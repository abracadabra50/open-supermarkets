/**
 * MCP tool routing, kept apart from the server so it can be tested without
 * starting one.
 */

import { PROVIDERS, supportsExtra, type Need } from './providers/registry';

/**
 * What each tool needs from a provider. This table plus the registry manifest
 * is the whole routing story: eligibility, the provider enum in each tool's
 * schema, and the login gate are all derived from it. A new provider needs a
 * manifest entry, not an edit here.
 *
 * `fixed` tools always act on one provider, whatever `provider` says.
 * Tools missing from the table (status, providers, compare) are global.
 */
export type Route = { need: Need; fixed?: string };

export const TOOL_ROUTES: Record<string, Route> = {
  grocery_login: { need: { capability: 'search', extra: 'login' } },
  grocery_search: { need: { capability: 'search' } },
  grocery_search_batch: { need: { capability: 'search' } },
  grocery_favourites: { need: { capability: 'search', extra: 'favourites' } },
  grocery_favourites_search: { need: { capability: 'search', extra: 'favourites' } },
  grocery_categories: { need: { capability: 'search', extra: 'categories' } },
  grocery_browse: { need: { capability: 'search', extra: 'browse' } },
  ocado_regulars: { need: { capability: 'search', extra: 'regulars' }, fixed: 'ocado' },
  grocery_basket_view: { need: { capability: 'basket' } },
  grocery_basket_add: { need: { capability: 'basket' } },
  grocery_basket_add_batch: { need: { capability: 'basket' } },
  grocery_basket_remove: { need: { capability: 'basket' } },
  grocery_basket_update: { need: { capability: 'basket' } },
  grocery_basket_clear: { need: { capability: 'basket' } },
  grocery_slots: { need: { capability: 'slots' } },
  grocery_book_slot: { need: { capability: 'slots' } },
  grocery_checkout: { need: { capability: 'checkout' } },
  grocery_orders: { need: { capability: 'orders' } },
  tesco_staples: { need: { capability: 'search', extra: 'staples' }, fixed: 'tesco' },
};

/** Provider ids a tool can be called with, straight from the manifests. */
export function eligibleProviders(tool: string): string[] {
  const route = TOOL_ROUTES[tool];
  if (!route) return PROVIDERS.map((p) => p.id);
  if (route.fixed) return [route.fixed];
  return PROVIDERS
    .filter((p) => p.capabilities.includes(route.need.capability))
    .filter((p) => !route.need.extra || supportsExtra(p.id, route.need.extra))
    .map((p) => p.id);
}

