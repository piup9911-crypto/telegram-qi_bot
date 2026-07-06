const fs = require("fs");
const net = require("net");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const ROOT = __dirname;
const BRIDGE_ENV_PATH = path.join(ROOT, "bridge.env");
const CODEX_ENV_PATH = path.join(ROOT, "codex-bridge.env");
const STATE_DIR = path.join(ROOT, "codex-bridge-state");
const CONTEXT_SETTINGS_PATH = path.join(STATE_DIR, "context-settings.json");
const AGENT_LOG_PATH = path.join(STATE_DIR, "codex-control-agent.log");
const CONTROL_LOCK_PATH = path.join(STATE_DIR, "codex-control.lock.json");
const START_QI_BRIDGE = path.join(ROOT, "start-telegram-codex-bridge.cmd");
const QI_LOCK_PATH = path.join(STATE_DIR, "codex-bridge.lock.json");
const STATUS_SYNC_SCRIPT = path.join(ROOT, "codex-status-sync.cjs");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function log(...args) {
  ensureDir(STATE_DIR);
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
  fs.appendFileSync(AGENT_LOG_PATH, `${stamped}\n`, "utf8");
  process.stdout.write(`${stamped}\n`);
}

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

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function setCodexContextMaxHistoryChars(params = {}) {
  const maxHistoryChars = clampInteger(
    params.maxHistoryChars,
    800000,
    10000,
    800000
  );
  const settings = readJson(CONTEXT_SETTINGS_PATH, {});
  settings.codex = {
    ...(settings.codex || {}),
    maxHistoryChars,
    updatedAt: new Date().toISOString()
  };
  writeJson(CONTEXT_SETTINGS_PATH, settings);
  return {
    status: "completed",
    message: `Codex bot 最大历史字符数已设置为 ${maxHistoryChars}。重启祈桥接后生效。`
  };
}

function deriveCodexControlUrl() {
  if (process.env.CODEX_CONTROL_URL) return process.env.CODEX_CONTROL_URL;
  const sharedMemoryUrl = process.env.SHARED_MEMORY_URL || "";
  if (sharedMemoryUrl.includes("/api/shared-memory")) {
    return sharedMemoryUrl.replace(/\/api\/shared-memory.*$/, "/api/codex-control");
  }
  return "";
}

function requestJson(method, url, token, body) {
  ensureDir(STATE_DIR);
  const bodyPath = path.join(STATE_DIR, "gem-control-request.json");
  if (body) {
    fs.writeFileSync(bodyPath, JSON.stringify(body), "utf8");
  } else if (fs.existsSync(bodyPath)) {
    fs.unlinkSync(bodyPath);
  }

  // The local Node runtime cannot always reach Vercel directly on this machine.
  // PowerShell already follows the user's working Windows network path, so all
  // cloud control requests go through Invoke-RestMethod on purpose.
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$headers = @{ 'x-memory-sync-token' = $env:GEM_CONTROL_TOKEN; Accept = 'application/json' }",
    "if (Test-Path -LiteralPath $env:CODEX_CONTROL_BODY) {",
    "  $body = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:CODEX_CONTROL_BODY",
    "  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "  $result = Invoke-RestMethod -Method $env:CODEX_CONTROL_METHOD -Uri $env:CODEX_CONTROL_URL -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8'",
    "} else {",
    "  $result = Invoke-RestMethod -Method $env:CODEX_CONTROL_METHOD -Uri $env:CODEX_CONTROL_URL -Headers $headers",
    "}",
    "$result | ConvertTo-Json -Depth 20 -Compress"
  ].join("; ");

  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_CONTROL_BODY: bodyPath,
        CODEX_CONTROL_METHOD: method,
        GEM_CONTROL_TOKEN: token,
        CODEX_CONTROL_URL: url
      }
    }
  );

  return output.trim() ? JSON.parse(output) : null;
}

