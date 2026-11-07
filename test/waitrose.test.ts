import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { errors } from 'playwright';
import { getManifest, createProvider } from '../src/providers/registry';
import { normaliseWaitroseCard, WaitroseProvider } from '../src/providers/waitrose';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'waitrose-cards.json'), 'utf8')
);

let failures = 0;
/** Run one isolated assertion and report a TAP-like result. */
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

/** Build a browser double that executes the real product-card extractor callback. */
function browserWithCards(cards: any[], body: string = '', waitError?: Error) {
  let contextClosed = false;
  let browserClosed = false;
  let productSelectorUsed = false;
  const anchors = cards.map(card => ({
    href: card.href,
    innerText: card.text,
    parentElement: { tagName: 'BODY' },
    getAttribute: (name: string) => name === 'aria-label' ? card.name : null,
    querySelector: () => card.imageUrl ? { currentSrc: card.imageUrl } : null,
  }));
  const page: any = {
    goto: async () => ({ status: () => 200 }),
    locator: (selector: string) => {
      if (selector.includes('/ecom/products/')) {
        productSelectorUsed = true;
        return {
          first: () => ({ waitFor: async () => { if (waitError) throw waitError; } }),
          evaluateAll: async (callback: (nodes: unknown[]) => unknown) => callback(anchors),
        };
      }
      return { innerText: async () => body };
    },
  };
  const browser: any = {
    newContext: async () => ({ newPage: async () => page, close: async () => { contextClosed = true; } }),
    close: async () => { browserClosed = true; },
  };
  return {
    browser,
    closed: () => ({ contextClosed, browserClosed }),
    usedProductSelector: () => productSelectorUsed,
  };
}

/** Execute the offline Waitrose provider tests. */
async function main() {
  console.log('waitrose provider');

  await check('normalises public pound and pence price cards', () => {
    const milk = normaliseWaitroseCard(fixture[0]);
    const lemon = normaliseWaitroseCard(fixture[1]);
    assert.deepEqual(milk, {
      product_uid: '123456-123457-123458',
      name: 'Essential British Semi Skimmed Milk 2 Pints 1.136L',
      retail_price: { price: 1.2 },
      unit_price: { price: 1.06, measure: 'litre' },
      in_stock: null,
      image_url: 'https://images.example.test/milk.jpg',
      provider: 'waitrose',
      currency: 'GBP',
      size: '1.136L',
    });
    assert.equal(lemon?.retail_price.price, 0.4);
    assert.deepEqual(lemon?.unit_price, { price: 0.4, measure: 'each' });
    assert.equal(lemon?.in_stock, null);
  });

  await check('drops malformed public cards instead of inventing a product', () => {
    assert.equal(normaliseWaitroseCard({ id: '1', name: 'Milk', text: 'Milk' }), undefined);
    assert.equal(normaliseWaitroseCard({ name: 'Milk', text: 'Item price\n£1.00' }), undefined);
  });

  await check('validates unsupported search arguments before launching a browser', async () => {
    let launched = false;
    const provider = new WaitroseProvider(async () => { launched = true; throw new Error('should not launch'); });
    await assert.rejects(() => provider.search('  '), /must not be empty/);
    await assert.rejects(() => provider.search('milk', { offset: 1 }), /pagination is not implemented/);
    await assert.rejects(() => provider.search('milk', { category: 'dairy' }), /category filtering/);
    assert.deepEqual(await provider.search('milk', { limit: 0 }), []);
    assert.equal(launched, false);
  });

  await check('extracts public cards through the product selector and cleans browser resources', async () => {
    const fake = browserWithCards(fixture);
    const provider = new WaitroseProvider(async () => fake.browser);
    const products = await provider.search('milk', { limit: 1 });
    assert.deepEqual(products, [normaliseWaitroseCard(fixture[0])]);
    assert.equal(fake.usedProductSelector(), true);
    assert.deepEqual(fake.closed(), { contextClosed: true, browserClosed: true });
  });

  await check('only returns an empty list for an explicit no-results page', async () => {
    const empty = browserWithCards([], "Sorry, we couldn't find any products", new errors.TimeoutError('no cards'));
    const provider = new WaitroseProvider(async () => empty.browser);
    assert.deepEqual(await provider.search('not-a-real-product'), []);

    const unexpected = browserWithCards([], 'Welcome to Waitrose');
    const failingProvider = new WaitroseProvider(async () => unexpected.browser);
    await assert.rejects(() => failingProvider.search('milk'), /unexpected page without product cards/);
    assert.deepEqual(unexpected.closed(), { contextClosed: true, browserClosed: true });
  });

  await check('propagates non-timeout selector failures instead of hiding page errors', async () => {
    const failing = browserWithCards([], '', new Error('Waitrose page crashed'));
    const provider = new WaitroseProvider(async () => failing.browser);
    await assert.rejects(() => provider.search('milk'), /Waitrose page crashed/);
    assert.deepEqual(failing.closed(), { contextClosed: true, browserClosed: true });
  });

  await check('registry advertises anonymous search and lazy-loads Waitrose', async () => {
    const manifest = getManifest('waitrose');
    assert.deepEqual(manifest.capabilities, ['search']);
    assert.equal(manifest.auth, 'anonymous');
    assert.equal(manifest.tier, 'community');
    assert.equal((await createProvider('waitrose')).name, 'waitrose');
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
