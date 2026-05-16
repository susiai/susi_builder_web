"use strict";

const AGENT_PAGE_TEXT_LIMIT = 32000;

function parseAgentPageURL(address) {
	let url;
	try { url = typeof address === "string" ? new URL(address) : null; }
	catch { throw new Error("Enter a valid HTTP or HTTPS URL."); }
	if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("Enter an HTTP or HTTPS URL without embedded credentials.");
	}
	return url;
}

async function fetchAgentPage(address, signal) {
	const failure = (output, details = {}) => ({ exit_code: 1, ...details, output });
	let url;
	try { url = parseAgentPageURL(address); }
	catch (error) { return failure(error.message); }
	url.hash = "";
	const timeout = AbortSignal.timeout(20000);
	const request = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		const response = await fetch(url, {
			method: "GET", credentials: "omit", referrerPolicy: "no-referrer", signal: request,
			headers: { Accept: "text/html, application/xhtml+xml, text/plain, text/markdown, application/json, application/xml" }
		});
		const type = response.headers.get("content-type") || "";
		const contentType = type.split(";", 1)[0].trim().toLowerCase();
		const details = { url: response.url || url.href, status: response.status, content_type: contentType };
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			return failure(response.ok ? "This URL returned no content." : `The website returned HTTP ${response.status}.`, details);
		}
		if (contentType && !contentType.startsWith("text/") && !/^application\/(?:json|xml|[\w.+-]+\+(?:json|xml))$/.test(contentType)) {
			await response.body.cancel();
			return failure(`This URL serves ${contentType}. Web fetch reads text content.`, details);
		}

		const charset = type.match(/;\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
		let decoder;
		try { decoder = new TextDecoder(charset || "utf-8"); }
		catch { decoder = new TextDecoder(); }
		const reader = response.body.getReader();
		let remaining = 512 * 1024, truncated = false;
		const chunks = [];
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				const kept = value.subarray(0, remaining);
				chunks.push(decoder.decode(kept, { stream: true }));
				remaining -= kept.length;
				if (kept.length < value.length) {
					truncated = true;
					break;
				}
			}
			chunks.push(decoder.decode());
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		request.throwIfAborted();
		let output = chunks.join("");
		let title = "";
		if (contentType === "text/html" || contentType === "application/xhtml+xml" ||
			(!contentType && /^\s*(?:<!doctype\s+html\b|<html[\s>])/i.test(output))) {
			// A detached template keeps webpage markup inert, including scripts, frames, and resource links.
			const page = document.createElement("template");
			page.innerHTML = output;
			title = (page.content.querySelector("title")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300);
			for (const node of page.content.querySelectorAll(
				"title, script, style, template, noscript, iframe, svg, nav, footer, [hidden], [aria-hidden='true']"
			)) node.remove();
			const main = page.content.querySelector("main, [role='main']") || page.content;
			for (const node of main.querySelectorAll("address, article, blockquote, br, dd, div, dt, h1, h2, h3, h4, h5, h6, li, p, pre, section, tr")) {
				node.before("\n");
				node.after("\n");
			}
			for (const node of main.querySelectorAll("td + td, th + th")) node.before(" | ");
			output = main.textContent.split(/\r?\n/).map(line => line.replace(/[^\S\r\n]+/g, " ").trim()).filter(Boolean).join("\n");
		}
		truncated ||= output.length > AGENT_PAGE_TEXT_LIMIT;
		output = output.slice(0, AGENT_PAGE_TEXT_LIMIT).trim();
		if (!output) {
			return failure(truncated ? "No readable text was found in the portion fetched." : "This page returned no readable text.", details);
		}
		return { exit_code: 0, ...details, title, truncated, output };
	} catch (error) {
		signal?.throwIfAborted();
		if (timeout.aborted) return failure("The website did not respond within 20 seconds.");
		if (error instanceof TypeError) {
			return failure("The browser could not fetch this URL. The website may not allow cross-origin reads (CORS).");
		}
		return failure(error?.message || String(error));
	}
}
