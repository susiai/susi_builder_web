"use strict";

class ConsoleChat {
  #client;
  #markdown;

  constructor(client, markdown) {
    this.#client = client;
    this.#markdown = markdown;
  }

  async suggest(config, instruction, { cwd, signal, onStatus }) {
    const directory = `The current Bash working directory in the virtual file system is ${JSON.stringify(cwd)}. ` +
      "Resolve relative paths in the user's request and in suggested commands from this directory. " +
      "Absolute paths start at the virtual file system root (/).";
    const formatting = "Always put code and shell commands in Markdown code blocks fenced with triple backticks, " +
      "including single-line commands. Put the opening and closing fences on their own lines. " +
      "For Bash commands omit the shell prompt. The last code block will be inserted into the Bash input line for the user to review.";
    const { options } = this.#client.selectModel(config);
    const { message } = await this.#client.completeChat({
      ...options, signal, onStatus,
      messages: [
        { role: "system", content: [config.systemprompt, directory, formatting].filter(Boolean).join("\n\n") },
        { role: "user", content: instruction }
      ]
    });
    const text = message.content;
    if (!text?.trim()) return;
    const env = {};
    const tokens = this.#markdown.parse(text.endsWith("\n") ? text : text + "\n", env);
    const lastBlock = tokens.findLast(token => {
      if (token.type !== "fence" || !token.markup.startsWith("`")) return false;
      // Markdown also accepts an unclosed fence. Only a complete block has both delimiter lines in its source range.
      const contentLines = token.content.split("\n").length - 1;
      return token.map[1] - token.map[0] === contentLines + 2;
    });
    return {
      html: this.#markdown.renderer.render(tokens, this.#markdown.options, env),
      command: lastBlock?.content.replace(/\n$/, "")
    };
  }
}

function mountConsoleChat({ terminal, output, getWorkingDirectory, insertDraft }) {
  const form = document.getElementById("console-chat");
  const toggle = document.getElementById("console-chat-toggle");
  const prompt = document.getElementById("console-chat-prompt");
  const submit = form.querySelector('[type="submit"]');
  const close = form.querySelector('[type="button"]');
  const status = form.querySelector('[role="status"]');
  const result = document.getElementById("console-chat-result");
  const resultOutput = result.querySelector(".prompt-chat-output");
  const inserted = document.getElementById("console-chat-inserted");
  let chat;
  let ready = false;
  let request;

  function update() {
    toggle.disabled = !ready || Boolean(request);
    prompt.disabled = toggle.disabled;
    submit.disabled = prompt.disabled || !prompt.value.trim();
    close.textContent = request ? "Cancel" : "×";
    close.setAttribute("aria-label", request ? "Cancel request" : "Close console chat");
    form.setAttribute("aria-busy", String(Boolean(request)));
    output.inert = Boolean(request);
  }

  function setStatus(text, error = false) {
    status.textContent = text;
    status.toggleAttribute("data-error", error);
  }

  function setOpen(open) {
    form.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      setStatus("Enter to send · Shift+Enter for a new line");
      prompt.focus();
    } else terminal.focus();
  }

  function cancel() {
    request?.abort();
    request = undefined;
    update();
  }

  function setReady(value) {
    ready = value;
    if (!ready && request) cancel();
    else update();
  }

  toggle.addEventListener("click", () => setOpen(form.hidden));
  close.addEventListener("click", () => {
    if (request) {
      cancel();
      setStatus("Request canceled.");
      prompt.focus();
    } else setOpen(false);
  });
  prompt.addEventListener("input", update);
  form.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close.click();
    } else if (event.target === prompt && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!submit.disabled && !event.repeat) form.requestSubmit();
    }
  });
  document.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "i" || result.open) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || toggle.disabled) return;
    if (!form.hidden && !form.contains(document.activeElement)) prompt.focus();
    else setOpen(form.hidden);
  }, true);
  result.addEventListener("close", () => {
    if (inserted.hidden && !form.hidden && ready) prompt.focus();
    else terminal.focus();
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const instruction = prompt.value.trim();
    if (!ready || request || form.hidden || !instruction) return;
    const cwd = getWorkingDirectory();
    const controller = request = new AbortController();
    const { signal } = controller;
    update();
    close.focus();
    setStatus("Thinking…");
    try {
      const config = await readLLMConfig();
      signal.throwIfAborted();
      chat ??= new ConsoleChat(llmClient.create({ readApiKey: readLLMApiKey }), window.markdownit({ html: false }).disable("image"));
      const reply = await chat.suggest(config, instruction, {
        cwd, signal,
        onStatus: text => { if (!signal.aborted) setStatus(text); }
      });
      signal.throwIfAborted();
      if (reply) {
        resultOutput.innerHTML = reply.html;
        inserted.hidden = !reply.command;
        if (reply.command) insertDraft(reply.command);
        result.showModal();
      }
      prompt.value = "";
      setStatus("Enter to send · Shift+Enter for a new line");
    } catch (error) {
      if (!signal.aborted) setStatus(error.message || "Unable to get a reply.", true);
    } finally {
      if (request === controller) {
        request = undefined;
        update();
        if (!result.open) prompt.focus();
      }
    }
  });
  return { setReady };
}
