/**
 * Virtual File System (VFS) using IndexedDB with Bash-like Commands
 * (C) 2026 by Michael Peter Christen
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program in the file lgpl21.txt
 * If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * This script implements a simple key-value store using IndexedDB, which is a low-level API
 * for client-side storage of significant amounts of structured data, including files/blobs.
 * This API uses indexes to enable high-performance searches of this data.
 *
 * The VFS provides a set of methods for storing, retrieving, and deleting key-value pairs in an
 * IndexedDB object store, where keys represent paths in a file system-like structure.
 * Paths are delimited by a slash (/) and must start with a leading slash.
 * Paths ending with a slash are considered directories, while paths not ending with a slash are considered files.
 *
 * The VFS includes Bash-like commands for manipulating the virtual file system.
 *
 * The VFS is exposed as a global object in pages and workers.
 */

const vfsSessions = new WeakMap();
const vfsDatabaseName = 'vfs';
const vfsAppRoot = '/.webstation/apps/';
const vfsChatTerminalRoot = '/Apps/chat-terminal/';
const vfsChatTerminalSeed = 'bundled-chat-terminal';
const vfsChatTerminalVersion = 4;
const vfsSkillsSeed = 'bundled-skills';
const vfsStandaloneApp = typeof document !== 'undefined' &&
  document.currentScript?.hasAttribute('data-vfs-standalone');
const vfsSkipPreload = typeof document !== 'undefined' &&
  document.currentScript?.hasAttribute('data-vfs-skip-preload');
const vfsScriptURL = typeof document !== 'undefined' ? document.currentScript.src
  : new URL(/\/js\/[^/]*$/.test(location.pathname) ? 'vfs.js' : 'js/vfs.js', location.href).href;
const vfsPreloadOverride = globalThis.VFS_PRELOAD_URL;
const vfsPreloadIndexURL = vfsStandaloneApp ? null : new URL(vfsPreloadOverride || '../vfs-preload.json', vfsScriptURL);
const vfsTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
let vfsPreloadRequest;

function newVfsGeneration() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateVfsPreload(entries) {
  const records = new Map();
  const explicitPaths = new Set();
  for (const { path, value } of entries) {
    if (typeof path !== 'string' || !path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path)) {
      throw new Error('Invalid VFS preload path.');
    }
    const directory = path.endsWith('/');
    const parts = path.slice(1, directory ? -1 : undefined).split('/');
    if (parts.some(part => !part || part === '.' || part === '..') || explicitPaths.has(path)) {
      throw new Error(`Invalid or duplicate VFS preload path: ${path}`);
    }
    explicitPaths.add(path);
    const counterpart = directory ? path.slice(0, -1) : path + '/';
    if (records.has(counterpart)) throw new Error(`File and folder conflict in VFS preload: ${path}`);
    if (!directory && typeof value !== 'string' && !(value instanceof Blob) &&
      !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
      throw new Error(`Missing or invalid VFS preload contents: ${path}`);
    }
    let parent = '';
    for (const part of parts.slice(0, -1)) {
      parent += '/' + part;
      if (records.has(parent)) throw new Error(`File used as a folder in VFS preload: ${parent}`);
      records.set(parent + '/', '');
    }
    const content = directory ? '' : value;
    records.set(path, content instanceof ArrayBuffer ? content.slice(0)
      : ArrayBuffer.isView(content) ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength).slice()
      : content);
  }
  return Array.from(records, ([path, value]) => ({ path, value }));
}

function vfsFileValue(data) {
  try {
    const text = vfsTextDecoder.decode(data);
    if (!text.includes('\0')) return text;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  return data;
}

async function fetchVfsDefaults(include) {
  async function read(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to read ${url.pathname} (HTTP ${response.status}).`);
    return response;
  }
  const paths = await (await read(vfsPreloadIndexURL)).json();
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
    throw new Error('Invalid VFS preload file list.');
  }
  // Validate the entire layout before requesting files. Each path is relative to the raw defaults directory.
  const entries = validateVfsPreload(paths.map(path => ({ path: '/' + path, value: '' })));
  const selected = include ? entries.filter(entry => include(entry.path)) : entries;
  const files = selected.filter(entry => !entry.path.endsWith('/'));
  const directoryURL = new URL('../vfs-preload/', vfsPreloadIndexURL);
  await Promise.all(files.map(async entry => {
    const relative = entry.path.slice(1).split('/').map(encodeURIComponent).join('/');
    const response = await read(new URL(relative, directoryURL));
    entry.value = vfsFileValue(new Uint8Array(await response.arrayBuffer()));
  }));
  return selected;
}

// Classic scripts can deliver installed resources when a file: page cannot fetch sibling files.
// The script element owns the callback so concurrent loads never share a result.
async function readInstalledResource(url) {
  let value;
  const receive = resource => { value = resource; };
  if (typeof document === 'undefined') {
    // Classic workers load scripts synchronously and have no currentScript element.
    globalThis.susiSource = receive;
    try { importScripts(url.href); }
    finally { delete globalThis.susiSource; }
  } else {
    const script = document.createElement('script');
    script.susiSource = receive;
    script.src = url.href;
    try {
      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Unable to load ${url.pathname}.`));
        document.head.append(script);
      });
    } finally { script.remove(); }
  }
  if (value === undefined) throw new Error(`Missing resource data in ${url.pathname}.`);
  return value;
}

async function readPackagedVfsDefaults(include) {
  // Reset reads the current installation even when this tab already loaded an earlier version.
  const url = new URL('vfs-preload.js', vfsPreloadIndexURL);
  url.searchParams.set('read', Date.now());
  const files = await readInstalledResource(url);
  const selected = include ? files.filter(([path]) => include('/' + path)) : files;
  return validateVfsPreload(selected.map(([path, encoded]) => ({
    path: '/' + path,
    value: path.endsWith('/') ? '' : vfsFileValue(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)))
  })));
}

function loadVfsPreload(include) {
  if (!vfsPreloadIndexURL) return Promise.resolve([]);
  const read = vfsPreloadOverride && vfsPreloadIndexURL.protocol !== 'file:' ? fetchVfsDefaults : readPackagedVfsDefaults;
  if (include) return read(include);
  if (!vfsPreloadRequest) {
    // The bundle is published with the site, including on hosts that serve only docs/.
    const request = read();
    vfsPreloadRequest = request.finally(() => { vfsPreloadRequest = undefined; });
  }
  return vfsPreloadRequest;
}

