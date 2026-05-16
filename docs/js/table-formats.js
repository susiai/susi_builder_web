"use strict";

const { tableFormats, tableParquet } = (() => {
	const encoder = new TextEncoder();
	const number = text => new LosslessJSON.LosslessNumber(String(text));
	const isNumber = value => typeof value === "number" || LosslessJSON.isLosslessNumber(value);
	const record = value => value !== null && typeof value === "object" && !Array.isArray(value) && !isNumber(value);
	const json = LosslessJSON.stringify;

	function textValue(value) {
		if (value === undefined || value === null) return "";
		return typeof value === "string" ? value : json(value);
	}

	function csvSheet(text, bom, encoding, maxRows) {
		// Look for the separator in the first logical record, excluding quoted fields.
		const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
		let quoted = false;
		for (const ch of text) {
			if (ch === '"') quoted = !quoted;
			else if (!quoted && (ch === "\r" || ch === "\n")) break;
			else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
		}
		const delimiter = [...counts].sort((a, b) => b[1] - a[1])[0][0];
		const records = [];
		let row = [], field = "", closed = false, eol = "";
		quoted = false;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (quoted) {
				if (ch !== '"') field += ch;
				else if (text[i + 1] === '"') { field += '"'; i++; }
				else { quoted = false; closed = true; }
			} else if (ch === delimiter) {
				row.push(field); field = ""; closed = false;
			} else if (ch === "\r" || ch === "\n") {
				const crlf = ch === "\r" && text[i + 1] === "\n";
				if (!eol) eol = crlf ? "\r\n" : ch;
				if (crlf) i++;
				row.push(field); records.push(row);
				row = []; field = ""; closed = false;
				if (records.length > maxRows) break; // The first record is the header.
			} else if (ch === '"' && !field && !closed) {
				quoted = true;
			} else {
				if (ch === '"' || closed) throw new Error(`Invalid quote in CSV record ${records.length + 1}.`);
				field += ch;
			}
		}
		if (quoted) throw new Error(`Unclosed quote in CSV record ${records.length + 1}.`);
		const trailing = /[\r\n]$/.test(text);
		if (text && !trailing && records.length <= maxRows) { row.push(field); records.push(row); }
		const header = records.shift() || [];
		const width = records.reduce((n, r) => Math.max(n, r.length), header.length);
		const columns = Array.from({ length: width }, (_, i) => ({ name: header[i] ?? "", implicit: i >= header.length }));
		return { format: "csv", columns, rows: records, csv: { delimiter, eol: eol || "\r\n", trailing, bom, encoding } };
	}

	function jsonSheet(text, maxRows) {
		const records = [];
		const names = new Set();
		let values = false;
		let lineNumber = 0;
		for (const [line] of text.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/g)) {
			if (records.length >= maxRows) break;
			lineNumber++;
			if (!line.trim()) continue;
			let value;
			try { value = LosslessJSON.parse(line); } catch (error) {
				throw new Error(`Invalid JSON on line ${lineNumber}. ${error.message}`);
			}
			records.push(value);
			if (record(value)) {
				const keys = Object.keys(value);
				// JavaScript enumerates integer keys first. Read their written order when discovering columns.
				if (keys.length > 1 && /^\d+$/.test(keys[0]) && keys.some(key => !names.has(key))) {
					let depth = 0;
					for (const [token] of line.matchAll(/"(?:\\.|[^"\\])*"(?:\s*:)?|[{}\[\]]/g)) {
						if (token === "{" || token === "[") depth++;
						else if (token === "}" || token === "]") depth--;
						else if (depth === 1 && token.endsWith(":")) names.add(JSON.parse(token.slice(0, -1)));
					}
				} else keys.forEach(key => names.add(key));
			} else values = true;
		}
		const columns = (values ? ["value"] : [...names]).map(name => ({ name }));
		const rows = records.map(obj => values ? [obj] : columns.map(({ name }) => Object.hasOwn(obj, name) ? obj[name] : undefined));
		return { format: "jsonl", columns, rows, values };
	}

	async function read(format, bytes, maxRows = Infinity) {
		if (format === "parquet") return parquet.read(bytes, maxRows);
		if (format === "csv") {
			const { text, encoding } = decodeTableText(format, bytes);
			const bom = text.startsWith("\uFEFF");
			return csvSheet(bom ? text.slice(1) : text, bom, encoding, maxRows);
		}
		if (format === "jsonl") return jsonSheet(decodeTableText(format, bytes).text.replace(/^\uFEFF/, ""), maxRows);
		throw new Error("Choose a CSV, JSONL or Parquet file.");
	}

	function write(sheet, format) {
		const { columns, rows } = sheet;
		if (format !== "csv" && new Set(columns.map(c => c.name)).size !== columns.length) {
			throw new Error("Give each column a unique name before saving in this format.");
		}
		if (format === "parquet") return parquet.write(sheet);
		if (format === "jsonl") {
			const keys = columns.map(column => JSON.stringify(column.name));
			const lines = rows.map(row => {
				if (sheet.values) return json(row[0] ?? null);
				const entries = [];
				for (const [c, { field }] of columns.entries()) {
					if (row[c] !== undefined) {
						const value = field ? parquet.jsonValue(field, row[c]) : row[c];
						entries.push(keys[c] + ":" + json(value));
					}
				}
				return "{" + entries.join(",") + "}";
			});
			return encoder.encode(lines.length ? lines.join("\n") + "\n" : "");
		}
		if (format !== "csv") throw new Error("Choose a supported file format.");
		const { delimiter, eol, trailing, bom } = sheet.csv || { delimiter: ",", eol: "\r\n", trailing: true };
		function line(fields, header = false) {
			return fields.map(v => {
				const s = textValue(v);
				return s.includes(delimiter) || /["\r\n]/.test(s) || (header && /[,;\t]/.test(s)) || (!s && fields.length === 1)
					? '"' + s.replaceAll('"', '""') + '"' : s;
			}).join(delimiter);
		}
		// A short CSV header and short records can be preserved independently.
		const header = columns.map(c => c.name);
		while (header.length && columns[header.length - 1].implicit) header.pop();
		const lines = header.length || rows.length ? [line(header, true), ...rows.map(row => line(row))] : [];
		const text = (bom ? "\uFEFF" : "") + lines.join(eol) + (trailing && lines.length ? eol : "");
		return encodeTableText(text, sheet.csv?.encoding);
	}

	function kind(value) {
		if (value === undefined) return "missing";
		if (value === null) return "null";
		if (isNumber(value)) return "number";
		if (typeof value === "string") return "text";
		if (typeof value === "boolean") return "boolean";
		return "json";
	}

	function parseCell(type, text) {
		if (type === "missing") return undefined;
		if (type === "null") return null;
		if (type === "text") return text;
		if (type === "boolean" && !/^(true|false)$/.test(text.trim())) throw new Error("Enter true or false.");
		if (type === "number" && !LosslessJSON.isNumber(text.trim())) throw new Error("Enter a valid number.");
		return LosslessJSON.parse(text.trim());
	}

	const parquet = (() => {
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		const million = 1000000n;
		const day = 86400000000000n;

		function fieldType(e) {
			return e.logical_type?.type || e.converted_type || e.type || "STRUCT";
		}

		function integer(value, bits, signed) {
			if (!/^-?\d+$/.test(String(value))) throw new Error("Enter a whole number.");
			const n = BigInt(String(value));
			if (n !== (signed ? BigInt.asIntN(bits, n) : BigInt.asUintN(bits, n))) {
				throw new Error(`Value exceeds the ${signed ? "signed" : "unsigned"} ${bits}-bit range.`);
			}
			return n;
		}

		function decimal(value, e, writing) {
			const scale = e.scale ?? e.logical_type.scale;
			const precision = e.precision ?? e.logical_type.precision;
			if (writing) {
				const parts = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
				if (!parts || (parts[3]?.length || 0) > scale) throw new Error(`Enter a decimal with up to ${scale} fractional digits.`);
				const n = BigInt(parts[1] + parts[2] + (parts[3] || "").padEnd(scale, "0"));
				if (String(n).replace("-", "").length > precision) throw new Error(`Decimal precision is ${precision} digits.`);
				return n;
			}
			let n;
			if (value instanceof Uint8Array) {
				n = 0n;
				for (const b of value) n = (n << 8n) + BigInt(b);
				n = BigInt.asIntN(value.length * 8, n);
			} else n = BigInt(value);
			const digits = String(n < 0n ? -n : n).padStart(scale + 1, "0");
			return number((n < 0n ? "-" : "") + (scale ? digits.slice(0, -scale) + "." + digits.slice(-scale) : digits));
		}

		function temporal(value, e, writing) {
			const type = fieldType(e);
			const unit = e.logical_type?.unit || type.split("_")[1] || "NANOS";
			const digits = { MILLIS: 3, MICROS: 6, NANOS: 9 }[unit];
			const step = 10n ** BigInt(9 - digits);
			const stamp = type.startsWith("TIMESTAMP") || e.type === "INT96";
			const utc = e.logical_type?.isAdjustedToUTC ?? true;
			if (!writing) {
				const nanos = BigInt(value) * step;
				if (!stamp && (nanos < 0n || nanos >= day)) return number(value);
				const fraction = (nanos % day + day) % day;
				const time = new Date(Number(fraction / million)).toISOString().slice(11, 19);
				const clock = time + "." + String(fraction % 1000000000n).padStart(9, "0").slice(0, digits);
				if (!stamp) return clock;
				const midnight = new Date(Number((nanos - fraction) / million));
				if (!Number.isFinite(+midnight)) return number(value);
				return midnight.toISOString().split("T")[0] + "T" + clock + (utc ? "Z" : "");
			}
			if (isNumber(value)) {
				const ticks = integer(value, e.type === "INT32" ? 32 : 64, true);
				return e.type === "INT32" ? Number(ticks) : ticks;
			}
			const match = /^(?:((?:\d{4}|[+-]\d{6})-\d{2}-\d{2})T)?(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z)?$/.exec(value);
			if (!match || !!match[1] !== stamp || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 ||
				(match[5]?.length || 0) > digits || (match[6] && (!utc || !stamp))) {
				throw new Error(`Enter ${stamp ? "an ISO timestamp" : "HH:MM:SS"} with up to ${digits} fractional digits.`);
			}
			const date = new Date((match[1] || "1970-01-01") + "T00:00:00Z");
			if (!Number.isFinite(+date) || (stamp && !date.toISOString().startsWith(match[1] + "T"))) throw new Error("Invalid date.");
			const seconds = +match[2] * 3600 + +match[3] * 60 + +match[4];
			const ticks = (BigInt(+date) * million + BigInt(seconds) * 1000000000n + BigInt((match[5] || "").padEnd(9, "0"))) / step;
			return e.type === "INT32" ? Number(ticks) : integer(ticks, 64, true);
		}

		function bytes(value, e, writing) {
			if (!writing) return Array.from(value, b => b.toString(16).padStart(2, "0")).join("");
			if (typeof value !== "string" || !/^(?:[\da-f]{2})*$/i.test(value)) throw new Error("Enter bytes as pairs of hexadecimal digits.");
			if (e.type_length && value.length !== 2 * e.type_length) throw new Error(`Enter exactly ${e.type_length} bytes.`);
			return Uint8Array.from(value.match(/../g) || [], pair => parseInt(pair, 16));
		}

		function convert(node, value, writing, repeated = false) {
			const e = node.element;
			const type = fieldType(e);
			if (value == null) {
				if (writing && e.repetition_type === "REQUIRED") throw new Error(`${e.name} is required.`);
				return null;
			}
			if (e.repetition_type === "REPEATED" && !repeated) {
				if (!Array.isArray(value)) throw new Error("Enter a JSON array.");
				return value.map(item => convert(node, item, writing, true));
			}
			if (type === "LIST") {
				if (!Array.isArray(value)) throw new Error("Enter a JSON array.");
				const child = node.children[0];
				return value.map(v => convert(child.children.length === 1 ? child.children[0] : child, v, writing, true));
			}
			if (type === "MAP") {
				const entry = node.children[0];
				// Read the physical entries to retain non-string keys, order and duplicate keys.
				const entries = writing ? value : value[entry.element.name];
				if (!Array.isArray(entries)) throw new Error("Enter a JSON array of key/value entries.");
				return entries.map(item => convert(entry, item, writing, true));
			}
			if (node.children.length) {
				if (!record(value)) throw new Error("Enter a JSON object with the fields in this schema.");
				if (writing && Object.keys(value).some(key => !node.children.some(c => c.element.name === key))) {
					throw new Error("Object contains a field outside the Parquet schema.");
				}
				const fields = Object.fromEntries(node.children.map(child => {
					const key = child.element.name;
					return [key, convert(child, Object.hasOwn(value, key) ? value[key] : null, writing)];
				}));
				if (writing && type === "VARIANT") Hyparquet.decodeVariantColumn(fields);
				return fields;
			}
			if (type === "DECIMAL") return decimal(value, e, writing);
			if (type === "DATE") {
				if (!writing) {
					const date = new Date(Number(value) * 86400000);
					return Number.isFinite(+date) ? date.toISOString().split("T")[0] : number(value);
				}
				if (isNumber(value)) return Number(integer(value, 32, true));
				const date = new Date(value + "T00:00:00Z");
				if (!Number.isFinite(+date) || date.toISOString().split("T")[0] !== value) throw new Error("Enter a date as YYYY-MM-DD.");
				return +date / 86400000;
			}
			if (type.startsWith("TIME") || e.type === "INT96") return temporal(value, e, writing);
			if (type === "JSON") {
				if (!writing) return value;
				LosslessJSON.parse(value);
				return encoder.encode(value);
			}
			if (["STRING", "UTF8", "ENUM"].includes(type)) {
				if (typeof value !== "string") throw new Error("Enter a text value.");
				return writing ? encoder.encode(value) : value;
			}
			if (type === "UUID") {
				if (writing && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)) throw new Error("Enter a UUID.");
				return value;
			}
			if (type === "UNKNOWN") throw new Error("This column only accepts null.");
			if (e.type === "BOOLEAN") {
				if (writing && typeof value !== "boolean") throw new Error("Enter true or false.");
				return Boolean(value);
			}
			if (["INT32", "INT64"].includes(e.type)) {
				if (!writing) return number(value);
				const bits = e.logical_type?.bitWidth || Number(/INT_(\d+)/.exec(type)?.[1]) || Number(e.type.slice(3));
				const signed = e.logical_type?.isSigned ?? !type.startsWith("UINT");
				const n = integer(value, bits, signed);
				return e.type === "INT32" ? Number(n) : n;
			}
			if (["FLOAT", "DOUBLE"].includes(e.type) || type === "FLOAT16") {
				if (!writing) return Number.isFinite(value) ? number(Object.is(value, -0) ? "-0" : value) : String(value);
				if (["NaN", "Infinity", "-Infinity"].includes(value)) return Number(value);
				if (!isNumber(value) || !Number.isFinite(Number(String(value)))) throw new Error("Enter a floating-point number.");
				return Number(String(value));
			}
			const binary = bytes(value, e, writing);
			if (writing && (type === "GEOMETRY" || type === "GEOGRAPHY")) {
				const reader = { view: new DataView(binary.buffer, binary.byteOffset, binary.byteLength), offset: 0 };
				Hyparquet.wkbToGeojson(reader);
				if (reader.offset !== binary.length) throw new Error("Unexpected bytes after the WKB geometry.");
			}
			return binary;
		}

		// These cells expose their physical data so editing another column preserves WKB dimensions and variant subtypes.
		function storageSchema(e) {
			return ["VARIANT", "GEOMETRY", "GEOGRAPHY", "JSON"].includes(fieldType(e))
				? { ...e, converted_type: undefined, logical_type: undefined } : e;
		}

		function physicalReadSchema(e) {
			const type = fieldType(e);
			if (["DECIMAL", "BSON", "INTERVAL", "MAP"].includes(type)) return { ...e, converted_type: undefined, logical_type: undefined };
			if (type === "ENUM") return { ...e, converted_type: "UTF8" };
			if (type === "JSON") return { ...e, converted_type: "JSON" };
			return storageSchema(e);
		}

		async function read(bytes, maxRows = Infinity) {
			const file = bytes.byteOffset || bytes.byteLength !== bytes.buffer.byteLength ? bytes.slice().buffer : bytes.buffer;
			const metadata = Hyparquet.parquetMetadata(file);
			const tree = Hyparquet.parquetSchema(metadata);
			const columns = tree.children.map(field => ({ name: field.element.name, field }));
			const parsers = {
				dateFromDays: v => v, timestampFromMilliseconds: v => v, timestampFromMicroseconds: v => v,
				timestampFromNanoseconds: v => v, stringFromBytes: v => decoder.decode(v), jsonFromBytes: v => decoder.decode(v)
			};
			let rows = [];
			const rowEnd = Math.min(Number(metadata.num_rows), maxRows);
			if (rowEnd > 0) await Hyparquet.parquetRead({
				file, metadata: { ...metadata, schema: metadata.schema.map(physicalReadSchema) }, utf8: false,
				parsers, compressors: Hyparquet.compressors, rowFormat: "array", rowEnd,
				onComplete(data) { rows = data.map(row => columns.map(({ field }, i) => convert(field, row[i], false))); }
			});
			return { format: "parquet", columns, rows, root: tree.element, metadata: metadata.key_value_metadata,
				originalFields: tree.children, originalRows: rows.length };
		}

		function leaf(name, type, converted_type) {
			return { element: { name, type, converted_type, repetition_type: "OPTIONAL" }, children: [] };
		}

		function infer(name, data) {
			const values = data.filter(v => v != null);
			if (!values.length || values.every(v => typeof v === "string")) return leaf(name, "BYTE_ARRAY", "UTF8");
			if (values.every(v => typeof v === "boolean")) return leaf(name, "BOOLEAN");
			if (values.every(isNumber)) {
				if (values.every(v => /^-?\d+$/.test(String(v)) && BigInt(String(v)) === BigInt.asIntN(64, BigInt(String(v))))) {
					return leaf(name, "INT64");
				}
				if (values.every(v => LosslessJSON.isSafeNumber(String(v)) && Number.isFinite(Number(String(v))))) return leaf(name, "DOUBLE");
			}
			return leaf(name, "BYTE_ARRAY", "JSON");
		}

		function write(sheet) {
			if (!sheet.columns.length) throw new Error("Parquet requires at least one column.");
			const schema = [{ ...sheet.root, name: sheet.root?.name || "schema", num_children: sheet.columns.length }];
			let schemaChanged = sheet.originalFields?.length !== sheet.columns.length;
			function append(node, name) {
				const e = { ...node.element, name };
				const type = fieldType(e);
				if (e.type === "INT96") {
					e.type = "INT64";
					e.logical_type = { type: "TIMESTAMP", unit: "NANOS", isAdjustedToUTC: true };
					schemaChanged = true;
				}
				if (type === "DECIMAL") {
					e.converted_type = "DECIMAL"; e.scale ??= e.logical_type.scale; e.precision ??= e.logical_type.precision;
				}
				schema.push(e);
				node.children.forEach(child => append(child, child.element.name));
			}
			const columnData = sheet.columns.map(({ name, field }, c) => {
				if (field !== sheet.originalFields?.[c] || name !== field?.element.name) schemaChanged = true;
				const data = sheet.rows.map(row => row[c]);
				const node = field || infer(name, data);
				append(node, name);
				return { name, data: data.map((v, r) => {
					try {
						if (!field && fieldType(node.element) === "JSON" && v != null) v = json(v);
						return convert(node, v, true);
					} catch (error) { throw new Error(`Row ${r + 1}, column "${name}". ${error.message}`); }
				}) };
			});
			// Arrow/Pandas footer entries can refer to the original columns and Pandas range index.
			const kvMetadata = sheet.metadata?.filter(({ key }) =>
				!(key === "ARROW:schema" && schemaChanged) &&
				!(key === "pandas" && (schemaChanged || sheet.rows.length !== sheet.originalRows)));
			const buffer = new Hyparquet.ByteWriter();
			const writer = new Hyparquet.ParquetWriter({ writer: buffer, schema: schema.map(storageSchema), kvMetadata, statistics: false });
			writer.write({ columnData });
			// The physical pages already contain the encoded values. The footer carries their original logical annotations.
			writer.schema = schema;
			writer.finish();
			return new Uint8Array(buffer.getBuffer());
		}

		function kind(field) {
			const e = field.element, type = fieldType(e);
			if (field.children.length || e.repetition_type === "REPEATED") return "json";
			if (type === "DATE" || type.startsWith("TIME") || e.type === "INT96") return "text";
			if (type === "DECIMAL" || type === "FLOAT16" || ["INT32", "INT64", "DOUBLE", "FLOAT"].includes(e.type)) return "number";
			if (e.type === "BOOLEAN") return "boolean";
			return "text";
		}

		// JSON-annotated Parquet cells keep the literal text in the editor, distinguishing JSON null from a null field.
		function jsonValue(node, value, repeated = false) {
			if (!node || value == null) return value;
			const type = fieldType(node.element);
			if (node.element.repetition_type === "REPEATED" && !repeated) return value.map(v => jsonValue(node, v, true));
			if (type === "JSON") return LosslessJSON.parse(value);
			if (type === "LIST") {
				const child = node.children[0];
				return value.map(v => jsonValue(child.children.length === 1 ? child.children[0] : child, v, true));
			}
			if (type === "MAP") return value.map(v => jsonValue(node.children[0], v, true));
			if (node.children.length) {
				return Object.fromEntries(node.children.map(child => [child.element.name, jsonValue(child, value[child.element.name])]));
			}
			return value;
		}

		function label(field) {
			const e = field.element, type = fieldType(e);
			if (type === "DECIMAL") return `Decimal (${e.precision ?? e.logical_type.precision}, ${e.scale ?? e.logical_type.scale})`;
			if (type === "UTF8" || type === "STRING") return "Text";
			if (type === "BYTE_ARRAY" || type === "FIXED_LEN_BYTE_ARRAY") return "Hex bytes";
			if (type === "GEOMETRY" || type === "GEOGRAPHY") return "WKB (hex)";
			if (type === "VARIANT") return "Variant fields";
			if (type === "INT96") return "Timestamp (ns)";
			return type.replaceAll("_", " ").toLowerCase();
		}

		return { read, write, kind, label, fieldType, leaf, jsonValue, validate: (field, value) => convert(field, value, true) };
	})();

	return {
		tableFormats: { read, write, extension: tableFileFormat, textValue, json, kind, parseCell, number, isNumber, record },
		tableParquet: parquet
	};
})();
