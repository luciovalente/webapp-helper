const ANALYSIS_SCHEMA_VERSION = "1.0";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const AI_CONFIG_KEY = "AI_RUNTIME_CONFIG_V1";

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

function toBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(passphrase, saltB64) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fromBase64(saltB64),
      iterations: 120000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptSecret(plain, passphrase) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const saltB64 = toBase64(salt);
  const key = await deriveAesKey(passphrase, saltB64);
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return {
    alg: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    salt: saltB64,
    iv: toBase64(iv),
    cipher: toBase64(new Uint8Array(cipherBuffer))
  };
}

async function decryptSecret(payload, passphrase) {
  const key = await deriveAesKey(passphrase, payload.salt);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(payload.iv) },
    key,
    fromBase64(payload.cipher)
  );
  return new TextDecoder().decode(plain);
}

async function getAiConfig() {
  const store = await chrome.storage.local.get(AI_CONFIG_KEY);
  const cfg = store[AI_CONFIG_KEY] || {};
  return {
    provider: cfg.provider || "openai",
    model: cfg.model || DEFAULT_MODEL,
    endpoint: cfg.endpoint || DEFAULT_ENDPOINT,
    timeoutMs: Number(cfg.timeoutMs) || 20000,
    tokenEncrypted: cfg.tokenEncrypted || null,
    tokenPlain: cfg.tokenPlain || ""
  };
}

async function saveAiConfig(payload) {
  const provider = payload?.provider === "proxy" ? "proxy" : "openai";
  const model = (payload?.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const endpoint = (payload?.endpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  const timeoutMs = Math.max(5000, Number(payload?.timeoutMs) || 20000);

  const next = { provider, model, endpoint, timeoutMs, tokenEncrypted: null, tokenPlain: "" };
  const token = (payload?.token || "").trim();
  const passphrase = (payload?.passphrase || "").trim();

  if (provider === "openai" && token) {
    if (passphrase) {
      next.tokenEncrypted = await encryptSecret(token, passphrase);
    } else {
      next.tokenPlain = token;
    }
  }

  await chrome.storage.local.set({ [AI_CONFIG_KEY]: next });
  return { ok: true };
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
    "Analizza uno snapshot minimizzato della pagina web e proponi miglioramenti UX per componenti tabellari.",
    "Rispondi SOLO con JSON valido e senza testo aggiuntivo.",
    "Non assumere accesso al DOM completo: usa solo i metadati ricevuti.",
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
    "Input snapshot minimizzato:",
    JSON.stringify(snapshot)
  ].join("\n\n");
}

async function resolveProviderToken(config, passphrase) {
  if (config.provider !== "openai") return { ok: true, token: "" };
  if (config.tokenPlain) return { ok: true, token: config.tokenPlain };

  if (!config.tokenEncrypted) {
    return { ok: false, code: "CONFIG_MISSING", message: "Configurazione AI incompleta: token mancante nelle opzioni." };
  }
  if (!passphrase) {
    return { ok: false, code: "PASSPHRASE_REQUIRED", message: "Token cifrato presente: inserisci la passphrase nelle opzioni per usarlo." };
  }

  try {
    const token = await decryptSecret(config.tokenEncrypted, passphrase);
    return { ok: true, token };
  } catch {
    return { ok: false, code: "PASSPHRASE_INVALID", message: "Passphrase non valida per decifrare il token." };
  }
}

async function runOpenAiAnalysis(snapshot, llmConfig) {
  const endpoint = llmConfig.endpoint || DEFAULT_ENDPOINT;
  const model = llmConfig.model || DEFAULT_MODEL;

  if (!endpoint) {
    return { ok: false, code: "CONFIG_MISSING", message: "Configurazione AI incompleta: endpoint non configurato." };
  }

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
      const headers = { "Content-Type": "application/json" };
      if (llmConfig.provider === "openai") headers.Authorization = `Bearer ${llmConfig.apiKey}`;

      const res = await timeoutFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      }, llmConfig.timeoutMs || 20000);

      if (res.status === 401) return { ok: false, code: "UNAUTHORIZED", message: "Credenziali non valide o scadute." };
      if (res.status === 429) return { ok: false, code: "QUOTA", message: "Quota API esaurita o rate limit raggiunto." };
      if (!res.ok) {
        if (attempt < retries && res.status >= 500) continue;
        return { ok: false, code: "HTTP_ERROR", message: `Errore API (${res.status}).` };
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      const rawJson = extractJsonBlock(content);
      if (!rawJson) return { ok: false, code: "INVALID_RESPONSE", message: "Risposta LLM non contiene JSON valido." };

      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        return { ok: false, code: "INVALID_RESPONSE", message: "Impossibile interpretare il JSON della risposta." };
      }

      const schemaCheck = validateResponseSchema(parsed);
      if (!schemaCheck.ok) return { ok: false, code: "SCHEMA_INVALID", message: `Schema risposta non valido: ${schemaCheck.msg}` };

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
  const { snapshot, url, viewKey, forceRefresh, passphrase } = message;
  if (!snapshot || !isObject(snapshot)) return { ok: false, code: "INVALID_INPUT", message: "Snapshot pagina mancante o non valido." };

  const aiConfig = await getAiConfig();
  if (!aiConfig.endpoint || !aiConfig.model) {
    return { ok: false, code: "CONFIG_MISSING", message: "Configurazione AI mancante: apri Opzioni e imposta provider/modello/endpoint." };
  }

  const auth = await resolveProviderToken(aiConfig, passphrase);
  if (!auth.ok && aiConfig.provider === "openai") return auth;

  const cacheKey = buildStorageKey(url, viewKey);
  if (!forceRefresh) {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached?.[cacheKey]) return { ok: true, source: "cache", analysis: cached[cacheKey] };
  }

  const llmResult = await runOpenAiAnalysis(snapshot, {
    provider: aiConfig.provider,
    apiKey: auth.token,
    endpoint: aiConfig.endpoint,
    model: aiConfig.model,
    timeoutMs: aiConfig.timeoutMs
  });

  if (!llmResult.ok) return llmResult;

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
  if (!message || !message.action) return undefined;

  if (message.action === "analyze_page") {
    handleAnalyzePage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, code: "UNEXPECTED", message: error?.message || "Errore inatteso." }));
    return true;
  }

  if (message.action === "get_ai_config") {
    getAiConfig().then((cfg) => {
      sendResponse({
        ok: true,
        config: {
          provider: cfg.provider,
          model: cfg.model,
          endpoint: cfg.endpoint,
          timeoutMs: cfg.timeoutMs,
          tokenStored: !!(cfg.tokenPlain || cfg.tokenEncrypted),
          tokenEncrypted: !!cfg.tokenEncrypted
        }
      });
    }).catch((error) => sendResponse({ ok: false, message: error?.message || "Errore lettura configurazione." }));
    return true;
  }

  if (message.action === "save_ai_config") {
    saveAiConfig(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: error?.message || "Errore salvataggio configurazione." }));
    return true;
  }

  if (message.action === "clear_ai_token") {
    getAiConfig().then(async (cfg) => {
      await chrome.storage.local.set({
        [AI_CONFIG_KEY]: {
          provider: cfg.provider,
          model: cfg.model,
          endpoint: cfg.endpoint,
          timeoutMs: cfg.timeoutMs,
          tokenEncrypted: null,
          tokenPlain: ""
        }
      });
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, message: error?.message || "Errore rimozione token." }));
    return true;
  }

  return undefined;
});
