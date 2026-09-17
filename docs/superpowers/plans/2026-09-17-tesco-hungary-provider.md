# Tesco Hungary Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tesco-hu` provider to Open Supermarkets that searches the Hungarian Tesco catalogue anonymously and has basket operations wired for an imported browser session.

**Architecture:** A self-contained provider under `src/providers/tesco-hu/` made of three files: a GraphQL client for `https://xapi.tesco.com/` sent with Hungarian region headers, a cookie-session store at `~/.tesco-hu/session.json`, and the `GroceryProvider` implementation that normalises products and basket items. It is registered in the manifest with `capabilities: ['search']` only; basket becomes a declared capability in the last task, after a live round-trip.

**Tech Stack:** TypeScript (strict, CommonJS), axios, Node 18+, plain `tsx` test scripts with `node:assert` (the repo's existing style — no test framework).

**Spec:** `docs/superpowers/specs/2026-09-17-tesco-hungary-provider-design.md`

## Global Constraints

- No new npm dependencies. axios is already present.
- `src/providers/tesco-hu/**` must never import Playwright or anything from `src/providers/tesco/` (that module loads Playwright at import time).
- Currency is always `'HUF'`; prices are integer forints from `price.actual`.
- Declare only verified capabilities: the manifest says `['search']` until Task 10 proves basket live.
- Errors are never turned into empty results. Auth failures raise a message naming `supermarket --provider tesco-hu import-session`.
- Never commit cookies, credentials or real basket contents. Fixture ids are public catalogue ids (e.g. `205406742`, "Banán lédig").
- Every task ends with `npm run typecheck` and `npm test` passing.
- Headers on every xapi request: `x-apikey: TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA`, `region: HU`, `language: hu-HU`, `accept-language: hu-HU`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/format.ts` (modify) | Add `HUF` symbol and zero-decimal suffix rendering ("126 Ft"). |
| `src/providers/tesco-hu/session.ts` (create) | Cookie session file: parse Cookie header / cookie JSON exports, infer expiry, save/load/clear/info. Pure Node, no network. |
| `src/providers/tesco-hu/api.ts` (create) | axios GraphQL client for xapi with HU headers; operations `search`, `getProduct`, `getCategories`, `getBasket`, `updateBasket`; error translation. |
| `src/providers/tesco-hu/index.ts` (create) | `TescoHuProvider implements GroceryProvider`; normalisation; basket orchestration. |
| `src/providers/registry.ts` (modify) | Manifest entry `tesco-hu`. |
| `src/providers/index.ts` (modify) | `ProviderFactory.create` case. |
| `src/mcp-server.ts` (modify) | Provider list, session path, anonymous search. |
| `src/cli.ts` (modify) | `status` session info and `import-session` for `tesco-hu`. |
| `src/errors.ts` (modify) | import-session hint for `tesco-hu`. |
| `test/tesco-hu.test.ts` (create) | Offline tests for all of the above. |
| `test/lazy-loading.test.ts` (modify) | HU country assertion. |
| `package.json` (modify) | Wire the new test file into `npm test`. |
| `skills/tesco-hu.md`, `README.md`, `SKILL.md`, `docs/providers/evaluated.md` (modify/create) | Documentation. |

---

### Task 1: Baseline and forint formatting

**Files:**
- Modify: `src/format.ts`
- Modify: `package.json` (the `test` script)
- Create: `test/tesco-hu.test.ts`

**Interfaces:**
- Produces: `money(amount: number, currency?: string): string` renders `HUF` as `"126 Ft"` (rounded, no decimals, symbol after a space). All other currencies unchanged.

- [ ] **Step 1: Install and run the baseline**

Run:
```bash
cd /Users/balazsbenedek/development/tesco/open-supermarkets && npm ci && npm run typecheck && npm test
```
Expected: install succeeds, typecheck clean, both existing test scripts print only `✓` lines and exit 0. If anything fails here, stop: the baseline must be green before touching code.

- [ ] **Step 2: Create the test file with the harness and the money tests**

Create `test/tesco-hu.test.ts`:

```ts
/**
 * Tesco Hungary provider — offline tests.
 *
 * Everything here runs without network or credentials. Fixtures are copied from
 * live xapi.tesco.com responses (region HU) captured on 2026-09-17; ids are public
 * catalogue ids.
 *
 * Run: npx tsx test/tesco-hu.test.ts
 */

import assert from 'node:assert';
import { money, sym } from '../src/format';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

async function main() {
  console.log('format: forint');

  await check('HUF renders as whole forints with a trailing symbol', () => {
    assert.strictEqual(money(126, 'HUF'), '126 Ft');
    assert.strictEqual(money(1234.6, 'HUF'), '1235 Ft');
    assert.strictEqual(sym('HUF'), 'Ft');
  });

  await check('other currencies are unchanged', () => {
    assert.strictEqual(money(1.5, 'GBP'), '£1.50');
    assert.strictEqual(money(1.5), '£1.50');
    assert.strictEqual(money(12, 'BRL'), 'BRL 12.00');
  });

  process.exit(failures ? 1 : 0);
}

main();
```

- [ ] **Step 3: Run it to see the forint test fail**

Run: `npx tsx test/tesco-hu.test.ts`
Expected: `✗ HUF renders as whole forints...` (currently prints `HUF 126.00`), `✓ other currencies are unchanged`, exit code 1.

- [ ] **Step 4: Implement forint formatting**

In `src/format.ts`, add `HUF` to the symbol table and a zero-decimal suffix rule:

```ts
const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
  CAD: 'CA$',
  AUD: 'A$',
  PLN: 'zł',
  SEK: 'kr',
  CHF: 'CHF ',
  HUF: 'Ft',
};

/**
 * Currencies conventionally written as a whole number followed by the symbol,
 * e.g. "126 Ft". Forint has no sub-unit in use, so "Ft126.00" reads as wrong to
 * anyone who has shopped in Hungary.
 */
const WHOLE_NUMBER_SUFFIX = new Set(['HUF']);
```

Replace `money` with:

```ts
/** Format an amount as a price: two decimals, correct symbol. */
export function money(amount: number, currency?: string): string {
  const code = currency ?? 'GBP';
  const value = Number(amount ?? 0);
  if (WHOLE_NUMBER_SUFFIX.has(code)) {
    return `${Math.round(value)} ${sym(code)}`;
  }
  return `${sym(code)}${value.toFixed(2)}`;
}
```

- [ ] **Step 5: Wire the test into `npm test`**

In `package.json`, change the `test` script to:

```json
"test": "tsx test/lazy-loading.test.ts && tsx test/sainsburys-favourites.test.ts && tsx test/tesco-hu.test.ts",
```

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: all `✓`, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/format.ts package.json test/tesco-hu.test.ts
git commit -m "feat(format): render forint as whole numbers with a trailing Ft

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Cookie session store

**Files:**
- Create: `src/providers/tesco-hu/session.ts`
- Modify: `test/tesco-hu.test.ts`

**Interfaces:**
- Produces (all exported from `src/providers/tesco-hu/session.ts`):
  - `SESSION_FILE: string` — `~/.tesco-hu/session.json`
  - `interface SessionCookie { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: string }`
  - `interface TescoHuSession { cookies: SessionCookie[]; expiresAt: string; lastLogin: string }`
  - `interface TescoHuSessionInfo { exists: boolean; path: string; expired: boolean; expiresAt?: string; lastLogin?: string; cookieCount?: number }`
  - `parseCookieHeader(header: string): SessionCookie[]` — throws on no cookies
  - `normaliseCookieExport(raw: unknown): SessionCookie[]` — throws on no usable cookies
  - `inferSessionExpiry(cookies: Array<{ name?: string; expires?: number; expirationDate?: number }>, now?: number): string` — ISO string
  - `saveSession(session: TescoHuSession, file?: string): void`
  - `loadSession(file?: string): TescoHuSession | null` — null when missing or expired
  - `getSessionInfo(file?: string): TescoHuSessionInfo`
  - `clearSession(file?: string): void`
  - `getCookieString(session: TescoHuSession): string`
  - `importSessionFromHeader(header: string, file?: string): TescoHuSession`
  - `importSession(filePath: string, file?: string): TescoHuSession`

- [ ] **Step 1: Add failing session tests**

In `test/tesco-hu.test.ts`, add the import at the top:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseCookieHeader,
  normaliseCookieExport,
  inferSessionExpiry,
  saveSession,
  loadSession,
  getSessionInfo,
  clearSession,
  getCookieString,
  importSessionFromHeader,
} from '../src/providers/tesco-hu/session';
```

And inside `main()`, before `process.exit`, add:

