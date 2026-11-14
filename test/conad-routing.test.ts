/** Offline public-interface checks: no browser, credentials, or retailer calls. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getManifest } from '../src/providers/registry';

const store = {
  store_id: '010001', name: 'Test Store', address: 'Synthetic address',
  fulfilment: 'pickup' as const, provider: 'conad',
};
const product = {
  product_uid: '100001', name: 'Synthetic milk', retail_price: { price: 1.79 },
  in_stock: null, currency: 'EUR', provider: 'conad', store,
};

async function main() {
  const manifest = getManifest('conad');
  const originalLoad = manifest.load;
  const calls: Array<{ method: string; value?: unknown }> = [];
  const state = { provider: 'conad', authenticated: true, interaction_required: false, store };
  manifest.load = async () => class {
    readonly name = 'conad';
    async search(query: string) { calls.push({ method: 'search', value: query }); return [product]; }
    async getBasket() {
      return {
        items: [{ item_id: '0', product_uid: '100001', name: 'Synthetic milk', quantity: 1, unit_price: null, total_price: null, in_stock: false }],
        total_quantity: 1, total_cost: 5.9, provider: 'conad', currency: 'EUR', store,
      };
    }
    async getStore() { return store; }
    async login() { calls.push({ method: 'login' }); }
    async isAuthenticated() { return true; }
    async getSessionStatus() { return state; }
    async startBrowserLogin() { return state; }
    async removeFromBasket(itemId: string) { calls.push({ method: 'remove', value: itemId }); }
    async getCheckoutPreview() { return { store, can_place_order: false, blockers: ['Checkout is not verified.'] } as any; }
  };

  let web: http.Server | undefined;
  let server: Server | undefined;
  let connection: Promise<void> | undefined;
  const originalListen = http.Server.prototype.listen;
  const originalConnect = Server.prototype.connect;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'conad-routing', version: '1.0.0' });
  try {
    http.Server.prototype.listen = function () {
      web = this;
      return originalListen.call(this, 0, '127.0.0.1');
    } as typeof originalListen;
    require('../src/http-server');
    if (!web!.listening) await new Promise<void>(resolve => web!.once('listening', resolve));
    const address = web!.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const context = await fetch(`${base}/store?provider=conad`);
    assert.equal(context.status, 200);
    assert.deepEqual((await context.json() as any).store, store);
    const search = await fetch(`${base}/search?provider=conad&q=latte`);
    assert.deepEqual((await search.json() as any).products[0].store, store);
    const preview = await fetch(`${base}/checkout-preview?provider=conad`);
    assert.equal(preview.status, 200);
    assert.equal((await preview.json() as any).can_place_order, false);
    const before = calls.length;
    assert.equal((await fetch(`${base}/store?provider=ah`)).status, 501);
    assert.equal((await fetch(`${base}/checkout-preview?provider=ah`)).status, 501);
    assert.equal(calls.length, before);
    assert.equal((await fetch(`${base}/stores?provider=conad`)).status, 404);
    assert.equal((await fetch(`${base}/store?provider=conad`, { method: 'POST', body: '{}' })).status, 405);
    console.log('  ✓ HTTP local context/review route correctly; unsupported features fail before loading');

    Server.prototype.connect = function () {
      server = this;
      connection = originalConnect.call(this, st);
      return connection;
    };
    require('../src/mcp-server');
    await connection;
    await client.connect(ct);
    const tools = (await client.listTools()).tools;
    for (const name of ['grocery_browser_login', 'grocery_checkout_preview', 'grocery_store']) {
      const tool = tools.find(t => t.name === name)!;
      assert.ok(tool, name);
      assert.deepEqual((tool.inputSchema.properties as any).provider.enum, ['conad']);
    }
    assert.ok(!tools.some(t => ['grocery_stores', 'grocery_select_store', 'grocery_import_session'].includes(t.name)));
    for (const [name, args] of [
      ['grocery_browser_login', {}], ['grocery_checkout_preview', {}], ['grocery_store', {}],
      ['grocery_login', { email: 'agent@example.test', password: 'synthetic-password' }],
      ['grocery_status', {}], ['grocery_search', { query: 'latte' }],
      ['grocery_search_batch', { queries: ['latte'] }],
    ] as const) {
      const result = await client.callTool({ name, arguments: { provider: 'conad', ...args } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.doesNotMatch(JSON.stringify(result.content), /synthetic-password/);
      if (name !== 'grocery_login') assert.match(JSON.stringify(result.content), /010001/);
    }
    for (const args of [{ item_id: '0' }, { product_id: '0' }]) {
      const result = await client.callTool({ name: 'grocery_basket_remove', arguments: { provider: 'conad', ...args } });
      assert.notEqual(result.isError, true);
    }
    const basketView = await client.callTool({ name: 'grocery_basket_view', arguments: { provider: 'conad' } });
    assert.match(JSON.stringify(basketView.content), /Row ID: 0/);
    assert.match(JSON.stringify(basketView.content), /Product ID: 100001/);
    assert.match(JSON.stringify(basketView.content), /Out of stock/);
    assert.deepEqual(calls.filter(c => c.method === 'remove').map(c => c.value), ['0', '0']);
    const count = calls.length;
    const conflict = await client.callTool({ name: 'grocery_basket_remove', arguments: { provider: 'conad', item_id: '0', product_id: '1' } });
    assert.equal(conflict.isError, true);
    assert.equal(calls.length, count);
    const order = await client.callTool({ name: 'grocery_checkout', arguments: { provider: 'conad', dry_run: false } });
    assert.equal(order.isError, true);
    assert.match(JSON.stringify(order.content), /does not support/);
    console.log('  ✓ MCP exposes only implemented tools, preserves row-ID compatibility and refuses orders');

    const repo = path.resolve(__dirname, '..');
    const tsx = require.resolve('tsx/cli', { paths: [repo] });
    const run = (args: string[]) => spawnSync(process.execPath, [tsx, 'src/cli.ts', ...args], {
      cwd: repo, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, CONAD_PYTHON: '/nonexistent-python', CONAD_PROFILE_DIR: path.join(os.tmpdir(), `conad-unused-${process.pid}`) },
    });
    const listing = run(['providers', '--country', 'IT', '--json']);
    assert.equal(listing.status, 0, listing.stderr);
    assert.equal(JSON.parse(listing.stdout)[0].id, 'conad');
    const invalid = run(['search', '   ', '--country', 'IT', '--json']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /query must contain/);
    const unsupported = run(['--provider', 'ah', 'store']);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /does not support/);
    console.log('  ✓ CLI selects Italy lazily and validates unsupported/invalid requests without Python');
  } finally {
    manifest.load = originalLoad;
    http.Server.prototype.listen = originalListen;
    Server.prototype.connect = originalConnect;
    await client.close();
    await server?.close();
    if (web) await new Promise<void>(resolve => web!.close(() => resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
