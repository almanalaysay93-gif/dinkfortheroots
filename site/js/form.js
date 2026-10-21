// Registration form: slots, shirt size guide, payment QR, uploads, validation, submit.
import { CONFIG } from "./config.js";
import { CATEGORIES, CAP, getSlots, isDemo, isPastCutoff, register } from "./api.js";

const SIZES = [
  ["K8", 13, 17.5], ["K10", 13.5, 18.5], ["K12", 14.5, 19.5], ["K14", 15, 20], ["K16", 16, 21.5],
  ["K18", 17, 23], ["K20", 18, 24], ["XS", 18.5, 25], ["S", 19, 26], ["M", 20, 27],
  ["L", 21, 28], ["XL", 22, 29], ["2XL", 23, 30], ["3XL", 24, 31], ["4XL", 25, 32],
];
// Column geometry of the size table inside size-chart.jpg (2007 x 1555 px).
const CHART = { w: 2007, h: 1555, x0: 290, step: 109.6, col: 104, top: 1182, bottom: 1512 };

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const PHONE_RE = /^(09\d{9}|\+639\d{9})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LGUS = ["Digos City", "Bansalan", "Hagonoy", "Kiblawan", "Magsaysay", "Malalag", "Matanao", "Padada", "Santa Cruz", "Sulop"];
const CLUB_MAX = 100;

// One entry per file upload. Ids match index.html.
const UPLOADS = {
  receipt: {
    input: "receipt", zone: "dropZone", thumb: "receiptThumb", name: "receiptName",
    size: "receiptSize", file: "dropFile", missing: "Upload your payment receipt screenshot.",
  },
  validId: {
    input: "validId", zone: "idDropZone", thumb: "idThumb", name: "idName",
    size: "idSize", file: "idFile", missing: "Upload a photo of your valid ID.",
  },
};
const UPLOAD_KEYS = Object.keys(UPLOADS);

const $ = (sel, root = document) => root.querySelector(sel);
const peso = (n) => "₱" + n.toLocaleString("en-PH");

let slotState = null;
let closed = false;
const uploads = { receipt: null, validId: null };
let lastPayload = null;

/* ---------- Slots ---------- */
export async function loadSlots() {
  const note = $("#slotsNote");
  try {
    const res = await getSlots();
    if (!res || !res.ok) throw new Error(res && res.message || "slots");
    slotState = res.slots;
    const open = res.open !== false && !isPastCutoff();
    renderSlots(res.slots, open);
    if (!open) applyClosed();
    if (isDemo()) { note.textContent = "Preview mode. Slot counts are sample numbers."; note.hidden = false; }
  } catch {
    document.querySelectorAll("[data-slots]").forEach((el) => { el.textContent = "Slot count unavailable right now."; });
  }
}

function renderSlots(slots, open) {
  for (const { key } of CATEGORIES) {
    const s = slots[key] || { taken: 0, cap: CAP };
    const cap = s.cap || CAP;
    const leftPairs = Math.max(0, Math.ceil((cap - s.taken) / 2)); // a single open player slot still completes a pair
    const capPairs = Math.floor(cap / 2);
    const full = s.taken >= cap || !open;
    const card = document.querySelector(`.cat[data-cat="${key}"]`);
    if (card) {
      card.classList.toggle("is-full", full);
      card.querySelector("[data-slots]").innerHTML = !open
        ? "Registration closed."
        : full
          ? "Full. No slots left."
          : `<strong>${leftPairs}</strong> of ${capPairs} pairs left`;
      card.querySelector(".meter span").style.width = Math.min(100, (s.taken / cap) * 100) + "%";
    }
    const radio = document.querySelector(`input[name="category"][value="${key}"]`);
    const label = document.querySelector(`[data-rslots="${key}"]`);
    if (radio) {
      radio.disabled = full;
      if (full && radio.checked) radio.checked = false;
    }
    if (label) label.textContent = !open ? "Closed" : full ? "Full" : `${leftPairs} of ${capPairs} pairs left`;
  }
}

