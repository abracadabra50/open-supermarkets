/**
 * Tesco in-store stock and aisle (#7) — offline tests.
 *
 * Fixtures come from anonymous xapi.tesco.com responses at store 3060,
 * captured 2026-11-04. Nothing here hits the network or reads a session.
 *
 * Run: npx tsx test/tesco-store-stock.test.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TescoAPI, STORE_STOCK_FIELDS } from '../src/providers/tesco/api';
import { normaliseStoreStock, TescoProvider } from '../src/providers/tesco/index';

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tesco-uk-store-stock.json'), 'utf8'));

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

function fakeApi(answer: (op: any) => any) {
  const api = new TescoAPI();
  const sent: any[] = [];
  (api as any).client = {
    defaults: { headers: { common: {} } },
    post: async (_url: string, body: any[]) => {
      sent.push(...body);
      return { data: body.map(answer) };
    },
  };
  return { api, sent };
}

async function main() {
  console.log('normalise');

  await check('in stock, with the aisle de-duplicated', () => {
    const r = normaliseStoreStock(FIX.milk, '3060');
    assert.equal(r.stock, 'in_stock');
    assert.deepEqual(r.aisles, ['40']);
    assert.equal(r.store_id, '3060');
    assert.equal(r.product.product_uid, '254656543');
    assert.equal(r.product.retail_price.price, 1.75);
  });

  await check('a product the store does not range is not_ranged, not out_of_stock', () => {
    const r = normaliseStoreStock(FIX.bread, '3060');
    assert.equal(r.stock, 'not_ranged');
    assert.deepEqual(r.aisles, []);
  });

  await check('low stock, several aisles, and unknown levels stay unknown', () => {
    const r = normaliseStoreStock(FIX.houmous[1]);
    assert.equal(r.stock, 'low_stock');
    assert.deepEqual(r.aisles, ['43', '44']);
    assert.equal(r.store_id, null);
    assert.equal(normaliseStoreStock({ ...FIX.milk, availability: { status: 'UNKNOWN' } }).stock, 'unknown');
    assert.equal(normaliseStoreStock({ ...FIX.milk, availability: { status: 'SOMETHING_NEW' } }).stock, 'unknown');
    assert.equal(normaliseStoreStock({ ...FIX.milk, availability: undefined }).stock, 'unknown');
  });

  console.log('\napi');

  await check('stock for several products is one batched request, scoped to the store', async () => {
    const { api, sent } = fakeApi((op) => ({ data: { product: op.variables.tpnc === '306278259' ? FIX.bread : FIX.milk } }));
    const raw = await api.getStoreStock(['254656543', '306278259'], '3060');
    assert.equal(sent.length, 2);
    for (const op of sent) {
      assert.equal(op.operationName, 'StoreStock');
      assert.equal(op.variables.storeId, '3060');
      assert.match(op.query, /product\(tpnc: \$tpnc, storeId: \$storeId\)/);
    }
    assert.equal(raw[1].status, 'ProductNotFound');
  });

  await check('no store id means no storeId variable, so Tesco uses the session store', async () => {
    const { api, sent } = fakeApi(() => ({ data: { product: FIX.milk } }));
    await api.getStoreStock(['254656543']);
    assert.deepEqual(sent[0].variables, { tpnc: '254656543' });
  });

  await check('an unknown store id is a clear error, not empty results', async () => {
    const { api } = fakeApi(() => FIX.unknownStoreError);
    await assert.rejects(api.getStoreStock(['254656543'], '99999999'), /does not recognise store id "99999999"/);
    const search = fakeApi(() => ({ errors: [{ message: 'Not Found' }] }));
    await assert.rejects(search.api.searchStoreStock('milk', 5, '99999999'), /does not recognise store id/);
  });

  await check('store search selects stock and aisle and honours the limit', async () => {
    const { api, sent } = fakeApi(() => ({ data: { search: { results: FIX.houmous.map((node: any) => ({ node })) } } }));
    const raw = await api.searchStoreStock('houmous', 1, '3060');
    assert.equal(raw.length, 1, 'xapi can return more than count');
    assert.match(sent[0].query, /search\(query: \$query, page: 1, count: \$count, storeId: \$storeId\)/);
    assert.match(STORE_STOCK_FIELDS, /SelectedStoreProductAvailabilityType/);
    assert.match(STORE_STOCK_FIELDS, /StoreProductLocationType/);
  });

  console.log('\nprovider');

  await check('an explicit store uses a cookie-free client, so a dead session cannot break it', async () => {
    const sessionApi = { getStoreStock: async () => { throw new Error('session client used'); } };
    const self: any = { api: sessionApi, stockApi: (TescoProvider.prototype as any).stockApi };
    assert.notEqual(self.stockApi('3060'), sessionApi);
    assert.equal(self.stockApi(undefined), sessionApi);
  });

  await check('storeStock normalises every id, including ones xapi returns nothing for', async () => {
    const fake = { getStoreStock: async () => [FIX.milk, null] };
    const self: any = { api: fake, stockApi: () => fake };
    const results = await (TescoProvider.prototype as any).storeStock.call(self, ['254656543', '1'], '3060');
    assert.equal(results[0].stock, 'in_stock');
    assert.equal(results[1].stock, 'unknown');
    assert.equal(results[1].product.product_uid, '1');
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
