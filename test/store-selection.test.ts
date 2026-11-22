/**
 * The generic `stores` capability: store lookup plus store-scoped search.
 *
 * The capability is exercised through a fake store-scoped provider, registered
 * by temporarily giving one search-only manifest the capability and a stub
 * loader, so these checks hold whichever real providers declare `stores`.
 * Every check runs offline; any retailer request fails the test.
 *
 * Run: npx tsx test/store-selection.test.ts
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PROVIDERS, checkAccess, needsSession, MissingCapabilityError } from '../src/providers/registry';
import { eligibleProviders } from '../src/mcp-routes';
import { StoreInputError, parseStoreId, parseStoreSearch, searchNeeds, STORES_NEED } from '../src/stores';
import type { SearchOptions, Store, StoreSearchOptions } from '../src/providers/types';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

const REPO = path.resolve(__dirname, '..');
const SCOPED = 'lidl-ie'; // borrowed manifest: anonymous, search-only, no session file
const PLAIN = 'ah'; // a search-only provider that must refuse store ids

const STORES: Store[] = [
  { store_id: 'S1', name: 'One', postcode: 'D01', modes: ['delivery'] },
  { store_id: 'S2', name: 'Two', location: { latitude: 53.3, longitude: -6.2 } },
  { store_id: 'S3', name: 'Three' },
];

const loads: string[] = [];
const searches: SearchOptions[] = [];
const lookups: StoreSearchOptions[] = [];

const scoped = PROVIDERS.find((p) => p.id === SCOPED)!;
const plain = PROVIDERS.find((p) => p.id === PLAIN)!;
const original = { capabilities: scoped.capabilities, scopedLoad: scoped.load, plainLoad: plain.load };

class FakeStoreScoped {
  readonly name = SCOPED;
  async search(query: string, options: SearchOptions = {}) {
    searches.push(options);
    return [{
      product_uid: `${query}-1`, name: query, retail_price: { price: 1.5 }, in_stock: null,
      provider: SCOPED, currency: 'EUR',
    }];
  }
  async listStores(options: StoreSearchOptions = {}) {
    lookups.push(options);
    return STORES;
  }
}

function install() {
  scoped.capabilities = [...original.capabilities, 'stores'];
  scoped.load = async () => { loads.push(SCOPED); return FakeStoreScoped as never; };
  plain.load = async () => { loads.push(PLAIN); throw new Error('plain provider must not load'); };
}

function restore() {
  scoped.capabilities = original.capabilities;
  scoped.load = original.scopedLoad;
  plain.load = original.plainLoad;
}

async function main() {
  console.log('contract');

  await check('store ids are trimmed; blank or non-string ids are invalid input', () => {
    assert.equal(parseStoreId(undefined), undefined);
    assert.equal(parseStoreId(null), undefined);
    assert.equal(parseStoreId('  123 '), '123');
    assert.throws(() => parseStoreId('  '), StoreInputError);
    assert.throws(() => parseStoreId(42), StoreInputError);
  });

  await check('store lookup input is validated without any request', () => {
    assert.deepEqual(parseStoreSearch({}), { limit: 10 });
    assert.deepEqual(
      parseStoreSearch({ query: ' Cork ', postcode: 'T12', latitude: '51.9', longitude: -8.47, mode: 'Delivery', limit: '500' }),
      { limit: 100, query: 'Cork', postcode: 'T12', latitude: 51.9, longitude: -8.47, mode: 'delivery' }
    );
    assert.throws(() => parseStoreSearch({ latitude: 1 }), /together/);
    assert.throws(() => parseStoreSearch({ latitude: 91, longitude: 0 }), /between -90 and 90/);
    assert.throws(() => parseStoreSearch({ latitude: 0, longitude: 181 }), /between -180 and 180/);
    assert.throws(() => parseStoreSearch({ latitude: '1e3', longitude: 0 }), StoreInputError);
    assert.throws(() => parseStoreSearch({ limit: '0' }), /positive integer/);
    assert.throws(() => parseStoreSearch({ limit: 2.5 }), /positive integer/);
    assert.throws(() => parseStoreSearch({ query: ' ' }), /non-empty/);
  });

  await check('a store id adds the stores need; no store id leaves search alone', () => {
    assert.deepEqual(searchNeeds({ capability: 'search' }, undefined), [{ capability: 'search' }]);
    assert.deepEqual(searchNeeds({ capability: 'search' }, 'S1'), [{ capability: 'search' }, STORES_NEED]);
  });

  await check('store lookup needs a stored login exactly when search does', () => {
    for (const p of PROVIDERS.filter((m) => m.session)) {
      assert.equal(needsSession(p.id, STORES_NEED), needsSession(p.id, { capability: 'search' }), p.id);
    }
  });

  await check('a provider without stores is refused by the manifest', () => {
    for (const p of PROVIDERS.filter((m) => !m.capabilities.includes('stores'))) {
      assert.throws(() => checkAccess(p.id, STORES_NEED), MissingCapabilityError, p.id);
    }
  });

  await check('every stores provider also declares search', () => {
    for (const p of PROVIDERS.filter((m) => m.capabilities.includes('stores'))) {
      assert.ok(p.capabilities.includes('search'), p.id);
    }
  });

  install();
  const originalFetch = globalThis.fetch;
  const originalConnect = Server.prototype.connect;
  const originalListen = http.Server.prototype.listen;
  let mcpServer: Server | undefined;
  let httpServer: http.Server | undefined;
  const client = new Client({ name: 'store-selection', version: '1.0.0' });

  try {
    console.log('\nMCP');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let connection: Promise<void> | undefined;
    Server.prototype.connect = function () {
      mcpServer = this;
      connection = originalConnect.call(this, serverTransport);
      return connection;
    };
    require('../src/mcp-server');
    await connection;
    await client.connect(clientTransport);
    // Every retailer request below is a bug; the fake answers in-process.
    globalThis.fetch = async () => { throw new Error('Unexpected retailer request'); };
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: unknown };
      return { isError: r.isError === true, text: JSON.stringify(r.content) };
    };

    await check('grocery_stores is advertised only for stores providers', async () => {
      const { tools } = await client.listTools();
      const stores = tools.find((t) => t.name === 'grocery_stores');
      assert.ok(stores, 'grocery_stores missing');
      const provider = (stores!.inputSchema as { properties: { provider: { enum: string[] } } }).properties.provider;
      const expected = PROVIDERS.filter((p) => p.capabilities.includes('stores')).map((p) => p.id);
      assert.ok(expected.includes(SCOPED));
      assert.deepEqual(provider.enum, expected);
      assert.deepEqual(eligibleProviders('grocery_stores'), expected);
      for (const name of ['grocery_search', 'grocery_search_batch']) {
        const tool = tools.find((t) => t.name === name)!;
        assert.ok((tool.inputSchema as { properties: Record<string, unknown> }).properties.store_id, name);
      }
    });

    await check('store_id on a provider without stores is refused before provider code loads', async () => {
      loads.length = 0;
      for (const [tool, args] of [
        ['grocery_search', { query: 'milk' }],
        ['grocery_search_batch', { queries: ['milk'] }],
        ['grocery_stores', {}],
      ] as const) {
        const r = await call(tool, { provider: PLAIN, store_id: 'S1', ...args });
        assert.equal(r.isError, true, tool);
        assert.match(r.text, /does not support \\"stores\\"/, `${tool}: ${r.text}`);
      }
      assert.deepEqual(loads, []);
    });

    await check('invalid store input is refused before provider code loads', async () => {
      loads.length = 0;
      const blank = await call('grocery_search', { provider: SCOPED, query: 'milk', store_id: '  ' });
      assert.equal(blank.isError, true);
      assert.match(blank.text, /store id must be a non-empty string/);
      const half = await call('grocery_stores', { provider: SCOPED, latitude: 53 });
      assert.equal(half.isError, true);
      assert.match(half.text, /latitude and longitude must be given together/);
      assert.deepEqual(loads, []);
    });

    await check('search passes the trimmed store id; no store id passes none', async () => {
      searches.length = 0;
      const scopedSearch = await call('grocery_search', { provider: SCOPED, query: 'milk', store_id: ' S2 ' });
      assert.equal(scopedSearch.isError, false, scopedSearch.text);
      assert.match(scopedSearch.text, /at lidl-ie store S2/);
      const batch = await call('grocery_search_batch', { provider: SCOPED, queries: ['milk', 'eggs'], store_id: 'S2' });
      assert.equal(batch.isError, false, batch.text);
      assert.match(batch.text, /\\"store_id\\": \\"S2\\"/);
      const unscoped = await call('grocery_search', { provider: SCOPED, query: 'milk' });
      assert.equal(unscoped.isError, false, unscoped.text);
      assert.deepEqual(searches.map((s) => s.storeId), ['S2', 'S2', 'S2', undefined]);
    });

    await check('grocery_stores passes validated filters and honours limit', async () => {
      lookups.length = 0;
      const r = await call('grocery_stores', { provider: SCOPED, postcode: ' D01 ', mode: 'DELIVERY', limit: 2 });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(lookups, [{ limit: 2, postcode: 'D01', mode: 'delivery' }]);
      assert.match(r.text, /S1/);
      assert.match(r.text, /S2/);
      assert.doesNotMatch(r.text, /S3/);
    });

    console.log('\nHTTP');
    http.Server.prototype.listen = function () {
      httpServer = this;
      return originalListen.call(this, 0, '127.0.0.1');
    } as typeof originalListen;
    // The HTTP API uses the real fetch for its own requests; restore it briefly.
    globalThis.fetch = originalFetch;
    require('../src/http-server');
    if (!httpServer!.listening) await new Promise<void>((resolve) => httpServer!.once('listening', resolve));
    const address = httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;

    await check('HTTP refuses a store id or store lookup for a provider without stores (501, no load)', async () => {
      loads.length = 0;
      for (const route of [`/search?q=milk&store=S1&provider=${PLAIN}`, `/stores?provider=${PLAIN}`]) {
        const res = await fetch(`${base}${route}`);
        assert.equal(res.status, 501, route);
        assert.match(await res.text(), /does not support \\"stores\\"/, route);
      }
      assert.deepEqual(loads, []);
    });

    await check('HTTP rejects invalid store input with 400 before loading', async () => {
      loads.length = 0;
      for (const route of [`/search?q=milk&store=%20&provider=${SCOPED}`, `/stores?lat=1&provider=${SCOPED}`, `/stores?limit=x&provider=${SCOPED}`]) {
        const res = await fetch(`${base}${route}`);
        assert.equal(res.status, 400, route);
      }
      assert.deepEqual(loads, []);
    });

    await check('HTTP store-scoped search and store lookup', async () => {
      searches.length = 0;
      const search = await fetch(`${base}/search?q=milk&store=S1&provider=${SCOPED}`);
      assert.equal(search.status, 200);
      const body = await search.json() as { store_id: string; products: unknown[] };
      assert.equal(body.store_id, 'S1');
      assert.equal(body.products.length, 1);
      assert.equal(searches[0].storeId, 'S1');
      const stores = await fetch(`${base}/stores?q=Cork&limit=1&provider=${SCOPED}`);
      assert.equal(stores.status, 200);
      const listed = await stores.json() as { stores: Store[] };
      assert.deepEqual(listed.stores.map((s) => s.store_id), ['S1']);
    });
  } finally {
    restore();
    globalThis.fetch = originalFetch;
    Server.prototype.connect = originalConnect;
    http.Server.prototype.listen = originalListen;
    await client.close();
    await mcpServer?.close();
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }

  console.log('\nCLI');
  const tsx = require.resolve('tsx/cli', { paths: [REPO] });
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [tsx, 'src/cli.ts', ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });

  await check('CLI refuses --store and stores for a provider without stores', () => {
    for (const args of [['--provider', PLAIN, 'search', 'milk', '--store', 'S1'], ['--provider', PLAIN, 'stores']]) {
      const r = cli(...args);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /ah does not support "stores"/, args.join(' '));
    }
  });

  await check('CLI rejects invalid store lookup input', () => {
    const r = cli('--provider', PLAIN, 'stores', '--lat', '53');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /latitude and longitude must be given together/);
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
