"use strict";

// Capture a single frame. The browser owns the source picker and the stream ends before publishing is offered.
async function captureBrowserTab(signal) {
	const stream = await navigator.mediaDevices.getDisplayMedia({
		video: { displaySurface: "browser" }, audio: false, selfBrowserSurface: "exclude", monitorTypeSurfaces: "exclude"
	});
	const video = document.createElement("video");
	const track = stream.getVideoTracks()[0];
	const stop = () => stream.getTracks().forEach(item => item.stop());
	try {
		signal.throwIfAborted();
		if (track?.getSettings().displaySurface !== "browser") throw new Error("Choose a browser tab in the picker.");
		video.muted = true; video.playsInline = true; video.srcObject = stream;
		await new Promise((resolve, reject) => {
			const finish = error => {
				clearTimeout(timer); signal.removeEventListener("abort", abort); track.removeEventListener("ended", ended);
				video.onloadeddata = null;
				if (error) reject(error); else resolve();
			};
			const abort = () => finish(signal.reason);
			const ended = () => finish(new Error("The tab stopped sharing."));
			const timer = setTimeout(() => finish(new Error("No frame arrived from the selected tab.")), 10000);
			signal.addEventListener("abort", abort, { once: true }); track.addEventListener("ended", ended, { once: true });
			video.onloadeddata = () => finish();
			video.play().catch(finish);
		});
		signal.throwIfAborted();
		if (!video.videoWidth || !video.videoHeight) throw new Error("The selected tab has no image yet.");
		const canvas = document.createElement("canvas");
		let scale = Math.min(1, 1440 / video.videoWidth, 1080 / video.videoHeight);
		while (true) {
			canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
			canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
			canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
			const url = canvas.toDataURL("image/jpeg", 0.82);
			if (url.length <= 350000) return url;
			scale *= 0.75;
		}
	} finally { stop(); video.srcObject = null; }
}
