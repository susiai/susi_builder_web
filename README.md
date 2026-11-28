# SUSI Builder

SUSI Builder is an open-source workstation for agentic coding in the browser. The coding agent, console, and app
preview share a virtual file system (VFS) stored in the browser's IndexedDB.

## Get started

1. Open `docs/index.html` directly in your browser.
2. Open **Chat** and send a message. The default WebGPU model is LFM2.5 350M on phones and LFM3 1.7B on other devices.
   Both fall back to LFM2.5 350M on WASM. Chat downloads models as needed. You can send a message while the model
   loads, and each model works offline once its files have downloaded.
3. Use **Apps → New App** or **Create App** to start another app. Describe what it should do in **Chat**, then
   open the result with **View**.

In **Configuration → Models**, choose a primary WebGPU model and a separate WASM fallback, or select a model from an
OpenAI-compatible API endpoint such as Ollama. Use **Test model** to try your selection before saving it for Chat.
The primary model is saved for the current device category in `/config.json` under `chatLocalPrimaryDesktop` or
`chatLocalPrimaryMobile`.
Speech-to-text and speech output are off until you configure them there.

## Build and edit apps

- **Apps** lets you open your apps in Chat, preview them with View, or download them as ZIPs. New apps have an
  `index.html` under `/Apps/<name>/`. Unpack an exported app to publish it on a static web host.
- **Create App** combines designs, layouts, components, and bundled libraries. Build a dashboard, chat app, notebook,
  data workspace, or game from a starter with a live preview. [Template guide](docs/templates/README.md)
- **Chat** streams replies and gives the agent tools to read, search, and edit files in the selected app.
  The agent can call `run_python` with the path to a saved Python script in the active project.
  It can also call `run_javascript` with the path to a saved JavaScript module. The isolated runtime supports local
  imports, `console` output, and `readFile`, `writeFile`, `mkdir`, `readdir`, and `unlink` from `node:fs/promises`.
  JavaScript paths resolve from the project root at `/workspace`. Successful runs save their file changes together.
  Paste or attach images and use LFM3-VL-2B or Qwen3.5 4B on WebGPU, or a vision-capable API model.
  Attach text, PDF, XLSX, DOCX, PPTX, or audio files. Audio attachments use the selected speech-to-text model.
  Browser chat models run offline once downloaded to `/Models/Chat/`. Qwen3 0.6B and LFM2.5 350M support WebGPU
  and WASM. Qwen3 1.7B, Qwen3.5 2B, LFM2.5 1.2B Instruct, and LFM3 1.7B use WebGPU.
- **Console** runs Bash-like commands and shell scripts against workspace files and keeps command history.
  Run `python3 script.py` (also `python` or `python3.14`) to execute a workspace script in the browser.

Python loads Pyodide from jsDelivr on demand, including Pyodide packages imported directly by the script. Scripts see
workspace files under `/workspace` and use standard Python file operations. Changes are saved back when execution
finishes. An interrupted run discards pending writes.

Try `python3 /bin/python_example_csv.py` in Console, or list the five examples with `ls /bin/python_example_*.py`.
Each example creates sample input and writes results under `python-examples/` in the current directory. Edit the
sample input and rerun the script to see different results.

## How the preview runs without a server

**Preview** runs app files from the VFS in a sandbox, including when SUSI Builder is opened from disk. Apps can use
`window.susi.files.readFile` and `writeFile` to work with live files in their own folder.
Add `&menu=false` to a `view.html?path=…` link to open the app without the SUSI Builder menu.

A generated chat app has its own **Configuration** page for its API host and model. Preview allows API calls,
including to Ollama on localhost, when the endpoint permits them.

In **Create App**, add **Workbench Chat** under **Bring your tools** to use the same Chat interface and agent loop
as SUSI Builder. The generated app includes its own projects, conversation history, attachments, and tool logs.

## Tools and integrations

- **Browser** shares screenshots or a participating app with Chat. Interactive actions require approval in Browser.
- Use **Skill Creator** to write a skill, then enable it in **Skill Library**. Run
  `python3 tools/serve-webstation.py` for rendered page reading on localhost. On macOS, you can also use
  [Start Skill Creator.command](<Start Skill Creator.command>) with a workspace opened from disk.
- **Tools** lets you edit tool descriptions and set the maximum tool calls per reply.
- **Chat** can use enabled MCP functions from connectors saved in the workspace configuration.
- In **Models**, choose local Whisper or a transcription API for audio attachments and dictation in Chat.
  Read completed Chat replies aloud with local Chatterbox or the OpenAI Realtime API. The selected API
  receives the audio or text it processes. API keys stay in the browser tab's session storage.

## Workspace storage and backups

