const TABLE_PAGE_SIZE = 50;
const DB_NAME = "quasi-tracker";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const MANIFEST_URL = "https://raw.githubusercontent.com/lightdrinker/quasi-tracker/data/manifest.json";
const COLUMN_STORAGE_KEY = "quasi-tracker-visible-columns";

const COLUMN_DEFINITIONS = [
  { key: "itemSeq", label: "품목코드", exportLabel: "ITEM_SEQ", defaultVisible: true, width: 130, className: "code-cell" },
  { key: "itemName", label: "제품명", exportLabel: "ITEM_NAME", defaultVisible: true, width: 230, className: "name-cell" },
  { key: "entpName", label: "업체명", exportLabel: "ENTP_NAME", defaultVisible: true, width: 190 },
  { key: "itemPermitDate", label: "허가일", exportLabel: "ITEM_PERMIT_DATE", defaultVisible: true, width: 120, className: "muted-cell" },
  { key: "cancelCodeName", label: "상태", exportLabel: "CANCEL_CODE_NAME", defaultVisible: true, width: 120, render: renderStatusBadge },
  { key: "classNoName", label: "분류", exportLabel: "CLASS_NO_NAME", defaultVisible: true, width: 250 },
  { key: "itemNo", label: "허가번호", exportLabel: "ITEM_NO", width: 130 },
  { key: "cancelDate", label: "취소/취하일", exportLabel: "CANCEL_DATE", width: 130, className: "muted-cell" },
  { key: "classNo", label: "분류코드", exportLabel: "CLASS_NO", width: 120 },
  { key: "permitKind", label: "허가/신고", exportLabel: "PERMIT_KIND_CODE_NM", width: 130 },
  { key: "indutyCode", label: "제조/수입", exportLabel: "INDUTY_CODE", width: 130 },
  { key: "manufCountryNames", label: "수입제조국", exportLabel: "MANUF_COUNTRY_NAMES", width: 180 },
  { key: "mainIngr", label: "주성분", exportLabel: "MAIN_INGR", width: 340 },
  { key: "aditIngr", label: "첨가제", exportLabel: "ADIT_INGR", width: 340 },
  { key: "efficacyText", label: "효능효과", exportLabel: "EFFICACY_TEXT", width: 360 },
  { key: "dosageText", label: "용법용량", exportLabel: "DOSAGE_TEXT", width: 360 },
  { key: "cautionText", label: "사용상 주의사항", exportLabel: "CAUTION_TEXT", width: 380 },
  { key: "entpNo", label: "업체번호", exportLabel: "ENTP_NO", width: 130 },
  { key: "entpSeq", label: "업체일련번호", exportLabel: "ENTP_SEQ", width: 150 },
  { key: "bizrno", label: "사업자등록번호", exportLabel: "BIZRNO", width: 160 }
];

const COLUMN_BY_KEY = new Map(COLUMN_DEFINITIONS.map((column) => [column.key, column]));

const state = {
  rows: [],
  filteredRows: [],
  changes: [],
  currentPage: 1,
  isSyncing: false,
  visibleColumnKeys: loadVisibleColumnKeys()
};

const elements = {};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindEvents();
  await loadSnapshot();
});

