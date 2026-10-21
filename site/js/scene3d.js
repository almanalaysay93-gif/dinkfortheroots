// Floating paddles and balls. Procedural geometry and canvas textures only: no logos, no text.
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const FOV = 32;
const CAM_Z = 8;

/* ---------- Canvas textures ---------- */
function canvasTex(w, h, paint, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  paint(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Paddle face: sky blue, lime speed streaks, thin white angular strokes. No text or marks.
function faceTexture(seed) {
  return canvasTex(512, 640, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w * 0.6, h);
    grd.addColorStop(0, "#7cc8f4");
    grd.addColorStop(0.6, "#4ba8ea");
    grd.addColorStop(1, "#3a8fdc");
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    let s = seed;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const dx = 1, dy = -0.42; // one shared angle so the strokes read as speed lines
    const streak = (cx, cy, len, width, color) => {
      g.strokeStyle = color; g.lineWidth = width; g.lineCap = "round";
      g.beginPath(); g.moveTo(cx - dx * len / 2, cy - dy * len / 2); g.lineTo(cx + dx * len / 2, cy + dy * len / 2); g.stroke();
    };
    // Lime band across the top right.
    for (let i = 0; i < 26; i++) {
      const t = rnd();
      streak(w * (0.55 + rnd() * 0.5), h * (0.02 + t * 0.2) + rnd() * 20, 120 + rnd() * 220, 2 + rnd() * 4, `rgba(222, 240, 70, ${0.55 + rnd() * 0.45})`);
    }
    // Deep blue band across the bottom.
    for (let i = 0; i < 30; i++) {
      streak(w * (rnd() * 1.0), h * (0.72 + rnd() * 0.26), 160 + rnd() * 260, 2 + rnd() * 5, `rgba(24, 82, 176, ${0.3 + rnd() * 0.45})`);
    }
    // Three bold lime bars, lower right.
    for (let i = 0; i < 3; i++) streak(w * 0.78, h * (0.66 + i * 0.045), 170 - i * 30, 9 - i * 2, "rgba(214, 236, 58, 0.95)");
    // Thin white angular strokes.
    g.strokeStyle = "rgba(255, 255, 255, 0.9)";
    g.lineJoin = "miter";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(w * 0.1, h * 0.24); g.lineTo(w * 0.7, h * 0.1); g.lineTo(w * 0.22, h * 0.52); g.lineTo(w * 0.9, h * 0.36); g.lineTo(w * 0.42, h * 0.86);
    g.stroke();
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(w * 0.16, h * 0.3); g.lineTo(w * 0.6, h * 0.19); g.lineTo(w * 0.3, h * 0.48);
    g.stroke();
  });
}

// Black wrapped grip: spiral bands.
function gripTexture() {
  const t = canvasTex(128, 256, (g, w, h) => {
    g.fillStyle = "#121212";
    g.fillRect(0, 0, w, h);
    for (let y = -w; y < h + w; y += 22) {
      g.strokeStyle = "#2a2a2a"; g.lineWidth = 5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(w, y + w * 0.45); g.stroke();
      g.strokeStyle = "#050505"; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, y + 6); g.lineTo(w, y + 6 + w * 0.45); g.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 2);
  return t;
}

// Ball hole mask (equirectangular): white = shell, black = hole.
function holeMask() {
  return canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#000";
    const n = 30, ang = 0.17;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const lat = Math.asin(y);
      const lon = (i * Math.PI * (3 - Math.sqrt(5))) % (Math.PI * 2);
      const u = (lon / (Math.PI * 2)) * w;
      const v = (0.5 - lat / Math.PI) * h;
      const ry = (ang / Math.PI) * h;
      const rx = Math.min(w / 2, ((ang / (Math.PI * 2)) * w) / Math.max(0.12, Math.cos(lat)));
      for (const off of [-w, 0, w]) {
        g.beginPath(); g.ellipse(u + off, v, rx, ry, 0, 0, Math.PI * 2); g.fill();
      }
    }
  }, false);
}

