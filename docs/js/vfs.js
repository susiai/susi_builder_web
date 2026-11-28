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
 * Pages and classic workers can open independent instances with VirtualFileSystem.open().
 * Workstation pages also share a default instance through vfsReady.
 */

(() => {
  'use strict';

  const VFS_APPS_DIRECTORY = "/Apps/";

  function isVfsProjectIndex(path) {
    if (!path.endsWith("/index.html") || path.startsWith(".webstation/")) return false;
    const root = path.slice(0, path.indexOf("/") + 1);
    // Both the current and former app directories list only their direct app folders.
    return (root !== VFS_APPS_DIRECTORY.slice(1) && root !== "apps/") ||
      /^[^/]+\/index\.html$/.test(path.slice(root.length));
  }

  const vfsSessions = new WeakMap();
  const localResets = new EventTarget();
  const vfsDatabaseName = 'vfs';
  const vfsAppRoot = '/.webstation/apps/';
  const vfsChatTerminalRoot = '/Apps/chat-terminal/';
  const vfsChatTerminalSeed = 'bundled-chat-terminal';
  const vfsChatTerminalVersion = 4;
  const vfsSkillsSeed = 'bundled-skills';
  const vfsPythonExamplesSeed = 'bundled-python-examples';
  const isVfsPythonExample = path => /^\/bin\/python_example_[^/]+\.py$/.test(path);
  const vfsStandaloneApp = typeof document !== 'undefined' &&
    document.currentScript?.hasAttribute('data-vfs-standalone');
  const vfsSkipPreload = typeof document !== 'undefined' &&
    document.currentScript?.hasAttribute('data-vfs-skip-preload');
  const vfsScriptURL = typeof document !== 'undefined' ? (document.currentScript?.src || document.baseURI)
    : new URL(/\/js\/[^/]*$/.test(location.pathname) ? 'vfs.js' : 'js/vfs.js', location.href).href;
  const vfsPreloadOverride = globalThis.VFS_PRELOAD_URL;
  const vfsPreloadIndexURL = vfsStandaloneApp ? null : new URL(vfsPreloadOverride || '../vfs-preload.json', vfsScriptURL);
  const vfsTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let vfsPreloadRequest;

  function newVfsGeneration() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function validateVfsPreload(entries, { includeImplicitDirectories = true } = {}) {
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
    const paths = includeImplicitDirectories ? records.keys() : explicitPaths;
    return Array.from(paths, path => ({ path, value: records.get(path) }));
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
  async function loadVfsScript(url, receive) {
    if (typeof document === 'undefined') {
      // Classic workers load scripts synchronously and have no currentScript element.
      if (!receive) { importScripts(url.href); return; }
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
  }

  async function readInstalledResource(url) {
    let value;
    await loadVfsScript(url, resource => { value = resource; });
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

  async function initializeVfsDatabase(database, loadDefaults, { workspace = false } = {}) {
    // A standalone app can open the shared database before the workspace installs its defaults.
    const workspaceKey = async store => {
      const range = vfsDirectoryRange('/', true);
      const key = await vfsRequest(store.getKey(range));
      return workspace && key?.startsWith(vfsAppRoot)
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
    if (opened?.initialized && !workspace) {
      state = opened;
    } else if (path !== undefined) {
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
          if (loadDefaults === loadVfsPreload && defaults.some(({ path }) => isVfsPythonExample(path))) {
            await vfsRequest(metadata.put(true, vfsPythonExamplesSeed));
          }
          if (seedChatTerminal && defaults.some(entry => entry.path === vfsChatTerminalRoot + 'index.html')) {
            await vfsRequest(metadata.put(vfsChatTerminalVersion, vfsChatTerminalSeed));
          }
        }
        return initializedState(metadata, current);
      });
    }
    vfsSessions.set(database, { generation: state.generation, stale: false });
    if (loadDefaults === loadVfsPreload) {
      for (const [label, marker, include] of [
        ['skills', vfsSkillsSeed, path => path.startsWith('/Skills/')],
        ['Python examples', vfsPythonExamplesSeed, isVfsPythonExample]
      ]) {
        try { await seedVfsDefaults(database, marker, include); }
        catch (error) { console.warn(`Unable to install bundled ${label}:`, error); }
      }
    }
    if (seedChatTerminal) {
      // Keep an existing workspace usable if its bundled app cannot be installed yet.
      try { await seedVfsChatTerminal(database); }
      catch (error) { console.warn('Unable to install bundled Chat Terminal:', error); }
    }
  }

  async function seedVfsDefaults(database, marker, include) {
    const installed = await vfsTransaction(database, 'readonly', (_store, metadata) => vfsRequest(metadata.get(marker)));
    if (installed) return;
    const entries = await loadVfsPreload(include);
    if (!entries.length) return;
    await vfsTransaction(database, 'readwrite', async (store, metadata) => {
      if (await vfsRequest(metadata.get(marker))) return;
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
      // Respect later deletions. Reset Default Files can reinstall these files on request.
      await vfsRequest(metadata.put(true, marker));
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
      throw new Error('The VFS was reset. Reopen it before making changes.');
    }
  }

  // Run filesystem operations against a single committed view of the shared VFS.
  async function vfsTransaction(database, mode, operation, guard, signal = guard?.signal, updatedGuardPath) {
    // Resolve the policy before opening IndexedDB so loading a script cannot suspend an active transaction.
    signal?.throwIfAborted();
    const permission = guard && (await loadVfsRunStore()).writeGuard(guard);
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
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
        const initial = permission && (await vfsRequest(store.get(permission.path)))?.value;
        if (permission) permission.check(initial);
        const value = await operation(store, metadata);
        if (mode === 'readwrite') {
          const state = await vfsRequest(metadata.get('state'));
          if (state) await vfsRequest(metadata.put({ ...state, revision: (state.revision || 0) + 1 }, 'state'));
        }
        // A cancellation can arrive while an IDB request is pending. Abort before the transaction commits,
        // even when its file writes already succeeded within the still-uncommitted transaction.
        if (permission) {
          // An atomic update of the guard record can release ownership itself. Its original permission
          // must remain valid through commit, including when the operation extends its own deadline.
          if (permission.path !== updatedGuardPath) {
            const latest = (await vfsRequest(store.get(permission.path)))?.value;
            if (latest !== initial) permission.check(latest);
          }
          permission.check(initial);
        }
        signal?.throwIfAborted();
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

  let runStoreRequest;
  async function loadVfsRunStore() {
    if (globalThis.WorkspaceRunStore) return globalThis.WorkspaceRunStore;
    runStoreRequest ??= loadVfsScript(new URL('workstation-state.js', vfsScriptURL)).then(() => {
      if (!globalThis.WorkspaceRunStore) throw new Error('The workspace run store is unavailable.');
      return globalThis.WorkspaceRunStore;
    }).catch(error => { runStoreRequest = undefined; throw error; });
    return runStoreRequest;
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

  const { createVfsArchive, createVfsRecovery, clearVfsWorkspace } = (() => {
    const maxEntries = 20000;
    const isVfsBackupLocalKey = key => key.startsWith("webstation.chat.") || key === "webstation.agent-profile";

    function collectVfsBackupLocal(storage = localStorage) {
      return Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter(key => key && isVfsBackupLocalKey(key)).map(key => [key, storage.getItem(key)]);
    }

    function validateVfsBackupLocal(records) {
      if (!Array.isArray(records) || records.length > 2000) throw new Error("Invalid conversation archive.");
      const keys = new Set(); let bytes = 0;
      for (const record of records) {
        if (!Array.isArray(record) || record.length !== 2 || typeof record[0] !== "string" || !isVfsBackupLocalKey(record[0]) ||
          typeof record[1] !== "string" || keys.has(record[0])) throw new Error("Invalid conversation archive.");
        keys.add(record[0]); bytes += record[0].length + record[1].length;
      }
      if (bytes > 5 * 1024 * 1024) throw new Error("Conversation archive is too large for browser storage.");
      return records;
    }

    function replaceVfsBackupLocal(records, storage = localStorage) {
      validateVfsBackupLocal(records);
      const previous = collectVfsBackupLocal(storage);
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

    function beginVfsMaintenance() {
      const key = "webstation.recovery.active";
      let previous;
      try { previous = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
      if (previous?.expiresAt > Date.now()) throw new Error("Another workspace restore is already in progress.");
      const owner = newVfsGeneration();
      localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + 300000 }));
      return () => { try { if (JSON.parse(localStorage.getItem(key) || "null")?.owner === owner) localStorage.removeItem(key); } catch {} };
    }

    async function withVfsMaintenance(operation, { requireLock = true, databaseName = vfsDatabaseName } = {}) {
      const maintain = async () => {
        if (databaseName !== vfsDatabaseName) return operation();
        const release = beginVfsMaintenance();
        try { return await operation(); } finally { release(); }
      };
      if (!navigator.locks) {
        if (requireLock) throw new Error("Exclusive recovery requires Web Locks. Use a current browser on HTTPS, localhost, or supported local files.");
        return maintain();
      }
      let entered = false;
      const lockName = databaseName === vfsDatabaseName ? "webstation.workspace-maintenance" : "webstation.workspace-maintenance:" + databaseName;
      return navigator.locks.request(lockName, { ifAvailable: true }, lock => {
        entered = true;
        if (!lock) throw new Error("Another workspace restore or reset is already in progress.");
        return maintain();
      }).catch(error => {
        if (requireLock || entered || error.name !== "SecurityError") throw error;
        return maintain();
      });
    }

    async function clearVfsWorkspace(onBlocked) {
      return withVfsMaintenance(async () => {
        await clearVfsDatabase(onBlocked);
        const storage = localStorage;
        for (const key of Object.keys(storage)) {
          if (key.startsWith("webstation.") && key !== "webstation.recovery.active") storage.removeItem(key);
        }
      }, { requireLock: false });
    }

    // Every VFS connection in this page or worker uses the same lazily loaded ZIP codec.
    let vfsZipLibraryRequest;

    async function loadVfsZipLibrary() {
      if (globalThis.zip?.ZipReader && globalThis.zip?.ZipWriter) return globalThis.zip;
      if (!vfsZipLibraryRequest) {
        const url = new URL('vendor/zip-2.25.0.min.js', vfsScriptURL);
        vfsZipLibraryRequest = loadVfsScript(url).then(() => {
          if (!globalThis.zip?.ZipReader || !globalThis.zip?.ZipWriter) throw new Error('The VFS ZIP library is unavailable.');
          return globalThis.zip;
        }).catch(error => {
          vfsZipLibraryRequest = undefined;
          throw error;
        });
      }
      return vfsZipLibraryRequest;
    }

    function createVfsArchive(vfs) {
      const maxArchiveBytes = 64 * 1024 * 1024;
      const maxExpandedBytes = 128 * 1024 * 1024;

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

      async function importFolder(file) {
        if (file.size > maxArchiveBytes) throw new Error("ZIP imports are limited to 64 MiB compressed.");
        const stem = file.name.replace(/\.zip$/i, "").trim();
        const name = !stem || stem === "." || stem === ".." || /[/\\\x00-\x1f\x7f]/.test(stem) || /^[a-z]:/i.test(stem)
          ? "Archive"
          : stem;
        const zip = await loadVfsZipLibrary();
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
              entries.push({ path, value: vfsFileValue(bytes) });
            } else {
              entries.push({ path: `${path}/`, value: "" });
            }
          }
        } finally {
          await reader.close();
        }
        const parent = entries.some(({ path }) => path === "index.html") ? VFS_APPS_DIRECTORY : "/";
        return vfs.addFolderTree(name, entries, { parent });
      }

      async function exportFolder(path) {
        const folder = vfs.normalizeDirPath(path);
        const name = vfs.baseName(folder) || "VFS";
        const entries = await vfs.readFolderTree(folder);
        const app = isVfsProjectIndex(folder.slice(1) + "index.html") && entries.some(entry => entry.path === "index.html");
        const prefix = app ? "" : `${name}/`;
        const zip = await loadVfsZipLibrary();
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
      async function keyFor(password, salt) {
        if (!crypto.subtle) throw new Error("Encrypted backups require HTTPS, localhost, or a supported local-file context.");
        const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
        return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, material,
          { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      }
      async function encodeBackup(snapshot, { local = vfs.databaseName === vfsDatabaseName ? collectVfsBackupLocal() : [] } = {}) {
        validateVfsBackupLocal(local);
        const manifest = { format: "webstation-backup", version: 2, createdAt: new Date().toISOString(), entries: [], local };
        if (snapshot.entries.length > maxEntries) throw new Error("Backup exceeds 20,000 file entries.");
        const zip = await loadVfsZipLibrary();
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
      async function decodeBackup(file, password = "") {
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
        const zip = await loadVfsZipLibrary();
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
          validateVfsBackupLocal(manifest.local);
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

      return { importFolder, exportFolder, encodeBackup, decodeBackup };
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
      async function replace(snapshot, { expectedDigest, runStorePaths = [] } = {}, safety) {
        if (snapshot?.project !== '/' || snapshot.version !== 1 ||
          !Array.isArray(snapshot.entries) || snapshot.entries.length > maxEntries) throw new Error('Invalid workspace snapshot.');
        const entries = validateVfsPreload(snapshot.entries.map(entry => {
          if (typeof entry?.path !== 'string') throw new Error('Invalid snapshot entry.');
          return { path: '/' + entry.path, value: entry.value };
        }));
        if (typeof expectedDigest !== 'string') throw new Error('Review the current workspace before restoring.');
        // Hash outside the IDB transaction, then check the revision again inside the write transaction.
        const current = await read();
        if (await vfsSnapshotDigest(current.entries) !== expectedDigest) throw new Error('Workspace files changed. Review the backup again.');
        const customPaths = new Set(runStorePaths);
        function isRunIndex(path, value) {
          if (path.endsWith('/.webstation/workspace.json') || customPaths.has(path)) return true;
          if (typeof value !== 'string' || !/^\s*\{/.test(value) || !value.includes('"$susiWorkspaceRunStore"')) return false;
          try { return JSON.parse(value)?.$susiWorkspaceRunStore === 1; } catch { return false; }
        }
        const outgoing = current.entries.filter(entry => isRunIndex('/' + entry.path, entry.value));
        const incoming = entries.filter(entry => isRunIndex(entry.path, entry.value));
        const runStore = (outgoing.length || incoming.length) ? await loadVfsRunStore() : undefined;
        for (const entry of incoming) entry.value = runStore.interruptRestored(entry.value);
        const generation = newVfsGeneration();
        await vfsTransaction(database, 'readwrite', async (store, metadata) => {
          const state = await vfsRequest(metadata.get('state'));
          if ((state.revision || 0) !== current.revision) throw new Error('The workspace changed during restore. Try again.');
          // The revision check ties the inspected records to this transaction.
          if (outgoing.some(entry => runStore.hasActiveRun(entry.value))) {
            throw new Error('Stop active agent runs before restoring the workspace.');
          }
          if (safety) await vfsRequest(metadata.put({ ...safety, savedAt: Date.now() }, 'restore-safety'));
          await vfsRequest(store.delete(vfsDirectoryRange('/')));
          for (const { path, value } of entries) await vfsRequest(store.put({ id: path, value, mtime: Date.now() }));
          // An explicit workspace replacement also discards legacy project history.
          await vfsRequest(metadata.delete(IDBKeyRange.bound('checkpoint-', 'checkpoint;', false, true)));
          await vfsRequest(metadata.put({ initialized: true, generation }, 'state'));
        });
        notifyReset(generation);
      }

      const recovery = {
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
        async restore(snapshot, expectedDigest, { storage = database.name === vfsDatabaseName ? globalThis.localStorage : undefined, runStorePaths } = {}) {
          if (!storage && snapshot.local?.length) throw new Error("Supply conversation storage to restore these preferences.");
          validateVfsBackupLocal(snapshot.local || []);
          return withVfsMaintenance(async () => {
            const before = await read();
            before.local = storage ? collectVfsBackupLocal(storage) : [];
            if (await vfsSnapshotDigest(before.entries) !== expectedDigest) throw new Error("Workspace files changed. Review the backup again.");
            const previous = storage && replaceVfsBackupLocal(snapshot.local || [], storage);
            try { await replace(snapshot, { expectedDigest, runStorePaths }, before); }
            catch (error) { if (storage) replaceVfsBackupLocal(previous, storage); throw error; }
          }, { databaseName: database.name });
        },
        replace: (snapshot, options) => replace(snapshot, options)
      };
      return recovery;
    }

    return { createVfsArchive, createVfsRecovery, clearVfsWorkspace };
  })();

  function createVfsFileSystem(database, directoryRange) {
    const encoder = new TextEncoder();
    const read = (operation) => vfsTransaction(database, 'readonly', operation);
    const write = (operation, guard) => vfsTransaction(database, 'readwrite', operation, guard);

    function fail(code, path) {
      throw Object.assign(new Error(`${code}: ${path}`), { code });
    }

    function resolvePath(base, path) {
      if (typeof path !== 'string' || /[\\\x00-\x1f\x7f]/.test(path)) fail('EINVAL', path);
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

    function treeEntry(record) {
      const directory = record.id.endsWith('/');
      return { mtime: record.mtime ?? 0, mode: record.mode ?? (directory ? 0o755 : 0o644),
        size: directory ? 0 : record.value instanceof Blob ? record.value.size : bytes(record.value).byteLength };
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

    // Legacy writes can create a file inside an implicit directory. Check every ancestor so a
    // file can never become a parent, without materializing extra directory records in old trees.
    async function checkParent(store, path, implicitParents) {
      if (!implicitParents) return requireDirectory(store, parent(path));
      for (let dir = parent(path); dir !== '/'; dir = parent(dir)) {
        if (await vfsRequest(store.getKey(dir)) !== undefined) fail('ENOTDIR', dir);
      }
    }

    async function transfer(src, dest, { move = false, recursive = false, overwrite = true, guard,
      implicitParents = false, mergeDirectories = false, fileOnly = false } = {}) {
      const source = resolvePath('/', src);
      const target = resolvePath('/', dest);
      return write(async store => {
        const original = await requireEntry(store, source);
        const isDirectory = original.id.endsWith('/');
        if (fileOnly && isDirectory) fail('EISDIR', source);
        if (!isDirectory && src.endsWith('/')) fail('ENOTDIR', source);
        if (!isDirectory && dest.endsWith('/')) fail('ENOTDIR', target);
        if (source === target && (move || (fileOnly && overwrite))) return;
        if (source === target || (isDirectory && target.startsWith(directoryKey(source)))) fail('EINVAL', target);
        if (isDirectory && !recursive) fail('EISDIR', source);
        if (target === '/') fail('EBUSY', target);
        if (mergeDirectories) await makeDirectories(store, parent(target), { recursive: true });
        else await checkParent(store, target, implicitParents);
        const existing = await verifyDestination(store, target, isDirectory);
        if (existing && !overwrite) fail('EEXIST', target);
        if (move && existing && isDirectory && !mergeDirectories &&
            await vfsRequest(store.getKey(directoryRange(existing.id, true))) !== undefined) fail('ENOTEMPTY', target);

        const targetKey = isDirectory ? directoryKey(target) : target;
        const children = isDirectory ? await vfsRequest(store.getAll(directoryRange(original.id, true))) : [];
        // Snapshot before moving. A legacy tree merge can move children up into their own ancestor.
        if (move) await vfsRequest(store.delete(isDirectory ? directoryRange(original.id) : original.id));
        for (const record of [original, ...children]) {
          const id = targetKey + record.id.slice(original.id.length);
          const directory = id.endsWith('/');
          const path = directory ? id.slice(0, -1) : id;
          if (existing && record !== original) await checkParent(store, path, true);
          const previous = record === original ? existing : existing && await verifyDestination(store, path, directory);
          const mtime = previous ? Math.max(Date.now(), (previous.mtime ?? 0) + 1, record.mtime ?? 0) : record.mtime;
          await vfsRequest(store.put({ ...record, id, mtime }));
        }
      }, guard);
    }

    async function changeEntry(store, key, updater, { exclusive = false, expectedFile, expectedValue, directory = false,
      mode = directory ? 0o755 : 0o644, implicitParents = false, skipUnchanged = false, returnMtime = false } = {}) {
      await checkParent(store, key, implicitParents);
      const existing = await lookup(store, key);
      if (existing && exclusive) fail('EEXIST', key);
      if (existing && existing.id.endsWith('/') !== directory) fail(directory ? 'ENOTDIR' : 'EISDIR', key);
      if (expectedValue !== undefined && existing?.value !== expectedValue) {
        throw new Error('The file changed or was removed while you were editing.');
      }
      if (expectedFile) {
        const current = existing && !(existing.value instanceof Blob) ? bytes(existing.value) : undefined;
        if (!existing || (existing.mtime ?? 0) !== expectedFile.mtime ||
            (current && (current.length !== expectedFile.bytes.length || !current.every((b, i) => b === expectedFile.bytes[i])))) {
          throw Object.assign(new Error('The file changed or was removed. Reopen it or save your edits under another name.'), { code: 'ESTALE' });
        }
      }
      const value = updater(existing?.value);
      if (value && typeof value.then === 'function') throw new Error('VFS updates must be synchronous.');
      if (skipUnchanged && existing && value === existing.value) return value;
      const mtime = Math.max(Date.now(), (existing?.mtime ?? 0) + 1);
      await vfsRequest(store.put({ ...existing, id: directory ? directoryKey(key) : key, value, mode: existing?.mode ?? mode, mtime }));
      return returnMtime ? mtime : value;
    }

    async function makeDirectories(store, key, { recursive, mode = 0o755 }) {
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
          if (await vfsRequest(store.getKey(existing.id)) !== undefined) continue;
        }
        await vfsRequest(store.add({ id: directoryKey(directory), value: '', mode, mtime: Date.now() }));
      }
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
          const { mtime, ...entry } = treeEntry(record);
          return { ...entry, isDirectory: record.id.endsWith('/'), mtime: new Date(mtime) };
        });
      },

      async readBytes(path) {
        return (await readFile(path)).bytes;
      },

      async snapshotTree(path, { exclude = [], maxEntries, maxBytes, signal, label = 'Python' } = {}) {
        const entries = await read(async (store) => {
          const { id } = await requireDirectory(store, resolvePath('/', path));
          const keys = (await vfsRequest(store.getAllKeys(directoryRange(id, true))))
            .filter(key => !exclude.includes(key.slice(id.length).split('/')[0]));
          if (keys.length > maxEntries) throw new Error(`The ${label} workspace has too many files.`);
          let total = 0;
          const result = [];
          for (const key of keys) {
            signal?.throwIfAborted();
            const record = await vfsRequest(store.get(key));
            const entry = treeEntry(record);
            total += entry.size;
            if (total > maxBytes) throw new Error(`The ${label} workspace exceeds ${maxBytes / (1024 * 1024)} MiB.`);
            result.push({ ...entry, path: key.slice(id.length), value: key.endsWith('/') ? null : record.value });
          }
          return result;
        });
        return Promise.all(entries.map(async ({ value, ...entry }) => ({ ...entry,
          data: value === null ? null : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : bytes(value) })));
      },

      applyTreeChanges(path, changes, { guard, signal, label = 'Python' } = {}) {
        const root = directoryKey(resolvePath('/', path));
        // Validate all expected entries before applying a single transaction. Unrelated edits can proceed.
        return vfsTransaction(database, 'readwrite', async (store) => {
          await requireDirectory(store, resolvePath('/', root));
          for (const { path: relative, before } of changes) {
            if (!relative || relative.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(relative) ||
              relative.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..')) {
              throw new Error(`Invalid ${label} workspace path.`);
            }
            const record = await vfsRequest(store.get(root + relative));
            const current = record && treeEntry(record);
            if (Boolean(current) !== Boolean(before) || (current &&
              (current.mtime !== before.mtime || current.mode !== before.mode || current.size !== before.size ||
                (before.data && !(record.value instanceof Blob) && bytes(record.value).some((byte, i) => byte !== before.data[i]))))) {
              throw new Error(`Workspace entry changed while ${label} was running: ${relative}`);
            }
          }
          // Removals are ordered children first, then additions are ordered parents first.
          for (const { path: relative, after } of changes) {
            signal?.throwIfAborted();
            const key = root + relative;
            const directory = key.endsWith('/');
            if (!after) {
              if (directory && await vfsRequest(store.getKey(directoryRange(key, true))) !== undefined) {
                throw new Error(`Workspace directory changed while ${label} was running: ${relative}`);
              }
              await vfsRequest(store.delete(key));
            } else {
              const target = directory ? key.slice(0, -1) : key;
              await requireDirectory(store, parent(target));
              await verifyDestination(store, target, directory);
              await vfsRequest(store.put({ id: key, value: directory ? '' : vfsFileValue(after.data),
                mode: after.mode, mtime: after.mtime }));
            }
          }
        }, guard, signal);
      },

      async write(path, data, options = {}) {
        const value = options.preserveValue || typeof data === 'string' ? data : vfsFileValue(data);
        const key = resolvePath('/', path);
        const result = await write(store => changeEntry(store, key, previous =>
          options.append && previous !== undefined ? append(previous, value) : value, options), options.guard);
        if (options.returnMtime) return result;
      },

      update(path, updater, options = {}) {
        const key = resolvePath('/', path);
        return write(store => changeEntry(store, key, updater, { ...options, skipUnchanged: true }), options.guard);
      },

      // Commit a manifest edit together with its associated file, including all checks and directory creation.
      updateWithFile(path, updater, file, { guard } = {}) {
        const key = resolvePath('/', path);
        const target = resolvePath('/', file.path);
        if (key === target || key === '/' || target === '/' || file.path.endsWith('/')) fail('EINVAL', target);
        return vfsTransaction(database, 'readwrite', async store => {
          switch (file.action) {
            case 'require':
              await requireFile(store, target);
              break;
            case 'create': {
              const [{ value }] = validateVfsPreload([{ path: target, value: file.value }], { includeImplicitDirectories: false });
              await makeDirectories(store, parent(target), { recursive: true });
              if (await verifyDestination(store, target, false)) fail('EEXIST', target);
              await vfsRequest(store.add({ id: target, value: typeof value === 'string' ? value : vfsFileValue(value),
                mode: 0o644, mtime: Date.now() }));
              break;
            }
            case 'update':
              await changeEntry(store, target, file.update, { implicitParents: true, skipUnchanged: true });
              break;
            case 'remove':
              if (await verifyDestination(store, target, false)) await vfsRequest(store.delete(target));
              break;
            default:
              throw new TypeError('Unknown file operation.');
          }
          return changeEntry(store, key, updater, { implicitParents: true, skipUnchanged: true });
        }, guard, guard?.signal, key);
      },

      mkdir(path, { recursive = false, mode = 0o755, guard } = {}) {
        const key = resolvePath('/', path);
        return write(store => makeDirectories(store, key, { recursive, mode }), guard);
      },

      async addFolderTree(name, entries, { parent = '/', reuseMatching = false, guard } = {}) {
        if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name)) {
          throw new Error('Invalid folder name.');
        }
        const tree = validateVfsPreload(entries.map(({ path, value }) => {
          if (typeof path !== 'string') throw new Error('Invalid folder entry path.');
          return { path: '/' + path, value };
        }), { includeImplicitDirectories: false }).map(({ path, value }) => ({ path: path.slice(1), value }));
        const parentPath = directoryKey(resolvePath('/', parent));
        // Create the parent if needed, pick a free name, and write the complete tree atomically.
        return write(async store => {
          await makeDirectories(store, resolvePath('/', parent), { recursive: true });
          const keys = await vfsRequest(store.getAllKeys(vfsDirectoryRange(parentPath, true)));
          const names = new Set(keys.map(key => key.slice(parentPath.length).split('/')[0]));
          if (reuseMatching) {
            // Check for an unchanged tree in the same transaction that can create its replacement.
            for (const candidate of names) {
              if (candidate !== name && candidate.replace(/ \([1-9]\d*\)$/, '') !== name) continue;
              const folder = `${parentPath}${candidate}/`;
              if (await vfsRequest(store.getKey(folder)) === undefined) continue;
              if (await vfsRequest(store.count(vfsDirectoryRange(folder, true))) !== tree.length) continue;
              const records = await Promise.all(tree.map(({ path }) => vfsRequest(store.get(folder + path))));
              if (tree.every(({ value }, index) => records[index] && records[index].value === value)) return folder;
            }
          }
          let availableName = name;
          for (let number = 2; names.has(availableName); number += 1) {
            availableName = `${name} (${number})`;
          }
          const folder = `${parentPath}${availableName}/`;
          const mtime = Date.now();
          await vfsRequest(store.add({ id: folder, value: '', mtime }));
          for (const { path, value } of tree) await vfsRequest(store.add({ id: folder + path, value, mtime }));
          return folder;
        }, guard);
      },

      readdir(path) {
        return read(async (store) => {
          const { id } = await requireDirectory(store, resolvePath('/', path));
          const keys = await vfsRequest(store.getAllKeys(directoryRange(id)));
          return [...new Set(keys.filter((key) => key !== id).map((key) => key.slice(id.length).split('/')[0]))];
        });
      },

      rm(path, { recursive = false, force = false, allowRoot = false, fileOnly = false, guard } = {}) {
        const key = resolvePath('/', path);
        return write(async (store) => {
          if (key === '/' && !(allowRoot && recursive)) fail('EBUSY', key);
          const record = await lookup(store, key);
          if (!record) {
            if (!force) fail('ENOENT', key);
            return;
          }
          const isDirectory = record.id.endsWith('/');
          if (fileOnly && isDirectory) fail('EISDIR', key);
          if (!isDirectory && path.endsWith('/')) fail('ENOTDIR', key);
          if (isDirectory && !recursive) {
            const range = directoryRange(record.id, true);
            if (await vfsRequest(store.getKey(range)) !== undefined) fail('ENOTEMPTY', key);
          }
          await vfsRequest(store.delete(isDirectory ? directoryRange(record.id, key === '/') : record.id));
        }, guard);
      },

      cp(src, dest, options) {
        return transfer(src, dest, { ...options, move: false });
      },

      mv(src, dest, options) {
        return transfer(src, dest, { ...options, move: true, recursive: true });
      },

      setMetadata(path, { mode, mtime, guard }) {
        return write(async (store) => {
          const record = await requireEntry(store, resolvePath('/', path));
          await vfsRequest(store.put({ ...record, mode: mode ?? record.mode, mtime: mtime ?? record.mtime }));
        }, guard);
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

  async function clearVfsDatabase(onBlocked, databaseName = vfsDatabaseName) {
    if (databaseName === vfsDatabaseName && vfsStandaloneApp) throw new Error('Open the Workspace page to clear the shared database.');
    const deletion = indexedDB.deleteDatabase(databaseName);
    if (onBlocked) deletion.onblocked = onBlocked;
    await vfsRequest(deletion);
    if (databaseName === vfsDatabaseName) clearVfsSessionStorage();
  }

  function showBlockedVfsOpen() {
    // The browser keeps this request queued until older connections close.
    const message = 'Waiting for a workspace update. Save your work in older tabs using this workspace, then close them. ' +
      'This page will continue automatically.';
    const status = globalThis.document?.querySelector('[data-vfs-open-status]');
    if (!status) { console.warn(message); return; }
    const { hidden, textContent } = status;
    status.hidden = false;
    status.textContent = message;
    return () => {
      if (status.textContent === message) {
        status.textContent = textContent;
        status.hidden = hidden;
      }
    };
  }

  const emptyVfsDefaults = () => [];

  async function openVfsInstance({ databaseName, existingOnly, onBlocked, loadDefaults }, initialize) {
    if (typeof databaseName !== 'string' || !databaseName) throw new TypeError('Supply a nonempty database name.');
    if (typeof loadDefaults !== 'function') throw new TypeError('Supply a function to load default files.');
    const request = indexedDB.open(databaseName, 2);
    let missing = false;
    let restoreStatus;
    request.onblocked = event => { restoreStatus = onBlocked?.(event); };
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
    }).finally(() => { if (typeof restoreStatus === 'function') restoreStatus(); });
    if (!db) return null;
    let vfs;
    try {
      vfs = new VirtualFileSystem(db, loadDefaults);
      await initialize(db);
      return vfs;
    } catch (error) {
      if (vfs) vfs.close();
      else db.close();
      throw error;
    }
  }

  class VirtualFileSystem extends EventTarget {
    #database;
    #loadDefaults;
    #connection = new AbortController();
    #channel;
    #resetNotified = false;

    static open({ databaseName = vfsDatabaseName, existingOnly = false, loadDefaults = emptyVfsDefaults, onBlocked } = {}) {
      return openVfsInstance({ databaseName, existingOnly, loadDefaults, onBlocked }, db => initializeVfsDatabase(db, loadDefaults));
    }

    constructor(database, loadDefaults) {
      super();
      this.#database = database;
      this.#loadDefaults = loadDefaults;
      this.fileSystem = createVfsFileSystem(database, vfsDirectoryRange);
      this.archive = createVfsArchive(this);
      this.recovery = createVfsRecovery(database, generation => this.#reset(generation));
      localResets.addEventListener(database.name, event => this.#reset(event.detail, true), { signal: this.#connection.signal });
      database.onversionchange = event => {
        this.close();
        if (event.newVersion !== null) return;
        const session = vfsSessions.get(database);
        if (session) session.stale = true;
        this.dispatchEvent(new CustomEvent('reset', { detail: { cleared: true } }));
      };
      const checkGeneration = async () => {
        if (!vfsSessions.has(database) || this.#connection.signal.aborted || this.#resetNotified) return;
        try {
          const state = await vfsTransaction(database, 'readonly', (_store, metadata) => vfsRequest(metadata.get('state')));
          if (state?.generation) this.#reset(state.generation, true);
        } catch (error) {
          if (!this.#connection.signal.aborted) console.error('Unable to check the VFS generation:', error);
        }
      };
      try {
        const name = database.name === vfsDatabaseName ? 'webstation.vfs' : 'webstation.vfs:' + database.name;
        this.#channel = new BroadcastChannel(name);
        this.#channel.onmessage = checkGeneration;
      } catch { /* Focus checks cover browsers that disallow BroadcastChannel for local files. */ }
      if (typeof document !== 'undefined') {
        const options = { signal: this.#connection.signal };
        window.addEventListener('focus', checkGeneration, options);
        window.addEventListener('pageshow', checkGeneration, options);
        document.addEventListener('visibilitychange', checkGeneration, options);
      }
    }

    get databaseName() { return this.#database.name; }
    get wasReset() { return vfsSessions.get(this.#database)?.stale || false; }

    #reset(generation, remote = false) {
      const session = vfsSessions.get(this.#database);
      if (this.#connection.signal.aborted || this.#resetNotified || !session || session.generation === generation) return;
      session.stale = true;
      this.#resetNotified = true;
      if (!remote) {
        localResets.dispatchEvent(new CustomEvent(this.databaseName, { detail: generation }));
        this.#channel?.postMessage({ generation });
      }
      this.dispatchEvent(new CustomEvent('reset', { detail: { generation, remote } }));
    }

    close() {
      if (this.#connection.signal.aborted) return;
      this.#connection.abort();
      this.#channel?.close();
      this.#database.close();
    }

    clearDatabase(onBlocked) { return clearVfsDatabase(onBlocked, this.databaseName); }
    readDefaults(include) { return this.#loadDefaults(include); }
    resetDefaultFiles(entries = this.readDefaults()) { return resetVfsDefaultFiles(this.#database, entries); }
    async resetToDefaults(entries = this.readDefaults()) {
      this.#reset(await replaceVfsWithDefaults(this.#database, entries));
    }

    async checkRun(guard) {
      if (!guard) return;
      const permission = (await loadVfsRunStore()).writeGuard(guard);
      return vfsTransaction(this.#database, 'readonly', async store =>
        permission.check((await vfsRequest(store.get(permission.path)))?.value));
    }

    // Non-path keys belong to the original key/value API. Files use the checked filesystem engine.
    #changeKey(key, updater, { guard, expectedValue }, skipUnchanged) {
      return vfsTransaction(this.#database, 'readwrite', async store => {
        const previous = await vfsRequest(store.get(key));
        if (expectedValue !== undefined && previous?.value !== expectedValue) throw new Error('The stored value changed.');
        const value = updater(previous?.value);
        if (value && typeof value.then === 'function') throw new Error('VFS updates must be synchronous.');
        if (!skipUnchanged || !previous || previous.value !== value) {
          await vfsRequest(store.put({ ...previous, id: key, value, mtime: Math.max(Date.now(), (previous?.mtime ?? 0) + 1) }));
        }
        return value;
      }, guard);
    }

    async put(key, value, options = {}) {
      if (typeof key !== 'string' || !key.startsWith('/')) {
        await this.#changeKey(key, () => value, options, false);
        return;
      }
      await this.fileSystem.write(key, value, { ...options, preserveValue: true, implicitParents: true, directory: key.endsWith('/') });
    }

    update(key, updater, options = {}) {
      if (typeof key !== 'string' || !key.startsWith('/')) return this.#changeKey(key, updater, options, true);
      return this.fileSystem.update(key, updater, { ...options, implicitParents: true, directory: key.endsWith('/') });
    }

    async getasync(key) {
      const record = await vfsTransaction(this.#database, 'readonly', async store => {
        const exact = await vfsRequest(store.get(key));
        if (exact) return exact;
        if (typeof key === 'string' && key.startsWith('/')) {
          const path = this.fileSystem.resolvePath('/', key);
          const canonical = key.endsWith('/') && path !== '/' ? path + '/' : path;
          if (canonical !== key) return vfsRequest(store.get(canonical));
        }
      });
      if (!record) throw 'Key not found';
      return record.value;
    }

    get(key) { return this.getasync(key); }

    touch(path, options) {
      this.#absolute(path);
      return this.put(path, '', options);
    }

    #absolute(path) {
      if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Invalid path');
      return path;
    }

    rm(path, options) {
      return this.fileSystem.rm(this.#absolute(path), { ...options, fileOnly: !path.endsWith('/'), force: true });
    }

    cp(src, dest, options) {
      return this.fileSystem.cp(this.#absolute(src), this.#absolute(dest),
        { ...options, fileOnly: !src.endsWith('/'), recursive: src.endsWith('/'), implicitParents: true });
    }

    mv(src, dest, options) {
      return this.fileSystem.mv(this.#absolute(src), this.#absolute(dest),
        { ...options, fileOnly: !src.endsWith('/'), implicitParents: true });
    }

    applyDiff(path, diffText, { guard } = {}) {
      this.#absolute(path);
      if (path.endsWith('/')) throw new Error('Invalid file path');
      if (typeof diffText !== 'string') throw new Error('Invalid diff');
      return this.update(path, original => {
        if (original === undefined) throw 'Key not found';
        return applyUnifiedDiff(String(original || ''), diffText);
      }, { guard });
    }

    editFile(path, edits, { guard } = {}) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.endsWith('/') || path.endsWith('/.') ||
        path.includes('\0') || path.split('/').includes('..')) {
        throw new Error('Invalid file path.');
      }
      const key = this.fileSystem.resolvePath('/', path);
      return this.update(key, original => VirtualFileSystem.applyTextEdits(original, edits), { guard });
    }

    // Resolve every replacement against the same snapshot before changing any text.
    static applyTextEdits(original, edits) {
      if (!Array.isArray(edits) || !edits.length || edits.some(edit => !edit || typeof edit !== 'object' ||
        Object.keys(edit).length !== 2 || typeof edit.oldText !== 'string' || !edit.oldText ||
        typeof edit.newText !== 'string')) {
        throw new Error('Rejected: invalid edits or empty oldText.');
      }
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
    }

    ls(path) {
      if (!path.endsWith('/')) {
        throw new Error('Invalid directory path');
      }
      const folder = this.normalizeDirPath(path);
      return vfsTransaction(this.#database, 'readonly', async (store) => {
        const keys = await vfsRequest(store.getAllKeys(vfsDirectoryRange(folder)));
        return keys.map((key) => key.slice(folder.length));
      });
    }

    normalizeDirPath(path) {
      if (!path || path === '/') {
        return '/';
      }
      if (!path.startsWith('/')) {
        throw new Error('Invalid directory path');
      }
      const directory = this.fileSystem.resolvePath('/', path);
      return directory === '/' ? directory : directory + '/';
    }

    parentDir(path) {
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
    }

    baseName(path) {
      if (!path || path === '/') {
        return '';
      }
      const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
      const parts = trimmed.split('/').filter(Boolean);
      return parts[parts.length - 1] || '';
    }

    async mkdir(path, options) {
      const directory = this.normalizeDirPath(path);
      await this.fileSystem.mkdir(directory, { ...options, recursive: true });
      return directory;
    }

    readFolderTree(path) {
      const folder = this.normalizeDirPath(path);
      return new Promise((resolve, reject) => {
        const transaction = this.#database.transaction('keyValueStore', 'readonly');
        const request = transaction.objectStore('keyValueStore').getAll(vfsDirectoryRange(folder));
        request.onsuccess = () => resolve(request.result
          .filter(({ id }) => id !== folder)
          .map(({ id, value }) => ({ path: id.slice(folder.length), value })));
        request.onerror = () => reject(request.error);
      });
    }

    addFolderTree(name, entries, options) {
      return this.fileSystem.addFolderTree(name, entries, options);
    }

    deleteTree(path, options) {
      return this.fileSystem.rm(this.#absolute(path), { ...options, force: true, recursive: path.endsWith('/'),
        fileOnly: !path.endsWith('/'), allowRoot: path === '/' });
    }

    async moveTree(src, destDir, options) {
      this.#absolute(src);
      const name = this.baseName(src);
      if (!name) return src;
      const directory = src.endsWith('/');
      const dest = this.normalizeDirPath(destDir) + name + (directory ? '/' : '');
      await this.fileSystem.mv(src, dest, { ...options, fileOnly: !directory, mergeDirectories: true });
      return dest;
    }

    cat(path) {
      // Display the contents of a file at the specified path.
      if (path.endsWith('/')) {
        throw new Error('Invalid file path');
      }
      const transaction = this.#database.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      const getRequest = store.get(path);
      getRequest.onsuccess = function (event) {
        console.log(event.target.result ? event.target.result.value : '');
      };
      getRequest.onerror = function (event) {
        console.error(`Error getting file at ${path}: ${event.target.errorCode}`);
      };
    }

    find(pattern) {
      // Search for files or directories matching a specified pattern.
      const transaction = this.#database.transaction(['keyValueStore'], 'readonly');
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
    }


    du() {
      // Show the disk usage of files and directories.
      const transaction = this.#database.transaction(['keyValueStore'], 'readonly');
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
    }

    df() {
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
    }

    grep(path, pattern) {
      // Search for a pattern in file content at the specified path.
      if (!path.startsWith('/') || path === '') {
        throw new Error('Invalid path');
      }
      const transaction = this.#database.transaction(['keyValueStore'], 'readonly');
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

  }

  // Workstation adapter. Explicit class instances never replace this global or reload the page.
  async function openVfs({ existingOnly = false } = {}) {
    const vfs = await openVfsInstance({ databaseName: vfsDatabaseName, existingOnly,
      loadDefaults: loadVfsPreload, onBlocked: showBlockedVfsOpen }, async db => {
      if (vfsStandaloneApp) {
        const state = await vfsTransaction(db, 'readonly', (_store, metadata) => vfsRequest(metadata.get('state')));
        vfsSessions.set(db, { generation: state?.generation, stale: false });
      } else await initializeVfsDatabase(db, vfsSkipPreload ? emptyVfsDefaults : loadVfsPreload, { workspace: true });
    });
    if (vfs) {
      if (globalThis.vfs?.wasReset) globalThis.vfs.close();
      vfs.addEventListener('reset', ({ detail }) => {
        try { if (detail.cleared) clearVfsSessionStorage(); }
        finally { globalThis.dispatchEvent(new CustomEvent('vfs-reset', { detail })); }
        if (detail.remote && typeof document !== 'undefined') location.reload();
      });
      globalThis.vfs = vfs;
    }
    return vfs;
  }

  // Workstation scripts also use these compatibility entry points. Storage internals stay private.
  Object.assign(globalThis, { VirtualFileSystem, openVfs, clearVfsWorkspace, vfsSnapshotDigest,
    newVfsGeneration, readInstalledResource, isWorkspaceRecovering, isVfsProjectIndex, VFS_APPS_DIRECTORY });

  if (vfsSkipPreload || globalThis.document?.currentScript?.hasAttribute('data-vfs-workspace') ||
      (vfsStandaloneApp && !window.susi?.files && !document.body?.hasAttribute('data-chat-demo'))) {
    globalThis.vfsReady = openVfs({ existingOnly: vfsSkipPreload });
  } else if (!vfsStandaloneApp && !('vfsReady' in globalThis)) {
    // Older pages and classic workers can still await vfsReady. Loading the library alone opens no database.
    Object.defineProperty(globalThis, 'vfsReady', {
      configurable: true,
      get() { return globalThis.vfsReady = openVfs(); },
      set(value) { Object.defineProperty(globalThis, 'vfsReady', { value, writable: true, configurable: true }); }
    });
  }
})();
