const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVICE = "/exa.language_server_pb.LanguageServerService/";
const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const STREAM_IDLE_MS = Math.max(
  0,
  Number.parseInt(process.env.BRIDGE_ANTIGRAVITY_STREAM_IDLE_MS || "1800000", 10) || 0
);
const PARALLEL_STREAM_START =
  String(process.env.BRIDGE_ANTIGRAVITY_PARALLEL_STREAM_START || "true")
    .trim()
    .toLowerCase() !== "false";
const TRAJECTORY_POLL_MS = Math.max(
  100,
  Number.parseInt(process.env.BRIDGE_ANTIGRAVITY_TRAJECTORY_POLL_MS || "200", 10) || 200
);
const SIDECAR_REQUEST_TIMEOUT_MS = Math.max(
  300000,
  Number.parseInt(process.env.BRIDGE_ANTIGRAVITY_SIDECAR_REQUEST_TIMEOUT_MS || "300000", 10) || 300000
);
const PLANNER_POLL_DIAGNOSTICS_ENABLED =
  String(process.env.BRIDGE_ANTIGRAVITY_PLANNER_POLL_DIAG || "true")
    .trim()
    .toLowerCase() !== "false";
const BRIDGE_LOG_PATH = path.join(__dirname, "bridge-state", "bridge.log");
const sidecarAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 2,
  rejectUnauthorized: false
});

let cachedEndpoint = null;
let cachedEndpointAt = 0;
const sharedStateStreams = new Map();

function sidecarDiagLog(message, data = {}) {
  if (!PLANNER_POLL_DIAGNOSTICS_ENABLED) return;
  try {
    fs.mkdirSync(path.dirname(BRIDGE_LOG_PATH), { recursive: true });
    fs.appendFileSync(
      BRIDGE_LOG_PATH,
      `[${new Date().toISOString()}] ${message} ${JSON.stringify(data)}\n`,
      "utf8"
    );
  } catch {}
}

class SidecarRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SidecarRequestError";
    Object.assign(this, details);
  }
}

function discoverSidecar({ force = false } = {}) {
  if (
    !force &&
    cachedEndpoint &&
    Date.now() - cachedEndpointAt < DISCOVERY_TTL_MS
  ) {
    return cachedEndpoint;
  }

  const script = [
    "$proc = Get-CimInstance Win32_Process |",
    "  Where-Object { $_.Name -eq 'language_server.exe' -and $_.CommandLine -match '--csrf_token' } |",
    "  Sort-Object CreationDate -Descending | Select-Object -First 1;",
    "if (-not $proc) { exit 3 };",
    "$token = [regex]::Match($proc.CommandLine, '--csrf_token\\s+([^\\s]+)').Groups[1].Value;",
    "if (-not $token) { exit 4 };",
    "[pscustomobject]@{ pid = $proc.ProcessId; csrfToken = $token } | ConvertTo-Json -Compress"
  ].join(" ");

  let raw;
  try {
    raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 10000 }
    ).trim();
  } catch (error) {
    throw new SidecarRequestError("Antigravity sidecar is not running.", {
      phase: "discovery",
      cause: error
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SidecarRequestError("Antigravity sidecar discovery returned invalid JSON.", {
      phase: "discovery",
      cause: error
    });
  }

  let netstatText;
  try {
    netstatText = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000
    });
  } catch (error) {
    throw new SidecarRequestError("Could not inspect Antigravity sidecar ports.", {
      phase: "discovery",
      cause: error
    });
  }
  const pid = Number(parsed.pid);
  const ports = netstatText
    .split(/\r?\n/)
    .map((line) =>
      line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    )
    .filter((match) => match && Number(match[2]) === pid)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
  if (ports.length === 0) {
    throw new SidecarRequestError("Antigravity sidecar has no listening localhost port.", {
      phase: "discovery",
      pid
    });
  }

  cachedEndpoint = {
    pid,
    port: ports[0],
    csrfToken: String(parsed.csrfToken || "")
  };
  cachedEndpointAt = Date.now();
  return cachedEndpoint;
}

