<div align="center">

# open&#8203;-supermarkets

### One command line for the world's supermarkets

**Search real products at real prices, build a basket, book a slot, check out —<br>across 15 providers in seven countries. Built for AI agents.**

<br>

[![npm](https://img.shields.io/npm/v/open-supermarkets?color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/open-supermarkets)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Countries](https://img.shields.io/badge/countries-7-2ea44f)](#what-works-where)
[![Providers](https://img.shields.io/badge/providers-15-2ea44f)](#what-works-where)
[![No account](https://img.shields.io/badge/4%20of%207%20countries-no%20user%20account-orange)](#what-works-where)
[![CI](https://github.com/abracadabra50/open-supermarkets/actions/workflows/ci.yml/badge.svg)](https://github.com/abracadabra50/open-supermarkets/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-23%20tools-6E56CF)](#three-ways-to-drive-it)
[![Stars](https://img.shields.io/github/stars/abracadabra50/open-supermarkets?style=flat&color=yellow)](https://github.com/abracadabra50/open-supermarkets/stargazers)

🇬🇧 &nbsp;🇮🇪 &nbsp;🇳🇱 &nbsp;🇧🇪 &nbsp;🇪🇸 &nbsp;🇺🇸 &nbsp;🇨🇦 &nbsp;&nbsp;·&nbsp;&nbsp; [**your country next?**](#we-want-your-supermarket)

</div>

---

```console
$ supermarket compare milk
  Ocado        Ocado British Semi Skimmed Milk 2 Pints   £1.20  ← best
  Sainsbury's  Sainsbury's British Semi Skimmed 2.27L    £1.75
  Tesco        Tesco British Semi Skimmed Milk 2.272L    £1.75

$ supermarket search leche --country ES
  Leche semidesnatada Hacendado    €5.04 / 6l

$ supermarket search melk --country NL
  Campina Halfvolle melk           €1.89 / 1,5 l
```

**Four of the seven countries need no user account.** Spain, the Netherlands and
Belgium answer anonymously. Ireland also needs no login, although Tesco Ireland
sends the public web API key used by its storefront and may need an environment
override if that key rotates.

---

## Why this exists

Supermarkets have no public API. So every meal planner, price tracker and shopping
agent reimplements the same brittle integration from scratch, for one country, and
abandons it six months later.

This is that layer, done once, in the open. Your agent decides *what* to buy. This
works out *where*, *how much*, and *how to actually order it*.

---

## Install

```bash
npm install -g open-supermarkets
supermarket providers
```

From source:

```bash
git clone https://github.com/abracadabra50/open-supermarkets.git
cd open-supermarkets && npm install && npm link
npx playwright install chromium   # only for browser-auth providers
```

The command is `supermarket`. If you used this when it was UK-only, `groc` still works
and prints a deprecation notice — it's going in v4, because the unrelated `groc` npm
package ships its own `groc` binary and the two can't share a PATH.

---

## What works where

Providers declare what they can do. Search needs no account almost anywhere; checkout
needs an account, an address and a card, so it exists for fewer.

| Provider | Country | Search | Stores | Basket | Slots | Checkout | Auth |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| Tesco | 🇬🇧 | ✓ | — | ✓ | ✓ | ✓ | browser session |
| Sainsbury's | 🇬🇧 | ✓ | — | ✓ | ✓ | ✓ | email + password |
| Ocado | 🇬🇧 | ✓ | — | ✓ | read-only | — | email + password |
| Tesco Ireland | 🇮🇪 | ✓ | — | — | — | — | public API key |
| Aldi Ireland | 🇮🇪 | ✓ | ✓ | — | — | — | **none** |
| Lidl Ireland | 🇮🇪 | ✓ | — | — | — | — | **none** |
| Mr Price Ireland | 🇮🇪 | ✓ | — | — | — | — | **none** |
| Dunnes Stores Ireland | 🇮🇪 | ✓ | ✓ | — | — | — | **none** |
| SuperValu Ireland | 🇮🇪 | ✓ | ✓ | — | — | — | **none** |
| Albert Heijn | 🇳🇱 | ✓ | — | — | — | — | **none** |
| Albert Heijn België | 🇧🇪 | ✓ | — | — | — | — | **none** |
| Mercadona | 🇪🇸 | ✓ | — | — | — | — | **none** |
| Kroger *+ Ralphs, Fred Meyer, King Soopers, Harris Teeter, QFC* | 🇺🇸 | ✓ | — | — | — | — | free API key |
| Instacart | 🇺🇸 🇨🇦 | ✓ | — | ✓ | — | via link | partner key |
| Instacart *(unofficial)* | 🇺🇸 🇨🇦 | ✓ | — | ✓ | — | — | browser session |

`supermarket providers` prints this live from the registry, so it can't drift from
reality the way a hand-maintained table does.

Aldi, Dunnes and SuperValu prices are store-scoped. Find a store, then pass its
retailer ID to search:

```bash
supermarket --provider aldi-ie stores --query Dublin --json
supermarket --provider aldi-ie --store-id D001 search milk --json
```

The HTTP API exposes the same flow through `GET /stores` and `store_id` on
`GET /search`. MCP clients use `grocery_stores` and `store_id`.

Ocado's slot *booking* and checkout are blocked by AWS WAF. Reading slots works;
committing to one doesn't. The manifest doesn't claim the capability — which is why
you see a dash rather than a footnote.

---

## Three ways to drive it

**It's a CLI first.** Everything else wraps that. Commands are the contract — they're
stable, scriptable, and work from anything that can shell out.

```bash
supermarket search "olive oil" --country ES --limit 5 --json
```

**As an MCP server**, for Claude, Cursor or anything speaking the protocol:

```json
{ "mcpServers": { "groceries": { "command": "supermarket-mcp" } } }
```

> *"Plan a week of high-protein dinners, no pork, no nuts, and price the shop at Tesco."*

| MCP tool | |
|---|---|
| `grocery_search` · `grocery_compare` | Find and compare products |
| **`grocery_search_batch`** · **`grocery_basket_add_batch`** | **Many at once — prefer these** |
| `grocery_stores` | Find a store before store-scoped search |
| `grocery_basket_*` | View, add, remove, update, clear |
| `grocery_slots` · `grocery_book_slot` | Delivery slots |
| `grocery_checkout` | Place the order — `dry_run` defaults to **true** |
| `grocery_favourites` · `ocado_regulars` · `tesco_staples` | Repeat-purchase lists |
| `grocery_orders` | Order history |

**As agent skills.** [`SKILL.md`](SKILL.md) is the top-level skill; [`skills/`](skills/)
holds per-provider ones with the quirks that matter — Tesco's cookie import, Ocado's
category paths, Sainsbury's favourites. Drop them into Claude Code, OpenClaw, or
anything that reads `SKILL.md`.

There's also `supermarket-api`, a plain HTTP server, for agents with network access but
no filesystem.

---

## Batch mode — built for how agents actually work

A week of meals is about thirty ingredients. One at a time that's thirty searches plus
thirty adds: sixty process starts, sixty MCP round trips, sixty tool results filling
the model's context. The agent spends its budget on plumbing instead of on deciding
what to cook.

```console
$ echo '["semi skimmed milk","free range eggs","chicken breast","broccoli"]' \
    | supermarket search --batch - --provider ocado --limit 2
```

```json
{
  "provider": "ocado",
  "results": [
    { "query": "semi skimmed milk",
      "products": [{ "id": "73f814b7", "name": "Ocado British Semi Skimmed Milk 2 Pints",
                     "price": 1.20, "currency": "GBP", "size": "1.136L",
                     "unit": "1.06/1.136L", "inStock": true }] }
  ]
}
```

Then pick, and add them all in one call:

```bash
supermarket add --batch picks.json     # [{"id":"73f814b7","qty":2}, ...]
```

Six queries take **1.7s in one invocation** rather than six. Input is forgiving — a
JSON array, an object with `queries`, or newline-delimited text from a pipe.

Output is deliberately **lean**: id, name, price, currency, size, unit price, stock.
No images, no descriptions, no ratings. Thirty queries by five candidates by a full
product record is a serious slice of a context window, and none of it helps a model
choose between two milks.

**Batch search returns candidates. It does not choose.** Picking a 650g pack for a
200g recipe is a judgement about your money and your fridge, and the model has context
the CLI never will — the rest of the plan, the budget, whether leftovers are fine. One
bad query returns an `error` on its own entry rather than sinking the batch. Adds run
sequentially, because baskets are mutable server-side state and concurrent writes race.

---

## Only pay for the country you're in

Providers are declared in a manifest; their code loads on demand. Shopping in the UK
never loads the Spanish provider, and never pays Playwright's startup cost for a
retailer you don't use.

```ts
import { list, createProvider } from 'open-supermarkets';

list({ country: 'ES', capability: 'search' });   // loads no provider code at all
const m = await createProvider('mercadona');     // loads exactly one
```

Country comes from `--country`, then `SUPERMARKET_COUNTRY`, then your system locale.

---

## Nutrition and allergens, everywhere

`--enrich` adds Nutri-Score, NOVA processing group, allergens and ingredients from
[Open Food Facts](https://openfoodfacts.org) — every provider, every country, no key.

```console
$ supermarket search "semi skimmed milk 2l" --provider tesco --enrich
  Tesco Semi Skimmed Milk 2L   £1.45
    Nutri-Score B · allergens: milk · matched by barcode
```

**It is deliberately conservative and will often tell you nothing.** That's the design.
Matching is by barcode where a provider exposes one, by name where it doesn't — and a
name match must clear a strict guard:

- A **variant marker** on one side and not the other is disqualifying. "Zero" versus
  regular is a different product however well the rest matches.
- Sharing only a **category word** isn't evidence. "Chocolate" matches everything
  chocolatey and means nothing.
- Only the **top candidate** is considered. Scoring the top five was tried and reverted
  — it immediately matched a Coca-Cola Zero query to a regular-Coke record.

The cost is real misses. A Nutella jar from a UK provider gets nothing, because Open
Food Facts returns an unrelated product at position one. That's the right trade: **a
miss shows nothing, a false positive shows the wrong allergens.**

**Kroger and Mercadona expose barcodes, so their matches are exact rather than guessed:**

```console
$ supermarket search nutella --provider kroger --enrich
  Nutella® Hazelnut Spread with Cocoa   $6.49 / 13 oz
    Nutri-Score E · NOVA 4 · allergens: milk, nuts, soybeans · matched by barcode
```

Kroger's `upc` field needed reconstructing first — it's the 11-digit product code
padded to 13 with the UPC-A check digit dropped, so it resolves to nothing as supplied.
One missing digit was the difference between exact allergen data and a name guess.

Never rely on it for an allergy. Read the packet.

---

## We want your supermarket

**This is the part we'd most like help with.** 15 providers, seven countries — and
there are a lot more countries. If you shop somewhere that isn't here, you are better
placed to add it than anyone else, because you can actually test it.

A search-only provider is **one file and one manifest entry**. Roughly an afternoon.

**1. Write it.** Only `name` and `search()` are required.

```ts
export class MySupermarketProvider {
  readonly name = 'mysupermarket';
  async search(query: string, opts?: SearchOptions): Promise<Product[]> { /* ... */ }
}
```

**2. Register it** in `src/providers/registry.ts`:

```ts
{
  id: 'mysupermarket',
  label: 'My Supermarket',
  country: 'DE',
  capabilities: ['search'],
  auth: 'none',
  tier: 'community',
  maintainer: 'your-github-handle',
  load: async () => (await import('./mysupermarket')).MySupermarketProvider,
}
```

**3. Open a PR.** [`src/providers/ah.ts`](src/providers/ah.ts) is the reference —
anonymous token, catalogue search, ~150 lines, no account required. A `skills/` entry
for anything non-obvious about your provider is welcome but not required.

**Read [`docs/providers/evaluated.md`](docs/providers/evaluated.md) first** so you don't
lose a weekend. It records what's already been probed and exactly why it failed: REWE
needs mTLS certificates extracted from its APK, Jumbo refuses the TLS handshake,
DoorDash and Woolworths serve bot challenges, and Loblaws returns 403. Tesco Ireland's
older client error is recorded as resolved. Rejections are dated — an old "no" is a reason to re-probe,
not to stop.

### The rules that stop this rotting

- **Every provider has a maintainer of record.** Keeping dozens of reverse-engineered
  integrations alive is not one person's job. No maintainer, provider goes red, then
  archived. A status, not a judgement.
- **`core` is maintained here and CI-tested. `community` is best-effort**, labelled as
  such in the CLI so nobody is surprised at checkout.
- **Declare only what you implement.** A provider claiming a `checkout` it has never run
  is worse than one claiming nothing.
- **Credit the protocol.** If you learned the endpoints from someone else's reverse
  engineering, put it in the manifest's `credit` field. We do.

---

## Honest caveats

**Most of these are unofficial integrations.** Retailers change their APIs without
notice and some deploy bot protection. A red provider is usually that, not your setup.

**Automated access may conflict with a retailer's terms of service.** This is built for
personal automation — your account, your shopping. Read the terms and make your own
call.

**Checkout previews by default.** `supermarket checkout` shows the order and places
nothing; spending real money needs `--confirm`, explicitly. The MCP tool defaults
`dry_run` to true. Three tests pin that, because a one-character regression is
somebody's shopping.

**Sessions expire.** Cookie-auth providers need re-importing periodically. When Tesco's
session dies, search says so — silently returning an empty list, as if the shelves were
bare, was a real bug and is now a loud error.

---

## Credits

Protocol knowledge — reimplemented, not copied — from:

- [gwillem/appie-go](https://github.com/gwillem/appie-go) — Albert Heijn (Go, MIT)
- [kleinjm/instacart_api](https://github.com/kleinjm/instacart_api) — Instacart web (Ruby, MIT)
- [CupOfOwls/kroger-api](https://github.com/CupOfOwls/kroger-api) — Kroger (Python, MIT)
- [Open Food Facts](https://openfoodfacts.org) — global product data (ODbL)

Open Food Facts is a nonprofit, and the enrichment layer is free because volunteers
scanned several million products. If this is useful to you,
[donate to them](https://donate.openfoodfacts.org).

MIT. Not affiliated with, endorsed by, or connected to any retailer named here.
