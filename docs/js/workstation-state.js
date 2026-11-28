"use strict";

globalThis.WorkspaceRunStore = (() => {
	function validateState(state) {
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

	function parseState(source) {
		return validateState(source === undefined ? { version: 1, tasks: [], runs: [] } : JSON.parse(source));
	}

	function newId() {
		return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
	}

	const leaseDuration = 120000;
	function active(run, now) {
		return run?.status === "running" && Number.isFinite(run.leaseUntil) && run.leaseUntil > now;
	}

	function ownedRun(state, id, owner) {
		const run = state?.runs?.find(item => item?.id === id);
		if (!active(run, Date.now()) || run.owner !== owner) {
			throw new Error("The agent run has expired or stopped, or belongs to another owner. This write was not applied.");
		}
		return run;
	}

	function endRun(state, run, status, error, now) {
		Object.assign(run, { status, error, leaseUntil: 0, updatedAt: now });
		const task = typeof run.id === "string" && Array.isArray(state.tasks) &&
			state.tasks.find(task => task?.latestRun === run.id);
		if (task) Object.assign(task, { status, updatedAt: now });
	}

	function interruptRuns(state, restored) {
		const now = Date.now();
		let changed = false;
		for (const run of state.runs) {
			if (run?.status !== "running" || (!restored && active(run, now))) continue;
			endRun(state, run, "interrupted", restored
				? "Restored from backup. Review files before starting a new run."
				: "The page closed or stopped responding. Review files before running again.", now);
			changed = true;
		}
		return changed;
	}

	// Restore may also be used to repair a damaged record. Keep the original contents when unreadable.
	function recoveryState(source) {
		if (typeof source !== "string") return;
		try {
			const state = JSON.parse(source);
			if (Array.isArray(state?.runs)) return state;
		} catch { /* Keep the file available for repair. */ }
	}

	function notifyChange(id) {
		globalThis.dispatchEvent?.(new Event("workstation-change"));
		try {
			const channel = new BroadcastChannel("webstation.runs.v1");
			channel.postMessage({ type: "changed", id });
			channel.close();
		} catch { /* The page can also refresh on focus. */ }
	}

	function readLog(source, id) {
		const log = source === undefined ? { version: 1, runId: id, events: [], total: 0, characters: 0 } : JSON.parse(source);
		if (log?.version !== 1 || log.runId !== id || !Array.isArray(log.events)) throw new Error("Invalid run activity.");
		return log;
	}

	return class WorkspaceRunStore {
		static get defaultPath() { return "/.webstation/workspace.json"; }
		#vfs;
		#path;
		#logRoot;
		#owner = newId();
		#notify;

		constructor(vfs, path = WorkspaceRunStore.defaultPath, { onChange = notifyChange } = {}) {
			this.#vfs = vfs;
			this.#path = path;
			this.#logRoot = path === WorkspaceRunStore.defaultPath ? "/.webstation/runs/" : path + ".runs/";
			this.#notify = onChange;
		}

		// The fence is plain data so it can cross the preview bridge or a browser tab boundary.
		fence(id) { return { path: this.#path, runId: id, owner: this.#owner }; }

		// The VFS supplies the current contents of this path inside its transaction.
		static writeGuard({ path, runId, owner, signal }) {
			if (typeof path !== "string" || !path || typeof runId !== "string" || !runId || typeof owner !== "string" || !owner) {
				throw new Error("Invalid agent write permission.");
			}
			return { path, check(source) {
				signal?.throwIfAborted();
				return ownedRun(source === undefined ? undefined : JSON.parse(source), runId, owner);
			} };
		}

		static hasActiveRun(source) {
			const now = Date.now();
			return recoveryState(source)?.runs.some(run => active(run, now)) ?? false;
		}

		static interruptRestored(source) {
			const state = recoveryState(source);
			return state && interruptRuns(state, true) ? JSON.stringify(state, null, 2) : source;
		}

		logPath(id) { return this.#logRoot + id + ".json"; }

		#serialize(state) {
			// A custom index travels with its files in a backup, even to a fresh VFS connection.
			const record = this.#path.endsWith(WorkspaceRunStore.defaultPath) ? state : { ...state, $susiWorkspaceRunStore: 1 };
			return JSON.stringify(record, null, 2);
		}

		async #change(operation, guard) {
			let result;
			await this.#vfs.update(this.#path, source => {
				const state = parseState(source);
				result = operation(state);
				return this.#serialize(state);
			}, { guard });
			this.#notify();
			return result;
		}

		async #readFile(path) {
			try { return await this.#vfs.getasync(path); }
			catch (error) { if (error !== "Key not found" && error?.code !== "ENOENT") throw error; }
		}

		async #withActivity(run) {
			const source = await this.#readFile(this.logPath(run.id));
			if (source === undefined) return { ...run, events: run.events || [] };
			const log = readLog(source, run.id);
			// The index may have been read just before a concurrent finish committed the full result.
			const result = run.status === "running" ? run.result : log.result ?? run.result;
			return { ...run, result, events: log.events, eventsTruncated: log.truncated, totalEvents: log.total };
		}

		async read({ events = true } = {}) {
			const state = parseState(await this.#readFile(this.#path));
			if (events) state.runs = await Promise.all(state.runs.map(run => this.#withActivity(run)));
			return state;
		}

		async getRun(id) {
			const state = await this.read({ events: false });
			const run = state.runs.find(item => item.id === id);
			if (!run) throw new Error("Run not found.");
			return this.#withActivity(run);
		}

		async recover() {
			const { runs } = await this.read({ events: false });
			const now = Date.now();
			if (runs.some(run => run.status === "running" && !active(run, now))) {
				await this.#change(state => interruptRuns(state, false));
			}
		}

		createTask({ title, prompt, project, profile = "builder", dependsOn = [] }) {
			return this.#change(state => {
				if (state.tasks.filter(task => !task.archived).length >= 500) throw new Error("Archive tasks before adding more than 500 active tasks.");
				const now = Date.now();
				const task = { id: newId(), title: title.trim(), prompt: prompt.trim(), project, profile,
					dependsOn: [...new Set(dependsOn)], status: "queued", createdAt: now, updatedAt: now, latestRun: null };
				if (!task.title || !task.prompt) throw new Error("Enter a task title and instructions.");
				if (task.dependsOn.some(id => !state.tasks.some(item => item.id === id && item.project === project))) throw new Error("Choose dependencies in this project.");
				state.tasks.unshift(task);
				validateState(state);
				return task;
			});
		}

		updateTask(id, edits, expectedUpdatedAt) {
			return this.#change(state => {
				const task = state.tasks.find(item => item.id === id);
				if (!task || task.status === "running") throw new Error("Stop the task before editing it.");
				if (expectedUpdatedAt !== undefined && task.updatedAt !== expectedUpdatedAt) throw new Error("Task changed in another page. Reload Workspace.");
				if (edits.archived === false && task.archived && state.tasks.filter(item => !item.archived).length >= 500) throw new Error("Active task limit reached.");
				const changedGoal = ["title", "prompt", "profile", "dependsOn"].some(key => Object.hasOwn(edits, key) && JSON.stringify(edits[key]) !== JSON.stringify(task[key]));
				for (const key of ["title", "prompt", "profile", "archived", "dependsOn"]) if (Object.hasOwn(edits, key)) task[key] = edits[key];
				if (changedGoal) { task.review = undefined; task.latestRun = null; task.status = "queued"; }
				task.updatedAt = Date.now();
				validateState(state);
				return task;
			});
		}

		async start({ taskId = null, project, profile, prompt }) {
			const { run, discarded } = await this.#change(state => {
				interruptRuns(state, false);
				if (state.runs.some(run => run.status === "running" &&
					(run.project.startsWith(project) || project.startsWith(run.project)))) {
					throw new Error("Another agent is working in this directory tree. Stop it before starting another run.");
				}
				const task = taskId && state.tasks.find(item => item.id === taskId);
				if (taskId && (!task || task.project !== project || task.archived)) throw new Error("The task is unavailable in this project.");
				if (task?.dependsOn?.some(id => state.tasks.find(item => item.id === id)?.review?.decision !== "approved")) {
					throw new Error("Review and approve prerequisite tasks before starting this task.");
				}
				const now = Date.now();
				const run = { id: newId(), taskId, project, profile, prompt, owner: this.#owner, status: "running",
					startedAt: now, updatedAt: now, leaseUntil: now + leaseDuration };
				state.runs.unshift(run);
				const discarded = [];
				let finished = 0;
				state.runs = state.runs.filter(item => {
					if (item.status === "running" || ++finished <= 100) return true;
					discarded.push(item.id);
					return false;
				});
				if (task) Object.assign(task, { status: "running", latestRun: run.id, review: undefined, updatedAt: now });
				validateState(state);
				return { run, discarded };
			});
			for (const id of discarded) await this.#vfs.rm(this.logPath(id));
			return run;
		}

		heartbeat(id) {
			return this.#change(state => {
				const run = ownedRun(state, id, this.#owner);
				run.leaseUntil = Date.now() + leaseDuration;
			}, this.fence(id));
		}

		async append(id, event) {
			if (!event || typeof event.type !== "string" || typeof event.content !== "string") throw new Error("Invalid activity event.");
			await this.#vfs.update(this.logPath(id), source => {
				const log = readLog(source, id);
				const content = event.content.slice(0, 8000);
				log.events.push({ type: event.type.slice(0, 64), name: String(event.name || "").slice(0, 128), content,
					excerpt: event.content.length > content.length, at: Date.now() });
				log.total += 1;
				log.characters += content.length;
				while ((log.events.length > 200 || log.characters > 65536) && log.events.length > 2) {
					log.characters -= log.events.shift().content.length;
					log.truncated = true;
				}
				return JSON.stringify(log);
			}, { guard: this.fence(id) });
			this.#notify(id);
		}

		async finish(id, status, result = "", error = "") {
			if (!["completed", "failed", "stopped"].includes(status)) throw new Error("Invalid run status.");
			await this.#vfs.fileSystem.updateWithFile(this.#path, source => {
				const state = parseState(source);
				const run = ownedRun(state, id, this.#owner);
				run.result = result.slice(0, 2000);
				endRun(state, run, status, String(error).slice(0, 2000), Date.now());
				return this.#serialize(state);
			}, {
				action: "update", path: this.logPath(id), update(source) {
					const log = readLog(source, id);
					log.result = result.slice(0, 50000);
					return JSON.stringify(log);
				}
			}, { guard: this.fence(id) });
			this.#notify(id);
		}

		reviewRun(id, decision, note = "", expectedReviewAt) {
			if (!["approved", "changes_requested"].includes(decision) || typeof note !== "string" || note.length > 4000) throw new Error("Invalid review.");
			return this.#change(state => {
				const run = state.runs.find(item => item.id === id);
				if (!run || run.status === "running" || (decision === "approved" && run.status !== "completed")) throw new Error("Only completed agent work can be approved.");
				if (expectedReviewAt !== undefined && (run.review?.at ?? null) !== expectedReviewAt) throw new Error("The review changed in another page. Reload it before saving.");
				run.review = { decision, note, at: Date.now() };
				const task = state.tasks.find(item => item.latestRun === id);
				if (task) { task.review = run.review; task.updatedAt = run.review.at; }
			});
		}
	};
})();
