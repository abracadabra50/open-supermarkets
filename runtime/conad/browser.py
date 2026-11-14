"""SeleniumBase lifecycle, account binding and privacy-safe browser operations."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import time
from urllib.parse import urlencode, urlsplit

from model import ConadError, RequestContext, same_store, store_context

BASE = "https://spesaonline.conad.it"
LOGIN_ORIGIN = "https://my.conad.it"
LOGIN_URL = LOGIN_ORIGIN + "/login?" + urlencode({"cb": BASE + "/entry"})
REJECT = "#onetrust-reject-all-handler"
PASSWORD = 'input[name="password"]'
REMEMBER = 'input[name="mantain"]'
REMEMBER_LABEL = 'label[aria-label="Mantieni la sessione attiva"]'
STATE_SCRIPT = r"""(() => {
  const u = window.user, s = window.pointOfService, t = window.typeOfService;
  const authenticated = location.origin === 'https://spesaonline.conad.it' &&
    !!u && typeof u === 'object' && Object.keys(u).length > 0;
  const identities = {
    utenzaId: authenticated && ['string', 'number'].includes(typeof u.utenzaId) ? String(u.utenzaId) : null,
    email: authenticated && typeof u.email === 'string' ? u.email.trim().toLowerCase() : null
  };
  return {
    url: location.origin + location.pathname, authenticated, _identities: identities,
    login_form: !!document.querySelector('input[name="password"]'),
    remember_session: document.querySelector('input[name="mantain"]')?.checked ?? null,
    store: location.origin === 'https://spesaonline.conad.it' && s && ['HOME_DELIVERY', 'ORDER_AND_COLLECT'].includes(t) ? {
      store_id: s.name, name: s.businessName || ('Conad ' + s.name),
      address: s.address?.formattedAddress, fulfilment: t === 'HOME_DELIVERY' ? 'delivery' : 'pickup'
    } : null
  };
})()"""


def private_directory(path: Path, create=True) -> Path:
    path = path.expanduser().resolve()
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ConadError("CONAD_PROFILE_ERROR", "Conad profile/runtime directories must be owned by this user with mode 0700.")
    return path


def private_file(path: Path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ConadError("CONAD_PROFILE_ERROR", "Conad state files must be private regular files owned by this user.")


def write_private_json(path: Path, data):
    if path.exists() or path.is_symlink():
        private_file(path)
    fd, name = tempfile.mkstemp(prefix=".conad-state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def block_direct_requests():
    import requests
    original = requests.sessions.Session.request
    original_send = getattr(requests.sessions.Session, "send", None)
    for name, other in (("NO_PROXY", "no_proxy"), ("no_proxy", "NO_PROXY")):
        current = os.environ.get(name, os.environ.get(other, ""))
        entries = [value.strip() for value in current.split(",") if value.strip()]
        for local in ("localhost", "127.0.0.1", "::1"):
            if local not in entries:
                entries.append(local)
        os.environ[name] = ",".join(entries)

    def allowed(url):
        if urlsplit(str(url)).hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ConadError("CONAD_BROWSER_ERROR", "Direct Python HTTP requests to websites are disabled; use browser navigation.")

    def browser_only(session, method, url, *args, **kwargs):
        allowed(url)
        return original(session, method, url, *args, **kwargs)

    def send_local(session, request, *args, **kwargs):
        allowed(request.url)  # Also enforce the rule after HTTP redirects.
        return original_send(session, request, *args, **kwargs)

    requests.sessions.Session.request = browser_only
    if original_send is not None:
        requests.sessions.Session.send = send_local


@contextmanager
def launch_browser(profile: Path, binary: str | None):
    """Every exit path closes the owned browser and removes temporary files."""
    driver = None
    original_cwd = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="conad-browser-") as work:
        try:
            os.chdir(work)
            try:
                import seleniumbase
                from seleniumbase import Driver
                from seleniumbase.core import browser_launcher
            except ImportError:
                raise ConadError("CONAD_DEPENDENCY_MISSING", "Install the optional SeleniumBase runtime requirements using CONAD_PYTHON.") from None
            installed = Path(seleniumbase.__file__).parent / "drivers" / "uc_driver"
            if not installed.is_file():
                raise ConadError("CONAD_DEPENDENCY_MISSING", "Provision a Chrome-compatible SeleniumBase uc_driver before starting Conad.")
            cache = Path(work) / "drivers"
            cache.mkdir(mode=0o700)
            target = cache / "uc_driver"
            shutil.copyfile(installed, target)
            target.chmod(0o700)
            browser_launcher.override_driver_dir(str(cache))
            block_direct_requests()
            driver = Driver(
                uc=True, headed=True, headless=False, user_data_dir=str(profile),
                binary_location=binary, driver_version="keep", locale="it-IT",
                enable_ws=True, window_size="1280,900",
            )
            driver.activate_cdp_mode("about:blank")
            yield driver
        finally:
            try:
                if driver is not None:
                    driver.quit()
            finally:
                os.chdir(original_cwd)


class BrowserSession:
    def __init__(self, driver, profile: Path, remember=True):
        self.driver = driver
        self.cdp = driver.cdp
        self.profile = profile
        self.remember = remember
        self.binding_path = profile / ".open-supermarkets-account.json"
        self.account = None
        self.binding_kind = None
        self.context = RequestContext(time.monotonic() + 120)
        if self.binding_path.exists() or self.binding_path.is_symlink():
            private_file(self.binding_path)
            try:
                binding = json.loads(self.binding_path.read_text(encoding="utf-8"))
                account = binding["account"]
                if binding.get("kind") not in ("utenzaId", "email") or binding["version"] != 1 or not isinstance(account, str) or len(account) != 64 or any(c not in "0123456789abcdef" for c in account):
                    raise ValueError()
                self.account = account
                self.binding_kind = binding["kind"]
            except (ValueError, KeyError, TypeError):
                raise ConadError("CONAD_PROFILE_ERROR", "The Conad account binding is invalid; use a fresh dedicated profile.") from None

    def evaluate(self, script):
        self.context.check()
        return self.cdp.evaluate(script)

    def wait(self, script, timeout=20):
        until = min(self.context.deadline, time.monotonic() + timeout)
        failures = 0
        while time.monotonic() < until:
            self.context.check()
            try:
                if self.cdp.evaluate(script):
                    return
            except Exception:
                failures += 1
                if failures >= 3:
                    raise ConadError("CONAD_BROWSER_ERROR", "Conad browser state could not be read; inspect the visible browser.") from None
            time.sleep(.1)
        self.context.check()
        raise ConadError("CONAD_INTERACTION_REQUIRED", "Conad did not present the expected page. Check login, browser challenges and local-store selection.")

    def open(self, path):
        self.navigate(BASE + path)

    def navigate(self, url):
        if urlsplit(url).scheme != "https" or urlsplit(url).netloc not in {"spesaonline.conad.it", "my.conad.it"}:
            raise ConadError("CONAD_INVALID_INPUT", "Only Conad storefront/account navigation is allowed.")
        self.context.check()
        previous = self.evaluate("performance.timeOrigin")
        self.cdp.open(url)
        self.wait("document.readyState !== 'loading' && performance.timeOrigin !== " + json.dumps(previous))

    def click(self, selector, mutation=False):
        self.context.check()
        if mutation:
            self.context.before_write()
        self.cdp.click(selector, timeout=min(10, max(.1, self.context.deadline - time.monotonic())))

    def state(self):
        raw = self.evaluate(STATE_SCRIPT)
        if not isinstance(raw, dict) or not isinstance(raw.get("authenticated"), bool) or not isinstance(raw.get("url"), str):
            raise ConadError("CONAD_PROTOCOL_ERROR", "Conad returned malformed authentication state.")
        identities = raw.pop("_identities", None)
        if raw["authenticated"]:
            if not isinstance(identities, dict):
                raise ConadError("CONAD_PROTOCOL_ERROR", "The authenticated Conad account could not be identified.")
            kind = self.binding_kind or ("utenzaId" if identities.get("utenzaId") else "email")
            identity = identities.get(kind)
            if not isinstance(identity, str) or not 1 <= len(identity) <= 512:
                raise ConadError("CONAD_PROTOCOL_ERROR", "The authenticated Conad account identity is not available yet.")
            digest = hashlib.sha256(json.dumps([kind, identity]).encode()).hexdigest()
            if self.account is not None and digest != self.account:
                raise ConadError("CONAD_ACCOUNT_CHANGED", "This Conad profile is bound to a different account. Use a separate profile for another account.")
            if self.account is None:
                write_private_json(self.binding_path, {"version": 1, "kind": kind, "account": digest})
                self.account = digest
                self.binding_kind = kind
        return {
            "authenticated": raw["authenticated"], "store": store_context(raw.get("store")),
            "url": raw.get("url"), "login_form": raw.get("login_form") is True,
            "remember_session": raw.get("remember_session"),
        }

    def local(self, expected=None):
        current = self.state()
        if self.account and not current["authenticated"]:
            raise ConadError("CONAD_INTERACTION_REQUIRED", "The Conad account session expired. Complete browser login before continuing.")
        store = current["store"]
        if store is None:
            raise ConadError("CONAD_INTERACTION_REQUIRED", "Select the local store and fulfilment service in the visible Conad browser first.")
        if expected is not None and not same_store(store, expected):
            raise ConadError("CONAD_CART_CHANGED", "The Conad store or fulfilment service changed. Review the store and basket before retrying.")
        return store

    def reject_cookies(self, timeout=3):
        until = min(self.context.deadline, time.monotonic() + timeout)
        while True:
            self.context.check()
            if self.cdp.is_element_visible(REJECT):
                self.click(REJECT)
                self.wait("!document.querySelector('#onetrust-reject-all-handler')?.getClientRects().length", 10)
                return True
            if time.monotonic() >= until:
                return False
            time.sleep(.1)

    def prepare_login(self):
        current = self.state()
        if current["authenticated"] or not current["url"].startswith(BASE):
            return current
        self.open("/home")
        self.reject_cookies()
        if self.state()["authenticated"]:
            return self.state()
        self.navigate(LOGIN_URL)
        self.wait("document.readyState !== 'loading'")
        self.reject_cookies()
        if self.cdp.is_element_visible(PASSWORD):
            self.set_remember()
        self.cdp.bring_to_front()
        return self.state()

    def set_remember(self):
        checked = self.evaluate("document.querySelector('input[name=\"mantain\"]')?.checked ?? null")
        if not isinstance(checked, bool):
            raise ConadError("CONAD_PROTOCOL_ERROR", "The Conad persistent-login control is missing.")
        if checked != self.remember:
            self.click(REMEMBER_LABEL)
        if self.evaluate("document.querySelector('input[name=\"mantain\"]').checked") != self.remember:
            raise ConadError("CONAD_BROWSER_ERROR", "The Conad persistent-login preference was not applied.")

    def submit_login(self):
        if self.state()["authenticated"]:
            return self.state()
        if self.state()["url"] != LOGIN_ORIGIN + "/login":
            raise ConadError("CONAD_INTERACTION_REQUIRED", "Complete the account verification in the visible MyConad browser.")
        if not isinstance(self.evaluate("document.querySelector('input[name=\"mantain\"]')?.checked ?? null"), bool):
            raise ConadError("CONAD_PROTOCOL_ERROR", "The Conad persistent-login control is missing.")
        ready = self.evaluate("Boolean(document.querySelector('input[name=\"email\"]')?.value && document.querySelector('input[name=\"password\"]')?.value)")
        if ready is not True:
            raise ConadError("CONAD_INTERACTION_REQUIRED", "Complete the login fields in the visible MyConad browser.")
        self.click('form:has(input[name="password"]) button[type="submit"]')
        until = min(self.context.deadline, time.monotonic() + 30)
        while time.monotonic() < until:
            self.context.check()
            try:
                current = self.state()
            except ConadError:
                raise
            except Exception:
                time.sleep(.1)
                continue
            if current["authenticated"]:
                return current
            time.sleep(.2)
        raise ConadError("CONAD_INTERACTION_REQUIRED", "Conad login was not confirmed. Complete any verification or correct the credentials in the visible browser.")