```ts
  console.log('\nsession store');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tesco-hu-test-'));
  const tmpFile = path.join(tmpDir, 'session.json');

  await check('parseCookieHeader tolerates the header name and keeps = inside values', () => {
    const cookies = parseCookieHeader('Cookie: a=1; token=abc=def; empty');
    assert.deepStrictEqual(cookies.map(c => [c.name, c.value]), [['a', '1'], ['token', 'abc=def']]);
    assert.strictEqual(cookies[0].domain, '.tesco.hu');
  });

  await check('parseCookieHeader rejects an empty header', () => {
    assert.throws(() => parseCookieHeader('   '), /No cookies parsed/);
  });

  await check('normaliseCookieExport accepts array, {cookies}, object-of-arrays and Capitalised keys', () => {
    const fromArray = normaliseCookieExport([{ name: 'a', value: '1' }]);
    assert.strictEqual(fromArray.length, 1);
    const fromWrapped = normaliseCookieExport({ cookies: [{ Name: 'b', Value: '2', Domain: 'www.tesco.hu' }] });
    assert.deepStrictEqual([fromWrapped[0].name, fromWrapped[0].value, fromWrapped[0].domain], ['b', '2', 'www.tesco.hu']);
    const fromMap = normaliseCookieExport({ 'tesco.hu': [{ name: 'c', value: '3' }], 'x.hu': [{ name: 'd', value: '4' }] });
    assert.strictEqual(fromMap.length, 2);
    assert.throws(() => normaliseCookieExport([{ name: 'no-value' }]), /No usable cookies/);
  });

  await check('inferSessionExpiry uses the earliest auth cookie expiry, else 12h', () => {
    const now = Date.UTC(2026, 8, 17, 12, 0, 0);
    const inSeconds = Math.floor(now / 1000) + 3600;      // 1h, seconds
    const inMillis = now + 7200 * 1000;                     // 2h, milliseconds
    const expiry = inferSessionExpiry(
      [
        { name: 'tracking', expires: Math.floor(now / 1000) + 60 },   // not an auth cookie
        { name: 'access_token', expires: inMillis },
        { name: 'OAuth.Refresh', expires: inSeconds },
      ],
      now
    );
    assert.strictEqual(expiry, new Date(inSeconds * 1000).toISOString());
    assert.strictEqual(
      inferSessionExpiry([{ name: 'x', expires: -1 }], now),
      new Date(now + 12 * 60 * 60 * 1000).toISOString()
    );
  });

  await check('saveSession/loadSession round-trip and getCookieString joins pairs', () => {
    const session = importSessionFromHeader('a=1; b=2', tmpFile);
    assert.strictEqual(fs.existsSync(tmpFile), true);
    const loaded = loadSession(tmpFile);
    assert.ok(loaded);
    assert.strictEqual(getCookieString(loaded!), 'a=1; b=2');
    const info = getSessionInfo(tmpFile);
    assert.deepStrictEqual([info.exists, info.expired, info.cookieCount], [true, false, 2]);
  });

  await check('loadSession returns null for an expired session and clearSession removes the file', () => {
    saveSession(
      { cookies: [{ name: 'a', value: '1', domain: '.tesco.hu', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }],
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        lastLogin: new Date().toISOString() },
      tmpFile
    );
    assert.strictEqual(loadSession(tmpFile), null);
    assert.strictEqual(getSessionInfo(tmpFile).expired, true);
    clearSession(tmpFile);
    assert.strictEqual(fs.existsSync(tmpFile), false);
    assert.strictEqual(getSessionInfo(tmpFile).exists, false);
  });
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `npx tsx test/tesco-hu.test.ts`
Expected: fails at compile/import time with `Cannot find module '../src/providers/tesco-hu/session'`.

- [ ] **Step 3: Implement the session store**

Create `src/providers/tesco-hu/session.ts`:

```ts
/**
 * Tesco Hungary — cookie session store.
 *
 * bevasarlas.tesco.hu sits behind Akamai and its login lives on www.tesco.hu, so
 * there is no scripted login here. The user signs in with a normal browser and
 * imports the resulting cookies — either a raw `Cookie:` request header copied
 * from DevTools → Network (the one route that always works and includes HttpOnly
 * cookies), or a cookie JSON export from Chrome DevTools / Cookie-Editor /
 * Playwright.
 *
 * Stored at ~/.tesco-hu/session.json. Deliberately a different file from the UK
 * provider's ~/.tesco/session.json so the two never overwrite each other.
 *
 * This module has no network code and imports nothing from ../tesco/ (that module
 * loads Playwright at import time).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const CONFIG_DIR = path.join(os.homedir(), '.tesco-hu');
export const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_DOMAIN = '.tesco.hu';
const AUTH_COOKIE_RE = /(auth|oauth|token|session|sid|sso|identity|access|refresh|jwt|tesco)/i;

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds, or -1 when unknown. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface TescoHuSession {
  cookies: SessionCookie[];
  expiresAt: string;
  lastLogin: string;
}

export interface TescoHuSessionInfo {
  exists: boolean;
  path: string;
  expired: boolean;
  expiresAt?: string;
  lastLogin?: string;
  cookieCount?: number;
}

function cookieExpiryMs(cookie: { expires?: unknown; expirationDate?: unknown }): number | null {
  const raw = cookie?.expires ?? cookie?.expirationDate;
  if (raw === undefined || raw === null || raw === -1 || raw === 0) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // Playwright and Chrome exports use seconds; tolerate millisecond exports too.
  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}

/**
 * Earliest expiry among auth-looking cookies that is at least a minute away;
 * otherwise a 12 hour fallback. `now` is injectable for tests.
 */
export function inferSessionExpiry(
  cookies: Array<{ name?: string; expires?: number; expirationDate?: number }>,
  now: number = Date.now(),
  fallbackMs: number = DEFAULT_SESSION_TTL_MS
): string {
  const authExpiries = cookies
    .filter(c => AUTH_COOKIE_RE.test(String(c?.name || '')))
    .map(cookieExpiryMs)
    .filter((e): e is number => !!e && e > now + 60_000)
    .sort((a, b) => a - b);
  if (authExpiries.length > 0) return new Date(authExpiries[0]).toISOString();
  return new Date(now + fallbackMs).toISOString();
}

