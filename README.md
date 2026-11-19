# SUSI Builder

SUSI Builder is an open-source workstation for agentic coding in the browser. The coding agent, console, and app
preview share a virtual file system (VFS) stored in the browser's IndexedDB.

## Get started

1. Open `docs/index.html` directly in your browser.
2. Open **Chat** and send a message. New workspaces use LFM3 1.7B on WebGPU and fall back to LFM2.5 350M on WASM.
   It downloads each model when needed. You can send a message while the model loads. Each model works offline once
   its files have downloaded.
3. Use **Apps → New App** or **Create App** to start another app. Describe what it should do in **Chat**, then
   open the result with **View**.

In **Configuration → Models**, choose a primary WebGPU model and a separate WASM fallback, or select a model from an
OpenAI-compatible API endpoint such as Ollama. Use **Test model** to try your selection before saving it for Chat.
Speech-to-text and speech output are off until you configure them there.

## Build and edit apps

- **Apps** lets you open your apps in Chat, preview them with View, or download them as ZIPs. New apps have an
  `index.html` under `/Apps/<name>/`. Unpack an exported app to publish it on a static web host.
- **Create App** combines designs, layouts, components, and bundled libraries. Build a dashboard, chat app, notebook,
  data workspace, or game from a starter with a live preview. [Template guide](docs/templates/README.md)
- **Chat** streams replies and gives the agent tools to read, search, and edit files in the selected app.
  The agent can call `run_python` with the path to a saved Python script in the active project.
  Paste or attach images and use LFM3-VL-2B on WebGPU or a vision-capable API model to read them.
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

**Reset Default Files** restores the bundled files from `vfs-preload/`, including `config.json`, and keeps other
workspace files. **Clear** deletes the workspace database. Conversations, console history, and credentials use
separate browser storage. Workspace opens without loading defaults. Opening a page such as Apps starts a
fresh workspace if the database is empty.

## Development checks

Serve the repository root with a static server to open the relevant browser checks in `tests/`.
The browser loads its default workspace from `docs/vfs-preload.js`, including when GitHub Pages publishes `docs/`.
Keep that package and the raw file index in `docs/vfs-preload.json` in sync with `vfs-preload/` when changing the
bundled files. To read the raw files when serving the repository root, set `globalThis.VFS_PRELOAD_URL` to
`../vfs-preload.json` before loading `docs/js/vfs.js`.

SUSI Builder is distributed under the MIT license. The VFS source, bundled libraries, and fonts carry their own
license notices. [License](LICENSE)
