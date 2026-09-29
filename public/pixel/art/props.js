/*
 * art/props.js — เฟอร์นิเจอร์ · ของแต่งผนัง · เปลือกห้อง (พื้น/ผนัง) ของ PIXEL OFFICE
 *
 * ทุกชิ้นวาดด้วยโค้ด (fillRect + แผนที่พิกเซลเล็ก ๆ) ไม่มีไฟล์ภาพ — repo ห้ามมีไฟล์ภาพ/ขั้นตอน build
 * มุมมอง: มองจากบนเฉียงลงมา (3/4) ⇒ เห็นหน้าด้านหน้าของของทุกชิ้น และ "ด้านบน" สว่างกว่าหน้าเสมอ
 * (แสงมาจากเพดานด้านบน) · เส้นขอบหมึก 1 px เฉพาะที่ช่วยให้ของแยกจากพื้นไม้ได้ชัด
 *
 * ขนาดของทุกชิ้นต้องตรงกับ PROP_SIZES ใน world.js เป๊ะ เพราะ world วางของโดยให้ "มุมซ้ายล่างของ sprite
 * = มุมซ้ายล่างของ footprint" แล้วคำนวณว่าใครยืนบังอะไรจากความสูงนั้น — ถ้าภาพสูงกว่าที่ world คิด
 * ของบนผนังจะโดนตู้บัง/หัวคนนั่งจะโดนจอบัง (หน้าพรีวิวตรวจความตรงนี้ทุกครั้ง)
 *
 * ภาพทุกชิ้นถูก "อบ" ลง atlas กลางใบเดียวแบบขี้เกียจ (ขอครั้งแรกค่อยวาด) แล้วใช้ซ้ำตลอดอายุแท็บ —
 * ชั้น sorted ของ scene ขอ prop() ทุกเฟรม จึงต้องเป็นแค่การค้น Map ไม่ใช่การวาดใหม่
 * ไม่มี Math.random: ลายไม้/สีสันหนังสือมาจาก hash ⇒ ห้องเดิมหน้าตาเดิมทุกครั้งที่เปิดหน้า
 */

import { TILE, PALETTE as C, hash32, mulberry32, paintMap, shade, mix, createAtlas } from "./base.js";

/* ───────────────────────── ชุดเครื่องมือวาด (พิกัดท้องถิ่นของชิ้น) ───────────────────────── */

function fill(g, x, y, w, h, c) {
  if (w <= 0 || h <= 0) return;
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}
function dot(g, x, y, c) {
  g.fillStyle = c;
  g.fillRect(x, y, 1, 1);
}
/** กรอบ 1 px (ไม่เติมข้างใน) */
function frame(g, x, y, w, h, c) {
  fill(g, x, y, w, 1, c);
  fill(g, x, y + h - 1, w, 1, c);
  fill(g, x, y + 1, 1, h - 2, c);
  fill(g, x + w - 1, y + 1, 1, h - 2, c);
}
/**
 * กล่องเติมสี + ขอบหมึก + ขอบบน/ซ้ายสว่าง ขอบล่าง/ขวาเข้ม — ใช้แทบทุกชิ้น
 * เพราะไฮไลต์/เงาขั้นเดียวแบบนี้คือสิ่งที่ทำให้ "กล่องสี่เหลี่ยม" อ่านออกว่าเป็นของมีปริมาตร
 */
function box(g, x, y, w, h, body, hi, lo, line = C.ink) {
  fill(g, x, y, w, h, line === null ? body : line);
  const ix = line === null ? 0 : 1;
  fill(g, x + ix, y + ix, w - ix * 2, h - ix * 2, body);
  if (hi) {
    fill(g, x + ix, y + ix, w - ix * 2, 1, hi);
    fill(g, x + ix, y + ix, 1, h - ix * 2, hi);
  }
  if (lo) {
    fill(g, x + ix, y + h - ix - 1, w - ix * 2, 1, lo);
    fill(g, x + w - ix - 1, y + ix + 1, 1, h - ix * 2 - 1, lo);
  }
}
/** กรอบหมึกมุมมน 1 px (ตัดพิกเซลมุมทิ้ง) — ของที่ไม่ใช่ตู้เหลี่ยม เช่น เบาะ พนักพิง จอ */
function rbox(g, x, y, w, h, body, line = C.ink) {
  fill(g, x + 1, y, w - 2, h, line);
  fill(g, x, y + 1, w, h - 2, line);
  fill(g, x + 1, y + 1, w - 2, h - 2, body);
}
/** เงาโปร่งบนพื้นใต้ของ (ช่วยให้เฟอร์นิเจอร์ "วางอยู่บนพื้น" ไม่ลอย) */
function floorShadow(g, x, y, w, h = 1) {
  fill(g, x, y, w, h, C.shadow);
}
function hexOk(v) {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
}

/* ───────────────────────── แคตตาล็อก ───────────────────────── */

/*
 * ชื่อ variant ตัวแรกของแต่ละชิ้น = หน้าตาปกติ (ใช้เมื่อได้ "default" หรือชื่อที่ไม่รู้จัก)
 * frames = จำนวนเฟรมของ variant ที่ขยับได้ (world เดินเฟรม 0/1 ให้เอง) — variant อื่นมีเฟรมเดียว
 * เฟรมที่เกินถูกวนกลับ (mod) แทนที่จะอบภาพใหม่ไม่รู้จบ
 */
const CATALOG = {
  door: { w: 32, h: 44, variants: ["closed", "open"], paint: paintDoor },
  window: { w: 32, h: 24, variants: ["default", "dark"], paint: paintWindow },
  whiteboard: { w: 48, h: 26, variants: ["clean", "scribble"], paint: paintWhiteboard },
  cctv: { w: 16, h: 14, variants: ["default", "on"], paint: paintCctv },
  clock: { w: 12, h: 12, variants: ["default"], paint: paintClock },
  scoreboard: { w: 32, h: 14, variants: ["default"], paint: paintScoreboard },
  poster: { w: 16, h: 20, variants: ["0", "1", "2"], paint: paintPoster },
  mailbox: { w: 16, h: 24, variants: ["empty", "full"], paint: paintMailbox },
  bookshelf: { w: 32, h: 40, variants: ["default"], paint: paintBookshelf },
  cabinet: { w: 32, h: 28, variants: ["closed", "open"], paint: paintCabinet },
  terminal: { w: 32, h: 36, variants: ["idle", "active", "error"], frames: { active: 2 }, paint: paintTerminal },
  kiosk: { w: 32, h: 30, variants: ["idle", "active"], paint: paintKiosk },
  toolbox: { w: 16, h: 32, variants: ["default"], paint: paintToolbox },
  printer: { w: 16, h: 20, variants: ["idle", "active"], paint: paintPrinter },
  coffee: { w: 16, h: 28, variants: ["default"], paint: paintCoffee },
  phone: { w: 16, h: 26, variants: ["idle", "ringing"], frames: { ringing: 2 }, paint: paintPhone },
  couch: { w: 48, h: 26, variants: ["default"], paint: paintCouch },
  plant: { w: 16, h: 26, variants: ["0", "1"], paint: paintPlant },
  desk: { w: 32, h: 24, variants: ["off", "on", "error"], paint: paintDesk },
  chair: { w: 16, h: 18, variants: ["default"], paint: paintChair },
  "lead-desk": { w: 48, h: 26, variants: ["off", "on", "error"], frames: { error: 2 }, paint: paintLeadDesk },
  "lead-chair": { w: 16, h: 22, variants: ["default"], paint: paintLeadChair },
  rug: { w: 64, h: 48, variants: ["default"], paint: paintRug },
  "side-door": { w: 16, h: 16, variants: ["closed", "open"], paint: paintSideDoor },
};

/** ข้อมูลแคตตาล็อกแบบอ่านอย่างเดียว (หน้าพรีวิว/ทดสอบใช้ไล่วาดทุกชิ้น — scene ไม่ต้องใช้) */
export const PROP_CATALOG = Object.freeze(
  Object.fromEntries(
    Object.entries(CATALOG).map(([name, s]) => [
      name,
      Object.freeze({ w: s.w, h: s.h, variants: Object.freeze([...s.variants]), frames: Object.freeze({ ...(s.frames || {}) }) }),
    ]),
  ),
);

const atlas = createAtlas(512);

/**
 * ภาพของเฟอร์นิเจอร์หนึ่งชิ้น → { img, sx, sy, w, h } (วาดโดยให้มุมซ้ายล่างอยู่ที่มุมซ้ายล่างของ footprint)
 * ไม่ throw เด็ดขาด: variant แปลก → หน้าตาปกติ · ชื่อแปลก → กล่องบานเย็น "?" ให้เห็นบนจอว่ามีของหาย
 */
export function prop(name, variant = "default", frame = 0) {
  const key = typeof name === "string" ? name : String(name);
  const spec = Object.prototype.hasOwnProperty.call(CATALOG, key) ? CATALOG[key] : null;
  if (!spec) return unknownProp(key);
  const want = variant === undefined || variant === null ? "" : String(variant);
  const v = spec.variants.includes(want) ? want : spec.variants[0];
  const n = (spec.frames && spec.frames[v]) || 1;
  const fi = Math.floor(Number(frame));
  const f = n > 1 && Number.isFinite(fi) ? ((fi % n) + n) % n : 0;
  return atlas.get(`${key}|${v}|${f}`, spec.w, spec.h, (g, x, y) => {
    g.translate(x, y); // atlas ครอบ save/restore ให้แล้ว — ตัววาดทุกตัวจึงคิดพิกัดจาก 0,0 ได้
    spec.paint(g, v, f);
  });
}

/** ทิ้งภาพที่อบไว้ (ครั้งต่อไปที่ขอจะวาดใหม่) */
export function clearPropCache() {
  atlas.clear();
}

const warnedNames = new Set();
/*
 * ของที่ไม่รู้จัก = บั๊กฝั่งผู้เรียก (สะกดชื่อผิด/world เพิ่มของใหม่ก่อนมีภาพ) — แสดงเป็นกล่องบานเย็นที่
 * "ดูผิดชัด ๆ" ดีกว่าวาดว่างเปล่าแล้วไม่มีใครรู้ · เตือนครั้งเดียวต่อชื่อ เพราะถูกขอทุกเฟรม
 */
function unknownProp(name) {
  if (!warnedNames.has(name) && warnedNames.size < 64) {
    warnedNames.add(name);
    console.warn(`[pixel/props] ไม่รู้จักเฟอร์นิเจอร์ "${name}" — วาดกล่อง "?" แทน`);
  }
  return atlas.get("?unknown", 12, 12, (g, x, y) => {
    g.translate(x, y);
    box(g, 0, 0, 12, 12, "#ff00ff", "#ff80ff", "#b000b0");
    paintMap(g, [".###.", "#...#", "...#.", "..#..", ".....", "..#.."], { "#": C.white }, 4, 3);
  });
}

/* ───────────────────────── เปลือกห้อง (พื้น + ผนัง) ───────────────────────── */

/*
 * สีโครงห้อง: ผนังกระดาษน้ำเงินเข้ม (ออฟฟิศยามค่ำ) + ไม้ครึ่งล่าง (wainscot) ให้อุ่น
 * ขอบบนของผนัง (cap) คือ "ความหนาของผนังที่มองเห็นจากด้านบน" — สว่างกว่าหน้าผนัง ตามกฎ "ด้านบนสว่างกว่า"
 */
const SHELL = {
  capTop: mix(C.charcoal, C.slate, 0.45),
  capEdge: C.charcoal,
  paper: C.navy,
  paperStripe: mix(C.navy, C.blue, 0.22),
  paperDot: mix(C.navy, C.sky, 0.28),
  paperShade: mix(C.navy, C.ink, 0.45),
  panel: C.woodDark,
  panelIn: mix(C.woodDark, C.wood, 0.35),
  panelLo: C.woodDeep,
  panelHi: C.wood,
  base: C.woodDeep,
  outerFace: mix(C.ink, C.navy, 0.35),
  outerBrick: mix(C.ink, C.navy, 0.6),
};
/* โทนไม้ของแผ่นพื้น — ต่างกันนิดเดียวพอให้ "เป็นแผ่นไม้หลายแผ่น" โดยไม่กลายเป็นลายตาหมากรุก */
const PLANK_TONES = [
  C.woodLight,
  mix(C.woodLight, C.wood, 0.22),
  mix(C.woodLight, C.wood, 0.4),
  mix(C.woodLight, C.yellow, 0.08),
  mix(C.woodLight, C.wood, 0.12),
];
const PLANK_SEAM = mix(C.wood, C.woodDark, 0.35);
const PLANK_H = 4;
/* ไฟดับ = คูณสีทั้งเปลือกด้วยสีน้ำเงินหม่น (ไม่ใช่ทับด้วยสีดำ) ⇒ ไม้ยังเป็นไม้แต่ดูเย็นและมืดลงจริง */
const NIGHT_TINT = "#6874ac";