function requestJson(method, payload, { timeoutMs = SIDECAR_REQUEST_TIMEOUT_MS, retry = true } = {}) {
  const endpoint = discoverSidecar();
  const body = Buffer.from(JSON.stringify(payload || {}), "utf8");

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port: endpoint.port,
        path: SERVICE + method,
        method: "POST",
        rejectUnauthorized: false,
        agent: sidecarAgent,
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": endpoint.csrfToken,
          "Content-Length": body.length
        },
        timeout: Math.max(5000, timeoutMs)
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = {};
          if (text.trim()) {
            try {
              data = JSON.parse(text);
            } catch (error) {
              reject(
                new SidecarRequestError(
                  `Antigravity sidecar ${method} returned invalid JSON.`,
                  { method, statusCode: response.statusCode, responseText: text, cause: error }
                )
              );
              return;
            }
          }

          if ((response.statusCode || 500) < 200 || response.statusCode >= 300) {
            reject(
              new SidecarRequestError(
                data.message || `Antigravity sidecar ${method} failed with HTTP ${response.statusCode}.`,
                { method, statusCode: response.statusCode, response: data }
              )
            );
            return;
          }
          resolve(data);
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Antigravity sidecar ${method} timed out.`));
    });
    request.on("error", async (error) => {
      if (retry) {
        cachedEndpoint = null;
        cachedEndpointAt = 0;
        try {
          resolve(await requestJson(method, payload, { timeoutMs, retry: false }));
          return;
        } catch (retryError) {
          reject(retryError);
          return;
        }
      }
      reject(
        new SidecarRequestError(`Antigravity sidecar ${method} connection failed: ${error.message}`, {
          method,
          phase: "request",
          cause: error
        })
      );
    });
    request.end(body);
  });
}

function encodeConnectEnvelope(payload) {
  const json = Buffer.from(JSON.stringify(payload || {}), "utf8");
  const envelope = Buffer.allocUnsafe(5 + json.length);
  envelope[0] = 0;
  envelope.writeUInt32BE(json.length, 1);
  json.copy(envelope, 5);
  return envelope;
}

function streamAgentStateUpdates(
  conversationId,
  { timeoutMs = 180000, onUpdate, onError, onEnd } = {}
) {
  const endpoint = discoverSidecar();
  const subscriberId = `telegram-bridge-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const body = encodeConnectEnvelope({ conversationId, subscriberId });
  let request = null;
  let settled = false;
  let closed = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const fail = (error) => {
    if (closed) return;
    if (!settled) {
      settled = true;
      rejectReady(error);
      return;
    }
    if (typeof onError === "function") {
      try {
        onError(error);
      } catch {}
    }
  };

  request = https.request(
    {
      hostname: "127.0.0.1",
      port: endpoint.port,
      path: SERVICE + "StreamAgentStateUpdates",
      method: "POST",
      rejectUnauthorized: false,
      agent: sidecarAgent,
      headers: {
        "Content-Type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        "X-Codeium-Csrf-Token": endpoint.csrfToken,
        "Content-Length": body.length
      },
      timeout: Math.max(5000, timeoutMs)
    },
    (response) => {
      if ((response.statusCode || 500) < 200 || response.statusCode >= 300) {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          fail(
            new SidecarRequestError(
              `Antigravity StreamAgentStateUpdates failed with HTTP ${response.statusCode}.`,
              {
                method: "StreamAgentStateUpdates",
                statusCode: response.statusCode,
                responseText: Buffer.concat(chunks).toString("utf8")
              }
            )
          );
        });
        return;
      }

      if (!settled) {
        settled = true;
        resolveReady();
      }
      let pending = Buffer.alloc(0);
      response.on("data", (chunk) => {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= 5) {
          const flags = pending[0];
          const length = pending.readUInt32BE(1);
          if (pending.length < 5 + length) break;
          const payload = pending.subarray(5, 5 + length);
          pending = pending.subarray(5 + length);
          let data;
          try {
            data = payload.length ? JSON.parse(payload.toString("utf8")) : {};
          } catch (error) {
            fail(
              new SidecarRequestError(
                "Antigravity StreamAgentStateUpdates returned invalid JSON.",
                { method: "StreamAgentStateUpdates", cause: error }
              )
            );
            continue;
          }
          if (flags & 0x02) {
            if (data?.error) {
              fail(
                new SidecarRequestError(
                  data.error.message || "Antigravity state stream ended with an error.",
                  { method: "StreamAgentStateUpdates", response: data }
                )
              );
            }
            continue;
          }
          if (typeof onUpdate === "function") {
            try {
              onUpdate(data);
            } catch (error) {
              fail(error);
            }
          }
        }
      });
      response.on("error", fail);
      response.on("end", () => {
        if (!closed && typeof onEnd === "function") {
          try {
            onEnd();
          } catch {}
        }
      });
    }
  );

  request.on("timeout", () => {
    request.destroy(new Error("Antigravity StreamAgentStateUpdates timed out."));
  });
  request.on("error", (error) => {
    fail(
      new SidecarRequestError(
        `Antigravity StreamAgentStateUpdates connection failed: ${error.message}`,
        { method: "StreamAgentStateUpdates", phase: "stream", cause: error }
      )
    );
  });
  request.end(body);

  return {
    ready,
    close() {
      closed = true;
      if (request && !request.destroyed) request.destroy();
    }
  };
}

