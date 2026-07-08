const fs = require("fs");
const net = require("net");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const BRIDGE_ENV_PATH = path.join(ROOT, "bridge.env");
const STATE_DIR = path.join(ROOT, "st-bridge-state");
const TELEGRAM_STATE_DIR = path.join(ROOT, "bridge-state");
const CONTEXT_SETTINGS_PATH = path.join(TELEGRAM_STATE_DIR, "context-settings.json");
const AGENT_LOG_PATH = path.join(STATE_DIR, "gem-control-agent.log");
const START_PUBLIC_BRIDGE = path.join(ROOT, "start-public-openai-bridge.ps1");
const TELEGRAM_BRIDGE_SCRIPT = path.join(ROOT, "telegram-gem-bridge.cjs");
const TELEGRAM_LOCK_PATH = path.join(ROOT, "bridge-state", "bridge.lock.json");
const STATUS_SYNC_SCRIPT = path.join(ROOT, "gem-status-sync.cjs");
const PUBLIC_URL_PATH = path.join(STATE_DIR, "public-openai-bridge-url.txt");
const TUNNEL_LOG_PATH = path.join(STATE_DIR, "localhostrun.out.log");
const CLOUDFLARED_LOG_PATH = path.join(STATE_DIR, "cloudflared.out.log");
const CLOUDFLARED_TEST_LOG_PATH = path.join(STATE_DIR, "cloudflared-test.log");
// Keep the legacy control agent compatible with the newer status agent. Either
// one may claim a queued website command, so both must normalize the same keys.
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

function setGemContextMaxHistoryChars(params = {}) {
  const maxHistoryChars = clampInteger(
    params.maxHistoryChars,
    100000,
    10000,
    1000000
  );
  const settings = readJson(CONTEXT_SETTINGS_PATH, {});
  settings.telegramGem = {
    ...(settings.telegramGem || {}),
    maxHistoryChars,
    updatedAt: new Date().toISOString()
  };
  writeJson(CONTEXT_SETTINGS_PATH, settings);
  return {
    status: "completed",
    message: `Gem 主 bot 最大历史字符数已设置为 ${maxHistoryChars}。重启 Telegram bridge 后生效。`
  };
}

function normalizePromptControls(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    Object.entries(DEFAULT_PROMPT_CONTROLS).map(([key, defaultValue]) => [
      key,
      typeof source[key] === "boolean" ? source[key] : defaultValue
    ])
  );
}

function setGemPromptControls(params = {}) {
  const promptControls = normalizePromptControls(params.promptControls);
  const settings = readJson(CONTEXT_SETTINGS_PATH, {});
  settings.telegramGem = {
    ...(settings.telegramGem || {}),
    promptControls,
    updatedAt: new Date().toISOString()
  };
  writeJson(CONTEXT_SETTINGS_PATH, settings);
  return {
    status: "completed",
    message: "Gem 主 bot Prompt 输入开关已保存，下一条消息起生效。"
  };
}

