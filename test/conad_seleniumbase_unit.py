"""Offline runtime tests: Python standard library only, no account or browser."""

import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1] / "runtime" / "conad"
sys.path.insert(0, str(RUNTIME))
import actions
import browser
import model
import worker

STORE = {"store_id": "010001", "name": "Test Store", "address": "Synthetic address", "fulfilment": "pickup", "provider": "conad"}
FIXTURE = Path(__file__).parent / "fixtures" / "conad-basket.json"


def snapshot():
    return json.loads(FIXTURE.read_text())


def raw_state(account="test-account"):
    return {
        "url": browser.BASE + "/home", "authenticated": account is not None,
        "_identities": {"utenzaId": account, "email": "test@example.test"} if account else None,
        "login_form": False, "remember_session": None, "store": STORE,
    }


class FakeCDP:
    def __init__(self):
        self.raw = raw_state()
        self.checked = False
        self.banner = True
        self.clicks = []

    def evaluate(self, script):
        if script == browser.STATE_SCRIPT:
            return copy.deepcopy(self.raw)
        if "onetrust-reject-all-handler" in script:
            return not self.banner
        if "mantain" in script:
            return self.checked
        raise AssertionError("Unexpected evaluation in the fake browser")

    def is_element_visible(self, selector):
        return self.banner if selector == browser.REJECT else True

    def click(self, selector, **_kwargs):
        self.clicks.append(selector)
        if selector == browser.REJECT:
            self.banner = False
        elif selector == browser.REMEMBER_LABEL:
            self.checked = not self.checked


class DataTests(unittest.TestCase):
    def test_compact_boolean_update_flags_are_not_quantities(self):
        result = model.basket_from_snapshot(snapshot(), STORE)
        line = result["basket"]["items"][0]
        self.assertEqual(line["quantity"], 1)
        self.assertEqual(line["item_id"], "0")
        self.assertEqual(line["unit_price"], 1.79)
        self.assertEqual(result["basket"]["total_cost"], 7.69)
        self.assertEqual(result["summary"]["delivery"], 5.9)

    def test_unknown_prices_stay_unknown(self):
        data = snapshot()
        data["cards"][0]["product"]["entries"][0]["totalPrice"] = None
        data["cart"]["total"] = None
        result = model.basket_from_snapshot(data, STORE)["basket"]
        self.assertIsNone(result["items"][0]["unit_price"])
        self.assertIsNone(result["items"][0]["total_price"])
        self.assertIsNone(result["total_cost"])

    def test_explicit_unavailability_is_not_reported_as_a_free_product(self):
        data = snapshot()
        data["cart"]["entries"][0]["outOfStock"] = True
        data["cards"][0]["product"]["entries"][0]["totalPrice"]["value"] = 0
        line = model.basket_from_snapshot(data, STORE)["basket"]["items"][0]
        self.assertIs(line["in_stock"], False)
        self.assertIsNone(line["unit_price"])
        self.assertIsNone(line["total_price"])

    def test_invalid_quantities_and_inconsistent_identity_are_errors(self):
        for value in (False, True, None, 0, -1, float("nan")):
            data = snapshot()
            data["cards"][0]["product"]["entries"][0]["qty"] = value
            with self.subTest(quantity=value), self.assertRaises(model.ConadError):
                model.basket_from_snapshot(data, STORE)
        data = snapshot()
        data["cart"]["entries"][0]["productCode"] = "wrong-product"
        with self.assertRaises(model.ConadError):
            model.basket_from_snapshot(data, STORE)

    def test_only_confirmed_empty_ui_can_be_empty(self):
        with self.assertRaises(model.ConadError):
            model.basket_from_snapshot({"cart": None, "cards": [], "empty_visible": False}, STORE)
        result = model.basket_from_snapshot({"cart": None, "cards": [], "empty_visible": True}, STORE)
        self.assertEqual(result["basket"]["items"], [])
        self.assertEqual(result["basket"]["total_cost"], 0)

    def test_variable_or_unknown_cart_mode_is_read_only(self):
        data = snapshot()
        data["cards"][0]["product"]["variations"] = {"unit": "KG"}
        result = model.basket_from_snapshot(data, STORE)
        with self.assertRaises(model.ConadError):
            actions.editable(result, "100001")
        data = snapshot()
        data["ordinary_cart"] = None
        with self.assertRaises(model.ConadError):
            actions.editable(model.basket_from_snapshot(data, STORE))

    def test_concurrent_cart_edit_is_not_overridden(self):
        old = model.basket_from_snapshot(snapshot(), STORE)
        changed = copy.deepcopy(old)
        changed["basket"]["items"][0]["quantity"] = 2
        with patch.object(actions, "capture", return_value=changed), patch.object(actions, "product") as product:
            with self.assertRaises(model.ConadError) as error:
                actions.set_quantity(None, old, "100001", 0)
            self.assertEqual(error.exception.code, "CONAD_CART_CHANGED")
            product.assert_not_called()

    def test_write_must_be_confirmed_once_without_retry(self):
        old = model.basket_from_snapshot(snapshot(), STORE)
        session = types.SimpleNamespace(cdp=types.SimpleNamespace(is_element_visible=lambda _s: True), local=lambda _s: STORE)
        session.wait = lambda *_args: None
        clicks = []
        session.click = lambda selector, mutation=False: clicks.append(selector)
        with patch.object(actions, "capture", side_effect=[old, old]), patch.object(actions, "product", return_value={"variable": False, "quantity": 1, "cart": {"code": "synthetic-basket", "total_quantity": 1, "entries": [["0", "100001"]]}}):
            with self.assertRaises(model.ConadError):
                actions.set_quantity(session, old, "100001", 2)
        self.assertEqual(len(clicks), 1)

    def test_large_deltas_are_rejected_before_browser_work(self):
        old = model.basket_from_snapshot(snapshot(), STORE)
        with patch.object(actions, "capture") as capture:
            with self.assertRaises(model.ConadError):
                actions.set_quantity(None, old, "100001", 100)
            capture.assert_not_called()


