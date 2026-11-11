# Open Supermarkets API

Open Supermarkets exposes a common interface over supermarket providers through the TypeScript library, CLI, HTTP API and MCP server.

The provider registry in `src/providers/registry.ts` is the source of truth for countries, authentication models and supported capabilities.

For contributor-facing provider requirements, see [PROVIDER-SPEC.md](./PROVIDER-SPEC.md).

## Current coverage

Current `main` includes 13 provider integrations across 9 countries:

- United Kingdom: Sainsbury's, Tesco, Ocado
- Ireland: Lidl Ireland
- Netherlands: Albert Heijn
- Belgium: Albert Heijn België
- Spain: Mercadona, AhorraMás
- Hungary: Tesco Magyarország
- Switzerland: Migros
- United States: Kroger, Instacart, Instacart Web, Walmart (via Scavio)
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

`openProvider(id, { capability, extra? })` does the same after checking the manifest, so an unsupported operation throws before any provider code loads. The legacy synchronous `ProviderFactory` exists only for backwards compatibility. The CLI, HTTP API and MCP server no longer use it.

## Product

The current product contract on `main` is:

```ts
interface Product {
  product_uid: string;
  name: string;
  description?: string;

  retail_price: {
    price: number | null;   // null = unknown, never 0
  };

  unit_price?: {
    measure: string;
    price: number;
  };

  in_stock: boolean | null; // null = the retailer did not say
  image_url?: string;
  provider: string;
  currency?: string;
  rating?: number;
  review_count?: number;
  size?: string;
}
```

`currency` is ISO 4217. Older UK providers may omit it, in which case consumers historically treated the value as GBP. New non-UK providers must set it explicitly.

Missing data is `null`, never an invented value:

- `retail_price.price` is `null` when the retailer gave no usable price. `0` means genuinely free.
- `in_stock` is `true` or `false` only when the retailer said so, and `null` otherwise.
- Basket `unit_price`/`total_price` and `total_cost` are `null` when the retailer does not expose them reliably. A total is only computed from lines when every line price is known.

The CLI and MCP print these as "price unknown" and "Stock unknown". Price comparisons sort unknown prices last and never mark them as the cheapest. Shared helpers live in `src/providers/normalise.ts` (`toPrice`, `toStock`, `sumKnown`, `perUnit`) and `src/format.ts` (`money`, `stockLabel`, `byPrice`, `cheapest`).

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

Provider routing comes from the registry. Each tool's `provider` enum lists exactly the providers whose manifest supports that tool. Unsupported operations and missing stored logins are refused before any provider code loads.

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