/**
 * วาดเปลือกห้องขนาด w × h ช่อง ที่มุม (0,0) ของ ctx (หน่วย world px — scene อบลง offscreen ต่อห้อง)
 *
 *   แถว 0–2      ผนังหลัง: ขอบบนผนัง · วอลเปเปอร์ · คิ้วผนัง (สี accent) · ไม้บุผนัง · บัวเชิงผนัง
 *   คอลัมน์ 0/W-1 ผนังข้าง (เห็นแต่ด้านบนของความหนาผนัง — มุม 3/4 ไม่เห็นหน้าผนังข้าง)
 *   แถว H-1      ผนังหน้า: ขอบบน + หน้าผนังด้านนอกที่หันหาผู้ดู (เข้มสุด)
 *   ที่เหลือ     พื้นไม้แผ่นยาว ลายต่างกันเล็กน้อยตาม hash ของตำแหน่ง (ห้องโตขึ้น พื้นเดิมไม่เปลี่ยนลาย)
 *
 * doorTx: วาดธรณี + พรมเช็ดเท้าที่แถว 3 ใต้ประตู (ตัวบานประตูเป็น prop "door" ที่ world วาดชั้น sorted)
 * sideDoors: [แถว…] ของประตูข้างในผนังซ้าย — วาดพรมเช็ดเท้าบนพื้นช่องถัดเข้ามา (คอลัมน์ 1) ตัวประตูเป็น
 *            prop "side-door" ชั้น sorted เหมือนประตูหลัก (เปิด/ปิดตามคนเดินผ่าน ไม่ต้องอบห้องใหม่)
 * windowTxs: ไม่ใช้ — หน้าต่างเป็น prop "window" ที่วาดทับผนังอยู่แล้ว (รับไว้ตามสัญญาเท่านั้น)
 * lightsOn:false: คูณสีทั้งเปลือก (multiply) ในตัววาดนี้เลย ไม่ใช่ทับทีหลัง ⇒ สีเข้ม/เย็นลงแบบไม่ขุ่น
 * accent: สีคิ้วผนัง (hex) — ให้แต่ละห้องมีเอกลักษณ์เล็ก ๆ โดยไม่ทำลายโทนรวม (ไม่ส่ง = ไม้อ่อน)
 */
