/**
 * GTIN normalisation, so two providers' barcodes are comparable.
 *
 * Tesco and Sainsbury's both return a real barcode for the same product, in
 * different shapes: Tesco zero-pads to 14 (`05000157024671`), Sainsbury's
 * returns a bare EAN-13 (`5000157026071`). Compared as strings those never
 * match, which is the whole reason a caller cannot currently line up a branded
 * product across two retailers.
 *
 * GS1's own rule is that a GTIN is a number, not a string: shorter forms are
 * the same identifier left-padded with zeros. So everything is widened to
 * GTIN-14 and compared there.
 */

/** Digits only, widened to GTIN-14. Returns undefined if it is not a GTIN. */
export function toGtin14(raw?: string | number | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const digits = String(raw).replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return undefined;
  // GTIN-8, -12, -13 and -14 are the only valid lengths. Anything else is an
  // internal product code that happens to be numeric — a Tesco TPNB, say — and
  // treating one of those as a barcode is worse than having none, because it
  // silently matches nothing while looking authoritative.
  if (digits.length > 14 || ![8, 12, 13, 14].includes(digits.length)) return undefined;
  return digits.padStart(14, '0');
}

/**
 * GS1 mod-10 check digit. The last digit of a GTIN is derived from the rest,
 * so a transposed or truncated code is detectable rather than merely wrong.
 */
export function isValidGtin(raw?: string | number | null): boolean {
  const g = toGtin14(raw);
  if (!g) return false;
  const body = g.slice(0, 13);
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    // Weights alternate 3,1,... from the LEFT of a 13-digit body.
    sum += Number(body[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(g[13]);
}

/** Normalise, and drop anything that fails its own check digit. */
export function cleanGtin(raw?: string | number | null): string | undefined {
  const g = toGtin14(raw);
  return g && isValidGtin(g) ? g : undefined;
}
