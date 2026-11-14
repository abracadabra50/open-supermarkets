import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { lean } from '../src/batch';
import { explain } from '../src/errors';
import { ConadProvider, normaliseProduct } from '../src/providers/conad';
import { ConadInteractionRequiredError, ConadWorkerError } from '../src/providers/conad/seleniumbase';
import { checkAccess, createProvider, getManifest, providersFor } from '../src/providers/registry';
import type { Basket, StoreContext } from '../src/providers/types';

const store: StoreContext = {
  store_id: '010001', name: 'Test Store', address: 'Synthetic address',
  provider: 'conad', fulfilment: 'pickup',
};
const products = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/conad-products.json'), 'utf8'));
const rows = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({
  code: String(100000 + start + i), nome: `Synthetic product ${start + i}`, basePrice: 1.5,
}));
const initialBasket: Basket = {
  items: [{ item_id: '0', product_uid: '100000', name: 'Synthetic milk', quantity: 1, unit_price: 1.5, total_price: 1.5 }],
  total_quantity: 1, total_cost: 7.4, basket_id: 'synthetic-basket', provider: 'conad', currency: 'EUR', store,
};

function harness() {
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  const pages = new Map<number, unknown>([[1, { rows: rows(0, 3), total: 3, store }]]);
  const data = {
    authenticated: false,
    product: { row: rows(0, 1)[0], store } as unknown,
    basket: structuredClone(initialBasket) as unknown,
    error: undefined as Error | undefined,
    writeReply: { confirmed: true } as unknown,
  };
  const transport = {
    async call(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ action, args });
      if (data.error) throw data.error;
      if (['status', 'browser_login', 'login'].includes(action)) return { authenticated: data.authenticated, store, ignored_private_field: 'not-for-tool-output' };
      if (action === 'search_page') return pages.get(args.page as number);
      if (action === 'product') return data.product;
      if (action === 'basket') return data.basket;
      if (action === 'checkout_summary') return {
        basket: data.basket, account_key: 'synthetic-account',
        summary: { subtotal: 1.5, delivery: 5.9, minimum_value_reached: true },
      };
      return data.writeReply;
    },
  };
  return { provider: new ConadProvider({}, transport), calls, pages, data };
}

test('Conad is a lazy community integration with only implemented capabilities', async () => {
  assert.deepEqual(providersFor('IT').map(p => p.id), ['conad']);
  const manifest = getManifest('conad');
  assert.equal(manifest.maintainer, 'GianluDeveloper');
  assert.equal(manifest.tier, 'community');
  assert.deepEqual(manifest.capabilities, ['search', 'basket']);
  assert.equal((await createProvider('conad')).name, 'conad');
  for (const capability of ['slots', 'checkout', 'orders'] as const) {
    assert.throws(() => checkAccess('conad', { capability }), /does not support/);
  }
});

test('product mapping preserves regular price, full local SKU, EUR and uncertainty', () => {
  const mapped = products.map((p: unknown) => normaliseProduct(p, store));
  assert.equal(mapped[0].retail_price.price, 1.79);
  assert.equal(mapped[1].retail_price.price, null);
  assert.equal(mapped[2].product_uid, '437403-1_N');
  assert.equal(mapped[2].retail_price.price, 2.49);
  assert.equal(mapped[2].gtin, '08003170014312');
  for (const product of mapped) {
    assert.equal(product.in_stock, null);
    assert.equal(product.currency, 'EUR');
    assert.deepEqual(lean(product).store, store);
  }
});

test('malformed/missing prices do not become free, discounted or plausible numeric prices', () => {
  for (const basePrice of [undefined, null, false, {}, -1, 0, 'invalid', 'abc1.79', '1.234,56']) {
    assert.equal(normaliseProduct({ code: '100001', nome: 'Synthetic milk', basePrice, promo: [{ finalPrice: 1 }] }, store).retail_price.price, null);
  }
  assert.equal(normaliseProduct({ code: '100001', nome: 'Synthetic milk', ean: '8003170014313' }, store).gtin, undefined);
  for (const row of [null, [], {}, { code: '../path', nome: 'Bad' }, { code: '100001' }]) {
    assert.throws(() => normaliseProduct(row, store));
  }
});

test('search validates local inputs without starting a browser', async () => {
  const h = harness();
  for (const query of ['', ' ', null, 'x'.repeat(1001)]) {
    await assert.rejects(() => h.provider.search(query as string));
  }
  for (const options of [{ limit: -1 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: NaN }, { category: 'milk' }]) {
    await assert.rejects(() => h.provider.search('latte', options));
  }
  assert.deepEqual(await h.provider.search('latte', { limit: 0 }), []);
  assert.equal(h.calls.length, 0);
});

test('search slices exact offsets and checks pagination across 40-row pages', async () => {
  const h = harness();
  assert.deepEqual((await h.provider.search(' latte ', { offset: 1, limit: 2 })).map(p => p.product_uid), ['100001', '100002']);
  assert.deepEqual(h.calls[0], { action: 'search_page', args: { query: 'latte', page: 1 } });
  h.pages.set(1, { rows: rows(0, 40), total: 85, store });
  h.pages.set(2, { rows: rows(40, 40), total: 85, store });
  h.pages.set(3, { rows: rows(80, 5), total: 85, store });
  const result = await h.provider.search('latte', { offset: 38, limit: 45 });
  assert.equal(result.length, 45);
  assert.equal(result[44].product_uid, '100082');
  h.pages.set(4, { rows: [], total: 85, store });
  assert.deepEqual(await h.provider.search('latte', { offset: 120 }), []);
});

