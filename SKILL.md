---
name: open-supermarkets
description: "Grocery automation across ten retailers in seven countries — UK, Netherlands, Belgium, Spain, Hungary, the US and Canada. Search, compare, basket, delivery slots and checkout, plus Open Food Facts nutrition and allergen enrichment. Available as CLI, MCP server, or agent skill."
license: MIT
compatibility: Node.js 18+, TypeScript. Playwright only for browser-auth providers. Delivery areas vary by retailer.
metadata:
  author: zish
  version: "3.0.0"
  repository: https://github.com/abracadabra50/open-supermarkets
  tags: [groceries, supermarket, sainsburys, ocado, tesco, tesco-hu, hungary, albert-heijn, mercadona, kroger, instacart, uk, netherlands, belgium, spain, usa, shopping, automation, mcp, agent-tool]
allowed-tools: Bash({baseDir}/node:*), Bash(supermarket:*), Bash(npm:run:supermarket:*)
---

# UK Grocery CLI - Agent Skills

Unified grocery automation across UK supermarkets. Use via CLI, MCP server, or as agent skills.

**Location:** `{baseDir}`

---

## Per-Supermarket Skills

Each supermarket has a dedicated skill file with provider-specific commands, authentication, and API details:

| Supermarket | Skill File | Status |
|-------------|-----------|--------|
| **Sainsbury's** | [`skills/sainsburys.md`](skills/sainsburys.md) | Full coverage |
| **Tesco** | [`skills/tesco.md`](skills/tesco.md) | Full coverage + staples |
| **Ocado** | [`skills/ocado.md`](skills/ocado.md) | Full coverage except slot booking/checkout (AWS WAF) |
| **Tesco Magyarország** | [`skills/tesco-hu.md`](skills/tesco-hu.md) | Search and basket; no slots/checkout |

---

## Quick Start

```bash
cd {baseDir}
npm install
npx playwright install chromium
```

### CLI Usage

```bash
# Search any supermarket
npm run groc -- --provider sainsburys search "milk"
npm run groc -- --provider tesco search "milk"
npm run groc -- --provider ocado search "milk"

# Compare across all stores
npm run groc compare "organic eggs" --json

# Provider is a flag - all commands work the same way
npm run groc -- --provider <store> basket
npm run groc -- --provider <store> add <id> --qty 2
npm run groc -- --provider <store> slots
npm run groc -- --provider <store> checkout --dry-run
```

### MCP Server Usage

```bash
# Start MCP server (stdio transport)
npx tsx src/mcp-server.ts
# Or after build:
node dist/mcp-server.js
```

Claude Desktop config (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "uk-grocery": {
      "command": "node",
      "args": ["/path/to/uk-grocery-cli/dist/mcp-server.js"]
    }
  }
}
```

---

## MCP Tools Reference

All tools accept a `provider` parameter (`sainsburys`, `ocado`, `tesco`). Default: `sainsburys`.

### Core Tools (all providers)

| Tool | Description |
|------|-------------|
| `grocery_login` | Login to supermarket account |
| `grocery_status` | Check login status across all providers |
| `grocery_search` | Search products |
| `grocery_compare` | Compare prices across all stores |
| `grocery_basket_view` | View basket contents |
| `grocery_basket_add` | Add product to basket |
| `grocery_basket_remove` | Remove from basket |
| `grocery_basket_update` | Update item quantity |
| `grocery_basket_clear` | Clear basket |
| `grocery_slots` | List delivery slots |
| `grocery_book_slot` | Book delivery slot |
| `grocery_checkout` | Checkout (dry_run=true by default) |
| `grocery_orders` | View order history |
| `grocery_favourites` | Favourite / frequently-bought products (Sainsbury's, Ocado) |
| `grocery_favourites_search` | Search within favourites (Sainsbury's, Ocado) |
| `grocery_categories` | List browse categories (Sainsbury's, Ocado) |
| `grocery_browse` | Browse products in a category (Ocado) |
| `grocery_providers` | List providers and login status |

### Provider-Specific Tools

| Tool | Description |
|------|-------------|
| `tesco_staples` | View, update, or auto-add repeat-purchase staples |
| `ocado_regulars` | List Ocado recurring-shopping ("Regulars") definitions |

---

## When to Use This Skill

Trigger when users:
- Want to plan meals or order groceries
- Ask about product prices or availability
- Want to compare prices across supermarkets
- Need to manage a shopping basket
- Want to book delivery slots or checkout
- Ask about weekly shop, meal prep, or grocery budget

---

## Example Agent Workflows

### Meal Planning
```bash
# Search ingredients across stores
npm run groc compare "chicken breast" --json
npm run groc compare "basmati rice" --json

# Add to cheapest provider
npm run groc -- --provider tesco add PRODUCT_ID --qty 1
npm run groc -- --provider tesco basket --json
npm run groc -- --provider tesco checkout --dry-run
```

### Restock Staples (Tesco)
```bash
npm run groc -- --provider tesco staples --add
npm run groc -- --provider tesco basket --json
npm run groc -- --provider tesco checkout --dry-run
```

### Price Comparison
```bash
npm run groc compare "organic milk" --json
# Returns results from all providers with prices
```

---

## Documentation

- [`skills/sainsburys.md`](skills/sainsburys.md) - Sainsbury's skill details
- [`skills/tesco.md`](skills/tesco.md) - Tesco skill details
- [`skills/ocado.md`](skills/ocado.md) - Ocado skill details
- [`AGENTS.md`](AGENTS.md) - Full agent integration guide
- [`docs/SMART-SHOPPING.md`](docs/SMART-SHOPPING.md) - Smart shopping decisions
- [`API-REFERENCE.md`](API-REFERENCE.md) - API endpoint documentation
