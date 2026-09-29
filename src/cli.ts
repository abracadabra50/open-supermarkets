#!/usr/bin/env node

import { Command } from 'commander';
import { ProviderFactory, ProviderName, compareProduct } from './providers';
import {
  list as listProviders,
  resolveCountry,
  countries as knownCountries,
  providersFor,
  createProvider,
} from './providers/registry';
import type { Capability } from './providers/types';
import { money } from './format';
import { explain } from './errors';
// Tesco is imported as a *type only* — a value import here would pull Playwright
// into every `groc` invocation, including `groc providers` in another country.
import type { TescoProvider } from './providers/tesco/index';

const program = new Command();

// Invoked as `supermarket`. `groc` still works as a deprecated alias — it was the
// name while this was UK-only, and it is being retired because the `groc` npm
// package (a literate-programming doc generator) ships its own `groc` binary, so
// the two cannot coexist on one PATH.
const invokedAs = require('path').basename(process.argv[1] || 'supermarket')
  .replace(/\.(js|ts)$/, '');

if (invokedAs.startsWith('groc')) {
  console.error(
    '\x1b[33mnote:\x1b[0m `groc` is deprecated and will be removed in v4. ' +
    'Use `supermarket` instead — same flags, no other change.\n'
  );
}

program
  .name(invokedAs.startsWith('groc') ? invokedAs : 'supermarket')
  .description("One command line for the world's supermarkets. Built for agents.")
  .version('3.0.0')
  .option('-p, --provider <name>', 'Provider id (see `supermarket providers`)', 'sainsburys');

// Parse a string as a positive integer, or throw
function parsePositiveInt(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return n;
}

// Helper to get provider from options
function getProvider(options: any) {
  const providerName = options.provider || program.opts().provider;
  return ProviderFactory.create(providerName as ProviderName);
}


function printProducts(products: any[]) {
  products.forEach((p, i) => {
    const stock = p.in_stock === true ? '✅' : p.in_stock === false ? '❌' : '❔';
    const rating = p.rating ? ` ${p.rating}★ (${p.review_count ?? 0})` : '';
    const size = p.size ? ` / ${p.size}` : '';
    const unit = p.unit_price?.price
      ? ` (${money(p.unit_price.price, p.currency)}${p.unit_price.measure ? `/${p.unit_price.measure}` : ''})`
      : '';
    console.log(`${i + 1}. ${p.name}${rating}`);
    console.log(`   ${money(p.retail_price.price, p.currency)}${size}${unit} ${stock}`);
    console.log(`   ID: ${p.product_uid}\n`);
  });
}

// Login
program
  .command('login')
  .description('Login to supermarket account')
  .option('-e, --email <email>', 'Email address (or set SUPERMARKET_EMAIL)')
  .option('--password [password]', 'Password (or set SUPERMARKET_PASSWORD; omit to be prompted interactively)')
  .action(async (options, cmd) => {
    try {
      // SUPERMARKET_* is preferred; GROC_* still works for pre-3.0 setups.
      const email =
        options.email || process.env.SUPERMARKET_EMAIL || process.env.GROC_EMAIL;
      const password =
        options.password || process.env.SUPERMARKET_PASSWORD || process.env.GROC_PASSWORD;
      if (!email || !password) {
        console.error('❌ Email and password required. Use --email/--password or set SUPERMARKET_EMAIL/SUPERMARKET_PASSWORD.');
        process.exit(1);
      }
      const provider = getProvider(cmd.optsWithGlobals());
      await provider.login(email, password);
      console.log(`✅ Logged in to ${provider.name}`);
    } catch (error: any) {
      console.error('❌ Login failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'login' }));
      process.exit(1);
    }
  });

// Logout
program
  .command('logout')
  .description('Logout from supermarket account')
  .action(async (options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());
      await provider.logout();
      console.log(`✅ Logged out from ${provider.name}`);
    } catch (error: any) {
      console.error('❌ Logout failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'logout' }));
      process.exit(1);
    }
  });

