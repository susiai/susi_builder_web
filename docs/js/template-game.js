(globalThis.document?.currentScript?.susiSource || (run => run.call(globalThis)))(function () { /* susi source */
"use strict";

(() => {
	const $ = id => document.getElementById(id);
	const board = $('game-board'), map = $('level-grid'), pixels = $('sprite-grid');
	const { level, sprite } = gameData;
	const tileSize = 24;
	const width = level[0].length, height = level.length;
	const colors = { '1': '#233346', '2': '#70dfc3', '3': '#fff3cf', '4': '#ffac58' };
	const tiles = { '.': 'Floor', '#': 'Wall', '*': 'Crystal', S: 'Player start', E: 'Exit gate' };
	const keys = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', a: 'left', s: 'down', d: 'right' };
	const directions = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
	let player, remaining, total, moves, won;
	const cursors = new Map();
	for (const canvas of [board, map].filter(Boolean)) {
		canvas.width = width * tileSize;
		canvas.height = height * tileSize;
	}
	if (pixels) pixels.width = pixels.height = 128;

	function paintSprite(ctx, x, y, scale) {
		for (const [row, line] of sprite.entries()) {
			for (let col = 0; col < line.length; col++) {
				if (line[col] === '.') continue;
				ctx.fillStyle = colors[line[col]];
				ctx.fillRect(x + col * scale, y + row * scale, scale, scale);
			}
		}
	}

	function drawMap(canvas) {
		const ctx = canvas.getContext('2d');
		const playing = canvas === board;
		for (const [y, line] of level.entries()) {
			for (let x = 0; x < width; x++) {
				const t = line[x], px = x * tileSize, py = y * tileSize;
				const rect = (color, dx, dy, w, h) => { ctx.fillStyle = color; ctx.fillRect(px + dx, py + dy, w, h); };
				rect((x + y) % 2 ? '#192b38' : '#1c303e', 0, 0, 24, 24);
				rect('#2e4754', 3 + (x * 7 + y) % 16, 5 + (x + y * 3) % 13, 2, 1);
				if (t === '#') {
					rect('#162532', 0, 0, 24, 24);
					rect('#3c596b', 0, 0, 23, 20);
					rect('#63818a', 0, 0, 23, 2);
					rect('#30495a', 1, 14, 21, 5);
					rect('#486678', 2, 3, 8, 2);
					rect('#233a49', 0, 20, 23, 3);
				} else if (t === '*' && (!playing || remaining.has(y * width + x))) {
					rect('#11202a', 7, 18, 11, 2);
					rect('#ac622d', 10, 3, 4, 17);
					rect('#ed9846', 8, 5, 8, 13);
					rect('#ffd076', 6, 8, 12, 7);
					rect('#fff3bd', 8, 8, 3, 5);
					rect('#cc7639', 14, 12, 3, 3);
				} else if (t === 'E') {
					const open = !playing || remaining.size === 0;
					rect('#0a1924', 3, 3, 18, 19);
					rect('#7d839d', 4, 3, 3, 18);
					rect('#adb6d3', 6, 2, 12, 3);
					rect('#65748d', 17, 3, 3, 18);
					if (!open) for (const dx of [8,12,16]) rect('#6c7b92', dx, 7, 1, 12);
					rect(open ? '#82e6cd' : '#d8a574', 10, 5, 4, 2);
					rect(open ? '#66aeac' : '#526575', 3, 20, 18, 2);
				}
				if ((!playing && t === 'S') || (playing && player.x === x && player.y === y)) {
					rect('#0d1e29', 4, 19, 16, 2);
					paintSprite(ctx, px + 4, py + 3, 2);
				}
			}
		}
	}

	function draw() {
		if (board) drawMap(board);
		if (map) drawMap(map);
		if (pixels) {
			const ctx = pixels.getContext('2d');
			for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
				ctx.fillStyle = (x + y) % 2 ? '#344754' : '#405766';
				ctx.fillRect(x * 16, y * 16, 16, 16);
			}
			paintSprite(ctx, 0, 0, 16);
			ctx.fillStyle = 'rgba(10,25,36,.2)';
			for (let n = 16; n < 128; n += 16) { ctx.fillRect(n, 0, 1, 128); ctx.fillRect(0, n, 128, 1); }
		}
		for (const [canvas, cursor] of cursors) {
			if (document.activeElement !== canvas) continue;
			const ctx = canvas.getContext('2d'), size = canvas === map ? tileSize : 16;
			ctx.strokeStyle = '#fff8d6'; ctx.lineWidth = 2;
			ctx.strokeRect(cursor.x * size + 1, cursor.y * size + 1, size - 2, size - 2);
		}
	}

	function status(message) {
		$('game-crystals').textContent = (total - remaining.size) + ' / ' + total;
		$('game-moves').textContent = moves;
		$('game-status').textContent = message + ' · Column ' + (player.x + 1) + ', row ' + (player.y + 1);
	}

	function restart() {
		remaining = new Set();
		for (const [y, line] of level.entries()) for (let x = 0; x < width; x++) {
			if (line[x] === 'S') player = { x, y };
			if (line[x] === '*') remaining.add(y * width + x);
		}
		total = remaining.size; moves = 0; won = false;
		if (board) status(total ? 'Find the crystals' : 'The gate is open');
		draw();
	}

	function move(direction) {
		if (won) return;
		const [dx, dy] = directions[direction];
		const x = player.x + dx, y = player.y + dy, tile = level[y]?.[x];
		if (!tile || tile === '#') { status('Wall ahead'); return; }
		if (tile === 'E' && remaining.size) { status('The gate needs every crystal'); return; }
		player = { x, y }; moves++;
		const picked = remaining.delete(y * width + x);
		won = tile === 'E';
		status(won ? 'Level complete!' : picked ? (remaining.size ? 'Crystal collected' : 'The gate is open') : 'Moved');
		draw();
	}

	if (board) {
		for (const link of document.querySelectorAll('a[href="#game-board"]')) {
			link.addEventListener('click', event => {
				if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) board.focus({ preventScroll: true });
			});
		}
		board.addEventListener('keydown', event => {
			const dir = keys[event.key] || keys[event.key.toLowerCase()];
			if (!dir || event.ctrlKey || event.altKey || event.metaKey) return;
			event.preventDefault(); move(dir);
		});
		for (const button of document.querySelectorAll('[data-move]')) button.onclick = () => move(button.dataset.move);
		$('game-restart').onclick = () => { restart(); board.focus({ preventScroll: true }); };
	}

	function setupEditor(canvas, rows, prefix, brush) {
		const cursor = { x: 0, y: 0 }, history = [];
		cursors.set(canvas, cursor);
		const undo = $(prefix + '-undo'), output = $(prefix + '-cell');
		let pointer = null, savedStroke = false, lastCell = null;
		function describe() {
			const tile = rows[cursor.y][cursor.x];
			const name = canvas === map ? tiles[tile] : ({ '.': 'Transparent', 1: 'Ink', 2: 'Mint', 3: 'Ivory', 4: 'Amber' })[tile];
			output.textContent = 'Column ' + (cursor.x + 1) + ', row ' + (cursor.y + 1) + ' · ' + name;
		}
		function changed() {
			if (canvas === map) restart(); else draw();
			describe();
			document.dispatchEvent(new Event('game-data-change'));
		}
		function paint(x, y, fill) {
			const current = rows[y][x];
			if (current === fill) return false;
			if (canvas === map && (current === 'S' || current === 'E')) {
				output.textContent = 'Place the ' + tiles[current].toLowerCase() + ' on another tile to move it.';
				return false;
			}
			if (!savedStroke) {
				history.push(rows.slice());
				if (history.length > 40) history.shift();
				savedStroke = true; undo.disabled = false;
			}
			if (canvas === map && (fill === 'S' || fill === 'E')) {
				const previous = rows.findIndex(line => line.includes(fill));
				rows[previous] = rows[previous].replace(fill, '.');
			}
			rows[y] = rows[y].slice(0, x) + fill + rows[y].slice(x + 1);
			return true;
		}
		function atPointer(event) {
			const rect = canvas.getBoundingClientRect();
			const x = Math.floor((event.clientX - rect.left) * rows[0].length / rect.width);
			const y = Math.floor((event.clientY - rect.top) * rows.length / rect.height);
			if (x < 0 || x >= rows[0].length || y < 0 || y >= rows.length) { lastCell = null; return; }
			if (lastCell?.x === x && lastCell.y === y) return;
			cursor.x = x; cursor.y = y;
			describe();
			const fill = brush();
			// Fill gaps between pointer events in a fast stroke. A start or exit moves straight to the destination.
			const from = lastCell && fill !== 'S' && fill !== 'E' ? lastCell : cursor;
			const dx = x - from.x, dy = y - from.y;
			const steps = Math.max(1, Math.abs(dx), Math.abs(dy));
			let edited = false;
			for (let step = 1; step <= steps; step++) {
				const col = from.x + Math.round(dx * step / steps), row = from.y + Math.round(dy * step / steps);
				if (paint(col, row, fill)) edited = true;
			}
			lastCell = { x, y };
			if (edited) changed(); else draw();
		}
		canvas.addEventListener('pointerdown', event => {
			if (event.button !== 0 || pointer !== null) return;
			pointer = event.pointerId; savedStroke = false; lastCell = null;
			canvas.setPointerCapture(pointer); canvas.focus({ preventScroll: true }); atPointer(event);
		});
		canvas.addEventListener('pointermove', event => { if (event.pointerId === pointer) atPointer(event); });
		canvas.addEventListener('pointerup', event => { if (event.pointerId === pointer) atPointer(event); });
		canvas.addEventListener('lostpointercapture', () => { pointer = null; });
		canvas.addEventListener('focus', () => { draw(); describe(); });
		canvas.addEventListener('blur', draw);
		canvas.addEventListener('keydown', event => {
			if (event.ctrlKey || event.altKey || event.metaKey) return;
			if (event.key === ' ' || event.key === 'Enter') {
				event.preventDefault();
				savedStroke = false;
				if (paint(cursor.x, cursor.y, brush())) changed();
				return;
			}
			if (!event.key.startsWith('Arrow') || !keys[event.key]) return;
			event.preventDefault();
			const [dx, dy] = directions[keys[event.key]];
			cursor.x = Math.max(0, Math.min(rows[0].length - 1, cursor.x + dx));
			cursor.y = Math.max(0, Math.min(rows.length - 1, cursor.y + dy));
			draw(); describe();
		});
		undo.onclick = () => {
			if (!history.length) return;
			rows.splice(0, rows.length, ...history.pop());
			undo.disabled = !history.length; changed();
		};
		describe();
	}
	if (map) setupEditor(map, level, 'level', () => $('level-brush').value);
	if (pixels) setupEditor(pixels, sprite, 'sprite', () => document.querySelector('[name="pixel-color"]:checked').value);

	function download(blob, name) {
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob); link.download = name; link.click();
		setTimeout(() => URL.revokeObjectURL(link.href), 1000);
	}
	for (const button of document.querySelectorAll('[data-download-game]')) button.onclick = () => {
		const source = 'const gameData = ' + JSON.stringify(gameData, null, 2) + ';\n';
		download(new Blob([source], { type: 'text/javascript' }), 'game-data.js');
	};
	if (pixels) $('sprite-png').onclick = () => {
		const image = document.createElement('canvas');
		image.width = image.height = 8;
		paintSprite(image.getContext('2d'), 0, 0, 1);
		image.toBlob(blob => { if (blob) download(blob, 'player.png'); }, 'image/png');
	};
	restart();
})();

/* end susi source */
});
