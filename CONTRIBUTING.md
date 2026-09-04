# Contributing to Open Supermarkets

Open Supermarkets is most useful when people contribute the retailers they can actually test.

The goal is not to collect as many provider names as possible. The goal is a trustworthy interface that agents and humans can rely on without inventing capabilities or silently returning nonsense.

## Good contributions

- a new supermarket provider you can verify against the live retailer;
- fixes for a provider that changed upstream;
- tests for regional catalogue, pricing or authentication behaviour;
- improvements to the CLI, HTTP, MCP or skill interfaces;
- examples of real projects built on Open Supermarkets;
- documentation that removes a genuine setup or debugging trap.

Before investigating a new retailer, read `docs/providers/evaluated.md`. Failed probes are documented so contributors do not repeatedly lose weekends to the same WAF, mTLS requirement or dead endpoint.

## Adding a provider

A search-only provider can be deliberately small. At minimum it needs a provider implementation and a registry entry.

```ts
export class MySupermarketProvider {
  readonly name = 'mysupermarket';
  async search(query: string, opts?: SearchOptions): Promise<Product[]> {
    // return truthful, normalised product data
  }
}
```

Use `src/providers/ah.ts` as a reference for a compact anonymous-search integration.

When registering a provider:

- declare only capabilities you have implemented and tested;
- set the correct country and authentication model;
- identify a maintainer;
- use `community` for integrations that are not maintained by the core project;
- add protocol/research credit where another project helped you understand an undocumented interface.

## Verification contract

A PR should make it possible for a reviewer to distinguish verified behaviour from assumptions.

Include:

1. What you tested live.
2. What you could only test offline.
3. Any region/store/account assumptions that affect pricing or availability.
4. What deliberately remains unsupported.
5. Commands or fixtures that reproduce the behaviour without exposing credentials.

Run before opening a PR:

```bash
npm ci
npm run typecheck
npm run build
npm test
```

CI is designed to run without retailer credentials so PRs from forks remain verifiable.

## Correctness rules

### Unknown is better than invented

If stock, price, product identity or a capability cannot be established, preserve that uncertainty. Do not turn missing data into `false`, zero, an empty basket or another authoritative-looking value unless that is genuinely what the retailer returned.

### Spending must be explicit

Checkout and other actions that can spend money must fail safe. Preview/dry-run behaviour is the default. Never weaken an existing confirmation boundary for convenience.

### Errors should be actionable

Do not swallow authentication failures, WAF responses or upstream errors and return an empty result. An agent will treat an empty result as truth. Surface enough context for a human or agent to understand what happened.

### Keep agent payloads lean

The model needs identifiers, names, prices, sizes, stock and other decision-relevant fields. Avoid pushing decorative or redundant retailer payloads through MCP simply because the upstream API returned them.

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

Keep PRs scoped enough to review. A provider addition can be substantial, but unrelated refactors make live integration changes unnecessarily difficult to reason about.

A useful PR description explains the problem, the protocol/behaviour discovered, the change, live verification, offline tests and known limitations.

Contributors who maintain a provider are encouraged to put their GitHub handle in the registry. Reverse-engineered integrations stay healthy through ownership, not optimism.
