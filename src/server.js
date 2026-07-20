import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { CFG, logger } from "./lib.js";
import { spawn } from "child_process";
import { runBulkShopifyCsv } from "./bulk_shopify_csv.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const upload = multer({ dest: process.env.UPLOAD_DIR || "/tmp/shopify-bulk-uploads" });

let activeJob = null;
let latestBulkReport = null;

function requireSecret(req, res, next) {
  if (!CFG.triggerSecret) return next();
  const supplied = req.query.secret || req.body?.secret;
  if (supplied !== CFG.triggerSecret) {
    return res.status(401).json({ ok: false, error: "Invalid secret" });
  }
  next();
}

function runScript(script, res) {
  if (activeJob) {
    return res.status(409).json({ ok: false, error: "Job already running", activeJob });
  }

  activeJob = { script, startedAt: new Date().toISOString() };
  const child = spawn("npm", ["run", script], { stdio: "inherit", shell: true });

  child.on("close", code => {
    const finishedJob = activeJob;
    activeJob = null;
    if (code === 0) res.json({ ok: true, script, finishedJob });
    else res.status(500).json({ ok: false, script, code, finishedJob });
  });

  child.on("error", error => {
    const failedJob = activeJob;
    activeJob = null;
    res.status(500).json({ ok: false, script, error: error.message, failedJob });
  });
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderReport(report) {
  if (!report) return "";
  const rows = (report.results || []).slice(0, 500).map(r => `
    <tr class="${r.status === "failed" ? "bad" : "good"}">
      <td>${htmlEscape(r.row)}</td>
      <td>${htmlEscape(r.sku)}</td>
      <td>${htmlEscape(r.normalizedPrice || r.requestedPrice || "")}</td>
      <td>${htmlEscape(r.requestedCollection || "")}</td>
      <td>${htmlEscape(r.status)}</td>
      <td>${htmlEscape(r.productId)}</td>
      <td>${htmlEscape(r.error)}</td>
    </tr>`).join("");

  return `
    <h2>Latest report</h2>
    <p><strong>Dry run:</strong> ${report.dryRun ? "Yes" : "No"} · <strong>Rows:</strong> ${report.scannedRows} · <strong>Updated:</strong> ${report.updated} · <strong>Failed:</strong> ${report.failed} · <a href="/reports/latest.json">View JSON</a></p>
    <table>
      <thead><tr><th>Row</th><th>SKU</th><th>Price</th><th>Collection</th><th>Status</th><th>Product ID</th><th>Error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Shopify Bulk Tools</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 1100px; margin: 28px auto; padding: 0 18px; line-height: 1.35; }
    h1 { margin-bottom: 4px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 18px; margin: 18px 0; }
    label { display:block; margin: 12px 0 4px; font-weight: 700; }
    input[type="text"], input[type="password"] { width: 100%; max-width: 520px; padding: 8px; }
    button { padding: 10px 14px; font-weight: 700; cursor: pointer; }
    code { background:#f4f4f4; padding: 2px 5px; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #ddd; padding: 7px; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    tr.good { background: #f7fff7; }
    tr.bad { background: #fff6f6; }
  </style>
</head>
<body>
  <h1>Shopify Bulk Tools</h1>
  <p>Upload a CSV with <code>SKU</code> and <code>price</code>. Optional collection columns: <code>collection</code>, <code>collection_id</code>, or <code>collection_handle</code>.</p>

  <div class="card">
    <h2>Upload CSV</h2>
    <form method="post" action="/jobs/shopify/bulk-update${CFG.triggerSecret ? "?secret=" : ""}" enctype="multipart/form-data">
      ${CFG.triggerSecret ? `<label>Secret</label><input type="password" name="secret" placeholder="SYNC_TRIGGER_SECRET" />` : ""}
      <label>CSV file</label>
      <input type="file" name="csv" accept=".csv,text/csv" required />
      <label>Default collection, optional</label>
      <input type="text" name="defaultCollection" placeholder="Collection title, handle, or numeric collection ID" />
      <label><input type="checkbox" name="updatePrices" checked /> Update Shopify prices</label>
      <label><input type="checkbox" name="updateCollections" checked /> Add products to collection when CSV/default collection is provided</label>
      <label><input type="checkbox" name="updateAirtable" /> Also update Airtable Price field</label>
      <p><strong>Safety:</strong> set Railway variable <code>DRY_RUN=true</code> to test without changing Shopify.</p>
      <button type="submit">Run bulk update</button>
    </form>
  </div>

  <div class="card">
    <h2>CSV format</h2>
    <pre>SKU,price,collection
A06062510,1034.10,Summer Sale
C02102677,1299.00,vintage-guitars</pre>
  </div>

  ${renderReport(latestBulkReport)}
</body>
</html>`);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "shopify-bulk-tools",
    version: "1.0.0-bulk-price-collections",
    dryRun: CFG.dryRun,
    activeJob,
    latestBulkReportSummary: latestBulkReport ? {
      scannedRows: latestBulkReport.scannedRows,
      updated: latestBulkReport.updated,
      failed: latestBulkReport.failed,
      dryRun: latestBulkReport.dryRun,
    } : null,
  });
});

app.get("/reports/latest.json", (req, res) => {
  if (!latestBulkReport) return res.status(404).json({ ok: false, error: "No report yet" });
  res.json(latestBulkReport);
});

app.post("/jobs/shopify/create-drafts", requireSecret, (req, res) => runScript("sync-drafts", res));

app.post("/jobs/shopify/bulk-update", upload.single("csv"), requireSecret, async (req, res) => {
  if (activeJob) return res.status(409).json({ ok: false, error: "Job already running", activeJob });
  if (!req.file?.path) return res.status(400).json({ ok: false, error: "Missing CSV upload field named csv" });

  activeJob = { script: "bulk-shopify-upload", startedAt: new Date().toISOString() };
  try {
    const report = await runBulkShopifyCsv({
      csvPath: req.file.path,
      defaultCollection: req.body.defaultCollection || "",
      updatePrices: req.body.updatePrices === "on" || req.body.updatePrices === "true" || req.body.updatePrices === true,
      updateCollections: req.body.updateCollections === "on" || req.body.updateCollections === "true" || req.body.updateCollections === true,
      updateAirtable: req.body.updateAirtable === "on" || req.body.updateAirtable === "true" || req.body.updateAirtable === true,
    });
    latestBulkReport = report;
    await fs.unlink(req.file.path).catch(() => {});

    if ((req.headers.accept || "").includes("text/html")) {
      return res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Bulk update report</title><style>body{font-family:Arial,sans-serif;max-width:1100px;margin:28px auto;padding:0 18px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ddd;padding:7px;text-align:left;vertical-align:top}th{background:#f5f5f5}.good{background:#f7fff7}.bad{background:#fff6f6}</style></head><body><p><a href="/">← Back</a></p>${renderReport(report)}</body></html>`);
    }

    return res.json(report);
  } catch (err) {
    latestBulkReport = { ok: false, error: err.message };
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    activeJob = null;
  }
});

app.listen(PORT, () => logger("info", `Listening on port ${PORT}`));
