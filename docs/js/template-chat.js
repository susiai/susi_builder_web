(globalThis.document?.currentScript?.susiSource || (run => run.call(globalThis)))(function () { /* susi source */
"use strict";

(() => {
	const preview = document.body.hasAttribute('data-chat-demo');
	const projectFiles = window.susi?.files;
	const settingsPath = 'chat-settings.json';
	const project = new URL('./', document.baseURI).pathname;
	const appId = document.body.dataset.appId;
	const standalonePath = /^\w[\w-]*$/.test(appId ?? '') && appId
		? '/.webstation/apps/' + appId + '/' + settingsPath : null;
	const defaults = llmClient.normalizeConfig({ thinking: true, requestTimeoutMs: 120000 });
	const client = llmClient.create();
	const get = id => document.getElementById(id);
	const configForm = get('chat-config-form');
	const workspace = !preview && configForm && document.body.hasAttribute('data-chat-workspace')
		? susiChatApp.open(appId) : null;
	let settingsFile = null;
	let standaloneSource;

	async function readSettings() {
		if (preview) return defaults;
		if (workspace) {
			const saved = await workspace.readConfig();
			return { ...defaults, ...saved, thinking: saved.thinking ?? defaults.thinking };
		}
		let saved;
		if (projectFiles) {
			try {
				settingsFile = await projectFiles.readFile(settingsPath);
				saved = JSON.parse(await settingsFile.text());
				if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
					throw new Error('chat-settings.json must contain a JSON object.');
				}
			} catch (error) {
				if (error.code !== 'ENOENT') throw error;
			}
		} else {
			const vfs = await window.vfsReady;
			if (!standalonePath || !vfs) throw new Error('The app could not open its shared file storage.');
			try {
				standaloneSource = await vfs.getasync(standalonePath);
				saved = JSON.parse(standaloneSource);
				if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
					throw new Error('chat-settings.json must contain a JSON object.');
				}
			} catch (error) { if (error !== 'Key not found') throw error; }
		}
		return llmClient.normalizeConfig({ ...defaults, ...saved });
	}

	async function saveSettings(settings) {
		if (workspace) return workspace.writeConfig(settings);
		const value = JSON.stringify(settings, null, 2) + '\n';
		if (projectFiles) {
			settingsFile = await projectFiles.writeFile(settingsPath, value, { ifUnchanged: settingsFile });
		} else {
			const vfs = await window.vfsReady;
			standaloneSource = await vfs.update(standalonePath, previous => {
				if (previous !== standaloneSource) {
					throw Object.assign(new Error('Settings changed in another tab.'), { code: 'EEXIST' });
				}
				return value;
			});
		}
	}

	function sessionKey(host, value) {
		if (workspace) return workspace.apiKey(host, value);
		const key = 'project-chat.key:' + JSON.stringify([appId ?? project, host]);
		// The sandbox can deny sessionStorage. Password fields still work for the current page.
		try {
			if (value === undefined) return sessionStorage.getItem(key) || '';
			if (value) sessionStorage.setItem(key, value);
			else sessionStorage.removeItem(key);
			return true;
		} catch { return value === undefined ? '' : false; }
	}

	function report(status, message, error = false) {
		status.textContent = message;
		status.classList.toggle('project-error', error);
	}

	function networkError(error) {
		if (!(error instanceof TypeError)) return error.message;
		return 'Could not reach the model endpoint. Check the URL and its CORS settings.';
	}

	async function configure() {
		const fieldset = configForm.querySelector('fieldset');
		const host = get('chat-host'), model = get('chat-model'), key = get('chat-api-key');
		const prompt = get('chat-prompt'), timeout = get('chat-timeout'), thinking = get('chat-thinking');
		const models = get('chat-models'), fetchModels = get('chat-fetch-models'), status = get('chat-config-status');
		const initial = await readSettings();
		host.value = initial.apihost;
		model.value = initial.model;
		prompt.value = initial.systemprompt;
		timeout.value = initial.requestTimeoutMs / 1000;
		thinking.checked = initial.thinking;
		if (preview) {
			report(status, 'Create an app to save settings and connect to a model.');
			return;
		}
		key.value = await sessionKey(initial.apihost);
		if (projectFiles && !workspace) get('chat-key-help').textContent = 'Use the key to fetch models here. Enter it again in Chat.';
		report(status, '');
		fieldset.disabled = fetchModels.disabled = false;
		let request;

		function clearModels() {
			models.replaceChildren(new Option('Fetch available models first', ''));
			models.disabled = true;
		}
		host.addEventListener('input', () => {
			request?.abort();
			key.value = '';
			clearModels();
			report(status, '');
		});
		models.addEventListener('change', () => { if (models.value) model.value = models.value; });
		fetchModels.addEventListener('click', async () => {
			if (!host.reportValidity() || !timeout.reportValidity()) return;
			request?.abort();
			const current = request = new AbortController();
			clearModels();
			report(status, 'Loading models…');
			try {
				const { apihost, requestTimeoutMs } = llmClient.normalizeConfig({
					apihost: host.value, requestTimeoutMs: timeout.valueAsNumber * 1000
				});
				const apiKey = llmClient.validateApiKey(apihost, key.value.trim());
				const list = await client.listModels({ baseUrl: apihost, apiKey, timeoutMs: requestTimeoutMs, signal: current.signal });
				if (current.signal.aborted) return;
				const items = list?.data ?? list?.models ?? list;
				const ids = new Set((Array.isArray(items) ? items : []).map(item => item?.id ?? item?.name)
					.filter(id => typeof id === 'string' && id.trim()));
				models.replaceChildren(new Option(ids.size ? 'Choose a model' : 'No models reported', ''));
				for (const id of ids) models.add(new Option(id, id));
				if (ids.has(model.value)) models.value = model.value;
				models.disabled = !ids.size;
				report(status, ids.size ? `${ids.size} models available.` : 'No models reported. You can enter a model ID manually.');
			} catch (error) {
				if (!current.signal.aborted) report(status, networkError(error), true);
			}
		});

		configForm.addEventListener('submit', async event => {
			event.preventDefault();
			if (fieldset.disabled) return;
			request?.abort();
			fieldset.disabled = fetchModels.disabled = true;
			try {
				const settings = llmClient.normalizeConfig({
					chatProvider: 'api', apihost: host.value, model: model.value.trim(), systemprompt: prompt.value,
					thinking: thinking.checked, requestTimeoutMs: timeout.valueAsNumber * 1000
				});
				if (!settings.model) throw new Error('Enter a model ID.');
				const apiKey = llmClient.validateApiKey(settings.apihost, key.value.trim());
				await saveSettings(settings);
				const keptKey = await sessionKey(settings.apihost, apiKey);
				host.value = settings.apihost;
				model.value = settings.model;
				const keyNotice = workspace ? 'This browser could not keep the API key in this tab.' : 'Enter the API key again in Chat.';
				report(status, apiKey && !keptKey ? `Settings saved. ${keyNotice}` : 'Settings saved.');
			} catch (error) {
				report(status, error.code === 'EEXIST' ? 'Settings changed in another tab. Reload before saving again.' : error.message, true);
			} finally { fieldset.disabled = fetchModels.disabled = false; }
		});
		window.addEventListener('pagehide', () => request?.abort());
	}

	async function chat() {
		const form = get('chat-form'), log = get('chat-log'), input = get('chat-message');
		const send = get('chat-send'), stop = get('chat-stop'), reset = get('chat-new'), status = get('chat-status');
		const settings = await readSettings();
		const inference = llmClient.requestOptions(settings);
		const model = preview ? undefined : await client.modelStatus(inference);
		const modelStatus = get('chat-model-status');
		if (preview) report(modelStatus, 'Template preview · sample replies');
		else if (model.ready) report(modelStatus, model.label);
		else {
			report(modelStatus, (model.message || 'No model active.') + ' ', true);
			const setup = document.createElement('a');
			setup.href = 'config.html';
			setup.textContent = 'Select and save a model in Configuration';
			modelStatus.append(setup, ' to start chatting.');
			return;
		}
		const key = get('chat-api-key');
		const usesKey = !preview && inference.provider !== 'browser';
		get('chat-auth').hidden = !usesKey;
		if (usesKey) key.value = sessionKey(settings.apihost);
		const messages = [];
		let active;
		send.disabled = false;

		function addMessage(role, content) {
			const article = document.createElement('article');
			article.dataset.role = role;
			const name = document.createElement('h3');
			name.textContent = role === 'user' ? 'You' : 'Assistant';
			const text = document.createTextNode(content);
			const body = document.createElement('p');
			body.append(text);
			article.append(name, body);
			log.append(article);
			return { article, text };
		}

		form.addEventListener('submit', async event => {
			event.preventDefault();
			const content = input.value.trim();
			if (!content || active) return;
			const user = addMessage('user', content);
			const answer = addMessage('assistant', '');
			input.value = '';
			log.scrollTop = log.scrollHeight;
			const current = active = new AbortController();
			send.disabled = reset.disabled = true;
			stop.hidden = false;
			report(status, 'Waiting for a reply…');
			try {
				const prompt = { role: 'user', content };
				if (preview) answer.text.data = 'This is a sample reply. Set a model in the new app to receive real replies.';
				else {
					const apiKey = usesKey ? llmClient.validateApiKey(settings.apihost, key.value.trim()) : undefined;
					if (usesKey) sessionKey(settings.apihost, apiKey);
					await client.streamChat({
						...inference, apiKey, signal: current.signal,
						messages: [{ role: 'system', content: settings.systemprompt }, ...messages, prompt],
						onStatus: stage => report(status, stage),
						onToken(token) {
							const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
							answer.text.appendData(token);
							if (atEnd) log.scrollTop = log.scrollHeight;
						}
					});
				}
				if (!answer.text.data.trim()) throw new Error('The model returned no text.');
				messages.push(prompt, { role: 'assistant', content: answer.text.data });
				report(status, 'Reply received.');
			} catch (error) {
				user.article.remove();
				answer.article.remove();
				if (!input.value) input.value = content;
				report(status, current.signal.aborted ? 'Reply stopped.' :
					usesKey ? networkError(error) : error.message, !current.signal.aborted);
			} finally {
				active = undefined;
				send.disabled = false;
				reset.disabled = !messages.length;
				stop.hidden = true;
			}
		});
		stop.addEventListener('click', () => active?.abort());
		reset.addEventListener('click', () => {
			messages.length = 0;
			log.replaceChildren();
			input.value = '';
			reset.disabled = true;
			report(status, '');
			input.focus();
		});
		window.addEventListener('pagehide', () => active?.abort());
	}

	(configForm ? configure() : chat()).catch(error => {
		report(get(configForm ? 'chat-config-status' : 'chat-model-status'), 'Could not load settings. ' + error.message, true);
	});
})();

/* end susi source */
});