function createSharedStateStream(conversationId, { timeoutMs, idleMs, persistent }) {
  const listeners = new Set();
  const entry = {
    conversationId,
    persistent,
    idleMs,
    listeners,
    stream: null,
    ready: null,
    readyAt: 0,
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
    idleTimer: null,
    closed: false,
    close(reason = "closed", destroyStream = true) {
      if (entry.closed) return;
      entry.closed = true;
      entry.closeReason = reason;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      listeners.clear();
      if (sharedStateStreams.get(conversationId) === entry) {
        sharedStateStreams.delete(conversationId);
      }
      if (destroyStream && entry.stream) entry.stream.close();
    },
    touch() {
      entry.lastTouchedAt = Date.now();
      if (!entry.persistent || entry.idleMs <= 0 || entry.closed) return;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => entry.close("idle-timeout"), entry.idleMs);
      if (typeof entry.idleTimer.unref === "function") entry.idleTimer.unref();
    },
    subscribe(listener) {
      if (entry.closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };

  const streamTimeoutMs = Math.max(
    timeoutMs || 180000,
    persistent && idleMs > 0 ? idleMs + 60000 : 180000
  );
  entry.stream = streamAgentStateUpdates(conversationId, {
    timeoutMs: streamTimeoutMs,
    onUpdate: (event) => {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {}
      }
    },
    onError: () => entry.close("stream-error", false),
    onEnd: () => entry.close("stream-ended", false)
  });
  entry.ready = entry.stream.ready
    .then(() => {
      entry.readyAt = Date.now();
      return entry;
    })
    .catch((error) => {
      entry.close("stream-open-failed");
      throw error;
    });
  // Parallel startup deliberately does not await this promise. Attach a
  // handler immediately so a failed preview stream never becomes an unhandled
  // rejection or interrupts the trajectory-polling fallback.
  entry.ready.catch(() => {});
  entry.touch();
  return entry;
}

function acquireStateStream(conversationId, { timeoutMs, idleMs = STREAM_IDLE_MS } = {}) {
  const persistent = idleMs > 0;
  if (persistent) {
    const existing = sharedStateStreams.get(conversationId);
    if (existing && !existing.closed) {
      existing.touch();
      return { entry: existing, reused: true };
    }
  }
  const entry = createSharedStateStream(conversationId, {
    timeoutMs,
    idleMs,
    persistent
  });
  if (persistent) sharedStateStreams.set(conversationId, entry);
  return { entry, reused: false };
}

function trajectoryStepIdentity(step) {
  const info = step?.metadata?.sourceTrajectoryStepInfo || {};
  if (info.trajectoryId && info.stepIndex !== undefined) {
    return `${info.trajectoryId}:${info.stepIndex}`;
  }
  const createdAt = step?.metadata?.createdAt || "";
  return createdAt ? `${step?.type || ""}:${createdAt}` : "";
}

