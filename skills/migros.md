---
name: migros-switzerland-groceries
description: "Migros Switzerland catalogue search through a live Playwright browser context."
compatibility: Node.js 18+, TypeScript, Playwright. Switzerland only.
metadata:
  author: vgvr0
  version: "3.0.0"
  tags: [groceries, migros, switzerland, shopping, automation, playwright]
---

# Migros Switzerland

Search the Migros Switzerland catalogue with the standard provider interface:

```bash
npm run groc -- --provider migros search "milk"
npm run groc -- --provider migros search "bread" --json
```

Migros blocks cold HTTP requests with Cloudflare. The provider therefore starts a
headless Chromium context and calls Migros's JSON endpoints from the live page context.
The browser remains alive for the provider instance and is closed by `logout()`/`close()`
or when a search fails. Browser cookies are not currently sufficient for replaying the
same requests through Axios after the browser closes.

The provider implements catalogue search only. Basket, delivery slots and checkout are
not declared capabilities.
