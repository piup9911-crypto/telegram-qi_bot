const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_DIR = __dirname;
const DEFAULT_AGY_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "agy",
  "bin",
  "agy.exe"
);
const AGY_PATH = process.env.AGY_PATH || DEFAULT_AGY_PATH;
const AGY_HOME = path.join(os.homedir(), ".gemini", "antigravity-cli");
const LAST_CONVERSATIONS_PATH = path.join(AGY_HOME, "cache", "last_conversations.json");
const SETTINGS_PATH = path.join(AGY_HOME, "settings.json");
const BRAIN_DIR = path.join(AGY_HOME, "brain");
const ANTIGRAVITY_APP_NODE_MODULES = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Programs",
  "Antigravity",
  "resources",
  "app",
  "node_modules"
);
const ANTIGRAVITY_STATE_DB_PATH = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Antigravity",
  "User",
  "globalStorage",
  "state.vscdb"
);
const ANTIGRAVITY_OAUTH_CLIENTS = readAntigravityOAuthClients();
const ANTIGRAVITY_USER_AGENT = "antigravity/1.23.2 windows/amd64";
let fetchProxyConfigured = false;

function readAntigravityOAuthClients() {
  const rawJson = process.env.ANTIGRAVITY_OAUTH_CLIENTS_JSON || "";
  if (rawJson.trim()) {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) throw new Error("ANTIGRAVITY_OAUTH_CLIENTS_JSON must be an array.");
    return parsed
      .map((item) => ({ id: String(item.id || "").trim(), secret: String(item.secret || "").trim() }))
      .filter((item) => item.id && item.secret);
  }

  return [
    { id: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID, secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET },
    { id: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID_2, secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET_2 }
  ]
    .map((item) => ({ id: String(item.id || "").trim(), secret: String(item.secret || "").trim() }))
    .filter((item) => item.id && item.secret);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function requireAntigravityModule(name) {
  return require(path.join(ANTIGRAVITY_APP_NODE_MODULES, name));
}

function configureFetchProxy() {
  if (fetchProxyConfigured) return;
  fetchProxyConfigured = true;

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "";
  if (!proxyUrl) return;

  try {
    const { setGlobalDispatcher, ProxyAgent } = requireAntigravityModule("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch {
    // If Antigravity's vendored undici is unavailable, fall back to Node's fetch.
    // The caller will surface a normal network error if the direct connection fails.
  }
}

function readAntigravityStateValue(key) {
  return new Promise((resolve, reject) => {
    let sqlite3;
    try {
      sqlite3 = requireAntigravityModule("@vscode/sqlite3");
    } catch (error) {
      reject(new Error(`Antigravity sqlite module is unavailable: ${error.message}`));
      return;
    }

    const db = new sqlite3.Database(ANTIGRAVITY_STATE_DB_PATH, sqlite3.OPEN_READONLY);
    db.get("SELECT value FROM ItemTable WHERE key = ?", [key], (error, row) => {
      db.close();
      if (error) {
        reject(error);
        return;
      }
      resolve(row && row.value ? row.value.toString("utf8") : "");
    });
  });
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < buffer.length; i += 1) {
    const byte = BigInt(buffer[i]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) {
      return [value, i + 1];
    }
    shift += 7n;
  }
  throw new Error("Invalid protobuf varint.");
}

function readProtoFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, offset);
    offset = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    let value;

    if (wire === 0) {
      const [nextValue, afterValue] = readVarint(buffer, offset);
      value = nextValue;
      offset = afterValue;
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(buffer, offset);
      offset = afterLength;
      value = buffer.slice(offset, offset + Number(length));
      offset += Number(length);
    } else {
      break;
    }

    fields.push({ field, wire, value });
  }
  return fields;
}

async function readAntigravityOAuthTokenInfo() {
  const encodedState = await readAntigravityStateValue("antigravityUnifiedStateSync.oauthToken");
  if (!encodedState) {
    throw new Error("Antigravity OAuth state was not found.");
  }

  // Antigravity stores OAuthTokenInfo as a protobuf payload inside a base64
  // unified-state-sync row. We only keep the tokens in memory long enough to
  // call Google's model-list endpoint; they are never logged or written out.
  const outer = Buffer.from(encodedState, "base64");
  const innerBase64 = (outer.toString("utf8").match(/[A-Za-z0-9+/=]{200,}/g) || [])[0];
  if (!innerBase64) {
    throw new Error("Antigravity OAuth token payload could not be decoded.");
  }

  const fields = readProtoFields(Buffer.from(innerBase64, "base64"));
  const accessToken = fields.find((item) => item.field === 1 && item.wire === 2)?.value.toString("utf8") || "";
  const tokenType = fields.find((item) => item.field === 2 && item.wire === 2)?.value.toString("utf8") || "Bearer";
  const refreshToken = fields.find((item) => item.field === 3 && item.wire === 2)?.value.toString("utf8") || "";

  if (!refreshToken) {
    throw new Error("Antigravity refresh token was not found.");
  }

  return { accessToken, tokenType, refreshToken };
}

