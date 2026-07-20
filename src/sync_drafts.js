import {
  CFG,
  logger,
  fetchReadyAirtableRecords,
  updateAirtableRecord,
  createShopifyDraftProduct,
  updateInventoryItemCost,
  uploadShopifyProductImages,
  shopifyAdminProductUrl,
  numberField,
  stringField,
  findShopifyVariantBySku,
} from "./lib.js";

async function linkExistingShopifyProduct(record, existing) {
  const f = CFG.airtable.fields;
  const sku = stringField(record, f.sku);
  const draftUrl = shopifyAdminProductUrl(existing.productId);

  await updateAirtableRecord(record.id, {
    [f.shopifyProductId]: String(existing.productId),
    [f.shopifyVariantId]: existing.variantId ? String(existing.variantId) : "",
    [f.shopifyDraftUrl]: draftUrl,
    [f.draftCreated]: true,
    [f.draftSyncSource]: "Shopify Draft Automation - Linked Existing SKU",
    [f.automationError]: "",
  });

  logger("warn", "Existing Shopify product found by SKU; linked Airtable record instead of creating duplicate", {
    sku,
    productId: existing.productId,
    variantId: existing.variantId,
    productTitle: existing.productTitle,
    productStatus: existing.productStatus,
    draftUrl
  });

  return {
    sku,
    productId: existing.productId,
    variantId: existing.variantId,
    draftUrl,
    action: "linked_existing_shopify_product"
  };
}

async function markCreatedInAirtableImmediately(record, product, variant) {
  const f = CFG.airtable.fields;
  const draftUrl = shopifyAdminProductUrl(product.id);

  await updateAirtableRecord(record.id, {
    [f.shopifyProductId]: String(product.id),
    [f.shopifyVariantId]: variant?.id ? String(variant.id) : "",
    [f.shopifyDraftUrl]: draftUrl,
    [f.draftCreated]: true,
    [f.draftSyncSource]: "Shopify Draft Automation - Created",
    [f.automationError]: "",
  });

  return draftUrl;
}

async function processRecord(record) {
  const f = CFG.airtable.fields;
  const sku = stringField(record, f.sku);
  const title = stringField(record, f.title);
  const description = stringField(record, f.description);

  if (!sku) throw new Error("Missing SKU");
  if (!title) throw new Error("Missing Generated Listing Title");
  if (!description) throw new Error(`Missing ${f.description}`);

  logger("info", "Checking Shopify for existing SKU before creating draft", { sku });

  const existing = await findShopifyVariantBySku(sku);
  if (existing?.productId) {
    return linkExistingShopifyProduct(record, existing);
  }

  logger("info", "Creating Shopify draft", { sku, title });

  const created = await createShopifyDraftProduct(record);
  const product = created?.product;
  if (!product?.id) throw new Error(`Shopify response missing product id: ${JSON.stringify(created)}`);

  const variant = product?.variants?.[0] || {};

  // Important duplicate-prevention step:
  // Write the Shopify IDs and Draft Created flag immediately after product creation,
  // before image upload or cost update. If those later steps fail, the next run
  // will not create another Shopify product for the same SKU.
  const draftUrl = await markCreatedInAirtableImmediately(record, product, variant);

  await uploadShopifyProductImages(product.id, record);

  const cost = numberField(record, f.cost);
  if (variant.inventory_item_id && cost !== null) {
    await updateInventoryItemCost(variant.inventory_item_id, cost);
  }

  await updateAirtableRecord(record.id, {
    [f.draftSyncSource]: "Shopify Draft Automation - Complete",
    [f.automationError]: "",
  });

  logger("info", "Created Shopify draft, uploaded images, and updated Airtable", { sku, productId: product.id, draftUrl });
  return { sku, productId: product.id, draftUrl, action: "created_new_shopify_draft" };
}

async function main() {
  const records = await fetchReadyAirtableRecords();
  logger("info", "Found ready Airtable records", { count: records.length });

  const results = [];
  let failed = 0;

  for (const record of records) {
    try {
      results.push(await processRecord(record));
    } catch (err) {
      failed += 1;
      logger("error", "Failed to create draft for Airtable record", { recordId: record.id, error: err.message });
      try {
        await updateAirtableRecord(record.id, {
          [CFG.airtable.fields.automationError]: err.message,
          [CFG.airtable.fields.draftSyncSource]: "Shopify Draft Automation - Error",
        });
      } catch (airtableErr) {
        logger("error", "Failed to write Airtable error", { recordId: record.id, error: airtableErr.message });
      }
    }
  }

  console.log(JSON.stringify({
    ok: failed === 0,
    scannedReadyRecords: records.length,
    processed: results.length,
    failed,
    results
  }, null, 2));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  logger("error", "sync-drafts failed", err.message);
  process.exit(1);
});
