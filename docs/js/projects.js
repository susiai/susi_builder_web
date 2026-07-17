"use strict";

(async () => {
	const status = document.getElementById("project-status");
	const loading = document.getElementById("project-loading");
	const list = document.getElementById("project-list");
	const pinnedSection = document.getElementById("pinned-apps");
	const open = document.getElementById("project-new");
	const newTile = open?.closest("li");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const artworkTypes = [
		["app.svg", "image/svg+xml"],
		["app.png", "image/png"],
		["favicon.svg", "image/svg+xml"]
	];
	let vfs;
	let tiles = new Map();
	let request = 0;
	let creating = false;

	function notice(message, error = false) {
		status.textContent = message;
		status.hidden = !message;
		status.toggleAttribute("data-error", error);
	}

	function createTile(project) {
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
			header.append(pin);
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
		initials.textContent = Array.from(vfs.baseName(project)).slice(0, 2).join("");
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
		code.href = `code-studio.html?${new URLSearchParams({ file: project + "index.html" })}`;
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
					const { name, blob } = await vfsZip.exportFolder(vfs, project);
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

	async function readManifest(path) {
		const file = await vfs.fileSystem.readFile(path);
		try {
			const metadata = JSON.parse(decoder.decode(file.bytes));
			if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError();
			return { file, metadata };
		} catch {
			throw new Error(`Fix the JSON object in ${path} before changing its pin.`);
		}
	}

	function setPin(pin, pinned) {
		pin.setAttribute("aria-pressed", String(pinned));
		pin.title = pinned ? "Unpin from Home" : "Pin to Home";
	}

	async function togglePin(project, pin) {
		if (pin.getAttribute("aria-disabled") === "true") return;
		const pinned = pin.getAttribute("aria-pressed") !== "true";
		pin.setAttribute("aria-disabled", "true");
		const path = project + "app.json";
		const name = vfs.baseName(project);
		try {
			const current = await readManifest(path).catch(error => {
				if (error?.code === "ENOENT") return null;
				throw error;
			});
			const metadata = current?.metadata ?? { version: 1, name };
			const value = JSON.stringify({ ...metadata, pinned }, null, 2) + "\n";
			await vfs.fileSystem.write(path, value, current ? { expectedFile: current.file } : { exclusive: true });
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
		const entries = await vfs.ls("/");
		const files = new Set(entries);
		const apps = await Promise.all(findVfsProjects(entries).map(async project => {
			const path = project + "app.json";
			const current = files.has(path.slice(1)) ? await readManifest(path).catch(() => null) : null;
			return { project, pinned: current?.metadata.pinned === true };
		}));
		if (id !== request) return;
		const visible = pinnedSection ? apps.filter(app => app.pinned) : apps;
		if (visible.length !== tiles.size || visible.some(({ project }) => !tiles.has(project))) {
			const next = new Map(visible.map(({ project }) => [project, tiles.get(project) ?? createTile(project)]));
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

		for (const { project, pinned } of visible) {
			const tile = tiles.get(project);
			if (tile.pin) setPin(tile.pin, pinned);
			const artwork = artworkTypes.find(([name]) => files.has(project.slice(1) + name));
			if (!artwork) {
				setArtwork(tile, null);
				continue;
			}
			const [name, type] = artwork;
			vfs.getasync(project + name).then(
				value => { if (id === request) setArtwork(tile, value ?? null, type); },
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
				const path = await createVfsApp(vfs, name);
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

	try {
		vfs = await window.vfsReady;
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
			notice("Workspace cleared. Reload to start a fresh workspace.");
		});
		await refresh();
		if (open && !vfs.wasReset) enableAppCreation();
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
