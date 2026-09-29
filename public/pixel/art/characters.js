/*
 * art/characters.js — ตัวละครพิกเซลของ PIXEL OFFICE (หัวหน้า = main agent · ผู้ช่วย = sub-agent)
 *
 * โจทย์ของผู้ใช้คือ "ตัวละครเดิมเดินไปมาทำงาน" ⇒ หน้าตาต้องคงที่ตลอดชีวิตของ agent:
 *   - สีผิว / สีผม / ทรงผม มาจาก hash32(id)      → agent ตัวเดิมหน้าเดิมทุกครั้งที่เปิดแท็บ
 *   - สีเสื้อ มาจาก modelTag (MODEL_SHIRT)         → มองปราดเดียวรู้ว่าเป็น haiku/sonnet/opus/fable
 *   - ของแต่งหัวของผู้ช่วย มาจาก hash32(type)     → ผู้ช่วยชนิดเดียวกัน (เช่น Explore) แต่งตัวเหมือนกัน
 *   - หัวหน้าผูกเนกไท + ใส่เฮดเซ็ต               → รู้ทันทีว่าใครคุมห้อง
 *
 * ทำไมประกอบจาก "ชั้น" (ลำตัว · ขา · แขนตามท่า · หัว+หน้า · ผมตามทรง · ของแต่ง · ของในมือ)
 * แทนการวาดทีละเฟรม: มี 22 ท่า × 4 ทิศ × หลายเฟรม × 6 ทรงผม × ของแต่ง 6 แบบ — วาดมือทุกช่องเป็นหมื่นภาพ
 * และแก้ทรงผมทีเดียวต้องไล่แก้ทุกท่า ชั้นที่ใช้ร่วมกันทำให้ทุกท่า "เป็นคนคนเดียวกัน" เสมอ
 *
 * ขั้นตอนประกอบหนึ่งเฟรม (ใน buffer 16×24 ของสี ก่อนลง canvas):
 *   1) ชั้นที่อยู่หลังตัว (ผมยาวหลังไหล่ · แขนข้างไกล · ของที่ถือไว้ด้านหลัง)
 *   2) ขา → ลำตัว → แขน → หัว → หน้า → ผม → ของแต่ง → มือที่อยู่หน้าหน้า
 *   3) ตีเส้นขอบรอบ "เงา" ของทั้งตัวทีเดียว (สี ink 1 px แบบ 4 ทิศ ⇒ มุมมน ดูน่ารักกว่าแบบ 8 ทิศ)
 *      — ตีทีเดียวทั้งตัวแทนที่จะวาดขอบไว้ในแต่ละชิ้น เพราะชิ้นที่ต่อกัน (แขนกับลำตัว) จะได้ไม่มีเส้นดำคั่นกลาง
 *   4) ของในมือ + มือที่จับของ วาดทีหลังพร้อมขอบของตัวเอง (ของต้องแยกออกจากเสื้อให้เห็นชัด)
 *   5) ทิศขวา = กระจกของทิศซ้ายทั้งเฟรม
 *
 * หน่วยความจำ: หนึ่ง "หน้าตา" = atlas หนึ่งชุด (อบเฟรมเมื่อถูกขอครั้งแรกเท่านั้น) อยู่ใน LRU เพดาน 400
 * ตอนพายุงาน 240 ตัว หน้าตาที่ซ้ำกัน (สีผิว/ผม/ทรง/เสื้อ/ของแต่งเหมือนกันหมด) ใช้ atlas ร่วมกันด้วย
 *
 * พิกัดในเฟรม: จุดยึด (8, 23) = กึ่งกลางใต้เท้า สำหรับท่ายืน/เดิน
 *   ท่านั่งใช้จุดยึดเดียวกันแต่หมายถึง "จุดที่ก้นแตะที่นั่ง": world วางคนนั่งที่ y = แถวที่นั่ง×16 + 15
 *   และโต๊ะด้านหน้าสูงเข้ามาในแถวที่นั่ง 8 px ⇒ ในเฟรม แถว 16 ลงไปถูกโต๊ะบัง เหลือหัว + ไหล่ + มือบนคีย์บอร์ด
 *   ร่างท่อนบนของท่านั่งจึงอยู่ระดับเดียวกับท่ายืน (ตักอยู่ใต้ขอบโต๊ะพอดี) ส่วนบนโซฟาไม่มีโต๊ะบัง
 *   จึงวาดขาห้อยครบทุกท่านั่ง
 */

import { PALETTE, MODEL_SHIRT, hash32, pickBy, shade, mix, createAtlas, createLru } from "./base.js";

const FW = 16;
const FH = 24;
const AX = 8;
const AY = 23;

/* ───────────────────────── ตารางท่าทาง (ต้องตรงกับ POSE_FRAMES ใน world.js) ───────────────────────── */

const ALL4 = Object.freeze(["down", "up", "left", "right"]);
const DOWN = Object.freeze(["down"]);
const UP = Object.freeze(["up"]);
const DLR = Object.freeze(["down", "left", "right"]);
/* fps ตรงกับ world.js (WALK_FPS 8 · POSE_FPS 2.5) — world เป็นคนเดินเฟรมจริง ค่านี้ไว้ให้ผู้เรียกอื่นอ้างอิง */
const WALK_FPS = 8;
const POSE_FPS = 2.5;

function poseDef(frames, dirs, seated = false, fps = POSE_FPS) {
  return Object.freeze({ frames, fps, dirs, seated });
}

const POSES = Object.freeze({
  stand: poseDef(2, ALL4),
  walk: poseDef(4, ALL4, false, WALK_FPS),
  "sit-type": poseDef(2, DOWN, true),
  "sit-think": poseDef(2, DOWN, true),
  "sit-idle": poseDef(2, DOWN, true),
  "sit-slump": poseDef(1, DOWN, true),
  "sit-sleep": poseDef(2, DOWN, true),
  sip: poseDef(2, DOWN),
  read: poseDef(2, UP),
  reach: poseDef(2, UP),
  "type-stand": poseDef(2, UP),
  "write-board": poseDef(2, UP),
  "think-stand": poseDef(2, DOWN),
  "raise-hand": poseDef(2, DOWN),
  phone: poseDef(2, DOWN),
  supervise: poseDef(2, DLR),
  celebrate: poseDef(2, DOWN),
  sad: poseDef(2, DOWN),
  oops: poseDef(1, DOWN),
  wave: poseDef(2, DOWN),
  "read-letter": poseDef(2, DOWN),
  give: poseDef(1, ALL4),
});

/** หน้าเริ่มต้นของแต่ละท่า (world ส่ง face มาเองอยู่แล้ว — ตารางนี้กันกรณีผู้เรียกไม่ส่ง) */
const DEFAULT_FACE = Object.freeze({
  celebrate: "happy",
  wave: "happy",
  sad: "sad",
  "sit-slump": "sad",
  "sit-sleep": "sleep",
  oops: "surprised",
  "think-stand": "think",
  "sit-think": "think",
});
const FACES = new Set(["normal", "happy", "sad", "sleep", "talk", "surprised", "think"]);

/** ของที่ท่านั้น "ถือเป็นปกติ" — opts.item ส่งมาเมื่อไหร่ก็แทนที่ของชิ้นนี้ (เช่น give + paper) */
const POSE_ITEM = Object.freeze({
  sip: "mug",
  read: "book",
  supervise: "clipboard",
  "read-letter": "letter",
  give: "paper",
});
const ITEMS = new Set(["paper", "letter", "mug", "book", "clipboard"]);

/* ───────────────────────── หน้าตา (Look) ───────────────────────── */

/* [สีหลัก, สีเงา] — ผิวสี่โทนจากพาเลตกลาง (สีเงาของผิวอ่อนคือผิวถัดไป ⇒ ทั้งห้องดูเป็นชุดเดียวกัน) */
const SKINS = Object.freeze([
  [PALETTE.skin1, PALETTE.skin1s],
  [PALETTE.skin2, PALETTE.skin2s],
  [PALETTE.skin3, PALETTE.skin3s],
  [PALETTE.skin4, PALETTE.skin4s],
]);

/*
 * สีผม 8 แบบ — "ดำ" ใช้ charcoal ไม่ใช่ ink เพราะ ink คือสีเส้นขอบ ผมดำสนิทจะกลืนกับขอบจนทรงผมหาย
 * สีเงาได้จาก shade()/mix() ของพาเลตกลาง ไม่เพิ่ม hex ใหม่ลอย ๆ
 */
