"use strict";

// Small, reusable page preferences live under config.pages. File contents and action results have their own stores.
const pageSettings = (() => {
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
	async function update(store, page, changes, fillMissing = false) {
		// Merge against the latest file inside the VFS transaction, including concurrent edits on the same page.
		const saved = await store.update(config => {
			const pages = object(config.pages);
			const current = object(pages[page]);
			const next = fillMissing ? { ...changes, ...current } : { ...current, ...changes };
			if (JSON.stringify(current) === JSON.stringify(next)) return;
			return { ...config, pages: { ...pages, [page]: next } };
		});
		return object(object(saved.pages)[page]);
	}
	async function read(page, legacy = {}) {
		try {
			const store = new WorkspaceConfigStore(await window.vfsReady);
			const config = await store.read();
			const current = object(object(config.pages)[page]);
			if (Object.keys(legacy).some(key => !Object.hasOwn(current, key))) {
				try { return await update(store, page, legacy, true); }
				catch (error) { report(page, error); return { ...legacy, ...current }; }
			}
			return current;
		} catch (error) { report(page, error); return {}; }
	}
	async function save(page, changes) {
		try { await update(new WorkspaceConfigStore(await window.vfsReady), page, changes); return true; }
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
