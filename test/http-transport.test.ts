import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

const tsx = require.resolve('tsx/cli');
const baseEnv = { ...process.env };
for (const key of ['SUPERMARKET_API_HOST', 'GROC_API_HOST', 'SUPERMARKET_API_PORT',
  'GROC_API_PORT', 'SUPERMARKET_API_TOKEN', 'GROC_API_TOKEN']) delete baseEnv[key];

// Exercise startup in isolated processes, including both environment namespaces.
for (const prefix of ['SUPERMARKET', 'GROC']) {
  for (const token of ['', 'synthetic-test-token']) {
    for (const host of ['0.0.0.0', '::', '192.0.2.1', 'example.com', '127.0.0.1.example.com']) {
      const result = spawnSync(process.execPath, [tsx, '--eval', `
        const http = require('node:http');
        http.Server.prototype.listen = () => { throw new Error('UNSAFE_LISTEN'); };
        require('./src/http-server');
      `], { env: { ...baseEnv, [`${prefix}_API_HOST`]: host, [`${prefix}_API_TOKEN`]: token }, encoding: 'utf8' });
      assert.equal(result.status, 1, `${prefix}: ${host}`);
      assert.match(result.stderr, /must be 127\.0\.0\.1, ::1, or localhost/);
      assert.doesNotMatch(result.stderr, /Error: UNSAFE_LISTEN/);
    }
  }
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    const expected = host === 'localhost' ? '127.0.0.1' : host;
    const result = spawnSync(process.execPath, [tsx, '--eval', `
      const assert = require('node:assert/strict');
      const http = require('node:http');
      let called = false;
      http.Server.prototype.listen = function (port, host) {
        assert.equal(host, ${JSON.stringify(expected)});
        called = true;
        return this;
      };
      require('./src/http-server');
      assert.ok(called);
    `], { env: { ...baseEnv, [`${prefix}_API_HOST`]: host }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}

async function main() {
  const originalListen = http.Server.prototype.listen;
  let server: http.Server | undefined;
  process.env.SUPERMARKET_API_HOST = 'localhost';
  process.env.SUPERMARKET_API_TOKEN = 'synthetic-test-token';
  try {
    http.Server.prototype.listen = function () {
      server = this;
      return originalListen.call(this, 0, '127.0.0.1');
    } as typeof originalListen;
    require('../src/http-server');
    if (!server!.listening) await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server!.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/health`;
    for (const authorization of ['', 'Bearer wrong', 'Bearer synthetic-test-token']) {
      const response = await fetch(url, { headers: { authorization } });
      assert.equal(response.status, authorization === 'Bearer synthetic-test-token' ? 200 : 401);
      await response.text();
    }
    console.log('  ✓ HTTP is loopback-only; bearer authentication still enforced');
  } finally {
    http.Server.prototype.listen = originalListen;
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
