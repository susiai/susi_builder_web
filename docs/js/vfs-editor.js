"use strict";

function createVfsAceEditor(host) {
	return window.ace.edit(host, {
		theme: { cssClass: "ace-susi", isDark: true, cssText: "", padding: 12 },
		fontFamily: getComputedStyle(host).getPropertyValue("--font-mono").trim(),
		fontSize: "0.875rem",
		showPrintMargin: false
	});
}

// Keep the syntax modes available when the editor is opened directly from disk.
const vfsAceModes = new Set([
	"c_cpp", "css", "golang", "html", "java", "javascript", "json", "jsx",
	"markdown", "python", "rust", "sh", "tsx", "typescript", "xml", "yaml"
]);

function setVfsAceMode(session, path) {
	const detected = window.ace.require("ace/ext/modelist").getModeForPath(path);
	const supported = vfsAceModes.has(detected.name);
	session.setMode(supported ? detected.mode : "ace/mode/text");
	return supported ? detected.caption : "Plain text";
}

function createVfsAceSession(path, source) {
	const session = window.ace.createEditSession(source);
	session.setUseWorker(false);
	const language = setVfsAceMode(session, path);
	session.setUseWrapMode(true);
	return { session, language };
}

function createVfsEditor({ onStatus, onSaved }) {
	const dialog = document.getElementById("vfs-editor");
	const host = document.getElementById("vfs-editor-input");
	const pathLabel = document.getElementById("vfs-editor-path");
	const modeLabel = document.getElementById("vfs-editor-mode");
	const status = document.getElementById("vfs-editor-status");
	const discardButton = document.getElementById("vfs-editor-discard");
	const saveButton = document.getElementById("vfs-editor-save");

	let editor;
	let file;
	let openRequest = 0;
	let saving = false;

	function close() {
		if (saving || !dialog.open) return;
		if (editor.searchBox?.active) editor.searchBox.hide();
		dialog.close();
		file = null;
	}

	async function save() {
		if (!file || saving) return;
		const { path, original, initial } = file;
		const value = editor.getValue();
		if (value === initial) {
			close();
			return;
		}

		saving = true;
		editor.setReadOnly(true);
		saveButton.disabled = true;
		discardButton.disabled = true;
		status.textContent = "Saving…";
		try {
			const vfs = await window.vfsReady;
			await vfs.put(path, value, { expectedValue: original });
		} catch (error) {
			status.textContent = error?.message || "Unable to save the file.";
			return;
		} finally {
			saving = false;
			editor.setReadOnly(false);
			saveButton.disabled = false;
			discardButton.disabled = false;
		}
		close();
		onSaved(path);
	}

	discardButton.addEventListener("click", close);
	saveButton.addEventListener("click", save);
	dialog.addEventListener("cancel", (event) => {
		event.preventDefault();
		close();
	});
	dialog.addEventListener("click", (event) => {
		if (event.target !== dialog) return;
		const { left, right, top, bottom } = dialog.getBoundingClientRect();
		const { clientX, clientY } = event;
		if (clientX < left || clientX > right || clientY < top || clientY > bottom) close();
	});

	return async function open(path) {
		if (!path || path.endsWith("/") || dialog.open) return;
		const request = ++openRequest;
		try {
			const vfs = await window.vfsReady;
			const original = await vfs.getasync(path);
			if (request !== openRequest) return;
			if (typeof original !== "string") {
				onStatus("Binary files can be downloaded from the Explorer.");
				return;
			}

			if (!editor) {
				editor = createVfsAceEditor(host);
				editor.commands.addCommand({
					name: "saveVfsFile",
					bindKey: { win: "Ctrl-S", mac: "Command-S" },
					exec: save
				});
				new ResizeObserver(() => {
					if (dialog.open) editor.resize();
				}).observe(host);
			}

			const { session, language } = createVfsAceSession(path, original);
			const previous = editor.session;
			editor.setSession(session);
			previous.destroy();

			file = { path, original, initial: session.getValue() };
			pathLabel.textContent = path;
			modeLabel.textContent = language;
			status.textContent = "";
			onStatus("");
			dialog.showModal();
			editor.resize(true);
			editor.focus();
		} catch {
			if (request === openRequest) onStatus("Unable to load file for editing.", true);
		}
	};
}
