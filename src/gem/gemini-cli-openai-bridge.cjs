const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const VERSION = "0.1.0";
const ROOT = path.resolve(__dirname, "..", "..");
const REAL_HOME = os.homedir();
const APPDATA_DIR =
  process.env.APPDATA || path.join(REAL_HOME, "AppData", "Roaming");
const SOURCE_GEMINI_DIR = path.join(REAL_HOME, ".gemini");
const BRIDGE_ENV_PATH = path.join(ROOT, "bridge.env");
const OPENAI_BRIDGE_HOME = path.join(ROOT, "st-bridge-home");
const OPENAI_BRIDGE_GEMINI_DIR = path.join(OPENAI_BRIDGE_HOME, ".gemini");
const OPENAI_BRIDGE_WORKSPACE = path.join(ROOT, "st-bridge-workspace");
const OPENAI_BRIDGE_STATE_DIR = path.join(ROOT, "st-bridge-state");
const OPENAI_BRIDGE_LOG_PATH = path.join(
  OPENAI_BRIDGE_STATE_DIR,
  "openai-bridge.log"
);
const GEMINI_BUNDLE_PATH = path.join(
  APPDATA_DIR,
  "npm",
  "node_modules",
  "@google",
  "gemini-cli",
  "bundle",
  "gemini.js"
);

// We keep the bridge model list explicit so SillyTavern can show a predictable
// picker instead of relying on "whatever the backend happens to accept today".
const OFFICIAL_MODEL_ALIASES = ["auto", "pro", "flash", "flash-lite"];
const OFFICIAL_CONCRETE_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview"
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

loadEnvFile(path.join(SOURCE_GEMINI_DIR, ".env"), false);
loadEnvFile(BRIDGE_ENV_PATH, true);

const DEFAULT_MODEL =
  process.env.OPENAI_BRIDGE_DEFAULT_MODEL ||
  process.env.BRIDGE_GEMINI_MODEL_QUALITY ||
  process.env.BRIDGE_GEMINI_MODEL ||
  "gemini-3.1-pro-preview";
const HEALTHCHECK_MODEL =
  process.env.OPENAI_BRIDGE_HEALTHCHECK_MODEL ||
  process.env.BRIDGE_GEMINI_MODEL_FAST ||
  "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.OPENAI_BRIDGE_TIMEOUT_MS || process.env.BRIDGE_GEMINI_TIMEOUT_MS || "300000", 10) ||
    300000
);
const STREAM_UPDATE_MS = Math.max(
  250,
  Number.parseInt(process.env.OPENAI_BRIDGE_STREAM_UPDATE_MS || "700", 10) || 700
);
const MAX_REQUEST_BYTES = Math.max(
  1024 * 64,
  Number.parseInt(process.env.OPENAI_BRIDGE_MAX_REQUEST_BYTES || "4194304", 10) ||
    4194304
);
const HOST = process.env.OPENAI_BRIDGE_HOST || "127.0.0.1";
const PORT = Math.max(
  1,
  Number.parseInt(process.env.OPENAI_BRIDGE_PORT || "4141", 10) || 4141
);
const API_KEY = process.env.OPENAI_BRIDGE_API_KEY || "";
// Some mobile frontends ask the user for either an API root or a full "/v1"
// base URL, then append their own OpenAI path internally. Accepting the doubled
// shape keeps those clients from failing model discovery over a harmless config
// mismatch.
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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  process.stderr.write(`[openai-bridge] ${stamped}\n`);
}

