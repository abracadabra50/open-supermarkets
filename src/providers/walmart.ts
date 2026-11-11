/**
 * Walmart (United States) — catalogue search through the Scavio API.
 *
 * Walmart's own consumer GraphQL answers HTTP 418 to plain clients
 * (docs/providers/evaluated.md), so this provider goes through Scavio
 * (https://scavio.dev), a paid API that returns walmart.com search results as
 * JSON. It needs a Scavio key; a search page costs 1 credit, or 2 when a store
 * is set.
 *
 *   SCAVIO_API_KEY     required
 *   WALMART_STORE_ID   optional, with WALMART_ZIP: price and stock at that store
 *   WALMART_ZIP        optional, with WALMART_STORE_ID
 *
 * Walmart prices and stocks every search against a store. Without the two
 * store variables it picks its own default store, which is not the shopper's,
 * so set them for prices that match a real store.
 *
 * Only items sold by Walmart itself are returned. Marketplace sellers list in
 * the same results at their own prices, often several times the shelf price,
 * and that is not Walmart's price.
 */
import type { GroceryProvider, Product, SearchOptions } from './types';
import { toPrice } from './normalise';
import {
  asRecord,
  clampLimit,
  clampOffset,
  firstString,
  type FetchLike,
  ProviderHttpError,
  ProviderProtocolError,
  requireQuery,
  requireRecordArray,
} from './ie/shared';

const SEARCH_URL = 'https://api.scavio.dev/api/v1/walmart/search';
const PROVIDER = 'Walmart';
// A store-scoped search takes 10 to 60 seconds upstream.
const REQUEST_TIMEOUT_MS = 90_000;
// One search page holds about 40 Walmart results; there is no second request.
const MAX_LIMIT = 40;
const WALMART_SELLER = /^walmart(\.com)?$/i;

export interface WalmartOptions {
  fetcher?: FetchLike;
  apiKey?: string;
  storeId?: string;
  zip?: string;
}

function mapProduct(row: Record<string, unknown>): Product | undefined {
  const id = firstString(row.id);
  const name = firstString(row.title);
  if (!id || !name) return undefined;
  const rating = typeof row.rating === 'number' ? row.rating : undefined;
  const reviews = typeof row.rating_count === 'number' ? row.rating_count : undefined;
  return {
    product_uid: id,
    name,
    retail_price: { price: toPrice(row.price) },
    in_stock: typeof row.out_of_stock === 'boolean' ? !row.out_of_stock : null,
    image_url: firstString(row.image),
    provider: 'walmart',
    currency: 'USD',
    rating,
    review_count: reviews,
  };
}

export class WalmartProvider implements GroceryProvider {
  readonly name = 'walmart';

  private readonly fetcher: FetchLike;
  private readonly apiKey: string;
  private readonly storeId?: string;
  private readonly zip?: string;

  constructor(options: WalmartOptions = {}) {
    const apiKey = options.apiKey ?? process.env.SCAVIO_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Walmart search runs through the Scavio API and needs SCAVIO_API_KEY.\n' +
          'Get a key at https://scavio.dev (new accounts include free credits).'
      );
    }
    const storeId = options.storeId ?? process.env.WALMART_STORE_ID;
    const zip = options.zip ?? process.env.WALMART_ZIP;
    if (Boolean(storeId) !== Boolean(zip)) {
      throw new Error('Set WALMART_STORE_ID and WALMART_ZIP together, or neither.');
    }
    if (storeId && !/^\d{1,6}$/.test(storeId)) {
      throw new Error('WALMART_STORE_ID must be a numeric Walmart store id.');
    }
    if (zip && !/^\d{5}$/.test(zip)) {
      throw new Error('WALMART_ZIP must be a 5-digit US ZIP code.');
    }
    this.fetcher = options.fetcher ?? fetch;
    this.apiKey = apiKey;
    this.storeId = storeId || undefined;
    this.zip = zip || undefined;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalizedQuery = requireQuery(query);
    const limit = clampLimit(options.limit, 10, MAX_LIMIT);
    if (clampOffset(options.offset) > 0) {
      // Walmart pages hold a varying number of items, so an offset cannot be
      // mapped to a page without fetching, and paying for, every page before it.
      throw new RangeError('Walmart search does not support offset');
    }

    const body: Record<string, string> = { query: normalizedQuery };
    if (this.storeId && this.zip) {
      body.store_id = this.storeId;
      body.delivery_zip = this.zip;
    }

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetcher(SEARCH_URL, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new Error(`Walmart request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      }
      throw error;
    }

    if (response.status === 401) {
      throw new Error('Scavio rejected the API key (HTTP 401). Check SCAVIO_API_KEY.');
    }
    if (response.status === 402) {
      throw new Error('Scavio account is out of credits (HTTP 402).');
    }
    if (response.status === 429) {
      throw new Error('Scavio rate limit reached (HTTP 429). Try again shortly.');
    }
    if (!response.ok) throw new ProviderHttpError(PROVIDER, response.status);

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProviderProtocolError(PROVIDER, 'expected JSON but received an invalid response');
    }

    const data = asRecord(asRecord(payload).data);
    const rows = requireRecordArray(data.products, PROVIDER, 'products list');
    // Without seller names the filter below would read as an empty shelf.
    if (rows.length > 0 && !rows.some((row) => firstString(row.seller_name))) {
      throw new ProviderProtocolError(PROVIDER, 'products list carried no seller names');
    }
    const mapped = rows
      .filter((row) => WALMART_SELLER.test(firstString(row.seller_name) ?? ''))
      .map(mapProduct);
    const products = mapped.filter((product): product is Product => product !== undefined);
    if (mapped.length > 0 && products.length === 0) {
      throw new ProviderProtocolError(PROVIDER, 'products list contained no valid products');
    }
    return products.slice(0, limit);
  }
}
