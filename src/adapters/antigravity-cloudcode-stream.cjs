/*
 * Antigravity CloudCode streaming chat client.
 *
 * Bypasses agy.exe entirely — calls the same internal Google CloudCode API
 * that the Antigravity CLI uses, but directly over HTTPS with OAuth tokens
 * extracted from the Antigravity IDE's local state database.
 *
 * This eliminates the ~25s cold-start of agy.exe (SQLite init, auth parsing,
 * context loading) and provides true streaming output.
 *
 * Endpoint: v1internal:streamGenerateChat on daily-cloudcode-pa.googleapis.com
 * Response: streaming JSON array, each element has {markdown, processingDetails, ...}
 */

const os = require("os");
const path = require("path");

// --- HTTP client with proxy support ---
let undici;
try {
  undici = require("undici");
} catch {
  undici = null;
}

let proxyConfigured = false;
function configureProxy() {
  if (proxyConfigured || !undici) return;
  proxyConfigured = true;
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    "";
  if (!proxyUrl) return;
  try {
    undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
  } catch {}
}

const httpFetch = undici ? undici.fetch : globalThis.fetch;

// --- Constants ---
const STATE_DB_PATH = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Antigravity",
  "User",
  "globalStorage",
  "state.vscdb"
);

const OAUTH_CLIENTS = readAntigravityOAuthClients();

const USER_AGENT = "antigravity/1.23.2 windows/amd64";
const CC_BASE = "https://daily-cloudcode-pa.googleapis.com/";
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000;

// --- Token cache ---
let cachedAccessToken = null;
let cachedTokenAt = 0;
let cachedProject = null;

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
    { id: process.env.ANTIGRAVITY_OAUTH_CLIENT_ID_2, secret: process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET_2 },
  ]
    .map((item) => ({ id: String(item.id || "").trim(), secret: String(item.secret || "").trim() }))
    .filter((item) => item.id && item.secret);
}

// --- Protobuf parsing (from antigravity-cli-adapter.cjs) ---
function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < buffer.length; i += 1) {
    const byte = BigInt(buffer[i]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return [value, i + 1];
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

// --- SQLite reading ---
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = null;
}

function readOAuthTokenFromDB() {
  if (!Database) {
    throw new Error(
      "better-sqlite3 is not installed. Run: npm install better-sqlite3"
    );
  }
  const db = new Database(STATE_DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("antigravityUnifiedStateSync.oauthToken");
    if (!row || !row.value) {
      throw new Error("Antigravity OAuth token not found in state.vscdb.");
    }
    return Buffer.isBuffer(row.value)
      ? row.value.toString("utf8")
      : String(row.value);
  } finally {
    db.close();
  }
}

function extractRefreshToken(encodedState) {
  const outer = Buffer.from(encodedState, "base64");
  const innerBase64 =
    (outer.toString("utf8").match(/[A-Za-z0-9+/=]{200,}/g) || [])[0];
  if (!innerBase64) {
    throw new Error("OAuth token payload could not be decoded.");
  }
  const fields = readProtoFields(Buffer.from(innerBase64, "base64"));
  const refreshToken =
    fields.find((i) => i.field === 3 && i.wire === 2)?.value.toString("utf8") ||
    "";
  if (!refreshToken) {
    throw new Error("Refresh token not found in OAuth protobuf.");
  }
  return refreshToken;
}

// --- OAuth ---
async function refreshAccessToken(refreshToken) {
  if (!OAUTH_CLIENTS.length) {
    throw new Error("Antigravity OAuth client credentials are not configured.");
  }
  configureProxy();
  for (const client of OAUTH_CLIENTS) {
    const body = new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    try {
      const response = await httpFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.access_token) {
        return payload.access_token;
      }
    } catch {}
  }
  throw new Error("Antigravity OAuth token refresh failed.");
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now - cachedTokenAt < TOKEN_CACHE_TTL_MS) {
    return cachedAccessToken;
  }
  const encodedState = readOAuthTokenFromDB();
  const refreshToken = extractRefreshToken(encodedState);
  const token = await refreshAccessToken(refreshToken);
  cachedAccessToken = token;
  cachedTokenAt = now;
  return token;
}