function resolvePlanModel(modelName) {
  const normalized = String(modelName || "").toLowerCase();
  if (normalized.includes("3.1 pro") && normalized.includes("low")) {
    return "MODEL_PLACEHOLDER_M36";
  }
  if (normalized.includes("3.1 pro")) {
    return "MODEL_PLACEHOLDER_M16";
  }
  return "MODEL_PLACEHOLDER_M16";
}

async function startCascade(options = {}) {
  const payload = {
    source: "CORTEX_TRAJECTORY_SOURCE_CLI"
  };
  if (Array.isArray(options.workspaceUris) && options.workspaceUris.length > 0) {
    payload.workspaceUris = options.workspaceUris.map(String);
  }
  const result = await requestJson("StartCascade", payload, { timeoutMs: SIDECAR_REQUEST_TIMEOUT_MS });
  if (!result.cascadeId) {
    throw new SidecarRequestError("Antigravity sidecar did not return a cascadeId.", {
      method: "StartCascade",
      response: result
    });
  }
  return result.cascadeId;
}

async function getCascadeTrajectory(cascadeId) {
  return requestJson("GetCascadeTrajectory", { cascadeId }, { timeoutMs: SIDECAR_REQUEST_TIMEOUT_MS });
}

async function cascadeExists(cascadeId) {
  if (!cascadeId) return false;
  try {
    const result = await getCascadeTrajectory(cascadeId);
    return Boolean(result?.trajectory?.cascadeId === cascadeId);
  } catch {
    return false;
  }
}

function getSteps(result) {
  return Array.isArray(result?.trajectory?.steps) ? result.trajectory.steps : [];
}

function plannerText(step) {
  return String(
    step?.plannerResponse?.modifiedResponse ||
    step?.plannerResponse?.response ||
    step?.plannerResponse?.text ||
    ""
  ).trim();
}

function plannerThinking(step) {
  return String(step?.plannerResponse?.thinking || "").trim();
}

function userInputText(step) {
  const items = step?.userInput?.items;
  if (!Array.isArray(items) || items.length === 0) return "";
  const texts = [];
  for (const item of items) {
    if (!item) continue;
    if (typeof item.text === "string") texts.push(item.text);
    else if (typeof item.content === "string") texts.push(item.content);
  }
  return texts.join("\n").trim();
}

// Convert a trajectory snapshot into a linear list of dialogue turns.
// Each entry is { role, content, at, stepIdentity, type } where:
//   role         "user" | "assistant"
//   content      raw message text (NOT cleaned of thought markers — caller
//                decides whether to apply cleanAssistantRecordText)
//   at           ISO timestamp from step.metadata.createdAt, or ""
//   stepIdentity stable identity from trajectoryStepIdentity
//   type         "user_input" | "planner_response"
// Steps that are not dialogue content (conversation_history, checkpoint,
// tool calls, errors, in-progress waits, etc.) are skipped.
function extractTrajectoryMessages(trajectory) {
  const steps = getSteps({ trajectory });
  const out = [];
  for (const step of steps) {
    if (!step) continue;
    const status = step?.status || "";
    if (
      status === "CORTEX_STEP_STATUS_WAITING" ||
      status === "CORTEX_STEP_STATUS_PENDING" ||
      status === "CORTEX_STEP_STATUS_RUNNING" ||
      status === "CORTEX_STEP_STATUS_GENERATING"
    ) {
      continue;
    }
    const identity = trajectoryStepIdentity(step);
    const at = step?.metadata?.createdAt || "";
    if (step?.type === "CORTEX_STEP_TYPE_USER_INPUT") {
      const content = userInputText(step);
      if (content) out.push({ role: "user", content, at, stepIdentity: identity, type: "user_input" });
    } else if (step?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
      const content = plannerText(step);
      if (content) out.push({ role: "assistant", content, at, stepIdentity: identity, type: "planner_response" });
    }
  }
  return out;
}

