// Page entry: hero title sequence, layered parallax, contour rings, reveals, lazy 3D, form.
import { initForm, loadSlots } from "./form.js";
import { initRings } from "./rings.js";

const root = document.documentElement;
const reduce = root.classList.contains("reduced-motion");
const gsap = window.gsap;

initForm();
loadSlots();
initTopbar();
initRings(document.getElementById("rings"), { animate: !reduce });

if (gsap && !reduce) {
  playTitle();
  initParallax();
} else {
  root.classList.remove("anim-pending");
}
initReveals();
scheduleScene();

/* Title sequence. The final pose is the CSS layout, so every load ends in the same place. */
function playTitle() {
  const line1 = document.querySelector(".title__line1");
  const line2 = document.querySelector(".title__line2");
  const roots = document.querySelector(".title__roots");
  const logos = document.querySelectorAll(".logo");
  const meta = document.getElementById("heroMeta");
  const sub = document.querySelector(".title__sub");

  const wipe = { p: 0 };
  const line2Clip = (x) => {
    // Reveal "THE ROOTS" left to right while the root area stays cut out.
    const X = x * 100;
    if (X <= 70) return `polygon(0 37%, ${X}% 37%, ${X}% 100%, 0 100%)`;
    if (X <= 95) return `polygon(0 37%, ${X}% 37%, ${X}% 70%, 70% 70%, 70% 100%, 0 100%)`;
    return `polygon(0 37%, ${X}% 37%, ${X}% 100%, 95% 100%, 95% 70%, 70% 70%, 70% 100%, 0 100%)`;
  };

  gsap.set(line1, { clipPath: "inset(0% 100% 63% 0%)" });
  gsap.set(line2, { clipPath: line2Clip(0) });
  gsap.set(roots, { clipPath: "inset(70% 5% 30% 70%)" });
  gsap.set(logos, { y: 40, opacity: 0, scale: 0.86 });
  gsap.set(meta, { y: 24, opacity: 0 });
  gsap.set(sub, { y: 10, opacity: 0 });
  gsap.set([line1, line2, roots], { opacity: 1 });
  root.classList.remove("anim-pending");

  const tl = gsap.timeline({ defaults: { ease: "power3.out" }, delay: 0.15 });
  tl.to(logos, { y: 0, opacity: 1, scale: 1, duration: 0.9, stagger: 0.12, ease: "back.out(1.6)" })
    .to(line1, { clipPath: "inset(0% 0% 63% 0%)", duration: 0.8, ease: "power2.inOut" }, "-=0.35")
    .fromTo(line1, { y: 14 }, { y: 0, duration: 0.8 }, "<")
    .to(wipe, { p: 1, duration: 0.85, ease: "power2.inOut", onUpdate: () => { line2.style.clipPath = line2Clip(wipe.p); } }, "-=0.35")
    .fromTo(line2, { y: 14 }, { y: 0, duration: 0.85 }, "<")
    .to(sub, { y: 0, opacity: 1, duration: 0.7 }, "-=0.3")
    .to(roots, { clipPath: "inset(70% 5% 0% 70%)", duration: 1.1, ease: "power2.out" }, "-=0.1")
    .to(meta, { y: 0, opacity: 1, duration: 0.8 }, "-=0.7")
    .add(() => {
      line2.style.clipPath = "";
      // Slow idle float, kept small so the resting position stays consistent.
      gsap.to(".title__art", { y: -6, duration: 3.2, ease: "sine.inOut", yoyo: true, repeat: -1 });
      gsap.to(".logo--seal", { rotate: 3, duration: 4, ease: "sine.inOut", yoyo: true, repeat: -1 });
    });
}

/* Pointer and scroll parallax over the hero layers. */
function initParallax() {
  const hero = document.querySelector(".hero");
  const photo = document.querySelector(".layer--photo");
  const rings = document.getElementById("rings");
  const brand = document.getElementById("brand");
  const fine = window.matchMedia("(pointer: fine)").matches;
  let px = 0, py = 0, tx = 0, ty = 0, sy = 0, raf = 0;

  const apply = () => {
    raf = 0;
    px += (tx - px) * 0.08;
    py += (ty - py) * 0.08;
    const h = hero.offsetHeight || 1;
    const s = Math.min(1, sy / h);
    photo.style.transform = `translate3d(${px * -14}px, ${py * -10 + s * h * 0.22}px, 0) scale(${1 + s * 0.06})`;
    rings.style.transform = `translate3d(${px * -26}px, ${py * -18 + s * h * 0.12}px, 0)`;
    brand.style.transform = `translate3d(${px * 10}px, ${py * 8 - s * h * 0.12}px, 0)`;
    brand.style.opacity = String(1 - s * 0.9);
    if (Math.abs(tx - px) > 0.001 || Math.abs(ty - py) > 0.001) raf = requestAnimationFrame(apply);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(apply); };

  if (fine) {
    hero.addEventListener("pointermove", (e) => {
      tx = (e.clientX / innerWidth) * 2 - 1;
      ty = (e.clientY / innerHeight) * 2 - 1;
      kick();
    }, { passive: true });
    hero.addEventListener("pointerleave", () => { tx = 0; ty = 0; kick(); });
  }
  addEventListener("scroll", () => { sy = scrollY; if (sy < (hero.offsetHeight || 0) * 1.2) kick(); }, { passive: true });
}

function initTopbar() {
  const bar = document.getElementById("topbar");
  const hero = document.querySelector(".hero");
  const io = new IntersectionObserver(([e]) => bar.classList.toggle("is-solid", !e.isIntersecting), { rootMargin: "-80px 0px 0px 0px" });
  io.observe(hero);
}

function initReveals() {
  const els = document.querySelectorAll(".reveal");
  if (reduce || !("IntersectionObserver" in window)) { els.forEach((el) => el.classList.add("is-in")); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
  }, { rootMargin: "0px 0px -10% 0px" });
  els.forEach((el) => io.observe(el));
}

/* Load the 3D layer after first paint so the photo and title stay the LCP. */
function scheduleScene() {
  const host = document.getElementById("scene3d");
  const start = () => {
    import("./scene3d.js")
      .then((m) => m.initScene(host, { animate: !reduce }))
      .catch(() => host.closest(".hero").classList.add("no-webgl"));
  };
  const later = () => ("requestIdleCallback" in window ? requestIdleCallback(start, { timeout: 1500 }) : setTimeout(start, 600));
  if (document.readyState === "complete") later();
  else addEventListener("load", later, { once: true });
}
