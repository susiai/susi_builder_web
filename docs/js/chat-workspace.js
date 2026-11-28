"use strict";

// Both exported apps and sandboxed previews use the host VFS, rooted in the app's own workspace.
function createChatWorkspaceAccess(vfs, root, projects = root + "Projects/") {
	// Preview documents are replaced on navigation. Keep credentials in the parent tab, scoped to this app.
	const apiKey = llmClient.createSessionKeyStore(root, new Map());
	function resolve(path) {
		if (typeof path !== "string" || !path.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(path) ||
			path.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid app workspace path.");
		if (path === "/Projects") return projects.slice(0, -1);
		if (path.startsWith("/Projects/")) return projects + path.slice("/Projects/".length);
		return root + path.slice(1);
	}
	function writeOptions(fence, signal) {
		return fence ? { guard: { path: resolve(fence.path), owner: fence.owner, runId: fence.runId, signal } } : {};
	}
	function compareText(previous, value) {
		if ((previous !== undefined && typeof previous !== "string") || typeof value !== "string") {
			throw new Error("Chat settings and records must be text.");
		}
		return latest => {
			if (latest !== previous) throw Object.assign(new Error("The app file changed in another page."), { code: "EEXIST" });
			return value;
		};
	}
	function runScript(runtime, signal, folder, script, fence) {
		if (!isVfsPreviewFolder(folder) || !folder.startsWith("/Projects/") || folder === "/Projects/") {
			throw new Error("Choose an app project folder to run the script.");
		}
		return runtime.runFile(vfs.fileSystem, resolve(folder), script, { ...writeOptions(fence, signal), signal });
	}
	async function createFolder(name, parent, entries) {
		if (typeof name !== "string" || !name.trim() || name === "." || name === ".." ||
			/[\\/\x00-\x1f\x7f]/.test(name)) throw new Error("Invalid project folder name.");
		const folder = await vfs.addFolderTree(name, entries, { parent: resolve(parent) });
		return parent.replace(/\/?$/, "/") + vfs.baseName(folder) + "/";
	}
	const methods = {
		readApiKey: (_signal, host) => apiKey(host),
		writeApiKey: (_signal, host, value) => apiKey(host, value),
		get: (_signal, path) => vfs.getasync(resolve(path)),
		list: (_signal, path) => vfs.ls(resolve(path)),
		stat: (_signal, path) => vfs.fileSystem.stat(resolve(path)),
		readdir: (_signal, path) => vfs.fileSystem.readdir(resolve(path)),
		readFile: (_signal, path) => vfs.fileSystem.readFile(resolve(path)),
		checkRun: (signal, fence) => vfs.checkRun(writeOptions(fence, signal).guard),
		runPython: (signal, folder, script, fence) => runScript(susiPython, signal, folder, script, fence),
		runJavaScript: (signal, folder, script, fence) => runScript(susiJavaScript, signal, folder, script, fence),
		put: (signal, path, value, fence) => vfs.put(resolve(path), value, writeOptions(fence, signal)),
		edit: (signal, path, edits, fence) => vfs.editFile(resolve(path), edits, writeOptions(fence, signal)),
		remove: (signal, path, fence) => vfs.rm(resolve(path), writeOptions(fence, signal)),
		copy: (signal, from, to, fence) => vfs.cp(resolve(from), resolve(to), writeOptions(fence, signal)),
		move: (signal, from, to, fence) => vfs.mv(resolve(from), resolve(to), writeOptions(fence, signal)),
		mkdir: (_signal, path) => vfs.fileSystem.mkdir(resolve(path), { recursive: true }),
		create: (_signal, name, parent) => createFolder(name, parent, [{ path: "index.html", value: "" }]),
		createFolder: (_signal, name, parent) => createFolder(name, parent, []),
		replace: (signal, path, previous, value, fence) =>
			vfs.update(resolve(path), compareText(previous, value), writeOptions(fence, signal)),
		replacePair: (signal, path, previous, value, file, fence) =>
			vfs.fileSystem.updateWithFile(resolve(path), compareText(previous, value), {
				action: "update", path: resolve(file.path), update: compareText(file.previous, file.value)
			}, writeOptions(fence, signal))
	};
	return (name, args, signal) => {
		if (!Object.hasOwn(methods, name) || !Array.isArray(args) || args.length !== methods[name].length - 1) {
			throw new Error("Invalid workspace operation.");
		}
		signal?.throwIfAborted();
		return methods[name](signal, ...args);
	};
}

function createChatWorkspace(call) {
	const invoke = (name, args, { guard } = {}) => {
		const { signal, ...fence } = guard || {};
		return call(name, [...args, fence.path ? fence : null], signal);
	};
	const getasync = path => call("get", [path]);
	async function previousText(path) {
		try { return await getasync(path); }
		catch (error) { if (error !== "Key not found" && error?.code !== "ENOENT") throw error; }
	}
	async function retryConflicts(operation) {
		for (let attempt = 1; ; attempt++) {
			try { return await operation(); }
			catch (error) { if (error.code !== "EEXIST" || attempt === 8) throw error; }
		}
	}
	return {
		getasync,
		checkRun: guard => invoke("checkRun", [], { guard }),
		runPython: (folder, script, { guard, signal } = {}) =>
			invoke("runPython", [folder, script], { guard: { ...guard, signal } }),
		runJavaScript: (folder, script, { guard, signal } = {}) =>
			invoke("runJavaScript", [folder, script], { guard: { ...guard, signal } }),
		baseName: path => path.replace(/\/$/, "").split("/").at(-1),
		ls: path => call("list", [path]),
		async listProjectFolders(root) {
			const entries = await call("list", [root]);
			const folders = entries.filter(path => path.includes("/")).map(path => root + path.split("/")[0] + "/");
			return [root, ...new Set(folders)];
		},
		mkdir: path => call("mkdir", [path]),
		createFolder: (name, parent) => call("createFolder", [name, parent]),
		addFolderTree: (name, _entries, { parent } = {}) => call("create", [name, parent || "/"]),
		put: (path, value, options) => invoke("put", [path, value], options),
		editFile: (path, edits, options) => invoke("edit", [path, edits], options),
		rm: (path, options) => invoke("remove", [path], options),
		cp: (from, to, options) => invoke("copy", [from, to], options),
		mv: (from, to, options) => invoke("move", [from, to], options),
		update(path, updater, options) {
			return retryConflicts(async () => {
				const previous = await previousText(path);
				const value = updater(previous);
				if (value === previous && !options?.guard) return value;
				return invoke("replace", [path, previous, value], options);
			});
		},
		fileSystem: {
			async updateWithFile(path, updater, file, options) {
				if (file.action !== "update") throw new Error("Expected a paired update of Chat records.");
				return retryConflicts(async () => {
					const [previous, other] = await Promise.all([previousText(path), previousText(file.path)]);
					return invoke("replacePair", [path, previous, updater(previous),
						{ path: file.path, previous: other, value: file.update(other) }], options);
				});
			},
			resolvePath: (base, path) => {
				const parts = [];
				for (const part of (path.startsWith("/") ? path : base + "/" + path).split("/")) {
					if (part === "..") parts.pop();
					else if (part && part !== ".") parts.push(part);
				}
				return "/" + parts.join("/");
			},
			stat: path => call("stat", [path]),
			readdir: path => call("readdir", [path]),
			readFile: path => call("readFile", [path]),
			readBytes: async path => (await call("readFile", [path])).bytes
		}
	};
}