const HAIRS = Object.freeze([
  [PALETTE.charcoal, shade(PALETTE.charcoal, -0.4)],
  [PALETTE.woodDeep, shade(PALETTE.woodDeep, -0.35)],
  [PALETTE.wood, PALETTE.woodDark],
  [PALETTE.woodLight, PALETTE.wood],
  [PALETTE.yellow, mix(PALETTE.yellow, PALETTE.orange, 0.5)],
  [PALETTE.orange, PALETTE.red],
  [PALETTE.silver, PALETTE.slate],
  [PALETTE.plum, shade(PALETTE.plum, -0.35)],
]);

/* ทรงผม 6 แบบ — เลือกให้ "เงา" ต่างกันจริง (ตั้งแหลม / ยาวประบ่า / จุกสองข้าง / หางม้าข้าง / บ๊อบกลม) */
const HAIR_STYLES = Object.freeze(["short", "spiky", "long", "buns", "ponytail", "bob"]);

/* กางเกงโทนเข้มเสมอ — เสื้อคือสัญญาณหลัก (สีโมเดล) กางเกงจึงต้องไม่แย่งสายตา */
const PANTS = Object.freeze([
  [PALETTE.charcoal, shade(PALETTE.charcoal, -0.35)],
  [PALETTE.navy, shade(PALETTE.navy, -0.35)],
  [PALETTE.slate, PALETTE.charcoal],
  [PALETTE.woodDark, PALETTE.woodDeep],
]);

const ACCESSORIES = Object.freeze(["glasses", "cap", "headphones", "beanie", "none"]);
const ACC_COLORS = Object.freeze([
  [PALETTE.red, shade(PALETTE.red, -0.3)],
  [PALETTE.teal, shade(PALETTE.teal, -0.35)],
  [PALETTE.blue, PALETTE.navy],
  [PALETTE.orange, PALETTE.red],
  [PALETTE.green, PALETTE.teal],
  [PALETTE.yellow, mix(PALETTE.yellow, PALETTE.orange, 0.5)],
]);

/*
 * กรอบแว่นมีชุดสีของตัวเอง: สีของแต่งทั่วไป (ส้ม/เหลือง) ใกล้ผิวจนกรอบกลืนเป็นรอยเปื้อน
 * ส่วนสีดำล้วนก็ติดกับตา (ink) จนกลายเป็นแว่นกันแดด — จึงใช้โทนเข้มกลาง ๆ ที่ตัดกับผิวทุกโทน
 */
const GLASS_FRAMES = Object.freeze([PALETTE.red, PALETTE.teal, PALETTE.navy, PALETTE.plum, PALETTE.blue]);

const LOOK_BRAND = "pixel-look/1";
/* lookFor ถูกเรียกบ่อย (ทุกครั้งที่ scene สร้าง/อัปเดตตัวละคร) — จำผลไว้ ไม่ต้อง hash ซ้ำ */
const lookMemo = createLru(1200);

/*
 * hash32 (FNV-1a) ผสมบิตล่างได้ไม่ดี: สตริงที่ต่างกันแค่ท้าย ("#skin" กับ "#hair") ได้บิตล่างที่สัมพันธ์กัน
 * ⇒ `% 4` กับ `% 8` ขยับไปด้วยกัน (ผิวคล้ำได้ผมเทาทุกคน) — ผ่าน finalizer ของ murmur3 ก่อนหารเอาเศษ
 */
function hashOf(s) {
  let h = hash32(s);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function normTag(tag) {
  const t = typeof tag === "string" ? tag.toUpperCase() : "";
  return Object.prototype.hasOwnProperty.call(MODEL_SHIRT, t) ? t : "";
}

/**
 * หน้าตาของ agent — ค่าเดิมเสมอสำหรับอินพุตเดิม (ไม่มีสุ่ม)
 * @param {{id?: string, role?: string, modelTag?: string, type?: string}} src
 */
export function lookFor(src = {}) {
  const s = src && typeof src === "object" ? src : {};
  const id = s.id == null ? "" : String(s.id);
  const role = s.role === "lead" ? "lead" : "helper";
  const modelTag = normTag(s.modelTag);
  const type = s.type == null ? "" : String(s.type);
  const memoKey = `${role}\u0001${modelTag}\u0001${type}\u0001${id}`;
  const hit = lookMemo.get(memoKey);
  if (hit) return hit;

  /* แยก hash ต่อคุณสมบัติ (เติม salt) — ถ้าใช้ hash เดียว % หลายค่า สีผิวกับสีผมจะผูกกันเป็นคู่ตายตัว */
  const hs = hashOf(`${id}#skin`);
  const hh = hashOf(`${id}#hair`);
  const hy = hashOf(`${id}#style`);
  const hp = hashOf(`${id}#pants`);
  const ht = hashOf(`type:${type}`);
  const shirt = MODEL_SHIRT[modelTag] || MODEL_SHIRT[""];
  const skinIdx = hs % SKINS.length;
  /* ผมสีเดียวกับเสื้อ (ผมส้มกับเสื้อ FA) ทำให้หัวกับตัวเป็นก้อนเดียว — เลื่อนไปสีถัดไป (ยังคงที่ต่อ id) */
  let hairIdx = hh % HAIRS.length;
  for (let i = 0; i < HAIRS.length && (HAIRS[hairIdx][0] === shirt[0] || HAIRS[hairIdx][0] === shirt[2]); i++) {
    hairIdx = (hairIdx + 1) % HAIRS.length;
  }
  const style = pickBy(HAIR_STYLES, hy);
  const pantsIdx = hp % PANTS.length;
  /* หัวหน้าไม่ใส่ของแต่งหัวแบบผู้ช่วย — มีเฮดเซ็ต + เนกไทเป็นเครื่องหมายเฉพาะแทน */
  const accessory = role === "lead" ? "headset" : pickBy(ACCESSORIES, ht);
  const accIdx = (ht >>> 8) % ACC_COLORS.length;
  /* เนกไทสีแดง ยกเว้นเสื้อส้ม (FA) ที่แดงจะกลืน → ใช้กรมท่า */
  const tie = modelTag === "FA" ? [PALETTE.navy, shade(PALETTE.navy, -0.35)] : [PALETTE.red, shade(PALETTE.red, -0.3)];

  const look = Object.freeze({
    brand: LOOK_BRAND,
    id,
    role,
    modelTag,
    type,
    style,
    accessory,
    skin: SKINS[skinIdx],
    hair: HAIRS[hairIdx],
    shirt,
    pants: PANTS[pantsIdx],
    acc: ACC_COLORS[accIdx],
    frame: GLASS_FRAMES[(ht >>> 16) % GLASS_FRAMES.length],
    tie,
    /* หน้าตาที่เหมือนกันทุกชั้นได้ key เดียวกัน ⇒ ใช้ atlas ร่วมกัน (ประหยัด canvas ตอนพายุงาน) */
    key: [
      role,
      modelTag,
      skinIdx,
      hairIdx,
      style,
      pantsIdx,
      accessory,
      accIdx, // สีของแต่งใช้กับยางรัดผมด้วย (จุก/หางม้า) — หัวหน้าก็ต้องแยกตามค่านี้
      accessory === "glasses" ? (ht >>> 16) % GLASS_FRAMES.length : 0,
    ].join("|"),
  });
  lookMemo.set(memoKey, look);
  return look;
}

/** สีของแต่ละตัวอักษรในแผนที่พิกเซล สำหรับหน้าตาหนึ่ง ๆ (ตัวอักษรเดียวกันใช้ได้ทุกชั้นทุกท่า) */
function paletteOf(look) {
  const ink = PALETTE.ink;
  return {
    k: ink,
    S: look.skin[0],
    s: look.skin[1],
    H: look.hair[0],
    h: look.hair[1],
    C: look.shirt[0],
    c: look.shirt[1],
    L: look.shirt[2],
    P: look.pants[0],
    p: look.pants[1],
    F: PALETTE.woodDeep,
    T: look.tie[0],
    t: look.tie[1],
    A: look.acc[0],
    a: look.acc[1],
    g: look.frame,
    B: PALETTE.blush,
    M: shade(PALETTE.red, -0.2),
    W: PALETTE.white,
    w: PALETTE.silver,
    G: PALETTE.cyan,
    R: PALETTE.red,
    Y: PALETTE.yellow,
    O: PALETTE.orange,
    N: PALETTE.wood,
    n: PALETTE.woodDark,
    D: PALETTE.charcoal,
    d: PALETTE.slate,
    U: PALETTE.blue,
    u: PALETTE.navy,
    Q: PALETTE.sky,
  };
}

/* ───────────────────────── buffer ประกอบภาพ 16×24 ───────────────────────── */

/*
 * ประกอบใน array ของสีก่อน แล้วค่อยลง canvas ทีเดียว เพราะต้อง "ตีเส้นขอบรอบทั้งตัว" และ "สะท้อนซ้าย-ขวา"
 * ซึ่งทำบน array ได้ตรง ๆ แต่บน canvas ต้องอ่าน getImageData กลับมา (ช้าและทำให้ canvas ช้าทั้งใบ)
 */
function makeBuf() {
  return new Array(FW * FH).fill(null);
}

const warnedChars = new Set();

/**
 * วางแผนที่พิกเซลลง buffer — "." = โปร่ง, "_" = ลบพิกเซลเดิมทิ้ง (เจาะช่อง เช่น ช่องระหว่างขา)
 * @param {Array<string|null>} buf
 * @param {string[]} rows
 * @param {Record<string,string>} pal
 */
function paint(buf, rows, pal, x0 = 0, y0 = 0) {
  if (!rows) return;
  for (let r = 0; r < rows.length; r++) {
    const y = y0 + r;
    if (y < 0 || y >= FH) continue;
    const row = rows[r];
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === "." || ch === " ") continue;
      const x = x0 + i;
      if (x < 0 || x >= FW) continue;
      if (ch === "_") {
        buf[y * FW + x] = null;
        continue;
      }
      const col = pal[ch];
      if (col === undefined) {
        if (!warnedChars.has(ch)) {
          warnedChars.add(ch);
          console.warn(`[pixel/characters] ตัวอักษร "${ch}" ไม่มีในพาเลต — ข้าม`);
        }
        continue;
      }
      if (col) buf[y * FW + x] = col;
    }
  }
}

