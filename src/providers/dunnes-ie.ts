/**
 * Dunnes Stores Ireland — search adapter with two documented transports.
 *
 * The grocery gateway is the default because live verification showed that the
 * public VTEX endpoint searches Dunnes' general retail catalogue, not groceries.
 * Gateway requests remain store-scoped and refuse to run without a store ID.
 */
import type {
  GroceryProvider,
  Product,
  SearchOptions,
  Store,
  StoreSearchOptions,
} from './types';
import {
  absoluteUrl,
  asRecord,
  asRecords,
  clampLimit,
  clampOffset,
  env,
  explicitBooleanState,
  firstNumber,
  firstString,
  type FetchLike,
  jsonResponse,
  ProviderInputError,
  ProviderProtocolError,
  requireRecordArray,
  requireQuery,
  uuid,
} from './ie/shared';

const VTEX_ENDPOINT = 'https://www.dunnesstores.com/_v/segment/graphql/v1';
const GATEWAY_BASE = 'https://storefrontgateway.dunnesstoresgrocery.com/api';
const SITE_URL = 'https://www.dunnesstoresgrocery.com';
const STORE_LOOKUP_LIMIT = 20;
const STORE_LOOKUP_MAX = 100;
const MAX_STORE_PAGES = 10;
const DEFAULT_NEARBY_RANGE_KM = 10;
const SHOPPING_MODE_IDS = {
  pickup: '11111111-1111-1111-1111-111111111111',
  delivery: '22222222-2222-2222-2222-222222222222',
} as const;

export type DunnesTransport = 'vtex' | 'gateway';

export interface DunnesIrelandOptions {
  fetcher?: FetchLike;
  transport?: DunnesTransport;
  storeId?: string;
  /** Optional user-owned runtime session cookie for the grocery gateway. */
  cookieHeader?: string;
  vtexEndpoint?: string;
  gatewayBase?: string;
}

function vtexProduct(item: Record<string, unknown>): Product | undefined {
  const productName = firstString(item.productName, item.name);
  let sellableItem: Record<string, unknown> | undefined;
  let seller: Record<string, unknown> | undefined;
  for (const candidate of asRecords(item.items)) {
    const candidateSeller = asRecords(candidate.sellers).find((entry) => {
      const offer = asRecord(entry.commertialOffer);
      return firstNumber(offer.Price, offer.ListPrice) !== undefined;
    });
    if (candidateSeller) {
      sellableItem = candidate;
      seller = candidateSeller;
      break;
    }
  }
  const offer = asRecord(seller?.commertialOffer);
  const image = asRecords(sellableItem?.images)[0];
  const id = firstString(
    sellableItem?.itemId,
    item.productReference,
    item.productId,
  );
  const price = firstNumber(offer.Price, offer.ListPrice);
  if (!id || !productName || price === undefined) return undefined;
  const availableQuantity = firstNumber(offer.AvailableQuantity);

  return {
    product_uid: id,
    name: productName,
    retail_price: { price },
    in_stock:
      availableQuantity === undefined || availableQuantity < 0
        ? null
        : availableQuantity > 0,
    image_url: absoluteUrl(SITE_URL, firstString(image?.imageUrl, image?.imageTag)),
    provider: 'dunnes-ie',
    currency: 'EUR',
  };
}

function gatewayProduct(item: Record<string, unknown>): Product | undefined {
  const name = firstString(item.name, item.title);
  const id = firstString(item.sku, item.id, item.productId);
  const price = firstNumber(
    item.priceNumeric,
    item.currentPrice,
    item.price,
    asRecord(item.price).value
  );
  if (!id || !name || price === undefined) return undefined;
  const unitPrice = firstString(item.pricePerUnit, item.unitPriceText);
  const unitMatch = unitPrice?.match(/€?\s*([0-9]+(?:[.,][0-9]+)?)\s*\/\s*(.+)/i);

  return {
    product_uid: id,
    name,
    retail_price: { price },
    unit_price:
      unitMatch && firstNumber(unitMatch[1]) !== undefined
        ? { price: firstNumber(unitMatch[1])!, measure: unitMatch[2]!.trim() }
        : undefined,
    in_stock: explicitBooleanState(item.available),
    image_url: absoluteUrl(SITE_URL, firstString(item.imageUrl, item.image)),
    provider: 'dunnes-ie',
    currency: 'EUR',
    size: firstString(item.size, item.packSize),
  };
}

function field(record: Record<string, unknown>, name: string): unknown {
  const expected = name.toLowerCase();
  return Object.entries(record).find(([key]) => key.toLowerCase() === expected)?.[1];
}

function normalizedStoreId(value: unknown): string {
  const storeId = firstString(value);
  if (!storeId) throw new ProviderInputError('storeId must be a non-empty string');
  return storeId;
}

