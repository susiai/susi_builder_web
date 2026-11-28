"use strict";

(async () => {
	const get = id => document.getElementById(id);
	const filter = get("skill-filter"), list = get("skill-list"), preview = get("skill-preview");
	const edit = get("edit-skill"), empty = get("skill-empty"), status = get("skills-status");
	const install = get("install-skills");
	const deleteDialog = get("delete-skill-dialog"), deleteName = get("delete-skill-name");
	const markdown = window.markdownit({ html: false }).disable("image");
	let skills, paths = [], selected, request = 0, busy = false;
	let enabled = new Set();
	let activationReady = false;
	let hasMissingDefaults = false;
	let pendingDelete;

	async function refreshDefaults() {
		try {
			hasMissingDefaults = (await skills.missingDefaults(paths)).length > 0;
			install.title = "";
		} catch (error) {
			hasMissingDefaults = false;
			install.title = "Could not read default skills. " + (error.message || error);
		}
		updateInstallButton();
	}

	function updateInstallButton() {
		install.disabled = busy || !hasMissingDefaults;
	}

	function showList() {
		const query = filter.value.trim().toLowerCase();
		const rows = paths.filter(path => (path + " " + SkillLibrary.displayName(path)).toLowerCase().includes(query)).map(path => {
			const row = document.createElement("div");
			const toggle = document.createElement("input");
			toggle.type = "checkbox";
			toggle.dataset.skill = path;
			toggle.checked = enabled.has(path);
			toggle.disabled = busy || !activationReady;
			toggle.setAttribute("aria-label", `Allow Chat agents to use ${path}`);
			toggle.title = "Allow Chat agents to find and use this skill";
			const link = document.createElement("a");
			link.href = "?" + new URLSearchParams({ file: path });
			link.textContent = path;
			if (path === selected) link.setAttribute("aria-current", "true");
			const remove = document.createElement("button");
			remove.type = "button";
			remove.dataset.deleteSkill = path;
			remove.disabled = busy;
			remove.title = `Delete ${path}`;
			remove.setAttribute("aria-label", remove.title);
			const icon = document.createElement("img");
			icon.src = "icons/action-edit-delete.svg";
			icon.alt = "";
			remove.append(icon);
			row.append(toggle, link, remove);
			return row;
		});
		list.replaceChildren(...rows);
		if (!rows.length) list.textContent = paths.length ? "No matching files." : "No Markdown files in /Skills/ yet.";
	}

	async function open(path, remember = true) {
		const current = ++request;
		selected = paths.includes(path) ? path : paths[0];
		preview.hidden = edit.hidden = true;
		empty.hidden = false;
		empty.textContent = selected ? "Reading skill…" : "Add the bundled examples or write a skill in Skill Creator.";
		showList();
		if (!selected) return;
		try {
			const skill = await skills.read(selected);
			if (current !== request) return;
			const doc = new DOMParser().parseFromString(markdown.render(skill.content), "text/html");
			// A document heading sits under the Skills page heading.
			for (const heading of doc.querySelectorAll("h1")) {
				const sectionHeading = doc.createElement("h2");
				sectionHeading.textContent = heading.textContent;
				heading.replaceWith(sectionHeading);
			}
			for (const link of doc.querySelectorAll("a[href]")) {
				link.target = "_blank";
				link.rel = "noopener noreferrer";
			}
			preview.replaceChildren(...doc.body.childNodes);
			edit.href = "code-studio.html?" + new URLSearchParams({ file: skills.filePath(skill.path) });
			preview.hidden = edit.hidden = false;
			empty.hidden = true;
			if (remember) pageSettings.save("skills", { file: skill.path });
		} catch (error) {
			if (current === request) empty.textContent = "Could not open the skill. " + error.message;
		}
	}

	filter.addEventListener("input", showList);
	list.addEventListener("click", event => {
		const button = event.target.closest("button[data-delete-skill]");
		if (button && !busy) {
			pendingDelete = button.dataset.deleteSkill;
			deleteName.textContent = pendingDelete;
			deleteDialog.returnValue = "";
			deleteDialog.showModal();
			return;
		}
		const link = event.target.closest("a[href]");
		if (!link || location.protocol === "file:" || event.button !== 0 || event.metaKey || event.ctrlKey ||
			event.shiftKey || event.altKey) return;
		event.preventDefault();
		history.replaceState(null, "", link.href);
		open(new URL(link.href).searchParams.get("file"));
	});

	function setBusy(value) {
		busy = value;
		updateInstallButton();
		for (const toggle of list.querySelectorAll("input[data-skill]")) {
			toggle.disabled = value || !activationReady;
			if (!value) toggle.checked = enabled.has(toggle.dataset.skill);
		}
		for (const remove of list.querySelectorAll("button[data-delete-skill]")) remove.disabled = value;
	}

	deleteDialog.addEventListener("close", async () => {
		const path = pendingDelete;
		pendingDelete = undefined;
		if (deleteDialog.returnValue !== "delete" || !path || busy) return;
		setBusy(true);
		try {
			enabled = await skills.delete(path);
			const wasSelected = selected === path;
			paths = await skills.list();
			await refreshDefaults();
			await open(selected, false);
			if (wasSelected) await pageSettings.save("skills", { file: selected ?? null });
			const url = new URL(location.href);
			if (url.searchParams.get("file") === path) {
				url.searchParams.delete("file");
				try { history.replaceState(null, "", url); }
				catch { location.replace(url); }
			}
			status.textContent = `Deleted ${path}.`;
			(list.querySelector('[aria-current="true"]') || filter).focus();
		} catch (error) {
			status.textContent = "Could not delete the skill. " + (error.message || error);
		} finally { setBusy(false); }
	});

	list.addEventListener("change", async event => {
		const toggle = event.target;
		if (!toggle.matches("input[data-skill]") || !activationReady || busy) return;
		const path = toggle.dataset.skill;
		const checked = toggle.checked;
		const focused = document.activeElement === toggle;
		setBusy(true);
		try {
			enabled = await skills.setEnabled(path, checked);
			status.textContent = checked ? `${path} is available to Chat agents.` : `${path} is disabled for Chat agents.`;
		} catch (error) {
			status.textContent = "Could not save skill activation. " + (error.message || error);
		} finally {
			setBusy(false);
			if (focused && toggle.isConnected && document.activeElement === document.body) toggle.focus();
		}
	});

	install.addEventListener("click", async () => {
		if (install.disabled) return;
		setBusy(true);
		try {
			const added = await skills.installDefaults();
			status.textContent = added ? `Added ${added} default ${added === 1 ? "skill" : "skills"}.` : "All default skills are already present.";
		} catch (error) {
			status.textContent = "Could not add defaults. " + (error.message || error);
		} finally {
			try {
				paths = await skills.list();
				await refreshDefaults();
				enabled = await skills.readEnabled();
				activationReady = true;
				await open(selected);
			} catch (error) {
				status.textContent = "Could not refresh the skill list. " + (error.message || error);
			} finally { setBusy(false); }
		}
	});

	try {
		skills = new SkillLibrary(await window.vfsReady);
		paths = await skills.list();
		let activationError;
		try {
			enabled = await skills.readEnabled();
			activationReady = true;
		} catch (error) { activationError = error; }
		const linked = new URL(location.href).searchParams.get("file");
		const requested = linked || (await pageSettings.read("skills")).file;
		await open(requested, Boolean(linked));
		if (activationError) status.textContent = "Could not read skill activation. " + (activationError.message || activationError);
		else if (requested && !paths.includes(requested)) status.textContent = "That skill is no longer in the library.";
		else status.textContent = "";
		setBusy(false);
	} catch (error) {
		status.textContent = "Could not open the workspace. " + (error.message || error);
		return;
	}

	await refreshDefaults();

	// Other workspace pages can add or remove skills while this page remains open.
	window.addEventListener("focus", async () => {
		if (busy) return;
		try {
			const [current, approvals] = await Promise.all([skills.list(), skills.readEnabled()]);
			if (busy) return;
			enabled = approvals;
			activationReady = true;
			if (current.length === paths.length && current.every((path, index) => path === paths[index])) {
				setBusy(false);
				return;
			}
			paths = current;
			await refreshDefaults();
			await open(selected, false);
		} catch (error) {
			status.textContent = "Could not refresh the skill list. " + (error.message || error);
		}
	});
})();
