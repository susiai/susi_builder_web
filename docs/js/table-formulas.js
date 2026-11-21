"use strict";

const tableCalc = (() => {
	class Formula {
		constructor(expression) { this.expression = expression; }
		get usesLLM() {
			return /\bLLM\s*\(/i.test(this.expression) && scan(this.expression).some((t,i,parts) =>
				t.toUpperCase() === "LLM" && parts[nextToken(parts,i+1)] === "(");
		}
	}
	class Fault extends Error {}
	const fail = code => { throw new Fault(code); };
	const textLimit = 32767;
	function asText(value) {
		return typeof value === "boolean" ? String(value).toUpperCase() : tableFormats.textValue(value);
	}
	function appendText(left, right) {
		if (left.length + right.length > textLimit) fail("#VALUE!");
		return left + right;
	}
	function reciprocal(value) {
		return value === 0 ? fail("#DIV/0!") : 1 / value;
	}
	function reciprocalTrig(fn) {
		return x => {
			if (Math.abs(x) >= 2 ** 27) fail("#NUM!");
			return reciprocal(fn(x));
		};
	}
	function log(value, base = 10) {
		if (value <= 0 || base <= 0) fail("#NUM!");
		if (base === 1) fail("#DIV/0!");
		return base === 10 ? Math.log10(value) : Math.log(value) / Math.log(base);
	}
	function power(base, exponent) {
		if (base === 0 && exponent === 0) fail("#NUM!");
		if (base === 0 && exponent < 0) fail("#DIV/0!");
		return Math.pow(base,exponent);
	}
	function factorial(value) {
		// 170! is the largest factorial representable as a finite number.
		if (value < 0 || value >= 171) fail("#NUM!");
		const n = Math.trunc(value);
		let result = 1;
		for (let i = 2; i <= n; i++) result *= i;
		return result;
	}
	function round(value, places) {
		places = Math.trunc(places);
		// Round the decimal digits directly so a midpoint such as 1.005 stays exact.
		const {sign,digits,exponent} = LosslessJSON.splitNumber(String(value));
		const keep = exponent + 1 + places;
		if (keep >= digits.length) return value;
		if (keep < 0) return 0;
		let rounded = BigInt(digits.slice(0,keep) || "0");
		if (digits[keep] >= "5") rounded += 1n;
		return rounded === 0n ? 0 : Number(sign + rounded + "e" + (-places));
	}
	const functions = {
		SUM: { args:"number, …", alias:"SUMME", localArgs:"Zahl; …" },
		AVERAGE: { args:"number, …", alias:"MITTELWERT", localArgs:"Zahl; …" },
		MIN: { args:"number, …" },
		MAX: { args:"number, …" },
		CONCAT: { args:"text1, [text2], …", alias:"TEXTKETTE", localArgs:"Text1; [Text2]; …", maxArgs:253, future:true },
		CONCATENATE: { args:"text1, [text2], …", alias:"VERKETTEN", localArgs:"Text1; [Text2]; …", maxArgs:255 },
		TEXTJOIN: { args:"delimiter, ignore_empty, text1, …", alias:"TEXTVERKETTEN", localArgs:"Trennzeichen; Leer_ignorieren; Text1; …", maxArgs:254, future:true },
		LLM: { args:"question", maxArgs:1 },
		IF: { args:"test, then, [else]", alias:"WENN", localArgs:"Prüfung; dann; [sonst]", maxArgs:3 },
		PI: { args:"", calc:() => Math.PI },
		RADIANS: { args:"degrees", alias:"BOGENMASS", localArgs:"Grad", calc:x => x * (Math.PI / 180) },
		DEGREES: { args:"radians", alias:"GRAD", localArgs:"Bogenmaß", calc:x => x * (180 / Math.PI) },
		SIN: { args:"radians", calc:Math.sin },
		COS: { args:"radians", calc:Math.cos },
		TAN: { args:"radians", calc:Math.tan },
		COT: { args:"radians", calc:reciprocalTrig(Math.tan), future:true },
		SEC: { args:"radians", calc:reciprocalTrig(Math.cos), future:true },
		CSC: { args:"radians", alias:"COSEC", localArgs:"Bogenmaß", calc:reciprocalTrig(Math.sin), future:true },
		ASIN: { args:"number", alias:"ARCSIN", calc:Math.asin },
		ACOS: { args:"number", alias:"ARCCOS", calc:Math.acos },
		ATAN: { args:"number", alias:"ARCTAN", calc:Math.atan },
		ATAN2: { args:"x, y", alias:"ARCTAN2", localArgs:"x; y", calc:(x,y) => x === 0 && y === 0 ? fail("#DIV/0!") : Math.atan2(y,x) },
		ACOT: { args:"number", alias:"ARCCOT", calc:x => Math.atan2(1,x), future:true },
		ASEC: { args:"number", calc:x => Math.acos(reciprocal(x)), excelCall:["ACOS(1/(", "))"] },
		ACSC: { args:"number", calc:x => Math.asin(reciprocal(x)), excelCall:["ASIN(1/(", "))"] },
		SINH: { args:"number", alias:"SINHYP", calc:Math.sinh },
		COSH: { args:"number", alias:"COSHYP", calc:Math.cosh },
		TANH: { args:"number", alias:"TANHYP", calc:Math.tanh },
		COTH: { args:"number", alias:"COTHYP", calc:reciprocalTrig(Math.tanh), future:true },
		SECH: { args:"number", alias:"SECHYP", calc:reciprocalTrig(Math.cosh), future:true },
		CSCH: { args:"number", alias:"COSECHYP", calc:reciprocalTrig(Math.sinh), future:true },
		ASINH: { args:"number", alias:"ARCSINHYP", calc:Math.asinh },
		ACOSH: { args:"number", alias:"ARCCOSHYP", calc:Math.acosh },
		ATANH: { args:"number", alias:"ARCTANHYP", calc:Math.atanh },
		ACOTH: { args:"number", alias:"ARCCOTHYP", calc:x => Math.atanh(1 / x), future:true },
		ASECH: { args:"number", calc:x => Math.acosh(reciprocal(x)), excelCall:["ACOSH(1/(", "))"] },
		ACSCH: { args:"number", calc:x => Math.asinh(reciprocal(x)), excelCall:["ASINH(1/(", "))"] },
		EXP: { args:"number", calc:Math.exp },
		EXP2: { args:"number", calc:x => 2 ** x, excelCall:["POWER(2,", ")"] },
		POWER: { args:"base, exponent", alias:"POTENZ", localArgs:"Basis; Exponent", calc:power },
		FACT: { args:"number", alias:"FAKULTÄT", calc:factorial },
		ROUND: { args:"number, num_digits", alias:"RUNDEN", localArgs:"Zahl; Anzahl_Stellen", calc:round },
		SQRT: { args:"number", alias:"WURZEL", calc:Math.sqrt },
		LN: { args:"number", calc:Math.log },
		LOG: { args:"number, [base]", calc:log, maxArgs:2 },
		LOG10: { args:"number", calc:Math.log10 },
		LOG2: { args:"number", calc:Math.log2, excelCall:["LOG(", ",2)"] }
	};
	const aliases = { WAHR:"TRUE", FALSCH:"FALSE" };
	const constants = {
		PI: { value:Math.PI, excel:"PI()" },
		E: { value:Math.E, excel:"EXP(1)" }
	};
	const functionNames = [];
	for (const [name, {args, alias, localArgs}] of Object.entries(functions)) {
		functionNames.push({name, args});
		if (alias) {
			aliases[alias] = name;
			functionNames.push({name:alias, args:localArgs ?? "Zahl"});
		}
	}
	const suggestions = [...functionNames, ...Object.entries(constants).map(([name,{value}]) => ({name,value}))];
	const refPattern = /^(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\d_.]*))!)?(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)$/iu;
	const tokens = /"(?:[^"]|"")*"|(?:'(?:[^']|'')+'!|[\p{L}_][\p{L}\d_.]*!)?\$?[A-Z]{1,3}\$?[1-9]\d*(?![\p{L}\d_.(])|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[\p{L}_][\p{L}\d_.]*|#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)|<>|<=|>=|\s+|./giu;
	const scan = expression => expression.match(tokens) || [];
	function letters(c) {
		let s = "";
		for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
		return s;
	}
	function reference(token) {
		const m = refPattern.exec(token);
		if (!m) return null;
		return { name: m[1]?.replaceAll("''", "'") ?? m[2], prefix: token.slice(0, token.lastIndexOf("!") + 1),
			c: [...m[4].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1,
			r: Number(m[6]) - 1, fixedCol: m[3], fixedRow: m[5] };
	}
	function refText(p) {
		if (p.r < 0 || p.c < 0 || p.c >= 16384 || p.r >= 1048576) return "#REF!";
		return p.prefix + p.fixedCol + letters(p.c) + p.fixedRow + (p.r + 1);
	}
	function nextToken(parts, i) {
		while (parts[i]?.trim() === "") i++;
		return i;
	}
	// Keep source offsets so editing an incomplete formula never requires evaluating it.
	function referenceSpans(expression) {
		if (!expression.startsWith("=")) return [];
		const parts = scan(expression), spans = [];
		let offset = 0;
		for (let i=0; i<parts.length; i++) {
			const start = offset, token = parts[i];
			offset += token.length;
			if (token === '"' || token === "'") break;
			const a = reference(token), next = nextToken(parts,i+1);
			if (!a || parts[next] === "(") continue;
			const aEnd = offset;
			let b = a, bStart = start;
			if (parts[next] === ":") {
				const end = nextToken(parts,next+1), last = reference(parts[end] || "");
				if (last && parts[nextToken(parts,end+1)] !== "(") {
					b = last;
					while (i < end) offset += parts[++i].length;
					bStart = offset - parts[i].length;
				}
			}
			spans.push({start,end:offset,aEnd,bStart,a,b});
		}
		return spans;
	}
	function cycleReferences(expression, start, end = start) {
		const edits = [];
		function cycle(ref, from, to) {
			if (ref.c >= 16384 || ref.r >= 1048576) return;
			const colMark = from + ref.prefix.length;
			const rowMark = to - String(ref.r+1).length - ref.fixedRow.length;
			// B2 → $B$2 → B$2 → $B2 → B2. Only edit the dollar signs.
			edits.push({at:colMark,remove:ref.fixedCol.length,insert:ref.fixedCol ? "" : "$"});
			const nextRow = ref.fixedCol === ref.fixedRow ? "$" : "";
			if (nextRow !== ref.fixedRow) edits.push({at:rowMark,remove:ref.fixedRow.length,insert:nextRow});
		}
		for (const span of referenceSpans(expression)) {
			const atRange = start === end && start >= span.start && start <= span.end;
			if (atRange || (start < span.aEnd && end > span.start)) cycle(span.a,span.start,span.aEnd);
			if (span.b !== span.a && (atRange || (start < span.end && end > span.bStart))) cycle(span.b,span.bStart,span.end);
		}
		if (!edits.length) return null;
		let value = "", pos = 0, selectionStart = start, selectionEnd = end;
		for (const {at,remove,insert} of edits) {
			value += expression.slice(pos,at) + insert;
			pos = at + remove;
			if (at < start) selectionStart += insert.length-remove;
			if (at < end) selectionEnd += insert.length-remove;
		}
		return {value:value+expression.slice(pos),selectionStart,selectionEnd};
	}
	function canonical(name) {
		const upper = name.toUpperCase();
		if (upper.startsWith("_XLFN.") && functions[upper.slice(6)]?.future) return upper.slice(6);
		return aliases[upper] || upper;
	}
	function rewrite(expression, transform) {
		return scan(expression).map((token,i,parts) => {
			const p = parts[nextToken(parts,i+1)] !== "(" && reference(token);
			return p ? refText(transform(p)) : token;
		}).join("");
	}
	// Structural edits follow the referenced row or column even for absolute references.
	function relayout(expression, home, target, axis, remap) {
		const parts = scan(expression), key = axis === "row" ? "r" : "c";
		const belongs = (p, fallback) => (p.name || fallback).toLowerCase() === target.toLowerCase();
		for (let i=0; i<parts.length; i++) {
			const a = reference(parts[i]); if (!a) continue;
			const separator = nextToken(parts,i+1);
			if (parts[separator] === "(") continue;
			let end = separator + 1;
			while (parts[end]?.trim() === "") end++;
			const b = parts[separator] === ":" && reference(parts[end]);
			if (b && belongs(a,home) && belongs(b,a.name || home)) {
				const step = a[key] <= b[key] ? 1 : -1;
				while (remap(a[key]) < 0 && a[key] !== b[key]) a[key] += step;
				while (remap(b[key]) < 0 && b[key] !== a[key]) b[key] -= step;
				a[key] = remap(a[key]); b[key] = remap(b[key]);
				parts[i] = refText(a); parts[end] = refText(b); i = end;
			} else if (belongs(a,home)) {
				a[key] = remap(a[key]); parts[i] = refText(a);
			}
		}
		return parts.join("");
	}

	function offset(expression, dr, dc) {
		return rewrite(expression, p => ({ ...p, r: p.r + (p.fixedRow ? 0 : dr), c: p.c + (p.fixedCol ? 0 : dc) }));
	}
	function rename(expression, oldName, newName) {
		return rewrite(expression, p => p.name?.toLowerCase() === oldName.toLowerCase()
			? { ...p, prefix: "'" + newName.replaceAll("'", "''") + "'!" } : p);
	}
	function normalized(expression) {
		const parts = scan(expression);
		if (!parts.includes(";")) return parts;
		for (let i=1; i+1<parts.length; i++) {
			if (parts[i] === "," && /^\d+$/.test(parts[i-1]) && /^\d+(?:e[+-]?\d+)?$/i.test(parts[i+1])) {
				parts.splice(i-1,3,parts[i-1] + "." + parts[i+1]); i--;
			}
		}
		return parts;
	}
	function fromExcel(expression) {
		return "=" + scan(expression).map((t,i,parts) =>
			/^_xlfn\./i.test(t) && parts[nextToken(parts,i+1)] === "(" && functions[canonical(t)]?.future
				? canonical(t) : t
		).join("");
	}
	function excel(expression) {
		const parts = normalized(expression.slice(1)), closing = [], out = [];
		for (let i=0; i<parts.length; i++) {
			const t = parts[i], open = nextToken(parts,i+1);
			if (/^[\p{L}_]/u.test(t) && parts[open] === "(") {
				const name = canonical(t), fn = functions[name];
				const [start,end] = fn?.excelCall ?? [(fn?.future ? "_xlfn." : "") + (fn || name === "TRUE" || name === "FALSE" ? name : t) + "(", ")"];
				out.push(start); closing.push(end); i = open;
			} else if (t === "(") { out.push(t); closing.push(")"); }
			else if (t === ")") out.push(closing.pop() ?? ")");
			else if (Object.hasOwn(constants,t.toUpperCase())) out.push(constants[t.toUpperCase()].excel);
			else if (/^(WAHR|FALSCH)$/i.test(t)) out.push(canonical(t));
			else out.push(t === ";" ? "," : t);
		}
		return out.join("");
	}
	const precedence = { "=":1, "<>":1, "<":1, ">":1, "<=":1, ">=":1, "&":2, "+":3, "-":3, "*":4, "/":4, "^":5, ":":6 };
	const missingOperand = Symbol("missing operand");
	function expectsReference(expression, start, end = start) {
		if (!expression.startsWith("=") || start < 1) return false;
		const after = expression.slice(end).trimStart();
		if (after && !/^[),;:+\-*/^&=<>]/.test(after)) return false;
		if (start === end && ["<>","<=",">="].includes(expression.slice(start-1,start+1))) return false;
		const prefix = normalized(expression.slice(1,start)).filter(t => t.trim());
		// An unmatched quote leaves the caret in text or in a quoted sheet name.
		if (prefix.includes('"') || prefix.includes("'")) return false;
		try { parse(prefix,true); } catch (error) { return error === missingOperand; }
		return false;
	}
	function parse(ts, probing = false) {
		let i = 0;
		const take = token => ts[i] === token && (++i, true);
		function expr(min = 1) {
			const t = ts[i++];
			if (!t) {
				if (probing) throw missingOperand;
				fail("#VALUE!");
			}
			let node;
			if (t === "(") { node = expr(); if (!take(")")) fail("#VALUE!"); }
			else if (t === "+" || t === "-") node = { unary:t, arg:expr(5) };
			else if (t.startsWith('"')) node = { literal:t.slice(1,-1).replaceAll('""','"') };
			else if (/^(\d|\.)/.test(t)) node = { literal:Number(t) };
			else if (t.startsWith("#")) node = { error:t };
			else if (take("(")) {
				const name = canonical(t);
				const args = [];
				if (!take(")")) {
					do {
						if (probing) {
							const fn = functions[name];
							const max = name === "TRUE" || name === "FALSE" ? 0 : fn?.maxArgs ?? fn?.calc?.length ?? Infinity;
							if (args.length >= max) fail("#VALUE!");
						}
						// While editing, an earlier argument may still be blank.
						const blank = probing && (ts[i] === ";" || ts[i] === ",");
						args.push(blank ? null : expr());
					} while (take(",") || take(";"));
					if (!take(")")) fail("#VALUE!");
				}
				if (name === "TRUE" || name === "FALSE") {
					if (args.length) fail("#VALUE!");
					node = {literal:name === "TRUE"};
				} else node = { fn:name, args };
			} else {
				const ref = reference(t);
				if (ref) node = { ref };
				else if (Object.hasOwn(constants,t.toUpperCase())) node = { literal:constants[t.toUpperCase()].value };
				else if (/^(TRUE|FALSE|WAHR|FALSCH)$/i.test(t)) node = { literal:/^(TRUE|WAHR)$/i.test(t) };
				else node = { error:"#NAME?" };
			}
			while (Object.hasOwn(precedence,ts[i]) && precedence[ts[i]] >= min) {
				const op = ts[i++]; node = { op, left:node, right:expr(precedence[op] + (op === "^" ? 0 : 1)) };
			}
			return node;
		}
		const root = expr(); if (i !== ts.length) fail("#VALUE!"); return root;
	}
	const trees = new WeakMap();
	function calculator(sheets, lookupAnswer) {
		const cache = new WeakMap(), active = new Set();
		const byName = new Map(sheets.map(s => [s.name.toLowerCase(),s]));
		const number = v => {
			if (v == null || v === "") return 0;
			if (typeof v !== "object" || tableFormats.isNumber(v)) {
				const n = Number(String(v)); if (Number.isFinite(n)) return n;
				if (typeof v === "boolean") return Number(v);
			}
			return fail("#VALUE!");
		};
		function resolve(p, home) {
			const tab = p.name ? byName.get(p.name.toLowerCase()) : home;
			if (!tab || p.r >= 1048576 || p.c >= 16384) fail("#REF!");
			return tab;
		}
		function range(arg, home) {
			const a = arg.left.ref, b = arg.right.ref;
			if (!a || !b) fail("#REF!");
			const tab = resolve(a,home);
			if (resolve(b,tab) !== tab) fail("#REF!");
			return {tab,top:Math.min(a.r,b.r),bottom:Math.max(a.r,b.r),left:Math.min(a.c,b.c),right:Math.max(a.c,b.c)};
		}
		// Report the position within the full rectangle, even for sparse worksheets.
		function visitValues(arg, home, visit) {
			if (arg.op !== ":") { visit(evalNode(arg,home),0); return 1; }
			const {tab,top,bottom,left,right} = range(arg,home);
			const width = right-left+1;
			for (let r=top; r<=Math.min(bottom,tab.rows.length-1); r++) {
				const row = tab.rows[r];
				for (let c=left; c<=Math.min(right,row.length-1); c++) {
					if (row[c] != null) visit(cell(tab,r,c),(r-top)*width + c-left);
				}
			}
			return (bottom-top+1)*width;
		}
		function joinText(name, args, home) {
			const join = name === "TEXTJOIN", offset = join ? 2 : 0;
			if (args.length <= offset || args.length > functions[name].maxArgs) fail("#VALUE!");
			const delimiters = [];
			let period = 0, ignoreEmpty = true;
			if (join) {
				period = visitValues(args[0],home,(value,index) => {
					const text = asText(value);
					if (text) delimiters.push({index,text});
				});
				const flag = evalNode(args[1],home);
				if (/^(true|wahr)$/i.test(flag)) ignoreEmpty = true;
				else if (/^(false|falsch)$/i.test(flag)) ignoreEmpty = false;
				else ignoreEmpty = number(flag) !== 0;
			}
			let result = "", count = 0, cycle = 0, next = 0;
			// A delimiter range repeats. Skip its empty positions without walking
			// every blank cell of a potentially large input or delimiter range.
			function separatorsBefore(index) {
				while (delimiters.length && cycle + delimiters[next].index < index) {
					result = appendText(result,delimiters[next].text);
					if (++next === delimiters.length) { next = 0; cycle += period; }
				}
			}
			for (const arg of args.slice(offset)) {
				if (name === "CONCATENATE" && arg.op === ":") fail("#VALUE!");
				const size = visitValues(arg,home,(value,index) => {
					const text = asText(value);
					if (!text) return;
					separatorsBefore(ignoreEmpty ? count : count + index);
					result = appendText(result,text);
					if (ignoreEmpty) count++;
				});
				if (!ignoreEmpty) count += size;
			}
			separatorsBefore(count-1);
			return result;
		}
		function evalNode(n, home) {
			if ("literal" in n) return n.literal;
			if (n.error) fail(n.error);
			if (n.ref) return cell(resolve(n.ref,home),n.ref.r,n.ref.c);
			if (n.unary) return (n.unary === "-" ? -1 : 1) * number(evalNode(n.arg,home));
			if (n.fn) {
				if (n.fn === "CONCAT" || n.fn === "CONCATENATE" || n.fn === "TEXTJOIN") return joinText(n.fn,n.args,home);
				if (n.fn === "LLM") {
					if (n.args.length !== 1) fail("#VALUE!");
					const value = evalNode(n.args[0],home);
					const prompt = value == null ? "" : tableFormats.textValue(value);
					if (!prompt.trim()) return "";
					const entry = lookupAnswer?.(prompt);
					if (entry?.state === "ready") return entry.text;
					if (entry?.state === "failed") fail("#LLM!");
					if (entry?.state === "running" || entry?.state === "queued") fail("#BUSY!");
					fail("#LLM?");
				}
				if (n.fn === "IF") {
					if (n.args.length < 2 || n.args.length > 3) fail("#VALUE!");
					const test = evalNode(n.args[0],home);
					const branch = n.args[(tableFormats.isNumber(test) ? number(test) !== 0 : !!test) ? 1 : 2];
					return branch ? evalNode(branch,home) : false;
				}
				const fn = functions[n.fn];
				if (!fn) fail("#NAME?");
				if (fn.calc) {
					const count = n.args.length, minArgs = fn.calc.length;
					if (count < minArgs || count > (fn.maxArgs ?? minArgs)) fail("#VALUE!");
					const result = fn.calc(...n.args.map(arg => number(evalNode(arg,home))));
					return Number.isFinite(result) ? result : fail("#NUM!");
				}
				let count = 0, sum = 0, min = Infinity, max = -Infinity;
				function add(v, fromRange) {
					if (v == null || v === "" || (fromRange && (typeof v === "boolean" || (typeof v === "string" && !Number.isFinite(Number(v)))))) return;
					const x = number(v); count++; sum += x; min = Math.min(min,x); max = Math.max(max,x);
				}
				for (const arg of n.args) {
					visitValues(arg,home,v => add(v,!!arg.ref || arg.op === ":"));
				}
				if (n.fn === "SUM") return sum;
				if (n.fn === "AVERAGE") return count ? sum/count : fail("#DIV/0!");
				return count ? (n.fn === "MIN" ? min : max) : 0;
			}
			if (n.op === ":") fail("#VALUE!");
			const a = evalNode(n.left,home), b = evalNode(n.right,home);
			if (n.op === "&") return appendText(asText(a),asText(b));
			if (precedence[n.op] === 1) {
				const numeric = v => v == null || v === "" || tableFormats.isNumber(v) || typeof v === "string" && Number.isFinite(Number(v));
				const [x,y] = numeric(a) && numeric(b) ? [number(a),number(b)] : [String(a ?? "").toLowerCase(),String(b ?? "").toLowerCase()];
				return { "=":x===y,"<>":x!==y,"<":x<y,">":x>y,"<=":x<=y,">=":x>=y }[n.op];
			}
			const x = number(a), y = number(b);
			switch (n.op) {
				case "+": return x+y; case "-": return x-y; case "*": return x*y;
				case "/": return y ? x/y : fail("#DIV/0!"); case "^": return power(x,y);
			}
		}
		function cell(tab,r,c) {
			const raw = tab.rows[r]?.[c];
			if (!(raw instanceof Formula)) return raw;
			if (active.has(raw)) fail("#CIRC!");
			if (!cache.has(raw)) {
				active.add(raw);
				try {
					if (!trees.has(raw)) trees.set(raw,parse(normalized(raw.expression.slice(1)).filter(t => t.trim())));
					const result = evalNode(trees.get(raw),tab) ?? 0;
					if (typeof result === "number" && !Number.isFinite(result)) fail("#NUM!");
					cache.set(raw,result);
				} catch (e) { cache.set(raw,e instanceof Fault ? e : new Fault("#VALUE!")); }
				finally { active.delete(raw); }
			}
			const v = cache.get(raw); if (v instanceof Fault) throw v; return v;
		}
		return (tab,r,c) => { try { return cell(tab,r,c); } catch (e) { return e.message; } };
	}
	const helpTopics = Object.entries(functions).map(([name,{alias,args,localArgs}]) => ({name,alias,args,localArgs}));
	helpTopics.push({name:"E"}, {name:"TRUE",alias:"WAHR",args:""}, {name:"FALSE",alias:"FALSCH",args:""});
	return { Formula, calculator, expectsReference, referenceSpans, cycleReferences, letters, offset, rename, relayout, excel, fromExcel, functionNames, suggestions, helpTopics };
})();
