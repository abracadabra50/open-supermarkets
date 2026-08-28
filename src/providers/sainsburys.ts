import axios, { AxiosInstance } from 'axios';
import { cleanGtin } from './gtin.js';
import { GroceryProvider, Product, Basket, DeliverySlot, Order, SearchOptions, BasketItem } from './types';
import { login } from '../auth/login';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const API_BASE = 'https://www.sainsburys.co.uk/groceries-api/gol-services';
const SESSION_FILE = path.join(os.homedir(), '.sainsburys', 'session.json');

export class SainsburysProvider implements GroceryProvider {
  readonly name = 'sainsburys';
  private client: AxiosInstance;
  private storeNumber: string;
  /** Single-flight guard so concurrent 401s trigger one Playwright login, not N. */
  private reauthInFlight: Promise<void> | null = null;

  constructor() {
    // Store number can be configured via environment variable
    // Default to '0560' if not set
    this.storeNumber = process.env.SAINSBURYS_STORE_NUMBER || '0560';
    this.client = axios.create({
      baseURL: API_BASE,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    });

    // Load session if exists
    this.loadSession();

    // Auto re-auth (issue #11): Sainsbury's sessions expire after ~20 min.
    // Opt in by setting SAINSBURYS_EMAIL + SAINSBURYS_PASSWORD — on a
    // 401/403 we re-login headlessly once and replay the failed request.
    this.client.interceptors.response.use(undefined, async (error: any) => {
      const status = error?.response?.status;
      const config = error?.config;
      const email = process.env.SAINSBURYS_EMAIL;
      const password = process.env.SAINSBURYS_PASSWORD;
      if ((status === 401 || status === 403) && config && !config._authRetry && email && password) {
        config._authRetry = true;
        if (!this.reauthInFlight) {
          console.error(`⚠️  Sainsbury's session rejected (HTTP ${status}) — re-authenticating…`);
          this.reauthInFlight = this.headlessRelogin(email, password)
            .finally(() => { this.reauthInFlight = null; });
        }
        await this.reauthInFlight;
        config.headers = {
          ...config.headers,
          Cookie: this.client.defaults.headers.common['Cookie'],
          wcauthtoken: this.client.defaults.headers.common['wcauthtoken'],
        };
        return this.client.request(config);
      }
      throw error;
    });
  }

  private async headlessRelogin(email: string, password: string): Promise<void> {
    const sessionData = await login(email, password, { headless: true });
    this.applySession(sessionData.cookies);
  }

  private applySession(cookies: any[]): void {
    this.client.defaults.headers.common['Cookie'] =
      cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
    const authCookie = cookies.find((c: any) => c.name.startsWith('WC_AUTHENTICATION_'));
    if (authCookie) {
      this.client.defaults.headers.common['wcauthtoken'] = authCookie.value;
    } else {
      delete this.client.defaults.headers.common['wcauthtoken'];
    }
  }

