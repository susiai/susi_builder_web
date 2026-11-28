"use strict";

const VFS_PREVIEW_ORIGIN = "https://susi-vfs.invalid";

function vfsPreviewPolicy(allowRemoteResources = false) {
	const remote = allowRemoteResources ? " https: http:" : "";
	return [
		"default-src 'none'",
		`script-src blob: 'unsafe-inline' 'unsafe-eval'${remote}`,
		`style-src blob: 'unsafe-inline'${remote}`,
		`img-src blob: data:${remote}`,
		`font-src blob: data:${remote}`,
		`media-src blob: data:${remote}`,
		`connect-src blob:${remote}${allowRemoteResources ? " wss: ws:" : ""}`,
		"object-src 'none'", "frame-src 'none'", "worker-src 'none'",
		`base-uri ${VFS_PREVIEW_ORIGIN}${remote}`,
		"form-action 'none'"
	].join("; ");
}

function previewFileURL(path) {
	return new URL(path.split("/").map(encodeURIComponent).join("/"), VFS_PREVIEW_ORIGIN + "/").href;
}

// A parser keeps import-like text inside comments, strings, and regular expressions intact.
function preparePreviewScript(source, base, imports) {
	let program;
	try {
		program = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
	} catch {
		try {
			program = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
		} catch {
			return source; // Let the browser report syntax errors in the original project source.
		}
	}
	const edits = [];
	const nodes = [program];
	while (nodes.length) {
		const node = nodes.pop();
		if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
			node.type === "ExportAllDeclaration") && node.source) {
			if (/^(?:\.{1,2}\/|\/)/.test(node.source.value)) {
				const url = new URL(node.source.value, base).href;
				imports.add(url);
				edits.push({ start: node.source.start, end: node.source.end, text: JSON.stringify(url) });
			}
		} else if (node.type === "ImportExpression") {
			// Inserting around the expression also permits nested imports and import.meta edits.
			edits.push({ start: node.source.start, end: node.source.start, text: "window.__susiPreview.moduleURL(" });
			edits.push({ start: node.source.end, end: node.source.end, text: `,${JSON.stringify(base)})` });
		} else if (node.type === "MetaProperty" && node.meta.name === "import") {
			edits.push({ start: node.start, end: node.end, text: `window.__susiPreview.meta(${JSON.stringify(base)})` });
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) {
				for (const child of value) if (child?.type) nodes.push(child);
			} else if (value?.type) nodes.push(value);
		}
	}
	for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
		source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
	}
	return source;
}

async function prepareVfsPreview(entries) {
	const imports = new Set();
	const files = await Promise.all(entries.filter(entry => !entry.path.endsWith("/")).map(async ({ path, value }) => {
		const url = previewFileURL(path);
		let source = value;
		if (typeof source !== "string" && /\.(?:html?|css|m?js)$/i.test(path)) source = await new Blob([source]).text();
		if (typeof source === "string" && /\.(?:m?js)$/i.test(path)) {
			source = preparePreviewScript(source, url, imports);
		} else if (typeof source === "string" && /\.html?$/i.test(path)) {
			const doc = new DOMParser().parseFromString(source, "text/html");
			const base = new URL(doc.querySelector("base[href]")?.getAttribute("href") || url, url).href;
			for (const script of doc.querySelectorAll("script:not([src])")) {
				if (!script.type || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/i.test(script.type)) {
					script.textContent = preparePreviewScript(script.textContent, base, imports);
				}
			}
			source = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
		}
		return { url, value, source };
	}));
	return { files, imports: [...imports] };
}

