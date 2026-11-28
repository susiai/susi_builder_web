"use strict";

// One store per editor. Each read remembers the exact source that editor can replace.
globalThis.ConversationStore = (() => {
	const documentTypes = Object.freeze({
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		pdf: "application/pdf"
	});
	const maxImageURLLength = 140000;

	function conflict() {
		return Object.assign(new Error("This conversation changed in another page."), { code: "EEXIST" });
	}

	// IndexedDB also serializes writers across tabs on HTTP origins without Web Locks.
	function withBrowserWriteLock(key, commit) {
		const locks = globalThis.navigator?.locks;
		if (locks) return locks.request(key, commit);
		return new Promise((resolve, reject) => {
			const open = indexedDB.open("webstation.chat.writes.v1", 1);
			open.onupgradeneeded = () => open.result.createObjectStore("writers");
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				const transaction = db.transaction("writers", "readwrite");
				let failure;
				transaction.oncomplete = resolve;
				transaction.onabort = () => reject(failure || transaction.error);
				// The request callback runs while the transaction owns the store's write lock.
				transaction.objectStore("writers").get(key).onsuccess = () => {
					try { commit(); }
					catch (error) { failure = error; transaction.abort(); }
				};
				db.close();
			};
		});
	}

	function validMessage(item) {
		if (item?.role === "assistant") {
			return (item.content == null || typeof item.content === "string") &&
				(item.tool_calls == null || (Array.isArray(item.tool_calls) && item.tool_calls.every(call =>
					typeof call?.id === "string" && typeof call.function?.name === "string" && typeof call.function.arguments === "string")));
		}
		return (item?.role === "tool" && typeof item.tool_call_id === "string" ||
			item?.role === "function" && typeof item.name === "string") && typeof item.content === "string";
	}

	function validAttachment(file) {
		if (typeof file?.name !== "string" || typeof file.mimeType !== "string") return false;
		if (file.imageUrl !== undefined) {
			return typeof file.imageUrl === "string" && file.imageUrl.length <= maxImageURLLength &&
				file.imageUrl.startsWith("data:" + file.mimeType + ";base64,") &&
				/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(file.imageUrl) &&
				(file.followUpId === undefined || typeof file.followUpId === "string" && /^[a-f0-9]{32}$/.test(file.followUpId));
		}
		return typeof file.text === "string" && (file.mimeType.startsWith("text/") ||
			file.mimeType.startsWith("audio/") || Object.values(documentTypes).includes(file.mimeType));
	}

	function validate(turns) {
		if (!Array.isArray(turns) || turns.some(turn => typeof turn?.prompt !== "string" || !Array.isArray(turn.messages) ||
			!turn.messages.every(validMessage) || turn.draft !== undefined && typeof turn.draft !== "string" ||
			turn.note !== undefined && typeof turn.note !== "string" ||
			turn.attachments !== undefined && (!Array.isArray(turn.attachments) || !turn.attachments.every(validAttachment)))) {
			throw new TypeError("Invalid saved conversation.");
		}
	}

	return class ConversationStore {
		#adapter;
		#versions = new Map();
		#pending = new Map();
		#writes = 0;

		constructor(adapter) { this.#adapter = adapter; }

		static get documentTypes() { return documentTypes; }
		static get maxImageURLLength() { return maxImageURLLength; }

		static forBrowser(storage) {
			const area = () => storage ?? globalThis.localStorage;
			return new ConversationStore({
				read: key => area().getItem(key),
				watch(key, notify) {
					const changed = event => {
						if ((event.key === key || event.key === null) && event.storageArea === area()) notify(area().getItem(key));
					};
					globalThis.addEventListener("storage", changed);
					return () => globalThis.removeEventListener("storage", changed);
				},
				replace(key, expected, text) {
					return withBrowserWriteLock(key, () => {
						const target = area();
						if (target.getItem(key) !== expected) throw conflict();
						if (text !== expected) target.setItem(key, text);
					});
				}
			});
		}

		static forProject(vfs, directory = "/.webstation/conversations/") {
			const path = key => directory.replace(/\/?$/, "/") + encodeURIComponent(key) + ".json";
			return new ConversationStore({
				async read(key) {
					try { return await vfs.getasync(path(key)) ?? null; }
					catch (error) {
						if (error === "Key not found" || error?.code === "ENOENT") return null;
						throw error;
					}
				},
				replace: (key, expected, text) => vfs.update(path(key), current => {
					if ((current ?? null) !== expected) throw conflict();
					return text;
				})
			});
		}

		static scope(config) { return config?.chatProvider === "browser" ? "browser" : config?.apihost; }

		static key(config, project) {
			if (config && project) return "webstation.chat.project.v1:" + JSON.stringify([this.scope(config), project]);
		}

		static settleDraft(turn) {
			if (turn.draft) turn.messages.push({ role: "assistant", content: turn.draft });
			turn.draft = "";
		}

		static export(project, turns) {
			return JSON.stringify({ format: "webstation-conversation", version: 1, project, turns }, null, 2);
		}

		get pending() { return this.#writes > 0; }

		watch(key, listener) {
			return this.#adapter.watch?.(key, source => {
				const version = this.#versions.get(key);
				if (version && version.source !== source) listener();
			});
		}

		// A fresh read after a failed save can reopen the winning version. Other keys run independently.
		#enqueue(key, operation) {
			if (typeof key !== "string" || !key) throw new TypeError("A conversation key is required.");
			const previous = this.#pending.get(key);
			const result = (previous || Promise.resolve()).then(operation, operation).finally(() => {
				if (this.#pending.get(key) === result) this.#pending.delete(key);
			});
			this.#pending.set(key, result);
			return result;
		}

		read(key) {
			return this.#enqueue(key, async () => {
				this.#versions.delete(key);
				const source = await this.#adapter.read(key);
				const version = { source };
				this.#versions.set(key, version);
				const turns = source === null ? [] : JSON.parse(source);
				validate(turns);
				for (const turn of turns) {
					if (turn.state === "streaming") {
						ConversationStore.settleDraft(turn);
						turn.state = "stopped";
						turn.note = "Generation interrupted.";
					}
				}
				version.snapshot = JSON.stringify(turns);
				return turns;
			});
		}

		readLegacy(config) {
			return config?.apihost && config.chatProvider !== "browser" ?
				this.read("webstation.chat.v1:" + config.apihost) : Promise.resolve([]);
		}

		async save(key, turns, { ifChanged = false } = {}) {
			if (!Array.isArray(turns)) throw new TypeError("Expected an array of conversation turns.");
			const text = JSON.stringify(turns);
			// Leaving an untouched conversation must not write a recovered draft over an active stream.
			if (ifChanged && text !== undefined && !this.#pending.has(key) && this.#versions.get(key)?.snapshot === text) return;
			validate(JSON.parse(text));
			return this.#write(key, text, false);
		}

		// Explicitly clearing can replace a malformed record, subject to the same revision check.
		clear(key) { return this.#write(key, "[]", true); }

		async #write(key, text, clear) {
			this.#writes++;
			try {
				await this.#enqueue(key, async () => {
					const version = this.#versions.get(key);
					if (!version) throw new Error("Read the conversation before saving.");
					if (!clear && version.snapshot === undefined) throw new Error("The saved conversation is invalid.");
					await this.#adapter.replace(key, version.source, text);
					this.#versions.set(key, { source: text, snapshot: text });
				});
			} finally { this.#writes--; }
		}
	};
})();
