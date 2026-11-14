import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  ConadInteractionRequiredError, ConadWorkerError, SeleniumBaseClient,
} from '../src/providers/conad/seleniumbase';

async function waitUntil(check: () => boolean): Promise<void> {
  const until = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < until, 'local worker did not stop');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function protocolTest(root: string): Promise<void> {
  const socketPath = path.join(root, 'test.sock');
  const client = new SeleniumBaseClient({ socketPath, profileDir: path.join(root, 'profile') });
  const calls: string[] = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.split('\n')[0]);
      calls.push(request.action);
      if (request.action === 'product') {
        socket.end('synthetic-private-password: this is not JSON\n');
        return;
      }
      if (request.action === 'basket_clear') {
        socket.end(JSON.stringify({ protocol_version: 1, profile_key: client.profileKey, ok: true }) + '\n');
        return;
      }
      const reply = request.action === 'login'
        ? { ok: false, error: { code: 'CONAD_INTERACTION_REQUIRED', message: 'Complete login in the visible browser.', mutation_may_have_applied: false } }
        : { ok: true, data: request.action === 'hello' ? { engine: 'seleniumbase', pid: 1 } : { name: 'Caffè — qualità' } };
      const bytes = Buffer.from(JSON.stringify({ protocol_version: 1, profile_key: client.profileKey, ...reply }) + '\n');
      const split = bytes.indexOf(Buffer.from('è')) + 1;
      socket.write(bytes.subarray(0, split));
      setImmediate(() => socket.end(bytes.subarray(split)));
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    fs.chmodSync(socketPath, 0o600);
    assert.deepEqual(await client.call('status'), { name: 'Caffè — qualità' });
    await assert.rejects(() => client.call('login'), ConadInteractionRequiredError);
    await assert.rejects(() => client.call('product'), error => {
      assert.ok(error instanceof ConadWorkerError);
      assert.equal(error.code, 'CONAD_PROTOCOL_ERROR');
      assert.doesNotMatch(error.message, /synthetic-private-password/);
      return true;
    });
    await assert.rejects(() => client.call('basket_clear'), error => {
      assert.ok(error instanceof ConadWorkerError);
      assert.equal(error.mutation_may_have_applied, true);
      return true;
    });
    assert.equal(calls.filter(action => action === 'basket_clear').length, 1);
    const other = new SeleniumBaseClient({ socketPath, profileDir: path.join(root, 'other-account') });
    await assert.rejects(() => other.call('basket_add', { product_id: '100001', quantity: 1 }), /profile/);
    assert.ok(!calls.includes('basket_add'), 'wrong-profile client sent a mutation before its handshake');
    fs.chmodSync(socketPath, 0o666);
    await assert.rejects(() => client.call('status'), /0600/);
    const missing = new SeleniumBaseClient({ socketPath: path.join(root, 'missing.sock') });
    await assert.rejects(() => missing.call('status'), /unavailable/);
    console.log('  ✓ IPC preserves UTF-8, enforces profile/permissions and redacts malformed replies');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function lifecycleTest(root: string): Promise<void> {
  const python = path.join(root, 'fake-python');
  fs.copyFileSync(path.join(__dirname, 'fixtures/conad_fake_worker.py'), python);
  fs.chmodSync(python, 0o700);
  const profileDir = path.join(root, 'autostart');
  const options = { profileDir, python };
  const clients = Array.from({ length: 3 }, () => new SeleniumBaseClient(options));
  const client = clients[0];
  try {
    await Promise.all(clients.map(c => c.call('status')));
    assert.equal(fs.readFileSync(path.join(profileDir, 'launch-count'), 'utf8'), '1');
    await assert.rejects(() => client.call('basket_add', { product_id: '100001', quantity: 1 }), error => {
      assert.ok(error instanceof ConadWorkerError);
      assert.equal(error.mutation_may_have_applied, true);
      return true;
    });
    const status = await client.call('status') as { writes: number };
    assert.equal(status.writes, 1, 'a transport failure replayed the write');
    const short = new SeleniumBaseClient({ ...options, requestTimeoutMs: 50 });
    const start = Date.now();
    await assert.rejects(() => short.call('product'), /timed out/);
    assert.ok(Date.now() - start < 2000, 'dribbled bytes reset the absolute timeout');
    console.log('  ✓ one cold worker serves concurrent callers; uncertain writes are not replayed; deadlines are absolute');
  } finally {
    try { await client.call('shutdown'); } catch { /* A failed startup has already terminated its child. */ }
    await waitUntil(() => !fs.existsSync(client.socketPath));
  }
}

async function main() {
  if (process.platform === 'win32') {
    console.log('  ○ Conad requires Unix sockets');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conad-ipc-'));
  const previous = process.env.CONAD_RUNTIME_SOCKET;
  delete process.env.CONAD_RUNTIME_SOCKET;
  try {
    await protocolTest(root);
    await lifecycleTest(root);
  } finally {
    if (previous !== undefined) process.env.CONAD_RUNTIME_SOCKET = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
