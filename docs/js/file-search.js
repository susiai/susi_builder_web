"use strict";

const searchAgentFiles = (() => {
	const scripts = window.__susiPreview ? new URL("js/", document.baseURI) : new URL("./", document.currentScript.src);
	let dependencies;

	function loadScript(path) {
		return new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = new URL(path, scripts).href;
			script.onload = () => { script.remove(); resolve(); };
			script.onerror = () => { script.remove(); reject(new Error("The file search engine could not be loaded.")); };
			document.head.append(script);
		});
	}

	function loadSearchEngine() {
		dependencies ??= Promise.all([
			globalThis.JustBash?.Bash ? undefined : loadScript("vendor/just-bash-3.6.1.browser.js"),
			typeof createJustBashFileSystem === "function" ? undefined : loadScript("just-bash-vfs.js")
		]).catch(error => {
			dependencies = undefined;
			throw error;
		});
		return dependencies;
	}

	return async function searchAgentFiles(resolveVfs, options, signal) {
		const { pattern, path = ".", glob, fixed_strings: literal, ignore_case: ignoreCase,
			context_lines: contextLines, max_results: maxResults } = options;
		const start = path ?? ".";
		const context = contextLines ?? 0, limit = maxResults ?? 100;
		const validString = value => typeof value === "string" && !value.includes("\0");
		if (!validString(pattern) || !validString(start) || !start ||
			(glob != null && !validString(glob)) || (literal != null && typeof literal !== "boolean") ||
			(ignoreCase != null && typeof ignoreCase !== "boolean") ||
			!Number.isSafeInteger(context) || context < 0 || !Number.isSafeInteger(limit) || limit < 1) {
			return { exit_code: 2, output: "Rejected: invalid search arguments." };
		}
		if (start.startsWith("/") || start.split("/").includes("..")) {
			return { exit_code: 2, output: "Rejected: path must be relative and must not contain .. components." };
		}
		if (pattern.includes("\n")) return { exit_code: 2, output: "A search pattern cannot contain a line break." };

		try {
			signal?.throwIfAborted();
			const [vfs] = await Promise.all([resolveVfs(), loadSearchEngine()]);
			signal?.throwIfAborted();
			const adapter = createJustBashFileSystem(vfs);
			const readMethods = ["readFile", "readFileBuffer", "stat", "lstat", "realpath", "readdir", "resolvePath", "exists"];
			const fs = Object.fromEntries(readMethods.map(method => [method, (...args) => {
				signal?.throwIfAborted();
				return adapter[method](...args);
			}]));
			let request;
			const shell = new JustBash.Bash({ fs, cwd: "/", commands: ["rg"], customCommands: [{
				name: "search_project_files",
				// Pass arguments directly to rg, with no shell parsing of model-supplied values.
				execute: (_args, { exec, cwd, signal }) => exec("rg", { ...request, cwd, signal })
			}] });
			const rg = (args, stdin) => {
				request = { args, stdin, stdinKind: "text" };
				return shell.exec("search_project_files", { signal });
			};
			const match = [];
			if (literal) match.push("--fixed-strings");
			if (ignoreCase) match.push("--ignore-case");
			match.push("--regexp", pattern);
			// Check the expression even in an empty project, using one dummy stdin line.
			const validation = await rg(["--quiet", ...match], "\n");
			if (validation.exitCode > 1 || validation.stderr) {
				return { exit_code: Math.max(2, validation.exitCode), output: validation.stderr.trimEnd() };
			}

			const listing = ["--files", "--null", "--sort", "path"];
			if (glob) listing.push("--glob", glob);
			const searchPath = vfs.projectPath?.(start) ?? (start === "." ? "." : "./" + start);
			const files = await rg([...listing, "--", searchPath]);
			const output = [];
			let exitCode = files.exitCode > 1 ? files.exitCode : 0;
			if (files.stderr) {
				exitCode ||= 2;
				output.push(files.stderr.trimEnd());
			}
			let hits = 0;
			let truncated = false;
			for (const entry of files.stdout.split("\0").filter(Boolean)) {
				signal?.throwIfAborted();
				const file = entry.startsWith("./") ? entry : "./" + entry;
				// Search one file at a time for unambiguous line prefixes and bounded buffered output.
				// Once the limit is exceeded, continue quietly so filesystem errors are still reported.
				const count = Math.min(limit - hits + 1, Number.MAX_SAFE_INTEGER);
				const format = truncated ? ["--quiet"] : [
					"--no-filename", "--line-number", "-C", String(context), "--max-count", String(count)
				];
				const result = await rg([...format, ...match, "--", file]);
				signal?.throwIfAborted();
				if (result.exitCode > 1 || result.stderr) {
					exitCode = Math.max(exitCode, result.exitCode, 2);
					if (result.stderr) output.push(result.stderr.trimEnd());
				}
				for (const line of result.stdout.split("\n")) {
					const prefix = /^(\d+)([:-])/.exec(line);
					if (!prefix) continue;
					if (prefix[2] === ":") {
						if (hits === limit) {
							output.push(`[Truncated: more than ${limit} matching lines. Narrow the search or increase max_results.]`);
							truncated = true;
							break;
						}
						hits++;
					}
					output.push(`${file}:${prefix[1]}:${line.slice(prefix[0].length)}`);
				}
			}
			return { exit_code: exitCode, output: output.join("\n") || "No matches found." };
		} catch (error) {
			signal?.throwIfAborted();
			return { exit_code: 2, output: error?.message || String(error) };
		}
	};
})();
