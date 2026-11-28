"use strict";

function buildVfsTree(entries) {
	const root = { name: "/", path: "/", type: "folder", children: new Map() };

	entries.forEach((entry) => {
		if (!entry) return;
		const isDir = entry.endsWith("/");
		const parts = entry.split("/").filter(Boolean);
		let current = root;
		let currentPath = "/";

		parts.forEach((part, index) => {
			const isLast = index === parts.length - 1;
			const partIsDir = isLast ? isDir : true;
			const nextPath = `${currentPath}${part}${partIsDir ? "/" : ""}`;
			if (!current.children.has(part)) {
				current.children.set(part, {
					name: part,
					path: nextPath,
					type: partIsDir ? "folder" : "file",
					children: new Map()
				});
			}
			const child = current.children.get(part);
			if (partIsDir) {
				child.type = "folder";
			} else if (isLast) {
				child.type = "file";
			}
			current = child;
			currentPath = nextPath;
		});
	});

	return root;
}

function sortedVfsChildren(node) {
	return Array.from(node.children.values()).sort((a, b) => {
		if (a.type !== b.type) {
			return a.type === "folder" ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
}

function tableFileFormat(path) {
	return /\.(csv|jsonl|parquet)$/i.exec(path)?.[1].toLowerCase();
}

function vfsImageType(path) {
	const format = /\.(png|svg)$/i.exec(path)?.[1].toLowerCase();
	if (format) return format === "svg" ? "image/svg+xml" : "image/png";
}

function tableEditorUrl(path) {
	return (tableFileFormat(path) || /\.xlsx$/i.test(path)) ? "table.html?" + new URLSearchParams({ file: path }) : null;
}

function decodeTableText(format, bytes) {
	let encoding = "utf-8";
	if (format === "csv" && bytes[0] === 255 && bytes[1] === 254) encoding = "utf-16le";
	if (format === "csv" && bytes[0] === 254 && bytes[1] === 255) encoding = "utf-16be";
	const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
	return { text, encoding };
}

function encodeTableText(text, encoding) {
	if (encoding === "utf-16le" || encoding === "utf-16be") {
		const view = new DataView(new ArrayBuffer(text.length * 2));
		const littleEndian = encoding === "utf-16le";
		for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), littleEndian);
		return new Uint8Array(view.buffer);
	}
	return new TextEncoder().encode(text);
}

function createVfsPreviewLink(folder) {
	if (folder.type !== "folder" || folder.children.get("index.html")?.type !== "file") return null;
	return createProjectPreviewLink(folder.path);
}

function createProjectPreviewLink(path) {
	const play = document.createElement("a");
	play.href = `view.html?${new URLSearchParams({ path })}`;
	play.target = "_blank";
	play.rel = "noopener";
	play.dataset.action = "play";
	play.setAttribute("aria-label", "Preview website");
	play.title = "Preview website (opens in a new tab)";
	return play;
}

function downloadVfsBlob(blob, name) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function vfsDownloadBlob(vfs, path) {
	const contents = await vfs.getasync(path);
	const type = typeof contents === "string" ? "text/plain" : "application/octet-stream";
	return new Blob([contents], { type });
}

async function downloadVfsFile(vfs, path) {
	downloadVfsBlob(await vfsDownloadBlob(vfs, path), vfs.baseName(path));
}

async function importDroppedVfsFolder(vfs, parent, directory) {
	const entries = [];
	async function collect(folder, prefix) {
		const reader = folder.createReader();
		// A directory reader can return multiple batches, including on Chromium.
		while (true) {
			const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
			if (!batch.length) break;
			for (const child of batch) {
				const path = prefix + child.name;
				if (child.isDirectory) {
					entries.push({ path: path + "/", value: "" });
					await collect(child, path + "/");
				} else {
					const file = await new Promise((resolve, reject) => child.file(resolve, reject));
					const bytes = new Uint8Array(await file.arrayBuffer());
					entries.push({ path, value: vfs.fileSystem.fileValue(bytes) });
				}
			}
		}
	}
	await collect(directory, "");
	return vfs.addFolderTree(directory.name, entries, { parent });
}

async function exportVfsFolderToDirectory(vfs, path, destination) {
	const entries = await vfs.readFolderTree(path);
	const base = vfs.baseName(path) || "VFS";
	async function exists(parent, name) {
		try { await parent.getFileHandle(name); return true; }
		catch (error) {
			if (error.name === "NotFoundError") return false;
			if (error.name === "TypeMismatchError") return true;
			throw error;
		}
	}

	async function writeTree() {
		let name = base;
		for (let suffix = 2; await exists(destination, name); suffix++) name = base + " (" + suffix + ")";
		const root = await destination.getDirectoryHandle(name, { create: true });
		const directories = new Map([["", root]]);
		let currentPath = "";
		try {
			for (const entry of entries) {
				currentPath = entry.path;
				const parts = entry.path.split("/");
				const filename = parts.pop();
				let parent = root, prefix = "";
				for (const part of parts) {
					prefix += part + "/";
					if (!directories.has(prefix)) {
						if (await exists(parent, part)) throw new Error("A matching folder name already exists.");
						directories.set(prefix, await parent.getDirectoryHandle(part, { create: true }));
					}
					parent = directories.get(prefix);
				}
				if (!filename) continue;
				if (await exists(parent, filename)) throw new Error("A matching file name already exists.");
				const file = await parent.getFileHandle(filename, { create: true });
				const writer = await file.createWritable();
				try {
					await writer.write(new Blob([entry.value]));
					await writer.close();
				} catch (error) {
					await writer.abort().catch(() => {});
					throw error;
				}
			}
		} catch (error) {
			throw new Error(`Export incomplete in ${name} at ${currentPath}. ${error.message || error}`);
		}
		return name;
	}
	// Two Explorer tabs exporting to the same OS folder must choose distinct names.
	return navigator.locks ? navigator.locks.request("susi-explorer-folder-export", writeTree) : writeTree();
}