async function initializeVfsDatabase(database, loadDefaults = loadVfsPreload) {
  // A standalone app can open the shared database before the workspace installs its defaults.
  const workspaceKey = async store => {
    const range = vfsDirectoryRange('/', true);
    const key = await vfsRequest(store.getKey(range));
    return key?.startsWith(vfsAppRoot)
      ? vfsRequest(store.getKey(IDBKeyRange.bound(vfsDirectoryRange(vfsAppRoot).upper, range.upper, false, true)))
      : key;
  };
  const readState = (store, metadata) => Promise.all([
    vfsRequest(metadata.get('state')),
    workspaceKey(store)
  ]);
  const initializedState = async (metadata, state) => {
    if (state?.initialized) return state;
    const initial = { initialized: true, generation: newVfsGeneration() };
    await vfsRequest(metadata.put(initial, 'state'));
    return initial;
  };
  // Opening an existing workspace can reuse its initialized state.
  const [opened, path] = await vfsTransaction(database, 'readonly', readState);
  checkVfsGeneration(vfsSessions.get(database), opened);
  const seedChatTerminal = loadDefaults === loadVfsPreload && !vfsPreloadOverride;
  let state;
  if (path !== undefined) {
    state = opened?.initialized ? opened : await vfsTransaction(database, 'readwrite', async (store, metadata) => {
      const [current, existingPath] = await readState(store, metadata);
      if (existingPath !== undefined) return initializedState(metadata, current);
    });
  }
  if (!state) {
    const defaults = validateVfsPreload(await loadDefaults());
    state = await vfsTransaction(database, 'readwrite', async (store, metadata) => {
      // Another tab may have written a file or reset the workspace while the defaults loaded.
      const [current, existingPath] = await readState(store, metadata);
      if (existingPath === undefined && current?.generation === opened?.generation) {
        for (const { path, value } of defaults) await vfsRequest(store.add({ id: path, value }));
        if (loadDefaults === loadVfsPreload) await vfsRequest(metadata.put(true, vfsSkillsSeed));
        if (seedChatTerminal && defaults.some(entry => entry.path === vfsChatTerminalRoot + 'index.html')) {
          await vfsRequest(metadata.put(vfsChatTerminalVersion, vfsChatTerminalSeed));
        }
      }
      return initializedState(metadata, current);
    });
  }
  vfsSessions.set(database, { generation: state.generation, stale: false });
  if (loadDefaults === loadVfsPreload) {
    try { await seedVfsSkills(database); }
    catch (error) { console.warn('Unable to install bundled skills:', error); }
  }
  if (seedChatTerminal) {
    // Keep an existing workspace usable if its bundled app cannot be installed yet.
    try { await seedVfsChatTerminal(database); }
    catch (error) { console.warn('Unable to install bundled Chat Terminal:', error); }
  }
}

async function seedVfsSkills(database) {
  const installed = await vfsTransaction(database, 'readonly', (_store, metadata) => vfsRequest(metadata.get(vfsSkillsSeed)));
  if (installed) return;
  const entries = await loadVfsPreload(path => path.startsWith('/Skills/'));
  await vfsTransaction(database, 'readwrite', async (store, metadata) => {
    if (await vfsRequest(metadata.get(vfsSkillsSeed))) return;
    // Defaults list parents first. Keep user files even when one occupies a bundled folder's path.
    const blockedFolders = [];
    for (const { path, value } of entries) {
      if (blockedFolders.some(folder => path.startsWith(folder))) continue;
      const directory = path.endsWith('/');
      const conflict = directory ? path.slice(0, -1) : vfsDirectoryRange(path + '/');
      if (await vfsRequest(store.getKey(conflict)) !== undefined) {
        if (directory) blockedFolders.push(path);
        continue;
      }
      if (await vfsRequest(store.getKey(path)) === undefined) await vfsRequest(store.add({ id: path, value }));
    }
    // Later deletions are intentional. The library can reinstall defaults on request.
    await vfsRequest(metadata.put(true, vfsSkillsSeed));
  });
}

