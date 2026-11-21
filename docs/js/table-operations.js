"use strict";

const tableOperations = (() => {
	const fieldTypes = { text: ["BYTE_ARRAY", "UTF8"], integer: ["INT64"], number: ["DOUBLE"], boolean: ["BOOLEAN"] };

	// Canonical keys distinguish types and ignore object key order and numeric spelling.
	function valueKey(value) {
		switch (tableFormats.kind(value)) {
			case "number": return ["number", LosslessJSON.splitNumber(String(value))];
			case "json": return Array.isArray(value) ? ["array", value.map(valueKey)] :
				["object", Object.keys(value).sort().map(key => [key, valueKey(value[key])])];
			default: return [typeof value, value];
		}
	}

	function profile(rows, column) {
		const counts = new Map(), keys = [];
		let empty = 0;
		for (const cells of rows) {
			const value = cells[column];
			if (value == null || value === "") { keys.push(null); empty++; continue; }
			const key = filterKey(value);
			keys.push(key); counts.set(key, (counts.get(key) || 0) + 1);
		}
		const duplicates = new Set();
		keys.forEach((key, row) => { if (counts.get(key) > 1) duplicates.add(row); });
		return { empty, distinct: counts.size, repeated: [...counts.values()].filter(n => n > 1).length, duplicates };
	}

	function convert(value, target, separator) {
		if (value == null) return value;
		const text = tableFormats.textValue(value);
		if (target === "text") return text;
		if (!text.trim()) return null;
		if (target === "boolean") return tableFormats.parseCell("boolean", text.trim().toLowerCase());
		const numeric = typeof value === "string" && separator === "," ? text.trim().replace(",", ".") : text.trim();
		if (typeof value === "string" && separator === "," && text.includes(".")) throw new Error("Use a comma as the decimal separator.");
		if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(numeric)) throw new Error("Invalid numeric value.");
		const normalized = numeric.replace(/^\+/, "").replace(/^(-?)0+(?=\d)/, "$1");
		if (target === "integer") {
			const { digits, exponent, sign } = LosslessJSON.splitNumber(normalized);
			if (exponent - digits.length + 1 < 0) throw new Error("A whole number is required.");
			if (exponent > 18) throw new Error("Outside the 64-bit integer range.");
			return tableFormats.number(sign + digits.padEnd(exponent + 1, "0"));
		}
		const number = Number(normalized);
		if (!Number.isFinite(number) || LosslessJSON.compareNumber(normalized, String(number)) !== 0)
			throw new Error("This value would lose precision as a double.");
		return tableFormats.number(String(number));
	}

	function filterKey(value) {
		return value == null || value === "" ? "" : JSON.stringify(valueKey(value));
	}
	return { profile, filterKey, convert, field: (name, type) => tableParquet.leaf(name, ...fieldTypes[type]) };
})();
