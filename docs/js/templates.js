"use strict";

(async () => {
	const form = document.getElementById('template-form');
	const name = document.getElementById('template-name');
	const purpose = document.getElementById('template-purpose');
	const layout = document.getElementById('template-layout');
	const status = document.getElementById('template-status');
	const create = document.getElementById('template-create');
	const previewStatus = document.getElementById('template-preview-status');
	const frame = document.getElementById('template-preview');
	const shell = document.getElementById('template-frame-shell');
	const phoneButton = document.getElementById('template-phone');
	pageSettings.rememberDisclosure(document.getElementById('template-files'), 'templates', 'filesOpen');
	const narrow = matchMedia('(max-width: 43rem)');
	const libraryOptions = document.getElementById('template-library-options');
	const independentLibraries = document.querySelector('#template-independent-libraries > div');
	const libraryGroups = [
		{ name: 'chart', title: 'Chart library', none: 'No chart library', choices: ['plotly', 'uplot'] },
		{ name: 'chat-library', title: 'Chat library', none: 'No chat library', choices: ['chat', 'chat-workbench'] }
	];
	const dataSource = document.getElementById('template-data-source');
	const dataSelect = document.getElementById('template-dataset');
	const dataFile = document.getElementById('template-data-file');
	const dataStatus = document.getElementById('template-data-status');
	let vfs;
	let preview;
	let previewTimer;
	let previewRequest = 0;
	let creating = false;
	let phoneOverride;
	let selectionChanged = false;
	let gameDraft, notesDraft, notebookText, editToken;
	let editRevision = 0;
	let dataset, localDataset, preferredDataset, parquetReady;
	let datasetKey = '', sourceRequest = 0, readingData = false, listingTables = false;
	const size = bytes => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

	for (const design of templateCatalog.designs) {
		const label = document.createElement('label');
		label.className = 'template-design';
		label.dataset.design = design.id;
		const input = document.createElement('input');
		input.type = 'radio'; input.name = 'design'; input.value = design.id;
		input.checked = design.id === 'webstation';
		const title = document.createElement('strong'); title.textContent = design.name;
		const summary = document.createElement('small'); summary.textContent = design.summary;
		label.append(input, title, summary);
		document.getElementById('template-designs').append(label);
	}
	for (const item of templateCatalog.purposes) purpose.add(new Option(item.name, item.id));
	for (const item of templateCatalog.layouts) layout.add(new Option(item.name, item.id));
	for (const block of templateCatalog.blocks) {
		const label = document.createElement('label');
		const input = document.createElement('input');
		input.type = 'checkbox'; input.name = 'block'; input.value = block.id;
		const text = document.createElement('span');
		text.textContent = block.name;
		if (block.summary) {
			const summary = document.createElement('small');
			summary.textContent = block.summary; text.append(summary);
		}
		label.append(input, text);
		const group = { games: 'game', data: 'data' }[block.category] || 'content';
		document.getElementById('template-' + group + '-blocks').append(label);
	}
	function libraryOption(library, type, group) {
		const label = document.createElement('label');
		const input = document.createElement('input');
		input.type = type; input.name = group; input.value = library.id;
		const text = document.createElement('span');
		const title = document.createElement('strong');
		const version = group === 'chat-library' ? '' : library.version;
		title.textContent = version ? `${library.name} ${version}` : library.name;
		text.append(title);
		if (library.summary) {
			const summary = document.createElement('small');
			summary.textContent = `${library.summary} · ${size(library.bytes)}`;
			text.append(summary);
		}
		label.append(input, text);
		return label;
	}
	const groupedIds = new Set(libraryGroups.flatMap(group => group.choices));
	for (const group of libraryGroups) {
		const fieldset = document.createElement('fieldset');
		const legend = document.createElement('legend');
		legend.textContent = group.title;
		fieldset.append(legend, libraryOption({ id: 'none', name: group.none }, 'radio', group.name));
		for (const id of group.choices) {
			const library = templateCatalog.libraries.find(item => item.id === id);
			fieldset.append(libraryOption(library, 'radio', group.name));
		}
		libraryOptions.insertBefore(fieldset, independentLibraries.parentElement);
	}
	for (const library of templateCatalog.libraries) {
		if (!groupedIds.has(library.id)) independentLibraries.append(libraryOption(library, 'checkbox', 'library'));
	}
	const selectedLibraries = () => [...libraryOptions.querySelectorAll('input:checked')]
		.map(input => input.value).filter(id => id !== 'none');
	const selectedBlocks = () => [...form.querySelectorAll('[name="block"]:checked')].map(input => input.value);
	const libraryPreferences = () => ({
		libraries: selectedLibraries().filter(id => id !== form.elements.chart.value), librarySelectionVersion: 2
	});

	function selectLibraries(ids) {
		for (const group of libraryGroups) {
			// A saved selection containing both chat variants keeps Workbench and its full set of features.
			form.elements[group.name].value = group.choices.findLast(id => ids.includes(id)) || 'none';
		}
		for (const input of independentLibraries.querySelectorAll('input')) input.checked = ids.includes(input.value);
	}

	function options(forPreview = false) {
		return {
			name: name.value.trim() || (forPreview ? 'Your next website' : ''),
			design: form.querySelector('[name="design"]:checked').value,
			purpose: purpose.value, layout: layout.value,
			gameData: gameDraft, playtestNotes: notesDraft, notebookText, dataset,
			blocks: selectedBlocks(),
			libraries: selectedLibraries()
		};
	}

	function showSelection() {
		const selected = options(true);
		const packages = templateEngine.projectPackages(selected);
		const showData = packages.includes(templateCatalog.dataAssets);
		if (showData && dataSource.hidden) listTables();
		dataSource.hidden = !showData;
		create.disabled = !vfs || creating || (showData && readingData);
		document.getElementById('template-game-help').hidden =
			!selected.blocks.some(id => ['level-editor', 'sprite-editor', 'playtest'].includes(id));
		document.getElementById('template-notebook-help').hidden = !selected.blocks.includes('project-notebook');
		document.getElementById('template-library-summary').textContent = `${selected.libraries.length} ${selected.libraries.length === 1 ? 'library' : 'libraries'} · ` +
			size(packages.reduce((bytes, item) => bytes + item.bytes, 0)) + ' of bundled assets';
		document.getElementById('template-layout-help').textContent = templateCatalog.layouts.find(item => item.id === layout.value).summary;
	}

	async function listTables() {
		if (!vfs || listingTables) return;
		listingTables = true;
		try {
			const paths = (await vfs.ls('/')).filter(tableFileFormat).sort().map(path => '/' + path);
			const current = dataSelect.value;
			// A selected file remains a usable snapshot even if another tab moves it.
			if (datasetKey.startsWith('/') && !paths.includes(datasetKey)) paths.push(datasetKey);
			const group = dataSelect.querySelector('optgroup');
			group.replaceChildren(...paths.map(path => new Option(path, path)));
			dataSelect.value = current;
			if (!dataSource.hidden && !datasetKey && !readingData && paths.includes(preferredDataset)) {
				dataSelect.value = preferredDataset;
				await selectDataset(undefined, false);
			}
		} catch (error) {
			dataStatus.textContent = 'Unable to list workspace tables. ' + (error.message || error);
		} finally { listingTables = false; }
	}
	dataSelect.addEventListener('focus', listTables);
	document.getElementById('template-choose-data').addEventListener('click', () => dataFile.click());

	async function selectDataset(file, remember = true) {
		const request = ++sourceRequest;
		const key = file ? 'local' : dataSelect.value;
		readingData = true;
		updateCreateStatus();
		dataStatus.removeAttribute('data-error');
		dataStatus.textContent = 'Reading table…';
		try {
			let next;
			if (key === 'local' && !file) next = localDataset;
			else if (key) {
				const name = file ? file.name : key.split('/').at(-1);
				const format = tableFileFormat(name);
				if (format === 'parquet' && !globalThis.Hyparquet) {
					if (!parquetReady) parquetReady = new Promise((resolve, reject) => {
						const library = templateCatalog.libraries.find(item => item.id === 'hyparquet');
						const script = document.createElement('script');
						script.src = library.files.find(file => file.path === library.scripts[0]).source.slice('docs/'.length);
						script.onload = resolve;
						script.onerror = () => { script.remove(); parquetReady = undefined; reject(new Error('Unable to load the Parquet reader.')); };
						document.head.append(script);
					});
					await parquetReady;
				}
				const bytes = file ? new Uint8Array(await file.arrayBuffer()) : (await vfs.fileSystem.readFile(key)).bytes;
				if (request !== sourceRequest) return;
				const sheet = await tableFormats.read(format, bytes);
				if (request !== sourceRequest) return;
				const columns = sheet.columns.map(column => column.name);
				next = { name, columns, rows: sheet.rows.map(row => columns.map((_, i) =>
					row[i] == null ? null : tableFormats.textValue(row[i]))) };
			}
			dataset = next;
			datasetKey = key;
			if (file) {
				localDataset = next;
				dataSelect.querySelector('option[value="local"]')?.remove();
				dataSelect.add(new Option(file.name, 'local'), dataSelect.querySelector('optgroup'));
			}
			dataSelect.value = key;
			if (remember) {
				preferredDataset = key.startsWith('/') ? key : null;
				pageSettings.save('templates', { dataset: preferredDataset });
			}
			const source = dataset || templateCatalog.dataAssets.defaults;
			dataStatus.textContent = source.name + ' · ' + source.rows.length.toLocaleString('en') +
				(source.rows.length === 1 ? ' record · ' : ' records · ') + source.columns.length + (source.columns.length === 1 ? ' column' : ' columns');
			if (!dataSource.hidden) refreshPreview();
		} catch (error) {
			if (request !== sourceRequest) return;
			dataSelect.value = datasetKey;
			dataStatus.textContent = (error.message || String(error)) + ' Current dataset: ' + (dataset || templateCatalog.dataAssets.defaults).name + '.';
			dataStatus.setAttribute('data-error', '');
		} finally {
			if (request === sourceRequest) {
				readingData = false;
				if (!dataSource.hidden) updateCreateStatus();
			}
		}
	}

	function recommend() {
		const selected = templateCatalog.purposes.find(item => item.id === purpose.value);
		layout.value = selected.layout;
		selectLibraries([...selected.libraries, selected.chart]);
		for (const input of form.querySelectorAll('[name="block"]')) input.checked = selected.blocks.includes(input.value);
		document.getElementById('template-purpose-help').textContent = selected.summary;
		showSelection();
	}

	function clearPreview() {
		editToken = undefined;
		preview?.dispose();
		preview = undefined;
		document.getElementById('template-file-list').textContent = '';
		document.querySelector('#template-files summary').textContent = 'App files';
	}

	// Installed only in the Templates preview. Standalone projects export their edits to local files.
	function shareDesignEdits(token) {
		const send = (key, value) => parent.postMessage({ templateEdit: token, key, value }, '*');
		document.addEventListener('game-data-change', () => send('gameData', gameData));
		document.getElementById('playtest-notes')?.addEventListener('input', event => send('notes', event.target.value));
	}

	window.addEventListener('message', event => {
		const edit = event.data;
		if (!editToken || event.source !== frame.contentWindow || edit?.templateEdit !== editToken) return;
		if (edit.key === 'gameData') {
			try { gameDraft = templateEngine.gameData(edit.value); } catch { return; }
		} else if (edit.key === 'notes' && typeof edit.value === 'string' && edit.value.length <= 16000) {
			notesDraft = edit.value;
		} else return;
		editRevision++;
	});

	async function refreshPreview() {
		clearTimeout(previewTimer);
		const request = ++previewRequest;
		previewStatus.removeAttribute('data-error');
		previewStatus.textContent = 'Preparing preview…';
		try {
			const revision = editRevision;
			const project = await templateEngine.build(options(true));
			if (request !== previewRequest) return;
			if (project.settings.libraries.some(id => id === 'chat' || id === 'chat-workbench')) {
				for (const entry of project.entries) {
					if (['index.html', 'config.html', 'agent-chat.html', 'agent-chat-config.html'].includes(entry.path)) {
						entry.value = entry.value.replace('<body ', '<body data-chat-demo ');
					}
				}
			}
			const editable = project.settings.blocks.some(id => ['level-editor', 'sprite-editor', 'playtest'].includes(id));
			const token = editable ? request : undefined;
			if (editable) {
				const app = project.entries.find(entry => entry.path === 'js/app.js');
				app.value += '\n(' + shareDesignEdits.toString() + ')(' + JSON.stringify(token) + ');\n';
			}
			const snapshot = await prepareVfsPreview(project.entries);
			if (request !== previewRequest) return;
			if (editRevision !== revision) return refreshPreview();
			preview?.dispose();
			editToken = token;
			// Before creation, the notebook edits the draft that will become the project's notes.md.
			let note;
			if (project.settings.blocks.includes('project-notebook')) {
				note = new File([project.entries.find(entry => entry.path === 'notes.md').value], 'notes.md', { lastModified: 0 });
			}
			const projectFiles = note && {
				readFile(path) {
					if (path !== note.name) throw new Error('Choose notes.md in this template draft.');
					return note;
				},
				async writeFile(path, value, previous, signal) {
					const next = await new Blob([value]).text();
					signal.throwIfAborted();
					if (path !== note.name) throw new Error('Choose notes.md in this template draft.');
					if (previous === null || (previous && previous.lastModified !== note.lastModified)) {
						throw new Error('The note changed. Reload it before saving.');
					}
					notebookText = next;
					note = new File([next], path, { lastModified: note.lastModified + 1 });
					editRevision++;
					return note;
				}
			};
			preview = createVfsPreview(frame, snapshot, {
				projectFiles,
				onNavigate: path => preview.open(path).catch(error => { if (error.name !== 'AbortError') previewStatus.textContent = error.message; }),
				onError: message => { previewStatus.textContent = message; previewStatus.setAttribute('data-error', ''); }
			});
			await preview.open();
			if (request !== previewRequest) return;
			const files = project.entries.filter(entry => !entry.path.endsWith('/')).map(entry => entry.path).sort();
			document.getElementById('template-file-list').textContent = files.join('\n');
			document.querySelector('#template-files summary').textContent = `App files (${files.length})`;
			previewStatus.textContent = `${templateCatalog.designs.find(item => item.id === project.settings.design).name} · ` +
				templateCatalog.purposes.find(item => item.id === project.settings.purpose).name + ' · Preview ready';
		} catch (error) {
			if (request !== previewRequest || error.name === 'AbortError') return;
			clearPreview();
			previewStatus.textContent = error.message || 'Unable to prepare this preview.';
			previewStatus.setAttribute('data-error', '');
		}
	}

	form.addEventListener('change', event => {
		if (event.target === dataSelect) { selectDataset(); return; }
		if (event.target === dataFile) {
			const file = dataFile.files[0]; dataFile.value = '';
			if (file) selectDataset(file);
			return;
		}
		if (event.target !== name) selectionChanged = true;
		if (event.target === purpose) recommend();
		else showSelection();
		const control = event.target;
		if (control === purpose) {
			pageSettings.save('templates', { purpose: purpose.value, layout: layout.value, chart: form.elements.chart.value,
				blocks: selectedBlocks(), ...libraryPreferences() });
		} else if (control.name === 'block') {
			pageSettings.save('templates', { blocks: selectedBlocks() });
		} else if (control.name === 'design' || control === layout || control.name === 'chart') {
			pageSettings.save('templates', { [control.name]: control.value });
		} else if (libraryOptions.contains(control)) {
			pageSettings.save('templates', libraryPreferences());
		}
		clearTimeout(previewTimer);
		previewTimer = setTimeout(refreshPreview, 350);
	});
	document.getElementById('template-refresh').addEventListener('click', refreshPreview);
	function sizePreview() {
		const phone = phoneOverride ?? narrow.matches;
		phoneButton.setAttribute('aria-pressed', String(phone));
		const style = getComputedStyle(shell);
		const left = parseFloat(style.paddingLeft);
		const top = parseFloat(style.paddingTop);
		const available = shell.clientWidth - left - parseFloat(style.paddingRight);
		if (available <= 0) return;
		const width = phone ? 375 : 1100;
		const scale = Math.min(1, available / width);
		frame.style.width = `${width}px`;
		frame.style.height = `${(shell.clientHeight - top - parseFloat(style.paddingBottom)) / scale}px`;
		frame.style.transform = `scale(${scale})`;
		frame.style.left = `${left + (available - width * scale) / 2}px`;
		frame.style.top = `${top}px`;
	}
	new ResizeObserver(sizePreview).observe(shell);
	narrow.addEventListener('change', sizePreview);
	phoneButton.addEventListener('click', () => {
		phoneOverride = phoneButton.getAttribute('aria-pressed') !== 'true';
		pageSettings.save('templates', { phoneView: phoneOverride });
		sizePreview();
	});
	form.addEventListener('submit', async event => {
		event.preventDefault();
		if (creating || !vfs || (readingData && !dataSource.hidden)) return;
		const selected = options();
		creating = true;
		for (const control of form.querySelectorAll('input, select, button')) control.disabled = true;
		status.textContent = 'Creating the app in the virtual file system…';
		status.removeAttribute('data-error');
		try {
			const project = await templateEngine.create(vfs, selected);
			await pageSettings.save('chat', { project: project.path });
			document.getElementById('template-created-path').textContent = project.path;
			const play = createProjectPreviewLink(project.path);
			play.textContent = 'Preview app ↗';
			play.removeAttribute('aria-label');
			const studio = document.createElement('a');
			studio.href = 'code-studio.html?' + new URLSearchParams({ file: project.path + 'index.html' });
			studio.textContent = 'Open Code Studio';
			const chat = document.createElement('a'); chat.href = 'chat.html?' + new URLSearchParams({ project: project.path });
			chat.id = 'template-continue-chat';
			chat.textContent = 'Continue in Chat';
			document.getElementById('template-created-links').replaceChildren(chat, play, studio);
			const created = document.getElementById('template-created');
			created.hidden = false;
			const fileCount = project.entries.filter(entry => !entry.path.endsWith('/')).length;
			status.textContent = `Created ${project.path} in the virtual file system with ${fileCount} files.`;
			created.scrollIntoView({ block: 'nearest' });
			chat.focus({ preventScroll: true });
		} catch (error) {
			status.textContent = error.message || 'Unable to create the app.';
			status.setAttribute('data-error', '');
		} finally {
			creating = false;
			for (const control of form.querySelectorAll('input, select, button')) control.disabled = false;
		}
	});
	window.addEventListener('pagehide', () => { clearTimeout(previewTimer); preview?.dispose(); });
	function updateCreateStatus() {
		create.disabled = !vfs || creating || (readingData && !dataSource.hidden);
		if (vfs) {
			status.textContent = readingData && !dataSource.hidden ? 'Reading table…' : 'Ready to create an app.';
			status.removeAttribute('data-error');
		}
	}
	recommend();
	// Preview uses an in-memory project and can start while the workspace is opening.
	previewTimer = setTimeout(refreshPreview, 150);
	try {
		const settings = await pageSettings.read('templates');
		const selected = (select, value) => [...select.options].some(option => option.value === value);
		if (!selectionChanged && Object.keys(settings).length) {
			if (selected(purpose, settings.purpose)) purpose.value = settings.purpose;
			recommend();
			for (const radio of form.querySelectorAll('[name="design"]')) {
				if (radio.value === settings.design) radio.checked = true;
			}
			if (selected(layout, settings.layout)) layout.value = settings.layout;
			// Older Chat selections included the Chat files implicitly, outside the saved library list.
			const libraryIds = purpose.value === 'chat' && settings.librarySelectionVersion !== 2 && Array.isArray(settings.libraries)
				? [...settings.libraries, 'chat'] : settings.libraries;
			const chart = form.elements.chart;
			if (Array.isArray(libraryIds)) selectLibraries([...libraryIds, chart.value]);
			if ([...chart].some(radio => radio.value === settings.chart)) chart.value = settings.chart;
			if (Array.isArray(settings.blocks)) {
				for (const input of form.querySelectorAll('[name="block"]')) input.checked = settings.blocks.includes(input.value);
			}
			showSelection();
			refreshPreview();
		}
		if (phoneOverride === undefined && typeof settings.phoneView === 'boolean') {
			phoneOverride = settings.phoneView; sizePreview();
		}
		if (preferredDataset === undefined && !readingData && typeof settings.dataset === 'string' &&
			settings.dataset.startsWith('/')) preferredDataset = settings.dataset;
		vfs = await window.vfsReady;
		if (!dataSource.hidden) await listTables();
		updateCreateStatus();
	} catch (error) {
		status.textContent = error.message || 'Unable to open the workspace.';
		status.setAttribute('data-error', '');
	}
})();
