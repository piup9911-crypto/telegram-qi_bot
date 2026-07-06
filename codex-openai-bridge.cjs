const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const VERSION = "0.1.0";
const ROOT = __dirname;
const REAL_HOME = os.homedir();
const APPDATA_DIR =
  process.env.APPDATA || path.join(REAL_HOME, "AppData", "Roaming");

const BRIDGE_ENV_PATH = path.join(ROOT, "codex-bridge.env");
const OPENAI_BRIDGE_STATE_DIR = path.join(ROOT, "codex-st-bridge-state");
const OPENAI_BRIDGE_WORKSPACE = path.join(ROOT, "codex-st-bridge-workspace");
const OPENAI_BRIDGE_LOG_PATH = path.join(
  OPENAI_BRIDGE_STATE_DIR,
  "openai-bridge.log"
);
const CODEX_CMD = process.env.CODEX_CMD || path.join(APPDATA_DIR, "npm", "codex.cmd");
const DEFAULT_NODE_CMD = process.execPath || "node";

const OFFICIAL_MODEL_ALIASES = ["auto", "pro", "flash", "flash-lite"];
const OFFICIAL_CONCRETE_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-3.1-pro-preview",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20241022",
  "gpt-4o"
];

function loadEnvFile(filePath, overrideExisting) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }
    if (!overrideExisting && Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }
    process.env[key] = value;
  }
}

loadEnvFile(BRIDGE_ENV_PATH, true);

const DEFAULT_MODEL =
  process.env.OPENAI_BRIDGE_DEFAULT_MODEL ||
  process.env.CODEX_MODEL ||
  "claude-3-7-sonnet-20250219";
const HEALTHCHECK_MODEL =
  process.env.OPENAI_BRIDGE_HEALTHCHECK_MODEL ||
  "gemini-2.5-flash";
const CODEX_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.OPENAI_BRIDGE_TIMEOUT_MS || "300000", 10) ||
    300000
);
const MAX_REQUEST_BYTES = Math.max(
  1024 * 64,
  Number.parseInt(process.env.OPENAI_BRIDGE_MAX_REQUEST_BYTES || "4194304", 10) ||
    4194304
);
const HOST = process.env.OPENAI_BRIDGE_HOST || "127.0.0.1";
const PORT = Math.max(
  1,
  Number.parseInt(process.env.OPENAI_BRIDGE_PORT || "4142", 10) || 4142
);
const API_KEY = process.env.OPENAI_BRIDGE_API_KEY || "";

const MODEL_ROUTE_PATHS = new Set(["/v1/models", "/models", "/v1/v1/models"]);
const ENGINE_ROUTE_PATHS = new Set(["/v1/engines", "/engines", "/v1/v1/engines"]);
const CHAT_COMPLETION_ROUTE_PATHS = new Set([
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/v1/chat/completions"
]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function log(...args) {
  ensureDir(OPENAI_BRIDGE_STATE_DIR);
  const line = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
  const stamped = `[${new Date().toISOString()}] ${line}`;
  fs.appendFileSync(OPENAI_BRIDGE_LOG_PATH, `${stamped}\n`, "utf8");
  process.stderr.write(`[codex-openai-bridge] ${stamped}\n`);
}

function resolveCodexLaunch(args) {
  const isCmdShim = /\.cmd$/i.test(CODEX_CMD);
  if (!isCmdShim) {
    return { command: CODEX_CMD, args };
  }

  const codexJsPath = path.join(
    path.dirname(CODEX_CMD),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js"
  );

  if (fs.existsSync(codexJsPath)) {
    return { command: DEFAULT_NODE_CMD, args: [codexJsPath, ...args] };
  }

  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", CODEX_CMD, ...args]
  };
}

function callCodexStream(prompt, modelId, onChunk) {
  return new Promise((resolve, reject) => {
    ensureDir(OPENAI_BRIDGE_WORKSPACE);

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--cd", OPENAI_BRIDGE_WORKSPACE,
      "--sandbox", "none",
      "--model", modelId,
      "--color", "never",
      prompt
    ];

    const { command: spawnCommand, args: spawnArgs } = resolveCodexLaunch(args);

    const child = spawn(spawnCommand, spawnArgs, {
      cwd: OPENAI_BRIDGE_WORKSPACE,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          `Codex timed out after ${Math.round(CODEX_TIMEOUT_MS / 1000)} seconds.`
        )
      );
    }, CODEX_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (typeof onChunk === "function") {
        try {
          onChunk(chunk);
        } catch (err) {
          // Ignore
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const details = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(details));
        return;
      }

      resolve({ text: stdout.trim() || "No response returned." });
    });
  });
}

