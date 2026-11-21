"use strict";

const tableSheet = (() => {
	function numeric(value) {
		if (typeof value !== "string" && !tableFormats.isNumber(value)) return null;
		const text = tableFormats.textValue(value).trim().replace(",", ".");
		return /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) ? text : null;
	}
	// Decimal coefficients keep sum and number series exact for CSV and 64-bit integers.
	function decimal(text) {
		const [base, exponent = "0"] = text.toLowerCase().split("e");
		const scale = (base.split(".")[1]?.length || 0) - Number(exponent);
		if (Math.abs(scale) > 4096 || base.length > 4096) return null;
		return { n: BigInt(base.replace(".", "")), scale };
	}
	function add(a, b, factor = 1n) {
		const scale = Math.max(a.scale, b.scale);
		return { n: a.n * 10n ** BigInt(scale - a.scale) + factor * b.n * 10n ** BigInt(scale - b.scale), scale };
	}
	function string({ n, scale }) {
		const digits = (n < 0n ? -n : n).toString();
		if (!n) return "0";
		const padded = digits.padStart(scale + 1, "0");
		const abs = scale <= 0 ? digits + "0".repeat(-scale) :
			(padded.slice(0, -scale) + "." + padded.slice(-scale)).replace(/\.?0+$/, "");
		return (n < 0n ? "-" : "") + abs;
	}
	function statistics(rows, cols, sheet) {
		let count = 0, numbers = 0, sum = { n: 0n, scale: 0 };
		for (const r of rows) for (const c of cols) {
			const value = sheet.rows[r][c];
			if (value == null || value === "") continue;
			count++;
			const text = numeric(value);
			if (text === null) continue;
			const d = decimal(text); numbers++;
			sum = sum && d ? add(sum, d) : null;
		}
		let average = "—";
		if (numbers && sum) {
			const divisor = BigInt(numbers), scaled = sum.n * 10n ** 12n;
			average = string({ n: (scaled + (scaled < 0n ? -1n : 1n) * (divisor / 2n)) / divisor, scale: sum.scale + 12 });
		}
		return { count, sum: numbers && sum ? string(sum) : "—", average };
	}
	const calendars = [
		"Jan Feb Mär Apr Mai Jun Jul Aug Sep Okt Nov Dez", "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",
		"Januar Februar März April Mai Juni Juli August September Oktober November Dezember",
		"January February March April May June July August September October November December"
	].map(list => list.split(" "));
	function series(values) {
		const repeat = i => values[(i % values.length + values.length) % values.length];
		if (values.length > 1) {
			const decimals = values.map(v => { const text = numeric(v); return text && decimal(text); });
			if (decimals.every(Boolean)) {
				const step = add(decimals[1], decimals[0], -1n);
				if (decimals.every((d, i) => add(d, add(decimals[0], step, BigInt(i)), -1n).n === 0n))
					return i => string(add(decimals[0], step, BigInt(i)));
			}
		}
		for (const names of calendars) {
			const indexes = values.map(v => names.findIndex(name => typeof v === "string" && name.toLowerCase() === v.toLowerCase()));
			const step = indexes.length === 1 ? 1 : (indexes[1] - indexes[0] + 12) % 12;
			if (indexes.every((n, i) => n >= 0 && n === (indexes[0] + i * step) % 12))
				return i => names[((indexes[0] + i * step) % 12 + 12) % 12];
		}
		return repeat;
	}
	const numberFormats = new Map();
	function formatted(value, style, fallback) {
		if (!style?.format || style.format === "general") return fallback;
		if (style.format === "date") return tableWorkbook.dateText(value) ?? fallback;
		const text = numeric(value);
		if (text === null) return fallback;
		const digits = style.digits ?? 2, key = style.format + digits;
		if (!numberFormats.has(key)) numberFormats.set(key, new Intl.NumberFormat(undefined, {
			style: style.format === "number" ? "decimal" : style.format, currency: "EUR",
			minimumFractionDigits: digits, maximumFractionDigits: digits
		}));
		return numberFormats.get(key).format(text);
	}
	return { numeric, statistics, series, formatted };
})();
