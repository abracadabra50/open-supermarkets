---
name: conad-italy-groceries
description: "Conad Italy through SeleniumBase: persistent browser login, local catalogue, ordinary baskets and a draft shopping review."
compatibility: Node.js 18+, Python 3.10+, SeleniumBase 4.57.1 and visible Chrome on Linux/macOS.
metadata:
  author: GianluDeveloper
  tags: [groceries, conad, italy, seleniumbase, login, mcp]
---

# Conad Italy

Use the dedicated SeleniumBase UC/CDP profile configured by `CONAD_PROFILE_DIR`.
The optional requirements ship at `runtime/conad/requirements.txt`. Reject optional
cookies and select **Mantieni la sessione attiva** by default. Never print form
snapshots after a user starts entering credentials. Do not recreate retailer HTTP
requests with Axios, requests or browser fetch scripts.

1. `grocery_browser_login`: leave the browser to the user when interaction is needed.
2. `grocery_status` with the provider and `grocery_store`: verify account/store/service.
3. `grocery_search_batch`: choose candidates by pack size, quantity and user constraints.
4. `grocery_basket_view`: inspect the initial state before any mutation.
5. Basket add/update/remove: serialize writes and verify results. Use current
   `item_id` for rows; preserve full product codes such as `437403-1_N` for additions.
6. `grocery_checkout_preview`: show known/unknown costs and unresolved blockers.

An addition is incremental, an update absolute. The adapter supports at most
10 units of quantity change per call and refuses weighted/ambiguous lines or order
amendments. Read after an uncertain write before deciding to retry.

Store selection is manual in the retailer browser. Keep `store` in batch results;
these are local prices. Null price/stock means unknown. Retailer codes and validated
GTINs are different identities.

The current review cannot authorize payment. Conad does not declare checkout or
orders. A future placement flow needs a verified final checkout, explicit user
approval of the exact snapshot, a single-use token and idempotency.

See the repository's [provider guide](https://github.com/abracadabra50/open-supermarkets/blob/main/docs/providers/conad.md)
and [MCP procedure](https://github.com/abracadabra50/open-supermarkets/blob/main/docs/procedures/conad-shopping-mcp.md).
