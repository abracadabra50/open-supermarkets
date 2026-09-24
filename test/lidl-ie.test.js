'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { LidlIrelandProvider } = require('../src/providers/lidl-ie.ts');
const { createProvider, getManifest } = require('../src/providers/registry.ts');

const fixture = () => JSON.parse(readFileSync(join(__dirname, 'fixtures/lidl-search.json'), 'utf8'));

function fetchWith(body, calls = []) {
  return async (input, init) => {
    calls.push({ url: String(input), init });
    return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
  };
}

test('Lidl manifest exposes anonymous search and loads its provider', async () => {
  const manifest = getManifest('lidl-ie');
  assert.equal(manifest.country, 'IE');
  assert.deepEqual(manifest.capabilities, ['search']);
  assert.equal(manifest.tier, 'community');
  assert.equal((await createProvider('lidl-ie')).name, 'lidl-ie');
});

test('Lidl requests the IE catalogue and normalises regular prices', async () => {
  const calls = [];
  const provider = new LidlIrelandProvider({ fetcher: fetchWith(fixture(), calls) });
  const products = await provider.search('milk', { limit: 8, offset: 16 });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('assortment'), 'IE');
  assert.equal(url.searchParams.get('locale'), 'en_IE');
  assert.equal(url.searchParams.get('q'), 'milk');
  assert.equal(url.searchParams.get('fetchsize'), '8');
  assert.equal(url.searchParams.get('offset'), '16');
  assert.equal(calls[0].init.headers.Accept, 'application/mindshift.search+json');
  assert.equal(products[0].retail_price.price, 2.25);
  assert.equal(products[0].in_stock, null);
  assert.deepEqual(products[0].unit_price, { price: 1.13, measure: '1 L' });
  assert.equal(products[0].currency, 'EUR');
  assert.equal(products[1].in_stock, false);
});

test('Lidl uses regional regular price before loyalty price', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'regular', fullTitle: 'Milk', regionsPrices: { '1': {
      currentPrice: { price: '€2.79' },
      currentLidlPlusPrice: { price: { price: '€1.99' } },
    } },
  } } }] };
  const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(product.retail_price.price, 2.79);
});

test('Lidl uses the old regular price next to a loyalty offer', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'regular', fullTitle: 'Milk', regionsPrices: { '1': {
      currentLidlPlusPrice: { price: { price: '€1.99', oldPrice: '€2.49' } },
    } },
  } } }] };
  const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(product.retail_price.price, 2.49);
});

test('Lidl preserves unknown stock when badges conflict', async () => {
  const payload = fixture();
  payload.items.push({ gridbox: { data: {
    id: 'conflict', fullTitle: '--- Milk', price: { price: 1.50 },
    stockAvailability: { badgeInfo: { badges: [{ text: 'In stock' }, { text: 'Out of stock' }] } },
  } } });
  const products = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(products[2].name, 'Milk');
  assert.equal(products[2].in_stock, null);
});

test('Lidl rejects a malformed shelf and loyalty-only pricing', async () => {
  const malformed = new LidlIrelandProvider({ fetcher: fetchWith({ items: 'bad' }) });
  await assert.rejects(() => malformed.search('milk'), /items|array|protocol/i);
  const loyaltyOnly = new LidlIrelandProvider({ fetcher: fetchWith({ items: [{ gridbox: { data: {
    id: 'loyalty', fullTitle: 'Milk',
    regionsPrices: { '1': { currentLidlPlusPrice: { price: { price: 1.99 } } } },
  } } }] }) });
  await assert.rejects(() => loyaltyOnly.search('milk'), /valid products|retail price|malformed/i);
});

test('Lidl rejects blank searches before calling the retailer', async () => {
  const calls = [];
  const provider = new LidlIrelandProvider({ fetcher: fetchWith(fixture(), calls) });
  await assert.rejects(() => provider.search('  '), /query must not be empty/);
  assert.equal(calls.length, 0);
});
