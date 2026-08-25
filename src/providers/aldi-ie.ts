/**
 * Aldi Ireland — anonymous catalogue search.
 *
 * Primary protocol evidence:
 * - AviBackToBlack/lidaldi (MIT)
 * - but3k4/supermarket-mcp (MIT)
 * - fwhite2104/drinks-tracker (unlicensed; facts only, no copied code)
 */
import type {
  GroceryProvider,
  Product,
  SearchOptions,
  Store,
  StoreSearchOptions,
} from './types';
import {
  asRecord,
  asRecords,
  clampLimit,
  clampOffset,
  env,
  explicitBooleanState,
  firstNumber,
  firstString,
  type FetchLike,
  joinBrandAndName,
  jsonResponse,
  parseUnitPrice,
  ProviderHttpError,
  ProviderInputError,
  ProviderProtocolError,
  requireRecordArray,
  requireQuery,
} from './ie/shared';

const PRIMARY_SEARCH = 'https://asl.api.aldi.ie/commerce/v3/product-search';
const LEGACY_SEARCH = 'https://api.aldi.ie/v3/product-search';
const SERVICE_POINTS = 'https://asl.api.aldi.ie/commerce/v2/service-points';
const PRODUCT_PAGE = 'https://www.aldi.ie/product/';
const ALLOWED_PAGE_SIZES = [12, 16, 24, 30, 32, 48, 60] as const;
const STORE_LOOKUP_LIMIT = 20;
const STORE_LOOKUP_MAX = 100;

export interface AldiIrelandOptions {
  fetcher?: FetchLike;
  primarySearchUrl?: string;
  legacySearchUrl?: string;
  servicePointsUrl?: string;
  storeId?: string;
}

function pageSize(limit: number): number {
  return ALLOWED_PAGE_SIZES.find((size) => size >= limit) ?? 60;
}

function imageUrl(item: Record<string, unknown>): string | undefined {
  const asset = asRecords(item.assets)[0];
  const template = firstString(asset?.url);
  const slug = firstString(item.urlSlugText) ?? 'image';
  return template
    ?.replace('{width}', '600')
    .replace('{slug}', encodeURIComponent(slug));
}

function retailPrice(item: Record<string, unknown>): number | undefined {
  const price = asRecord(item.price);
  // The live Aldi response includes both an integer minor-unit amount and a
  // display value. Prefer the display value because it is already in EUR.
  const display = firstNumber(price.amountRelevantDisplay, price.amountDisplay);
  if (display !== undefined) return display;

  // Keep the documented numeric fallback in minor units (for example 139 is
  // €1.39). Other legacy amount values are retained as euro values.
  const minorUnits = firstNumber(price.amountRelevant);
  if (minorUnits !== undefined) return minorUnits / 100;
  return firstNumber(price.amount, item.price);
}

function mapProduct(item: Record<string, unknown>): Product | undefined {
  const sku = firstString(item.sku, item.productId, item.id);
  const amount = retailPrice(item);
  const price = asRecord(item.price);
  const comparison = firstString(price.comparisonDisplay, item.comparisonDisplay);
  const rawName = firstString(item.name);
  if (!sku || !rawName || amount === undefined) return undefined;
  const name = joinBrandAndName(item.brandName, rawName);

  return {
    product_uid: sku,
    name,
    description: firstString(item.description),
    retail_price: { price: amount },
    unit_price: parseUnitPrice(comparison),
    // Catalogue publication, opening hours, and a store's sellability do not
    // prove stock. Only an explicit product-level availability field may do so.
    in_stock: explicitBooleanState(
      item.available,
      typeof item.outOfStock === 'boolean' ? !item.outOfStock : undefined
    ),
    image_url: imageUrl(item),
    provider: 'aldi-ie',
    currency: 'EUR',
    size: firstString(item.sellingSize, item.packSize),
  };
}

function normalizedStoreId(value: unknown): string {
  const storeId = firstString(value)?.toUpperCase();
  if (!storeId) throw new ProviderInputError('storeId must be a non-empty string');
  return storeId;
}

function normalizedModes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modes = new Set<string>();
  for (const candidate of value) {
    const record = asRecord(candidate);
    const mode = firstString(candidate, record.name, record.mode, record.serviceType);
    if (mode) modes.add(mode.toLowerCase());
  }
  return modes.size > 0 ? [...modes] : undefined;
}

