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

  const previousSnapshot = await fetchPreviousSnapshot();
  const changes = detectChanges(previousSnapshot?.rows || [], rows);
  const rowsHash = hashJson(rows);
  const syncedAt = new Date().toISOString();
  const snapshot = {
    schemaVersion: 2,
    syncedAt,
    generatedInSeconds: Number(((Date.now() - startedAt.getTime()) / 1000).toFixed(2)),
    totalCount,
    rowsHash,
    rows,
    changes
  };
  const manifest = {
    schemaVersion: 2,
    syncedAt,
    totalCount,
    rowsHash,
    changeCount: changes.length,
    snapshotUrl: "snapshot.json"
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "snapshot.json"), `${JSON.stringify(snapshot)}\n`, "utf8");
  await fs.writeFile(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        totalCount,
        rows: rows.length,
        totalPages,
        changes: changes.length,
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
        detail: `${old.cancelCodeName || "-"} -> ${row.cancelCodeName || "-"}`
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

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
