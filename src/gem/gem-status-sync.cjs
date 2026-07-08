const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const BRIDGE_ENV_PATH = path.join(ROOT, "bridge.env");
const ST_STATE_DIR = path.join(ROOT, "st-bridge-state");
const TELEGRAM_STATE_DIR = path.join(ROOT, "bridge-state");
const CONTEXT_SETTINGS_PATH = path.join(TELEGRAM_STATE_DIR, "context-settings.json");
const PROMPT_PREVIEW_PATH = path.join(
  TELEGRAM_STATE_DIR,
  "latest-prompt-preview.json"
);
const PUBLIC_URL_PATH = path.join(ST_STATE_DIR, "public-openai-bridge-url.txt");
const OPENAI_LOG_PATH = path.join(ST_STATE_DIR, "openai-bridge.log");
const TUNNEL_LOG_PATH = path.join(ST_STATE_DIR, "localhostrun.out.log");
const CLOUDFLARED_LOG_PATH = path.join(ST_STATE_DIR, "cloudflared.out.log");
const CLOUDFLARED_TEST_LOG_PATH = path.join(ST_STATE_DIR, "cloudflared-test.log");
const TELEGRAM_LOG_PATH = path.join(TELEGRAM_STATE_DIR, "bridge.log");
const TELEGRAM_LOCK_PATH = path.join(TELEGRAM_STATE_DIR, "bridge.lock.json");
// Report explicit defaults even before the user saves the form once. This keeps
// old config files and newly opened devices visually consistent.
const DEFAULT_PROMPT_CONTROLS = Object.freeze({
  persona: true,
  bridgeInstructions: true,
  currentTime: true,
  conversationTiming: true,
  coreMemory: true,
  activeThreads: true,
  vectorMemory: true,
  chatRecall: true,
  memoryConstraints: true
});

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) process.env[key] = value;
  }
}

function readText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readContextSettings() {
  const settings = readJson(CONTEXT_SETTINGS_PATH, {});
  const maxHistoryChars = clampInteger(
    settings &&
      settings.telegramGem &&
      settings.telegramGem.maxHistoryChars !== undefined
      ? settings.telegramGem.maxHistoryChars
      : 100000,
    100000,
    10000,
    1000000
  );
  const configuredControls =
    settings &&
    settings.telegramGem &&
    settings.telegramGem.promptControls &&
    typeof settings.telegramGem.promptControls === "object"
      ? settings.telegramGem.promptControls
      : {};
  return {
    telegramGem: {
      maxHistoryChars,
      promptControls: Object.fromEntries(
        Object.entries(DEFAULT_PROMPT_CONTROLS).map(([key, defaultValue]) => [
          key,
          typeof configuredControls[key] === "boolean"
            ? configuredControls[key]
            : defaultValue
        ])
      ),
      officialInputTokenLimit: 1048576,
      maxAllowedHistoryChars: 1000000,
      source: fs.existsSync(CONTEXT_SETTINGS_PATH) ? "context-settings.json" : "default"
    }
  };
}

function readPromptPreview() {
  const preview = readJson(PROMPT_PREVIEW_PATH, {}) || {};
  return {
    updatedAt: preview.updatedAt || null,
    chatId: String(preview.chatId || "").slice(0, 80),
    model: String(preview.model || "").slice(0, 100),
    promptChars: Math.max(0, Number(preview.promptChars) || 0),
    previewChars: Math.max(0, Number(preview.previewChars) || 0),
    recentHistory:
      preview.recentHistory && typeof preview.recentHistory === "object"
        ? preview.recentHistory
        : {},
    promptControls:
      preview.promptControls && typeof preview.promptControls === "object"
        ? preview.promptControls
        : {},
    content: String(preview.content || "").slice(0, 180000)
  };
}

