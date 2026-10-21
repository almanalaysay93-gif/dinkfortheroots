"""Receipt OCR, parsing, and tamper heuristics for the Dink for the Roots checker.

Every check here is a heuristic. A Verified result is not proof of payment.
Thresholds are starting values. Calibrate them on real receipts before you rely on them.
"""

import base64
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO

import cv2
import numpy as np
from PIL import Image

# ---- Heuristic thresholds (calibrate on real receipts) -------------------------

AMOUNT_TOLERANCE = 0.005            # peso difference treated as equal
DHASH_DUPLICATE_DISTANCE = 6        # Hamming distance of 64-bit dHash treated as duplicate
ELA_RESAVE_QUALITY = 90             # JPEG quality for error level analysis re-save
ELA_BLOCK = 16                      # block size in pixels
ELA_BASE_FLOOR = 2.0                # minimum baseline block score, avoids divide by near zero
ELA_HOT_RATIO = 6.0                 # max block score / baseline that counts as a hot spot
ELA_MIN_BLOCK = 10.0                # minimum absolute block score for a hot spot
ORB_FEATURES = 1500
COPY_MOVE_RATIO = 0.75              # ORB ratio test between best and second best self-match
COPY_MOVE_MIN_SHIFT = 30.0          # pixels, ignore matches that stay close together
COPY_MOVE_BIN = 6.0                 # pixels, displacement bin width
COPY_MOVE_MIN_MATCHES = 24          # matches sharing one displacement bin inside one window
COPY_MOVE_WINDOW = 120.0            # pixels, square window for the local match density
NOISE_BRIGHT_LEVEL = 200            # gray level treated as paper background
NOISE_FLOOR = 2.0                   # minimum background noise to flag
NOISE_RATIO = 3.0                   # field box noise over median noise of all boxes
WORK_MAX_SIDE = 2000                # downscale above this size
WORK_MIN_SIDE = 1000                # upscale below this size, for OCR
WORK_MAX_UPSCALE = 3.0
MODIFY_GAP_DAYS = 1                 # ModifyDate later than DateTimeOriginal by this much
DATE_FUTURE_DAYS = 1                # allowed days after now for a receipt date
OCR_TEXT_LIMIT = 5000

# ---- Verdict and score rules -----------------------------------------------------

SUSPECT_SCORE = 50                  # score at or above this value means Suspect
VERDICT_VERIFIED = "Verified"
VERDICT_REVIEW = "Needs review"
VERDICT_SUSPECT = "Suspect"

EDITOR_NAMES = (
    "photoshop", "lightroom", "gimp", "canva", "picsart", "snapseed", "pixellab",
    "remini", "pixlr", "photoscape", "facetune", "meitu", "affinity", "paint.net",
    "inkscape", "fotor", "illustrator", "adobe express",
)

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

# Weight and strength of each finding code.
# Strong findings force Suspect. Other findings give Needs review unless the score is high.
FINDING_RULES = {
    "editor_metadata": (40, True),
    "modify_date_gap": (15, False),
    "ela_hot_region": (35, True),
    "jpeg_quant_nonstandard": (5, False),
    "copy_move": (45, False),
    "field_noise_outlier": (25, False),
    "amount_mismatch": (60, True),
    "amount_unreadable": (10, False),
    "reference_unreadable": (10, False),
    "date_unreadable": (5, False),
    "date_outside_window": (30, True),
    "recipient_mismatch": (30, True),
    "recipient_unreadable": (5, False),
    "duplicate_reference": (80, True),
    "duplicate_image_hash": (80, True),
    "payment_ref_mismatch": (20, False),
    "file_unreadable": (0, True),
}


@dataclass
class Finding:
    code: str
    message: str

    @property
    def weight(self):
        return FINDING_RULES[self.code][0]

    @property
    def strong(self):
        return FINDING_RULES[self.code][1]


@dataclass
class OcrLine:
    text: str
    box: list
    score: float


@dataclass
class ParsedReceipt:
    amount: float = None
    amount_line: int = None
    reference_no: str = None
    reference_line: int = None
    txn_datetime: datetime = None
    txn_has_time: bool = False
    date_line: int = None
    sender: str = None
    recipient: str = None
    recipient_line: int = None


# ---- OCR --------------------------------------------------------------------------

_ENGINE = None


