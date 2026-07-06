const fs = require("fs");
const path = require("path");
const {
  ROOT,
  getSharedMemoryConfig,
  httpRequestJson
} = require("./cloud-memory-client.cjs");

const BRIDGE_STATE_DIR = path.join(ROOT, "bridge-state");
const LOCAL_CONFIG_PATH = path.join(BRIDGE_STATE_DIR, "lmc-provider-config-cache.json");
const PROVIDER_STATUS_PATH = path.join(BRIDGE_STATE_DIR, "lmc-provider-status.json");

const DEFAULT_FALLBACK_MODEL = "Gemini 3.5 Flash (Low)";
const DEFAULT_GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_API_MODEL = "gemini-3.5-flash";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function compactText(value, maxLength) {
  const text = String(value || "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function parsePositiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (provider === "openai" || provider === "openai-compatible") {
    return "openai-compatible";
  }
  return "gemini-api";
}

function normalizeProviderConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const provider = normalizeProvider(source.provider);
  const apiUrl =
    compactText(source.apiUrl, 500) ||
    (provider === "gemini-api" ? DEFAULT_GEMINI_API_URL : "");
  const model =
    compactText(source.model, 160) ||
    (provider === "gemini-api" ? DEFAULT_GEMINI_API_MODEL : "");
  const apiKey = compactText(source.apiKey, 2000);
  return {
    schemaVersion: 1,
    enabled: Boolean(source.enabled),
    provider,
    apiUrl,
    model,
    apiKey,
    fallbackModel: compactText(source.fallbackModel, 160) || DEFAULT_FALLBACK_MODEL,
    timeoutMs: parsePositiveInteger(source.timeoutMs, 90000, 10000, 300000),
    updatedAt: source.updatedAt || "",
    source: source.source || ""
  };
}

function maskApiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return "";
  if (key.length <= 10) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function publicProviderConfig(config) {
  const normalized = normalizeProviderConfig(config);
  return {
    ...normalized,
    apiKey: "",
    hasApiKey: Boolean(normalized.apiKey),
    maskedApiKey: maskApiKey(normalized.apiKey)
  };
}

function providerConfigUrlFromSharedMemoryUrl(apiUrl) {
  const url = String(apiUrl || "").trim();
  if (!url) return "";
  if (/\/api\/shared-memory(?:\?.*)?$/i.test(url)) {
    return url.replace(
      /\/api\/shared-memory(?:\?.*)?$/i,
      "/api/gem-status?mode=provider-config"
    );
  }
  return "";
}

function getProviderConfigUrl() {
  return (
    process.env.LMC_PROVIDER_CONFIG_URL ||
    providerConfigUrlFromSharedMemoryUrl(getSharedMemoryConfig().apiUrl)
  );
}

function readLocalProviderConfig() {
  const envEnabled = String(process.env.LMC_CUSTOM_API_ENABLED || "").toLowerCase();
  const envConfig = normalizeProviderConfig({
    enabled: ["1", "true", "yes", "on", "enabled"].includes(envEnabled),
    provider: process.env.LMC_CUSTOM_API_PROVIDER || "gemini-api",
    apiUrl: process.env.LMC_CUSTOM_API_URL || DEFAULT_GEMINI_API_URL,
    apiKey: process.env.LMC_CUSTOM_API_KEY || "",
    model: process.env.LMC_CUSTOM_API_MODEL || DEFAULT_GEMINI_API_MODEL,
    fallbackModel: process.env.LMC_ANTIGRAVITY_MODEL || DEFAULT_FALLBACK_MODEL,
    timeoutMs: process.env.LMC_CUSTOM_API_TIMEOUT_MS || 90000,
    source: "env"
  });
  const cached = normalizeProviderConfig(readJson(LOCAL_CONFIG_PATH, {}));
  return normalizeProviderConfig({
    ...envConfig,
    ...cached,
    apiKey: cached.apiKey || envConfig.apiKey,
    source: cached.updatedAt ? "cache" : envConfig.source
  });
}

async function fetchRemoteProviderConfig(options = {}) {
  const config = getSharedMemoryConfig();
  const url = options.url || getProviderConfigUrl();
  const syncToken = options.syncToken || config.syncToken;
  if (!url || !syncToken) {
    return {
      ok: false,
      skipped: true,
      reason: "Provider config URL or sync token is not configured."
    };
  }

  const response = await httpRequestJson(url, {
    method: "GET",
    timeoutMs: options.timeoutMs || 15000,
    headers: {
      Accept: "application/json",
      "X-Memory-Sync-Token": syncToken,
      "X-Memory-Client": "lmc-provider-config"
    }
  });
  return {
    ok: true,
    config: normalizeProviderConfig({
      ...(response.data || {}),
      source: "cloud"
    })
  };
}

async function loadMemoryProviderConfig(options = {}) {
  const localConfig = readLocalProviderConfig();
  if (options.skipCloud) return localConfig;
  try {
    const remote = await fetchRemoteProviderConfig(options);
    if (remote.ok && remote.config) {
      writeJsonAtomic(LOCAL_CONFIG_PATH, {
        ...remote.config,
        cachedAt: new Date().toISOString()
      });
      return remote.config;
    }
  } catch (error) {
    // The cloud config is a convenience layer, not a dependency for replying.
    // If fetching it fails, keep using the last local cache or env fallback.
    writeMemoryProviderStatus({
      configFetchOk: false,
      configFetchError: error && error.message ? error.message : String(error),
      configFetchErrorAt: new Date().toISOString()
    });
  }
  return localConfig;
}

function readMemoryProviderStatus() {
  return readJson(PROVIDER_STATUS_PATH, {}) || {};
}

function writeMemoryProviderStatus(patch) {
  const previous = readMemoryProviderStatus();
  const next = {
    ...previous,
    ...(patch || {}),
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(PROVIDER_STATUS_PATH, next);
  return next;
}

function publicProviderStatus() {
  const config = publicProviderConfig(readLocalProviderConfig());
  const status = readMemoryProviderStatus();
  return {
    config,
    status: {
      enabled: Boolean(status.enabled),
      activeProvider: status.activeProvider || "",
      configuredProvider: status.configuredProvider || config.provider,
      model: status.model || config.model || "",
      fallbackModel: status.fallbackModel || config.fallbackModel,
      customApiOk: status.customApiOk === true,
      lastAttemptAt: status.lastAttemptAt || "",
      lastSuccessAt: status.lastSuccessAt || "",
      lastErrorAt: status.lastErrorAt || status.configFetchErrorAt || "",
      lastError: compactText(status.lastError || status.configFetchError || "", 220),
      notice: compactText(status.notice || "", 220)
    }
  };
}

module.exports = {
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_GEMINI_API_MODEL,
  DEFAULT_GEMINI_API_URL,
  getProviderConfigUrl,
  loadMemoryProviderConfig,
  normalizeProviderConfig,
  publicProviderConfig,
  publicProviderStatus,
  readMemoryProviderStatus,
  writeMemoryProviderStatus
};