async function refreshAntigravityAccessToken(refreshToken) {
  if (!ANTIGRAVITY_OAUTH_CLIENTS.length) {
    throw new Error("Antigravity OAuth client credentials are not configured.");
  }
  configureFetchProxy();

  for (const client of ANTIGRAVITY_OAUTH_CLIENTS) {
    const body = new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.access_token) {
      return payload.access_token;
    }
  }

  throw new Error("Antigravity OAuth token refresh failed.");
}

async function postAntigravityCloudCode(pathName, accessToken, body) {
  configureFetchProxy();
  const response = await fetch(`https://daily-cloudcode-pa.googleapis.com/${pathName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": ANTIGRAVITY_USER_AGENT
    },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = payload && payload.error && payload.error.status ? payload.error.status : response.status;
    throw new Error(`Antigravity CloudCode request failed: ${status}`);
  }
  return payload;
}

function normalizeCloudCodeProject(project) {
  if (typeof project === "string") return project;
  if (project && typeof project.id === "string") return project.id;
  if (project && typeof project.name === "string") return project.name;
  return "";
}

function sortAntigravityModels(response) {
  const byId = response && response.models && typeof response.models === "object"
    ? response.models
    : {};
  const ids = [];
  const pushId = (id) => {
    if (typeof id === "string" && byId[id] && !ids.includes(id)) ids.push(id);
  };

  for (const sortGroup of response.agentModelSorts || []) {
    for (const group of sortGroup.groups || []) {
      for (const id of group.modelIds || []) pushId(id);
    }
  }
  for (const id of Object.keys(byId)) pushId(id);

  const seenNames = new Set();
  const models = [];
  const details = [];
  for (const id of ids) {
    const entry = byId[id] || {};
    const displayName = typeof entry.displayName === "string" ? entry.displayName.trim() : "";
    if (!displayName || entry.disabled) continue;
    const key = displayName.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    models.push(displayName);
    details.push({
      id,
      displayName,
      recommended: Boolean(entry.recommended),
      tagTitle: entry.tagTitle || "",
      quotaRemainingFraction:
        entry.quotaInfo && typeof entry.quotaInfo.remainingFraction === "number"
          ? entry.quotaInfo.remainingFraction
          : null
    });
  }

  return { models, details };
}

async function fetchAntigravityAvailableModels() {
  const tokenInfo = await readAntigravityOAuthTokenInfo();
  const accessToken = await refreshAntigravityAccessToken(tokenInfo.refreshToken);
  const loadResponse = await postAntigravityCloudCode("v1internal:loadCodeAssist", accessToken, {
    metadata: {
      ide_name: "antigravity",
      ide_type: "ANTIGRAVITY",
      ide_version: "1.23.2"
    },
    cloudaicompanion_project: ""
  });
  const project = normalizeCloudCodeProject(
    loadResponse.cloudaicompanionProject || loadResponse.cloudaicompanion_project
  );
  const modelsResponse = await postAntigravityCloudCode(
    "v1internal:fetchAvailableModels",
    accessToken,
    project ? { project } : {}
  );
  const sorted = sortAntigravityModels(modelsResponse);

  return {
    ok: sorted.models.length > 0,
    status: sorted.models.length > 0 ? "cloudcode_models_ok" : "cloudcode_empty_models",
    source: "antigravity cloudcode fetchAvailableModels",
    models: sorted.models,
    modelDetails: sorted.details,
    defaultAgentModelId: modelsResponse.defaultAgentModelId || "",
    modelCountRaw: modelsResponse.models ? Object.keys(modelsResponse.models).length : 0
  };
}

function readTranscriptEntries(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getWorkspaceConversationId(cwd = REPO_DIR) {
  const lastConversations = readJson(LAST_CONVERSATIONS_PATH, {});
  return lastConversations[cwd] || lastConversations[path.resolve(cwd)] || null;
}

function getTranscriptPath(conversationId) {
  if (!conversationId) return null;
  return path.join(
    BRAIN_DIR,
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl"
  );
}

function getCurrentAntigravityModel() {
  const settings = readJson(SETTINGS_PATH, {});
  return settings && typeof settings.model === "string" && settings.model.trim()
    ? settings.model.trim()
    : "";
}

function cleanModelListOutput(output) {
  const cleaned = String(output || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n");
  const seen = new Set();
  const models = [];
  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine
      .replace(/^[\s>*\-•●○✔✓]+/, "")
      .replace(/\s+\(current\)\s*$/i, "")
      .trim();
    if (!line || /^available models:?$/i.test(line)) continue;
    if (/^(usage|error|warning|exit=)/i.test(line)) continue;
    const key = line.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      models.push(line);
    }
  }
  return models;
}

function listTranscriptCandidates() {
  try {
    return fs
      .readdirSync(BRAIN_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const conversationId = entry.name;
        const transcriptPath = getTranscriptPath(conversationId);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(transcriptPath).mtimeMs;
        } catch {
          // Missing transcripts are expected for unused conversations.
        }
        return { conversationId, transcriptPath, mtimeMs };
      })
      .filter((item) => item.mtimeMs > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function findLatestModelResponse({ startedAtMs = 0, cwd = REPO_DIR } = {}) {
  const preferredId = getWorkspaceConversationId(cwd);
  const candidates = listTranscriptCandidates();
  const ordered = [
    ...candidates.filter((item) => item.conversationId === preferredId),
    ...candidates.filter((item) => item.conversationId !== preferredId)
  ];

  for (const candidate of ordered) {
    const entries = readTranscriptEntries(candidate.transcriptPath);
    const modelEntries = entries
      .filter((entry) => {
        if (entry.source !== "MODEL") return false;
        if (entry.type !== "PLANNER_RESPONSE") return false;
        if (entry.status && entry.status !== "DONE") return false;
        if (!entry.content || !String(entry.content).trim()) return false;
        const createdAtMs = Date.parse(entry.created_at || "");
        return !Number.isFinite(createdAtMs) || createdAtMs >= startedAtMs - 3000;
      })
      .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));

    const latest = modelEntries.at(-1);
    if (latest) {
      return {
        conversationId: candidate.conversationId,
        transcriptPath: candidate.transcriptPath,
        content: String(latest.content).trim(),
        thinking: latest.thinking ? String(latest.thinking).trim() : "",
        createdAt: latest.created_at || null
      };
    }
  }

  return null;
}

function runAgyCommand(args, { cwd = REPO_DIR, timeoutMs = 300000, stdin = "" } = {}) {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    const runnerPath = path.join(
      REPO_DIR,
      "bridge-state",
      `agy-runner-${process.pid}-${startedAtMs}.cmd`
    );
    fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
    const argText = args
      .filter((value) => value !== undefined && value !== null && String(value).trim())
      .map((value) => `"${String(value).replaceAll('"', "")}"`)
      .join(" ");
    fs.writeFileSync(
      runnerPath,
      [
        "@echo off",
        "chcp 65001 > NUL",
        `"${AGY_PATH}" ${argText}`,
        "exit /b %ERRORLEVEL%",
        ""
      ].join("\r\n"),
      "utf8"
    );

    // Directly spawning agy.exe from Node can hang on Windows in Antigravity 1.0.9.
    // Running through a temporary .cmd file avoids Node/cmd quote mangling,
    // sends the real prompt on stdin, avoids Windows command-line length limits,
    // and lets Antigravity write the durable answer to its local transcript.
    const child = spawn(
      "cmd.exe",
      ["/d", "/c", runnerPath],
      {
        cwd,
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs + 5000);

    child.stdin.end(stdin, "utf8");

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      try {
        fs.rmSync(runnerPath, { force: true });
      } catch {
        // Best-effort cleanup; stale runner files are harmless diagnostics.
      }
      resolve({
        code,
        signal,
        timedOut,
        startedAtMs,
        elapsedMs: Date.now() - startedAtMs,
        stdout,
        stderr
      });
    });
  });
}

