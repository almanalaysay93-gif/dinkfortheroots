// Falling pickleballs behind the event and category sections.
// One sticky 2D canvas. Ball positions are a pure function of scroll offset,
// so scrolling up plays the fall in reverse. Sprites are drawn in code once.

const BASE = 64;                 // sprite ball radius in px
const LEVELS = [               // depth levels: far, mid, near
  { blur: 3.5, alpha: 0.34 },
  { blur: 1.2, alpha: 0.6 },
  { blur: 0, alpha: 0.92 },
];

export function initBallfall(zone, { animate }) {
  const host = zone && zone.querySelector(".ballfall");
  if (!host) return;
  const sprites = LEVELS.map((l) => makeSprite(l.blur));

  if (!animate) { placeStatic(host, sprites); return; }

  const canvas = host.querySelector("canvas");
  const ctx = canvas && canvas.getContext("2d");
  if (!ctx) return;

  let w = 0, h = 0, dpr = 1, balls = [], raf = 0, visible = false;

  function layout() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, zone.clientWidth);
    h = Math.max(1, window.innerHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    balls = makeBalls(w, h, textRight(zone));
    draw();
  }

  function draw() {
    raf = 0;
    const zr = zone.getBoundingClientRect();
    const top = canvas.getBoundingClientRect().top;
    const s = h - zr.top;          // scroll travel since the zone entered the viewport
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const b of balls) {
      const span = h + b.r * 4;
      const fall = s * b.f;
      let vy = (b.y0 * span + fall) % span;
      if (vy < 0) vy += span;
      vy -= b.r * 2;
      const vx = b.x0 + Math.sin(fall * 0.006 + b.ph) * b.amp;
      const y = vy - top;            // viewport y to canvas y (the canvas is sticky)
      if (y < -b.r * 2 || y > h + b.r * 2) continue;
      ctx.globalAlpha = b.a;
      ctx.save();
      ctx.translate(vx, y);
      ctx.rotate(b.ph + (fall / b.r) * 0.45 * b.dir);
      const sp = sprites[b.lv];
      const k = b.r / BASE;
      ctx.drawImage(sp, -sp.width / 2 * k, -sp.height / 2 * k, sp.width * k, sp.height * k);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  const kick = () => { if (visible && !raf) raf = requestAnimationFrame(draw); };

  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) kick();
  });
  io.observe(zone);
  addEventListener("scroll", kick, { passive: true });
  let rt = 0;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(layout, 120); }, { passive: true });
  layout();
}

/* Right edge of the loose text (eyebrows, headings, ledes). Facts and cards are opaque, so balls may pass behind them. */
function textRight(zone) {
  let right = 0;
  zone.querySelectorAll(".eyebrow, .h2, .lede, .demo-note").forEach((el) => {
    if (el.hidden) return;
    const rg = document.createRange();
    rg.selectNodeContents(el);
    for (const r of rg.getClientRects()) right = Math.max(right, r.right);
  });
  return right;
}

/* Ball set. Balls stay right of the loose text and in the left gutter.
   When no free column is left (phones), a few faint balls hug the right edge. */
