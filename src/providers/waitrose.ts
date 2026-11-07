/**
 * Waitrose (United Kingdom) — anonymous public catalogue search.
 *
 * Waitrose renders its catalogue in a browser context and may reject cold HTTP
 * clients. Search is deliberately read-only: no account, postcode, cookies or
 * basket state are persisted. Because the public catalogue is not tied to a
 * delivery address, stock is unknown rather than assumed available.
 */

import { chromium } from 'playwright';
import type { Browser, LaunchOptions, Page } from 'playwright';
import type { GroceryProvider, Product, SearchOptions } from './types';

export const WAITROSE = {
  id: 'waitrose',
  label: 'Waitrose',
  country: 'GB',
  currency: 'GBP',
} as const;

const BASE_URL = 'https://www.waitrose.com';
const SEARCH_PATH = '/ecom/shop/search';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const SEARCH_TIMEOUT = 20_000;

export interface WaitroseCard {
  id?: string;
  href?: string;
  name?: string;
  text?: string;
  imageUrl?: string;
}

export class WaitroseError extends Error {}

export type WaitroseBrowserLauncher = (options: LaunchOptions) => Promise<Browser>;

/** Convert Waitrose's public pound or pence labels to a numeric GBP amount. */
function money(value: string): number | undefined {
  const trimmed = value.replace(/,/g, '').trim();
  const pence = trimmed.match(/^(\d+(?:\.\d+)?)p$/i);
  if (pence) return Number(pence[1]) / 100;
  const pounds = trimmed.match(/^£\s*(\d+(?:\.\d+)?)$/);
  if (pounds) return Number(pounds[1]);
  return undefined;
}

/** Prefer the explicit product id, otherwise recover the stable id from its product URL. */
function productId(card: WaitroseCard): string | undefined {
  if (card.id?.trim()) return card.id.trim();
  const match = card.href?.match(/\/(\d+(?:-\d+)*)\/?(?:[?#].*)?$/);
  return match?.[1];
}

/** Return the first meaningful line of a product-card text block. */
function firstLine(value: string | undefined): string | undefined {
  const line = value?.split(/\r?\n/).map(part => part.trim()).find(Boolean);
  return line || undefined;
}

/** Parse one public product card captured from the Waitrose search page. */
export function normaliseWaitroseCard(card: WaitroseCard): Product | undefined {
  const id = productId(card);
  const text = card.text ?? '';
  const name = card.name?.trim() || firstLine(text);
  const itemPrice = text.match(/Item price\s*\n?\s*(£\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?p)/i)?.[1];
  const price = itemPrice ? money(itemPrice) : undefined;

  if (!id || !name || price === undefined || !Number.isFinite(price)) return undefined;

  const unitMatch = text.match(
    /Price per unit\s*\n?\s*(£\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?p)\s*(?:\/\s*)?([^\n]+)/i
  );
  const unitPrice = unitMatch ? money(unitMatch[1]) : undefined;
  const size = name.match(/(?:\d+(?:\.\d+)?\s*(?:kg|g|ml|litre|litres|l)|\d+\s*(?:pack|s)\b)/i)?.[0];

  return {
    product_uid: id,
    name,
    retail_price: { price },
    unit_price:
      unitPrice !== undefined
        ? { price: unitPrice, measure: unitMatch?.[2].trim() ?? '' }
        : undefined,
    // Public pages are not associated with a delivery postcode.
    in_stock: null,
    image_url: card.imageUrl,
    provider: WAITROSE.id,
    currency: WAITROSE.currency,
    size,
  };
}

/** Extract product-card fields from the public search page without persisting browser state. */
async function cardsFromPage(page: Page): Promise<WaitroseCard[]> {
  return page.locator('a[href*="/ecom/products/"]').evaluateAll((anchors: any[]) => {
    const cards: Array<{
      id?: string;
      href?: string;
      name?: string;
      text?: string;
      imageUrl?: string;
    }> = [];
    const seen = new Set<string>();

    for (const anchor of anchors) {
      const href = anchor.href as string;
      if (!href || seen.has(href)) continue;
      seen.add(href);

      let root: any = anchor;
      while (root.parentElement && !/Item price/i.test(root.innerText) && root.parentElement.tagName !== 'BODY') {
        root = root.parentElement;
      }
      const image: any = root.querySelector('img');
      cards.push({
        href,
        name: anchor.getAttribute('aria-label') || undefined,
        text: root.innerText,
        imageUrl: image?.currentSrc || image?.src || undefined,
      });
    }
    return cards;
  });
}

/** Identify Waitrose's explicit empty-search messages without masking malformed pages. */
function isNoResults(text: string): boolean {
  return /(?:no results|couldn't find|cannot find|no products found)/i.test(text);
}

export class WaitroseProvider implements GroceryProvider {
  readonly name = WAITROSE.id;

  constructor(private readonly launch: WaitroseBrowserLauncher = options => chromium.launch(options)) {}

  /** Search the public catalogue in a fresh anonymous browser context. */
  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    const term = query.trim();
    if (!term) throw new WaitroseError('Waitrose search query must not be empty');

    const limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
      throw new WaitroseError(`Waitrose search limit must be an integer between 0 and ${MAX_LIMIT}`);
    }
    if ((options.offset ?? 0) !== 0) {
      throw new WaitroseError('Waitrose search pagination is not implemented yet');
    }
    if (options.category) throw new WaitroseError('Waitrose category filtering is not implemented yet');
    if (limit === 0) return [];

    let browser: Browser | undefined;
    try {
      browser = await this.launch({ headless: true });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const url = new URL(SEARCH_PATH, BASE_URL);
        url.searchParams.set('searchTerm', term);
        const response = await page.goto(url.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: SEARCH_TIMEOUT,
        });

        if (!response || response.status() >= 400) {
          throw new WaitroseError(`Waitrose search failed${response ? ` (HTTP ${response.status()})` : ''}`);
        }

        await page.locator('a[href*="/ecom/products/"]').first().waitFor({ timeout: SEARCH_TIMEOUT }).catch(() => undefined);
        const cards = await cardsFromPage(page);
        const products = cards
          .map(normaliseWaitroseCard)
          .filter((product): product is Product => product !== undefined);

        if (!products.length) {
          const body = await page.locator('body').innerText();
          if (isNoResults(body)) return [];
          throw new WaitroseError('Waitrose search returned an unexpected page without product cards');
        }
        return products.slice(0, limit);
      } finally {
        await context.close();
      }
    } catch (error) {
      if (error instanceof WaitroseError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new WaitroseError(`Waitrose search failed: ${detail}`);
    } finally {
      await browser?.close();
    }
  }
}
