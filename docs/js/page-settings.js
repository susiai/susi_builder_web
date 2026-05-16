"use strict";

// Small, reusable page preferences live under config.pages. File contents and action results have their own stores.
const pageSettings = (() => {
	const path = "/config.json";
	function object(value = {}) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Expected an object in the workspace configuration.");
		}
		return value;
	}
	function report(page, error) {
		console.warn("Could not access preferences for " + page, error);
		let notice = document.getElementById("page-settings-notice");
		if (!notice) {
			notice = document.createElement("p");
			notice.id = "page-settings-notice";
			notice.setAttribute("role", "status");
			(document.querySelector("main") || document.body).append(notice);
		}
		notice.textContent = "Could not access page preferences in config.json. " + (error.message || error);
	}
	async function update(vfs, page, changes, fillMissing = false) {
		// Merge against the latest file inside the VFS transaction, including concurrent edits on the same page.
		let next;
		await vfs.update(path, source => {
			const config = object(JSON.parse(source ?? "{}"));
			const pages = object(config.pages);
			const current = object(pages[page]);
			next = fillMissing ? { ...changes, ...current } : { ...current, ...changes };
			if (JSON.stringify(current) === JSON.stringify(next)) return source ?? "{}";
			config.pages = { ...pages, [page]: next };
			return JSON.stringify(config, null, 2);
		});
		return next;
	}
	async function read(page, legacy = {}) {
		try {
			const vfs = await window.vfsReady;
			let source;
			try { source = await vfs.getasync(path); }
			catch (error) { if (error !== "Key not found") throw error; }
			const config = object(JSON.parse(source ?? "{}"));
			const current = object(object(config.pages)[page]);
			if (Object.keys(legacy).some(key => !Object.hasOwn(current, key))) {
				try { return await update(vfs, page, legacy, true); }
				catch (error) { report(page, error); return { ...legacy, ...current }; }
			}
			return current;
		} catch (error) { report(page, error); return {}; }
	}
	async function save(page, changes) {
		try { await update(await window.vfsReady, page, changes); return true; }
		catch (error) { report(page, error); return false; }
	}
	function rememberDisclosure(element, page, key) {
		let open;
		element.addEventListener("toggle", () => {
			if (element.open === open) return;
			open = element.open;
			save(page, { [key]: open });
		});
		read(page).then(settings => {
			if (open === undefined && typeof settings[key] === "boolean") {
				open = settings[key]; element.open = open;
			}
		});
	}
	return { read, save, rememberDisclosure };
})();
