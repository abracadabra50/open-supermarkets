import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProviderFactory } from '../src/providers';
import { TescoHuProvider } from '../src/providers/tesco-hu';

// Exercise the real MCP request handlers without stdio, credentials or retailer calls.
// Regressions that collapse null into false must fail at the client-visible boundary.
async function main() {
  const products = [true, false, null].map((in_stock, index) => ({
    product_uid: String(index), name: ['Available', 'Unavailable', 'Unknown'][index],
    retail_price: { price: 2 }, currency: 'EUR', provider: 'tesco-hu', in_stock,
  }));
  const provider = {
    name: 'tesco-hu',
    search: async () => products,
    getFavourites: async () => products,
    searchFavourites: async () => products,
    browseCategory: async () => products,
  };
  const originalCreate = ProviderFactory.create;
  const originalSearch = TescoHuProvider.prototype.search;
  const originalConnect = Server.prototype.connect;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let server: Server | undefined;
  let connection: Promise<void> | undefined;
  const client = new Client({ name: 'stock-regression', version: '1.0.0' });
  try {
    ProviderFactory.create = (() => provider) as typeof ProviderFactory.create;
    TescoHuProvider.prototype.search = (async () => products) as typeof originalSearch;
    Server.prototype.connect = function () {
      server = this;
      connection = originalConnect.call(this, serverTransport);
      return connection;
    };
    require('../src/mcp-server');
    await connection;
    await client.connect(clientTransport);
    for (const name of ['grocery_search', 'grocery_favourites', 'grocery_favourites_search', 'grocery_browse']) {
      const result = await client.callTool({ name, arguments: {
        provider: 'tesco-hu', query: 'milk', category_path: 'dairy',
      } });
      assert.notEqual(result.isError, true, `${name} should succeed: ${JSON.stringify(result.content)}`);
      const text = (result.content as Array<{ text: string }>).map(item => item.text).join('\n');
      assert.match(text, /Available\n[^\n]*\| In stock \|/, name);
      assert.match(text, /Unavailable\n[^\n]*\| Out of stock \|/, name);
      assert.match(text, /Unknown\n[^\n]*\| Stock unknown \|/, `${name} must distinguish null from false`);
      console.log(`  ✓ ${name} preserves all three stock states`);
    }
  } finally {
    ProviderFactory.create = originalCreate;
    TescoHuProvider.prototype.search = originalSearch;
    Server.prototype.connect = originalConnect;
    await client.close();
    await server?.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