function filledAt(buf, x, y) {
  return x >= 0 && x < FW && y >= 0 && y < FH && buf[y * FW + x] != null;
}

/** ขอบ 4 ทิศรอบทุกพิกเซลที่มีสี (เติมเฉพาะช่องว่าง) */
function outline(buf, color) {
  const src = buf.slice();
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      if (src[y * FW + x] != null) continue;
      if (filledAt(src, x - 1, y) || filledAt(src, x + 1, y) || filledAt(src, x, y - 1) || filledAt(src, x, y + 1)) {
        buf[y * FW + x] = color;
      }
    }
  }
}

/**
 * วางชิ้นที่ "ลอยอยู่หน้าตัว" พร้อมขอบของมันเอง (ของในมือ · มือที่ยกมาหน้าหน้า)
 * ขอบทับพิกเซลเดิมได้ — ไม่งั้นแก้วกาแฟสีขาวบนเสื้อสีอ่อนจะกลืนเป็นก้อนเดียว
 */
function paintRinged(buf, rows, pal, x0, y0, ring = PALETTE.ink) {
  const tmp = makeBuf();
  paint(tmp, rows, pal, x0, y0);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const i = y * FW + x;
      if (tmp[i] != null) continue;
      if (filledAt(tmp, x - 1, y) || filledAt(tmp, x + 1, y) || filledAt(tmp, x, y - 1) || filledAt(tmp, x, y + 1)) {
        buf[i] = ring;
      }
    }
  }
  for (let i = 0; i < tmp.length; i++) if (tmp[i] != null) buf[i] = tmp[i];
}

function mirror(buf) {
  const out = makeBuf();
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) out[y * FW + (FW - 1 - x)] = buf[y * FW + x];
  return out;
}

/** ลง canvas ทีละ "ช่วงสีเดียวกันในแถว" — fillRect น้อยกว่าทีละพิกเซลหลายเท่า */
function blit(g, buf, ox, oy) {
  for (let y = 0; y < FH; y++) {
    let x = 0;
    while (x < FW) {
      const c = buf[y * FW + x];
      if (c == null) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < FW && buf[y * FW + end] === c) end++;
      g.fillStyle = c;
      g.fillRect(ox + x, oy + y, end - x, 1);
      x = end;
    }
  }
}

/* ───────────────────────── ชิ้นส่วนร่าง (พิกัดจริงในเฟรม ท่ายืน) ───────────────────────── */

/*
 * ทุกแผนที่ในส่วนนี้เขียนเป็น "พิกัดจริง" ในเฟรม 16×24 (สตริงเริ่มที่คอลัมน์ 0) — มองแล้วรู้ทันทีว่าพิกเซลอยู่ตรงไหน
 * ของเฟรม ไม่ต้องบวกลบ offset ในหัว ชิ้นที่ต้องเลื่อน (ท่อนบนยุบตอนเศร้า/กระโดด) เลื่อนตอนวาดด้วย dy
 *
 * ผังร่างท่ายืน (หันหน้า):
 *   แถว 1–12  หัว (รวมผมและเส้นขอบ) กว้าง 12 px   ← หัวโตเกือบครึ่งตัว = ทรง chibi
 *   แถว 13–17 ลำตัว (เสื้อ) กว้าง 6 + แขนข้างละ 1
 *   แถว 18–22 สะโพก · ขา · รองเท้า
 *   แถว 23    เส้นขอบใต้เท้า = จุดยึด (8, 23)
 *   แถว 0     ว่างไว้ให้ปลายผมตั้ง / มือที่ชูขึ้น
 *
 * ตัวอักษร: S/s ผิว · H/h ผม · C/c/L เสื้อ (หลัก/เงา/ไฮไลต์) · P/p กางเกง · F รองเท้า · k เส้นหมึก
 *           T/t เนกไท · A/a สีของแต่ง · B แก้มแดง · M ปาก · W ขาว · w เทาเงิน · G เลนส์/ไฟ
 */

/** ชิ้นแผนที่พร้อมตำแหน่ง — ring = วาดพร้อมขอบของตัวเอง (สำหรับของ/มือที่ลอยอยู่หน้าตัว) */
function at(x, y, rows, ring = false) {
  return { x, y, rows, ring };
}

/* ── หัว: กะโหลกเดียวกันทุกทิศ (ต่างกันที่ผม/หน้าที่วาดทับ) ── */
const HEAD = [
  "....SSSSSSSS",
  "...SSSSSSSSSS",
  "...SSSSSSSSSS",
  "...SSSSSSSSSS",
  "...SSSSSSSSSS",
  "...SSSSSSSSSS",
  "...SSSSSSSSSS",
  "...SSSSSSSSSS",
  "...sSSSSSSSSs",
  "....ssSSSSss",
]; // แถว 2–11
/* มุมข้าง: จมูกจุดเดียวยื่นพ้นหน้า — เล็กแต่ทำให้รู้ทิศที่หันแม้ซูมแค่ 2 เท่า */
const NOSE_LEFT = at(2, 8, ["S"]);

/* ── ลำตัว ── */
const TORSO = {
  down: ["....." + "LCCCCC", ".....CCCCCC", ".....CCCCCC", ".....CCCCCC", ".....cccccc"],
  up: [".....cCCCCc", ".....CCCCCC", ".....CCCCCC", ".....CCCCCC", ".....cccccc"],
  left: ["......LCCCC", "......CCCCC", "......CCCCC", "......CCCCC", "......ccccc"],
}; // แถว 13–17
/* คอเสื้อ: ผู้ช่วยคอวีโชว์คอ · หัวหน้าคอปกขาว + เนกไท (มองจากหลังก็เห็นปกขาวโผล่) */
const COLLAR = {
  helper: { down: at(7, 13, ["SS"]), up: null, left: at(6, 13, ["S"]) },
  lead: {
    down: at(6, 13, ["WTTW", ".TT.", ".TT.", ".tt."]),
    up: at(6, 13, ["WWWW"]),
    left: at(6, 13, ["WT", ".T", ".t"]),
  },
};

