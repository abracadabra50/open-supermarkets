/**
 * Tesco Ireland — read-only catalogue search.
 *
 * Two independently documented read paths are supported:
 *
 *   xapi  — one GraphQL `search` operation, including seller prices.
 *   index — `search.api.tesco.com` returns Irish TPNBs, then xapi batch-
 *           hydrates each product through `GetProductByTpnb`.
 *
 * `auto` prefers the cheaper one-request xapi path and falls back to the index
 * path only when the GraphQL search projection is unavailable. It never falls
 * back on authentication, rate-limit, or bot-block errors because doing so
 * would turn one rejected request into a burst of more rejected requests.
 *
 * This provider is intentionally search-only and separate from the existing GB
 * Tesco provider. No basket, slot, order, login, or checkout mutation is sent.
 */
import type { GroceryProvider, Product, SearchOptions } from './types';
import {
  asRecord,
  asRecords,
  clampLimit,
  clampOffset,
  compactSnippet,
  env,
  explicitBooleanState,
  firstNumber,
  firstString,
  type FetchLike,
  ProviderHttpError,
  ProviderProtocolError,
  requireQuery,
  responseText,
  uuid,
} from './ie/shared';

export const TESCO_IE_SEARCH_ENDPOINT = 'https://search.api.tesco.com/search';
export const TESCO_XAPI_ENDPOINT = 'https://xapi.tesco.com/';

/** Public key embedded in Tesco's web bundles. It rotates; env override wins. */
export const TESCO_CURRENT_PUBLIC_API_KEY = 'TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA';

const ORIGIN = 'https://www.tesco.ie';
const REFERER = 'https://www.tesco.ie/shop/en-IE/';

const XAPI_SEARCH_QUERY = `
query Search($query: String!, $page: Int = 1, $count: Int) {
  search(query: $query, page: $page, count: $count) {
    results {
      node {
        __typename
        ... on ProductInterface {
          tpnc
          tpnb
          gtin
          title
          brandName
          defaultImageUrl
          isForSale
          details { packSize { value units } }
          sellers {
            results {
              price { actual unitPrice unitOfMeasure }
              promotions {
                description
                price { afterDiscount beforeDiscount }
              }
            }
          }
        }
      }
    }
  }
}`.trim();

const PRODUCT_BY_TPNB_QUERY = `
query GetProductByTpnb($tpnb: String) {
  product(tpnb: $tpnb) {
    id
    tpnc
    tpnb
    gtin
    title
    brandName
    defaultImageUrl
    isForSale
    details { packSize { value units } }
    sellers {
      results {
        price { actual unitPrice unitOfMeasure }
        promotions {
          description
          price { afterDiscount beforeDiscount }
        }
      }
    }
  }
}`.trim();

const GET_PRODUCT_QUERY = `
query GetProduct($tpnc: String!) {
  product(tpnc: $tpnc) {
    id
    tpnc
    tpnb
    gtin
    title
    brandName
    defaultImageUrl
    isForSale
    details { packSize { value units } }
    sellers {
      results {
        price { actual unitPrice unitOfMeasure }
        promotions {
          description
          price { afterDiscount beforeDiscount }
        }
      }
    }
  }
}`.trim();

interface GraphQLOperation {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  extensions?: { mfeName: string };
}

interface GraphQLEnvelope {
  data?: unknown;
  errors?: unknown;
}

type TescoProductIdKind = 'tpnb' | 'tpnc';

export type TescoIrelandSearchStrategy = 'auto' | 'xapi' | 'index';

export interface TescoIrelandOptions {
  fetcher?: FetchLike;
  apiKey?: string;
  cookie?: string;
  authorization?: string;
  strategy?: TescoIrelandSearchStrategy;
  xapiEndpoint?: string;
  searchEndpoint?: string;
  userAgent?: string;
}

class TescoSearchProjectionError extends ProviderProtocolError {
  constructor(message: string) {
    super('Tesco Ireland', message);
    this.name = 'TescoSearchProjectionError';
  }
}

function packSize(details: unknown): string | undefined {
  const pack = asRecord(asRecord(details).packSize);
  const value = firstString(pack.value) ??
    (firstNumber(pack.value) !== undefined ? String(firstNumber(pack.value)) : undefined);
  const units = firstString(pack.units);
  if (!value) return undefined;
  return units ? `${value} ${units}` : value;
}

function seller(node: Record<string, unknown>): Record<string, unknown> {
  const sellers = asRecord(node.sellers);
  const first = asRecord(asRecords(sellers.results)[0]);
  return first;
}

function promotionFrom(value: unknown): Record<string, unknown> | undefined {
  return asRecords(value)[0];
}

