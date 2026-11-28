"use strict";

function tableFormulaHelp(dialog) {
	const articles = {
		SUM: ["Adds the numbers in the supplied cells or ranges.", "Addiert die Zahlen in den angegebenen Zellen oder Bereichen.", ["A1:A5","10"]],
		AVERAGE: ["Returns the arithmetic mean of the numbers in a range.", "Gibt den arithmetischen Mittelwert der Zahlen in einem Bereich zurück.", ["A1:A5"]],
		MIN: ["Returns the smallest number.", "Gibt die kleinste Zahl zurück.", ["A1:A5"]],
		MAX: ["Returns the largest number.", "Gibt die größte Zahl zurück.", ["A1:A5"]],
		CONCAT: ["Joins text and ranges without a separator. Ranges are read row by row.", "Verbindet Texte und Zellbereiche ohne Trennzeichen. Bereiche werden zeilenweise gelesen.", ["A1:B2"]],
		CONCATENATE: ["Joins individual values in order. Include a space in quotes to separate words.", "Verbindet einzelne Werte in der angegebenen Reihenfolge. Ein Leerzeichen in Anführungszeichen trennt die Wörter.", ["A1",'" "',"B1"]],
		TEXTJOIN: ["Joins values or ranges with a delimiter. TRUE skips empty values. FALSE keeps their places.", "Verbindet Werte oder Zellbereiche mit einem Trennzeichen. TRUE überspringt leere Werte. FALSE behält ihre Positionen bei.", ['", "',"TRUE","A1:A5"]],
		IF: ["Tests a condition and evaluates the matching branch. If the condition is false and the last argument is omitted, the result is FALSE.", "Prüft eine Bedingung und berechnet den passenden Zweig. Ist die Bedingung falsch und fehlt das letzte Argument, lautet das Ergebnis FALSE.", ["A1>0","A1","0"]],
		LLM: ["Sends the question to the configured chat model and returns its reply as text. Identical questions reuse the workbook’s saved answer. An empty question makes no request.", "Stellt dem konfigurierten Chatmodell die Frage und gibt die Antwort als Text zurück. Gleiche Fragen verwenden die in der Arbeitsmappe gespeicherte Antwort. Eine leere Frage löst keine Anfrage aus.", ["A1"]],
		PI: ["Returns π, approximately 3.14159. Use PI or PI().", "Gibt die Kreiszahl π zurück, ungefähr 3,14159. Du kannst PI oder PI() schreiben.", []],
		E: ["Euler’s number, approximately 2.71828, is the base of the natural logarithm.", "Die Eulersche Zahl, ungefähr 2,71828, ist die Basis des natürlichen Logarithmus."],
		TRUE: ["Returns the logical value true, for example to skip empty cells in TEXTJOIN.", "Gibt den Wahrheitswert wahr zurück, etwa zum Überspringen leerer Zellen in TEXTJOIN.", []],
		FALSE: ["Returns the logical value false, for example to keep empty cells in TEXTJOIN.", "Gibt den Wahrheitswert falsch zurück, etwa zum Beibehalten leerer Zellen in TEXTJOIN.", []],
		RADIANS: ["Converts an angle from degrees to radians.", "Rechnet einen Winkel von Grad in Bogenmaß um.", ["180"]],
		DEGREES: ["Converts an angle from radians to degrees.", "Rechnet einen Winkel von Bogenmaß in Grad um.", ["PI"]],
		ATAN2: ["Returns the angle in radians from the positive x-axis to the point (x, y). Enter x first. The origin has no angle.", "Gibt den Winkel im Bogenmaß von der positiven x-Achse zum Punkt (x, y) zurück. Das erste Argument ist x. Für den Ursprung ist kein Winkel definiert.", ["1","1"]],
		EXP: ["Raises Euler’s number e to the given power.", "Potenziert die Eulersche Zahl e mit dem angegebenen Exponenten.", ["1"]],
		EXP2: ["Raises 2 to the given power.", "Potenziert 2 mit dem angegebenen Exponenten.", ["3"]],
		POWER: ["Raises the base to the given exponent.", "Potenziert die Basis mit dem angegebenen Exponenten.", ["2","3"]],
		FACT: ["Multiplies the integers from 1 to the given number. Zero gives 1. Fractions are rounded down. The supported range is 0 up to, but excluding, 171.", "Multipliziert die ganzen Zahlen von 1 bis zur angegebenen Zahl. Für 0 ist das Ergebnis 1. Nachkommastellen werden abgeschnitten. Zulässig sind Zahlen ab 0 und kleiner als 171.", ["5"]],
		SQRT: ["Returns the nonnegative square root. The input must be zero or positive.", "Gibt die nichtnegative Quadratwurzel zurück. Die Eingabe muss null oder positiv sein.", ["9"]],
		ROUND: ["Rounds a number to the given number of decimal places. Use 0 for whole numbers, −1 for tens or −2 for hundreds. Halfway values round away from zero.", "Rundet eine Zahl auf die angegebene Anzahl von Nachkommastellen. Mit 0 rundest du auf ganze Zahlen, mit −1 auf Zehner und mit −2 auf Hunderter. Liegt der Wert genau in der Mitte, wird von null weg gerundet.", ["A1","2"]],
		LN: ["Returns the natural logarithm of a positive number, using base e.", "Gibt den natürlichen Logarithmus einer positiven Zahl zur Basis e zurück.", ["E"]],
		LOG: ["Returns the logarithm of a positive number. The default base is 10. A supplied base must be positive and different from 1.", "Gibt den Logarithmus einer positiven Zahl zurück. Ohne Angabe gilt die Basis 10. Eine angegebene Basis muss positiv und ungleich 1 sein.", ["8","2"]],
		LOG10: ["Returns the base-10 logarithm of a positive number.", "Gibt den Zehnerlogarithmus einer positiven Zahl zurück.", ["100"]],
		LOG2: ["Returns the base-2 logarithm of a positive number.", "Gibt den Logarithmus einer positiven Zahl zur Basis 2 zurück.", ["8"]]
	};
	articles.CHAT = articles.LLM;
	for (const [name,en,de] of [
		["SIN","sine","Sinus"], ["COS","cosine","Kosinus"], ["TAN","tangent","Tangens"],
		["COT","cotangent","Kotangens"], ["SEC","secant","Sekans"], ["CSC","cosecant","Kosekans"]
	]) {
		articles[name] = ["Returns the " + en + " of an angle in radians.", "Berechnet den " + de + " eines Winkels im Bogenmaß.", ["PI/4"]];
		articles["A"+name] = ["Returns the inverse " + en + " as an angle in radians.", "Berechnet über die Umkehrfunktion von " + de + " einen Winkel im Bogenmaß.", ["1"]];
		articles[name+"H"] = ["Returns the hyperbolic " + en + " of the input.", "Berechnet den hyperbolischen " + de + " der angegebenen Zahl.", ["1"]];
		const inverseExample = {COS:"2",TAN:"1/2",COT:"2",SEC:"1/2"}[name] || "1";
		articles["A"+name+"H"] = ["Returns the inverse hyperbolic " + en + " of the input.", "Liefert die Zahl, deren hyperbolischer " + de + " den Eingabewert ergibt.", [inverseExample]];
	}
	const labels = {
		en:["Formula help","Find a function","Functions and constants","Example","Close","No matching function.","Help language"],
		de:["Formelhilfe","Funktion suchen","Funktionen und Konstanten","Beispiel","Schließen","Keine passende Funktion gefunden.","Sprache der Hilfe"]
	};
	const bareNames = new Set(["PI","E","TRUE","FALSE"]);
	const topics = new Map(tableCalc.helpTopics.map(topic => [topic.name,topic]));
	const names = [...topics.keys()].sort();
	const get = id => dialog.querySelector("#"+id);
	const search = get("help-search"), list = get("help-list"), language = get("help-language");
	let preferred = navigator.language.toLowerCase().startsWith("de") ? "de" : "en";

	function display() {
		const name = list.value, topic = topics.get(name);
		const de = preferred === "de";
		const [title,find,entries,example,close,empty,languageLabel] = labels[preferred];
		dialog.lang = language.value = preferred;
		get("formula-help-title").textContent = title;
		get("help-search-label").textContent = find;
		list.setAttribute("aria-label",entries);
		language.setAttribute("aria-label",languageLabel);
		get("help-close").textContent = close;
		get("help-empty").textContent = empty;
		get("help-empty").hidden = !!topic;
		get("help-article").hidden = !topic;
		if (!topic) return;
		const [english,german,exampleArgs] = articles[topic.name];
		const {args} = topic;
		const bare = bareNames.has(topic.name) && args !== undefined;
		get("help-name").textContent = name;
		get("help-description").textContent = de ? german : english;
		get("help-syntax").textContent = (bare ? name+" · " : "") + name + (args === undefined ? "" : "("+args+")");
		get("help-example-label").textContent = example;
		get("help-example").textContent = "=" + name + (exampleArgs ? "("+exampleArgs.join(", ")+")" : "");
	}
	function filter(select) {
		const query = search.value.trim().toUpperCase();
		const matches = names.filter(name => name.includes(query));
		list.replaceChildren(...matches.map(name => new Option(name,name)));
		if (matches.length) list.value = matches.includes(select) ? select : matches.includes(query) ? query : matches[0];
		display();
	}
	search.oninput = () => filter();
	search.onkeydown = event => {
		if (list.length && ["ArrowDown","Enter"].includes(event.key)) { event.preventDefault(); list.focus(); }
	};
	list.onchange = display;
	language.onchange = () => {
		preferred = language.value;
		display();
	};

	// Track nested calls up to the caret. Quoted text and worksheet names are single tokens.
	function atCaret(text,caret) {
		if (!text.startsWith("=")) return;
		const calls = [];
		let previous, closed;
		const tokens = /"(?:[^"]|"")*(?:"|$)|'(?:[^']|'')*(?:'|$)|[\p{L}_][\p{L}\d_.]*|[^\s]/gu;
		for (const match of text.matchAll(tokens)) {
			const start = match.index, token = match[0].toUpperCase(), end = start + match[0].length;
			if (start > caret) break;
			const topic = topics.get(token);
			if (topic && caret <= end) {
				const next = text.slice(end).trimStart()[0];
				if (next === "(" || (bareNames.has(topic.name) && next !== "!")) return token;
			}
			if (end > caret) break;
			closed = undefined;
			if (token === "(") calls.push(topics.has(previous) ? previous : null);
			if (token === ")") closed = calls.pop();
			previous = token;
		}
		return closed || calls.reverse().find(Boolean);
	}
	let restore;
	function close() {
		dialog.close();
		restore?.();
		restore = undefined;
	}
	get("help-close").onclick = close;
	dialog.oncancel = event => { event.preventDefault(); close(); };
	return (text,caret,highlighted,onClose) => {
		restore = onClose;
		search.value = "";
		filter(highlighted || atCaret(text,caret) || "SUM");
		dialog.showModal();
	};
}