/* ── ขา (แถว 18–22) ── ช่องระหว่างขาเว้นโปร่งไว้ ขอบหมึกจะเติมเป็นเงาช่องขาให้เอง */
const LEGS = {
  down: {
    stand: [".....PPPPPP", ".....Pp..Pp", ".....Pp..Pp", ".....Pp..Pp", ".....FF..FF"],
    /* เดิน: เท้าที่ก้าวถูกยกขึ้น 1 px (มองจากหน้าเห็นเป็นขาสั้นลง) */
    liftL: [".....PPPPPP", ".....Pp..Pp", ".....Pp..Pp", ".....FF..Pp", ".........FF"],
    liftR: [".....PPPPPP", ".....Pp..Pp", ".....Pp..Pp", ".....Pp..FF", ".....FF"],
    /* นั่ง: ต้นขาพุ่งเข้าหาคนดูเป็นแผงกว้าง แล้วหน้าแข้งห้อยลง (บนโซฟาเห็นเต็ม ที่โต๊ะถูกบัง) */
    sit: ["....PPPPPPPP", "....pPPPPPPp", ".....pp..pp", ".....Pp..Pp", ".....FF..FF"],
    /* กระโดด: ขาพับ ทั้งตัวลอย 2 px (วาดด้วย ly = -2) */
    tuck: [".....PPPPPP", ".....Pp..Pp", ".....FF..FF"],
    /* เขย่งหยิบของบนชั้น: ส้นยก เท้าเหลือแค่ปลาย */
    tiptoe: [".....PPPPPP", ".....Pp..Pp", ".....Pp..Pp", ".....Pp..Pp", ".....F...F"],
  },
  left: {
    stand: ["......PPPPP", ".......PPp", ".......PPp", ".......PPp", ".....FFFFF"],
    /* ก้าวยาว: ขาใกล้ (สีหลัก) กับขาไกล (สีเงา) สลับหน้า-หลัง ⇒ เฟรม 0 กับ 2 ไม่ซ้ำกัน */
    strideN: ["......PPPPP", ".....PP..pp", "....PP....pp", "....PP....pp", "...FFF....FF"],
    strideF: ["......PPPPP", ".....pp..PP", "....pp....PP", "....pp....PP", "...FFF....FF"],
    /* จังหวะขาไขว้ผ่านกัน: ขาไกลงอ ปลายเท้ายกไปด้านหลัง */
    pass: ["......PPPPP", ".......PPpp", ".......PP.pp", ".......PP.FF", "......FFF"],
  },
};
LEGS.up = {
  stand: LEGS.down.stand,
  liftL: LEGS.down.liftR, // มองจากหลัง ซ้าย-ขวาสลับกับมองจากหน้า
  liftR: LEGS.down.liftL,
  sit: LEGS.down.sit,
  tuck: LEGS.down.tuck,
  tiptoe: LEGS.down.tiptoe,
};

/* ── แขนมาตรฐาน (แถว 13–18) ── แขนเสื้อใช้สีเงาเสมอ ⇒ แยกจากลำตัวได้โดยไม่ต้องมีเส้นดำคั่น */
const ARMS = {
  down: {
    side: at(4, 13, ["c......c", "c......c", "c......c", "c......c", "S......S"]),
    /*
     * แกว่งแขนตอนเดิน: แขนที่เหวี่ยงเข้าหาคนดูดูยาวขึ้น 1 แขนที่เหวี่ยงออกดูสั้นลง 1
     * (ชื่อบอกด้านของภาพ: rightFwd = แขนฝั่งขวาของภาพยาว)
     */
    rightFwd: at(4, 13, ["c......c", "c......c", "c......c", "S......c", ".......c", ".......S"]),
    leftFwd: at(4, 13, ["c......c", "c......c", "c......c", "c......S", "c", "S"]),
  },
  left: {
    side: at(7, 13, ["cc", "cc", "cc", "cc", "SS"]),
    /* แขนแกว่งไปหน้า (ซ้าย) / หลัง (ขวา) — มือพ้นลำตัวออกไป เส้นขอบรวมจะล้อมให้เอง */
    fwd: at(4, 13, ["...cc", "..cc", ".cc", "SS"]),
    back: at(8, 13, ["cc", ".cc", "..cc", "..SS"]),
  },
};
/* มองจากหลังแขนห้อยเหมือนมองจากหน้า (ท่าเดินหันหลังเลือกชุดแกว่งเองใน RIGS.walk) */
ARMS.up = { side: ARMS.down.side };

/* ── หน้า (หันหน้า): ตาแถว 7–8 · แก้มแถว 9 · ปากแถว 10 ── */
const FACE_DOWN = {
  normal: [at(5, 7, ["k....k", "k....k"]), at(4, 9, ["B......B"]), at(7, 10, ["MM"])],
  happy: [at(4, 7, [".k....k.", "k.k..k.k"]), at(4, 9, ["B......B"]), at(6, 10, ["kMMk"])],
  sad: [at(6, 6, ["k..k"]), at(5, 7, ["k....k", "k....k"]), at(4, 9, ["Q"]), at(6, 10, [".kk.", "k..k"])],
  sleep: [at(4, 8, ["kk....kk"]), at(4, 9, ["B......B"]), at(7, 10, ["M"])],
  talk: [at(5, 7, ["k....k", "k....k"]), at(4, 9, ["B......B"]), at(7, 10, ["MM", "MM"])],
  surprised: [at(5, 6, ["k....k"]), at(4, 7, ["kk....kk", "kk....kk"]), at(7, 10, ["k", "k"])],
  think: [at(6, 6, ["k....k", "k....k"]), at(4, 9, ["B......B"]), at(8, 10, ["kk"])],
};
/* หน้า (มุมข้าง หันซ้าย): ตาเดียวที่คอลัมน์ 4 · ปากที่ขอบหน้า */
const FACE_LEFT = {
  normal: [at(4, 7, ["k", "k"]), at(5, 9, ["B"]), at(3, 10, ["M"])],
  happy: [at(3, 7, [".k.", "k.k"]), at(5, 9, ["B"]), at(3, 10, ["kM"])],
  sad: [at(5, 6, ["k"]), at(4, 7, ["k", "k"]), at(5, 9, ["Q"]), at(3, 10, ["k"])],
  sleep: [at(4, 8, ["kk"]), at(5, 9, ["B"]), at(3, 10, ["M"])],
  talk: [at(4, 7, ["k", "k"]), at(5, 9, ["B"]), at(3, 10, ["M", "M"])],
  surprised: [at(4, 6, [".k"]), at(4, 7, ["kk", "kk"]), at(3, 10, ["k", "k"])],
  think: [at(5, 6, ["k", "k"]), at(6, 9, ["B"]), at(3, 10, ["kk"])],
};

/* ───────────────────────── ทรงผม 6 แบบ × 3 มุม ───────────────────────── */

/*
 * front = วาดทับหัว (หลังวาดหน้า) · behind = วาดก่อนลำตัว (ผมยาวที่ห้อยอยู่หลังหลัง ในมุมข้าง)
 * ผมมุมหลัง (up) ปิดทั้งหัว — มองจากหลังไม่มีหน้า มีแต่ผม ทรงผมจึงต้องต่างกันพอให้รู้ว่าเป็นใครแม้หันหลัง
 * ใส่ S/s ในแผนที่ผมได้ = หู (ผิว) ที่โผล่พ้นผม
 */
