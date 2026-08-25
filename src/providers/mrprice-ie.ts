/**
 * Mr Price Ireland — Shopify search.
 *
 * Protocol credit: but3k4/supermarket-mcp (MIT).
 */
import type { GroceryProvider, Product, SearchOptions } from './types';
import {
  absoluteUrl,
  asNumber,
  asRecord,
  clampLimit,
  clampOffset,
  compactSnippet,
  firstString,
  type FetchLike,
  htmlText,
  jsonResponse,
  ProviderHttpError,
  ProviderProtocolError,
  requireRecordArray,
  requireQuery,
  responseText,
} from './ie/shared';

const BASE_URL = 'https://www.mrprice.online';

export interface MrPriceIrelandOptions {
  fetcher?: FetchLike;
  baseUrl?: string;
}

function shopifyMoney(value: unknown): number | undefined {
  const parsed = asNumber(value);
  if (parsed === undefined || parsed < 0) return undefined;

  // Shopify JSON and data-price values are usually integer cents. Decimal
  // strings/numbers are already euro values. Keep the raw type/text here so
  // that a decimal string such as "1.00" is not mistaken for one cent.
  if (typeof value === 'number') return Number.isInteger(value) ? value / 100 : value;
  if (typeof value === 'string') {
    return /[.,]/.test(value) ? parsed : parsed / 100;
  }
  return undefined;
}

function mapPredictiveProduct(
  item: Record<string, unknown>,
  baseUrl: string
): Product | undefined {
  const name = firstString(item.title, item.name);
  const url = absoluteUrl(baseUrl, firstString(item.url));
  const price = shopifyMoney(item.price);
  if (!name || !url || price === undefined) return undefined;
  const id = firstString(item.id, item.handle, url) ?? url;
  return {
    product_uid: id,
    name,
    retail_price: { price },
    in_stock: typeof item.available === 'boolean' ? item.available : null,
    image_url: absoluteUrl(
      baseUrl,
      firstString(asRecord(item.featured_image).url, item.image)
    ),
    provider: 'mrprice-ie',
    currency: 'EUR',
  };
}

function extractAttribute(tag: string, attribute: string): string | undefined {
  const match = tag.match(new RegExp(`${attribute}=["']([^"']+)["']`, 'i'));
  return match?.[1];
}

