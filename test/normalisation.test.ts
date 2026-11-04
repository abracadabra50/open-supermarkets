/**
 * Missing price and missing stock must stay unknown.
 *
 * A zero price means free and `in_stock: true` means the retailer said so. An
 * agent building a basket acts on both, so each mapper is fed a record with the
 * field missing and must return null, not a guess. Mappers are called on a
 * stub `this`, so no constructor runs and nothing touches the network or disk.
 *
 * Run: npx tsx test/normalisation.test.ts
 */

import assert from 'node:assert';
import { money, stockLabel, byPrice, cheapest, dealCandidates, UNKNOWN_PRICE } from '../src/format';
import { toPrice, toStock, sumKnown, perUnit } from '../src/providers/normalise';
import { lean } from '../src/batch';
import { AlbertHeijnProvider } from '../src/providers/ah';
import { KrogerProvider } from '../src/providers/kroger';
import { InstacartProvider } from '../src/providers/instacart';
import { InstacartWebProvider } from '../src/providers/instacart-web';
import { SainsburysProvider } from '../src/providers/sainsburys';
import { OcadoProvider } from '../src/providers/ocado';
import { MercadonaProvider } from '../src/providers/mercadona';
import { TescoProvider, tescoStock } from '../src/providers/tesco/index';
import { normaliseProduct as tescoHuProduct, normaliseBasket as tescoHuBasket } from '../src/providers/tesco-hu/index';
import type { Product } from '../src/providers/types';

let failures = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  const done = (err?: any) => {
    if (err) { failures++; console.error(`  ✗ ${name}\n    ${err.message}`); }
    else console.log(`  ✓ ${name}`);
  };
  try {
    const r = fn();
    if (r instanceof Promise) pending.push(r.then(() => done(), done));
    else done();
  } catch (err) { done(err); }
}

/** Call a (possibly private) prototype method with a stub `this`. */
function call(cls: any, method: string, self: object, ...args: any[]): any {
  return cls.prototype[method].call(self, ...args);
}

console.log('helpers');

check('toPrice keeps real prices, including a genuine zero', () => {
  assert.strictEqual(toPrice(1.5), 1.5);
  assert.strictEqual(toPrice(0), 0);
  assert.strictEqual(toPrice('$4.99'), 4.99);
  assert.strictEqual(toPrice('1,25 €'), 1.25);
  assert.strictEqual(toPrice('£1,234.50'), 1234.5);
});

check('toPrice returns null for missing, blank, junk and negative', () => {
  for (const v of [undefined, null, '', 'n/a', NaN, -1, '—']) assert.strictEqual(toPrice(v), null, String(v));
});

check('toStock only trusts booleans', () => {
  assert.strictEqual(toStock(true), true);
  assert.strictEqual(toStock(false), false);
  for (const v of [undefined, null, 'true', 1]) assert.strictEqual(toStock(v), null, String(v));
});

check('sumKnown is null if any line is unknown; an empty basket is 0', () => {
  assert.strictEqual(sumKnown([1, 2.5]), 3.5);
  assert.strictEqual(sumKnown([1, null]), null);
  assert.strictEqual(sumKnown([]), 0);
  assert.strictEqual(perUnit(null, 2), null);
  assert.strictEqual(perUnit(3, 0), null);
  assert.strictEqual(perUnit(3, 2), 1.5);
});

console.log('\nformatting');

check('money prints unknown, not £0.00', () => {
  assert.strictEqual(money(null), UNKNOWN_PRICE);
  assert.strictEqual(money(undefined, 'EUR'), UNKNOWN_PRICE);
  assert.strictEqual(money(0), '£0.00');
  assert.strictEqual(money(2, 'EUR'), '€2.00');
});

check('stockLabel has three states', () => {
  assert.strictEqual(stockLabel(true), 'In stock');
  assert.strictEqual(stockLabel(false), 'Out of stock');
  assert.strictEqual(stockLabel(null), 'Stock unknown');
});

const p = (id: string, price: number | null): Product =>
  ({ product_uid: id, name: id, retail_price: { price }, in_stock: true, provider: 'x' });

check('an unknown price is never the cheapest', () => {
  const list = [p('unknown', null), p('two', 2), p('one', 1)];
  assert.deepStrictEqual([...list].sort(byPrice).map((x) => x.product_uid), ['one', 'two', 'unknown']);
  assert.strictEqual(cheapest(list)?.product_uid, 'one');
  assert.strictEqual(cheapest([p('a', null)]), undefined);
});

