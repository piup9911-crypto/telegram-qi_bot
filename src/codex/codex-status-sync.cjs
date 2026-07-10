const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CODEX_ENV_PATH = path.join(ROOT, "codex-bridge.env");
const CODEX_STATE_DIR = path.join(ROOT, "codex-bridge-state");
const CONTEXT_SETTINGS_PATH = path.join(CODEX_STATE_DIR, "context-settings.json");
const QI_LOG_PATH = path.join(CODEX_STATE_DIR, "codex-bridge.log");
const QI_LOCK_PATH = path.join(CODEX_STATE_DIR, "codex-bridge.lock.json");

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
    settings && settings.codex && settings.codex.maxHistoryChars !== undefined
      ? settings.codex.maxHistoryChars
      : 800000,
    800000,
    10000,
    800000
  );
  return {
    codex: {
      maxHistoryChars,
      officialContextTokenLimit: 1050000,
      maxAllowedHistoryChars: 800000,
      source: fs.existsSync(CONTEXT_SETTINGS_PATH) ? "context-settings.json" : "default"
    }
  };
}

function lastNonEmptyLine(filePath) {
  const lines = readText(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function deriveCodexStatusUrl() {
  if (process.env.CODEX_STATUS_URL) return process.env.CODEX_STATUS_URL;
  const sharedMemoryUrl = process.env.SHARED_MEMORY_URL || "";
  if (sharedMemoryUrl.includes("/api/shared-memory")) {
    return sharedMemoryUrl.replace(/\/api\/shared-memory.*$/, "/api/codex-status");
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

function buildStatus() {
  const qiLock = readJson(QI_LOCK_PATH, null);
  const qiPid = qiLock && qiLock.pid ? Number(qiLock.pid) : null;

  return {
    reporter: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cwd: ROOT
    },
    services: {
      qiBridge: {
        online: processExists(qiPid),
        pid: qiPid,
        lockFile: fs.existsSync(QI_LOCK_PATH),
        model: process.env.CODEX_BRIDGE_MODEL || "gpt-5.6-terra",
        sandbox: process.env.CODEX_BRIDGE_SANDBOX || "danger-full-access",
        reasoning: process.env.CODEX_BRIDGE_REASONING_EFFORT || "medium",
        lastLine: lastNonEmptyLine(QI_LOG_PATH)
      }
    },
    context: readContextSettings(),
    notes: "Codex status is reported by the local bridge workspace."
  };
}

function uploadStatusWithPowerShell(url, token, status) {
  const bodyPath = path.join(CODEX_STATE_DIR, "codex-status-upload.json");
  fs.mkdirSync(CODEX_STATE_DIR, { recursive: true });
  fs.writeFileSync(bodyPath, JSON.stringify(status), "utf8");

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$body = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:CODEX_STATUS_UPLOAD_BODY",
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "$result = Invoke-RestMethod -Method Put -Uri $env:CODEX_STATUS_UPLOAD_URL -Headers @{ 'x-memory-sync-token' = $env:CODEX_STATUS_UPLOAD_TOKEN } -Body $bytes -ContentType 'application/json; charset=utf-8'",
    "$result | ConvertTo-Json -Depth 12 -Compress"
  ].join("; ");

  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_STATUS_UPLOAD_BODY: bodyPath,
        CODEX_STATUS_UPLOAD_URL: url,
        CODEX_STATUS_UPLOAD_TOKEN: token
      }
    }
  );

  return output.trim() ? JSON.parse(output) : null;
}

async function uploadStatus() {
  const url = deriveCodexStatusUrl();
  const token = process.env.SHARED_MEMORY_SYNC_TOKEN || "";
  const status = buildStatus();

  if (!url) {
    throw new Error("Missing CODEX_STATUS_URL or SHARED_MEMORY_URL in environment.");
  }

  if (!token) {
    throw new Error("Missing SHARED_MEMORY_SYNC_TOKEN in environment.");
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
  loadEnvFile(path.join(ROOT, "bridge.env"));
  loadEnvFile(CODEX_ENV_PATH);
  disableProxyForStatusUpload();

  const watch = process.argv.includes("--watch");
  const intervalMs = Math.max(
    10000,
    Number.parseInt(process.env.GEM_STATUS_SYNC_INTERVAL_MS || "30000", 10) || 30000
  );

  async function tick() {
    const result = await uploadStatus();
    process.stdout.write(
      `[${new Date().toISOString()}] codex status uploaded: ${result && result.updatedAt ? result.updatedAt : "ok"}\n`
    );
  }

  await tick();
  if (!watch) return;

  setInterval(() => {
    tick().catch((error) => {
      process.stderr.write(
        `[${new Date().toISOString()}] codex status upload failed: ${
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