function productPrice(node: Record<string, unknown>): number | undefined {
  const firstSeller = seller(node);
  const sellerPrice = asRecord(firstSeller.price);
  const directPrice = asRecord(node.price);
  const displayPrice = asRecord(node.displayPrice);
  const promotion = promotionFrom(firstSeller.promotions) ?? promotionFrom(node.promotions);
  const promotionPrice = asRecord(promotion?.price);
  return firstNumber(
    displayPrice.value,
    sellerPrice.actual,
    directPrice.actual,
    promotionPrice.afterDiscount
  );
}

function unitPrice(node: Record<string, unknown>): Product['unit_price'] | undefined {
  const firstSeller = seller(node);
  const sellerPrice = asRecord(firstSeller.price);
  const directPrice = asRecord(node.price);
  const directUnit = asRecord(node.unitPrice);
  const price = firstNumber(directUnit.price, sellerPrice.unitPrice, directPrice.unitPrice);
  const measure = firstString(
    directUnit.measure,
    sellerPrice.unitOfMeasure,
    directPrice.unitOfMeasure
  );
  return price !== undefined && measure ? { price, measure } : undefined;
}

function parsedStockState(value: unknown): boolean | null | undefined {
  const state = firstString(value);
  if (!state) return undefined;
  if (/^(?:in[_ -]?stock|available)$/i.test(state)) return true;
  if (/^(?:out[_ -]?of[_ -]?stock|unavailable|sold[_ -]?out)$/i.test(state)) return false;
  return null;
}

function mapProduct(node: Record<string, unknown>): Product | undefined {
  // TPNB is available in both search strategies. Prefer it so the same
  // catalogue product keeps one identity across xapi and index hydration.
  const id = firstString(node.tpnb, node.tpnc, node.id, node.gtin);
  const title = firstString(node.title, node.name);
  const price = productPrice(node);
  if (!id || !title || price === undefined) return undefined;
  const firstSeller = seller(node);
  const promotion = promotionFrom(firstSeller.promotions) ?? promotionFrom(node.promotions);
  const availability = asRecord(node.availability);
  const stockSignals = [
    parsedStockState(availability.status),
    parsedStockState(availability.state),
  ];
  const inStock = stockSignals.includes(null)
    ? null
    : explicitBooleanState(...stockSignals);
  return {
    product_uid: id,
    name: title,
    description: firstString(promotion?.description),
    retail_price: { price },
    unit_price: unitPrice(node),
    // isForSale and a positive price prove sale eligibility, not inventory.
    // Current anonymous IE responses omit a usable product stock state.
    in_stock: inStock,
    image_url: firstString(node.defaultImageUrl, node.imageUrl),
    provider: 'tesco-ie',
    currency: 'EUR',
    size: packSize(node.details),
  };
}

function graphQlMessages(value: unknown): string[] {
  return asRecords(value)
    .map((error) => firstString(error.message) ?? 'unknown GraphQL error');
}

function isProjectionFailure(messages: readonly string[]): boolean {
  return messages.some((message) =>
    /cannot query field|unknown field|validation error|unknown argument/i.test(message)
  );
}

export class TescoIrelandProvider implements GroceryProvider {
  readonly name = 'tesco-ie';
  private readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly cookie?: string;
  private readonly authorization?: string;
  private readonly strategy: TescoIrelandSearchStrategy;
  private readonly xapiEndpoint: string;
  private readonly searchEndpoint: string;
  private readonly userAgent: string;

  constructor(options: TescoIrelandOptions = {}) {
    this.apiKey =
      options.apiKey ??
      env('SUPERMARKET_TESCO_IE_API_KEY') ??
      env('TESCO_IE_API_KEY') ??
      env('TESCO_API_KEY') ??
      TESCO_CURRENT_PUBLIC_API_KEY;
    this.fetcher = options.fetcher ?? fetch;
    this.cookie = options.cookie ?? env('SUPERMARKET_TESCO_IE_COOKIE');
    this.authorization =
      options.authorization ?? env('SUPERMARKET_TESCO_IE_AUTHORIZATION');
    this.strategy = options.strategy ?? 'auto';
    this.xapiEndpoint = options.xapiEndpoint ?? TESCO_XAPI_ENDPOINT;
    this.searchEndpoint = options.searchEndpoint ?? TESCO_IE_SEARCH_ENDPOINT;
    this.userAgent =
      options.userAgent ??
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalizedQuery = requireQuery(query);
    const limit = clampLimit(options.limit, 10, 50);
    const offset = clampOffset(options.offset);

    if (this.strategy === 'xapi') {
      return this.searchXapi(normalizedQuery, limit, offset);
    }
    if (this.strategy === 'index') {
      return this.searchIndex(normalizedQuery, limit, offset);
    }

    try {
      return await this.searchXapi(normalizedQuery, limit, offset);
    } catch (error) {
      if (!(error instanceof TescoSearchProjectionError)) throw error;
      return this.searchIndex(normalizedQuery, limit, offset);
    }
  }