check('null stock is unknown, not out of stock: it stays a deal candidate', () => {
  const oos = { ...p('oos', 0.5), in_stock: false };
  const unknown = { ...p('unknown-stock', 1), in_stock: null };
  const list = [oos, unknown, p('in', 2), p('no-price', null)];
  assert.deepStrictEqual(dealCandidates(list).map((x) => x.product_uid), ['unknown-stock', 'in']);
  // A known out-of-stock item is never "best", however cheap.
  assert.strictEqual(cheapest(list)?.product_uid, 'unknown-stock');
});

check('batch lean output carries null through', () => {
  const l = lean({ ...p('a', null), in_stock: null });
  assert.strictEqual(l.price, null);
  assert.strictEqual(l.inStock, null);
});

console.log('\nproduct mappers: missing price → null, missing stock → null');

check('Albert Heijn', () => {
  const self = { name: 'ah' };
  const bare = call(AlbertHeijnProvider, 'toProduct', self, { webshopId: 1, title: 'Melk' });
  assert.strictEqual(bare.retail_price.price, null);
  assert.strictEqual(bare.in_stock, null);
  const full = call(AlbertHeijnProvider, 'toProduct', self,
    { webshopId: 1, title: 'Melk', priceBeforeBonus: 1.29, orderable: false });
  assert.strictEqual(full.retail_price.price, 1.29);
  assert.strictEqual(full.in_stock, false);
});

check('Kroger: no regular price, no store inventory', () => {
  const bare = call(KrogerProvider, 'toProduct', { name: 'kroger' },
    { productId: '1', upc: '1', description: 'Milk', items: [{ price: { promo: 0 } }] });
  assert.strictEqual(bare.retail_price.price, null);
  assert.strictEqual(bare.in_stock, null);
  const oos = call(KrogerProvider, 'toProduct', { name: 'kroger' },
    { productId: '1', upc: '1', description: 'Milk',
      items: [{ price: { regular: 3.49, promo: 0 }, inventory: { stockLevel: 'TEMPORARILY_OUT_OF_STOCK' } }] });
  assert.strictEqual(oos.retail_price.price, 3.49);
  assert.strictEqual(oos.in_stock, false);
  const low = call(KrogerProvider, 'toProduct', { name: 'kroger' },
    { productId: '1', upc: '1', description: 'Milk', items: [{ price: { regular: 3.49 }, inventory: { stockLevel: 'LOW' } }] });
  assert.strictEqual(low.in_stock, true);
});

check('Ocado', () => {
  const bare = call(OcadoProvider, 'mapEntity', { name: 'ocado' }, { productId: 'u', name: 'Milk' });
  assert.strictEqual(bare.retail_price.price, null);
  assert.strictEqual(bare.in_stock, null);
  const full = call(OcadoProvider, 'mapEntity', { name: 'ocado' },
    { productId: 'u', name: 'Milk', price: { current: { amount: '1.65' } }, available: true });
  assert.strictEqual(full.retail_price.price, 1.65);
  assert.strictEqual(full.in_stock, true);
});

check("Sainsbury's", () => {
  const bare = call(SainsburysProvider, 'mapProduct', { name: 'sainsburys' }, { product_uid: '1', name: 'Milk' });
  assert.strictEqual(bare.retail_price.price, null);
  assert.strictEqual(bare.in_stock, null);
  const off = call(SainsburysProvider, 'mapProduct', { name: 'sainsburys' },
    { product_uid: '1', name: 'Milk', retail_price: { price: 1.5 }, in_stock: true, is_available: false });
  assert.strictEqual(off.retail_price.price, 1.5);
  assert.strictEqual(off.in_stock, false);
});

check('Tesco UK', () => {
  const bare = call(TescoProvider, 'normaliseProduct', { name: 'tesco' }, { id: '1', title: 'Milk' });
  assert.strictEqual(bare.retail_price.price, null);
  assert.strictEqual(bare.in_stock, null);
  assert.strictEqual(tescoStock({ isAvailable: true }), true);
  assert.strictEqual(tescoStock({ isAvailable: true, maxQuantityAllowed: 0 }), false);
  assert.strictEqual(tescoStock({}), null);
});

