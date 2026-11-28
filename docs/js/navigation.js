"use strict";

const pageSelect = document.getElementById("site-page-select");
const pageChooser = document.getElementById("site-page-chooser");
const siteNav = document.getElementById("site-nav");
const pageLinks = [...siteNav.querySelectorAll("li > a")];
const groups = [];
let openGroup;

function markCurrentPage() {
	const current = pageLinks.find(link => "#" + link.parentElement.id === location.hash);
	for (const link of pageLinks) {
		if (link === current) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
	for (const { item, submenu } of groups) {
		item.toggleAttribute("data-current-page", submenu.contains(current ?? null));
	}
	pageSelect.value = current?.href || "";
}

function updateFrame(picker) {
	if (parent === window) return;
	const bounds = (picker || openGroup?.submenu)?.getBoundingClientRect();
	const bottom = picker ? bounds.top + picker.scrollHeight + 2 * picker.clientTop - picker.scrollTop : bounds?.bottom;
	const extraHeight = bottom ? Math.min(480, Math.max(0, Math.ceil(bottom - siteNav.getBoundingClientRect().bottom))) : 0;
	// Local-file pages have an opaque origin. The parent verifies the message comes from its navigation frame.
	parent.postMessage({ type: "susi.navigation.layout", extraHeight, left: bounds?.left ?? 0, right: bounds?.right ?? 0 },
		window.origin === "null" ? "*" : window.origin);
}

function showGroup(group) {
	if (openGroup === group) return;
	const previous = openGroup;
	openGroup = group;
	if (previous) {
		previous.submenu.hidden = true;
		previous.trigger.setAttribute("aria-expanded", "false");
	}
	if (group) {
		group.submenu.hidden = false;
		group.trigger.setAttribute("aria-expanded", "true");
	}
	updateFrame();
}

pageSelect.add(new Option("Go to page", ""));
for (const item of siteNav.querySelectorAll(":scope > ul > li")) {
	const trigger = item.querySelector(":scope > button");
	if (!trigger) {
		const link = item.querySelector("a");
		pageSelect.add(new Option(link.textContent, link.href));
		continue;
	}

	const submenu = document.getElementById(trigger.getAttribute("aria-controls"));
	const group = { item, trigger, submenu };
	groups.push(group);
	const options = document.createElement("optgroup");
	options.label = trigger.textContent;
	for (const link of submenu.querySelectorAll("a")) {
		options.append(new Option(link.textContent, link.href));
	}
	pageSelect.append(options);

	item.addEventListener("pointerenter", event => {
		if (event.pointerType === "mouse") showGroup(group);
	});
	item.addEventListener("pointerleave", event => {
		if (event.pointerType === "mouse" && openGroup === group && !item.contains(document.activeElement)) showGroup();
	});
	trigger.addEventListener("click", () => showGroup(openGroup === group ? undefined : group));
	item.addEventListener("focusout", event => {
		if (openGroup === group && !item.contains(event.relatedTarget)) showGroup();
	});
}
document.addEventListener("pointerdown", event => {
	if (openGroup && !openGroup.item.contains(event.target)) showGroup();
});
document.addEventListener("keydown", event => {
	if (event.key !== "Escape" || !openGroup) return;
	event.preventDefault();
	const { trigger } = openGroup;
	showGroup();
	trigger.focus();
});
window.addEventListener("blur", () => showGroup());
document.addEventListener("toggle", event => {
	if (event.target.matches(".select-picker")) updateFrame(event.newState === "open" ? event.target : null);
}, true);
window.addEventListener("resize", () => {
	if (!openGroup) return;
	if (!openGroup.trigger.getClientRects().length) showGroup();
	else updateFrame();
});

pageChooser.addEventListener("submit", event => {
	event.preventDefault();
	if (pageSelect.value) (window.parent === window ? window : window.parent).location.href = pageSelect.value;
});
pageChooser.hidden = false;
siteNav.dataset.chooserReady = "";
markCurrentPage();
window.addEventListener("hashchange", markCurrentPage);