/** Parse a raw `Cookie:` request header. Values legitimately contain '='. */
export function parseCookieHeader(header: string): SessionCookie[] {
  const cleaned = String(header ?? '')
    .trim()
    .replace(/^Cookie:\s*/i, '')
    .replace(/^["']|["']$/g, '');

  const cookies = cleaned
    .split(';')
    .map(pair => pair.trim())
    .filter(Boolean)
    .map((pair): SessionCookie | null => {
      const eq = pair.indexOf('=');
      if (eq === -1) return null;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name || !value) return null;
      return { name, value, domain: COOKIE_DOMAIN, path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' };
    })
    .filter((c): c is SessionCookie => c !== null);

  if (cookies.length === 0) {
    throw new Error(
      'No cookies parsed from that header.\n' +
        'Expected something like: name=value; name2=value2; ...\n' +
        'In DevTools → Network, pick a bevasarlas.tesco.hu request, then Request Headers → Cookie.'
    );
  }
  return cookies;
}

/**
 * Normalise a cookie JSON export. Chrome DevTools exports an array; Cookie-Editor
 * exports an array with Capitalised keys or `{ [domain]: cookie[] }`; Playwright
 * storage_state wraps everything in `{ cookies: [...] }`.
 */
export function normaliseCookieExport(raw: unknown): SessionCookie[] {
  let list: any[];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object' && Array.isArray((raw as any).cookies)) list = (raw as any).cookies;
  else if (raw && typeof raw === 'object') list = Object.values(raw as Record<string, unknown>).flat() as any[];
  else list = [];

  const cookies = list
    .map((c: any): SessionCookie => ({
      name: c?.name ?? c?.Name,
      value: c?.value ?? c?.Value,
      domain: c?.domain ?? c?.Domain ?? COOKIE_DOMAIN,
      path: c?.path ?? c?.Path ?? '/',
      expires: Number(c?.expirationDate ?? c?.expires ?? -1),
      httpOnly: Boolean(c?.httpOnly ?? c?.HttpOnly ?? false),
      secure: Boolean(c?.secure ?? c?.Secure ?? false),
      sameSite: String(c?.sameSite ?? c?.SameSite ?? 'Lax'),
    }))
    .filter(c => c.name && c.value);

  if (cookies.length === 0) {
    throw new Error('No usable cookies found in the file. Check the export includes name/value fields.');
  }
  return cookies;
}

export function saveSession(session: TescoHuSession, file: string = SESSION_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
}

/** Null when there is no session or it has expired. Callers decide what to say. */
export function loadSession(file: string = SESSION_FILE): TescoHuSession | null {
  if (!fs.existsSync(file)) return null;
  const session: TescoHuSession = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (new Date(session.expiresAt) < new Date()) return null;
  return session;
}

export function getSessionInfo(file: string = SESSION_FILE): TescoHuSessionInfo {
  if (!fs.existsSync(file)) return { exists: false, path: file, expired: true };
  const session: TescoHuSession = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return {
    exists: true,
    path: file,
    expired: new Date(session.expiresAt) < new Date(),
    expiresAt: session.expiresAt,
    lastLogin: session.lastLogin,
    cookieCount: session.cookies?.length ?? 0,
  };
}

export function clearSession(file: string = SESSION_FILE): void {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function getCookieString(session: TescoHuSession): string {
  return session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function sessionFrom(cookies: SessionCookie[]): TescoHuSession {
  return { cookies, expiresAt: inferSessionExpiry(cookies), lastLogin: new Date().toISOString() };
}

export function importSessionFromHeader(header: string, file: string = SESSION_FILE): TescoHuSession {
  const session = sessionFrom(parseCookieHeader(header));
  saveSession(session, file);
  return session;
}

export function importSession(filePath: string, file: string = SESSION_FILE): TescoHuSession {
  const resolved = filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`Cookie file not found: ${resolved}`);
  const session = sessionFrom(normaliseCookieExport(JSON.parse(fs.readFileSync(resolved, 'utf-8'))));
  saveSession(session, file);
  return session;
}
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck && npx tsx test/tesco-hu.test.ts`
Expected: all `✓`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/providers/tesco-hu/session.ts test/tesco-hu.test.ts
git commit -m "feat(tesco-hu): cookie session store at ~/.tesco-hu/session.json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: GraphQL client for xapi with Hungarian headers

**Files:**
- Create: `src/providers/tesco-hu/api.ts`
- Modify: `test/tesco-hu.test.ts`

**Interfaces:**
- Produces (exported from `src/providers/tesco-hu/api.ts`):
  - `interface TescoRegionConfig { id: string; region: string; language: string; currency: string; origin: string; shopPath: string }`
  - `const TESCO_HU: TescoRegionConfig` = `{ id: 'tesco-hu', region: 'HU', language: 'hu-HU', currency: 'HUF', origin: 'https://bevasarlas.tesco.hu', shopPath: '/shop/hu-HU/' }`
  - `class TescoHuSessionError extends Error { status?: number }`
  - `sessionHelp(providerId: string, status?: number): string`
  - `class TescoHuAPI` with `constructor(config?: TescoRegionConfig)`, `readonly config`, `setAuthCookies(cookieString: string): void`, `hasAuthCookies(): boolean`, `search(query: string, page: number, count: number): Promise<{ total: number; products: any[] }>`, `getProduct(tpnc: string): Promise<any>`, `getCategories(): Promise<any[]>`, `getBasket(): Promise<any>`, `updateBasket(tpnc: string, quantity: number, orderId: string): Promise<any>`.
  - Private `client: AxiosInstance` — tests stub `(api as any).client.post`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Add failing API tests**

Add to the imports in `test/tesco-hu.test.ts`:

```ts
import { TescoHuAPI, TescoHuSessionError, TESCO_HU } from '../src/providers/tesco-hu/api';
```

Add inside `main()` before `process.exit`:

```ts
  console.log('\nxapi client');

  /** Replace the axios post with a canned batch response; capture what was sent. */
  function stubPost(api: TescoHuAPI, reply: unknown | Error, captured: any[] = []) {
    (api as any).client.post = async (url: string, body: unknown) => {
      captured.push({ url, body });
      if (reply instanceof Error) throw reply;
      return { data: reply };
    };
    return captured;
  }

  await check('sends the Hungarian region headers and a one-element batch', async () => {
    const api = new TescoHuAPI();
    const headers = (api as any).client.defaults.headers;
    assert.strictEqual(headers['region'], 'HU');
    assert.strictEqual(headers['language'], 'hu-HU');
    assert.strictEqual(headers['accept-language'], 'hu-HU');
    assert.strictEqual(headers['x-apikey'], 'TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA');
    assert.strictEqual(headers['Origin'], TESCO_HU.origin);

    const sent = stubPost(api, [{ data: { product: { id: '205406742', title: 'Banán lédig' } }, status: 200 }]);
    const product = await api.getProduct('205406742');
    assert.strictEqual(product.title, 'Banán lédig');
    assert.strictEqual(sent[0].url, 'https://xapi.tesco.com/');
    assert.ok(Array.isArray(sent[0].body) && sent[0].body.length === 1);
    assert.strictEqual(sent[0].body[0].operationName, 'GetProduct');
    assert.deepStrictEqual(sent[0].body[0].variables, { tpnc: '205406742' });
  });

  await check('search maps nodes and total, dropping null nodes, and pages by page/count', async () => {
    const api = new TescoHuAPI();
    const sent = stubPost(api, [{
      data: { search: {
        info: { total: 211, page: 2, count: 3, pageSize: 3 },
        results: [
          { node: { id: '210621123', title: 'Tesco UHT félzsíros tej 2,8% 1 l' } },
          { node: null },
          { node: { id: '120305258', title: 'Tesco UHT zsírszegény tej 1,5% 1 l' } },
        ],
      } },
      status: 200,
    }]);
    const { total, products } = await api.search('tej', 2, 3);
    assert.strictEqual(total, 211);
    assert.deepStrictEqual(products.map(p => p.id), ['210621123', '120305258']);
    assert.deepStrictEqual(sent[0].body[0].variables, { query: 'tej', page: 2, count: 3, sortBy: 'relevance' });
  });

  await check('GraphQL errors are thrown with the operation name, never swallowed', async () => {
    const api = new TescoHuAPI();
    stubPost(api, [{ errors: [{ message: 'Cannot query field "nope"' }], status: 400 }]);
    await assert.rejects(api.search('tej', 1, 5), /GraphQL error \(Search\): Cannot query field/);
  });

  await check('Unauthorized becomes a session error naming import-session', async () => {
    const api = new TescoHuAPI();
    stubPost(api, [{ errors: [{ message: 'Unauthorized', path: ['basket'], extensions: { http: { status: 401 } } }], data: { basket: null }, status: 401 }]);
    await assert.rejects(api.getBasket(), (err: any) => {
      assert.ok(err instanceof TescoHuSessionError);
      assert.strictEqual(err.status, 401);
      assert.match(err.message, /supermarket --provider tesco-hu import-session/);
      return true;
    });
  });

  await check('HTTP 401/403 from the transport also becomes a session error', async () => {
    const api = new TescoHuAPI();
    const transport: any = new Error('Request failed with status code 403');
    transport.response = { status: 403 };
    stubPost(api, transport);
    await assert.rejects(api.getBasket(), (err: any) => err instanceof TescoHuSessionError && err.status === 403);
  });

  await check('setAuthCookies sets the Cookie header and hasAuthCookies reflects it', () => {
    const api = new TescoHuAPI();
    assert.strictEqual(api.hasAuthCookies(), false);
    api.setAuthCookies('a=1; b=2');
    assert.strictEqual(api.hasAuthCookies(), true);
    assert.strictEqual((api as any).client.defaults.headers.common['Cookie'], 'a=1; b=2');
  });
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `npx tsx test/tesco-hu.test.ts`
Expected: fails with `Cannot find module '../src/providers/tesco-hu/api'`.

- [ ] **Step 3: Implement the client**

Create `src/providers/tesco-hu/api.ts`:

```ts
/**
 * Tesco Hungary — GraphQL client for https://xapi.tesco.com/
 *
 * bevasarlas.tesco.hu is the same Tesco micro-frontend platform as www.tesco.com
 * and talks to the same GraphQL backend ("mango") with the same public API key.
 * The `region` and `language` headers select the Hungarian catalogue: the same
 * product id returns "Banán lédig" with region HU and product-not-found with UK.
 *
 * Unlike the storefront, xapi answers plain HTTP clients — no Akamai challenge —
 * so search needs no browser and no account. Verified live 2026-09-17.
 *
 * Schema notes (introspection is disabled; learned from the site's SSR cache):
 *   - Product fields: id tpnb tpnc gtin title status isForSale defaultImageUrl
 *     price { actual unitPrice unitOfMeasure } reviews { stats { ... } } ...
 *   - The UK fields isAvailable / displayPrice / unitPrice do NOT exist here.
 *   - search(query, page, count, sortBy) and category(facet, page, sortBy, count)
 *     both return { info { total page count pageSize offset } results { node } }.
 *
 * Request format: POST / with a JSON array of operations; the response is an
 * array in the same order, each element { data, errors?, status }.
 */

import axios, { AxiosInstance } from 'axios';

export const XAPI_URL = 'https://xapi.tesco.com/';

/** Public key baked into the site's page config (`mangoApiKey`). Same as the UK. */
export const TESCO_API_KEY = 'TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA';

export interface TescoRegionConfig {
  /** Provider id used in error messages, e.g. "tesco-hu". */
  id: string;
  /** `region` header, upper-case, e.g. "HU". */
  region: string;
  /** `language` and `accept-language` headers, e.g. "hu-HU". */
  language: string;
  /** ISO 4217. */
  currency: string;
  /** Storefront origin, used for Origin/Referer headers. */
  origin: string;
  /** Shop path prefix on the storefront, e.g. "/shop/hu-HU/". */
  shopPath: string;
}

export const TESCO_HU: TescoRegionConfig = {
  id: 'tesco-hu',
  region: 'HU',
  language: 'hu-HU',
  currency: 'HUF',
  origin: 'https://bevasarlas.tesco.hu',
  shopPath: '/shop/hu-HU/',
};

export class TescoHuSessionError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TescoHuSessionError';
    this.status = status;
  }
}

export function sessionHelp(providerId: string, status?: number): string {
  return [
    `${providerId} session missing or rejected${status ? ` (${status})` : ''}.`,
    `Sign in at https://www.tesco.hu/account/login/hu-HU in your browser, copy the Cookie request header`,
    `from DevTools → Network on any bevasarlas.tesco.hu request, then run`,
    `\`supermarket --provider ${providerId} import-session --stdin\` and paste it.`,
    `Check with \`supermarket status --provider ${providerId}\`.`,
  ].join(' ');
}

const PRODUCT_FIELDS = `
  id
  tpnb
  tpnc
  gtin
  title
  status
  isForSale
  defaultImageUrl
  bulkBuyLimit
  averageWeight
  productType
  superDepartmentName
  departmentName
  aisleName
  shelfName
  price { actual unitPrice unitOfMeasure }
  promotions { id description }
  reviews { stats { noOfReviews overallRating } }
`;

function httpStatusOf(err: any): number | undefined {
  return err?.response?.status ?? err?.extensions?.http?.status;
}

export class TescoHuAPI {
  readonly config: TescoRegionConfig;
  private client: AxiosInstance;

  constructor(config: TescoRegionConfig = TESCO_HU) {
    this.config = config;
    this.client = axios.create({
      headers: {
        'x-apikey': TESCO_API_KEY,
        region: config.region,
        language: config.language,
        'accept-language': config.language,
        'content-type': 'application/json',
        accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Origin: config.origin,
        Referer: `${config.origin}${config.shopPath}`,
      },
    });
  }

  /** Inject cookies from an imported session (see session.ts). */
  setAuthCookies(cookieString: string): void {
    this.client.defaults.headers.common['Cookie'] = cookieString;
  }

  hasAuthCookies(): boolean {
    return Boolean(this.client.defaults.headers.common['Cookie']);
  }

  /**
   * Send one operation as a one-element batch and unwrap the first result.
   * GraphQL errors are thrown; an Unauthorized error or a 401/403 becomes a
   * TescoHuSessionError so the CLI/MCP boundary can tell the user what to do.
   */
  private async gql(operationName: string, query: string, variables: object = {}): Promise<any> {
    let response;
    try {
      response = await this.client.post(XAPI_URL, [{ operationName, variables, query }]);
    } catch (err: any) {
      const status = httpStatusOf(err);
      if (status === 401 || status === 403) throw new TescoHuSessionError(sessionHelp(this.config.id, status), status);
      throw err;
    }

    const result = Array.isArray(response.data) ? response.data[0] : response.data;
    const errors: any[] = result?.errors ?? [];
    if (errors.length) {
      const auth = errors.find(
        e => /unauthori[sz]ed/i.test(String(e?.message)) || [401, 403].includes(httpStatusOf(e) as number)
      );
      if (auth) {
        const status = httpStatusOf(auth) ?? 401;
        throw new TescoHuSessionError(sessionHelp(this.config.id, status), status);
      }
      const msg = errors.map(e => e?.message).filter(Boolean).join(', ');
      throw new Error(`GraphQL error (${operationName}): ${msg}`);
    }
    return result?.data;
  }

  // ── catalogue (anonymous) ────────────────────────────────────────────

  async search(query: string, page: number, count: number): Promise<{ total: number; products: any[] }> {
    const data = await this.gql(
      'Search',
      `query Search($query: String!, $page: Int, $count: Int, $sortBy: String) {
        search(query: $query, page: $page, count: $count, sortBy: $sortBy) {
          info { total page count pageSize offset }
          results { node { ... on ProductType { ${PRODUCT_FIELDS} } } }
        }
      }`,
      { query, page, count, sortBy: 'relevance' }
    );
    const results: any[] = data?.search?.results ?? [];
    return {
      total: Number(data?.search?.info?.total ?? 0),
      products: results.map(r => r?.node).filter(Boolean),
    };
  }

  async getProduct(tpnc: string): Promise<any> {
    const data = await this.gql(
      'GetProduct',
      `query GetProduct($tpnc: String) { product(tpnc: $tpnc) { ${PRODUCT_FIELDS} } }`,
      { tpnc }
    );
    return data?.product;
  }

  /** Superdepartment → department → aisle tree. */
  async getCategories(): Promise<any[]> {
    const data = await this.gql(
      'Taxonomy',
      `query Taxonomy($includeChildren: Boolean = true) {
        taxonomy(includeInspirationEvents: false) {
          name
          label
          children @include(if: $includeChildren) {
            id
            name
            label
            children { id name label }
          }
        }
      }`,
      { includeChildren: true }
    );
    return data?.taxonomy ?? [];
  }

  // ── basket (needs an imported session) ──────────────────────────────

  async getBasket(): Promise<any> {
    return this.gql(
      'GetBasket',
      `query GetBasket {
        basket {
          id
          splitView {
            id
            totalPrice
            guidePrice
            totalItems
            items {
              id
              quantity
              cost
              unit
              product { id tpnb gtin title defaultImageUrl price { actual unitPrice unitOfMeasure } }
            }
          }
        }
      }`
    );
  }

  /**
   * Add, change or remove a line. quantity 0 removes. orderId is basket.id from
   * getBasket(). Same mutation the Hungarian mfe-basket-manager bundle uses.
   */
  async updateBasket(tpnc: string, quantity: number, orderId: string): Promise<any> {
    return this.gql(
      'UpdateBasket',
      `mutation UpdateBasket($items: [BasketLineItemInputType], $orderId: ID) {
        basket(items: $items, orderId: $orderId) {
          id
          splitView {
            id
            totalPrice
            totalItems
            items { id quantity cost product { id title } }
          }
        }
      }`,
      { orderId, items: [{ adjustment: false, id: tpnc, newValue: quantity, newUnitChoice: 'pcs' }] }
    );
  }
}
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck && npx tsx test/tesco-hu.test.ts`
Expected: all `✓`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/providers/tesco-hu/api.ts test/tesco-hu.test.ts
git commit -m "feat(tesco-hu): xapi GraphQL client with Hungarian region headers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Provider class — search, product, categories

**Files:**
- Create: `src/providers/tesco-hu/index.ts`
- Modify: `test/tesco-hu.test.ts`

**Interfaces:**
- Consumes: `TescoHuAPI`, `TESCO_HU`, `TescoHuSessionError`, `sessionHelp` from `./api`; `loadSession`, `clearSession`, `getCookieString` from `./session`.
- Produces: `export class TescoHuProvider implements GroceryProvider` with `readonly name = 'tesco-hu'`, `search(query, options?)`, `getProduct(id)`, `getCategories(): Promise<Array<{ id: string; name: string; label: string; depth: number; path: string }>>`, `getAPI(): TescoHuAPI`. Basket methods are added in Task 5. Also `export function normaliseProduct(p: any, provider?: string): Product` and `export function flattenTaxonomy(nodes: any[]): Array<{...}>` for tests.

- [ ] **Step 1: Add failing provider tests**

Add to imports in `test/tesco-hu.test.ts`:

```ts
import { TescoHuProvider, normaliseProduct, flattenTaxonomy } from '../src/providers/tesco-hu/index';
```

Add inside `main()` before `process.exit`:

```ts
  console.log('\nprovider: catalogue');

  /** Live product fixture, xapi region HU, 2026-09-17. */
  const BANANA = {
    id: '205406742', tpnb: '205406742', tpnc: '205406742', gtin: '02870100000000',
    title: 'Banán lédig', status: 'AvailableForSale', isForSale: true,
    defaultImageUrl: 'https://digitalcontent.api.tesco.com/v2/media/ghs/a2ffdd5f-77ce-43fe-a45a-527231c49e52/bd9bbd54-0beb-45ca-9661-07b1a5c00d54_1756812688.jpeg?h=225&w=225',
    bulkBuyLimit: 24, averageWeight: 0.18, productType: 'LooseProduce',
    superDepartmentName: 'Zöldség és gyümölcs', departmentName: 'Gyümölcsök', aisleName: 'Banán', shelfName: 'Banán',
    price: { actual: 126, unitPrice: 699, unitOfMeasure: 'kg' },
    promotions: [],
    reviews: { stats: { noOfReviews: 12, overallRating: 4.4 } },
  };

  await check('normaliseProduct maps the live shape into Product with HUF', () => {
    const p = normaliseProduct(BANANA);
    assert.strictEqual(p.provider, 'tesco-hu');
    assert.strictEqual(p.product_uid, '205406742');
    assert.strictEqual(p.name, 'Banán lédig');
    assert.strictEqual(p.retail_price.price, 126);
    assert.deepStrictEqual(p.unit_price, { price: 699, measure: 'kg' });
    assert.strictEqual(p.currency, 'HUF');
    assert.strictEqual(p.in_stock, true);
    assert.strictEqual(p.rating, 4.4);
    assert.strictEqual(p.review_count, 12);
    assert.strictEqual(p.description, 'Gyümölcsök / Banán');
    assert.ok(p.image_url?.startsWith('https://digitalcontent.api.tesco.com/'));
    assert.strictEqual(p.size, undefined);
  });

  await check('normaliseProduct: stock follows status, then isForSale; nothing is invented', () => {
    assert.strictEqual(normaliseProduct({ ...BANANA, status: 'Unavailable' }).in_stock, false);
    assert.strictEqual(normaliseProduct({ ...BANANA, status: undefined, isForSale: true }).in_stock, true);
    assert.strictEqual(normaliseProduct({ ...BANANA, status: undefined, isForSale: undefined }).in_stock, false);
    const bare = normaliseProduct({ id: '1', title: 'x', price: { actual: 10 } });
    assert.strictEqual(bare.unit_price, undefined);
    assert.strictEqual(bare.rating, undefined);
    assert.strictEqual(bare.description, undefined);
  });

  await check('search converts limit/offset into page/count and normalises results', async () => {
    const provider = new TescoHuProvider();
    const calls: any[] = [];
    (provider.getAPI() as any).search = async (query: string, page: number, count: number) => {
      calls.push({ query, page, count });
      return { total: 211, products: [BANANA] };
    };
    const first = await provider.search('banán', { limit: 10 });
    assert.deepStrictEqual(calls[0], { query: 'banán', page: 1, count: 10 });
    assert.strictEqual(first[0].name, 'Banán lédig');
    await provider.search('banán', { limit: 10, offset: 20 });
    assert.deepStrictEqual(calls[1], { query: 'banán', page: 3, count: 10 });
    await provider.search('banán');
    assert.deepStrictEqual(calls[2], { query: 'banán', page: 1, count: 24 });
  });

  await check('getProduct normalises and getCategories flattens with depth and path', async () => {
    const provider = new TescoHuProvider();
    (provider.getAPI() as any).getProduct = async () => BANANA;
    (provider.getAPI() as any).getCategories = async () => [
      { name: 'Zöldség és gyümölcs', label: 'superDepartment', children: [
        { id: 'b;dep', name: 'Gyümölcsök', label: 'department', children: [
          { id: 'b;aisle', name: 'Banán', label: 'aisle' },
        ] },
      ] },
    ];
    const p = await provider.getProduct('205406742');
    assert.strictEqual(p.product_uid, '205406742');
    const cats = await provider.getCategories();
    assert.deepStrictEqual(cats, [
      { id: '', name: 'Zöldség és gyümölcs', label: 'superDepartment', depth: 0, path: 'Zöldség és gyümölcs' },
      { id: 'b;dep', name: 'Gyümölcsök', label: 'department', depth: 1, path: 'Zöldség és gyümölcs > Gyümölcsök' },
      { id: 'b;aisle', name: 'Banán', label: 'aisle', depth: 2, path: 'Zöldség és gyümölcs > Gyümölcsök > Banán' },
    ]);
    assert.deepStrictEqual(flattenTaxonomy([]), []);
  });
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `npx tsx test/tesco-hu.test.ts`
Expected: fails with `Cannot find module '../src/providers/tesco-hu/index'`.

- [ ] **Step 3: Implement the provider (catalogue half)**

Create `src/providers/tesco-hu/index.ts`:

```ts
/**
 * TescoHuProvider — Tesco Magyarország (bevasarlas.tesco.hu).
 *
 * Composes TescoHuAPI (GraphQL over xapi.tesco.com, region HU) with the cookie
 * session store. Catalogue search needs no account. Basket operations need an
 * imported browser session — see session.ts.
 *
 * Shares no code with ../tesco (UK): that provider is core, CI-tested and its
 * auth module imports Playwright at load time, which would make every Hungarian
 * search pay for a browser it never uses.
 */

import type { Basket, BasketItem, GroceryProvider, Product, SearchOptions } from '../types';
import { TescoHuAPI, TescoHuSessionError, TESCO_HU, sessionHelp } from './api';
import { clearSession, getCookieString, loadSession } from './session';

export interface FlatCategory {
  id: string;
  name: string;
  label: string;
  depth: number;
  path: string;
}

/** superDepartment → department → aisle, flattened with a breadcrumb path. */
export function flattenTaxonomy(nodes: any[], depth = 0, parentPath = ''): FlatCategory[] {
  const out: FlatCategory[] = [];
  for (const node of nodes ?? []) {
    const name = String(node?.name ?? '');
    const path = parentPath ? `${parentPath} > ${name}` : name;
    out.push({ id: String(node?.id ?? ''), name, label: String(node?.label ?? ''), depth, path });
    if (Array.isArray(node?.children)) out.push(...flattenTaxonomy(node.children, depth + 1, path));
  }
  return out;
}

export function normaliseProduct(p: any, provider: string = TESCO_HU.id): Product {
  const price = p?.price ?? {};
  const unitPrice =
    price.unitPrice !== undefined && price.unitPrice !== null && price.unitOfMeasure
      ? { price: Number(price.unitPrice), measure: String(price.unitOfMeasure) }
      : undefined;

  // `status` is authoritative when present. Without it fall back to isForSale.
  // The Product interface has no "unknown", so an absent field reads as not in
  // stock rather than as available — never claim stock we did not see.
  const inStock =
    typeof p?.status === 'string' ? p.status === 'AvailableForSale' : p?.isForSale === true;

  const stats = p?.reviews?.stats;
  const crumbs = [p?.departmentName, p?.aisleName].filter(Boolean);

  return {
    product_uid: String(p?.id ?? p?.tpnc ?? ''),
    name: String(p?.title ?? 'Unknown product'),
    description: crumbs.length ? crumbs.join(' / ') : undefined,
    retail_price: { price: Number(price.actual ?? 0) },
    unit_price: unitPrice,
    in_stock: inStock,
    image_url: p?.defaultImageUrl || undefined,
    provider,
    currency: TESCO_HU.currency,
    rating: typeof stats?.overallRating === 'number' ? stats.overallRating : undefined,
    review_count: typeof stats?.noOfReviews === 'number' ? stats.noOfReviews : undefined,
  };
}

export class TescoHuProvider implements GroceryProvider {
  readonly name = TESCO_HU.id;
  private api: TescoHuAPI;

  constructor() {
    this.api = new TescoHuAPI(TESCO_HU);
    try {
      const session = loadSession();
      if (session?.cookies?.length) this.api.setAuthCookies(getCookieString(session));
    } catch {
      // A corrupt session file must not break anonymous search. Basket calls
      // will raise the session error with instructions.
    }
  }

  /** Exposed for tests and provider-specific commands. */
  getAPI(): TescoHuAPI {
    return this.api;
  }

  // ── catalogue ────────────────────────────────────────────────────────

  async search(query: string, options?: SearchOptions): Promise<Product[]> {
    const count = options?.limit || 24;
    const page = options?.offset ? Math.floor(options.offset / count) + 1 : 1;
    const { products } = await this.api.search(query, page, count);
    return products.map(p => normaliseProduct(p, this.name));
  }

  async getProduct(productId: string): Promise<Product> {
    const p = await this.api.getProduct(productId);
    if (!p) throw new Error(`${this.name}: product ${productId} not found`);
    return normaliseProduct(p, this.name);
  }

  async getCategories(): Promise<FlatCategory[]> {
    return flattenTaxonomy(await this.api.getCategories());
  }

  // ── auth ─────────────────────────────────────────────────────────────

  async logout(): Promise<void> {
    clearSession();
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.api.hasAuthCookies()) return false;
    try {
      await this.api.getBasket();
      return true;
    } catch (err) {
      if (err instanceof TescoHuSessionError) return false;
      throw err;
    }
  }

  /** Raise the actionable session error before any network call. */
  protected requireSession(): void {
    if (!this.api.hasAuthCookies()) throw new TescoHuSessionError(sessionHelp(this.name));
  }
}
```

(`Basket` and `BasketItem` are imported now so Task 5 only adds methods; the unused-import is fine under this tsconfig — `noUnusedLocals` is not set.)

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck && npx tsx test/tesco-hu.test.ts`
Expected: all `✓`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/providers/tesco-hu/index.ts test/tesco-hu.test.ts
git commit -m "feat(tesco-hu): provider with anonymous search, product lookup and categories

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Basket methods (wired, not yet declared)

**Files:**
- Modify: `src/providers/tesco-hu/index.ts`
- Modify: `test/tesco-hu.test.ts`

**Interfaces:**
- Consumes: `TescoHuAPI.getBasket()`, `TescoHuAPI.updateBasket(tpnc, quantity, orderId)`, `requireSession()` from Task 4.
- Produces on `TescoHuProvider`: `getBasket(): Promise<Basket>`, `addToBasket(productId: string, quantity: number)`, `updateBasketItem(itemId: string, quantity: number)`, `removeFromBasket(itemId: string)`, `clearBasket()`; `export function normaliseBasket(data: any, provider?: string): Basket`.

- [ ] **Step 1: Add failing basket tests**

Add `normaliseBasket` to the index import line, and inside `main()`:

```ts
  console.log('\nprovider: basket');

  /** Shape of GetBasket, from the UK provider's confirmed query; HU validates the same fields. */
  const BASKET = {
    basket: {
      id: 'trn:tesco:order:uuid:test-basket',
      splitView: [{
        id: 'view-1', totalPrice: 252, guidePrice: 252, totalItems: 2,
        items: [{
          id: 'line-1', quantity: 2, cost: 252, unit: 'pcs',
          product: { id: '205406742', tpnb: '205406742', gtin: '02870100000000', title: 'Banán lédig', price: { actual: 126, unitPrice: 699, unitOfMeasure: 'kg' } },
        }],
      }],
    },
  };

  function basketProvider() {
    const provider = new TescoHuProvider();
    const api: any = provider.getAPI();
    api.setAuthCookies('session=test');
    const updates: any[] = [];
    api.getBasket = async () => BASKET;
    api.updateBasket = async (tpnc: string, quantity: number, orderId: string) => { updates.push({ tpnc, quantity, orderId }); return BASKET; };
    return { provider, updates };
  }

  await check('normaliseBasket maps splitView items, totals and ids', () => {
    const b = normaliseBasket(BASKET);
    assert.strictEqual(b.provider, 'tesco-hu');
    assert.strictEqual(b.total_cost, 252);
    assert.strictEqual(b.total_quantity, 2);
    assert.deepStrictEqual(b.items[0], {
      item_id: 'line-1', product_uid: '205406742', name: 'Banán lédig', quantity: 2, unit_price: 126, total_price: 252,
    });
    // splitView may also arrive as a single object rather than an array
    const single = normaliseBasket({ basket: { ...BASKET.basket, splitView: BASKET.basket.splitView[0] } });
    assert.strictEqual(single.items.length, 1);
    // total_price falls back to unit_price * quantity when cost is absent
    const noCost = normaliseBasket({ basket: { splitView: [{ items: [{ id: 'l', quantity: 3, product: { id: 'p', title: 't', price: { actual: 10 } } }] }] } });
    assert.strictEqual(noCost.items[0].total_price, 30);
    assert.strictEqual(noCost.total_quantity, 3);
  });

  await check('basket methods raise the session error before any network call when no cookies', async () => {
    const provider = new TescoHuProvider();
    const api: any = provider.getAPI();
    api.setAuthCookies('');
    let called = false;
    api.getBasket = async () => { called = true; return BASKET; };
    await assert.rejects(provider.getBasket(), /import-session/);
    await assert.rejects(provider.addToBasket('205406742', 1), /import-session/);
    assert.strictEqual(called, false);
    assert.strictEqual(await provider.isAuthenticated(), false);
  });

  await check('addToBasket sends UpdateBasket with the basket id as orderId', async () => {
    const { provider, updates } = basketProvider();
    await provider.addToBasket('120502935', 3);
    assert.deepStrictEqual(updates, [{ tpnc: '120502935', quantity: 3, orderId: 'trn:tesco:order:uuid:test-basket' }]);
  });

  await check('update/remove accept either the line id or the product id', async () => {
    const { provider, updates } = basketProvider();
    await provider.updateBasketItem('line-1', 5);
    await provider.removeFromBasket('205406742');
    await provider.removeFromBasket('unknown-id');
    assert.deepStrictEqual(updates.map(u => [u.tpnc, u.quantity]), [['205406742', 5], ['205406742', 0], ['unknown-id', 0]]);
  });

  await check('clearBasket removes every line', async () => {
    const { provider, updates } = basketProvider();
    await provider.clearBasket();
    assert.deepStrictEqual(updates, [{ tpnc: '205406742', quantity: 0, orderId: 'trn:tesco:order:uuid:test-basket' }]);
  });
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `npx tsx test/tesco-hu.test.ts`
Expected: TypeScript/import failure on `normaliseBasket` (does not exist yet).

- [ ] **Step 3: Implement basket normalisation and methods**

In `src/providers/tesco-hu/index.ts`, add after `normaliseProduct`:

```ts
function normaliseBasketItem(item: any): BasketItem {
  const product = item?.product ?? {};
  const quantity = Number(item?.quantity ?? 1);
  const unitPrice = Number(product?.price?.actual ?? 0);
  const cost = item?.cost;
  return {
    item_id: String(item?.id ?? ''),
    product_uid: String(product?.id ?? product?.tpnb ?? ''),
    name: String(product?.title ?? 'Unknown item'),
    quantity,
    unit_price: unitPrice,
    total_price: cost !== undefined && cost !== null ? Number(cost) : unitPrice * quantity,
  };
}

/** GetBasket → Basket. splitView is an array in the mfe-trolley shape; tolerate an object. */
export function normaliseBasket(data: any, provider: string = TESCO_HU.id): Basket {
  const basket = data?.basket ?? data ?? {};
  const view = Array.isArray(basket?.splitView) ? basket.splitView[0] : basket?.splitView;
  const items: any[] = view?.items ?? [];
  const normalised = items.map(normaliseBasketItem);
  const totalItems =
    view?.totalItems !== undefined && view?.totalItems !== null
      ? Number(view.totalItems)
      : normalised.reduce((s, i) => s + i.quantity, 0);
  return {
    items: normalised,
    total_quantity: totalItems,
    total_cost: Number(view?.totalPrice ?? 0),
    provider,
  };
}
```

And inside the class, after the `// ── auth` section, add:

```ts
  // ── basket ───────────────────────────────────────────────────────────
  //
  // Wired, but NOT declared in the manifest until a live round-trip with an
  // imported session has been verified (see the spec's capability promotion rule).

  async getBasket(): Promise<Basket> {
    this.requireSession();
    return normaliseBasket(await this.api.getBasket(), this.name);
  }

  /** The basket's own id doubles as the orderId that UpdateBasket needs. */
  private async getBasketOrderId(): Promise<string> {
    const data = await this.api.getBasket();
    const orderId = data?.basket?.id ?? data?.id;
    if (!orderId) throw new Error(`${this.name}: could not read the basket id — is the session valid?`);
    return String(orderId);
  }

  /**
   * UpdateBasket takes the product id, but `remove`/`update` are documented to
   * take the basket line id like every other provider. Resolve either against
   * the live basket; an unknown id is passed through as a product id.
   */
  private async resolveProductUid(itemOrProductId: string): Promise<string> {
    const basket = normaliseBasket(await this.api.getBasket(), this.name);
    const match = basket.items.find(i => i.item_id === itemOrProductId || i.product_uid === itemOrProductId);
    return match?.product_uid ?? itemOrProductId;
  }

  async addToBasket(productId: string, quantity: number): Promise<void> {
    this.requireSession();
    const orderId = await this.getBasketOrderId();
    await this.api.updateBasket(productId, quantity, orderId);
  }

  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
    this.requireSession();
    const productUid = await this.resolveProductUid(itemId);
    const orderId = await this.getBasketOrderId();
    await this.api.updateBasket(productUid, quantity, orderId);
  }

  async removeFromBasket(itemId: string): Promise<void> {
    await this.updateBasketItem(itemId, 0);
  }

  async clearBasket(): Promise<void> {
    this.requireSession();
    const basket = normaliseBasket(await this.api.getBasket(), this.name);
    const orderId = await this.getBasketOrderId();
    for (const item of basket.items) {
      await this.api.updateBasket(item.product_uid, 0, orderId);
    }
  }
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck && npx tsx test/tesco-hu.test.ts`
Expected: all `✓`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/providers/tesco-hu/index.ts test/tesco-hu.test.ts
git commit -m "feat(tesco-hu): basket operations over UpdateBasket, gated on an imported session

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Register the provider

**Files:**
- Modify: `src/providers/registry.ts` (after the `// ── Spain` block, before `// ── United States`)
- Modify: `src/providers/index.ts` (`ProviderFactory.create` switch)
- Modify: `test/lazy-loading.test.ts` (country filter test around line 62)

**Interfaces:**
- Consumes: `TescoHuProvider` from `./tesco-hu/index`.
- Produces: manifest id `'tesco-hu'`, country `'HU'`; `ProviderFactory.create('tesco-hu')`; `createProvider('tesco-hu')`.

- [ ] **Step 1: Add the failing registry assertion**

In `test/lazy-loading.test.ts`, inside `check('country filter excludes other countries', ...)`, after the `nl` assertion add:

```ts
  const hu = registry.list({ country: 'HU' }).map((p: any) => p.id);
  assert.deepStrictEqual(hu, ['tesco-hu']);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx test/lazy-loading.test.ts`
Expected: `✗ country filter excludes other countries` with `[] !== ['tesco-hu']`; exit 1.

- [ ] **Step 3: Add the manifest entry**

In `src/providers/registry.ts`, insert before `// ── United States`:

```ts
  // ── Hungary ──────────────────────────────────────────────────────────
  {
    id: 'tesco-hu',
    label: 'Tesco Magyarország',
    country: 'HU',
    // 'basket' is implemented but deliberately not declared: it needs an
    // imported browser session and has not yet been verified end-to-end.
    // Promote it only after a live add/remove round-trip (see the spec).
    capabilities: ['search'],
    auth: 'session-cookie',
    tier: 'community',
    maintainer: 'benedek',
    credit:
      'Same xapi.tesco.com GraphQL backend as the UK provider, selected by region/language headers; ' +
      'schema differences learned from the storefront\'s server-rendered Apollo cache',
    load: async () => (await import('./tesco-hu/index')).TescoHuProvider,
  },
```

- [ ] **Step 4: Add the synchronous factory case**

In `src/providers/index.ts`, inside the `switch (name)` after the `'mercadona'` case:

```ts
      case 'tesco-hu':
        return new (require('./tesco-hu/index').TescoHuProvider)();
```

- [ ] **Step 5: Run typecheck and the whole test suite**

Run: `npm run typecheck && npm test`
Expected: all `✓`, exit 0. In particular `importing ./providers loads no provider module`, `creating one provider loads exactly that provider` and both parity checks must still pass.

- [ ] **Step 6: Commit**

```bash
git add src/providers/registry.ts src/providers/index.ts test/lazy-loading.test.ts
git commit -m "feat(tesco-hu): register Tesco Magyarország as a search provider for HU

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: CLI, MCP and error-hint plumbing

**Files:**
- Modify: `src/cli.ts` — `status` (~line 121) and `import-session` (~lines 811–835)
- Modify: `src/mcp-server.ts` — `PROVIDERS` (~line 35), `SESSION_PATHS` (~line 38), `providerEnum` (~line 68), `grocery_search` handler (~line 431)
- Modify: `src/errors.ts` — login hint (~line 63)
- Modify: `test/tesco-hu.test.ts`

**Interfaces:**
- Consumes: `getSessionInfo`, `importSession`, `importSessionFromHeader` from `src/providers/tesco-hu/session`.
- Produces: `supermarket status --provider tesco-hu` prints session info; `supermarket --provider tesco-hu import-session --file|--header|--stdin` works; MCP tools accept `provider: "tesco-hu"` and `grocery_search` does not demand a session for it.

- [ ] **Step 1: Add the failing error-hint test**

Add to imports in `test/tesco-hu.test.ts`:

```ts
import { explain } from '../src/errors';
```

Inside `main()`:

```ts
  console.log('\nerror hints');

  await check('a 401 for tesco-hu points at import-session, not at login', () => {
    const err: any = new Error('Request failed with status code 401');
    err.response = { status: 401 };
    const msg = explain(err, { provider: 'tesco-hu', action: 'get basket' });
    assert.match(msg, /supermarket --provider tesco-hu import-session/);
    assert.doesNotMatch(msg, /SUPERMARKET_EMAIL/);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx test/tesco-hu.test.ts`
Expected: `✗ a 401 for tesco-hu points at import-session` (message currently suggests `supermarket login`).

- [ ] **Step 3: Update the error hint**

In `src/errors.ts` replace the `loginHint` condition:

```ts
    const SESSION_IMPORT_PROVIDERS = new Set(['tesco', 'tesco-hu', 'instacart-web']);
    const loginHint =
      opts.provider && SESSION_IMPORT_PROVIDERS.has(opts.provider)
        ? `Import a browser session — see \`supermarket --provider ${opts.provider} import-session --help\`.`
        : `Log in with \`supermarket login --provider ${who}\`, or set SUPERMARKET_EMAIL and SUPERMARKET_PASSWORD.`;
```

- [ ] **Step 4: Update the CLI `status` command**

In `src/cli.ts`, replace:

```ts
      const sessionInfo = providerName === 'tesco'
        ? (await import('./providers/tesco/auth')).getSessionInfo()
        : undefined;
```

with:

```ts
      const sessionInfo =
        providerName === 'tesco'
          ? (await import('./providers/tesco/auth')).getSessionInfo()
          : providerName === 'tesco-hu'
            ? (await import('./providers/tesco-hu/session')).getSessionInfo()
            : undefined;
```

And change the hint line a few lines below from the hard-coded `--provider tesco` to use the provider name:

```ts
        console.log(`\n💡 Refresh with \`supermarket login\` or import browser cookies with \`supermarket --provider ${providerName} import-session --file <cookies.json>\`.`);
```

- [ ] **Step 5: Update the CLI `import-session` command**

In `src/cli.ts`, inside the `import-session` action:

Replace the `--header/--stdin` branch's provider check and import:

```ts
      if (options.header || options.stdin) {
        if (providerName !== 'tesco' && providerName !== 'tesco-hu') {
          console.error('❌ --header is currently available for --provider tesco and --provider tesco-hu.');
          process.exit(1);
        }
        const header = options.stdin
          ? require('fs').readFileSync(0, 'utf-8')
          : options.header;
        if (providerName === 'tesco-hu') {
          const { importSessionFromHeader, SESSION_FILE } = await import('./providers/tesco-hu/session');
          const session = importSessionFromHeader(header);
          console.log(`✅ Imported ${session.cookies.length} cookies from header — tesco-hu session saved to ${SESSION_FILE}, valid until ${session.expiresAt}`);
        } else {
          const { importSessionFromHeader } = await import('./providers/tesco/import-session');
          importSessionFromHeader(header);
        }
        return;
      }
```

And in the `--file` branch add a `tesco-hu` case before the final `else`:

```ts
      } else if (providerName === 'tesco-hu') {
        const { importSession, SESSION_FILE } = await import('./providers/tesco-hu/session');
        const session = importSession(options.file);
        console.log(`✅ Imported ${session.cookies.length} cookies — tesco-hu session saved to ${SESSION_FILE}, valid until ${session.expiresAt}`);
      } else {
        console.error('❌ The import-session command is only available for --provider tesco, tesco-hu or ocado');
        process.exit(1);
      }
```

Also update the command description string to:

```ts
  .description('Tesco/Tesco HU/Ocado — import a browser session (cookie file, or a raw Cookie header)')
```

- [ ] **Step 6: Update the MCP server**

In `src/mcp-server.ts`:

```ts
const PROVIDERS: ProviderName[] = ['sainsburys', 'ocado', 'tesco', 'tesco-hu'];

// Session directories per provider
const SESSION_PATHS: Record<ProviderName, string> = {
  sainsburys: `${os.homedir()}/.sainsburys/session.json`,
  ocado: `${os.homedir()}/.ocado/session.json`,
  tesco: `${os.homedir()}/.tesco/session.json`,
  'tesco-hu': `${os.homedir()}/.tesco-hu/session.json`,
};

/** Providers whose catalogue search works with no session at all. */
const ANONYMOUS_SEARCH = new Set<ProviderName>(['tesco-hu']);
```

Update the enum description:

```ts
const providerEnum = { type: 'string', enum: PROVIDERS, description: 'Supermarket provider: sainsburys, ocado, tesco, or tesco-hu (Hungary)' };
```

In the `grocery_search` handler replace `if (loginError) return textResult(loginError, true);` with:

```ts
      if (loginError && !ANONYMOUS_SEARCH.has(providerName)) return textResult(loginError, true);
```

Also update the `grocery_login` description to mention that `tesco-hu` has no scripted login: change `'Login to a UK supermarket account. Required before using other tools for that provider. Launches a browser for authentication.'` to `'Login to a supermarket account (sainsburys, ocado, tesco). Launches a browser for authentication. tesco-hu has no scripted login: import a browser session with the CLI instead.'`

- [ ] **Step 7: Typecheck, test, and smoke the CLI offline**

Run: `npm run typecheck && npm test`
Expected: all `✓`, exit 0.

Run: `npx tsx src/cli.ts providers`
Expected: a row for `tesco-hu` with country HU, capability `search`, auth `session-cookie`.

Run: `npx tsx src/cli.ts --provider tesco-hu status`
Expected: `Authenticated: ❌ no`, `Session file: not found`, and a hint that names `--provider tesco-hu import-session`. Exit 0.

Run: `echo 'a=1; b=2' | npx tsx src/cli.ts --provider tesco-hu import-session --stdin && npx tsx src/cli.ts --provider tesco-hu status && rm ~/.tesco-hu/session.json`
Expected: `✅ Imported 2 cookies from header`, then status shows `Cookies: 2`, `Authenticated: ❌ no` (fake cookies), then the file is removed so no fake session lingers.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/mcp-server.ts src/errors.ts test/tesco-hu.test.ts
git commit -m "feat(tesco-hu): wire status, import-session, MCP provider list and error hints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Live verification of the anonymous catalogue

**Files:** none modified. Output is recorded for the PR description and Task 9's skill file.

- [ ] **Step 1: Search**

Run: `npx tsx src/cli.ts --provider tesco-hu search tej --limit 5`
Expected: five Hungarian milk products, each priced like `390 Ft (390 Ft/l) ✅` with a numeric ID. Must not print `£`.

- [ ] **Step 2: Search as JSON and confirm the schema**

Run: `npx tsx src/cli.ts --provider tesco-hu search "Banán lédig" --limit 3 --json`
Expected: a `products` array whose first element has `product_uid: "205406742"`, `currency: "HUF"`, `in_stock: true`, `unit_price: { price: 699, measure: "kg" }` (price may drift; ids and shapes must match).

- [ ] **Step 3: Paging**

Run: `npx tsx src/cli.ts --provider tesco-hu search tej --limit 3 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).products;console.log(p.length, p.map(x=>x.product_uid))})'`
Expected: `3 [ ... ]` — exactly three ids.