function lastNonEmptyLine(filePath) {
  const lines = readText(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function deriveGemStatusUrl() {
  if (process.env.GEM_STATUS_URL) {
    return process.env.GEM_STATUS_URL;
  }

  const sharedMemoryUrl = process.env.SHARED_MEMORY_URL || "";
  if (sharedMemoryUrl.includes("/api/shared-memory")) {
    return sharedMemoryUrl.replace(/\/api\/shared-memory.*$/, "/api/gem-status");
  }

  return "";
}

function disableProxyForStatusUpload() {
  if (String(process.env.GEM_STATUS_USE_PROXY || "").toLowerCase() === "true") {
    return;
  }

  // Status upload goes to the public Vercel site. The bridge.env file may keep
  // local proxy settings for Gemini/Telegram debugging, but a closed
  // 127.0.0.1:10808 proxy would make this heartbeat look offline even when the
  // website is reachable. Keep the heartbeat direct unless explicitly opted in.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    delete process.env[key];
  }
}

function getListeningPid(port) {
  try {
    const output = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${escapedPort}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "im");
    const match = output.match(pattern);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    // Signal 0 is a cross-platform liveness check; it does not terminate the process.
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function findProcessIdsByImage(imageName) {
  try {
    const output = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8"
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.includes("INFO:"))
      .map((line) => line.match(/^"[^"]+","(\d+)"/))
      .filter(Boolean)
      .map((match) => Number(match[1]));
  } catch {
    return [];
  }
}

function findPublicUrl() {
  const saved = readText(PUBLIC_URL_PATH).trim();
  if (saved) {
    return saved;
  }

  for (const logPath of [CLOUDFLARED_LOG_PATH, CLOUDFLARED_TEST_LOG_PATH]) {
    const cloudflaredLog = readText(logPath);
    const cloudflareMatch = cloudflaredLog.match(/https:\/\/[A-Za-z0-9-]+\.trycloudflare\.com/i);
    if (cloudflareMatch && cloudflareMatch[0]) {
      return `${cloudflareMatch[0].replace(/[.,;]+$/, "")}/v1`;
    }
  }

  const tunnelLog = readText(TUNNEL_LOG_PATH);
  const assigned = tunnelLog.match(/tunneled with tls termination,\s+(https:\/\/[A-Za-z0-9.-]+)/i);
  if (assigned && assigned[1]) {
    return `${assigned[1].replace(/[.,;]+$/, "")}/v1`;
  }

  // localhost.run also prints documentation URLs and social links. If the
  // stable assignment line is missing, ignore those service links and use the
  // most recent tunnel-looking HTTPS host instead.
  const matches = (tunnelLog.match(/https:\/\/[A-Za-z0-9.-]+(?:\/v1)?/g) || []).filter(
    (item) => !item.includes("localhost.run") && !item.includes("twitter.com")
  );
  if (!matches || matches.length === 0) {
    return "";
  }

  const latest = matches[matches.length - 1].replace(/[.,;]+$/, "");
  return latest.endsWith("/v1") ? latest : `${latest}/v1`;
}

function buildStatus() {
  const port = Number.parseInt(process.env.OPENAI_BRIDGE_PORT || "4141", 10) || 4141;
  const openaiPid = getListeningPid(port);
  const telegramLock = readJson(TELEGRAM_LOCK_PATH, null);
  const telegramPid = telegramLock && telegramLock.pid ? Number(telegramLock.pid) : null;
  const publicUrl = findPublicUrl();

  // Keep the cloud payload descriptive but not secret-bearing: URLs and process
  // liveness are useful on the phone, while tokens and local env values stay local.
  return {
    reporter: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cwd: ROOT
    },
    links: {
      publicUrl,
      localOpenaiUrl: `http://127.0.0.1:${port}/v1`
    },
    services: {
      openaiBridge: {
        online: Boolean(openaiPid),
        pid: openaiPid,
        port,
        model: process.env.OPENAI_BRIDGE_DEFAULT_MODEL || process.env.BRIDGE_GEMINI_MODEL_QUALITY || "gemini-3.1-pro-preview",
        lastLine: lastNonEmptyLine(OPENAI_LOG_PATH)
      },
      publicTunnel: {
        online:
          Boolean(publicUrl) &&
          (findProcessIdsByImage("ssh.exe").length > 0 ||
            findProcessIdsByImage("cloudflared.exe").length > 0),
        url: publicUrl,
        sshPids: findProcessIdsByImage("ssh.exe"),
        cloudflaredPids: findProcessIdsByImage("cloudflared.exe"),
        lastLine:
          lastNonEmptyLine(CLOUDFLARED_LOG_PATH) ||
          lastNonEmptyLine(CLOUDFLARED_TEST_LOG_PATH) ||
          lastNonEmptyLine(TUNNEL_LOG_PATH)
      },
      telegramBridge: {
        online: processExists(telegramPid),
        pid: telegramPid,
        lockFile: fs.existsSync(TELEGRAM_LOCK_PATH),
        lastLine: lastNonEmptyLine(TELEGRAM_LOG_PATH)
      },
      memorySync: {
        configured: Boolean(process.env.SHARED_MEMORY_URL && process.env.SHARED_MEMORY_SYNC_TOKEN),
        url: process.env.SHARED_MEMORY_URL || "",
        hasToken: Boolean(process.env.SHARED_MEMORY_SYNC_TOKEN)
      }
    },
    context: readContextSettings(),
    // Include the latest compact prompt snapshot so a manual legacy status sync
    // cannot erase the preview uploaded by the newer background agent.
    promptPreview: readPromptPreview(),
    notes: "Status is reported by the local Gemini bridge workspace."
  };
}

function uploadStatusWithPowerShell(url, token, status) {
  const bodyPath = path.join(ST_STATE_DIR, "gem-status-upload.json");
  fs.mkdirSync(ST_STATE_DIR, { recursive: true });
  fs.writeFileSync(bodyPath, JSON.stringify(status), "utf8");

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$body = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:GEM_STATUS_UPLOAD_BODY",
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "$result = Invoke-RestMethod -Method Put -Uri $env:GEM_STATUS_UPLOAD_URL -Headers @{ 'x-memory-sync-token' = $env:GEM_STATUS_UPLOAD_TOKEN } -Body $bytes -ContentType 'application/json; charset=utf-8'",
    "$result | ConvertTo-Json -Depth 12 -Compress"
  ].join("; ");

  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GEM_STATUS_UPLOAD_BODY: bodyPath,
        GEM_STATUS_UPLOAD_URL: url,
        GEM_STATUS_UPLOAD_TOKEN: token
      }
    }
  );

  return output.trim() ? JSON.parse(output) : null;
}

