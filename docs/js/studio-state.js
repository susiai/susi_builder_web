"use strict";

function parseStudioConfig(source) {
	const config = JSON.parse(source === undefined ? "{}" : source);
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("config.json must contain a JSON object.");
	}
	return config;
}

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
	let source;
	try {
		source = await vfs.getasync("/config.json");
	} catch (error) {
		if (error !== "Key not found") throw error;
	}
	return normalizeStudioState(parseStudioConfig(source).codeStudio);
}

function writeStudioState(vfs, state) {
	return vfs.update("/config.json", (source) => {
		const config = parseStudioConfig(source);
		return JSON.stringify({ ...config, codeStudio: state }, null, 2);
	});
}

// The managed session must not recursively embed older copies of itself in config drafts.
// Other files retain their exact text, including incomplete JSON while it is being edited.
function studioDraftText(path, text, ignorePageSettings = false) {
	if (path === "/config.json") {
		try {
			const config = parseStudioConfig(text);
			delete config.codeStudio;
			if (ignorePageSettings) delete config.pages;
			return JSON.stringify(config, null, 2);
		} catch {}
	}
	return text;
}

function writeStudioConfig(vfs, value, base) {
	const edited = parseStudioConfig(value);
	// A page can remember a selection while this editor is open. Preserve it unless the user edited that section.
	let keepPageSettings = false;
	try { keepPageSettings = JSON.stringify(edited.pages) === JSON.stringify(parseStudioConfig(base).pages); }
	catch { /* A malformed base can still be repaired when it matches the current file. */ }
	const expected = studioDraftText("/config.json", base, keepPageSettings);
	return vfs.update("/config.json", (source) => {
		let current;
		try {
			current = parseStudioConfig(source);
		} catch (error) {
			// Allow repairing the exact malformed file that was opened, without overwriting a newer edit.
			if (source !== base) throw error;
			current = {};
		}
		if (studioDraftText("/config.json", source, keepPageSettings) !== expected) {
			throw new Error("The configuration changed while you were editing.");
		}
		// Save user settings while retaining the latest session written by Code Studio.
		if (keepPageSettings) edited.pages = current.pages;
		return JSON.stringify({ ...edited, codeStudio: current.codeStudio }, null, 2);
	});
}
