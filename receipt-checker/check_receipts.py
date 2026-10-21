"""Receipt checker for the Dink for the Roots organizer.

Commands:
  python check_receipts.py run [--dry-run]   pull pending receipts, check them, write results
  python check_receipts.py check <image>     local check of one image, prints JSON, no network

Config is read from .env in this folder. Never print ADMIN_KEY.
"""

import argparse
import json
import os
import socket
import sys
import urllib.request
from dataclasses import dataclass
from datetime import date
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin

import receipt_analysis as ra

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ENV = os.path.join(HERE, ".env")
REDIRECT_CODES = (301, 302, 303, 307, 308)
MAX_REDIRECTS = 5
REQUEST_TIMEOUT = 60
MAX_RUN_ROUNDS = 1000

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_CONFIG = 2


class ConfigError(Exception):
    pass


class ApiError(Exception):
    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass
class Config:
    endpoint: str
    admin_key: str
    expected_amount: float
    expected_recipient: str
    event_window_start: date


def load_env(path):
    """Parse KEY=VALUE lines. Blank lines and lines starting with # are skipped."""
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key.strip()] = value
    return values


def load_config(path, require_endpoint):
    values = load_env(path)
    endpoint = values.get("ENDPOINT", "")
    admin_key = values.get("ADMIN_KEY", "")
    if require_endpoint:
        if not endpoint.startswith("https://"):
            raise ConfigError("ENDPOINT in .env must be the https Apps Script /exec URL.")
        if not admin_key:
            raise ConfigError("ADMIN_KEY in .env is empty.")
    try:
        expected_amount = float(values.get("EXPECTED_AMOUNT", "1200"))
    except ValueError:
        raise ConfigError("EXPECTED_AMOUNT must be a number.")
    try:
        window = date.fromisoformat(values.get("EVENT_WINDOW_START", "2026-10-01"))
    except ValueError:
        raise ConfigError("EVENT_WINDOW_START must use YYYY-MM-DD.")
    return Config(
        endpoint=endpoint,
        admin_key=admin_key,
        expected_amount=expected_amount,
        expected_recipient=values.get("EXPECTED_RECIPIENT", "").strip(),
        event_window_start=window,
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Return redirect responses to the caller, which follows them with GET."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ApiClient:
    """Minimal JSON client for the Apps Script web app."""

    def __init__(self, endpoint, admin_key, opener=None, timeout=REQUEST_TIMEOUT):
        self.endpoint = endpoint
        self.admin_key = admin_key
        self.timeout = timeout
        self.opener = opener or urllib.request.build_opener(_NoRedirect)

    def _send(self, url, body, method):
        headers = {"Content-Type": "text/plain;charset=utf-8", "Accept": "application/json"}
        return urllib.request.Request(url, data=body, headers=headers, method=method)

    def _read_json(self, url, body, method):
        """Send one request. Follow Apps Script 302 redirects with GET, as the web app expects."""
        for _ in range(MAX_REDIRECTS + 1):
            request = self._send(url, body, method)
            try:
                response = self.opener.open(request, timeout=self.timeout)
            except HTTPError as exc:
                location = exc.headers.get("Location") if exc.headers else None
                if exc.code in REDIRECT_CODES and location:
                    url = urljoin(url, location)
                    body, method = None, "GET"
                    continue
                raise ApiError(f"HTTP_{exc.code}", "the web app returned an HTTP error")
            except (URLError, socket.timeout, OSError) as exc:
                reason = getattr(exc, "reason", exc)
                raise ApiError("NETWORK", f"could not reach the web app ({reason})")
            raw = response.read()
            try:
                return json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise ApiError("BAD_RESPONSE", "the web app did not return JSON")
        raise ApiError("REDIRECT_LOOP", "too many redirects from the web app")

    def call(self, payload):
        if payload.get("action") != "slots":
            payload = {**payload, "key": self.admin_key}
        body = json.dumps(payload).encode("utf-8")
        data = self._read_json(self.endpoint, body, "POST")
        if not isinstance(data, dict):
            raise ApiError("BAD_RESPONSE", "the web app returned an unexpected shape")
        if data.get("ok") is not True:
            raise ApiError(str(data.get("error", "UNKNOWN")), str(data.get("message", "no message")))
        return data

    def pending(self):
        return self.call({"action": "pending"}).get("items", [])

    def refs(self):
        return self.call({"action": "refs"}).get("refs", [])

    def verify(self, ref, result):
        return self.call({"action": "verify", "ref": ref, "result": result})


def analyze_item(item, cfg, refs):
    """Analyze one pending receipt item from the web app."""
    return ra.analyze_base64(
        item.get("base64", ""),
        expected_amount=cfg.expected_amount,
        expected_recipient=cfg.expected_recipient or None,
        window_start=cfg.event_window_start,
        refs=refs,
        own_ref=item.get("ref"),
        payment_ref=item.get("paymentRef") or None,
    )


def run_checker(cfg, client, dry_run, out=sys.stdout, err=sys.stderr):
    """Process every pending receipt. Returns the process exit code."""
    try:
        refs = client.refs()
    except ApiError as exc:
        print(f"Could not read existing references: {exc.code}. {exc.message}", file=err)
        return EXIT_FAILURE

    seen = set()
    counts = {ra.VERDICT_VERIFIED: 0, ra.VERDICT_REVIEW: 0, ra.VERDICT_SUSPECT: 0}
    failures = 0
    for _ in range(MAX_RUN_ROUNDS):
        try:
            items = client.pending()
        except ApiError as exc:
            print(f"Could not read pending receipts: {exc.code}. {exc.message}", file=err)
            return EXIT_FAILURE
        fresh = [item for item in items if item.get("ref") and item["ref"] not in seen]
        if not fresh:
            break
        for item in fresh:
            seen.add(item["ref"])
            result = analyze_item(item, cfg, refs)
            if not dry_run:
                try:
                    client.verify(item["ref"], result)
                except ApiError as exc:
                    failures += 1
                    print(f"{item['ref']}: verify failed, {exc.code}. {exc.message}", file=err)
                    continue
            counts[result["verdict"]] = counts.get(result["verdict"], 0) + 1
            refs.append({"ref": item["ref"], "referenceNo": result["referenceNo"], "imageHash": result["imageHash"]})
            print(f"{item['ref']}: {result['verdict']} (score {result['tamperScore']}, "
                  f"{len(result['flags'])} flag(s))", file=out)
    else:
        print("Stopped after the round limit. Run the checker again.", file=err)
        return EXIT_FAILURE

    mode = "dry run, nothing written" if dry_run else "results written"
    print(f"Done ({mode}). Verified: {counts[ra.VERDICT_VERIFIED]}, "
          f"Needs review: {counts[ra.VERDICT_REVIEW]}, Suspect: {counts[ra.VERDICT_SUSPECT]}, "
          f"write failures: {failures}.", file=out)
    return EXIT_FAILURE if failures else EXIT_OK


def check_image(path, cfg, out=sys.stdout, err=sys.stderr):
    if not os.path.isfile(path):
        print(f"File not found: {path}", file=err)
        return EXIT_CONFIG
    result = ra.analyze_file(
        path,
        expected_amount=cfg.expected_amount,
        expected_recipient=cfg.expected_recipient or None,
        window_start=cfg.event_window_start,
    )
    print(json.dumps(result, indent=2, ensure_ascii=False), file=out)
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(description="Dink for the Roots receipt checker")
    parser.add_argument("--env", default=DEFAULT_ENV, help="path to the .env file")
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run", help="check pending receipts and write results")
    run_parser.add_argument("--dry-run", action="store_true", help="check but do not call verify")
    check_parser = sub.add_parser("check", help="check one image locally, no network")
    check_parser.add_argument("image", help="path to the receipt image")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        cfg = load_config(args.env, require_endpoint=(args.command == "run"))
    except ConfigError as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    if args.command == "check":
        return check_image(args.image, cfg)
    client = ApiClient(cfg.endpoint, cfg.admin_key)
    try:
        return run_checker(cfg, client, args.dry_run)
    except Exception as exc:  # last resort so the window shows a clear message
        print(f"Unexpected error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_FAILURE


if __name__ == "__main__":
    sys.exit(main())
