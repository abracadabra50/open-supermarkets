#!/usr/bin/env node

import http from 'node:http';
import { URL } from 'node:url';
import { createProvider, getManifest } from './providers';
import type { ProviderName } from './providers';
import type { Capability, GroceryProvider, SearchOptions, StoreSearchOptions } from './providers/types';

type FavouritesProvider = GroceryProvider & {
  getFavourites?: (options?: SearchOptions) => Promise<unknown[]>;
  searchFavourites?: (query: string, options?: SearchOptions) => Promise<unknown[]>;
};

type ProviderResolver = (name: ProviderName) => Promise<GroceryProvider> | GroceryProvider;

export interface HttpServerOptions {
  host?: string;
  port?: number;
  defaultProvider?: ProviderName;
  /** `null` disables authentication for deterministic local tests. */
  apiToken?: string | null;
  /** Replaces the registry loader in tests. */
  resolveProvider?: ProviderResolver;
}

interface ResolvedHttpServerOptions {
  host: string;
  port: number;
  defaultProvider: ProviderName;
  apiToken?: string;
  resolveProvider: ProviderResolver;
}

interface ProviderContext {
  name: ProviderName;
  manifest: ReturnType<typeof getManifest>;
  provider: GroceryProvider;
}

// SUPERMARKET_* preferred; GROC_* still honoured for pre-3.0 setups.
function resolveOptions(options: HttpServerOptions = {}): ResolvedHttpServerOptions {
  const host = options.host || process.env.SUPERMARKET_API_HOST || process.env.GROC_API_HOST || '127.0.0.1';
  const port = options.port ?? parsePort(process.env.SUPERMARKET_API_PORT || process.env.GROC_API_PORT || '7876');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid SUPERMARKET_API_PORT: ${port}`);
  }
  const defaultProvider = options.defaultProvider ||
    (process.env.SUPERMARKET_PROVIDER || process.env.GROC_PROVIDER || 'sainsburys') as ProviderName;
  const apiToken = options.apiToken === null
    ? undefined
    : options.apiToken ?? process.env.SUPERMARKET_API_TOKEN ?? process.env.GROC_API_TOKEN;
  return {
    host,
    port,
    defaultProvider,
    apiToken,
    resolveProvider: options.resolveProvider || ((name) => createProvider(name)),
  };
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid SUPERMARKET_API_PORT: ${value}`);
  }
  return parsed;
}

