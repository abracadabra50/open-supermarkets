## Agent Integration Guide

This document explains how to integrate Open Supermarkets into AI agent frameworks.

---

## Supported Frameworks

- ✅ **OpenClaw** / **Clawdbot** - Skills system
- ✅ **Pi Agent** / **Mom** - Slack bot with skills
- ✅ **Claude Desktop** - MCP server
- ✅ **Custom agents** - Any framework that can call bash

---

## Quick Integration

### 1. Add as Skill

Use the repository's top-level skill file or copy it to your agent's skills directory:

```bash
cp SKILL.md /path/to/agent/skills/open-supermarkets.md
```

### 2. Agent Calls Commands

```typescript
// From your agent code
await bash("supermarket search 'milk'");
```

### 3. Parse JSON Responses

```typescript
const stdout = await bash("supermarket search 'milk' --json");
const results = JSON.parse(stdout);

results.products.forEach(product => {
  console.log(`${product.name} - ${product.currency} ${product.retail_price.price}`);
});
```

---

## Skill File Format

The `SKILL.md` follows the open skills format used by OpenClaw, Pi, and other agent frameworks.

### Frontmatter

```yaml
---
name: open-supermarkets
description: Multi-country grocery search and supported shopping actions
license: MIT
compatibility: Node.js 18+, TypeScript, Playwright
metadata:
  author: zish
  version: "3.0.0"
allowed-tools: Bash({baseDir}/node:*), Bash(supermarket:*), Bash(npm:run:supermarket:*)
---
```

### Triggers

Agent should load this skill when user:
- Mentions meal planning or groceries
- Asks "what's for dinner?"
- Wants to order food/shopping
- Talks about recipes or cooking
- Mentions Sainsbury's

---

## Natural Language Workflow

### User Intent Detection

```typescript
const intents = {
  mealPlanning: ["plan meals", "what should I cook", "dinner ideas"],
  shopping: ["add to basket", "order groceries", "buy milk"],
  delivery: ["book slot", "delivery Tuesday", "checkout"],
  query: ["what's in my basket", "show orders", "search for bread"]
};

if (userMessage.match(/plan meals|what.*cook|dinner ideas/i)) {
  await startMealPlanning();
}
```

### Meal Planning Flow

```typescript
async function startMealPlanning() {
  // 1. Ask constraints
  await ask("How many people? Budget? Dietary restrictions?");
  
  // 2. Suggest meals
  const meals = await suggestMeals({
    people: 2,
    budget: 50,
    dietary: ["halal"]
  });
  
  // 3. Get approval
  await showMeals(meals);
  const approved = await waitForApproval();
  
  // 4. Generate shopping list
  const ingredients = extractIngredients(approved);
  
  // 5. Search products
  for (const ingredient of ingredients) {
    const result = await bash(`supermarket search "${ingredient}" --json`);
    const products = JSON.parse(result);
    const best = pickBestMatch(products, ingredient);
    shoppingList.push(best);
  }
  
  // 6. Show list and add to basket
  await showShoppingList(shoppingList);
  if (await confirm("Add to basket?")) {
    for (const item of shoppingList) {
      await bash(`supermarket add ${item.product_uid} --qty ${item.quantity}`);
    }
  }
  
  // 7. Checkout
  await bash(`supermarket basket --json`);
  // ... show basket, book slot, checkout
}
```

---

## Block Kit Integration (Slack Bots)

For Slack agents like Pi/Mom, use Block Kit for rich UIs.

### Shopping List

```javascript
async function showShoppingList(items, total) {
  const blocks = [
    {
      "type": "header",
      "text": {"type": "plain_text", "text": "🛒 Your Shopping List"}
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": `*Total: £${total}* (${items.length} items)`
      }
    },
    {"type": "divider"},
    ...buildItemSections(items),
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": {"type": "plain_text", "text": "Add All to Basket"},
          "action_id": "add_to_basket",
          "style": "primary"
        },
        {
          "type": "button",
          "text": {"type": "plain_text", "text": "Modify List"},
          "action_id": "modify_list"
        }
      ]
    }
  ];
  
  await sendBlocks(blocks);
}

function buildItemSections(items) {
  const categories = groupByCategory(items);
  const sections = [];
  
  for (const [category, products] of Object.entries(categories)) {
    const itemsText = products
      .map(p => `• ${p.name} - £${p.price}`)
      .join('\n');
    
    sections.push({
      "type": "section",
      "fields": [
        {
          "type": "mrkdwn",
          "text": `*${category}*\n${itemsText}`
        }
      ]
    });
  }
  
  return sections;
}
```

