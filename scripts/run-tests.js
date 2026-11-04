#!/usr/bin/env node
/**
 * Offline test runner.
 *
 * Finds every `*.test.ts` / `*.test.js` under test/ and runs each one in its own
 * process with tsx. There is no list to maintain: a new test file is picked up
 * by being named correctly. A file fails if it exits non-zero.
 *
 * Live-provider probes live in scripts/ (e.g. `npm run test:ahorramas:live`)
 * and are never discovered here.
 *
 * Usage: node scripts/run-tests.js [filter]
 *   filter  optional substring; only matching test paths run
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_FILE = /\.test\.(ts|js)$/;
const SKIP_DIRS = new Set(['fixtures', 'node_modules']);

/** Sorted, repo-relative paths of every test file under `dir`. */
function discoverTests(dir, root = dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...discoverTests(full, root));
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return dir === root ? found.sort() : found;
}

function main() {
  const repo = path.resolve(__dirname, '..');
  const filter = process.argv[2];
  const tsx = require.resolve('tsx/cli', { paths: [repo] });

  const files = discoverTests(path.join(repo, 'test'))
    .filter((f) => !filter || f.includes(filter));

  if (files.length === 0) {
    console.error(filter ? `No test files match "${filter}".` : 'No test files found under test/.');
    process.exit(1);
  }

  const failed = [];
  for (const file of files) {
    const rel = path.relative(repo, file);
    console.log(`\n▶ ${rel}`);
    const r = spawnSync(process.execPath, [tsx, file], { cwd: repo, stdio: 'inherit' });
    if (r.status !== 0) failed.push(`${rel} (${r.signal ? `signal ${r.signal}` : `exit ${r.status}`})`);
  }

  console.log(`\n${files.length - failed.length}/${files.length} test files passed`);
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
}

module.exports = { discoverTests, TEST_FILE };

if (require.main === module) main();
