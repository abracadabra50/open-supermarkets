'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const jsonFixture = (name) => JSON.parse(fixture(name));

const {
  AldiIrelandProvider,
} = require('../dist/providers/aldi-ie.js');
const {
  LidlIrelandProvider,
} = require('../dist/providers/lidl-ie.js');
const {
  MrPriceIrelandProvider,
} = require('../dist/providers/mrprice-ie.js');
const {
  DunnesIrelandProvider,
} = require('../dist/providers/dunnes-ie.js');
const {
  SuperValuIrelandProvider,
} = require('../dist/providers/supervalu-ie.js');
const {
  TescoIrelandProvider,
} = require('../dist/providers/tesco-ie.js');
const shared = require('../dist/providers/ie/shared.js');
const {
  assess: assessLiveProbe,
  evaluateRun: evaluateLiveProbeRun,
  hardFailureReason: liveProbeHardFailureReason,
  parseArgs: parseLiveProbeArgs,
  providerFor: liveProbeProviderFor,
} = require('../scripts/live-probe.js');

function response(body, status = 200, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    async text() {
      return text;
    },
  };
}

function queueFetch(entries, calls = []) {
  const queue = [...entries];
  const fetcher = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    if (queue.length === 0) {
      throw new Error(`Unexpected fetch: ${call.url}`);
    }
    const next = queue.shift();
    if (typeof next === 'function') return next(call);
    if (next && Object.prototype.hasOwnProperty.call(next, 'body')) {
      return response(next.body, next.status ?? 200, next.headers ?? {});
    }
    return response(next);
  };
  fetcher.remaining = () => queue.length;
  return fetcher;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function rejects(fn, pattern) {
  await assert.rejects(fn, pattern);
}

// ---------------------------------------------------------------------------
// Shared contract and safety helpers
// ---------------------------------------------------------------------------

test('shared: requireQuery trims input', () => {
  assert.equal(shared.requireQuery('  milk  '), 'milk');
});

test('shared: requireQuery rejects empty input', () => {
  assert.throws(() => shared.requireQuery('   '), /query must not be empty/);
});

test('shared: clampLimit defaults and caps', () => {
  assert.equal(shared.clampLimit(undefined, 10, 50), 10);
  assert.equal(shared.clampLimit(100, 10, 50), 50);
});

test('shared: clampLimit rejects invalid numbers', () => {
  assert.throws(() => shared.clampLimit(0), /positive integer/);
  assert.throws(() => shared.clampLimit(1.5), /positive integer/);
});

test('shared: clampOffset rejects negative values', () => {
  assert.throws(() => shared.clampOffset(-1), /non-negative integer/);
});

test('shared: compactSnippet redacts common credential labels', () => {
  const value = shared.compactSnippet('Cookie: abc123 Authorization=Bearer-secret api_key=hello');
  assert.equal(value.includes('abc123'), false);
  assert.equal(value.includes('Bearer-secret'), false);
  assert.equal(value.includes('hello'), false);
});

test('shared: compactSnippet fully redacts standard auth and cookie headers', () => {
  const value = shared.compactSnippet(
    `Authorization: Bearer ${['fixture', 'bearer', 'value', '123'].join('-')}\nCookie: sid=${['fixture', 'cookie', 'value', '456'].join('-')}; refresh=two\nmessage: denied`
  );
  assert.equal(value.includes(['fixture', 'bearer', 'value', '123'].join('-')), false);
  assert.equal(value.includes(`sid=${['fixture', 'cookie', 'value', '456'].join('-')}`), false);
  assert.equal(value.includes('refresh=two'), false);
  assert.match(value, /Authorization=\[redacted\]/i);
  assert.match(value, /Cookie=\[redacted\]/i);
});

test('shared: compactSnippet redacts credential values in quoted JSON', () => {
  const value = shared.compactSnippet(
    JSON.stringify({ Authorization: `Bearer ${['fixture', 'json', 'bearer', 'value'].join('-')}`, Cookie: `sid=${['fixture', 'json', 'cookie', 'value'].join('-')}`, error: 'denied' })
  );
  assert.equal(value.includes(['fixture', 'json', 'bearer', 'value'].join('-')), false);
  assert.equal(value.includes(`sid=${['fixture', 'json', 'cookie', 'value'].join('-')}`), false);
  assert.match(value, /\[redacted\]/);
  assert.match(value, /denied/);
});

test('shared: compactSnippet redacts quoted headers and OAuth token fields', () => {
  const header = shared.compactSnippet(
    `Authorization: "Bearer ${['fixture', 'access', 'value', '789'].join('-')}"\nmessage: denied`
  );
  const json = shared.compactSnippet(
    JSON.stringify({ 'OAuth.AccessToken': ['fixture', 'oauth', 'value', '123'].join('-'), 'x-apikey': ['fixture', 'api', 'value', '456'].join('-'), accessToken: ['fixture', 'access', 'value', '789'].join('-'), refresh_token: ['fixture', 'refresh', 'value', '012'].join('-'), client_secret: ['fixture', 'client', 'value', '345'].join('-'), message: 'denied' })
  );
  assert.equal(header.includes(['fixture', 'access', 'value', '789'].join('-')), false);
  assert.equal(json.includes(['fixture', 'oauth', 'value', '123'].join('-')), false);
  assert.equal(json.includes(['fixture', 'api', 'value', '456'].join('-')), false);
  assert.equal(json.includes(['fixture', 'access', 'value', '789'].join('-')), false);
  assert.equal(json.includes(['fixture', 'refresh', 'value', '012'].join('-')), false);
  assert.equal(json.includes(['fixture', 'client', 'value', '345'].join('-')), false);
  assert.match(header, /denied/);
  assert.match(json, /denied/);
});

test('shared: absoluteUrl accepts HTTP links and rejects active-content schemes', () => {
  assert.equal(
    shared.absoluteUrl('https://shop.example.test/base/', '/image.jpg'),
    'https://shop.example.test/image.jpg'
  );
  assert.equal(shared.absoluteUrl('https://shop.example.test/', 'javascript:alert(1)'), undefined);
  assert.equal(shared.absoluteUrl('https://shop.example.test/', 'data:text/html,hello'), undefined);
});

test('shared: jsonResponse rejects non-JSON success bodies', async () => {
  await rejects(
    () => shared.jsonResponse(response('<html>challenge</html>'), 'Test provider'),
    /expected JSON/
  );
});

test('shared: jsonResponse preserves HTTP status without dumping secrets', async () => {
  await rejects(
    () => shared.jsonResponse(response('Cookie: top-secret', 403), 'Test provider'),
    (error) => error.status === 403 && !error.message.includes('top-secret')
  );
});

// ---------------------------------------------------------------------------
// Aldi Ireland
// ---------------------------------------------------------------------------

