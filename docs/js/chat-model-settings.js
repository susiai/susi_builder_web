"use strict";

const chatModelSettingsMarkup = includeSystemPrompt => `
	<form id="llm-config-form">
		<div id="models-layout">
			<div id="chat-model-config">
				<fieldset id="chat-provider-options" disabled>
					<legend>Inference method</legend>
					<div class="model-fields">
						<label><input type="radio" name="chat-provider" value="browser" checked /> Browser model</label>
						<label><input type="radio" name="chat-provider" value="api" /> API endpoint</label>
					</div>
				</fieldset>
				<fieldset id="chat-api-settings" hidden disabled>
					<legend>Model endpoint</legend>
					<label for="apihost">API host</label>
					<input id="apihost" name="apihost" type="url" placeholder="http://localhost:11434" required />
					<label for="api-key">API key (optional)</label>
					<div class="model-key-entry">
						<input id="api-key" type="password" autocomplete="off" spellcheck="false"
							aria-describedby="api-key-help" />
						<button id="api-key-clear" type="button" title="Forget this endpoint's key">Forget key</button>
					</div>
					<p id="api-key-help">Saved keys stay in this tab. Use HTTPS for remote providers.</p>
				</fieldset>
				${includeSystemPrompt ? `<div>
					<label for="systemprompt">System prompt</label>
					<textarea id="systemprompt" name="systemprompt" rows="4"></textarea>
				</div>` : ""}
				<div class="model-fields">
					<div>
						<label for="request-timeout">Idle timeout (seconds)</label>
						<input id="request-timeout" type="number" min="10" max="600" step="1" required value="120" />
					</div>
					<label id="thinking-option" for="thinking">
						<input id="thinking" name="thinking" type="checkbox" checked /> Allow thinking
					</label>
				</div>
			</div>
			<section id="model-list" aria-labelledby="model-list-title">
				<header class="model-actions">
					<h3 id="model-list-title">Available models</h3>
					<button type="button" id="refresh-models" hidden disabled>Refresh list</button>
				</header>
				<p id="browser-model-help">WebGPU runs first, with WASM as a fallback. Model files download as needed.</p>
				<p id="model-status" role="status"></p>
				<div id="ollama-setup" hidden>
					<p>Ollama is the recommended API option for running larger models locally.</p>
					<ul>
						<li><strong>Install Ollama.</strong> Get the desktop app for your system from
							<a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com</a>.</li>
						<li><strong>Allow browser connections on macOS.</strong> Run this in Terminal, then
							quit Ollama and reopen it.
							<pre><code>launchctl setenv OLLAMA_ORIGINS "*"</code></pre>
						</li>
						<li><strong>Allow browser connections on Windows.</strong> Quit Ollama from the system tray,
							open <em>Edit environment variables for your account</em>, and create a user variable
							named <code>OLLAMA_ORIGINS</code> with the value <code>*</code>. Reopen Ollama from the
							Start menu. <a href="https://objectgraph.com/blog/ollama-cors/#on-windows"
								target="_blank" rel="noopener">Windows walkthrough</a></li>
						<li><strong>Download a model.</strong> Run one of these commands in Terminal or PowerShell.
							<ul>
								<li><code>ollama pull lfm3:1.7b-q4_K_M</code></li>
								<li><code>ollama pull gemma4:e4b-it-qat</code></li>
								<li><code>ollama pull gemma4:12b-it-qat</code></li>
								<li><code>ollama pull qwen3.6:35b-a3b-q4_K_M</code></li>
								<li><code>ollama pull qwen3.8:27b-mtp-q4_K_M</code></li>
								<li><code>ollama pull inkling-2-mini:26b-a5b</code></li>
							</ul>
						</li>
						<li><strong>Connect to Ollama.</strong><br />
							Type <code>http://localhost:11434</code> into the <strong>API host</strong> field.<br />
							Leave the API key blank and choose <strong>Check connection</strong>.</li>
					</ul>
				</div>
				<div id="api-model-entry" hidden>
					<label for="model-id">Model ID</label>
					<input id="model-id" autocomplete="off" spellcheck="false" placeholder="Choose or enter a model ID" />
				</div>
				<div id="model-choices" hidden></div>
				<div id="models-local-progress" class="model-loading" hidden>
					<progress aria-label="Browser model preparation"></progress>
					<span role="status"></span>
				</div>
			</section>
		</div>
		<div class="model-actions" id="chat-model-actions">
			<button id="save-chat-model" type="submit" disabled>Save settings</button>
			<p id="chat-model-settings-status" data-vfs-open-status role="status">Opening the workspace…</p>
		</div>
	</form>
	<section id="model-test" aria-labelledby="model-test-title">
		<h3 id="model-test-title">Test model</h3>
		<p id="model-test-help">Test the current settings here. Save settings to use them in Chat.</p>
		<form id="model-test-form">
			<div>
				<label for="model-test-prompt">Test prompt</label>
				<input id="model-test-prompt" required maxlength="4000" aria-describedby="model-test-help"
						value="Reply with the word Ready." />
			</div>
			<div class="model-actions">
				<button id="model-test-run" type="submit" disabled>Run test</button>
				<button id="model-test-cancel" type="button" hidden>Stop test</button>
			</div>
		</form>
		<p id="model-test-status" role="status"></p>
		<pre id="model-test-reply" aria-label="Test reply" tabindex="0" hidden></pre>
	</section>
`;

