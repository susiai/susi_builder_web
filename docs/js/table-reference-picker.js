"use strict";

function tableReferencePicker({grid, bar, scroller, getEditor, getSheetName, extendRows, trimRows, closeMenu}) {
	const ink = document.getElementById("formula-ink");
	const colors = ["#75baff","#ffac75","#c69bff","#72dca2","#ff94b5","#e5ce65"];
	let gesture, suppressedClick, paintedText, paintedSheet;

	function alignInk() {
		if (ink.hidden) return;
		ink.style.width = bar.clientWidth + "px";
		ink.style.height = bar.clientHeight + "px";
		ink.scrollTop = bar.scrollTop;
		ink.scrollLeft = bar.scrollLeft;
	}
	bar.addEventListener("scroll",alignInk);
	new ResizeObserver(alignInk).observe(bar);

	function paint(text, home) {
		const spans = tableCalc.referenceSpans(text);
		if (!spans.length && ink.hidden) return;
		const fragment = document.createDocumentFragment(), ranges = [], palette = new Map();
		let pos = 0;
		for (const {start,end,a,b} of spans) {
			const top = Math.min(a.r,b.r), bottom = Math.max(a.r,b.r);
			const left = Math.min(a.c,b.c), right = Math.max(a.c,b.c);
			const sheet = (a.name || home).toLowerCase(), other = (b.name || sheet).toLowerCase();
			const key = JSON.stringify([sheet,other,top,bottom,left,right]);
			if (!palette.has(key)) palette.set(key,colors[palette.size % colors.length]);
			const color = palette.get(key);
			const span = document.createElement("span");
			span.style.color = color; span.textContent = text.slice(start,end);
			fragment.append(text.slice(pos,start),span); pos = end;
			if (sheet === home.toLowerCase() && other === sheet) ranges.push({top,bottom,left,right,color});
		}
		fragment.append(text.slice(pos),"\u200b");
		ink.hidden = !spans.length;
		ink.replaceChildren(fragment);
		bar.toggleAttribute("data-colored",!ink.hidden);
		alignInk();

		const rows = grid.tBodies[0].rows;
		const columns = Array.from(rows[0]?.querySelectorAll("td") || [], td => +td.dataset.c);
		for (let i=0; i<rows.length; i++) {
			const tr = rows[i], r = +tr.cells[0].dataset.r;
			const prev = i ? +rows[i-1].cells[0].dataset.r : NaN;
			const next = i+1<rows.length ? +rows[i+1].cells[0].dataset.r : NaN;
			for (let j=0; j<columns.length; j++) {
				const td = tr.cells[j+1], c = columns[j];
				const range = ranges.findLast(b => r >= b.top && r <= b.bottom && c >= b.left && c <= b.right);
				if (!range) {
					if (td.hasAttribute("data-reference")) { delete td.dataset.reference; td.style.removeProperty("--reference-color"); }
					continue;
				}
				const {top,bottom,left,right,color} = range;
				td.dataset.reference = [!(prev>=top && prev<=bottom) && "top", !(next>=top && next<=bottom) && "bottom",
					!(columns[j-1]>=left && columns[j-1]<=right) && "left", !(columns[j+1]>=left && columns[j+1]<=right) && "right"].filter(Boolean).join(" ");
				td.style.setProperty("--reference-color",color);
			}
		}
	}

	function update(force = false) {
		const editor = getEditor(), text = editor?.value.startsWith("=") ? editor.value : "", home = getSheetName();
		grid.toggleAttribute("data-pick-reference",!!gesture || !!text && tableCalc.expectsReference(text,editor.selectionStart,editor.selectionEnd));
		if (force || text !== paintedText || home !== paintedSheet) {
			paint(text,home); paintedText = text; paintedSheet = home;
		}
	}
	const address = (r,c) => tableCalc.letters(c) + (r+1);
	function preview(cell) {
		const g = gesture;
		if (!cell || !grid.contains(cell)) return;
		const r = +cell.dataset.r, c = +cell.dataset.c;
		let ref = address(r,c);
		if (!g.endpoint && (r !== g.r || c !== g.c)) {
			ref = address(Math.min(r,g.r),Math.min(c,g.c)) + ":" + address(Math.max(r,g.r),Math.max(c,g.c));
		}
		if (ref === g.ref) return;
		const previousEnd = g.ref ? g.start+g.ref.length : g.end;
		g.editor.setRangeText(ref,g.start,previousEnd,"end");
		g.ref = ref;
		if (g.editor !== bar) bar.value = g.editor.value;
		update();
	}
	function cellAtPointer() {
		const rect = scroller.getBoundingClientRect();
		const x = Math.max(rect.left+grid.rows[0].cells[0].offsetWidth+1, Math.min(gesture.x,rect.left+scroller.clientWidth-2));
		const y = Math.max(rect.top+grid.tHead.offsetHeight+1, Math.min(gesture.y,rect.top+scroller.clientHeight-2));
		return document.elementFromPoint(x,y)?.closest("td[data-r][data-c]");
	}
	function scrollAtEdge() {
		const g = gesture;
		if (!g.moved) return;
		const box = scroller.getBoundingClientRect();
		const dy = g.y >= box.top+scroller.clientHeight-18 ? 1 : g.y <= box.top+grid.tHead.offsetHeight+10 ? -1 : 0;
		const dx = g.x >= box.left+scroller.clientWidth-18 ? 1 : g.x <= box.left+grid.rows[0].cells[0].offsetWidth+10 ? -1 : 0;
		if (!dx && !dy) return;
		const before = scroller.scrollTop;
		scroller.scrollBy(dx*24,dy*24);
		if (dy && before === scroller.scrollTop && extendRows(dy)) {
			g.extended = true; scroller.scrollBy(0,dy*24); update(true);
		}
		preview(cellAtPointer());
	}
	function start(editor,cell,event) {
		if (gesture) return;
		const {value:text,selectionStart:start,selectionEnd:end,selectionDirection:direction} = editor;
		gesture = {editor,text,start,end,direction,r:+cell.dataset.r,c:+cell.dataset.c,id:event.pointerId,
			x:event.clientX,y:event.clientY, endpoint:/:\s*$/.test(text.slice(0,start)) || /^\s*:/.test(text.slice(end))};
		suppressedClick = event.pointerId;
		grid.setPointerCapture(event.pointerId);
		event.preventDefault(); closeMenu(); preview(cell);
		gesture.timer = setInterval(scrollAtEdge,80);
	}
	function finish(apply) {
		const g = gesture;
		if (!g) return;
		gesture = null; clearInterval(g.timer);
		if (grid.hasPointerCapture(g.id)) grid.releasePointerCapture(g.id);
		if (g.extended) trimRows();
		if (apply) g.editor.dispatchEvent(new Event("input",{bubbles:true}));
		else {
			bar.value = g.editor.value = g.text;
			g.editor.setSelectionRange(g.start,g.end,g.direction);
		}
		update(true);
	}
	grid.addEventListener("pointerdown",() => { suppressedClick = undefined; },true);
	grid.addEventListener("contextmenu",event => {
		if (gesture) { event.preventDefault(); event.stopImmediatePropagation(); }
	},true);
	grid.addEventListener("click",event => {
		if (suppressedClick !== undefined && (event.pointerId === suppressedClick || event.detail > 0)) {
			suppressedClick = undefined; event.stopImmediatePropagation(); event.preventDefault();
		}
	},true);
	grid.addEventListener("pointermove",event => {
		if (gesture?.id !== event.pointerId) return;
		gesture.moved = true; gesture.x = event.clientX; gesture.y = event.clientY;
		preview(cellAtPointer());
	});
	grid.addEventListener("pointerup",event => {
		if (gesture?.id !== event.pointerId) return;
		gesture.x = event.clientX; gesture.y = event.clientY;
		if (gesture.moved) preview(cellAtPointer());
		finish(true);
	});
	for (const name of ["pointercancel","lostpointercapture"]) grid.addEventListener(name,event => {
		if (gesture?.id === event.pointerId && event.target === grid) finish(false);
	});
	window.addEventListener("blur",() => finish(false));
	document.addEventListener("keydown",event => {
		if (!gesture) return;
		finish(false);
		if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
	},true);
	document.addEventListener("focusin",() => update());
	document.addEventListener("focusout",() => {
		if (gesture) finish(false);
		queueMicrotask(() => update());
	});
	document.addEventListener("selectionchange",() => update());
	return {start,update};
}
