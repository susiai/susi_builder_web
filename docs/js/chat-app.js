"use strict";

// Entry point for generated apps. The full Chat UI and agent loop are shared with chat.html.
const susiChatApp = (() => {
	let workspace;

	function open(appId = document.body.dataset.appId) {
		if (!/^[a-f0-9]{32}$/.test(appId)) throw new Error("Missing or invalid Chat app ID.");
		if (workspace) {
			if (workspace.appId !== appId) throw new Error("Only one Chat workspace can be opened in this page.");
			return workspace;
		}
		const bridge = window.susi?.workspace;
		const original = window.vfsReady;
		const ready = bridge ? Promise.resolve(createChatWorkspace(bridge)) : Promise.resolve(original).then(vfs => {
			if (!vfs) throw new Error("The app's workspace storage is unavailable.");
			return createChatWorkspace(createChatWorkspaceAccess(vfs, "/.webstation/apps/" + appId + "/chat/"));
		});
		window.vfsReady = ready;
		const apiKey = bridge ? (host, value) => value === undefined
			? bridge("readApiKey", [host]) : bridge("writeApiKey", [host, value])
			: llmClient.createSessionKeyStore(appId);
		return workspace = { appId, ready, apiKey, readConfig: readLLMConfig, writeConfig: writeLLMConfig };
	}

	async function mount({ appId, modelHref = "agent-chat-config.html", container = document.body } = {}) {
		const projectsRoot = "/Projects/";
		if (document.body.hasAttribute("data-chat-demo")) {
			mountSusiChat({ demo: true, modelHref, container, projectsRoot });
			return;
		}
		const { ready, apiKey } = open(appId);
		const vfs = await ready;
		await vfs.mkdir(projectsRoot);
		const directory = "/.webstation/conversations/";
		const files = (await vfs.ls(directory)).filter(name => !name.includes("/") && name.endsWith(".json"));
		const values = new Map(await Promise.all(files.map(async name =>
			[decodeURIComponent(name.slice(0, -5)), await vfs.getasync(directory + name)])));
		let writes = Promise.resolve();
		let pending = 0;
		let failure;
		const history = {
			get pending() { return pending > 0; },
			getItem: key => values.get(key) ?? null,
			setItem(key, value) {
				if (failure) throw failure;
				const expected = history.getItem(key);
				values.set(key, value);
				pending++;
				writes = writes.then(async () => {
					if (failure) return;
					await vfs.update(directory + encodeURIComponent(key) + ".json", source => {
						if ((source ?? null) !== expected) {
							throw Object.assign(new Error("This conversation changed in another tab. Export it before reloading."),
								{ code: "EEXIST" });
						}
						return value;
					});
				}).catch(error => {
					failure = error;
					history.onError?.(error);
				}).finally(() => { pending--; });
				return writes;
			}
		};
		mountSusiChat({ historyStore: history, modelHref, container, projectsRoot, readApiKey: apiKey,
			allowBrowser: !window.susi?.workspace, showProjectPreview: false });
	}

	return { open, mount };
})();
