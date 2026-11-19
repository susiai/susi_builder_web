"use strict";

const susiPython = (() => {
	const runtimeURL = "https://cdn.jsdelivr.net/pyodide/v314.0.8/full/";
	const commands = ["python", "python3", "python3.14"];
	const limits = { maxEntries: 10000, maxBytes: 64 * 1024 * 1024, maxOutput: 64 * 1024 };
	const decoder = new TextDecoder();

	// Serialized into a worker created in a frame with an opaque origin.
	function pythonWorker(runtimeURL, limits) {
		self.onmessage = async ({ data, ports: [port] }) => {
			self.onmessage = null;
			const reply = port.postMessage.bind(port);
			const { entries, cwd, command, args, stdin } = data;
			const root = "/workspace";
			function output() {
				const data = new Uint8Array(limits.maxOutput);
				let length = 0;
				let truncated = false;
				return {
					write(chunk) {
						const n = Math.min(chunk.length, data.length - length);
						data.set(chunk.subarray(0, n), length);
						length += n;
						truncated ||= n < chunk.length;
						return chunk.length;
					},
					result: () => data.slice(0, length),
					get truncated() { return truncated; }
				};
			}
			const stdout = output();
			const stderr = output();
			let offset = 0;
			try {
				const { loadPyodide } = await import(runtimeURL + "pyodide.mjs");
				const pyodide = await loadPyodide({ indexURL: runtimeURL });
				const { FS } = pyodide;
				pyodide.setStdout(stdout);
				pyodide.setStderr(stderr);
				pyodide.setStdin({ read(buffer) {
					const bytes = stdin.subarray(offset, offset + buffer.length);
					buffer.set(bytes);
					offset += bytes.length;
					return bytes.length;
				} });

				FS.mkdir(root);
				for (const entry of entries) {
					const path = root + "/" + entry.path.replace(/\/$/, "");
					if (entry.data === null) FS.mkdirTree(path);
					else {
						FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
						FS.writeFile(path, entry.data);
					}
				}
				// Preserve directory times after populating children.
				for (const entry of entries) {
					const path = root + "/" + entry.path.replace(/\/$/, "");
					FS.chmod(path, entry.mode);
					FS.utime(path, entry.mtime, entry.mtime);
				}

				const globals = pyodide.globals.get("dict")();
				let exitCode;
				try {
					globals.set("invocation", JSON.stringify({ cwd: root + cwd, command, args }));
					// Dependency loading must preserve the script's stdout for pipelines and redirects.
					globals.set("load_dependencies", source => pyodide.loadPackagesFromImports(source, { messageCallback() {} }));
					exitCode = await pyodide.runPythonAsync(String.raw`
import importlib.machinery
import io
import json
import os
import sys
import tokenize
import traceback
import types

async def run_script():
    invocation_options = json.loads(invocation)
    command = invocation_options["command"]
    args = invocation_options["args"]
    os.chdir(invocation_options["cwd"])
    sys.argv = args
    main = types.ModuleType("__main__")
    sys.modules["__main__"] = main
    try:
        if command == "version":
            print("Python " + sys.version.split()[0])
            return 0
        if command == "file":
            filename = os.path.abspath(args[0])
            sys.path.insert(0, os.path.dirname(filename))
            main.__file__ = filename
            main.__loader__ = importlib.machinery.SourceFileLoader("__main__", filename)
            with open(filename, "rb") as script:
                source = script.read()
        else:
            sys.path.insert(0, "")
            filename = "<stdin>" if command == "stdin" else "<string>"
            source = sys.stdin.buffer.read() if command == "stdin" else args.pop(1)
            if command == "stdin":
                main.__file__ = filename
        program = compile(source, filename, "exec")
        if isinstance(source, bytes):
            encoding, _ = tokenize.detect_encoding(io.BytesIO(source).readline)
            source = source.decode(encoding)
        await load_dependencies(source)
        exec(program, vars(main))
        return 0
    except SystemExit as exc:
        if exc.code is None:
            return 0
        if isinstance(exc.code, int):
            return exc.code & 255
        print(exc.code, file=sys.stderr)
        return 1
    except BaseException as exc:
        traceback.print_exception(type(exc), exc, exc.__traceback__.tb_next)
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()

await run_script()
`, { globals });
				} finally { globals.destroy(); }

				const files = [];
				let total = 0;
				function collect(directory, relative = "") {
					for (const name of FS.readdir(directory)) {
						if (name === "." || name === "..") continue;
						if (files.length >= limits.maxEntries) throw new Error("Python created too many files.");
						const target = directory + "/" + name;
						const stat = FS.lstat(target);
						const path = relative + name;
						const entry = { path, mtime: stat.mtime.getTime(), mode: stat.mode & 0o777, data: null };
						if (FS.isDir(stat.mode)) {
							entry.path += "/";
							files.push(entry);
							collect(target, entry.path);
						} else {
							if (!FS.isFile(stat.mode)) throw new Error("The workspace cannot save special files: " + path);
							total += stat.size;
							if (total > limits.maxBytes) throw new Error("Python output files exceed 64 MiB.");
							entry.data = FS.readFile(target);
							files.push(entry);
						}
					}
				}
				collect(root);
				const output = stdout.result();
				const errors = stderr.result();
				reply({ files, exitCode, stdout: output, stderr: errors, truncated: stdout.truncated || stderr.truncated },
					[output.buffer, errors.buffer, ...files.flatMap(entry => entry.data ? [entry.data.buffer] : [])]);
			} catch (error) {
				reply({ error: error?.message || String(error) });
			}
		};
	}

	function startFrame(workerSource) {
		window.addEventListener("message", function run({ source, data, ports: [port] }) {
			if (source !== parent || !port) return;
			window.removeEventListener("message", run);
			const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
			try {
				// Chromium rejects module workers from opaque blob URLs. Dynamic import still loads the Pyodide modules.
				const worker = new Worker(url);
				const { port1, port2 } = new MessageChannel();
				worker.onerror = event => port.postMessage({ error: event.message || "The Python worker did not start." });
				port1.onmessage = ({ data }) => {
					const transfer = !data.error ? [data.stdout.buffer, data.stderr.buffer,
						...data.files.flatMap(entry => entry.data ? [entry.data.buffer] : [])] : [];
					port.postMessage(data, transfer);
				};
				// Keep the worker's reply port out of the Python-visible global scope.
				worker.postMessage(data, [port2, data.stdin.buffer,
					...data.entries.flatMap(entry => entry.data ? [entry.data.buffer] : [])]);
			} catch (error) {
				port.postMessage({ error: error.message });
			}
		});
	}

	async function execute(data, signal) {
		const frame = document.createElement("iframe");
		frame.hidden = true;
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("title", "Python interpreter");
		const { port1, port2 } = new MessageChannel();
		const workerSource = "(" + pythonWorker.toString() + ")(" + JSON.stringify(runtimeURL) + "," + JSON.stringify(limits) + ");";
		const bootstrap = "(" + startFrame.toString() + ")(" + JSON.stringify(workerSource) + ");";
		const policy = "default-src 'none'; script-src blob: 'unsafe-inline' 'wasm-unsafe-eval' " + runtimeURL +
			"; connect-src " + runtimeURL + "; worker-src blob:; base-uri 'none'; form-action 'none'";
		frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + policy + '"><script>' +
			bootstrap.replace(/<\/script/gi, "<\\/script") + "</script>";
		let timer, abort;
		try {
			return await new Promise((resolve, reject) => {
				abort = () => reject(signal.reason || new DOMException("Python was interrupted.", "AbortError"));
				signal?.throwIfAborted();
				signal?.addEventListener("abort", abort, { once: true });
				timer = setTimeout(() => reject(new Error("Python timed out while loading or running the script.")), 60000);
				port1.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
				frame.onload = () => frame.contentWindow.postMessage(data, "*", [port2]);
				document.body.append(frame);
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			port1.close();
			frame.remove();
		}
	}

	function validPath(path) {
		return typeof path === "string" && path.length > 0 && !/[\\\x00-\x1f\x7f]/.test(path) &&
			path.replace(/\/$/, "").split("/").every(part => part && part !== "." && part !== "..");
	}

	function changesFrom(before, files, exclude) {
		const original = new Map(before.map(entry => [entry.path, entry]));
		const updates = [];
		for (const entry of files) {
			const { path, data, mode, mtime } = entry;
			if (!validPath(path) || exclude.includes(path.split("/")[0])) {
				throw new Error("Python cannot save this workspace path: " + path);
			}
			const previous = original.get(path);
			original.delete(path);
			const old = previous?.data;
			if (previous?.mode === mode && (data === null ? old === null :
				previous.mtime === mtime && old?.length === data.length && data.every((byte, index) => byte === old[index]))) continue;
			updates.push({ path, before: previous, after: entry });
		}
		// A type change uses one removal and one addition, with children ordered around their parent.
		const removals = [...original.values()].reverse().map(entry => ({ path: entry.path, before: entry }));
		return removals.concat(updates);
	}

	async function run(fs, { root = "/", cwd = "", command = "file", args, stdin = new Uint8Array(),
		exclude = [], signal, guard } = {}) {
		signal?.throwIfAborted();
		const entries = command === "version" ? [] : await fs.snapshotTree(root, { ...limits, exclude, signal });
		const result = await execute({ entries, cwd, command, args, stdin }, signal);
		signal?.throwIfAborted();
		const changes = changesFrom(entries, result.files, exclude);
		if (changes.length) await fs.applyTreeChanges(root, changes, { guard, signal });
		return result;
	}

	function shellCommands(fs) {
		const byteString = bytes => {
			let text = "";
			for (let offset = 0; offset < bytes.length; offset += 8192) {
				text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
			}
			return text;
		};
		const execute = async (args, context) => {
			const stdin = Uint8Array.from(context.stdin, char => char.charCodeAt(0));
			const [first, source] = args;
			const exclude = [".webstation", "Models"];
			const cwd = context.cwd === "/" ? "" : context.cwd;
			const fail = message => ({ stdout: "", stderr: message + "\n", exitCode: 2 });
			let command = "file";
			if (first === "--version" || first === "-V") command = "version";
			else if (first === "-c" && source !== undefined) command = "code";
			else if (first === "-" || (!first && context.stdinProvided)) command = "stdin";
			else if (!first || first.startsWith("-")) return fail("Usage: python3 FILE [ARGS] | -c CODE | - | --version");
			if (command !== "version" && exclude.includes(cwd.split("/")[1])) {
				return fail("Python cannot open this workspace directory.");
			}
			const invocationArgs = command === "version" ? [] : first ? [...args] : ["-"];
			if (command === "file") {
				const script = fs.resolvePath(context.cwd, first);
				if (exclude.includes(script.split("/")[1])) return fail("Python cannot open this workspace file.");
				invocationArgs[0] = "/workspace" + script;
			}
			try {
				const { stdout, stderr, exitCode, truncated } = await run(fs, {
					cwd: command === "version" ? "" : cwd, command, args: invocationArgs, stdin, exclude, signal: context.signal
				});
				return { stdout: byteString(stdout), stdoutKind: "bytes", stderr: decoder.decode(stderr) +
					(truncated ? "\n[Python output truncated.]\n" : ""), exitCode };
			} catch (error) {
				context.signal?.throwIfAborted();
				return fail(`python: ${error.message || error}`);
			}
		};
		return commands.map(name => ({ name, execute }));
	}

	return {
		shellCommands,
		async runFile(fs, root, path, { guard, signal } = {}) {
			if (!validPath(path) || path.endsWith("/")) throw new Error("Provide the path to a Python file in the project.");
			const result = await run(fs, { root, args: [path], guard, signal });
			return { exit_code: result.exitCode, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr),
				...(result.truncated ? { truncated: true } : {}) };
		}
	};
})();
