"use strict";

// Function tool definitions are public. Handlers and the registry's copies of their schemas stay private.
globalThis.ToolRegistry = class ToolRegistry {
    #tools = new Map();

    register(definition, handler) {
        const name = definition?.function?.name;
        if (definition?.type !== "function" || typeof name !== "string" || !name.trim() || typeof handler !== "function") {
            throw new TypeError("A function tool needs a name and a handler.");
        }
        if (this.#tools.has(name)) throw new Error("Tool already registered: " + name);
        this.#tools.set(name, { definition: structuredClone(definition), handler });
    }

    listTools(descriptions = {}) {
        return Array.from(this.#tools, ([name, tool]) => {
            const definition = structuredClone(tool.definition);
            if (Object.hasOwn(descriptions, name) && typeof descriptions[name] === "string") {
                definition.function.description = descriptions[name];
            }
            return definition;
        });
    }

    async runTool(call, context = {}) {
        const name = call?.function?.name;
        const tool = this.#tools.get(name);
        if (!tool) return "Unsupported tool: " + (name || "unknown");
        const source = call.function.arguments ?? "";
        if (typeof source !== "string") return "Invalid arguments.";
        let args;
        try { args = JSON.parse(source || "{}"); }
        catch { return "Invalid arguments."; }
        if (!args || typeof args !== "object" || Array.isArray(args)) return "Invalid arguments.";
        context.signal?.throwIfAborted();
        return tool.handler(args, context);
    }
};
