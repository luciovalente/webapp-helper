(() => {
    if (window.__filterHelp) return;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const safeJsonParse = (str) => { try { return JSON.parse(str); } catch { return null; } };

    function truncateText(value, max = 220) {
        const text = (value || "").replace(/\s+/g, " ").trim();
        if (!text) return "";
        return text.length > max ? text.slice(0, max) + "…" : text;
    }

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

    function getRootNodeLabel(el) {
        if (!el) return "unknown";
        const tag = (el.tagName || "unknown").toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        return `${tag}${id}`;
    }

    function buildDomPath(el) {
        if (!el || el.nodeType !== 1) return "";
        const segments = [];
        let node = el;

        while (node && node.nodeType === 1) {
            const tag = node.tagName.toLowerCase();
            const parent = node.parentElement;
            let nth = 1;

            if (parent) {
                const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
                nth = siblings.indexOf(node) + 1;
            }

            segments.unshift(`${tag}:nth-of-type(${nth})`);
            const root = node.getRootNode && node.getRootNode();

            if (root && root instanceof ShadowRoot) {
                const host = root.host;
                segments.unshift(`shadow-host(${getRootNodeLabel(host)})`);
                node = host;
                continue;
            }

            node = parent;
        }

        return segments.join(" > ");
    }

    function getNearbyHeading(el) {
        if (!el) return "";
        const container = el.closest && el.closest("section, article, main, div, form");
        if (container) {
            const heading = container.querySelector("h1, h2, h3, h4, h5, h6, [role='heading'], caption");
            if (heading) return truncateText(heading.textContent || "", 80);
        }

        const ownHeading = el.querySelector && el.querySelector("caption, h1, h2, h3, [role='heading']");
        if (ownHeading) return truncateText(ownHeading.textContent || "", 80);

        return "";
    }

    // --- Tabulator Discovery (Deep Search) ---
    function findTabulatorInstance(el) {
        const candidates = [
            el?.tabulator, el?.Tabulator, el?._tabulator, el?.__tabulator,
            el?.table, el?._table, el?.__table
        ];
        for (const c of candidates) {
            if (c && typeof c.setColumns === "function") return c;
            if (c && c.instance && typeof c.instance.setColumns === "function") return c.instance;
        }

        const sr = el.shadowRoot;
        if (!sr) return null;

        const tabNodes = sr.querySelectorAll('.tabulator, [class*="tabulator"]');
        for (const node of tabNodes) {
            const props = [node.tabulator, node._tabulator, node.__tabulator, node.table];
            for (const p of props) {
                if (p && typeof p.setColumns === "function") return p;
            }
        }

        return null;
    }

    function createTableDescriptor(el, strategy, index) {
        const heading = getNearbyHeading(el) || "no-heading";
        const domPath = buildDomPath(el);
        const tag = (el.tagName || "unknown").toLowerCase();
        const tableId = `${domPath}|${heading}|${index}`;

        return {
            el,
            strategy,
            index,
            tableId,
            label: `${heading} · ${tag} [${strategy}]`
        };
    }

    // --- Ricerca Tabelle ---
    function findAllTables() {
        const roots = allRootsDeep();
        const unique = new Set();
        const hits = [];

        const levels = [
            { strategy: "web-component", selector: "m2c-view-invoice, b2w-table-v2, [payload-columns]" },
            { strategy: "native-table", selector: "table" },
            { strategy: "aria-grid", selector: "[role='grid'], [role='table']" },
            { strategy: "library-grid", selector: ".tabulator, .ag-root, .dataTables_wrapper, .MuiDataGrid-root, .handsontable" }
        ];

        for (const level of levels) {
            for (const r of roots) {
                const els = r.querySelectorAll ? r.querySelectorAll(level.selector) : [];
                for (const el of els) {
                    if (unique.has(el)) continue;
                    unique.add(el);
                    hits.push({ el, strategy: level.strategy });
                }
            }
        }

        return hits.map((entry, idx) => createTableDescriptor(entry.el, entry.strategy, idx));
    }

    // --- Estrazione Colonne ---
    function getCols(el) {
        const tab = findTabulatorInstance(el);
        if (tab && typeof tab.getColumnDefinitions === "function") {
            const defs = tab.getColumnDefinitions();
            return defs.map(d => ({
                field: d.field,
                title: d.title || d.label || d.field,
                visible: d.visible !== false,
                ...d
            }));
        } else if (tab && typeof tab.getColumns === "function") {
            const cols = tab.getColumns();
            return cols.map(c => ({
                field: c.getField(),
                title: c.getDefinition().title,
                visible: c.isVisible()
            }));
        }

        if (el.payloadColumns && Array.isArray(el.payloadColumns)) {
            return JSON.parse(JSON.stringify(el.payloadColumns));
        }
        const attrCols = safeJsonParse(el.getAttribute("payload-columns") || "");
        if (Array.isArray(attrCols)) return attrCols;

        const nativeHeaders = el.querySelectorAll ? [...el.querySelectorAll("thead th, th, [role='columnheader']")] : [];
        if (nativeHeaders.length) {
            return nativeHeaders.map((th, idx) => {
                const text = truncateText(th.textContent || "", 120) || `column_${idx + 1}`;
                return {
                    field: th.getAttribute("data-field") || `column_${idx + 1}`,
                    title: text,
                    visible: true
                };
            });
        }

        return [];
    }

    // --- Chiave Univoca ---
    function computeKeyStable(el) {
        let uid = el.getAttribute("unique-id") || el.id;

        if (!uid) {
            const acc = el.getAttribute("account-code");
            const crm = el.getAttribute("crm-code");
            if (acc) uid = "invoice_acc_" + acc;
            else if (crm) uid = "invoice_crm_" + crm;
            else uid = el.tagName.toLowerCase();
        }

        return `view_cfg_v4:${location.pathname}:${uid}`;
    }

    // --- Logica di Applicazione (Scan / Save / Restore) ---

    async function loadSavedOrder(el) {
        const key = computeKeyStable(el);
        const obj = await chrome.storage.local.get(key);
        if (Array.isArray(obj[key]) && obj[key].length) return obj[key];
        return null;
    }

    async function loadSavedOrderByTableId(tableId, el) {
        const keyV5 = `view_cfg_v5:${location.pathname}:${tableId}`;
        const objV5 = await chrome.storage.local.get(keyV5);
        if (Array.isArray(objV5[keyV5]) && objV5[keyV5].length) {
            return { key: keyV5, saved: objV5[keyV5] };
        }

        const legacySaved = await loadSavedOrder(el);
        if (legacySaved?.length) {
            return { key: computeKeyStable(el), saved: legacySaved };
        }

        return { key: keyV5, saved: null };
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

    async function applySavedOrderToTable(descriptor) {
        const { saved } = await loadSavedOrderByTableId(descriptor.tableId, descriptor.el);
        if (!saved) return { applied: false, reason: "no-saved" };

        const currentCols = getCols(descriptor.el);
        if (!currentCols.length) return { applied: false, reason: "cols-not-ready" };

        const colsToApply = buildColumnsToApply(currentCols, saved);

        const currentFields = currentCols.map(c => c.field);
        const targetFields = colsToApply.map(c => c.field);
        const isIdentical = currentFields.length === targetFields.length &&
                            currentFields.every((val, index) => val === targetFields[index]);

        if (isIdentical) return { applied: false, reason: "already-sorted" };

        if (await setColsViaTabulator(descriptor.el, colsToApply)) return { applied: true, reason: "tabulator" };
        if (await setColsViaPayload(descriptor.el, colsToApply)) return { applied: true, reason: "payload" };

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
            for (const table of tables) {
                try {
                    const res = await applySavedOrderToTable(table);
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
        return findAllTables().slice(0, 10).map((table) => {
            const cols = getCols(table.el).slice(0, 40).map((col) => ({
                field: col.field || null,
                label: col.title || col.label || col.field || null,
                visible: col.visible !== false
            }));
            return {
                table_id: table.tableId,
                tag: table.el.tagName.toLowerCase(),
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
                const tables = findAllTables();
                if (!tables.length) return { ok: false, msg: "Nessuna tabella trovata." };

                if (action === "scan") {
                    const list = [];

                    for (const table of tables) {
                        const live = getCols(table.el);
                        const { key, saved } = await loadSavedOrderByTableId(table.tableId, table.el);
                        const isKnown = Array.isArray(saved) && saved.length > 0;

                        const ordered = [];
                        const processedFields = new Set();

                        if (isKnown && typeof saved[0] === 'object') {
                            for (const s of saved) {
                                const liveDef = live.find(d => d.field === s.field);
                                ordered.push({
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
                                    ordered.push({ field: f, label: def.title || def.label || f, visible: true });
                                    processedFields.add(f);
                                }
                            }
                        }

                        for (const def of live) {
                            if (!processedFields.has(def.field)) {
                                ordered.push({
                                    field: def.field,
                                    label: def.title || def.label || def.field,
                                    visible: true
                                });
                            }
                        }

                        list.push({
                            tableId: table.tableId,
                            label: table.label,
                            columns: ordered,
                            capabilities: {
                                tabulator: !!findTabulatorInstance(table.el),
                                payload: table.el.hasAttribute && table.el.hasAttribute("payload-columns"),
                                reorder: ordered.length > 0
                            },
                            isKnown,
                            viewKey: key
                        });
                    }

                    return {
                        ok: true,
                        tables: list,
                        count: list.length,
                        columns: list[0]?.columns || [],
                        isKnown: list[0]?.isKnown || false,
                        viewKey: list[0]?.viewKey || null
                    };
                }

                if (action === "save_config") {
                    if (!data?.tableId || !Array.isArray(data?.columns)) {
                        return { ok: false, msg: "Parametro tableId/columns mancante." };
                    }
                    const key = `view_cfg_v5:${location.pathname}:${data.tableId}`;
                    await chrome.storage.local.set({ [key]: data.columns });
                    await aggressiveReapply();
                    return { ok: true, msg: "Configurazione salvata!" };
                }

                if (action === "debug") {
                    const firstTable = tables[0];
                    const currentCols = getCols(firstTable.el);
                    const tabInstance = findTabulatorInstance(firstTable.el);

                    return {
                        ok: true,
                        dbg: {
                            tagName: firstTable.el.tagName,
                            key: computeKeyStable(firstTable.el),
                            tableId: firstTable.tableId,
                            tablesFound: tables.length,
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
                        viewKey: computeKeyStable(tables[0].el),
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
                if (action === "invert") { return { ok: true }; }

                return { ok: false, msg: "Comando sconosciuto" };
            } catch (e) {
                return { ok: false, msg: "Errore: " + e.message };
            }
        }
    };
})();
