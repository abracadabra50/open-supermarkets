# Providers evaluated and not built

Before spending a weekend on a supermarket, check here. Each entry says what was
probed, what came back, and what would have to change for it to become viable.

Rejections are dated, because bot defences and APIs both move. A "no" from a year ago
is a reason to re-probe, not a reason to stop.

| Provider | Country | Verdict | Blocker |
|---|---|---|---|
| REWE | DE | blocked | mTLS client certificates extracted from the APK |
| Jumbo | NL | blocked | Akamai; connection refused outright |
| Picnic | NL | unknown | endpoint not found; needs real discovery |
| DoorDash | US | not worth it | active Cloudflare challenge; official API is merchant-side |
| Woolworths | AU | blocked | HTTP 403 + HTML body on the product search API |
| Loblaws / PC Express | CA | blocked | HTTP 403 "Access Denied" on api.pcexpress.ca |
| Target | US | blocked | RedSky now answers 403 + CAPTCHA challenge |
| Walmart | US | blocked | consumer GraphQL returns HTTP 418 (bot detection) |
| ~~Tesco Ireland~~ | IE | **BUILT** | separate Ireland provider with current public client evidence |
| ~~Mercadona~~ | ES | **BUILT** | Algolia key found in the frontend bundle — see src/providers/mercadona.ts |

---

## REWE (Germany) — blocked, 2026-08-03

