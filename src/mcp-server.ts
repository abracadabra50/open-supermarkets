#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) Server for Open Supermarkets
 *
 * Exposes grocery shopping functions as MCP tools for Claude Desktop
 * and other MCP-compatible clients. Provider metadata and capability checks
 * are read from the registry, so new countries do not need MCP-specific edits.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { compareProduct } from './providers/index.js';
import {
  assertCapability,
  createProvider,
  getManifest,
  PROVIDERS,
} from './providers/registry.js';
import type {
  AuthModel,
  Capability,
  GroceryProvider,
  ProviderManifest,
  StoreSearchOptions,
} from './providers/types.js';
import { money } from './format.js';
import { explain } from './errors.js';
import * as fs from 'fs';
import * as os from 'os';

/** Registry ids, including any community providers added for another country. */
export function providerIds(): string[] {
  return PROVIDERS.map((provider) => provider.id);
}

export function providerIdsForCapability(capability: Capability): string[] {
  return PROVIDERS
    .filter((provider) => provider.capabilities.includes(capability))
    .map((provider) => provider.id);
}

/**
 * Only legacy providers write a known local session file. A registry provider
 * may have no session at all, so callers must treat an unknown path as absent,
 * not try to pass `undefined` to fs.
 */
const SESSION_PATHS: Record<string, string> = {
  sainsburys: `${os.homedir()}/.sainsburys/session.json`,
  ocado: `${os.homedir()}/.ocado/session.json`,
  tesco: `${os.homedir()}/.tesco/session.json`,
};

export function sessionPath(providerId: string): string | undefined {
  return SESSION_PATHS[providerId];
}

export function needsStoredLogin(auth: AuthModel): boolean {
  return auth === 'credentials' || auth === 'session-cookie';
}

export function isLoggedIn(providerId: string): boolean {
  const path = sessionPath(providerId);
  return path ? fs.existsSync(path) : false;
}

export function requireLogin(providerId: string): string | null {
  const manifest = getManifest(providerId);
  if (!needsStoredLogin(manifest.auth)) return null;
  if (!isLoggedIn(providerId)) {
    return `Not logged in to ${providerId}. Use grocery_login with provider "${providerId}" first.`;
  }
  return null;
}

export function authenticationStatus(manifest: ProviderManifest): string {
  if (!needsStoredLogin(manifest.auth)) return `no stored login required (${manifest.auth})`;
  return isLoggedIn(manifest.id) ? 'logged in' : 'not logged in';
}

type ProviderMethod = keyof GroceryProvider;
type ProviderWithMethod<K extends ProviderMethod> = GroceryProvider & Required<Pick<GroceryProvider, K>>;

/**
 * Check the declarative contract before importing provider code, then check the
 * concrete method after construction. This protects search-only integrations
 * from accidental basket, slot, checkout, or order calls.
 */
export async function getCapabilityProvider<K extends ProviderMethod>(
  providerId: string,
  capability: Capability,
  method: K
): Promise<ProviderWithMethod<K>> {
  assertCapability(providerId, capability);
  const provider = await createProvider(providerId);
  return requireProviderMethod(providerId, capability, provider, method);
}

export function requireProviderMethod<K extends ProviderMethod>(
  providerId: string,
  capability: Capability,
  provider: GroceryProvider,
  method: K
): ProviderWithMethod<K> {
  if (typeof provider[method] !== 'function') {
    throw new Error(
      `Provider "${providerId}" declares "${capability}" but does not implement ${String(method)}.`
    );
  }
  return provider as ProviderWithMethod<K>;
}

export async function getProvider(providerId: string): Promise<GroceryProvider> {
  getManifest(providerId);
  return createProvider(providerId);
}

export interface StoreToolArguments {
  query?: string;
  postcode?: string;
  latitude?: number;
  longitude?: number;
  range?: number;
  shopping_mode?: 'pickup' | 'delivery';
  limit?: number;
}

