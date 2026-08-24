/**
 * Batch primitives, for agents.
 *
 * A week of meals is roughly thirty ingredients. One at a time that is thirty
 * searches plus thirty adds — sixty process starts at ~0.85s each, sixty MCP
 * round trips, and sixty tool results sitting in the model's context. The agent
 * spends most of its budget on plumbing rather than on deciding what to cook,
 * and every one of those calls is a place a run can half-fail and leave a basket
 * in an unknown state.
 *
 * These run the same work in one invocation, one auth, one report.
 *
 * Deliberately NOT included: any attempt to resolve ambiguity. Picking between a
 * 650g pack and a 200g recipe requirement is a judgement about someone's money
 * and their fridge, and the model has context the CLI never will — the rest of
 * the meal plan, the budget, whether leftovers are fine. So batch search returns
 * CANDIDATES and the model chooses. The CLI does not get an opinion.
 */

import type { GroceryProvider, Product, SearchOptions } from './providers/types';

/** A query, or a query with per-item overrides. */
export type BatchQuery = string | { query: string; limit?: number };

export interface BatchSearchResult {
  query: string;
  products: LeanProduct[];
  error?: string;
}

/**
 * The fields a model needs to choose between two milks, and nothing else.
 *
 * Thirty queries × five candidates × a full Product is a serious slice of a
 * context window, and images, descriptions and ratings are noise to something
 * deciding on price, size and availability.
 */
export interface LeanProduct {
  id: string;
  name: string;
  price: number;
  currency: string;
  size?: string;
  unit?: string;
  /** `null` means the retailer did not expose a product-level stock signal. */
  inStock: boolean | null;
}

export function lean(p: Product): LeanProduct {
  const unit = p.unit_price?.price
    ? `${p.unit_price.price}${p.unit_price.measure ? `/${p.unit_price.measure}` : ''}`
    : undefined;
  return {
    id: p.product_uid,
    name: p.name,
    price: p.retail_price.price,
    currency: p.currency ?? 'GBP',
    size: p.size,
    unit,
    inStock: p.in_stock,
  };
}

function normalise(q: BatchQuery): { query: string; limit?: number } {
  return typeof q === 'string' ? { query: q } : q;
}

/**
 * Run many searches against one provider.
 *
 * Bounded concurrency because these are reverse-engineered endpoints that
 * rate-limit — firing thirty parallel requests at Albert Heijn is how you get a
 * 403 and conclude the integration is broken. A failed query yields an `error`
 * on that entry rather than sinking the batch, since one bad ingredient should
 * not cost you the other twenty-nine.
 */
export async function batchSearch(
  provider: GroceryProvider,
  queries: BatchQuery[],
  options: SearchOptions & { concurrency?: number } = {}
): Promise<BatchSearchResult[]> {
  const concurrency = options.concurrency ?? 4;
  const items = queries.map(normalise);
  const out: BatchSearchResult[] = new Array(items.length);

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      const { query, limit } = items[i];
      try {
        const products = await provider.search(query, {
          ...options,
          limit: limit ?? options.limit ?? 5,
        });
        out[i] = { query, products: products.map(lean) };
      } catch (err: any) {
        out[i] = { query, products: [], error: err?.message ?? String(err) };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return out;
}

export interface BatchAddItem {
  id: string;
  qty?: number;
}

export interface BatchAddResult {
  id: string;
  qty: number;
  ok: boolean;
  error?: string;
}

/**
 * Add many products to a basket.
 *
 * Sequential, unlike search. Baskets are mutable server-side state and several
 * providers resolve item ids against the live basket on every write, so
 * concurrent adds race each other. Slower and correct beats faster and wrong
 * when the artefact is someone's shopping.
 */
export async function batchAdd(
  provider: GroceryProvider,
  items: BatchAddItem[]
): Promise<BatchAddResult[]> {
  if (typeof provider.addToBasket !== 'function') {
    throw new Error(`${provider.name} does not support baskets.`);
  }

  const results: BatchAddResult[] = [];
  for (const { id, qty = 1 } of items) {
    try {
      await provider.addToBasket(id, qty);
      results.push({ id, qty, ok: true });
    } catch (err: any) {
      results.push({ id, qty, ok: false, error: err?.message ?? String(err) });
    }
  }
  return results;
}

/**
 * Parse a batch file or stdin payload.
 *
 * Accepts what an agent is likely to emit without being told a schema: a bare
 * array of strings, an array of objects, or either wrapped in `{queries}` /
 * `{items}`. Newline-delimited plain text works too, because that is what falls
 * out of a shell pipeline.
 */
export function parseBatchInput(raw: string): BatchQuery[] {
  const text = raw.trim();
  if (!text) throw new Error('Batch input was empty.');

  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed.queries ?? parsed.items ?? parsed.products;
    if (!Array.isArray(arr)) {
      throw new Error(
        'Expected a JSON array, or an object with a "queries" array. ' +
          'Example: ["milk","eggs"] or [{"query":"milk","limit":3}]'
      );
    }
    return arr;
  }

  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

export function parseAddInput(raw: string): BatchAddItem[] {
  const text = raw.trim();
  if (!text) throw new Error('Batch input was empty.');

  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.products;
    if (!Array.isArray(arr)) {
      throw new Error('Expected a JSON array of {id, qty}, or an object with an "items" array.');
    }
    return arr.map((x: any) =>
      typeof x === 'string' ? { id: x } : { id: String(x.id ?? x.product_uid), qty: x.qty }
    );
  }

  // "id qty" or just "id", one per line.
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const [id, qty] = l.split(/\s+/);
      // Omit qty entirely when absent, so this path produces the same shape as
      // the JSON one. An `undefined` key and a missing key are different objects
      // to anything comparing them, and inconsistency here surfaces as a
      // baffling test failure rather than a bug you can see.
      return qty ? { id, qty: Number(qty) } : { id };
    });
}