Looked like the best target on paper: [ByteSizedMarius/rewerse-engineering](https://github.com/ByteSizedMarius/rewerse-engineering)
is 78★ and actively maintained. Star count and commit recency measure *effort*, not
*accessibility*. From its own README:

> The certificates required for talking to the rewe api are not included in this
> repository. You need to extract them from the APK.

The API is `mobile-api.rewe.de` behind **mutual TLS**. The other headers are easy —
`rdfa` is a generated UUID, plus `correlation-id`, `rd-postcode`, `ruleversion` and a
REWE-Mobile-Client UA. The client certificate is the wall, and it is neither
redistributable nor stable across app releases.

**What would change this:** a contributor willing to extract certs themselves and
keep them current, with a documented, legally clean extraction path. Not something
this repo can ship.

## Jumbo (Netherlands) — blocked, 2026-08-03

`mobileapi.jumbo.com` resolves (Akamai, `95.101.253.189`) but the connection is
refused before HTTP — `curl` returns 000, so it is a TLS-layer rejection rather than
a status code. Likely certificate pinning or TLS fingerprinting.

**What would change this:** evidence of a client that connects successfully, to
compare handshakes against.

## Picnic (Netherlands) — unknown, 2026-08-03

Guessed `storefront-prod.nl.picnicinternational.com/api/15/search`, got a clean
`NOT_FOUND` JSON body — the host is right and answering, the path or API version is
wrong. Only prior art found was a 1★ Perl library, too thin to mine.

**What would change this:** proper endpoint discovery from a current app build. This
is the most likely of the three to turn out viable; it was deprioritised, not ruled
out.

## DoorDash (US) — not worth it, 2026-08-03

Three problems at once, any one of which would be enough:

**Active bot challenge.** `www.doordash.com` returns `cf-mitigated: challenge` with
`server: cloudflare`. Both `www.doordash.com/graphql` and
`consumer-mobile-bff.doordash.com/graphql` return 403. That is an interactive
challenge, not a passive rule — harder than the AWS WAF that already defeats Ocado's
checkout.

**The official API points the wrong way.** The [Marketplace and Item Management
APIs](https://developer.doordash.com/en-US/api/marketplace_v2/) exist so *merchants
can publish their catalogue into DoorDash* — add items, manage inventory and pricing.
There is no sanctioned consumer-side product search or cart. Drive is for requesting
deliveries, not for shopping.

**No community protocol knowledge.** Every `doordash api` repo is DoorDash's own
merchant sample code (3-6★, 2-3 years stale). The scrapers are abandoned 0-2★
projects. Nothing like the Instacart or Albert Heijn work exists to build on.

**What would change this:** DoorDash shipping a consumer-facing API. Until then,
Instacart covers the US with both a sanctioned path and a documented unofficial one.

---

## The pattern worth internalising

Albert Heijn is the exception, not the template. It hands an anonymous bearer token to
anyone who asks, which is why that provider is ~150 lines and needs no account.

Most chains defend the catalogue about as hard as the checkout. So when picking a
target, the useful signals are, in order:

1. **Does an anonymous or open catalogue endpoint exist?** This decides everything.
2. **Is there an official API pointing at shoppers** rather than at merchants?
3. **Is there recent reverse-engineering work** — and does it require anything
   non-redistributable, like certificates?
4. Star counts on a reverse-engineering repo measure how hard the problem was, not
   how easy it will be for you.

---

## Instacart (US/CA) — unofficial path, partially verified 2026-08-03

Not a rejection. Recorded here because the probing produced facts worth keeping.

**The endpoint is open.** `www.instacart.com` is plain nginx, HTTP 200, no Cloudflare
challenge. Compare DoorDash above.

**The persisted-query hashes are current.** Sent
`SearchCrossRetailerGroupResults` with the hash captured from
[kleinjm/instacart_api](https://github.com/kleinjm/instacart_api) and the server
resolved it, then complained about missing variables. A stale hash returns
`PersistedQueryNotSupported` instead, so this is a genuine liveness check that costs
one unauthenticated request. **Re-run it before debugging anything else.**

**Search is anonymous; item detail is not.**

| Operation | Anonymous | Returns |
|---|---|---|
| `SearchCrossRetailerGroupResults` | ✓ | `results[].itemIds` — 20 real ids |
| `Items` | ✗ `Not Authenticated` | names, prices |

**Required variables**, discovered by letting the server name each missing one in
turn: `query`, `zoneId`, `postalCode`, `shopIds` (array), `shopId` (singular, required
*as well as* the array), `first`, `searchSource`. Omitting any fails validation before
the query runs.

**Getting real ids.** They are embedded, URL-encoded, in any storefront page:

```bash
curl -s https://www.instacart.com/store/costco/storefront \
  | python3 -c "import sys,urllib.parse,re;s=urllib.parse.unquote(urllib.parse.unquote(sys.stdin.read()));
print({k:re.findall(chr(34)+k+chr(34)+r'\s*:\s*\"?([0-9]+)\"?',s)[:1] for k in ('zoneId','shopId','postalCode')})"
```

At time of writing Costco SF returned `zoneId=1`, `shopId=12`, `retailerId=5`,
`postalCode=94105`. They are per-store and per-area — use one that delivers to you.

---

## Probed 2026-08-09, while looking for a fourth country

**Woolworths (AU)** — `/apis/ui/Search/products` returns HTTP 403 with an HTML body.
Bot-protected, same shape as DoorDash. A new continent would have been the strongest
possible addition; it is not reachable.

**Loblaws / PC Express (CA)** — `api.pcexpress.ca/product-facade/v4/products/search`
returns HTTP 403 "Access Denied" (Akamai-style HTML). Canada is currently covered only
by Instacart, which is itself gated.

**Tesco Ireland (IE)** — the 2026-08-09 probe correctly showed that Ireland was not a
header switch on the GB provider. That blocker is now resolved by the separate
`tesco-ie` provider. It uses the current public Ireland client evidence, keeps Irish
product identity separate, and declares search only. A rejected or rotated public key
still fails with an explicit action instead of falling back to an unsafe transport.

### Mercadona (ES) — the one genuinely worth picking up

**The API is open.** No auth, no token, no bot challenge:

```
GET /api/categories/          → 200, paginated category tree
GET /api/products/{id}/       → 200, full product
```

A product carries `display_name`, `brand`, `ean`, `categories`, and
`price_instructions.unit_price`. Verified live: *Aceite de oliva 0,4º Hacendado*,
EAN `8402001027475`, €3.80.

**The `ean` is the barcode**, which matters more than it sounds — it makes Open Food
Facts an exact lookup rather than the fuzzy name match every provider except Kroger is
stuck with. Allergen data from Mercadona would be trustworthy.

**What blocks it: there is no text search endpoint.** `/api/search/` and
`/api/products/?query=` both 404. Mercadona's storefront search is Algolia-backed, and
the app id and search key are in a frontend JS bundle rather than the page HTML. Search
is the one required capability in `GroceryProvider`, so this cannot ship until someone
extracts those keys — or builds search by walking the category tree, which would be
slow and bad.

**If you want to add Spain, this is the task**: find the Algolia credentials in the
bundle, confirm they are the public search-only key rather than an admin key, and wire
`search()` to it. Everything else is already open.

## The big US chains, probed 2026-08-09

**Target** — `redsky.target.com` was for years the most open retail API in the US, with
a public key sitting in the frontend. It now answers **HTTP 403 with a CAPTCHA
redirect** (`captchaRelativeURL`). Whatever was true in the scraping tutorials is no
longer true.

**Walmart** — `walmart.com` serves 200, but the consumer GraphQL endpoint at
`/orchestra/home/graphql` returns **HTTP 418**. That is not a joke status here; it is
the documented bot-detection response used by their edge protection.

**Loblaws (CA)** — HTTP 403 "Access Denied" on `api.pcexpress.ca`.

All three follow the DoorDash pattern rather than the Kroger one: an official API
exists but faces *sellers and partners*, and the shopper-facing surface is defended.
Kroger remains the outlier — the only large US grocer with a documented, self-serve,
shopper-facing product API.

**If you want more US coverage, Kroger's banner family is the leverage**, not a new
chain: Ralphs, Fred Meyer, King Soopers, Harris Teeter, Smith's, QFC and Food4Less all
sit behind the credentials you already have.
