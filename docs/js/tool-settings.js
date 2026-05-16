"use strict";

(() => {
	const form = document.getElementById("agent-tools-form");
	const list = document.getElementById("agent-tool-list");
	const status = document.getElementById("agent-tools-status");
	const save = document.getElementById("agent-tools-save");
	const maxToolCalls = document.getElementById("agent-max-tool-calls");
	const client = createLLM();
	const fields = new Map();
	let baseline = {};
	let baselineLimit;
	let loaded = false;
	let saving = false;
	let readRequest = 0;

	for (const { function: tool } of client.listTools({}, { includeBrowser: true })) {
		const item = document.createElement("div");
		const label = document.createElement("label");
		const name = document.createElement("code");
		const field = document.createElement("textarea");
		field.id = `tool-description-${tool.name}`;
		field.name = tool.name;
		field.rows = 3;
		field.value = tool.description;
		field.readOnly = true;
		label.htmlFor = field.id;
		name.textContent = tool.name;
		label.append(name);
		item.append(label, field);
		list.append(item);
		fields.set(tool.name, field);
	}

	function setStatus(text, error = false) {
		status.textContent = text;
		status.toggleAttribute("data-error", error);
	}

	function editedSettings() {
		const descriptions = Object.fromEntries([...fields].filter(([name, field]) => field.value !== baseline[name])
			.map(([name, field]) => [name, field.value]));
		const changes = {};
		if (Object.keys(descriptions).length) changes.toolDescriptions = descriptions;
		if (maxToolCalls.valueAsNumber !== baselineLimit) changes.maxToolCalls = maxToolCalls.valueAsNumber;
		return changes;
	}

	function updateControls() {
		save.disabled = !loaded || saving || !Object.keys(editedSettings()).length;
		form.setAttribute("aria-busy", String(saving));
		for (const field of fields.values()) field.readOnly = !loaded || saving;
		maxToolCalls.readOnly = !loaded || saving;
	}

	function showSettings(settings) {
		baseline = {};
		for (const { function: tool } of client.listTools(settings.toolDescriptions, { includeBrowser: true })) {
			fields.get(tool.name).value = tool.description;
			baseline[tool.name] = tool.description;
		}
		baselineLimit = settings.maxToolCalls;
		maxToolCalls.value = baselineLimit;
		loaded = true;
		updateControls();
	}

	async function refreshSettings() {
		if (saving || (loaded && Object.keys(editedSettings()).length)) return;
		const request = ++readRequest;
		try {
			const settings = await readAgentSettings();
			if (request !== readRequest || saving) return;
			showSettings(settings);
			setStatus(`${fields.size} tools available.`);
		} catch (error) {
			if (request === readRequest) setStatus(`Could not load settings: ${error.message || error}`, true);
		}
	}

	form.addEventListener("input", () => {
		readRequest += 1;
		updateControls();
		setStatus(Object.keys(editedSettings()).length ? "Unsaved changes." : `${fields.size} tools available.`);
	});
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!loaded || saving) return;
		const changes = editedSettings();
		if (!Object.keys(changes).length) return;
		saving = true;
		readRequest += 1;
		updateControls();
		setStatus("Saving settings…");
		try {
			showSettings(await writeAgentSettings(changes, { toolDescriptions: baseline, maxToolCalls: baselineLimit }));
			setStatus("Settings saved. New chat replies will use them.");
		} catch (error) {
			setStatus(`Could not save settings: ${error.message || error}`, true);
		} finally {
			saving = false;
			updateControls();
		}
	});
	window.addEventListener("focus", refreshSettings);
	document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshSettings(); });
	refreshSettings();
})();
