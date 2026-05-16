"use strict";

const workspaceSkills = (() => {
	const root = "/Skills/";
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const markdownPath = path => typeof path === "string" && /\.md$/i.test(path) && path.split("/").every(part => part && part !== "." && part !== "..") &&
		!/[\\\x00-\x1f\x7f]/.test(path);
	const normalize = text => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
	const name = path => path.split("/").at(-1).replace(/\.md$/i, "").replace(/[-_]+/g, " ");

	async function list(vfs) {
		return (await vfs.ls(root)).filter(markdownPath);
	}

	async function read(vfs, path) {
		if (!markdownPath(path)) throw new Error("Choose a Markdown file in /Skills/.");
		const { bytes } = await vfs.fileSystem.readFile(root + path);
		const content = decoder.decode(bytes);
		const title = content.match(/^#\s+([^\r\n]+)$/m)?.[1].trim() || name(path);
		return { path, title, content };
	}

	function enabledPaths(config) {
		const enabled = config?.pages?.skills?.enabled;
		return new Set(Array.isArray(enabled) ? enabled.filter(markdownPath) : []);
	}

	async function readEnabled(vfs) {
		try { return enabledPaths(JSON.parse((await vfs.getasync("/config.json")) ?? "{}")); }
		catch (error) {
			if (error === "Key not found") return new Set();
			throw error;
		}
	}

	async function setEnabled(vfs, path, enabled) {
		if (!markdownPath(path)) throw new Error("Choose a Markdown file in /Skills/.");
		let next;
		await vfs.update("/config.json", source => {
			const config = JSON.parse(source ?? "{}");
			if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid workspace configuration.");
			next = enabledPaths(config);
			if (enabled) next.add(path);
			else next.delete(path);
			config.pages = { ...config.pages, skills: { ...config.pages?.skills, enabled: [...next] } };
			return JSON.stringify(config, null, 2);
		});
		return next;
	}

	async function search(vfs, query, signal) {
		if (typeof query !== "string" || query.length > 200) throw new Error("Enter a skill query of up to 200 characters.");
		const terms = [...new Set(normalize(query).match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 12);
		if (!terms.length) throw new Error("Enter at least one keyword for the skill search.");
		const enabled = await readEnabled(vfs);
		const matches = [];
		for (const path of enabled.size ? await list(vfs) : []) {
			signal?.throwIfAborted();
			if (!enabled.has(path)) continue;
			let skill;
			try {
				if ((await vfs.fileSystem.stat(root + path)).size > 128 * 1024) continue;
				skill = await read(vfs, path);
			} catch (error) {
				if (error.code === "ENOENT" || error instanceof TypeError) continue;
				throw error;
			}
			const heading = normalize(skill.title + " " + name(path));
			const content = normalize(skill.content);
			const rank = terms.reduce((score, term) => score + (heading.includes(term) ? 4 : content.includes(term) ? 1 : 0), 0);
			if (rank) matches.push({ path, rank, title: skill.title.slice(0, 160), content: skill.content.slice(0, 16000),
				truncated: skill.content.length > 16000 });
		}
		// A skill can be disabled while the search is reading the library.
		const current = matches.length ? await readEnabled(vfs) : enabled;
		signal?.throwIfAborted();
		const available = matches.filter(skill => current.has(skill.path))
			.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
		return { query, total: available.length, matches: available.slice(0, 3).map(({ rank, ...skill }) => skill) };
	}

	return { root, name, list, read, readEnabled, setEnabled, search };
})();
