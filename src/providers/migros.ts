/**
 * Migros Switzerland — browser-backed catalogue search.
 *
 * Migros serves a Cloudflare page to cold HTTP clients. A real Chromium page
 * receives a short-lived `leshopch` request header, which the product APIs
 * require in addition to the browser context. Keep the page alive for the
 * lifetime of the provider and make the JSON calls from that page; do not
 * scrape the rendered product cards.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright';
import type { Basket, BasketItem, GroceryProvider, Product, SearchOptions } from './types';
import { sumKnown, toPrice } from './normalise';

export const MIGROS = {
  id: 'migros',
  label: 'Migros',
  country: 'CH',
  currency: 'CHF',
} as const;

const BASE_URL = 'https://www.migros.ch';
const HOME_PATH = '/en';
const GUEST_PATH = '/authentication/public/v1/api/guest?authorizationNotRequired=true';
const BASKET_OVERVIEW_PATH = '/shopping-list/public/v1/lists/overview';
const BASKET_DETAILS_PATH = '/shopping-list/public/v2/list/details';
const BASKET_ITEMS_PATH = '/shopping-list/public/v3/items';
const FULFILMENT_PATH = '/fulfilment-selector/public/v1/fulfilment-selection';
const SEARCH_PATH = '/product-display/public/v2/products/search';
const CARDS_PATH = '/product-display/public/v4/product-cards';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const REQUEST_TIMEOUT = 30_000;
/**
 * The guest basket lives server-side, keyed by cookies on the guest session.
 * CLI, MCP and HTTP callers build a fresh provider per operation, so those
 * cookies must outlive the browser or every call gets an empty new basket.
 */
export function migrosSessionFile(): string {
  return process.env.MIGROS_SESSION_FILE || path.join(os.homedir(), '.migros', 'session.json');
}
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

interface MigrosBasketItem {
  id: number | string;
  name?: string;
  quantity: number;
  type: string;
}

interface MigrosBasketResponse {
  categories: Array<{ items?: MigrosBasketItem[] }>;
  shoppingListId: number | string;
  totals: {
    onlineTotal: { estimatedTotal: number };
  };
}

