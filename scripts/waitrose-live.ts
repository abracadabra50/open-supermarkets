/**
 * Optional live probe. Never called by the offline test runner or CI.
 * Run: npm run test:waitrose:live
 */
import { WaitroseProvider } from '../src/providers/waitrose';

/** Run one opt-in public-catalogue probe without changing any Waitrose state. */
async function main() {
  const products = await new WaitroseProvider().search('milk', { limit: 3 });
  if (!products.length) throw new Error('Waitrose live search returned no products for "milk"');
  console.log(JSON.stringify(products, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
