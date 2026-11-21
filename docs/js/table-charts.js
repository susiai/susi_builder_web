"use strict";

const tableCharts = (() => {
	const types = {bar:"Column",line:"Line",pie:"Pie"};
	const url = new URL("../jsx/plotly-basic-4.3.0.min.js",document.currentScript.src);
	let loading;
	function library() {
		if (!loading) loading = new Promise((resolve,reject) => {
			const script = document.createElement("script"); script.src = url;
			script.onload = () => resolve(window.Plotly);
			script.onerror = () => { script.remove(); loading = null; reject(new Error("Could not load the chart renderer.")); };
			document.head.append(script);
		});
		return loading;
	}
	function number(value) {
		const text = tableSheet.numeric(value);
		return text !== null && Number.isFinite(Number(text)) ? Number(text) : null;
	}
	function coords(byRow,point,series) {
		return byRow ? [series,point] : [point,series];
	}
	function suggest(chart,cell) {
		const points = chart.byRow ? chart.cols : chart.rows, series = chart.byRow ? chart.rows : chart.cols;
		const value = (p,s) => cell(...coords(chart.byRow,p,s));
		const containsText = v => typeof v === "string" && v.trim() && number(v) === null;
		chart.headings = points.length > 1 && series.every(s => number(value(points[0],s)) === null) &&
			series.some(s => containsText(value(points[0],s)));
		chart.labels = series.length > 1 && points.slice(Number(chart.headings)).some(p => containsText(value(p,series[0])));
	}
	function data(chart,tab,cell) {
		const {byRow} = chart;
		const points = (byRow ? chart.cols : chart.rows).slice(), columns = (byRow ? chart.rows : chart.cols).slice();
		const header = chart.headings ? points.shift() : undefined, label = chart.labels ? columns.shift() : undefined;
		function textAt(p,s) {
			const [r,c] = coords(byRow,p,s), value = cell(r,c);
			return tableSheet.formatted(value,tab.styles?.get(tab.rows[r])?.get(tab.columns[c]),tableFormats.textValue(value));
		}
		const categories = points.map(p => label !== undefined ? textAt(p,label) : byRow ? tab.columns[p].name : String(p+1));
		const series = columns.map(s => ({
			index:s, name:(header !== undefined && textAt(header,s)) || (byRow ? "Row " + (s+1) : tab.columns[s].name || tableCalc.letters(s)),
			values:points.map(p => number(cell(...coords(byRow,p,s))))
		})).filter(s => s.values.some(v => v !== null));
		let message = "";
		if (!series.length) message = "Select cells containing numeric values.";
		else if (chart.type === "pie") {
			if (series.length !== 1) message = "A pie chart needs one numeric series. Select a single series or change the series direction.";
			else if (series[0].values.some(v => v < 0) || !series[0].values.some(v => v > 0)) message = "A pie chart needs nonnegative values and at least one positive value.";
		}
		return {points,header,label,categories,series,message};
	}
	function remap(chart,axis,indexOf,inserted) {
		const field = axis === "row" ? "rows" : "cols", source = chart[field], indices = [];
		for (const [i,old] of source.entries()) {
			const next = indexOf(old);
			if (next < 0) continue;
			// An insertion inside a contiguous selected range extends the chart.
			const step = old-source[i-1];
			if (inserted && Math.abs(step) === 1 && indices.length) {
				for (let j=indices.at(-1)+step; (next-j)*step > 0; j+=step) indices.push(j);
			}
			indices.push(next);
		}
		const updated = {...chart,[field]:indices};
		if (source.length && indexOf(source[0]) < 0) {
			const pointAxis = chart.byRow ? "column" : "row";
			updated[axis === pointAxis ? "headings" : "labels"] = false;
		}
		return updated;
	}
	function valid(chart,tab) {
		const axis = (indices,size) => Array.isArray(indices) && indices.every(i => Number.isInteger(i) && i >= 0 && i < size);
		return chart && Object.hasOwn(types,chart.type) && typeof chart.title === "string" &&
			["byRow","headings","labels"].every(k => typeof chart[k] === "boolean") &&
			axis(chart.rows,tab.rows.length) && axis(chart.cols,tab.columns.length);
	}
	// Plotly supports inline markup in labels. Worksheet text is always shown literally.
	const plain = text => String(text).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
	async function plot(host,chart,source) {
		const lib = await library();
		if (!host.isConnected) return;
		const ticks = source.categories.map(plain), x = ticks.map((_,i) => i);
		const traces = source.series.map(s => chart.type === "pie"
			? {type:"pie",labels:ticks,values:s.values,sort:false,textinfo:"percent",customdata:ticks,hovertemplate:"%{customdata}: %{value}<extra></extra>",ids:x.map(String)}
			: {type:chart.type === "line" ? "scatter" : "bar",mode:"lines+markers",name:plain(s.name),
				x,y:s.values,customdata:ticks,hovertemplate:"%{customdata}: %{y}<extra>%{fullData.name}</extra>"});
		const css = getComputedStyle(host);
		const layout = {autosize:true,height:235,margin:{l:55,r:18,t:12,b:42},paper_bgcolor:"transparent",plot_bgcolor:"transparent",
			font:{color:css.color,family:css.fontFamily},colorway:["#60a5fa","#fbbf24","#34d399","#fb7185","#c084fc","#22d3ee"],
			showlegend:chart.type === "pie" || traces.length > 1,legend:{orientation:"h"},barmode:"group",
			xaxis:{tickmode:"array",tickvals:[],ticktext:[],automargin:true},yaxis:{automargin:true,gridcolor:css.getPropertyValue("--color-border")}};
		const stride = Math.max(1,Math.ceil(x.length/10));
		for (let i=0; i<x.length; i+=stride) { layout.xaxis.tickvals.push(i); layout.xaxis.ticktext.push(ticks[i]); }
		await lib.newPlot(host,traces,layout,{responsive:true,displayModeBar:false,displaylogo:false});
		if (!host.isConnected) lib.purge(host);
	}
	return {types,coords,suggest,data,remap,valid,plot};
})();

