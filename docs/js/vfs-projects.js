"use strict";

const VFS_APPS_DIRECTORY = "/Apps/";

function isVfsProjectIndex(path) {
	if (!path.endsWith("/index.html") || path.startsWith(".webstation/")) return false;
	const root = path.slice(0, path.indexOf("/") + 1);
	// Both the current and former app directories list only their direct app folders.
	return (root !== VFS_APPS_DIRECTORY.slice(1) && root !== "apps/") ||
		/^[^/]+\/index\.html$/.test(path.slice(root.length));
}

function findVfsProjects(paths) {
	return paths
		.filter(isVfsProjectIndex)
		.map((path) => `/${path.slice(0, -"index.html".length)}`)
		.sort((a, b) => a.localeCompare(b));
}

function createVfsApp(vfs, name, entries, { indexHtml = "", reuseMatching = false } = {}) {
	const files = entries ?? [
		{ path: "index.html", value: indexHtml },
		{ path: "app.json", value: JSON.stringify({ version: 1, name, pinned: false }, null, 2) + "\n" }
	];
	return vfs.addFolderTree(name, files, { parent: VFS_APPS_DIRECTORY, reuseMatching });
}

function isVfsPreviewFolder(path) {
	return typeof path === "string" && path.startsWith("/") && path.endsWith("/") &&
		(path === "/" || path.slice(1, -1).split("/").every(part =>
			part && part !== "." && part !== ".." && !/[\\\x00-\x1f\x7f]/.test(part)));
}

// Both /index.html and index.html refer to a file at the root of the selected project.
function createVfsProjectPathResolver(root) {
	if (!root.startsWith("/") || !root.endsWith("/") || root.startsWith("/.webstation/") || root.includes("\0") ||
		root.split("/").some((part) => part === "." || part === "..")) {
		throw new Error("Invalid project directory.");
	}

	function resolve(path) {
		if (typeof path !== "string" || path.includes("\0")) throw new Error("Invalid project path.");
		const parts = [];
		for (const part of path.split("/")) {
			if (part === "..") {
				if (!parts.length) throw new Error("Path leaves the project directory.");
				parts.pop();
			} else if (part && part !== ".") {
				parts.push(part);
			}
		}
		return root + parts.join("/") + (parts.length && path.endsWith("/") ? "/" : "");
	}

	function filePath(path) {
		const resolved = resolve(path);
		if (resolved.endsWith("/")) throw new Error("Expected a file inside the project.");
		return resolved;
	}
	return { resolve, filePath };
}

function createProjectVfs(vfs, root, { guard } = {}) {
	const resolver = createVfsProjectPathResolver(root);
	const workspacePath = root.slice(1, -1);
	const projectName = workspacePath.split("/").at(-1);
	const prefixes = [...new Set([workspacePath, projectName].filter(Boolean))];
	function withinProject(path) {
		if (typeof path !== "string") return path;
		const relative = path.replace(/^\/+/, "");
		// An explicit ./ is always literal, including for a child with the same name as the project.
		const prefix = prefixes.find(name => relative.startsWith(`${name}/`));
		return prefix ? relative.slice(prefix.length + 1) : relative;
	}
	const resolve = path => resolver.resolve(withinProject(path));
	const filePath = path => resolver.filePath(withinProject(path));
	return {
		projectPath: path => `./${resolve(path).slice(root.length)}`,
		// The search engine walks paths in its own project-rooted filesystem after resolving the tool argument.
		fileSystem: {
			resolvePath: (base, path) => vfs.fileSystem.resolvePath(base, path),
			stat: path => vfs.fileSystem.stat(resolver.resolve(path)),
			readdir: path => vfs.fileSystem.readdir(resolver.resolve(path)),
			readBytes: path => vfs.fileSystem.readBytes(resolver.filePath(path))
		},
		getasync: (path) => vfs.getasync(resolve(path)),
		ls: (path) => vfs.ls(resolve(path.endsWith("/") ? path : `${path}/`)),
		put: (path, value, options) => vfs.put(path.endsWith("/") ? resolve(path) : filePath(path), value, { ...options, guard }),
		applyDiff: (path, diff) => vfs.applyDiff(filePath(path), diff, { guard }),
		editFile: (path, edits) => vfs.editFile(filePath(path), edits, { guard }),
		rm: (path) => vfs.rm(filePath(path), { guard }),
		cp: (from, to) => vfs.cp(filePath(from), filePath(to), { guard }),
		mv: (from, to) => vfs.mv(filePath(from), filePath(to), { guard })
	};
}

// The preview host owns the root. Its sandbox receives only these two file operations.
function createPreviewProjectFiles(vfs, root) {
	if (!isVfsPreviewFolder(root) || root === "/") throw new Error("Open a project folder to use project files.");
	const { filePath } = createVfsProjectPathResolver(root);
	return {
		async readFile(path) {
			const key = filePath(path);
			const { bytes, mtime } = await vfs.fileSystem.readFile(key);
			return new File([bytes], vfs.baseName(key), { lastModified: mtime });
		},
		async writeFile(path, value, previous, signal) {
			const key = filePath(path);
			if (typeof value !== "string" && !(value instanceof Blob) &&
				!(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
				throw new TypeError("Write text, a Blob or binary bytes to the project file.");
			}
			const options = { returnMtime: true, exclusive: previous === null };
			if (previous != null) {
				if (!(previous instanceof File)) throw new TypeError("Use the file returned by readFile for ifUnchanged.");
				options.expectedFile = { mtime: previous.lastModified, bytes: new Uint8Array(await previous.arrayBuffer()) };
			}
			const data = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value;
			signal?.throwIfAborted();
			const mtime = await vfs.fileSystem.write(key, data, options);
			return new File([data], vfs.baseName(key), { lastModified: mtime });
		}
	};
}
