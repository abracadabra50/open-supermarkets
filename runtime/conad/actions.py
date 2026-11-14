"""Conad browser actions. Only fixed-pack ordinary baskets are editable."""

from __future__ import annotations

import hashlib
import json
import time
from urllib.parse import urlencode

from browser import BrowserSession, LOGIN_ORIGIN, PASSWORD
from model import ConadError, basket_from_snapshot, integer, product_code

MAX_QUANTITY_DELTA = 10
CART_SCRIPT = r"""(() => {
  const c = window.cart, main = document.querySelector('main');
  const visible = el => !!el?.getClientRects().length;
  const text = (main?.innerText || '').replace(/\s+/g, ' ');
  const buttons = Array.from(main?.querySelectorAll('button, a') || []).filter(visible);
  const empty = visible(document.querySelector('main .container-cart-empty')) || /carrello\s+(?:è\s+)?vuoto/i.test(text);
  const accountText = (document.body?.innerText || '').replace(/\s+/g, ' ');
  const amend = !!(c?.orderCode || c?.originalOrderCode || c?.isOrderAmendment) ||
    /stai modificando.{0,40}ordine|ordine in modifica|conferma (?:le )?modifiche|annulla (?:le )?modifiche/i.test(accountText);
  return {
    empty_visible: empty,
    ordinary_cart: buttons.some(el => /^Vai alla cassa\b|^Inizia la spesa\b/i.test(el.innerText.trim())),
    amend,
    cards: Array.from(document.querySelectorAll('main .component-ProductCardDetailCart[data-product]'))
      .map(el => ({product: JSON.parse(el.getAttribute('data-product')), max_quantity: el.getAttribute('data-maxquantity')})),
    cart: c ? {
      code: c.code, entries: c.entries?.map(e => ({entryNumber: e.entryNumber, productCode: e.productCode, outOfStock: e.outOfStock})),
      total_quantity: c.totalUnitCount, total: c.totalPrice?.value,
      subtotal: c.subTotal?.value, delivery: c.totalDeliveryCost?.value,
      minimum_value_reached: c.minimumValueReached,
      currency: c.subTotal?.currencyIso || c.totalDeliveryCost?.currencyIso
    } : null
  };
})()"""


