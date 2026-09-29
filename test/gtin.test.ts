/**
 * GTIN normalisation, and the mappers that expose it.
 *
 * The point of the field is that two providers' barcodes are comparable, so the
 * thing worth asserting is that a Tesco response and a Sainsbury's response for
 * the same product land on the same string.
 *
 * Payloads below are trimmed from live responses captured 2026-08-29 —
 * xapi.tesco.com (region UK) and sainsburys.co.uk/groceries-api — for a product
 * both retailers stock. Ids and barcodes are public catalogue values.
 *
 * Offline: no network, no credentials. Run: npx tsx test/gtin.test.ts
 */

import assert from 'node:assert';
import { toGtin14, isValidGtin, cleanGtin, firstValidGtin } from '../src/providers/gtin';
import { normaliseProduct as tescoProduct } from '../src/providers/tesco/index';
import { normaliseProduct as sainsburysProduct } from '../src/providers/sainsburys';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

// Heinz Baked Beans 4 x 415g — stocked by both, and the barcode that made the
// cross-retailer join verifiable in the first place.
const TESCO_RAW = {
  id: '267204718',
  gtin: '05000157024886',
  title: 'Heinz Baked Beans In Tomato Sauce 4X415g',
  price: { actual: 3.9 },
  defaultImageUrl: 'https://digitalcontent.api.tesco.com/v2/media/ghs/example.jpeg',
};

const SAINSBURYS_RAW = {
  product_uid: '7907461',
  name: "Heinz Baked Beans in a Rich Tomato Sauce 4 x 415g",
  eans: ['5000157024886'],
  retail_price: { price: 3.9, measure: '' },
  unit_price: { price: 2.35, measure: 'kg', measure_amount: 1 },
  is_available: true,
  image: 'https://assets.sainsburys-groceries.co.uk/gol/7907461/image.jpg',
};

async function main() {
  console.log('gtin: normalisation');

  await check('Tesco padding and a bare EAN-13 normalise to the same GTIN-14', () => {
    assert.strictEqual(toGtin14('05000157024886'), toGtin14('5000157024886'));
    assert.strictEqual(toGtin14('5000157024886'), '05000157024886');
  });

  await check('shorter GTIN forms widen to 14', () => {
    assert.strictEqual(toGtin14('96385074'), '00000096385074');     // GTIN-8
    assert.strictEqual(toGtin14('614141000036'), '00614141000036'); // GTIN-12
  });

  await check('an internal product code is not a barcode', () => {
    // An Ocado SKU like 78914011 is eight digits, which is a legal GTIN-8
    // LENGTH — so normalisation alone accepts it and returns something that
    // looks authoritative and matches nothing. Only the check digit separates
    // the two, which is why the mappers call cleanGtin and not toGtin14.
    assert.strictEqual(toGtin14('78914011'), '00000078914011');
    assert.strictEqual(cleanGtin('78914011'), undefined);
    assert.strictEqual(toGtin14('1234567890123456'), undefined); // too long for any form
  });

  await check('empty and junk are undefined, not a crash', () => {
    for (const v of [undefined, null, '', '   ', 'abc', 0]) {
      assert.strictEqual(toGtin14(v as any), undefined);
    }
  });

  await check('the GS1 check digit is enforced', () => {
    assert.ok(isValidGtin('5000157024886'), 'real EAN-13 should validate');
    assert.ok(isValidGtin('05000157024886'), 'same code, zero-padded');
    assert.ok(!isValidGtin('5000157024887'), 'last digit altered');
  });

  console.log('\ngtin: first valid in a list');

  await check('the first USABLE barcode wins, not simply the first entry', () => {
    // Sainsbury's `eans` can lead with an empty string, an internal code, or a
    // truncated value. Taking [0] blindly yields an identifier that joins to
    // nothing, which is worse than reporting none.
    assert.strictEqual(firstValidGtin(['', '5000157024886']), '05000157024886');
    assert.strictEqual(firstValidGtin(['78914011', '5000157024886']), '05000157024886');
    assert.strictEqual(firstValidGtin(['5000157024887', '5000157024886']), '05000157024886');
  });

  await check('a list with nothing usable is undefined', () => {
    assert.strictEqual(firstValidGtin([]), undefined);
    assert.strictEqual(firstValidGtin(['', null, undefined, 'abc']), undefined);
    assert.strictEqual(firstValidGtin(undefined), undefined);
    assert.strictEqual(firstValidGtin(null), undefined);
  });

  await check('a bare value is accepted as well as a list', () => {
    assert.strictEqual(firstValidGtin('5000157024886'), '05000157024886');
  });

  console.log('\ngtin: the mappers');

  await check('Tesco exposes the gtin its query already selected', () => {
    const p = tescoProduct(TESCO_RAW);
    assert.strictEqual(p.gtin, '05000157024886');
    // product_uid must NOT change: basket operations address products by it.
    assert.strictEqual(p.product_uid, '267204718');
  });

  await check("Sainsbury's exposes the first valid ean", () => {
    const p = sainsburysProduct(SAINSBURYS_RAW);
    assert.strictEqual(p.gtin, '05000157024886');
    assert.strictEqual(p.product_uid, '7907461');
  });

  await check('🔴 both providers expose the SAME normalised GTIN for one product', () => {
    const t = tescoProduct(TESCO_RAW);
    const s = sainsburysProduct(SAINSBURYS_RAW);
    assert.strictEqual(
      t.gtin,
      s.gtin,
      `Tesco ${t.gtin} vs Sainsbury's ${s.gtin} — the cross-retailer join is broken`,
    );
    assert.ok(t.gtin, 'a join on undefined is not a join');
    // ...and the retailer-specific ids remain different, which is the point of
    // keeping gtin separate from product_uid.
    assert.notStrictEqual(t.product_uid, s.product_uid);
  });

  await check('a product with no barcode leaves gtin undefined, not empty', () => {
    assert.strictEqual(tescoProduct({ id: '1', title: 'Loose bananas' }).gtin, undefined);
    assert.strictEqual(
      sainsburysProduct({ product_uid: '2', name: 'Loose bananas', eans: [] }).gtin,
      undefined,
    );
  });

  await check('the rest of the mapping is unchanged', () => {
    const t = tescoProduct(TESCO_RAW);
    assert.strictEqual(t.name, 'Heinz Baked Beans In Tomato Sauce 4X415g');
    assert.strictEqual(t.retail_price.price, 3.9);
    assert.strictEqual(t.provider, 'tesco');
    const s = sainsburysProduct(SAINSBURYS_RAW);
    assert.strictEqual(s.provider, 'sainsburys');
    assert.strictEqual(s.in_stock, true);
  });

  if (failures) {
    console.error(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nall passing');
}

main();
