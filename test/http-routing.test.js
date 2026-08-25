'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../dist/http-server.js');
const { ProviderInputError } = require('../dist/providers/ie/shared.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
}

async function main() {
  let resolverCalls = 0;
  const searchProvider = {
    name: 'ah',
    async search(query, options) {
      resolverCalls += 1;
      return [{ product_uid: 'fixture-1', name: query, retail_price: { price: 1 }, in_stock: true, provider: 'ah', limit: options.limit }];
    },
  };

  const server = createServer({
    apiToken: null,
    resolveProvider: () => searchProvider,
  });
  const port = await listen(server);
  try {
    const search = await request(port, '/search?provider=ah&q=milk');
    assert.equal(search.status, 200);
    assert.equal(search.body.products[0].name, 'milk');
    assert.equal(resolverCalls, 1, 'search should call only the injected provider');

    const whitespaceSearch = await request(port, '/search?provider=ah&q=%20%20');
    assert.equal(whitespaceSearch.status, 400);
    assert.match(whitespaceSearch.body.error, /missing query parameter: q/i);
    assert.equal(resolverCalls, 1, 'whitespace-only search must fail before provider work');

    const health = await request(port, '/health?provider=ah');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.endpoints, ['/search?q=']);

    const basket = await request(port, '/basket?provider=ah');
    assert.equal(basket.status, 501);
    assert.match(basket.body.error, /ah.*does not support.*basket/i);
    assert.doesNotMatch(basket.body.error, /TypeError/);

    for (const path of ['/add?provider=ah&id=item-1', '/remove?provider=ah&id=item-1', '/update?provider=ah&id=item-1&qty=2']) {
      const response = await request(port, path);
      assert.equal(response.status, 501, path);
      assert.match(response.body.error, /does not support.*basket/i, path);
    }

    const storesUnsupported = await request(port, '/stores?provider=ah');
    assert.equal(storesUnsupported.status, 501);
    assert.match(storesUnsupported.body.error, /ah.*does not support.*stores/i);
  } finally {
    await close(server);
  }

  const storeEvents = [];
  const storeProvider = {
    name: 'dunnes-ie',
    async listStores(options) {
      storeEvents.push({ type: 'listStores', options });
      if (options.fullTextSearch === 'invalid-combination') {
        throw new ProviderInputError('fullTextSearch cannot be combined with coordinates');
      }
      return [{ store_id: '258', name: 'Dublin fixture', postcode: 'D02' }];
    },
    async selectStore(storeId) {
      storeEvents.push({ type: 'selectStore', storeId });
      if (storeId !== '258') throw new ProviderInputError(`store ${storeId} not found`);
    },
    async search(query) {
      storeEvents.push({ type: 'search', query });
      return [{ product_uid: 'selected-store-fixture', name: `${query} in store 258`, retail_price: { price: 2 }, in_stock: true, provider: 'dunnes-ie' }];
    },
  };
  const storeServer = createServer({
    apiToken: null,
    resolveProvider: () => storeProvider,
  });
  const storePort = await listen(storeServer);
  try {
    const stores = await request(storePort, '/stores?provider=dunnes-ie&query=dublin&postcode=D02&latitude=53.3&longitude=-6.2&range=12&mode=delivery&limit=4');
    assert.equal(stores.status, 200);
    assert.equal(stores.body.stores[0].store_id, '258');
    assert.deepEqual(storeEvents[0], {
      type: 'listStores',
      options: {
        limit: 4,
        fullTextSearch: 'dublin',
        postcode: 'D02',
        latitude: 53.3,
        longitude: -6.2,
        range: 12,
        shoppingMode: 'delivery',
      },
    });

    const selectedSearch = await request(storePort, '/search?provider=dunnes-ie&store_id=258&q=milk');
    assert.equal(selectedSearch.status, 200);
    assert.equal(selectedSearch.body.products[0].name, 'milk in store 258');
    assert.deepEqual(storeEvents.slice(1).map((entry) => entry.type), ['selectStore', 'search']);

    const invalidSelection = await request(storePort, '/search?provider=dunnes-ie&store_id=999&q=milk');
    assert.equal(invalidSelection.status, 400);
    assert.match(invalidSelection.body.error, /invalid store_id.*999.*not found/i);
    assert.equal(storeEvents.at(-1).type, 'selectStore');

    const incompleteCoordinates = await request(storePort, '/stores?provider=dunnes-ie&latitude=53.3');
    assert.equal(incompleteCoordinates.status, 400);
    assert.match(incompleteCoordinates.body.error, /latitude and longitude.*together/i);

    const providerSpecificValidation = await request(
      storePort,
      '/stores?provider=dunnes-ie&query=invalid-combination&latitude=53.3&longitude=-6.2'
    );
    assert.equal(providerSpecificValidation.status, 400);
    assert.match(providerSpecificValidation.body.error, /fullTextSearch cannot be combined/i);
  } finally {
    await close(storeServer);
  }

  const selectionFailureServer = createServer({
    apiToken: null,
    resolveProvider: () => ({
      name: 'dunnes-ie',
      async listStores() { return []; },
      async selectStore() {
        throw Object.assign(new Error('upstream connection reset'), {
          name: 'ProviderInputError',
          statusCode: 400,
        });
      },
      async search() { return []; },
    }),
  });
  const selectionFailurePort = await listen(selectionFailureServer);
  try {
    const response = await request(
      selectionFailurePort,
      '/search?provider=dunnes-ie&store_id=258&q=milk'
    );
    assert.equal(response.status, 500);
  } finally {
    await close(selectionFailureServer);
  }

  const discoveryFailureServer = createServer({
    apiToken: null,
    resolveProvider: () => ({
      name: 'dunnes-ie',
      async listStores() {
        throw Object.assign(new Error('upstream connection reset'), {
          name: 'ProviderInputError',
          statusCode: 400,
        });
      },
      async selectStore() {},
      async search() { return []; },
    }),
  });
  const discoveryFailurePort = await listen(discoveryFailureServer);
  try {
    const response = await request(discoveryFailurePort, '/stores?provider=dunnes-ie');
    assert.equal(response.status, 500);
  } finally {
    await close(discoveryFailureServer);
  }

  const requiredStoreServer = createServer({ apiToken: null });
  const requiredStorePort = await listen(requiredStoreServer);
  try {
    const health = await request(requiredStorePort, '/health?provider=aldi-ie');
    assert.deepEqual(health.body.endpoints, [
      '/search?q=&store_id=',
      '/stores?query=&postcode=&latitude=&longitude=&range=&mode=&limit=',
    ]);
    for (const provider of ['aldi-ie', 'dunnes-ie', 'supervalu-ie']) {
      const response = await request(
        requiredStorePort,
        `/search?provider=${provider}&q=milk`
      );
      assert.equal(response.status, 400, provider);
      assert.match(response.body.error, /store/i, provider);
    }
  } finally {
    await close(requiredStoreServer);
  }

  const internalRangeServer = createServer({
    apiToken: null,
    resolveProvider: () => ({
      name: 'ah',
      async search() { throw new RangeError('internal array size failure'); },
    }),
  });
  const internalRangePort = await listen(internalRangeServer);
  try {
    const response = await request(internalRangePort, '/search?provider=ah&q=milk');
    assert.equal(response.status, 500);
  } finally {
    await close(internalRangeServer);
  }

  const missingMethodProvider = {
    name: 'sainsburys',
    async search() { return []; },
  };
  const missingMethodServer = createServer({
    apiToken: null,
    resolveProvider: () => missingMethodProvider,
  });
  const missingMethodPort = await listen(missingMethodServer);
  try {
    const response = await request(missingMethodPort, '/basket?provider=sainsburys');
    assert.equal(response.status, 501);
    assert.match(response.body.error, /declares.*basket.*does not implement.*getBasket/i);
    assert.doesNotMatch(response.body.error, /TypeError/);
  } finally {
    await close(missingMethodServer);
  }

  const authServer = createServer({
    apiToken: 'fixture-token',
    resolveProvider: () => searchProvider,
  });
  const authPort = await listen(authServer);
  try {
    assert.equal((await request(authPort, '/health')).status, 401);
    const health = await request(authPort, '/health', { authorization: 'Bearer fixture-token' });
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.endpoints, ['/search?q=']);
  } finally {
    await close(authServer);
  }
}

main().then(() => {
  console.log('http routing tests: all passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
