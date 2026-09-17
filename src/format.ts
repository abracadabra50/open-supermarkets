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

/** Format an amount as a price: two decimals, correct symbol. */
export function money(amount: number, currency?: string): string {
  const code = currency ?? 'GBP';
  const value = Number(amount ?? 0);
  if (WHOLE_NUMBER_SUFFIX.has(code)) {
    return `${Math.round(value)} ${sym(code)}`;
  }
  return `${sym(code)}${value.toFixed(2)}`;
}
