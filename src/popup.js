async function getActiveTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Tab attiva non trovata");
    return tab.id;
}

async function ensureContentInjected(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ["content.js"]
        });
    } catch (e) {}
}

async function callAction(action, data = {}) {
    const tabId = await getActiveTabId();
    await ensureContentInjected(tabId);

    const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: async (actionName, actionData) => {
            if (!window.__filterHelp) return { ok: false, msg: "Script non caricato." };
            return await window.__filterHelp.run(actionName, actionData);
        },
        args: [action, data]
    });

    const valid = results.find(r => r.result && r.result.ok);
    return valid ? valid.result : (results[0]?.result || { ok: false, msg: "Nessuna risposta valida." });
}

function setOut(text) {
    const el = document.getElementById("out");
    el.textContent = text;
    if (text.startsWith("OK")) setTimeout(() => el.textContent = "", 3000);
}

let currentColumns = [];
let scanTables = [];
let selectedTableId = null;

function getSelectedTable() {
    return scanTables.find((t) => t.tableId === selectedTableId) || scanTables[0] || null;
}

function renderTableSelector() {
    const container = document.getElementById("tableSelectorWrap");
    const select = document.getElementById("tableSelector");

    if (!scanTables.length) {
        container.style.display = "none";
        select.innerHTML = "";
        return;
    }

    container.style.display = "block";
    select.innerHTML = "";

    scanTables.forEach((table, idx) => {
        const opt = document.createElement("option");
        opt.value = table.tableId;
        opt.textContent = `${idx + 1}. ${table.label}`;
        select.appendChild(opt);
    });

    if (!selectedTableId || !scanTables.some((t) => t.tableId === selectedTableId)) {
        selectedTableId = scanTables[0].tableId;
    }
    select.value = selectedTableId;
}

function renderScanner(columns, isKnown) {
    const container = document.getElementById("scannerContainer");
    const list = document.getElementById("colList");
    const btnSave = document.getElementById("btnApplyScan");
    const statusDiv = document.getElementById("viewStatus");

    container.style.display = "block";
    list.innerHTML = "";

    statusDiv.style.display = "block";
    if (isKnown) {
        statusDiv.textContent = "Vista Salvata (Modalità Modifica)";
        statusDiv.className = "status-known";
        btnSave.textContent = "Aggiorna Configurazione";
    } else {
        statusDiv.textContent = "Nuova Vista Rilevata";
        statusDiv.className = "status-new";
        btnSave.textContent = "Salva Nuova Vista";
    }

    columns.forEach((col, index) => {
        const row = document.createElement("div");
        row.className = "col-item" + (col.visible ? "" : " hidden-col");

        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.className = "col-check";
        chk.checked = col.visible;
        chk.onchange = () => {
            col.visible = chk.checked;
            renderScanner(currentColumns, isKnown);
        };

        const lbl = document.createElement("div");
        lbl.className = "col-label";
        lbl.textContent = col.label || col.field;
        lbl.title = col.field;

        const btns = document.createElement("div");
        btns.className = "move-btns";

        const btnUp = document.createElement("div");
        btnUp.className = "move-btn";
        btnUp.textContent = "▲";
        btnUp.onclick = () => moveCol(index, -1, isKnown);

        const btnDown = document.createElement("div");
        btnDown.className = "move-btn";
        btnDown.textContent = "▼";
        btnDown.onclick = () => moveCol(index, 1, isKnown);

        btns.append(btnUp, btnDown);
        row.append(chk, lbl, btns);
        list.appendChild(row);
    });

    btnSave.style.display = "block";
}

function moveCol(index, dir, isKnown) {
    if (dir === -1 && index === 0) return;
    if (dir === 1 && index === currentColumns.length - 1) return;

    const item = currentColumns.splice(index, 1)[0];
    currentColumns.splice(index + dir, 0, item);
    renderScanner(currentColumns, isKnown);
}

document.getElementById("tableSelector").addEventListener("change", (e) => {
    selectedTableId = e.target.value;
    const selected = getSelectedTable();
    if (!selected) return;

    currentColumns = selected.columns.map((c) => ({ ...c }));
    renderScanner(currentColumns, selected.isKnown);
});

// --- BUTTON EVENTS ---

document.getElementById("btnScan").addEventListener("click", async () => {
    setOut("Analisi vista in corso...");
    try {
        const res = await callAction("scan");
        if (res.ok) {
            scanTables = Array.isArray(res.tables) ? res.tables : [];
            if (!scanTables.length) {
                setOut("ERRORE: Nessuna tabella utile trovata.");
                return;
            }

            selectedTableId = scanTables[0].tableId;
            renderTableSelector();

            const selected = getSelectedTable();
            currentColumns = selected.columns.map((c) => ({ ...c }));
            renderScanner(currentColumns, selected.isKnown);
            setOut("");
        } else {
            setOut("ERRORE: " + res.msg);
        }
    } catch (e) { setOut("ERRORE: " + e.message); }
});

document.getElementById("btnApplyScan").addEventListener("click", async () => {
    const selected = getSelectedTable();
    if (!selected) {
        setOut("ERRORE: Nessuna tabella selezionata.");
        return;
    }

    setOut("Salvataggio...");
    const payload = currentColumns.map(c => ({
        field: c.field,
        visible: c.visible,
        label: c.label
    }));

    try {
        const res = await callAction("save_config", {
            tableId: selected.tableId,
            columns: payload
        });
        if (res.ok) setOut("OK: Vista salvata e applicata!");
        else setOut("ERRORE: " + res.msg);
    } catch (e) { setOut("ERRORE: " + e.message); }
});

function wireLegacy(btnId, action) {
    document.getElementById(btnId).addEventListener("click", async () => {
        setOut("Eseguo " + action + "...");
        try {
            const r = await callAction(action);
            if (r.ok && action === "debug") setOut(JSON.stringify(r.dbg, null, 2));
            else setOut((r.ok ? "OK: " : "ERRORE: ") + r.msg);
        } catch (e) { setOut("ERRORE: " + e.message); }
    });
}

wireLegacy("btnInvert", "invert");
wireLegacy("btnRestore", "restore");
wireLegacy("btnDebug", "debug");