const HAIR = {
  short: {
    down: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...hHHHHHHHHh",
        "...HHHHHHHHHH",
        "...HHHHHHHhHH",
        "...Hh.hHH..hH",
        "...h........h",
      ]),
    },
    up: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...hHHHHHHHHh",
        "...HHHHHHHHHH",
        "...HHHHHHHHHH",
        "...HHHHHHHHHH",
        "...SHHHHHHHHS",
        "...shHHHHHHhs",
        "...hhHHHHHHhh",
        "....hhhhhhhh",
      ]),
    },
    left: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHHHHHh",
        "...HHHHHHHHHH",
        "...hHHHHHHHHH",
        "....hh.HHHHHH",
        "........SHHHh",
        "........sHHHh",
        ".........hHhh",
        "..........hh",
      ]),
    },
  },
  spiky: {
    down: {
      front: at(0, 1, [
        "....H..H..H",
        "...HHHhHHHHHh",
        "..HHHHHHHHHHHH",
        "...HHHHHHHHHH",
        "..hHHHhHHHHhHh",
        "...Hh.h.hH.hH",
        "...h........h",
      ]),
    },
    up: {
      front: at(0, 1, [
        "....H..H..H",
        "...HHHhHHHHHh",
        "..HHHHHHHHHHHH",
        "...HHHHHHHHHH",
        "..hHHHHHHHHHHh",
        "...HHHHHHHHHH",
        "..hHHHHHHHHHHh",
        "...HHHHHHHHHH",
        "...hHHhHHhHHh",
        "...hh.hh.hhh",
      ]),
    },
    left: {
      front: at(0, 1, [
        ".....H..H..H",
        "....HHHHHHHHH",
        "...HHHHHHHHHHHH",
        "...HHHHHHHHHHh",
        "..hHHHHHHHHHHH",
        "....h.hHHHHHHh",
        "........SHHHHH",
        "........sHHHh",
        ".........hHHh",
        "..........hh",
      ]),
    },
  },
  long: {
    down: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHhHHHH",
        "..HHHHHHhHHHHH",
        "..HHHHHh.hHHHH",
        "..HHHh....hHHH",
        "..HHh......hHH",
        "..HH........HH",
        "..HH........HH",
        "..Hh........hH",
        "..Hh........hH",
        "..hH........Hh",
        "..hh........hh",
        "...h........h",
      ]),
    },
    up: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..hHHHHHHHHHHh",
        "...HHHHHHHHHH",
        "...hHHHHHHHHh",
        "....hHHHHHHh",
        ".....hHHHHh",
        "......hhhh",
      ]),
    },
    left: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHHHHHh",
        "...HHHHHHHHHHH",
        "...hHHHHHHHHHH",
        "....hHh.HHHHHH",
        ".......hHHHHHH",
        ".......hHHHHHH",
        "........HHHHHh",
        "........HHHHHh",
        "........hHHHHh",
        "........hHHHh",
      ]),
      behind: at(0, 13, [".........hHHh", "..........hHh", "...........h"]),
    },
  },
  /* จุกสองข้าง (odango) — ไม่ทำมวยกลางหัวเพราะตอนกระโดดดีใจมวยจะชนขอบบนของเฟรม */
  buns: {
    down: {
      front: at(0, 1, [
        "..H..........H",
        ".HHhhHHHHHHhhHH",
        ".HHhHHHHhHHHhHH",
        "..hAHHHHhhHHAh",
        "...HHHHh..hHHH",
        "...Hh......hH",
        "...h........h",
      ]),
    },
    up: {
      front: at(0, 1, [
        "..H..........H",
        ".HHhhHHHHHHhhHH",
        ".HHhHHHHHHHHhHH",
        "..hAHHHHHHHHAh",
        "...HHHHHHHHHH",
        "...HHHHHHHHHH",
        "...SHHHHHHHHS",
        "...shHHHHHHhs",
        "...hhHHHHHHhh",
        "....hhhhhhhh",
      ]),
    },
    left: {
      front: at(0, 1, [
        "...........HH",
        "....hHHHHHHhHH",
        "...HHHHHHHHHhH",
        "...HHHHHHHHHAh",
        "...hHHHHHHHHH",
        "....hh.HHHHHH",
        "........SHHHh",
        "........sHHHh",
        ".........hHhh",
        "..........hh",
      ]),
    },
  },
  /* หางม้าเอียงข้าง — มองจากหน้าก็เห็นหางโผล่พ้นหัวด้านขวา (หางกลางหลังจะหายไปทั้งหมดในมุมหน้า) */
  ponytail: {
    down: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHHHHHhA",
        "...HHHHHHHHHHHH",
        "...HHHHHHHhhHHH",
        "...HHHh....hHHH",
        "...Hh.......hHh",
        "...h.........Hh",
        ".............hh",
        "..............h",
      ]),
    },
    up: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHHHHHH",
        "...HHHHAAHHHH",
        "...HHHhHHhHHH",
        "...HHHhHHhHHH",
        "...SHHhHHhHHS",
        "...shHhHHhHhs",
        "...hhHhHHhHhh",
        "....hhhHHhhh",
        "......hHHh",
        "......hHHh",
        ".......hh",
      ]),
    },
    left: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHHHHHh",
        "...HHHHHHHHHAH",
        "...hHHHHHHHHHHH",
        "....hh.HHHHHHHH",
        "........SHHHhHH",
        "........sHHHhHh",
        ".........hHhhHh",
        "..........hh.h",
      ]),
    },
  },
  bob: {
    down: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HhhhhhhhhhhH",
        "..HH........HH",
        "..HH........HH",
        "..Hh........hH",
        "..hh........hh",
        "...h........h",
      ]),
    },
    up: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..HHHHHHHHHHHH",
        "..hHHHHHHHHHHh",
        "...hhhhhhhhhh",
      ]),
    },
    left: {
      front: at(0, 2, [
        "....hHHHHHHh",
        "...HHHHHHHHHH",
        "...HHHHHHHHHHH",
        "...HHHHHHHHHHH",
        "...hhhhHHHHHHH",
        ".......HHHHHHH",
        ".......HHHHHHH",
        ".......hHHHHHh",
        ".......hhHHHh",
        "........hhhh",
      ]),
    },
  },
};

/* ───────────────────────── ของแต่งหัว ───────────────────────── */

/*
 * under = วาดก่อนหน้า (แว่น: ตาต้องทับกรอบแว่น ไม่งั้นแว่นกลบตาหาย)
 * over  = วาดหลังผม (หมวก/หูฟังครอบผม)
 */
const ACCESSORY = {
  /* แว่น: แค่ขอบข้างเลนส์ + สะพานจมูก (กรอบเต็ม 3×3 ลองแล้วปิดหน้าจนดูเป็นแว่นดำน้ำ) */
  glasses: {
    down: { under: at(4, 7, ["g.gggg.g", "g.g..g.g"]) },
    up: {},
    left: { under: at(3, 7, ["g.gggg", "g.g"]) },
  },
  cap: {
    down: {
      over: at(0, 1, [
        ".....AAAAAA",
        "....AAAAAAAA",
        "...AAAAWAAAAA",
        "...aAAAAAAAAa",
        "..aaaaaaaaaaaa",
      ]),
    },
    up: {
      over: at(0, 1, [".....AAAAAA", "....AAAAAAAA", "...AAAAAAAAAA", "...AAAAAAAAAA", "...aaaWWWWaaa"]),
    },
    left: {
      over: at(0, 1, [".....AAAAAA", "....AAAAAAAA", "...AAAAAAAAAA", "...AAAAAAAAAA", ".aaaaaaAAAAAa"]),
    },
  },
  beanie: {
    down: {
      over: at(0, 0, [
        ".......WW",
        ".......WW",
        "....AAAAAAAA",
        "...AAAAAAAAAA",
        "...AAAAAAAAAA",
        "...aAaAaAaAaa",
      ]),
    },
    up: {
      over: at(0, 0, [".......WW", ".......WW", "....AAAAAAAA", "...AAAAAAAAAA", "...AAAAAAAAAA", "...aAaAaAaAaa"]),
    },
    left: {
      over: at(0, 0, ["........WW", "........WW", "....AAAAAAAA", "...AAAAAAAAAA", "...AAAAAAAAAA", "...aaAaAaAaAa"]),
    },
  },
  headphones: {
    down: {
      over: at(0, 1, [
        ".....DDDDDD",
        "....D......D",
        "...D........D",
        "...D........D",
        "..AA........AA",
        "..AA........AA",
        "..aa........aa",
      ]),
    },
    up: {
      over: at(0, 1, [
        ".....DDDDDD",
        "....D......D",
        "...D........D",
        "...D........D",
        "..AA........AA",
        "..AA........AA",
        "..aa........aa",
      ]),
    },
    left: {
      over: at(0, 1, [".....DDDDDD", "....D.....D", "..........D", "..........D", "..........D", "........AAA", ".......AAAA", ".......aAAa", "........aa"]),
    },
  },
  /*
   * เฮดเซ็ตของหัวหน้า: หูฟังข้างเดียวที่นูนพ้นขอบหัว + ก้านไมค์ยื่นมาหน้าปาก
   * ไม่วาดก้านคาดหัว — ลองแล้วเส้นเข้มบนผมสีอ่อนอ่านเป็นรอยแผล/ผมโคนดำ และไม่ใส่ไฟสีสว่างบนหน้า
   * (จุดฟ้าข้างแก้มอ่านเป็น "น้ำตา" ตอนซูม 2 เท่า)
   */
  headset: {
    down: { over: at(1, 6, ["DD", "DD", "DD", "..D", "...Dd"]) },
    up: { over: at(12, 6, ["DD", "DD", "DD"]) },
    /* มุมข้าง: หูฟังแท่งเดียวบนผมหลังหู + ก้านไมค์สีอ่อน (ก้อนเข้ม 2×3 ตรงหูอ่านเป็นตาข้างที่สอง) */
    left: { over: at(6, 6, ["...D", "...D", "...D", "..d", "dd"]) },
  },
  none: { down: {}, up: {}, left: {} },
};

/* ───────────────────────── ของในมือ ───────────────────────── */

/*
 * ของทุกชิ้นวาดพร้อมขอบของตัวเอง (paintRinged) หลังตีขอบตัวละครแล้ว — กระดาษขาวบนเสื้อสีอ่อนจะได้ไม่กลืน
 * gx, gy = จุดที่มือจับ (มือถูกวาดทับตรงนั้นทีหลัง ⇒ ดูเหมือนถือจริง ไม่ใช่ของลอยข้างตัว)
 */
const ITEM_ART = {
  paper: { rows: ["WWWw", "WwwW", "WWWW", "WwwW", "WWWW"], gx: 0, gy: 1 },
  letter: { rows: ["WWWWW", "wWWWw", "WwRwW", "WWWWW"], gx: 0, gy: 1 },
  mug: { rows: ["WWW.", "RRRW", "WWWW", "www."], gx: 3, gy: 1 },
  book: { rows: ["UUUW", "UYUW", "UUUW", "UUUW", "uuuW"], gx: 0, gy: 2 },
  clipboard: { rows: [".DDD.", "NWWWN", "NwwWN", "NWWWN", "NwwwN", "NNNNN"], gx: 0, gy: 2 },
};