export function normaliseBasket(
  details: MigrosBasketResponse,
  prices: Map<string, number> = new Map()
): Basket {
  const items = details.categories.flatMap(category => category.items ?? []);
  const basketItems: BasketItem[] = items.map(item => {
    // Lines without an online product card (promotions, delisted items) have
    // no known price. That's unknown, not free.
    const unitPrice = prices.get(String(item.id)) ?? null;
    return {
      item_id: String(item.id),
      product_uid: String(item.id),
      name: item.name ?? String(item.id),
      quantity: item.quantity,
      unit_price: unitPrice,
      total_price: unitPrice !== null ? unitPrice * item.quantity : null,
    };
  });
  return {
    items: basketItems,
    total_quantity: basketItems.reduce((sum, item) => sum + item.quantity, 0),
    total_cost: toPrice(details.totals?.onlineTotal?.estimatedTotal) ?? sumKnown(basketItems.map(item => item.total_price)),
    provider: MIGROS.id,
    currency: MIGROS.currency,
  };
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
  getBasket(): Promise<Basket>;
  addToBasket(productId: string, quantity: number): Promise<void>;
  updateBasketItem(itemId: string, quantity: number): Promise<void>;
  removeFromBasket(itemId: string): Promise<void>;
  clearBasket(): Promise<void>;
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

function assertBasketResponse(value: unknown): MigrosBasketResponse {
  if (!value || typeof value !== 'object') {
    throw new MigrosError('Migros basket response has an unexpected schema.');
  }
  const basket = value as Partial<MigrosBasketResponse>;
  if (
    !Array.isArray(basket.categories) ||
    (typeof basket.shoppingListId !== 'string' && typeof basket.shoppingListId !== 'number') ||
    !basket.totals ||
    typeof basket.totals !== 'object' ||
    !basket.totals.onlineTotal ||
    typeof basket.totals.onlineTotal.estimatedTotal !== 'number'
  ) {
    throw new MigrosError('Migros basket response has an unexpected schema.');
  }
  for (const category of basket.categories) {
    if (!category || typeof category !== 'object' || (category.items !== undefined && !Array.isArray(category.items))) {
      throw new MigrosError('Migros basket response has an unexpected schema.');
    }
    for (const item of category.items ?? []) {
      if (
        !item ||
        typeof item !== 'object' ||
        (typeof item.id !== 'string' && typeof item.id !== 'number') ||
        typeof item.quantity !== 'number' ||
        typeof item.type !== 'string'
      ) {
        throw new MigrosError('Migros basket response has an unexpected schema.');
      }
    }
  }
  return basket as MigrosBasketResponse;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function stockFromAvailability(availability: unknown): boolean | null {
  if (typeof availability !== 'string') return null;

  switch (availability.toUpperCase()) {
    case 'ONLINE':
    case 'ONLINE_AND_INSTORE':
    case 'IN_STOCK':
    case 'AVAILABLE':
      return true;
    case 'OUT_OF_STOCK':
    case 'UNAVAILABLE':
    case 'NOT_AVAILABLE':
      return false;
    default:
      return null;
  }
}

export function normaliseProduct(card: MigrosProductCard, provider = MIGROS.id): Product | undefined {
  const price = card.offer?.price;
  const retailPrice = numberOrUndefined(price?.effectiveValue ?? price?.advertisedValue);
  if (retailPrice === undefined) return undefined;
  const unitPrice = numberOrUndefined(price?.unitPrice?.value);
  const inStock = stockFromAvailability(card.productAvailability);

  return {
    // `uid` is the id search returns and the only one the basket resolves.
    // `migrosId` is accepted by PUT /items but never shows up in the basket.
    product_uid: String(card.uid ?? card.migrosId ?? card.migrosOnlineId ?? ''),
    name: String(card.title ?? card.name ?? card.description ?? ''),
    description: card.description || undefined,
    retail_price: { price: retailPrice },
    unit_price:
      unitPrice !== undefined && price?.unitPrice?.unit
        ? { price: unitPrice, measure: price.unitPrice.unit }
        : undefined,
    in_stock: inStock,
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

  constructor(
    private readonly launch: MigrosBrowserLauncher = options => chromium.launch(options),
    private readonly sessionFile: string | null = migrosSessionFile()
  ) {}

  /** Previously saved guest cookies, if any. A corrupt file is ignored, not fatal. */
  private storedState(): string | undefined {
    if (!this.sessionFile || !fs.existsSync(this.sessionFile)) return undefined;
    try {
      JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      return this.sessionFile;
    } catch {
      return undefined;
    }
  }

  private async saveState(): Promise<void> {
    if (!this.sessionFile || !this.context) return;
    const state = await this.context.storageState();
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.sessionFile, JSON.stringify(state), { mode: 0o600 });
  }

  /**
   * Run one public operation: open the browser, do the work, save the guest
   * cookies, close everything. Callers get a provider per operation and no
   * disposal hook, so nothing may outlive the call.
   */
  private async run<T>(work: () => Promise<T>, persist: boolean): Promise<T> {
    try {
      const result = await work();
      if (persist) await this.saveState();
      return result;
    } finally {
      await this.close();
    }
  }

  private async initialise(): Promise<void> {
    if (this.page) return;
    if (this.initialising) return this.initialising;

    this.initialising = (async () => {
      try {
        this.browser = await this.launch({ headless: true });
        this.context = await this.browser.newContext({
          userAgent: USER_AGENT,
          locale: 'en-CH',
          storageState: this.storedState(),
        });
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
        if (error instanceof MigrosError) throw error;
        throw new MigrosError(`Migros browser session failed: ${(error as Error).message}`);
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
    try {
      await Promise.all([
        request.then(candidate => {
          this.leshopHeader = candidate.headers().leshopch;
        }),
        this.page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT }),
      ]);
    } catch (error) {
      throw new MigrosError(`Migros search page failed: ${(error as Error).message}`);
    }

    if (!this.leshopHeader) {
      throw new MigrosError('Migros did not provide the required browser session header.');
    }
  }

  private async fetchJson(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body: unknown,
    label: string
  ): Promise<any> {
    if (!this.page || !this.leshopHeader && path !== GUEST_PATH) {
      throw new MigrosError('Migros browser session is not ready.');
    }

    let result: PageJsonResult;
    try {
      result = await this.page.evaluate(
        async ({ url, method: requestMethod, body: requestBody, leshopHeader }) => {
          const response = await fetch(url, {
            method: requestMethod,
            credentials: 'include',
            headers: {
              Accept: 'application/json, text/plain, */*',
              ...(requestMethod !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
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
    } catch (error) {
      throw new MigrosError(`Migros ${label} browser request failed: ${(error as Error).message}`);
    }

    return assertResponse(result, label);
  }

  private async ensureBasketSession(): Promise<void> {
    await this.initialise();
    if (!this.leshopHeader) await this.captureSessionHeader('basket');
  }

  private async shoppingListId(): Promise<string | number> {
    const overview = await this.fetchJson(BASKET_OVERVIEW_PATH, 'GET', undefined, 'basket overview');
    if (
      !Array.isArray(overview) ||
      !overview[0] ||
      (typeof overview[0].shoppingListId !== 'string' && typeof overview[0].shoppingListId !== 'number')
    ) {
      throw new MigrosError('Migros basket overview has an unexpected schema.');
    }
    return overview[0].shoppingListId;
  }

  private async setBasketItem(productId: string, quantity: number, type: string): Promise<void> {
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new MigrosError('Migros basket quantity must be a non-negative number.');
    }
    await this.ensureBasketSession();
    const shoppingListId = await this.shoppingListId();
    assertBasketResponse(
      await this.fetchJson(
        BASKET_ITEMS_PATH,
        'PUT',
        { shoppingListId, items: [{ id: productId, quantity, type }] },
        'basket update'
      )
    );
  }

  private async basketDetails(): Promise<MigrosBasketResponse> {
    await this.ensureBasketSession();
    const shoppingListId = await this.shoppingListId();
    const details = await this.fetchJson(
      `${BASKET_DETAILS_PATH}?shoppingListId=${encodeURIComponent(String(shoppingListId))}`,
      'GET',
      undefined,
      'basket details'
    );
    return assertBasketResponse(details);
  }

  /** Online warehouse for the guest's (guessed) delivery area. */
  private async warehouseId(): Promise<number | undefined> {
    const fulfilment = await this.fetchJson(FULFILMENT_PATH, 'GET', undefined, 'fulfilment selection');
    return fulfilment && typeof fulfilment.warehouseId === 'number' ? fulfilment.warehouseId : undefined;
  }

  private async readBasket(): Promise<Basket> {
    const details = await this.basketDetails();
    const items = details.categories.flatMap(category => category.items ?? []);
    const numericIds = items
      .map(item => Number(item.id))
      .filter(Number.isFinite);
    const prices = new Map<string, number>();

    if (numericIds.length) {
      const warehouseId = await this.warehouseId();
      const cards = await this.fetchJson(
        CARDS_PATH,
        'POST',
        {
          offerFilter: {
            storeType: 'ONLINE',
            ...(warehouseId === undefined ? {} : { warehouseId }),
            ongoingOfferDate: `${new Date().toISOString().slice(0, 10)}T00:00:00`,
          },
          productFilter: { uids: numericIds },
        },
        'basket product cards'
      );
      if (!Array.isArray(cards)) throw new MigrosError('Migros basket product cards have an unexpected schema.');
      for (const card of cards as MigrosProductCard[]) {
        const uid = String(card.uid ?? card.migrosId ?? card.migrosOnlineId ?? '');
        const price = numberOrUndefined(card.offer?.price?.effectiveValue ?? card.offer?.price?.advertisedValue);
        if (uid && price !== undefined) prices.set(uid, price);
      }
    }

    return normaliseBasket(details, prices);
  }

  async getBasket(): Promise<Basket> {
    return this.run(() => this.readBasket(), true);
  }

  async addToBasket(productId: string, quantity: number): Promise<void> {
    return this.run(() => this.setBasketItem(productId, quantity, 'PRODUCT'), true);
  }

  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
    return this.run(() => this.setExisting(itemId, quantity), true);
  }

  async removeFromBasket(itemId: string): Promise<void> {
    return this.run(() => this.setExisting(itemId, 0), true);
  }

  async clearBasket(): Promise<void> {
    return this.run(async () => {
      const basket = await this.basketDetails();
      for (const item of basket.categories.flatMap(category => category.items ?? [])) {
        await this.setBasketItem(String(item.id), 0, item.type);
      }
    }, true);
  }

  private async setExisting(itemId: string, quantity: number): Promise<void> {
    const basket = await this.basketDetails();
    const item = basket.categories.flatMap(category => category.items ?? []).find(candidate => String(candidate.id) === itemId);
    if (!item) throw new MigrosError(`Migros basket item not found: ${itemId}`);
    await this.setBasketItem(itemId, quantity, item.type);
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    return this.run(() => this.searchOpen(query, options), false);
  }

  private async searchOpen(query: string, options: SearchOptions): Promise<Product[]> {
    {
      await this.initialise();
      await this.captureSessionHeader(query);

      const warehouseId = await this.warehouseId();
      const requestedLimit = Math.trunc(options.limit ?? DEFAULT_LIMIT);
      const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIMIT);
      const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
      const result = (await this.fetchJson(
        SEARCH_PATH,
        'POST',
        {
          query,
          language: 'en',
          // The online catalogue, so every result can go in the basket. In-store
          // items are accepted by the list API and then silently never appear.
          storeType: 'ONLINE',
          region: 'national',
          ...(warehouseId === undefined ? {} : { warehouseId }),
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
            storeType: 'ONLINE',
            ...(warehouseId === undefined ? {} : { warehouseId }),
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
      return cards
        .map(card => normaliseProduct(card))
        .filter((product): product is Product => product !== undefined);
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

  async getBasket(): Promise<Basket> {
    return this.session.getBasket();
  }

  async addToBasket(productId: string, quantity: number): Promise<void> {
    return this.session.addToBasket(productId, quantity);
  }

  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
    return this.session.updateBasketItem(itemId, quantity);
  }

  async removeFromBasket(itemId: string): Promise<void> {
    return this.session.removeFromBasket(itemId);
  }

  async clearBasket(): Promise<void> {
    return this.session.clearBasket();
  }

  async logout(): Promise<void> {
    await this.session.close();
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