function bindElements() {
  for (const id of [
    "syncStatus",
    "refreshButton",
    "metricTotal",
    "metricNormal",
    "metricInactive",
    "metricRecent",
    "metricChanged",
    "searchInput",
    "withinSearchInput",
    "statusFilter",
    "classFilter",
    "permitFilter",
    "indutyFilter",
    "fromDate",
    "toDate",
    "resetButton",
    "exportButton",
    "topCategories",
    "topCompanies",
    "resultCount",
    "sortSelect",
    "productTable",
    "tableColumns",
    "tableHeadRow",
    "productRows",
    "selectedColumns",
    "availableColumns",
    "prevPage",
    "nextPage",
    "pageInfo",
    "changeList",
    "detailDialog",
    "detailCode",
    "detailTitle",
    "detailBody",
    "closeDetail"
  ]) {
    elements[id] = document.getElementById(id);
  }
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => syncAll({ force: true }));
  elements.resetButton.addEventListener("click", resetFilters);
  elements.exportButton.addEventListener("click", exportCsv);
  elements.prevPage.addEventListener("click", () => setPage(state.currentPage - 1));
  elements.nextPage.addEventListener("click", () => setPage(state.currentPage + 1));
  elements.closeDetail.addEventListener("click", () => elements.detailDialog.close());
  elements.selectedColumns.addEventListener("click", handleColumnAction);
  elements.availableColumns.addEventListener("click", handleColumnAction);

  for (const input of [
    elements.searchInput,
    elements.withinSearchInput,
    elements.statusFilter,
    elements.classFilter,
    elements.permitFilter,
    elements.indutyFilter,
    elements.fromDate,
    elements.toDate,
    elements.sortSelect
  ]) {
    input.addEventListener("input", () => {
      state.currentPage = 1;
      applyFilters();
    });
  }
}

async function loadSnapshot() {
  setStatus("Loading local snapshot");
  const snapshot = await readSnapshot();

  if (snapshot && Array.isArray(snapshot.rows)) {
    state.rows = snapshot.rows;
    state.changes = snapshot.changes || [];
    setStatus(`Cached snapshot ${formatDateTime(snapshot.syncedAt)}`);
    hydrateFilters();
    applyFilters();
  }

  await syncAll({ force: false });
}

async function syncAll({ force }) {
  if (state.isSyncing) {
    return;
  }

  state.isSyncing = true;
  elements.refreshButton.disabled = true;

  try {
    setStatus("Checking central snapshot");
    const localSnapshot = await readSnapshot();
    const manifest = await fetchManifest();

    if (!force && localSnapshot && localSnapshot.rowsHash === manifest.rowsHash) {
      setStatus(`Latest central snapshot ${formatDateTime(manifest.syncedAt)}`);
      return;
    }

    setStatus("Downloading central snapshot");
    const centralSnapshot = await fetchCentralSnapshot(manifest);
    const normalizedRows = centralSnapshot.rows.map(normalizeSnapshotRow).sort(sortByPermitDateDesc);
    const snapshot = {
      syncedAt: centralSnapshot.syncedAt || manifest.syncedAt,
      totalCount: centralSnapshot.totalCount || manifest.totalCount || normalizedRows.length,
      rowsHash: centralSnapshot.rowsHash || manifest.rowsHash,
      rows: normalizedRows,
      changes: centralSnapshot.changes || []
    };

    await writeSnapshot(snapshot);
    state.rows = normalizedRows;
    state.changes = snapshot.changes;
    hydrateFilters();
    state.currentPage = 1;
    applyFilters();
    setStatus(`Loaded central snapshot ${formatDateTime(snapshot.syncedAt)}`);
  } catch (error) {
    setStatus(`Snapshot sync failed: ${error.message}`);
    if (force || !state.rows.length) {
      renderEmpty(error.message);
    }
  } finally {
    state.isSyncing = false;
    elements.refreshButton.disabled = false;
  }
}