test('browser errors, malformed pages, duplicates and changed store/totals remain errors', async () => {
  for (const second of [
    { rows: rows(0, 40), total: 80, store },
    { rows: rows(40, 40), total: 81, store },
    { rows: rows(40, 39), total: 80, store },
    { rows: rows(40, 40), total: 80, store: { ...store, store_id: '999999' } },
  ]) {
    const h = harness();
    h.pages.set(1, { rows: rows(0, 40), total: 80, store });
    h.pages.set(2, second);
    await assert.rejects(() => h.provider.search('latte', { limit: 60 }));
  }
  for (const reply of [null, [], {}, { rows: [], total: 1, store }, { rows: rows(0, 3), total: 3, store: null }]) {
    const h = harness();
    h.pages.set(1, reply);
    await assert.rejects(() => h.provider.search('latte'));
  }
  const h = harness();
  const error = new ConadInteractionRequiredError('Complete login in the visible browser before retrying.');
  h.data.error = error;
  await assert.rejects(() => h.provider.search('latte'), ConadInteractionRequiredError);
  assert.equal(explain(error, { provider: 'conad' }), error.message);
});

test('detail verifies retailer identity, including composite codes', async () => {
  const h = harness();
  assert.equal((await h.provider.getProduct('100000')).product_uid, '100000');
  h.data.product = { row: products[2], store };
  assert.equal((await h.provider.getProduct('437403-1_N')).product_uid, '437403-1_N');
  await assert.rejects(() => h.provider.getProduct('100000'));
  await assert.rejects(() => h.provider.getProduct('../home'));
});

test('session status is one atomic read and does not expose worker-private data', async () => {
  const h = harness();
  const result = await h.provider.getSessionStatus();
  assert.equal(result.authenticated, false);
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /not-for-tool-output/);
  assert.equal((await h.provider.startBrowserLogin()).interaction_required, true);
  await assert.rejects(() => h.provider.login('agent@example.test', 'synthetic-password'), ConadInteractionRequiredError);
  h.data.authenticated = true;
  await h.provider.login('agent@example.test', 'synthetic-password');
  assert.equal(await h.provider.isAuthenticated(), true);
});

test('basket mapping retains retailer totals and rejects invalid lines/quantities', async () => {
  const h = harness();
  assert.deepEqual(await h.provider.getBasket(), initialBasket);
  h.data.basket = { ...initialBasket, total_cost: null, items: [{ ...initialBasket.items[0], unit_price: null, total_price: null }] };
  assert.equal((await h.provider.getBasket()).total_cost, null);
  for (const quantity of [false, undefined, -1, NaN]) {
    h.data.basket = { ...initialBasket, items: [{ ...initialBasket.items[0], quantity }] };
    await assert.rejects(() => h.provider.getBasket());
  }
  for (const raw of [null, {}, { ...initialBasket, total_quantity: 2 }, { ...initialBasket, basket_id: '' }]) {
    h.data.basket = raw;
    await assert.rejects(() => h.provider.getBasket());
  }
});

test('writes require proper row IDs, bounded quantities and positive confirmation', async () => {
  const h = harness();
  await h.provider.addToBasket('437403-1_N', 2);
  await h.provider.updateBasketItem('0', 3);
  await h.provider.removeFromBasket('0');
  await h.provider.clearBasket();
  assert.deepEqual(h.calls.map(c => c.action), ['basket_add', 'basket_update', 'basket_remove', 'basket_clear']);
  const before = h.calls.length;
  await assert.rejects(() => h.provider.addToBasket('100001', 11));
  await assert.rejects(() => h.provider.updateBasketItem('0', .5));
  await assert.rejects(() => h.provider.removeFromBasket('437403-1_N'));
  assert.equal(h.calls.length, before);
  h.data.writeReply = { confirmed: false };
  await assert.rejects(() => h.provider.addToBasket('100001', 1), error => {
    assert.ok(error instanceof ConadWorkerError);
    assert.equal(error.mutation_may_have_applied, true);
    return true;
  });
});

test('review uses one snapshot, distinguishes equal-price substitutions and cannot authorize orders', async () => {
  const h = harness();
  const preview = await h.provider.getCheckoutPreview();
  assert.deepEqual(h.calls.map(c => c.action), ['checkout_summary']);
  assert.equal(preview.can_place_order, false);
  assert.ok(preview.blockers.length);
  assert.equal(preview.totals.final, null);
  assert.equal(preview.totals.delivery, 5.9);
  assert.ok(!Object.hasOwn(preview, 'expires_at'));
  assert.ok(!Object.hasOwn(preview, 'confirmation_token'));
  assert.equal(preview.snapshot_hash, (await h.provider.getCheckoutPreview()).snapshot_hash);
  h.data.basket = { ...initialBasket, items: [{ ...initialBasket.items[0], product_uid: '100005' }] };
  assert.notEqual(preview.snapshot_hash, (await h.provider.getCheckoutPreview()).snapshot_hash);
});