- [ ] **Step 4: Categories**

Run: `npx tsx src/cli.ts --provider tesco-hu categories | head -20`
Expected: an indented tree starting with `Most ajánlott!` and including `Zöldség és gyümölcs`, each with a `>`-joined path line.

- [ ] **Step 5: Compare across countries still works**

Run: `npx tsx src/cli.ts search tej --country HU --limit 2`
Expected: the `--country HU` route resolves to `tesco-hu` without `--provider`.

- [ ] **Step 6: Record**

Paste the exact commands and trimmed outputs into the final report; they go into the PR description under "What I tested live".

---

### Task 9: Documentation

**Files:**
- Create: `skills/tesco-hu.md`
- Modify: `README.md` (lines 7, 15–16, 22, provider table after line 169)
- Modify: `SKILL.md` (line 3 description, line 10 tags, per-supermarket table)
- Modify: `docs/providers/evaluated.md` (summary table + a section)

- [ ] **Step 1: Write the provider skill**

Create `skills/tesco-hu.md`:

````markdown
---
name: tesco-hungary-groceries
description: "Tesco Magyarország (bevasarlas.tesco.hu) grocery search and basket via CLI or MCP. Anonymous catalogue search in Hungarian with forint prices; basket needs an imported browser session."
license: MIT
compatibility: Node.js 18+, TypeScript. No browser needed for search. Hungary only.
metadata:
  author: benedek
  version: "1.0.0"
  repository: https://github.com/abracadabra50/open-supermarkets
  tags: [groceries, tesco, hungary, magyar, shopping, automation, mcp, agent-tool]
