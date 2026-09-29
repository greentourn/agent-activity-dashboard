/*
 * art/base.js — ฐานร่วมของงานภาพพิกเซลทั้งหมดใน PIXEL OFFICE
 *
 * ทำไมต้องมีไฟล์กลาง: ภาพถูกแบ่งเป็นสามโมดูล (ตัวละคร / เฟอร์นิเจอร์ / ไอคอน-เอฟเฟกต์) ที่เขียนแยกกัน
 * ถ้าแต่ละไฟล์นิยามสีเอง ไม้ของโต๊ะกับไม้ของพื้นจะเพี้ยนกันคนละโทนทันที และถ้าแต่ละไฟล์ทำ canvas
 * เองทีละเฟรม เบราว์เซอร์จะมี canvas เป็นหมื่นใบตอนพายุงาน 240 ตัว — จึงรวม "สี + วิธีวาดแผนที่พิกเซล
 * + แผ่นรวมภาพ (atlas)" ไว้ที่นี่ที่เดียว
 *
 * ไม่มี Math.random ในงานภาพเลย: ความหลากหลายทุกอย่างมาจาก hash ของสตริง ⇒ agent ตัวเดิมหน้าตาเดิม
 * ทุกครั้งที่เปิดหน้า (โจทย์ "ตัวละครเดิม")
 */

export const TILE = 16;

/*
 * พาเลตหลัก = Sweetie 16 (ชื่อสีตั้งตามหน้าที่ ไม่ใช่ตามเฉด เพื่อให้อ่านแผนที่พิกเซลแล้วรู้ว่าสีนั้นใช้ทำอะไร)
 * + สีเสริม: โทนผิว · ไม้ · ม่วงของ opus · เงา/ไฮไลต์ที่ Sweetie 16 ไม่มี
 */
export const PALETTE = Object.freeze({
  ink: "#1a1c2c", // เส้นขอบ / เงาเข้มสุด
  plum: "#5d275d",
  red: "#b13e53",
  orange: "#ef7d57",
  yellow: "#ffcd75",
  lime: "#a7f070",
  green: "#38b764",
  teal: "#257179",
  navy: "#29366f",
  blue: "#3b5dc9",
  sky: "#41a6f6",
  cyan: "#73eff7",
  white: "#f4f4f4",
  silver: "#94b0c2",
  slate: "#566c86",
  charcoal: "#333c57",

  // สีเสริม
  skin1: "#f6d2b0",
  skin1s: "#e0a878",
  skin2: "#e0a878",
  skin2s: "#b97a4f",
  skin3: "#b97a4f",
  skin3s: "#8a5434",
  skin4: "#7a4a2e",
  skin4s: "#57321d",
  wood: "#8f563b",
  woodDark: "#6e3f2a",
  woodLight: "#b8784a",
  woodDeep: "#4f2c1e",
  purple: "#7b4fbf",
  lilac: "#b58cf0",
  blush: "#f2a0a0",
  shadow: "rgba(26,28,44,0.35)", // เงาใต้เท้า/ใต้เฟอร์นิเจอร์ (โปร่งแสง — ใช้ผ่าน fillRect เท่านั้น)
});

/** สีเสื้อตามโมเดล [สีหลัก, สีเงา, สีไฮไลต์] — ล้อกับสีโมเดลของหน้า Classic/NEURAL CORE (HA เขียว · SO ฟ้า · OP ม่วง · FA ส้ม) */
export const MODEL_SHIRT = Object.freeze({
  HA: Object.freeze([PALETTE.green, PALETTE.teal, PALETTE.lime]),
  SO: Object.freeze([PALETTE.blue, PALETTE.navy, PALETTE.sky]),
  OP: Object.freeze([PALETTE.purple, PALETTE.plum, PALETTE.lilac]),
  FA: Object.freeze([PALETTE.orange, PALETTE.red, PALETTE.yellow]),
  "": Object.freeze([PALETTE.slate, PALETTE.charcoal, PALETTE.silver]),
});

/* ───────────────────────── hash / PRNG (แทน Math.random ทั้งหมด) ───────────────────────── */