function callCodex(prompt, modelId) {
  return callCodexStream(prompt, modelId, null);
}

function contentPartToText(part) {
  if (part == null) return "";
  if (typeof part === "string") return part;
  if (Array.isArray(part)) return part.map(contentPartToText).join("");
  if (typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (part.type === "text" && typeof part.text === "string") return part.text;
  if (part.type === "image_url") return "[Image omitted by bridge]";
  return "";
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentPartToText).join("");
  return contentPartToText(content);
}

function buildPromptFromMessages(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const systemMessages = [];
  const conversationLines = [];

  for (const message of safeMessages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user").trim().toLowerCase();
    const namePrefix = message.name ? ` (${message.name})` : "";
    const content = messageContentToText(message.content).trim();
    if (!content) continue;

    if (role === "system") {
      systemMessages.push(content);
      continue;
    }

    const label =
      role === "assistant"
        ? `Assistant${namePrefix}`
        : role === "tool"
          ? `Tool${namePrefix}`
          : `User${namePrefix}`;
    conversationLines.push(`${label}: ${content}`);
  }

  return [
    "You are answering a SillyTavern conversation through an OpenAI-compatible bridge.",
    "Follow the system instructions and continue the assistant side of the dialogue naturally.",
    "Return only the assistant reply body. Do not restate these instructions.",
    "",
    systemMessages.length > 0 ? "System instructions:" : null,
    systemMessages.length > 0 ? systemMessages.join("\n\n") : null,
    systemMessages.length > 0 ? "" : null,
    "Conversation so far:",
    conversationLines.join("\n\n"),
    "",
    "Assistant:"
  ]
    .filter((item) => item != null && item !== "")
    .join("\n");
}

function buildRequestId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

function getCorsHeaders(req) {
  const origin = String(req?.headers?.origin || "").trim();
  const requestedHeaders = String(req?.headers?.["access-control-request-headers"] || "").trim();
  const requestedMethod = String(req?.headers?.["access-control-request-method"] || "").trim();
  const requestedPrivateNetwork = String(req?.headers?.["access-control-request-private-network"] || "").trim().toLowerCase();

  const headers = {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": requestedHeaders || "Authorization, Content-Type",
    "Access-Control-Allow-Methods": requestedMethod || "GET,POST,OPTIONS",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Headers, Access-Control-Request-Method, Access-Control-Request-Private-Network"
  };

  headers["Access-Control-Allow-Private-Network"] = "true";
  return headers;
}

