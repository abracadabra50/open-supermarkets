/**
 * Tesco UK catalogue — offline tests.
 *
 * Fixtures are anonymous xapi.tesco.com responses captured 2026-11-04. The
 * second milk is the Northern Ireland product from issue #15: outside NI it
 * reports status "ProductNotFound", which is exactly what a GB product reports
 * to an NI account. Both must surface as not buyable rather than in stock.
 *
 * Run: npx tsx test/tesco-uk.test.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TescoAPI, PRODUCT_FIELDS } from '../src/providers/tesco/api';
import { normaliseProduct, tescoStock, TescoProvider } from '../src/providers/tesco/index';

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tesco-uk-products.json'), 'utf8'));

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

/** A TescoAPI whose HTTP client records the batch and answers from a fixture. */
function fakeApi(answer: (op: any) => any) {
  const api = new TescoAPI();
  const sent: any[] = [];
  (api as any).client = {
    post: async (_url: string, body: any[]) => {
      sent.push(...body);
      return { data: body.map(answer) };
    },
  };
  return { api, sent };
}

async function main() {
  console.log('normalise');

  await check('maps the live xapi shape: price, unit price, description, stock, barcode', () => {
    const p = normaliseProduct(FIX.gbMilk);
    assert.equal(p.product_uid, '254656543');
    assert.equal(p.name, 'Tesco British Semi Skimmed Milk 2.272L, 4 Pints');
    assert.equal(p.retail_price.price, 1.75);
    assert.deepEqual(p.unit_price, { price: 0.77, measure: 'litre' });
    assert.equal(p.description, 'Pasteurised homogenised semi skimmed milk.');
    assert.equal(p.in_stock, true);
    assert.equal(p.gtin, '05000436589457');
  });

  await check("a product the shopper's store doesn't sell is not in stock (#15)", () => {
    const p = normaliseProduct(FIX.niMilk);
    assert.equal(p.in_stock, false);
    // It still has a catalogue price; that must not be read as buyable.
    assert.equal(p.retail_price.price, 1.6);
  });

  await check('status beats isForSale, isForSale beats the legacy fields, nothing is unknown', () => {
    assert.equal(tescoStock({ status: 'AvailableForSale', isForSale: false }), true);
    assert.equal(tescoStock({ status: 'ProductNotFound', isForSale: true }), false);
    assert.equal(tescoStock({ isForSale: false, isAvailable: true }), false);
    assert.equal(tescoStock({ isAvailable: true }), true);
    assert.equal(tescoStock({}), null);
  });

  await check('the per-unit price is never used as the item price', () => {
    const p = normaliseProduct({ id: '1', title: 'x', price: { unitPrice: 0.5, unitOfMeasure: 'kg' } });
    assert.equal(p.retail_price.price, null);
    assert.deepEqual(p.unit_price, { price: 0.5, measure: 'kg' });
  });

  console.log('\napi');

  await check('search uses xapi search with the shared field set and returns nodes', async () => {
    const { api, sent } = fakeApi(() => FIX.search);
    const products = await api.searchProducts('semi skimmed milk', 2, 1);
    assert.equal(sent.length, 1, 'one round trip, not one per product');
    assert.equal(sent[0].operationName, 'Search');
    assert.match(sent[0].query, /search\(query: \$query/);
    assert.deepEqual(sent[0].variables, { query: 'semi skimmed milk', page: 1, count: 2, sortBy: 'relevance' });
    assert.equal(products.length, 1);
    assert.equal(products[0].id, '254656543');
  });

  await check('queries only select fields xapi has (no isAvailable/displayPrice/unitPrice{})', async () => {
    const { api, sent } = fakeApi(() => ({ data: { product: FIX.gbMilk } }));
    await api.getProduct('254656543');
    for (const q of [sent[0].query, PRODUCT_FIELDS]) {
      assert.doesNotMatch(q, /isAvailable|displayPrice|maxQuantity/);
      assert.doesNotMatch(q, /^\s*unitPrice\s*\{/m);
      assert.match(q, /status/);
      assert.match(q, /isForSale/);
    }
  });

  await check('provider search and getProduct normalise through the new path', async () => {
    const { api } = fakeApi((op) => op.operationName === 'Search' ? FIX.search : { data: { product: FIX.niMilk } });
    const self = { name: 'tesco', api, normaliseProduct: (p: any) => normaliseProduct(p) };
    const [hit] = await (TescoProvider.prototype as any).search.call(self, 'milk', { limit: 2 });
    assert.equal(hit.in_stock, true);
    const ni = await (TescoProvider.prototype as any).getProduct.call(self, '253656619');
    assert.equal(ni.in_stock, false);
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
