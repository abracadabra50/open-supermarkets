/**
 * Money formatting, shared by the CLI, the MCP server and the HTTP API.
 *
 * This lives in its own module because the pound sign was previously hardcoded
 * in a dozen places across three entrypoints. That was harmless while the
 * project was UK-only and became a correctness bug the moment it wasn't — an
 * Instacart basket reporting dollars as pounds is worse than no total at all.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
  CAD: 'CA$',
  AUD: 'A$',
  PLN: 'zł',
  SEK: 'kr',
  CHF: 'CHF ',
  HUF: 'Ft',
};

/**
 * Currencies conventionally written as a whole number followed by the symbol,
 * e.g. "126 Ft". Forint has no sub-unit in use, so "Ft126.00" reads as wrong to
 * anyone who has shopped in Hungary.
 */
const WHOLE_NUMBER_SUFFIX = new Set(['HUF']);

/**
 * Symbol for a currency code, falling back to the code itself so an unmapped
 * currency reads as "BRL 12.00" rather than silently claiming to be sterling.
 */
export function sym(currency?: string): string {
  const code = currency ?? 'GBP';
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

/** What unknown money reads as, everywhere. */
export const UNKNOWN_PRICE = 'price unknown';

/**
 * Format an amount as a price: two decimals, correct symbol. A missing amount
 * reads as "price unknown" rather than £0.00, which would mean free.
 */
export function money(amount: number | null | undefined, currency?: string): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return UNKNOWN_PRICE;
  const code = currency ?? 'GBP';
  const value = Number(amount);
  if (WHOLE_NUMBER_SUFFIX.has(code)) {
    return `${Math.round(value)} ${sym(code)}`;
  }
  return `${sym(code)}${value.toFixed(2)}`;
}

/**
 * Products worth offering as a deal: known price, and not known to be out of
 * stock. null stock is kept and shown as unknown rather than dropped.
 */
export function dealCandidates<T extends Priced>(products: T[]): T[] {
  return products.filter((p) => p.in_stock !== false && p.retail_price.price !== null);
}

/** Stock as words. null/undefined means the retailer did not say. */
export function stockLabel(inStock: boolean | null | undefined): 'In stock' | 'Out of stock' | 'Stock unknown' {
  if (inStock === true) return 'In stock';
  if (inStock === false) return 'Out of stock';
  return 'Stock unknown';
}

/** Ascending by price with unknown prices last, so "cheapest" is never a guess. */
export function byPrice<T extends { retail_price: { price: number | null } }>(a: T, b: T): number {
  const pa = a.retail_price.price;
  const pb = b.retail_price.price;
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  return pa - pb;
}

type Priced = { retail_price: { price: number | null }; in_stock: boolean | null };

/**
 * The cheapest product that has a known price and is not known to be out of
 * stock. Unknown stock (null) stays eligible: it is unknown, not unavailable.
 */
export function cheapest<T extends Priced>(products: T[]): T | undefined {
  const priced = dealCandidates(products);
  return priced.length ? [...priced].sort(byPrice)[0] : undefined;
}
