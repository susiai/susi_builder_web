"use strict";

(() => {
	if (!("showPopover" in HTMLElement.prototype)) return;

	function positionPicker(select, list, popup) {
		const box = select.getBoundingClientRect();
		popup.style.left = box.left + "px";
		popup.style.width = box.width + "px";
		const fitAll = popup !== list;
		popup.style.setProperty("--picker-row-height", fitAll ? "1.6em" : box.height + "px");
		popup.style.height = "1px";
		if (fitAll) {
			// Some native listboxes reserve a scrollbar even when every row fits.
			const gutter = list.offsetWidth - list.clientWidth;
			list.style.width = "calc(100% + " + gutter + "px)";
		}
		// A wrapped label sets the height for every option in this menu.
		const options = Array.from(list.options);
		const rowHeight = options.reduce((height, option) => Math.max(height, option.getBoundingClientRect().height), 0);
		popup.style.setProperty("--picker-row-height", rowHeight + "px");
		// Measure the real rows, including group headings, before fitting the list to the viewport.
		const current = list.selectedOptions[0];
		const row = current?.getClientRects().length ? current : options.find(item => item.getClientRects().length);
		if (row) {
			const rect = row.getBoundingClientRect();
			const before = rect.top - popup.getBoundingClientRect().top + list.scrollTop;
			// scrollHeight is rounded to an integer even when the rows have fractional heights.
			const height = list.scrollHeight + 2 * popup.clientTop + (fitAll ? 1 : 0);
			const after = height - before - rect.height;
			const above = Math.max(0, Math.min(before, box.top));
			const below = Math.max(0, Math.min(after, innerHeight - box.top - rect.height));
			if (fitAll && height <= innerHeight) {
				const centeredTop = box.top + (box.height - rect.height) / 2 - before;
				popup.style.height = height + "px";
				popup.style.top = Math.max(0, Math.min(centeredTop, innerHeight - height)) + "px";
				list.scrollTop = 0;
			} else {
				popup.style.top = (box.top - above) + "px";
				popup.style.height = (above + rect.height + below) + "px";
				list.scrollTop = before - above;
			}
		} else {
			popup.style.top = box.top + "px";
			popup.style.height = box.height + "px";
		}
		return box;
	}

	function openPicker(select) {
		const style = getComputedStyle(select);
		const list = document.createElement("select");
		list.size = 2; // Keep native listbox navigation, type-ahead and option groups.
		const popup = select.hasAttribute("data-fit-options") ? document.createElement("div") : list;
		if (popup !== list) popup.append(list);
		popup.className = "select-picker";
		popup.popover = "auto";
		popup.dir = style.direction;
		if (select.hasAttribute("aria-labelledby")) list.setAttribute("aria-labelledby", select.getAttribute("aria-labelledby"));
		else list.setAttribute("aria-label", select.getAttribute("aria-label") || select.labels?.[0]?.textContent.trim() || "Options");
		for (const child of select.children) {
			if (child.matches("option, optgroup, hr")) list.append(child.cloneNode(true));
		}
		list.selectedIndex = select.selectedIndex;
		popup.style.font = style.font;
		popup.style.setProperty("--picker-inset", style.paddingInlineStart);
		(select.closest("dialog, [popover]") || document.body).append(popup);
		select.focus({ preventScroll: true });
		popup.showPopover();
		list.focus({ preventScroll: true });
		const expanded = select.getAttribute("aria-expanded");
		select.setAttribute("aria-expanded", "true");

		let box = positionPicker(select, list, popup);

		const listeners = new AbortController();
		const { signal } = listeners;
		function close() {
			if (popup.matches(":popover-open")) popup.hidePopover();
		}
		function accept() {
			const picked = list.selectedOptions[0];
			const changed = select.isConnected && select.matches(":enabled") && picked?.matches(":enabled") && select.selectedIndex !== picked.index;
			close();
			select.focus({ preventScroll: true });
			if (!changed) return;
			select.selectedIndex = picked.index;
			select.dispatchEvent(new Event("input", { bubbles: true }));
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}

		// Only committed edits on the form control reach its listeners.
		for (const type of ["input", "change"]) list.addEventListener(type, event => event.stopPropagation());
		list.addEventListener("click", event => {
			if (event.target.matches("option:enabled")) accept();
		});
		list.addEventListener("keydown", event => {
			event.stopPropagation();
			if (event.key === "Tab") accept();
			else if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				accept();
			} else if (event.key === "Escape") {
				event.preventDefault();
				close();
				select.focus({ preventScroll: true });
			}
		});
		// Dismiss a snapshot if the source options or the position of the field change.
		const changes = new MutationObserver(close);
		changes.observe(select, { attributes: true, childList: true, characterData: true, subtree: true });
		window.addEventListener("blur", close, { signal });
		window.addEventListener("resize", () => {
			if (select.getClientRects().length) box = positionPicker(select, list, popup);
			else close();
		}, { signal });
		document.addEventListener("scroll", event => {
			if (popup.contains(event.target)) return;
			const bounds = select.getBoundingClientRect();
			if (bounds.top !== box.top || bounds.left !== box.left) close();
		}, { capture: true, signal });
		popup.addEventListener("beforetoggle", event => {
			if (event.newState !== "closed") return;
			changes.disconnect();
			listeners.abort();
			if (expanded === null) select.removeAttribute("aria-expanded");
			else select.setAttribute("aria-expanded", expanded);
		});
		popup.addEventListener("toggle", event => {
			if (event.newState === "closed") popup.remove();
		});
	}

	function isDropdown(target) {
		return target instanceof HTMLSelectElement && !target.multiple && target.size <= 1 &&
			target.matches(":enabled") && matchMedia("(pointer: fine) and (forced-colors: none)").matches;
	}
	document.addEventListener("mousedown", event => {
		if (event.defaultPrevented || event.button !== 0 || event.sourceCapabilities?.firesTouchEvents || !isDropdown(event.target)) return;
		event.preventDefault();
		openPicker(event.target);
	});
	document.addEventListener("keydown", event => {
		if (event.defaultPrevented || !isDropdown(event.target) || ![" ", "Enter", "ArrowDown", "ArrowUp", "F4"].includes(event.key) ||
			event.ctrlKey || event.metaKey || event.shiftKey) return;
		event.preventDefault();
		openPicker(event.target);
	});
})();
