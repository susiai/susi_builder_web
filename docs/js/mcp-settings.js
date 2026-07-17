"use strict";

// The anonymous gateway reports list prices beyond its free allowance. A configured platform key
// can still be reserved for paying customers, and individual pack descriptions can specify extra requirements.
function isAnonymousPipeworxPack({ auth, cost, description }) {
	if (!auth || auth.account_required || typeof auth.detail !== "string" || !auth.detail || cost?.basis !== "list") {
		return false;
	}
	const keyless = auth.shape === "keyless" && /^no key required\b/i.test(auth.detail);
	const suppliedKey = auth.shape === "platform-keyed" && auth.key_configured === true &&
		/no key needed from you/i.test(auth.detail);
	if (!keyless && !suppliedKey) return false;

	const restrictions = /(?<!\bno )\bBYOK?\b|\b(?:OAuth\d*|prepaid|signed[- ]in|authenticated user|api_key auth only|paid[- ]only)\b/i;
	const requiresCredential = /\b(?:requires?|needs?|your own)\b[^.;\n]{0,60}\b(?:keys?|tokens?|credentials?|account|subscription)\b/i;
	return !restrictions.test(description) && !requiresCredential.test(description);
}

async function searchPipeworxPacks(query, signal) {
	const options = { credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal };
	// The gateway can mark an OAuth workspace app as keyless because it needs no upstream API key.
	// Pipeworx lists these separately in Explore. Its public index is cached by the browser between searches.
	const [response, workspaceResponse] = await Promise.all([
		fetch("https://gateway.pipeworx.io/v1/tools/search_packs", {
			...options,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, limit: 200 })
		}),
		fetch("https://pipeworx.io/explore/tools/own-workspace.json", options)
	]);
	if (response.status === 429) throw new Error("Pipeworx’s anonymous request limit was reached. Try again later.");
	if (!response.ok) throw new Error("Pipeworx search is unavailable (HTTP " + response.status + "). Try again later.");
	if (!workspaceResponse.ok) throw new Error("Could not verify anonymous access with Pipeworx. Try again later.");
	const [data, workspace] = await Promise.all([response.json(), workspaceResponse.json()]);
	if (!Array.isArray(data?.packs)) throw new Error("Pipeworx returned an unreadable pack list.");
	if (workspace?.area !== "own-workspace" || !workspace.packs || typeof workspace.packs !== "object" ||
		Array.isArray(workspace.packs) || !Object.keys(workspace.packs).length) {
		throw new Error("Pipeworx did not return its account requirements. Try again later.");
	}

	const packs = new Map();
	for (const pack of data.packs) {
		if (!pack || typeof pack.slug !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(pack.slug) ||
			typeof pack.name !== "string" || !pack.name.trim() || typeof pack.description !== "string" ||
			!pack.description.trim() || Object.hasOwn(workspace.packs, pack.slug) || !isAnonymousPipeworxPack(pack)) continue;
		const url = "https://gateway.pipeworx.io/" + pack.slug + "/mcp";
		if (pack.gateway_url === url && !packs.has(url)) {
			packs.set(url, { name: pack.name.trim(), description: pack.description.trim(), url,
				docs: "https://pipeworx.io/packs/" + pack.slug + "/" });
		}
	}
	return { packs: [...packs.values()], truncated: data.truncated === true };
}

