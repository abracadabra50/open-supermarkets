/**
 * TescoProvider — implements GroceryProvider interface
 *
 * Composes TescoAPI (REST calls) + auth (session management).
 * Delivery slots and checkout delegate to Playwright browser files.
 */

import { GroceryProvider, Product, Basket, DeliverySlot, Order, SearchOptions, BasketItem } from '../types';
import { cleanGtin } from '../gtin.js';
import { TescoAPI } from './api';
import { login, loadSession, clearSession, getCookieString } from './auth';

export class TescoProvider implements GroceryProvider {
  readonly name = 'tesco';
  private api: TescoAPI;

  constructor() {
    this.api = new TescoAPI();
    this.loadSession();
  }

  private loadSession(): void {
    try {
      const session = loadSession();
      if (session?.cookies && Array.isArray(session.cookies)) {
        this.api.setAuthCookies(getCookieString(session));
      }
    } catch {
      // Ignore session load errors silently
    }
  }

  async login(email: string, password: string): Promise<void> {
    const session = await login(email, password);
    const cookieString = getCookieString(session);
    this.api.setAuthCookies(cookieString);
  }

  async logout(): Promise<void> {
    clearSession();
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.api.getBasket();
      return true;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Product Search
  // ─────────────────────────────────────────────────────────

  async search(query: string, options?: SearchOptions): Promise<Product[]> {
    const count = options?.limit || 24;
    const page = options?.offset ? Math.floor(options.offset / count) + 1 : 1;
    const rawProducts = await this.api.searchProducts(query, count, page);
    return rawProducts.map((p: any) => this.normaliseProduct(p));
  }

  async getProduct(productId: string): Promise<Product> {
    const data = await this.api.getProduct(productId);
    const p = data?.product || data;
    return this.normaliseProduct(p);
  }

  async getCategories(): Promise<any> {
    return this.api.getCategories();
  }

  // ─────────────────────────────────────────────────────────
  // Basket
  // ─────────────────────────────────────────────────────────

  async getBasket(): Promise<Basket> {
    const data = await this.api.getBasket();

    // GraphQL response shape: data.basket.splitView.items (confirmed from mfe-trolley)
    const basket = data?.basket || data;
    const view = Array.isArray(basket?.splitView) ? basket.splitView[0] : basket?.splitView;
    const items: any[] = view?.items || [];
    const totalPrice = parseFloat(view?.totalPrice || 0);
    const totalItems = Number(view?.totalItems || items.reduce((s: number, i: any) => s + (i.quantity || 1), 0));

    return {
      items: items.map((item: any) => this.normaliseBasketItem(item)),
      total_quantity: totalItems,
      total_cost: totalPrice,
      provider: this.name,
    };
  }

  /** Get the basket orderId needed for UpdateBasket mutations */
  private async getBasketOrderId(): Promise<string> {
    const data = await this.api.getBasket();
    const orderId = data?.basket?.id || data?.id;
    if (!orderId) throw new Error('Could not retrieve basket orderId — are you logged in?');
    return orderId;
  }

  /**
   * UpdateBasket takes product_uid (TPNC), but the CLI's `remove`/`update` commands
   * are documented to take the basket item_id (the barcode-style ID shown by `groc
   * basket`) — matching every other provider. Resolve whichever one we were given
   * against the live basket so both forms work.
   */
  private async resolveProductUid(itemOrProductId: string): Promise<string> {
    const basket = await this.getBasket();
    const match = basket.items.find(
      i => i.item_id === itemOrProductId || i.product_uid === itemOrProductId
    );
    return match?.product_uid || itemOrProductId;
  }

  async addToBasket(productId: string, quantity: number): Promise<void> {
    const orderId = await this.getBasketOrderId();
    await this.api.updateBasket(productId, quantity, orderId);
  }

  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
    const productUid = await this.resolveProductUid(itemId);
    const orderId = await this.getBasketOrderId();
    await this.api.updateBasket(productUid, quantity, orderId);
  }

  async removeFromBasket(itemId: string): Promise<void> {
    const productUid = await this.resolveProductUid(itemId);
    // Set quantity to 0 to remove
    const orderId = await this.getBasketOrderId();
    await this.api.updateBasket(productUid, 0, orderId);
  }

