import base64
import json
import os
import sys
import tempfile
import unittest
from datetime import date
from email.message import Message
from io import BytesIO, StringIO
from urllib.error import HTTPError, URLError

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from PIL import Image, ImageDraw  # noqa: E402

import check_receipts as cr  # noqa: E402
import receipt_analysis as ra  # noqa: E402

ENDPOINT = "https://script.google.com/macros/s/TEST/exec"
SECRET = "TOP-SECRET-ADMIN-KEY-123"


class FakeResponse:
    def __init__(self, payload):
        self._raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")

    def read(self):
        return self._raw


class FakeOpener:
    """Returns queued results. A result is a dict (JSON body), an exception, or a bytes body."""

    def __init__(self, results):
        self.results = list(results)
        self.requests = []

    def open(self, request, timeout=None):
        body = request.data.decode("utf-8") if request.data else None
        self.requests.append({
            "url": request.full_url,
            "method": request.get_method(),
            "body": body,
            "content_type": request.get_header("Content-type"),
        })
        item = self.results.pop(0)
        if isinstance(item, BaseException):
            raise item
        return FakeResponse(item)


def http_302(location):
    headers = Message()
    headers["Location"] = location
    return HTTPError(ENDPOINT, 302, "Found", headers, None)


def make_png_b64():
    img = Image.new("RGB", (900, 400), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.text((50, 50), "Amount ₱1,000.00", fill=(0, 0, 0))
    draw.text((50, 150), "Ref No. 1234 567 890123", fill=(0, 0, 0))
    buf = BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def write_env(lines):
    handle = tempfile.NamedTemporaryFile("w", suffix=".env", delete=False, encoding="utf-8")
    handle.write("\n".join(lines))
    handle.close()
    return handle.name


class EnvTests(unittest.TestCase):
    def test_parses_values_and_defaults(self):
        path = write_env([
            "# comment",
            "ENDPOINT=https://example.test/exec",
            "ADMIN_KEY=\"quoted-key\"",
            "EXPECTED_AMOUNT=1000",
            "EVENT_WINDOW_START=2026-10-01",
        ])
        try:
            cfg = cr.load_config(path, require_endpoint=True)
        finally:
            os.unlink(path)
        self.assertEqual(cfg.endpoint, "https://example.test/exec")
        self.assertEqual(cfg.admin_key, "quoted-key")
        self.assertEqual(cfg.expected_amount, 1000.0)
        self.assertEqual(cfg.expected_recipient, "")
        self.assertEqual(cfg.event_window_start, date(2026, 10, 1))

    def test_missing_key_is_config_error_for_run(self):
        path = write_env(["ENDPOINT=https://example.test/exec"])
        try:
            with self.assertRaises(cr.ConfigError):
                cr.load_config(path, require_endpoint=True)
        finally:
            os.unlink(path)

    def test_check_does_not_need_endpoint(self):
        cfg = cr.load_config(os.path.join(HERE, "does-not-exist.env"), require_endpoint=False)
        self.assertEqual(cfg.expected_amount, 1000.0)

    def test_rejects_http_endpoint(self):
        path = write_env(["ENDPOINT=http://example.test/exec", "ADMIN_KEY=k"])
        try:
            with self.assertRaises(cr.ConfigError):
                cr.load_config(path, require_endpoint=True)
        finally:
            os.unlink(path)


class ClientTests(unittest.TestCase):
    def test_post_is_text_plain_and_carries_key_in_body(self):
        opener = FakeOpener([{"ok": True, "items": []}])
        client = cr.ApiClient(ENDPOINT, SECRET, opener=opener)
        client.pending()
        sent = opener.requests[0]
        self.assertEqual(sent["method"], "POST")
        self.assertEqual(sent["content_type"], "text/plain;charset=utf-8")
        self.assertEqual(json.loads(sent["body"]), {"action": "pending", "key": SECRET})

    def test_slots_is_sent_without_key(self):
        opener = FakeOpener([{"ok": True, "open": True, "slots": {}}])
        cr.ApiClient(ENDPOINT, SECRET, opener=opener).call({"action": "slots"})
        self.assertNotIn(SECRET, opener.requests[0]["body"])

    def test_302_is_followed_with_get(self):
        location = "https://script.googleusercontent.com/macros/echo?user_content_key=abc"
        opener = FakeOpener([http_302(location), {"ok": True, "refs": []}])
        refs = cr.ApiClient(ENDPOINT, SECRET, opener=opener).refs()
        self.assertEqual(refs, [])
        self.assertEqual(opener.requests[1]["method"], "GET")
        self.assertEqual(opener.requests[1]["url"], location)
        self.assertIsNone(opener.requests[1]["body"])

    def test_error_response_maps_to_api_error(self):
        opener = FakeOpener([{"ok": False, "error": "FORBIDDEN", "message": "Wrong admin key."}])
        with self.assertRaises(cr.ApiError) as ctx:
            cr.ApiClient(ENDPOINT, SECRET, opener=opener).pending()
        self.assertEqual(ctx.exception.code, "FORBIDDEN")
        self.assertEqual(ctx.exception.message, "Wrong admin key.")

    def test_network_error_is_clear(self):
        opener = FakeOpener([URLError("name resolution failed")])
        with self.assertRaises(cr.ApiError) as ctx:
            cr.ApiClient(ENDPOINT, SECRET, opener=opener).pending()
        self.assertEqual(ctx.exception.code, "NETWORK")

    def test_non_json_body(self):
        opener = FakeOpener([b"<html>login</html>"])
        with self.assertRaises(cr.ApiError) as ctx:
            cr.ApiClient(ENDPOINT, SECRET, opener=opener).pending()
        self.assertEqual(ctx.exception.code, "BAD_RESPONSE")


class FakeClient:
    def __init__(self, pending_batches, fail_verify=False):
        self.pending_batches = list(pending_batches)
        self.fail_verify = fail_verify
        self.verified = []

    def refs(self):
        return []

    def pending(self):
        return self.pending_batches.pop(0) if self.pending_batches else []

    def verify(self, ref, result):
        if self.fail_verify:
            raise cr.ApiError("INTERNAL", "sheet busy")
        self.verified.append((ref, result))
        return {"ok": True}


class RunTests(unittest.TestCase):
    def setUp(self):
        self.cfg = cr.Config(endpoint=ENDPOINT, admin_key=SECRET, expected_amount=1000.0,
                             expected_recipient="", event_window_start=date(2026, 10, 1))
        self.item = {"ref": "DFR-000001", "paymentRef": "", "base64": make_png_b64()}

    def test_run_verifies_each_item_and_stops_when_empty(self):
        client = FakeClient([[self.item], [self.item]])
        out, err = StringIO(), StringIO()
        code = cr.run_checker(self.cfg, client, dry_run=False, out=out, err=err)
        self.assertEqual(code, cr.EXIT_OK)
        self.assertEqual(len(client.verified), 1)
        ref, result = client.verified[0]
        self.assertEqual(ref, "DFR-000001")
        self.assertEqual(result["amount"], 1000.0)
        self.assertIn("Verified", out.getvalue())
        self.assertNotIn(SECRET, out.getvalue() + err.getvalue())

    def test_dry_run_never_calls_verify(self):
        client = FakeClient([[self.item], [self.item]])
        out = StringIO()
        code = cr.run_checker(self.cfg, client, dry_run=True, out=out, err=StringIO())
        self.assertEqual(code, cr.EXIT_OK)
        self.assertEqual(client.verified, [])
        self.assertIn("dry run", out.getvalue())

    def test_verify_failure_gives_nonzero_exit(self):
        client = FakeClient([[self.item], [self.item]], fail_verify=True)
        err = StringIO()
        code = cr.run_checker(self.cfg, client, dry_run=False, out=StringIO(), err=err)
        self.assertEqual(code, cr.EXIT_FAILURE)
        self.assertIn("verify failed", err.getvalue())
        self.assertNotIn(SECRET, err.getvalue())

    def test_network_error_at_pending_gives_nonzero_exit(self):
        class Broken(FakeClient):
            def pending(self):
                raise cr.ApiError("NETWORK", "could not reach the web app")

        err = StringIO()
        code = cr.run_checker(self.cfg, Broken([]), dry_run=False, out=StringIO(), err=err)
        self.assertEqual(code, cr.EXIT_FAILURE)
        self.assertIn("NETWORK", err.getvalue())


class CheckCommandTests(unittest.TestCase):
    def test_missing_file_exit_code(self):
        cfg = cr.load_config(os.path.join(HERE, "does-not-exist.env"), require_endpoint=False)
        err = StringIO()
        code = cr.check_image(os.path.join(HERE, "nope.png"), cfg, out=StringIO(), err=err)
        self.assertEqual(code, cr.EXIT_CONFIG)

    def test_prints_json_without_network(self):
        cfg = cr.load_config(os.path.join(HERE, "does-not-exist.env"), require_endpoint=False)
        fd, path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            img = Image.new("RGB", (400, 200), (255, 255, 255))
            ImageDraw.Draw(img).text((20, 20), "Amount ₱500.00", fill=(0, 0, 0))
            img.save(path, "PNG")
            out = StringIO()
            code = cr.check_image(path, cfg, out=out, err=StringIO())
        finally:
            os.unlink(path)
        self.assertEqual(code, cr.EXIT_OK)
        data = json.loads(out.getvalue())
        self.assertEqual(data["amount"], 500.0)
        self.assertIn(data["verdict"], (ra.VERDICT_SUSPECT, ra.VERDICT_REVIEW))


if __name__ == "__main__":
    unittest.main()