function ensureBridgeHome() {
  ensureDir(OPENAI_BRIDGE_GEMINI_DIR);
  ensureDir(OPENAI_BRIDGE_WORKSPACE);
  ensureDir(OPENAI_BRIDGE_STATE_DIR);

  // We isolate SillyTavern traffic from Telegram traffic on purpose so the two
  // clients can evolve independently and not accidentally share a weird session
  // state or persona file.
  const requiredCopy = ["oauth_creds.json"];
  const optionalCopy = ["google_accounts.json", "installation_id", "state.json"];

  for (const name of [...requiredCopy, ...optionalCopy]) {
    const source = path.join(SOURCE_GEMINI_DIR, name);
    const target = path.join(OPENAI_BRIDGE_GEMINI_DIR, name);
    if (!fs.existsSync(source)) {
      if (requiredCopy.includes(name) && !process.env.GEMINI_API_KEY) {
        throw new Error(
          `Missing ${source}. Run Gemini CLI locally first or provide GEMINI_API_KEY.`
        );
      }
      continue;
    }
    fs.copyFileSync(source, target);
  }

  // We keep this bridge stateless and tool-light on purpose. SillyTavern is the
  // conversation UI here, so the bridge only needs a trusted local workspace and
  // a clean Gemini CLI profile, not the Telegram memory/menu customizations.
  const settings = {
    security: {
      auth: {
        selectedType: process.env.GEMINI_API_KEY ? "gemini-api-key" : "oauth-personal"
      }
    },
    general: {
      sessionRetention: {
        enabled: false,
        maxAge: "30d"
      }
    },
    ui: {
      autoThemeSwitching: false,
      showModelInfoInChat: false
    },
    output: {
      format: "json"
    },
    mcpServers: {}
  };

  writeJson(path.join(OPENAI_BRIDGE_GEMINI_DIR, "settings.json"), settings);
  writeJson(path.join(OPENAI_BRIDGE_GEMINI_DIR, "trustedFolders.json"), {
    [OPENAI_BRIDGE_WORKSPACE]: "TRUST_FOLDER"
  });
  writeJson(path.join(OPENAI_BRIDGE_GEMINI_DIR, "projects.json"), {
    projects: {
      [OPENAI_BRIDGE_WORKSPACE.toLowerCase()]: "sillytavern-openai-bridge"
    }
  });
}

function getRawGeminiText(parsed, stdout, stderr) {
  if (parsed && typeof parsed.response === "string" && parsed.response.trim()) {
    return parsed.response.trim();
  }
  if (stdout.trim()) {
    return stdout.trim();
  }
  if (stderr.trim()) {
    return stderr.trim();
  }
  return "";
}

function looksLikeMetaAnalysisHeading(line) {
  const normalized = String(line || "").trim();
  if (!normalized) return false;
  return /^\*\*(Analyzing|Assessing|Understanding|Reviewing|Parsing|Considering|Thinking|Interpreting|Evaluating|Responding)\b/i.test(
    normalized
  );
}

function looksLikeMetaAnalysisParagraph(paragraph) {
  const normalized = String(paragraph || "").trim();
  if (!normalized) return false;
  return (
    /^(The user|This response|This reply|I'?m currently|I am currently|I should|This suggests|This indicates|This means|The message|The user responded)/i.test(
      normalized
    ) ||
    looksLikeMetaAnalysisHeading(normalized.split("\n", 1)[0] || "")
  );
}

function sanitizeAssistantReply(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  // Gemini CLI sometimes leaks analysis scaffolding before the actual user-facing
  // answer. We strip that here because SillyTavern expects the completion body,
  // not the bridge's internal debugging text.
  const paragraphs = normalized
    .split(/\n\s*\n/g)
    .map((item) => item.trim())
    .filter(Boolean);

  if (paragraphs.length >= 2 && looksLikeMetaAnalysisParagraph(paragraphs[0])) {
    return paragraphs.slice(1).join("\n\n").trim();
  }

  const lines = normalized.split("\n");
  if (lines.length >= 3 && looksLikeMetaAnalysisHeading(lines[0])) {
    let index = 1;
    while (index < lines.length && !lines[index].trim()) {
      index += 1;
    }
    while (index < lines.length && lines[index].trim()) {
      index += 1;
    }
    const cleaned = lines.slice(index).join("\n").trim();
    if (cleaned) {
      return cleaned;
    }
  }

  return normalized;
}

