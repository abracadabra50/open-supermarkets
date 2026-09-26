import assert from 'node:assert/strict';
import { MigrosProvider, MigrosSession, normaliseProduct } from '../src/providers/migros';
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

async function main(): Promise<void> {
  console.log('migros provider');

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