// Status
program
  .command('status')
  .description('Check saved session/authentication status')
  .option('--json', 'Output as JSON')
  .action(async (options, cmd) => {
    try {
      const providerName = cmd.optsWithGlobals().provider;
      const provider = getProvider(cmd.optsWithGlobals());
      const sessionInfo =
        providerName === 'tesco'
          ? (await import('./providers/tesco/auth')).getSessionInfo()
          : providerName === 'tesco-hu'
            ? (await import('./providers/tesco-hu/session')).getSessionInfo()
            : undefined;
      const authenticated = await provider.isAuthenticated();

      const result = {
        provider: provider.name,
        authenticated,
        session: sessionInfo,
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`\n🔐 ${provider.name.toUpperCase()} Status\n`);
      console.log(`Authenticated: ${authenticated ? '✅ yes' : '❌ no'}`);

      if (sessionInfo) {
        console.log(`Session file: ${sessionInfo.exists ? sessionInfo.path : 'not found'}`);
        if (sessionInfo.exists) {
          console.log(`Cookies: ${sessionInfo.cookieCount}`);
          console.log(`Last login/import: ${sessionInfo.lastLogin || 'unknown'}`);
          console.log(`Expires: ${sessionInfo.expiresAt || 'unknown'} ${sessionInfo.expired ? '(expired)' : ''}`);
        }
      }

      if (!authenticated) {
        console.log(`\n💡 Refresh with \`supermarket login\` or import browser cookies with \`supermarket --provider ${providerName} import-session --file <cookies.json>\`.`);
      }
      console.log();
    } catch (error: any) {
      console.error('❌ Status check failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'status check' }));
      process.exit(1);
    }
  });

// Search
program
  .command('search [query]')
  .description('Search for products')
  .option('-l, --limit <number>', 'Max results', '24')
  .option('-c, --country <code>', 'Country to shop in (ISO 3166-1 alpha-2)')
  .option('--enrich', 'Add Nutri-Score, NOVA and allergens from Open Food Facts')
  .option('--batch <file>', 'Run many queries at once. JSON array, or - for stdin')
  .option('--json', 'Output as JSON')
  .action(async (query, options, cmd) => {
    try {
      const limit = parsePositiveInt(options.limit, 'limit');
      const globals = cmd.optsWithGlobals();

      // `--country` picks the first search-capable provider there, unless a
      // provider was named explicitly. This is what makes `search --country NL`
      // work without the user knowing which chains exist in the Netherlands.
      let provider;
      if (options.country && !cmd.args.includes('--provider')) {
        const country = resolveCountry(options.country);
        const [first] = providersFor(country, 'search');
        provider = await createProvider(first.id);
      } else {
        provider = getProvider(globals);
      }

      // Batch mode: thirty queries in one invocation instead of thirty.
      if (options.batch) {
        const { batchSearch, parseBatchInput } = await import('./batch');
        const raw =
          options.batch === '-'
            ? require('fs').readFileSync(0, 'utf-8')
            : require('fs').readFileSync(
                options.batch.startsWith('~')
                  ? require('path').join(require('os').homedir(), options.batch.slice(1))
                  : options.batch,
                'utf-8'
              );
        const queries = parseBatchInput(raw);
        const results = await batchSearch(provider, queries, { limit });

        if (options.json !== false) {
          console.log(JSON.stringify({ provider: provider.name, results }, null, 2));
          return;
        }
        for (const r of results) {
          console.log(`\n${r.query}`);
          if (r.error) { console.log(`  error: ${r.error}`); continue; }
          for (const p of r.products) {
            console.log(`  ${money(p.price, p.currency)}  ${p.name}${p.size ? ` (${p.size})` : ''}`);
          }
        }
        return;
      }

      let products: any[] = await provider.search(query, { limit });

      if (options.enrich) {
        const { enrich } = await import('./enrich/openfoodfacts');
        products = await enrich(products);
      }

      if (options.json) {
        console.log(JSON.stringify({ products }, null, 2));
        return;
      }

      console.log(`\n🔍 Search results from ${provider.name}: "${query}"\n`);
      printProducts(products);

      if (options.enrich) {
        products.forEach((p: any, i: number) => {
          const n = p.nutrition;
          if (!n) return;
          const bits = [
            n.nutriscore ? `Nutri-Score ${n.nutriscore.toUpperCase()}` : null,
            n.nova ? `NOVA ${n.nova}` : null,
            n.allergens.length ? `allergens: ${n.allergens.join(', ')}` : null,
            n.match === 'name' ? 'matched by name' : 'matched by barcode',
          ].filter(Boolean);
          console.log(`   ${i + 1}. ${bits.join(' · ')}`);
        });
        console.log();
      }
    } catch (error: any) {
      console.error('❌ Search failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'search' }));
      process.exit(1);
    }
  });

// Favourites
program
  .command('favourites')
  .alias('favorites')
  .description('List favourite / frequently-bought products')
  .option('-l, --limit <number>', 'Max results', '50')
  .option('--json', 'Output as JSON')
  .action(async (options, cmd) => {
    try {
      const provider: any = getProvider(cmd.optsWithGlobals());
      if (typeof provider.getFavourites !== 'function') {
        throw new Error(`Provider "${provider.name}" does not support favourites`);
      }

      const products = await provider.getFavourites({ limit: parsePositiveInt(options.limit, 'limit') });
      if (options.json) {
        console.log(JSON.stringify({ products }, null, 2));
      } else {
        console.log(`\n⭐ Favourites from ${provider.name}\n`);
        printProducts(products);
      }
    } catch (error: any) {
      console.error('❌ Failed to get favourites:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'get favourites' }));
      process.exit(1);
    }
  });

// List categories
program
  .command('categories')
  .description('List browse categories (provider-dependent shape)')
  .option('--json', 'Output as JSON')
  .action(async (options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());
      const cats = await provider.getCategories();
      if (options.json) {
        console.log(JSON.stringify({ categories: cats }, null, 2));
      } else if (Array.isArray(cats) && cats[0]?.path) {
        console.log(`\n🗂️  ${provider.name.toUpperCase()} categories\n`);
        cats.forEach((c: any) => console.log(`${'  '.repeat(c.depth ?? 0)}${c.name}\n${'  '.repeat(c.depth ?? 0)}   ${c.path}`));
      } else {
        console.log(JSON.stringify(cats, null, 2));
      }
    } catch (error: any) {
      console.error('❌ Failed to list categories:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'list categories' }));
      process.exit(1);
    }
  });

// Browse a category listing
program
  .command('browse <category-path>')
  .description('Browse products in a category (use a path from `categories`)')
  .option('-l, --limit <number>', 'Max results', '24')
  .option('--json', 'Output as JSON')
  .action(async (categoryPath, options, cmd) => {
    try {
      const provider: any = getProvider(cmd.optsWithGlobals());
      if (typeof provider.browseCategory !== 'function') {
        throw new Error(`Provider "${provider.name}" does not support category browsing`);
      }
      const products = await provider.browseCategory(categoryPath, { limit: parsePositiveInt(options.limit, 'limit') });
      if (options.json) {
        console.log(JSON.stringify({ products }, null, 2));
      } else {
        console.log(`\n🗂️  ${provider.name}: ${categoryPath}\n`);
        printProducts(products);
      }
    } catch (error: any) {
      console.error('❌ Browse failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'browse' }));
      process.exit(1);
    }
  });

// Deals view: top-rated + cheapest for a query (works with any provider
// whose products carry rating/price data)
program
  .command('deals <query>')
  .description('Show top-rated and cheapest results for a query')
  .option('-l, --limit <number>', 'Max results per table', '5')
  .option('--json', 'Output as JSON')
  .action(async (query, options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());
      const limit = parsePositiveInt(options.limit, 'limit');
      const products = await provider.search(query, { limit: 50 });
      const available = products.filter(p => p.in_stock && p.retail_price.price > 0);
      const rated = available
        .filter(p => p.rating)
        .sort((a, b) => (b.rating! - a.rating!) || ((b.review_count ?? 0) - (a.review_count ?? 0)))
        .slice(0, limit);
      const cheapest = [...available]
        .sort((a, b) => a.retail_price.price - b.retail_price.price)
        .slice(0, limit);
      if (options.json) {
        console.log(JSON.stringify({ top_rated: rated, cheapest }, null, 2));
      } else {
        console.log(`\n🏆 Top rated from ${provider.name}: "${query}"\n`);
        printProducts(rated.length ? rated : available.slice(0, limit));
        console.log(`💰 Cheapest\n`);
        printProducts(cheapest);
      }
    } catch (error: any) {
      console.error('❌ Deals failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'deals' }));
      process.exit(1);
    }
  });

// Recurring shopping ("Regulars")
program
  .command('regulars')
  .description('List recurring-shopping definitions (Ocado)')
  .option('--json', 'Output as JSON')
  .action(async (options, cmd) => {
    try {
      const provider: any = getProvider(cmd.optsWithGlobals());
      if (typeof provider.getRegulars !== 'function') {
        throw new Error(`Provider "${provider.name}" does not support regulars`);
      }
      const regulars = await provider.getRegulars();
      if (options.json) {
        console.log(JSON.stringify({ regulars }, null, 2));
      } else if (regulars.length === 0) {
        console.log(`\n🔁 No regulars set up on ${provider.name}.`);
      } else {
        console.log(`\n🔁 Regulars on ${provider.name}\n`);
        regulars.forEach((r: any) => console.log(JSON.stringify(r)));
      }
    } catch (error: any) {
      console.error('❌ Regulars failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'regulars' }));
      process.exit(1);
    }
  });

// Search within favourites
program
  .command('fav-search <query>')
  .alias('favorite-search')
  .description('Search within favourite / frequently-bought products')
  .option('-l, --limit <number>', 'Max results', '24')
  .option('--json', 'Output as JSON')
  .action(async (query, options, cmd) => {
    try {
      const provider: any = getProvider(cmd.optsWithGlobals());
      if (typeof provider.searchFavourites !== 'function') {
        throw new Error(`Provider "${provider.name}" does not support favourite search`);
      }

      const products = await provider.searchFavourites(query, { limit: parsePositiveInt(options.limit, 'limit') });
      if (options.json) {
        console.log(JSON.stringify({ products }, null, 2));
      } else {
        console.log(`\n⭐ Favourite search results from ${provider.name}: "${query}"\n`);
        printProducts(products);
      }
    } catch (error: any) {
      console.error('❌ Favourite search failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'favourite search' }));
      process.exit(1);
    }
  });

// Compare across providers
program
  .command('compare <query>')
  .description('Compare a product across every provider in a country')
  .option('-l, --limit <number>', 'Results per provider', '5')
  .option('-c, --country <code>', 'Country to compare in (ISO 3166-1 alpha-2)')
  .option('--json', 'Output as JSON')
  .action(async (query, options) => {
    try {
      const country = resolveCountry(options.country);
      console.log(`\n🔍 Comparing "${query}" across ${country} supermarkets...\n`);

      const limit = parsePositiveInt(options.limit, 'limit');
      const results = await compareProduct(query, undefined, limit, country);
      
      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      for (const { provider, products, error } of results) {
        console.log(`\n📦 ${provider.toUpperCase()}`);
        console.log('─'.repeat(50));
        
        if (error) {
          console.log(`❌ Error: ${error}\n`);
          continue;
        }

        if (products.length === 0) {
          console.log('No products found\n');
          continue;
        }

        const cheapest = products.reduce((min, p) => 
          p.retail_price.price < min.retail_price.price ? p : min
        );

        products.slice(0, 5).forEach((p, i) => {
          const isCheapest = p.product_uid === cheapest.product_uid ? ' 💰 BEST' : '';
          console.log(`${i + 1}. ${p.name}`);
          console.log(`   ${money(p.retail_price.price, p.currency)}${isCheapest}`);
        });
        console.log();
      }
    } catch (error: any) {
      console.error('❌ Compare failed:', explain(error, { action: 'compare across providers' }));
      process.exit(1);
    }
  });

// Basket
program
  .command('basket')
  .description('View basket')
  .option('--json', 'Output as JSON')
  .action(async (options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());
      const basket = await provider.getBasket();
      
      if (options.json) {
        console.log(JSON.stringify(basket, null, 2));
      } else {
        console.log(`\n🛒 ${provider.name.toUpperCase()} Basket\n`);
        console.log(`Total: ${money(basket.total_cost, (basket as any).currency)} (${basket.total_quantity} items)\n`);
        
        basket.items.forEach((item, i) => {
          console.log(`${i + 1}. ${item.quantity}x ${item.name}`);
          console.log(`   ${money(item.unit_price, (basket as any).currency)} each = ${money(item.total_price, (basket as any).currency)}`);
          console.log(`   ID: ${item.item_id}\n`);
        });
      }
    } catch (error: any) {
      console.error('❌ Failed to get basket:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'get basket' }));
      process.exit(1);
    }
  });

// Add to basket
program
  .command('add [product-id]')
  .description('Add product(s) to basket')
  .option('-q, --qty <number>', 'Quantity', '1')
  .option('--batch <file>', 'Add many at once. JSON [{id,qty}], or - for stdin')
  .action(async (productId, options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());

      if (options.batch) {
        const { batchAdd, parseAddInput } = await import('./batch');
        const raw =
          options.batch === '-'
            ? require('fs').readFileSync(0, 'utf-8')
            : require('fs').readFileSync(options.batch, 'utf-8');
        const results = await batchAdd(provider, parseAddInput(raw));
        const ok = results.filter(r => r.ok).length;
        console.log(JSON.stringify({ provider: provider.name, added: ok, total: results.length, results }, null, 2));
        if (ok < results.length) process.exit(1);
        return;
      }

      if (!productId) {
        console.error('❌ Give a product id, or use --batch. See --help.');
        process.exit(1);
      }
      await provider.addToBasket(productId, parsePositiveInt(options.qty, 'qty'));
      console.log(`✅ Added to ${provider.name} basket`);
    } catch (error: any) {
      console.error('❌ Failed to add to basket:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'add to basket' }));
      process.exit(1);
    }
  });

// Remove from basket
program
  .command('remove <item-id>')
  .description('Remove item from basket')
  .action(async (itemId, options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());
      await provider.removeFromBasket(itemId);
      console.log(`✅ Removed from ${provider.name} basket`);
    } catch (error: any) {
      console.error('❌ Failed to remove from basket:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'remove from basket' }));
      process.exit(1);
    }
  });

// Delivery slots
program
  .command('slots')
  .description('View delivery slots')
  .option('--json', 'Output as JSON')
  .action(async (options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());
      const slots = await provider.getDeliverySlots();
      
      if (options.json) {
        console.log(JSON.stringify({ slots }, null, 2));
      } else {
        console.log(`\n📅 ${provider.name.toUpperCase()} Delivery Slots\n`);
        slots.forEach((slot, i) => {
          const available = slot.available ? '✅' : '❌';
          console.log(`${i + 1}. ${slot.date} ${slot.start_time}-${slot.end_time}`);
          console.log(`   ${money(slot.price)} ${available}`);
          console.log(`   ID: ${slot.slot_id}\n`);
        });
      }
    } catch (error: any) {
      console.error('❌ Failed to get slots:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'get slots' }));
      process.exit(1);
    }
  });

