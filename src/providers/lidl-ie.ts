/**
 * Lidl Ireland — anonymous Mindshift catalogue search.
 *
 * Protocol credit: AviBackToBlack/lidaldi (MIT).
 */
import type { GroceryProvider, Product, SearchOptions } from './types';
import {
  absoluteUrl,
  asNumber,
  asRecord,
  asRecords,
  clampLimit,
  clampOffset,
  explicitBooleanState,
  firstString,
  type FetchLike,
  jsonResponse,
  ProviderProtocolError,
  requireRecordArray,
  requireQuery,
} from './ie/shared';

const SEARCH_URL = 'https://www.lidl.ie/q/api/search';
const BASE_URL = 'https://www.lidl.ie';
const ACCEPT = 'application/mindshift.search+json';
const REQUEST_TIMEOUT_MS = 15_000;

export interface LidlIrelandOptions {
  fetcher?: FetchLike;
  searchUrl?: string;
  apiVersion?: string;
}

// Accept only complete, non-negative amounts. Stripping arbitrary text
// can turn malformed values into a plausible shelf price.
function firstPrice(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'string' && !/^(?:(?:€|EUR)\s*[\d.,]+|[\d.,]+\s*(?:€|EUR)|[\d.,]+)$/i.test(value.trim())) continue;
    const amount = asNumber(value);
    if (amount !== undefined && Number.isFinite(amount) && amount >= 0) return amount;
  }
  return undefined;
}

function conditionalPrice(price: Record<string, unknown>): boolean {
  const discount = asRecord(price.discount);
  const text = firstString(discount.discountText) ?? '';
  return discount.fromNormalPriceForLidlPlus === true ||
    /mix\s*(?:['’]?n['’]?|and|&)\s*match|multi[- ]?buy|\bbuy\s+\d+\b|\d+\s+for\b|lidl\s*plus/i.test(text);
}

function regularOldPrice(price: Record<string, unknown>): number | undefined {
  // A recommended retail price is not evidence of this retailer's price.
  if (asRecord(price.discount).fromRecommendedPrice === true) return undefined;
  return firstPrice(price.oldPrice);
}

function stockState(data: Record<string, unknown>): boolean | null {
  const availability = asRecord(data.stockAvailability);
  const badgeInfo = asRecord(availability.badgeInfo);
  const signals = asRecords(badgeInfo.badges).flatMap((badge) => {
    const text = (firstString(badge.text, badge.label) ?? '').trim();
    // Match complete status labels. A sentence such as 'Not in stock' or
    // 'Back in stock soon' must never become a positive stock signal.
    if (/^(?:sold out|out of stock|unavailable|not in stock|no longer in stock)[.!]?$/i.test(text)) return [false];
    if (/^in stock[.!]?$/i.test(text)) return [true];
    return [];
  });
  return explicitBooleanState(...signals);
}

function mapProduct(item: Record<string, unknown>): Product | undefined {
  const gridbox = asRecord(item.gridbox);
  const data = asRecord(gridbox.data);
  // Lidl sometimes emits placeholder brands such as `---` or `-` at the
  // start of fullTitle. They are not part of the customer-facing product name.
  const name = firstString(data.fullTitle, data.title, data.name)
    ?.replace(/^-{1,3}\s+/, '')
    .trim();
  if (!name) return undefined;

  const price = asRecord(data.price);
  const regionsPrices = asRecord(data.regionsPrices);
  const regionPrice = asRecord(regionsPrices['1']);
  const currentPrice = asRecord(regionPrice.currentPrice);
  const hasRegionalPrice = Object.prototype.hasOwnProperty.call(regionPrice, 'currentPrice');
  if (hasRegionalPrice && firstPrice(currentPrice.price) === undefined) return undefined;
  // Offer terms can appear only on the regional price while data.price
  // repeats the discounted amount. A multibuy is not a single-item price.
  const conditional = conditionalPrice(price) || conditionalPrice(currentPrice);
  let productPrice: number | undefined;
  if (conditional) {
    // The generic price can repeat the regional RRP without its marker.
    if (asRecord(currentPrice.discount).fromRecommendedPrice !== true) {
      productPrice = Object.prototype.hasOwnProperty.call(currentPrice, 'oldPrice')
        ? regularOldPrice(currentPrice) : regularOldPrice(price);
    }
  } else {
    productPrice = hasRegionalPrice
      ? firstPrice(currentPrice.price) : firstPrice(price.price);
  }
  const canonicalPath = firstString(data.canonicalUrl, data.url);
  const id = [data.id, data.productId, data.code, canonicalPath]
    .map((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value) : firstString(value))
    .find((value) => value !== undefined);
  if (!id || productPrice === undefined) return undefined;
  const pricePerUnit = asRecord(data.pricePerUnit);
  // Generic unit prices are trustworthy only when the selected shelf price
  // matches their generic price context. Otherwise omit the optional field.
  const matchingUnitContext = !hasRegionalPrice || firstPrice(price.price) === productPrice;
  const unitPrice = conditional || !matchingUnitContext
    ? undefined : firstPrice(pricePerUnit.price, data.basePrice);
  const unitMeasure = firstString(
    pricePerUnit.unit,
    pricePerUnit.unitOfMeasure,
    data.basePriceUnit
  );

  return {
    product_uid: id,
    name,
    retail_price: { price: productPrice },
    unit_price:
      unitPrice !== undefined && unitMeasure
        ? { price: unitPrice, measure: unitMeasure }
        : undefined,
    in_stock: stockState(data),
    image_url: absoluteUrl(BASE_URL, firstString(data.image, data.imageUrl)),
    provider: 'lidl-ie',
    currency: 'EUR',
    size: firstString(data.packaging, data.packSize, data.quantity),
  };
}

export class LidlIrelandProvider implements GroceryProvider {
  readonly name = 'lidl-ie';
  private readonly fetcher: FetchLike;
  private readonly searchUrl: string;
  private readonly apiVersion: string;

  constructor(options: LidlIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.searchUrl = options.searchUrl ?? SEARCH_URL;
    this.apiVersion = options.apiVersion ?? '2.1.0';
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalizedQuery = requireQuery(query);
    const limit = clampLimit(options.limit, 10, 100);
    const offset = clampOffset(options.offset);
    const url = new URL(this.searchUrl);
    url.searchParams.set('assortment', 'IE');
    url.searchParams.set('category.id', '10068374');
    url.searchParams.set('locale', 'en_IE');
    url.searchParams.set('q', normalizedQuery);
    url.searchParams.set('version', this.apiVersion);
    url.searchParams.set('fetchsize', String(limit));
    url.searchParams.set('offset', String(offset));

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let payload: unknown;
    try {
      payload = await jsonResponse<unknown>(
        await this.fetcher(url, {
          signal,
          headers: {
            Accept: ACCEPT,
            'Accept-Language': 'en-IE,en;q=0.9',
          },
        }),
        'Lidl Ireland'
      );
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new Error(`Lidl Ireland request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      }
      throw error;
    }
    const root = asRecord(payload);
    const source = root.items;
    const rows = requireRecordArray(source, 'Lidl Ireland', 'items collection');
    const products = rows
      .map(mapProduct)
      .filter((product): product is Product => product !== undefined);
    if (Array.isArray(source) && source.length > 0 && products.length === 0) {
      throw new ProviderProtocolError(
        'Lidl Ireland',
        'items collection contained no valid products'
      );
    }
    return products.slice(0, limit);
  }
}