async function fetchManifest() {
  const url = new URL(MANIFEST_URL);
  url.searchParams.set("t", String(Date.now()));
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Manifest request failed with ${response.status}`);
  }

  return response.json();
}

async function fetchCentralSnapshot(manifest) {
  const snapshotUrl = new URL(manifest.snapshotUrl || "snapshot.json", MANIFEST_URL);
  snapshotUrl.searchParams.set("v", manifest.rowsHash || String(Date.now()));
  const response = await fetch(snapshotUrl, { cache: "reload" });
  if (!response.ok) {
    throw new Error(`Snapshot request failed with ${response.status}`);
  }

  return response.json();
}

function normalizeSnapshotRow(item) {
  return {
    itemSeq: cleanValue(item.itemSeq),
    itemName: cleanValue(item.itemName),
    entpName: cleanValue(item.entpName),
    itemPermitDate: cleanDate(item.itemPermitDate),
    itemNo: cleanValue(item.itemNo),
    cancelCodeName: cleanValue(item.cancelCodeName) || "미기재",
    cancelDate: cleanDate(item.cancelDate),
    mainIngr: cleanValue(item.mainIngr),
    aditIngr: cleanValue(item.aditIngr),
    classNo: cleanValue(item.classNo),
    classNoName: cleanValue(item.classNoName),
    permitKind: cleanValue(item.permitKind),
    indutyCode: cleanValue(item.indutyCode),
    manufCountryNames: cleanValue(item.manufCountryNames),
    entpNo: cleanValue(item.entpNo),
    entpSeq: cleanValue(item.entpSeq),
    bizrno: cleanValue(item.bizrno),
    efficacyText: cleanValue(item.efficacyText),
    dosageText: cleanValue(item.dosageText),
    cautionText: cleanValue(item.cautionText)
  };
}

function cleanValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function cleanDate(value) {
  const cleaned = cleanValue(value).replaceAll(".", "-");
  if (/^\d{8}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
  }
  return cleaned;
}

function hydrateFilters() {
  setOptions(elements.statusFilter, "All status", uniqueSorted(state.rows.map((row) => row.cancelCodeName)));
  setOptions(elements.classFilter, "All categories", uniqueSorted(state.rows.map((row) => row.classNoName)));
  setOptions(elements.permitFilter, "All", uniqueSorted(state.rows.map((row) => row.permitKind)));
  setOptions(elements.indutyFilter, "All", uniqueSorted(state.rows.map((row) => row.indutyCode)));
}

function setOptions(select, label, values) {
  const current = select.value;
  select.innerHTML = "";
  select.append(new Option(label, ""));
  for (const value of values) {
    if (value) {
      select.append(new Option(value, value));
    }
  }
  select.value = values.includes(current) ? current : "";
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
}

function applyFilters() {
  const query = elements.searchInput.value.trim().toLowerCase();
  const withinQuery = elements.withinSearchInput.value.trim().toLowerCase();
  const status = elements.statusFilter.value;
  const className = elements.classFilter.value;
  const permit = elements.permitFilter.value;
  const induty = elements.indutyFilter.value;
  const fromDate = elements.fromDate.value;
  const toDate = elements.toDate.value;

  state.filteredRows = state.rows.filter((row) => {
    if (query && !getSearchText(row).includes(query)) {
      return false;
    }
    if (status && row.cancelCodeName !== status) {
      return false;
    }
    if (className && row.classNoName !== className) {
      return false;
    }
    if (permit && row.permitKind !== permit) {
      return false;
    }
    if (induty && row.indutyCode !== induty) {
      return false;
    }
    if (fromDate && row.itemPermitDate < fromDate) {
      return false;
    }
    if (toDate && row.itemPermitDate > toDate) {
      return false;
    }
    return true;
  });

  if (withinQuery) {
    state.filteredRows = state.filteredRows.filter((row) => getSearchText(row).includes(withinQuery));
  }

  sortFilteredRows();
  render();
}

function getSearchText(row) {
  return [
    row.itemSeq,
    row.itemName,
    row.entpName,
    row.itemNo,
    row.mainIngr,
    row.aditIngr,
    row.classNoName,
    row.efficacyText,
    row.dosageText,
    row.cautionText
  ]
    .join(" ")
    .toLowerCase();
}

function sortFilteredRows() {
  const sort = elements.sortSelect.value;
  const collator = new Intl.Collator("ko");

  state.filteredRows.sort((a, b) => {
    if (sort === "permitDateAsc") {
      return a.itemPermitDate.localeCompare(b.itemPermitDate);
    }
    if (sort === "nameAsc") {
      return collator.compare(a.itemName, b.itemName);
    }
    if (sort === "companyAsc") {
      return collator.compare(a.entpName, b.entpName);
    }
    return sortByPermitDateDesc(a, b);
  });
}

function sortByPermitDateDesc(a, b) {
  return b.itemPermitDate.localeCompare(a.itemPermitDate) || a.itemName.localeCompare(b.itemName, "ko");
}

function render() {
  renderMetrics();
  renderTopLists();
  renderColumnControls();
  renderTable();
  renderChanges();
}

function renderMetrics() {
  const total = state.rows.length;
  const normal = state.rows.filter((row) => row.cancelCodeName === "정상").length;
  const recentCutoff = getDateDaysAgo(30);
  const recent = state.rows.filter((row) => row.itemPermitDate >= recentCutoff).length;

  elements.metricTotal.textContent = total.toLocaleString();
  elements.metricNormal.textContent = normal.toLocaleString();
  elements.metricInactive.textContent = (total - normal).toLocaleString();
  elements.metricRecent.textContent = recent.toLocaleString();
  elements.metricChanged.textContent = state.changes.length.toLocaleString();
}

function renderTopLists() {
  renderCounterList(elements.topCategories, countBy(state.rows, "classNoName"), 8);
  renderCounterList(elements.topCompanies, countBy(state.rows, "entpName"), 8);
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = row[key] || "미기재";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderCounterList(container, entries, limit) {
  container.innerHTML = "";
  for (const [label, count] of entries.slice(0, limit)) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeHtml(label)}</strong><span>${count.toLocaleString()}</span>`;
    container.append(li);
  }
}