function runAgyPrint(
  prompt,
  {
    cwd = REPO_DIR,
    timeoutMs = 180000,
    modelName = "",
    conversationId = "",
    printPrompt = ""
  } = {}
) {
  const placeholderPrompt =
    printPrompt ||
    "Bridge transport placeholder. Answer the Telegram message provided in stdin.";
  const args = [
    "--print-timeout",
    `${Math.ceil(timeoutMs / 1000)}s`,
    modelName ? "--model" : "",
    modelName || "",
    conversationId ? "--conversation" : "",
    conversationId || "",
    "--print",
    placeholderPrompt
  ];
  return runAgyCommand(args, { cwd, timeoutMs, stdin: prompt });
}

async function listAntigravityModels(options = {}) {
  if (!fs.existsSync(AGY_PATH)) {
    return {
      ok: false,
      status: "missing",
      models: [],
      currentModel: "",
      message: "agy.exe was not found.",
      agyPath: AGY_PATH
    };
  }

  let cloudErrorMessage = "";
  try {
    const cloudModels = await fetchAntigravityAvailableModels();
    if (cloudModels.ok) {
      return {
        ...cloudModels,
        currentModel: getCurrentAntigravityModel(),
        agyPath: AGY_PATH
      };
    }
  } catch (error) {
    // Keep the CLI fallback. Antigravity has exposed an official-looking
    // `agy models` command, but on this Windows build it currently exits with
    // empty stdout, so CloudCode is the preferred source and CLI is diagnostic.
    cloudErrorMessage = error && error.message ? error.message : String(error);
  }

  const result = await runAgyCommand(["models"], {
    cwd: options.cwd || REPO_DIR,
    timeoutMs: options.timeoutMs || 300000
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const models = cleanModelListOutput(output);
  const currentModel = getCurrentAntigravityModel();
  return {
    ok: models.length > 0,
    status: models.length > 0 ? "models_ok" : "empty_models",
    models,
    currentModel,
    source: "agy models",
    agyPath: AGY_PATH,
    elapsedMs: result.elapsedMs,
    exitCode: result.code,
    signal: result.signal,
    message: cloudErrorMessage
      ? `CloudCode model fetch failed first: ${cloudErrorMessage}`
      : "",
    outputPreview: output.slice(0, 1200)
  };
}

async function askAntigravity(prompt, options = {}) {
  if (!fs.existsSync(AGY_PATH)) {
    return {
      ok: false,
      status: "missing",
      message: "agy.exe was not found.",
      agyPath: AGY_PATH
    };
  }

  const result = await runAgyPrint(prompt, options);

  // Antigravity 1.0.9 can complete successfully while leaving stdout empty.
  // The durable source of truth is the local transcript written by the CLI.
  if (result.stdout.trim()) {
    const transcriptResponse = findLatestModelResponse({
      startedAtMs: result.startedAtMs,
      cwd: options.cwd || REPO_DIR
    });
    return {
      ok: true,
      status: "stdout_ok",
      content: result.stdout.trim(),
      conversationId:
        (transcriptResponse && transcriptResponse.conversationId) ||
        options.conversationId ||
        null,
      transcriptPath:
        (transcriptResponse && transcriptResponse.transcriptPath) || null,
      agyPath: AGY_PATH,
      elapsedMs: result.elapsedMs,
      exitCode: result.code,
      signal: result.signal
    };
  }

  const transcriptResponse = findLatestModelResponse({
    startedAtMs: result.startedAtMs,
    cwd: options.cwd || REPO_DIR
  });

  if (transcriptResponse) {
    return {
      ok: true,
      status: "transcript_ok",
      ...transcriptResponse,
      agyPath: AGY_PATH,
      elapsedMs: result.elapsedMs,
      exitCode: result.code,
      signal: result.signal,
      stderrPreview: result.stderr.trim().slice(0, 800)
    };
  }

  return {
    ok: false,
    status: result.timedOut ? "timeout_no_transcript" : "empty_no_transcript",
    message: "Antigravity CLI did not produce stdout, and no matching model response was found in transcript logs.",
    agyPath: AGY_PATH,
    elapsedMs: result.elapsedMs,
    exitCode: result.code,
    signal: result.signal,
    stdoutLength: result.stdout.length,
    stderrPreview: result.stderr.trim().slice(0, 800)
  };
}

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim() || "只回复 PONG";
  const response = await askAntigravity(prompt);
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

module.exports = {
  askAntigravity,
  listAntigravityModels,
  fetchAntigravityAvailableModels,
  getCurrentAntigravityModel,
  findLatestModelResponse,
  getWorkspaceConversationId,
  getTranscriptPath
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}
