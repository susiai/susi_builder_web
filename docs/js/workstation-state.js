"use strict";

function parseWorkstationState(source) {
	const state = source === undefined ? { version: 1, tasks: [], runs: [] } : JSON.parse(source);
	const statuses = ["queued", "running", "completed", "failed", "stopped", "interrupted"];
	const project = value => typeof value === "string" && value !== "/" && value.startsWith("/") && value.endsWith("/") &&
		!/[\\\x00-\x1f\x7f]/.test(value) && !value.slice(1, -1).split("/").some(part => !part || part === "." || part === "..");
	const profile = value => ["builder", "planner", "reviewer", "browser"].includes(value);
	const id = value => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
	if (!state || state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.runs) ||
		state.tasks.length > 5000 || state.runs.length > 1000) throw new Error("Unsupported workspace record. Export it before repair.");
	const ids = new Set();
	for (const task of state.tasks) {
		if (!task || !id(task.id) || ids.has(task.id) || !project(task.project) || !profile(task.profile) ||
			typeof task.title !== "string" || task.title.length > 160 || typeof task.prompt !== "string" ||
			task.prompt.length > 50000 || !statuses.includes(task.status) ||
			(task.archived !== undefined && typeof task.archived !== "boolean") || !task.title.trim() || !task.prompt.trim() ||
			(task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || task.dependsOn.length > 20 || !task.dependsOn.every(id)))) {
			throw new Error("Invalid saved task. Repair the workspace record in Code Studio.");
		}
		ids.add(task.id);
	}
	const tasksById = new Map(state.tasks.map(task => [task.id, task]));
	const incoming = new Map(); const outgoing = new Map(); const ready = [];
	for (const task of state.tasks) {
		const dependencies = task.dependsOn || [];
		if (dependencies.some(id => !tasksById.has(id) || id === task.id || tasksById.get(id).project !== task.project)) throw new Error("Invalid task prerequisite.");
		incoming.set(task.id, dependencies.length);
		for (const id of dependencies) { if (!outgoing.has(id)) outgoing.set(id, []); outgoing.get(id).push(task.id); }
		if (!dependencies.length) ready.push(task.id);
	}
	for (let i = 0; i < ready.length; i += 1) for (const id of outgoing.get(ready[i]) || []) {
		incoming.set(id, incoming.get(id) - 1); if (incoming.get(id) === 0) ready.push(id);
	}
	if (ready.length !== state.tasks.length) throw new Error("Task prerequisites contain a cycle.");
	const runIds = new Set();
	for (const run of state.runs) {
		if (!run || !id(run.id) || runIds.has(run.id) || !project(run.project) || !profile(run.profile) ||
			typeof run.owner !== "string" || typeof run.prompt !== "string" || run.prompt.length > 50000 ||
			!statuses.slice(1).includes(run.status) || !Number.isFinite(run.leaseUntil) ||
			(run.events !== undefined && !Array.isArray(run.events))) throw new Error("Invalid saved run.");
		runIds.add(run.id);
	}
	return state;
}