function sendJson(req, res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...getCorsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendSseHeaders(req, res) {
  res.writeHead(200, {
    ...getCorsHeaders(req),
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
}

function sendOpenAiError(req, res, statusCode, message, type) {
  sendJson(req, res, statusCode, {
    error: {
      message,
      type: type || "invalid_request_error"
    }
  });
}

function authenticateRequest(req, res) {
  if (!API_KEY) return true;
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${API_KEY}`) return true;
  sendOpenAiError(req, res, 401, "Invalid or missing API key.", "authentication_error");
  return false;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        reject(new Error("Request body exceeded the configured size limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });

    req.on("error", reject);
  });
}

function buildModelsPayload() {
  const ids = [DEFAULT_MODEL, ...OFFICIAL_MODEL_ALIASES, ...OFFICIAL_CONCRETE_MODELS]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
  const created = Math.floor(Date.now() / 1000);

  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "codex-openai-bridge",
      root: id,
      parent: null,
      permission: [
        {
          id: `modelperm-${crypto.createHash("sha1").update(id).digest("hex").slice(0, 16)}`,
          object: "model_permission",
          created,
          allow_create_engine: false,
          allow_sampling: true,
          allow_logprobs: false,
          allow_search_indices: false,
          allow_view: true,
          allow_fine_tuning: false,
          organization: "*",
          group: null,
          is_blocking: false
        }
      ]
    }))
  };
}

function buildEnginesPayload() {
  const models = buildModelsPayload();
  return {
    object: "list",
    data: models.data.map((model) => ({
      id: model.id,
      object: "engine",
      created: model.created,
      owned_by: model.owned_by,
      ready: true
    }))
  };
}

function resolveModel(requestedModel) {
  const normalized = String(requestedModel || "").trim();
  return normalized || DEFAULT_MODEL;
}

function buildCompletionResponse(id, model, content) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }
    ]
  };
}

function writeSseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleChatCompletions(req, res) {
  if (!authenticateRequest(req, res)) return;

  let body;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    sendOpenAiError(req, res, 400, error.message);
    return;
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages) {
    sendOpenAiError(req, res, 400, "`messages` must be an array.");
    return;
  }

  const model = resolveModel(body.model);
  const prompt = buildPromptFromMessages(messages);
  const requestId = buildRequestId("chatcmpl");

  log("chat completion request", {
    model,
    stream: Boolean(body.stream),
    messageCount: messages.length
  });

  if (body.stream) {
    sendSseHeaders(req, res);

    try {
      await callCodexStream(prompt, model, (chunk) => {
        writeSseChunk(res, {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                content: chunk
              },
              finish_reason: null
            }
          ]
        });
      });

      writeSseChunk(res, {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop"
          }
        ]
      });
      res.end("data: [DONE]\n\n");
    } catch (error) {
      writeSseChunk(res, {
        error: {
          message: error.message,
          type: "server_error"
        }
      });
      res.end("data: [DONE]\n\n");
    }
    return;
  }

  try {
    const result = await callCodex(prompt, model);
    sendJson(req, res, 200, buildCompletionResponse(requestId, model, result.text));
  } catch (error) {
    sendOpenAiError(req, res, 500, error.message, "server_error");
  }
}

function printHelp() {
  process.stdout.write(
    [
      "codex-openai-bridge",
      "",
      "Runs a local OpenAI-compatible server backed by Codex CLI.",
      "",
      "Endpoints:",
      "  GET  /v1/models",
      "  POST /v1/chat/completions",
      "",
      "Optional env vars:",
      "  OPENAI_BRIDGE_HOST",
      "  OPENAI_BRIDGE_PORT (default 4142)",
      "  OPENAI_BRIDGE_API_KEY",
      "  OPENAI_BRIDGE_DEFAULT_MODEL",
      "  OPENAI_BRIDGE_TIMEOUT_MS",
      ""
    ].join("\n")
  );
}

async function runHealthcheck() {
  const result = await callCodex("Reply with exactly OK.", HEALTHCHECK_MODEL);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        model: HEALTHCHECK_MODEL,
        response: result.text
      },
      null,
      2
    )}\n`
  );
}

async function startServer() {
  ensureDir(OPENAI_BRIDGE_WORKSPACE);

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      sendOpenAiError(req, res, 404, "Missing request URL.", "not_found_error");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    res.on("close", () => {
      log("http response closed", {
        method: req.method,
        path: url.pathname,
        statusCode: res.statusCode,
        writableEnded: res.writableEnded
      });
    });

    if (req.method === "OPTIONS") {
      log("cors preflight", {
        path: url.pathname,
        origin: req.headers.origin || ""
      });
      res.writeHead(204, getCorsHeaders(req));
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      sendJson(req, res, 200, {
        ok: true,
        service: "codex-openai-bridge",
        version: VERSION,
        host: HOST,
        port: PORT,
        defaultModel: DEFAULT_MODEL
      });
      return;
    }

    if (req.method === "GET" && MODEL_ROUTE_PATHS.has(url.pathname)) {
      if (!authenticateRequest(req, res)) return;
      log("models request", { path: url.pathname });
      sendJson(req, res, 200, buildModelsPayload());
      return;
    }

    if (req.method === "GET" && ENGINE_ROUTE_PATHS.has(url.pathname)) {
      if (!authenticateRequest(req, res)) return;
      log("engines request", { path: url.pathname });
      sendJson(req, res, 200, buildEnginesPayload());
      return;
    }

    if (req.method === "POST" && CHAT_COMPLETION_ROUTE_PATHS.has(url.pathname)) {
      await handleChatCompletions(req, res);
      return;
    }

    sendOpenAiError(
      req,
      res,
      404,
      `Unknown route: ${req.method} ${url.pathname}`,
      "not_found_error"
    );
  });

  server.listen(PORT, HOST, () => {
    log("openai bridge started", {
      host: HOST,
      port: PORT,
      defaultModel: DEFAULT_MODEL,
      apiKeyEnabled: Boolean(API_KEY)
    });
  });
}

async function main() {
  const command = process.argv[2] || "";
  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--healthcheck") {
    await runHealthcheck();
    return;
  }
  await startServer();
}

main().catch((error) => {
  log("bridge crashed", error && error.stack ? error.stack : String(error));
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