export function paintRoomShell(ctx, opts = {}) {
  if (!ctx || typeof ctx.fillRect !== "function") return;
  const o = opts && typeof opts === "object" ? opts : {};
  const w = clampInt(o.w, 4, 512, 26);
  const h = clampInt(o.h, 5, 512, 13);
  const accent = hexOk(o.accent) ? o.accent : C.woodLight;
  const W = w * TILE;
  const H = h * TILE;
  ctx.save();
  try {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.imageSmoothingEnabled = false;
    paintFloor(ctx, w, h);
    const doorTx = Number(o.doorTx);
    if (Number.isFinite(doorTx) && doorTx >= 1 && doorTx <= w - 3) paintThreshold(ctx, Math.round(doorTx) * TILE);
    if (Array.isArray(o.sideDoors)) {
      for (const r of o.sideDoors) {
        const ty = Math.floor(Number(r));
        if (Number.isFinite(ty) && ty >= 3 && ty <= h - 2) paintSideMat(ctx, ty * TILE);
      }
    }
    paintBackWall(ctx, W, accent);
    paintSideWalls(ctx, W, H);
    paintFrontWall(ctx, W, H);
    if (o.lightsOn === false) {
      ctx.globalCompositeOperation = "multiply";
      fill(ctx, 0, 0, W, H, NIGHT_TINT);
    }
  } finally {
    ctx.restore();
  }
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** พื้นไม้: แผ่นสูง 4 px ยาวไม่เท่ากัน รอยต่อเหลื่อมกันแต่ละแถว (แบบปูพื้นจริง ไม่ใช่ตารางช่อง 16 px) */
function paintFloor(g, w, h) {
  const x0 = TILE;
  const x1 = (w - 1) * TILE;
  const y0 = 3 * TILE;
  const y1 = (h - 1) * TILE;
  fill(g, x0, y0, x1 - x0, y1 - y0, PLANK_TONES[0]);
  const lengths = [24, 32, 40, 28, 36, 48];
  for (let y = y0, row = 0; y < y1; y += PLANK_H, row++) {
    const rh = Math.min(PLANK_H, y1 - y);
    /* ตำแหน่งเริ่มของแถวขึ้นกับเลขแถวเท่านั้น ⇒ ลายพื้นของห้องขนาดใดก็ตรงกันในส่วนที่ทับกัน */
    let x = x0 - (hash32(`fr${row}`) % 40);
    for (let i = 0; x < x1; i++) {
      const hv = hash32(`fp${row}:${i}`);
      const len = lengths[hv % lengths.length];
      const a = Math.max(x0, x);
      const b = Math.min(x1, x + len);
      if (b > a) {
        const tone = PLANK_TONES[(hv >>> 4) % PLANK_TONES.length];
        fill(g, a, y, b - a, rh, tone);
        /* เสี้ยนไม้: เส้นเข้มสั้น ๆ บางแผ่น (ไม่ทุกแผ่น — ทุกแผ่นจะดูเป็นลายผ้า) */
        if ((hv >>> 9) % 3 === 0 && rh >= 3 && b - a > 12) {
          const gx = a + 3 + ((hv >>> 12) % (b - a - 10));
          const gl = 3 + ((hv >>> 16) % 5);
          fill(g, gx, y + 1 + ((hv >>> 20) % 2), Math.min(gl, b - gx - 2), 1, mix(tone, C.wood, 0.45));
        }
        /* ตาไม้จุดเดียว — นาน ๆ ที */
        if ((hv >>> 22) % 11 === 0 && b - a > 12) dot(g, a + 6 + ((hv >>> 25) % (b - a - 10)), y + 1, mix(tone, C.woodDark, 0.5));
        if (x >= x0) fill(g, x, y, 1, rh - 1, PLANK_SEAM); // รอยต่อหัวแผ่น
      }
      x += len;
    }
    if (rh === PLANK_H) fill(g, x0, y + PLANK_H - 1, x1 - x0, 1, PLANK_SEAM); // ร่องระหว่างแถวแผ่น
  }
  /* เงาอับแสงใต้ผนังหลังและข้างผนังข้าง — ทำให้พื้น "ลึกเข้าไป" ใต้ผนังแทนที่จะแปะเรียบ */
  const ao = [0.42, 0.26, 0.14, 0.06];
  ao.forEach((a, i) => fill(g, x0, y0 + i, x1 - x0, 1, `rgba(26,28,44,${a})`));
  [0.3, 0.12].forEach((a, i) => {
    fill(g, x0 + i, y0, 1, y1 - y0, `rgba(26,28,44,${a})`);
    fill(g, x1 - 1 - i, y0, 1, y1 - y0, `rgba(26,28,44,${a * 0.7})`);
  });
}

/** ธรณีประตูหิน + พรมเช็ดเท้า ที่แถว 3 ใต้ประตู (จุดที่ผู้ช่วยทุกคนเดินเข้า-ออก) */
function paintThreshold(g, x) {
  const y = 3 * TILE;
  fill(g, x + 1, y, 30, 2, C.silver);
  fill(g, x + 1, y + 2, 30, 1, C.slate);
  fill(g, x + 3, y + 4, 26, 10, C.woodDeep);
  fill(g, x + 4, y + 5, 24, 8, C.red);
  frame(g, x + 5, y + 6, 22, 6, C.plum);
  for (let i = 0; i < 5; i++) fill(g, x + 8 + i * 4, y + 8, 2, 2, C.orange);
  fill(g, x + 3, y + 14, 26, 1, "rgba(26,28,44,0.3)");
}

/** พรมเช็ดเท้าแนวตั้งหน้าประตูข้าง (พื้นคอลัมน์ 1 แถว y) — ลายเดียวกับพรมหน้าประตูหลัก ให้รู้ว่าเป็นทางเข้า */
function paintSideMat(g, y) {
  const x = TILE;
  fill(g, x + 2, y + 1, 11, 14, C.woodDeep);
  fill(g, x + 3, y + 2, 9, 12, C.red);
  frame(g, x + 4, y + 3, 7, 10, C.plum);
  for (let i = 0; i < 3; i++) fill(g, x + 6, y + 5 + i * 3, 2, 2, C.orange);
  fill(g, x + 13, y + 2, 1, 13, "rgba(26,28,44,0.3)");
}

function paintBackWall(g, W, accent) {
  const x0 = TILE;
  const ww = W - 2 * TILE;
  /* ขอบบนผนัง (ความหนาผนังที่มองจากบน) */
  fill(g, 0, 0, W, 1, C.ink);
  fill(g, x0, 1, ww, 2, SHELL.capTop);
  fill(g, x0, 3, ww, 1, SHELL.capEdge);
  /* วอลเปเปอร์: ริ้วตั้ง + จุดลายเล็ก ๆ ทุก 8 px — ผนังเรียบสนิทดูเป็นกระดาษแข็ง */
  fill(g, x0, 4, ww, 24, SHELL.paper);
  for (let x = x0 + 2; x < x0 + ww; x += 8) {
    fill(g, x, 5, 1, 23, SHELL.paperStripe);
    dot(g, x + 4, 9, SHELL.paperDot);
    dot(g, x + 4, 17, SHELL.paperDot);
    dot(g, x + 4, 25, SHELL.paperDot);
  }
  fill(g, x0, 4, ww, 1, SHELL.paperShade);
  fill(g, x0, 5, ww, 1, mix(SHELL.paper, C.ink, 0.2));
  /* คิ้วผนัง (chair rail) = สี accent ของห้อง */
  fill(g, x0, 28, ww, 1, shade(accent, 0.3));
  fill(g, x0, 29, ww, 1, accent);
  fill(g, x0, 30, ww, 1, shade(accent, -0.45));
  /* ไม้บุผนังครึ่งล่าง: ลูกฟักทุก 16 px ตรงกับช่อง ⇒ ของที่ชิดผนังดูตั้งอยู่หน้าลูกฟักพอดี */
  fill(g, x0, 31, ww, 13, SHELL.panel);
  for (let x = x0; x < x0 + ww; x += TILE) {
    fill(g, x + 2, 33, 12, 9, SHELL.panelIn);
    fill(g, x + 2, 33, 12, 1, SHELL.panelLo);
    fill(g, x + 2, 33, 1, 9, SHELL.panelLo);
    fill(g, x + 2, 41, 12, 1, SHELL.panelHi);
    fill(g, x + 13, 34, 1, 8, SHELL.panelHi);
  }
  /* บัวเชิงผนัง */
  fill(g, x0, 44, ww, 1, C.wood);
  fill(g, x0, 45, ww, 2, SHELL.base);
  fill(g, x0, 47, ww, 1, C.ink);
}

function paintSideWalls(g, W, H) {
  const yEnd = H - TILE + 5; // ผนังข้างวิ่งลงไปชนขอบบนของผนังหน้า
  for (const x of [0, W - TILE]) {
    const left = x === 0;
    const inner = left ? x + TILE - 1 : x; // ขอบด้านที่ติดพื้นห้อง
    const outer = left ? x : x + TILE - 1;
    fill(g, x, 0, TILE, yEnd, SHELL.capTop);
    /* ลายอิฐจาง ๆ บนสันผนัง — แค่พอให้ไม่ใช่แถบสีเรียบ */
    const brick = mix(SHELL.capTop, SHELL.capEdge, 0.55);
    for (let y = 8, k = 0; y < yEnd - 2; y += 8, k++) {
      fill(g, x + 2, y, TILE - 4, 1, brick);
      fill(g, x + (k % 2 ? 5 : 10), y - 7, 1, 7, brick);
    }
    fill(g, inner + (left ? -1 : 1), 0, 1, yEnd, SHELL.capEdge);
    fill(g, inner, 0, 1, yEnd, C.ink);
    fill(g, outer, 0, 1, H, C.ink);
  }
  fill(g, 0, 0, W, 1, C.ink);
}

function paintFrontWall(g, W, H) {
  const y = H - TILE;
  /* ขอบบนผนังหน้า (ต่อกับสันผนังข้าง) */
  fill(g, TILE, y, W - 2 * TILE, 1, C.ink);
  fill(g, TILE, y + 1, W - 2 * TILE, 3, SHELL.capTop);
  fill(g, 0, y + 4, W, 1, SHELL.capEdge);
  /* หน้าผนังด้านนอก (หันหาผู้ดู) — เข้มสุด เป็นกรอบล่างของห้อง */
  fill(g, 0, y + 5, W, TILE - 5, SHELL.outerFace);
  for (let r = 0; r < 2; r++) {
    const by = y + 8 + r * 4;
    fill(g, 1, by, W - 2, 1, SHELL.outerBrick);
    for (let x = (r % 2) * 8 + 4; x < W - 2; x += 16) fill(g, x, by - 3, 1, 3, SHELL.outerBrick);
  }
  fill(g, 0, H - 1, W, 1, C.ink);
  fill(g, 0, y + 4, 1, TILE - 4, C.ink);
  fill(g, W - 1, y + 4, 1, TILE - 4, C.ink);
}

/* ───────────────────────── ของบนผนังหลัง ───────────────────────── */

const HALL_DARK = "#12131f"; // สีเดียวกับพื้นหลังหน้า (โถงทางเดินข้างนอก) ⇒ ประตูเปิด = มองทะลุออกไปข้างนอกจริง

/** ประตู 32×44: วงกบไม้ + บานไม้มีช่องกระจก/ลูกฟัก · open = ช่องมืดของโถง + บานที่แง้มไปด้านบานพับ */
function paintDoor(g, v) {
  fill(g, 0, 0, 32, 44, C.ink);
  fill(g, 1, 1, 30, 43, C.woodDark);
  fill(g, 1, 1, 30, 1, C.woodLight);
  fill(g, 1, 2, 1, 42, C.wood);
  fill(g, 30, 2, 1, 42, C.woodDeep);
  /* ป้ายเลขห้องเล็ก ๆ บนคานประตู — ให้ประตูอ่านออกว่าเป็น "ทางเข้าห้องนี้" ไม่ใช่ตู้ */
  fill(g, 13, 1, 6, 3, C.yellow);
  fill(g, 13, 3, 6, 1, C.orange);
  fill(g, 15, 2, 2, 1, C.woodDeep);
  fill(g, 3, 4, 26, 40, C.ink);
  if (v === "open") {
    fill(g, 4, 5, 24, 39, HALL_DARK);
    /* พื้นโถงข้างนอก (เส้นขอบฟ้าที่ ~3/4 ความสูง = มองเห็นพื้นทางเดินไกล ๆ) */
    fill(g, 4, 33, 24, 11, mix(HALL_DARK, C.charcoal, 0.55));
    fill(g, 4, 33, 24, 1, C.charcoal);
    fill(g, 12, 38, 16, 1, mix(HALL_DARK, C.charcoal, 0.8));
    fill(g, 16, 41, 12, 1, mix(HALL_DARK, C.charcoal, 0.8));
    /* บานประตูที่เปิดออกไปด้านนอก เห็นเป็นแผ่นบางเฉียงทางด้านบานพับ (ซ้าย) */
    for (let i = 0; i < 6; i++) fill(g, 4 + i, 5 + i, 1, 39 - i * 2, i === 5 ? C.woodLight : i < 2 ? C.woodDeep : C.wood);
    fill(g, 9, 24, 1, 2, C.yellow); // ลูกบิดด้านใน
    return;
  }
  fill(g, 4, 5, 24, 39, C.wood);
  fill(g, 4, 5, 24, 1, C.woodLight);
  fill(g, 4, 5, 1, 39, mix(C.wood, C.woodLight, 0.5));
  fill(g, 27, 5, 1, 39, C.woodDark);
  /* ช่องกระจกฝ้าบน (โถงข้างนอกมืด ⇒ กระจกเป็นน้ำเงินเข้มมีแสงสะท้อนเฉียง) */
  box(g, 8, 8, 16, 11, C.navy, C.woodDeep, C.woodLight);
  fill(g, 9, 9, 14, 9, mix(C.navy, C.slate, 0.25));
  for (let i = 0; i < 4; i++) dot(g, 17 + i, 13 - i, mix(C.silver, C.navy, 0.3));
  for (let i = 0; i < 3; i++) dot(g, 12 + i, 14 - i, mix(C.silver, C.navy, 0.5));
  /* ลูกฟักล่าง 2 บาน: ขอบเงาบน/ซ้าย ขอบสว่างล่าง/ขวา = ลูกฟักจมลงไปในบาน */
  for (const px of [7, 17]) {
    fill(g, px, 22, 8, 17, mix(C.wood, C.woodLight, 0.25));
    fill(g, px, 22, 8, 1, C.woodDark);
    fill(g, px, 22, 1, 17, C.woodDark);
    fill(g, px, 38, 8, 1, C.woodLight);
    fill(g, px + 7, 23, 1, 16, C.woodLight);
  }
  /* ลูกบิดทองเหลือง + แผ่นกันกระแทกโลหะด้านล่าง */
  fill(g, 23, 25, 3, 5, C.silver);
  fill(g, 23, 25, 3, 1, C.white);
  fill(g, 22, 26, 2, 2, C.ink);
  fill(g, 22, 26, 2, 1, C.yellow);
  fill(g, 4, 40, 24, 3, C.slate);
  fill(g, 4, 40, 24, 1, C.silver);
  fill(g, 4, 43, 24, 1, C.ink);
}

/*
 * ประตูข้าง 16×16 (ช่องหนึ่งในสันผนังซ้าย ของห้องที่โตเกิน 2 ชุดโต๊ะ) — มุม 3/4 เห็นผนังข้างแค่ "สันบน"
 * ประตูในผนังแนวตั้งจึงวาดแบบมองจากบน: วงกบไม้หัว-ท้าย (ปลายของสันผนังสองท่อน) · พื้นธรณีหินระหว่างวงกบ
 * closed = บานไม้หนาวางขวางช่อง (เห็นสันบานจากด้านบน มีร่องไม้ + ลูกบิดทองเหลืองฝั่งในห้อง)
 * open   = บานเปิดออกไปข้างนอก ⇒ ครึ่งนอกของช่องเป็นโถงมืด (สีเดียวกับพื้นหลังหน้า) เห็นแค่บานพับ
 *          ครึ่งในเป็นธรณีหินที่มีแสงในห้องตกลงมา — อ่านออกทันทีว่า "มีคนกำลังเข้า/ออกทางนี้"
 *
 *   x: 0 = ขอบนอกของห้อง · 15 = ขอบที่ติดพื้นห้อง (คอลัมน์ 1) · y: 0–2 วงกบบน · 3–12 ช่องประตู · 13–15 วงกบล่าง
 */
function paintSideDoor(g, v) {
  const open = v === "open";
  /* พื้นธรณีหิน (ทั้งช่อง — วงกบวาดทับหัว-ท้ายทีหลัง) */
  fill(g, 0, 0, 16, 16, C.ink);
  fill(g, 1, 3, 14, 10, C.silver);
  fill(g, 1, 3, 14, 1, C.slate);
  fill(g, 1, 12, 14, 1, mix(C.silver, C.slate, 0.5));
  fill(g, 8, 4, 1, 8, mix(C.silver, C.slate, 0.35)); // รอยต่อแผ่นหิน
  if (open) {
    /* ครึ่งนอกมืด = โถงทางเดินข้างนอก (เห็นพื้นโถงจาง ๆ) · บานพับ + ขอบบานที่เปิดออกไปชิดวงกบบน */
    fill(g, 0, 3, 7, 10, HALL_DARK);
    fill(g, 0, 9, 7, 4, mix(HALL_DARK, C.charcoal, 0.55));
    fill(g, 0, 9, 7, 1, C.charcoal);
    fill(g, 0, 3, 7, 2, C.woodDark);
    fill(g, 0, 3, 7, 1, C.wood);
    fill(g, 6, 3, 1, 2, C.woodDeep);
    dot(g, 6, 5, C.yellow); // บานพับทองเหลือง
    /* แสงในห้องตกลงบนธรณีครึ่งใน */
    fill(g, 7, 4, 7, 8, mix(C.silver, C.yellow, 0.25));
    fill(g, 7, 4, 1, 8, C.ink);
  } else {
    /* บานไม้ปิด: สันบานหนา 6 px กลางความหนาผนัง (ไฮไลต์ซ้ายบน เงาขวา) ร่องไม้ตามยาว */
    box(g, 5, 3, 6, 10, C.wood, C.woodLight, C.woodDeep);
    fill(g, 7, 5, 1, 6, C.woodDark);
    /* ลูกบิดฝั่งในห้อง ยื่นเลยสันบานมาทางพื้น */
    fill(g, 11, 7, 2, 2, C.yellow);
    dot(g, 11, 7, C.white);
    fill(g, 11, 9, 2, 1, C.ink);
  }
  /* วงกบบน/ล่าง = ปลายสันผนังสองท่อนที่หุ้มไม้ (ด้านบนสว่างกว่าเสมอ — แสงจากเพดาน) */
  for (const y of [0, 13]) {
    fill(g, 0, y, 16, 3, C.woodDark);
    fill(g, 1, y, 14, 1, C.woodLight);
    fill(g, 1, y + 1, 14, 1, C.wood);
    fill(g, 0, y + 2, 16, 1, C.woodDeep);
  }
  /* เส้นขอบในเดียวกับสันผนังข้าง (ต่อเนื่องกับผนังเหนือ/ใต้ประตู) */
  fill(g, 0, 0, 1, 16, C.ink);
  fill(g, 15, 0, 1, 3, C.ink);
  fill(g, 15, 13, 1, 3, C.ink);
}

/**
 * หน้าต่าง 32×24: ม่านสองข้าง · กรอบไม้ 4 ช่องกระจก · เมืองยามค่ำคืนข้างนอก
 * dark = ห้องปิดไฟ ⇒ หน้าต่างมืดทั้งบาน ไม่มีไฟจากตึก (ให้ห้องที่ session จบแล้ว "หลับ" ทั้งห้อง)
 */
function paintWindow(g, v) {
  const dark = v === "dark";
  box(g, 3, 1, 26, 20, C.wood, C.woodLight, C.woodDark);
  paintNightCity(g, 5, 3, 22, 16, dark);
  /* เงาของกรอบบนกระจก (กระจกอยู่ลึกกว่ากรอบ) */
  fill(g, 5, 3, 22, 1, "rgba(26,28,44,0.45)");
  fill(g, 15, 3, 2, 16, C.wood);
  fill(g, 15, 3, 1, 16, C.woodLight);
  fill(g, 5, 11, 22, 1, C.wood);
  fill(g, 5, 11, 22, 1, mix(C.wood, C.woodLight, 0.4));
  /* ขอบหน้าต่าง (sill) ยื่นออกมา — ด้านบนสว่าง หน้าเข้ม */
  fill(g, 1, 19, 30, 1, C.ink);
  fill(g, 1, 20, 30, 1, C.woodLight);
  fill(g, 1, 21, 30, 1, C.wood);
  fill(g, 1, 22, 30, 1, C.woodDeep);
  fill(g, 2, 23, 29, 1, "rgba(26,28,44,0.35)");
  fill(g, 0, 19, 1, 4, C.ink);
  fill(g, 31, 19, 1, 4, C.ink);
  /* ราวม่าน + ม่านผูกเอว (ห้องทำงานตอนค่ำ ⇒ ม่านทำให้ "บ้าน ๆ" ขึ้นทันที) */
  fill(g, 0, 0, 32, 1, C.woodDeep);
  dot(g, 0, 0, C.yellow);
  dot(g, 31, 0, C.yellow);
  paintCurtain(g, 0, false);
  paintCurtain(g, 27, true);
}

function paintCurtain(g, x, right) {
  /* ความกว้างม่านตามแถว: กว้างบนสุด คอดที่สายผูก (แถว ~11) แล้วบานออกนิดหน่อยที่ชายม่าน */
  const widths = [5, 5, 5, 5, 5, 4, 4, 4, 4, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5];
  widths.forEach((wd, i) => {
    const y = 1 + i;
    const x0 = right ? x + 5 - wd : x;
    fill(g, x0, y, wd, 1, C.red);
    dot(g, right ? x0 : x0 + wd - 1, y, C.ink); // ขอบด้านในของม่าน
    dot(g, x0 + (right ? 2 : 1), y, C.plum); // รอยจีบ
    if (wd >= 4) dot(g, x0 + (right ? 3 : 2), y, mix(C.red, C.orange, 0.5));
  });
  fill(g, right ? x + 1 : x + 1, 11, 3, 1, C.yellow); // สายผูกม่าน
}

/** เมืองกลางคืนหลังกระจก — ตึก/ดาว/ไฟหน้าต่างกำหนดตายตัวด้วย hash (ไม่กะพริบ ไม่สุ่ม) */
function paintNightCity(g, x, y, w, h, dark) {
  const top = dark ? mix(C.ink, "#000000", 0.2) : mix(C.ink, C.navy, 0.35);
  const mid = dark ? C.ink : C.navy;
  const low = dark ? mix(C.ink, C.navy, 0.35) : mix(C.navy, C.plum, 0.55);
  for (let i = 0; i < h; i++) {
    const t = i / (h - 1);
    fill(g, x, y + i, w, 1, t < 0.45 ? mix(top, mid, t / 0.45) : mix(mid, low, (t - 0.45) / 0.55));
  }
  const stars = [
    [2, 1],
    [7, 3],
    [11, 1],
    [19, 5],
    [4, 6],
    [13, 4],
  ];
  for (const [sx, sy] of stars) dot(g, x + sx, y + sy, dark ? C.slate : C.silver);
  dot(g, x + 7, y + 3, dark ? C.silver : C.white);
  /* พระจันทร์เสี้ยว */
  const moon = dark ? C.silver : mix(C.yellow, C.white, 0.5);
  fill(g, x + 17, y + 1, 3, 3, moon);
  dot(g, x + 16, y + 2, moon);
  fill(g, x + 18, y + 1, 2, 2, top);
  /* ตึก: [x, กว้าง, สูง, ชั้นไกล?] */
  const blds = [
    [0, 4, 7, 1],
    [3, 5, 10, 0],
    [8, 4, 6, 1],
    [11, 4, 8, 0],
    [14, 3, 5, 1],
    [17, 5, 9, 0],
  ];
  for (const [bx, bw, bh, far] of blds) {
    const col = far ? (dark ? mix(C.ink, C.charcoal, 0.4) : C.charcoal) : dark ? C.ink : mix(C.ink, C.charcoal, 0.4);
    const x0 = x + bx;
    const y0 = y + h - bh;
    fill(g, x0, y0, Math.min(bw, w - bx), bh, col);
    if (dark) continue;
    /* ไฟหน้าต่างตึก: ช่องละ 1 px เว้น 1 px เลือกเปิดด้วย hash ของตำแหน่ง */
    for (let wy = y0 + 2; wy < y + h - 1; wy += 2) {
      for (let wx = x0 + 1; wx < x0 + bw - 1 && wx < x + w; wx += 2) {
        const hv = hash32(`win${wx}:${wy}`);
        if (hv % 3 === 0) continue;
        dot(g, wx, wy, hv % 5 === 1 ? C.orange : far ? mix(C.yellow, C.charcoal, 0.35) : C.yellow);
      }
    }
  }
  /* เสาอากาศมีไฟแดงบนตึกสูงสุด (ปิดไฟห้องแล้วก็ยังเห็นเป็นจุดเดียว — เมืองไม่ได้ดับตามเรา) */
  fill(g, x + 5, y + h - 12, 1, 2, dark ? C.ink : C.charcoal);
  dot(g, x + 5, y + h - 13, dark ? mix(C.red, C.ink, 0.5) : C.red);
}

/** ไวต์บอร์ด 48×26 บนขาตั้งชิดผนัง (ขาทำให้ขอบล่างที่ระดับพื้นดูสมเหตุสมผล) · scribble = มีแผนงานเขียนเต็ม */
function paintWhiteboard(g, v) {
  /* ขาตั้ง + ล้อ */
  for (const lx of [4, 42]) {
    fill(g, lx, 20, 2, 5, C.slate);
    fill(g, lx, 20, 1, 5, C.silver);
    fill(g, lx - 1, 24, 4, 2, C.ink);
  }
  box(g, 0, 0, 48, 21, C.silver, C.white, C.slate);
  const surf = mix(C.white, C.silver, 0.12);
  fill(g, 2, 2, 44, 16, C.white);
  fill(g, 2, 16, 44, 2, surf);
  fill(g, 44, 2, 2, 16, surf);
  /* ประกายสะท้อนเฉียง — กระดานมันวาว */
  for (let i = 0; i < 5; i++) dot(g, 36 + i, 7 - i, mix(C.white, C.sky, 0.12));
  for (let i = 0; i < 3; i++) dot(g, 40 + i, 7 - i, mix(C.white, C.sky, 0.12));
  /* รางวางปากกา + ปากกา 3 สี + แปรงลบ */
  fill(g, 2, 18, 44, 2, C.slate);
  fill(g, 2, 18, 44, 1, C.silver);
  fill(g, 1, 20, 46, 1, C.ink);
  fill(g, 7, 17, 4, 1, C.red);
  fill(g, 12, 17, 4, 1, C.blue);
  fill(g, 17, 17, 3, 1, C.green);
  dot(g, 10, 17, C.ink);
  dot(g, 15, 17, C.ink);
  fill(g, 35, 16, 7, 2, C.charcoal);
  fill(g, 35, 16, 7, 1, C.slate);
  fill(g, 35, 18, 7, 1, C.yellow);
  if (v !== "scribble") {
    /* กระดานสะอาด: รอยลบจาง ๆ (บอกว่า "เคยใช้" ไม่ใช่ของใหม่แกะกล่อง) */
    const ghost = mix(C.white, C.silver, 0.35);
    fill(g, 6, 5, 9, 1, ghost);
    fill(g, 8, 7, 12, 1, ghost);
    fill(g, 24, 11, 7, 1, ghost);
    return;
  }
  /* หัวข้อ (ขีดดำหนา) */
  fill(g, 4, 3, 10, 1, C.charcoal);
  fill(g, 4, 4, 7, 1, C.charcoal);
  dot(g, 15, 3, C.charcoal);
  /* ผังกล่อง-ลูกศร (สีน้ำเงิน) = วางแผนงาน */
  frame(g, 4, 7, 7, 5, C.blue);
  frame(g, 15, 7, 7, 5, C.blue);
  frame(g, 15, 13, 7, 3, C.blue);
  fill(g, 6, 9, 3, 1, C.sky);
  fill(g, 17, 9, 3, 1, C.sky);
  fill(g, 11, 9, 3, 1, C.red);
  dot(g, 13, 8, C.red);
  dot(g, 13, 10, C.red);
  fill(g, 7, 12, 1, 2, C.red);
  fill(g, 7, 14, 7, 1, C.red);
  dot(g, 13, 13, C.red);
  dot(g, 13, 15, C.red);
  /* เช็กลิสต์ (สีเขียว = ติ๊กแล้ว) */
  for (let i = 0; i < 4; i++) {
    const ty = 4 + i * 3;
    frame(g, 26, ty, 3, 3, C.charcoal);
    if (i < 3) {
      dot(g, 27, ty + 1, C.green);
      dot(g, 28, ty, C.green);
    }
    fill(g, 30, ty + 1, i === 3 ? 5 : 7 + (i % 2) * 3, 1, i < 3 ? C.slate : C.charcoal);
  }
  /* วงกลมแดงเน้นงานที่เหลือ + กราฟเส้นขึ้น */
  frame(g, 29, 12, 9, 5, C.red);
  fill(g, 40, 4, 1, 9, C.charcoal);
  fill(g, 40, 12, 5, 1, C.charcoal);
  const line = [
    [41, 10],
    [42, 9],
    [43, 7],
    [44, 5],
  ];
  for (const [lx, ly] of line) dot(g, lx, ly, C.orange);
}

/** กล้องวงจรปิด 16×14 ยึดผนังด้านขวา หันเลนส์ลงมาทางซ้าย · on = ไฟแดงสว่าง + เลนส์วาว (มีคนเฝ้าดูอยู่) */
function paintCctv(g, v) {
  const on = v === "on";
  /* แผ่นยึดผนัง + แขน */
  box(g, 11, 0, 5, 10, C.charcoal, C.slate, C.ink);
  dot(g, 13, 2, C.silver);
  dot(g, 13, 7, C.silver);
  fill(g, 8, 2, 4, 4, C.ink);
  fill(g, 9, 3, 3, 1, C.slate);
  fill(g, 9, 4, 3, 1, C.charcoal);
  /* ตัวกล้อง: กล่องขาว ฝากันแดดยื่นเหนือหน้าเลนส์ (ซ้าย) · ท้องกล้องเงา */
  fill(g, 0, 4, 11, 8, C.ink);
  fill(g, 1, 5, 9, 1, C.white);
  fill(g, 2, 6, 8, 3, mix(C.white, C.silver, 0.2));
  fill(g, 2, 9, 8, 2, C.silver);
  fill(g, 9, 6, 1, 5, C.slate);
  /* หน้าเลนส์: วงกลมดำขอบเทา มีประกาย (เปิดอยู่ = ประกายฟ้าสว่าง) */
  fill(g, 1, 6, 1, 5, C.slate);
  fill(g, 0, 7, 3, 3, C.ink);
  dot(g, 1, 8, on ? C.cyan : C.navy);
  dot(g, 1, 7, on ? C.white : C.charcoal);
  /* ไฟสถานะ REC */
  dot(g, 7, 7, on ? C.red : C.plum);
  if (on) {
    dot(g, 7, 6, mix(C.red, C.white, 0.55));
    dot(g, 8, 7, mix(C.red, C.orange, 0.5));
  }
  fill(g, 2, 12, 8, 1, "rgba(26,28,44,0.3)");
}

/** นาฬิกาแขวน 12×12 (หน้าปัดครีม ขอบไม้) — เข็มหยุดนิ่ง: ฉากหลังห้ามขยับเอง (ผู้ใช้เวียนหัว) */
function paintClock(g) {
  const rows = [
    "...RRRRR...",
    ".RRwwwwwRR.",
    ".RwwwwwwwR.",
    "RwwwwwwwwwR",
    "RwwwwwwwwwR",
    "RwwwwwwwwwR",
    "RwwwwwwwwwR",
    "RwwwwwwwwwR",
    ".RwwwwwwwR.",
    ".RRwwwwwRR.",
    "...RRRRR...",
  ];
  /* เงาตกกระทบผนัง 1 px ขวา-ล่าง ก่อน แล้วค่อยวาดตัวนาฬิกาทับ */
  paintMap(g, rows, { R: "rgba(26,28,44,0.45)", w: "rgba(26,28,44,0.45)" }, 1, 1);
  paintMap(g, rows, { R: C.woodDark, w: mix(C.white, C.yellow, 0.25) }, 0, 0);
  fill(g, 3, 0, 5, 1, C.woodLight);
  dot(g, 1, 1, C.wood);
  dot(g, 2, 1, C.woodLight);
  /* ขีดชั่วโมง 12/3/6/9 */
  dot(g, 5, 1, C.slate);
  dot(g, 9, 5, C.slate);
  dot(g, 5, 9, C.slate);
  dot(g, 1, 5, C.slate);
  /* เข็มยาวชี้ 12 เข็มสั้นชี้ 4 (ราวสี่ทุ่ม — ออฟฟิศยามค่ำ) */
  fill(g, 5, 2, 1, 4, C.ink);
  dot(g, 6, 6, C.ink);
  dot(g, 7, 7, C.ink);
  dot(g, 5, 5, C.red);
}

/** ป้ายคะแนน 32×14: จอมืดเปล่า ๆ — scene เขียนตัวเลขจริงทับด้วย drawTinyText (ภาพไม่แต่งตัวเลขเอง) */
function paintScoreboard(g) {
  box(g, 0, 0, 32, 14, C.charcoal, C.slate, C.ink);
  fill(g, 2, 2, 28, 10, C.ink);
  fill(g, 3, 3, 26, 8, "#12131f");
  /* ตาราง LED จางมาก ๆ — ให้รู้ว่าเป็นจอ LED แต่ไม่แย่งสายตาจากตัวเลขที่ scene เขียน */
  for (let yy = 4; yy < 11; yy += 2) for (let xx = 4; xx < 29; xx += 2) dot(g, xx, yy, "#1c1e2e");
  dot(g, 1, 1, C.silver);
  dot(g, 30, 1, C.silver);
  dot(g, 1, 12, C.silver);
  dot(g, 30, 12, C.silver);
}

/** โปสเตอร์ 16×20 สามแบบ: "0" ภูเขายามเย็น · "1" จรวด · "2" กราฟแท่ง */
function paintPoster(g, v) {
  fill(g, 1, 2, 15, 18, "rgba(26,28,44,0.4)"); // เงาบนผนัง
  fill(g, 0, 1, 15, 18, C.white);
  frame(g, 0, 1, 15, 18, mix(C.white, C.silver, 0.5));
  const x = 2;
  const y = 3;
  if (v === "1") {
    fill(g, x, y, 11, 12, C.navy);
    for (const [sx, sy] of [
      [1, 1],
      [8, 2],
      [2, 7],
      [9, 9],
      [5, 0],
    ])
      dot(g, x + sx, y + sy, C.silver);
    /* จรวด: หัวแดง ตัวขาว หน้าต่างฟ้า ครีบแดง ไฟท้ายส้ม-เหลือง */
    fill(g, x + 5, y + 1, 1, 1, C.red);
    fill(g, x + 4, y + 2, 3, 1, C.red);
    fill(g, x + 4, y + 3, 3, 5, C.white);
    fill(g, x + 6, y + 3, 1, 5, C.silver);
    dot(g, x + 5, y + 4, C.sky);
    fill(g, x + 3, y + 6, 1, 3, C.red);
    fill(g, x + 7, y + 6, 1, 3, C.red);
    fill(g, x + 4, y + 8, 3, 1, C.slate);
    fill(g, x + 4, y + 9, 3, 1, C.orange);
    dot(g, x + 5, y + 10, C.yellow);
    dot(g, x + 5, y + 11, C.orange);
    fill(g, x, y + 13, 11, 1, C.red);
    fill(g, x + 2, y + 15, 7, 1, C.charcoal);
  } else if (v === "2") {
    fill(g, x, y, 11, 2, C.blue);
    fill(g, x + 1, y + 2, 6, 1, C.slate);
    fill(g, x + 1, y + 4, 1, 9, C.charcoal);
    fill(g, x + 1, y + 12, 10, 1, C.charcoal);
    const bars = [
      [3, 3, C.sky],
      [5, 5, C.green],
      [7, 4, C.orange],
      [9, 7, C.lime],
    ];
    for (const [bx, bh, col] of bars) {
      fill(g, x + bx, y + 12 - bh, 2, bh, col);
      fill(g, x + bx + 1, y + 12 - bh, 1, bh, shade(col, -0.25));
    }
    fill(g, x + 1, y + 14, 9, 1, C.silver);
    fill(g, x + 1, y + 15, 6, 1, C.silver);
  } else {
    /* ท้องฟ้ายามเย็นไล่สี + ดวงอาทิตย์ครึ่งดวง + ภูเขาสองชั้น */
    const sky = [C.plum, C.plum, C.red, C.red, C.orange, C.orange, C.yellow];
    sky.forEach((c, i) => fill(g, x, y + i, 11, 1, c));
    fill(g, x + 6, y + 5, 3, 2, mix(C.yellow, C.white, 0.5));
    fill(g, x + 5, y + 6, 5, 1, mix(C.yellow, C.white, 0.5));
    const far = [6, 5, 4, 4, 3, 3, 4, 5, 5, 6, 6];
    const near = [9, 8, 7, 6, 6, 7, 8, 9, 9, 8, 7];
    for (let i = 0; i < 11; i++) {
      fill(g, x + i, y + far[i], 1, 12 - far[i], C.purple);
      fill(g, x + i, y + near[i], 1, 12 - near[i], C.navy);
    }
    dot(g, x + 4, y + 3, mix(C.white, C.lilac, 0.4)); // หิมะยอดเขา
    fill(g, x, y + 12, 11, 1, C.teal);
    fill(g, x + 2, y + 14, 7, 1, C.charcoal);
    fill(g, x + 3, y + 15, 5, 1, C.silver);
  }
  /* หมุดแดงตรึงโปสเตอร์ */
  dot(g, 7, 0, C.red);
  dot(g, 7, 1, C.plum);
}

/* ───────────────────────── สถานีทำงานชิดผนังหลัง (แถว 3) ───────────────────────── */

/**
 * ตู้ไปรษณีย์ 16×24 (ตู้แดงบนเสา — "จดหมาย" = prompt ใหม่จากผู้ใช้)
 * full = ธงเหลืองยกขึ้น + ซองจดหมายโผล่จากช่อง (อ่านออกทันทีว่า "มีงานใหม่มาแล้ว")
 */
function paintMailbox(g, v) {
  const full = v === "full";
  floorShadow(g, 2, 23, 12);
  /* เสา + ฐาน */
  fill(g, 6, 15, 3, 7, C.ink);
  fill(g, 7, 15, 1, 6, C.slate);
  fill(g, 4, 21, 7, 2, C.ink);
  fill(g, 5, 21, 5, 1, C.slate);
  /* ตัวตู้ทรงโดม: เงาหมึกทั้งทรงก่อน แล้วเติมสีด้านใน (โดมบนรับแสง = ส้มแดง, หน้าตู้ = แดง) */
  fill(g, 4, 2, 6, 1, C.ink);
  fill(g, 2, 3, 10, 1, C.ink);
  fill(g, 1, 4, 12, 12, C.ink);
  fill(g, 4, 3, 6, 1, mix(C.red, C.orange, 0.6));
  fill(g, 2, 4, 10, 1, mix(C.red, C.orange, 0.6));
  fill(g, 2, 5, 10, 1, mix(C.red, C.orange, 0.3));
  fill(g, 2, 6, 10, 9, C.red);
  dot(g, 5, 3, C.yellow);
  dot(g, 4, 4, mix(C.orange, C.yellow, 0.5));
  fill(g, 11, 5, 1, 10, C.plum);
  fill(g, 2, 14, 10, 1, C.plum);
  /* ช่องหย่อนจดหมาย (ขอบบนสว่าง = ฝาพับ) + บานเปิดเก็บจดหมายด้านล่างมีมือจับทองเหลือง */
  fill(g, 3, 7, 8, 1, mix(C.red, C.orange, 0.5));
  fill(g, 3, 8, 8, 1, C.ink);
  frame(g, 3, 10, 8, 4, mix(C.red, C.plum, 0.45));
  fill(g, 4, 10, 6, 1, mix(C.red, C.plum, 0.7)); // ขอบบนของบานเป็นร่องเงา
  dot(g, 9, 12, C.yellow);
  if (full) {
    /* ซองจดหมาย (กว้างกว่าสูง มีรอยพับ V) โผล่พ้นช่อง + แสตมป์แดง */
    fill(g, 2, 4, 9, 5, C.ink);
    fill(g, 3, 5, 7, 3, C.white);
    dot(g, 4, 5, C.silver);
    dot(g, 5, 6, C.silver);
    dot(g, 6, 6, C.silver);
    dot(g, 7, 5, C.silver);
    dot(g, 8, 5, C.red);
    /* ธงเหลืองยกตั้ง = "มีจดหมายรออยู่" */
    fill(g, 13, 2, 3, 4, C.ink);
    fill(g, 14, 3, 2, 2, C.yellow);
    fill(g, 13, 6, 1, 6, C.ink);
    fill(g, 12, 10, 2, 2, C.ink);
  } else {
    /* ธงพับลงแนบข้างตู้ */
    fill(g, 12, 10, 4, 3, C.ink);
    fill(g, 13, 11, 2, 1, C.yellow);
  }
}

const BOOK_COLORS = [C.red, C.blue, C.green, C.yellow, C.purple, C.teal, C.orange, C.sky, C.plum, C.lime, C.slate, C.white];

/** สันหนังสือหนึ่งแถว (สุ่มแบบกำหนดตายตัวจาก seed ⇒ ชั้นหนังสือหน้าตาเดิมทุกครั้ง) */
function paintBookRow(g, x0, x1, yBottom, maxH, seed) {
  const rnd = mulberry32(seed);
  let x = x0;
  let last = null;
  while (x < x1) {
    const bw = rnd() < 0.3 ? 3 : 2;
    if (x + bw > x1) break;
    const bh = Math.max(4, maxH - Math.floor(rnd() * 4));
    let col = BOOK_COLORS[Math.floor(rnd() * BOOK_COLORS.length)];
    if (col === last) col = BOOK_COLORS[(BOOK_COLORS.indexOf(col) + 3) % BOOK_COLORS.length];
    last = col;
    const top = yBottom - bh;
    fill(g, x, top, bw, bh, col);
    fill(g, x + bw - 1, top, 1, bh, shade(col, -0.35));
    fill(g, x, top, bw - 1, 1, shade(col, 0.35));
    const band = rnd();
    if (band < 0.45) fill(g, x, top + 2, bw - 1, 1, col === C.yellow ? C.woodDark : C.yellow);
    else if (band < 0.7) fill(g, x, yBottom - 3, bw - 1, 1, shade(col, 0.5));
    x += bw;
    if (rnd() < 0.1) x += 1; // ช่องว่างระหว่างเล่ม — ชั้นจริงไม่เคยแน่นเป๊ะ
  }
  return x;
}

/** ชั้นหนังสือ 32×40: ตู้ไม้ 3 ชั้น หนังสือหลากสี + เล่มเอียง + กองนอน + กระบองเพชรจิ๋ว */
function paintBookshelf(g) {
  fill(g, 0, 0, 32, 40, C.ink);
  /* ด้านบนตู้ (มองจากบน = สว่างสุด) */
  fill(g, 1, 1, 30, 3, C.woodLight);
  fill(g, 1, 1, 30, 1, mix(C.woodLight, C.yellow, 0.3));
  fill(g, 1, 4, 30, 2, C.wood);
  /* ข้างตู้ */
  fill(g, 1, 6, 2, 30, C.wood);
  fill(g, 1, 6, 1, 30, mix(C.wood, C.woodLight, 0.5));
  fill(g, 29, 6, 2, 30, C.woodDark);
  /* แผ่นหลังตู้ (เงาลึก) */
  fill(g, 3, 6, 26, 30, C.woodDeep);
  const shelves = [
    [6, 15],
    [17, 26],
    [28, 35],
  ];
  shelves.forEach(([top, bottom], i) => {
    fill(g, 3, top, 26, 1, mix(C.woodDeep, C.ink, 0.4)); // เงาใต้แผ่นชั้นบน
    const h = bottom - top;
    if (i === 0) {
      const end = paintBookRow(g, 4, 25, bottom, h - 1, hash32("shelf-0"));
      /* เล่มสุดท้ายเอียงพิงแถว — ให้ชั้นดูมีคนหยิบใช้จริง */
      for (let k = 0; k < h - 2; k++) fill(g, Math.min(end, 26) + Math.floor(k / 3), bottom - 1 - k, 2, 1, k === h - 3 ? shade(C.red, 0.3) : C.red);
    } else if (i === 1) {
      paintBookRow(g, 3, 20, bottom, h - 1, hash32("shelf-1"));
      /* กองหนังสือนอน 3 เล่ม */
      const stack = [C.blue, C.yellow, C.green];
      stack.forEach((col, k) => {
        const sy = bottom - 2 - k * 2;
        fill(g, 21 + (k % 2), sy, 7 - (k % 2), 2, col);
        fill(g, 21 + (k % 2), sy, 7 - (k % 2), 1, shade(col, 0.3));
        dot(g, 27, sy + 1, C.white);
      });
    } else {
      paintBookRow(g, 3, 23, bottom, h - 1, hash32("shelf-2"));
      /* กระบองเพชรในกระถาง */
      fill(g, 24, bottom - 3, 4, 3, C.orange);
      fill(g, 24, bottom - 3, 4, 1, mix(C.orange, C.yellow, 0.5));
      fill(g, 25, bottom - 7, 2, 4, C.green);
      dot(g, 25, bottom - 7, C.lime);
      dot(g, 24, bottom - 6, C.green);
      dot(g, 27, bottom - 5, C.green);
    }
    /* แผ่นชั้น: ขอบบนสว่าง (เห็นผิวบนนิดหนึ่งจากมุมเฉียง) + หน้าไม้ */
    if (i < 2) {
      fill(g, 1, bottom, 30, 1, C.woodLight);
      fill(g, 1, bottom + 1, 30, 1, C.wood);
    }
  });
  /* ฐานตู้ */
  fill(g, 1, 35, 30, 1, C.woodLight);
  fill(g, 1, 36, 30, 3, C.woodDark);
  fill(g, 3, 37, 26, 1, C.woodDeep);
}

/** ตู้เอกสารโลหะ 2 ตู้ 32×28 ลิ้นชัก 3 ชั้น มีมือจับ+ป้ายชื่อ · open = ลิ้นชักบนซ้ายถูกดึงออกมีแฟ้ม/กระดาษ */
function paintCabinet(g, v) {
  const open = v === "open";
  const body = mix(C.silver, C.slate, 0.25);
  for (const cx of [0, 16]) {
    fill(g, cx, 4, 16, 24, C.ink);
    /* ด้านบนตู้ */
    fill(g, cx + 1, 5, 14, 2, mix(C.silver, C.white, 0.45));
    fill(g, cx + 1, 7, 14, 1, C.silver);
    fill(g, cx + 1, 8, 14, 17, body);
    fill(g, cx + 14, 8, 1, 17, C.slate);
    for (let d = 0; d < 3; d++) paintDrawer(g, cx + 2, 9 + d * 5, cx === 0 ? C.white : mix(C.yellow, C.white, 0.4));
    fill(g, cx + 1, 25, 14, 2, C.charcoal);
    fill(g, cx + 1, 27, 14, 1, C.ink);
  }
  /* ของบนตู้: ถาดเอกสาร (ซ้าย) · แก้วปากกา (ขวา) */
  fill(g, 3, 2, 9, 3, C.ink);
  fill(g, 4, 2, 7, 1, C.white);
  fill(g, 4, 3, 7, 1, C.charcoal);
  fill(g, 5, 1, 5, 1, mix(C.white, C.silver, 0.3));
  fill(g, 25, 1, 4, 4, C.ink);
  fill(g, 26, 2, 2, 2, C.teal);
  dot(g, 25, 0, C.red);
  dot(g, 27, 0, C.yellow);
  if (!open) return;
  /* ลิ้นชักบนของตู้ซ้ายถูกดึงออกมาหาผู้ดู: เห็นแฟ้มในลิ้นชักจากด้านบน แล้วหน้าลิ้นชักเลื่อนลงมาทับชั้นถัดไป */
  fill(g, 1, 7, 14, 7, C.ink);
  fill(g, 2, 8, 12, 5, C.charcoal);
  const folders = [C.yellow, C.white, C.sky, C.white, C.yellow, C.orange];
  folders.forEach((col, k) => {
    const fx = 2 + k * 2;
    fill(g, fx, 8, 1, 5, col);
    dot(g, fx, 7 - (k % 2), col); // แถบป้ายแฟ้มโผล่
  });
  /* กระดาษโผล่พ้นลิ้นชัก */
  fill(g, 6, 4, 4, 4, C.white);
  fill(g, 7, 5, 2, 1, C.slate);
  fill(g, 6, 7, 4, 1, C.silver);
  /* หน้าลิ้นชักที่ดึงออก + เงาทับลิ้นชักล่าง */
  fill(g, 0, 13, 16, 7, C.ink);
  fill(g, 1, 13, 14, 1, C.silver);
  fill(g, 1, 14, 14, 5, body);
  paintDrawer(g, 2, 14, C.white);
  fill(g, 1, 20, 14, 1, "rgba(26,28,44,0.45)");
}

function paintDrawer(g, x, y, label) {
  fill(g, x, y, 12, 4, mix(C.silver, C.white, 0.15));
  fill(g, x, y + 3, 12, 1, C.slate);
  fill(g, x + 11, y, 1, 4, C.slate);
  fill(g, x + 4, y, 4, 2, label);
  dot(g, x + 5, y + 1, C.charcoal);
  dot(g, x + 6, y + 1, C.charcoal);
  fill(g, x + 3, y + 2, 6, 1, C.ink); // มือจับ
  fill(g, x + 3, y + 2, 1, 1, C.charcoal);
}

/**
 * เทอร์มินัล 32×36: ตู้แร็กเซิร์ฟเวอร์ (ซ้าย) + คอนโซลจอเขียว (ขวา)
 * active เฟรม 0/1 = ตัวอักษรเลื่อน + ไฟแร็กสลับกะพริบ (world สลับเฟรมให้ ~2 ครั้ง/วินาที)
 * error = จอแดง ไฟแร็กแดง — คำสั่งพัง อ่านออกได้จากไกล ๆ แม้ไม่อ่าน caption
 */
function paintTerminal(g, v, f) {
  const err = v === "error";
  const act = v === "active";
  floorShadow(g, 1, 35, 30);
  /* ── ตู้แร็ก ── */
  fill(g, 0, 0, 15, 35, C.ink);
  fill(g, 1, 1, 13, 2, C.slate);
  fill(g, 1, 1, 13, 1, C.silver);
  fill(g, 1, 3, 13, 30, C.charcoal);
  for (let u = 0; u < 7; u++) {
    const y = 4 + u * 4;
    fill(g, 2, y, 11, 3, mix(C.charcoal, C.ink, 0.55));
    fill(g, 2, y, 11, 1, mix(C.charcoal, C.slate, 0.35));
    fill(g, 3, y + 2, 5, 1, C.ink); // ช่องระบายอากาศ
    for (let k = 0; k < 2; k++) {
      let col;
      if (err) col = (u + k) % 3 === 0 ? C.orange : C.red;
      else if (act) {
        const on = (hash32(`led${u}:${k}`) + f * (k + 1)) % 2 === 0;
        col = on ? (k === 0 ? C.lime : u % 3 === 1 ? C.yellow : C.cyan) : mix(C.green, C.ink, 0.5);
      } else col = k === 0 ? mix(C.green, C.ink, 0.25) : mix(C.green, C.ink, 0.6);
      dot(g, 9 + k * 2, y + 1, col);
    }
  }
  fill(g, 1, 33, 13, 1, C.slate);
  fill(g, 2, 34, 2, 1, C.charcoal);
  fill(g, 11, 34, 2, 1, C.charcoal);
  /* ── คอนโซล: โต๊ะโลหะ + คีย์บอร์ด + จอ CRT ── */
  fill(g, 15, 20, 17, 15, C.ink);
  fill(g, 16, 21, 15, 2, C.silver);
  fill(g, 16, 23, 15, 1, C.slate);
  fill(g, 16, 24, 15, 10, C.charcoal);
  fill(g, 17, 26, 13, 1, C.slate);
  fill(g, 22, 28, 3, 1, C.silver); // มือจับตู้ใต้คอนโซล
  fill(g, 16, 34, 15, 1, C.ink);
  /* คีย์บอร์ด */
  fill(g, 17, 20, 13, 2, C.ink);
  for (let k = 0; k < 6; k++) dot(g, 18 + k * 2, 20, C.silver);
  fill(g, 18, 21, 11, 1, C.slate);
  /* จอ CRT (ตัวเรือนเทาอ่อน) */
  fill(g, 16, 2, 15, 17, C.ink);
  fill(g, 17, 3, 13, 15, mix(C.silver, C.white, 0.2));
  fill(g, 29, 4, 1, 14, C.silver);
  fill(g, 17, 17, 13, 1, C.silver);
  fill(g, 21, 18, 5, 2, C.slate);
  fill(g, 21, 18, 5, 1, C.charcoal);
  dot(g, 28, 16, err ? C.red : act ? C.lime : C.green); // ไฟจอ
  const sx = 18;
  const sy = 4;
  const sw = 11;
  const sh = 11;
  fill(g, sx - 1, sy - 1, sw + 2, sh + 2, C.ink);
  if (err) {
    fill(g, sx, sy, sw, sh, C.red);
    fill(g, sx, sy, sw, 1, mix(C.red, C.orange, 0.5));
    /* กากบาทใหญ่ + ขีดข้อความ error */
    for (let k = 0; k < 5; k++) {
      dot(g, sx + 3 + k, sy + 2 + k, C.white);
      dot(g, sx + 7 - k, sy + 2 + k, C.white);
    }
    fill(g, sx + 1, sy + 8, 9, 1, C.yellow);
    fill(g, sx + 1, sy + 9, 5, 1, mix(C.red, C.white, 0.4));
    return;
  }
  const scr = mix(C.ink, C.teal, 0.28);
  fill(g, sx, sy, sw, sh, scr);
  fill(g, sx, sy, sw, 1, mix(scr, C.teal, 0.4)); // แสงสะท้อนขอบบนจอ
  if (!act) {
    /* ว่าง: พรอมต์ ">" + เคอร์เซอร์ค้าง */
    dot(g, sx + 1, sy + 2, C.green);
    dot(g, sx + 2, sy + 3, C.green);
    dot(g, sx + 1, sy + 4, C.green);
    fill(g, sx + 4, sy + 3, 2, 2, mix(C.green, scr, 0.3));
    return;
  }
  /* กำลังรัน: บรรทัดข้อความเลื่อนขึ้นทีละบรรทัดระหว่างสองเฟรม */
  const lens = [7, 4, 9, 5, 8, 3, 6, 9];
  for (let li = 0; li < 5; li++) {
    const len = lens[(li + f) % lens.length];
    const ly = sy + 1 + li * 2;
    const col = li === 4 ? C.lime : li % 2 ? C.green : mix(C.green, C.lime, 0.5);
    fill(g, sx + 1, ly, Math.min(len, sw - 2), 1, col);
  }
  if (f === 0) fill(g, sx + 1 + lens[(4 + f) % lens.length], sy + 9, 1, 1, C.white);
}

/**
 * คีออสก์เว็บ 32×30: เคาน์เตอร์ไม้ + ลูกโลกตั้งโต๊ะ (ซ้าย) + จอเว็บ (ขวา)
 * active = จอสว่างเป็นหน้าเว็บขาว (มีคนกำลังค้นเว็บจริง) · idle = จอหรี่เป็นสีน้ำเงินมืด
 */
function paintKiosk(g, v) {
  const act = v === "active";
  floorShadow(g, 1, 29, 30);
  /* เคาน์เตอร์ */
  fill(g, 0, 17, 32, 12, C.ink);
  fill(g, 1, 18, 30, 2, C.woodLight);
  fill(g, 1, 20, 30, 1, C.wood);
  fill(g, 1, 21, 30, 7, C.woodDark);
  fill(g, 1, 23, 30, 1, act ? C.sky : mix(C.sky, C.woodDark, 0.5)); // แถบสีฟ้า = มุม "เว็บ"
  fill(g, 3, 25, 26, 1, C.woodDeep);
  fill(g, 1, 28, 30, 1, C.ink);
  /* ลูกโลก: ทะเลฟ้า แผ่นดินเขียว วงแหวนทองเหลือง ฐานไม้ */
  const globe = ["..####..", ".#oogo#.", "#oggooo#", "#ooggoo#", "#goooog#", "#oogoog#", ".#oggo#.", "..####.."];
  paintMap(g, globe, { "#": C.ink, o: C.blue, g: C.green }, 2, 6);
  dot(g, 4, 7, C.sky);
  dot(g, 3, 8, C.sky);
  dot(g, 5, 9, C.lime);
  fill(g, 10, 7, 1, 6, C.yellow); // วงแหวนเส้นแวงทองเหลือง
  dot(g, 9, 6, C.yellow);
  dot(g, 9, 13, C.yellow);
  fill(g, 5, 14, 2, 2, C.yellow);
  fill(g, 3, 16, 7, 2, C.ink);
  fill(g, 4, 16, 5, 1, C.woodDark);
  /* จอเว็บบนขาตั้ง */
  fill(g, 13, 1, 18, 14, C.ink);
  fill(g, 14, 2, 16, 12, C.charcoal);
  fill(g, 20, 15, 4, 2, C.slate);
  fill(g, 18, 17, 8, 1, C.charcoal);
  const x = 15;
  const y = 3;
  if (!act) {
    fill(g, x, y, 14, 10, mix(C.navy, C.ink, 0.35));
    fill(g, x, y, 14, 2, mix(C.charcoal, C.ink, 0.3));
    fill(g, x + 2, y + 4, 6, 1, mix(C.navy, C.slate, 0.4));
    fill(g, x + 2, y + 6, 9, 1, mix(C.navy, C.slate, 0.3));
    dot(g, x + 12, y + 8, mix(C.sky, C.navy, 0.5)); // ไฟสแตนด์บาย
    return;
  }
  fill(g, x, y, 14, 10, C.white);
  /* แถบเบราว์เซอร์: ปุ่มสามสี + ช่อง URL */
  fill(g, x, y, 14, 2, C.silver);
  dot(g, x + 1, y, C.red);
  dot(g, x + 2, y, C.yellow);
  dot(g, x + 3, y, C.green);
  fill(g, x + 5, y, 8, 1, C.white);
  /* หัวเว็บ + รูป + ข้อความ + ช่องค้นหา */
  fill(g, x, y + 2, 14, 2, C.sky);
  fill(g, x + 1, y + 2, 4, 1, C.white);
  fill(g, x + 1, y + 5, 4, 4, C.orange);
  fill(g, x + 1, y + 7, 4, 2, C.green);
  dot(g, x + 3, y + 5, C.yellow);
  fill(g, x + 6, y + 5, 7, 1, C.charcoal);
  fill(g, x + 6, y + 7, 6, 1, C.slate);
  fill(g, x + 6, y + 8, 7, 1, C.slate);
  fill(g, x + 6, y + 9, 4, 1, C.blue);
}

/**
 * กล่องเครื่องมือ 16×32: แผงเจาะรู (pegboard) บนผนังแขวนประแจ ค้อน ไขควง ปลั๊กพร้อมสาย
 * + กล่องเครื่องมือแดงบนพื้น — ปลั๊กต้องเห็นชัด เพราะ mcp__* (ปลั๊กอิน) มาใช้สถานีนี้ด้วย
 */
function paintToolbox(g) {
  const board = mix(C.woodLight, C.yellow, 0.3);
  box(g, 0, 0, 16, 19, board, mix(board, C.white, 0.35), mix(board, C.wood, 0.45));
  for (let y = 2; y < 18; y += 3) for (let x = 2; x < 15; x += 3) dot(g, x, y, mix(board, C.woodDark, 0.5));
  /* เครื่องมือทุกชิ้นมีขอบหมึก — บนแผงสีอ่อน เหล็กสีเงินจะจมหายถ้าไม่มีขอบ */
  const L = { k: C.ink, s: C.silver, S: C.slate, b: board, w: C.woodLight, W: C.wood, r: C.red, R: C.plum, o: C.orange, y: C.yellow, Y: C.orange, c: C.charcoal };
  /* ประแจปากตาย (บน) + ห่วง (ล่าง) */
  paintMap(g, [".k.k.", "ksksk", "ksssk", ".ksk.", ".ksk.", ".ksk.", ".ksk.", "ksssk", "ksbSk", "ksSSk", ".kkk."], L, 1, 1);
  /* ค้อน: หัวเหล็กขวาง + ด้ามไม้ */
  paintMap(g, ["kkkkk", "ksssk", "kSSSk", ".kwk.", ".kwk.", ".kwk.", ".kWk.", ".kWk.", ".kWk.", ".kkk."], L, 6, 1);
  /* ไขควงด้ามแดง */
  paintMap(g, [".kkk.", "korrk", "krrRk", "krrRk", "krrRk", ".kkk.", ".ksk.", ".ksk.", ".kSk.", ".kSk.", "..k.."], L, 10, 1);
  /* ปลั๊กไฟสีเหลือง (ขาเหล็กชี้ขึ้น) + สายไฟขดแขวนตะขอ */
  paintMap(g, [".s.s.", ".s.s.", "kkkkk", "kyyyk", "kyyYk", "kkkkk"], L, 1, 12);
  const cable = [
    [5, 15],
    [6, 16],
    [7, 16],
    [8, 15],
  ];
  for (const [x, y] of cable) dot(g, x, y, C.charcoal);
  paintMap(g, [".ccc.", "c...c", "c...c", "c...c", ".ccc."], L, 8, 13);
  dot(g, 10, 12, C.silver); // ตะขอแขวน
  /* กล่องเครื่องมือแดงบนพื้น */
  floorShadow(g, 0, 31, 16);
  fill(g, 5, 19, 6, 2, C.ink);
  fill(g, 6, 20, 4, 1, C.charcoal);
  fill(g, 0, 21, 16, 10, C.ink);
  fill(g, 1, 22, 14, 3, mix(C.red, C.orange, 0.35));
  fill(g, 1, 22, 14, 1, C.orange);
  fill(g, 1, 25, 14, 1, C.plum);
  fill(g, 1, 26, 14, 4, C.red);
  fill(g, 14, 26, 1, 4, C.plum);
  fill(g, 7, 24, 2, 3, C.silver);
  dot(g, 7, 24, C.white);
}

/** เครื่องพิมพ์ 16×20 บนรถเข็นเล็ก · active = กระดาษรายงานกำลังเลื่อนออกจากช่องบน + ไฟเขียวสว่าง */
function paintPrinter(g, v) {
  const act = v === "active";
  floorShadow(g, 1, 19, 14);
  /* รถเข็น: ท็อป + ขา + ชั้นล่างมีรีมกระดาษ */
  fill(g, 1, 11, 14, 2, C.ink);
  fill(g, 2, 11, 12, 1, C.slate);
  fill(g, 2, 13, 2, 5, C.charcoal);
  fill(g, 12, 13, 2, 5, C.charcoal);
  fill(g, 2, 16, 12, 1, C.charcoal);
  fill(g, 5, 14, 6, 2, C.white);
  fill(g, 5, 15, 6, 1, C.silver);
  fill(g, 2, 18, 2, 1, C.ink);
  fill(g, 12, 18, 2, 1, C.ink);
  /* ตัวเครื่อง */
  fill(g, 1, 3, 14, 9, C.ink);
  fill(g, 2, 4, 12, 3, mix(C.white, C.silver, 0.25));
  fill(g, 2, 4, 12, 1, C.white);
  fill(g, 4, 5, 8, 1, C.charcoal); // ช่องกระดาษออก
  fill(g, 2, 7, 12, 4, C.silver);
  fill(g, 2, 10, 12, 1, C.slate);
  fill(g, 3, 8, 3, 1, mix(C.teal, C.cyan, act ? 0.8 : 0.2)); // จอเล็ก
  dot(g, 12, 8, act ? C.lime : mix(C.green, C.ink, 0.35));
  fill(g, 7, 9, 5, 1, C.charcoal); // ถาดกระดาษเข้า
  if (act) {
    /* แผ่นรายงานโผล่พ้นช่อง มีกราฟแท่งเล็ก ๆ */
    fill(g, 4, 0, 8, 6, C.ink);
    fill(g, 5, 0, 6, 5, C.white);
    fill(g, 5, 1, 4, 1, C.slate);
    dot(g, 6, 3, C.blue);
    fill(g, 7, 2, 1, 2, C.green);
    fill(g, 9, 3, 1, 1, C.orange);
  }
}

/**
 * เครื่องชงกาแฟ 16×28 บนตู้ไม้: เครื่องดริปมีโถแก้วกาแฟสีน้ำตาล + แก้วมัคสองใบบนเครื่อง
 * (โถกาแฟอ่านออกว่า "กาแฟ" ได้ทันที — เครื่องเอสเปรสโซกล่องดำตัวเล็กดูเหมือนจอคอมพิวเตอร์)
 */
function paintCoffee(g) {
  floorShadow(g, 1, 27, 14);
  /* ตู้ไม้ */
  fill(g, 0, 14, 16, 13, C.ink);
  fill(g, 1, 15, 14, 2, C.woodLight);
  fill(g, 1, 17, 14, 9, C.wood);
  fill(g, 2, 18, 12, 7, C.woodDark);
  fill(g, 3, 19, 10, 5, C.wood);
  fill(g, 3, 19, 10, 1, mix(C.wood, C.woodLight, 0.4));
  dot(g, 11, 21, C.yellow); // ปุ่มตู้
  fill(g, 1, 26, 14, 1, C.woodDeep);
  /* ตัวเครื่อง: ฝาบน · หัวดริป (ไฟแดง/เขียว) · เสาหลังขวา · ช่องวางโถ */
  fill(g, 2, 4, 12, 13, C.ink);
  fill(g, 3, 5, 10, 1, C.silver);
  fill(g, 3, 6, 10, 1, C.slate);
  fill(g, 3, 7, 10, 3, C.red);
  fill(g, 3, 7, 10, 1, mix(C.red, C.orange, 0.5));
  fill(g, 3, 9, 10, 1, C.plum);
  dot(g, 11, 8, C.lime);
  dot(g, 5, 10, C.slate); // ปากดริป
  fill(g, 3, 10, 7, 6, mix(C.ink, C.charcoal, 0.5));
  fill(g, 10, 10, 3, 6, C.charcoal);
  fill(g, 10, 10, 1, 6, C.slate);
  /* โถแก้ว: ฝาดำ · แก้วใสขอบเงิน · กาแฟครึ่งโถ · หูจับ */
  fill(g, 4, 11, 5, 1, C.charcoal);
  fill(g, 4, 12, 1, 4, C.silver);
  fill(g, 8, 12, 1, 4, C.silver);
  fill(g, 5, 12, 3, 1, mix(C.silver, C.charcoal, 0.4));
  fill(g, 5, 13, 3, 3, C.woodDeep);
  fill(g, 5, 13, 3, 1, C.wood);
  dot(g, 5, 12, C.white);
  fill(g, 9, 12, 1, 3, C.ink);
  /* แก้วมัคสองใบวางบนเครื่อง */
  for (const [mx, band] of [
    [3, C.white],
    [8, C.yellow],
  ]) {
    fill(g, mx, 1, 4, 4, C.ink);
    fill(g, mx + 1, 1, 2, 3, band);
    fill(g, mx + 1, 1, 2, 1, mix(band, C.white, 0.5));
    dot(g, mx + 3, 2, C.ink);
    dot(g, mx + 4, 2, C.ink);
  }
}

/**
 * บูธ "ถามคุณ" 16×26: แท่นไม้มีเครื่องหมาย ? · โทรศัพท์แดง · กระดิ่งทองเหลือง
 * ringing เฟรม 0/1 = หูโทรศัพท์กระดก + เส้นสั่นสลับข้าง (agent กำลังรอคำตอบจากผู้ใช้)
 */
function paintPhone(g, v, f) {
  const ring = v === "ringing";
  floorShadow(g, 1, 25, 14);
  /* แท่น */
  fill(g, 1, 12, 14, 13, C.ink);
  fill(g, 2, 13, 12, 2, C.woodLight);
  fill(g, 2, 15, 12, 9, C.wood);
  fill(g, 13, 15, 1, 9, C.woodDark);
  fill(g, 2, 23, 12, 1, C.woodDeep);
  /* เครื่องหมาย ? สีเหลืองบนป้ายวงกลม */
  fill(g, 5, 16, 6, 7, C.navy);
  dot(g, 5, 16, C.wood);
  dot(g, 10, 16, C.wood);
  dot(g, 5, 22, C.wood);
  dot(g, 10, 22, C.wood);
  paintMap(g, [".##.", "#..#", "..#.", ".#..", "....", ".#.."], { "#": C.yellow }, 6, 16);
  /* กระดิ่ง (ขวา) */
  fill(g, 10, 11, 5, 2, C.charcoal);
  fill(g, 11, 8, 3, 3, C.yellow);
  fill(g, 10, 10, 5, 1, C.orange);
  dot(g, 11, 8, mix(C.yellow, C.white, 0.5));
  dot(g, 12, 7, C.ink);
  /* โทรศัพท์ (ซ้าย): ตัวเครื่องแดงทรงคางหมู + หน้าปัดหมุนสีขาว */
  const P = { k: C.ink, r: C.red, o: mix(C.red, C.orange, 0.5), R: C.plum, w: C.white, s: C.silver };
  paintMap(g, [".kkkkkkk.", "koooooook", "krrwwwrRk", "krwsksrRk", "krrwwwrRk", "kkkkkkkkk"], P, 1, 8);
  /* หูโทรศัพท์วางบนแท่นรับ (ปลายสองข้างงุ้มลง) · ตอนดัง: เฟรม 0 ยกทั้งอัน · เฟรม 1 เอียงซ้ายขึ้น */
  const lift = ring ? (f === 0 ? 2 : 1) : 0;
  const hy = 5 - lift;
  if (ring && f === 1) {
    paintMap(g, ["kkk......", "kook.....", "krRkkkkk.", ".kkkoooRk", "....kkrRk", "......kk."], P, 1, hy - 1);
  } else {
    paintMap(g, [".kkkkkkk.", "koooooook", "krRkkkrRk", "kkk...kkk"], P, 1, hy);
  }
  if (!ring) return;
  /* เส้นสั่น: เฟรม 0 ฝั่งซ้าย-บนกระดิ่ง · เฟรม 1 ฝั่งขวา-บนโทรศัพท์ */
  const hum = mix(C.yellow, C.white, 0.4);
  if (f === 0) {
    fill(g, 0, 3, 1, 3, hum);
    dot(g, 1, 2, hum);
    fill(g, 12, 3, 1, 3, hum);
    dot(g, 14, 4, hum);
    dot(g, 10, 4, hum);
  } else {
    fill(g, 15, 5, 1, 3, hum);
    dot(g, 14, 4, hum);
    fill(g, 5, 1, 1, 2, hum);
    dot(g, 3, 2, hum);
    dot(g, 8, 2, hum);
  }
}

/* ใบไม้วงรี — ต้นไม้ประกอบจากใบรีหลายใบ วาดจากหลังมาหน้า (ขอบหมึกรอบนอกทีเดียวก่อน) */
function ellipseRows(g, cx, cy, rx, ry, c) {
  for (let dy = -ry; dy <= ry; dy++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry + 0.5))));
    fill(g, cx - half, cy + dy, half * 2 + 1, 1, c);
  }
}

