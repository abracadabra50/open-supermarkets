/**
 * SuperValu Ireland — store-scoped catalogue search.
 *
 * Prices and assortment vary by retailer/store. The provider refuses to run
 * without an explicit store id rather than presenting one store as national.
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
  parseUnitPrice,
  ProviderInputError,
  ProviderProtocolError,
  requireRecordArray,
  requireQuery,
} from './ie/shared';

const BASE_URL = 'https://shop.supervalu.ie';
const GATEWAY_BASE = 'https://storefrontgateway.supervalu.ie/api';
const STORE_LOOKUP_LIMIT = 20;
const STORE_LOOKUP_MAX = 100;
const MAX_STORE_PAGES = 10;
const DEFAULT_NEARBY_RANGE_KM = 10;
const SHOPPING_MODE_IDS = {
  pickup: '11111111-1111-1111-1111-111111111111',
  delivery: '22222222-2222-2222-2222-222222222222',
} as const;

export interface SuperValuIrelandOptions {
  storeId?: string;
  cookieHeader?: string;
  fetcher?: FetchLike;
  gatewayBase?: string;
}

function mapProduct(item: Record<string, unknown>): Product | undefined {
  const name = firstString(item.name, item.title, item.productName);
  const id = firstString(item.id, item.productId, item.sku);
  const price = firstNumber(
    item.priceNumeric,
    item.currentPrice,
    item.price,
    asRecord(item.price).value
  );
  if (!id || !name || price === undefined) return undefined;
  const promotions = asRecords(item.promotions);
  const promotion = promotions[0];

  return {
    product_uid: id,
    name,
    retail_price: { price },
    unit_price: parseUnitPrice(
      firstString(item.pricePerUnit, item.unitPrice, item.unitPriceText)
    ),
    in_stock: explicitBooleanState(
      item.available,
      typeof item.outOfStock === 'boolean' ? !item.outOfStock : undefined
    ),
    image_url: absoluteUrl(
      BASE_URL,
      firstString(item.imageUrl, item.image, asRecord(item.image).url)
    ),
    provider: 'supervalu-ie',
    currency: 'EUR',
    size: firstString(item.size, item.packSize),
    // Promotion details are intentionally not forced into Product because the
    // current upstream interface has no promotion field.
    description:
      firstString(item.description) ?? firstString(promotion?.description),
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

export class SuperValuIrelandProvider implements GroceryProvider {
  readonly name = 'supervalu-ie';
  private storeId?: string;
  private readonly cookieHeader?: string;
  private readonly fetcher: FetchLike;
  private readonly gatewayBase: string;

  constructor(options: SuperValuIrelandOptions = {}) {
    this.storeId =
      options.storeId ??
      env('SUPERMARKET_SUPERVALU_STORE_ID') ??
      env('SUPERVALU_STORE_ID');
    this.cookieHeader =
      options.cookieHeader ?? env('SUPERMARKET_SUPERVALU_COOKIE_HEADER');
    this.fetcher = options.fetcher ?? fetch;
    this.gatewayBase = options.gatewayBase ?? GATEWAY_BASE;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    if (!this.storeId) {
      throw new ProviderInputError(
        'SuperValu Ireland requires a store id. Set SUPERMARKET_SUPERVALU_STORE_ID.'
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

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      'Accept-Language': 'en-IE,en;q=0.9',
    };
    if (this.cookieHeader) headers.Cookie = this.cookieHeader;

    const payload = await jsonResponse<unknown>(
      await this.fetcher(url, { headers }),
      'SuperValu Ireland'
    );
    const root = asRecord(payload);
    const branches = ['items', 'products', 'results'] as const;
    const presentBranches = branches.filter((candidate) =>
      Object.prototype.hasOwnProperty.call(root, candidate)
    );
    const malformedBranch = presentBranches.find(
      (candidate) => !Array.isArray(root[candidate])
    );
    if (malformedBranch) {
      requireRecordArray(
        root[malformedBranch],
        'SuperValu Ireland',
        `${malformedBranch} collection`
      );
    }
    const branch =
      branches.find(
        (candidate) => Array.isArray(root[candidate]) && root[candidate].length > 0
      ) ?? presentBranches[0];
    if (!branch) {
      throw new ProviderProtocolError(
        'SuperValu Ireland',
        'missing or malformed product collection'
      );
    }
    const source = root[branch];
    const rows = requireRecordArray(
      source,
      'SuperValu Ireland',
      `${branch} collection`
    );
    const products = rows
      .map(mapProduct)
      .filter((product): product is Product => product !== undefined);
    if (Array.isArray(source) && source.length > 0 && products.length === 0) {
      throw new ProviderProtocolError(
        'SuperValu Ireland',
        `${branch} collection contained no valid products`
      );
    }
    return products.slice(0, limit);
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
          'SuperValu Ireland stores',
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
        'SuperValu Ireland stores'
      );
      const root = asRecord(payload);
      const source = field(root, 'items');
      const rows = requireRecordArray(source, 'SuperValu Ireland stores', 'items collection');
      const pageStores = rows
        .map(gatewayStore)
        .filter((store): store is Store => store !== undefined);
      if (Array.isArray(source) && source.length > 0 && pageStores.length === 0) {
        throw new ProviderProtocolError(
          'SuperValu Ireland stores',
          'items collection contained no valid stores'
        );
      }
      if (pageStores.length > 0) {
        const signature = pageStores.map((store) => store.store_id).join('\u0000');
        if (seenPages.has(signature)) {
          throw new ProviderProtocolError(
            'SuperValu Ireland stores',
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
            'SuperValu Ireland stores',
            'pagination total must be a non-negative integer'
          );
        }
        if (expectedTotal === undefined) expectedTotal = total;
        else if (total !== expectedTotal) {
          throw new ProviderProtocolError(
            'SuperValu Ireland stores',
            'pagination total changed between pages'
          );
        }
        for (const store of pageStores) {
          if (seenStoreIds.has(store.store_id)) {
            throw new ProviderProtocolError(
              'SuperValu Ireland stores',
              'pagination returned overlapping store ids'
            );
          }
          seenStoreIds.add(store.store_id);
        }
        const received = skip + rows.length;
        if (received > expectedTotal!) {
          throw new ProviderProtocolError(
            'SuperValu Ireland stores',
            'pagination total is smaller than received records'
          );
        }
        if (rows.length === 0 && received < expectedTotal!) {
          throw new ProviderProtocolError(
            'SuperValu Ireland stores',
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
        `SuperValu Ireland retailer store ${selection.retailerStoreId} was not found`
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
}