// Rewrite url(...) and quoted @import references, retaining other CSS strings and comments.
function rewritePreviewCSS(source, resolve) {
	return source.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(@import\s+)(["'])((?:\\[\s\S]|[^\\])*?)\2|url\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|([^)]*))\s*\)/gi,
		(match, prefix, quote, imported, double, single, unquoted) => {
			const value = imported ?? double ?? single ?? unquoted?.trim();
			if (value === undefined) return match;
			const decoded = value.replace(/\\([\da-f]{1,6})\s?|\\([^\n\r\f])/gi,
				(_match, hex, character) => hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : character);
			const url = resolve(decoded);
			return prefix ? `${prefix}${JSON.stringify(url)}` : `url(${JSON.stringify(url)})`;
		});
}

// Runs inside the opaque iframe. Object URLs created there also work when opened from file://.
function startVfsPreview(id, origin, policy) {
	const send = (type, extra = {}) => parent.postMessage({ preview: id, type, ...extra }, "*");
	// The private port belongs to this document, even if another page later occupies the same iframe.
	const { port1: host, port2 } = new MessageChannel();
	host.onmessage = ({ data }) => {
		host.onmessage = null;
		try { start(data); } catch (error) { host.close(); send("error", { message: error.message }); }
	};
	parent.postMessage({ preview: id, type: "ready" }, "*", [port2]);

	function start(snapshot) {
		let diagnosticCount = 0;
		function diagnostic(level, message, blockedPreviewConnection = false) {
			if (++diagnosticCount > 100) return;
			send("diagnostic", { level, message: String(message).slice(0, 2000), blockedPreviewConnection, time: Date.now() });
			if (diagnosticCount === 100) send("diagnostic", { level: "warn", message: "Further diagnostics are omitted until Reload.", time: Date.now() });
		}
		const files = new Map(snapshot.files.map(file => [new URL(file.url).pathname, file]));
		const urls = new Map();
		const rawURLs = new Map();
		const buildingCSS = new Set();
		const createdURLs = new Set();
		const nativeFetch = window.fetch.bind(window);
		const mimeTypes = {
			html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
			json: "application/json", map: "application/json", webmanifest: "application/manifest+json",
			txt: "text/plain", csv: "text/csv", xml: "application/xml", svg: "image/svg+xml", png: "image/png",
			jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
			ico: "image/vnd.microsoft.icon", bmp: "image/bmp", woff: "font/woff", woff2: "font/woff2",
			ttf: "font/ttf", otf: "font/otf", wasm: "application/wasm", pdf: "application/pdf",
			mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4",
			webm: "video/webm", vtt: "text/vtt"
		};
		const typeOf = path => mimeTypes[path.split(".").at(-1).toLowerCase()] || "application/octet-stream";
		const blobURL = (value, type) => {
			const url = URL.createObjectURL(new Blob([value], { type }));
			createdURLs.add(url);
			return url;
		};
		const resolve = (value, base = document.baseURI) => new URL(String(value), base);
		const local = url => url.origin === origin;
		const moduleURL = (value, base) => {
			if (!/^(?:\.{1,2}\/|\/|[a-z][a-z\d+.-]*:)/i.test(value)) return value;
			const url = resolve(value, base);
			return local(url) ? resourceURL(url.href) : url.href;
		};
		function resourceURL(value, base = document.baseURI, raw = false) {
			if (!value || String(value).startsWith("#")) return value;
			const url = resolve(value, base);
			if (!local(url)) return url.href;
			const cache = raw ? rawURLs : urls;
			if (!cache.has(url.pathname)) {
				const file = files.get(url.pathname);
				const type = typeOf(url.pathname);
				let content = file ? raw ? file.value : file.source : "";
				if (!raw && type === "text/css" && typeof content === "string") {
					if (buildingCSS.has(url.pathname)) return "data:text/css,";
					buildingCSS.add(url.pathname);
					content = rewritePreviewCSS(content, reference => resourceURL(reference, url.href));
					buildingCSS.delete(url.pathname);
				}
				if (!file && type === "text/javascript") content = `throw new Error(${JSON.stringify("File not found in the project: " + url.pathname)});`;
				cache.set(url.pathname, blobURL(content, type));
			}
			return cache.get(url.pathname) + url.hash;
		}

		const requestFile = async (input, options) => {
			const url = resolve(input instanceof Request ? input.url : input);
			if (!local(url)) return nativeFetch(input, options);
			const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
			signal?.throwIfAborted();
			const method = (options?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
			const file = files.get(url.pathname);
			const status = method !== "GET" && method !== "HEAD" ? 405 : file ? 200 : 404;
			const body = status === 200 ? file.value : status === 404 ? "File not found in the VFS." : "The preview is read-only.";
			const response = new Response(method === "HEAD" ? null : body, {
				status, statusText: { 200: "OK", 404: "Not Found", 405: "Method Not Allowed" }[status],
				headers: { "Content-Type": status === 200 ? typeOf(url.pathname) : "text/plain", "Cache-Control": "no-store" }
			});
			Object.defineProperty(response, "url", { value: url.href });
			return response;
		};
		window.fetch = requestFile;
		const xhrOpen = XMLHttpRequest.prototype.open;
		const xhrStatus = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "status").get;
		const xhrURL = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseURL").get;
		const requests = new WeakMap();
		XMLHttpRequest.prototype.open = function(method, value, ...args) {
			const url = resolve(value);
			requests.delete(this);
			if (local(url)) {
				const status = /^(GET|HEAD)$/i.test(method) ? files.has(url.pathname) ? 200 : 404 : 405;
				requests.set(this, { url: url.href, status });
				value = status === 200 && method.toUpperCase() !== "HEAD" ? resourceURL(url.href, url.href, true)
					: blobURL(status === 200 ? "" : status === 404 ? "File not found in the VFS." : "The preview is read-only.", "text/plain");
				method = "GET";
			}
			return xhrOpen.call(this, method, value, ...args);
		};
		Object.defineProperties(XMLHttpRequest.prototype, {
			status: { configurable: true, get() { const status = xhrStatus.call(this); return status ? requests.get(this)?.status ?? status : status; } },
			responseURL: { configurable: true, get() { return requests.get(this)?.url || xhrURL.call(this); } }
		});

		const urlAttributes = new Map([
			["IMG", ["src"]], ["SCRIPT", ["src"]], ["LINK", ["href"]], ["SOURCE", ["src"]],
			["VIDEO", ["src", "poster"]], ["AUDIO", ["src"]], ["TRACK", ["src"]],
			["INPUT", ["src"]], ["EMBED", ["src"]], ["OBJECT", ["data"]], ["IMAGE", ["href", "xlink:href"]]
		]);
		function rewriteElement(element, base) {
			if ((element.tagName === "A" || element.tagName === "AREA") && element.hasAttribute("download") && element.hasAttribute("href")) {
				const value = element.getAttribute("href");
				const rewritten = resourceURL(value, base, true);
				if (value !== rewritten) element.setAttribute("href", rewritten);
			}
			for (const attribute of urlAttributes.get(element.tagName.toUpperCase()) || []) {
				if (element.hasAttribute(attribute)) {
					const value = element.getAttribute(attribute);
					const rewritten = resourceURL(value, base);
					if (value !== rewritten) element.setAttribute(attribute, rewritten);
				}
			}
			if (element.hasAttribute("srcset")) {
				const source = element.getAttribute("srcset");
				if (!source.includes("data:")) {
					const rewritten = source.replace(/(^|,)\s*(\S+)/g, (_match, comma, value) => `${comma} ${resourceURL(value, base)}`);
					if (source !== rewritten) element.setAttribute("srcset", rewritten);
				}
			}
			if (element.hasAttribute("style")) {
				const source = element.getAttribute("style");
				const rewritten = rewritePreviewCSS(source, value => resourceURL(value, base));
				if (source !== rewritten) element.setAttribute("style", rewritten);
			}
			if (element.tagName === "STYLE") {
				const source = element.textContent;
				const rewritten = rewritePreviewCSS(source, value => resourceURL(value, base));
				if (source !== rewritten) element.textContent = rewritten;
			}
		}
		// Resolve dynamic resource setters before the browser starts a request. The observer also handles
		// inserted HTML fragments and changes made through APIs that bypass reflected property setters.
		const setAttribute = Element.prototype.setAttribute;
		Element.prototype.setAttribute = function(name, value) {
			const attributes = urlAttributes.get(this.tagName.toUpperCase()) || [];
			if (this.ownerDocument === document && attributes.includes(name.toLowerCase())) {
				value = resourceURL(String(value));
			}
			return setAttribute.call(this, name, value);
		};
		for (const [constructor, properties] of [
			[HTMLImageElement, ["src"]], [HTMLScriptElement, ["src"]], [HTMLLinkElement, ["href"]],
			[HTMLMediaElement, ["src"]], [HTMLVideoElement, ["poster"]], [HTMLSourceElement, ["src"]],
			[HTMLTrackElement, ["src"]], [HTMLInputElement, ["src"]], [HTMLEmbedElement, ["src"]],
			[HTMLObjectElement, ["data"]]
		]) {
			for (const name of properties) {
				const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, name);
				if (!descriptor?.set) continue;
				Object.defineProperty(constructor.prototype, name, {
					...descriptor,
					set(value) { descriptor.set.call(this, this.ownerDocument === document ? resourceURL(String(value)) : value); }
				});
			}
		}

		let pageURL = resolve(snapshot.path, origin + "/");
		if (pageURL.pathname.endsWith("/")) pageURL.pathname += "index.html";
		else if (!files.has(pageURL.pathname) && files.has(pageURL.pathname + "/index.html")) pageURL.pathname += "/index.html";
		const entry = files.get(pageURL.pathname);
		if (!entry || typeOf(pageURL.pathname) !== "text/html") throw new Error("No HTML page found in the project at " + pageURL.pathname);
		const doc = new DOMParser().parseFromString(entry.source, "text/html");
		const security = doc.createElement("meta");
		security.httpEquiv = "Content-Security-Policy";
		security.content = policy;
		doc.head.prepend(security);
		let base = doc.querySelector("base[href]");
		const baseURL = resolve(base?.getAttribute("href") || pageURL.href, pageURL.href).href;
		if (!base) base = doc.createElement("base");
		security.after(base);
		base.href = baseURL;
		const importMap = { imports: {} };
		for (const file of files.values()) importMap.imports[file.url] = resourceURL(file.url);
		for (const url of snapshot.imports) if (local(resolve(url, baseURL))) importMap.imports[url] = resourceURL(url);
		for (const map of doc.querySelectorAll('script[type="importmap"]')) {
			const configured = JSON.parse(map.textContent);
			for (const [name, value] of Object.entries(configured.imports || {})) {
				if (typeof value !== "string") continue;
				const target = resolve(value, baseURL);
				const key = /^(?:\.{1,2}\/|\/)/.test(name) ? resolve(name, baseURL).href : name;
				if (key.endsWith("/") && local(target)) {
					for (const file of files.values()) if (file.url.startsWith(target.href)) {
						importMap.imports[key + file.url.slice(target.href.length)] = resourceURL(file.url);
					}
				} else importMap.imports[key] = local(target) ? resourceURL(target.href) : target.href;
			}
			map.remove();
		}
		for (const element of doc.querySelectorAll("*")) rewriteElement(element, baseURL);
		const imports = doc.createElement("script");
		imports.type = "importmap";
		imports.textContent = JSON.stringify(importMap).replace(/</g, "\\u003c");
		base.after(imports);
		const install = doc.createElement("script");
		install.textContent = "window.__susiPreview.install();";
		imports.after(install);

		// Existing app bundles also check the original preview marker for asset resolution.
		window.__susiPreview = window.__webstationPreview = {
			moduleURL,
			meta: url => ({ url, resolve: value => resolve(value, url).href }),
			install() {
				window.fetch = requestFile;
				if (snapshot.projectFiles || snapshot.projectWorkspace || snapshot.localModel) {
					const calls = new Map();
					let nextId = 0;
					let closed = false;
					function closeFiles() {
						closed = true;
						host.close();
						for (const call of calls.values()) {
							call.cleanup();
							call.reject(new DOMException("Project closed.", "AbortError"));
						}
						calls.clear();
					}
					host.onmessage = ({ data }) => {
						if (data.closed) { closeFiles(); return; }
						const call = calls.get(data.id);
						if (!call) return;
						if (data.event) { call.onEvent?.(data.event, data.value); return; }
						calls.delete(data.id);
						call.cleanup();
						if (data.missing) call.reject("Key not found");
						else if (data.error) call.reject(Object.assign(new Error(data.error), { code: data.code }));
						else call.resolve(data.file);
					};
					const request = (message, signal, onEvent) => new Promise((resolve, reject) => {
						if (closed) throw new DOMException("Project closed.", "AbortError");
						signal?.throwIfAborted();
						const id = ++nextId;
						const abort = () => {
							calls.delete(id);
							host.postMessage({ id, method: "cancel" });
							reject(signal.reason);
						};
						host.postMessage({ id, ...message });
						signal?.addEventListener("abort", abort, { once: true });
						calls.set(id, { resolve, reject, onEvent, cleanup: () => signal?.removeEventListener("abort", abort) });
					});
					// Older exported apps use the original name for the same scoped file API.
					window.susi = window.webstation = {};
					if (snapshot.projectFiles) window.susi.files = {
						readFile: path => request({ method: "read", path }),
						writeFile: (path, value, { ifUnchanged: previous } = {}) => request({ method: "write", path, value, previous })
					};
					if (snapshot.projectWorkspace) window.susi.workspace = (name, args, signal) =>
						request({ method: "workspace", name, args }, signal);
					if (snapshot.localModel) window.susi.localModel = (name, args, signal, onEvent) =>
						request({ method: "local-model", name, args }, signal, onEvent);
					window.addEventListener("pagehide", event => { if (!event.persisted) closeFiles(); });
				} else host.close();
				for (const level of ["warn", "error"]) {
					const original = console[level].bind(console);
					console[level] = (...values) => {
						original(...values);
						diagnostic(level, values.map(value => {
							try { return typeof value === "string" ? value : value instanceof Error ? value.message : JSON.stringify(value); }
							catch { return "[Unserializable value]"; }
						}).join(" "));
					};
				}
				window.addEventListener("error", event => {
					if (event.message) diagnostic("error", `${event.message} (${event.filename || "inline"}:${event.lineno || 0})`);
					else if (event.target !== window) diagnostic("error", `Resource failed: ${event.target.getAttribute?.("src") || event.target.getAttribute?.("href") || event.target.tagName}`);
				}, true);
				window.addEventListener("unhandledrejection", event => diagnostic("error", event.reason?.message || event.reason || "Unhandled promise rejection"));
				document.addEventListener("securitypolicyviolation", event => {
					const blockedPreviewConnection = event.isTrusted && event.disposition === "enforce" &&
						event.effectiveDirective === "connect-src" && event.originalPolicy === policy;
					diagnostic("warn", `Blocked ${event.violatedDirective}: ${event.blockedURI}`, blockedPreviewConnection);
				});
					function followLink(event) {
						const primary = event.type === "click" && event.button === 0;
						if (!primary && !(event.type === "auxclick" && event.button === 1)) return;
					const link = event.target.closest("a[href],area[href]");
						if (!link || event.defaultPrevented || link.hasAttribute("download")) return;
						const href = link.getAttribute("href");
						if (!URL.canParse(href, document.baseURI)) return;
						const url = resolve(href);
						if (!local(url)) {
							if (url.protocol !== "https:" && url.protocol !== "http:") return;
							event.preventDefault();
							if (event.isTrusted) send("open-external", { url: url.href });
							return;
						}
						if (!primary || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
					event.preventDefault();
					if (url.pathname === pageURL.pathname && url.search === pageURL.search && url.hash) {
						document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
					} else send("navigate", { url: url.href });
					}
					document.addEventListener("click", followLink);
					document.addEventListener("auxclick", followLink);
				document.addEventListener("submit", event => {
					if (event.defaultPrevented) return;
					const form = event.target;
					if (form.method === "dialog") return;
					const url = resolve(form.getAttribute("action") || pageURL.href);
					if (!local(url)) return;
					event.preventDefault();
					if (form.method.toLowerCase() !== "get") return;
					url.search = new URLSearchParams(new FormData(form, event.submitter));
					send("navigate", { url: url.href });
				});
				new MutationObserver(records => {
					for (const record of records) {
						if (record.type === "attributes") rewriteElement(record.target, document.baseURI);
						if (record.target.parentElement?.tagName === "STYLE") rewriteElement(record.target.parentElement, document.baseURI);
						if (record.target.nodeType === Node.ELEMENT_NODE && record.target.tagName === "STYLE") rewriteElement(record.target, document.baseURI);
						for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) {
							rewriteElement(node, document.baseURI);
							for (const element of node.querySelectorAll("*")) rewriteElement(element, document.baseURI);
						}
					}
				}).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "href", "srcset", "style", "poster", "data", "download"] });
				window.addEventListener("pagehide", event => {
					if (!event.persisted) for (const url of createdURLs) URL.revokeObjectURL(url);
				});
			}
		};
		// document.open clears document listeners; reinstall the bridge before project scripts execute.
		document.open();
		document.write("<!DOCTYPE html>\n" + doc.documentElement.outerHTML);
		document.close();
		if (pageURL.hash) document.getElementById(decodeURIComponent(pageURL.hash.slice(1)))?.scrollIntoView();
		send("rendered", { url: pageURL.href });
	}
}

