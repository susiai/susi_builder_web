# Website templates

`create_app.html` creates independent website projects. Design, purpose, page structure, building blocks, and libraries
can be combined. Purpose selects editable recommendations; changing a design keeps the other choices. The live preview
uses the same generated files as project creation and does not write a temporary project to the VFS.

## Designs and purposes

- **Default design:** the shared stylesheet, copied as `css/susi.css`, with local Geist and Barlow Condensed fonts
  and their OFL licenses.
- **Notes:** warm paper, serif typography, rust and olive accents.
- **Harbor:** a light workspace with cobalt accents and restrained cards.
- **Bloom:** a dark plum canvas, peach accents and rounded surfaces.
- **Hacker** pairs a dark terminal grid with phosphor green, monospace type and amber highlights.
- **Flower** combines raspberry pink, lilac, apricot and mint with a floral header and serif headings.
- **XP** combines glossy cobalt bars, beveled controls and a pastel desktop landscape.
- **Spectrum** uses a fixed-width body font, local Silkscreen headings and stepped pixel art in a bright 8-bit palette.

Purposes include Dashboard, Landing page, Portfolio, Knowledge base, Chat, Code playground, Data workspace,
VFS notebook, 2D game, and Game design lab. Each provides sample content and recommended libraries. Dashboard suggests
Plotly basic. You can choose uPlot or leave charts out under **Chart library**. Optional blocks include a searchable
table, metric cards, feature cards, and a demo form.
Layouts can use one column, an overview grid, or a sidebar.

## Chat

Choose the **Chat** purpose to preselect **Basic Chat**. The library can also be selected for other purposes
under **Bring your tools**, alongside other libraries. It adds streaming replies and a separate **Configuration** page.
Choose a WebGPU model and WASM fallback, or enter an OpenAI-compatible API host and select or type a model ID.
Configuration uses the same chat model panel as SUSI Builder, including Ollama setup, a test prompt, a system prompt,
thinking controls, and the request idle timeout. The Create App preview uses sample replies.

Open the generated project with **Preview app** to use Builder's browser model cache or reach an API endpoint,
including Ollama on localhost. An API endpoint must accept requests from the browser origin. Model settings are saved
in `chat-settings.json` inside the VFS project. Standalone exports use the shared IndexedDB database `vfs` for their
origin and store settings under `/.webstation/apps/<app-id>/`. The ID is generated with the app and included in the
export. API keys stay in the current browser tab.

### Full Chat workbench

Select **Workbench Chat** under **Bring your tools** for a project sidebar, conversation history, agent profiles,
tool calls, attachments, and prompt retry. The selected design styles both the
workbench and the starter. Choose the workbench by itself with the Chat purpose for a full-page layout, or combine
it with other blocks to put it on the starter page. The Chat library group also offers the simple chat and an option
to omit chat. Set the workbench model in `agent-chat-config.html`.
Edit the selected design stylesheet under `css/` to theme both the starter and the workbench.

The workbench initially opens the empty `/Projects/` folder. Start right there or create a subfolder for a separate
project and conversation. Folders can hold any files, including scripts or notes.

To reuse it in another app, copy the scripts and local assets referenced by the generated Chat page. Keep their order
and load `js/susi-chat.js` with `data-vfs-standalone`. Call `susiChatApp.mount({ appId, modelHref, container })`
from a deferred script. Use the generated 32-character app ID to keep the app's data in its own workspace.
Preview limits the workbench to its app directory. A standalone export uses the same IndexedDB database with
an app-specific path. Enter model keys in Configuration. They stay in the current tab and are kept out of app files.

The generated app has its own model settings. Browser tools and speech settings are managed in SUSI Builder.

### Browser inference in a standalone app

For an OpenAI-compatible endpoint, load `llm-client.js` and use `new LlmClient()`.
For the bundled browser backend, also load `transformer-model-assets.js` and `llm-local.js` in that order,
include the Transformers.js bundle in `js/vendor/`, and use `new LlmClient({ browserBackend: llmLocal })`.
Generated Chat apps include these files. Their existing `llmClient.create()` factory selects the page's backend.
If you also use `llmClient.createConfigStore(storage, path)` in your own app, load
`workspace-config-store.js` before creating the settings store.
Pass `provider: "browser"`, `model: "qwen3-0.6b-webgpu"`, and `fallbackModel: "lfm2.5-350m-wasm"` to
`streamChat()` or `completeChat()`. The worker prepares the selected builds as needed. See `llmLocal.models`
for available combination IDs. To use a single device, install it with `llmLocal.download(vfs, model, device)`
and pass `model` and `device` to the client.

For apps that follow workspace settings, call `const selection = client.selectModel(config)` when
settings change. Use `await selection.status({ signal, onProgress })` to display readiness, and pass
`selection.options` to generation. Query image support with `client.supportsImages(selection.options)`.
When `selection.canPrepareOnDemand` is true, a user can send a
message while preparation is still running.

To use another browser backend, supply an object with `status(options, preparation)` and `generate(request)`.
The first returns a readiness object with `ready`, `label`, and `message`. The second returns an assistant
`message` and can report `model`, `finishReason`, `promptTokens`, and `completionTokens`. An optional
`supportsImages(options)` method advertises vision. A backend can also implement `close()` to release a
changed selection and `onModelStatusChange(listener)` to return an unsubscribe function.