/** Convert MCP's stable snake_case arguments to the provider contract. */
export function storeSearchOptions(args: StoreToolArguments): StoreSearchOptions {
  return {
    ...(args.query === undefined ? {} : { fullTextSearch: args.query }),
    ...(args.postcode === undefined ? {} : { postcode: args.postcode }),
    ...(args.latitude === undefined ? {} : { latitude: args.latitude }),
    ...(args.longitude === undefined ? {} : { longitude: args.longitude }),
    ...(args.range === undefined ? {} : { range: args.range }),
    ...(args.shopping_mode === undefined ? {} : { shoppingMode: args.shopping_mode }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  };
}

/** Select a provider store before a search, with an honest capability error. */
export async function selectStoreForSearch(
  providerId: string,
  provider: GroceryProvider,
  storeId: string,
): Promise<void> {
  if (!storeId.trim()) throw new Error('store_id must not be empty.');
  assertCapability(providerId, 'stores');
  const selected = requireProviderMethod(providerId, 'stores', provider, 'selectStore');
  await selected.selectStore(storeId);
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function stockLabel(inStock: boolean | null): string {
  return inStock === true ? 'In stock' : inStock === false ? 'Out of stock' : 'Availability unknown';
}

// ─── Tool definitions ────────────────────────────────────────────

export const providerEnum = {
  type: 'string',
  get enum() { return providerIds(); },
  description: 'Supermarket provider id from the provider registry',
};

export const storesProviderEnum = {
  type: 'string',
  get enum() { return providerIdsForCapability('stores'); },
  description: 'Provider id with read-only store lookup support',
};

export function toolDefinitions(): any[] {
  return [
      // ── Authentication ──
      {
        name: 'grocery_login',
        description: 'Login to a UK supermarket account. Required before using other tools for that provider. Launches a browser for authentication.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            email: { type: 'string', description: 'Account email address' },
            password: { type: 'string', description: 'Account password' },
          },
          required: ['email', 'password'],
        },
      },
      {
        name: 'grocery_status',
        description: 'Check which supermarket accounts are currently logged in.',
        inputSchema: { type: 'object', properties: {} },
      },

      {
        name: 'grocery_stores',
        description: 'List stores that can scope local pricing and availability. This is read-only.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...storesProviderEnum },
            query: { type: 'string', description: 'Retailer store name or text query, where supported' },
            postcode: { type: 'string', description: 'Postcode filter, where supported' },
            latitude: { type: 'number', description: 'Latitude for nearby-store search' },
            longitude: { type: 'number', description: 'Longitude for nearby-store search' },
            range: { type: 'number', description: 'Nearby-store radius in kilometres' },
            shopping_mode: { type: 'string', enum: ['pickup', 'delivery'], description: 'Required fulfilment mode for nearby search' },
            limit: { type: 'number', default: 10, description: 'Maximum stores to return (default: 10)' },
          },
          required: ['provider'],
        },
      },

      // ── Search ──
      {
        name: 'grocery_search',
        description: 'Search for grocery products. Returns product names, prices, stock status, and IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            query: { type: 'string', description: 'Search term (e.g., "milk", "organic eggs", "chicken breast")' },
            store_id: { type: 'string', description: 'Optional retailer store id from grocery_stores' },
            limit: { type: 'number', description: 'Maximum results to return (default: 10)', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'grocery_compare',
        description: 'Compare a product across search-capable providers in one country to find the best price.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Product to compare (e.g., "semi-skimmed milk")' },
            limit: { type: 'number', description: 'Results per provider (default: 5)', default: 5 },
            country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code (default: GB)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'grocery_search_batch',
        description:
          'Search MANY products in one call. Strongly preferred over repeated grocery_search ' +
          'when planning meals or building a shop — thirty ingredients is one call instead of ' +
          'thirty. Returns lean candidates (id, name, price, size, unit price, stock) for YOU ' +
          'to choose between; it does not pick for you.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            queries: {
              type: 'array',
              items: { type: 'string' },
              description: 'Product queries, e.g. ["semi skimmed milk","free range eggs"]',
            },
            store_id: { type: 'string', description: 'Optional retailer store id from grocery_stores, selected once before the batch' },
            limit: { type: 'number', description: 'Candidates per query (default: 5)', default: 5 },
          },
          required: ['queries'],
        },
      },
      {
        name: 'grocery_basket_add_batch',
        description:
          'Add MANY products to the basket in one call. Use after grocery_search_batch. ' +
          'Adds run sequentially and each result reports success individually, so a single ' +
          'bad id does not lose the rest.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'product_uid from a search result' },
                  qty: { type: 'number', description: 'Quantity (default: 1)' },
                },
                required: ['id'],
              },
            },
          },
          required: ['items'],
        },
      },
      {
        name: 'grocery_favourites',
        description: 'List favourite / frequently-bought products for a supermarket account. Supported by Sainsbury\'s and Ocado.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            limit: { type: 'number', description: 'Maximum results to return (default: 50)', default: 50 },
          },
        },
      },
      {
        name: 'grocery_favourites_search',
        description: 'Search within favourite / frequently-bought products. Supported by Sainsbury\'s and Ocado.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            query: { type: 'string', description: 'Search term (e.g., "milk", "yogurt", "bananas")' },
            limit: { type: 'number', description: 'Maximum results to return (default: 24)', default: 24 },
          },
          required: ['query'],
        },
      },
      {
        name: 'grocery_categories',
        description: 'List browse categories at a supermarket (shape is provider-dependent). Supported by Sainsbury\'s and Ocado.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
          },
        },
      },
      {
        name: 'grocery_browse',
        description: 'Browse products in a category. Pass a category path from grocery_categories (e.g. Ocado: "/categories/fresh/12345"). Currently supported by Ocado.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'ocado' },
            category_path: { type: 'string', description: 'Category path from grocery_categories' },
            limit: { type: 'number', description: 'Maximum results to return (default: 50)', default: 50 },
          },
          required: ['category_path'],
        },
      },
      {
        name: 'ocado_regulars',
        description: 'List Ocado recurring-shopping ("Regulars") definitions on the account.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },

      // ── Basket ──
      {
        name: 'grocery_basket_view',
        description: 'View the current shopping basket contents and total cost at a supermarket.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
          },
        },
      },
      {
        name: 'grocery_basket_add',
        description: 'Add a product to the shopping basket at a supermarket.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            product_id: { type: 'string', description: 'Product ID from search results' },
            quantity: { type: 'number', description: 'Quantity to add (default: 1)', default: 1 },
          },
          required: ['product_id'],
        },
      },
      {
        name: 'grocery_basket_remove',
        description: 'Remove a product from the shopping basket.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            product_id: { type: 'string', description: 'Product or item ID to remove' },
          },
          required: ['product_id'],
        },
      },
      {
        name: 'grocery_basket_update',
        description: 'Update the quantity of an item already in the basket.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            item_id: { type: 'string', description: 'Item ID in the basket' },
            quantity: { type: 'number', description: 'New quantity' },
          },
          required: ['item_id', 'quantity'],
        },
      },
      {
        name: 'grocery_basket_clear',
        description: 'Clear all items from the shopping basket. This cannot be undone.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
          },
        },
      },

      // ── Delivery & Checkout ──
      {
        name: 'grocery_slots',
        description: 'List available delivery slots. May use browser automation and take 10-15 seconds.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
          },
        },
      },
      {
        name: 'grocery_book_slot',
        description: 'Book a delivery slot.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            slot_id: { type: 'string', description: 'Slot ID from grocery_slots results' },
          },
          required: ['slot_id'],
        },
      },
      {
        name: 'grocery_checkout',
        description: 'Complete the order and checkout. Use dry_run=true to preview without placing the order.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            dry_run: { type: 'boolean', description: 'Preview without placing order (default: true)', default: true },
          },
        },
      },
      {
        name: 'grocery_orders',
        description: 'View order history for a supermarket.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { ...providerEnum, default: 'sainsburys' },
            limit: { type: 'number', description: 'Max orders to return (default: 10)', default: 10 },
          },
        },
      },

      // ── Tesco-specific ──
      {
        name: 'tesco_staples',
        description: 'Tesco only: View or manage repeat-purchase staples detected from order history. Can auto-add staples to basket.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['view', 'update', 'add_to_basket'],
              description: 'view = show staples, update = refresh from order history, add_to_basket = add all staples to basket',
              default: 'view',
            },
          },
        },
      },

      // ── Providers ──
      {
        name: 'grocery_providers',
        description: 'List all available supermarket providers and their login status.',
        inputSchema: { type: 'object', properties: {} },
      },
  ];
}

