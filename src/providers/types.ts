// Provider interface for grocery supermarkets

export interface Product {
  product_uid: string;
  name: string;
  description?: string;
  /**
   * `price` is null when the retailer gave no usable price. Never 0: zero
   * means free. Consumers must treat null as "unknown", not as cheapest.
   */
  retail_price: {
    price: number | null;
  };
  unit_price?: {
    measure: string;
    price: number;
  };
  /**
   * true = the retailer says it can be bought, false = it says it can't,
   * null = it didn't say. Never turn a missing signal into true or false.
   */
  in_stock: boolean | null;
  image_url?: string;
  provider: string; // sainsburys, ocado, tesco, etc.
  /**
   * ISO 4217, e.g. "GBP", "EUR", "USD". Optional for backwards compatibility;
   * absent means GBP, which is where this project started. Set it in any
   * non-UK provider — printing a euro price with a pound sign is a bug users
   * notice immediately.
   */
  currency?: string;
  rating?: number;       // 0-5 overall rating, when the provider exposes it
  review_count?: number; // number of ratings behind `rating`
  size?: string;         // pack size, e.g. "750g", "6 pack"
  /**
   * GTIN-14, when the provider exposes a real barcode.
   *
   * This is the only field that means the same thing at two different
   * retailers, so it is what turns "compare these baskets" from fuzzy name
   * matching into an exact join — the same argument `kroger.ts` already makes
   * for Open Food Facts enrichment. Own-label lines have no shared barcode by
   * definition and simply leave it undefined.
   *
   * Always normalised through `gtin.ts` to GTIN-14 and check-digit validated,
   * because providers disagree about zero-padding: Tesco returns
   * `05000157024886`, Sainsbury's `5000157024886`.
   */
  gtin?: string;
  /**
   * Guaranteed remaining life in DAYS from delivery, when the provider states
   * it. Ocado's `LIFE 3d+` badge is this number.
   *
   * Worth a field of its own because it is per-PACK and stated by the retailer:
   * a generic "milk keeps a week" table cannot tell Cravendale's two weeks from
   * a fresh organic line's six days, and any caller sequencing a meal plan or
   * flagging waste needs the difference. Absent means the provider said
   * nothing — never assume a default.
   */
  shelf_life_days?: number;
}

export interface BasketItem {
  item_id: string;
  product_uid: string;
  name: string;
  quantity: number;
  /** null when the retailer does not expose reliable line pricing. */
  unit_price: number | null;
  total_price: number | null;
}

export interface Basket {
  items: BasketItem[];
  total_quantity: number;
  /** null when the retailer gives no total and any line price is unknown. */
  total_cost: number | null;
  provider: string;
  /** ISO 4217. Absent means GBP, like Product.currency. Non-UK providers must set it. */
  currency?: string;
  /** Provider's id for this basket, when it has one. */
  basket_id?: string;
  /**
   * Set when the "basket" is really an upcoming order the shopper is amending.
   * Writes then change that order, not a fresh trolley, so providers refuse
   * them unless the caller opted in with allowOrderAmend(true).
   */
  amend?: OrderAmend;
}

export interface OrderAmend {
  order_id: string;
  order_no?: string;
  /** ISO time the amend window closes, when the provider says. */
  expires_at?: string;
}

export interface DeliverySlot {
  slot_id: string;
  start_time: string;
  end_time: string;
  date: string;
  price: number;
  available: boolean;
}

export interface Order {
  order_id: string;
  status: string;
  total: number;
  delivery_slot?: DeliverySlot;
  items: BasketItem[];
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  category?: string;
}

/**
 * What a provider can actually do.
 *
 * A provider is not all-or-nothing. Catalogue search usually needs no account
 * at all, while checkout needs an account, an address and a card. Splitting
 * these means someone can contribute a search-only provider for their country
 * in an afternoon, instead of being blocked on implementing checkout.
 */
export type Capability =
  | 'search'    // product search + lookup. No account for most providers.
  | 'basket'    // add/remove/read a basket. Needs an account.
  | 'slots'     // delivery slot availability. Needs an account.
  | 'checkout'  // place a real order. Needs account + address + payment.
  | 'orders';   // order history. Needs an account.