function deriveControlUrl() {
  if (process.env.GEM_CONTROL_URL) {
    return process.env.GEM_CONTROL_URL;
  }

  const sharedMemoryUrl = process.env.SHARED_MEMORY_URL || "";
  if (sharedMemoryUrl.includes("/api/shared-memory")) {
    return sharedMemoryUrl.replace(/\/api\/shared-memory.*$/, "/api/gem-control");
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
    "if (Test-Path -LiteralPath $env:GEM_CONTROL_BODY) {",
    "  $body = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:GEM_CONTROL_BODY",
    "  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)",
    "  $result = Invoke-RestMethod -Method $env:GEM_CONTROL_METHOD -Uri $env:GEM_CONTROL_URL -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8'",
    "} else {",
    "  $result = Invoke-RestMethod -Method $env:GEM_CONTROL_METHOD -Uri $env:GEM_CONTROL_URL -Headers $headers",
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
        GEM_CONTROL_BODY: bodyPath,
        GEM_CONTROL_METHOD: method,
        GEM_CONTROL_TOKEN: token,
        GEM_CONTROL_URL: url
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

function publicTunnelLooksOnline() {
  const savedUrl = readText(PUBLIC_URL_PATH).trim();
  const tunnelLog = readText(TUNNEL_LOG_PATH);
  const cloudflaredLog = `${readText(CLOUDFLARED_LOG_PATH)}\n${readText(CLOUDFLARED_TEST_LOG_PATH)}`;
  const hasAssignedUrl = /tunneled with tls termination,\s+https:\/\/[A-Za-z0-9.-]+/i.test(tunnelLog);
  const hasCloudflareUrl = /https:\/\/[A-Za-z0-9-]+\.trycloudflare\.com/i.test(cloudflaredLog);
  return (
    Boolean(savedUrl || hasAssignedUrl || hasCloudflareUrl) &&
    (findProcessIdsByImage("ssh.exe").length > 0 ||
      findProcessIdsByImage("cloudflared.exe").length > 0)
  );
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

async function startPublicOpenaiBridge() {
  const port = Number.parseInt(process.env.OPENAI_BRIDGE_PORT || "4141", 10) || 4141;
  const bridgePid = getListeningPid(port);
  if (bridgePid && publicTunnelLooksOnline()) {
    return {
      status: "skipped",
      message: `公网桥接已经在线，OpenAI Bridge PID ${bridgePid}。`
    };
  }

  const pid = spawnDetached("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    START_PUBLIC_BRIDGE
  ]);

  return {
    status: "completed",
    message: `已发起公网桥接启动，launcher PID ${pid}。状态页会在几十秒内刷新。`
  };
}

async function startTelegramBridge() {
  const lock = readJson(TELEGRAM_LOCK_PATH, null);
  const existingPid = lock && lock.pid ? Number(lock.pid) : null;
  if (processExists(existingPid)) {
    return {
      status: "skipped",
      message: `Telegram 桥接已经在线，PID ${existingPid}。`
    };
  }

  // The Telegram launcher currently depends on the local proxy. Failing early
  // here avoids starting a bridge that immediately enters polling/network errors.
  const proxyReady = await checkTcp("127.0.0.1", 10808, 1200);
  if (!proxyReady) {
    return {
      status: "failed",
      message: "127.0.0.1:10808 代理没有连上，先打开代理再从网页启动 Telegram 桥接。"
    };
  }

  const pid = spawnDetached("node.exe", [TELEGRAM_BRIDGE_SCRIPT], {
    env: {
      ...process.env,
      HTTP_PROXY: "http://127.0.0.1:10808",
      HTTPS_PROXY: "http://127.0.0.1:10808",
      NO_PROXY: "localhost,127.0.0.1"
    }
  });

  return {
    status: "completed",
    message: `已发起 Telegram 桥接启动，PID ${pid}。`
  };
}

async function syncStatusOnce() {
  execFileSync("node.exe", [STATUS_SYNC_SCRIPT], {
    cwd: ROOT,
    stdio: "pipe",
    encoding: "utf8"
  });
  return {
    status: "completed",
    message: "已同步一次 Gem 状态。"
  };
}

async function executeCommand(command) {
  if (!command || command.status !== "queued") {
    return null;
  }

  if (command.action === "start_public_openai_bridge") {
    return startPublicOpenaiBridge();
  }

  if (command.action === "start_telegram_bridge") {
    return startTelegramBridge();
  }

  if (command.action === "sync_status_once") {
    return syncStatusOnce();
  }

  if (command.action === "set_gem_context_max_chars") {
    const result = setGemContextMaxHistoryChars(command.params);
    // The website reads a cloud snapshot rather than the local settings file.
    // Upload immediately so open PC and phone pages converge on the same value.
    await syncStatusOnce();
    return result;
  }

  if (command.action === "set_gem_prompt_controls") {
    const result = setGemPromptControls(command.params);
    // Upload the applied switches immediately so PC and phone show the same
    // configuration instead of keeping a device-local UI state.
    await syncStatusOnce();
    return result;
  }

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
  loadEnvFile(BRIDGE_ENV_PATH);

  const url = deriveControlUrl();
  const token = process.env.SHARED_MEMORY_SYNC_TOKEN || "";
  if (!url) {
    throw new Error("Missing GEM_CONTROL_URL or SHARED_MEMORY_URL in bridge.env.");
  }
  if (!token) {
    throw new Error("Missing SHARED_MEMORY_SYNC_TOKEN in bridge.env.");
  }

  const watch = process.argv.includes("--watch");
  const pollMs = Math.max(
    3000,
    Number.parseInt(process.env.GEM_CONTROL_POLL_MS || "8000", 10) || 8000
  );

  log("gem control agent started", {
    url,
    watch,
    pollMs
  });

  await pollOnce(url, token);
  if (!watch) return;

  setInterval(() => {
    pollOnce(url, token).catch((error) => {
      log("poll failed", error && error.message ? error.message : String(error));
    });
  }, pollMs);
}

main().catch((error) => {
  log("gem control agent crashed", error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
