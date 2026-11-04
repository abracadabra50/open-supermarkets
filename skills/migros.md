---
name: migros-switzerland-groceries
description: "Migros Switzerland: online-catalogue search and an anonymous guest basket, through a live Playwright browser context."
compatibility: Node.js 18+, TypeScript, Playwright. Switzerland only.
metadata:
  author: vgvr0
  version: "3.0.0"
  tags: [groceries, migros, switzerland, shopping, automation, playwright]
---

# Migros Switzerland

No account needed. Search and the basket run as a Migros guest.

```bash
supermarket --provider migros search "milk" --json
supermarket --provider migros add 100006357 --qty 2
supermarket --provider migros basket
supermarket --provider migros remove 100006357
```

**How it works.** Migros blocks cold HTTP requests with Cloudflare, so each call starts
headless Chromium, calls Migros's JSON endpoints from the live page, and closes the
browser when it's done. Nothing stays running between calls.

**The basket persists.** The guest's cookies are saved to `~/.migros/session.json`
(mode 600; override with `MIGROS_SESSION_FILE`) and reused on the next call, so separate
CLI, MCP or HTTP calls all see the same basket. Delete the file to start a fresh guest.

**Ids.** `product_uid` is Migros's `uid`, which is what search returns and the basket
accepts. `migrosId` looks like a product id, and the basket API accepts it, but the item then
never appears.

**Online catalogue.** Search uses the online shop for the guest's delivery warehouse, so
every result can go in the basket. In-store-only products are not listed.

**Not supported:** delivery slots, checkout, order history. The guest's delivery area is
the one Migros guesses; signed-in accounts are not supported.
