# Conad SeleniumBase runtime

The Conad adapter deliberately uses SeleniumBase **4.57.1**, `Driver(uc=True)` and
CDP Mode. It does not replace other providers' authentication engines. The
optional runtime lives under `runtime/conad/` and is included in the npm tarball;
source documentation and developer tests are not shipped.

## Requirements

- Node.js 18+ for the common CLI/MCP/HTTP surfaces.
- Python 3.10+ on Linux/macOS, a compatible Chrome and SeleniumBase.
- A visible display (or Xvfb plus a protected viewer for human onboarding).
- A private persistent profile directory owned by the service user, mode `0700`.

The existing Node-only Dockerfile does not install these optional dependencies.
Provision them in the deployment image before enabling Conad. Tested browser
setup: Python 3.12, Chrome 157, SeleniumBase 4.57.1. Unit tests on other Python
versions do not imply live retailer/browser verification on those versions.

From a source checkout:

```bash
python3 -m venv .venv-seleniumbase
.venv-seleniumbase/bin/python -m pip install -r runtime/conad/requirements.txt
# Match the major version to the Chrome installed in the image.
.venv-seleniumbase/bin/seleniumbase get uc_driver 157
export CONAD_PYTHON="$PWD/.venv-seleniumbase/bin/python"
export CONAD_BROWSER_EXECUTABLE=/path/to/chrome
export CONAD_PROFILE_DIR=/private/persistent/conad-profile
npm ci
npm run build
```

For a global npm installation, the requirements file is also available at
`$(npm root -g)/open-supermarkets/runtime/conad/requirements.txt`.
The worker requires an already provisioned driver and uses a private temporary
copy for patching/locking. It does not write into installed site-packages or
silently download drivers while handling a grocery request.

## MCP configuration

```json
{
  "mcpServers": {
    "groceries": {
      "command": "node",
      "args": ["/app/open-supermarkets/dist/mcp-server.js"],
      "env": {
        "CONAD_PYTHON": "/app/open-supermarkets/.venv-seleniumbase/bin/python",
        "CONAD_BROWSER_EXECUTABLE": "/path/to/chrome",
        "CONAD_PROFILE_DIR": "/private/persistent/profiles/conad-user-1"
      }
    }
  }
}
```

The first Conad operation starts the worker lazily. A profile lock is acquired
**before** launching Chrome; different socket names cannot open two workers for
one profile. The worker reuses the browser across calls and serializes operations.
It closes after 15 minutes without requests by default. Chrome is closed and
its profile retained on normal shutdown, signal or handled failure.

Each account needs its own profile and MCP/service configuration. A private hash
of the retailer identity binds an authenticated profile to its account across
restarts. Switching accounts or allowing an expired account to become a guest
basket is rejected; use a separate profile for another account.

Auto-started workers use a private per-user temporary directory and a `0600` Unix
socket. Requests and replies include the protocol version and canonical profile
hash. An explicitly configured `CONAD_RUNTIME_SOCKET` is **supervisor-managed**:
the client verifies it but does not start a replacement if it is absent. Configure
the matching `CONAD_PROFILE_DIR` as well; wrong-profile connections fail before a
shopping operation.

## Supervised worker and manual onboarding

A new manual profile is empty by default; reuse requires an explicit flag:

```bash
python3 runtime/conad/worker.py --profile /private/new-profile --binary /path/to/chrome
```

The interactive helper supports newline-delimited JSON on stdin:

```json
{"action":"status"}
{"action":"submit_login"}
{"action":"quit"}
```

Do not type credentials into this protocol. Enter them in the visible browser.
The helper rejects optional cookies on both domains, selects the visible
persistent-login label by default and leaves challenges/profile completion to the
user. `CONAD_REMEMBER_SESSION=false` changes the initial checkbox preference.
There are no CAPTCHA solver calls or automatic choices of carts/terms/payment.
A redirect alone never confirms authentication.

For a service supervisor:

```bash
mkdir -m 700 -p /private/conad-runtime
python3 runtime/conad/worker.py --profile /private/profile --reuse-profile \
  --socket /private/conad-runtime/browser.sock --idle-timeout 900
```

Then point `CONAD_RUNTIME_SOCKET` at that socket. The supervisor owns the worker
PID and should send SIGTERM for shutdown; a foreground helper can also be stopped
with Ctrl-C. The worker closes Chrome and releases its profile lock in either
case. Shutdown preserves the profile and does not revoke the retailer session.
Logout must be completed in MyConad. Stop a manual helper before starting a
service with the same profile. Never publish the socket or Chrome debug port.

## Failure and privacy boundaries

Every request has an absolute deadline, including queue time. Expired queued
writes are rejected before browser work. An interrupted browser operation closes
the worker rather than reusing a potentially inconsistent CDP connection. A write
that may have applied is identified explicitly and must be followed by a read;
it is never automatically replayed. Startup errors are reported through bounded,
structured messages rather than raw browser exceptions.

Browser-library stdout/stderr are suppressed because exceptions can contain form
values or page source. Public responses use allowlists; no raw user object,
password, cookie, private delivery address or payment data is returned. The
profile directory remains sensitive authentication material: keep it out of Git,
logs and shared volumes.

Only browser navigation and controls contact the retailer. `Driver.get()` is not
used because UC Mode may issue a Python `requests.get()` preflight. The runtime
also guards external `requests` calls, including redirects, and bypasses proxies
only for the browser's loopback control endpoints. Retailer browsing still uses
Chrome normally. `enable_ws=True` is retained. SeleniumBase 4.57.1 itself adds
`--no-sandbox`; isolate this optional service appropriately rather than assuming
Chrome's OS sandbox is active.

## Upstream references

- [UC Mode](https://seleniumbase.io/help_docs/uc_mode/): Driver semantics, reconnect/disconnect and headless/display caveats.
- [CDP Mode](https://seleniumbase.io/examples/cdp_mode/ReadMe/): browser control while WebDriver is disconnected.
- [CDP methods](https://seleniumbase.io/help_docs/cdp_mode_methods/): navigation, interaction, DOM reads and waits.
- [Options](https://seleniumbase.io/help_docs/customizing_test_runs/): profile, browser and security settings.
- [Syntax formats](https://seleniumbase.io/help_docs/syntax_formats/): Driver versus context-manager/test-runner lifecycles.

Passing a browser fingerprint test is not a promise that a retailer will accept
all future sessions. Treat protection failures as errors, never empty catalogues.
