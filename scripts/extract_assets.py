"""Cut the title sticker and the two partner logos out of source/title-logos.jpg,
and remove the baked-in title from source/bg-court.png.

Run: python -I scripts/extract_assets.py   (from the project root)
"""
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source"
OUT = ROOT / "site" / "assets"
OUT.mkdir(parents=True, exist_ok=True)


def sticker_mask(rgb: np.ndarray) -> np.ndarray:
    """Mask of the white-outlined sticker: near-white border, holes filled."""
    r, g, b = rgb[..., 0].astype(int), rgb[..., 1].astype(int), rgb[..., 2].astype(int)
    white = ((r > 225) & (g > 225) & (b > 225)).astype(np.uint8) * 255
    white = cv2.morphologyEx(white, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    # flood fill from the border: everything not reached is inside the sticker
    h, w = white.shape
    flood = white.copy()
    ff = np.zeros((h + 2, w + 2), np.uint8)
    for x in range(0, w, 8):
        for y in (0, h - 1):
            if flood[y, x] == 0:
                cv2.floodFill(flood, ff, (x, y), 128)
    for y in range(0, h, 8):
        for x in (0, w - 1):
            if flood[y, x] == 0:
                cv2.floodFill(flood, ff, (x, y), 128)
    mask = (flood != 128).astype(np.uint8) * 255
    # keep components that are large (the title words), drop specks
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    keep = np.zeros_like(mask)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] > 4000:
            keep[labels == i] = 255
    # soften the edge by 1px
    keep = cv2.GaussianBlur(keep, (3, 3), 0)
    return keep


def save_rgba(rgb: np.ndarray, alpha: np.ndarray, name: str) -> None:
    ys, xs = np.where(alpha > 10)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgba = np.dstack([rgb, alpha])[y0:y1, x0:x1]
    bgra = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)
    cv2.imwrite(str(OUT / f"{name}.png"), bgra)
    cv2.imwrite(str(OUT / f"{name}.webp"), bgra, [cv2.IMWRITE_WEBP_QUALITY, 92])
    print(name, rgba.shape[1], "x", rgba.shape[0])


def main() -> None:
    bgr = cv2.imread(str(SRC / "title-logos.jpg"))
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    # Title sticker (subtitle text excluded: it is white text without an outline)
    ty0, ty1, tx0, tx1 = 520, 1180, 230, 1480
    region = rgb[ty0:ty1, tx0:tx1]
    m = sticker_mask(region)
    # drop the subtitle band (thin white text left of the root)
    sub = np.zeros_like(m)
    sub[1000 - ty0:1085 - ty0, 0:1100 - tx0] = 1
    n, labels, stats, _ = cv2.connectedComponentsWithStats((m > 127).astype(np.uint8), 8)
    for i in range(1, n):
        x, y, w, h = stats[i, :4]
        if h < 70 and (y + ty0) > 990:
            m[labels == i] = 0
    # Letter counters (inside D, O, R, ...) still hold the red background: clear them
    r, g, b = (region[..., i].astype(int) for i in range(3))
    bg_like = (r > 140) & (g > 60) & (r - g > 35) & (np.abs(g - b) < 28) & ~((r > 225) & (g > 225) & (b > 225))
    bg_like = cv2.morphologyEx(bg_like.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bg_like, 8)
    holes = np.zeros_like(m)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] > 60:
            holes[labels == i] = 255
    holes = cv2.dilate(holes, np.ones((3, 3), np.uint8))
    m = np.where(holes > 0, 0, m).astype(np.uint8)
    save_rgba(region, m, "title")

    # Make Them Visible: circular seal (center found with HoughCircles)
    cx, cy, rad = 610, 294, 106
    pad = 2
    seal = rgb[cy - rad - pad:cy + rad + pad, cx - rad - pad:cx + rad + pad]
    a = np.zeros(seal.shape[:2], np.uint8)
    cv2.circle(a, (rad + pad, rad + pad), rad, 255, -1, lineType=cv2.LINE_AA)
    save_rgba(seal, a, "logo-make-them-visible")

    # Circle of Care: white rectangle card
    card = rgb[223:368, 789:1151]
    save_rgba(card, np.full(card.shape[:2], 255, np.uint8), "logo-circle-of-care")


if __name__ == "__main__":
    main()


def clean_background() -> None:
    """Inpaint the baked-in title out of the court photo."""
    bgr = cv2.imread(str(SRC / "bg-court.png"))
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    y0, y1, x0, x1 = 120, 410, 30, 640
    m = np.zeros(rgb.shape[:2], np.uint8)
    m[y0:y1, x0:x1] = sticker_mask(rgb[y0:y1, x0:x1])
    m = cv2.dilate((m > 40).astype(np.uint8) * 255, np.ones((9, 9), np.uint8))
    out = cv2.inpaint(bgr, m, 9, cv2.INPAINT_TELEA)
    # the inpaint leaves facets: replace the patch with a heavy blur, feathered in
    soft = cv2.GaussianBlur(out, (0, 0), 22)
    feather = cv2.GaussianBlur(cv2.dilate(m, np.ones((25, 25), np.uint8)), (0, 0), 12).astype(np.float32)[..., None] / 255
    out = (soft * feather + out * (1 - feather)).astype(np.uint8)
    cv2.imwrite(str(SOURCE_CLEAN), out)
    for w in (1600, 900):
        h = round(out.shape[0] * w / out.shape[1])
        im = cv2.resize(out, (w, h), interpolation=cv2.INTER_CUBIC if w > out.shape[1] else cv2.INTER_AREA)
        cv2.imwrite(str(OUT / f"bg-court-{w}.webp"), im, [cv2.IMWRITE_WEBP_QUALITY, 80])
        cv2.imwrite(str(OUT / f"bg-court-{w}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 82])
    print("background cleaned")


SOURCE_CLEAN = ROOT / "source" / "bg-court-clean.png"

if __name__ == "__main__":
    clean_background()
