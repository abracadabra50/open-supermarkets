import assert from 'node:assert/strict';
import http from 'node:http';
import { getManifest } from '../src/providers/registry';

const httpServerPath = require.resolve('../src/http-server');

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function main() {
  const originalHost = process.env.SUPERMARKET_API_HOST;
  const originalToken = process.env.SUPERMARKET_API_TOKEN;
  const originalLegacyHost = process.env.GROC_API_HOST;
  const originalLegacyToken = process.env.GROC_API_TOKEN;
  try {
    process.env.SUPERMARKET_API_HOST = '0.0.0.0';
    delete process.env.SUPERMARKET_API_TOKEN;
    delete process.env.GROC_API_HOST;
    delete process.env.GROC_API_TOKEN;
    assert.throws(
      () => require(httpServerPath),
      /SUPERMARKET_API_HOST .* must be 127\.0\.0\.1, ::1, or localhost/
    );
    console.log('  ✓ HTTP server refuses every public bind');
  } finally {
    delete require.cache[httpServerPath];
    restoreEnv('SUPERMARKET_API_HOST', originalHost);
    restoreEnv('SUPERMARKET_API_TOKEN', originalToken);
    restoreEnv('GROC_API_HOST', originalLegacyHost);
    restoreEnv('GROC_API_TOKEN', originalLegacyToken);
  }
  const originalListen = http.Server.prototype.listen;
  const originalEnv = { ...process.env };
  const manifest = getManifest('tesco');
  const originalLoad = manifest.load;
  const writes: unknown[][] = [];
  let loads = 0;
  let server: http.Server | undefined;
  try {
    manifest.load = async () => {
      loads++;
      return class {
        name = 'tesco';
        async addToBasket(...args: unknown[]) { writes.push(['add', ...args]); }
        async removeFromBasket(...args: unknown[]) { writes.push(['remove', ...args]); }
        async updateBasketItem(...args: unknown[]) { writes.push(['update', ...args]); }
      } as any;
    };
    http.Server.prototype.listen = function () {
      server = this;
      return originalListen.call(this, 0, '127.0.0.1');
    } as typeof originalListen;
    for (const tokenSetting of [undefined, 'SUPERMARKET_API_TOKEN', 'GROC_API_TOKEN']) {
      delete process.env.SUPERMARKET_API_TOKEN;
      delete process.env.GROC_API_TOKEN;
      if (tokenSetting) process.env[tokenSetting] = 'security-test-token';
      delete require.cache[require.resolve('../src/http-server')];
      require('../src/http-server');
      if (!server!.listening) await new Promise<void>(resolve => server!.once('listening', resolve));
      const address = server!.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const auth = { authorization: 'Bearer security-test-token' };
      const initialLoads = loads;
      const initialWrites = writes.length;
      for (const route of ['add', 'remove', 'update']) {
        const url = `${base}/${route}?provider=tesco&id=123&qty=2&amend=1`;
        for (const method of ['GET', 'POST', 'HEAD', 'OPTIONS']) {
          for (const headers of [
            {},
            { authorization: 'Bearer wrong-token' },
            { cookie: 'authorization=Bearer security-test-token' },
            { origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
          ]) {
            const response = await fetch(url, { method, headers });
            assert.equal(response.status, 401, `${tokenSetting} ${method} ${route}`);
            assert.equal(response.headers.get('access-control-allow-origin'), null);
            await response.text();
          }
        }
        for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT']) {
          const response = await fetch(url, { method, headers: auth });
          assert.equal(response.status, tokenSetting ? 405 : 401);
          if (tokenSetting) assert.equal(response.headers.get('allow'), 'POST');
          await response.text();
        }
        if (!tokenSetting) {
          assert.equal((await fetch(url, { method: 'POST', headers: auth })).status, 401);
        }
      }
      assert.equal(loads, initialLoads, 'rejected requests must not load saved retailer authority');
      assert.equal(writes.length, initialWrites, 'rejected requests must not mutate baskets');
      if (tokenSetting) {
        for (const route of ['add', 'remove', 'update']) {
          const response = await fetch(`${base}/${route}?provider=tesco&id=123&qty=2`, {
            method: 'POST', headers: auth,
          });
          assert.equal(response.status, 200);
          assert.equal((await response.json() as any).ok, true);
        }
        assert.deepEqual(writes.slice(initialWrites), [
          ['add', '123', 2], ['remove', '123'], ['update', '123', 2],
        ]);
      }
      const health = await fetch(`${base}/health`, { headers: tokenSetting ? auth : {} });
      assert.equal(health.status, 200);
      await health.text();
      const readPost = await fetch(`${base}/basket`, { method: 'POST', headers: tokenSetting ? auth : {} });
      assert.equal(readPost.status, 405);
      await readPost.text();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      server = undefined;
    }
    console.log('  ✓ HTTP mutations require POST and explicit bearer authentication before provider loading');
  } finally {
    manifest.load = originalLoad;
    http.Server.prototype.listen = originalListen;
    for (const key of ['SUPERMARKET_API_TOKEN', 'GROC_API_TOKEN']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
