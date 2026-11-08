#!/usr/bin/env node

// Tiny wrapper for the local groc HTTP API.
// API server expected at: http://127.0.0.1:7876

const API = 'http://127.0.0.1:7876';
const [cmd, ...args] = process.argv.slice(2);

async function call(path, params = {}, method = 'GET') {
  const url = new URL(path, API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const token = process.env.SUPERMARKET_API_TOKEN || process.env.GROC_API_TOKEN;
  const res = await fetch(url, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = await res.text();

  if (!res.ok) {
    console.error(body || `HTTP ${res.status}`);
    process.exit(1);
  }

  console.log(body);
}

switch (cmd) {
  case 'search':
    await call('/search', { q: args.join(' ') });
    break;

  case 'fav-search':
    await call('/fav-search', { q: args.join(' ') });
    break;

  case 'favourites':
  case 'favorites':
    await call('/favourites');
    break;

  case 'basket':
    await call('/basket');
    break;

  case 'add':
    await call('/add', { id: args[0], qty: args[1] || 1 }, 'POST');
    break;

  case 'remove':
    await call('/remove', { id: args[0] }, 'POST');
    break;

  case 'update':
    await call('/update', { id: args[0], qty: args[1] }, 'POST');
    break;

  default:
    console.error(`Usage:
  node skills/api/wrapper.js search "milk"
  node skills/api/wrapper.js fav-search "milk"
  node skills/api/wrapper.js favourites
  node skills/api/wrapper.js basket
  node skills/api/wrapper.js add <product-id> [qty]
  node skills/api/wrapper.js remove <item-id>
  node skills/api/wrapper.js update <item-id> <qty>
`);
    process.exit(1);
}