// Registration is closed: the server said so, or the browser clock is past the cut-off.
function applyClosed() {
  closed = true;
  $("#formStatus").innerHTML = "";
  $("#regForm").querySelectorAll("input, select, textarea, button").forEach((el) => { el.disabled = true; });
  $("#closedNote").hidden = false;
}

/* ---------- Shirt sizes ---------- */
function buildSizes() {
  const wrap = $("#sizeChips");
  const frag = document.createDocumentFragment();
  SIZES.forEach(([size], i) => {
    if (size === "XS") {
      const sep = document.createElement("span");
      sep.className = "sizes__sep";
      sep.setAttribute("aria-hidden", "true");
      frag.append(sep);
    }
    const label = document.createElement("label");
    label.className = "size";
    label.innerHTML = `<input type="radio" name="shirtSize" value="${size}" ${i === 0 ? "required" : ""}><span>${size}</span>`;
    frag.append(label);
  });
  wrap.append(frag);

  const guide = $("#sizeGuide");
  const open = () => { guide.hidden = false; };
  wrap.addEventListener("focusin", open);
  wrap.addEventListener("change", (e) => {
    if (e.target.name === "shirtSize") { open(); showSize(e.target.value); clearError("shirtSize"); }
  });
}

function showSize(size) {
  const i = SIZES.findIndex((s) => s[0] === size);
  if (i < 0) return;
  const [, w, l] = SIZES[i];
  const hl = $("#sizeHl");
  hl.style.left = ((CHART.x0 + i * CHART.step) / CHART.w) * 100 + "%";
  hl.style.width = (CHART.col / CHART.w) * 100 + "%";
  hl.style.top = (CHART.top / CHART.h) * 100 + "%";
  hl.style.height = ((CHART.bottom - CHART.top) / CHART.h) * 100 + "%";
  hl.classList.add("is-on");
  $("#sizeRead").innerHTML = `Size <strong>${size}</strong>: width <strong>${w} in</strong> (underarm to underarm), length <strong>${l} in</strong> (shoulder tip to hem).`;
}

/* ---------- Payment QR ---------- */
function buildQr() {
  const frame = $("#qrFrame");
  const soon = () => {
    frame.innerHTML = `<div class="qr-soon"><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="6" width="14" height="14" rx="2"/><rect x="28" y="6" width="14" height="14" rx="2"/><rect x="6" y="28" width="14" height="14" rx="2"/><path d="M28 28h6v6h-6zM36 36h6v6h-6zM28 40h4M40 28v4"/></svg><strong>Payment QR coming soon</strong><span>Check back before you pay.</span></div>`;
  };
  if (!CONFIG.PAYMENT_QR) { soon(); }
  else {
    const img = new Image();
    img.alt = `Payment QR code for the ${peso(CONFIG.FEE)} registration fee`;
    img.width = 260; img.height = 260;
    img.onload = () => { frame.replaceChildren(img); };
    img.onerror = soon;
    img.src = CONFIG.PAYMENT_QR;
    soon();
  }
  if (CONFIG.PAYMENT_LABEL) { const p = $("#payLabel"); p.textContent = CONFIG.PAYMENT_LABEL; p.hidden = false; }
  document.querySelectorAll(".pay__fee strong").forEach((el) => { el.textContent = peso(CONFIG.FEE); });
}

/* ---------- Uploads (receipt and valid ID) ---------- */
const zoneOf = (key) => document.getElementById(UPLOADS[key].zone);

function buildUploads() {
  for (const key of UPLOAD_KEYS) {
    const input = document.getElementById(UPLOADS[key].input);
    const zone = zoneOf(key);
    input.addEventListener("change", () => setUpload(key, input.files && input.files[0]));
    ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, () => zone.classList.remove("is-over")));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) setUpload(key, f);
    });
  }
}

function setUpload(key, file) {
  const cfg = UPLOADS[key];
  const thumb = document.getElementById(cfg.thumb);
  if (thumb.src.startsWith("blob:")) URL.revokeObjectURL(thumb.src);
  uploads[key] = null;
  document.getElementById(cfg.file).hidden = true;
  zoneOf(key).querySelector(".drop__idle").hidden = false;
  if (!file) return;
  const problem = fileProblem(file);
  if (problem) { setError(key, problem); return; }
  clearError(key);
  uploads[key] = file;
  thumb.src = URL.createObjectURL(file);
  document.getElementById(cfg.name).textContent = file.name;
  document.getElementById(cfg.size).textContent = (file.size / 1024 / 1024).toFixed(2) + " MB · tap to change";
  document.getElementById(cfg.file).hidden = false;
  zoneOf(key).querySelector(".drop__idle").hidden = true;
}