/** กระถางต้นไม้ 16×26: "0" ใบใหญ่พุ่มกลมในกระถางดินเผา · "1" ลิ้นมังกรใบตั้งในกระถางเซรามิกขาว */
function paintPlant(g, v) {
  floorShadow(g, 3, 25, 10);
  if (v === "1") {
    /* ใบลิ้นมังกร: [x, ยอด, กว้าง] */
    const blades = [
      [3, 7, 2],
      [5, 2, 2],
      [7, 5, 2],
      [9, 0, 2],
      [11, 4, 2],
    ];
    for (const [x, top, w] of blades) fill(g, x - 1, top - 1, w + 2, 20 - top, C.ink);
    for (const [x, top, w] of blades) {
      fill(g, x, top, w, 19 - top, C.green);
      fill(g, x, top + 1, 1, 18 - top, C.lime);
      dot(g, x + w - 1, top, C.ink);
      for (let y = top + 3; y < 18; y += 3) dot(g, x + w - 1, y, C.teal);
      for (let y = top + 4; y < 18; y += 4) dot(g, x, y, mix(C.lime, C.yellow, 0.5));
    }
    /* กระถางเซรามิกขาว แถบน้ำเงิน */
    fill(g, 3, 17, 10, 8, C.ink);
    fill(g, 4, 17, 8, 1, C.woodDeep);
    fill(g, 4, 18, 8, 6, C.white);
    fill(g, 10, 18, 2, 6, C.silver);
    fill(g, 4, 20, 8, 2, C.blue);
    fill(g, 10, 20, 2, 2, C.navy);
    fill(g, 4, 24, 8, 1, C.slate);
    return;
  }
  /* พุ่มใบใหญ่: ใบหลัง (เขียวเข้ม) → ใบหน้า (เขียวสด + ไฮไลต์) */
  const leaves = [
    [4, 8, 3, 2, C.teal],
    [11, 6, 3, 2, C.teal],
    [8, 3, 2, 3, C.teal],
    [3, 12, 3, 2, C.green],
    [12, 11, 3, 2, C.green],
    [8, 8, 3, 3, C.green],
    [6, 14, 3, 2, C.green],
    [10, 14, 3, 2, C.green],
  ];
  for (const [cx, cy, rx, ry] of leaves) ellipseRows(g, cx, cy, rx + 1, ry + 1, C.ink);
  for (const [cx, cy, rx, ry, c] of leaves) {
    ellipseRows(g, cx, cy, rx, ry, c);
    fill(g, cx - rx + 1, cy + ry, rx * 2 - 1, 1, shade(c, -0.3)); // ขอบล่างใบเข้ม ⇒ ใบซ้อนกันแยกออก
    if (c === C.green) {
      dot(g, cx - 1, cy - ry + 1, C.lime);
      dot(g, cx, cy - ry + 1, C.lime);
      fill(g, cx, cy, 1, ry, mix(C.green, C.teal, 0.5)); // เส้นกลางใบ
    }
  }
  /* ก้านลงกระถาง */
  fill(g, 7, 15, 2, 3, C.teal);
  /* กระถางดินเผา */
  fill(g, 2, 16, 12, 3, C.ink);
  fill(g, 3, 17, 10, 1, mix(C.orange, C.yellow, 0.35));
  fill(g, 4, 16, 8, 1, C.woodDeep);
  fill(g, 3, 19, 10, 6, C.ink);
  fill(g, 4, 19, 8, 5, C.orange);
  fill(g, 10, 19, 2, 5, mix(C.orange, C.red, 0.5));
  fill(g, 4, 19, 8, 1, mix(C.orange, C.red, 0.35));
  fill(g, 5, 24, 6, 1, C.ink);
}

