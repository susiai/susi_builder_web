"use strict";

function createBrowserClient({ discoveryMs = 600, requestTimeout = 180000, session } = {}) {
	let hubId;
	let discovering;
	let lastError = "";
	const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
	async function discover(signal) {
		if (session) return session;
		if (hubId) return hubId;
		if (discovering) return discovering;
		discovering = new Promise((resolve, reject) => {
			const channel = new BroadcastChannel("webstation.browser.v3");
			const requestId = id();
			const hubs = new Set();
			const abort = () => { clearTimeout(timer); channel.close(); reject(signal.reason); };
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", abort); channel.close();
				if (hubs.size !== 1) reject(new Error(hubs.size ?
					"Several browser connections are available. Open Chat from the connection you want to use." :
					"No browser connection is available."));
				else { hubId = [...hubs][0]; resolve(hubId); }
			}, discoveryMs);
			channel.onmessage = ({ data }) => {
				if (data?.type === "response" && data.id === requestId && data.result?.connected && data.result.hubId) {
					hubs.add(data.result.hubId);
				}
			};
			channel.postMessage({ type: "request", id: requestId, method: "status", expiresAt: Date.now() + discoveryMs + 1000 });
			signal?.addEventListener("abort", abort, { once: true });
		}).finally(() => { discovering = undefined; });
		return discovering;
	}
	async function request(method, args = {}, { signal, run } = {}) {
		signal?.throwIfAborted();
		const requestHub = await discover(signal);
		signal?.throwIfAborted();
		const channel = new BroadcastChannel("webstation.browser.v3");
		const requestId = id();
		const expiresAt = Date.now() + (method === "status" ? 1500 : requestTimeout);
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error, result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer); signal?.removeEventListener("abort", cancel); channel.close();
				if (error) { lastError = error.message; reject(error); } else { lastError = ""; resolve(result); }
			};
			const cancel = () => {
				channel.postMessage({ type: "cancel", id: requestId, hubId: requestHub });
				finish(signal.reason || new DOMException("Stopped.", "AbortError"));
			};
			const timer = setTimeout(() => {
				channel.postMessage({ type: "cancel", id: requestId, hubId: requestHub });
				if (method === "status" && hubId === requestHub) hubId = undefined;
				finish(new Error("Browser request expired. Check the connection and try again."));
			}, Math.max(0, expiresAt - Date.now()));
			channel.onmessage = ({ data }) => {
				if (data?.hubId !== requestHub) return;
				if (data.type === "connection-closed") {
					if (hubId === requestHub) hubId = undefined;
					finish(new Error("The browser connection was closed.")); return;
				}
				if (data.type !== "response" || data.id !== requestId) return;
				finish(data.error ? new Error(data.error) : null, data.result);
			};
			signal?.addEventListener("abort", cancel, { once: true });
			channel.postMessage({ type: "request", id: requestId, hubId: requestHub, method, args, run, expiresAt });
		});
	}
	return { request, get error() { return lastError; }, async available() {
		try { return (await request("status")).connected; }
		catch (error) { lastError = error.message; return false; }
	} };
}
