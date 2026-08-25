---
name: tesco-groceries
description: "Tesco UK grocery automation. Search products, manage basket, book delivery, checkout, and manage repeat-purchase staples at Tesco via CLI or MCP tools."
license: MIT
compatibility: Node.js 18+, TypeScript, Playwright for auth. UK Tesco delivery areas only.
metadata:
  author: zish
  version: "2.1.0"
  repository: https://github.com/abracadabra50/open-supermarkets
  tags: [groceries, tesco, uk, shopping, automation, mcp, agent-tool]
allowed-tools: Bash({baseDir}/node:*), Bash(npm:run:groc:*)
---

# Tesco Groceries Skill

Search products, manage basket, book delivery slots, checkout, and manage staples at Tesco.

**Location:** `{baseDir}`

---

## When to Use

- User wants to buy groceries from Tesco
- User asks about product prices or availability at Tesco
- User wants to manage their Tesco basket
- User needs to book a Tesco delivery slot
- User wants to reorder regular staples from Tesco
- User wants to checkout at Tesco

---

## Setup

```bash
cd {baseDir}
npm install
npx playwright install chromium
```

## Authentication

Tesco uses Akamai bot detection. Three options:

**Option 1 - Automated login (may be blocked by Akamai):**
```bash
npm run groc -- --provider tesco login --email EMAIL --password PASS
# Omit --password to be prompted interactively
npm run groc -- --provider tesco login --email EMAIL
```

**Option 2 - Import session from browser (recommended):**
```bash
# 1. Log in to tesco.com manually in Chrome/Firefox
# 2. Export cookies with "Cookie Editor" browser extension -> Export All -> JSON
# 3. Import:
npm run groc -- --provider tesco import-session --file ~/Downloads/tesco-cookies.json
```

**Option 3 - Environment variable:**
```bash
TESCO_PASSWORD=yourpass npm run groc -- --provider tesco login --email EMAIL
```

Session saved to `~/.tesco/session.json` (~7 day expiry).

---

## CLI Commands

All commands require `--provider tesco`.

### Search Products
```bash
npm run groc -- --provider tesco search "semi-skimmed milk"
npm run groc -- --provider tesco search "bread" --limit 10 --json
```

### Basket Management
```bash
npm run groc -- --provider tesco basket                    # View basket
npm run groc -- --provider tesco basket --json             # JSON output
npm run groc -- --provider tesco add <product-id> --qty 2  # Add item
npm run groc -- --provider tesco update <item-id> 3        # Update qty
npm run groc -- --provider tesco remove <item-id>          # Remove item
npm run groc -- --provider tesco clear --force             # Clear basket
```

### Delivery & Checkout
```bash
npm run groc -- --provider tesco slots                     # View slots
npm run groc -- --provider tesco slots --json              # JSON output
npm run groc -- --provider tesco book <slot-id>            # Book slot
npm run groc -- --provider tesco checkout --dry-run        # Preview
npm run groc -- --provider tesco checkout                  # Place order
npm run groc -- --provider tesco orders                    # Order history
```

### Tesco-Specific: Staples Management
```bash
# View repeat-purchase staples (auto-detected from order history)
npm run groc -- --provider tesco staples

# Refresh staples from latest order history
npm run groc -- --provider tesco staples --update

# Add all staples to basket (skips items already in basket)
npm run groc -- --provider tesco staples --add

# JSON output
npm run groc -- --provider tesco staples --json
```

### Tesco-Specific: Session Import
```bash
npm run groc -- --provider tesco import-session --file <cookies.json>
```

### Tesco-Specific: API Discovery (dev)
```bash
npm run groc -- --provider tesco discover
```

---

## MCP Tools

When using the MCP server, use `provider: "tesco"` for standard tools:

| Tool | Description |
|------|-------------|
| `grocery_search` | Search Tesco products |
| `grocery_basket_view` | View basket contents |
| `grocery_basket_add` | Add product to basket |
| `grocery_basket_remove` | Remove product from basket |
| `grocery_basket_update` | Update item quantity |
| `grocery_basket_clear` | Clear all items |
| `grocery_slots` | List delivery slots |
| `grocery_book_slot` | Book a delivery slot |
| `grocery_checkout` | Checkout (dry_run default) |
| `grocery_orders` | View order history |
| `grocery_login` | Login to Tesco |
| `tesco_staples` | View/update/add staples (Tesco-only) |

---

## Tesco API Details

Tesco uses **GraphQL** via `https://xapi.tesco.com/`:

- Operations: `SearchProducts`, `Basket`, `AddToBasket`, `GetOrders`, `Taxonomy`
- Required headers: `x-apikey`, `language: en-GB`, `region: UK`
- Batched POST requests

Delivery slots and checkout use **Playwright browser automation**.

---

## Example Agent Workflow

```bash
# 1. Check staples from order history
npm run groc -- --provider tesco staples --json

# 2. Add staples to basket automatically
npm run groc -- --provider tesco staples --add

# 3. Search for additional items
npm run groc -- --provider tesco search "avocados" --json

# 4. Add extra items
npm run groc -- --provider tesco add PRODUCT_ID --qty 2

# 5. Review basket
npm run groc -- --provider tesco basket --json

# 6. Book slot and checkout
npm run groc -- --provider tesco slots --json
npm run groc -- --provider tesco book SLOT_ID
npm run groc -- --provider tesco checkout --dry-run
```

---

## Limitations

- Akamai bot detection can block automated login (use import-session)
- Browser automation required for slots and checkout (slower, ~10-15s)
- Age-restricted items may need ID verification
- Payment completion requires manual confirmation (never auto-completes payment)
