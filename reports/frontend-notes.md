# Frontend notes: Dink for the Roots registration page

Date: 2026-10-21.
Agent: designme frontend agent (Opus 5.5).
Scope: `site/index.html`, `site/css/*`, `site/js/*`.
No file in `site/assets/`, `apps-script/`, `receipt-checker/`, or `tests/` was changed.

## Files

| File | Purpose |
|---|---|
| `site/index.html` | Page markup, meta tags, Open Graph, inline SVG ball favicon, hero layers, sections, form. |
| `site/css/tokens.css` | Color, type, radius, and spacing tokens as CSS custom properties. |
| `site/css/main.css` | Layout, hero layers, sections, form, responsive rules, reduced motion rules. |
| `site/js/config.js` | `CONFIG` exactly as in `ORCHESTRATOR.md`. `ENDPOINT` is empty. |
| `site/js/api.js` | Apps Script client (`slots`, `register`) and demo mode with localStorage. |
| `site/js/form.js` | Slot display, shirt size guide, payment QR, receipt upload, validation, submit states. |
| `site/js/main.js` | Entry module: title sequence (GSAP), pointer and scroll parallax, reveals, lazy 3D load. |
| `site/js/rings.js` | Animated contour ring canvas that echoes the poster. |
| `site/js/scene3d.js` | Three.js r160 scene: procedural paddles and balls, canvas textures, no text or logos. |

## Design decisions

- D1: Palette comes from the poster: forest `#1e3b2a`, maroon `#7d0b0b`, gold `#c9a45c`, dusk maroon, court blue as accent.
- D2: Display type is Montserrat 800 and 900. Body type is Figtree. Both load from Google Fonts.
- D3: The hero stacks five layers: court photo, contour ring canvas, warm haze, scrim, 3D canvas. The title block sits above them.
- D4: The desktop photo crop is `object-position: 50% 64%`, so the players stay on the right. The mobile crop is `82% 50%`, so the players stay below the title.
- D5: The title is one image used in three clipped layers: "DINK FOR" (top 37%), "THE ROOTS" (37% to 100% without the root box), and the root box (x 70% to 95%, y 70% to 100%).
- D6: The split line is 37%, not 48%. A pixel scan of `title.png` shows the empty row between the two lines at 36.8%.
- D7: `title.png` and `title.webp` have no subtitle pixels (alpha is 0 in that area). The page renders the subtitle as live HTML text in the same position, sized with container query units.
- D8: The final title pose is the CSS layout. GSAP animates from offsets to that pose, so every load ends in the same place.
- D9: The logos sit above the title in one row, seal left and card right, as on the poster.
- D10: Paddles use an extruded rounded shape with a black bevel as the edge guard, a planar UV face texture, and a spiral grip texture. Balls use a lime shell with an alpha hole mask over a darker inner sphere.
- D11: ScrollTrigger is not loaded. An IntersectionObserver handles the section reveals, so the extra script was not needed.
- D12: The size guide highlights the chosen column on the chart image with an overlay box. A text line also states the width and length in inches.
- D13: "Pairs left" rounds up. One open player slot still completes a pair, because each player registers alone.
- D14: The form section is a light paper card on the dark page, for text contrast and readability.

## Verified, with evidence

Checks ran in Chrome through the chrome-devtools MCP against `python -m http.server 8137` in `site/`.

1. Desktop 1440 x 900: the hero renders with the photo, rings, logos, title, chips, and 3D canvas. Screenshot: `screens/desktop-hero.png`.
2. Mobile 390 x 844: the title sits over the sky and the player sits below it. Screenshot: `screens/mobile-hero.png`.
3. No horizontal overflow: `scrollWidth` equals the viewport width at 1440, 390, and 320.
4. The title sequence was sampled every 250 ms. Line 1 wiped in, then line 2, then the root box grew downward from 30% inset to 0%. The final clip values match the CSS values.
5. The 3D canvas exists after load and the hero has no `no-webgl` class.
6. The size guide opens on focus and on selection. For 2XL it states "width 23 in, length 30 in", and the overlay box sits on the 2XL column. Screenshots: `screens/mobile-size-guide.png`, `screens/desktop-form-filled.png`.
7. An empty submit shows 10 inline errors and moves focus to Full name. Screenshot: `screens/mobile-validation.png`.
8. Demo submit returned a `DFR-XXXXXX` reference, reset the form, and lowered the open slots for that category. Screenshot: `screens/desktop-submit-success.png`.
9. A second submit with the same email in different letter case returned the duplicate notice with the first reference.
10. With a stubbed endpoint, the request body matched the contract: `action: "register"`, `player` with 9 fields, `receipt` with `fileName`, `mimeType`, `base64`, and `consent: true`. The phone was normalized to `09171234567`.
11. The decoded receipt base64 was byte-identical to the original 109,681-byte file.
12. A stubbed `FULL` reply showed the full notice and disabled the full category radio card.
13. A stubbed network failure showed "No connection" with a "Try again" button and kept the form values.
14. Reduced motion at 320 x 700: no title animation, no photo transform, one static 3D frame, all reveal blocks visible. Screenshot: `screens/mobile320-reduced-motion.png`.
15. Console: no JavaScript errors. One 404 for `assets/payment-qr.png` appears, and the page shows the "Payment QR coming soon" placeholder.

## Not verified

- Safari, Firefox, and real phones were not tested.
- A live Apps Script endpoint was not tested. The endpoint tests used a fetch stub.
- The GET `?action=slots` path against Apps Script redirects was not tested live.
- The WebGL failure fallback (`no-webgl` class and CSS balls) was not forced in a browser.
- Lighthouse, frame rate on a low-end phone, and screen reader output were not measured.
- Text contrast over the photo was not measured with a tool. Chips and notes use dark backgrounds at 60% to 74% opacity as a scrim.

## Open items for QA

- O1: The 404 for `payment-qr.png` stays until the user adds the real QR file to `site/assets/`.
- O2: On short phones (320 x 700) the date and venue chips cover part of the player's face. The title and chips take most of the hero height there.
- O3: The consent checkbox is 24 px. Its label is part of the tap target.
- O4: The local server on port 8137 was left running in the background.
