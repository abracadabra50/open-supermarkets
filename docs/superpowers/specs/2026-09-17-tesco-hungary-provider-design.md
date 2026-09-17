# Tesco Hungary provider — design

Date: 2026-09-17
Status: approved for implementation
Maintainer: benedek

## Goal

Make the Hungarian Tesco online shop (https://bevasarlas.tesco.hu) available through
Open Supermarkets, so that agents can search the Hungarian catalogue today and, once a
browser session has been imported and verified, manage a basket.

## What was established live (2026-09-17)

- bevasarlas.tesco.hu is the same Tesco micro-frontend platform as www.tesco.com
  (`mfe-plp`, `mfe-basket`, `mfe-orchestrator`, ...). Its page config exposes
  `mangoUrl: https://xapi.tesco.com/`, `mangoApiKey` equal to the UK public key,
  `region: hu`, `language: hu-HU`, `currency: HUF`.
- The storefront is behind Akamai and returns `403 Access Denied` to any non-browser
  client. The adapter never needs it.
- `POST https://xapi.tesco.com/` accepts plain HTTP clients when sent
  `x-apikey`, `region: HU`, `language: hu-HU`, `accept-language: hu-HU`. These
  operations were confirmed anonymously:
  - `product(tpnc: "205406742") { id title price { actual unitPrice unitOfMeasure } ... }`
    → "Banán lédig", 126 HUF, 699 HUF/kg. The same id with `region: UK` is
    `product-not-found`, so the region header selects the catalogue.
  - `search(query: "tej", page: 1, count: 5, sortBy: "relevance") { info { total page count pageSize } results { node { ... on ProductType { ... } } } }`
    → 211 results.
  - `category(facet: <id>, page, sortBy, count)` with the same result shape.
  - `basket { ... }` → GraphQL error `Unauthorized` (HTTP status 401 in extensions).
- Product fields available on `ProductType`: `id tpnb tpnc gtin title status isForSale
  defaultImageUrl bulkBuyLimit averageWeight productType superDepartmentName
  departmentName aisleName shelfName price { actual unitPrice unitOfMeasure }
  promotions { ... } reviews { stats { noOfReviews overallRating } }`.
  The UK fields `isAvailable`, `displayPrice` and `unitPrice` do **not** exist here.
- Introspection is disabled.
- Operations present in the Hungarian bundles: `GetBasket`, `UpdateBasket($items:
  [BasketLineItemInputType], $orderId: ID)`, `BulkAddToBasket`, `Taxonomy`,
  `Fulfilment`, `GetProfile`. Basket operations therefore match the UK provider.
- Login is at `https://www.tesco.hu/account/login/hu-HU`. The orchestrator attaches an
  `authorization` header when the server-rendered config carries one; whether a raw
  Cookie header is enough for xapi, as it is for the UK, is unverified.

## Approach

A self-contained provider under `src/providers/tesco-hu/`. It shares no code with the
UK Tesco provider: that provider is core, CI-tested, cannot be verified without a UK
account, and its auth module imports Playwright at load time. Region, language,
currency and origin live in one config object so a Czech or Slovak entry can be added
later as a manifest line without claiming it now.

## Components

### `src/providers/tesco-hu/api.ts` — GraphQL client

- axios instance for `https://xapi.tesco.com/`, headers `x-apikey`, `region: HU`,
  `language: hu-HU`, `accept-language: hu-HU`, `content-type`, `accept`, browser
  `User-Agent`, `Origin`/`Referer` of bevasarlas.tesco.hu.
- `setAuthCookies(cookieString)` sets the `Cookie` header, as the UK client does.
- `gql(operationName, query, variables)` sends a one-element batch array and unwraps
  the first result. GraphQL `errors` are thrown as `Error` with the operation name. An
  `Unauthorized` error, or an `extensions.http.status` of 401/403, is rethrown as a
  session error whose message names `supermarket --provider tesco-hu import-session`.
- Operations: `search(query, page, count)`, `getProduct(tpnc)`, `getCategories()`
  (`Taxonomy`), `getBasket()` (`GetBasket`), `updateBasket(tpnc, quantity, orderId)`
  (`UpdateBasket`, quantity 0 removes).

### `src/providers/tesco-hu/session.ts` — cookie session store

- File `~/.tesco-hu/session.json`, mode 0600, shape `{ cookies, expiresAt, lastLogin }`
  like the UK store, but a separate file so UK and HU sessions never overwrite each
  other.
- `importSessionFromHeader(header)`: parses a raw `Cookie:` request header (tolerates
  the header name and quotes, splits on the first `=` only).
- `importSession(filePath)`: accepts a Chrome DevTools / Cookie-Editor / Playwright
  cookie JSON export.
- `inferSessionExpiry(cookies)`: earliest expiry among auth-looking cookies, fallback
  12 hours.
- `loadSession`, `saveSession`, `clearSession`, `getSessionInfo`, `getCookieString`.

### `src/providers/tesco-hu/index.ts` — `TescoHuProvider`

- `name = 'tesco-hu'`; loads the saved session in the constructor if present.
- `search(query, { limit, offset })`: `count = limit ?? 24`, `page = floor(offset /
  count) + 1`. Returns normalised products. Backend errors propagate.
- `getProduct(id)`, `getCategories()`.
- `isAuthenticated()`: true when `getBasket()` succeeds.
- `logout()`: clears the session file.
- Basket: `getBasket`, `addToBasket`, `updateBasketItem`, `removeFromBasket`,
  `clearBasket`, mirroring the UK provider (resolve item id or product id against the
  live basket; `UpdateBasket` with the basket `id` as `orderId`).
- No `login()`: scripted browser login is out of scope; the session comes from
  `import-session`.

### Product normalisation

| Product field | Source |
|---|---|
| `product_uid` | `id` (falls back to `tpnc`) |
| `name` | `title` |
| `retail_price.price` | `price.actual` (integer HUF) |
| `unit_price` | `{ price: price.unitPrice, measure: price.unitOfMeasure }` when both present |
| `in_stock` | `status === 'AvailableForSale'` when `status` is a string; otherwise `isForSale === true`. The interface has no "unknown", so an absent field reads as not in stock rather than as available |
| `image_url` | `defaultImageUrl` |
| `rating`, `review_count` | `reviews.stats.overallRating`, `reviews.stats.noOfReviews` |
| `currency` | `'HUF'` |
| `size` | not set; the title already carries pack size in Hungarian |
| `description` | `departmentName / aisleName` when present |

Basket items: `item_id = item.id`, `product_uid = item.product.id`, `name =
item.product.title`, `quantity`, `unit_price = item.product.price.actual`,
`total_price = item.cost` when present, else `unit_price * quantity`.

### Registration and plumbing

- `src/providers/registry.ts`: new `// ── Hungary` section, id `tesco-hu`, label
  `Tesco Magyarország`, country `HU`, `capabilities: ['search']`, `auth:
  'session-cookie'`, `tier: 'community'`, `maintainer: 'benedek'`, `credit` noting the
  shared xapi backend documented by the UK provider.
- `src/providers/index.ts`: `ProviderFactory.create` case for `tesco-hu`.
- `src/mcp-server.ts`: add `tesco-hu` to `PROVIDERS` and `SESSION_PATHS`.
- `src/cli.ts`: `status` shows session info for `tesco-hu`; `import-session` accepts
  `--file`, `--header` and `--stdin` for `tesco-hu`.
- `src/errors.ts`: the import-session hint also fires for `tesco-hu`.
- `src/format.ts`: `HUF` symbol `Ft`; `money()` renders zero-decimal currencies as
  `126 Ft` (amount, space, symbol) instead of `Ft126.00`.

### Capability promotion rule

`basket` is added to the manifest only after a live round-trip with an imported
session: `getBasket` succeeds, `addToBasket` of a known product changes the basket,
`removeFromBasket` restores it. If xapi rejects the Cookie header, the follow-up is a
discovery step in a signed-in browser to find how the `authorization` header is
derived. Until then the basket methods exist but the manifest does not claim them, and
`assertCapability` blocks them at the CLI/MCP boundary.

## Error handling

- Anonymous search or product errors: throw with the GraphQL message. Never return
  `[]` for a failed call.
- 401/403 or `Unauthorized`: throw the session error with the import command.
- Missing session file on a basket call: same session error, raised before the network
  call.

## Testing

Offline, run by `npm test`:

- `test/tesco-hu.test.ts`: normalisation of a search result and a product fixture
  (values copied from live responses, ids kept real since they are public catalogue
  data), paging arithmetic, cookie-header parsing including values containing `=`,
  session expiry inference, and the session error for an `Unauthorized` GraphQL
  response.
- `test/lazy-loading.test.ts`: `list({ country: 'HU' })` is `['tesco-hu']`; the parity
  loop covers the new factory case automatically.

Live, documented in the PR and in `skills/tesco-hu.md`:

```bash
supermarket search tej --provider tesco-hu --limit 5
supermarket search "Banán lédig" --provider tesco-hu --json   # expect id 205406742
supermarket categories --provider tesco-hu
supermarket status --provider tesco-hu
```

## Documentation

- `skills/tesco-hu.md`: setup, cookie import from Chrome DevTools, commands, MCP usage,
  API notes, limitations.
- `README.md`: provider table row, country flag and counts, SKILL.md description.
- `docs/providers/evaluated.md`: entry recording that Tesco Hungary is built on the
  shared xapi, and that Czechia (nakup.itesco.cz) and Slovakia
  (potravinydomov.itesco.sk) very likely work with a region switch but are unverified.

## Out of scope

Delivery slots, checkout, order history, scripted browser login, Czech and Slovak
shops, Open Food Facts matching quality for Hungarian names, and hosting the MCP
server so the Claude iPhone app can reach it.
