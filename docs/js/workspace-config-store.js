"use strict";

// The adapter supplies getasync(path) and atomic update(path, transform), returning the committed text.
globalThis.WorkspaceConfigStore = class WorkspaceConfigStore {
    #storage;
    #path;

    static get defaultPath() { return "/config.json"; }

    constructor(storage, path = WorkspaceConfigStore.defaultPath) {
        this.#storage = storage;
        this.#path = path;
    }

    static parse(source, path = WorkspaceConfigStore.defaultPath) {
        if (source === undefined) return {};
        const config = JSON.parse(source);
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            throw new TypeError(`${path.split("/").at(-1)} must contain a JSON object.`);
        }
        return config;
    }

    async read() {
        let source;
        try { source = await this.#storage.getasync(this.#path); }
        catch (error) {
            if (error !== "Key not found" && error?.code !== "ENOENT") throw error;
        }
        return WorkspaceConfigStore.parse(source, this.#path);
    }

    // Each invocation receives the latest document. Return an object to save, or undefined to keep its text.
    async update(transform) {
        const source = await this.updateFromSource(current => transform(WorkspaceConfigStore.parse(current, this.#path)));
        return WorkspaceConfigStore.parse(source, this.#path);
    }

    // Text editors can compare the original source and repair it atomically. Return the exact committed text.
    updateFromSource(transform) {
        return this.#storage.update(this.#path, source => {
            const next = transform(source);
            if (next === undefined) return source === undefined ? "{}" : source;
            if (typeof next?.then === "function") throw new TypeError("Configuration updates must be synchronous.");
            const text = JSON.stringify(next, null, 2);
            if (!text?.startsWith("{")) throw new TypeError(`${this.#path.split("/").at(-1)} must contain a JSON object.`);
            return text;
        });
    }
};
