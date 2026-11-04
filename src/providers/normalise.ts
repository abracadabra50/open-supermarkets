/**
 * Shared helpers for turning retailer data into the common contract without
 * inventing values.
 *
 * Missing data is `null`, never `0` or `true`. A zero price means free and a
 * `true` stock flag means the retailer said so; neither is a safe default when
 * the upstream field is absent or unparseable.
 */

/**
 * A price from a number or a display string ("$4.99", "1,25 €"). Returns null
 * for anything absent, empty, negative or unparseable.
 */
export function toPrice(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else {
    let s = String(v).replace(/[^\d.,-]/g, '');
    // "1,25" is a decimal comma; "1,234.50" is a thousands separator.
    s = s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.');
    if (!/\d/.test(s)) return null;
    n = Number(s);
  }
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** True or false only when the retailer said so; anything else is unknown. */
export function toStock(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Sum of line amounts, or null if any line is unknown. An empty list is 0. */
export function sumKnown(values: Array<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/** Unit price from a line total, or null when either side is unknown. */
export function perUnit(total: number | null, quantity: number): number | null {
  return total !== null && quantity > 0 ? total / quantity : null;
}