(async () => {
	const setup = document.getElementById("mcp-setup");
	if (!setup) return;
	const form = document.getElementById("mcp-server-form");
	const fields = form.elements;
	const title = document.getElementById("mcp-form-title");
	const submit = form.querySelector('[type="submit"]');
	const cancel = document.getElementById("mcp-cancel");
	const forget = document.getElementById("mcp-forget");
	const suggestions = document.getElementById("mcp-suggestions");
	document.getElementById("mcp-file-help").hidden = location.protocol !== "file:";
	const featured = document.getElementById("mcp-featured");
	const search = document.getElementById("mcp-pack-search");
	const query = document.getElementById("mcp-pack-query");
	const searchButton = search.querySelector('[type="submit"]');
	const clearSearch = document.getElementById("mcp-pack-clear");
	const searchStatus = document.getElementById("mcp-pack-status");
	const results = document.getElementById("mcp-pack-results");
	const packCard = document.getElementById("mcp-pack-card");
	const more = document.getElementById("mcp-pack-more");
	const list = document.getElementById("mcp-connectors");
	const status = document.getElementById("mcp-status");
	const template = document.getElementById("mcp-card");
	const refreshing = new Map(), notices = new Map();
	let vfs, editing, servers = [], readId = 0;
	let packRequest, packs = [];

	function message(target, text, error = false) {
		target.textContent = text;
		target.toggleAttribute("data-error", error);
	}

	function updateChoices() {
		const configured = new Set(servers.map(server => server.url));
		for (const card of suggestions.querySelectorAll("li")) {
			const button = card.querySelector("button");
			const name = card.querySelector("h4").textContent;
			button.disabled = configured.has(card.querySelector("code").textContent);
			button.textContent = button.disabled ? "Already added" : "Use server";
			button.setAttribute("aria-label", button.disabled ? name + " already added" : "Use " + name);
		}
	}

	function render() {
		updateChoices();
		const focused = list.contains(document.activeElement) ? document.activeElement : null;
		const activeId = focused?.closest("article")?.dataset.id;
		const activeAction = focused?.dataset.action;
		const fragment = document.createDocumentFragment();
		for (const server of servers) {
			const card = template.content.firstElementChild.cloneNode(true);
			card.dataset.id = server.id;
			const heading = card.querySelector("h3");
			heading.id = "connector-" + server.id;
			heading.textContent = server.name;
			card.setAttribute("aria-labelledby", heading.id);
			card.querySelector(".mcp-url").textContent = server.url;
			const pending = refreshing.has(server.id);
			card.querySelector('[data-action="refresh"]').textContent = pending ? "Cancel refresh" : "Refresh tools";
			const enabled = server.tools.filter(tool => tool.enabled).length;
			card.querySelector("legend").textContent = enabled + " of " + server.tools.length + " tools enabled";
			const all = card.querySelector('[data-action="all"]');
			all.disabled = !server.tools.length;
			all.checked = enabled > 0 && enabled === server.tools.length;
			all.indeterminate = enabled > 0 && !all.checked;
			const tools = card.querySelector(".mcp-tools");
			for (const tool of server.tools) {
				const label = document.createElement("label");
				const check = document.createElement("input");
				check.type = "checkbox";
				check.checked = tool.enabled;
				check.dataset.action = tool.alias;
				const caption = document.createElement("span"), name = document.createElement("code");
				name.textContent = tool.name;
				caption.append(name);
				if (tool.description) {
					const detail = document.createElement("small");
					detail.textContent = tool.description;
					caption.append(detail);
				}
				label.append(check, caption);
				tools.append(label);
			}
			const note = notices.get(server.id);
			const empty = server.version ? "The server offers no compatible tools." : "Refresh to load this server’s tools.";
			message(card.querySelector(".mcp-notice"), note?.text || (server.tools.length ? "" : empty), note?.error);
			fragment.append(card);
		}
		if (!servers.length) fragment.append("No servers configured.");
		list.replaceChildren(fragment);
		if (activeId && activeAction) {
			list.querySelector(`article[data-id="${activeId}"] [data-action="${activeAction}"]`)?.focus({ preventScroll: true });
		}
	}

	async function reload() {
		const revision = ++readId;
		const result = await susiMcp.read(vfs);
		if (revision === readId) { servers = result; render(); }
	}

	function edit(server) {
		editing = server;
		form.reset();
		search.reset();
		resetResults();
		suggestions.open = false;
		document.getElementById("mcp-create-options").hidden = Boolean(server);
		fields.name.value = server?.name || "";
		fields.url.value = server?.url || "";
		const stored = server && susiMcp.tokenFor(server);
		forget.hidden = !stored;
		fields.token.placeholder = stored ? "Leave blank to keep the saved token" : "";
		document.getElementById("mcp-auth").open = false;
		title.textContent = server ? "Edit server" : "Add a server";
		submit.textContent = server ? "Save server" : "Add server";
		cancel.hidden = document.getElementById("mcp-edit-help").hidden = !server;
	}

	async function refresh(server) {
		const controller = new AbortController();
		refreshing.get(server.id)?.abort();
		refreshing.set(server.id, controller);
		notices.set(server.id, { text: "Loading tools…" });
		render();
		try {
			const { skipped } = await susiMcp.discover(vfs, server, controller.signal);
			if (refreshing.get(server.id) === controller) {
				notices.set(server.id, { text: skipped.length ? "Unsupported tool schemas: " + skipped.join(", ") : "Tool list updated." });
			}
		} catch (error) {
			if (refreshing.get(server.id) === controller) notices.set(server.id, controller.signal.aborted
				? { text: "Refresh canceled." } : { text: error.message || String(error), error: true });
		} finally {
			if (refreshing.get(server.id) === controller) refreshing.delete(server.id);
			await reload();
		}
	}

	form.addEventListener("submit", async event => {
		event.preventDefault();
		if (setup.inert) return;
		setup.inert = true;
		const previous = editing;
		try {
			const url = susiMcpClient.endpoint(fields.url.value.trim());
			const token = fields.token.value.trim();
			susiMcpClient.validateToken(url, token);
			const oldToken = previous ? susiMcp.tokenFor(previous) : "";
			const changedEndpoint = previous?.url !== url;
			const changedToken = Boolean(token && token !== oldToken || fields.forget.checked && oldToken);
			const saved = await susiMcp.saveServer(vfs, fields.name.value, url, previous);
			const server = saved.find(server => server.url === url);
			if (token || oldToken && (changedEndpoint || fields.forget.checked)) {
				try { susiMcp.setToken(server, token); }
				catch {
					edit(server);
					message(status, "Server saved. This tab could not update its stored bearer token.", true);
					await reload();
					return;
				}
			}
			edit();
			message(status, server.name + " saved.");
			await reload();
			if (changedEndpoint || changedToken) refresh(server).catch(error => message(status, error.message, true));
		} catch (error) {
			message(status, error.message || String(error), true);
			await reload().catch(() => {});
		} finally { setup.inert = false; }
	});
	cancel.addEventListener("click", () => { edit(); fields.name.focus(); });

	function resetResults() {
		packRequest?.abort();
		packRequest = undefined;
		packs = [];
		results.replaceChildren();
		results.hidden = more.hidden = true;
		featured.hidden = Boolean(query.value.trim());
		clearSearch.hidden = !featured.hidden;
		searchButton.disabled = false;
		message(searchStatus, "");
	}

	function showPacks() {
		const start = results.childElementCount;
		const fragment = document.createDocumentFragment();
		for (const pack of packs.slice(start, start + 12)) {
			const card = packCard.content.firstElementChild.cloneNode(true);
			card.querySelector("h4").textContent = pack.name;
			card.querySelector("p").textContent = pack.description;
			card.querySelector("code").textContent = pack.url;
			const docs = card.querySelector("a");
			docs.href = pack.docs;
			docs.setAttribute("aria-label", pack.name + " documentation");
			fragment.append(card);
		}
		results.append(fragment);
		results.hidden = !packs.length;
		more.hidden = results.childElementCount >= packs.length;
		updateChoices();
		if (start) results.children[start]?.querySelector("button:enabled, a").focus();
	}

	query.addEventListener("input", resetResults);
	clearSearch.addEventListener("click", () => {
		search.reset();
		resetResults();
		query.focus();
	});
	more.addEventListener("click", showPacks);
	search.addEventListener("submit", async event => {
		event.preventDefault();
		const term = query.value.trim();
		if (setup.inert || editing || !term || packRequest) return;
		resetResults();
		const controller = new AbortController();
		packRequest = controller;
		searchButton.disabled = true;
		message(searchStatus, "Searching Pipeworx…");
		try {
			const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
			const result = await searchPipeworxPacks(term, signal);
			if (packRequest !== controller) return;
			packs = result.packs;
			showPacks();
			const count = packs.length;
			const text = count ? `${count} free-tier ${count === 1 ? "pack" : "packs"} for “${term}”.`
				: `No free-tier packs found for “${term}”.`;
			message(searchStatus, text + (result.truncated ? " Refine your search for more matches." : ""));
		} catch (error) {
			if (packRequest !== controller) return;
			let text = error.message;
			if (error.name === "TimeoutError") text = "Pipeworx took too long to respond. Try your search again.";
			else if (error instanceof TypeError) text = "Could not reach Pipeworx. Check your connection and try again.";
			else if (error instanceof SyntaxError) text = "Could not read the Pipeworx catalog. Try again later.";
			message(searchStatus, text, true);
		} finally {
			if (packRequest === controller) {
				packRequest = undefined;
				searchButton.disabled = false;
			}
		}
	});
	suggestions.addEventListener("click", event => {
		const card = event.target.closest("li button")?.closest("li");
		if (!card || editing || setup.inert) return;
		const name = card.querySelector("h4").textContent;
		const url = card.querySelector("code").textContent;
		edit();
		fields.name.value = name;
		fields.url.value = url;
		message(status, name + " selected. Choose Add server to load its tools.");
		submit.focus();
	});

	list.addEventListener("change", async event => {
		const check = event.target;
		if (!check.matches('input[type="checkbox"]')) return;
		const server = servers.find(item => item.id === check.closest("article").dataset.id);
		if (!server) return;
		const aliases = check.dataset.action === "all" ? server.tools.map(tool => tool.alias) : [check.dataset.action];
		try {
			await susiMcp.select(vfs, server, aliases, check.checked);
			notices.set(server.id, { text: "Selection saved." });
		} catch (error) { notices.set(server.id, { text: error.message || String(error), error: true }); }
		try { await reload(); } catch (error) { message(status, error.message, true); }
	});

	list.addEventListener("click", async event => {
		const button = event.target.closest("button");
		if (!button) return;
		const server = servers.find(item => item.id === button.closest("article").dataset.id);
		if (!server) return;
		try {
			switch (button.dataset.action) {
				case "edit": edit(server); fields.name.focus(); break;
				case "refresh":
					if (refreshing.has(server.id)) refreshing.get(server.id).abort();
					else await refresh(server);
					break;
				case "remove":
					if (!window.confirm("Remove " + server.name + " and its tool selections from SUSI Builder?")) return;
					await susiMcp.removeServer(vfs, server);
					refreshing.get(server.id)?.abort();
					refreshing.delete(server.id); notices.delete(server.id);
					if (susiMcp.tokenFor(server)) susiMcp.setToken(server, "");
					if (editing?.id === server.id) edit();
					message(status, server.name + " removed.");
					await reload();
					fields.name.focus();
					break;
			}
		} catch (error) { message(status, error.message || String(error), true); }
	});

	try {
		vfs = await window.vfsReady;
		await reload();
		setup.inert = false;
		message(status, "");
		window.addEventListener("focus", () => reload().catch(error => message(status, error.message, true)));
		window.addEventListener("pagehide", () => {
			resetResults();
			for (const controller of refreshing.values()) controller.abort();
		});
	} catch (error) { message(status, error.message || String(error), true); }
})();
