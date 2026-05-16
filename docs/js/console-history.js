"use strict";

const susiConsoleHistory = (() => {
  const prefix = 'webstation.console.history.v1.';
  const commandKey = prefix + 'command.';
  const outputKey = prefix + 'output.';
  const maxEntries = 200;
  const maxCharacters = 512 * 1024;
  const maxOutput = 64 * 1024;
  let lastTime = 0;

  function keys(storage, startsWith) {
    const matches = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(startsWith)) matches.push(key);
    }
    return matches;
  }

  function save(storage, key, value) {
    if (value.length > maxCharacters) throw new Error('This command is too large to keep in console history.');
    // A failed write must leave previously saved commands intact.
    storage.setItem(key, value);
    let remaining = maxCharacters;
    for (const [i, command] of keys(storage, commandKey).sort().reverse().entries()) {
      const output = outputKey + command.slice(commandKey.length);
      remaining -= (storage.getItem(command)?.length || 0) + (storage.getItem(output)?.length || 0);
      if (i >= maxEntries || remaining < 0) {
        storage.removeItem(command);
        storage.removeItem(output);
      }
    }
  }

  function read() {
    const storage = window.localStorage;
    const entries = [];
    for (const key of keys(storage, commandKey).sort()) {
      let entry;
      try { entry = JSON.parse(storage.getItem(key)); } catch { continue; }
      if (typeof entry?.cwd !== 'string' || typeof entry.command !== 'string' || !entry.command.trim() ||
          /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(entry.command)) continue;
      const output = storage.getItem(outputKey + key.slice(commandKey.length));
      entries.push({ cwd: entry.cwd, command: entry.command, output });
    }
    return entries;
  }

  function start(cwd, command) {
    lastTime = Math.max(Date.now(), lastTime + 1);
    const id = lastTime + '-' + crypto.getRandomValues(new Uint32Array(2)).join('-');
    save(window.localStorage, commandKey + id, JSON.stringify({ cwd, command }));
    return id;
  }

  function finish(id, text, truncated) {
    const storage = window.localStorage;
    const key = outputKey + id;
    // An older tab finishing after a clear can never recreate a submitted command.
    const command = storage.getItem(commandKey + id);
    if (command === null) return;
    const limit = Math.min(maxOutput, maxCharacters - command.length);
    if (truncated || text.length > limit) {
      const notice = '[Earlier output omitted]\n'.slice(0, limit);
      const start = Math.max(0, text.length - (limit - notice.length));
      text = notice + text.slice(start);
    }
    save(storage, key, text);
    if (storage.getItem(commandKey + id) === null) storage.removeItem(key);
  }

  function clear() {
    const storage = window.localStorage;
    for (const key of keys(storage, prefix)) storage.removeItem(key);
  }
  return { start, finish, read, clear };
})();
