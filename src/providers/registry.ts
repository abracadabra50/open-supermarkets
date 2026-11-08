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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  Capability,
  Extra,
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
    session: '.sainsburys/session.json',
    searchNeedsSession: true,
    extras: ['login', 'favourites', 'categories'],
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
    session: '.ocado/session.json',
    searchNeedsSession: true,
    extras: ['login', 'favourites', 'categories', 'browse', 'regulars'],
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
    session: '.tesco/session.json',
    searchNeedsSession: true,
    // Scripted login exists but is usually bot-blocked; import-session is the
    // reliable path, which is why auth is session-cookie.
    extras: ['login', 'categories', 'staples'],
    tier: 'core',
    maintainer: 'abracadabra50',
    load: async () => (await import('./tesco/index')).TescoProvider,
  },

  // ── Ireland ──────────────────────────────────────────────────────────
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
    extras: ['categories'],
    tier: 'core',
    maintainer: 'abracadabra50',
    credit: 'Open REST catalogue + the storefront\'s public Algolia search key',
    load: async () => (await import('./mercadona')).MercadonaProvider,
  },
  {
    id: 'ahorramas',
    label: 'AhorraMás',
    country: 'ES',
    capabilities: ['search'],
    auth: 'none',
    tier: 'community',
    maintainer: 'vgvr0',
    credit:
      'Salesforce Commerce Cloud storefront using anonymous server-rendered catalogue pages',
    load: async () => (await import('./ahorramas')).AhorramasProvider,
  },

  // ── Hungary ──────────────────────────────────────────────────────────
  {
    id: 'tesco-hu',
    label: 'Tesco Magyarország',
    country: 'HU',
    // Basket verified live on 2026-09-17 with an imported browser session
    // (add one item, read it back, remove it, totals restored).
    capabilities: ['search', 'basket'],
    auth: 'session-cookie',
    session: '.tesco-hu/session.json',
    extras: ['categories'],
    tier: 'community',
    maintainer: 'benedek',
    credit:
      'Same xapi.tesco.com GraphQL backend as the UK provider, selected by region/language headers; ' +
      'schema differences learned from the storefront\'s server-rendered Apollo cache',
    load: async () => (await import('./tesco-hu/index')).TescoHuProvider,
  },

  // ── Switzerland ─────────────────────────────────────────────────────
  {
    id: 'migros',
    label: 'Migros',
    country: 'CH',
    // Migros search is public inside a live browser context, but cold HTTP
    // requests are Cloudflare-blocked. The provider keeps Chromium alive.
    capabilities: ['search', 'basket'],
    auth: 'anonymous',
    tier: 'community',
    maintainer: 'vgvr0',
    credit: 'Migros storefront JSON endpoints, verified live on 2026-09-26',
    load: async () => (await import('./migros')).MigrosProvider,
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

export class MissingExtraError extends Error {
  constructor(providerId: string, extra: Extra) {
    super(
      `${providerId} does not support ${extra}.\n` +
        `Run \`supermarket providers\` to see what it can do.`
    );
    this.name = 'MissingExtraError';
  }
}

export class MissingSessionError extends Error {
  constructor(readonly providerId: string) {
    super(`Not logged in to ${providerId}. ${loginHint(providerId)}`);
    this.name = 'MissingSessionError';
  }
}

/** Provider ids, optionally filtered. Loads no provider code. */
export function providerIds(opts: ListOptions = {}): string[] {
  return list(opts).map((p) => p.id);
}

export function supportsExtra(id: string, extra: Extra): boolean {
  return getManifest(id).extras?.includes(extra) ?? false;
}

/** Absolute path of the provider's stored login, if it keeps one on disk. */
export function sessionFile(id: string): string | undefined {
  const rel = getManifest(id).session;
  return rel ? path.join(os.homedir(), rel) : undefined;
}

/** true/false for providers with a session file; undefined when there is none to check. */
export function hasSession(id: string): boolean | undefined {
  const file = sessionFile(id);
  return file ? fs.existsSync(file) : undefined;
}

/** How to get authenticated with this provider, from its manifest. */
export function loginHint(id: string): string {
  const m = getManifest(id);
  if (m.auth === 'none' || m.auth === 'anonymous') return 'No login is needed.';
  if (m.auth === 'session-cookie' && m.session) {
    return `Import a browser session: \`supermarket --provider ${id} import-session --help\`.`;
  }
  if (m.extras?.includes('login')) {
    return `Log in locally with \`supermarket --provider ${id} login\`. MCP does not accept account credentials.`;
  }
  return 'Set its credentials in the environment; see `supermarket providers`.';
}

/** Account-only extras: these always need the stored login when there is one. */
const ACCOUNT_EXTRAS = new Set<Extra>(['favourites', 'regulars', 'staples']);

/** What an operation needs from a provider. */
export interface Need {
  capability: Capability;
  extra?: Extra;
}

/** Does this operation need the stored login? False when there is no session file to check. */
export function needsSession(id: string, need: Need): boolean {
  const m = getManifest(id);
  if (!m.session) return false;
  if (need.extra === 'login') return false;
  if (need.extra && ACCOUNT_EXTRAS.has(need.extra)) return true;
  return need.capability === 'search' ? m.searchNeedsSession === true : true;
}

/**
 * Check an operation against the manifest before any provider code loads or
 * any request is made: unknown id, missing capability, missing extra, and
 * (when `session` is set) a missing stored login. Throws the matching error.
 */
export function checkAccess(id: string, need: Need, opts: { session?: boolean } = {}): ProviderManifest {
  const m = getManifest(id);
  if (!m.capabilities.includes(need.capability)) throw new MissingCapabilityError(id, need.capability);
  if (need.extra && !m.extras?.includes(need.extra)) throw new MissingExtraError(id, need.extra);
  if (opts.session && needsSession(id, need) && !hasSession(id)) throw new MissingSessionError(id);
  return m;
}

/** checkAccess, then load and construct the provider. */
export async function openProvider(
  id: string,
  need: Need,
  opts: { session?: boolean } = {}
): Promise<GroceryProvider> {
  checkAccess(id, need, opts);
  return createProvider(id);
}

/** True for the errors checkAccess throws: the request is wrong, not the retailer. */
export function isAccessError(err: unknown): boolean {
  return (
    err instanceof UnknownProviderError ||
    err instanceof MissingCapabilityError ||
    err instanceof MissingExtraError ||
    err instanceof MissingSessionError
  );
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
