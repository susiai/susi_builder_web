"use strict";

function renderModelProgress(container, state) {
    const message = state?.message;
    container.hidden = !message;
    if (!message) return;
    const status = container.querySelector("[role=status]");
    if (status.textContent !== message) status.textContent = message;
    const progress = container.querySelector("progress");
    if (state.total > 0) {
        progress.max = state.total;
        progress.value = state.loaded;
    } else progress.removeAttribute("value");
}
