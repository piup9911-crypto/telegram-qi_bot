const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const REAL_HOME = os.homedir();
const SOURCE_GEMINI_DIR = path.join(REAL_HOME, ".gemini");
const BRIDGE_ENV_PATH = path.join(ROOT, "bridge.env");

function loadEnvFile(filePath, overrideExisting) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    value = value.replace(/(^['"]|['"]$)/g, "");
    if (overrideExisting || !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(SOURCE_GEMINI_DIR, ".env"), false);
loadEnvFile(BRIDGE_ENV_PATH, false);

function getSharedMemoryConfig() {
  // LEGACY CLOUD API: this still points at the old pending/approved memory
  // service so we can migrate existing data into the new independent memory
  // system. New automatic memory writes should use `memory-docs/` records
  // instead of creating more old pending/approved entries.
  return {
    apiUrl:
      process.env.SHARED_MEMORY_URL ||
      process.env.BRIDGE_SHARED_MEMORY_URL ||
      "",
    syncToken: process.env.SHARED_MEMORY_SYNC_TOKEN || ""
  };
}

function getMemoryEntriesUrl(apiUrl) {
  if (!apiUrl) return "";
  return apiUrl.replace(/\/shared-memory(?:\?.*)?$/i, "/memory-entries");
}

function nodeHttpRequestJson(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === "http:" ? http : https;
    const req = transport.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        // Prefer IPv4 for Vercel/Supabase memory calls. On this Windows setup
        // Node can occasionally pick an IPv6 route that hangs until timeout,
        // while PowerShell reaches the same endpoint immediately.
        family: options.family || 4,
        timeout: options.timeoutMs || 15000
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {}

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              data: parsed,
              raw: data
            });
            return;
          }

          const message =
            (parsed && (parsed.error || parsed.message)) ||
            data ||
            `Request failed with ${res.statusCode}`;
          reject(new Error(message));
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Cloud memory request timed out."));
    });
    req.on("error", (error) => {
      reject(error);
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

function powershellRequestJson(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const headersJson = JSON.stringify(options.headers || {});
    const bodyBase64 = options.body
      ? Buffer.from(options.body, "utf8").toString("base64")
      : "";
    const timeoutSec = Math.max(
      1,
      Math.ceil((options.timeoutMs || 15000) / 1000)
    );
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$headers = @{}",
      "if ($env:MEMORY_HEADERS_JSON) {",
      "  $parsedHeaders = $env:MEMORY_HEADERS_JSON | ConvertFrom-Json",
      "  foreach ($property in $parsedHeaders.PSObject.Properties) {",
      "    $headers[$property.Name] = [string]$property.Value",
      "  }",
      "}",
      "$invokeArgs = @{",
      "  Uri = $env:MEMORY_URL",
      "  Method = $env:MEMORY_METHOD",
      "  Headers = $headers",
      "  TimeoutSec = [int]$env:MEMORY_TIMEOUT_SEC",
      "  UseBasicParsing = $true",
      "}",
      "$tempPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ([System.Guid]::NewGuid().ToString() + '.json'))",
      "$invokeArgs.OutFile = $tempPath",
      "if ($env:MEMORY_BODY_BASE64) {",
      "  $invokeArgs.Body = [System.Convert]::FromBase64String($env:MEMORY_BODY_BASE64)",
      "}",
      "try {",
      "  $response = Invoke-WebRequest @invokeArgs",
      "  $raw = ''",
      "  try {",
      "    if (Test-Path -LiteralPath $tempPath) {",
      "      $rawBytes = [System.IO.File]::ReadAllBytes($tempPath)",
      "      $raw = [System.Text.Encoding]::UTF8.GetString($rawBytes)",
      "    }",
      "  } catch {}",
      "  Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue",
      "  $statusCode = 200",
      "  if ($response -and $response.StatusCode) { $statusCode = [int]$response.StatusCode }",
      "  $rawBase64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$raw))",
      "  [Console]::Out.WriteLine((@{ statusCode = $statusCode; rawBase64 = $rawBase64 } | ConvertTo-Json -Compress))",
      "} catch {",
      "  Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue",
      "  $statusCode = 0",
      "  $raw = $_.Exception.Message",
      "  if ($_.Exception.Response) {",
      "    $statusCode = [int]$_.Exception.Response.StatusCode",
      "    try {",
      "      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())",
      "      $raw = $reader.ReadToEnd()",
      "    } catch {}",
      "  }",
      "  $rawBase64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$raw))",
      "  [Console]::Out.WriteLine((@{ statusCode = $statusCode; rawBase64 = $rawBase64 } | ConvertTo-Json -Compress))",
      "  exit 1",
      "}"
    ].join("\n");

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          MEMORY_URL: urlString,
          MEMORY_METHOD: options.method || "GET",
          MEMORY_HEADERS_JSON: headersJson,
          // Pass request bodies as UTF-8 bytes so Chinese memory writes do not
          // get mangled when Node falls back to Windows PowerShell networking.
          MEMORY_BODY_BASE64: bodyBase64,
          MEMORY_TIMEOUT_SEC: String(timeoutSec)
        }
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      let payload = null;
      try {
        payload = stdout.trim() ? JSON.parse(stdout.trim()) : null;
      } catch {}

      if (!payload) {
        reject(new Error(stderr.trim() || `PowerShell request exited with ${code}`));
        return;
      }

      const raw =
        typeof payload.rawBase64 === "string"
          ? Buffer.from(payload.rawBase64, "base64").toString("utf8")
          : typeof payload.raw === "string"
            ? payload.raw
            : "";
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {}

      if (payload.statusCode >= 200 && payload.statusCode < 300) {
        resolve({
          statusCode: payload.statusCode,
          headers: {},
          data: parsed,
          raw
        });
        return;
      }

      const message =
        (parsed && (parsed.error || parsed.message)) ||
        raw ||
        stderr.trim() ||
        `Request failed with ${payload.statusCode}`;
      reject(new Error(message));
    });
  });
}