async function uploadStatus() {
  const url = deriveGemStatusUrl();
  const token = process.env.SHARED_MEMORY_SYNC_TOKEN || "";
  const status = buildStatus();

  if (!url) {
    throw new Error("Missing GEM_STATUS_URL or SHARED_MEMORY_URL in bridge.env.");
  }

  if (!token) {
    throw new Error("Missing SHARED_MEMORY_SYNC_TOKEN in bridge.env.");
  }

  let response = null;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-memory-sync-token": token
      },
      body: JSON.stringify(status)
    });
  } catch (error) {
    // Node's built-in fetch does not use the user's Windows/browser proxy in
    // this environment. Fall back to PowerShell, which matches the route that
    // already works for checking the Vercel site from this machine.
    return uploadStatusWithPowerShell(url, token, status);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    throw new Error(
      payload && payload.error ? payload.error : `Status upload failed with ${response.status}`
    );
  }

  return payload;
}

async function main() {
  loadEnvFile(BRIDGE_ENV_PATH);
  disableProxyForStatusUpload();

  const watch = process.argv.includes("--watch");
  const intervalMs = Math.max(
    10000,
    Number.parseInt(process.env.GEM_STATUS_SYNC_INTERVAL_MS || "30000", 10) || 30000
  );

  async function tick() {
    const result = await uploadStatus();
    process.stdout.write(
      `[${new Date().toISOString()}] gem status uploaded: ${result && result.updatedAt ? result.updatedAt : "ok"}\n`
    );
  }

  await tick();
  if (!watch) return;

  setInterval(() => {
    tick().catch((error) => {
      process.stderr.write(
        `[${new Date().toISOString()}] gem status upload failed: ${
          error && error.message ? error.message : String(error)
        }\n`
      );
    });
  }, intervalMs);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