allowed-tools: Bash({baseDir}/node:*), Bash(supermarket:*), Bash(npm:run:supermarket:*)
---

# Tesco Magyarország Skill

Search the Hungarian Tesco catalogue and, with an imported session, manage the basket.

**Location:** `{baseDir}`

## When to use

- The user shops at Tesco in Hungary, or asks about Hungarian prices ("mennyibe kerül a tej a Tescoban?")
- The user wants to build a Tesco Hungary basket from a meal plan
- The user asks for `--country HU`

## Setup

```bash
cd {baseDir}
npm install
```

No Playwright and no account are needed for search.

## Search (no login)

```bash
supermarket --provider tesco-hu search "tej" --limit 10
supermarket --provider tesco-hu search "csirkemell" --json
supermarket search kenyér --country HU
supermarket --provider tesco-hu categories
```

Prices are in forints and print as `390 Ft`. Product ids are numeric Tesco product
numbers (TPNC), e.g. `205406742` is "Banán lédig".

Search terms should be Hungarian: the backend matches against Hungarian titles.

## Authentication (needed for basket)

There is no scripted login. Tesco Hungary's storefront is behind Akamai and its
login page lives on www.tesco.hu, so import a session from your normal browser:

1. Sign in at https://www.tesco.hu/account/login/hu-HU and open https://bevasarlas.tesco.hu
2. DevTools → Network → click any `bevasarlas.tesco.hu` request → Request Headers → right-click the `Cookie` value → Copy value
3. Import it without letting it touch your shell history:

```bash
supermarket --provider tesco-hu import-session --stdin
# paste, then Ctrl-D
supermarket --provider tesco-hu status
```

A cookie JSON export also works: `supermarket --provider tesco-hu import-session --file ~/Downloads/tesco-hu-cookies.json`

The session is saved to `~/.tesco-hu/session.json` (mode 0600) and expires with the
earliest auth cookie, or after 12 hours when the export carries no expiry.

## Basket

Basket commands exist but the `basket` capability is only declared in the registry
once a live round-trip has been verified. Until then the CLI/MCP boundary refuses them
with `tesco-hu does not support "basket"`. After promotion:

```bash
supermarket --provider tesco-hu basket
supermarket --provider tesco-hu add 205406742 --qty 2
supermarket --provider tesco-hu update <item-id> 3
supermarket --provider tesco-hu remove <item-id>
supermarket --provider tesco-hu clear --force
```

`add`/`update`/`remove` accept either the basket line id shown by `basket` or the
product id.

## MCP

Use `provider: "tesco-hu"` on the standard tools. `grocery_search` and
`grocery_search_batch` work with no session. Basket tools need the imported session
file to exist on the machine running the MCP server.

## API notes

- Backend: `POST https://xapi.tesco.com/` (GraphQL, batched array body)
- Headers: `x-apikey` (public, from the page config), `region: HU`, `language: hu-HU`, `accept-language: hu-HU`
- Operations: `Search`, `GetProduct`, `Taxonomy`, `GetBasket`, `UpdateBasket`
- Schema differs from the UK: no `isAvailable`/`displayPrice`/`unitPrice` on products; use `status`, `price.actual`, `price.unitPrice`, `price.unitOfMeasure`
- Introspection is disabled