function renderTable() {
  const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / TABLE_PAGE_SIZE));
  state.currentPage = Math.min(state.currentPage, totalPages);
  const start = (state.currentPage - 1) * TABLE_PAGE_SIZE;
  const pageRows = state.filteredRows.slice(start, start + TABLE_PAGE_SIZE);
  const visibleColumns = getVisibleColumns();

  renderTableHead(visibleColumns);
  elements.resultCount.textContent = `${state.filteredRows.length.toLocaleString()} results`;
  elements.productRows.innerHTML = "";

  if (!pageRows.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="${visibleColumns.length}" class="empty-state">No products match the current filters.</td>`;
    elements.productRows.append(row);
  }

  for (const item of pageRows) {
    const tr = document.createElement("tr");
    tr.innerHTML = visibleColumns.map((column) => renderTableCell(item, column)).join("");
    tr.addEventListener("click", () => openDetail(item));
    elements.productRows.append(tr);
  }

  elements.pageInfo.textContent = `${state.currentPage} / ${totalPages}`;
  elements.prevPage.disabled = state.currentPage <= 1;
  elements.nextPage.disabled = state.currentPage >= totalPages;
}

function renderTableHead(visibleColumns) {
  const tableWidth = Math.max(960, visibleColumns.reduce((sum, column) => sum + column.width, 0));
  elements.productTable.style.minWidth = `${tableWidth}px`;
  elements.tableColumns.innerHTML = visibleColumns
    .map((column) => `<col style="width: ${column.width}px">`)
    .join("");
  elements.tableHeadRow.innerHTML = visibleColumns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
}

function renderTableCell(item, column) {
  const value = getColumnValue(item, column);
  const displayValue = value || "-";
  const className = column.className ? ` class="${column.className}"` : "";
  const title = ` title="${escapeHtml(displayValue)}"`;

  if (column.render) {
    return `<td${className}${title}>${column.render(value, item)}</td>`;
  }

  return `<td${className}><span class="truncate-cell"${title}>${escapeHtml(displayValue)}</span></td>`;
}

function renderStatusBadge(status) {
  const type = status === "정상" ? "normal" : "inactive";
  return `<span class="badge ${type}">${escapeHtml(status || "미기재")}</span>`;
}

function renderColumnControls() {
  const visibleColumns = getVisibleColumns();
  const visibleKeys = new Set(visibleColumns.map((column) => column.key));
  const availableColumns = COLUMN_DEFINITIONS.filter((column) => !visibleKeys.has(column.key));

  elements.selectedColumns.innerHTML = "";
  visibleColumns.forEach((column, index) => {
    const chip = document.createElement("div");
    chip.className = "column-chip";
    chip.innerHTML = `
      <span title="${escapeHtml(column.label)}">${escapeHtml(column.label)}</span>
      <button type="button" data-column-action="left" data-column-key="${escapeHtml(column.key)}" aria-label="${escapeHtml(column.label)} 왼쪽으로 이동"${index === 0 ? " disabled" : ""}>‹</button>
      <button type="button" data-column-action="right" data-column-key="${escapeHtml(column.key)}" aria-label="${escapeHtml(column.label)} 오른쪽으로 이동"${index === visibleColumns.length - 1 ? " disabled" : ""}>›</button>
      <button type="button" data-column-action="remove" data-column-key="${escapeHtml(column.key)}" aria-label="${escapeHtml(column.label)} 숨기기"${visibleColumns.length === 1 ? " disabled" : ""}>×</button>
    `;
    elements.selectedColumns.append(chip);
  });

  elements.availableColumns.innerHTML = "";
  if (!availableColumns.length) {
    const empty = document.createElement("span");
    empty.className = "column-empty";
    empty.textContent = "추가 가능한 컬럼 없음";
    elements.availableColumns.append(empty);
    return;
  }

  for (const column of availableColumns) {
    const button = document.createElement("button");
    button.className = "column-add";
    button.type = "button";
    button.dataset.columnAction = "add";
    button.dataset.columnKey = column.key;
    button.innerHTML = `<span>+ ${escapeHtml(column.label)}</span>`;
    elements.availableColumns.append(button);
  }
}

function handleColumnAction(event) {
  const button = event.target.closest("button[data-column-action]");
  if (!button) {
    return;
  }

  const key = button.dataset.columnKey;
  const action = button.dataset.columnAction;

  if (!COLUMN_BY_KEY.has(key)) {
    return;
  }

  if (action === "add") {
    addColumn(key);
  } else if (action === "remove") {
    removeColumn(key);
  } else if (action === "left") {
    moveColumn(key, -1);
  } else if (action === "right") {
    moveColumn(key, 1);
  }
}

function addColumn(key) {
  if (state.visibleColumnKeys.includes(key)) {
    return;
  }
  state.visibleColumnKeys = [...state.visibleColumnKeys, key];
  persistColumnSelection();
}

function removeColumn(key) {
  if (state.visibleColumnKeys.length <= 1) {
    return;
  }
  state.visibleColumnKeys = state.visibleColumnKeys.filter((columnKey) => columnKey !== key);
  persistColumnSelection();
}

function moveColumn(key, direction) {
  const index = state.visibleColumnKeys.indexOf(key);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= state.visibleColumnKeys.length) {
    return;
  }

  const nextKeys = [...state.visibleColumnKeys];
  [nextKeys[index], nextKeys[nextIndex]] = [nextKeys[nextIndex], nextKeys[index]];
  state.visibleColumnKeys = nextKeys;
  persistColumnSelection();
}

function persistColumnSelection() {
  saveVisibleColumnKeys();
  renderColumnControls();
  renderTable();
}

function renderChanges() {
  elements.changeList.innerHTML = "";
  const changes = state.changes.slice(0, 12);

  if (!changes.length) {
    elements.changeList.innerHTML = `<div class="empty-state">No snapshot changes detected yet.</div>`;
    return;
  }

  for (const change of changes) {
    const item = document.createElement("div");
    item.className = "change-item";
    item.innerHTML = `
      <strong>${escapeHtml(change.itemName || change.itemSeq)} · ${escapeHtml(change.type)}</strong>
      <span>${escapeHtml(change.detail || "")}</span>
    `;
    elements.changeList.append(item);
  }
}

function setPage(page) {
  const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / TABLE_PAGE_SIZE));
  state.currentPage = Math.min(totalPages, Math.max(1, page));
  renderTable();
}

function openDetail(item) {
  elements.detailCode.textContent = item.itemSeq;
  elements.detailTitle.textContent = item.itemName;
  elements.detailBody.innerHTML = `
    <section class="detail-section">
      <h3>기본정보</h3>
      <div class="detail-grid">
        ${kv("업체명", item.entpName)}
        ${kv("사업자등록번호", item.bizrno || "-")}
        ${kv("허가번호", item.itemNo || "-")}
        ${kv("허가일", item.itemPermitDate || "-")}
        ${kv("상태", item.cancelCodeName || "-")}
        ${kv("취소/취하일", item.cancelDate || "-")}
        ${kv("품목분류", item.classNoName || "-")}
        ${kv("허가/신고", item.permitKind || "-")}
        ${kv("제조/수입", item.indutyCode || "-")}
        ${kv("수입제조국", item.manufCountryNames || "-")}
      </div>
    </section>
    ${textSection("주성분", item.mainIngr)}
    ${textSection("첨가제", item.aditIngr)}
    ${textSection("효능효과", item.efficacyText)}
    ${textSection("용법용량", item.dosageText)}
    ${textSection("사용상 주의사항", item.cautionText)}
  `;
  elements.detailDialog.showModal();
}

function kv(label, value) {
  return `<div class="detail-kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function textSection(title, value) {
  return `
    <section class="detail-section">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(value || "-")}</p>
    </section>
  `;
}