function mirrorRows(rows) {
  let w = 0;
  for (const r of rows) w = Math.max(w, r.length);
  return rows.map((r) => r.padEnd(w, ".").split("").reverse().join(""));
}

/**
 * วาดของชิ้น name ให้จุดจับตรงกับมือที่ (hx, hy)
 * side "right" = ของยื่นไปทางขวาของมือ · "left" = ยื่นไปทางซ้าย (กลับด้านภาพให้หูแก้วอยู่ฝั่งมือเสมอ)
 */
function drawItem(buf, pal, name, hx, hy, side = "right") {
  const art = ITEM_ART[name];
  if (!art) return;
  const w = art.rows.reduce((m, r) => Math.max(m, r.length), 0);
  const mug = name === "mug";
  /* แก้ว: ภาพต้นฉบับหูอยู่ขวา (จับด้วยมือขวาของภาพ) — ถ้าของต้องยื่นไปขวาของมือ ให้กลับด้านให้หูมาอยู่ซ้าย */
  const flip = mug ? side === "right" : side === "left";
  const rows = flip ? mirrorRows(art.rows) : art.rows;
  const gx = flip ? w - 1 - art.gx : art.gx;
  paintRinged(buf, rows, pal, hx - gx, hy - art.gy);
}

/* ───────────────────────── ประกอบร่างหนึ่งเฟรม ───────────────────────── */

function paintPart(buf, part, pal, dx = 0, dy = 0) {
  if (!part) return;
  if (part.ring) paintRinged(buf, part.rows, pal, part.x + dx, part.y + dy);
  else paint(buf, part.rows, pal, part.x + dx, part.y + dy);
}

/**
 * rig (ท่าหนึ่งเฟรม) บอกแค่ "ต่างจากท่ายืนตรงไหน":
 *   dy      เลื่อนท่อนบน (หัว+ลำตัว+แขน) ลง(+)/ขึ้น(−) — ยุบตัวตอนเศร้า/หายใจ
 *   hx, hy  เลื่อนหัวเพิ่มจากท่อนบน — เอียงหัว/ก้มหัว
 *   legs    ชื่อชุดขาใน LEGS[มุม] · ly เลื่อนขา (กระโดด)
 *   arms    ชิ้นแขนที่วาดหลังลำตัว (เลื่อนตาม dy) · front ชิ้นที่วาดหลังหัว/ผม (มือแตะหัว/คาง/หู)
 *   behind  ชิ้นที่วาดก่อนทุกอย่าง · headDown แสดงหัวแบบก้มฟุบ (เห็นแต่ผม ไม่เห็นหน้า)
 *   hold    { x, y, side, behind, hands } ตำแหน่งมือที่ถือของ (ไม่มี = ท่านี้ไม่ถือของ)
 *   face    บังคับหน้า (เช่น ฟุบหลับไม่เห็นหน้า = "none")
 *   post    ชิ้นที่วาดหลังของในมือ (มือที่ถือปากกาอยู่หน้าคลิปบอร์ด)
 * ของประกอบท่าที่ไม่ใช่ของในมือ (หูโทรศัพท์ ปากกาไวต์บอร์ด) เป็นชิ้น front แบบมีขอบ — ขยับไปกับแขนได้ในแผนที่เดียว
 */
function drawFigure(buf, look, pal, facing, rig, faceKind, itemName) {
  const dy = rig.dy || 0;
  const hx = rig.hx || 0;
  const hy = dy + (rig.hy || 0);
  const ly = rig.ly || 0;
  const style = HAIR[look.style] || HAIR.short;
  const view = rig.headDown ? "up" : facing;
  const hair = style[view] || style.down;
  const accAll = ACCESSORY[look.accessory] || ACCESSORY.none;
  const acc = accAll[view] || {};
  const role = look.role === "lead" ? "lead" : "helper";
  const hold = itemName ? rig.hold : null;

  /* 1) หลังตัว */
  if (hold && hold.behind) drawItem(buf, pal, itemName, hold.x, hold.y + dy, hold.side);
  for (const p of rig.behind || []) paintPart(buf, p, pal, 0, dy);
  if (hair.behind) paintPart(buf, hair.behind, pal, hx, hy);

  /* 2) ขา → ลำตัว (ถ้ายืดตัวขึ้น เติมเสื้อลงมาให้ชนสะโพก ไม่งั้นขอบหมึกจะกลายเป็นเข็มขัดดำ) */
  const legs = (LEGS[facing] && LEGS[facing][rig.legs || "stand"]) || LEGS[facing].stand;
  paint(buf, legs, pal, 0, 18 + ly);
  const torso = TORSO[facing];
  paint(buf, torso, pal, 0, 13 + dy);
  for (let y = 13 + dy + torso.length; y < 18 + ly; y++) paint(buf, [torso[torso.length - 1]], pal, 0, y);
  const collar = COLLAR[role][facing];
  if (collar) paintPart(buf, collar, pal, 0, dy);

  /* 3) แขน */
  for (const p of rig.arms || []) paintPart(buf, p, pal, 0, dy);

  /* 4) หัว — ขอบของหัววาดทับลำตัวได้ ⇒ มีเส้นคางเสมอแม้ก้มหัวลงชิดไหล่ */
  paintRinged(buf, HEAD, pal, hx, 2 + hy);
  if (facing === "left" && !rig.headDown) paintPart(buf, NOSE_LEFT, pal, hx, hy);
  if (!rig.headDown && facing !== "up") {
    if (acc.under) paintPart(buf, acc.under, pal, hx, hy);
    const fk = rig.face || faceKind;
    const faces = facing === "left" ? FACE_LEFT : FACE_DOWN;
    if (fk !== "none") for (const p of faces[fk] || faces.normal) paintPart(buf, p, pal, hx, hy);
  }
  if (hair.front) paintPart(buf, hair.front, pal, hx, hy);
  if (acc.over) paintPart(buf, acc.over, pal, hx, hy);

  /* 5) มือที่อยู่หน้าหัว */
  for (const p of rig.front || []) paintPart(buf, p, pal, 0, dy);

  /* 6) ขอบรอบทั้งตัว */
  outline(buf, PALETTE.ink);

  /* 7) ของในมือ + มือที่จับ */
  if (hold && !hold.behind) {
    drawItem(buf, pal, itemName, hold.x, hold.y + dy, hold.side);
    const hands = hold.hands || [[hold.x, hold.y]];
    for (const [x, y] of hands) paint(buf, ["S"], pal, x, y + dy);
  }
  /* 8) ชิ้นที่ต้องอยู่หน้าของในมือ (มือถือปากกาเขียนบนคลิปบอร์ด) */
  for (const p of rig.post || []) paintPart(buf, p, pal, 0, dy);
}

/* ───────────────────────── atlas ต่อหน้าตา ───────────────────────── */

/*
 * หนึ่งหน้าตา = atlas หนึ่งชุด (หน้า 128×128 ≈ 28 เฟรม — ตัวละครทั่วไปใช้ราว 10–30 เฟรม ขยายหน้าเองเมื่อเต็ม)
 * เพดาน 400 หน้าตา: เกินแล้วทิ้งอันที่ไม่ได้ใช้นานสุด (คนที่กลับบ้านไปแล้ว) — ถ้ากลับมาใหม่ก็อบใหม่ได้
 */
const LOOK_CAP = 400;
const looks = createLru(LOOK_CAP, (entry) => {
  entry.frames.clear();
  entry.atlas.clear();
});

function entryFor(look) {
  let e = looks.get(look.key);
  if (!e) {
    e = { atlas: createAtlas(128), pal: paletteOf(look), frames: new Map() };
    looks.set(look.key, e);
  }
  return e;
}

/**
 * ข้อมูลของท่า — frames ตรงกับ POSE_FRAMES ใน world.js
 * @param {string} pose
 * @returns {{frames: number, fps: number, dirs: string[], seated: boolean}}
 */
export function poseInfo(pose) {
  return POSES[pose] || POSES.stand;
}

/**
 * เฟรมตัวละครหนึ่งเฟรม (อบครั้งแรกที่ถูกขอ แล้วคืนตำแหน่งเดิมใน atlas ทุกครั้ง)
 * วาดด้วย drawImage(img, sx, sy, w, h, x - ax, y - ay, w, h)
 * @param {object} look ค่าจาก lookFor() (ส่ง { id, role, modelTag, type } ดิบมาก็ได้ — จะเรียก lookFor ให้)
 * @param {string} pose
 * @param {string} dir down|up|left|right
 * @param {number} frame
 * @param {{item?: string|null, face?: string|null}} [opts]
 */
