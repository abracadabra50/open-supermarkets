# Agent Integration Guide

Open Supermarkets gives agents one grocery interface across multiple retailers and countries instead of requiring retailer-specific integrations in every agent.

Current `main` covers 11 provider integrations across the UK, Netherlands, Belgium, Spain, Hungary, the US and Canada.

## What agents should use it for

Use Open Supermarkets when an agent needs to:

- search live supermarket catalogues and prices;
- compare products across retailers in a country;
- build or inspect baskets where supported;
- inspect delivery slots or order history where supported;
- prepare a checkout preview without spending money;
- enrich products with nutrition/allergen data;
- plan a multi-item grocery shop efficiently.

The model should make the shopping decision. The provider layer should return truthful candidates and perform explicitly requested operations.

## Preferred interfaces

### MCP

Use the MCP server when the host supports Model Context Protocol:

```json
{
  "mcpServers": {
    "groceries": {
      "command": "npx",
      "args": ["-y", "open-supermarkets", "mcp"]
    }
  }
}
```

Prefer batch tools for multi-item shopping:

- `grocery_search_batch`
- `grocery_basket_add_batch`

This reduces process/tool overhead and keeps context smaller than one call per ingredient.

### CLI

For shell-capable agents:

```bash
supermarket providers
supermarket search "olive oil" --country ES --limit 5 --json
supermarket --provider tesco basket --json
```

The canonical command is `supermarket`; `open-supermarkets` is an npm-friendly alias.

### HTTP

Use `supermarket-api` for agents that have network access but cannot execute local commands.

Keep it loopback-only unless an API token is configured.

## Capabilities

Providers are capability-based, not all-or-nothing.

Typical capabilities are:

- search
- basket
- slots
- checkout
- orders

A search-only provider is valid and useful. Agents must not assume every provider supports basket or checkout.

Use `supermarket providers` or the registry to inspect the current capability matrix.

## Provider selection

Prefer explicit provider/country context.

Examples:

```bash
supermarket search "milk" --country NL --json
supermarket search "leche" --country ES --json
supermarket --provider tesco-hu search "tej" --json
```

For multi-retailer comparison, compare providers in the same relevant market. Do not compare store-scoped/local pricing as though it were national pricing.

## Product selection

Search returns candidates. The agent should use user context such as:

- requested item;
- pack size;
- quantity;
- budget;
- dietary constraints;
- preferred brands;
- intended recipe;
- household size.

Do not choose solely by the first result or lowest absolute price if pack size makes that misleading.

## Availability semantics

Do not interpret missing/unknown availability as explicitly out of stock.

Where the provider contract exposes an unknown state, handle it separately:

```ts
if (product.in_stock === false) {
  // explicitly unavailable
} else if (product.in_stock === true) {
  // explicitly available
} else {
  // availability unknown
}
```

## Basket and checkout safety

Basket writes change server-side state, so avoid unnecessary parallel mutation.

Checkout must remain explicit. Open Supermarkets previews checkout by default and requires an explicit confirmation path before spending money.

Agents should always:

1. show the selected products;
2. show quantities and totals;
3. surface substitutions or uncertainty;
4. obtain explicit approval before placing an order.

## Authentication

Auth differs by provider:

- some catalogues need no account;
- some use anonymous guest tokens;
- some use official API keys/OAuth;
- some use account credentials;
- some require browser-imported sessions.

Do not invent a login flow. Follow the provider manifest/auth instructions.

## Errors

An empty search result means the retailer returned a legitimate empty result.

Authentication failures, WAF/bot challenges, malformed upstream responses and rate limits should be surfaced as errors and not converted into empty product lists.

## Nutrition and allergens

`--enrich` can add data from Open Food Facts.

Treat enrichment as auxiliary metadata, especially for allergies. Prefer exact product identity when available and do not present fuzzy matches as authoritative.

## Provider-specific skills

Provider-specific notes live in `skills/`, including:

- Sainsbury's
- Tesco
- Ocado
- Tesco Magyarország

Additional providers can still be used through the common CLI/library even when they do not need a dedicated skill file.

## Developer references

- [README.md](README.md)
- [SKILL.md](SKILL.md)
- [docs/API.md](docs/API.md)
- [docs/PROVIDER-SPEC.md](docs/PROVIDER-SPEC.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)

The registry is the source of truth for provider coverage and capabilities.
