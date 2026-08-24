# API Documentation

Reference for the multi-country supermarket provider interface and implementation.

---

## Provider Interface

Every provider implements `name` and `search`. Other methods are optional and
must match the capabilities declared in the provider registry.

```typescript
interface GroceryProvider {
  readonly name: string;
  
  // Product search (required)
  search(query: string, options?: SearchOptions): Promise<Product[]>;
  getProduct?(productId: string): Promise<Product>;
  getCategories?(): Promise<any>;

  // Store-scoped catalogue operations
  listStores?(options?: StoreSearchOptions): Promise<Store[]>;
  selectStore?(storeId: string): Promise<void>;

  // Authentication
  login?(email: string, password: string): Promise<void>;
  logout?(): Promise<void>;
  isAuthenticated?(): Promise<boolean>;
  
  // Basket operations
  getBasket?(): Promise<Basket>;
  addToBasket?(productId: string, quantity: number): Promise<void>;
  updateBasketItem?(itemId: string, quantity: number): Promise<void>;
  removeFromBasket?(itemId: string): Promise<void>;
  clearBasket?(): Promise<void>;
  
  // Delivery & checkout
  getDeliverySlots?(): Promise<DeliverySlot[]>;
  bookSlot?(slotId: string): Promise<void>;
  checkout?(dryRun?: boolean): Promise<Order>;
  
  // Orders
  getOrders?(): Promise<Order[]>;
}
```

Use `assertCapability(providerId, capability)` before calling an optional
capability method. The CLI, HTTP server and MCP server already do this.

---

## Data Types

### Product

```typescript
interface Product {
  product_uid: string;      // Unique product ID
  name: string;             // Product name
  description?: string;     // Product description
  retail_price: {
    price: number;          // Retail price in the provider currency
  };
  unit_price?: {
    measure: string;        // Unit (L, kg, etc.)
    price: number;          // Price per unit
  };
  in_stock: boolean | null; // Explicit stock, or null when the retailer does not say
  image_url?: string;       // Product image
  provider: string;         // Provider name (sainsburys, ocado)
}
```

### Basket

```typescript
interface Basket {
  items: BasketItem[];
  total_quantity: number;
  total_cost: number;
  provider: string;
}

interface BasketItem {
  item_id: string;          // Line item ID
  product_uid: string;      // Product ID
  name: string;             // Product name
  quantity: number;         // Quantity in basket
  unit_price: number;       // Price per unit
  total_price: number;      // Total for this line
}
```

### DeliverySlot

```typescript
interface DeliverySlot {
  slot_id: string;
  start_time: string;       // ISO 8601 timestamp
  end_time: string;         // ISO 8601 timestamp
  date: string;             // Date string
  price: number;            // Delivery charge
  available: boolean;       // Slot availability
}
```

### Order

```typescript
interface Order {
  order_id: string;
  status: string;           // placed, confirmed, delivered, etc.
  total: number;
  delivery_slot?: DeliverySlot;
  items: BasketItem[];
}
```

### SearchOptions

```typescript
interface SearchOptions {
  limit?: number;           // Max results (default: 24)
  offset?: number;          // Pagination offset
  category?: string;        // Filter by category
}
```

### Store and StoreSearchOptions

```typescript
interface Store {
  store_id: string;        // Retailer-owned ID used for catalogue search
  name: string;
  status?: string;
  currency?: string;
  postcode?: string;
  address?: string;
  location?: { latitude: number; longitude: number };
  shopping_modes?: string[];
}

interface StoreSearchOptions {
  limit?: number;
  offset?: number;
  retailerStoreId?: string;
  latitude?: number;
  longitude?: number;
  range?: number;          // Kilometres
  shoppingMode?: 'pickup' | 'delivery';
  fullTextSearch?: string;
  postcode?: string;
}
```

Store-capable providers expose `listStores()` and `selectStore()`. Select a
store before searching when local price and availability depend on it.

---

## Authentication

### Login

```typescript
await provider.login(email, password);
```

Uses Playwright to authenticate via browser automation. Session cookies are saved to:
- Sainsbury's: `~/.sainsburys/session.json`
- Ocado: `~/.ocado/session.json`

**Example:**

```typescript
import { SainsburysProvider } from './providers/sainsburys';

const provider = new SainsburysProvider();
await provider.login('you@email.com', 'password123');
```

### Check Authentication

```typescript
const isLoggedIn = await provider.isAuthenticated();
```

Tests authentication by attempting to fetch basket. Returns `true` if valid session, `false` otherwise.

### Logout

```typescript
await provider.logout();
```

Deletes session file and clears cookies.

---

## Product Search

### Basic Search

```typescript
const products = await provider.search('milk');
```

Returns array of `Product` objects.

### Search with Options

```typescript
const products = await provider.search('organic eggs', {
  limit: 10,
  offset: 0
});
```

### Get Single Product