function getListeningPid(port) {
  try {
    const output = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "im");
    const match = output.match(pattern);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
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

function processExists(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function acquireControlLock() {
  const existing = readJson(CONTROL_LOCK_PATH, null);
  const existingPid = existing && existing.pid ? Number(existing.pid) : null;
  if (processExists(existingPid)) {
    throw new Error(`Another Codex control agent is already running (pid ${existingPid}).`);
  }
  writeJson(CONTROL_LOCK_PATH, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    script: "codex-control-agent.cjs"
  });
}

function releaseControlLock() {
  const existing = readJson(CONTROL_LOCK_PATH, null);
  if (existing && Number(existing.pid) === process.pid) {
    try {
      fs.unlinkSync(CONTROL_LOCK_PATH);
    } catch {}
  }
}

function checkTcp(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    }
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    ...options
  });
  child.unref();
  return child.pid;
}

async function startQiBridge() {
  const lock = readJson(QI_LOCK_PATH, null);
  const existingPid = lock && lock.pid ? Number(lock.pid) : null;
  if (processExists(existingPid)) {
    return { status: "skipped", message: `祈 (Codex CLI) 桥接已经在线，PID ${existingPid}。` };
  }

  const pid = spawnDetached("cmd.exe", ["/c", "start", "/min", '""', START_QI_BRIDGE]);
  return { status: "completed", message: `已发起祈桥接启动，launcher PID ${pid}。` };
}

async function restartQiBridge() {
  const lock = readJson(QI_LOCK_PATH, null);
  const existingPid = lock && lock.pid ? Number(lock.pid) : null;
  if (processExists(existingPid)) {
    try { process.kill(existingPid); } catch {}
  }
  return startQiBridge();
}

async function syncStatusOnce() {
  execFileSync("node.exe", [STATUS_SYNC_SCRIPT], { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
  return { status: "completed", message: "已同步一次 Codex 状态。" };
}

async function executeCommand(command) {
  if (!command || command.status !== "queued") {
    return null;
  }

  if (command.action === "start_codex_bridge") return startQiBridge();
  if (command.action === "restart_codex_bridge") return restartQiBridge();
  if (command.action === "sync_codex_status") return syncStatusOnce();
  if (command.action === "set_codex_context_max_chars") return setCodexContextMaxHistoryChars(command.params);

  return {
    status: "failed",
    message: `不支持的动作：${command.action || "unknown"}`
  };
}

async function markCommand(url, token, command, status, message) {
  return requestJson("PUT", url, token, {
    id: command.id,
    status,
    message
  });
}

async function pollOnce(url, token) {
  const state = requestJson("GET", url, token);
  const command = state && state.command;
  if (!command || command.status !== "queued") {
    return false;
  }

  log("claiming command", {
    id: command.id,
    action: command.action
  });
  markCommand(url, token, command, "running", "本机控制器已领取指令，正在执行。");

  const result = await executeCommand(command);
  if (result) {
    markCommand(url, token, command, result.status, result.message);
    log("command finished", {
      id: command.id,
      action: command.action,
      status: result.status,
      message: result.message
    });
  }

  return true;
}

async function main() {
  loadEnvFile(path.join(ROOT, "bridge.env"));
  loadEnvFile(CODEX_ENV_PATH);
  acquireControlLock();

  const url = deriveCodexControlUrl();
  const token = process.env.SHARED_MEMORY_SYNC_TOKEN || "";
  if (!url) {
    throw new Error("Missing CODEX_CONTROL_URL or SHARED_MEMORY_URL in environment.");
  }
  if (!token) {
    throw new Error("Missing SHARED_MEMORY_SYNC_TOKEN in environment.");
  }

  const watch = process.argv.includes("--watch");
  const pollMs = Math.max(
    3000,
    Number.parseInt(process.env.GEM_CONTROL_POLL_MS || "8000", 10) || 8000
  );

  log("codex control agent started", { url, watch, pollMs });

  await pollOnce(url, token);
  if (!watch) return;

  setInterval(() => {
    pollOnce(url, token).catch((error) => {
      log("poll failed", error && error.message ? error.message : String(error));
    });
  }, pollMs);
}

main().catch((error) => {
  log("codex control agent crashed", error && error.stack ? error.stack : String(error));
  releaseControlLock();
  process.exitCode = 1;
});

process.on("SIGINT", () => {
  releaseControlLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseControlLock();
  process.exit(0);
});
process.on("exit", releaseControlLock);
