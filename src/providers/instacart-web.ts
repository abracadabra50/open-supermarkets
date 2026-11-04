/**
 * Instacart (US / Canada) — unofficial web GraphQL API.
 *
 * Use this when you do not have an official Developer Platform key. It talks to
 * the same GraphQL endpoint instacart.com's own web app uses, which means it can
 * actually search real products with real prices for a real address — something
 * the official API deliberately does not expose.
 *
 * The trade-offs are real and you should know them before depending on it:
 *
 *   • Login is bot-protected and cannot be scripted. You supply a session cookie
 *     captured from a browser you logged into yourself.
 *   • It sends Apollo *persisted queries*: an operation name plus a SHA-256 hash
 *     the server already knows. Those hashes are tied to an Instacart frontend
 *     build and rotate when they deploy. When that happens every call fails at
 *     once and the hashes below must be recaptured.
 *   • Automated access may be against Instacart's Terms of Service. This is here
 *     for personal automation. Decide for yourself.
 *
 * Protocol credit: github.com/kleinjm/instacart_api (Ruby, MIT). Endpoints,
 * headers, operation names and the persisted-query mechanism were read from that
 * project and reimplemented; no code was copied.
 *
 * PARTIALLY VERIFIED LIVE (2026-08-03), which is better than it sounds:
 *
 *   ✓ The endpoint is not bot-walled — plain nginx, HTTP 200, no Cloudflare
 *     challenge (unlike DoorDash).
 *   ✓ The persisted-query hashes below are CURRENT. The server resolved them and
 *     validated variables, which it would not do for a stale hash.
 *   ✓ SearchCrossRetailerGroupResults runs ANONYMOUSLY and returns real itemIds.
 *   ✗ Items returns "Not Authenticated" without a cookie, so hydrating names and
 *     prices still needs a session. Untested with a real one.
 */

import axios, { AxiosInstance } from 'axios';
import type { Basket, BasketItem, Product, SearchOptions } from './types';
import { sumKnown, toPrice, toStock } from './normalise';

const ENDPOINT = 'https://www.instacart.com/graphql';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Captured persisted-query hashes. These WILL go stale — they are pinned to an
 * Instacart frontend build, not to a stable API version. A blanket failure with
 * "PersistedQueryNotSupported" means recapture, not a bug in this file.
 *
 * Captured from kleinjm/instacart_api, 2026-08.
 */
const PERSISTED_QUERIES: Record<string, string> = {
  SearchCrossRetailerGroupResults:
    '0ef32d339ed761d8609b91d8232a26b7b6b05206baf32694c6fa47f7f8e73a33',
  Items: '9ad66078d7fa81276b6bd4eb6a6f6fcdd1f4022ff0c3f5b4663c62877f06692a',
  UpdateCartItemsMutation:
    'ba4bf465d294d1d528d82a4ac48ac13980d528149874c0e52082dc1d833bdb09',
  PersonalActiveCarts:
    'eac9d17bd45b099fbbdabca2e111acaf2a4fa486f2ce5bc4e8acbab2f31fd8c0',
};

export class StalePersistedQueryError extends Error {
  constructor(operation: string) {
    super(
      `Instacart rejected the persisted query for "${operation}".\n` +
        `This almost always means Instacart shipped a new frontend build and the\n` +
        `hashes in src/providers/instacart-web.ts are stale. Recapture them from\n` +
        `a browser session and open a PR — see docs/providers/instacart-web.md.`
    );
    this.name = 'StalePersistedQueryError';
  }
}

export class InstacartWebProvider {
  readonly name = 'instacart-web';

  private http: AxiosInstance;
  private zoneId?: string;
  private postalCode?: string;
  private shopId?: string;