// Book slot
program
  .command('book <slot-id>')
  .description('Book delivery slot')
  .action(async (slotId, options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());
      await provider.bookSlot(slotId);
      console.log(`✅ Slot booked with ${provider.name}`);
    } catch (error: any) {
      console.error('❌ Failed to book slot:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'book slot' }));
      process.exit(1);
    }
  });

// Checkout
program
  .command('checkout')
  .description('Preview the order. Placing it for real requires --confirm.')
  // Dry run is the DEFAULT, and placing an order needs an explicit --confirm.
  //
  // This was the other way round until v3: a bare `checkout` spent real money and
  // `--dry-run` was opt-in. The MCP tool has always defaulted dry_run=true, which
  // meant the agent had the safe default and the human did not — exactly backwards.
  // A command that spends money should require you to say so.
  .option('--confirm', 'Actually place the order. Spends real money.')
  .option('--dry-run', 'Preview only (the default; kept for explicitness)')
  .action(async (options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());
      const placing = options.confirm === true;

      if (!placing) {
        console.log(`🔍 Previewing ${provider.name} checkout — nothing will be ordered.\n`);
      }

      const order = await provider.checkout(!placing);

      if (!placing) {
        console.log(`\n📋 Checkout Preview:`);
        console.log(`Total: ${money(order.total)}`);
        console.log(`Status: ${order.status}`);
        console.log(`\n💡 This placed NO order. Re-run with --confirm to buy.`);
      } else {
        console.log(`✅ Order placed with ${provider.name}!`);
        console.log(JSON.stringify(order, null, 2));
      }
    } catch (error: any) {
      console.error('❌ Checkout failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'checkout' }));
      process.exit(1);
    }
  });

