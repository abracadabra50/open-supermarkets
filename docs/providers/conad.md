# Conad (Italy)

`conad` is a community integration maintained by **GianluDeveloper**. It serves
Italy (`IT`, `EUR`) through a visible SeleniumBase UC/CDP browser and a dedicated,
persistent Chrome profile. Python and SeleniumBase are optional: other providers
continue to work without them.

Supported: local catalogue search and product detail, ordinary fixed-pack
baskets, verified store context, and an incomplete shopping review. Delivery-slot
booking, order history and order placement are **not implemented or advertised**.

## Setup and authentication

See [runtime setup](conad-seleniumbase.md) for installation, display requirements
and MCP configuration. Then, from the repository:

```bash
export CONAD_PROFILE_DIR=/private/persistent/conad-profile
export CONAD_PYTHON=/path/to/venv/bin/python
export CONAD_BROWSER_EXECUTABLE=/path/to/chrome
npm run build
node dist/cli.js --provider conad login --manual
node dist/cli.js --provider conad status --json
node dist/cli.js --provider conad store --json
```

In the browser, select the local store and pickup/delivery service. Account login
is optional for a guest profile where the retailer permits it. An account-bound
profile must reauthenticate when its session expires; it must not silently become
a new guest basket. Use a separate profile for each account. The worker stores
only a private hash of the retailer account identifier to detect account changes.

`grocery_browser_login` opens or resumes human authentication without requiring
credentials in tool arguments. Optional-cookie banners are rejected on both
storefront and MyConad. **Mantieni la sessione attiva** is selected by default;
`CONAD_REMEMBER_SESSION=false` changes that default. A human can still change the
checkbox. The retailer controls the actual lifetime of the session.

`grocery_login` can fill credentials supplied by a host/secret manager. Credentials
are sent through private local IPC and the real login form, never a Python HTTP
client. MFA, challenges and profile completion remain human interactions. A click
or redirect alone is not proof of authentication. Provider-specific status reads
account and store state together. Logout must currently be completed with **Esci**
in MyConad; stopping the worker does not revoke the retailer session.

## Catalogue and basket

```bash
node dist/cli.js search "latte" --country IT --limit 5 --json
node dist/cli.js --provider conad basket --json
node dist/cli.js --provider conad add PRODUCT_ID --qty 1
node dist/cli.js --provider conad remove ITEM_ID
node dist/cli.js --provider conad checkout-preview
```

- Search uses real storefront pages. `limit` is 0–100; `offset` is a non-negative
  integer. Empty results require an explicit zero-result page. Missing markup,
  contradictory counts, repeated pages and browser/session failures are errors.
- `product_uid` is the complete operational retailer code. Composite codes such
  as `437403-1_N` must retain their suffix. A real EAN is separately validated as
  `gtin`; the retailer SKU must not be treated as a barcode.
- Regular `basePrice` is distinct from promotional/member prices. Missing prices
  and Conad's zero sentinel map to `null`. Stock remains `null` when no reliable
  local signal is available. Unknown stock does not mean unavailable.
- `Product.store` and `Basket.store` identify the selected store and fulfilment
  service; batch results preserve that context. These are not national prices.
- `addToBasket` is incremental. `updateBasketItem` is absolute; removal uses the
  current `item_id` from the basket. Quantity changes are limited to **10 units
  per call**, in addition to limits shown by the retailer. Larger changes require
  review/smaller explicit operations. Do not parallelize writes.
- Variable-weight products, multiple lines for the same SKU, order amendments and
  unrecognized cart modes are not automatically editable. Read operations preserve
  retailer totals, including delivery charges already included in them.

Conad's compact `window.cart.entries` contains boolean `updatedEntry` and
`updatedQuantity` flags. They are **not** product data or quantities. Complete
lines come from the cart cards' `data-product`, including `entries[].qty`,
`entryNumber` and `totalPrice.value`. The adapter validates both representations
against each other. Explicit `outOfStock: true` marks a line unavailable; its zero
placeholder price is unknown, not a free product.

Before a write the worker checks the basket snapshot, account and store; after
one UI click it waits for UI acknowledgement and reads the server-rendered basket
again. An unexpected change or timeout is never automatically replayed. Read the
basket before deciding what to do after an uncertain write; it may have applied.

## MCP and HTTP

| Purpose | MCP tool |
|---|---|
| Human authentication/resume | `grocery_browser_login` |
| Live account/store state | `grocery_status` with `provider`, `grocery_store` |
| Product candidates | `grocery_search`, `grocery_search_batch` |
| Basket read/write | `grocery_basket_view`, `grocery_basket_add`, `grocery_basket_add_batch`, `grocery_basket_update`, `grocery_basket_remove`, `grocery_basket_clear` |
| Incomplete shopping review | `grocery_checkout_preview` |

For removal use `item_id`; the legacy MCP `product_id` argument remains an alias
for existing providers, but Conad still expects the basket row's operational ID.

The loopback HTTP API exposes the same provider through `/search`, `/basket`,
`/add`, `/update`, `/remove`, `/store`, and `/checkout-preview`. Use its API token
when operating authenticated profiles. The browser worker itself exposes no HTTP
service. Automatic store discovery/selection is intentionally absent: select the
store in the retailer browser, then verify its context.

## Shopping review and future checkout

The review captures basket, charges and account binding in **one worker operation**.
It returns an observation time, review ID/hash, known/unknown costs and blockers.
It does not reserve a price or delivery slot and provides no purchase authorization.
`can_place_order` is always false; the `checkout` capability is absent.

[Shopping procedures](../procedures/conad-shopping-mcp.md) specify the future
approval, idempotency and reconciliation contract. Final checkout/payment/slot
validation is still required before implementing any order-placement tool.

## Verification and limitations

Live research on **2026-11-14**, Italy, one account-selected home-delivery store:

- human SeleniumBase login and profile reuse across browser restarts;
- store-scoped search and detail, including composite local SKUs;
- one fixed-pack item added, changed to two, removed, with the original basket
  quantities and retailer total restored;
- library, CLI, HTTP and MCP search/read/review routes;
- refusal of order placement before browser work.

The hardening tests cover profile locking/binding, private IPC, absolute deadlines,
uncertain writes, malformed data, snapshot consistency, cleanup and packaging.
The default suite uses synthetic data without SeleniumBase, Chrome or credentials.
Live retailer behaviour remains a separate, opt-in check. No order was placed.

```bash
npm run typecheck
npm run build
npm test
CONAD_LIVE_LOCAL=true npm run test:conad:live
```

Conad can change markup, sessions or protection rules without notice. This is an
unofficial community adapter, not an unattended checkout guarantee.
