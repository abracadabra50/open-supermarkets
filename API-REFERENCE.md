# Sainsbury's API Reference

> This is a legacy, Sainsbury's-specific endpoint record. For the current
> multi-country provider contract, optional capabilities, store selection, and
> tri-state stock semantics, see [`docs/API.md`](docs/API.md). The supported
> command is `supermarket`; `groc` remains only as a compatibility alias.

## Working Endpoints ✅

### Authentication

**Login (Browser-based)**
```
URL: https://www.sainsburys.co.uk/gol-ui/oauth/login
Method: Browser automation (Playwright)
Auth: None (outputs session cookies)
MFA: SMS code required (interactive prompt)
Output: Session saved to ~/.sainsburys/session.json
```

### Products

**Search Products**
```http
GET /groceries-api/gol-services/product/v1/product?filter[keyword]=QUERY&page_number=1&page_size=24
Auth: Cookies (optional for search)
Response: {
  products: [{
    product_uid, name, retail_price, unit_price, in_stock, image_url
  }]
}
```

### Basket

**View Basket**
```http
GET /groceries-api/gol-services/basket/v2/basket?pick_time=ISO_DATE&store_number=0560&slot_booked=false
Auth: Cookies + wcauthtoken header
Response: {
  basket_id, order_id, subtotal_price, total_price, minimum_spend, has_exceeded_minimum_spend,
  item_count, items: [{ item_uid, quantity, subtotal_price, product: { sku, name, image, ... } }]
}
```

**Add to Basket**
```http
POST /groceries-api/gol-services/basket/v2/basket/item?pick_time=ISO_DATE&store_number=0560&slot_booked=false
Auth: Cookies + wcauthtoken header
Body: {
  "product_uid": "7977681",
  "quantity": 2,
  "uom": "ea",
  "selected_catchweight": ""
}
```

### Customer

**Get Profile**
```http
GET /groceries-api/gol-services/customer/v1/customer/profile
Auth: Cookies + wcauthtoken
Response: { user_id, customer_id, is_registered, email, ... }
```

### Slots

**Get Reservation Status**
```http
GET /groceries-api/gol-services/slot/v1/slot/reservation
Auth: Cookies + wcauthtoken
Response: { reservation_type, postcode, region, store_identifier, flexi_stores, is_alcohol_restricted_store }
```

## Not Working / Unknown ⚠️

### Basket (Partially Working)

**Remove from Basket**
```http
DELETE /groceries-api/gol-services/basket/v2/basket/item/{item_uid}?pick_time=...&store_number=...&slot_booked=...
Status: 405 Method Not Allowed
Note: Endpoint may have changed or require different params
```

**Update Basket Item**
```http
PUT /groceries-api/gol-services/basket/v2/basket/items/{item_uid}
Status: Unknown - not tested
```

###Slots (Access Denied)

**Get Delivery Information**
```http
GET /groceries-api/gol-services/slot/v1/slot/delivery-information
Auth: Cookies + wcauthtoken
Status: ✅ Working
Response: { hd_minimum_spend: "25", cnc_minimum_spend: "0" }
```

**Get Reservation Status**
```http
GET /groceries-api/gol-services/slot/v1/slot/reservation
Auth: Cookies + wcauthtoken
Status: ✅ Working
Response: { reservation_type, postcode, region, store_identifier, flexi_stores, is_alcohol_restricted_store }
```

**List Available Slots**
```http
GET /groceries-api/gol-services/slot/v1/slots
Status: ❌ Access Denied (direct API)
Solution: ✅ Browser automation implemented
Implementation: src/browser/slots.ts
Method: Playwright navigates to /gol-ui/slotselection and parses DOM
```

**Book Slot**
```http
POST /groceries-api/gol-services/slot/v1/slot/reservation
Status: ❌ Access Denied (direct API)
Solution: ✅ Browser automation implemented
Implementation: src/browser/slots.ts -> bookSlot()
Method: Playwright clicks slot elements and confirmation buttons
```

### Checkout (Browser Automation)

**Complete Checkout**
```http
POST /groceries-api/gol-services/checkout/v1/checkout
Status: ❌ Access Denied (direct API)
Solution: ✅ Browser automation implemented
Implementation: src/browser/checkout.ts
Method: Playwright navigates full checkout flow with dry-run support
```

