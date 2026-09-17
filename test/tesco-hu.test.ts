/**
 * Tesco Hungary provider — offline tests.
 *
 * Everything here runs without network or credentials. Fixtures are copied from
 * live xapi.tesco.com responses (region HU) captured on 2026-09-17; ids are public
 * catalogue ids.
 *
 * Run: npx tsx test/tesco-hu.test.ts
 */

import assert from 'node:assert';
import { money, sym } from '../src/format';

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

async function main() {
  console.log('format: forint');

  await check('HUF renders as whole forints with a trailing symbol', () => {
    assert.strictEqual(money(126, 'HUF'), '126 Ft');
    assert.strictEqual(money(1234.6, 'HUF'), '1235 Ft');
    assert.strictEqual(sym('HUF'), 'Ft');
  });

  await check('other currencies are unchanged', () => {
    assert.strictEqual(money(1.5, 'GBP'), '£1.50');
    assert.strictEqual(money(1.5), '£1.50');
    assert.strictEqual(money(12, 'BRL'), 'BRL 12.00');
  });

  process.exit(failures ? 1 : 0);
}

main();
