"use strict";

function tableFunctionMenu(list, acceptsFormula) {
	let editor, token, choices = [], active = 0;

	function functionToken(input) {
		const text = input.value, caret = input.selectionStart;
		if (!text.startsWith("=") || caret !== input.selectionEnd || caret < 1) return null;
		const before = text.slice(0,caret);
		let quote = "";
		for (const ch of before) {
			if (quote) { if (ch === quote) quote = ""; }
			else if (ch === '"' || ch === "'") quote = ch;
		}
		if (quote) return null;
		const prefix = /[\p{L}\d_.]*$/u.exec(before)[0];
		const start = caret - prefix.length;
		if (!/[=(,;+\-*/^&<>]\s*$/.test(before.slice(0,start))) return null;
		const end = caret + /^[\p{L}\d_.]*/u.exec(text.slice(caret))[0].length;
		if (text.slice(end).trimStart().startsWith("!")) return null;
		const word = text.slice(start,end).toUpperCase();
		if (word && !tableCalc.functionNames.some(fn => fn.name.startsWith(word)) && /[\d_.]/.test(word)) return null;
		return { start, end, prefix:prefix.toUpperCase(), call:/^\s*\(/.test(text.slice(end)) };
	}

	function close() {
		editor?.removeAttribute("aria-activedescendant");
		editor = null; list.hidden = true;
	}
	function position() {
		if (!editor) return;
		const rect = editor.getBoundingClientRect(), clip = editor.closest("#grid-scroll")?.getBoundingClientRect();
		if (!editor.isConnected || (clip && (rect.bottom <= clip.top || rect.top >= clip.bottom || rect.right <= clip.left || rect.left >= clip.right))) {
			close(); return;
		}
		const view = window.visualViewport, left = view?.offsetLeft ?? 0, top = view?.offsetTop ?? 0;
		const right = left + (view?.width ?? document.documentElement.clientWidth);
		const bottom = top + (view?.height ?? innerHeight);
		// With no function prefix, keep the grid available for picking a cell reference.
		const barTop = !token.prefix ? document.getElementById("cell-value").getBoundingClientRect().top : rect.top;
		const clearGrid = !token.prefix && barTop - top >= 48;
		const anchorTop = clearGrid ? barTop : rect.top;
		const above = anchorTop - top - 6, below = bottom - rect.bottom - 6;
		const upwards = clearGrid || (below < Math.min(list.scrollHeight + 2,240) && above > below);
		list.style.maxHeight = Math.max(0,Math.min(280,upwards ? above : below)) + "px";
		list.style.left = Math.max(left + 3,Math.min(rect.left,right - list.offsetWidth - 3)) + "px";
		list.style.top = (upwards ? anchorTop - list.offsetHeight - 2 : rect.bottom + 2) + "px";
	}
	function highlight(index) {
		list.children[active]?.setAttribute("aria-selected","false");
		active = index;
		const option = list.children[index];
		option.setAttribute("aria-selected","true");
		editor.setAttribute("aria-activedescendant",option.id);
		if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
		else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight)
			list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
	}
	function update(input) {
		if (document.activeElement !== input || !acceptsFormula()) { close(); return; }
		const next = functionToken(input);
		const matches = next && tableCalc.suggestions.filter(item =>
			item.name.startsWith(next.prefix) && (!next.call || item.value === undefined));
		if (!matches?.length) { close(); return; }
		if (editor === input && token.prefix === next.prefix && token.start === next.start && token.call === next.call) {
			token = next; position(); return;
		}
		close(); editor = input; token = next; choices = matches; active = 0;
		list.replaceChildren(...choices.map(({name,args,value},i) => {
			const option = document.createElement("div"), label = document.createElement("strong");
			option.id = list.id + "-" + i; option.setAttribute("role","option");
			option.setAttribute("aria-selected","false"); label.textContent = name;
			option.append(label,value === undefined ? "(" + args + ")" : " · constant ≈ " + value.toFixed(6)); return option;
		}));
		list.hidden = false; position();
		if (editor) highlight(Math.max(0,choices.findIndex(item => item.value !== undefined && item.name === token.prefix)));
	}
	function accept(index) {
		const input = editor, {name,args,value} = choices[index];
		const current = functionToken(input);
		if (!current || current.start !== token.start || !name.startsWith(current.prefix)) { close(); return; }
		const existing = /^\s*\(/.exec(input.value.slice(current.end));
		const suffix = existing || value !== undefined ? "" : args ? "(" : "()";
		const caret = current.start + name.length + (existing ? existing[0].length : suffix.length);
		input.setRangeText(name + suffix,current.start,current.end,"end");
		input.setSelectionRange(caret,caret);
		input.dispatchEvent(new Event("input",{bubbles:true}));
		close();
	}
	function keydown(event) {
		if (event.target !== editor || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false;
		switch (event.key) {
			case "ArrowDown": highlight((active + 1) % choices.length); break;
			case "ArrowUp": highlight((active + choices.length - 1) % choices.length); break;
			case "Enter":
				if (choices[active].value !== undefined && choices[active].name === token.prefix && editor.selectionStart === editor.value.length) {
					close(); return false;
				}
				accept(active); break;
			case "Tab": accept(active); break;
			case "Escape": close(); break;
			default: return false;
		}
		event.preventDefault(); return true;
	}
	function bind(input) {
		input.setAttribute("aria-autocomplete","list"); input.setAttribute("aria-controls",list.id);
		input.addEventListener("input",event => event.isComposing ? close() : update(input));
		input.addEventListener("compositionend",() => update(input));
		input.addEventListener("click",() => update(input));
		input.addEventListener("focus",() => update(input));
		input.addEventListener("blur",close);
		input.addEventListener("keyup",event => {
			if (["ArrowLeft","ArrowRight","Home","End"].includes(event.key) && !event.isComposing) update(input);
		});
	}
	list.addEventListener("pointerdown",event => { if (event.target.closest("[role=option]")) event.preventDefault(); });
	list.addEventListener("click",event => {
		const option = event.target.closest("[role=option]");
		if (editor && option) accept([...list.children].indexOf(option));
	});
	window.addEventListener("blur",close);
	window.addEventListener("resize",position);
	window.visualViewport?.addEventListener("resize",position);
	window.visualViewport?.addEventListener("scroll",position);
	document.addEventListener("scroll",event => { if (event.target !== list) position(); },true);
	return { bind, close, keydown, highlighted:() => editor && token.prefix && choices[active]?.name };
}
