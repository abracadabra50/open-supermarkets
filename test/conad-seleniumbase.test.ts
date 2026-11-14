import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.platform === 'win32') {
  console.log('  ○ Conad worker requires Unix sockets');
} else {
  const result = spawnSync(process.env.CONAD_PYTHON || 'python3', [path.join(__dirname, 'conad_seleniumbase_unit.py')], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 30_000,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT' && !process.env.CI) {
    console.log('  ○ optional Conad runtime tests require Python 3.10+ (CI runs them explicitly)');
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, 'Conad Python runtime tests failed');
  }
}