async function seedVfsChatTerminal(database) {
  const appsRoot = '/Apps/';
  const scriptPath = vfsChatTerminalRoot + 'js/susi_vfs.js';
  const artworkPath = vfsChatTerminalRoot + 'app.png';
  const indexPath = vfsChatTerminalRoot + 'index.html';
  const targetOccupied = async store => {
    const keys = await Promise.all([
      vfsRequest(store.getKey(appsRoot.slice(0, -1))),
      vfsRequest(store.getKey(vfsChatTerminalRoot.slice(0, -1))),
      vfsRequest(store.getKey(vfsDirectoryRange(vfsChatTerminalRoot)))
    ]);
    return keys.some(key => key !== undefined);
  };
  const canAddArtwork = async store => {
    const [index, script, file, folder] = await Promise.all([
      vfsRequest(store.getKey(indexPath)),
      vfsRequest(store.getKey(scriptPath)),
      vfsRequest(store.getKey(artworkPath)),
      vfsRequest(store.getKey(vfsDirectoryRange(artworkPath + '/')))
    ]);
    return index !== undefined && script !== undefined && file === undefined && folder === undefined;
  };
  const pending = await vfsTransaction(database, 'readonly', async (store, metadata) => {
    const seeded = await vfsRequest(metadata.get(vfsChatTerminalSeed));
    if (seeded === vfsChatTerminalVersion) return null;
    const install = !seeded && !(await targetOccupied(store));
    const source = install ? undefined : (await vfsRequest(store.get(scriptPath)))?.value;
    return { install, source, addArtwork: !install && await canAddArtwork(store) };
  });
  if (!pending) return;

  // Replace only the previously bundled storage script. Keep edits and other app files.
  let upgrade = false;
  if (typeof pending.source === 'string' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.source));
    const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    upgrade = hex === 'df78128412772125b6ba38e517369ee0f9d8de67d00f4b2782195e99ebe7df7f';
  }
  const entries = pending.install || upgrade
    ? (await loadVfsPreload()).filter(entry => entry.path.startsWith(vfsChatTerminalRoot))
    : [];
  if (pending.install && !entries.some(entry => entry.path === indexPath)) return;
  const script = upgrade && entries.find(entry => entry.path === scriptPath);
  if (upgrade && (!script || script.value === pending.source)) return;
  const artwork = pending.addArtwork && (upgrade ? entries : await readPackagedVfsDefaults(path => path === artworkPath))
    .find(entry => entry.path === artworkPath);
  if (pending.addArtwork && !artwork) return;

  await vfsTransaction(database, 'readwrite', async (store, metadata) => {
    // A concurrent tab can install the bundle or create its own app while the files load.
    const seeded = await vfsRequest(metadata.get(vfsChatTerminalSeed));
    if (seeded === vfsChatTerminalVersion) return;
    if (pending.install && !seeded && !(await targetOccupied(store))) {
      if (await vfsRequest(store.getKey(appsRoot)) === undefined) {
        await vfsRequest(store.add({ id: appsRoot, value: '' }));
      }
      for (const { path, value } of entries) await vfsRequest(store.add({ id: path, value }));
    } else {
      const updateScript = async (path, change) => {
        const current = await vfsRequest(store.get(path));
        if (typeof current?.value !== 'string') return;
        const value = change(current.value);
        if (value === current.value) return;
        const mtime = Math.max(Date.now(), (current.mtime ?? 0) + 1);
        await vfsRequest(store.put({ ...current, value, mtime }));
      };
      if (script) await updateScript(scriptPath, value => value === pending.source ? script.value : value);
      for (const name of ['susi_chat_terminal.js', 'susi_chat_executor.js']) {
        await updateScript(vfsChatTerminalRoot + 'js/' + name, value =>
          value.replace(/https:\/\/github\.com\/susiai\/susi_chat(?=["'])/g, 'https://github.com/susiai/susi_builder_web'));
      }
      if (artwork && await canAddArtwork(store)) {
        await vfsRequest(store.add({ id: artwork.path, value: artwork.value }));
      }
    }
    // Remember the seed so a user can remove the bundled app without it reappearing on reload.
    await vfsRequest(metadata.put(vfsChatTerminalVersion, vfsChatTerminalSeed));
  });
}

async function resetVfsDefaultFiles(database, entries = loadVfsPreload()) {
  const defaults = validateVfsPreload(await entries);
  await vfsTransaction(database, 'readwrite', async (store) => {
    for (const { path, value } of defaults) {
      const directory = path.endsWith('/');
      // Legacy directories can exist with descendants alone, so a file must check the full directory range.
      const conflictingKey = directory ? path.slice(0, -1) : vfsDirectoryRange(path + '/');
      if (await vfsRequest(store.getKey(conflictingKey)) !== undefined) {
        throw new Error(`Cannot reset ${path}: a file and folder occupy the same path.`);
      }
      const previous = await vfsRequest(store.get(path));
      if (directory && previous) continue;
      const mtime = Math.max(Date.now(), (previous?.mtime ?? 0) + 1);
      await vfsRequest(store.put({ ...previous, id: path, value, mtime }));
    }
  });
}

async function replaceVfsWithDefaults(database, entries = loadVfsPreload()) {
  // Load and validate everything before clearing. All replacements commit together or roll back together.
  const defaults = validateVfsPreload(await entries);
  const generation = newVfsGeneration();
  await vfsTransaction(database, 'readwrite', async (store, metadata) => {
    await vfsRequest(store.clear());
    await vfsRequest(metadata.clear());
    for (const { path, value } of defaults) await vfsRequest(store.add({ id: path, value }));
    await vfsRequest(metadata.put({ initialized: true, generation }, 'state'));
  });
  // Keep the old generation: delayed autosaves from this document must also be rejected until it reloads.
  vfsSessions.get(database).stale = true;
  return generation;
}

const applyUnifiedDiff = (originalText, diffText) => {
  const originalEndsWithNewline = originalText.endsWith('\n');
  const originalLines = originalText.split('\n');
  const diffLines = diffText.split('\n');
  const result = [];
  let origIndex = 0;
  let i = 0;
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  const collectHunkOps = (startIndex) => {
    const ops = [];
    let index = startIndex;
    while (index < diffLines.length && !diffLines[index].startsWith('@@')) {
      const hunkLine = diffLines[index];
      if (hunkLine.startsWith(' ') || hunkLine.startsWith('-') || hunkLine.startsWith('+')) {
        ops.push(hunkLine);
      }
      index += 1;
    }
    return { ops, nextIndex: index };
  };

  const hunkFitsAt = (startAt, ops) => {
    let checkIndex = startAt;
    for (const op of ops) {
      if (op.startsWith(' ') || op.startsWith('-')) {
        const content = op.slice(1);
        if (originalLines[checkIndex] !== content) {
          return false;
        }
        checkIndex += 1;
      }
    }
    return true;
  };

  const findHunkStart = (fromIndex, ops, suggestedStart) => {
    if (Number.isInteger(suggestedStart) && suggestedStart >= fromIndex) {
      if (hunkFitsAt(suggestedStart, ops)) {
        return suggestedStart;
      }
    }
    const firstContext = ops.find((op) => op.startsWith(' '));
    if (!firstContext) {
      return fromIndex;
    }
    const needle = firstContext.slice(1);
    for (let idx = fromIndex; idx < originalLines.length; idx += 1) {
      if (originalLines[idx] === needle && hunkFitsAt(idx, ops)) {
        return idx;
      }
    }
    return -1;
  };

  while (i < diffLines.length) {
    const line = diffLines[i];
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      i += 1;
      continue;
    }
    const match = line.match(hunkHeader);
    if (!match) {
      i += 1;
      continue;
    }

    const oldStart = parseInt(match[1], 10) - 1;
    const { ops, nextIndex } = collectHunkOps(i + 1);
    const hunkStart = findHunkStart(origIndex, ops, oldStart);
    if (hunkStart < 0) {
      throw new Error('Patch context mismatch.');
    }

    while (origIndex < hunkStart && origIndex < originalLines.length) {
      result.push(originalLines[origIndex]);
      origIndex += 1;
    }

    for (const op of ops) {
      if (op.startsWith(' ')) {
        const content = op.slice(1);
        if (originalLines[origIndex] !== content) {
          throw new Error('Patch context mismatch.');
        }
        result.push(content);
        origIndex += 1;
      } else if (op.startsWith('-')) {
        const content = op.slice(1);
        if (originalLines[origIndex] !== content) {
          throw new Error('Patch removal mismatch.');
        }
        origIndex += 1;
      } else if (op.startsWith('+')) {
        result.push(op.slice(1));
      }
    }

    i = nextIndex;
  }

  while (origIndex < originalLines.length) {
    result.push(originalLines[origIndex]);
    origIndex += 1;
  }

  let patched = result.join('\n');
  if (originalEndsWithNewline && !patched.endsWith('\n')) {
    patched += '\n';
  }
  return patched;
};

function checkVfsGeneration(session, state) {
  if (session && (session.stale || state?.generation !== session.generation)) {
    session.stale = true;
    throw new Error('The VFS was reset in another page. Reload before making changes.');
  }
}

// Run filesystem operations against a single committed view of the shared VFS.
function vfsTransaction(database, mode, operation, guard) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['keyValueStore', 'metadata'], mode);
    let result;
    let failure;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure || transaction.error);
    const metadata = transaction.objectStore('metadata');
    (async () => {
      const session = vfsSessions.get(database);
      if (mode === 'readwrite' && session) {
        const state = await vfsRequest(metadata.get('state'));
        checkVfsGeneration(session, state);
      }
      const store = transaction.objectStore('keyValueStore');
      if (guard) await assertVfsRunGuard(store, guard);
      const value = await operation(store, metadata);
      const guardedRun = guard ? await assertVfsRunGuard(store, guard) : undefined;
      if (mode === 'readwrite') {
        const state = await vfsRequest(metadata.get('state'));
        if (state) await vfsRequest(metadata.put({ ...state, revision: (state.revision || 0) + 1 }, 'state'));
      }
      // A cancellation can arrive while an IDB request is pending. Abort before the transaction commits,
      // even when its file writes already succeeded within the still-uncommitted transaction.
      guard?.signal?.throwIfAborted();
      if (guardedRun && guardedRun.leaseUntil <= Date.now()) throw new Error('The agent lease expired. This write was not applied.');
      return value;
    })().then((value) => {
      result = value;
    }).catch((error) => {
      failure = error;
      try {
        transaction.abort();
      } catch {
        reject(error);
      }
    });
  });
}

function vfsRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function vfsDirectoryRange(path, descendantsOnly = false) {
  return IDBKeyRange.bound(path, `${path.slice(0, -1)}0`, descendantsOnly, true);
}

function isWorkspaceRecovering() {
  try { return JSON.parse(localStorage.getItem('webstation.recovery.active') || 'null')?.expiresAt > Date.now(); }
  catch { return false; }
}

// Checked in the SAME transaction as an agent's mutation, fencing delayed writes after lease loss or cancellation.
async function assertVfsRunGuard(store, guard) {
  if (!guard) return;
  guard.signal?.throwIfAborted();
  if (typeof guard.path !== 'string' || typeof guard.runId !== 'string' || typeof guard.owner !== 'string') {
    throw new Error('Invalid agent write permission.');
  }
  const record = await vfsRequest(store.get(guard.path));
  guard.signal?.throwIfAborted();
  const run = JSON.parse(record?.value || '{}').runs?.find(item => item.id === guard.runId);
  if (!run || run.owner !== guard.owner || run.status !== 'running' || !Number.isFinite(run.leaseUntil) || run.leaseUntil <= Date.now()) {
    throw new Error('The agent run has expired or stopped. This write was not applied.');
  }
  return run;
}

async function vfsValueBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Unsupported file contents.');
}

async function vfsSnapshotDigest(entries) {
  const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  const parts = [];
  for (const { path, value } of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const type = typeof value === 'string' ? 'text' : value instanceof Blob ? 'blob:' + value.type : 'bytes';
    // JSON preserves every UTF-16 code unit, including lone surrogates in saved editor drafts.
    const digest = hex(await crypto.subtle.digest('SHA-256', await vfsValueBytes(typeof value === 'string' ? JSON.stringify(value) : value)));
    parts.push([path, type, digest]);
  }
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts))));
}

function createVfsRecovery(database, notifyReset = () => {}) {
  function read(project = '/') {
    if (project !== '/') throw new Error('A workspace backup requires the root directory.');
    return vfsTransaction(database, 'readonly', async (store, metadata) => {
      const rows = await vfsRequest(store.getAll(vfsDirectoryRange('/', true)));
      const state = await vfsRequest(metadata.get('state'));
      return { version: 1, project: '/', generation: state.generation, revision: state.revision || 0,
        entries: rows.map(({ id, value }) => ({ path: id.slice(1), value })) };
    });
  }
  return {
    read,
    hasSafety() {
      return vfsTransaction(database, 'readonly', async (_store, metadata) =>
        Boolean(await vfsRequest(metadata.count('restore-safety'))));
    },
    saveSafety(snapshot) {
      return vfsTransaction(database, 'readwrite', (_store, metadata) =>
        vfsRequest(metadata.put({ ...snapshot, savedAt: Date.now() }, 'restore-safety')));
    },
    getSafety() {
      return vfsTransaction(database, 'readonly', (_store, metadata) => vfsRequest(metadata.get('restore-safety')));
    },
    async replace(snapshot, { expectedDigest } = {}) {
      if (snapshot?.project !== '/' || snapshot.version !== 1 ||
        !Array.isArray(snapshot.entries) || snapshot.entries.length > 20000) throw new Error('Invalid workspace snapshot.');
      const entries = validateVfsPreload(snapshot.entries.map(entry => {
        if (typeof entry?.path !== 'string') throw new Error('Invalid snapshot entry.');
        return { path: '/' + entry.path, value: entry.value };
      }));
      if (typeof expectedDigest !== 'string') throw new Error('Review the current workspace before restoring.');
      // Hash outside the IDB transaction, then check the revision again inside the write transaction.
      const current = await read();
      if (await vfsSnapshotDigest(current.entries) !== expectedDigest) throw new Error('Workspace files changed. Review the backup again.');
      const generation = newVfsGeneration();
      await vfsTransaction(database, 'readwrite', async (store, metadata) => {
        const state = await vfsRequest(metadata.get('state'));
        if ((state.revision || 0) !== current.revision) throw new Error('The workspace changed during restore. Try again.');
        const record = await vfsRequest(store.get('/.webstation/workspace.json'));
        let activity;
        // A full backup can also repair a missing or unreadable activity record.
        if (record) { try { activity = JSON.parse(record.value); } catch {} }
        if (Array.isArray(activity?.runs) && activity.runs.some(run =>
          run?.status === 'running' && Number.isFinite(run.leaseUntil) && run.leaseUntil > Date.now())) {
          throw new Error('Stop active agent runs before restoring the workspace.');
        }
        await vfsRequest(store.delete(vfsDirectoryRange('/')));
        for (const { path, value } of entries) await vfsRequest(store.put({ id: path, value, mtime: Date.now() }));
        // An explicit workspace replacement also discards legacy project history.
        await vfsRequest(metadata.delete(IDBKeyRange.bound('checkpoint-', 'checkpoint;', false, true)));
        await vfsRequest(metadata.put({ initialized: true, generation }, 'state'));
      });
      vfsSessions.get(database).stale = true;
      notifyReset(generation);
    }
  };
}