check('Tesco HU', () => {
  const bare = tescoHuProduct({ id: '1', title: 'Tej' });
  assert.strictEqual(bare.retail_price.price, null);
  assert.strictEqual(bare.in_stock, null);
});

check('Mercadona: unparseable price is unknown', () => {
  const bare = call(MercadonaProvider, 'toProduct', { name: 'mercadona' },
    { id: '1', display_name: 'Leche', price_instructions: {} });
  assert.strictEqual(bare.retail_price.price, null);
});

check('Instacart: price and stock are not known until the list is opened', async () => {
  const [hit] = await call(InstacartProvider, 'search', { name: 'instacart' }, 'milk');
  assert.strictEqual(hit.retail_price.price, null);
  assert.strictEqual(hit.in_stock, null);
});

check('Instacart web: no price string, no availability flag', async () => {
  const self = {
    name: 'instacart-web',
    requireLocation: () => ({ zoneId: 'z', postalCode: 'p', shopId: 's' }),
    query: async (op: string) => op === 'Items'
      ? { items: [{ id: 'i1', name: 'Milk', viewSection: {} }] }
      : { searchCrossRetailerGroupResults: { results: [{ itemIds: ['i1'] }] } },
  };
  const [hit] = await call(InstacartWebProvider, 'search', self, 'milk', {});
  assert.strictEqual(hit.retail_price.price, null);
  assert.strictEqual(hit.in_stock, null);
});

console.log('\nbasket mappers: missing line prices → null totals');

check('Instacart: queued items have unknown prices and total', async () => {
  const basket = await call(InstacartProvider, 'getBasket', { name: 'instacart', pending: [{ name: 'milk', quantity: 2 }] });
  assert.strictEqual(basket.items[0].unit_price, null);
  assert.strictEqual(basket.items[0].total_price, null);
  assert.strictEqual(basket.total_cost, null);
  const empty = await call(InstacartProvider, 'getBasket', { name: 'instacart', pending: [] });
  assert.strictEqual(empty.total_cost, 0);
});

check('Instacart web: a line without pricing makes the total unknown', async () => {
  const basket = await call(InstacartWebProvider, 'getBasket', {
    name: 'instacart-web',
    query: async () => ({ personalActiveCarts: [{ items: [
      { id: 'a', itemId: 'a', name: 'Milk', quantity: 1, pricing: { unitPrice: 2, total: 2 } },
      { id: 'b', itemId: 'b', name: 'Eggs', quantity: 1 },
    ] }] }),
  });
  assert.strictEqual(basket.items[1].total_price, null);
  assert.strictEqual(basket.total_cost, null);
});

check('Ocado: no line price and no cart total → unknown, not £0', async () => {
  const basket = await call(OcadoProvider, 'getBasket', {
    name: 'ocado',
    rawCart: async () => ({ items: [{ productId: 'u', quantity: 2 }] }),
    productsInfo: async () => [{ productId: 'u', name: 'Milk' }],
  });
  assert.strictEqual(basket.items[0].unit_price, null);
  assert.strictEqual(basket.items[0].total_price, null);
  assert.strictEqual(basket.total_cost, null);
});

check("Sainsbury's: missing subtotal and total are unknown", async () => {
  const basket = await call(SainsburysProvider, 'getBasket', {
    name: 'sainsburys', storeNumber: '0560',
    client: { get: async () => ({ data: { items: [{ item_uid: 'x', product: { sku: '1', name: 'Milk' }, quantity: 1 }] } }) },
  });
  assert.strictEqual(basket.items[0].unit_price, null);
  assert.strictEqual(basket.items[0].total_price, null);
  assert.strictEqual(basket.total_cost, null);
});

check('Tesco HU: no totalPrice falls back to known lines, else unknown', () => {
  const known = tescoHuBasket({ splitView: [{ items: [{ id: 'a', quantity: 2, product: { id: '1', price: { actual: 100 } } }] }] });
  assert.strictEqual(known.items[0].total_price, 200);
  assert.strictEqual(known.total_cost, 200);
  const unknown = tescoHuBasket({ splitView: [{ items: [{ id: 'a', quantity: 1, product: { id: '1' } }] }] });
  assert.strictEqual(unknown.items[0].unit_price, null);
  assert.strictEqual(unknown.total_cost, null);
});

Promise.all(pending).then(() => {
  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
});
