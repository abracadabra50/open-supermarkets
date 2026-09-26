import { FullGroceryProvider } from './types';
import { createProvider, getManifest, list, PROVIDERS } from './registry';

export * from './types';
export * from './registry';

/**
 * Provider ids are strings now, not a closed union — adding a country must not
 * mean editing a type in a different file. `getManifest()` validates at runtime
 * and throws with the available list.
 */
export type ProviderName = string;

/**
 * Legacy synchronous factory, kept so existing callers and the MCP server keep
 * working. It eagerly requires the UK providers.
 *
 * Prefer `createProvider()` from the registry: it loads one provider on demand
 * instead of all of them, which is the whole point of the manifest.
 *
 * @deprecated use `createProvider()`
 */
export class ProviderFactory {
  static create(name: ProviderName): FullGroceryProvider {
    getManifest(name); // throws with a helpful message for unknown ids
    switch (name) {
      case 'sainsburys':
        return new (require('./sainsburys').SainsburysProvider)();
      case 'ocado':
        return new (require('./ocado').OcadoProvider)();
      case 'tesco':
        return new (require('./tesco/index').TescoProvider)();
      case 'ah':
        return new (require('./ah').AlbertHeijnProvider)();
      case 'ah-be':
        return new (require('./ah').AlbertHeijnBEProvider)();
      case 'mercadona':
        return new (require('./mercadona').MercadonaProvider)();
      case 'tesco-hu':
        return new (require('./tesco-hu/index').TescoHuProvider)();
      case 'migros':
        return new (require('./migros').MigrosProvider)();
      case 'kroger':
        return new (require('./kroger').KrogerProvider)();
      case 'instacart':
        return new (require('./instacart').InstacartProvider)();
      case 'instacart-web':
        return new (require('./instacart-web').InstacartWebProvider)();
      default:
        // Reachable only if a manifest entry has no case here — which the
        // registry-parity test catches before it ships.
        throw new Error(
          `"${name}" has a manifest entry but no synchronous constructor. ` +
            `Add a case to ProviderFactory.create, or use \`await createProvider('${name}')\`.`
        );
    }
  }

  static getAvailableProviders(): ProviderName[] {
    return PROVIDERS.map((p) => p.id);
  }

  static createAll(): FullGroceryProvider[] {
    return list({ country: 'GB' }).map((p) => this.create(p.id));
  }
}

// NOTE: deliberately no `export { SainsburysProvider } from './sainsburys'` etc.
// A static re-export here would make this barrel eagerly load every provider —
// including Tesco, which pulls in Playwright — the moment anything imports
// `./providers` for a type or a registry helper. That would defeat the manifest's
// lazy `load()` thunks entirely.
//
// Need a concrete class? Import its module directly, or use `createProvider(id)`.
// There is a test in `test/lazy-loading.test.ts` that fails if this regresses.

/**
 * Search the same query across several providers at once.
 * Defaults to every search-capable provider in the given country.
 */
export async function compareProduct(
  query: string,
  providers?: ProviderName[],
  limit: number = 5,
  country: string = 'GB'
) {
  const ids = providers ?? list({ country, capability: 'search' }).map((p) => p.id);

  return Promise.all(
    ids.map(async (id) => {
      try {
        const provider = await createProvider(id);
        const products = await provider.search(query, { limit });
        return { provider: id, products, error: null as string | null };
      } catch (error: any) {
        return { provider: id, products: [], error: error.message as string };
      }
    })
  );
}
