"use strict";

(async () => {
	function binaryTableEditorUrl(path) {
		return /\.(parquet|xlsx)$/i.test(path) ? tableEditorUrl(path) : null;
	}
	const requested = history.state?.studioEdit?.path ?? new URLSearchParams(location.search).get("file");
	const requestedTable = requested?.startsWith("/") && binaryTableEditorUrl(requested);
	if (requestedTable) {
		window.location.replace(requestedTable);
		return;
	}
	const studio = document.getElementById("code-studio");
	const tree = document.getElementById("studio-tree");
	const explorer = document.getElementById("studio-explorer");
	const treeScroll = document.getElementById("studio-tree-scroll");
	const treeEmpty = document.getElementById("studio-tree-empty");
	const toggle = document.getElementById("studio-toggle");
	const tablist = document.getElementById("studio-tabs");
	const panel = document.getElementById("studio-panel");
	const host = document.getElementById("studio-editor");
	const preview = document.getElementById("studio-image-preview");
	const previewImage = preview.querySelector("img");
	const empty = document.getElementById("studio-empty");
	const pathLabel = document.getElementById("studio-path");
	const languageLabel = document.getElementById("studio-language");
	const saveGroup = document.getElementById("studio-save-group");
	const saveButton = document.getElementById("studio-save");
	const saveStatus = document.getElementById("studio-save-status");
	const chatToggle = document.getElementById("studio-chat-toggle");
	const chatUndo = document.getElementById("studio-chat-undo");
	const chatForm = document.getElementById("studio-chat");
	const chatPrompt = document.getElementById("studio-chat-prompt");
	const chatSelection = document.getElementById("studio-chat-selection");
	const chatSubmit = document.getElementById("studio-chat-submit");
	const chatClose = document.getElementById("studio-chat-close");
	const chatStatus = document.getElementById("studio-chat-status");
	const chatResult = document.getElementById("studio-chat-result");
	let chatRun;
	let lastEdit = history.state?.studioUndo;
	const dictationControls = document.getElementById("studio-dictation-controls");
	const recordButton = document.getElementById("studio-record");
	const stopRecording = document.getElementById("studio-stop-recording");
	const dictationFeedback = document.getElementById("studio-dictation-feedback");
	const dictationStatus = document.getElementById("studio-dictation-status");
	const dictationProgress = document.getElementById("studio-dictation-progress");
	const message = document.getElementById("studio-message");
	const menu = document.getElementById("studio-context");
	const menuItems = [...menu.querySelectorAll("button")];
	const narrow = matchMedia("(max-width: 42rem)");
	const touch = matchMedia("(pointer: coarse)");

	let openFiles = new Map();
	const fileRows = new Map();
	const expanded = new Set();
	const busyPaths = new Set();
	let active;
	let selectedPath;
	let context;
	let openRequest = 0;
	let refreshRequest = 0;
	let nextTabId = 0;
	let listedPaths;
	let vfs;
	let editor;
	let emptySession;
	let previewUrl;
	let speechSettings;
	let speechRequest = 0;
	const dictation = stt.createDictation({
		recordButton, stopButton: stopRecording, microphonePanel: document.getElementById("studio-microphone"),
		update: updateDictationControls, report: showDictationStatus
	});
	let restoring = true;
	let stateTimer;
	let stateRevision = 0;
	let storedRevision = 0;
	let stateWrite;
	let stateError = "";
	let navigating = false;
	const pendingWrites = new Set();
	const navigationDocuments = new WeakSet();

	function pathWithin(path, root) {
		return path === root || (root.endsWith("/") && path?.startsWith(root));
	}

	function isBusy(path) {
		return Boolean(path && [...busyPaths].some(busy => pathWithin(path, busy) || pathWithin(busy, path)));
	}

	function showMessage(text = "", error = false) {
		message.textContent = text;
		message.hidden = !text;
		message.toggleAttribute("data-error", error);
	}

	function showDictationStatus(text = "", error = false) {
		dictationStatus.textContent = text;
		dictationStatus.toggleAttribute("data-error", error);
		dictationFeedback.hidden = !text;
	}

	function updateDictationControls() {
		dictationControls.hidden = !active?.session;
		dictation.render(Boolean(speechSettings), !active?.session || editor.getReadOnly());
		updateChatControls();
	}

	async function refreshSpeechSettings() {
		if (!vfs || dictation.busy || vfs.wasReset) return;
		const request = ++speechRequest;
		const settings = await stt.activeSettings(vfs).catch(() => undefined);
		if (request !== speechRequest || dictation.busy) return;
		if (speechSettings && (speechSettings.model !== settings?.model || speechSettings.device !== settings?.device)) {
			stt.close();
		}
		speechSettings = settings;
		updateDictationControls();
	}

	recordButton.addEventListener("click", async () => {
		if (recordButton.disabled) return;
		const file = active;
		const settings = speechSettings;
		try {
			const transcript = await dictation.run((audio, signal) =>
				stt.transcribeWithProgress(vfs, settings, audio, signal, {
					container: dictationProgress, report: showDictationStatus
				}), settings);
			if (active !== file || editor.getReadOnly() || vfs.wasReset) return;
			file.session.markUndoGroup();
			const end = file.session.insert(editor.getCursorPosition(), transcript);
			file.session.markUndoGroup();
			editor.clearSelection();
			editor.moveCursorToPosition(end);
			editor.focus();
			showDictationStatus("Transcript inserted at the cursor.");
		} catch (error) {
			if (active !== file || vfs.wasReset) return;
			const canceled = error?.name === "AbortError";
			showDictationStatus(canceled ? "Dictation canceled." : error?.message || "Could not record or transcribe audio.", !canceled);
		}
	});
	document.getElementById("studio-dictation-cancel").addEventListener("click", dictation.cancel);

	function sessionSnapshot() {
		return {
			version: 1,
			tabs: [...openFiles.values()].map((file) => {
				if (!file.session) return { path: file.path };
				const tab = {
					path: file.path,
					cursor: file.session.selection.getCursor(),
					scrollTop: file.session.getScrollTop(),
					scrollLeft: file.session.getScrollLeft()
				};
				if (file.dirty) {
					tab.base = studioDraftText(file.path, file.source);
					tab.draft = studioDraftText(file.path, file.session.getValue());
				}
				return tab;
			}),
			activePath: active?.path,
			expandedFolders: [...expanded],
			explorerOpen: studio.dataset.explorerOpen === "true"
		};
	}

	function queueSessionSave(immediate = false) {
		if (restoring) return;
		stateRevision += 1;
		clearTimeout(stateTimer);
		if (immediate) return persistSession();
		stateTimer = setTimeout(persistSession, 500);
	}

	function persistSession() {
		clearTimeout(stateTimer);
		stateTimer = undefined;
		if (restoring || !vfs || vfs.wasReset) return Promise.resolve(true);
		if (stateWrite) return stateWrite;
		stateWrite = (async () => {
			while (storedRevision < stateRevision) {
				const revision = stateRevision;
				try {
					await writeStudioState(vfs, sessionSnapshot());
					storedRevision = revision;
					if (stateError) showMessage(active?.error, Boolean(active?.error));
					stateError = "";
				} catch (error) {
					stateError = error?.message || "Unable to save the Code Studio session.";
					showMessage(`Could not save the workspace: ${stateError}`, true);
					return false;
				}
			}
			return true;
		})().finally(() => { stateWrite = undefined; });
		return stateWrite;
	}

	async function readSource(path) {
		const value = await vfs.getasync(path);
		const type = vfsImageType(path);
		if (type) return { image: new Blob([value], { type }), text: typeof value === "string" ? value : undefined };
		if (typeof value === "string") return { text: value };
		const format = tableFileFormat(path);
		if (format !== "csv" && format !== "jsonl") return {};
		// UTF-16 CSV and older uploads can be stored as bytes. Keep their encoding and VFS conflict check on save.
		const snapshot = await vfs.fileSystem.readFile(path);
		const { text, encoding } = decodeTableText(format, snapshot.bytes);
		return { text, encoded: { ...snapshot, encoding } };
	}

	async function restoreSession() {
		const state = await readStudioState(vfs);
		for (const path of state.expandedFolders) expanded.add(path);
		showExplorer(state.explorerOpen);
		const contents = await Promise.allSettled(state.tabs.map(tab => readSource(tab.path)));
		let unavailable = false;
		for (const [index, tab] of state.tabs.entries()) {
			const result = contents[index];
			const { text: current, encoded, image } = result.status === "fulfilled" ? result.value : {};
			const hasDraft = typeof tab.draft === "string";
			if (current === undefined && !image && !hasDraft) {
				unavailable = true;
				continue;
			}
			const alreadySaved = hasDraft && current !== undefined && studioDraftText(tab.path, current) === tab.draft;
			// Keep unsaved SVG source from earlier sessions accessible as an editor draft.
			if (image && (!hasDraft || alreadySaved)) {
				createTab(tab.path, { image });
				continue;
			}
			const base = hasDraft && !alreadySaved ? tab.base : current;
			const file = createTab(tab.path, { text: base, encoded: base === current ? encoded : undefined });
			if (hasDraft && !alreadySaved) {
				file.session.setValue(tab.draft);
				updateDirty(file);
				if (current === undefined || studioDraftText(tab.path, current) !== tab.base) {
					file.error = "The VFS file changed or was removed. Your draft was restored; review it before saving.";
				}
			}
			if (tab.cursor) file.session.selection.moveCursorTo(tab.cursor.row, tab.cursor.column);
			file.session.setScrollTop(tab.scrollTop || 0);
			file.session.setScrollLeft(tab.scrollLeft || 0);
		}
		activate(openFiles.get(state.activePath) || openFiles.values().next().value);
		if (unavailable) showMessage("Some previously open files are no longer available.");
	}

	async function navigateTo(href) {
		if (navigating || chatRun) return;
		navigating = true;
		// Existing file writes must finish before the last snapshot records their saved state.
		await Promise.allSettled([...pendingWrites]);
		if (await persistSession()) window.location.assign(href);
		else navigating = false;
	}

	function saveBeforeNavigation(event) {
		const link = event.target.closest("a[href]");
		if (restoring || !link || event.defaultPrevented || event.button !== 0 || event.ctrlKey ||
			event.metaKey || event.shiftKey || event.altKey || link.hasAttribute("download") || link.target === "_blank") return;
		event.preventDefault();
		navigateTo(link.href);
	}

	function watchNavigation(doc) {
		if (!doc || navigationDocuments.has(doc)) return;
		navigationDocuments.add(doc);
		doc.addEventListener("click", saveBeforeNavigation);
	}

	function icon(name) {
		const image = document.createElement("img");
		image.src = `icons/${name}.svg`;
		image.alt = "";
		return image;
	}

	function selectFile(path) {
		fileRows.get(selectedPath)?.removeAttribute("data-selected");
		selectedPath = path;
		fileRows.get(path)?.setAttribute("data-selected", "");
	}

	function renderTree(node, list) {
		for (const entry of sortedVfsChildren(node)) {
			const item = document.createElement("li");
			const label = document.createElement("span");
			label.textContent = entry.name;

			if (entry.type === "folder") {
				const folder = document.createElement("details");
				const summary = document.createElement("summary");
				const children = document.createElement("ul");
				folder.dataset.path = entry.path;
				folder.open = expanded.has(entry.path);
				summary.title = entry.name;
				summary.append(icon("place-folder"), label);
				folder.append(summary, children);
				renderTree(entry, children);
				item.append(folder);
				const play = createVfsPreviewLink(entry);
				if (play) item.append(play);
			} else {
				const row = document.createElement("div");
				row.dataset.studioFile = entry.path;
				fileRows.set(entry.path, row);
				const tableUrl = binaryTableEditorUrl(entry.path);
				const name = document.createElement(tableUrl ? "a" : "button");
				if (tableUrl) name.href = tableUrl;
				else name.type = "button";
				name.className = "studio-filename";
				name.title = tableUrl ? `Open ${entry.path} in Table editor` : entry.path;
				const fileIcon = vfsImageType(entry.path) ? "mime-image-x-generic" :
					tableEditorUrl(entry.path) ? "mime-x-office-spreadsheet" : "mime-text-x-generic";
				name.append(icon(fileIcon), label);
				const actions = document.createElement("button");
				actions.type = "button";
				actions.className = "studio-file-actions";
				actions.setAttribute("aria-label", `Actions for ${entry.name}`);
				actions.setAttribute("aria-haspopup", "menu");
				actions.textContent = "⋯";
				row.append(name, actions);
				item.append(row);
			}
			list.append(item);
		}
	}

	async function refreshTree() {
		if (restoring) return;
		const request = ++refreshRequest;
		try {
			const paths = await vfs.ls("/");
			if (request !== refreshRequest) return;
			const snapshot = JSON.stringify(paths);
			if (listedPaths === snapshot) return;
			listedPaths = snapshot;
			hideMenu();
			fileRows.clear();
			tree.replaceChildren();
			treeEmpty.textContent = "Right-click here to create a file or folder.";
			treeEmpty.hidden = paths.length > 0;
			renderTree(buildVfsTree(paths), tree);
			selectFile(selectedPath);
		} catch {
			if (request === refreshRequest) showMessage("Unable to read the VFS file list.", true);
		}
	}

	function showExplorer(open) {
		studio.dataset.explorerOpen = String(open);
		toggle.setAttribute("aria-expanded", String(open));
		queueSessionSave();
	}

	function updateSaveStatus() {
		updateChatControls();
		saveGroup.hidden = !active?.session;
		if (!active?.session) return;
		const state = active.saving ? "saving" : active.error ? "error" : active.dirty ? "dirty" : "saved";
		saveStatus.dataset.state = state;
		saveStatus.textContent = { saving: "Saving…", error: "Save failed", dirty: "Unsaved", saved: "Saved" }[state];
		saveButton.disabled = active.saving || Boolean(chatRun) || isBusy(active.path);
	}

	function chatUnavailable() {
		if (!active?.session) return "Open a text file to use file chat.";
		if (active.dirty || active.error) return "Save this file before using file chat.";
		if (restoring || navigating || active.saving || busyPaths.size || dictation.busy || editor.getReadOnly()) {
			return "Wait for the current operation to finish.";
		}
		return "";
	}

	function updateChatControls() {
		const unavailable = chatUnavailable();
		chatUndo.hidden = !lastEdit || lastEdit.path !== active?.path || !active?.session;
		chatUndo.disabled = Boolean(unavailable || chatRun);
		chatToggle.disabled = Boolean(unavailable || chatRun);
		chatToggle.title = unavailable || "File chat (Ctrl+I / Command+I)";
		chatPrompt.disabled = chatToggle.disabled;
		chatSubmit.disabled = chatToggle.disabled || !chatPrompt.value.trim();
		if (!chatRun) chatStatus.textContent = unavailable || "Enter to send · Shift+Enter for a new line";
	}

	function closeChat() {
		chatForm.hidden = true;
		chatToggle.setAttribute("aria-expanded", "false");
	}

	function updateChatSelection() {
		if (!chatForm.hidden && !chatRun) chatSelection.hidden = editor.selection.isEmpty();
	}

	function selectedPassage(file) {
		const range = file.session.selection.getRange();
		if (range.isEmpty()) return;
		const { start, end } = range;
		let text = file.session.getTextRange(range);
		// Ace uses one newline style per session. Quote the saved line endings so edit_file can match mixed-EOL text.
		if (start.row !== end.row && file.source.includes("\r")) {
			const parts = file.source.split(/(\r\n|\r|\n)/).slice(2 * start.row, 2 * end.row + 1);
			if (parts.length === 2 * (end.row - start.row) + 1) {
				parts[0] = parts[0].slice(start.column);
				parts[parts.length - 1] = parts.at(-1).slice(0, end.column);
				const saved = parts.join("");
				if (saved.replace(/\r\n?/g, "\n") === text.replace(/\r\n?/g, "\n")) text = saved;
			}
		}
		return { start, end, text };
	}

	function toggleChat() {
		if (chatRun) return;
		const reason = chatUnavailable();
		if (reason) {
			if (active?.session) showMessage(reason);
			return;
		}
		if (!chatForm.hidden) {
			closeChat();
			editor.focus();
			return;
		}
		openChat();
	}

	function openChat() {
		showMessage();
		hideMenu();
		if (narrow.matches) showExplorer(false);
		chatForm.hidden = false;
		chatToggle.setAttribute("aria-expanded", "true");
		chatPrompt.value = "";
		chatPrompt.placeholder = "Describe a change to " + active.name + "…";
		updateChatSelection();
		updateChatControls();
		chatPrompt.focus();
	}

	function lockForChat(locked) {
		editor.setReadOnly(locked);
		tablist.inert = explorer.inert = locked;
		chatClose.disabled = false;
		chatClose.textContent = locked ? "Cancel" : "×";
		chatClose.setAttribute("aria-label", locked ? "Cancel edit" : "Close file chat");
		chatForm.setAttribute("aria-busy", String(locked));
		updateSaveStatus();
		updateDictationControls();
	}

	function rememberEdit(undo) {
		const state = { ...history.state };
		if (undo) state.studioUndo = undo;
		else delete state.studioUndo;
		history.replaceState(state, "");
		lastEdit = undo;
	}

	async function undoChatEdit() {
		const file = active, undo = lastEdit;
		if (!undo || undo.path !== file?.path || chatRun || chatUnavailable()) return;
		const controller = chatRun = new AbortController();
		openRequest++;
		lockForChat(true);
		chatClose.disabled = true;
		chatStatus.textContent = "Restoring file…";
		showMessage();
		try {
			const { value, base } = await reverseStudioEdit(undo, file);
			controller.signal.throwIfAborted();
			const write = writeSource(file, value, base);
			pendingWrites.add(write);
			try { file.source = await write; }
			finally { pendingWrites.delete(write); }
			const cursor = file.session.selection.getCursor();
			file.session.setValue(file.source);
			file.savedValue = file.session.getValue();
			file.session.selection.moveCursorToPosition(cursor);
			file.error = "";
			updateDirty(file);
			rememberEdit(undefined);
			showMessage("Last AI edit undone.");
		} catch (error) {
			showMessage(error?.message || "Unable to undo the last AI edit.", true);
		} finally {
			chatRun = undefined;
			lockForChat(false);
			updateChatSelection();
			if (chatForm.hidden) editor.focus();
			else chatPrompt.focus();
		}
	}

	async function submitChat(event) {
		event.preventDefault();
		if (chatRun || chatForm.hidden || chatUnavailable() || !chatPrompt.value.trim()) return;
		const file = active;
		const instruction = chatPrompt.value.trim();
		const selection = selectedPassage(file);
		const controller = chatRun = new AbortController();
		const { signal } = controller;
		let committed;
		let reloading = false;
		openRequest++;
		lockForChat(true);
		chatClose.focus();
		showMessage();
		chatStatus.textContent = "Preparing file…";
		try {
			await Promise.allSettled([...pendingWrites]);
			if (!await persistSession()) throw new Error("Unable to preserve open editor drafts.");
			const config = await readLLMConfig();
			const workspace = await new WorkspaceConfigStore(vfs).read();
			const before = (await readSource(file.path)).text;
			if (typeof before !== "string" ||
				studioDraftText(file.path, before, true) !== studioDraftText(file.path, file.source, true)) {
				throw new Error("This file changed outside Code Studio. Reload it before applying an edit.");
			}
			signal.throwIfAborted();
			chatStatus.textContent = "Editing " + file.name + "…";
			const { text, reply } = await StudioFileChat.run({
				client: llmClient.create({ readApiKey: readLLMApiKey }), config, path: file.path, source: before, instruction,
				template: StudioFileChat.prompt(workspace), selection, markedTemplate: workspace.studioMarkedPrompt,
				maxToolCalls: agentSettings(workspace).maxToolCalls, signal,
				onStatus: status => { chatStatus.textContent = status; }
			});
			signal.throwIfAborted();
			chatClose.disabled = true;
			chatStatus.textContent = "Finishing edit…";
			if (before !== text) {
				const previous = lastEdit;
				const undo = await createStudioEditUndo(file.path, before, text, file.encoded?.encoding);
				signal.throwIfAborted();
				// Reserve the undo before committing, including when storage for the reload is limited.
				if (undo) rememberEdit(undo);
				const write = writeSource(file, text, before);
				pendingWrites.add(write);
				try { committed = await write; }
				catch (error) {
					if (undo && !vfs.wasReset) rememberEdit(previous);
					throw error;
				}
				finally { pendingWrites.delete(write); }
			}
			const after = committed ?? before;
			const ranges = StudioFileChat.addedRanges(before, after);
			if (reply) {
				document.getElementById("studio-chat-result-path").textContent = file.path;
				document.getElementById("studio-chat-output").textContent = reply;
				chatResult.showModal();
				await new Promise(resolve => chatResult.addEventListener("close", resolve, { once: true }));
			}
			if (!await persistSession()) throw new Error("Unable to preserve open editor drafts.");
			const studioEdit = { path: file.path, stamp: StudioFileChat.textStamp(after), ranges };
			history.replaceState({ ...history.state, studioEdit }, "");
			location.reload();
			reloading = true;
		} catch (error) {
			if (committed !== undefined) {
				file.source = file.savedValue = committed;
				file.session.setValue(committed);
				updateDirty(file);
			}
			showMessage(signal.aborted ? "File edit canceled." : error.message || "Unable to apply the edit.", !signal.aborted);
		} finally {
			if (!reloading) {
				chatRun = undefined;
				lockForChat(false);
				updateChatSelection();
				chatPrompt.focus();
			}
		}
	}

	function restoreAfterChat() {
		const { studioEdit, ...state } = history.state || {};
		if (!studioEdit) return;
		history.replaceState(state, "");
		if (studioEdit.path !== active?.path || chatUnavailable()) return;
		if (studioEdit.ranges?.length && StudioFileChat.textStamp(active.source) === studioEdit.stamp) {
			const session = active.session;
			const Range = ace.require("ace/range").Range;
			const markers = studioEdit.ranges.map(coords => session.addMarker(new Range(...coords), "studio-added-text", "text"));
			session.once("change", () => { for (const id of markers) session.removeMarker(id); });
			const [row, column] = studioEdit.ranges[0];
			editor.gotoLine(row + 1, column);
		}
		openChat();
	}

	function updateFilebar(file) {
		pathLabel.textContent = file.path;
		pathLabel.title = file.path;
		languageLabel.textContent = file.language;
	}

	function showImage(file) {
		preview.hidden = !file?.image;
		host.hidden = Boolean(file?.image);
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = undefined;
		previewImage.removeAttribute("src");
		if (!file?.image) return;
		const url = previewUrl = URL.createObjectURL(file.image);
		previewImage.alt = file.name;
		previewImage.src = url;
		previewImage.decode().catch(() => {
			if (previewUrl !== url) return;
			file.error = "Unable to display this image.";
			showMessage(file.error, true);
		});
	}

	function activate(file, focus = false) {
		if (active !== file) {
			closeChat();
			const wasDictating = dictation.busy;
			dictation.cancel();
			showDictationStatus(file?.session && wasDictating ? "Dictation canceled because the active file changed." : "");
			showImage(file);
		}
		if (active) {
			active.tab.removeAttribute("data-active");
			active.label.setAttribute("aria-selected", "false");
			active.label.tabIndex = -1;
		}
		active = file;
		panel.hidden = !file;
		empty.hidden = Boolean(file);
		updateSaveStatus();
		updateDictationControls();
		showMessage(file?.error, Boolean(file?.error));
		if (!file) {
			dictation.close();
			editor.setSession(emptySession);
			panel.removeAttribute("aria-labelledby");
			queueSessionSave(true);
			return;
		}

		file.tab.setAttribute("data-active", "");
		file.label.setAttribute("aria-selected", "true");
		file.label.tabIndex = 0;
		file.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
		panel.setAttribute("aria-labelledby", file.label.id);
		updateFilebar(file);
		selectFile(file.path);
		editor.setSession(file.session || emptySession);
		if (file.session) editor.resize(true);
		if (focus) {
			if (narrow.matches) showExplorer(false);
			if (file.session) editor.focus();
			else preview.focus({ preventScroll: true });
		}
		queueSessionSave(true);
	}

	function updateDirty(file) {
		file.dirty = file.session.getValue() !== file.savedValue;
		file.tab.toggleAttribute("data-dirty", file.dirty);
		if (active === file) updateSaveStatus();
		queueSessionSave();
	}

	function createTab(path, { text: source, encoded, image }) {
		const { session, language } = image ? { language: image.type === "image/svg+xml" ? "SVG image" : "PNG image" } :
			createVfsAceSession(path, source);
		const name = vfs.baseName(path);
		const tab = document.createElement("div");
		tab.className = "studio-tab";
		tab.setAttribute("role", "presentation");
		const label = document.createElement("button");
		label.type = "button";
		label.id = `studio-tab-${++nextTabId}`;
		label.className = "studio-tab-label";
		label.title = path;
		label.setAttribute("role", "tab");
		label.setAttribute("aria-controls", panel.id);
		label.setAttribute("aria-selected", "false");
		label.tabIndex = -1;
		const title = document.createElement("span");
		title.textContent = name;
		label.append(title);
		const close = document.createElement("button");
		close.type = "button";
		close.className = "studio-tab-close";
		close.setAttribute("aria-label", `Close ${name}`);
		close.title = "Close tab";
		close.textContent = "×";
		tab.append(label, close);
		tablist.append(tab);
		const file = { path, name, session, language, source, savedValue: session?.getValue(), encoded, image, tab, label, title, close };
		openFiles.set(path, file);
		if (session) {
			session.on("change", () => updateDirty(file));
			session.selection.on("changeCursor", () => queueSessionSave());
			session.on("changeScrollTop", () => queueSessionSave());
			session.on("changeScrollLeft", () => queueSessionSave());
		}
		queueSessionSave();
		label.addEventListener("click", () => {
			// A text draft from an older session stays accessible until the user saves or discards it.
			const tableUrl = !file.dirty && binaryTableEditorUrl(file.path);
			if (tableUrl) navigateTo(tableUrl);
			else activate(file, true);
		});
		close.addEventListener("click", () => closeTab(file));
		return file;
	}

	async function openFile(path) {
		if (isBusy(path)) return;
		const request = ++openRequest;
		const tableUrl = binaryTableEditorUrl(path);
		if (tableUrl) return navigateTo(tableUrl);
		const existing = openFiles.get(path);
		if (existing) {
			activate(existing, true);
			return;
		}

		try {
			const source = await readSource(path);
			if (chatRun || isBusy(path) || !fileRows.has(path)) return;
			if (source.text === undefined && !source.image) {
				if (request === openRequest) showMessage("Use Download in the file menu to open this binary file.");
				return;
			}
			const file = openFiles.get(path) || createTab(path, source);
			if (!active || request === openRequest) activate(file, request === openRequest);
		} catch {
			if (request === openRequest) showMessage("Unable to open the file.", true);
		}
	}

	function removeTab(file) {
		const files = [...openFiles.values()];
		const index = files.indexOf(file);
		if (index === -1) return;
		openFiles.delete(file.path);
		if (active === file) activate(files[index + 1] || files[index - 1], true);
		file.tab.remove();
		file.session?.destroy();
		queueSessionSave(true);
	}

	function closeTab(file) {
		if (file.saving || isBusy(file.path)) return;
		if (file.dirty && !window.confirm(`Close ${file.name} and discard its unsaved changes?`)) return;
		removeTab(file);
	}

	async function writeSource(file, value, base = file.source) {
		if (file.path === WorkspaceConfigStore.defaultPath) return writeStudioConfig(vfs, value, base);
		if (file.encoded) {
			const bytes = encodeTableText(value, file.encoded.encoding);
			const mtime = await vfs.fileSystem.write(file.path, bytes, { expectedFile: file.encoded, returnMtime: true });
			file.encoded = { ...file.encoded, bytes, mtime };
		} else await vfs.put(file.path, value, { expectedValue: base });
		return value;
	}

	async function saveFile(file) {
		if (chatRun || !file?.dirty || file.saving || isBusy(file.path)) return;
		const value = file.session.getValue();
		file.saving = true;
		file.close.disabled = true;
		if (active === file) {
			showMessage();
			updateSaveStatus();
		}
		let write;
		try {
			write = writeSource(file, value);
			pendingWrites.add(write);
			file.source = await write;
			file.savedValue = value;
			file.error = "";
			if (lastEdit?.path === file.path) rememberEdit(undefined);
		} catch (error) {
			file.error = error?.message || "Unable to save the file.";
		} finally {
			pendingWrites.delete(write);
			file.saving = false;
			file.close.disabled = false;
			updateDirty(file);
			if (active === file) showMessage(file.error, Boolean(file.error));
		}
	}

	function showMenu(target, x, y) {
		const row = target.closest("[data-studio-file]");
		const folder = target.closest("details[data-path]");
		const folderHeader = !row && folder && target.closest("summary")?.parentElement === folder;
		const path = row?.dataset.studioFile || (folderHeader ? folder.dataset.path : undefined);
		if (isBusy(path)) return;
		const format = row && tableFileFormat(path);
		context = {
			path,
			tableUrl: format === "csv" || format === "jsonl" ? tableEditorUrl(path) : null,
			directory: folder?.dataset.path || "/",
			focusTarget: row?.querySelector(".studio-filename") || folder?.querySelector("summary") || treeScroll
		};
		if (row) selectFile(context.path);
		for (const item of menuItems) {
			const command = item.dataset.command;
			if (command === "open-table") item.hidden = !context.tableUrl;
			else if (command === "rename") item.hidden = !path;
			else item.hidden = row ? command.startsWith("new-") : !command.startsWith("new-");
		}
		menu.setAttribute("aria-label", row ? "File actions" : folderHeader ? "Folder actions" : `Create in ${context.directory}`);
		menu.hidden = false;
		menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
		menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
		menuItems.find(item => !item.hidden).focus();
	}

	function menuForRow(row) {
		const rect = row.getBoundingClientRect();
		showMenu(row, rect.left + 12, rect.bottom);
	}

	function hideMenu(restoreFocus = false) {
		if (menu.hidden) return;
		const target = context?.focusTarget;
		menu.hidden = true;
		context = undefined;
		if (restoreFocus) (target?.isConnected ? target : treeScroll).focus({ preventScroll: true });
	}

	async function createEntry(directory, isDirectory) {
		const entered = window.prompt(`${isDirectory ? "New folder" : "New file"} in ${directory}\nName:`);
		if (entered === null) return;
		const name = entered.trim();
		if (!name || name === "." || name === ".." || /[/\\\x00-\x1f\x7f]/.test(name)) {
			showMessage("Enter a valid name without a path.", true);
			return;
		}
		const path = directory + name;
		const tableUrl = !isDirectory && binaryTableEditorUrl(path);
		if (isBusy(path) || openFiles.has(path)) {
			showMessage(`An entry named ${name} already exists.`, true);
			return;
		}
		busyPaths.add(path);
		let write;
		try {
			// These public VFS operations check for both files and folders in the same write transaction.
			write = isDirectory ? vfs.fileSystem.mkdir(path) : vfs.fileSystem.write(path, "", { exclusive: true });
			pendingWrites.add(write);
			await write;
			if (directory !== "/") expanded.add(directory);
			if (isDirectory) {
				expanded.add(path + "/");
				queueSessionSave(true);
			} else if (tableUrl || vfsImageType(path)) {
				queueSessionSave();
			} else {
				openRequest += 1;
				activate(createTab(path, { text: "" }), true);
			}
			showMessage();
			await refreshTree();
			if (isDirectory) tree.querySelector(`details[data-path="${CSS.escape(path + "/")}"] > summary`)?.focus();
		} catch (error) {
			showMessage(error?.code === "EEXIST" || error?.code === "EISDIR"
				? `An entry named ${name} already exists.` : error?.message || "Unable to create the entry.", true);
			return;
		} finally {
			pendingWrites.delete(write);
			busyPaths.delete(path);
			updateSaveStatus();
		}
		if (tableUrl) await navigateTo(tableUrl);
	}

	async function renameEntry(path) {
		if (!path || isBusy(path)) return;
		const isFolder = path.endsWith("/");
		const kind = isFolder ? "folder" : "file";
		const files = [...openFiles.values()].filter(file => pathWithin(file.path, path));
		if (files.some(file => file.saving)) {
			showMessage("Wait for the current save to finish before renaming.", true);
			return;
		}
		const current = vfs.baseName(path);
		const name = window.prompt("Rename " + kind, current);
		if (name === null || name === current) return;
		if (!name.trim() || name === "." || name === ".." || /[/\\\x00-\x1f\x7f]/.test(name)) {
			showMessage("Enter a valid " + kind + " name without a path.", true);
			return;
		}
		const entry = isFolder ? path.slice(0, -1) : path;
		const target = vfs.parentDir(entry) + name + (isFolder ? "/" : "");
		if ([...openFiles.keys()].some(key => pathWithin(key, target)) || isBusy(target)) {
			showMessage(`The name ${name} is already in use.`, true);
			return;
		}

		busyPaths.add(path);
		busyPaths.add(target);
		for (const file of files) file.close.disabled = true;
		updateSaveStatus();
		let write;
		try {
			write = vfs.fileSystem.mv(path, target, { overwrite: false });
			pendingWrites.add(write);
			await write;
			const movedPath = key => target + key.slice(path.length);
			if (lastEdit && pathWithin(lastEdit.path, path)) rememberEdit({ ...lastEdit, path: movedPath(lastEdit.path) });
			for (const file of files) {
				file.path = movedPath(file.path);
				file.label.title = file.path;
				if (!isFolder) {
					file.name = file.title.textContent = name;
					file.close.setAttribute("aria-label", `Close ${name}`);
					if (file.session) file.language = setVfsAceMode(file.session, target);
					else if (active === file) previewImage.alt = name;
				}
			}
			// Keep the map order aligned with the visible tab order.
			if (files.length) openFiles = new Map([...openFiles.values()].map(file => [file.path, file]));
			if (isFolder) {
				for (const folder of [...expanded].filter(folder => pathWithin(folder, path))) {
					expanded.delete(folder);
					expanded.add(movedPath(folder));
				}
			}
			if (pathWithin(selectedPath, path)) selectFile(movedPath(selectedPath));
			if (files.includes(active)) updateFilebar(active);
			const controlFor = entry => isFolder
				? tree.querySelector(`details[data-path="${CSS.escape(entry)}"] > summary`)
				: fileRows.get(entry)?.querySelector(".studio-filename");
			const restoreFocus = controlFor(path)?.contains(document.activeElement);
			showMessage(active?.error, Boolean(active?.error));
			await queueSessionSave(true);
			await refreshTree();
			if (restoreFocus && document.activeElement === document.body) controlFor(target)?.focus();
		} catch (error) {
			const collision = ["EEXIST", "EISDIR", "ENOTDIR"].includes(error?.code);
			showMessage(collision ? `An entry named ${name} already exists.` : error?.message || "Unable to rename the " + kind + ".", true);
		} finally {
			pendingWrites.delete(write);
			busyPaths.delete(path);
			busyPaths.delete(target);
			for (const file of files) file.close.disabled = false;
			updateSaveStatus();
		}
	}

	async function deleteFile(path) {
		const file = openFiles.get(path);
		if (file?.saving || isBusy(path)) return;
		const name = vfs.baseName(path);
		const question = file?.dirty ? `Delete ${name} and discard its unsaved changes?` : `Delete ${name} from the VFS?`;
		if (!window.confirm(question)) return;
		busyPaths.add(path);
		updateSaveStatus();
		let write;
		try {
			write = vfs.deleteTree(path);
			pendingWrites.add(write);
			await write;
			if (lastEdit?.path === path) rememberEdit(undefined);
			if (file) removeTab(file);
			if (selectedPath === path) selectFile(undefined);
			await refreshTree();
		} catch (error) {
			showMessage(error?.message || "Unable to delete the file.", true);
		} finally {
			pendingWrites.delete(write);
			busyPaths.delete(path);
			updateSaveStatus();
		}
	}

	const siteMenu = document.getElementById("site-menu");
	watchNavigation(document);
	siteMenu.addEventListener("load", () => watchNavigation(siteMenu.contentDocument));
	watchNavigation(siteMenu.contentDocument);

	try {
		vfs = await window.vfsReady;
		editor = createVfsAceEditor(host);
		editor.on("changeSelection", updateChatSelection);
		emptySession = editor.session;
		editor.textInput.getElement().setAttribute("aria-label", "Code editor");
		refreshSpeechSettings();
		new ResizeObserver(() => {
			if (active?.session) editor.resize();
		}).observe(host);
	} catch {
		treeEmpty.textContent = "Unable to start Code Studio.";
		return;
	}

	toggle.addEventListener("click", () => showExplorer(studio.dataset.explorerOpen !== "true"));
	tree.addEventListener("toggle", (event) => {
		const folder = event.target;
		if (folder.open) expanded.add(folder.dataset.path);
		else expanded.delete(folder.dataset.path);
		queueSessionSave();
	}, true);
	tree.addEventListener("click", (event) => {
		const row = event.target.closest("[data-studio-file]");
		if (!row) return;
		const path = row.dataset.studioFile;
		if (isBusy(path)) { event.preventDefault(); return; }
		selectFile(path);
		if (event.target.closest("a[href]")) return;
		if (event.target.closest(".studio-file-actions")) menuForRow(row);
		else if (event.detail === 0 || touch.matches) openFile(path);
	});
	tree.addEventListener("dblclick", (event) => {
		const name = event.target.closest("button.studio-filename");
		if (name) openFile(name.parentElement.dataset.studioFile);
	});
	explorer.addEventListener("contextmenu", (event) => {
		if (event.target.closest('a[data-action="play"]')) return;
		event.preventDefault();
		showMenu(event.target, event.clientX, event.clientY);
	});
	explorer.addEventListener("keydown", (event) => {
		if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
		if (event.target.closest('a[data-action="play"]')) return;
		event.preventDefault();
		const rect = event.target.getBoundingClientRect();
		showMenu(event.target, rect.left + 12, rect.top + Math.min(rect.height, 30));
	});
	menu.addEventListener("keydown", (event) => {
		if (event.key === "Escape" || event.key === "Tab") {
			event.preventDefault();
			hideMenu(true);
		} else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			event.preventDefault();
			const items = menuItems.filter(item => !item.hidden);
			const index = items.indexOf(document.activeElement);
			const step = event.key === "ArrowUp" ? -1 : 1;
			items[(index + step + items.length) % items.length].focus();
		}
	});
	menu.addEventListener("click", async (event) => {
		const item = event.target.closest("[data-command]");
		if (!item || item.hidden || !context) return;
		const action = item.dataset.command;
		const { path, directory, tableUrl } = context;
		hideMenu(true);
		if (action === "new-file" || action === "new-folder") {
			await createEntry(directory, action === "new-folder");
		} else if (action === "open-table") {
			if (tableUrl) await navigateTo(tableUrl);
		} else if (action === "delete") {
			await deleteFile(path);
		} else if (action === "rename") {
			await renameEntry(path);
		} else {
			try {
				await downloadVfsFile(vfs, path);
			} catch (error) {
				showMessage(error?.message || "Unable to download the file.", true);
			}
		}
	});
	document.addEventListener("pointerdown", (event) => {
		if (!menu.contains(event.target)) hideMenu();
	});
	window.addEventListener("resize", () => hideMenu());
	treeScroll.addEventListener("scroll", () => hideMenu());
	chatToggle.addEventListener("click", toggleChat);
	chatUndo.addEventListener("click", undoChatEdit);
	chatClose.addEventListener("click", () => {
		if (chatRun) chatRun.abort();
		else { closeChat(); editor.focus(); }
	});
	chatForm.addEventListener("submit", submitChat);
	chatPrompt.addEventListener("input", updateChatControls);
	chatForm.addEventListener("keydown", event => {
		if (event.isComposing) return;
		if (event.key === "Escape" && !chatClose.disabled) {
			event.preventDefault();
			chatClose.click();
		} else if (event.target === chatPrompt && event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			chatForm.requestSubmit();
		}
	});
	saveButton.addEventListener("click", () => saveFile(active));
	document.addEventListener("keydown", (event) => {
		if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || chatResult.open) return;
		if (event.key.toLowerCase() === "i" && active?.session) {
			event.preventDefault();
			event.stopPropagation();
			if (event.repeat) return;
			if (!chatForm.hidden && !chatPrompt.disabled && editor.isFocused()) chatPrompt.focus();
			else toggleChat();
		} else if (event.key.toLowerCase() === "s") {
			event.preventDefault();
			event.stopPropagation();
			saveFile(active);
		}
	}, true);
	tablist.addEventListener("keydown", (event) => {
		if (!event.target.matches('[role="tab"]')) return;
		const files = [...openFiles.values()];
		const index = files.findIndex(file => file.label === event.target);
		const destination = {
			ArrowLeft: (index - 1 + files.length) % files.length,
			ArrowRight: (index + 1) % files.length,
			Home: 0,
			End: files.length - 1
		}[event.key];
		if (destination !== undefined) {
			event.preventDefault();
			activate(files[destination]);
			files[destination].label.focus();
		} else if (event.key === "Delete") {
			event.preventDefault();
			closeTab(files[index]);
		}
	});
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) persistSession();
		else refreshTree();
	});
	window.addEventListener("focus", refreshSpeechSettings);
	window.addEventListener("pagehide", () => {
		chatRun?.abort();
		dictation.close();
		stt.close();
		persistSession();
	});
	window.addEventListener("vfs-reset", () => {
		chatRun?.abort();
		if (lastEdit) rememberEdit(undefined);
		speechRequest += 1;
		speechSettings = undefined;
		dictation.close();
		stt.close();
		updateDictationControls();
	});
	window.addEventListener("pageshow", event => {
		navigating = false;
		refreshTree();
		if (event.persisted) refreshSpeechSettings();
	});
	window.addEventListener("beforeunload", (event) => {
		if (vfs?.wasReset) return;
		persistSession();
		if (pendingWrites.size || (storedRevision < stateRevision && [...openFiles.values()].some(file => file.dirty))) {
			event.preventDefault();
			event.returnValue = true;
		}
	});
	studio.inert = true;
	try {
		await restoreSession();
	} catch (error) {
		showMessage(error?.message || "Unable to restore the Code Studio session.", true);
	} finally {
		restoring = false;
		await refreshTree();
		studio.inert = false;
	}
	if (requested?.startsWith("/") && !requested.endsWith("/")) await openFile(requested);
	updateChatControls();
	restoreAfterChat();
})();
