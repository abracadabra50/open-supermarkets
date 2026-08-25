/**
 * MCP routing must reflect the provider registry without starting stdio,
 * importing retailer modules, or making network calls.
 *
 * Run: npx tsx test/mcp-routing.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const mcp = require('../src/mcp-server');
const registry = require('../src/providers/registry');

test('provider enum is derived exactly from the registry', () => {
  const ids = registry.PROVIDERS.map((provider) => provider.id);
  assert.deepEqual(mcp.providerIds(), ids);
  assert.deepEqual(mcp.providerEnum.enum, ids);
});

test('store tool schema is dynamic and search schemas accept store selection', () => {
  const tools = mcp.toolDefinitions();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const stores = byName.get('grocery_stores');
  assert.ok(stores, 'grocery_stores should be listed');
  assert.deepEqual(
    stores.inputSchema.properties.provider.enum,
    registry.list({ capability: 'stores' }).map((provider) => provider.id)
  );
  for (const field of ['query', 'postcode', 'latitude', 'longitude', 'range', 'shopping_mode', 'limit']) {
    assert.ok(stores.inputSchema.properties[field], `grocery_stores needs ${field}`);
  }
  assert.ok(byName.get('grocery_search').inputSchema.properties.store_id);
  assert.ok(byName.get('grocery_search_batch').inputSchema.properties.store_id);
});

test('Ireland manifests appear in MCP when registered', () => {
  const ireland = registry.list({ country: 'IE' }).map((provider) => provider.id).sort();
  assert.deepEqual(ireland, [
    'aldi-ie',
    'dunnes-ie',
    'lidl-ie',
    'mrprice-ie',
    'supervalu-ie',
    'tesco-ie',
  ]);
  const inMcp = mcp.providerIds().filter((id) => ireland.includes(id)).sort();
  assert.deepEqual(inMcp, ireland);
});

test('none, anonymous, and api-key providers never require a stored login', () => {
  for (const auth of ['none', 'anonymous', 'api-key']) {
    assert.equal(mcp.needsStoredLogin(auth), false, auth);
  }
  assert.equal(mcp.needsStoredLogin('credentials'), true);
  assert.equal(mcp.needsStoredLogin('session-cookie'), true);
  assert.equal(mcp.requireLogin('mercadona'), null);
  assert.equal(mcp.requireLogin('ah'), null);
  assert.equal(mcp.requireLogin('instacart'), null);
});

test('unknown provider session paths are safe', () => {
  assert.equal(mcp.sessionPath('not-a-provider'), undefined);
  assert.equal(mcp.isLoggedIn('not-a-provider'), false);
});

test('a declared capability still needs its concrete method', () => {
  const searchOnly = { name: 'fixture', async search() { return []; } };
  assert.throws(
    () => mcp.requireProviderMethod('fixture', 'checkout', searchOnly, 'checkout'),
    /declares "checkout" but does not implement checkout/
  );
});

test('missing manifest capabilities fail before provider construction', async () => {
  await assert.rejects(
    () => mcp.getCapabilityProvider('ah', 'checkout', 'checkout'),
    /does not support "checkout"/
  );
});

test('store options use the provider contract without network work', () => {
  assert.deepEqual(
    mcp.storeSearchOptions({
      query: 'city centre',
      postcode: 'D01',
      latitude: 53.35,
      longitude: -6.26,
      range: 8,
      shopping_mode: 'delivery',
      limit: 4,
    }),
    {
      fullTextSearch: 'city centre',
      postcode: 'D01',
      latitude: 53.35,
      longitude: -6.26,
      range: 8,
      shoppingMode: 'delivery',
      limit: 4,
    }
  );
});

test('store selection runs before search only for store-capable providers', async () => {
  const calls = [];
  const provider = {
    name: 'fixture',
    async search() { return []; },
    async selectStore(storeId) { calls.push(storeId); },
  };
  await mcp.selectStoreForSearch('aldi-ie', provider, 'IE-DUB-001');
  assert.deepEqual(calls, ['IE-DUB-001']);

  await assert.rejects(
    () => mcp.selectStoreForSearch('tesco-ie', provider, 'IE-DUB-001'),
    /does not support "stores"/
  );
  assert.deepEqual(calls, ['IE-DUB-001']);
});

test('server construction does not connect stdio or call providers', () => {
  assert.ok(mcp.createMcpServer());
});

test('registered tools/call handler dispatches a local provider listing', async () => {
  const server = mcp.createMcpServer();
  const handler = server._requestHandlers.get('tools/call');
  assert.equal(typeof handler, 'function');

  const result = await handler({
    method: 'tools/call',
    params: { name: 'grocery_providers', arguments: {} },
  }, {});

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^Available providers:/);
  assert.match(result.content[0].text, /aldi-ie \(Aldi Ireland\)/);
});

test('registered tools/call handler reports unsupported capabilities before provider work', async () => {
  const server = mcp.createMcpServer();
  const handler = server._requestHandlers.get('tools/call');
  assert.equal(typeof handler, 'function');

  const result = await handler({
    method: 'tools/call',
    params: { name: 'grocery_stores', arguments: { provider: 'tesco-ie' } },
  }, {});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /tesco-ie does not support "stores"/);
});
