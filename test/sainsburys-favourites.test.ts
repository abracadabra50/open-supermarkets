/**
 * Sainsbury's favourites must page through /product/v1/favourites.
 *
 * The live API defaults to one page of ~24 products — the same page_size
 * search() already sends. Without page_number/page_size, both
 * `supermarket favourites --limit 100` and fav-search only ever see that
 * first page (issue #17).
 *
 * Run: npx tsx test/sainsburys-favourites.test.ts
 */

import assert from 'node:assert';
import { SainsburysProvider } from '../src/providers/sainsburys';

const PAGE_SIZE = 24;
const TOTAL = 50;

function rawProduct(i: number, name?: string) {
  return {
    product_uid: `fav-${i}`,
    name: name ?? `Favourite item ${i}`,
    retail_price: { price: 1.5 },
    in_stock: true,
  };
}

/** 50 favourites across three pages. Index 30 ("milk") lives on page 2. */
function catalogue() {
  const products = [];
  for (let i = 0; i < TOTAL; i++) {
    products.push(rawProduct(i, i === 30 ? 'Hidden Favourite Semi Skimmed Milk' : undefined));
  }
  return products;
}

function stubFavourites(provider: SainsburysProvider, captured: Array<{ url: string; params: Record<string, unknown> }>) {
  const all = catalogue();
  (provider as any).client.get = async (url: string, config: { params?: Record<string, unknown> }) => {
    const params = { ...(config?.params || {}) };
    captured.push({ url, params });
    // Missing page_number → first page, matching the live API default.
    const page = Number(params.page_number) || 1;
    const size = Number(params.page_size) || PAGE_SIZE;
    const start = (page - 1) * size;
    return { data: { products: all.slice(start, start + size) } };
  };
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

async function main() {
  console.log('sainsburys favourites pagination');

  await check('getFavourites walks pages so --limit 100 is not capped at 24', async () => {
    const provider = new SainsburysProvider();
    const captured: Array<{ url: string; params: Record<string, unknown> }> = [];
    stubFavourites(provider, captured);

    const products = await provider.getFavourites({ limit: 100 });
    assert.strictEqual(
      products.length,
      TOTAL,
      `expected all ${TOTAL} favourites, got ${products.length}`
    );
    assert.ok(
      captured.every((c) => c.url === '/product/v1/favourites'),
      `unexpected urls: ${captured.map((c) => c.url).join(', ')}`
    );
    assert.ok(
      captured.some((c) => Number(c.params.page_number) >= 2),
      `expected a request with page_number>=2, got ${JSON.stringify(captured.map((c) => c.params))}`
    );
    assert.ok(
      captured.every((c) => c.params.page_size != null),
      'each favourites request must send page_size (same as search())'
    );
    assert.strictEqual(products[30].product_uid, 'fav-30');
    assert.strictEqual(products[30].name, 'Hidden Favourite Semi Skimmed Milk');
  });

  await check('searchFavourites sees a match that only exists on page 2', async () => {
    const provider = new SainsburysProvider();
    const captured: Array<{ url: string; params: Record<string, unknown> }> = [];
    stubFavourites(provider, captured);

    const hits = await provider.searchFavourites('semi skimmed milk');
    assert.strictEqual(
      hits.length,
      1,
      `expected the page-2 milk favourite, got ${hits.map((p) => p.name).join(', ') || 'none'}`
    );
    assert.strictEqual(hits[0].product_uid, 'fav-30');
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
