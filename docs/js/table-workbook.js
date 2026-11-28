"use strict";

const tableWorkbook = (() => {
	const libraryUrl = new URL("vendor/exceljs-4.4.0.min.js",document.currentScript.src);
	let loading;
	function library() {
		if (!loading) loading = new Promise((resolve,reject) => {
			const script = document.createElement("script"); script.src = libraryUrl;
			script.onload = () => resolve(window.ExcelJS);
			script.onerror = () => { loading = null; script.remove(); reject(new Error("Could not load the XLSX reader.")); };
			document.head.append(script);
		});
		return loading;
	}
	const day = 86400000, epoch = Date.UTC(1899,11,30);
	const dateSerial = date => (date.getTime() - epoch) / day;
	function serial(date) {
		const n = dateSerial(date); return n < 61 ? n-1 : n;
	}
	function parseDate(text) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || text < "1900-01-01") return null;
		const date = new Date(text + "T00:00:00Z");
		return Number.isFinite(+date) && date.toISOString().startsWith(text) ? date : null;
	}
	function dateText(value) {
		if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
		const n = tableSheet.numeric(value);
		if (n === null || Number(n) < 1 || Number(n) >= 2958466) return null;
		if (Math.floor(Number(n)) === 60) return "1900-02-29";
		return new Date(epoch + (Number(n) + (Number(n) < 60 ? 1 : 0)) * day).toISOString().slice(0,10);
	}
	const {createSheet: empty, defaultRowCount} = Workbook;
	const conditions = {
		negative: { operator:"lessThan", color:"FF9B2626" },
		positive: { operator:"greaterThan", color:"FF18643D" },
		zero: { operator:"equal", color:"FF795818" }
	};
	function readStyle(cell) {
		const style = {}, fmt = cell.numFmt || "";
		if (cell.value instanceof Date || /[yd]/i.test(fmt.replace(/"[^"]*"|\[[^\]]*\]/g,"")) && !/General/i.test(fmt)) style.format = "date";
		else if (fmt.includes("%")) style.format = "percent";
		else if (fmt.includes("€")) style.format = "currency";
		else if (/[0#]/.test(fmt)) style.format = "number";
		if (style.format && style.format !== "date") style.digits = Math.min(20, /\.([0#]+)/.exec(fmt)?.[1].length || 0);
		if (cell.alignment?.horizontal) style.align = cell.alignment.horizontal;
		if (cell.alignment?.wrapText) style.wrap = true;
		const color = cell.fill?.fgColor?.argb;
		if (color && cell.fill.pattern === "solid") style.color = "#" + color.slice(-6);
		return style;
	}
	function external(value) {
		if (value instanceof Date) return serial(value);
		if (value?.richText) return value.richText.map(run => run.text).join("");
		if (value?.hyperlink) return value.text || value.hyperlink;
		return value?.error || value;
	}
	function conditionRanges(ws, tab) {
		for (const {ref,rules} of ws.conditionalFormattings || []) for (const rule of rules) {
			const condition = Object.keys(conditions).find(k => conditions[k].operator === rule.operator);
			if (!condition || rule.type !== "cellIs" || String(rule.formulae?.[0]) !== "0") continue;
			for (const range of ref.split(/\s+/)) {
				const ends = range.replaceAll("$","").split(":");
				if (!ends.every(x => /^[A-Z]{1,3}[1-9]\d*$/.test(x))) continue;
				const a = ws.getCell(ends[0]), b = ws.getCell(ends.at(-1));
				for (let r=a.row-1; r<Math.min(b.row,tab.rows.length); r++) {
					const row = tab.rows[r]; if (!tab.styles.has(row)) tab.styles.set(row,new Map());
					for (let c=a.col-1; c<Math.min(b.col,tab.columns.length); c++) {
						const col = tab.columns[c]; tab.styles.get(row).set(col,{...tab.styles.get(row).get(col),condition});
					}
				}
			}
		}
	}
	const metadata = "SUSI table layout v1\n";
	// Excel displays the last calculated values. A marked, very hidden sheet
	// holds our expressions and answer index, including text beyond Excel’s cell limit.
	const modelMarker = "SUSI Table LLM v1";
	// Excel's visible strings must fit a cell and contain XML-compatible text.
	// The answer index retains the exact string, including longer model responses.
	function modelPreview(value) {
		return typeof value === "string"
			? value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,"")
				.replace(/\r\n?/g,"\n").slice(0,32767).replace(/[\uD800-\uDBFF]$/,"")
			: value;
	}
	function writeModelSheet(book, name, data) {
		const ws = book.addWorksheet(name,{state:"veryHidden"});
		ws.addRow([modelMarker]);
		const bytes = new TextEncoder().encode(JSON.stringify(data));
		for (let i=0; i<bytes.length; i+=18000) {
			ws.addRow([btoa(String.fromCharCode(...bytes.subarray(i,i+18000)))]);
		}
	}
	function readModelSheet(ws) {
		if (ws?.getCell("A1").value !== modelMarker) throw new Error("The workbook’s LLM metadata sheet is missing or invalid.");
		const decoder = new TextDecoder(), parts = [];
		for (let r=2; r<=ws.rowCount; r++) {
			const chunk = atob(ws.getCell(r,1).text);
			parts.push(decoder.decode(Uint8Array.from(chunk,ch => ch.charCodeAt(0)),{stream:true}));
		}
		parts.push(decoder.decode());
		const data = JSON.parse(parts.join(""));
		if (!Array.isArray(data.cells) || !Array.isArray(data.answers)) throw new Error("Invalid workbook LLM metadata.");
		return data;
	}
	async function read(bytes) {
		const {Workbook} = await library();
		const book = new Workbook(); await book.xlsx.load(bytes);
		let layouts = [];
		if (book.description?.startsWith(metadata)) {
			try { layouts = JSON.parse(book.description.slice(metadata.length)); } catch { /* optional layout */ }
		}
		const modelName = Array.isArray(layouts) && layouts[0]?.modelSheet;
		const modelSheet = modelName && book.getWorksheet(modelName);
		const modelData = modelName ? readModelSheet(modelSheet) : null;
		const tabsById = new Map();
		const helpers = Array.isArray(layouts?.[0]?.chartDataSheets) ? layouts[0].chartDataSheets : [];
		const tabs = book.worksheets.filter(ws => ws !== modelSheet && !(ws.state === "veryHidden" && helpers.includes(ws.name))).map(ws => {
			const layout = Array.isArray(layouts) && layouts.find(x => x?.name === ws.name);
			// An empty CSV or a header-only CSV can legitimately have no data rows.
			const csvLayout = typeof layout?.csv?.header === "boolean";
			const minimum = csvLayout ? 0 : 1;
			const nr = Math.max(minimum,ws.rowCount, Number.isSafeInteger(layout?.rows) ? layout.rows : 0);
			let nc = Math.max(minimum,Array.isArray(layout?.columns) ? layout.columns.length : 0);
			if (nr > 1048576) throw new Error("Worksheet row numbers exceed the Excel limit.");
			const lines = [];
			const lastRow = ws.rowCount;
			for (let r=1; r<=lastRow; r++) {
				const line = ws.findRow(r);
				if (line) { lines.push(line); nc = Math.max(nc,line.cellCount); }
			}
			if (nc > 16384) throw new Error("Worksheet column numbers exceed the Excel limit.");
			const tab = empty(ws.name,nr,nc);
			if (Array.isArray(layout?.charts)) tab.charts = layout.charts.filter(chart => tableCharts.valid(chart,tab));
			tab.columns.forEach((col,c) => { if (typeof layout?.columns?.[c] === "string") col.name = layout.columns[c]; });
			if (csvLayout) {
				const csv = layout.csv;
				tab.csv = {header: csv.header};
				if ([",",";","\t"].includes(csv.delimiter)) tab.csv.delimiter = csv.delimiter;
				if (["\n","\r","\r\n"].includes(csv.eol)) tab.csv.eol = csv.eol;
				if (["utf-8","utf-16le","utf-16be"].includes(csv.encoding)) tab.csv.encoding = csv.encoding;
				for (const key of ["trailing","bom"]) if (typeof csv[key] === "boolean") tab.csv[key] = csv[key];
				if (Array.isArray(layout.implicitColumns)) for (const c of layout.implicitColumns) {
					if (Number.isInteger(c) && tab.columns[c]) tab.columns[c].implicit = true;
				}
			}
			lines.forEach(line => line.eachCell({includeEmpty:true},(cell,c) => {
				const cells = tab.rows[line.number-1], value = cell.value;
				if (cell.formula) cells[c-1] = new tableCalc.Formula(tableCalc.fromExcel(cell.formula));
				else if (value != null) cells[c-1] = external(value);
				const style = readStyle(cell);
				if (Object.keys(style).length) {
					if (!tab.styles.has(cells)) tab.styles.set(cells,new Map());
					tab.styles.get(cells).set(tab.columns[c-1],style);
				}
			}));
			tabsById.set(ws.id,tab);
			conditionRanges(ws,tab);
			return tab;
		});
		if (modelData) {
			for (const [id,r,c,expression,visible] of modelData.cells) {
				const tab = tabsById.get(id);
				if (!Number.isInteger(r) || !Number.isInteger(c) || !tab?.rows[r] || !tab.columns[c] || typeof expression !== "string") continue;
				// Respect a cell overwritten in Excel between editor sessions.
				const value = tab.rows[r][c] ?? "";
				if (value === visible) tab.rows[r][c] = new tableCalc.Formula(modelData.formulaLanguage === undefined
					? tableCalc.fromLegacyModelFormula(expression) : expression);
			}
			tabs.modelAnswers = modelData.answers;
		}
		tabs.fromEditor = book.description?.startsWith(metadata) === true;
		if (!tabs.length) throw new Error("This workbook contains no worksheets.");
		return tabs;
	}
	function excelValue(v) {
		if (tableFormats.isNumber(v)) {
			const n = Number(String(v));
			return Number.isFinite(n) && (typeof v === "number" || LosslessJSON.compareNumber(String(n),String(v)) === 0) ? n : String(v);
		}
		return v != null && typeof v === "object" ? tableFormats.textValue(v) : v ?? null;
	}
	function writeStyle(cell, style) {
		const decimals = style.digits ?? 2, decimal = decimals ? "." + "0".repeat(decimals) : "";
		if (style.format === "date") cell.numFmt = "yyyy-mm-dd";
		if (style.format === "currency") cell.numFmt = '"€"#,##0' + decimal;
		if (style.format === "number") cell.numFmt = "0" + decimal;
		if (style.format === "percent") cell.numFmt = "0" + decimal + "%";
		if (style.align || style.wrap) cell.alignment = {horizontal:style.align,wrapText:!!style.wrap};
		if (style.color) cell.fill = {type:"pattern",pattern:"solid",fgColor:{argb:"FF"+style.color.slice(1).toUpperCase()}};
	}
	async function write(tabs, calculate, answers = []) {
		const {Workbook} = await library();
		const book = new Workbook(); book.calcProperties.fullCalcOnLoad = true;
		const layouts = tabs.map(t => ({name:t.name,rows:t.rows.length,columns:t.columns.map(c => c.name),charts:t.charts?.length ? t.charts : undefined,
			csv:t.csv ?? (t.format === "csv" ? {header:true} : undefined),
			implicitColumns:t.csv && t.columns.flatMap((column,c) => column.implicit ? [c] : [])}));
		const modelCells = [];
		for (const tab of tabs) {
			const ws = book.addWorksheet(tab.name);
			tab.rows.forEach((row,r) => {
				const styles = tab.styles?.get(row);
				const indexes = new Set(Object.keys(row).map(Number));
				if (styles) for (const col of styles.keys()) { const c = tab.columns.indexOf(col); if (c >= 0) indexes.add(c); }
				for (const c of indexes) {
					const v = row[c], style = styles?.get(tab.columns[c]);
					if (v == null && !style) continue;
					const cell = ws.getCell(r+1,c+1);
					if (v instanceof tableCalc.Formula) {
						const result = excelValue(calculate(tab,r,c));
						if (v.usesLLM) {
							const visible = modelPreview(result);
							cell.value = visible;
							modelCells.push([ws.id,r,c,v.expression,visible]);
						} else cell.value = { formula:tableCalc.excel(v.expression), result:typeof result === "string" && /^#(?:REF!|DIV\/0!|NAME\?|NUM!|VALUE!|CIRC!|N\/A)$/.test(result) ? {error:result === "#CIRC!" ? "#VALUE!" : result} : result };
					} else cell.value = excelValue(v);
					if (!style) continue;
					writeStyle(cell,style);
					const rule = conditions[style.condition];
					if (rule) ws.addConditionalFormatting({ref:cell.address,rules:[{type:"cellIs",operator:rule.operator,formulae:[0],
						style:{fill:{type:"pattern",pattern:"solid",bgColor:{argb:rule.color},fgColor:{argb:rule.color}}}}]});
				}
			});
		}
		if (modelCells.length) {
			const names = new Set(tabs.map(t => t.name.toLowerCase()));
			let name = "_SUSI_LLM", i = 1;
			while (names.has(name.toLowerCase())) name = "_SUSI_LLM_" + i++;
			layouts[0].modelSheet = name;
			writeModelSheet(book,name,{cells:modelCells,answers,formulaLanguage:"en"});
		}
		const drawings = tableChartXlsx.prepare(book,tabs,calculate,layouts);
		book.description = metadata + JSON.stringify(layouts);
		return tableChartXlsx.embed(new Uint8Array(await book.xlsx.writeBuffer()),drawings);
	}
	return {empty, defaultRowCount, read, write, dateText, parseDate, serial};
})();