## Limitations

- No delivery slots, checkout or order history
- No scripted login; sessions must be re-imported when they expire
- Czechia (nakup.itesco.cz) and Slovakia (potravinydomov.itesco.sk) run the same platform and very likely work with a region switch, but are unverified and not registered
````

- [ ] **Step 2: Update README**

In `README.md`:

- Line 7: `across nine providers in six countries` → `across ten providers in seven countries`.
- Line 15: `countries-6` → `countries-7`. Line 16: `providers-9` → `providers-10`.
- Line 22: add `🇭🇺 &nbsp;` after `🇪🇸 &nbsp;`.
- Provider table: after the `Instacart *(unofficial)*` row add:

```markdown
| Tesco Magyarország | 🇭🇺 | ✓ | — | — | — | browser session (basket only) |
```

- In the "Bring your supermarket" section, after the sentence about `src/providers/ah.ts`, add: `` `src/providers/tesco-hu/` shows a search-plus-session provider that talks GraphQL and imports browser cookies. ``

- [ ] **Step 3: Update SKILL.md**

- Line 3: `across nine retailers in five countries — UK, Netherlands, Belgium, Spain and the US` → `across ten retailers in seven countries — UK, Netherlands, Belgium, Spain, Hungary, the US and Canada`.
- Line 10 tags: add `tesco-hu, hungary` after `tesco`.
- Per-Supermarket Skills table: add a row `| **Tesco Magyarország** | [`skills/tesco-hu.md`](skills/tesco-hu.md) | Search; basket pending live verification |`.

