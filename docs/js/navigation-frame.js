"use strict";

(() => {
	const frame = document.getElementById("site-menu");
	window.addEventListener("message", event => {
		if (event.source !== frame.contentWindow || event.origin !== window.origin ||
			event.data?.type !== "susi.navigation.layout") return;
		const { extraHeight, left, right } = event.data;
		if (!Number.isFinite(extraHeight) || extraHeight < 0 || extraHeight > 480) return;
		if (extraHeight && (!Number.isFinite(left) || !Number.isFinite(right) ||
			left < 0 || left >= right || right > frame.clientWidth)) return;
		frame.style.setProperty("--submenu-height", extraHeight + "px");
		frame.style.setProperty("--submenu-left", left + "px");
		frame.style.setProperty("--submenu-right", right + "px");
		frame.toggleAttribute("data-submenu-open", extraHeight > 0);
	});
})();