function normalizedModes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modes = new Set<string>();
  for (const candidate of value) {
    const record = asRecord(candidate);
    const mode = firstString(candidate, field(record, 'name'), field(record, 'mode'));
    if (mode) modes.add(mode.toLowerCase());
  }
  return modes.size > 0 ? [...modes] : undefined;
}

function gatewayStore(item: Record<string, unknown>): Store | undefined {
  const storeId = firstString(field(item, 'retailerStoreId'));
  const name = firstString(field(item, 'name'));
  if (!storeId || !name) return undefined;

  const location = asRecord(field(item, 'location'));
  const latitude = firstNumber(field(location, 'latitude'), field(item, 'latitude'));
  const longitude = firstNumber(field(location, 'longitude'), field(item, 'longitude'));
  const address = [
    field(item, 'addressLine1'),
    field(item, 'addressLine2'),
    field(item, 'addressLine3'),
    field(item, 'city'),
    field(item, 'countyProvinceState'),
    field(item, 'country'),
  ]
    .map((value) => firstString(value))
    .filter((value): value is string => value !== undefined)
    .join(', ');

  return {
    store_id: storeId,
    name,
    status: firstString(field(item, 'status'))?.toLowerCase(),
    currency: firstString(field(item, 'currency'))?.toUpperCase(),
    postcode: firstString(field(item, 'postCode'), field(item, 'postcode'))?.toUpperCase(),
    address: address || undefined,
    location:
      latitude !== undefined && longitude !== undefined
        ? { latitude, longitude }
        : undefined,
    shopping_modes: normalizedModes(field(item, 'shoppingModes')),
  };
}

function normalizedSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function requireSearchableStoreFilter(value: string, name: string): string {
  const filter = requireQuery(value);
  if (!normalizedSearchText(filter)) {
    throw new ProviderInputError(`${name} must contain searchable characters`);
  }
  return filter;
}

function storeMatches(store: Store, fullTextSearch?: string, postcode?: string): boolean {
  if (fullTextSearch) {
    const query = normalizedSearchText(fullTextSearch);
    const haystack = normalizedSearchText(
      [store.name, store.address, store.postcode].filter(Boolean).join(' ')
    );
    if (!haystack.includes(query)) return false;
  }
  if (postcode) {
    const expected = normalizedSearchText(postcode).replace(/ /g, '');
    const actual = normalizedSearchText(store.postcode ?? '').replace(/ /g, '');
    if (!actual.startsWith(expected)) return false;
  }
  return true;
}

function nearbyStoreOptions(options: StoreSearchOptions): {
  limit: number;
  offset: number;
  retailerStoreId?: string;
  fullTextSearch?: string;
  postcode?: string;
  latitude?: number;
  longitude?: number;
  range?: number;
  shoppingMode?: 'pickup' | 'delivery';
} {
  const limit = clampLimit(options.limit, STORE_LOOKUP_LIMIT, STORE_LOOKUP_MAX);
  const offset = clampOffset(options.offset);
  const fullTextSearch = options.fullTextSearch === undefined
    ? undefined
    : requireSearchableStoreFilter(options.fullTextSearch, 'fullTextSearch');
  const postcode = options.postcode === undefined
    ? undefined
    : requireSearchableStoreFilter(options.postcode, 'postcode');
  const retailerStoreId =
    options.retailerStoreId === undefined
      ? undefined
      : normalizedStoreId(options.retailerStoreId);
  const coordinatesSpecified =
    options.latitude !== undefined || options.longitude !== undefined;
  if (!coordinatesSpecified) {
    if (options.shoppingMode !== undefined) {
      throw new ProviderInputError('shoppingMode requires both latitude and longitude');
    }
    return { limit, offset, retailerStoreId, fullTextSearch, postcode };
  }
  if (fullTextSearch) {
    throw new ProviderInputError('fullTextSearch cannot be combined with coordinates');
  }
  if (postcode) {
    throw new ProviderInputError('postcode cannot be combined with coordinates');
  }
  if (offset > 0) {
    throw new ProviderInputError('offset cannot be combined with coordinates');
  }
  if (
    !Number.isFinite(options.latitude) ||
    !Number.isFinite(options.longitude) ||
    options.latitude === undefined ||
    options.longitude === undefined ||
    options.latitude < -90 ||
    options.latitude > 90 ||
    options.longitude < -180 ||
    options.longitude > 180
  ) {
    throw new ProviderInputError('latitude and longitude must be valid coordinates');
  }
  const range = options.range ?? DEFAULT_NEARBY_RANGE_KM;
  if (!Number.isFinite(range) || range <= 0) {
    throw new ProviderInputError('range must be a positive number of kilometres');
  }
  if (options.shoppingMode !== undefined && options.shoppingMode !== 'pickup' && options.shoppingMode !== 'delivery') {
    throw new ProviderInputError('shoppingMode must be pickup or delivery');
  }
  return {
    limit,
    offset,
    retailerStoreId,
    fullTextSearch,
    postcode,
    latitude: options.latitude,
    longitude: options.longitude,
    range,
    shoppingMode: options.shoppingMode ?? 'pickup',
  };
}

