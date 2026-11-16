"use strict";

(async () => {
	const $ = id => document.getElementById(id);
	const backupStatus = $("backup-status");
	const backupFile = $("backup-file");
	const restorePassphrase = $("restore-passphrase");
	const restorePassphraseField = $("restore-passphrase-field");
	const restore = $("backup-restore");
	const restoreDialog = $("backup-restore-dialog");
	const restoreConfirm = $("backup-restore-confirm");
	const clearButton = $("open-vfs-reset");
	const resetDefaults = $("open-default-files-reset");
	const resetDialog = $("vfs-reset-dialog");
	const resetConfirm = $("confirm-vfs-reset");
	const resetStatus = $("vfs-reset-status");
	const resetError = $("vfs-reset-error");
	const actions = [$("backup-export"), $("backup-inspect"), $("backup-safety"), backupFile, restorePassphrase,
		$("backup-restore-cancel"), clearButton, resetDefaults, $("cancel-vfs-reset"), resetConfirm];
	let vfs;
	let busy = false;
	let ready = false;
	let persistent;
	let inspected;
	let readRequest = 0;
	let clearWorkspace = false;

	function notice(text, error = false) {
		backupStatus.textContent = text;
		backupStatus.toggleAttribute("data-error", error);
	}

	function controls() {
		const locked = busy || !ready;
		for (const action of actions) action.disabled = locked;
		restore.disabled = restoreConfirm.disabled = locked || !inspected;
		$("storage-persist").disabled = locked || !navigator.storage?.persist || persistent !== false;
	}

	async function run(action, report = error => notice(error.message || String(error), true), { openDatabase = true } = {}) {
		if (!ready || busy) return;
		busy = true;
		controls();
		try {
			// An explicit action can reopen the database after Clear. Workspace opens without defaults.
			if (openDatabase && (!vfs || vfs.wasReset)) vfs = await (globalThis.vfsReady = openVfs());
			await action();
		}
		catch (error) { report(error); }
		finally { busy = false; controls(); }
	}

	function clearInspection() {
		if (inspected) notice("");
		inspected = undefined;
		readRequest++;
		$("backup-summary").textContent = "";
	}

	function clearRestorePassphrase() {
		restorePassphrase.value = "";
		restorePassphraseField.hidden = true;
	}

	function encodeWorkspace(snapshot, local) {
		// Pinned model downloads can be restored from their sources and exceed the archive limit.
		const entries = snapshot.entries.filter(entry =>
			!stt.modelPaths.has(entry.path) && !tts.modelPaths.has(entry.path));
		return susiBackup.encode({ ...snapshot, entries }, { local });
	}

	function download(result, stem = "workspace-backup") {
		const url = URL.createObjectURL(result.blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${stem}-${new Date().toISOString().slice(0, 10)}.${result.extension}`;
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	}

	$("backup-export").onclick = () => run(async () => {
		notice("Reading a consistent workspace snapshot…");
		const snapshot = await vfs.recovery.read();
		download(await encodeWorkspace(snapshot));
		notice("Backup created. Keep the file outside browser storage; session API keys are excluded.");
	});
	for (const input of [backupFile, restorePassphrase]) input.addEventListener("input", () => {
		if (input === backupFile) clearRestorePassphrase();
		clearInspection();
		controls();
	});
	$("backup-inspect").onclick = () => run(async () => {
		const file = backupFile.files[0];
		if (!file) { notice("Choose a workspace backup first.", true); return; }
		clearInspection();
		const request = readRequest;
		notice("Validating workspace backup…");
		const snapshot = await susiBackup.decode(file, restorePassphrase.value);
		const current = await vfs.recovery.read();
		const expectedDigest = await vfsSnapshotDigest(current.entries);
		if (request !== readRequest) return;
		inspected = { snapshot, expectedDigest };
		let endpoint = "";
		try { endpoint = JSON.parse(snapshot.entries.find(entry => entry.path === "config.json")?.value || "{}").apihost || ""; }
		catch { /* Keep the backup summary available with a malformed model configuration. */ }
		$("backup-summary").textContent = `${snapshot.entries.length} file/folder entries, ` +
			`${snapshot.local.length} conversation/preferences records. ` + (endpoint ? `Model endpoint in backup: ${endpoint}.` : "");
		notice("Backup validated. Review the replacement scope before restoring.");
	}, error => {
		if (error.code === "BACKUP_PASSPHRASE_REQUIRED") restorePassphraseField.hidden = false;
		notice(error.message || String(error), true);
	});
	restore.onclick = () => {
		$("backup-restore-error").textContent = "";
		restoreDialog.showModal();
	};
	$("backup-restore-cancel").onclick = () => { if (!busy) restoreDialog.close(); };
	restoreConfirm.onclick = () => run(async () => {
		if (!inspected) return;
		const { snapshot, expectedDigest } = inspected;
		// Restored executions are historical records, never resumable owners of project writes.
		const activity = snapshot.entries.find(entry => entry.path === ".webstation/workspace.json");
		if (typeof activity?.value === "string") {
			try {
				const state = JSON.parse(activity.value);
				for (const run of state.runs || []) if (run.status === "running") {
					run.status = "interrupted";
					run.leaseUntil = 0;
					run.error = "Restored from backup; review files before starting a new run.";
					const task = state.tasks?.find(task => task.latestRun === run.id);
					if (task) task.status = "interrupted";
				}
				activity.value = JSON.stringify(state, null, 2);
			} catch { /* Preserve malformed user data for repair in Code Studio. */ }
		}
		await susiBackup.restore(vfs, snapshot, expectedDigest);
		try { sessionStorage.setItem("webstation.backup-restored", "1"); } catch {}
		location.reload();
	}, error => { $("backup-restore-error").textContent = error.message || String(error); });
	$("backup-safety").onclick = () => run(async () => {
		const snapshot = await vfs.recovery.getSafety();
		if (!snapshot) throw new Error("No previous restore snapshot exists.");
		const backup = await encodeWorkspace(snapshot, snapshot.local || []);
		download(backup, "workspace-before-restore");
	});
	$("storage-persist").onclick = () => run(async () => {
		persistent = await navigator.storage.persist();
		$("storage-status").textContent = persistent ?
			"Persistent storage granted. Downloaded backups are still recommended." :
			"The browser kept best-effort storage. Save downloaded backups regularly.";
	}, error => { $("storage-status").textContent = error.message || String(error); }, { openDatabase: false });

	function showReset(clear) {
		clearWorkspace = clear;
		const action = (clear ? clearButton : resetDefaults).textContent;
		$("vfs-reset-title").textContent = action + "?";
		resetConfirm.textContent = action;
		$("vfs-reset-warning").hidden = !clear;
		$("default-files-reset-warning").hidden = clear;
		resetDialog.setAttribute("aria-describedby", clear ? "vfs-reset-warning" : "default-files-reset-warning");
		resetError.textContent = "";
		resetDialog.showModal();
	}
	clearButton.onclick = () => showReset(true);
	resetDefaults.onclick = () => showReset(false);
	for (const dialog of [restoreDialog, resetDialog]) dialog.addEventListener("cancel", event => {
		if (busy) event.preventDefault();
	});
	resetConfirm.onclick = () => run(async () => {
		clearInspection();
		const label = resetConfirm.textContent;
		resetConfirm.textContent = clearWorkspace ? "Clearing…" : "Restoring…";
		resetDialog.setAttribute("aria-busy", "true");
		resetError.textContent = "";
		resetStatus.textContent = "";
		try {
			if (clearWorkspace) {
				await susiBackup.clearWorkspace(() => {
					resetError.textContent = "Close other tabs using this workspace to finish clearing the database.";
				});
				vfs = null;
				globalThis.vfsReady = Promise.resolve(null);
				$("backup-safety").hidden = true;
				$("storage-status").textContent = "";
				notice("");
				backupFile.value = "";
				clearRestorePassphrase();
				resetStatus.textContent = "Workspace cleared. Apps, conversations, and console history were deleted.";
			} else {
				await vfs.resetDefaultFiles();
				resetStatus.textContent = "Default files restored.";
			}
			resetDialog.close();
		} finally {
			resetConfirm.textContent = label;
			resetDialog.removeAttribute("aria-busy");
		}
	}, error => {
		if (error?.name !== "AbortError") {
			resetError.textContent = error?.message || (clearWorkspace
				? "Unable to clear the workspace database." : "Unable to restore the default files.");
		}
	}, { openDatabase: !clearWorkspace });

	controls();
	try { vfs = await window.vfsReady; }
	catch (error) {
		notice(error.message || String(error), true);
		resetStatus.textContent = error?.message || "Unable to open the VFS.";
		return;
	}
	try {
		const [estimate, persisted, safety] = await Promise.all([
			navigator.storage?.estimate?.(), navigator.storage?.persisted?.(), vfs?.recovery.hasSafety()
		]);
		persistent = Boolean(persisted);
		$("storage-origin").textContent = `Workspace origin: ${location.origin === "null" ?
			"local files (browser-specific isolation)" : location.origin}`;
		$("storage-status").textContent = estimate?.quota ?
			`${(estimate.usage / 1048576).toFixed(1)} MiB used of ${(estimate.quota / 1048576).toFixed(0)} MiB. ` +
			`${persistent ? "Persistent" : "Best-effort"} browser storage.` : "Storage estimates are unavailable in this context.";
		$("backup-safety").hidden = !safety;
		try {
			if (sessionStorage.getItem("webstation.backup-restored")) {
				notice("Workspace restored. The previous workspace is available as a safety backup.");
				sessionStorage.removeItem("webstation.backup-restored");
			}
		} catch { /* The previous workspace remains available in storage. */ }
	} catch (error) { notice(error.message || String(error), true); }
	ready = true;
	controls();
})();
