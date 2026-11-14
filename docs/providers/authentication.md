# Authentication in this repository

Static code review dated 2026-11-14; no live authentication checks were performed
against other retailers during the Conad work.

There is one common MCP server, not a separate implementation for each retailer.
The registry declares capabilities, authentication requirements and optional
features. `grocery_login` delegates to the providers declaring the `login` extra.

| Provider | Implemented authentication | Persistence and boundaries |
|---|---|---|
| Sainsbury's | Visible Playwright, credentials, optional SMS MFA entered through a terminal prompt | Private `~/.sainsburys/session.json`; cookies reused in API calls. Opt-in headless reauthentication on 401/403 with provider-specific environment credentials. |
| Ocado | Visible Playwright, credentials, optional email OTP from a terminal prompt; cookie import alternative | Private `~/.ocado/session.json`; cookies plus site-derived CSRF for writes. Live authentication check reads the cart. |
| Tesco UK | Playwright-extra/stealth, email OTP or human completion; cookie import fallback | Private `~/.tesco/session.json`; JSON/header imports and expiry inferred from cookies, with a local 12-hour fallback. The retailer can invalidate it sooner. |
| Tesco Hungary | Imported browser session; no scripted login advertised | Private `~/.tesco-hu/session.json`. Anonymous catalogue, authenticated basket. |
| Albert Heijn NL/BE | Automatically issued anonymous bearer token | Cached in memory until shortly before expiry; no customer account login. |
| Migros | Browser-created guest session | Configurable private Playwright storage-state file. Browser resources are closed after each operation. Not a personal-account login. |
| Kroger | OAuth2 client credentials | Application client ID/secret from environment, token in memory; not a shopper login. |
| Instacart official | Partner API key | Environment-provided key, no customer login implemented. |
| Instacart web | Browser session supplied by the operator | Cookie header in `INSTACART_SESSION_COOKIE`, with separately configured store/zone context. No scripted login. |
| Lidl Ireland, Mercadona, AhorraMás | Public catalogue access | No customer credentials for the declared capabilities. Public search keys are not customer-account secrets. |
| Conad | Persistent SeleniumBase UC/CDP profile; human login/resume and optional credential submission | Private per-account profile and local IPC, session/account binding and serialized browser actions. Retailer calls are performed by the browser. |

The manifest's stored-session gate checks whether a file exists. It does not
universally prove that the retailer still accepts its cookies. The global status
listing therefore reports local setup rather than a live guarantee. A
provider-specific status request invokes the provider's authentication method;
Conad reads account and store together.

The UK MFA paths contain terminal `readline` prompts, not a uniform MCP
start/challenge/resume protocol. Conad's human-login worker is separate from MCP
stdio and does not consume credential prompts on that transport. Existing UK
cookie-consent behaviour was not changed as part of this integration.

Source references:

- [Registry](../../src/providers/registry.ts), [MCP routes](../../src/mcp-routes.ts), [server](../../src/mcp-server.ts).
- Sainsbury's [login helper](../../src/auth/login.ts) and [provider](../../src/providers/sainsburys.ts).
- [Ocado](../../src/providers/ocado.ts).
- Tesco [authentication](../../src/providers/tesco/auth.ts) and [imports](../../src/providers/tesco/import-session.ts).
- Tesco Hungary [sessions](../../src/providers/tesco-hu/session.ts) and [provider](../../src/providers/tesco-hu/index.ts).
- [Albert Heijn](../../src/providers/ah.ts), [Kroger](../../src/providers/kroger.ts), [Instacart](../../src/providers/instacart.ts), [Instacart web](../../src/providers/instacart-web.ts).
- [Migros](../../src/providers/migros.ts), [Conad bridge](../../src/providers/conad/seleniumbase.ts) and [worker](../../runtime/conad/worker.py).
