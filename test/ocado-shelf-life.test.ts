/**
 * Ocado guaranteed product life — offline tests.
 *
 * Entities below are trimmed from live `productEntities` blobs on
 * ocado.com search pages, captured 2026-08-28 and 2026-09-30. Product ids are
 * public catalogue values.
 *
 * No network, no credentials. Run: npx tsx test/ocado-shelf-life.test.ts
 */

import assert from 'node:assert';
import { shelfLifeDays, normaliseEntity } from '../src/providers/ocado';

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

// Captured 2026-08-28. Six days is the shortest life observed on a milk line
// and the reason a per-pack figure beats a per-food table.
const YEO_VALLEY = {
  productId: 'c05873ac-d00c-45db-9703-36d96fe2823e',
  name: 'Yeo Valley Organic Fresh Semi Skimmed Milk',
  brand: 'Yeo Valley',
  price: { current: { amount: 3.15 }, unit: { current: { amount: 1.58 } } },
  size: { value: '2L' },
  available: true,
  image: '/productImages/example.jpg',
  ratingSummary: { overallRating: 3.8, count: 225 },
  guaranteedProductLife: { quantity: 6, unit: 'DAY' },
};

// Captured 2026-09-30. Same shelf, more than twice the life.
const ARLA_BOB = {
  productId: '9f1c2f31-0000-0000-0000-000000000000',
  name: 'Arla BOB Semi-Skimmed Milk that Tastes like Whole',
  brand: 'Arla',
  price: { current: { amount: 1.85 } },
  size: { value: '2L' },
  available: true,
  guaranteedProductLife: { quantity: 2, unit: 'WEEK' },
};

async function main() {
  console.log('ocado: shelf life conversion');

  await check('DAY and WEEK convert to days', () => {
    assert.strictEqual(shelfLifeDays({ quantity: 6, unit: 'DAY' }), 6);
    assert.strictEqual(shelfLifeDays({ quantity: 2, unit: 'WEEK' }), 14);
    assert.strictEqual(shelfLifeDays({ quantity: 1, unit: 'WEEK' }), 7);
  });

  await check('MONTH and YEAR are handled, though unobserved live', () => {
    assert.strictEqual(shelfLifeDays({ quantity: 3, unit: 'MONTH' }), 90);
    assert.strictEqual(shelfLifeDays({ quantity: 1, unit: 'YEAR' }), 365);
  });

  await check('plural and lower-case units are tolerated', () => {
    assert.strictEqual(shelfLifeDays({ quantity: 5, unit: 'DAYS' }), 5);
    assert.strictEqual(shelfLifeDays({ quantity: 2, unit: 'weeks' }), 14);
  });

  await check('🔴 an unrecognised unit returns undefined, never a guess', () => {
    // If Ocado adds a unit, "no answer" lets a caller fall back to its own
    // estimate. A wrong number silently mis-sequences a plan instead.
    assert.strictEqual(shelfLifeDays({ quantity: 2, unit: 'FORTNIGHT' }), undefined);
    assert.strictEqual(shelfLifeDays({ quantity: 2, unit: '' }), undefined);
    assert.strictEqual(shelfLifeDays({ quantity: 2 }), undefined);
  });

  await check('a missing or nonsense quantity returns undefined', () => {
    for (const raw of [
      undefined, null, {},
      { quantity: 0, unit: 'DAY' },
      { quantity: -3, unit: 'DAY' },
      { quantity: 'soon', unit: 'DAY' },
    ]) {
      assert.strictEqual(shelfLifeDays(raw as any), undefined, JSON.stringify(raw));
    }
  });

  console.log('\nocado: the mapper');

  await check('a captured entity carries its stated life', () => {
    assert.strictEqual(normaliseEntity(YEO_VALLEY).shelf_life_days, 6);
    assert.strictEqual(normaliseEntity(ARLA_BOB).shelf_life_days, 14);
  });

  await check('two lines on the same shelf differ, which is the point', () => {
    const a = normaliseEntity(YEO_VALLEY).shelf_life_days!;
    const b = normaliseEntity(ARLA_BOB).shelf_life_days!;
    assert.ok(b > a * 2, `${b}d should be more than twice ${a}d`);
  });

  await check('an entity with no stated life leaves the field undefined', () => {
    const { guaranteedProductLife, ...bare } = YEO_VALLEY;
    assert.strictEqual(normaliseEntity(bare).shelf_life_days, undefined);
  });

  await check('the rest of the mapping is unchanged', () => {
    const p = normaliseEntity(YEO_VALLEY);
    assert.strictEqual(p.product_uid, 'c05873ac-d00c-45db-9703-36d96fe2823e');
    assert.strictEqual(p.name, 'Yeo Valley Organic Fresh Semi Skimmed Milk');
    assert.strictEqual(p.description, 'Brand: Yeo Valley');
    assert.strictEqual(p.retail_price.price, 3.15);
    assert.deepStrictEqual(p.unit_price, { measure: '2L', price: 1.58 });
    assert.strictEqual(p.size, '2L');
    assert.strictEqual(p.in_stock, true);
    assert.strictEqual(p.rating, 3.8);
    assert.strictEqual(p.review_count, 225);
    assert.strictEqual(p.provider, 'ocado');
    assert.ok(p.image_url?.startsWith('https://www.ocado.com/'));
  });

  await check('the provider name is overridable, as elsewhere', () => {
    assert.strictEqual(normaliseEntity(ARLA_BOB, 'ocado-test').provider, 'ocado-test');
  });

  if (failures) {
    console.error(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nall passing');
}

main();
