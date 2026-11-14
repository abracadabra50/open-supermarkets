/** A profile-bound, owner-only connection to the optional SeleniumBase worker. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { InteractionRequiredError } from '../../errors';

export const CONAD_PROTOCOL_VERSION = 1;
export type ConadAction =
  | 'hello' | 'shutdown' | 'status' | 'browser_login' | 'login' | 'store'
  | 'search_page' | 'product' | 'basket' | 'checkout_summary'
  | 'basket_add' | 'basket_update' | 'basket_remove' | 'basket_clear';

export interface ConadBrowserOptions {
  profileDir?: string;
  socketPath?: string;
  python?: string;
  executablePath?: string;
  rememberSession?: boolean;
  /** An explicit socket is supervisor-managed and is never auto-started. */
  requestTimeoutMs?: number;
}

export interface ConadTransport {
  call(action: ConadAction, args?: Record<string, unknown>): Promise<unknown>;
}

export class ConadInteractionRequiredError extends InteractionRequiredError {
  readonly statusCode = 409;
  constructor(message = 'Complete login or local-store selection in the visible Conad browser, then retry.', readonly code: string = 'CONAD_INTERACTION_REQUIRED', readonly mutation_may_have_applied = false) {
    super(message);
    this.name = 'ConadInteractionRequiredError';
  }
}

export class ConadWorkerError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: string,
    message: string,
    readonly mutation_may_have_applied = false,
  ) {
    super(message + (mutation_may_have_applied ? ' A write may have been applied; read the basket before retrying.' : ''));
    this.name = 'ConadWorkerError';
    this.statusCode = code === 'CONAD_INVALID_INPUT' ? 400 : code === 'CONAD_NOT_FOUND' ? 404 : code === 'CONAD_TIMEOUT' ? 504 : 502;
  }
}

const WRITE_ACTIONS = new Set<ConadAction>(['basket_add', 'basket_update', 'basket_remove', 'basket_clear']);
const starts = new Map<string, Promise<void>>();
const verified = new Map<string, string>();
const ERROR_CODES = new Set([
  'CONAD_INVALID_INPUT', 'CONAD_PROTOCOL_ERROR', 'CONAD_INTERACTION_REQUIRED',
  'CONAD_ACCOUNT_CHANGED', 'CONAD_CART_CHANGED', 'CONAD_UNSUPPORTED_PRODUCT',
  'CONAD_UNSUPPORTED_CART', 'CONAD_NOT_FOUND', 'CONAD_TIMEOUT', 'CONAD_BROWSER_ERROR',
  'CONAD_PROFILE_ERROR', 'CONAD_PROFILE_BUSY', 'CONAD_PROFILE_MISMATCH',
  'CONAD_DEPENDENCY_MISSING', 'CONAD_PLATFORM_UNSUPPORTED', 'CONAD_STARTUP_FAILED',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalPath(candidate: string): string {
  const absolute = path.resolve(candidate);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  return path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute));
}

function unavailable(): ConadWorkerError {
  return new ConadWorkerError('CONAD_STARTUP_FAILED', 'The configured Conad browser worker is unavailable. Check Python, SeleniumBase, Chrome, the visible desktop and the dedicated profile.');
}

export class SeleniumBaseClient implements ConadTransport {
  readonly profileDir: string;
  readonly profileKey: string;
  readonly socketPath: string;
  private readonly runtimeDir: string;
  private readonly managedExternally: boolean;
  private readonly timeout: number;

  constructor(private readonly options: ConadBrowserOptions = {}) {
    this.profileDir = canonicalPath(options.profileDir || process.env.CONAD_PROFILE_DIR || path.join(os.homedir(), '.conad', 'seleniumbase-profile'));
    this.profileKey = createHash('sha256').update(this.profileDir).digest('hex');
    this.runtimeDir = path.join(os.tmpdir(), `open-supermarkets-conad-${process.getuid?.() ?? 'user'}`);
    const external = options.socketPath || process.env.CONAD_RUNTIME_SOCKET;
    this.managedExternally = external !== undefined;
    this.socketPath = path.resolve(external || path.join(this.runtimeDir, `${this.profileKey.slice(0, 16)}.sock`));
    this.timeout = options.requestTimeoutMs ?? 120_000;
    if (!Number.isInteger(this.timeout) || this.timeout < 50 || this.timeout > 120_000) {
      throw new RangeError('Conad request timeout must be an integer between 50 and 120000 milliseconds.');
    }
    if (Buffer.byteLength(this.socketPath) > 100) {
      throw new Error('Conad Unix socket path is too long; configure a shorter private CONAD_RUNTIME_SOCKET path.');
    }
  }

