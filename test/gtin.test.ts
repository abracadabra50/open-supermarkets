/**
 * GTIN normalisation.
 *
 * The point of the field is that two providers' barcodes are comparable, so
 * the thing worth asserting is that Tesco's zero-padded form and Sainsbury's
 * bare EAN-13 land on the same string for the same product.
 *
 * Offline, no credentials, no network — the CI contract.
 *
 * Run: npx tsx test/gtin.test.ts
 */

import assert from 'node:assert';
import { toGtin14, isValidGtin, cleanGtin } from '../src/providers/gtin.js';

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('gtin');

// The reason this module exists: same product, two shapes, one identity.
check('Tesco padding and a bare EAN-13 normalise to the same GTIN-14', () => {
  assert.strictEqual(toGtin14('05000157024671'), toGtin14('5000157024671'));
  assert.strictEqual(toGtin14('5000157024671'), '05000157024671');
});

check('shorter GTIN forms widen to 14', () => {
  assert.strictEqual(toGtin14('96385074'), '00000096385074');       // GTIN-8
  assert.strictEqual(toGtin14('614141000036'), '00614141000036');   // GTIN-12
});

check('an internal product code is not a barcode', () => {
  // 🔴 THIS IS WHY THE MAPPERS CALL cleanGtin AND NOT toGtin14.
  //
  // An Ocado SKU like 78914011 is eight digits, which is a legal GTIN-8
  // LENGTH — so normalisation alone accepts it and hands back something that
  // looks authoritative and matches nothing. Only the check digit tells the
  // two apart, and a wrong barcode is worse than no barcode: it silently
  // fails to join instead of falling back to a name match.
  assert.strictEqual(toGtin14('78914011'), '00000078914011');
  assert.strictEqual(cleanGtin('78914011'), undefined);
  // Too long to be any GTIN form.
  assert.strictEqual(toGtin14('1234567890123456'), undefined);
});

check('empty and junk are undefined, not a crash', () => {
  for (const v of [undefined, null, '', '   ', 'abc', 0]) {
    assert.strictEqual(toGtin14(v as any), undefined);
  }
});

check('the GS1 check digit is enforced', () => {
  assert.ok(isValidGtin('5000157024671'), 'real Heinz EAN-13 should validate');
  assert.ok(isValidGtin('05000157024671'), 'same code, zero-padded');
  assert.ok(!isValidGtin('5000157024672'), 'last digit altered');
  assert.ok(!isValidGtin('5000157026071'.replace('26', '62')), 'transposed digits');
});

check('cleanGtin drops anything that fails its own check digit', () => {
  assert.strictEqual(cleanGtin('5000157024671'), '05000157024671');
  assert.strictEqual(cleanGtin('5000157024672'), undefined);
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nall passing');