// Detect the bootstrap prompt that was injected by the bridge itself when
// opening a new Cascade. Such messages should not be mirrored back into the
// local chat JSON because they are meta-instructions, not real dialogue.
function looksLikeBootstrapUserMessage(content) {
  if (typeof content !== "string" || content.length < 20) return false;
  return content.startsWith("[系统] 你正在通过 Telegram 与用户持续对话");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stepIsActive(step) {
  return [
    "CORTEX_STEP_STATUS_PENDING",
    "CORTEX_STEP_STATUS_RUNNING",
    "CORTEX_STEP_STATUS_GENERATING",
    "CORTEX_STEP_STATUS_WAITING"
  ].includes(step?.status);
}

async function approveWaitingInteraction(cascadeId, step) {
  const sourceInfo = step?.metadata?.sourceTrajectoryStepInfo || {};
  const interaction = {
    trajectoryId: sourceInfo.trajectoryId,
    stepIndex: sourceInfo.stepIndex
  };
  if (!interaction.trajectoryId || interaction.stepIndex === undefined) {
    throw new SidecarRequestError("Antigravity requested an interaction without step metadata.", {
      method: "HandleCascadeUserInteraction",
      cascadeId,
      interactionRequired: true,
      step
    });
  }

  if (step?.requestedInteraction?.permission) {
    interaction.permission = {
      allow: true,
      scope: "PERMISSION_SCOPE_ONCE"
    };
  } else if (step?.requestedInteraction?.filePermission) {
    const request = step.requestedInteraction.filePermission;
    interaction.filePermission = {
      allow: true,
      scope: "PERMISSION_SCOPE_ONCE",
      absolutePathUri: request.absolutePathUri || request.path || ""
    };
  } else {
    throw new SidecarRequestError("Antigravity is waiting for an unsupported user interaction.", {
      method: "HandleCascadeUserInteraction",
      cascadeId,
      interactionRequired: true,
      step
    });
  }

  await requestJson(
    "HandleCascadeUserInteraction",
    { cascadeId, interaction },
    { timeoutMs: SIDECAR_REQUEST_TIMEOUT_MS }
  );
  return {
    trajectoryId: interaction.trajectoryId,
    stepIndex: interaction.stepIndex,
    type: interaction.permission ? "permission" : "filePermission"
  };
}

async function sendCascadeMessage(
  cascadeId,
  text,
  modelName,
  {
    timeoutMs = 180000,
    autoApprovePermissions = true,
    onStreamText,
    streamIdleMs = STREAM_IDLE_MS,
    parallelStreamStart = PARALLEL_STREAM_START
  } = {}
) {
  const before = await getCascadeTrajectory(cascadeId);
  const beforeSteps = getSteps(before);
  const beforeCount = beforeSteps.length;
  const beforeStepIdentities = new Set(
    beforeSteps.map(trajectoryStepIdentity).filter(Boolean)
  );
  const startedAt = Date.now();
  const planModel = resolvePlanModel(modelName);
  let streamEntry = null;
  let unsubscribeStream = null;
  let streamReused = false;
  let streamActive = false;
  let lastStreamText = "";
  let lastPlannerDiagKey = "";
  const emitPreviewFromStep = (responseStep, source) => {
    if (typeof onStreamText !== "function") return;
    if (!streamActive || !responseStep) return;
    const nextText = plannerText(responseStep);
    if (!nextText || nextText === lastStreamText) return;
    lastStreamText = nextText;
    sidecarDiagLog("sidecar planner preview emitted", {
      cascadeId,
      source,
      status: responseStep?.status || "",
      elapsedMs: Date.now() - startedAt,
      textChars: nextText.length,
      thinkingChars: plannerThinking(responseStep).length
    });
    try {
      onStreamText(nextText, {
        source,
        status: responseStep?.status || "",
        elapsedMs: Date.now() - startedAt
      });
    } catch {}
  };

  if (typeof onStreamText === "function") {
    try {
      const acquired = acquireStateStream(cascadeId, {
        timeoutMs,
        idleMs: streamIdleMs
      });
      streamEntry = acquired.entry;
      streamReused = acquired.reused;
      unsubscribeStream = streamEntry.subscribe((event) => {
          if (!streamActive) return;
          const steps = event?.update?.mainTrajectoryUpdate?.stepsUpdate?.steps;
          if (!Array.isArray(steps)) return;
          const responseStep = [...steps]
            .reverse()
            .find(
              (step) =>
                step?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" &&
                plannerText(step) &&
                !beforeStepIdentities.has(trajectoryStepIdentity(step))
            );
          emitPreviewFromStep(responseStep, "stream");
      });
      if (!parallelStreamStart) await streamEntry.ready;
    } catch {
      if (unsubscribeStream) unsubscribeStream();
      unsubscribeStream = null;
      if (streamEntry && !streamEntry.persistent) streamEntry.close("open-failed");
      streamEntry = null;
    }
  }

  try {
    // Activate immediately before submission. A newly opened stream may still
    // replay old state, which is filtered by beforeStepIdentities above.
    streamActive = true;
    await requestJson(
      "SendUserCascadeMessage",
      {
        cascadeId,
        items: [{ text: String(text || "") }],
        blocking: false,
        cascadeConfig: {
          plannerConfig: { planModel }
        }
      },
      { timeoutMs: Math.min(timeoutMs, SIDECAR_REQUEST_TIMEOUT_MS) }
    );
    if (streamEntry) streamEntry.touch();

    const deadline = startedAt + timeoutMs;
    const handledInteractions = new Set();
    const approvedInteractions = [];
    let quietResponseKey = "";
    let quietSince = 0;
    let after = null;

    while (Date.now() < deadline) {
      after = await getCascadeTrajectory(cascadeId);
      const newSteps = getSteps(after).slice(beforeCount);
      const errorStep = [...newSteps]
        .reverse()
        .find((step) => step?.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE");
      if (errorStep) {
        const details =
          errorStep?.errorMessage?.error?.shortError ||
          errorStep?.errorMessage?.error?.modelErrorMessage ||
          "Antigravity sidecar returned an error step.";
        throw new SidecarRequestError(details, {
          method: "SendUserCascadeMessage",
          cascadeId,
          response: after
        });
      }

      const waitingSteps = newSteps.filter(
        (step) => step?.status === "CORTEX_STEP_STATUS_WAITING"
      );
      for (const step of waitingSteps) {
        const info = step?.metadata?.sourceTrajectoryStepInfo || {};
        const key = `${info.trajectoryId || ""}:${info.stepIndex ?? ""}`;
        if (handledInteractions.has(key)) continue;
        if (!autoApprovePermissions) {
          throw new SidecarRequestError("Antigravity is waiting for tool permission.", {
            method: "HandleCascadeUserInteraction",
            cascadeId,
            interactionRequired: true,
            step
          });
        }
        approvedInteractions.push(await approveWaitingInteraction(cascadeId, step));
        handledInteractions.add(key);
      }

      const activeSteps = newSteps.filter(stepIsActive);
      const latestPlannerStep = [...newSteps]
        .reverse()
        .find((step) => step?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE");
      if (latestPlannerStep) {
        const meta = latestPlannerStep?.metadata || {};
        const textLength = plannerText(latestPlannerStep).length;
        const thinkingLength = plannerThinking(latestPlannerStep).length;
        const info = meta.sourceTrajectoryStepInfo || {};
        const diagKey = [
          latestPlannerStep?.status || "",
          info.trajectoryId || "",
          info.stepIndex ?? "",
          textLength,
          thinkingLength,
          activeSteps.length
        ].join(":");
        if (diagKey !== lastPlannerDiagKey) {
          lastPlannerDiagKey = diagKey;
          sidecarDiagLog("sidecar planner poll state", {
            cascadeId,
            elapsedMs: Date.now() - startedAt,
            status: latestPlannerStep?.status || "",
            activeStepCount: activeSteps.length,
            textChars: textLength,
            thinkingChars: thinkingLength,
            createdAt: meta.createdAt || "",
            viewableAt: meta.viewableAt || "",
            finishedGeneratingAt: meta.finishedGeneratingAt || "",
            trajectoryId: info.trajectoryId || "",
            stepIndex: info.stepIndex ?? null
          });
        }
      }
      const responseStep = latestPlannerStep && plannerText(latestPlannerStep)
        ? latestPlannerStep
        : null;
      if (responseStep) {
        emitPreviewFromStep(responseStep, "poll");
      }
      if (responseStep && activeSteps.length === 0) {
        const info = responseStep?.metadata?.sourceTrajectoryStepInfo || {};
        const responseKey = `${info.trajectoryId || ""}:${info.stepIndex ?? ""}:${plannerText(responseStep).length}`;
        if (quietResponseKey === responseKey) {
          if (Date.now() - quietSince >= 350) {
            return {
              text: plannerText(responseStep),
              thinking: plannerThinking(responseStep),
              elapsedMs: Date.now() - startedAt,
              planModel,
              responseStep,
              trajectory: after.trajectory,
              approvedInteractions,
              streamReused,
              streamReadyElapsedMs: streamEntry?.readyAt
                ? Math.max(0, streamEntry.readyAt - startedAt)
                : null,
              streamIdleMs: streamEntry?.persistent ? streamEntry.idleMs : 0
            };
          }
        } else {
          quietResponseKey = responseKey;
          quietSince = Date.now();
        }
      } else {
        quietResponseKey = "";
        quietSince = 0;
      }
      await sleep(TRAJECTORY_POLL_MS);
    }

    throw new SidecarRequestError(`Antigravity sidecar timed out after ${timeoutMs} ms.`, {
      method: "SendUserCascadeMessage",
      cascadeId,
      phase: "wait",
      response: after
    });
  } finally {
    streamActive = false;
    if (unsubscribeStream) unsubscribeStream();
    if (streamEntry && !streamEntry.persistent) streamEntry.close("turn-complete");
  }
}

async function askAntigravitySidecar(prompt, options = {}) {
  const startedAt = Date.now();
  let conversationId = options.conversationId || "";
  let created = false;

  if (!(await cascadeExists(conversationId))) {
    conversationId = await startCascade({ workspaceUris: options.workspaceUris });
    created = true;
  }

  let bootstrapResult = null;
  if (created && options.bootstrapPrompt) {
    try {
      const bootstrapPrompt =
        typeof options.bootstrapPrompt === "function"
          ? await options.bootstrapPrompt()
          : options.bootstrapPrompt;
      bootstrapResult = await sendCascadeMessage(
        conversationId,
        bootstrapPrompt,
        options.modelName,
        { timeoutMs: options.timeoutMs }
      );
      bootstrapResult.promptChars = String(bootstrapPrompt || "").length;
    } catch (error) {
      error.bootstrapMayHaveStarted = true;
      throw error;
    }
  }

  let result;
  try {
    result = await sendCascadeMessage(
      conversationId,
      prompt,
      options.modelName,
      { timeoutMs: options.timeoutMs, onStreamText: options.onReplyPreview }
    );
  } catch (error) {
    error.generationMayHaveStarted = true;
    throw error;
  }

  if (typeof options.onReplyPreview === "function" && result.text) {
    try {
      await options.onReplyPreview(result.text);
    } catch {}
  }

  return {
    ok: true,
    status: "sidecar_ok",
    backend: "sidecar",
    content: result.text,
    thinking: result.thinking,
    conversationId,
    created,
    bootstrapPromptChars: bootstrapResult?.promptChars || 0,
    bootstrapElapsedMs: bootstrapResult?.elapsedMs || 0,
    elapsedMs: Date.now() - startedAt,
    planModel: result.planModel,
    streamReused: Boolean(result.streamReused),
    streamReadyElapsedMs: result.streamReadyElapsedMs,
    streamIdleMs: result.streamIdleMs || 0,
    sidecarPid: discoverSidecar().pid
  };
}

module.exports = {
  SidecarRequestError,
  acquireStateStream,
  askAntigravitySidecar,
  cascadeExists,
  discoverSidecar,
  extractTrajectoryMessages,
  getCascadeTrajectory,
  looksLikeBootstrapUserMessage,
  plannerText,
  plannerThinking,
  requestJson,
  resolvePlanModel,
  sendCascadeMessage,
  startCascade,
  trajectoryStepIdentity,
  userInputText
};