/* ───────────────────────── โต๊ะ / เก้าอี้ / มุมพัก ───────────────────────── */

/*
 * เรขาคณิตของการนั่ง (ต้องตรงกับ world.js): เก้าอี้ (วาดก่อน) < คนนั่ง < โต๊ะ (วาดทีหลัง)
 * โต๊ะสูง 24 px โดย 8 px บนสุดล้ำขึ้นไปในแถวที่นั่ง ⇒ ฝาหลังแล็ปท็อปบังได้แค่อก/ตักของคนนั่ง
 * หัวคนนั่ง (สูงกว่าขอบบน sprite โต๊ะ) จึงไม่เคยโดนบัง — ห้ามวาดอะไรสูงเกินขอบบนนี้
 */
const GLOW = { on: C.cyan, error: C.red };

/** ฝาหลังแล็ปท็อปที่หันหาผู้ดู (จอหันไปทางคนนั่ง) + แสงจอเล็ดลอดขอบฝาเมื่อเปิดใช้งาน */
function paintLaptopBack(g, x, y, w, h, v) {
  const glow = GLOW[v] || null;
  if (glow) {
    /* แสงจอลอดขอบบนฝา + ส่องโต๊ะข้างฐานเครื่อง — "จอเปิดอยู่" โดยไม่ต้องเห็นหน้าจอ */
    fill(g, x + 1, y - 1, w - 2, 1, glow);
    fill(g, x - 1, y + h - 1, 1, 2, mix(glow, C.woodLight, 0.55));
    fill(g, x + w, y + h - 1, 1, 2, mix(glow, C.woodLight, 0.55));
  }
  fill(g, x, y, w, h, C.ink);
  fill(g, x + 1, y + 1, w - 2, h - 2, glow ? C.silver : mix(C.silver, C.slate, 0.4));
  fill(g, x + 1, y + 1, w - 2, 1, glow ? mix(C.silver, C.white, 0.5) : C.silver);
  fill(g, x + w - 2, y + 2, 1, h - 3, C.slate);
  /* โลโก้กลางฝา: เรืองตามสถานะ (เห็นได้แม้ตัวละครบังขอบ) */
  const cx = x + Math.floor(w / 2) - 1;
  const cy = y + Math.floor(h / 2) - 1;
  if (v === "error" && w >= 10 && h >= 8) {
    /* พัง: กากบาทแดง 6×6 แทนโลโก้ (ภาษาเดียวกับจอเทอร์มินัลพัง — อ่านออกจากด้านหลังเครื่อง) */
    for (let i = 0; i < 6; i++) {
      dot(g, cx - 2 + i, cy - 2 + i, C.red);
      dot(g, cx + 3 - i, cy - 2 + i, C.red);
    }
    fill(g, cx, cy, 2, 2, C.orange);
  } else {
    fill(g, cx, cy, 2, 2, glow ? mix(glow, C.white, 0.35) : C.slate);
  }
  fill(g, x, y + h, w, 1, C.charcoal); // ขอบฐานเครื่อง
}

