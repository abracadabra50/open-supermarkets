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
import { TescoHuAPI, TescoHuSessionError, TESCO_HU } from '../src/providers/tesco-hu/api';

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

  console.log('\nxapi client');

  /** Replace the axios post with a canned batch response; capture what was sent. */
  function stubPost(api: TescoHuAPI, reply: unknown | Error, captured: any[] = []) {
    (api as any).client.post = async (url: string, body: unknown) => {
      captured.push({ url, body });
      if (reply instanceof Error) throw reply;
      return { data: reply };
    };
    return captured;
  }

  await check('sends the Hungarian region headers and a one-element batch', async () => {
    const api = new TescoHuAPI();
    const headers = (api as any).client.defaults.headers;
    assert.strictEqual(headers['region'], 'HU');
    assert.strictEqual(headers['language'], 'hu-HU');
    assert.strictEqual(headers['accept-language'], 'hu-HU');
    assert.strictEqual(headers['x-apikey'], 'TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA');
    assert.strictEqual(headers['Origin'], TESCO_HU.origin);

    const sent = stubPost(api, [{ data: { product: { id: '205406742', title: 'Banán lédig' } }, status: 200 }]);
    const product = await api.getProduct('205406742');
    assert.strictEqual(product.title, 'Banán lédig');
    assert.strictEqual(sent[0].url, 'https://xapi.tesco.com/');
    assert.ok(Array.isArray(sent[0].body) && sent[0].body.length === 1);
    assert.strictEqual(sent[0].body[0].operationName, 'GetProduct');
    assert.deepStrictEqual(sent[0].body[0].variables, { tpnc: '205406742' });
  });

  await check('search maps nodes and total, dropping null nodes, and pages by page/count', async () => {
    const api = new TescoHuAPI();
    const sent = stubPost(api, [{
      data: { search: {
        info: { total: 211, page: 2, count: 3, pageSize: 3 },
        results: [
          { node: { id: '210621123', title: 'Tesco UHT félzsíros tej 2,8% 1 l' } },
          { node: null },
          { node: { id: '120305258', title: 'Tesco UHT zsírszegény tej 1,5% 1 l' } },
        ],
      } },
      status: 200,
    }]);
    const { total, products } = await api.search('tej', 2, 3);
    assert.strictEqual(total, 211);
    assert.deepStrictEqual(products.map(p => p.id), ['210621123', '120305258']);
    assert.deepStrictEqual(sent[0].body[0].variables, { query: 'tej', page: 2, count: 3, sortBy: 'relevance' });
  });

  await check('GraphQL errors are thrown with the operation name, never swallowed', async () => {
    const api = new TescoHuAPI();
    stubPost(api, [{ errors: [{ message: 'Cannot query field "nope"' }], status: 400 }]);
    await assert.rejects(api.search('tej', 1, 5), /GraphQL error \(Search\): Cannot query field/);
  });

  await check('Unauthorized becomes a session error naming import-session', async () => {
    const api = new TescoHuAPI();
    stubPost(api, [{ errors: [{ message: 'Unauthorized', path: ['basket'], extensions: { http: { status: 401 } } }], data: { basket: null }, status: 401 }]);
    await assert.rejects(api.getBasket(), (err: any) => {
      assert.ok(err instanceof TescoHuSessionError);
      assert.strictEqual(err.status, 401);
      assert.match(err.message, /supermarket --provider tesco-hu import-session/);
      return true;
    });
  });

  await check('HTTP 401/403 from the transport also becomes a session error', async () => {
    const api = new TescoHuAPI();
    const transport: any = new Error('Request failed with status code 403');
    transport.response = { status: 403 };
    stubPost(api, transport);
    await assert.rejects(api.getBasket(), (err: any) => err instanceof TescoHuSessionError && err.status === 403);
  });

  await check('setAuthCookies sets the Cookie header and hasAuthCookies reflects it', () => {
    const api = new TescoHuAPI();
    assert.strictEqual(api.hasAuthCookies(), false);
    api.setAuthCookies('a=1; b=2');
    assert.strictEqual(api.hasAuthCookies(), true);
    assert.strictEqual((api as any).client.defaults.headers.common['Cookie'], 'a=1; b=2');
  });

  process.exit(failures ? 1 : 0);
}

main();
