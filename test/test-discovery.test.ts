/**
 * `npm test` must run every test file, not a hand-kept list of them.
 *
 * A test that exists but never runs is worse than no test: CI goes green and
 * everyone believes the behaviour is covered. This asserts the runner finds
 * files by name alone, and that package.json can't quietly route around it.
 *
 * Run: npx tsx test/test-discovery.test.ts
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { discoverTests } = require('../scripts/run-tests.js') as { discoverTests: (dir: string) => string[] };

const REPO = path.resolve(__dirname, '..');

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

console.log('test-discovery');

check('a newly added test file is discovered without editing anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'groc-discovery-'));
  try {
    fs.mkdirSync(path.join(dir, 'providers'));
    fs.mkdirSync(path.join(dir, 'fixtures'));
    fs.writeFileSync(path.join(dir, 'b.test.ts'), '');
    fs.writeFileSync(path.join(dir, 'a.test.js'), '');
    fs.writeFileSync(path.join(dir, 'providers', 'new-shop.test.ts'), '');
    fs.writeFileSync(path.join(dir, 'helpers.ts'), '');
    fs.writeFileSync(path.join(dir, 'fixtures', 'captured.test.ts'), '');
    fs.writeFileSync(path.join(dir, 'notes.test.md'), '');

    const found = discoverTests(dir).map((f) => path.relative(dir, f));
    assert.deepStrictEqual(found, ['a.test.js', 'b.test.ts', path.join('providers', 'new-shop.test.ts')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('every *.test.ts in test/ is discovered, including this one', () => {
  const found = discoverTests(path.join(REPO, 'test')).map((f) => path.basename(f));
  const onDisk = fs.readdirSync(path.join(REPO, 'test')).filter((f) => /\.test\.(ts|js)$/.test(f));
  assert.ok(found.includes(path.basename(__filename)), 'runner does not see test-discovery.test.ts');
  for (const f of onDisk) assert.ok(found.includes(f), `${f} would not run`);
});

check('npm test goes through the runner, and is defined exactly once', () => {
  const raw = fs.readFileSync(path.join(REPO, 'package.json'), 'utf8');
  // JSON.parse keeps the last duplicate key silently; count the raw keys instead.
  const scriptsBlock = raw.slice(raw.indexOf('"scripts"'), raw.indexOf('}', raw.indexOf('"scripts"')));
  const testKeys = scriptsBlock.match(/"test"\s*:/g) ?? [];
  assert.strictEqual(testKeys.length, 1, `scripts.test is defined ${testKeys.length} times`);

  const { scripts } = JSON.parse(raw);
  assert.match(scripts.test, /scripts\/run-tests\.js/, `scripts.test is "${scripts.test}"`);
});

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