**Workspace** backs up apps, settings, conversations, and run activity in unencrypted ZIP files. It can also restore
older encrypted `.wsbackup` files using their original passphrase.
Browser storage is tied to the address you open. Use a workspace backup to move between a local file and a hosted copy.

After `const vfs = await vfsReady`, call `vfs.archive.exportFolder(path)` to get a ZIP `{ name, blob }`
or `vfs.archive.importFolder(file)` to extract a ZIP and get its new folder path. For full workspace
backups, `vfs.archive.encodeBackup(snapshot)` and `vfs.archive.decodeBackup(file, passphrase)` use the
workspace manifest. Decoding a backup lets the caller inspect it before restoring it.

**Reset Default Files** restores the bundled files from `vfs-preload/`, including `config.json`, and keeps other
workspace files. **Clear** deletes the workspace database. Conversations, console history, and credentials use
separate browser storage. Workspace opens without loading defaults. Opening a page such as Apps starts a
fresh workspace if the database is empty.

### Reusing the virtual file system

Load `docs/js/vfs.js` as a classic script in a page or worker. Each call to
`VirtualFileSystem.open()` returns a connection. Choose a database name to keep an application's
files separate from the workstation's `vfs` database.

```js
const notes = await VirtualFileSystem.open({ databaseName: "notes" });
try {
    await notes.fileSystem.write("/draft.txt", "First draft");
    const text = await notes.get("/draft.txt");
} finally {
    notes.close();
}
```

A named database starts empty. To seed it, pass a `loadDefaults` function that returns an array
of `{ path, value }` entries or a promise for that array. `resetToDefaults()` replaces the contents
and emits a `reset` event on open connections to that database. Reopen it to write again.
Folder and backup ZIPs use the instance's `archive` API. To use ZIPs in another project, also copy
`vendor/zip-2.25.0.min.js` and its license beside the script in the same `vendor/` layout.

### Reusing the project catalog

Load `docs/js/vfs.js` and `docs/js/project-catalog.js` as classic scripts. A catalog uses the
VFS connection passed to it. `listPaths()` discovers apps by their `index.html`. Calling `list()` also
returns each app's manifest, pin state, and available artwork.

```js
const catalog = new ProjectCatalog(await vfsReady);
const path = await catalog.create("Notes", { indexHtml: "<title>Notes</title>" });
await catalog.setPinned(path, true);
const pinnedApps = (await catalog.list()).filter(app => app.pinned);
```

`setPinned()` preserves custom manifest fields. If another writer changes or creates the manifest
between the read and the write, the operation rejects and preserves the other writer's version.

### Sharing a JSON settings file

Load `docs/js/workspace-config-store.js` and pass a storage adapter to `WorkspaceConfigStore`.
The default path is `/config.json`. Pass a second argument to use a different file.

```js
const settings = new WorkspaceConfigStore(await vfsReady, "/my-app/settings.json");
await settings.update(current => ({ ...current, theme: "dark" }));
const { theme } = await settings.read();
```

The adapter supplies `getasync(path)` and an atomic `update(path, transform)` that returns the saved text.
A missing file reads as an empty object. Each update receives the latest document, so features can
merge their own changes in a synchronous callback. Returning `undefined` keeps the existing text.

### Reusing the skill library

Load `docs/js/vfs.js`, `docs/js/workspace-config-store.js`, and `docs/js/skills.js` as classic
scripts. Pass a VFS connection to `SkillLibrary`. Its methods use Markdown paths relative to
`/Skills/`, including subfolders.

```js
const vfs = await VirtualFileSystem.open({ databaseName: "my-app" });
try {
    const skills = new SkillLibrary(vfs);
    const path = await skills.create("Review a draft", "Check each citation against its source.");
    await skills.setEnabled(path, true);
    const { matches } = await skills.search("citation");
    await skills.delete(path);
} finally {
    vfs.close();
}
```

`create()` rejects an existing filename. Deleting a skill also removes its approval.
Given a VFS with a `loadDefaults` function, `installDefaults()` restores missing bundled
Markdown files and returns the number added. Restored skills start disabled. Existing files
keep their content and approval.

### Reusing the workspace run store

Load `docs/js/vfs.js` and `docs/js/workstation-state.js` as classic scripts. Each
`WorkspaceRunStore` instance owns the runs it starts. Pass its fence to a project write to have
the VFS verify ownership and lease expiry inside the write transaction.

```js
const vfs = await vfsReady;
const runs = new WorkspaceRunStore(vfs);
const run = await runs.start({ project: "/Notes/", profile: "builder", prompt: "Save a draft" });
await vfs.put("/Notes/draft.md", "# Draft", { guard: runs.fence(run.id) });
await runs.finish(run.id, "completed", "Saved draft.md");
```