/* ---------- Models ---------- */
function paddleShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.1, 0);
  s.lineTo(0.1, 0);
  s.bezierCurveTo(0.12, 0.08, 0.39, 0.1, 0.39, 0.26);
  s.lineTo(0.39, 0.84);
  s.quadraticCurveTo(0.39, 1.02, 0.21, 1.02);
  s.lineTo(-0.21, 1.02);
  s.quadraticCurveTo(-0.39, 1.02, -0.39, 0.84);
  s.lineTo(-0.39, 0.26);
  s.bezierCurveTo(-0.39, 0.1, -0.12, 0.08, -0.1, 0);
  return s;
}

function makePaddle(faceMap, gripMap) {
  const group = new THREE.Group();
  const geo = new THREE.ExtrudeGeometry(paddleShape(), {
    depth: 0.03, bevelEnabled: true, bevelThickness: 0.014, bevelSize: 0.014, bevelSegments: 3, curveSegments: 28,
  });
  geo.translate(0, 0, -0.015);
  // Planar UVs over the face so the art spans the whole paddle.
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + 0.4) / 0.8, (pos.getY(i) - 0.0) / 1.03);
  uv.needsUpdate = true;
  const face = new THREE.MeshStandardMaterial({ map: faceMap, emissiveMap: faceMap, emissive: 0xffffff, emissiveIntensity: 0.32, roughness: 0.4, metalness: 0.0 });
  const guard = new THREE.MeshStandardMaterial({ color: 0x0c0f12, roughness: 0.5, metalness: 0.1 });
  group.add(new THREE.Mesh(geo, [face, guard]));

  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.058, 0.052, 0.5, 24, 1),
    new THREE.MeshStandardMaterial({ map: gripMap, roughness: 0.85 }),
  );
  handle.position.y = -0.23;
  group.add(handle);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.064, 0.064, 0.05, 24), guard);
  collar.position.y = 0.015;
  group.add(collar);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.06, 0.035, 24), guard);
  cap.position.y = -0.49;
  group.add(cap);

  // Pivot near the center of mass.
  group.children.forEach((c) => { c.position.y -= 0.3; });
  return group;
}

function makeBall(mask) {
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0xd4e83a, emissive: 0xb8cc20, emissiveIntensity: 0.28, roughness: 0.55, alphaMap: mask, alphaTest: 0.5, side: THREE.DoubleSide }),
  );
  const inner = new THREE.Mesh(
    new THREE.SphereGeometry(0.47, 32, 24),
    new THREE.MeshStandardMaterial({ color: 0x6f7d12, roughness: 0.9 }),
  );
  group.add(shell, inner);
  return group;
}

/* ---------- Layouts in viewport fractions (x from left, y from top) ---------- */
const LAYOUTS = {
  wide: {
    paddles: [
      { x: 0.53, y: 0.24, z: -1.2, s: 1.15, rx: 0.3, ry: -0.6, rz: -0.5 },
      { x: 0.06, y: 0.9, z: 0.6, s: 0.95, rx: -0.2, ry: 0.7, rz: 0.9 },
      { x: 1.0, y: 0.24, z: -2.6, s: 1.0, rx: 0.4, ry: 2.4, rz: 0.4 },
    ],
    balls: [
      { x: 0.6, y: 0.66, z: 0.4, s: 0.3 },
      { x: 0.34, y: 0.86, z: -0.6, s: 0.24 },
      { x: 0.66, y: 0.1, z: -1.8, s: 0.22 },
      { x: 0.04, y: 0.3, z: -1.0, s: 0.2 },
      { x: 0.57, y: 0.44, z: -2.4, s: 0.18 },
    ],
  },
  tall: {
    paddles: [
      { x: 0.93, y: 0.47, z: -1.0, s: 0.72, rx: 0.2, ry: -0.7, rz: -0.4 },
      { x: 0.04, y: 0.64, z: -0.4, s: 0.7, rx: -0.2, ry: 0.6, rz: 0.6 },
    ],
    balls: [
      { x: 0.5, y: 0.43, z: 0.2, s: 0.22 },
      { x: 0.86, y: 0.16, z: -1.2, s: 0.18 },
      { x: 0.24, y: 0.5, z: -1.6, s: 0.16 },
      { x: 0.9, y: 0.94, z: -0.2, s: 0.2 },
    ],
  },
};

