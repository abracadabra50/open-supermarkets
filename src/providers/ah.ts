/**
 * Albert Heijn (Netherlands) — catalogue search.
 *
 * AH issues an *anonymous* bearer token to anyone who asks, which is why this
 * provider needs no account, no address and no browser. That makes it the
 * reference implementation for a search-only provider: if you want to add your
 * country's supermarket, copy this file.
 *
 * Protocol credit: github.com/gwillem/appie-go (Go, MIT). No code was copied —
 * the endpoints, the `x-application` header and the anonymous token flow were
 * read from that project and reimplemented here.
 *
 * Verified live: 2026-08-03.
 */

import axios, { AxiosInstance } from 'axios';
import type { Product, SearchOptions } from './types';
import { toPrice, toStock } from './normalise';

const API_BASE = 'https://api.ah.nl';
const CLIENT_ID = 'appie-ios';

/**
 * Without this header the API returns HTTP 500
 * "Can not find application: 'null'". It is not optional.
 *
 * It also selects the storefront. AHBEWEBSHOP serves Albert Heijn Belgium from
 * the same host, with its own rate-limit bucket — observed returning HTTP 200
 * while the NL context was throttled.
 */
export const AH_APPLICATIONS = {
  NL: 'AHWEBSHOP',
  BE: 'AHBEWEBSHOP',
} as const;

interface AhToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface AhProduct {
  webshopId: number;
  title: string;
  salesUnitSize?: string;
  priceBeforeBonus?: number;
  currentPrice?: number;
  orderable?: boolean;
  images?: Array<{ url: string; width?: number }>;
  brand?: string;
  mainCategory?: string;
}

export class AlbertHeijnProvider {
  readonly name: string = 'ah';

  private http: AxiosInstance;
  private token?: string;
  private tokenExpiry = 0;

  constructor(application: string = AH_APPLICATIONS.NL) {
    this.http = axios.create({
      baseURL: API_BASE,
      timeout: 15_000,
      headers: {
        'x-application': application,
        'x-client-name': CLIENT_ID,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Appie/8.22.3',
      },
    });
  }

  /**
   * Anonymous token. Cached until 60s before expiry so a multi-command session
   * does not re-authenticate on every call.
   */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) return this.token;

    try {
      const { data } = await this.http.post<AhToken>(
        '/mobile-auth/v1/auth/token/anonymous',
        { clientId: CLIENT_ID }
      );
      if (!data?.access_token) {
        throw new Error('Albert Heijn returned no access_token');
      }
      this.token = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
      return this.token;
    } catch (err: any) {
      const status = err?.response?.status;

      // 403/429 here is almost always throttling, not a broken integration —
      // observed while developing this provider, where repeated calls started
      // returning 403 and recovered on their own minutes later. Saying "the API
      // may have changed, open an issue" for that produces bogus bug reports,
      // so the transient case gets its own message.
      if (status === 403 || status === 429) {
        throw new Error(
          `Albert Heijn refused the request (HTTP ${status}). This is usually rate ` +
            `limiting rather than a broken integration — wait a minute and retry. ` +
            `If it persists for more than an hour, please open an issue.`
        );
      }

      throw new Error(
        `Albert Heijn anonymous auth failed${status ? ` (HTTP ${status})` : ''}. ` +
          `If this is reproducible, the API may have changed — please open an issue.`
      );
    }
  }

  private toProduct(p: AhProduct): Product {
    const price = toPrice(p.currentPrice ?? p.priceBeforeBonus);
    return {
      product_uid: String(p.webshopId),
      name: p.title,
      retail_price: { price },
      in_stock: toStock(p.orderable),
      image_url: p.images?.[p.images.length - 1]?.url,
      provider: this.name,
      currency: 'EUR',
      size: p.salesUnitSize,
    };
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const token = await this.ensureToken();
    const limit = options.limit ?? 10;

    try {
      const { data } = await this.http.get<{ products?: AhProduct[] }>(
        '/mobile-services/product/search/v2',
        {
          params: {
            query,
            size: limit,
            page: Math.floor((options.offset ?? 0) / Math.max(limit, 1)),
            sortOn: 'RELEVANCE',
          },
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      return (data.products ?? []).slice(0, limit).map((p) => this.toProduct(p));
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        // Token rejected mid-session; drop it so the next call re-authenticates.
        this.token = undefined;
        this.tokenExpiry = 0;
      }
      throw new Error(
        `Albert Heijn search failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`
      );
    }
  }

  async getProduct(productId: string): Promise<Product> {
    const token = await this.ensureToken();
    const { data } = await this.http.get<AhProduct[]>(
      '/mobile-services/product/search/v2/products',
      {
        params: { ids: productId, sortOn: 'INPUT_PRODUCT_IDS' },
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const first = Array.isArray(data) ? data[0] : undefined;
    if (!first) throw new Error(`Albert Heijn: no product with id ${productId}`);
    return this.toProduct(first);
  }
}

/**
 * Albert Heijn Belgium — same API, different storefront.
 *
 * Verified: HTTP 200, 324 results for "brood", and served successfully while the
 * NL context was rate-limited, which is what shows it is a distinct application
 * rather than the same catalogue reordered.
 *
 * NOT verified: that the assortment and pricing match ah.be exactly. If you shop
 * there and something looks wrong, please open an issue — that is the check we
 * could not run from here.
 */
export class AlbertHeijnBEProvider extends AlbertHeijnProvider {
  readonly name: string = 'ah-be';
  constructor() {
    super(AH_APPLICATIONS.BE);
  }
}