def _get_engine():
    """Create the RapidOCR engine once. Model load is slow."""
    global _ENGINE
    if _ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR
        _ENGINE = RapidOCR()
    return _ENGINE


def to_working_image(rgb_image):
    """Return a BGR numpy image sized for OCR and feature checks."""
    arr = np.asarray(rgb_image.convert("RGB"))
    h, w = arr.shape[:2]
    longest = max(h, w)
    scale = 1.0
    if longest > WORK_MAX_SIDE:
        scale = WORK_MAX_SIDE / longest
    elif longest < WORK_MIN_SIDE:
        scale = min(WORK_MIN_SIDE / longest, WORK_MAX_UPSCALE)
    if scale != 1.0:
        interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
        arr = cv2.resize(arr, None, fx=scale, fy=scale, interpolation=interp)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def run_ocr(bgr_image):
    """Return OcrLine items in the order the OCR engine returns them."""
    result, _elapse = _get_engine()(bgr_image)
    lines = []
    for item in result or []:
        box, text, score = item[0], item[1], item[2]
        lines.append(OcrLine(text=unicodedata.normalize("NFKC", str(text)),
                             box=[[float(x), float(y)] for x, y in box],
                             score=float(score)))
    return lines


# ---- Parsing ------------------------------------------------------------------------

AMOUNT_KEYWORD_RE = re.compile(r"amount|total|sent|paid|transfer|payment|debited", re.I)
MONEY_RE = re.compile(r"(?:₱|PHP|Php|php|P)\s?(?=[\dOo])([\dOo][\dOo,]*(?:\.\d{1,2})?)")
DECIMAL_RE = re.compile(r"(?<![\d.])(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})(?!\d)")
REF_LABEL_RE = re.compile(
    r"(ref(?:erence)?\s*(?:no|num|number|id)?\.?|transaction\s*(?:id|no|number)\.?|txn\s*(?:id|no)\.?)",
    re.I,
)
REF_NUMERIC_RE = re.compile(r"(?<![A-Za-z\d])(?:\d+(?:[ -]\d+)+|\d{8,})(?![A-Za-z\d])")
REF_ALNUM_RE = re.compile(r"\b[A-Z0-9]{8,}\b")
RECIPIENT_LABEL_RE = re.compile(r"^\s*(?:to|sent to|recipient|receiver)\s*[:\-]?\s*(.*)$", re.I)
SENDER_LABEL_RE = re.compile(r"^\s*(?:from|sender|sent via|sent by)\s*[:\-]?\s*(.*)$", re.I)
MASKED_NUMBER_RE = re.compile(r"(?:\+?63|0)9[\dXx*]{2}[\s-]?[\dXx*]{3}[\s-]?[\dXx*]{4}")

_DATE_TIME_TAIL = r"(?:[ ,T]*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?"
DATE_PATTERNS = [
    # \s* because OCR often drops spaces: "Oct21,20267:45PM"
    ("mdy_name", re.compile(r"\b([A-Za-z]{3,9})\.?\s*(\d{1,2}),?\s*(\d{4})" + _DATE_TIME_TAIL)),
    ("dmy_name", re.compile(r"\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})" + _DATE_TIME_TAIL)),
    ("slash", re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})" + _DATE_TIME_TAIL)),
    ("iso", re.compile(r"\b(\d{4})-(\d{2})-(\d{2})" + _DATE_TIME_TAIL)),
]


def _fix_digits(token):
    """Map OCR letter O to zero inside number tokens."""
    if any(ch.isdigit() for ch in token):
        return token.replace("O", "0").replace("o", "0")
    return token


def parse_amount(lines):
    """Return (amount, line_index) for the most likely peso amount."""
    best = None
    for idx, text in enumerate(lines):
        keyword = bool(AMOUNT_KEYWORD_RE.search(text))
        for m in MONEY_RE.finditer(text):
            token = _fix_digits(m.group(1)).replace(",", "")
            try:
                value = float(token)
            except ValueError:
                continue
            weight = 2 if keyword else 1
            if best is None or weight > best[0]:
                best = (weight, value, idx)
        if keyword:
            for m in DECIMAL_RE.finditer(text):
                value = float(m.group(1).replace(",", ""))
                if best is None or 2 > best[0]:
                    best = (2, value, idx)
    if best is None:
        return None, None
    return best[1], best[2]