```typescript
const product = await provider.getProduct('357937');
```

Returns detailed product information.

### Browse Categories

```typescript
const categories = await provider.getCategories();
```

Returns category tree structure (provider-specific format).

---

## Basket Management

### View Basket

```typescript
const basket = await provider.getBasket();

console.log(basket.total_cost);      // 48.50
console.log(basket.total_quantity);  // 24
console.log(basket.items.length);    // 12
```

### Add to Basket

```typescript
await provider.addToBasket('357937', 2);
```

Adds 2 units of product with ID `357937`.

### Update Quantity

```typescript
await provider.updateBasketItem('line_123', 3);
```

Updates basket line item to quantity of 3.

### Remove from Basket

```typescript
await provider.removeFromBasket('line_123');
```

Removes specific line item.

### Clear Basket

```typescript
await provider.clearBasket();
```

Removes all items from basket.

---

## Delivery & Checkout

### View Delivery Slots

```typescript
const slots = await provider.getDeliverySlots();

slots.forEach(slot => {
  console.log(`${slot.date} ${slot.start_time}-${slot.end_time}`);
  console.log(`£${slot.price} - ${slot.available ? 'Available' : 'Full'}`);
});
```

### Book Slot

```typescript
await provider.bookSlot('slot_abc123');
```

Reserves delivery slot. Typically required before checkout.

### Checkout

```typescript
const order = await provider.checkout();

console.log(`Order placed: ${order.order_id}`);
console.log(`Total: £${order.total}`);
console.log(`Status: ${order.status}`);
```

**Note:** Uses saved payment method from supermarket account.

---

## Order History

```typescript
const orders = await provider.getOrders();

orders.forEach(order => {
  console.log(`Order ${order.order_id}: £${order.total} - ${order.status}`);
  
  if (order.delivery_slot) {
    console.log(`Delivery: ${order.delivery_slot.date} ${order.delivery_slot.start_time}-${order.delivery_slot.end_time}`);
  }
  
  if (order.items) {
    console.log(`Items: ${order.items.length}`);
  }
});
```

**Note:** Order history availability depends on the provider's API. Some providers may not expose order history via API, or may require additional authentication. If `getOrders()` returns an empty array, check the supermarket website directly for order history.

---

## Provider Factory

### Create Provider by Name

```typescript
import { ProviderFactory } from './providers';

const provider = ProviderFactory.create('sainsburys');
// or
const provider = ProviderFactory.create('ocado');
```

### List Available Providers

```typescript
const providers = ProviderFactory.getAvailableProviders();
// Returns: ['sainsburys', 'ocado']
```

### Create All Providers

```typescript
const allProviders = ProviderFactory.createAll();
// Returns array of all provider instances
```

---

## Multi-Provider Comparison

```typescript
import { compareProduct } from './providers';

const results = await compareProduct('milk');

results.forEach(({ provider, products, error }) => {
  if (error) {
    console.log(`${provider}: Error - ${error}`);
  } else {
    console.log(`${provider}: ${products.length} results`);
    console.log(`Cheapest: ${products[0].name} - £${products[0].retail_price.price}`);
  }
});
```

---

## Error Handling

### Authentication Errors

```typescript
try {
  await provider.login(email, password);
} catch (error) {
  if (error.message.includes('401') || error.message.includes('403')) {
    console.error('Invalid credentials');
  }
}
```

### Session Expired

```typescript
try {
  await provider.getBasket();
} catch (error) {
  if (error.message.includes('401')) {
    console.log('Session expired, re-authenticating...');
    await provider.login(email, password);
    // Retry operation
    await provider.getBasket();
  }
}
```

### Product Not Found

```typescript
const products = await provider.search('rare product');

if (products.length === 0) {
  console.log('No results found');
}
```

### Out of Stock

```typescript
const product = await provider.getProduct('357937');

if (product.in_stock === false) {
  console.log('Product out of stock');
  // Find alternative
} else if (product.in_stock === null) {
  console.log('Retailer did not provide a stock signal');
}
```

---

## Provider-Specific Details

### Sainsbury's

**Base URL:** `https://www.sainsburys.co.uk/groceries-api/gol-services`

**Endpoints:**
- Search: `GET /product/v1/product?filter[keyword]=milk`
- Basket: `GET /basket/v2/basket`
- Add: `POST /basket/v2/basket/items`
- Slots: `GET /slot/v1/slot/reservation`
- Checkout: `POST /checkout/v1/checkout`

**Session:** Cookies stored in `~/.sainsburys/session.json`

**Coverage:** UK-wide delivery

### Ocado

**Base URL:** `https://www.ocado.com/api`

**Endpoints:**
- Search: `GET /search/v1/products?searchTerm=milk`
- Basket: `GET /trolley/v1/basket`
- Add: `POST /trolley/v1/items`
- Slots: `GET /slots/v1/available`
- Checkout: `POST /checkout/v1/place-order`