def fingerprint(basket):
    return hashlib.sha256(json.dumps(basket, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def target_quantity(basket, code):
    lines = [line for line in basket["items"] if line["product_uid"] == code]
    if len(lines) > 1:
        raise ConadError("CONAD_UNSUPPORTED_PRODUCT", "Conad products split across multiple basket lines require manual quantity/variant selection.")
    return lines[0]["quantity"] if lines else 0


def capture(session: BrowserSession, expected_store=None):
    expected = session.local(expected_store)
    session.open("/cartdetail")
    session.local(expected)
    session.wait("Boolean(document.querySelector('main .component-ProductCardDetailCart') || document.querySelector('main .container-cart-empty')?.getClientRects().length || /carrello\\s+(?:è\\s+)?vuoto/i.test(document.querySelector('main')?.innerText || ''))")
    raw = session.evaluate(CART_SCRIPT)
    if isinstance(raw, dict) and isinstance(raw.get("cart"), dict) and raw["cart"].get("currency") not in (None, "EUR"):
        raise ConadError("CONAD_PROTOCOL_ERROR", "Conad returned an unexpected basket currency.")
    result = basket_from_snapshot(raw, session.local(expected))
    if raw.get("amend") is True:
        raise ConadError("CONAD_UNSUPPORTED_CART", "Conad order amendments are not supported by this adapter. Review the existing order in the visible browser.")
    return result


def product(session, code):
    code = product_code(code)
    expected = session.local()
    session.open("/p/--" + code)
    session.local(expected)
    session.wait("Boolean(document.querySelector('main[data-product]'))")
    raw = session.evaluate(r"""(() => {
      const p = JSON.parse(document.querySelector('main[data-product]').getAttribute('data-product'));
      return {
        row: Object.fromEntries(['code','nome','basePrice','defaultImgSrc','netQuantity','netQuantityUm','ean'].filter(k => k in p).map(k => [k,p[k]])),
        variable: !!p.variations || !!document.querySelector('main .var-weight-menu input'),
        quantity: Array.isArray(p.entries) ? p.entries.reduce((n,e) => n + (typeof e.qty === 'number' ? e.qty : NaN), 0) : null,
        cart: {code: window.cart?.code ?? null, total_quantity: window.cart?.totalUnitCount ?? 0,
          entries: (window.cart?.entries || []).map(e => [String(e.entryNumber), e.productCode])}

      };
    })()""")
    if not isinstance(raw, dict) or not isinstance(raw.get("row"), dict) or raw["row"].get("code") != code:
        raise ConadError("CONAD_PROTOCOL_ERROR", "Conad product detail does not match the requested retailer code.")
    return raw | {"store": session.local(expected)}


def search(session, args):
    query = args.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > 1_000:
        raise ConadError("CONAD_INVALID_INPUT", "Conad search requires a non-empty query of at most 1000 characters.")
    page = integer(args.get("page", 1), "page", 1, 2**53 - 1)
    expected = session.local()
    session.open("/search?" + urlencode({"query": query.strip(), "page": page}))
    session.local(expected)
    session.wait("Boolean(document.querySelector('.results-info .results, .no-result'))")
    raw = session.evaluate(r"""(() => ({
      count: document.querySelector('.results-info .results')?.textContent ?? null,
      empty: !!document.querySelector('.no-result'),
      rows: Array.from(document.querySelectorAll('.product-results .component-ProductCard[data-product]'))
        .map(el => JSON.parse(el.getAttribute('data-product')))
        .map(p => Object.fromEntries(['code','nome','basePrice','defaultImgSrc','netQuantity','netQuantityUm','ean'].filter(k => k in p).map(k => [k,p[k]])))
    }))()""")
    import re
    if not isinstance(raw, dict) or not isinstance(raw.get("rows"), list):
        raise ConadError("CONAD_PROTOCOL_ERROR", "Conad returned malformed search markup.")
    match = re.fullmatch(r"\s*([0-9][0-9.\s]*)\s+risultat[oi]\s*", raw.get("count") or "")
    if match:
        total = int(re.sub(r"[.\s]", "", match.group(1)))
    elif raw.get("empty") is True and not raw["rows"]:
        total = 0
    else:
        raise ConadError("CONAD_PROTOCOL_ERROR", "Conad search result count is missing.")
    if (raw.get("empty") and total) or len(raw["rows"]) != min(40, max(0, total - (page - 1) * 40)):
        raise ConadError("CONAD_PROTOCOL_ERROR", "Conad returned an incomplete or contradictory catalogue page.")
    return {"rows": raw["rows"], "total": total, "store": session.local(expected)}


def editable(snapshot, code=None):
    if not snapshot["ordinary_cart"]:
        raise ConadError("CONAD_UNSUPPORTED_CART", "Conad did not confirm an ordinary editable cart. Review the visible browser before changing it.")
    codes = [code] if code is not None else [line["product_uid"] for line in snapshot["basket"]["items"]]
    for value in codes:
        target_quantity(snapshot["basket"], value)
        if value in snapshot["variable_codes"]:
            raise ConadError("CONAD_UNSUPPORTED_PRODUCT", "Variable-weight or variant Conad products require manual basket changes.")


def other_lines(basket, code):
    return sorted((line["item_id"], line["product_uid"], line["quantity"]) for line in basket["items"] if line["product_uid"] != code)


def ui_quantity(code):
    # This is an acknowledgement only; the fresh cart is still authoritative.
    return """(() => {
      const main=document.querySelector('main[data-product]');
      if(!main || JSON.parse(main.getAttribute('data-product')).code!=="""+json.dumps(code)+""") return null;
      if(document.querySelector('#button-cart-add')?.getClientRects().length) return 0;
      const value=document.querySelector('main .product-button-add .add-quantity .quantity')?.textContent.trim();
      return /^\\d+$/.test(value || '')?Number(value):null;
    })()"""


def product_cart_matches(basket, detail):
    raw = detail.get("cart")
    if not isinstance(raw, dict) or raw.get("total_quantity") != basket["total_quantity"]:
        return False
    if basket.get("basket_id") and raw.get("code") != basket["basket_id"]:
        return False
    expected = sorted((line["item_id"], line["product_uid"]) for line in basket["items"])
    entries = raw.get("entries")
    return isinstance(entries,list) and all(isinstance(e,list) and len(e)==2 for e in entries) and sorted(tuple(e) for e in entries)==expected


def set_quantity(session, snapshot, code, desired):
    desired = integer(desired, "quantity", 0, 100)
    code = product_code(code)
    editable(snapshot, code)
    original = target_quantity(snapshot["basket"], code)
    if abs(desired - original) > MAX_QUANTITY_DELTA:
        raise ConadError("CONAD_INVALID_INPUT", "Conad UI updates are limited to 10 units of quantity change per call.")
    limit = snapshot["limits"].get(code)
    if limit is not None and desired > limit:
        raise ConadError("CONAD_INVALID_INPUT", "The requested quantity exceeds the maximum shown by Conad.")
    while original != desired:
        # A separate read catches edits made by a person while the agent was
        # thinking. Never compensate for an unexpected concurrent change.
        fresh = capture(session, snapshot["basket"]["store"])
        if fingerprint(fresh["basket"]) != fingerprint(snapshot["basket"]):
            raise ConadError("CONAD_CART_CHANGED", "Conad basket changed before the write. Read it again before retrying.")
        detail = product(session, code)
        if detail.get("variable") is not False:
            raise ConadError("CONAD_UNSUPPORTED_PRODUCT", "This Conad product requires an explicit weight or variant selection.")
        if (detail.get("quantity") is not None and detail["quantity"] != original) or not product_cart_matches(snapshot["basket"], detail):
            raise ConadError("CONAD_CART_CHANGED", "Conad product quantity changed before the write. Read the basket again.")
        session.wait(ui_quantity(code) + "===" + str(original), 15)
        session.local(snapshot["basket"]["store"])
        selector = '#button-cart-add' if original == 0 else 'main .product-button-add .add-quantity button[onclick*="addCart"]'
        delta = 1 if desired > original else -1
        if delta < 0:
            selector = 'main .product-button-add .add-quantity button[onclick*="removeToCart"]'
        if not session.cdp.is_element_visible(selector):
            raise ConadError("CONAD_UNSUPPORTED_PRODUCT", "The requested change is unavailable in the visible Conad product controls.")
        session.click(selector, mutation=True)
        session.wait(ui_quantity(code) + "===" + str(original + delta), 15)
        # Do not use updatedQuantity/updatedEntry: those are boolean flags.
        # A fresh server-rendered cart is the confirmation of the write.
        after = capture(session, snapshot["basket"]["store"])
        expected = original + delta
        if (target_quantity(after["basket"], code) != expected or
                other_lines(after["basket"], code) != other_lines(snapshot["basket"], code) or
                (snapshot["basket"].get("basket_id") and snapshot["basket"]["basket_id"] != after["basket"].get("basket_id"))):
            raise ConadError("CONAD_CART_CHANGED", "Conad did not confirm the exact basket change. Inspect the basket before retrying.")
        original, snapshot = expected, after
    return snapshot


def mutate(session, action, args):
    snapshot = capture(session)
    editable(snapshot)
    if action == "basket_add":
        code = product_code(args.get("product_id"))
        amount = integer(args.get("quantity", 1), "quantity", 1, MAX_QUANTITY_DELTA)
        desired = target_quantity(snapshot["basket"], code) + amount
    elif action == "basket_clear":
        if sum(line["quantity"] for line in snapshot["basket"]["items"]) > MAX_QUANTITY_DELTA:
            raise ConadError("CONAD_INVALID_INPUT", "Clear at most 10 units per Conad browser operation; review larger carts manually.")
        for code in dict.fromkeys(line["product_uid"] for line in snapshot["basket"]["items"]):
            snapshot = set_quantity(session, snapshot, code, 0)
        return {"confirmed": True}
    else:
        item = args.get("item_id")
        if not isinstance(item, str) or not item:
            raise ConadError("CONAD_INVALID_INPUT", "A Conad basket line ID is required.")
        line = next((line for line in snapshot["basket"]["items"] if line["item_id"] == item), None)
        if line is None:
            raise ConadError("CONAD_NOT_FOUND", "The Conad basket line was not found; read the current basket again.")
        code = line["product_uid"]
        desired = 0 if action == "basket_remove" else integer(args.get("quantity"), "quantity", 0, 100)
    result = set_quantity(session, snapshot, code, desired)
    if target_quantity(result["basket"], code) != desired:
        raise ConadError("CONAD_CART_CHANGED", "The Conad basket change was not confirmed.")
    return {"confirmed": True}


def dispatch(session: BrowserSession, action, args):
    if action == "status":
        return session.state()
    if action == "browser_login":
        return session.prepare_login()
    if action == "login":
        email, password = args.get("email"), args.get("password")
        if not isinstance(email, str) or not email.strip() or not isinstance(password, str) or not password:
            raise ConadError("CONAD_INVALID_INPUT", "Conad email and password are required.")
        session.prepare_login()
        if session.state()["authenticated"]:
            same = session.evaluate("(() => {const e=window.user?.email;return typeof e==='string' && e.trim().toLowerCase()===" + json.dumps(email.strip().lower()) + ";})()")
            if same is not True:
                raise ConadError("CONAD_ACCOUNT_CHANGED", "A different or unverified account is already signed in. Use its dedicated profile.")
            return session.state()
        if session.state()["url"] != LOGIN_ORIGIN + "/login" or not session.cdp.is_element_visible(PASSWORD):
            raise ConadError("CONAD_INTERACTION_REQUIRED", "Complete the verification in the visible MyConad browser.")
        session.context.check()
        session.cdp.type('input[name="email"]', email)
        session.cdp.type(PASSWORD, password)
        return session.submit_login()
    if action == "store":
        return session.local()
    if action == "search_page":
        return search(session, args)
    if action == "product":
        result = product(session, args.get("product_id"))
        return {"row": result["row"], "store": result["store"]}
    if action in {"basket", "checkout_summary"}:
        snapshot = capture(session)
        return snapshot["basket"] if action == "basket" else {"basket": snapshot["basket"], "summary": snapshot["summary"], "account_key": session.account or ("guest:" + hashlib.sha256(str(session.profile).encode()).hexdigest())}
    if action in {"basket_add", "basket_update", "basket_remove", "basket_clear"}:
        return mutate(session, action, args)
    raise ConadError("CONAD_INVALID_INPUT", "Unknown Conad browser operation.")
