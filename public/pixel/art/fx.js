/*
 * art/fx.js — ไอคอน 9×9 · ฟองคำพูด 15×15 · เอฟเฟกต์เล็ก ๆ · ตัวอักษรจิ๋ว 3×5 ของ PIXEL OFFICE
 *
 * ทำไมรวมไว้ไฟล์เดียว: ของพวกนี้ "ลอย" อยู่เหนือโลก (ฟองเหนือหัว, ควันที่เทอร์มินัล, ตัวเลขบนสกอร์บอร์ด)
 * ไม่ผูกกับหน้าตาตัวละครหรือห้องใด → ใช้แผ่นรวมภาพ (atlas) ใบเดียวร่วมกันทั้งหน้า
 * ทุกชิ้นถูก "อบ" ครั้งเดียวตอนถูกขอครั้งแรก (lazy) — ไอคอนที่ไม่เคยโผล่ก็ไม่เปลืองพื้นที่ canvas เลย
 *
 * ภาพทั้งหมดเป็น "แผนที่พิกเซล" (หนึ่งตัวอักษร = หนึ่งพิกเซล) เก็บในตารางระดับโมดูลด้านล่าง
 * เพื่อให้ปรับภาพได้ด้วยการแก้ตัวอักษรตรง ๆ ไม่ต้องไล่อ่านโค้ดวาด
 * ไม่มี Math.random: ฟองใบเดิมต้องหน้าตาเดิมทุกเฟรม ไม่งั้นภาพจะดูสั่นเหมือนจอเสีย
 *
 * หลักการสี: ไอคอนต้องอ่านออกบน "พื้นขาว" ของฟอง → ขอบหมึกเข้ม + สีอิ่ม ไม่ใช้ขาวเป็นสีหลัก
 * ส่วนเอฟเฟกต์ลอยบนพื้นไม้/ผนังสีน้ำเงินมืด → ใช้สีสว่างเป็นหลัก ขอบเข้มใช้เท่าที่จำเป็น
 */

import { PALETTE, createAtlas, paintMap, mapSize } from "./base.js";

const P = PALETTE;

export const ICON_SIZE = 9;
export const BUBBLE_SIZE = 15;
/* ตำแหน่งวางไอคอน 9×9 ในฟอง 15×15 — ตายตัวตามสัญญา scene.js วาดไอคอนเองที่จุดนี้ */
const BUBBLE_IX = 3;
const BUBBLE_IY = 3;

/*
 * ตัวอักษร → สี (ใช้ร่วมกันทั้งไอคอนและเอฟเฟกต์)
 * ตั้งให้เดาได้: ตัวเล็ก = สีหลัก, ตัวใหญ่ = เฉดสว่างของสีตระกูลเดียวกัน
 * สีโปร่งแสง (q/Q/z) มีไว้ให้ควัน/ฝุ่นเฟรมท้าย ๆ "จางหาย" แทนการหายวับ — paintMap วาดด้วย fillRect
 * สี rgba จึงผสมกับพื้นหลังได้เองโดยไม่ต้องมีสไปรต์เพิ่ม
 */
const LEGEND = Object.freeze({
  k: P.ink,
  c: P.charcoal,
  l: P.slate,
  s: P.silver,
  w: P.white,
  r: P.red,
  o: P.orange,
  y: P.yellow,
  g: P.green,
  G: P.lime,
  t: P.teal,
  n: P.navy,
  b: P.blue,
  B: P.sky,
  C: P.cyan,
  p: P.purple,
  P: P.lilac,
  m: P.plum,
  d: P.wood,
  D: P.woodDark,
  L: P.woodLight,
  h: P.blush,
  q: "rgba(244,244,244,0.55)", // ขาวจาง — ฝุ่นที่กำลังสลาย
  Q: "rgba(148,176,194,0.5)", // เงินจาง
  z: "rgba(86,108,134,0.45)", // เทาอมฟ้าจาง — ควันปลายทาง
});

/*
 * สีขอบฟองตามโทน (สัญญา: neutral หมึก · good เขียว · bad แดง · warn ส้ม/เหลือง · info ฟ้า)
 * main = ขอบนอก 1 px ของ speech/thought และวงนอกของ alert
 * inner = วงในของ alert (ขอบหนา 2 px) — ใช้เฉดสว่างกว่า ให้กรอบดูเรืองแสงบนผนังมืด
 */
const TONES = Object.freeze({
  neutral: Object.freeze({ main: P.ink, inner: P.charcoal }),
  good: Object.freeze({ main: P.green, inner: P.lime }),
  bad: Object.freeze({ main: P.red, inner: P.orange }),
  warn: Object.freeze({ main: P.orange, inner: P.yellow }),
  info: Object.freeze({ main: P.sky, inner: P.cyan }),
});

const hasOwn = (obj, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);

/* ───────────────────────── แผ่นรวมภาพ + แคช ───────────────────────── */

/*
 * atlas ใบเดียวของทั้งโมดูล (256×256 พอสำหรับทุกชิ้นรวมกัน ≈ 25 ไอคอน + 15 ฟอง + ~30 เฟรมเอฟเฟกต์)
 * สร้างตอนถูกขอครั้งแรกเท่านั้น — import ไฟล์นี้ใน Node (ทดสอบ) จึงไม่ต้องมี canvas
 */
