import assert from 'node:assert/strict';
import { MigrosProvider, MigrosSession, normaliseBasket, normaliseProduct } from '../src/providers/migros';
import type { MigrosSearchSession } from '../src/providers/migros';

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

class FakeSession implements MigrosSearchSession {
  calls: Array<{ query: string; options?: any }> = [];
  closed = 0;
  error?: Error;

  async search(query: string, options?: any) {
    this.calls.push({ query, options });
    if (this.error) throw this.error;
    return query === 'nothing'
      ? []
      : [{
          product_uid: '123',
          name: 'Milk',
          retail_price: { price: 2.5 },
          in_stock: true,
          provider: 'migros',
          currency: 'CHF',
        }];
  }

  async getBasket() {
    return { items: [], total_quantity: 0, total_cost: 0, provider: 'migros', currency: 'CHF' };
  }

  async addToBasket() {}
  async updateBasketItem() {}
  async removeFromBasket() {}
  async clearBasket() {}

  async close(): Promise<void> {
    this.closed++;
  }
}

function fakeBrowser(evaluate: (args: any) => any, closed: string[]) {
  const page: any = {
    goto: async () => ({ status: () => 200 }),
    waitForRequest: async () => ({ headers: () => ({ leshopch: 'session-header' }) }),
    evaluate: async (_fn: unknown, args: any) => evaluate(args),
    close: async () => closed.push('page'),
  };
  const context: any = {
    newPage: async () => page,
    close: async () => closed.push('context'),
  };
  return {
    newContext: async () => context,
    close: async () => closed.push('browser'),
  } as any;
}

function basketBrowser(
  evaluate: (args: any) => any,
  requests: any[],
  closed: string[] = []
) {
  return fakeBrowser(args => {
    requests.push(args);
    return evaluate(args);
  }, closed);
}

