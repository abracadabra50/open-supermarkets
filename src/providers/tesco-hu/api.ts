/**
 * Tesco Hungary — GraphQL client for https://xapi.tesco.com/
 *
 * bevasarlas.tesco.hu is the same Tesco micro-frontend platform as www.tesco.com
 * and talks to the same GraphQL backend ("mango") with the same public API key.
 * The `region` and `language` headers select the Hungarian catalogue: the same
 * product id returns "Banán lédig" with region HU and product-not-found with UK.
 *
 * Unlike the storefront, xapi answers plain HTTP clients — no Akamai challenge —
 * so search needs no browser and no account. Verified live 2026-09-17.
 *
 * Schema notes (introspection is disabled; learned from the site's SSR cache):
 *   - Product fields: id tpnb tpnc gtin title status isForSale defaultImageUrl
 *     price { actual unitPrice unitOfMeasure } reviews { stats { ... } } ...
 *   - The UK fields isAvailable / displayPrice / unitPrice do NOT exist here.
 *   - search(query, page, count, sortBy) and category(facet, page, sortBy, count)
 *     both return { info { total page count pageSize offset } results { node } }.
 *
 * Request format: POST / with a JSON array of operations; the response is an
 * array in the same order, each element { data, errors?, status }.
 */

import axios, { AxiosInstance } from 'axios';

export const XAPI_URL = 'https://xapi.tesco.com/';

/** Public key baked into the site's page config (`mangoApiKey`). Same as the UK. */
export const TESCO_API_KEY = 'TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA';

export interface TescoRegionConfig {
  /** Provider id used in error messages, e.g. "tesco-hu". */
  id: string;
  /** `region` header, upper-case, e.g. "HU". */
  region: string;
  /** `language` and `accept-language` headers, e.g. "hu-HU". */
  language: string;
  /** ISO 4217. */
  currency: string;
  /** Storefront origin, used for Origin/Referer headers. */
  origin: string;
  /** Shop path prefix on the storefront, e.g. "/shop/hu-HU/". */
  shopPath: string;
}

export const TESCO_HU: TescoRegionConfig = {
  id: 'tesco-hu',
  region: 'HU',
  language: 'hu-HU',
  currency: 'HUF',
  origin: 'https://bevasarlas.tesco.hu',
  shopPath: '/shop/hu-HU/',
};

export class TescoHuSessionError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TescoHuSessionError';
    this.status = status;
  }
}

export function sessionHelp(providerId: string, status?: number): string {
  return [
    `${providerId} session missing or rejected${status ? ` (${status})` : ''}.`,
    `Sign in at https://www.tesco.hu/account/login/hu-HU in your browser, copy the Cookie request header`,
    `from DevTools → Network on any bevasarlas.tesco.hu request, then run`,
    `\`supermarket --provider ${providerId} import-session --stdin\` and paste it.`,
    `Check with \`supermarket status --provider ${providerId}\`.`,
  ].join(' ');
}

const PRODUCT_FIELDS = `
  id
  tpnb
  tpnc
  gtin
  title
  status
  isForSale
  defaultImageUrl
  bulkBuyLimit
  averageWeight
  productType
  superDepartmentName
  departmentName
  aisleName
  shelfName
  price { actual unitPrice unitOfMeasure }
  promotions { id description }
  reviews { stats { noOfReviews overallRating } }
`;

function httpStatusOf(err: any): number | undefined {
  return err?.response?.status ?? err?.extensions?.http?.status;
}

export class TescoHuAPI {
  readonly config: TescoRegionConfig;
  private client: AxiosInstance;

  constructor(config: TescoRegionConfig = TESCO_HU) {
    this.config = config;
    this.client = axios.create({
      headers: {
        'x-apikey': TESCO_API_KEY,
        region: config.region,
        language: config.language,
        'accept-language': config.language,
        'content-type': 'application/json',
        accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Origin: config.origin,
        Referer: `${config.origin}${config.shopPath}`,
      },
    });
  }

  /** Inject cookies from an imported session (see session.ts). */
  setAuthCookies(cookieString: string): void {
    this.client.defaults.headers.common['Cookie'] = cookieString;
  }

