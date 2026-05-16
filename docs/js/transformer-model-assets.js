"use strict";

const transformerModelAssets = (() => {
	const runtimeVersion = "1.31.0-dev.20260914-8d85527a0";
	const wasmName = "ort-wasm-simd-threaded.asyncify.wasm";
	const runtime = {
		// Whisper installed this shared runtime first. Keep its path so existing downloads are still usable.
		path: `/Models/Whisper/runtime/${runtimeVersion}/${wasmName}`,
		url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${runtimeVersion}/dist/${wasmName}`,
		size: 26861777,
		digest: "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082"
	};
	const cpuRuntime = [
		["ort-wasm-simd-threaded.wasm", 14264838, "06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3"],
		["ort-wasm-simd-threaded.mjs", 24381, "c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f"]
	].map(([name, size, digest]) => ({ name, size, digest, path: `/Models/Chat/runtime/${runtimeVersion}/${name}`,
		url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${runtimeVersion}/dist/${name}` }));
	const base = window.__susiPreview ? new URL("js/", document.baseURI) : document.currentScript.src;
	const bundle = new URL("vendor/transformers-4.3.2.browser.js?v=8fb21031", base);
	let moduleRequest;

	async function stored(vfs, { path, size }) {
		try {
			const value = await vfs.getasync(path);
			if ((value instanceof Blob && value.size === size) ||
				(value instanceof Uint8Array && value.byteLength === size)) return value;
		} catch (error) { if (error !== "Key not found") throw error; }
	}

	async function read(vfs, files) {
		const values = await Promise.all(files.map(asset => stored(vfs, asset)));
		return values.map(value => value instanceof Uint8Array ? new Blob([value]) : value);
	}

	async function missing(vfs, files) {
		const values = await Promise.all(files.map(asset => stored(vfs, asset)));
		return files.filter((_, index) => !values[index]);
	}

	async function download(vfs, assets, report, signal) {
		const files = await missing(vfs, assets);
		const total = files.reduce((size, asset) => size + asset.size, 0);
		let completed = 0;
		let storeBytes = false;
		for (const asset of files) {
			signal.throwIfAborted();
			const name = asset.name ?? "ONNX Runtime";
			report(name, completed, total);
			const response = await fetch(asset.url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
			if (!response.ok || !response.body) throw new Error(`Download failed for ${name} (HTTP ${response.status}).`);
			let size = 0;
			const body = response.body.pipeThrough(new TransformStream({
				transform(chunk, controller) {
					size += chunk.byteLength;
					if (size > asset.size) throw new Error(`Unexpected download size for ${name}.`);
					controller.enqueue(chunk);
					report(name, completed + size, total);
				}
			}));
			const type = asset.name?.endsWith(".json") ? "application/json" : "application/octet-stream";
			const file = await new Response(body, { headers: { "Content-Type": type } }).blob();
			signal.throwIfAborted();
			if (size !== asset.size) throw new Error(`Incomplete download for ${name}.`);
			if (asset.digest) {
				const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
				const digest = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
				if (digest !== asset.digest) throw new Error(`Integrity check failed for ${name}.`);
			}
			signal.throwIfAborted();
			await vfs.fileSystem.mkdir(asset.path.slice(0, asset.path.lastIndexOf("/")), { recursive: true });
			signal.throwIfAborted();
			if (!storeBytes) {
				try { await vfs.put(asset.path, file); }
				catch (error) {
					// Some WebKit contexts cannot persist Blob data in IndexedDB.
					if (error?.name !== "UnknownError") throw error;
					storeBytes = true;
				}
			}
			if (storeBytes) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				signal.throwIfAborted();
				await vfs.put(asset.path, bytes);
			}
			completed += size;
		}
	}

	function loadModules() {
		moduleRequest ??= new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = bundle.href;
			script.onload = () => {
				script.remove();
				if (globalThis.susiTransformersModules) resolve(globalThis.susiTransformersModules);
				else reject(new Error("Transformers.js did not initialize."));
			};
			script.onerror = () => {
				script.remove();
				reject(new Error("Could not load Transformers.js."));
			};
			document.head.append(script);
		}).catch(error => { moduleRequest = undefined; throw error; });
		return moduleRequest;
	}

	return { runtime, cpuRuntime, read, missing, download, loadModules };
})();
