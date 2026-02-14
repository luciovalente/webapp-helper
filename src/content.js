(() => {
    if (window.__filterHelp) return;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const safeJsonParse = (str) => { try { return JSON.parse(str); } catch { return null; } };

    // --- Helpers DOM ---
    function allRootsDeep() {
        const roots = [document];
        const walk = (root) => {
            const els = root.querySelectorAll ? [...root.querySelectorAll("*")] : [];
            for (const el of els) {
                if (el.shadowRoot && !roots.includes(el.shadowRoot)) {
                    roots.push(el.shadowRoot);
                    walk(el.shadowRoot);
                }
            }
        };
        walk(document);
        return roots;
    }

    // --- Tabulator Discovery (Deep Search) ---
    function findTabulatorInstance(el) {
        // 1. Cerca istanza diretta sull'elemento host
        const candidates = [
            el?.tabulator, el?.Tabulator, el?._tabulator, el?.__tabulator,
            el?.table, el?._table, el?.__table
        ];
        for (const c of candidates) {
            if (c && typeof c.setColumns === "function") return c;
            if (c && c.instance && typeof c.instance.setColumns === "function") return c.instance;
        }

        // 2. Entra nel Shadow DOM (Cruciale per m2c-view-invoice)
        const sr = el.shadowRoot;
        if (!sr) return null;

        // Cerca il DIV interno che contiene la tabella Tabulator
        // Di solito ha classe "tabulator" o "tabulator-tableHolder"
        const tabNodes = sr.querySelectorAll('.tabulator, [class*="tabulator"]');
        
        for (const node of tabNodes) {
            // Tabulator spesso attacca l'istanza JS al nodo DOM stesso
            const props = [node.tabulator, node._tabulator, node.__tabulator, node.table];
            for (const p of props) {
                if (p && typeof p.setColumns === "function") return p;
            }
        }
        
        return null;
    }

    // --- Ricerca Tabelle ---
    function findAllTables() {
        const roots = allRootsDeep();
        const out = [];
        
        // Cerca esplicitamente il tag che mi hai indicato
        const specificTag = "M2C-VIEW-INVOICE"; 
        // Fallback per le vecchie tabelle
        const legacyTag = "B2W-TABLE-V2";

        for (const r of roots) {
            const els = r.querySelectorAll ? r.querySelectorAll("*") : [];
            for (const el of els) {
                const tag = el.tagName.toUpperCase();
                
                // Se è la tabella fatture, PRENDILA SUBITO
                if (tag === specificTag) {
                    out.push(el);
                }
                // Se è la tabella vecchia, prendila solo se ha i dati
                else if (tag === legacyTag || el.getAttribute("payload-columns")) {
                    out.push(el);
                }
            }
        }
        return out;
    }

    function findFirstTable() {
        const tables = findAllTables();
        
        // --- PRIORITÀ ASSOLUTA AL POPUP ---
        // Se c'è una m2c-view-invoice (la tabella fatture), usa quella.
        // Altrimenti usa la tabella della pagina sotto.
        const m2c = tables.find(t => t.tagName === "M2C-VIEW-INVOICE");
        if (m2c) return m2c;

        return tables[0] || null;
    }

    // --- Estrazione Colonne ---
    function getCols(el) {
        // Caso A: Tabella Fatture (m2c) -> Chiedi a Tabulator
        const tab = findTabulatorInstance(el);
        if (tab && typeof tab.getColumnDefinitions === "function") {
            const defs = tab.getColumnDefinitions();
            return defs.map(d => ({
                field: d.field,
                title: d.title || d.label || d.field, 
                visible: d.visible !== false,
                ...d 
            }));
        } 
        // A volte Tabulator usa .getColumns() che ritorna oggetti Column, non definizioni
        else if (tab && typeof tab.getColumns === "function") {
             const cols = tab.getColumns();
             return cols.map(c => ({
                 field: c.getField(),
                 title: c.getDefinition().title,
                 visible: c.isVisible()
             }));
        }

        // Caso B: Tabella Standard (b2w) -> Attributo JSON
        if (el.payloadColumns && Array.isArray(el.payloadColumns)) {
             return JSON.parse(JSON.stringify(el.payloadColumns));
        }
        const attrCols = safeJsonParse(el.getAttribute("payload-columns") || "");
        if (Array.isArray(attrCols)) return attrCols;

        return [];
    }

    // --- Chiave Univoca ---
    function computeKeyStable(el) {
        // Generiamo una chiave specifica per questa tabella fatture
        let uid = el.getAttribute("unique-id") || el.id;
        
        if (!uid) {
            // Usiamo gli attributi che vedo nel tuo HTML
            const acc = el.getAttribute("account-code");
            const crm = el.getAttribute("crm-code");
            if (acc) uid = "invoice_acc_" + acc; // Es: invoice_acc_154995
            else if (crm) uid = "invoice_crm_" + crm;
            else uid = el.tagName.toLowerCase();
        }

        // Includiamo search per differenziare le pagine
        return `view_cfg_v4:${location.pathname}:${uid}`;
    }

    // --- Logica di Applicazione (Scan / Save / Restore) ---

    async function loadSavedOrder(el) {
        const key = computeKeyStable(el);
        const obj = await chrome.storage.local.get(key);
        if (Array.isArray(obj[key]) && obj[key].length) return obj[key];
        return null;
    }

    function buildColumnsToApply(currentCols, savedConfig) {
        const currentMap = new Map(currentCols.map(c => [c?.field, c]));
        const finalCols = [];
        const isNewFormat = savedConfig.length > 0 && typeof savedConfig[0] === 'object';

        if (isNewFormat) {
            for (const item of savedConfig) {
                if (item.visible && currentMap.has(item.field)) {
                    finalCols.push(currentMap.get(item.field));
                    currentMap.delete(item.field);
                } else if (!item.visible) {
                    currentMap.delete(item.field); 
                }
            }
        } else {
            for (const field of savedConfig) {
                if (currentMap.has(field)) {
                    finalCols.push(currentMap.get(field));
                    currentMap.delete(field);
                }
            }
        }
        for (const [_, col] of currentMap.entries()) finalCols.push(col);
        return finalCols;
    }

    async function setColsViaTabulator(el, cols) {
        const tab = findTabulatorInstance(el);
        if (!tab || typeof tab.setColumns !== "function") return false;
        try {
            await tab.setColumns(cols);
            if (typeof tab.redraw === "function") tab.redraw();
            return true;
        } catch (e) { return false; }
    }

    async function setColsViaPayload(el, cols) {
        if (!el.hasAttribute("payload-columns")) return false;
        const json = JSON.stringify(cols);
        if (el.getAttribute("payload-columns") === json) return false;
        el.setAttribute("payload-columns", json);
        if ("payloadColumns" in el) el.payloadColumns = cols;
        return true;
    }

    async function applySavedOrderToTable(el) {
        const savedConfig = await loadSavedOrder(el);
        if (!savedConfig) return { applied: false, reason: "no-saved" };

        const currentCols = getCols(el);
        if (!currentCols.length) return { applied: false, reason: "cols-not-ready" };

        const colsToApply = buildColumnsToApply(currentCols, savedConfig);
        
        // Verifica se l'ordine è già corretto
        const currentFields = currentCols.map(c => c.field);
        const targetFields = colsToApply.map(c => c.field);
        const isIdentical = currentFields.length === targetFields.length && 
                            currentFields.every((val, index) => val === targetFields[index]);

        if (isIdentical) return { applied: false, reason: "already-sorted" };

        if (await setColsViaTabulator(el, colsToApply)) return { applied: true, reason: "tabulator" };
        if (await setColsViaPayload(el, colsToApply)) return { applied: true, reason: "payload" };

        return { applied: false, reason: "failed" };
    }

    // --- Observer ---
    let isRunning = false;
    async function aggressiveReapply() {
        if (isRunning) return;
        isRunning = true;
        for (let i = 0; i < 25; i++) { 
            const tables = findAllTables();
            let anySuccess = false;
            for (const t of tables) {
                try { 
                    const res = await applySavedOrderToTable(t); 
                    if (res.applied) anySuccess = true;
                } catch {}
            }
            await sleep(anySuccess ? 800 : 300);
        }
        isRunning = false;
    }

    function attachObservers() {
        let timeout;
        const mo = new MutationObserver((mutations) => {
            const relevant = mutations.some(m => m.type !== 'attributes' || m.attributeName !== 'payload-columns');
            if (!relevant) return;
            clearTimeout(timeout);
            timeout = setTimeout(aggressiveReapply, 500);
        });

        const observeAll = () => {
            const roots = allRootsDeep();
            for (const r of roots) {
                try { mo.observe(r, { childList: true, subtree: true }); } catch {}
            }
        };
        observeAll();
        setInterval(observeAll, 1500);
        
        window.addEventListener("load", aggressiveReapply);
        const pushState = history.pushState;
        history.pushState = function() { pushState.apply(history, arguments); aggressiveReapply(); };
    }

    attachObservers();
    aggressiveReapply();



    function truncateText(value, max = 220) {
        const text = (value || "").replace(/\s+/g, " ").trim();
        if (!text) return "";
        return text.length > max ? text.slice(0, max) + "…" : text;
    }

    function collectReducedDomSnapshot() {
        const nodes = [...document.querySelectorAll("h1, h2, h3, form, table, [role='table'], button, input, select, textarea, canvas, svg")].slice(0, 120);
        return nodes.map((node) => ({
            tag: node.tagName.toLowerCase(),
            id: node.id || null,
            className: truncateText(node.className || "", 120),
            role: node.getAttribute("role"),
            text: truncateText(node.textContent, 180)
        }));
    }

    function collectTableMetadata() {
        return findAllTables().slice(0, 10).map((table, index) => {
            const cols = getCols(table).slice(0, 40).map((col) => ({
                field: col.field || null,
                label: col.title || col.label || col.field || null,
                visible: col.visible !== false
            }));
            return {
                table_id: table.id || table.getAttribute("unique-id") || `${table.tagName.toLowerCase()}_${index}`,
                tag: table.tagName.toLowerCase(),
                column_count: cols.length,
                columns: cols
            };
        });
    }

    function collectSignificantInlineScripts() {
        const keywords = /(tabulator|table|filter|chart|form|fetch|axios|xhr|api)/i;
        return [...document.querySelectorAll("script:not([src])")].map((s) => s.textContent || "")
            .filter((txt) => txt.length > 30 && keywords.test(txt))
            .slice(0, 8)
            .map((txt) => truncateText(txt, 900));
    }

    function buildPageSnapshot() {
        return {
            page: {
                url: location.href,
                title: document.title,
                pathname: location.pathname
            },
            dom: collectReducedDomSnapshot(),
            table_metadata: collectTableMetadata(),
            significant_inline_scripts: collectSignificantInlineScripts()
        };
    }

    async function requestBackgroundAnalysis(payload) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(payload, (response) => {
                const err = chrome.runtime.lastError;
                if (err) resolve({ ok: false, code: "RUNTIME", message: err.message });
                else resolve(response || { ok: false, code: "NO_RESPONSE", message: "Nessuna risposta dal background." });
            });
        });
    }

    // --- API ESTERNA ---
    window.__filterHelp = {
        async run(action, data) {
            try {
                const table = findFirstTable();
                if (!table) return { ok: false, msg: "Nessuna tabella trovata." };
                
                const key = computeKeyStable(table);
                const currentCols = getCols(table);
                const tabInstance = findTabulatorInstance(table);

                if (action === "scan") {
                    const saved = await loadSavedOrder(table); 
                    const live = currentCols;
                    const isKnown = (Array.isArray(saved) && saved.length > 0);
                    
                    const result = [];
                    const processedFields = new Set();

                    if (isKnown && typeof saved[0] === 'object') {
                        for (const s of saved) {
                            const liveDef = live.find(d => d.field === s.field);
                            result.push({ 
                                field: s.field, 
                                label: liveDef ? (liveDef.title || liveDef.label || liveDef.field) : (s.label || s.field), 
                                visible: s.visible !== false 
                            });
                            processedFields.add(s.field);
                        }
                    } else if (isKnown && typeof saved[0] === 'string') {
                         for (const f of saved) {
                            const def = live.find(d => d.field === f);
                            if (def) {
                                result.push({ field: f, label: def.title || def.label || f, visible: true });
                                processedFields.add(f);
                            }
                         }
                    }

                    for (const def of live) {
                        if (!processedFields.has(def.field)) {
                            result.push({ 
                                field: def.field, 
                                label: def.title || def.label || def.field, 
                                visible: true 
                            });
                        }
                    }
                    
                    return { ok: true, columns: result, isKnown: isKnown, viewKey: key };
                }

                if (action === "save_config") {
                    await chrome.storage.local.set({ [key]: data });
                    await aggressiveReapply();
                    return { ok: true, msg: "Configurazione salvata!" };
                }

                if (action === "debug") {
                    return { 
                        ok: true, 
                        dbg: { 
                            tagName: table.tagName,
                            key: key,
                            hasTabulator: !!tabInstance,
                            colsFound: currentCols.length
                        } 
                    }; 
                }

                if (action === "analyze_page") {
                    const snapshot = buildPageSnapshot();
                    const result = await requestBackgroundAnalysis({
                        action: "analyze_page",
                        snapshot,
                        url: location.href,
                        viewKey: key,
                        forceRefresh: !!data?.forceRefresh
                    });

                    if (!result?.ok) {
                        const humanErrors = {
                            TOKEN_MISSING: "Token OpenAI non configurato. Imposta OPENAI_API_KEY in storage.",
                            QUOTA: "Quota API esaurita o limite richieste raggiunto.",
                            TIMEOUT: "Richiesta scaduta per timeout: riprova tra poco.",
                            SCHEMA_INVALID: "Il modello ha risposto in formato inatteso.",
                            INVALID_RESPONSE: "Risposta del modello non valida.",
                            UNAUTHORIZED: "Token API non valido o revocato."
                        };
                        return {
                            ok: false,
                            msg: humanErrors[result.code] || result.message || "Analisi non disponibile."
                        };
                    }

                    return {
                        ok: true,
                        msg: result.source === "cache" ? "Suggerimenti caricati da cache." : "Suggerimenti generati.",
                        analysis: result.analysis
                    };
                }
                
                if (action === "restore") { await aggressiveReapply(); return { ok: true }; }
                if (action === "invert") { return { ok: true }; } // Usa scan ormai

                return { ok: false, msg: "Comando sconosciuto" };
            } catch (e) {
                return { ok: false, msg: "Errore: " + e.message };
            }
        }
    };
})();
