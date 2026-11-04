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

test('Lidl rejects an old loyalty price without an explicit regular price', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'regular', fullTitle: 'Milk', regionsPrices: { '1': {
      currentLidlPlusPrice: { price: { price: '€1.99', oldPrice: '€2.49' } },
    } },
  } } }] };
  await assert.rejects(() => new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk'), /no valid products/);
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

test('Lidl maps the captured Mix n Match offer to its single-item price', async () => {
  const payload = JSON.parse(readFileSync(join(__dirname, 'fixtures/lidl-multibuy.json'), 'utf8'));
  const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(product.product_uid, '/p/realforno-milk-and-honey-shortbread-biscuits/p11143576');
  assert.equal(product.retail_price.price, 1.79);
  assert.equal(product.unit_price, undefined);
  assert.equal(product.in_stock, null);
});

test('Lidl rejects conditional pricing without a reliable single-item price', async () => {
  for (const discountText of ["Mix 'n' Match 2 for €3", 'Buy 2 get 1 free', '3 for €5', 'Lidl Plus']) {
    const payload = { items: [{ gridbox: { data: {
      id: 'conditional', fullTitle: 'Milk', price: { price: 1.50 },
      regionsPrices: { '1': { currentPrice: { price: 1.50, discount: { discountText } } } },
    } } }] };
    await assert.rejects(() => new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk'), /no valid products/);
  }
});

test('Lidl retains unconditional reductions rather than mapping their old price', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'sale', fullTitle: 'Milk', price: { price: 1.50, oldPrice: 1.79 },
    regionsPrices: { '1': { currentPrice: { price: 1.50, oldPrice: 1.79, discount: { discountText: '16% off' } } } },
  } } }] };
  const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(product.retail_price.price, 1.50);
});

test('Lidl rejects malformed and negative prices instead of stripping their text', async () => {
  for (const amount of [-1, '-€1.50', '1.50oops', '2 for €3', 'Infinity', '', null]) {
    const payload = { items: [{ gridbox: { data: {
      id: 'invalid', fullTitle: 'Milk', price: { price: amount },
    } } }] };
    await assert.rejects(() => new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk'), /no valid products/);
  }
});

test('Lidl does not treat a recommended price as the regular multibuy price', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'rrp', fullTitle: 'Milk', price: { price: 1.50 },
    regionsPrices: { '1': { currentPrice: {
      price: 1.50, oldPrice: 2, discount: { discountText: '2 for €3', fromRecommendedPrice: true },
    } } },
  } } }] };
  await assert.rejects(() => new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk'), /no valid products/);
});

test('Lidl retains valid rows when another row has an invalid price', async () => {
  const payload = fixture();
  payload.items.push({ gridbox: { data: { id: 'bad', fullTitle: 'Milk', price: { price: -1 } } } });
  const products = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(products.length, 2);
  assert.equal(products[0].retail_price.price, 2.25);
});

test('Lidl matches complete stock labels without treating negation as available', async () => {
  for (const [text, expected] of [
    ['Not in stock', false], ['No longer in stock', false], ['Out of stock', false],
    ['Sold out', false], ['Unavailable', false], ['IN STOCK', true],
    ['In stock.', true], ['Back in stock soon', null], ['Not currently in stock', null],
    ['Usually in stock', null], ['Not unavailable', null], ['Not sold out', null],
  ]) {
    const payload = { items: [{ gridbox: { data: {
      id: 'stock', fullTitle: 'Milk', price: { price: 1.50 },
      stockAvailability: { badgeInfo: { badges: [{ text }] } },
    } } }] };
    const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
    assert.equal(product.in_stock, expected, text);
  }
});


test('Lidl omits loyalty-only rows while retaining products with regular prices', async () => {
  const payload = fixture();
  payload.items.push({ gridbox: { data: {
    id: 'loyalty-only', fullTitle: 'Loyalty Milk', regionsPrices: { '1': {
      currentLidlPlusPrice: { price: { price: 1.99, oldPrice: 2.49 } },
    } },
  } } });
  const products = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(products.length, 2);
  assert.equal(products.some((product) => product.product_uid === 'loyalty-only'), false);
});


test('Lidl prefers the IE regional current price over a different generic price', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'regional', fullTitle: 'Milk', price: { price: 3.29 },
    regionsPrices: { '1': { currentPrice: { price: 2.79 } } },
  } } }] };
  const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(product.retail_price.price, 2.79);
});

test('Lidl rejects a duplicated regional RRP without its generic marker', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'rrp-duplicate', fullTitle: 'Milk', price: { price: 1.50, oldPrice: 2 },
    regionsPrices: { '1': { currentPrice: {
      price: 1.50, oldPrice: 2, discount: { discountText: '2 for €3', fromRecommendedPrice: true },
    } } },
  } } }] };
  await assert.rejects(() => new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk'), /no valid products/);
});


test('Lidl retains an unconditional discount whose message says buy now', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'unconditional', fullTitle: 'Milk', price: { price: 1.50 },
    regionsPrices: { '1': { currentPrice: {
      price: 1.50, oldPrice: 1.79, discount: { discountText: 'Buy now and save 16%' },
    } } },
  } } }] };
  const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(product.retail_price.price, 1.50);
});