function resetFilters() {
  elements.searchInput.value = "";
  elements.withinSearchInput.value = "";
  elements.statusFilter.value = "";
  elements.classFilter.value = "";
  elements.permitFilter.value = "";
  elements.indutyFilter.value = "";
  elements.fromDate.value = "";
  elements.toDate.value = "";
  elements.sortSelect.value = "permitDateDesc";
  state.currentPage = 1;
  applyFilters();
}

function exportCsv() {
  const columns = getVisibleColumns();
  const headers = columns.map((column) => column.exportLabel || column.label);
  const lines = [headers.join(",")];

  for (const row of state.filteredRows) {
    lines.push(columns.map((column) => csvCell(getColumnValue(row, column))).join(","));
  }

  const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `quasi-tracker-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

function getDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul"
  }).format(new Date(value));
}

function setStatus(message) {
  elements.syncStatus.textContent = message;
}

function renderEmpty(message) {
  const visibleColumns = getVisibleColumns();
  renderColumnControls();
  renderTableHead(visibleColumns);
  elements.productRows.innerHTML = `<tr><td colspan="${visibleColumns.length}" class="empty-state">${escapeHtml(message)}</td></tr>`;
}

function getVisibleColumns() {
  const columns = state.visibleColumnKeys.map((key) => COLUMN_BY_KEY.get(key)).filter(Boolean);
  if (columns.length) {
    return columns;
  }
  state.visibleColumnKeys = getDefaultColumnKeys();
  return state.visibleColumnKeys.map((key) => COLUMN_BY_KEY.get(key));
}

function getColumnValue(row, column) {
  return row[column.key] || "";
}

function getDefaultColumnKeys() {
  return COLUMN_DEFINITIONS.filter((column) => column.defaultVisible).map((column) => column.key);
}

function loadVisibleColumnKeys() {
  try {
    const rawValue = localStorage.getItem(COLUMN_STORAGE_KEY);
    const parsed = rawValue ? JSON.parse(rawValue) : null;
    if (Array.isArray(parsed)) {
      const validKeys = parsed.filter((key) => COLUMN_BY_KEY.has(key));
      if (validKeys.length) {
        return validKeys;
      }
    }
  } catch (error) {
    console.warn("Unable to read saved columns", error);
  }

  return getDefaultColumnKeys();
}

function saveVisibleColumnKeys() {
  try {
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(state.visibleColumnKeys));
  } catch (error) {
    console.warn("Unable to save columns", error);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSnapshot() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get("latest");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeSnapshot(snapshot) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).put(snapshot, "latest");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