let atlas = null;
function sheet() {
  if (!atlas) atlas = createAtlas(256);
  return atlas;
}

/*
 * ฟอง/เอฟเฟกต์ต้องคืนฟิลด์เพิ่ม (ix/iy, frames) นอกเหนือจาก entry ของ atlas
 * แคช object ที่ห่อแล้วไว้ ⇒ ขอซ้ำได้ object เดิม ไม่สร้างขยะใหม่ทุกเฟรม (เรียกหลายร้อยครั้งต่อวินาทีตอนพายุงาน)
 */
const wrapped = new Map();

function wrapEntry(id, entry, extra) {
  const out = Object.freeze({ img: entry.img, sx: entry.sx, sy: entry.sy, w: entry.w, h: entry.h, ...extra });
  wrapped.set(id, out);
  return out;
}

/*
 * วาดแผนที่ลงช่องของ atlas พร้อมเตือน (ครั้งเดียวต่อชิ้น) ถ้าขนาดแผนที่ไม่ตรงกับที่ประกาศ
 * เหตุผล: คนแก้ภาพด้วยมือมักพิมพ์แถวขาด/เกินหนึ่งตัว — ภาพจะเลื่อนไปหนึ่งพิกเซลแบบเงียบ ๆ
 * atlas ตัดขอบ (clip) ให้อยู่แล้วจึงไม่ล้นทับชิ้นข้าง ๆ แต่ควรรู้ตัวตั้งแต่ตอนแก้
 */
const sizeWarned = new Set();
function paintInto(g, rows, legend, x, y, w, h, id) {
  const size = mapSize(rows);
  if ((size.w !== w || size.h !== h) && !sizeWarned.has(id)) {
    sizeWarned.add(id);
    console.warn(`[pixel/fx] แผนที่ "${id}" ขนาด ${size.w}×${size.h} ไม่ตรงกับที่ประกาศ ${w}×${h}`);
  }
  paintMap(g, rows, legend, x, y);
}

/** ทิ้งภาพที่อบไว้ทั้งหมด — ครั้งถัดไปที่ถูกขอจะอบใหม่จากแผนที่พิกเซล (ใช้ตอนแก้ภาพใน DevTools) */
export function clearFxCache() {
  if (atlas) atlas.clear();
  atlas = null;
  wrapped.clear();
}

/* ───────────────────────── ไอคอน 9×9 ───────────────────────── */

/**
 * @param {string} name ชื่อไอคอน (ดูตาราง ICONS) — ไม่รู้จัก → "question" (บอกตรง ๆ ว่าไม่รู้ ดีกว่าช่องว่าง)
 * @returns {{img: HTMLCanvasElement, sx: number, sy: number, w: 9, h: 9}}
 */
export function icon(name) {
  const key = typeof name === "string" ? name.trim().toLowerCase() : "";
  const k = hasOwn(ICONS, key) ? key : "question";
  const id = `icon:${k}`;
  /* เส้นทางร้อน: scene ขอไอคอนทุกเฟรมทุกฟอง — เช็กแคชก่อน จะได้ไม่สร้างฟังก์ชันวาดทิ้งทุกครั้ง */
  const hit = wrapped.get(id);
  if (hit) return hit;
  const entry = sheet().get(id, ICON_SIZE, ICON_SIZE, (g, x, y) =>
    paintInto(g, ICONS[k], LEGEND, x, y, ICON_SIZE, ICON_SIZE, id),
  );
  wrapped.set(id, entry);
  return entry;
}

/* ───────────────────────── ฟองคำพูด 15×15 ───────────────────────── */

/**
 * @param {"speech"|"thought"|"alert"} kind ไม่รู้จัก → speech
 * @param {"neutral"|"good"|"bad"|"warn"|"info"} tone ไม่รู้จัก → neutral
 * @returns {{img, sx, sy, w: 15, h: 15, ix: 3, iy: 3}} ผู้เรียกวาดไอคอน 9×9 เองที่ (ix, iy)
 *
 * ไม่อบไอคอนลงในฟองเลย: 3 แบบ × 5 โทน × 25 ไอคอน = 375 ชิ้น ในขณะที่แยกกันมีแค่ 15 + 25
 */
export function bubble(kind, tone) {
  const k = hasOwn(BUBBLES, kind) ? kind : "speech";
  const t = hasOwn(TONES, tone) ? tone : "neutral";
  const id = `bubble:${k}:${t}`;
  const hit = wrapped.get(id);
  if (hit) return hit;
  const legend = { w: P.white, o: TONES[t].main, i: TONES[t].inner };
  const entry = sheet().get(id, BUBBLE_SIZE, BUBBLE_SIZE, (g, x, y) =>
    paintInto(g, BUBBLES[k], legend, x, y, BUBBLE_SIZE, BUBBLE_SIZE, id),
  );
  return wrapEntry(id, entry, { ix: BUBBLE_IX, iy: BUBBLE_IY });
}

/* ───────────────────────── เอฟเฟกต์ ───────────────────────── */

/**
 * @param {string} name ชื่อเอฟเฟกต์ (ดูตาราง EFFECTS) — ไม่รู้จัก → poof
 * @param {number} frame เลขเฟรมใด ๆ (วนด้วย modulo — ผู้เรียกส่ง floor(t·fps) มาได้เลยไม่ต้องเช็กขอบ)
 * @returns {{img, sx, sy, w, h, frames}}
 */