Use `heartbeat(id)` to renew a running lease and `recover()` to mark expired runs and their
latest tasks interrupted. Restoring a backup interrupts historical executions before their
files become writable. The store defaults to `/.webstation/workspace.json` and accepts a custom
index path as its second argument. For older backups with an unmarked custom index, pass its
absolute path in the `runStorePaths` option to `vfs.recovery.restore()`.

### Reusing conversation history

Load `docs/js/conversation-store.js` as a classic script. Give each editor its own store.
Use `ConversationStore.forBrowser()` for local storage or `ConversationStore.forProject(vfs)`
for files in a workspace. Both use the same keys and saved turns.

```js
const history = ConversationStore.forProject(await vfsReady);
const key = ConversationStore.key({ chatProvider: "browser" }, "/Notes/");
const turns = await history.read(key);
turns.push({ prompt: "First question", messages: [] });
await history.save(key, turns);
```

Reading a saved streaming turn recovers its partial assistant reply in memory. Saving compares
the stored contents with the editor's last read or successful save. A stale save rejects with
`code === "EEXIST"` and leaves the newer conversation available to read. An explicit `clear(key)`
can replace a malformed conversation after a read attempt and performs the same conflict check.
The browser adapter coordinates simultaneous writers with Web Locks or an IndexedDB transaction.
A custom adapter can supply `read(key)`, returning saved text or `null`, and
`replace(key, expected, text)`, which must compare and replace atomically.

### Running an agent with custom tools

Load `docs/js/llm-client.js`, `docs/js/tool-registry.js`, and `docs/js/agent-runtime.js`
as classic scripts. Each registry starts empty. Register a function definition and a handler
that receives the parsed arguments and the call context, including its cancellation signal.

```js
const registry = new ToolRegistry();
registry.register({
    type: "function",
    function: {
        name: "word_count",
        description: "Count the words in a string.",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
    }
}, ({ text }) => text.trim().split(/\s+/).filter(Boolean).length);

const reply = await runAgent({
    client: new LlmClient(), registry,
    config: { chatProvider: "api", apihost: "http://localhost:11434", model: "your-model" },
    messages: [{ role: "user", content: "Count the words in 'Welcome home'." }],
    maxToolCalls: 1, signal: new AbortController().signal
});
```

`registry.listTools(descriptions)` returns the schemas with optional description overrides.
Pass a subset as `tools` to restrict a run. A `refreshTools` callback can narrow that subset
before each model request. The loop dispatches only the tool names advertised for that round.
Chat and the Tools settings page use `docs/js/workstation-tools.js` for the built-in catalog.

### Editing a workbook outside the Table page

Load the bundled LosslessJSON script followed by `table-formats.js`, `table-formulas.js`,
`table-charts.js`, and `workbook.js` from `docs/js/`. A `Workbook` operates on the
same worksheets used by the XLSX reader and writer. Row and column indices start at zero.

```js
const data = Workbook.createSheet("Data", 2, 1);
const summary = Workbook.createSheet("Summary", 1, 1);
const book = new Workbook([data, summary]);
book.editCells([{row: 1, column: 0, value: 7}]);
book.selectSheet(summary);
book.editCells([{row: 0, column: 0, value: new tableCalc.Formula("=Data!A2")}]);

book.selectSheet(data);
book.insertRows(1);
summary.rows[0][0].expression; // "=Data!A3"
book.calculator(summary, 0, 0); // 7
book.undo();                    // Restores the row and "=Data!A2"
```

Structural edits update formulas across sheets and chart ranges on the edited sheet in one
history entry. `undo()` and `redo()` select the affected worksheet. `markSaved()` records
a checkpoint. `dirty` includes formatting changes, while `dataDirty` tracks edits to the data.

## Development checks

Serve the repository root with a static server to open the relevant browser checks in `tests/`.
Open `tests/vfs-instance.html` to check database isolation, reset handling, and the Explorer and project write policies.
Open `tests/project-catalog.html` to check app discovery, pinning, and concurrent manifest edits.
Open `tests/conversation-store.html` to check saved replies, interrupted streams, and competing edits on both storage backends.
Open `tests/workspace-run-store.html` to check run ownership, rollback at lease expiry, and restore across workspaces.
Open `tests/skill-library.html` to check the skill lifecycle across two connections to the same workspace.
The browser loads its default workspace from `docs/vfs-preload.js`, including when GitHub Pages publishes `docs/`.
Keep that package and the raw file index in `docs/vfs-preload.json` in sync with `vfs-preload/` when changing the
bundled files. To read the raw files when serving the repository root, set `globalThis.VFS_PRELOAD_URL` to
`../vfs-preload.json` before loading `docs/js/vfs.js`.

SUSI Builder is distributed under the MIT license. The VFS source, bundled libraries, and fonts carry their own
license notices. [License](LICENSE)
