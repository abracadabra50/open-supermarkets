---
name: sainsburys-groceries
description: "Sainsbury's UK grocery automation. Search products, manage basket, book delivery, and checkout at Sainsbury's via CLI or MCP tools."
license: MIT
compatibility: Node.js 18+, TypeScript, Playwright for auth. UK Sainsbury's delivery areas only.
metadata:
  author: zish
  version: "2.1.0"
  repository: https://github.com/abracadabra50/open-supermarkets
  tags: [groceries, sainsburys, uk, shopping, automation, mcp, agent-tool]
allowed-tools: Bash({baseDir}/node:*), Bash(npm:run:groc:*)
---

# Sainsbury's Groceries Skill

Search products, manage basket, book delivery slots, and checkout at Sainsbury's.

**Location:** `{baseDir}`

---

## When to Use

- User wants to buy groceries from Sainsbury's
- User asks about product prices or availability at Sainsbury's
- User wants to manage their Sainsbury's basket
- User needs to book a Sainsbury's delivery slot
- User wants to checkout at Sainsbury's

---

## Setup

```bash
cd {baseDir}
npm install
npx playwright install chromium
```

## Authentication

```bash
# Login (opens browser, requires SMS 2FA)
npm run groc -- --provider sainsburys login --email EMAIL --password PASS

# Session saved to ~/.sainsburys/session.json
```

**Notes:**
- SMS 2FA may be required on fresh logins
- Sessions expire after ~20 minutes of real-world use
- **Auto re-auth (recommended for agents):** set `SAINSBURYS_EMAIL` + `SAINSBURYS_PASSWORD` and the CLI re-logins headlessly on any 401/403 and retries the failed request. MFA-protected accounts fail fast with a pointer to interactive login instead of hanging.

---

## CLI Commands

All commands use `--provider sainsburys` (this is the default provider).

### Search Products
```bash
npm run groc search "organic milk"
npm run groc search "chicken breast" --limit 10 --json
```

### Basket Management
```bash
npm run groc basket                          # View basket
npm run groc basket --json                   # JSON output
npm run groc add <product-id> --qty 2        # Add item
npm run groc update <item-id> 3              # Update quantity
npm run groc remove <item-id>                # Remove item
npm run groc clear --force                   # Clear basket
```

### Delivery & Checkout
```bash
npm run groc slots                           # View delivery slots
npm run groc slots --json                    # JSON output
npm run groc book <slot-id>                  # Book slot
npm run groc checkout --dry-run              # Preview order
npm run groc checkout                        # Place order
npm run groc orders                          # Order history
```

---

## MCP Tools

When using the MCP server, these tools are available with `provider: "sainsburys"`:

| Tool | Description |
|------|-------------|
| `grocery_search` | Search Sainsbury's products |
| `grocery_basket_view` | View basket contents |
| `grocery_basket_add` | Add product to basket |
| `grocery_basket_remove` | Remove product from basket |
| `grocery_basket_update` | Update item quantity |
| `grocery_basket_clear` | Clear all items |
| `grocery_slots` | List delivery slots |
| `grocery_book_slot` | Book a delivery slot |
| `grocery_checkout` | Checkout (dry_run default) |
| `grocery_orders` | View order history |
| `grocery_login` | Login to Sainsbury's |

---

## API Endpoints

```
Base: https://www.sainsburys.co.uk/groceries-api/gol-services

GET  /product/v1/product?filter[keyword]=milk         # Search
GET  /basket/v2/basket                                 # View basket
POST /basket/v2/basket/items                           # Add to basket
PUT  /basket/v2/basket                                 # Update basket
GET  /slot/v1/slot/reservation                         # Delivery slots
POST /checkout/v1/checkout                             # Checkout
GET  /order/v1/order?page_size=10&page_number=1        # Order history list
GET  /order/v1/order/{order_uid}                       # Single order detail (incl. items)
```

**Order history note:** The correct page URL is `/gol-ui/my-account/orders`, not `/shop/gb/groceries/order-history` (which is a legacy 404). The API returns `order_uid` (not `order_id`) and `order_items` (not `items`) in the detail response.

---

## Example Agent Workflow

```bash
# 1. Search for ingredients
npm run groc search "organic eggs" --json

# 2. Add to basket
npm run groc add 357937 --qty 1

# 3. Check basket total
npm run groc basket --json

# 4. Find delivery slot
npm run groc slots --json

# 5. Book and checkout
npm run groc book SLOT_ID
npm run groc checkout --dry-run
npm run groc checkout
```

---

## Limitations

- UK Sainsbury's delivery areas only
- SMS 2FA required on every fresh login
- Some checkout endpoints still experimental
- Slot removal endpoint returns 405 (known issue)
- Age-restricted items may need ID verification
