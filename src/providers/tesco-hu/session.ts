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
