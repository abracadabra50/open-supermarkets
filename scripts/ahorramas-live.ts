/**
 * Opt-in live smoke test. It is intentionally not part of `npm test`: retailer
 * catalogues, counts and prices are dynamic.
 *
 * Run with: npx tsx scripts/ahorramas-live.ts
 */

import assert from 'node:assert';
import { AhorramasProvider } from '../src/providers/ahorramas';

async function main() {
  const provider = new AhorramasProvider();

  for (const query of ['leche', 'aceite oliva']) {
    const products = await provider.search(query, { limit: 5 });
    assert.ok(products.length > 0, `${query}: expected at least one result`);
    for (const product of products) {
      assert.ok(product.product_uid, `${query}: product_uid is missing`);
      assert.ok(product.name, `${query}: name is missing`);
      assert.ok(Number.isFinite(product.retail_price.price), `${query}: price is invalid`);
      assert.strictEqual(product.currency, 'EUR', `${query}: currency is not EUR`);
      if (product.unit_price) {
        assert.ok(Number.isFinite(product.unit_price.price), `${query}: unit price is invalid`);
      }
    }
    console.log(`✓ ${query}: ${products.length} live results`);
  }

  const missing = await provider.search('zzzz-no-existe-12345', { limit: 5 });
  assert.strictEqual(missing.length, 0, 'nonexistent query should have no results');
  console.log('✓ zzzz-no-existe-12345: 0 live results');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