function mapHtmlCard(card: string, baseUrl: string): Product | undefined {
  const anchorMatch = card.match(/<a\b[^>]*href=["'][^"']*\/products\/[^"']+["'][^>]*>/i);
  const anchor = anchorMatch?.[0];
  const anchorStart = anchorMatch?.index;
  if (!anchor || anchorStart === undefined) return undefined;
  const href = extractAttribute(anchor, 'href');
  const url = absoluteUrl(baseUrl, href?.split('?')[0]);
  if (!url) return undefined;

  const title = extractAttribute(anchor, 'title');
  const anchorClose = card.toLowerCase().indexOf('</a>', anchorStart + anchor.length);
  const anchorText =
    anchorClose >= 0 ? htmlText(card.slice(anchorStart + anchor.length, anchorClose)) : '';
  const name = (title ? htmlText(title) : '') || anchorText;
  if (!name) return undefined;

  const openTag = card.match(/<[^>]+class=["'][^"']*product-card[^"']*["'][^>]*>/i)?.[0] ?? '';
  const cents = extractAttribute(openTag, 'data-price');
  const price = shopifyMoney(cents);
  if (price === undefined) return undefined;
  const imageTag = card.match(/<img\b[^>]*>/i)?.[0];
  const image = imageTag
    ? absoluteUrl(
        baseUrl,
        extractAttribute(imageTag, 'data-src')
          ?.replace('{width}', '400')
          .replace(/^\/\//, 'https://') ?? extractAttribute(imageTag, 'src')
      )
    : undefined;
  const soldOut = /(?:^|\s)(?:sold-out|out-of-stock|unavailable)(?:\s|$)/i.test(
    extractAttribute(openTag, 'class') ?? ''
  );

  return {
    product_uid: url,
    name,
    retail_price: { price },
    in_stock: soldOut ? false : null,
    image_url: image,
    provider: 'mrprice-ie',
    currency: 'EUR',
  };
}

function extractSearchGrid(html: string): string {
  const marker = html.match(
    /<([a-z][\w:-]*)\b[^>]*\bid\s*=\s*["']js-product-ajax["'][^>]*>/i
  );
  if (!marker || marker.index === undefined) {
    throw new ProviderProtocolError(
      'Mr Price Ireland',
      'HTML response did not contain the search results grid'
    );
  }

  const tagName = marker[1]!;
  const contentStart = marker.index + marker[0].length;
  const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tags.lastIndex = contentStart;
  let depth = 1;
  for (const match of html.matchAll(tags)) {
    const tag = match[0];
    if (tag.startsWith('</')) {
      depth -= 1;
    } else if (!/\/\s*>$/.test(tag)) {
      depth += 1;
    }
    if (depth === 0) {
      return html.slice(contentStart, match.index);
    }
  }

  throw new ProviderProtocolError(
    'Mr Price Ireland',
    'HTML search results grid was not closed'
  );
}

function parseHtmlProducts(
  html: string,
  baseUrl: string,
  limit: number,
  offset: number
): Product[] {
  const grid = extractSearchGrid(html);
  const starts = [...grid.matchAll(/<[^>]+class=["'][^"']*\bproduct-card\b[^"']*["'][^>]*>/gi)]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined);
  const cards = starts.map((start, index) =>
    grid.slice(start, starts[index + 1] ?? grid.length)
  );
  const products = cards
    .map((card) => mapHtmlCard(card, baseUrl))
    .filter((product): product is Product => product !== undefined);
  if (cards.length > 0 && products.length === 0) {
    throw new ProviderProtocolError(
      'Mr Price Ireland',
      'HTML product-card collection contained no valid products'
    );
  }
  return products.slice(offset, offset + limit);
}

function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderProtocolError('Mr Price Ireland', `missing or malformed ${path}`);
  }
  return value as Record<string, unknown>;
}

function predictiveProducts(payload: unknown, baseUrl: string): Product[] {
  const root = objectRecord(payload, 'predictive response');
  const resources = objectRecord(root.resources, 'resources branch');
  const results = objectRecord(resources.results, 'results branch');
  const source = results.products;
  const rows = requireRecordArray(source, 'Mr Price Ireland', 'products collection');

  const products = rows
    .map((item) => mapPredictiveProduct(item, baseUrl))
    .filter((product): product is Product => product !== undefined);
  if (Array.isArray(source) && source.length > 0 && products.length === 0) {
    throw new ProviderProtocolError(
      'Mr Price Ireland',
      'products collection contained no valid products'
    );
  }
  return products;
}

export class MrPriceIrelandProvider implements GroceryProvider {
  readonly name = 'mrprice-ie';
  private readonly fetcher: FetchLike;
  private readonly baseUrl: string;

  constructor(options: MrPriceIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const normalizedQuery = requireQuery(query);
    const limit = clampLimit(options.limit, 10, 20);
    const offset = clampOffset(options.offset);
    const predictiveLimit = Math.min(offset + limit, 20);

    const suggestionUrl = new URL('/search/suggest.json', this.baseUrl);
    suggestionUrl.searchParams.set('q', normalizedQuery);
    suggestionUrl.searchParams.set('resources[type]', 'product');
    suggestionUrl.searchParams.set('resources[limit]', String(predictiveLimit));

    const suggestionResponse = await this.fetcher(suggestionUrl, {
      headers: { Accept: 'application/json' },
    });

    if (suggestionResponse.ok) {
      const payload = await jsonResponse<unknown>(suggestionResponse, 'Mr Price Ireland');
      const predictive = predictiveProducts(payload, this.baseUrl);
      const predictiveWindowFitsCap = offset <= 20 - limit;
      if (offset < predictive.length && predictiveWindowFitsCap) {
        return predictive.slice(offset, offset + limit);
      }
    } else if (![404, 410].includes(suggestionResponse.status)) {
      const body = await responseText(suggestionResponse);
      throw new ProviderHttpError(
        'Mr Price Ireland',
        suggestionResponse.status,
        compactSnippet(body)
      );
    }

    // Shopify's predictive endpoint is narrower than its full search page.
    const htmlUrl = new URL('/search', this.baseUrl);
    htmlUrl.searchParams.set('type', 'product');
    htmlUrl.searchParams.set('q', normalizedQuery);
    const response = await this.fetcher(htmlUrl, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    const html = await responseText(response);
    if (!response.ok) {
      throw new ProviderHttpError('Mr Price Ireland', response.status, compactSnippet(html));
    }
    return parseHtmlProducts(html, this.baseUrl, limit, offset);
  }
}