  constructor(
    sessionCookie = process.env.INSTACART_SESSION_COOKIE,
    opts: { zoneId?: string; postalCode?: string; shopId?: string } = {}
  ) {
    if (!sessionCookie) {
      throw new Error(
        'Instacart web needs a browser session cookie.\n' +
          'Set INSTACART_SESSION_COOKIE to the Cookie header from a logged-in\n' +
          'instacart.com tab (at minimum __Host-instacart_sid and its companions).\n' +
          'Their login is bot-protected, so this cannot be automated.'
      );
    }
    this.zoneId = opts.zoneId ?? process.env.INSTACART_ZONE_ID;
    this.postalCode = opts.postalCode ?? process.env.INSTACART_POSTAL_CODE;
    this.shopId = opts.shopId ?? process.env.INSTACART_SHOP_ID;

    this.http = axios.create({
      timeout: 20_000,
      headers: {
        Cookie: sessionCookie,
        'User-Agent': USER_AGENT,
        // Without this the persisted-query resolver rejects the variables.
        'X-Client-Identifier': 'web',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  private extensions(operation: string) {
    const sha256Hash = PERSISTED_QUERIES[operation];
    if (!sha256Hash) {
      throw new StalePersistedQueryError(operation);
    }
    return { persistedQuery: { version: 1, sha256Hash } };
  }

  private unwrap(data: any, operation: string): any {
    const errors = data?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const message = errors.map((e: any) => e?.message).join('; ');
      if (/PersistedQueryNotSupported|PersistedQueryNotFound/i.test(message)) {
        throw new StalePersistedQueryError(operation);
      }
      throw new Error(`Instacart GraphQL error: ${message}`);
    }
    return data?.data;
  }

  /** Persisted queries go over GET with the payload in the query string. */
  private async query(operation: string, variables: Record<string, unknown>) {
    const { data } = await this.http.get(ENDPOINT, {
      params: {
        operationName: operation,
        variables: JSON.stringify(variables),
        extensions: JSON.stringify(this.extensions(operation)),
      },
    });
    return this.unwrap(data, operation);
  }

  /** Mutations go over POST with a JSON body. */
  private async mutate(operation: string, variables: Record<string, unknown>) {
    const { data } = await this.http.post(ENDPOINT, {
      operationName: operation,
      variables,
      extensions: this.extensions(operation),
    });
    return this.unwrap(data, operation);
  }

  private requireLocation(): { zoneId: string; postalCode: string; shopId: string } {
    if (!this.zoneId || !this.postalCode || !this.shopId) {
      throw new Error(
        'Instacart web needs a location and a store to scope search and pricing.\n' +
          'Set INSTACART_ZONE_ID, INSTACART_POSTAL_CODE and INSTACART_SHOP_ID.\n\n' +
          'All three are embedded in any storefront page. For example:\n' +
          '  curl -s https://www.instacart.com/store/costco/storefront \\\n' +
          '    | python3 -c "import sys,urllib.parse,re; \\\n' +
          '        s=urllib.parse.unquote(urllib.parse.unquote(sys.stdin.read())); \\\n' +
          '        print({k:re.findall(chr(34)+k+chr(34)+r\'\\s*:\\s*\"?([0-9]+)\"?\', s)[:1] \\\n' +
          '               for k in (\'zoneId\',\'shopId\',\'postalCode\')})"\n\n' +
          'They are per-store and per-area, so use a store that delivers to you.'
      );
    }
    return { zoneId: this.zoneId, postalCode: this.postalCode, shopId: this.shopId };
  }

  /**
   * Search is TWO calls, and the first one needs no authentication.
   *
   * Verified against the live endpoint 2026-08-03:
   *
   *   SearchCrossRetailerGroupResults  → anonymous, returns `results[].itemIds`
   *   Items                            → "Not Authenticated" without a cookie
   *
   * So the search half works for anyone; only hydrating names and prices needs
   * the session. That is why a failure here reads very differently depending on
   * which leg broke, and why the two are reported separately.
   *
   * The required variables were discovered by letting the server name each
   * missing one in turn. `shopId` (singular) is required *in addition to*
   * `shopIds`, and `searchSource` is mandatory — omitting any of them fails
   * validation before the query runs.
   */
  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const { zoneId, postalCode, shopId } = this.requireLocation();
    const limit = options.limit ?? 10;

    const searchData = await this.query('SearchCrossRetailerGroupResults', {
      query,
      zoneId,
      postalCode,
      shopId,
      shopIds: [shopId],
      first: limit,
      searchSource: 'search',
    });

    const groups = searchData?.searchCrossRetailerGroupResults?.results ?? [];
    const itemIds: string[] = [];
    for (const group of groups) {
      for (const id of group?.itemIds ?? []) {
        if (itemIds.length < limit) itemIds.push(String(id));
      }
    }
    if (itemIds.length === 0) return [];

    // Second leg. This is the one that needs the cookie.
    const itemData = await this.query('Items', {
      ids: itemIds,
      zoneId,
      postalCode,
      shopId,
    });

    const items = itemData?.items ?? [];
    return items.map((item: any): Product => {
      const view = item?.viewSection ?? {};
      // Prices come back as display strings ("$4.99") more often than numbers.
      const price = toPrice(view.priceString ?? item?.pricing?.price);

      return {
        product_uid: String(item?.id ?? ''),
        name: item?.name ?? view.titleString ?? '(unnamed)',
        retail_price: { price },
        in_stock: toStock(item?.available),
        currency: 'USD',
        image_url: view.itemImage?.url ?? item?.imageUrl,
        provider: this.name,
        size: item?.size ?? view.sizeString,
      };
    });
  }

  async getBasket(): Promise<Basket> {
    const data = await this.query('PersonalActiveCarts', {});
    const carts = data?.personalActiveCarts ?? [];
    const items = (carts[0]?.items ?? []).map((i: any, idx: number) => ({
      item_id: String(i?.id ?? idx),
      product_uid: String(i?.itemId ?? i?.id ?? ''),
      name: i?.name ?? '(unnamed)',
      quantity: Number(i?.quantity ?? 1),
      unit_price: toPrice(i?.pricing?.unitPrice),
      total_price: toPrice(i?.pricing?.total),
    }));

    return {
      items,
      total_quantity: items.reduce((n: number, i: any) => n + i.quantity, 0),
      total_cost: sumKnown(items.map((i: BasketItem) => i.total_price)),
      provider: this.name,
    };
  }

  async addToBasket(productId: string, quantity = 1): Promise<void> {
    const { zoneId } = this.requireLocation();
    await this.mutate('UpdateCartItemsMutation', {
      zoneId,
      items: [{ itemId: productId, quantity }],
    });
  }

  async removeFromBasket(itemId: string): Promise<void> {
    await this.addToBasket(itemId, 0);
  }
}