function parsePositiveInt(value: string | null, name: string, defaultValue: number): number {
  if (value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function badRequest(message: string): Error & { statusCode: 400 } {
  return Object.assign(new Error(message), { statusCode: 400 as const });
}

function optionalQuery(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = raw.trim();
  if (!value) throw badRequest(`${name} must not be empty`);
  return value;
}

function optionalNumber(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') {
    if (raw === null) return undefined;
    throw badRequest(`${name} must be a finite number`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw badRequest(`${name} must be a finite number, got "${raw}"`);
  return parsed;
}

function storeSearchOptions(url: URL): StoreSearchOptions {
  const latitude = optionalNumber(url, 'latitude');
  const longitude = optionalNumber(url, 'longitude');
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw badRequest('latitude and longitude must be provided together');
  }
  if (
    latitude !== undefined &&
    (latitude < -90 || latitude > 90 || longitude! < -180 || longitude! > 180)
  ) {
    throw badRequest('latitude must be between -90 and 90 and longitude between -180 and 180');
  }

  const range = optionalNumber(url, 'range');
  if (range !== undefined && range <= 0) throw badRequest('range must be greater than zero');

  const rawMode = optionalQuery(url, 'mode');
  const mode = rawMode?.toLowerCase();
  if (mode !== undefined && mode !== 'pickup' && mode !== 'delivery') {
    throw badRequest(`mode must be "pickup" or "delivery", got "${rawMode}"`);
  }

  const options: StoreSearchOptions = {
    limit: parsePositiveInt(url.searchParams.get('limit'), 'limit', 20),
  };
  const query = optionalQuery(url, 'query');
  const postcode = optionalQuery(url, 'postcode');
  if (query !== undefined) options.fullTextSearch = query;
  if (postcode !== undefined) options.postcode = postcode;
  if (latitude !== undefined) {
    options.latitude = latitude;
    options.longitude = longitude;
  }
  if (range !== undefined) options.range = range;
  if (mode !== undefined) options.shoppingMode = mode as 'pickup' | 'delivery';
  return options;
}

async function getProvider(url: URL, options: ResolvedHttpServerOptions): Promise<ProviderContext> {
  const name = (url.searchParams.get('provider') || options.defaultProvider) as ProviderName;
  const manifest = getManifest(name);
  const provider = await options.resolveProvider(name);
  return { name, manifest, provider };
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function requireQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw Object.assign(new Error(`Missing query parameter: ${name}`), { statusCode: 400 });
  return value;
}

function checkAuth(req: http.IncomingMessage, options: ResolvedHttpServerOptions): boolean {
  if (!options.apiToken) return true;
  return req.headers.authorization === `Bearer ${options.apiToken}`;
}

type BoundProviderMethod = (...args: any[]) => any;

function routeMethod(
  context: ProviderContext,
  capability: Capability,
  method: keyof GroceryProvider,
  route: string,
): BoundProviderMethod | string {
  if (!context.manifest.capabilities.includes(capability)) {
    return `Provider "${context.name}" does not support "${capability}" required by ${route}`;
  }
  const candidate = context.provider[method];
  if (typeof candidate !== 'function') {
    return `Provider "${context.name}" declares "${capability}" but does not implement "${String(method)}" required by ${route}`;
  }
  return candidate.bind(context.provider);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ResolvedHttpServerOptions,
): Promise<void> {
  if (!checkAuth(req, options)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || `${options.host}:${options.port}`}`);

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      provider: url.searchParams.get('provider') || options.defaultProvider,
      endpoints: [
        '/search?q=',
        '/stores?query=&postcode=&latitude=&longitude=&range=&mode=&limit=',
        '/add?id=&qty=',
        '/remove?id=',
        '/update?id=&qty=',
        '/basket',
        '/favourites',
        '/fav-search?q='
      ],
    });
  }

  const context = await getProvider(url, options);
  const { provider } = context;

  if (url.pathname === '/stores') {
    const listStores = routeMethod(context, 'stores', 'listStores', '/stores');
    if (typeof listStores === 'string') return sendJson(res, 501, { error: listStores });
    try {
      const stores = await listStores(storeSearchOptions(url));
      return sendJson(res, 200, { stores });
    } catch (error: any) {
      if (error instanceof RangeError) {
        return sendJson(res, 400, { error: error.message });
      }
      throw error;
    }
  }

  if (url.pathname === '/search') {
    const search = routeMethod(context, 'search', 'search', '/search');
    if (typeof search === 'string') return sendJson(res, 501, { error: search });
    const storeId = optionalQuery(url, 'store_id');
    if (storeId !== undefined) {
      const selectStore = routeMethod(context, 'stores', 'selectStore', '/search store selection');
      if (typeof selectStore === 'string') return sendJson(res, 501, { error: selectStore });
      try {
        await selectStore(storeId);
      } catch (error: any) {
        const detail = error?.message || 'store was not found';
        return sendJson(res, 400, { error: `Invalid store_id "${storeId}": ${detail}` });
      }
    }
    const q = requireQuery(url, 'q');
    const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 24);
    const products = await search(q, { limit });
    return sendJson(res, 200, { products });
  }

  if (url.pathname === '/add') {
    const addToBasket = routeMethod(context, 'basket', 'addToBasket', '/add');
    if (typeof addToBasket === 'string') return sendJson(res, 501, { error: addToBasket });
    const id = url.searchParams.get('id') || url.searchParams.get('q');
    if (!id) throw Object.assign(new Error('Missing query parameter: id'), { statusCode: 400 });
    const qty = parsePositiveInt(url.searchParams.get('qty'), 'qty', 1);
    await addToBasket(id, qty);
    return sendJson(res, 200, { ok: true, provider: provider.name, product_id: id, quantity: qty });
  }

  if (url.pathname === '/remove') {
    const removeFromBasket = routeMethod(context, 'basket', 'removeFromBasket', '/remove');
    if (typeof removeFromBasket === 'string') return sendJson(res, 501, { error: removeFromBasket });
    const id = url.searchParams.get('id') || url.searchParams.get('q');
    if (!id) throw Object.assign(new Error('Missing query parameter: id'), { statusCode: 400 });
    await removeFromBasket(id);
    return sendJson(res, 200, { ok: true, provider: provider.name, item_id: id });
  }

  if (url.pathname === '/update') {
    const updateBasketItem = routeMethod(context, 'basket', 'updateBasketItem', '/update');
    if (typeof updateBasketItem === 'string') return sendJson(res, 501, { error: updateBasketItem });
    const id = url.searchParams.get('id') || url.searchParams.get('q');
    if (!id) throw Object.assign(new Error('Missing query parameter: id'), { statusCode: 400 });
    const qty = parsePositiveInt(url.searchParams.get('qty'), 'qty', 1);
    await updateBasketItem(id, qty);
    return sendJson(res, 200, { ok: true, provider: provider.name, item_id: id, quantity: qty });
  }

  if (url.pathname === '/basket') {
    const getBasket = routeMethod(context, 'basket', 'getBasket', '/basket');
    if (typeof getBasket === 'string') return sendJson(res, 501, { error: getBasket });
    return sendJson(res, 200, await getBasket());
  }

  if (url.pathname === '/favourites' || url.pathname === '/favorites') {
    const favouritesProvider = provider as FavouritesProvider;
    if (typeof favouritesProvider.getFavourites !== 'function') {
      return sendJson(res, 501, { error: `Provider "${provider.name}" does not support favourites` });
    }
    const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 50);
    const products = await favouritesProvider.getFavourites({ limit });
    return sendJson(res, 200, { products });
  }

  if (url.pathname === '/fav-search' || url.pathname === '/favorite-search') {
    const favouritesProvider = provider as FavouritesProvider;
    if (typeof favouritesProvider.searchFavourites !== 'function') {
      return sendJson(res, 501, { error: `Provider "${provider.name}" does not support favourite search` });
    }
    const q = requireQuery(url, 'q');
    const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 24);
    const products = await favouritesProvider.searchFavourites(q, { limit });
    return sendJson(res, 200, { products });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function createServerFromResolvedOptions(resolved: ResolvedHttpServerOptions): http.Server {
  return http.createServer((req, res) => {
    handleRequest(req, res, resolved).catch((error: any) => {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(res, status, { error: error?.message || 'Internal server error' });
    });
  });
}

export function createServer(options: HttpServerOptions = {}): http.Server {
  return createServerFromResolvedOptions(resolveOptions(options));
}

export function startServer(options: HttpServerOptions = {}): http.Server {
  const resolved = resolveOptions(options);
  const server = createServerFromResolvedOptions(resolved);
  server.listen(resolved.port, resolved.host, () => {
    console.log(`open-supermarkets API listening on http://${resolved.host}:${resolved.port}`);
    console.log(`Provider: ${resolved.defaultProvider}`);
    if (!resolved.apiToken) {
      console.log('No SUPERMARKET_API_TOKEN set; relying on localhost binding for access control.');
    }
    if (resolved.host !== '127.0.0.1' && resolved.host !== 'localhost' && !resolved.apiToken) {
      console.warn('WARNING: API is not bound to localhost and has no token. Set SUPERMARKET_API_TOKEN.');
    }
  });
  return server;
}

if (require.main === module) {
  startServer();
}