// Orders
program
  .command('orders')
  .description('View order history')
  .option('--json', 'Output as JSON')
  .option('--limit <number>', 'Max orders to show', '10')
  .action(async (options, cmd) => {
    try {
      const provider = getProvider(cmd.optsWithGlobals());
      const orders = await provider.getOrders();
      
      if (options.json) {
        console.log(JSON.stringify({ orders }, null, 2));
        return;
      }
      
      if (orders.length === 0) {
        console.log(`\n📦 No orders found for ${provider.name}\n`);
        console.log('Note: Order history may not be available via API.');
        console.log('Check the website for full order history.\n');
        return;
      }
      
      console.log(`\n📦 ${provider.name.toUpperCase()} Order History\n`);
      
      const orderLimit = parsePositiveInt(options.limit, 'limit');
      const displayOrders = orders.slice(0, orderLimit);
      
      displayOrders.forEach((order, i) => {
        console.log(`${i + 1}. Order #${order.order_id}`);
        console.log(`   Status: ${order.status}`);
        console.log(`   Total: ${money(order.total)}`);
        
        if (order.delivery_slot) {
          console.log(`   Delivery: ${order.delivery_slot.date} ${order.delivery_slot.start_time}-${order.delivery_slot.end_time}`);
        }
        
        if (order.items && order.items.length > 0) {
          console.log(`   Items: ${order.items.length}`);
        }
        
        console.log();
      });
      
      if (orders.length > orderLimit) {
        console.log(`Showing ${orderLimit} of ${orders.length} orders. Use --limit to see more.\n`);
      }
    } catch (error: any) {
      console.error('❌ Failed to get orders:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'get orders' }));
      console.log('\nNote: Order history may require additional permissions.');
      console.log('Try logging in again or check the website.\n');
      process.exit(1);
    }
  });

// Update basket item quantity
program
  .command('update <item-id> <quantity>')
  .description('Update quantity of a basket item')
  .action(async (itemId, quantity, options, cmd) => {
    try {
      const provider = getProvider((cmd as any).optsWithGlobals());
      await provider.updateBasketItem(itemId, parseInt(quantity));
      console.log(`✅ Updated item ${itemId} to qty ${quantity}`);
    } catch (error: any) {
      console.error('❌ Failed to update basket item:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'update basket item' }));
      process.exit(1);
    }
  });

// Clear basket
program
  .command('clear')
  .description('Clear all items from basket')
  .option('--force', 'Skip confirmation prompt')
  .action(async (options, cmd) => {
    try {
      if (!options.force) {
        console.log('⚠️  Use --force to confirm clearing the basket');
        process.exit(0);
      }
      const provider = getProvider(cmd.optsWithGlobals());
      await provider.clearBasket();
      console.log(`✅ Basket cleared`);
    } catch (error: any) {
      console.error('❌ Failed to clear basket:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'clear basket' }));
      process.exit(1);
    }
  });

// List providers, with the capability matrix.
//
// Rendered from the registry rather than written by hand, so it can never claim
// a capability a provider does not declare. Loads no provider code.
program
  .command('providers')
  .description('List providers with their countries and capabilities')
  .option('-c, --country <code>', 'Only providers serving this country (ISO 3166-1 alpha-2)')
  .option('--capability <name>', 'Only providers with this capability')
  .option('--all', 'Every provider, ignoring your country')
  .option('--json', 'Machine-readable output')
  .action((options) => {
    const country = options.all
      ? undefined
      : resolveCountry(options.country);

    const manifests = listProviders({
      country,
      capability: options.capability,
    });

    if (options.json) {
      // Drop `load`: a function is not serialisable and not useful here.
      console.log(
        JSON.stringify(
          manifests.map(({ load, ...rest }) => rest),
          null,
          2
        )
      );
      return;
    }

    if (manifests.length === 0) {
      console.log(
        `\nNo providers for ${country}. Countries covered: ${knownCountries().join(', ')}\n` +
          `Try --all, or --country <code>.\n`
      );
      return;
    }

    const CAPS: Capability[] = ['search', 'basket', 'slots', 'checkout', 'orders'];
    const width = Math.max(...manifests.map((m) => m.label.length), 8);

    console.log(
      country
        ? `\nProviders in ${country}   (--all for every country)\n`
        : '\nAll providers\n'
    );
    console.log(
      `  ${'PROVIDER'.padEnd(width)}  ${CAPS.map((c) => c.slice(0, 5).padEnd(6)).join('')} AUTH`
    );
    for (const m of manifests) {
      const marks = CAPS.map((c) =>
        (m.capabilities.includes(c) ? '  ✓   ' : '  -   ')
      ).join('');
      const tier = m.tier === 'community' ? ' (community)' : '';
      console.log(`  ${m.label.padEnd(width)}${marks} ${m.auth}${tier}`);
    }
    console.log(`\n  ${manifests.length} provider(s). Enrichment via Open Food Facts works everywhere.\n`);
  });

// ─────────────────────────────────────────────────────────
// Tesco-specific commands
// ─────────────────────────────────────────────────────────

// Tesco: API discovery
program
  .command('discover')
  .description('Tesco only — intercept network traffic to discover API endpoints')
  .action(async (options, cmd) => {
    const providerName = cmd.optsWithGlobals().provider;
    if (providerName !== 'tesco') {
      console.error('❌ The discover command is only available for --provider tesco');
      process.exit(1);
    }
    try {
      const { discover } = await import('./providers/tesco/discover');
      await discover();
    } catch (error: any) {
      console.error('❌ Discovery failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'discovery' }));
      process.exit(1);
    }
  });

// Tesco: import session from Chrome cookie export
program
  .command('import-session')
  .description('Tesco/Tesco HU/Ocado — import a browser session (cookie file, or a raw Cookie header)')
  .option('--file <path>', 'Cookies JSON (Chrome DevTools, Cookie-Editor, or Playwright storage_state)')
  .option('--header <cookie>', 'Raw Cookie request header, copied from DevTools → Network')
  .option('--stdin', 'Read a raw Cookie header from stdin (avoids it landing in shell history)')
  .action(async (options, cmd) => {
    const providerName = cmd.optsWithGlobals().provider;
    try {
      // --header/--stdin exist because exporting a cookie FILE is the worst step in
      // onboarding: extension UIs differ and some have no export at all. Copying a
      // request header out of DevTools is the one route that always works, and unlike
      // document.cookie it includes HttpOnly cookies — which is all of the ones that
      // matter here.
      if (options.header || options.stdin) {
        if (providerName !== 'tesco' && providerName !== 'tesco-hu') {
          console.error('❌ --header is currently available for --provider tesco and --provider tesco-hu.');
          process.exit(1);
        }
        const header = options.stdin
          ? require('fs').readFileSync(0, 'utf-8')
          : options.header;
        if (providerName === 'tesco-hu') {
          const { importSessionFromHeader, SESSION_FILE } = await import('./providers/tesco-hu/session');
          const session = importSessionFromHeader(header);
          console.log(`✅ Imported ${session.cookies.length} cookies from header — tesco-hu session saved to ${SESSION_FILE}, valid until ${session.expiresAt}`);
        } else {
          const { importSessionFromHeader } = await import('./providers/tesco/import-session');
          importSessionFromHeader(header);
        }
        return;
      }

      if (!options.file) {
        console.error('❌ Give me one of --file, --header or --stdin. See --help.');
        process.exit(1);
      }

      if (providerName === 'tesco') {
        const { importSession } = await import('./providers/tesco/import-session');
        importSession(options.file);
      } else if (providerName === 'ocado') {
        const { importSession } = await import('./providers/ocado');
        importSession(options.file);
      } else if (providerName === 'tesco-hu') {
        const { importSession, SESSION_FILE } = await import('./providers/tesco-hu/session');
        const session = importSession(options.file);
        console.log(`✅ Imported ${session.cookies.length} cookies — tesco-hu session saved to ${SESSION_FILE}, valid until ${session.expiresAt}`);
      } else {
        console.error('❌ The import-session command is only available for --provider tesco, tesco-hu or ocado');
        process.exit(1);
      }
    } catch (error: any) {
      console.error('❌ Session import failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'session import' }));
      process.exit(1);
    }
  });

// Kroger: find a store id (prices are per-store, so you need one)
program
  .command('kroger-stores')
  .description('Kroger only — find store IDs near a US ZIP code, for KROGER_LOCATION_ID')
  .requiredOption('--zip <code>', 'US ZIP code, e.g. 90210')
  .option('-l, --limit <number>', 'Max stores', '5')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const { KrogerProvider } = await import('./providers/kroger');
      const stores = await new KrogerProvider().findStores(
        options.zip,
        parsePositiveInt(options.limit, 'limit')
      );
      if (options.json) {
        console.log(JSON.stringify({ stores }, null, 2));
        return;
      }
      if (stores.length === 0) {
        console.log(`\nNo Kroger-family stores near ${options.zip}.\n`);
        return;
      }
      console.log(`\nKroger stores near ${options.zip}\n`);
      for (const s of stores) {
        console.log(`  ${s.locationId}  ${s.chain} — ${s.name}`);
        console.log(`  ${' '.repeat(s.locationId.length)}  ${s.address}\n`);
      }
      console.log(`Set one as KROGER_LOCATION_ID to get prices for that store.\n`);
    } catch (error: any) {
      console.error('❌ Kroger store lookup failed:', explain(error, { provider: 'kroger', action: 'find stores' }));
      process.exit(1);
    }
  });

// Tesco: staples management
program
  .command('staples')
  .description('Tesco only — view, update, or add your regular staples to basket')
  .option('--update', 'Refresh staples from order history')
  .option('--add', 'Add all staples to basket (skips items already present)')
  .option('--json', 'Output as JSON')
  .action(async (options, cmd) => {
    const providerName = cmd.optsWithGlobals().provider;
    if (providerName !== 'tesco') {
      console.error('❌ The staples command is only available for --provider tesco');
      process.exit(1);
    }
    try {
      const { updateStaples, loadStaples, printStaples, addStaplesToBasket } =
        await import('./providers/tesco/staples');

      const provider = getProvider(cmd.optsWithGlobals()) as TescoProvider;
      const api = provider.getAPI();

      let staples = loadStaples();

      if (options.update || staples.length === 0) {
        staples = await updateStaples(api);
      }

      if (options.add) {
        // Get current basket to skip already-added items
        const basket = await provider.getBasket();
        const alreadyAdded = new Set(basket.items.map(i => i.product_uid));
        await addStaplesToBasket(provider, staples, alreadyAdded);
        return;
      }

      printStaples(staples, options.json);

    } catch (error: any) {
      console.error('❌ Staples command failed:', explain(error, { provider: cmd?.optsWithGlobals?.().provider ?? program.opts().provider, action: 'staples command' }));
      process.exit(1);
    }
  });

program.parse();
