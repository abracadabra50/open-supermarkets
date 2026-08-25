---
name: ocado-groceries
description: "Ocado UK grocery automation. Search products, manage basket, and book delivery at Ocado via CLI or MCP tools."
license: MIT
compatibility: Node.js 18+, TypeScript. London & South England delivery areas only.
metadata:
  author: zish
  version: "2.1.0"
  repository: https://github.com/abracadabra50/open-supermarkets
  tags: [groceries, ocado, uk, shopping, automation, mcp, agent-tool]
allowed-tools: Bash({baseDir}/node:*), Bash(npm:run:groc:*)
---

# Ocado Groceries Skill

> ✅ **Rebuilt (2026-07).** The provider now uses Ocado's current internal web-app JSON API: `GET/POST /api/cart/v1/carts/active(/apply-quantity)` for the trolley (delta-quantity writes signed with an `x-csrf-token` header scraped from page HTML) and `PUT /api/webproductpagews/v6/products` for product info. Search parses the server-rendered `/search?q=` page's embedded `productEntities`. **Working:** login/import-session, search, getProduct, category browse, favourites, full basket CRUD, delivery slot listing, order history, regulars. **Not implemented:** slot *booking* and checkout — blocked by AWS WAF bot detection; those two throw clear errors. Note: products are addressed by UUID, not the numeric SKU in URLs.

Search products, manage basket, and book delivery at Ocado.

**Location:** `{baseDir}`

---

## When to Use

- User wants to buy groceries from Ocado
- User asks about product prices or availability at Ocado
- User wants to manage their Ocado basket/trolley
- User needs to book an Ocado delivery slot
- User is in London or South England (Ocado's delivery area)

---

## Setup

```bash
cd {baseDir}
npm install
```

## Authentication

```bash
# Option 1 — Playwright login:
npm run groc -- --provider ocado login --email EMAIL --password PASS

# Option 2 — Import cookies from a real browser (recommended, beats the WAF):
# Log in at ocado.com, export cookies with the "Cookie Editor" extension, then:
npm run groc -- --provider ocado import-session --file ~/Downloads/ocado-cookies.json

# Session saved to ~/.ocado/session.json
```

**Notes:**
- Ocado sits behind AWS WAF bot detection: cold HTTP requests get an empty 202 challenge. Real browser cookies (which carry the WAF token) make plain HTTP work, so `import-session` is the reliable path.
- If commands fail with "AWS WAF challenge or expired session", re-import cookies.
- Session file: `~/.ocado/session.json`

---

## CLI Commands

All commands require `--provider ocado`.

### Search Products
```bash
npm run groc -- --provider ocado search "milk"
npm run groc -- --provider ocado search "organic bread" --limit 10 --json
```

### Basket Management
```bash
npm run groc -- --provider ocado basket                    # View trolley
npm run groc -- --provider ocado basket --json             # JSON output
npm run groc -- --provider ocado add <product-id> --qty 2  # Add item
npm run groc -- --provider ocado update <item-id> 3        # Update qty
npm run groc -- --provider ocado remove <item-id>          # Remove item
npm run groc -- --provider ocado clear --force             # Clear trolley
```

### Browsing & Favourites
```bash
npm run groc -- --provider ocado favourites --json         # Favourite/frequently-bought products
npm run groc -- --provider ocado fav-search "milk" --json  # Search within favourites
npm run groc -- --provider ocado categories --json         # List browse categories
npm run groc -- --provider ocado browse "/categories/<slug>/<id>" --json  # Browse a category
npm run groc -- --provider ocado regulars --json           # Recurring-shopping definitions
```

### Delivery & Orders
```bash
npm run groc -- --provider ocado slots                     # View delivery slots (works)
npm run groc -- --provider ocado orders                    # Order history with line items (works)
npm run groc -- --provider ocado book <slot-id>            # ❌ NOT implemented (AWS WAF) — errors
npm run groc -- --provider ocado checkout                  # ❌ NOT implemented (AWS WAF) — errors
```

Slot booking and checkout must be finished by the user on ocado.com — the basket built via CLI is the same server-side trolley they'll see there.

---

## MCP Tools

When using the MCP server, use `provider: "ocado"` for all standard tools:

| Tool | Description |
|------|-------------|
| `grocery_search` | Search Ocado products |
| `grocery_basket_view` | View trolley contents |
| `grocery_basket_add` | Add product to trolley |
| `grocery_basket_remove` | Remove product from trolley |
| `grocery_basket_update` | Update item quantity |
| `grocery_basket_clear` | Clear all items |
| `grocery_favourites` | Favourite / frequently-bought products |
| `grocery_favourites_search` | Search within favourites |
| `grocery_categories` | List browse categories |
| `grocery_browse` | Browse products in a category |
| `ocado_regulars` | Recurring-shopping definitions |
| `grocery_slots` | List delivery slots |
| `grocery_book_slot` | ❌ Errors — not implemented (AWS WAF) |
| `grocery_checkout` | ❌ Errors — not implemented (AWS WAF) |
| `grocery_orders` | View order history |
| `grocery_login` | Login to Ocado |

---

## Ocado API Details

```
Base: https://www.ocado.com

GET  /search?q=milk                               # Search (server-rendered, productEntities blob)
GET  /api/cart/v1/carts/active                    # Read trolley
POST /api/cart/v1/carts/active/apply-quantity     # Write trolley (quantities are DELTAS)
PUT  /api/webproductpagews/v6/products            # Batch product info by UUID
POST /api/ecomslots/v2/slots                      # Delivery slots
POST /graphql                                     # Order history (GetCompletedOrders)
```

Writes need an `x-csrf-token` header scraped from any page's HTML — handled automatically, with one re-scrape on 403.

---

## Example Agent Workflow

```bash
# 1. Search for products
npm run groc -- --provider ocado search "free range eggs" --json

# 2. Add to trolley
npm run groc -- --provider ocado add PRODUCT_ID --qty 1

# 3. Check trolley
npm run groc -- --provider ocado basket --json

# 4. Check slots, then hand off to the user for booking/checkout on ocado.com
npm run groc -- --provider ocado slots --json
```

---

## Limitations

- **London & South England only** (Ocado delivery area)
- **Slot booking and checkout are not implemented** — AWS WAF bot detection blocks them; hand off to the user at ocado.com (the CLI basket is their real trolley)
- Cold requests without cookies get an empty HTTP 202 (WAF challenge) — use `import-session`
- Playwright login can be blocked; browser cookie import is the reliable path
