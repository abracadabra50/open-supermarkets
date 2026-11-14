/** Italy: store-scoped catalogue and fixed-pack baskets through SeleniumBase. */
import { createHash, randomUUID } from 'node:crypto';
import type {
  Basket, BasketItem, BrowserLoginStatus, CheckoutPreview, GroceryProvider,
  Product, SearchOptions, StoreContext,
} from '../types';
import {
  CONAD_MAX_QUANTITY_DELTA, CONAD_PAGE_SIZE, isConadCode, isRecord, normaliseProduct,
} from './catalogue';
import { SeleniumBaseClient, ConadInteractionRequiredError, ConadWorkerError } from './seleniumbase';
import type { ConadBrowserOptions, ConadTransport } from './seleniumbase';

export { normaliseProduct, CONAD_PAGE_SIZE } from './catalogue';
export { ConadInteractionRequiredError } from './seleniumbase';

function protocol(): never {
  throw new ConadWorkerError('CONAD_PROTOCOL_ERROR', 'Conad returned malformed browser data; inspect the provider before retrying.');
}

function money(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) protocol();
  return value;
}

function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConadWorkerError('CONAD_INVALID_INPUT', `${name} must be an integer between ${min} and ${max}.`);
  }
}

function validStore(raw: unknown): StoreContext {
  if (raw === null) throw new ConadInteractionRequiredError('Select a local store and fulfilment service in the visible Conad browser first.');
  if (!isRecord(raw) || raw.provider !== 'conad' || typeof raw.store_id !== 'string' || !raw.store_id.trim() || typeof raw.name !== 'string' || !raw.name.trim() || typeof raw.address !== 'string' || !raw.address.trim() || (raw.fulfilment !== 'pickup' && raw.fulfilment !== 'delivery')) protocol();
  return { store_id: raw.store_id, name: raw.name, address: raw.address, provider: 'conad', fulfilment: raw.fulfilment };
}

function status(raw: unknown): BrowserLoginStatus {
  if (!isRecord(raw) || typeof raw.authenticated !== 'boolean') protocol();
  return {
    provider: 'conad', authenticated: raw.authenticated,
    interaction_required: !raw.authenticated,
    store: raw.store === null ? null : validStore(raw.store),
  };
}

function basket(raw: unknown): Basket {
  if (!isRecord(raw) || !Array.isArray(raw.items) || raw.provider !== 'conad' || raw.currency !== 'EUR' || typeof raw.total_quantity !== 'number' || !Number.isFinite(raw.total_quantity) || raw.total_quantity < 0) protocol();
  const seen = new Set<string>();
  const items: BasketItem[] = raw.items.map(line => {
    if (!isRecord(line) || typeof line.item_id !== 'string' || !line.item_id || !isConadCode(line.product_uid) || typeof line.name !== 'string' || !line.name.trim() || typeof line.quantity !== 'number' || !Number.isFinite(line.quantity) || line.quantity <= 0 || seen.has(line.item_id)) protocol();
    seen.add(line.item_id);
    const stock = line.in_stock;
    if (stock !== undefined && stock !== null && typeof stock !== 'boolean') protocol();
    return {
      item_id: line.item_id, product_uid: line.product_uid, name: line.name,
      quantity: line.quantity, unit_price: money(line.unit_price), total_price: money(line.total_price),
      ...(stock !== undefined ? { in_stock: stock } : {}),
    };
  });
  if (Math.abs(items.reduce((sum, line) => sum + line.quantity, 0) - raw.total_quantity) > 1e-8) protocol();
  if (raw.basket_id !== undefined && (typeof raw.basket_id !== 'string' || !raw.basket_id)) protocol();
  if (items.length && !raw.basket_id) protocol();
  return {
    items, total_quantity: raw.total_quantity, total_cost: money(raw.total_cost),
    provider: 'conad', currency: 'EUR', store: validStore(raw.store),
    ...(typeof raw.basket_id === 'string' ? { basket_id: raw.basket_id } : {}),
  };
}

export class ConadProvider implements GroceryProvider {
  readonly name = 'conad';
  private readonly transport: ConadTransport;

  constructor(options: ConadBrowserOptions = {}, transport?: ConadTransport) {
    this.transport = transport || new SeleniumBaseClient(options);
  }

  async startBrowserLogin(): Promise<BrowserLoginStatus> {
    return status(await this.transport.call('browser_login'));
  }

