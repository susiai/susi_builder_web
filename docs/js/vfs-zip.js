"use strict";

const { vfsZip, susiBackup } = (() => {
	const maxArchiveBytes = 64 * 1024 * 1024;
	const maxExpandedBytes = 128 * 1024 * 1024;
	const maxEntries = 20000;

	// Count actual extracted bytes as well as the sizes declared by the archive.
	function createZipEntryReader(maxTotalBytes, limitMessage) {
		let extracted = 0;
		return async (entry, entryLimit) => {
			let length = 0;
			const chunks = [];
			await entry.getData(new WritableStream({ write(chunk) {
				length += chunk.byteLength;
				extracted += chunk.byteLength;
				if (length > entryLimit || extracted > maxTotalBytes) throw new Error(limitMessage);
				chunks.push(chunk);
			} }), { checkSignature: true, checkCrc32: true, useWebWorkers: false });
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return bytes;
		};
	}

	function entryParts(filename, directory) {
		const path = filename.replaceAll("\\", "/");
		const parts = path.replace(/\/$/, "").split("/").filter((part) => part !== ".");
		if (filename.length > 2048 || parts.length > 100 || (!directory && !parts.length) || /^[a-z]:/i.test(parts[0] || "") ||
			parts.some((part) => !part || part === ".." || /[\x00-\x1f\x7f]/.test(part))) {
			throw new Error(`Invalid ZIP path: ${filename}`);
		}
		return parts;
	}

	async function importFolder(vfs, file) {
		if (file.size > maxArchiveBytes) throw new Error("ZIP imports are limited to 64 MiB compressed.");
		const stem = file.name.replace(/\.zip$/i, "").trim();
		const name = !stem || stem === "." || stem === ".." || /[/\\\x00-\x1f\x7f]/.test(stem) || /^[a-z]:/i.test(stem)
			? "Archive"
			: stem;
		const reader = new zip.ZipReader(new zip.BlobReader(file), { useWebWorkers: false, checkCrc32: true });
		const entries = [];
		try {
			const list = await reader.getEntries();
			if (list.length > maxEntries) throw new Error("ZIP imports are limited to 20,000 entries.");
			let expandedBytes = 0;
			for (const entry of list) {
				expandedBytes += entry.uncompressedSize;
				if (entry.encrypted) throw new Error("Password-protected ZIP imports are not supported.");
				if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || expandedBytes > maxExpandedBytes) {
					throw new Error("ZIP imports are limited to 128 MiB unpacked.");
				}
			}
			const archive = list.map((entry) => ({
				entry,
				parts: entryParts(entry.filename, entry.directory)
			})).filter(({ parts }) => parts.length);
			// Older app exports and ordinary folder exports may wrap their contents in one folder.
			const root = archive[0]?.parts[0];
			const singleRoot = archive.every(({ entry, parts }) => parts[0] === root && (parts.length > 1 || entry.directory));
			const wrappedApp = singleRoot && archive.some(({ entry, parts }) =>
				!entry.directory && parts.length === 2 && parts[1] === "index.html");
			const stripRoot = singleRoot && (root === name || wrappedApp);
			const paths = new Map();
			for (const { entry, parts } of archive) {
				const relative = stripRoot ? parts.slice(1) : parts;
				let path = "";
				for (const [index, part] of relative.entries()) {
					path += index === 0 ? part : `/${part}`;
					const isDirectory = index < relative.length - 1 || entry.directory;
					if (paths.has(path) && (!isDirectory || paths.get(path))) {
						throw new Error(`Conflicting ZIP entries: ${path}`);
					}
					paths.set(path, isDirectory ? null : entry);
					if (paths.size > maxEntries) throw new Error("Too many files and folders in this ZIP.");
				}
			}

			const readEntry = createZipEntryReader(maxExpandedBytes, "ZIP extraction limit reached.");
			for (const [path, entry] of paths) {
				if (entry) {
					const bytes = await readEntry(entry, entry.uncompressedSize);
					if (bytes.byteLength !== entry.uncompressedSize) throw new Error("Invalid ZIP entry size.");
					entries.push({ path, value: vfs.fileSystem.fileValue(bytes) });
				} else {
					entries.push({ path: `${path}/`, value: "" });
				}
			}
		} finally {
			await reader.close();
		}
		return entries.some(({ path }) => path === "index.html")
			? createVfsApp(vfs, name, entries)
			: vfs.addFolderTree(name, entries);
	}

	async function exportFolder(vfs, path) {
		const folder = vfs.normalizeDirPath(path);
		const name = vfs.baseName(folder) || "VFS";
		const entries = await vfs.readFolderTree(folder);
		const app = isVfsProjectIndex(folder.slice(1) + "index.html") && entries.some(entry => entry.path === "index.html");
		const prefix = app ? "" : `${name}/`;
		const writer = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { useWebWorkers: false });
		if (prefix) await writer.add(prefix, undefined, { directory: true });
		for (const entry of entries) {
			const filename = prefix + entry.path;
			if (entry.path.endsWith("/")) {
				await writer.add(filename, undefined, { directory: true });
			} else {
				await writer.add(filename, new zip.BlobReader(new Blob([entry.value])));
			}
		}
		return { name: `${name}.zip`, blob: await writer.close() };
	}

	const maxEncryptedBytes = 64 * 1024 * 1024;
	const maxManifestBytes = 8 * 1024 * 1024;
	const magic = new TextEncoder().encode("WSBACKUP0001");
	const localKey = key => key.startsWith("webstation.chat.") || key === "webstation.agent-profile";
	function collectLocal(storage = localStorage) {
		return Array.from({ length: storage.length }, (_, index) => storage.key(index))
			.filter(key => key && localKey(key)).map(key => [key, storage.getItem(key)]);
	}
	function validateLocal(records) {
		if (!Array.isArray(records) || records.length > 2000) throw new Error("Invalid conversation archive.");
		const keys = new Set(); let bytes = 0;
		for (const record of records) {
			if (!Array.isArray(record) || record.length !== 2 || typeof record[0] !== "string" || !localKey(record[0]) ||
				typeof record[1] !== "string" || keys.has(record[0])) throw new Error("Invalid conversation archive.");
			keys.add(record[0]); bytes += record[0].length + record[1].length;
		}
		if (bytes > 5 * 1024 * 1024) throw new Error("Conversation archive is too large for browser storage.");
		return records;
	}
	function replaceLocal(records, storage = localStorage) {
		validateLocal(records);
		const previous = collectLocal(storage);
		try {
			for (const [key] of previous) storage.removeItem(key);
			for (const [key, value] of records) storage.setItem(key, value);
		} catch (error) {
			for (const [key] of records) storage.removeItem(key);
			for (const [key, value] of previous) storage.setItem(key, value);
			throw new Error("Conversation storage is full or unavailable. The previous conversations were restored.", { cause: error });
		}
		return previous;
	}
	function maintenance() {
		const key = "webstation.recovery.active";
		let previous;
		try { previous = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
		if (previous?.expiresAt > Date.now()) throw new Error("Another workspace restore is already in progress.");
		const owner = newVfsGeneration();
		localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + 300000 }));
		return () => { try { if (JSON.parse(localStorage.getItem(key) || "null")?.owner === owner) localStorage.removeItem(key); } catch {} };
	}
	async function withMaintenance(operation, { requireLock = true } = {}) {
		const maintain = async () => {
			const release = maintenance();
			try { return await operation(); } finally { release(); }
		};
		if (!navigator.locks) {
			if (requireLock) throw new Error("Exclusive recovery requires Web Locks. Use a current browser on HTTPS, localhost, or supported local files.");
			return maintain();
		}
		let entered = false;
		return navigator.locks.request("webstation.workspace-maintenance", { ifAvailable: true }, lock => {
			entered = true;
			if (!lock) throw new Error("Another workspace restore or reset is already in progress.");
			return maintain();
		}).catch(error => {
			if (requireLock || entered || error.name !== "SecurityError") throw error;
			return maintain();
		});
	}
	async function clearWorkspace(onBlocked) {
		return withMaintenance(async () => {
			await clearVfsDatabase(onBlocked);
			const storage = localStorage;
			for (const key of Object.keys(storage)) {
				if (key.startsWith("webstation.") && key !== "webstation.recovery.active") storage.removeItem(key);
			}
		}, { requireLock: false });
	}
	async function keyFor(password, salt) {
		if (!crypto.subtle) throw new Error("Encrypted backups require HTTPS, localhost, or a supported local-file context.");
		const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
		return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, material,
			{ name: "AES-GCM", length: 256 }, false, ["decrypt"]);
	}
	async function encode(snapshot, { local = collectLocal() } = {}) {
		validateLocal(local);
		const manifest = { format: "webstation-backup", version: 2, createdAt: new Date().toISOString(), entries: [], local };
		if (snapshot.entries.length > maxEntries) throw new Error("Backup exceeds 20,000 file entries.");
		const writer = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { useWebWorkers: false });
		let total = 0;
		for (const { path, value } of snapshot.entries) {
			if (typeof value !== "string" && !(value instanceof Blob) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
				throw new Error("Unsupported file contents: " + path);
			}
			const kind = typeof value === "string" ? "text" : value instanceof Blob ? "blob" : "bytes";
			const content = new Blob([kind === "text" ? JSON.stringify(value) : value]);
			total += content.size;
			if (total > maxExpandedBytes) throw new Error("Backup exceeds 128 MiB. Export projects separately.");
			const data = "data/" + (manifest.entries.length + 1);
			await writer.add(data, new zip.BlobReader(content));
			manifest.entries.push({ path, data, kind, ...(kind === "text" ? { encoding: "json" } : {}), ...(kind === "blob" ? { mime: value.type } : {}) });
		}
		const manifestText = JSON.stringify(manifest);
		if (new Blob([manifestText]).size > maxManifestBytes) throw new Error("Backup manifest exceeds the 8 MiB limit.");
		await writer.add("manifest.json", new zip.TextReader(manifestText));
		return { blob: await writer.close(), extension: "zip" };
	}
	async function decode(file, password = "") {
		if (file.size > maxExpandedBytes + 10 * 1024 * 1024) throw new Error("Backup file is too large.");
		let archive = file;
		const header = new Uint8Array(await file.slice(0, magic.length + 28).arrayBuffer());
		if (magic.every((byte, index) => header[index] === byte)) {
			if (file.size > maxEncryptedBytes + header.length + 16) throw new Error("Encrypted backup is too large.");
			if (!password) {
				throw Object.assign(new Error("Enter the passphrase for this encrypted backup, then inspect it again."),
					{ code: "BACKUP_PASSPHRASE_REQUIRED" });
			}
			try {
				const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: header.slice(magic.length + 16),
					additionalData: header, tagLength: 128 }, await keyFor(password, header.slice(magic.length, magic.length + 16)),
					await file.slice(header.length).arrayBuffer());
				archive = new Blob([plain]);
			} catch { throw new Error("The passphrase is incorrect or this encrypted backup was damaged."); }
		}
		const reader = new zip.ZipReader(new zip.BlobReader(archive), { useWebWorkers: false });
		try {
			const list = await reader.getEntries();
			if (list.length > maxEntries + 1) throw new Error("Too many backup entries.");
			const maxTotalBytes = maxExpandedBytes + maxManifestBytes;
			const files = new Map(); let total = 0;
			for (const entry of list) {
				if (entry.directory || entry.encrypted || files.has(entry.filename) ||
					(entry.filename !== "manifest.json" && !/^data\/[1-9]\d*$/.test(entry.filename))) throw new Error("Unexpected backup archive entry.");
				total += entry.uncompressedSize;
				if (!Number.isSafeInteger(entry.uncompressedSize) || total > maxTotalBytes) throw new Error("Backup expands beyond the size limit.");
				files.set(entry.filename, entry);
			}
			const readEntry = createZipEntryReader(maxTotalBytes, "Backup extraction limit reached.");
			function read(entry, limit = maxExpandedBytes) {
				if (!entry || entry.uncompressedSize > limit) throw new Error("Missing or oversized backup entry.");
				return readEntry(entry, limit);
			}
			const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
			const manifest = JSON.parse(decoder.decode(await read(files.get("manifest.json"), maxManifestBytes)));
			if (manifest.format !== "webstation-backup" || ![1, 2].includes(manifest.version) || !Array.isArray(manifest.entries)) {
				throw new Error("Unsupported workspace backup.");
			}
			validateLocal(manifest.local);
			files.delete("manifest.json");
			function takeFile(name) {
				const entry = files.get(name);
				if (!entry) throw new Error("Missing or duplicate backup file reference.");
				files.delete(name);
				return entry;
			}
			const entries = [];
			for (const item of manifest.entries) {
				if (typeof item?.path !== "string" || !["text", "bytes", "blob"].includes(item.kind)) throw new Error("Invalid backup file descriptor.");
				const bytes = await read(takeFile(item.data));
				const value = item.kind === "text" ? (item.encoding === "json" ? JSON.parse(decoder.decode(bytes)) : decoder.decode(bytes)) : item.kind === "blob" ?
					new Blob([bytes], { type: typeof item.mime === "string" ? item.mime.slice(0, 160) : "" }) : bytes;
				if (item.kind === "text" && typeof value !== "string") throw new Error("Invalid archived text file.");
				entries.push({ path: item.path, value });
			}
			if (manifest.version === 1) {
				// Older ZIPs included project history. Account for its ZIP members without unpacking them.
				if (!Array.isArray(manifest.checkpoints) || manifest.checkpoints.length > 2000) throw new Error("Invalid legacy backup.");
				for (const record of manifest.checkpoints) {
					if (!Array.isArray(record?.entries)) throw new Error("Invalid legacy backup.");
					for (const item of record.entries) takeFile(item?.data);
				}
			}
			if (files.size) throw new Error("Unreferenced backup data.");
			// Validation is deliberately completed before touching either storage system.
			validateVfsPreload(entries.map(item => ({ ...item, path: "/" + item.path })));
			return { version: 1, project: "/", entries, local: manifest.local };
		} finally { await reader.close(); }
	}
	async function restore(vfs, snapshot, expectedDigest, { storage = localStorage } = {}) {
		validateLocal(snapshot.local || []);
		return withMaintenance(async () => {
			const before = await vfs.recovery.read();
			before.local = collectLocal(storage);
			if (await vfsSnapshotDigest(before.entries) !== expectedDigest) throw new Error("Workspace files changed. Review the backup again.");
			await vfs.recovery.saveSafety(before);
			const previous = replaceLocal(snapshot.local || [], storage);
			try { await vfs.recovery.replace(snapshot, { expectedDigest }); }
			catch (error) { replaceLocal(previous, storage); throw error; }
		});
	}

	return {
		vfsZip: { importFolder, exportFolder },
		susiBackup: { encode, decode, restore, clearWorkspace, collectLocal, replaceLocal, withMaintenance, maxBytes: maxExpandedBytes }
	};
})();