test('aldi: sends Irish currency, walk-in service, query, and offset', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([jsonFixture('aldi-search.json')], calls),
  });
  await provider.search('milk', { limit: 10, offset: 12 });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('q'), 'milk');
  assert.equal(url.searchParams.get('currency'), 'EUR');
  assert.equal(url.searchParams.get('serviceType'), 'walk-in');
  assert.equal(url.searchParams.get('offset'), '12');
});

test('aldi: rounds request size to an API-supported page size', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([jsonFixture('aldi-search.json')], calls),
  });
  await provider.search('milk', { limit: 13 });
  assert.equal(new URL(calls[0].url).searchParams.get('limit'), '16');
});

test('aldi: maps brand, price, EUR, and stable SKU', async () => {
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([jsonFixture('aldi-search.json')]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.product_uid, 'aldi-1001');
  assert.equal(product.name, 'Clonbawn Fresh Irish Milk');
  assert.equal(product.retail_price.price, 1.39);
  assert.equal(product.currency, 'EUR');
});

test('aldi: converts documented minor-unit prices when display price is absent', async () => {
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([
      {
        data: [
          {
            sku: 'aldi-live-shape-239',
            name: 'Fallback Milk',
            price: { amountRelevant: 239 },
          },
        ],
      },
    ]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.retail_price.price, 2.39);
});

test('aldi: maps unit price, size, and image template', async () => {
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([jsonFixture('aldi-search.json')]),
  });
  const [product] = await provider.search('milk');
  assert.deepEqual(product.unit_price, { price: 1.2, measure: '1 L' });
  assert.equal(product.size, '2 L');
  assert.equal(
    product.image_url,
    'https://dm.example.test/600/clonbawn-fresh-irish-milk.jpg'
  );
});

test('aldi: reports unknown availability when product stock is absent', async () => {
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([jsonFixture('aldi-search.json')]),
  });
  const products = await provider.search('yogurt');
  assert.equal(products[1].in_stock, null);
});

test('aldi: maps only explicit product availability fields to stock', async () => {
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([{ data: [
      { sku: 'available', name: 'Available Milk', price: { amountRelevant: 199 }, available: true },
      { sku: 'unavailable', name: 'Unavailable Milk', price: { amountRelevant: 199 }, outOfStock: true },
      {
        sku: 'conflicting',
        name: 'Conflicting Milk',
        price: { amountRelevant: 199 },
        available: true,
        outOfStock: true,
      },
    ] }]),
  });
  const products = await provider.search('milk');
  assert.deepEqual(products.map((product) => product.in_stock), [true, false, null]);
});

test('aldi: lists anonymous walk-in stores using the official service-point schema', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([jsonFixture('aldi-stores.json')], calls),
  });
  const stores = await provider.listStores({
    limit: 4,
    offset: 2,
    fullTextSearch: 'Dublin',
  });
  assert.deepEqual(stores, [{
    store_id: 'D001', name: "King's Court, Parnell Street Unit 6/7", postcode: 'D01 F295',
    address: "King's Court, Parnell Street Unit 6/7, Dublin, Ireland",
    location: { latitude: 53.35028, longitude: -6.26599 }, shopping_modes: ['walk-in'],
  }]);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('offset'), '2');
  assert.equal(url.searchParams.get('limit'), '4');
  assert.equal(url.searchParams.get('serviceType'), 'walk-in');
  assert.equal(url.searchParams.get('fullTextSearch'), 'Dublin');
  assert.equal(url.searchParams.get('addressZipcode'), null);
  assert.equal(url.searchParams.get('includeNearbyServicePoints'), null);
});

test('aldi: sends the official postcode and nearby-store query parameters', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([jsonFixture('aldi-stores.json'), jsonFixture('aldi-stores.json')], calls),
  });
  await provider.listStores({ postcode: 'D01 F295' });
  await provider.listStores({ limit: 4, latitude: 53.35, longitude: -6.26 });
  const postcodeUrl = new URL(calls[0].url);
  assert.equal(postcodeUrl.searchParams.get('addressZipcode'), 'D01 F295');
  assert.equal(postcodeUrl.searchParams.get('postcode'), null);
  const nearbyUrl = new URL(calls[1].url);
  assert.equal(nearbyUrl.searchParams.get('latitude'), '53.35');
  assert.equal(nearbyUrl.searchParams.get('longitude'), '-6.26');
  assert.equal(nearbyUrl.searchParams.get('includeNearbyServicePoints'), 'true');
});

test('aldi: validates selected service points and scopes search with uppercase servicePoint', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([jsonFixture('aldi-stores.json'), jsonFixture('aldi-search.json')], calls),
  });
  await provider.selectStore('d001');
  await provider.search('milk');
  assert.equal(new URL(calls[1].url).searchParams.get('servicePoint'), 'D001');
});

test('aldi: rejects incomplete store coordinates and unknown service points', async () => {
  const provider = new AldiIrelandProvider({ fetcher: queueFetch([]) });
  await rejects(() => provider.listStores({ latitude: 53.35 }), /latitude and longitude/);
  await rejects(
    () => provider.listStores({ fullTextSearch: 'Dublin', latitude: 53.35, longitude: -6.26 }),
    /fullTextSearch cannot be combined/
  );
  await rejects(
    () => provider.listStores({ fullTextSearch: 'Dublin', postcode: 'D01 F295' }),
    /fullTextSearch cannot be combined with postcode/
  );
  await rejects(
    () => provider.listStores({ postcode: 'D01 F295', latitude: 53.35, longitude: -6.26 }),
    /postcode cannot be combined with coordinates/
  );
  await rejects(() => provider.listStores({ range: 5 }), /does not support a range filter/);
  await rejects(
    () => provider.listStores({ shoppingMode: 'delivery' }),
    /walk-in service points only/
  );
  await rejects(
    () => provider.listStores({ retailerStoreId: 'D001' }),
    /does not support retailerStoreId filtering/
  );
  const unknown = new AldiIrelandProvider({ fetcher: queueFetch([jsonFixture('aldi-stores.json')]) });
  await rejects(() => unknown.selectStore('d999'), /service point D999 was not found/);
});

test('aldi: falls back to the legacy host only for a missing primary route', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([
      { body: 'not found', status: 404 },
      jsonFixture('aldi-search.json'),
    ], calls),
  });
  const products = await provider.search('milk');
  assert.equal(products.length, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /api\.aldi\.ie/);
});

test('aldi: does not retry a blocked request against another host', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([{ body: 'forbidden', status: 403 }], calls),
  });
  await rejects(() => provider.search('milk'), /HTTP 403/);
  assert.equal(calls.length, 1);
});

test('aldi: rejects an empty query before networking', async () => {
  const calls = [];
  const provider = new AldiIrelandProvider({ fetcher: queueFetch([], calls) });
  await rejects(() => provider.search(' '), /query must not be empty/);
  assert.equal(calls.length, 0);
});

test('aldi: rejects a malformed product collection instead of returning an empty shelf', async () => {
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([{ data: 'wrong-shape' }]),
  });
  await rejects(() => provider.search('milk'), /data|array|protocol/i);
});