export function effect(name, frame = 0) {
  const k = hasOwn(EFFECTS, name) ? name : "poof";
  const def = EFFECTS[k];
  const n = def.frames.length;
  let f = Math.floor(Number(frame));
  if (!Number.isFinite(f)) f = 0;
  f = ((f % n) + n) % n; // เฟรมติดลบ (นาฬิกาถอยหลังชั่วขณะ) ก็ยังได้เฟรมที่ถูกต้อง
  const id = `fx:${k}:${f}`;
  const hit = wrapped.get(id);
  if (hit) return hit;
  const entry = sheet().get(id, def.w, def.h, (g, x, y) => paintInto(g, def.frames[f], LEGEND, x, y, def.w, def.h, id));
  return wrapEntry(id, entry, { frames: n });
}

/* ───────────────────────── ตัวอักษรจิ๋ว 3×5 ───────────────────────── */

/*
 * ใช้บนสกอร์บอร์ดในโลก (ตัวเลขต้องคมเท่าพิกเซลอื่น ๆ ในฉาก — ฟอนต์ระบบจะเบลอเมื่อซูม)
 * "#" = หมึก, "." = ว่าง; ความกว้างของแต่ละตัว = ความยาวแถว (ส่วนใหญ่ 3, วรรคตอนแคบ ๆ 1)
 * ศูนย์เป็นทรงรี เพราะกรอบสี่เหลี่ยมมุมเหลี่ยม 3×5 สงวนไว้เป็น "ตัวที่ไม่รู้จัก" (ตามสัญญา) — ถ้าหน้าตาเหมือนกัน
 * คนอ่านสกอร์จะแยกไม่ออกว่า 0 จริงหรือข้อความเพี้ยน (O กับ 0 ใช้รูปเดียวกันได้ — สกอร์บอร์ดมีแต่ตัวเลข)
 */
const FONT = Object.freeze({
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"],
  N: ["##.", "#.#", "#.#", "#.#", "#.#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "###", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  0: [".#.", "#.#", "#.#", "#.#", ".#."],
  1: [".#.", "##.", ".#.", ".#.", "###"],
  2: ["##.", "..#", ".#.", "#..", "###"],
  3: ["##.", "..#", ".#.", "..#", "##."],
  4: ["#.#", "#.#", "###", "..#", "..#"],
  5: ["###", "#..", "##.", "..#", "##."],
  6: [".##", "#..", "###", "#.#", "###"],
  7: ["###", "..#", "..#", ".#.", ".#."],
  8: ["###", "#.#", "###", "#.#", "###"],
  9: ["###", "#.#", "###", "..#", "##."],
  ".": [".", ".", ".", ".", "#"],
  ":": [".", "#", ".", "#", "."],
  "!": ["#", "#", "#", ".", "#"],
  ",": ["..", "..", "..", ".#", "#."],
  "'": ["#", "#", ".", ".", "."],
  "-": ["...", "...", "###", "...", "..."],
  "+": ["...", ".#.", "###", ".#.", "..."],
  "=": ["...", "###", "...", "###", "..."],
  "_": ["...", "...", "...", "...", "###"],
  "/": ["..#", "..#", ".#.", "#..", "#.."],
  "%": ["#.#", "..#", ".#.", "#..", "#.#"],
  "?": ["##.", "..#", ".#.", "...", ".#."],
  "#": ["#.#", "###", "#.#", "###", "#.#"],
  "×": ["...", "#.#", ".#.", "#.#", "..."],
  "*": ["...", "#.#", ".#.", "#.#", "..."],
  "(": [".#", "#.", "#.", "#.", ".#"],
  ")": ["#.", ".#", ".#", ".#", "#."],
  "<": ["..#", ".#.", "#..", ".#.", "..#"],
  ">": ["#..", ".#.", "..#", ".#.", "#.."],
  " ": ["...", "...", "...", "...", "..."],
});

/* ตัวที่ไม่รู้จัก (ไทย, อีโมจิ ฯลฯ) → กรอบสี่เหลี่ยม: เห็นชัดว่ามี "อะไรบางอย่าง" ที่ฟอนต์นี้วาดไม่ได้ */
const UNKNOWN_GLYPH = Object.freeze(["###", "#.#", "#.#", "#.#", "###"]);
const TINY_SPACING = 1;

/*
 * แปลงแผนที่ของแต่ละตัวเป็นรายการ "ช่วงพิกเซลติดกันในแถว" ครั้งเดียวแล้วเก็บไว้
 * สกอร์บอร์ดถูกวาดใหม่ทุกเฟรมทุกห้อง — fillRect ทีละช่วงเร็วกว่าอ่านสตริงซ้ำทุกเฟรม
 */
const glyphCache = new Map();
function compileGlyph(rows) {
  const runs = [];
  let w = 0;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    w = Math.max(w, row.length);
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === "#") end++;
      runs.push([x, y, end - x]);
      x = end;
    }
  }
  return Object.freeze({ w, runs: Object.freeze(runs) });
}
function glyphFor(ch) {
  let g = glyphCache.get(ch);
  if (g) return g;
  let key = /\s/.test(ch) ? " " : ch;
  if (!hasOwn(FONT, key)) {
    const up = key.toUpperCase();
    if (hasOwn(FONT, up)) key = up;
  }
  g = compileGlyph(hasOwn(FONT, key) ? FONT[key] : UNKNOWN_GLYPH);
  glyphCache.set(ch, g);
  return g;
}

