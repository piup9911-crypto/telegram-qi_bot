function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildUrl(baseUrl, wireApi) {
  if (/\/(chat\/completions|responses)$/i.test(baseUrl)) return baseUrl;
  if (wireApi === "responses") return `${baseUrl}/responses`;
  return `${baseUrl}/chat/completions`;
}

function extractChatCompletionText(payload) {
  return String(payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content || "").trim();
}

function extractResponsesText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (typeof content.text === "string") parts.push(content.text);
      if (typeof content.output_text === "string") parts.push(content.output_text);
    }
  }
  return parts.join("\n").trim();
}

function providerConfigFromEnv(env = process.env) {
  const baseUrl = cleanBaseUrl(env.RP_MODEL_BASE_URL);
  const apiKey = String(env.RP_MODEL_API_KEY || "").trim();
  const model = String(env.RP_MODEL_NAME || "").trim();
  const wireApi = String(env.RP_MODEL_WIRE_API || "chat_completions").trim() === "responses"
    ? "responses"
    : "chat_completions";
  return {
    configured: Boolean(baseUrl && apiKey && model),
    baseUrl,
    apiKey,
    model,
    wireApi
  };
}

async function callOpenAiCompatible(input, env = process.env) {
  const config = providerConfigFromEnv(env);
  if (!config.configured) {
    return {
      configured: false,
      reply: "",
      raw: null,
      debug: {
        configured: false,
        reason: "RP_MODEL_BASE_URL, RP_MODEL_API_KEY, or RP_MODEL_NAME is missing."
      }
    };
  }

  const url = buildUrl(config.baseUrl, config.wireApi);
  const body = config.wireApi === "responses"
    ? {
        model: config.model,
        input: input.prompt,
        temperature: input.temperature,
        top_p: input.top_p,
        max_output_tokens: input.max_tokens
      }
    : {
        model: config.model,
        messages: [{ role: "user", content: input.prompt }],
        temperature: input.temperature,
        top_p: input.top_p,
        frequency_penalty: input.frequency_penalty,
        presence_penalty: input.presence_penalty,
        max_tokens: input.max_tokens,
        stop: input.stop_strings && input.stop_strings.length ? input.stop_strings : undefined
      };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = { text };
  }
  if (!response.ok) {
    const message = raw && raw.error && raw.error.message ? raw.error.message : text.slice(0, 500);
    const error = new Error(`Provider request failed: ${response.status} ${message}`);
    error.status = response.status;
    error.raw = raw;
    throw error;
  }

  const reply = config.wireApi === "responses"
    ? extractResponsesText(raw)
    : extractChatCompletionText(raw);
  if (!reply) {
    const error = new Error("Provider returned an empty reply.");
    error.raw = raw;
    throw error;
  }
  return {
    configured: true,
    reply,
    raw,
    debug: {
      configured: true,
      url,
      model: config.model,
      wireApi: config.wireApi
    }
  };
}

module.exports = {
  callOpenAiCompatible,
  providerConfigFromEnv
};