test('Lidl rejects a malformed present regional price instead of using generic data', async () => {
  for (const currentPrice of [null, [], 'bad', {}, { price: -1 }, { price: 'bad' }]) {
    const payload = { items: [{ gridbox: { data: {
      id: 'malformed-regional', fullTitle: 'Milk', price: { price: 2.25 },
      regionsPrices: { '1': { currentPrice } },
    } } }] };
    await assert.rejects(() => new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk'), /no valid products/);
  }
});

test('Lidl passes a deadline signal and identifies upstream timeouts', async () => {
  let signal;
  const fetcher = async (_input, init) => {
    signal = init.signal;
    const error = new Error('upstream stalled');
    error.name = 'TimeoutError';
    throw error;
  };
  await assert.rejects(() => new LidlIrelandProvider({ fetcher }).search('milk'), /Lidl Ireland request timed out after 15000 ms/);
  assert.ok(signal instanceof AbortSignal);
});

test('Lidl identifies timeouts during response-body reading', async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.equal(milliseconds, 15000);
    return controller.signal;
  });
  const fetcher = async () => ({ ok: true, status: 200, async text() {
    const error = new Error('body stalled');
    error.name = 'TimeoutError';
    controller.abort(error);
    throw error;
  } });
  await assert.rejects(() => new LidlIrelandProvider({ fetcher }).search('milk'), /Lidl Ireland request timed out/);
});


test('Lidl rejects malformed present regional old prices on conditional offers', async () => {
  for (const oldPrice of ['bad', null, '', -1, {}, []]) {
    const payload = { items: [{ gridbox: { data: {
      id: 'invalid-old-price', fullTitle: 'Milk', price: { price: 1.50, oldPrice: 2.79 },
      regionsPrices: { '1': { currentPrice: {
        price: 1.50, oldPrice, discount: { discountText: '2 for €3' },
      } } },
    } } }] };
    await assert.rejects(() => new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk'), /no valid products/);
  }
});

test('Lidl may use generic regular old price when regional old price is absent', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'missing-old-price', fullTitle: 'Milk', price: { price: 1.50, oldPrice: 2.79 },
    regionsPrices: { '1': { currentPrice: {
      price: 1.50, discount: { discountText: '2 for €3' },
    } } },
  } } }] };
  const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(product.retail_price.price, 2.79);
});

test('Lidl prefers a valid regional regular old price over the generic old price', async () => {
  const payload = { items: [{ gridbox: { data: {
    id: 'regional-old-price', fullTitle: 'Milk', price: { price: 1.50, oldPrice: 3.99 },
    regionsPrices: { '1': { currentPrice: {
      price: 1.50, oldPrice: 2.79, discount: { discountText: '2 for €3' },
    } } },
  } } }] };
  const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(product.retail_price.price, 2.79);
});

test('Lidl identifies a direct response-body timeout error', async () => {
  const fetcher = async () => ({ ok: true, status: 200, async text() {
    const error = new Error('body stalled');
    error.name = 'TimeoutError';
    throw error;
  } });
  await assert.rejects(() => new LidlIrelandProvider({ fetcher }).search('milk'), /Lidl Ireland request timed out after 15000 ms/);
});


test('Lidl accepts unambiguous grouped EUR amounts', async () => {
  for (const price of ['€1,299.00', '€1.299,00']) {
    const payload = { items: [{ gridbox: { data: { id: 'grouped', fullTitle: 'Milk', price: { price } } } }] };
    const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
    assert.equal(product.retail_price.price, 1299);
  }
});

test('Lidl preserves numeric catalogue identity before its canonical URL', async () => {
  for (const field of ['id', 'productId', 'code']) {
    const payload = { items: [{ gridbox: { data: {
      [field]: 11143576, fullTitle: 'Milk', canonicalUrl: '/p/milk/p11143576', price: { price: 2.79 },
    } } }] };
    const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
    assert.equal(product.product_uid, '11143576');
  }
});

test('Lidl rejects malformed present regional prices for conditional offers too', async () => {
  for (const currentPrice of [null, {}, [], 'bad', { price: 'bad' }, { price: -1 }]) {
    const payload = { items: [{ gridbox: { data: {
      id: 'bad-conditional', fullTitle: 'Milk', price: {
        price: 1.50, oldPrice: 2.79, discount: { discountText: '2 for €3' },
      }, regionsPrices: { '1': { currentPrice } },
    } } }] };
    await assert.rejects(() => new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk'), /no valid products/);
  }
});

test('Lidl omits generic unit price when the selected regional shelf price differs', async () => {
  const payload = fixture();
  payload.items[0].gridbox.data.regionsPrices['1'].currentPrice.price = 3.25;
  const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
  assert.equal(product.retail_price.price, 3.25);
  assert.equal(product.unit_price, undefined);
});


test('Lidl accepts complete EUR labels but rejects other currencies', async () => {
  for (const price of ['EUR 2.79', '2.79 EUR', '€2.79', '2.79 €']) {
    const payload = { items: [{ gridbox: { data: { id: 'eur', fullTitle: 'Milk', price: { price } } } }] };
    const [product] = await new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk');
    assert.equal(product.retail_price.price, 2.79);
  }
  for (const price of ['GBP 2.79', '2.79 GBP', 'USD 2.79', '£2.79', '$2.79', 'EUR -2.79']) {
    const payload = { items: [{ gridbox: { data: { id: 'non-eur', fullTitle: 'Milk', price: { price } } } }] };
    await assert.rejects(() => new LidlIrelandProvider({ fetcher: fetchWith(payload) }).search('milk'), /no valid products/);
  }
});