/** แก้วกาแฟเล็กบนโต๊ะ */
function paintMug(g, x, y, band) {
  fill(g, x, y, 4, 4, C.ink);
  fill(g, x + 1, y, 2, 1, C.woodDeep);
  fill(g, x + 1, y + 1, 2, 2, C.white);
  fill(g, x + 1, y + 2, 2, 1, band);
  fill(g, x + 4, y + 1, 1, 2, C.ink);
}

/** โต๊ะผู้ช่วย 32×24: ไม้ท็อปสว่าง · ขาโต๊ะ · แผ่นบังขา · แล็ปท็อปหันหลังให้ผู้ดู + ของจุกจิก */
function paintDesk(g, v) {
  floorShadow(g, 1, 23, 30);
  /* ขาโต๊ะ + แผ่นบังขา (ถอยลึกเข้าไป = เข้มกว่า) */
  fill(g, 1, 12, 30, 11, C.ink);
  fill(g, 4, 14, 24, 6, C.woodDeep);
  fill(g, 4, 14, 24, 1, mix(C.woodDeep, C.ink, 0.4));
  fill(g, 6, 16, 20, 1, mix(C.woodDeep, C.woodDark, 0.5));
  g.clearRect(4, 20, 24, 3); // ช่องใต้แผ่นบังขาโปร่ง เห็นพื้น (โต๊ะไม่ใช่กล่องทึบ)
  fill(g, 4, 20, 24, 1, C.ink);
  for (const lx of [2, 28]) {
    fill(g, lx, 12, 2, 10, C.wood);
    fill(g, lx, 12, 1, 10, C.woodLight);
  }
  /* ท็อปโต๊ะ: ผิวบน (สว่าง) + สันหน้า */
  fill(g, 0, 6, 32, 8, C.ink);
  fill(g, 1, 7, 30, 4, C.woodLight);
  fill(g, 1, 7, 30, 1, mix(C.woodLight, C.yellow, 0.25));
  fill(g, 1, 11, 30, 2, C.wood);
  fill(g, 1, 12, 30, 1, C.woodDark);
  /* ลิ้นชักเล็กที่สันหน้า */
  fill(g, 22, 12, 6, 1, C.woodDeep);
  /* ของบนโต๊ะ: แก้วกาแฟ (ซ้าย) · กองกระดาษ + ปากกา (ขวา) · โพสต์อิท */
  paintMug(g, 3, 5, C.red);
  fill(g, 24, 8, 6, 3, C.ink);
  fill(g, 24, 8, 5, 2, C.white);
  fill(g, 25, 9, 5, 1, C.silver);
  fill(g, 25, 7, 4, 1, mix(C.white, C.silver, 0.3));
  fill(g, 23, 10, 4, 1, C.blue);
  fill(g, 3, 10, 3, 1, C.yellow);
  dot(g, 5, 10, C.orange);
  paintLaptopBack(g, 9, 0, 14, 9, v);
}