  private socketIdentity(): string {
    const parent = fs.lstatSync(path.dirname(this.socketPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || (process.getuid && parent.uid !== process.getuid())) {
      throw new Error('Conad socket directory must be private, owned by this user, and have mode 0700.');
    }
    const info = fs.lstatSync(this.socketPath);
    if (!info.isSocket() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
      throw new Error('Conad browser socket must be owned by this user with mode 0600.');
    }
    return `${info.dev}:${info.ino}:${info.ctimeMs}:${this.profileKey}`;
  }

  private request(action: ConadAction, args: Record<string, unknown> = {}, timeout = this.timeout): Promise<unknown> {
    const packet = JSON.stringify({
      protocol_version: CONAD_PROTOCOL_VERSION, profile_key: this.profileKey,
      deadline_ms: Date.now() + timeout, action, args,
    }) + '\n';
    if (Buffer.byteLength(packet) > 65_536) return Promise.reject(new RangeError('Conad browser request exceeds 64 KiB.'));
    return new Promise((resolve, reject) => {
      let data = '';
      let sent = false;
      let settled = false;
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding('utf8');
      const timer = setTimeout(() => fail(new ConadWorkerError('CONAD_TIMEOUT', 'Conad browser operation timed out.', sent && WRITE_ACTIONS.has(action))), timeout + 500);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        verified.delete(this.socketPath);
        socket.destroy();
        reject(error);
      };
      socket.on('error', error => {
        if (!sent && action === 'hello' && isMissingSocket(error)) fail(error);
        else fail(new ConadWorkerError('CONAD_BROWSER_ERROR', 'Conad browser connection failed.', sent && WRITE_ACTIONS.has(action)));
      });
      socket.on('connect', () => {
        sent = true;
        socket.write(packet);
      });
      socket.on('data', chunk => {
        data += chunk;
        if (Buffer.byteLength(data) > 4_000_000) return fail(new ConadWorkerError('CONAD_PROTOCOL_ERROR', 'Conad browser response exceeded the size limit.', sent && WRITE_ACTIONS.has(action)));
        const newline = data.indexOf('\n');
        if (newline < 0) return;
        try {
          let reply: unknown;
          try { reply = JSON.parse(data.slice(0, newline)); }
          catch { throw new ConadWorkerError('CONAD_PROTOCOL_ERROR', 'Conad browser returned invalid JSON.', sent && WRITE_ACTIONS.has(action)); }
          if (!record(reply) || reply.protocol_version !== CONAD_PROTOCOL_VERSION || reply.profile_key !== this.profileKey || typeof reply.ok !== 'boolean') {
            throw new ConadWorkerError('CONAD_PROFILE_MISMATCH', 'Conad browser protocol/profile does not match the configured client.', sent && WRITE_ACTIONS.has(action));
          }
          if (reply.ok === false) {
            const error = reply.error;
            if (!record(error) || typeof error.code !== 'string' || !ERROR_CODES.has(error.code) || typeof error.message !== 'string' || error.message.length > 1000 || typeof error.mutation_may_have_applied !== 'boolean') {
              throw new ConadWorkerError('CONAD_PROTOCOL_ERROR', 'Conad browser returned a malformed error response.', WRITE_ACTIONS.has(action));
            }
            const message = error.message + (error.mutation_may_have_applied ? ' A write may have been applied; read the basket before retrying.' : '');
            if (error.code === 'CONAD_INTERACTION_REQUIRED' || error.code === 'CONAD_ACCOUNT_CHANGED') {
              throw new ConadInteractionRequiredError(message, error.code, error.mutation_may_have_applied);
            }
            throw new ConadWorkerError(error.code, error.message, error.mutation_may_have_applied);
          }
          if (!Object.prototype.hasOwnProperty.call(reply, 'data')) {
            throw new ConadWorkerError('CONAD_PROTOCOL_ERROR', 'Conad browser response is missing data.', sent && WRITE_ACTIONS.has(action));
          }
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(reply.data);
        } catch (error) {
          fail(error instanceof Error ? error : new ConadWorkerError('CONAD_PROTOCOL_ERROR', 'Conad browser returned invalid JSON.'));
        }
      });
      socket.on('end', () => fail(new ConadWorkerError('CONAD_BROWSER_ERROR', 'Conad browser closed without a complete response.', sent && WRITE_ACTIONS.has(action))));
      socket.on('close', () => {
        if (!settled) fail(new ConadWorkerError('CONAD_BROWSER_ERROR', 'Conad browser disconnected.', sent && WRITE_ACTIONS.has(action)));
      });
    });
  }

