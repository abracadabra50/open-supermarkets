/** Opt-in, read-only live checks; never run by the offline test runner. */
import assert from 'node:assert/strict';
import { createProvider } from '../src/providers/registry';

async function main() {
  const provider = await createProvider('conad');
  if (process.env.CONAD_LIVE_LOCAL !== 'true') {
    console.log('Set CONAD_LIVE_LOCAL=true with a configured SeleniumBase profile for local catalogue checks.');
    return;
  }
  const store = await provider.getStore!(); assert.ok(store, 'configure a local store first');
  const products = await provider.search('latte', { limit: 5 });
  assert.ok(products.length > 0);
  for (const product of products) {
    assert.equal(product.store?.store_id, store.store_id); assert.equal(product.currency, 'EUR');
    assert.ok(product.retail_price.price === null || product.retail_price.price > 0);
  }
  const detail = await provider.getProduct!(products[0].product_uid);
  assert.equal(detail.product_uid, products[0].product_uid); assert.equal(detail.store?.store_id, store.store_id);
  const page = await provider.search('latte', { offset: 39, limit: 3 });
  assert.equal(new Set(page.map(p => p.product_uid)).size, page.length);
  assert.deepEqual(await provider.search('zzqxnonexistent874553', { limit: 5 }), []);
  console.log(`✓ Local catalogue, detail, pagination and empty search at store ${store.store_id}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Conad live probe failed'); process.exitCode = 1; });
