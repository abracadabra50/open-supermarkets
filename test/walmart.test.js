'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { WalmartProvider } = require('../src/providers/walmart.ts');
const { getManifest, loginHint } = require('../src/providers/registry.ts');

const fixture = () => JSON.parse(readFileSync(join(__dirname, 'fixtures/walmart-search.json'), 'utf8'));

function respond(status, body, calls = []) {
  return async (input, init) => {
    calls.push({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
    };
  };
}

const provider = (fetcher, extra = {}) => new WalmartProvider({ fetcher, apiKey: 'test-key', ...extra });

test('Walmart manifest exposes keyed search only', () => {
  const manifest = getManifest('walmart');
  assert.equal(manifest.country, 'US');
  assert.deepEqual(manifest.capabilities, ['search']);
  assert.equal(manifest.auth, 'api-key');
  assert.equal(manifest.tier, 'community');
  assert.equal(manifest.session, undefined);
  assert.doesNotMatch(loginHint('walmart'), /import-session/);
});

test('Walmart needs a Scavio key before any network work', () => {
  const saved = process.env.SCAVIO_API_KEY;
  delete process.env.SCAVIO_API_KEY;
  try {
    assert.throws(() => new WalmartProvider({ fetcher: respond(200, fixture()) }), /SCAVIO_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.SCAVIO_API_KEY = saved;
  }
});

test('Walmart store targeting takes a store id and ZIP together', () => {
  const fetcher = respond(200, fixture());
  assert.throws(() => provider(fetcher, { storeId: '4376' }), /together/);
  assert.throws(() => provider(fetcher, { zip: '72712' }), /together/);
  assert.throws(() => provider(fetcher, { storeId: 'abc', zip: '72712' }), /numeric/);
  assert.throws(() => provider(fetcher, { storeId: '4376', zip: '7271' }), /5-digit/);
});

test('Walmart posts the query with the key and no store by default', async () => {
  const calls = [];
  await provider(respond(200, fixture(), calls)).search('  nutella ');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.scavio.dev/api/v1/walmart/search');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'nutella' });
});

test('Walmart sends the store id and ZIP when both are set', async () => {
  const calls = [];
  await provider(respond(200, fixture(), calls), { storeId: '4376', zip: '72712' }).search('nutella');
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'nutella', store_id: '4376', delivery_zip: '72712' });
});

test('Walmart keeps items Walmart sells and maps price, stock and ratings', async () => {
  const products = await provider(respond(200, fixture())).search('nutella');
  assert.deepEqual(products.map((p) => p.product_uid), ['21198173695', '17855305415', '10451273', '1205673170']);
  const jar = products[2];
  assert.equal(jar.name, 'Nutella Hazelnut Spread with Cocoa, Creamy Hazelnut Spread, Breakfast Favorite, 13 oz Jar');
  assert.equal(jar.retail_price.price, 4.47);
  assert.equal(jar.currency, 'USD');
  assert.equal(jar.in_stock, true);
  assert.equal(jar.rating, 4.7);
  assert.equal(jar.review_count, 43698);
  assert.equal(jar.provider, 'walmart');
  assert.match(jar.image_url, /^https:\/\/i5\.walmartimages\.com\//);
  // No rating is unknown, not zero.
  assert.equal(products[0].rating, undefined);
  assert.equal(products[0].review_count, undefined);
  assert.equal(products[3].in_stock, false);
});

test('Walmart keeps unknown price and stock unknown', async () => {
  const body = fixture();
  const row = body.data.products[1];
  delete row.price;
  delete row.out_of_stock;
  const [, product] = await provider(respond(200, body)).search('nutella');
  assert.equal(product.retail_price.price, null);
  assert.equal(product.in_stock, null);
});

test('Walmart honours limit and refuses offset before the request', async () => {
  const calls = [];
  const p = provider(respond(200, fixture(), calls));
  assert.equal((await p.search('nutella', { limit: 2 })).length, 2);
  await assert.rejects(p.search('nutella', { offset: 10 }), /offset/);
  await assert.rejects(p.search('   '), /empty/);
  assert.equal(calls.length, 1);
});

test('Walmart returns an empty list only for an empty shelf', async () => {
  const body = fixture();
  body.data.products = [];
  assert.deepEqual(await provider(respond(200, body)).search('nutella'), []);
});

test('Walmart rejects malformed responses', async () => {
  await assert.rejects(provider(respond(200, { data: {} })).search('nutella'), /missing or malformed products list/);
  await assert.rejects(provider(respond(200, 'not json')).search('nutella'), /invalid response/);
  const nameless = fixture();
  for (const row of nameless.data.products) delete row.seller_name;
  await assert.rejects(provider(respond(200, nameless)).search('nutella'), /no seller names/);
  const broken = fixture();
  for (const row of broken.data.products) delete row.id;
  await assert.rejects(provider(respond(200, broken)).search('nutella'), /no valid products/);
});

test('Walmart surfaces key, credit, rate and upstream errors', async () => {
  await assert.rejects(provider(respond(401, { error: 'Invalid API key' })).search('nutella'), /SCAVIO_API_KEY/);
  await assert.rejects(provider(respond(402, { error: 'Insufficient credits' })).search('nutella'), /out of credits/);
  await assert.rejects(provider(respond(429, { error: 'Too many requests' })).search('nutella'), /rate limit/);
  await assert.rejects(provider(respond(502, { error: 'Bad gateway' })).search('nutella'), /HTTP 502/);
});