test('aldi: does not invent identity, price, or stock for a malformed row', async () => {
  const provider = new AldiIrelandProvider({
    fetcher: queueFetch([{ data: [{}] }]),
  });
  await rejects(() => provider.search('milk'), /valid product|identifier|price|malformed/i);
});

// ---------------------------------------------------------------------------
// Lidl Ireland
// ---------------------------------------------------------------------------

test('lidl: sends IE assortment, locale, version, offset, and media type', async () => {
  const calls = [];
  const provider = new LidlIrelandProvider({
    fetcher: queueFetch([jsonFixture('lidl-search.json')], calls),
  });
  await provider.search('milk', { limit: 8, offset: 16 });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('assortment'), 'IE');
  assert.equal(url.searchParams.get('category.id'), '10068374');
  assert.equal(url.searchParams.get('locale'), 'en_IE');
  assert.equal(url.searchParams.get('version'), '2.1.0');
  assert.equal(url.searchParams.get('offset'), '16');
  assert.equal(calls[0].init.headers.Accept, 'application/mindshift.search+json');
});

test('lidl: keeps regular price separate from Lidl Plus evidence', async () => {
  const provider = new LidlIrelandProvider({
    fetcher: queueFetch([jsonFixture('lidl-search.json')]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.retail_price.price, 2.25);
  assert.equal(product.in_stock, null);
});

test('lidl: falls back to the regional current regular price', async () => {
  const provider = new LidlIrelandProvider({
    fetcher: queueFetch([{
      items: [{
        gridbox: {
          data: {
            id: 'lidl-current-price',
            fullTitle: 'Regional current price',
            regionsPrices: {
              '1': { currentPrice: { price: '€2.79' } },
            },
          },
        },
      }],
    }]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.retail_price.price, 2.79);
});

test('lidl: falls back to the regular old price beside a Lidl Plus offer', async () => {
  const provider = new LidlIrelandProvider({
    fetcher: queueFetch([{
      items: [{
        gridbox: {
          data: {
            id: 'lidl-old-price',
            fullTitle: 'Regional old price',
            regionsPrices: {
              '1': {
                currentLidlPlusPrice: { price: { price: '€1.99', oldPrice: '€2.49' } },
              },
            },
          },
        },
      }],
    }]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.retail_price.price, 2.49);
});

test('lidl: maps unit price, package size, image, and EUR', async () => {
  const provider = new LidlIrelandProvider({
    fetcher: queueFetch([jsonFixture('lidl-search.json')]),
  });
  const [product] = await provider.search('milk');
  assert.deepEqual(product.unit_price, { price: 1.13, measure: '1 L' });
  assert.equal(product.size, '2 L');
  assert.equal(product.image_url, 'https://img.example.test/milk.jpg');
  assert.equal(product.currency, 'EUR');
});

test('lidl: detects out-of-stock badges', async () => {
  const payload = jsonFixture('lidl-search.json');
  payload.items.push({
    gridbox: {
      data: {
        id: 'lidl-in-stock',
        fullTitle: '--- Explicitly Available Milk',
        price: { price: 1.99 },
        stockAvailability: { badgeInfo: { badges: [{ text: 'In stock' }] } },
      },
    },
  }, {
    gridbox: {
      data: {
        id: 'lidl-conflicting-stock',
        fullTitle: 'Conflicting Stock Milk',
        price: { price: 1.89 },
        stockAvailability: {
          badgeInfo: { badges: [{ text: 'In stock' }, { text: 'Out of stock' }] },
        },
      },
    },
  });
  const provider = new LidlIrelandProvider({
    fetcher: queueFetch([payload]),
  });
  const products = await provider.search('milk');
  assert.deepEqual(products.map((product) => product.in_stock), [null, false, true, null]);
  assert.equal(products[2].name, 'Explicitly Available Milk');
});

test('lidl: rejects malformed item collections instead of returning an empty shelf', async () => {
  const provider = new LidlIrelandProvider({ fetcher: queueFetch([{ items: 'bad' }]) });
  await rejects(() => provider.search('milk'), /items|array|protocol/i);
});

test('lidl: rejects loyalty-only prices instead of inventing a regular retail price', async () => {
  const provider = new LidlIrelandProvider({
    fetcher: queueFetch([{
      items: [{
        gridbox: {
          data: {
            id: 'lidl-loyalty-only',
            fullTitle: 'Loyalty-only price',
            regionsPrices: {
              '1': { currentLidlPlusPrice: { price: { price: 1.99 } } },
            },
          },
        },
      }],
    }]),
  });
  await rejects(() => provider.search('milk'), /valid product|retail price|malformed/i);
});

test('lidl: rejects an empty query before networking', async () => {
  const calls = [];
  const provider = new LidlIrelandProvider({ fetcher: queueFetch([], calls) });
  await rejects(() => provider.search(''), /query must not be empty/);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Mr Price Ireland
// ---------------------------------------------------------------------------

test('mrprice: calls Shopify predictive search with a bounded product limit', async () => {
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([jsonFixture('mrprice-predictive.json')], calls),
  });
  await provider.search('milk', { limit: 5 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/search/suggest.json');
  assert.equal(url.searchParams.get('resources[type]'), 'product');
  assert.equal(url.searchParams.get('resources[limit]'), '5');
});

test('mrprice: converts Shopify cents, resolves image URLs, and maps stock', async () => {
  const payload = jsonFixture('mrprice-predictive.json');
  payload.resources.results.products.push({
    id: 'gid://shopify/Product/3003',
    title: 'Unmarked Milk 1L',
    price: 1.29,
    url: '/products/unmarked-milk-1l',
  });
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([payload]),
  });
  const products = await provider.search('milk');
  assert.equal(products[0].retail_price.price, 1.79);
  assert.equal(products[0].image_url, 'https://cdn.example.test/milk.jpg');
  assert.deepEqual(products.map((product) => product.in_stock), [true, false, null]);
});

test('mrprice: converts sub-euro integer cents without treating them as euros', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([{
      resources: {
        results: {
          products: [{
            id: 'gid://shopify/Product/99',
            title: 'Small item',
            price: '99',
            url: '/products/small-item',
            available: true,
          }],
        },
      },
    }]),
  });
  const [product] = await provider.search('small');
  assert.equal(product.retail_price.price, 0.99);
});

test('mrprice: applies SearchOptions.offset to predictive results', async () => {
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([jsonFixture('mrprice-predictive.json')], calls),
  });
  const products = await provider.search('milk', { limit: 1, offset: 1 });
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Long Life Milk 1L');
  assert.equal(new URL(calls[0].url).searchParams.get('resources[limit]'), '2');
});

test('mrprice: falls back to the full HTML grid when predictive search is empty', async () => {
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      fixture('mrprice-search.html'),
    ], calls),
  });
  const products = await provider.search('milk');
  assert.equal(calls.length, 2);
  assert.equal(products[0].name, 'Oat Milk 1L');
  assert.equal(products[0].retail_price.price, 1.99);
});

