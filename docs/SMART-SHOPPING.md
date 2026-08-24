# Smart Shopping Guide

**Intelligent agent decision-making for grocery shopping.**

Your agent doesn't just find products - it makes smart decisions about what to buy based on health, budget, and preferences.

---

## Organic vs Conventional

Not all produce needs to be organic. Some conventional produce is perfectly safe, while others have high pesticide residues.

### The Dirty Dozen

**Always buy organic for these (high pesticide residue):**

1. Strawberries
2. Spinach
3. Kale, collard & mustard greens
4. Peaches
5. Pears
6. Nectarines
7. Apples
8. Grapes
9. Bell & hot peppers
10. Cherries
11. Blueberries
12. Green beans

### The Clean Fifteen

**Safe to buy conventional (low pesticide residue):**

1. Avocados
2. Sweet corn
3. Pineapple
4. Onions
5. Papaya
6. Sweet peas (frozen)
7. Asparagus
8. Honeydew melon
9. Kiwi
10. Cabbage
11. Mushrooms
12. Mangoes
13. Sweet potatoes
14. Watermelon
15. Carrots

---

## Agent Decision Logic

### Example: Organic Prioritization

```typescript
async function smartOrganicChoice(product: string, budget: number) {
  const dirtyDozen = [
    'strawberries', 'spinach', 'kale', 'peaches', 'pears',
    'nectarines', 'apples', 'grapes', 'peppers', 'cherries',
    'blueberries', 'green beans'
  ];
  
  const cleanFifteen = [
    'avocados', 'sweet corn', 'pineapple', 'onions', 'papaya',
    'sweet peas', 'asparagus', 'honeydew', 'kiwi', 'cabbage',
    'mushrooms', 'mangoes', 'sweet potatoes', 'watermelon', 'carrots'
  ];
  
  const isDirtyDozen = dirtyDozen.some(item => 
    product.toLowerCase().includes(item)
  );
  
  const isCleanFifteen = cleanFifteen.some(item => 
    product.toLowerCase().includes(item)
  );
  
  // Search both organic and conventional
  const organic = await searchProduct(`organic ${product}`);
  const conventional = await searchProduct(product);
  
  const priceDiff = organic.price - conventional.price;
  const percentDiff = (priceDiff / conventional.price) * 100;
  
  // Decision logic
  if (isDirtyDozen) {
    // Always recommend organic for Dirty Dozen
    return {
      choice: 'organic',
      reason: 'High pesticide residue - organic recommended',
      product: organic,
      savings: null
    };
  }
  
  if (isCleanFifteen) {
    // Conventional is safe
    return {
      choice: 'conventional',
      reason: 'Low pesticide residue - conventional is safe',
      product: conventional,
      savings: priceDiff
    };
  }
  
  // For others, consider budget and price difference
  if (percentDiff < 20 && budget > organic.price) {
    // Less than 20% more expensive - worth it
    return {
      choice: 'organic',
      reason: `Only ${percentDiff.toFixed(0)}% more expensive`,
      product: organic,
      savings: null
    };
  }
  
  if (percentDiff > 50) {
    // More than 50% more expensive - skip
    return {
      choice: 'conventional',
      reason: `Organic is ${percentDiff.toFixed(0)}% more expensive`,
      product: conventional,
      savings: priceDiff
    };
  }
  
  // Middle ground - ask user
  return {
    choice: 'ask',
    reason: `Organic is ${percentDiff.toFixed(0)}% more expensive`,
    organic,
    conventional,
    priceDiff
  };
}
```

### Example: Budget Optimization

```typescript
async function buildSmartShoppingList(meals: Meal[], budget: number) {
  const ingredients = extractIngredients(meals);
  const shoppingList = [];
  let spent = 0;
  
  for (const ingredient of ingredients) {
    const decision = await smartOrganicChoice(
      ingredient.name,
      budget - spent
    );
    
    if (decision.choice === 'organic') {
      shoppingList.push({
        ...decision.product,
        note: decision.reason
      });
      spent += decision.product.price;
    } else if (decision.choice === 'conventional') {
      shoppingList.push({
        ...decision.product,
        note: decision.reason,
        saved: decision.savings
      });
      spent += decision.product.price;
    } else {
      // Ask user
      const userChoice = await ask(
        `${ingredient.name}: Organic £${decision.organic.price} or Conventional £${decision.conventional.price}? (${decision.reason})`
      );
      
      const chosen = userChoice === 'organic' ? decision.organic : decision.conventional;
      shoppingList.push(chosen);
      spent += chosen.price;
    }
  }
  
  return {
    list: shoppingList,
    totalSpent: spent,
    totalSaved: shoppingList.reduce((sum, item) => sum + (item.saved || 0), 0),
    budgetRemaining: budget - spent
  };
}
```

