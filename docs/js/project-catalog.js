"use strict";

// The VFS shares its app directory and index-file convention with folder ZIP import and export.
globalThis.ProjectCatalog = (() => {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const artworkTypes = [
		["app.svg", "image/svg+xml"],
		["app.png", "image/png"],
		["favicon.svg", "image/svg+xml"]
	];

	function projectPaths(entries) {
		return entries.filter(isVfsProjectIndex)
			.map(path => "/" + path.slice(0, -"index.html".length))
			.sort((a, b) => a.localeCompare(b));
	}

	return class ProjectCatalog {
		#vfs;

		constructor(vfs) { this.#vfs = vfs; }

		async listPaths() { return projectPaths(await this.#vfs.ls("/")); }

		async list() {
			const entries = await this.#vfs.ls("/");
			const files = new Set(entries);
			return Promise.all(projectPaths(entries).map(async path => {
				const folder = path.slice(1);
				// Apps without a readable manifest still open from the catalog.
				const manifest = files.has(folder + "app.json") ? await this.readManifest(path).catch(() => null) : null;
				const image = artworkTypes.find(([name]) => files.has(folder + name));
				return {
					path, name: this.#vfs.baseName(path), indexPath: path + "index.html",
					manifest, pinned: manifest?.pinned === true,
					artwork: image ? { path: path + image[0], type: image[1] } : null
				};
			}));
		}

		async create(name, { entries, indexHtml = "", reuseMatching = false } = {}) {
			const files = entries ?? [
				{ path: "index.html", value: indexHtml },
				{ path: "app.json", value: JSON.stringify({ version: 1, name, pinned: false }, null, 2) + "\n" }
			];
			if (!files.some(entry => entry.path === "index.html")) throw new Error("An app needs an index.html file.");
			return this.#vfs.addFolderTree(name, files, { parent: VFS_APPS_DIRECTORY, reuseMatching });
		}

		#manifestPath(project) {
			const folder = this.#vfs.fileSystem.resolvePath("/", project);
			if (folder === "/" || folder + "/" !== project ||
				!isVfsProjectIndex(project.slice(1) + "index.html")) throw new Error("Choose a project folder.");
			return project + "app.json";
		}

		async #readManifestFile(path) {
			let file;
			try { file = await this.#vfs.fileSystem.readFile(path); }
			catch (error) {
				if (error?.code === "ENOENT") return null;
				throw error;
			}
			try {
				const manifest = JSON.parse(decoder.decode(file.bytes));
				if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError();
				return { file, manifest };
			} catch {
				throw new Error("Fix the JSON object in " + path + " before changing its pin.");
			}
		}

		async readManifest(project) {
			const current = await this.#readManifestFile(this.#manifestPath(project));
			return current?.manifest ?? null;
		}

		async setPinned(project, pinned) {
			if (typeof pinned !== "boolean") throw new TypeError("Choose whether the project is pinned.");
			const path = this.#manifestPath(project);
			if ((await this.#vfs.fileSystem.stat(project + "index.html")).isDirectory) throw new Error("An app needs an index.html file.");
			const current = await this.#readManifestFile(path);
			const manifest = { ...(current?.manifest ?? { version: 1, name: this.#vfs.baseName(project) }), pinned };
			const value = JSON.stringify(manifest, null, 2) + "\n";
			await this.#vfs.fileSystem.write(path, value, current ? { expectedFile: current.file } : { exclusive: true });
			return manifest;
		}
	};
})();