export function character(look, pose, dir, frame = 0, opts = {}) {
  const lk = look && look.brand === LOOK_BRAND ? look : lookFor(look || {});
  const p = POSES[pose] ? pose : "stand";
  const info = POSES[p];
  const d = info.dirs.includes(dir) ? dir : info.dirs[0];
  const n = Number.isFinite(frame) ? Math.floor(frame) : 0;
  const f = ((n % info.frames) + info.frames) % info.frames;
  const o = opts && typeof opts === "object" ? opts : {};
  const face = FACES.has(o.face) ? o.face : DEFAULT_FACE[p] || "normal";
  const item = ITEMS.has(o.item) ? o.item : POSE_ITEM[p] || null;

  const e = entryFor(lk);
  /* มองจากหลัง/ฟุบโต๊ะไม่เห็นหน้า — ทุกหน้าใช้เฟรมเดียวกัน (ไม่งั้นพูดตอนหันหลังจะอบเฟรมซ้ำ 7 ชุด) */
  const faceKey = d === "up" || p === "sit-slump" ? "-" : face;
  const key = `${p}|${d}|${f}|${faceKey}|${item || ""}`;
  /* คืน object เดิมทุกครั้ง: scene เรียกทุกเฟรม × ทุกตัวละคร (พายุงาน ≈ 15k ครั้ง/วินาที) — ไม่อยากสร้างขยะ */
  const hit = e.frames.get(key);
  if (hit) return hit;
  const got = e.atlas.get(key, FW, FH, (g, x, y) => {
    const facing = d === "right" ? "left" : d;
    const rigFn = RIGS[p] || RIGS.stand;
    const rig = rigFn(facing, f, item) || {};
    let buf = makeBuf();
    drawFigure(buf, lk, e.pal, facing, rig, face, item);
    if (d === "right") buf = mirror(buf);
    blit(g, buf, x, y);
  });
  const out = Object.freeze({ img: got.img, sx: got.sx, sy: got.sy, w: FW, h: FH, ax: AX, ay: AY });
  e.frames.set(key, out);
  return out;
}

/** ทิ้ง atlas ของตัวละครทั้งหมด (หน้าตาที่จำไว้ยังอยู่ — มันเป็นแค่ object เล็ก ๆ ไม่ใช่ canvas) */
export function clearCharacterCache() {
  looks.clear();
}

/* ───────────────────────── ท่าทาง (rig ต่อท่า ต่อมุม ต่อเฟรม) ───────────────────────── */

/*
 * แต่ละท่าบอกแค่ส่วนที่ต่างจากท่ายืน — ร่าง หัว ผม ของแต่ง มาจากชั้นกลางเสมอ ⇒ ทุกท่าเป็นคนเดียวกัน
 * หลักการออกแบบ: ท่าที่ต่างความหมายต้อง "เงาไม่เหมือนกัน" (ดูจากเงาดำล้วนก็ต้องแยกออก) เพราะตอนซูม 2 เท่า
 * คนดูเห็นแค่รูปทรง ไม่เห็นรายละเอียดหน้า — แขนจึงชูออกนอกตัว/พับเข้าหน้า/ยื่นออกข้าง ให้ต่างกันชัด ๆ
 * แขนที่ยกมาทับหัวใช้ at(..., true) = มีขอบของตัวเอง ไม่งั้นแขนจะกลืนไปกับหน้า/ผม
 */

const HANG_L = at(4, 13, ["c", "c", "c", "c", "S"]);
const HANG_R = at(11, 13, ["c", "c", "c", "c", "S"]);
const UPPER_R = at(11, 13, ["c", "c"]);
/* มือเท้าคาง: มือ (มีขอบ) ใต้คาง + ปลายแขนที่พับขึ้นมาทับขอบล่างของมือ (วาดหลังมือ แขนจึงต่อกันไม่ขาด) */
const CHIN_HAND = [at(9, 12, ["SS"], true), at(10, 13, ["c", "c", "cc"])];