/** Construct a server without connecting it, which keeps import-time tests offline. */
export function createMcpServer(): Server {
const server = new Server(
  { name: 'open-supermarkets', version: '3.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions(),
}));

// ─── Tool handlers ───────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const providerName = String((args as any).provider || 'sainsburys');

  try {
    // ── grocery_login ──
    if (name === 'grocery_login') {
      const { email, password } = args as { email: string; password: string };
      const manifest = getManifest(providerName);
      if (!needsStoredLogin(manifest.auth)) {
        return textResult(`Provider "${providerName}" does not support account login. Its auth model is ${manifest.auth}.`, true);
      }
      const provider = await getProvider(providerName);
      if (typeof provider.login !== 'function') {
        return textResult(`Provider "${providerName}" declares ${manifest.auth} authentication but has no login method.`, true);
      }
      await provider.login(email, password);
      return textResult(`Logged in to ${providerName} successfully. Session saved.`);
    }

    // ── grocery_status ──
    if (name === 'grocery_status') {
      const statuses = PROVIDERS.map((p) => `${p.id}: ${authenticationStatus(p)}`);
      return textResult(`Authentication status:\n${statuses.join('\n')}`);
    }

    // ── grocery_providers ──
    if (name === 'grocery_providers') {
      const info = PROVIDERS.map((p) =>
        `- ${p.id} (${p.label}) | country: ${p.country}${p.countries?.length ? `/${p.countries.join('/')}` : ''} | ` +
        `auth: ${p.auth} | capabilities: ${p.capabilities.join(', ') || 'none'} | ${authenticationStatus(p)}`
      );
      return textResult(`Available providers:\n${info.join('\n')}`);
    }

    if (name === 'grocery_stores') {
      const loginError = requireLogin(providerName);
      if (loginError) return textResult(loginError, true);
      const provider = await getCapabilityProvider(providerName, 'stores', 'listStores');
      const stores = await provider.listStores(storeSearchOptions(args as StoreToolArguments));
      return textResult(JSON.stringify({ provider: providerName, stores }, null, 2));
    }

    if (name === 'grocery_search_batch') {
      const { queries = [], limit = 5, store_id } = args as {
        queries?: string[];
        limit?: number;
        store_id?: string;
      };
      if (!queries.length) return textResult('Give me at least one query.', true);
      const loginError = requireLogin(providerName);
      if (loginError) return textResult(loginError, true);
      const { batchSearch } = await import('./batch.js');
      const provider = await getCapabilityProvider(providerName, 'search', 'search');
      if (store_id !== undefined) await selectStoreForSearch(providerName, provider, store_id);
      const results = await batchSearch(provider, queries, { limit });
      return textResult(JSON.stringify({ provider: providerName, results }, null, 2));
    }

    if (name === 'grocery_basket_add_batch') {
      const { items = [] } = args as { items?: Array<{ id: string; qty?: number }> };
      if (!items.length) return textResult('Give me at least one item.', true);
      const loginError = requireLogin(providerName);
      if (loginError) return textResult(loginError, true);
      const { batchAdd } = await import('./batch.js');
      const provider = await getCapabilityProvider(providerName, 'basket', 'addToBasket');
      const results = await batchAdd(provider, items);
      const added = results.filter(r => r.ok).length;
      return textResult(
        JSON.stringify({ provider: providerName, added, total: results.length, results }, null, 2),
        added < results.length
      );
    }

    if (name === 'grocery_compare') {
      const { query, limit = 5, country } = args as { query: string; limit?: number; country?: string };
      const results = await compareProduct(query, undefined, limit, country);

      const sections = results.map(({ provider, products, error }) => {
        if (error) return `${provider.toUpperCase()}: Error - ${error}`;
        if (products.length === 0) return `${provider.toUpperCase()}: No products found`;

        const cheapest = products.reduce((min, p) =>
          p.retail_price.price < min.retail_price.price ? p : min
        );
        const lines = products.map((p, i) => {
          const best = p.product_uid === cheapest.product_uid ? ' [BEST PRICE]' : '';
          return `  ${i + 1}. ${p.name} - ${money(p.retail_price.price, p.currency)}${best} (ID: ${p.product_uid})`;
        });
        return `${provider.toUpperCase()}:\n${lines.join('\n')}`;
      });

      return textResult(`Price comparison for "${query}":\n\n${sections.join('\n\n')}`);
    }

    // All remaining tools require login
    const loginError = requireLogin(providerName);

    // ── grocery_search ──
    if (name === 'grocery_search') {
      if (loginError) return textResult(loginError, true);
      const { query, limit = 10, store_id } = args as {
        query: string;
        limit?: number;
        store_id?: string;
      };
      const provider = await getCapabilityProvider(providerName, 'search', 'search');
      if (store_id !== undefined) await selectStoreForSearch(providerName, provider, store_id);
      const results = await provider.search(query, { limit });
      const limited = results.slice(0, limit);

      const formatted = limited.map((p, i) => {
        const stock = stockLabel(p.in_stock);
        const unitPrice = p.unit_price ? ` (${p.unit_price.price}/${p.unit_price.measure})` : '';
        return `${i + 1}. ${p.name}\n   ${money(p.retail_price.price, p.currency)}${unitPrice} | ${stock} | ID: ${p.product_uid}`;
      }).join('\n\n');

      return textResult(
        `Found ${results.length} products at ${providerName} (showing ${limited.length}):\n\n${formatted}`
      );
    }

    // ── grocery_favourites ──
    if (name === 'grocery_favourites') {
      if (loginError) return textResult(loginError, true);
      const { limit = 50 } = args as { limit?: number };
      const provider: any = await getProvider(providerName);

      if (typeof provider.getFavourites !== 'function') {
        return textResult(`Provider "${providerName}" does not support favourites.`, true);
      }

      const products = await provider.getFavourites({ limit });
      if (products.length === 0) {
        return textResult(`No favourites found at ${providerName}.`);
      }

      const formatted = products.map((p: any, i: number) => {
        const stock = stockLabel(p.in_stock);
        const unitPrice = p.unit_price ? ` (${p.unit_price.price}/${p.unit_price.measure})` : '';
        return `${i + 1}. ${p.name}\n   ${money(p.retail_price.price, p.currency)}${unitPrice} | ${stock} | ID: ${p.product_uid}`;
      }).join('\n\n');

      return textResult(
        `${providerName.toUpperCase()} Favourites (showing ${products.length}):\n\n${formatted}`
      );
    }

    // ── grocery_favourites_search ──
    if (name === 'grocery_favourites_search') {
      if (loginError) return textResult(loginError, true);
      const { query, limit = 24 } = args as { query: string; limit?: number };
      const provider: any = await getProvider(providerName);

      if (typeof provider.searchFavourites !== 'function') {
        return textResult(`Provider "${providerName}" does not support favourite search.`, true);
      }

      const products = await provider.searchFavourites(query, { limit });
      if (products.length === 0) {
        return textResult(`No favourite products matching "${query}" found at ${providerName}.`);
      }

      const formatted = products.map((p: any, i: number) => {
        const stock = stockLabel(p.in_stock);
        const unitPrice = p.unit_price ? ` (${p.unit_price.price}/${p.unit_price.measure})` : '';
        return `${i + 1}. ${p.name}\n   ${money(p.retail_price.price, p.currency)}${unitPrice} | ${stock} | ID: ${p.product_uid}`;
      }).join('\n\n');

      return textResult(
        `Favourite search results for "${query}" at ${providerName} (showing ${products.length}):\n\n${formatted}`
      );
    }

    // ── grocery_categories ──
    if (name === 'grocery_categories') {
      if (loginError) return textResult(loginError, true);
      const provider: any = await getProvider(providerName);

      if (typeof provider.getCategories !== 'function') {
        return textResult(`Provider "${providerName}" does not support category browsing.`, true);
      }

      const categories = await provider.getCategories();
      return textResult(
        `${providerName.toUpperCase()} categories:\n\n${JSON.stringify(categories, null, 2)}`
      );
    }

    // ── grocery_browse ──
    if (name === 'grocery_browse') {
      if (loginError) return textResult(loginError, true);
      const { category_path, limit = 50 } = args as { category_path: string; limit?: number };
      const provider: any = await getProvider(providerName);

      if (typeof provider.browseCategory !== 'function') {
        return textResult(`Provider "${providerName}" does not support category browsing.`, true);
      }

      const products = await provider.browseCategory(category_path, { limit });
      if (products.length === 0) {
        return textResult(`No products found in "${category_path}" at ${providerName}.`);
      }

      const formatted = products.map((p: any, i: number) => {
        const stock = stockLabel(p.in_stock);
        const unitPrice = p.unit_price ? ` (${p.unit_price.price}/${p.unit_price.measure})` : '';
        return `${i + 1}. ${p.name}\n   ${money(p.retail_price.price, p.currency)}${unitPrice} | ${stock} | ID: ${p.product_uid}`;
      }).join('\n\n');

      return textResult(
        `Products in "${category_path}" at ${providerName} (showing ${products.length}):\n\n${formatted}`
      );
    }

    // ── ocado_regulars ──
    if (name === 'ocado_regulars') {
      const provider: any = await getProvider('ocado');

      if (typeof provider.getRegulars !== 'function') {
        return textResult('Ocado provider does not support regulars.', true);
      }

      const regulars = await provider.getRegulars();
      if (regulars.length === 0) {
        return textResult('No Regulars set up on this Ocado account.');
      }
      return textResult(
        `Ocado Regulars (${regulars.length}):\n\n${JSON.stringify(regulars, null, 2)}`
      );
    }

    // ── grocery_basket_view ──
    if (name === 'grocery_basket_view') {
      if (loginError) return textResult(loginError, true);
      const provider = await getCapabilityProvider(providerName, 'basket', 'getBasket');
      const basket = await provider.getBasket();

      if (basket.items.length === 0) {
        return textResult(`${providerName} basket is empty.`);
      }

      const formatted = basket.items.map((item, i) =>
        `${i + 1}. ${item.quantity}x ${item.name}\n   ${money(item.unit_price)} each = ${money(item.total_price)} | ID: ${item.product_uid}`
      ).join('\n\n');

      return textResult(
        `${providerName.toUpperCase()} Basket - ${money(basket.total_cost)} (${basket.items.length} items):\n\n${formatted}`
      );
    }

    // ── grocery_basket_add ──
    if (name === 'grocery_basket_add') {
      if (loginError) return textResult(loginError, true);
      const { product_id, quantity = 1 } = args as { product_id: string; quantity?: number };
      const provider = await getCapabilityProvider(providerName, 'basket', 'addToBasket');
      await provider.addToBasket(product_id, quantity);
      return textResult(`Added ${quantity}x product ${product_id} to ${providerName} basket.`);
    }

    // ── grocery_basket_remove ──
    if (name === 'grocery_basket_remove') {
      if (loginError) return textResult(loginError, true);
      const { product_id } = args as { product_id: string };
      const provider = await getCapabilityProvider(providerName, 'basket', 'removeFromBasket');
      await provider.removeFromBasket(product_id);
      return textResult(`Removed product ${product_id} from ${providerName} basket.`);
    }

    // ── grocery_basket_update ──
    if (name === 'grocery_basket_update') {
      if (loginError) return textResult(loginError, true);
      const { item_id, quantity } = args as { item_id: string; quantity: number };
      const provider = await getCapabilityProvider(providerName, 'basket', 'updateBasketItem');
      await provider.updateBasketItem(item_id, quantity);
      return textResult(`Updated item ${item_id} to quantity ${quantity} in ${providerName} basket.`);
    }

    // ── grocery_basket_clear ──
    if (name === 'grocery_basket_clear') {
      if (loginError) return textResult(loginError, true);
      const provider = await getCapabilityProvider(providerName, 'basket', 'clearBasket');
      await provider.clearBasket();
      return textResult(`${providerName} basket cleared.`);
    }

    // ── grocery_slots ──
    if (name === 'grocery_slots') {
      if (loginError) return textResult(loginError, true);
      const provider = await getCapabilityProvider(providerName, 'slots', 'getDeliverySlots');
      const slots = await provider.getDeliverySlots();

      if (slots.length === 0) {
        return textResult(`No delivery slots available at ${providerName}. Ensure basket meets minimum spend.`);
      }

      const formatted = slots.map((slot, i) => {
        const avail = slot.available ? 'Available' : 'Unavailable';
        return `${i + 1}. ${slot.date} ${slot.start_time}-${slot.end_time}\n   ${money(slot.price)} | ${avail} | ID: ${slot.slot_id}`;
      }).join('\n\n');

      return textResult(`${providerName.toUpperCase()} Delivery Slots:\n\n${formatted}`);
    }

    // ── grocery_book_slot ──
    if (name === 'grocery_book_slot') {
      if (loginError) return textResult(loginError, true);
      const { slot_id } = args as { slot_id: string };
      const provider = await getCapabilityProvider(providerName, 'slots', 'bookSlot');
      await provider.bookSlot(slot_id);
      return textResult(`Slot ${slot_id} booked at ${providerName}.`);
    }

    // ── grocery_checkout ──
    if (name === 'grocery_checkout') {
      if (loginError) return textResult(loginError, true);
      const { dry_run = true } = args as { dry_run?: boolean };
      const provider = await getCapabilityProvider(providerName, 'checkout', 'checkout');
      const order = await provider.checkout(dry_run);

      if (dry_run) {
        return textResult(
          `Checkout preview for ${providerName}:\nTotal: ${money(order.total)}\nStatus: ${order.status}\nItems: ${order.items.length}\n\nUse dry_run=false to place the order.`
        );
      }

      return textResult(
        `Order placed at ${providerName}!\nOrder ID: ${order.order_id}\nTotal: ${money(order.total)}\nStatus: ${order.status}`
      );
    }

    // ── grocery_orders ──
    if (name === 'grocery_orders') {
      if (loginError) return textResult(loginError, true);
      const { limit = 10 } = args as { limit?: number };
      const provider = await getCapabilityProvider(providerName, 'orders', 'getOrders');
      const orders = await provider.getOrders();

      if (orders.length === 0) {
        return textResult(`No orders found at ${providerName}.`);
      }

      const displayed = orders.slice(0, limit);
      const formatted = displayed.map((order, i) => {
        const delivery = order.delivery_slot
          ? `\n   Delivery: ${order.delivery_slot.date} ${order.delivery_slot.start_time}-${order.delivery_slot.end_time}`
          : '';
        return `${i + 1}. Order #${order.order_id}\n   Total: ${money(order.total)} | Status: ${order.status}${delivery}`;
      }).join('\n\n');

      return textResult(
        `${providerName.toUpperCase()} Orders (${displayed.length} of ${orders.length}):\n\n${formatted}`
      );
    }

    // ── tesco_staples ──
    if (name === 'tesco_staples') {
      const tescoLoginError = requireLogin('tesco');
      if (tescoLoginError) return textResult(tescoLoginError, true);

      const { action = 'view' } = args as { action?: string };
      const { TescoProvider } = await import('./providers/tesco/index.js');
      const { updateStaples, loadStaples, addStaplesToBasket } = await import('./providers/tesco/staples.js');

      const tesco = new TescoProvider();
      const api = tesco.getAPI();

      let staples = loadStaples();

      if (action === 'update' || staples.length === 0) {
        staples = await updateStaples(api);
      }

      if (action === 'add_to_basket') {
        assertCapability('tesco', 'basket');
        if (typeof tesco.getBasket !== 'function' || typeof tesco.addToBasket !== 'function') {
          return textResult('Tesco declares basket support but its basket methods are unavailable.', true);
        }
        const basket = await tesco.getBasket();
        const alreadyAdded = new Set(basket.items.map(i => i.product_uid));
        await addStaplesToBasket(tesco, staples, alreadyAdded);
        return textResult(`Added ${staples.length} staples to Tesco basket (skipped items already in basket).`);
      }

      const formatted = staples.map((s: any, i: number) =>
        `${i + 1}. ${s.name} (ordered ${s.frequency} times) | ID: ${s.product_uid}`
      ).join('\n');

      return textResult(`Tesco Staples (${staples.length} items):\n\n${formatted}`);
    }

    return textResult(`Unknown tool: ${name}`, true);

  } catch (error: any) {
    // Agents act on error text, so a bare "status code 401" makes them retry
    // forever instead of telling the user to log in.
    return textResult(`Error: ${explain(error, { provider: providerName })}`, true);
  }
});

  return server;
}

// ─── Start server ────────────────────────────────────────────────

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Open Supermarkets MCP Server v3.0.0 running on stdio');
  console.error(`Providers: ${providerIds().join(', ')}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
