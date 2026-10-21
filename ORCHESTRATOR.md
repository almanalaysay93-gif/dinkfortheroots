# Dink for the Roots: orchestrator contract

Checkpoint 2 (2026-10-21, change request CR1). Checkpoint 1 (2026-10-21). Orchestrator and QA: Opus 5.5. Build agents: Haiku 5.5. Designme frontend agent: Opus 5.5.

## Decisions (user approved)

- D1: Event date is **December 5, 2026** (poster image wins over the md).
- D2: One form per **player**. Each player pays ₱1,200 (CR1). The player names a partner.
- D3: Receipt checker is a Python script on the organizer PC. It pulls pending receipts from Apps Script with an admin key and writes results back. No Google API credentials.
- D4: Static site on GitHub Pages (`almanalaysay93-gif/dinkfortheroots`), Google Sheet + Apps Script in `paddlebase@gmail.com` (changed 2026-10-21 by the user), so confirmation emails come from that address. No push before user OK.
- D5: Free-only. No paid APIs.

## Event facts (single source of truth)

- Name: DINK FOR THE ROOTS. Subtitle: A Pickleball Fundraising Tournament for Indigenous Communities.
- Partners: Make Them Visible (Empowering Indigenous Community) and Circle of Care ("Step that Matters", Community Service | Women Empowerment | Mental Wellness).
- Date: Saturday, December 5, 2026. Venue: Pickle Park, Roxas Extension, Digos City.
- Exclusive for Davao del Sur residents only.
- NOVICE: 20 pairs per category, ₱1,200 per player. Categories: Men's Doubles, Women's Doubles, Mixed Doubles.
- ROOKIE: 20 pairs per category, ₱1,200 per player. Categories: Men's Doubles, Women's Doubles, Mixed Doubles (CR1).
- Registration cut-off: November 20, 2026, 11:59 PM Asia/Manila (`2026-11-20T23:59:59+08:00`). After it, `register` returns `CLOSED` and `slots` returns `open:false`.
- Each player uploads a valid ID image (required) and may enter a Club Name (optional).
- Inclusions: T-shirt, freebies (surprise), raffle entry, one-time light snacks, bottled water, drawstring bag, sweat towel.
- Prizes, each of the 6 categories: Champion ₱5,000, Silver ₱3,000, Bronze ₱2,000.
- Organizer notification emails: ibanezdianarose9@gmail.com and aceyorkbasilan@gmail.com (both always receive the alert).

## Category keys and caps

| key | label | tab name | cap (players) |
|---|---|---|---|
| `novice-mens` | Novice Men's Doubles | Novice Men's | 40 |
| `novice-womens` | Novice Women's Doubles | Novice Women's | 40 |
| `novice-mixed` | Novice Mixed Doubles | Novice Mixed | 40 |
| `rookie-mens` | Rookie Men's Doubles | Rookie Men's | 40 |
| `rookie-womens` | Rookie Women's Doubles | Rookie Women's | 40 |
| `rookie-mixed` | Rookie Mixed Doubles | Rookie Mixed | 40 |

Shirt sizes (exact strings): `K8 K10 K12 K14 K16 K18 K20 XS S M L XL 2XL 3XL 4XL`.

Davao del Sur LGUs (exact strings): `Digos City, Bansalan, Hagonoy, Kiblawan, Magsaysay, Malalag, Matanao, Padada, Santa Cruz, Sulop`.

## File ownership

| path | owner |
|---|---|
| `site/index.html`, `site/css/*`, `site/js/*` (except `js/config.js` values) | frontend (Opus designme) |
| `site/assets/*` | orchestrator (already made) |
| `apps-script/Code.gs`, `apps-script/appsscript.json`, `tests/code.test.mjs` | backend (Haiku) |
| `receipt-checker/*` | python (Haiku) |
| `site/llms.txt`, `site/robots.txt`, `site/sitemap.xml` | discoverability (Haiku, last) |

## Assets ready in `site/assets/`

- `title.png|webp` (1235x543, transparent sticker title), `logo-make-them-visible.png|webp` (215x215 round), `logo-circle-of-care.png|webp` (362x145 card).
- `bg-court-1600.webp|jpg`, `bg-court-900.webp|jpg`: portrait court photo (aspect 1122:1402), baked title removed. Original title sat top-left at x 5%-55%, y 10%-28%. Players stand bottom-right.
- `size-chart.jpg` (shirt measuring guide), `payment-qr.png` slot: the user adds the real QR later. Until then the page shows a placeholder.

## API contract (Apps Script web app)

All requests: `fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) })`. Text/plain avoids the CORS preflight. Every response is JSON `{ ok: boolean, ... }`. Errors: `{ ok:false, error:"<code>", message:"<human text>" }`.

GET `ENDPOINT?action=slots` also works and returns the same as POST `slots`.