def _normalize_ref(text):
    return re.sub(r"[\s-]", "", text).upper()


def parse_reference(lines):
    """Return (reference_no, line_index). The value may sit on the label line or the next line."""
    for idx, text in enumerate(lines):
        m = REF_LABEL_RE.search(text)
        if not m:
            continue
        candidates = [text[m.end():]]
        if idx + 1 < len(lines):
            candidates.append(lines[idx + 1])
        for candidate in candidates:
            value = _find_ref_value(candidate)
            if value:
                return value, idx
    return None, None


def _find_ref_value(text):
    # digit groups first: OCR often keeps some spaces ("9876 543210987")
    for m in REF_NUMERIC_RE.finditer(text):
        digits = re.sub(r"\D", "", m.group(0))
        if 8 <= len(digits) <= 20:
            return digits
    for m in REF_ALNUM_RE.finditer(text.upper()):
        if any(ch.isdigit() for ch in m.group(0)):
            return m.group(0)
    return None


def _to_datetime(groups, kind):
    if kind == "mdy_name" or kind == "dmy_name":
        if kind == "mdy_name":
            month_name, day, year = groups[0], groups[1], groups[2]
        else:
            day, month_name, year = groups[0], groups[1], groups[2]
        time_groups = groups[3:]
        month = MONTHS.get(month_name[:3].lower())
        if month is None:
            return None, False
    elif kind == "slash":
        first, second, year = int(groups[0]), int(groups[1]), int(groups[2])
        # MM/DD/YYYY by default. Read DD/MM only when the first part cannot be a month.
        if first > 12:
            day, month = first, second
        else:
            month, day = first, second
        time_groups = groups[3:]
    else:
        year, month, day = int(groups[0]), int(groups[1]), int(groups[2])
        time_groups = groups[3:]
    month = int(month)
    try:
        hour, minute, second, ampm = 0, 0, 0, None
        has_time = bool(time_groups[0] and time_groups[1])
        if has_time:
            hour, minute = int(time_groups[0]), int(time_groups[1])
            second = int(time_groups[2]) if time_groups[2] else 0
            ampm = time_groups[3].lower() if time_groups[3] else None
            if ampm == "pm" and hour < 12:
                hour += 12
            if ampm == "am" and hour == 12:
                hour = 0
        value = datetime(int(year), month, int(day), hour, minute, second)
        return value, has_time
    except (ValueError, TypeError):
        return None, False


def parse_date(lines):
    """Return (datetime, has_time, line_index) for the first readable date."""
    for idx, text in enumerate(lines):
        for kind, pattern in DATE_PATTERNS:
            for m in pattern.finditer(text):
                value, has_time = _to_datetime(m.groups(), kind)
                if value is not None:
                    return value, has_time, idx
    return None, False, None


def parse_party(lines, label_re):
    """Return (value, line_index) for a labelled sender or recipient."""
    for idx, text in enumerate(lines):
        m = label_re.match(text)
        if not m:
            continue
        value = m.group(1).strip()
        if not value and idx + 1 < len(lines):
            value = lines[idx + 1].strip()
            idx = idx + 1
        if value:
            return value, idx
    return None, None


def parse_receipt(lines):
    """Parse text lines into fields. Returns a ParsedReceipt."""
    parsed = ParsedReceipt()
    parsed.amount, parsed.amount_line = parse_amount(lines)
    parsed.reference_no, parsed.reference_line = parse_reference(lines)
    parsed.txn_datetime, parsed.txn_has_time, parsed.date_line = parse_date(lines)
    parsed.sender, _ = parse_party(lines, SENDER_LABEL_RE)
    parsed.recipient, parsed.recipient_line = parse_party(lines, RECIPIENT_LABEL_RE)
    return parsed


# ---- Metadata ------------------------------------------------------------------------

def _text_values(img):
    values = []
    for key, value in img.info.items():
        if key in ("icc_profile", "exif"):
            continue
        if isinstance(value, bytes):
            value = value[:20000].decode("utf-8", errors="ignore")
        if isinstance(value, str):
            values.append(value)
    exif = img.getexif()
    for value in exif.values():
        if isinstance(value, bytes):
            value = value.decode("utf-8", errors="ignore")
        values.append(str(value))
    return values


