"use strict";

const susiWorkspaceRunner = (() => {
	const limits = { maxEntries: 10000, maxBytes: 64 * 1024 * 1024, maxOutput: 64 * 1024 };

	function startFrame(workerSource) {
		window.addEventListener("message", function run({ source, data, ports: [port] }) {
			if (source !== parent || !port) return;
			window.removeEventListener("message", run);
			const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
			try {
				// Chromium rejects module workers from opaque blob URLs. Use a classic worker with dynamic imports where needed.
				const worker = new Worker(url);
				const { port1, port2 } = new MessageChannel();
				worker.onerror = event => port.postMessage({ error: event.message || "The script worker did not start." });
				port1.onmessage = ({ data }) => {
					const transfer = !data.error ? [data.stdout.buffer, data.stderr.buffer,
						...(data.files ?? []).flatMap(entry => entry.data ? [entry.data.buffer] : [])] : [];
					port.postMessage(data, transfer);
				};
			// Only the worker code receives the reply port.
				worker.postMessage(data, [port2, ...(data.stdin ? [data.stdin.buffer] : []),
					...data.entries.flatMap(entry => entry.data ? [entry.data.buffer] : [])]);
			} catch (error) {
				port.postMessage({ error: error.message });
			}
		});
	}

	async function execute(data, { workerSource, label, networkSource, timeoutMs, signal }) {
		const frame = document.createElement("iframe");
		frame.hidden = true;
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("title", label + " interpreter");
		const { port1, port2 } = new MessageChannel();
		const bootstrap = "(" + startFrame.toString() + ")(" + JSON.stringify(workerSource) + ");";
		const scriptSource = networkSource ? " " + networkSource : "";
		const policy = "default-src 'none'; script-src blob: 'unsafe-inline' 'wasm-unsafe-eval'" + scriptSource +
			"; connect-src " + (networkSource || "'none'") + "; worker-src blob:; base-uri 'none'; form-action 'none'";
		frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + policy + '"><script>' +
			bootstrap.replace(/<\/script/gi, "<\\/script") + "</script>";
		let timer, abort;
		try {
			return await new Promise((resolve, reject) => {
				abort = () => reject(signal.reason || new DOMException(label + " was interrupted.", "AbortError"));
				signal?.throwIfAborted();
				signal?.addEventListener("abort", abort, { once: true });
				timer = setTimeout(() => reject(new Error(label + " timed out while loading or running the script.")), timeoutMs);
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

	function changesFrom(before, files, exclude, label) {
		const original = new Map(before.map(entry => [entry.path, entry]));
		const updates = [];
		for (const entry of files) {
			const { path, data, mode, mtime } = entry;
			if (!validPath(path) || exclude.includes(path.split("/")[0])) {
				throw new Error(label + " cannot save this workspace path: " + path);
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

	async function run(fs, { root = "/", invocation, workerSource, label, networkSource, timeoutMs = 60000,
		skipSnapshot = false, exclude = [], signal, guard }) {
		signal?.throwIfAborted();
		const entries = skipSnapshot ? [] : await fs.snapshotTree(root, { ...limits, exclude, signal, label });
		const source = await workerSource();
		const result = await execute({ ...invocation, entries }, { workerSource: source, label, networkSource, timeoutMs, signal });
		signal?.throwIfAborted();
		if (result.files) {
			const changes = changesFrom(entries, result.files, exclude, label);
			if (changes.length) await fs.applyTreeChanges(root, changes, { guard, signal, label });
		}
		return result;
	}

	return { run, validPath, limits };
})();
