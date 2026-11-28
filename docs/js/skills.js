"use strict";

globalThis.SkillLibrary = (() => {
	const root = "/Skills/";
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const markdownPath = path => typeof path === "string" && /\.md$/i.test(path) &&
		path.split("/").every(part => part && part !== "." && part !== "..") && !/[\\\x00-\x1f\x7f]/.test(path);
	const normalize = text => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

	function enabledPaths(config) {
		const enabled = config.pages?.skills?.enabled;
		return new Set(Array.isArray(enabled) ? enabled.filter(markdownPath) : []);
	}

	return class SkillLibrary {
		#vfs;
		#defaults;

		constructor(vfs) { this.#vfs = vfs; }

		static validName(name) {
			return typeof name === "string" && name.trim().length > 0 && name.length <= 80 &&
				![".", ".."].includes(name.trim()) && !/[\\/\x00-\x1f\x7f]/.test(name);
		}

		static displayName(path) { return path.split("/").at(-1).replace(/\.md$/i, "").replace(/[-_]+/g, " "); }

		filePath(path) {
			if (!markdownPath(path)) throw new Error("Choose a Markdown file in /Skills/.");
			return root + path;
		}

		async list() { return (await this.#vfs.ls(root)).filter(markdownPath); }

		async read(path) {
			const { bytes } = await this.#vfs.fileSystem.readFile(this.filePath(path));
			const content = decoder.decode(bytes);
			const title = content.match(/^#\s+([^\r\n]+)$/m)?.[1].trim() || SkillLibrary.displayName(path);
			return { path, title, content };
		}

		async readEnabled() { return enabledPaths(await new WorkspaceConfigStore(this.#vfs).read()); }

		async #changeApproval(path, enabled, file) {
			// The same VFS transaction owns the file check/change and the config store's edit.
			const storage = file ? { update: (key, edit) => this.#vfs.fileSystem.updateWithFile(key, edit, file) } : this.#vfs;
			const saved = await new WorkspaceConfigStore(storage).update(config => {
				const next = enabledPaths(config);
				if (next.has(path) === enabled) return;
				if (enabled) next.add(path);
				else next.delete(path);
				return { ...config, pages: { ...config.pages, skills: { ...config.pages?.skills, enabled: [...next] } } };
			});
			return enabledPaths(saved);
		}

		async setEnabled(path, enabled) {
			const target = this.filePath(path);
			if (typeof enabled !== "boolean") throw new TypeError("Choose whether the skill is enabled.");
			return this.#changeApproval(path, enabled, enabled ? { action: "require", path: target } : undefined);
		}

		#createFile(path, value) {
			return this.#changeApproval(path, false, { action: "create", path: this.filePath(path), value });
		}

		async create(name, body) {
			if (!SkillLibrary.validName(name)) throw new Error("Enter a name of up to 80 characters without slashes or control characters.");
			const text = typeof body === "string" ? body.trim() : "";
			if (!text || text.length > 15000) throw new Error("Enter skill text of up to 15,000 characters.");
			const title = name.trim();
			const path = title + ".md";
			await this.#createFile(path, `# ${title}\n\n${text}\n`);
			return path;
		}

		async delete(path) {
			return this.#changeApproval(path, false, { action: "remove", path: this.filePath(path) });
		}

		async #loadDefaults() {
			const entries = await this.#vfs.readDefaults(path => path.startsWith(root));
			const defaults = [];
			for (const { path, value } of entries) {
				if (!path.startsWith(root) || !/\.md$/i.test(path)) continue;
				const relative = path.slice(root.length);
				this.filePath(relative);
				defaults.push({ path: relative, value });
			}
			return defaults;
		}

		async #missingEntries(paths) {
			this.#defaults ??= this.#loadDefaults().catch(error => {
				this.#defaults = undefined;
				throw error;
			});
			const defaults = await this.#defaults;
			const present = new Set(paths ?? await this.list());
			return defaults.filter(entry => !present.has(entry.path));
		}

		async missingDefaults(paths) { return (await this.#missingEntries(paths)).map(entry => entry.path); }

		async installDefaults() {
			let added = 0;
			for (const { path, value } of await this.#missingEntries()) {
				try {
					await this.#createFile(path, value);
					added++;
				} catch (error) {
					// Another page may have installed or created the file since we listed it.
					if (error.code !== "EEXIST") throw error;
				}
			}
			return added;
		}

		async search(query, signal) {
			if (typeof query !== "string" || query.length > 200) throw new Error("Enter a skill query of up to 200 characters.");
			const terms = [...new Set(normalize(query).match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 12);
			if (!terms.length) throw new Error("Enter at least one keyword for the skill search.");
			const enabled = await this.readEnabled();
			const matches = [];
			for (const path of enabled.size ? await this.list() : []) {
				signal?.throwIfAborted();
				if (!enabled.has(path)) continue;
				let skill;
				try {
					if ((await this.#vfs.fileSystem.stat(this.filePath(path))).size > 128 * 1024) continue;
					skill = await this.read(path);
				} catch (error) {
					if (error.code === "ENOENT" || error instanceof TypeError) continue;
					throw error;
				}
				const heading = normalize(skill.title + " " + SkillLibrary.displayName(path));
				const content = normalize(skill.content);
				const rank = terms.reduce((score, term) => score + (heading.includes(term) ? 4 : content.includes(term) ? 1 : 0), 0);
				if (rank) matches.push({ path, rank, title: skill.title.slice(0, 160), content: skill.content.slice(0, 16000),
					truncated: skill.content.length > 16000 });
			}
			// A skill can be disabled while search is reading its Markdown.
			const current = matches.length ? await this.readEnabled() : enabled;
			signal?.throwIfAborted();
			const available = matches.filter(skill => current.has(skill.path))
				.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
			return { query, total: available.length, matches: available.slice(0, 3).map(({ rank, ...skill }) => skill) };
		}
	};
})();
