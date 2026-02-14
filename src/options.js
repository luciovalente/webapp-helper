function setStatus(text, type = "ok") {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = type;
}

function callRuntime(action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, message: err.message });
      else resolve(response || { ok: false, message: "Nessuna risposta." });
    });
  });
}

function toggleTokenField() {
  const provider = document.getElementById("provider").value;
  document.getElementById("tokenWrap").style.display = provider === "openai" ? "flex" : "none";
}

async function loadConfig() {
  const res = await callRuntime("get_ai_config");
  if (!res.ok) {
    setStatus(`Errore caricamento: ${res.message || "sconosciuto"}`, "err");
    return;
  }

  const cfg = res.config;
  document.getElementById("provider").value = cfg.provider || "openai";
  document.getElementById("model").value = cfg.model || "gpt-4o-mini";
  document.getElementById("endpoint").value = cfg.endpoint || "https://api.openai.com/v1/chat/completions";
  toggleTokenField();

  if (cfg.tokenStored) {
    setStatus(cfg.tokenEncrypted ? "Token presente (cifrato)." : "Token presente (non cifrato).", "ok");
  }
}

async function saveConfig() {
  const provider = document.getElementById("provider").value;
  const model = document.getElementById("model").value.trim();
  const endpoint = document.getElementById("endpoint").value.trim();
  const token = document.getElementById("token").value.trim();
  const passphrase = document.getElementById("passphrase").value;

  if (!model || !endpoint) {
    setStatus("Model ed endpoint sono obbligatori.", "err");
    return;
  }

  const res = await callRuntime("save_ai_config", { provider, model, endpoint, token, passphrase });
  if (!res.ok) {
    setStatus(`Errore salvataggio: ${res.message || "sconosciuto"}`, "err");
    return;
  }

  document.getElementById("token").value = "";
  setStatus("Configurazione salvata con successo.", "ok");
}

async function clearToken() {
  const res = await callRuntime("clear_ai_token");
  if (!res.ok) {
    setStatus(`Errore rimozione token: ${res.message || "sconosciuto"}`, "err");
    return;
  }
  setStatus("Token rimosso.", "ok");
}

document.getElementById("provider").addEventListener("change", toggleTokenField);
document.getElementById("btnSave").addEventListener("click", saveConfig);
document.getElementById("btnResetToken").addEventListener("click", clearToken);

loadConfig();
