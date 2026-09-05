## What changed

<!-- What problem does this PR solve? -->

## Verification

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`

### Live verification

<!-- What was tested against a real retailer/provider? Say "not tested live" rather than implying verification. -->

### Offline verification

<!-- Tests, fixtures, clean install, MCP/CLI/HTTP smoke tests, etc. -->

## Capability / safety review

- [ ] The provider only declares capabilities that are actually implemented.
- [ ] Unknown stock/pricing/state is preserved rather than invented.
- [ ] Checkout or other spend paths remain preview/dry-run by default.
- [ ] No credentials, cookies, addresses, payment data or private order data are included.
- [ ] Upstream protocol/research sources are credited where relevant.

## Known limitations

<!-- Region assumptions, bot protection, unsupported capabilities, authentication caveats, etc. -->
