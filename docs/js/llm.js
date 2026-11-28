function readLLMApiKey(host) {
    try { const key = JSON.parse(sessionStorage.getItem('webstation.api-keys.v1') || '{}')[host]; return typeof key === 'string' ? key : ''; }
    catch { return ''; }
}

function writeLLMApiKey(host, key) {
    const keys = JSON.parse(sessionStorage.getItem('webstation.api-keys.v1') || '{}');
    if (key) keys[host] = key; else delete keys[host];
    sessionStorage.setItem('webstation.api-keys.v1', JSON.stringify(keys));
}

// Compatibility facade for callers using the original history and tool methods.
function createLLM(options = {}) {
    const defaultSystemPrompt = options.systemPrompt || '';

    // In-memory chat history. Intended to be the only state store for prompts.
    class ChatHistory {
        constructor(systemPrompt) {
            this.systemPrompt = systemPrompt;
            this.messages = [{ role: 'system', content: systemPrompt }];
        }

        reset(systemPrompt = this.systemPrompt) {
            this.systemPrompt = systemPrompt;
            this.messages = [{ role: 'system', content: systemPrompt }];
        }

        setSystemPrompt(systemPrompt) {
            this.systemPrompt = systemPrompt;
            if (this.messages.length > 0) {
                this.messages[0] = { role: 'system', content: systemPrompt };
            } else {
                this.messages = [{ role: 'system', content: systemPrompt }];
            }
        }

        addMessage(message) {
            this.messages.push(message);
        }

        addUser(content) {
            this.messages.push({ role: 'user', content });
        }

        addAssistant(content) {
            this.messages.push({ role: 'assistant', content });
        }

        getMessages() {
            return this.messages;
        }

        setMessages(messages) {
            this.messages = messages;
        }

        length() {
            return this.messages.length;
        }

        last() {
            return this.messages[this.messages.length - 1];
        }

        getLastContent() {
            const last = this.last();
            return last ? last.content : '';
        }

        getLastAssistantContent() {
            for (let i = this.messages.length - 1; i >= 0; i -= 1) {
                if (this.messages[i].role === 'assistant') return this.messages[i].content;
            }
            return '';
        }

        getSecondLastContent() {
            return this.messages.length >= 2 ? this.messages[this.messages.length - 2].content : '';
        }

        chopLastPair() {
            const before = this.messages.length;
            if (this.messages.length > 1) {
                this.messages.pop();
                this.messages.pop();
            }
            return { before, after: this.messages.length };
        }

        truncateLastPair() {
            if (this.messages.length >= 2) {
                this.messages = this.messages.slice(0, -2);
            }
        }

        appendUserEmptyAndAssistant(content) {
            this.messages.push({ role: 'user', content: '' });
            this.messages.push({ role: 'assistant', content });
        }

        buildEmptyPromptState() {
            const transposed = [];
            let promptContent = '';
            if (this.messages.length > 0) {
                transposed.push({ ...this.messages[0] });
            }
            for (let i = 2; i < this.messages.length - 2; i += 2) {
                const assistantm = { ...this.messages[i], role: 'user' };
                const userm = { ...this.messages[i + 1], role: 'assistant' };
                transposed.push(assistantm);
                transposed.push(userm);
                promptContent = assistantm.content;
            }
            return { transposed, promptContent };
        }
    }

    const history = new ChatHistory(defaultSystemPrompt);

    const transport = llmClient.create({
        browserBackend: options.browserBackend,
        systemPrompt: defaultSystemPrompt,
        getMessages: () => history.getMessages(),
        readApiKey: options.readApiKey ?? readLLMApiKey,
        normalizeMessages: globalThis.WorkstationToolRegistry?.normalizeMessages
    });
    let tools;
    const registry = () => tools ??= new WorkstationToolRegistry(options);
    return Object.assign(transport, { history,
        listTools: (...args) => registry().listTools(...args),
        runTool: (...args) => registry().runTool(...args)
    });
}

async function writeLLMConfig(changes) {
    return llmClient.createConfigStore(await window.vfsReady).write(changes);
}

async function readLLMConfig() {
    return llmClient.createConfigStore(await window.vfsReady).read();
}
