import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DIRECT_API_URL =
  "https://apis.data.go.kr/1471000/QdrgPrdtPrmsnInfoService03/getQdrgPrdtPrmsnInfoInq03";
const PAGE_SIZE = 500;
const CONCURRENCY = 10;
const OUT_DIR = process.env.SNAPSHOT_OUT_DIR || "snapshot-out";
const PROXY_BASE_URL = process.env.QDRG_PROXY_BASE_URL || "";
const SERVICE_KEY = process.env.QDRG_SERVICE_KEY || process.env.QDRG_API_KEY || "";
const PREVIOUS_SNAPSHOT_URL = process.env.PREVIOUS_SNAPSHOT_URL || "";
const PREVIOUS_MANIFEST_URL = process.env.PREVIOUS_MANIFEST_URL || "";
const BASELINE_RETENTION_MONTHS = Math.max(1, Number(process.env.BASELINE_RETENTION_MONTHS || 12) || 12);

async function main() {
  const startedAt = new Date();
  const firstPage = await fetchPage(1);
  const totalCount = Number(firstPage.body?.totalCount || 0);
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const rows = extractItems(firstPage).map(normalizeItem);

  const remainingPages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 2);
  const pageResults = await mapWithConcurrency(remainingPages, CONCURRENCY, fetchPage);
  for (const page of pageResults) {
    rows.push(...extractItems(page).map(normalizeItem));
  }

  rows.sort(sortByPermitDateDesc);

  const rowsHash = hashJson(rows);
  const syncedAt = new Date().toISOString();
  const previousSnapshot = await fetchPreviousSnapshot();
  const previousManifest = await fetchPreviousManifest();
  const baselines = await buildBaselines({
    previousManifest,
    rows,
    rowsHash,
    syncedAt,
    totalCount
  });
  const currentBaselineMonth = getKstMonth(new Date(syncedAt));
  const currentBaseline = baselines.find((baseline) => baseline.month === currentBaselineMonth);
  const changes = detectChanges(currentBaseline?.rows || previousSnapshot?.rows || [], rows, currentBaselineMonth);
  const snapshot = {
    schemaVersion: 3,
    syncedAt,
    generatedInSeconds: Number(((Date.now() - startedAt.getTime()) / 1000).toFixed(2)),
    totalCount,
    rowsHash,
    rows,
    changes
  };
  const manifest = {
    schemaVersion: 3,
    syncedAt,
    totalCount,
    rowsHash,
    changeCount: changes.length,
    snapshotUrl: "snapshot.json",
    currentBaselineMonth,
    baselineRetentionMonths: BASELINE_RETENTION_MONTHS,
    baselines: baselines.map(({ rows: _rows, ...baseline }) => baseline)
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(path.join(OUT_DIR, "baselines"), { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "snapshot.json"), `${JSON.stringify(snapshot)}\n`, "utf8");
  await fs.writeFile(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const baseline of baselines) {
    const baselineSnapshot = {
      schemaVersion: 3,
      type: "monthly-baseline",
      month: baseline.month,
      syncedAt: baseline.syncedAt,
      totalCount: baseline.totalCount,
      rowsHash: baseline.rowsHash,
      rows: baseline.rows
    };
    await fs.writeFile(
      path.join(OUT_DIR, "baselines", `${baseline.month}.json`),
      `${JSON.stringify(baselineSnapshot)}\n`,
      "utf8"
    );
  }

  console.log(
    JSON.stringify(
      {
        totalCount,
        rows: rows.length,
        totalPages,
        changes: changes.length,
        baselines: baselines.map((baseline) => baseline.month),
        rowsHash,
        outDir: OUT_DIR
      },
      null,
      2
    )
  );
}

async function fetchPage(pageNo) {
  const url = new URL(PROXY_BASE_URL || DIRECT_API_URL);
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(PAGE_SIZE));
  url.searchParams.set("type", "json");

  if (!PROXY_BASE_URL) {
    if (!SERVICE_KEY) {
      throw new Error("QDRG_SERVICE_KEY is required when QDRG_PROXY_BASE_URL is not set.");
    }
    url.searchParams.set("serviceKey", SERVICE_KEY);
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`Page ${pageNo} failed with HTTP ${response.status}`);
  }

  const payload = await response.json();
  const header = payload.header || {};
  if (header.resultCode && header.resultCode !== "00") {
    throw new Error(`Page ${pageNo} failed: ${header.resultMsg || header.resultCode}`);
  }
  return payload;
}

