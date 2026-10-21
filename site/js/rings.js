// Topographic contour rings that echo the poster. Thin lines, slow outward drift.
export function initRings(canvas, { animate }) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let w = 0, h = 0, t = 0, raf = 0, last = 0, visible = true;

  // Centers in viewport fractions: top right and left edge, as on the poster.
  const sets = [
    { cx: 0.82, cy: -0.04, count: 22, gap: 0.028, amp: 0.012, alpha: 0.2 },
    { cx: -0.06, cy: 0.42, count: 16, gap: 0.03, amp: 0.01, alpha: 0.14 },
  ];

  function resize() {
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width));
    h = Math.max(1, Math.round(r.height));
    canvas.width = w;   // 1x is enough for soft hairlines
    canvas.height = h;
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    const unit = Math.max(w, h);
    ctx.lineWidth = 1;
    for (const s of sets) {
      const cx = s.cx * w, cy = s.cy * h;
      const drift = (t * 0.018) % 1; // rings move outward by one gap per cycle
      for (let i = 0; i < s.count; i++) {
        const k = i + drift;
        const r = (0.05 + k * s.gap) * unit;
        const fade = 1 - k / s.count;
        ctx.strokeStyle = `rgba(255, 236, 228, ${(s.alpha * fade).toFixed(3)})`;
        ctx.beginPath();
        for (let a = 0; a <= 64; a++) {
          const th = (a / 64) * Math.PI * 2;
          const wob = 1 + s.amp * Math.sin(th * 3 + i * 0.6 + t * 0.4) + s.amp * 0.6 * Math.sin(th * 5 - t * 0.3);
          const x = cx + Math.cos(th) * r * wob;
          const y = cy + Math.sin(th) * r * wob * 0.92;
          if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < 40) return; // about 25 fps is plenty for slow drift
    t += (now - (last || now)) / 1000;
    last = now;
    draw();
  }
  const start = () => { if (animate && !raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(loop); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };

  resize();
  addEventListener("resize", resize, { passive: true });
  if (!animate) return;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }).observe(canvas);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  start();
}
