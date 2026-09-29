/*
 * scene.js — "กล้องกับผืนผ้าใบ" ของหน้า PIXEL OFFICE
 *
 * หน้าที่มีสามอย่าง และไม่ตัดสินใจเรื่องเนื้อเรื่องเลยสักอย่าง (ใครอยู่ไหน ทำอะไร = world.js ตัดสินแล้ว):
 *   1. วาดโลกลง <canvas> แบบพิกเซลแข็ง: ห้องละหนึ่งภาพนิ่งที่อบไว้ (พื้น/ผนัง/ของติดผนัง) + ชั้นที่ขยับ
 *      (เฟอร์นิเจอร์ที่เปลี่ยนสภาพ ตัวละคร เอฟเฟกต์) เรียงตาม sortY ให้คนนั่ง "หลังโต๊ะ" จริง
 *   2. ชั้นตัวหนังสือบนจอ (ป้ายชื่อห้อง ป้ายงาน ฟองคำพูด ป้ายปิดห้อง) — วาดทีหลังด้วยพิกัดจอ
 *      เพราะตัวอักษรไทยต้องคมที่ความละเอียดจริง ถ้าวาดในโลกแล้วขยาย ×4 จะเป็นก้อนเบลอ
 *   3. กล้องและการรับอินพุต: ลาก = เลื่อน · ล้อเมาส์ = ซูมทีละขั้นรอบเคอร์เซอร์ · คลิก = เลือก ·
 *      ดับเบิลคลิก = เล็งกล้อง · คีย์บอร์ด (+ − 0 ลูกศร)
 *
 * กฎของกล้อง (คำสั่งผู้ใช้ใน brain/main.js 2026-09-10): กล้องไม่ขยับเองเพราะเหตุการณ์ใด ๆ
 *   ขยับได้เฉพาะ ลาก/ซูมของผู้ใช้ · ปุ่ม "จัดกรอบ" · คลิก/เล็งตัวละครหรือห้อง · และจัดกรอบอัตโนมัติ
 *   "ครั้งเดียว" หลังข้อมูลชุดแรก (main.js เป็นคนเรียก) — ไฟล์นี้จึงไม่มีโค้ดตามกล้องไปหาใครเลย
 *
 * ความคมของพิกเซล: ซูมเป็นจำนวนเต็ม "ต่อพิกเซลจอจริง" (device px) และ offset ของกล้องเป็นจำนวนเต็ม
 *   ⇒ พิกเซลโลก 1 จุด = สี่เหลี่ยม z×z ของจอพอดีเสมอ ไม่มีครึ่งพิกเซลให้เบราว์เซอร์เกลี่ยสี
 *   (ตำแหน่งในโลกทุกตัวถูกปัดเป็นพิกเซลโลกเต็มก่อนวาด)
 */

const TILE = 16;
/** ความกว้างห้องหนึ่งห้อง (26 ช่อง — ROOM_W ของ world.js) ใช้ตัดสินว่า "ล้นนิดเดียว" หรือ "ล้นทั้งห้อง" ตอนจัดกรอบ */
const ROOM_PX = 26 * TILE;
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
/** ขอบเขตความละเอียด: DPR 3 ของมือถือบางรุ่นทำให้ backing store ใหญ่ 9 เท่าโดยตาแทบไม่เห็นต่าง */
const DPR_MAX = 2;
const BG = "#12131f";
/** ลากเกินเท่านี้ (CSS px) ถึงนับว่า "ลาก" — มือสั่นตอนคลิกไม่ควรกลายเป็นการเลื่อนฉาก */
const DRAG_SLOP = 4;
/** ล้อเมาส์: สะสม delta ให้ครบหนึ่ง "คลิกล้อ" ก่อนซูมหนึ่งขั้น (ทัชแพดยิง delta เล็ก ๆ ถี่มาก) */
const WHEEL_STEP = 90;
/** กันกล้องหลุดไปไกลจนหาห้องไม่เจอ: ต้องเห็นขอบของโลกอย่างน้อยเท่านี้ (device px) */
const KEEP_VISIBLE = 64;
const FONT_STACK = '"Segoe UI","Noto Sans Thai","Leelawadee UI",system-ui,sans-serif';

/** โทนของป้าย/ขอบ (Sweetie 16) — ตรงกับ px-tone--* ใน pixel.css ให้ฟีดกับฉากพูดภาษาสีเดียวกัน */
const TONE_COLOR = {
  info: "#41a6f6",
  good: "#38b764",
  bad: "#b13e53",
  warn: "#ffcd75",
  spawn: "#73eff7",
  neutral: "#94b0c2",
};

/** สถานะห้อง → คำสั้นบนป้ายชื่อ + สี (ชุดคำเดียวกับรายชื่อห้องใน hud.js) */
const STATE_LABEL = {
  tool: ["ทำงาน", "#41a6f6"],
  delegating: ["คุมงาน", "#73eff7"],
  waiting: ["รอคุณ", "#ffcd75"],
  thinking: ["คิด", "#b58cf0"],
  blocked: ["ติดด่าน", "#ef7d57"],
  idle: ["ว่าง", "#a7f070"],
  unknown: ["ไม่ทราบ", "#94b0c2"],
};

