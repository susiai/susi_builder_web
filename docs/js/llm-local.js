"use strict";

globalThis.llmLocal = (() => {
	const root = "/Models/Chat/";
	const contextLimit = 8192;
	const defaultConfig = {
		chatProvider: "browser", chatLocalPrimary: "lfm3-1.7b-webgpu", chatLocalFallback: "lfm2.5-350m-wasm", thinking: false
	};
	const metadata = [
		["generation_config.json", 219, "9e9e031ae8bca36eefcdcdd0b35d83c61baa01e31d68d5f5a961c9ca1a4b95bf"],
		["tokenizer.json", 9117040, "e7a95fce95bf5b0946d0ddb3f9d7caa030b7e850bbe92b0edb26bcf563e9f3d5"],
		["chat_template.jinja", 4116, "87a2728cb8dc9fe424d624542f6060ec05a1d285ebbec578bb078900e33396b5"]
	];
	const qwenSmallOriginal = {
		repo: "onnx-community/Qwen3-0.6B-ONNX", revision: "79346d370dfae34801d26993fda9ae2372900fd0"
	};
	const qwenSmallMetadata = [
		["config.json", 912, "8a04114ba59cc42b47d804d35d1d5c61d746ae4634f41f796768c6e302d39b9e"],
		["tokenizer_config.json", 10369, "7c5194eecfd95a4dcbd6b4b502af785d2541fd65a388d1cae7ad43693c67b802"],
		...metadata
	];
	const lfm350 = {
		modelId: "lfm2.5-350m", label: "LFM2.5 350M", toolFormat: "lfm2",
		repo: "onnx-community/LFM2.5-350M-ONNX", revision: "7dd4999565b0342c381ba90a3d8fc467d6df19c4"
	};
	const lfm350Metadata = [
		["config.json", 1443, "544d8d604bacf4cb89383c49c9a54621afa26a6741f3f55fd8b840ca1d640419"],
		["generation_config.json", 136, "94bfac0e1c207691baf4e172389a8efb114f8b60eb3a5c07a2f418aefa8f8bb6"],
		["tokenizer.json", 3297793, "29d43b4be8e8a896fefd7cd836ca6d6b4eedd249f823866ce0453b368e646f49"],
		["tokenizer_config.json", 3825, "e70cd070c2696bf1b0f1ad303c34502753670cca6f844637821cb1c37e6bea8d"],
		["chat_template.jinja", 2553, "013eed60546434b6967e3483153d8c5c37abcb1d667f8b1f914683f2a9411531"]
	];
	const models = [
		{
			...qwenSmallOriginal,
			id: "qwen3-0.6b-webgpu", modelId: "qwen3-0.6b", label: "Qwen3 0.6B",
			device: "webgpu", dtype: "q4f16", shaderF16: true,
			files: [
				...qwenSmallMetadata,
				["onnx/model_q4f16.onnx", 569789750, "9e33a5911974174761d0dfdcc0bec975d9c45af0eae5e9eb647b8ba9442a8f91"]
			]
		},
		{
			id: "qwen3-1.7b-webgpu", modelId: "qwen3-1.7b", label: "Qwen3 1.7B",
			device: "webgpu", dtype: "q4f16", shaderF16: true,
			repo: "sunxanadu/Qwen3-1.7B-ONNX-web", revision: "faf6f7aafaf8b0e80954ae165d83059cf865854e",
			files: [
				["config.json", 892, "02db82ca7ad8c14257371f41ce4e92f8c8709448afa20b1d74d6f506430ef0d5"],
				["tokenizer_config.json", 9705, "b0a8115cf05a7002cbe2575058c0139c1dee3f06f221c05717c3444947d78b9f"],
				...metadata,
				["onnx/model_q4f16.onnx", 329917, "5699d47a0a75502c628f9bfa624d61e1fa046b06f46544a8a1405c5d24fbcd1f"],
				["onnx/model_q4f16.onnx_data", 1138917376, "b1b2617c6929842acfa83f71632ac573ac13a0898132a0c57d310b60a2cbde8a"]
			]
		},
		{
			...lfm350, id: "lfm2.5-350m-webgpu", device: "webgpu", dtype: "q4f16", shaderF16: true,
			files: [
				...lfm350Metadata,
				["onnx/model_q4f16.onnx", 182827, "3012c28a119828561c90196331435d91c43c1a6ab4898ac79715585fff1dff85"],
				["onnx/model_q4f16.onnx_data", 254965760, "9256ecd417b801b441d926ebe5ead4ebf50ac1a5a0f8f7914cf60d9d6452ef69"]
			]
		},
		{
			id: "lfm2.5-1.2b-instruct-webgpu", modelId: "lfm2.5-1.2b-instruct", label: "LFM2.5 1.2B Instruct",
			device: "webgpu", dtype: "q4f16", shaderF16: true, toolFormat: "lfm2",
			repo: "LiquidAI/LFM2.5-1.2B-Instruct-ONNX", revision: "10f72e70abf67ac0fd7ebf15bc5854726891d864",
			files: [
				["config.json", 1599, "dd5d4c6e32a992ad7ddac5c07f5e4711e42c69125f2b94287af7a8ec19963be5"],
				["generation_config.json", 131, "25f750b7e6a790f86ed01cd6f128f905152cb60bbfe2e6618ceca833b452cf80"],
				["tokenizer.json", 3297799, "0a1f2cb9fc2769030ca1f4207e81c1af493319373d41b8d3cf5be53860c13760"],
				["tokenizer_config.json", 2391, "0f11f4ffa5750369414bb24e41f26e2bbf23f1d01def533cad5f584e59ae3bef"],
				["chat_template.jinja", 1783, "f05bf4b967dc993bdc7a2fe6e43759ee218eb0eb340d68b063e1c4f8ad148176"],
				["onnx/model_q4f16.onnx", 182795, "a9986ad188200507342ac32f727aa4691edb5428b0aa8c4a9fbdf0c85a6fe667"],
				["onnx/model_q4f16.onnx_data", 760279040, "46cfacc12941150620a3f644a5269e9baebd75d681cfa09cadeef71b8ed64ac2"]
			]
		},
		{
			id: "qwen3.5-2b-webgpu", modelId: "qwen3.5-2b", label: "Qwen3.5 2B",
			device: "webgpu", dtype: "q4f16", shaderF16: true, toolFormat: "xml",
			repo: "onnx-community/Qwen3.5-2B-ONNX-OPT", revision: "ed446636739bf426e73c5a00714fd8e010d36c21",
			// AutoModelForCausalLM opens only the text sessions of this multimodal export.
			files: [
				["config.json", 2993, "b028de63b0ed8b37107acaaf1475d40d6d4feb5721153674e7d1d0bdbfd0f258"],
				["generation_config.json", 248, "dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48"],
				["tokenizer.json", 19226111, "89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b"],
				["tokenizer_config.json", 10069, "5dcac2c1306b11d1e18ec4c024a174bded2ca3178ce87b0aa590711696407f3d"],
				["chat_template.jinja", 7755, "273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80"],
				["onnx/embed_tokens_q4f16.onnx", 1064, "802a072ff21f540eda7f343aa71dbb0354c8859caaf34f09b3bf8117725d7de8"],
				["onnx/embed_tokens_q4f16.onnx_data", 294010880, "650aa8eb39b7404ca2c908d78243c82b6fd88321feeb8fca175745806c6b3a81"],
				["onnx/decoder_model_merged_q4f16.onnx", 707377, "c567d4d34dc97185e85bb40c9c30d6f73133858b1f8a32b90166b7fea4b653bf"],
				["onnx/decoder_model_merged_q4f16.onnx_data", 1088892928,
					"06dd7841f90e5c4ecc029193a29478750ae9dcbfeaf8cfb223cf8b69cc5666d6"]
			]
		},
		{
			id: "lfm3-1.7b-webgpu", modelId: "lfm3-1.7b", label: "LFM3 1.7B",
			device: "webgpu", dtype: "q4f16", shaderF16: true, toolFormat: "xml", prefillChunkSize: 256,
			repo: "onnx-community/LFM3-1.7B-ONNX", revision: "ab9fec4c681a25bec3b48b0b97a62fc2660a2985",
			files: [
				["config.json", 1549, "beb7c0a3e61147e15b50151728b8dc15b994c46a3cd524264b98b1485b1acf9c"],
				["generation_config.json", 241, "422ed8749f8849f763ffe836a709a2c58e1adcf3d32dfa4da48b3959e87ecce9"],
				["tokenizer.json", 17908635, "7e226e34bface23ccf6e495d157bf77186c1c30a7659880e1a8994db528c3701"],
				["tokenizer_config.json", 14262, "4e1748d03b2162c6cf5d53b13cd0cf01aae0c98d47a8b99bfb737d7fdc3d1d05"],
				["chat_template.jinja", 12129, "f45005c50cd2a97329722bf3a2dee9f16c04cdf825a589b280fb7e99e6827818"],
				["onnx/model_q4f16.onnx", 296714, "ef4f1e8b5e1af2e1a64230c71a344954fa047db7f3d718437908030817a0ee73"],
				["onnx/model_q4f16.onnx_data", 1087789056, "7a83bb217011b85cdab7f0d42806f32b86dc4365201fd5a68bffa5b41f40cce7"]
			]
		},
		{
			id: "qwen3-0.6b-wasm", modelId: "qwen3-0.6b", label: "Qwen3 0.6B",
			device: "wasm", dtype: "q4", cpuRuntime: true,
			repo: "onnx-community/Qwen3-0.6B-ONNX-OPT", revision: "4799e655597b49210adb5c1ebe5b9d3bd04005a0",
			files: [
				["config.json", 1770, "86c544072c56874ad015eb70647bba4a2df163f66968dfced8ea0ca387fcae16"],
				["generation_config.json", 249, "7dfbda99ac3e2efae82d814cedf73f4a5f63eb46298d486b4ff779bab7ee496d"],
				["tokenizer.json", 9117036, "40ae5d1ee027b985684a3bbeef4ee16b2b5697d1d90658bec5bc5d2a73018bd7"],
				["tokenizer_config.json", 5051, "04984a9d62f1a94b929fca5670c1ab4f66aa330877816038fa88a41a158bd4b6"],
				["chat_template.jinja", 4168, "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8"],
				["onnx/model_q4.onnx", 369635, "be5f0d8d03ac387bdd2d2582e4e114ca3c23a44b70bf03be609844542107745c"],
				["onnx/model_q4.onnx_data", 403007488, "22f7763f31c1be426affc5b14cc37aa9c1c48e29d8ff043551a20606bd105e0f"]
			],
			// Reuse a complete older WASM download when the smaller build is absent.
			cachedBuild: {
				...qwenSmallOriginal, dtype: "q8",
				files: [
					...qwenSmallMetadata,
					["onnx/model_quantized.onnx", 617687575, "ccf8734e59fdf7475b2dc0c117005e267a3a08342c1d951e0a79f0bce57bf62a"]
				]
			}
		},
		{
			...lfm350, id: "lfm2.5-350m-wasm", device: "wasm", dtype: "q4", cpuRuntime: true,
			files: [
				...lfm350Metadata,
				["onnx/model_q4.onnx", 183442, "d1a705712e93aafaba1346b32245fa59e7857a46e2272003c0e8c524977e0de8"],
				["onnx/model_q4.onnx_data", 293629952, "71ec6ad38a4c463dcb3dba671d06a1d9861be3a23e51290d818b95c0b7d2a5db"]
			]
		}
	];
	let engine;
	let operation;
	let preparation;
	let activePairKey;
	let modelChannel;
	let retryPending = false;

	function assets(model, build) {
		const { repo, revision, files } = build;
		const modelPath = `${root}${model.modelId ?? model.id}/${revision}/`;
		// The CPU-only build includes quantized embedding kernels omitted from the WebGPU build.
		const runtime = build.cpuRuntime ? transformerModelAssets.cpuRuntime : [transformerModelAssets.runtime];
		return [...runtime, ...files
			.map(([name, size, digest]) => ({
				name, size, digest, path: modelPath + name,
				url: `https://huggingface.co/${repo}/resolve/${revision}/${name}`
			}))];
	}

	function modelPair(primaryId, fallbackId) {
		const primary = models.find(model => model.id === primaryId && model.device === "webgpu");
		const fallback = models.find(model => model.id === fallbackId && model.device === "wasm");
		if (!primary || !fallback) throw new Error("Select a primary WebGPU model and a WASM fallback in Models.");
		return { primary, fallback, key: JSON.stringify([primary.id, primary.revision, fallback.id, fallback.revision]) };
	}

	function modelForDevice(id, device) {
		if (!id) return;
		return models.find(model => model.device === device && (model.id === id || model.modelId === id));
	}

	function localConfig({ chatLocalModel, chatLocalPrimary, chatLocalFallback }) {
		return {
			chatLocalPrimary: chatLocalPrimary ?? modelForDevice(chatLocalModel, "webgpu")?.id ?? defaultConfig.chatLocalPrimary,
			chatLocalFallback: chatLocalFallback ?? modelForDevice(chatLocalModel, "wasm")?.id ?? defaultConfig.chatLocalFallback
		};
	}

	function requestSelection(id, fallbackId, device) {
		if (device === undefined || fallbackId !== undefined) return modelPair(id, fallbackId);
		// Standalone callers can still pass a model ID and an explicit device.
		if (device === "auto") return modelPair(modelForDevice(id, "webgpu")?.id, modelForDevice(id, "wasm")?.id);
		const primary = modelForDevice(id, device);
		if (!primary) throw new Error("Select a supported browser model and device.");
		return { primary, key: primary.id };
	}

	const modelLabel = model => `${model.label} · ${model.device === "webgpu" ? "WebGPU" : "WASM"}`;

	function readyState({ model, fallbackReason }) {
		return {
			ready: true, device: model.device, label: modelLabel(model) + (fallbackReason ? " (fallback)" : ""),
			message: "", fallbackReason
		};
	}

	async function webgpuBufferBytes(model, signal) {
		if (model.device !== "webgpu") return;
		const adapter = await untilAborted(Promise.resolve(navigator.gpu?.requestAdapter()).catch(() => undefined), signal);
		if (!adapter) throw new Error("WebGPU is unavailable in this browser.");
		if (model.shaderF16 && !adapter.features.has("shader-f16")) {
			throw new Error("The selected model requires WebGPU shader-f16 support.");
		}
		return Math.min(adapter.limits.maxBufferSize, adapter.limits.maxStorageBufferBindingSize);
	}

	async function status({ model, fallbackModel, device, timeoutMs }, { onProgress, signal } = {}) {
		try {
			signal?.throwIfAborted();
			const pair = requestSelection(model, fallbackModel, device);
			usePair(pair);
			const session = await preparePair(pair, { onProgress, signal, timeoutMs, allowRetry: !operation });
			return readyState(session);
		} catch (error) {
			signal?.throwIfAborted();
			return { ready: false, label: "", message: error.message || String(error) };
		}
	}

	async function download(vfs, id, device, report = () => {}, signal) {
		const model = modelForDevice(id, device);
		if (!model) throw new Error("Select a supported browser model and device.");
		await webgpuBufferBytes(model, signal);
		await prepareAssets(vfs, model, report, signal);
	}

	async function prepareAssets(vfs, model, report, signal, timeoutMs) {
		const downloadMissing = () => withIdleDeadline(signal, timeoutMs, async (request, touch) => {
			const files = await transformerModelAssets.missing(vfs, assets(model, model));
			if (!files.length) return model;
			if (model.cachedBuild && !(await transformerModelAssets.missing(vfs, assets(model, model.cachedBuild))).length) {
				return model.cachedBuild;
			}
			if (!report) throw new Error("Model files are missing. Download the model before starting inference.");
			const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
			if (estimate?.quota && files.reduce((bytes, file) => bytes + file.size, 0) > estimate.quota - (estimate.usage ?? 0)) {
				throw new Error("There is not enough browser storage for this model. Free up space in Workspace.");
			}
			await transformerModelAssets.download(vfs, files, (name, loaded, total) => {
				touch();
				report(name, loaded, total);
			}, request);
			return model;
		});
		if (navigator.locks) {
			let acquired = false;
			try {
				// Start the download deadline once this tab owns the download.
				return await navigator.locks.request("webstation.chat-model.download", { signal }, async () => {
					acquired = true;
					return downloadMissing();
				});
			} catch (error) {
				// Some file origins cannot use Web Locks. The pinned assets are safe to write more than once.
				if (acquired || error.name !== "SecurityError") throw error;
			}
		}
		return downloadMissing();
	}

	function lfmToolFormat() {
		const open = "<|tool_call_start|>";
		const close = "<|tool_call_end|>";
		const identifier = /^[A-Za-z_][\w-]{0,127}$/;

		// LFM emits Python-style calls. Parse only calls with literal data arguments.
		function parse(source) {
			let json;
			try { json = JSON.parse(source); }
			catch { return parseCalls(source.trim()); }
			return Array.isArray(json) ? json : [json];
		}

		function parseCalls(source) {
			const tokens = [];
			const pattern = /\s*("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|[A-Za-z_][\w-]*|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|\*\*|[\[\]{}(),:=])/y;
			const invalid = () => { throw new SyntaxError("Invalid LFM tool call."); };
			while (pattern.lastIndex < source.length) {
				const match = pattern.exec(source);
				if (!match) invalid();
				tokens.push(match[1]);
			}
			let index = 0;

			function accept(token) {
				if (tokens[index] !== token) return false;
				index++;
				return true;
			}
			function expect(token) {
				if (!accept(token)) invalid();
			}
			function name() {
				const token = tokens[index++];
				if (!token || !identifier.test(token)) invalid();
				return token;
			}
			function string(token) {
				if (!token || !/^['"]/.test(token)) invalid();
				const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", a: "\x07", v: "\v" };
				return token.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|U[\da-fA-F]{8}|x[\da-fA-F]{2}|[\s\S])/g, (match, code) => {
					if (code.length > 1) return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
					if ("\\\"'/".includes(code)) return code;
					return escapes[code] ?? match;
				});
			}
			function list(end, readItem) {
				const result = [];
				while (tokens[index] !== end) {
					result.push(readItem());
					if (!accept(",")) break;
				}
				expect(end);
				return result;
			}
			function record(end, separator, readKey, depth) {
				const entries = list(end, () => {
					const key = readKey();
					expect(separator);
					return [key, value(depth)];
				});
				const result = Object.fromEntries(entries);
				if (Object.keys(result).length !== entries.length) invalid();
				return result;
			}
			function value(depth) {
				if (depth > 64) invalid();
				if (accept("[")) return list("]", () => value(depth + 1));
				if (accept("{")) return record("}", ":", () => string(tokens[index++]), depth + 1);
				const token = tokens[index++];
				if (!token) invalid();
				if (/^['"]/.test(token)) return string(token);
				if (token === "None" || token === "null") return null;
				if (token === "True" || token === "true") return true;
				if (token === "False" || token === "false") return false;
				const number = Number(token);
				if (!/^[+-]?[\d.]/.test(token) || !Number.isFinite(number)) invalid();
				return number;
			}

			expect("[");
			const calls = list("]", () => {
				const tool = name();
				expect("(");
				if (accept("**")) {
					expect("{");
					const args = record("}", ":", () => string(tokens[index++]), 0);
					expect(")");
					return { name: tool, arguments: args };
				}
				return { name: tool, arguments: record(")", "=", name, 0) };
			});
			if (index !== tokens.length) invalid();
			return calls;
		}

		function prepareMessages(messages) {
			const jsonLiteral = value => JSON.stringify(value).replaceAll("<", "\\u003c");
			function literal(value) {
				if (value == null) return "None";
				if (typeof value === "boolean") return value ? "True" : "False";
				return jsonLiteral(value);
			}
			return messages.map(message => {
				if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) return message;
				// The ONNX chat template renders message content and does not interpolate tool_calls.
				const calls = [];
				for (const call of message.tool_calls) {
					const fn = call?.function;
					if (typeof fn?.name !== "string" || !identifier.test(fn.name)) continue;
					let args;
					try { args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments ?? {}; }
					catch { continue; }
					if (!args || typeof args !== "object" || Array.isArray(args)) continue;
					const entries = Object.entries(args);
					const parameters = entries.every(([key]) => identifier.test(key))
						? entries.map(([key, value]) => key + "=" + literal(value)).join(", ")
						: "**" + jsonLiteral(args);
					calls.push(fn.name + "(" + parameters + ")");
				}
				return calls.length ? { ...message, content: message.content + open + "[" + calls.join(", ") + "]" + close } : message;
			});
		}
		return { open, close, parse, prepareMessages, prepareTools: tools => tools.map(tool => tool.function ?? tool),
			endMarkers: ["<|startoftext|>", "<|pad|>"] };
	}

	function xmlToolFormat() {
		const invalid = () => new SyntaxError("Invalid tool call markup.");

		function parseArgument(value, schema) {
			const types = [schema?.type, ...(schema?.anyOf ?? schema?.oneOf ?? []).map(option => option.type)].flat().filter(Boolean);
			if (!types.length || (types.length === 1 && types[0] === "string")) return value;
			try {
				const parsed = JSON.parse(value);
				const type = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
				if (type === "number" && !Number.isFinite(parsed)) throw invalid();
				if (types.includes(type) || (types.includes("integer") && Number.isInteger(parsed))) return parsed;
			} catch { /* A union can also allow the original string. */ }
			if (types.includes("string")) return value;
			throw invalid();
		}

		function parse(source, tools) {
			const match = /^<function=([\w-]{1,128})>([\s\S]*)<\/function>$/.exec(source.trim());
			if (!match) throw invalid();
			const [, name, body] = match;
			// Multiline calls close on their own line. An inline closing tag can be part of the argument text.
			if (/^\r?\n/.test(body) && !/\r?\n[\t ]*$/.test(body)) throw invalid();
			const definition = tools.find(tool => (tool.function ?? tool).name === name);
			const properties = (definition?.function ?? definition)?.parameters?.properties ?? {};
			const args = Object.create(null);
			const start = /\s*<parameter=([^<>\r\n]{1,128})>/y;
			const end = /<\/parameter>(?=\s*(?:<parameter=|$))/g;
			while (body.slice(start.lastIndex).trim()) {
				const parameter = start.exec(body);
				if (!parameter || Object.hasOwn(args, parameter[1])) throw invalid();
				end.lastIndex = start.lastIndex;
				const closing = end.exec(body);
				if (!closing) throw invalid();
				// Keep whitespace in code and plain text, removing only the delimiter's framing line breaks.
				const value = body.slice(start.lastIndex, closing.index).replace(/^\r?\n|\r?\n$/g, "");
				const key = parameter[1];
				args[key] = parseArgument(value, Object.hasOwn(properties, key) ? properties[key] : undefined);
				start.lastIndex = end.lastIndex;
			}
			return [{ name, arguments: args }];
		}

		function prepareMessages(messages) {
			return messages.map(message => {
				if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
				const tool_calls = message.tool_calls.map(call => {
					const fn = call.function;
					if (typeof fn?.arguments !== "string") return call;
					let args;
					try { args = JSON.parse(fn.arguments); }
					catch { /* Skip malformed parameters in saved chat history. */ }
					return { ...call, function: { ...fn, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} } };
				});
				return { ...message, tool_calls };
			});
		}
		return { open: "<tool_call>", close: "</tool_call>", parse, prepareMessages, prefillsThinking: true,
			endMarkers: ["<|startoftext|>", "<|pad|>"] };
	}

	// Tool calls and reasoning are interleaved with visible text in the model's token stream.
	function createReply(publish, allowTools, stopTokens, toolFormat, tools = [], thinking = false) {
		const endMarkers = ["<|im_end|>", "<|endoftext|>", "<|im_start|>", ...(toolFormat?.endMarkers ?? []), ...stopTokens];
		const openTool = toolFormat?.open ?? "<tool_call>";
		const closeTool = toolFormat?.close ?? "</tool_call>";
		const parseCalls = toolFormat ? text => toolFormat.parse(text, tools) : text => [JSON.parse(text)];
		const textMarkers = [...endMarkers, "<think>", "</think>", ...(allowTools ? [openTool] : [])];
		const thinkingMarkers = ["</think>", ...endMarkers];
		let buffer = "";
		let content = "";
		let leading = "";
		let mode = toolFormat?.prefillsThinking && thinking ? "thinking" : "text";
		let stopped = false;
		const calls = [];

		function emit(text) {
			if (!content) {
				leading += text;
				if (!leading.trim()) return;
				text = leading;
				leading = "";
			}
			if (!text) return;
			content += text;
			publish(text);
		}

		function push(text) {
			if (stopped || !text) return;
			buffer += text;
			while (buffer) {
				if (mode === "tool") {
					let parsed;
					let end = buffer.indexOf(closeTool);
					while (end !== -1) {
						try { parsed = parseCalls(buffer.slice(0, end)); break; }
						catch { end = buffer.indexOf(closeTool, end + closeTool.length); }
					}
					if (end === -1) return;
					if (calls.length + parsed.length > 256) throw new Error("The browser model returned too many tool calls.");
					for (const call of parsed) {
						const { name, arguments: args } = call?.function ?? call ?? {};
						if (typeof name !== "string" || !/^[\w-]{1,128}$/.test(name) ||
							!args || typeof args !== "object" || Array.isArray(args)) {
							throw new Error("The browser model returned an invalid tool call.");
						}
						calls.push({ id: "call_" + crypto.randomUUID().replaceAll("-", ""), type: "function",
							function: { name, arguments: JSON.stringify(args) } });
					}
					buffer = buffer.slice(end + closeTool.length);
					mode = "text";
					continue;
				}

				const markers = mode === "thinking" ? thinkingMarkers : textMarkers;
				let next = buffer.length;
				let marker;
				for (const tag of markers) {
					const index = buffer.indexOf(tag);
					if (index !== -1 && index < next) { next = index; marker = tag; }
				}
				if (!marker) {
					// Keep any unfinished delimiter for the next streamed chunk.
					let end = buffer.length;
					for (const tag of markers) {
						for (let size = Math.min(buffer.length, tag.length - 1); size > buffer.length - end; size--) {
							if (buffer.endsWith(tag.slice(0, size))) { end = buffer.length - size; break; }
						}
					}
					if (mode === "text") emit(buffer.slice(0, end));
					buffer = buffer.slice(end);
					return;
				}

				if (mode === "text") emit(buffer.slice(0, next));
				buffer = buffer.slice(next + marker.length);
				if (marker === openTool) { mode = "tool"; leading = ""; }
				else if (marker === "<think>") { mode = "thinking"; leading = ""; }
				else if (marker === "</think>") mode = "text";
				else { buffer = ""; stopped = true; }
			}
		}

		function finish() {
			if (mode === "tool") throw new Error("The browser model returned an incomplete or invalid tool call.");
			if (mode === "text") emit(buffer);
			const message = { role: "assistant", content };
			if (calls.length) message.tool_calls = calls;
			return message;
		}
		return { push, finish, get stopped() { return stopped; } };
	}

	// Run in a Blob worker so the same bundle also starts from file://.
	function runWorker(createReply, lfmToolFormat, xmlToolFormat) {
		let tokenizer, model, TextStreamer, InterruptableStoppingCriteria, toolFormat;
		let chunkSize = 256;
		self.onmessage = async ({ data }) => {
			const { setup, messages, tools, thinking, temperature, stopTokens, maxTokens, stream, contextLimit } = data;
			try {
				if (setup) {
					const { modules, wasm, files, id, root, device, dtype, bufferBytes, prefillChunkSize = 768 } = setup;
					if (setup.toolFormat === "lfm2") toolFormat = lfmToolFormat();
					if (setup.toolFormat === "xml") toolFormat = xmlToolFormat();
					const moduleURL = URL.createObjectURL(modules.transformers);
					const factoryURL = URL.createObjectURL(modules.factory);
					try {
						const transformers = await import(moduleURL);
						const { env, AutoTokenizer, AutoModelForCausalLM } = transformers;
						({ TextStreamer, InterruptableStoppingCriteria } = transformers);
						const path = root + id + "/";
						Object.assign(env, { localModelPath: root, allowLocalModels: true, allowRemoteModels: false,
							useBrowserCache: false, useWasmCache: false,
							fetch: async resource => {
								const url = String(resource);
								const file = url.startsWith(path) && files[url.slice(path.length)];
								return file instanceof Blob
									? new Response(file, { headers: { "Content-Length": String(file.size) } })
									: new Response(null, { status: 404 });
							}
						});
						Object.assign(env.backends.onnx.wasm, {
							numThreads: 1, proxy: false, wasmPaths: { mjs: factoryURL }, wasmBinary: await wasm.arrayBuffer()
						});
						tokenizer = await AutoTokenizer.from_pretrained(id, { local_files_only: true });
						model = await AutoModelForCausalLM.from_pretrained(id, {
							device, dtype, local_files_only: true,
							// WebGPU sessions routinely assign some operations to the CPU. Log errors and fatal messages.
							...(device === "webgpu" ? { session_options: { logSeverityLevel: 3 } } : {})
						});
						if (model.config.model_type === "qwen3_5" && !model.sessions.vision_encoder) {
							// A null pixel_values placeholder is otherwise sent to the vision encoder during cached prefill.
							const prepare = model.prepare_inputs_for_generation.bind(model);
							model.prepare_inputs_for_generation = (...args) => {
								const prepared = prepare(...args);
								delete prepared.pixel_values;
								return prepared;
							};
						}
						if (device === "webgpu") {
							const { vocab_size: vocabularySize } = model.config.text_config ?? model.config;
							const tokensPerBuffer = Math.floor(bufferBytes / (vocabularySize * Float32Array.BYTES_PER_ELEMENT));
							chunkSize = Math.max(1, Math.min(prefillChunkSize, tokensPerBuffer));
						}
						env.fetch = async () => new Response(null, { status: 404 });
					} finally {
						URL.revokeObjectURL(moduleURL);
						URL.revokeObjectURL(factoryURL);
					}
					self.postMessage({ result: true });
					return;
				}

				const inputMessages = toolFormat ? toolFormat.prepareMessages(messages) : messages;
				const definitions = toolFormat?.prepareTools?.(tools) ?? tools;
				const inputs = tokenizer.apply_chat_template(inputMessages, {
					tools: definitions, add_generation_prompt: true, enable_thinking: thinking
				});
				const promptTokens = inputs.input_ids.dims.at(-1);
				const limit = Math.min(maxTokens, contextLimit - promptTokens);
				if (limit < 1) {
					throw Object.assign(
						new Error(`This request needs ${promptTokens} input tokens. The browser model has a ${contextLimit}-token budget. Use a shorter prompt or a new chat.`),
						{ code: "context-limit" }
					);
				}
				// Bound the size of the logits and report activity as the key/value cache fills.
				let cache;
				if (promptTokens > chunkSize) {
					self.postMessage({ status: "Reading the prompt locally…" });
					for (let end = chunkSize; end < promptTokens; end += chunkSize) {
						const prefix = await model.generate({
							input_ids: inputs.input_ids.slice(null, [0, end]),
							attention_mask: inputs.attention_mask.slice(null, [0, end]),
							...(cache ? { past_key_values: cache } : {}),
							max_new_tokens: 1, do_sample: false, return_dict_in_generate: true
						});
						// The cache contains the input tokens only. The sampled token is discarded.
						cache = prefix.past_key_values;
						self.postMessage({ status: `Reading the prompt locally… ${Math.floor(end / promptTokens * 100)}%` });
					}
				}
				self.postMessage({ status: "Generating locally…" });
				let lastActivity = performance.now();
				let completionTokens = 0;
				const stopping = new InterruptableStoppingCriteria();
				const reply = createReply(text => { if (stream) self.postMessage({ text }); },
					tools.length > 0, stopTokens, toolFormat, tools, thinking);
				const streamer = new TextStreamer(tokenizer, {
					skip_prompt: true, skip_special_tokens: false, clean_up_tokenization_spaces: false,
					callback_function(text) {
						reply.push(text);
						if (reply.stopped) stopping.interrupt();
					},
					token_callback_function(tokens) {
						completionTokens += tokens.length;
						const now = performance.now();
						if (now - lastActivity >= 500) {
							self.postMessage({ active: true });
							lastActivity = now;
						}
					}
				});
				await model.generate({ ...inputs, ...(cache ? { past_key_values: cache } : {}),
					max_new_tokens: limit, streamer, stopping_criteria: stopping,
					do_sample: temperature > 0, ...(temperature > 0 ? { temperature } : {}) });
				// generate updates an existing cache in place and leaves its disposal to the caller.
				await cache?.dispose();
				const message = reply.finish();
				const finishReason = message.tool_calls?.length ? "tool_calls" :
					!reply.stopped && completionTokens >= limit ? "length" : "stop";
				if (!message.content && !message.tool_calls?.length && finishReason === "length") {
					throw new Error("The browser model reached its output limit before answering. " +
						(thinking ? "Try turning off Allow thinking." : "Try a shorter prompt or start a new chat."));
				}
				self.postMessage({ result: { message, finishReason, promptTokens, completionTokens } });
			} catch (error) {
				self.postMessage({ error: error?.message || String(error), code: error?.code });
			}
		};
	}

	function release() {
		if (!engine) return;
		engine.worker.terminate();
		URL.revokeObjectURL(engine.url);
		engine = undefined;
	}

	function close() {
		const reason = new DOMException("Browser inference interrupted.", "AbortError");
		preparation?.controller.abort(reason);
		preparation = undefined;
		operation?.abort(reason);
		release();
		activePairKey = undefined;
		retryPending = false;
	}

	function usePair(pair) {
		if (activePairKey === pair.key) return;
		close();
		activePairKey = pair.key;
		if (pair.fallback) getModelChannel();
	}

	// A fallback belongs to a page's worker. A settings change or successful primary test can ask
	// another page to retry at its next preparation without interrupting an active inference request.
	function queuePrimaryRetry(key) {
		if (key === activePairKey && (engine?.fallbackReason || preparation?.model?.device === "wasm")) retryPending = true;
	}

	function getModelChannel() {
		if (modelChannel === undefined) {
			try {
				modelChannel = new BroadcastChannel("webstation.chat-model.v1");
				modelChannel.onmessage = ({ data }) => {
					if (typeof data?.retryPrimary !== "string") return;
					queuePrimaryRetry(data.retryPrimary);
					window.dispatchEvent(new Event("susi-primary-model-retry"));
				};
			} catch { modelChannel = null; }
		}
		return modelChannel;
	}

	function requestPrimaryRetry(primaryId, fallbackId, { share = false } = {}) {
		const { key } = modelPair(primaryId, fallbackId);
		queuePrimaryRetry(key);
		if (share) {
			try { getModelChannel()?.postMessage({ retryPrimary: key }); }
			catch { /* Each new page starts with the primary model even without cross-tab messaging. */ }
		}
	}

	// A caller can stop waiting for the model while the page's background preparation continues.
	async function untilAborted(promise, signal) {
		if (!signal) return promise;
		let abort;
		try {
			return await new Promise((resolve, reject) => {
				abort = () => reject(signal.reason);
				promise.then(resolve, reject);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		} finally { signal.removeEventListener("abort", abort); }
	}

	async function withIdleDeadline(signal, timeoutMs = 120000, run) {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error("Invalid request timeout.");
		signal?.throwIfAborted();
		const controller = new AbortController();
		const request = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		let timer;
		const touch = () => {
			clearTimeout(timer);
			timer = setTimeout(() => controller.abort(new DOMException("The browser model stopped responding.", "TimeoutError")), timeoutMs);
		};
		try {
			touch();
			const result = await run(request, touch);
			request.throwIfAborted();
			return result;
		} finally { clearTimeout(timer); }
	}

	async function exchange(worker, payload, { signal, onStatus, onToken, onActivity }) {
		let abort;
		try {
			return await new Promise((resolve, reject) => {
				abort = () => reject(signal.reason);
				signal.throwIfAborted();
				signal.addEventListener("abort", abort, { once: true });
				worker.onerror = event => {
					event.preventDefault();
					reject(new Error(event.message || "The browser model worker could not start."));
				};
				worker.onmessageerror = () => reject(new Error("The browser model response could not be read."));
				worker.onmessage = ({ data }) => {
					if (signal.aborted) return;
					try {
						onActivity?.();
						if (data.error) reject(Object.assign(new Error(data.error), { code: data.code }));
						else if (data.result) resolve(data.result);
						else if (data.status) onStatus?.(data.status);
						else if (data.text) onToken?.(data.text);
					} catch (error) { reject(error); }
				};
				worker.postMessage(payload);
			});
		} finally {
			worker.onmessage = worker.onmessageerror = worker.onerror = null;
			signal.removeEventListener("abort", abort);
		}
	}

	async function loadEngine(vfs, model, build, bufferBytes, signal, touch) {
		release();
		const manifest = assets(model, build);
		const [modules, blobs] = await untilAborted(Promise.all([
			transformerModelAssets.loadModules(), transformerModelAssets.read(vfs, manifest)
		]), signal);
		signal.throwIfAborted();
		if (blobs.some(blob => !blob)) throw new Error("Model files are missing. Download the model again in Models.");
		const [wasm, ...files] = blobs;
		const cpuOnly = build.cpuRuntime;
		const factory = cpuOnly ? new Blob([files.shift()], { type: "text/javascript" }) : modules.factory;
		const setup = { modules: { ...modules, factory }, wasm, id: model.modelId ?? model.id, root,
			device: model.device, bufferBytes, dtype: build.dtype, toolFormat: model.toolFormat, prefillChunkSize: model.prefillChunkSize,
			files: Object.fromEntries(manifest.slice(cpuOnly ? 2 : 1).map(({ name }, index) => [name, files[index]])) };
		const url = URL.createObjectURL(new Blob([`(${runWorker})(${createReply}, ${lfmToolFormat}, ${xmlToolFormat});`],
			{ type: "text/javascript" }));
		let session;
		try {
			session = engine = { model, url, worker: new Worker(url) };
			await exchange(session.worker, { setup }, { signal, onActivity: touch });
			signal.throwIfAborted();
			session.ready = true;
			return session;
		} catch (error) {
			if (!session) URL.revokeObjectURL(url);
			else if (engine === session) release();
			throw error;
		}
	}

	async function preparePair(pair, { onProgress, signal, timeoutMs, primaryError, allowRetry = true } = {}) {
		signal?.throwIfAborted();
		const { primary, fallback } = pair;
		if (allowRetry && retryPending && fallback && !primaryError) {
			retryPending = false;
			if (preparation?.model === fallback) {
				preparation.controller.abort(new DOMException("Retrying the primary browser model.", "AbortError"));
				preparation = undefined;
			}
			if (engine?.model === fallback) release();
		}
		let task = preparation;
		if (!task) {
			if (engine?.ready && !primaryError) {
				const session = engine;
				onProgress?.(readyState(session));
				return session;
			}
			task = preparation = { controller: new AbortController(), listeners: new Set() };
			const preparing = task;
			const publish = state => {
				preparing.state = state;
				for (const listener of preparing.listeners) listener(state);
			};
			const install = async (model, failure) => {
				preparing.model = model;
				const signal = preparing.controller.signal;
				const label = modelLabel(model);
				publish({ label, message: failure
					? `${modelLabel(primary)} failed. Switching to ${label}…` : `Checking ${label}…` });
				const { vfs, bufferBytes } = await withIdleDeadline(signal, timeoutMs, async request => {
					const vfs = await untilAborted(Promise.resolve(globalThis.vfsReady), request);
					if (!vfs) throw new Error("The browser model needs access to the virtual file system.");
					return { vfs, bufferBytes: await webgpuBufferBytes(model, request) };
				});
				const report = fallback && ((_name, loaded, total) =>
					publish({ label, message: `Downloading ${label}…`, loaded, total }));
				const build = await prepareAssets(vfs, model, report, signal, timeoutMs);
				publish({ label, message: `Loading ${label}…` });
				const session = await withIdleDeadline(signal, timeoutMs, (request, touch) =>
					loadEngine(vfs, model, build, bufferBytes, request, touch));
				if (failure) session.fallbackReason = `${modelLabel(primary)} failed: ${failure.message || failure}`;
				publish(readyState(session));
				return session;
			};
			task.promise = (async () => {
				let failure = primaryError;
				if (!failure) {
					try { return await install(primary); }
					catch (error) {
						preparing.controller.signal.throwIfAborted();
						if (!fallback) throw error;
						failure = error;
					}
				}
				try { return await install(fallback, failure); }
				catch (error) {
					preparing.controller.signal.throwIfAborted();
					if (!failure) throw error;
					throw new Error(`${modelLabel(primary)} failed: ${failure.message || failure}. ` +
						`${modelLabel(fallback)} failed: ${error.message || error}`, { cause: error });
				}
			})().finally(() => {
				if (preparation === preparing) preparation = undefined;
			});
		}
		if (onProgress) task.listeners.add(onProgress);
		try {
			if (task.state) onProgress?.(task.state);
			return await untilAborted(task.promise, signal);
		} finally { if (onProgress) task.listeners.delete(onProgress); }
	}

	async function generate({ model, fallbackModel, device, messages, tools, thinking, maxTokens, temperature, stopTokens,
		toolChoice, stream, signal, timeoutMs, onToken, onStatus, onProgress, onRestart }) {
		const pair = requestSelection(model, fallbackModel, device);
		if (toolChoice && !["auto", "none"].includes(toolChoice)) {
			throw new Error("Browser chat models support automatic tool selection.");
		}
		if (!Array.isArray(messages) || messages.some(message => !message ||
			!["system", "user", "assistant", "tool"].includes(message.role) ||
			(message.content != null && typeof message.content !== "string"))) {
			throw new Error("The selected browser model accepts text messages. Use a vision-capable API model for images.");
		}
		const escapeMarkers = text => (text ?? "").replace(
			/<\|[\w-]+\|>|<\/?(?:tool_response|tool_call|think)>/g, marker => "＜" + marker.slice(1));
		signal?.throwIfAborted();
		if (operation) throw new Error("A browser model is already generating on this page.");
		usePair(pair);
		const controller = operation = new AbortController();
		const request = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const payload = { stream, contextLimit, thinking: thinking === true,
			messages: messages.map(message => ({ ...message, content: escapeMarkers(message.content) })),
			tools: toolChoice === "none" || !Array.isArray(tools) ? [] : tools,
			maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, 4096) : 1024,
			temperature: Number.isFinite(temperature) && temperature >= 0 ? temperature : thinking ? 0.6 : 0,
			stopTokens: Array.isArray(stopTokens) ? stopTokens.filter(token => typeof token === "string" && token) : []
		};
		// Streaming clients that can replace a draft get live tokens during both attempts.
		// Other streaming callers receive the completed text.
		const publishToken = !pair.fallback || onRestart ? onToken : undefined;
		const attempt = session => withIdleDeadline(request, timeoutMs, async (attemptSignal, touch) => {
			try {
				return await exchange(session.worker, payload, { signal: attemptSignal, onActivity: touch, onStatus, onToken: publishToken });
			} catch (error) {
				if (engine === session && error.code !== "context-limit") release();
				throw error;
			}
		});
		try {
			const report = state => { onProgress?.(state); if (state.message) onStatus?.(state.message); };
			const options = { signal: request, timeoutMs, onProgress: report };
			let session = await preparePair(pair, options);
			let reply;
			try { reply = await attempt(session); }
			catch (error) {
				request.throwIfAborted();
				if (!pair.fallback || session.model !== pair.primary || error.code === "context-limit") throw error;
				onRestart?.();
				session = await preparePair(pair, { ...options, primaryError: error });
				reply = await attempt(session);
			}
			if (pair.fallback && !onRestart && stream && reply.message.content) onToken?.(reply.message.content);
			return { ...reply, model: device !== undefined && fallbackModel === undefined ? model : session.model.id };
		} catch (error) {
			request.throwIfAborted();
			throw error;
		} finally { if (operation === controller) operation = undefined; }
	}

	window.addEventListener("pagehide", () => {
		close();
		modelChannel?.close();
		modelChannel = undefined;
	});
	window.addEventListener("vfs-reset", close);
	const preview = window.susi?.localModel;
	if (preview) {
		// The preview is sandboxed. Its host runs the same worker against the host's model cache.
		return { models, defaultConfig, localConfig, modelPair, modelLabel,
			status: (options, { signal, onProgress } = {}) =>
				preview("status", [options], signal, (name, value) => { if (name === "progress") onProgress?.(value); }),
			generate: ({ signal, onToken, onStatus, onProgress, onRestart, ...options }) => {
				const handlers = { token: onToken, status: onStatus, progress: onProgress, restart: onRestart };
				return preview("generate", [options, Boolean(onRestart)], signal, (name, value) => handlers[name]?.(value));
			},
			close: () => { void preview("close", []).catch(() => {}); },
			requestPrimaryRetry: (primary, fallback) => { void preview("retry", [primary, fallback]).catch(() => {}); }
		};
	}

	function previewRequest(method, args, signal, emit) {
		switch (method) {
			case "status":
				return status(args[0], { signal, onProgress: state => emit("progress", state) });
			case "generate":
				return generate({
					...args[0], signal,
					onToken: text => emit("token", text),
					onStatus: text => emit("status", text),
					onProgress: state => emit("progress", state),
					onRestart: args[1] ? () => emit("restart") : undefined
				});
			case "retry":
				return requestPrimaryRetry(args[0], args[1]);
			case "close":
				return close();
			default:
				throw new Error("Unknown browser model operation.");
		}
	}

	return { models, defaultConfig, localConfig, modelPair, modelLabel, status, download, generate, close, requestPrimaryRetry, previewRequest };
})();
