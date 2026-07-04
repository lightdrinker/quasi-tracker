const PAGE_SIZE = 500;
const TABLE_PAGE_SIZE = 50;
const DB_NAME = "quasi-tracker";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";

const state = {
  rows: [],
  filteredRows: [],
  changes: [],
  currentPage: 1,
  isSyncing: false
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
    "productRows",
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

  for (const input of [
    elements.searchInput,
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
    setStatus(`Last refreshed ${formatDateTime(snapshot.syncedAt)}`);
    hydrateFilters();
    applyFilters();
  }

  if (!snapshot || shouldRefresh(snapshot.syncedAt)) {
    await syncAll({ force: false });
  }
}

async function syncAll({ force }) {
  if (state.isSyncing) {
    return;
  }

  state.isSyncing = true;
  elements.refreshButton.disabled = true;

  try {
    const previousRows = state.rows;
    const firstPage = await fetchPage(1);
    const totalCount = Number(firstPage.body && firstPage.body.totalCount ? firstPage.body.totalCount : 0);
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    const rows = extractItems(firstPage);

    setStatus(`Refreshing 1 / ${totalPages}`);

    for (let page = 2; page <= totalPages; page += 1) {
      const pageData = await fetchPage(page);
      rows.push(...extractItems(pageData));
      setStatus(`Refreshing ${page} / ${totalPages}`);
    }

    const normalizedRows = rows.map(normalizeItem).sort(sortByPermitDateDesc);
    const changes = detectChanges(previousRows, normalizedRows);
    const snapshot = {
      syncedAt: new Date().toISOString(),
      totalCount,
      rows: normalizedRows,
      changes
    };

    await writeSnapshot(snapshot);
    state.rows = normalizedRows;
    state.changes = changes;
    hydrateFilters();
    state.currentPage = 1;
    applyFilters();
    setStatus(`Refreshed ${normalizedRows.length.toLocaleString()} items`);
  } catch (error) {
    setStatus(`Refresh failed: ${error.message}`);
    if (force || !state.rows.length) {
      renderEmpty(error.message);
    }
  } finally {
    state.isSyncing = false;
    elements.refreshButton.disabled = false;
  }
}

async function fetchPage(pageNo) {
  const response = await fetch(`/api/qdrg?pageNo=${pageNo}&numOfRows=${PAGE_SIZE}&type=json`);
  if (!response.ok) {
    throw new Error(`API request failed with ${response.status}`);
  }

  const payload = await response.json();
  const header = payload.header || {};
  if (header.resultCode && header.resultCode !== "00") {
    throw new Error(header.resultMsg || `API returned ${header.resultCode}`);
  }

  return payload;
}

function extractItems(payload) {
  const items = payload && payload.body && Array.isArray(payload.body.items) ? payload.body.items : [];
  return items.map((entry) => entry.item || entry);
}

function normalizeItem(item) {
  return {
    itemSeq: cleanValue(item.ITEM_SEQ),
    itemName: cleanValue(item.ITEM_NAME),
    entpName: cleanValue(item.ENTP_NAME),
    itemPermitDate: cleanDate(item.ITEM_PERMIT_DATE),
    itemNo: cleanValue(item.ITEM_NO),
    cancelCodeName: cleanValue(item.CANCEL_CODE_NAME) || "미기재",
    cancelDate: cleanDate(item.CANCEL_DATE),
    mainIngr: cleanValue(item.MAIN_INGR),
    aditIngr: cleanValue(item.ADIT_INGR),
    classNo: cleanValue(item.CLASS_NO),
    classNoName: cleanValue(item.CLASS_NO_NAME),
    permitKind: cleanValue(item.PERMIT_KIND_CODE_NM),
    indutyCode: cleanValue(item.INDUTY_CODE),
    manufCountryNames: cleanValue(item.MANUF_COUNTRY_NAMES),
    entpNo: cleanValue(item.ENTP_NO),
    entpSeq: cleanValue(item.ENTP_SEQ),
    bizrno: cleanValue(item.BIZRNO),
    efficacyText: extractDocText(item.EE_DOC_DATA),
    dosageText: extractDocText(item.UD_DOC_DATA),
    cautionText: extractDocText(item.NB_DOC_DATA)
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

function extractDocText(xmlText) {
  const source = cleanValue(xmlText);
  if (!source) {
    return "";
  }

  try {
    const doc = new DOMParser().parseFromString(source, "text/xml");
    const parserError = doc.querySelector("parsererror");
    if (parserError) {
      return stripXml(source);
    }

    const parts = [];
    for (const article of doc.querySelectorAll("ARTICLE")) {
      const title = cleanValue(article.getAttribute("title"));
      if (title) {
        parts.push(title);
      }
      for (const paragraph of article.querySelectorAll("PARAGRAPH")) {
        const text = cleanValue(paragraph.textContent);
        if (text) {
          parts.push(text);
        }
      }
    }
    return parts.join("\n");
  } catch {
    return stripXml(source);
  }
}

function stripXml(value) {
  return value
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

  elements.resultCount.textContent = `${state.filteredRows.length.toLocaleString()} results`;
  elements.productRows.innerHTML = "";

  if (!pageRows.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="6" class="empty-state">No products match the current filters.</td>`;
    elements.productRows.append(row);
  }

  for (const item of pageRows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="code-cell">${escapeHtml(item.itemSeq)}</td>
      <td class="name-cell">${escapeHtml(item.itemName)}</td>
      <td>${escapeHtml(item.entpName)}</td>
      <td class="muted-cell">${escapeHtml(item.itemPermitDate || "-")}</td>
      <td>${renderStatusBadge(item.cancelCodeName)}</td>
      <td>${escapeHtml(item.classNoName || "-")}</td>
    `;
    tr.addEventListener("click", () => openDetail(item));
    elements.productRows.append(tr);
  }

  elements.pageInfo.textContent = `${state.currentPage} / ${totalPages}`;
  elements.prevPage.disabled = state.currentPage <= 1;
  elements.nextPage.disabled = state.currentPage >= totalPages;
}

function renderStatusBadge(status) {
  const type = status === "정상" ? "normal" : "inactive";
  return `<span class="badge ${type}">${escapeHtml(status || "미기재")}</span>`;
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

function detectChanges(previousRows, nextRows) {
  if (!previousRows.length) {
    return nextRows.slice(0, 20).map((row) => ({
      type: "new snapshot",
      itemSeq: row.itemSeq,
      itemName: row.itemName,
      detail: `${row.entpName} · ${row.classNoName}`
    }));
  }

  const previous = new Map(previousRows.map((row) => [row.itemSeq, row]));
  const changes = [];

  for (const row of nextRows) {
    const old = previous.get(row.itemSeq);
    if (!old) {
      changes.push({
        type: "new",
        itemSeq: row.itemSeq,
        itemName: row.itemName,
        detail: `${row.itemPermitDate} · ${row.entpName}`
      });
      continue;
    }

    if (old.cancelCodeName !== row.cancelCodeName) {
      changes.push({
        type: "status",
        itemSeq: row.itemSeq,
        itemName: row.itemName,
        detail: `${old.cancelCodeName || "-"} → ${row.cancelCodeName || "-"}`
      });
    }

    if (docFingerprint(old) !== docFingerprint(row)) {
      changes.push({
        type: "document",
        itemSeq: row.itemSeq,
        itemName: row.itemName,
        detail: "효능효과/용법용량/주의사항 문서 변경"
      });
    }
  }

  return changes;
}

function docFingerprint(row) {
  return [row.efficacyText, row.dosageText, row.cautionText].join("|");
}

function resetFilters() {
  elements.searchInput.value = "";
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
  const headers = [
    "ITEM_SEQ",
    "ITEM_NAME",
    "ENTP_NAME",
    "ITEM_PERMIT_DATE",
    "CANCEL_CODE_NAME",
    "CLASS_NO_NAME",
    "PERMIT_KIND_CODE_NM",
    "INDUTY_CODE",
    "MAIN_INGR",
    "ADIT_INGR"
  ];
  const lines = [headers.join(",")];

  for (const row of state.filteredRows) {
    lines.push(
      [
        row.itemSeq,
        row.itemName,
        row.entpName,
        row.itemPermitDate,
        row.cancelCodeName,
        row.classNoName,
        row.permitKind,
        row.indutyCode,
        row.mainIngr,
        row.aditIngr
      ]
        .map(csvCell)
        .join(",")
    );
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

function shouldRefresh(syncedAt) {
  if (!syncedAt) {
    return true;
  }
  const last = new Date(syncedAt);
  return last < getCurrentKstRefreshBoundary();
}

function getCurrentKstRefreshBoundary() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const boundaryUtcMs = Date.UTC(
    kstNow.getUTCFullYear(),
    kstNow.getUTCMonth(),
    kstNow.getUTCDate(),
    7 - 9,
    0,
    0,
    0
  );
  const boundary = new Date(boundaryUtcMs);
  if (now < boundary) {
    boundary.setUTCDate(boundary.getUTCDate() - 1);
  }
  return boundary;
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
  elements.productRows.innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(message)}</td></tr>`;
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