### Basket Summary

```javascript
async function showBasket(basket) {
  const blocks = [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": `*🛒 Your Basket*\n\n*${basket.total_quantity} items* | *£${basket.total_cost}*`
      }
    },
    {"type": "divider"}
  ];
  
  // Group items
  basket.products.slice(0, 10).forEach(item => {
    blocks.push({
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": `*${item.quantity}x* ${item.name}\n£${item.unit_price} each`
      },
      "accessory": {
        "type": "button",
        "text": {"type": "plain_text", "text": "Remove"},
        "action_id": `remove_${item.item_id}`,
        "style": "danger"
      }
    });
  });
  
  if (basket.products.length > 10) {
    blocks.push({
      "type": "context",
      "elements": [{
        "type": "mrkdwn",
        "text": `... and ${basket.products.length - 10} more items`
      }]
    });
  }
  
  blocks.push({
    "type": "actions",
    "elements": [
      {
        "type": "button",
        "text": {"type": "plain_text", "text": "Checkout"},
        "action_id": "checkout",
        "style": "primary"
      },
      {
        "type": "button",
        "text": {"type": "plain_text", "text": "Clear Basket"},
        "action_id": "clear_basket",
        "style": "danger"
      }
    ]
  });
  
  await sendBlocks(blocks);
}
```

### Delivery Slots

```javascript
async function showDeliverySlots(slots) {
  const blocks = [
    {
      "type": "header",
      "text": {"type": "plain_text", "text": "📅 Available Delivery Slots"}
    }
  ];
  
  slots.forEach(slot => {
    blocks.push({
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": `*${slot.date}*\n${slot.startTime} - ${slot.endTime}\n£${slot.price}`
      },
      "accessory": {
        "type": "button",
        "text": {"type": "plain_text", "text": "Book This"},
        "action_id": `book_${slot.id}`,
        "style": "primary"
      }
    });
  });
  
  await sendBlocks(blocks);
}
```

---

## Dietary Preferences (Optional Agent Logic)

If your agent implements meal planning, you can add preference handling.

### Configuration

Load preferences when user mentions dietary requirements:

```typescript
const preferences = {
  dietary_restrictions: ["vegetarian", "gluten-free"],
  dislikes: ["mushrooms", "olives"],
  budget: {weekly: 50},
  household_size: 2
};

savePreferences(preferences);
```

### Special Sourcing Example

Some users need specific sourcing (halal, kosher, local farms):

```typescript
const preferences = {
  dietary_restrictions: ["halal"],
  external_sources: {
    meat: "halal_butcher",
    note: "Exclude non-halal meat from Sainsbury's"
  },
  sainsburys_excludes: ["beef", "lamb", "chicken", "turkey"]
};
```

### Filter Search Results

```typescript
async function searchWithPreferences(query, preferences) {
  // Search Sainsbury's
  const result = await bash(`supermarket search "${query}" --json`);
  const products = JSON.parse(result);
  
  // Filter based on preferences
  const filtered = products.products.filter(product => {
    // Example: exclude restricted items
    if (preferences.sainsburys_excludes) {
      for (const excluded of preferences.sainsburys_excludes) {
        if (product.name.toLowerCase().includes(excluded)) {
          return false;
        }
      }
    }
    return true;
  });
  
  return filtered;
}
```

### Split Shopping Lists

For users with external sourcing needs:

```typescript
async function generateShoppingList(meals, preferences) {
  const sainsburys = [];
  const external = {};
  
  for (const meal of meals) {
    for (const ingredient of meal.ingredients) {
      // Check if should be sourced externally
      const externalSource = shouldSourceExternally(ingredient, preferences);
      
      if (externalSource) {
        if (!external[externalSource]) external[externalSource] = [];
        external[externalSource].push({
          item: ingredient,
          meal: meal.name
        });
      } else {
        sainsburys.push(ingredient);
      }
    }
  }
  
  return {sainsburys, external};
}
```

### Display Split Lists (Block Kit)