  private async probe(): Promise<void> {
    const identity = this.socketIdentity();
    if (verified.get(this.socketPath) === identity) return;
    const reply = await this.request('hello', {}, Math.min(this.timeout, 10_000));
    if (!record(reply) || reply.engine !== 'seleniumbase' || !Number.isSafeInteger(reply.pid)) {
      throw new ConadWorkerError('CONAD_PROTOCOL_ERROR', 'Conad browser handshake was invalid.');
    }
    verified.set(this.socketPath, this.socketIdentity());
  }

  private async start(): Promise<void> {
    if (process.platform === 'win32') throw new Error('Conad SeleniumBase currently requires Linux/macOS Unix sockets.');
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(this.runtimeDir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
      throw new Error('Conad runtime directory must be private and owned by this user.');
    }
    const args = [
      '-u', path.resolve(__dirname, '../../../runtime/conad/worker.py'),
      '--profile', this.profileDir, '--reuse-profile', '--socket', this.socketPath,
    ];
    const binary = this.options.executablePath || process.env.CONAD_BROWSER_EXECUTABLE;
    if (binary) args.push('--binary', binary);
    const child = spawn(this.options.python || process.env.CONAD_PYTHON || 'python3', args, {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, CONAD_REMEMBER_SESSION: String(this.options.rememberSession ?? process.env.CONAD_REMEMBER_SESSION !== 'false') },
    });
    child.unref();
    let launchError: Error | undefined;
    let announcedReady = false;
    let output = '';
    child.on('error', () => { launchError = unavailable(); });
    child.stdout.on('data', chunk => {
      output = (output + chunk.toString('utf8')).slice(-16_384);
      for (const line of output.split('\n').slice(0, -1)) {
        try {
          const event: unknown = JSON.parse(line);
          if (record(event) && event.event === 'ready') {
            if (event.protocol_version === CONAD_PROTOCOL_VERSION && event.profile_key === this.profileKey) announcedReady = true;
            else launchError = new ConadWorkerError('CONAD_PROFILE_MISMATCH', 'Conad worker startup metadata did not match this profile.');
          }
          if (record(event) && event.event === 'error' && typeof event.code === 'string' && ERROR_CODES.has(event.code) && typeof event.message === 'string' && event.message.length <= 1000) {
            launchError = new ConadWorkerError(event.code, event.message);
          }
        } catch { /* Only our worker's bounded JSON events are considered. */ }
      }
      output = output.slice(output.lastIndexOf('\n') + 1);
    });
    let ready = false;
    try {
      const until = Date.now() + 90_000;
      while (Date.now() < until) {
        if (announcedReady) {
          verified.set(this.socketPath, this.socketIdentity());
          ready = true;
          return;
        }
        if (launchError || child.exitCode !== null) {
          // A competing starter can win the profile lock. Attach only after
          // verifying its protocol/profile; no shopping action has been sent.
          try { await this.probe(); ready = true; return; }
          catch (error: unknown) { if (!isMissingSocket(error)) throw error; }
          throw launchError || unavailable();
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw unavailable();
    } finally {
      child.stdout.destroy();
      if (!ready && child.exitCode === null) child.kill('SIGTERM');
    }
  }

  async call(action: ConadAction, args: Record<string, unknown> = {}): Promise<unknown> {
    try { await this.probe(); }
    catch (error: unknown) {
      if (!isMissingSocket(error)) throw error;
      if (this.managedExternally || action === 'shutdown') throw unavailable();
      let starting = starts.get(this.socketPath);
      if (!starting) {
        starting = this.start().finally(() => starts.delete(this.socketPath));
        starts.set(this.socketPath, starting);
      }
      await starting;
    }
    // Never replay an operation after sending it, including on transport error.
    return this.request(action, args);
  }
}

function isMissingSocket(error: unknown): boolean {
  return error instanceof Error && ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '');
}
