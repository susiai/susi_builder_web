"use strict";

(async () => {
	const status = document.getElementById("project-status");
	const loading = document.getElementById("project-loading");
	const list = document.getElementById("project-list");
	const pinnedSection = document.getElementById("pinned-apps");
	const open = document.getElementById("project-new");
	const newTile = open?.closest("li");
	const deleteDialog = document.getElementById("app-delete-dialog");
	let vfs, catalog;
	let tiles = new Map();
	let request = 0;
	let creating = false;

	function notice(message, error = false) {
		status.textContent = message;
		status.hidden = !message;
		status.toggleAttribute("data-error", error);
	}

	function createTile({ path: project, name, indexPath }) {
		const item = document.createElement("li");
		const header = document.createElement("header");
		const heading = document.createElement(pinnedSection ? "h3" : "h2");
		heading.textContent = heading.title = project;
		header.append(heading);
		const tile = { item, source: null };
		if (newTile) {
			const pin = document.createElement("button");
			pin.type = "button";
			pin.className = "app-pin";
			pin.setAttribute("aria-label", "Pin to Home");
			pin.addEventListener("click", () => togglePin(project, pin));
			tile.pin = pin;

			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "app-delete";
			remove.dataset.deleteApp = project;
			remove.title = "Delete app";
			remove.setAttribute("aria-label", `Delete ${project}`);
			const icon = document.createElement("img");
			icon.alt = "";
			icon.src = "icons/action-edit-delete.svg";
			icon.width = icon.height = 18;
			remove.append(icon);

			const controls = document.createElement("div");
			controls.className = "app-tile-controls";
			controls.append(pin, remove);
			header.append(controls);
		}

		const view = createProjectPreviewLink(project);
		view.title = "Open this app in a new tab";
		view.setAttribute("aria-label", `View ${project} (opens in a new tab)`);
		const artwork = view.cloneNode();
		artwork.className = "app-artwork";
		artwork.tabIndex = -1; // The identical View action in the footer is the keyboard stop.
		const image = document.createElement("img");
		image.alt = "";
		image.hidden = true;
		image.addEventListener("load", () => { image.hidden = !image.naturalWidth; });
		const initials = document.createElement("span");
		initials.textContent = Array.from(name).slice(0, 2).join("");
		artwork.append(image, initials);

		const actions = document.createElement("footer");
		const chat = document.createElement("a");
		chat.textContent = "Chat";
		chat.title = "Build and edit this app with the coding agent";
		chat.href = `chat.html?${new URLSearchParams({ project })}`;
		chat.setAttribute("aria-label", `Chat for ${project}`);
		const code = document.createElement("a");
		code.textContent = "Code";
		code.title = "Edit this app in Code Studio";
		code.href = `code-studio.html?${new URLSearchParams({ file: indexPath })}`;
		code.setAttribute("aria-label", `Code Studio for ${project}`);
		view.textContent = "View";
		actions.append(chat, code, view);
		if (newTile) {
			const download = document.createElement("button");
			download.type = "button";
			download.className = "app-download";
			download.title = "Download as ZIP";
			download.setAttribute("aria-label", `Download ${project} as ZIP`);
			const icon = document.createElement("img");
			icon.alt = "";
			icon.src = "icons/action-document-save-as.svg";
			icon.width = icon.height = 18;
			download.append(icon);
			download.addEventListener("click", async () => {
				if (download.getAttribute("aria-disabled") === "true") return;
				download.setAttribute("aria-disabled", "true");
				download.title = "Preparing ZIP…";
				try {
					const { name, blob } = await vfs.archive.exportFolder(project);
					downloadVfsBlob(blob, name);
				} catch (error) {
					notice(`Could not download ${project} as ZIP. ${error?.message || error}`, true);
				} finally {
					download.removeAttribute("aria-disabled");
					download.title = "Download as ZIP";
				}
			});
			actions.append(download);
		}
		item.append(header, artwork, actions);
		return Object.assign(tile, { chat, image });
	}

	function setPin(pin, pinned) {
		pin.setAttribute("aria-pressed", String(pinned));
		pin.title = pinned ? "Unpin from Home" : "Pin to Home";
	}

	async function togglePin(project, pin) {
		if (pin.getAttribute("aria-disabled") === "true") return;
		const pinned = pin.getAttribute("aria-pressed") !== "true";
		pin.setAttribute("aria-disabled", "true");
		const name = vfs.baseName(project);
		try {
			await catalog.setPinned(project, pinned);
			await refresh();
			notice(pinned ? `Pinned ${name} to Home.` : `Unpinned ${name} from Home.`);
		} catch (error) {
			notice(error.message || String(error), true);
		} finally {
			pin.removeAttribute("aria-disabled");
		}
	}

	function setArtwork(tile, source, type) {
		if (tile.source === source && tile.artworkType === type) return;
		tile.source = source;
		tile.artworkType = type;
		if (tile.image.hasAttribute("src")) URL.revokeObjectURL(tile.image.src);
		tile.image.hidden = true;
		if (source === null) tile.image.removeAttribute("src");
		else tile.image.src = URL.createObjectURL(new Blob([source], { type }));
	}

	async function refresh() {
		const id = ++request;
		const apps = await catalog.list();
		if (id !== request) return;
		const visible = pinnedSection ? apps.filter(app => app.pinned) : apps;
		if (visible.length !== tiles.size || visible.some(app => !tiles.has(app.path))) {
			const next = new Map(visible.map(app => [app.path, tiles.get(app.path) ?? createTile(app)]));
			for (const [path, tile] of tiles) {
				if (!next.has(path)) setArtwork(tile, null);
			}
			tiles = next;
			const children = Array.from(tiles.values(), tile => tile.item);
			if (newTile) children.push(newTile);
			list.replaceChildren(...children);
		}
		if (pinnedSection) pinnedSection.hidden = visible.length === 0;
		if (loading) loading.hidden = true;
		list.setAttribute("aria-busy", "false");

		for (const { path, pinned, artwork } of visible) {
			const tile = tiles.get(path);
			if (tile.pin) setPin(tile.pin, pinned);
			if (!artwork) {
				setArtwork(tile, null);
				continue;
			}
			vfs.getasync(artwork.path).then(
				value => { if (id === request) setArtwork(tile, value ?? null, artwork.type); },
				() => { if (id === request) setArtwork(tile, null); }
			);
		}
	}

	function enableAppCreation() {
		const dialog = document.getElementById("project-dialog");
		const form = document.getElementById("project-form");
		const nameInput = document.getElementById("project-name");
		const errorMessage = document.getElementById("project-error");
		const cancel = document.getElementById("project-cancel");
		const create = document.getElementById("project-create");
		open.addEventListener("click", () => {
			form.reset();
			errorMessage.hidden = true;
			dialog.showModal();
		});
		cancel.addEventListener("click", () => dialog.close());
		dialog.addEventListener("cancel", event => { if (creating) event.preventDefault(); });
		form.addEventListener("submit", async event => {
			event.preventDefault();
			if (creating) return;
			const name = nameInput.value.trim();
			if (!name || name.startsWith(".") || /[\\/\u0000-\u001f\u007f]/.test(name)) {
				errorMessage.textContent = "Enter a folder name without slashes, control characters, or a leading dot.";
				errorMessage.hidden = false;
				nameInput.focus();
				return;
			}
			creating = create.disabled = cancel.disabled = true;
			errorMessage.hidden = true;
			try {
				const path = await catalog.create(name);
				dialog.close();
				notice(`Created ${vfs.baseName(path)}.`);
				await refresh();
				tiles.get(path)?.chat.focus();
			} catch (error) {
				if (dialog.open) {
					errorMessage.textContent = error.message || String(error);
					errorMessage.hidden = false;
				} else notice(error.message || String(error), true);
			} finally { creating = create.disabled = cancel.disabled = false; }
		});
		open.disabled = false;
	}

	function enableAppDeletion() {
		const form = document.getElementById("app-delete-form");
		const path = document.getElementById("app-delete-path");
		const errorMessage = document.getElementById("app-delete-error");
		const cancel = document.getElementById("app-delete-cancel");
		const confirm = document.getElementById("app-delete-confirm");
		let project;
		let deleting = false;

		list.addEventListener("click", event => {
			const button = event.target.closest("button[data-delete-app]");
			if (!button || deleteDialog.open || deleting || vfs.wasReset) return;
			project = path.textContent = button.dataset.deleteApp;
			errorMessage.hidden = true;
			deleteDialog.showModal();
		});
		cancel.addEventListener("click", () => deleteDialog.close());
		deleteDialog.addEventListener("cancel", event => {
			if (deleting) event.preventDefault();
		});
		form.addEventListener("submit", async event => {
			event.preventDefault();
			if (!deleteDialog.open || deleting || vfs.wasReset) return;
			const target = project;
			deleting = cancel.disabled = confirm.disabled = true;
			errorMessage.hidden = true;
			try {
				await vfs.deleteTree(target);
			} catch (error) {
				errorMessage.textContent = `Could not delete the app. ${error?.message || error}`;
				errorMessage.hidden = false;
				return;
			} finally {
				deleting = cancel.disabled = confirm.disabled = false;
			}
			deleteDialog.close();
			if (vfs.wasReset) return;
			try {
				await refresh();
				notice(`Deleted ${target}.`);
			} catch (error) {
				notice(`Deleted ${target}. Could not refresh the app list. ${error?.message || error}`, true);
			}
			if (document.activeElement === document.body) open.focus();
		});
	}

	try {
		vfs = await window.vfsReady;
		catalog = new ProjectCatalog(vfs);
		window.addEventListener("vfs-reset", event => {
			if (!event.detail?.cleared) return;
			request += 1;
			for (const tile of tiles.values()) setArtwork(tile, null);
			tiles.clear();
			list.replaceChildren(...(newTile ? [newTile] : []));
			if (pinnedSection) pinnedSection.hidden = true;
			if (loading) loading.hidden = true;
			list.setAttribute("aria-busy", "false");
			if (open) open.disabled = true;
			document.getElementById("project-dialog")?.close();
			deleteDialog?.close();
			notice("Workspace cleared. Reload to start a fresh workspace.");
		});
		await refresh();
		if (open && !vfs.wasReset) enableAppCreation();
		if (deleteDialog && !vfs.wasReset) enableAppDeletion();
		const refreshApps = () => {
			if (!creating && !vfs.wasReset) refresh().catch(error => notice(error.message || String(error), true));
		};
		window.addEventListener("focus", refreshApps);
		window.addEventListener("pageshow", event => {
			if (event.persisted) refreshApps();
		});
	} catch (error) {
		if (loading) loading.hidden = true;
		list.setAttribute("aria-busy", "false");
		notice(error.message || String(error), true);
	}
})();