/** How you authenticate. Ordered roughly by how painful it is to automate. */
export type AuthModel =
  | 'none'           // open endpoints, no token at all
  | 'anonymous'      // token issued to anyone who asks, no account
  | 'api-key'        // official API key
  | 'oauth'          // official OAuth2
  | 'credentials'    // email + password, scriptable
  | 'session-cookie';// login is bot-protected; needs a cookie from a real browser

/**
 * Features only some providers have. Declared in the manifest so every
 * interface can refuse them before loading provider code.
 */
export type Extra =
  | 'login'       // scripted email + password login (supermarket login)
  | 'favourites'  // the account's favourites list, and search within it
  | 'categories'  // category tree
  | 'browse'      // list products in a category path
  | 'regulars'    // Ocado "Regulars"
  | 'staples';    // Tesco repeat-purchase staples from order history

export type ProviderTier =
  | 'core'       // maintained here, exercised in CI
  | 'community'; // contributed; best-effort, owned by its maintainer

export interface ProviderManifest {
  id: string;
  /** Display name, e.g. "Albert Heijn". */
  label: string;
  /** ISO 3166-1 alpha-2, or 'XX' for multi-country aggregators. */
  country: string;
  /** Countries served, when one integration spans several. */
  countries?: string[];
  capabilities: Capability[];
  auth: AuthModel;
  tier: ProviderTier;
  /** GitHub handle of whoever owns breakage. Community providers must have one. */
  maintainer?: string;
  /** Where the protocol knowledge came from, if it was reverse-engineered elsewhere. */
  credit?: string;
  /**
   * Where a stored login lives, relative to the home directory, e.g.
   * '.sainsburys/session.json'. Interfaces check for it before any work that
   * needs an account. Omit when auth comes from env vars or there is none.
   */
  session?: string;
  /** Search also needs that stored login. Default: search does not. */
  searchNeedsSession?: boolean;
  /** Provider-specific features beyond the shared capabilities. */
  extras?: Extra[];
  /**
   * Dynamic import. Deliberately a thunk: the registry can list and filter every
   * provider without loading any of their code. A user in the UK never parses
   * the German provider.
   */
  load: () => Promise<ProviderConstructor>;
}

export type ProviderConstructor = new () => GroceryProvider;

/**
 * The provider contract.
 *
 * Only `name` and `search` are required. Everything else is optional and
 * declared through the manifest's `capabilities`. Call `assertCapability()`
 * before reaching for an optional method.
 */
export interface GroceryProvider {
  readonly name: string;

  // ── search (required) ────────────────────────────────────────────────
  search(query: string, options?: SearchOptions): Promise<Product[]>;
  getProduct?(productId: string): Promise<Product>;
  getCategories?(): Promise<any>;

  // ── auth ─────────────────────────────────────────────────────────────
  login?(email: string, password: string): Promise<void>;
  logout?(): Promise<void>;
  isAuthenticated?(): Promise<boolean>;

  // ── basket ───────────────────────────────────────────────────────────
  getBasket?(): Promise<Basket>;
  addToBasket?(productId: string, quantity: number): Promise<void>;
  updateBasketItem?(itemId: string, quantity: number): Promise<void>;
  removeFromBasket?(itemId: string): Promise<void>;
  clearBasket?(): Promise<void>;
  /**
   * Opt in to basket writes that edit an upcoming order in amend mode.
   * Off by default: a write that would silently change someone's next
   * delivery throws OrderAmendError instead.
   */
  allowOrderAmend?(allow: boolean): void;

  // ── delivery & checkout ──────────────────────────────────────────────
  getDeliverySlots?(): Promise<DeliverySlot[]>;
  bookSlot?(slotId: string): Promise<void>;
  checkout?(dryRun?: boolean): Promise<Order>;

  // ── orders ───────────────────────────────────────────────────────────
  getOrders?(): Promise<Order[]>;
}

/**
 * A provider that implements the whole surface — search through checkout.
 *
 * This exists so code that has already established it is holding a full-service
 * provider (the UK three, reached through `ProviderFactory`) does not need a
 * capability guard on every call. New code should prefer `GroceryProvider` plus
 * `assertCapability()`, which is honest about the fact that most providers in
 * the world do not do checkout.
 */
export type FullGroceryProvider = Required<Omit<GroceryProvider, 'allowOrderAmend'>> &
  Pick<GroceryProvider, 'allowOrderAmend'>;
