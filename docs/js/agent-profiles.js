"use strict";

(async () => {
	const form = document.getElementById("agent-profile-form");
	const choice = document.getElementById("agent-profile");
	const instructions = document.getElementById("agent-profile-instructions");
	const status = document.getElementById("agent-profile-status");
	const save = form.querySelector('button[type="submit"]');
	const checks = [...form.querySelectorAll('input[type="checkbox"]')];
	let profiles;
	for (const profile of agentProfileDefaults) choice.add(new Option(profile.name, profile.id));
	function show() {
		const profile = profiles[choice.value];
		instructions.value = profile.instructions;
		for (const check of checks) check.checked = profile.capabilities.includes(check.value);
		document.getElementById("agent-profile-help").textContent = profile.description;
	}
	choice.addEventListener("change", () => {
		show();
		pageSettings.save("agents", { selectedProfile: choice.value });
	});
	form.addEventListener("change", event => {
		const read = checks.find(check => check.value === "browser.read");
		const interact = checks.find(check => check.value === "browser.interact");
		if (event.target === read && !read.checked) interact.checked = false;
		if (interact.checked) read.checked = true;
	});
	form.addEventListener("submit", async event => {
		event.preventDefault(); save.disabled = true;
		try {
			profiles[choice.value] = await writeAgentProfile(choice.value, { instructions: instructions.value,
				capabilities: checks.filter(check => check.checked).map(check => check.value) }, profiles[choice.value]);
			status.textContent = "Profile saved. New replies use these instructions and permissions.";
			status.removeAttribute("data-error");
		} catch (error) { status.textContent = error.message || String(error); status.dataset.error = ""; }
		finally { save.disabled = false; }
	});
	try {
		profiles = await readAgentProfiles();
		const settings = await pageSettings.read("agents");
		if (Object.hasOwn(profiles, settings.selectedProfile)) choice.value = settings.selectedProfile;
		show(); form.inert = false;
	}
	catch (error) { status.textContent = error.message || String(error); status.dataset.error = ""; }
})();
