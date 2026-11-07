import assert from 'node:assert/strict';

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
      /SUPERMARKET_API_TOKEN is required when SUPERMARKET_API_HOST is not a loopback address/
    );
    console.log('  ✓ HTTP server refuses a public bind without an API token');
  } finally {
    delete require.cache[httpServerPath];
    restoreEnv('SUPERMARKET_API_HOST', originalHost);
    restoreEnv('SUPERMARKET_API_TOKEN', originalToken);
    restoreEnv('GROC_API_HOST', originalLegacyHost);
    restoreEnv('GROC_API_TOKEN', originalLegacyToken);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