/** เก้าอี้สำนักงาน 16×18 (วาดก่อนคนนั่ง ⇒ พนักพิงโผล่ข้างไหล่/หลังหัว) */
function paintChair(g) {
  floorShadow(g, 2, 17, 12);
  /* ขาห้าแฉก + ล้อ */
  fill(g, 2, 15, 12, 1, C.ink);
  fill(g, 7, 12, 2, 4, C.slate);
  fill(g, 7, 12, 1, 4, C.silver);
  dot(g, 2, 16, C.charcoal);
  dot(g, 7, 16, C.charcoal);
  dot(g, 13, 16, C.charcoal);
  /* เบาะนั่ง + ที่วางแขน */
  fill(g, 1, 9, 14, 4, C.ink);
  fill(g, 2, 10, 12, 1, C.slate);
  fill(g, 2, 11, 12, 1, C.charcoal);
  fill(g, 0, 7, 2, 4, C.ink);
  fill(g, 14, 7, 2, 4, C.ink);
  dot(g, 0, 7, C.charcoal);
  dot(g, 15, 7, C.charcoal);
  /* พนักพิง: ผ้าน้ำเงินเข้มในกรอบดำ มีช่องบุนูนตรงกลาง */
  rbox(g, 2, 0, 12, 10, C.navy);
  fill(g, 3, 1, 10, 1, mix(C.navy, C.sky, 0.35));
  fill(g, 4, 3, 8, 5, mix(C.navy, C.blue, 0.4));
  fill(g, 4, 3, 8, 1, mix(C.navy, C.sky, 0.3));
  fill(g, 12, 2, 1, 7, mix(C.navy, C.ink, 0.4));
}