function createVfsFileSystem(database, directoryRange) {
  const encoder = new TextEncoder();
  const read = (operation) => vfsTransaction(database, 'readonly', operation);
  const write = (operation) => vfsTransaction(database, 'readwrite', operation);

  function fail(code, path) {
    throw Object.assign(new Error(`${code}: ${path}`), { code });
  }

  function resolvePath(base, path) {
    if (path.includes('\0')) fail('EINVAL', path);
    const parts = path.startsWith('/') ? [] : base.split('/').filter(Boolean);
    for (const part of path.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return '/' + parts.join('/');
  }

  function directoryKey(path) {
    return path === '/' ? '/' : path + '/';
  }

  function parent(path) {
    return path.slice(0, path.lastIndexOf('/')) || '/';
  }

  function bytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return encoder.encode(value ?? '');
  }

  function append(previous, value) {
    if (typeof previous === 'string' && typeof value === 'string') return previous + value;
    if (previous instanceof Blob || value instanceof Blob) return new Blob([previous, value]);
    const initial = bytes(previous);
    const added = bytes(value);
    const joined = new Uint8Array(initial.length + added.length);
    joined.set(initial);
    joined.set(added, initial.length);
    return vfsFileValue(joined);
  }

  async function lookup(store, path) {
    if (path !== '/') {
      const file = await vfsRequest(store.get(path));
      if (file) return file;
    }
    const key = directoryKey(path);
    const directory = await vfsRequest(store.get(key));
    if (directory) return directory;

    // Older VFS entries may have descendants without an explicit directory record.
    const firstChild = await vfsRequest(store.getKey(directoryRange(key)));
    return path === '/' || firstChild !== undefined ? { id: key, value: '' } : undefined;
  }

  async function requireEntry(store, path) {
    const record = await lookup(store, path);
    if (!record) fail('ENOENT', path);
    return record;
  }

  async function requireDirectory(store, path) {
    const record = await requireEntry(store, path);
    if (!record.id.endsWith('/')) fail('ENOTDIR', path);
    return record;
  }

  async function requireFile(store, path) {
    const record = await requireEntry(store, path);
    if (record.id.endsWith('/')) fail('EISDIR', path);
    return record;
  }

  async function verifyDestination(store, path, isDirectory) {
    const entry = await lookup(store, path);
    if (entry && entry.id.endsWith('/') !== isDirectory) {
      fail(isDirectory ? 'ENOTDIR' : 'EISDIR', path);
    }
    return entry;
  }

  async function transfer(src, dest, { move = false, recursive = false, overwrite = true } = {}) {
    const source = resolvePath('/', src);
    const target = resolvePath('/', dest);
    return write(async (store) => {
      const original = await requireEntry(store, source);
      const isDirectory = original.id.endsWith('/');
      if (source === target && move) return;
      if (source === target || (isDirectory && target.startsWith(directoryKey(source)))) {
        fail('EINVAL', target);
      }
      if (isDirectory && !recursive) fail('EISDIR', source);
      if (target === '/') fail('EBUSY', target);
      await requireDirectory(store, parent(target));
      const existing = await verifyDestination(store, target, isDirectory);
      if (existing && !overwrite) fail('EEXIST', target);
      if (move && existing && isDirectory) {
        const range = directoryRange(existing.id, true);
        if (await vfsRequest(store.getKey(range)) !== undefined) fail('ENOTEMPTY', target);
      }

      const targetKey = isDirectory ? directoryKey(target) : target;
      await vfsRequest(store.put({ ...original, id: targetKey }));
      if (isDirectory) {
        const records = await vfsRequest(store.getAll(directoryRange(original.id)));
        for (const record of records) {
          if (record.id === original.id) continue;
          const id = targetKey + record.id.slice(original.id.length);
          if (existing) {
            const directory = id.endsWith('/');
            await verifyDestination(store, directory ? id.slice(0, -1) : id, directory);
          }
          await vfsRequest(store.put({ ...record, id }));
        }
      }
      if (move) {
        await vfsRequest(store.delete(isDirectory ? directoryRange(original.id) : original.id));
      }
    });
  }

  async function readFile(path) {
    const { value, mtime = 0 } = await read((store) => requireFile(store, resolvePath('/', path)));
    return { bytes: value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : bytes(value), mtime };
  }

  return {
    resolvePath,
    readFile,
    fileValue: vfsFileValue,

    stat(path) {
      return read(async (store) => {
        const record = await requireEntry(store, resolvePath('/', path));
        const isDirectory = record.id.endsWith('/');
        return {
          isDirectory,
          size: isDirectory ? 0 : record.value instanceof Blob ? record.value.size : bytes(record.value).byteLength,
          mode: record.mode ?? (isDirectory ? 0o755 : 0o644),
          mtime: new Date(record.mtime ?? 0)
        };
      });
    },

    async readBytes(path) {
      return (await readFile(path)).bytes;
    },

    write(path, data, { append: appendData = false, exclusive = false, expectedFile, returnMtime = false, mode = 0o644 } = {}) {
      const key = resolvePath('/', path);
      const value = typeof data === 'string' ? data : vfsFileValue(data);
      return write(async (store) => {
        await requireDirectory(store, parent(key));
        const existing = await lookup(store, key);
        if (existing && exclusive) fail('EEXIST', key);
        if (existing?.id.endsWith('/')) fail('EISDIR', key);
        if (expectedFile) {
          // Guard the snapshot inside the write transaction. Legacy Blob reads finish outside IndexedDB.
          const current = existing && !(existing.value instanceof Blob) ? bytes(existing.value) : undefined;
          if (!existing || (existing.mtime ?? 0) !== expectedFile.mtime ||
              (current && (current.length !== expectedFile.bytes.length || !current.every((b, i) => b === expectedFile.bytes[i])))) {
            throw new Error('The file changed or was removed. Reopen it or save your edits under another name.');
          }
        }
        const contents = appendData && existing ? append(existing.value, value) : value;
        const mtime = Math.max(Date.now(), (existing?.mtime ?? 0) + 1);
        await vfsRequest(store.put({ id: key, value: contents, mode: existing?.mode ?? mode, mtime }));
        if (returnMtime) return mtime;
      });
    },

    mkdir(path, { recursive = false, mode = 0o755 } = {}) {
      const key = resolvePath('/', path);
      return write(async (store) => {
        if (key === '/') {
          if (!recursive) fail('EEXIST', key);
          return;
        }
        const parts = key.slice(1).split('/');
        const directories = recursive
          ? parts.map((_, index) => '/' + parts.slice(0, index + 1).join('/'))
          : [key];
        if (!recursive) await requireDirectory(store, parent(key));
        for (const directory of directories) {
          const existing = await lookup(store, directory);
          if (existing) {
            if (!recursive) fail('EEXIST', directory);
            if (!existing.id.endsWith('/')) fail('ENOTDIR', directory);
          } else {
            await vfsRequest(store.add({ id: directoryKey(directory), value: '', mode, mtime: Date.now() }));
          }
        }
      });
    },

    readdir(path) {
      return read(async (store) => {
        const { id } = await requireDirectory(store, resolvePath('/', path));
        const keys = await vfsRequest(store.getAllKeys(directoryRange(id)));
        return [...new Set(keys.filter((key) => key !== id).map((key) => key.slice(id.length).split('/')[0]))];
      });
    },

    rm(path, { recursive = false, force = false } = {}) {
      const key = resolvePath('/', path);
      return write(async (store) => {
        if (key === '/') fail('EBUSY', key);
        const record = await lookup(store, key);
        if (!record) {
          if (!force) fail('ENOENT', key);
          return;
        }
        const isDirectory = record.id.endsWith('/');
        if (isDirectory && !recursive) {
          const range = directoryRange(record.id, true);
          if (await vfsRequest(store.getKey(range)) !== undefined) fail('ENOTEMPTY', key);
        }
        await vfsRequest(store.delete(isDirectory ? directoryRange(record.id) : record.id));
      });
    },

    cp(src, dest, options) {
      return transfer(src, dest, options);
    },

    mv(src, dest, { overwrite = true } = {}) {
      return transfer(src, dest, { move: true, recursive: true, overwrite });
    },

    setMetadata(path, { mode, mtime }) {
      return write(async (store) => {
        const record = await requireEntry(store, resolvePath('/', path));
        await vfsRequest(store.put({ ...record, mode: mode ?? record.mode, mtime: mtime ?? record.mtime }));
      });
    }
  };
}