  async clearBasket(): Promise<void> {
    const basket = await this.getBasket();
    const orderId = await this.getBasketOrderId();
    for (const item of basket.items) {
      await this.api.updateBasket(item.product_uid, 0, orderId);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Delivery & Checkout (browser automation)
  // ─────────────────────────────────────────────────────────

  async getDeliverySlots(): Promise<DeliverySlot[]> {
    // Use GraphQL API (preferred) — falls back to Playwright if API fails
    try {
      const today = new Date().toISOString().slice(0, 10);
      const twoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const data = await this.api.getSlots(today, twoWeeks);

      const rawSlots: any[] = Array.isArray(data?.delivery)
        ? data.delivery
        : data?.delivery || [];

      return rawSlots.map((s: any) => ({
        slot_id: String(s.id || ''),
        start_time: s.start ? new Date(s.start).toTimeString().slice(0, 5) : '',
        end_time: s.end ? new Date(s.end).toTimeString().slice(0, 5) : '',
        date: s.start ? new Date(s.start).toISOString().slice(0, 10) : '',
        price: parseFloat(s.price?.afterDiscount || s.charge || 0),
        available: String(s.status || '').toLowerCase() === 'available',
      }));

    } catch {
      // Fallback to Playwright browser scraping
      const { getTescoSlots } = await import('../../browser/tesco-slots');
      const slots = await getTescoSlots(true);
      return slots.map(s => ({
        slot_id: s.slot_id,
        start_time: s.start_time,
        end_time: s.end_time,
        date: s.date,
        price: s.price,
        available: s.available,
      }));
    }
  }

  async bookSlot(slotId: string): Promise<void> {
    try {
      await this.api.bookSlot(slotId);
    } catch {
      // Fallback to Playwright
      const { bookTescoSlot } = await import('../../browser/tesco-slots');
      await bookTescoSlot(slotId, false);
    }
  }

  async checkout(dryRun: boolean = false): Promise<Order> {
    const { tescoCheckout } = await import('../../browser/tesco-checkout');
    const result = await tescoCheckout(dryRun);
    return {
      order_id: result.order_id,
      status: result.status,
      total: result.total,
      items: [],
    };
  }

  // ─────────────────────────────────────────────────────────
  // Orders
  // ─────────────────────────────────────────────────────────

  async getOrders(): Promise<Order[]> {
    const data = await this.api.getOrders();
    const rawOrders: any[] = data?.orders || [];

    return rawOrders.map((o: any) => ({
      order_id: String(o.orderNo || o.id || ''),
      status: o.status || 'unknown',
      total: parseFloat(o.totalPrice || 0),
      delivery_slot: o.slot
        ? {
            slot_id: '',
            start_time: o.slot.start || '',
            end_time: o.slot.end || '',
            date: o.createdDateTime || '',
            price: parseFloat(o.slot.charge || 0),
            available: true,
          }
        : undefined,
      items: (o.items || []).map((i: any) => ({
        item_id: '',
        product_uid: String(i.product?.id || ''),
        name: i.product?.title || '',
        quantity: i.quantity || 0,
        unit_price: 0,
        total_price: 0,
      })),
    }));
  }

  // ─────────────────────────────────────────────────────────
  // Normalisation helpers
  // ─────────────────────────────────────────────────────────

  /** Expose the underlying API for the staples command */
  getAPI(): TescoAPI {
    return this.api;
  }

  private normaliseProduct(p: any): Product {
    // Price: try displayPrice, unitPrice, then fall back to promotion afterDiscount
    const promoPrice = p?.promotions?.[0]?.price?.afterDiscount;
    const promoUnit = p?.promotions?.[0]?.unitSellingInfo; // e.g. "£0.20/each"
    const price = parseFloat(
      p?.displayPrice?.value || p?.unitPrice?.price || p?.price?.actual || promoPrice || 0
    );

    // Unit price from unitSellingInfo string e.g. "£1.20/100g"
    let unitPrice: { price: number; measure: string } | undefined;
    if (p?.unitPrice?.price && p?.unitPrice?.measure) {
      unitPrice = { price: parseFloat(p.unitPrice.price), measure: p.unitPrice.measure };
    } else if (promoUnit) {
      const m = promoUnit.match(/£([\d.]+)\s*\/\s*(.+)/);
      if (m) unitPrice = { price: parseFloat(m[1]), measure: m[2].trim() };
    }

    return {
      product_uid: String(p?.id || p?.gtin || ''),
      // The GraphQL query has always selected `gtin`; it was only ever used as
      // a fallback for product_uid, which never fires because `id` is present.
      // product_uid must stay the internal id — basket operations address
      // products by it — so the barcode gets its own field.
      gtin: cleanGtin(p?.gtin),
      name: p?.title || p?.name || 'Unknown product',
      description: Array.isArray(p?.description?.features)
        ? p.description.features.join('; ')
        : (p?.description?.info || undefined),
      retail_price: { price },
      unit_price: unitPrice,
      in_stock: p?.isAvailable !== false && p?.maxQuantityAllowed !== 0 && p?.maxQuantity !== 0,
      image_url: p?.defaultImageUrl || undefined,
      provider: this.name,
    };
  }

  private normaliseBasketItem(item: any): BasketItem {
    // GraphQL basket item shape (from GetBasket query):
    // { id, unit, quantity, product: { id, gtin, title, displayPrice, unitPrice } }
    const product = item?.product || {};
    const unitPrice =
      product?.price?.actual ||
      product?.displayPrice?.value ||
      product?.unitPrice?.price ||
      item?.unitPrice?.price ||
      0;
    const quantity = item?.quantity || 1;
    // product_uid = product.id — this is the TPNC used in UpdateBasket mutations
    const productUid = String(product?.id || product?.tpnb || item?.productId || '');

    return {
      item_id: String(item?.id || ''),      // basket line id (for display)
      product_uid: productUid,              // TPNC — used for add/remove/update
      name: product?.title || item?.title || 'Unknown item',
      quantity: Number(quantity),
      unit_price: parseFloat(unitPrice) || 0,
      total_price: parseFloat(unitPrice) * Number(quantity),
    };
  }
}
