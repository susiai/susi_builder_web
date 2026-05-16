"use strict";

(async () => {
  const output = document.getElementById('console-output');
  const interrupt = document.getElementById('console-interrupt');
  const location = document.getElementById('console-cwd');
  const status = document.getElementById('console-status');
  const statusMessage = document.getElementById('console-status-message');
  const reload = document.getElementById('console-reload');
  const historyStatus = document.getElementById('console-history-status');
  const clearHistory = document.getElementById('console-clear-history');
  reload.addEventListener('click', () => window.location.reload());

  const terminal = new Terminal({
    convertEol: true,
    cursorInactiveStyle: 'none',
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: matchMedia('(max-width: 43rem)').matches ? 12 : 14,
    scrollback: 4000,
    screenReaderMode: true,
    theme: {
      background: '#0b0f1a',
      foreground: '#dce3f0',
      cursor: '#dafc3d',
      selectionBackground: '#35435d',
      black: '#080a12',
      brightBlack: '#a5b2cc',
      red: '#ff85bd',
      brightRed: '#ffa7cf',
      green: '#dafc3d',
      brightGreen: '#efffa1',
      yellow: '#f7df7a',
      brightYellow: '#fff2a9',
      blue: '#91abff',
      brightBlue: '#bbcbff',
      magenta: '#c8a0fa',
      brightMagenta: '#e2caff',
      cyan: '#97eaf9',
      brightCyan: '#c4f8ff',
      white: '#dce3f0',
      brightWhite: '#f1f4ff'
    }
  });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(output);
  terminal.textarea.setAttribute('aria-label', 'Bash command');
  terminal.textarea.setAttribute('aria-describedby', 'console-keys');
  new ResizeObserver(() => fit.fit()).observe(output);
  document.fonts.ready.then(() => fit.fit());

  function sizeViewport() {
    const viewport = window.visualViewport;
    if (viewport?.scale === 1) {
      document.body.style.setProperty('--console-viewport', `${viewport.height}px`);
    } else {
      document.body.style.removeProperty('--console-viewport');
    }
  }
  window.visualViewport?.addEventListener('resize', sizeViewport);
  sizeViewport();

  let cwd = '/';
  let env = {};
  let exitCode = 0;
  let execution;
  let clearing = false;
  let fs;
  let shell;

  const shellSeparator = /[\t\r\n ;|&()<>]/;

  function pathPrefixAtCursor(line, cursor) {
    let start = 0;
    let path = "";
    let quote = "";

    for (let i = 0; i < cursor; i++) {
      const char = line[i];
      if (char === "\\" && quote !== "'") {
        const next = line[i + 1];
        if (i + 1 >= cursor) return null;
        if (!quote || /["\\$`\n]/.test(next)) {
          if (next !== "\n") path += next;
          i++;
          continue;
        }
      }
      if (quote) {
        if (char === quote) quote = "";
        else path += char;
      } else if (char === "'" || char === '"') {
        quote = char;
      } else if (shellSeparator.test(char)) {
        path = "";
        start = i + 1;
      } else if (char === "#" && i === start) {
        const nextLine = line.indexOf("\n", i);
        if (nextLine < 0 || nextLine >= cursor) return null;
        i = nextLine;
        start = i + 1;
      } else {
        path += char;
      }
    }

    // Complete at a word boundary without replacing text already to the right.
    const next = line[cursor];
    if (next && (quote ? next !== quote : !shellSeparator.test(next))) return null;
    return { path, quote, homeRelative: line.startsWith("~/", start) };
  }

  function quotePathSuffix(suffix, quote) {
    if (quote === "'") return suffix.replaceAll("'", "'\\''");
    if (quote === '"') return suffix.replace(/["\\$`]/g, "\\$&");
    return suffix.replace(/[\s\\'"$`<>|&;(){}\[\]*?!#~=]/g, "\\$&");
  }

  async function completeVfsPath(fs, cwd, home, line, cursor) {
    const word = pathPrefixAtCursor(line, cursor);
    if (!word) return "";
    const slash = word.path.lastIndexOf("/") + 1;
    const directory = word.path.slice(0, slash);
    const fragment = word.path.slice(slash);
    const target = word.homeRelative && home?.startsWith("/") ? home + directory.slice(1) : directory;
    const parent = fs.resolvePath(cwd, target);
    const names = await fs.readdir(parent);
    const matches = names.filter(name => name.startsWith(fragment) &&
      (fragment.startsWith(".") || !name.startsWith(".")) && !/[\x00-\x1f\x7f-\x9f]/.test(name));
    if (!matches.length) return "";

    if (matches.length === 1) {
      const name = matches[0];
      const entry = await fs.stat(fs.resolvePath(parent, name));
      return quotePathSuffix(name.slice(fragment.length) + (entry.isDirectory ? "/" : ""), word.quote);
    }

    matches.sort();
    const first = matches[0];
    const last = matches.at(-1);
    let end = fragment.length;
    for (const char of first.slice(end)) {
      if (!last.startsWith(char, end)) break;
      end += char.length;
    }
    return quotePathSuffix(first.slice(fragment.length, end), word.quote);
  }

  const readline = new XtermReadline.Readline();
  readline.setCompletionHandler((line, cursor) => fs ? completeVfsPath(fs, cwd, env.HOME, line, cursor) : '');
  terminal.loadAddon(readline);

  // Opening IndexedDB can wait on another tab. It must not prevent attaching the input or drawing the prompt.
  const storageWarning = setTimeout(() => {
    reload.hidden = false;
  }, 10000);
  const shellReady = Promise.resolve().then(async () => {
    if (!window.vfsReady) throw new Error('Workspace storage did not start. Reload the console.');
    fs = createJustBashFileSystem(await window.vfsReady);
    const displayText = (args, { exec, cwd, stdin }) =>
      exec('cat', { args, cwd, stdin, stdinKind: 'bytes' });
    shell = new JustBash.Bash({
      fs,
      cwd: '/',
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', TMPDIR: '/' },
      customCommands: ['more', 'less'].map((name) => ({ name, execute: displayText }))
    });
    env = shell.getEnv();
  });
  shellReady.then(() => {
    clearTimeout(storageWarning);
    status.hidden = true;
  }, error => {
    clearTimeout(storageWarning);
    statusMessage.textContent = error?.message || 'Unable to open workspace storage.';
    status.setAttribute('role', 'alert');
    reload.hidden = false;
  });

  function waitForShell(signal) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Command timed out waiting for workspace storage. Try again when it opens.')), 15000);
      const abort = () => finish(signal.reason || new DOMException('Interrupted.', 'AbortError'));
      function finish(error) {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      }
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      shellReady.then(() => finish(), finish);
    });
  }

  function cancel() {
    if (!execution || execution.signal.aborted) return;
    execution.abort();
    interrupt.disabled = true;
  }

  function writeResult(result) {
    const { stdout, stderr } = result;
    if (stdout) {
      if (result.stdoutKind === 'bytes' || result.stdoutEncoding === 'binary') {
        terminal.write(Uint8Array.from(stdout, (character) => character.charCodeAt(0)));
      } else {
        terminal.write(stdout);
      }
      if (!stdout.endsWith('\n')) terminal.writeln('');
    }
    if (stderr) {
      terminal.write(stderr);
      if (!stderr.endsWith('\n')) terminal.writeln('');
    }
  }

  output.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
      event.stopPropagation();
    }
  }, { capture: true });
  readline.setCtrlCHandler(cancel);
  interrupt.addEventListener('click', () => {
    terminal.focus();
    cancel();
  });

  function historyError(error) {
    historyStatus.textContent = 'Console history storage is unavailable. ' + (error?.message || String(error));
    historyStatus.hidden = false;
  }

  clearHistory.addEventListener('click', () => {
    try { susiConsoleHistory.clear(); }
    catch (error) {
      historyError(error);
      try { if (susiConsoleHistory.read().length) return; } catch { /* Only in-memory history is accessible. */ }
    }
    clearing = true;
    cancel();
    window.location.reload();
  });
  window.addEventListener('pagehide', cancel);
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
  window.addEventListener('vfs-reset', event => {
    if (!event.detail?.cleared) return;
    clearing = true;
    cancel();
    terminal.reset();
    statusMessage.textContent = 'Workspace cleared. Reload to start a fresh workspace.';
    status.hidden = false;
    reload.hidden = false;
    clearHistory.disabled = true;
  });

  function prompt(path) {
    return `\x1b[1;92m${path.replace(/[\x00-\x1f\x7f-\x9f]/g, '?')} $\x1b[0m `;
  }

  async function execute(command) {
    execution = new AbortController();
    interrupt.hidden = false;
    interrupt.disabled = false;
    terminal.scrollToBottom();
    let entry, start;
    try { entry = susiConsoleHistory.start(cwd, command); }
    catch (error) { historyError(error); }
    terminal.write('\x1b[?25l', () => { if (entry) start = terminal.registerMarker(); });

    try {
      await waitForShell(execution.signal);
      execution.signal.throwIfAborted();
      const result = await shell.exec(`(exit ${exitCode})\n${command}`, {
        rawScript: true,
        cwd,
        env: { ...env, COLUMNS: String(terminal.cols), LINES: String(terminal.rows) },
        replaceEnv: true,
        signal: execution.signal
      });
      exitCode = result.exitCode;
      env = result.env;
      if (env.PWD !== cwd && env.PWD?.startsWith('/')) {
        const entry = await fs.stat(env.PWD).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (entry?.isDirectory) cwd = env.PWD;
      }
      location.textContent = cwd;
      location.title = cwd;
      writeResult(result);
    } catch (error) {
      exitCode = execution.signal.aborted ? 130 : 1;
      if (!execution.signal.aborted) terminal.writeln(error?.message || String(error));
    } finally {
      interrupt.disabled = true;
      if (execution.signal.aborted) {
        exitCode = 130;
        terminal.writeln('^C');
      }
      if (entry) {
        // Read the rendered output after xterm processes bytes, colors, and cursor movements.
        // Reopening the log prints plain text without running commands or replaying terminal controls.
        await new Promise(resolve => terminal.write('', resolve));
        if (!clearing) {
          try {
            const buffer = terminal.buffer.active;
            const end = buffer.baseY + buffer.cursorY;
            const parts = [];
            for (let i = Math.max(0, start?.line ?? 0); i < end; i++) {
              const wrapped = buffer.getLine(i + 1)?.isWrapped;
              parts.push(buffer.getLine(i).translateToString(!wrapped));
              if (!wrapped) parts.push('\n');
            }
            if (buffer.cursorX > 0) parts.push(buffer.getLine(end).translateToString(true), '\n');
            susiConsoleHistory.finish(entry, parts.join(''), !start || start.isDisposed);
            historyStatus.hidden = true;
          } catch (error) { historyError(error); }
        }
        start?.dispose();
      }
      execution = undefined;
      interrupt.hidden = true;
    }
  }

  terminal.writeln('\x1b[1;92mSUSI BUILDER CONSOLE\x1b[0m');
  terminal.writeln('Working directory / · Type help for built-in commands.');
  terminal.writeln('');
  try {
    for (const entry of susiConsoleHistory.read()) {
      readline.appendHistory(entry.command);
      terminal.writeln(prompt(entry.cwd) + entry.command);
      if (entry.output === null) terminal.writeln('[No result recorded]');
      else if (entry.output) terminal.write(entry.output.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));
    }
  } catch (error) { historyError(error); }
  if (matchMedia('(pointer: fine)').matches) terminal.focus();

  while (!clearing) {
    // Enable bracketed paste so pasted line breaks stay in the draft.
    terminal.write('\x1b[0m\x1b[?25h\x1b[?2004h');
    const command = await readline.read(prompt(cwd));
    if (!clearing && command.trim()) await execute(command);
  }
})().catch(error => {
  // Startup failures must remain visible even when the terminal or one of its addons could not open.
  console.error('Unable to start the console:', error);
  const status = document.getElementById('console-status');
  status.hidden = false;
  status.setAttribute('role', 'alert');
  document.getElementById('console-status-message').textContent = error?.message || 'Unable to start the console.';
  const reload = document.getElementById('console-reload');
  reload.hidden = false;
});