/**
 * โต๊ะหัวหน้า 48×26: โต๊ะผู้บริหารสองตู้ลิ้นชัก · ป้ายชื่อทองเหลือง · โคมไฟตั้งโต๊ะ · แก้ว · แล็ปท็อป + จอที่สอง
 * จอที่สองอยู่ขวาและเตี้ย (ขอบบนไม่เกิน sprite) ⇒ ไม่บังหัวหัวหน้าที่นั่งอยู่กลางโต๊ะ
 */
function paintLeadDesk(g, v, f = 0) {
  const glow = GLOW[v] || null;
  /*
   * ติดด่าน (error): หัวหน้าฟุบอยู่หลังแล็ปท็อป เห็นแค่ผม — โต๊ะต้อง "ตะโกน" แทน: โคมไฟกลายเป็นไฟเตือนแดง
   * กะพริบ (เฟรม 0 สว่าง / 1 หรี่) ส่องแดงทั่วท็อปโต๊ะ + กากบาทแดงบนฝาแล็ปท็อป (ภาษาเดียวกับเทอร์มินัลพัง)
   */
  const alarm = v === "error";
  const lit = alarm && (Math.floor(Number(f)) || 0) % 2 === 0;
  floorShadow(g, 1, 25, 46);
  /* ตัวโต๊ะ: ตู้ซ้าย-ขวา + แผ่นบังขาลึกตรงกลาง */
  fill(g, 0, 13, 48, 12, C.ink);
  fill(g, 14, 16, 20, 7, C.woodDeep);
  fill(g, 16, 18, 16, 3, mix(C.woodDeep, C.woodDark, 0.45));
  for (const px of [1, 34]) {
    fill(g, px, 15, 13, 9, C.wood);
    fill(g, px, 15, 1, 9, C.woodLight);
    fill(g, px + 12, 15, 1, 9, C.woodDark);
    for (let d = 0; d < 2; d++) {
      const dy = 16 + d * 4;
      fill(g, px + 2, dy, 9, 3, mix(C.wood, C.woodLight, 0.25));
      fill(g, px + 2, dy + 2, 9, 1, C.woodDark);
      fill(g, px + 5, dy + 1, 3, 1, C.yellow); // มือจับทองเหลือง
    }
  }
  fill(g, 1, 24, 46, 1, C.woodDeep);
  /* ท็อปโต๊ะ */
  fill(g, 0, 8, 48, 7, C.ink);
  fill(g, 1, 9, 46, 3, C.woodLight);
  fill(g, 1, 9, 46, 1, mix(C.woodLight, C.yellow, 0.3));
  fill(g, 1, 12, 46, 2, C.wood);
  fill(g, 1, 14, 46, 1, C.woodDark);
  /* ป้ายชื่อทองเหลืองบนสันหน้า */
  fill(g, 18, 12, 12, 3, C.ink);
  fill(g, 19, 12, 10, 2, C.yellow);
  fill(g, 19, 13, 10, 1, C.orange);
  for (let k = 0; k < 4; k++) fill(g, 20 + k * 2, 12, 1, 1, C.woodDeep);
  /* โคมไฟตั้งโต๊ะ (โป๊ะเขียว) + แสงอุ่นบนท็อป · ติดด่าน = ไฟเตือนแดงกะพริบ */
  if (lit) {
    /* แสงแดงเลียขอบท็อปทั้งแผ่น — เห็นได้แม้ตัวละครบังกลางโต๊ะ */
    fill(g, 1, 9, 46, 1, mix(C.woodLight, C.red, 0.55));
    fill(g, 2, 10, 12, 1, mix(C.woodLight, C.red, 0.35));
  }
  fill(g, 2, 9, 9, 2, alarm ? mix(C.woodLight, lit ? C.red : C.plum, 0.5) : mix(C.woodLight, C.yellow, 0.45));
  fill(g, 5, 4, 1, 6, alarm ? C.orange : C.yellow);
  fill(g, 3, 10, 5, 1, C.woodDeep);
  fill(g, 1, 1, 8, 4, C.ink);
  fill(g, 2, 1, 6, 2, alarm ? (lit ? C.red : C.plum) : C.green);
  fill(g, 2, 1, 6, 1, alarm ? (lit ? C.orange : C.red) : C.lime);
  fill(g, 2, 3, 6, 1, alarm ? (lit ? C.yellow : C.orange) : C.yellow);
  if (lit) {
    /* ประกายไฟเตือนสองข้างโป๊ะ */
    dot(g, 0, 1, C.orange);
    dot(g, 9, 1, C.orange);
    dot(g, 0, 3, C.red);
    dot(g, 9, 3, C.red);
  }
  /* แก้วประจำตัวหัวหน้า (แถบสีม่วง) */
  paintMug(g, 10, 6, C.purple);
  /* แล็ปท็อปกลางโต๊ะ + จอที่สองด้านขวา (ด้านหลังจอหันหาผู้ดูเช่นกัน) */
  paintLaptopBack(g, 17, 1, 14, 9, v);
  if (glow) fill(g, 34, 2, 11, 1, glow);
  fill(g, 34, 3, 11, 7, C.ink);
  fill(g, 35, 4, 9, 5, C.charcoal);
  fill(g, 35, 4, 9, 1, C.slate);
  dot(g, 39, 6, C.slate);
  fill(g, 38, 10, 3, 1, C.ink);
  fill(g, 36, 11, 7, 1, C.charcoal);
  /* ถาดเอกสารเล็กข้างจอ */
  fill(g, 42, 11, 5, 2, C.white);
  fill(g, 42, 12, 5, 1, C.silver);
}

/** เก้าอี้หัวหน้า 16×22: พนักพิงสูงหนังแดงเข้ม บุดุม — สูงกว่าเก้าอี้ผู้ช่วยให้มองหาหัวหน้าเจอเร็ว */
function paintLeadChair(g) {
  floorShadow(g, 2, 21, 12);
  fill(g, 2, 19, 12, 1, C.ink);
  fill(g, 7, 16, 2, 4, C.slate);
  fill(g, 7, 16, 1, 4, C.silver);
  dot(g, 2, 20, C.charcoal);
  dot(g, 7, 20, C.charcoal);
  dot(g, 13, 20, C.charcoal);
  fill(g, 1, 13, 14, 4, C.ink);
  fill(g, 2, 14, 12, 1, C.red);
  fill(g, 2, 15, 12, 1, C.plum);
  fill(g, 0, 10, 2, 5, C.ink);
  fill(g, 14, 10, 2, 5, C.ink);
  fill(g, 0, 10, 2, 1, C.woodDark);
  fill(g, 14, 10, 2, 1, C.woodDark);
  /* พนักพิงสูง + หมอนรองหัว */
  rbox(g, 2, 0, 12, 14, C.red);
  fill(g, 3, 1, 10, 1, mix(C.red, C.orange, 0.5));
  fill(g, 12, 2, 1, 11, C.plum);
  fill(g, 3, 4, 10, 1, C.plum);
  for (const [bx, by] of [
    [5, 7],
    [10, 7],
    [7, 10],
    [5, 12],
    [10, 12],
  ])
    dot(g, bx, by, C.plum);
  dot(g, 7, 7, mix(C.red, C.orange, 0.4));
}

/** โซฟา 48×26 สามที่นั่ง สีเขียวหัวเป็ด + หมอนอิงส้ม (หัวหน้ามานอนงีบตรงนี้ตอนว่างนาน) */
function paintCouch(g) {
  const body = C.teal;
  const hi = mix(C.teal, C.cyan, 0.35);
  const lo = mix(C.teal, C.ink, 0.4);
  floorShadow(g, 2, 25, 44);
  /* ขาไม้ */
  fill(g, 4, 23, 2, 2, C.woodDark);
  fill(g, 42, 23, 2, 2, C.woodDark);
  /* พนักพิง: เบาะหลังสามลูก */
  fill(g, 3, 0, 42, 14, C.ink);
  g.clearRect(3, 0, 1, 1); // มุมมนของพนักพิง
  g.clearRect(44, 0, 1, 1);
  for (let k = 0; k < 3; k++) {
    const x = 4 + k * 14;
    fill(g, x, 1, 12, 12, body);
    fill(g, x + 1, 1, 10, 1, hi);
    fill(g, x, 2, 1, 10, hi);
    fill(g, x + 11, 2, 1, 11, lo);
    if (k < 2) fill(g, x + 12, 1, 2, 12, lo);
  }
  /* เบาะนั่งสามลูก: ผิวบนสว่าง + หน้าเบาะ */
  fill(g, 4, 12, 40, 7, C.ink);
  for (let k = 0; k < 3; k++) {
    const x = 5 + k * 13;
    fill(g, x, 13, 12, 3, hi);
    fill(g, x, 13, 12, 1, mix(hi, C.white, 0.2));
    fill(g, x, 16, 12, 2, body);
    fill(g, x + 12, 13, 1, 5, lo);
  }
  /* ฐานโซฟา */
  fill(g, 3, 18, 42, 5, C.ink);
  fill(g, 4, 19, 40, 3, lo);
  fill(g, 4, 19, 40, 1, body);
  /* ที่วางแขนสองข้าง (บนสว่าง หน้าเข้ม) */
  for (const ax of [0, 42]) {
    fill(g, ax, 6, 6, 17, C.ink);
    fill(g, ax + 1, 7, 4, 3, hi);
    fill(g, ax + 1, 7, 4, 1, mix(hi, C.white, 0.25));
    fill(g, ax + 1, 10, 4, 12, body);
    fill(g, ax + (ax ? 4 : 1), 10, 1, 12, lo);
  }
  /* หมอนอิงส้มมุมซ้าย */
  fill(g, 6, 6, 8, 8, C.ink);
  fill(g, 7, 7, 6, 6, C.orange);
  fill(g, 7, 7, 6, 1, C.yellow);
  fill(g, 12, 8, 1, 5, C.red);
  dot(g, 9, 9, C.yellow);
  dot(g, 10, 10, C.red);
}

/** พรม 64×48 (ชั้นพื้น ใต้ทุกอย่าง): ลายพรมเปอร์เซีย — ขอบม่วง · แถบน้ำเงินลายจุด · ผืนแดงมีเหรียญตรงกลาง + พู่สองข้าง */
function paintRug(g) {
  /* พู่ปลายพรมซ้าย-ขวา */
  for (let y = 1; y < 47; y += 2) {
    fill(g, 0, y, 2, 1, C.white);
    fill(g, 62, y, 2, 1, C.white);
  }
  fill(g, 2, 0, 60, 48, C.plum);
  frame(g, 2, 0, 60, 48, mix(C.plum, C.ink, 0.4));
  fill(g, 5, 3, 54, 42, C.navy);
  for (let x = 7; x < 58; x += 4) {
    dot(g, x, 4, C.yellow);
    dot(g, x + 2, 43, C.yellow);
  }
  for (let y = 6; y < 43; y += 4) {
    dot(g, 6, y, C.yellow);
    dot(g, 57, y + 2, C.yellow);
  }
  fill(g, 8, 6, 48, 36, C.red);
  frame(g, 8, 6, 48, 36, C.orange);
  /* ลายจุดเล็กทั่วผืน */
  for (let y = 9; y < 40; y += 5) for (let x = 11 + ((y / 5) % 2) * 3; x < 54; x += 6) dot(g, x, y, mix(C.red, C.plum, 0.6));
  /* เหรียญกลาง (ข้าวหลามตัดซ้อนชั้น) — คำนวณระยะแบบ |dx|/rx + |dy|/ry แล้วเลือกสีตามชั้น */
  const cx = 31.5;
  const cy = 23.5;
  const rings = [
    [1.0, C.orange],
    [0.8, C.navy],
    [0.62, C.yellow],
    [0.45, C.plum],
    [0.25, C.orange],
    [0.1, C.yellow],
  ];
  for (let y = 10; y < 38; y++) {
    for (let x = 14; x < 50; x++) {
      const d = Math.abs(x - cx) / 17 + Math.abs(y - cy) / 13;
      let col = null;
      for (const [r, c] of rings) if (d <= r) col = c;
      if (col) dot(g, x, y, col);
    }
  }
  /* ลายมุมผืน */
  for (const [mx, my] of [
    [12, 10],
    [51, 10],
    [12, 37],
    [51, 37],
  ]) {
    fill(g, mx - 1, my, 3, 1, C.yellow);
    fill(g, mx, my - 1, 1, 3, C.yellow);
    dot(g, mx, my, C.navy);
  }
}
