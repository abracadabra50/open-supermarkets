#!/usr/bin/env node

import http from 'node:http';
import { URL } from 'node:url';
import { ProviderFactory, ProviderName } from './providers';
import { createProvider, supports } from './providers/registry';
import type { FullGroceryProvider, SearchOptions } from './providers/types';

type FavouritesProvider = FullGroceryProvider & {
  getFavourites?: (options?: SearchOptions) => Promise<unknown[]>;
  searchFavourites?: (query: string, options?: SearchOptions) => Promise<unknown[]>;
};

// SUPERMARKET_* preferred; GROC_* still honoured for pre-3.0 setups.
const host = process.env.SUPERMARKET_API_HOST || process.env.GROC_API_HOST || '127.0.0.1';
const port = parsePort(process.env.SUPERMARKET_API_PORT || process.env.GROC_API_PORT || '7876');
const defaultProvider = (process.env.SUPERMARKET_PROVIDER || process.env.GROC_PROVIDER || 'sainsburys') as ProviderName;
const apiToken = process.env.SUPERMARKET_API_TOKEN || process.env.GROC_API_TOKEN;

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
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function getProvider(url: URL): FullGroceryProvider {
  const providerName = (url.searchParams.get('provider') || defaultProvider) as ProviderName;
  return ProviderFactory.create(providerName);
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

function checkAuth(req: http.IncomingMessage): boolean {
  if (!apiToken) return true;
  return req.headers.authorization === `Bearer ${apiToken}`;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req)) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (url.pathname === '/' || url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      provider: url.searchParams.get('provider') || defaultProvider,
      endpoints: [
        '/search?q=',
        '/add?id=&qty=',
        '/remove?id=',
        '/update?id=&qty=',
        '/basket',
        '/favourites',
        '/fav-search?q='
      ],
    });
  }

  if (url.pathname === '/search') {
    const q = requireQuery(url, 'q');
    const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 24);
    const provider = await createProvider(url.searchParams.get('provider') || defaultProvider);
    const products = await provider.search(q, { limit });
    return sendJson(res, 200, { products });
  }

  // Unsupported operations must fail before the legacy factory is called.
  const basketPaths = ['/add', '/remove', '/update', '/basket'];
  const favouritePaths = ['/favourites', '/favorites', '/fav-search', '/favorite-search'];
  if (!basketPaths.includes(url.pathname) && !favouritePaths.includes(url.pathname)) {
    return sendJson(res, 404, { error: 'Not found' });
  }
  const providerId = url.searchParams.get('provider') || defaultProvider;
  if ((basketPaths.includes(url.pathname) && !supports(providerId, 'basket')) ||
      (favouritePaths.includes(url.pathname) &&
       providerId !== 'sainsburys' && providerId !== 'ocado')) {
    return sendJson(res, 501, { error: `Provider "${providerId}" does not support ${url.pathname}` });
  }
  const provider = getProvider(url);

  if (url.pathname === '/add') {
    const id = url.searchParams.get('id') || url.searchParams.get('q');
    if (!id) throw Object.assign(new Error('Missing query parameter: id'), { statusCode: 400 });
    const qty = parsePositiveInt(url.searchParams.get('qty'), 'qty', 1);
    await provider.addToBasket(id, qty);
    return sendJson(res, 200, { ok: true, provider: provider.name, product_id: id, quantity: qty });
  }

  if (url.pathname === '/remove') {
    const id = url.searchParams.get('id') || url.searchParams.get('q');
    if (!id) throw Object.assign(new Error('Missing query parameter: id'), { statusCode: 400 });
    await provider.removeFromBasket(id);
    return sendJson(res, 200, { ok: true, provider: provider.name, item_id: id });
  }

  if (url.pathname === '/update') {
    const id = url.searchParams.get('id') || url.searchParams.get('q');
    if (!id) throw Object.assign(new Error('Missing query parameter: id'), { statusCode: 400 });
    const qty = parsePositiveInt(url.searchParams.get('qty'), 'qty', 1);
    await provider.updateBasketItem(id, qty);
    return sendJson(res, 200, { ok: true, provider: provider.name, item_id: id, quantity: qty });
  }

  if (url.pathname === '/basket') {
    return sendJson(res, 200, await provider.getBasket());
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

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error: any) => {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    sendJson(res, status, { error: error?.message || 'Internal server error' });
  });
});

server.listen(port, host, () => {
  console.log(`open-supermarkets API listening on http://${host}:${port}`);
  console.log(`Provider: ${defaultProvider}`);
  if (!apiToken) {
    console.log('No SUPERMARKET_API_TOKEN set; relying on localhost binding for access control.');
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && !apiToken) {
    console.warn('WARNING: API is not bound to localhost and has no token. Set SUPERMARKET_API_TOKEN.');
  }
});