function fileProblem(file) {
  if (!TYPES.includes(file.type)) return "Use a JPG, PNG, or WEBP image.";
  if (file.size > MAX_BYTES) return "The image is larger than 5 MB. Upload the original screenshot from your phone.";
  if (file.size === 0) return "The file is empty. Choose the image again.";
  return "";
}

// Original bytes as base64. No resize, no re-encode: the organizer's checker needs the original file.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/* ---------- Validation ---------- */
function fieldEl(name) {
  if (name === "category") return document.querySelector('input[name="category"]:not(:disabled)') || document.querySelector('input[name="category"]');
  if (name === "shirtSize") return document.querySelector('input[name="shirtSize"]');
  return document.getElementById(name);
}
function setError(name, msg) {
  const err = document.getElementById(name + "-err");
  if (err) err.textContent = msg;
  const el = document.getElementById(name);
  if (el) el.setAttribute("aria-invalid", "true");
  if (UPLOADS[name]) zoneOf(name).classList.add("is-invalid");
}
function clearError(name) {
  const err = document.getElementById(name + "-err");
  if (err) err.textContent = "";
  const el = document.getElementById(name);
  if (el) el.removeAttribute("aria-invalid");
  if (UPLOADS[name]) zoneOf(name).classList.remove("is-invalid");
}

const normPhone = (v) => v.replace(/[\s-]/g, "");

function collect(form) {
  const fd = new FormData(form);
  const v = (k) => String(fd.get(k) || "").trim().replace(/\s+/g, " ");
  return {
    fullName: v("fullName"),
    email: v("email").toLowerCase(),
    phone: normPhone(v("phone")),
    municipality: v("municipality"),
    barangay: v("barangay"),
    category: v("category"),
    partnerName: v("partnerName"),
    clubName: v("clubName"),
    shirtSize: v("shirtSize"),
    paymentRef: v("paymentRef"),
    consent: fd.get("consent") === "on",
  };
}

function validate(p) {
  const errors = {};
  if (p.fullName.length < 3) errors.fullName = "Enter your full name.";
  if (!EMAIL_RE.test(p.email)) errors.email = "Enter a valid email, for example juan@gmail.com.";
  if (!PHONE_RE.test(p.phone)) errors.phone = "Use 09XXXXXXXXX or +639XXXXXXXXX.";
  if (p.partnerName.length < 3) errors.partnerName = "Enter your partner's full name.";
  else if (p.partnerName.toLowerCase() === p.fullName.toLowerCase()) errors.partnerName = "Your partner must be a different person.";
  if (p.clubName.length > CLUB_MAX) errors.clubName = `Use ${CLUB_MAX} characters or fewer.`;
  if (!LGUS.includes(p.municipality)) errors.municipality = "Choose your city or municipality in Davao del Sur.";
  if (p.barangay.length < 2) errors.barangay = "Enter your barangay.";
  if (!CATEGORIES.some((c) => c.key === p.category)) errors.category = "Choose a category.";
  if (!SIZES.some((s) => s[0] === p.shirtSize)) errors.shirtSize = "Choose a shirt size.";
  for (const key of UPLOAD_KEYS) {
    const f = uploads[key];
    if (!f) errors[key] = UPLOADS[key].missing;
    else { const pr = fileProblem(f); if (pr) errors[key] = pr; }
  }
  if (!p.consent) errors.consent = "Check this box to continue.";
  return errors;
}

const ORDER = ["fullName", "email", "phone", "partnerName", "clubName", "municipality", "barangay", "category", "shirtSize", "receipt", "validId", "consent"];