def _exif_datetime(text):
    try:
        return datetime.strptime(str(text).strip(), "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None


def metadata_findings(img):
    findings = []
    haystack = " ".join(_text_values(img)).lower()
    for name in EDITOR_NAMES:
        if name in haystack:
            findings.append(Finding("editor_metadata", f"metadata names an editor: {name}"))
            break
    exif = img.getexif()
    original = None
    exif_ifd = exif.get_ifd(0x8769) if exif else {}
    if exif_ifd and 36867 in exif_ifd:
        original = _exif_datetime(exif_ifd[36867])
    modified = _exif_datetime(exif[306]) if exif and 306 in exif else None
    if original and modified and modified - original > timedelta(days=MODIFY_GAP_DAYS):
        findings.append(Finding("modify_date_gap", "ModifyDate is more than one day after DateTimeOriginal"))
    return findings


# ---- JPEG checks -------------------------------------------------------------------

def _standard_quality(table):
    """Return the libjpeg quality that matches a quantization table, or None."""
    if not table or len(table) < 64:
        return None
    for q in range(1, 101):
        scale = 5000 / q if q < 50 else 200 - 2 * q
        first = max(1, min(255, (16 * scale + 50) // 100))
        last = max(1, min(255, (99 * scale + 50) // 100))
        if int(first) == int(table[0]) and int(last) == int(table[63]):
            return q
    return None


def quantization_findings(img):
    tables = getattr(img, "quantization", None) or {}
    if not tables:
        return []
    if _standard_quality(tables.get(0)) is None:
        return [Finding("jpeg_quant_nonstandard", "JPEG quantization table is not a standard quality")]
    return []


def ela_findings(img_rgb):
    """Error level analysis. Compare the decoded image with a re-save at a fixed quality."""
    buf = BytesIO()
    img_rgb.save(buf, "JPEG", quality=ELA_RESAVE_QUALITY)
    buf.seek(0)
    resaved = Image.open(buf).convert("RGB")
    original = np.asarray(img_rgb.convert("RGB"), dtype=np.int16)
    diff = np.abs(original - np.asarray(resaved, dtype=np.int16)).max(axis=2).astype(np.float32)
    h, w = diff.shape
    hb, wb = h // ELA_BLOCK, w // ELA_BLOCK
    if hb < 1 or wb < 1:
        return []
    blocks = diff[:hb * ELA_BLOCK, :wb * ELA_BLOCK].reshape(hb, ELA_BLOCK, wb, ELA_BLOCK).mean(axis=(1, 3))
    baseline = max(float(np.median(blocks)), ELA_BASE_FLOOR)
    hot = float(blocks.max())
    ratio = hot / baseline
    if hot >= ELA_MIN_BLOCK and ratio >= ELA_HOT_RATIO:
        return [Finding("ela_hot_region", f"error level hot spot: block {hot:.1f}, baseline {baseline:.1f}, ratio {ratio:.1f}")]
    return []


# ---- Working-image checks -----------------------------------------------------------

def copy_move_findings(gray):
    orb = cv2.ORB_create(nfeatures=ORB_FEATURES)
    keypoints, desc = orb.detectAndCompute(gray, None)
    if desc is None or len(keypoints) < COPY_MOVE_MIN_MATCHES:
        return []
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    knn = matcher.knnMatch(desc, desc, k=3)
    by_bin = {}
    for i, matches in enumerate(knn):
        candidates = [m for m in matches if m.trainIdx != i]
        if not candidates:
            continue
        best = candidates[0]
        if len(candidates) > 1 and best.distance >= COPY_MOVE_RATIO * candidates[1].distance:
            continue
        px, py = keypoints[i].pt
        qx, qy = keypoints[best.trainIdx].pt
        dx, dy = qx - px, qy - py
        if math.hypot(dx, dy) < COPY_MOVE_MIN_SHIFT:
            continue
        key = (round(dx / COPY_MOVE_BIN), round(dy / COPY_MOVE_BIN))
        by_bin.setdefault(key, []).append((px, py))
    findings = []
    for key, sources in by_bin.items():
        density = _max_points_in_window(sources, COPY_MOVE_WINDOW)
        if density >= COPY_MOVE_MIN_MATCHES:
            findings.append(Finding("copy_move", f"{density} keypoints in one {COPY_MOVE_WINDOW:.0f} px area share a copied offset"))
            break
    return findings


def _max_points_in_window(points, size):
    """Largest number of points inside any square of the given size anchored at a point."""
    best = 0
    for x0, y0 in points:
        count = sum(1 for x, y in points if x0 <= x <= x0 + size and y0 <= y <= y0 + size)
        best = max(best, count)
    return best


def _box_rect(box, shape):
    pts = np.array(box, dtype=np.int32)
    x, y, w, h = cv2.boundingRect(pts)
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(shape[1], x + w), min(shape[0], y + h)
    return x0, y0, x1, y1


def background_noise(gray, rect):
    """Median residual of bright (paper) pixels inside a box. None when the box has no paper."""
    x0, y0, x1, y1 = rect
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    crop = gray[y0:y1, x0:x1]
    residual = np.abs(crop.astype(np.float32) - cv2.medianBlur(crop, 3).astype(np.float32))
    paper = crop >= NOISE_BRIGHT_LEVEL
    if paper.sum() < 20:
        return None
    return float(np.median(residual[paper]))


def field_noise_findings(gray, lines, field_lines):
    """Flag amount, reference, or date text whose paper noise differs from the rest of the receipt."""
    noises = {}
    for idx, line in enumerate(lines):
        rect = _box_rect(line.box, gray.shape)
        value = background_noise(gray, rect)
        if value is not None:
            noises[idx] = value
    if len(noises) < 3:
        return []
    median_all = float(np.median(list(noises.values())))
    limit = max(NOISE_FLOOR, NOISE_RATIO * median_all)
    findings = []
    for name, idx in field_lines.items():
        if idx in noises and noises[idx] > limit:
            findings.append(Finding(
                "field_noise_outlier",
                f"{name} text noise {noises[idx]:.1f} above limit {limit:.1f}",
            ))
    return findings


# ---- Hashing ------------------------------------------------------------------------

def dhash(rgb_image):
    """64-bit difference hash as 16 hex characters."""
    gray = rgb_image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    px = np.asarray(gray, dtype=np.int16)
    bits = (px[:, 1:] > px[:, :-1]).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return f"{value:016x}"


def hamming_hex(a, b):
    return (int(a, 16) ^ int(b, 16)).bit_count()


# ---- Rules ----------------------------------------------------------------------------

def _digits(text):
    return re.sub(r"\D", "", text or "")


def _refs_match(a, b):
    na, nb = _normalize_ref(a or ""), _normalize_ref(b or "")
    if not na or not nb:
        return False
    if na == nb:
        return True
    shorter, longer = sorted([na, nb], key=len)
    return len(shorter) >= 8 and shorter in longer


def rule_findings(parsed, *, expected_amount, expected_recipient, window_start, now,
                  refs, own_ref, payment_ref, image_hash):
    findings = []
    if parsed.amount is None:
        findings.append(Finding("amount_unreadable", "amount not read"))
    elif abs(parsed.amount - expected_amount) > AMOUNT_TOLERANCE:
        findings.append(Finding("amount_mismatch", f"amount read {parsed.amount:.2f}, expected {expected_amount:.2f}"))
    if parsed.reference_no is None:
        findings.append(Finding("reference_unreadable", "reference number not read"))
    if parsed.txn_datetime is None:
        findings.append(Finding("date_unreadable", "transaction date not read"))
    else:
        receipt_date = parsed.txn_datetime.date()
        latest = (now + timedelta(days=DATE_FUTURE_DAYS)).date()
        if receipt_date < window_start or receipt_date > latest:
            findings.append(Finding("date_outside_window", f"date {receipt_date.isoformat()} outside event window"))
    if expected_recipient:
        if not parsed.recipient:
            findings.append(Finding("recipient_unreadable", "recipient not read"))
        elif not _recipient_matches(parsed.recipient, expected_recipient):
            findings.append(Finding("recipient_mismatch", "recipient does not match the organizer account"))
    if parsed.reference_no:
        for item in refs or []:
            if item.get("ref") == own_ref:
                continue
            if item.get("referenceNo") and _refs_match(parsed.reference_no, item["referenceNo"]):
                findings.append(Finding("duplicate_reference", f"reference number also on {item.get('ref')}"))
                break
    if image_hash:
        for item in refs or []:
            if item.get("ref") == own_ref or not item.get("imageHash"):
                continue
            if hamming_hex(image_hash, item["imageHash"]) <= DHASH_DUPLICATE_DISTANCE:
                findings.append(Finding("duplicate_image_hash", f"image matches {item.get('ref')}"))
                break
    if payment_ref and parsed.reference_no and not _refs_match(payment_ref, parsed.reference_no):
        findings.append(Finding("payment_ref_mismatch", "player payment reference does not match the receipt"))
    return findings


def _recipient_matches(recipient, expected):
    expected = expected.strip()
    if expected.isdigit() or re.fullmatch(r"[\d\s-]+", expected):
        want = _digits(expected)
        return bool(want) and want in _digits(recipient)
    return expected.lower() in recipient.lower()


# ---- Verdict --------------------------------------------------------------------------

def verdict_for(findings, score):
    if any(f.strong for f in findings) or score >= SUSPECT_SCORE:
        return VERDICT_SUSPECT
    if findings:
        return VERDICT_REVIEW
    return VERDICT_VERIFIED


def _score(findings):
    return min(100, sum(f.weight for f in findings))


# ---- Public API -----------------------------------------------------------------------

def _now(now):
    return now if now is not None else datetime.now(timezone.utc)


def _unreadable_result(now, reason):
    finding = Finding("file_unreadable", reason)
    return {
        "verdict": VERDICT_REVIEW,
        "amount": None,
        "referenceNo": None,
        "txnDate": None,
        "sender": None,
        "recipient": None,
        "ocrText": "",
        "tamperScore": 0,
        "flags": [finding.message],
        "checkedAt": _now(now).isoformat(timespec="seconds"),
        "imageHash": None,
    }


def analyze_image_bytes(data, *, expected_amount, expected_recipient=None, window_start,
                        refs=None, own_ref=None, payment_ref=None, now=None):
    """Analyze one receipt image. Returns the sheet result dict (contract item 4 plus imageHash)."""
    now = _now(now)
    try:
        img = Image.open(BytesIO(data))
        img.load()
    except Exception:
        return _unreadable_result(now, "receipt file could not be read as an image")

    fmt = img.format
    rgb = img.convert("RGB")
    image_hash = dhash(rgb)
    findings = []
    findings += metadata_findings(img)
    if fmt == "JPEG":
        findings += quantization_findings(img)
        findings += ela_findings(rgb)

    work = to_working_image(rgb)
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    lines = run_ocr(work)
    texts = [line.text for line in lines]
    parsed = parse_receipt(texts)

    field_lines = {}
    if parsed.amount_line is not None:
        field_lines["amount"] = parsed.amount_line
    if parsed.reference_line is not None:
        field_lines["reference"] = parsed.reference_line
    if parsed.date_line is not None:
        field_lines["date"] = parsed.date_line
    findings += field_noise_findings(gray, lines, field_lines)
    findings += copy_move_findings(gray)
    findings += rule_findings(
        parsed,
        expected_amount=expected_amount,
        expected_recipient=expected_recipient,
        window_start=window_start,
        now=now,
        refs=refs,
        own_ref=own_ref,
        payment_ref=payment_ref,
        image_hash=image_hash,
    )

    score = _score(findings)
    txn = None
    if parsed.txn_datetime is not None:
        if parsed.txn_has_time:
            txn = parsed.txn_datetime.isoformat(timespec="minutes")
        else:
            txn = parsed.txn_datetime.date().isoformat()
    ocr_text = "\n".join(texts)[:OCR_TEXT_LIMIT]
    return {
        "verdict": verdict_for(findings, score),
        "amount": parsed.amount,
        "referenceNo": parsed.reference_no,
        "txnDate": txn,
        "sender": parsed.sender,
        "recipient": parsed.recipient,
        "ocrText": ocr_text,
        "tamperScore": score,
        "flags": [f.message for f in findings],
        "checkedAt": now.isoformat(timespec="seconds"),
        "imageHash": image_hash,
    }


def analyze_base64(b64_data, **kwargs):
    """Decode a base64 receipt from the Apps Script pending response and analyze it."""
    try:
        data = base64.b64decode(b64_data, validate=False)
    except (ValueError, TypeError):
        return _unreadable_result(kwargs.get("now"), "receipt data is not valid base64")
    return analyze_image_bytes(data, **kwargs)


def analyze_file(path, **kwargs):
    with open(path, "rb") as handle:
        return analyze_image_bytes(handle.read(), **kwargs)
