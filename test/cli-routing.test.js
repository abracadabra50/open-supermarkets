'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

function run(...args) {
  return spawnSync(TSX, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      CI: '1',
    },
  });
}

function output(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

// Keep these checks offline. The selected providers either do not exist or are
// search-only, so a correct router must fail before a retailer request.
const explicitProvider = run(
  '--provider', 'not-a-real-provider',
  'search', 'milk', '--country', 'NL', '--json'
);
assert.equal(explicitProvider.status, 1);
assert.match(output(explicitProvider), /Unknown provider: "not-a-real-provider"/);
assert.doesNotMatch(output(explicitProvider), /TypeError|Search results/);

const searchOnlyBasket = run('--provider', 'ah', 'basket', '--json');
assert.equal(searchOnlyBasket.status, 1);
assert.match(output(searchOnlyBasket), /ah does not support "basket"/);
assert.doesNotMatch(output(searchOnlyBasket), /TypeError|ENOTFOUND|ECONN/);

const searchOnlyStores = run('--provider', 'ah', 'stores', '--json');
assert.equal(searchOnlyStores.status, 1);
assert.match(output(searchOnlyStores), /ah does not support "stores"/);
assert.doesNotMatch(output(searchOnlyStores), /TypeError|ENOTFOUND|ECONN/);

const storeSelectionNeedsCapability = run(
  '--provider', 'ah', '--store-id', 'fixture-store', 'search', 'milk', '--json'
);
assert.equal(storeSelectionNeedsCapability.status, 1);
assert.match(output(storeSelectionNeedsCapability), /ah does not support "stores"/);
assert.doesNotMatch(output(storeSelectionNeedsCapability), /TypeError|ENOTFOUND|ECONN/);

for (const [name, args, expected] of [
  ['invalid latitude', ['stores', '--latitude', 'not-a-number'], /latitude must be a number/],
  ['invalid mode', ['stores', '--mode', 'delivery-ish'], /mode must be pickup or delivery/],
]) {
  const result = run('--provider', 'ah', ...args);
  assert.equal(result.status, 1, `${name} should fail locally`);
  assert.match(output(result), expected);
  assert.doesNotMatch(output(result), /ah does not support|TypeError|ENOTFOUND|ECONN/);
}

for (const [name, args, expected] of [
  ['login', ['login', '--email', 'fixture@example.test', '--password', 'fixture'], 'login'],
  ['logout', ['logout'], 'logout'],
  ['status', ['status', '--json'], 'authentication status'],
  ['categories', ['categories', '--json'], 'categories'],
  ['favourites', ['favourites', '--json'], 'favourites'],
  ['browse', ['browse', 'fresh', '--json'], 'category browsing'],
]) {
  const result = run('--provider', 'ah', ...args);
  assert.equal(result.status, 1, `${name} should fail without network access`);
  assert.match(output(result), new RegExp(`does not support ${expected}`));
  assert.doesNotMatch(output(result), /TypeError|ENOTFOUND|ECONN/);
}

console.log('CLI routing tests passed');