function aldiStore(item: Record<string, unknown>): Store | undefined {
  const servicePoint = asRecord(item.servicePoint);
  const storeId = firstString(item.servicePoint, servicePoint.id, item.id);
  const addressRecord = asRecord(item.address);
  const location = asRecord(item.location);
  const coordinates = asRecord(item.coordinates);
  const latitude = firstNumber(
    item.latitude,
    addressRecord.latitude,
    location.latitude,
    coordinates.latitude,
    coordinates.lat
  );
  const longitude = firstNumber(
    item.longitude,
    addressRecord.longitude,
    location.longitude,
    coordinates.longitude,
    coordinates.lng
  );
  const addressParts = [
    addressRecord.address1,
    addressRecord.address2,
    addressRecord.address3,
    addressRecord.addressLine1,
    addressRecord.addressLine2,
    addressRecord.street,
    addressRecord.city,
    addressRecord.county,
    addressRecord.regionName,
    addressRecord.countryName,
    addressRecord.country,
  ]
    .map((value) => firstString(value))
    .filter((value): value is string => value !== undefined);
  const seenAddressParts = new Set<string>();
  const address = addressParts
    .filter((value) => {
      const key = value.toLowerCase();
      if (seenAddressParts.has(key)) return false;
      seenAddressParts.add(key);
      return true;
    })
    .join(', ');
  const name = firstString(item.name, item.displayName, servicePoint.name);
  if (!storeId || !name) return undefined;
  return {
    store_id: normalizedStoreId(storeId),
    name,
    ...(firstString(item.status, item.state)
      ? { status: firstString(item.status, item.state)!.toLowerCase() }
      : {}),
    postcode: firstString(
      item.postcode,
      item.postalCode,
      addressRecord.zipCode,
      addressRecord.postcode,
      addressRecord.postalCode
    )?.toUpperCase(),
    address: address || firstString(item.address),
    location: latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
    shopping_modes: normalizedModes(
      item.availableCustomerServiceTypes ?? item.serviceTypes ?? item.shoppingModes ?? item.serviceType
    ),
  };
}

function storeLookupOptions(options: StoreSearchOptions): {
  limit: number;
  offset: number;
  fullTextSearch?: string;
  postcode?: string;
  latitude?: number;
  longitude?: number;
} {
  if (options.range !== undefined) {
    throw new ProviderInputError('Aldi store lookup does not support a range filter');
  }
  if (options.shoppingMode !== undefined) {
    throw new ProviderInputError(
      'Aldi Ireland exposes walk-in service points only; pickup and delivery filters are unsupported'
    );
  }
  if (options.retailerStoreId !== undefined) {
    throw new ProviderInputError(
      'Aldi store lookup does not support retailerStoreId filtering; use selectStore for validated selection'
    );
  }
  const limit = clampLimit(options.limit, STORE_LOOKUP_LIMIT, STORE_LOOKUP_MAX);
  const offset = clampOffset(options.offset);
  const fullTextSearch = options.fullTextSearch === undefined
    ? undefined
    : requireQuery(options.fullTextSearch);
  const postcode = options.postcode === undefined ? undefined : requireQuery(options.postcode);
  const coordinatesSpecified = options.latitude !== undefined || options.longitude !== undefined;
  if (fullTextSearch && postcode) {
    throw new ProviderInputError('fullTextSearch cannot be combined with postcode');
  }
  if (postcode && coordinatesSpecified) {
    throw new ProviderInputError('postcode cannot be combined with coordinates');
  }
  if (!coordinatesSpecified) return { limit, offset, fullTextSearch, postcode };
  if (fullTextSearch) {
    throw new ProviderInputError('fullTextSearch cannot be combined with coordinates');
  }
  if (
    options.latitude === undefined ||
    options.longitude === undefined ||
    !Number.isFinite(options.latitude) ||
    !Number.isFinite(options.longitude) ||
    options.latitude < -90 || options.latitude > 90 ||
    options.longitude < -180 || options.longitude > 180
  ) {
    throw new ProviderInputError('latitude and longitude must be valid coordinates');
  }
  return { limit, offset, postcode, latitude: options.latitude, longitude: options.longitude };
}

export class AldiIrelandProvider implements GroceryProvider {
  readonly name = 'aldi-ie';
  private readonly fetcher: FetchLike;
  private readonly searchUrls: readonly string[];
  private readonly servicePointsUrl: string;
  private storeId?: string;