  async getProduct(productId: string): Promise<Product> {
    const suppliedId = requireQuery(productId);
    const explicit = suppliedId.match(/^(tpnb|tpnc):(.*)$/i);
    if (explicit) {
      const kind = explicit[1]!.toLocaleLowerCase('en-IE') as TescoProductIdKind;
      const id = requireQuery(explicit[2] ?? '');
      const product = await this.lookupProduct(id, kind);
      if (product) return product;
      throw new ProviderProtocolError(
        'Tesco Ireland',
        `no product returned for ${kind.toUpperCase()} ${id}`
      );
    }

    // Search emits a bare TPNB when one is available. Try that identity first.
    // A clean not-found response may be a legacy bare TPNC, so make one bounded
    // compatibility lookup. HTTP, GraphQL, and malformed-product errors stop.
    const byTpnb = await this.lookupProduct(suppliedId, 'tpnb');
    if (byTpnb) return byTpnb;
    const byTpnc = await this.lookupProduct(suppliedId, 'tpnc');
    if (byTpnc) return byTpnc;
    throw new ProviderProtocolError(
      'Tesco Ireland',
      `no product returned for TPNB or legacy TPNC ${suppliedId}`
    );
  }

  private async lookupProduct(
    id: string,
    kind: TescoProductIdKind
  ): Promise<Product | undefined> {
    const byTpnb = kind === 'tpnb';
    const envelopes = await this.executeBatch([
      {
        operationName: byTpnb ? 'GetProductByTpnb' : 'GetProduct',
        query: byTpnb ? PRODUCT_BY_TPNB_QUERY : GET_PRODUCT_QUERY,
        variables: byTpnb ? { tpnb: id } : { tpnc: id },
        extensions: { mfeName: 'mfe-pdp' },
      },
    ]);
    const data = asRecord(envelopes[0]?.data);
    if (!Object.prototype.hasOwnProperty.call(data, 'product') || data.product === undefined) {
      throw new ProviderProtocolError(
        'Tesco Ireland',
        `${kind.toUpperCase()} lookup response was missing data.product`
      );
    }
    if (data.product === null) {
      return undefined;
    }
    const product = mapProduct(asRecord(data.product));
    if (!product) {
      throw new ProviderProtocolError(
        'Tesco Ireland',
        `${kind.toUpperCase()} lookup returned no valid priced product for id ${id}`
      );
    }
    return product;
  }

  private async searchXapi(query: string, limit: number, offset: number): Promise<Product[]> {
    const firstPage = Math.floor(offset / limit) + 1;
    const offsetWithinPage = offset % limit;
    const pageCount = offsetWithinPage === 0 ? 1 : 2;
    const operations = Array.from({ length: pageCount }, (_, index) => ({
      operationName: 'Search',
      query: XAPI_SEARCH_QUERY,
      variables: { query, page: firstPage + index, count: limit },
      extensions: { mfeName: 'mfe-plp' },
    }));
    const envelopes = await this.executeBatch(operations, { allowProjectionErrors: true });

    const results: unknown[] = [];
    for (const envelope of envelopes) {
      const messages = graphQlMessages(envelope.errors);
      if (messages.length > 0) {
        if (isProjectionFailure(messages)) {
          throw new TescoSearchProjectionError(messages.slice(0, 3).join('; '));
        }
        throw new ProviderProtocolError('Tesco Ireland', messages.slice(0, 3).join('; '));
      }

      const data = asRecord(envelope.data);
      const search = asRecord(data.search);
      if (!Array.isArray(search.results)) {
        throw new TescoSearchProjectionError('xapi Search returned no results array');
      }
      results.push(...search.results);
    }
    const selectedResults = results.slice(offsetWithinPage, offsetWithinPage + limit);
    const mappedProducts = selectedResults
      .map((result) => mapProduct(asRecord(asRecord(result).node)))
      .filter((product): product is Product => product !== undefined);
    if (selectedResults.length > 0 && mappedProducts.length === 0) {
      throw new ProviderProtocolError(
        'Tesco Ireland',
        'xapi Search returned products but none had a stable ID, name, and numeric price'
      );
    }
    return mappedProducts;
  }

