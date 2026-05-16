"use strict";

const documentAttachments = (() => {
	const base = window.__susiPreview ? new URL("js/", document.baseURI) : document.currentScript.src;
	const officeBundle = new URL("vendor/officeparser-8.9.0.browser.slim.iife.js?v=db8b9914", base);
	const pdfWorkerBundle = new URL("vendor/pdfjs-6.5.438.worker.js?v=c1674370", base);
	const formats = {
		xlsx: {
			fileType: "xlsx",
			mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			icon: "mime-x-office-spreadsheet"
		},
		docx: {
			fileType: "docx",
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			icon: "mime-x-office-document"
		},
		pptx: {
			fileType: "pptx",
			mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			icon: "mime-x-office-presentation"
		},
		pdf: {
			fileType: "pdf",
			mimeType: "application/pdf",
			icon: "mime-application-pdf"
		}
	};
	const scripts = new Map();

	function findFormat(mimeType, name = "") {
		const byMimeType = Object.values(formats).find(format => format.mimeType === mimeType);
		if (byMimeType) return byMimeType;
		// File pickers can report documents as generic binary data or leave the MIME type blank.
		if (!mimeType || ["application/octet-stream", "application/zip", "application/x-zip-compressed"].includes(mimeType)) {
			const extension = name.match(/\.(xlsx|docx|pptx|pdf)$/i)?.[1].toLowerCase();
			return formats[extension];
		}
	}

	function loadScript(url, globalName, errorMessage) {
		if (scripts.has(url)) return scripts.get(url);
		const loading = new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = url.href;
			script.onload = () => {
				script.remove();
				const exported = globalThis[globalName];
				if (exported) resolve(exported);
				else reject(new Error(errorMessage));
			};
			script.onerror = () => { script.remove(); reject(new Error(errorMessage)); };
			document.head.append(script);
		}).catch(error => {
			scripts.delete(url);
			throw error;
		});
		scripts.set(url, loading);
		return loading;
	}

	async function read(file, { fileType }) {
		if (file.size > 32 * 1024 * 1024) throw new Error("Document files are limited to 32 MiB each.");
		const parser = await loadScript(officeBundle, "officeParser", "Could not load the document reader.");
		const isPdf = fileType === "pdf";
		let workerUrl;
		if (isPdf) {
			const worker = await loadScript(pdfWorkerBundle, "susiPdfWorker", "Could not load the PDF reader.");
			workerUrl = URL.createObjectURL(worker);
		}
		let parsed;
		try {
			parsed = await parser.parseOffice(file, {
				fileType, ignoreSlideMasters: true, extractAttachments: false, ocr: false, allowRemoteAssets: false,
				...(isPdf ? {
					pdfWorkerSrc: workerUrl,
					pdfParserConfig: { extractTextColor: false, keepHeadersAndFootersInPages: true },
					abortSignal: AbortSignal.timeout(30_000)
				} : {}),
				decompressionLimits: {
					maxUncompressedBytes: 64 * 1024 * 1024, maxZipEntries: 5000, maxTableCells: 100000,
					maxXmlElements: 500000, maxRepeatedContent: 2000000
				}
			});
		} catch (error) {
			if (/LIMIT_EXCEEDED$/.test(error?.officeIssue?.code)) {
				throw new Error("This document is too large to read in Chat.");
			}
			if (isPdf && error?.name === "AbortError") throw new Error("Reading this PDF timed out.");
			const type = isPdf ? "PDF" : "Office file";
			throw new Error(`Could not read this ${type}. Check that it opens and is unlocked.`, { cause: error });
		} finally {
			if (workerUrl) URL.revokeObjectURL(workerUrl);
		}
		if (parsed.warnings.some(issue => /LIMIT_EXCEEDED$/.test(issue.code))) {
			throw new Error("This document is too large to read in Chat.");
		}
		// Only include document content. Markdown generation otherwise adds file properties as YAML front matter.
		parsed.metadata = {};
		if (fileType === "xlsx") {
			parsed.content = parsed.content.flatMap(sheet => {
				const name = sheet.metadata?.sheetName;
				return sheet.type === "sheet" && name && sheet.children?.length
					? [{ type: "heading", metadata: { level: 2 }, children: [{ type: "text", text: name }] }, sheet]
					: [sheet];
			});
		}
		const { value } = await parsed.to("md", {
			generateIds: false,
			mdConfig: { dialect: "github", fallbackToHtml: false }
		});
		const markdown = value.replace(/^---\n+/, "");
		if (!markdown.replace(/^---$/gm, "").trim()) {
			throw new Error(isPdf
				? "This PDF contains no readable text. Scanned pages need OCR before you attach the file."
				: "This document contains no readable text.");
		}
		return markdown;
	}

	async function readText(file, mimeType) {
		const data = new Uint8Array(await file.arrayBuffer());
		const charset = file.type.match(/;\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
		const encoding = charset || (data[0] === 0xff && data[1] === 0xfe ? "utf-16le" :
			data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8");
		const text = new TextDecoder(encoding, { fatal: true }).decode(data);
		if (text.includes("\0")) throw new Error("Invalid text.");
		if (mimeType === "text/markdown" || /\.(md|markdown)$/i.test(file.name)) return text;
		return literalMarkdown(text);
	}

	function literalMarkdown(text) {
		// A fence longer than any run inside the file preserves literal Markdown and source code.
		let fenceLength = 3;
		for (const [run] of text.matchAll(/~+/g)) fenceLength = Math.max(fenceLength, run.length + 1);
		const fence = "~".repeat(fenceLength);
		const lineBreak = text && !/[\r\n]$/.test(text) ? "\n" : "";
		return `${fence}text\n${text}${lineBreak}${fence}\n`;
	}

	return { findFormat, read, readText, literalMarkdown };
})();