test('mrprice: HTML fallback detects stock and expands image templates', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      fixture('mrprice-search.html'),
    ]),
  });
  const products = await provider.search('milk');
  assert.equal(products[0].image_url, 'https://cdn.example.test/400/oat.jpg');
  assert.equal(products[0].in_stock, null);
  assert.equal(products[1].name, 'Almond Milk 1L');
  assert.equal(products[1].in_stock, false);
});

test('mrprice: high offsets use the full HTML grid beyond the predictive cap', async () => {
  const predictiveProducts = Array.from({ length: 20 }, (_, index) => ({
    id: `predictive-${index}`,
    title: `Predictive ${index}`,
    price: 199,
    url: `/products/predictive-${index}`,
  }));
  const cards = Array.from({ length: 22 }, (_, index) =>
    `<div class="product-card" data-price="${200 + index}">` +
      `<a href="/products/html-${index}">HTML ${index}</a></div>`
  ).join('');
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: predictiveProducts } } },
      `<div id="js-product-ajax">${cards}</div>`,
    ], calls),
  });

  const products = await provider.search('milk', { limit: 2, offset: 20 });
  assert.equal(calls.length, 2);
  assert.deepEqual(products.map((product) => product.name), ['HTML 20', 'HTML 21']);
});

test('mrprice: rejects a challenge page that lacks the search results grid', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      '<!doctype html><html><body>CAPTCHA challenge</body></html>',
    ]),
  });

  await rejects(() => provider.search('milk'), /search results grid/);
});

test('mrprice: accepts a credible empty HTML search grid', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      '<main><div id="js-product-ajax"></div></main>',
    ]),
  });

  assert.deepEqual(await provider.search('missing-product'), []);
});

test('mrprice: ignores recommendation cards outside the search results grid', async () => {
  const recommendation =
    '<div class="product-card" data-price="999">' +
      '<a href="/products/recommendation">Recommendation</a></div>';
  const result =
    '<div class="product-card" data-price="249">' +
      '<a href="/products/search-result">Search Result</a></div>';
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([
      { resources: { results: { products: [] } } },
      `${recommendation}<div id="js-product-ajax">${result}</div>${recommendation}`,
    ]),
  });

  const products = await provider.search('milk');
  assert.deepEqual(products.map((product) => product.name), ['Search Result']);
});

test('mrprice: rejects malformed predictive data instead of hiding schema drift', async () => {
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([{ resources: { results: { products: 'wrong-shape' } } }]),
  });
  await rejects(() => provider.search('milk'), /products|array|protocol/i);
});

test('mrprice: does not hide a predictive endpoint server error', async () => {
  const calls = [];
  const provider = new MrPriceIrelandProvider({
    fetcher: queueFetch([{ body: 'server error', status: 500 }], calls),
  });
  await rejects(() => provider.search('milk'), /HTTP 500/);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Dunnes Stores Ireland
// ---------------------------------------------------------------------------

test('dunnes: explicit VTEX mode remains a read-only general-retail probe', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    transport: 'vtex',
    fetcher: queueFetch([jsonFixture('dunnes-vtex.json')], calls),
  });
  await provider.search('milk', { limit: 5, offset: 5 });
  assert.match(calls[0].url, /dunnesstores\.com\/_v\/segment\/graphql\/v1/);
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.query, /productSearch/);
  assert.match(body.query, /from: 5, to: 9/);
  assert.doesNotMatch(body.query, /mutation/i);
});

test('dunnes: maps VTEX price, SKU, image, and currency', async () => {
  const provider = new DunnesIrelandProvider({
    transport: 'vtex',
    fetcher: queueFetch([jsonFixture('dunnes-vtex.json')]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.product_uid, 'SKU-4001');
  assert.equal(product.retail_price.price, 2.45);
  assert.equal(product.image_url, 'https://img.example.test/dunnes-milk.jpg');
  assert.equal(product.currency, 'EUR');
});

test('dunnes: maps zero available quantity as out of stock', async () => {
  const provider = new DunnesIrelandProvider({
    transport: 'vtex',
    fetcher: queueFetch([jsonFixture('dunnes-vtex.json')]),
  });
  const products = await provider.search('milk');
  assert.deepEqual(products.map((product) => product.in_stock), [true, false]);

  const unknownProvider = new DunnesIrelandProvider({
    transport: 'vtex',
    fetcher: queueFetch([{
      data: {
        productSearch: {
          products: [{
            productName: 'Unknown Stock Milk',
            items: [{
              itemId: 'SKU-UNKNOWN-STOCK',
              sellers: [{ commertialOffer: { Price: 2.1 } }],
            }],
          }],
        },
      },
    }]),
  });
  const [unknownProduct] = await unknownProvider.search('milk');
  assert.equal(unknownProduct.in_stock, null);
});

test('dunnes: uses a priced later seller when the first seller has no offer', async () => {
  const provider = new DunnesIrelandProvider({
    transport: 'vtex',
    fetcher: queueFetch([{
      data: {
        productSearch: {
          products: [{
            productName: 'Irish Milk 2L',
            items: [{
              itemId: 'milk-2l',
              sellers: [
                { commertialOffer: {} },
                { commertialOffer: { Price: 2.79, AvailableQuantity: 4 } },
              ],
            }],
          }],
        },
      },
    }]),
  });

  const [product] = await provider.search('milk');
  assert.equal(product.product_uid, 'milk-2l');
  assert.equal(product.retail_price.price, 2.79);
  assert.equal(product.in_stock, true);
});

test('dunnes: surfaces GraphQL errors instead of returning an empty shelf', async () => {
  const provider = new DunnesIrelandProvider({
    transport: 'vtex',
    fetcher: queueFetch([{ errors: [{ message: 'query rejected' }] }]),
  });
  await rejects(() => provider.search('milk'), /query rejected/);
});

test('dunnes: default grocery gateway requires an explicit store ID', async () => {
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([]),
  });
  await rejects(() => provider.search('milk'), /store-scoped/);
});

test('dunnes: lists and normalizes anonymous stores by retailer store id', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([jsonFixture('dunnes-stores.json')], calls),
  });
  const stores = await provider.listStores({ limit: 4, retailerStoreId: '258' });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/stores');
  assert.equal(url.searchParams.get('Take'), '4');
  assert.equal(url.searchParams.get('RetailerStoreId'), '258');
  assert.deepEqual(stores, [{
    store_id: '258',
    name: 'Beacon Court',
    status: 'active',
    currency: 'EUR',
    postcode: 'D18 PT97',
    address: 'Unit C2-C5, The Courtyard, Beacon South Quarter, Dublin 18, Ireland',
    location: { latitude: 53.2777612, longitude: -6.2160268 },
    shopping_modes: ['pickup', 'delivery'],
  }]);
});

