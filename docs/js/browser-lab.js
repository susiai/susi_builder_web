"use strict";

(() => {
	document.getElementById("lab-form").addEventListener("submit", event => {
		event.preventDefault();
		const input = document.getElementById("lab-task");
		const item = document.createElement("li");
		const button = document.createElement("button"); button.type = "button"; button.dataset.susiAction = ""; button.textContent = "Mark complete";
		item.append(document.createTextNode(input.value + (document.getElementById("lab-priority").value === "high" ? " · High priority" : "")), button);
		document.getElementById("lab-items").append(item); input.value = "";
		update();
	});
	document.getElementById("lab-items").addEventListener("click", event => {
		if (!event.target.matches("button")) return;
		event.target.closest("li").dataset.complete = ""; event.target.remove(); update();
	});
	function update() {
		document.getElementById("lab-status").textContent = `${document.querySelectorAll('#lab-items li:not([data-complete])').length} open item(s).`;
	}
})();
