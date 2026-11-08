---
name: grocery-api
description: Use the local groc HTTP API to search Sainsbury's groceries, search favourites, add/update/remove basket items, and view basket.
allowed-tools: Bash(node:skills/api/wrapper.js:*)
---

# Grocery API Skill

Use this skill when the user asks about Sainsbury's groceries, favourites, searching products, adding/updating/removing basket items, or viewing the basket.

The local API must already be running on port `7876`:

```bash
GROC_API_PORT=7876 SUPERMARKET_API_TOKEN="your-private-token" npm run api
```

## Commands

Run from the repo root:

```bash
node skills/api/wrapper.js fav-search "milk"
node skills/api/wrapper.js search "milk"
node skills/api/wrapper.js favourites
node skills/api/wrapper.js basket
node skills/api/wrapper.js add <product-id> [qty]
node skills/api/wrapper.js remove <item-id>
node skills/api/wrapper.js update <item-id> <qty>
```

All commands return JSON from the local API.

Basket changes require the same token in the wrapper environment:

```bash
SUPERMARKET_API_TOKEN="your-private-token" node skills/api/wrapper.js add <product-id> [qty]
```

## Add-to-basket workflow

When the user asks to add an item to the basket:

1. First search favourites:

   ```bash
   node skills/api/wrapper.js fav-search "USER ITEM"
   ```

2. If there is a clear favourite result that matches the user's intent, add it directly:

   ```bash
   node skills/api/wrapper.js add <product-id> [qty]
   ```

3. If there are multiple plausible favourite results, ask the user which one to add. Include names, prices, and product IDs.

4. If there are no good favourite matches, or if the user explicitly asks to look outside favourites, use regular search:

   ```bash
   node skills/api/wrapper.js search "USER ITEM"
   ```

5. For regular search results, always confirm with the user before adding anything to the basket.

6. After adding, show or summarize the basket:

   ```bash
   node skills/api/wrapper.js basket
   ```

## Remove/update workflow

When the user asks to remove or update an item:

1. First inspect the basket to get basket item IDs:

   ```bash
   node skills/api/wrapper.js basket
   ```

2. Use the basket `item_id`, not the product ID:

   ```bash
   node skills/api/wrapper.js remove <item-id>
   node skills/api/wrapper.js update <item-id> <qty>
   ```

3. If the item to change is ambiguous, ask the user which basket item they mean.

4. After removing or updating, show or summarize the basket.

## Notes

- Prefer favourites over regular search for add requests.
- Do not add ambiguous items without asking.
- Do not use regular search additions without confirmation.
- Use the `product_uid` as the product ID for `add`.
- Use the basket `item_id` for `remove` and `update`.
