/**
 * Lidl Ireland — anonymous Mindshift catalogue search.
 *
 * Protocol credit: AviBackToBlack/lidaldi (MIT).
 */
import type { GroceryProvider, Product, SearchOptions } from './types';
import {
  absoluteUrl,
  asRecord,
  asRecords,
  clampLimit,
  clampOffset,
  explicitBooleanState,
  firstNumber,
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

export interface LidlIrelandOptions {
  fetcher?: FetchLike;
  searchUrl?: string;
  apiVersion?: string;
}

function stockState(data: Record<string, unknown>): boolean | null {
  const availability = asRecord(data.stockAvailability);
  const badgeInfo = asRecord(availability.badgeInfo);
  const signals = asRecords(badgeInfo.badges).flatMap((badge) => {
    const text = firstString(badge.text, badge.label) ?? '';
    if (/sold out|out of stock|unavailable/i.test(text)) return [false];
    if (/\bin stock\b/i.test(text)) return [true];
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
  const currentLidlPlusPrice = asRecord(regionPrice.currentLidlPlusPrice);
  const currentLidlPlusPriceDetails = asRecord(currentLidlPlusPrice.price);
  // Lidl Plus is loyalty pricing. The common Product contract has no field
  // for it, so only its oldPrice (the regular price shown beside the offer)
  // may be used as a final fallback. Never map the loyalty price itself.
  const productPrice = firstNumber(
    price.price,
    currentPrice.price,
    currentLidlPlusPriceDetails.oldPrice
  );
  const canonicalPath = firstString(data.canonicalUrl, data.url);
  const id = firstString(data.id, data.productId, data.code, canonicalPath);
  if (!id || productPrice === undefined) return undefined;
  const pricePerUnit = asRecord(data.pricePerUnit);
  const unitPrice = firstNumber(pricePerUnit.price, data.basePrice);
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

    const payload = await jsonResponse<unknown>(
      await this.fetcher(url, {
        headers: {
          Accept: ACCEPT,
          'Accept-Language': 'en-IE,en;q=0.9',
        },
      }),
      'Lidl Ireland'
    );
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