// --- Project ID ---
async function getProjectId(accessToken) {
  if (cachedProject) return cachedProject;
  configureProxy();
  const response = await httpFetch(CC_BASE + "v1internal:loadCodeAssist", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      metadata: {
        ide_name: "antigravity",
        ide_type: "ANTIGRAVITY",
        ide_version: "1.23.2",
      },
      cloudaicompanion_project: "",
    }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  const project =
    payload.cloudaicompanionProject ||
    payload.cloudaicompanion_project ||
    "";
  if (!project) {
    throw new Error("Failed to get CloudCode project ID.");
  }
  cachedProject = project;
  return project;
}

// --- Streaming JSON array parser ---
class StreamingJsonArrayParser {
  constructor() {
    this.buffer = "";
    this.cursor = 0;
  }

  append(chunk) {
    this.buffer += chunk;
    const results = [];
    while (this.cursor < this.buffer.length) {
      const start = this.buffer.indexOf("{", this.cursor);
      if (start === -1) break;
      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let i = start; i < this.buffer.length; i++) {
        const c = this.buffer[i];
        if (inString) {
          if (escape) escape = false;
          else if (c === "\\") escape = true;
          else if (c === '"') inString = false;
        } else {
          if (c === '"') inString = true;
          else if (c === "{") depth++;
          else if (c === "}") {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
      }
      if (end === -1) break;
      try {
        results.push(JSON.parse(this.buffer.slice(start, end + 1)));
      } catch {}
      this.cursor = end + 1;
    }
    if (this.cursor > 100000) {
      this.buffer = this.buffer.slice(this.cursor);
      this.cursor = 0;
    }
    return results;
  }
}

// --- Main: native Antigravity 3.1 Pro streaming chat ---
async function streamChatAntigravity(prompt, options = {}) {
  const {
    onChunk,
    timeoutMs = 180000,
    signal: externalSignal,
    requirePro31 = true,
  } = options;

  const startedAt = Date.now();
  configureProxy();

  const accessToken = await getAccessToken();
  const project = await getProjectId(accessToken);

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Math.max(5000, timeoutMs)
  );
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  // The CloudCode endpoint rejects public model IDs as model_config_id.
  // Antigravity selects its active 3.1 Pro configuration server-side; the
  // response model is verified below so a Flash fallback cannot go unnoticed.
  const response = await httpFetch(CC_BASE + "v1internal:streamGenerateChat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      project,
      user_message: String(prompt || ""),
    }),
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", abortFromExternal);
    }
    if (response.status === 401 && !options._retried) {
      cachedAccessToken = null;
      cachedTokenAt = 0;
      return streamChatAntigravity(prompt, { ...options, _retried: true });
    }
    throw new Error(
      `streamGenerateChat failed: ${response.status} ${errorText.slice(0, 500)}`
    );
  }

  const parser = new StreamingJsonArrayParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let fullText = "";
  let modelDisplayName = "";
  let modelConfigId = "";
  let usageMetadata = null;
  let firstChunkAt = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      const decoded = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      const payloads = parser.append(decoded);

      for (const payload of payloads) {
        const pd = payload.processingDetails || {};
        const reportedModel = pd.modelConfig?.displayName || "";
        const reportedModelConfigId = pd.modelConfig?.id || "";
        if (reportedModel) modelDisplayName = reportedModel;
        if (reportedModelConfigId) modelConfigId = reportedModelConfigId;
        if (payload.usageMetadata) usageMetadata = payload.usageMetadata;

        if (
          requirePro31 &&
          reportedModel &&
          !/3[.]1\s+Pro/i.test(reportedModel)
        ) {
          await reader.cancel().catch(() => {});
          throw new Error(
            `Antigravity model mismatch: expected 3.1 Pro, got ${reportedModel}`
          );
        }

        const delta = String(payload.markdown || "");
        if (!delta) continue;
        if (firstChunkAt === null) firstChunkAt = Date.now() - startedAt;
        fullText += delta;
        if (typeof onChunk === "function") {
          try {
            onChunk(delta);
          } catch {}
        }
      }

      if (done) break;
    }
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", abortFromExternal);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  return {
    ok: true,
    text: fullText.trim() || "No response returned.",
    thinkingText: null,
    model: modelDisplayName,
    modelConfigId,
    usageMetadata,
    firstChunkMs: firstChunkAt,
    elapsedMs,
  };
}

module.exports = {
  streamChatAntigravity,
  getAccessToken,
  getProjectId,
};
