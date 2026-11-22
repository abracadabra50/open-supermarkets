/**
 * Store selection, shared by the CLI, HTTP API and MCP server.
 *
 * Some retailers price and stock per store. The contract is stateless: a
 * provider declaring the `stores` capability implements `listStores()`, and
 * its `search()` honours `SearchOptions.storeId`. Nothing is remembered between
 * calls, so one caller's store can never leak into another's results.
 *
 * Every surface follows the same order, before provider code loads:
 *
 *   1. validate the caller's input           → StoreInputError (HTTP 400)
 *   2. checkAccess() each need from `searchNeeds()` / `STORES_NEED`
 *      → MissingCapabilityError (HTTP 501) for providers without `stores`
 */

import type { Need } from './providers/registry';
import type { StoreSearchOptions } from './providers/types';

/** Store lookup needs the `stores` capability. */
export const STORES_NEED: Need = { capability: 'stores' };

/** Most stores a single lookup returns, whatever the caller asks for. */
export const MAX_STORES = 100;

/** Invalid store input from the caller, not a retailer failure. */
export class StoreInputError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'StoreInputError';
  }
}

/**
 * What a search needs: `search`, plus `stores` when the caller scoped it to a
 * store. A provider without `stores` is refused instead of silently returning
 * prices that are not for the store the caller asked about.
 */
export function searchNeeds(base: Need, storeId: string | undefined): Need[] {
  return storeId === undefined ? [base] : [base, STORES_NEED];
}

/** Trimmed store id, undefined when absent, StoreInputError when blank or not a string. */
export function parseStoreId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new StoreInputError('store id must be a non-empty string');
  }
  return raw.trim();
}

/** Raw lookup input: strings from the CLI and HTTP, numbers from MCP. */
export interface RawStoreSearch {
  query?: unknown;
  postcode?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  mode?: unknown;
  limit?: unknown;
}

function text(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StoreInputError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function number(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) throw new StoreInputError(`${name} must be a number, got "${String(value)}"`);
  return parsed;
}

/** Validate lookup input into the provider contract. Makes no request. */
export function parseStoreSearch(raw: RawStoreSearch, defaultLimit = 10): StoreSearchOptions {
  const latitude = number(raw.latitude, 'latitude');
  const longitude = number(raw.longitude, 'longitude');
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new StoreInputError('latitude and longitude must be given together');
  }
  if (latitude !== undefined && (latitude < -90 || latitude > 90)) {
    throw new StoreInputError(`latitude must be between -90 and 90, got ${latitude}`);
  }
  if (longitude !== undefined && (longitude < -180 || longitude > 180)) {
    throw new StoreInputError(`longitude must be between -180 and 180, got ${longitude}`);
  }
  const limit = number(raw.limit, 'limit') ?? defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new StoreInputError(`limit must be a positive integer, got "${String(raw.limit)}"`);
  }

  const options: StoreSearchOptions = { limit: Math.min(limit, MAX_STORES) };
  const query = text(raw.query, 'query');
  const postcode = text(raw.postcode, 'postcode');
  const mode = text(raw.mode, 'mode')?.toLowerCase();
  if (query !== undefined) options.query = query;
  if (postcode !== undefined) options.postcode = postcode;
  if (latitude !== undefined && longitude !== undefined) {
    options.latitude = latitude;
    options.longitude = longitude;
  }
  if (mode !== undefined) options.mode = mode;
  return options;
}
