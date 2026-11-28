"use strict";

(() => {
	const get = id => document.getElementById(id);
	const formatMiB = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;

	void initPromptForm("chat", [
		{ input: get("systemprompt"), key: "systemprompt", fallback: llmClient.normalizeConfig().systemprompt }
	], "Chat prompt saved.");
	void initPromptForm("studio", [
		{ input: get("studio-system-prompt"), key: "studioFilePrompt", placeholder: "<file>", fallback: StudioFileChat.defaultPrompt },
		{ input: get("studio-marked-prompt"), key: "studioMarkedPrompt", placeholder: "<marked>", fallback: StudioFileChat.defaultMarkedPrompt }
	], "Code Studio prompts saved.");
	void initSpeechToText();
	void initSpeechOutput();

	function notice(element, message, error = false) {
		if (element.textContent !== message) element.textContent = message;
		element.toggleAttribute("data-error", error);
	}

	async function initPromptForm(context, fields, successMessage) {
		const form = get(context + "-prompt-form");
		const save = form.querySelector('[type="submit"]');
		const reset = get(context + "-prompt-default"), status = get(context + "-prompt-status");
		try {
			const store = new WorkspaceConfigStore(await window.vfsReady);
			let saved = await store.read();
			const savedValue = (field, config = saved) => field.key === "systemprompt"
				? llmClient.normalizeConfig({ systemprompt: config.systemprompt }).systemprompt : config[field.key] ?? field.fallback;
			const changed = field => field.input.value !== savedValue(field);
			function edited() {
				for (const { input, placeholder } of fields) {
					input.setCustomValidity(!placeholder || input.value.includes(placeholder) ? "" : `Include the ${placeholder} placeholder.`);
				}
				save.disabled = !fields.some(changed);
				notice(status, "");
			}
			reset.disabled = false;
			for (const field of fields) {
				field.input.value = savedValue(field);
				field.input.disabled = false;
			}
			edited();
			form.addEventListener("input", edited);
			reset.addEventListener("click", () => {
				for (const field of fields) field.input.value = field.fallback;
				edited();
				fields[0].input.focus();
			});
			form.addEventListener("submit", async event => {
				event.preventDefault();
				if (!form.reportValidity()) return;
				const changes = fields.filter(changed);
				save.disabled = reset.disabled = true;
				for (const { input } of fields) input.disabled = true;
				try {
					saved = await store.update(config => {
						for (const field of changes) {
							const current = savedValue(field, config);
							if (current !== savedValue(field) && current !== field.input.value) {
								throw new Error("The prompt changed in another page. Reload Models before saving.");
							}
							config[field.key] = field.input.value;
						}
						return config;
					});
					for (const field of fields) field.input.value = savedValue(field);
					edited();
					notice(status, successMessage);
				} catch (error) {
					notice(status, error.message, true);
				} finally {
					for (const { input } of fields) input.disabled = false;
					reset.disabled = false;
					save.disabled = !fields.some(changed);
				}
			});
		} catch (error) {
			notice(status, error.message || "Unable to load the system prompt.", true);
		}
	}

	function speechForm(prefix, submitName, offLabel) {
		const field = name => get(`${prefix}-${name}`);
		const form = field("form");
		const method = form.elements[`${prefix}-provider`];
		const provider = field("provider-options");
		const browserSettings = field("browser-settings"), apiSettings = field("api-settings");
		const submit = field(submitName), cancel = field("cancel"), progress = field("progress"), status = field("status");
		const showStatus = (message, error) => notice(status, message, error);

		function renderProvider(savedProvider, { locked, downloading, checking = false }) {
			const local = method.value === "browser";
			const api = method.value === "api";
			provider.disabled = locked;
			browserSettings.hidden = !local;
			browserSettings.disabled = locked || !local || checking;
			apiSettings.hidden = !api;
			apiSettings.disabled = locked || !api;
			cancel.hidden = progress.hidden = !local || !downloading;
			submit.hidden = !local && !api && savedProvider === "off";
			if (!local) {
				submit.disabled = locked || (!api && savedProvider === "off");
				submit.textContent = api ? "Save API settings" : offLabel;
			}
			return local;
		}

		function reportDownload(name, loaded, total) {
			progress.max = total;
			progress.value = loaded;
			showStatus(`Downloading ${name}…`);
		}

		return { field, form, method, provider, submit, cancel, progress, renderProvider, showStatus, reportDownload };
	}

	async function checkSpeechDevice(device) {
		if (device === "webgpu" && !await navigator.gpu?.requestAdapter()) {
			throw new Error("No WebGPU adapter is available. Select WASM instead.");
		}
	}

	async function initSpeechToText() {
		const { field, form, method, provider, submit: download, cancel, progress, renderProvider, showStatus, reportDownload } =
			speechForm("speech", "download", "Turn off speech to text");
		const model = field("model"), device = field("device"), language = field("language");
		const info = field("model-info"), filePermission = field("file-permission");
		const endpoint = field("api-endpoint"), apiModel = field("api-model"), apiKey = field("api-key");
		let vfs;
		let active;
		let savedProvider = "off";
		let files;
		let operation;
		let request = 0;
		let modelChanged = false;
		let preferredDevice = "wasm";
		let preferredLanguage = "auto";

		const languageNames = new Intl.DisplayNames("en", { type: "language" });
		const languageOptions = [...stt.languages].map(code => new Option(languageNames.of(code), code));
		for (const option of languageOptions.sort((a, b) => a.text.localeCompare(b.text, "en"))) language.add(option);

		const selection = () => stt.models.find(item => item.id === model.value);

		function render() {
			filePermission.hidden = location.protocol !== "file:" || method.value === "off";
			const locked = !vfs || Boolean(operation);
			if (!renderProvider(savedProvider, { locked, downloading: operation && files?.length })) return;
			const selected = selection();
			model.disabled = Boolean(operation);
			device.value = selected?.webgpuOnly ? "webgpu" : preferredDevice;
			device.disabled = !vfs || Boolean(operation) || Boolean(selected?.webgpuOnly);
			language.disabled = !vfs || Boolean(operation) || Boolean(selected?.englishOnly);
			language.value = selected?.englishOnly ? "en" : preferredLanguage;
			download.disabled = locked || !files || (device.value === "webgpu" && !navigator.gpu);
			download.textContent = files?.length === 0 ? "Apply settings" : "Download & apply";
			if (!selected || !files) {
				info.textContent = selected ? "Checking model files…" : "";
				return;
			}
			const size = formatMiB(files.reduce((size, file) => size + file.size, 0));
			const detail = files.length ? `${size} to download, including any missing runtime files.` : "Downloaded.";
			const localActive = active?.provider === "browser" ? active : undefined;
			const activeLanguage = localActive?.language === "auto" ? "Auto-detect" :
				localActive && languageNames.of(localActive.language);
			const selectedLabel = localActive ?
				` In use: ${localActive.model.label} (${localActive.device.toUpperCase()}) · ${activeLanguage}.` : "";
			const deviceDetail = device.value === "webgpu" && !navigator.gpu ? " WebGPU is unavailable in this browser." : "";
			info.textContent = detail + selectedLabel + deviceDetail;
		}

		async function refresh() {
			if (!vfs || operation) return;
			const id = ++request;
			const selected = selection();
			files = undefined;
			render();
			if (method.value !== "browser" || !selected) return;
			try {
				const [next, missing] = await Promise.all([
					stt.activeSettings(vfs), stt.missingAssets(vfs, selected)
				]);
				if (id !== request) return;
				active = next;
				files = missing;
			} catch (error) {
				if (id === request) showStatus(error.message || String(error), true);
			} finally {
				if (id === request) render();
			}
		}

		provider.addEventListener("change", () => {
			showStatus("");
			refresh();
		});
		endpoint.addEventListener("input", () => { apiKey.value = ""; });
		field("api-openai").addEventListener("click", () => {
			endpoint.value = stt.apiDefaults.endpoint;
			apiModel.value = stt.apiDefaults.model;
			apiKey.value = stt.readApiKey(endpoint.value);
		});

		model.addEventListener("change", () => {
			modelChanged = true;
			showStatus("");
			refresh();
		});
		device.addEventListener("change", () => {
			preferredDevice = device.value;
			showStatus("");
			render();
		});
		language.addEventListener("change", () => {
			preferredLanguage = language.value;
			showStatus("");
		});
		cancel.addEventListener("click", () => operation?.abort());
		window.addEventListener("pagehide", () => operation?.abort());
		window.addEventListener("focus", refresh);
		form.addEventListener("submit", async event => {
			event.preventDefault();
			if (download.disabled) return;
			const mode = method.value;
			const backend = device.value;
			const controller = operation = new AbortController();
			showStatus("");
			progress.removeAttribute("value");
			render();
			try {
				if (mode === "off") {
					if (!await pageSettings.save("speech", { provider: "off" })) throw new Error("Could not turn off speech to text.");
					active = undefined;
					savedProvider = "off";
					showStatus("Speech to text is off.");
					return;
				}
				if (mode === "api") {
					await stt.saveApiSettings(endpoint.value, apiModel.value, apiKey.value);
					savedProvider = "api";
					showStatus("Transcription API settings saved.");
					return;
				}
				const selected = selection();
				const settings = { provider: "browser", model: selected.id, device: backend };
				if (!selected.englishOnly) settings.language = preferredLanguage;
				await checkSpeechDevice(backend);
				await stt.download(vfs, selected, reportDownload, controller.signal);
				controller.signal.throwIfAborted();
				if (!await pageSettings.save("speech", settings)) {
					throw new Error("The files are downloaded, but the selection could not be saved.");
				}
				savedProvider = "browser";
				showStatus("Speech-to-text settings saved.");
			} catch (error) {
				const canceled = mode === "browser" && controller.signal.aborted;
				showStatus(canceled ? "Download canceled. Select Download to resume." : error.message || String(error), !canceled);
			} finally {
				operation = undefined;
				if (mode === "browser") await refresh();
				else render();
			}
		});

		try {
			const ready = await window.vfsReady;
			const settings = await pageSettings.read("speech");
			savedProvider = settings.provider === "api" ? "api" :
				settings.provider !== "off" && stt.models.some(item => item.id === settings.model) ? "browser" : "off";
			method.value = savedProvider;
			endpoint.value = settings.apiEndpoint || stt.apiDefaults.endpoint;
			apiModel.value = settings.apiModel || stt.apiDefaults.model;
			apiKey.value = stt.readApiKey(endpoint.value);
			if (stt.languages.has(settings.language)) preferredLanguage = settings.language;
			if (!modelChanged && [...model.options].some(option => option.value === settings.model)) {
				model.value = settings.model;
			}
			if (settings.device === "webgpu") preferredDevice = "webgpu";
			vfs = ready;
			await refresh();
		} catch (error) { showStatus(error.message || String(error), true); }
	}

	async function initSpeechOutput() {
		const { field, form, method, provider, submit: enable, cancel, progress, renderProvider, showStatus, reportDownload } =
			speechForm("speech-output", "enable", "Turn off speech output");
		const language = field("language"), voice = field("voice"), device = field("device");
		const apiEndpoint = field("api-endpoint"), apiModel = field("api-model"), apiVoice = field("api-voice"), apiKey = field("api-key");
		const info = field("info");
		let vfs;
		let saved = { provider: "off" };
		let operation;
		let missing;
		let checking = false;

		for (const [id, name] of Object.entries(tts.languages)) language.add(new Option(name, id));
		for (const [id, name] of Object.entries(tts.voices)) voice.add(new Option(name, id));
		for (const id of tts.apiVoices) apiVoice.add(new Option(id[0].toUpperCase() + id.slice(1), id));
		const browserLanguage = navigator.language.split("-")[0];
		language.value = Object.hasOwn(tts.languages, browserLanguage) ? browserLanguage : "en";
		device.value = navigator.gpu ? "webgpu" : "wasm";

		function render() {
			const locked = !vfs || Boolean(operation);
			if (!renderProvider(saved.provider, { locked, downloading: operation && missing?.length, checking })) return;
			enable.disabled = locked || checking || !missing || (device.value === "webgpu" && !navigator.gpu);
			enable.textContent = missing?.length === 0 ? "Apply settings" : "Download & enable";
			if (!missing || checking) { info.textContent = checking ? "Checking Chatterbox files…" : ""; return; }
			const bytes = missing.reduce((total, asset) => total + asset.size, 0);
			const download = bytes ? `${formatMiB(bytes)} to download.` : "Model downloaded.";
			const active = !missing.length && saved.provider === "browser" && tts.validSettings(saved);
			const selected = active ? ` In Chat: ${tts.voices[saved.voice ?? "default"]} · ` +
				`${tts.languages[saved.language]} · ${saved.device.toUpperCase()}.` : "";
			const backend = device.value === "wasm" ? " WASM synthesis can take several minutes on the CPU." :
				!navigator.gpu ? " WebGPU is unavailable in this browser." : "";
			info.textContent = download + selected + backend;
		}

		async function checkLocalAssets() {
			if (!vfs || checking || method.value !== "browser") return;
			checking = true;
			render();
			try { missing = await tts.missingAssets(vfs); }
			catch (error) {
				missing = undefined;
				if (method.value === "browser") showStatus(error.message || String(error), true);
			} finally {
				checking = false;
				render();
			}
		}

		provider.addEventListener("change", () => {
			showStatus("");
			render();
			checkLocalAssets();
		});
		apiEndpoint.addEventListener("input", () => { apiKey.value = ""; });
		field("api-openai").addEventListener("click", () => {
			apiEndpoint.value = tts.apiDefaults.endpoint;
			apiModel.value = tts.apiDefaults.model;
			apiVoice.value = tts.apiDefaults.voice;
			apiKey.value = tts.readApiKey(apiEndpoint.value);
		});
		device.addEventListener("change", render);
		cancel.addEventListener("click", () => operation?.abort());
		window.addEventListener("pagehide", () => operation?.abort());
		form.addEventListener("submit", async event => {
			event.preventDefault();
			if (enable.disabled) return;
			const mode = method.value;
			const controller = operation = new AbortController();
			progress.removeAttribute("value");
			showStatus("");
			render();
			try {
				if (mode === "off") {
					if (!await pageSettings.save("speechOutput", { provider: "off" })) throw new Error("Could not turn off speech output.");
					saved.provider = "off";
					showStatus("Speech output is off.");
					return;
				}
				if (mode === "api") {
					const settings = await tts.saveApiSettings(apiEndpoint.value, apiModel.value, apiVoice.value, apiKey.value);
					apiEndpoint.value = settings.endpoint;
					apiModel.value = settings.model;
					saved.provider = "api";
					showStatus("Speech output API settings saved.");
					return;
				}
				const selection = { provider: "browser", language: language.value, voice: voice.value, device: device.value };
				await checkSpeechDevice(selection.device);
				if (missing.length) await tts.download(vfs, reportDownload, controller.signal);
				controller.signal.throwIfAborted();
				if (!await pageSettings.save("speechOutput", selection)) throw new Error("Could not save speech output settings.");
				saved = { ...saved, ...selection };
				showStatus("Speech output is ready in Chat.");
			} catch (error) {
				showStatus(controller.signal.aborted ? "Download canceled. Select Download to resume." :
					error.message || String(error), !controller.signal.aborted);
			} finally {
				operation = undefined;
				render();
				if (mode === "browser") await checkLocalAssets();
			}
		});

		try {
			const ready = await window.vfsReady;
			saved = await pageSettings.read("speechOutput");
			saved.provider = saved.provider === "api" ? "api" :
				saved.provider !== "off" && tts.validSettings(saved) ? "browser" : "off";
			method.value = saved.provider;
			if (tts.validSettings(saved)) {
				language.value = saved.language;
				voice.value = saved.voice ?? "default";
				device.value = saved.device;
			}
			apiEndpoint.value = saved.apiEndpoint || tts.apiDefaults.endpoint;
			apiModel.value = saved.apiModel || tts.apiDefaults.model;
			apiVoice.value = tts.apiVoices.includes(saved.apiVoice) ? saved.apiVoice : tts.apiDefaults.voice;
			apiKey.value = tts.readApiKey(apiEndpoint.value);
			vfs = ready;
			render();
			if (method.value === "api" && !apiKey.value) showStatus("Enter the API key to enable speech output in this tab.");
			await checkLocalAssets();
		} catch (error) { showStatus(error.message || String(error), true); }
	}
})();