Both methods return `message`, `finishReason`, and `model` for browser models and OpenAI-compatible
endpoints. Read reply text from `result.message.content` and tool calls from `result.message.tool_calls`.
The model ID comes from the provider when available and otherwise defaults to the requested ID.
`result.usage` can contain `prompt_tokens`, `completion_tokens`, and `total_tokens`.
`result.tokenCount` is the completion token count. Missing counts are `undefined`, and a reported zero stays zero.

For images, select `lfm3-vl-2b-webgpu` or `qwen3.5-4b-webgpu` and use OpenAI Chat Completions
`image_url` parts in user messages.
The browser backend accepts base64 data URLs and HTTP(S) image URLs that permit browser access via CORS.

## VFS notebook

Choose **VFS notebook**, or add the **App file editor** block to any other purpose. The starter includes
`notes.md` and `js/notebook.js`. Save in the Create App preview to carry your draft into the new project.
After **Create App → Preview app**, **Save note** writes the actual project file. **Reload note** reads
the latest version, including edits made in Code Studio. The standalone export can open and download text files.
The [project file API](../../README.md#how-the-preview-runs-without-a-server) also works in other generated apps.

## Data workspace

Choose **Data workspace** for three views of one table. Each view also works independently with any design or purpose.

- **Interactive data table** lets you sort by a header, show or hide columns, and choose the page size.
- **Grouped summary** counts the records in each group and shows its share of the matching rows.
- **Column profile** shows the inferred type, distinct values, missing cells, and ranges for numbers and dates.

Under **Dataset for these views**, choose the sample river survey, a table in the workspace, or a CSV, JSONL or
Parquet file from your computer. Create App includes a snapshot in `js/dataset.js`. Its rows follow the order of
the column headers, with values stored as display text to preserve precision and leading zeros. Empty strings,
absent fields and nulls count as missing. The original file stays separate and the project works offline.

Searching all columns or a single column updates every selected view. If selected, the chart compares populated
and missing cells across the complete dataset. The ZIP download includes the filtered records in their current
sort order, with all columns.

## Games and game design

**2D game** starts with Crystal trail. Move with the arrow keys, WASD, or the on-screen buttons, collect the
crystals, and reach the exit. **Game design lab** adds a tile map editor, an 8 × 8 player sprite editor, and
a Markdown playtest brief. All four blocks can be combined individually with any design or purpose.

In the live preview, paint with a pointer or use the arrow keys and Space on an editor grid. Each editor can undo
a stroke. Moving the start or exit keeps a single copy on the map. Level edits restart the game with the new map.
**Create App** includes the edited level and pixels in `js/game-data.js` and the brief in `PLAYTEST.md`.
In the resulting project, **Download game data** exports a replacement for `js/game-data.js`. The sprite editor
also exports a transparent PNG, and the brief can be downloaded as Markdown.

Select **Matter.js** to include a separate 2D physics sandbox with a ramp, balls, adjustable gravity,
and run, pause, and reset controls. Its example lives in `js/physics.js`.

## Project files

Every project includes `index.html`, `css/`, `js/app.js`, `app.json`, `README.md`, and license information. Chosen
libraries are copied into `js/vendor/`; their stylesheets go into `css/vendor/`. The default design and Spectrum also include
`fonts/` with their license notices. Scripts and styles use relative paths, and generated pages work independently.

Examples initialize the selected chart, editor, terminal, Markdown renderer, syntax parser, or archive library. The
terminal uses its own page-local, in-memory file system. Forms are demonstrations with no configured server endpoint.
All selected library files and license notices are included; exported projects require no CDN or package manager.

Existing libraries remain in `js/vendor/` (Highlight.js is in `js/`). Additional libraries that SUSI Builder
does not use itself are stored under `jsx/`. The pinned Plotly basic, uPlot, Matter.js, and Three.js bundles are listed
in the [source manifest](../jsx/SOURCES.md). Plotly basic supports bar, pie and scatter/line charts.
The xterm.js choice includes the Fit and Readline addons. Ace includes all bundled modes and its search extension.
Select **Three.js** to add a rotatable sample scene. The included browser bundle exposes `THREE` and uses WebGL 2.

## Source files

Each entry in `catalog.js` maps a `source` in the SUSI Builder installation to a `path` in the generated project.
Paths start at the folder containing `docs/` and `LICENSE`. Preview and creation read the same catalog files.
Opening `create_app.html` starts an in-memory preview, including from disk. **App name** names a folder under
`/Apps/` in the VFS. **Create App** writes all its files in one transaction and displays the resulting path.

On a host, Create App fetches the selected assets under `docs/` and reads the repository's MIT notice from the
packaged static resources. A local page can load installed classic scripts directly.
Each catalog script has a small adapter that exposes its original source to Create App and runs normally elsewhere.
Generated projects receive the script body with its original license comments. Fonts, styles and notices for the
direct-file reader are generated from their catalog sources. After updating a catalog asset, run
`python3 tools/index-template-assets.py` and use `--check` to verify the installed resources.

## Verification

Open `tests/templates.html` on a local static host. It checks every design/purpose combination, compares hosted and
direct-file reads, and exercises project creation, name collisions, missing files, and relative links.
The sandboxed preview exercises the data views, playable level, editors, and physics controls alongside the libraries.
The checks remove their temporary projects when they finish.