  private async searchIndex(query: string, limit: number, offset: number): Promise<Product[]> {
    const url = new URL(this.searchEndpoint);
    url.searchParams.set('distchannel', 'ghs');
    url.searchParams.set('query', query);
    url.searchParams.set('count', String(limit));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('geo', 'ie');

    const response = await this.fetcher(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-IE,en;q=0.9',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
        'User-Agent': this.userAgent,
      },
    });
    const text = await responseText(response);
    if (!response.ok) {
      throw new ProviderHttpError(
        'Tesco Ireland search index',
        response.status,
        compactSnippet(text)
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new ProviderProtocolError(
        'Tesco Ireland search index',
        `expected JSON but received ${compactSnippet(text) || 'an empty body'}`
      );
    }

    const root = asRecord(decoded);
    const country = asRecord(root.ie);
    const ghs = asRecord(country.ghs);
    const products = asRecord(ghs.products);
    if (!Array.isArray(products.results)) {
      throw new ProviderProtocolError(
        'Tesco Ireland search index',
        'missing `ie.ghs.products.results`'
      );
    }
    const indexResults = products.results;
    const tpnbs = asRecords(indexResults)
      .map((result) => firstString(result.tpnb) ??
        (firstNumber(result.tpnb) !== undefined ? String(firstNumber(result.tpnb)) : undefined))
      .filter((tpnb): tpnb is string => tpnb !== undefined)
      .slice(0, limit);
    if (indexResults.length > 0 && tpnbs.length === 0) {
      throw new ProviderProtocolError(
        'Tesco Ireland search index',
        'product results contained no stable TPNB identifiers'
      );
    }
    if (tpnbs.length === 0) return [];

    const envelopes = await this.executeBatch(
      tpnbs.map((tpnb) => ({
        operationName: 'GetProductByTpnb',
        query: PRODUCT_BY_TPNB_QUERY,
        variables: { tpnb },
        extensions: { mfeName: 'mfe-pdp' },
      }))
    );

    const hydrated: Product[] = [];
    const errors: string[] = [];
    for (const [index, envelope] of envelopes.entries()) {
      const messages = graphQlMessages(envelope.errors);
      if (messages.length > 0) {
        errors.push(...messages);
        continue;
      }
      const data = asRecord(envelope.data);
      const node = asRecord(data.product);
      const product = mapProduct(node);
      if (product) {
        hydrated.push(product);
      } else if (!('product' in data) || data.product === null || data.product === undefined) {
        errors.push(`hydration response ${index + 1} missing data.product`);
      } else {
        errors.push(`hydration response ${index + 1} contained no valid priced product`);
      }
    }
    if (hydrated.length === 0) {
      throw new ProviderProtocolError(
        'Tesco Ireland',
        `index found ${tpnbs.length} products but hydration failed: ` +
          (errors.slice(0, 3).join('; ') || 'no hydration results could be mapped')
      );
    }
    return hydrated.slice(0, limit);
  }

  private async executeBatch(
    operations: GraphQLOperation[],
    options: { allowProjectionErrors?: boolean } = {}
  ): Promise<GraphQLEnvelope[]> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Language': 'en-IE,en;q=0.9',
      'x-apikey': this.apiKey,
      region: 'IE',
      language: 'en-IE',
      Origin: ORIGIN,
      Referer: REFERER,
      traceid: `${uuid()}:${uuid()}`,
      trkid: uuid(),
      'apollographql-client-name': 'open-supermarkets',
      'apollographql-client-version': '3-ie-search',
    };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.authorization) headers.Authorization = this.authorization;

    const response = await this.fetcher(this.xapiEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(operations),
    });
    const text = await responseText(response);

    if (response.status === 403 && /invalid client/i.test(text)) {
      throw new Error(
        'Tesco Ireland rejected the public web API key (HTTP 403 Invalid Client). ' +
          'The key rotates; set SUPERMARKET_TESCO_IE_API_KEY from a current tesco.ie request.'
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Tesco Ireland xapi rejected the read request (HTTP ${response.status}). ` +
          'The current market may require a user-owned session cookie or authorization token.'
      );
    }
    if (response.status === 429) {
      throw new Error(
        'Tesco Ireland rate limited the request (HTTP 429). Stop and retry later.'
      );
    }
    if (!response.ok) {
      throw new ProviderHttpError(
        'Tesco Ireland',
        response.status,
        compactSnippet(text)
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new ProviderProtocolError(
        'Tesco Ireland',
        `expected JSON but received ${compactSnippet(text) || 'an empty body'}`
      );
    }
    const envelopes = (Array.isArray(decoded) ? decoded : [decoded]).map((value) => {
      const record = asRecord(value);
      return { data: record.data, errors: record.errors } satisfies GraphQLEnvelope;
    });
    if (envelopes.length !== operations.length) {
      throw new ProviderProtocolError(
        'Tesco Ireland',
        `GraphQL batch returned ${envelopes.length} envelopes for ${operations.length} operations`
      );
    }

    if (!options.allowProjectionErrors) {
      const messages = envelopes.flatMap((envelope) => graphQlMessages(envelope.errors));
      if (messages.length > 0 && envelopes.every((envelope) => !asRecord(envelope.data).product)) {
        throw new ProviderProtocolError('Tesco Ireland', messages.slice(0, 3).join('; '));
      }
    }
    return envelopes;
  }
}
