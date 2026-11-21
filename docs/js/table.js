"use strict";

(() => {
	const $ = id => document.getElementById(id);
	const pageTitle = document.title;
	const grid = $("data-grid"), bar = $("cell-value"), type = $("cell-type");
	const scroller = $("grid-scroll"), dropLine = $("table-drop-line");
	const pageSize = 100;
	const formats = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", jsonl: "application/x-ndjson", parquet: "application/octet-stream" };
	const past = [], future = [];
	let sheet, source, row = 0, col = 0, page = 0, revision = 0, saved = 0, sequence = 0;
	let busy = false, draft = false, inline = null, columnAction, listing = 0;
	let drag;
	let lastView, clipboard, pendingPaste, fillDrag, dataRevision = 0, savedData = 0;
	let styles = new Map();
	const fillHandle = document.createElement("button");
	fillHandle.type = "button"; fillHandle.id = "fill-handle"; fillHandle.tabIndex = -1;
	fillHandle.setAttribute("aria-label", "Drag to fill adjacent cells"); fillHandle.title = "Drag to fill adjacent cells";
	let answers, savedAnswerVersion = 0, modelViewDirty = false;
	const changed = () => draft || revision !== saved || answers.version !== savedAnswerVersion;
	const basename = name => name.split("/").pop();
	const letters = index => {
		let name = "";
		for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
		return name;
	};

	const Formula = tableCalc.Formula;
	const extension = name => /\.xlsx$/i.test(name) ? "xlsx" : tableFormats.extension(name);
	let tabs = [], calculate, resolvedRows, projectionSheet, projectionRevision, hasFormulas;
	const inputText = v => v instanceof Formula ? v.expression : tableFormats.textValue(v);
	function invalidate() {
		calculate = tableCalc.calculator(tabs,prompt => answers.entries.get(prompt));
		projectionSheet = null;
	}
	function showModelProgress(state) {
		renderModelProgress($("table-model-loading"),state);
	}
	function modelStatus() {
		let pending = 0, paused = 0, problem = "";
		let progress;
		for (const prompt of answers.needed) {
			const entry = answers.entries.get(prompt);
			if (entry.state === "running") progress = entry.progress;
			if (entry.state === "failed") problem ||= entry.text;
			if (entry.state === "paused" || entry.state === "failed") paused++;
			else if (entry.state !== "ready") pending++;
		}
		const label = $("model-state");
		label.hidden = !pending && !paused;
		label.textContent = [pending && (pending + " LLM pending"), problem || (paused && (paused + " unanswered"))].filter(Boolean).join(" · ");
		label.title = label.textContent;
		$("run-model").hidden = !paused;
		showModelProgress(pending ? progress || {message:"Queued for model…"} : undefined);
	}
	function modelResult() {
		// A completed answer can supply the argument of another LLM call.
		answers.refresh(tabs,true);
		invalidate(); viewRevision = searchRevision = undefined;
		modelStatus();
		modelViewDirty = true;
		chartPanel.render(sheet,calculate);
		if (!draft && !inline && !drag && !fillDrag && !rangePointer && !resize && !busy && document.activeElement !== bar) {
			render(grid.contains(document.activeElement));
		} else {
			// Preserve the live editor, caret, selection handle and any open dialog.
			for (const td of grid.querySelectorAll("td[data-r][data-c]")) {
				const r = Number(td.dataset.r), c = Number(td.dataset.c);
				if (!(sheet.rows[r]?.[c] instanceof Formula) || td.contains(inline)) continue;
				const value = calculate(sheet,r,c);
				const text = tableSheet.formatted(value,styleAt(sheet.rows[r],sheet.columns[c]),displayValue(value));
				if (td.firstChild?.nodeType === Node.TEXT_NODE) td.firstChild.data = text;
				else td.prepend(document.createTextNode(text));
			}
			title();
		}
	}
	$("run-model").onclick = () => {
		if (!commit()) return;
		answers.retry(); invalidate(); viewRevision = searchRevision = undefined; render(); modelStatus();
	};
	window.addEventListener("pagehide", event => { if (!event.persisted) answers?.controller.abort(); });
	function values() {
		if (sheet !== projectionSheet || revision !== projectionRevision) {
			hasFormulas = false;
			resolvedRows = sheet.rows.map((cells,r) => {
				if (!cells.some(v => v instanceof Formula)) return cells;
				hasFormulas = true;
				return cells.map((v,c) => v instanceof Formula ? calculate(sheet,r,c) : v);
			});
			projectionSheet = sheet; projectionRevision = revision;
		}
		return resolvedRows;
	}
	function needsWorkbook() {
		if (sheet.charts?.length || tabs.length > 1 || sheet.format === "xlsx" || sheet.name !== "Sheet1") return true;
		values(); return hasFormulas;
	}
	function activate(next) {
		if (sheet === next) return;
		sheet.view = {row,col,anchor,sortLevels,filters:[...filters],query:$("find-value").value};
		const view = next.view || {};
		sheet = next; styles = sheet.styles; row = view.row || 0; col = view.col || 0;
		anchor = view.anchor; sortLevels = view.sortLevels || []; filters.clear();
		for (const [column,filter] of view.filters || []) filters.set(column,filter);
		$("find-value").value = view.query || "";
		viewRevision = searchRevision = undefined;
	}
	function drawTabs() {
		const nav = $("worksheet-tabs");
		if (nav.children.length !== tabs.length || tabs.some((tab,i) => nav.children[i].textContent !== tab.name)) {
			nav.replaceChildren(...tabs.map(tab => {
				const button = document.createElement("button"); button.textContent = tab.name;
				button.onclick = () => { if (commit()) { activate(tab); render(true); } };
				button.ondblclick = () => $("sheet-options").click();
				button.draggable = true;
				button.ondragstart = event => {
					if (!commit()) { event.preventDefault(); return; }
					event.dataTransfer.setData("application/x-susi-worksheet",String(tabs.indexOf(tab)));
					event.dataTransfer.effectAllowed = "move";
				};
				button.ondragover = event => {
					if (event.dataTransfer.types.includes("application/x-susi-worksheet")) event.preventDefault();
				};
				button.ondrop = event => {
					const from = event.dataTransfer.getData("application/x-susi-worksheet");
					if (!/^\d+$/.test(from) || !tabs[+from] || tabs[+from] === tab) return;
					event.preventDefault(); activate(tabs[+from]); moveSheet(tabs.indexOf(tab)-Number(from));
				};
				button.onkeydown = event => {
					const index = tabs.indexOf(tab), next = {ArrowLeft:index-1,ArrowRight:index+1,Home:0,End:tabs.length-1}[event.key];
					if (!tabs[next] || !commit()) return;
					event.preventDefault(); activate(tabs[next]); render(); nav.children[next].focus();
				};
				return button;
			}));
		}
		for (const [i,button] of [...nav.children].entries()) button.setAttribute("aria-current",String(tabs[i] === sheet));
	}
	function uniqueName(base) {
		const names = new Set(tabs.map(tab => tab.name.toLowerCase()));
		for (let i = 1; ; i++) {
			const suffix = String(i), name = base.slice(0,31-suffix.length) + suffix;
			if (!names.has(name.toLowerCase())) return name;
		}
	}
	function insertTab(next) {
		const previous = sheet, i = tabs.indexOf(sheet) + 1;
		change(() => { tabs.splice(i,0,next); activate(next); }, () => { activate(previous); tabs.splice(i,1); });
		render(true);
	}
	$("sheet-add").onclick = () => { if (commit()) insertTab(tableWorkbook.empty(uniqueName("Sheet"))); };
	$("sheet-options").onclick = () => {
		if (!commit()) return;
		$("worksheet-name").value = sheet.name;
		$("sheet-left").disabled = sheet === tabs[0]; $("sheet-right").disabled = sheet === tabs.at(-1);
		show($("worksheet-dialog")); $("worksheet-name").select();
	};
	function formulas(transform) {
		const edits = [];
		for (const tab of tabs) for (const cells of tab.rows) cells.forEach((v,c) => {
			if (!(v instanceof Formula)) return;
			const expression = transform(v.expression,tab);
			if (expression !== v.expression) edits.push({cells,c,before:v,after:new Formula(expression)});
		});
		return edits;
	}
	$("worksheet-form").onsubmit = event => {
		event.preventDefault();
		const next = $("worksheet-name").value.trim(), before = sheet.name;
		if (!next || next.length > 31 || /[\\/*?:\[\]]|^'|'$/.test(next) || next.toLowerCase() === "history" ||
			tabs.some(tab => tab !== sheet && tab.name.toLowerCase() === next.toLowerCase())) {
			status("Enter a unique Excel sheet name of up to 31 characters without / \\ * ? : [ ] or outer apostrophes.",true); return;
		}
		if (next !== before) {
			const edits = formulas(expr => tableCalc.rename(expr,before,next));
			change(() => { sheet.name = next; for (const e of edits) e.cells[e.c] = e.after; },
				() => { sheet.name = before; for (const e of edits) e.cells[e.c] = e.before; });
		}
		$("worksheet-dialog").close(); render(true);
	};
	$("sheet-duplicate").onclick = () => {
		const name = uniqueName(sheet.name + " "), next = tableWorkbook.empty(name,sheet.rows.length,sheet.columns.length);
		next.charts = structuredClone(sheet.charts || []);
		next.columns = sheet.columns.map(col => ({name:col.name}));
		next.rows = sheet.rows.map(cells => cells.map(v => v instanceof Formula ? new Formula(tableCalc.rename(v.expression,sheet.name,name)) : v));
		for (const [r,c,style] of styleRecords()) {
			const cells = next.rows[r]; if (!next.styles.has(cells)) next.styles.set(cells,new Map());
			next.styles.get(cells).set(next.columns[c],{...style});
		}
		$("worksheet-dialog").close(); insertTab(next);
	};
	function moveSheet(step) {
		const i = tabs.indexOf(sheet), j = i + step;
		const move = (from,to) => tabs.splice(to,0,tabs.splice(from,1)[0]);
		change(() => move(i,j),() => move(j,i)); $("worksheet-dialog").close(); render(true);
	}
	$("sheet-left").onclick = () => moveSheet(-1); $("sheet-right").onclick = () => moveSheet(1);

	const filters = new Map(), widths = new WeakMap();
	const hidden = new WeakSet(), pinned = new WeakSet(), profiles = new WeakMap();
	let visibleColumns = [];
	function columnProfile(c) {
		const column = sheet.columns[c], cached = profiles.get(column);
		if (cached?.revision === revision && cached.answerVersion === answers.version) return cached.profile;
		const profile = tableOperations.profile(values(), c);
		profiles.set(column, { revision, answerVersion:answers.version, profile }); return profile;
	}
	const collator = new Intl.Collator(undefined, { numeric: true });
	const kindOrder = { missing: 0, null: 1, boolean: 2, number: 3, text: 4, json: 5 };
	let sortLevels = [], viewRevision, visibleRows = [], positions = new Map(), anchor;
	let matches = [], searchRevision, searchQuery;
	const address = (r, c) => letters(c) + (r + 1);
	function displayValue(value) {
		if (value === null) return "null";
		if (value === undefined && sheet.format === "jsonl") return "missing";
		return tableFormats.textValue(value);
	}
	function rowFilter(except) {
		const tests = [];
		for (const [column,filter] of filters) {
			const c = sheet.columns.indexOf(column);
			if (c < 0) { filters.delete(column); continue; }
			if (column === except) continue;
			if (filter.mode === "duplicates") {
				const duplicates = columnProfile(c).duplicates;
				tests.push((cells,r) => duplicates.has(r));
			} else if (filter.mode === "values") tests.push(cells => filter.keys.has(tableOperations.filterKey(cells[c])));
			else if (filter.mode === "empty") tests.push(cells => cells[c] == null || cells[c] === "");
			else tests.push(cells => displayValue(cells[c]) === filter.text);
		}
		return (cells,r) => tests.every(test => test(cells,r));
	}
	function rebuildView() {
		if (viewRevision === revision) return;
		const rows = values(), include = rowFilter();
		visibleRows = [];
		rows.forEach((cells,r) => { if (include(cells,r)) visibleRows.push(r); });
		sortLevels = sortLevels.filter(level => sheet.columns.includes(level.column));
		const keys = sortLevels.map(({column,order}) => {
			const c = sheet.columns.indexOf(column);
			const numericCSV = sheet.format === "csv" && !column.field && visibleRows.every(r => {
				const value = rows[r][c];
				return value == null || value === "" || LosslessJSON.isNumber(String(value));
			});
			return {c,numericCSV,direction:order === "asc" ? 1 : -1};
		});
		if (keys.length) visibleRows.sort((i,j) => {
			for (const {c,numericCSV,direction} of keys) {
				const a = rows[i][c], b = rows[j][c];
				const aKind = tableFormats.kind(a), bKind = tableFormats.kind(b);
				if (aKind !== bKind) return direction * (kindOrder[aKind] - kindOrder[bKind]);
				const cmp = aKind === "number" || (numericCSV && a && b)
					? LosslessJSON.compareNumber(String(a),String(b))
					: collator.compare(displayValue(a),displayValue(b));
				if (cmp) return direction * cmp;
			}
			return i-j;
		});
		positions = new Map(visibleRows.map((r, i) => [r, i]));
		viewRevision = revision;
	}
	function rangeBounds() {
		const end = positions.get(anchor?.extent?.row ?? row), start = positions.get(anchor?.row) ?? end;
		const endCol = visibleColumns.indexOf(anchor?.extent?.col ?? col);
		const wholeRows = anchor?.mode === "rows" || anchor?.mode === "all";
		const wholeCols = anchor?.mode === "columns" || anchor?.mode === "all";
		return { top: wholeCols ? 0 : Math.min(start, end), bottom: wholeCols ? visibleRows.length - 1 : Math.max(start, end),
			left: wholeRows ? 0 : Math.min(visibleColumns.indexOf(anchor?.col ?? col), endCol),
			right: wholeRows ? visibleColumns.length - 1 : Math.max(visibleColumns.indexOf(anchor?.col ?? col), endCol) };
	}
	function selectedRange() {
		const b = rangeBounds();
		return { rows: visibleRows.slice(b.top, b.bottom + 1), cols: visibleColumns.slice(b.left, b.right + 1) };
	}
	function selectionAddress() {
		const b = rangeBounds();
		if (!visibleRows.length || !visibleColumns.length) return "";
		const first = address(visibleRows[b.top], visibleColumns[b.left]), last = address(visibleRows[b.bottom], visibleColumns[b.right]);
		return first === last ? first : first + ":" + last;
	}
	function chooseHeader(header, extend = false) {
		if (!commit()) return;
		const mode = header.hasAttribute("data-c") ? "columns" : header.hasAttribute("data-r") ? "rows" : "all";
		const start = extend && anchor?.mode === mode ? anchor : null;
		if (mode === "columns") col = Number(header.dataset.c);
		if (mode === "rows") row = Number(header.dataset.r);
		anchor = start ? { row: start.row, col: start.col, mode } : { row, col, mode };
		selection(true);
	}
	function edges(y, x, b) {
		if (y < b.top || y > b.bottom || x < b.left || x > b.right) return "";
		return [y === b.top && "top", x === b.right && "right", y === b.bottom && "bottom", x === b.left && "left"].filter(Boolean).join(" ");
	}
	function paintSelection(bounds) {
		fillHandle.remove();
		const clip = clipboard?.sheet === sheet && clipboard.marked ? clipboard : null;
		for (const td of grid.querySelectorAll("td")) {
			const y = positions.get(+td.dataset.r), x = td.cellIndex - 1;
			const inside = y >= bounds.top && y <= bounds.bottom && x >= bounds.left && x <= bounds.right;
			td.toggleAttribute("data-range", !!anchor && inside);
			td.setAttribute("aria-selected", String(inside));
			const edge = edges(y, x, bounds);
			if (edge) td.dataset.edge = edge; else delete td.dataset.edge;
			const copyEdge = clip && edges(clip.rowPositions.get(+td.dataset.r) ?? -1, clip.colPositions.get(+td.dataset.c) ?? -1, clip.bounds);
			if (copyEdge) td.dataset.copyEdge = copyEdge; else delete td.dataset.copyEdge;
			if (!inline && !drag?.active && y === bounds.bottom && x === bounds.right) td.append(fillHandle);
		}
		const { rows, cols } = selectedRange(), stats = tableSheet.statistics(rows, cols, {rows:values()});
		$("selection-stats").textContent = "Count " + stats.count + "   ·   Sum " + stats.sum + "   ·   Average " + stats.average;
	}
	function activateTab(tab, focus = false) {
		for (const button of $("ribbon-tabs").children) {
			const selected = button === tab;
			button.setAttribute("aria-selected", selected); button.tabIndex = selected ? 0 : -1;
			$(button.getAttribute("aria-controls")).hidden = !selected;
		}
		if (focus) tab.focus();
	}
	$("ribbon-tabs").onclick = event => { if (event.target.matches("[role=tab]")) activateTab(event.target); };
	$("ribbon-tabs").onkeydown = event => {
		const tabs = [...$("ribbon-tabs").children], index = tabs.indexOf(event.target);
		const steps = { ArrowLeft: (index + 3) % 4, ArrowRight: (index + 1) % 4, Home: 0, End: 3 };
		if (Object.hasOwn(steps, event.key)) { event.preventDefault(); activateTab(tabs[steps[event.key]], true); }
	};
	$("import-table").onclick = () => $("open-table").click();
	$("data-options").onclick = () => grid.querySelector('th[data-c="' + col + '"] button')?.click();
	$("expand-bar").onclick = () => {
		const expanded = $("cell-bar").toggleAttribute("data-expanded");
		$("expand-bar").setAttribute("aria-expanded", expanded);
		$("expand-bar").setAttribute("aria-label", expanded ? "Collapse formula bar" : "Expand formula bar");
		$("expand-bar").title = $("expand-bar").getAttribute("aria-label");
	};

	function refreshMatches() {
		const query = $("find-value").value.toLocaleLowerCase();
		if (query !== searchQuery || revision !== searchRevision) {
			searchQuery = query; searchRevision = revision; matches = [];
			if (query) values().forEach((cells, r) => {
				for (let c = 0; c < sheet.columns.length; c++) {
					if (displayValue(cells[c]).toLocaleLowerCase().includes(query)) matches.push([r,c]);
				}
			});
		}
		const current = matches.findIndex(([r,c]) => r === row && c === col && positions.has(r));
		$("find-count").textContent = !query ? "" : current >= 0 ? (current + 1) + " of " + matches.length :
			matches.length + (matches.length === 1 ? " match" : " matches");
		$("find-next").disabled = $("find-prev").disabled = !matches.length;
		return current;
	}
	function reveal(r, c, focus) {
		const filtered = !positions.has(r), unhide = hidden.delete(sheet.columns[c]);
		if (filtered || unhide) {
			if (filtered) filters.clear();
			viewRevision = undefined; row = r; col = c; anchor = null; render(focus);
			status((filtered ? "Filters cleared. " : "") + "Showing " + address(r, c) + ".");
		} else move(r, c, focus);
		grid.querySelector("[data-selected]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}
	function findMatch(step, first = false) {
		if (!commit()) return;
		const current = refreshMatches();
		if (!matches.length) return;
		const index = first ? 0 : current < 0 ? (step > 0 ? 0 : matches.length - 1) :
			(current + step + matches.length) % matches.length;
		reveal(...matches[index], false);
	}
	$("find-value").oninput = () => findMatch(1, true);
	$("search-bar").onsubmit = event => { event.preventDefault(); findMatch(1); };
	$("find-prev").onclick = () => findMatch(-1);
	$("find-value").onkeydown = event => {
		if (event.shiftKey && event.key === "Enter") { event.preventDefault(); findMatch(-1); }
	};
	$("cell-address").onfocus = event => event.target.select();
	$("cell-address").onblur = event => {
		event.target.value = selectionAddress();
	};
	$("cell-address").onkeydown = event => {
		if (event.key === "Escape") { event.preventDefault(); event.target.value = selectionAddress(); grid.querySelector("[data-selected]")?.focus(); return; }
		if (event.key !== "Enter") return;
		event.preventDefault();
		const parts = event.target.value.trim().split(":");
		const points = parts.map(part => {
			const match = /^([A-Z]+)([1-9]\d*)$/i.exec(part.trim());
			return match && { row: Number(match[2]) - 1, col: [...match[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 };
		});
		if (parts.length > 2 || points.some(p => !p || p.row >= sheet.rows.length || p.col >= sheet.columns.length)) {
			status("Enter a cell or range within this table.", true); event.target.select(); return;
		}
		if (!commit()) return;
		const [first, last] = points;
		if (!last) { reveal(first.row, first.col, true); return; }
		if (!positions.has(first.row) || !positions.has(last.row)) { filters.clear(); viewRevision = undefined; }
		hidden.delete(sheet.columns[first.col]); hidden.delete(sheet.columns[last.col]);
		row = first.row; col = first.col; anchor = last; render(true);
	};
	$("reset-view").onclick = () => {
		if (!commit()) return;
		filters.clear(); sortLevels = []; anchor = null; viewRevision = undefined; render(true);
	};

	function status(message, error = false) {
		const out = document.querySelector("dialog[open] .dialog-status") || $("table-status");
		out.textContent = message;
		out.toggleAttribute("data-error", error);
	}
	function show(dialog) {
		dialog.querySelector(".dialog-status").textContent = "";
		dialog.showModal();
	}

	// Keep pickers in the click's user activation and serialize file operations.
	async function run(action) {
		if (busy) return;
		const previousSheet = sheet;
		const hadCellFocus = document.activeElement?.matches("#data-grid td[data-selected]");
		busy = true;
		const activeDialog = document.querySelector("dialog[open]");
		$("table-workspace").inert = true;
		if (activeDialog) activeDialog.inert = true;
		try { await action(); }
		catch (error) { if (error.name !== "AbortError") status(error.message || String(error), true); }
		finally {
			busy = false;
			$("table-workspace").inert = false;
			if (activeDialog) activeDialog.inert = false;
			if (modelViewDirty && !draft && !inline) render();
			// File loads render while the workspace is inert. Focus the final selection once it accepts input.
			if ((sheet !== previousSheet || hadCellFocus) && !document.querySelector("dialog[open]"))
				grid.querySelector("td[data-selected]")?.focus();
		}
	}

	function title() {
		const newWorkbook = !source && needsWorkbook();
		const name = source?.name || (newWorkbook ? "Untitled.xlsx" : "Untitled.csv");
		$("file-name").textContent = name + (changed() ? " *" : "");
		$("unsaved").hidden = !changed();
		const folder = source?.path?.slice(0, -name.length);
		$("file-location").textContent = folder ? "Workspace · " + folder : source ? "Computer" : newWorkbook ? "New workbook" : "New table";
		$("file-location").title = source?.path || "";
		document.title = (changed() ? "* " : "") + name + " · " + pageTitle;
		$("undo").disabled = !past.length;
		$("redo").disabled = !future.length;
	}

	function reset(next, file, message, records = [], worksheets = [next]) {
		clipboard = pendingPaste = null; dataRevision = savedData = 0;
		answers?.controller.abort();
		answers = new tableModel.Answers(worksheets.modelAnswers,modelResult,showModelProgress);
		savedAnswerVersion = 0;
		tabs = worksheets; sheet = next; sheet.name ||= "Sheet1";
		// Tab buttons capture their worksheet. Rebind even when a reopened book has the same names.
		$("worksheet-tabs").replaceChildren();
		if (sheet.styles) styles = sheet.styles; else { restoreStyles(records); sheet.styles = styles; }
		answers.sync(tabs,false); modelStatus();
		invalidate(); source = file; row = col = page = revision = saved = sequence = 0;
		if (file?.path && lastView?.file === file.path) {
			row = Number.isSafeInteger(lastView.row) ? lastView.row : 0;
			col = Number.isSafeInteger(lastView.column) ? lastView.column : 0;
		}
		filters.clear(); sortLevels = []; anchor = null; viewRevision = searchRevision = undefined;
		$("find-value").value = "";
		past.length = future.length = 0;
		draft = false; inline = null;
		render(!busy);
		if (message) status(message);
	}

	function empty() {
		const columns = [1, 2, 3].map(n => ({ name: "Column " + n }));
		const rows = Array.from({ length: tableWorkbook.defaultRowCount }, () => columns.map(() => ""));
		return { format: "csv", columns, rows };
	}

	function rememberView(file) {
		const csv = source?.csv;
		const next = file ? { file, row, column: col, worksheet:sheet.name, csv } : { file: null };
		if (lastView?.file === next.file && lastView.worksheet === next.worksheet && lastView.row === next.row && lastView.column === next.column && lastView.csv?.header === csv?.header && lastView.csv?.delimiter === csv?.delimiter) return;
		lastView = next;
		pageSettings.save("table", { view: next });
	}

	function typeOptions() {
		if (sheet.format === "xlsx") return ["auto","text","number","boolean"];
		const field = sheet.columns[col]?.field;
		const value = sheet.rows[row]?.[col];
		if (sheet.format === "csv" && !field) return ["text"];
		if (!field) return sheet.values ? ["text","number","boolean","json","null"] : ["text","number","boolean","json","null","missing"];
		const types = [tableParquet.kind(field)];
		// Special floats and dates outside the ISO range retain their original representation.
		if (value != null && !types.includes(tableFormats.kind(value))) types.push(tableFormats.kind(value));
		if (field.element.repetition_type !== "REQUIRED") types.push("null");
		return types;
	}

	function selection(focus = false) {
		functionMenu.close();
		if (!$("cell-error").hidden) clearCellError();
		const bounds = rangeBounds();
		paintSelection(bounds);
		refreshMatches();
		const old = grid.querySelector("[data-selected]");
		if (old) { old.tabIndex = -1; old.removeAttribute("data-selected"); }
		grid.querySelectorAll("[data-active]").forEach(th => th.removeAttribute("data-active"));
		const cell = grid.querySelector(`td[data-r="${row}"][data-c="${col}"]`);
		if (cell) {
			cell.dataset.selected = ""; cell.tabIndex = 0;
			cell.parentNode.firstChild.dataset.active = "";
			grid.tHead.rows[0].cells[cell.cellIndex].dataset.active = "";
			if (focus) cell.focus();
		}
		for (const header of grid.querySelectorAll("th[data-c]")) {
			if (anchor && header.cellIndex - 1 >= bounds.left && header.cellIndex - 1 <= bounds.right) header.dataset.active = "";
		}
		for (const header of grid.querySelectorAll("th[data-r]")) {
			const pos = positions.get(+header.dataset.r);
			if (anchor && pos >= bounds.top && pos <= bounds.bottom) header.dataset.active = "";
		}
		for (const control of $("panel-home").querySelectorAll("button,input,select")) control.disabled = !cell;
		const style = styles.get(sheet.rows[row])?.get(sheet.columns[col]) || {};
		$("cell-condition").value = style.condition || "";
		$("number-format").value = style.format || "general"; $("cell-align").value = style.align || "";
		$("wrap-cells").setAttribute("aria-pressed", !!style.wrap);
		$("cell-color").value = style.color || "#314b60";
		const field = sheet.columns[col]?.field;
		const v = sheet.rows[row]?.[col];
		const kind = sheet.format === "csv" && !field ? "text" : tableFormats.kind(v);
		const types = typeOptions();
		type.replaceChildren(...types.map(t => new Option(t === "json" ? "JSON" : t[0].toUpperCase() + t.slice(1), t)));
		if (field) type.options[0].textContent = tableParquet.label(field);
		type.value = sheet.format === "xlsx" ? "auto" : types.includes(kind) ? kind : types[0];
		type.disabled = !cell || types.length < 2;
		type.title = field ? "Parquet column type: " + tableParquet.fieldType(field.element) : "Cell value type";
		bar.value = cell ? inputText(v) : "";
		bar.removeAttribute("aria-invalid");
		bar.placeholder = cell ? "Enter a value or =formula" : "";
		bar.disabled = !cell || ["null", "missing"].includes(type.value);
		$("insert-chart").disabled = !cell;
		$("auto-sum").disabled = !cell || !acceptsFormula(type.value,field);
		$("apply-cell").disabled = $("fill-selection").disabled = !cell;
		$("replace-values").disabled = !sheet.columns.length || !sheet.rows.length;
		$("cell-address").value = cell ? selectionAddress() : "";
		$("remove-row").disabled = !visibleRows.length;
		$("rename-column").disabled = !sheet.columns.length || !!sheet.values;
		$("remove-column").disabled = sheet.columns.length <= 1 || !!sheet.values;
		$("add-column").disabled = !!sheet.values;
		$("add-row").disabled = $("append-row").disabled = !sheet.columns.length && sheet.format !== "jsonl";
		if (source?.path) rememberView(source.path);
		referencePicker.update(true);
	}

	function renderRows(start,end) {
		const body = document.createDocumentFragment();
		for (let pos = start; pos < end; pos++) {
			const r = visibleRows[pos];
			const tr = document.createElement("tr"), th = document.createElement("th");
			th.scope = "row"; th.dataset.r = r; th.textContent = r + 1; tr.append(th);
			if (sheet.rows.length > 1 && !sortLevels.length && !filters.size) {
				th.dataset.reorder = "row";
				th.title = "Drag to move row " + (r + 1);
			}
			for (const c of visibleColumns) {
				const td = document.createElement("td"), v = values()[r][c];
				td.dataset.r = r; td.dataset.c = c; td.tabIndex = -1;
				pinCell(td, c);
				td.dataset.kind = sheet.format === "csv" && !sheet.columns[c].field ? "text" : tableFormats.kind(v);
				const style = styles.get(sheet.rows[r])?.get(sheet.columns[c]);
				td.textContent = tableSheet.formatted(v, style, displayValue(v));
				if (style) {
					td.style.textAlign = style.align || ""; td.style.backgroundColor = style.color || "";
					const n = tableSheet.numeric(v);
					if (n !== null && ((style.condition === "negative" && +n < 0) || (style.condition === "positive" && +n > 0) || (style.condition === "zero" && +n === 0))) td.dataset.condition = style.condition;
					if (style.wrap) { td.style.whiteSpace = "pre-wrap"; td.style.overflowWrap = "anywhere"; }
				}
				tr.append(td);
			}
			body.append(tr);
		}
		return body;
	}
	function render(focus = false, visiblePage) {
		modelViewDirty = false;
		if (drag?.active && visiblePage === undefined) endDrag(false);
		inline = null; clearCellError(); rebuildView();
		row = Math.min(Math.max(0, row), Math.max(0, sheet.rows.length - 1));
		if (sheet.columns.length && sheet.columns.every(column => hidden.has(column))) hidden.delete(sheet.columns[0]);
		visibleColumns = sheet.columns.map((_, c) => c).filter(c => !hidden.has(sheet.columns[c]));
		visibleColumns.sort((a, b) => Number(pinned.has(sheet.columns[b])) - Number(pinned.has(sheet.columns[a])));
		if (!visibleColumns.includes(col)) col = visibleColumns.find(c => c >= col) ?? visibleColumns.at(-1) ?? 0;
		if (!positions.has(row)) row = visibleRows[0] ?? 0;
		if (anchor && (!positions.has(anchor.row) || !visibleColumns.includes(anchor.col) ||
			(anchor.extent && (!positions.has(anchor.extent.row) || !visibleColumns.includes(anchor.extent.col))))) anchor = null;
		page = visiblePage ?? Math.floor((positions.get(row) ?? 0) / pageSize);
		const head = document.createElement("tr");
		const corner = document.createElement("th"); corner.title = "Select all"; corner.setAttribute("aria-label", "Select all cells"); corner.textContent = "◩"; head.append(corner);
		for (const i of visibleColumns) {
			const column = sheet.columns[i];
			const th = document.createElement("th"), letter = document.createElement("small");
			letter.textContent = letters(i);
			th.scope = "col"; th.dataset.c = i; pinCell(th, i);
			if (sheet.format === "xlsx" && column.name === letters(i)) th.append(column.name);
				else th.append(letter, column.name || "(unnamed)");
			th.title = column.field ? tableParquet.fieldType(column.field.element) : column.name;
			if (sheet.columns.length > 1) {
				th.dataset.reorder = "column";
				th.title = [th.title, "Drag to move column " + letters(i)].filter(Boolean).join("\n");
			}
			const menu = document.createElement("button");
			menu.type = "button"; menu.className = "column-menu";
			menu.setAttribute("aria-label", "Options for " + (column.name || letters(i)));
			menu.setAttribute("aria-haspopup", "dialog");
			const priority = sortLevels.findIndex(level => level.column === column);
			menu.textContent = "▾";
			if (priority >= 0) {
				const ascending = sortLevels[priority].order === "asc";
				menu.textContent = (ascending ? "↑" : "↓") + (sortLevels.length > 1 ? priority+1 : "");
				menu.title = "Sort level " + (priority+1) + (ascending ? ", ascending" : ", descending");
				if (!priority) th.setAttribute("aria-sort",ascending ? "ascending" : "descending");
			}
			menu.toggleAttribute("data-filtered",filters.has(column));
			if (filters.has(column)) menu.title = [menu.title,"Filtered"].filter(Boolean).join(" · ");
			if (menu.title) menu.setAttribute("aria-label",menu.getAttribute("aria-label") + ", " + menu.title);
			const grip = document.createElement("span"); grip.className = "resize-column";
			grip.title = "Drag to resize · Double-click to fit";
			th.append(menu, grip); head.append(th);
		}
		sizeColumns();
		grid.tHead.replaceChildren(head);
		const start = page * pageSize, end = Math.min(start + pageSize, visibleRows.length);
		grid.tBodies[0].replaceChildren(renderRows(start,end));
		const nr = sheet.rows.length, nc = sheet.columns.length;
		$("custom-sort").disabled = !nc;
		$("reset-view").hidden = !filters.size && !sortLevels.length;
		$("dimensions").textContent = (filters.size ? visibleRows.length.toLocaleString() + " of " : "") + `${nr.toLocaleString()} ${nr === 1 ? "row" : "rows"} · ${nc.toLocaleString()} ${nc === 1 ? "column" : "columns"}`;
		$("page-range").textContent = end ? `${start + 1}–${end}` : "0";
		$("previous-page").disabled = !start;
		$("next-page").disabled = end >= visibleRows.length;
		$("page-range").parentNode.hidden = visibleRows.length <= pageSize;
		drawTabs(); chartPanel.render(sheet,calculate); selection(focus); title();
	}

	const chartPanel = tableChartPanel($,show,commit,charts => {
		const before = sheet.charts;
		change(() => { sheet.charts = charts; },() => { sheet.charts = before; },true);
		render(true);
	});
	$("insert-chart").onclick = () => {
		if (commit()) chartPanel.open(selectedRange());
	};

	function change(apply, revert, presentation = false) {
		if (clipboard) clipboard.marked = false;
		anchor = null;
		const owner = sheet, before = revision, after = ++sequence;
		apply(); revision = after;
		if (!presentation) { answers.sync(tabs,true); modelStatus(); }
		invalidate();
		const beforeData = dataRevision;
		if (!presentation) dataRevision = after;
		past.push({ owner, apply, revert, before, after, beforeData, afterData: dataRevision });
		if (past.length > 100) past.shift();
		future.length = 0;
	}
	function layoutChange(axis, apply, revert) {
		const key = axis === "row" ? "rows" : "columns";
		const before = sheet[key].slice(), charts = sheet.charts;
		let edits, nextCharts;
		change(() => {
			apply();
			if (!edits) {
				const current = sheet[key], indices = new Map(current.map((item,i) => [item,i]));
				const remap = i => i < before.length ? (indices.get(before[i]) ?? -1) : i + current.length - before.length;
				nextCharts = charts?.map(chart => tableCharts.remap(chart,axis,remap,current.length > before.length));
				edits = formulas((expr,tab) => tableCalc.relayout(expr,tab.name,sheet.name,axis,remap));
			}
			sheet.charts = nextCharts;
			for (const e of edits) e.cells[e.c] = e.after;
		}, () => {
			sheet.charts = charts;
			for (const e of edits) e.cells[e.c] = e.before;
			revert();
		});
	}
	function undo(redo) {
		if (!commit()) return;
		anchor = null;
		const entry = (redo ? future : past).pop();
		if (!entry) return;
		if (clipboard) clipboard.marked = false;
		activate(entry.owner);
		dataRevision = redo ? entry.afterData : entry.beforeData;
		if (redo) { entry.apply(); revision = entry.after; past.push(entry); }
		else { entry.revert(); revision = entry.before; future.push(entry); }
		if (entry.beforeData !== entry.afterData) { answers.sync(tabs,true); modelStatus(); }
		invalidate(); render(true); status(redo ? "Change reapplied." : "Change undone.");
	}

	function acceptsFormula(kind, field) {
		return !field && (sheet.format === "csv" || (sheet.format === "xlsx" && kind !== "text"));
	}
	function editValue(kind, text, field) {
		if (acceptsFormula(kind,field) && text.startsWith("=")) return new Formula(text);
		if (kind === "auto") {
			if (text.startsWith("'")) return text.slice(1);
			if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
			const date = tableWorkbook.parseDate(text);
			if (date) return date;
			if (LosslessJSON.isNumber(text.trim())) return tableFormats.number(text.trim());
			return text;
		}
		return tableFormats.parseCell(kind,text);
	}
	function commit() {
		if (!draft && !inline) return true;
		try {
			if (draft) {
				const cells = sheet.rows[row], c = col, field = sheet.columns[c].field;
				const next = editValue(type.value, bar.value, field);
				if (field) tableParquet.validate(field, next);
				const e = cellEdit(cells,sheet.columns[c],c,next);
				if (tableFormats.json(e.value) !== tableFormats.json(e.before) || e.style !== e.previousStyle) applyCells([e]);
			}
		} catch (error) {
			showCellError(error.message, inline || bar);
			return false;
		}
		draft = false;
		render();
		status("Cell applied.");
		return true;
	}
	function showCellError(message, editor) {
		clearCellError();
		const cell = grid.querySelector("[data-selected]"), error = $("cell-error");
		if (cell) {
			cell.dataset.invalid = "";
			cell.append(error); error.textContent = message; error.hidden = false;
			const bounds = scroller.getBoundingClientRect(), box = error.getBoundingClientRect();
			error.toggleAttribute("data-above", box.bottom > bounds.bottom);
			error.toggleAttribute("data-align-end", box.right > bounds.right);
			editor ??= cell;
			editor.setAttribute("aria-invalid", "true"); editor.setAttribute("aria-describedby", "cell-error");
			editor.focus();
		}
		status(message, true);
	}
	function clearCellError() {
		const error = $("cell-error");
		const invalid = grid.querySelector("td[aria-invalid]");
		if (invalid) { invalid.removeAttribute("aria-invalid"); invalid.removeAttribute("aria-describedby"); }
		error.removeAttribute("data-above"); error.removeAttribute("data-align-end");
		if (error.parentElement !== scroller) scroller.append(error);
		error.hidden = true; grid.querySelector("[data-invalid]")?.removeAttribute("data-invalid");
		bar.removeAttribute("aria-invalid"); bar.setAttribute("aria-describedby", "table-status");
		if (inline) { inline.removeAttribute("aria-invalid"); inline.removeAttribute("aria-describedby"); }
	}
	function move(r, c, focus = true, extend = false, keep = null) {
		if (!commit()) return;
		if (extend) anchor = { row: anchor?.row ?? row, col: anchor?.col ?? col }; else anchor = keep;
		if (anchor && (!positions.has(anchor.row) || (anchor.extent && !positions.has(anchor.extent.row)))) anchor = null;
		row = positions.has(r) ? r : visibleRows[0] ?? 0;
		col = Math.max(0, Math.min(c, sheet.columns.length - 1));
		if (page !== Math.floor((positions.get(row) ?? 0) / pageSize)) render(focus); else selection(focus);
	}
	function reorder(axis, from, to) {
		const columns = axis === "column";
		if (columns && pinned.has(sheet.columns[from]) !== pinned.has(sheet.columns[to])) {
			status("Use the column menu to pin or unpin this column."); return;
		}
		if (!columns && (sortLevels.length || filters.size)) { status("Clear filters and sort before moving rows."); return; }
		const items = columns ? sheet.columns : sheet.rows;
		if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length || !commit()) return;
		function relocate(list, start, end) {
			if (start >= list.length && end >= list.length) return;
			const [value] = list.splice(start, 1);
			// A short CSV record can move a real field beyond its current end.
			if (end > list.length) list.length = end;
			list.splice(end, 0, value);
		}
		function apply(start, end) {
			relocate(items, start, end);
			if (columns) {
				for (const cells of sheet.rows) {
					relocate(cells, start, end);
					if (sheet.format === "csv") {
						while (cells.length && cells[cells.length - 1] === undefined) cells.pop();
					}
				}
				col = end;
			} else row = end;
		}
		layoutChange(axis, () => apply(from, to), () => apply(to, from));
		render(true);
		status(columns ? `Column ${letters(from)} moved to ${letters(to)}.` : `Row ${from + 1} moved to ${to + 1}.`);
	}

	function endDrag(restorePage = true) {
		if (!drag) return;
		const { id, header, frame, pageTimer, homePage } = drag;
		drag = null;
		cancelAnimationFrame(frame); clearTimeout(pageTimer);
		for (const element of [grid, header]) {
			if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
		}
		grid.removeAttribute("data-moving");
		dropLine.hidden = true;
		if (restorePage && page !== homePage) render();
	}

	function trackDrop() {
		const { axis, from, x, y } = drag;
		const horizontal = axis === "column";
		const hit = document.elementFromPoint(x, y);
		const pager = !horizontal && hit?.closest("#previous-page:enabled, #next-page:enabled");
		if (pager !== drag.pager) {
			clearTimeout(drag.pageTimer);
			drag.pager = pager;
			if (pager) drag.pageTimer = setTimeout(() => {
				const next = pager.id === "next-page";
				render(false, page + (next ? 1 : -1));
				scroller.scrollTop = next ? 0 : scroller.scrollHeight;
			}, 450);
		}
		const cell = hit?.closest("th, td");
		const index = horizontal ? cell?.dataset.c : cell?.dataset.r;
		drag.to = null;
		dropLine.hidden = true;
		const view = scroller.getBoundingClientRect();
		const start = horizontal ? view.left + grid.tHead.rows[0].cells[0].offsetWidth : view.top + grid.tHead.offsetHeight;
		const end = horizontal ? Math.min(view.left + scroller.clientWidth, innerWidth) : Math.min(view.top + scroller.clientHeight, innerHeight);
		if (index !== undefined && grid.contains(cell)) {
			const rect = cell.getBoundingClientRect(), target = Number(index);
			const offset = horizontal ? x - rect.left - rect.width / 2 : y - rect.top - rect.height / 2;
			const after = Math.abs(offset) <= 1 ? target > from : offset > 0;
			const boundary = target + Number(after);
			const to = boundary > from ? boundary - 1 : boundary;
			if (to !== from && (!horizontal || pinned.has(sheet.columns[target]) === pinned.has(sheet.columns[from]))) {
				drag.to = to;
				const edge = horizontal ? (after ? rect.right : rect.left) : (after ? rect.bottom : rect.top);
				const marker = Math.max(start, Math.min(edge - 1, end - 2));
				const bottom = Math.min(view.bottom, grid.getBoundingClientRect().bottom);
				dropLine.style.left = (horizontal ? marker : view.left) + "px";
				dropLine.style.top = (horizontal ? view.top : marker) + "px";
				dropLine.style.width = (horizontal ? 2 : scroller.clientWidth) + "px";
				dropLine.style.height = (horizontal ? bottom - view.top : 2) + "px";
				dropLine.hidden = false;
			}
		}
		if (!scroller.contains(hit) || drag.frame) return;
		const position = horizontal ? x : y;
		const step = position < start + 24 ? -12 : position > end - 24 ? 12 : 0;
		if (step) drag.frame = requestAnimationFrame(() => {
			drag.frame = 0;
			const before = horizontal ? scroller.scrollLeft : scroller.scrollTop;
			scroller.scrollBy(horizontal ? step : 0, horizontal ? 0 : step);
			if (before !== (horizontal ? scroller.scrollLeft : scroller.scrollTop)) trackDrop();
		});
	}

	grid.addEventListener("pointerdown", event => {
		if (event.target.closest("button, .resize-column")) return;
		const header = event.target.closest("th[data-reorder]");
		if (!header || busy || drag || !event.isPrimary || event.button !== 0) return;
		drag = { id: event.pointerId, header, axis: header.dataset.reorder, from: Number(header.dataset.c ?? header.dataset.r),
			startX: event.clientX, startY: event.clientY, homePage: page, active: false };
		header.setPointerCapture(event.pointerId);
	});
	grid.addEventListener("pointermove", event => {
		if (drag?.id !== event.pointerId) return;
		drag.x = event.clientX; drag.y = event.clientY;
		if (!drag.active) {
			if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
			// Capture on the table itself so paging or committing an edit can replace the source header.
			grid.setPointerCapture(event.pointerId);
			if (!commit()) { endDrag(); return; }
			drag.active = true;
			grid.dataset.moving = drag.axis;
		}
		trackDrop();
	});
	grid.addEventListener("pointerup", event => {
		if (drag?.id !== event.pointerId) return;
		if (!drag.active) { endDrag(); return; }
		drag.x = event.clientX; drag.y = event.clientY;
		trackDrop();
		const { axis, from, to } = drag;
		endDrag(to === null);
		if (to !== null) reorder(axis, from, to);
	});
	grid.addEventListener("pointercancel", event => { if (drag?.id === event.pointerId) endDrag(); });
	grid.addEventListener("lostpointercapture", event => {
		if (drag?.id === event.pointerId && (event.target === grid || !drag.active)) endDrag();
	});
	window.addEventListener("blur", () => endDrag());
	document.addEventListener("keydown", event => {
		if (drag && event.key === "Escape") { event.preventDefault(); endDrag(); }
	});
	const functionMenu = tableFunctionMenu($("formula-functions"), () => acceptsFormula(type.value,sheet.columns[col]?.field));
	functionMenu.bind(bar);
	function formulaEditor() {
		const el = document.activeElement;
		return (el === bar || el === inline) && sheet && acceptsFormula(type.value,sheet.columns[col]?.field) ? el : null;
	}
	const referencePicker = tableReferencePicker({grid, bar, scroller, getEditor:formulaEditor,
		getSheetName:() => sheet?.name || "", closeMenu:functionMenu.close,
		extendRows(direction) {
			// Append temporary rows without replacing the focused in-cell editor across a page boundary.
			const body = grid.tBodies[0], rows = body.rows;
			if (direction > 0) {
				const start = positions.get(+rows[rows.length-1].cells[0].dataset.r)+1;
				if (start >= visibleRows.length) return false;
				body.append(renderRows(start,Math.min(start+pageSize,visibleRows.length)));
			} else {
				const end = positions.get(+rows[0].cells[0].dataset.r);
				if (!end) return false;
				const height = scroller.scrollHeight, top = scroller.scrollTop;
				body.prepend(renderRows(Math.max(0,end-pageSize),end));
				scroller.scrollTop = top + scroller.scrollHeight-height;
			}
			return true;
		},
		trimRows() {
			for (const tr of Array.from(grid.tBodies[0].rows)) {
				if (Math.floor(positions.get(+tr.cells[0].dataset.r)/pageSize) !== page) tr.remove();
			}
			grid.querySelector("td[data-selected]")?.scrollIntoView({block:"nearest",inline:"nearest"});
		}
	});
	const openHelp = tableFormulaHelp($("formula-help"));
	function formulaHelp() {
		const editor = document.activeElement === bar ? bar : inline;
		const text = (editor || bar).value;
		const selection = editor && [editor.selectionStart, editor.selectionEnd, editor.selectionDirection];
		const start = text.match(/^=[\s(]*/)?.[0].length ?? 0;
		openHelp(text,editor?.selectionStart ?? start,functionMenu.highlighted(),() => {
			if (!editor?.isConnected) return;
			editor.focus({preventScroll:true});
			editor.setSelectionRange(...selection);
		});
		functionMenu.close();
	}
	$("formula-help-button").onpointerdown = event => {
		// Keep the active editor and highlighted suggestion available until the click.
		if (document.activeElement === bar || (inline && document.activeElement === inline)) event.preventDefault();
	};
	$("formula-help-button").onclick = formulaHelp;
	document.addEventListener("keydown", event => {
		if (event.key === "F1" && !busy && !document.querySelector("dialog[open]") && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
			event.preventDefault(); formulaHelp();
		}
	});
	function edit(initial) {
		if (inline || !sheet.rows[row] || !sheet.columns[col]) return;
		const cell = grid.querySelector("[data-selected]");
		if (!cell) return;
		if (["null", "missing"].includes(type.value)) {
			type.value = type.options[0].value; bar.disabled = false;
		}
		clearCellError();
		const editor = document.createElement("textarea");
		editor.setAttribute("aria-label", "Edit " + address(row,col));
		editor.spellcheck = false; editor.value = initial ?? bar.value;
		functionMenu.bind(editor);
		fillHandle.remove(); inline = editor; cell.append(editor); editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
		if (initial !== undefined) { bar.value = initial; editor.setSelectionRange(initial.length, initial.length); draft = true; title(); }
		referencePicker.update();
	}
	function referenceEditor(cell, event) {
		const editor = formulaEditor();
		if (!cell || cell.hasAttribute("data-selected") || !editor ||
			event.button !== 0 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
		return tableCalc.expectsReference(editor.value,editor.selectionStart,editor.selectionEnd) ? editor : null;
	}
	grid.addEventListener("click", event => {
		if (event.target.closest(".resize-column, button")) return;
		const header = event.target.closest("th");
		if (header) { chooseHeader(header, event.shiftKey); return; }
		const cell = event.target.closest("td");
		const editor = referenceEditor(cell,event);
		if (editor) {
			editor.setRangeText(address(+cell.dataset.r,+cell.dataset.c),editor.selectionStart,editor.selectionEnd,"end");
			editor.dispatchEvent(new Event("input",{bubbles:true}));
			return;
		}
		if (cell && event.target !== inline && !cell.matches("td[data-selected]")) move(Number(cell.dataset.r ?? row), Number(cell.dataset.c ?? col), true, event.shiftKey);
	});
	grid.addEventListener("dblclick", event => { if (event.target.closest("td")) edit(); });
	grid.addEventListener("input", event => {
		if (event.target === inline) { clearCellError(); bar.value = inline.value; draft = true; title(); referencePicker.update(); }
	});
	bar.addEventListener("input", () => { clearCellError(); if (inline) inline.value = bar.value; draft = true; title(); referencePicker.update(); });
	type.addEventListener("change", () => {
		clearCellError(); draft = true; bar.disabled = ["null", "missing"].includes(type.value);
		$("auto-sum").disabled = !acceptsFormula(type.value,sheet.columns[col]?.field);
		if (bar.disabled) bar.value = "";
		if (inline) { inline.remove(); inline = null; }
		title(); if (!bar.disabled) bar.focus();
	});
	$("apply-cell").onclick = () => { if (commit()) selection(true); };
	function autoSum() {
		if ($("auto-sum").disabled) return;
		if (bar.value !== "") {
			status("Select an empty result cell below or to the right of the numbers.");
			(inline || bar).focus();
			return;
		}
		function numericAt(r,c) {
			const value = calculate(sheet,r,c);
			return tableFormats.isNumber(value) || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
		}
		let range = "";
		for (const [dr,dc] of [[1,0],[0,1]]) {
			let r = row-dr, c = col-dc;
			if (r < 0 || c < 0 || !numericAt(r,c)) continue;
			const last = address(r,c);
			while (r >= dr && c >= dc && numericAt(r-dr,c-dc)) { r -= dr; c -= dc; }
			const first = address(r,c);
			range = first === last ? first : first + ":" + last;
			break;
		}
		const prefix = "=SUMME(";
		bar.focus();
		bar.value = prefix + range + ")";
		bar.setSelectionRange(prefix.length,prefix.length + range.length);
		bar.dispatchEvent(new Event("input",{bubbles:true}));
		functionMenu.close();
		status("Select a range or press Enter to apply AutoSum.");
	}
	$("auto-sum").onclick = autoSum;
	function keys(event) {
		if (functionMenu.keydown(event)) return;
		const editor = event.target === inline || event.target === bar;
		if (!editor && !event.target.matches("td")) return;
		if (event.altKey && event.key === "=" && !event.ctrlKey && !event.metaKey && !event.isComposing && !$("auto-sum").disabled) {
			event.preventDefault(); autoSum(); return;
		}
		const pos = positions.get(row);
		const x = visibleColumns.indexOf(col), width = visibleColumns.length;
		const at = index => visibleRows[Math.min(visibleRows.length - 1, Math.max(0, index))];
		if (!editor && event.target.matches("td") && event.altKey && !event.ctrlKey && !event.metaKey &&
			!event.shiftKey && !event.isComposing && event.key.startsWith("Arrow")) {
			event.preventDefault();
			const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
			const from = horizontal ? col : row;
			const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
			reorder(horizontal ? "column" : "row", from, horizontal ? visibleColumns[x + delta] ?? from : from + delta);
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) {
			event.preventDefault(); enterRangeValue(); return;
		}
		if (!editor && (event.ctrlKey || event.metaKey) && !event.isComposing) {
			if (event.key.toLowerCase() === "a") { event.preventDefault(); chooseHeader(grid.tHead.rows[0].cells[0]); return; }
			if (event.key.startsWith("Arrow")) {
				event.preventDefault();
				const horizontal = ["ArrowLeft","ArrowRight"].includes(event.key), step = ["ArrowLeft","ArrowUp"].includes(event.key) ? -1 : 1;
				const axis = horizontal ? visibleColumns : visibleRows, last = axis.length - 1;
				const filled = i => { const v = horizontal ? sheet.rows[row][axis[i]] : sheet.rows[axis[i]][col]; return v != null && v !== ""; };
				let i = horizontal ? x : pos;
				if (i + step >= 0 && i + step <= last) {
					const contiguous = filled(i) && filled(i + step);
					i += step;
					while (i + step >= 0 && i + step <= last && (contiguous ? filled(i + step) : !filled(i))) i += step;
				}
				move(horizontal ? row : axis[i], horizontal ? axis[i] : col, true, event.shiftKey);
			}
			return;
		}
		if (editor && event.altKey && event.key === "Enter" && !event.isComposing) {
			event.preventDefault(); event.target.setRangeText("\n",event.target.selectionStart,event.target.selectionEnd,"end");
			event.target.dispatchEvent(new Event("input",{ bubbles: true })); return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
		if (event.key === "F4" && !event.shiftKey && editor && formulaEditor() === event.target) {
			const input = event.target;
			const edit = tableCalc.cycleReferences(input.value,input.selectionStart,input.selectionEnd);
			if (edit) {
				event.preventDefault();
				const direction = input.selectionDirection;
				input.value = edit.value;
				input.setSelectionRange(edit.selectionStart,edit.selectionEnd,direction);
				input.dispatchEvent(new Event("input",{bubbles:true}));
				functionMenu.close();
			}
			return;
		}
		if (event.key === "Escape" && editor) {
			event.preventDefault(); draft = false; render(true); status("Edit cancelled."); return;
		}
		if (event.key === "Escape" && !editor) {
			event.preventDefault(); pendingPaste = null;
			if (clipboard?.marked && clipboard.cutEntry && clipboard.cutEntry === past.at(-1) && revision !== saved) undo(false);
			if (clipboard) clipboard.marked = false;
			anchor = null; selection(true); return;
		}
		if (event.key === "Tab" || event.key === "Enter") {
			const b = rangeBounds();
			if (anchor && (b.top < b.bottom || b.left < b.right)) {
				event.preventDefault();
				const vertical = event.key === "Enter", h = b.bottom - b.top + 1, w = b.right - b.left + 1;
				const current = vertical ? (x-b.left)*h + pos-b.top : (pos-b.top)*w + x-b.left;
				const index = (current + (event.shiftKey ? -1 : 1) + h*w) % (h*w);
				const y = b.top + (vertical ? index % h : Math.floor(index/w));
				const nextX = b.left + (vertical ? Math.floor(index/h) : index % w);
				move(visibleRows[y], visibleColumns[nextX], true, false, { ...anchor, extent: anchor.extent || { row,col } }); return;
			}
			if (event.key === "Tab" && !editor && ((event.shiftKey && pos === 0 && x === 0) ||
				(!event.shiftKey && pos === visibleRows.length - 1 && x === width - 1))) return;
			event.preventDefault();
			if (event.key === "Enter") move(at(pos + (event.shiftKey ? -1 : 1)), col);
			else {
				const index = Math.max(0, Math.min(visibleRows.length * width - 1, pos * width + x + (event.shiftKey ? -1 : 1)));
				move(at(Math.floor(index / width)), visibleColumns[index % width]);
			}
		} else if (!editor) {
			const deltas = { ArrowLeft: [0,-1], ArrowRight: [0,1], ArrowUp: [-1,0], ArrowDown: [1,0] };
			const delta = deltas[event.key];
			if (delta) { event.preventDefault(); move(at(pos + delta[0]), visibleColumns[x + delta[1]] ?? col, true, event.shiftKey); }
			else if (["Delete", "Backspace"].includes(event.key)) {
				event.preventDefault();
				clearSelection();
			} else if (event.key === "F2" || event.key.length === 1) {
				event.preventDefault(); edit(event.key === "F2" ? undefined : event.key);
			}
		}
	}
	grid.addEventListener("keydown", keys); bar.addEventListener("keydown", keys);
	function pinCell(cell, c) {
		if (pinned.has(sheet.columns[c])) {
			cell.dataset.pinned = ""; cell.style.left = "var(--pin-" + c + ")";
		}
	}
	function sizeColumns() {
		const group = grid.querySelector("colgroup"), count = visibleColumns.length;
		const gutter = 52;
		const defaultWidth = Math.max(154, Math.floor((scroller.clientWidth - gutter) / Math.max(1, count)));
		const sizes = [gutter, ...visibleColumns.map(c => widths.get(sheet.columns[c]) ?? defaultWidth)];
		if (group.children.length !== sizes.length) group.replaceChildren(...sizes.map(() => document.createElement("col")));
		let left = gutter;
		sizes.forEach((size, i) => {
			group.children[i].style.width = size + "px";
			const c = visibleColumns[i - 1];
			if (i && pinned.has(sheet.columns[c])) { grid.style.setProperty("--pin-" + c, left + "px"); left += size; }
		});
		scroller.style.scrollPaddingInlineStart = Math.min(left, scroller.clientWidth * 0.75) + "px";
		grid.style.width = sizes.reduce((sum, n) => sum + n, 0) + "px";
	}
	function fitColumn(c) {
		const measure = document.createElement("canvas").getContext("2d");
		measure.font = getComputedStyle(grid).font;
		let width = measure.measureText(sheet.columns[c].name).width + 62;
		for (const cells of values()) {
			for (const line of displayValue(cells[c]).split(/\r\n|[\r\n]/)) width = Math.max(width, measure.measureText(line).width + 26);
		}
		widths.set(sheet.columns[c], Math.max(88, Math.ceil(width))); sizeColumns();
	}
	let resize, rangePointer;
	grid.addEventListener("pointerdown", event => {
		if (event.button !== 0 || !event.isPrimary) return;
		const grip = event.target.closest(".resize-column");
		if (grip) {
			const th = grip.parentElement;
			resize = { column: sheet.columns[Number(th.dataset.c)], x: event.clientX, width: th.offsetWidth, id: event.pointerId };
			grip.setPointerCapture(event.pointerId); event.preventDefault(); return;
		}
		const td = event.target.closest("td");
		const editor = referenceEditor(td,event);
		if (editor && !event.target.closest("button, textarea")) {
			referencePicker.start(editor,td,event); return;
		}
		if (td && !event.target.closest("button") && event.pointerType === "mouse" && !event.target.closest("textarea") && commit()) {
			move(Number(td.dataset.r), Number(td.dataset.c), true, event.shiftKey);
			rangePointer = event.pointerId; event.preventDefault();
		}
	});
	grid.addEventListener("pointermove", event => {
		if (resize?.id === event.pointerId) {
			widths.set(resize.column, Math.max(88, resize.width + event.clientX - resize.x)); sizeColumns(); return;
		}
		if (rangePointer !== event.pointerId || !event.buttons) return;
		const td = event.target.closest("td");
		if (td && (Number(td.dataset.r) !== row || Number(td.dataset.c) !== col)) move(Number(td.dataset.r), Number(td.dataset.c), true, true);
	});
	function endSelection() { rangePointer = undefined; resize = null; }
	window.addEventListener("pointerup", endSelection);
	window.addEventListener("pointercancel", endSelection);
	window.addEventListener("blur", endSelection);
	grid.addEventListener("dblclick", event => {
		const grip = event.target.closest(".resize-column");
		if (grip) fitColumn(Number(grip.parentElement.dataset.c));
	});
	new ResizeObserver(() => sizeColumns()).observe(scroller);

	function applyView() {
		anchor = null; viewRevision = undefined;
		rebuildView(); row = visibleRows[0] ?? 0; render(true);
	}
	const valueList = tableValueList($);
	const openSort = tableSortDialog($,show,levels => {
		sortLevels = levels.map(({column,order}) => ({column:sheet.columns[column],order}));
		applyView();
	});
	$("custom-sort").onclick = () => {
		if (!commit() || !sheet.columns.length) return;
		const names = sheet.columns.map((column,c) => column.name && column.name !== letters(c) ? letters(c) + " · " + column.name : letters(c));
		openSort(names,sortLevels.map(({column,order}) => ({column:sheet.columns.indexOf(column),order})),col);
	};
	function filterOptions(column,c) {
		const entries = new Map(), include = rowFilter(column);
		values().forEach((cells,r) => {
			if (!include(cells,r)) return;
			const value = cells[c], key = tableOperations.filterKey(value);
			if (!entries.has(key)) entries.set(key,{key,label:key === "" ? "(Blanks)" : displayValue(value),kind:tableFormats.kind(value)});
		});
		const labels = new Set(), repeated = new Set();
		for (const {label} of entries.values()) {
			if (labels.has(label)) repeated.add(label);
			labels.add(label);
		}
		for (const item of entries.values()) {
			if (item.key && repeated.has(item.label)) item.label += " (" + item.kind + ")";
		}
		return [...entries.values()].sort((a,b) => collator.compare(a.label,b.label));
	}
	grid.addEventListener("click", event => {
		const button = event.target.closest(".column-menu");
		if (!button || !commit()) return;
		col = Number(button.parentElement.dataset.c); anchor = null; selection();
		const column = sheet.columns[col], filter = filters.get(column);
		$("options-title").textContent = column.name || "Column " + letters(col);
		valueList.open(filterOptions(column,col),filter);
		$("sort-order").value = sortLevels.find(level => level.column === column)?.order || "";
		$("menu-rename").disabled = $("rename-column").disabled;
		$("menu-delete").disabled = $("remove-column").disabled;
		const stats = columnProfile(col);
		$("column-profile").textContent = sheet.rows.length + " rows · " + stats.empty + " empty · " +
			stats.distinct + " distinct nonempty values · " + stats.repeated + " repeated values in " + stats.duplicates.size + " rows";
		$("show-duplicates").disabled = !stats.duplicates.size;
		$("hide-column").disabled = visibleColumns.length <= 1;
		$("pin-column").textContent = pinned.has(column) ? "Unpin column" : "Pin left";
		show($("column-options"));
	});
	$("options-form").onsubmit = event => {
		event.preventDefault();
		const column = sheet.columns[col], filter = valueList.read(), order = $("sort-order").value;
		if (filter) filters.set(column,filter); else filters.delete(column);
		const index = sortLevels.findIndex(level => level.column === column);
		if (index >= 0) sortLevels.splice(index,1,...(order ? [{column,order}] : []));
		else if (order) sortLevels.push({column,order});
		$("column-options").close(); applyView();
	};
	$("show-duplicates").onclick = () => {
		$("filter-mode").value = "duplicates"; $("options-form").requestSubmit();
	};
	$("pin-column").onclick = () => {
		const column = sheet.columns[col];
		if (!pinned.delete(column)) pinned.add(column);
		$("column-options").close(); render(true);
	};
	$("hide-column").onclick = () => {
		hidden.add(sheet.columns[col]); $("column-options").close(); render(true);
	};
	$("manage-columns").onclick = () => {
		if (!commit()) return;
		const body = $("layout-columns").tBodies[0]; body.replaceChildren();
		for (const [c, column] of sheet.columns.entries()) {
			const tr = body.insertRow(), name = column.name || letters(c);
			tr.insertCell().textContent = letters(c) + " · " + name;
			for (const [label, checked] of [["Visible", !hidden.has(column)], ["Pinned", pinned.has(column)]]) {
				const box = document.createElement("input"); box.type = "checkbox"; box.checked = checked;
				box.setAttribute("aria-label", label + " " + name); tr.insertCell().append(box);
			}
		}
		show($("columns-dialog"));
	};
	$("layout-form").onsubmit = event => {
		event.preventDefault();
		const rows = [...$("layout-columns").tBodies[0].rows];
		if (rows.length && !rows.some(tr => tr.querySelector("input").checked)) { status("Keep at least one column visible.", true); return; }
		rows.forEach((tr, c) => {
			const [visible, pin] = tr.querySelectorAll("input"), column = sheet.columns[c];
			if (visible.checked) hidden.delete(column); else hidden.add(column);
			if (pin.checked) pinned.add(column); else pinned.delete(column);
		});
		anchor = null; $("columns-dialog").close(); render(true);
	};
	$("fit-width").onclick = () => { fitColumn(col); $("column-options").close(); };
	$("menu-rename").onclick = () => { $("column-options").close(); columnDialog("rename"); };
	$("menu-delete").onclick = () => { $("column-options").close(); $("remove-column").click(); };
	$("maximize").onclick = () => {
		const expanded = document.body.classList.toggle("maximized");
		$("site-menu").inert = expanded;
		$("maximize").setAttribute("aria-pressed", expanded);
		$("maximize").textContent = expanded ? "Restore view" : "Maximize";
	};
	document.addEventListener("keydown", event => {
		if (event.key === "Escape" && document.body.classList.contains("maximized") && !event.defaultPrevented &&
			!document.querySelector("dialog[open]")) $("maximize").click();
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && !document.querySelector("dialog[open]")) {
			event.preventDefault();
			if (commit()) { activateTab($("tab-data")); $("find-value").focus(); $("find-value").select(); }
		}
	});

	let bulkMode, bulkPlan, previewPage = 0;
	function openBulk(mode) {
		if (!commit()) return;
		bulkMode = mode;
		$("column-options").close();
		const titles = { replace: "Find and replace", fill: "Fill selection", convert: "Convert column type" };
		$("bulk-title").textContent = titles[mode];
		$("replace-fields").hidden = mode !== "replace";
		$("value-field").hidden = mode === "convert";
		$("convert-fields").hidden = mode !== "convert";
		$("bulk-value-label").textContent = mode === "fill" ? "Fill with" : "Replace with";
		$("bulk-value").value = "";
		$("bulk-scope").value = anchor ? "selection" : "table";
		$("bulk-find").value = $("find-value").value;
		$("convert-type").value = "number"; $("decimal-separator").value = ".";
		$("preview-filter").value = "all";
		show($("bulk-dialog")); previewBulk();
		$(mode === "convert" ? "convert-type" : mode === "replace" ? "bulk-find" : "bulk-value").focus();
	}
	$("replace-values").onclick = () => openBulk("replace");
	$("fill-selection").onclick = () => openBulk("fill");
	$("convert-column").onclick = () => openBulk("convert");
	function previewBulk() {
		const converting = bulkMode === "convert", replacing = bulkMode === "replace";
		const scope = converting ? "column" : replacing ? $("bulk-scope").value : "selection";
		const { top, bottom, left, right } = rangeBounds();
		const scopedRows = scope === "selection" ? visibleRows.slice(top, bottom + 1) : sheet.rows.keys();
		const scopedColumns = scope === "column" ? [col] : scope === "selection" ? visibleColumns.slice(left, right + 1) : sheet.columns.map((_, c) => c);
		const target = $("convert-type").value, separator = $("decimal-separator").value;
		$("decimal-separator").disabled = target !== "number" && target !== "integer";
		const field = converting ? tableOperations.field(sheet.columns[col].name, target) : null;
		if (field && sheet.columns[col].field?.element.repetition_type === "REQUIRED") field.element.repetition_type = "REQUIRED";
		const originalField = sheet.columns[col]?.field;
		const schemaChange = converting && JSON.stringify(field) !== JSON.stringify(originalField);
		const find = $("bulk-find").value;
		const pattern = replacing && find ? new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : null;
		const replacement = $("bulk-value").value, entries = [];
		let errors = 0, warnings = 0, scanned = 0;
		for (const r of scopedRows) {
			if (replacing && !pattern) break;
			for (const c of scopedColumns) {
				const before = sheet.rows[r][c], text = inputText(before);
				let after, error, warning = false;
				scanned++;
				try {
					if (converting) {
						after = tableOperations.convert(before instanceof Formula ? calculate(sheet,r,c) : before, target, separator);
						tableParquet.validate(field, after);
						warning = typeof before === "string" && ["number", "integer"].includes(target) && /^[+-]?0\d/.test(before.trim());
					} else if (replacing) {
						if (before == null) continue;
						const result = text.replace(pattern, () => replacement);
						if (result === text) continue;
						after = before instanceof Formula ? editValue("auto",result,sheet.columns[c].field) : pastedValue([tableFormats.kind(before), result], sheet.columns[c].field, before);
					} else {
						const text = replacement.startsWith("=") ? tableCalc.offset(replacement,r-row,c-col) : replacement;
						after = pastedValue([null, text], sheet.columns[c].field, before);
						if (after instanceof Date) after = replacement;
					}
				} catch (failure) { error = failure.message; errors++; }
				if (warning) warnings++;
				const changed = !error && tableFormats.json(after) !== tableFormats.json(before);
				if (error || changed || schemaChange) entries.push({ r, c, before, after, error, warning, changed, length: sheet.rows[r].length });
			}
		}
		bulkPlan = { entries, field, schemaChange, errors };
		const changedCells = entries.reduce((count, entry) => count + Number(entry.changed), 0);
		const context = converting ? "Column " + letters(col) + " · " + target + ". " :
			scope === "selection" ? "Selection (" + scanned + " cells). " : scope === "column" ? "Entire column " + letters(col) + ". " : "Entire table. ";
		const summary = [changedCells + (changedCells === 1 ? " cell will change" : " cells will change"), errors + (errors === 1 ? " error" : " errors")];
		if (schemaChange) summary.push("new column type: " + tableParquet.label(field));
		if (warnings) summary.push("leading zeros removed in " + warnings + (warnings === 1 ? " cell" : " cells"));
		$("bulk-summary").textContent = context + summary.join(" · ") + ".";
		if (converting && sheet.format === "csv") $("bulk-summary").textContent += " CSV stores text on disk. JSONL and Parquet retain typed values.";
		$("bulk-apply").disabled = !!errors || (!changedCells && !schemaChange);
		previewPage = 0; drawPreview();
	}
	function previewValue(value, field) {
		if (value instanceof Formula) return value.expression;
		const kind = tableFormats.kind(value);
		if (kind === "missing" || kind === "null") return kind;
		return (field ? tableParquet.label(field) : kind) + " · " + tableFormats.textValue(value);
	}
	function drawPreview() {
		const filter = $("preview-filter").value, entries = bulkPlan.entries;
		const shown = filter === "all" ? entries : entries.filter(item => filter === "errors" ? item.error : item.warning);
		const start = previewPage * 6, end = Math.min(start + 6, shown.length);
		const tbody = $("bulk-preview").tBodies[0]; tbody.replaceChildren();
		for (const item of shown.slice(start, end)) {
			const tr = tbody.insertRow();
			tr.insertCell().textContent = address(item.r, item.c);
			tr.insertCell().textContent = previewValue(item.before, sheet.columns[item.c].field);
			tr.insertCell().textContent = item.error || previewValue(item.after, bulkPlan.field || sheet.columns[item.c].field) + (item.warning ? " · leading zeros removed" : "");
			tr.toggleAttribute("data-error", !!item.error);
		}
		$("preview-range").textContent = shown.length ? (start + 1) + "–" + end + " of " + shown.length : "0";
		$("preview-back").disabled = start === 0; $("preview-forward").disabled = end === shown.length;
	}
	$("preview-back").onclick = () => { previewPage--; drawPreview(); };
	$("preview-forward").onclick = () => { previewPage++; drawPreview(); };
	$("preview-filter").onchange = () => { previewPage = 0; drawPreview(); };
	for (const id of ["bulk-value", "bulk-find"]) $(id).oninput = previewBulk;
	for (const id of ["bulk-scope", "convert-type", "decimal-separator"]) $(id).onchange = previewBulk;
	$("bulk-dialog").addEventListener("close", () => { if (!$("bulk-dialog").open) bulkPlan = null; });
	$("bulk-form").onsubmit = event => {
		event.preventDefault();
		if ($("bulk-apply").disabled || !bulkPlan || bulkPlan.errors) return;
		const { field, schemaChange } = bulkPlan, column = sheet.columns[col], originalField = column?.field;
		const entries = bulkPlan.entries.filter(entry => entry.changed);
		change(() => {
			if (schemaChange) column.field = field;
			for (const { r, c, after } of entries) sheet.rows[r][c] = after;
		}, () => {
			if (schemaChange) {
				if (originalField) column.field = originalField; else delete column.field;
			}
			for (const { r, c, before, length } of entries) {
				sheet.rows[r][c] = before; sheet.rows[r].length = length;
			}
		});
		$("bulk-dialog").close(); render(true);
		status((schemaChange ? "Column type updated. " : "") + entries.length + " cells changed.");
	};

	const clipboardType = "application/x-susi-table-cells";
	const clipboardToken = "application/x-susi-table-copy";
	function styleAt(cells, column) { return styles.get(cells)?.get(column); }
	function putStyle(cells, column, style) {
		let map = styles.get(cells);
		if (style && Object.keys(style).length) {
			if (!map) styles.set(cells, map = new Map());
			map.set(column, style);
		} else if (map) {
			map.delete(column); if (!map.size) styles.delete(cells);
		}
	}
	function formatRange(update) {
		if (!commit()) return;
		const { rows, cols } = selectedRange(), edits = [], remembered = anchor;
		for (const r of rows) for (const c of cols) {
			const cells = sheet.rows[r], column = sheet.columns[c], before = styleAt(cells, column);
			const next = update({ ...before });
			if (JSON.stringify(before || {}) !== JSON.stringify(next)) edits.push({ cells, column, before, next });
		}
		if (!edits.length) return;
		change(() => edits.forEach(e => putStyle(e.cells, e.column, e.next)), () => edits.forEach(e => putStyle(e.cells, e.column, e.before)), true);
		anchor = remembered; render(true);
	}
	$("cell-condition").onchange = event => { const condition = event.target.value; formatRange(s => { if (condition) s.condition = condition; else delete s.condition; return s; }); };
	$("number-format").onchange = event => { const format = event.target.value; formatRange(s => ({ ...s, format })); };
	$("cell-align").onchange = event => { const align = event.target.value; formatRange(s => ({ ...s, align })); };
	$("wrap-cells").onclick = () => {
		const wrap = $("wrap-cells").getAttribute("aria-pressed") !== "true";
		formatRange(s => ({ ...s, wrap }));
	};
	$("cell-color").onchange = event => { const color = event.target.value; formatRange(s => ({ ...s, color })); };
	$("no-fill").onclick = () => formatRange(s => { delete s.color; return s; });
	function decimals(delta) {
		formatRange(s => ({ ...s, format: !s.format || s.format === "general" ? "number" : s.format,
			digits: Math.min(20, Math.max(0, (s.digits ?? 2) + delta)) }));
	}
	$("more-decimals").onclick = () => decimals(1); $("less-decimals").onclick = () => decimals(-1);

	function captureBlock(cut) {
		const { rows, cols } = selectedRange();
		const block = rows.map(r => cols.map(c => {
			const v = sheet.rows[r][c];
			const result = calculate(sheet,r,c);
			const entry = [tableFormats.kind(result), tableFormats.textValue(result), styleAt(sheet.rows[r], sheet.columns[c]) || null];
			if (v instanceof Formula) entry.push(v.expression,r,c);
			return entry;
		}));
		const text = block.map(line => line.map(([, value]) =>
			!value || /["\t\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value
		).join("\t")).join("\r\n");
		const indices = array => new Map(array.map((v, i) => [v, i]));
		clipboard = { sheet, rows, cols, block, text, cut, marked: true, token: [...crypto.getRandomValues(new Uint32Array(4))].join("-"),
			rowPositions: indices(rows), colPositions: indices(cols), bounds: { top: 0, left: 0, bottom: rows.length - 1, right: cols.length - 1 } };
		paintSelection(rangeBounds()); return clipboard;
	}
	for (const action of ["copy", "cut"]) grid.addEventListener(action, event => {
		if (event.target.tagName !== "TD" || !event.clipboardData) return;
		const clip = captureBlock(action === "cut");
		if (clip.cut && !cutSource(clip)) { event.preventDefault(); return; }
		event.clipboardData.setData("text/plain", clip.text);
		event.clipboardData.setData(clipboardType, JSON.stringify(clip.block));
		event.clipboardData.setData(clipboardToken, clip.token); event.preventDefault();
	});
	function clearedValue(c) {
		const field = sheet.columns[c].field;
		if (field) tableParquet.validate(field, null);
		return sheet.format === "csv" && !field ? "" : sheet.format === "xlsx" ? undefined : null;
	}
	function cellEdit(cells, column, c, value, style = styleAt(cells, column)) {
		if (value instanceof Date) {
			value = tableWorkbook.serial(value);
			style = {...style,format:"date"};
		}
		return { cells, column, c, value, style, before: cells[c], previousStyle: styleAt(cells, column), width: cells.length };
	}
	function applyCells(edits, newRows = [], newCols = []) {
		const nr = sheet.rows.length, nc = sheet.columns.length;
		change(() => {
			for (const column of newCols) sheet.columns.push(column);
			for (const cells of newRows) sheet.rows.push(cells);
			for (const e of edits) { e.cells[e.c] = e.value; putStyle(e.cells, e.column, e.style); }
		}, () => {
			for (const e of edits) { e.cells[e.c] = e.before; e.cells.length = e.width; putStyle(e.cells, e.column, e.previousStyle); }
			sheet.rows.length = nr; sheet.columns.length = nc;
		});
	}
	function cutSource(clip) {
		const edits = [], keep = anchor;
		try {
			for (const r of clip.rows) for (const c of clip.cols) {
				const cells = sheet.rows[r], column = sheet.columns[c];
				if ((cells[c] == null || cells[c] === "") && !styleAt(cells,column)) continue;
				try { edits.push(cellEdit(cells,column,c,clearedValue(c),null)); }
				catch (error) { throw new Error(address(r,c) + " · " + error.message); }
			}
		} catch (error) { clipboard = null; selection(true); status(error.message,true); return false; }
		if (edits.length) {
			applyCells(edits); clip.cutEntry = past.at(-1); clip.marked = true; anchor = keep; render(true);
		}
		return true;
	}
	function enterRangeValue() {
		const { rows, cols } = selectedRange(), edits = [], keep = anchor;
		try {
			for (const r of rows) for (const c of cols) {
				const cells = sheet.rows[r], column = sheet.columns[c];
				try {
					const text = bar.value.startsWith("=") ? tableCalc.offset(bar.value,r-row,c-col) : bar.value;
					const v = column.field ? pastedValue([type.value,text],column.field,cells[c]) : editValue(type.value,text,column.field);
					edits.push(cellEdit(cells,column,c,v));
				}
				catch (err) { throw new Error(address(r,c) + " · " + err.message); }
			}
		} catch (err) { showCellError(err.message,inline || bar); return; }
		draft = false; applyCells(edits); anchor = keep; render(true);
	}
	function clearSelection() {
		if (!commit()) return;
		const { rows, cols } = selectedRange(), edits = [], remembered = anchor;
		try {
			for (const r of rows) for (const c of cols) {
				const cells = sheet.rows[r];
				if (cells[c] == null || cells[c] === "") continue;
				let value;
				try { value = clearedValue(c); } catch (error) { throw new Error(address(r,c) + " · " + error.message); }
				edits.push(cellEdit(cells, sheet.columns[c], c, value));
			}
		} catch (error) { status(error.message, true); return; }
		if (edits.length) { applyCells(edits); anchor = remembered; render(true); status("Cleared " + edits.length + " cells."); }
	}
	function pastedValue(entry, field, before, r, c, mode = "paste", moving = false) {
		const [kind, text] = entry;
		if (!field && ["csv","xlsx"].includes(sheet.format)) {
			if (mode !== "values" && typeof entry[3] === "string" && entry[3].startsWith("=") && Number.isSafeInteger(entry[4]) && Number.isSafeInteger(entry[5]))
				return new Formula(moving ? entry[3] : tableCalc.offset(entry[3],r-entry[4],c-entry[5]));
			if (!kind && mode !== "values" && text.startsWith("=")) return new Formula(text);
			if (sheet.format === "xlsx") {
				if (mode === "values" && text.startsWith("=")) return text;
				if (!kind || kind === "auto") return editValue("auto",text,field);
				return tableFormats.parseCell(kind,text);
			}
			return text;
		}
		let target = kind;
		if (field) {
			target = tableParquet.kind(field);
			if (target === "number" && ["NaN", "Infinity", "-Infinity"].includes(text)) target = "text";
			if (target === "text" && kind === "number" && tableParquet.fieldType(field.element) === "DATE") target = "number";
			if (kind === "null" || kind === "missing" || (!kind && !text && target !== "text")) target = "null";
		} else if (!target) {
			target = before == null ? "text" : tableFormats.kind(before);
		}
		if (target === "missing" && sheet.values) target = "null";
		const value = tableFormats.parseCell(target, text);
		if (field) tableParquet.validate(field, value);
		return value;
	}
	function blankRow() {
		return sheet.columns.map(column => column.field || sheet.values ? null : sheet.format === "csv" ? "" : undefined);
	}
	function pasteBlock(block, mode = "paste", cut = null) {
		if (!block.length || !commit()) return;
		if (!Array.isArray(block) || !block.every(line => Array.isArray(line) && line.every(entry =>
			Array.isArray(entry) && typeof entry[1] === "string" && [null,"text","number","boolean","null","missing","json"].includes(entry[0]))))
			throw new Error("The clipboard contains an invalid cell block.");
		const { top, left, bottom, right } = rangeBounds();
		let width = block.reduce((n, line) => Math.max(n, line.length), 0);
		if (!width) return;
		if (mode === "transpose") {
			block = Array.from({ length: width }, (_, i) => block.map(line => line[i] || ["text", ""]));
			width = block[0].length;
		}
		let height = block.length, destinationWidth = width;
		if (anchor && (bottom > top || right > left)) {
			const h = bottom - top + 1, w = right - left + 1;
			if (h % height || w % width) throw new Error("Select one destination cell or a range that fits the copied block.");
			height = h; destinationWidth = w;
		}
		const targets = visibleColumns.slice(left, left + destinationWidth), newCols = [], newRows = [], edits = [];
		if ((sheet.format === "parquet" || sheet.values) && targets.length < destinationWidth) throw new Error("The pasted range exceeds this schema.");
		if ((sortLevels.length || filters.size) && top + height > visibleRows.length) throw new Error("Clear filters and sort to paste beyond the visible rows.");
		const names = new Set(sheet.columns.map(v => v.name));
		let n = sheet.columns.length + 1;
		while (targets.length < destinationWidth) {
			while (names.has("Column " + n)) n++;
			const column = { name: "Column " + n++ }; names.add(column.name);
			targets.push(sheet.columns.length + newCols.length); newCols.push(column);
		}
		for (let y = 0; y < height; y++) {
			const r = visibleRows[top + y] ?? sheet.rows.length + newRows.length;
			const cells = sheet.rows[r] || blankRow();
			if (r >= sheet.rows.length) newRows.push(cells);
			for (let x = 0; x < destinationWidth; x++) {
				const entry = block[y % block.length][x % width]; if (!entry) continue;
				const c = targets[x], column = sheet.columns[c] || newCols[c - sheet.columns.length];
				let value;
				try { value = pastedValue(entry, column.field, cells[c], r, c, mode, cut?.cut); }
				catch (error) { if (positions.has(r) && sheet.columns[c]) move(r,c); throw new Error(address(r,c) + " · " + error.message); }
				const style = mode === "values" || entry.length < 3 ? styleAt(cells,column) : cleanStyle(entry[2]);
				edits.push(cellEdit(cells, column, c, value, style || null));
			}
		}
		const cutEntry = cut?.cutEntry;
		const joinCut = cutEntry && cut.marked && past.at(-1) === cutEntry && revision !== saved;
		applyCells(edits, newRows, newCols);
		if (joinCut) {
			const paste = past.pop();
			past.pop();
			past.push({ ...paste, before: cutEntry.before, beforeData: cutEntry.beforeData,
				apply() { activate(cutEntry.owner); cutEntry.apply(); activate(paste.owner); paste.apply(); },
					revert() { activate(paste.owner); paste.revert(); activate(cutEntry.owner); cutEntry.revert(); } });
		}
		render(true); status("Pasted " + height + " × " + destinationWidth + " cells.");
	}
	function plainBlock(text) {
		return (text ? tableFormats.parseTSV(text) : [[""]]).map(line => line.map(value => [null, value]));
	}
	grid.addEventListener("paste", event => {
		if (event.target.tagName !== "TD" || !event.clipboardData) return;
		event.preventDefault();
		try {
			const typed = event.clipboardData.getData(clipboardType), token = event.clipboardData.getData(clipboardToken);
			const mode = pendingPaste || "paste"; pendingPaste = null;
			pasteBlock(typed ? JSON.parse(typed) : plainBlock(event.clipboardData.getData("text/plain")), mode,
				token && token === clipboard?.token ? clipboard : null);
		} catch (error) { showCellError(error.message); }
	});
	function styleRecords() {
		if (!styles.size) return [];
		const columns = new Map(sheet.columns.map((column,c) => [column,c])), records = [];
		sheet.rows.forEach((cells,r) => {
			for (const [column,style] of styles.get(cells) || []) {
				if (columns.has(column)) records.push([r,columns.get(column),style]);
			}
		});
		return records;
	}
	function restoreStyles(records) {
		styles = new Map();
		for (const [r,c,style] of records) if (sheet.rows[r] && sheet.columns[c]) putStyle(sheet.rows[r],sheet.columns[c],cleanStyle(style));
	}
	function formatStorageKey(file) {
		return "susi.table.formats." + (file.path ? "workspace:" + file.path : "local:" + file.name);
	}
	async function signature(bytes, csv) {
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return Array.from(digest, n => n.toString(16).padStart(2,"0")).join("") + JSON.stringify(csv || {});
	}
	async function loadStyles(file, bytes, csv) {
		try {
			const raw = localStorage.getItem(formatStorageKey(file));
			if (!raw) return [];
			const savedStyles = JSON.parse(raw);
			if (savedStyles.signature === await signature(bytes,csv) && Array.isArray(savedStyles.records)) return savedStyles.records;
		} catch { /* Data files remain usable when browser storage is unavailable. */ }
		return [];
	}
	async function storeStyles(file, bytes, csv) {
		const records = styleRecords(), key = formatStorageKey(file);
		try {
			if (records.length) localStorage.setItem(key, JSON.stringify({ signature: await signature(bytes,csv), records }));
			else localStorage.removeItem(key);
			return "";
		} catch { return " Browser storage could not save cell formatting."; }
	}

	function cleanStyle(value) {
		if (!value || typeof value !== "object") return null;
		const s = {};
		if (["general","number","percent","currency","date"].includes(value.format)) s.format = value.format;
		if (["negative","positive","zero"].includes(value.condition)) s.condition = value.condition;
		if (Number.isInteger(value.digits) && value.digits >= 0 && value.digits <= 20) s.digits = value.digits;
		if (["left","center","right"].includes(value.align)) s.align = value.align;
		if (typeof value.wrap === "boolean") s.wrap = value.wrap;
		if (/^#[a-f\d]{6}$/i.test(value.color)) s.color = value.color;
		return s;
	}
	function insertRows(above) {
		if (!commit()) return;
		const selected = selectedRange().rows;
		const index = selected.length ? (above ? selected[0] : selected.at(-1) + 1) : sheet.rows.length;
		const added = Array.from({ length: Math.max(1, selected.length) }, blankRow);
		layoutChange("row", () => { for (let i = 0; i < added.length; i++) sheet.rows.splice(index + i, 0, added[i]); },
			() => sheet.rows.splice(index, added.length));
		row = index; rebuildView(); if (!positions.has(row)) reveal(row,col,true); else render(true);
	}
	function deleteRows() {
		if (!commit()) return;
		const items = selectedRange().rows.sort((a,b) => a-b).map(r => [r, sheet.rows[r]]);
		if (!items.length) return;
		layoutChange("row", () => { for (let i = items.length - 1; i >= 0; i--) sheet.rows.splice(items[i][0],1); },
			() => { for (const [r,cells] of items) sheet.rows.splice(r,0,cells); });
		render(true); status("Deleted " + items.length + " rows.");
	}
	function deleteColumns() {
		if (!commit() || sheet.values) return;
		const indices = selectedRange().cols.sort((a,b) => a-b);
		if (!indices.length || indices.length === sheet.columns.length) { status("Keep at least one column.", true); return; }
		const columns = indices.map(c => sheet.columns[c]);
		const originals = sheet.rows.map(cells => ({ width: cells.length, values: indices.map(c => cells[c]) }));
		layoutChange("column", () => {
			for (let i = indices.length - 1; i >= 0; i--) {
				sheet.columns.splice(indices[i],1); for (const cells of sheet.rows) cells.splice(indices[i],1);
			}
		}, () => {
			indices.forEach((c,i) => {
				sheet.columns.splice(c,0,columns[i]);
				sheet.rows.forEach((cells,r) => { if (c < originals[r].width) cells.splice(c,0,originals[r].values[i]); });
			});
		});
		render(true); status("Deleted " + indices.length + " columns.");
	}
	const contextMenu = $("cell-menu");
	function hideMenu() { contextMenu.hidden = true; }
	function openMenu(event) {
		const target = event.target.closest("td,th");
		if (!target || event.target.closest("textarea") || !commit()) return;
		event.preventDefault();
		const b = rangeBounds(), r = Number(target.dataset.r), c = Number(target.dataset.c);
		const y = positions.get(r), x = visibleColumns.indexOf(c);
		if (target.matches("td")) {
			if (!(y >= b.top && y <= b.bottom && x >= b.left && x <= b.right)) move(r,c);
		} else if (!(anchor?.mode === "rows" && y >= b.top && y <= b.bottom) &&
			!(anchor?.mode === "columns" && x >= b.left && x <= b.right)) chooseHeader(target);
		const columnHeader = target.matches("th[data-c]"), rowHeader = target.matches("th[data-r]");
		for (const button of contextMenu.children) {
			const action = button.dataset.command;
			button.hidden = action === "delete-columns" ? !columnHeader : ["insert-rows","delete-rows"].includes(action) && !rowHeader;
			button.disabled = action === "delete-columns" ? !!sheet.values || selectedRange().cols.length >= sheet.columns.length : !visibleRows.length && action !== "insert-rows";
		}
		contextMenu.hidden = false;
		contextMenu.style.left = Math.max(0, Math.min(event.clientX, innerWidth - contextMenu.offsetWidth)) + "px";
		contextMenu.style.top = Math.max(0, Math.min(event.clientY, innerHeight - contextMenu.offsetHeight)) + "px";
		contextMenu.querySelector("button:not([hidden]):enabled")?.focus();
	}
	grid.addEventListener("contextmenu", openMenu);
	grid.addEventListener("keydown", event => {
		if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && event.target.matches("td")) {
			event.preventDefault();
			const rect = event.target.getBoundingClientRect();
			event.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 }));
		}
	});
	document.addEventListener("pointerdown", e => { if (!contextMenu.contains(e.target)) hideMenu(); });
	window.addEventListener("blur", hideMenu);
	contextMenu.onkeydown = event => {
		const buttons = [...contextMenu.querySelectorAll("button:not([hidden]):enabled")], i = buttons.indexOf(event.target);
		if (event.key === "Escape" || event.key === "Tab") { hideMenu(); grid.querySelector("[data-selected]")?.focus(); }
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault(); buttons[(i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
		}
	};
	async function clipboardCommand(action) {
		if (!visibleRows.length || !visibleColumns.length || !commit()) return;
		if (["cut","copy"].includes(action)) {
			grid.querySelector("[data-selected]")?.focus();
			if (!document.execCommand(action)) {
				const clip = captureBlock(action === "cut");
				if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(clip.text);
				if (clip.cut && clip.sheet === sheet && clip.marked) cutSource(clip);
			}
			return;
		}
		let clip = clipboard, block = clip?.block;
		const originalSheet = sheet, originalRevision = revision, destination = selectionAddress();
		try {
			const text = await navigator.clipboard.readText();
			if (!clip || text !== clip.text) { clip = null; block = plainBlock(text); }
		} catch {
			if (!clip) {
				pendingPaste = action; grid.querySelector("[data-selected]")?.focus();
				status("Press Ctrl+V or Command+V to " + (action === "transpose" ? "paste transposed." : action === "values" ? "paste values only." : "paste.")); return;
			}
		}
		if (sheet !== originalSheet || originalRevision !== revision || destination !== selectionAddress()) return;
		pasteBlock(block, action, clip);
	}
	for (const button of document.querySelectorAll("[data-command]")) button.onclick = () => {
		hideMenu();
		const action = button.dataset.command;
		if (action === "insert-rows") insertRows(true);
		else if (action === "delete-rows") deleteRows();
		else if (action === "delete-columns") deleteColumns();
		else if (action === "clear") clearSelection();
		else clipboardCommand(action).catch(error => status(error.message, true));
	};

	function fillDestination(x, y) {
		const { bounds } = fillDrag;
		const hit = document.elementFromPoint(x,y)?.closest("td,th");
		let pos, column;
		if (hit && grid.contains(hit)) { pos = positions.get(Number(hit.dataset.r)); column = visibleColumns.indexOf(Number(hit.dataset.c)); }
		const last = grid.tBodies[0].lastElementChild, box = scroller.getBoundingClientRect();
		if (pos === undefined && last && y >= last.getBoundingClientRect().bottom && y <= box.bottom &&
			x >= box.left && x < box.right && !sortLevels.length && !filters.size && (page + 1) * pageSize >= visibleRows.length) {
			const rect = last.getBoundingClientRect();
			pos = visibleRows.length + Math.floor((y - rect.bottom) / rect.height);
			column = bounds.right;
		}
		if (pos === undefined || column < 0 || column === undefined) return null;
		const dx = column < bounds.left ? column - bounds.left : Math.max(0,column - bounds.right);
		const dy = pos < bounds.top ? pos - bounds.top : Math.max(0,pos - bounds.bottom);
		if (!dx && !dy) return null;
		const vertical = Math.abs(dy) >= Math.abs(dx);
		if (vertical) return { vertical, top: dy < 0 ? pos : bounds.bottom + 1, bottom: dy < 0 ? bounds.top - 1 : pos, left: bounds.left, right: bounds.right, forward: dy > 0 };
		return { vertical, top: bounds.top, bottom: bounds.bottom, left: dx < 0 ? column : bounds.right + 1, right: dx < 0 ? bounds.left - 1 : column, forward: dx > 0 };
	}
	function fillEntry(y, x, vertical) {
		const { bounds, series } = fillDrag, lane = vertical ? x : y, key = (vertical ? "v" : "h") + lane;
		if (!series.has(key)) {
			const seeds = [];
			if (vertical) for (let i=bounds.top; i<=bounds.bottom; i++) seeds.push([visibleRows[i],visibleColumns[x]]);
			else for (let i=bounds.left; i<=bounds.right; i++) seeds.push([visibleRows[y],visibleColumns[i]]);
			series.set(key, { seeds, generate: tableSheet.series(seeds.map(([r,c]) => sheet.rows[r][c])) });
		}
		const { seeds, generate } = series.get(key), i = vertical ? y - bounds.top : x - bounds.left;
		const [r,c] = seeds[(i % seeds.length + seeds.length) % seeds.length];
		const v = sheet.rows[r][c];
		if (v instanceof Formula) return ["text",tableCalc.offset(v.expression,(visibleRows[y] ?? y)-r,visibleColumns[x]-c),styleAt(sheet.rows[r],sheet.columns[c]) || null,v.expression,r,c];
		return [tableFormats.kind(v), tableFormats.textValue(generate(i)), styleAt(sheet.rows[r],sheet.columns[c]) || null];
	}
	function previewFill(event) {
		const f = fillDrag;
		f.x = event.clientX; f.y = event.clientY;
		const dest = fillDestination(f.x,f.y); f.dest = dest;
		const tip = $("fill-tip"); tip.hidden = !dest;
		if (dest) {
			const y = dest.forward ? dest.bottom : dest.top, x = dest.forward ? dest.right : dest.left;
			tip.textContent = fillEntry(y,x,dest.vertical)[1] || "(empty)";
			tip.style.left = Math.min(innerWidth - tip.offsetWidth, f.x + 14) + "px";
			tip.style.top = Math.min(innerHeight - tip.offsetHeight, f.y + 18) + "px";
		}
		for (const td of grid.querySelectorAll("td")) {
			const y = positions.get(+td.dataset.r), x = td.cellIndex - 1;
			td.toggleAttribute("data-fill-target", !!dest && y >= dest.top && y <= dest.bottom && x >= dest.left && x <= dest.right);
		}
	}
	function stopFill(apply) {
		if (!fillDrag) return;
		const { dest, bounds, pointer, initialPage, timer } = fillDrag;
		clearInterval(timer);
		try {
			if (apply && dest) {
				const edits = [], added = [];
				for (let y=dest.top; y<=dest.bottom; y++) {
					const r = visibleRows[y] ?? y, cells = sheet.rows[r] || blankRow();
					if (!sheet.rows[r]) added.push(cells);
					for (let x=dest.left; x<=dest.right; x++) {
						const c = visibleColumns[x], column = sheet.columns[c], entry = fillEntry(y,x,dest.vertical);
						try { edits.push(cellEdit(cells,column,c,pastedValue(entry,column.field,cells[c],r,c),entry[2])); }
						catch (error) { throw new Error(address(r,c) + " · " + error.message); }
					}
				}
				applyCells(edits, added); rebuildView();
				const end = dest.forward ? dest.bottom : dest.top;
				const startRow = fillDrag.startRows[dest.forward ? bounds.top : bounds.bottom];
				anchor = { row: startRow, col: visibleColumns[dest.forward ? bounds.left : bounds.right] };
				row = fillDrag.startRows[end] ?? end; col = visibleColumns[dest.forward ? dest.right : dest.left];
				if (!positions.has(anchor.row) || !positions.has(row)) anchor = null;
				status("Filled " + edits.length + " cells.");
			}
		} catch (error) { status(error.message, true); }
		finally {
			fillDrag = null; if (grid.hasPointerCapture(pointer)) grid.releasePointerCapture(pointer);
			$("fill-tip").hidden = true; render(true, !apply ? initialPage : undefined);
		}
	}
	fillHandle.onpointerdown = event => {
		if (event.button || !event.isPrimary || !commit()) return;
		event.stopPropagation(); event.preventDefault();
		fillDrag = { bounds: rangeBounds(), startRows: visibleRows, series: new Map(), pointer: event.pointerId, initialPage: page, x: event.clientX, y: event.clientY };
		grid.setPointerCapture(event.pointerId);
		fillDrag.timer = setInterval(() => {
			const f = fillDrag, rect = scroller.getBoundingClientRect();
			if (f.x < rect.left || f.x > rect.right || f.y < rect.top - 18 || f.y > rect.bottom + 40) return;
			const edge = f.y > rect.bottom - 18 ? 1 : f.y < rect.top + grid.tHead.offsetHeight + 8 ? -1 : 0;
			const side = f.x > rect.right - 18 ? 1 : f.x < rect.left + 18 ? -1 : 0;
			if (!edge && !side) return;
			const before = scroller.scrollTop;
			scroller.scrollBy(side * 24, edge * 22);
			const next = page + edge;
			if (edge && before === scroller.scrollTop && next >= 0 && next * pageSize < visibleRows.length && (!f.turned || Date.now()-f.turned > 450)) {
				f.turned = Date.now(); render(false,next); scroller.scrollTop = edge > 0 ? 0 : scroller.scrollHeight;
			}
			previewFill({clientX:f.x, clientY:Math.max(rect.top + grid.tHead.offsetHeight + 2, Math.min(f.y,rect.bottom-2))});
		},100);
	};
	grid.addEventListener("pointermove", e => { if (fillDrag?.pointer === e.pointerId) previewFill(e); });
	grid.addEventListener("pointerup", e => { if (fillDrag?.pointer === e.pointerId) stopFill(true); });
	for (const name of ["pointercancel", "lostpointercapture"]) {
		grid.addEventListener(name, e => { if (fillDrag?.pointer === e.pointerId && e.target === grid) stopFill(false); });
	}
	window.addEventListener("blur", () => stopFill(false));
	document.addEventListener("keydown", e => { if (fillDrag && e.key === "Escape") { e.preventDefault(); stopFill(false); } });

	function turnPage(delta) {
		const b = rangeBounds(), start = (page + delta) * pageSize;
		if (anchor && start <= b.bottom && start + pageSize > b.top) {
			move(visibleRows[Math.max(start,b.top)], col, true, false, { ...anchor, extent: anchor.extent || { row,col } });
		} else move(visibleRows[start],col);
	}
	$("previous-page").onclick = () => turnPage(-1);
	$("next-page").onclick = () => turnPage(1);
	$("undo").onclick = () => undo(false); $("redo").onclick = () => undo(true);

	function appendRow() {
		if (!commit()) return;
		const r = sheet.rows.length;
		const data = blankRow();
		change(() => sheet.rows.splice(r, 0, data), () => sheet.rows.splice(r, 1));
		row = r; rebuildView();
		if (!positions.has(r)) reveal(r, col, true); else render(true);
	}
	$("add-row").onclick = () => insertRows(false); $("append-row").onclick = appendRow;
	$("remove-row").onclick = deleteRows;
	function columnDialog(action) {
		if (!commit()) return;
		columnAction = action;
		$("column-title").textContent = action === "add" ? "Add column" : "Rename column";
		let n = sheet.columns.length + 1;
		while (sheet.columns.some(c => c.name === "Column " + n)) n++;
		$("column-name").value = action === "add" ? "Column " + n : sheet.columns[col].name;
		const typed = sheet.format === "parquet" && action === "add";
		$("column-type").hidden = document.querySelector('label[for="column-type"]').hidden = !typed;
		$("column-type").value = "Text";
		show($("column-dialog"));
		if (sheet.csv?.header === false) status("Saving this column name adds a header row to the CSV.");
		$("column-name").select();
	}
	$("add-column").onclick = () => columnDialog("add");
	$("rename-column").onclick = () => columnDialog("rename");
	$("column-form").onsubmit = event => {
		event.preventDefault();
		const name = $("column-name").value, c = col;
		if (sheet.format !== "csv" && sheet.columns.some((v, i) => v.name === name && (columnAction === "add" || i !== c))) {
			status("A column with this name already exists.", true); return;
		}
		const headerless = sheet.csv?.header === false;
		if (columnAction === "rename") {
			const column = sheet.columns[c], original = { ...column };
			change(() => {
				column.name = name; column.implicit = false;
				if (headerless) sheet.csv.header = true;
			}, () => {
				Object.assign(column, { implicit: false }, original);
				if (headerless) sheet.csv.header = false;
			});
		} else {
			const column = { name };
			if (sheet.format === "parquet") column.field = tableOperations.field(name, $("column-type").value.toLowerCase());
			const index = sheet.columns.length, widths = sheet.rows.map(r => r.length);
			change(() => {
				sheet.columns.push(column);
				if (headerless) sheet.csv.header = true;
				sheet.rows.forEach(r => { r[index] = sheet.format === "csv" ? "" : null; });
			}, () => {
				sheet.columns.pop(); sheet.rows.forEach((r, i) => { r.length = widths[i]; });
				if (headerless) sheet.csv.header = false;
			});
			col = index;
		}
		$("column-dialog").close(); render(true);
	};
	$("remove-column").onclick = deleteColumns;

	let pendingCSV, previewSequence = 0;
	function csvOptions() {
		const separator = $("csv-delimiter").value;
		return { delimiter: separator === "tab" ? "\t" : separator, header: $("csv-header").checked };
	}
	async function previewCSV() {
		const request = pendingCSV, seq = ++previewSequence;
		if (!request) return;
		$("csv-import").disabled = true;
		const preview = $("csv-preview");
		preview.tHead.replaceChildren(); preview.tBodies[0].replaceChildren();
		try {
			const sample = await tableFormats.read("csv", request.snapshot.bytes, 5, csvOptions());
			if (seq !== previewSequence) return;
			const head = preview.tHead.insertRow();
			for (const column of sample.columns) {
				const th = document.createElement("th"); th.scope = "col"; th.textContent = column.name || "(unnamed)"; head.append(th);
			}
			for (const cells of sample.rows) {
				const tr = preview.tBodies[0].insertRow();
				for (let c = 0; c < sample.columns.length; c++) tr.insertCell().textContent = cells[c] ?? "";
			}
			const sep = { ",": "comma", ";": "semicolon", "\t": "tab" }[sample.csv.delimiter];
			status(request.file.name + " · " + sep + " · " + sample.rows.length + " preview rows");
			$("csv-import").disabled = false;
		} catch (error) { if (seq === previewSequence) status(error.message, true); }
	}
	$("csv-delimiter").onchange = $("csv-header").onchange = previewCSV;
	$("csv-dialog").addEventListener("close", event => {
		if (!event.target.open) { pendingCSV = null; previewSequence++; }
	});
	$("csv-form").onsubmit = event => {
		event.preventDefault();
		if (pendingCSV) run(() => openFile(pendingCSV.file, pendingCSV.snapshot, csvOptions()));
	};

	async function openFile(file, snapshot, options) {
		const format = extension(file.name);
		if (!format) throw new Error("Choose a file ending in .xlsx, .csv, .jsonl or .parquet.");
		if (format === "xlsx") {
			const book = await tableWorkbook.read(snapshot.bytes);
			document.querySelector("dialog[open]")?.close();
			const active = file.path && lastView?.file === file.path && book.find(tab => tab.name === lastView.worksheet);
			reset(active || book[0],{...file,snapshot,externalWorkbook:!book.fromEditor},"Opened " + file.name + " · " + book.length + " worksheet(s).",[],book);
			updateUrl(file.path); return;
		}
		if (format === "csv" && !options) {
			document.querySelector("dialog[open]")?.close();
			pendingCSV = { file, snapshot };
			$("csv-header").checked = true; $("csv-delimiter").value = "";
			show($("csv-dialog")); await previewCSV(); return;
		}
		// A newly created workspace file has no Parquet footer yet. Initialize it on the first Save.
		const newParquet = file.path && format === "parquet" && !snapshot.bytes.length;
		const next = newParquet
			? { format, columns: [{ name: "Column 1", field: tableParquet.leaf("Column 1", "BYTE_ARRAY", "UTF8") }], rows: [] }
			: await tableFormats.read(format, snapshot.bytes, Infinity, options);
		document.querySelector("dialog[open]")?.close();
		const message = newParquet ? "Empty Parquet file. Add rows or save the new table." : "Opened " + file.name + ".";
		const csv = next.csv && { header: next.csv.header, delimiter: next.csv.delimiter };
		reset(next, { ...file, snapshot, newParquet, csv }, message, await loadStyles(file,snapshot.bytes,csv));
		updateUrl(file.path);
	}
	function updateUrl(path) {
		const url = new URL(location.href);
		if (path) url.searchParams.set("file", path); else url.searchParams.delete("file");
		try { window.history.replaceState(null, "", url); } catch { /* Some browsers restrict file URL history. */ }
		rememberView(path);
	}
	async function openWorkspace(path, options) {
		const vfs = await window.vfsReady;
		const absolute = vfs.fileSystem.resolvePath("/", path);
		await openFile({ name: basename(absolute), path: absolute }, await vfs.fileSystem.readFile(absolute), options);
	}
	function discard() { return !changed() || window.confirm("Discard the unsaved table edits?"); }
	$("new-workbook").onclick = () => { if (discard()) { reset(tableWorkbook.empty(),null,"New workbook."); updateUrl(); } };
	$("new-table").onclick = () => {
		if (discard()) { reset(empty(), null, "New table."); updateUrl(); }
	};
	$("open-table").onclick = async () => {
		const dialog = $("open-dialog"), files = $("workspace-files"), request = ++listing;
		files.replaceChildren(); $("open-workspace").disabled = true;
		show(dialog); status("Looking for workspace tables…");
		try {
			const entries = await (await window.vfsReady).ls("/");
			if (!dialog.open || request !== listing) return;
			const paths = entries.filter(path => extension(path)).sort();
			files.replaceChildren(...paths.map(path => new Option("/" + path, "/" + path)));
			if (paths.length) files.selectedIndex = 0;
			$("open-workspace").disabled = !paths.length;
			status(paths.length ? "" : "No XLSX, CSV, JSONL or Parquet files in this workspace yet.");
		} catch (error) { if (dialog.open && request === listing) status(error.message || String(error), true); }
	};
	$("open-form").onsubmit = event => {
		event.preventDefault();
		if ($("workspace-files").value && discard()) run(() => openWorkspace($("workspace-files").value));
	};
	$("workspace-files").ondblclick = () => { if (!$("open-workspace").disabled) $("open-form").requestSubmit(); };
	const pickerTypes = Object.entries(formats).map(([ext, mime]) => ({ description: ext.toUpperCase(), accept: { [mime]: ["." + ext] } }));
	$("open-local").onclick = () => {
		if (!discard()) return;
		if (!window.showOpenFilePicker) { $("local-file").click(); return; }
		run(async () => {
			let handles;
			try { handles = await window.showOpenFilePicker({ types: pickerTypes }); }
			catch (error) {
				if (error.name !== "SecurityError" && error.name !== "NotAllowedError") throw error;
				$("local-file").click(); return;
			}
			const handle = handles[0], f = await handle.getFile();
			await openFile({ name: f.name, handle }, { bytes: new Uint8Array(await f.arrayBuffer()) });
		});
	};
	$("local-file").onchange = () => {
		const f = $("local-file").files[0]; $("local-file").value = "";
		if (f) run(async () => openFile({ name: f.name }, { bytes: new Uint8Array(await f.arrayBuffer()) }));
	};
	let exportingView = false;
	function exportSheet() {
		rebuildView();
		return { ...sheet, rows: visibleRows.map(r => values()[r]), originalRows: undefined };
	}
	function formatNote() {
		const target = $("save-format").value;
		if (target === "xlsx") { $("format-note").textContent = "Save all " + tabs.length + " worksheet(s), including formulas, formatting and charts." + (source?.externalWorkbook ? " The edited copy includes the cell data, formulas and formats supported by this editor." : ""); return; }
		const notes = {
			csv: "CSV stores text. Null and missing values become empty fields. Nested values use JSON text.",
			jsonl: "Each row becomes one JSON value. Object fields missing from a row are omitted. Empty files have no column names.",
			parquet: "Parquet stores typed columns. Missing values become null."
		};
		const order = exportingView ? `Exporting ${visibleRows.length} visible rows in view order, with all ${sheet.columns.length} columns.` :
			`Exporting all ${sheet.rows.length} rows in file order.`;
		let note = exportingView ? order + " " + notes[target] : notes[target];
		if (target !== sheet.format) {
			let nulls = 0, missing = 0, nested = 0, strings = 0;
			for (const cells of exportingView ? exportSheet().rows : values()) {
				for (let c = 0; c < sheet.columns.length; c++) {
					const value = cells[c];
					if (value === null) nulls++;
					else if (value === undefined) missing++;
					else if (typeof value === "string") strings++;
					else if (tableFormats.kind(value) === "json") nested++;
				}
			}
			const counts = [];
			if (target === "csv") {
				if (nulls || missing) counts.push(`Empty fields from this table: ${nulls} null, ${missing} missing.`);
				if (nested) counts.push(`Nested values written as JSON text: ${nested}.`);
			} else if (target === "jsonl" && missing) counts.push(`Fields omitted: ${missing}.`);
			else if (target === "parquet" && missing) counts.push(`Missing fields converted to null: ${missing}.`);
			if (sheet.format === "csv") counts.push(`Values retained as text: ${strings}.`);
			note = [order, ...counts, notes[target]].join(" ");
		}
		$("format-note").textContent = (needsWorkbook() ? "Export the active sheet as calculated values. " : "") + note;
	}
	function saveDialog(exportRows = false) {
		if (!commit()) return;
		exportingView = exportRows;
		$("save-title").textContent = exportRows ? "Export visible rows" : "Save table as";
		$("save-form").querySelector("[type=submit]").textContent = exportRows ? "Export" : "Save";
		const format = exportRows && needsWorkbook() ? "csv" : needsWorkbook() ? "xlsx" : sheet.format;
		$("save-format").querySelector('[value=xlsx]').disabled = exportRows;
		const sourceName = source?.path || source?.name || (needsWorkbook() ? "Untitled.xlsx" : "Untitled.csv");
		$("save-name").value = exportRows ? sourceName.replace(/\.[^.]+$/, "") + "-view." + format : sourceName.replace(/\.[^./]+$/,"") + (source?.externalWorkbook && changed() ? "-edited" : "") + "." + format;
		$("save-destination").value = !source || source.path ? "vfs" : "local";
		$("save-format").value = format; formatNote();
		show($("save-dialog")); $("save-name").focus();
	}
	$("save-as").onclick = () => saveDialog();
	$("export-view").onclick = () => saveDialog(true);
	$("save-format").onchange = () => {
		const input = $("save-name");
		input.value = input.value.replace(/\.(xlsx|csv|jsonl|parquet)$/i, "") + "." + $("save-format").value;
		formatNote();
	};
	$("save-name").oninput = () => {
		const ext = extension($("save-name").value);
		if (ext && ext !== $("save-format").value) { $("save-format").value = ext; formatNote(); }
	};
	$("save-destination").onchange = () => {
		if ($("save-destination").value === "local") $("save-name").value = basename($("save-name").value);
	};
	async function save(target, format, as, exportRows = false) {
		let { name, path, handle } = target;
		const workspace = path !== undefined;
		let downloaded = false;
		if (!workspace && as && window.showSaveFilePicker) {
			try {
				handle = await window.showSaveFilePicker({ suggestedName: name, types: pickerTypes.filter(t => t.description === format.toUpperCase()) });
				name = handle.name;
				if (extension(name) !== format) throw new Error("The file extension must match the selected format.");
			} catch (error) { if (error.name !== "SecurityError" && error.name !== "NotAllowedError") throw error; }
		}
		const workbook = format === "xlsx", flatExport = !workbook && needsWorkbook();
		const separate = exportRows || flatExport;
		if (answers.work) { status("Waiting for model answers before saving…"); await answers.settle(); }
		const original = !separate && source && !source.newParquet && (workbook ? revision === saved && answers.version === savedAnswerVersion : dataRevision === savedData) && format === extension(source.name);
		const bytes = original ? source.snapshot.bytes : workbook ? await tableWorkbook.write(tabs,calculate,answers.records()) :
			tableFormats.write(exportRows ? exportSheet() : flatExport ? {...sheet,rows:values(),originalRows:undefined} : sheet, format);
		// Reopen conversions and Parquet encodings. Native JSONL saves retain the displayed order of sparse columns.
		const next = !workbook && !separate && !original && (format === "parquet" || sheet.format !== format) ? await tableFormats.read(format, bytes) : sheet;
		const snapshot = { bytes };
		if (workspace) {
			const fs = (await window.vfsReady).fileSystem;
			path = fs.resolvePath("/", path);
			const same = path === source?.path;
			if (same && separate) throw new Error("Choose a separate file for the exported rows.");
			let expectedFile = same ? source.snapshot : undefined;
			if (!same) {
				try { expectedFile = await fs.readFile(path); }
				catch (error) { if (error.code !== "ENOENT") throw error; }
				if (expectedFile && !window.confirm(`Replace the existing file ${path}?`)) return;
			}
			snapshot.mtime = await fs.write(path, bytes, { exclusive: !expectedFile, expectedFile, returnMtime: true });
		} else if (handle) {
			const same = source?.handle && (handle === source.handle || await handle.isSameEntry(source.handle));
			if (separate && (same || (!source?.handle && !source?.path && name === source?.name))) throw new Error("Choose a separate file for the exported rows.");
			if (same) {
				const latest = new Uint8Array(await (await handle.getFile()).arrayBuffer()), old = source.snapshot.bytes;
				if (old.length !== latest.length || !latest.every((b, i) => old[i] === b)) {
					throw new Error("The file changed on your computer. Reopen it or save a copy under another name.");
				}
			}
			const stream = await handle.createWritable();
			try { await stream.write(bytes); await stream.close(); }
			catch (error) { await stream.abort().catch(() => {}); throw error; }
		} else {
			downloadVfsBlob(new Blob([bytes], { type: formats[format] }), name);
			downloaded = true;
		}
		document.querySelector("dialog[open]")?.close();
		if (separate) {
			status("Exported " + (exportRows ? visibleRows.length : sheet.rows.length) + " rows to " + (path || name) + "."); return;
		}
		source = { name, path, handle, snapshot, externalWorkbook:workbook && original && source?.externalWorkbook, csv: format === "csv" ? { header: next.csv?.header !== false, delimiter: next.csv?.delimiter || "," } : undefined };
		if (workbook && tabs.some(tab => tab.format !== "xlsx")) {
			const book = await tableWorkbook.read(bytes), active = tabs.indexOf(sheet);
			reset(book[active],source,"Saved " + (path || name) + ".",[],book); updateUrl(path); return;
		}
		if (sheet !== next) {
			const records = styleRecords(), previous = sheet.columns;
			const nextFilters = next.columns.map((_, c) => filters.get(previous[c]));
			filters.clear();
			next.columns.forEach((column, c) => {
				if (nextFilters[c]) filters.set(column, nextFilters[c]);
				if (hidden.has(previous[c])) hidden.add(column);
				if (pinned.has(previous[c])) pinned.add(column);
				if (widths.has(previous[c])) widths.set(column, widths.get(previous[c]));
			});
			sortLevels = sortLevels.map(({column,order}) => ({column:next.columns[previous.indexOf(column)],order})).filter(level => level.column);
			tabs = [next]; next.name = sheet.name; sheet = next; restoreStyles(records); sheet.styles = styles; invalidate(); past.length = future.length = 0; anchor = null; viewRevision = searchRevision = undefined;
		}
		saved = revision; savedData = dataRevision; savedAnswerVersion = answers.version;
		const formatStatus = workbook ? "" : await storeStyles(source,bytes,source.csv);
		render(); updateUrl(path);
		status((downloaded ? "Downloaded " + name + "." : "Saved " + (path || name) + ".") + formatStatus);
	}
	$("save-table").onclick = () => {
		if (!commit()) return;
		if (!source || (source.externalWorkbook && changed()) || (needsWorkbook() && extension(source.name) !== "xlsx")) { saveDialog(); return; }
		run(() => save(source, extension(source.name), false));
	};
	$("save-form").onsubmit = event => {
		event.preventDefault();
		const format = $("save-format").value, workspace = $("save-destination").value === "vfs";
		let input = $("save-name").value.trim();
		if (!input || input.endsWith("/") || /(^|\/)\.{1,2}$/.test(input)) { status("Enter a file name.", true); return; }
		if (exportingView && format === "xlsx") { status("Choose CSV, JSON Lines or Parquet for the visible rows.",true); return; }
		if (!extension(input)) input += "." + format;
		else if (extension(input) !== format) { status("Choose a file extension matching the selected format.",true); return; }
		const name = basename(input);
		const path = workspace ? (input.startsWith("/") ? input : (source?.path?.slice(0, -source.name.length) || "/") + input) : undefined;
		run(() => save({ name, path }, format, true, exportingView));
	};
	document.querySelectorAll("[data-close]").forEach(button => button.onclick = () => button.closest("dialog").close());
	document.addEventListener("keydown", event => {
		if (!(event.ctrlKey || event.metaKey) || busy || document.querySelector("dialog[open]")) return;
		if (event.key.toLowerCase() === "s") {
			event.preventDefault(); (event.shiftKey ? $("save-as") : $("save-table")).click();
		} else if (event.key.toLowerCase() === "z" && !event.target.closest("textarea, input, select")) {
			event.preventDefault(); undo(event.shiftKey);
		}
	});
	window.addEventListener("beforeunload", event => { if (changed() || busy) { event.preventDefault(); event.returnValue = ""; } });
	reset(tableWorkbook.empty(), null);
	const requested = new URLSearchParams(location.search).get("file");
	const initialSheet = sheet;
	async function restoreTable(settings) {
		if (sheet !== initialSheet || changed() || inline || document.querySelector("dialog[open]")) return;
		lastView = settings.view;
		const path = requested || lastView?.file;
		if (typeof path !== "string" || !path.startsWith("/") || !extension(path)) {
			if (requested) await openWorkspace(requested);
			return;
		}
		try { await openWorkspace(path, lastView?.file === path ? lastView.csv || {} : undefined); }
		catch (error) {
			if (requested || error.code !== "ENOENT") throw error;
			status("The last workspace table was removed or moved. Choose another file to open.");
		}
	}
	if (requested) run(async () => restoreTable(await pageSettings.read("table")));
	else pageSettings.read("table").then(settings => {
		if (!busy && settings.view?.file) run(() => restoreTable(settings));
	});
})();