  async login(email: string, password: string): Promise<void> {
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      throw new Error('Conad email and password are required.');
    }
    const result = status(await this.transport.call('login', { email, password }));
    if (!result.authenticated) throw new ConadInteractionRequiredError('Complete Conad verification in the visible browser, then check its status.');
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getSessionStatus()).authenticated;
  }

  async getStore(): Promise<StoreContext | null> {
    return (await this.getSessionStatus()).store;
  }

  async getSessionStatus(): Promise<BrowserLoginStatus> {
    return status(await this.transport.call('status'));
  }

  async logout(): Promise<void> {
    throw new ConadInteractionRequiredError('Use Esci in the visible MyConad browser to log out. A profile shutdown does not revoke the retailer session.');
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('Conad search query must contain 1 to 1000 characters.');
    if (options.category !== undefined) throw new Error('Conad category filtering is not supported.');
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    integer(limit, 'Conad limit', 0, 100);
    integer(offset, 'Conad offset', 0);
    integer(offset + limit, 'Conad search end', 0);
    if (!limit) return [];
    const results: Product[] = [];
    const seen = new Set<string>();
    let page = Math.floor(offset / CONAD_PAGE_SIZE) + 1;
    let previousTotal: number | undefined;
    let store: StoreContext | undefined;
    while (results.length < limit) {
      const raw = await this.transport.call('search_page', { query: query.trim(), page });
      if (!isRecord(raw) || !Array.isArray(raw.rows) || typeof raw.total !== 'number' || !Number.isSafeInteger(raw.total) || raw.total < 0) protocol();
      const context = validStore(raw.store);
      if (store && (store.store_id !== context.store_id || store.fulfilment !== context.fulfilment)) {
        throw new Error('Conad store changed during search; review the store before retrying.');
      }
      store = context;
      if (previousTotal !== undefined && previousTotal !== raw.total) throw new Error('Conad catalogue changed during pagination; retry the search.');
      previousTotal = raw.total;
      const start = (page - 1) * CONAD_PAGE_SIZE;
      if (raw.rows.length !== Math.min(CONAD_PAGE_SIZE, Math.max(0, raw.total - start))) protocol();
      const rows = raw.rows.map(row => normaliseProduct(row, context));
      for (const row of rows) {
        if (seen.has(row.product_uid)) throw new Error('Conad repeated/overlapped a catalogue page.');
        seen.add(row.product_uid);
      }
      const skip = Math.max(0, offset - start);
      results.push(...rows.slice(skip, skip + limit - results.length));
      if (start + rows.length >= raw.total) break;
      page++;
    }
    return results;
  }

  async getProduct(productId: string): Promise<Product> {
    if (!isConadCode(productId)) throw new Error('A valid Conad retailer code is required.');
    const raw = await this.transport.call('product', { product_id: productId });
    if (!isRecord(raw) || !isRecord(raw.row) || raw.row.code !== productId) protocol();
    return normaliseProduct(raw.row, validStore(raw.store));
  }

  async getBasket(): Promise<Basket> {
    return basket(await this.transport.call('basket'));
  }

  private async write(action: 'basket_add' | 'basket_update' | 'basket_remove' | 'basket_clear', args: Record<string, unknown>): Promise<void> {
    const result = await this.transport.call(action, args);
    if (!isRecord(result) || result.confirmed !== true) {
      throw new ConadWorkerError('CONAD_PROTOCOL_ERROR', 'Conad did not confirm the basket change. Read the basket before retrying.', true);
    }
  }

  async addToBasket(productId: string, quantity: number): Promise<void> {
    if (!isConadCode(productId)) throw new Error('A valid Conad retailer code is required.');
    integer(quantity, 'quantity', 1, CONAD_MAX_QUANTITY_DELTA);
    await this.write('basket_add', { product_id: productId, quantity });
  }

  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
    if (typeof itemId !== 'string' || !/^\d+$/.test(itemId)) throw new Error('A numeric Conad basket line ID is required.');
    integer(quantity, 'quantity', 0, 100);
    await this.write('basket_update', { item_id: itemId, quantity });
  }

  async removeFromBasket(itemId: string): Promise<void> {
    if (typeof itemId !== 'string' || !/^\d+$/.test(itemId)) throw new Error('A numeric Conad basket line ID is required.');
    await this.write('basket_remove', { item_id: itemId });
  }

  async clearBasket(): Promise<void> {
    await this.write('basket_clear', {});
  }

  async getCheckoutPreview(): Promise<CheckoutPreview> {
    // One worker operation captures the basket and charges together. Comparing
    // only two totals cannot detect equal-price concurrent basket substitutions.
    const raw = await this.transport.call('checkout_summary');
    if (!isRecord(raw) || !isRecord(raw.summary) || typeof raw.account_key !== 'string') protocol();
    const current = basket(raw.basket);
    const subtotal = money(raw.summary.subtotal);
    const delivery = money(raw.summary.delivery);
    const minimum = raw.summary.minimum_value_reached;
    if (minimum !== null && typeof minimum !== 'boolean') protocol();
    const blockers = ['The final Conad checkout, delivery slot, substitutions and payment have not been verified. Order placement is disabled.'];
    if (!current.items.length) blockers.push('Basket is empty.');
    if (minimum === false) blockers.push('The retailer minimum spend has not been reached.');
    if (current.items.some(line => line.in_stock === false)) blockers.push('Conad explicitly marked a basket line unavailable.');
    if (current.total_cost === null || current.items.some(line => line.unit_price === null || line.total_price === null)) blockers.push('Some basket prices are unknown.');
    return {
      provider: 'conad', currency: 'EUR', store: current.store!, basket: current,
      preview_id: randomUUID(), generated_at: new Date().toISOString(),
      snapshot_hash: createHash('sha256').update(JSON.stringify({ account: raw.account_key, basket: current, subtotal, delivery })).digest('hex'),
      totals: { basket: subtotal, delivery, service: null, final: null },
      current_cart_total: current.total_cost, delivery_slot: null, payment_ready: null,
      blockers, can_place_order: false,
    };
  }
}