## Browser Automation Approach

Since direct API calls to slots/checkout return "Access Denied", we use Playwright browser automation:

**Anti-Bot Detection:**
- Non-headless mode (visible browser)
- Disable automation control flags
- Proper user agent and viewport
- Hide navigator.webdriver property

**How It Works:**
1. Load saved session from ~/.sainsburys/session.json
2. Navigate to slot/checkout pages
3. Accept cookie consent
4. Parse DOM for slot/checkout data
5. Simulate user clicks for booking/checkout
6. Capture screenshots on errors for debugging

**Files:**
- `src/browser/slots.ts` - Slot listing and booking
- `src/browser/checkout.ts` - Checkout flow with dry-run

This bypasses Access Denied and provides full functionality.

### Orders

**Get Order History**
```http
GET /groceries-api/gol-services/order/v1/order/status
Status: 404 (no active orders to test with)
```

## Authentication Details

### Headers Required

**All Authenticated Requests:**
```http
Cookie: [session cookies from login]
wcauthtoken: [value from WC_AUTHENTICATION_* cookie]
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
Accept: application/json
Content-Type: application/json
```

### Session Cookie Format

**Saved in `~/.sainsburys/session.json`:**
```json
{
  "cookies": [
    { "name": "WC_AUTHENTICATION_554173388", "value": "...", "domain": ".sainsburys.co.uk", ... },
    { "name": "WC_SESSION_ESTABLISHED", "value": "true", ... },
    { "name": "WC_USERACTIVITY_554173388", "value": "...", ... },
    ...
  ],
  "expiresAt": "2026-02-22T14:20:00.000Z",
  "lastLogin": "2026-02-15T14:20:00.000Z"
}
```

### Extracting wcauthtoken

```javascript
const authCookie = session.cookies.find(c => c.name.startsWith('WC_AUTHENTICATION_'));
const wcauthtoken = authCookie ? authCookie.value : '';
```

## Query Parameters

### Common Params

**pick_time**: ISO 8601 date for delivery (typically tomorrow)
```javascript
const pickTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
// "2026-02-16T14:30:00.000Z"
```

**store_number**: Fulfilment store identifier
```
Default: "0560"
Can be obtained from slot/v1/slot/reservation response: store_identifier
```

**slot_booked**: Whether a delivery slot is currently reserved
```
"false" | "true"
```

## Rate Limiting & Error Handling

**401 Unauthorized**
- Session expired or wcauthtoken missing
- Solution: Re-login

**400 Bad Request**
- Invalid payload or missing required fields
- Solution: Check request body matches examples above

**405 Method Not Allowed**
- Endpoint may have changed
- Solution: Capture real browser request using Playwright

**404 Not Found**
- Resource doesn't exist (e.g., no active orders)
- May be expected in some cases

## Base URLs

```
API Base: https://www.sainsburys.co.uk/groceries-api/gol-services
Web UI: https://www.sainsburys.co.uk/gol-ui
Assets: https://assets.sainsburys-groceries.co.uk/gol
```

## Testing

```bash
# Test search (no auth required)
curl 'https://www.sainsburys.co.uk/groceries-api/gol-services/product/v1/product?filter[keyword]=milk&page_number=1&page_size=10'

# Test basket view (auth required)
# 1. Login via CLI to get session
# 2. Extract cookies and wcauthtoken
# 3. Use in curl:
curl -H "Cookie: WC_AUTHENTICATION_...=...; WC_SESSION_ESTABLISHED=true; ..." \
     -H "wcauthtoken: ..." \
     'https://www.sainsburys.co.uk/groceries-api/gol-services/basket/v2/basket?pick_time=2026-02-16T14:00:00Z&store_number=0560&slot_booked=false'
```

## Notes

- All working endpoints verified with real requests on 2026-02-15
- Session expires after ~7 days
- MFA required on every new login
- Search works without authentication but basket/checkout require login
- API structure suggests REST but some endpoints don't follow standard conventions
- Sainsbury's may change endpoints without notice - use browser inspection to verify