async function main(): Promise<void> {
  console.log('migros provider');

await check('normalises basket totals, quantities, CHF and item types without inventing prices', () => {
  const basket = normaliseBasket({
    shoppingListId: 'dynamic-list',
    categories: [{ items: [
      { id: 101, name: 'Flour', quantity: 2, type: 'PRODUCT' },
      { id: 202, name: 'Promotion', quantity: 1, type: 'GROUPED_PROMOTION' },
    ] }],
    totals: { onlineTotal: { estimatedTotal: 8.5 } },
  }, new Map([['101', 3.25]]));
  assert.equal(basket.total_quantity, 3);
  assert.equal(basket.total_cost, 8.5);
  assert.equal(basket.currency, 'CHF');
  assert.equal(basket.items[0].total_price, 6.5);
  assert.equal(basket.items[1].unit_price, 0);
  assert.equal(basket.items[1].item_id, '202');
});

await check('getBasket discovers a dynamic shopping list id and uses online product cards', async () => {
  const requests: any[] = [];
  const session = new MigrosSession(async () => basketBrowser(args => {
    if (String(args.url).includes('/guest?')) return { status: 200, contentType: 'application/json', body: '{"userid":"guest-1"}' };
    if (String(args.url).includes('/lists/overview')) return { status: 200, contentType: 'application/json', body: '[{"shoppingListId":"dynamic-list"}]' };
    if (String(args.url).includes('/list/details')) return { status: 200, contentType: 'application/json', body: JSON.stringify({
      shoppingListId: 'dynamic-list',
      categories: [{ items: [{ id: 101, name: 'Flour', quantity: 2, type: 'PRODUCT' }] }],
      totals: { onlineTotal: { estimatedTotal: 6.5 } },
    }) };
    if (String(args.url).includes('/fulfilment-selection')) return { status: 200, contentType: 'application/json', body: '{"warehouseId":7}' };
    if (String(args.url).includes('/product-cards')) return { status: 200, contentType: 'application/json', body: '[{"migrosId":101,"offer":{"price":{"effectiveValue":3.25}}}]' };
    throw new Error(`unexpected ${args.url}`);
  }, requests));
  const basket = await session.getBasket();
  assert.equal(basket.total_quantity, 2);
  assert.equal(basket.total_cost, 6.5);
  assert.equal(basket.items[0].unit_price, 3.25);
  const cards = requests.find(request => String(request.url).includes('/product-cards'));
  assert.deepEqual(cards.body.offerFilter, { storeType: 'ONLINE', warehouseId: 7, ongoingOfferDate: cards.body.offerFilter.ongoingOfferDate });
  assert.deepEqual(cards.body.productFilter, { uids: [101] });
  assert.ok(requests.some(request => String(request.url).includes('shoppingListId=dynamic-list')));
  await session.close();
});

await check('basket writes use PUT, absolute quantities, zero removal and the stored item type', async () => {
  const requests: any[] = [];
  const session = new MigrosSession(async () => basketBrowser(args => {
    if (String(args.url).includes('/guest?')) return { status: 200, contentType: 'application/json', body: '{"userid":"guest-1"}' };
    if (String(args.url).includes('/lists/overview')) return { status: 200, contentType: 'application/json', body: '[{"shoppingListId":987654}]' };
    if (String(args.url).includes('/list/details')) return { status: 200, contentType: 'application/json', body: JSON.stringify({
      shoppingListId: 987654,
      categories: [{ items: [{ id: 202, name: 'Promotion', quantity: 1, type: 'GROUPED_PROMOTION' }] }],
      totals: { onlineTotal: { estimatedTotal: 4 } },
    }) };
    if (String(args.url).includes('/shopping-list/public/v3/items')) return { status: 200, contentType: 'application/json', body: JSON.stringify({
      shoppingListId: 987654, categories: [], totals: { onlineTotal: { estimatedTotal: 0 } },
    }) };
    throw new Error(`unexpected ${args.url}`);
  }, requests));
  await session.addToBasket('101', 3);
  await session.updateBasketItem('202', 2);
  await session.removeFromBasket('202');
  const puts = requests.filter(request => request.method === 'PUT');
  assert.deepEqual(puts.map(request => request.body), [
    { shoppingListId: 987654, items: [{ id: '101', quantity: 3, type: 'PRODUCT' }] },
    { shoppingListId: 987654, items: [{ id: '202', quantity: 2, type: 'GROUPED_PROMOTION' }] },
    { shoppingListId: 987654, items: [{ id: '202', quantity: 0, type: 'GROUPED_PROMOTION' }] },
  ]);
  await session.close();
});

await check('basket translates HTTP errors and unexpected schemas', async () => {
  const httpError = new MigrosSession(async () => basketBrowser(args => {
    if (String(args.url).includes('/guest?')) return { status: 200, contentType: 'application/json', body: '{"userid":"guest-1"}' };
    return { status: 503, contentType: 'application/json', body: '{}' };
  }, []));
  await assert.rejects(httpError.getBasket(), /HTTP 503/);

  const badSchema = new MigrosSession(async () => basketBrowser(args => {
    if (String(args.url).includes('/guest?')) return { status: 200, contentType: 'application/json', body: '{"userid":"guest-1"}' };
    if (String(args.url).includes('/lists/overview')) return { status: 200, contentType: 'application/json', body: '[{"shoppingListId":987654}]' };
    return { status: 200, contentType: 'application/json', body: '{}' };
  }, []));
  await assert.rejects(badSchema.getBasket(), /unexpected schema/);
});

await check('normalises Migros product cards without inventing optional fields', () => {
  const product = normaliseProduct({
    migrosId: '104602200000',
    title: 'Pure spelt flour',
    description: 'Migros · Pure spelt flour · Classic',
    quantity: '1kg',
    productAvailability: 'ONLINE_AND_INSTORE',
    images: [{ url: 'https://image.migros.ch/flour.jpg' }],
    offer: { price: { effectiveValue: 3.8, unitPrice: { value: 0.38, unit: '100g' } } },
  });
  assert.deepEqual(product, {
    product_uid: '104602200000',
    name: 'Pure spelt flour',
    description: 'Migros · Pure spelt flour · Classic',
    retail_price: { price: 3.8 },
    unit_price: { price: 0.38, measure: '100g' },
    in_stock: true,
    image_url: 'https://image.migros.ch/flour.jpg',
    provider: 'migros',
    currency: 'CHF',
    size: '1kg',
  });
});

await check('search delegates a query and returns products', async () => {
  const session = new FakeSession();
  const products = await new MigrosProvider(session).search('milk', { limit: 5 });
  assert.equal(products.length, 1);
  assert.equal(session.calls[0].query, 'milk');
});

await check('a legitimate empty search returns zero products', async () => {
  const session = new FakeSession();
  assert.deepEqual(await new MigrosProvider(session).search('nothing'), []);
});

await check('passes pagination options through unchanged', async () => {
  const session = new FakeSession();
  await new MigrosProvider(session).search('milk', { limit: 20, offset: 40 });
  assert.deepEqual(session.calls[0].options, { limit: 20, offset: 40 });
});

await check('propagates provider errors instead of returning an empty list', async () => {
  const session = new FakeSession();
  session.error = new Error('Migros search failed (HTTP 503)');
  await assert.rejects(new MigrosProvider(session).search('milk'), /HTTP 503/);
});

await check('turns an HTTP 403 into an explicit Cloudflare error', async () => {
  const closed: string[] = [];
  const session = new MigrosSession(async () => fakeBrowser(args => {
    if (String(args.url).includes('/guest?')) {
      return { status: 200, contentType: 'application/json', body: '{"userid":"guest-1"}' };
    }
    return { status: 403, contentType: 'text/html', body: '<html>challenge</html>' };
  }, closed));
  await assert.rejects(session.search('milk'), /Cloudflare/);
});

await check('rejects non-JSON and unexpected API schemas', async () => {
  const nonJson = new MigrosSession(async () => fakeBrowser(args => {
    if (String(args.url).includes('/guest?')) {
      return { status: 200, contentType: 'text/html', body: '<html>maintenance</html>' };
    }
    return { status: 200, contentType: 'application/json', body: '{}' };
  }, []));
  await assert.rejects(nonJson.search('milk'), /non-JSON/);

  const badSchema = new MigrosSession(async () => fakeBrowser(args => {
    if (String(args.url).includes('/guest?')) {
      return { status: 200, contentType: 'application/json', body: '{"userid":"guest-1"}' };
    }
    return { status: 200, contentType: 'application/json', body: '{}' };
  }, []));
  await assert.rejects(badSchema.search('milk'), /unexpected schema/);
});

await check('closes page, context and browser after a successful session', async () => {
  const closed: string[] = [];
  const session = new MigrosSession(async () => fakeBrowser(args => {
    if (String(args.url).includes('/guest?')) {
      return { status: 200, contentType: 'application/json', body: '{"userid":"guest-1"}' };
    }
    if (String(args.url).endsWith('/products/search')) {
      return { status: 200, contentType: 'application/json', body: '{"items":[],"numberOfProducts":0}' };
    }
    throw new Error(`unexpected ${args.url}`);
  }, closed));
  assert.deepEqual(await session.search('nothing'), []);
  await session.close();
  assert.deepEqual(closed, ['page', 'context', 'browser']);
});

await check('cleans up all browser resources when a search fails', async () => {
  const closed: string[] = [];
  const session = new MigrosSession(async () => fakeBrowser(args => {
    if (String(args.url).includes('/guest?')) {
      return { status: 200, contentType: 'application/json', body: '{"userid":"guest-1"}' };
    }
    throw new Error('synthetic browser failure');
  }, closed));
  await assert.rejects(session.search('milk'), /synthetic browser failure/);
  assert.deepEqual(closed, ['page', 'context', 'browser']);
});

  if (failures) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
