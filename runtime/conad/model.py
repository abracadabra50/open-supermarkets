"""Validated, retailer-derived data and safe errors. No browser dependency."""

from __future__ import annotations

from dataclasses import dataclass
import math
import re
import time
from typing import Callable

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 65_536
MAX_OPERATION_SECONDS = 120
CODE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")


class ConadError(Exception):
    """Only this allowlisted message is suitable for logs/tool responses."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.safe_message = message


class DeadlineExceeded(BaseException):
    """Must not be swallowed by browser-library Exception handlers."""


@dataclass
class RequestContext:
    deadline: float
    connected: Callable[[], bool] = lambda: True
    mutation_started: bool = False

    def check(self) -> None:
        if time.monotonic() >= self.deadline or not self.connected():
            raise DeadlineExceeded()

    def before_write(self) -> None:
        self.check()
        self.mutation_started = True


def fail_protocol(message: str) -> None:
    raise ConadError("CONAD_PROTOCOL_ERROR", message)


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return value if math.isfinite(value) and value >= 0 else None
    except OverflowError:
        return None


def positive_quantity(value):
    n = number(value)
    if n is None or n <= 0:
        fail_protocol("Conad returned an invalid basket quantity.")
    return n


def integer(value, name: str, minimum=0, maximum=100):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ConadError("CONAD_INVALID_INPUT", f"{name} must be an integer between {minimum} and {maximum}.")
    return value


def product_code(value):
    if not isinstance(value, str) or not CODE.fullmatch(value):
        raise ConadError("CONAD_INVALID_INPUT", "A valid Conad retailer code is required.")
    return value


def store_context(raw):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        fail_protocol("Conad returned malformed store metadata.")
    for key in ("store_id", "name", "address"):
        if not isinstance(raw.get(key), str) or not raw[key].strip():
            fail_protocol("Conad returned incomplete store metadata.")
    if raw.get("fulfilment") not in ("pickup", "delivery"):
        fail_protocol("Conad returned an unknown fulfilment mode.")
    return {key: raw[key] for key in ("store_id", "name", "address", "fulfilment")} | {"provider": "conad"}


def same_store(left, right):
    return left is not None and right is not None and all(
        left[key] == right[key] for key in ("store_id", "fulfilment")
    )


def basket_from_snapshot(snapshot, store):
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("cards"), list):
        fail_protocol("Conad returned malformed basket data.")
    cart = snapshot.get("cart")
    if cart is None:
        if snapshot.get("empty_visible") is not True:
            fail_protocol("Conad did not confirm an empty basket.")
        cart = {"entries": [], "total_quantity": 0, "total": 0, "code": ""}
    if not isinstance(cart, dict) or not isinstance(cart.get("entries"), list):
        fail_protocol("Conad basket entries are missing.")
    compact_ids = []
    unavailable = set()
    for entry in cart["entries"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("productCode"), str):
            fail_protocol("Conad returned a malformed basket entry.")
        compact_ids.append((str(entry.get("entryNumber")), entry["productCode"]))
        if entry.get("outOfStock") is True:
            unavailable.add(str(entry.get("entryNumber")))
    if compact_ids and (not isinstance(cart.get("code"), str) or not cart["code"]):
        fail_protocol("Conad did not identify the non-empty basket.")
    items = []
    variable_codes = []
    limits = {}
    for card in snapshot["cards"]:
        if not isinstance(card, dict) or not isinstance(card.get("product"), dict):
            fail_protocol("Conad returned a malformed basket card.")
        product = card["product"]
        code = product_code(product.get("code"))
        name = product.get("nome")
        entries = product.get("entries")
        if not isinstance(name, str) or not name.strip() or not isinstance(entries, list):
            fail_protocol("Conad basket product identity is incomplete.")
        limit = card.get("max_quantity")
        if isinstance(limit, str) and limit.isdecimal():
            limits[code] = int(limit)
        if product.get("variations"):
            variable_codes.append(code)
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("entryNumber") is None:
                fail_protocol("Conad basket line ID is missing.")
            qty = positive_quantity(entry.get("qty"))
            if not float(qty).is_integer() or entry.get("scale") is not None:
                variable_codes.append(code)
            price = entry.get("totalPrice")
            if isinstance(price, dict) and price.get("currencyIso") not in (None, "EUR"):
                fail_protocol("Conad basket currency changed unexpectedly.")
            total = number(price.get("value")) if isinstance(price, dict) else None
            stock = False if str(entry["entryNumber"]) in unavailable else None
            if stock is False and total == 0:
                total = None
            unit = total / qty if total is not None else None
            unit = number(unit)
            items.append({
                "item_id": str(entry["entryNumber"]), "product_uid": code,
                "name": name.strip(), "quantity": qty,
                "unit_price": unit,
                "total_price": total,
                "in_stock": stock,
            })
    actual_ids = [(line["item_id"], line["product_uid"]) for line in items]
    if len(set(actual_ids)) != len(actual_ids) or sorted(actual_ids) != sorted(compact_ids):
        fail_protocol("Conad rendered basket lines do not match its basket state.")
    quantity = number(cart.get("total_quantity"))
    if quantity is None or not math.isclose(quantity, sum(line["quantity"] for line in items), abs_tol=1e-8):
        fail_protocol("Conad basket quantity is inconsistent.")
    basket = {
        "items": items, "total_quantity": quantity, "total_cost": number(cart.get("total")),
        "provider": "conad", "currency": "EUR", "store": store,
    }
    if isinstance(cart.get("code"), str) and cart["code"]:
        basket["basket_id"] = cart["code"]
    return {
        "basket": basket,
        "ordinary_cart": snapshot.get("ordinary_cart") is True and snapshot.get("amend") is False,
        "variable_codes": set(variable_codes), "limits": limits,
        "summary": {
            "subtotal": number(cart.get("subtotal")), "delivery": number(cart.get("delivery")),
            "minimum_value_reached": cart.get("minimum_value_reached") if isinstance(cart.get("minimum_value_reached"), bool) else None,
        },
    }
