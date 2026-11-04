/**
 * The registry is the only place provider routing is decided.
 *
 * The CLI, HTTP API and MCP server used to keep their own provider lists,
 * session-path maps and "anonymous search" sets, and they drifted from the
 * manifests. Every surface now derives from the manifest. These checks keep it
 * that way: each one fails if a surface accepts a provider the manifest
 * excludes, rejects one it allows, or does provider work before the check.
 *
 * Nothing here touches the network or a real session file.
 *
 * Run: npx tsx test/registry-routing.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import fs = require('fs');
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  PROVIDERS,
  checkAccess,
  loginHint,
  needsSession,
  sessionFile,
  MissingCapabilityError,
  MissingExtraError,
  MissingSessionError,
  UnknownProviderError,
} from '../src/providers/registry';
import { TOOL_ROUTES, eligibleProviders } from '../src/mcp-routes';

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

const REPO = path.resolve(__dirname, '..');
const ROUTE_SOURCES = ['src/cli.ts', 'src/http-server.ts', 'src/mcp-server.ts', 'src/mcp-routes.ts', 'src/errors.ts'];
const GLOBAL_TOOLS = new Set(['grocery_status', 'grocery_providers', 'grocery_compare']);

async function main() {
  console.log('registry');

  await check('checkAccess fails in order: id, capability, extra, session', () => {
    assert.throws(() => checkAccess('nope', { capability: 'search' }), UnknownProviderError);
    assert.throws(() => checkAccess('ah', { capability: 'basket' }), MissingCapabilityError);
    assert.throws(() => checkAccess('ah', { capability: 'search', extra: 'favourites' }), MissingExtraError);
    assert.doesNotThrow(() => checkAccess('ah', { capability: 'search' }, { session: true }));
  });

  await check('session gating comes from the manifest', () => {
    // UK three gate search on a stored login; tesco-hu searches anonymously.
    for (const id of ['sainsburys', 'ocado', 'tesco']) {
      assert.equal(needsSession(id, { capability: 'search' }), true, id);
    }
    assert.equal(needsSession('tesco-hu', { capability: 'search' }), false);
    assert.equal(needsSession('tesco-hu', { capability: 'basket' }), true);
    assert.equal(needsSession('tesco-hu', { capability: 'search', extra: 'categories' }), false);
    assert.equal(needsSession('ocado', { capability: 'search', extra: 'regulars' }), true);
    // Logging in can't require already being logged in.
    assert.equal(needsSession('sainsburys', { capability: 'search', extra: 'login' }), false);
    // No session file (env or no auth): nothing to check up front.
    for (const id of ['ah', 'lidl-ie', 'kroger', 'instacart', 'instacart-web']) {
      assert.equal(needsSession(id, { capability: 'basket' }), false, id);
    }
  });

  await check('every session path is under the home directory and unique', () => {
    const files = PROVIDERS.map((p) => sessionFile(p.id)).filter(Boolean) as string[];
    assert.equal(new Set(files).size, files.length, 'two providers share a session file');
    for (const f of files) assert.ok(f.startsWith(require('os').homedir()), f);
  });

  await check('tesco-hu session path matches what the provider writes', () => {
    const { SESSION_FILE } = require('../src/providers/tesco-hu/session');
    assert.equal(sessionFile('tesco-hu'), SESSION_FILE);
  });

  await check('session-cookie providers with a session file are told to import, not log in', () => {
    for (const p of PROVIDERS.filter((m) => m.auth === 'session-cookie' && m.session)) {
      assert.match(loginHint(p.id), /import-session/, p.id);
    }
    assert.match(loginHint('sainsburys'), /supermarket --provider sainsburys login/);
    assert.match(loginHint('lidl-ie'), /No login is needed/);
  });

  await check('no surface keeps its own provider list', () => {
    // The old hard-coded sets. A provider id in an array or Set literal in
    // these files means routing knowledge has leaked out of the registry.
    const ids = PROVIDERS.map((p) => p.id).map((id) => id.replace(/[-]/g, '\\-'));
    const literalList = new RegExp(`\\[\\s*'(${ids.join('|')})'\\s*,\\s*'(${ids.join('|')})'`);
    for (const rel of ROUTE_SOURCES) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.doesNotMatch(src, literalList, `${rel} has a hard-coded provider list`);
      assert.doesNotMatch(src, /SESSION_PATHS|ANONYMOUS_SEARCH|SESSION_IMPORT_PROVIDERS/, rel);
      assert.doesNotMatch(src, /ProviderFactory\.create/, `${rel} still routes through the legacy factory`);
    }
  });

  console.log('\nMCP');

  // Stub every loader so we can tell whether provider code would have loaded.
  const loads: string[] = [];
  const originalLoads = new Map(PROVIDERS.map((p) => [p.id, p.load]));
  for (const p of PROVIDERS) {
    p.load = async () => {
      loads.push(p.id);
      return class {
        readonly name = p.id;
        async search() { return []; }
        async getBasket() { return { items: [], total_quantity: 0, total_cost: 0, provider: p.id }; }
        async getDeliverySlots() { return []; }
        async getOrders() { return []; }
        async getCategories() { return []; }
      } as any;
    };
  }
  const originalExists = fs.existsSync;
  let loggedIn = new Set<string>();
  fs.existsSync = ((f: fs.PathLike) => {
    const owner = PROVIDERS.find((p) => sessionFile(p.id) === String(f));
    return owner ? loggedIn.has(owner.id) : originalExists(f);
  }) as typeof fs.existsSync;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected retailer request'); };

  const originalConnect = Server.prototype.connect;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let server: Server | undefined;
  let connection: Promise<void> | undefined;
  Server.prototype.connect = function () {
    server = this;
    connection = originalConnect.call(this, serverTransport);
    return connection;
  };
  const client = new Client({ name: 'routing-parity', version: '1.0.0' });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: JSON.stringify(r.content) };
  };

  try {
    require('../src/mcp-server');
    await connection;
    await client.connect(clientTransport);
    const { tools } = await client.listTools();

    await check('every tool is routed or deliberately global', () => {
      for (const t of tools) {
        assert.ok(TOOL_ROUTES[t.name] || GLOBAL_TOOLS.has(t.name), `${t.name} has no route`);
      }
      for (const name of Object.keys(TOOL_ROUTES)) {
        assert.ok(tools.some((t) => t.name === name), `route for missing tool ${name}`);
      }
    });

    await check("each tool's provider enum is exactly what the manifests allow", () => {
      for (const t of tools) {
        const prop: any = (t.inputSchema as any).properties?.provider;
        if (!prop) continue;
        assert.deepEqual(prop.enum, eligibleProviders(t.name), t.name);
        const route = TOOL_ROUTES[t.name];
        if (!route || route.fixed) continue;
        const expected = PROVIDERS.filter((p) =>
          p.capabilities.includes(route.need.capability) &&
          (!route.need.extra || p.extras?.includes(route.need.extra))
        ).map((p) => p.id);
        assert.deepEqual(prop.enum, expected, t.name);
      }
    });

    await check('a new search-only provider appears in search tools with no other edit', () => {
      const searchTool: any = tools.find((t) => t.name === 'grocery_search');
      for (const p of PROVIDERS) assert.ok(searchTool.inputSchema.properties.provider.enum.includes(p.id), p.id);
    });

    await check('every ineligible (tool, provider) pair is refused before provider code loads', async () => {
      loggedIn = new Set(PROVIDERS.map((p) => p.id)); // a session can't grant a capability
      for (const [tool, route] of Object.entries(TOOL_ROUTES)) {
        if (route.fixed) continue;
        for (const p of PROVIDERS) {
          if (eligibleProviders(tool).includes(p.id)) continue;
          loads.length = 0;
          const r = await call(tool, { provider: p.id, query: 'x', queries: ['x'], items: [{ id: '1' }], product_id: '1', item_id: '1', quantity: 1, slot_id: '1', category_path: 'x', email: 'e', password: 'p' });
          assert.equal(r.isError, true, `${tool}/${p.id}`);
          assert.match(r.text, /does not support/, `${tool}/${p.id}: ${r.text}`);
          assert.deepEqual(loads, [], `${tool}/${p.id} loaded provider code`);
        }
      }
    });

    await check('a missing stored login is refused before provider code loads', async () => {
      loggedIn = new Set();
      for (const p of PROVIDERS.filter((m) => m.session)) {
        for (const tool of ['grocery_basket_view', 'grocery_search']) {
          if (!eligibleProviders(tool).includes(p.id)) continue;
          if (!needsSession(p.id, TOOL_ROUTES[tool].need)) continue;
          loads.length = 0;
          const r = await call(tool, { provider: p.id, query: 'milk' });
          assert.equal(r.isError, true, `${tool}/${p.id}`);
          assert.match(r.text, new RegExp(`Not logged in to ${p.id}`), `${tool}/${p.id}`);
          assert.deepEqual(loads, [], `${tool}/${p.id}`);
        }
      }
    });

    await check('eligible calls load exactly the named provider', async () => {
      loggedIn = new Set(PROVIDERS.map((p) => p.id));
      for (const p of PROVIDERS) {
        loads.length = 0;
        const r = await call('grocery_search', { provider: p.id, query: 'milk' });
        assert.equal(r.isError, false, `${p.id}: ${r.text}`);
        assert.deepEqual(loads, [p.id]);
      }
      loads.length = 0;
      const r = await call('grocery_basket_view', { provider: 'tesco-hu' });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(loads, ['tesco-hu']);
      // An anonymous guest basket (Migros) has no stored login to demand.
      loggedIn = new Set();
      loads.length = 0;
      const guest = await call('grocery_basket_view', { provider: 'migros' });
      assert.equal(guest.isError, false, guest.text);
      assert.deepEqual(loads, ['migros']);
    });

    await check('status lists every manifest provider', async () => {
      const r = await call('grocery_providers', {});
      for (const p of PROVIDERS) assert.match(r.text, new RegExp(`- ${p.id} `), p.id);
    });
  } finally {
    for (const p of PROVIDERS) p.load = originalLoads.get(p.id)!;
    fs.existsSync = originalExists;
    globalThis.fetch = originalFetch;
    Server.prototype.connect = originalConnect;
    await client.close();
    await server?.close();
  }

  console.log('\nCLI');

  await check('an unsupported command fails before any provider loads', () => {
    const tsx = require.resolve('tsx/cli', { paths: [REPO] });
    const r = spawnSync(process.execPath, [tsx, 'src/cli.ts', '--provider', 'ah', 'basket'], {
      cwd: REPO, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /ah does not support "basket"/);
  });

  await check('an unknown provider names the alternatives', () => {
    const tsx = require.resolve('tsx/cli', { paths: [REPO] });
    const r = spawnSync(process.execPath, [tsx, 'src/cli.ts', '--provider', 'nope', 'orders'], {
      cwd: REPO, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Unknown provider: "nope"/);
  });

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
