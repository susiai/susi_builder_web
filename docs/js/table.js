"use strict";

(() => {
	const $ = id => document.getElementById(id);
	const pageTitle = document.title;
	const grid = $("data-grid"), bar = $("cell-value"), type = $("cell-type");
	const scroller = $("grid-scroll"), dropLine = $("table-drop-line");
	const pageSize = 100;
	const formats = { csv: "text/csv", jsonl: "application/x-ndjson", parquet: "application/octet-stream" };
	const past = [], future = [];
	let sheet, source, row = 0, col = 0, page = 0, revision = 0, saved = 0, sequence = 0;
	let busy = false, draft = false, inline = null, columnAction, listing = 0;
	let drag;
	let lastView;
	const changed = () => draft || revision !== saved;
	const basename = name => name.split("/").pop();
	const letters = index => {
		let name = "";
		for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
		return name;
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
		}
	}

	function title() {
		const name = source?.name || "Untitled.csv";
		$("file-name").textContent = name + (changed() ? " *" : "");
		const folder = source?.path?.slice(0, -name.length);
		$("file-location").textContent = folder ? "Workspace · " + folder : source ? "Computer" : "New table";
		$("file-location").title = source?.path || "";
		document.title = (changed() ? "* " : "") + name + " · " + pageTitle;
		$("undo").disabled = !past.length;
		$("redo").disabled = !future.length;
	}

	function reset(next, file, message) {
		sheet = next; source = file; row = col = page = revision = saved = sequence = 0;
		if (file?.path && lastView?.file === file.path) {
			row = Number.isSafeInteger(lastView.row) ? lastView.row : 0;
			col = Number.isSafeInteger(lastView.column) ? lastView.column : 0;
		}
		past.length = future.length = 0;
		draft = false; inline = null;
		render();
		if (message) status(message);
	}

	function empty() {
		return { format: "csv", columns: [1, 2, 3].map(n => ({ name: "Column " + n })), rows: [["", "", ""]] };
	}

	function rememberView(file) {
		const next = file ? { file, row, column: col } : { file: null };
		if (lastView?.file === next.file && lastView.row === next.row && lastView.column === next.column) return;
		lastView = next;
		pageSettings.save("table", { view: next });
	}

	function typeOptions() {
		const field = sheet.columns[col]?.field;
		const value = sheet.rows[row]?.[col];
		if (sheet.format === "csv") return ["text"];
		if (!field) return sheet.values ? ["text","number","boolean","json","null"] : ["text","number","boolean","json","null","missing"];
		const types = [tableParquet.kind(field)];
		// Special floats and dates outside the ISO range retain their original representation.
		if (value != null && !types.includes(tableFormats.kind(value))) types.push(tableFormats.kind(value));
		if (field.element.repetition_type !== "REQUIRED") types.push("null");
		return types;
	}

	function selection(focus = false) {
		const old = grid.querySelector("[data-selected]");
		if (old) { old.tabIndex = -1; old.removeAttribute("data-selected"); }
		grid.querySelectorAll("[data-active]").forEach(th => th.removeAttribute("data-active"));
		const cell = grid.querySelector(`td[data-r="${row}"][data-c="${col}"]`);
		if (cell) {
			cell.dataset.selected = ""; cell.tabIndex = 0;
			cell.parentNode.firstChild.dataset.active = "";
			grid.tHead.rows[0].cells[col + 1].dataset.active = "";
			if (focus) cell.focus();
		}
		const field = sheet.columns[col]?.field;
		const v = sheet.rows[row]?.[col];
		const kind = sheet.format === "csv" ? "text" : tableFormats.kind(v);
		const types = typeOptions();
		type.replaceChildren(...types.map(t => new Option(t === "json" ? "JSON" : t[0].toUpperCase() + t.slice(1), t)));
		if (field) type.options[0].textContent = tableParquet.label(field);
		type.value = types.includes(kind) ? kind : types[0];
		type.disabled = !cell || types.length < 2;
		type.title = field ? "Parquet column type: " + tableParquet.fieldType(field.element) : "Cell value type";
		bar.value = tableFormats.textValue(v);
		bar.removeAttribute("aria-invalid");
		bar.placeholder = cell ? "Enter a value" : "";
		bar.disabled = !cell || ["null", "missing"].includes(type.value);
		$("apply-cell").disabled = !cell;
		$("cell-address").textContent = cell ? letters(col) + (row + 1) : "—";
		$("remove-row").disabled = !sheet.rows.length;
		$("rename-column").disabled = !sheet.columns.length || !!sheet.values;
		$("remove-column").disabled = sheet.columns.length <= 1 || !!sheet.values;
		$("add-column").disabled = !!sheet.values;
		$("add-row").disabled = $("append-row").disabled = !sheet.columns.length && sheet.format !== "jsonl";
		if (source?.path) rememberView(source.path);
	}

	function render(focus = false, visiblePage) {
		if (drag?.active && visiblePage === undefined) endDrag(false);
		inline = null;
		row = Math.min(Math.max(0, row), Math.max(0, sheet.rows.length - 1));
		col = Math.min(Math.max(0, col), Math.max(0, sheet.columns.length - 1));
		page = visiblePage ?? Math.floor(row / pageSize);
		const head = document.createElement("tr");
		head.append(document.createElement("th"));
		for (const [i, column] of sheet.columns.entries()) {
			const th = document.createElement("th"), letter = document.createElement("small");
			letter.textContent = letters(i);
			th.scope = "col"; th.dataset.c = i;
			th.append(letter, column.name || "(unnamed)");
			th.title = column.field ? tableParquet.fieldType(column.field.element) : column.name;
			if (sheet.columns.length > 1) {
				th.dataset.reorder = "column";
				th.title = [th.title, "Drag to move column " + letters(i)].filter(Boolean).join("\n");
			}
			head.append(th);
		}
		grid.tHead.replaceChildren(head);
		const body = document.createDocumentFragment();
		const start = page * pageSize, end = Math.min(start + pageSize, sheet.rows.length);
		for (let r = start; r < end; r++) {
			const tr = document.createElement("tr"), th = document.createElement("th");
			th.scope = "row"; th.dataset.r = r; th.textContent = r + 1; tr.append(th);
			if (sheet.rows.length > 1) {
				th.dataset.reorder = "row";
				th.title = "Drag to move row " + (r + 1);
			}
			for (let c = 0; c < sheet.columns.length; c++) {
				const td = document.createElement("td"), v = sheet.rows[r][c];
				td.dataset.r = r; td.dataset.c = c; td.tabIndex = -1;
				td.dataset.kind = sheet.format === "csv" ? "text" : tableFormats.kind(v);
				td.textContent = v === null ? "null" : v === undefined && sheet.format === "jsonl" ? "missing" : tableFormats.textValue(v);
				tr.append(td);
			}
			body.append(tr);
		}
		grid.tBodies[0].replaceChildren(body);
		const nr = sheet.rows.length, nc = sheet.columns.length;
		$("dimensions").textContent = `${nr.toLocaleString()} ${nr === 1 ? "row" : "rows"} · ${nc.toLocaleString()} ${nc === 1 ? "column" : "columns"}`;
		$("page-range").textContent = end ? `${start + 1}–${end}` : "0";
		$("previous-page").disabled = !start;
		$("next-page").disabled = end >= sheet.rows.length;
		$("page-range").parentNode.hidden = sheet.rows.length <= pageSize;
		selection(focus); title();
	}

	function change(apply, revert) {
		const before = revision, after = ++sequence;
		apply(); revision = after;
		past.push({ apply, revert, before, after });
		if (past.length > 100) past.shift();
		future.length = 0;
	}
	function undo(redo) {
		if (!commit()) return;
		const entry = (redo ? future : past).pop();
		if (!entry) return;
		if (redo) { entry.apply(); revision = entry.after; past.push(entry); }
		else { entry.revert(); revision = entry.before; future.push(entry); }
		render(true); status(redo ? "Change reapplied." : "Change undone.");
	}

	function commit() {
		if (!draft && !inline) return true;
		try {
			if (draft) {
				const cells = sheet.rows[row], c = col, field = sheet.columns[c].field;
				let next = tableFormats.parseCell(type.value, bar.value);
				if (field) tableParquet.validate(field, next);
				const before = cells[c], width = cells.length;
				if (tableFormats.json(next) !== tableFormats.json(before)) {
					change(() => { cells[c] = next; }, () => { cells[c] = before; cells.length = width; });
				}
			}
		} catch (error) {
			status(error.message, true); bar.setAttribute("aria-invalid", "true"); (inline || bar).focus(); return false;
		}
		draft = false;
		render();
		status("Cell applied.");
		return true;
	}
	function move(r, c, focus = true) {
		if (!commit()) return;
		row = Math.max(0, Math.min(r, sheet.rows.length - 1));
		col = Math.max(0, Math.min(c, sheet.columns.length - 1));
		if (page !== Math.floor(row / pageSize)) render(focus); else selection(focus);
	}
	function reorder(axis, from, to) {
		const columns = axis === "column";
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
		change(() => apply(from, to), () => apply(to, from));
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
			if (to !== from) {
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
	function edit(initial) {
		if (inline || !sheet.rows[row] || !sheet.columns[col]) return;
		const cell = grid.querySelector("[data-selected]");
		if (!cell) return;
		if (["null", "missing"].includes(type.value)) {
			type.value = type.options[0].value; bar.disabled = false;
		}
		const editor = document.createElement("textarea");
		editor.setAttribute("aria-label", "Edit " + $("cell-address").textContent);
		editor.spellcheck = false; editor.value = initial ?? bar.value;
		inline = editor; cell.append(editor); editor.focus(); editor.select();
		if (initial !== undefined) { bar.value = initial; editor.setSelectionRange(initial.length, initial.length); draft = true; title(); }
	}
	grid.addEventListener("click", event => {
		const cell = event.target.closest("[data-c], [data-r]");
		if (cell && event.target !== inline) move(Number(cell.dataset.r ?? row), Number(cell.dataset.c ?? col));
	});
	grid.addEventListener("dblclick", event => { if (event.target.closest("td")) edit(); });
	grid.addEventListener("input", event => {
		if (event.target === inline) { bar.value = inline.value; draft = true; title(); }
	});
	bar.addEventListener("input", () => { if (inline) inline.value = bar.value; draft = true; title(); });
	type.addEventListener("change", () => {
		draft = true; bar.disabled = ["null", "missing"].includes(type.value);
		if (bar.disabled) bar.value = "";
		if (inline) { inline.remove(); inline = null; }
		title(); if (!bar.disabled) bar.focus();
	});
	$("apply-cell").onclick = () => { if (commit()) selection(true); };
	function keys(event) {
		const editor = event.target === inline || event.target === bar;
		if (!editor && event.target.matches("td") && event.altKey && !event.ctrlKey && !event.metaKey &&
			!event.shiftKey && !event.isComposing && event.key.startsWith("Arrow")) {
			event.preventDefault();
			const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
			const from = horizontal ? col : row;
			const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
			reorder(horizontal ? "column" : "row", from, from + delta);
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
		if (event.key === "Escape" && editor) {
			event.preventDefault(); draft = false; render(true); status("Edit cancelled."); return;
		}
		if (event.key === "Enter" && event.shiftKey && editor) return;
		if (event.key === "Tab" || event.key === "Enter") {
			if (!editor && event.key === "Enter") { event.preventDefault(); edit(); return; }
			if (event.key === "Tab" && !editor && ((event.shiftKey && row === 0 && col === 0) ||
				(!event.shiftKey && row === sheet.rows.length - 1 && col === sheet.columns.length - 1))) return;
			event.preventDefault();
			if (event.key === "Enter") move(row + 1, col);
			else {
				const index = (row * sheet.columns.length) + col + (event.shiftKey ? -1 : 1);
				move(Math.floor(index / sheet.columns.length), (index + sheet.columns.length) % sheet.columns.length);
			}
		} else if (!editor) {
			const deltas = { ArrowLeft: [0,-1], ArrowRight: [0,1], ArrowUp: [-1,0], ArrowDown: [1,0] };
			const delta = deltas[event.key];
			if (delta) { event.preventDefault(); move(row + delta[0], col + delta[1]); }
			else if (["Delete", "Backspace"].includes(event.key)) {
				event.preventDefault();
				if (sheet.format === "csv") { bar.value = ""; draft = true; }
				else if (typeOptions().includes("null")) { type.value = "null"; draft = true; }
				else { status("This Parquet field requires a value.", true); return; }
				if (commit()) selection(true);
			} else if (event.key === "F2" || event.key.length === 1) {
				event.preventDefault(); edit(event.key === "F2" ? undefined : event.key);
			}
		}
	}
	grid.addEventListener("keydown", keys); bar.addEventListener("keydown", keys);
	grid.addEventListener("copy", event => {
		if (event.target.tagName !== "TD" || !event.clipboardData) return;
		event.clipboardData.setData("text/plain", bar.value); event.preventDefault();
	});
	grid.addEventListener("paste", event => {
		if (event.target.tagName !== "TD" || !event.clipboardData) return;
		event.preventDefault(); edit(event.clipboardData.getData("text/plain"));
	});
	$("previous-page").onclick = () => move((page - 1) * pageSize, col);
	$("next-page").onclick = () => move((page + 1) * pageSize, col);
	$("undo").onclick = () => undo(false); $("redo").onclick = () => undo(true);

	function addRow(append) {
		if (!commit()) return;
		const r = append ? sheet.rows.length : Math.min(row + 1, sheet.rows.length);
		const data = sheet.columns.map(() => sheet.format === "csv" ? "" : sheet.format === "parquet" || sheet.values ? null : undefined);
		change(() => sheet.rows.splice(r, 0, data), () => sheet.rows.splice(r, 1));
		row = r; render(true);
	}
	$("add-row").onclick = () => addRow(false); $("append-row").onclick = () => addRow(true);
	$("remove-row").onclick = () => {
		if (!commit()) return;
		const r = row, previous = sheet.rows[r];
		change(() => sheet.rows.splice(r, 1), () => sheet.rows.splice(r, 0, previous)); render(true);
	};
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
		show($("column-dialog")); $("column-name").select();
	}
	$("add-column").onclick = () => columnDialog("add");
	$("rename-column").onclick = () => columnDialog("rename");
	$("column-form").onsubmit = event => {
		event.preventDefault();
		const name = $("column-name").value, c = col;
		if (sheet.format !== "csv" && sheet.columns.some((v, i) => v.name === name && (columnAction === "add" || i !== c))) {
			status("A column with this name already exists.", true); return;
		}
		if (columnAction === "rename") {
			const column = sheet.columns[c], original = { ...column };
			change(() => { column.name = name; column.implicit = false; }, () => Object.assign(column, { implicit: false }, original));
		} else {
			const column = { name };
			if (sheet.format === "parquet") {
				const types = { Text: ["BYTE_ARRAY","UTF8"], Integer: ["INT64"], Number: ["DOUBLE"], Boolean: ["BOOLEAN"] };
				column.field = tableParquet.leaf(name, ...types[$("column-type").value]);
			}
			const index = sheet.columns.length, widths = sheet.rows.map(r => r.length);
			change(() => {
				sheet.columns.push(column);
				sheet.rows.forEach(r => { r[index] = sheet.format === "csv" ? "" : null; });
			}, () => { sheet.columns.pop(); sheet.rows.forEach((r, i) => { r.length = widths[i]; }); });
			col = index;
		}
		$("column-dialog").close(); render(true);
	};
	$("remove-column").onclick = () => {
		if (!commit()) return;
		const c = col, column = sheet.columns[c], values = sheet.rows.map(r => r[c]), widths = sheet.rows.map(r => r.length);
		change(() => { sheet.columns.splice(c, 1); sheet.rows.forEach(r => r.splice(c, 1)); }, () => {
			sheet.columns.splice(c, 0, column);
			sheet.rows.forEach((r, i) => { if (c < widths[i]) r.splice(c, 0, values[i]); });
		});
		render(true);
	};

	async function openFile(file, snapshot) {
		const format = tableFormats.extension(file.name);
		if (!format) throw new Error("Choose a file ending in .csv, .jsonl or .parquet.");
		// A newly created workspace file has no Parquet footer yet. Initialize it on the first Save.
		const newParquet = file.path && format === "parquet" && !snapshot.bytes.length;
		const next = newParquet
			? { format, columns: [{ name: "Column 1", field: tableParquet.leaf("Column 1", "BYTE_ARRAY", "UTF8") }], rows: [] }
			: await tableFormats.read(format, snapshot.bytes);
		document.querySelector("dialog[open]")?.close();
		const message = newParquet ? "Empty Parquet file. Add rows or save the new table." : "Opened " + file.name + ".";
		reset(next, { ...file, snapshot, newParquet }, message);
		updateUrl(file.path);
	}
	function updateUrl(path) {
		const url = new URL(location.href);
		if (path) url.searchParams.set("file", path); else url.searchParams.delete("file");
		try { window.history.replaceState(null, "", url); } catch { /* Some browsers restrict file URL history. */ }
		rememberView(path);
	}
	async function openWorkspace(path) {
		const vfs = await window.vfsReady;
		const absolute = vfs.fileSystem.resolvePath("/", path);
		await openFile({ name: basename(absolute), path: absolute }, await vfs.fileSystem.readFile(absolute));
	}
	function discard() { return !changed() || window.confirm("Discard the unsaved table edits?"); }
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
			const paths = entries.filter(path => tableFormats.extension(path)).sort();
			files.replaceChildren(...paths.map(path => new Option("/" + path, "/" + path)));
			if (paths.length) files.selectedIndex = 0;
			$("open-workspace").disabled = !paths.length;
			status(paths.length ? "" : "No CSV, JSONL or Parquet files in this workspace yet.");
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
	function formatNote() {
		const target = $("save-format").value;
		const notes = {
			csv: "CSV stores text. Null and missing values become empty fields. Nested values use JSON text.",
			jsonl: "Each row becomes one JSON value. Object fields missing from a row are omitted. Empty files have no column names.",
			parquet: "Parquet stores typed columns. Missing values become null. CSV fields remain text."
		};
		$("format-note").textContent = notes[target];
	}
	function saveDialog() {
		if (!commit()) return;
		$("save-name").value = source?.path || source?.name || "Untitled.csv";
		$("save-destination").value = !source || source.path ? "vfs" : "local";
		$("save-format").value = sheet.format; formatNote();
		show($("save-dialog")); $("save-name").focus();
	}
	$("save-as").onclick = saveDialog;
	$("save-format").onchange = () => {
		const input = $("save-name");
		input.value = input.value.replace(/\.(csv|jsonl|parquet)$/i, "") + "." + $("save-format").value;
		formatNote();
	};
	$("save-name").oninput = () => {
		const ext = tableFormats.extension($("save-name").value);
		if (ext) { $("save-format").value = ext; formatNote(); }
	};
	$("save-destination").onchange = () => {
		if ($("save-destination").value === "local") $("save-name").value = basename($("save-name").value);
	};
	async function save(target, format, as) {
		let { name, path, handle } = target;
		const workspace = path !== undefined;
		let downloaded = false;
		if (!workspace && as && window.showSaveFilePicker) {
			try {
				handle = await window.showSaveFilePicker({ suggestedName: name, types: pickerTypes.filter(t => t.description === format.toUpperCase()) });
				name = handle.name;
				if (tableFormats.extension(name) !== format) throw new Error("The file extension must match the selected format.");
			} catch (error) { if (error.name !== "SecurityError" && error.name !== "NotAllowedError") throw error; }
		}
		const original = source && !source.newParquet && revision === saved && format === sheet.format;
		const bytes = original ? source.snapshot.bytes : tableFormats.write(sheet, format);
		// Reopen conversions and Parquet encodings. Native JSONL saves retain the displayed order of sparse columns.
		const next = !original && (format === "parquet" || sheet.format !== format) ? await tableFormats.read(format, bytes) : sheet;
		const snapshot = { bytes };
		if (workspace) {
			const fs = (await window.vfsReady).fileSystem;
			path = fs.resolvePath("/", path);
			const same = path === source?.path;
			let expectedFile = same ? source.snapshot : undefined;
			if (!same) {
				try { expectedFile = await fs.readFile(path); }
				catch (error) { if (error.code !== "ENOENT") throw error; }
				if (expectedFile && !window.confirm(`Replace the existing file ${path}?`)) return;
			}
			snapshot.mtime = await fs.write(path, bytes, { exclusive: !expectedFile, expectedFile, returnMtime: true });
		} else if (handle) {
			const same = source?.handle && (handle === source.handle || await handle.isSameEntry(source.handle));
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
		source = { name, path, handle, snapshot };
		if (sheet !== next) {
			sheet = next; past.length = future.length = 0;
		}
		saved = revision; render(); updateUrl(path);
		status(downloaded ? "Downloaded " + name + "." : "Saved " + (path || name) + ".");
	}
	$("save-table").onclick = () => {
		if (!source) { saveDialog(); return; }
		if (commit()) run(() => save(source, sheet.format, false));
	};
	$("save-form").onsubmit = event => {
		event.preventDefault();
		const format = $("save-format").value, workspace = $("save-destination").value === "vfs";
		let input = $("save-name").value.trim();
		if (!input || input.endsWith("/") || /(^|\/)\.{1,2}$/.test(input)) { status("Enter a file name.", true); return; }
		if (!tableFormats.extension(input)) input += "." + format;
		const name = basename(input);
		const path = workspace ? (input.startsWith("/") ? input : (source?.path?.slice(0, -source.name.length) || "/") + input) : undefined;
		run(() => save({ name, path }, format, true));
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
	reset(empty(), null);
	const requested = new URLSearchParams(location.search).get("file");
	const initialSheet = sheet;
	async function restoreTable(settings) {
		if (sheet !== initialSheet || changed() || inline || document.querySelector("dialog[open]")) return;
		lastView = settings.view;
		const path = requested || lastView?.file;
		if (typeof path !== "string" || !path.startsWith("/") || !tableFormats.extension(path)) {
			if (requested) await openWorkspace(requested);
			return;
		}
		try { await openWorkspace(path); }
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
