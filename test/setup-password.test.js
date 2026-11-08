const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-password-'));
try {
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  // Stand in for the launcher: capture exactly what setup passes to it.
  fs.writeFileSync(path.join(bin, 'npx'), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({
  args: process.argv.slice(2), password: process.env.SUPERMARKET_PASSWORD
}));
console.log('Logged in');
`, { mode: 0o700 });

  const password = 'synthetic secret $value; * - leading spaces';
  for (const [choice, provider] of [['1', 'sainsburys'], ['2', 'ocado']]) {
    const home = path.join(temp, provider);
    fs.mkdirSync(home);
    const capture = path.join(home, 'capture.json');
    const result = spawnSync('bash', ['setup.sh'], {
      cwd: repo,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
        CAPTURE_FILE: capture, SUPERMARKET_PASSWORD: 'stale inherited password' },
      input: `${choice}\ntest@example.invalid\n${password}\n7\n\n1\n2\n`,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const received = JSON.parse(fs.readFileSync(capture, 'utf8'));
    assert.deepEqual(received.args, [
      'ts-node', 'src/cli.ts', '--provider', provider, 'login', '--email', 'test@example.invalid',
    ]);
    assert.equal(received.password, password);
    assert.ok(!result.stdout.includes(password), 'setup printed the password');
    assert.match(result.stdout, /Login successful/);
  }
  console.log('Setup keeps passwords out of launcher arguments for both providers');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
