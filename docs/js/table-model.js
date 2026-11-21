"use strict";

// Formula evaluation only reads this workbook's answer index. Committed changes
// discover the currently needed questions and schedule missing answers separately.
const tableModel = (() => {
	async function ask(prompt, signal, report) {
		const config = await readLLMConfig();
		const options = llmClient.requestOptions(config);
		if (!options.model?.trim()) throw new Error("Select a chat model in Models.");
		const messages = [];
		if (config.systemprompt) messages.push({role:"system",content:config.systemprompt});
		messages.push({role:"user",content:prompt});
		signal.throwIfAborted();
		const client = llmClient.create({readApiKey:readLLMApiKey});
		report({message:options.provider === "browser" ? "Preparing the browser model…" : "Waiting for " + options.model + " to reply…"});
		const response = await client.completeChat({...options,messages,signal,
			onProgress: state => report(state.ready ? {message:"Generating a reply with " + state.label + "…"} : state),
			onStatus: message => report({message})
		});
		const answer = response.choices?.[0]?.message?.content;
		if (typeof answer !== "string") throw new Error("The model returned no text answer.");
		return answer;
	}

	class Answers {
		constructor(records, onResult, onProgress) {
			this.entries = new Map();
			this.needed = new Set();
			this.version = 0;
			this.controller = new AbortController();
			this.onResult = onResult;
			this.onProgress = onProgress;
			for (const record of records || []) {
				if (!Array.isArray(record)) continue;
				const [prompt,state,text] = record;
				if (typeof prompt === "string" && ["ready","failed"].includes(state) && typeof text === "string")
					this.entries.set(prompt,{state,text});
			}
		}
		sync(tabs, allowNew) {
			// Row/column operations can move formulas. Reindex on data changes,
			// then reuse the positions while asynchronous answers arrive.
			this.formulas = [];
			for (const tab of tabs) tab.rows.forEach((row,r) => row.forEach((v,c) => {
				if (v instanceof tableCalc.Formula && v.usesLLM) this.formulas.push({tab,r,c});
			}));
			this.refresh(tabs,allowNew);
		}
		refresh(tabs, allowNew) {
			const needed = new Set();
			const discover = tableCalc.calculator(tabs,prompt => {
				needed.add(prompt);
				if (!this.entries.has(prompt)) this.entries.set(prompt,{state:allowNew ? "queued" : "paused"});
				return this.entries.get(prompt);
			});
			for (const {tab,r,c} of this.formulas) discover(tab,r,c);
			this.needed = needed;
			this.start();
		}
		start() {
			if (this.work || this.controller.signal.aborted) return;
			if (![...this.needed].some(p => this.entries.get(p).state === "queued")) return;
			this.work = Promise.resolve().then(async () => {
				while (!this.controller.signal.aborted) {
					const prompt = [...this.needed].find(p => this.entries.get(p).state === "queued");
					if (prompt === undefined) break;
					const entry = this.entries.get(prompt);
					entry.state = "running";
					try {
						entry.text = await ask(prompt,this.controller.signal,progress => {
							if (this.controller.signal.aborted || entry.state !== "running" || !progress.message) return;
							// The browser backend also echoes download messages through onStatus, without byte counts.
							if (progress.message === entry.progress?.message && progress.total === undefined) return;
							entry.progress = progress;
							if (this.needed.has(prompt)) this.onProgress?.(progress);
						});
						entry.state = "ready";
					} catch (error) {
						if (this.controller.signal.aborted) return;
						entry.text = error.message || String(error); entry.state = "failed";
					} finally { delete entry.progress; }
					if (!this.controller.signal.aborted && this.needed.has(prompt)) {
						this.version++;
						this.onResult();
					}
				}
			}).finally(() => { this.work = null; this.start(); });
		}
		retry() {
			for (const p of this.needed) {
				const entry = this.entries.get(p);
				if (["paused","failed"].includes(entry.state)) entry.state = "queued";
			}
			this.start();
		}
		async settle() {
			while (this.work) await this.work;
		}
		records() {
			const records = [];
			for (const p of this.needed) {
				const {state,text} = this.entries.get(p);
				if (state === "ready" || state === "failed") records.push([p,state,text]);
			}
			return records;
		}
	}
	return {Answers};
})();
