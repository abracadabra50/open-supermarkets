import assert from 'node:assert/strict';
import http from 'node:http';
import { ProviderFactory } from '../src/providers';

async function main() {
  const originalListen = http.Server.prototype.listen;
  const originalCreate = ProviderFactory.create;
  let server: http.Server | undefined;
  let constructions = 0;
  try {
    ProviderFactory.create = (() => {
      constructions++;
      throw new Error('Unexpected legacy construction');
    }) as typeof ProviderFactory.create;
    http.Server.prototype.listen = function () {
      server = this;
      return originalListen.call(this, 0, '127.0.0.1');
    } as typeof originalListen;
    require('../src/http-server');
    if (!server!.listening) await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server!.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    for (const path of ['/basket', '/add?id=1', '/remove?id=1', '/update?id=1&qty=2',
      '/favourites', '/favorites', '/fav-search?q=milk', '/favorite-search?q=milk']) {
      const response = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}provider=lidl-ie`);
      assert.equal(response.status, 501, path);
      const body = await response.text();
      assert.match(body, /does not support/, path);
      assert.doesNotMatch(body, /constructor|Unexpected legacy/, path);
    }
    for (const path of ['/favourites', '/fav-search?q=milk']) {
      const response = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}provider=instacart`);
      assert.equal(response.status, 501, path);
      assert.match(await response.text(), /does not support/);
    }
    const unknown = await fetch(`${base}/unknown?provider=lidl-ie`);
    assert.equal(unknown.status, 404);
    assert.equal(constructions, 0, 'unsupported routes must not construct providers');
    console.log('  ✓ HTTP unsupported operations fail before provider construction');
  } finally {
    ProviderFactory.create = originalCreate;
    http.Server.prototype.listen = originalListen;
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
