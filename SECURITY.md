# Security Policy

Open Supermarkets interacts with retailer accounts, authenticated browser sessions, baskets and, for some providers, checkout flows. Treat credentials and session material as secrets with the same care you would give the retailer account itself.

## Reporting a vulnerability

Please do **not** open a public issue containing an exploitable vulnerability, retailer credentials, session cookies, payment information or another user's private data.

For a security-sensitive report, use GitHub's private vulnerability reporting feature for this repository when it is available. If private reporting is not available, open a minimal public issue stating that you have a security report to share, without including exploit details or secrets, so a private channel can be established.

A useful report includes:

- affected provider or component;
- affected version/commit;
- impact;
- minimal reproduction steps with secrets removed;
- whether the issue can spend money, mutate a live basket, expose authentication material or cross an account boundary.

## Safety boundaries

The project treats the following as security-sensitive invariants:

### Checkout is fail-safe

Checkout must preview/dry-run by default. Spending real money requires an explicit confirmation path. Changes that weaken this boundary should be treated as security changes and reviewed accordingly.

### Credentials stay local

Passwords, API keys and retailer session cookies must never be logged, committed, embedded in fixtures or returned through agent tool output.

Session files should use restrictive local file permissions where supported.

### Empty data must not hide authentication failure

An expired session or blocked request must not silently become an empty search result, empty order history or empty basket. Agents can act on those values as if they are authoritative.

### External retailer content is untrusted

Product names, descriptions and other retailer-controlled strings are data, not instructions. Agent integrations should not treat content returned by a retailer as trusted executable guidance.

## Supported versions

Security fixes target the current release and the `main` branch. This project integrates with undocumented and changing retailer interfaces, so old releases can stop working independently of the core package.

## Secrets accidentally committed

If a real credential or session cookie is committed, assume it is compromised even if the commit is subsequently removed. Revoke or rotate it at the retailer/provider first; history rewriting is not a substitute for invalidating the credential.
