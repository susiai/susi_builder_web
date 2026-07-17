"use strict";

(async () => {
	const params = new URLSearchParams(location.search);
	const folder = params.get("path");
	if (params.get("menu") !== "false") {
		const menu = document.getElementById("site-menu");
		menu.src = "navigation.html";
		menu.hidden = false;
	}
	const notice = document.getElementById("preview-notice");
	const status = document.getElementById("preview-status");
	const frame = document.getElementById("preview-frame");
	let preview;

	if (!isVfsPreviewFolder(folder)) {
		status.textContent = "Select View in Apps or Play on a folder with index.html in Explorer.";
		return;
	}

	function showError(text) {
		status.textContent = text;
		notice.hidden = false;
		frame.hidden = true;
	}

	async function navigate(path) {
		try {
			await preview.open(path);
			frame.hidden = false;
			notice.hidden = true;
		} catch (error) {
			if (error.name !== "AbortError") showError(error.message);
		}
	}

	window.addEventListener("pagehide", event => { if (!event.persisted) preview?.dispose(); });
	try {
		const vfs = await window.vfsReady;
		// One committed snapshot supplies the preview until the browser refreshes the page.
		const entries = await vfs.readFolderTree(folder);
		if (!entries.some(entry => entry.path === "index.html")) throw new Error("This VFS folder has no index.html.");
		const project = folder !== "/" && !folder.startsWith("/.webstation/");
		const workbench = project && entries.some(({ path }) => path === "js/susi-chat.js" || path === "js/webstation-chat.js");
		const snapshot = await prepareVfsPreview(workbench
			? entries.filter(entry => !entry.path.startsWith(".chat-workspace/"))
			: entries);
		preview = createVfsPreview(frame, snapshot, {
			onNavigate: navigate, onError: showError, allowRemoteResources: true,
			projectFiles: project ? createPreviewProjectFiles(vfs, folder) : undefined,
			projectWorkspace: workbench ? createChatWorkspaceAccess(vfs, folder + ".chat-workspace/", folder + "Projects/") : undefined
		});
		await navigate("/index.html");
	} catch (error) {
		showError(error.message || "Unable to read the VFS project.");
	}
})();