function splitNativeThinkingAndReply(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return {
      rawText: "",
      replyText: ""
    };
  }

  const thoughtMarkerRegex = /\[Thought:\s*true\]/gi;
  const markerMatches = Array.from(normalized.matchAll(thoughtMarkerRegex));
  if (markerMatches.length >= 2) {
    const lastMatch = markerMatches[markerMatches.length - 1];
    const lastMarkerIndex = lastMatch.index ?? 0;
    const lastMarkerLength = lastMatch[0].length;
    const replyText = normalized.slice(lastMarkerIndex + lastMarkerLength).trim();
    return {
      rawText: normalized,
      replyText: replyText || sanitizeAssistantReply(normalized)
    };
  }

  if (markerMatches.length === 1) {
    const match = markerMatches[0];
    const markerIndex = match.index ?? 0;
    const markerLength = match[0].length;
    const replyOnlyText = normalized.slice(markerIndex + markerLength).trim();
    return {
      rawText: normalized,
      replyText: replyOnlyText || sanitizeAssistantReply(normalized)
    };
  }

  return {
    rawText: normalized,
    replyText: sanitizeAssistantReply(normalized)
  };
}

function extractGeminiTextParts(parsed, stdout, stderr) {
  return splitNativeThinkingAndReply(getRawGeminiText(parsed, stdout, stderr));
}

function extractTextFromStructuredContent(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractTextFromStructuredContent(item)).join("");
  }
  if (typeof value !== "object") {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.parts)) {
    return value.parts.map((item) => extractTextFromStructuredContent(item)).join("");
  }
  if (Array.isArray(value.content)) {
    return value.content.map((item) => extractTextFromStructuredContent(item)).join("");
  }
  return "";
}

function extractAssistantStreamText(event) {
  if (!event || event.type !== "message") {
    return "";
  }
  if (event.role && event.role !== "assistant") {
    return "";
  }

  const directText = extractTextFromStructuredContent(event.content);
  if (directText) {
    return directText;
  }

  const messageText = extractTextFromStructuredContent(event.message);
  if (messageText) {
    return messageText;
  }

  if (typeof event.text === "string") {
    return event.text;
  }

  return "";
}

function mergeGeminiStreamText(currentText, nextText, isDelta) {
  const incoming = String(nextText || "");
  if (!incoming) {
    return currentText;
  }
  if (!currentText) {
    return incoming;
  }
  if (isDelta) {
    return currentText + incoming;
  }
  if (incoming.startsWith(currentText)) {
    return incoming;
  }
  if (currentText.endsWith(incoming)) {
    return currentText;
  }
  return currentText + incoming;
}

function extractStreamingReplyPreview(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  const thoughtMarkerRegex = /\[Thought:\s*true\]/gi;
  const markerMatches = Array.from(normalized.matchAll(thoughtMarkerRegex));
  if (markerMatches.length >= 2) {
    const lastMatch = markerMatches[markerMatches.length - 1];
    const lastMarkerIndex = lastMatch.index ?? 0;
    const lastMarkerLength = lastMatch[0].length;
    return normalized.slice(lastMarkerIndex + lastMarkerLength).trim();
  }

  if (markerMatches.length === 1) {
    const match = markerMatches[0];
    const markerIndex = match.index ?? 0;
    const markerLength = match[0].length;
    if (markerIndex === 0) {
      return "";
    }
    return normalized.slice(markerIndex + markerLength).trim();
  }

  const firstParagraph = normalized.split(/\n\s*\n/, 1)[0] || "";
  const firstLine = normalized.split("\n", 1)[0] || "";
  if (
    looksLikeMetaAnalysisHeading(firstLine) ||
    looksLikeMetaAnalysisParagraph(firstParagraph)
  ) {
    return "";
  }

  return sanitizeAssistantReply(normalized);
}

