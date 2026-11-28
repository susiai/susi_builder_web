"use strict";

globalThis.Workbook = (() => {
	function indexIn(index, length) {
		if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError("Index outside the worksheet.");
	}

	function checkGrid(rows, columns) {
		if (!Array.isArray(rows) || !rows.every(Array.isArray) || !Array.isArray(columns) ||
			!columns.every(column => typeof column?.name === "string")) {
			throw new TypeError("A worksheet needs row arrays and named columns.");
		}
	}

	function deletionIndices(indices, length) {
		const sorted = [...new Set(indices)].sort((a,b) => a-b);
		for (const i of sorted) indexIn(i,length);
		return sorted;
	}

	function relocate(items, from, to) {
		if (from >= items.length && to >= items.length) return;
		const present = Object.hasOwn(items,from);
		const [item] = items.splice(from,1);
		if (to > items.length) items.length = to;
		items.splice(to,0,item);
		if (!present) delete items[to];
	}

	function setStyle(styles, row, column, style) {
		let map = styles.get(row);
		if (style && Object.keys(style).length) {
			if (!map) styles.set(row, map = new Map());
			map.set(column,style);
		} else if (map) {
			map.delete(column);
			if (!map.size) styles.delete(row);
		}
	}

	return class Workbook {
		#sheets;
		#active;
		#past = [];
		#future = [];
		#sequence = 0;
		#revision = 0;
		#dataRevision = 0;
		#saved = 0;
		#savedData = 0;
		#calculate;
		#lookupAnswer;
		#onSelect;
		#onChange;

		static get defaultRowCount() { return 16; }

		static createSheet(name = "Sheet1", rows = Workbook.defaultRowCount, columns = 10) {
			if (!Number.isSafeInteger(rows) || rows < 0 || rows > 1048576 ||
				!Number.isSafeInteger(columns) || columns < 0 || columns > 16384) throw new RangeError("Invalid XLSX sheet dimensions.");
			return { format: "xlsx", name, columns: Array.from({length: columns}, (_,c) => ({name: tableCalc.letters(c)})),
				rows: Array.from({length: rows}, () => []), styles: new Map() };
		}

		static stylesFromRecords(sheet, records) {
			const styles = new Map();
			for (const [r,c,style] of records) {
				if (sheet.rows[r] && sheet.columns[c]) setStyle(styles,sheet.rows[r],sheet.columns[c],style);
			}
			return styles;
		}

		constructor(sheets = [Workbook.createSheet()], {activeSheet = sheets[0], lookupAnswer, onSelect, onChange} = {}) {
			if (!activeSheet || !sheets.includes(activeSheet)) throw new Error("Choose a worksheet in this workbook.");
			const names = new Set();
			for (const [i,sheet] of sheets.entries()) {
				checkGrid(sheet.rows,sheet.columns);
				const name = sheet.name || "Sheet" + (i+1);
				if (typeof name !== "string" || names.has(name.toLowerCase())) throw new Error("Worksheet names must be unique.");
				names.add(name.toLowerCase());
			}
			this.#sheets = Object.freeze([...sheets]);
			for (const [i, sheet] of sheets.entries()) {
				sheet.name ||= "Sheet" + (i+1);
				sheet.styles ??= new Map();
			}
			this.#active = activeSheet;
			this.#lookupAnswer = lookupAnswer;
			this.#onSelect = onSelect;
			this.#onChange = onChange;
		}

		get sheets() { return this.#sheets; }
		get activeSheet() { return this.#active; }
		get revision() { return this.#revision; }
		get dirty() { return this.#revision !== this.#saved; }
		get dataDirty() { return this.#dataRevision !== this.#savedData; }
		get canUndo() { return this.#past.length > 0; }
		get canRedo() { return this.#future.length > 0; }

		markSaved() {
			this.#saved = this.#revision;
			this.#savedData = this.#dataRevision;
		}

		selectSheet(sheet) {
			if (!this.#sheets.includes(sheet)) throw new Error("Unknown worksheet.");
			if (sheet === this.#active) return;
			this.#active = sheet;
			this.#onSelect?.(sheet);
		}

		get calculator() {
			return this.#calculate ??= tableCalc.calculator(this.#sheets,this.#lookupAnswer);
		}

		invalidateCalculation() { this.#calculate = undefined; }

		modeChangeWarnings(format) {
			const sheet = this.#active;
			if (format === sheet.format) return [];
			const warnings = [];
			if (sheet.columns.some(column => column.field)) warnings.push("Column type restrictions will be removed.");
			if (format === "csv") {
				const others = this.#sheets.filter(tab => tab !== sheet);
				if (others.length) warnings.push("Only “" + sheet.name + "” will be kept. The following sheets will be removed — " + others.map(tab => tab.name).join(", ") + ".");
				if (sheet.name !== "Sheet1") warnings.push("The worksheet name “" + sheet.name + "” will be lost.");
				if (sheet.rows.some(row => row.some(value => value instanceof tableCalc.Formula)))
					warnings.push("Formulas will be replaced by their calculated results, including any errors.");
				if (sheet.rows.some(row => row.some(value => typeof value !== "string" && value !== undefined && !(value instanceof tableCalc.Formula))))
					warnings.push("Typed cell values will become text. Null values become empty fields.");
				if (sheet.styles.size) warnings.push("Cell formatting will be removed. Formatted numbers and dates will use their underlying values.");
				if (sheet.charts?.length) warnings.push("Charts on this worksheet will be removed.");
			}
			return warnings;
		}

		switchMode(format) {
			const sheet = this.#active;
			if (format === sheet.format) return;
			if (!["xlsx","csv"].includes(format) || !["xlsx","csv"].includes(sheet.format))
				throw new Error("Choose a CSV table or an XLSX workbook.");
			if (format === "xlsx" && (sheet.rows.length > 1048576 || sheet.columns.length > 16384))
				throw new Error("This table exceeds Excel’s worksheet dimensions.");
			const previousSheets = this.#sheets;
			const before = {format: sheet.format, rows: sheet.rows, name: sheet.name, styles: sheet.styles, charts: sheet.charts, csv: sheet.csv};
			const next = {...before, format};
			const fields = sheet.columns.filter(column => column.field).map(column => [column,column.field]);
			if (format === "csv") {
				// Resolve cross-sheet references while all original worksheets are still available.
				const calculate = this.calculator;
				next.rows = sheet.rows.map((row,r) => row.map((value,c) =>
					tableFormats.textValue(value instanceof tableCalc.Formula ? calculate(sheet,r,c) : value)));
				next.name = "Sheet1";
				next.styles = new Map();
				next.charts = [];
				next.csv ??= {header: sheet.columns.some((column,c) => column.name !== tableCalc.letters(c))};
				// A headerless CSV needs at least one full-width record to carry empty trailing columns.
				if (!next.csv.header && next.rows.length && !next.rows.some(row => row.length === sheet.columns.length))
					next.rows[0].length = sheet.columns.length;
			} else next.csv ??= {header: true};
			const nextSheets = format === "csv" ? Object.freeze([sheet]) : previousSheets;
			this.#change(() => {
				Object.assign(sheet,next);
				this.#sheets = nextSheets;
				for (const [column] of fields) delete column.field;
			}, () => {
				Object.assign(sheet,before);
				this.#sheets = previousSheets;
				for (const [column,field] of fields) column.field = field;
			});
		}

		#notify(previousSheet, dataChanged, moved) {
			this.invalidateCalculation();
			if (this.#active !== previousSheet) this.#onSelect?.(this.#active);
			this.#onChange?.({dataChanged, moved});
		}

		// Flat files can reuse their original bytes after presentation-only edits.
		// Consecutive cut and paste steps can share an undo entry, including across worksheets.
		#change(apply, revert, {presentation = false, mergeWith, moved} = {}) {
			const step = {sheet: this.#active, apply, revert, moved};
			const before = this.#revision, beforeData = this.#dataRevision;
			apply();
			this.#revision = ++this.#sequence;
			if (!presentation) this.#dataRevision = this.#revision;
			const previous = this.#past.at(-1);
			if (previous && previous.after === mergeWith && before !== this.#saved) {
				previous.steps.push(step);
				previous.after = this.#revision;
				previous.afterData = this.#dataRevision;
			} else {
				this.#past.push({steps: [step], before, beforeData, after: this.#revision, afterData: this.#dataRevision});
				if (this.#past.length > 100) this.#past.shift();
			}
			this.#future.length = 0;
			this.#notify(step.sheet,!presentation, moved && {axis: moved.axis, index: moved.to});
		}

		undo() { return this.#replay(false); }
		redo() { return this.#replay(true); }

		#replay(forward) {
			const source = forward ? this.#future : this.#past, entry = source.at(-1);
			if (!entry) return false;
			const previousSheet = this.#active;
			const steps = forward ? entry.steps : [...entry.steps].reverse();
			for (const step of steps) {
				this.#active = step.sheet;
				if (forward) step.apply(); else step.revert();
			}
			source.pop();
			(forward ? this.#past : this.#future).push(entry);
			this.#revision = forward ? entry.after : entry.before;
			this.#dataRevision = forward ? entry.afterData : entry.beforeData;
			const moved = steps.at(-1).moved;
			this.#notify(previousSheet,entry.beforeData !== entry.afterData, moved && {axis: moved.axis, index: forward ? moved.to : moved.from});
			return true;
		}

		#uniqueName(base) {
			const names = new Set(this.#sheets.map(sheet => sheet.name.toLowerCase()));
			for (let i = 1; ; i++) {
				const suffix = String(i), name = base.slice(0,31-suffix.length) + suffix;
				if (!names.has(name.toLowerCase())) return name;
			}
		}

		#checkName(name, except) {
			if (typeof name !== "string" || !name.trim() || name.length > 31 || /[\\/*?:\[\]]|^'|'$/.test(name) ||
				name.toLowerCase() === "history" || this.#sheets.some(s => s !== except && s.name.toLowerCase() === name.toLowerCase())) {
				throw new Error("Enter a unique Excel sheet name of up to 31 characters without / \\ * ? : [ ] or outer apostrophes.");
			}
		}

		addSheet(sheet = Workbook.createSheet(this.#uniqueName("Sheet"))) {
			this.#checkName(sheet.name);
			checkGrid(sheet.rows,sheet.columns);
			sheet.styles ??= new Map();
			const previous = this.#active, before = this.#sheets, next = [...before];
			next.splice(next.indexOf(previous)+1,0,sheet);
			Object.freeze(next);
			this.#change(() => { this.#sheets = next; this.#active = sheet; },
				() => { this.#active = previous; this.#sheets = before; });
			return sheet;
		}

		duplicateSheet() {
			const source = this.#active, name = this.#uniqueName(source.name + " ");
			const next = {format: "xlsx", name, columns: source.columns.map(col => ({name: col.name})),
				rows: source.rows.map(cells => cells.map(v => v instanceof tableCalc.Formula ?
					new tableCalc.Formula(tableCalc.rename(v.expression,source.name,name)) : v)),
				charts: structuredClone(source.charts || []), styles: new Map()};
			const columns = new Map(source.columns.map((column,i) => [column,next.columns[i]]));
			source.rows.forEach((row,i) => {
				for (const [column,style] of source.styles.get(row) || []) {
					if (columns.has(column)) setStyle(next.styles,next.rows[i],columns.get(column),{...style});
				}
			});
			return this.addSheet(next);
		}

		moveSheet(to) {
			const before = this.#sheets, from = before.indexOf(this.#active);
			indexIn(to,before.length);
			if (from === to) return;
			const next = [...before];
			relocate(next,from,to);
			Object.freeze(next);
			this.#change(() => { this.#sheets = next; }, () => { this.#sheets = before; });
		}

		#formulaEdits(transform) {
			const edits = [];
			for (const sheet of this.#sheets) for (const cells of sheet.rows) cells.forEach((value,c) => {
				if (!(value instanceof tableCalc.Formula)) return;
				const expression = transform(value.expression,sheet);
				if (expression !== value.expression) edits.push({cells,c,before: value,after: new tableCalc.Formula(expression)});
			});
			return edits;
		}

		renameSheet(name) {
			const sheet = this.#active, before = sheet.name;
			this.#checkName(name,sheet);
			if (name === before) return;
			const edits = this.#formulaEdits(expr => tableCalc.rename(expr,before,name));
			this.#change(() => { sheet.name = name; for (const e of edits) e.cells[e.c] = e.after; },
				() => { sheet.name = before; for (const e of edits) e.cells[e.c] = e.before; });
		}

		#layout(axis, apply, revert, moved) {
			const sheet = this.#active, items = axis === "row" ? sheet.rows : sheet.columns;
			const before = [...items], charts = sheet.charts;
			let edits, nextCharts;
			this.#change(() => {
				apply();
				if (!edits) {
					try {
						const indices = new Map(items.map((item,i) => [item,i]));
						const remap = i => i < before.length ? indices.get(before[i]) ?? -1 : i + items.length - before.length;
						nextCharts = charts?.map(chart => tableCharts.remap(chart,axis,remap,items.length > before.length));
						edits = this.#formulaEdits((expr,home) => tableCalc.relayout(expr,home.name,sheet.name,axis,remap));
					} catch (error) { revert(); throw error; }
				}
				if (charts) sheet.charts = nextCharts;
				for (const edit of edits) edit.cells[edit.c] = edit.after;
			}, () => {
				if (charts) sheet.charts = charts;
				for (const edit of edits) edit.cells[edit.c] = edit.before;
				revert();
			}, {moved});
		}

		blankRow() {
			const sheet = this.#active;
			return sheet.columns.map(col => col.field || sheet.values ? null : sheet.format === "csv" ? "" : undefined);
		}

		insertRows(index, count = 1) {
			const rows = this.#active.rows;
			indexIn(index,rows.length+1);
			if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("Choose a positive row count.");
			const added = Array.from({length: count}, () => this.blankRow());
			this.#layout("row", () => added.forEach((row,i) => rows.splice(index+i,0,row)), () => rows.splice(index,count));
		}

		// Appending materializes cells at existing addresses, including addresses referenced by formulas.
		appendRow() {
			const rows = this.#active.rows, row = this.blankRow();
			this.#change(() => rows.push(row), () => rows.pop());
		}

		deleteRows(indices) {
			const {rows,styles} = this.#active;
			const removed = deletionIndices(indices,rows.length).map(i => ({i,row:rows[i],styles:styles.get(rows[i])}));
			if (!removed.length) return;
			this.#layout("row", () => {
				for (let n = removed.length-1; n >= 0; n--) {
					rows.splice(removed[n].i,1);
					styles.delete(removed[n].row);
				}
			}, () => {
				for (const item of removed) {
					rows.splice(item.i,0,item.row);
					if (item.styles) styles.set(item.row,item.styles);
				}
			});
		}

		deleteColumns(indices) {
			const sheet = this.#active, sorted = deletionIndices(indices,sheet.columns.length);
			if (!sorted.length) return;
			if (sheet.values || sorted.length === sheet.columns.length) throw new Error("Keep at least one column.");
			const removed = sorted.map(i => sheet.columns[i]);
			const hole = Symbol();
			const originals = sheet.rows.map(row => ({width: row.length, values: sorted.map(c => Object.hasOwn(row,c) ? row[c] : hole)}));
			const removedStyles = [];
			const columns = new Set(removed);
			for (const [row,styles] of sheet.styles) for (const [column,style] of styles) {
				if (columns.has(column)) removedStyles.push({row,column,style});
			}
			this.#layout("column", () => {
				for (let n = sorted.length-1; n >= 0; n--) {
					sheet.columns.splice(sorted[n],1);
					for (const row of sheet.rows) row.splice(sorted[n],1);
				}
				for (const {row,column} of removedStyles) setStyle(sheet.styles,row,column,null);
			}, () => {
				sorted.forEach((c,n) => {
					sheet.columns.splice(c,0,removed[n]);
					sheet.rows.forEach((row,r) => {
						if (c >= originals[r].width) return;
						const value = originals[r].values[n];
						row.splice(c,0,value);
						if (value === hole) delete row[c];
					});
				});
				for (const {row,column,style} of removedStyles) setStyle(sheet.styles,row,column,style);
			});
		}

		move(axis, from, to) {
			if (axis !== "row" && axis !== "column") throw new Error("Choose a row or column.");
			const sheet = this.#active, columns = axis === "column", items = columns ? sheet.columns : sheet.rows;
			indexIn(from,items.length); indexIn(to,items.length);
			if (from === to) return;
			const widths = columns && sheet.rows.map(row => row.length);
			const move = (start,end,restoring) => {
				relocate(items,start,end);
				if (columns) sheet.rows.forEach((row,r) => {
					relocate(row,start,end);
					if (restoring) row.length = widths[r];
					else if (sheet.format === "csv") while (row.length && row.at(-1) === undefined) row.pop();
				});
			};
			this.#layout(axis, () => move(from,to,false), () => move(to,from,true), {axis,from,to});
		}

		#checkColumn(name, except) {
			const sheet = this.#active;
			if (typeof name !== "string") throw new TypeError("A column name must be text.");
			if (sheet.values) throw new Error("This worksheet has a fixed value column.");
			if (sheet.format !== "csv" && sheet.columns.some(c => c !== except && c.name === name))
				throw new Error("A column with this name already exists.");
		}

		appendColumn(column) {
			const sheet = this.#active, index = sheet.columns.length, widths = sheet.rows.map(row => row.length);
			this.#checkColumn(column.name);
			const headerless = sheet.csv?.header === false;
			this.#change(() => {
				sheet.columns.push(column);
				if (headerless) sheet.csv.header = true;
				for (const row of sheet.rows) row[index] = sheet.format === "csv" ? "" : null;
			}, () => {
				sheet.columns.pop();
				sheet.rows.forEach((row,i) => { row.length = widths[i]; });
				if (headerless) sheet.csv.header = false;
			});
		}

		renameColumn(index, name) {
			const sheet = this.#active;
			indexIn(index,sheet.columns.length);
			const column = sheet.columns[index], previous = column.name, implicit = column.implicit;
			this.#checkColumn(name,column);
			const headerless = sheet.csv?.header === false;
			this.#change(() => {
				column.name = name; column.implicit = false;
				if (headerless) sheet.csv.header = true;
			}, () => {
				column.name = previous;
				if (implicit === undefined) delete column.implicit; else column.implicit = implicit;
				if (headerless) sheet.csv.header = false;
			});
		}

		setCharts(charts) {
			const sheet = this.#active, before = sheet.charts;
			this.#change(() => { sheet.charts = charts; }, () => { sheet.charts = before; }, {presentation: true});
		}

		editCells(edits, {newRows = [], newColumns = [], fieldChange, mergeWith} = {}) {
			const sheet = this.#active, nr = sheet.rows.length, nc = sheet.columns.length;
			if (!edits.length && !newRows.length && !newColumns.length && !fieldChange) return;
			checkGrid(newRows,newColumns);
			if (newColumns.length && (sheet.format === "parquet" || sheet.values)) throw new Error("The pasted range exceeds this schema.");
			newRows = [...newRows];
			newColumns = [...newColumns];
			if (fieldChange) indexIn(fieldChange.column,nc);
			const fieldColumn = fieldChange && sheet.columns[fieldChange.column];
			const previousField = fieldColumn?.field, nextField = fieldChange?.field;
			const changes = edits.map(edit => {
				const {row, column: c} = edit;
				indexIn(row,nr+newRows.length); indexIn(c,nc+newColumns.length);
				const cells = row < nr ? sheet.rows[row] : newRows[row-nr];
				const column = c < nc ? sheet.columns[c] : newColumns[c-nc];
				return {edit: {...edit}, cells, column, c, before: cells[c], present: Object.hasOwn(cells,c),
					width: cells.length, previousStyle: sheet.styles.get(cells)?.get(column)};
			});
			const presentation = !fieldChange && !newRows.length && !newColumns.length && changes.every(e => !Object.hasOwn(e.edit,"value"));
			this.#change(() => {
				if (fieldColumn) fieldColumn.field = nextField;
				for (const column of newColumns) sheet.columns.push(column);
				for (const row of newRows) sheet.rows.push(row);
				for (const {edit,cells,column,c} of changes) {
					if (Object.hasOwn(edit,"value")) cells[c] = edit.value;
					if (Object.hasOwn(edit,"style")) setStyle(sheet.styles,cells,column,edit.style);
				}
			}, () => {
				if (fieldColumn) {
					if (previousField === undefined) delete fieldColumn.field; else fieldColumn.field = previousField;
				}
				for (const e of changes) {
					if (Object.hasOwn(e.edit,"value")) {
						if (e.present) e.cells[e.c] = e.before; else delete e.cells[e.c];
						e.cells.length = e.width;
					}
					if (Object.hasOwn(e.edit,"style")) setStyle(sheet.styles,e.cells,e.column,e.previousStyle);
				}
				sheet.rows.length = nr; sheet.columns.length = nc;
			}, {presentation,mergeWith});
		}
	};
})();
