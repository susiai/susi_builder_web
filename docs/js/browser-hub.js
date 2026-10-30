"use strict";

(() => {
	const $ = id => document.getElementById(id);
	const pageTitle = document.title;
	const hubId = newVfsGeneration();
	$("browser-chat").href = "chat.html?" + new URLSearchParams({ browserSession: hubId });
	const pending = new Map();
	const targets = new Map();
	const images = new Map();
	const snapshots = new Map();
	const seen = new Set();
	const requests = new Map();
	let channel;
	let observation;
	let draftImage;
	let capturing;
	let incoming;
	let disposed = false;
	try { channel = new BroadcastChannel("webstation.browser.v3"); }
	catch { $("browser-status").textContent = "Cross-page connections are unavailable here. Use localhost or HTTPS for Chat access."; }
	const connected = () => targets.size > 0;
	function notice(text, error = false) { $("browser-status").textContent = text; $("browser-status").toggleAttribute("data-error", error); }
	function element(tag, text) { const node = document.createElement(tag); node.textContent = text; return node; }
	function state() {
		const count = targets.size;
		$("browser-connection").textContent = count ? count + (count === 1 ? " shared item" : " shared items") : "Nothing shared";
		$("browser-disconnect").disabled = !count && !appTabs.size && !draftImage && !capturing;
		$("browser-pending-count").textContent = `${pending.size} pending`;
		$("browser-approval-empty").hidden = pending.size > 0;
		document.title = pending.size ? `(${pending.size}) Approval · ${pageTitle}` : pageTitle;
	}
	function rejectApproval(id, reason) {
		const request = pending.get(id);
		if (!request) return;
		clearTimeout(request.timer); pending.delete(id); request.node.remove(); request.reject(new Error(reason)); state();
	}
	function removeTarget(id) {
		if (incoming === id) { $("browser-incoming").hidden = true; incoming = undefined; }
		const removed = targets.delete(id);
		images.delete(id); snapshots.delete(id);
		for (const [key, approval] of pending) if (approval.tab === id) rejectApproval(key, "Sharing ended.");
		if (observation?.tab === id) {
			observation = undefined;
			$("browser-observation").hidden = true; $("browser-observation-empty").hidden = false;
			$("browser-observed-image").removeAttribute("src");
			$("browser-page-text").textContent = ""; $("browser-element").onchange = null;
			$("browser-element").replaceChildren(); $("browser-value").value = "";
		}
		if (removed && !connected()) channel?.postMessage({ type: "connection-closed", hubId });
		renderTargets(); state();
	}
	function addTarget(tab) { targets.set(tab.id, tab); renderTargets(); state(); }
	function offerTab(tab, accept, decline) {
		incoming = tab.id;
		$("browser-incoming").hidden = false;
		$("browser-incoming-name").textContent = tab.title + " · " + tab.url +
			(tab.permission === "interact" ? " · read and request actions" : " · read only");
		$("browser-accept").onclick = () => { $("browser-incoming").hidden = true; incoming = undefined; accept(); };
		$("browser-decline").onclick = decline;
		state();
	}
	const appTabs = createBrowserTabs();
	function clearDraft() {
		draftImage = undefined;
		$("browser-capture-draft").hidden = true;
		$("browser-capture-image").removeAttribute("src");
	}
	function disconnect() {
		capturing?.abort(); clearDraft();
		appTabs.disconnect();
		for (const id of [...targets.keys()]) removeTarget(id);
		for (const request of requests.values()) request.abort(new DOMException("Browser disconnected.", "AbortError"));
		state();
	}
	function renderTargets() {
		$("browser-target-empty").hidden = connected();
		$("browser-targets").replaceChildren(...Array.from(targets.values(), tab => {
			const item = document.createElement("li");
			const read = element("button", tab.kind === "image" ? "View image" : "Read page"); read.type = "button"; read.dataset.read = tab.id;
			const revoke = element("button", "Revoke"); revoke.type = "button"; revoke.dataset.revoke = tab.id;
			item.append(element("strong", tab.title), element("small", `${tab.url} · ${tab.permission}`), document.createElement("br"), read, revoke);
			return item;
		}));
	}
	function showSnapshot(tab, snapshot) {
		observation = { tab, ...snapshot };
		$("browser-observation").hidden = false; $("browser-observation-empty").hidden = true;
		$("browser-observation-title-text").textContent = `${snapshot.title} · ${snapshot.url}`;
		$("browser-page-text").textContent = snapshot.text;
		const picture = $("browser-observed-image");
		picture.hidden = snapshot.kind !== "image";
		if (snapshot.kind === "image") picture.src = snapshot.imageUrl;
		else picture.removeAttribute("src");
		$("browser-element").replaceChildren(...snapshot.elements.map(item => new Option(item.label + " · " + item.tag, item.id)));
		$("browser-observation-actions").hidden = !snapshot.elements.length || targets.get(tab)?.permission !== "interact";
		$("browser-element").onchange = () => {
			const action = snapshot.elements.find(item => item.id === $("browser-element").value)?.action;
			$("browser-click").disabled = action !== "click";
			$("browser-fill").disabled = $("browser-value").disabled = action !== "fill";
		};
		$("browser-value").value = ""; $("browser-element").onchange();
	}
	async function perform(method, args, id, run, signal, expiresAt = Date.now() + 180000) {
		const checkRequest = async () => {
			signal?.throwIfAborted();
			if (Date.now() >= expiresAt) throw new Error("This browser request has expired.");
			if (run?.fence) await (await window.vfsReady).checkRun(run.fence);
			signal?.throwIfAborted();
			if (Date.now() >= expiresAt) throw new Error("This browser request has expired.");
		};
		await checkRequest();
		signal?.throwIfAborted();
		if (method === "tabs") return [...targets.values()];
		if (!["read", "click", "fill"].includes(method)) throw new Error("Unsupported browser request.");
		const tab = targets.get(args.tab);
		if (!tab) throw new Error("This surface is not shared. Share it and read a new snapshot.");
		if (method === "read") {
			let snapshot;
			if (tab.kind === "image") {
				snapshot = { kind: "image", snapshot: tab.id, title: tab.title, url: tab.url,
					text: "Still image explicitly shared by the user.", elements: [], imageUrl: images.get(tab.id) };
			} else {
				const data = await appTabs.request(tab.id, "read", {});
				if (!data || typeof data.snapshot !== "string" || !Array.isArray(data.elements)) throw new Error("Invalid app snapshot.");
				const elements = data.elements.slice(0, 100).filter(item => item && ["click", "fill"].includes(item.action))
					.map(item => ({ id: String(item.id).slice(0, 80), tag: String(item.tag).slice(0, 30),
						label: String(item.label).slice(0, 160), action: item.action,
						...(Array.isArray(item.options) ? { options: item.options.slice(0, 100).map(option => ({
							label: String(option.label).slice(0, 160), value: String(option.value).slice(0, 500) })) } : {}) }));
				snapshot = { kind: "app", snapshot: data.snapshot.slice(0, 100), title: tab.title, url: tab.url,
					text: String(data.text || "").slice(0, 12000), elements };
			}
			await checkRequest();
			if (targets.get(tab.id) !== tab) throw new Error("Sharing ended.");
			snapshots.set(tab.id, snapshot); showSnapshot(tab.id, snapshot);
			return snapshot;
		}
		if (tab.permission !== "interact") throw new Error("This surface is shared for reading only.");
		const snapshot = snapshots.get(tab.id);
		const target = snapshot?.elements.find(item => item.id === args.element);
		if (!target || target.action !== method || snapshot.snapshot !== args.snapshot) throw new Error("Read a fresh page before requesting an action.");
		if (method === "fill" && (typeof args.value !== "string" || args.value.length > 8000)) throw new Error("Invalid field value.");
		if (pending.size >= 5) throw new Error("Review the pending browser actions first.");
		await new Promise((resolve, reject) => {
			const node = document.createElement("article");
			node.append(element("h3", `${method === "click" ? "Click" : "Fill"}: ${target.label}`),
				element("p", `${tab.title} · ${tab.url}`), element("p", run ? `${run.profile || "Agent"} · ${run.project || ""}` : "Manual request"));
			if (method === "fill") node.append(element("pre", args.value));
			node.append(element("p", "Approve only if this action matches your task. Clicking may submit a form or follow a link."));
			const actions = document.createElement("div"); actions.className = "workspace-actions";
			const approve = element("button", "Approve once"); approve.type = "button";
			const deny = element("button", "Deny"); deny.type = "button";
			actions.append(approve, deny); node.append(actions); $("browser-pending").append(node);
			const timer = setTimeout(() => rejectApproval(id, "The approval expired."), Math.max(0, expiresAt - Date.now()));
			pending.set(id, { tab: tab.id, node, reject, timer }); state();
			approve.onclick = () => {
				if (Date.now() >= expiresAt) { rejectApproval(id, "The approval expired."); return; }
				clearTimeout(timer); pending.delete(id); node.remove(); state(); resolve();
			};
			deny.onclick = () => rejectApproval(id, "The user denied this browser action.");
		});
		// The target checks document identity and element freshness again after human approval.
		await checkRequest();
		if (targets.get(tab.id) !== tab || snapshots.get(tab.id) !== snapshot) throw new Error("Read a fresh page before acting.");
		const result = await appTabs.request(tab.id, method, args);
		snapshots.delete(tab.id);
		return result;
	}
	if (channel) channel.onmessage = async ({ data }) => {
		if (data?.hubId && data.hubId !== hubId) return;
		if (data?.type === "cancel") {
			requests.get(data.id)?.abort(new DOMException("The agent stopped.", "AbortError"));
			rejectApproval(data.id, "The agent stopped before approval."); return;
		}
		if (data?.type !== "request" || (!connected() && !(data.method === "status" && data.hubId === hubId)) ||
			typeof data.id !== "string" || data.id.length > 100 || JSON.stringify(data).length > 40000 || seen.has(data.id) ||
			!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 181000) return;
		seen.add(data.id); if (seen.size > 1000) seen.delete(seen.values().next().value);
		const request = new AbortController(); requests.set(data.id, request);
		try {
			const result = data.method === "status" ? { connected: connected(), hubId, pendingCount: pending.size } :
				await perform(data.method, data.args || {}, data.id, data.run, request.signal, data.expiresAt);
			if (!disposed) channel.postMessage({ type: "response", id: data.id, hubId, result });
		} catch (error) { if (!disposed) channel.postMessage({ type: "response", id: data.id, hubId, error: error.message }); }
		finally { requests.delete(data.id); }
	};
	const urlInput = $("browser-app-url");
	let urlEdited = false;
	urlInput.addEventListener("input", () => { urlEdited = true; });
	urlInput.addEventListener("change", () => { if (!urlInput.value.trim()) pageSettings.save("browser", { appUrl: null }); });
	pageSettings.read("browser").then(settings => {
		if (!urlEdited && !urlInput.value && typeof settings.appUrl === "string") urlInput.value = settings.appUrl;
	});
	function openApp(url, remember = false) {
		try {
			appTabs.open(url); state();
			if (remember) {
				// A launch URL can contain a one-time token. Only remember ordinary app addresses.
				const plain = ["http:", "https:"].includes(url.protocol) && !url.search && !url.hash;
				pageSettings.save("browser", { appUrl: plain ? url.href : null });
			}
			notice("In the app tab, choose what to share and select Share with SUSI Builder.");
		} catch (error) { notice(error.message, true); }
	}
	$("browser-app-form").onsubmit = event => {
		event.preventDefault();
		try { openApp(new URL(urlInput.value), true); } catch { notice("Enter a valid app URL.", true); }
	};
	$("browser-practice-start").onclick = () => openApp(new URL("browser-lab.html", location.href));
	const captureButton = $("browser-capture");
	captureButton.disabled = !navigator.mediaDevices?.getDisplayMedia;
	if (captureButton.disabled) $("browser-capture-status").textContent = "Tab capture is unavailable in this browser or context.";
	captureButton.onclick = async () => {
		if (capturing) return;
		clearDraft();
		const job = new AbortController(); capturing = job; captureButton.disabled = true; state();
		try {
			const image = await captureBrowserTab(job.signal);
			if (job.signal.aborted) return;
			draftImage = image;
			$("browser-capture-image").src = image; $("browser-capture-draft").hidden = false;
			$("browser-capture-status").textContent = "Review this frame before sharing it with Chat.";
		} catch (error) {
			if (!job.signal.aborted) $("browser-capture-status").textContent = error.name === "NotAllowedError" ?
				"Capture was cancelled or permission was declined." : error.message;
		} finally { capturing = undefined; captureButton.disabled = false; state(); }
	};
	$("browser-publish").onclick = () => {
		if (!draftImage) return;
		const id = newVfsGeneration();
		images.set(id, draftImage);
		addTarget({ id, title: "Tab image · " + new Date().toLocaleTimeString(), url: "User-selected frame", kind: "image", permission: "read" });
		clearDraft(); $("browser-capture-status").textContent = "Image shared for this Browser session."; state();
	};
	$("browser-discard").onclick = () => { clearDraft(); $("browser-capture-status").textContent = "Image discarded."; state(); };
	$("browser-disconnect").onclick = () => { disconnect(); notice("Sharing ended."); $("browser-capture-status").textContent = ""; };
	$("browser-targets").onclick = async event => {
		const read = event.target.closest("button[data-read]")?.dataset.read;
		const revoke = event.target.closest("button[data-revoke]")?.dataset.revoke;
		try {
			if (read) { await perform("read", { tab: read }, newVfsGeneration()); notice("Fresh page snapshot received."); }
			if (revoke) { if (images.has(revoke)) removeTarget(revoke); else appTabs.close(revoke); }
		} catch (error) { notice(error.message, true); }
	};
	for (const method of ["click", "fill"]) $("browser-" + method).onclick = async () => {
		if (!observation) return;
		try {
			await perform(method, { tab: observation.tab, snapshot: observation.snapshot,
				element: $("browser-element").value, value: $("browser-value").value }, newVfsGeneration());
			notice("Action completed. Read the page again to verify the result.");
		} catch (error) { notice(error.message, true); }
	};
	window.addEventListener("pagehide", () => { disposed = true; disconnect(); appTabs.dispose(); channel?.close(); });
	window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
	state();

	function createBrowserTabs() {
		const protocol = "webstation-app-v1";
		const peers = new Map();
		const pendingCalls = new Map();
		let poll;
		function close(id, reason = "Sharing ended.") {
			const peer = peers.get(id);
			if (!peer) return;
			peers.delete(id);
			if (!peers.size) { clearInterval(poll); poll = undefined; }
			if (peer.port) { peer.port.postMessage({ type: "closed" }); peer.port.close(); }
			else if (!peer.window.closed) peer.window.postMessage({ protocol, type: "withdraw", token: id },
				peer.origin === "null" ? "*" : peer.origin);
			for (const [key, call] of pendingCalls) {
				if (call.peer !== peer) continue;
				clearTimeout(call.timer); pendingCalls.delete(key); call.reject(new Error(reason));
			}
			removeTarget(id);
		}
		function request(id, method, args) {
			const peer = peers.get(id);
			if (!peer?.shared || peer.window.closed) {
				close(id); return Promise.reject(new Error("This tab is no longer shared."));
			}
			if (method !== "read" && (peer.permission !== "interact" || !["click", "fill"].includes(method))) {
				return Promise.reject(new Error("This operation is not permitted."));
			}
			const key = newVfsGeneration();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => close(id, "The app stopped responding. Share its tab again."), 12000);
				pendingCalls.set(key, { peer, resolve, reject, timer });
				peer.port.postMessage({ id: key, method, args });
			});
		}
		function invite(peer) {
			peer.window.postMessage({ protocol, type: "invite", token: peer.id }, peer.origin === "null" ? "*" : peer.origin);
		}
		function receive(event) {
			const data = event.data;
			if (data?.protocol !== protocol || data.type !== "share" || !event.ports[0]) return;
			const peer = peers.get(data.token);
			const origin = event.origin === "file://" ? "null" : event.origin;
			if (!peer || peer.port || peer.window !== event.source || origin !== peer.origin ||
				!["read", "interact"].includes(data.permission)) {
				event.ports[0].postMessage({ type: "closed" }); event.ports[0].close(); return;
			}
			peer.port = event.ports[0];
			peer.permission = data.permission;
			const tab = { id: peer.id, title: String(data.title || "App tab").slice(0, 200), url: peer.label,
				permission: peer.permission, kind: "app" };
			peer.port.onmessage = ({ data: reply }) => {
				if (reply?.type === "closed") { close(peer.id); return; }
				const call = pendingCalls.get(reply?.id);
				if (!call || call.peer !== peer) return;
				clearTimeout(call.timer); pendingCalls.delete(reply.id);
				if (reply.error) call.reject(new Error(String(reply.error)));
				else call.resolve(reply.result);
			};
			peer.port.onmessageerror = () => close(peer.id);
			const accept = () => {
				if (!peers.has(peer.id) || peer.shared || peer.window.closed) return;
				peer.shared = true;
				addTarget(tab);
				peer.port.postMessage({ type: "accepted" });
			};
			if (peer.incoming) offerTab(tab, accept, () => close(peer.id));
			else accept();
		}
		window.addEventListener("message", receive);
		function checkPeers() {
			for (const peer of peers.values()) {
				if (peer.window.closed) {
					close(peer.id);
					if (!peer.shared) notice("The app tab closed or isolated its connection. Use tab capture to share an image.");
					continue;
				}
				if (!peer.shared && Date.now() > peer.deadline) {
					close(peer.id); notice("Pairing expired. Open a compatible app and choose Share with SUSI Builder.");
				} else if (!peer.port) invite(peer);
			}
		}
		function register(win, id, origin, label, incoming) {
			const peer = { id, window: win, origin, label, incoming, deadline: Date.now() + 120000 };
			peers.set(id, peer);
			if (poll === undefined) poll = setInterval(checkPeers, 1000);
			if (incoming) invite(peer);
		}
		const params = new URLSearchParams(location.hash.slice(1));
		const id = params.get("share"), origin = params.get("origin");
		if (window.opener && /^[a-f0-9]{32}$/.test(id || "")) {
			const opener = window.opener;
			window.opener = null;
			try {
				if ((origin === "null" && location.protocol === "file:") ||
					(origin === new URL(origin).origin && /^https?:\/\//.test(origin))) {
					register(opener, id, origin, origin === "null" ? "Local document" : origin, true);
					notice("Waiting for the app requesting a connection…");
				}
			} catch { notice("Invalid app origin."); }
			try { history.replaceState(history.state, "", location.href.split("#")[0]); }
			catch { /* The confirmed peer remains pinned if a file origin keeps the fragment. */ }
		}
		return {
			get size() { return peers.size; },
			open(url) {
				const localPractice = url.protocol === "file:" && location.protocol === "file:" &&
					url.href === new URL("browser-lab.html", location.href).href;
				if ((!localPractice && !["http:", "https:"].includes(url.protocol)) || url.username || url.password) {
					throw new Error("Enter an HTTP or HTTPS app URL without embedded credentials.");
				}
				const win = window.open("about:blank", "_blank");
				if (!win) throw new Error("Allow SUSI Builder to open the app tab, then try again.");
				const id = newVfsGeneration();
				const launchUrl = new URL(url);
				launchUrl.searchParams.set("_webstation_pair", id);
				// Keep a reference for postMessage without granting the app access to its opener.
				win.opener = null; win.location.replace(launchUrl.href);
				register(win, id, localPractice ? "null" : url.origin, localPractice ? "Local practice app" : url.origin + url.pathname, false);
			},
			request, close,
			disconnect() { for (const id of [...peers.keys()]) close(id); },
			dispose() { this.disconnect(); window.removeEventListener("message", receive); }
		};
	}

	// Capture a single frame. The browser owns the source picker and the stream ends before publishing is offered.
	async function captureBrowserTab(signal) {
		const stream = await navigator.mediaDevices.getDisplayMedia({
			video: { displaySurface: "browser" }, audio: false, selfBrowserSurface: "exclude", monitorTypeSurfaces: "exclude"
		});
		const video = document.createElement("video");
		const track = stream.getVideoTracks()[0];
		const stop = () => stream.getTracks().forEach(item => item.stop());
		try {
			signal.throwIfAborted();
			if (track?.getSettings().displaySurface !== "browser") throw new Error("Choose a browser tab in the picker.");
			video.muted = true; video.playsInline = true; video.srcObject = stream;
			await new Promise((resolve, reject) => {
				const finish = error => {
					clearTimeout(timer); signal.removeEventListener("abort", abort); track.removeEventListener("ended", ended);
					video.onloadeddata = null;
					if (error) reject(error); else resolve();
				};
				const abort = () => finish(signal.reason);
				const ended = () => finish(new Error("The tab stopped sharing."));
				const timer = setTimeout(() => finish(new Error("No frame arrived from the selected tab.")), 10000);
				signal.addEventListener("abort", abort, { once: true }); track.addEventListener("ended", ended, { once: true });
				video.onloadeddata = () => finish();
				video.play().catch(finish);
			});
			signal.throwIfAborted();
			if (!video.videoWidth || !video.videoHeight) throw new Error("The selected tab has no image yet.");
			const canvas = document.createElement("canvas");
			let scale = Math.min(1, 1440 / video.videoWidth, 1080 / video.videoHeight);
			while (true) {
				canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
				canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
				canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
				const url = canvas.toDataURL("image/jpeg", 0.82);
				if (url.length <= 350000) return url;
				scale *= 0.75;
			}
		} finally { stop(); video.srcObject = null; }
	}
})();
