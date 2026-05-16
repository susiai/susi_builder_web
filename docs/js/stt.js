"use strict";

const stt = (() => {
	const root = "/Models/Whisper/";
	const { runtime } = transformerModelAssets;
	const configFiles = ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json"];
	const models = [
		{
			id: "whisper-tiny", label: "Whisper Tiny · multilingual", revision: "5332fcc35e32a33b86612b9a57a89be7906102b1",
			sizes: [2248, 3716, 339, 2480466, 282683, 10124910, 30727765],
			digests: [
				"fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e",
				"6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0"
			]
		},
		{
			id: "whisper-tiny.en", label: "Whisper Tiny · English", englishOnly: true,
			revision: "79fb389fc764e7c395bd330e9531d9d32ada7049",
			sizes: [2202, 1590, 339, 2128494, 835, 10124913, 30727382],
			digests: [
				"8cc3c6f8563d1b3fbd2c5af9f64c2bed8b020bc593c402d1ef53b9f08fbf1b90",
				"dbb2e063b7fbc41d9803b9698f93ecb035c50cbb3fb87b56cb131e4a5eb99059"
			]
		},
		{
			id: "whisper-base", label: "Whisper Base · multilingual", revision: "64da57285918e20ea79ea5c88eed7197933abaa8",
			sizes: [2248, 3776, 339, 2480466, 282683, 23200850, 53707539],
			digests: [
				"3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9",
				"a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861"
			]
		},
		{
			id: "whisper-small", label: "Whisper Small · multilingual", revision: "2d67713f236afa48a18992566e7647f6ca848e13",
			sizes: [2232, 3837, 339, 2480466, 282683, 92324809, 156780950],
			digests: [
				"969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06",
				"fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24"
			]
		},
		{
			id: "whisper-medium", label: "Whisper Medium · multilingual", dtype: "q4", webgpuOnly: true,
			revision: "8c5b90880ab9f79487ab33613413431bf661d595",
			sizes: [2256, 3694, 339, 2480466, 282683, 209993363, 469835828],
			digests: [
				"e22a27383d33e8eb9a07a3cd434f5ef47c43a19de5db07335fca9fa497718743",
				"72cff87d24864768d33a4f0447417a989cb2574c4142bbab2c600a63fb6581c5"
			]
		}
	];
	// The pinned multilingual models share the language tokens in generation_config.json.
	const languages = new Set(("af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu ha haw " +
		"he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl " +
		"ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo zh").split(" "));
	const audioTypes = {
		wav: "audio/wav", wave: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4",
		aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
		webm: "audio/webm", aiff: "audio/aiff", aif: "audio/aiff",
		mp4: "audio/mp4", mpeg: "audio/mpeg", mpga: "audio/mpeg"
	};
	const apiFormats = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);
	const apiDefaults = {
		endpoint: "https://api.openai.com/v1/audio/transcriptions",
		model: "gpt-transcribe"
	};
	const apiKeyStorage = "webstation.stt-api-key.v1";
	const apiMaxBytes = 25_000_000;
	const sampleRate = 16000;
	let engine;

	function audioMimeType(name, type) {
		if (type.startsWith("audio/")) return type;
		const extension = name.toLowerCase().split(".").at(-1);
		if ((!type || ["application/octet-stream", "video/webm", "video/mp4", "video/mpeg", "application/ogg"].includes(type)) &&
			Object.hasOwn(audioTypes, extension)) return audioTypes[extension];
		return "";
	}

	function apiSettings(endpoint, model) {
		const url = new URL(endpoint.trim());
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
			url.username || url.password || url.search || url.hash) {
			throw new Error("Enter an HTTPS transcription endpoint or an HTTP loopback endpoint without credentials.");
		}
		model = model.trim();
		if (!model) throw new Error("Enter the transcription model ID.");
		return { endpoint: url.href, model, keyRequired: url.hostname === "api.openai.com" };
	}

	function readApiKey(endpoint) {
		try {
			const saved = JSON.parse(sessionStorage.getItem(apiKeyStorage));
			return saved?.endpoint === endpoint && typeof saved.key === "string" ? saved.key : "";
		} catch { return ""; }
	}

	function clearApiKey() {
		sessionStorage.removeItem(apiKeyStorage);
	}

	async function saveApiSettings(endpoint, model, key) {
		const settings = apiSettings(endpoint, model);
		key = key.trim();
		if (settings.keyRequired && !key) throw new Error("Enter your OpenAI API key.");
		if (/[\x00-\x20\x7f]/.test(key)) throw new Error("Enter an API key without spaces or control characters.");
		const changeKey = key || readApiKey(settings.endpoint);
		const saved = changeKey ? sessionStorage.getItem(apiKeyStorage) : null;
		if (key) sessionStorage.setItem(apiKeyStorage, JSON.stringify({ endpoint: settings.endpoint, key }));
		else if (changeKey) clearApiKey();
		if (!await pageSettings.save("speech", { provider: "api", apiEndpoint: settings.endpoint,
			apiModel: settings.model, apiRequiresKey: Boolean(key) })) {
			if (changeKey) {
				if (saved === null) clearApiKey();
				else sessionStorage.setItem(apiKeyStorage, saved);
			}
			throw new Error("The transcription settings could not be saved.");
		}
	}

	function assets(model) {
		const suffix = model.dtype === "q4" ? "q4" : "quantized";
		const files = [...configFiles, `onnx/encoder_model_${suffix}.onnx`, `onnx/decoder_model_merged_${suffix}.onnx`];
		return [runtime, ...files.map((name, index) => ({
			name, path: `${root}${model.id}/${model.revision}/${name}`,
			url: `https://huggingface.co/Xenova/${model.id}/resolve/${model.revision}/${name}`,
			size: model.sizes[index], digest: model.digests[index - configFiles.length]
		}))];
	}

	function missingAssets(vfs, model) {
		return transformerModelAssets.missing(vfs, assets(model));
	}

	function download(vfs, model, report, signal) {
		return transformerModelAssets.download(vfs, assets(model), report, signal);
	}

	async function activeSettings(vfs) {
		const settings = await pageSettings.read("speech");
		if (settings.provider === "off") return;
		if (settings.provider === "api") {
			const api = apiSettings(settings.apiEndpoint, settings.apiModel);
			api.keyRequired ||= settings.apiRequiresKey === true;
			if (api.keyRequired && !readApiKey(api.endpoint)) return;
			return { provider: "api", ...api };
		}
		const model = models.find(item => item.id === settings.model);
		if (!model || !["wasm", "webgpu"].includes(settings.device)) return;
		if (model.webgpuOnly && (settings.device !== "webgpu" || !navigator.gpu)) return;
		if ((await missingAssets(vfs, model)).length) return;
		return { provider: "browser", model, device: settings.device, language: model.englishOnly ? "en" :
			languages.has(settings.language) ? settings.language : "auto" };
	}

	// A classic Blob worker can start from a file:// page, then import the bundled modules inside the worker.
	function runWorker() {
		let transcriber;
		self.onmessage = async ({ data }) => {
			const { sampleRate, audio, device, dtype, modelId, modules, files, wasm } = data;
			let { language } = data;
			try {
				if (!transcriber) {
					if (device === "webgpu" && !await self.navigator.gpu?.requestAdapter()) {
						throw new Error("WebGPU is unavailable. Select WASM in Models.");
					}
					const transformerUrl = URL.createObjectURL(modules.transformers);
					const factoryUrl = URL.createObjectURL(modules.factory);
					try {
						const { env, pipeline } = await import(transformerUrl);
						const modelPath = `/Models/${modelId}/`;
						Object.assign(env, {
							allowLocalModels: true, allowRemoteModels: false, localModelPath: "/Models/",
							useBrowserCache: false, useWasmCache: false,
							fetch: async path => {
								const url = String(path);
								const file = url.startsWith(modelPath) && files[url.slice(modelPath.length)];
								return file instanceof Blob ? new Response(file, { headers: { "Content-Length": String(file.size) } }) :
									new Response(null, { status: 404 });
							}
						});
						Object.assign(env.backends.onnx.wasm, {
							numThreads: 1, proxy: false, wasmPaths: { mjs: factoryUrl }, wasmBinary: await wasm.arrayBuffer()
						});
						transcriber = await pipeline("automatic-speech-recognition", modelId, {
							device, dtype, local_files_only: true
						});
						env.fetch = async () => new Response(null, { status: 404 });
					} finally {
						URL.revokeObjectURL(transformerUrl);
						URL.revokeObjectURL(factoryUrl);
					}
				}
				const windowSeconds = 30, strideSeconds = 5;
				const model = transcriber.model;
				const generation = model.generation_config;
				if (generation?.is_multilingual && !language) {
					self.postMessage({ stage: "Detecting speech language…" });
					// Whisper predicts a language token after its start token. Restrict this step to language tokens.
					const languages = new Map(Object.entries(generation.lang_to_id).map(([token, id]) => [id, token.slice(2, -2)]));
					const suppress = Array.from({ length: model.config.vocab_size }, (_, id) => id)
						.filter(id => !languages.has(id));
					const { input_features } = await transcriber.processor(audio.subarray(0, sampleRate * windowSeconds));
					const tokens = await model.generate({
						inputs: input_features, decoder_input_ids: [generation.decoder_start_token_id],
						max_new_tokens: 1, do_sample: false, return_timestamps: false, suppress_tokens: suppress
					});
					language = languages.get(Number(tokens.tolist()[0].at(-1)));
					if (!language) throw new Error("Whisper could not detect the speech language.");
				}
				const length = audio.length / sampleRate;
				const total = Math.max(1, 1 + Math.ceil((length - windowSeconds) / (windowSeconds - 2 * strideSeconds)));
				let completed = 0;
				self.postMessage({ progress: { completed, total } });
				const result = await transcriber(audio, {
					chunk_length_s: windowSeconds, stride_length_s: strideSeconds,
					...(language ? { language, task: "transcribe" } : {}),
					streamer: {
						put() {},
						end() { self.postMessage({ progress: { completed: ++completed, total } }); }
					}
				});
				self.postMessage({ text: result.text.trim() });
			} catch (error) {
				self.postMessage({ error: error?.message || String(error) });
			}
		};
	}

	function close() {
		if (!engine) return;
		const { worker, url, reject } = engine;
		engine = undefined;
		worker.terminate();
		URL.revokeObjectURL(url);
		reject?.(new DOMException("Transcription stopped.", "AbortError"));
	}

	async function decodeAudio(file, report, signal) {
		if (file.size > 64 * 1024 * 1024) throw new Error("Audio files are limited to 64 MiB each.");
		const Audio = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
		if (!Audio) throw new Error("This browser does not support audio decoding.");
		report("Decoding audio…");
		let samples;
		try {
			const audioContext = new Audio(1, 1, sampleRate);
			const decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
			if (!decoded.length) throw new Error("This file contains no audio.");
			if (decoded.duration > 1800) throw new Error("Audio files are limited to 30 minutes each.");
			samples = new Float32Array(decoded.length);
			for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
				const source = decoded.getChannelData(channel);
				for (let index = 0; index < samples.length; index++) samples[index] += source[index] / decoded.numberOfChannels;
			}
		} catch (error) {
			if (error.name === "EncodingError" || error.name === "NotSupportedError") {
				throw new Error("This browser could not decode the audio. Try WAV or MP3.", { cause: error });
			}
			throw error;
		}
		signal.throwIfAborted();
		return samples;
	}

	async function transcribeApi({ endpoint, model, keyRequired }, file, report, signal) {
		const key = readApiKey(endpoint);
		if (keyRequired && !key) throw new Error("Enter the transcription API key in Models.");
		let name = file.name;
		if (!name && file.type === "audio/wav") name = "recording.wav";
		if (!apiFormats.has(name?.split(".").at(-1).toLowerCase())) {
			const samples = await decodeAudio(file, report, signal);
			const pcm = Int16Array.from(samples, sample => Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
			file = microphoneWave([pcm], pcm.byteLength, sampleRate);
			name = "audio.wav";
		}
		if (file.size > apiMaxBytes) throw new Error("The transcription API accepts audio files up to 25 MB.");
		if (!file.size) throw new Error("This file contains no audio.");
		signal.throwIfAborted();
		const body = new FormData();
		body.append("file", file, name);
		body.append("model", model);
		const request = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
		report("Uploading audio and transcribing…");
		try {
			const response = await fetch(endpoint, {
				method: "POST", body, signal: request, credentials: "omit", redirect: "error",
				headers: key ? { Authorization: `Bearer ${key}` } : {}
			});
			if (!response.ok) {
				await response.body?.cancel();
				const detail = [401, 403].includes(response.status) ? " Check the transcription API key." : "";
				throw new Error(`Transcription API returned HTTP ${response.status}.${detail}`);
			}
			const result = await response.json();
			if (typeof result?.text !== "string") throw new Error("The transcription API did not return a JSON transcript.");
			if (!result.text.trim()) throw new Error("No speech was recognized.");
			return result.text.trim();
		} catch (error) {
			request.throwIfAborted();
			if (error instanceof TypeError) {
				throw new Error("Could not reach the transcription API. Check the endpoint and its browser access (CORS).");
			}
			throw error;
		}
	}

	async function transcribe(vfs, settings, file, report = () => {}, signal = new AbortController().signal) {
		signal.throwIfAborted();
		if (settings.provider === "api") return transcribeApi(settings, file, report, signal);
		const { model, device, language } = settings;
		if (model.webgpuOnly && device !== "webgpu") throw new Error(`${model.label} requires WebGPU.`);
		const samples = await decodeAudio(file, report, signal);
		const key = `${model.id}:${device}`;
		let setup = {};
		if (engine?.key !== key) {
			close();
			report(`Loading ${model.label} with ${device.toUpperCase()}…`);
			const files = assets(model);
			const [modules, blobs] = await Promise.all([
				transformerModelAssets.loadModules(), transformerModelAssets.read(vfs, files)
			]);
			signal.throwIfAborted();
			if (blobs.some(blob => !blob)) throw new Error("Whisper files are missing. Download the model again in Models.");
			const [wasm, ...weights] = blobs;
			setup = { modules, wasm, files: Object.fromEntries(files.slice(1).map(({ name }, index) => [name, weights[index]])) };
			const url = URL.createObjectURL(new Blob([`(${runWorker.toString()})();`], { type: "text/javascript" }));
			try { engine = { key, url, worker: new Worker(url) }; }
			catch (error) { URL.revokeObjectURL(url); throw error; }
		}
		const session = engine;
		try {
			const text = await new Promise((resolve, reject) => {
				session.reject = reject;
				session.worker.onerror = event => reject(new Error(event.message || "The transcription worker could not start."));
				session.worker.onmessageerror = () => reject(new Error("The transcription result could not be read."));
				session.worker.onmessage = ({ data }) => {
					if (data.progress) {
						const { completed, total } = data.progress;
						report(`Transcribing ${completed} of ${total} audio segments…`, completed, total);
					} else if (data.stage) report(data.stage);
					else if (data.error) reject(new Error(data.error));
					else resolve(data.text);
				};
				signal.addEventListener("abort", close, { once: true });
				session.worker.postMessage({ sampleRate, audio: samples, device, modelId: `Xenova/${model.id}`,
					dtype: model.dtype ?? "q8", language: !model.englishOnly && languages.has(language) ? language : undefined,
					...setup }, [samples.buffer]);
			});
			if (!text) throw new Error("No speech was recognized.");
			return text;
		} catch (error) {
			if (engine === session) close();
			if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
			throw new Error(`${model.label} (${device.toUpperCase()}) · ${error?.message || String(error)}`, { cause: error });
		} finally {
			session.reject = undefined;
			session.worker.onmessage = session.worker.onmessageerror = session.worker.onerror = null;
			signal.removeEventListener("abort", close);
		}
	}

	function microphoneWorklet() {
		class MicrophoneProcessor extends AudioWorkletProcessor {
			buffer = new Int16Array(2048);
			length = 0;
			stopped = false;

			constructor() {
				super();
				this.port.onmessage = () => {
					this.stopped = true;
					this.flush();
					this.port.postMessage(null);
				};
			}

			flush() {
				if (!this.length) return;
				const chunk = this.buffer.subarray(0, this.length);
				this.port.postMessage(chunk, [chunk.buffer]);
				this.buffer = new Int16Array(2048);
				this.length = 0;
			}

			process(inputs) {
				if (this.stopped) return false;
				for (const sample of inputs[0]?.[0] ?? []) {
					this.buffer[this.length++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
					if (this.length === this.buffer.length) this.flush();
				}
				return true;
			}
		}
		registerProcessor("susi-microphone", MicrophoneProcessor);
	}

	function microphoneWave(chunks, size, sampleRate) {
		const header = new ArrayBuffer(44);
		const view = new DataView(header);
		view.setUint32(0, 0x52494646); // RIFF
		view.setUint32(4, 36 + size, true);
		view.setUint32(8, 0x57415645); // WAVE
		view.setUint32(12, 0x666d7420); // fmt
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true); // PCM
		view.setUint16(22, 1, true); // Mono
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		view.setUint32(36, 0x64617461); // data
		view.setUint32(40, size, true);
		return new Blob([header, ...chunks], { type: "audio/wav" });
	}

	function createSpeechDictation({ recordButton, stopButton, microphonePanel, update, report }) {
		const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
		const supported = Boolean(Audio && globalThis.AudioWorkletNode && navigator.mediaDevices?.getUserMedia);
		const meter = microphonePanel.querySelector("meter");
		const meterLabel = meter.closest("label");
		const releaseButton = microphonePanel.querySelector("button");
		const readyTitle = recordButton.title;
		let microphone;
		let session;

		function render(ready, disabled = false) {
			recordButton.disabled = disabled || Boolean(session) || !ready || !supported;
			recordButton.title = !supported ? "Microphone recording is unavailable in this browser context" :
				ready ? readyTitle : "Configure speech to text in Models";
			recordButton.hidden = !ready || Boolean(session?.recorder);
			stopButton.hidden = !session?.recorder;
			stopButton.disabled = !session?.recorder || session.stopped;
			meterLabel.hidden = !session?.recorder || session.stopped;
			releaseButton.hidden = Boolean(session) || !microphone;
			microphonePanel.hidden = meterLabel.hidden && releaseButton.hidden;
		}

		function releaseMicrophone() {
			const stream = microphone;
			microphone = undefined;
			for (const track of stream?.getTracks() ?? []) track.stop();
		}

		async function requestMicrophone(signal) {
			if (microphone?.getAudioTracks().some(track => track.readyState === "live")) return microphone;
			releaseMicrophone();
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (signal.aborted) {
				for (const track of stream.getTracks()) track.stop();
				signal.throwIfAborted();
			}
			microphone = stream;
			for (const track of stream.getAudioTracks()) {
				track.enabled = false;
				track.addEventListener("ended", () => {
					if (microphone !== stream) return;
					session?.controller.abort(new Error("The microphone was disconnected."));
					releaseMicrophone();
					update();
				}, { once: true });
			}
			return stream;
		}

		releaseButton.addEventListener("click", () => {
			releaseMicrophone();
			update();
			if (!recordButton.disabled) recordButton.focus({ preventScroll: true });
		});

		stopButton.addEventListener("click", () => {
			if (!session?.recorder || session.stopped) return;
			session.stopped = true;
			session.recorder.port.postMessage("stop");
			update();
			report("Finishing recording…");
		});

		async function run(transcribe, settings) {
			if (session) throw new Error("A recording is already in progress.");
			const controller = new AbortController();
			const { signal } = controller;
			const limit = settings?.provider === "api" ? apiMaxBytes : 64 * 1024 * 1024;
			session = { controller };
			update();
			report(microphone ? "Starting microphone…" : "Waiting for microphone access…");
			try {
				const context = new Audio();
				let stream;
				let source;
				let recorder;
				let audio;
				try {
					if (!context.audioWorklet) throw new Error("This browser context does not support microphone audio processing.");
					const canceled = new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
					// A data URL also works when the page is opened directly from disk, where module loads are cross-origin.
					const module = "data:text/javascript," + encodeURIComponent(`(${microphoneWorklet.toString()})();`);
					[stream] = await Promise.race([canceled,
						Promise.all([requestMicrophone(signal), context.resume(), context.audioWorklet.addModule(module)])]);
					signal.throwIfAborted();
					source = context.createMediaStreamSource(stream);
					recorder = new AudioWorkletNode(context, "susi-microphone", { channelCount: 1, channelCountMode: "explicit" });
					const chunks = [];
					let size = 0;
					let peak = 0;
					meter.value = meter.min;
					const stopped = new Promise((resolve, reject) => {
						recorder.addEventListener("processorerror", () => reject(new Error("Microphone audio processing stopped.")), { once: true });
						recorder.port.onmessage = ({ data: chunk }) => {
							if (chunk === null) {
								if (!peak) reject(new Error("No microphone signal was captured. Check the selected input and its level."));
								else resolve(microphoneWave(chunks, size, context.sampleRate));
								return;
							}
							size += chunk.byteLength;
							if (size + 44 > limit) {
								const maximum = limit === apiMaxBytes ? "25 MB API" : "64 MiB";
								reject(new Error(`The recording reached the ${maximum} audio limit.`));
								return;
							}
							chunks.push(chunk);
							let level = 0;
							for (const sample of chunk) level = Math.max(level, Math.abs(sample));
							peak = Math.max(peak, level);
							meter.value = Math.max(meter.min, 20 * Math.log10(level / 32767));
						};
						for (const track of stream.getAudioTracks()) track.enabled = true;
						source.connect(recorder);
						recorder.connect(context.destination); // Keep the graph running. The processor only outputs silence.
					});
					const focusStop = document.activeElement === recordButton || document.activeElement === document.body;
					session.recorder = recorder;
					update();
					if (focusStop) stopButton.focus({ preventScroll: true });
					report("Recording… Stop recording to transcribe.");
					audio = await Promise.race([stopped, canceled]);
				} finally {
					// Keep the permission session available, with input muted between recordings.
					for (const track of stream?.getAudioTracks() ?? []) track.enabled = false;
					source?.disconnect();
					recorder?.disconnect();
					recorder?.port.close();
					await context.close().catch(() => {});
					session.recorder = undefined;
					update();
				}
				signal.throwIfAborted();
				const text = await transcribe(audio, signal);
				signal.throwIfAborted();
				return text;
			} catch (error) {
				if (error?.name === "NotAllowedError") throw new Error("Allow microphone access in your browser to record audio.");
				if (error?.name === "NotFoundError") throw new Error("No microphone was found.");
				if (error?.name === "NotReadableError") throw new Error("Could not open the microphone. Check your system's input settings.");
				throw error;
			} finally {
				controller.abort();
				session = undefined;
				update();
			}
		}

		return {
			get busy() { return Boolean(session); },
			render, run,
			cancel() { session?.controller.abort(); },
			close() {
				session?.controller.abort();
				releaseMicrophone();
				update();
			}
		};
	}

	async function transcribeWithProgress(vfs, settings, audio, signal, { container, report }) {
		const bar = container.querySelector("progress");
		container.hidden = false;
		try {
			return await transcribe(vfs, settings, audio, (label, done, total) => {
				if (total) {
					bar.max = total;
					bar.value = done;
				} else bar.removeAttribute("value");
				report(label);
			}, signal);
		} finally {
			container.hidden = true;
		}
	}

	const modelPaths = new Set(models.flatMap(model => assets(model).map(asset => asset.path.slice(1))));
	return { models, modelPaths, languages, missingAssets, activeSettings, download, transcribe, close, audioMimeType,
		apiDefaults, readApiKey, saveApiSettings, clearApiKey,
		createDictation: createSpeechDictation, transcribeWithProgress,
		audioAccept: ["audio/*", ...Object.keys(audioTypes).map(extension => "." + extension)].join(",") };
})();
