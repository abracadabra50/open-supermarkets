import type { Product } from '../types';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly provider: string;
  readonly bodySnippet: string;

  constructor(provider: string, status: number, bodySnippet = '') {
    super(
      `${provider} request failed (HTTP ${status})` +
        (bodySnippet ? `: ${bodySnippet}` : '')
    );
    this.name = 'ProviderHttpError';
    this.status = status;
    this.provider = provider;
    this.bodySnippet = bodySnippet;
  }
}

export class ProviderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderInputError';
  }
}

export class ProviderProtocolError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderProtocolError';
    this.provider = provider;
  }
}

export function requireQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) throw new RangeError('query must not be empty');
  return normalized;
}

export function clampLimit(value: number | undefined, fallback = 10, max = 60): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new RangeError('limit must be a positive integer');
  }
  return Math.min(value, max);
}

export function clampOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError('offset must be a non-negative integer');
  }
  return value;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

export function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object'
      )
    : [];
}

/**
 * Require a response collection to be present and array-shaped.
 *
 * Empty arrays are valid search results. Invalid row values are discarded;
 * product-level fields are validated by each provider mapper so valid rows
 * can still be retained when a collection contains incomplete records. The
 * caller must compare the source array length with its mapped result count so
 * an all-invalid non-empty collection is not mistaken for an empty shelf.
 */
export function requireRecordArray(
  value: unknown,
  provider: string,
  path: string
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new ProviderProtocolError(provider, `missing or malformed ${path}`);
  }
  return value.filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
  );
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value
    .replace(/\s/g, '')
    .replace(/[^0-9,.-]/g, '')
    .replace(',', '.');
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseUnitPrice(value: unknown): Product['unit_price'] | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const match = text.match(/€?\s*([0-9]+(?:[.,][0-9]+)?)\s*\/\s*(.+)$/i);
  if (!match) return undefined;
  const price = asNumber(match[1]);
  const measure = match[2]?.trim();
  return price !== undefined && measure ? { price, measure } : undefined;
}

export function joinBrandAndName(brand: unknown, name: unknown): string {
  const b = asString(brand);
  const n = asString(name);
  if (!n) return b ?? 'Unknown product';
  if (!b) return n;
  const normalize = (value: string) =>
    value.toLocaleLowerCase('en-IE').replace(/[^a-z0-9]+/g, ' ').trim();
  return normalize(n).startsWith(normalize(b)) ? n : `${b} ${n}`;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return undefined;
}

export function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

/**
 * Combine explicit boolean signals without inventing a default.
 * Conflicting signals are unknown because the payload does not support a
 * truthful true or false result.
 */
export function explicitBooleanState(...values: unknown[]): boolean | null {
  const signals = values.filter((value): value is boolean => typeof value === 'boolean');
  if (signals.length === 0) return null;
  return signals.every((value) => value === signals[0]) ? signals[0]! : null;
}

export async function responseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export async function jsonResponse<T>(
  response: Response,
  provider: string
): Promise<T> {
  const text = await responseText(response);
  if (!response.ok) {
    throw new ProviderHttpError(provider, response.status, compactSnippet(text));
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderProtocolError(
      provider,
      `expected JSON but received ${compactSnippet(text) || 'an empty body'}`
    );
  }
}

export function compactSnippet(text: string, max = 180): string {
  return text
    // Redact quoted JSON fields before handling normal HTTP-style headers.
    .replace(
      /(["'](?:cookie|set-cookie)["']\s*:\s*)["'][^"'\r\n]*["']/gi,
      '$1"[redacted]"'
    )
    .replace(
      /(["'](?:authorization|token|api[-_ ]?key|x-api[-_]?key|oauth\.accesstoken|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']\s*:\s*)["'][^"'\r\n]*["']/gi,
      '$1"[redacted]"'
    )
    // Header-style values are also sometimes quoted, for example
    // Authorization: "Bearer <token>". Match the complete quoted value.
    .replace(
      /\b(authorization|cookie|set-cookie|api[-_ ]?key|x-api[-_]?key|oauth\.accesstoken|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*(["'])[^"'\r\n]*\2/gi,
      '$1=[redacted]'
    )
    // Cookie and Set-Cookie values can contain several semicolon-delimited
    // pairs. Redact the complete header value, not only its first pair.
    .replace(
      /\b(cookie|set-cookie)\s*[:=]\s*(?!\[redacted\])[^\r\n]*/gi,
      '$1=[redacted]'
    )
    // A normal bearer header has whitespace between the scheme and token.
    .replace(
      /\b(authorization)\s*[:=]\s*bearer\s+[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .replace(
      /\b(authorization|token|api[-_ ]?key|x-api[-_]?key|oauth\.accesstoken|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export async function requestText(
  fetcher: FetchLike,
  input: string | URL | Request,
  init: RequestInit,
  provider: string
): Promise<string> {
  const response = await fetcher(input, init);
  const text = await responseText(response);
  if (!response.ok) {
    throw new ProviderHttpError(provider, response.status, compactSnippet(text));
  }
  return text;
}

export async function requestJson<T>(
  fetcher: FetchLike,
  input: string | URL | Request,
  init: RequestInit,
  provider: string
): Promise<T> {
  const response = await fetcher(input, init);
  return jsonResponse<T>(response, provider);
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function htmlText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function absoluteUrl(base: string, candidate: unknown): string | undefined {
  const text = asString(candidate);
  if (!text) return undefined;
  try {
    const url = new URL(text, base);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function env(name: string): string | undefined {
  const processLike = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  const value = processLike.process?.env?.[name];
  return asString(value);
}

export function uuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}
