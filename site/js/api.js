// Apps Script client. Empty CONFIG.ENDPOINT switches to demo mode (localStorage only).
import { CONFIG } from "./config.js";

export const CATEGORIES = [
  { key: "novice-mens", label: "Novice Men's Doubles" },
  { key: "novice-womens", label: "Novice Women's Doubles" },
  { key: "novice-mixed", label: "Novice Mixed Doubles" },
  { key: "rookie", label: "Rookie Doubles" },
];
export const CAP = 36;

export const isDemo = () => !CONFIG.ENDPOINT;

const DEMO_KEY = "dfr-demo-registrations";
const DEMO_BASE = { "novice-mens": 20, "novice-womens": 12, "novice-mixed": 26, "rookie": 8 };

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
    return { ok: true, open: true, slots };
  }
  const res = await fetch(CONFIG.ENDPOINT + (CONFIG.ENDPOINT.includes("?") ? "&" : "?") + "action=slots");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function register(payload) {
  if (isDemo()) {
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