test('dunnes: uses the nearby store endpoint and delivery mode id', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([jsonFixture('dunnes-stores.json')], calls),
  });
  await provider.listStores({
    limit: 3,
    latitude: 53.2777612,
    longitude: -6.2160268,
    range: 12.5,
    shoppingMode: 'delivery',
  });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/near/53.2777612/-6.2160268/12.5/3/stores');
  assert.equal(url.searchParams.get('shoppingModeId'), '22222222-2222-2222-2222-222222222222');
});

test('dunnes: validates a selected store before binding gateway search', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([
      jsonFixture('dunnes-stores.json'),
      jsonFixture('dunnes-gateway.json'),
    ], calls),
  });
  await provider.selectStore('258');
  await provider.search('milk');
  assert.equal(new URL(calls[0].url).searchParams.get('RetailerStoreId'), '258');
  assert.equal(new URL(calls[1].url).pathname, '/api/stores/258/search');
});

test('dunnes: rejects an unverified store id and incomplete coordinates', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    fetcher: queueFetch([jsonFixture('dunnes-stores.json')], calls),
  });
  await rejects(() => provider.selectStore('999'), /retailer store 999 was not found/);
  await rejects(() => provider.search('milk'), /store-scoped/);
  await rejects(() => provider.listStores({ latitude: 53.2 }), /latitude and longitude/);
  assert.equal(calls.length, 1);
});

test('dunnes: gateway mode sends store, correlation, and shopping-mode context', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    transport: 'gateway',
    storeId: '258',
    fetcher: queueFetch([jsonFixture('dunnes-gateway.json')], calls),
  });
  await provider.search('milk', { limit: 4, offset: 8 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/stores/258/search');
  assert.equal(url.searchParams.get('skip'), '8');
  assert.ok(calls[0].init.headers['x-correlation-id']);
  assert.ok(calls[0].init.headers['x-shopping-mode']);
});

test('dunnes: gateway mode maps price and unit price', async () => {
  const payload = jsonFixture('dunnes-gateway.json');
  payload.items.push(
    { sku: 'DG-5002', name: 'Unavailable Milk', priceNumeric: 1.99, available: false },
    { sku: 'DG-5003', name: 'Unknown Stock Milk', priceNumeric: 1.89 }
  );
  const provider = new DunnesIrelandProvider({
    transport: 'gateway',
    storeId: '258',
    fetcher: queueFetch([payload]),
  });
  const products = await provider.search('milk');
  const [product] = products;
  assert.equal(product.retail_price.price, 2.49);
  assert.deepEqual(product.unit_price, { price: 1.25, measure: 'L' });
  assert.deepEqual(products.map((item) => item.in_stock), [true, false, null]);
});

test('dunnes: gateway sends an optional user-owned cookie only when supplied', async () => {
  const calls = [];
  const provider = new DunnesIrelandProvider({
    transport: 'gateway',
    storeId: '258',
    cookieHeader: 'session=user-owned',
    fetcher: queueFetch([jsonFixture('dunnes-gateway.json')], calls),
  });
  await provider.search('milk');
  assert.equal(calls[0].init.headers.Cookie, 'session=user-owned');
});

test('dunnes: rejects malformed VTEX collections instead of returning an empty shelf', async () => {
  const provider = new DunnesIrelandProvider({
    transport: 'vtex',
    fetcher: queueFetch([{ data: { productSearch: { products: 'wrong-shape' } } }]),
  });
  await rejects(() => provider.search('milk'), /products|array|protocol/i);
});

// ---------------------------------------------------------------------------
// SuperValu Ireland
// ---------------------------------------------------------------------------

test('supervalu: refuses to present a default store as national pricing', async () => {
  const provider = new SuperValuIrelandProvider({ fetcher: queueFetch([]) });
  await rejects(() => provider.search('milk'), /requires a store id/);
});

test('supervalu: lists and normalizes anonymous stores by retailer store id', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([jsonFixture('supervalu-stores.json')], calls),
  });
  const stores = await provider.listStores({ limit: 2, retailerStoreId: '5550' });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/stores');
  assert.equal(url.searchParams.get('Take'), '2');
  assert.equal(url.searchParams.get('RetailerStoreId'), '5550');
  assert.deepEqual(stores, [{
    store_id: '5550',
    name: 'SuperValu Online',
    status: 'active',
    currency: 'EUR',
    postcode: 'T12 N799',
    address: 'Test Site, Cork, Ireland',
    location: { latitude: 0, longitude: 0 },
    shopping_modes: ['pickup', 'delivery'],
  }]);
});

test('supervalu: uses the nearby store endpoint and pickup mode id', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([jsonFixture('supervalu-stores.json')], calls),
  });
  await provider.listStores({
    limit: 3,
    latitude: 53.338671,
    longitude: -9.179969,
    range: 8,
    shoppingMode: 'pickup',
  });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/near/53.338671/-9.179969/8/3/stores');
  assert.equal(url.searchParams.get('shoppingModeId'), '11111111-1111-1111-1111-111111111111');
});

test('supervalu: validates a selected store before binding gateway search', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([
      jsonFixture('supervalu-stores.json'),
      jsonFixture('supervalu-gateway.json'),
    ], calls),
  });
  await provider.selectStore('5550');
  await provider.search('milk');
  assert.equal(new URL(calls[0].url).searchParams.get('RetailerStoreId'), '5550');
  assert.equal(new URL(calls[1].url).pathname, '/api/stores/5550/search');
});

test('supervalu: rejects an unverified store id and a mode without coordinates', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    fetcher: queueFetch([jsonFixture('supervalu-stores.json')], calls),
  });
  await rejects(() => provider.selectStore('999'), /retailer store 999 was not found/);
  await rejects(() => provider.search('milk'), /requires a store id/);
  await rejects(() => provider.listStores({ shoppingMode: 'pickup' }), /requires both latitude/);
  assert.equal(calls.length, 1);
});

