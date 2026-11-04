import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProviderFactory, getManifest } from '../src/providers';
import type { SearchOptions } from '../src/providers/types';
import http = require('node:http');
import https = require('node:https');
import fs = require('fs');

async function main() {
  const originalExists = fs.existsSync;
  const checkedExists = (path: fs.PathLike) => {
    assert.notEqual(path, undefined, 'login lookup must use a real session path');
    return originalExists(path);
  };
  const originalCreate = ProviderFactory.create;
  const originalConnect = Server.prototype.connect;
  const huManifest = getManifest('tesco-hu');
  const lidlManifest = getManifest('lidl-ie');
  const originalHuLoad = huManifest.load;
  const originalLidlLoad = lidlManifest.load;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalReadFile = fs.readFileSync;
  const originalFetch = globalThis.fetch;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let server: Server | undefined;
  let connection: Promise<void> | undefined;
  let searchCalls = 0;
  let lastLimit: number | undefined;
  const client = new Client({ name: 'capability-regression', version: '1.0.0' });
  try {
    fs.existsSync = ((path: fs.PathLike) => String(path).endsWith('/session.json') ? false : checkedExists(path)) as typeof fs.existsSync;
    ProviderFactory.create = (() => { throw new Error('Unexpected legacy constructor'); }) as typeof ProviderFactory.create;
    globalThis.fetch = async () => { throw new Error('Unexpected retailer request'); };
    // Registry loader fakes cover both CJS and dynamic ESM loading on all Node versions.
    huManifest.load = async () => class {
      readonly name = 'tesco-hu';
      async search(_query: string, options?: SearchOptions) { searchCalls++; lastLimit = options?.limit; return []; }
    };
    lidlManifest.load = async () => class {
      readonly name = 'lidl-ie';
      async search() { searchCalls++; return []; }
    };
    http.request = (() => { throw new Error('Unexpected HTTP request'); }) as typeof http.request;
    https.request = (() => { throw new Error('Unexpected HTTPS request'); }) as typeof https.request;
    Server.prototype.connect = function () {
      server = this;
      connection = originalConnect.call(this, serverTransport);
      return connection;
    };
    fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...options: any[]) => {
      if (String(path).endsWith('/.tesco/staples.json')) {
        return JSON.stringify([{ productId: '1', name: 'Test milk', avgQty: 1, frequency: 1 }]);
      }
      if (String(path).endsWith('/.tesco/session.json')) return '{}';
      return (originalReadFile as any)(path, ...options);
    }) as typeof fs.readFileSync;
    require('../src/mcp-server');
    await connection;
    await client.connect(clientTransport);
    for (const name of ['grocery_login', 'grocery_favourites', 'grocery_favourites_search',
      'grocery_categories', 'grocery_browse', 'grocery_basket_view', 'grocery_basket_add',
      'grocery_basket_remove', 'grocery_basket_update', 'grocery_basket_clear', 'grocery_slots',
      'grocery_book_slot', 'grocery_checkout', 'grocery_orders', 'grocery_basket_add_batch']) {
      const result = await client.callTool({ name, arguments: { provider: 'lidl-ie', items: [{ id: '1' }] } });
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result.content), /does not support/, name);
      assert.doesNotMatch(JSON.stringify(result.content), /constructor|Unexpected retailer/, name);
    }
    for (const name of ['grocery_basket_view', 'grocery_basket_add_batch']) {
      const result = await client.callTool({ name, arguments: { provider: 'tesco-hu', items: [{ id: '1' }] } });
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result.content), /Not logged in to tesco-hu/, name);
    }
    const gatedBatch = await client.callTool({ name: 'grocery_search_batch', arguments: { provider: 'sainsburys', queries: ['milk'] } });
    assert.equal(gatedBatch.isError, true);
    assert.match(JSON.stringify(gatedBatch.content), /Not logged in to sainsburys/);
    for (const provider of ['tesco-hu', 'lidl-ie']) {
      for (const name of ['grocery_search', 'grocery_search_batch']) {
        const result = await client.callTool({ name, arguments: { provider, query: 'milk', queries: ['milk'] } });
        assert.notEqual(result.isError, true, JSON.stringify(result.content));
      }
    }
    assert.equal(searchCalls, 4);
    for (const name of ['grocery_search', 'grocery_search_batch']) {
      for (const limit of [0, -1, 1.5, '10']) {
        const result = await client.callTool({ name, arguments: { provider: 'tesco-hu', query: 'milk', queries: ['milk'], limit } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /limit must be a positive integer/);
      }
    }
    assert.equal(searchCalls, 4, 'invalid limits must fail before retailer search');
    for (const name of ['grocery_search', 'grocery_search_batch']) {
      const result = await client.callTool({ name, arguments: { provider: 'tesco-hu', query: 'milk', queries: ['milk'], limit: 1000000 } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.equal(lastLimit, 100, 'large limits must be bounded before provider search');
    }
    for (const [name, provider] of [['ocado_regulars', 'ocado'], ['tesco_staples', 'tesco']]) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result.content), new RegExp(`Not logged in to ${provider}`));
      assert.doesNotMatch(JSON.stringify(result.content), /sainsburys|Unexpected legacy constructor/);
    }
    // A session cannot grant a provider capabilities that it does not declare.
    fs.existsSync = ((path: fs.PathLike) => String(path).endsWith('/.tesco-hu/session.json') ||
      (!String(path).endsWith('/session.json') && checkedExists(path))) as typeof fs.existsSync;
    for (const name of ['grocery_slots', 'grocery_book_slot', 'grocery_checkout', 'grocery_orders']) {
      const result = await client.callTool({ name, arguments: { provider: 'tesco-hu' } });
      assert.equal(result.isError, true, name);
      assert.match(JSON.stringify(result.content), /does not support/, name);
      assert.doesNotMatch(JSON.stringify(result.content), /Unexpected legacy|TypeError|Not logged in/, name);
    }
    // Each provider-specific tool works with only its own fake session.
    let regularsCalls = 0;
    fs.existsSync = ((path: fs.PathLike) => String(path).endsWith('/.ocado/session.json') ||
      (!String(path).endsWith('/session.json') && checkedExists(path))) as typeof fs.existsSync;
    ProviderFactory.create = ((name: string) => {
      assert.equal(name, 'ocado');
      return { getRegulars: async () => { regularsCalls++; return []; } };
    }) as unknown as typeof ProviderFactory.create;
    const regulars = await client.callTool({ name: 'ocado_regulars', arguments: {} });
    assert.notEqual(regulars.isError, true, JSON.stringify(regulars.content));
    const regularsExtraProvider = await client.callTool({ name: 'ocado_regulars', arguments: { provider: 'lidl-ie' } });
    assert.notEqual(regularsExtraProvider.isError, true, JSON.stringify(regularsExtraProvider.content));
    assert.equal(regularsCalls, 2);
    fs.existsSync = ((path: fs.PathLike) => String(path).endsWith('/.tesco/session.json') ||
      String(path).endsWith('/.tesco/staples.json') ||
      (!String(path).endsWith('/session.json') && checkedExists(path))) as typeof fs.existsSync;
    const stapleResult = await client.callTool({ name: 'tesco_staples', arguments: { action: 'view' } });
    assert.notEqual(stapleResult.isError, true, JSON.stringify(stapleResult.content));
    assert.match(JSON.stringify(stapleResult.content), /Test milk/);
    const staplesExtraProvider = await client.callTool({ name: 'tesco_staples', arguments: { action: 'view', provider: 'lidl-ie' } });
    assert.notEqual(staplesExtraProvider.isError, true, JSON.stringify(staplesExtraProvider.content));
    assert.match(JSON.stringify(staplesExtraProvider.content), /Test milk/);
    console.log('  ✓ MCP catalogue capabilities and provider-specific login gates');
  } finally {
    fs.existsSync = originalExists;
    fs.readFileSync = originalReadFile;
    ProviderFactory.create = originalCreate;
    Server.prototype.connect = originalConnect;
    huManifest.load = originalHuLoad;
    lidlManifest.load = originalLidlLoad;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    globalThis.fetch = originalFetch;
    await client.close();
    await server?.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