function extractItems(payload) {
  const items = payload?.body?.items;
  if (!Array.isArray(items)) {
    return [];
  }
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

  return source
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<ARTICLE[^>]*title="([^"]*)"[^>]*>/g, (_, title) => (title ? `\n${title}\n` : "\n"))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sortByPermitDateDesc(a, b) {
  return b.itemPermitDate.localeCompare(a.itemPermitDate) || a.itemName.localeCompare(b.itemName, "ko");
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let index = 0;

  async function worker() {
    while (index < values.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(values[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function fetchPreviousSnapshot() {
  if (!PREVIOUS_SNAPSHOT_URL) {
    return null;
  }

  try {
    const url = new URL(PREVIOUS_SNAPSHOT_URL);
    url.searchParams.set("t", String(Date.now()));
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchPreviousManifest() {
  if (!PREVIOUS_MANIFEST_URL) {
    return null;
  }

  try {
    const url = new URL(PREVIOUS_MANIFEST_URL);
    url.searchParams.set("t", String(Date.now()));
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function buildBaselines({ previousManifest, rows, rowsHash, syncedAt, totalCount }) {
  const currentMonth = getKstMonth(new Date(syncedAt));
  const retainedMonths = getRecentMonths(currentMonth, BASELINE_RETENTION_MONTHS);
  const retainedMonthSet = new Set(retainedMonths);
  const baselineByMonth = new Map();

  for (const baseline of previousManifest?.baselines || []) {
    if (!retainedMonthSet.has(baseline.month) || baselineByMonth.has(baseline.month)) {
      continue;
    }
    const previousBaseline = await fetchPreviousBaseline(baseline);
    baselineByMonth.set(baseline.month, {
      month: baseline.month,
      syncedAt: previousBaseline.syncedAt || baseline.syncedAt || syncedAt,
      totalCount: previousBaseline.totalCount || baseline.totalCount || previousBaseline.rows?.length || 0,
      rowsHash: previousBaseline.rowsHash || baseline.rowsHash || hashJson(previousBaseline.rows || []),
      url: baselineUrl(baseline.month),
      rows: previousBaseline.rows || []
    });
  }

  if (!baselineByMonth.has(currentMonth)) {
    baselineByMonth.set(currentMonth, {
      month: currentMonth,
      syncedAt,
      totalCount,
      rowsHash,
      url: baselineUrl(currentMonth),
      rows
    });
  }

  return retainedMonths.filter((month) => baselineByMonth.has(month)).map((month) => baselineByMonth.get(month));
}

async function fetchPreviousBaseline(baseline) {
  if (!PREVIOUS_MANIFEST_URL) {
    throw new Error(`Cannot fetch baseline ${baseline.month}: PREVIOUS_MANIFEST_URL is not set.`);
  }

  const url = new URL(baseline.url || baselineUrl(baseline.month), PREVIOUS_MANIFEST_URL);
  url.searchParams.set("v", baseline.rowsHash || String(Date.now()));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Baseline ${baseline.month} failed with HTTP ${response.status}`);
  }

  return response.json();
}

function baselineUrl(month) {
  return `baselines/${month}.json`;
}

function getKstMonth(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
}

function getRecentMonths(currentMonth, count) {
  const [year, month] = currentMonth.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 - index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

function detectChanges(previousRows, nextRows, baselineMonth = "") {
  if (!previousRows.length) {
    return nextRows.slice(0, 20).map((row) => ({
      baselineMonth,
      type: "new snapshot",
      itemSeq: row.itemSeq,
      itemName: row.itemName,
      entpName: row.entpName,
      itemPermitDate: row.itemPermitDate,
      classNoName: row.classNoName,
      permitKind: row.permitKind,
      indutyCode: row.indutyCode,
      cancelCodeName: row.cancelCodeName,
      detail: `${row.entpName} · ${row.classNoName}`
    }));
  }

  const previous = new Map(previousRows.map((row) => [row.itemSeq, row]));
  const next = new Map(nextRows.map((row) => [row.itemSeq, row]));
  const changes = [];

  for (const row of nextRows) {
    const old = previous.get(row.itemSeq);
    if (!old) {
      changes.push({
        ...changeMeta(row, baselineMonth),
        type: "new",
        detail: `${row.itemPermitDate} · ${row.entpName}`
      });
      continue;
    }

    if (old.cancelCodeName !== row.cancelCodeName) {
      changes.push({
        ...changeMeta(row, baselineMonth),
        type: "status",
        from: old.cancelCodeName || "-",
        to: row.cancelCodeName || "-",
        detail: `${old.cancelCodeName || "-"} -> ${row.cancelCodeName || "-"}`
      });
    }

    const changedFields = changedDocumentFields(old, row);
    if (changedFields.length) {
      changes.push({
        ...changeMeta(row, baselineMonth),
        type: "document",
        changedFields,
        detail: `${changedFields.join("/")} 변경`
      });
    }
  }

  for (const old of previousRows) {
    if (!next.has(old.itemSeq)) {
      changes.push({
        ...changeMeta(old, baselineMonth),
        type: "removed",
        detail: "기준월 이후 최신 DB에서 제외"
      });
    }
  }

  return changes;
}

function changeMeta(row, baselineMonth) {
  return {
    baselineMonth,
    itemSeq: row.itemSeq,
    itemName: row.itemName,
    entpName: row.entpName,
    itemPermitDate: row.itemPermitDate,
    classNoName: row.classNoName,
    permitKind: row.permitKind,
    indutyCode: row.indutyCode,
    cancelCodeName: row.cancelCodeName
  };
}

function changedDocumentFields(oldRow, nextRow) {
  const fields = [
    ["efficacyText", "효능효과"],
    ["dosageText", "용법용량"],
    ["cautionText", "주의사항"]
  ];
  return fields.filter(([key]) => oldRow[key] !== nextRow[key]).map(([, label]) => label);
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