---

## Smart Provider Selection

Don't just pick cheapest - consider quality, delivery, and convenience.

### Example: Multi-Factor Optimization

```typescript
async function selectBestProvider(product: string, preferences: any) {
  // Search all providers
  const results = await compareProduct(product);
  
  // Score each option
  const scored = results.map(({ provider, products }) => {
    const bestProduct = products[0];
    
    let score = 0;
    
    // Price (40% weight)
    const cheapest = Math.min(...results.map(r => r.products[0]?.price || Infinity));
    const priceScore = (cheapest / bestProduct.price) * 40;
    score += priceScore;
    
    // Quality preference (30% weight)
    const qualityScores = {
      'ocado': 35,      // Premium quality
      'sainsburys': 30, // Good quality
      'tesco': 25,      // Standard
      'asda': 20        // Budget
    };
    score += qualityScores[provider] || 25;
    
    // User preference (20% weight)
    if (preferences.preferredProviders?.includes(provider)) {
      score += 20;
    } else {
      score += 10;
    }
    
    // Availability (10% weight)
    if (bestProduct.in_stock === true) {
      score += 10;
    } else if (bestProduct.in_stock === null) {
      score += 5; // Unknown is not the same as confirmed out of stock.
    }
    
    return {
      provider,
      product: bestProduct,
      score,
      breakdown: {
        price: priceScore,
        quality: qualityScores[provider],
        preference: preferences.preferredProviders?.includes(provider) ? 20 : 10,
        availability: bestProduct.in_stock === true ? 10 : bestProduct.in_stock === null ? 5 : 0
      }
    };
  });
  
  // Sort by score
  scored.sort((a, b) => b.score - a.score);
  
  return scored[0];
}
```

---

## Smart Substitutions

When item is out of stock or too expensive, suggest alternatives.

### Example: Substitution Logic

```typescript
async function findSubstitute(originalProduct: string, reason: 'out_of_stock' | 'over_budget') {
  const substitutes = {
    'strawberries': ['blueberries', 'raspberries', 'blackberries'],
    'kale': ['spinach', 'chard', 'collard greens'],
    'organic milk': ['standard milk', 'oat milk', 'almond milk'],
    'beef mince': ['turkey mince', 'plant-based mince', 'lamb mince']
  };
  
  const alternatives = substitutes[originalProduct.toLowerCase()] || [];
  
  if (alternatives.length === 0) {
    return { found: false, suggestion: null };
  }
  
  // Search alternatives
  const results = await Promise.all(
    alternatives.map(alt => searchProduct(alt))
  );
  
  // Filter by reason
  if (reason === 'out_of_stock') {
    const inStock = results.filter(r => r.in_stock === true);
    return {
      found: inStock.length > 0,
      suggestion: inStock[0],
      reason: `${originalProduct} out of stock`
    };
  }
  
  if (reason === 'over_budget') {
    const cheaper = results.filter(r => r.price < originalProduct.price);
    return {
      found: cheaper.length > 0,
      suggestion: cheaper[0],
      reason: `Cheaper alternative to ${originalProduct}`
    };
  }
}
```

---

## Seasonal Awareness

Buy produce in season for better prices and quality.

### UK Seasonal Calendar

```typescript
const ukSeasonalProduce = {
  'January-March': ['kale', 'leeks', 'brussels sprouts', 'cabbage'],
  'April-June': ['asparagus', 'spinach', 'radishes', 'spring onions'],
  'July-September': ['tomatoes', 'courgettes', 'berries', 'corn'],
  'October-December': ['pumpkins', 'parsnips', 'beetroot', 'apples']
};

function isInSeason(product: string, month: number): boolean {
  const quarter = Math.floor((month - 1) / 3);
  const seasons = [
    'January-March',
    'April-June',
    'July-September',
    'October-December'
  ];
  
  const seasonalItems = ukSeasonalProduce[seasons[quarter]];
  return seasonalItems.some(item => product.toLowerCase().includes(item));
}

async function prioritizeSeasonalProduce(products: Product[]): Product[] {
  const month = new Date().getMonth() + 1;
  
  return products.sort((a, b) => {
    const aInSeason = isInSeason(a.name, month);
    const bInSeason = isInSeason(b.name, month);
    
    if (aInSeason && !bInSeason) return -1;
    if (!aInSeason && bInSeason) return 1;
    return a.price - b.price;
  });
}
```

