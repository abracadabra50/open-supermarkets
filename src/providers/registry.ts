/**
 * The provider registry.
 *
 * Two rules make this scale past one country:
 *
 *   1. Manifests are declarative and import nothing. Listing, filtering and
 *      the capability matrix all work without loading a single provider.
 *   2. Provider code is loaded on demand, by country. Someone shopping in the
 *      UK never loads the German provider, never installs its dependencies'
 *      cost, and never sees its breakage.
 *
 * Adding a provider means adding one manifest entry and one file. Nothing else
 * in the codebase needs to know it exists.
 */

import type {
  Capability,
  GroceryProvider,
  ProviderManifest,
} from './types';

export const PROVIDERS: ProviderManifest[] = [
  // ── United Kingdom ───────────────────────────────────────────────────
  {
    id: 'sainsburys',
    label: "Sainsbury's",
    country: 'GB',
    capabilities: ['search', 'basket', 'slots', 'checkout', 'orders'],
    auth: 'credentials',
    tier: 'core',
    maintainer: 'abracadabra50',
    load: async () => (await import('./sainsburys')).SainsburysProvider,
  },
  {
    id: 'ocado',
    label: 'Ocado',
    country: 'GB',
    // No 'checkout': slot *booking* and checkout are blocked by AWS WAF bot
    // detection as of 2026-07. Reading slots works; committing to one does not.
    // Declaring a capability we cannot deliver is worse than declaring none.
    capabilities: ['search', 'basket', 'slots', 'orders'],
    auth: 'credentials',
    tier: 'core',
    maintainer: 'abracadabra50',
    load: async () => (await import('./ocado')).OcadoProvider,
  },
  {
    id: 'tesco',
    label: 'Tesco',
    country: 'GB',
    capabilities: ['search', 'basket', 'slots', 'checkout', 'orders'],
    auth: 'session-cookie',
    tier: 'core',
    maintainer: 'abracadabra50',
    load: async () => (await import('./tesco/index')).TescoProvider,
  },

  // ── Ireland ──────────────────────────────────────────────────────────
  {
    id: 'tesco-ie',
    label: 'Tesco Ireland',
    country: 'IE',
    capabilities: ['search'],
    auth: 'api-key',
    tier: 'community',
    maintainer: 'c-mongan',
    credit:
      'Protocol cross-checked against basketeer and grocery-cli (MIT), plus independently reimplemented Irish market evidence',
    load: async () => (await import('./tesco-ie')).TescoIrelandProvider,
  },
  {
    id: 'aldi-ie',
    label: 'Aldi Ireland',
    country: 'IE',
    capabilities: ['search', 'stores'],
    auth: 'none',
    tier: 'community',
    maintainer: 'c-mongan',
    credit:
      'Protocol reimplemented from AviBackToBlack/lidaldi and but3k4/supermarket-mcp (MIT)',
    load: async () => (await import('./aldi-ie')).AldiIrelandProvider,
  },
  {
    id: 'lidl-ie',
    label: 'Lidl Ireland',
    country: 'IE',
    capabilities: ['search'],
    auth: 'none',
    tier: 'community',
    maintainer: 'c-mongan',
    credit: 'Protocol reimplemented from AviBackToBlack/lidaldi (MIT)',
    load: async () => (await import('./lidl-ie')).LidlIrelandProvider,
  },
  {
    id: 'mrprice-ie',
    label: 'Mr Price Ireland',
    country: 'IE',
    capabilities: ['search'],
    auth: 'none',
    tier: 'community',
    maintainer: 'c-mongan',
    credit: 'Protocol reimplemented from but3k4/supermarket-mcp (MIT)',
    load: async () => (await import('./mrprice-ie')).MrPriceIrelandProvider,
  },
  {
    id: 'dunnes-ie',
    label: 'Dunnes Stores Ireland',
    country: 'IE',
    capabilities: ['search', 'stores'],
    auth: 'none',
    tier: 'community',
    maintainer: 'c-mongan',
    credit:
      'Protocol reimplemented from but3k4/supermarket-mcp (MIT) and independently cross-checked Irish gateway evidence',
    load: async () => (await import('./dunnes-ie')).DunnesIrelandProvider,
  },
  {
    id: 'supervalu-ie',
    label: 'SuperValu Ireland',
    country: 'IE',
    capabilities: ['search', 'stores'],
    auth: 'none',
    tier: 'community',
    maintainer: 'c-mongan',
    credit:
      'Protocol reimplemented from but3k4/supermarket-mcp (MIT) and independently cross-checked Irish store gateway evidence',
    load: async () => (await import('./supervalu-ie')).SuperValuIrelandProvider,
  },

  // ── Netherlands ──────────────────────────────────────────────────────
  {
    id: 'ah',
    label: 'Albert Heijn',
    country: 'NL',
    capabilities: ['search'],
    auth: 'anonymous',
    tier: 'core',
    maintainer: 'abracadabra50',
    credit: 'Protocol documented by github.com/gwillem/appie-go (Go, MIT)',
    load: async () => (await import('./ah')).AlbertHeijnProvider,
  },

  {
    id: 'ah-be',
    label: 'Albert Heijn België',
    country: 'BE',
    capabilities: ['search'],
    auth: 'anonymous',
    tier: 'core',
    maintainer: 'abracadabra50',
    credit: 'Same API as ah; storefront selected by the x-application header',
    load: async () => (await import('./ah')).AlbertHeijnBEProvider,
  },

  // ── Spain ────────────────────────────────────────────────────────────
  {
    id: 'mercadona',
    label: 'Mercadona',
    country: 'ES',
    capabilities: ['search'],
    auth: 'none',
    tier: 'core',
    maintainer: 'abracadabra50',
    credit: 'Open REST catalogue + the storefront\'s public Algolia search key',
    load: async () => (await import('./mercadona')).MercadonaProvider,
  },

  // ── United States ────────────────────────────────────────────────────
  {
    id: 'kroger',
    label: 'Kroger',
    country: 'US',
    capabilities: ['search'],
    auth: 'oauth',
    tier: 'core',
    maintainer: 'abracadabra50',
    credit: 'Official Kroger Public Products API (developer.kroger.com)',
    load: async () => (await import('./kroger')).KrogerProvider,
  },
  {
    id: 'instacart',
    label: 'Instacart (official API)',
    country: 'US',
    countries: ['US', 'CA'],
    capabilities: ['search', 'basket'],
    auth: 'api-key',
    tier: 'core',
    maintainer: 'abracadabra50',
    credit: 'Official Instacart Developer Platform API',
    load: async () => (await import('./instacart')).InstacartProvider,
  },
  {
    id: 'instacart-web',
    label: 'Instacart (unofficial)',
    country: 'US',
    countries: ['US', 'CA'],
    capabilities: ['search', 'basket'],
    auth: 'session-cookie',
    tier: 'core',
    maintainer: 'abracadabra50',
    credit: 'Protocol documented by github.com/kleinjm/instacart_api (Ruby, MIT)',
    load: async () => (await import('./instacart-web')).InstacartWebProvider,
  },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

export class UnknownProviderError extends Error {
  constructor(id: string, available: string[]) {
    super(
      `Unknown provider: "${id}".\n` +
        `Available: ${available.join(', ')}\n` +
        `Run \`supermarket providers\` to see them with countries and capabilities.`
    );
    this.name = 'UnknownProviderError';
  }
}

export class MissingCapabilityError extends Error {
  constructor(providerId: string, capability: Capability) {
    super(
      `${providerId} does not support "${capability}".\n` +
        `Run \`supermarket providers\` to see what it can do.`
    );
    this.name = 'MissingCapabilityError';
  }
}

export function getManifest(id: string): ProviderManifest {
  const m = byId.get(id);
  if (!m) throw new UnknownProviderError(id, PROVIDERS.map((p) => p.id));
  return m;
}

/** Every country with at least one provider, sorted. */
export function countries(): string[] {
  const set = new Set<string>();
  for (const p of PROVIDERS) {
    set.add(p.country);
    p.countries?.forEach((c) => set.add(c));
  }
  return [...set].sort();
}

export interface ListOptions {
  country?: string;
  capability?: Capability;
  tier?: ProviderManifest['tier'];
}

/** Filter manifests. Loads no provider code. */
export function list(opts: ListOptions = {}): ProviderManifest[] {
  return PROVIDERS.filter((p) => {
    if (opts.country) {
      const serves =
        p.country === opts.country || p.countries?.includes(opts.country);
      if (!serves) return false;
    }
    if (opts.capability && !p.capabilities.includes(opts.capability)) return false;
    if (opts.tier && p.tier !== opts.tier) return false;
    return true;
  });
}

export function supports(id: string, capability: Capability): boolean {
  return getManifest(id).capabilities.includes(capability);
}

export function assertCapability(id: string, capability: Capability): void {
  if (!supports(id, capability)) throw new MissingCapabilityError(id, capability);
}

/** Instantiate a provider, importing its module only now. */
export async function createProvider(id: string): Promise<GroceryProvider> {
  const Ctor = await getManifest(id).load();
  return new Ctor();
}

/**
 * Resolve which country we are shopping in.
 *
 * Explicit flag beats env beats system locale. Falls back to GB, which is
 * where the project started and where the most providers are.
 */
export function resolveCountry(explicit?: string): string {
  if (explicit) return explicit.toUpperCase();
  // GROC_* is the pre-3.0 prefix, still honoured so existing setups keep working.
  const fromEnvVar = process.env.SUPERMARKET_COUNTRY ?? process.env.GROC_COUNTRY;
  if (fromEnvVar) return fromEnvVar.toUpperCase();

  const locale =
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  const fromEnv = locale.match(/[_-]([A-Z]{2})/);
  if (fromEnv) return fromEnv[1];

  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    const m = resolved.match(/[_-]([A-Z]{2})/i);
    if (m) return m[1].toUpperCase();
  } catch {
    // Intl unavailable; fall through.
  }
  return 'GB';
}

/**
 * Providers usable in a country for a given capability.
 * Throws with something actionable rather than returning an empty array,
 * because "no results" is almost always a country mismatch.
 */
export function providersFor(country: string, capability?: Capability): ProviderManifest[] {
  const found = list({ country, capability });
  if (found.length === 0) {
    const inCountry = list({ country });
    if (inCountry.length === 0) {
      throw new Error(
        `No providers for country "${country}". ` +
          `Countries covered: ${countries().join(', ')}.\n` +
          `Set one with --country, or SUPERMARKET_COUNTRY.`
      );
    }
    throw new Error(
      `No provider in "${country}" supports "${capability}". ` +
        `Available there: ${inCountry
          .map((p) => `${p.id} (${p.capabilities.join('/')})`)
          .join(', ')}`
    );
  }
  return found;
}
