"use strict";

const { susiMcpClient, susiMcp } = (() => {
	// MCP tools over Streamable HTTP.
	const modern = "2026-07-28";
	const legacy = ["2025-11-25", "2025-06-18", "2025-03-26"];
	const identity = { name: "susi", version: "0.3.0" };
	const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

	function endpoint(value) {
		let url;
		try { url = new URL(value); } catch { throw new Error("Enter the full HTTP or HTTPS MCP endpoint."); }
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
			throw new Error("Use an HTTP or HTTPS endpoint without embedded credentials or a fragment.");
		}
		return url.href;
	}

	// Modern MCP can mirror schema-declared primitive arguments into namespaced HTTP headers.
	function parameterHeaders(schema, args) {
		const headers = new Headers();
		const names = new Set();
		function visit(node, path) {
			if (!isObject(node)) return;
			if (Object.hasOwn(node, "x-mcp-header")) {
				const name = node["x-mcp-header"];
				if (!path?.length || typeof name !== "string" || !/^[!#$%&'*+.^_\x60|~a-zA-Z0-9-]+$/.test(name) ||
					names.has(name.toLowerCase()) || !["string", "integer", "boolean"].includes(node.type)) {
					throw new Error("Invalid or duplicate x-mcp-header annotation.");
				}
				names.add(name.toLowerCase());
				let value = args;
				for (const key of path) value = isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
				if (value !== undefined) {
					if (node.type === "integer" ? !Number.isSafeInteger(value) : typeof value !== node.type) {
						throw new Error("Invalid value for MCP header parameter " + path.join(".") + ".");
					}
					headers.set("Mcp-Param-" + name, headerValue(String(value)));
				}
			}
			for (const [key, child] of Object.entries(node)) {
				if (key === "properties" && isObject(child)) {
					for (const [name, property] of Object.entries(child)) visit(property, path && [...path, name]);
				} else if (["$defs", "definitions", "patternProperties", "dependentSchemas"].includes(key) && isObject(child)) {
					Object.values(child).forEach(part => visit(part, null));
				} else if (["allOf", "anyOf", "oneOf", "prefixItems", "items", "if", "then", "else", "not", "contains",
					"additionalProperties", "unevaluatedProperties", "propertyNames", "unevaluatedItems"].includes(key)) {
					for (const part of Array.isArray(child) ? child : [child]) visit(part, null);
				}
			}
		}
		visit(schema, []);
		return headers;
	}

	function headerValue(value) {
		if (/^[\x20-\x7e]*$/.test(value) && value === value.trim() &&
			!(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
		return "=?base64?" + btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join("")) + "?=";
	}

	async function responseMessage(response, id) {
		const stream = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() === "text/event-stream";
		const reader = response.body?.getReader();
		if (!reader) throw new Error("The MCP server returned an empty response.");
		const decoder = new TextDecoder();
		let buffer = "", event = "", lines = [];
		const matches = message => message?.jsonrpc === "2.0" && message.id === id &&
			!Object.hasOwn(message, "method") && (Object.hasOwn(message, "result") || isObject(message.error));
		try {
			let size = 0;
			while (true) {
				const { done, value } = await reader.read();
				size += value?.byteLength || 0;
				if (size > 16 * 1024 * 1024) throw new Error("The MCP response exceeded 16 MiB.");
				buffer += decoder.decode(value, { stream: !done });
				if (stream) {
					// Hold a trailing CR until we can distinguish CRLF from a standalone line ending.
					let start = 0;
					for (const match of buffer.matchAll(/\r\n|[\r\n]/g)) {
						if (!done && match[0] === "\r" && match.index === buffer.length - 1) break;
						const line = buffer.slice(start, match.index);
						start = match.index + match[0].length;
						if (!line) {
							if (lines.length && (!event || event === "message")) {
								const message = JSON.parse(lines.join("\n"));
								if (matches(message)) return message;
							}
							lines = []; event = "";
						} else if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
						else if (line.startsWith("event:")) event = line.slice(6).trim();
					}
					buffer = buffer.slice(start);
				}
				if (done) break;
			}
			if (!stream) {
				const message = JSON.parse(buffer);
				if (matches(message) || (!response.ok && isObject(message?.error) && message.id == null)) return message;
			}
			throw new Error("The MCP server did not return a matching JSON-RPC response.");
		} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
	}

	function validateToken(url, token) {
		const address = new URL(url);
		if (token && address.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)) {
			throw new Error("A bearer token requires HTTPS or a loopback endpoint.");
		}
		if (token && !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error("Invalid bearer token.");
	}

	async function connect(address, token, signal, knownVersion) {
		const url = endpoint(address);
		validateToken(url, token);
		let version = knownVersion || modern, sessionId, counter = 0, hasTools = true;
		const auth = token ? { Authorization: "Bearer " + token } : {};
		async function send(method, params, operationSignal, { notification = false, schema } = {}) {
			const id = notification ? undefined : ++counter;
			const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...auth });
			if (method !== "initialize") headers.set("MCP-Protocol-Version", version);
			if (sessionId) headers.set("Mcp-Session-Id", sessionId);
			if (version === modern) {
				params = { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": version,
					"io.modelcontextprotocol/clientInfo": identity, "io.modelcontextprotocol/clientCapabilities": {} } };
				headers.set("Mcp-Method", method);
				if (method === "tools/call") {
					headers.set("Mcp-Name", headerValue(params.name));
					parameterHeaders(schema, params.arguments).forEach((value, name) => headers.set(name, value));
				}
			}
			const timeout = AbortSignal.timeout(method === "tools/call" ? 120000 : 30000);
			const lifetime = operationSignal ? AbortSignal.any([operationSignal, timeout]) : timeout;
			let response;
			try {
				response = await fetch(url, { method: "POST", headers, credentials: "omit", redirect: "error",
					cache: "no-store", signal: lifetime, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
			} catch (error) {
				lifetime.throwIfAborted();
				throw Object.assign(new Error("Cannot reach the MCP endpoint. Check the URL and the server's CORS settings.", { cause: error }), { network: true });
			}
			if (notification && response.ok) { await response.body?.cancel(); return; }
			let message;
			try { message = await responseMessage(response, id); }
			catch (error) {
				lifetime.throwIfAborted();
				if (response.ok) throw error;
			}
			if (!response.ok || message?.error) {
				const detail = message?.error?.message || response.statusText || "Request failed";
				throw Object.assign(new Error("MCP " + method + " (" + response.status + "): " + detail),
					{ status: response.status, rpcCode: message?.error?.code });
			}
			if (!isObject(message.result)) throw new Error("Invalid MCP result for " + method + ".");
			if (method === "initialize") sessionId = response.headers.get("Mcp-Session-Id");
			return message.result;
		}

		async function close() {
			if (!sessionId) return;
			const id = sessionId;
			sessionId = undefined;
			try {
				const response = await fetch(url, { method: "DELETE", credentials: "omit", redirect: "error",
					headers: { ...auth, "Mcp-Session-Id": id, "MCP-Protocol-Version": version }, signal: AbortSignal.timeout(3000) });
				await response.body?.cancel();
			} catch { /* A server can expire or decline to close a legacy session. */ }
		}

		try {
			if (!knownVersion) {
				try {
					const info = await send("server/discover", {}, signal);
					if (!Array.isArray(info.supportedVersions) || !info.supportedVersions.includes(modern) ||
						!isObject(info.capabilities)) throw new Error("Unsupported MCP discovery response.");
					hasTools = Boolean(info.capabilities.tools);
				} catch (error) {
					signal?.throwIfAborted();
					// Older endpoints can reject the modern method or its CORS preflight. Only retry discovery.
					const uninitialized = [-32000, -32002].includes(error.rpcCode) && /initializ/i.test(error.message);
					if ([-32020, -32021, -32022].includes(error.rpcCode) ||
						!(error.network || [400, 404, 405].includes(error.status) || error.rpcCode === -32601 || uninitialized)) throw error;
					version = legacy[0];
				}
			}
			if (version !== modern) {
				const info = await send("initialize", { protocolVersion: version, clientInfo: identity, capabilities: {} }, signal);
				if (!legacy.includes(info.protocolVersion)) throw new Error("Unsupported MCP protocol version: " + info.protocolVersion);
				version = info.protocolVersion;
				hasTools = Boolean(info.capabilities?.tools);
				await send("notifications/initialized", {}, signal, { notification: true });
			}
		} catch (error) { await close(); throw error; }

		return {
			version, close,
			async listTools(signal) {
				const tools = [], names = new Set(), cursors = new Set(), skipped = [];
				if (!hasTools) return { tools, skipped };
				let cursor;
				do {
					const page = await send("tools/list", cursor === undefined ? {} : { cursor }, signal);
					if (!Array.isArray(page.tools)) throw new Error("The MCP server returned an invalid tools list.");
					for (const tool of page.tools) {
						if (typeof tool?.name !== "string" || !tool.name || names.has(tool.name)) throw new Error("Missing or duplicate MCP tool name.");
						names.add(tool.name);
						if (!isObject(tool.inputSchema) || tool.inputSchema.type !== "object") { skipped.push(tool.name); continue; }
						if (version === modern) {
							try { parameterHeaders(tool.inputSchema); } catch { skipped.push(tool.name); continue; }
						}
						tools.push({ name: tool.name, description: typeof tool.description === "string" ? tool.description : "",
							inputSchema: tool.inputSchema });
					}
					cursor = page.nextCursor;
					if (cursor != null && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("Invalid MCP pagination cursor.");
					cursors.add(cursor);
				} while (cursor != null);
				return { tools, skipped };
			},
			callTool(tool, args, signal) {
				if (!hasTools) throw new Error("This MCP server does not offer tools.");
				return send("tools/call", { name: tool.name, arguments: args }, signal, { schema: tool.inputSchema });
			}
		};
	}

	// Workspace configuration, session tokens and tool grants.
	const tokenKey = "webstation.mcp-tokens.v1";
	function serversIn(config) {
		const servers = config.mcpServers ?? [];
		const ids = new Set(), aliases = new Set();
		if (!Array.isArray(servers)) throw new Error("Invalid MCP server configuration.");
		for (const server of servers) {
			if (!server || !/^[a-f0-9]{32}$/.test(server.id) || ids.has(server.id) ||
				typeof server.name !== "string" || !server.name.trim() || endpoint(server.url) !== server.url ||
				!Array.isArray(server.tools)) throw new Error("Invalid or duplicate MCP server in config.json.");
			ids.add(server.id);
			const names = new Set();
			for (const tool of server.tools) {
				if (typeof tool?.name !== "string" || !tool.name || names.has(tool.name) || typeof tool.description !== "string" ||
					tool.inputSchema?.type !== "object" || typeof tool.enabled !== "boolean" ||
					!/^mcp_[A-Za-z0-9_-]{1,60}$/.test(tool.alias) || aliases.has(tool.alias)) {
					throw new Error("Invalid or duplicate MCP function in config.json.");
				}
				aliases.add(tool.alias); names.add(tool.name);
			}
		}
		return servers;
	}

	async function read(vfs) {
		return serversIn(await new WorkspaceConfigStore(vfs).read());
	}

	// Update the current config in one transaction, including when another page edits unrelated settings.
	async function update(vfs, change) {
		const saved = await new WorkspaceConfigStore(vfs).update(config => {
			const servers = serversIn(config);
			change(servers);
			config.mcpServers = servers;
			serversIn(config);
			return config;
		});
		return saved.mcpServers;
	}

	function existing(servers, reference) {
		const server = servers.find(item => item.id === reference.id);
		if (!server || server.url !== reference.url) throw new Error("This server changed in another page. Reload its settings.");
		return server;
	}

	function saveServer(vfs, name, url, reference) {
		name = name.trim();
		if (!name) throw new Error("Give the MCP server a name.");
		url = endpoint(url);
		return update(vfs, servers => {
			if (servers.some(server => server.url === url && server.id !== reference?.id)) {
				throw new Error("This endpoint already has a connector.");
			}
			if (!reference) { servers.push({ id: newVfsGeneration(), name, url, tools: [] }); return; }
			const server = existing(servers, reference);
			if (server.name !== reference.name) throw new Error("The server name changed in another page. Reload its settings.");
			if (url !== server.url) {
				server.tools = []; delete server.version;
				server.catalogRevision = newVfsGeneration();
			}
			server.name = name; server.url = url;
		});
	}

	function removeServer(vfs, reference) {
		return update(vfs, servers => servers.splice(servers.indexOf(existing(servers, reference)), 1));
	}

	function tokenFor(server) {
		try {
			const entry = JSON.parse(sessionStorage.getItem(tokenKey) || "{}")[server.id];
			return entry?.url === server.url && typeof entry.token === "string" ? entry.token : "";
		} catch { return ""; }
	}

	function setToken(server, token) {
		validateToken(server.url, token);
		const tokens = JSON.parse(sessionStorage.getItem(tokenKey) || "{}");
		if (token) tokens[server.id] = { url: server.url, token };
		else delete tokens[server.id];
		if (Object.keys(tokens).length) sessionStorage.setItem(tokenKey, JSON.stringify(tokens));
		else sessionStorage.removeItem(tokenKey);
	}

	async function discover(vfs, reference, signal) {
		const client = await connect(reference.url, tokenFor(reference), signal);
		try {
			const { tools, skipped } = await client.listTools(signal);
			const servers = await update(vfs, servers => {
				signal?.throwIfAborted();
				const server = existing(servers, reference);
				if (server.catalogRevision !== reference.catalogRevision) throw new Error("A newer tool list was saved. Refresh again.");
				const previous = new Map(server.tools.map(tool => [tool.name, tool]));
				const slug = value => value.replace(/[^A-Za-z0-9_-]+/g, "_");
				server.tools = tools.map(tool => {
					const old = previous.get(tool.name);
					const alias = old?.alias || "mcp_" + slug(server.name).slice(0, 12) + "_" + slug(tool.name).slice(0, 30) +
						"_" + newVfsGeneration().slice(0, 16);
					return { ...tool, alias, enabled: old?.enabled === true };
				});
				server.version = client.version;
				server.catalogRevision = newVfsGeneration();
			});
			return { servers, skipped };
		} finally { await client.close(); }
	}

	function select(vfs, reference, aliases, enabled) {
		if (typeof enabled !== "boolean") throw new Error("Invalid MCP tool selection.");
		return update(vfs, servers => {
			const changed = new Set(aliases);
			const server = existing(servers, reference);
			for (const tool of server.tools) if (changed.delete(tool.alias)) tool.enabled = enabled;
			if (changed.size) throw new Error("The tool list changed. Review the current list.");
		});
	}

	function toolOutput(result) {
		if (result.resultType === "input_required") throw new Error("This tool requires additional client input.");
		if (!Array.isArray(result.content) && result.structuredContent === undefined) throw new Error("The server did not return a tool result.");
		const parts = (result.content || []).map(block => {
			if (block.type === "text") return String(block.text ?? "");
			if (block.type === "resource") return block.resource?.text ?? { uri: block.resource?.uri, mimeType: block.resource?.mimeType };
			if (block.type === "resource_link") return { name: block.name, uri: block.uri, description: block.description };
			return { type: block.type, mimeType: block.mimeType };
		});
		if (result.structuredContent !== undefined) parts.push(result.structuredContent);
		const output = parts.map(part => typeof part === "string" ? part : JSON.stringify(part)).join("\n");
		return result.isError ? "MCP tool error: " + output : output;
	}

	async function forAgent(vfs) {
		const routes = new Map(), connections = new Map(), tools = [];
		let closed = false;
		for (const server of await read(vfs)) for (const tool of server.tools) {
			if (!tool.enabled) continue;
			routes.set(tool.alias, { id: server.id, url: server.url, name: tool.name, schema: JSON.stringify(tool.inputSchema) });
			tools.push({ type: "function", function: { name: tool.alias,
				description: server.name + " · " + tool.name + (tool.description ? "\n" + tool.description : ""), parameters: tool.inputSchema } });
		}
		function currentGrants(servers) {
			const grants = new Map();
			for (const server of servers) for (const tool of server.tools) {
				const route = routes.get(tool.alias);
				if (tool.enabled && route?.id === server.id && route.url === server.url && route.name === tool.name &&
					route.schema === JSON.stringify(tool.inputSchema)) grants.set(tool.alias, { server, tool });
			}
			return grants;
		}
		async function check(alias, signal) {
			signal?.throwIfAborted();
			const grant = currentGrants(await read(vfs)).get(alias);
			if (closed || !grant) throw new Error("This MCP function is no longer enabled for this connector.");
			return grant;
		}
		return {
			tools,
			async filterTools(advertised) {
				const grants = currentGrants(await read(vfs));
				return advertised.filter(tool => !tool.function.name.startsWith("mcp_") || grants.has(tool.function.name));
			},
			async call(alias, args, { signal, run } = {}) {
				if (!routes.has(alias)) throw new Error("Unknown or disabled MCP function.");
				const { server } = await check(alias, signal);
				const token = tokenFor(server);
				let entry = connections.get(server.id);
				if (!entry || entry.token !== token) {
					entry?.client.then(client => client.close()).catch(() => {});
					entry = { token, client: connect(server.url, token, signal, server.version) };
					connections.set(server.id, entry);
				}
				try {
					const client = await entry.client;
					// A selection, endpoint, or run lease can change while a session is opening.
					if (run?.fence) await vfs.checkRun(run.fence);
					const { tool } = await check(alias, signal);
					signal?.throwIfAborted();
					return toolOutput(await client.callTool(tool, args, signal));
				} catch (error) {
					if (connections.get(server.id) === entry) connections.delete(server.id);
					entry.client.then(client => client.close()).catch(() => {});
					throw error; // A tool may already have taken effect. Never replay a failed call automatically.
				}
			},
			close() {
				closed = true;
				const pending = [...connections.values()].map(entry => entry.client.then(client => client.close()));
				connections.clear();
				return Promise.allSettled(pending);
			}
		};
	}

	return {
		susiMcpClient: { endpoint, validateToken, connect },
		susiMcp: { read, saveServer, removeServer, tokenFor, setToken, discover, select, forAgent }
	};
})();