1. `{ action:"slots" }` → `{ ok:true, open:<bool>, closesAt:"2026-11-20T23:59:59+08:00", slots:{ "novice-mens":{taken:n,cap:40}, ... } }`. `taken` counts rows with status not `Rejected`.
2. `{ action:"register", player:{ fullName, email, phone, municipality, barangay, category, partnerName, clubName, shirtSize, paymentRef }, receipt:{ fileName, mimeType, base64 }, validId:{ fileName, mimeType, base64 }, consent:true }`
   - The receipt must show ₱1,200: Drive OCR (Drive API with the script token, temporary Google Doc deleted after reading) must find 1200 / 1,200 / 1,200.00 in the text, else `{ ok:false, error:"INVALID", field:"receipt.amount" }`. When OCR fails, the entry is accepted and the receipt checker reviews it.
   - After the cut-off → `{ ok:false, error:"CLOSED" }`, checked before any other validation. `clubName` optional, 0 to 100 chars. `validId` same rules as `receipt`, saved to Drive folder `Dink for the Roots Valid IDs` as `<ref>-ID-<fileName>`, private.`
   - Validates every field (email format, phone `09XXXXXXXXX` or `+639XXXXXXXXX`, municipality in list, category in list, shirt in list, receipt mime `image/jpeg|image/png|image/webp`, decoded size ≤ 5 MB, consent true).
   - Duplicate rule: same email in same category → `{ ok:true, duplicate:true, ref:<existing> }`.
   - Full category → `{ ok:false, error:"FULL" }`. Uses `LockService` around count + append.
   - Saves receipt to Drive folder `Dink for the Roots Receipts` as `<ref>-<fileName>`, appends row, status `Pending check`.
   - Sends player thank-you email (HTML + plain text). No poster since 2026-10-21 (user request): `POSTER_URL` is empty, so nothing is attached. Sends organizer alert to the union of the two default organizer emails and any comma-separated addresses in script property `ORGANIZER_EMAIL`.
   - After the append (inside the lock) rebuilds the 6 category tabs. A tab rebuild failure is logged and does not fail the registration.
   - Returns `{ ok:true, ref:"DFR-XXXXXX" }`.
3. `{ action:"pending", key }` (admin) → `{ ok:true, items:[{ ref, row, fullName, email, category, paymentRef, submittedAt, fileName, mimeType, base64 }] }` for rows with status `Pending check`, max 10 per call.
4. `{ action:"verify", key, ref, result:{ verdict, amount, referenceNo, txnDate, sender, recipient, ocrText, tamperScore, flags[], checkedAt } }` (admin) → writes the result columns, sets status to the verdict. `verdict` in `Verified | Needs review | Suspect`.
5. `{ action:"refs", key }` (admin) → `{ ok:true, refs:[{ ref, referenceNo, imageHash }] }` for duplicate detection.

Admin `key` is compared with script property `ADMIN_KEY`. Wrong key → `{ ok:false, error:"FORBIDDEN" }`.

Sheet tab `Registrations` columns (in this order):
`Ref, Submitted At, Status, Full Name, Email, Phone, Municipality, Barangay, Category, Partner Name, Club Name, Shirt Size, Payment Ref (player), Receipt File ID, Receipt URL, Valid ID File ID, Valid ID URL, Verdict, OCR Amount, OCR Reference No, OCR Txn Date, OCR Sender, OCR Recipient, Tamper Score, Flags, Image Hash, Checked At, OCR Text, Player Email Sent, Organizer Email Sent`.

## Site config (`site/js/config.js`)

```js
export const CONFIG = {
  ENDPOINT: "",          // Apps Script /exec URL. Empty = demo mode (localStorage, fake slots).
  FEE: 1000,
  PAYMENT_QR: "assets/payment-qr.png",
  PAYMENT_LABEL: "",     // e.g. "GCash · Juan D. · 0917 XXX XXXX", set by the user
};
```

## Gates

Opus QA runs: anti-slop, bug hunt (320/390/768/1440), keyboard, contrast, reduced motion, console clean, Lighthouse, Code.gs tests, Python tests.

## Category tabs (CR1)

One tab per category, named in the table above. `Registrations` stays the single source of truth. Tabs are rebuilt from it after each `register`, after each `verify`, and by the editor function `rebuildTabs()`.

Tab columns: `Pair No, Pair Status, Player 1, P1 Ref, P1 Status, P1 Club, P1 Phone, P1 Email, P1 Shirt, Player 2, P2 Ref, P2 Status, P2 Club, P2 Phone, P2 Email, P2 Shirt, Note`.

Pairing inside one category, rows with status not `Rejected`, in submit order:
1. Mutual match: A.partnerName equals B.fullName and B.partnerName equals A.fullName → Pair Status `Complete`.
2. One-way match on either side → Pair Status `Complete`, Note `Partner names do not match exactly. Check.`
3. No match → Player 2 blank, Pair Status `Waiting for partner`, Note `Named partner: <partnerName>`.
Name compare: lowercase, letters and digits only, single spaces.

## Setup migration (CR1)

`setup()` writes the new header when the `Registrations` tab has no data rows. With data rows and a header mismatch it throws, as before. The test row `DFR-6TGX38` is deleted before setup (user approved 2026-10-21).
