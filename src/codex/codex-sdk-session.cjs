const fs = require("fs");
const os = require("os");
const path = require("path");

const SDK_STATE_DIR = path.join(__dirname, "codex-bridge-state", "sdk");
const SDK_CONTEXTS_PATH = path.join(SDK_STATE_DIR, "contexts.json");

let CodexCtor = null;
const registry = new Map();
const metadata = loadMetadata();

async function loadCodexSdk() {
  if (CodexCtor) return CodexCtor;
  const sdk = await import("@openai/codex-sdk");
  CodexCtor = sdk.Codex;
  return CodexCtor;
}

class CodexSessionService {
  constructor(config) {
    this.config = config;
    this.codex = null;
    this.thread = null;
    this.abortController = null;
    this.currentThreadId = null;
    this.currentWorkspace = config.workspace;
    this.currentModel = config.model;
    this.currentReasoningEffort = config.reasoningEffort;
    this.currentSandboxMode = config.sandboxMode || "workspace-write";
    this.currentApprovalPolicy = config.approvalPolicy || "never";
    this.lastCommandOutput = new Map();
    this.sessionTokens = { input: 0, cached: 0, output: 0 };
  }

  static async create(config, options = {}) {
    const service = new CodexSessionService(config);
    service.currentWorkspace = path.resolve(options.workspace || config.workspace);
    service.currentModel = options.model || config.model;
    service.currentReasoningEffort = options.reasoningEffort || config.reasoningEffort;
    service.currentSandboxMode = options.sandboxMode || config.sandboxMode || "workspace-write";
    service.currentApprovalPolicy = options.approvalPolicy || config.approvalPolicy || "never";
    service.resetCodexClient();

    if (options.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId);
      return service;
    }

    if (!options.deferThreadStart) {
      await service.newThread(service.currentWorkspace, service.currentModel);
    }

