'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  // Keep this offline: the login command must never reach a retailer.
  fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\necho "Logged in"\n', { mode: 0o700 });
  return {
    home, bin, config: path.join(home, '.uk-grocery-config.json'),
    run(overwrite = false) {
      return spawnSync('bash', ['-c', 'umask 000; exec bash "$1"', 'setup-test', path.resolve(__dirname, '../setup.sh')], {
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
        input: `${overwrite ? 'y\n' : ''}1\nsynthetic@example.invalid\nsynthetic-password\n7\n\n2\n2\n`,
        encoding: 'utf8', timeout: 10000,
      });
    },
  };
}

for (const existing of [false, true]) {
  test(`setup saves private credentials ${existing ? 'over an existing readable file' : 'under a permissive umask'}`, (t) => {
    const f = fixture(t);
    if (existing) {
      fs.writeFileSync(f.config, 'old config');
      fs.chmodSync(f.config, 0o644);
    }
    const result = f.run(existing);
    assert.equal(result.status, 0, result.stderr);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
    }
    assert.equal(JSON.parse(fs.readFileSync(f.config, 'utf8')).password, 'synthetic-password');
    assert.deepEqual(fs.readdirSync(f.home).sort(), ['.uk-grocery-config.json', 'bin']);
  });
}

test('setup replaces a config symlink without writing credentials to its target', (t) => {
  const f = fixture(t);
  const target = path.join(f.home, 'target');
  fs.writeFileSync(target, 'untouched');
  fs.symlinkSync(target, f.config);
  assert.equal(f.run(true).status, 0);
  assert.equal(fs.lstatSync(f.config).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
  }
});

test('failed replacement preserves the old config and removes temporary credentials', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.config, 'old config');
  fs.writeFileSync(path.join(f.bin, 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const result = f.run(true);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.config, 'utf8'), 'old config');
  assert.deepEqual(fs.readdirSync(f.home).sort(), ['.uk-grocery-config.json', 'bin']);
});

test('temporary config creation fails before credentials are written', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.bin, 'mktemp'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not create temporary configuration file/);
  assert.deepEqual(fs.readdirSync(f.home).sort(), ['bin']);
});
