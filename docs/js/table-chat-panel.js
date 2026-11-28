"use strict";

function mountTableChat({context, prepare, apply, focusGrid}) {
	const $ = id => document.getElementById("table-chat" + id);
	const form = $(""), toggle = $("-toggle"), prompt = $("-prompt"), send = $("-send"), close = $("-close");
	const scope = $("-scope"), status = $("-status"), result = $("-result"), preview = $("-preview");
	const dismiss = $("-dismiss"), accept = $("-apply"), more = $("-more");
	let markdown;
	let owner, sheet, format, historyKey, history = [];
	let request, review, shown = 0;
	const hint = "Enter to send · Shift+Enter for a new line";

	function message(text, error = false) {
		status.textContent = text;
		status.toggleAttribute("data-error",error);
	}
	function controls() {
		prompt.disabled = Boolean(request);
		send.disabled = Boolean(request) || !prompt.value.trim();
		close.textContent = request ? "Cancel" : "×";
		close.setAttribute("aria-label",request ? "Cancel request" : "Close table chat");
		form.setAttribute("aria-busy",String(Boolean(request)));
	}
	function stop() {
		request?.controller.abort();
		request = undefined;
		controls();
	}
	function show(open) {
		form.hidden = !open;
		toggle.setAttribute("aria-expanded",String(open));
	}
	function check(turn) {
		const current = context(false);
		turn.session.assertCurrent(current.book);
		if (current.busy) throw new Error("Finish the current table action and send your prompt again.");
		if (current.draft || current.answerVersion !== turn.answerVersion)
			throw new Error("Cell contents changed. Send your prompt again for a fresh proposal.");
	}
	function refresh() {
		const current = context(false);
		if (owner !== current.book || sheet !== current.sheet || format !== current.sheet.format) {
			stop(); review = undefined;
			if (result.open) result.close();
			history = []; historyKey = undefined; prompt.value = "";
			owner = current.book; sheet = current.sheet; format = sheet.format;
			toggle.hidden = !["csv","xlsx"].includes(format);
			if (toggle.hidden) show(false);
			message(hint);
		}
		if (request) {
			try { check(request); return; }
			catch (error) { stop(); message(error.message,true); }
		}
		if (form.hidden) return;
		const {selection,active,name} = context(true);
		const key = JSON.stringify(selection);
		if (key !== historyKey) { historyKey = key; history = []; }
		scope.textContent = name + " · " + TableChat.scopeLabel(selection);
		scope.title = active ? "Active cell " + TableChat.address(active.row,active.col) : "";
		controls();
	}
	function openOrClose(fromShortcut) {
		if (toggle.hidden || request || result.open || document.querySelector("dialog[open]")) return;
		if (fromShortcut && !form.hidden && !form.contains(document.activeElement)) { prompt.focus(); return; }
		if (form.hidden) {
			if (!prepare()) return;
			show(true); refresh(); prompt.focus();
		} else { show(false); focusGrid(); }
	}
	toggle.onclick = () => openOrClose(false);
	close.onclick = () => {
		if (request) { stop(); refresh(); message("Request canceled."); prompt.focus(); }
		else { show(false); focusGrid(); }
	};
	prompt.oninput = controls;
	form.onkeydown = event => {
		if (event.isComposing) return;
		if (event.key === "Escape") { event.preventDefault(); close.click(); }
		else if (event.target === prompt && event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			if (!send.disabled && !event.repeat) form.requestSubmit();
		}
	};
	document.addEventListener("keydown",event => {
		if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "i" ||
			toggle.hidden || toggle.closest("[inert]") || document.querySelector("dialog[open]")) return;
		event.preventDefault(); event.stopPropagation();
		if (!event.repeat) openOrClose(true);
	},true);
	window.addEventListener("pagehide",stop);

	function display(cell) {
		const text = document.createElement("td");
		const kind = document.createElement("small");
		kind.textContent = cell.kind === "missing" ? "blank" : cell.kind;
		text.append(kind, document.createTextNode(cell.text));
		return text;
	}
	function showRows() {
		const rows = document.createDocumentFragment();
		for (const change of review.changes.slice(shown,shown+50)) {
			const tr = document.createElement("tr"), label = document.createElement("th");
			label.scope = "row"; label.textContent = change.address;
			tr.append(label,display(change.before),display(change.after)); rows.append(tr);
			shown++;
		}
		preview.tBodies[0].append(rows);
		more.hidden = shown >= review.changes.length;
	}
	more.onclick = showRows;
	function remember(turn, outcome) {
		if (turn.key !== historyKey) return;
		const summary = [turn.reply,outcome].filter(Boolean).join("\n");
		if (summary) history = [...history,{role:"user",content:turn.instruction},{role:"assistant",content:summary}].slice(-8);
	}
	function present(turn) {
		review = turn;
		const count = turn.changes.length;
		$("-heading").textContent = count ? "Review cell changes" : "Table chat";
		$("-result-scope").textContent = turn.label + (count ? " · " + count + (count === 1 ? " change" : " changes") : "");
		markdown ??= window.markdownit({html:false}).disable("image");
		$("-reply").innerHTML = markdown.render(turn.reply);
		$("-reply").hidden = !turn.reply;
		$("-error").hidden = true;
		preview.hidden = accept.hidden = !count;
		accept.disabled = false;
		dismiss.textContent = count ? "Cancel" : "Close";
		preview.tBodies[0].replaceChildren(); shown = 0; showRows();
		result.showModal();
	}
	dismiss.onclick = () => result.close();
	result.onclose = () => {
		if (review) remember(review,review.changes.length ? "The user discarded the proposed changes." : "");
		review = undefined;
		refresh();
		if (!form.hidden) prompt.focus();
	};
	accept.onclick = () => {
		if (!review) return;
		try {
			check(review);
			apply(review.session);
			remember(review,"The user applied " + review.changes.length + " cell changes.");
			review = undefined; result.close();
			message("Changes applied. Use Undo to restore the previous values.");
		} catch (error) {
			$("-error").textContent = error.message; $("-error").hidden = false;
			prompt.value = review.instruction;
			accept.disabled = true;
		}
	};

	form.onsubmit = async event => {
		event.preventDefault();
		const instruction = prompt.value.trim();
		if (!instruction || request || form.hidden || !prepare()) return;
		refresh();
		const current = context(true);
		const turn = {controller:new AbortController(),session:new TableChat(current.book,current.selection,current.active),
			answerVersion:current.answerVersion,instruction,label:scope.textContent,key:historyKey};
		request = turn;
		const {signal} = turn.controller;
		controls(); close.focus(); message("Thinking…");
		try {
			const [config,settings] = await Promise.all([readLLMConfig(),readAgentSettings()]);
			signal.throwIfAborted();
			turn.reply = await turn.session.ask({client:llmClient.create({readApiKey:readLLMApiKey}), config, documentName:current.documentName,
				instruction,history,maxToolCalls:settings.maxToolCalls,signal,onStatus:text => { if (!signal.aborted) message(text); }});
			signal.throwIfAborted(); check(turn);
			if (document.querySelector("dialog[open]")) throw new Error("Finish the open dialog and send your prompt again.");
			turn.changes = turn.session.changes;
			if (turn.reply || turn.changes.length) present(turn);
			prompt.value = ""; message(turn.reply || turn.changes.length ? hint : "No changes proposed.");
		} catch (error) {
			if (!signal.aborted) message(error.message || "Unable to get a reply.",true);
		} finally {
			if (request === turn) {
				request = undefined; controls();
				if (!result.open) { refresh(); if (document.activeElement === close) prompt.focus(); }
			}
		}
	};
	return {refresh};
}