test('supervalu: sends explicit store scope, offset, and optional cookie', async () => {
  const calls = [];
  const provider = new SuperValuIrelandProvider({
    storeId: '5550',
    cookieHeader: 'cf_clearance=user-owned',
    fetcher: queueFetch([jsonFixture('supervalu-gateway.json')], calls),
  });
  await provider.search('milk', { limit: 7, offset: 14 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/stores/5550/search');
  assert.equal(url.searchParams.get('skip'), '14');
  assert.equal(calls[0].init.headers.Cookie, 'cf_clearance=user-owned');
});

test('supervalu: maps price, unit price, promotion text, image, and size', async () => {
  const payload = jsonFixture('supervalu-gateway.json');
  payload.items.push(
    { id: 'SV-6002', name: 'Unavailable Milk', priceNumeric: 1.99, available: false },
    { id: 'SV-6003', name: 'Unknown Stock Milk', priceNumeric: 1.89 },
    {
      id: 'SV-6004',
      name: 'Conflicting Stock Milk',
      priceNumeric: 1.79,
      available: true,
      outOfStock: true,
    }
  );
  const provider = new SuperValuIrelandProvider({
    storeId: '5550',
    fetcher: queueFetch([payload]),
  });
  const products = await provider.search('milk');
  const [product] = products;
  assert.equal(product.retail_price.price, 2.55);
  assert.deepEqual(product.unit_price, { price: 1.28, measure: '1 L' });
  assert.equal(product.description, '2 for €4.50');
  assert.equal(product.size, '2 L');
  assert.equal(product.image_url, 'https://img.example.test/sv-milk.jpg');
  assert.deepEqual(products.map((item) => item.in_stock), [true, false, null, null]);
});

test('supervalu: rejects a missing product collection instead of returning an empty shelf', async () => {
  const provider = new SuperValuIrelandProvider({
    storeId: '5550',
    fetcher: queueFetch([{}]),
  });
  await rejects(() => provider.search('milk'), /items|products|results|array|protocol/i);
});

// ---------------------------------------------------------------------------
// Tesco Ireland — first-class coverage
// ---------------------------------------------------------------------------

test('tesco: xapi strategy sends IE region/language and the public-key header', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')], calls),
  });
  await provider.search('milk');
  const headers = calls[0].init.headers;
  assert.equal(headers.region, 'IE');
  assert.equal(headers.language, 'en-IE');
  assert.equal(headers.Origin, 'https://www.tesco.ie');
  assert.ok(headers['x-apikey']);
  assert.equal(headers.Cookie, undefined);
});

test('tesco: xapi search is read-only and tagged as the PLP micro-frontend', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')], calls),
  });
  await provider.search('milk');
  const [operation] = JSON.parse(calls[0].init.body);
  assert.equal(operation.operationName, 'Search');
  assert.equal(operation.extensions.mfeName, 'mfe-plp');
  assert.match(operation.query, /^query Search/);
  assert.doesNotMatch(operation.query, /mutation/i);
});

test('tesco: xapi maps price, unit price, size, promotion, image, and EUR', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')]),
  });
  const [product] = await provider.search('milk');
  assert.equal(product.product_uid, '7001000');
  assert.equal(product.retail_price.price, 2.35);
  assert.deepEqual(product.unit_price, { price: 1.18, measure: 'litre' });
  assert.equal(product.size, '2 L');
  assert.equal(product.description, 'Clubcard Price');
  assert.equal(product.currency, 'EUR');
});

test('tesco: xapi keeps sale-ineligible products visible without inventing stock', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')]),
  });
  const products = await provider.search('milk');
  assert.deepEqual(products.map((product) => product.in_stock), [null, null]);

  const explicitProvider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([[{
      data: {
        search: {
          results: [
            {
              node: {
                tpnb: 'explicit-in-stock',
                title: 'Explicitly Available Milk',
                availability: { status: 'IN_STOCK' },
                sellers: { results: [{ price: { actual: 2.1 } }] },
              },
            },
            {
              node: {
                tpnb: 'explicit-out-of-stock',
                title: 'Explicitly Unavailable Milk',
                availability: { status: 'OUT_OF_STOCK' },
                sellers: { results: [{ price: { actual: 2.2 } }] },
              },
            },
            {
              node: {
                tpnb: 'conflicting-stock',
                title: 'Conflicting Stock Milk',
                availability: { status: 'IN_STOCK', state: 'OUT_OF_STOCK' },
                sellers: { results: [{ price: { actual: 2.3 } }] },
              },
            },
          ],
        },
      },
    }]]),
  });
  const explicitProducts = await explicitProvider.search('milk');
  assert.deepEqual(explicitProducts.map((product) => product.in_stock), [true, false, null]);
});

test('tesco: SearchOptions.offset is converted to a one-based xapi page', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')], calls),
  });
  await provider.search('milk', { limit: 10, offset: 20 });
  const [operation] = JSON.parse(calls[0].init.body);
  assert.equal(operation.variables.page, 3);
  assert.equal(operation.variables.count, 10);
});

test('tesco: xapi honours an offset inside a page by batching the next page', async () => {
  const calls = [];
  const result = (index) => ({
    node: {
      tpnc: `product-${index}`,
      title: `Product ${index}`,
      isForSale: true,
      sellers: { results: [{ price: { actual: index + 1 } }] },
    },
  });
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([[
      { data: { search: { results: Array.from({ length: 10 }, (_, index) => result(index)) } } },
      { data: { search: { results: Array.from({ length: 10 }, (_, index) => result(index + 10)) } } },
    ]], calls),
  });
  const products = await provider.search('milk', { limit: 10, offset: 5 });
  const operations = JSON.parse(calls[0].init.body);
  assert.deepEqual(operations.map((operation) => operation.variables.page), [1, 2]);
  assert.deepEqual(
    products.map((product) => product.product_uid),
    Array.from({ length: 10 }, (_, index) => `product-${index + 5}`)
  );
});

test('tesco: index strategy uses geo=ie and batch-hydrates returned TPNBs', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      jsonFixture('tesco-index-search.json'),
      jsonFixture('tesco-hydration.json'),
    ], calls),
  });
  const products = await provider.search('milk', { limit: 2, offset: 4 });
  const indexUrl = new URL(calls[0].url);
  assert.equal(indexUrl.hostname, 'search.api.tesco.com');
  assert.equal(indexUrl.searchParams.get('geo'), 'ie');
  assert.equal(indexUrl.searchParams.get('offset'), '4');
  const hydration = JSON.parse(calls[1].init.body);
  assert.equal(hydration.length, 2);
  assert.deepEqual(hydration.map((op) => op.variables.tpnb), ['7100001', '7100002']);
  for (const operation of hydration) {
    assert.doesNotMatch(operation.query, /\bisAvailable\b/);
    assert.doesNotMatch(operation.query, /\bdisplayPrice\b/);
    assert.doesNotMatch(operation.query, /\bunitPrice\s*\{/);
    assert.match(operation.query, /sellers\s*\{\s*results\s*\{\s*price\s*\{\s*actual\s+unitPrice\s+unitOfMeasure/s);
    assert.match(operation.query, /promotions\s*\{\s*description\s+price\s*\{\s*afterDiscount\s+beforeDiscount/s);
    assert.doesNotMatch(operation.query, /mutation/i);
  }
  assert.equal(products.length, 2);
});

test('tesco: index hydration maps the accepted seller-price response shape', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      jsonFixture('tesco-index-search.json'),
      jsonFixture('tesco-hydration.json'),
    ]),
  });
  const products = await provider.search('milk');
  assert.equal(products[0].retail_price.price, 2.69);
  assert.deepEqual(products[0].unit_price, { price: 1.35, measure: 'litre' });
  assert.equal(products[1].retail_price.price, 2.29);
  assert.deepEqual(products[1].unit_price, { price: 1.15, measure: 'litre' });
});

test('tesco: auto strategy falls back only on a GraphQL search projection failure', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'auto',
    fetcher: queueFetch([
      jsonFixture('tesco-projection-error.json'),
      jsonFixture('tesco-index-search.json'),
      jsonFixture('tesco-hydration.json'),
    ], calls),
  });
  const products = await provider.search('milk');
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /search\.api\.tesco\.com/);
  assert.equal(products.length, 2);
});

