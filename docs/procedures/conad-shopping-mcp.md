# Conad shopping through MCP

This procedure covers the implemented shopping workflow and the proposed order
approval contract. Conad currently exposes **no order-placement tool**. Its
shopping review cannot authorize payment, reserve prices or reserve a slot.

## 1. Establish the account and store

1. Call `grocery_browser_login` with `provider: "conad"` for human authentication.
2. Complete any challenge in the visible browser. Reject optional cookies on both
   domains. The persistent-login checkbox is selected by default.
3. Call `grocery_status` with the provider and verify the live account state.
4. Read `grocery_store`; show the selected local store and pickup/delivery service.
5. Select/change stores in the retailer browser. Revisit prices and the basket
   after a context change. Use a separate persistent profile for another account.

A pending interaction or a local profile file is not proof of a successful login.
Do not log credentials, form snapshots, cookies or private account data.

## 2. Search and choose

Prefer `grocery_search_batch` for a shopping list:

```json
{"provider":"conad","queries":["latte parzialmente scremato 1 l","pasta integrale 500 g"],"limit":5}
```

For each selected item retain the full retailer code, name, pack size, desired
number of packs, price/currency, stock uncertainty, store/service and any relevant
brand/diet/substitution constraints. Preserve composite SKU suffixes. Never choose
only the first result or the lowest absolute price while ignoring pack size.
Unknown price/stock stays unknown. Nutrition enrichment is auxiliary, especially
for allergies.

## 3. Mutate and reconcile the basket

1. Read `grocery_basket_view` before writing.
2. Confirm it is an ordinary editable cart, not an order amendment.
3. Use `grocery_basket_add_batch` or single additions for approved products.
   Additions are incremental; updates are absolute.
4. Use each current `item_id` for update/removal. Conad does not infer a line
   identifier from a product position or remove every variation of a SKU.
5. Serialize writes. The UI adapter supports at most 10 units of quantity change
   per call, respects known retailer limits and refuses weighted/ambiguous lines.
6. Read the result and compare identities, quantities and retailer totals.
7. On timeout or an uncertain write, read before deciding whether to retry. Do
   not blindly repeat an addition; it may already have changed the server cart.

Unexpected concurrent edits are errors, not a reason to silently compensate.
Report partial changes accurately. Do not claim a failed multi-step edit was
rolled back unless it was actually verified.

## 4. Prepare the shopping review

Call `grocery_checkout_preview`. It captures basket and known charges in one
serialized worker operation, returns an observation time and account-scoped
snapshot hash, and identifies blockers. It always reports `can_place_order: false`.

Before an eventual final approval, the following information must be known and
reviewed with the user:

| Data | Required verification |
|---|---|
| Products | Exact identity, packs, quantities, prices and unavailable lines |
| Promotions | Conditions, required loyalty membership and applied discounts |
| Substitutions | Explicit choices and limits for each affected line |
| Store/service | Same verified context as the basket and price review |
| Destination | User-reviewed delivery address or pickup point |
| Slot | Date, time zone, window, price, booking ID and expiry |
| Costs | Subtotal, discounts, delivery, service, surcharges and final total |
| Limits | Minimum spend, quantity/weight/volume limits and surcharges |
| Payment | Ready method/status, without full card details in tool output |
| Validity | Retailer-confirmed limits on the quote and slot |

Do not add charges twice when the retailer total already includes them. Unknown
values are null, not zero. A local review timestamp is not a price guarantee.

## 5. Proposed order approval contract — not implemented

The future order tool must be implemented and tested separately after the final
Conad checkout has been verified:

1. Produce a complete, blocker-free checkout snapshot bound to account, basket,
   store, slot, substitutions, payment method and final payable total.
2. Show that exact review and obtain explicit approval for the order/amount.
   Search and basket-edit requests are not purchase approval.
3. Bind the approval to a review ID/hash. Only then issue a short-lived, single-use
   confirmation token. This token does not exist in the current draft review.
4. Require the token, strict `confirm: true` and an idempotency key for placement.
5. Re-read the retailer checkout immediately before submission. Any relevant
   change invalidates approval and requires a fresh review.
6. Perform the final retailer action once. Verify order number, status, amount
   and actual contents before reporting success.
7. If the result is uncertain, reconcile retailer order history before any retry.
   A timeout does not prove that no order was created.

Ordinary tests must not spend money. The current registry excludes Conad from
`grocery_checkout`, including `dry_run: false`, before loading browser code.

## Current boundary

Login/profile reuse, local search/detail, ordinary fixed-pack baskets and a draft
review are implemented. Automatic store selection, slot booking, final checkout,
order history, approval-token issuance and placement remain unsupported. No
procedure should tell an agent to simulate success for those stages.
