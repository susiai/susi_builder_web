(globalThis.document?.currentScript?.susiSource || (run => run.call(globalThis)))(function () { /* susi source */
"use strict";

(() => {
	const demo = document.body.hasAttribute('data-chat-demo');
	const configPanel = document.getElementById('chat-model-settings');
	const get = id => document.getElementById(id);
	const appId = document.body.dataset.appId;
	const client = llmClient.create();

	async function openBasicChat() {
		const projectFiles = window.susi?.files;
		const settingsPath = 'chat-settings.json';
		const bridge = window.susi?.workspace;
		const keyStore = llmClient.createSessionKeyStore(appId ?? new URL('./', document.baseURI).pathname);
		const apiKey = bridge ? (host, value) => value === undefined
			? bridge('readApiKey', [host]) : bridge('writeApiKey', [host, value]) : keyStore;
		if (projectFiles) {
			async function readFile(path) {
				try { return await projectFiles.readFile(path); }
				catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
			}
			// Adapt the preview's versioned file API to the same settings store used by standalone apps.
			const fileStore = {
				async getasync(path) {
					const file = await readFile(path);
					if (!file) throw 'Key not found';
					return file.text();
				},
				async update(path, updater) {
					// The preview bridge uses conditional writes. Reapply the edit to newer settings on conflict.
					for (let attempt = 1; ; attempt++) {
						const file = await readFile(path);
						const source = await file?.text();
						const value = updater(source);
						if (value === source) return value;
						try {
							await projectFiles.writeFile(path, value, { ifUnchanged: file });
							return value;
						} catch (error) {
							if (attempt === 8 || !["EEXIST", "ESTALE"].includes(error.code)) throw error;
						}
					}
				}
			};
			const { read, write } = llmClient.createConfigStore(fileStore, settingsPath);
			return { readConfig: read, writeConfig: write, apiKey };
		}
		const vfs = await window.vfsReady;
		if (!/^\w[\w-]*$/.test(appId ?? '') || !vfs) throw new Error('The app could not open its shared file storage.');
		const { read, write } = llmClient.createConfigStore(vfs, '/.webstation/apps/' + appId + '/' + settingsPath);
		return { readConfig: read, writeConfig: write, apiKey };
	}

	async function configure() {
		const workspace = demo ? {} : document.body.hasAttribute('data-chat-workspace')
			? susiChatApp.open(appId) : await openBasicChat();
		await mountChatModelSettings(configPanel, {
			demo, readConfig: workspace.readConfig, writeConfig: workspace.writeConfig,
			readKey: workspace.apiKey, writeKey: workspace.apiKey
		});
	}

	function report(status, message, error = false) {
		status.textContent = message;
		status.classList.toggle('project-error', error);
	}

	function networkError(error) {
		if (!(error instanceof TypeError)) return error.message;
		return 'Could not reach the model endpoint. Check the URL and its CORS settings.';
	}

	async function chat() {
		const form = get('chat-form'), log = get('chat-log'), input = get('chat-message');
		const send = get('chat-send'), stop = get('chat-stop'), reset = get('chat-new'), status = get('chat-status');
		const modelStatus = get('chat-model-status');
		const workspace = demo ? undefined : await openBasicChat();
		const settings = workspace ? await workspace.readConfig() : {};
		const selectedModel = client.selectModel(settings);
		const inference = selectedModel.options;
		const usesKey = !demo && inference.provider !== 'browser';
		const key = get('chat-api-key');
		get('chat-auth').hidden = !usesKey;
		if (demo) report(modelStatus, 'Template preview · sample replies');
		else {
			const preparation = new AbortController();
			window.addEventListener('pagehide', () => preparation.abort(), { once: true });
			const model = await selectedModel.status({
				signal: preparation.signal,
				onProgress: state => report(modelStatus, state.message || state.label || '')
			});
			if (model.ready) report(modelStatus, [model.label, model.fallbackReason].filter(Boolean).join(' · '));
			else {
				report(modelStatus, (model.message || 'No model active.') + ' ', true);
				const setup = document.createElement('a');
				setup.href = 'config.html';
				setup.textContent = 'Select and save a model in Configuration';
				modelStatus.append(setup, ' to start chatting.');
				return;
			}
			if (usesKey) key.value = await workspace.apiKey(settings.apihost);
		}
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
				if (demo) answer.text.data = 'This is a sample reply. Set a model in the new app to receive real replies.';
				else {
					const apiKey = usesKey ? llmClient.validateApiKey(settings.apihost, key.value.trim()) : undefined;
					if (usesKey) await workspace.apiKey(settings.apihost, apiKey);
					const { message } = await client.streamChat({
						...inference, apiKey, signal: current.signal,
						messages: [{ role: 'system', content: settings.systemprompt }, ...messages, prompt],
						onStatus: stage => report(status, stage),
						onProgress: state => { if (state.message) report(status, state.message); },
						onRestart: () => { answer.text.data = ''; },
						onToken(token) {
							const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
							answer.text.appendData(token);
							if (atEnd) log.scrollTop = log.scrollHeight;
						}
					});
					answer.text.data = message.content;
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

	(configPanel ? configure() : chat()).catch(error => {
		if (error?.name === 'AbortError') return;
		const status = configPanel || get('chat-model-status');
		report(status, 'Could not load settings. ' + (error.message || error), true);
	});
})();

/* end susi source */
});
