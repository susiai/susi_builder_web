"use strict";

(() => {
	const get = id => document.getElementById(id);
	const formatMiB = bytes => `${(bytes / 1048576).toFixed(1)} MiB`;

	void initChatModels();
	void initSpeechToText();
	void initSpeechOutput();

	function notice(element, message, error = false) {
		if (element.textContent !== message) element.textContent = message;
		element.toggleAttribute("data-error", error);
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

	async function initChatModels() {
		const form = get("llm-config-form");
		const methods = get("chat-provider-options");
		const method = form.elements["chat-provider"];
		const apiFields = get("chat-api-settings");
		const host = get("apihost"), key = get("api-key"), modelID = get("model-id");
		const forgetKey = get("api-key-clear");
		const timeout = get("request-timeout"), prompt = get("systemprompt"), thinking = get("thinking");
		const choices = get("model-choices"), modelStatus = get("model-status"), refresh = get("refresh-models");
		const modelListTitle = get("model-list-title"), ollamaSetup = get("ollama-setup");
		const modelLoading = get("models-local-progress");
		const browserHelp = get("browser-model-help"), apiSelection = get("api-model-entry");
		const save = get("save-chat-model"), saveStatus = get("chat-model-settings-status");
		const testForm = get("model-test-form"), testPrompt = get("model-test-prompt");
		const testRun = get("model-test-run"), testCancel = get("model-test-cancel");
		const testStatus = get("model-test-status"), testReply = get("model-test-reply");
		const replyText = testReply.appendChild(document.createTextNode(""));

		const client = llmClient.create({ readApiKey: readLLMApiKey });
		const isBrowser = () => method.value === "browser";
		const ollamaHost = `http://localhost:${DEFAULT_OLLAMA_PORT}`;
		const browserGroups = [
			{ name: "chatLocalPrimary", title: "Primary · WebGPU", models: llmLocal.models.filter(model => model.device === "webgpu") },
			{ name: "chatLocalFallback", title: "Fallback · WASM", models: llmLocal.models.filter(model => model.device === "wasm") }
		];
		let config, operation, modelRequest, localCheck, localStatus;
		let localSelection, apiCatalog = { models: [] };

		function matchesSavedPair(selection, saved = config) {
			return saved?.chatProvider === "browser" && selection.chatLocalPrimary === saved.chatLocalPrimary &&
				selection.chatLocalFallback === saved.chatLocalFallback;
		}

		function readDraft() {
			const changes = {
				chatProvider: method.value, systemprompt: prompt.value, thinking: thinking.checked,
				requestTimeoutMs: timeout.valueAsNumber * 1000,
				...(isBrowser() ? localSelection : { apihost: host.value, model: modelID.value.trim() })
			};
			const settings = llmClient.normalizeConfig({ ...config, ...changes });
			const apiKey = isBrowser() ? undefined : llmClient.validateApiKey(settings.apihost, key.value.trim());
			return { changes, settings, apiKey };
		}

		function render() {
			const local = isBrowser();
			const locked = !config || Boolean(operation);
			const hasHost = Boolean(host.value.trim());
			const showSetup = !local && !apiCatalog.connected;
			const title = showSetup ? "Set up Ollama" : "Available models";
			const refreshLabel = showSetup ? "Check connection" : "Refresh list";
			if (modelListTitle.textContent !== title) modelListTitle.textContent = title;
			if (refresh.textContent !== refreshLabel) refresh.textContent = refreshLabel;
			methods.disabled = timeout.disabled = prompt.disabled = thinking.disabled = locked;
			apiFields.hidden = refresh.hidden = local;
			apiSelection.hidden = local || showSetup;
			browserHelp.hidden = !local;
			apiFields.disabled = locked || local;
			modelID.disabled = refresh.disabled = key.disabled = forgetKey.disabled = locked || local || !hasHost;
			choices.inert = locked;
			save.disabled = locked || (!local && !hasHost);
			testRun.disabled = save.disabled || (!local && !modelID.value.trim());
			testPrompt.readOnly = Boolean(operation);
			testCancel.hidden = operation?.kind !== "test";
			ollamaSetup.hidden = !showSetup;

			if (local) {
				const hasDraft = config && !matchesSavedPair(localSelection);
				const message = localStatus?.ready ?
					[`${localStatus.label} is ready.`, localStatus.fallbackReason].filter(Boolean).join(" ") :
					localStatus?.message || (hasDraft ? "Save settings to use the selected models in Chat." : "");
				notice(modelStatus, message, Boolean(localStatus?.message));
			} else {
				notice(modelStatus, apiCatalog.message || "", apiCatalog.error);
			}
		}

		function renderChoices() {
			const groups = isBrowser() ? browserGroups : [{ name: "model", models: apiCatalog.models }];
			choices.replaceChildren();
			choices.hidden = groups.every(group => !group.models.length);
			for (const { name, title, models } of groups) {
				if (!models.length) continue;
				const list = document.createElement("ul");
				const selected = name === "model" ? modelID.value.trim() : localSelection[name];
				for (const model of models) {
					const row = document.createElement("li");
					const label = document.createElement("label");
					const radio = document.createElement("input");
					const text = document.createElement("span");
					radio.type = "radio";
					radio.name = name;
					radio.value = model.id;
					radio.checked = model.id === selected;
					text.textContent = model.label || model.id;
					if (model.detail) {
						const detail = document.createElement("small");
						detail.textContent = model.detail;
						text.append(detail);
					}
					label.append(radio, text);
					row.append(label);
					list.append(row);
				}
				if (title) {
					const fieldset = document.createElement("fieldset");
					const legend = document.createElement("legend");
					legend.textContent = title;
					fieldset.append(legend, list);
					choices.append(fieldset);
				} else choices.append(list);
			}
		}

		async function checkLocal() {
			if (!config || operation || localCheck || !isBrowser() || !matchesSavedPair(localSelection)) return;
			const controller = localCheck = new AbortController();
			try {
				const status = await client.modelStatus(llmClient.requestOptions(config), {
					signal: controller.signal,
					onProgress(state) { if (localCheck === controller) renderModelProgress(modelLoading, state); }
				});
				if (localCheck === controller) localStatus = status;
			} catch (error) {
				if (localCheck === controller) localStatus = { ready: false, message: error.message || String(error) };
			} finally {
				if (localCheck === controller) {
					localCheck = undefined;
					renderModelProgress(modelLoading);
					render();
				}
			}
		}

		function cancelLocalCheck() {
			localCheck?.abort();
			localCheck = localStatus = undefined;
			renderModelProgress(modelLoading);
		}

		function stopLocalModel() {
			cancelLocalCheck();
			llmLocal.close();
		}

		function cancelApiList() {
			modelRequest?.abort();
			modelRequest = undefined;
		}

		function showApiList(models, message, { connected = false, error = false } = {}) {
			apiCatalog = { models, message, connected, error };
			renderChoices();
			render();
		}

		async function loadApiModels() {
			cancelApiList();
			if (!host.value.trim()) {
				showApiList([], "");
				return;
			}
			const request = modelRequest = new AbortController();
			apiCatalog = { ...apiCatalog, message: "Checking endpoint…", error: false };
			renderChoices();
			render();
			try {
				const settings = llmClient.normalizeConfig({
					apihost: host.value, requestTimeoutMs: timeout.valueAsNumber * 1000
				});
				const response = await client.listModels({
					baseUrl: settings.apihost, apiKey: key.value.trim(), signal: request.signal, timeoutMs: settings.requestTimeoutMs
				});
				if (request.signal.aborted) return;
				const items = response?.data ?? response?.models ?? response;
				if (!Array.isArray(items)) throw new Error("The endpoint did not return a model list.");
				const models = new Map();
				for (const model of items) {
					const id = model?.id || model?.name;
					if (typeof id !== "string" || !id.trim() || models.has(id)) continue;
					const created = model.created ?? model.created_at;
					const date = new Date(typeof created === "number" && created <= 1000000000000 ? created * 1000 : created);
					const detail = [model.owned_by || model.owner, Number.isNaN(date.getTime()) ? "" : date.toLocaleString()]
						.filter(Boolean).join(" · ");
					models.set(id, { id, detail });
				}
				const emptyMessage = settings.apihost === ollamaHost
					? "Connected. Run ollama pull lfm3:1.7b-q4_K_M to add a model, then refresh the list."
					: "Connected. No models reported. Enter a model ID to test.";
				showApiList([...models.values()], models.size ?
					`${models.size} model${models.size === 1 ? "" : "s"} available.` :
					emptyMessage, { connected: true });
			} catch (error) {
				if (request.signal.aborted) return;
				showApiList([], `Could not load models. ${error.message || error}`, { error: true });
			} finally {
				if (modelRequest === request) modelRequest = undefined;
			}
		}

		function clearTest() {
			notice(testStatus, "");
			replyText.data = "";
			testReply.hidden = true;
		}

		form.addEventListener("input", event => {
			const input = event.target;
			notice(saveStatus, "");
			clearTest();
			if (input.name === "chat-provider") {
				if (isBrowser()) {
					cancelApiList();
					renderChoices();
					void checkLocal();
				} else {
					stopLocalModel();
					void loadApiModels();
				}
			} else if (input === host || input === key) {
				if (input === host) key.value = modelID.value = "";
				cancelApiList();
				showApiList([], host.value.trim() ? "Check the connection to discover models." : "");
			} else if (input === modelID) {
				for (const radio of choices.querySelectorAll("input")) radio.checked = radio.value === modelID.value.trim();
			} else if (choices.contains(input) && input.checked) {
				if (isBrowser()) {
					localSelection[input.name] = input.value;
					stopLocalModel();
					void checkLocal();
				} else modelID.value = input.value;
			}
			render();
		});

		forgetKey.addEventListener("click", () => {
			try {
				writeLLMApiKey(llmClient.normalizeConfig({ apihost: host.value }).apihost, "");
				key.value = "";
				clearTest();
				notice(saveStatus, "Session key removed.");
				void loadApiModels();
			} catch (error) { notice(saveStatus, error.message, true); }
		});
		refresh.addEventListener("click", loadApiModels);

		form.addEventListener("submit", async event => {
			event.preventDefault();
			if (save.disabled) return;
			operation = { kind: "save" };
			notice(saveStatus, "Saving…");
			render();
			try {
				const { changes, apiKey } = readDraft();
				config = await writeLLMConfig(changes);
				if (isBrowser()) {
					cancelLocalCheck();
					llmLocal.requestPrimaryRetry(config.chatLocalPrimary, config.chatLocalFallback, { share: true });
				} else {
					host.value = config.apihost;
					modelID.value = config.model;
					try { writeLLMApiKey(config.apihost, apiKey); }
					catch { notice(saveStatus, "Settings saved. This browser could not store the session key.", true); return; }
				}
				notice(saveStatus, "Chat model settings saved.");
			} catch (error) {
				notice(saveStatus, error.message || String(error), true);
			} finally {
				operation = undefined;
				render();
				void checkLocal();
				if (document.activeElement === document.body && !save.disabled) save.focus({ preventScroll: true });
			}
		});

		testForm.addEventListener("submit", async event => {
			event.preventDefault();
			if (testRun.disabled || !form.reportValidity()) return;
			const text = testPrompt.value.trim();
			if (!text) { notice(testStatus, "Enter a test prompt.", true); return; }
			const controller = new AbortController();
			const local = isBrowser();
			operation = { controller, kind: "test" };
			cancelLocalCheck();
			clearTest();
			notice(testStatus, "Waiting for a reply…");
			render();
			try {
				const { settings, apiKey } = readDraft();
				const { chatLocalPrimary, chatLocalFallback } = settings;
				if (local) llmLocal.requestPrimaryRetry(chatLocalPrimary, chatLocalFallback);
				const { model, message, finishReason } = await client.streamChat({
					...llmClient.requestOptions(settings), apiKey,
					maxTokens: 512,
					messages: [{ role: "system", content: settings.systemprompt }, { role: "user", content: text }],
					signal: controller.signal,
					onStatus: stage => notice(testStatus, stage),
					onProgress(state) {
						localStatus = state.ready ? state : undefined;
						renderModelProgress(modelLoading, state);
						if (state.ready) render();
					},
					onRestart: clearTest,
					onToken(token) {
						if (testReply.hidden) notice(testStatus, "Receiving reply…");
						testReply.hidden = false;
						replyText.appendData(token);
					}
				});
				if (!message.content.trim()) throw new Error("The model returned no text.");
				replyText.data = message.content;
				testReply.hidden = false;
				const outcome = finishReason === "length" ? "Test reached the output limit with" : "Test complete with";
				notice(testStatus, `${outcome} ${localStatus?.label || model || settings.model}.`);
				if (local && model === chatLocalPrimary && matchesSavedPair(settings)) {
					const saved = await readLLMConfig().catch(() => null);
					if (!controller.signal.aborted && matchesSavedPair(settings, saved)) {
						llmLocal.requestPrimaryRetry(chatLocalPrimary, chatLocalFallback, { share: true });
					}
				}
			} catch (error) {
				localStatus = undefined;
				const stopped = controller.signal.aborted;
				notice(testStatus, stopped ? "Test stopped." : error.message || String(error), !stopped);
			} finally {
				operation = undefined;
				if (local && controller.signal.aborted) stopLocalModel();
				renderModelProgress(modelLoading);
				render();
				if (!document.hidden && controller.signal.aborted) void checkLocal();
				if (document.activeElement === document.body) testRun.focus({ preventScroll: true });
			}
		});
		testCancel.addEventListener("click", () => operation?.controller?.abort());
		testPrompt.addEventListener("input", clearTest);

		window.addEventListener("pagehide", () => {
			operation?.controller?.abort();
			cancelApiList();
			stopLocalModel();
		});
		window.addEventListener("pageshow", event => {
			if (!event.persisted || !config) return;
			if (isBrowser()) void checkLocal();
			else void loadApiModels();
		});
		window.addEventListener("focus", checkLocal);

		render();
		try {
			const saved = await readLLMConfig();
			const defaultOnly = saved.apihost === ollamaHost && saved.chatProvider !== "api" && !saved.model.trim();
			host.value = defaultOnly ? "" : saved.apihost;
			key.value = host.value ? readLLMApiKey(host.value) : "";
			modelID.value = saved.model;
			timeout.value = (saved.requestTimeoutMs ?? 120000) / 1000;
			prompt.value = saved.systemprompt;
			thinking.checked = saved.thinking ?? true;
			method.value = saved.chatProvider ?? "api";
			localSelection = llmLocal.localConfig(saved);
			for (const { name, models } of browserGroups) {
				if (!models.some(model => model.id === localSelection[name])) localSelection[name] = llmLocal.defaultConfig[name];
			}
			config = saved;
			notice(saveStatus, "");
			if (isBrowser()) {
				renderChoices();
				render();
				void checkLocal();
			} else void loadApiModels();
		} catch (error) { notice(saveStatus, error.message || String(error), true); }
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
