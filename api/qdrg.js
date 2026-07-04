const API_URL =
  "https://apis.data.go.kr/1471000/QdrgPrdtPrmsnInfoService03/getQdrgPrdtPrmsnInfoInq03";

const ALLOWED_PARAMS = new Set([
  "pageNo",
  "numOfRows",
  "type",
  "item_seq",
  "item_name",
  "entp_name",
  "class_no"
]);

function getServiceKey() {
  return process.env.QDRG_SERVICE_KEY || process.env.QDRG_API_KEY || "";
}

function sendJson(res, statusCode, payload, cacheControl) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cacheControl) {
    res.setHeader("Cache-Control", cacheControl);
  }
  res.end(JSON.stringify(payload));
}

function normalizeParams(query) {
  const params = new URLSearchParams();
  const pageNo = Math.max(1, Number.parseInt(query.pageNo || "1", 10) || 1);
  const requestedRows = Number.parseInt(query.numOfRows || "500", 10) || 500;
  const numOfRows = Math.min(500, Math.max(1, requestedRows));

  params.set("pageNo", String(pageNo));
  params.set("numOfRows", String(numOfRows));
  params.set("type", "json");

  for (const [key, value] of Object.entries(query)) {
    if (!ALLOWED_PARAMS.has(key) || key === "pageNo" || key === "numOfRows" || key === "type") {
      continue;
    }
    const trimmed = String(value || "").trim();
    if (trimmed) {
      params.set(key, trimmed);
    }
  }

  return params;
}

async function fetchQdrg(query) {
  const serviceKey = getServiceKey();
  if (!serviceKey) {
    return {
      statusCode: 500,
      payload: {
        error: "QDRG_SERVICE_KEY is not configured."
      }
    };
  }

  const params = normalizeParams(query);
  params.set("serviceKey", serviceKey);

  const response = await fetch(`${API_URL}?${params.toString()}`, {
    headers: {
      Accept: "application/json"
    }
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {
      error: "The upstream API returned a non-JSON response.",
      status: response.status,
      preview: text.slice(0, 300)
    };
  }

  return {
    statusCode: response.ok ? 200 : response.status,
    payload
  };
}

module.exports = async function handler(req, res) {
  if (req.method && req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const query = Object.fromEntries(url.searchParams.entries());
    const result = await fetchQdrg(query);
    sendJson(
      res,
      result.statusCode,
      result.payload,
      "public, s-maxage=21600, stale-while-revalidate=86400"
    );
  } catch (error) {
    sendJson(res, 500, {
      error: "Failed to fetch quasi-drug permission data.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
};

module.exports.fetchQdrg = fetchQdrg;