export class DunnesIrelandProvider implements GroceryProvider {
  readonly name = 'dunnes-ie';
  private readonly fetcher: FetchLike;
  private readonly transport: DunnesTransport;
  private storeId?: string;
  private readonly cookieHeader?: string;
  private readonly vtexEndpoint: string;
  private readonly gatewayBase: string;

  constructor(options: DunnesIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.transport = options.transport ?? 'gateway';
    this.storeId = options.storeId ?? env('DUNNES_IE_STORE_ID');
    this.cookieHeader =
      options.cookieHeader ??
      env('SUPERMARKET_DUNNES_IE_COOKIE_HEADER') ??
      env('SUPERMARKET_DUNNES_IE_COOKIE') ??
      env('DUNNES_IE_COOKIE');
    this.vtexEndpoint = options.vtexEndpoint ?? VTEX_ENDPOINT;
    this.gatewayBase = options.gatewayBase ?? GATEWAY_BASE;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    return this.transport === 'gateway'
      ? this.searchGateway(query, options)
      : this.searchVtex(query, options);
  }

  async listStores(options: StoreSearchOptions = {}): Promise<Store[]> {
    const selection = nearbyStoreOptions(options);
    const base = this.gatewayBase.replace(/\/$/, '');
    const url =
      selection.latitude === undefined
        ? new URL(`${base}/stores`)
        : new URL(
            `${base}/near/${selection.latitude}/${selection.longitude}/${selection.range}/${selection.limit}/stores`
          );
    const localFilter =
      selection.fullTextSearch !== undefined || selection.postcode !== undefined;
    if (selection.latitude === undefined) {
      url.searchParams.set('Take', String(localFilter ? STORE_LOOKUP_MAX : selection.limit));
      if (!localFilter && selection.offset > 0) {
        url.searchParams.set('Skip', String(selection.offset));
      }
      if (selection.retailerStoreId) {
        url.searchParams.set('RetailerStoreId', selection.retailerStoreId);
      }
    } else {
      url.searchParams.set('shoppingModeId', SHOPPING_MODE_IDS[selection.shoppingMode!]);
    }

    const stores: Store[] = [];
    const seenPages = new Set<string>();
    const seenStoreIds = new Set<string>();
    let skip = 0;
    let pageCount = 0;
    let expectedTotal: number | undefined;
    while (true) {
      if (pageCount >= MAX_STORE_PAGES) {
        throw new ProviderProtocolError(
          'Dunnes Ireland stores',
          `pagination exceeded ${MAX_STORE_PAGES} pages`
        );
      }
      pageCount += 1;
      const pageUrl = new URL(url);
      if (selection.latitude === undefined && localFilter && skip > 0) {
        pageUrl.searchParams.set('Skip', String(skip));
      }
      const payload = await jsonResponse<unknown>(
        await this.fetcher(pageUrl, { headers: { Accept: 'application/json' } }),
        'Dunnes Ireland stores'
      );
      const root = asRecord(payload);
      const source = field(root, 'items');
      const rows = requireRecordArray(source, 'Dunnes Ireland stores', 'items collection');
      const pageStores = rows
        .map(gatewayStore)
        .filter((store): store is Store => store !== undefined);
      if (Array.isArray(source) && source.length > 0 && pageStores.length === 0) {
        throw new ProviderProtocolError(
          'Dunnes Ireland stores',
          'items collection contained no valid stores'
        );
      }
      if (pageStores.length > 0) {
        const signature = pageStores.map((store) => store.store_id).join('\u0000');
        if (seenPages.has(signature)) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination repeated a page'
          );
        }
        seenPages.add(signature);
      }
      stores.push(...pageStores);
      const total = firstNumber(field(root, 'total'));
      if (localFilter) {
        if (!Number.isInteger(total) || total! < 0) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination total must be a non-negative integer'
          );
        }
        if (expectedTotal === undefined) expectedTotal = total;
        else if (total !== expectedTotal) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination total changed between pages'
          );
        }
        for (const store of pageStores) {
          if (seenStoreIds.has(store.store_id)) {
            throw new ProviderProtocolError(
              'Dunnes Ireland stores',
              'pagination returned overlapping store ids'
            );
          }
          seenStoreIds.add(store.store_id);
        }
        const received = skip + rows.length;
        if (received > expectedTotal!) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination total is smaller than received records'
          );
        }
        if (rows.length === 0 && received < expectedTotal!) {
          throw new ProviderProtocolError(
            'Dunnes Ireland stores',
            'pagination ended before the declared total'
          );
        }
      }
      if (
        !localFilter ||
        selection.latitude !== undefined ||
        rows.length === 0 ||
        skip + rows.length >= expectedTotal!
      ) {
        break;
      }
      skip += rows.length;
    }

    if (
      selection.retailerStoreId &&
      !stores.some((store) => store.store_id === selection.retailerStoreId)
    ) {
      throw new ProviderInputError(
        `Dunnes Ireland retailer store ${selection.retailerStoreId} was not found`
      );
    }
    const filtered = stores.filter((store) =>
      storeMatches(store, selection.fullTextSearch, selection.postcode)
    );
    const offset = localFilter || selection.latitude !== undefined ? selection.offset : 0;
    return filtered.slice(offset, offset + selection.limit);
  }

  async selectStore(storeId: string): Promise<void> {
    const selectedStoreId = normalizedStoreId(storeId);
    await this.listStores({ retailerStoreId: selectedStoreId, limit: 1 });
    this.storeId = selectedStoreId;
  }

  private async searchVtex(
    query: string,
    options: SearchOptions
  ): Promise<Product[]> {
    const normalizedQuery = requireQuery(query);
    const limit = clampLimit(options.limit, 10, 50);
    const offset = clampOffset(options.offset);
    const to = offset + limit - 1;
    const document = `
      query SearchDunnesIreland {
        productSearch(fullText: ${JSON.stringify(normalizedQuery)}, from: ${offset}, to: ${to})
          @context(provider: "vtex.search-graphql@0.72.0") {
          products {
            productId
            productName
            productReference
            items {
              itemId
              images { imageUrl imageTag }
              sellers {
                commertialOffer { Price ListPrice AvailableQuantity }
              }
            }
          }
        }
      }
    `;

    const payload = await jsonResponse<unknown>(
      await this.fetcher(this.vtexEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Accept-Language': 'en-IE,en;q=0.9',
        },
        body: JSON.stringify({ query: document }),
      }),
      'Dunnes Ireland VTEX'
    );
    const root = asRecord(payload);
    const errors = asRecords(root.errors);
    if (errors.length > 0) {
      throw new ProviderProtocolError(
        'Dunnes Ireland VTEX',
        firstString(errors[0]?.message) ?? 'GraphQL returned an error'
      );
    }
    const data = asRecord(root.data);
    const search = asRecord(data.productSearch);
    const source = search.products;
    const rows = requireRecordArray(
      source,
      'Dunnes Ireland VTEX',
      'data.productSearch.products collection'
    );
    const products = rows
      .map(vtexProduct)
      .filter((product): product is Product => product !== undefined);
    if (Array.isArray(source) && source.length > 0 && products.length === 0) {
      throw new ProviderProtocolError(
        'Dunnes Ireland VTEX',
        'products collection contained no valid products'
      );
    }
    return products.slice(0, limit);
  }

  private async searchGateway(
    query: string,
    options: SearchOptions
  ): Promise<Product[]> {
    if (!this.storeId) {
      throw new ProviderInputError(
        'Dunnes gateway search is store-scoped. Set DUNNES_IE_STORE_ID or pass storeId.'
      );
    }
    const normalizedQuery = requireQuery(query);
    const limit = clampLimit(options.limit, 10, 50);
    const offset = clampOffset(options.offset);
    const url = new URL(
      `${this.gatewayBase.replace(/\/$/, '')}/stores/${encodeURIComponent(this.storeId)}/search`
    );
    url.searchParams.set('q', normalizedQuery);
    url.searchParams.set('take', String(limit));
    url.searchParams.set('skip', String(offset));
    url.searchParams.set('page', String(Math.floor(offset / limit) + 1));

    const payload = await jsonResponse<unknown>(
      await this.fetcher(url, {
        headers: {
          Accept: 'application/json',
          'x-site-host': SITE_URL,
          'x-site-location': 'HeadersBuilderInterceptor',
          'x-correlation-id': uuid(),
          'x-shopping-mode': '22222222-2222-2222-2222-222222222222',
          Origin: SITE_URL,
          Referer: `${SITE_URL}/`,
          ...(this.cookieHeader ? { Cookie: this.cookieHeader } : {}),
        },
      }),
      'Dunnes Ireland gateway'
    );
    const root = asRecord(payload);
    const source = root.items;
    const rows = requireRecordArray(
      source,
      'Dunnes Ireland gateway',
      'items collection'
    );
    const products = rows
      .map(gatewayProduct)
      .filter((product): product is Product => product !== undefined);
    if (Array.isArray(source) && source.length > 0 && products.length === 0) {
      throw new ProviderProtocolError(
        'Dunnes Ireland gateway',
        'items collection contained no valid products'
      );
    }
    return products.slice(0, limit);
  }
}
