# Open Supermarkets API

Open Supermarkets exposes a common interface over supermarket providers through the TypeScript library, CLI, HTTP API and MCP server.

The provider registry in `src/providers/registry.ts` is the source of truth for countries, authentication models and supported capabilities.

For contributor-facing provider requirements, see [PROVIDER-SPEC.md](./PROVIDER-SPEC.md).

## Current coverage

Current `main` includes 11 provider integrations across 7 countries:

- United Kingdom: Sainsbury's, Tesco, Ocado
- Netherlands: Albert Heijn
- Belgium: Albert Heijn België
- Spain: Mercadona, AhorraMás
- Hungary: Tesco Magyarország
- United States: Kroger, Instacart, Instacart Web
- Canada: Instacart, Instacart Web

Some provider integrations cover multiple retail banners. For example, Kroger's API also serves banners including Ralphs, Fred Meyer, King Soopers, Harris Teeter and QFC.

Run the registry-backed command for the live capability matrix:

```bash
supermarket providers
```

## Provider model

Only product search is required by the base provider contract. Basket, slots, checkout and orders are optional capabilities.

```ts
interface GroceryProvider {
  readonly name: string;

  search(query: string, options?: SearchOptions): Promise<Product[]>;
  getProduct?(productId: string): Promise<Product>;
  getCategories?(): Promise<unknown>;

  login?(email: string, password: string): Promise<void>;
  logout?(): Promise<void>;
  isAuthenticated?(): Promise<boolean>;

  getBasket?(): Promise<Basket>;
  addToBasket?(productId: string, quantity: number): Promise<void>;
  updateBasketItem?(itemId: string, quantity: number): Promise<void>;
  removeFromBasket?(itemId: string): Promise<void>;
  clearBasket?(): Promise<void>;

  getDeliverySlots?(): Promise<DeliverySlot[]>;
  bookSlot?(slotId: string): Promise<void>;
  checkout?(dryRun?: boolean): Promise<Order>;

  getOrders?(): Promise<Order[]>;
}
```

Do not assume every provider supports every method. Check the registry capability before calling an optional operation.

## Loading a provider

Prefer the async registry loader:

```ts
import { createProvider, getManifest } from './src/providers';

const manifest = getManifest('mercadona');
const provider = await createProvider(manifest.id);

const products = await provider.search('olive oil', { limit: 5 });
```

The legacy synchronous `ProviderFactory` exists for backwards compatibility but should not be the basis for new integrations.

## Product

The current product contract on `main` is:

```ts
interface Product {
  product_uid: string;
  name: string;
  description?: string;

  retail_price: {
    price: number;
  };

  unit_price?: {
    measure: string;
    price: number;
  };

  in_stock: boolean;
  image_url?: string;
  provider: string;
  currency?: string;
  rating?: number;
  review_count?: number;
  size?: string;
}
```

`currency` is ISO 4217. Older UK providers may omit it, in which case consumers historically treated the value as GBP. New non-UK providers must set it explicitly.

The project is moving toward representing unknown availability explicitly rather than conflating it with out-of-stock. See the provider specification and open architecture issues before introducing new fallback semantics.

## Search

```ts
const products = await provider.search('milk', {
  limit: 10,
  offset: 0,
});
```

Search semantics vary upstream, but the common contract requires providers to surface real upstream errors instead of returning an empty list for authentication failures, WAF blocks or malformed responses.

## Basket

Basket support is capability-gated.

```ts
import { assertCapability, createProvider } from './src/providers';

assertCapability('tesco', 'basket');
const provider = await createProvider('tesco');

if (!provider.getBasket || !provider.addToBasket) {
  throw new Error('Provider declared basket support but methods are missing');
}

const basket = await provider.getBasket();
await provider.addToBasket('PRODUCT_ID', 1);
```

Basket identifiers and quantity semantics are retailer-specific. Use the provider-returned `product_uid` / `item_id`; do not substitute names or guessed barcodes.

## CLI

```bash
supermarket providers
supermarket search "olive oil" --country ES --limit 5
supermarket --provider tesco basket --json
supermarket --provider tesco checkout
```

Checkout previews by default. Spending money requires an explicit confirmation path.

## HTTP API

Start locally:

```bash
supermarket-api
```

The HTTP server binds to loopback by default. Set `SUPERMARKET_API_TOKEN` before exposing it beyond localhost.

Core routes include search and provider-backed basket operations. The supported surface depends on the selected provider's capabilities.

## MCP

Run:

```bash
supermarket-mcp
```

or:

```bash
npx -y open-supermarkets mcp
```

The MCP server exposes grocery search, comparison, batch search, basket operations, delivery slots, checkout, favourites and provider-specific tools where supported.

Provider/capability routing is being migrated toward the registry as the single source of truth. See issue #30 for that architecture work.

## Authentication models

Provider manifests use these auth models:

- `none`: no token or session required
- `anonymous`: retailer issues a guest/anonymous session
- `api-key`: developer/API key
- `oauth`: OAuth flow
- `credentials`: account login can be scripted
- `session-cookie`: browser-derived session is required

Do not assume a 401/403 means a username/password login is available. The manifest's auth model is authoritative.

## Provider-specific protocol notes

Detailed retailer protocol notes live alongside provider code and in provider-specific docs/skills.

`API-REFERENCE.md` is retained as the Sainsbury's protocol reference; it is not the global Open Supermarkets API contract.

## Safety

- Never commit retailer credentials, cookies, payment data or private order history.
- Do not represent unknown price as zero.
- Do not represent missing availability as a confident stock signal.
- Checkout and other spend operations must remain behind explicit confirmation.
- Treat upstream retailer responses as unstable external protocol data.

See [CONTRIBUTING.md](../CONTRIBUTING.md), [PROVIDER-SPEC.md](./PROVIDER-SPEC.md) and [SECURITY.md](../SECURITY.md).
