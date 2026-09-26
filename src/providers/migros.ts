/**
 * Migros Switzerland — browser-backed catalogue search.
 *
 * Migros serves a Cloudflare page to cold HTTP clients. A real Chromium page
 * receives a short-lived `leshopch` request header, which the product APIs
 * require in addition to the browser context. Keep the page alive for the
 * lifetime of the provider and make the JSON calls from that page; do not
 * scrape the rendered product cards.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright';
import type { GroceryProvider, Product, SearchOptions } from './types';

export const MIGROS = {
  id: 'migros',
  label: 'Migros',
  country: 'CH',
  currency: 'CHF',
} as const;

const BASE_URL = 'https://www.migros.ch';
const HOME_PATH = '/en';
const GUEST_PATH = '/authentication/public/v1/api/guest?authorizationNotRequired=true';
const SEARCH_PATH = '/product-display/public/v2/products/search';
const CARDS_PATH = '/product-display/public/v4/product-cards';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const REQUEST_TIMEOUT = 30_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface MigrosSearchItem {
  id: number | string;
  type?: string;
}

interface MigrosSearchResponse {
  items: MigrosSearchItem[];
  numberOfProducts: number;
  offset?: number;
}

interface MigrosPrice {
  effectiveValue?: number;
  advertisedValue?: number;
  unitPrice?: { unit?: string; value?: number };
}

interface MigrosProductCard {
  uid?: number | string;
  migrosId?: number | string;
  migrosOnlineId?: number | string;
  title?: string;
  name?: string;
  description?: string;
  quantity?: string;
  productAvailability?: string;
  images?: Array<{ url?: string }>;
  imageTransparent?: { url?: string };
  offer?: { price?: MigrosPrice };
}

interface PageJsonResult {
  status: number;
  contentType: string | null;
  body: string;
}

export class MigrosError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MigrosError';
    this.status = status;
  }
}

export interface MigrosSearchSession {
  search(query: string, options?: SearchOptions): Promise<Product[]>;
  close(): Promise<void>;
}

export type MigrosBrowserLauncher = (options: LaunchOptions) => Promise<Browser>;

function parseJson(body: string, label: string, status: number, contentType: string | null): any {
  if (!contentType?.toLowerCase().includes('json')) {
    throw new MigrosError(
      `Migros ${label} returned non-JSON content (HTTP ${status})`,
      status
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new MigrosError(`Migros ${label} returned invalid JSON (HTTP ${status})`, status);
  }
}

function assertResponse(result: PageJsonResult, label: string): any {
  if (result.status === 403) {
    throw new MigrosError(
      `Migros ${label} was blocked by Cloudflare (HTTP 403). Keep a live Playwright session.`,
      result.status
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new MigrosError(`Migros ${label} failed (HTTP ${result.status})`, result.status);
  }
  return parseJson(result.body, label, result.status, result.contentType);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

export function normaliseProduct(card: MigrosProductCard, provider = MIGROS.id): Product {
  const price = card.offer?.price;
  const retailPrice = numberOrUndefined(price?.effectiveValue ?? price?.advertisedValue) ?? 0;
  const unitPrice = numberOrUndefined(price?.unitPrice?.value);
  const availability = card.productAvailability;

  return {
    product_uid: String(card.migrosId ?? card.migrosOnlineId ?? card.uid ?? ''),
    name: String(card.title ?? card.name ?? card.description ?? ''),
    description: card.description || undefined,
    retail_price: { price: retailPrice },
    unit_price:
      unitPrice !== undefined && price?.unitPrice?.unit
        ? { price: unitPrice, measure: price.unitPrice.unit }
        : undefined,
    in_stock: typeof availability === 'string' && /ONLINE|IN_STOCK|AVAILABLE/i.test(availability),
    image_url: card.images?.find(image => image.url)?.url ?? card.imageTransparent?.url,
    provider,
    currency: MIGROS.currency,
    size: card.quantity || undefined,
  };
}

/** A browser context plus the JSON API calls made from its page. */
export class MigrosSession implements MigrosSearchSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private initialising?: Promise<void>;
  private leshopHeader?: string;

  constructor(private readonly launch: MigrosBrowserLauncher = options => chromium.launch(options)) {}

  private async initialise(): Promise<void> {
    if (this.page) return;
    if (this.initialising) return this.initialising;

    this.initialising = (async () => {
      try {
        this.browser = await this.launch({ headless: true });
        this.context = await this.browser.newContext({ userAgent: USER_AGENT, locale: 'en-CH' });
        this.page = await this.context.newPage();

        const home = await this.page.goto(`${BASE_URL}${HOME_PATH}`, {
          waitUntil: 'domcontentloaded',
          timeout: REQUEST_TIMEOUT,
        });
        if (!home || home.status() < 200 || home.status() >= 300) {
          const status = home?.status();
          throw new MigrosError(
            status === 403
              ? 'Migros home was blocked by Cloudflare (HTTP 403).'
              : `Migros home failed${status ? ` (HTTP ${status})` : ''}.`,
            status
          );
        }

        const guest = await this.fetchJson(GUEST_PATH, 'GET', undefined, 'guest');
        if (!guest || typeof guest.userid !== 'string' || !guest.userid) {
          throw new MigrosError('Migros guest response has an unexpected schema.');
        }
      } catch (error) {
        await this.close();
        throw error;
      } finally {
        this.initialising = undefined;
      }
    })();

    return this.initialising;
  }

  private async captureSessionHeader(query: string): Promise<void> {
    if (!this.page || this.leshopHeader) return;

    const searchUrl = `${BASE_URL}/en/search?query=${encodeURIComponent(query)}`;
    const request = this.page.waitForRequest(
      candidate => candidate.url() === `${BASE_URL}${SEARCH_PATH}`,
      { timeout: REQUEST_TIMEOUT }
    );
    await Promise.all([
      request.then(candidate => {
        this.leshopHeader = candidate.headers().leshopch;
      }),
      this.page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT }),
    ]);

    if (!this.leshopHeader) {
      throw new MigrosError('Migros did not provide the required browser session header.');
    }
  }

  private async fetchJson(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    label: string
  ): Promise<any> {
    if (!this.page || !this.leshopHeader && path !== GUEST_PATH) {
      throw new MigrosError('Migros browser session is not ready.');
    }

    const result = await this.page.evaluate(
      async ({ url, method: requestMethod, body: requestBody, leshopHeader }) => {
        const response = await fetch(url, {
          method: requestMethod,
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
            ...(requestMethod === 'POST' ? { 'Content-Type': 'application/json' } : {}),
            ...(leshopHeader ? { leshopch: leshopHeader } : {}),
            'migros-language': 'en',
            'peer-id': 'website-js-1265.0.0',
          },
          body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
        });
        return {
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: await response.text(),
        };
      },
      {
        url: `${BASE_URL}${path}`,
        method,
        body,
        leshopHeader: this.leshopHeader,
      }
    );

    return assertResponse(result, label);
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    try {
      await this.initialise();
      await this.captureSessionHeader(query);

      const requestedLimit = Math.trunc(options.limit ?? DEFAULT_LIMIT);
      const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIMIT);
      const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
      const result = (await this.fetchJson(
        SEARCH_PATH,
        'POST',
        {
          query,
          language: 'en',
          storeType: 'OFFLINE',
          region: 'national',
          sortFields: [],
          sortOrder: 'asc',
          from: offset,
          limit,
          filters: {},
          searchAlgorithm: 'DEFAULT',
          enabledSponsoredProducts: true,
        },
        'search'
      )) as MigrosSearchResponse;

      if (!Array.isArray(result.items) || typeof result.numberOfProducts !== 'number') {
        throw new MigrosError('Migros search response has an unexpected schema.');
      }
      if (result.items.length === 0) return [];

      const cards = await this.fetchJson(
        CARDS_PATH,
        'POST',
        {
          offerFilter: {
            storeType: 'OFFLINE',
            region: 'national',
            ongoingOfferDate: `${new Date().toISOString().slice(0, 10)}T00:00:00`,
          },
          productFilter: {
            uids: result.items.map(item => Number(item.id)).filter(Number.isFinite),
          },
        },
        'product cards'
      );
      if (!Array.isArray(cards)) {
        throw new MigrosError('Migros product-card response has an unexpected schema.');
      }
      return cards.map(card => normaliseProduct(card));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const page = this.page;
    const context = this.context;
    const browser = this.browser;
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.leshopHeader = undefined;

    const errors: unknown[] = [];
    for (const resource of [page, context, browser]) {
      if (!resource) continue;
      try {
        await resource.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw errors[0];
  }
}

export class MigrosProvider implements GroceryProvider {
  readonly name = MIGROS.id;
  private readonly session: MigrosSearchSession;

  constructor(session: MigrosSearchSession = new MigrosSession()) {
    this.session = session;
  }

  async search(query: string, options?: SearchOptions): Promise<Product[]> {
    return this.session.search(query, options);
  }

  async logout(): Promise<void> {
    await this.session.close();
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
