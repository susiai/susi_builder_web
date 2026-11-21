"use strict";

// ExcelJS writes the workbook and cell formats. Add the editable DrawingML chart parts
// to that generated package, keeping chart data linked to the worksheet.
const tableChartXlsx = (() => {
	const zipUrl = new URL("vendor/zip-2.25.0.min.js",document.currentScript.src);
	const chartNS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
	const drawingNS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
	const artNS = "http://schemas.openxmlformats.org/drawingml/2006/main";
	const relNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
	const packageNS = "http://schemas.openxmlformats.org/package/2006/relationships";
	const contentType = "application/vnd.openxmlformats-officedocument.";
	let loading;
	function library() {
		if (!loading) loading = new Promise((resolve,reject) => {
			const script = document.createElement("script"); script.src = zipUrl;
			script.onload = () => resolve(window.zip);
			script.onerror = () => { loading = null; script.remove(); reject(new Error("Could not load the XLSX chart writer.")); };
			document.head.append(script);
		});
		return loading;
	}
	const xml = value => String(value).replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
	const addr = (r,c) => "$" + tableCalc.letters(c) + "$" + (r+1);
	const sheetRef = name => "'" + name.replaceAll("'","''") + "'!";
	function cache(kind,values,ref) {
		const points = values.map((v,i) => v == null ? "" : '<pt idx="'+i+'"><v>'+xml(v)+'</v></pt>').join("");
		const list = (kind === "num" ? "<formatCode>General</formatCode>" : "") + '<ptCount val="'+values.length+'"/>'+points;
		return ref ? "<"+kind+"Ref><f>"+xml(ref)+"</f><"+kind+"Cache>"+list+"</"+kind+"Cache></"+kind+"Ref>"
			: "<"+kind+"Lit>"+list+"</"+kind+"Lit>";
	}
	function axis(id,cross,tag,side) {
		return '<'+tag+'><axId val="'+id+'"/><scaling><orientation val="minMax"/></scaling><axPos val="'+side+'"/>'+
			(tag === "valAx" ? "<majorGridlines/>" : "")+'<crossAx val="'+cross+'"/><crosses val="autoZero"/></'+tag+'>';
	}
	function chartXml(chart,data,ref) {
		const tag = {bar:"barChart",line:"lineChart",pie:"pieChart"}[chart.type];
		const title = chart.title || tableCharts.types[chart.type] + " chart";
		let plot = "<"+tag+">";
		if (chart.type === "bar") plot += '<barDir val="col"/><grouping val="clustered"/>';
		if (chart.type === "line") plot += '<grouping val="standard"/>';
		if (chart.type === "pie") plot += '<varyColors val="1"/>';
		const categories = cache("str",data.categories,ref.categories);
		data.series.forEach((s,i) => {
			const name = ref.names[i] ? cache("str",[s.name],ref.names[i]) : "<v>"+xml(s.name)+"</v>";
			plot += '<ser><idx val="'+i+'"/><order val="'+i+'"/><tx>'+name+'</tx><cat>'+categories+'</cat><val>'+cache("num",s.values,ref.values[i])+'</val></ser>';
		});
		if (chart.type !== "pie") plot += '<axId val="1"/><axId val="2"/>';
		plot += "</"+tag+">";
		if (chart.type !== "pie") plot += axis(1,2,"catAx","b")+axis(2,1,"valAx","l");
		return '<chartSpace xmlns="'+chartNS+'" xmlns:a="'+artNS+'"><chart><title><tx><rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>'+xml(title)+
			'</a:t></a:r></a:p></rich></tx></title><plotArea>'+plot+'</plotArea><legend><legendPos val="b"/></legend><plotVisOnly val="0"/><dispBlanksAs val="gap"/></chart></chartSpace>';
	}
	function prepare(book,tabs,calculate,layouts) {
		const drawings = new Map();
		let helper;
		function helperSheet(rows) {
			if (!helper || helper.rowCount+rows > 1048576) {
				let i=1; while (book.getWorksheet("_SUSI_ChartData"+i)) i++;
				helper = book.addWorksheet("_SUSI_ChartData"+i,{state:"veryHidden"});
				(layouts[0].chartDataSheets ??= []).push(helper.name);
			}
			return helper;
		}
		for (const tab of tabs) {
			const ws = book.getWorksheet(tab.name), parts = [];
			for (const chart of tab.charts || []) {
				const cell = (r,c) => calculate(tab,r,c), data = tableCharts.data(chart,tab,cell);
				if (data.message) continue;
				const prefix = sheetRef(tab.name), pos = (p,s) => addr(...tableCharts.coords(chart.byRow,p,s));
				const ref = {names:[],values:[]};
				const contiguous = data.points.every((p,i) => !i || p === data.points[i-1]+1);
				function range(s,values,numeric) {
					const first = pos(data.points[0],s), last = pos(data.points.at(-1),s);
					if (contiguous && (!numeric || data.points.every((p,i) => values[i] == null || typeof cell(...tableCharts.coords(chart.byRow,p,s)) !== "string")))
						return prefix + first + ":" + last;
					// A chart series needs one contiguous Excel range. Materialize references in
					// selection order for filtered/sorted data or numeric text from imported CSVs.
					const h = helperSheet(data.points.length), start = h.rowCount+1;
					data.points.forEach((p,i) => {
						const src = prefix+pos(p,s);
						const formula = numeric ? 'IFERROR(IF('+src+'="","",IF(ISNUMBER('+src+'),'+src+',_xlfn.NUMBERVALUE(SUBSTITUTE('+src+',",","."),"."," "))),"")' : 'IF('+src+'="","",'+src+')';
						h.getCell(start+i,1).value = {formula,result:values[i] ?? ""};
					});
					return sheetRef(h.name)+"$A$"+start+":$A$"+h.rowCount;
				}
				if (data.label !== undefined) ref.categories = range(data.label,data.categories,false);
				for (const series of data.series) {
					ref.names.push(data.header !== undefined ? prefix+pos(data.header,series.index) : null);
					ref.values.push(range(series.index,series.values,true));
				}
				parts.push({xml:chartXml(chart,data,ref), col:Math.min(16383,Math.max(chart.cols[0],chart.cols.at(-1))+1)});
			}
			if (parts.length) drawings.set(ws.id,parts);
		}
		return drawings;
	}
	function drawing(part,i) {
		return '<xdr:oneCellAnchor><xdr:from><xdr:col>'+part.col+'</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>'+(i*16)+'</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="5334000" cy="2857500"/>'+
			'<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="'+(i+1)+'" name="Chart '+(i+1)+'"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'+
			'<a:graphic><a:graphicData uri="'+chartNS+'"><c:chart r:id="rId'+(i+1)+'"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>';
	}
	async function embed(bytes,drawings) {
		if (!drawings.size) return bytes;
		const zip = await library(), options = {useWebWorkers:false};
		const reader = new zip.ZipReader(new zip.Uint8ArrayReader(bytes),options);
		try {
			const entries = await reader.getEntries(), byName = new Map(entries.map(e => [e.filename,e]));
			const textOf = path => byName.get(path).getData(new zip.TextWriter(),options);
			const changed = new Map(), rels = '<Relationships xmlns="'+packageNS+'">';
			const relation = (id,type,target) => '<Relationship Id="'+id+'" Type="'+relNS+'/'+type+'" Target="'+target+'"/>';
			let overrides = "", index = 0;
			for (const [sheet,parts] of drawings) {
				const path = 'xl/worksheets/sheet'+sheet+'.xml', relPath = 'xl/worksheets/_rels/sheet'+sheet+'.xml.rels';
				const doc = await textOf(path), id = "chartDrawing";
				changed.set(path,doc.replace('</worksheet>','<drawing xmlns:r="'+relNS+'" r:id="'+id+'"/></worksheet>'));
				const existing = byName.has(relPath) ? await textOf(relPath) : rels+'</Relationships>';
				changed.set(relPath,existing.replace('</Relationships>',relation(id,"drawing","../drawings/drawing"+sheet+".xml")+'</Relationships>'));
				const base = 'xl/drawings/drawing'+sheet+'.xml';
				changed.set(base,'<xdr:wsDr xmlns:xdr="'+drawingNS+'" xmlns:a="'+artNS+'" xmlns:c="'+chartNS+'" xmlns:r="'+relNS+'">'+parts.map(drawing).join("")+'</xdr:wsDr>');
				overrides += '<Override PartName="/'+base+'" ContentType="'+contentType+'drawing+xml"/>';
				let links = "";
				parts.forEach((part,i) => {
					const file = "chart"+(++index)+".xml", target = "xl/charts/"+file;
					changed.set(target,part.xml);
					overrides += '<Override PartName="/'+target+'" ContentType="'+contentType+'drawingml.chart+xml"/>';
					links += relation("rId"+(i+1),"chart","../charts/"+file);
				});
				changed.set('xl/drawings/_rels/drawing'+sheet+'.xml.rels',rels+links+'</Relationships>');
			}
			const types = "[Content_Types].xml";
			changed.set(types,(await textOf(types)).replace("</Types>",overrides+"</Types>"));
			const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(),options);
			for (const entry of entries) {
				if (entry.directory || changed.has(entry.filename)) continue;
				await writer.add(entry.filename,new zip.Uint8ArrayReader(await entry.getData(new zip.Uint8ArrayWriter(),options)));
			}
			for (const [path,content] of changed) await writer.add(path,new zip.TextReader(content));
			return await writer.close();
		} finally { await reader.close(); }
	}
	return {prepare,embed};
})();
