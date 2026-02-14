const ANALYSIS_SCHEMA_VERSION = "1.0";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";

function buildStorageKey(url, viewKey) {
  const u = (url || "").replace(/[#?].*$/, "");
  const v = viewKey || "default-view";
  return `analysis_cache:${u}:${v}`;
}

function timeoutFetch(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateResponseSchema(payload) {
  if (!isObject(payload)) return { ok: false, msg: "Risposta non oggetto JSON." };

  const requiredArrays = ["detected_components", "recommended_actions", "table_configs"];
  for (const key of requiredArrays) {
    if (!Array.isArray(payload[key])) return { ok: false, msg: `Campo mancante o non valido: ${key}` };
  }

  for (const comp of payload.detected_components) {
    if (!isObject(comp) || typeof comp.type !== "string") {
      return { ok: false, msg: "detected_components contiene elementi non validi." };
    }
  }

  for (const table of payload.table_configs) {
    if (!isObject(table) || typeof table.table_id !== "string" || !Array.isArray(table.columns)) {
      return { ok: false, msg: "table_configs non rispetta il contratto." };
    }
    if (table.possible_actions && !Array.isArray(table.possible_actions)) {
      return { ok: false, msg: "possible_actions deve essere un array." };
    }
  }

  return { ok: true };
}

function extractJsonBlock(text) {
  if (!text || typeof text !== "string") return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

function createPrompt(snapshot) {
  return [
    "Analizza lo snapshot ridotto di una pagina web e proponi miglioramenti UX sui componenti tabellari.",
    "Rispondi SOLO con JSON valido e senza testo aggiuntivo.",
    "Schema obbligatorio:",
    JSON.stringify({
      schema_version: ANALYSIS_SCHEMA_VERSION,
      detected_components: [
        { type: "table|form|chart", id: "string", confidence: "0-1", notes: "string" }
      ],
      recommended_actions: [
        { action: "string", reason: "string", priority: "low|medium|high" }
      ],
      table_configs: [
        {
          table_id: "string",
          columns: [{ name: "string", data_type: "string", suggested_visibility: "show|hide" }],
          possible_actions: ["hide", "reorder", "filter"]
        }
      ]
    }, null, 2),
    "Input snapshot:",
    JSON.stringify(snapshot)
  ].join("\n\n");
}

async function runOpenAiAnalysis(snapshot, llmConfig) {
  const apiKey = llmConfig.apiKey;
  if (!apiKey) {
    return { ok: false, code: "TOKEN_MISSING", message: "Token API non configurato. Salvalo in chrome.storage.local come OPENAI_API_KEY." };
  }

  const endpoint = llmConfig.endpoint || DEFAULT_ENDPOINT;
  const model = llmConfig.model || DEFAULT_MODEL;

  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Sei un assistente che produce solo JSON valido." },
      { role: "user", content: createPrompt(snapshot) }
    ]
  };

  const retries = 2;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await timeoutFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      }, llmConfig.timeoutMs || 20000);

      if (res.status === 401) {
        return { ok: false, code: "UNAUTHORIZED", message: "Token API non valido o scaduto." };
      }
      if (res.status === 429) {
        return { ok: false, code: "QUOTA", message: "Quota API esaurita o rate limit raggiunto." };
      }
      if (!res.ok) {
        if (attempt < retries && res.status >= 500) continue;
        return { ok: false, code: "HTTP_ERROR", message: `Errore API (${res.status}).` };
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      const rawJson = extractJsonBlock(content);
      if (!rawJson) {
        return { ok: false, code: "INVALID_RESPONSE", message: "Risposta LLM non contiene JSON valido." };
      }

      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        return { ok: false, code: "INVALID_RESPONSE", message: "Impossibile interpretare il JSON della risposta." };
      }

      const schemaCheck = validateResponseSchema(parsed);
      if (!schemaCheck.ok) {
        return { ok: false, code: "SCHEMA_INVALID", message: `Schema risposta non valido: ${schemaCheck.msg}` };
      }

      return { ok: true, payload: parsed };
    } catch (error) {
      const isTimeout = error?.name === "AbortError";
      if (attempt < retries) continue;
      return {
        ok: false,
        code: isTimeout ? "TIMEOUT" : "NETWORK",
        message: isTimeout ? "Timeout nella chiamata al modello." : "Errore di rete durante la chiamata API."
      };
    }
  }

  return { ok: false, code: "UNKNOWN", message: "Errore sconosciuto." };
}

async function handleAnalyzePage(message) {
  const { snapshot, url, viewKey, forceRefresh } = message;
  if (!snapshot || !isObject(snapshot)) {
    return { ok: false, code: "INVALID_INPUT", message: "Snapshot pagina mancante o non valido." };
  }

  const cacheKey = buildStorageKey(url, viewKey);
  if (!forceRefresh) {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached?.[cacheKey]) {
      return { ok: true, source: "cache", analysis: cached[cacheKey] };
    }
  }

  const configStore = await chrome.storage.local.get([
    "OPENAI_API_KEY",
    "LLM_ENDPOINT",
    "LLM_MODEL",
    "LLM_TIMEOUT_MS"
  ]);

  const llmResult = await runOpenAiAnalysis(snapshot, {
    apiKey: configStore.OPENAI_API_KEY,
    endpoint: configStore.LLM_ENDPOINT,
    model: configStore.LLM_MODEL,
    timeoutMs: Number(configStore.LLM_TIMEOUT_MS) || 20000
  });

  if (!llmResult.ok) {
    return llmResult;
  }

  const analysis = {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    url,
    viewKey,
    ...llmResult.payload
  };

  await chrome.storage.local.set({ [cacheKey]: analysis });
  return { ok: true, source: "llm", analysis };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.action !== "analyze_page") return undefined;

  handleAnalyzePage(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, code: "UNEXPECTED", message: error?.message || "Errore inatteso." }));

  return true;
});
