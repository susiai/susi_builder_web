"use strict";

const susiJavaScript = (() => {
	const scriptURL = document.currentScript.src;
	const decoder = new TextDecoder();
	const label = "JavaScript";
	let runtimeSource;

	// The worker is outside the application's origin. Only the explicit bindings below enter the QuickJS context.
	function javascriptWorker(initialize, limits) {
		self.onmessage = async ({ data: { entries, script }, ports: [port] }) => {
			self.onmessage = null;
			const reply = port.postMessage.bind(port);
			const workspace = "/workspace";
			const files = new Map(entries.map(entry => [entry.path, entry]));
			let size = entries.reduce((sum, entry) => sum + (entry.data?.length ?? 0), 0);
			const encoder = new TextEncoder();
			const decoder = new TextDecoder();
			const stdout = new Uint8Array(limits.maxOutput);
			const stderr = new Uint8Array(limits.maxOutput);
			let outLength = 0;
			let errLength = 0;
			let truncated = false;

			function print(buffer, offset, text) {
				const line = text + "\n";
				const { read, written } = encoder.encodeInto(line, buffer.subarray(offset));
				truncated ||= read < line.length;
				return offset + written;
			}

			function normalize(path, cwd = "") {
				if (!path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid workspace path.");
				if (path.startsWith("/")) {
					if (path !== workspace && !path.startsWith(workspace + "/")) {
						throw new Error("Path is outside /workspace: " + path);
					}
					cwd = "";
					path = path.slice(workspace.length);
				}
				const parts = cwd ? cwd.split("/") : [];
				for (const part of path.split("/")) {
					if (part === "..") {
						if (!parts.length) throw new Error("Path leaves /workspace.");
						parts.pop();
					} else if (part && part !== ".") parts.push(part);
				}
				return parts.join("/");
			}

			const parent = path => path.slice(0, Math.max(0, path.lastIndexOf("/")));
			function isDirectory(path) {
				const prefix = path + "/";
				if (!path || files.has(prefix)) return true;
				// Older workspace folders can be implicit in their descendants' paths.
				for (const key of files.keys()) if (key.startsWith(prefix)) return true;
				return false;
			}

			function readFile(path) {
				const file = files.get(path);
				if (!file) throw new Error((isDirectory(path) ? "EISDIR: " : "ENOENT: ") + path);
				return file.data;
			}

			function writeFile(path, data) {
				if (isDirectory(path)) throw new Error("EISDIR: " + path);
				if (!isDirectory(parent(path))) throw new Error("Parent directory does not exist: " + path);
				const previous = files.get(path);
				const total = size - (previous?.data.length ?? 0) + data.length;
				if (total > limits.maxBytes) throw new Error("Workspace files exceed 64 MiB.");
				if (!previous && files.size >= limits.maxEntries) throw new Error("Workspace has too many files.");
				files.set(path, { path, data, mode: previous?.mode ?? 0o644,
					mtime: Math.max(Date.now(), (previous?.mtime ?? 0) + 1) });
				size = total;
			}

			function mkdir(path, recursive) {
				if (files.has(path)) throw new Error("ENOTDIR: " + path);
				if (isDirectory(path)) {
					if (recursive) return;
					throw new Error("EEXIST: " + path);
				}
				const directory = parent(path);
				if (!isDirectory(directory)) {
					if (!recursive) throw new Error("Parent directory does not exist: " + path);
					mkdir(directory, true);
				}
				if (files.size >= limits.maxEntries) throw new Error("Workspace has too many files.");
				const key = path + "/";
				files.set(key, { path: key, data: null, mode: 0o755, mtime: Date.now() });
			}

			function readdir(path) {
				if (!isDirectory(path)) throw new Error((files.has(path) ? "ENOTDIR: " : "ENOENT: ") + path);
				const prefix = path ? path + "/" : "";
				return [...new Set([...files.keys()].filter(key => key !== prefix && key.startsWith(prefix))
					.map(key => key.slice(prefix.length).split("/")[0]))].sort();
			}

			function evaluate(engine) {
				const runtime = engine.newRuntime();
				try {
					const deadline = performance.now() + 10000;
					runtime.setMemoryLimit(limits.maxBytes);
					runtime.setMaxStackSize(1024 * 1024);
					runtime.setInterruptHandler(() => performance.now() >= deadline);
					const vm = runtime.newContext();
					try {
						const string = handle => {
							if (!handle || vm.typeof(handle) !== "string") throw new TypeError("Expected a string.");
							return vm.getString(handle);
						};
						const functions = {
							log(stream, message) {
								const text = string(message);
								if (string(stream) === "error") errLength = print(stderr, errLength, text);
								else outLength = print(stdout, outLength, text);
							},
							read(path, encoding) {
								const data = readFile(normalize(string(path)));
								return string(encoding) ? vm.newString(decoder.decode(data)) : vm.newArrayBuffer(data.slice().buffer);
							},
							write(path, value) {
								const key = normalize(string(path));
								const data = vm.typeof(value) === "string" ? encoder.encode(string(value)) :
									vm.getArrayBuffer(value).consume(buffer => buffer.value.slice());
								writeFile(key, data);
							},
							mkdir(path, recursive) { mkdir(normalize(string(path)), vm.getNumber(recursive) === 1); },
							readdir(path) { return vm.newString(JSON.stringify(readdir(normalize(string(path))))); },
							unlink(path) {
								const key = normalize(string(path));
								size -= readFile(key).length;
								files.delete(key);
							}
						};
						vm.newObject().consume(bindings => {
							for (const [name, implementation] of Object.entries(functions)) {
								vm.newFunction(name, implementation).consume(fn => vm.setProp(bindings, name, fn));
							}
							vm.setProp(vm.global, "__susiHost", bindings);
						});
						vm.unwrapResult(vm.evalCode(String.raw`
(() => {
	const host = globalThis.__susiHost;
	delete globalThis.__susiHost;
	const { parse, stringify } = JSON;
	const { isView } = ArrayBuffer;
	const ArrayBufferType = ArrayBuffer;
	const ByteArray = Uint8Array;
	function encoding(options) {
		const value = typeof options === "string" ? options : options?.encoding;
		if (value == null) return "";
		if (value === "utf8" || value === "utf-8") return value;
		throw new TypeError("The workspace supports UTF-8 text and binary files.");
	}
	const fs = Object.freeze({
		async readFile(path, options) {
			const codec = encoding(options);
			const data = host.read(path, codec);
			return codec ? data : new ByteArray(data);
		},
		async writeFile(path, data, options) {
			encoding(options);
			if (options?.flag && options.flag !== "w") throw new TypeError("The workspace supports the w flag.");
			if (typeof data === "string") return host.write(path, data);
			if (isView(data)) data = new ByteArray(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
			if (!(data instanceof ArrayBufferType)) throw new TypeError("Expected text or binary bytes.");
			return host.write(path, data);
		},
		async mkdir(path, options) { return host.mkdir(path, options?.recursive === true ? 1 : 0); },
		async readdir(path) { return parse(host.readdir(path)); },
		async unlink(path) { return host.unlink(path); }
	});
	Object.defineProperty(globalThis, "__susiFs", { value: fs });
	const show = value => {
		if (value === null || typeof value !== "object") return String(value);
		try { return stringify(value) ?? String(value); } catch { return String(value); }
	};
	const log = stream => (...values) => host.log(stream, values.map(show).join(" "));
	globalThis.console = { log: log("out"), info: log("out"), warn: log("error"), error: log("error") };
})();
`)).dispose();
						const fsModule = "const fs = globalThis.__susiFs; export default fs; " +
							"export const { readFile, writeFile, mkdir, readdir, unlink } = fs;";
						runtime.setModuleLoader(name => {
							if (name === "node:fs/promises") return fsModule;
							if (!name.startsWith(workspace + "/")) throw new Error("Unsupported module: " + name);
							return decoder.decode(readFile(normalize(name)));
						}, (base, name) => {
							if (name.startsWith("./") || name.startsWith("../") || name.startsWith(workspace + "/")) {
								return workspace + "/" + normalize(name, parent(normalize(base)));
							}
							return name;
						});
						const entry = workspace + "/" + script;
						const handle = vm.unwrapResult(vm.evalCode(decoder.decode(readFile(script)), entry, { type: "module" }));
						try {
							while (runtime.hasPendingJob()) {
								if (performance.now() >= deadline) throw new Error("JavaScript exceeded its execution deadline.");
								vm.unwrapResult(runtime.executePendingJobs(32));
							}
							const state = vm.getPromiseState(handle);
							if (state.type === "pending") throw new Error("The script is waiting for a promise that cannot settle.");
							if (!state.notAPromise) vm.unwrapResult(state).dispose();
						} finally { handle.dispose(); }
						if (performance.now() >= deadline) throw new Error("JavaScript exceeded its execution deadline.");
					} finally { vm.dispose(); }
				} finally { runtime.dispose(); }
			}

			let exitCode = 0;
			try { evaluate(await initialize()); }
			catch (error) {
				exitCode = 1;
				errLength = print(stderr, errLength, error?.stack || error?.message || String(error));
			}
			// Failed scripts leave their staged changes behind in the worker.
			const saved = exitCode === 0 ? [...files.values()].sort((a, b) => a.path < b.path ? -1 : 1) : undefined;
			reply({ files: saved, exitCode, stdout: stdout.subarray(0, outLength), stderr: stderr.subarray(0, errLength), truncated },
				[stdout.buffer, stderr.buffer, ...(saved ?? []).flatMap(entry => entry.data ? [entry.data.buffer] : [])]);
		};
	}

	function workerSource() {
		const runtimeURL = new URL("vendor/quickjs-0.32.0.browser.js", scriptURL);
		runtimeSource ??= readInstalledResource(runtimeURL).then(factory => Function.prototype.toString.call(factory))
			.catch(error => { runtimeSource = undefined; throw error; });
		return runtimeSource.then(source => "(" + javascriptWorker.toString() + ")((" + source + ")," +
			JSON.stringify(susiWorkspaceRunner.limits) + ");");
	}

	return {
		async runFile(fs, root, script, { guard, signal } = {}) {
			if (!susiWorkspaceRunner.validPath(script) || script.endsWith("/")) {
				throw new Error("Provide the path to a JavaScript file in the project.");
			}
			const result = await susiWorkspaceRunner.run(fs, {
				root, label, signal, guard, workerSource, invocation: { script }, timeoutMs: 15000
			});
			return { exit_code: result.exitCode, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr),
				...(result.truncated ? { truncated: true } : {}) };
		}
	};
})();