/** FNV-1a 32 บิต — เสถียรข้ามเบราว์เซอร์/เครื่อง */
export function hash32(s) {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — ใช้เมื่อต้องการตัวเลขหลายตัวจาก seed เดียว (เช่น ลายไม้ของพื้นทั้งห้อง) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** เลือกของจาก array ด้วย hash (ไม่สุ่ม) */
export function pickBy(list, seed) {
  return list[(seed >>> 0) % list.length];
}

/* ───────────────────────── canvas ───────────────────────── */

/** canvas ใบใหม่ — ใช้ DOM ถ้ามี (เบราว์เซอร์ปกติ) ไม่งั้น OffscreenCanvas (worker/ทดสอบ) */
export function makeCanvas(w, h) {
  const W = Math.max(1, Math.ceil(w));
  const H = Math.max(1, Math.ceil(h));
  if (typeof document !== "undefined" && document.createElement) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(W, H);
  throw new Error("[pixel/art] ไม่มี canvas ให้ใช้ (ต้องรันในเบราว์เซอร์)");
}

export function ctx2d(canvas) {
  const g = canvas.getContext("2d");
  g.imageSmoothingEnabled = false;
  return g;
}

/**
 * วาด "แผนที่พิกเซล" ลง ctx
 *
 * @param {CanvasRenderingContext2D} g
 * @param {string[]} rows แต่ละสตริง = หนึ่งแถว, หนึ่งตัวอักษร = หนึ่งพิกเซล
 *   ตัวอักษร "." และ " " = โปร่งใส; ตัวอื่นแปลงเป็นสีผ่าน legend
 * @param {Record<string,string|null>} legend ตัวอักษร → สี CSS (null = โปร่งใส — ใช้ "ปิด" บางชั้นได้)
 * @param {number} dx
 * @param {number} dy
 * @param {{flipX?: boolean}} [opts] flipX = สะท้อนซ้าย-ขวา (ทำท่าหันขวาจากท่าหันซ้าย)
 *
 * วาดทีละ "ช่วงสีเดียวกันในแถว" (run) ไม่ใช่ทีละพิกเซล — fillRect น้อยลงราว 3–5 เท่า
 * ตัวอักษรที่ไม่มีใน legend จะถูกข้าม (และเตือนครั้งเดียว) แทนที่จะวาดเป็นสีดำเงียบ ๆ
 */
export function paintMap(g, rows, legend, dx = 0, dy = 0, opts = {}) {
  const flip = !!opts.flipX;
  let width = 0;
  for (const r of rows) width = Math.max(width, r.length);
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === "." || ch === " ") {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = legend[ch];
      if (color === undefined) warnMissing(ch);
      else if (color !== null) {
        g.fillStyle = color;
        const px = flip ? width - end : x;
        g.fillRect(dx + px, dy + y, end - x, 1);
      }
      x = end;
    }
  }
}

const warned = new Set();
function warnMissing(ch) {
  if (warned.has(ch)) return;
  warned.add(ch);
  console.warn(`[pixel/art] ตัวอักษร "${ch}" ไม่มีใน legend — ข้ามพิกเซลนั้น`);
}

/** ขนาดของแผนที่พิกเซล (กว้างสุดของทุกแถว × จำนวนแถว) */
export function mapSize(rows) {
  let w = 0;
  for (const r of rows) w = Math.max(w, r.length);
  return { w, h: rows.length };
}