  constructor(options: AldiIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.searchUrls = [
      options.primarySearchUrl ?? PRIMARY_SEARCH,
      options.legacySearchUrl ?? LEGACY_SEARCH,
    ];
    this.servicePointsUrl = options.servicePointsUrl ?? SERVICE_POINTS;
    const storeId = options.storeId ?? env('SUPERMARKET_ALDI_IE_STORE_ID') ?? env('ALDI_IE_SERVICE_POINT');
    this.storeId = storeId === undefined ? undefined : normalizedStoreId(storeId);
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalizedQuery = requireQuery(query);
    if (!this.storeId) {
      throw new ProviderInputError(
        'Aldi Ireland requires a store id. Pass --store-id or set SUPERMARKET_ALDI_IE_STORE_ID.'
      );
    }
    const limit = clampLimit(options.limit, 10, 60);
    const offset = clampOffset(options.offset);
    let lastError: unknown;

    for (let index = 0; index < this.searchUrls.length; index++) {
      const url = new URL(this.searchUrls[index]!);
      url.searchParams.set('q', normalizedQuery);
      url.searchParams.set('currency', 'EUR');
      url.searchParams.set('limit', String(pageSize(limit)));
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('serviceType', 'walk-in');
      url.searchParams.set('sort', 'RELEVANCE');
      if (this.storeId) url.searchParams.set('servicePoint', this.storeId);

      try {
        const payload = await jsonResponse<unknown>(
          await this.fetcher(url, {
            headers: {
              Accept: 'application/json',
              'Accept-Language': 'en-IE,en;q=0.9',
            },
          }),
          'Aldi Ireland'
        );
        const root = asRecord(payload);
        const source = root.data;
        const rows = requireRecordArray(source, 'Aldi Ireland', 'data collection');
        const products = rows
          .map(mapProduct)
          .filter((product): product is Product => product !== undefined);
        if (Array.isArray(source) && source.length > 0 && products.length === 0) {
          throw new ProviderProtocolError(
            'Aldi Ireland',
            'data collection contained no valid products'
          );
        }
        return products.slice(0, limit);
      } catch (error) {
        lastError = error;
        // The two known hosts are protocol variants. Only fall back when the
        // route is absent; do not turn a 403/429 into a second burst of traffic.
        if (
          index === 0 &&
          error instanceof ProviderHttpError &&
          (error.status === 404 || error.status === 410)
        ) {
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Aldi Ireland search failed');
  }

  async listStores(options: StoreSearchOptions = {}): Promise<Store[]> {
    const selection = storeLookupOptions(options);
    const url = new URL(this.servicePointsUrl);
    url.searchParams.set('offset', String(selection.offset));
    url.searchParams.set('limit', String(selection.limit));
    url.searchParams.set('serviceType', 'walk-in');
    if (selection.fullTextSearch) url.searchParams.set('fullTextSearch', selection.fullTextSearch);
    if (selection.postcode) url.searchParams.set('addressZipcode', selection.postcode);
    if (selection.latitude !== undefined) {
      url.searchParams.set('latitude', String(selection.latitude));
      url.searchParams.set('longitude', String(selection.longitude));
      url.searchParams.set('includeNearbyServicePoints', 'true');
    }
    const payload = await jsonResponse<unknown>(
      await this.fetcher(url, { headers: { Accept: 'application/json', 'Accept-Language': 'en-IE,en;q=0.9' } }),
      'Aldi Ireland stores'
    );
    const root = asRecord(payload);
    const data = asRecord(root.data);
    const source = Array.isArray(root.data)
      ? root.data
      : data.servicePoints ?? data.items ?? data.results;
    const rows = requireRecordArray(source, 'Aldi Ireland stores', 'service-point collection');
    const stores = rows.map(aldiStore).filter((store): store is Store => store !== undefined);
    if (rows.length > 0 && stores.length === 0) {
      throw new ProviderProtocolError('Aldi Ireland stores', 'service-point collection contained no valid stores');
    }
    return stores;
  }

  async selectStore(storeId: string): Promise<void> {
    const selectedStoreId = normalizedStoreId(storeId);
    for (let offset = 0; offset < 500; offset += STORE_LOOKUP_MAX) {
      const stores = await this.listStores({ limit: STORE_LOOKUP_MAX, offset });
      if (stores.some((store) => store.store_id === selectedStoreId)) {
        this.storeId = selectedStoreId;
        return;
      }
      if (stores.length < STORE_LOOKUP_MAX) break;
    }
    throw new ProviderInputError(`Aldi Ireland service point ${selectedStoreId} was not found`);
  }

  static productUrl(product: Product): string {
    return `${PRODUCT_PAGE}${encodeURIComponent(product.product_uid)}`;
  }
}
