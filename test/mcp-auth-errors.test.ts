import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { AxiosError } from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getManifest } from '../src/providers/registry';
import { SainsburysProvider } from '../src/providers/sainsburys';
import { login } from '../src/auth/login';
import fs = require('node:fs');

async function main() {
  const password = 'synthetic-credential-"\\\n-only';
  const browserError = new Error(`page.fill: Timeout 100ms exceeded.\nCall log:\n  - fill(${JSON.stringify(password)})`);
  const originalLaunch = chromium.launch;
  const originalLoadSession = (SainsburysProvider.prototype as any).loadSession;
  const originalExists = fs.existsSync;
  const originalConnect = Server.prototype.connect;
  const manifest = getManifest('sainsburys');
  const originalLoad = manifest.load;
  const originalEmail = process.env.SAINSBURYS_EMAIL;
  const originalPassword = process.env.SAINSBURYS_PASSWORD;
  let closed = 0;
  let fills = 0;
  let failPasswordFill = true;
  const page = {
    goto: async () => {}, waitForTimeout: async () => {}, waitForSelector: async () => {},
    locator: () => ({ isVisible: async () => false }),
    evaluate: async () => {}, click: async () => {},
    url: () => 'https://www.sainsburys.co.uk/groceries',
    fill: async (_selector: string, value: string) => {
      fills++;
      if (failPasswordFill && value === password) throw browserError;
    },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'auth-error-regression', version: '1.0.0' });
  let server: Server | undefined;
  let connection: Promise<void> | undefined;
  let mode = 'reauth';
  try {
    (SainsburysProvider.prototype as any).loadSession = () => {};
    chromium.launch = (async () => ({
      newContext: async () => ({ newPage: async () => page }),
      close: async () => { closed++; },
    })) as unknown as typeof chromium.launch;
    // A stored session permits MCP access; avoid reading any real session.
    fs.existsSync = ((path: fs.PathLike) => String(path).endsWith('/.sainsburys/session.json') || originalExists(path)) as typeof fs.existsSync;
    process.env.SAINSBURYS_EMAIL = 'synthetic@example.invalid';
    process.env.SAINSBURYS_PASSWORD = password;
    manifest.load = async () => class extends SainsburysProvider {
      constructor() {
        super();
        (this as any).client.defaults.adapter = async (config: any) => {
          throw new AxiosError('Request failed with status code 401', undefined, config, undefined,
            { status: 401, data: {}, headers: {}, statusText: 'Unauthorized', config });
        };
      }
      async search(query: string) {
        if (mode === 'raw') throw browserError;
        if (mode === 'considered') throw new Error('A considered provider error that must remain actionable and unchanged.');
        return super.search(query);
      }
    } as any;
    Server.prototype.connect = function () {
      server = this;
      connection = originalConnect.call(this, serverTransport);
      return connection;
    };
    require('../src/mcp-server');
    await connection;
    await client.connect(clientTransport);
    const call = () => client.callTool({ name: 'grocery_search', arguments: { provider: 'sainsburys', query: 'milk' } });
    const reauth = await call();
    assert.equal(reauth.isError, true);
    assert.match(JSON.stringify(reauth.content), /authentication failed/);
    assert.doesNotMatch(JSON.stringify(reauth), /synthetic-credential|Call log|page.fill/);
    assert.equal(fills, 2, 'automatic reauthentication reaches the password fill');
    assert.equal(closed, 1, 'failed login closes the browser');
    mode = 'raw';
    const raw = await call();
    assert.equal(raw.isError, true);
    assert.match(JSON.stringify(raw.content), /Browser operation failed/);
    assert.doesNotMatch(JSON.stringify(raw), /synthetic-credential|Call log|page.fill/);
    mode = 'considered';
    assert.match(JSON.stringify((await call()).content), /A considered provider error/);
    await assert.rejects(login('synthetic@example.invalid', password, { headless: true }), (error: any) => {
      assert.match(error.message, /authentication failed/);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack, /synthetic-credential|Call log|page.fill/);
      return true;
    });
    failPasswordFill = false;
    (page as any).url = () => 'https://www.sainsburys.co.uk/gol-ui/oauth/login';
    await assert.rejects(login('synthetic@example.invalid', password, { headless: true }), (error: any) => {
      assert.match(error.message, /Login failed - still on login page/);
      assert.doesNotMatch(error.stack, /synthetic-credential|Call log|page.fill/);
      return true;
    });
    console.log('✓ automatic reauthentication and MCP errors keep browser credentials local');
  } finally {
    chromium.launch = originalLaunch;
    (SainsburysProvider.prototype as any).loadSession = originalLoadSession;
    fs.existsSync = originalExists;
    manifest.load = originalLoad;
    Server.prototype.connect = originalConnect;
    if (originalEmail === undefined) delete process.env.SAINSBURYS_EMAIL;
    else process.env.SAINSBURYS_EMAIL = originalEmail;
    if (originalPassword === undefined) delete process.env.SAINSBURYS_PASSWORD;
    else process.env.SAINSBURYS_PASSWORD = originalPassword;
    await client.close();
    await server?.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