  hasAuthCookies(): boolean {
    return Boolean(this.client.defaults.headers.common['Cookie']);
  }

  /**
   * Send one operation as a one-element batch and unwrap the first result.
   * GraphQL errors are thrown; an Unauthorized error or a 401/403 becomes a
   * TescoHuSessionError so the CLI/MCP boundary can tell the user what to do.
   */
  private async gql(operationName: string, query: string, variables: object = {}): Promise<any> {
    let response;
    try {
      response = await this.client.post(XAPI_URL, [{ operationName, variables, query }]);
    } catch (err: any) {
      const status = httpStatusOf(err);
      if (status === 401 || status === 403) throw new TescoHuSessionError(sessionHelp(this.config.id, status), status);
      throw err;
    }

    const result = Array.isArray(response.data) ? response.data[0] : response.data;
    const errors: any[] = result?.errors ?? [];
    if (errors.length) {
      const auth = errors.find(
        e => /unauthori[sz]ed/i.test(String(e?.message)) || [401, 403].includes(httpStatusOf(e) as number)
      );
      if (auth) {
        const status = httpStatusOf(auth) ?? 401;
        throw new TescoHuSessionError(sessionHelp(this.config.id, status), status);
      }
      const msg = errors.map(e => e?.message).filter(Boolean).join(', ');
      throw new Error(`GraphQL error (${operationName}): ${msg}`);
    }
    return result?.data;
  }

  // ── catalogue (anonymous) ────────────────────────────────────────────

  async search(query: string, page: number, count: number): Promise<{ total: number; products: any[] }> {
    const data = await this.gql(
      'Search',
      `query Search($query: String!, $page: Int, $count: Int, $sortBy: String) {
        search(query: $query, page: $page, count: $count, sortBy: $sortBy) {
          info { total page count pageSize offset }
          results { node { ... on ProductType { ${PRODUCT_FIELDS} } } }
        }
      }`,
      { query, page, count, sortBy: 'relevance' }
    );
    const results: any[] = data?.search?.results ?? [];
    return {
      total: Number(data?.search?.info?.total ?? 0),
      products: results.map(r => r?.node).filter(Boolean),
    };
  }

  async getProduct(tpnc: string): Promise<any> {
    const data = await this.gql(
      'GetProduct',
      `query GetProduct($tpnc: String) { product(tpnc: $tpnc) { ${PRODUCT_FIELDS} } }`,
      { tpnc }
    );
    return data?.product;
  }

  /** Superdepartment → department → aisle tree. */
  async getCategories(): Promise<any[]> {
    const data = await this.gql(
      'Taxonomy',
      `query Taxonomy($includeChildren: Boolean = true) {
        taxonomy(includeInspirationEvents: false) {
          name
          label
          children @include(if: $includeChildren) {
            id
            name
            label
            children { id name label }
          }
        }
      }`,
      { includeChildren: true }
    );
    return data?.taxonomy ?? [];
  }

  // ── basket (needs an imported session) ──────────────────────────────

  async getBasket(): Promise<any> {
    return this.gql(
      'GetBasket',
      `query GetBasket {
        basket {
          id
          splitView {
            id
            totalPrice
            guidePrice
            totalItems
            items {
              id
              quantity
              cost
              unit
              product { id tpnb gtin title defaultImageUrl price { actual unitPrice unitOfMeasure } }
            }
          }
        }
      }`
    );
  }

  /**
   * Add, change or remove a line. quantity 0 removes. orderId is basket.id from
   * getBasket(). Same mutation the Hungarian mfe-basket-manager bundle uses.
   */
  async updateBasket(tpnc: string, quantity: number, orderId: string): Promise<any> {
    return this.gql(
      'UpdateBasket',
      `mutation UpdateBasket($items: [BasketLineItemInputType], $orderId: ID) {
        basket(items: $items, orderId: $orderId) {
          id
          splitView {
            id
            totalPrice
            totalItems
            items { id quantity cost product { id title } }
          }
        }
      }`,
      { orderId, items: [{ adjustment: false, id: tpnc, newValue: quantity, newUnitChoice: 'pcs' }] }
    );
  }
}
