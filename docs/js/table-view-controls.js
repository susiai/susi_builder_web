"use strict";

function tableValueList($) {
	const mode = $("filter-mode"), search = $("filter-search"), all = $("filter-all"), choices = $("filter-choices");
	const batch = 100;
	let items = [], matches = [], selected = new Set(), limit;

	function updateAll() {
		const count = matches.reduce((n,item) => n + Number(selected.has(item.key)),0);
		all.checked = count > 0 && count === matches.length;
		all.indeterminate = count > 0 && count < matches.length;
		all.disabled = !matches.length;
	}
	function draw() {
		const list = document.createDocumentFragment();
		for (const {key,label} of matches.slice(0,limit)) {
			const line = document.createElement("label"), box = document.createElement("input");
			box.type = "checkbox"; box.checked = selected.has(key); box.value = key;
			line.append(box,document.createTextNode(label)); list.append(line);
		}
		if (!matches.length) list.append("No matching values");
		choices.replaceChildren(list);
		$("filter-more").hidden = matches.length <= limit;
		updateAll();
	}
	function find() {
		const query = search.value.trim().toLocaleLowerCase();
		matches = items.filter(item => item.label.toLocaleLowerCase().includes(query));
		$("filter-only-matches").hidden = !query || !matches.length;
		limit = batch; draw();
	}
	function toggle(key,checked) {
		if (checked) selected.add(key); else selected.delete(key);
	}
	function changed() {
		mode.value = items.length && items.every(item => selected.has(item.key)) ? "" : "values";
	}
	all.onchange = () => {
		for (const {key} of matches) toggle(key,all.checked);
		changed(); draw();
	};
	choices.onchange = event => {
		toggle(event.target.value,event.target.checked); changed(); updateAll();
	};
	search.oninput = find;
	$("filter-only-matches").onclick = () => {
		selected = new Set(matches.map(item => item.key)); changed(); draw();
	};
	$("filter-more").onclick = () => { limit += batch; draw(); };
	function updateMode() {
		$("filter-values").hidden = mode.value !== "" && mode.value !== "values";
		$("filter-text").hidden = document.querySelector('label[for="filter-text"]').hidden = mode.value !== "equals";
	}
	mode.onchange = () => {
		if (!mode.value) { selected = new Set(items.map(item => item.key)); draw(); }
		updateMode();
	};
	return {
		open(options,filter) {
			items = options;
			selected = new Set(filter?.keys ?? items.map(item => item.key));
			mode.value = filter?.mode || ""; $("filter-text").value = filter?.text || "";
			search.value = ""; find(); updateMode();
			choices.scrollTop = 0;
		},
		read() {
			if (!mode.value) return null;
			return mode.value === "values" ? {mode:"values", keys:new Set(selected)} : {mode:mode.value,text:$("filter-text").value};
		}
	};
}

function tableSortDialog($,show,apply) {
	const list = $("sort-levels"), add = $("add-sort-level");
	let columns, levels;
	function available() {
		return columns.findIndex((_,i) => !levels.some(level => level.column === i));
	}
	function draw(focusIndex,focusSelector = ".sort-column") {
		list.replaceChildren();
		for (const [index,level] of levels.entries()) {
			const li = $("sort-level").content.firstElementChild.cloneNode(true);
			const column = li.querySelector(".sort-column"), order = li.querySelector(".sort-direction");
			for (const [i,name] of columns.entries()) {
				const option = new Option(name,String(i));
				option.disabled = i !== level.column && levels.some(other => other.column === i);
				column.add(option);
			}
			column.value = level.column; order.value = level.order;
			column.onchange = () => { level.column = Number(column.value); draw(index); };
			order.onchange = () => { level.order = order.value; };
			for (const [selector,step] of [[".sort-up",-1],[".sort-down",1]]) {
				const button = li.querySelector(selector), dest = index+step;
				button.disabled = dest < 0 || dest >= levels.length;
				button.onclick = () => { [levels[index],levels[dest]] = [levels[dest],levels[index]]; draw(dest,selector); };
			}
			li.querySelector(".sort-remove").onclick = () => { levels.splice(index,1); draw(Math.min(index,levels.length-1)); };
			list.append(li);
		}
		add.disabled = available() < 0;
		if (focusIndex != null) {
			const li = list.children[focusIndex], target = li?.querySelector(focusSelector);
			(target && !target.disabled ? target : li?.querySelector("select") || add).focus();
		}
	}
	add.onclick = () => { levels.push({column:available(),order:"asc"}); draw(levels.length-1); };
	$("sort-form").onsubmit = event => {
		event.preventDefault(); $("sort-dialog").close(); apply(levels);
	};
	return (names,current,index) => {
		columns = names;
		levels = current.length ? current : [{column:index,order:"asc"}];
		draw(); show($("sort-dialog"));
	};
}