    return service;
  }

  getInfo() {
    return {
      threadId: this.currentThreadId || (this.thread && this.thread.id) || null,
      workspace: this.currentWorkspace,
      model: this.currentModel,
      reasoningEffort: this.currentReasoningEffort,
      sandboxMode: this.currentSandboxMode,
      approvalPolicy: this.currentApprovalPolicy,
      sessionTokens: { ...this.sessionTokens }
    };
  }

  isProcessing() {
    return this.abortController !== null;
  }

  hasActiveThread() {
    return this.thread !== null;
  }

  async ensureThread() {
    if (!this.thread) {
      await this.newThread(this.currentWorkspace, this.currentModel);
    }
  }

  async prompt(input, callbacks = {}, options = {}) {
    await this.ensureThread();
    if (this.abortController) {
      throw new Error("A Codex turn is already in progress");
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.lastCommandOutput = new Map();
    let lastAgentText = "";

    try {
      const { events } = await this.thread.runStreamed(buildSdkInput(input), {
        signal: controller.signal
      });

      for await (const event of events) {
        if (event.type === "thread.started") {
          this.currentThreadId = event.thread_id;
          callbacks.onThreadStart && callbacks.onThreadStart(event.thread_id);
          continue;
        }

        if (event.type === "item.started" || event.type === "item.updated") {
          const nextText = this.handleStartedOrUpdated(event, callbacks, lastAgentText);
          if (nextText !== null) lastAgentText = nextText;
          continue;
        }

        if (event.type === "item.completed") {
          const nextText = this.handleCompleted(event.item, callbacks, lastAgentText);
          if (nextText !== null) lastAgentText = nextText;
          continue;
        }

        if (event.type === "turn.completed") {
          const usage = event.usage || {};
          this.sessionTokens.input += usage.input_tokens || 0;
          this.sessionTokens.cached += usage.cached_input_tokens || 0;
          this.sessionTokens.output += usage.output_tokens || 0;
          callbacks.onTurnComplete &&
            callbacks.onTurnComplete({
              inputTokens: usage.input_tokens || 0,
              cachedInputTokens: usage.cached_input_tokens || 0,
              outputTokens: usage.output_tokens || 0
            });
          callbacks.onAgentEnd && callbacks.onAgentEnd();
          continue;
        }

        if (event.type === "turn.failed") {
          throw new Error(event.error && event.error.message ? event.error.message : "Codex turn failed.");
        }

        if (event.type === "error") {
          if (typeof event.message === "string" && /^Reconnecting\.\.\./i.test(event.message)) {
            callbacks.onReconnect && callbacks.onReconnect(event.message);
            continue;
          }
          throw new Error(event.message || "Codex SDK error.");
        }
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  handleStartedOrUpdated(event, callbacks, lastAgentText) {
    const item = event.item;
    if (!item) return null;

    if (item.type === "agent_message") {
      const next = item.text || "";
      const delta = computeTextDelta(lastAgentText, next);
      if (delta) callbacks.onTextDelta && callbacks.onTextDelta(delta);
      return next;
    }

    if (item.type === "command_execution") {
      if (event.type === "item.started") {
        this.lastCommandOutput.set(item.id, item.aggregated_output || "");
        callbacks.onToolStart && callbacks.onToolStart(item.command || "shell command", item.id, "shell");
        return null;
      }

      const previous = this.lastCommandOutput.get(item.id) || "";
      const next = item.aggregated_output || "";
      const delta = computeTextDelta(previous, next);
      this.lastCommandOutput.set(item.id, next);
      if (delta) callbacks.onToolUpdate && callbacks.onToolUpdate(item.id, delta, "shell");
      return null;
    }

    if (item.type === "web_search" && event.type === "item.started") {
      const label = truncate(item.query || "web search", 80);
      callbacks.onToolStart && callbacks.onToolStart(label, item.id, "web_search");
      callbacks.onToolUpdate && callbacks.onToolUpdate(item.id, item.query || "", "web_search");
      return null;
    }

    if (item.type === "todo_list") {
      callbacks.onTodoUpdate && callbacks.onTodoUpdate(item.items || []);
      return null;
    }

    return null;
  }

  handleCompleted(item, callbacks, lastAgentText) {
    if (!item) return null;

    if (item.type === "agent_message") {
      const next = item.text || "";
      const delta = computeTextDelta(lastAgentText, next);
      if (delta) callbacks.onTextDelta && callbacks.onTextDelta(delta);
      return next;
    }

    if (item.type === "command_execution") {
      const previous = this.lastCommandOutput.get(item.id) || "";
      const next = item.aggregated_output || "";
      const delta = computeTextDelta(previous, next);
      if (delta) callbacks.onToolUpdate && callbacks.onToolUpdate(item.id, delta, "shell");
      callbacks.onToolEnd && callbacks.onToolEnd(item.id, item.status === "failed", "shell");
      return null;
    }

    if (item.type === "file_change") {
      const summary = (item.changes || [])
        .map((change) => `${change.kind} ${change.path}`)
        .join("\n");
      callbacks.onToolStart && callbacks.onToolStart("file_change", item.id, "file_change");
      if (summary) callbacks.onToolUpdate && callbacks.onToolUpdate(item.id, summary, "file_change");
      callbacks.onToolEnd && callbacks.onToolEnd(item.id, item.status === "failed", "file_change");
      return null;
    }

    if (item.type === "mcp_tool_call") {
      const label = `mcp:${item.server}/${item.tool}`;
      callbacks.onToolStart && callbacks.onToolStart(label, item.id, label);
      if (item.error && item.error.message) {
        callbacks.onToolUpdate && callbacks.onToolUpdate(item.id, item.error.message, label);
      }
      callbacks.onToolEnd && callbacks.onToolEnd(item.id, item.status === "failed", label);
      return null;
    }

    if (item.type === "web_search") {
      callbacks.onToolEnd && callbacks.onToolEnd(item.id, false, "web_search");
      return null;
    }

    if (item.type === "error") {
      callbacks.onToolStart && callbacks.onToolStart("error", item.id, "error");
      callbacks.onToolUpdate && callbacks.onToolUpdate(item.id, item.message || "", "error");
      callbacks.onToolEnd && callbacks.onToolEnd(item.id, true, "error");
      return null;
    }

    if (item.type === "todo_list") {
      callbacks.onTodoUpdate && callbacks.onTodoUpdate(item.items || []);
      return null;
    }

    return null;
  }

  async abort() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  async newThread(workspace, model) {
    this.ensureIdle("start a new thread");
    this.currentWorkspace = path.resolve(workspace || this.currentWorkspace);
    if (model) this.currentModel = model;
    this.thread = this.getCodex().startThread(this.buildThreadOptions());
    this.currentThreadId = this.thread.id || null;
    return this.getInfo();
  }

  async resumeThread(threadId) {
    this.ensureIdle("resume a thread");
    this.thread = this.getCodex().resumeThread(threadId, this.buildThreadOptions());
    this.currentThreadId = threadId;
    return this.getInfo();
  }

  handback() {
    const info = this.getInfo();
    this.abort();
    this.thread = null;
    this.currentThreadId = null;
    return info;
  }

  dispose() {
    this.abort();
    this.thread = null;
    this.currentThreadId = null;
  }

  setModel(model) {
    this.currentModel = model;
  }

  setReasoningEffort(reasoningEffort) {
    this.currentReasoningEffort = reasoningEffort;
  }

  buildThreadOptions() {
    const options = {
      model: this.currentModel,
      sandboxMode: this.currentSandboxMode,
      workingDirectory: this.currentWorkspace,
      approvalPolicy: this.currentApprovalPolicy,
      skipGitRepoCheck: true
    };
    if (this.currentReasoningEffort) {
      options.modelReasoningEffort = this.currentReasoningEffort;
    }
    return options;
  }

  ensureIdle(action) {
    if (this.abortController) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  getCodex() {
    if (!this.codex) this.resetCodexClient();
    return this.codex;
  }

  resetCodexClient() {
    const Codex = CodexCtor;
    if (!Codex) {
      throw new Error("Codex SDK is not loaded yet.");
    }
    this.codex = new Codex({
      apiKey: this.config.apiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY,
      codexPathOverride: resolveCodexExecutable(this.config.codexPathOverride || process.env.CODEX_BRIDGE_COMMAND),
      config: {
        approval_policy: this.currentApprovalPolicy
      },
      env: buildCodexEnv(this.config.apiKey)
    });
  }
}

async function callCodexSdk(prompt, state, attachments = [], options = {}) {
  await loadCodexSdk();

  const model = options.model || state.model;
  const workingDirectory = path.resolve(options.execWorkDir || process.cwd());
  const contextKey = getContextKey({
    chatId: options.chatId || "default",
    workspace: workingDirectory,
    sandboxMode: options.sandboxMode || "workspace-write",
    approvalPolicy: options.approvalPolicy || "never"
  });
  const persisted = metadata.get(contextKey);
  const persistThreads = shouldPersistThreads();

  let session = registry.get(contextKey);
  if (!persistThreads) {
    session = null;
  }
  if (!session) {
    session = await CodexSessionService.create(
      {
        apiKey: options.apiKey,
        codexPathOverride: options.codexPathOverride,
        workspace: workingDirectory,
        model,
        reasoningEffort: options.reasoningEffort,
        sandboxMode: options.sandboxMode || "workspace-write",
        approvalPolicy: options.approvalPolicy || "never"
      },
      {
        workspace: persisted && persisted.workspace ? persisted.workspace : workingDirectory,
        model: (persisted && persisted.model) || model,
        reasoningEffort: (persisted && persisted.reasoningEffort) || options.reasoningEffort,
        sandboxMode: (persisted && persisted.sandboxMode) || options.sandboxMode,
        approvalPolicy: (persisted && persisted.approvalPolicy) || options.approvalPolicy,
        resumeThreadId: persistThreads && persisted && persisted.threadId ? persisted.threadId : undefined,
        deferThreadStart: false
      }
    );
    if (persistThreads) {
      registry.set(contextKey, session);
    }
  } else {
    session.setModel(model);
    session.setReasoningEffort(options.reasoningEffort);
  }

  const taskKey = options.taskKey ? String(options.taskKey) : "";
  if (taskKey && options.activeTasks) {
    options.activeTasks.set(taskKey, session);
  }

  let finalText = "";
  let settled = false;
  const timeoutMs = options.timeoutMs || 300000;
  const timeout = setTimeout(() => {
    if (settled) return;
    session.abort();
  }, timeoutMs);

  emitProgress(options, {
    type: "started",
    engine: "sdk",
    threadId: session.getInfo().threadId,
    execWorkDir: workingDirectory
  });

  try {
    await session.prompt(buildPromptInput(prompt, attachments), {
      onThreadStart: (threadId) => {
        emitProgress(options, { type: "thread_started", threadId });
      },
      onTextDelta: (delta) => {
        finalText += delta;
      },
      onToolStart: (toolName, toolId, kind) => {
        emitProgress(options, {
          type: "tool_start",
          toolName: kind || toolName || "tool",
          toolId,
          summary: toolName || ""
        });
      },
      onToolUpdate: (toolId, output, kind) => {
        const summary = summarizeToolOutput(output);
        if (!summary) return;
        emitProgress(options, {
          type: "tool_update",
          toolName: kind || "tool",
          toolId,
          summary
        });
      },
      onToolEnd: (toolId, isError, kind) => {
        emitProgress(options, {
          type: "tool_end",
          toolName: kind || "tool",
          toolId,
          isError
        });
      },
      onTodoUpdate: (items) => {
        emitProgress(options, {
          type: "todo_update",
          items
        });
      },
      onReconnect: (summary) => {
        emitProgress(options, {
          type: "reconnecting",
          summary
        });
      },
      onTurnComplete: (usage) => {
        emitProgress(options, {
          type: "usage",
          usage
        });
      },
      onAgentEnd: () => {}
    });

    settled = true;
    if (persistThreads) {
      persistContext(contextKey, session);
    }
    emitProgress(options, {
      type: "finished",
      engine: "sdk",
      threadId: session.getInfo().threadId,
      replyLength: finalText.length
    });
    return finalText || "这轮已经结束了，但 SDK 没有返回可发送的最终文本。";
  } catch (error) {
    if (session.abortController === null && !settled && String(error && error.message).includes("aborted")) {
      throw new Error(`Codex timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (taskKey && options.activeTasks && options.activeTasks.get(taskKey) === session) {
      options.activeTasks.delete(taskKey);
    }
    if (!persistThreads) {
      session.dispose();
    }
  }
}

function shouldPersistThreads() {
  return String(process.env.CODEX_BRIDGE_SDK_PERSIST_THREADS || "false").trim().toLowerCase() === "true";
}

function buildPromptInput(prompt, attachments) {
  const imagePaths = attachments
    .filter((attachment) => attachment && attachment.isImage && attachment.filePath)
    .map((attachment) => attachment.filePath);
  if (imagePaths.length === 0) return prompt;
  return {
    text: prompt,
    imagePaths
  };
}

function buildSdkInput(input) {
  if (typeof input === "string") return input;
  const parts = [];
  const textParts = [];
  if (input.stagedFileInstructions) textParts.push(input.stagedFileInstructions);
  if (input.text) textParts.push(input.text);
  if (textParts.length > 0) {
    parts.push({ type: "text", text: textParts.join("\n\n") });
  }
  for (const imagePath of input.imagePaths || []) {
    parts.push({ type: "local_image", path: imagePath });
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function getContextKey(options) {
  return [
    options.chatId || "default",
    path.resolve(options.workspace || os.homedir()),
    options.sandboxMode || "workspace-write",
    options.approvalPolicy || "never"
  ].join("|");
}

function persistContext(contextKey, session) {
  const info = session.getInfo();
  metadata.set(contextKey, {
    contextKey,
    threadId: info.threadId,
    workspace: info.workspace,
    model: info.model,
    reasoningEffort: info.reasoningEffort,
    sandboxMode: info.sandboxMode,
    approvalPolicy: info.approvalPolicy,
    sessionTokens: info.sessionTokens,
    updatedAt: Date.now()
  });
  saveMetadata();
}

function loadMetadata() {
  try {
    const raw = fs.readFileSync(SDK_CONTEXTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.filter((entry) => entry && entry.contextKey).map((entry) => [entry.contextKey, entry]));
  } catch {
    return new Map();
  }
}

function saveMetadata() {
  try {
    fs.mkdirSync(SDK_STATE_DIR, { recursive: true });
    fs.writeFileSync(SDK_CONTEXTS_PATH, `${JSON.stringify([...metadata.values()], null, 2)}\n`, "utf8");
  } catch {}
}

function resetCodexSdkSessions() {
  for (const session of registry.values()) {
    session.dispose();
  }
  registry.clear();
  metadata.clear();
  saveMetadata();
}

function buildCodexEnv(apiKey) {
  const env = { ...process.env };
  if (apiKey) env.CODEX_API_KEY = apiKey;
  return env;
}

function resolveCodexExecutable(configuredPath) {
  const rawPath = String(configuredPath || "").trim();
  if (rawPath && !/\.cmd$/i.test(rawPath)) return rawPath;

  const candidates = [
    path.join(
      process.env.APPDATA || "",
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe"
    ),
    path.join(
      __dirname,
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe"
    )
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  return rawPath || undefined;
}

function emitProgress(options, event) {
  if (!options || typeof options.onProgress !== "function") return;
  try {
    Promise.resolve(options.onProgress(event)).catch(() => {});
  } catch {}
}

function computeTextDelta(previousText, nextText) {
  const previous = String(previousText || "");
  const next = String(nextText || "");
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function summarizeToolOutput(text, maxLength = 700) {
  const lines = String(text || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);
  const summary = lines.join("\n").trim();
  if (!summary) return "";
  return summary.length > maxLength ? summary.slice(summary.length - maxLength).trim() : summary;
}

function truncate(text, maxLength) {
  const value = String(text || "");
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

module.exports = {
  CodexSessionService,
  callCodexSdk,
  resetCodexSdkSessions
};