  private loadSession() {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        if (session.cookies) {
          // Handle both formats: array (from login.ts) or string (legacy)
          if (Array.isArray(session.cookies)) {
            this.applySession(session.cookies);
          } else {
            // Legacy format: cookies already a header string
            this.client.defaults.headers.common['Cookie'] = session.cookies;
          }
        }

      }
    } catch (error) {
      // Ignore session load errors
    }
  }

  async login(email: string, password: string): Promise<void> {
    // login() saves the session file itself; we just adopt the cookies.
    const sessionData = await login(email, password);
    this.applySession(sessionData.cookies);
  }

  async logout(): Promise<void> {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
    delete this.client.defaults.headers.common['Cookie'];
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.getBasket();
      return true;
    } catch {
      return false;
    }
  }

  private mapProduct(p: any): Product {
    return {
      product_uid: p.product_uid,
      name: p.name,
      description: p.description || p.short_description,
      retail_price: p.retail_price,
      unit_price: p.unit_price,
      in_stock: p.in_stock !== false && p.is_available !== false,
      image_url: p.image || p.assets?.plp_image,
      provider: this.name,
      // Sainsbury's returns `eans: ["5000157026071"]` on every product and it
      // was being dropped here. An array because a product can carry more than
      // one barcode (a multipack and its inner unit); the first is the one that
      // scans at the till.
      gtin: cleanGtin(p.eans?.[0])
    };
  }

  async search(query: string, options?: SearchOptions): Promise<Product[]> {
    const params: any = {
      'filter[keyword]': query,
      page_number: options?.offset ? Math.floor(options.offset / (options.limit || 24)) + 1 : 1,
      page_size: options?.limit || 24,
      sort_order: 'FAVOURITES_FIRST'
    };

    const response = await this.client.get('/product/v1/product', { params });
    
    return response.data.products.map((p: any) => this.mapProduct(p));
  }

  async getFavourites(options?: SearchOptions): Promise<Product[]> {
    const response = await this.client.get('/product/v1/favourites', {
      params: {
        'include[ASSOCIATIONS]': 'true',
        'include[REPLACEMENT_PRODUCTS]': 'true',
        minimised: 'true',
        store_identifier: this.storeNumber
      },
      headers: {
        Referer: 'https://www.sainsburys.co.uk/gol-ui/favourites-as-list'
      }
    });

    const products = (response.data.products || []).map((p: any) => this.mapProduct(p));
    const offset = options?.offset || 0;
    const limit = options?.limit;
    return typeof limit === 'number' ? products.slice(offset, offset + limit) : products.slice(offset);
  }

  async searchFavourites(query: string, options?: SearchOptions): Promise<Product[]> {
    const products = await this.getFavourites();
    const scored = products
      .map(product => ({ product, score: this.favouriteSearchScore(product, query) }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name))
      .map(result => result.product);

    const offset = options?.offset || 0;
    const limit = options?.limit || 24;
    return scored.slice(offset, offset + limit);
  }

  private favouriteSearchScore(product: Product, query: string): number {
    const haystack = `${product.name} ${product.description || ''}`.toLowerCase();
    const needle = query.trim().toLowerCase();
    if (!needle) return 0;
    if (haystack === needle) return 1000;
    if (haystack.includes(needle)) return 500 + needle.length;

    const terms = needle.split(/\s+/).filter(Boolean);
    return terms.reduce((score, term) => {
      if (haystack.includes(term)) return score + 100 + term.length;
      return score;
    }, 0);
  }

  async getProduct(productId: string): Promise<Product> {
    const response = await this.client.get(`/product/v1/product/${productId}`);
    return this.mapProduct(response.data);
  }

  async getCategories(): Promise<any> {
    const response = await this.client.get('/product/categories/tree');
    return response.data;
  }

  async getBasket(): Promise<Basket> {
    const pickTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const response = await this.client.get('/basket/v2/basket', {
      params: {
        pick_time: pickTime,
        store_number: this.storeNumber,
        slot_booked: 'false'
      }
    });
    const data = response.data;
    
    return {
      items: data.items?.map((item: any) => ({
        item_id: item.item_uid,
        product_uid: item.product?.sku,
        name: item.product?.name,
        quantity: item.quantity,
        unit_price: parseFloat(item.subtotal_price) / item.quantity,
        total_price: parseFloat(item.subtotal_price || 0)
      })) || [],
      total_quantity: data.item_count || 0,
      total_cost: parseFloat(data.total_price || 0),
      provider: this.name
    };
  }

  async addToBasket(productId: string, quantity: number): Promise<void> {
    // Generate pick_time (tomorrow at current time)
    const pickTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    
    await this.client.post('/basket/v2/basket/item', {
      product_uid: productId,
      quantity,
      uom: 'ea',  // unit of measure: 'ea' for each
      selected_catchweight: ''
    }, {
      params: {
        pick_time: pickTime,
        store_number: this.storeNumber,
        slot_booked: 'false'
      }
    });
  }

  async updateBasketItem(itemId: string, quantity: number): Promise<void> {
    const pickTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    
    // Get current basket to find the item
    const basket = await this.getBasket();
    const item = basket.items.find(i => i.item_id === itemId);
    
    if (!item) {
      throw new Error(`Item ${itemId} not found in basket`);
    }
    
    // Update using PUT with items array
    await this.client.put('/basket/v2/basket', {
      items: [{
        product_uid: item.product_uid,
        quantity,
        uom: 'ea',
        selected_catchweight: '',
        item_uid: itemId,
        decreasing_quantity: quantity < item.quantity
      }]
    }, {
      params: {
        pick_time: pickTime,
        store_number: this.storeNumber,
        slot_booked: 'false'
      }
    });
  }

  async removeFromBasket(itemId: string): Promise<void> {
    // Remove by updating to quantity 0
    await this.updateBasketItem(itemId, 0);
  }

  async clearBasket(): Promise<void> {
    const basket = await this.getBasket();
    for (const item of basket.items) {
      await this.removeFromBasket(item.item_id);
    }
  }

  async getDeliverySlots(): Promise<DeliverySlot[]> {
    // Use browser automation (headless) to get slots
    const { getSlots } = await import('../browser/slots');
    const slots = await getSlots(true); // headless mode
    
    return slots.map(s => ({
      slot_id: s.slot_id,
      start_time: s.start_time,
      end_time: s.end_time,
      date: s.date,
      price: s.price,
      available: s.available
    }));
  }

  async bookSlot(slotId: string): Promise<void> {
    const { bookSlot } = await import('../browser/slots');
    await bookSlot(slotId, false); // Show browser for booking
  }

  async checkout(dryRun: boolean = false): Promise<Order> {
    const { checkout } = await import('../browser/checkout');
    const result = await checkout(dryRun);
    
    return {
      order_id: result.order_id,
      status: result.status,
      total: result.total,
      items: []
    };
  }

  async getOrders(): Promise<Order[]> {
    // Fetch the order list
    const listResponse = await this.client.get('/order/v1/order', {
      params: { page_size: 10, page_number: 1 }
    });

    const rawOrders: any[] = listResponse.data.orders || [];

    // Fetch full detail for each order (needed to get order_items)
    const orders = await Promise.all(
      rawOrders.map(async (o: any) => {
        let items: BasketItem[] = [];
        try {
          const detail = await this.client.get(`/order/v1/order/${o.order_uid}`);
          items = (detail.data.order_items || []).map((item: any) => ({
            item_id: item.product.product_uid,
            product_uid: item.product.product_uid,
            name: item.product.name,
            quantity: item.quantity,
            unit_price: parseFloat((item.sub_total / item.quantity).toFixed(2)),
            total_price: parseFloat(item.sub_total)
          }));
        } catch {
          // detail fetch failed — order still usable without items
        }

        return {
          order_id: o.order_uid,
          status: o.status,
          total: parseFloat(o.total || 0),
          delivery_slot: o.slot_start_time ? {
            slot_id: '',
            start_time: o.slot_start_time,
            end_time: o.slot_end_time || '',
            date: o.slot_start_time.split('T')[0],
            price: parseFloat(o.slot_price || 0),
            available: true
          } : undefined,
          items
        };
      })
    );

    return orders;
  }
}