function callGemini(prompt, modelId) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      USERPROFILE: OPENAI_BRIDGE_HOME,
      HOME: OPENAI_BRIDGE_HOME,
      GEMINI_CLI_TRUSTED_FOLDERS_PATH: path.join(
        OPENAI_BRIDGE_GEMINI_DIR,
        "trustedFolders.json"
      )
    };

    const args = [
      GEMINI_BUNDLE_PATH,
      "-m",
      modelId,
      "--approval-mode",
      "plan",
      // Gemini CLI headless mode expects a prompt flag even when we stream the
      // real prompt through stdin. A single space is safer than an empty string
      // here because Windows shells and some launchers may collapse empty args.
      "--prompt",
      " ",
      "-o",
      "json"
    ];

    const child = spawn(process.execPath, args, {
      cwd: OPENAI_BRIDGE_WORKSPACE,
      env: childEnv,
      windowsHide: true
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
          `Gemini timed out after ${Math.round(GEMINI_TIMEOUT_MS / 1000)} seconds.`
        )
      );
    }, GEMINI_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(prompt, "utf8");
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

      const stdoutText = stdout.trim();
      let parsed = null;
      if (stdoutText) {
        try {
          parsed = JSON.parse(stdoutText);
        } catch {
          parsed = null;
        }
      }

      if (code !== 0) {
        const details = stderr.trim() || stdoutText || `exit code ${code}`;
        reject(new Error(details));
        return;
      }

      const textParts = extractGeminiTextParts(parsed, stdout, stderr);
      resolve({
        text: textParts.replyText || textParts.rawText || "No response returned."
      });
    });
  });
}

function callGeminiStream(prompt, modelId, onPreview) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      USERPROFILE: OPENAI_BRIDGE_HOME,
      HOME: OPENAI_BRIDGE_HOME,
      GEMINI_CLI_TRUSTED_FOLDERS_PATH: path.join(
        OPENAI_BRIDGE_GEMINI_DIR,
        "trustedFolders.json"
      )
    };

    const args = [
      GEMINI_BUNDLE_PATH,
      "-m",
      modelId,
      "--approval-mode",
      "plan",
      // Same reasoning as the non-stream path above: keep the CLI in headless
      // mode with a shell-safe placeholder, then send the actual prompt on stdin.
      "--prompt",
      " ",
      "-o",
      "stream-json"
    ];

    const child = spawn(process.execPath, args, {
      cwd: OPENAI_BRIDGE_WORKSPACE,
      env: childEnv,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let settled = false;
    let parsedResult = null;
    let rawAssistantText = "";
    let lastPreviewText = "";
    let lastPreviewAt = 0;

    const emitPreview = (force) => {
      if (typeof onPreview !== "function") {
        return;
      }
      const previewText = extractStreamingReplyPreview(rawAssistantText);
      if (!force) {
        if (!previewText || previewText === lastPreviewText) {
          return;
        }
        if (Date.now() - lastPreviewAt < STREAM_UPDATE_MS) {
          return;
        }
      }
      if (!previewText && !force) {
        return;
      }
      lastPreviewText = previewText;
      lastPreviewAt = Date.now();
      Promise.resolve(onPreview(previewText)).catch(() => {});
    };

    const handleStreamEvent = (event) => {
      if (!event || typeof event !== "object") {
        return;
      }

      if (event.type === "result") {
        parsedResult = event;
      }

      const nextText = extractAssistantStreamText(event);
      if (!nextText) {
        return;
      }

      rawAssistantText = mergeGeminiStreamText(
        rawAssistantText,
        nextText,
        event.delta === true
      );
      emitPreview(false);
    };

    const flushLineBuffer = () => {
      const trailing = lineBuffer.trim();
      if (!trailing) {
        return;
      }
      lineBuffer = "";
      try {
        handleStreamEvent(JSON.parse(trailing));
      } catch {}
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          `Gemini timed out after ${Math.round(GEMINI_TIMEOUT_MS / 1000)} seconds.`
        )
      );
    }, GEMINI_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      lineBuffer += chunk;
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const rawLine = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (rawLine) {
          try {
            handleStreamEvent(JSON.parse(rawLine));
          } catch {}
        }
        newlineIndex = lineBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(prompt, "utf8");
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
      flushLineBuffer();

      if (code !== 0) {
        const details = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(details));
        return;
      }

      emitPreview(true);
      const textParts = rawAssistantText
        ? splitNativeThinkingAndReply(rawAssistantText)
        : extractGeminiTextParts(parsedResult, stdout, stderr);
      resolve({
        text: textParts.replyText || textParts.rawText || "No response returned."
      });
    });
  });
}

