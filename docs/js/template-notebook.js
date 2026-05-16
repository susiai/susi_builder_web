(globalThis.document?.currentScript?.susiSource || (run => run.call(globalThis)))(function () { /* susi source */
"use strict";

(async () => {
	const path = "notes.md";
	const files = window.susi?.files;
	const form = document.getElementById("notebook-form");
	const editor = document.getElementById("notebook-text");
	const save = form.querySelector('[type="submit"]');
	const reload = document.getElementById("notebook-reload");
	const local = document.getElementById("notebook-import");
	const picker = local.querySelector("input");
	const status = document.getElementById("notebook-status");
	let original = null;

	async function edit(operation) {
		if (save.disabled) return;
		save.disabled = reload.disabled = picker.disabled = editor.readOnly = true;
		try { await operation(); }
		catch (error) { status.textContent = error.message; }
		finally { save.disabled = reload.disabled = picker.disabled = editor.readOnly = false; }
	}

	async function load(file) {
		editor.value = await file.text();
		original = file;
		document.getElementById("notebook-name").textContent = file.name;
		status.textContent = "Opened " + file.name + ".";
	}

	async function readProjectNote() {
		try { await load(await files.readFile(path)); }
		catch (error) {
			if (error.code !== "ENOENT") throw error;
			original = null;
			status.textContent = "Save a note to create notes.md in this app.";
		}
	}

	form.addEventListener("submit", event => {
		event.preventDefault();
		edit(async () => {
			if (files) {
				// Saving against the file we opened also detects edits made in Code Studio or another tab.
				original = await files.writeFile(path, editor.value, { ifUnchanged: original });
				status.textContent = "Saved notes.md.";
			} else {
				const url = URL.createObjectURL(new Blob([editor.value], { type: "text/markdown;charset=utf-8" }));
				const link = document.createElement("a");
				link.href = url;
				link.download = original?.name || path;
				document.body.append(link);
				link.click();
				link.remove();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				status.textContent = "Downloaded " + link.download + ".";
			}
		});
	});

	if (files) {
		reload.addEventListener("click", () => edit(readProjectNote));
		await edit(readProjectNote);
	} else {
		reload.hidden = true;
		save.textContent = "Download note";
		local.hidden = false;
		picker.addEventListener("change", () => {
			const file = picker.files[0];
			picker.value = "";
			if (file) edit(() => load(file));
		});
		status.textContent = "Open notes.md from your exported folder, or write a new note.";
		if (/^https?:$/.test(location.protocol)) await edit(async () => {
			const response = await fetch(path);
			if (response.ok) await load(new File([await response.blob()], path));
		});
	}
})();

/* end susi source */
});