async function httpRequestJson(urlString, options = {}) {
  if (process.platform === "win32" && options.preferNodeHttp !== true) {
    try {
      // On this Windows setup Node's direct HTTPS path can be slower or return
      // garbled UTF-8 from the Vercel memory endpoint. The PowerShell path now
      // sends/receives raw UTF-8 bytes, so prefer it for memory stability.
      return await powershellRequestJson(urlString, options);
    } catch (powerShellError) {
      if (options.allowNodeFallback === false) {
        throw powerShellError;
      }

      try {
        return await nodeHttpRequestJson(urlString, options);
      } catch {
        throw powerShellError;
      }
    }
  }

  try {
    return await nodeHttpRequestJson(urlString, options);
  } catch (error) {
    if (
      process.platform === "win32" &&
      options.allowPowerShellFallback !== false
    ) {
      // Windows fallback: PowerShell can reach the user's Vercel deployment in
      // environments where Node's direct socket path times out. Keep this
      // contained in the cloud client so Telegram/CLI memory sync stays stable.
      return powershellRequestJson(urlString, options);
    }
    throw error;
  }
}

async function fetchSharedMemoryBundle(options = {}) {
  // Legacy read-only fetch. The new single-source memory system imports this
  // once via legacy-cloud-memory-migration.cjs, then treats `memory-docs/` as
  // the local source of truth.
  const config = getSharedMemoryConfig();
  const apiUrl = options.apiUrl || config.apiUrl;
  const syncToken = options.syncToken || config.syncToken;

  if (!apiUrl) {
    return {
      ok: false,
      skipped: true,
      reason: "SHARED_MEMORY_URL is not configured."
    };
  }

  if (!syncToken) {
    return {
      ok: false,
      skipped: true,
      reason: "SHARED_MEMORY_SYNC_TOKEN is not configured."
    };
  }

  const response = await httpRequestJson(apiUrl, {
    method: "GET",
    timeoutMs: options.timeoutMs || 15000,
    headers: {
      Accept: "application/json",
      "X-Memory-Sync-Token": syncToken,
      "X-Memory-Client": options.clientName || "local-sync"
    }
  });

  const payload = response.data || {};
  return {
    ok: true,
    apiUrl,
    content: typeof payload.content === "string" ? payload.content : "",
    updatedAt: payload.updatedAt || null,
    approvedEntries: Array.isArray(payload.approvedEntries)
      ? payload.approvedEntries
      : [],
    pendingEntries: Array.isArray(payload.pendingEntries)
      ? payload.pendingEntries
      : []
  };
}

async function postMemoryEntries(entries, options = {}) {
  // Deprecated write path for the old pending/approved cloud system. Keep it
  // available for rollback/debugging, but do not use it for new memory ingest.
  const config = getSharedMemoryConfig();
  const apiUrl = options.apiUrl || config.apiUrl;
  const syncToken = options.syncToken || config.syncToken;
  const entriesUrl = options.entriesUrl || getMemoryEntriesUrl(apiUrl);

  if (!entriesUrl) {
    return {
      ok: false,
      skipped: true,
      reason: "Shared memory entries URL is not configured."
    };
  }

  if (!syncToken) {
    return {
      ok: false,
      skipped: true,
      reason: "SHARED_MEMORY_SYNC_TOKEN is not configured."
    };
  }

  const response = await httpRequestJson(entriesUrl, {
    method: "POST",
    timeoutMs: options.timeoutMs || 15000,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Memory-Sync-Token": syncToken,
      "X-Memory-Client": options.clientName || "local-ingest"
    },
    body: JSON.stringify({ entries })
  });

  return {
    ok: true,
    entries: Array.isArray(response.data && response.data.entries)
      ? response.data.entries
      : []
  };
}

module.exports = {
  ROOT,
  SOURCE_GEMINI_DIR,
  BRIDGE_ENV_PATH,
  getSharedMemoryConfig,
  getMemoryEntriesUrl,
  httpRequestJson,
  fetchSharedMemoryBundle,
  postMemoryEntries
};
