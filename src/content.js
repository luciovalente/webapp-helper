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

    function rowCells(row) {
        return row ? [...row.children].filter((cell) => cell.matches("th, td")) : [];
    }

    async function setColsViaNativeTable(el, cols) {
        if (!el || el.tagName !== "TABLE") return false;

        const currentCols = getCols(el);
        if (!currentCols.length) return false;

        const indexByField = new Map(currentCols.map((col, idx) => [col.field, idx]));
        const orderedIndexes = [];
        const visibleIndexes = new Set();

        for (const col of cols) {
            const idx = indexByField.get(col?.field);
            if (idx === undefined) continue;
            orderedIndexes.push(idx);
            if (col.visible !== false) visibleIndexes.add(idx);
        }

        if (!orderedIndexes.length) return false;

        const rows = [...el.querySelectorAll("tr")];
        for (const row of rows) {
            const cells = rowCells(row);
            if (!cells.length) continue;

            const movable = orderedIndexes
                .map((idx) => cells[idx])
                .filter(Boolean);

            if (!movable.length) continue;

            for (const cell of movable) row.appendChild(cell);

            const updatedCells = rowCells(row);
            for (let i = 0; i < updatedCells.length; i++) {
                const cell = updatedCells[i];
                const sourceColIdx = orderedIndexes[i];
                const shouldBeVisible = sourceColIdx === undefined ? true : visibleIndexes.has(sourceColIdx);
                cell.style.display = shouldBeVisible ? "" : "none";
                if (shouldBeVisible) cell.removeAttribute("aria-hidden");
                else cell.setAttribute("aria-hidden", "true");
            }
        }

        return true;
    }

    async function applyColumnsToTable(descriptor, columns) {
        if (!Array.isArray(columns) || !columns.length) return { ok: false, msg: "Nessuna colonna da applicare." };
        if (await setColsViaTabulator(descriptor.el, columns)) return { ok: true, mode: "tabulator" };
        if (await setColsViaPayload(descriptor.el, columns)) return { ok: true, mode: "payload" };
        if (await setColsViaNativeTable(descriptor.el, columns)) return { ok: true, mode: "native-table" };
        return { ok: false, msg: "Tabella non modificabile in runtime." };
    }

    function buildSuggestionPreview(descriptor, suggestion = {}) {
        const currentCols = getCols(descriptor.el);
        if (!currentCols.length) return { ok: false, msg: "Colonne non disponibili." };

        const kind = suggestion.kind;
        if (kind === "hide_non_essential") {
            const fieldsToHide = new Set(Array.isArray(suggestion.fieldsToHide) ? suggestion.fieldsToHide : []);
            const columns = currentCols.map((col) => ({
                ...col,
                visible: !fieldsToHide.has(col.field)
            }));
            return { ok: true, kind, columns, irreversible: true };
        }

        if (kind === "reorder_columns") {
            const orderedFields = Array.isArray(suggestion.orderedFields) ? suggestion.orderedFields : [];
            const fieldMap = new Map(currentCols.map((col) => [col.field, col]));
            const used = new Set();
            const reordered = [];

            for (const field of orderedFields) {
                if (fieldMap.has(field)) {
                    reordered.push(fieldMap.get(field));
                    used.add(field);
                }
            }
            for (const col of currentCols) {
                if (!used.has(col.field)) reordered.push(col);
            }
            return { ok: true, kind, columns: reordered, irreversible: true };
        }

        if (kind === "highlight_column") {
            return {
                ok: true,
                kind,
                columns: currentCols,
                irreversible: false,
                msg: "Suggerimento informativo: nessuna modifica persistente da applicare."
            };
        }

        return { ok: false, msg: "Tipo suggerimento non supportato." };
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
        if (await setColsViaNativeTable(descriptor.el, colsToApply)) return { applied: true, reason: "native-table" };

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
        const headings = [...document.querySelectorAll("h1, h2, h3, [role='heading'], caption")]
            .slice(0, 30)
            .map((node) => truncateText(node.textContent, 90))
            .filter(Boolean);

        return {
            heading_count: headings.length,
            headings,
            forms_count: document.querySelectorAll("form").length,
            buttons_count: document.querySelectorAll("button").length,
            input_count: document.querySelectorAll("input, select, textarea").length
        };
    }

    function inferColumnType(col) {
        const source = `${col.field || ""} ${col.title || ""} ${col.label || ""}`.toLowerCase();
        if (/date|time|giorno|mese|anno/.test(source)) return "date";
        if (/qty|amount|tot|price|importo|numero|count|id/.test(source)) return "number";
        if (/mail|email/.test(source)) return "email";
        if (/status|state|stato/.test(source)) return "status";
        return "string";
    }

    function collectTableMetadata() {
        return findAllTables().slice(0, 10).map((table) => {
            const cols = getCols(table.el).slice(0, 40).map((col) => ({
                field: col.field || null,
                header: col.title || col.label || col.field || null,
                visible: col.visible !== false,
                inferred_type: inferColumnType(col)
            }));
            return {
                table_id: table.tableId,
                tag: table.el.tagName.toLowerCase(),
                column_count: cols.length,
                columns: cols
            };
        });
    }

    function buildPageSnapshot() {
        return {
            page: {
                origin: location.origin,
                pathname: location.pathname,
                title: truncateText(document.title, 120)
            },
            dom_summary: collectReducedDomSnapshot(),
            table_metadata: collectTableMetadata(),
            policy: {
                minimized: true,
                excluded: ["full_html", "inline_scripts", "full_text_content"]
            }
        };
    }


    function getColumnFieldList(columns = []) {
        return columns.map((col) => col?.field).filter(Boolean);
    }

    function buildTableDebugInfo(table) {
        const liveColumns = getCols(table.el);
        const tabInstance = findTabulatorInstance(table.el);
        const visibleColumns = liveColumns.filter((col) => col.visible !== false);

        return {
            tableId: table.tableId,
            label: table.label,
            tagName: table.el.tagName,
            strategy: table.strategy,
            domPath: buildDomPath(table.el),
            heading: getNearbyHeading(table.el),
            capabilities: {
                tabulator: !!tabInstance,
                payloadColumns: !!(table.el.hasAttribute && table.el.hasAttribute("payload-columns")),
                setColumns: !!(tabInstance && typeof tabInstance.setColumns === "function")
            },
            columns: {
                count: liveColumns.length,
                visibleCount: visibleColumns.length,
                hiddenCount: Math.max(liveColumns.length - visibleColumns.length, 0),
                fields: getColumnFieldList(liveColumns),
                visibleFields: getColumnFieldList(visibleColumns)
            }
        };
    }

    async function buildDebugBundle(tables) {
        const tableReports = [];

        for (const table of tables) {
            const tableDebug = buildTableDebugInfo(table);
            const { key, saved } = await loadSavedOrderByTableId(table.tableId, table.el);

            tableReports.push({
                ...tableDebug,
                storage: {
                    key,
                    hasSavedConfig: Array.isArray(saved) && saved.length > 0,
                    savedConfig: saved || []
                }
            });
        }

        return {
            generatedAt: new Date().toISOString(),
            extension: "Filter Help (Pro)",
            page: {
                href: location.href,
                origin: location.origin,
                pathname: location.pathname,
                title: truncateText(document.title, 200)
            },
            totals: {
                tablesFound: tables.length,
                tablesWithSavedConfig: tableReports.filter((item) => item.storage.hasSavedConfig).length
            },
            tables: tableReports,
            pageSnapshot: buildPageSnapshot(),
            troubleshootingChecklist: [
                "Verificare che tableId della pagina coincida con quello salvato in storage.",
                "Controllare capabilities.setColumns/capabilities.payloadColumns per capire se il riordino runtime è supportato.",
                "Confrontare columns.fields con storage.savedConfig per identificare colonne rinominate/mancanti."
            ]
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
                    const bundle = await buildDebugBundle(tables);
                    return {
                        ok: true,
                        msg: "Debug bundle generato.",
                        dbg: bundle
                    };
                }

                if (action === "analyze_page") {
                    const snapshot = buildPageSnapshot();
                    const result = await requestBackgroundAnalysis({
                        action: "analyze_page",
                        snapshot,
                        url: location.href,
                        viewKey: computeKeyStable(tables[0].el),
                        forceRefresh: !!data?.forceRefresh,
                        passphrase: data?.passphrase || ""
                    });

                    if (!result?.ok) {
                        const humanErrors = {
                            CONFIG_MISSING: "Configurazione AI mancante: apri Opzioni AI e completa provider/model/endpoint.",
                            PASSPHRASE_REQUIRED: "Token cifrato: inserisci passphrase nel popup o aggiorna Opzioni AI.",
                            PASSPHRASE_INVALID: "Passphrase non valida: verifica la passphrase configurata.",
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

                if (action === "preview_suggestion" || action === "apply_suggestion") {
                    const suggestion = data?.suggestion;
                    const targetTableId = data?.tableId || tables[0]?.tableId;
                    const descriptor = tables.find((t) => t.tableId === targetTableId) || tables[0];
                    if (!descriptor) return { ok: false, msg: "Tabella non trovata." };

                    const preview = buildSuggestionPreview(descriptor, suggestion);
                    if (!preview.ok) return preview;

                    if (action === "preview_suggestion") {
                        return {
                            ok: true,
                            irreversible: preview.irreversible,
                            msg: preview.msg || "Anteprima pronta.",
                            summary: {
                                tableId: descriptor.tableId,
                                columns: preview.columns.map((c) => ({
                                    field: c.field,
                                    label: c.title || c.label || c.field,
                                    visible: c.visible !== false
                                }))
                            }
                        };
                    }

                    const applyRes = await applyColumnsToTable(descriptor, preview.columns);
                    if (!applyRes.ok) return applyRes;
                    return { ok: true, msg: "Suggerimento applicato.", irreversible: preview.irreversible };
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
