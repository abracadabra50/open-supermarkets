---
name: open-supermarkets
description: "Grocery automation across 15 providers in seven served countries: the UK, Ireland, the Netherlands, Belgium, Spain, the US and Canada. Search, compare, store-scope, basket, delivery and checkout capabilities vary by provider. Available as a CLI, MCP server or agent skill."
license: MIT
compatibility: Node.js 18+, TypeScript. Playwright is used by browser-auth providers. Delivery areas and capabilities vary by provider.
metadata:
  author: zish
  version: "3.0.0"
  repository: https://github.com/abracadabra50/open-supermarkets
  tags: [groceries, supermarket, sainsburys, ocado, tesco, albert-heijn, mercadona, kroger, instacart, uk, ireland, netherlands, belgium, spain, usa, canada, shopping, automation, mcp, agent-tool]
allowed-tools: Bash({baseDir}/node:*), Bash(supermarket:*), Bash(npm:run:supermarket:*)
---

# Open Supermarkets — Agent Skill

Open Supermarkets provides one CLI, MCP server and agent skill for grocery
search and supported shopping actions across multiple countries.

**Location:** `{baseDir}`

## Provider registry

The registry currently contains 15 provider IDs across seven served countries:

| Country | Provider IDs |
|---------|--------------|
| GB | `sainsburys`, `ocado`, `tesco` |
| IE | `tesco-ie`, `aldi-ie`, `lidl-ie`, `mrprice-ie`, `dunnes-ie`, `supervalu-ie` |
| NL | `ah` |
| BE | `ah-be` |
| ES | `mercadona` |
| US | `kroger`, `instacart`, `instacart-web` |
| CA | served by the two Instacart providers (`instacart`, `instacart-web`) |

Provider IDs and provider enums come from `src/providers/registry.ts`. Use the
registry-backed command to see current countries and declared capabilities:

```bash
supermarket providers
```

The six Ireland providers have these verified capability boundaries:

- `aldi-ie`, `dunnes-ie` and `supervalu-ie` support read-only store lookup and
  store selection for local pricing and availability.
- `tesco-ie`, `lidl-ie` and `mrprice-ie` are search-only.

## Per-provider skill files

Only these providers have dedicated per-provider skill files:

| Provider | Skill file |
|----------|------------|
| Sainsbury's | [`skills/sainsburys.md`](skills/sainsburys.md) |
| Tesco | [`skills/tesco.md`](skills/tesco.md) |
| Ocado | [`skills/ocado.md`](skills/ocado.md) |

The provider registry is the source for the complete provider list and
capability matrix. Do not infer a provider-specific skill file from a provider
ID.

## Quick start

```bash
cd {baseDir}
npm install
npx playwright install chromium   # only for browser-auth providers
npm run build
npm link
supermarket providers
```

### CLI usage

The canonical CLI command is `supermarket`.

```bash
# Search a provider
supermarket --provider sainsburys search "milk" --json
supermarket --provider aldi-ie search "milk" --json

# Compare search-capable providers in a country
supermarket compare "organic eggs" --country IE --json

# List stores, then scope a search to one selected store
supermarket --provider aldi-ie stores --query Dublin --json
supermarket --provider aldi-ie --store-id <store-id> search milk --json

# Use a provider capability declared by the registry
supermarket --provider tesco-ie search "bread" --json
```

The legacy `groc` binary remains an alias for compatibility and prints a
deprecation notice. New integrations should call `supermarket`.

### MCP server usage

Start the MCP server after building:

```bash
npm run build
supermarket-mcp
```

Claude Desktop configuration:

```json
{
  "mcpServers": {
    "groceries": {
      "command": "supermarket-mcp"
    }
  }
}
```

The MCP server exposes 23 tools. Provider enums are generated from the
registry, so the schemas stay aligned with the provider manifest:

### Authentication and discovery

- `grocery_login`
- `grocery_status`
- `grocery_providers`
- `grocery_stores`

### Search and repeat purchases

- `grocery_search`
- `grocery_compare`
- `grocery_search_batch`
- `grocery_basket_add_batch`
- `grocery_favourites`
- `grocery_favourites_search`
- `grocery_categories`
- `grocery_browse`
- `ocado_regulars`

### Basket, delivery and orders

- `grocery_basket_view`
- `grocery_basket_add`
- `grocery_basket_remove`
- `grocery_basket_update`
- `grocery_basket_clear`
- `grocery_slots`
- `grocery_book_slot`
- `grocery_checkout`
- `grocery_orders`
- `tesco_staples`

Use `grocery_stores` before a store-scoped search when the selected provider
declares the `stores` capability. Use `grocery_search_batch` and
`grocery_basket_add_batch` for multi-item workflows.

## Agent workflows

### Meal planning

```bash
supermarket compare "chicken breast" --country IE --json
supermarket compare "basmati rice" --country IE --json
supermarket --provider aldi-ie --store-id <store-id> search "chicken breast" --json
```

Review results before selecting products or adding them to a basket.

### Store-scoped shopping

```bash
supermarket --provider supervalu-ie stores --query Dublin --json
supermarket --provider supervalu-ie --store-id <store-id> search "milk" --json
```

Only providers that declare `stores` support this flow. For the Ireland
registry entries, that is Aldi, Dunnes Stores and SuperValu.

### Dry-run checkout

```bash
supermarket --provider sainsburys checkout --dry-run
```

Checkout is provider-dependent. Treat `--dry-run` as the safe default and
review the result before any real order action.

## Documentation

- [`README.md`](README.md) — install, capability matrix and CLI examples
- [`skills/sainsburys.md`](skills/sainsburys.md) — Sainsbury's details
- [`skills/tesco.md`](skills/tesco.md) — Tesco details
- [`skills/ocado.md`](skills/ocado.md) — Ocado details
- [Provider API reference](https://github.com/abracadabra50/open-supermarkets/blob/main/docs/API.md)
- [Smart shopping guide](https://github.com/abracadabra50/open-supermarkets/blob/main/docs/SMART-SHOPPING.md)
