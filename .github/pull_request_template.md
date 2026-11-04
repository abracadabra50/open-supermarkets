## Summary

<!-- What does this change, and why? Keep this current as the PR evolves. -->

## Scope

- [ ] One provider, or no provider-specific change
- [ ] Shared infrastructure is separated from provider-specific work where practical
- [ ] No unrelated refactors

If this PR intentionally spans multiple providers or public surfaces, explain why they cannot be reviewed independently:

<!-- explanation -->

## Provider contract

<!-- Complete for provider changes; delete if not applicable. -->

**Provider ID:**  
**Country/countries:**  
**Auth model:**  
**Capabilities added/changed:**  
**Maintainer:**  

- [ ] Manifest capabilities match the concrete methods implemented
- [ ] Missing/unknown price, stock or identity is not represented as an authoritative value
- [ ] Currency and regional/store pricing semantics are explicit
- [ ] Retailer-specific `product_uid` remains distinct from cross-retailer identity such as GTIN
- [ ] Unsupported operations fail before retailer network work where possible

## Verification

### Offline

- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] New test files are actually invoked by `npm test`
- [ ] Tests do not require private credentials or live retailer access

Describe the important cases covered:

<!-- tests -->

### Live

What was tested against the real retailer, on what date, country/store/fulfilment context, and through which interfaces?

<!-- live verification -->

- [ ] Library/provider API
- [ ] CLI
- [ ] HTTP API
- [ ] MCP

Only tick interfaces you actually exercised.

## Safety and data handling

- [ ] No credentials, cookies, access tokens, addresses, payment data or private order data are committed
- [ ] Error messages redact secrets
- [ ] Browser/session resources are cleaned up on both success and failure
- [ ] Checkout/spend confirmation boundaries are unchanged unless explicitly discussed

## Known limitations

<!-- WAF/bot protection, store scoping, missing capabilities, brittle upstream endpoints, etc. -->

## Upstream evidence / protocol credit

<!-- Link public documentation or credit prior open-source research where relevant. Do not paste secrets or private traffic. -->

## Maintainer notes

<!-- Anything reviewers should inspect especially closely. -->
