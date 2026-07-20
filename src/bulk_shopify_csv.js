import fs from "node:fs/promises";
import path from "node:path";
import {
  CFG,
  logger,
  findShopifyVariantBySku,
  updateShopifyVariantPrice,
  addProductToCustomCollection,
  updateAirtablePriceBySku,
  normalizePrice,
} from "./lib.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values.map(v => v.trim());
}

export function parseCsv(text) {
  const clean = String(text || "").replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter(line => line.trim() !== "");
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map((line, index) => {
    const cols = splitCsvLine(line);
    const row = { __rowNumber: index + 2 };
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    return row;
  });
}

function firstValue(row, names) {
  const entries = Object.entries(row);
  for (const name of names) {
    const exact = row[name];
    if (exact !== undefined && String(exact).trim() !== "") return exact;
    const found = entries.find(([key, value]) => key.trim().toLowerCase() === name.toLowerCase() && String(value).trim() !== "");
    if (found) return found[1];
  }
  return "";
}

function rowToWorkItem(row, defaultCollection = "") {
  const sku = String(firstValue(row, ["SKU", "sku", "Variant SKU", "variant_sku"])).trim();
  const price = firstValue(row, ["price", "Price", "New Price", "new_price", "New List Price", "list_price", "List Price"]);
  const collection = String(firstValue(row, ["collection", "Collection", "collection_id", "Collection ID", "collection_handle", "Collection Handle"]) || defaultCollection || "").trim();
  return { rowNumber: row.__rowNumber, sku, price, collection, raw: row };
}

async function processItem(item, options) {
  const result = {
    row: item.rowNumber,
    sku: item.sku,
    requestedPrice: item.price,
    normalizedPrice: normalizePrice(item.price),
    requestedCollection: item.collection || "",
    status: "pending",
    productId: "",
    variantId: "",
    productTitle: "",
    priceUpdated: false,
    collectionUpdated: false,
    airtableUpdated: false,
    error: "",
  };

  try {
    if (!item.sku) throw new Error("Missing SKU");
    const hasPrice = String(item.price ?? "").trim() !== "";
    const hasCollection = String(item.collection ?? "").trim() !== "";
    if (!hasPrice && !hasCollection) throw new Error("No price or collection provided");
    if (hasPrice && result.normalizedPrice === null) throw new Error(`Invalid price: ${item.price}`);

    const existing = await findShopifyVariantBySku(item.sku);
    if (!existing?.variantId || !existing?.productId) throw new Error("SKU not found in Shopify");

    result.productId = existing.productId;
    result.variantId = existing.variantId;
    result.productTitle = existing.productTitle || "";

    if (hasPrice && options.updatePrices) {
      await updateShopifyVariantPrice(existing.variantId, result.normalizedPrice);
      result.priceUpdated = true;
    }

    if (hasCollection && options.updateCollections) {
      const collectionResult = await addProductToCustomCollection(existing.productId, item.collection);
      result.collectionUpdated = true;
      result.collectionResult = collectionResult;
    }

    if (hasPrice && options.updateAirtable) {
      const airtableResult = await updateAirtablePriceBySku(item.sku, result.normalizedPrice);
      result.airtableUpdated = Boolean(airtableResult.updated);
      result.airtableResult = airtableResult;
    }

    result.status = CFG.dryRun ? "dry_run_ok" : "updated";
    return result;
  } catch (err) {
    result.status = "failed";
    result.error = err.message;
    return result;
  }
}

export async function runBulkShopifyCsv(options = {}) {
  const csvPath = options.csvPath || process.env.BULK_UPDATE_CSV_PATH;
  if (!csvPath) throw new Error("Missing CSV path. Set BULK_UPDATE_CSV_PATH or pass --csv path/to/file.csv");

  const text = await fs.readFile(csvPath, "utf8");
  const rows = parseCsv(text);
  const items = rows.map(row => rowToWorkItem(row, options.defaultCollection || process.env.DEFAULT_COLLECTION || ""));

  const updatePrices = options.updatePrices !== undefined ? options.updatePrices : true;
  const updateCollections = options.updateCollections !== undefined ? options.updateCollections : true;
  const updateAirtable = options.updateAirtable !== undefined
    ? options.updateAirtable
    : String(process.env.UPDATE_AIRTABLE_PRICES || "false").toLowerCase() === "true";

  logger("info", "Starting Shopify bulk CSV update", {
    csvPath,
    rows: items.length,
    dryRun: CFG.dryRun,
    updatePrices,
    updateCollections,
    updateAirtable,
  });

  const results = [];
  for (const item of items) {
    logger("info", "Processing CSV row", { row: item.rowNumber, sku: item.sku, price: item.price, collection: item.collection || null });
    results.push(await processItem(item, { updatePrices, updateCollections, updateAirtable }));
  }

  const summary = {
    ok: results.every(r => r.status !== "failed"),
    dryRun: CFG.dryRun,
    scannedRows: results.length,
    updated: results.filter(r => r.status === "updated" || r.status === "dry_run_ok").length,
    failed: results.filter(r => r.status === "failed").length,
    priceUpdated: results.filter(r => r.priceUpdated).length,
    collectionUpdated: results.filter(r => r.collectionUpdated).length,
    airtableUpdated: results.filter(r => r.airtableUpdated).length,
    results,
  };

  if (options.reportPath) {
    await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
    await fs.writeFile(options.reportPath, JSON.stringify(summary, null, 2));
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv);
  const summary = await runBulkShopifyCsv({
    csvPath: args.csv,
    defaultCollection: args.collection || "",
    updatePrices: args["no-price"] ? false : true,
    updateCollections: args["no-collections"] ? false : true,
    updateAirtable: args.airtable ? true : undefined,
    reportPath: args.report || "reports/latest-bulk-shopify-report.json",
  });

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    logger("error", "bulk-shopify failed", err.message);
    process.exit(1);
  });
}