**Session:** Cookies stored in `~/.ocado/session.json`

**Coverage:** London & South England only

**Note:** Ocado endpoints may vary - implementation based on observed API calls. May need refinement.

---

## Rate Limiting

Be respectful of supermarket APIs:

```typescript
// Add delays between requests
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

for (const product of products) {
  await provider.addToBasket(product.id, 1);
  await sleep(500); // 500ms delay
}
```

---

## Session Management

### Session Storage

Sessions are stored as JSON:

```json
{
  "cookies": "session=abc123; path=/; ...",
  "savedAt": "2026-02-14T20:00:00.000Z"
}
```

### Manual Session Export

If Playwright login fails, you can export session from browser:

1. Login to supermarket website
2. Open DevTools → Application → Cookies
3. Copy all cookies as header string
4. Save to session file manually

```javascript
import fs from 'fs';
import path from 'path';
import os from 'os';

const sessionFile = path.join(os.homedir(), '.sainsburys', 'session.json');
const cookies = 'session=abc123; path=/; ...'; // From browser

fs.writeFileSync(sessionFile, JSON.stringify({
  cookies,
  savedAt: new Date().toISOString()
}));
```

### Session Refresh

Sessions typically last 7 days. They auto-refresh on API calls. If expired, re-login:

```typescript
if (!await provider.isAuthenticated()) {
  await provider.login(email, password);
}
```

---

## TypeScript Types

All types are exported from `src/providers/types.ts`:

```typescript
import {
  GroceryProvider,
  Product,
  Basket,
  BasketItem,
  DeliverySlot,
  Order,
  SearchOptions
} from './providers/types';
```

---

## Example: Complete Shopping Flow

```typescript
import { SainsburysProvider } from './providers/sainsburys';

async function completeShop() {
  const provider = new SainsburysProvider();
  
  // 1. Login
  await provider.login('you@email.com', 'password123');
  
  // 2. Search products
  const milkResults = await provider.search('milk');
  const breadResults = await provider.search('bread');
  
  // 3. Add to basket
  await provider.addToBasket(milkResults[0].product_uid, 2);
  await provider.addToBasket(breadResults[0].product_uid, 1);
  
  // 4. View basket
  const basket = await provider.getBasket();
  console.log(`Total: £${basket.total_cost}`);
  
  // 5. Get delivery slots
  const slots = await provider.getDeliverySlots();
  const nextSlot = slots.find(s => s.available);
  
  // 6. Book slot
  if (nextSlot) {
    await provider.bookSlot(nextSlot.slot_id);
  }
  
  // 7. Checkout
  const order = await provider.checkout();
  console.log(`Order placed: ${order.order_id}`);
  
  return order;
}
```

---

## Testing

### Mock Provider

For testing without real API calls:

```typescript
class MockProvider implements GroceryProvider {
  readonly name = 'mock';
  
  async login() { return; }
  async logout() { return; }
  async isAuthenticated() { return true; }
  
  async search(query: string): Promise<Product[]> {
    return [{
      product_uid: 'mock_123',
      name: `Mock ${query}`,
      retail_price: { price: 1.99 },
      in_stock: true,
      provider: 'mock'
    }];
  }
  
  // ... implement other methods
}
```

### Integration Tests

```typescript
describe('SainsburysProvider', () => {
  let provider: SainsburysProvider;
  
  beforeEach(() => {
    provider = new SainsburysProvider();
  });
  
  it('should search products', async () => {
    const results = await provider.search('milk');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('product_uid');
  });
  
  it('should add to basket', async () => {
    await provider.login(EMAIL, PASSWORD);
    const products = await provider.search('milk');
    await provider.addToBasket(products[0].product_uid, 1);
    const basket = await provider.getBasket();
    expect(basket.items.length).toBeGreaterThan(0);
  });
});
```

---

## Performance

### Parallel Searches

```typescript
// Search multiple providers in parallel
const [sainsburysResults, ocadoResults] = await Promise.all([
  sainsburysProvider.search('milk'),
  ocadoProvider.search('milk')
]);
```

### Batch Basket Operations

```typescript
// Add multiple items in parallel
await Promise.all(
  products.map(p => provider.addToBasket(p.product_uid, p.quantity))
);
```

### Caching

```typescript
// Cache search results
const cache = new Map<string, Product[]>();

async function cachedSearch(query: string): Promise<Product[]> {
  if (cache.has(query)) {
    return cache.get(query)!;
  }
  
  const results = await provider.search(query);
  cache.set(query, results);
  
  // Expire after 1 hour
  setTimeout(() => cache.delete(query), 60 * 60 * 1000);
  
  return results;
}
```

---

## See Also

- [Smart Shopping Guide](./SMART-SHOPPING.md) - Intelligent agent decision-making
- [AGENTS.md](../AGENTS.md) - Agent integration patterns
- [SKILL.md](../SKILL.md) - Open skills format reference