/**
 * วาดข้อความด้วยฟอนต์ 3×5 ลง ctx โดยตรง (fillRect — ไม่ผ่าน atlas เพราะตัวเลขเปลี่ยนทุกวินาที)
 * @param {CanvasRenderingContext2D|null} ctx ส่ง null ได้ = แค่วัดความกว้าง (ใช้จัดกึ่งกลางก่อนวาดจริง)
 * @param {string|number} text ตัวพิมพ์เล็กถูกแปลงเป็นพิมพ์ใหญ่
 * @param {number} x มุมซ้ายบน (world px — ถูกปัดเป็นจำนวนเต็มให้พิกเซลคม)
 * @param {number} y
 * @param {string} [color] ค่าเริ่มต้นสีขาวนวล
 * @returns {number} ความกว้างที่ใช้ไป (px) ไม่รวมช่องไฟหลังตัวสุดท้าย
 */
export function drawTinyText(ctx, text, x, y, color) {
  const s = text == null ? "" : String(text);
  if (!s) return 0;
  const ox = Math.round(Number(x) || 0);
  const oy = Math.round(Number(y) || 0);
  const canDraw = !!ctx && typeof ctx.fillRect === "function";
  if (canDraw) ctx.fillStyle = color || P.white;
  let cx = 0;
  let first = true;
  /* for..of เดินทีละ code point — อีโมจิ (surrogate pair) จึงกลายเป็นกรอบเดียว ไม่ใช่สองกรอบ */
  for (const ch of s) {
    const gl = glyphFor(ch);
    if (!first) cx += TINY_SPACING;
    first = false;
    if (canDraw) {
      const runs = gl.runs;
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        ctx.fillRect(ox + cx + r[0], oy + r[1], r[2], 1);
      }
    }
    cx += gl.w;
  }
  return cx;
}

/* ═══════════════════════════ ตารางแผนที่พิกเซล ═══════════════════════════ */

/*
 * ไอคอน 9×9 — วาดลงบนพื้นขาวของฟอง จึงใช้ขอบหมึก (k) หรือสีอิ่มล้วน ห้ามพึ่งสีขาวเป็นรูปทรง
 * แต่ละตัวสื่อ "สถานี" ในออฟฟิศ (ดูตาราง activityForTool ใน world.js) ให้คนดูจับคู่ได้ทันที
 */