async function mountChatModelSettings(container, { readConfig, writeConfig, readKey, writeKey, includeSystemPrompt = true, demo = false } = {}) {
	container.innerHTML = chatModelSettingsMarkup(includeSystemPrompt);
	const get = id => container.querySelector("#" + id);
	function notice(element, message, error = false) {
		if (element.textContent !== message) element.textContent = message;
		element.toggleAttribute("data-error", error);
	}
	const { defaultOllamaPort } = llmClient;
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

	const client = llmClient.create();
	const isBrowser = () => method.value === "browser";
	const ollamaHost = `http://localhost:${defaultOllamaPort}`;
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
			chatProvider: method.value, thinking: thinking.checked,
			...(prompt && { systemprompt: prompt.value }),
			requestTimeoutMs: timeout.valueAsNumber * 1000,
			...(isBrowser() ? localSelection : { apihost: host.value, model: modelID.value.trim() })
		};
		const settings = llmClient.normalizeConfig({ ...config, ...changes });
		const apiKey = isBrowser() ? undefined : llmClient.validateApiKey(settings.apihost, key.value.trim());
		return { changes, settings, apiKey };
	}

	function render() {
		const local = isBrowser();
		const locked = demo || !config || Boolean(operation);
		const hasHost = Boolean(host.value.trim());
		const showSetup = !local && !apiCatalog.connected;
		const title = showSetup ? "Set up Ollama" : "Available models";
		const refreshLabel = showSetup ? "Check connection" : "Refresh list";
		if (modelListTitle.textContent !== title) modelListTitle.textContent = title;
		if (refresh.textContent !== refreshLabel) refresh.textContent = refreshLabel;
		methods.disabled = timeout.disabled = thinking.disabled = locked;
		if (prompt) prompt.disabled = locked;
		apiFields.hidden = refresh.hidden = local;
		apiSelection.hidden = local;
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
		if (demo || !config || operation || localCheck || !isBrowser() || !matchesSavedPair(localSelection)) return;
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
		if (demo) return;
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

	forgetKey.addEventListener("click", async () => {
		try {
			if (await writeKey(llmClient.normalizeConfig({ apihost: host.value }).apihost, "") === false) {
				throw new Error("This browser could not remove the session key.");
			}
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
			config = await writeConfig(changes);
			if (isBrowser()) {
				cancelLocalCheck();
				llmLocal.requestPrimaryRetry(config.chatLocalPrimary, config.chatLocalFallback, { share: true });
			} else {
				host.value = config.apihost;
				modelID.value = config.model;
				try {
					if (await writeKey(config.apihost, apiKey) === false) throw new Error();
				}
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
			const systemPrompt = prompt ? settings.systemprompt : (await readConfig()).systemprompt;
			const { chatLocalPrimary, chatLocalFallback } = settings;
			if (local) llmLocal.requestPrimaryRetry(chatLocalPrimary, chatLocalFallback);
			const { model, message, finishReason } = await client.streamChat({
				...llmClient.requestOptions(settings), apiKey,
				maxTokens: 512,
				messages: [{ role: "system", content: systemPrompt }, { role: "user", content: text }],
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
				const saved = await readConfig().catch(() => null);
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
		const saved = demo ? llmClient.normalizeConfig(llmLocal.defaultConfig) : await readConfig();
		const defaultOnly = saved.apihost === ollamaHost && saved.chatProvider !== "api" && !saved.model.trim();
		host.value = defaultOnly ? "" : saved.apihost;
		key.value = host.value && !demo ? await readKey(host.value) : "";
		modelID.value = saved.model;
		timeout.value = (saved.requestTimeoutMs ?? 120000) / 1000;
		if (prompt) prompt.value = saved.systemprompt;
		thinking.checked = saved.thinking ?? true;
		method.value = saved.chatProvider ?? "api";
		localSelection = llmLocal.localConfig(saved);
		for (const { name, models } of browserGroups) {
			if (!models.some(model => model.id === localSelection[name])) localSelection[name] = llmLocal.defaultConfig[name];
		}
		config = saved;
		notice(saveStatus, demo ? "Create an app to save settings and connect to a model." : "");
		if (demo) {
			renderChoices();
			render();
		} else if (isBrowser()) {
			renderChoices();
			render();
			void checkLocal();
		} else void loadApiModels();
	} catch (error) { notice(saveStatus, error.message || String(error), true); }
}