function contentPartToText(part) {
  if (part == null) {
    return "";
  }
  if (typeof part === "string") {
    return part;
  }
  if (Array.isArray(part)) {
    return part.map((item) => contentPartToText(item)).join("");
  }
  if (typeof part !== "object") {
    return "";
  }
  if (typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }
  if (part.type === "image_url") {
    return "[Image omitted by bridge]";
  }
  return "";
}

function messageContentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => contentPartToText(item)).join("");
  }
  return contentPartToText(content);
}

function buildPromptFromMessages(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const systemMessages = [];
  const conversationLines = [];

  for (const message of safeMessages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = String(message.role || "user").trim().toLowerCase();
    const namePrefix = message.name ? ` (${message.name})` : "";
    const content = messageContentToText(message.content).trim();
    if (!content) {
      continue;
    }

    // We keep system messages grouped at the top because SillyTavern often emits
    // multiple instruction blocks. Grouping them helps Gemini CLI see the full
    // policy before the role-by-role transcript starts.
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
  const requestedHeaders = String(
    req?.headers?.["access-control-request-headers"] || ""
  ).trim();
  const requestedMethod = String(
    req?.headers?.["access-control-request-method"] || ""
  ).trim();
  const requestedPrivateNetwork = String(
    req?.headers?.["access-control-request-private-network"] || ""
  )
    .trim()
    .toLowerCase();

  // Mobile browser wrappers and HTTPS-hosted tools may preflight local-LAN
  // requests before they even attempt /models or /chat/completions. Echoing the
  // browser's requested headers/methods keeps the bridge permissive enough for
  // local experimentation without forcing every client to hardcode the same list.
  const headers = {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers":
      requestedHeaders || "Authorization, Content-Type",
    "Access-Control-Allow-Methods": requestedMethod || "GET,POST,OPTIONS",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
    Vary:
      "Origin, Access-Control-Request-Headers, Access-Control-Request-Method, Access-Control-Request-Private-Network"
  };

  // Chrome's Private Network Access preflight looks for this explicit opt-in
  // when a secure webpage reaches into a private IP like 192.168.x.x. Returning
  // it on every CORS response is harmless for normal clients and avoids a class
  // of mobile WebView quirks where preflight metadata is not exposed cleanly.
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
  if (!API_KEY) {
    return true;
  }
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${API_KEY}`) {
    return true;
  }
  sendOpenAiError(
    req,
    res,
    401,
    "Invalid or missing API key.",
    "authentication_error"
  );
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
      owned_by: "gemini-cli-openai-bridge",
      root: id,
      parent: null,
      // Some community OpenAI-compatible frontends still expect the legacy
      // OpenAI model permission shape. Keeping it populated makes the endpoint
      // easier to parse without changing the actual model routing behavior.
      permission: [
        {
          id: `modelperm-${crypto
            .createHash("sha1")
            .update(id)
            .digest("hex")
            .slice(0, 16)}`,
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
  if (!authenticateRequest(req, res)) {
    return;
  }

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

    // We stream deltas into one OpenAI-compatible SSE response because this is
    // the shape SillyTavern already understands. The bridge only emits the new
    // suffix each time so ST can append it without re-rendering the whole reply.
    let emittedText = "";
    try {
      const result = await callGeminiStream(prompt, model, (previewText) => {
        const next = String(previewText || "");
        if (!next || next === emittedText) {
          return;
        }
        const delta = next.startsWith(emittedText)
          ? next.slice(emittedText.length)
          : next;
        emittedText = next;
        if (!delta) {
          return;
        }
        writeSseChunk(res, {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                content: delta
              },
              finish_reason: null
            }
          ]
        });
      });

      if (result.text && result.text !== emittedText) {
        const finalDelta = result.text.startsWith(emittedText)
          ? result.text.slice(emittedText.length)
          : result.text;
        if (finalDelta) {
          writeSseChunk(res, {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {
                  content: finalDelta
                },
                finish_reason: null
              }
            ]
          });
        }
      }

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
    const result = await callGemini(prompt, model);
    sendJson(req, res, 200, buildCompletionResponse(requestId, model, result.text));
  } catch (error) {
    sendOpenAiError(req, res, 500, error.message, "server_error");
  }
}

function printHelp() {
  process.stdout.write(
    [
      "gemini-cli-openai-bridge",
      "",
      "Runs a local OpenAI-compatible server backed by Gemini CLI.",
      "",
      "Endpoints:",
      "  GET  /v1/models",
      "  POST /v1/chat/completions",
      "",
      "Optional env vars:",
      "  OPENAI_BRIDGE_HOST",
      "  OPENAI_BRIDGE_PORT",
      "  OPENAI_BRIDGE_API_KEY",
      "  OPENAI_BRIDGE_DEFAULT_MODEL",
      "  OPENAI_BRIDGE_TIMEOUT_MS",
      "  OPENAI_BRIDGE_STREAM_UPDATE_MS",
      ""
    ].join("\n")
  );
}

async function runHealthcheck() {
  ensureBridgeHome();
  // Health checks only need to prove the bridge can reach Gemini CLI end-to-end.
  // Using a faster model here avoids spending minutes validating a route that is
  // otherwise identical for SillyTavern traffic.
  const result = await callGemini("Reply with exactly OK.", HEALTHCHECK_MODEL);
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
  ensureBridgeHome();

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      sendOpenAiError(req, res, 404, "Missing request URL.", "not_found_error");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    // These connection-level logs tell us whether a phone browser is truly
    // reaching the bridge or getting blocked earlier by LAN/firewall/security
    // policy. That makes the next round of debugging much less guessy.
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
        origin: req.headers.origin || "",
        requestedMethod: req.headers["access-control-request-method"] || "",
        requestedHeaders: req.headers["access-control-request-headers"] || "",
        requestedPrivateNetwork:
          req.headers["access-control-request-private-network"] || ""
      });
      res.writeHead(204, getCorsHeaders(req));
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      sendJson(req, res, 200, {
        ok: true,
        service: "gemini-cli-openai-bridge",
        version: VERSION,
        host: HOST,
        port: PORT,
        defaultModel: DEFAULT_MODEL
      });
      return;
    }

    // Different OpenAI-compatible clients disagree on whether the configured
    // base URL already includes "/v1". We accept both route shapes so tools like
    // SillyTavern and lighter community wrappers can connect without custom hacks.
    if (req.method === "GET" && MODEL_ROUTE_PATHS.has(url.pathname)) {
      if (!authenticateRequest(req, res)) {
        return;
      }
      log("models request", {
        path: url.pathname,
        origin: req.headers.origin || "",
        userAgent: req.headers["user-agent"] || ""
      });
      sendJson(req, res, 200, buildModelsPayload());
      return;
    }

    if (req.method === "GET" && ENGINE_ROUTE_PATHS.has(url.pathname)) {
      if (!authenticateRequest(req, res)) {
        return;
      }
      log("engines request", {
        path: url.pathname,
        origin: req.headers.origin || "",
        userAgent: req.headers["user-agent"] || ""
      });
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