- [ ] **Step 4: Update evaluated.md**

In the summary table add:

```markdown
| ~~Tesco Hungary~~ | HU | **BUILT** | same xapi as the UK, selected by `region: HU` — see src/providers/tesco-hu/ |
| Tesco Czechia / Slovakia | CZ / SK | likely viable | same platform as Hungary; unverified, needs someone who can test |
```

Append a section:

```markdown
## Tesco Hungary (bevasarlas.tesco.hu) — BUILT, 2026-09-17

The storefront is Akamai-fronted (403 to anything that is not a browser), but its
page config points at `https://xapi.tesco.com/` with the UK's public `mangoApiKey`,
`region: hu`, `language: hu-HU`. xapi accepts plain HTTP with `region: HU` and returns
the Hungarian catalogue: `product(tpnc: "205406742")` is "Banán lédig" here and
`product-not-found` with `region: UK`.

The Tesco Ireland note above ("Invalid Client") did not reproduce for Hungary — the
same key works. Schema differs from the UK (`status`/`isForSale`/`price.unitPrice`
instead of `isAvailable`/`displayPrice`/`unitPrice`); introspection is disabled, so
field names came from the storefront's server-rendered Apollo cache.

Basket mutations (`UpdateBasket`) validate but need a session. Login is on
www.tesco.hu; the storefront attaches an `authorization` header for signed-in users.
Whether a raw Cookie header is enough for xapi (as it is for the UK) is being verified
by the maintainer.

**Czechia and Slovakia:** nakup.itesco.cz and potravinydomov.itesco.sk are the same
platform. A `region: CZ` / `region: SK` config in `src/providers/tesco-hu/api.ts` is
the obvious probe; nobody has run it yet.
```

- [ ] **Step 5: Typecheck and tests still green, then commit**

Run: `npm run typecheck && npm test`
Expected: all `✓`.

```bash
git add skills/tesco-hu.md README.md SKILL.md docs/providers/evaluated.md
git commit -m "docs(tesco-hu): skill file, README/SKILL rows, evaluated.md entry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Live basket verification and capability promotion (needs the user)

**Files:**
- Modify (only if verified): `src/providers/registry.ts` (`capabilities`), `test/lazy-loading.test.ts` (no change needed: the checkout list is unaffected), `README.md` provider row, `skills/tesco-hu.md` Basket section, `docs/providers/evaluated.md` last paragraph of the Hungary section.

**Interfaces:**
- Consumes: the user's imported session at `~/.tesco-hu/session.json`.

- [ ] **Step 1: Stop and ask the user to import a session**

This step cannot be done by the agent (entering credentials is prohibited). Ask the user to:

1. Sign in at https://www.tesco.hu/account/login/hu-HU in Chrome and open https://bevasarlas.tesco.hu/shop/hu-HU/
2. DevTools → Network → any `bevasarlas.tesco.hu` request → Request Headers → copy the `Cookie` value
3. Run `npx tsx src/cli.ts --provider tesco-hu import-session --stdin`, paste, Ctrl-D

Wait for confirmation.

- [ ] **Step 2: Check authentication**

Run: `npx tsx src/cli.ts --provider tesco-hu status`

Branch on the result:

- `Authenticated: ✅ yes` → continue to Step 3.
- `Authenticated: ❌ no` → the Cookie header is not enough for xapi. Do **not** promote the capability. Record the exact GraphQL error, and open a follow-up: capture, in a signed-in browser, the `authorization` request header the storefront sends to `xapi.tesco.com` (DevTools → Network → filter `xapi` → any POST → Request Headers), and extend `session.ts`/`api.ts` to store and send that bearer token. That is a new bounded task; brainstorm it separately.

- [ ] **Step 3: Round-trip a known product (temporarily bypassing the capability guard)**

Because the manifest does not yet declare `basket`, the CLI refuses `add`. Verify through a one-off script instead:

```bash
npx tsx -e '
const { TescoHuProvider } = require("./src/providers/tesco-hu/index");
(async () => {
  const p = new TescoHuProvider();
  const before = await p.getBasket();
  console.log("before", before.total_quantity, before.total_cost);
  await p.addToBasket("205406742", 1);
  const mid = await p.getBasket();
  console.log("after add", mid.items.filter(i => i.product_uid === "205406742"));
  const line = mid.items.find(i => i.product_uid === "205406742");
  await p.removeFromBasket(line.item_id);
  const after = await p.getBasket();
  console.log("after remove", after.total_quantity, after.total_cost);
})().catch(e => { console.error(e.message); process.exit(1); });
'
```

Expected: `after add` shows one banana line with quantity 1 and `after remove` matches `before`. If the basket had a banana already, the quantity goes up by one and back down; record what you saw.

- [ ] **Step 4: Promote the capability**

In `src/providers/registry.ts` change the `tesco-hu` entry to `capabilities: ['search', 'basket'],` and replace the comment with `// Basket verified live on <date> with an imported browser session.`

In `README.md` change the row to `| Tesco Magyarország | 🇭🇺 | ✓ | ✓ | — | — | browser session |`.

In `skills/tesco-hu.md` replace the first paragraph of the Basket section with `Basket commands need an imported session (see Authentication).` and delete the sentence about the boundary refusing them.

In `docs/providers/evaluated.md` replace the "Whether a raw Cookie header is enough..." sentence with `A raw Cookie header imported from the browser is enough for xapi basket operations, verified <date>.`

- [ ] **Step 5: Verify through the real CLI path and the test suite**

Run: `npx tsx src/cli.ts --provider tesco-hu basket`
Expected: the live basket prints in forints with line ids.

Run: `npm run typecheck && npm test`
Expected: all `✓`.

- [ ] **Step 6: Commit**

```bash
git add src/providers/registry.ts README.md skills/tesco-hu.md docs/providers/evaluated.md
git commit -m "feat(tesco-hu): declare basket after live add/remove round-trip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand off**

Report to the user: what was verified live (Tasks 8 and 10), what was offline only, the branch name, and that the fork could not be created by the agent's token so they need to fork `abracadabra50/open-supermarkets` themselves (or grant the token `fork` permission) before `git push fork tesco-hu` and the PR.