class SessionTests(unittest.TestCase):
    def test_binding_keeps_the_same_identity_kind_when_user_data_finishes_loading(self):
        with tempfile.TemporaryDirectory() as folder:
            cdp = FakeCDP()
            cdp.raw["_identities"]["utenzaId"] = None
            session = browser.BrowserSession(types.SimpleNamespace(cdp=cdp), Path(folder))
            session.state()
            self.assertEqual(session.binding_kind, "email")
            cdp.raw["_identities"]["utenzaId"] = "test-account"
            self.assertTrue(session.state()["authenticated"])

    def test_owned_browser_and_temp_files_are_cleaned_up_on_action_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "drivers").mkdir()
            (root / "drivers" / "uc_driver").write_text("synthetic driver")
            driver = types.SimpleNamespace(
                activate_cdp_mode=lambda _url: None,
                quit=unittest.mock.Mock(),
            )
            launcher = types.SimpleNamespace(override_driver_dir=unittest.mock.Mock())
            package = types.SimpleNamespace(__file__=str(root / "__init__.py"), Driver=unittest.mock.Mock(return_value=driver))
            modules = {"seleniumbase": package, "seleniumbase.core": types.SimpleNamespace(browser_launcher=launcher)}
            initial = Path.cwd()
            work = None
            with patch.dict(sys.modules, modules), patch.object(browser, "block_direct_requests"):
                with self.assertRaises(RuntimeError):
                    with browser.launch_browser(root, None):
                        work = Path.cwd()
                        raise RuntimeError("synthetic failure")
            driver.quit.assert_called_once()
            self.assertEqual(Path.cwd(), initial)
            self.assertFalse(work.exists())

    def test_cookie_rejection_and_remember_preference_are_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            cdp = FakeCDP()
            session = browser.BrowserSession(types.SimpleNamespace(cdp=cdp), Path(folder))
            self.assertTrue(session.reject_cookies(timeout=0))
            self.assertFalse(session.reject_cookies(timeout=0))
            session.set_remember()
            session.set_remember()
            self.assertEqual(cdp.clicks, [browser.REJECT, browser.REMEMBER_LABEL])

    def test_account_binding_survives_restart_without_exposing_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            cdp = FakeCDP()
            profile = Path(folder)
            session = browser.BrowserSession(types.SimpleNamespace(cdp=cdp), profile)
            public = session.state()
            binding = session.binding_path.read_text()
            self.assertNotIn("test-account", binding)
            self.assertNotIn("_identities", public)
            self.assertEqual(session.binding_path.stat().st_mode & 0o777, 0o600)
            cdp.raw = raw_state(None)
            restarted = browser.BrowserSession(types.SimpleNamespace(cdp=cdp), profile)
            with self.assertRaises(model.ConadError) as error:
                restarted.local()
            self.assertEqual(error.exception.code, "CONAD_INTERACTION_REQUIRED")
            cdp.raw = raw_state("different-account")
            with self.assertRaises(model.ConadError) as error:
                restarted.state()
            self.assertEqual(error.exception.code, "CONAD_ACCOUNT_CHANGED")
            self.assertEqual(session.binding_path.read_text(), binding)

    def test_profile_lock_precedes_launch_and_covers_different_sockets(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder)
            with worker.ProfileLock(profile):
                with self.assertRaises(model.ConadError) as error:
                    with worker.ProfileLock(profile):
                        self.fail("second worker acquired an active profile")
                self.assertEqual(error.exception.code, "CONAD_PROFILE_BUSY")
            with worker.ProfileLock(profile):
                pass

    def test_main_never_launches_a_second_browser_for_a_locked_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder)
            args = types.SimpleNamespace(
                profile=profile, socket=profile / "different.sock", stop=False,
                idle_timeout=900, reuse_profile=True, binary=None,
            )
            with worker.ProfileLock(profile), patch.object(worker, "launch_browser") as launch:
                with self.assertRaises(model.ConadError) as error:
                    worker.main(args)
                self.assertEqual(error.exception.code, "CONAD_PROFILE_BUSY")
                launch.assert_not_called()

    def test_unsafe_profile_permissions_and_binding_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder) / "profile"
            profile.mkdir(mode=0o755)
            profile.chmod(0o755)
            with self.assertRaises(model.ConadError):
                browser.private_directory(profile)
            profile.chmod(0o700)
            (profile / ".open-supermarkets-account.json").symlink_to(Path(folder) / "missing")
            with self.assertRaises(model.ConadError):
                browser.BrowserSession(types.SimpleNamespace(cdp=FakeCDP()), profile)

    def test_requests_preflight_is_stopped_before_network(self):
        calls = []
        class Session:
            def request(self, method, url, *args, **kwargs):
                calls.append(url)
                return "local protocol"

            def send(self, request, *args, **kwargs):
                calls.append(request.url)
                return "local protocol"
        fake = types.SimpleNamespace(sessions=types.SimpleNamespace(Session=Session))
        with patch.dict(sys.modules, {"requests": fake}):
            browser.block_direct_requests()
            with self.assertRaises(model.ConadError):
                Session().request("GET", browser.BASE)
            with self.assertRaises(model.ConadError):
                Session().send(types.SimpleNamespace(url=browser.BASE))
            self.assertEqual(calls, [])
            self.assertEqual(Session().request("GET", "http://127.0.0.1:9223/json"), "local protocol")


