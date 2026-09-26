/** Ahorramás — Salesforce Commerce Cloud storefront (Spain).
 *
 * The storefront gives anonymous visitors a basket.  Salesforce returns the
 * session cookies in Set-Cookie, so this provider deliberately owns a small
 * in-memory cookie jar instead of creating a new HTTP client per operation.
 * Cookies are never persisted or included in error messages.
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { Basket, BasketItem, GroceryProvider, Product, SearchOptions } from './types';

export const AHORRAMAS_BASE = 'https://www.ahorramas.com';
export const AHORRAMAS_SITE = 'Sites-Ahorramas-Site';
export const AHORRAMAS_LOCALE = 'es';
const STORE_PATH = `/on/demandware.store/${AHORRAMAS_SITE}/${AHORRAMAS_LOCALE}`;

type HttpResponse = Pick<AxiosResponse, 'data' | 'headers' | 'status'>;

export class AhorramasHttpError extends Error {
  readonly status?: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status?: number, cause?: unknown) {
    const detail = safeErrorDetail(cause);
    super(`Ahorramás ${method} ${path} failed${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'AhorramasHttpError';
    this.status = status;
    this.method = method;
    this.path = path;
    if (cause) (this as any).cause = cause;
  }
}

export class AhorramasParseError extends Error {
  constructor(message: string) {
    super(`Ahorramás cart response could not be parsed: ${message}`);
    this.name = 'AhorramasParseError';
  }
}

function safeErrorDetail(error: any): string {
  const value = error?.response?.data;
  const detail = typeof value === 'string'
    ? value
    : value?.error ?? value?.errorMessage ?? value?.message;
  if (typeof detail !== 'string' || !detail.trim()) return '';
  return detail.replace(/((?:sid|dwsid|dwanonymous_[^=;\s]*|dwac_[^=;\s]*))=[^;\s]+/gi, '$1=[redacted]').slice(0, 240);
}

/** Parse Spanish/euro prices without changing the process locale. */
export function parseAhorramasPrice(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value ?? '').trim().replace(/\s/g, '').replace(/[€$£]/g, '');
  if (!text) return 0;
  // Spanish values use comma for decimals. Remove thousands separators only
  // when both separators occur; otherwise a lone comma is the decimal mark.
  const normalised = text.includes(',')
    ? text.replace(/\./g, '').replace(',', '.')
    : text;
  const parsed = Number(normalised.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function number(value: unknown): number {
  return typeof value === 'number' ? (Number.isFinite(value) ? value : 0) : parseAhorramasPrice(value);
}

function quantityTotal(value: unknown, items: BasketItem[]): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>).map(number);
    if (values.length) return values.reduce((sum, n) => sum + n, 0);
  }
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

function productFromItem(item: any): any {
  return item?.product ?? item;
}

export function normaliseAhorramasBasket(raw: any, provider = 'ahorramas'): Basket {
  const cart = raw?.cart ?? raw?.basket ?? raw ?? {};
  const sourceItems = Array.isArray(cart.items) ? cart.items : Array.isArray(cart.products) ? cart.products : [];
  const items = sourceItems.map((item: any): BasketItem => {
    const product = productFromItem(item);
    const quantity = number(item?.quantity ?? item?.qty ?? 1);
    const unit = item?.unitPrice?.sales?.value ?? item?.unitPrice?.value ?? item?.unitPrice ?? product?.price;
    const total = item?.priceTotal?.decimalPrice ?? item?.priceTotal?.value ?? item?.totalPrice ?? item?.subtotal;
    return {
      item_id: String(item?.UUID ?? item?.uuid ?? item?.item_id ?? item?.itemId ?? ''),
      product_uid: String(item?.id ?? item?.productId ?? product?.id ?? product?.productId ?? ''),
      name: String(item?.productName ?? product?.productName ?? product?.name ?? 'Unknown item'),
      quantity,
      unit_price: number(unit),
      total_price: total === undefined ? number(unit) * quantity : number(total),
    };
  });
  const totals = cart.totals ?? raw?.totals ?? {};
  const total = totals.total ?? totals.grandTotal ?? totals.orderTotal ?? totals.totalPrice;
  return {
    items,
    total_quantity: quantityTotal(cart.quantityTotal ?? cart.quantityTotalByUnit, items),
    // Basket.total_cost means the payable basket total in existing providers.
    // SFCC's total is preferred; subtotal is only a response-shape fallback.
    total_cost: total === undefined ? number(totals.subTotal ?? totals.subtotal) : number(total),
    provider,
    currency: 'EUR',
  };
}

function jsonCandidates(html: string): any[] {
  const values: any[] = [];
  const patterns = [
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      try { values.push(JSON.parse(match[1])); } catch { /* unrelated page JSON */ }
    }
  }
  return values;
}

