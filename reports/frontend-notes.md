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

## v2 (2026-10-21)

### Changes

1. V1: Falling pickleballs.
   The new file `site/js/ballfall.js` draws lime perforated balls on one sticky 2D canvas.
   The canvas sits in a new wrapper `#ballZone` around `#event` and `#categories`.
   Ball sprites are drawn in code once, at three depth levels (blur, size, opacity).
   Ball position and spin are a pure function of the scroll offset, so a scroll up plays the fall in reverse.
   The draw runs in one `requestAnimationFrame` per scroll event, only while the zone is on screen.
   Balls stay right of the measured text edge (eyebrow, heading, lede) and in the left gutter.
   On phones, five small balls sit half off the right edge at 16% to 22% opacity.
   Reduced motion shows four still balls (two on phones) and no scroll motion.
   The category cards now have an opaque base, so a ball never shows through card text.
2. V2: Court photo behind the registration section.
   `#register` has a `.court-bg` layer with a sticky viewport-height frame, so the court stays behind the form while the form scrolls.
   The frame uses `<picture>` with WEBP and JPG at 960w and 1920w, `sizes="max(100vw, 178vh)"`.
   JavaScript sets the image sources only when the section is within 900 px of the viewport, so the photo never competes with the hero LCP.
   A dark scrim (80% to 86% at the top) and a top and bottom mask keep the heading readable.
   The image drifts by up to 5% of the viewport height with scroll. Reduced motion has no drift.
   `.section--register` now uses `overflow: clip` (with `hidden` as a fallback), because `hidden` stops `position: sticky`.
3. V3: Google Maps links.
   The hero venue chip and the facts venue are links to the Google Maps search URL, with `target="_blank"`, `rel="noopener"`, and the name "Pickle Park, Roxas Extension, Digos City (opens Google Maps)".
   The chip shows an underline and an external icon. The facts link shows an underline and "Open in Maps".
   Both links are at least 44 px high and have hover and focus styles.

### Verified, with evidence

Checks ran in Chrome through the chrome-devtools MCP against `python -m http.server 8138` in `site/`.
The form was not submitted, because the live endpoint is set.

1. Scroll reversal at 1440 x 900: a canvas pixel hash at offset 300 px, then 700 px, then 300 px again gave the same hash at 300 px and a different hash at 700 px.
2. No ball under loose text: a sweep of the zone in 50 px steps found 0 canvas pixels inside 266 text line boxes at 1440 x 900, and 0 at 390 x 844.
3. No horizontal overflow at 1440 x 900 and 390 x 844.
4. The court image did not load at the top of the page. It loaded (1920 WEBP) when the form came near. LCP stayed on the hero title.
5. Contrast over the court photo at 1440 x 900, from the 99th percentile background pixel next to the text: lede 8.2:1, heading 11.8:1, eyebrow 8.7:1.
6. Both map links have the right `href`, `target`, `rel`, and accessible name. Heights: chip 44 px, facts link 74 px.
7. Reduced motion: the ball layer shows still balls, the court image has no transform.
8. Console: no errors. The only warning was the `getImageData` readback from the test script.

Screenshots: `screens/v2-desktop-balls-a.png`, `screens/v2-desktop-balls-b.png`, `screens/v2-desktop-register-court.png`, `screens/v2-desktop-reduced-motion.png`, `screens/v2-mobile-hero-maplink.png`, `screens/v2-mobile-balls-maplink.png`, `screens/v2-mobile-register-court.png`.

### Not verified

- Safari and Firefox. Safari has no canvas `filter`, so far balls there are not blurred (assumption, not tested).
- Contrast was measured at 1440 x 900 only. The phone heading sits over the same scrim band.
- Hover styles were not captured in a screenshot.
- Frame rate on a low-end phone was not measured.
- The server on port 8138 was stopped.