function tableChartPanel($,show,commit,apply) {
	let sheet,calculate,draft,editing;
	const panel = $("sheet-charts"), preview = $("chart-preview"), dialog = $("chart-dialog");
	const cell = (r,c) => calculate(sheet,r,c);
	function clear(parent) {
		for (const host of parent.querySelectorAll(".js-plotly-plot")) window.Plotly?.purge(host);
		parent.replaceChildren();
	}
	function draw(parent,chart,source) {
		if (source.message) { parent.textContent = source.message; return; }
		const host = document.createElement("div"); host.className = "chart-plot";
		host.setAttribute("role","img"); host.setAttribute("aria-label",chart.title || tableCharts.types[chart.type] + " chart");
		parent.append(host);
		tableCharts.plot(host,chart,source).catch(error => { host.textContent = error.message; });
	}
	function refreshPreview() {
		draft.type = $("chart-type").value;
		draft.title = $("chart-title").value.trim();
		draft.headings = $("chart-headings").checked; draft.labels = $("chart-labels").checked;
		const source = tableCharts.data(draft,sheet,cell);
		$("chart-apply").disabled = !!source.message;
		clear(preview); draw(preview,draft,source);
	}
	function direction() {
		$("chart-headings-label").textContent = "Series names in first " + (draft.byRow ? "column" : "row");
		$("chart-labels-label").textContent = "Category labels in first " + (draft.byRow ? "row" : "column");
		$("chart-headings").checked = draft.headings; $("chart-labels").checked = draft.labels;
	}
	$("chart-direction").onchange = () => {
		draft.byRow = $("chart-direction").value === "rows";
		tableCharts.suggest(draft,cell); direction(); refreshPreview();
	};
	for (const id of ["chart-type","chart-headings","chart-labels"]) $(id).onchange = refreshPreview;
	function open(selection,index) {
		editing = index;
		draft = index === undefined ? {...selection,type:"bar",title:"",byRow:selection.rows.length === 1 && selection.cols.length > 1}
			: {...sheet.charts[index]};
		if (index === undefined) tableCharts.suggest(draft,cell);
		$("chart-type").value = draft.type; $("chart-title").value = draft.title;
		$("chart-direction").value = draft.byRow ? "rows" : "columns";
		$("chart-source").textContent = sheet.name + " · " + draft.rows.length + " rows × " + draft.cols.length + " columns";
		$("chart-heading").textContent = index === undefined ? "Chart from selection" : "Edit chart";
		$("chart-apply").textContent = index === undefined ? "Insert" : "Apply";
		direction(); show(dialog); refreshPreview();
	}
	dialog.addEventListener("close",() => clear(preview));
	$("chart-form").onsubmit = event => {
		event.preventDefault();
		if ($("chart-apply").disabled) return;
		draft.title = $("chart-title").value.trim();
		const charts = [...sheet.charts || []];
		charts[editing ?? charts.length] = draft;
		dialog.close(); apply(charts);
		panel.children[editing ?? charts.length-1]?.scrollIntoView({block:"nearest",inline:"nearest"});
	};
	function render(tab,read) {
		if (tab === sheet && read === calculate) return;
		sheet = tab; calculate = read; clear(panel);
		panel.hidden = !tab.charts?.length;
		for (const [i,chart] of (tab.charts || []).entries()) {
			const card = document.createElement("article"), header = document.createElement("header"), title = document.createElement("h3");
			card.className = "sheet-chart"; title.textContent = chart.title || tableCharts.types[chart.type] + " chart";
			header.append(title);
			for (const action of ["Edit","Remove"]) {
				const button = document.createElement("button"); button.textContent = action; button.type = "button";
				button.setAttribute("aria-label",action + " " + title.textContent);
				button.onclick = () => {
					if (!commit()) return;
					if (action === "Edit") open(null,i);
					else apply(tab.charts.filter((_,j) => j !== i));
				};
				header.append(button);
			}
			card.append(header); panel.append(card);
			const body = document.createElement("div"); card.append(body);
			draw(body,chart,tableCharts.data(chart,tab,cell));
		}
	}
	return {open,render};
}