function makeBalls(w, h, right) {
  const rnd = mulberry(7);
  const out = [];
  const inner = Math.min(1180, w - 2 * Math.min(48, Math.max(16, w * 0.04)));
  const gutter = (w - inner) / 2;
  const free = w - right;
  const wide = free >= 140;
  const n = wide ? 14 : 5;
  for (let i = 0; i < n; i++) {
    const lv = wide ? (i % 3 === 0 ? 2 : i % 3 === 1 ? 1 : 0) : (i % 2 ? 1 : 0);
    const r = wide
      ? [10 + rnd() * 6, 16 + rnd() * 7, 26 + rnd() * 12][lv]
      : [6 + rnd() * 2, 8 + rnd() * 3][lv];
    const amp = wide ? 6 + rnd() * 18 : 2 + rnd() * 3;
    let x0;
    if (wide && lv < 2 && gutter > 70 && i % 4 === 1) {
      x0 = r + amp + rnd() * Math.max(1, gutter - 2 * (r + amp));     // left gutter, small only
    } else if (wide) {
      const lo = Math.max(w * 0.6, right + r + amp + 12);
      x0 = lo + rnd() * Math.max(1, w - lo - r * 0.4);
    } else {
      x0 = w - r * (0.1 + rnd() * 0.5);                                 // half off the right edge
    }
    out.push({
      lv, r, x0, amp,
      a: wide ? LEVELS[lv].alpha : 0.16 + lv * 0.06,   // phones: faint, so text over a ball keeps contrast
      y0: i / n + rnd() * 0.05,
      f: 0.22 + lv * 0.16 + rnd() * 0.08,   // nearer balls fall faster
      ph: rnd() * Math.PI * 2,
      dir: rnd() > 0.5 ? 1 : -1,
    });
  }
  return out.sort((a, b) => a.lv - b.lv);
}

/* Reduced motion: a few still balls, no scroll motion. */
function placeStatic(host, sprites) {
  host.classList.add("is-static");
  const spots = [
    { x: 88, y: 12, s: 64, lv: 2 }, { x: 74, y: 30, s: 30, lv: 1 },
    { x: 93, y: 58, s: 40, lv: 1 }, { x: 80, y: 84, s: 24, lv: 0 },
  ];
  for (const p of spots) {
    const img = document.createElement("img");
    img.src = sprites[p.lv].toDataURL("image/png");
    img.alt = "";
    img.className = "ballfall__still";
    img.style.cssText = `left:${p.x}%;top:${p.y}%;width:${p.s}px;opacity:${LEVELS[p.lv].alpha}`;
    host.appendChild(img);
  }
}

/* Lime perforated ball sprite: shell gradient, projected round holes, limb shade, highlight. */
function makeSprite(blur) {
  const R = BASE, pad = Math.ceil(blur * 3) + 2, S = R * 2 + pad * 2;
  const ball = document.createElement("canvas");
  ball.width = ball.height = R * 2;
  const g = ball.getContext("2d");
  const c = R;

  const shell = g.createRadialGradient(c * 0.72, c * 0.6, R * 0.05, c, c, R);
  shell.addColorStop(0, "#f3ff9a");
  shell.addColorStop(0.35, "#d4e83a");
  shell.addColorStop(0.85, "#a9bd1e");
  shell.addColorStop(1, "#7f9113");
  g.fillStyle = shell;
  g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill();

  // Fibonacci sphere holes, front half only, foreshortened toward the edge.
  const n = 26, hole = Math.sin(0.19) * R;
  g.fillStyle = "#2a3510";
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const rr = Math.sqrt(1 - y * y);
    const t = i * Math.PI * (3 - Math.sqrt(5));
    const x = Math.cos(t) * rr, z = Math.sin(t) * rr;
    if (z < 0.08) continue;
    g.beginPath();
    g.ellipse(c + x * R * 0.96, c + y * R * 0.96, hole * z, hole, Math.atan2(y, x), 0, Math.PI * 2);
    g.fill();
  }

  const limb = g.createRadialGradient(c, c, R * 0.55, c, c, R);
  limb.addColorStop(0, "rgba(0,0,0,0)");
  limb.addColorStop(1, "rgba(20,30,6,.38)");
  g.fillStyle = limb;
  g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.fill();

  g.fillStyle = "rgba(255,255,240,.32)";
  g.beginPath(); g.ellipse(c * 0.66, c * 0.52, R * 0.22, R * 0.12, -0.6, 0, Math.PI * 2); g.fill();

  const out = document.createElement("canvas");
  out.width = out.height = S;
  const o = out.getContext("2d");
  if (blur > 0 && "filter" in o) o.filter = `blur(${blur}px)`;
  o.drawImage(ball, pad, pad);
  return out;
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
