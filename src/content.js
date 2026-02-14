(() => {
  if (window.__WAH_LOADED__) {
    return;
  }
  window.__WAH_LOADED__ = true;

  let activeTable = null;
  let filterState = { query: "", columnIndex: -1 };

  const panel = document.createElement("aside");
  panel.id = "wah-panel";
  panel.innerHTML = `
    <div class="wah-header">
      <div class="wah-title">WebApp Helper</div>
      <button id="wah-toggle" class="wah-btn" title="Mostra/Nascondi">—</button>
    </div>
    <div class="wah-body" id="wah-body">
      <div class="wah-section">
        <h4>Tabelle rilevate</h4>
        <div class="wah-row">
          <select id="wah-table-select"></select>
          <button id="wah-refresh" class="wah-btn">Aggiorna</button>
        </div>
        <div class="wah-small">Clicca l'intestazione colonna per ordinare asc/desc.</div>
      </div>

      <div class="wah-section">
        <h4>Visibilità colonne</h4>
        <div id="wah-columns"></div>
      </div>

      <div class="wah-section">
        <h4>Filtri rapidi</h4>
        <div class="wah-row">
          <select id="wah-filter-column"></select>
          <input id="wah-filter-query" placeholder="Contiene..." />
        </div>
        <div class="wah-row">
          <button id="wah-apply-filter" class="wah-btn">Applica</button>
          <button id="wah-reset-filter" class="wah-btn">Reset</button>
        </div>
      </div>

      <div class="wah-section">
        <h4>Preset filtri</h4>
        <div class="wah-row">
          <input id="wah-preset-name" placeholder="Nome preset" />
          <button id="wah-save-preset" class="wah-btn">Salva</button>
        </div>
        <div id="wah-presets"></div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(`#${id}`);
  const tableSelect = $("wah-table-select");
  const columnsBox = $("wah-columns");
  const filterColumn = $("wah-filter-column");
  const filterQuery = $("wah-filter-query");
  const presetsBox = $("wah-presets");
  const presetName = $("wah-preset-name");

  function getTables() {
    return [...document.querySelectorAll("table")].filter((t) => t.rows.length > 1);
  }

  function getHeaders(table) {
    const firstRow = table.tHead?.rows?.[0] || table.rows[0];
    return firstRow ? [...firstRow.cells].map((c, i) => c.innerText.trim() || `Colonna ${i + 1}`) : [];
  }

  function enableHeaderSorting(table) {
    const firstRow = table.tHead?.rows?.[0] || table.rows[0];
    if (!firstRow || firstRow.__wahSortingEnabled) {
      return;
    }
    firstRow.__wahSortingEnabled = true;

    [...firstRow.cells].forEach((cell, index) => {
      cell.style.cursor = "pointer";
      cell.title = "Clicca per ordinare";
      let asc = true;
      cell.addEventListener("click", () => {
        sortTable(table, index, asc);
        asc = !asc;
      });
    });
  }

  function sortTable(table, colIndex, asc = true) {
    const tbody = table.tBodies[0] || table;
    const rows = [...tbody.rows].slice(table.tHead ? 0 : 1);

    rows.sort((a, b) => {
      const aText = a.cells[colIndex]?.innerText.trim() || "";
      const bText = b.cells[colIndex]?.innerText.trim() || "";
      const aNum = Number(aText.replace(/[^\d.-]/g, ""));
      const bNum = Number(bText.replace(/[^\d.-]/g, ""));
      const numeric = !Number.isNaN(aNum) && !Number.isNaN(bNum);

      if (numeric) {
        return asc ? aNum - bNum : bNum - aNum;
      }
      return asc ? aText.localeCompare(bText) : bText.localeCompare(aText);
    });

    rows.forEach((row) => tbody.appendChild(row));
  }

  function setColumnVisibility(table, colIndex, visible) {
    [...table.rows].forEach((row) => {
      const cell = row.cells[colIndex];
      if (cell) {
        cell.style.display = visible ? "" : "none";
      }
    });
  }

  function applyFilter(table, query, columnIndex) {
    const q = query.trim().toLowerCase();
    const rows = [...(table.tBodies[0] || table).rows].slice(table.tHead ? 0 : 1);

    rows.forEach((row) => {
      const text = columnIndex >= 0
        ? (row.cells[columnIndex]?.innerText || "")
        : row.innerText;
      row.style.display = !q || text.toLowerCase().includes(q) ? "" : "none";
    });
  }

  function renderColumns(table) {
    const headers = getHeaders(table);
    columnsBox.innerHTML = "";
    filterColumn.innerHTML = `<option value="-1">Tutte</option>`;

    headers.forEach((name, index) => {
      const id = `wah-col-${index}`;
      const wrap = document.createElement("label");
      wrap.className = "wah-chip";
      wrap.innerHTML = `<input id="${id}" type="checkbox" checked /> ${name}`;
      columnsBox.appendChild(wrap);

      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = name;
      filterColumn.appendChild(option);

      const checkbox = wrap.querySelector("input");
      checkbox.addEventListener("change", () => setColumnVisibility(table, index, checkbox.checked));
    });
  }

  async function loadPresets() {
    const key = location.origin;
    const data = await chrome.storage.local.get([key]);
    return data[key] || {};
  }

  async function savePreset(name, value) {
    const key = location.origin;
    const presets = await loadPresets();
    presets[name] = value;
    await chrome.storage.local.set({ [key]: presets });
    await renderPresets();
  }

  async function removePreset(name) {
    const key = location.origin;
    const presets = await loadPresets();
    delete presets[name];
    await chrome.storage.local.set({ [key]: presets });
    await renderPresets();
  }

  async function renderPresets() {
    const presets = await loadPresets();
    presetsBox.innerHTML = "";

    Object.entries(presets).forEach(([name, state]) => {
      const row = document.createElement("div");
      row.className = "wah-row";
      row.innerHTML = `
        <button class="wah-btn" data-load="${name}">${name}</button>
        <button class="wah-btn" data-delete="${name}">Elimina</button>
      `;
      presetsBox.appendChild(row);

      row.querySelector("[data-load]").addEventListener("click", () => {
        filterState = state;
        filterQuery.value = filterState.query;
        filterColumn.value = String(filterState.columnIndex);
        if (activeTable) {
          applyFilter(activeTable, filterState.query, filterState.columnIndex);
        }
      });

      row.querySelector("[data-delete]").addEventListener("click", () => removePreset(name));
    });
  }

  function refreshTables() {
    const tables = getTables();
    tableSelect.innerHTML = "";

    tables.forEach((table, i) => {
      enableHeaderSorting(table);
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = `Tabella ${i + 1} (${table.rows.length} righe)`;
      tableSelect.appendChild(option);
    });

    activeTable = tables[0] || null;
    if (activeTable) {
      renderColumns(activeTable);
      applyFilter(activeTable, filterState.query, filterState.columnIndex);
    } else {
      columnsBox.innerHTML = "<div class='wah-small'>Nessuna tabella trovata.</div>";
      filterColumn.innerHTML = `<option value="-1">Tutte</option>`;
    }
  }

  $("wah-refresh").addEventListener("click", refreshTables);
  tableSelect.addEventListener("change", () => {
    const tables = getTables();
    activeTable = tables[Number(tableSelect.value)] || null;
    if (activeTable) {
      renderColumns(activeTable);
      applyFilter(activeTable, filterState.query, filterState.columnIndex);
    }
  });

  $("wah-apply-filter").addEventListener("click", () => {
    filterState = {
      query: filterQuery.value,
      columnIndex: Number(filterColumn.value)
    };
    if (activeTable) {
      applyFilter(activeTable, filterState.query, filterState.columnIndex);
    }
  });

  $("wah-reset-filter").addEventListener("click", () => {
    filterQuery.value = "";
    filterColumn.value = "-1";
    filterState = { query: "", columnIndex: -1 };
    if (activeTable) {
      applyFilter(activeTable, "", -1);
    }
  });

  $("wah-save-preset").addEventListener("click", async () => {
    const name = presetName.value.trim();
    if (!name) {
      return;
    }
    filterState = {
      query: filterQuery.value,
      columnIndex: Number(filterColumn.value)
    };
    await savePreset(name, filterState);
    presetName.value = "";
  });

  $("wah-toggle").addEventListener("click", () => {
    const body = $("wah-body");
    body.classList.toggle("wah-hidden");
    $("wah-toggle").textContent = body.classList.contains("wah-hidden") ? "+" : "—";
  });

  refreshTables();
  renderPresets();
})();