```javascript
{
  "type": "section",
  "fields": [
    {
      "type": "mrkdwn",
      "text": "*From Sainsbury's:*\n• Pasta\n• Tomatoes\n• Onions\n• Herbs"
    },
    {
      "type": "mrkdwn",
      "text": "*From Other Sources:*\n• Local Farm: Eggs\n• Halal Butcher: Chicken\n_(Purchased separately)_"
    }
  ]
}
```

**Note:** This is your agent's logic, not CLI functionality. The CLI just provides product search and ordering.

---

## Error Handling

### Session Expired

```typescript
try {
  await bash("supermarket basket --json");
} catch (error) {
  if (error.includes("401") || error.includes("403")) {
    await say("Session expired. Let me log you in again...");
    await bash(`supermarket login --email ${EMAIL} --password ${PASSWORD}`);
    // Retry
    await bash("supermarket basket --json");
  }
}
```

### Product Not Found

```typescript
const result = await bash(`supermarket search "${ingredient}" --json`);
const products = JSON.parse(result);

if (products.products.length === 0) {
  await say(`Couldn't find "${ingredient}". Can you be more specific? (e.g., brand, size)`);
  const clarification = await waitForResponse();
  // Retry search
}
```

### Out of Stock

```typescript
const product = products.products[0];

if (product.in_stock === false) {
  await say(`${product.name} is out of stock. Here are alternatives:`);
  const alternatives = products.products.slice(1, 4);
  // Show alternatives
} else if (product.in_stock === null) {
  await say(`${product.name} has no retailer stock signal. Check the selected store before buying.`);
}
```

---

## Performance Tips

### Cache Product Searches

```typescript
const searchCache = new Map();

async function searchProduct(query) {
  if (searchCache.has(query)) {
    return searchCache.get(query);
  }
  
  const result = await bash(`supermarket search "${query}" --json`);
  const products = JSON.parse(result);
  
  searchCache.set(query, products);
  setTimeout(() => searchCache.delete(query), 60 * 60 * 1000); // 1 hour
  
  return products;
}
```

### Batch Basket Operations

```typescript
// Keep basket writes sequential because the basket is shared server-side state.
for (const item of items) {
  await bash(`supermarket add ${item.id} --qty ${item.qty}`);
}
```

---

## MCP Server

The repository includes an MCP server. Start it with `supermarket-mcp` after
building, or use the equivalent tool definitions from the server source:

```typescript
// server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const server = new Server({
  name: "open-supermarkets",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "sainsburys_search",
      description: "Search Sainsbury's products",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" }
        }
      }
    },
    {
      name: "sainsburys_add_to_basket",
      description: "Add product to basket",
      inputSchema: {
        type: "object",
        properties: {
          productId: { type: "string" },
          quantity: { type: "number" }
        }
      }
    }
    // ... more tools
  ]
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case "sainsburys_search":
      return await search(args.query, args.limit);
    case "sainsburys_add_to_basket":
      return await addToBasket(args.productId, args.quantity);
  }
});
```

---

## Testing Your Integration

### 1. Test Basic Commands

```bash
npm run build
supermarket search "test"
supermarket basket
```

### 2. Test From Agent

```typescript
// In your agent code
const result = await bash("supermarket search 'milk' --json");
console.log(JSON.parse(result));
```

### 3. Test Full Workflow

```typescript
// Login
await bash("supermarket login --email test@example.com --password test123");

// Search and add
const products = await bash("supermarket search 'milk' --json");
const firstProduct = JSON.parse(products).products[0];
await bash(`supermarket add ${firstProduct.product_uid} --qty 2`);

// View basket
const basket = await bash("supermarket basket --json");
console.log(JSON.parse(basket));
```

---

## Example Integrations

### OpenClaw

```typescript
// SKILL.md loaded automatically

// Agent uses natural language
user: "plan meals for this week"

agent: 
  → loads skill
  → asks constraints
  → suggests meals
  → searches Sainsbury's
  → builds basket
  → checks out
```

### Pi Agent (Slack)

```typescript
// data/skills/open-supermarkets/SKILL.md

// In meal-planning channel
await bash("supermarket search 'milk' --json");

// Show results with Block Kit
await sendBlocks(productBlocks);
```

---

## Support

**Issues:** GitHub issues  
**Docs:** README.md, SKILL.md, AGENTS.md  
**Examples:** See `/examples` directory

---

**Happy agent building! 🤖**
