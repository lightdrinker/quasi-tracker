const { fetchQdrg } = require("./qdrg");

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method && req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const startedAt = new Date().toISOString();
    const result = await fetchQdrg({ pageNo: "1", numOfRows: "1", type: "json" });
    const body = result.payload && result.payload.body ? result.payload.body : {};
    const totalCount = Number(body.totalCount || 0);

    sendJson(res, result.statusCode, {
      ok: result.statusCode === 200,
      startedAt,
      checkedAt: new Date().toISOString(),
      totalCount,
      expectedPagesAt500Rows: totalCount ? Math.ceil(totalCount / 500) : null,
      upstreamCode: result.payload && result.payload.header ? result.payload.header.resultCode : null,
      upstreamMessage: result.payload && result.payload.header ? result.payload.header.resultMsg : null
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: "Refresh health check failed.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
};