class ProtocolTests(unittest.TestCase):
    key = "a" * 64

    def test_python_and_native_output_are_suppressed_but_protocol_remains_available(self):
        script = f"""
import os,sys
sys.path.insert(0,{str(RUNTIME)!r})
import worker
try:
    with worker.quiet_framework_output():
        print('synthetic-private-password')
        os.write(1,b'synthetic-native-secret\\n')
        os.write(2,b'synthetic-stderr-secret\\n')
        sys.__stdout__.write('synthetic-buffered-secret')
        raise RuntimeError('synthetic-failure')
except RuntimeError:
    worker.emit({{'safe':True}})
"""
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"safe": True})
        self.assertEqual(result.stderr, "")

    def request(self, action="hello", args=None, deadline=None, key=None):
        return {"protocol_version": 1, "profile_key": key or self.key, "action": action, "args": args or {}, "deadline_ms": deadline if deadline is not None else int((time.time() + 5) * 1000)}

    def exchange(self, request, dispatch=None, raw=None):
        client, server = socket.socketpair()
        try:
            client.sendall(raw if raw is not None else (json.dumps(request) + "\n").encode())
            with patch.object(worker, "dispatch", dispatch or (lambda *_args: {"confirmed": True})) as call:
                stop = worker.handle_connection(server, types.SimpleNamespace(), self.key)
            server.shutdown(socket.SHUT_WR)
            response = json.loads(client.makefile("rb").readline())
            return response, stop, call
        finally:
            client.close()
            server.close()

    def test_wrong_profile_and_invalid_json_never_dispatch(self):
        for request, raw in [(self.request(key="b" * 64), None), (None, b'{"password":"synthetic-secret"}\n')]:
            calls = []
            response, stop, _ = self.exchange(request, lambda *args: calls.append(args), raw=raw)
            self.assertFalse(response["ok"])
            self.assertFalse(stop)
            self.assertEqual(calls, [])
            self.assertNotIn("synthetic-secret", json.dumps(response))

    def test_expired_queued_write_does_not_run_or_stop_worker(self):
        calls = []
        response, stop, _ = self.exchange(self.request("basket_add", deadline=0), lambda *args: calls.append(args))
        self.assertFalse(response["ok"])
        self.assertFalse(response["error"]["mutation_may_have_applied"])
        self.assertFalse(stop)
        self.assertEqual(calls, [])

    def test_partial_write_timeout_is_explicit_and_stops_browser_reuse(self):
        def interrupted(session, *_args):
            session.context.before_write()
            raise model.DeadlineExceeded()
        response, stop, _ = self.exchange(self.request("basket_add"), interrupted)
        self.assertTrue(response["error"]["mutation_may_have_applied"])
        self.assertTrue(stop)

    def test_framework_exception_contents_are_never_returned(self):
        def failed(*_args):
            raise RuntimeError("synthetic-private-password cookie=synthetic-token")
        response, _, _ = self.exchange(self.request("login"), failed)
        self.assertNotIn("synthetic-private-password", json.dumps(response))
        self.assertNotIn("synthetic-token", json.dumps(response))
        self.assertEqual(response["error"]["code"], "CONAD_BROWSER_ERROR")

    def test_client_disconnect_does_not_escape_response_handling(self):
        client, server = socket.socketpair()
        try:
            client.sendall((json.dumps(self.request()) + "\n").encode())
            client.close()
            self.assertFalse(worker.handle_connection(server, None, self.key))
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
