"use strict";

(async () => {
	const $ = id => document.getElementById(id);
	const status = $("tasks-status");
	const inferenceClient = llmClient.create();
	let store;
	let vfs, catalog;
	let state;
	let projects = [];
	let selectedRun;
	let rememberedProject;
	const page = new URL(location.href);
	const requestedProject = page.searchParams.get("project");
	const filter = $("tasks-filter-project");
	let filterProject;
	let refreshing = false;
	let addingTask = false;
	let disposed = false;
	let rendered;
	let modelRequest = 0;
	let detailRequest = 0;
	let detailRendered;
	let profiles = Object.fromEntries(agentProfileDefaults.map(profile => [profile.id, profile]));
	function notice(message, error = false) {
		status.textContent = message;
		status.toggleAttribute("data-error", error);
	}
	function element(tag, text) { const node = document.createElement(tag); node.textContent = text; return node; }
	function link(label, url) { const node = element("a", label); node.href = url; return node; }
	function badge(value) { const node = element("span", value); node.className = "workspace-status"; node.dataset.status = value; return node; }
	function chatLink(project, task) { return "chat.html?" + new URLSearchParams(task ? { project, task } : { project }); }
	async function showRun() {
		const host = $("tasks-run-detail");
		const token = ++detailRequest;
		const entry = state?.runs.find(item => item.id === selectedRun && inSelectedProject(item));
		if (!entry) { host.hidden = true; return; }
		if (host.dataset.run === entry.id && host.contains(document.activeElement) &&
			document.activeElement.matches("input, textarea")) return;
		const run = await store.getRun(entry.id);
		if (token !== detailRequest) return;
		host.hidden = !run;
		const signature = JSON.stringify(run);
		if (detailRendered === signature) return;
		detailRendered = signature;
		host.dataset.run = entry.id;
		if (!run) return;
		host.replaceChildren(element("h3", run.prompt.slice(0, 100)), badge(run.status), element("p", run.project));
		if (run.error) host.append(element("p", run.error));
		if (run.result) host.append(element("pre", run.result.replace(/^(?:[ \t]*\r?\n)+/, "")));
		const links = document.createElement("div"); links.className = "workspace-actions";
		const follow = element("button", "Create follow-up task"); follow.type = "button";
		follow.onclick = () => {
			$("tasks-project").value = run.project;
			render();
			$("tasks-profile").value = run.profile === "planner" ? "builder" : "reviewer";
			$("tasks-task-name").value = "Follow up: " + run.prompt.slice(0, 100);
			$("tasks-prompt").value = ("Continue this task in the current project:\n" + run.prompt + "\n\nPrevious agent result:\n" +
				(run.result || "No final answer.")).slice(0, 30000);
			$("tasks-dependency").value = run.taskId || "";
			$("tasks-options").open = true;
			describeProfile(); $("tasks-task-name").focus();
		};
		links.append(follow); host.append(links);
		if (run.status !== "running") {
			host.append(element("p", run.review ? `Review: ${run.review.decision}` : "Agent finished; human review is still required."));
			const form = document.createElement("form");
			const label = element("label", "Review notes"); const notes = document.createElement("textarea");
			notes.id = "tasks-review-notes"; notes.maxLength = 4000; notes.rows = 2; notes.value = run.review?.note || ""; label.htmlFor = notes.id;
			const approve = element("button", "Approve result"); approve.type = "submit"; approve.value = "approved"; approve.disabled = run.status !== "completed";
			const revise = element("button", "Request changes"); revise.type = "submit"; revise.value = "changes_requested";
			form.append(label, notes, approve, revise); form.onsubmit = async event => {
				event.preventDefault();
				try { await store.reviewRun(run.id, event.submitter.value, notes.value, run.review?.at ?? null); await refresh(); }
				catch (error) { notice(error.message, true); }
			}; host.append(form);
		}
		if (run.eventsTruncated) host.append(element("p", "Older activity was trimmed to keep this run's log bounded."));
		for (const event of run.events) {
			const detail = document.createElement("details");
			const kind = event.type === "tool-request" ? "request" : event.type === "tool-result" ? "result" : event.type;
			const label = event.name ? `${event.name} · ${kind}` : kind;
			detail.append(element("summary", `${new Date(event.at).toLocaleTimeString()} · ${label}`),
				element("pre", (event.content || "") + (event.excerpt ? "\n[excerpt]" : "")));
			host.append(detail);
		}
		if (!run.events.length) host.append(element("p", "No tool calls recorded."));
	}
	function inSelectedProject(item) { return !filterProject || item.project === filterProject; }
	function render() {
		const filterable = new Set([...projects, ...state.tasks.map(task => task.project),
			...state.runs.map(run => run.project)]);
		if (filterProject) filterable.add(filterProject);
		filter.replaceChildren(new Option("All projects", ""), ...Array.from(filterable, path => new Option(path, path)));
		filter.value = filterProject;
		filter.disabled = false;
		$("tasks-task-form").inert = false;
		$("tasks-show-archived").disabled = false;
		$("tasks-no-projects").hidden = Boolean(projects.length);
		const selected = $("tasks-project").value || rememberedProject;
		$("tasks-project").replaceChildren(...projects.map(project => new Option(vfs.baseName(project), project)));
		if (projects.includes(selected)) $("tasks-project").value = selected;
		describeProfile();
		$("tasks-create-task").disabled = addingTask || !projects.length;
		const dependency = $("tasks-dependency").value;
		$("tasks-dependency").replaceChildren(new Option("No prerequisite", ""), ...state.tasks.filter(task => !task.archived && task.project === $("tasks-project").value)
			.map(task => new Option(task.title, task.id)));
		if ([...$("tasks-dependency").options].some(option => option.value === dependency)) $("tasks-dependency").value = dependency;
		const tasks = state.tasks.filter(task => inSelectedProject(task) && ($("tasks-show-archived").checked || !task.archived));
		$("tasks-task-empty").hidden = Boolean(tasks.length);
		$("tasks-tasks").replaceChildren(...tasks.map(task => {
			const item = document.createElement("li");
			const actions = document.createElement("div"); actions.className = "workspace-actions";
			actions.append(badge(task.status));
			if (task.review) actions.append(badge(task.review.decision));
			const blocked = task.dependsOn?.some(id => state.tasks.find(item => item.id === id)?.review?.decision !== "approved");
			if (task.archived) actions.append(badge("archived"));
			if (blocked) actions.append(element("small", "Waiting for prerequisite review"));
			if (projects.includes(task.project) && task.status !== "running" && !task.archived && !blocked) {
				actions.append(link(task.status === "queued" ? "Open in Chat →" : "Open again in Chat →", chatLink(task.project, task.id)));
			}
			if (task.latestRun && state.runs.some(run => run.id === task.latestRun)) {
				const result = element("button", "View run"); result.type = "button"; result.dataset.run = task.latestRun;
				actions.append(result);
			}
			if (task.status !== "running") {
				const edit = element("button", "Edit task"); edit.type = "button"; edit.onclick = () => {
					$("tasks-edit-id").value = task.id; $("tasks-edit-revision").value = task.updatedAt || "";
					$("tasks-edit-title").value = task.title; $("tasks-edit-prompt").value = task.prompt;
					$("tasks-edit-dependency").replaceChildren(new Option("No prerequisite", ""), ...state.tasks
						.filter(item => item.id !== task.id && item.project === task.project).map(item => new Option(item.title, item.id)));
					$("tasks-edit-dependency").value = task.dependsOn?.[0] || "";
					$("tasks-edit-error").textContent = "";
					$("tasks-edit-dialog").showModal();
				};
				const archive = element("button", task.archived ? "Unarchive" : "Archive"); archive.type = "button";
				archive.onclick = async () => { try { await store.updateTask(task.id, { archived: !task.archived }, task.updatedAt); await refresh(); }
					catch (error) { notice(error.message, true); } };
				actions.append(edit, archive);
			}
			item.append(element("strong", task.title), element("p", `${task.project} · ${profiles[task.profile]?.name || task.profile}`),
				element("p", task.prompt.slice(0, 240)), actions);
			return item;
		}));
		const runs = state.runs.filter(inSelectedProject);
		$("tasks-run-empty").hidden = Boolean(runs.length);
		$("tasks-runs").replaceChildren(...runs.slice(0, 15).map(run => {
			const item = document.createElement("li");
			const actions = document.createElement("div"); actions.className = "workspace-actions";
			const button = element("button", "View activity"); button.type = "button"; button.dataset.run = run.id;
			actions.append(badge(run.status), button);
			if (run.status === "running") {
				const stop = element("button", "Stop run"); stop.type = "button"; stop.dataset.stop = run.id; actions.append(stop);
			}
			item.append(element("strong", run.prompt.slice(0, 80)), element("p", `${run.project} · ${new Date(run.startedAt).toLocaleString()}`), actions);
			return item;
		}));
		showRun().catch(error => notice(error.message, true));
	}
	async function refresh() {
		if (refreshing || !store || disposed) return;
		refreshing = true;
		try {
			await store.recover();
			[state, profiles] = await Promise.all([store.read({ events: false }), readAgentProfiles()]);
			projects = await catalog.listPaths();
			const signature = JSON.stringify([projects, state.tasks, state.runs.map(({ leaseUntil, ...run }) => run)]);
			if (signature === rendered) return;
			rendered = signature;
			render();
		} catch (error) { notice(error.message || String(error), true); }
		finally { refreshing = false; }
	}
	async function refreshModel() {
		if (!vfs || disposed) return;
		const request = ++modelRequest;
		const loading = $("tasks-model-loading");
		const warning = $("tasks-model-warning");
		const label = $("tasks-model");
		try {
			const config = await readLLMConfig();
			if (disposed || request !== modelRequest) return;
			renderModelProgress(loading);
			const model = await inferenceClient.selectModel(config).status({
				onProgress(state) {
					if (disposed || request !== modelRequest) return;
					warning.hidden = true;
					renderModelProgress(loading, state);
				}
			});
			if (disposed || request !== modelRequest) return;
			warning.hidden = model.ready;
			warning.querySelector("strong").textContent = model.message || "No model active.";
			label.hidden = !model.ready;
			label.textContent = model.ready ? `Model · ${model.label}` : "";
		} catch (error) {
			if (!disposed && request === modelRequest) notice(error.message || String(error), true);
		} finally { if (!disposed && request === modelRequest) renderModelProgress(loading); }
	}
	for (const profile of agentProfileDefaults) $("tasks-profile").add(new Option(profile.name, profile.id));
	function describeProfile() { $("tasks-profile-help").textContent = profiles[$("tasks-profile").value].description; }
	$("tasks-profile").addEventListener("change", () => {
		describeProfile(); pageSettings.save("tasks", { profile: $("tasks-profile").value });
	}); describeProfile();
	$("tasks-project").addEventListener("change", () => {
		rememberedProject = $("tasks-project").value;
		pageSettings.save("tasks", { project: rememberedProject }); render();
	});
	$("tasks-show-archived").addEventListener("change", () => {
		pageSettings.save("tasks", { showArchived: $("tasks-show-archived").checked }); render();
	});
	filter.addEventListener("change", () => {
		filterProject = filter.value;
		if (filterProject) page.searchParams.set("project", filterProject);
		else page.searchParams.delete("project");
		history.replaceState(null, "", page);
		if (projects.includes(filterProject) && !$("tasks-task-name").value && !$("tasks-prompt").value) {
			$("tasks-project").value = filterProject;
		}
		pageSettings.save("tasks", { filterProject });
		render();
	});
	$("tasks-edit-cancel").onclick = () => $("tasks-edit-dialog").close();
	$("tasks-edit-form").onsubmit = async event => {
		event.preventDefault(); event.submitter.disabled = true;
		try { await store.updateTask($("tasks-edit-id").value,
			{ title: $("tasks-edit-title").value.trim(), prompt: $("tasks-edit-prompt").value.trim(),
				dependsOn: $("tasks-edit-dependency").value ? [$("tasks-edit-dependency").value] : [] },
			$("tasks-edit-revision").value ? Number($("tasks-edit-revision").value) : undefined);
			$("tasks-edit-dialog").close(); await refresh();
		} catch (error) { $("tasks-edit-error").textContent = error.message; }
		finally { event.submitter.disabled = false; }
	};
	$("tasks-task-form").addEventListener("submit", async event => {
		event.preventDefault();
		if (addingTask) return;
		addingTask = $("tasks-create-task").disabled = true;
		try {
			const project = $("tasks-project").value, profile = $("tasks-profile").value;
			await store.createTask({ title: $("tasks-task-name").value, prompt: $("tasks-prompt").value,
				project, profile,
				dependsOn: $("tasks-dependency").value ? [$("tasks-dependency").value] : [] });
			pageSettings.save("tasks", { project, profile });
			$("tasks-task-name").value = ""; $("tasks-prompt").value = "";
			notice("Task queued. Choose Open in Chat, review the instructions, and send to begin.");
			await refresh();
		} catch (error) { notice(error.message || String(error), true); }
		finally {
			addingTask = false;
			$("tasks-create-task").disabled = !projects.length;
		}
	});
	$("tasks-main").addEventListener("click", event => {
		const run = event.target.closest("button[data-run]")?.dataset.run;
		if (run) {
			selectedRun = run; pageSettings.save("tasks", { selectedRun: run });
			showRun().then(() => $("tasks-run-detail").scrollIntoView({ block: "start" })).catch(error => notice(error.message, true));
		}
		const stop = event.target.closest("button[data-stop]")?.dataset.stop;
		if (stop) {
			try {
				const channel = new BroadcastChannel("webstation.runs.v1");
				channel.postMessage({ type: "stop", id: stop }); channel.close();
				notice("Stop requested. An unresponsive run is marked interrupted after its lease expires.");
			} catch { notice("Open the Chat page that owns this run and press Stop.", true); }
		}
	});
	try {
		const settings = await pageSettings.read("tasks", await pageSettings.read("workspace"));
		filterProject = requestedProject ?? settings.filterProject ?? "";
		rememberedProject = requestedProject || settings.project;
		selectedRun = settings.selectedRun;
		if (Object.hasOwn(profiles, settings.profile)) $("tasks-profile").value = settings.profile;
		$("tasks-show-archived").checked = settings.showArchived === true;
		describeProfile();
		vfs = await window.vfsReady;
		catalog = new ProjectCatalog(vfs);
		store = new WorkspaceRunStore(vfs);
		void refreshModel();
		await refresh();
	}
	catch (error) { notice(error.message || String(error), true); }
	const timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
	window.addEventListener("focus", refresh);
	window.addEventListener("focus", refreshModel);
	let activityChannel;
	try { activityChannel = new BroadcastChannel("webstation.runs.v1"); activityChannel.onmessage = ({ data }) => {
		if (data?.type !== "changed") return;
		if (data.id === selectedRun) showRun().catch(error => notice(error.message, true));
		refresh();
	}; } catch {}
	window.addEventListener("pagehide", () => { disposed = true; clearInterval(timer); activityChannel?.close(); });
	window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
})();