const ICONS = Object.freeze({
  /* Read → ชั้นหนังสือ: หนังสือกางออก ปกฟ้า */
  book: [
    ".........",
    ".kkk.kkk.",
    "kwwwkwwwk",
    "kwllkllwk",
    "kwwwkwwwk",
    "kwllkllwk",
    "kwwwkwwwk",
    "kbbbkbbbk",
    ".kkkkkkk.",
  ],
  /* Grep/Glob → ตู้เอกสาร: แว่นขยาย เลนส์ฟ้ามีประกาย */
  magnifier: [
    "..kkk....",
    ".kBwBk...",
    "kBwBBBk..",
    "kBBBBBk..",
    "kBBBBBk..",
    ".kBBBkk..",
    "..kkk.kk.",
    "......kkk",
    ".......kk",
  ],
  /* Bash/PowerShell → เทอร์มินัล: จอมืดกับพรอมต์ ">_" สีเขียวอ่อน */
  terminal: [
    ".........",
    "kkkkkkkkk",
    "knnnnnnnk",
    "knGnnnnnk",
    "knnGnnnnk",
    "knGnGGGnk",
    "knnnnnnnk",
    "kkkkkkkkk",
    ".........",
  ],
  /* Edit/Write → โต๊ะตัวเอง: ดินสอเฉียง ยางลบชมพู ปลอกเงิน ไส้ดำ */
  pencil: [
    "......kk.",
    ".....khhk",
    "....kshhk",
    "...kyssk.",
    "..kyyok..",
    ".kyyok...",
    "kLLok....",
    "kkLk.....",
    "kkk......",
  ],
  /* WebFetch/WebSearch → ตู้คีออสก์: ลูกโลก ทะเลฟ้า ทวีปเขียว */
  globe: [
    "..kkkkk..",
    ".kgBBBBk.",
    "kgggBBBBk",
    "kBgggBBBk",
    "kBBgBBggk",
    "kBBBBgggk",
    "kBBBBggBk",
    ".kBBBgBk.",
    "..kkkkk..",
  ],
  /* TodoWrite → ไวต์บอร์ด: คลิปบอร์ด รายการที่ติ๊กเขียวแล้ว */
  checklist: [
    "...kkk...",
    "kkkkskkkk",
    "kgwlllwwk",
    "kwwwwwwwk",
    "kgwllllwk",
    "kwwwwwwwk",
    "kgwllwwwk",
    "kwwwwwwwk",
    "kkkkkkkkk",
  ],
  /* Workflow → วางแผนงาน: ผังต้นไม้ หนึ่งแม่สองลูก */
  graph: [
    "...kkk...",
    "...kok...",
    "...kkk...",
    "....k....",
    ".kkkkkkk.",
    ".k.....k.",
    "kkk...kkk",
    "kgk...kbk",
    "kkk...kkk",
  ],
  /* Agent/Task → สั่งงานผู้ช่วย: หัวหุ่นยนต์ ตาฟ้าเรืองในหน้ากากมืด */
  robot: [
    "....r....",
    "....k....",
    ".kkkkkkk.",
    ".ksssssk.",
    "kknCnCnkk",
    "kknCnCnkk",
    ".ksksksk.",
    ".ksssssk.",
    ".kkkkkkk.",
  ],
  /* AskUserQuestion / ไม่รู้จัก: เครื่องหมายคำถามน้ำเงินหนา ๆ */
  question: [
    "..bbbbb..",
    ".bbbbbbb.",
    ".bb...bb.",
    "......bb.",
    "....bbb..",
    "....bb...",
    "....bb...",
    ".........",
    "....bb...",
  ],
  /* รออนุญาต (สงสัยว่ามีพรอมต์ขออนุญาตค้าง): ตกใจแดง ปลายเรียว */
  exclaim: [
    "...rrr...",
    "...rrr...",
    "...rrr...",
    "...rrr...",
    "....r....",
    "....r....",
    ".........",
    "...rrr...",
    "...rrr...",
  ],
  /* mcp__* → ปลั๊กอิน: ปลั๊กไฟสองขา ตัวส้ม สายลงล่าง */
  plug: [
    "..c...c..",
    "..c...c..",
    ".kkkkkkk.",
    ".kyooook.",
    ".koooook.",
    "..koook..",
    "...kkk...",
    "....k....",
    "....k....",
  ],
  /* Skill/ToolSearch/อื่น ๆ → กล่องเครื่องมือ: ประแจปากตาย ร่องเปิดขึ้นขวา */
  wrench: [
    ".....cc..",
    "....cc...",
    "....ccccc",
    "....ccccc",
    "....cccc.",
    "...cc....",
    "..cc.....",
    ".cc......",
    "cc.......",
  ],
  /* Monitor → กล้องวงจรปิด: ดวงตา ม่านตาน้ำเงิน */
  eye: [
    ".........",
    "..kkkkk..",
    ".kwwwwwk.",
    "kwwbbbwwk",
    "kwwbkbwwk",
    "kwwbbbwwk",
    ".kwwwwwk.",
    "..kkkkk..",
    ".........",
  ],
  /* Artifact → เครื่องพิมพ์: กราฟแท่งสามสี */
  chart: [
    "k........",
    "k......oo",
    "k......oo",
    "k...bb.oo",
    "k...bb.oo",
    "k...bb.oo",
    "kgg.bb.oo",
    "kgg.bb.oo",
    "kkkkkkkkk",
  ],
  /* คิดออกแล้ว (หลังเหตุการณ์ thinking): หลอดไฟเหลือง ขั้วเงิน */
  bulb: [
    "..kkkkk..",
    ".kyyyywk.",
    "kyyyyyywk",
    "kyyyyyyyk",
    "koyyyyyyk",
    ".koyyyyk.",
    "..kkkkk..",
    "..kslsk..",
    "...kkk...",
  ],
  /* กำลังคิด/รอ: จุดสามจุด (ไม่ได้อยู่กึ่งกลางเป๊ะ — 3 จุด×2 px + ช่อง 1 px = 8 วางใน 9 ไม่ลงตัว) */
  dots: [
    ".........",
    ".........",
    ".........",
    ".........",
    ".cc.cc.cc",
    ".cc.cc.cc",
    ".........",
    ".........",
    ".........",
  ],
  /* ส่งงานสำเร็จ: เครื่องหมายถูกเขียว หนา 2 px */
  check: [
    ".........",
    "........g",
    ".......gg",
    "g.....gg.",
    "gg...gg..",
    ".gg.gg...",
    "..ggg....",
    "...g.....",
    ".........",
  ],
  /* ล้มเหลว: กากบาทแดง */
  cross: [
    ".........",
    ".rr...rr.",
    ".rrr.rrr.",
    "..rrrrr..",
    "...rrr...",
    "..rrrrr..",
    ".rrr.rrr.",
    ".rr...rr.",
    ".........",
  ],
  /* จดหมาย (prompt ใหม่): ซองขาว ปิดผนึกแดงที่ปลายฝา */
  envelope: [
    ".........",
    "kkkkkkkkk",
    "kkwwwwwkk",
    "kwkwwwkwk",
    "kwwkwkwwk",
    "kwwwrwwwk",
    "kwwwwwwwk",
    "kkkkkkkkk",
    ".........",
  ],
  /* ว่าง → จิบกาแฟ: แก้วแดง ไอร้อนลอย */
  coffee: [
    ".l..l....",
    "..l..l...",
    ".l..l....",
    "kkkkkkk..",
    "kDDDDDkkk",
    "krrrrrk.k",
    "krrrrrkkk",
    "krrrrrk..",
    ".kkkkk...",
  ],
  /* ติดด่าน (blocked): ป้ายสามเหลี่ยมเตือน */
  warning: [
    "....k....",
    "...kyk...",
    "...kyk...",
    "..kykyk..",
    "..kykyk..",
    ".kyykyyk.",
    ".kyyyyyk.",
    "kyyykyyyk",
    "kkkkkkkkk",
  ],
  /* หลับบนโซฟา: Z ใหญ่ล่างซ้าย z เล็กบนขวา */
  zzz: [
    "......bbb",
    ".......b.",
    "......bbb",
    ".........",
    "bbbbb....",
    "...b.....",
    "..b......",
    ".b.......",
    "bbbbb....",
  ],
  /* ชมเชย/ผลงานเด่น: ดาวเหลืองขอบหมึก */
  star: [
    "....k....",
    "...kyk...",
    "kkkyyykkk",
    "kyyyyyyyk",
    ".kyyyyyk.",
    "..kyyyk..",
    ".kyykyyk.",
    ".kyk.kyk.",
    ".kk...kk.",
  ],
  /* ขอบคุณ (ผู้จ้างรับรายงาน): หัวใจแดง ประกายชมพู */
  heart: [
    ".........",
    ".kkk.kkk.",
    "khrrkrrrk",
    "khrrrrrrk",
    "krrrrrrrk",
    ".krrrrrk.",
    "..krrrk..",
    "...krk...",
    "....k....",
  ],
});