function createVfsPreview(frame, snapshot, {
	onNavigate = () => {}, onError = () => {}, onDiagnostic = () => {}, allowRemoteResources = false, projectFiles, projectWorkspace, localModel
} = {}) {
	let current;
	let pending;
	let timeout;
	let port;
	let session;
	const policy = vfsPreviewPolicy(allowRemoteResources);
	function settle(error, url) {
		clearTimeout(timeout);
		if (!pending) return;
		if (error) pending.reject(error); else pending.resolve(url);
		pending = undefined;
	}
	function receive(event) {
		if (event.source !== frame.contentWindow || event.data?.preview !== current) return;
		if (event.data.type === "ready" && pending && !port && event.ports[0]) {
			port = event.ports[0];
			const connection = port;
			const { signal } = session;
			if (localModel) signal.addEventListener("abort", () => localModel("close", []), { once: true });
			const requests = new Map();
			if (projectFiles || projectWorkspace || localModel) connection.onmessage = async ({ data }) => {
				if (signal.aborted || !Number.isSafeInteger(data?.id)) return;
				if (data.method === "cancel") { requests.get(data.id)?.abort(); return; }
				if (requests.has(data.id)) return;
				const controller = new AbortController();
				requests.set(data.id, controller);
				const operation = AbortSignal.any([signal, controller.signal]);
				try {
					let file;
					if (data.method === "workspace" && projectWorkspace) {
						file = await projectWorkspace(data.name, data.args, operation);
					} else if (data.method === "local-model" && localModel && Array.isArray(data.args)) {
						file = await localModel(data.name, data.args, operation, (event, value) => {
							if (!operation.aborted) connection.postMessage({ id: data.id, event, value });
						});
					} else {
						if (typeof data.path !== "string" || /[\\\x00-\x1f\x7f]/.test(data.path)) {
							throw new Error("Invalid project file path.");
						}
						if (data.method === "read") file = await projectFiles?.readFile(data.path);
						else if (data.method === "write") file = await projectFiles?.writeFile(data.path, data.value, data.previous, operation);
						else throw new Error("Unknown project file operation.");
					}
					if (!operation.aborted) connection.postMessage({ id: data.id, file });
				} catch (error) {
					if (!operation.aborted) connection.postMessage({
						id: data.id, error: error?.message || String(error), code: error?.code, missing: error === "Key not found"
					});
				} finally { requests.delete(data.id); }
			};
			connection.postMessage({
				...snapshot, path: pending.path, projectFiles: Boolean(projectFiles),
				projectWorkspace: Boolean(projectWorkspace), localModel: Boolean(localModel)
			});
		} else if (event.data.type === "rendered") settle(undefined, event.data.url);
		else if (event.data.type === "error") { settle(new Error(event.data.message)); onError(event.data.message); }
		else if (event.data.type === "navigate") onNavigate(event.data.url);
		else if (event.data.type === "open-external" && navigator.userActivation?.isActive !== false) {
			// Use the host tab so the destination opens with its own origin and storage.
			if (typeof event.data.url !== "string" || !URL.canParse(event.data.url)) return;
			const url = new URL(event.data.url);
			if ((url.protocol === "https:" || url.protocol === "http:") && url.origin !== VFS_PREVIEW_ORIGIN) {
				window.open(url.href, "_blank", "noopener,noreferrer");
			}
		}
		else if (event.data.type === "diagnostic" && ["warn", "error"].includes(event.data.level) && typeof event.data.message === "string") {
			onDiagnostic({ level: event.data.level, message: event.data.message.slice(0, 2000),
				blockedPreviewConnection: event.data.blockedPreviewConnection === true, time: Date.now() });
		}
	}
	function disconnect() {
		session?.abort();
		if (port) {
			port.postMessage({ closed: true });
			port.close();
			port = undefined;
		}
	}
	window.addEventListener("message", receive);
	frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-downloads");
	return {
		open(path = "/index.html") {
			settle(new DOMException("Preview replaced.", "AbortError"));
			disconnect();
			session = new AbortController();
			current = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
			const result = new Promise((resolve, reject) => { pending = { path, resolve, reject }; });
			timeout = setTimeout(() => {
				settle(new Error("The project did not finish starting. Try refreshing the page."));
			}, 15000);
			const script = rewritePreviewCSS.toString() + "\n(" + startVfsPreview.toString() + ")(" +
				JSON.stringify(current) + "," + JSON.stringify(VFS_PREVIEW_ORIGIN) + "," + JSON.stringify(policy) + ");";
			frame.srcdoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
				policy.replaceAll('"', "&quot;") + '"><script>' +
				script.replace(/<\/script/gi, "<\\/script") + "</script></head><body></body></html>";
			return result;
		},
		dispose() {
			window.removeEventListener("message", receive);
			settle(new DOMException("Preview closed.", "AbortError"));
			disconnect();
			current = undefined;
			frame.srcdoc = "";
		}
	};
}
