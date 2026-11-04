---
name: open-supermarkets
description: "Open-source supermarket infrastructure across 11 provider integrations in 7 countries. Search live catalogues and prices, compare retailers, build baskets, inspect slots and orders, and preview checkout through CLI, HTTP, MCP or agent skills."
license: MIT
compatibility: Node.js 18+, TypeScript. Playwright only for browser-auth providers. Delivery areas and capabilities vary by retailer.
metadata:
  author: zish
  version: "3.0.0"
  repository: https://github.com/abracadabra50/open-supermarkets
  tags: [groceries, supermarket, grocery-api, price-comparison, tesco, sainsburys, ocado, tesco-hu, albert-heijn, mercadona, ahorramas, kroger, instacart, uk, netherlands, belgium, spain, hungary, usa, canada, shopping, automation, mcp, agent-tool]
allowed-tools: Bash({baseDir}/node:*), Bash(supermarket:*), Bash(npm:run:supermarket:*)
---

# Open Supermarkets

One common grocery interface across supermarket providers in the UK, Europe and North America.

Use it when an agent needs live grocery search, retailer comparison, basket operations, delivery slots, order history or a checkout preview.

## Current coverage

Current `main` includes 11 provider integrations across 7 countries:

| Provider | Market | Main capabilities |
|---|---|---|
| Sainsbury's | UK | search, basket, slots, checkout, orders |
| Tesco | UK | search, basket, slots, checkout, orders |
| Ocado | UK | search, basket, read slots, orders |
| Albert Heijn | Netherlands | search |
| Albert Heijn België | Belgium | search |
| Mercadona | Spain | search |
| AhorraMás | Spain | search |
| Tesco Magyarország | Hungary | search, basket |
| Kroger | US | search |
| Instacart | US, Canada | search, basket |
| Instacart Web | US, Canada | search, basket |

Run `supermarket providers` for the live registry-backed capability matrix.

## Quick start

```bash
npx open-supermarkets providers
npx open-supermarkets search "olive oil" --country ES --limit 5
```

Or install globally:

```bash
npm install -g open-supermarkets
supermarket providers
```

## CLI

```bash
# Search by country
supermarket search "milk" --country NL --json
supermarket search "leche" --country ES --json

# Search a specific provider
supermarket --provider tesco search "milk" --json
supermarket --provider tesco-hu search "tej" --json

# Basket and checkout where supported
supermarket --provider tesco basket --json
supermarket --provider tesco add PRODUCT_ID --qty 1
supermarket --provider tesco checkout
```

Checkout previews by default. Spending requires explicit confirmation.

## MCP

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

Prefer batch tools for multi-item workflows:

- `grocery_search_batch`
- `grocery_basket_add_batch`

Use `grocery_providers` to inspect the providers exposed by the MCP server.

## How to reason about providers

Providers are capability-based.

Do not assume that because search works, basket or checkout also works. Check the provider capability matrix first.

Search-only integrations are intentionally first-class because catalogue and pricing access is useful even when authenticated shopping is not available.

## Product selection

The provider returns candidates. The agent should decide what to buy using user context such as:

- requested ingredient/product;
- pack size;
- quantity;
- budget;
- dietary restrictions;
- brand preference;
- recipe;
- household size.

Do not blindly select the first or cheapest absolute-price result.

## Availability

Treat availability as a truth claim.

If a provider can distinguish unknown availability, do not convert unknown into out-of-stock or in-stock.

## Authentication

Authentication varies by provider:

- none;
- anonymous/guest session;
- API key;
- OAuth;
- credentials;
- browser-imported session.

Follow the provider manifest and provider-specific notes rather than assuming every retailer supports scripted login.

## Error handling

A legitimate empty search may return an empty product list.

Authentication failures, rate limits, malformed retailer responses and bot/WAF challenges should remain errors. Do not treat them as "no products found".

## Provider-specific skills

Dedicated notes currently exist for:

- [Sainsbury's](skills/sainsburys.md)
- [Tesco](skills/tesco.md)
- [Ocado](skills/ocado.md)
- [Tesco Magyarország](skills/tesco-hu.md)

Providers without a dedicated skill file still work through the common provider interface where their declared capabilities are supported.

## Nutrition and allergens

`--enrich` adds Open Food Facts data such as Nutri-Score, NOVA group, ingredients and allergens.

Treat enrichment as auxiliary metadata. Exact identity matching is preferred; fuzzy matches should never be presented as definitive allergy information.

## References

- [README.md](README.md)
- [AGENTS.md](AGENTS.md)
- [docs/API.md](docs/API.md)
- [docs/PROVIDER-SPEC.md](docs/PROVIDER-SPEC.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