test('tesco: auto strategy does not retry-storm a forbidden xapi request', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'auto',
    fetcher: queueFetch([{ body: 'Forbidden', status: 403 }], calls),
  });
  await rejects(() => provider.search('milk'), /may require a user-owned session/);
  assert.equal(calls.length, 1);
});

test('tesco: gives a specific action when the rotating public key is rejected', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([{ body: 'Forbidden: Invalid Client', status: 403 }]),
  });
  await rejects(() => provider.search('milk'), /API key.*rotates/i);
});

test('tesco: handles 429 without attempting another transport', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'auto',
    fetcher: queueFetch([{ body: 'too many requests', status: 429 }], calls),
  });
  await rejects(() => provider.search('milk'), /rate limited.*429/i);
  assert.equal(calls.length, 1);
});

test('tesco: includes user-owned auth material only when explicitly supplied', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    apiKey: 'public-key-override',
    cookie: ['session', 'cookie', 'fixture'].join('-'),
    authorization: `Bearer ${['user', 'token', 'fixture'].join('-')}`,
    fetcher: queueFetch([jsonFixture('tesco-xapi-search.json')], calls),
  });
  await provider.search('milk');
  const headers = calls[0].init.headers;
  assert.equal(headers['x-apikey'], 'public-key-override');
  assert.equal(headers.Cookie, ['session', 'cookie', 'fixture'].join('-'));
  assert.equal(headers.Authorization, `Bearer ${['user', 'token', 'fixture'].join('-')}`);
});

test('tesco: partial batch hydration returns valid products and skips failed records', async () => {
  const mixed = jsonFixture('tesco-hydration.json');
  mixed[0] = { errors: [{ message: 'regional product unavailable' }] };
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([jsonFixture('tesco-index-search.json'), mixed]),
  });
  const products = await provider.search('milk');
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Tesco Semi Skimmed Milk 2L');
});

test('tesco: all failed hydration records fail loudly rather than appearing empty', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      jsonFixture('tesco-index-search.json'),
      [
        { errors: [{ message: 'unauthorized' }] },
        { errors: [{ message: 'unauthorized' }] },
      ],
    ]),
  });
  await rejects(() => provider.search('milk'), /unauthorized/);
});

test('tesco: structurally empty hydration records fail loudly', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      { ie: { ghs: { products: { results: [{ tpnb: '7100001' }] } } } },
      [{}],
    ]),
  });
  await rejects(() => provider.search('milk'), /hydration|valid product|missing product/i);
});

test('tesco: hydration rejects a batch response with missing envelopes', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      jsonFixture('tesco-index-search.json'),
      [jsonFixture('tesco-hydration.json')[0]],
    ]),
  });
  await rejects(() => provider.search('milk'), /batch|expected 2|received 1/i);
});

test('tesco: index path validates the Ireland response branch', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([{ uk: { ghs: { products: { results: [] } } } }]),
  });
  await rejects(() => provider.search('milk'), /ie\.ghs\.products\.results/);
});

test('tesco: getProduct is a read-only xapi operation with Irish normalisation', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    fetcher: queueFetch([jsonFixture('tesco-get-product.json')], calls),
  });
  const product = await provider.getProduct('tpnc:7201001');
  const [operation] = JSON.parse(calls[0].init.body);
  assert.equal(operation.operationName, 'GetProduct');
  assert.deepEqual(operation.variables, { tpnc: '7201001' });
  assert.doesNotMatch(operation.query, /\bisAvailable\b/);
  assert.doesNotMatch(operation.query, /\bdisplayPrice\b/);
  assert.doesNotMatch(operation.query, /\bunitPrice\s*\{/);
  assert.match(operation.query, /sellers\s*\{\s*results\s*\{\s*price\s*\{\s*actual\s+unitPrice\s+unitOfMeasure/s);
  assert.match(operation.query, /promotions\s*\{\s*description\s+price\s*\{\s*afterDiscount\s+beforeDiscount/s);
  assert.doesNotMatch(operation.query, /mutation/i);
  assert.equal(product.name, 'Tesco Whole Milk 1L');
  assert.equal(product.retail_price.price, 1.35);
});

test('tesco: a search result TPNB round-trips through getProduct', async () => {
  const xapiSearch = jsonFixture('tesco-xapi-search.json');
  const searchedNode = xapiSearch[0].data.search.results[0].node;
  const calls = [];
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([
      xapiSearch,
      [{ data: { product: searchedNode } }],
    ], calls),
  });

  const [searchResult] = await provider.search('milk');
  const product = await provider.getProduct(searchResult.product_uid);
  const [operation] = JSON.parse(calls[1].init.body);
  assert.equal(searchResult.product_uid, '7001000');
  assert.equal(operation.operationName, 'GetProductByTpnb');
  assert.deepEqual(operation.variables, { tpnb: '7001000' });
  assert.equal(product.product_uid, searchResult.product_uid);
});

test('tesco: a bare legacy TPNC gets one bounded fallback after TPNB not-found', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    fetcher: queueFetch([
      [{ data: { product: null } }],
      jsonFixture('tesco-get-product.json'),
    ], calls),
  });

  const product = await provider.getProduct('7201001');
  const operations = calls.map((call) => JSON.parse(call.init.body)[0]);
  assert.deepEqual(
    operations.map((operation) => operation.operationName),
    ['GetProductByTpnb', 'GetProduct']
  );
  assert.equal(product.name, 'Tesco Whole Milk 1L');
});

test('tesco: malformed TPNB lookup does not trigger a legacy fallback request', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({
    fetcher: queueFetch([[{ data: {} }]], calls),
  });

  await rejects(() => provider.getProduct('7001000'), /missing data\.product/);
  assert.equal(calls.length, 1);
});

test('tesco: rejects an empty query before making either request', async () => {
  const calls = [];
  const provider = new TescoIrelandProvider({ fetcher: queueFetch([], calls) });
  await rejects(() => provider.search('  '), /query must not be empty/);
  assert.equal(calls.length, 0);
});

test('tesco: non-JSON challenge pages are classified as protocol failures', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch(['<html>Akamai challenge</html>']),
  });
  await rejects(() => provider.search('milk'), /expected JSON/);
});

test('tesco: keeps product identity stable across xapi and index strategies', async () => {
  const xapiProvider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([[{
      data: {
        search: {
          results: [{
            node: {
              tpnc: 'variant-123',
              tpnb: 'product-123',
              title: 'Irish Milk 2L',
              sellers: { results: [{ price: { actual: 2.49 } }] },
            },
          }],
        },
      },
    }]]),
  });
  const indexProvider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([
      { ie: { ghs: { products: { results: [{ tpnb: 'product-123' }] } } } },
      [{
        data: {
          product: {
            id: 'variant-123',
            tpnb: 'product-123',
            title: 'Irish Milk 2L',
            price: { actual: 2.49 },
          },
        },
      }],
    ]),
  });

  const [xapiProduct] = await xapiProvider.search('milk');
  const [indexProduct] = await indexProvider.search('milk');
  assert.equal(xapiProduct.product_uid, 'product-123');
  assert.equal(indexProduct.product_uid, 'product-123');
});