const CHIP_FALLBACK = { HA: "#38b764", SO: "#3b5dc9", OP: "#7b4fbf", FA: "#ef7d57", "": "#566c86" };

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function num(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function isObj(v) {
  return v !== null && typeof v === "object";
}
function oneLine(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/**
 * endedAgo (ms) → "N นาทีก่อน" (คำเดียวกับ fmtEndedAgo ใน hud.js)
 * เกิน 30 วันถือว่าค่าผิด (fixture รุ่นปัจจุบันส่ง epoch ปนมา ⇒ "29 ล้านนาทีก่อน") — ไม่บอกเวลา
 * ดีกว่าบอกเวลาที่ไม่จริง (server เก็บห้องที่ปิดแล้วไว้แค่ --stale-minutes อยู่แล้ว)
 */
const ENDED_AGO_SANE_MS = 30 * 24 * 3600 * 1000;
function endedAgoText(ms) {
  const v = typeof ms === "number" && Number.isFinite(ms) ? ms : NaN;
  if (!(v >= 0) || v > ENDED_AGO_SANE_MS) return "";
  const min = Math.floor(v / 60000);
  if (min < 1) return "เพิ่งปิด";
  if (min < 60) return `${min} นาทีก่อน`;
  return `${Math.floor(min / 60)} ชม. ${min % 60} นาทีก่อน`;
}

/**
 * สร้างฉาก
 * @param {HTMLCanvasElement} canvas
 * @param {object} world ค่าจาก createWorld() — อ่านอย่างเดียว
 * @param {object} sprites โมดูล sprites.js ทั้งก้อน (ส่งเข้ามาแทนการ import ตรง ⇒ ทดสอบด้วยของปลอมได้)
 * @param {{ reduceMotion?: boolean, insets?: () => ({top?:number,right?:number,bottom?:number,left?:number}),
 *           onSelect?: (key: string|null, info?: object) => void, onHover?: (key: string|null) => void,
 *           onCamera?: (zoom: number) => void, onFocusRoom?: (sessionId: string) => void }} [options]
 */
export function createScene(canvas, world, sprites, options = {}) {
  const opts = isObj(options) ? options : {};
  const RM = !!opts.reduceMotion;
  const ctx = canvas.getContext("2d", { alpha: false });

  /* ───────────── สถานะกล้อง ───────────── */
  let dpr = 1;
  let W = 1; // backing store (device px)
  let H = 1;
  let z = 2; // device px ต่อ world px (จำนวนเต็ม)
  let ox = 0; // world (0,0) อยู่ที่ device px นี้ (จำนวนเต็ม)
  let oy = 0;
  let selected = null;
  let hovered = null;
  let captionMode = "auto";
  let time = 0; // นาฬิกาของฉากเอง (กระพริบ/สั่น) — ไม่พึ่ง world.time เผื่อ world ถูก dispose
  let disposed = false;

  /** ที่ไหนพังซ้ำทุกเฟรม (60 ครั้ง/วิ) จะท่วม Console จนหา error แรกไม่เจอ — บอกซ้ำได้ทุก 10 วิต่อจุด */
  const reported = new Map();
  function report(where, err) {
    const now = Date.now();
    const last = reported.get(where);
    if (last !== undefined && now - last < 10000) return;
    if (reported.size > 200) reported.clear();
    reported.set(where, now);
    console.error(`[pixel/scene] ${where}`, err);
  }
  /** callback ของ main.js พังต้องไม่ลากอินพุต/ลูปวาดไปด้วย */
  function emit(fn, ...args) {
    if (typeof fn !== "function") return;
    try {
      fn(...args);
    } catch (err) {
      report("callback", err);
    }
  }

  /* ───────────── กล้อง: แปลงพิกัด ───────────── */

  /** CSS px (เทียบมุมซ้ายบนของ canvas) → world px */
  function screenToWorld(sx, sy) {
    return { x: (num(sx) * dpr - ox) / z, y: (num(sy) * dpr - oy) / z };
  }
  /** world px → CSS px */
  function worldToScreen(wx, wy) {
    return { x: (num(wx) * z + ox) / dpr, y: (num(wy) * z + oy) / dpr };
  }

  /**
   * พื้นที่ที่ "มองเห็นจริง" (device px) = ทั้ง canvas ลบแถบ HUD ที่ทับอยู่ — จัดกรอบ/เล็งกล้องให้ของ
   * อยู่กลางพื้นที่นี้ ไม่ใช่กลางจอที่ครึ่งหนึ่งโดนแผงบัง
   */
  function safeRect() {
    let ins = null;
    if (typeof opts.insets === "function") {
      try {
        ins = opts.insets();
      } catch (err) {
        report("insets", err);
      }
    }
    const i = isObj(ins) ? ins : {};
    const top = clamp(num(i.top) * dpr, 0, H * 0.6);
    const right = clamp(num(i.right) * dpr, 0, W * 0.6);
    const bottom = clamp(num(i.bottom) * dpr, 0, H * 0.6);
    const left = clamp(num(i.left) * dpr, 0, W * 0.6);
    return { x: left, y: top, w: Math.max(32, W - left - right), h: Math.max(32, H - top - bottom) };
  }

  /** กันกล้องหลุด: โลกทั้งก้อนต้องเหลือบนจออย่างน้อย KEEP_VISIBLE px ทุกด้าน */
  function clampCamera() {
    const b = world.bounds();
    const x0 = b.x * z;
    const y0 = b.y * z;
    const x1 = (b.x + b.w) * z;
    const y1 = (b.y + b.h) * z;
    const keepX = Math.min(KEEP_VISIBLE, (x1 - x0) / 2);
    const keepY = Math.min(KEEP_VISIBLE, (y1 - y0) / 2);
    ox = Math.round(clamp(ox, keepX - x1, W - keepX - x0));
    oy = Math.round(clamp(oy, keepY - y1, H - keepY - y0));
  }

  function cameraChanged() {
    clampCamera();
    emit(opts.onCamera, z);
  }

  /** วาง world rect ให้อยู่กลาง safe rect ที่ซูม zz */
  function centerOn(wx, wy, zz) {
    const r = safeRect();
    z = clamp(Math.round(zz), ZOOM_MIN, ZOOM_MAX);
    ox = Math.round(r.x + r.w / 2 - wx * z);
    oy = Math.round(r.y + r.h / 2 - wy * z);
    cameraChanged();
  }

  /** ซูมจำนวนเต็มที่ใหญ่สุดที่ทั้ง rect ยังพอดีพื้นที่ที่มองเห็น (อย่างน้อย 1) */
  function zoomToFit(rect, maxZ = ZOOM_MAX) {
    const r = safeRect();
    const zx = Math.floor(r.w / Math.max(1, rect.w));
    const zy = Math.floor(r.h / Math.max(1, rect.h));
    return clamp(Math.min(zx, zy), ZOOM_MIN, maxZ);
  }

  /**
   * วาง rect ของโลกลงจอที่ซูม zz:
   *   พอดีพื้นที่ที่ไม่โดนแผงบัง → กลางพื้นที่นั้น
   *   กว้างเกินไม่ถึงครึ่งห้อง (มือถือ DPR 1: ห้องกว้าง 416 px บนจอ 390 px) → ก็ยังจัดกลาง ⇒ ผนังสองข้าง
   *     ถูกตัดเท่า ๆ กันไม่ถึงช่องเดียว ประตูซ้ายและโซนหัวหน้าขวายังเห็นครบ (เดิมชิดซ้าย ผนังขวา/ต้นไม้/โซฟาหาย)
   *   กว้างกว่านั้น (แม้ซูมต่ำสุด) → ชิดซ้ายของพื้นที่ที่มองเห็น ⇒ ห้องแรก (slot 0) เห็นเต็มเสมอ
   *     (เดิมจัดกลาง "ทั้งจอ" — ห้องขวาสุดจึงมุดใต้คอลัมน์เครื่องมือ/รายชื่อห้อง ทั้งกำแพงหลังและโซนหัวหน้า
   *      ส่วนที่ล้นออกขวาตอนนี้ล้นออกนอกจอจริง ๆ ซึ่งลากดูได้ ไม่ใช่ซ่อนอยู่ใต้แผงที่ลากไม่ได้)
   */
  function placeRect(b, zz) {
    const r = safeRect();
    z = clamp(Math.round(zz), ZOOM_MIN, ZOOM_MAX);
    const bw = b.w * z;
    const bh = b.h * z;
    let px;
    let py;
    if (bw <= r.w || bw - r.w < (ROOM_PX * z) / 2) px = r.x + (r.w - bw) / 2;
    else px = r.x;
    if (bh <= r.h) py = r.y + (r.h - bh) / 2;
    else if (bh <= H - r.y) py = r.y + (H - r.y - bh) / 2;
    else py = r.y;
    ox = Math.round(px - b.x * z);
    oy = Math.round(py - b.y * z);
    cameraChanged();
  }

  /** ปุ่ม "จัดกรอบ" / จัดกรอบอัตโนมัติครั้งแรก: ทุกห้องพอดีจอ */
  function fit() {
    const b = world.bounds();
    placeRect(b, zoomToFit(b));
  }

  /** ซูมขึ้น/ลงทีละขั้นรอบจุด (CSS px) — ค่าเริ่มต้นคือกลางพื้นที่ที่มองเห็น (ปุ่ม/คีย์บอร์ด) */
  function zoomBy(step, sx, sy) {
    const s = Math.sign(num(step));
    if (!s) return;
    const nz = clamp(z + s, ZOOM_MIN, ZOOM_MAX);
    if (nz === z) return;
    let px;
    let py;
    if (Number.isFinite(sx) && Number.isFinite(sy)) {
      px = sx * dpr;
      py = sy * dpr;
    } else {
      const r = safeRect();
      px = r.x + r.w / 2;
      py = r.y + r.h / 2;
    }
    /* จุดในโลกที่อยู่ใต้เคอร์เซอร์ต้องยังอยู่ใต้เคอร์เซอร์หลังซูม */
    const wx = (px - ox) / z;
    const wy = (py - oy) / z;
    z = nz;
    ox = Math.round(px - wx * z);
    oy = Math.round(py - wy * z);
    cameraChanged();
  }

  /** เลื่อนฉาก (CSS px) */
  function panBy(dx, dy) {
    ox = Math.round(ox + num(dx) * dpr);
    oy = Math.round(oy + num(dy) * dpr);
    cameraChanged();
  }

  /** เล็งกล้องไปที่ตัวละคร (การกระทำของผู้ใช้เท่านั้น: ดับเบิลคลิก/คลิกแถวในฟีด) */
  function focus(key) {
    const ch = typeof key === "string" ? world.characters.get(key) : null;
    const p = ch ? world.worldPos(ch) : null;
    if (!p) return false;
    /* เล็งที่ช่วงอก ไม่ใช่เท้า — ตัวสูง 24 px */
    centerOn(p.x, p.y - 12, Math.max(z, 3));
    return true;
  }

  /** เล็งกล้องให้ทั้งห้องพอดีจอ (ปุ่มในรายชื่อห้อง / คลิกป้ายชื่อห้อง) */
  function focusRoom(sessionId) {
    const room = world.rooms.get(sessionId);
    if (!room) return false;
    /* เผื่อด้านบน 24 px ให้ป้ายชื่อห้องที่ลอยเหนือขอบ + ขอบรอบ ๆ 8 px */
    const rect = { x: room.tx - 8, y: room.ty - 32, w: room.w * TILE + 16, h: room.h * TILE + 40 };
    placeRect(rect, zoomToFit(rect));
    return true;
  }

  /** พื้นที่ของโลกที่อยู่ในจอตอนนี้ (world px) — ใช้ตัดของนอกจอ และให้ main.js เช็กว่ามีห้องล้นจอไหม */
  function viewRect() {
    return { x: -ox / z, y: -oy / z, w: W / z, h: H / z };
  }

  /** ปรับขนาด backing store ตาม CSS size × DPR — จุดกลางจอเดิมยังอยู่กลางจอหลังปรับ (ไม่ใช่กล้องขยับเอง) */
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width || window.innerWidth || 1));
    const cssH = Math.max(1, Math.round(rect.height || window.innerHeight || 1));
    const nd = clamp(num(window.devicePixelRatio, 1), 1, DPR_MAX);
    const nw = Math.max(1, Math.round(cssW * nd));
    const nh = Math.max(1, Math.round(cssH * nd));
    if (nw === W && nh === H && nd === dpr) return;
    const cx = (W / 2 - ox) / z;
    const cy = (H / 2 - oy) / z;
    dpr = nd;
    W = nw;
    H = nh;
    canvas.width = W;
    canvas.height = H;
    ox = Math.round(W / 2 - cx * z);
    oy = Math.round(H / 2 - cy * z);
    clampCamera();
  }

  /* ───────────── ภาพนิ่งของห้อง (อบครั้งเดียว วาดซ้ำทุกเฟรม) ───────────── */

  /** sessionId → { canvas, g, sig } — ห้องหายเมื่อไหร่ก็ทิ้งภาพของมันทันที (แท็บเปิดทิ้งไว้ได้เป็นวัน) */
  const bakes = new Map();

  function accentOf(tag) {
    const pair = sprites.MODEL_SHIRT && sprites.MODEL_SHIRT[tag];
    return (pair && pair[0]) || CHIP_FALLBACK[tag] || CHIP_FALLBACK[""];
  }

  /**
   * ลายเซ็นของภาพนิ่ง: staticVersion (world เพิ่มเมื่อผัง/หน้าต่าง/ไฟเปลี่ยน) + ขนาด + ไฟ + สีคิ้วผนังตามโมเดล
   * ไม่ผูกกับ world.layoutVersion ตรง ๆ — มันขยับทุกครั้งที่ห้องไหน "เลื่อนที่" (ห้องใหม่เกิด/tween จบ)
   * ซึ่งไม่ได้เปลี่ยนหน้าตาของห้องเลย การอบทุกห้องใหม่ทั้งหมดตอนนั้นคือจ่ายฟรีหลายมิลลิวินาที
   */
  function bakeSig(room) {
    return `${room.staticVersion}|${room.w}|${room.h}|${room.lightsOn ? 1 : 0}|${room.modelTag}`;
  }

  function bakeRoom(room) {
    const sig = bakeSig(room);
    let b = bakes.get(room.sessionId);
    if (b && b.sig === sig) return b;
    const wpx = room.w * TILE;
    const hpx = room.h * TILE;
    if (!b) {
      const c = document.createElement("canvas");
      b = { canvas: c, g: c.getContext("2d"), sig: "" };
      bakes.set(room.sessionId, b);
    }
    if (b.canvas.width !== wpx || b.canvas.height !== hpx) {
      b.canvas.width = wpx;
      b.canvas.height = hpx;
    } else {
      b.g.clearRect(0, 0, wpx, hpx);
    }
    const g = b.g;
    g.imageSmoothingEnabled = false;
    try {
      /*
       * อบเปลือกห้องแบบ "ไฟเปิด" เสมอ แล้วค่อยหรี่ทั้งห้อง (รวมคนและเฟอร์นิเจอร์ที่ขยับ) ด้วยชั้น multiply
       * ชั้นเดียวตอนวาด — ถ้าให้ paintRoomShell หรี่เองด้วย พื้นจะมืดสองรอบ ส่วนโต๊ะ/คนไม่มืดเลย
       */
      sprites.paintRoomShell(g, {
        w: room.w,
        h: room.h,
        doorTx: room.door ? room.door.tx : 1,
        /* พรมหน้าประตูข้าง (ห้องที่โตเกิน 2 ชุดโต๊ะ) — แถวของประตูขึ้นกับขนาดห้อง ซึ่งอยู่ใน bakeSig แล้ว */
        sideDoors: Array.isArray(room.doors) ? room.doors.filter((d) => isObj(d) && d.tx === 0).map((d) => d.ty) : [],
        windowTxs: [],
        lightsOn: true,
        accent: accentOf(room.modelTag),
      });
      for (const p of room.props) {
        if (p.layer !== "floor" && p.layer !== "wall") continue;
        const s = sprites.prop(p.name, p.variant, p.frame);
        g.drawImage(s.img, s.sx, s.sy, s.w, s.h, Math.round(p.tx * TILE), (p.ty + p.fh) * TILE - s.h, s.w, s.h);
      }
    } catch (err) {
      report(`bake room ${room.sessionId}`, err);
    }
    b.sig = sig;
    return b;
  }

  /* ───────────── ชั้นที่ขยับ: เฟอร์นิเจอร์ใช้งาน · ตัวละคร · เอฟเฟกต์ ───────────── */

  /** key → { src, look } — lookFor ถูก memo อยู่แล้ว แต่การเทียบ object เดิมถูกกว่าการต่อสตริง key ทุกเฟรม */
  const looks = new Map();
  function lookOf(ch) {
    let e = looks.get(ch.key);
    if (!e || e.src !== ch.look) {
      e = { src: ch.look, look: sprites.lookFor(ch.look || {}) };
      looks.set(ch.key, e);
    }
    return e.look;
  }
  /* object opts ใช้ซ้ำ (character() อ่านค่าทันทีแล้วไม่เก็บไว้) — 240 ตัว × 60 fps ไม่ควรสร้างขยะทุกเฟรม */
  const charOpts = { item: null, face: null };
  const items = [];
  /** sessionId → ตัวละครของห้องนั้นในเฟรมนี้ (อาร์เรย์ใช้ซ้ำข้ามเฟรม) */
  const byRoom = new Map();
  let view = { x0: 0, y0: 0, x1: 0, y1: 0 };

  function sortKey(it) {
    return it.layer ? it.sortY : it.y;
  }
  function bySortY(a, b) {
    return sortKey(a) - sortKey(b);
  }

  function shakeOf(ch) {
    if (!(ch.shake > 0) || RM) return 0;
    return Math.round(Math.sin(time * 55) * 2 * ch.shake);
  }

  function drawProp(p, rx, ry) {
    const s = sprites.prop(p.name, p.variant, p.frame);
    const x = rx + Math.round(p.tx * TILE);
    const y = ry + (p.ty + p.fh) * TILE - s.h;
    if (x > view.x1 || y > view.y1 || x + s.w < view.x0 || y + s.h < view.y0) return;
    ctx.drawImage(s.img, s.sx, s.sy, s.w, s.h, x, y, s.w, s.h);
  }

  /** วงแหวนใต้เท้า (เลือก = เหลือง · ชี้ = ขาว) — วาดก่อนตัวละคร จึงอยู่ "บนพื้น" ไม่ทับตัว */
  function drawRing(x, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x - 4, y - 2, 8, 1);
    ctx.fillRect(x - 4, y + 1, 8, 1);
    ctx.fillRect(x - 5, y - 1, 1, 2);
    ctx.fillRect(x + 4, y - 1, 1, 2);
  }

  function drawCharacter(ch, rx, ry) {
    const a = num(ch.alpha, 1);
    if (a <= 0.02) return;
    const x = rx + Math.round(num(ch.x)) + shakeOf(ch);
    const y = ry + Math.round(num(ch.y));
    if (x + 12 < view.x0 || x - 12 > view.x1 || y - 26 > view.y1 || y + 4 < view.y0) return;
    const info = sprites.poseInfo(ch.pose);
    ctx.globalAlpha = clamp(a, 0, 1);
    if (!info.seated) {
      /* เงาใต้เท้า: ทำให้คนเดิน "แตะพื้น" ไม่ลอยอยู่บนลายไม้ */
      ctx.fillStyle = "rgba(26,28,44,0.35)";
      ctx.fillRect(x - 5, y - 1, 10, 2);
      ctx.fillRect(x - 4, y + 1, 8, 1);
      if (ch.key === selected) drawRing(x, y, "#ffcd75");
      else if (ch.key === hovered) drawRing(x, y, "rgba(244,244,244,0.85)");
    }
    charOpts.item = ch.item || null;
    charOpts.face = ch.face || null;
    const f = sprites.character(lookOf(ch), ch.pose, ch.dir, ch.frame, charOpts);
    ctx.drawImage(f.img, f.sx, f.sy, f.w, f.h, x - f.ax, y - f.ay, f.w, f.h);
    ctx.globalAlpha = 1;
  }

  /**
   * เมฆฝน/zZz ที่ world วางไว้เหนือหัวพอดี (y−30) ตรงกับที่ฟองไอคอนอยู่ (y−38…y−24) — ถ้าเจ้าของมีฟอง
   * อยู่ด้วย (เช่น ติดด่าน = ฝน + ป้ายเตือน) ฟองที่วาดทีหลังจะบังเมฆมิด ⇒ ยกเมฆขึ้นไปเหนือฟองแทน
   */
  const WEATHER = new Set(["rain", "storm", "zzz"]);
  /** key ของตัวที่เมฆถูกยกขึ้นในเฟรมนี้ — ชั้นตัวหนังสือต้องดันป้ายงานขึ้นตาม ไม่งั้นป้ายทับเมฆ */
  const lifted = new Set();
  /** key ของตัวที่มีเมฆ/zZz อยู่เหนือหัวในเฟรมนี้ (ยกหรือไม่ยกก็ตาม) — ป้ายงานต้องอยู่เหนือเมฆ */
  const weathered = new Set();
  /** ฟองแบบ "ข้างหัว" (world ตั้ง side:true เช่นติดด่าน) — เหนือหัวเป็นที่ของเมฆฝน ไม่ต้องยกเมฆหนีฟอง */
  function sideBubble(ch) {
    return isObj(ch.bubble) && ch.bubble.side === true;
  }
  function weatherLift(e, chars) {
    if (!WEATHER.has(e.kind) || !chars) return 0;
    for (const ch of chars) {
      if (num(ch.alpha, 1) < 0.3) continue;
      if (Math.abs(num(ch.x) - num(e.x)) <= 8 && Math.abs(num(ch.y) - 30 - num(e.y)) <= 12) {
        weathered.add(ch.key);
        if (!hasBubble(ch) || sideBubble(ch)) return 0;
        lifted.add(ch.key);
        return 17;
      }
    }
    return 0;
  }

  function drawEffect(e, rx, ry, chars) {
    /* t ติดลบ = เอฟเฟกต์ที่ world "นัดไว้" (เช่น หัวใจเด้งตอนกระดาษรายงานบินถึงมือผู้จ้าง) — ยังไม่ถึงเวลา */
    if (num(e.t) < 0) return;
    const ttl = num(e.ttl, 1) || 1;
    const p = clamp(num(e.t) / ttl, 0, 0.999);
    const probe = sprites.effect(e.kind, 0);
    const frames = Math.max(1, probe.frames | 0);
    const s = frames > 1 ? sprites.effect(e.kind, Math.floor(p * frames)) : probe;
    let x = num(e.x);
    let y = num(e.y);
    if (isObj(e.from) && isObj(e.to)) {
      /* จดหมาย/รายงานที่ "ลอย" จากคนหนึ่งไปอีกคน: เส้นตรง + โค้ง (world กำหนดความสูงตามระยะ ปกติ 10 px) */
      x = num(e.from.x) + (num(e.to.x) - num(e.from.x)) * p;
      y = num(e.from.y) + (num(e.to.y) - num(e.from.y)) * p - (RM ? 0 : Math.sin(p * Math.PI) * clamp(num(e.arc, 10), 0, 48));
    } else if (e.kind === "zzz" && !RM) {
      y -= p * 6; // zZz ลอยขึ้นช้า ๆ
    }
    y -= weatherLift(e, chars);
    const dx = rx + Math.round(x - s.w / 2);
    const dy = ry + Math.round(y - s.h / 2);
    if (dx > view.x1 || dy > view.y1 || dx + s.w < view.x0 || dy + s.h < view.y0) return;
    ctx.drawImage(s.img, s.sx, s.sy, s.w, s.h, dx, dy, s.w, s.h);
  }

  /** ตัวเลขบนป้ายคะแนน (ในโลก ด้วยฟอนต์ 3×5): "เสร็จ/ทั้งหมด" ของทีมผู้ช่วย — ส้มเมื่อมีตัวที่ล้มเหลว */
  function drawScore(room, rx, ry) {
    let sb = null;
    for (const p of room.props) {
      if (p.name === "scoreboard") {
        sb = p;
        break;
      }
    }
    if (!sb || !isObj(room.score)) return;
    const sc = room.score;
    const cap = (n) => Math.min(999, Math.max(0, Math.floor(num(n))));
    let text = `${cap(sc.done)}/${cap(sc.total)}`;
    /* หน้าจอของป้ายกว้าง 26 px (x 3–28 ใน sprite) — เกินก็เหลือแค่จำนวนที่เสร็จ ดีกว่าตัวเลขล้นกรอบ */
    if (sprites.drawTinyText(null, text, 0, 0) > 26) text = String(cap(sc.done));
    const w = sprites.drawTinyText(null, text, 0, 0);
    const spr = sprites.prop("scoreboard", sb.variant, 0);
    const x0 = rx + Math.round(sb.tx * TILE) + 3 + Math.floor((26 - w) / 2);
    const y0 = ry + (sb.ty + sb.fh) * TILE - spr.h + 4;
    const color = num(sc.failed) > 0 ? "#ef7d57" : num(sc.running) > 0 ? "#a7f070" : "#f4f4f4";
    sprites.drawTinyText(ctx, text, x0, y0, color);
  }

  function drawRoomWorld(room, chars) {
    const rx = Math.round(num(room.x));
    const ry = Math.round(num(room.y));
    const wpx = room.w * TILE;
    const hpx = room.h * TILE;
    /* ห้องที่อยู่นอกจอทั้งห้อง ข้ามทั้งหมด (ป้ายชื่อที่ลอยเหนือห้องวาดแยกในชั้นจอ) */
    if (rx > view.x1 || ry > view.y1 || rx + wpx < view.x0 || ry + hpx < view.y0) return;
    const b = bakeRoom(room);
    ctx.drawImage(b.canvas, rx, ry);
    drawScore(room, rx, ry);

    items.length = 0;
    for (const p of room.props) if (p.layer === "sorted") items.push(p);
    for (const ch of chars) items.push(ch);
    /* sort ของ JS คงลำดับเดิมเมื่อค่าเท่ากัน ⇒ เฟอร์นิเจอร์ (ใส่ก่อน) ชนะคนเมื่อ sortY เท่ากัน */
    items.sort(bySortY);
    for (const it of items) {
      try {
        if (it.layer) drawProp(it, rx, ry);
        else drawCharacter(it, rx, ry);
      } catch (err) {
        ctx.globalAlpha = 1;
        report(`draw ${it.layer ? it.name : it.key}`, err);
      }
    }
    for (const e of world.effects) {
      if (e.sessionId !== room.sessionId) continue;
      try {
        drawEffect(e, rx, ry, chars);
      } catch (err) {
        report(`effect ${e.kind}`, err);
      }
    }
    if (room.lightsOn === false) {
      /* ห้องปิดไฟ: หรี่ทั้งห้องครั้งเดียวด้วย multiply (สีเดียวกับที่ props.js ใช้หรี่เปลือกห้อง) */
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "#6874ac";
      ctx.fillRect(rx, ry, wpx, hpx);
      ctx.globalCompositeOperation = "source-over";
    }
  }

  /* ───────────── ฟองไอคอนเหนือหัว (ยังอยู่ในพิกัดโลก — เป็นภาพพิกเซลเหมือนตัวละคร) ───────────── */

  /** ตำแหน่งเท้าบนโลก (ปัดเป็นพิกเซลเต็ม + สั่น) — ใช้ร่วมกันทั้งฟองไอคอนและชั้นตัวหนังสือ */
  function feetOf(ch) {
    const room = world.rooms.get(ch.sessionId);
    if (!room) return null;
    return {
      x: Math.round(num(room.x)) + Math.round(num(ch.x)) + shakeOf(ch),
      y: Math.round(num(room.y)) + Math.round(num(ch.y)),
    };
  }

  /** มีฟอง (ไม่สนจังหวะกะพริบ) — ใช้จัดตำแหน่งป้าย/เมฆ ไม่ให้ป้ายกระโดดขึ้นลงตามจังหวะกะพริบของฟอง */
  function hasBubble(ch) {
    return isObj(ch.bubble) && num(ch.alpha, 1) >= 0.3;
  }

  function bubbleShown(ch) {
    const b = ch.bubble;
    if (!isObj(b) || num(ch.alpha, 1) < 0.3) return false;
    /* กระพริบ = "รอคุณอยู่นะ" — ผู้ใช้ที่ขอลดการเคลื่อนไหวได้ฟองนิ่ง (ความหมายยังอยู่ครบ) */
    if (b.blink && !RM && Math.floor(time * 2.5) % 2 === 1) return false;
    return true;
  }

  function drawBubbles(chars) {
    for (const ch of chars) {
      if (!bubbleShown(ch)) continue;
      const p = feetOf(ch);
      if (!p || p.x + 10 < view.x0 || p.x - 10 > view.x1 || p.y - 42 > view.y1 || p.y < view.y0) continue;
      const b = ch.bubble;
      try {
        const bs = sprites.bubble(b.kind, b.tone);
        /* ปลายหางของฟอง (แถว 14) แตะเหนือหัวพอดี: หัวเริ่มที่ y−23 · ฟองข้างหัว = ขวาของหัว ต่ำลงมาครึ่งฟอง */
        const side = b.side === true;
        const bx = side ? p.x + 8 : p.x - 7;
        const by = side ? p.y - 23 - bs.h + 8 : p.y - 23 - bs.h;
        ctx.globalAlpha = clamp(num(ch.alpha, 1), 0, 1) * (b.dim ? 0.55 : 1);
        ctx.drawImage(bs.img, bs.sx, bs.sy, bs.w, bs.h, bx, by, bs.w, bs.h);
        if (b.icon) {
          const ic = sprites.icon(b.icon);
          ctx.drawImage(ic.img, ic.sx, ic.sy, ic.w, ic.h, bx + bs.ix, by + bs.iy, ic.w, ic.h);
        }
      } catch (err) {
        report(`bubble ${ch.key}`, err);
      }
      ctx.globalAlpha = 1;
    }
  }

  /* ───────────── ชั้นตัวหนังสือบนจอ (device px — ตัวอักษรไทยคมที่ความละเอียดจริง) ───────────── */

  /** ความกว้างข้อความที่วัดแล้ว: measureText ช้า และป้ายงานร้อยป้ายวัดซ้ำทุกเฟรมไม่ไหว */
  const widths = new Map();
  let fontNow = "";
  function setFont(px, bold) {
    const f = `${bold ? "700 " : ""}${Math.round(px)}px ${FONT_STACK}`;
    if (f !== fontNow) {
      ctx.font = f;
      fontNow = f;
    }
    return f;
  }
  function measure(text) {
    const k = `${fontNow}\u0001${text}`;
    let w = widths.get(k);
    if (w === undefined) {
      if (widths.size > 1500) widths.clear(); // นาฬิกาในป้ายเปลี่ยนทุกวินาที — ล้างทั้งก้อนถูกกว่าทำ LRU
      w = ctx.measureText(text).width;
      widths.set(k, w);
    }
    return w;
  }
  /** ตัดข้อความให้พอดีความกว้าง (ตัดตาม code point ไม่ผ่ากลางอีโมจิ) */
  function fitText(text, maxW) {
    if (measure(text) <= maxW) return text;
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measure(chars.slice(0, mid).join("") + "…") <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? chars.slice(0, lo).join("") + "…" : "…";
  }

  /** กล่องสไตล์พิกเซล: พื้น #1a1c2c ~0.9 · ขอบ 1 px · เงาแข็ง 2 px (ตามสเปกภาษาภาพ) */
  function plate(x, y, w, h, border, fill = "rgba(26,28,44,0.92)") {
    const u = Math.max(1, Math.round(dpr));
    x = Math.round(x);
    y = Math.round(y);
    w = Math.round(w);
    h = Math.round(h);
    ctx.fillStyle = "rgba(11,12,20,0.85)";
    ctx.fillRect(x + 2 * u, y + 2 * u, w, h);
    ctx.fillStyle = border;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = fill;
    ctx.fillRect(x + u, y + u, w - 2 * u, h - 2 * u);
  }

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const pad = (n) => String(n).padStart(2, "0");
    if (m >= 60) return `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}`;
    return `${m}:${pad(s % 60)}`;
  }

  /** ป้ายชื่อห้องลอยเหนือขอบบนของห้อง + จุดคลิกเพื่อเล็งห้อง */
  const plateHits = [];
  function drawRoomPlate(room) {
    const u = dpr;
    const sx = Math.round(num(room.x)) * z + ox;
    const sy = Math.round(num(room.y)) * z + oy;
    const roomW = room.w * TILE * z;
    if (sx > W || sx + roomW < 0 || sy > H + 24 * u || sy + room.h * TILE * z < 0) return;
    const h = Math.round(20 * u);
    const y = Math.round(sy - h - 4 * u);
    const pad = Math.round(6 * u);
    setFont(11 * u, true);
    /* ยังไม่รู้รุ่นโมเดล (transcript ยังไม่มีข้อความจากโมเดล) — ขีดว่าง ไม่ใช่ "??" ที่ดูเหมือนของพัง */
    const tag = room.modelTag || "—";
    const chipW = Math.round(measure(tag) + 8 * u);
    const st = room.alive === false ? ["ปิดแล้ว", "#94b0c2"] : STATE_LABEL[room.state] || STATE_LABEL.unknown;
    setFont(12 * u, false);
    const stW = measure(st[0]);
    const maxW = Math.max(120 * u, roomW);
    setFont(12 * u, true);
    const titleMax = maxW - chipW - stW - pad * 4;
    const title = fitText(oneLine(room.title) || String(room.sessionId).slice(0, 8), Math.max(24 * u, titleMax));
    const titleW = measure(title);
    let sub = "";
    let subW = 0;
    let subColor = "#94b0c2";
    const spare = maxW - (chipW + titleW + stW + pad * 5);
    /*
     * ซูม 1 ป้ายงานเหนือหัวถูกซ่อน (ตัวละครสูง 24 px ป้ายจะบังทั้งห้อง) — ย้าย "หัวหน้ากำลังทำอะไร" มาไว้บนป้าย
     * ชื่อห้องแทน ข้อความเดียวกับ caption จริงทุกตัวอักษร (ไม่ประดิษฐ์อะไรเพิ่ม) + จำนวนผู้ช่วยที่ทำงานจริง
     */
    const act = z < 2 && captionMode !== "none" ? plateActivity(room) : "";
    if (act && spare > 40 * u) {
      setFont(11 * u, false);
      sub = fitText(act, spare - pad);
      subW = measure(sub) + pad;
      subColor = "#dfe8ee";
    } else if (z >= 2 && room.subtitle && spare > 60 * u) {
      setFont(11 * u, false);
      sub = fitText(oneLine(room.subtitle), spare - pad);
      subW = measure(sub) + pad;
    }
    const w = Math.round(pad + chipW + pad + titleW + pad + stW + pad + (sub ? subW : 0));
    /* ห้องล้นจอซ้าย (ลาก/ซูมอยู่): ป้ายเลื่อนตามเข้ามาในจอ แต่ไม่เลยขอบขวาของห้องตัวเอง */
    const x = Math.round(Math.max(sx, Math.min(4 * u, sx + roomW - w)));
    plate(x, y, w, h, st[1]);
    const cy = y + h / 2;
    ctx.textBaseline = "middle";
    // ชิปรุ่นโมเดล (สีเดียวกับเสื้อของตัวละครในห้อง)
    ctx.fillStyle = accentOf(room.modelTag);
    ctx.fillRect(x + pad, Math.round(y + 4 * u), chipW, h - Math.round(8 * u));
    setFont(11 * u, true);
    ctx.fillStyle = "#f4f4f4";
    ctx.fillText(tag, x + pad + 4 * u, cy);
    setFont(12 * u, true);
    ctx.fillStyle = room.alive === false ? "#94b0c2" : "#f4f4f4";
    let cx = x + pad + chipW + pad;
    ctx.fillText(title, cx, cy);
    cx += titleW + pad;
    setFont(12 * u, false);
    ctx.fillStyle = st[1];
    ctx.fillText(st[0], cx, cy);
    cx += stW + pad;
    if (sub) {
      setFont(11 * u, false);
      ctx.fillStyle = subColor;
      ctx.fillText(sub, cx, cy);
    }
    plateHits.push({ x, y, w, h, sessionId: room.sessionId });
  }

  /** กิจกรรมของหัวหน้าแบบย่อสำหรับป้ายชื่อห้อง (ใช้ caption จริงชุดเดียวกับป้ายเหนือหัว) */
  function plateActivity(room) {
    if (room.alive === false) return "";
    const lead = world.characters.get(room.sessionId);
    if (!lead || lead.leaving) return "";
    let t = captionText(lead);
    if (!t) return "";
    if (lead.captionNote) t += ` · ${oneLine(lead.captionNote)}`;
    /* คุมงานอยู่ = caption บอกจำนวนผู้ช่วยแล้ว ไม่ต้องซ้ำ */
    const n = isObj(room.score) ? Math.floor(num(room.score.running)) : 0;
    if (n > 0 && room.state !== "delegating") t += ` · ผู้ช่วย ${n}`;
    return t;
  }

  /** ป้าย "ปิดแล้ว · N นาทีก่อน" กลางห้องที่ session จบแล้ว + ป้าย "+N ที่ไม่ได้วาด" มุมล่างขวา */
  function drawRoomSigns(room) {
    const u = dpr;
    const sx = Math.round(num(room.x)) * z + ox;
    const sy = Math.round(num(room.y)) * z + oy;
    const rw = room.w * TILE * z;
    const rh = room.h * TILE * z;
    if (sx > W || sy > H || sx + rw < 0 || sy + rh < 0) return;
    ctx.textBaseline = "middle";
    if (room.alive === false) {
      const ago = endedAgoText(room.endedAgo);
      const text = ago ? `ปิดแล้ว · ${ago}` : "ปิดแล้ว";
      setFont(14 * u, true);
      const w = measure(text) + 20 * u;
      const h = 28 * u;
      const x = sx + rw / 2 - w / 2;
      const y = sy + rh / 2 - h / 2;
      plate(x, y, w, h, "#566c86");
      ctx.fillStyle = "#ffcd75";
      ctx.fillText(text, Math.round(x + 10 * u), Math.round(y + h / 2));
    }
    const over = Math.floor(num(room.overflow));
    if (over > 0) {
      const text = `+${over} ที่ไม่ได้วาด`;
      setFont(11 * u, true);
      const w = measure(text) + 12 * u;
      const h = 18 * u;
      /* มุมล่างขวาเหนือผนังหน้า — ตรงนั้นเป็นพื้นว่าง ไม่บังโต๊ะผู้ช่วยหรือโซนหัวหน้า */
      const x = sx + rw - w - TILE * z - 4 * u;
      const y = sy + rh - TILE * z - h - 4 * u;
      plate(x, y, w, h, "#ffcd75");
      ctx.fillStyle = "#ffcd75";
      ctx.fillText(text, Math.round(x + 6 * u), Math.round(y + h / 2));
    }
  }

  /** ป้ายงาน: เห็นเมื่อไหร่ตามโหมด (auto: หัวหน้าที่ซูม ≥2 · ผู้ช่วยเมื่อเลือก/ชี้ หรือซูม ≥4) */
  function captionVisible(ch) {
    if (captionMode === "none") return false;
    if (captionMode === "all") return true;
    if (ch.key === selected || ch.key === hovered) return true;
    if (ch.role === "lead") return z >= 2;
    /* ผู้ช่วยที่ส่งงานเสร็จแล้วกำลังเดินออก: กระดาษในมือ + ท่าดีใจเล่าเรื่องครบแล้ว ป้ายซ้ำจะรกเปล่า ๆ */
    return z >= 4 && !ch.leaving;
  }

  /** กล่องป้ายที่วาดไปแล้วในเฟรมนี้ — ป้ายทั่วไปที่ชนกล่องเดิมจะถูกข้าม (ตัวที่เลือก/ชี้วาดทับได้เสมอ) */
  const placed = [];
  function overlapsPlaced(x, y, w, h) {
    for (let i = 0; i < placed.length; i += 4) {
      if (x < placed[i] + placed[i + 2] && x + w > placed[i] && y < placed[i + 1] + placed[i + 3] && y + h > placed[i + 1]) {
        return true;
      }
    }
    return false;
  }

  function captionText(ch) {
    const c = ch.caption;
    if (!isObj(c) || !c.text) return "";
    let t = `${c.icon ? c.icon + " " : ""}${oneLine(c.text)}`;
    /* นาฬิกาเดินจากเวลาเริ่มจริงใน snapshot (นาฬิกา server) — ภาพย้อนหลังไม่มีนาฬิกา เพราะมันจบไปแล้ว */
    const since = num(c.sinceMs, 0);
    const now = world.nowMs();
    if (!c.replay && since > 0 && now > 0) t += ` · ${fmtElapsed(now - since)}`;
    return t;
  }

  /*
   * กล่องหัว + ฟองไอคอนของตัวละครที่มองเห็นในเฟรมนี้ (device px) — ป้ายของ "คนอื่น" ห้ามทับหน้าใคร
   * (เดิมที่ซูม 4 ป้ายของผู้ช่วยทุกคนโผล่พร้อมกัน ป้าย "รันคำสั่ง Bash…" คร่อมหัวคนนั่งแถวบน ภาพกลายเป็นกองป้าย)
   */
  const heads = []; // [x, y, w, h, …]
  const headOwner = []; // key ต่อกล่อง (กล่องของตัวเองไม่นับเป็นสิ่งกีดขวางของป้ายตัวเอง)
  function collectHeads(chars) {
    heads.length = 0;
    headOwner.length = 0;
    for (const ch of chars) {
      if (num(ch.alpha, 1) < 0.3) continue;
      const p = feetOf(ch);
      if (!p) continue;
      const sx = p.x * z + ox;
      const sy = p.y * z + oy;
      if (sx < -24 * z || sx > W + 24 * z || sy < -8 * z || sy > H + 48 * z) continue;
      /* หัว chibi ≈ 12×12 px อยู่เหนือเท้า 11–23 px (ท่านั่งใช้จุดยึดเดียวกัน หัวจึงอยู่แถวเดียวกันพอดี) */
      heads.push(Math.round((p.x - 6) * z + ox), Math.round((p.y - 23) * z + oy), 12 * z, 12 * z);
      headOwner.push(ch.key);
      if (hasBubble(ch) && !sideBubble(ch)) {
        heads.push(Math.round((p.x - 7) * z + ox), Math.round((p.y - 38) * z + oy), 15 * z, 15 * z);
        headOwner.push(ch.key);
      }
    }
  }
  function hitsHead(x, y, w, h, ownerKey) {
    for (let i = 0, j = 0; i < heads.length; i += 4, j++) {
      if (headOwner[j] === ownerKey) continue;
      if (x < heads[i] + heads[i + 2] && x + w > heads[i] && y < heads[i + 1] + heads[i + 3] && y + h > heads[i + 1]) return true;
    }
    return false;
  }

  function paintCaption(ch, shown, x, y, w, h, emphasis) {
    const u = dpr;
    const c = ch.caption;
    placed.push(x, y, w, h);
    const tone = c.replay ? "#94b0c2" : TONE_COLOR[c.tone] || TONE_COLOR.neutral;
    ctx.globalAlpha = clamp(num(ch.alpha, 1), 0.35, 1) * (c.replay ? 0.85 : 1);
    plate(x, y, w, h, emphasis ? "#ffcd75" : tone);
    ctx.fillStyle = c.replay ? "#c9d6df" : "#f4f4f4";
    ctx.textBaseline = "middle";
    ctx.fillText(shown, x + 6 * u, Math.round(y + h / 2));
    ctx.globalAlpha = 1;
  }

  /**
   * ป้ายเหนือหัว 1 ป้าย (มีการหลบ) → คืนขอบบนของสิ่งที่วาด (ให้ป้ายเสริม/ฟองคำพูดซ้อนต่อด้านบน)
   *   mode "full": ข้อความเต็ม — ลองกลางหัว → (หัวหน้า/ตัวที่เลือก) เลื่อนซ้าย/ขวาหลบ → ชนหมด → ชิปไอคอน
   *   mode "chip": ไอคอนอย่างเดียว (ผู้ช่วยที่ซูม 4 — ข้อความเต็มเห็นเมื่อซูม ≥5 หรือชี้/เลือก)
   *   ชิปก็ชน → ไม่วาด (ผู้ช่วย) · หัวหน้ายอมให้ชิปคร่อมหัวคนอื่นได้ (ห้องละคนเดียว ต้องรู้ว่าทำอะไรอยู่)
   *   ตัวที่เลือก/ชี้ (emphasis): ข้างบนทับหัวคนอื่น → ลองใต้เท้า → ไม่ได้อีกก็วางข้างบนทับไปเลย (ผู้ใช้ต้องอ่านได้)
   */
  function drawCaption(ch, headY, cx, feetY, emphasis, mode) {
    const text = captionText(ch);
    if (!text) return headY;
    const u = dpr;
    const h = 18 * u;
    if (mode === "full") {
      setFont(12 * u, emphasis);
      /*
       * ป้ายของผู้ช่วยที่ไม่ได้เลือกกว้างไม่เกินระยะห่างโต๊ะ (3 ช่อง) — ไม่งั้นแถวผู้ช่วยป้ายชนกันเป็นพืด
       * หัวหน้ามีห้องละคนเดียวและยืนอยู่โซนของตัวเอง จึงได้ป้ายกว้างพอให้อ่าน tool + label + นาฬิกาครบ
       */
      const maxW = emphasis ? 300 * u : ch.role === "lead" ? 240 * u : Math.max(90 * u, 3 * TILE * z - 6 * u);
      const shown = fitText(text, maxW - 12 * u);
      const w = Math.round(measure(shown) + 12 * u);
      const yAbove = Math.round(headY - h - 3 * u);
      const x0 = Math.round(cx - w / 2);
      const xs = ch.role === "lead" || emphasis ? [x0, Math.round(cx - w + 14 * u), Math.round(cx - 14 * u)] : [x0];
      for (const x of xs) {
        if (overlapsPlaced(x, yAbove, w, h) || hitsHead(x, yAbove, w, h, ch.key)) continue;
        paintCaption(ch, shown, x, yAbove, w, h, emphasis);
        return yAbove;
      }
      if (emphasis) {
        const yBelow = Math.round(feetY + 4 * u);
        if (!overlapsPlaced(x0, yBelow, w, h) && !hitsHead(x0, yBelow, w, h, ch.key)) {
          paintCaption(ch, shown, x0, yBelow, w, h, emphasis);
          return headY;
        }
        paintCaption(ch, shown, x0, yAbove, w, h, emphasis);
        return yAbove;
      }
    }
    /* ชิปไอคอน: บอก "ทำงานประเภทไหน" ได้ในพื้นที่เท่าหัวคนเดียว */
    const c = ch.caption;
    const icon = oneLine(c.icon) || "•";
    setFont(12 * u, false);
    const cw = Math.round(measure(icon) + 8 * u);
    const chH = Math.round(16 * u);
    const x = Math.round(cx - cw / 2);
    const y = Math.round(headY - chH - 2 * u);
    if (overlapsPlaced(x, y, cw, chH)) return headY;
    if (ch.role !== "lead" && hitsHead(x, y, cw, chH, ch.key)) return headY;
    placed.push(x, y, cw, chH);
    const tone = c.replay ? "#94b0c2" : TONE_COLOR[c.tone] || TONE_COLOR.neutral;
    ctx.globalAlpha = c.replay ? 0.85 : 1;
    plate(x, y, cw, chH, tone);
    ctx.fillStyle = "#f4f4f4";
    ctx.textBaseline = "middle";
    ctx.fillText(icon, x + 4 * u, Math.round(y + chH / 2));
    ctx.globalAlpha = 1;
    return y;
  }

  /** ป้ายเสริมเล็กเหนือป้ายงาน (ข้อความจริงของเหตุการณ์ที่ภาพกำลังเล่า) — ตัวเล็กกว่า ขอบสีฟ้า */
  function drawNote(ch, topY, cx, emphasis) {
    const text = oneLine(ch.captionNote);
    if (!text) return topY;
    const u = dpr;
    setFont(11 * u, false);
    const shown = fitText(text, (emphasis ? 300 : 240) * u - 10 * u);
    const w = measure(shown) + 10 * u;
    const h = 16 * u;
    const x = Math.round(cx - w / 2);
    const y = Math.round(topY - h - 2 * u);
    if (!emphasis && overlapsPlaced(x, y, w, h)) return topY;
    placed.push(x, y, w, h);
    ctx.globalAlpha = clamp(num(ch.alpha, 1), 0.35, 1);
    plate(x, y, w, h, TONE_COLOR.info);
    ctx.fillStyle = "#c9d6df";
    ctx.textBaseline = "middle";
    ctx.fillText(shown, x + 5 * u, Math.round(y + h / 2));
    ctx.globalAlpha = 1;
    return y;
  }

  /** ฟองคำพูดตัวหนังสือ (จาก event `say`) — กล่องขาวมีหางชี้ลงหาหัว */
  function drawSpeech(ch, topY, cx, emphasis) {
    const sp = ch.speech;
    if (!isObj(sp) || !sp.text) return topY;
    const u = dpr;
    setFont(12 * u, false);
    const shown = fitText(`“${oneLine(sp.text)}”`, 240 * u);
    const w = measure(shown) + 14 * u;
    const h = 20 * u;
    const x = Math.round(cx - w / 2);
    const y = Math.round(topY - h - 7 * u);
    if (!emphasis && overlapsPlaced(x, y, w, h + 6 * u)) return topY;
    placed.push(x, y, w, h + 6 * u);
    ctx.globalAlpha = clamp(num(ch.alpha, 1), 0.35, 1);
    plate(x, y, w, h, "#1a1c2c", "#f4f4f4");
    // หางสามเหลี่ยมแบบขั้นบันได (พิกเซล) ชี้ลง
    ctx.fillStyle = "#1a1c2c";
    const tx = Math.round(cx);
    const step = Math.max(1, Math.round(2 * u));
    for (let i = 0; i < 3; i++) ctx.fillRect(tx - (3 - i) * step, y + h + i * step, (3 - i) * 2 * step, step);
    ctx.fillStyle = "#f4f4f4";
    for (let i = 0; i < 2; i++) ctx.fillRect(tx - (2 - i) * step, y + h - step + i * step, (2 - i) * 2 * step, step);
    ctx.fillStyle = "#1a1c2c";
    ctx.textBaseline = "middle";
    ctx.fillText(shown, x + 7 * u, Math.round(y + h / 2));
    ctx.globalAlpha = 1;
    return y;
  }

  /** มุมเล็งสี่มุมรอบตัวที่เลือก/ชี้ — วาดบนสุด จึงเห็นแม้ตัวนั้นนั่งหลังโต๊ะ (วงแหวนที่เท้าโดนโต๊ะบัง) */
  function drawBrackets(p, color, thick) {
    const x0 = (p.x - 8) * z + ox;
    const x1 = (p.x + 8) * z + ox;
    const y0 = (p.y - 25) * z + oy;
    const y1 = (p.y + 2) * z + oy;
    const t = Math.max(1, Math.round(thick * dpr));
    const len = Math.max(4 * dpr, 3 * z);
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, len, t);
    ctx.fillRect(x0, y0, t, len);
    ctx.fillRect(x1 - len, y0, len, t);
    ctx.fillRect(x1 - t, y0, t, len);
    ctx.fillRect(x0, y1 - t, len, t);
    ctx.fillRect(x0, y1 - len, t, len);
    ctx.fillRect(x1 - len, y1 - t, len, t);
    ctx.fillRect(x1 - t, y1 - len, t, len);
  }

  /**
   * รูปแบบป้ายของตัวละครนี้ในเฟรมนี้: null (ไม่มีป้าย) · "full" · "chip"
   * กำลังจางเข้า/ออก (alpha < 1) → ไม่มีป้าย — เดิมผู้ช่วยที่เพิ่งเข้าประตูพร้อมกันมีป้าย "คิดอยู่" โปร่งแสง
   * ซ้อนกันเป็นตั้งบนธรณีประตู · ผู้ช่วยที่ซูม 4 ได้แค่ชิปไอคอน ข้อความเต็มที่ซูม ≥5 (หรือโหมด "all")
   */
  function captionStyle(ch, emphasis) {
    if (!captionVisible(ch)) return null;
    if (emphasis) return "full";
    if (num(ch.alpha, 1) < 0.999) return null;
    if (ch.role === "lead" || captionMode === "all") return "full";
    return z >= 5 ? "full" : "chip";
  }

  function drawOverlayFor(ch, emphasis) {
    const p = feetOf(ch);
    if (!p) return;
    const sx = p.x * z + ox;
    const sy = p.y * z + oy;
    if (sx < -200 * dpr || sx > W + 200 * dpr || sy < -40 * dpr || sy > H + 400 * dpr) return;
    if (ch.key === selected) drawBrackets(p, "#ffcd75", 2);
    else if (ch.key === hovered) drawBrackets(p, "rgba(244,244,244,0.8)", 1);
    let top = (p.y - 23) * z + oy;
    if (hasBubble(ch) && !sideBubble(ch)) top -= 16 * z;
    if (weathered.has(ch.key)) top -= 15 * z;
    const style = captionStyle(ch, emphasis);
    if (style) {
      const before = top;
      top = drawCaption(ch, top, sx, sy + 2 * z, emphasis, style);
      /* ป้ายเสริมของบทที่กำลังเล่น (เช่น "📬 คำสั่งใหม่: …" ตอนอ่านจดหมาย) ซ้อนเหนือป้ายงาน (เฉพาะป้ายเต็ม) */
      if (ch.captionNote && style === "full" && top !== before) top = drawNote(ch, top, sx, emphasis);
    }
    /* คำพูดสั้น ๆ มีความหมายกว่าป้ายงาน แต่ที่ซูม 1 จะกลายเป็นกำแพงข้อความ — เห็นเมื่อซูม ≥2 หรือเลือก/ชี้ */
    if (ch.speech && (z >= 2 || emphasis) && (emphasis || num(ch.alpha, 1) >= 0.999)) drawSpeech(ch, top, sx, emphasis);
  }

  function drawOverlaySafe(ch, emphasis) {
    try {
      drawOverlayFor(ch, emphasis);
    } catch (err) {
      ctx.globalAlpha = 1;
      report(`caption ${ch.key}`, err);
    }
  }

  function drawScreenPass(chars) {
    plateHits.length = 0;
    placed.length = 0;
    for (const room of world.rooms.values()) {
      try {
        drawRoomPlate(room);
        drawRoomSigns(room);
      } catch (err) {
        report(`room plate ${room.sessionId}`, err);
      }
    }
    /*
     * declutter: วาดตามลำดับความสำคัญ แล้วป้ายที่มาทีหลังต้องหลบป้ายที่วางไปแล้ว + หัว/ฟองของคนอื่น
     *   ตัวที่เลือก → ตัวที่ชี้ → หัวหน้า → ผู้ช่วยที่สถานี → ผู้ช่วยที่นั่งโต๊ะ → ผู้ช่วยที่กำลังเดิน
     * ⇒ ป้ายของตัวที่ผู้ใช้สนใจไม่เคยถูกป้ายอื่นแย่งที่ · ห้องแน่น ๆ ยังเห็นว่าหัวหน้าทำอะไร
     *   · ป้ายชื่อห้องที่วาดไปก่อนแล้วก็เป็นสิ่งกีดขวาง (ป้ายงานห้ามทับชื่อห้อง)
     */
    let selCh = null;
    let hovCh = null;
    overlayOrder.length = 0;
    for (const ch of chars) {
      if (ch.key === selected) selCh = ch;
      else if (ch.key === hovered) hovCh = ch;
      else if (captionVisible(ch) || ch.speech) overlayOrder.push(ch);
    }
    /* ซูม 1 ส่วนใหญ่ไม่มีป้ายให้วาดเลย — ไม่ต้องไล่เก็บกล่องหัวของ 240 ตัวทุกเฟรม */
    if (!selCh && !hovCh && !overlayOrder.length) return;
    collectHeads(chars);
    for (const ph of plateHits) placed.push(ph.x, ph.y, ph.w, ph.h);
    /* sort ของ JS คงลำดับเดิมเมื่อค่าเท่ากัน ⇒ ลำดับในกลุ่มเดียวกันนิ่งทุกเฟรม ป้ายไม่กะพริบสลับกัน */
    overlayOrder.sort((a, b) => overlayRank(a) - overlayRank(b));
    try {
      if (selCh) drawOverlayFor(selCh, true);
      if (hovCh) drawOverlayFor(hovCh, true);
    } catch (err) {
      ctx.globalAlpha = 1;
      report("caption (selected)", err);
    }
    for (const ch of overlayOrder) drawOverlaySafe(ch, false);
    overlayOrder.length = 0;
    ctx.globalAlpha = 1;
  }

  const overlayOrder = [];
  const SEATED_POSES = new Set(["sit-type", "sit-think", "sit-idle", "sit-slump", "sit-sleep"]);
  function overlayRank(ch) {
    if (ch.role === "lead") return 0;
    if (ch.moving || ch.pose === "walk") return 3;
    return SEATED_POSES.has(ch.pose) ? 2 : 1;
  }

  /* ───────────── ป้ายขอบจอ: ห้องที่ "ต้องการคุณ" แต่อยู่นอกส่วนที่มองเห็น ───────────── */

  /*
   * กฎกล้อง: ห้ามเลื่อนกล้องไปหาเองเพราะเหตุการณ์ — แต่ห้องที่ "รอคุณตอบ / รออนุญาต / ติดด่าน" คือสิ่งเดียว
   * ที่ออฟฟิศต้องบอกให้ได้ แม้ห้องนั้นจะล้นลงใต้ฟีดหรือออกนอกจอ (ออฟฟิศ 5 ห้องขึ้นไปบนจอแล็ปท็อป)
   * ⇒ ถ้าหัวหน้าของห้องนั้นไม่อยู่ในส่วนที่มองเห็นจริง (นอก canvas หรือใต้แผง HUD) วาดป้ายเล็กชิดขอบของ
   *   พื้นที่ที่มองเห็น ชี้ทิศไปหาห้อง ("🙋 nova-73 ↓") — คลิกป้าย = เล็งห้องนั้น (การกระทำของผู้ใช้เอง)
   *   ภาพกล้องไม่ขยับสักพิกเซลจนกว่าผู้ใช้จะคลิก
   */
  const ATTN_STATES = new Set(["waiting", "blocked"]);
  /** กล่องป้ายขอบจอในเฟรมล่าสุด (device px) สำหรับคลิก/ชี้ */
  const edgeHits = [];
  /** sessionId ของห้องที่มีป้ายขอบจออยู่ตอนนี้ (main.js ส่งต่อให้ HUD ทำแถวรายชื่อห้องกระพริบ) */
  let attentionIds = [];

  /** กล่องแผง HUD ที่บัง canvas อยู่ (CSS px → device px) — main.js วัดจาก DOM จริง */
  function occluders() {
    if (typeof opts.occluders !== "function") return [];
    let list = null;
    try {
      list = opts.occluders();
    } catch (err) {
      report("occluders", err);
    }
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const r of list) {
      if (!isObj(r)) continue;
      const x0 = num(r.left, NaN) * dpr;
      const y0 = num(r.top, NaN) * dpr;
      const x1 = num(r.right, NaN) * dpr;
      const y1 = num(r.bottom, NaN) * dpr;
      if (Number.isFinite(x0 + y0 + x1 + y1) && x1 > x0 && y1 > y0) out.push({ x0, y0, x1, y1 });
    }
    return out;
  }

  /** จุดที่ต้องมองเห็น (device px): กลางตัวหัวหน้า · ยังไม่มีหัวหน้าให้เห็น → บูธโทรศัพท์ของห้อง */
  function attentionPoint(room) {
    const lead = world.characters.get(room.sessionId);
    if (lead && !lead.leaving && num(lead.alpha, 1) > 0.3) {
      const p = feetOf(lead);
      if (p) return { x: p.x * z + ox, y: (p.y - 12) * z + oy };
    }
    return { x: (num(room.x) + 20 * TILE) * z + ox, y: (num(room.y) + 3 * TILE + 8) * z + oy };
  }

  function pointVisible(x, y, occ) {
    const m = 6 * dpr;
    if (x < m || y < m || x > W - m || y > H - m) return false;
    for (const r of occ) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return false;
    return true;
  }

  /** ลูกศร 8 ทิศจากป้ายไปหาห้อง */
  function arrowFor(dx, dy) {
    const a = Math.atan2(dy, dx);
    const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    return ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"][i];
  }

  function drawEdgeBadges() {
    edgeHits.length = 0;
    const ids = [];
    const list = [];
    for (const room of world.rooms.values()) if (room.alive !== false && ATTN_STATES.has(room.state)) list.push(room);
    if (!list.length) {
      attentionIds = ids;
      return;
    }
    list.sort((a, b) => num(a.slot) - num(b.slot));
    /* วัดแผง HUD เฉพาะตอนมีห้องที่ต้องตรวจ (ส่วนใหญ่ไม่มีเลย) */
    const occ = occluders();
    const r = safeRect();
    const u = dpr;
    for (const room of list) {
      const pt = attentionPoint(room);
      if (pointVisible(pt.x, pt.y, occ)) continue;
      ids.push(room.sessionId);
      const lead = world.characters.get(room.sessionId);
      const blocked = room.state === "blocked";
      const icon = blocked ? "⛔" : lead && isObj(lead.caption) && lead.caption.icon === "✋" ? "✋" : "🙋";
      const h = Math.round(22 * u);
      const m = Math.round(8 * u);
      /* ทิศลูกศรคิดจากจุดกึ่งกลางของพื้นที่ที่มองเห็น (คงที่ระหว่างวางป้าย) ไปหาหัวหน้าห้องนั้น */
      const arrow = arrowFor(pt.x - (r.x + r.w / 2), pt.y - (r.y + r.h / 2));
      setFont(12 * u, true);
      const title = fitText(oneLine(room.title) || String(room.sessionId).slice(0, 8), 150 * u);
      const text = `${icon} ${title} ${arrow}`;
      const w = Math.round(measure(text) + 16 * u);
      const x = Math.round(clamp(pt.x - w / 2, r.x + m, r.x + r.w - m - w));
      const baseY = Math.round(clamp(pt.y - h / 2, r.y + m, r.y + r.h - m - h));
      let y = baseY;
      /* ป้ายหลายห้องชี้ไปทางเดียวกัน → เรียงสลับขึ้น/ลงทีละช่อง (ไม่ซ้อนทับจนอ่านชื่อไม่ออก) */
      const hit = (yy) => edgeHits.some((e) => x < e.x + e.w && x + w > e.x && yy < e.y + e.h && yy + h > e.y);
      for (let k = 1; k <= 10 && hit(y); k++) {
        const off = Math.ceil(k / 2) * (h + 4 * u) * (k % 2 ? -1 : 1);
        y = Math.round(clamp(baseY + off, r.y + m, r.y + r.h - m - h));
      }
      /* กระพริบขอบช้า ๆ ให้สะดุดตา (ปิดเมื่อผู้ใช้ขอลดการเคลื่อนไหว — สีขอบยังบอกความหมายครบ) */
      const pulse = !RM && Math.floor(time * 2) % 2 === 1;
      const tone = blocked ? TONE_COLOR.bad : TONE_COLOR.warn;
      plate(x, y, w, h, pulse ? "#f4f4f4" : tone);
      ctx.textBaseline = "middle";
      ctx.fillStyle = blocked ? "#ef7d57" : "#ffcd75";
      ctx.fillText(text, x + 8 * u, Math.round(y + h / 2));
      edgeHits.push({ x, y, w, h, sessionId: room.sessionId });
    }
    attentionIds = ids;
  }

  function edgeAt(x, y) {
    const px = x * dpr;
    const py = y * dpr;
    for (let i = edgeHits.length - 1; i >= 0; i--) {
      const e = edgeHits[i];
      if (px >= e.x && px <= e.x + e.w && py >= e.y && py <= e.y + e.h) return e.sessionId;
    }
    return null;
  }

  /* ───────────── วาดหนึ่งเฟรม ───────────── */

  const allChars = [];
  const EMPTY = [];
  let houseTimer = 0;

  /** ล้างแคชของห้อง/ตัวละครที่หายไปแล้ว (ทุก ~5 วิ ไม่ต้องทุกเฟรม) */
  function housekeeping() {
    for (const sid of Array.from(bakes.keys())) if (!world.rooms.has(sid)) bakes.delete(sid);
    for (const sid of Array.from(byRoom.keys())) if (!world.rooms.has(sid)) byRoom.delete(sid);
    for (const k of Array.from(looks.keys())) if (!world.characters.has(k)) looks.delete(k);
  }

  function render(dt) {
    if (disposed) return;
    const step = clamp(num(dt), 0, 0.25);
    time += step;
    houseTimer += step;
    if (houseTimer >= 5) {
      houseTimer = 0;
      housekeeping();
    }
    if (hovered && !world.characters.has(hovered)) setHovered(null);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const vr = viewRect();
    view = { x0: vr.x - 8, y0: vr.y - 8, x1: vr.x + vr.w + 8, y1: vr.y + vr.h + 48 };

    for (const arr of byRoom.values()) arr.length = 0;
    allChars.length = 0;
    lifted.clear();
    weathered.clear();
    for (const ch of world.characters.values()) {
      let arr = byRoom.get(ch.sessionId);
      if (!arr) {
        arr = [];
        byRoom.set(ch.sessionId, arr);
      }
      arr.push(ch);
      allChars.push(ch);
    }

    ctx.setTransform(z, 0, 0, z, ox, oy);
    for (const room of world.rooms.values()) {
      try {
        drawRoomWorld(room, byRoom.get(room.sessionId) || EMPTY);
      } catch (err) {
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        report(`room ${room.sessionId}`, err);
      }
    }
    drawBubbles(allChars);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    fontNow = "";
    drawScreenPass(allChars);
    try {
      drawEdgeBadges();
    } catch (err) {
      edgeHits.length = 0;
      report("edge badges", err);
    }
  }

  /* ───────────── อินพุต ───────────── */

  const pointers = new Map(); // pointerId → { x, y } (CSS px)
  let drag = null; // { id, sx, sy, lx, ly, moved }
  let pinch = null; // { dist, cx, cy }
  let wheelAcc = 0;
  let wheelAt = 0;

  function localPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function pickAt(x, y) {
    const w = screenToWorld(x, y);
    return world.pick(w.x, w.y);
  }

  function plateAt(x, y) {
    const px = x * dpr;
    const py = y * dpr;
    for (let i = plateHits.length - 1; i >= 0; i--) {
      const p = plateHits[i];
      if (px >= p.x && px <= p.x + p.w && py >= p.y && py <= p.y + p.h) return p.sessionId;
    }
    return null;
  }

  function roomAt(x, y) {
    const w = screenToWorld(x, y);
    for (const room of world.rooms.values()) {
      if (w.x >= room.x && w.y >= room.y && w.x <= room.x + room.w * TILE && w.y <= room.y + room.h * TILE) {
        return room.sessionId;
      }
    }
    return null;
  }

  function setHovered(key) {
    const k = typeof key === "string" && key ? key : null;
    if (k === hovered) return;
    hovered = k;
    canvas.style.cursor = k ? "pointer" : "";
    emit(opts.onHover, k);
  }

  function pinchInfo() {
    const pts = Array.from(pointers.values());
    const a = pts[0];
    const b = pts[1];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = localPos(e);
    pointers.set(e.pointerId, p);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* บางเบราว์เซอร์ไม่ให้ capture (เช่น pointer หลุดไปแล้ว) — ลากต่อได้แค่ในกรอบ canvas ไม่เป็นไร */
    }
    if (pointers.size >= 2) {
      /* นิ้วที่สองลง = บีบซูม ยกเลิกการคลิก/ลากของนิ้วแรก */
      drag = null;
      pinch = pinchInfo();
      return;
    }
    drag = { id: e.pointerId, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false };
  }

  function onPointerMove(e) {
    const p = localPos(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const now = pinchInfo();
      panBy(now.cx - pinch.cx, now.cy - pinch.cy);
      pinch.cx = now.cx;
      pinch.cy = now.cy;
      const ratio = now.dist / Math.max(1, pinch.dist);
      /* ซูมเป็นขั้นจำนวนเต็ม: ต้องกาง/หุบนิ้วพอสมควรก่อนขยับหนึ่งขั้น แล้วตั้งฐานใหม่ */
      if (ratio > 1.3 || ratio < 0.77) {
        zoomBy(ratio > 1 ? 1 : -1, now.cx, now.cy);
        pinch.dist = now.dist;
      }
      return;
    }
    if (drag && drag.id === e.pointerId) {
      if (!drag.moved && Math.hypot(p.x - drag.sx, p.y - drag.sy) > DRAG_SLOP) {
        drag.moved = true;
        setHovered(null);
      }
      if (drag.moved) panBy(p.x - drag.lx, p.y - drag.ly);
      drag.lx = p.x;
      drag.ly = p.y;
      return;
    }
    if (e.pointerType === "mouse" || e.pointerType === "pen") {
      if (edgeAt(p.x, p.y)) {
        setHovered(null);
        canvas.style.cursor = "pointer";
        return;
      }
      setHovered(pickAt(p.x, p.y));
      if (!hovered) canvas.style.cursor = "";
    }
  }

  function onPointerUp(e) {
    const p = localPos(e);
    const wasDrag = drag && drag.id === e.pointerId ? drag : null;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    drag = null;
    if (!wasDrag || wasDrag.moved || e.type === "pointercancel") return;
    /* ป้ายขอบจอ (ห้องที่รอคุณอยู่นอกจอ) วาดทับทุกอย่าง จึงรับคลิกก่อน */
    const attn = edgeAt(p.x, p.y);
    if (attn) {
      focusRoom(attn);
      emit(opts.onFocusRoom, attn);
      return;
    }
    const sid = plateAt(p.x, p.y);
    if (sid) {
      focusRoom(sid);
      emit(opts.onFocusRoom, sid);
      return;
    }
    /* คลิกพื้นว่าง = เลิกเลือก (แบบเดียวกับเกมมุมมองบนทั่วไป) */
    emit(opts.onSelect, pickAt(p.x, p.y), { source: "click" });
  }

  function onPointerLeave(e) {
    if (e.pointerType === "mouse" && !drag) setHovered(null);
  }

  function onDblClick(e) {
    const p = localPos(e);
    const key = pickAt(p.x, p.y);
    if (key) {
      focus(key);
      emit(opts.onSelect, key, { source: "dblclick" });
      return;
    }
    const sid = roomAt(p.x, p.y);
    if (sid) focusRoom(sid);
  }

  function onWheel(e) {
    e.preventDefault();
    let d = num(e.deltaY);
    if (e.deltaMode === 1) d *= 40;
    else if (e.deltaMode === 2) d *= 800;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    /* หยุดหมุนนาน หรือหมุนกลับทิศ = เริ่มสะสมใหม่ ไม่ให้เศษของรอบก่อนทำให้ซูมกระโดดเกิน */
    if (now - wheelAt > 250 || Math.sign(d) !== Math.sign(wheelAcc)) wheelAcc = 0;
    wheelAt = now;
    wheelAcc += d;
    if (Math.abs(wheelAcc) >= WHEEL_STEP) {
      const p = localPos(e);
      zoomBy(wheelAcc < 0 ? 1 : -1, p.x, p.y);
      wheelAcc = 0;
    }
  }

  function isFormControl(t) {
    if (!t || typeof t !== "object") return false;
    if (t.isContentEditable) return true;
    const tag = typeof t.tagName === "string" ? t.tagName : "";
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
  }

  function onKeyDown(e) {
    if (!e || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isFormControl(e.target)) return;
    const k = e.key;
    const stepPx = e.shiftKey ? 240 : 64;
    if (k === "+" || k === "=") zoomBy(1);
    else if (k === "-" || k === "_") zoomBy(-1);
    else if (k === "0") fit();
    else if (k === "ArrowLeft") panBy(stepPx, 0);
    else if (k === "ArrowRight") panBy(-stepPx, 0);
    else if (k === "ArrowUp") panBy(0, stepPx);
    else if (k === "ArrowDown") panBy(0, -stepPx);
    else if (k === "Escape") {
      /* hud.js ปิดแผง (แล้วสั่ง close-panel) ก่อนเราอยู่แล้ว — ที่นี่เก็บตกกรณีเลือกค้างโดยไม่มีแผง
         และถ้า HUD หยุดการแพร่ของ Esc ไว้ (ปิด legend) ก็ปล่อยให้ Esc นั้นปิดแค่ legend */
      if (e.cancelBubble || !selected) return;
      emit(opts.onSelect, null, { source: "key" });
      return;
    } else return;
    e.preventDefault();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("dblclick", onDblClick);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  document.addEventListener("keydown", onKeyDown);

  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    canvas.removeEventListener("dblclick", onDblClick);
    canvas.removeEventListener("wheel", onWheel);
    document.removeEventListener("keydown", onKeyDown);
    bakes.clear();
    looks.clear();
    byRoom.clear();
    widths.clear();
    pointers.clear();
    edgeHits.length = 0;
    attentionIds = [];
  }

  resize();

  return {
    resize,
    render,
    fit,
    zoomBy,
    panBy,
    focus,
    focusRoom,
    setSelected(key) {
      selected = typeof key === "string" && key ? key : null;
    },
    setHovered,
    setCaptions(mode) {
      captionMode = mode === "all" || mode === "none" ? mode : "auto";
    },
    screenToWorld,
    worldToScreen,
    viewRect,
    dispose,
    get zoom() {
      return z;
    },
    get selected() {
      return selected;
    },
    get hovered() {
      return hovered;
    },
    /** sessionId ของห้องที่ "รอคุณ/ติดด่าน" แต่หัวหน้าอยู่นอกส่วนที่มองเห็น (มีป้ายขอบจออยู่ในเฟรมล่าสุด) */
    get attention() {
      return attentionIds.slice();
    },
  };
}