/*
 * ฟอง 15×15 — ตัวอักษรในแผนที่: o = ขอบสีตามโทน, i = วงในของ alert (เฉดสว่าง), w = พื้นขาว
 * ไอคอน 9×9 ถูกวางที่ (3,3) → พื้นขาวต้องครอบคลุมแถว/คอลัมน์ 3..11 เสมอ (ตรวจใน selfcheck ด้วย)
 * ส่วนหางของแต่ละแบบจึงต้องอยู่ในแถว 12..14 ที่เหลือ
 */
const BUBBLES = Object.freeze({
  /* พูด: กล่องมุมมน หางรูปตัว V ตรงกลางล่าง ชี้ลงหาหัวคนพูด */
  speech: [
    ".ooooooooooooo.",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    ".oooooowoooooo.",
    ".......o.......",
  ],
  /*
   * คิด: เมฆขอบหยัก (สองโหนกบน หยักข้างละหนึ่ง) + เม็ดกลมเล็กสองเม็ดไล่ลงซ้าย
   * เม็ดอยู่แถวล่างสุดแถวเดียวเพราะแถว 13 ติดขอบเมฆ — ถ้าวางแถว 13 เม็ดจะกลืนเป็นหางของฟองพูด
   */
  thought: [
    "...ooo...ooo...",
    "..owwwo.owwwo..",
    ".owwwwwowwwwwo.",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    ".owwwwwwwwwwwo.",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    "owwwwwwwwwwwwwo",
    ".owwwwwwwwwwwo.",
    "..owwwwwwwwwo..",
    "...ooooooooo...",
    "...............",
    ".o..oo.........",
  ],
  /* เตือน: ป้ายสี่เหลี่ยมขอบหนา 2 px (วงนอกเข้ม วงในสว่าง) ไม่มีหาง — กะพริบได้โดยไม่ดูเป็นคำพูด */
  alert: [
    ".ooooooooooooo.",
    "oiiiiiiiiiiiiio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiwwwwwwwwwwwio",
    "oiiiiiiiiiiiiio",
    ".ooooooooooooo.",
  ],
});

/*
 * เอฟเฟกต์ — { w, h, frames: [แผนที่ต่อเฟรม] } ใช้ LEGEND ชุดเดียวกับไอคอน
 * ขนาด/จำนวนเฟรมตายตัวตามสัญญา (world.js กำหนดอายุ ttl ของแต่ละชนิด ส่วน scene เลือกเฟรมจากเวลา)
 * เฟรมสุดท้ายของฝุ่น/ควันใช้สีโปร่งแสง (q/Q/z) ให้ "จางหาย" ไม่ใช่ "หายวับ"
 */
