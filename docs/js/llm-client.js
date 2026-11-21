(globalThis.document?.currentScript?.susiSource || (run => run.call(globalThis)))(function () { /* susi source */
"use strict";

// Shared by the main Chat page and standalone Chat projects.
globalThis.llmClient = (() => {
    function llmRequestLifetime(signal, timeoutMs = 120000) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid request timeout.');
        signal?.throwIfAborted();
        const controller = new AbortController();
        let timer;
        const abort = () => controller.abort(signal.reason);
        const touch = () => {
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(new DOMException('The model endpoint stopped responding.', 'TimeoutError')), timeoutMs);
        };
        signal?.addEventListener('abort', abort, { once: true }); touch();
        return { signal: controller.signal, touch, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
    }

    function isRetiredEndpoint(host) {
        try { return new URL(host).hostname.replace(/\.$/, '') === 'llm.susi.ai'; }
        catch { return false; }
    }

    function llmEndpointKey(host, key) {
        if (isRetiredEndpoint(host)) throw new Error('This model endpoint has been retired. Choose a different endpoint.');
        if (key && key !== '_') {
            const url = new URL(host);
            if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
                throw new Error('API keys require HTTPS, except for a local loopback endpoint.');
            }
        }
        return key;
    }

    async function readLLMJSON(response, onActivity) {
        if (!response.body) return null;
        const reader = response.body.getReader(); const decoder = new TextDecoder();
        const parts = []; let length = 0;
        try {
            while (true) {
                const { value, done } = await reader.read(); if (done) break;
                length += value.byteLength;
                if (length > 4194304) throw new Error('The model response exceeded the 4 MiB limit.');
                onActivity?.(); parts.push(decoder.decode(value, { stream: true }));
            }
            parts.push(decoder.decode()); return JSON.parse(parts.join(''));
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }

    const DEFAULT_OLLAMA_PORT = "11434";
    const DEFAULT_LLM_API_HOST = `http://localhost:${DEFAULT_OLLAMA_PORT}`;
    const DEFAULT_LLM_SYSTEM_PROMPT = "You are not a very talkative chatbot, rather grumpy and terse. " +
        "Unless asked otherwise, respond with just one sentence.";
    const LEGACY_LLM_SYSTEM_PROMPT = "Du bist ein nicht sehr gesprächiger Chatbot, eher mürrisch, wortkarg. " +
        "Wenn nicht gefragt, antworte nur mit einzelnen Sätzen.";

    function normalizeLLMConfig(config) {
        const host = typeof config?.apihost === "string" ? config.apihost.trim() : "";
        const prompt = typeof config?.systemprompt === "string" ? config.systemprompt : DEFAULT_LLM_SYSTEM_PROMPT;
        const endpoint = host.replace(/\/+$/, "").replace(/([^/])\/v1$/, "$1") || DEFAULT_LLM_API_HOST;
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error('Use an HTTP or HTTPS API endpoint without embedded credentials, a query, or a fragment.');
        }
        if (config?.requestTimeoutMs !== undefined && (!Number.isInteger(config.requestTimeoutMs) ||
            config.requestTimeoutMs < 10000 || config.requestTimeoutMs > 600000)) throw new Error('Request timeout must be 10–600 seconds.');
        const provider = config?.chatProvider;
        if (provider !== undefined && provider !== 'api' && provider !== 'browser') {
            throw new Error('Choose API endpoint or Browser model for chat inference.');
        }
        return {
            // The client adds /v1 when it builds the model and chat URLs.
            apihost: endpoint,
            // Translate only the former default, preserving custom prompts and explicitly empty values.
            systemprompt: prompt.trim() === LEGACY_LLM_SYSTEM_PROMPT ? DEFAULT_LLM_SYSTEM_PROMPT : prompt,
            model: typeof config?.model === "string" ? config.model : "",
            // Older configs leave the reasoning setting to the API.
            thinking: typeof config?.thinking === "boolean" ? config.thinking : undefined,
            ...(config?.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
            ...(provider !== undefined ? { chatProvider: provider } : {}),
            ...(typeof config?.chatLocalPrimary === 'string' ? { chatLocalPrimary: config.chatLocalPrimary } : {}),
            ...(typeof config?.chatLocalPrimaryDesktop === 'string' ? { chatLocalPrimaryDesktop: config.chatLocalPrimaryDesktop } : {}),
            ...(typeof config?.chatLocalPrimaryMobile === 'string' ? { chatLocalPrimaryMobile: config.chatLocalPrimaryMobile } : {}),
            ...(typeof config?.chatLocalFallback === 'string' ? { chatLocalFallback: config.chatLocalFallback } : {})
        };
    }

    function parseConfigFile(source, path) {
        const config = JSON.parse(source === undefined ? "{}" : source);
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            throw new Error(`${path.split("/").at(-1)} must contain a JSON object.`);
        }
        return config;
    }

    function normalizeWorkspaceLLMConfig(current, changes = {}) {
        if (globalThis.llmLocal && Object.hasOwn(changes, "chatLocalPrimary")) {
            // Models saves the primary shown on this device.
            const { chatLocalPrimary, ...settings } = changes;
            changes = { [llmLocal.primaryConfigKey]: chatLocalPrimary, ...settings };
        }
        const updated = { ...current, ...changes };
        if (isRetiredEndpoint(updated.apihost)) {
            Object.assign(updated, { apihost: "", model: "", chatProvider: globalThis.llmLocal ? "browser" : "api" });
        }
        const config = normalizeLLMConfig(updated);
        if (!globalThis.llmLocal) return { ...current, ...config };

        const { chatLocalModel, chatLocalDevice } = updated;
        // Older workspaces with no selected model can use the same first-run setup.
        if (!config.chatProvider && !config.model.trim() && config.apihost === DEFAULT_LLM_API_HOST) {
            config.chatProvider = llmLocal.defaultConfig.chatProvider;
            config.thinking = llmLocal.defaultConfig.thinking;
        }
        const saved = { ...current, ...config };
        const { chatLocalPrimary, chatLocalFallback } = config;
        const hasLegacyPrimary = chatLocalPrimary !== undefined || chatLocalModel !== undefined;
        if (config.chatProvider === "browser" || hasLegacyPrimary || chatLocalDevice !== undefined) {
            const legacy = llmLocal.localConfig({ chatLocalModel, chatLocalPrimary, chatLocalFallback });
            saved.chatLocalFallback = legacy.chatLocalFallback;
            if (hasLegacyPrimary) {
                saved.chatLocalPrimaryDesktop = config.chatLocalPrimaryDesktop ?? legacy.chatLocalPrimary;
                saved.chatLocalPrimaryMobile = config.chatLocalPrimaryMobile ?? legacy.chatLocalPrimary;
            }
        }
        delete saved.chatLocalPrimary;
        delete saved.chatLocalModel;
        delete saved.chatLocalDevice;
        return saved;
    }

    function createConfigStore(vfs, path) {
        function resolveConfig(saved) {
            const config = normalizeLLMConfig(saved);
            if (globalThis.llmLocal && config.chatProvider === "browser") {
                Object.assign(config, llmLocal.localConfig(config));
            }
            return config;
        }

        function update(changes, validate) {
            return vfs.update(path, source => {
                const current = parseConfigFile(source, path);
                const next = normalizeWorkspaceLLMConfig(current, changes);
                if (validate && globalThis.llmLocal && next.chatProvider === "browser") {
                    const { chatLocalPrimary, chatLocalFallback } = resolveConfig(next);
                    llmLocal.modelPair(chatLocalPrimary, chatLocalFallback);
                }
                return JSON.stringify(next, null, 2);
            });
        }

        return {
            async read() {
                let source;
                try { source = await vfs.getasync(path); }
                catch (error) { if (error !== "Key not found") throw error; }
                const current = parseConfigFile(source, path);
                const config = normalizeWorkspaceLLMConfig(current);
                if (Object.keys(config).some(key => current[key] !== config[key]) ||
                    Object.keys(current).some(key => !Object.hasOwn(config, key))) {
                    // Normalize the latest settings atomically, retaining unrelated configuration sections.
                    return resolveConfig(JSON.parse(await update()));
                }
                return resolveConfig(config);
            },
            async write(changes) {
                return resolveConfig(JSON.parse(await update(changes, true)));
            }
        };
    }

    function createSessionKeyStore(scope, fallback) {
        return (host, value) => {
            if (typeof host !== "string" || (value !== undefined && typeof value !== "string")) {
                throw new Error("Invalid model credentials.");
            }
            const key = "project-chat.key:" + JSON.stringify([scope, host]);
            if (value === undefined) {
                if (fallback?.has(key)) return fallback.get(key);
                try { return sessionStorage.getItem(key) || ""; } catch { return ""; }
            }
            try {
                if (value) sessionStorage.setItem(key, value);
                else sessionStorage.removeItem(key);
                fallback?.delete(key);
                return true;
            } catch {
                fallback?.set(key, value);
                return Boolean(fallback);
            }
        };
    }

    function renderModelProgress(container, state) {
        const message = state?.message;
        container.hidden = !message;
        if (!message) return;
        const status = container.querySelector("[role=status]");
        if (status.textContent !== message) status.textContent = message;
        const progress = container.querySelector("progress");
        if (state.total > 0) {
            progress.max = state.total;
            progress.value = state.loaded;
        } else progress.removeAttribute("value");
    }

    function requestOptions(config) {
        const settings = { thinking: config.thinking, timeoutMs: config.requestTimeoutMs };
        return config.chatProvider === 'browser'
            ? { ...settings, provider: 'browser', model: config.chatLocalPrimary, fallbackModel: config.chatLocalFallback }
            : { ...settings, baseUrl: config.apihost, model: config.model };
    }

    function supportsImages(options) {
        return options.provider !== 'browser' || globalThis.llmLocal?.supportsImages?.(options) === true;
    }

    async function inlineBrowserImages(messages, { signal, timeoutMs }) {
        if (!Array.isArray(messages)) return messages;
        const images = new Map();
        async function load(url) {
            const address = new URL(url);
            if (address.username || address.password) throw new Error('Image URLs must omit embedded credentials.');
            const request = llmRequestLifetime(signal, timeoutMs);
            try {
                // Read in the caller's origin so sandboxed apps retain their existing network permissions.
                const response = await fetch(address, {
                    signal: request.signal, credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer'
                });
                const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
                if (!response.ok || !response.body || !/^image\/(png|jpeg|webp|gif)$/.test(type)) {
                    await response.body?.cancel();
                    throw new Error('The image URL must return a PNG, JPEG, WebP, or GIF image.');
                }
                let bytes = 0;
                const body = response.body.pipeThrough(new TransformStream({
                    transform(chunk, controller) {
                        bytes += chunk.byteLength;
                        if (bytes > 1500000) throw new Error('Remote browser images are limited to 1.5 MB.');
                        request.touch();
                        controller.enqueue(chunk);
                    }
                }));
                const blob = await new Response(body, { headers: { 'Content-Type': type } }).blob();
                const dataURL = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(blob);
                });
                request.signal.throwIfAborted();
                return dataURL;
            } catch (error) {
                if (request.signal.aborted) throw request.signal.reason;
                if (error instanceof TypeError) throw new Error('Could not load the image URL. Check that the site allows browser access (CORS).', { cause: error });
                throw error;
            } finally { request.dispose(); }
        }
        return Promise.all(messages.map(async message => {
            if (message?.role !== 'user' || !Array.isArray(message.content)) return message;
            const content = await Promise.all(message.content.map(async part => {
                const url = part?.image_url?.url;
                if (part?.type !== 'image_url' || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return part;
                if (!images.has(url)) images.set(url, load(url));
                return { ...part, image_url: { ...part.image_url, url: await images.get(url) } };
            }));
            return { ...message, content };
        }));
    }

    function create({ systemPrompt: defaultSystemPrompt = "", getMessages = () => [],
        normalizeMessages = messages => messages, readApiKey = () => "", browserBackend = globalThis.llmLocal } = {}) {
        async function modelStatus(options = {}, preparation) {
            if (options.provider === 'browser') return browserBackend
                ? browserBackend.status(options, preparation)
                : { ready: false, label: '', message: 'Browser inference is unavailable on this page.' };
            const label = options.model?.trim() || '';
            return { ready: Boolean(label), label, message: '' };
        }

        async function generateInBrowser(options, stream) {
            if (!browserBackend) throw new Error('Browser inference is unavailable on this page.');
            const startedAt = performance.now();
            // The browser backend times downloads and each device attempt independently.
            options.signal?.throwIfAborted();
            let firstTokenAt = 0;
            try {
                const messages = normalizeMessages(options.messages || getMessages());
                const { model = options.model, message, finishReason, promptTokens, completionTokens } = await browserBackend.generate({
                    model: options.model, fallbackModel: options.fallbackModel, device: options.device, thinking: options.thinking, stream,
                    maxTokens: options.maxTokens, temperature: options.temperature, stopTokens: options.stopTokens,
                    tools: options.tools, toolChoice: options.toolChoice, timeoutMs: options.timeoutMs,
                    messages: browserBackend.supportsImages?.(options) ? await inlineBrowserImages(messages, options) : messages,
                    signal: options.signal,
                    onStatus: options.onStatus, onProgress: options.onProgress,
                    onRestart: options.onRestart && (() => { firstTokenAt = 0; options.onRestart(); }),
                    onToken(text) {
                        if (!firstTokenAt) firstTokenAt = performance.now();
                        options.onToken?.(text);
                    }
                });
                options.signal?.throwIfAborted();
                if (!stream) return {
                    model,
                    choices: [{ index: 0, message, finish_reason: finishReason }],
                    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens,
                        total_tokens: promptTokens + completionTokens }
                };
                const result = { model, message, finishReason, tokenCount: completionTokens, startedAt,
                    firstTokenAt, endedAt: performance.now() };
                options.onDone?.(result);
                return result;
            } catch (error) {
                const failure = options.signal?.aborted ? options.signal.reason : error;
                if (stream && !options.signal?.aborted) options.onError?.(failure.message);
                throw failure;
            }
        }

        // Build /v1/chat/completions payload from history + overrides.
        const buildChatPayload = (options = {}) => {
            const model = options.model;
            const messages = normalizeMessages(options.messages || getMessages());
            if (!model) {
                throw new Error('Missing model');
            }
            const payload = {
                model: model,
                messages: messages,
                stream: options.stream !== false
            };
            const maxTokens = options.maxTokens;
            const temperature = options.temperature;
            const stopTokens = Array.isArray(options.stopTokens) ? options.stopTokens : null;
            const tools = Array.isArray(options.tools) ? options.tools : null;
            const toolChoice = options.toolChoice;
            if (model && (model.startsWith('o4') || model.startsWith('gpt-4.1'))) {
                if (typeof maxTokens === 'number') payload.max_completion_tokens = maxTokens;
            } else {
                if (typeof maxTokens === 'number') payload.max_tokens = maxTokens;
                if (typeof temperature === 'number') payload.temperature = temperature;
                if (stopTokens && stopTokens.length) payload.stop = stopTokens;
            }
            if (tools && tools.length) payload.tools = tools;
            if (toolChoice) payload.tool_choice = toolChoice;
            if (options.thinking === false) {
                payload.enable_thinking = false;
                payload.reasoning_effort = 'none';
            }
            return payload;
        };

        const buildHeaders = (apiKey, hasJsonBody = true) => {
            const headers = hasJsonBody ? { 'Content-Type': 'application/json' } : {};
            if (apiKey && apiKey !== '' && apiKey !== '_') {
                headers.Authorization = 'Bearer ' + apiKey;
            }
            return headers;
        };

        const requestChat = async (options) => {
            if (!options.baseUrl) {
                throw new Error('Missing baseUrl');
            }
            const payload = buildChatPayload(options);
            const lifetime = llmRequestLifetime(options.signal, options.timeoutMs);
            try {
                const response = await fetch(options.baseUrl + '/v1/chat/completions', {
                    method: 'POST',
                    headers: buildHeaders(llmEndpointKey(options.baseUrl, options.apiKey ?? readApiKey(options.baseUrl))),
                    body: JSON.stringify(payload),
                    signal: lifetime.signal
                });
                if (!response.ok) {
                    const data = await readLLMJSON(response, lifetime.touch).catch(() => null);
                    throw new Error(data?.error?.message || 'HTTP ' + response.status);
                }
                return { response, ...lifetime };
            } catch (error) { lifetime.dispose(); throw lifetime.signal.aborted ? lifetime.signal.reason : error; }
        };

        // Decode complete SSE events even when a response splits a line across chunks.
        async function* readChatEvents(body, onActivity) {
            const reader = body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let data = [];
            let eventCharacters = 0;
            let wireBytes = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    wireBytes += value?.byteLength || 0;
                    if (wireBytes > 16777216) throw new Error('The model stream exceeded the 16 MiB transport limit.');
                    if (value?.byteLength) onActivity?.();
                    buffer += decoder.decode(value, { stream: !done });
                    if (buffer.length > 4194304) throw new Error('The model stream exceeded the 4-million-character event limit.');
                    for (let end = buffer.match(/\r\n?|\n/); end; end = buffer.match(/\r\n?|\n/)) {
                        const nextIndex = end.index + end[0].length;
                        if (!done && end[0] === '\r' && nextIndex === buffer.length) break;
                        const line = buffer.slice(0, end.index);
                        buffer = buffer.slice(nextIndex);
                        if (line.startsWith('data:')) {
                            const part = line.slice(5).replace(/^ /, '');
                            eventCharacters += part.length + 1;
                            if (eventCharacters > 4194304) throw new Error('The model stream exceeded the 4-million-character event limit.');
                            data.push(part);
                        } else if (!line && data.length) {
                            const event = data.join('\n');
                            data = [];
                            eventCharacters = 0;
                            yield event;
                        }
                    }
                    if (done) return;
                }
            } finally {
                // Also closes the response when a [DONE] event arrives before EOF.
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        }

        const streamChat = async (options = {}) => {
            if (options.provider === 'browser') return generateInBrowser(options, true);
            const startedAt = performance.now();
            let tokenCount = 0;
            let firstTokenAt = 0;
            let content = '';
            let finishReason;
            let responseCharacters = 0;
            const calls = new Map();
            const request = await requestChat({ ...options, stream: true });
            const response = request.response;

            const addDelta = (delta) => {
                if (!delta || typeof delta !== 'object' || (delta.content != null && typeof delta.content !== 'string') ||
                    (delta.tool_calls != null && !Array.isArray(delta.tool_calls))) throw new Error('The model returned an invalid message delta.');
                responseCharacters += (delta.content?.length || 0) + JSON.stringify(delta.tool_calls || []).length;
                if (responseCharacters > 4194304) throw new Error('The model response exceeded the 4-million-character limit.');
                if (delta.content) {
                    if (!firstTokenAt) firstTokenAt = performance.now();
                    tokenCount += 1;
                    content += delta.content;
                    options.onToken?.(delta.content);
                }
                for (const [position, part] of (delta.tool_calls || []).entries()) {
                    if (!part || typeof part !== 'object') throw new Error('The model returned an invalid tool-call delta.');
                    const index = part.index ?? position;
                    if (!Number.isSafeInteger(index) || index < 0 || index >= 256 ||
                        (part.id !== undefined && (typeof part.id !== 'string' || part.id.length > 200)) ||
                        (part.function?.name !== undefined && typeof part.function.name !== 'string') ||
                        (part.function?.arguments !== undefined && typeof part.function.arguments !== 'string')) {
                        throw new Error('The model returned an invalid tool-call delta.');
                    }
                    const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (part.id) call.id = part.id;
                    call.function.name += part.function?.name || '';
                    call.function.arguments += part.function?.arguments || '';
                    if (call.function.name.length > 128) throw new Error('The model returned an invalid tool name.');
                    calls.set(index, call);
                }
            };

            try {
                if (response.headers.get('content-type')?.includes('application/json')) {
                    const data = await readLLMJSON(response, request.touch);
                    if (data?.error) throw new Error(data.error.message || String(data.error));
                    const choice = data?.choices?.[0];
                    if (!choice?.message) throw new Error('The model returned no message.');
                    addDelta(choice.message);
                    finishReason = choice.finish_reason;
                } else {
                    if (!response.body) throw new Error('Missing response stream.');
                    let sawDone = false;
                    for await (const event of readChatEvents(response.body, request.touch)) {
                        if (event.trim() === '[DONE]') {
                            sawDone = true;
                            break;
                        }
                        const data = JSON.parse(event);
                        if (data?.error) throw new Error(data.error.message || String(data.error));
                        const choice = data?.choices?.[0];
                        if (choice?.delta) addDelta(choice.delta);
                        if (choice?.finish_reason) finishReason = choice.finish_reason;
                    }
                    if (!sawDone && !finishReason) throw new Error('The response stream was interrupted.');
                }

                const message = { role: 'assistant', content };
                if (calls.size) {
                    message.tool_calls = Array.from(calls.keys()).sort((a, b) => a - b).map((index) => calls.get(index));
                    if (message.tool_calls.some((call) => !call.id || !call.function.name)) {
                        throw new Error('The model returned an incomplete tool call.');
                    }
                }
                const result = { message, finishReason, tokenCount, startedAt, firstTokenAt, endedAt: performance.now() };
                options.onDone?.(result);
                return result;
            } catch (error) {
                const failure = request.signal.aborted ? request.signal.reason : error;
                if (!options.signal?.aborted) options.onError?.(failure.message);
                throw failure;
            } finally {
                request.dispose();
            }
        };

        const completeChat = async (options = {}) => {
            if (options.provider === 'browser') return generateInBrowser(options, false);
            const request = await requestChat({ ...options, stream: false });
            try { return await readLLMJSON(request.response, request.touch); }
            catch (error) { throw request.signal.aborted ? request.signal.reason : error; }
            finally { request.dispose(); }
        };

        // Lightweight model warmup; returns answer + token usage.
        const warmup = async (options = {}) => {
            const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : defaultSystemPrompt;
            const messages = [{ role: 'system', content: systemPrompt }];
            const data = await completeChat({
                ...options,
                messages
            });
            const answer = data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content
                : '';
            const usage = data.usage || {};
            return {
                answer,
                completion_tokens: usage.completion_tokens || 0,
                prompt_tokens: usage.prompt_tokens || 0,
                total_tokens: usage.total_tokens || 0
            };
        };

        async function requestJSON(path, options, body) {
            if (!options.baseUrl) throw new Error('Missing baseUrl');
            const lifetime = llmRequestLifetime(options.signal, options.timeoutMs ?? 30000);
            try {
                const response = await fetch(options.baseUrl + path, { method: body === undefined ? 'GET' : 'POST',
                    headers: buildHeaders(llmEndpointKey(options.baseUrl, options.apiKey ?? readApiKey(options.baseUrl)), body !== undefined),
                    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: lifetime.signal });
                const data = await readLLMJSON(response, lifetime.touch).catch(error => {
                    if (response.ok) throw error;
                    return null;
                });
                if (!response.ok) throw Object.assign(new Error(data?.error?.message || 'HTTP ' + response.status), { status: response.status });
                if (data === null) throw new Error('The model endpoint returned invalid JSON.');
                return data;
            } catch (error) { throw lifetime.signal.aborted ? lifetime.signal.reason : error; }
            finally { lifetime.dispose(); }
        }

        // Provider operations use the same credential scope, cancellation, and response deadline.
        const llamaCppLoadModel = (options = {}) => requestJSON('/models/load', options, { model: options.model });
        const listModels = (options = {}) => requestJSON('/v1/models', options);
        const ollamaPull = async (options = {}) => {
            try { return await requestJSON('/api/pull', options, { model: options.model, stream: false }); }
            catch (error) {
                if (options.signal?.aborted || ![404, 405].includes(error.status)) throw error;
                return llamaCppLoadModel(options);
            }
        };
        const ollamaDelete = (options = {}) => requestJSON('/api/delete', options, { model: options.model });

        // Public API surface (single object for easy embedding).
        return {
            buildChatPayload,
            modelStatus,
            streamChat,
            completeChat,
            warmup,
            listModels,
            llamaCppLoadModel,
            ollamaPull,
            ollamaDelete
        };
    }

    return { create, requestOptions, supportsImages, normalizeConfig: normalizeLLMConfig, createConfigStore, parseConfigFile,
        createSessionKeyStore, renderModelProgress,
        validateApiKey: llmEndpointKey, isRetiredEndpoint, defaultOllamaPort: DEFAULT_OLLAMA_PORT };
})();

/* end susi source */
});