/** ปรับความสว่างของสี hex (-1..1) — ใช้ทำเงา/ไฮไลต์ขั้นเดียวโดยไม่ต้องเพิ่มสีในพาเลตทุกครั้ง */
export function shade(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount);
    return Math.max(0, Math.min(255, Math.round(v)));
  });
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** ผสมสองสี hex (t = 0 → a, 1 → b) */
export function mix(a, b, t) {
  const pa = /^#?([0-9a-f]{6})$/i.exec(String(a));
  const pb = /^#?([0-9a-f]{6})$/i.exec(String(b));
  if (!pa || !pb) return a;
  const na = parseInt(pa[1], 16);
  const nb = parseInt(pb[1], 16);
  const out = [16, 8, 0].map((sh) => {
    const ca = (na >> sh) & 255;
    const cb = (nb >> sh) & 255;
    return Math.round(ca + (cb - ca) * t);
  });
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/* ───────────────────────── atlas (แผ่นรวมภาพ) ───────────────────────── */

/**
 * แผ่นรวมภาพแบบ "ชั้นวาง" (shelf packing): ภาพเล็ก ๆ หลายร้อยชิ้นอยู่ใน canvas ไม่กี่ใบ
 * ภาพถูก "อบ" ครั้งเดียวตอนขอครั้งแรก (lazy) แล้วคืนตำแหน่งเดิมทุกครั้งหลังจากนั้น
 *
 * คืนค่าเป็น { img, sx, sy, w, h } — ผู้ใช้วาดด้วย drawImage(img, sx, sy, w, h, x, y, w, h)
 * เว้นขอบ 1 px รอบทุกชิ้น กันพิกเซลของชิ้นข้าง ๆ ซึมเข้ามาตอนซูมไม่ลงตัว
 */
export function createAtlas(pageSize = 512) {
  const pages = [];
  const entries = new Map();
  let page = null;
  let cx = 0;
  let cy = 0;
  let shelfH = 0;

  function newPage(minW, minH) {
    const size = Math.max(pageSize, nextPow2(minW + 2), nextPow2(minH + 2));
    const canvas = makeCanvas(size, size);
    page = { canvas, g: ctx2d(canvas), size };
    pages.push(page);
    cx = 0;
    cy = 0;
    shelfH = 0;
  }

  function place(w, h) {
    const W = w + 2;
    const H = h + 2;
    if (!page) newPage(W, H);
    if (cx + W > page.size) {
      cx = 0;
      cy += shelfH;
      shelfH = 0;
    }
    if (cy + H > page.size) newPage(W, H);
    const spot = { page, x: cx + 1, y: cy + 1 };
    cx += W;
    shelfH = Math.max(shelfH, H);
    return spot;
  }

  /**
   * @param {string} key
   * @param {number} w
   * @param {number} h
   * @param {(g: CanvasRenderingContext2D, x: number, y: number) => void} draw วาดชิ้นนี้โดยให้มุมซ้ายบนอยู่ที่ (x, y)
   */
  function get(key, w, h, draw) {
    const hit = entries.get(key);
    if (hit) return hit;
    const spot = place(w, h);
    const g = spot.page.g;
    g.save();
    g.beginPath();
    g.rect(spot.x, spot.y, w, h);
    g.clip(); // กันภาพของชิ้นนี้ล้นไปทับชิ้นข้าง ๆ
    try {
      draw(g, spot.x, spot.y);
    } catch (err) {
      console.error(`[pixel/art] วาด "${key}" ไม่สำเร็จ`, err);
    }
    g.restore();
    const entry = Object.freeze({ img: spot.page.canvas, sx: spot.x, sy: spot.y, w, h });
    entries.set(key, entry);
    return entry;
  }

  function has(key) {
    return entries.has(key);
  }

  function clear() {
    entries.clear();
    pages.length = 0;
    page = null;
    cx = 0;
    cy = 0;
    shelfH = 0;
  }

  return {
    get,
    has,
    clear,
    get pageCount() {
      return pages.length;
    },
    get size() {
      return entries.size;
    },
  };
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * แคชแบบ LRU (ใช้กับ atlas ต่อหน้าตาตัวละคร — พายุงานเปลี่ยนตัวละครทั้งห้องทุกไม่กี่นาที
 * ถ้าไม่มีเพดาน canvas ของคนที่กลับบ้านไปแล้วจะค้างในหน่วยความจำตลอดอายุแท็บ)
 */
export function createLru(limit, onEvict) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v); // ดันไปท้าย = เพิ่งใช้ล่าสุด
      return v;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        const v = map.get(oldest);
        map.delete(oldest);
        if (onEvict) {
          try {
            onEvict(v, oldest);
          } catch {
            /* การคืนหน่วยความจำไม่ควรทำให้การวาดพัง */
          }
        }
      }
    },
    clear() {
      if (onEvict) for (const [k, v] of map) onEvict(v, k);
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