test('tesco: rejects non-empty xapi results when no product can be mapped', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'xapi',
    fetcher: queueFetch([[{
      data: { search: { results: [{ node: { title: 'Missing identity and price' } }] } },
    }]]),
  });

  await rejects(() => provider.search('milk'), /none had a stable ID, name, and numeric price/);
});

test('tesco: rejects non-empty index results without stable TPNB identifiers', async () => {
  const provider = new TescoIrelandProvider({
    strategy: 'index',
    fetcher: queueFetch([{ ie: { ghs: { products: { results: [{ title: 'Milk' }] } } } }]),
  });

  await rejects(() => provider.search('milk'), /no stable TPNB identifiers/);
});

// ---------------------------------------------------------------------------
// Live probe automated gate
// ---------------------------------------------------------------------------

test('live probe: passes only after two valid non-empty query results', () => {
  const products = [{
    product_uid: 'aldi-ie:123',
    name: 'Irish Milk 2L',
    provider: 'aldi-ie',
    currency: 'EUR',
    in_stock: true,
    retail_price: { price: 2.19 },
  }];
  const assessment = assessLiveProbe(products, 'aldi-ie');
  const evaluated = evaluateLiveProbeRun({
    results: [
      { query: 'milk', ok: true, duration_ms: 100, ...assessment },
      { query: 'bread', ok: true, duration_ms: 200, ...assessment },
    ],
  });

  assert.equal(evaluated.automated_pass, true);
  assert.equal(evaluated.pass, true);
  assert.equal(evaluated.manual_gate.status, 'required');
});

test('live probe: accepts unknown retailer availability and reports stock rates', () => {
  const assessment = assessLiveProbe([{
    product_uid: 'aldi-ie:unknown-stock',
    name: 'Irish Milk 2L',
    provider: 'aldi-ie',
    currency: 'EUR',
    in_stock: null,
    retail_price: { price: 2.19 },
  }], 'aldi-ie');
  assert.equal(assessment.all_rows_valid, true);
  assert.equal(assessment.all_stock_state_valid, true);
  assert.equal(assessment.stock_known_rate, 0);
  assert.equal(assessment.stock_unknown_rate, 1);
});

test('live probe: rejects a missing or invalid retailer availability state', () => {
  const assessment = assessLiveProbe([{
    product_uid: 'aldi-ie:bad-stock',
    name: 'Irish Milk 2L',
    provider: 'aldi-ie',
    currency: 'EUR',
    in_stock: 'yes',
    retail_price: { price: 2.19 },
  }], 'aldi-ie');
  assert.equal(assessment.all_rows_valid, false);
  assert.match(assessment.validation_errors.join(' '), /stock state is not boolean or null/);
});

test('live probe: fails on challenge responses and excessive p95 latency', () => {
  const products = [{
    product_uid: 'aldi-ie:123',
    name: 'Irish Milk 2L',
    provider: 'aldi-ie',
    currency: 'EUR',
    in_stock: false,
    retail_price: { price: 2.19 },
  }];
  const assessment = assessLiveProbe(products, 'aldi-ie');
  const evaluated = evaluateLiveProbeRun({
    results: [
      { query: 'milk', ok: true, duration_ms: 100, ...assessment },
      { query: 'bread', ok: true, duration_ms: 200, ...assessment },
      { query: 'chicken', ok: false, duration_ms: 16000, error: '<html>challenge</html>' },
    ],
  });

  assert.equal(evaluated.automated_pass, false);
  assert.equal(evaluated.checks.no_hard_failures, false);
  assert.equal(evaluated.checks.p95_duration_below_15000ms, false);
  assert.equal(evaluated.p95_duration_ms, 16000);
});

test('live probe: classifies invalid Tesco client before generic HTTP 403', () => {
  assert.equal(
    liveProbeHardFailureReason({ status: 403, bodySnippet: 'Forbidden: Invalid Client' }),
    'invalid client authentication'
  );
  assert.equal(
    liveProbeHardFailureReason({ status: 403, bodySnippet: 'Forbidden challenge' }),
    'blocked request or challenge (HTTP 403)'
  );
});

test('live probe: rejects a string retail price even at an 80 percent price rate', () => {
  const products = Array.from({ length: 5 }, (_, index) => ({
    product_uid: `aldi-ie:${index}`,
    name: `Product ${index}`,
    provider: 'aldi-ie',
    currency: 'EUR',
    in_stock: true,
    retail_price: { price: index === 4 ? '2.19' : 2.19 },
  }));
  const assessment = assessLiveProbe(products, 'aldi-ie');
  const evaluated = evaluateLiveProbeRun({
    results: [
      { query: 'milk', ok: true, duration_ms: 100, ...assessment },
      { query: 'bread', ok: true, duration_ms: 200, ...assessment },
    ],
  });

  assert.equal(assessment.positive_price_rate, 0.8);
  assert.equal(assessment.all_rows_valid, false);
  assert.equal(evaluated.automated_pass, false);
  assert.equal(evaluated.checks.product_contract_valid, false);
});

test('live probe: rejects unknown transport and Tesco strategy selectors', () => {
  assert.throws(
    () => parseLiveProbeArgs(['--provider', 'dunnes-ie', '--transport', 'unknown']),
    /transport must be vtex or gateway/
  );
  const previous = process.env.TESCO_IE_STRATEGY;
  process.env.TESCO_IE_STRATEGY = 'unknown';
  try {
    assert.throws(
      () => liveProbeProviderFor({ provider: 'tesco-ie' }),
      /TESCO_IE_STRATEGY must be xapi, index, or auto/
    );
  } finally {
    if (previous === undefined) delete process.env.TESCO_IE_STRATEGY;
    else process.env.TESCO_IE_STRATEGY = previous;
  }
});

test('live probe: Dunnes defaults to the store-scoped grocery gateway', async () => {
  const previous = process.env.DUNNES_IE_STORE_ID;
  delete process.env.DUNNES_IE_STORE_ID;
  try {
    const provider = liveProbeProviderFor({ provider: 'dunnes-ie' });
    await rejects(() => provider.search('milk'), /store-scoped/);
  } finally {
    if (previous === undefined) delete process.env.DUNNES_IE_STORE_ID;
    else process.env.DUNNES_IE_STORE_ID = previous;
  }
});

async function main() {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`✓ ${name}\n`);
    } catch (error) {
      failures.push({ name, error });
      process.stderr.write(`✗ ${name}\n  ${error?.stack || error}\n`);
    }
  }
  process.stdout.write(`\n${passed}/${tests.length} tests passed.\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main();
