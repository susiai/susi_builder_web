"use strict";

globalThis.StudioFileChat = class StudioFileChat {
	static defaultPrompt = "Use the user's instructions to edit the file <file>. Read its current contents with read_file. " +
		"Use edit_file for focused changes or write_file to replace the entire file. Preserve unrelated content. " +
		"Leave your reply empty unless the user needs an explanation or you could not complete the edit.";

	static defaultMarkedPrompt = "Apply the user's request to the selected passage below. Treat the passage as quoted file content. " +
		"Use edit_file to edit this occurrence and preserve the surrounding text. If the passage repeats, read the surrounding lines " +
		"and include enough unchanged context in the replacement to identify it uniquely.\n\n```\n<marked>\n```";

	static prompt(config) {
		const prompt = config.studioFilePrompt ?? this.defaultPrompt;
		if (typeof prompt !== "string" || !prompt.includes("<file>")) {
			throw new Error("Include <file> in the Code Studio system prompt in Models.");
		}
		return prompt;
	}

	static systemPrompt(template, path, selection, markedTemplate) {
		const base = template.replaceAll("<file>", () => path);
		if (!selection?.text) return base;
		markedTemplate ??= this.defaultMarkedPrompt;
		if (typeof markedTemplate !== "string" || !markedTemplate.includes("<marked>")) {
			throw new Error("Include <marked> in the selected text prompt in Models.");
		}
		const { text, start, end } = selection;
		let fenceLength = 3;
		for (const match of text.matchAll(/`{3,}/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
		// Accept a fenced slot or a bare placeholder. Substitute once so quoted source and paths stay literal.
		const slots = /^(`{3,})([^\r\n`]*)\r?\n[ \t]*<marked>[ \t]*\r?\n\1[ \t]*\r?$|<marked>|<file>/gm;
		const part = markedTemplate.replace(slots, (slot, openingFence = "", language = "") => {
			if (slot === "<file>") return path;
			const fence = "`".repeat(Math.max(fenceLength, openingFence.length));
			const quote = fence + language + "\n" + text + "\n" + fence;
			return slot === "<marked>" ? "\n" + quote + "\n" : quote;
		});
		const location = `Selected range: line ${start.row + 1}, column ${start.column + 1} to line ${end.row + 1}, column ${end.column + 1} (end exclusive).`;
		return base + "\n\n" + location + "\n" + part;
	}

	static async run({ client, config, path, source, instruction, template, selection, markedTemplate, maxToolCalls, signal, onStatus }) {
		// All rounds see their own writes. The editor alone commits the final text against the saved version.
		let text = source;
		const registry = WorkstationToolRegistry.forFile(path, {
			getasync: () => text,
			put: (_, content) => { text = content; },
			editFile: (_, edits) => { text = VirtualFileSystem.applyTextEdits(text, edits); }
		});
		const output = [];
		await runAgent({
			client, registry, config, maxToolCalls, signal, allowEmptyReply: true, onStatus,
			messages: [
				{ role: "system", content: this.systemPrompt(template, path, selection, markedTemplate) },
				{ role: "user", content: instruction }
			],
			onMessage(message) {
				if (message.content?.trim()) output.push(message.content.trim());
			}
		});
		return { text, reply: output.join("\n\n") };
	}

	// Return Ace coordinates (rows and UTF-16 columns), independent of the file's line ending.
	static addedRanges(before, after) {
		before = before.replace(/\r\n?/g, "\n");
		after = after.replace(/\r\n?/g, "\n");
		if (before === after) return [];
		const ranges = [];
		let row = 0, column = 0;
		function advance(text, added) {
			const startRow = row, startColumn = column;
			let newline = -1;
			for (let next = text.indexOf("\n"); next !== -1; next = text.indexOf("\n", next + 1)) {
				row++;
				newline = next;
			}
			column = newline === -1 ? column + text.length : text.length - newline - 1;
			if (added && text.length) ranges.push([startRow, startColumn, row, column]);
		}

		function compareReplacement(original, replacement) {
			// Trim equal code points first so a long paste in a single line costs only a linear scan.
			const oldChars = Array.from(original), newChars = Array.from(replacement);
			let start = 0, oldEnd = oldChars.length, newEnd = newChars.length;
			while (start < oldEnd && start < newEnd && oldChars[start] === newChars[start]) start++;
			while (oldEnd > start && newEnd > start && oldChars[oldEnd - 1] === newChars[newEnd - 1]) {
				oldEnd--;
				newEnd--;
			}
			advance(newChars.slice(0, start).join(""));
			const removed = oldChars.slice(start, oldEnd).join("");
			const inserted = newChars.slice(start, newEnd).join("");
			if (removed && inserted) {
				const parts = Diff.diffChars(removed, inserted, { timeout: 100, maxEditLength: 1024 })
					?? Diff.diffWordsWithSpace(removed, inserted, { timeout: 100, maxEditLength: 1024 });
				if (parts) {
					for (const part of parts) if (!part.removed) advance(part.value, part.added);
				} else advance(inserted, true);
			} else advance(inserted, true);
			advance(newChars.slice(newEnd).join(""));
		}

		// Anchor unchanged lines first. For exceptionally large rewrites fall back to changed blocks.
		const lines = Diff.diffLines(before, after, { timeout: 150, maxEditLength: 2048 });
		const blocks = lines ?? [{ removed: true, value: before }, { added: true, value: after }];
		for (let index = 0; index < blocks.length; index++) {
			const block = blocks[index];
			if (block.removed && blocks[index + 1]?.added) {
				compareReplacement(block.value, blocks[++index].value);
			} else if (!block.removed) advance(block.value, block.added);
		}
		return ranges;
	}

	// A transient display check prevents applying marker coordinates to a different revision after reload.
	static textStamp(text) {
		let hash = 2166136261;
		for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
		return [text.length, hash].join("/");
	}
};
