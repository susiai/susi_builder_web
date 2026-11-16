"use strict";

const templateEngine = (() => {
	const siteRoot = new URL('../', document.currentScript.src);
	const blockAssets = [templateCatalog.dataAssets, templateCatalog.gameAssets, templateCatalog.notebookAssets];
	const byId = (items, id, label) => {
		const item = items.find(item => item.id === id);
		if (!item) throw new Error(`Unknown ${label}: ${id}`);
		return item;
	};
	const escapeHTML = text => String(text).replace(/[&<>"']/g, char => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	})[char]);

	function gameData(value = templateCatalog.gameAssets.defaults) {
		const level = value?.level, sprite = value?.sprite;
		if (!Array.isArray(level) || level.length < 3 || level.length > 24 || !level.every(row =>
			typeof row === 'string' && row.length >= 3 && row.length <= 32 && row.length === level[0].length &&
			/^[.#*SE]+$/.test(row)) || (level.join('').match(/S/g) || []).length !== 1 ||
			(level.join('').match(/E/g) || []).length !== 1) throw new Error('A level needs a rectangular map, one start and one exit.');
		if (!Array.isArray(sprite) || sprite.length !== 8 || !sprite.every(row =>
			typeof row === 'string' && /^[.1-4]{8}$/.test(row))) throw new Error('The player sprite must have 8 × 8 palette pixels.');
		return { level: [...level], sprite: [...sprite] };
	}

	function projectPackages(settings) {
		const packages = [templateCatalog.base, byId(templateCatalog.designs, settings.design, 'design')];
		for (const item of blockAssets) if (item.blocks.some(id => settings.blocks.includes(id))) packages.push(item);
		return packages.concat(templateCatalog.libraries.filter(item => settings.libraries.includes(item.id)));
	}

	function normalize(options) {
		const name = typeof options.name === 'string' ? options.name.trim() : '';
		if (!name || name.length > 80 || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name)) {
			throw new Error('Enter an app name of 1–80 characters without slashes or control characters.');
		}
		const purpose = byId(templateCatalog.purposes, options.purpose || 'dashboard', 'purpose');
		const design = byId(templateCatalog.designs, options.design || 'webstation', 'design');
		const layout = byId(templateCatalog.layouts, options.layout || purpose.layout, 'layout');
		const libraryIds = options.libraries ?? [...purpose.libraries, ...(purpose.chart === 'none' ? [] : [purpose.chart])];
		const blockIds = options.blocks ?? purpose.blocks;
		if (!Array.isArray(libraryIds) || !Array.isArray(blockIds)) throw new Error('Invalid template selection.');
		for (const id of libraryIds) byId(templateCatalog.libraries, id, 'library');
		for (const id of blockIds) byId(templateCatalog.blocks, id, 'building block');
		if (libraryIds.includes('plotly') && libraryIds.includes('uplot')) throw new Error('Choose one chart library.');
		const settings = {
			name, design: design.id, purpose: purpose.id, layout: layout.id,
			libraries: templateCatalog.libraries.filter(item => libraryIds.includes(item.id)).map(item => item.id),
			blocks: templateCatalog.blocks.filter(item => blockIds.includes(item.id)).map(item => item.id)
		};
		if (templateCatalog.gameAssets.blocks.some(id => settings.blocks.includes(id))) settings.gameData = gameData(options.gameData);
		if (templateCatalog.dataAssets.blocks.some(id => settings.blocks.includes(id))) {
			const dataset = options.dataset ?? templateCatalog.dataAssets.defaults;
			if (typeof dataset.name !== 'string' || !Array.isArray(dataset.columns) ||
				!dataset.columns.every(column => typeof column === 'string') || !Array.isArray(dataset.rows) ||
				!dataset.rows.every(row => Array.isArray(row) && row.length === dataset.columns.length &&
					row.every(cell => cell === null || typeof cell === 'string'))) throw new Error('Invalid table dataset.');
			settings.dataset = dataset;
		}
		if (settings.blocks.includes('playtest')) {
			settings.playtestNotes = options.playtestNotes ?? templateCatalog.gameAssets.playtestNotes;
			if (typeof settings.playtestNotes !== 'string' || settings.playtestNotes.length > 16000) {
				throw new Error('Use up to 16,000 characters for playtest notes.');
			}
		}
		return settings;
	}

	// Cache in-flight reads across previews and creation. Each project owns its binary file contents.
	function assetReader(read) {
		const requests = new Map();
		return async file => {
			if (!requests.has(file.source)) {
				const request = read(file).catch(error => { requests.delete(file.source); throw error; });
				requests.set(file.source, request);
			}
			const value = await requests.get(file.source);
			return { path: file.path, value: file.binary ? value.slice() : value };
		};
	}

	function sourceURL(source) {
		// A host may publish the contents of docs/ at any URL prefix.
		return new URL(source.startsWith('docs/') ? source.slice('docs/'.length) : '../' + source, siteRoot);
	}

	// Only the enclosed upstream bytes belong in a generated project, including any BOM or trailing newline.
	function scriptBody(text, source) {
		const opening = /\/\* susi source \*\/(\r?\n)/.exec(text);
		const end = opening && text.lastIndexOf(opening[1] + '/* end susi source */');
		if (!opening || end < opening.index + opening[0].length) throw new Error(`Invalid template script source: ${source}`);
		return text.slice(opening.index + opening[0].length, end);
	}

	let staticResources;
	const localReader = assetReader(async ({ source, binary, rawScript }) => {
		if (source.endsWith('.js') && !rawScript) {
			const factory = await readInstalledResource(sourceURL(source));
			return scriptBody(Function.prototype.toString.call(factory), source);
		}
		// Local pages cannot fetch CSS, fonts or notices as bytes. The catalog's static resources travel as data.
		staticResources ??= readInstalledResource(new URL('js/template-static.js', siteRoot)).catch(error => {
			staticResources = undefined;
			throw error;
		});
		const resources = await staticResources;
		if (!Object.hasOwn(resources, source)) throw new Error(`Missing template resource: ${source}`);
		return binary ? Uint8Array.from(atob(resources[source]), char => char.charCodeAt(0)) : resources[source];
	});

	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	const hostedReader = assetReader(async file => {
		const { source, binary, rawScript } = file;
		// Repository-level files such as LICENSE ship in the static resource bundle.
		if (!source.startsWith('docs/')) return (await localReader(file)).value;
		const response = await fetch(sourceURL(source), { cache: 'no-cache' });
		if (!response.ok) throw new Error(`Unable to load ${source} (HTTP ${response.status}).`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (binary) return bytes;
		const text = decoder.decode(bytes);
		return source.endsWith('.js') && !rawScript ? scriptBody(text, source) : text;
	});

	async function packageFiles(item, reader = siteRoot.protocol === 'file:' ? localReader : hostedReader) {
		return Promise.all(item.files.map(reader));
	}

	async function build(options, reader) {
		const { dataset, gameData: assets, playtestNotes, ...settings } = normalize(options);
		const design = byId(templateCatalog.designs, settings.design, 'design');
		const purpose = byId(templateCatalog.purposes, settings.purpose, 'purpose');
		const libraries = templateCatalog.libraries.filter(library => settings.libraries.includes(library.id));
		const packages = projectPackages(settings);
		// Finish loading before opening a write transaction, so a missing asset cannot leave half a project.
		const sources = new Map();
		for (const file of packages.flatMap(item => item.files)) {
			if (sources.has(file.path) && sources.get(file.path).source !== file.source) {
				throw new Error("Conflicting template files for " + file.path);
			}
			sources.set(file.path, file);
		}
		const files = new Map((await packageFiles({ files: [...sources.values()] }, reader)).map(({ path, value }) => [path, value]));
		if (assets) files.set('js/game-data.js', 'const gameData = ' + JSON.stringify(assets, null, 2) + ';\n');
		if (dataset) {
			// A classic script also supplies the dataset when an exported index.html is opened from disk.
			const records = dataset.rows.map(row => '    ' + JSON.stringify(row)).join(',\n');
			files.set('js/dataset.js', 'const projectDataset = {\n  name: ' + JSON.stringify(dataset.name) +
				',\n  columns: ' + JSON.stringify(dataset.columns) + ',\n  rows: [\n' + records + '\n  ]\n};\n');
		}
		if (playtestNotes !== undefined) files.set('PLAYTEST.md', playtestNotes);
		if (files.has('notes.md') && typeof options.notebookText === 'string') files.set('notes.md', options.notebookText);
		if (settings.libraries.includes('matter')) files.set('js/physics.js', '"use strict";\n(' + startTemplatePhysics.toString() + ')();\n');
		const withChat = settings.libraries.includes('chat');
		const workbench = libraries.find(library => library.id === 'chat-workbench');
		const workbenchHome = Boolean(workbench && libraries.length === 1 && !settings.blocks.length && purpose.id === 'chat');
		if (withChat || workbench) settings.appId = newVfsGeneration();
		const pageAssets = packages.filter(item => item.blocks);
		files.set('index.html', makeTemplateHTML(settings, design, purpose, libraries, pageAssets, playtestNotes));
		if (withChat) files.set('config.html', makeTemplateChatConfig(settings, design));
		if (workbench) {
			const destination = withChat ? 'agent-chat.html' : 'index.html';
			const bundle = workbench.bundle.map(path => {
				const code = files.get(path);
				files.delete(path);
				return code;
			});
			files.set('js/susi-chat.js', '"use strict";\n(() => {\n' + bundle.join('\n;\n') +
				'\n;\nglobalThis.susiChatApp = susiChatApp;\n})();\n');
			files.set('js/workbench-start.js', 'const container = document.getElementById("workbench-panel") || document.body;\n' +
				'susiChatApp.mount({ container }).catch(error => {\n' +
				'  document.getElementById("workbench-status").textContent = error.message || String(error);\n});\n');
			if (workbenchHome || withChat) files.set(destination, makeTemplateWorkbench(settings, design, withChat));
			const returnTo = workbenchHome || withChat ? destination : 'index.html#workbench-panel';
			files.set('agent-chat-config.html', makeTemplateChatConfig(settings, design, returnTo));
			files.set('Projects/', '');
		}
		const ace = libraries.find(library => library.id === 'ace');
		const runtime = { ...settings, ...(ace ? { acePath: ace.scripts[0].slice(0, ace.scripts[0].lastIndexOf('/')) } : {}) };
		files.set('js/app.js', '"use strict";\n(' + startTemplateApp.toString() + ')(' + JSON.stringify(runtime, null, 2) +
			').catch(error => { console.error(error); document.documentElement.dataset.templateError = error.message; ' +
			'document.getElementById("starter-status").textContent = "Unable to start an example: " + error.message; });\n');
		files.set('app.json', JSON.stringify({ version: 1, ...settings, pinned: false,
			libraries: libraries.map(({ id, version, license, url }) => ({ id, version, license, url })) }, null, 2) + '\n');
		files.set('README.md', `# ${settings.name}\n\n${purpose.name} starter.\n\n` +
			'Edit index.html, css/app.css and js/app.js. The selected design and other styles are in css/.\n' +
			'All resources use relative paths and are included locally.\n' +
			(withChat ?
				'Open Configuration to choose an OpenAI-compatible API host and a model ID. You can fetch the model list there.\n' +
				'Preview allows API calls. The endpoint must allow the browser origin via CORS.\n' +
				'Preview saves chat-settings.json in the app folder. Standalone copies use the shared vfs database for this origin.\n' +
				'API keys are never written to the app folder. If tab storage is unavailable, enter the key on the page that uses it.\n\n' :
				'The sample data and forms are a starting point; no remote service is configured.\n\n') +
			(workbench ?
				'Open ' + (withChat ? 'agent-chat.html' : 'index.html') + ' for the full Chat workbench. Configure its model in agent-chat-config.html.\n' +
				'The workbench starts in the empty /Projects/ folder. Create more folders there for separate projects and histories.\n' +
				'To embed the workbench, copy the scripts, styles and assets used by the generated chat page.\n' +
				'See js/workbench-start.js for the mount call, which accepts appId, modelHref and container.\n\n' : '') +
			(settings.blocks.includes('project-notebook') ?
				'Open the app with Play. The notebook reads and writes notes.md in this folder.\n' +
				'See js/notebook.js for examples of readFile and writeFile, including conflict handling.\n' +
				'The standalone notebook can open a text file and download an edited copy.\n' : '') +
			(dataset ? 'Edit js/dataset.js to replace the table name, column headers or records. Each row follows the column order.\n' : '') +
			(assets ? 'Game rules and drawing live in js/game.js. Edit the level and player in js/game-data.js.\n' : '') +
			(settings.blocks.some(id => ['level-editor', 'sprite-editor'].includes(id)) ?
				'Use Download game data to replace js/game-data.js with your edits.\n' : '') +
			(settings.blocks.includes('sprite-editor') ? 'Use Download PNG to export the player as a transparent sprite.\n' : '') +
			(playtestNotes !== undefined ? 'Edit PLAYTEST.md in Code Studio or download revised notes from the page.\n' : '') +
			(settings.libraries.includes('matter') ? 'Edit js/physics.js to change the bodies, gravity and simulation controls.\n' : '') +
			'Use the app preview or publish the exported folder on any static web host.\n' +
			'For the terminal demo, shell files live in memory for the lifetime of the page.\n\n## Libraries\n\n' +
			(libraries.map(lib => `- ${lib.name.replace(/^SUSI /, '')} ${lib.version} (${lib.license})${lib.url ? ` ${lib.url}` : ''}`)
				.join('\n') || 'No third-party libraries selected.') +
			'\n\nLicense texts are included for bundled libraries and fonts.\n');
		for (const path of [...files.keys()]) {
			const parts = path.split('/');
			for (let length = 1; length < parts.length; length += 1) files.set(parts.slice(0, length).join('/') + '/', '');
		}
		files.set('css/', '');
		files.set('js/', '');
		return { settings, entries: [...files].map(([path, value]) => ({ path, value })) };
	}

	async function create(vfs, options, reader) {
		const project = await build(options, reader);
		const path = await createVfsApp(vfs, project.settings.name, project.entries);
		return { ...project, path };
	}

	function makeTemplateHTML(settings, design, purpose, libraries, pagePackages, playtestNotes) {
		const has = id => settings.libraries.includes(id);
		const sections = [];
		const add = (id, title, body) => sections.push({ id, title, html: `<section id="${id}"><h2>${title}</h2>${body}</section>` });
		const profiles = {
			dashboard: { labels: ['Active users', 'Conversion', 'Response time'], values: ['12,480', '3.8%', '184 ms'],
				headers: ['Channel', 'Visitors', 'Trend'], rows: [['Direct', '4,820', '+18%'], ['Search', '3,640', '+12%'], ['Community', '2,410', '+24%'], ['Referrals', '1,610', '+9%']] },
			data: { labels: ['Records', 'Coverage', 'Sources'], values: ['1,204', '98.7%', '6'],
				headers: ['Series', 'Records', 'Quality'], rows: [['North region', '324', 'Verified'], ['South region', '286', 'Verified'], ['East region', '312', 'Review'], ['West region', '282', 'Verified']] },
			portfolio: { labels: ['Selected work', 'Collaborations', 'Years of practice'], values: ['12', '24', '8'],
				headers: ['Work', 'Discipline', 'Year'], rows: [['Signal', 'Identity & digital', '2026'], ['Tideline', 'Product design', '2026'], ['Common Ground', 'Editorial system', '2025']] },
			knowledge: { labels: ['Guides', 'Topics', 'Contributors'], values: ['24', '6', '12'],
				headers: ['Guide', 'Topic', 'Reading time'], rows: [['Getting started', 'Essentials', '4 min'], ['A good working rhythm', 'Process', '6 min'], ['Small, useful patterns', 'Reference', '8 min']] },
			notebook: { labels: ['Note file', 'Format', 'Storage'], values: ['notes.md', 'Markdown', 'App folder'],
				headers: ['File', 'Format', 'Location'], rows: [['notes.md', 'Markdown', 'App folder']] },
			chat: { labels: ['Conversations', 'Messages', 'Average reply time'], values: ['18', '124', '2.4 s'],
				headers: ['Conversation', 'Messages', 'Status'], rows: [['Getting started', '4', 'Open'], ['Brainstorming', '8', 'Finished']] },
			landing: { labels: ['Early readers', 'Useful resources', 'New ideas'], values: ['1,240', '18', '7'],
				headers: ['Feature', 'For', 'Status'], rows: [['A focused workspace', 'Everyday work', 'Available'], ['Simple sharing', 'Your collaborators', 'Available'], ['A personal touch', 'Your next idea', 'Coming next']] },
			playground: { labels: ['Experiments', 'Languages', 'Ideas to try'], values: ['8', '3', '16'],
				headers: ['Experiment', 'Language', 'Status'], rows: [['Hello, browser', 'JavaScript', 'Ready'], ['A new layout', 'CSS', 'In progress'], ['Notes as code', 'Markdown', 'Ready']] }
		};
		const gamePurpose = settings.purpose === 'game' || settings.purpose === 'game-design';
		const data = gamePurpose ? {
			labels: ['Playtest sessions', 'Routes tested', 'Open questions'], values: ['4', '7', '2'],
			headers: ['Mechanic', 'Input', 'Feedback'], rows: [['Move', 'Arrow key', 'One tile'], ['Collect', 'Reach a crystal', 'Counter advances'],
				['Finish', 'Reach the open gate', 'Level complete']]
		} : profiles[settings.purpose];
		const hasBlock = id => settings.blocks.includes(id);
		const chat = has('chat');
		const workbench = has('chat-workbench');
		const embeddedWorkbench = workbench && !chat;
		const chatPurpose = purpose.id === 'chat' && chat;
		if (chat) add('project-chat', 'Conversation', `
		<p id="chat-model-status" role="status"></p>
		<div id="chat-log" role="log" aria-label="Conversation messages" aria-live="off" tabindex="0"></div>
		<form id="chat-form">
			<label for="chat-message">Message</label>
			<textarea id="chat-message" rows="2" required></textarea>
			<div class="chat-actions">
				<button id="chat-send" type="submit" disabled>Send</button>
				<button id="chat-stop" type="button" hidden>Stop</button>
				<button id="chat-new" type="button" disabled>New chat</button>
			</div>
		</form>
		<details id="chat-auth" hidden><summary>API key for this chat</summary>
			<label for="chat-api-key">API key (optional)</label>
			<input id="chat-api-key" type="password" autocomplete="off" spellcheck="false" />
		</details>
		<p id="chat-status" role="status"></p>`);
		if (hasBlock('project-notebook')) add('project-notebook', 'App notebook',
			'<form id="notebook-form" class="sample-form"><label for="notebook-text">Note · <code id="notebook-name">notes.md</code></label>' +
			'<textarea id="notebook-text" rows="10" spellcheck="true"></textarea>' +
			'<button type="submit">Save note</button> <button id="notebook-reload" type="button">Reload note</button>' +
			'<label id="notebook-import" hidden>Open a text file<input type="file" accept=".md,.txt,text/plain,text/markdown"></label>' +
			'</form><p id="notebook-status" class="demo-status" role="status"></p>');
		const dataViews = pagePackages.includes(templateCatalog.dataAssets);
		const directions = [['up', '↑'], ['left', '←'], ['down', '↓'], ['right', '→']];
		const dataButton = '<button type="button" data-download-game>Download game data</button>';
		if (hasBlock('playfield')) add('playfield', 'Crystal trail',
			'<div class="game-layout"><div class="game-stage">' +
			'<div class="game-hud"><span>Crystals <strong id="game-crystals"></strong></span><span>Moves <strong id="game-moves">0</strong></span></div>' +
			'<canvas id="game-board" tabindex="0" aria-label="Crystal trail playing field" aria-describedby="game-instructions game-status"></canvas></div>' +
			'<div class="game-controls"><p id="game-instructions">Collect every crystal, then step through the gate. Use the arrow keys, WASD or the buttons below.</p>' +
			'<div class="game-tools"><div class="game-pad" role="group" aria-label="Move player">' + directions.map(([dir, key]) =>
				`<button type="button" data-move="${dir}" aria-label="Move ${dir}">${key}</button>`).join('') + '</div>' +
			'<button id="game-restart" type="button">Restart</button></div><p id="game-status" role="status"></p></div></div>');
		if (hasBlock('level-editor')) add('level-editor', 'Tile map editor',
			'<label for="level-brush">Tile brush</label><select id="level-brush">' +
			[['#','Wall'], ['.','Floor'], ['*','Crystal'], ['S','Player start'], ['E','Exit gate']].map(([id, name]) =>
				`<option value="${id}">${name}</option>`).join('') + '</select>' +
			'<p id="level-help">Paint with a pointer, or focus the map and use arrow keys and Space. Place a start or gate to move it.</p>' +
			'<canvas id="level-grid" tabindex="0" aria-label="Edit level tiles" aria-describedby="level-help level-cell"></canvas>' +
			'<div class="game-tools"><button id="level-undo" type="button" disabled>Undo stroke</button>' + dataButton +
			(hasBlock('playfield') ? '<a href="#game-board">Play this level ↑</a>' : '') + '</div><p id="level-cell" role="status"></p>');
		if (hasBlock('sprite-editor')) add('sprite-editor', 'Player sprite',
			'<fieldset id="sprite-palette"><legend>Pixel brush</legend>' +
			[['2','Mint'], ['3','Ivory'], ['4','Amber'], ['1','Ink'], ['.','Erase']].map(([id, name], i) =>
				`<label><input type="radio" name="pixel-color" value="${id}"${i === 0 ? ' checked' : ''}>${name}</label>`).join('') + '</fieldset>' +
			'<p id="sprite-help">Paint the 8 × 8 player sprite. On the grid, arrow keys move the cursor and Space paints a pixel.</p>' +
			'<canvas id="sprite-grid" tabindex="0" aria-label="Edit player pixels" aria-describedby="sprite-help sprite-cell"></canvas>' +
			'<div class="game-tools"><button id="sprite-undo" type="button" disabled>Undo stroke</button>' +
			'<button id="sprite-png" type="button">Download PNG</button>' + (hasBlock('level-editor') ? '' : dataButton) +
			'</div><p id="sprite-cell" role="status"></p>');
		if (hasBlock('playtest')) add('playtest', 'Playtest brief',
			'<label for="playtest-notes">Design notes (Markdown)</label>' +
			`<textarea id="playtest-notes" rows="12" maxlength="16000">\n${escapeHTML(playtestNotes)}</textarea>` +
			'<button id="download-playtest" type="button">Download PLAYTEST.md</button>');
		if (has('matter')) add('physics', 'Physics sandbox',
			'<p>Drop a ball onto the ramp and change gravity to compare its motion.</p>' +
			'<canvas id="physics-board" width="512" height="200" role="img" aria-label="Gravity and collision simulation"></canvas>' +
			'<label for="physics-gravity">Gravity</label><input id="physics-gravity" type="range" min="0" max="2" step="0.1" value="1">' +
			'<button id="physics-drop" type="button">Drop ball</button> <button id="physics-run" type="button">Run</button> ' +
			'<button id="physics-reset" type="button">Reset</button><p id="physics-status" role="status"></p>');
		if (dataViews) {
			const scroll = (name, table) => `<div class="data-scroll" role="region" aria-label="${name}" tabindex="0">${table}</div>`;
			const pager = id => `<div class="data-pager" id="${id}-pager" role="group" aria-label="Pages of ${id}">` +
				'<button type="button" data-page="-1">Previous</button><span aria-live="polite"></span>' +
				'<button type="button" data-page="1">Next</button></div>';
			const grid = hasBlock('data-grid') ? '<section id="data-grid"><div class="data-subheading"><h3>Records</h3>' +
				'<div class="data-controls"><label>Rows per page <select id="data-page-size"><option>10</option><option>25</option><option>50</option></select></label>' +
				'<details id="data-columns"><summary>Columns</summary><fieldset><legend>Visible columns</legend></fieldset></details></div></div>' +
				scroll('Records', '<table aria-label="Records"><thead><tr></tr></thead><tbody></tbody></table>') + pager('records') + '</section>' : '';
			const groups = hasBlock('grouped-table') ? '<section id="grouped-table"><div class="data-subheading"><h3>Grouped summary</h3>' +
				'<label>Group by <select id="data-group-by"></select></label></div>' +
				scroll('Grouped summary', '<table aria-label="Grouped summary"><thead><tr><th scope="col">Value</th><th scope="col">Rows</th>' +
					'<th scope="col">Share</th></tr></thead><tbody></tbody></table>') + pager('groups') + '</section>' : '';
			const profile = hasBlock('column-profile') ? '<section id="column-profile"><h3>Column profile</h3>' +
				scroll('Column profile', '<table aria-label="Column profile"><thead><tr>' +
					['Column', 'Type', 'Distinct', 'Missing', 'Range'].map(label => `<th scope="col">${label}</th>`).join('') +
					'</tr></thead><tbody></tbody></table>') + '</section>' : '';
			sections.push({ id: 'data-workspace', title: 'Dataset',
				html: '<section id="data-workspace" aria-labelledby="data-name"><header class="data-source-line"><h2 id="data-name">Dataset</h2>' +
				'<span id="data-count" role="status"></span></header><div class="data-search">' +
				'<label>Search records<input type="search" id="data-search" autocomplete="off" /></label>' +
				'<label>Search in<select id="data-search-column"><option value="">All columns</option></select></label></div>' +
				grid + '<div class="data-analysis">' + groups + profile + '</div></section>' });
		}
		if (settings.blocks.includes('metrics')) {
			if (dataViews) add('overview', 'Dataset at a glance', '<div class="metrics">' +
				[['Complete records', 'complete'], ['Missing cells', 'missing'], ['Populated cells', 'coverage']].map(([label, key]) =>
					`<article class="metric"><small>${label}</small><strong id="data-metric-${key}"></strong></article>`).join('') + '</div>');
			else add('overview', 'At a glance', '<div class="metrics">' + data.labels.map((label, index) =>
				`<article class="metric"><small>${label}</small><strong>${data.values[index]}</strong><p>Sample data · this month</p></article>`).join('') + '</div>');
		}
		if (has('plotly') || has('uplot')) {
			const chartTitle = dataViews ? 'Column coverage' : 'A signal over time';
			const chartInfo = dataViews ? 'Present and missing values in each column of the complete dataset.' :
				'Two perspectives on the same week. Explore the chart to compare them.';
			const chartLabel = dataViews ? chartTitle : 'Sample weekly activity: this week and last week';
			add('chart-section', chartTitle, `<p>${chartInfo}</p><div id="sample-chart" class="chart" role="img" aria-label="${chartLabel}"></div>`);
		}
		if (settings.blocks.includes('cards')) {
			const titles = settings.purpose === 'portfolio' ? ['Signal', 'Tideline', 'Common Ground'] :
				settings.purpose === 'knowledge' ? ['Start with the essentials', 'Find a useful pattern', 'Go a little deeper'] :
				['A thoughtful beginning', 'Room to explore', 'Ready to make your own'];
			add('selected-work', settings.purpose === 'portfolio' ? 'Selected work' : 'A few good starting points',
				'<div class="features">' + titles.map((title, index) => `<article><div class="feature-art" aria-hidden="true"></div>` +
					`<small>0${index + 1} / ${escapeHTML(purpose.name)}</small><h3>${title}</h3><p>A small idea with room to grow. Add your own story, details and point of view.</p></article>`).join('') + '</div>');
		}
		if (settings.blocks.includes('table')) {
			add('table-section', settings.purpose === 'portfolio' ? 'Work index' : 'The details',
				'<label for="table-filter">Filter entries</label><input id="table-filter" type="search" placeholder="Type to filter…" />' +
				'<div class="table-scroll"><table><thead><tr>' + data.headers.map(header => `<th scope="col">${header}</th>`).join('') +
				'</tr></thead><tbody>' + data.rows.map(row => '<tr>' + row.map(cell => `<td>${cell}</td>`).join('') + '</tr>').join('') +
				'</tbody></table></div><p id="table-status" class="demo-status" role="status"></p>');
		}
		const example = 'function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nconsole.log(greet("browser"));\n';
		if (has('ace')) add('editor-section', 'An idea in code', '<p>A real editor, ready for your next experiment.</p>' +
			'<div id="code-editor" aria-label="JavaScript editor"></div>');
		if (has('acorn')) add('syntax-section', 'Look inside the code', (has('ace') ? '<p>Parse the code in the editor above.</p>' :
			`<label for="syntax-source">JavaScript source</label><textarea id="syntax-source" spellcheck="false">${escapeHTML(example)}</textarea>`) +
			'<button id="parse-code" type="button">Parse JavaScript</button><p id="syntax-status" class="demo-status" role="status"></p>');
		if (has('xterm')) add('terminal-section', 'A small command line', '<p>Try <code>help</code> or <code>echo hello</code>.</p>' +
			'<div id="terminal" aria-label="Terminal playground"></div><p class="project-note">' +
			(has('just-bash') ? 'Shell files stay in memory for this page session.' : 'This terminal demo supports help, date and echo.') + '</p>');
		if (has('just-bash') && !has('xterm')) add('shell-section', 'Try a command',
			'<form id="shell-form"><label for="shell-command">Command</label><input id="shell-command" value="cat /welcome.txt" required />' +
			'<button type="submit">Run command</button></form><pre id="shell-output" role="status">Shell files stay in memory for this page session.</pre>');
		if (has('markdown')) add('notes-section', 'Notes worth keeping',
			'<label for="markdown-source">Markdown</label><textarea id="markdown-source" spellcheck="false"># A useful starting point\n\nSmall steps make room for good ideas.\n\n- Make something clear\n- Try one new thing\n- Share what you learn</textarea>' +
			'<article id="markdown-preview" aria-label="Rendered notes"></article>');
		if (has('highlight')) add('example-section', 'A readable example', `<pre><code class="language-javascript">${escapeHTML(example)}</code></pre>`);
		if (has('three')) add('three-section', '3D scene',
			'<canvas id="three-scene" aria-label="A 3D shape above a grid"></canvas>' +
			'<label for="three-rotation">Rotate the shape</label>' +
			'<input id="three-rotation" type="range" min="0" max="360" value="35" />' +
			'<p id="three-status" role="status"></p>');
		if (has('zip')) add('export-section', 'Take the data with you',
			(dataViews ? '<p>Download the matching records as a CSV, including all columns.</p><button id="download-sample" type="button">Download filtered ZIP</button>' :
				'<p>Package a sample CSV and a short note into a ZIP archive.</p><button id="download-sample" type="button">Download sample ZIP</button>') +
			'<p id="archive-status" class="demo-status" role="status"></p>');
		if (settings.blocks.includes('form')) add('contact-section', 'Start a conversation',
			'<p>Leave a note about what you would like to make next.</p><form id="contact-form" class="sample-form">' +
			'<label for="contact-name">Your name</label><input id="contact-name" autocomplete="name" required />' +
			'<label for="contact-message">Your note</label><textarea id="contact-message" required></textarea>' +
			'<button type="submit">Leave a note</button><p id="contact-status" class="demo-status" role="status"></p></form>');
		if (embeddedWorkbench) {
			add('workbench-panel', 'Chat Workbench', '<p id="workbench-status" role="status"></p>');
			if (purpose.id === 'chat') sections.unshift(sections.pop());
		}
		if (!sections.length) add('start', 'A little room to begin', '<p>This is your starting canvas. Add a section, try a new layout, or tell a new story.</p>');
		const sectionLink = section => `<li><a href="#${section.id}">${section.title}</a></li>`;
		const links = sections.map(sectionLink).join('');
		const firstTarget = sections[0].id === 'playfield' ? 'game-board' : sections[0].id;
		const firstAction = { 'game-board': 'Play the game', 'data-workspace': 'Explore the data',
			'project-notebook': 'Open notebook', 'workbench-panel': 'Open Chat Workbench' }[firstTarget] || 'Take a look';
		const styles = ['css/base.css', design.css, 'css/app.css', ...pagePackages.flatMap(item => item.styles), ...libraries.flatMap(lib => lib.styles),
			...(embeddedWorkbench ? ['css/chat-workbench.css', 'css/speech-dictation.css'] : [])];
		const scripts = [...libraries.flatMap(lib => lib.scripts), ...pagePackages.flatMap(item => item.scripts),
			...(has('matter') ? ['js/physics.js'] : []), 'js/app.js',
			...(embeddedWorkbench ? ['js/susi-chat.js', 'js/workbench-start.js'] : [])];
		return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n' +
			'<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
			`<title>${escapeHTML(settings.name)}</title>\n` + styles.map(path => `<link rel="stylesheet" href="${path}" />`).join('\n') +
			'\n</head>\n' + `<body data-layout="${settings.layout}" data-purpose="${settings.purpose}"${settings.appId ? ` data-app-id="${settings.appId}"` : ''}>\n<nav class="project-nav" aria-label="Sections"><strong>${escapeHTML(settings.name)}</strong>` +
			`<ul>${chatPurpose ? '' : sections.filter(section => section.id !== 'workbench-panel').slice(0, 3).map(sectionLink).join('')}${chat ? '<li><a href="config.html">Configuration</a></li>' : ''}` +
			(workbench ? `<li><a href="${embeddedWorkbench ? '#workbench-panel' : 'agent-chat.html'}">Chat Workbench</a></li>` : '') + '</ul></nav>\n' +
			(chatPurpose ? `<header class="project-header"><h1>${escapeHTML(settings.name)}</h1></header>\n` :
			`<header class="project-header"><small class="eyebrow">${escapeHTML(purpose.name)} / ${escapeHTML(design.name)}</small>` +
			`<h1>${escapeHTML(settings.name)}</h1><p>${escapeHTML(purpose.headline)}</p>` +
			(gamePurpose || (dataViews && settings.purpose === 'data') ? '' : `<p>${escapeHTML(purpose.summary)}</p>`) +
			`<a class="button" href="#${firstTarget}">${firstAction} ↓</a></header>\n`) +
			'<div id="layout"><main>' + sections.map(section => section.html).join('\n') + '</main>' +
			`<aside><h2>On this page</h2><ul>${links}</ul><p class="project-note">A ${escapeHTML(purpose.name.toLowerCase())} in the ${escapeHTML(design.name)} design.</p></aside></div>\n` +
			'<footer>' + (chatPurpose ? '' : '<p>Sample content. A starting point for something of your own.</p>') +
			(libraries.length ? '<ul class="library-list" aria-label="Included libraries">' + libraries.map(lib => `<li>${escapeHTML(lib.name)} ${escapeHTML(lib.version)}</li>`).join('') + '</ul>' : '') +
			'<p id="starter-status" role="status"></p></footer>\n' +
			scripts.map(path => `<script src="${path}" defer${['js/vfs.js', 'js/susi-chat.js'].includes(path) ? ' data-vfs-standalone' : ''}></script>`).join('\n') +
			'\n</body>\n</html>\n';
	}

	function makeTemplateWorkbench({ name, appId }, design, showAppLink) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content" />
	<title>Chat · ${escapeHTML(name)}</title>
	<link rel="stylesheet" href="css/base.css" />
	<link rel="stylesheet" href="${design.css}" />
	<link rel="stylesheet" href="css/chat-workbench.css" />
	<link rel="stylesheet" href="css/speech-dictation.css" />
	<script defer src="js/susi-chat.js" data-vfs-standalone></script>
	<script defer src="js/workbench-start.js"></script>
</head>
<body id="chat-page" data-app-id="${appId}">
	${showAppLink ? '<nav class="workbench-nav" aria-label="App"><a href="index.html">App home</a></nav>' : ''}
	<p id="workbench-status" role="status"></p>
</body>
</html>
`;
	}

	function makeTemplateChatConfig({ name, appId }, design, workbenchPage) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Configuration · ${escapeHTML(name)}</title>
	<link rel="stylesheet" href="css/base.css" />
	<link rel="stylesheet" href="${design.css}" />
	<link rel="stylesheet" href="css/app.css" />
	<link rel="stylesheet" href="css/chat.css" />
	${workbenchPage ? '<script defer src="js/susi-chat.js" data-vfs-standalone></script>' :
			'<script defer src="js/vfs.js" data-vfs-standalone></script>\n\t<script defer src="js/llm-client.js"></script>'}
	<script defer src="js/chat.js"></script>
</head>
<body data-purpose="chat" data-app-id="${appId}"${workbenchPage ? ' data-chat-workspace' : ''}>
	<nav class="project-nav" aria-label="App"><strong>${escapeHTML(name)}</strong><a href="${workbenchPage || 'index.html'}">Back to chat</a></nav>
	<header class="project-header"><h1>Configuration</h1></header>
	<div id="layout">
		<main>
			<section id="chat-configuration" aria-labelledby="chat-config-title">
				<h2 id="chat-config-title">Model settings</h2>
				<p>Use an OpenAI-compatible endpoint such as Ollama.</p>
				<form id="chat-config-form">
					<fieldset disabled>
						<label for="chat-host">API host</label>
						<input id="chat-host" type="url" spellcheck="false" required />
						<label for="chat-api-key">API key (optional)</label>
						<input id="chat-api-key" type="password" autocomplete="off" spellcheck="false" aria-describedby="chat-key-help" />
						<small id="chat-key-help">The key is used for this host in the current browser tab.</small>
						<label for="chat-model">Model ID</label>
						<input id="chat-model" type="text" spellcheck="false" required />
						<label for="chat-prompt">System prompt</label>
						<textarea id="chat-prompt" rows="4"></textarea>
						<label for="chat-timeout">Request idle timeout (seconds)</label>
						<input id="chat-timeout" type="number" min="10" max="600" step="1" required />
						<label id="chat-thinking-label"><input id="chat-thinking" type="checkbox" /> Enable model thinking</label>
						<button type="submit">Save settings</button>
					</fieldset>
				</form>
				<div>
					<h3>Available models</h3>
					<label for="chat-models">Choose a model to fill in its ID</label>
					<select id="chat-models" disabled><option value="">Fetch available models first</option></select>
					<button id="chat-fetch-models" type="button" disabled>Fetch models</button>
				</div>
				<p id="chat-config-status" role="status">Loading settings…</p>
			</section>
		</main>
	</div>
</body>
</html>
`;
	}

	// Serialized into projects that select Matter.js. The simulation runs only while playing.
	function startTemplatePhysics() {
		const { Bodies, Composite, Engine, Render, Runner } = Matter;
		const canvas = document.getElementById('physics-board');
		const gravity = document.getElementById('physics-gravity');
		const toggle = document.getElementById('physics-run');
		const status = document.getElementById('physics-status');
		const engine = Engine.create({ enableSleeping: true });
		const runner = Runner.create();
		const { width, height } = canvas;
		const view = Render.create({ canvas, engine, options: { width, height, wireframes: false, background: '#192b38' } });
		const wall = { isStatic: true, render: { fillStyle: '#66818a' } };
		Composite.add(engine.world, [
			Bodies.rectangle(width / 2, height - 5, width, 10, wall),
			Bodies.rectangle(3, height / 2, 6, height, wall),
			Bodies.rectangle(width - 3, height / 2, 6, height, wall),
			Bodies.rectangle(132, 94, 204, 10, { ...wall, angle: .22, render: { fillStyle: '#70dfc3' } })
		]);
		const balls = [];
		let running = false;
		function drawStatus() {
			toggle.textContent = running ? 'Pause' : 'Run';
			status.textContent = (running ? 'Running' : 'Paused') + ' · ' + balls.length +
				(balls.length === 1 ? ' ball' : ' balls') + ' · Gravity ' + engine.gravity.y.toFixed(1);
		}
		function play(active) {
			if (active !== running) {
				running = active;
				if (running) { Runner.run(runner, engine); Render.run(view); }
				else { Runner.stop(runner); Render.stop(view); }
			}
			drawStatus();
		}
		function addBall() {
			const x = 52 + (balls.length % 5) * 23;
			const ball = Bodies.circle(x, 24, 9, { restitution: .55, render: { fillStyle: '#ffac58' } });
			if (balls.length === 30) Composite.remove(engine.world, balls.shift());
			balls.push(ball);
			Composite.add(engine.world, ball);
		}
		function reset() {
			play(false);
			for (const ball of balls) Composite.remove(engine.world, ball);
			balls.length = 0;
			Engine.clear(engine);
			gravity.value = '1';
			engine.gravity.y = 1;
			addBall();
			Render.world(view);
			drawStatus();
		}
		toggle.addEventListener('click', () => play(!running));
		document.getElementById('physics-drop').addEventListener('click', () => { addBall(); play(true); });
		document.getElementById('physics-reset').addEventListener('click', reset);
		gravity.addEventListener('input', () => { engine.gravity.y = Number(gravity.value); drawStatus(); });
		document.addEventListener('visibilitychange', () => { if (document.hidden) play(false); });
		window.addEventListener('pagehide', () => play(false));
		reset();
	}

	// Serialized into each project; it depends only on that project's own files and browser APIs.
	async function startTemplateApp(settings) {
		const has = id => settings.libraries.includes(id);
		if (has('three')) {
			const canvas = document.getElementById('three-scene');
			const rotation = document.getElementById('three-rotation');
			const status = document.getElementById('three-status');
			const context = canvas.getContext('webgl2', { antialias: true });
			if (!context) {
				rotation.disabled = true;
				status.textContent = 'The 3D preview requires WebGL 2.';
			} else {
				const renderer = new THREE.WebGLRenderer({ canvas, context });
				renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
				const scene = new THREE.Scene();
				scene.background = new THREE.Color(0x0b1020);
				const grid = new THREE.GridHelper(12, 12, 0x7083b0, 0x29344d);
				scene.add(grid);
				const geometry = new THREE.IcosahedronGeometry(1, 0);
				const material = new THREE.MeshNormalMaterial({ flatShading: true });
				const shape = new THREE.Mesh(geometry, material);
				shape.position.y = 1.15;
				scene.add(shape);
				const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 50);
				camera.position.set(3, 2.7, 5);
				camera.lookAt(0, 0.8, 0);
				const render = () => {
					shape.rotation.y = THREE.MathUtils.degToRad(rotation.valueAsNumber);
					renderer.render(scene, camera);
				};
				const resize = () => {
					if (!canvas.clientWidth || !canvas.clientHeight) return;
					camera.aspect = canvas.clientWidth / canvas.clientHeight;
					camera.updateProjectionMatrix();
					renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
					render();
				};
				const observer = new ResizeObserver(resize);
				observer.observe(canvas);
				rotation.addEventListener('input', render);
				window.addEventListener('pagehide', event => {
					if (event.persisted) return;
					observer.disconnect();
					geometry.dispose();
					material.dispose();
					grid.dispose();
					renderer.dispose();
				});
				resize();
			}
		}
		document.getElementById('download-playtest')?.addEventListener('click', () => {
			const notes = document.getElementById('playtest-notes').value;
			const url = URL.createObjectURL(new Blob([notes], { type: 'text/markdown;charset=utf-8' }));
			const link = document.createElement('a');
			link.href = url; link.download = 'PLAYTEST.md'; link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		});
		const example = 'function greet(name) {\n  return `Hello, ${name}!`;\n}\n\nconsole.log(greet("browser"));\n';
		const filter = document.getElementById('table-filter');
		if (filter) {
			const rows = [...document.querySelectorAll('#table-section tbody tr')];
			filter.addEventListener('input', () => {
				const query = filter.value.trim().toLocaleLowerCase();
				for (const row of rows) row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
				document.getElementById('table-status').textContent = `${rows.filter(row => !row.hidden).length} of ${rows.length} entries`;
			});
		}
		let editor;
		if (has('ace')) {
			// Blob script URLs in the preview cannot provide Ace's automatically detected mode directory.
			ace.config.set('basePath', settings.acePath);
			ace.config.set('modePath', settings.acePath);
			editor = ace.edit(document.getElementById('code-editor'));
			editor.session.setUseWorker(false);
			editor.session.setMode('ace/mode/javascript');
			editor.setValue(example, -1);
			editor.setOptions({ fontSize: 14, showPrintMargin: false });
			editor.textInput.getElement().setAttribute('aria-label', 'JavaScript editor');
			new ResizeObserver(() => editor.resize()).observe(document.getElementById('code-editor'));
		}
		if (has('acorn')) {
			const parse = () => {
				const output = document.getElementById('syntax-status');
				try {
					const ast = acorn.parse(editor ? editor.getValue() : document.getElementById('syntax-source').value,
						{ ecmaVersion: 'latest', sourceType: 'script' });
					output.textContent = `${ast.type} · ${ast.body.length} top-level statements · valid JavaScript`;
				} catch (error) { output.textContent = error.message; }
			};
			document.getElementById('parse-code').addEventListener('click', parse);
			parse();
		}
		if (has('markdown')) {
			const source = document.getElementById('markdown-source');
			const render = markdownit({ html: false }).disable('image');
			const update = () => { document.getElementById('markdown-preview').innerHTML = render.render(source.value); };
			source.addEventListener('input', update);
			update();
		}
		if (has('highlight')) {
			for (const code of document.querySelectorAll('#example-section code')) hljs.highlightElement(code);
		}
		let shell;
		if (has('just-bash')) {
			shell = new JustBash.Bash({ files: { '/welcome.txt': 'Welcome to your browser workspace.\nTry: ls, cat /welcome.txt, or echo hello\n' }, cwd: '/' });
		}
		if (has('xterm')) {
			const host = document.getElementById('terminal');
			const terminal = new Terminal({ cursorBlink: true, rows: 10, cols: 70, convertEol: true,
				theme: { background: '#11151d', foreground: '#e4edee', cursor: '#dafc3d' } });
			terminal.open(host);
			terminal.textarea.setAttribute('aria-label', 'Terminal command');
			const fit = new FitAddon.FitAddon();
			const readline = new XtermReadline.Readline();
			terminal.loadAddon(fit);
			terminal.loadAddon(readline);
			new ResizeObserver(() => fit.fit()).observe(host);
			fit.fit();
			terminal.writeln('Your browser playground. Type help to begin.');
			const read = async () => {
				while (true) {
					const command = await readline.read('$ ');
					if (!command.trim()) continue;
					if (command === 'help') terminal.writeln(shell ? 'Try ls, cat /welcome.txt, echo hello or pwd.' : 'Commands: help, date, echo <message>');
					else if (shell) {
						const result = await shell.exec(command);
						if (result.stdout || result.stderr) terminal.writeln((result.stdout + result.stderr).replace(/\n$/, ''));
					} else if (command === 'date') terminal.writeln(new Date().toLocaleString());
					else if (command.startsWith('echo ')) terminal.writeln(command.slice(5));
					else terminal.writeln('Try help for available commands.');
				}
			};
			read().catch(error => terminal.writeln(error.message));
		} else if (shell) {
			const form = document.getElementById('shell-form');
			form.addEventListener('submit', async event => {
				event.preventDefault();
				const button = form.querySelector('button');
				button.disabled = true;
				try {
					const result = await shell.exec(document.getElementById('shell-command').value);
					document.getElementById('shell-output').textContent = result.stdout + result.stderr || `(exit ${result.exitCode})`;
				} catch (error) { document.getElementById('shell-output').textContent = error.message; }
				finally { button.disabled = false; }
			});
		}
		const chart = document.getElementById('sample-chart');
		if (chart) {
			const coverage = typeof projectDataView !== 'undefined';
			const style = getComputedStyle(document.documentElement);
			const primary = style.getPropertyValue('--color-primary').trim();
			const signal = style.getPropertyValue('--color-signal').trim();
			const text = style.getPropertyValue('--color-text').trim();
			const line = style.getPropertyValue('--color-line').trim();
			const x = coverage ? projectDataset.columns.map((_, i) => i + 1) : [1, 2, 3, 4, 5, 6, 7];
			const current = coverage ? projectDataView.fullProfile.map(field => projectDataset.rows.length - field.empty) : [42, 58, 51, 74, 68, 92, 108];
			const previous = coverage ? projectDataView.fullProfile.map(field => field.empty) : [34, 42, 46, 56, 61, 65, 78];
			const series = coverage ? ['Present', 'Missing'] : ['This week', 'Last week'];
			const columnLabel = index => projectDataset.columns[index - 1] || 'Column ' + index;
			if (!x.length) chart.textContent = 'No columns to chart.';
			else if (has('plotly')) {
				await Plotly.newPlot(chart, [
					{ x, y: current, name: series[0], type: 'scatter', mode: 'lines+markers', line: { color: primary, width: 3 } },
					{ x, y: previous, name: series[1], type: 'scatter', mode: coverage ? 'lines+markers' : 'lines', line: { color: signal, dash: 'dot' } }
				], { paper_bgcolor: 'transparent', plot_bgcolor: 'transparent', font: { color: text },
					margin: { t: 25, r: 20, b: 45, l: 45 }, height: 310, legend: { orientation: 'h', y: 1.15 },
					xaxis: { title: { text: coverage ? 'Column' : 'Day' }, gridcolor: line, zeroline: false,
						...(coverage ? { tickmode: 'array', tickvals: x, ticktext: x.map(columnLabel), automargin: true } : {}) }, yaxis: { gridcolor: line, zeroline: false } },
				{ responsive: true, displaylogo: false, displayModeBar: false });
			} else if (has('uplot')) {
				const plot = new uPlot({ width: Math.max(220, chart.clientWidth), height: 300,
					scales: { x: { time: false } }, series: [{ ...(coverage ? { label: 'Column', value: (_, value) => value == null ? '' : columnLabel(value) } : {}) },
						{ label: series[0], stroke: primary, width: 3 }, { label: series[1], stroke: signal, width: 2 }],
					axes: [{ stroke: text, grid: { stroke: line }, ...(coverage ? { space: 100,
						values: (_, ticks) => ticks.map(value => Number.isInteger(value) && value > 0 && value <= x.length ? columnLabel(value) : '') } : {}) },
						{ stroke: text, grid: { stroke: line } }]
				}, [x, current, previous], chart);
				new ResizeObserver(() => {
					const width = Math.max(220, chart.clientWidth);
					if (plot.width !== width) plot.setSize({ width, height: 300 });
				}).observe(chart);
			}
		}
		if (has('zip')) {
			const button = document.getElementById('download-sample');
			button.addEventListener('click', async () => {
				button.disabled = true;
				const status = document.getElementById('archive-status');
				try {
					const writer = new zip.ZipWriter(new zip.BlobWriter('application/zip'), { useWebWorkers: false });
					const table = typeof projectDataView !== 'undefined';
					if (table) {
						const line = row => row.map(value => '"' + (value ?? '').replaceAll('"', '""') + '"').join(',');
						const csv = projectDataset.columns.length ? [line(projectDataset.columns), ...projectDataView.records.map(line)].join('\r\n') + '\r\n' : '';
						await writer.add('records.csv', new zip.TextReader(csv));
					} else await writer.add('sample.csv', new zip.TextReader('day,value\n1,42\n2,58\n3,51\n4,74\n5,68\n6,92\n7,108\n'));
					await writer.add('README.txt', new zip.TextReader((table ? 'Dataset from ' : 'A small dataset from ') + settings.name + '.\n'));
					const url = URL.createObjectURL(await writer.close());
					const link = document.createElement('a');
					link.href = url;
					link.download = table ? 'records.zip' : 'sample-data.zip';
					document.body.append(link);
					link.click();
					link.remove();
					setTimeout(() => URL.revokeObjectURL(url), 1000);
					status.textContent = 'Your archive is ready.';
				} catch (error) { status.textContent = error.message; }
				finally { button.disabled = false; }
			});
		}
		const contact = document.getElementById('contact-form');
		if (contact) contact.addEventListener('submit', event => {
			event.preventDefault();
			document.getElementById('contact-status').textContent = `Thanks, ${document.getElementById('contact-name').value}. This demo keeps your note on this page.`;
		});
		document.documentElement.dataset.templateReady = 'true';
	}

	return { normalize, gameData, projectPackages, build, create, packageFiles, hostedReader, localReader };
})();
