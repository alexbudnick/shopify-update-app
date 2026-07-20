# Shopify Bulk Tools

Version `1.0.0-bulk-price-collections`

This app keeps the existing Airtable → Shopify draft creator, and adds a reusable Shopify bulk updater for:

1. Updating Shopify variant prices by SKU from a CSV.
2. Optionally adding each product to a Shopify **manual/custom collection** from a CSV column or a default collection value.
3. Optionally updating the Airtable `Price` field after Shopify is confirmed.

## CSV format

Minimum CSV for price updates:

```csv
SKU,price
A06062510,1034.10
C02102677,1299.00
```

Optional collection column:

```csv
SKU,price,collection
A06062510,1034.10,Summer Sale
C02102677,1299.00,vintage-guitars
```

Accepted price column names:

- `price`
- `Price`
- `New Price`
- `new_price`
- `New List Price`
- `list_price`
- `List Price`

Accepted collection column names:

- `collection`
- `Collection`
- `collection_id`
- `Collection ID`
- `collection_handle`
- `Collection Handle`

Collection value can be:

- numeric Shopify custom collection ID
- custom collection handle
- exact custom collection title

Note: this adds items to manual/custom collections. Smart/automated collections are controlled by Shopify rules.

## Railway start command

For the reusable web uploader, use:

```bash
npm start
```

Then open the Railway app URL in your browser.

For the old scheduled draft creator behavior, use:

```bash
npm run sync-drafts
```

Do not use `npm start` for a scheduled one-off draft job unless something else is POSTing to `/jobs/shopify/create-drafts`.

## Required Railway variables

Use the same Shopify/Airtable variables from the draft creator app:

```env
SHOPIFY_SHOP=aflashfloodofgear
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_API_VERSION=2026-01

AIRTABLE_PAT=...
AIRTABLE_BASE_ID=...
AIRTABLE_TABLE_NAME=Inventory
AIRTABLE_SKU_FIELD=SKU
AIRTABLE_PRICE_FIELD=Price

SYNC_TRIGGER_SECRET=choose-a-secret
LOG_LEVEL=info
DRY_RUN=true
```

Start with:

```env
DRY_RUN=true
```

After the test report looks correct, set:

```env
DRY_RUN=false
```

## Browser workflow

1. Deploy on Railway with Start Command `npm start`.
2. Open the Railway app URL.
3. Upload your CSV.
4. Leave `Update Shopify prices` checked.
5. Leave `Also update Airtable Price field` unchecked for phase A.
6. Run once with `DRY_RUN=true`.
7. Check the report.
8. Change Railway `DRY_RUN=false`.
9. Upload the same CSV and run again.
10. After Shopify looks correct, rerun with `Also update Airtable Price field` checked for phase C.

## API / curl workflow

Upload a CSV to the app:

```bash
curl -X POST \
  -F "csv=@ShopifyPriceUpdates.csv" \
  -F "updatePrices=on" \
  -F "updateCollections=on" \
  "https://YOUR-RAILWAY-APP.up.railway.app/jobs/shopify/bulk-update?secret=YOUR_SECRET"
```

To also update Airtable:

```bash
curl -X POST \
  -F "csv=@ShopifyPriceUpdates.csv" \
  -F "updatePrices=on" \
  -F "updateCollections=on" \
  -F "updateAirtable=on" \
  "https://YOUR-RAILWAY-APP.up.railway.app/jobs/shopify/bulk-update?secret=YOUR_SECRET"
```

## Command-line workflow

For a one-off Railway job or local run:

```bash
BULK_UPDATE_CSV_PATH=./data/ShopifyPriceUpdates.csv npm run bulk-shopify
```

Or:

```bash
npm run bulk-shopify -- --csv ./data/ShopifyPriceUpdates.csv --report ./reports/report.json
```

To also update Airtable:

```bash
npm run bulk-shopify -- --csv ./data/ShopifyPriceUpdates.csv --airtable
```

## Existing draft creator endpoints still included

The old endpoint still works:

```text
POST /jobs/shopify/create-drafts?secret=YOUR_SECRET
```

The old script still works:

```bash
npm run sync-drafts
```
