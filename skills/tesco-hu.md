---
name: tesco-hungary-groceries
description: "Tesco Magyarország (bevasarlas.tesco.hu) grocery search and basket via CLI or MCP. Anonymous catalogue search in Hungarian with forint prices; basket needs an imported browser session."
license: MIT
compatibility: Node.js 18+, TypeScript. No browser needed for search. Hungary only.
metadata:
  author: benedek
  version: "1.0.0"
  repository: https://github.com/abracadabra50/open-supermarkets
  tags: [groceries, tesco, hungary, magyar, shopping, automation, mcp, agent-tool]
allowed-tools: Bash({baseDir}/node:*), Bash(supermarket:*), Bash(npm:run:supermarket:*)
---

# Tesco Magyarország Skill

Search the Hungarian Tesco catalogue and, with an imported session, manage the basket.

**Location:** `{baseDir}`

## When to use

- The user shops at Tesco in Hungary, or asks about Hungarian prices ("mennyibe kerül a tej a Tescoban?")
- The user wants to build a Tesco Hungary basket from a meal plan
- The user asks for `--country HU`

## Setup

```bash
cd {baseDir}
npm install
```

No Playwright and no account are needed for search.

## Search (no login)

```bash
supermarket --provider tesco-hu search "tej" --limit 10
supermarket --provider tesco-hu search "csirkemell" --json
supermarket search kenyér --country HU
supermarket --provider tesco-hu categories
```

Prices are in forints and print as `390 Ft`. Product ids are numeric Tesco product
numbers (TPNC), e.g. `205406742` is "Banán lédig".

Search terms should be Hungarian: the backend matches against Hungarian titles.

## Authentication (needed for basket)

There is no scripted login. Tesco Hungary's storefront is behind Akamai and its
login page lives on www.tesco.hu, so import a session from your normal browser:

1. Sign in at https://www.tesco.hu/account/login/hu-HU and open https://bevasarlas.tesco.hu
2. DevTools → Network → click any `bevasarlas.tesco.hu` request → Request Headers → right-click the `Cookie` value → Copy value
3. Import it without letting it touch your shell history:

```bash
supermarket --provider tesco-hu import-session --stdin
# paste, then Ctrl-D
supermarket --provider tesco-hu status
```

A cookie JSON export also works: `supermarket --provider tesco-hu import-session --file ~/Downloads/tesco-hu-cookies.json`

The session is saved to `~/.tesco-hu/session.json` (mode 0600) and expires with the
earliest auth cookie, or after 12 hours when the export carries no expiry.

## Basket

Basket commands exist but the `basket` capability is only declared in the registry
once a live round-trip has been verified. Until then the CLI/MCP boundary refuses them
with `tesco-hu does not support "basket"`. After promotion:

```bash
supermarket --provider tesco-hu basket
supermarket --provider tesco-hu add 205406742 --qty 2
supermarket --provider tesco-hu update <item-id> 3
supermarket --provider tesco-hu remove <item-id>
supermarket --provider tesco-hu clear --force
```

`add`/`update`/`remove` accept either the basket line id shown by `basket` or the
product id.

## MCP

Use `provider: "tesco-hu"` on the standard tools. `grocery_search` and
`grocery_search_batch` work with no session. Basket tools need the imported session
file to exist on the machine running the MCP server.

## API notes

- Backend: `POST https://xapi.tesco.com/` (GraphQL, batched array body)
- Headers: `x-apikey` (public, from the page config), `region: HU`, `language: hu-HU`, `accept-language: hu-HU`
- Operations: `Search`, `GetProduct`, `Taxonomy`, `GetBasket`, `UpdateBasket`
- Schema differs from the UK: no `isAvailable`/`displayPrice`/`unitPrice` on products; use `status`, `price.actual`, `price.unitPrice`, `price.unitOfMeasure`
- Introspection is disabled

## Limitations

- No delivery slots, checkout or order history
- No scripted login; sessions must be re-imported when they expire
- Czechia (nakup.itesco.cz) and Slovakia (potravinydomov.itesco.sk) run the same platform and very likely work with a region switch, but are unverified and not registered