const EFFECTS = Object.freeze({
  /* ฝุ่นฟุ้ง (ผู้ช่วยโผล่ที่ประตู): ก้อนเล็ก → ก้อนใหญ่ → แตกเป็นก้อนย่อยกระจายออก → จางหาย */
  poof: {
    w: 16,
    h: 16,
    frames: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        ".......ww.......",
        "......wwww......",
        "....wwwwwwww....",
        "....wwwwwwwww...",
        "...wwwwwwwwss...",
        "....wwwwwwss....",
        ".....wwwwss.....",
        "......wsss......",
        "................",
        "................",
        "................",
      ],
      [
        "................",
        "................",
        "......wwww......",
        ".....wwwwww.....",
        "....wwwwwwww....",
        "...wwwwwwwwww...",
        "...wwwwwwwwws...",
        "...wwwwwwwwws...",
        "..wwwwwwwwwwww..",
        ".wwwwwwwwwwwwww.",
        ".wwwwwwwwwwwwws.",
        ".wwwsswwwsswwss.",
        "..wss.wsss.wss..",
        "................",
        "................",
        "................",
      ],
      [
        "................",
        "......wwww......",
        "......wssl......",
        "......wssl......",
        "......wsll......",
        ".wwww..wl..wwww.",
        ".wssl......wssl.",
        ".wssl......wssl.",
        ".wsll..ww..wsll.",
        "..wl...wl...wl..",
        "...ww..wl..wl...",
        "..wssw....wssw..",
        "..wssl....wssl..",
        "..wssl....wssl..",
        "..wlll....wlll..",
        "................",
      ],
      [
        ".......qq.......",
        ".......qQ.......",
        ".......qQ.......",
        "................",
        ".qq..........qq.",
        "qqQ..........qQq",
        ".qQ..........qQ.",
        "................",
        "................",
        "................",
        "................",
        ".qq..........qq.",
        "qqqq........qqqq",
        "qqQQ........qqQQ",
        ".qQ....qq....qQ.",
        ".......qQ.......",
      ],
    ],
  },
  /* ประกายไฟ (tool พังที่โต๊ะ/สถานี): วาบเล็ก → แตกรัศมี 8 ทิศ → เหลือแต่ปลายที่เย็นลงเป็นส้ม-แดง */
  spark: {
    w: 12,
    h: 12,
    frames: [
      [
        "............",
        "............",
        "............",
        "...o....o...",
        ".....yy.....",
        "....ywwy....",
        "....ywwy....",
        ".....yy.....",
        "...o....o...",
        "............",
        "............",
        "............",
      ],
      [
        "............",
        ".....oo.....",
        ".....yy.....",
        "..o..yy..o..",
        "...y.ww.y...",
        ".oyywwwwyyo.",
        ".oyywwwwyyo.",
        "...y.ww.y...",
        "..o..yy..o..",
        ".....yy.....",
        ".....oo.....",
        "............",
      ],
      [
        ".....oo.....",
        "............",
        ".r........r.",
        "............",
        "............",
        "o..........o",
        "o..........o",
        "............",
        "............",
        ".r........r.",
        "............",
        ".....oo.....",
      ],
    ],
  },
  /* ควัน (เทอร์มินัลพัง): ก้อนเทาเข้มลอยขึ้น เอียงขวานิด ๆ แล้วจางเป็นสีโปร่ง */
  smoke: {
    w: 12,
    h: 12,
    frames: [
      [
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        ".....ss.....",
        "....slls....",
        "....sllls...",
        "....slllc...",
        ".....sccc...",
      ],
      [
        "............",
        "............",
        "............",
        "............",
        "....ssss....",
        "...slllls...",
        "...sllllc...",
        "...sllllls..",
        "....slllcc..",
        "....scccc...",
        "....sc......",
        "....sc......",
      ],
      [
        "............",
        ".....sss....",
        "....sssss...",
        "...sssssss..",
        "...ssssssl..",
        "...sssssll..",
        "..sssssll...",
        "...sssll....",
        "....ssl.....",
        "....sll.....",
        "....sl......",
        "............",
      ],
      [
        ".....QQQQ...",
        "....QQQQQQ..",
        "....QQQQQz..",
        "...QQQQQzz..",
        "...QQQzzz...",
        "....Qzz.....",
        "............",
        ".....QQ.....",
        ".....Qz.....",
        "............",
        "............",
        "............",
      ],
    ],
  },
  /* ฝนตก (ติดด่าน/ส่งงานพลาด): เมฆเทาอมฟ้า + หยดฝนสองชุดสลับกันตก */
  rain: {
    w: 16,
    h: 14,
    frames: [
      [
        "......ssss......",
        ".....sllllssss..",
        "..sssllllllllls.",
        ".sllllllllllllc.",
        "sllllllllllllllc",
        "sllllllllllllllc",
        ".clllllllllllcc.",
        "..cccc.cccccc...",
        "...B....B...B...",
        "...C....C...C...",
        "................",
        ".....B....B.....",
        ".....C....C.....",
        "................",
      ],
      [
        "......ssss......",
        ".....sllllssss..",
        "..sssllllllllls.",
        ".sllllllllllllc.",
        "sllllllllllllllc",
        "sllllllllllllllc",
        ".clllllllllllcc.",
        "..cccc.cccccc...",
        ".....B....B.....",
        ".....C....C.....",
        "...B....B...B...",
        "...C....C...C...",
        "................",
        "................",
      ],
    ],
  },
  /* พายุ: เมฆทรงเดียวกับฝนแต่มืดกว่า + สายฟ้าเหลืองแกนขาว สลับฝั่ง; เฟรมสองท้องเมฆสว่างวาบ */
  storm: {
    w: 16,
    h: 14,
    frames: [
      [
        "......llll......",
        ".....lccccllll..",
        "..lllcccccccccl.",
        ".lcccccccccccck.",
        "lcccccccccccccck",
        "lcccccccccccccck",
        ".kccccccccccckk.",
        "..kkkk.kyykkk...",
        ".......yy.......",
        "......ywwwy.....",
        "........yy......",
        ".......yy.......",
        "......yy........",
        "......y.........",
      ],
      [
        "......llll......",
        ".....lccccllll..",
        "..lllcccccccccl.",
        ".lcccccccccccck.",
        "lcccccccccccccck",
        "lcccccccccccccck",
        ".lccccccccccccl.",
        "..lllyyllllll...",
        "....yy..........",
        "...ywwwy........",
        ".....yy.........",
        "....yy..........",
        "...yy...........",
        "...y............",
      ],
    ],
  },
  /*
   * หลับ: z เล็กโผล่ข้างหัว → โตเป็น Z ลอยขึ้นขวา → Z ใหญ่ (วนแล้ว z ตัวใหม่ต่อคิวพอดี)
   * 16×16 ตัวอักษรขาวล้วนขอบหมึก 1 px — รุ่นแรก 10×10 สีเทาจางกลืนกับโซฟาเขียวหัวเป็ดจนมองไม่ออกแม้ซูม ×4
   * (ขอบหมึกทำให้อ่านออกทั้งบนโซฟา พื้นไม้ และผนังมืด)
   */
  zzz: {
    w: 16,
    h: 16,
    frames: [
      [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        "..kkkkkk........",
        "..kwwwwk........",
        "..kkkwkk........",
        "..kkwkkk........",
        "..kwwwwk........",
        "..kkkkkk........",
        "................",
        "................",
      ],
      [
        "................",
        "................",
        "................",
        "................",
        "......kkkkkkk...",
        "......kwwwwwk...",
        "......kkkkwkk...",
        ".......kkwkk....",
        "......kkwkkkk...",
        "......kwwwwwk...",
        "kkkkkkkkkkkkk...",
        "kwwwwk..........",
        "kkkwkk..........",
        "kkwkkk..........",
        "kwwwwk..........",
        "kkkkkk..........",
      ],
      [
        ".......kkkkkkkkk",
        ".......kwwwwwwwk",
        ".......kkkkkkwwk",
        "..........kkwwkk",
        ".........kkwwkk.",
        "........kkwwkk..",
        ".......kkwwkkkkk",
        ".......kwwwwwwwk",
        "..kkkkkkkkkkkkkk",
        "..kwwwwwk.......",
        "..kkkkwkk.......",
        "...kkwkk........",
        "..kkwkkkk.......",
        "..kwwwwwk.......",
        "..kkkkkkk.......",
        "................",
      ],
    ],
  },
  /* จดหมายที่บินจากประตูไปตู้รับจดหมาย (prompt ใหม่): ซองขาว ครั่งแดงปิดผนึก */
  letter: {
    w: 8,
    h: 6,
    frames: [["kkkkkkkk", "kkwwwwkk", "kwkwwkwk", "kwwrrwwk", "kwwwwwwk", "kkkkkkkk"]],
  },
  /* รายงานที่ผู้ช่วยยื่นให้ผู้จ้าง: กระดาษพับมุม มีบรรทัดตัวหนังสือ */
  paper: {
    w: 6,
    h: 8,
    frames: [["lllll.", "lwwwsl", "lwccwl", "lwwwwl", "lwccwl", "lwwwwl", "lwcwwl", "llllll"]],
  },
  /*
   * ตราประทับ "ไม่อนุมัติ" (ถูกปฏิเสธสิทธิ์): วงแหวนแดง + กากบาท เว้นรอยหมึกขาดสามจุดให้ดูเป็นตรายาง
   * ในวงรองพื้นขาวโปร่ง (q) — แดงล้วนจมหายไปกับพื้นไม้สีน้ำตาล (ความสว่างใกล้กันมาก) ตราต้องอ่านออกทุกพื้น
   */
  stamp: {
    w: 14,
    h: 14,
    frames: [
      [
        "....rrrrrr....",
        "...rrrrr.rr...",
        "..rrrqqqqrrr..",
        ".rrqqqqqqqqrr.",
        "rrrqrrqqrrqrrr",
        "rrqqqrrrrqqqrr",
        ".rqqqqrrqqqqrr",
        "rrqqqqrrqqqqrr",
        "rrqqqrrrrqqqrr",
        "rrrqrrqqrrqrrr",
        ".rrqqqqqqqqrr.",
        "..rrrqqqqrrr..",
        "...rr.rrrrr...",
        "....rrrrrr....",
      ],
    ],
  },
  /* หัวใจลอย (ผู้จ้างดีใจที่ได้รายงาน): ขอบหมึกกันแดงกลืนกับพื้นไม้ + ประกายชมพูมุมซ้ายบน */
  heart: {
    w: 7,
    h: 6,
    frames: [[".kk.kk.", "khrkrrk", "krrrrrk", ".krrrk.", "..krk..", "...k..."]],
  },
  /* ประกายวิบวับ (ส่งงานสำเร็จ): จุดเล็ก → ดาวสี่แฉก → กากบาทเฉียงจาง ๆ */
  sparkle: {
    w: 7,
    h: 7,
    frames: [
      [".......", ".......", "...y...", "..ywy..", "...y...", ".......", "......."],
      ["...y...", "...y...", "..ywy..", "yywwwyy", "..ywy..", "...y...", "...y..."],
      [".......", ".y...y.", "..y.y..", "...w...", "..y.y..", ".y...y.", "......."],
    ],
  },
});

/*
 * เปิดตารางภาพให้เครื่องมือ/ทดสอบอ่านได้ (ตรวจขนาดแผนที่ใน Node โดยไม่ต้องมี canvas)
 * ห้ามแก้ค่าผ่านตัวนี้ — ภาพที่อบแล้วจะไม่อัปเดตจนกว่าจะ clearFxCache()
 */
export const FX_ART = Object.freeze({ icons: ICONS, bubbles: BUBBLES, effects: EFFECTS, font: FONT, legend: LEGEND });
