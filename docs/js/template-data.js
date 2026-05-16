(globalThis.document?.currentScript?.susiSource || (run => run.call(globalThis)))(function () { /* susi source */
"use strict";

// Each record follows the column order. Keep display values as text so identifiers and long decimals survive export.
const projectDataView = (() => {
	const { name, columns, rows } = projectDataset;
	const byId = id => document.getElementById(id);
	const grid = byId('data-grid'), groups = byId('grouped-table'), profile = byId('column-profile');
	const search = byId('data-search'), searchColumn = byId('data-search-column');
	const numberFormat = new Intl.NumberFormat('en');
	const percent = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });
	const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
	const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i;
	const missing = value => value === null || value === '';
	const names = new Map();
	for (const name of columns) names.set(name, (names.get(name) || 0) + 1);
	const labels = columns.map((name, i) => !name ? 'Column ' + (i + 1) : names.get(name) > 1 ? name + ' (' + (i + 1) + ')' : name);

	// Only ties in native floating-point order need the original decimal digits (including unsafe integers).
	function decimalParts(text) {
		const [mantissa, exponent = '0'] = text.toLowerCase().replace(/^-/, '').split('e');
		const [whole, fraction = ''] = mantissa.split('.');
		const digits = (whole + fraction).replace(/^0+/, '');
		return { sign: digits ? (text.startsWith('-') ? -1 : 1) : 0,
			magnitude: BigInt(exponent) + BigInt(digits.length - fraction.length), digits: digits.replace(/0+$/, '') };
	}
	function compare(a, b, type) {
		if (a === b) return 0;
		if (type !== 'Number') return collator.compare(a, b);
		const left = Number(a), right = Number(b);
		if (left < right) return -1;
		if (left > right) return 1;
		const x = decimalParts(a), y = decimalParts(b);
		if (x.sign !== y.sign) return x.sign - y.sign;
		if (x.magnitude !== y.magnitude) return (x.magnitude < y.magnitude ? -1 : 1) * x.sign;
		return (x.digits < y.digits ? -1 : x.digits > y.digits ? 1 : 0) * x.sign;
	}
	function describe(records, index, knownType) {
		const values = new Set();
		let empty = 0;
		for (const row of records) {
			if (missing(row[index])) empty++;
			else values.add(row[index]);
		}
		let type = knownType;
		if (!type) {
			const different = [...values];
			if (!different.length) type = 'Empty';
			else if (different.every(value => numberPattern.test(value))) type = 'Number';
			else if (different.every(value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
				Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value + 'T'))) type = 'Date';
			else if (different.every(value => value === 'true' || value === 'false')) type = 'Boolean';
			else type = 'Text';
		}
		let low, high;
		if (type === 'Number' || type === 'Date') for (const value of values) {
			if (low === undefined || compare(value, low, type) < 0) low = value;
			if (high === undefined || compare(value, high, type) > 0) high = value;
		}
		return { type, distinct: values.size, empty, low, high };
	}
	const fullProfile = columns.map((_, i) => describe(rows, i));
	if (byId('data-metric-complete')) {
		const empty = fullProfile.reduce((total, field) => total + field.empty, 0);
		const cells = rows.length * columns.length;
		const complete = columns.length ? rows.reduce((count, row) => count + Number(!row.some(missing)), 0) : 0;
		byId('data-metric-complete').textContent = numberFormat.format(complete);
		byId('data-metric-missing').textContent = numberFormat.format(empty);
		byId('data-metric-coverage').textContent = cells ? percent.format((cells - empty) / cells) : '—';
	}
	let matching = rows, ordered = rows, distribution = [];
	let recordPage = 0, groupPage = 0, sortColumn = -1, direction = 1;
	const visible = columns.map(() => true);
	const groupBy = byId('data-group-by');
	byId('data-name').textContent = name;
	for (const [i, label] of labels.entries()) {
		searchColumn.add(new Option(label, i));
		if (groups) groupBy.add(new Option(label, i));
	}
	if (groups) {
		const candidate = fullProfile.findIndex(field => field.type === 'Text' && field.distinct > 1 && field.distinct <= rows.length / 3);
		if (candidate >= 0) groupBy.value = String(candidate);
		groupBy.disabled = !columns.length;
	}

	function cell(tr, text, numeric = false, rowHeading = false) {
		const el = document.createElement(rowHeading ? 'th' : 'td');
		if (rowHeading) el.scope = 'row';
		if (numeric) el.className = 'data-number';
		if (missing(text) || text === undefined) { el.textContent = '—'; el.classList.add('data-missing'); }
		else el.textContent = text;
		tr.append(el);
		return el;
	}
	function emptyRow(body, width, message) {
		const tr = document.createElement('tr');
		cell(tr, message).colSpan = Math.max(1, width);
		body.append(tr);
	}
	function pager(id, page, size, length) {
		const control = byId(id + '-pager');
		control.hidden = length <= size;
		control.firstElementChild.disabled = page === 0;
		control.lastElementChild.disabled = (page + 1) * size >= length;
		control.querySelector('span').textContent = 'Page ' + numberFormat.format(page + 1) + ' of ' + numberFormat.format(Math.max(1, Math.ceil(length / size)));
	}

	function orderRows() {
		if (sortColumn < 0) { ordered = matching; return; }
		const type = fullProfile[sortColumn].type;
		ordered = matching.slice().sort((a, b) => {
			const left = a[sortColumn], right = b[sortColumn];
			if (missing(left) || missing(right)) return Number(missing(left)) - Number(missing(right));
			return direction * compare(left, right, type);
		});
	}
	function renderRecords() {
		const size = Number(byId('data-page-size').value), start = recordPage * size;
		const content = document.createDocumentFragment();
		if (columns.length) for (const row of ordered.slice(start, start + size)) {
			const tr = document.createElement('tr');
			for (const [i, show] of visible.entries()) if (show) cell(tr, row[i], fullProfile[i].type === 'Number');
			content.append(tr);
		}
		if (!columns.length) emptyRow(content, 1, 'No columns in this dataset.');
		else if (!ordered.length) emptyRow(content, visible.filter(Boolean).length, rows.length ? 'No matching records.' : 'No records in this dataset.');
		grid.querySelector('tbody').replaceChildren(content);
		pager('records', recordPage, size, columns.length ? ordered.length : 0);
	}
	function headers() {
		const head = grid.querySelector('thead tr');
		head.replaceChildren();
		for (const [i, label] of labels.entries()) {
			if (!visible[i]) continue;
			const th = document.createElement('th'), button = document.createElement('button');
			th.scope = 'col';
			if (fullProfile[i].type === 'Number') th.className = 'data-number';
			button.type = 'button'; button.textContent = label; button.dataset.column = i;
			th.append(button); head.append(th);
		}
		markSort();
	}
	function markSort() {
		for (const button of grid.querySelectorAll('th button')) {
			const order = Number(button.dataset.column) === sortColumn ? (direction > 0 ? 'ascending' : 'descending') : 'none';
			button.parentElement.setAttribute('aria-sort', order);
		}
	}
	if (grid) {
		const fields = byId('data-columns').querySelector('fieldset');
		for (const [i, label] of labels.entries()) {
			const entry = document.createElement('label'), input = document.createElement('input');
			input.type = 'checkbox'; input.checked = true; input.disabled = columns.length === 1;
			input.addEventListener('change', () => {
				visible[i] = input.checked;
				if (!input.checked && sortColumn === i) { sortColumn = -1; recordPage = 0; orderRows(); }
				const single = visible.filter(Boolean).length === 1;
				for (const field of fields.querySelectorAll('input')) field.disabled = single && field.checked;
				headers(); renderRecords();
			});
			entry.append(input, label); fields.append(entry);
		}
		headers();
		grid.querySelector('thead').addEventListener('click', event => {
			const button = event.target.closest('button[data-column]');
			if (!button) return;
			const col = Number(button.dataset.column);
			direction = sortColumn === col ? -direction : 1; sortColumn = col; recordPage = 0;
			markSort(); orderRows(); renderRecords();
		});
		byId('data-page-size').onchange = () => { recordPage = 0; renderRecords(); };
		byId('records-pager').addEventListener('click', event => {
			const button = event.target.closest('[data-page]');
			if (button) { recordPage += Number(button.dataset.page); renderRecords(); }
		});
	}
	function renderGroups() {
		const content = document.createDocumentFragment(), size = 10;
		for (const [value, count] of distribution.slice(groupPage * size, (groupPage + 1) * size)) {
			const tr = document.createElement('tr'), share = count / matching.length;
			cell(tr, value, false, true); cell(tr, numberFormat.format(count), true);
			const bar = document.createElement('meter');
			bar.min = 0; bar.max = 1; bar.value = share; bar.setAttribute('aria-hidden', 'true');
			cell(tr, percent.format(share), true).prepend(bar);
			content.append(tr);
		}
		if (!distribution.length) emptyRow(content, 3, 'No groups to display.');
		groups.querySelector('tbody').replaceChildren(content);
		pager('groups', groupPage, size, distribution.length);
	}
	function groupRows() {
		const index = groupBy.selectedIndex, counts = new Map();
		if (index >= 0) for (const row of matching) {
			const key = missing(row[index]) ? null : row[index];
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		distribution = [...counts].sort(([a, countA], [b, countB]) => countB - countA ||
			(a === null || b === null ? Number(a === null) - Number(b === null) : compare(a, b, fullProfile[index].type)));
		groupPage = 0; renderGroups();
	}
	if (groups) {
		groupBy.onchange = groupRows;
		byId('groups-pager').addEventListener('click', event => {
			const button = event.target.closest('[data-page]');
			if (button) { groupPage += Number(button.dataset.page); renderGroups(); }
		});
	}
	function update() {
		const query = search.value.trim().toLocaleLowerCase(), col = searchColumn.value;
		const contains = value => value !== null && value.toLocaleLowerCase().includes(query);
		matching = !query ? rows : rows.filter(row => col === '' ? row.some(contains) : contains(row[Number(col)]));
		recordPage = 0; orderRows();
		byId('data-count').textContent = numberFormat.format(matching.length) + ' of ' + numberFormat.format(rows.length) +
			(rows.length === 1 ? ' record · ' : ' records · ') + numberFormat.format(columns.length) + (columns.length === 1 ? ' column' : ' columns');
		if (grid) renderRecords();
		if (groups) groupRows();
		if (profile) {
			const content = document.createDocumentFragment();
			for (const [i, label] of labels.entries()) {
				const field = matching === rows ? fullProfile[i] : describe(matching, i, fullProfile[i].type);
				const tr = document.createElement('tr');
				cell(tr, label, false, true); cell(tr, field.type);
				cell(tr, numberFormat.format(field.distinct), true); cell(tr, numberFormat.format(field.empty), true);
				cell(tr, field.low === field.high ? field.low : field.low + ' – ' + field.high);
				content.append(tr);
			}
			if (!columns.length) emptyRow(content, 5, 'No columns in this dataset.');
			profile.querySelector('tbody').replaceChildren(content);
		}
	}
	search.addEventListener('input', update);
	searchColumn.addEventListener('change', update);
	update();
	return { fullProfile, get records() { return ordered; } };
})();

/* end susi source */
globalThis.projectDataView = projectDataView;
});
