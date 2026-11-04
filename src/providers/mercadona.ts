/**
 * Mercadona (Spain) — open REST catalogue + Algolia search.
 *
 * Spain's largest grocer, and one of the more open APIs in this repo: no token,
 * no cookie, no bot challenge. It is split across two services, which is why the
 * first pass at this provider looked impossible.
 *
 *   REST   tienda.mercadona.es/api/products/{id}/   product detail, INCLUDING the EAN
 *   Algolia 7uzjkl1dj0-dsn.algolia.net              full-text search
 *
 * The Algolia credentials below are the storefront's PUBLIC search key, lifted
 * from their frontend bundle where every visitor's browser already has them.
 * Confirmed search-only: it is rejected with "Method not allowed with this API
 * key" when asked to list indexes, so it cannot read or write anything beyond
 * running queries. If it ever rotates, search breaks with a 403 and these need
 * recapturing from the bundle.
 *
 * Verified live 2026-08-09: 230 hits for "leche"; Leche semidesnatada Hacendado
 * at €5.04; product 4240 resolves to EAN 8402001027475.
 */

import axios, { AxiosInstance } from 'axios';
import { toPrice } from './normalise';
import type { Product, SearchOptions } from './types';

const REST_BASE = 'https://tienda.mercadona.es';
const ALGOLIA_APP = '7UZJKL1DJ0';
const ALGOLIA_KEY = '9d8f2e39e90df472b4f2e559a116fe17';
const ALGOLIA_BASE = `https://${ALGOLIA_APP.toLowerCase()}-dsn.algolia.net`;

/**
 * Catalogue and pricing are per distribution centre, and the index name encodes
 * it: products_prod_{warehouse}_{lang}. 4315 is verified working and is the
 * default; override with MERCADONA_WAREHOUSE if your region differs.
 *
 * There is no public warehouse directory — /api/postal-codes/actions/change-pc/
 * accepts a postcode but answers `{warehouse_changed:false}` and sets a cookie
 * rather than telling you the code, and the search key is not permitted to list
 * indexes. Finding yours means watching the network tab on tienda.mercadona.es
 * after setting your postcode.
 */
const DEFAULT_WAREHOUSE = '4315';

interface MercadonaPrice {
  unit_price?: string | number;
  bulk_price?: string | number;
  unit_size?: number;
  size_format?: string;
  reference_format?: string;
}

interface MercadonaHit {
  id: string;
  display_name?: string;
  brand?: string;
  slug?: string;
  ean?: string;
  packaging?: string;
  thumbnail?: string;
  price_instructions?: MercadonaPrice;
}

export class MercadonaProvider {
  readonly name = 'mercadona';

  private rest: AxiosInstance;
  private algolia: AxiosInstance;
  private index: string;

  constructor(warehouse = process.env.MERCADONA_WAREHOUSE || DEFAULT_WAREHOUSE) {
    this.index = `products_prod_${warehouse}_es`;

    this.rest = axios.create({
      baseURL: REST_BASE,
      timeout: 15_000,
      headers: { Accept: 'application/json' },
    });

    this.algolia = axios.create({
      baseURL: ALGOLIA_BASE,
      timeout: 15_000,
      headers: {
        'X-Algolia-Application-Id': ALGOLIA_APP,
        'X-Algolia-API-Key': ALGOLIA_KEY,
        'Content-Type': 'application/json',
      },
    });
  }

  private static label(p: MercadonaHit): string {
    const display = (p.display_name ?? '').trim();
    const brand = (p.brand ?? '').trim();
    if (!display) return brand || '(sin nombre)';
    if (!brand) return display;
    return display.toLowerCase().includes(brand.toLowerCase())
      ? display
      : `${brand} ${display}`;
  }

  private toProduct(p: MercadonaHit): Product {
    const pi = p.price_instructions ?? {};
    const size =
      p.packaging ||
      (pi.unit_size && pi.size_format ? `${pi.unit_size}${pi.size_format}` : undefined);

    return {
      // Prefer the EAN when we have it — it is a barcode, which turns Open Food
      // Facts enrichment into an exact lookup rather than a name guess. Search
      // hits do not carry one, so those fall back to the Mercadona id.
      product_uid: p.ean || String(p.id),
      // display_name usually already carries the brand ("Leche semidesnatada
      // Hacendado"), so prefixing it unconditionally gives "Hacendado Leche
      // semidesnatada Hacendado". Only prepend when it is genuinely absent.
      name: MercadonaProvider.label(p),
      // Prices arrive as strings ("5.04") as often as numbers.
      retail_price: { price: toPrice(pi.unit_price ?? pi.bulk_price) },
      in_stock: true, // The catalogue only lists published, purchasable products.
      image_url: p.thumbnail,
      provider: this.name,
      currency: 'EUR',
      size,
    };
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const limit = options.limit ?? 10;
    const page = Math.floor((options.offset ?? 0) / Math.max(limit, 1));

    try {
      const { data } = await this.algolia.post('/1/indexes/*/queries', {
        requests: [
          {
            indexName: this.index,
            params: `query=${encodeURIComponent(query)}&hitsPerPage=${limit}&page=${page}`,
          },
        ],
      });

      const result = data?.results?.[0];
      if (result?.message) throw new Error(result.message);
      return (result?.hits ?? []).map((h: MercadonaHit) => this.toProduct(h));
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 403) {
        throw new Error(
          'Mercadona search was rejected (HTTP 403). The storefront\'s public Algolia key ' +
            'has almost certainly rotated — recapture it from the frontend bundle at ' +
            'tienda.mercadona.es and update src/providers/mercadona.ts.'
        );
      }
      if (/does not exist/i.test(err.message)) {
        throw new Error(
          `Mercadona has no catalogue for warehouse "${this.index}". ` +
            `Set MERCADONA_WAREHOUSE to a valid code (default ${DEFAULT_WAREHOUSE}).`
        );
      }
      throw new Error(`Mercadona search failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    }
  }

  /** Detail lookup. Unlike search, this carries the EAN. */
  async getProduct(productId: string): Promise<Product> {
    try {
      const { data } = await this.rest.get<MercadonaHit>(
        `/api/products/${encodeURIComponent(productId)}/`
      );
      return this.toProduct(data);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) throw new Error(`Mercadona: no product with id ${productId}`);
      throw new Error(`Mercadona lookup failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    }
  }

  async getCategories(): Promise<any> {
    const { data } = await this.rest.get('/api/categories/');
    return data?.results ?? data;
  }
}
