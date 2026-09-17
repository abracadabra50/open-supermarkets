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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { money, sym } from '../src/format';
import {
  parseCookieHeader,
  normaliseCookieExport,
  inferSessionExpiry,
  saveSession,
  loadSession,
  getSessionInfo,
  clearSession,
  getCookieString,
  importSessionFromHeader,
} from '../src/providers/tesco-hu/session';

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

  console.log('\nsession store');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesco-hu-test-'));
  const tmpFile = path.join(tmpDir, 'session.json');

  await check('parseCookieHeader tolerates the header name and keeps = inside values', () => {
    const cookies = parseCookieHeader('Cookie: a=1; token=abc=def; empty');
    assert.deepStrictEqual(cookies.map(c => [c.name, c.value]), [['a', '1'], ['token', 'abc=def']]);
    assert.strictEqual(cookies[0].domain, '.tesco.hu');
  });

  await check('parseCookieHeader rejects an empty header', () => {
    assert.throws(() => parseCookieHeader('   '), /No cookies parsed/);
  });

  await check('normaliseCookieExport accepts array, {cookies}, object-of-arrays and Capitalised keys', () => {
    const fromArray = normaliseCookieExport([{ name: 'a', value: '1' }]);
    assert.strictEqual(fromArray.length, 1);
    const fromWrapped = normaliseCookieExport({ cookies: [{ Name: 'b', Value: '2', Domain: 'www.tesco.hu' }] });
    assert.deepStrictEqual([fromWrapped[0].name, fromWrapped[0].value, fromWrapped[0].domain], ['b', '2', 'www.tesco.hu']);
    const fromMap = normaliseCookieExport({ 'tesco.hu': [{ name: 'c', value: '3' }], 'x.hu': [{ name: 'd', value: '4' }] });
    assert.strictEqual(fromMap.length, 2);
    assert.throws(() => normaliseCookieExport([{ name: 'no-value' }]), /No usable cookies/);
  });

  await check('inferSessionExpiry uses the earliest auth cookie expiry, else 12h', () => {
    const now = Date.UTC(2026, 8, 17, 12, 0, 0);
    const inSeconds = Math.floor(now / 1000) + 3600;      // 1h, seconds
    const inMillis = now + 7200 * 1000;                     // 2h, milliseconds
    const expiry = inferSessionExpiry(
      [
        { name: 'tracking', expires: Math.floor(now / 1000) + 60 },   // not an auth cookie
        { name: 'access_token', expires: inMillis },
        { name: 'OAuth.Refresh', expires: inSeconds },
      ],
      now
    );
    assert.strictEqual(expiry, new Date(inSeconds * 1000).toISOString());
    assert.strictEqual(
      inferSessionExpiry([{ name: 'x', expires: -1 }], now),
      new Date(now + 12 * 60 * 60 * 1000).toISOString()
    );
  });

  await check('saveSession/loadSession round-trip and getCookieString joins pairs', () => {
    const session = importSessionFromHeader('a=1; b=2', tmpFile);
    assert.strictEqual(fs.existsSync(tmpFile), true);
    const loaded = loadSession(tmpFile);
    assert.ok(loaded);
    assert.strictEqual(getCookieString(loaded!), 'a=1; b=2');
    assert.strictEqual(session.cookies.length, 2);
    const info = getSessionInfo(tmpFile);
    assert.deepStrictEqual([info.exists, info.expired, info.cookieCount], [true, false, 2]);
  });

  await check('loadSession returns null for an expired session and clearSession removes the file', () => {
    saveSession(
      { cookies: [{ name: 'a', value: '1', domain: '.tesco.hu', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        lastLogin: new Date().toISOString() },
      tmpFile
    );
    assert.strictEqual(loadSession(tmpFile), null);
    assert.strictEqual(getSessionInfo(tmpFile).expired, true);
    clearSession(tmpFile);
    assert.strictEqual(fs.existsSync(tmpFile), false);
    assert.strictEqual(getSessionInfo(tmpFile).exists, false);
  });

  process.exit(failures ? 1 : 0);
}

main();
