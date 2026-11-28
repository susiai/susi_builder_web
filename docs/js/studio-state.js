"use strict";

function normalizeStudioState(state) {
	const tabs = [];
	const paths = new Set();
	if (state?.version === 1 && Array.isArray(state.tabs)) {
		for (const entry of state.tabs) {
			if (typeof entry?.path !== "string" || !entry.path.startsWith("/") ||
				entry.path.endsWith("/") || entry.path.includes("\0") || paths.has(entry.path)) continue;
			paths.add(entry.path);
			const tab = { path: entry.path };
			if (Number.isInteger(entry.cursor?.row) && entry.cursor.row >= 0 &&
				Number.isInteger(entry.cursor?.column) && entry.cursor.column >= 0) {
				tab.cursor = { row: entry.cursor.row, column: entry.cursor.column };
			}
			for (const key of ["scrollTop", "scrollLeft"]) {
				if (Number.isFinite(entry[key]) && entry[key] >= 0) tab[key] = entry[key];
			}
			if (typeof entry.draft === "string" && typeof entry.base === "string") {
				tab.draft = entry.draft;
				tab.base = entry.base;
			}
			tabs.push(tab);
		}
	}
	return {
		version: 1,
		tabs,
		activePath: paths.has(state?.activePath) ? state.activePath : tabs[0]?.path,
		expandedFolders: Array.isArray(state?.expandedFolders)
			? [...new Set(state.expandedFolders.filter(path => typeof path === "string" && path.startsWith("/") && path.endsWith("/")))]
			: [],
		explorerOpen: state?.explorerOpen !== false
	};
}

async function readStudioState(vfs) {
	const config = await new WorkspaceConfigStore(vfs).read();
	return normalizeStudioState(config.codeStudio);
}

function writeStudioState(vfs, state) {
	return new WorkspaceConfigStore(vfs).update(config => ({ ...config, codeStudio: state }));
}

// The managed session must not recursively embed older copies of itself in config drafts.
// Other files retain their exact text, including incomplete JSON while it is being edited.
function studioDraftText(path, text, ignorePageSettings = false) {
	if (path === WorkspaceConfigStore.defaultPath) {
		try {
			const config = WorkspaceConfigStore.parse(text);
			delete config.codeStudio;
			if (ignorePageSettings) delete config.pages;
			return JSON.stringify(config, null, 2);
		} catch {}
	}
	return text;
}

function sameStudioPageSettings(edited, base) {
	try { return JSON.stringify(edited.pages) === JSON.stringify(WorkspaceConfigStore.parse(base).pages); }
	catch { return false; } // A malformed base can still be repaired when it matches the current file.
}

function writeStudioConfig(vfs, value, base) {
	const edited = WorkspaceConfigStore.parse(value);
	// A page can remember a selection while this editor is open. Preserve it unless the user edited that section.
	const keepPageSettings = sameStudioPageSettings(edited, base);
	const expected = studioDraftText(WorkspaceConfigStore.defaultPath, base, keepPageSettings);
	return new WorkspaceConfigStore(vfs).updateFromSource(source => {
		let current;
		try {
			current = WorkspaceConfigStore.parse(source);
		} catch (error) {
			// Allow repairing the exact malformed file that was opened, without overwriting a newer edit.
			if (source !== base) throw error;
			current = {};
		}
		if (studioDraftText(WorkspaceConfigStore.defaultPath, source, keepPageSettings) !== expected) {
			throw new Error("The configuration changed while you were editing.");
		}
		// Save user settings while retaining the latest session written by Code Studio.
		return { ...edited, ...(keepPageSettings && { pages: current.pages }), codeStudio: current.codeStudio };
	});
}

async function studioEditVersion(text) {
	if (!globalThis.crypto?.subtle) return "text:" + text;
	return "sha256:" + await vfsSnapshotDigest([{ path: "", value: text }]);
}

// Carry an inverse replacement across the reload without storing the common prefix and suffix.
async function createStudioEditUndo(path, before, after, encoding) {
	const keepPages = path === WorkspaceConfigStore.defaultPath && sameStudioPageSettings(WorkspaceConfigStore.parse(after), before);
	before = studioDraftText(path, before, keepPages);
	after = studioDraftText(path, after, keepPages);
	if (before === after) return;
	let start = 0, oldEnd = before.length, end = after.length;
	while (start < oldEnd && start < end && before[start] === after[start]) start++;
	while (oldEnd > start && end > start && before[oldEnd - 1] === after[end - 1]) {
		oldEnd--;
		end--;
	}
	return { path, encoding, keepPages, start, end, removed: before.slice(start, oldEnd), version: await studioEditVersion(after) };
}

async function reverseStudioEdit(undo, file) {
	const base = studioDraftText(file.path, file.source, undo.keepPages);
	if (file.path !== undo.path || file.encoded?.encoding !== undo.encoding || await studioEditVersion(base) !== undo.version) {
		throw new Error("This file has changed since the last AI edit.");
	}
	return { value: base.slice(0, undo.start) + undo.removed + base.slice(undo.end), base };
}
