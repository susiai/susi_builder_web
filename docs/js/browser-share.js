"use strict";

function susiShareId() {
	return Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, "0")).join("");
}

// Installed by the app's author. Only explicitly published regions and controls participate.
function createSusiBrowserTarget(doc = document) {
	const view = doc.defaultView;
	const excluded = "script, style, template, noscript, iframe, object, embed, canvas, [hidden], [inert], " +
		"[aria-hidden=true], [data-susi-private], [contenteditable]:not([contenteditable=false])";
	let snapshot;
	let expires;
	let handles = new Map();

	function visible(node) {
		const style = view.getComputedStyle(node);
		return !node.matches(excluded) && style.display !== "none" && style.visibility === "visible" &&
			Number(style.opacity) !== 0 && style.contentVisibility !== "hidden";
	}
	function exposed(node) {
		if (!node.isConnected || !node.closest("[data-susi-surface]")) return false;
		for (let parent = node; parent; parent = parent.parentElement) if (!visible(parent)) return false;
		return true;
	}
	function publicText(root, limit) {
		const parts = [];
		let length = 0;
		function visit(node) {
			if (node.nodeType === 3) {
				const text = node.data.trim().replace(/\s+/g, " ").slice(0, limit - length);
				if (text) { parts.push(text); length += text.length + 1; }
			} else if (node.nodeType === 1 && visible(node) && !node.matches("input, textarea, select")) {
				for (const child of node.childNodes) {
					if (length >= limit) break;
					visit(child);
				}
			}
		}
		visit(root);
		return parts.join(" ");
	}
	function describe(node) {
		if (!node.matches("[data-susi-action]") || !exposed(node) || node.matches(":disabled, [aria-disabled=true]")) return;
		const tag = node.localName;
		const fillable = tag === "textarea" || tag === "select" || (tag === "input" && ["text", "search"].includes(node.type));
		if (tag !== "button" && (!fillable || node.readOnly || node.multiple)) return;
		if (fillable && /password|secret|token|api.?key|cc-|one-time-code/i.test(
			[node.id, node.name, node.autocomplete, node.getAttribute("aria-label")].join(" "))) return;
		const labels = Array.from(node.labels || []).filter(exposed).map(label => publicText(label, 160));
		const label = (node.getAttribute("aria-label") || labels.join(" ") || publicText(node, 160)).trim().slice(0, 160);
		if (!label) return;
		const info = { tag, label, action: fillable ? "fill" : "click" };
		if (tag === "select") info.options = Array.from(node.options).slice(0, 100)
			.filter(option => !option.matches(":disabled")).map(option => ({ label: option.label, value: option.value }));
		return info;
	}
	function signature(node, info) {
		return JSON.stringify([info, node.type, node.name, node.form?.action, node.form?.method, node.formAction, node.formMethod]);
	}
	return {
		read() {
			snapshot = susiShareId();
			expires = Date.now() + 180000;
			handles = new Map();
			const elements = [];
			let text = "";
			for (const root of doc.querySelectorAll("[data-susi-surface]")) {
				if (root.parentElement?.closest("[data-susi-surface]") || !exposed(root)) continue;
				if (text.length < 12000) text += publicText(root, 12000 - text.length) + "\n";
				for (const node of root.querySelectorAll("[data-susi-action]")) {
					if (elements.length >= 100) break;
					const info = describe(node);
					if (!info) continue;
					const id = "e" + (elements.length + 1);
					handles.set(id, { node, signature: signature(node, info) });
					elements.push({ id, ...info });
				}
			}
			return { snapshot, title: doc.title.slice(0, 200), text: text.trim(), elements };
		},
		act(method, args) {
			const handle = handles.get(args?.element);
			const info = handle && describe(handle.node);
			if (!info || args.snapshot !== snapshot || Date.now() >= expires || info.action !== method ||
				signature(handle.node, info) !== handle.signature) throw new Error("The control changed. Read the page again.");
			const node = handle.node;
			handles.clear();
			if (method === "click") node.click();
			else {
				if (typeof args.value !== "string" || args.value.length > 8000 ||
					(node.maxLength >= 0 && args.value.length > node.maxLength) ||
					(info.options && !info.options.some(option => option.value === args.value))) throw new Error("Invalid field value.");
				const prototype = { input: view.HTMLInputElement, textarea: view.HTMLTextAreaElement, select: view.HTMLSelectElement }[info.tag].prototype;
				Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, args.value);
				node.dispatchEvent(new view.Event("input", { bubbles: true }));
				node.dispatchEvent(new view.Event("change", { bubbles: true }));
			}
			return { completed: true };
		}
	};
}