// The small index owns task transitions/leases. Each run has a separate, bounded activity file.
function createWorkstationStore(vfs, path = "/.webstation/workspace.json") {
	const owner = newVfsGeneration();
	const leaseDuration = 120000;
	const logRoot = path === "/.webstation/workspace.json" ? "/.webstation/runs/" : path + ".runs/";
	const logPath = id => logRoot + id + ".json";
	const fence = id => ({ path, runId: id, owner });
	function changed(id) {
		window.dispatchEvent(new Event("workstation-change"));
		try { const channel = new BroadcastChannel("webstation.runs.v1"); channel.postMessage({ type: "changed", id }); channel.close(); } catch {}
	}
	async function change(operation) {
		let result;
		await vfs.update(path, source => {
			const state = parseWorkstationState(source);
			result = operation(state);
			return JSON.stringify(state, null, 2);
		});
		changed(); return result;
	}
	function ownedRun(state, id) {
		const run = state.runs.find(item => item.id === id);
		if (!run || run.owner !== owner || run.status !== "running" || run.leaseUntil <= Date.now()) {
			throw new Error("This run no longer belongs to this page. Start a new run to continue.");
		}
		return run;
	}
	function recover(state) {
		for (const run of state.runs) {
			if (run.status !== "running" || run.leaseUntil > Date.now()) continue;
			run.status = "interrupted"; run.error = "The page closed or stopped responding. Review files before running again.";
			run.updatedAt = Date.now();
			const task = state.tasks.find(item => item.id === run.taskId);
			if (task?.latestRun === run.id) task.status = run.status;
		}
	}
	async function readIndex() {
		let source;
		try { source = await vfs.getasync(path); } catch (error) { if (error !== "Key not found") throw error; }
		return parseWorkstationState(source);
	}
	async function withActivity(run) {
		try {
			const log = JSON.parse(await vfs.getasync(logPath(run.id)));
			if (log.version !== 1 || log.runId !== run.id || !Array.isArray(log.events)) throw new Error("Invalid run activity.");
			return { ...run, result: log.result ?? run.result, events: log.events, eventsTruncated: log.truncated, totalEvents: log.total };
		} catch (error) {
			if (error !== "Key not found") throw error;
			return { ...run, events: run.events || [] };
		}
	}
	return {
		fence, logPath,
		async read({ events = true } = {}) {
			const state = await readIndex();
			if (events) state.runs = await Promise.all(state.runs.map(withActivity));
			return state;
		},
		async getRun(id) {
			const state = await readIndex(); const run = state.runs.find(item => item.id === id);
			if (!run) throw new Error("Run not found.");
			return withActivity(run);
		},
		async recover() {
			const state = await readIndex();
			if (state.runs.some(run => run.status === "running" && run.leaseUntil <= Date.now())) await change(recover);
		},
		createTask({ title, prompt, project, profile = "builder", dependsOn = [] }) {
			return change(state => {
				if (state.tasks.filter(task => !task.archived).length >= 500) throw new Error("Archive tasks before adding more than 500 active tasks.");
				const task = { id: newVfsGeneration(), title: title.trim(), prompt: prompt.trim(), project, profile,
					dependsOn: [...new Set(dependsOn)], status: "queued", createdAt: Date.now(), updatedAt: Date.now(), latestRun: null };
				if (!task.title || !task.prompt) throw new Error("Enter a task title and instructions.");
				if (task.dependsOn.some(id => !state.tasks.some(item => item.id === id && item.project === project))) throw new Error("Choose dependencies in this project.");
				state.tasks.unshift(task); parseWorkstationState(JSON.stringify(state)); return task;
			});
		},
		updateTask(id, edits, expectedUpdatedAt) {
			return change(state => {
				const task = state.tasks.find(item => item.id === id);
				if (!task || task.status === "running") throw new Error("Stop the task before editing it.");
				if (expectedUpdatedAt !== undefined && task.updatedAt !== expectedUpdatedAt) throw new Error("Task changed in another page. Reload Workspace.");
				if (edits.archived === false && task.archived && state.tasks.filter(item => !item.archived).length >= 500) throw new Error("Active task limit reached.");
				const changedGoal = ["title", "prompt", "profile", "dependsOn"].some(key => Object.hasOwn(edits, key) && JSON.stringify(edits[key]) !== JSON.stringify(task[key]));
				for (const key of ["title", "prompt", "profile", "archived", "dependsOn"]) if (Object.hasOwn(edits, key)) task[key] = edits[key];
				if (changedGoal) { task.review = undefined; task.latestRun = null; task.status = "queued"; }
				task.updatedAt = Date.now(); parseWorkstationState(JSON.stringify(state)); return task;
			});
		},
		async start({ taskId = null, project, profile, prompt }) {
			const discarded = [];
			const run = await change(state => {
				recover(state);
				if (state.runs.some(run => run.status === "running" &&
					(run.project.startsWith(project) || project.startsWith(run.project)))) {
					throw new Error("Another agent is working in this directory tree. Stop it before starting another run.");
				}
				const task = taskId && state.tasks.find(item => item.id === taskId);
				if (taskId && (!task || task.project !== project || task.archived)) throw new Error("The task is unavailable in this project.");
				if (task?.dependsOn?.some(id => state.tasks.find(item => item.id === id)?.review?.decision !== "approved")) {
					throw new Error("Review and approve prerequisite tasks before starting this task.");
				}
				const run = { id: newVfsGeneration(), taskId, project, profile, prompt, owner, status: "running",
					startedAt: Date.now(), updatedAt: Date.now(), leaseUntil: Date.now() + leaseDuration };
				state.runs.unshift(run);
				let finished = 0;
				state.runs = state.runs.filter(item => {
					if (item.status === "running" || ++finished <= 100) return true;
					discarded.push(item.id); return false;
				});
				if (task) { task.status = "running"; task.latestRun = run.id; task.review = undefined; task.updatedAt = Date.now(); }
				parseWorkstationState(JSON.stringify(state)); return run;
			});
			for (const id of discarded) await vfs.rm(logPath(id));
			return run;
		},
		heartbeat(id) { return change(state => { const run = ownedRun(state, id); run.leaseUntil = Date.now() + leaseDuration; }); },
		async append(id, event) {
			if (!event || typeof event.type !== "string" || typeof event.content !== "string") throw new Error("Invalid activity event.");
			await vfs.update(logPath(id), source => {
				const log = source ? JSON.parse(source) : { version: 1, runId: id, events: [], total: 0, characters: 0 };
				if (log.version !== 1 || log.runId !== id || !Array.isArray(log.events)) throw new Error("Invalid activity record.");
				const content = event.content.slice(0, 8000);
				log.events.push({ type: event.type.slice(0, 64), name: String(event.name || "").slice(0, 128), content,
					excerpt: event.content.length > content.length, at: Date.now() });
				log.total += 1; log.characters += content.length;
				while ((log.events.length > 200 || log.characters > 65536) && log.events.length > 2) {
					log.characters -= log.events.shift().content.length; log.truncated = true;
				}
				return JSON.stringify(log);
			}, { guard: fence(id) });
			changed(id);
		},
		async finish(id, status, result = "", error = "") {
			if (!["completed", "failed", "stopped"].includes(status)) throw new Error("Invalid run status.");
			await vfs.update(logPath(id), source => {
				const log = source ? JSON.parse(source) : { version: 1, runId: id, events: [], total: 0, characters: 0 };
				log.result = result.slice(0, 50000); return JSON.stringify(log);
			}, { guard: fence(id) });
			return change(state => {
				const run = ownedRun(state, id);
				Object.assign(run, { status, result: result.slice(0, 2000), error: String(error).slice(0, 2000), updatedAt: Date.now(), leaseUntil: 0 });
				const task = state.tasks.find(item => item.id === run.taskId);
				if (task?.latestRun === id) { task.status = status; task.updatedAt = Date.now(); }
			});
		},
		reviewRun(id, decision, note = "", expectedReviewAt) {
			if (!["approved", "changes_requested"].includes(decision) || typeof note !== "string" || note.length > 4000) throw new Error("Invalid review.");
			return change(state => {
				const run = state.runs.find(item => item.id === id);
				if (!run || run.status === "running" || (decision === "approved" && run.status !== "completed")) throw new Error("Only completed agent work can be approved.");
				if (expectedReviewAt !== undefined && (run.review?.at ?? null) !== expectedReviewAt) throw new Error("The review changed in another page. Reload it before saving.");
				run.review = { decision, note, at: Date.now() };
				const task = state.tasks.find(item => item.latestRun === id);
				if (task) { task.review = run.review; task.updatedAt = Date.now(); }
			});
		}
	};
}
