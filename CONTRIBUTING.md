# Contributing to Open Supermarkets

Open Supermarkets is most useful when people contribute the retailers they can actually test.

The goal is not to collect as many provider names as possible. The goal is a trustworthy interface that humans and agents can rely on without invented capabilities, silent fallbacks, or misleading data.

Before implementing a provider, read:

- `docs/PROVIDER-SPEC.md` for the provider contract;
- `docs/providers/evaluated.md` before probing a new retailer;
- the pull request template before starting a large change.

## Good contributions

- a new supermarket provider you can verify against the live retailer;
- fixes for a provider that changed upstream;
- tests for regional catalogue, pricing or authentication behaviour;
- improvements to the CLI, HTTP, MCP or skill interfaces;
- examples of real projects built on Open Supermarkets;
- documentation that removes a genuine setup or debugging trap.

## Scope rules

Keep changes independently reviewable.

For provider work, the default is **one provider per PR**. Shared infrastructure should normally land in a separate PR before the providers that depend on it.

Do not combine several of these in one PR unless they are inseparable:

- multiple retailer integrations;
- new provider capabilities or public types;
- CLI routing changes;
- HTTP API changes;
- MCP architecture changes;
- build or release changes;
- broad documentation rewrites.

Large PRs are not rejected because line count is aesthetically offensive. They are split because retailer integrations fail independently and need to be reviewable, revertible and maintainable independently.

If a provider requires a new shared capability such as store selection, introduce and test the generic capability first, then add providers in focused follow-ups.

## Adding a provider

A search-only provider can be deliberately small. At minimum it needs a provider implementation, registry entry and offline tests.

```ts
export class MySupermarketProvider {
  readonly name = 'mysupermarket';

  async search(query: string, opts?: SearchOptions): Promise<Product[]> {
    // Return truthful, normalised product data.
  }
}
```

Use a compact existing provider with a similar auth/network model as a reference. Do not copy another provider's assumptions just because its API happens to look similar.

When registering a provider:

- declare only capabilities you have implemented and verified;
- set the correct country and authentication model;
- identify a maintainer;
- use `community` for integrations not maintained by the core project;
- add protocol/research credit where another project materially helped with an undocumented interface;
- ensure every declared capability is reachable through the supported interfaces that claim to expose it.

The normative contract is in `docs/PROVIDER-SPEC.md`.

## Verification contract

A PR must make it possible for a reviewer to distinguish verified behaviour from assumptions.

Include:

1. What you tested live.
2. What you tested offline.
3. Any region, store, account or fulfilment assumptions that affect pricing or availability.
4. What deliberately remains unsupported.
5. Commands or fixtures that reproduce behaviour without exposing credentials.
6. Which public interfaces were exercised: library, CLI, HTTP and/or MCP.
7. Any upstream anti-bot, WAF or browser-session dependency.

Run before opening or updating a PR:

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Then confirm that **the new tests are actually invoked by `npm test`**. A green workflow is not useful if the test file is orphaned or a duplicated JSON key caused the intended script to be ignored.

CI is designed to run without retailer credentials so PRs from forks remain verifiable.

## Correctness rules

### Unknown is better than invented

If stock, price, product identity or a capability cannot be established, preserve that uncertainty.

Do not turn missing data into:

- `false` when it means unknown;
- `0` when no valid price was returned;
- an empty result when the upstream request failed;
- a plausible-looking product identifier that has not been validated.

If the shared type cannot represent an important uncertainty honestly, propose the contract change explicitly and migrate existing consumers in the same infrastructure PR.

### Product identity

`product_uid` is the retailer-specific operational identifier used for provider operations.

Cross-retailer identifiers such as GTIN/EAN belong in their own field. Validate and normalise them before exposing them as globally comparable identifiers.

Never replace an operational retailer ID with a barcode unless the provider itself uses that barcode for the operation.

### Spending must be explicit

Checkout and other actions that can spend money must fail safe. Preview/dry-run behaviour is the default. Never weaken an existing confirmation boundary for convenience.

### Errors should be actionable

Do not swallow authentication failures, WAF responses, schema changes or upstream errors and return an empty result. An agent will treat an empty result as truth.

Surface enough context to distinguish:

- a legitimate empty search;
- malformed upstream data;
- authentication failure;
- bot/WAF blocking;
- unsupported capability;
- retailer outage.

Do not leak secrets while doing so.

### Capabilities are promises

A manifest capability is part of the public contract. If `basket` is declared, all supported entry points that advertise basket operations must either route it correctly or explicitly document that they do not.

Do not make capability routing depend on ad-hoc hard-coded provider lists when registry metadata can express the same truth.

### Keep agent payloads lean

The model needs identifiers, names, prices, sizes, stock and other decision-relevant fields. Avoid pushing decorative or redundant retailer payloads through MCP simply because the upstream API returned them.

## Tests

Provider tests should be offline by default.

Use synthetic fixtures or carefully reduced/redacted payloads. Cover at least:

- normal product mapping;
- empty results;
- malformed response shape;
- upstream HTTP failure;
- pagination/limit behaviour where supported;
- price and currency semantics;
- availability semantics;
- auth/session assumptions;
- cleanup of browser resources where applicable;
- registry/capability integration.

Live probes are useful evidence, but they do not replace deterministic tests.

If the provider uses browser automation, test both success and cleanup on failure.

## Credentials and private data

Never commit or paste into issues/PRs:

- passwords;
- API secrets;
- session cookies;
- complete request headers containing authentication;
- addresses;
- payment information;
- private order data.

Use environment variables, local fixtures with fake values and redacted examples.

If you discover a security vulnerability, follow `SECURITY.md` rather than publishing exploit details in a public issue.

## Pull requests

Use the PR template and keep the description current as the implementation changes.

A useful provider PR explains:

- the problem;
- the protocol/behaviour discovered;
- the implementation;
- capability and auth boundaries;
- live verification;
- offline tests;
- known limitations;
- upstream instability or anti-bot dependencies.

Maintainers may ask for a large PR to be split even if the implementation is correct. This is a maintainability requirement, not a judgement on the contribution.

Contributors who maintain a provider are encouraged to put their GitHub handle in the registry. Reverse-engineered integrations stay healthy through ownership, not optimism.