function clearVfsSessionStorage() {
  let storage;
  try { storage = globalThis.sessionStorage; } catch (error) {
    if (error.name !== 'SecurityError') throw error;
  }
  if (!storage) return;
  for (const key of Object.keys(storage)) {
    if (key.startsWith('webstation.') || key.startsWith('project-chat.key:')) storage.removeItem(key);
  }
}

async function clearVfsDatabase(onBlocked) {
  if (vfsStandaloneApp) throw new Error('Open the Workspace page to clear the shared database.');
  const deletion = indexedDB.deleteDatabase(vfsDatabaseName);
  if (onBlocked) deletion.onblocked = onBlocked;
  await vfsRequest(deletion);
  clearVfsSessionStorage();
}

async function openVfs({ existingOnly = false } = {}) {
  const request = indexedDB.open(vfsDatabaseName, 2);
  let missing = false;
  let restoreStatus;
  request.onblocked = () => {
    // The browser keeps this request queued until older connections close.
    const message = 'Waiting for a workspace update. Save your work in older tabs using this workspace, then close them. ' +
      'This page will continue automatically.';
    const status = globalThis.document?.querySelector('[data-vfs-open-status]');
    if (!status) { console.warn(message); return; }
    const { hidden, textContent } = status;
    status.hidden = false;
    status.textContent = message;
    restoreStatus = () => {
      if (status.textContent === message) {
        status.textContent = textContent;
        status.hidden = hidden;
      }
    };
  };
  request.onupgradeneeded = event => {
    if (existingOnly && event.oldVersion === 0) {
      // Opening Workspace after Clear leaves IndexedDB empty until an explicit action needs it.
      missing = true;
      request.transaction.abort();
      return;
    }
    const database = request.result;
    if (!database.objectStoreNames.contains('keyValueStore')) {
      database.createObjectStore('keyValueStore', { keyPath: 'id' });
    }
    if (!database.objectStoreNames.contains('metadata')) database.createObjectStore('metadata');
  };
  const db = await vfsRequest(request).catch(error => {
    if (!missing || error.name !== 'AbortError') throw error;
    return null;
  }).finally(() => restoreStatus?.());
  if (!db) return null;
  const connection = new AbortController();
  let resetChannel;
  db.onversionchange = event => {
    db.close();
    connection.abort();
    resetChannel?.close();
    if (event.newVersion !== null) return;
    // Deleting the database closes every open connection. Reloading would install the defaults again.
    const session = vfsSessions.get(db);
    if (session) session.stale = true;
    try { clearVfsSessionStorage(); }
    finally { globalThis.dispatchEvent(new CustomEvent('vfs-reset', { detail: { cleared: true } })); }
  };

  // The next character after '/' bounds the range to keys with this directory prefix.
  const directoryRange = vfsDirectoryRange;

  // Define the vfs object with methods to interact with the database
  const vfs = {
    checkRun: guard => vfsTransaction(db, 'readonly', store => assertVfsRunGuard(store, guard)),
    recovery: createVfsRecovery(db, generation => signalReset(generation, true)),
    get wasReset() { return vfsSessions.get(db)?.stale || false; },
    readDefaults: loadVfsPreload,
    resetDefaultFiles: entries => resetVfsDefaultFiles(db, entries),
    resetToDefaults: async function (entries) {
      const generation = await replaceVfsWithDefaults(db, entries);
      signalReset(generation, true);
    },
    clearDatabase: clearVfsDatabase,
    fileSystem: createVfsFileSystem(db, directoryRange),
    put: function (key, value, { expectedValue, guard } = {}) {
      return vfsTransaction(db, 'readwrite', async (store) => {
        const previous = await vfsRequest(store.get(key));
        if (expectedValue !== undefined && previous?.value !== expectedValue) {
          throw new Error('The file changed or was removed while you were editing.');
        }
        await vfsRequest(store.put({ ...previous, id: key, value, mtime: Date.now() }));
      }, guard);
    },
    // Read-modify-write a shared value in one transaction. The updater must be synchronous.
    update: function (key, updater, { guard } = {}) {
      return vfsTransaction(db, 'readwrite', async (store) => {
        const previous = await vfsRequest(store.get(key));
        const value = updater(previous?.value);
        if (value && typeof value.then === 'function') throw new Error('VFS updates must be synchronous.');
        if (!previous || value !== previous.value) {
          await vfsRequest(store.put({ ...previous, id: key, value, mtime: Date.now() }));
        }
        return value;
      }, guard);
    },
    getasync: function (key) {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['keyValueStore'], 'readonly');
        const store = transaction.objectStore('keyValueStore');
        const getRequest = store.get(key);
        getRequest.onsuccess = function (event) {
          // Check if the key exists before resolving the promise
          if (event.target.result) {
            resolve(event.target.result.value);
          } else {
            reject('Key not found');
          }
        };
        getRequest.onerror = function (event) {
          reject(event.target.errorCode);
        };
      });
    },
    get: async function (key) {
      return await this.getasync(key);
    },
    // the following methods all consider that keys are paths and have their proper shape:
    // - a path must have a leading slash
    // - a path ending with a slash is considered a directory
    // - a path not ending with a slash is considered a file
    // - directories cannot be created or removed directly,
    // - creating a file creates also the parent directory, removing all files removes the directory.
    touch: function (path) {
      // Create a file at the specified path.
      if (!path.startsWith('/') || path === '') {
        throw new Error('Invalid path');
      }
      return vfsTransaction(db, 'readwrite', store => vfsRequest(store.put({ id: path, value: '' })));
    },
    rm: function (path, { guard } = {}) {
      if (!path.startsWith('/')) throw new Error('Invalid path');
      return vfsTransaction(db, 'readwrite', async (store) => {
        await vfsRequest(store.delete(path));
      }, guard);
    },
    cp: function (srcPath, destPath, { guard } = {}) {
      if (!srcPath.startsWith('/') || !destPath.startsWith('/')) throw new Error('Invalid path');
      return vfsTransaction(db, 'readwrite', async (store) => {
        const source = await vfsRequest(store.get(srcPath));
        if (!source) throw new Error('Source file not found.');
        await vfsRequest(store.put({ ...source, id: destPath, mtime: Date.now() }));
      }, guard);
    },
    mv: function (srcPath, destPath, { guard } = {}) {
      if (!srcPath.startsWith('/') || !destPath.startsWith('/')) throw new Error('Invalid path');
      return vfsTransaction(db, 'readwrite', async (store) => {
        const source = await vfsRequest(store.get(srcPath));
        if (!source) throw new Error('Source file not found.');
        await vfsRequest(store.delete(srcPath));
        await vfsRequest(store.put({ ...source, id: destPath, mtime: Date.now() }));
      }, guard);
    },
    applyDiff: async function (path, diffText, { guard } = {}) {
      if (!path.startsWith('/') || path === '' || path.endsWith('/')) {
        throw new Error('Invalid file path');
      }
      if (typeof diffText !== 'string') {
        throw new Error('Invalid diff');
      }
      return vfsTransaction(db, 'readwrite', async (store) => {
        const record = await vfsRequest(store.get(path));
        if (!record) throw 'Key not found';
        const next = applyUnifiedDiff(String(record.value || ''), diffText);
        await vfsRequest(store.put({ ...record, value: next, mtime: Date.now() }));
        return next;
      }, guard);
    },
    editFile: function (path, edits, { guard } = {}) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.endsWith('/') || path.endsWith('/.') ||
        path.includes('\0') || path.split('/').includes('..')) {
        throw new Error('Invalid file path.');
      }
      if (!Array.isArray(edits) || !edits.length || edits.some(edit => !edit || typeof edit !== 'object' ||
        Object.keys(edit).length !== 2 || typeof edit.oldText !== 'string' || !edit.oldText ||
        typeof edit.newText !== 'string')) {
        throw new Error('Rejected: invalid edits or empty oldText.');
      }
      const key = vfs.fileSystem.resolvePath('/', path);
      // Resolve every match against the same original file and commit the whole edit in one transaction.
      return vfs.update(key, original => {
        if (original === undefined) throw new Error('File not found.');
        if (typeof original !== 'string') throw new Error('This is a binary file. Text tools cannot edit it.');
        const matches = edits.map(({ oldText, newText }) => {
          const start = original.indexOf(oldText);
          if (start < 0 || original.indexOf(oldText, start + 1) !== -1) {
            throw new Error('Rejected: every oldText must occur exactly once.');
          }
          return { start, end: start + oldText.length, newText };
        }).sort((a, b) => a.start - b.start);
        let offset = 0;
        const parts = [];
        for (const { start, end, newText } of matches) {
          if (start < offset) throw new Error('Rejected: edits overlap; nothing was changed.');
          parts.push(original.slice(offset, start), newText);
          offset = end;
        }
        parts.push(original.slice(offset));
        return parts.join('');
      }, { guard });
    },
    ls: function (path) {
      if (!path.endsWith('/')) {
        throw new Error('Invalid directory path');
      }
      return vfsTransaction(db, 'readonly', async (store) => {
        const keys = await vfsRequest(store.getAllKeys(directoryRange(path)));
        return keys.map((key) => key.slice(path.length));
      });
    },
    normalizeDirPath: function (path) {
      if (!path || path === '/') {
        return '/';
      }
      if (!path.startsWith('/')) {
        throw new Error('Invalid directory path');
      }
      return path.endsWith('/') ? path : `${path}/`;
    },
    parentDir: function (path) {
      if (!path || path === '/') {
        return '/';
      }
      if (!path.startsWith('/')) {
        throw new Error('Invalid path');
      }
      if (path.endsWith('/')) {
        return this.normalizeDirPath(path);
      }
      const index = path.lastIndexOf('/');
      return index <= 0 ? '/' : path.substring(0, index + 1);
    },
    baseName: function (path) {
      if (!path || path === '/') {
        return '';
      }
      const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
      const parts = trimmed.split('/').filter(Boolean);
      return parts[parts.length - 1] || '';
    },
    mkdir: async function (path) {
      const dirPath = this.normalizeDirPath(path);
      await this.put(dirPath, '');
      return dirPath;
    },
    readFolderTree: function (path) {
      const folder = this.normalizeDirPath(path);
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('keyValueStore', 'readonly');
        const request = transaction.objectStore('keyValueStore').getAll(directoryRange(folder));
        request.onsuccess = () => resolve(request.result
          .filter(({ id }) => id !== folder)
          .map(({ id, value }) => ({ path: id.slice(folder.length), value })));
        request.onerror = () => reject(request.error);
      });
    },
    addFolderTree: function (name, entries, { parent = '/', reuseMatching = false } = {}) {
      const parentPath = vfs.normalizeDirPath(vfs.fileSystem.resolvePath('/', parent));
      // Create the parent if needed, pick a free name, and write the complete tree atomically.
      return vfsTransaction(db, 'readwrite', async (store) => {
        let directory = '/';
        for (const part of parentPath.split('/').filter(Boolean)) {
          const path = directory + part;
          if (await vfsRequest(store.getKey(path)) !== undefined) {
            throw new Error(`Cannot create a folder in ${parentPath} because ${path} is a file.`);
          }
          directory = path + '/';
          if (await vfsRequest(store.getKey(directory)) === undefined) {
            await vfsRequest(store.add({ id: directory, value: '' }));
          }
        }
        const keys = await vfsRequest(store.getAllKeys(directoryRange(parentPath, true)));
        const names = new Set(keys.map(key => key.slice(parentPath.length).split('/')[0]));
        if (reuseMatching) {
          // Check for an unchanged tree in the same transaction that can create its replacement.
          for (const candidate of names) {
            if (candidate !== name && candidate.replace(/ \([1-9]\d*\)$/, '') !== name) continue;
            const folder = `${parentPath}${candidate}/`;
            if (await vfsRequest(store.count(directoryRange(folder, true))) !== entries.length) continue;
            const records = await Promise.all(entries.map(({ path }) => vfsRequest(store.get(folder + path))));
            if (entries.every(({ value }, index) => records[index] && records[index].value === value)) return folder;
          }
        }
        let availableName = name;
        for (let number = 2; names.has(availableName); number += 1) {
          availableName = `${name} (${number})`;
        }
        const folder = `${parentPath}${availableName}/`;
        await vfsRequest(store.add({ id: folder, value: '' }));
        for (const { path, value } of entries) await vfsRequest(store.add({ id: folder + path, value }));
        return folder;
      });
    },
    deleteTree: async function (path) {
      if (!path || !path.startsWith('/')) {
        throw new Error('Invalid path');
      }
      const range = path.endsWith('/') ? directoryRange(path, path === '/') : path;
      await vfsTransaction(db, 'readwrite', (store) => vfsRequest(store.delete(range)));
    },
    moveTree: async function (srcPath, destDir) {
      if (!srcPath || !srcPath.startsWith('/')) {
        throw new Error('Invalid source path');
      }
      const targetDir = this.normalizeDirPath(destDir);
      const isFolder = srcPath.endsWith('/');
      const name = this.baseName(srcPath);
      if (!name) {
        return srcPath;
      }
      const destPath = `${targetDir}${name}${isFolder ? '/' : ''}`;

      if (destPath === srcPath) {
        return destPath;
      }
      if (isFolder && targetDir.startsWith(srcPath)) {
        throw new Error('Cannot move a folder into itself.');
      }

      await vfsTransaction(db, 'readwrite', async (store) => {
        const source = isFolder ? directoryRange(srcPath) : srcPath;
        const keys = await vfsRequest(store.getAllKeys(source));
        if (!keys.length) throw new Error('Source entry no longer exists.');
        if (isFolder && srcPath.startsWith(destPath)) {
          // Moving /a/a/ into / can reuse source keys. Move the shorter keys out first.
          keys.sort((first, second) => first.length - second.length);
        }
        if (targetDir !== '/' && !await vfsRequest(store.getKey(targetDir))) {
          await vfsRequest(store.put({ id: targetDir, value: '' }));
        }
        for (const key of keys) {
          const record = await vfsRequest(store.get(key));
          record.id = destPath + key.slice(srcPath.length);
          await vfsRequest(store.put(record));
          await vfsRequest(store.delete(key));
        }
      });
      return destPath;
    },
    cat: function (path) {
      // Display the contents of a file at the specified path.
      if (path.endsWith('/')) {
        throw new Error('Invalid file path');
      }
      const transaction = db.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      const getRequest = store.get(path);
      getRequest.onsuccess = function (event) {
        console.log(event.target.result ? event.target.result.value : '');
      };
      getRequest.onerror = function (event) {
        console.error(`Error getting file at ${path}: ${event.target.errorCode}`);
      };
    },
    find: function (pattern) {
      // Search for files or directories matching a specified pattern.
      const transaction = db.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      const cursorRequest = store.openCursor();
      const matches = [];
      cursorRequest.onsuccess = function (event) {
        const cursor = event.target.result;
        if (cursor) {
          if (new RegExp(pattern).test(cursor.key)) {
            matches.push(cursor.key);
          }
          cursor.continue();
        } else {
          console.log(matches.join('\n'));
        }
      };
      cursorRequest.onerror = function (event) {
        console.error(`Error finding pattern ${pattern}: ${event.target.errorCode}`);
      };
    },

    du: function () {
      // Show the disk usage of files and directories.
      const transaction = db.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      let totalSize = 0;

      return new Promise((resolve, reject) => {
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = function (event) {
          const cursor = event.target.result;
          if (cursor) {
            const keyLength = cursor.key ? cursor.key.length : 0;
            const valueLength = cursor.value ? cursor.value.length : 0;
            if (!isNaN(keyLength) && !isNaN(valueLength)) {
              totalSize += keyLength + valueLength;
            }
            cursor.continue();
          } else {
            resolve(totalSize);
          }
        };
        cursorRequest.onerror = function (event) {
          reject(`Error getting disk usage: ${event.target.errorCode}`);
        };
      });
    },
    df: function () {
      // Show the amount of disk space used and available on the file system.
      if (navigator.storage && navigator.storage.estimate) {
        return navigator.storage.estimate().then((estimate) => {
          const quota = Number.isFinite(estimate.quota) ? estimate.quota : 0;
          const usage = Number.isFinite(estimate.usage) ? estimate.usage : 0;
          const available = Math.max(0, quota - usage);
          return { quota, usage, available };
        });
      }
      return Promise.reject('Storage estimate not available');
    },
    grep: function (path, pattern) {
      // Search for a pattern in file content at the specified path.
      if (!path.startsWith('/') || path === '') {
        throw new Error('Invalid path');
      }
      const transaction = db.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      const getRequest = store.get(path);
      getRequest.onsuccess = function (event) {
        const content = event.target.result ? event.target.result.value : '';
        if (new RegExp(pattern).test(content)) {
          console.log(`${path}: ${content}`);
        }
      };
      getRequest.onerror = function (event) {
        console.error(`Error getting file at ${path}: ${event.target.errorCode}`);
      };
    }
  };

  let reloading = false;
  function signalReset(generation, local = false) {
    const session = vfsSessions.get(db);
    if (connection.signal.aborted || !session || generation === session.generation) return;
    session.stale = true;
    globalThis.dispatchEvent(new Event('vfs-reset'));
    if (local) {
      try { resetChannel?.postMessage({ generation }); } catch { /* Generation checks still reject stale writes. */ }
    } else if (typeof document !== 'undefined' && !reloading) {
      reloading = true;
      location.reload();
    }
  }

  try {
    if (vfsStandaloneApp) {
      // Join an existing generation without installing the host's defaults or marking them initialized.
      const state = await vfsTransaction(db, 'readonly', (_store, metadata) => vfsRequest(metadata.get('state')));
      vfsSessions.set(db, { generation: state?.generation, stale: false });
    } else await initializeVfsDatabase(db, vfsSkipPreload ? () => [] : undefined);
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        resetChannel = new BroadcastChannel('webstation.vfs');
        resetChannel.onmessage = event => {
          if (typeof event.data?.generation === 'string') signalReset(event.data.generation);
        };
      }
    } catch { /* Focus checks cover browsers that disallow BroadcastChannel for local files. */ }
    if (typeof document !== 'undefined') {
      const checkGeneration = async () => {
        if (document.hidden || reloading) return;
        try {
          const state = await vfsTransaction(db, 'readonly', (store, metadata) => vfsRequest(metadata.get('state')));
          if (state?.generation) signalReset(state.generation);
        } catch (error) { console.error('Unable to check the VFS generation:', error); }
      };
      const options = { signal: connection.signal };
      window.addEventListener('focus', checkGeneration, options);
      window.addEventListener('pageshow', checkGeneration, options);
      document.addEventListener('visibilitychange', checkGeneration, options);
    }
    globalThis.vfs = vfs;
    return vfs;
  } catch (error) {
    db.close();
    connection.abort();
    resetChannel?.close();
    throw error;
  }
}

if (!vfsStandaloneApp || (!window.susi?.files && !document.body?.hasAttribute('data-chat-demo'))) {
  globalThis.vfsReady = openVfs({ existingOnly: vfsSkipPreload });
}