/** Extract the stable JSON state when /cart returns SSR HTML. */
export function parseAhorramasCartHtml(html: string): any {
  try {
    const json = JSON.parse(html);
    if (json && typeof json === 'object') return json;
  } catch { /* SSR HTML */ }
  for (const candidate of jsonCandidates(html)) {
    if (candidate?.cart || candidate?.basket || candidate?.items || candidate?.products) return candidate;
    const nested = candidate?.data?.cart ?? candidate?.data?.basket;
    if (nested) return { cart: nested };
  }
  // Some SFCC responses expose the state in a data attribute. This is a last
  // resort and intentionally only parses JSON-looking values, not CSS classes.
  const state = html.match(/(?:data-cart|data-basket|data-cart-state)=["']([^"']+)["']/i);
  if (state) {
    try { return JSON.parse(state[1].replace(/&quot;/g, '"')); } catch { /* continue */ }
  }
  throw new AhorramasParseError('no basket state was found in the SSR document');
}

export function parseAhorramasSearchHtml(html: string, provider = 'ahorramas'): Product[] {
  const products: Product[] = [];
  const seen = new Set<string>();
  const add = (id: string, name: string, price: unknown, image?: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    products.push({ product_uid: id, name: name || id, retail_price: { price: number(price) }, in_stock: true, image_url: image, provider, currency: 'EUR' });
  };
  for (const candidate of jsonCandidates(html)) {
    const list = Array.isArray(candidate) ? candidate : candidate?.products ?? candidate?.items ?? candidate?.results;
    for (const p of Array.isArray(list) ? list : []) {
      const id = String(p?.id ?? p?.pid ?? p?.productID ?? '');
      const offer = p?.offers?.price ?? p?.price?.sales?.value ?? p?.price;
      add(id, String(p?.name ?? p?.productName ?? ''), offer, p?.image ?? p?.image_url);
    }
  }
  const productLinks = /data-pid=["']([^"']+)["'][\s\S]*?(?:data-name|aria-label)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = productLinks.exec(html))) add(match[1], match[2], 0);
  return products;
}

export class AhorramasProvider implements GroceryProvider {
  readonly name = 'ahorramas';
  private readonly http: AxiosInstance;
  private readonly cookies = new Map<string, string>();

  constructor(http?: AxiosInstance) {
    this.http = http ?? axios.create({ baseURL: AHORRAMAS_BASE, timeout: 15_000, headers: { Accept: 'application/json, text/html', 'User-Agent': 'open-supermarkets' } });
  }

  private captureCookies(headers: any): void {
    const values = headers?.['set-cookie'] ?? headers?.['Set-Cookie'];
    for (const raw of Array.isArray(values) ? values : values ? [values] : []) {
      const pair = String(raw).split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }

  private async request<T = any>(config: AxiosRequestConfig): Promise<HttpResponse & { data: T }> {
    const headers = { ...(config.headers as any), ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}) };
    try {
      const response = await this.http.request<T>({ ...config, headers });
      this.captureCookies(response.headers);
      return response as HttpResponse & { data: T };
    } catch (error: any) {
      const status = error?.response?.status;
      throw new AhorramasHttpError(String(config.method ?? 'GET').toUpperCase(), String(config.url), status, error);
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const response = await this.request<string>({ method: 'GET', url: `${STORE_PATH}/Search-Show`, params: { q: query, sz: options.limit ?? 10, start: options.offset ?? 0 } });
    return parseAhorramasSearchHtml(String(response.data), this.name);
  }

  async getBasket(): Promise<Basket> {
    const response = await this.request<any>({ method: 'GET', url: '/cart' });
    const raw = typeof response.data === 'string' ? parseAhorramasCartHtml(response.data) : response.data;
    return normaliseAhorramasBasket(raw, this.name);
  }

  private async findItem(itemId: string): Promise<BasketItem> {
    const basket = await this.getBasket();
    const item = basket.items.find(i => i.item_id === itemId || i.product_uid === itemId);
    if (!item) throw new Error(`Ahorramás: basket line ${itemId} not found`);
    return item;
  }

  private validateQuantity(quantity: number): void {
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Ahorramás: quantity must be greater than zero');
  }

  async addToBasket(productId: string, quantity: number): Promise<void> {
    this.validateQuantity(quantity);
    await this.request({ method: 'POST', url: `${STORE_PATH}/Cart-AddProduct`, data: new URLSearchParams({ pid: productId, quantity: String(quantity), childProducts: '[]' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  }

  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
    this.validateQuantity(quantity);
    const item = await this.findItem(itemId);
    await this.request({ method: 'GET', url: `${STORE_PATH}/Cart-UpdateQuantity`, params: { pid: item.product_uid, quantity, quantityAbs: quantity, uuid: item.item_id } });
  }

  async removeFromBasket(itemId: string): Promise<void> {
    const item = await this.findItem(itemId);
    await this.request({ method: 'GET', url: `${STORE_PATH}/Cart-RemoveProductLineItem`, params: { pid: item.product_uid, uuid: item.item_id } });
  }

  async clearBasket(): Promise<void> {
    // Removing each known UUID is the verified-safe fallback. It also avoids
    // relying on an unexecuted Cart-ClearBasket controller.
    const basket = await this.getBasket();
    for (const item of basket.items) await this.removeFromBasket(item.item_id);
  }
}
