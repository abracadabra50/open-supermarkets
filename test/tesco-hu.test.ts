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
import { TescoHuProvider, normaliseProduct, normaliseBasket, flattenTaxonomy } from '../src/providers/tesco-hu/index';

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

  console.log('\nprovider: catalogue');

  /** Live product fixture, xapi region HU, 2026-09-17. */
  const BANANA = {
    id: '205406742', tpnb: '205406742', tpnc: '205406742', gtin: '02870100000000',
    title: 'Banán lédig', status: 'AvailableForSale', isForSale: true,
    defaultImageUrl: 'https://digitalcontent.api.tesco.com/v2/media/ghs/a2ffdd5f-77ce-43fe-a45a-527231c49e52/bd9bbd54-0beb-45ca-9661-07b1a5c00d54_1756812688.jpeg?h=225&w=225',
    bulkBuyLimit: 24, averageWeight: 0.18, productType: 'LooseProduce',
    superDepartmentName: 'Zöldség és gyümölcs', departmentName: 'Gyümölcsök', aisleName: 'Banán', shelfName: 'Banán',
    price: { actual: 126, unitPrice: 699, unitOfMeasure: 'kg' },
    promotions: [],
    reviews: { stats: { noOfReviews: 12, overallRating: 4.4 } },
  };

  await check('normaliseProduct maps the live shape into Product with HUF', () => {
    const p = normaliseProduct(BANANA);
    assert.strictEqual(p.provider, 'tesco-hu');
    assert.strictEqual(p.product_uid, '205406742');
    assert.strictEqual(p.name, 'Banán lédig');
    assert.strictEqual(p.retail_price.price, 126);
    assert.deepStrictEqual(p.unit_price, { price: 699, measure: 'kg' });
    assert.strictEqual(p.currency, 'HUF');
    assert.strictEqual(p.in_stock, true);
    assert.strictEqual(p.rating, 4.4);
    assert.strictEqual(p.review_count, 12);
    assert.strictEqual(p.description, 'Gyümölcsök / Banán');
    assert.ok(p.image_url?.startsWith('https://digitalcontent.api.tesco.com/'));
    assert.strictEqual(p.size, undefined);
  });

  await check('normaliseProduct: stock follows status, then isForSale; nothing is invented', () => {
    assert.strictEqual(normaliseProduct({ ...BANANA, status: 'Unavailable' }).in_stock, false);
    assert.strictEqual(normaliseProduct({ ...BANANA, status: undefined, isForSale: true }).in_stock, true);
    assert.strictEqual(normaliseProduct({ ...BANANA, status: undefined, isForSale: undefined }).in_stock, false);
    const bare = normaliseProduct({ id: '1', title: 'x', price: { actual: 10 } });
    assert.strictEqual(bare.unit_price, undefined);
    assert.strictEqual(bare.rating, undefined);
    assert.strictEqual(bare.description, undefined);
  });

  await check('search converts limit/offset into page/count and normalises results', async () => {
    const provider = new TescoHuProvider();
    const calls: any[] = [];
    (provider.getAPI() as any).search = async (query: string, page: number, count: number) => {
      calls.push({ query, page, count });
      return { total: 211, products: [BANANA] };
    };
    const first = await provider.search('banán', { limit: 10 });
    assert.deepStrictEqual(calls[0], { query: 'banán', page: 1, count: 10 });
    assert.strictEqual(first[0].name, 'Banán lédig');
    await provider.search('banán', { limit: 10, offset: 20 });
    assert.deepStrictEqual(calls[1], { query: 'banán', page: 3, count: 10 });
    await provider.search('banán');
    assert.deepStrictEqual(calls[2], { query: 'banán', page: 1, count: 24 });
  });

  await check('getProduct normalises and getCategories flattens with depth and path', async () => {
    const provider = new TescoHuProvider();
    (provider.getAPI() as any).getProduct = async () => BANANA;
    (provider.getAPI() as any).getCategories = async () => [
      { name: 'Zöldség és gyümölcs', label: 'superDepartment', children: [
        { id: 'b;dep', name: 'Gyümölcsök', label: 'department', children: [
          { id: 'b;aisle', name: 'Banán', label: 'aisle' },
        ] },
      ] },
    ];
    const p = await provider.getProduct('205406742');
    assert.strictEqual(p.product_uid, '205406742');
    const cats = await provider.getCategories();
    assert.deepStrictEqual(cats, [
      { id: '', name: 'Zöldség és gyümölcs', label: 'superDepartment', depth: 0, path: 'Zöldség és gyümölcs' },
      { id: 'b;dep', name: 'Gyümölcsök', label: 'department', depth: 1, path: 'Zöldség és gyümölcs > Gyümölcsök' },
      { id: 'b;aisle', name: 'Banán', label: 'aisle', depth: 2, path: 'Zöldség és gyümölcs > Gyümölcsök > Banán' },
    ]);
    assert.deepStrictEqual(flattenTaxonomy([]), []);
  });

  console.log('\nprovider: basket');

  /** Shape of GetBasket, from the UK provider's confirmed query; HU validates the same fields. */
  const BASKET = {
    basket: {
      id: 'trn:tesco:order:uuid:test-basket',
      splitView: [{
        id: 'view-1', totalPrice: 252, guidePrice: 252, totalItems: 2,
        items: [{
          id: 'line-1', quantity: 2, cost: 252, unit: 'pcs',
          product: { id: '205406742', tpnb: '205406742', gtin: '02870100000000', title: 'Banán lédig', price: { actual: 126, unitPrice: 699, unitOfMeasure: 'kg' } },
        }],
      }],
    },
  };

  function basketProvider() {
    const provider = new TescoHuProvider();
    const api: any = provider.getAPI();
    api.setAuthCookies('session=test');
    const updates: any[] = [];
    api.getBasket = async () => BASKET;
    api.updateBasket = async (tpnc: string, quantity: number, orderId: string) => { updates.push({ tpnc, quantity, orderId }); return BASKET; };
    return { provider, updates };
  }

  await check('normaliseBasket maps splitView items, totals and ids', () => {
    const b = normaliseBasket(BASKET);
    assert.strictEqual(b.provider, 'tesco-hu');
    assert.strictEqual(b.total_cost, 252);
    assert.strictEqual(b.total_quantity, 2);
    assert.deepStrictEqual(b.items[0], {
      item_id: 'line-1', product_uid: '205406742', name: 'Banán lédig', quantity: 2, unit_price: 126, total_price: 252,
    });
    // splitView may also arrive as a single object rather than an array
    const single = normaliseBasket({ basket: { ...BASKET.basket, splitView: BASKET.basket.splitView[0] } });
    assert.strictEqual(single.items.length, 1);
    // total_price falls back to unit_price * quantity when cost is absent
    const noCost = normaliseBasket({ basket: { splitView: [{ items: [{ id: 'l', quantity: 3, product: { id: 'p', title: 't', price: { actual: 10 } } }] }] } });
    assert.strictEqual(noCost.items[0].total_price, 30);
    assert.strictEqual(noCost.total_quantity, 3);
  });

  await check('basket methods raise the session error before any network call when no cookies', async () => {
    const provider = new TescoHuProvider();
    const api: any = provider.getAPI();
    api.setAuthCookies('');
    let called = false;
    api.getBasket = async () => { called = true; return BASKET; };
    await assert.rejects(provider.getBasket(), /import-session/);
    await assert.rejects(provider.addToBasket('205406742', 1), /import-session/);
    assert.strictEqual(called, false);
    assert.strictEqual(await provider.isAuthenticated(), false);
  });

  await check('addToBasket sends UpdateBasket with the basket id as orderId', async () => {
    const { provider, updates } = basketProvider();
    await provider.addToBasket('120502935', 3);
    assert.deepStrictEqual(updates, [{ tpnc: '120502935', quantity: 3, orderId: 'trn:tesco:order:uuid:test-basket' }]);
  });

  await check('update/remove accept either the line id or the product id', async () => {
    const { provider, updates } = basketProvider();
    await provider.updateBasketItem('line-1', 5);
    await provider.removeFromBasket('205406742');
    await provider.removeFromBasket('unknown-id');
    assert.deepStrictEqual(updates.map(u => [u.tpnc, u.quantity]), [['205406742', 5], ['205406742', 0], ['unknown-id', 0]]);
  });

  await check('clearBasket removes every line', async () => {
    const { provider, updates } = basketProvider();
    await provider.clearBasket();
    assert.deepStrictEqual(updates, [{ tpnc: '205406742', quantity: 0, orderId: 'trn:tesco:order:uuid:test-basket' }]);
  });

  process.exit(failures ? 1 : 0);
}

main();