const RIGS = {
  stand(facing, f) {
    /* เฟรม 2 = หายใจ: ท่อนบนยุบลง 1 px (world ปิดให้เองเมื่อผู้ใช้ขอลดการเคลื่อนไหว) */
    const dy = f === 1 ? 1 : 0;
    if (facing === "left") return { dy, arms: [ARMS.left.side], hold: { x: 7, y: 17, side: "left" } };
    if (facing === "up") return { dy, arms: [ARMS.up.side], hold: { x: 4, y: 17, side: "left", behind: true } };
    return { dy, arms: [ARMS.down.side], hold: { x: 11, y: 17, side: "right" } };
  },

  walk(facing, f) {
    if (facing === "left") {
      /* ก้าว(ขาใกล้หน้า) → ผ่าน → ก้าว(ขาไกลหน้า) → ผ่าน · แขนแกว่งสวนขาเสมอ */
      const s = [
        { legs: "strideN", arm: ARMS.left.back, hx: 10, hy: 16 },
        { legs: "pass", arm: ARMS.left.side, hx: 7, hy: 17 },
        { legs: "strideF", arm: ARMS.left.fwd, hx: 4, hy: 16 },
        { legs: "pass", arm: ARMS.left.side, hx: 7, hy: 17 },
      ][f];
      return { legs: s.legs, arms: [s.arm], hold: { x: s.hx, y: s.hy, side: "left" } };
    }
    if (facing === "up") {
      const s = [
        { legs: "stand", arm: ARMS.down.side, hy: 17 },
        { legs: "liftL", arm: ARMS.down.rightFwd, hy: 16 },
        { legs: "stand", arm: ARMS.down.side, hy: 17 },
        { legs: "liftR", arm: ARMS.down.leftFwd, hy: 18 },
      ][f];
      return { legs: s.legs, arms: [s.arm], hold: { x: 4, y: s.hy, side: "left", behind: true } };
    }
    const s = [
      { legs: "stand", arm: ARMS.down.side, hy: 17 },
      { legs: "liftL", arm: ARMS.down.rightFwd, hy: 18 },
      { legs: "stand", arm: ARMS.down.side, hy: 17 },
      { legs: "liftR", arm: ARMS.down.leftFwd, hy: 16 },
    ][f];
    return { legs: s.legs, arms: [s.arm], hold: { x: 11, y: s.hy, side: "right" } };
  },

  /* ── ท่านั่ง (หันหน้าอย่างเดียว) — ที่โต๊ะเห็นแค่แถว 0–15 ความต่างของแต่ละท่าจึงต้องอยู่เหนือแถว 16 ── */

  "sit-type"(facing, f) {
    /*
     * มือสองข้างสลับกันโผล่เหนือฝาแล็ปท็อป = กำลังพิมพ์ — ต้องอยู่แถว 13 เพราะฝาจอของโต๊ะจริง (art/props.js)
     * บังตั้งแต่แถว 14 ลงไปตรงกลางตัว (ลองแถว 15 แล้วมือหายหมด เห็นแค่คนนั่งนิ่ง)
     */
    const arms = at(4, 13, ["c......c", "cc....cc", "c......c"]);
    /* มือที่ยกขึ้นมีขอบของตัวเอง — มือผิวเปล่า ๆ ข้างคอเสื้อกลืนเป็นปกเสื้อ (ลองแล้วอ่านไม่ออก) */
    const up = f ? at(9, 13, ["SS"], true) : at(5, 13, ["SS"], true);
    const down = f ? at(5, 15, ["SS"]) : at(9, 15, ["SS"]);
    return { legs: "sit", arms: [arms, down], front: [up] };
  },

  "sit-think"(facing, f) {
    return { legs: "sit", dy: f === 1 ? 1 : 0, arms: [HANG_L, UPPER_R], front: CHIN_HAND };
  },

  "sit-idle"(facing, f) {
    /* มือวางบนโต๊ะ (ต่ำกว่าขอบ มองไม่เห็น) — ที่เห็นคือไหล่นิ่ง ๆ กับการหายใจ */
    return { legs: "sit", dy: f === 1 ? 1 : 0, arms: [at(4, 13, ["c......c", "c......c", "c......c", ".S....S."])] };
  },

  "sit-slump"() {
    /*
     * ฟุบโต๊ะ: หัวจมลงไปหลังจอจนเหลือแค่กระหม่อม แขนสองข้างแผ่ราบบนโต๊ะพ้นขอบจอออกไปสองข้าง
     * (ถ้าหัวยังสูงพ้นจอทั้งลูก จะอ่านเป็น "คนหันหลัง" แทน "หมดแรงฟุบ")
     */
    return {
      legs: "sit",
      dy: 1,
      hy: 5,
      headDown: true,
      face: "none",
      front: [at(1, 12, ["SSc........cSS"], true)],
    };
  },

  "sit-sleep"(facing, f) {
    /* หลับบนโซฟา: หัวเอียงพิงไปข้างหนึ่ง มือประสานบนตัก หายใจช้า ๆ */
    return {
      legs: "sit",
      dy: f === 1 ? 1 : 0,
      hx: 1,
      hy: 1,
      arms: [at(4, 13, ["c......c", "c......c", "c......c", ".c....c.", "..SSSS"])],
    };
  },

  sip(facing, f) {
    if (f === 1) {
      /* ยกแก้วขึ้นจิบ — แก้วบังปาก แขนพับขึ้นมาทับอก */
      return { arms: [HANG_L], front: [at(10, 12, ["cc", ".c"])], hold: { x: 9, y: 11, side: "left" } };
    }
    return { arms: [HANG_L, UPPER_R], hold: { x: 10, y: 15, side: "left" } };
  },

  /* ── ท่าหันหลัง (ยืนหน้าชั้นหนังสือ/ตู้/เทอร์มินัล/ไวต์บอร์ด) ── */

  read(facing, f, item) {
    const arms = [at(4, 13, ["c......c", "c......c", "c......c"])];
    if (item === "book") {
      /* หนังสือเปิดกว้างกว่าตัว — มองจากหลังเห็นขอบหน้ากระดาษโผล่สองข้าง · เฟรม 2 พลิกหน้า */
      const pages = f
        ? ["............WW", "UWWWWWWuWWWWWU", "UwwWWWWuWWWwwU", "UWWWWWWuWWWWWU", ".uuuuuuuuuuuu"]
        : ["", "UWWWWWWuWWWWWU", "UwwWWWWuWWWwwU", "UWWWWWWuWWWWWU", ".uuuuuuuuuuuu"];
      return { arms, hy: 1, behind: [at(1, 11, pages, true)] };
    }
    return { arms, hy: f === 1 ? 1 : 0, hold: { x: 4, y: 16, side: "left", behind: true } };
  },

  reach(facing, f) {
    /* เอื้อมเข้าชั้น: แขนขวาเหยียดขึ้นสุด เฟรม 2 เขย่ง + มือสูงขึ้นอีก */
    const arm = f
      ? at(13, 1, ["S", "S", "c", "c", "c", "c", "c", "c", "c", "c", "c", "c"], true)
      : at(13, 3, ["S", "S", "c", "c", "c", "c", "c", "c", "c", "c"], true);
    return { legs: f ? "tiptoe" : "stand", arms: [HANG_L, at(11, 13, ["cc"])], front: [arm] };
  },

  "type-stand"(facing, f) {
    /* พิมพ์ที่เทอร์มินัล: ข้อศอกสองข้างสลับกางออก (มือทั้งคู่อยู่หน้าตัว มองจากหลังไม่เห็น) */
    const arms = f ? at(4, 13, ["c......c", "c.......c", "........c"]) : at(3, 13, [".c......c", "c.......c", "c"]);
    return { arms: [arms] };
  },

  "write-board"(facing, f) {
    /* ชูแขนขวาเขียนบนกระดาน ปากกาปลายแดง · เฟรมสลับตำแหน่งมือ = ลากเส้น */
    const arm = f
      ? at(12, 5, [".R", ".S", ".c", ".c", ".c", ".c", "c"], true)
      : at(12, 7, ["..R", "..S", ".c", ".c", "c", "c"], true);
    return { arms: [HANG_L, at(11, 13, ["c"])], front: [arm] };
  },

  /* ── ท่ายืนหันหน้า ── */

  "think-stand"(facing, f) {
    /* เท้าคาง + แขนอีกข้างกอดอกรองศอก */
    return {
      dy: f === 1 ? 1 : 0,
      arms: [at(4, 13, ["c", "c", "c", "cccccS"]), UPPER_R, at(11, 15, ["c"])],
      front: CHIN_HAND,
    };
  },

  "raise-hand"(facing, f) {
    /* ยกมือสุดแขนข้างหัว — เงาที่สูงเกินหัวคือสัญญาณ "รออนุญาต" ที่มองเห็นจากไกล ๆ */
    const arm = f
      ? at(1, 2, ["S", "S", "c", "c", "c", "c", "c", "c", "c", ".c", "..c"], true)
      : at(1, 3, ["S", "S", "c", "c", "c", "c", "c", "c", ".c", "..c"], true);
    return { arms: [HANG_R, at(4, 13, ["c"])], front: [arm] };
  },

  phone(facing, f) {
    /* หูโทรศัพท์แนบหูขวา (ด้านขวาของภาพ) · เฟรม 2 มืออีกข้างทำท่าประกอบการพูด */
    /* หูโทรศัพท์สีแดงแบบตู้โทรศัพท์ — สีเข้มจะกลืนกับเฮดเซ็ต/หูฟังจนดูเหมือนแค่ใส่หูฟัง */
    const receiver = at(11, 6, [".RM", "..R", "..RS", "..RS", ".RMc", "..c", ".c", "c"], true);
    const other = f ? at(3, 13, [".c", "c", "S"]) : HANG_L;
    return { arms: [other], front: [receiver] };
  },

  supervise(facing, f) {
    if (facing === "left") {
      /* ถือคลิปบอร์ดไว้ข้างหน้า มืออีกข้างขีดปากกา */
      const pen = f ? at(3, 15, ["DS"]) : at(2, 14, ["DS"]);
      return { arms: [at(5, 13, ["..cc", ".cc"])], hold: { x: 5, y: 15, side: "left" }, post: [pen] };
    }
    const pen = f ? at(8, 15, ["D", "S"]) : at(9, 14, ["D", "S"]);
    return {
      arms: [at(4, 13, ["c......c", "c......c", ".......c"])],
      hold: { x: 5, y: 15, side: "right" },
      post: [pen],
    };
  },

  celebrate(facing, f) {
    /* ชูสองแขนเป็นตัว V · เฟรม 2 กระโดด (ท่อนบนลอย 1 + ขาพับ ⇒ เท้าพ้นพื้น 3 px) */
    const armL = at(1, 6, ["S", "S", "c", ".c", ".c", "..c", "..c"], true);
    const armR = at(12, 6, ["..S", "..S", "..c", ".c", ".c", "c", "c"], true);
    const base = [at(4, 13, ["c......c"])];
    if (f === 1) return { dy: -1, ly: -1, legs: "tuck", arms: base, front: [armL, armR] };
    return { arms: base, front: [armL, armR] };
  },

  sad(facing, f) {
    /* ห่อไหล่ คอตก — เฟรม 2 ถอนหายใจ หัวตกลงอีก */
    return { dy: 1, hy: f === 1 ? 2 : 1, arms: [ARMS.down.side] };
  },

  oops() {
    /* สองมือกุมหัว ศอกกางออกนอกตัว */
    const armL = at(1, 3, [".SS", ".SS", "c", "c", "c", "c", "c", "c", ".c", "..c"], true);
    const armR = at(12, 3, ["SS.", "SS.", "..c", "..c", "..c", "..c", "..c", "..c", ".c", "c"], true);
    return { arms: [at(4, 13, ["c......c"])], front: [armL, armR] };
  },

  wave(facing, f) {
    const arm = f
      ? at(11, 5, ["..S", "..S", "..c", "..c", "..c", ".c", ".c", "c"], true)
      : at(11, 6, ["...S", "...S", "..c", "..c", ".c", ".c", "c"], true);
    return { arms: [HANG_L], front: [arm] };
  },

  "read-letter"(facing, f) {
    /* ถือจดหมายสองมือตรงหน้าอก · เฟรม 2 ยกขึ้นอ่านใกล้ขึ้น */
    const y = f === 1 ? 14 : 15;
    return {
      arms: [at(4, 13, ["c......c", "c......c", "c.....c"])],
      hold: { x: 5, y, side: "right", hands: [[5, y], [9, y]] },
    };
  },

  give(facing) {
    if (facing === "left") {
      /* ยื่นแขนตรงออกไปข้างหน้า กระดาษอยู่สุดปลายแขน */
      return { arms: [at(5, 13, ["..cc", "ccc"])], hold: { x: 4, y: 14, side: "left" } };
    }
    if (facing === "up") {
      /* หันหลังยื่นของขึ้นไปข้างหน้า — กระดาษโผล่พ้นไหล่ขวา */
      return { arms: [HANG_L, at(11, 12, [".c", "c"])], hold: { x: 12, y: 11, side: "right" } };
    }
    /* หันหน้า: สองมือยื่นกระดาษมาตรงหน้า (ส่งให้คนที่ยืนอยู่ด้านล่าง) */
    return {
      arms: [at(4, 13, ["c......c", "c......c", ".c....c"])],
      hold: { x: 6, y: 16, side: "right", hands: [[6, 16], [9, 16]] },
    };
  },
};