/* ---------- Status UI ---------- */
function showStatus(kind, html) {
  const box = $("#formStatus");
  box.innerHTML = `<div class="notice notice--${kind}">${html}</div>`;
  box.focus({ preventScroll: true });
  box.scrollIntoView({ behavior: document.documentElement.classList.contains("reduced-motion") ? "auto" : "smooth", block: "center" });
}
function setBusy(on) {
  const btn = $("#submitBtn");
  btn.disabled = on || closed;
  btn.classList.toggle("is-busy", on);
  btn.setAttribute("aria-busy", String(on));
  btn.querySelector(".btn__label").textContent = on ? "Submitting…" : "Submit registration";
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function send(form, payload) {
  setBusy(true);
  $("#formStatus").innerHTML = "";
  try {
    const res = await register(payload);
    if (res && res.ok && res.duplicate) {
      showStatus("warn", `<h3>You are already registered</h3><p>This email already has an entry in this category.</p><p>Your reference: <span class="ref">${esc(res.ref)}</span></p>`);
    } else if (res && res.ok) {
      const name = esc(payload.player.fullName.split(" ")[0]);
      showStatus("ok", `<h3>Registration received, ${name}</h3><p>Your reference: <span class="ref">${esc(res.ref)}</span></p><p>Your valid ID was received.</p><p>A confirmation email is on its way to ${esc(payload.player.email)}. The organizers will check your receipt and email you if anything is missing.</p><p>Ask your partner to fill their own form.</p>`);
      form.reset();
      for (const key of UPLOAD_KEYS) setUpload(key, null);
      $("#sizeGuide").hidden = true;
      $("#sizeHl").classList.remove("is-on");
      $("#sizeRead").textContent = "Choose a size to see its measurements.";
      lastPayload = null;
      loadSlots();
    } else if (res && res.error === "CLOSED") {
      applyClosed();
    } else if (res && res.error === "FULL") {
      showStatus("err", `<h3>This category is full</h3><p>The last slot was taken before your entry arrived. Choose another category if one is open.</p>`);
      loadSlots();
    } else {
      const msg = res && res.message ? esc(res.message) : "The server could not save your entry.";
      showStatus("err", `<h3>Registration not saved</h3><p>${msg}</p><button type="button" class="btn btn--maroon btn--small" data-retry>Try again</button>`);
    }
  } catch {
    showStatus("err", `<h3>No connection</h3><p>Your entry was not sent. Check your internet connection, then try again. Your answers are still in the form.</p><button type="button" class="btn btn--maroon btn--small" data-retry>Try again</button>`);
  } finally {
    setBusy(false);
  }
}

export function initForm() {
  const form = $("#regForm");
  buildSizes();
  buildQr();
  buildUploads();
  if (isDemo()) $("#demoNote").hidden = false;
  if (isPastCutoff()) applyClosed();

  // Clear an error as soon as the field changes. Uploads clear their own error on a new file.
  form.addEventListener("input", (e) => { const n = e.target.name; if (n && !UPLOADS[n]) clearError(n); });
  form.addEventListener("change", (e) => { const n = e.target.name; if (n && !UPLOADS[n]) clearError(n); });

  $("#formStatus").addEventListener("click", (e) => {
    if (e.target.closest("[data-retry]") && lastPayload) send(form, lastPayload);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if ($("#submitBtn").disabled) return;
    const p = collect(form);
    ORDER.forEach(clearError);
    const errors = validate(p);
    const keys = ORDER.filter((k) => errors[k]);
    if (keys.length) {
      keys.forEach((k) => setError(k, errors[k]));
      $("#formStatus").innerHTML = "";
      const first = fieldEl(keys[0]);
      if (first) {
        first.focus({ preventScroll: true });
        first.scrollIntoView({ behavior: "auto", block: "center" });
      }
      return;
    }
    const base64 = {};
    for (const key of UPLOAD_KEYS) {
      try { base64[key] = await fileToBase64(uploads[key]); }
      catch { setError(key, "The image could not be read. Choose it again."); fieldEl(key).focus(); return; }
    }
    const { consent, ...player } = p;
    const upload = (key) => ({ fileName: uploads[key].name, mimeType: uploads[key].type, base64: base64[key] });
    lastPayload = {
      player,
      receipt: upload("receipt"),
      validId: upload("validId"),
      consent,
    };
    send(form, lastPayload);
  });
}