---

## Waste Prevention

Don't overbuy - consider shelf life and usage.

### Example: Smart Quantity

```typescript
function calculateOptimalQuantity(
  product: string,
  householdSize: number,
  shelfLife: number // days
): number {
  const usageRates = {
    'milk': householdSize * 0.5, // 0.5L per person per day
    'eggs': householdSize * 2,   // 2 eggs per person per week
    'bread': householdSize * 3,  // 3 slices per person per day
    'vegetables': householdSize * 0.3 // 300g per person per day
  };
  
  const category = Object.keys(usageRates).find(cat => 
    product.toLowerCase().includes(cat)
  );
  
  if (!category) return 1; // Default
  
  const dailyUsage = usageRates[category];
  const totalNeeded = dailyUsage * shelfLife;
  
  // Round to sensible pack sizes
  if (category === 'milk') return Math.ceil(totalNeeded / 2.27); // 2.27L bottles
  if (category === 'eggs') return Math.ceil(totalNeeded / 12);   // boxes of 12
  if (category === 'bread') return Math.ceil(totalNeeded / 20);  // loaves
  
  return Math.ceil(totalNeeded);
}
```

---

## Meal Plan Optimization

Build meals around what's available, in season, and good value.

### Example: Smart Meal Selection

```typescript
async function suggestOptimizedMeals(
  budget: number,
  preferences: Preferences,
  people: number
) {
  const month = new Date().getMonth() + 1;
  
  // Get seasonal ingredients
  const seasonal = getSeasonalProduce(month);
  
  // Get price data
  const ingredientPrices = await Promise.all(
    seasonal.map(ing => searchProduct(ing))
  );
  
  // Build meals around cheap + seasonal ingredients
  const mealDatabase = getMealDatabase();
  
  const optimizedMeals = mealDatabase
    .filter(meal => {
      // Filter by dietary restrictions
      if (preferences.dietary_restrictions) {
        return preferences.dietary_restrictions.every(restriction =>
          meal.tags.includes(restriction)
        );
      }
      return true;
    })
    .map(meal => {
      // Calculate cost using current prices
      const cost = calculateMealCost(meal, ingredientPrices);
      
      // Score based on seasonal ingredients
      const seasonalScore = meal.ingredients.filter(ing =>
        seasonal.includes(ing)
      ).length;
      
      // Score based on budget
      const budgetScore = cost < (budget / 7) ? 10 : 0;
      
      return {
        ...meal,
        cost,
        score: seasonalScore + budgetScore,
        seasonal: seasonalScore > 0
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 7); // One week
  
  return optimizedMeals;
}
```

---

## Agent Conversation Example

```
User: "Plan my weekly shop, £60 budget, prefer organic when it makes sense"

Agent:
  → Analyzes Dirty Dozen vs Clean Fifteen
  → Searches both organic and conventional options
  → Calculates price differences
  → Makes smart recommendations

"Here's your optimized shopping list:

ALWAYS ORGANIC (Dirty Dozen):
  • Strawberries (organic) - £3.20
    Reason: High pesticide residue
  • Spinach (organic) - £2.10
    Reason: High pesticide residue

CONVENTIONAL IS FINE (Clean Fifteen):
  • Avocados (conventional) - £1.50
    Reason: Low pesticide residue
    Saved: £1.20 vs organic

WORTH IT (Small price difference):
  • Tomatoes (organic) - £2.80
    Reason: Only 15% more expensive
  • Carrots (organic) - £1.40
    Reason: Only 10% more expensive

NOT WORTH IT (Big price difference):
  • Potatoes (conventional) - £1.80
    Reason: Organic is 60% more expensive
    Saved: £2.70

Total: £58.30
Budget remaining: £1.70
Total saved by smart choices: £3.90
Health optimized: All high-risk items are organic"
```

---

## Implementation

Add this to your agent's skill directory:

```bash
cp docs/SMART-SHOPPING.md /path/to/agent/skills/open-supermarkets/
```

Your agent can reference this guide when making shopping decisions.

---

**Smart shopping isn't just about finding the cheapest option - it's about making informed decisions that balance health, budget, and quality.**
