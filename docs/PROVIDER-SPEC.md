# Provider Specification

This document defines the behavioural contract for Open Supermarkets providers.

A provider is an adapter from a retailer-specific protocol to a small, truthful common interface. The common interface is more important than making every retailer look artificially identical.

## 1. Manifest

Every provider must have one entry in `src/providers/registry.ts`.

Required semantics:

- `id`: stable lowercase identifier. Country suffixes are appropriate when the same brand has materially different regional backends, for example `tesco-hu`.
- `label`: customer-facing retailer name.
- `country`: ISO 3166-1 alpha-2 primary market.
- `countries`: additional markets only when the same integration genuinely serves them.
- `capabilities`: operations implemented and verified by this provider.
- `auth`: the minimum authentication/session model required by the supported capability set.
- `tier`: `core` or `community`.
- `maintainer`: required in practice for community integrations.
- `credit`: protocol/documentation attribution where appropriate.
- `load`: lazy dynamic import of the provider implementation.

The registry is the source of truth. Do not maintain a second hand-written provider list in CLI, HTTP or MCP code when the information can be derived from the manifest.

## 2. Capabilities

Capabilities are promises, not marketing labels.

Current capability meanings:

- `search`: product catalogue search and product lookup.
- `basket`: read and mutate a basket.
- `slots`: read delivery-slot availability and, where implemented, select/book a slot.
- `checkout`: progress to or place an order under the project's explicit confirmation boundary.
- `orders`: read order history.

A future shared capability such as store discovery must be introduced as a generic contract first, with tests, before provider-specific implementations depend on it.

A provider must not declare a capability because the upstream retailer appears to expose a related endpoint. The Open Supermarkets method must be implemented and verified.

Consumers must check the manifest capability before calling an optional provider method.

## 3. Product contract

A search result must describe what the retailer actually exposed.

### Required fields

- `product_uid`: stable retailer-specific identifier suitable for that provider's operations where possible.
- `name`: customer-visible product name.
- `retail_price.price`: valid regular retail price for the represented shopping context.
- `in_stock`: availability according to the shared type's semantics.
- `provider`: provider ID.

Non-GBP providers must set `currency` using ISO 4217.

### Price

Never use `0` to mean "price unavailable".

If no valid regular retail price can be established, omit/drop the product or surface a protocol error according to the upstream response. Do not silently convert missing or malformed price data into a free item.

Loyalty/member pricing must not replace regular retail pricing unless the shared contract explicitly represents the distinction. If both are later supported, they need separate fields with explicit semantics.

Store-scoped pricing must not be represented as national pricing. The provider must either require/select the appropriate store context or expose the limitation.

### Availability

Availability has three logical states even if the current public type is narrower:

1. explicitly available;
2. explicitly unavailable;
3. unknown / not supplied reliably.

A provider must not convert state 3 into state 2.

If the public type cannot represent the upstream truth, change the shared contract deliberately and migrate all consumers that branch on it.

### Identity

`product_uid` is operational retailer identity.

Cross-retailer identifiers such as GTIN/EAN/UPC belong in a separate field. They must be normalised and check-digit validated before being advertised as globally comparable identifiers.

Do not treat arbitrary numeric retailer SKUs as GTINs.

### Optional product fields

Only populate optional fields when evidence exists in the retailer payload:

- `description`
- `unit_price`
- `image_url`
- `rating`
- `review_count`
- `size`
- future global identity fields

Do not derive authoritative-looking values from unrelated fields merely to fill the schema.

## 4. Search semantics

`search(query, options)` must:

- reject blank/whitespace-only queries before network work;
- honour `limit` within upstream and project bounds;
- honour `offset` where supported, or clearly reject unsupported pagination;
- return `[]` only for a legitimate empty catalogue result;
- throw on upstream HTTP failures, malformed protocol responses and blocked sessions;
- avoid returning partially fabricated products when all upstream rows are malformed.

Pagination must terminate safely. Guard against repeated pages, overlapping pages, contradictory totals and upstream loops.

## 5. Basket semantics

Basket mutations must use the retailer's actual identifier and quantity model.

Document whether quantity is:

- absolute;
- incremental;
- remove-on-zero;
- scoped by line-item ID rather than product ID.

Do not infer basket success solely from a 2xx status if the upstream response exposes a stronger confirmation signal.

Read operations should preserve retailer totals rather than recomputing them when promotions make local arithmetic unreliable.

Unknown line-item prices must not be silently represented as genuine zero-cost items. If the current `BasketItem` contract cannot express that truth, propose a shared contract change.

## 6. Authentication and sessions

Use the least powerful truthful auth model.

- `none`: no token/session needed.
- `anonymous`: retailer-issued anonymous/guest session.
- `api-key`: public/official developer key.
- `oauth`: official OAuth flow.
- `credentials`: scriptable account login.
- `session-cookie`: browser-derived session or equivalent.

Do not require a stored login merely because another provider does. Routing should follow manifest metadata and capability requirements, not provider-name exception lists.

Never commit secrets or production session material.

## 7. Browser-backed providers

Browser automation is acceptable when it establishes a legitimate storefront session that cold HTTP cannot reproduce.

Requirements:

- no hard-coded cookies or transient session headers;
- deterministic cleanup of page, context and browser;
- cleanup on both success and failure;
- explicit timeout bounds;
- tests for cleanup paths;
- clear errors for WAF/Cloudflare/bot blocking;
- prefer JSON/network interfaces from the established browser context over brittle rendered-DOM scraping.

Avoid stealth/anti-detection additions unless there is a separately reviewed project decision to support them.

## 8. Error semantics

Callers must be able to distinguish:

- invalid local input;
- unknown provider;
- unsupported capability;
- unauthenticated session;
- upstream HTTP failure;
- malformed upstream protocol;
- anti-bot/WAF block;
- legitimate empty result.

Never translate an upstream failure into an empty successful result.

Error snippets must redact tokens, cookies, authorisation headers and other credentials.

## 9. Interface integration

A provider contribution is not complete merely because its class works in isolation.

For each interface that advertises the capability, verify routing through:

- library/factory or registry API;
- CLI;
- HTTP API;
- MCP.

Provider lists, auth handling and capability checks should be registry-driven.

Search-only providers must not accidentally become eligible for basket/checkout tools. Anonymous providers must not be blocked by a generic stored-login requirement.

## 10. Tests

Provider tests must run offline by default.

Minimum useful coverage:

- manifest registration and lazy loading;
- normal mapping;
- price/currency handling;
- availability semantics;
- empty result;
- malformed top-level response;
- malformed product rows;
- upstream HTTP error;
- query validation;
- limit/pagination behaviour;
- auth/session assumptions;
- capability routing;
- cleanup when browser resources are used.

Fixtures must contain synthetic or safely reduced data and no private customer information.

A test file that is not invoked by `npm test` does not count as CI coverage.

## 11. Live verification

Live verification complements deterministic tests.

Record:

- date;
- retailer market/country;
- store or fulfilment context if relevant;
- operations exercised;
- public interfaces exercised;
- expected limitations;
- whether anti-bot/session behaviour was observed.

Do not include raw credentials, private headers, customer addresses, payment data or private order history.

## 12. PR shape

Default to one provider per PR.

If a provider requires a new generic capability or routing abstraction:

1. land the shared contract and infrastructure;
2. add tests for the generic behaviour;
3. add individual provider implementations in subsequent PRs.

This keeps retailer breakage independently revertible and makes ownership clear.
