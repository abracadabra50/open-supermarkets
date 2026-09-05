<div align="center">

# open&#8203;-supermarkets

### The open-source grocery interface for humans and AI agents

**Search live products and prices, compare retailers, build baskets and check out safely<br>across nine providers in six countries.**

**CLI · HTTP API · MCP · Agent Skills**

<br>

[![npm](https://img.shields.io/npm/v/open-supermarkets?color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/open-supermarkets)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Countries](https://img.shields.io/badge/countries-6-2ea44f)](#what-works-where)
[![Providers](https://img.shields.io/badge/providers-9-2ea44f)](#what-works-where)
[![No credentials](https://img.shields.io/badge/3%20countries-no%20credentials-orange)](#what-works-where)
[![CI](https://github.com/abracadabra50/open-supermarkets/actions/workflows/ci.yml/badge.svg)](https://github.com/abracadabra50/open-supermarkets/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-22%20tools-6E56CF)](#connect-an-agent)
[![Stars](https://img.shields.io/github/stars/abracadabra50/open-supermarkets?style=flat&color=yellow)](https://github.com/abracadabra50/open-supermarkets/stargazers)

🇬🇧 &nbsp;🇳🇱 &nbsp;🇧🇪 &nbsp;🇪🇸 &nbsp;🇺🇸 &nbsp;🇨🇦 &nbsp;&nbsp;·&nbsp;&nbsp; [**your country next?**](#bring-your-supermarket)

</div>

---

> **The demo to build:** “Plan five high-protein family dinners under £60. No pork, no nuts. Compare Tesco, Sainsbury's and Ocado, choose sensible pack sizes, build the basket and show me before checkout.”
>
> A short end-to-end demo belongs here. If you build one with Open Supermarkets, open a PR and we'll feature it.

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

**Spain, the Netherlands and Belgium need no credentials at all.** No key, no account,
no signup. You can query a real supermarket catalogue immediately.

---

## Try it

```bash
npx open-supermarkets providers
npx open-supermarkets search "olive oil" --country ES --limit 5
```

Or install it globally:

```bash
npm install -g open-supermarkets
supermarket providers
```

The canonical command is `supermarket`; `open-supermarkets` is an npm-friendly alias.
The old `groc` alias remains temporarily for backwards compatibility and will disappear
in v4.

From source:

```bash
git clone https://github.com/abracadabra50/open-supermarkets.git
cd open-supermarkets && npm install && npm link
npx playwright install chromium   # only for browser-auth providers
```

---

## What it lets an agent do

A shopping agent should decide *what* makes sense for the person. Open Supermarkets
handles the ugly retail plumbing underneath it:

- search real supermarket catalogues and current prices;
- compare retailers without forcing every agent to build retailer integrations;
- build and mutate live baskets where the provider supports it;
- inspect delivery slots and order history;
- enrich products with nutrition and allergen data;
- preview checkout safely before any money is spent.

Supermarkets rarely expose public shopper APIs. Without a shared layer, every meal
planner, price tracker and shopping agent reimplements the same brittle integration
for one retailer and eventually abandons it. This is that layer, done once, in the open.

---

## Connect an agent

### MCP

For Claude Desktop, Cursor or anything speaking Model Context Protocol:

```json
{
  "mcpServers": {
    "groceries": {
      "command": "npx",
      "args": ["-y", "open-supermarkets", "mcp"]
    }
  }
}
```

If you install the package globally, use `supermarket-mcp` directly.

A useful first prompt:

> *Plan a week of high-protein dinners, no pork and no nuts. Price the shop at Tesco, show me the basket and do not place an order.*

The server exposes 22 tools, including batch primitives designed to stop agents burning
one tool call per ingredient:

| MCP tool | Purpose |
|---|---|
| `grocery_search` · `grocery_compare` | Find and compare products |
| **`grocery_search_batch`** · **`grocery_basket_add_batch`** | **Many at once — prefer these** |
| `grocery_basket_*` | View, add, remove, update, clear |
| `grocery_slots` · `grocery_book_slot` | Delivery slots |
| `grocery_checkout` | Preview/place an order; `dry_run` defaults to **true** |
| `grocery_favourites` · `ocado_regulars` · `tesco_staples` | Repeat-purchase lists |
| `grocery_orders` | Order history |

### Agent skills

[`SKILL.md`](SKILL.md) is the top-level skill. [`skills/`](skills/) contains provider
skills for the quirks that actually matter: Tesco cookie import, Ocado category paths,
Sainsbury's favourites and more. Drop them into Claude Code, OpenClaw or another harness
that reads `SKILL.md`.

### HTTP

`supermarket-api` exposes the same core capabilities over plain HTTP for agents that
have network access but cannot execute local commands.

### CLI

Everything ultimately rests on a scriptable CLI contract:

```bash
supermarket search "olive oil" --country ES --limit 5 --json
```

---

## What works where

Providers declare what they can actually do. Search needs no account almost everywhere;
checkout needs an account, address and payment method, so it exists for fewer.

| Provider | Country | Search | Basket | Slots | Checkout | Auth |
|---|---|:-:|:-:|:-:|:-:|---|
| Tesco | 🇬🇧 | ✓ | ✓ | ✓ | ✓ | browser session |
| Sainsbury's | 🇬🇧 | ✓ | ✓ | ✓ | ✓ | email + password |
| Ocado | 🇬🇧 | ✓ | ✓ | read-only | — | email + password |
| Albert Heijn | 🇳🇱 | ✓ | — | — | — | **none** |
| Albert Heijn België | 🇧🇪 | ✓ | — | — | — | **none** |
| Mercadona | 🇪🇸 | ✓ | — | — | — | **none** |
| Kroger *+ Ralphs, Fred Meyer, King Soopers, Harris Teeter, QFC* | 🇺🇸 | ✓ | — | — | — | free API key |
| Instacart | 🇺🇸 🇨🇦 | ✓ | ✓ | — | via link | partner key |
| Instacart *(unofficial)* | 🇺🇸 🇨🇦 | ✓ | ✓ | — | — | browser session |

`supermarket providers` prints this live from the registry. The manifest is the source
of truth rather than a hand-maintained marketing claim.

Ocado slot booking and checkout are blocked by AWS WAF. Reading slots works; committing
to one does not. The manifest therefore does not claim those capabilities.

---

## Built for how agents actually work

A week of meals can mean thirty ingredients. One at a time, that becomes thirty searches
plus thirty basket writes: sixty process starts, sixty MCP round trips and sixty tool
results filling the model's context.

```console
$ echo '["semi skimmed milk","free range eggs","chicken breast","broccoli"]' \
    | supermarket search --batch - --provider ocado --limit 2
```

```json
{
  "provider": "ocado",
  "results": [
    {
      "query": "semi skimmed milk",
      "products": [
        {
          "id": "73f814b7",
          "name": "Ocado British Semi Skimmed Milk 2 Pints",
          "price": 1.20,
          "currency": "GBP",
          "size": "1.136L",
          "unit": "1.06/1.136L",
          "inStock": true
        }
      ]
    }
  ]
}
```

Then let the model choose using the context it already has and add its picks together:

```bash
supermarket add --batch picks.json
```

Batch search returns candidates. **It deliberately does not decide what to buy.** The
model knows the meal plan, budget, dietary constraints and whether leftovers are useful;
the supermarket integration does not.

Provider code is also lazy-loaded. Shopping in the UK does not load Spanish provider
code or pay Playwright startup cost for a retailer you never use.

---

## Nutrition and allergens

`--enrich` adds Nutri-Score, NOVA processing group, allergens and ingredients using
[Open Food Facts](https://openfoodfacts.org) across every provider and country.

```console
$ supermarket search nutella --provider kroger --enrich
  Nutella® Hazelnut Spread with Cocoa   $6.49 / 13 oz
    Nutri-Score E · NOVA 4 · allergens: milk, nuts, soybeans · matched by barcode
```

Matching is intentionally conservative. Where a provider exposes a barcode, the lookup
can be exact. Where it does not, name matching must clear strict guards. A miss shows
nothing; a false positive can show the wrong allergen, which is much worse.

Never rely on it as medical or allergy advice. Check the product packaging.

---

## Bring your supermarket

This project gets more useful when people add the supermarket they can actually test.
A search-only provider can be one file plus one manifest entry.

Before starting, read [`docs/providers/evaluated.md`](docs/providers/evaluated.md). It
records providers already investigated, what worked, what failed and when. That avoids
every contributor rediscovering the same bot wall or dead endpoint.

The minimum provider shape is intentionally small:

```ts
export class MySupermarketProvider {
  readonly name = 'mysupermarket';
  async search(query: string, opts?: SearchOptions): Promise<Product[]> { /* ... */ }
}
```

Register it in `src/providers/registry.ts`, add tests that run without credentials, and
open a PR. [`src/providers/ah.ts`](src/providers/ah.ts) is a useful reference for a small
anonymous-search provider.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution contract.

### The rules that stop this rotting

- Every provider has a maintainer of record.
- `core` integrations are maintained here and CI-tested; `community` integrations are best-effort and labelled as such.
- Declare only capabilities that have actually been implemented and verified.
- Credit protocol research you learned from rather than quietly absorbing it.
- Never put retailer credentials, session cookies or payment data in issues, tests or commits.

---

## Honest caveats

**Most integrations are unofficial.** Retailers change APIs without notice and some
deploy bot protection. A red provider can mean the retailer changed, not your setup.

**Automated access may conflict with retailer terms.** This project is intended for
personal automation of your own shopping. Understand the terms that apply to you.

**Checkout previews by default.** `supermarket checkout` shows the order and places
nothing. Spending money requires `--confirm`; the MCP checkout tool defaults to
`dry_run: true`.

**Sessions expire.** Cookie-auth providers need re-importing periodically. Authentication
failures are surfaced explicitly rather than masquerading as empty search results.

For security-sensitive reports, read [`SECURITY.md`](SECURITY.md).

---

## Built with Open Supermarkets

Using this in an agent, meal planner, price tracker, Alexa workflow or something stranger?
Open a PR adding it here. Real implementations are far more useful than another invented
example.

---

## Credits

Protocol knowledge, reimplemented rather than copied, from:

- [gwillem/appie-go](https://github.com/gwillem/appie-go) — Albert Heijn (Go, MIT)
- [kleinjm/instacart_api](https://github.com/kleinjm/instacart_api) — Instacart web (Ruby, MIT)
- [CupOfOwls/kroger-api](https://github.com/CupOfOwls/kroger-api) — Kroger (Python, MIT)
- [Open Food Facts](https://openfoodfacts.org) — global product data (ODbL)

Open Food Facts is a nonprofit. If this project is useful to you, consider supporting
the volunteers maintaining that dataset.

MIT. Not affiliated with, endorsed by or connected to any retailer named here.
