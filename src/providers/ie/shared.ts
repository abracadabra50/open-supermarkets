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
