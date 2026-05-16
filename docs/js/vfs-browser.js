"use strict";

function tableFileFormat(path) {
	return /\.(csv|jsonl|parquet)$/i.exec(path)?.[1].toLowerCase();
}

function decodeTableText(format, bytes) {
	let encoding = "utf-8";
	if (format === "csv" && bytes[0] === 255 && bytes[1] === 254) encoding = "utf-16le";
	if (format === "csv" && bytes[0] === 254 && bytes[1] === 255) encoding = "utf-16be";
	const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
	return { text, encoding };
}

function encodeTableText(text, encoding) {
	if (encoding === "utf-16le" || encoding === "utf-16be") {
		const view = new DataView(new ArrayBuffer(text.length * 2));
		const littleEndian = encoding === "utf-16le";
		for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), littleEndian);
		return new Uint8Array(view.buffer);
	}
	return new TextEncoder().encode(text);
}

function createProjectPreviewLink(path) {
	const play = document.createElement("a");
	play.href = `view.html?${new URLSearchParams({ path })}`;
	play.target = "_blank";
	play.rel = "noopener";
	play.dataset.action = "play";
	play.setAttribute("aria-label", "Preview website");
	play.title = "Preview website (opens in a new tab)";
	return play;
}

function downloadVfsBlob(blob, name) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
