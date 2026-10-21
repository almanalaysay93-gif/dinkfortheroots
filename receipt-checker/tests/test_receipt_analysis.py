import base64
import os
import sys
import unittest
from datetime import date, datetime, timezone
from io import BytesIO

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin  # noqa: E402

import receipt_analysis as ra  # noqa: E402

WINDOW = date(2026, 10, 1)
NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
ARIAL = "C:/Windows/Fonts/arial.ttf"
ROW_HEIGHT = 70
AMOUNT_ROW = 2


def _font(size):
    if os.path.exists(ARIAL):
        return ImageFont.truetype(ARIAL, size)
    return ImageFont.load_default(size=size)


def make_receipt(amount="1,000.00", ref="1234 567 890123", date_text="Oct 21, 2026 7:45 PM",
                 recipient="To: Juan D. Cruz"):
    """Draw a GCash-like receipt. Row 2 is the amount row."""
    img = Image.new("RGB", (900, 620), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    big, small = _font(34), _font(28)
    rows = [
        ("GCash", small),
        ("Sent via GCash", small),
        (f"Amount \u20b1{amount}", big),
        (f"Ref No. {ref}", small),
        (date_text, small),
        (recipient, small),
        ("From: Maria S.", small),
    ]
    for i, (text, font) in enumerate(rows):
        draw.text((50, 30 + i * ROW_HEIGHT), text, fill=(0, 0, 0), font=font)
    return img


def to_bytes(img, fmt="PNG", quality=None, info=None):
    buf = BytesIO()
    kwargs = {}
    if fmt == "JPEG":
        kwargs["quality"] = quality or 85
    if info is not None:
        kwargs["pnginfo"] = info
    img.save(buf, fmt, **kwargs)
    return buf.getvalue()


def analyze(data, refs=None, own_ref=None, payment_ref=None, recipient=None):
    return ra.analyze_image_bytes(
        data,
        expected_amount=1000.0,
        expected_recipient=recipient,
        window_start=WINDOW,
        refs=refs,
        own_ref=own_ref,
        payment_ref=payment_ref,
        now=NOW,
    )


def flag_text(result):
    return " | ".join(result["flags"]).lower()


class ParserTests(unittest.TestCase):
    def test_amount_variants(self):
        cases = {
            "Amount \u20b11,000.00": 1000.0,
            "Amount P1,000": 1000.0,
            "PHP 1000.00 sent": 1000.0,
            "Total: PHP 2,500.50": 2500.5,
            "Amount Paid \u20b1 750.25": 750.25,
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                amount, line = ra.parse_amount([text])
                self.assertEqual(amount, expected)
                self.assertEqual(line, 0)

    def test_amount_prefers_keyword_line(self):
        amount, line = ra.parse_amount(["Fee \u20b115.00", "Amount \u20b11,000.00"])
        self.assertEqual(amount, 1000.0)
        self.assertEqual(line, 1)

    def test_amount_reads_letter_o_as_zero(self):
        amount, _ = ra.parse_amount(["Amount \u20b11,OOO.00"])
        self.assertEqual(amount, 1000.0)

    def test_amount_missing(self):
        self.assertEqual(ra.parse_amount(["Sent via GCash", "Oct 21, 2026"]), (None, None))

    def test_reference_variants(self):
        cases = [
            (["Ref No. 1234 567 890123"], "1234567890123"),
            (["Reference No. 1234-567-890123"], "1234567890123"),
            (["Reference ID: MBX12345678"], "MBX12345678"),
            (["Reference No.", "1234567890123"], "1234567890123"),
            # OCR output with dropped spaces
            (["Ref No.9876 543210987"], "9876543210987"),
        ]
        for lines, expected in cases:
            with self.subTest(lines=lines):
                value, _ = ra.parse_reference(lines)
                self.assertEqual(value, expected)

    def test_numeric_payment_ref_from_sheet(self):
        # Google Sheets returns a digits-only ref as a number
        self.assertTrue(ra._refs_match(1234567890123, "1234 567 890123"))

    def test_reference_missing(self):
        self.assertEqual(ra.parse_reference(["Amount \u20b11,000.00"]), (None, None))

    def test_date_variants(self):
        cases = {
            "Oct 21, 2026 7:45 PM": (datetime(2026, 10, 21, 19, 45), True),
            "October 5, 2026 9:05 AM": (datetime(2026, 10, 5, 9, 5), True),
            "10/21/2026": (datetime(2026, 10, 21), False),
            "21 Oct 2026": (datetime(2026, 10, 21), False),
            "2026-10-21 14:30": (datetime(2026, 10, 21, 14, 30), True),
            "12:00 AM Oct 21, 2026": (datetime(2026, 10, 21), False),
            # OCR output with dropped spaces
            "Oct21,20267:45PM": (datetime(2026, 10, 21, 19, 45), True),
        }
        for text, (expected, has_time) in cases.items():
            with self.subTest(text=text):
                value, got_time, line = ra.parse_date([text])
                self.assertEqual(value, expected)
                self.assertEqual(got_time, has_time)
                self.assertEqual(line, 0)

    def test_slash_date_day_first_when_needed(self):
        value, _, _ = ra.parse_date(["21/10/2026"])
        self.assertEqual(value, datetime(2026, 10, 21))

    def test_invalid_date_is_ignored(self):
        self.assertEqual(ra.parse_date(["Feb 30, 2026"])[0], None)

    def test_recipient_and_sender(self):
        parsed = ra.parse_receipt(["From: Maria S.", "To: Juan D. Cruz", "+63 917 123 4567"])
        self.assertEqual(parsed.recipient, "Juan D. Cruz")
        self.assertEqual(parsed.sender, "Maria S.")

    def test_recipient_on_next_line(self):
        parsed = ra.parse_receipt(["Recipient", "Juan D. Cruz"])
        self.assertEqual(parsed.recipient, "Juan D. Cruz")


class HashTests(unittest.TestCase):
    def test_dhash_is_16_hex_and_stable(self):
        img = make_receipt()
        first = ra.dhash(img)
        self.assertEqual(len(first), 16)
        self.assertEqual(first, ra.dhash(img))
        int(first, 16)

    def test_hamming(self):
        self.assertEqual(ra.hamming_hex("0000000000000000", "0000000000000003"), 2)
        self.assertEqual(ra.hamming_hex("ffffffffffffffff", "0000000000000000"), 64)


class AnalysisTests(unittest.TestCase):
    def test_clean_png_ocr_and_verified(self):
        result = analyze(to_bytes(make_receipt()))
        self.assertEqual(result["amount"], 1000.0)
        self.assertEqual(result["referenceNo"], "1234567890123")
        self.assertEqual(result["txnDate"], "2026-10-21T19:45")
        self.assertEqual(result["recipient"], "Juan D. Cruz")
        self.assertIn("1,000.00", result["ocrText"].replace(" ", ""))
        self.assertEqual(result["flags"], [])
        self.assertEqual(result["verdict"], ra.VERDICT_VERIFIED)
        self.assertEqual(result["tamperScore"], 0)
        self.assertEqual(len(result["imageHash"]), 16)

    def test_result_has_contract_keys(self):
        result = analyze(to_bytes(make_receipt()))
        for key in ("verdict", "amount", "referenceNo", "txnDate", "sender", "recipient",
                    "ocrText", "tamperScore", "flags", "checkedAt", "imageHash"):
            self.assertIn(key, result)

    def test_tampered_jpeg_scores_higher_than_clean(self):
        clean = make_receipt()
        clean_result = analyze(to_bytes(clean))

        patch_source = make_receipt(amount="5,000.00")
        arr = np.asarray(patch_source).astype(np.int16)
        arr = arr + np.random.default_rng(7).integers(-12, 12, arr.shape)
        noisy = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
        tampered = clean.copy()
        top = 30 + AMOUNT_ROW * ROW_HEIGHT - 10
        tampered.paste(noisy.crop((40, top, 520, top + 65)), (40, top))
        tampered_result = analyze(to_bytes(tampered, "JPEG", quality=60))

        self.assertGreater(tampered_result["tamperScore"], clean_result["tamperScore"])
        self.assertNotEqual(tampered_result["verdict"], ra.VERDICT_VERIFIED)
        self.assertEqual(tampered_result["amount"], 5000.0)

    def test_clone_stamp_flags_copy_move(self):
        clean = make_receipt()
        clone = clean.copy()
        source = clone.crop((40, 170, 520, 240))
        clone.paste(source, (40, 450))
        result = analyze(to_bytes(clone))
        self.assertIn("keypoints", flag_text(result))
        self.assertNotEqual(result["verdict"], ra.VERDICT_VERIFIED)

    def test_editor_metadata_flags_suspect(self):
        info = PngImagePlugin.PngInfo()
        info.add_text("Software", "Adobe Photoshop 25.0")
        result = analyze(to_bytes(make_receipt(), info=info))
        self.assertIn("photoshop", flag_text(result))
        self.assertEqual(result["verdict"], ra.VERDICT_SUSPECT)

    def test_wrong_amount_is_suspect(self):
        result = analyze(to_bytes(make_receipt(amount="500.00")))
        self.assertEqual(result["amount"], 500.0)
        self.assertIn("amount read 500.00", flag_text(result))
        self.assertEqual(result["verdict"], ra.VERDICT_SUSPECT)

    def test_missing_amount_needs_review(self):
        result = analyze(to_bytes(make_receipt(amount="1,000.00").crop((0, 0, 900, 150))))
        self.assertIsNone(result["amount"])
        self.assertIn("amount not read", flag_text(result))
        self.assertNotEqual(result["verdict"], ra.VERDICT_VERIFIED)

    def test_duplicate_reference_is_suspect(self):
        refs = [{"ref": "DFR-OLD1", "referenceNo": "1234567890123", "imageHash": None}]
        result = analyze(to_bytes(make_receipt()), refs=refs, own_ref="DFR-NEW1")
        self.assertIn("reference number also on dfr-old1", flag_text(result))
        self.assertEqual(result["verdict"], ra.VERDICT_SUSPECT)

    def test_own_reference_is_not_a_duplicate(self):
        refs = [{"ref": "DFR-NEW1", "referenceNo": "1234567890123", "imageHash": None}]
        result = analyze(to_bytes(make_receipt()), refs=refs, own_ref="DFR-NEW1")
        self.assertEqual(result["verdict"], ra.VERDICT_VERIFIED)

    def test_duplicate_image_hash_is_suspect(self):
        data = to_bytes(make_receipt())
        own_hash = analyze(data)["imageHash"]
        refs = [{"ref": "DFR-OLD2", "referenceNo": None, "imageHash": own_hash}]
        result = analyze(data, refs=refs, own_ref="DFR-NEW2")
        self.assertIn("image matches dfr-old2", flag_text(result))
        self.assertEqual(result["verdict"], ra.VERDICT_SUSPECT)

    def test_recipient_mismatch_is_suspect(self):
        result = analyze(to_bytes(make_receipt(recipient="To: Pedro Santos")), recipient="0917 555 1234")
        self.assertIn("recipient does not match", flag_text(result))
        self.assertEqual(result["verdict"], ra.VERDICT_SUSPECT)

    def test_recipient_match_passes(self):
        result = analyze(to_bytes(make_receipt(recipient="To: Juan D. Cruz")), recipient="juan d. cruz")
        self.assertNotIn("recipient", flag_text(result))

    def test_date_outside_window_is_suspect(self):
        result = analyze(to_bytes(make_receipt(date_text="Sep 2, 2026 7:45 PM")))
        self.assertIn("outside event window", flag_text(result))
        self.assertEqual(result["verdict"], ra.VERDICT_SUSPECT)

    def test_payment_ref_mismatch_needs_review(self):
        result = analyze(to_bytes(make_receipt()), payment_ref="9999 999 999999")
        self.assertIn("player payment reference", flag_text(result))
        self.assertEqual(result["verdict"], ra.VERDICT_REVIEW)

    def test_payment_ref_match_passes(self):
        result = analyze(to_bytes(make_receipt()), payment_ref="1234567890123")
        self.assertNotIn("payment reference", flag_text(result))

    def test_unreadable_file_needs_review(self):
        result = analyze(b"this is not an image")
        self.assertEqual(result["verdict"], ra.VERDICT_REVIEW)
        self.assertIsNone(result["imageHash"])
        self.assertIn("could not be read", flag_text(result))

    def test_invalid_base64_needs_review(self):
        result = ra.analyze_base64("%%%not-base64", expected_amount=1000.0, window_start=WINDOW, now=NOW)
        self.assertEqual(result["verdict"], ra.VERDICT_REVIEW)
        self.assertIsNone(result["imageHash"])

    def test_base64_round_trip(self):
        encoded = base64.b64encode(to_bytes(make_receipt())).decode("ascii")
        result = ra.analyze_base64(encoded, expected_amount=1000.0, window_start=WINDOW, now=NOW)
        self.assertEqual(result["amount"], 1000.0)


if __name__ == "__main__":
    unittest.main()