(() => {
	const script = document.currentScript;
	const button = document.querySelector("button[data-susi-share]");
	if (!button || !script || window !== window.top) return;
	// An app can host a copy of this file and explicitly configure its trusted SUSI Builder URL.
	const hubUrl = new URL(script.dataset.susiUrl || "../browser.html", script.src);
	if (!["http:", "https:", "file:"].includes(hubUrl.protocol)) return;
	const protocol = "webstation-app-v1";
	const allowedOrigin = hubUrl.protocol === "file:" ? "null" : hubUrl.origin;
	const destination = allowedOrigin === "null" ? "*" : allowedOrigin;
	const appUrl = new URL(location.href);
	const launchToken = appUrl.searchParams.get("_webstation_pair");
	if (launchToken) {
		appUrl.searchParams.delete("_webstation_pair");
		try { history.replaceState(history.state, "", appUrl.href); }
		catch { /* Some file origins restrict URL cleanup. Pairing uses the window and token. */ }
		button.disabled = true;
		// A copied or expired launch URL can still start a fresh connection.
		setTimeout(() => { button.disabled = false; }, 5000);
	}
	const status = document.querySelector("[data-susi-status]");
	const choice = document.querySelector("select[data-susi-permission]");
	const initialLabel = button.textContent;
	let invitation, opening, port, poll;
	const report = message => { if (status) status.textContent = message; };
	function stop(message) {
		clearInterval(poll);
		if (port) { port.postMessage({ type: "closed" }); port.close(); }
		port = invitation = opening = undefined;
		if (choice) choice.disabled = false;
		button.textContent = initialLabel;
		report(message);
	}
	function share(peer, permission) {
		const pair = new MessageChannel();
		const page = location.href;
		const target = createSusiBrowserTarget();
		const activePort = pair.port1;
		let accepted = false;
		port = activePort;
		if (choice) choice.disabled = true;
		button.textContent = "Stop sharing";
		report("Waiting for SUSI Builder…");
		activePort.onmessage = ({ data }) => {
			if (port !== activePort) return;
			if (data?.type === "closed" || location.href !== page) { stop("Sharing ended."); return; }
			if (data?.type === "accepted") { accepted = true; report("Shared with SUSI Builder."); return; }
			if (!accepted || typeof data?.id !== "string") return;
			try {
				let result;
				if (data.method === "read") result = target.read();
				else if (permission === "interact" && ["click", "fill"].includes(data.method)) result = target.act(data.method, data.args);
				else throw new Error("This operation is not permitted.");
				activePort.postMessage({ id: data.id, result });
			} catch (error) { activePort.postMessage({ id: data.id, error: error.message }); }
		};
		peer.window.postMessage({ protocol, type: "share", token: peer.token, permission, title: document.title.slice(0, 200) },
			destination, [pair.port2]);
		clearInterval(poll);
		poll = setInterval(() => { if (peer.window.closed || location.href !== page) stop("Sharing ended."); }, 1500);
	}
	window.addEventListener("message", event => {
		const data = event.data;
		if (!event.source || event.source === window || data?.protocol !== protocol ||
			!/^[a-f0-9]{32}$/.test(data.token) || port) return;
		const origin = event.origin === "file://" ? "null" : event.origin;
		if (origin !== allowedOrigin || (origin === "null" && location.protocol !== "file:")) return;
		if (data.type === "withdraw" && invitation?.window === event.source && invitation.token === data.token) {
			stop("The invitation ended. Share again to start a new connection."); return;
		}
		if (data.type !== "invite") return;
		if (!opening && data.token !== launchToken) return;
		if (opening && (event.source !== opening.window || data.token !== opening.token)) return;
		if (invitation && !invitation.window.closed && event.source !== invitation.window) return;
		invitation = { window: event.source, token: data.token };
		button.disabled = false;
		if (opening) share(invitation, opening.permission);
	});
	button.addEventListener("click", event => {
		if (!event.isTrusted) return;
		if (port || opening) { stop("Sharing ended."); return; }
		const permission = choice?.value === "interact" ? "interact" : "read";
		if (invitation && !invitation.window.closed) { share(invitation, permission); return; }
		// A tab already open independently can start a Browser page for its current document.
		const token = susiShareId();
		const url = new URL(hubUrl);
		url.hash = new URLSearchParams({ share: token, origin: location.protocol === "file:" ? "null" : location.origin });
		const peer = window.open(url.href, "_blank");
		if (!peer) { report("Allow this app to open its SUSI Builder tab, then try again."); return; }
		opening = { window: peer, token, permission };
		button.textContent = "Cancel sharing";
		report("Confirm this app in the SUSI Builder tab.");
		const deadline = Date.now() + 120000;
		poll = setInterval(() => {
			if (peer.closed || Date.now() > deadline) stop("The connection ended. Share again to reconnect.");
		}, 1500);
	});
	window.addEventListener("pagehide", () => stop("Sharing ended."));
})();
