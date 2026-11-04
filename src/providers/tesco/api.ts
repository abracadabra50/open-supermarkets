/**
 * Tesco API Client — GraphQL via xapi.tesco.com
 *
 * All data operations go to https://xapi.tesco.com/ as batched GraphQL POSTs.
 * Endpoints and schema discovered via src/providers/tesco/discover.ts on 2026-03-08.
 *
 * Required headers on every request:
 *   x-apikey  — static API key (public, baked into the mfe bundles)
 *   language  — en-GB
 *   region    — UK
 *
 * Auth is carried via session cookies injected by setAuthCookies().
 *
 * Request format:  POST /  with body = JSON array of operation objects
 * Response format: JSON array of { data: { ... } } matching the batch order
 */

import axios, { AxiosInstance } from 'axios';

const XAPI_URL = 'https://xapi.tesco.com/';

/**
 * Product fields that exist on xapi's ProductInterface, checked against live
 * anonymous responses on 2026-11-04. `unitPrice`, `displayPrice` and
 * `isAvailable` are NOT fields there; selecting any of them fails the whole
 * query, which is why `product <id>` used to error.
 *
 * `status` / `isForSale` are scoped to the shopper's store: the session's store
 * when logged in, a default (GB) store otherwise. That is what makes a GB-only
 * product read as unavailable for a Northern Ireland account (issue #15).
 */
export const PRODUCT_FIELDS = `
  id
  tpnb
  tpnc
  gtin
  title
  description
  status
  isForSale
  defaultImageUrl
  price { actual unitPrice unitOfMeasure }
  promotions { description price { afterDiscount } unitSellingInfo }
`;

// Static API key baked into Tesco's mfe-* bundles (confirmed from discovery)
const TESCO_API_KEY = 'TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA';

function isAuthError(error: any): boolean {
  const status = error?.response?.status;
  return status === 401 || status === 403;
}

function tescoSessionHelp(status?: number): string {
  return [
    `Tesco session rejected${status ? ` (${status})` : ''}.`,
    'Run `groc --provider tesco status` to check the saved session.',
    'If it has expired, log in again or import fresh browser cookies:',
    '`groc --provider tesco import-session --file ~/Downloads/tesco-cookies.json`',
  ].join(' ');
}

