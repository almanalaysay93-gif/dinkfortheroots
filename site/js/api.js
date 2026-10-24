// Apps Script client. Empty CONFIG.ENDPOINT switches to demo mode (localStorage only).
import { CONFIG } from "./config.js";

export const CATEGORIES = [
  { key: "novice-mens", label: "Novice Men's Doubles" },
  { key: "novice-womens", label: "Novice Women's Doubles" },
  { key: "novice-mixed", label: "Novice Mixed Doubles" },
  { key: "rookie-mixed", label: "Rookie Mixed Doubles" },
];
export const CAP = 40;
export const CUTOFF_ISO = "2026-11-20T23:59:59+08:00";
const CUTOFF_MS = Date.parse(CUTOFF_ISO);

export const isDemo = () => !CONFIG.ENDPOINT;
export const isPastCutoff = () => Date.now() > CUTOFF_MS;

const DEMO_KEY = "dfr-demo-registrations";
const DEMO_BASE = {
  "novice-mens": 18, "novice-womens": 10, "novice-mixed": 22,
  "rookie-mixed": 16,
};

function readDemo() {
  try { return JSON.parse(localStorage.getItem(DEMO_KEY) || "[]"); } catch { return []; }
}
function writeDemo(rows) {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(rows)); } catch { /* storage blocked: preview only */ }
}

function demoRef() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "DFR-" + Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

async function post(payload) {
  const res = await fetch(CONFIG.ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function getSlots() {
  if (isDemo()) {
    const rows = readDemo();
    const slots = {};
    for (const { key } of CATEGORIES) {
      const mine = rows.filter((r) => r.category === key).length;
      slots[key] = { taken: Math.min(CAP, DEMO_BASE[key] + mine), cap: CAP };
    }
    return { ok: true, open: !isPastCutoff(), closesAt: CUTOFF_ISO, slots };
  }
  const res = await fetch(CONFIG.ENDPOINT + (CONFIG.ENDPOINT.includes("?") ? "&" : "?") + "action=slots&_=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function register(payload) {
  if (isDemo()) {
    if (isPastCutoff()) {
      return { ok: false, error: "CLOSED", message: "Registration closed on November 20, 2026 at 11:59 PM." };
    }
    await new Promise((r) => setTimeout(r, 900));
    const rows = readDemo();
    const p = payload.player;
    const email = p.email.toLowerCase();
    const dup = rows.find((r) => r.email === email && r.category === p.category);
    if (dup) return { ok: true, duplicate: true, ref: dup.ref };
    const taken = DEMO_BASE[p.category] + rows.filter((r) => r.category === p.category).length;
    if (taken >= CAP) return { ok: false, error: "FULL", message: "This category is full." };
    const ref = demoRef();
    rows.push({ ref, email, category: p.category, fullName: p.fullName, at: new Date().toISOString() });
    writeDemo(rows);
    return { ok: true, ref };
  }
  return post({ action: "register", ...payload });
}