function toWorld(camera, x, y, z) {
  const dist = CAM_Z - z;
  const halfH = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * dist;
  const halfW = halfH * camera.aspect;
  return new THREE.Vector3((x * 2 - 1) * halfW, (1 - y * 2) * halfH, z);
}

export function initScene(host, { animate }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    host.closest(".hero").classList.add("no-webgl");
    return;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
  camera.position.set(0, 0, CAM_Z);

  // Dusk studio light: warm key from upper left, rose sky fill, cool court-blue rim.
  scene.add(new THREE.HemisphereLight(0xf6c6b8, 0x1e3b2a, 1.1));
  const key = new THREE.DirectionalLight(0xffe0bd, 2.2);
  key.position.set(-4, 5, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7aa2ff, 1.4);
  rim.position.set(5, -2, -4);
  scene.add(rim);

  const grip = gripTexture();
  const mask = holeMask();
  const faces = [faceTexture(11), faceTexture(29), faceTexture(47)];
  const items = [];

  let layoutName = "";
  function build() {
    const name = host.clientWidth / Math.max(1, host.clientHeight) > 0.9 ? "wide" : "tall";
    if (name === layoutName) { place(); return; }
    layoutName = name;
    items.forEach((it) => scene.remove(it.obj));
    items.length = 0;
    const L = LAYOUTS[name];
    L.paddles.forEach((p, i) => {
      const obj = makePaddle(faces[i % faces.length], grip);
      obj.scale.setScalar(p.s);
      obj.rotation.set(p.rx, p.ry, p.rz);
      scene.add(obj);
      items.push({ obj, cfg: p, kind: "paddle", phase: i * 1.7, base: obj.rotation.clone() });
    });
    L.balls.forEach((b, i) => {
      const obj = makeBall(mask);
      obj.scale.setScalar(b.s);
      obj.rotation.set(i, i * 0.7, 0);
      scene.add(obj);
      items.push({ obj, cfg: b, kind: "ball", phase: i * 1.3 + 0.5, base: obj.rotation.clone() });
    });
    place();
  }
  function place() {
    items.forEach((it) => { it.home = toWorld(camera, it.cfg.x, it.cfg.y, it.cfg.z); it.obj.position.copy(it.home); });
  }

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    build();
    if (!animate) renderer.render(scene, camera);
  }
  resize();
  addEventListener("resize", resize, { passive: true });

  if (!animate) { renderer.render(scene, camera); return; }

  // Pointer tilt and scroll depth.
  let tx = 0, ty = 0, px = 0, py = 0;
  if (window.matchMedia("(pointer: fine)").matches) {
    addEventListener("pointermove", (e) => { tx = (e.clientX / innerWidth) * 2 - 1; ty = (e.clientY / innerHeight) * 2 - 1; }, { passive: true });
  }
  let raf = 0, visible = true, t = 0, last = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    t += Math.min(0.05, (now - (last || now)) / 1000);
    last = now;
    px += (tx - px) * 0.05;
    py += (ty - py) * 0.05;
    const h = host.clientHeight || 1;
    const s = Math.min(1.2, scrollY / h);
    for (const it of items) {
      const depth = 1 + (it.cfg.z + 3) * 0.35; // nearer objects move more
      const bob = Math.sin(t * 0.9 + it.phase) * 0.08;
      it.obj.position.set(
        it.home.x + px * 0.18 * depth,
        it.home.y + bob - py * 0.12 * depth + s * 1.6 * depth,
        it.home.z + s * 1.2 * depth,
      );
      if (it.kind === "ball") {
        it.obj.rotation.x = it.base.x + t * 0.5;
        it.obj.rotation.y = it.base.y + t * 0.35;
      } else {
        it.obj.rotation.x = it.base.x + Math.sin(t * 0.6 + it.phase) * 0.12 + py * 0.25;
        it.obj.rotation.y = it.base.y + Math.sin(t * 0.45 + it.phase) * 0.25 + px * 0.4;
        it.obj.rotation.z = it.base.z + Math.sin(t * 0.5 + it.phase) * 0.06;
      }
    }
    renderer.render(scene, camera);
  }
  const start = () => { if (!raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); }).observe(host);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  start();
}