export class TescoAPI {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      headers: {
        'x-apikey': TESCO_API_KEY,
        'language': 'en-GB',
        'region': 'UK',
        'content-type': 'application/json',
        'accept': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.tesco.com/groceries/en-GB/',
        'Origin': 'https://www.tesco.com',
      },
      withCredentials: true,
    });

    this.client.interceptors.response.use(
      response => response,
      error => {
        if (isAuthError(error)) {
          error.message = tescoSessionHelp(error.response?.status);
        }
        return Promise.reject(error);
      }
    );
  }

  /** Inject session cookies from ~/.tesco/session.json */
  setAuthCookies(cookieString: string): void {
    this.client.defaults.headers.common['Cookie'] = cookieString;
  }

  // ─────────────────────────────────────────────────────────
  // GraphQL helper
  // ─────────────────────────────────────────────────────────

  /**
   * Send a single GraphQL operation.
   * Tesco batches operations as an array; we wrap/unwrap automatically.
   */
  private async gql(operationName: string, query: string, variables: object = {}): Promise<any> {
    const response = await this.client.post(XAPI_URL, [
      { operationName, variables, query },
    ]);

    // Response is an array matching the batch order
    const result = Array.isArray(response.data) ? response.data[0] : response.data;

    if (result?.errors?.length) {
      const msg = result.errors.map((e: any) => e.message).join(', ');
      throw new Error(`GraphQL error (${operationName}): ${msg}`);
    }

    return result?.data;
  }

  // ─────────────────────────────────────────────────────────
  // Categories
  // ─────────────────────────────────────────────────────────

  async getCategories() {
    return this.gql('Taxonomy', `
      query Taxonomy($includeChildren: Boolean = true) {
        taxonomy(includeInspirationEvents: false) {
          name
          label
          children @include(if: $includeChildren) {
            id
            name
            label
            children {
              id
              name
              label
            }
          }
        }
      }
    `, { includeChildren: true });
  }

  // ─────────────────────────────────────────────────────────
  // Product Search
  // ─────────────────────────────────────────────────────────

  /**
   * Search for products with xapi's `search`, the query tesco.com itself uses.
   *
   * This replaced a two-step search (national TPNBs from search.api.tesco.com,
   * then a detail fetch per TPNB). The national list ignores the shopper's
   * store, so a Northern Ireland account was handed GB product codes that its
   * store doesn't sell (#15). xapi search is scoped the same way the storefront
   * is (session store, else a default) and returns status in one round trip.
   */
  async searchProducts(query: string, count: number = 24, page: number = 1) {
    const data = await this.gql('Search', `
      query Search($query: String!, $page: Int, $count: Int, $sortBy: String) {
        search(query: $query, page: $page, count: $count, sortBy: $sortBy) {
          info { total page count pageSize offset }
          results { node { ... on ProductType { ${PRODUCT_FIELDS} } } }
        }
      }
    `, { query, page, count, sortBy: 'relevance' });
    return (data?.search?.results ?? []).map((r: any) => r?.node).filter(Boolean).slice(0, count); // count is a hint to xapi
  }

  async getProduct(tpnc: string) {
    return this.gql('GetProduct', `
      query GetProduct($tpnc: String) {
        product(tpnc: $tpnc) { ${PRODUCT_FIELDS} }
      }
    `, { tpnc });
  }

  // ─────────────────────────────────────────────────────────
  // Basket
  // ─────────────────────────────────────────────────────────

  async getBasket() {
    // Query shape confirmed from mfe-trolley bundle (discovery 2026-03-08).
    // isInAmend / amendOrderId / amendExpiry / orderNo are the fields tesco.com's
    // own GetBasket reads to show its "you're editing order X" banner (bundle
    // read 2026-11-04). When isInAmend is true this basket IS the upcoming order.
    return this.gql('GetBasket', `
      query GetBasket($basketContexts: [BasketContextType]) {
        basket(basketContexts: $basketContexts) {
          id
          isInAmend
          amendOrderId
          amendExpiry
          orderNo
          splitView {
            id
            totalPrice
            guidePrice
            totalItems
            charges {
              fulfilment
              minimumValue
            }
            items {
              id
              quantity
              cost
              unit
              product {
                id
                tpnb
                gtin
                title
                defaultImageUrl
                price {
                  actual
                }
              }
            }
          }
        }
      }
    `, {});
  }

  /**
   * Add or update a basket item.
   * Tesco uses a single UpdateBasket mutation for both add and remove.
   * Requires the basket orderId from getBasket().basket.id
   *
   * @param tpnc     Tesco Product Number (numeric string)
   * @param quantity  New quantity — 0 removes the item
   * @param orderId  basket.id from getBasket() (the trn:tesco:order:... string)
   */
  async updateBasket(tpnc: string, quantity: number, orderId: string) {
    return this.gql('UpdateBasket', `
      mutation UpdateBasket($items: [BasketLineItemInputType], $orderId: ID) {
        basket(items: $items, orderId: $orderId) {
          id
          splitView {
            id
            totalPrice
            totalItems
            items {
              id
              quantity
              cost
              product {
                id
                title
              }
            }
          }
        }
      }
    `, {
      orderId,
      items: [{ adjustment: false, id: tpnc, newValue: quantity, newUnitChoice: 'pcs' }],
    });
  }

  // ─────────────────────────────────────────────────────────
  // Delivery Slots
  // ─────────────────────────────────────────────────────────

  async getSlots(start: string, end: string) {
    return this.gql('DeliverySlots', `
      query DeliverySlots($start: String, $end: String, $type: FulfilmentTypeType) {
        delivery(start: $start, end: $end) {
          id
          start
          end
          charge
          status
          group
          price {
            beforeDiscount
            afterDiscount
          }
          locationUuid
        }
        fulfilment(type: $type, range: { start: $start, end: $end }) {
          metadata {
            preBookedOrderDays
          }
        }
      }
    `, { start, end, type: 'DELIVERY_VAN' });
  }

  async bookSlot(slotId: string) {
    return this.gql('Fulfilment', `
      mutation Fulfilment($slotId: ID!) {
        fulfilment(slotId: $slotId) {
          orderId
          status
          error {
            code
            message
          }
        }
      }
    `, { slotId });
  }

  // ─────────────────────────────────────────────────────────
  // Orders (GraphQL — mfe-orders, discovered from live traffic 2026-08-08)
  // ─────────────────────────────────────────────────────────

  async getOrders(page: number = 1, pageSize: number = 10) {
    const data = await this.gql('GetPreviousOrdersWithPagination', `
      query GetPreviousOrdersWithPagination($orderContexts: [OrderContextType], $page: Int, $count: Int) {
        orderSearch(page: $page, count: $count, orderContexts: $orderContexts) {
          orders {
            id
            orderNo
            status
            createdDateTime
            totalPrice
            slot { start end charge }
            items {
              quantity
              unit
              weight
              product { id tpnb tpnc title }
            }
          }
        }
      }
    `, {
      orderContexts: [
        { type: 'GROCERY', statuses: ['Previous'] },
        { type: 'MARKETPLACE', statuses: ['Previous'] },
        { type: 'FNF', statuses: ['Previous'] },
      ],
      page,
      count: pageSize,
    });
    return data?.orderSearch;
  }

  async getOrder(orderId: string) {
    const data = await this.gql('GetOrderReceipt', `
      query GetOrderReceipt($id: ID!) {
        order(orderId: $id) {
          id
          orderNo
          status
          createdDateTime
          totalPrice
          slot { start end charge }
          splitView {
            items {
              id
              cost
              quantity
              product { title tpnb tpnc }
            }
          }
        }
      }
    `, { id: orderId });
    return data?.order;
  }
}
