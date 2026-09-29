/*
 * world.js — "ผู้กำกับเวที" ของหน้า PIXEL OFFICE
 *
 * แปลง snapshot ดิบจาก server (มาทุก ~700ms) ให้เป็นออฟฟิศพิกเซลที่ "เล่าเรื่องได้":
 *   ทุก session = หนึ่งห้อง · main agent = หัวหน้าห้อง · sub-agent ที่ยัง running = ผู้ช่วยหนึ่งคน
 *   แต่ละคนเดินไปยัง "จุดทำงาน" ที่ตรงกับ tool จริงที่กำลังรัน (Read → ชั้นหนังสือ, Bash → เทอร์มินัล …)
 *   ตัวละครเป็นคนเดิมตลอดชีวิตของ agent — จึงดูออกว่า "คนนี้เพิ่งไปค้นเอกสาร แล้วกลับมาแก้ไฟล์ที่โต๊ะ"
 *
 * ทำไมไฟล์นี้ต้อง "ล้วน" (ไม่มี DOM / canvas / timer / Date.now สักบรรทัด):
 *   - เวลาในโลกมาจากสองทางเท่านั้น: `sync(snapshot)` (นาฬิกา server ผ่าน snapshot.nowMs) และ
 *     `update(dt)` (นาฬิกาเฟรม) ⇒ ป้อนข้อมูลชุดเดิม + dt ชุดเดิม ได้ภาพเดิมทุกครั้ง ทดสอบซ้ำได้ใน Node
 *   - scene.js วาดอย่างเดียว ไม่ตัดสินใจ — "ใครอยู่ตรงไหน ทำอะไร เพราะอะไร" ถูกตัดสินที่นี่ที่เดียว
 *   - ไม่พึ่ง event ของ store.js: diff snapshot เองทั้งหมด (session id / agentId / event `i` /
 *     running true→false / counts) เพราะ world ต้องรู้สถานะก่อนหน้า "ในมุมของตัวเอง"
 *     (ใครยังเดินอยู่ ใครยังไม่ได้โต๊ะ ใครกำลังส่งงาน) ซึ่ง store ไม่รู้
 *
 * กฎความซื่อตรงของข้อมูล (กฎหลักของ repo: ห้ามมั่นใจเกินหลักฐาน):
 *   - caption บอก tool/สถานะ "จริง" ปัจจุบันเสมอ ภาพอาจ "เล่าย้อน" tool ที่เริ่มและจบไปแล้วระหว่าง
 *     สอง poll ได้ แต่ caption ต้องติดธง replay:true ("✓ เมื่อกี้") และเล่าย้อนได้เฉพาะตอนหัวหน้า
 *     "กำลังคิด" (ไม่มีอะไรวิ่งจริง) เท่านั้น — สถานะจริงชนะการเล่าย้อนเสมอ
 *   - ไม่ประดิษฐ์กิจกรรม: ผู้ช่วยทุกคนมาจาก sub-agent ที่ running จริง ส่วนที่เกินเพดานถูกนับเป็น
 *     `room.overflow` (บอกตรง ๆ ว่ามีคนที่ไม่ได้วาด) ส่วนตัวที่เห็นครั้งแรกก็จบไปแล้วนับแค่บนป้ายคะแนน
 *
 * หน่วยความจำ: ทุก Map ถูกล้างเมื่อ session/agent หายไปจาก snapshot (แท็บนี้อาจเปิดทิ้งไว้เป็นวัน)
 */

export const TILE = 16;

/* ───────────────────────── ค่าคงที่ของผังห้อง ───────────────────────── */

const ROOM_W = 26;
/** คอลัมน์ซ้ายของโต๊ะผู้ช่วยแต่ละตัวในหนึ่งแถว (โต๊ะกว้าง 2 + ช่องเดิน 1) */
const DESK_COLS = Object.freeze([2, 5, 8, 11, 14]);
const DESKS_PER_ROW = DESK_COLS.length;
const MIN_DESK_ROWS = 2;
/** ห้องโต/หดเป็นขั้นละ 10 โต๊ะ (= 2 แถว) — ขั้นละโต๊ะเดียวจะทำให้ห้องกระตุกขยายทุก poll ตอนพายุงาน */
const DESK_STEP = 10;
const HALL_TILES = 2;
const BOUNDS_MARGIN = 24;
/** เท้าของคนยืนอยู่ค่อนล่างของช่อง (ไม่ใช่ขอบล่างพอดี) เพื่อให้ sortY ยังอยู่ในแถวของตัวเอง */
const STAND_Y = 13;
/** จุดนั่ง = ขอบล่างของช่องที่นั่ง (ลบ 1 ให้ยังอยู่ในช่อง) — เก้าอี้ < คนนั่ง < โต๊ะ ตามลำดับ sortY */
const SEAT_Y = 15;

/* ───────────────────────── จังหวะเวลา ───────────────────────── */

const WALK_SPEED = 5.5 * TILE;
const PATROL_FACTOR = 0.55;
const WALK_FPS = 8;
const POSE_FPS = 2.5;
const ROOM_TWEEN_S = 0.4;
const SHRINK_AFTER_S = 30;
const BEAT_MAX_AGE_S = 5;
const BEAT_MAX_QUEUE = 2;
const MIN_DWELL_S = 1;
const NARRATE_GAP_S = 1.5;
const NARRATE_ERR_GAP_S = 2;
const SLEEP_AFTER_MS = 45_000;
const SPEECH_S = 4;
const SPEECH_CHARS = 40;
const THINK_FLIP_S = 3;
const BULB_S = 2.2;
/*
 * คิวหน้าสถานีสูงสุด 3 คน — เกินนี้ภาพกลายเป็นกองคนยืนทับกันหน้าตู้ (อ่านไม่ออกว่าใครทำอะไร)
 * คนที่เหลือทำงานนั้นที่โต๊ะตัวเองพร้อมไอคอนสถานีในฟองความคิด (ยังบอกความจริงครบ)
 */
const QUEUE_MAX = 3;
const QUEUE_RADIUS = 7;
/*
 * ผู้ช่วยลุกจากโต๊ะไปสถานีเมื่อ "น่าจะไปทันก่อน tool จบ" เท่านั้น (hysteresis):
 *   ใกล้ (≤ 8 ช่อง) → ไปเลย · ไกล → รอให้ tool รันมาแล้วอย่างน้อย max(1.2 วิ, 0.6 × เวลาเดิน)
 *   เหตุผล: tool ของผู้ช่วยเปลี่ยนทุก ~2 วิ แต่เดินจากโต๊ะแถวล่างขึ้นแถวสถานีใช้ 3–7 วิ — ถ้าลุกทุกครั้ง
 *   ทั้งห้องจะเป็นฝูงคนเดินสวนกันตลอดเวลา เรื่อง "เดินไปทำงาน แล้วกลับมานั่ง" จะไม่มีใครเห็น
 *   (tool ที่รันมานานแล้วมักรันต่ออีกพอ ๆ กัน — จึงใช้อายุของ tool เป็นตัวทำนาย)
 */
const ERRAND_NEAR_TILES = 8;
const ERRAND_MIN_AGE_S = 1.2;
const ERRAND_TRIP_FACTOR = 0.6;
/*
 * ส่งงานทางไกล/ห้องแน่น: ผู้ช่วยที่จบงานไม่ต้องเดินข้ามห้องไปหาผู้จ้างแล้วเดินกลับประตูซ้ายบน
 * (เดิมห้องหลังพายุใช้ ~45 วิกว่าจะว่าง และคนที่จบงานแล้วกินที่วาดของคนที่ยังทำงานอยู่)
 * → ยื่นรายงานจากที่ยืน (กระดาษลอยไปหาผู้จ้าง) แล้วปุ๊ฟหายไป · ฟีดกับป้ายคะแนนเล่าส่วนที่เหลือแล้ว
 */
const DELIVER_FAR_TILES = 10;
const EXIT_DOOR_FAR_TILES = 12;
/** รวมบรรทัด "ส่งงานแล้ว" ของห้องเดียวกันในช่วงนี้เป็นบรรทัดเดียว (พายุงานจบทีละหลายสิบคน) */
const DELIVER_NARRATE_WINDOW_S = 2;
/*
 * ทางเข้าของผู้ช่วยใหม่: รอนอกฉากจนช่องธรณีของตัวเองว่าง (ไม่เกินนี้ — กันค้างถ้ามีใครยืนขวางนานผิดปกติ)
 * ทางเดินจากประตูถึงโต๊ะยาวเกิน ENTER_HURRY_TILES ช่อง → เดินเร็วขึ้น ×ENTER_HURRY (ท่าเดินเร็วขึ้นตาม)
 */
const ENTER_WAIT_MAX_S = 6;
const ENTER_HURRY_TILES = 12;
const ENTER_HURRY = 1.5;
/* ส่งงานใกล้ขนาดนี้ (ช่อง) เดินไปยื่นถึงตัวเสมอ แม้ห้องเต็มเพดาน — ห้องเล็กต้องได้เห็นเรื่องครบ */
const DELIVER_NEAR_TILES = 6;
const PROMOTE_EVERY_S = 0.5;
const GOTO_TIMEOUT_S = 14;
const EXIT_TIMEOUT_S = 32;
const FADE_IN_S = 0.35;
const MAX_EFFECTS = 360;
const HIRE_STAGGER_S = 0.25;
const HIRE_STAGGER_MAX_S = 4;
const CAPTION_EVERY_S = 0.25;

/** เอฟเฟกต์ประเภท "ระเบิดอนุภาค" — ปิดเมื่อผู้ใช้ขอลดการเคลื่อนไหว (ที่เหลือสื่อความหมาย จึงเก็บไว้) */
const BURST_EFFECTS = new Set(["poof", "spark", "smoke", "sparkle", "heart"]);
const EFFECT_TTL = {
  poof: 0.5,
  spark: 0.45,
  smoke: 0.8,
  rain: 1.8,
  storm: 1.2,
  zzz: 1.5,
  letter: 0.8,
  paper: 0.6,
  stamp: 1.0,
  heart: 1.0,
  sparkle: 0.8,
};

/** จำนวนเฟรมของแต่ละท่า (ตรงกับตาราง pose ใน sprites.js) — world เป็นคนเดินเฟรม scene แค่วาด */
const POSE_FRAMES = {
  stand: 2,
  walk: 4,
  "sit-type": 2,
  "sit-think": 2,
  "sit-idle": 2,
  "sit-slump": 1,
  "sit-sleep": 2,
  sip: 2,
  read: 2,
  reach: 2,
  "type-stand": 2,
  "write-board": 2,
  "think-stand": 2,
  "raise-hand": 2,
  phone: 2,
  supervise: 2,
  celebrate: 2,
  sad: 2,
  oops: 1,
  wave: 2,
  "read-letter": 2,
  give: 1,
};
/** ท่า "ยืน/นั่งเฉย" ที่เฟรมที่สองคือการโยกตัวเบา ๆ — ปิดเมื่อ reduce-motion */
const IDLE_BOB_POSES = new Set(["stand", "sit-idle", "sit-think", "think-stand"]);
const SEATED_POSES = new Set(["sit-type", "sit-think", "sit-idle", "sit-slump", "sit-sleep"]);
const DEFAULT_FACE = {
  celebrate: "happy",
  wave: "happy",
  sad: "sad",
  "sit-slump": "sad",
  "sit-sleep": "sleep",
  oops: "surprised",
  "think-stand": "think",
  "sit-think": "think",
};

/** ขนาด sprite (px) ตามแคตตาล็อกในสเปก — ใช้ตรวจว่าของบนผนังไม่ถูกเฟอร์นิเจอร์สูง ๆ บัง */
export const PROP_SIZES = Object.freeze({
  door: [32, 44],
  window: [32, 24],
  whiteboard: [48, 26],
  cctv: [16, 14],
  clock: [12, 12],
  scoreboard: [32, 14],
  poster: [16, 20],
  mailbox: [16, 24],
  bookshelf: [32, 40],
  cabinet: [32, 28],
  terminal: [32, 36],
  kiosk: [32, 30],
  toolbox: [16, 32],
  printer: [16, 20],
  coffee: [16, 28],
  phone: [16, 26],
  couch: [48, 26],
  plant: [16, 26],
  desk: [32, 24],
  chair: [16, 18],
  "lead-desk": [48, 26],
  "lead-chair": [16, 22],
  rug: [64, 48],
  /* ประตูข้าง (ผนังซ้าย) ของห้องที่โตเกิน 2 ชุดโต๊ะ — ช่องเดียวในสันผนัง มองจากด้านบน */
  "side-door": [16, 16],
});

/* ───────────────────────── ตาราง tool → กิจกรรม ───────────────────────── */

function act(station, pose, icon, verb, emoji, extra) {
  return Object.freeze({ station, pose, icon, verb, emoji, ...(extra || {}) });
}

/*
 * หัวใจของ "เล่าเรื่องได้": tool แต่ละตัวมีที่ทางของมันในห้อง คนดูจึงอ่านออกจากตำแหน่งเดียวว่า
 * agent กำลังทำอะไร โดยไม่ต้องอ่าน caption เลย (caption มีไว้ยืนยันรายละเอียดที่จริง)
 */
const TOOL_ACTIVITY = {
  Read: act("bookshelf", "read", "book", "อ่าน", "📖"),
  Grep: act("cabinet", "reach", "magnifier", "ค้นหา", "🔍"),
  Glob: act("cabinet", "reach", "magnifier", "ค้นหา", "🔍"),
  Bash: act("terminal", "type-stand", "terminal", "รันคำสั่ง", "⌨️"),
  PowerShell: act("terminal", "type-stand", "terminal", "รันคำสั่ง", "⌨️"),
  Edit: act("desk", "sit-type", "pencil", "แก้ไฟล์", "✏️"),
  MultiEdit: act("desk", "sit-type", "pencil", "แก้ไฟล์", "✏️"),
  NotebookEdit: act("desk", "sit-type", "pencil", "แก้ไฟล์", "📓"),
  Write: act("desk", "sit-type", "pencil", "เขียนไฟล์", "📝"),
  WebFetch: act("kiosk", "type-stand", "globe", "ค้นเว็บ", "🌐"),
  WebSearch: act("kiosk", "type-stand", "globe", "ค้นเว็บ", "🌐"),
  TodoWrite: act("whiteboard", "write-board", "checklist", "จดงาน", "☑️"),
  Workflow: act("whiteboard", "write-board", "graph", "วางแผนงาน", "🕸️"),
  Agent: act("delegate", "supervise", "robot", "สั่งงานผู้ช่วย", "🤖"),
  Task: act("delegate", "supervise", "robot", "สั่งงานผู้ช่วย", "🤖"),
  AskUserQuestion: act("phone", "phone", "question", "ถามคุณ", "🙋"),
  Skill: act("toolbox", "reach", "wrench", "หยิบเครื่องมือ", "🧩"),
  ToolSearch: act("toolbox", "reach", "wrench", "หยิบเครื่องมือ", "🧰"),
  /* Monitor = ยืนใต้กล้องวงจรปิดแล้ว "หันขึ้นมอง" จึงใส่ dir ไว้ด้วย (ท่า stand มีทุกทิศ) */
  Monitor: act("cctv", "stand", "eye", "เฝ้าดู", "👁️", { dir: "up" }),
  Artifact: act("printer", "reach", "chart", "ทำรายงาน", "📊"),
};
const MCP_ACTIVITY = act("toolbox", "type-stand", "plug", "ใช้ปลั๊กอิน", "🔌");
const DEFAULT_ACTIVITY = act("desk", "sit-type", "wrench", "ใช้เครื่องมือ", "🔧");

const DELEGATE_TOOLS = new Set(["Agent", "Task"]);
const ASK_TOOL = "AskUserQuestion";
const STATE_WORDS = new Set(["tool", "delegating", "waiting", "thinking", "blocked", "idle", "unknown"]);

/** ตัวภายใน: คืน object แช่แข็งตัวเดิม (เรียกทุกเฟรมต่อทุกตัวละคร — ไม่อยากสร้างขยะ) */
function activityOf(tool) {
  const name = typeof tool === "string" ? tool : "";
  if (name && Object.prototype.hasOwnProperty.call(TOOL_ACTIVITY, name)) return TOOL_ACTIVITY[name];
  if (name.startsWith("mcp__")) return MCP_ACTIVITY;
  return DEFAULT_ACTIVITY;
}

/**
 * tool → { station, pose, icon, verb, emoji, dir? } ตามตารางในสเปก
 * (คืนสำเนาใหม่ทุกครั้ง ผู้เรียกแก้ได้โดยไม่ทำตารางกลางพัง; `emoji` = ไอคอนข้อความสำหรับ caption/ฟีด)
 */
export function activityForTool(tool) {
  return { ...activityOf(tool) };
}

/** "claude-opus-5" → "OP" · haiku → HA · sonnet → SO · fable → FA · อื่น ๆ → "" */
export function modelTagOf(model) {
  if (typeof model !== "string" || !model) return "";
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "HA";
  if (m.includes("sonnet")) return "SO";
  if (m.includes("opus")) return "OP";
  if (m.includes("fable")) return "FA";
  return "";
}

/** ชื่อห้อง: title → name → ชื่อโฟลเดอร์ของ cwd → 8 ตัวแรกของ sessionId (ตัดที่ ~28 ตัวอักษร) */
export function sessionDisplayName(session) {
  const s = isObj(session) ? session : {};
  const raw =
    oneLine(s.title) ||
    oneLine(s.name) ||
    oneLine(basename(s.cwd)) ||
    (typeof s.sessionId === "string" ? s.sessionId.slice(0, 8) : "") ||
    "session";
  return truncate(raw, 28);
}

/* ───────────────────────── ตัวช่วยทั่วไป (กัน undefined/NaN ทุกตัว) ───────────────────────── */

function isObj(v) {
  return v !== null && typeof v === "object";
}
function str(v) {
  return typeof v === "string" ? v : "";
}
function num(v, fallback = 0) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function oneLine(v) {
  return str(v).replace(/\s+/g, " ").trim();
}
/** ตัดตาม code point (ไม่ผ่ากลาง surrogate pair ของอีโมจิ) */
function truncate(text, max) {
  const chars = Array.from(str(text));
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, Math.max(1, max - 1)).join("") + "…";
}
function basename(p) {
  const s = str(p).replace(/[\\/]+$/, "");
  if (!s) return "";
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}
/** ISO string หรือ ms → ms (ไม่ใช่เวลาปัจจุบัน — Date.parse แค่แปลงรูปแบบ) */
function parseTs(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
function hash32(s) {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/** PRNG ต่อตัวละคร (mulberry32) — ห้ามใช้ Math.random เพื่อให้ภาพทำซ้ำได้ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dirOf(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}
function normState(session) {
  const st = isObj(session) && isObj(session.status) ? session.status.state : undefined;
  return STATE_WORDS.has(st) ? st : "unknown";
}
function runningList(session) {
  const r = isObj(session) && isObj(session.status) ? session.status.running : null;
  return Array.isArray(r) ? r.filter((e) => isObj(e) && typeof e.tool === "string" && e.tool) : [];
}
/** tool ที่ "กำลังทำจริง" ของหัวหน้า = ตัวแรกที่ไม่ใช่การสั่งผู้ช่วยหรือการถามผู้ใช้ */
function primaryEntry(session) {
  for (const e of runningList(session)) {
    if (!DELEGATE_TOOLS.has(e.tool) && e.tool !== ASK_TOOL) return e;
  }
  return null;
}
function entryKey(e) {
  return e ? `${str(e.tool)}|${str(e.startedTs)}|${str(e.label)}` : "";
}
function toolLabelKey(tool, label) {
  return `${str(tool)}|${oneLine(label)}`;
}
function joinText(a, b) {
  const x = oneLine(a);
  const y = oneLine(b);
  return x && y ? `${x} ${y}` : x || y;
}
function subModelTag(sub) {
  const t = str(sub && sub.modelTag).toUpperCase();
  if (t === "HA" || t === "SO" || t === "OP" || t === "FA") return t;
  return modelTagOf(sub && sub.model);
}
/** ผลงานของ sub → กลุ่มที่ภาพเล่าต่างกัน ("" ถือว่าสำเร็จ ตรงกับ store.js) */
function outcomeClass(outcome) {
  const o = str(outcome);
  if (o === "ok" || o === "") return "ok";
  if (o === "failed" || o === "error") return "failed";
  if (o === "killed") return "killed";
  return "unknown";
}
function listTypes(types) {
  const uniq = Array.from(new Set(types.filter(Boolean)));
  if (!uniq.length) return "agent";
  return uniq.length > 3 ? `${uniq.slice(0, 3).join(", ")} …` : uniq.join(", ");
}

/* ───────────────────────── ผังห้อง ───────────────────────── */

/*
 * ผังห้องมาตรฐาน (deskRows = 2 → 26 × 13 ช่อง; ห้องโตโดยเพิ่มแถวโต๊ะทีละ 2 แถว ส่วนบนไม่ขยับเลย
 * ⇒ โต๊ะเดิมอยู่ที่เดิมเสมอ ผู้ช่วยที่นั่งอยู่ไม่ต้องย้าย):
 *
 *            คอลัมน์ 0         1         2
 *                    01234567890123456789012345
 *   แถว  0  ผนัง    #DD#P##ww#o##www###########
 *   แถว  1  ผนัง    #DD#P##ww##WWW##SS#Pc#wwPww#
 *   แถว  2  ผนัง    #DD#######WWW###########   ← ผนังหลังสูง 3 แถว (ประตู/ไวต์บอร์ด/ของแต่ง)
 *   แถว  3  ของ     #__MBBCCTT___KKXPQcHh...p#    ← เฟอร์นิเจอร์ชิดผนัง (ยืนทำงานที่แถว 4)
 *   แถว  4  ทางเดิน #........................#   ← แถวยืนหน้าสถานี + ทางเดินหลัก
 *   แถว  5  ที่นั่ง  #.cc.cc.cc.cc.cc.....l...#   ← เก้าอี้ผู้ช่วย / เก้าอี้หัวหน้า (l)
 *   แถว  6  โต๊ะ    #.dd.dd.dd.dd.dd...LLL.>#    ← โต๊ะผู้ช่วย / โต๊ะหัวหน้า (> = ยืนคุมข้างโต๊ะ)
 *   แถว  7  ทางเดิน #........................#
 *   แถว  8  ที่นั่ง  #.cc.cc.cc.cc.cc...rUUUp.#   ← แถวโต๊ะชุดที่ 2 · โซฟา (U) บนพรม (r)
 *   แถว  9  โต๊ะ    #.dd.dd.dd.dd.dd...rrrr..#
 *   แถว 10  ทางเดิน #..................rrrr..#
 *   แถว 11  พื้น    #.......................p#
 *   แถว 12  ผนังหน้า ##########################
 *
 *   D ประตู (ธรณีประตู _ ที่แถว 3 คอลัมน์ 1–2 = ทางเข้าออกของทุกคน) · M ตู้จดหมาย · B ชั้นหนังสือ
 *   C ตู้เอกสาร · T เทอร์มินัล · W ไวต์บอร์ด (ติดผนัง ยืนใต้มันที่แถว 3) · K คีออสก์เว็บ
 *   X กล่องเครื่องมือ · P เครื่องพิมพ์ · Q เครื่องกาแฟ · c (แถว 3) ยืนใต้กล้องวงจรปิด = ยืนจิบกาแฟข้างเครื่อง
 *   H บูธโทรศัพท์ · h (แถว 3) ยืนข้างบูธ (ไม่บังโทรศัพท์ที่กำลังดัง)
 *   p ต้นไม้ · ของแต่งผนัง: ww หน้าต่าง · o นาฬิกา · SS ป้ายคะแนน · P โปสเตอร์ · c กล้องวงจรปิด
 *
 *   ห้องที่โตเกิน 2 ชุดโต๊ะ: มีประตูข้าง "]" ในผนังซ้ายทุก 2 ชุดโต๊ะ ที่แถวทางเดินระหว่างสองชุดนั้น
 *     แถว 13  ]m.....................   ← ] ช่องประตู (เดินได้ ทางตัน) · m พรมเช็ดเท้า (คอลัมน์ 1)
 *   แถว 19, 25, … ตามขนาดห้อง — ผู้ช่วยเข้า/ออกทางประตูที่ใกล้โต๊ะตัวเองที่สุด (ดู doorFor)
 *
 * ทำไมจัดแบบนี้:
 *   - สถานีทุกตัวเรียงชิดผนังหลัง ⇒ แถว 4 เป็นทางเดินยาวที่เชื่อมทุกอย่าง ไม่มีทางตัน
 *   - โต๊ะผู้ช่วยเป็นแถว ๆ (กว้าง 2 + ช่องว่าง 1) มีแถวทางเดินคั่นทุกชุด ⇒ ทุกที่นั่งเข้าถึงได้จาก
 *     สองทาง และห้องโตลงล่างได้เรื่อย ๆ โดยไม่แตะโซนบน
 *   - โซนหัวหน้าอยู่ขวา (โต๊ะใหญ่ + บูธถาม + มุมพัก) แยกจากฝูงผู้ช่วย ⇒ หาหัวหน้าเจอทันทีแม้ห้องแน่น
 *   - เก้าอี้/โซฟาไม่ใช่สิ่งกีดขวาง (ต้องเดินเข้าไปนั่งได้) แต่ค่าเดินผ่านแพงกว่าพื้น A* จึงอ้อมเอง
 */
export function buildRoomLayout(deskRows = MIN_DESK_ROWS) {
  const rows = Math.max(MIN_DESK_ROWS, Math.floor(num(deskRows, MIN_DESK_ROWS)));
  const w = ROOM_W;
  const h = 7 + 3 * rows;
  const n = w * h;
  const blocked = new Uint8Array(n);
  const cost = new Uint8Array(n).fill(1);
  /** 1 = ห้ามใช้เป็นที่ต่อคิว (ที่นั่ง จุดยืนประจำสถานี ธรณีประตู) — คิวไม่ควรไปยืนทับเก้าอี้ใคร */
  const noQueue = new Uint8Array(n);
  const at = (tx, ty) => ty * w + tx;

  for (let tx = 0; tx < w; tx++) {
    for (let ty = 0; ty < 3; ty++) blocked[at(tx, ty)] = 1;
    blocked[at(tx, h - 1)] = 1;
  }
  for (let ty = 0; ty < h; ty++) {
    blocked[at(0, ty)] = 1;
    blocked[at(w - 1, ty)] = 1;
  }

  const props = [];
  const addProp = (id, name, variant, tx, ty, fw, fh, layer, sortY) => {
    const p = {
      id,
      name,
      variant,
      frame: 0,
      tx,
      ty,
      fw,
      fh,
      layer,
      sortY: sortY === undefined ? (ty + fh) * TILE : sortY,
    };
    props.push(p);
    return p;
  };
  const floorProp = (id, name, variant, tx, ty, fw) => {
    addProp(id, name, variant, tx, ty, fw, 1, "sorted");
    for (let i = 0; i < fw; i++) blocked[at(tx + i, ty)] = 1;
  };
  const seatTile = (tx, ty, c) => {
    cost[at(tx, ty)] = c;
    noQueue[at(tx, ty)] = 1;
  };
  const spot = (tx, ty, facing, seated = false) => ({
    tx,
    ty,
    facing,
    x: tx * TILE + 8,
    y: ty * TILE + (seated ? SEAT_Y : STAND_Y),
  });

  /*
   * ของบนผนัง: ขอบล่างของ sprite = (ty + fh) * 16
   * ตัวที่เปลี่ยน variant ตามเหตุการณ์ (ประตูเปิด/ปิด, ไวต์บอร์ดมีลายมือ, กล้องติดไฟ) อยู่ชั้น "sorted"
   * ที่วาดทุกเฟรม — ถ้าไว้ในชั้น "wall" ที่อบเป็นภาพนิ่ง ทุกครั้งที่มีผู้ช่วยเข้าประตูต้องอบห้องใหม่ทั้งห้อง
   */
  addProp("door", "door", "closed", 1, 0, 2, 3, "sorted");
  addProp("poster-0", "poster", "0", 3, 0, 1, 2, "wall");
  addProp("window-0", "window", "default", 6, 0, 2, 2, "wall");
  addProp("clock", "clock", "default", 9, 0, 1, 1, "wall");
  addProp("whiteboard", "whiteboard", "clean", 10, 1, 3, 2, "sorted");
  addProp("scoreboard", "scoreboard", "default", 13, 1, 2, 1, "wall");
  addProp("poster-1", "poster", "1", 16, 0, 1, 2, "wall");
  addProp("cctv", "cctv", "default", 18, 1, 1, 1, "sorted");
  addProp("window-1", "window", "default", 20, 0, 2, 2, "wall");
  addProp("poster-2", "poster", "2", 22, 0, 1, 2, "wall");
  addProp("window-2", "window", "default", 23, 0, 2, 2, "wall");

  /* เฟอร์นิเจอร์ชิดผนังหลัง (แถว 3) — ยืนทำงานที่แถว 4 หันหน้าขึ้น */
  floorProp("mailbox", "mailbox", "empty", 3, 3, 1);
  floorProp("bookshelf", "bookshelf", "default", 4, 3, 2);
  floorProp("cabinet", "cabinet", "closed", 6, 3, 2);
  floorProp("terminal", "terminal", "idle", 8, 3, 2);
  floorProp("kiosk", "kiosk", "idle", 13, 3, 2);
  floorProp("toolbox", "toolbox", "default", 15, 3, 1);
  floorProp("printer", "printer", "idle", 16, 3, 1);
  floorProp("coffee", "coffee", "default", 17, 3, 1);
  floorProp("phone", "phone", "idle", 19, 3, 1);
  floorProp("plant-0", "plant", "0", 24, 3, 1);

  /* โซนหัวหน้า: โต๊ะใหญ่ + เก้าอี้พนักพิงสูง + มุมพัก (พรม โซฟา ต้นไม้) */
  floorProp("lead-desk", "lead-desk", "off", 20, 6, 3);
  addProp("lead-chair", "lead-chair", "default", 21, 5, 1, 1, "sorted", 6 * TILE - 2);
  seatTile(21, 5, 4);
  addProp("rug", "rug", "default", 19, 8, 4, 3, "floor", 0);
  /* โซฟาวาดก่อนคนที่นอนบนมัน (พนักอยู่หลังไหล่) เหมือนเก้าอี้ ⇒ sortY ต่ำกว่าจุดนั่ง 1 px */
  addProp("couch", "couch", "default", 20, 8, 3, 1, "sorted", 9 * TILE - 2);
  for (let tx = 20; tx <= 22; tx++) seatTile(tx, 8, 6);
  floorProp("plant-1", "plant", "1", 23, 8, 1);
  floorProp("plant-2", "plant", "0", 24, h - 2, 1);

  /* โต๊ะผู้ช่วย: index เรียงซ้าย→ขวา บน→ล่าง ⇒ โต๊ะเลขเดิมอยู่ตำแหน่งเดิมทุกขนาดห้อง */
  const desks = [];
  for (let i = 0; i < rows * DESKS_PER_ROW; i++) {
    const g = Math.floor(i / DESKS_PER_ROW);
    const tx = DESK_COLS[i % DESKS_PER_ROW];
    const ty = 6 + 3 * g;
    const sy = ty - 1;
    floorProp(`desk-${i}`, "desk", "off", tx, ty, 2);
    /*
     * โต๊ะกว้าง 2 ช่องแต่คนกว้าง 1 ช่อง: เก้าอี้และจุดนั่งจึงเยื้องครึ่งช่อง (tx + 0.5) ให้อยู่กลางโต๊ะพอดี
     * (scene คำนวณ x = tx * 16 ได้ตามปกติ — ค่าเศษ .5 ให้ผลเป็นพิกเซลเต็มอยู่แล้ว)
     */
    addProp(`chair-${i}`, "chair", "default", tx + 0.5, sy, 1, 1, "sorted", ty * TILE - 2);
    seatTile(tx, sy, 4);
    seatTile(tx + 1, sy, 4);
    noQueue[at(tx + 2, ty)] = 1;
    desks.push({
      index: i,
      tx,
      ty,
      seat: { tx, ty: sy, x: (tx + 1) * TILE, y: sy * TILE + SEAT_Y },
      owner: null,
      /** ช่องว่างขวาโต๊ะ = ที่ยืนคุมงานของเจ้าของโต๊ะ (ตอนเจ้าของเองสั่งผู้ช่วยต่อ) */
      beside: spot(tx + 2, ty, "left"),
      /** ช่องว่างซ้ายโต๊ะ = จุดที่หัวหน้าเดินตรวจงาน (หันขวาดูจอ) */
      side: spot(tx - 1, ty, "right"),
    });
  }

  const station = (slots, ax, ay, ordered = false) => {
    for (const sl of slots) noQueue[at(sl.tx, sl.ty)] = 1;
    /* ordered = ใช้ช่องตามลำดับที่ให้ (ช่องแรก = ช่องที่ดูดีที่สุด) แทนการเลือกช่องที่ใกล้ตัวที่สุด */
    return { slots, busy: 0, anchor: { x: ax, y: ay }, ordered };
  };
  const stations = {
    mailbox: station([spot(3, 4, "up")], 3 * TILE + 8, 3 * TILE + 8),
    bookshelf: station([spot(4, 4, "up"), spot(5, 4, "up")], 5 * TILE, 3 * TILE + 8),
    cabinet: station([spot(6, 4, "up"), spot(7, 4, "up")], 7 * TILE, 3 * TILE + 8),
    terminal: station([spot(8, 4, "up"), spot(9, 4, "up")], 9 * TILE, 3 * TILE + 8),
    whiteboard: station([spot(10, 3, "up"), spot(11, 3, "up"), spot(12, 3, "up")], 11 * TILE + 8, 2 * TILE + 8),
    kiosk: station([spot(13, 4, "up"), spot(14, 4, "up")], 14 * TILE, 3 * TILE + 8),
    toolbox: station([spot(15, 4, "up")], 15 * TILE + 8, 3 * TILE + 8),
    printer: station([spot(16, 4, "up")], 16 * TILE + 8, 3 * TILE + 8),
    /*
     * กาแฟ/บูธถาม: ยืน "ข้าง" เครื่อง (แถวเดียวกับของ) ไม่ใช่หน้าเครื่อง — ท่าจิบกาแฟ/ยกมือ/ถือหูโทรศัพท์
     * หันหน้าหาผู้ดูเท่านั้น ถ้ายืนหน้าเครื่อง หัว + ฟองเตือนจะบังโทรศัพท์ที่กำลังดัง/เครื่องกาแฟมิดทั้งชิ้น
     * (ช่อง (18,3) ใช้ร่วมกับจุดยืนใต้กล้อง — การจองเป็นรายช่อง จึงไม่มีสองคนยืนทับกัน)
     */
    coffee: station([spot(18, 3, "down")], 17 * TILE + 8, 3 * TILE + 8),
    cctv: station([spot(18, 3, "up")], 18 * TILE + 8, TILE + 10),
    phone: station([spot(20, 3, "down")], 19 * TILE + 8, 3 * TILE + 8),
    /* โซฟา: นั่งกลางก่อนเสมอ (เบาะซ้ายสุดทำให้ตัวทับที่วางแขน) */
    couch: station(
      [spot(21, 8, "down", true), spot(20, 8, "down", true), spot(22, 8, "down", true)],
      21 * TILE + 8,
      8 * TILE + 8,
      true,
    ),
  };

  /*
   * ประตูหลัก (ผนังหลัง กว้าง 2 ช่อง): lanes = จุดยืนของสองช่องธรณี — ผู้ช่วยที่เข้าพร้อมกันยืนคนละช่อง
   * และคนถัดไปรอ "นอกฉาก" จนช่องของตัวเองว่าง (ไม่ซ้อนกันเป็นก้อนโปร่งแสงบนธรณีอีก)
   * inDir/outDir = ทิศที่หันตอนก้าวเข้า/ก้าวออก (ประตูหลัง: เข้าหันหน้าลง ออกหันหลังขึ้น)
   */
  const door = {
    id: "door",
    tx: 1,
    ty: 3,
    x: 2 * TILE,
    y: 3 * TILE + STAND_Y,
    lanes: [TILE + 8, 2 * TILE + 8],
    inDir: "down",
    outDir: "up",
  };
  noQueue[at(1, 3)] = 1;
  noQueue[at(2, 3)] = 1;
  /*
   * ประตูข้าง: ห้องที่โตเกิน 2 ชุดโต๊ะ (พายุงาน) เดิมมีทางเข้าเดียวที่มุมซ้ายบน ผู้ช่วยของโต๊ะแถวล่าง ๆ ต้องเดิน
   * 40+ ช่อง (7–10 วิ) กว่าจะได้นั่ง ครึ่งห้องจึงเป็นคนเดินเข้าตลอดเวลา และ tool เปลี่ยนไป 2–3 รอบก่อนถึงโต๊ะ
   * ⇒ ทุก 2 ชุดโต๊ะถัดลงไปมีประตูในผนังซ้าย ที่แถวทางเดินระหว่างสองชุดนั้น (แถว 13, 19, 25 …)
   *   ผู้ช่วยเข้า/ออกทางประตูที่ใกล้โต๊ะตัวเองที่สุด · หัวหน้าและบทจดหมายยังใช้ประตูหลักเสมอ
   *   (คอลัมน์ 1 ว่างตลอดแนว เป็นทางเดินจากประตูข้างขึ้น/ลงไปถึงทุกแถวโต๊ะ)
   */
  const doors = [door];
  for (let k = 1; 2 * k + 1 <= rows - 1; k++) {
    const ty = 7 + 6 * k;
    blocked[at(0, ty)] = 0; // ช่องในสันผนังซ้ายกลายเป็นช่องประตู (ทางตัน: A* ไม่ใช้เป็นทางผ่าน)
    noQueue[at(0, ty)] = 1;
    noQueue[at(1, ty)] = 1; // พรมเช็ดเท้าหน้าประตู — ไม่ใช่ที่ต่อคิว/ยืนส่งงาน
    /* sortY = ขอบบนของช่อง ⇒ คนที่ยืนในช่องประตูถูกวาดทับบานประตูเสมอ */
    addProp(`side-door-${k}`, "side-door", "closed", 0, ty, 1, 1, "sorted", ty * TILE);
    doors.push({ id: `side-door-${k}`, tx: 0, ty, x: 8, y: ty * TILE + STAND_Y, lanes: [8], inDir: "right", outDir: "left" });
  }
  const leadSeat = { tx: 21, ty: 5, x: 21 * TILE + 8, y: 5 * TILE + SEAT_Y };
  const leadBeside = spot(23, 6, "left");
  noQueue[at(23, 6)] = 1;

  return {
    w,
    h,
    deskRows: rows,
    props,
    stations,
    door,
    doors,
    desks,
    leadSeat,
    spots: { leadBeside },
    grid: { w, h, blocked, cost, noQueue },
  };
}

/* ───────────────────────── A* บนกริด 4 ทิศ ───────────────────────── */

/* บัฟเฟอร์ใช้ซ้ำข้ามการเรียก (240 ตัวละครเปลี่ยนเป้าได้บ่อย — ไม่อยากจองอาร์เรย์ใหม่ทุกครั้ง) */
let astar = null;
function astarScratch(n) {
  if (!astar || astar.size < n) {
    const cap = Math.max(n, 256);
    astar = {
      size: cap,
      g: new Float64Array(cap),
      came: new Int32Array(cap),
      stamp: new Uint32Array(cap),
      closed: new Uint32Array(cap),
      heapNode: new Int32Array(cap * 4 + 8),
      heapPri: new Float64Array(cap * 4 + 8),
      gen: 0,
    };
  }
  astar.gen += 1;
  if (astar.gen >= 0xfffffff0) {
    astar.stamp.fill(0);
    astar.closed.fill(0);
    astar.gen = 1;
  }
  return astar;
}

/**
 * หาทางเดินสั้นสุด (4 ทิศ, ค่าเดินต่อช่องจาก grid.cost) → [[tx,ty], …] รวมต้นและปลาย หรือ null
 * ช่องเริ่มต้นเป็นสิ่งกีดขวางได้ (ตัวละครที่ติดอยู่หลังห้องหดจะเดินออกมาได้) แต่ปลายทางต้องเดินได้
 */
export function findPath(grid, sx, sy, gx, gy) {
  if (!grid || !grid.blocked) return null;
  const w = grid.w | 0;
  const h = grid.h | 0;
  const blocked = grid.blocked;
  const cost = grid.cost || null;
  const inb = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < w && y < h;
  if (!inb(sx, sy) || !inb(gx, gy)) return null;
  const start = sy * w + sx;
  const goal = gy * w + gx;
  if (blocked[goal]) return null;
  if (start === goal) return [[sx, sy]];
  const S = astarScratch(w * h);
  const { g, came, stamp, closed, heapNode, heapPri } = S;
  const gen = S.gen;
  let heapLen = 0;
  const push = (node, pri) => {
    let i = heapLen++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapPri[p] <= pri) break;
      heapNode[i] = heapNode[p];
      heapPri[i] = heapPri[p];
      i = p;
    }
    heapNode[i] = node;
    heapPri[i] = pri;
  };
  const pop = () => {
    const top = heapNode[0];
    const lastN = heapNode[--heapLen];
    const lastP = heapPri[heapLen];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= heapLen) break;
      const r = l + 1;
      const c = r < heapLen && heapPri[r] < heapPri[l] ? r : l;
      if (heapPri[c] >= lastP) break;
      heapNode[i] = heapNode[c];
      heapPri[i] = heapPri[c];
      i = c;
    }
    heapNode[i] = lastN;
    heapPri[i] = lastP;
    return top;
  };
  const hdist = (node) => Math.abs((node % w) - gx) + Math.abs(((node / w) | 0) - gy);
  stamp[start] = gen;
  g[start] = 0;
  came[start] = -1;
  push(start, hdist(start));
  const maxPush = heapNode.length - 4;
  while (heapLen > 0) {
    const cur = pop();
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (cur === goal) {
      const out = [];
      for (let k = cur; k !== -1; k = came[k]) out.push([k % w, (k / w) | 0]);
      out.reverse();
      return out;
    }
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = d === 0 ? cx + 1 : d === 1 ? cx - 1 : cx;
      const ny = d === 2 ? cy + 1 : d === 3 ? cy - 1 : cy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nb = ny * w + nx;
      if (blocked[nb] || closed[nb] === gen) continue;
      const ng = g[cur] + (cost ? cost[nb] || 1 : 1);
      if (stamp[nb] !== gen || ng < g[nb]) {
        stamp[nb] = gen;
        g[nb] = ng;
        came[nb] = cur;
        /* f เท่ากัน → เลือกตัวที่ g มากกว่า (ใกล้ปลายทางกว่า) ⇒ เส้นทางตรง ไม่ซิกแซก */
        if (heapLen < maxPush) push(nb, ng + hdist(nb) - ng * 1e-6);
      }
    }
  }
  return null;
}

/* ───────────────────────── โลก ───────────────────────── */

const STEP_DONE = Symbol("done");

/**
 * สร้างโลกหนึ่งชุด — ทุกอย่างของหน้า PIXEL OFFICE ที่ "ไม่ใช่การวาด"
 * @param {{ reduceMotion?: boolean, maxHelpersPerRoom?: number, seed?: number }} [options]
 */
export function createWorld({ reduceMotion = false, maxHelpersPerRoom = 64, seed = 1 } = {}) {
  const RM = !!reduceMotion;
  const MAX_HELPERS = Math.max(1, Math.floor(num(maxHelpersPerRoom, 64)));
  /* เพดานโต๊ะ = เพดานผู้ช่วยปัดขึ้นเป็นขั้นละ 10 (ห้องไม่มีวันโตเกินที่จำเป็น) */
  const MAX_DESKS = Math.max(DESK_STEP, Math.ceil(MAX_HELPERS / DESK_STEP) * DESK_STEP);
  const SEED = hash32(`pixel-world:${num(seed, 1)}`);

  /** @type {Map<string, object>} sessionId → Room */
  const rooms = new Map();
  /** @type {Map<string, object>} key → Character (หัวหน้า = sessionId · ผู้ช่วย = sessionId:agentId) */
  const characters = new Map();
  const effects = [];
  const narrators = new Set();
  /** sessionId → ลำดับห้อง (คงที่ตลอดชีวิต session แม้ server จะเรียง agents ใหม่ทุก poll) */
  const slotOf = new Map();
  /** sessionId → สิ่งที่เห็นจาก session นั้นรอบก่อน (สำหรับ diff) */
  const sessDiff = new Map();
  /** sessionId → Map<agentId, สิ่งที่เห็นจาก sub นั้นรอบก่อน> */
  const subDiff = new Map();
  /** "ชนิด|key" → clock ของบรรทัดล่าสุด (กันฟีดรัว) */
  const narrLast = new Map();
  /** key → บรรทัดที่ถูกกั้นไว้ รอปล่อยเมื่อพ้นช่วงกั้น ถ้ายังเป็นความจริงอยู่ */
  const narrPending = new Map();
  /** sessionId → { until, items } หน้าต่างรวมบรรทัด "ส่งงานแล้ว" ของห้องนั้น (ดู flushBatch) */
  const deliverWin = new Map();

  let clock = 0;
  let serverNowMs = 0;
  let serverNowAt = 0;
  let synced = false;
  let quiet = false;
  let disposed = false;
  let layoutVersion = 1;
  let needRepack = false;
  let fxSeq = 0;
  let captionTimer = 0;
  let pruneTimer = 0;
  /** ขนาดพื้นที่มองเห็นจาก setLayoutHint (device px) หรือ null · packMemo = จำนวนคอลัมน์ที่เลือกไว้แล้ว */
  let layoutHint = null;
  let packMemo = null;

  function report(where, err) {
    if (typeof console !== "undefined" && console && typeof console.error === "function") {
      console.error(`[pixel/world] ${where}`, err);
    }
  }
  /** ทุก callback ถูกครอบ — ขั้นตอนหนึ่งของบทพังต้องไม่ทำให้ลูปทั้งโลกหยุด */
  function safeCall(fn, ...args) {
    try {
      return fn(...args);
    } catch (err) {
      report("callback", err);
      return undefined;
    }
  }

  function nowMs() {
    return serverNowMs > 0 ? serverNowMs + (clock - serverNowAt) * 1000 : 0;
  }

  /* ───────────── การเล่าเรื่อง (ฟีด) ───────────── */

  function emitLine(line) {
    for (const fn of Array.from(narrators)) {
      try {
        fn(line);
      } catch (err) {
        report("onNarrate listener", err);
      }
    }
  }
  function narrate(icon, text, tone, key, sessionId) {
    if (quiet || disposed) return;
    emitLine({ icon, text, tone, key, sessionId });
  }
  /**
   * บรรทัดที่เกิดถี่ (tool เปลี่ยน / error) ถูกกั้น ≤ 1 บรรทัดต่อช่วงต่อตัวละคร
   * บรรทัดที่ถูกกั้นไม่ทิ้งทันที: ถ้าพ้นช่วงแล้ว "ยังจริงอยู่" (tool เดิมยังรัน) ค่อยปล่อย
   * ⇒ ฟีดไม่รัว แต่ก็ไม่พลาดสถานะล่าสุดที่ค้างนานพอจะมีความหมาย
   */
  function narrateThrottled(kind, key, sessionId, icon, text, tone, gap, toolKey) {
    if (quiet || disposed) return;
    const tkey = `${kind}|${key}`;
    const last = narrLast.get(tkey);
    if (last === undefined || clock - last >= gap) {
      narrLast.set(tkey, clock);
      narrPending.delete(tkey);
      emitLine({ icon, text, tone, key, sessionId });
    } else {
      narrPending.set(tkey, { icon, text, tone, key, sessionId, gap, toolKey: toolKey || null });
    }
  }
  function flushPendingNarration() {
    for (const [tkey, p] of narrPending) {
      const last = narrLast.has(tkey) ? narrLast.get(tkey) : -Infinity;
      if (clock - last < p.gap) continue;
      narrPending.delete(tkey);
      if (p.toolKey) {
        const lead = characters.get(p.key);
        const cur = lead && lead.node ? entryKey(primaryEntry(lead.node)) : "";
        if (cur !== p.toolKey) continue; // tool นั้นจบไปแล้ว — ไม่เล่าของที่ไม่จริงแล้ว
      }
      narrLast.set(tkey, clock);
      emitLine({ icon: p.icon, text: p.text, tone: p.tone, key: p.key, sessionId: p.sessionId });
    }
  }
  function forgetNarration(match) {
    for (const k of Array.from(narrLast.keys())) if (match(k.slice(k.indexOf("|") + 1))) narrLast.delete(k);
    for (const k of Array.from(narrPending.keys())) if (match(k.slice(k.indexOf("|") + 1))) narrPending.delete(k);
  }

  /* ───────────── เอฟเฟกต์ ───────────── */

  function addEffect(kind, sessionId, x, y, extra) {
    if (disposed) return;
    if (RM && BURST_EFFECTS.has(kind)) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    fxSeq = (fxSeq + 1) >>> 0;
    const e = { kind, sessionId, x, y, t: 0, ttl: EFFECT_TTL[kind] || 1, seed: hash32(`${SEED}:${fxSeq}`) };
    if (extra) Object.assign(e, extra);
    effects.push(e);
    /* พายุงาน 240 ตัวยิงเอฟเฟกต์พร้อมกันได้ — ตัดตัวเก่าสุดทิ้ง ไม่ให้อาร์เรย์โตไม่มีเพดาน */
    if (effects.length > MAX_EFFECTS) effects.splice(0, effects.length - MAX_EFFECTS);
  }
  function tickEffects(dt) {
    let j = 0;
    for (let i = 0; i < effects.length; i++) {
      const e = effects[i];
      e.t += dt;
      if (e.t < e.ttl && rooms.has(e.sessionId)) effects[j++] = e;
    }
    effects.length = j;
  }

  /* ───────────── ห้อง ───────────── */

  function allocSlot() {
    const used = new Set(slotOf.values());
    let s = 0;
    while (used.has(s)) s++;
    return s;
  }

  function indexProps(props) {
    const m = new Map();
    for (const p of props) m.set(p.id, p);
    return m;
  }

  function createRoom(s) {
    const sid = s.sessionId;
    const slot = allocSlot();
    slotOf.set(sid, slot);
    const L = buildRoomLayout(MIN_DESK_ROWS);
    const room = {
      sessionId: sid,
      slot,
      x: 0,
      y: 0,
      tx: 0,
      ty: 0,
      w: L.w,
      h: L.h,
      deskRows: L.deskRows,
      props: L.props,
      stations: L.stations,
      door: L.door,
      doors: L.doors,
      desks: L.desks,
      leadSeat: L.leadSeat,
      spots: L.spots,
      grid: L.grid,
      title: sessionDisplayName(s),
      subtitle: "",
      modelTag: "",
      state: "unknown",
      alive: s.alive !== false,
      endedAgo: 0,
      lightsOn: s.alive !== false,
      score: { running: 0, done: 0, failed: 0, errors: 0, total: 0 },
      overflow: 0,
      staticVersion: 1,
      node: s,
    };
    /* สถานะภายในแยกเป็น property ที่ไม่ enumerable — HUD/scene ไม่ต้องเห็น และ JSON ของห้องยังสะอาด */
    Object.defineProperty(room, "_r", {
      value: {
        res: new Map(), // tile index → key ของคนที่จองช่องนั้น (ช่องยืนสถานี / คิว / จุดส่งงาน)
        queues: new Map(), // station → Set<key> ที่กำลังต่อคิว
        propById: indexProps(L.props),
        helperKeys: new Set(),
        mailFull: false,
        errUntil: new Map(), // prop id → clock ที่ variant "error" หมดอายุ
        boardUsedAt: -Infinity,
        doorOpenUntil: 0,
        /** ประตูข้าง: id → clock ที่บานจะปิดเอง (เปิดค้างสั้น ๆ ตอนมีคนยืน/เดินผ่านช่องประตู) */
        sideOpenUntil: new Map(),
        phoneRinging: false,
        spareSince: null,
        tween: null,
        placed: false,
      },
      enumerable: false,
      writable: true,
    });
    applyWindowLook(room);
    rooms.set(sid, room);
    needRepack = true;
    layoutVersion++;
    return room;
  }

  function applyWindowLook(room) {
    for (const p of room.props) if (p.name === "window") p.variant = room.lightsOn ? "default" : "dark";
  }

  function setLights(room, on) {
    if (room.lightsOn === on) return;
    room.lightsOn = on;
    applyWindowLook(room);
    room.staticVersion++;
    layoutVersion++;
  }

  function removeRoom(sid) {
    const room = rooms.get(sid);
    for (const [key, ch] of Array.from(characters)) {
      if (ch.sessionId === sid) {
        characters.delete(key);
        ch._s.removed = true;
      }
    }
    rooms.delete(sid);
    slotOf.delete(sid);
    sessDiff.delete(sid);
    subDiff.delete(sid);
    deliverWin.delete(sid);
    forgetNarration((k) => k === sid || k.startsWith(`${sid}:`));
    let j = 0;
    for (let i = 0; i < effects.length; i++) if (effects[i].sessionId !== sid) effects[j++] = effects[i];
    effects.length = j;
    if (room) {
      room._r.res.clear();
      room._r.queues.clear();
      room._r.helperKeys.clear();
    }
    needRepack = true;
    layoutVersion++;
  }

  /**
   * จัดห้องแบบ masonry: ไล่ตาม slot (คงที่) แล้วใส่ห้องลงคอลัมน์ที่ "เตี้ยที่สุด" ณ ตอนนั้น (เสมอกัน → ซ้ายสุด)
   *   - ห้องสูงเท่ากันหมด = เติมทีละแถวแบบเดิมทุกประการ (slot 0,1 แถวบน · 2,3 แถวสอง …)
   *   - ห้องที่โตสูงจากพายุงาน ไม่ดัน "ทั้งแถวถัดไป" ลงไปใต้ขอบจออีกแล้ว: ห้องเตี้ยไปต่อคิวใต้คอลัมน์ที่ว่างกว่า
   *     และห้องสูงสองห้องได้ยืนเคียงกัน แทนการซ้อนกันเป็นตึก (เดิม forge-66 ถูกดันลงไปอยู่ใต้ฟีด)
   * ผลขึ้นกับ slot + ความสูงห้องเท่านั้น (deterministic) — server เรียง agents ใหม่ทุก poll ก็ไม่ขยับ
   * ห้องเลื่อนเฉพาะตอนห้องเกิด/หาย/เปลี่ยนขนาด และเลื่อนแบบ tween เสมอ
   * คืน { cols, pos[] (world px ตามลำดับ list), w, h (รวมขอบของ bounds()) }
   */
  function layoutColumns(list, c) {
    const cols = Math.max(1, Math.min(list.length, c));
    const colH = new Array(cols).fill(0);
    const pos = [];
    for (const room of list) {
      let best = 0;
      for (let i = 1; i < cols; i++) if (colH[i] < colH[best]) best = i;
      pos.push({ x: best * (ROOM_W + HALL_TILES) * TILE, y: colH[best] });
      colH[best] += (room.h + HALL_TILES) * TILE;
    }
    const tallest = Math.max(0, ...colH) - HALL_TILES * TILE;
    const w = cols * ROOM_W * TILE + (cols - 1) * HALL_TILES * TILE + BOUNDS_MARGIN * 2;
    return { cols, pos, w, h: Math.max(0, tallest) + BOUNDS_MARGIN * 2 };
  }

  /**
   * จำนวนคอลัมน์: ไม่มี hint → ≈ ceil(sqrt(n·1.6)) (จอแนวนอนทั่วไป)
   * มี hint (ขนาดพื้นที่ที่มองเห็นจริงจาก main — ข้อมูลล้วน ๆ ไม่ใช่ DOM):
   *   1) มีแบบที่ "ทั้งออฟฟิศพอดีจอที่ซูม ×1 ขึ้นไป" → เอาแบบที่ได้ซูมจำนวนเต็มสูงสุด แล้วดูสเกลต่อเนื่อง
   *      (ต่างกันไม่ถึง 3% ถือว่าเท่ากัน เอาคอลัมน์มากกว่า) ⇒ 3–4 ห้องบนจอ 1440×900 เป็น 2×2 ที่พ้นแผงขวา
   *   2) ไม่มีแบบไหนพอดีเลย (5 ห้องขึ้นไป / มีห้องที่โตสูง) → จำนวนคอลัมน์ "มากที่สุดที่ยังกว้างไม่เกินจอ"
   *      เหตุผล: ส่วนที่ล้นต้องล้น "ลงล่าง" ซึ่งลากเลื่อนดูได้ ห้ามล้นไปขวาใต้คอลัมน์เครื่องมือ/รายชื่อห้อง
   *      ที่ลากไม่ได้ (เดิมเลือกตามสเกลต่อเนื่อง ได้ 4 คอลัมน์กว้าง 1808 px ห้องทั้งห้องรวมห้องที่ "รอคุณ" มุดใต้แผง)
   *      กว้างไม่พอแม้คอลัมน์เดียว (มือถือ) → คอลัมน์เดียว
   * คำนวณใหม่เฉพาะตอนจำนวนห้องหรือ hint เปลี่ยน (ห้องโต/หดไม่ทำให้ทั้งออฟฟิศสลับจำนวนคอลัมน์)
   */
  function chooseCols(list) {
    const n = list.length;
    const fallback = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 1.6))));
    if (!layoutHint) return fallback;
    const sig = `${n}|${layoutHint.w}|${layoutHint.h}`;
    if (packMemo && packMemo.sig === sig) return packMemo.cols;
    let best = 0;
    let bestZ = 0;
    let bestS = -1;
    let widest = 0;
    for (let c = n; c >= 1; c--) {
      const sz = layoutColumns(list, c);
      if (!widest && sz.w <= layoutHint.w) widest = c;
      const sc = Math.min(layoutHint.w / sz.w, layoutHint.h / sz.h);
      if (sc < 1 - 1e-9) continue;
      const zi = Math.floor(sc + 1e-9);
      if (zi > bestZ || (zi === bestZ && sc > bestS * 1.03)) {
        best = c;
        bestZ = zi;
        bestS = sc;
      }
    }
    const cols = best || widest || 1;
    packMemo = { sig, cols };
    return cols;
  }

  /** hint จากฝั่งจอ: ขนาดพื้นที่ที่ไม่โดนแผงบัง (device px) — เปลี่ยนเมื่อไหร่ก็จัดผังใหม่ (ห้อง tween ไปที่ใหม่) */
  function setLayoutHint(h) {
    const w = isObj(h) ? Math.round(num(h.width, 0)) : 0;
    const hh = isObj(h) ? Math.round(num(h.height, 0)) : 0;
    const next = w > 0 && hh > 0 ? { w, h: hh } : null;
    if ((next && layoutHint && next.w === layoutHint.w && next.h === layoutHint.h) || (!next && !layoutHint)) return;
    layoutHint = next;
    packMemo = null;
    needRepack = true;
  }

  function repack() {
    needRepack = false;
    const list = Array.from(rooms.values()).sort((a, b) => a.slot - b.slot);
    if (!list.length) return;
    const lay = layoutColumns(list, chooseCols(list));
    let changed = false;
    list.forEach((room, i) => {
      const p = lay.pos[i];
      if (room.tx !== p.x || room.ty !== p.y || !room._r.placed) {
        changed = true;
        setRoomTarget(room, p.x, p.y);
      }
    });
    if (changed) layoutVersion++;
  }

  function setRoomTarget(room, tx, ty) {
    room.tx = tx;
    room.ty = ty;
    const r = room._r;
    if (!r.placed) {
      r.placed = true;
      room.x = tx;
      room.y = ty;
      r.tween = null;
      return;
    }
    r.tween = { fx: room.x, fy: room.y, t: 0 };
  }

  function tweenRooms(dt) {
    for (const room of rooms.values()) {
      const tw = room._r.tween;
      if (!tw) continue;
      tw.t = Math.min(1, tw.t + dt / ROOM_TWEEN_S);
      const e = 1 - Math.pow(1 - tw.t, 3);
      room.x = tw.fx + (room.tx - tw.fx) * e;
      room.y = tw.fy + (room.ty - tw.fy) * e;
      if (tw.t >= 1) {
        room.x = room.tx;
        room.y = room.ty;
        room._r.tween = null;
        layoutVersion++;
      }
    }
  }

  /** เปลี่ยนจำนวนแถวโต๊ะ: สร้างผังใหม่ ยกเจ้าของโต๊ะเดิมไปตาม index แล้วให้ทุกคนในห้องหาทางใหม่ */
  function resizeRoom(room, deskRows) {
    const L = buildRoomLayout(deskRows);
    if (L.deskRows === room.deskRows) return;
    const owners = room.desks.map((d) => d.owner);
    room.w = L.w;
    room.h = L.h;
    room.deskRows = L.deskRows;
    room.props = L.props;
    room.stations = L.stations;
    room.door = L.door;
    room.doors = L.doors;
    room.desks = L.desks;
    room.leadSeat = L.leadSeat;
    room.spots = L.spots;
    room.grid = L.grid;
    for (let i = 0; i < owners.length && i < room.desks.length; i++) room.desks[i].owner = owners[i];
    const r = room._r;
    r.res.clear();
    r.queues.clear();
    r.propById = indexProps(L.props);
    r.spareSince = null;
    r.sideOpenUntil.clear();
    applyWindowLook(room);
    for (const ch of characters.values()) {
      if (ch.sessionId !== room.sessionId) continue;
      const s = ch._s;
      s.target = null;
      s.path = [];
      s.pathIdx = 0;
      s.arrived = false;
      /* จุดหมายของบทที่คำนวณไว้แล้วอาจอยู่ในแถวที่หายไป — ให้คำนวณใหม่ */
      for (const sc of [s.beat, s.exit]) if (sc) sc.spot = null;
      /* คนที่กำลังส่งงาน/เดินออกคืนโต๊ะไปแล้ว — ไม่ต้องแจกโต๊ะใหม่ให้ */
      if (ch.role === "helper" && !s.exit && (ch.deskIndex == null || ch.deskIndex >= room.desks.length)) {
        const d = freeDesk(room);
        if (d) {
          d.owner = ch.key;
          ch.deskIndex = d.index;
        }
      }
      const t = tileOfPos(room, ch.x, ch.y);
      const inside = ch.x >= 0 && ch.y >= 0 && ch.x <= room.w * TILE && ch.y <= room.h * TILE;
      if (!inside || room.grid.blocked[t.ty * room.w + t.tx]) {
        const k = nearestWalkable(room, t.tx, t.ty);
        ch.x = (k % room.w) * TILE + 8;
        ch.y = Math.floor(k / room.w) * TILE + STAND_Y;
      }
    }
    room.staticVersion++;
    layoutVersion++;
    needRepack = true;
  }

  function capacityFor(want) {
    return Math.min(MAX_DESKS, Math.max(DESK_STEP, Math.ceil(want / DESK_STEP) * DESK_STEP));
  }

  /**
   * หดห้องแบบมี hysteresis: ต้องเหลือโต๊ะว่างพอสำหรับขั้นที่เล็กกว่า "ต่อเนื่อง" ≥ 30 วิ ก่อน
   * (พายุงานมาเป็นระลอก — หดทันทีแล้วโตใหม่ในอีก 5 วิ ทำให้ทั้งฉากกระตุกโดยไม่สื่ออะไร)
   */
  function shrinkCheck(room) {
    const r = room._r;
    const cap = room.desks.length;
    if (cap <= DESK_STEP) {
      r.spareSince = null;
      return;
    }
    const smaller = cap - DESK_STEP;
    let maxOwned = 0;
    for (const d of room.desks) if (d.owner) maxOwned = d.index + 1;
    let spare = maxOwned <= smaller && activeHelperCount(room) + room.overflow <= smaller;
    if (spare) {
      /*
       * คนที่กำลังเดินออก (คืนโต๊ะไปแล้ว) อาจยังอยู่ในแถวล่างที่จะหายไป หรือยืนในช่องประตูข้างที่จะกลายเป็นผนัง
       * — หดตอนนั้นคือการวาร์ปคนขึ้นมากลางห้อง ⇒ รอให้ทุกคนพ้นส่วนที่จะหายก่อน (ปกติไม่กี่วินาที)
       */
      const keepH = (7 + 3 * (smaller / DESKS_PER_ROW) - 1) * TILE;
      for (const key of room._r.helperKeys) {
        const c = characters.get(key);
        if (c && (c.y >= keepH || c.x < TILE)) {
          spare = false;
          break;
        }
      }
    }
    if (!spare) {
      r.spareSince = null;
      return;
    }
    if (r.spareSince === null) r.spareSince = clock;
    else if (clock - r.spareSince >= SHRINK_AFTER_S) resizeRoom(room, smaller / DESKS_PER_ROW);
  }

  function freeDesk(room) {
    for (const d of room.desks) {
      if (!d.owner || !characters.has(d.owner)) {
        d.owner = null;
        return d;
      }
    }
    return null;
  }

  /* ───────────── ช่องบนกริด ───────────── */

  function tileOfPos(room, x, y) {
    const tx = Math.max(0, Math.min(room.w - 1, Math.floor(num(x) / TILE)));
    const ty = Math.max(0, Math.min(room.h - 1, Math.floor(num(y) / TILE)));
    return { tx, ty };
  }

  function nearestWalkable(room, tx, ty) {
    const { w, h, blocked } = room.grid;
    const start = ty * w + tx;
    if (!blocked[start]) return start;
    const seen = new Uint8Array(w * h);
    const q = [start];
    seen[start] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const k = q[qi];
      if (!blocked[k]) return k;
      const x = k % w;
      const y = (k / w) | 0;
      if (x + 1 < w && !seen[k + 1]) (seen[k + 1] = 1), q.push(k + 1);
      if (x - 1 >= 0 && !seen[k - 1]) (seen[k - 1] = 1), q.push(k - 1);
      if (y + 1 < h && !seen[k + w]) (seen[k + w] = 1), q.push(k + w);
      if (y - 1 >= 0 && !seen[k - w]) (seen[k - w] = 1), q.push(k - w);
    }
    return room.door.ty * w + room.door.tx;
  }

  function holderAlive(holder) {
    return !!holder && characters.has(holder);
  }

  /**
   * BFS หาช่องว่างที่ใกล้ที่สุดจากจุดเริ่ม (ใช้ทั้งหาที่ต่อคิวและที่ยืนส่งงาน)
   * ช่องที่ใช้ได้ = เดินได้ · ไม่ใช่ที่นั่ง/โซฟา · ไม่ถูกคนอื่นจองอยู่ · (ถ้า queueOnly) ไม่ใช่จุดประจำ
   */
  function nearestFreeTile(room, fromTx, fromTy, key, { radius = QUEUE_RADIUS, queueOnly = true, avoid = -1 } = {}) {
    const { w, h, blocked, cost, noQueue } = room.grid;
    const res = room._r.res;
    const start = fromTy * w + fromTx;
    const seen = new Uint8Array(w * h);
    const dist = new Uint16Array(w * h);
    const q = [start];
    seen[start] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const k = q[qi];
      if (k !== start && k !== avoid && !blocked[k] && cost[k] === 1 && (!queueOnly || !noQueue[k])) {
        const holder = res.get(k);
        if (!holder || holder === key || !holderAlive(holder)) return k;
      }
      if (dist[k] >= radius) continue;
      const x = k % w;
      const y = (k / w) | 0;
      const nbs = [x + 1 < w ? k + 1 : -1, x - 1 >= 0 ? k - 1 : -1, y + 1 < h ? k + w : -1, y - 1 >= 0 ? k - w : -1];
      for (const nb of nbs) {
        if (nb < 0 || seen[nb] || blocked[nb]) continue;
        seen[nb] = 1;
        dist[nb] = dist[k] + 1;
        q.push(nb);
      }
    }
    return -1;
  }

  /**
   * จองช่องทำงานที่สถานี: ช่องจริงว่าง → จองช่องที่ใกล้ตัวที่สุด · เต็ม → ต่อคิว (ไม่เกิน 5 คนต่อสถานี)
   * · คิวก็เต็ม → null (ผู้เรียกให้ไปทำที่โต๊ะตัวเองแทน พร้อมไอคอนบอกว่ากำลังทำอะไร)
   */
  function acquireStation(room, ch, name, slotOnly) {
    const st = room.stations[name];
    if (!st || !st.slots.length) return null;
    const res = room._r.res;
    const w = room.w;
    const me = tileOfPos(room, ch.x, ch.y);
    let best = null;
    let bestD = Infinity;
    for (const sl of st.slots) {
      const k = sl.ty * w + sl.tx;
      const holder = res.get(k);
      if (holder && holder !== ch.key && holderAlive(holder)) continue;
      if (st.ordered) {
        best = sl;
        break;
      }
      const d = Math.abs(sl.tx - me.tx) + Math.abs(sl.ty - me.ty);
      if (d < bestD) {
        bestD = d;
        best = sl;
      }
    }
    if (best) {
      const k = best.ty * w + best.tx;
      res.set(k, ch.key);
      return { tx: best.tx, ty: best.ty, x: best.x, y: best.y, facing: best.facing, queued: false, resTile: k, resStation: null };
    }
    if (slotOnly) return null;
    let q = room._r.queues.get(name);
    if (q) for (const key of Array.from(q)) if (!characters.has(key)) q.delete(key);
    if (q && q.size >= QUEUE_MAX && !q.has(ch.key)) return null;
    const first = st.slots[0];
    const k = nearestFreeTile(room, first.tx, first.ty, ch.key, { radius: QUEUE_RADIUS, queueOnly: true });
    if (k < 0) return null;
    res.set(k, ch.key);
    if (!q) {
      q = new Set();
      room._r.queues.set(name, q);
    }
    q.add(ch.key);
    const tx = k % w;
    const ty = (k / w) | 0;
    const x = tx * TILE + 8;
    const y = ty * TILE + STAND_Y;
    return { tx, ty, x, y, facing: dirOf(st.anchor.x - x, st.anchor.y - y), queued: true, resTile: k, resStation: name };
  }

  function releaseTarget(room, ch) {
    const t = ch._s.target;
    ch._s.target = null;
    if (!t || !room) return;
    if (t.resTile != null && room._r.res.get(t.resTile) === ch.key) room._r.res.delete(t.resTile);
    if (t.resStation) {
      const q = room._r.queues.get(t.resStation);
      if (q) {
        q.delete(ch.key);
        if (!q.size) room._r.queues.delete(t.resStation);
      }
    }
  }

  /* ───────────── ตัวละคร ───────────── */

  function makeCharacter({ key, sessionId, agentId, parentKey, role, type, name, modelTag, node }) {
    const ch = {
      key,
      sessionId,
      agentId,
      parentKey,
      role,
      look: { id: key, role, modelTag, type },
      type,
      name,
      x: 0,
      y: 0,
      dir: "down",
      pose: "stand",
      frame: 0,
      item: null,
      face: "normal",
      alpha: 1,
      moving: false,
      sortY: 0,
      bubble: null,
      speech: null,
      caption: { icon: "", text: "", sinceMs: null, tone: "neutral", replay: false },
      /** ป้ายเสริมใต้ caption ระหว่างบทที่กำลังเล่น (บทจดหมาย: ข้อความ prompt จริง) หรือ null */
      captionNote: null,
      state: "unknown",
      node,
      shake: 0,
      talking: false,
      glow: null,
      /** true ตั้งแต่เริ่มบท "ส่งงาน/กลับบ้าน" จนหายไป — scene/HUD ใช้แยกคนที่งานจบแล้ว */
      leaving: false,
      deskIndex: null,
    };
    const rngSeed = (hash32(key) ^ SEED) >>> 0;
    Object.defineProperty(ch, "_s", {
      value: {
        rng: mulberry32(rngSeed),
        phaseOffset: (rngSeed % 1000) / 1000 * THINK_FLIP_S,
        target: null,
        desire: null,
        hold: null,
        path: [],
        pathIdx: 0,
        arrived: false,
        arrivedAt: -Infinity,
        promoteAt: 0,
        beats: [],
        beat: null,
        exit: null,
        fadeIn: false,
        remove: false,
        removed: false,
        animT: 0,
        lastPose: "",
        bulbUntil: -Infinity,
        ack: null,
        talkUntil: 0,
        fxAt: 0,
        patrol: { sig: "", points: [], idx: 0, pauseUntil: null },
        lastSeat: null,
        /** ผู้ช่วย: สถานีที่ "ตัดสินใจเดินไปแล้ว" ({ station }) — กันการเปลี่ยนเส้นทางไปมากลางทาง */
        errand: null,
        /** ผู้ช่วย: key ของ tool ที่ตกลงทำที่โต๊ะ (เปลี่ยนใจกลางทางแล้ว) — tool เดิมนี้จะไม่ลุกไปอีก */
        stayFor: "",
        toolSeenKey: "",
        toolSeenAt: 0,
        /** กำลัง "ยืนต่ออีกนิด" ตามกฎ dwell — ท่าเป็นกลาง ไม่ค้างท่าของสถานะเก่า (caption เปลี่ยนแล้ว) */
        dwell: false,
      },
      enumerable: false,
      writable: true,
    });
    return ch;
  }

  function setLook(ch, modelTag) {
    if (ch.look.modelTag !== modelTag) ch.look = { id: ch.key, role: ch.role, modelTag, type: ch.look.type };
  }

  function createLead(room, s) {
    const ch = makeCharacter({
      key: room.sessionId,
      sessionId: room.sessionId,
      agentId: null,
      parentKey: null,
      role: "lead",
      type: "lead",
      name: room.title,
      modelTag: modelTagOf(s.model),
      node: s,
    });
    ch.state = normState(s);
    characters.set(ch.key, ch);
    return ch;
  }

  function parentKeyOf(sid, sub, byId) {
    const pid = str(sub && sub.parentAgentId);
    if (pid && pid !== sub.agentId && byId.has(pid)) return `${sid}:${pid}`;
    return sid;
  }

  function createHelper(room, sub, desk, parentKey) {
    const sid = room.sessionId;
    const key = `${sid}:${sub.agentId}`;
    const type = oneLine(sub.type) || "agent";
    const ch = makeCharacter({
      key,
      sessionId: sid,
      agentId: sub.agentId,
      parentKey,
      role: "helper",
      type,
      name: type,
      modelTag: subModelTag(sub),
      node: sub,
    });
    ch.deskIndex = desk.index;
    ch.state = isObj(sub.current) ? "tool" : "thinking";
    desk.owner = key;
    room._r.helperKeys.add(key);
    characters.set(key, ch);
    return ch;
  }

  function removeCharacter(ch) {
    const room = rooms.get(ch.sessionId);
    if (room) {
      releaseTarget(room, ch);
      for (const [k, holder] of Array.from(room._r.res)) if (holder === ch.key) room._r.res.delete(k);
      for (const [name, q] of Array.from(room._r.queues)) {
        q.delete(ch.key);
        if (!q.size) room._r.queues.delete(name);
      }
      if (ch.deskIndex != null && room.desks[ch.deskIndex] && room.desks[ch.deskIndex].owner === ch.key) {
        room.desks[ch.deskIndex].owner = null;
      }
      room._r.helperKeys.delete(ch.key);
      if (ch.role === "lead" && !room.alive) setLights(room, false);
    }
    if (characters.get(ch.key) === ch) characters.delete(ch.key);
    forgetNarration((k) => k === ch.key);
    ch._s.removed = true;
    ch._s.beats.length = 0;
    ch._s.beat = null;
    ch._s.exit = null;
  }

  /* ───────────── จุดหมาย (desire) ───────────── */

  function ownSeat(ch, room) {
    if (ch.role === "lead") return room.leadSeat;
    const desk = ch.deskIndex != null ? room.desks[ch.deskIndex] : null;
    return desk ? desk.seat : room.leadSeat;
  }

  function seatDesire(ch, room, pose, extra) {
    const seat = ownSeat(ch, room);
    return {
      id: "seat",
      kind: "spot",
      tx: seat.tx,
      ty: seat.ty,
      x: seat.x,
      y: seat.y,
      facing: "down",
      pose,
      ...(extra || {}),
    };
  }

  function spotDesire(id, sp, pose, extra) {
    return { id, kind: "spot", tx: sp.tx, ty: sp.ty, x: sp.x, y: sp.y, facing: sp.facing, pose, ...(extra || {}) };
  }

  function stationDesire(name, pose, extra) {
    return { id: `st:${name}`, kind: "station", station: name, pose, ...(extra || {}) };
  }

  function besideSpot(ch, room) {
    if (ch.role === "lead") return room.spots.leadBeside;
    const desk = ch.deskIndex != null ? room.desks[ch.deskIndex] : null;
    return desk ? desk.beside : room.spots.leadBeside;
  }

  function activityDesire(ch, room, a, urgent) {
    if (a.station === "desk") return seatDesire(ch, room, a.pose, { urgent, glow: "on", icon: a.icon });
    if (a.station === "delegate") {
      return spotDesire("beside", besideSpot(ch, room), a.pose, { urgent, icon: a.icon });
    }
    return stationDesire(a.station, a.pose, { dir: a.dir || null, icon: a.icon, urgent });
  }

  /**
   * หัวหน้าที่กำลังรอผู้ช่วย: เดินตรวจ 2–3 โต๊ะของผู้ช่วยตัวเอง (หยุดดูโต๊ะละ 2–3 วิ ถือคลิปบอร์ด)
   * จุดตรวจเลือกด้วย PRNG ของหัวหน้าคนนั้น ⇒ ข้อมูลเดิมได้เส้นทางเดิม
   */
  function patrolDesire(ch, room) {
    const s = ch._s;
    const mine = [];
    const any = [];
    for (const key of room._r.helperKeys) {
      const h = characters.get(key);
      if (!h || h._s.exit || h.deskIndex == null || !room.desks[h.deskIndex]) continue;
      any.push(h.deskIndex);
      if (h.parentKey === ch.key) mine.push(h.deskIndex);
    }
    const pool = (mine.length ? mine : any).sort((a, b) => a - b);
    const sig = pool.join(",");
    const P = s.patrol;
    if (P.sig !== sig) {
      P.sig = sig;
      const chosen = [];
      const bag = pool.slice();
      const want = Math.min(bag.length, 2 + Math.floor(s.rng() * 2));
      while (chosen.length < want && bag.length) chosen.push(bag.splice(Math.floor(s.rng() * bag.length), 1)[0]);
      chosen.sort((a, b) => a - b);
      P.points = chosen.map((i) => room.desks[i].side);
      if (P.idx >= P.points.length) P.idx = 0;
      P.pauseUntil = null;
    }
    if (!P.points.length) return spotDesire("beside", room.spots.leadBeside, "supervise", { icon: "robot" });
    let p = P.points[P.idx];
    let id = `patrol:${p.tx},${p.ty}`;
    if (s.target && s.target.id === id && s.arrived) {
      if (P.pauseUntil === null) P.pauseUntil = clock + 2 + s.rng();
      else if (clock >= P.pauseUntil && P.points.length > 1) {
        P.idx = (P.idx + 1) % P.points.length;
        P.pauseUntil = null;
        p = P.points[P.idx];
        id = `patrol:${p.tx},${p.ty}`;
      }
    }
    return spotDesire(id, p, "supervise", { speed: PATROL_FACTOR, icon: "robot" });
  }

  /** ผู้กำกับของหัวหน้า: อ่าน status จริงของ session แล้วบอกว่าควรอยู่ตรงไหน ทำท่าอะไร */
  function leadDesire(ch, room) {
    const s = ch._s;
    const node = ch.node || {};
    const st = normState(node);
    if (st === "tool") {
      const e = primaryEntry(node);
      if (!e) return spotDesire("beside", room.spots.leadBeside, "stand", {});
      return activityDesire(ch, room, activityOf(e.tool), true);
    }
    if (st === "delegating") return patrolDesire(ch, room);
    if (st === "waiting") {
      const ask = runningList(node).some((e) => e.tool === ASK_TOOL);
      return stationDesire("phone", ask ? "phone" : "raise-hand", {
        urgent: true,
        icon: ask ? "question" : "exclaim",
        bubble: { kind: "alert", icon: ask ? "question" : "exclaim", tone: "warn", blink: true },
        ringing: true,
      });
    }
    if (st === "thinking") {
      const up = Math.floor((clock + s.phaseOffset) / THINK_FLIP_S) % 2 === 0;
      const bulb = clock < s.bulbUntil;
      return stationDesire("whiteboard", up ? "write-board" : "think-stand", {
        dir: up ? "up" : "down",
        icon: "dots",
        bubble: { kind: "thought", icon: bulb ? "bulb" : "dots", tone: "info", blink: false },
      });
    }
    if (st === "idle") {
      const since = parseTs(isObj(node.status) ? node.status.since : null);
      const now = nowMs();
      const sleepy = since !== null && now > 0 && now - since >= SLEEP_AFTER_MS;
      if (sleepy) return stationDesire("couch", "sit-sleep", { face: "sleep", zzz: true, icon: "zzz" });
      return stationDesire("coffee", "sip", { icon: "coffee" });
    }
    if (st === "blocked") {
      /*
       * side: ฟองเตือนอยู่ "ข้าง" หัว ไม่ใช่บนหัว — ตำแหน่งเหนือหัวเป็นของเมฆฝน (ฝนต้องตกใส่คนที่ติดด่าน
       * ไม่ใช่ตกใส่ป้ายเตือนที่ลอยสูงขึ้นไปอีกชั้น)
       */
      return seatDesire(ch, room, "sit-slump", {
        bubble: { kind: "alert", icon: "warning", tone: "bad", blink: false, side: true },
        rain: true,
        glow: "error",
        face: "sad",
        urgent: true,
      });
    }
    return spotDesire("beside", room.spots.leadBeside, "stand", {
      bubble: { kind: "thought", icon: "question", tone: "neutral", blink: false, dim: true },
    });
  }

  /** อายุของ tool (วินาที): จาก startedTs ตามนาฬิกา server หรือจากตอนที่โลกเห็นครั้งแรก (เอาค่าที่มากกว่า) */
  function toolAgeS(ch, cur, tk) {
    const s = ch._s;
    if (s.toolSeenKey !== tk) {
      s.toolSeenKey = tk;
      s.toolSeenAt = clock;
    }
    let age = clock - s.toolSeenAt;
    const started = parseTs(cur.startedTs);
    const now = nowMs();
    if (started !== null && now > 0) age = Math.max(age, (now - started) / 1000);
    return age;
  }

  /** ระยะเดินโดยประมาณ (ช่อง) จากตำแหน่งปัจจุบันถึงช่องที่ใกล้ที่สุดของสถานี — แมนฮัตตันพอ (ออฟฟิศโล่ง) */
  function tripTiles(ch, room, name) {
    const st = room.stations[name];
    if (!st || !st.slots.length) return 0;
    const me = tileOfPos(room, ch.x, ch.y);
    let best = Infinity;
    for (const sl of st.slots) best = Math.min(best, Math.abs(sl.tx - me.tx) + Math.abs(sl.ty - me.ty));
    return best;
  }

  /** ทำงานของสถานีที่โต๊ะตัวเอง: นั่งพิมพ์ + ไอคอนสถานีในฟองความคิด (บอกความจริงว่ากำลังทำอะไรอยู่) */
  function deskWorkDesire(ch, room, a) {
    return seatDesire(ch, room, "sit-type", {
      urgent: true,
      glow: "on",
      icon: a.icon,
      bubble: { kind: "thought", icon: a.icon, tone: "neutral", blink: false },
    });
  }

  /**
   * ผู้กำกับของผู้ช่วย: current tool → สถานีของมัน (ถ้าไปทัน) · ไม่ทัน → ทำที่โต๊ะพร้อมไอคอน
   * · ไม่มี tool → นั่งคิดที่โต๊ะตัวเอง
   * กติกา hysteresis (ดู ERRAND_*):
   *   - ตัดสินใจเดินไปสถานีแล้ว tool ใหม่ยังเป็นสถานีเดิม → เดินต่อ/อยู่ต่อ
   *   - กำลังเดินอยู่แล้ว tool เปลี่ยนเป็นสถานี "อื่น" → ไม่ลากเส้นทางใหม่ข้ามห้อง: กลับโต๊ะ ทำงานนั้นที่โต๊ะ
   *   - ยืนอยู่ที่สถานีแล้ว tool ใหม่เป็นสถานีอื่น → ตัดสินใหม่จากที่ยืน (สถานีเรียงติดกันแถวเดียว มักใกล้)
   */
  function helperDesire(ch, room) {
    const s = ch._s;
    const sub = ch.node || {};
    const cur = isObj(sub.current) && typeof sub.current.tool === "string" && sub.current.tool ? sub.current : null;
    if (!cur) {
      s.errand = null;
      s.stayFor = "";
      return seatDesire(ch, room, "sit-think", {
        bubble: { kind: "thought", icon: "dots", tone: "neutral", blink: false },
        face: "think",
        glow: "on",
      });
    }
    const a = activityOf(cur.tool);
    if (a.station === "desk" || a.station === "delegate" || !room.stations[a.station]) {
      s.errand = null;
      return activityDesire(ch, room, a, true);
    }
    const E = s.errand;
    if (E && E.station === a.station) return activityDesire(ch, room, a, true);
    const tk = entryKey(cur);
    if (E && s.target && !s.arrived && s.target.station === E.station) {
      /* เปลี่ยนใจกลางทาง → tool ตัวนี้ทำที่โต๊ะ (ไม่ลุกไปอีกจนกว่าจะเป็น tool ตัวใหม่) */
      s.errand = null;
      s.stayFor = tk;
    }
    if (s.stayFor !== tk) {
      const trip = tripTiles(ch, room, a.station);
      const need = Math.max(ERRAND_MIN_AGE_S, (ERRAND_TRIP_FACTOR * trip * TILE) / WALK_SPEED);
      if (trip <= ERRAND_NEAR_TILES || toolAgeS(ch, cur, tk) >= need) {
        s.errand = { station: a.station };
        s.stayFor = "";
        return activityDesire(ch, room, a, true);
      }
    }
    s.errand = null;
    return deskWorkDesire(ch, room, a);
  }

  function liveDesire(ch, room) {
    return ch.role === "lead" ? leadDesire(ch, room) : helperDesire(ch, room);
  }

  /** desire → เป้าหมายจริงบนกริด (จองช่องที่สถานีถ้าจำเป็น) */
  function resolveTarget(ch, room, d) {
    if (d.kind === "station") {
      const got = acquireStation(room, ch, d.station, false);
      if (got) return { id: d.id, station: d.station, ...got, fallback: false };
      const seat = ownSeat(ch, room);
      return {
        id: d.id,
        station: d.station,
        tx: seat.tx,
        ty: seat.ty,
        x: seat.x,
        y: seat.y,
        facing: "down",
        queued: false,
        fallback: true,
        resTile: null,
        resStation: null,
      };
    }
    return {
      id: d.id,
      station: null,
      tx: d.tx,
      ty: d.ty,
      x: d.x,
      y: d.y,
      facing: d.facing || "down",
      queued: false,
      fallback: false,
      resTile: d.resTile == null ? null : d.resTile,
      resStation: null,
    };
  }

  function planPath(ch, room) {
    const s = ch._s;
    const t = s.target;
    s.path = [];
    s.pathIdx = 0;
    if (!t) return;
    /*
     * แก้บั๊ก: อยู่ตรงเป้าอยู่แล้ว → ไม่ต้องเดินเลย (path ว่าง = ถึงทันทีในเฟรมถัดไป)
     * เดิมจุดนั่งของโต๊ะผู้ช่วยอยู่บนเส้นแบ่งช่องพอดี (x = (tx+1)*16) tileOfPos จึงได้ช่อง "ขวา" แต่เป้าคือช่อง
     * "ซ้าย" ⇒ A* พาเดินไปกลางช่องขวา → กลางช่องซ้าย → กลับจุดนั่ง: ทุกครั้งที่ห้องโต/หด (resizeRoom ล้างเป้า
     * ของทุกคน) ผู้ช่วยที่นั่งอยู่ทั้งห้องลุกขึ้นเดินส่ายไปมา ~0.4 วิ ทั้งที่โต๊ะเดิมไม่ได้ขยับเลย
     */
    if (Math.abs(ch.x - t.x) < 0.5 && Math.abs(ch.y - t.y) < 0.5) {
      ch.x = t.x;
      ch.y = t.y;
      return;
    }
    const from = tileOfPos(room, ch.x, ch.y);
    const tiles = findPath(room.grid, from.tx, from.ty, t.tx, t.ty);
    const pts = [];
    if (tiles && tiles.length) {
      /* ย่อจุดที่อยู่แนวเดียวกันออก เหลือแค่จุดเลี้ยว — เดินลื่นกว่าและทิศหน้าไม่กะพริบ */
      for (let i = 0; i < tiles.length; i++) {
        const [tx, ty] = tiles[i];
        if (i > 0 && i < tiles.length - 1) {
          const [px, py] = tiles[i - 1];
          const [nx, ny] = tiles[i + 1];
          if ((px === tx && tx === nx) || (py === ty && ty === ny)) continue;
        }
        pts.push({ x: tx * TILE + 8, y: ty * TILE + STAND_Y });
      }
      if (pts.length && Math.abs(pts[0].x - ch.x) < 1 && Math.abs(pts[0].y - ch.y) < 1) pts.shift();
      /*
       * แก้บั๊ก "ถอยหลังก่อนออกเดิน": จุดแรกของเส้นทางคือกลางช่องที่ยืนอยู่ ถ้าตัวละครไม่ได้อยู่กลางช่อง
       * (เปลี่ยนเป้ากลางทางตอนเดินเลยกลางช่องไปแล้ว หรือลุกจากที่นั่งที่อยู่บนเส้นแบ่งช่อง) มันจะเดินถอยกลับไป
       * กลางช่องก่อนแล้วค่อยกลับหลังหัน — เห็นเป็นอาการ "มูนวอล์ก" หันซ้ายขวากะพริบ (ในพายุงานเกิดหลายร้อยครั้ง)
       * ตัดจุดนั้นทิ้งได้อย่างปลอดภัยเสมอ: จุดถัดไปอยู่แถว/คอลัมน์เดียวกับช่องที่ยืน ⇒ เส้นตรงจากตัวละครไปถึงมัน
       * อยู่ในแถบของแถว/คอลัมน์นั้น ผ่านเฉพาะช่องบนเส้นทางเดิมที่เดินได้อยู่แล้ว (ไม่ตัดมุมสิ่งกีดขวาง)
       */
      else if (pts.length >= 2) pts.shift();
      /*
       * ปลายทางแบบเดียวกัน: เป้าหลายจุดไม่ได้อยู่กลางช่อง (ธรณีประตู x = 32 = กึ่งกลางประตูกว้าง 2 ช่อง,
       * ที่นั่งโต๊ะผู้ช่วยอยู่บนเส้นแบ่งสองช่องเก้าอี้) ถ้าก้าวสุดท้าย "กลางช่องสุดท้าย → เป้า" สวนทางกับทิศที่เดินมา
       * (dot < 0) แปลว่าเป้าอยู่ก่อนถึงกลางช่อง ⇒ ตัดกลางช่องทิ้ง เดินตรงเข้าเป้า ไม่ต้องเลยไปแล้วย้อนครึ่งช่อง
       * ปลอดภัยเพราะเป้าห่างกลางช่องสุดท้ายไม่เกินครึ่งช่อง และอยู่ระหว่างจุดก่อนหน้ากับกลางช่องนั้นบนแถว/คอลัมน์
       * เดียวกับเส้นทาง (จุดก่อนหน้าคือจุดเลี้ยว หรือตัวละครเองเมื่อเหลือจุดเดียว — ซึ่งอยู่แนวเดียวกันเสมอ)
       */
      const n = pts.length;
      if (n) {
        const a = n >= 2 ? pts[n - 2] : { x: ch.x, y: ch.y };
        const b = pts[n - 1];
        if ((b.x - a.x) * (t.x - b.x) + (b.y - a.y) * (t.y - b.y) < 0) pts.pop();
      }
    }
    const last = pts[pts.length - 1];
    if (!last || last.x !== t.x || last.y !== t.y) pts.push({ x: t.x, y: t.y });
    s.path = pts;
  }

  function isInPlace(d) {
    return !d || d.kind === "here" || d.kind === "hidden";
  }

  /**
   * รับ desire ของเฟรมนี้: เป้าเดิม → เดินต่อ · เป้าใหม่ → ปล่อยช่องเก่า จองช่องใหม่ หาเส้นทาง
   * กฎ "อยู่อย่างน้อย ~1 วิ": เพิ่งถึงสถานีแล้วอย่าเพิ่งผละไป ยกเว้นสถานะจริงเปลี่ยนเป็น tool ใหม่ (urgent)
   */
  function applyDesire(ch, room, d) {
    const s = ch._s;
    if (isInPlace(d)) {
      s.hold = d;
      return;
    }
    s.hold = null;
    const cur = s.target;
    if (cur && cur.id === d.id) {
      s.dwell = false;
      s.desire = d;
      maybePromote(ch, room, d);
      return;
    }
    if (cur && s.arrived && !d.urgent && !cur.queued && !cur.fallback && clock - s.arrivedAt < MIN_DWELL_S) {
      /*
       * ยืน/นั่งต่ออีกนิดตามกฎ dwell แต่ "ท่า" ต้องไม่โกหก: caption เปลี่ยนเป็นสถานะใหม่ไปแล้ว ถ้ายังยกมือ
       * ขออนุญาต/ถือหูโทรศัพท์/ฟุบโต๊ะค้างอยู่ จะเล่าสถานะที่จบไปแล้ว ⇒ present() ใช้ท่าเป็นกลางระหว่างนี้
       */
      s.dwell = true;
      return;
    }
    s.dwell = false;
    releaseTarget(room, ch);
    s.target = resolveTarget(ch, room, d);
    s.desire = d;
    s.arrived = false;
    s.promoteAt = clock + PROMOTE_EVERY_S;
    planPath(ch, room);
  }

  /** คนที่ต่อคิว / ไปทำที่โต๊ะเพราะคิวเต็ม: เช็กทุกครึ่งวินาทีว่ามีช่องจริงว่างหรือยัง */
  function maybePromote(ch, room, d) {
    const s = ch._s;
    const t = s.target;
    if (!t || d.kind !== "station" || !(t.queued || t.fallback)) return;
    if (clock < s.promoteAt) return;
    s.promoteAt = clock + PROMOTE_EVERY_S;
    const got = acquireStation(room, ch, d.station, t.queued);
    if (!got) return;
    if (got.queued && got.resTile === t.resTile) return;
    const keepRes = got.resTile;
    releaseTarget(room, ch);
    room._r.res.set(keepRes, ch.key);
    if (got.resStation) {
      let q = room._r.queues.get(got.resStation);
      if (!q) room._r.queues.set(got.resStation, (q = new Set()));
      q.add(ch.key);
    }
    s.target = { id: d.id, station: d.station, ...got, fallback: false };
    s.arrived = false;
    planPath(ch, room);
  }

  function stepMove(ch, s, dt, speed) {
    let budget = speed * dt;
    let lastDx = 0;
    let lastDy = 0;
    while (budget > 0 && s.pathIdx < s.path.length) {
      const p = s.path[s.pathIdx];
      const dx = p.x - ch.x;
      const dy = p.y - ch.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        ch.x = p.x;
        ch.y = p.y;
        budget -= d;
        s.pathIdx++;
        if (d > 0.01) {
          lastDx = dx;
          lastDy = dy;
        }
      } else {
        ch.x += (dx / d) * budget;
        ch.y += (dy / d) * budget;
        lastDx = dx;
        lastDy = dy;
        budget = 0;
      }
    }
    if (lastDx || lastDy) ch.dir = dirOf(lastDx, lastDy);
    return s.pathIdx >= s.path.length;
  }

  /* ───────────── บท (beats) ───────────── */

  /*
   * บทสั้น ๆ = ลำดับขั้นตอน: fn (ทำทันที) · wait (ซ่อนตัวรอ) · act (ทำท่าอยู่กับที่) ·
   * goto (เดินไปถึง) · visit (เดินไปแล้วอยู่ตรงนั้น dur วิ) · fade (จางหาย)
   * คิวบทต่อคน ≤ 2 และบทที่รอนานเกิน ~5 วิถูกทิ้ง — ภาพต้องตามข้อมูลให้ทัน ไม่ใช่เล่นย้อนหลังยาวเหยียด
   */
  function makeScript(type, steps, extra) {
    return { type, steps, i: 0, t: 0, dt: 0, created: clock, spot: null, started: false, arrivedFor: 0, dir: null, ...(extra || {}) };
  }

  function enqueueBeat(ch, beat) {
    const s = ch._s;
    if (s.exit || s.removed) return;
    if (beat.type === "replay") {
      for (let i = s.beats.length - 1; i >= 0; i--) if (s.beats[i].type === "replay") s.beats.splice(i, 1);
    }
    s.beats.push(beat);
    if (s.beats.length > BEAT_MAX_QUEUE) s.beats.splice(0, s.beats.length - BEAT_MAX_QUEUE);
  }

  function nextBeat(s) {
    while (s.beats.length) {
      const b = s.beats.shift();
      if (clock - b.created <= BEAT_MAX_AGE_S) return b;
    }
    return null;
  }

  function runScript(ch, room, sc, dt) {
    sc.t += dt;
    sc.dt = dt;
    for (let guard = 0; guard < 16; guard++) {
      if (sc.i >= sc.steps.length) return null;
      if (sc.abortIf && safeCall(sc.abortIf, ch, room)) {
        sc.i = sc.steps.length;
        return null;
      }
      const res = runStep(ch, room, sc, sc.steps[sc.i]);
      if (res !== STEP_DONE) return res;
      sc.i++;
      sc.t = 0;
      sc.started = false;
      sc.spot = null;
      sc.arrivedFor = 0;
      sc.dir = null;
    }
    return null;
  }

  function runStep(ch, room, sc, st) {
    const s = ch._s;
    switch (st.k) {
      case "fn":
        safeCall(st.fn, ch, room, sc);
        return STEP_DONE;
      case "wait":
        if (sc.t >= st.dur) return STEP_DONE;
        return { kind: "hidden" };
      case "enter": {
        /*
         * ซ่อนตัวรอหลังประตู: ถึงคิวเหลื่อมเวลาของตัวเองแล้ว + ช่องธรณีของตัวเองว่าง (คนก่อนหน้าเดินพ้นไปแล้ว)
         * หัวหน้าไม่ต้องรอช่อง (ห้องละคนเดียว) · รอเกิน ENTER_WAIT_MAX_S → เข้าเลย (กันค้างนอกฉากตลอดไป)
         */
        if (sc.t < st.delay) return { kind: "hidden" };
        const free = ch.role === "lead" || laneFree(room, ch, ch.x, ch.y) || sc.t >= st.delay + ENTER_WAIT_MAX_S;
        if (!free) return { kind: "hidden" };
        if (ch.role === "helper") addEffect("poof", ch.sessionId, ch.x, ch.y - 10);
        s.fadeIn = true;
        return STEP_DONE;
      }
      case "act": {
        if (!sc.started) {
          sc.started = true;
          if (st.onStart) safeCall(st.onStart, ch, room, sc);
        }
        if (sc.t >= st.dur) return STEP_DONE;
        return {
          kind: "here",
          pose: st.pose,
          dir: sc.dir || st.dir || null,
          face: st.face || null,
          item: st.item || null,
          bubble: st.bubble || null,
          glow: st.glow || null,
        };
      }
      case "goto":
      case "visit": {
        if (!sc.spot) {
          sc.spot = safeCall(st.spot, ch, room, sc) || null;
          sc.t = 0;
          if (!sc.spot) return STEP_DONE;
        }
        const there = s.target && s.target.id === sc.spot.id && s.arrived;
        if (there) {
          if (st.k === "goto") return STEP_DONE;
          if (!sc.started) {
            sc.started = true;
            if (st.onArrive) safeCall(st.onArrive, ch, room, sc);
          }
          sc.arrivedFor += sc.dt;
          if (sc.arrivedFor >= st.dur) return STEP_DONE;
        } else if (sc.t > GOTO_TIMEOUT_S) {
          return STEP_DONE;
        }
        return sc.spot;
      }
      case "fade": {
        /* sc.poof = หายตรงที่ยืน (ปุ๊ฟ + จางเร็ว หันหน้าหาผู้ดู) แทนการจางหายที่ประตู (หันหลังออกไป) */
        if (!sc.started) {
          sc.started = true;
          if (sc.poof) addEffect("poof", ch.sessionId, ch.x, ch.y - 10);
        }
        s.fadeIn = false;
        const dur = sc.poof ? Math.min(0.3, st.dur) : st.dur;
        ch.alpha = Math.max(0, ch.alpha - sc.dt / Math.max(0.05, dur));
        if (ch.alpha <= 0) return STEP_DONE;
        /* จางหายที่ประตู = หันออกไปทางประตู (ประตูหลัง: หันหลังขึ้น · ประตูข้าง: หันซ้าย) */
        return { kind: "here", pose: "stand", dir: sc.poof ? "down" : (sc.exitDoor && sc.exitDoor.outDir) || "up" };
      }
      default:
        return STEP_DONE;
    }
  }

  /**
   * ประตูของตัวละครนี้: หัวหน้า → ประตูหลักเสมอ (บทกลับบ้าน/จดหมาย) · ผู้ช่วย → ประตูที่ใกล้จุด (x, y) ที่สุด
   * (ระยะแมนฮัตตันเป็นช่อง — ออฟฟิศโล่ง ทางเดินจริงต่างจากนี้ไม่กี่ช่อง; เสมอกัน → ประตูหลัก)
   */
  function doorFor(room, ch, x, y) {
    const list = Array.isArray(room.doors) && room.doors.length ? room.doors : [room.door];
    if (ch.role === "lead" || list.length === 1) return room.door;
    const at = tileOfPos(room, x, y);
    let best = room.door;
    let bestD = Infinity;
    for (const d of list) {
      const dd = Math.abs(d.tx - at.tx) + Math.abs(d.ty - at.ty);
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
    return best;
  }

  /** จุดยืนที่ประตู (เดินออก): ประตูที่ใกล้ตัวที่สุด หันหน้าออก (ประตูหลัง = หันหลังขึ้น · ประตูข้าง = หันซ้าย) */
  function doorSpot(room, ch) {
    const d = ch ? doorFor(room, ch, ch.x, ch.y) : room.door;
    return { id: `exit:${d.id || "door"}`, kind: "spot", tx: d.tx, ty: d.ty, x: d.x, y: d.y, facing: d.outDir || "up", urgent: true };
  }

  /** ช่องธรณีตรงจุด (x, y) ว่างไหม: ไม่มีคนที่ "มองเห็นอยู่" (หรือกำลังจางเข้า) ยืนทับในรัศมีราวครึ่งตัว */
  function laneFree(room, self, x, y) {
    const check = (c) =>
      !!c && c !== self && !c._s.removed && (c.alpha > 0.02 || c._s.fadeIn) && Math.abs(c.x - x) < 12 && Math.abs(c.y - y) < 12;
    if (check(characters.get(room.sessionId))) return false;
    for (const key of room._r.helperKeys) if (check(characters.get(key))) return false;
    return true;
  }

  /**
   * ผู้ช่วยใหม่: รอ "นอกฉาก" หลังประตูจนถึงคิวตัวเอง (เหลื่อมเวลา) และช่องธรณีของตัวเองว่าง → ปุ๊ฟ ค่อย ๆ ปรากฏ
   * แล้วเดินไปโต๊ะ — ทีละคนต่อช่อง ไม่ยืนซ้อนกันเป็นก้อนโปร่งแสงบนธรณี (เดิม 13 คนกองอยู่ 5 จุดบนธรณีเดียว)
   * ประตูที่ใช้ = ประตูที่ใกล้โต๊ะของตัวเองที่สุด · ทางเดินเข้าไกลเกิน ENTER_HURRY_TILES → เดินเร็วขึ้น
   * (อ่านเป็น "รีบไปนั่งโต๊ะ" — คนที่เพิ่งถูกจ้างใช้เวลาเดินเข้าห้องสั้นลง ไม่ใช่ยืนอยู่กลางทางตอน tool เปลี่ยน)
   */
  function enterFromDoor(ch, room, delay, walkToSeat, order = 0) {
    const s = ch._s;
    const seat = ownSeat(ch, room);
    const d = walkToSeat ? doorFor(room, ch, seat.x, seat.y) : room.door;
    const lanes = ch.role === "lead" || !Array.isArray(d.lanes) || !d.lanes.length ? [d.x] : d.lanes;
    /* ช่องประจำตัวถูกกำหนดครั้งเดียว (สลับกันตามลำดับ) — ตัวที่ซ่อนอยู่จะไม่ถูกย้ายช่องไปมา */
    ch.x = lanes[Math.abs(Math.floor(num(order))) % lanes.length];
    ch.y = d.y;
    ch.alpha = 0;
    ch.dir = d.inDir || "down";
    const steps = [{ k: "enter", delay: Math.max(0, num(delay)), doorId: d.id || "door" }];
    if (walkToSeat) {
      steps.push({
        k: "goto",
        spot: (c, r) => {
          const st = ownSeat(c, r);
          const far = Math.abs(st.tx - Math.floor(c.x / TILE)) + Math.abs(st.ty - Math.floor(c.y / TILE)) > ENTER_HURRY_TILES;
          return { ...seatDesire(c, r, "sit-think"), urgent: true, speed: far && !RM ? ENTER_HURRY : 1, hurry: far && !RM };
        },
      });
    }
    s.beat = makeScript("enter", steps);
  }

  /** วางตัวละครที่จุดของสถานะจริงทันที (sync แรก = baseline เงียบ ไม่มีการเดินเข้า) */
  function placeDirect(ch, room) {
    const s = ch._s;
    if (ch.role === "helper") {
      /* ผู้ช่วย "เริ่มจากโต๊ะตัวเอง" — การตัดสินว่าไปสถานีทันไหม (helperDesire) วัดระยะจากที่นี่ ไม่ใช่จาก (0,0) */
      const seat = ownSeat(ch, room);
      ch.x = seat.x;
      ch.y = seat.y;
    }
    s.dwell = false;
    const d = liveDesire(ch, room);
    releaseTarget(room, ch);
    s.target = resolveTarget(ch, room, d);
    s.desire = d;
    s.path = [];
    s.pathIdx = 0;
    s.arrived = true;
    s.arrivedAt = clock - MIN_DWELL_S;
    ch.x = s.target.x;
    ch.y = s.target.y;
    ch.dir = d.dir || s.target.facing || "down";
    ch.alpha = 1;
    ch.moving = false;
    present(ch, room, 0);
  }

  function markPropError(room, ch) {
    const t = ch._s.target;
    if (!t || !ch._s.arrived) return;
    const until = clock + 2;
    if (t.station === "terminal" && !t.queued && !t.fallback) room._r.errUntil.set("terminal", until);
    else if (t.id === "seat" || t.fallback) {
      if (ch.role === "lead") room._r.errUntil.set("lead-desk", until);
      else if (ch.deskIndex != null) room._r.errUntil.set(`desk-${ch.deskIndex}`, until);
    }
  }

  function oopsBeat(denied) {
    return makeScript(denied ? "denied" : "oops", [
      {
        k: "act",
        pose: "oops",
        dur: 0.8,
        face: "surprised",
        onStart: (c, r) => {
          c.shake = RM ? 0 : 1;
          const t = c._s.target;
          const st = t && t.station && !t.queued && !t.fallback ? r.stations[t.station] : null;
          const fx = st ? st.anchor.x : c.x;
          const fy = st ? st.anchor.y : c.y - 20;
          addEffect(t && t.station === "terminal" ? "smoke" : "spark", c.sessionId, fx, fy);
          if (denied) addEffect("stamp", c.sessionId, c.x, c.y - 28);
          markPropError(r, c);
        },
      },
    ]);
  }

  function waveBeat() {
    return makeScript("wave", [{ k: "act", pose: "wave", dur: 1.5, face: "happy" }]);
  }

  /**
   * จดหมาย = prompt ใหม่: note คือข้อความ prompt จริง (ตัดสั้น) ให้ป้ายอธิบายว่าหัวหน้ากำลังอ่านอะไร
   * ระหว่างที่บทนี้เล่นอยู่ — caption หลักยังเป็นสถานะจริง (เช่น "คิดอยู่") ตามกฎความซื่อตรง
   */
  function mailBeat(room, text) {
    const t = truncate(oneLine(text), SPEECH_CHARS);
    return makeScript("mail", [
      {
        k: "fn",
        fn: (c, r) => {
          const mb = r.stations.mailbox.anchor;
          addEffect("letter", c.sessionId, mb.x, mb.y - 6, {
            from: { x: r.door.x, y: r.door.y - 18 },
            to: { x: mb.x, y: mb.y - 6 },
          });
          r._r.mailFull = true;
        },
      },
      {
        k: "visit",
        dur: 1.8,
        spot: () => stationDesire("mailbox", "read-letter", { dir: "down", icon: "envelope" }),
        onArrive: (c, r) => {
          r._r.mailFull = false;
        },
      },
    ], { note: t ? `📬 คำสั่งใหม่: "${t}"` : "📬 คำสั่งใหม่" });
  }

  /** เล่าย้อน tool ที่เริ่มและจบไปแล้วระหว่างสอง poll — ยกเลิกทันทีที่หัวหน้าไม่ได้ "กำลังคิด" แล้ว */
  function replayBeat(ev) {
    const a = activityOf(ev.tool);
    const label = oneLine(ev.label);
    const caption = {
      icon: "✓",
      text: `เมื่อกี้ · ${str(ev.icon) || a.emoji} ${ev.tool}${label ? ` ${label}` : ""}`,
      sinceMs: null,
      tone: ev.error === true ? "bad" : "good",
      replay: true,
    };
    return makeScript(
      "replay",
      [{ k: "visit", dur: 1.2, spot: (c, r) => ({ ...activityDesire(c, r, a, false), id: `replay:${a.station}` }) }],
      {
        caption,
        abortIf: (c) => !(c.node && c.node.alive !== false && normState(c.node) === "thinking"),
      },
    );
  }

  /**
   * ผู้รับรายงาน: ผู้จ้าง (หัวหน้า หรือผู้ช่วยที่เป็นแม่) → ผู้จ้างไม่อยู่แล้ว → ที่นั่งของผู้จ้าง (ถ้ายังมีโต๊ะ)
   * → ไม่มีอีก → หัวหน้า → ที่นั่งหัวหน้า · ตั้ง sc.hirerKey / sc.hirerPos แล้วคืนจุดยึด (พิกัดในห้อง)
   */
  function pickHirer(ch, room, sc) {
    const hirer = characters.get(ch.parentKey);
    let anchor = null;
    sc.hirerKey = null;
    if (hirer && hirer !== ch && !hirer._s.exit && hirer.alpha > 0.2) {
      anchor = { x: hirer.x, y: hirer.y };
      sc.hirerKey = hirer.key;
    } else if (hirer && hirer.role === "helper" && hirer.deskIndex != null && room.desks[hirer.deskIndex]) {
      anchor = { x: room.desks[hirer.deskIndex].seat.x, y: room.desks[hirer.deskIndex].seat.y };
    } else {
      const lead = characters.get(ch.sessionId);
      if (lead && lead !== ch && !lead._s.exit && lead.alpha > 0.2) {
        anchor = { x: lead.x, y: lead.y };
        sc.hirerKey = lead.key;
      } else anchor = { x: room.leadSeat.x, y: room.leadSeat.y };
    }
    sc.hirerPos = anchor;
    return anchor;
  }

  /** ระยะแมนฮัตตัน (ช่อง) ระหว่างสองจุดในห้อง */
  function tilesApart(room, a, b) {
    const p = tileOfPos(room, a.x, a.y);
    const q = tileOfPos(room, b.x, b.y);
    return Math.abs(p.tx - q.tx) + Math.abs(p.ty - q.ty);
  }

  /** จุดส่งรายงาน: ช่องว่างข้าง ๆ ผู้รับ (ดู pickHirer) */
  function deliverSpot(ch, room, sc) {
    const anchor = pickHirer(ch, room, sc);
    const at = tileOfPos(room, anchor.x, anchor.y);
    const avoid = at.ty * room.w + at.tx;
    let k = nearestFreeTile(room, at.tx, at.ty, ch.key, { radius: 6, queueOnly: false, avoid });
    if (k < 0) k = nearestWalkable(room, at.tx, at.ty);
    const tx = k % room.w;
    const ty = (k / room.w) | 0;
    room._r.res.set(k, ch.key);
    const x = tx * TILE + 8;
    const y = ty * TILE + STAND_Y;
    return {
      id: `deliver:${k}`,
      kind: "spot",
      tx,
      ty,
      x,
      y,
      facing: dirOf(anchor.x - x, anchor.y - y),
      resTile: k,
      urgent: true,
      walkItem: "paper",
    };
  }

  function giveTo(ch, room, sc, cls) {
    const hirer = sc.hirerKey ? characters.get(sc.hirerKey) : null;
    const to = hirer ? { x: hirer.x, y: hirer.y } : sc.hirerPos || { x: room.leadSeat.x, y: room.leadSeat.y };
    sc.dir = dirOf(to.x - ch.x, to.y - ch.y);
    /*
     * กระดาษบิน "ถึงตัว" ผู้จ้างจริง: ยิ่งไกลยิ่งบินนาน (ข้ามห้อง ~1 วิ แทนวาบ 0.6 วิ) และโค้งสูงตามระยะ
     * ⇒ การยื่นจากที่ยืนข้ามห้องอ่านออกว่าเป็นการส่งมอบ ไม่ใช่ยื่นกระดาษให้อากาศแล้วหายไป
     */
    const dist = Math.hypot(to.x - ch.x, to.y - ch.y);
    const flight = Math.min(1.2, 0.45 + dist / 360);
    addEffect("paper", ch.sessionId, to.x, to.y - 12, {
      from: { x: ch.x, y: ch.y - 12 },
      to: { x: to.x, y: to.y - 12 },
      ttl: flight,
      arc: Math.round(Math.min(36, 8 + dist * 0.12)),
    });
    if (hirer && !hirer._s.exit) {
      /*
       * สเปกให้ผู้จ้างขึ้นหัวใจ/เครื่องหมายถูก — แต่ถ้างานล้มเหลวจริง การขึ้นหัวใจคือการเล่าเกินจริง
       * จึงใช้ "✗" โทนแดงแทนเมื่อ outcome เป็น failed/error · ฟองขึ้น "ตอนกระดาษถึงมือ" ไม่ใช่ตอนเริ่มโยน
       */
      const ok = cls !== "failed";
      const icon = ok ? (hash32(ch.key) & 1 ? "heart" : "check") : "cross";
      const land = flight * 0.85;
      hirer._s.ack = { bubble: { kind: "speech", icon, tone: ok ? "good" : "bad", blink: false }, from: clock + land, until: clock + land + 1.1 };
      /* t ติดลบ = เอฟเฟกต์ที่ "นัดไว้" (scene ไม่วาดจนกว่า t ≥ 0) — หัวใจเด้งตอนกระดาษถึง */
      if (ok && icon === "heart") addEffect("heart", ch.sessionId, hirer.x, hirer.y - 30, { t: -land });
    }
  }

  /**
   * คืนโต๊ะทันทีที่เริ่มบทจากไป — คนที่จบงานแล้วไม่กลับไปนั่งอีก โต๊ะจึงควรเป็นของคนที่ยังรอเข้าห้อง
   * (ภาพ "ผู้ช่วยใหม่เดินเข้าประตูขณะที่คนเก่าเดินออก" คือเรื่องจริงของพายุงาน)
   */
  function releaseDesk(ch, room) {
    if (ch.role !== "helper") return;
    const d = ch.deskIndex != null ? room.desks[ch.deskIndex] : null;
    if (d && d.owner === ch.key) d.owner = null;
    ch.deskIndex = null;
  }

  /**
   * ขั้นสุดท้ายของบทจากไป: ประตูอยู่ใกล้ → เดินออกประตูแล้วจาง · ไกล (ผู้ช่วยที่อยู่อีกฟากห้อง) → ปุ๊ฟหาย
   * ตัดสินตอนถึงขั้นนี้จริง (ไม่ใช่ตอนเริ่มบท) เพราะระหว่างนั้นอาจเดินไปส่งงานมาแล้ว
   */
  function exitSteps(allowPoof) {
    return [
      {
        k: "fn",
        fn: (c, r, sc) => {
          const d = doorFor(r, c, c.x, c.y);
          sc.exitDoor = d;
          sc.poof = !!allowPoof && tilesApart(r, c, d) > EXIT_DOOR_FAR_TILES;
        },
      },
      {
        k: "goto",
        spot: (c, r, sc) => {
          if (sc.poof) return null;
          /* คำนวณใหม่ได้กลางทาง (ห้องหด → ประตูข้างหายไป) — จำประตูที่ใช้จริงไว้ให้ขั้นจางหายหันถูกทิศ */
          sc.exitDoor = doorFor(r, c, c.x, c.y);
          return doorSpot(r, c);
        },
      },
      { k: "fade", dur: 0.4 },
    ];
  }

  /**
   * sub จบ (running → false): ดีใจ/เสียใจ → ถือรายงานไปส่งผู้จ้าง → เดินออกประตู → หายไป
   * ผู้จ้างอยู่ไกล หรือห้องเต็มเพดาน (มีคนทำงานจริงรอวาดอยู่) → ยื่นรายงานจากที่ยืนแล้วปุ๊ฟหาย
   */
  function startDeliver(ch, room, sub) {
    const s = ch._s;
    if (s.exit || s.removed) return;
    const cls = outcomeClass(sub && sub.outcome);
    ch.leaving = true;
    ch.state = cls === "ok" ? "done" : cls === "failed" ? "failed" : cls === "killed" ? "killed" : "ended";
    /* ยังไม่ทันโผล่ให้เห็นเลย (ยังรอคิวเข้าประตู) — ไม่ต้องเล่นบทส่งงานของคนที่ไม่เคยปรากฏ */
    if (ch.alpha <= 0.01 && !s.fadeIn) {
      removeCharacter(ch);
      return;
    }
    s.beats.length = 0;
    s.beat = null;
    releaseDesk(ch, room);
    const steps = [];
    if (cls === "ok") {
      steps.push({
        k: "act",
        pose: "celebrate",
        dur: 1.2,
        face: "happy",
        onStart: (c) => addEffect("sparkle", c.sessionId, c.x, c.y - 26),
      });
    } else if (cls === "failed") {
      steps.push({
        k: "act",
        pose: "sad",
        dur: 1.5,
        face: "sad",
        onStart: (c) => addEffect("rain", c.sessionId, c.x, c.y - 30),
      });
    } else if (cls === "unknown") {
      steps.push({ k: "act", pose: "stand", dur: 0.5 });
    }
    const probe = {};
    const anchor = cls !== "killed" ? pickHirer(ch, room, probe) : null;
    if (cls !== "killed" && !probe.hirerKey) {
      /*
       * ผู้จ้างไม่อยู่ให้เห็นแล้ว (ส่งงานออกไปก่อน / หัวหน้ากลับบ้าน): ท่ายื่นกระดาษให้ "ความว่าง" ไม่สื่ออะไร
       * (เดิมยืนยื่นกระดาษไปทางเก้าอี้ว่างแล้วจางหาย) → จบแค่ท่าดีใจ/เสียใจ แล้วออก (ประตูใกล้ → เดินออก ·
       * ไกล → ปุ๊ฟ) — ฟีดยังบอกชื่อผู้จ้างจริงครบ ภาพไม่เล่าการส่งมอบที่ไม่มีใครรับ
       */
      steps.push(...exitSteps(true));
    } else if (cls !== "killed") {
      const trip = tilesApart(room, ch, anchor);
      /*
       * ห้องเต็มเพดาน (มีคนทำงานจริงรอวาดอยู่) ก็ยังเดินไปยื่นถึงตัวถ้าใกล้ ≤ 6 ช่อง — ห้องเล็กต้องได้เห็นเรื่องครบ
       * (เดิม overflow > 0 ตัดทุกคนเป็นยื่นจากที่ยืน ในพายุงานแทบไม่มีใครเดินไปหาผู้จ้างเลย)
       */
      const short = trip > DELIVER_FAR_TILES || (room.overflow > 0 && trip > DELIVER_NEAR_TILES);
      if (short) {
        /* ยื่นจากที่ยืน หันหาผู้จ้าง: กระดาษโค้งลอยข้ามห้องไปถึงตัว แล้วผู้จ้างค่อยขึ้นหัวใจ/✗ ตอนกระดาษถึง */
        steps.push({
          k: "act",
          pose: "give",
          dur: 0.8,
          item: "paper",
          onStart: (c, r, sc) => {
            pickHirer(c, r, sc);
            giveTo(c, r, sc, cls);
          },
        });
        steps.push({ k: "fn", fn: (c, r, sc) => (sc.poof = true) });
        steps.push({ k: "fade", dur: 0.4 });
      } else {
        steps.push({ k: "goto", spot: (c, r, sc) => deliverSpot(c, r, sc) });
        steps.push({ k: "act", pose: "give", dur: 0.8, item: "paper", onStart: (c, r, sc) => giveTo(c, r, sc, cls) });
        steps.push(...exitSteps(true));
      }
    } else {
      steps.push(...exitSteps(true));
    }
    s.exit = makeScript("deliver", steps, { deadline: clock + EXIT_TIMEOUT_S, outcome: cls, poof: false });
    refreshCaption(ch);
  }

  /** หัวหน้าเลิกงาน (process จบ) → เดินไปประตู จางหาย แล้วห้องปิดไฟ · ผู้ช่วยที่หายไปจาก snapshot → ออกจากห้อง */
  function startLeave(ch, type, state) {
    const s = ch._s;
    if (s.exit || s.removed) return;
    ch.leaving = true;
    ch.state = state;
    s.beats.length = 0;
    s.beat = null;
    const room = rooms.get(ch.sessionId);
    if (room) releaseDesk(ch, room);
    /* หัวหน้าเดินออกประตูเสมอ (บท "กลับบ้าน" ตามสเปก) — ผู้ช่วยที่อยู่ไกลประตูปุ๊ฟหายได้ */
    s.exit = makeScript(type, exitSteps(ch.role === "helper"), { deadline: clock + EXIT_TIMEOUT_S, poof: false });
    refreshCaption(ch);
  }

  /* ───────────── caption (ป้ายซื่อตรง) ───────────── */

  function setCaption(ch, icon, text, sinceMs, tone, replay) {
    const c = ch.caption;
    c.icon = icon;
    c.text = text;
    c.sinceMs = sinceMs;
    c.tone = tone;
    c.replay = replay;
  }

  /**
   * caption หลัก (สถานะจริง) + note เสริมระหว่างบทที่ภาพกำลังเล่าอยู่ (ตอนนี้มีแค่บทจดหมาย: ข้อความ prompt จริง)
   * note ไม่แทนที่ caption — แค่อธิบายว่าท่าบนจอ (อ่านจดหมาย) มาจากเหตุการณ์ไหน
   */
  function refreshCaption(ch) {
    baseCaption(ch);
    const b = ch._s.beat;
    ch.captionNote = b && b.type === "mail" && typeof b.note === "string" && b.note ? b.note : null;
  }

  function baseCaption(ch) {
    const s = ch._s;
    const node = ch.node || {};
    if (ch.role === "lead") {
      if (node.alive === false) return setCaption(ch, "🌙", "ปิดแล้ว", null, "neutral", false);
      const st = normState(node);
      const since = parseTs(isObj(node.status) ? node.status.since : null);
      if (st === "thinking" && s.beat && s.beat.type === "replay" && s.beat.caption) {
        const c = s.beat.caption;
        return setCaption(ch, c.icon, c.text, null, c.tone, true);
      }
      if (st === "tool") {
        const e = primaryEntry(node);
        if (!e) return setCaption(ch, "🛠", "ใช้เครื่องมือ", since, "info", false);
        const a = activityOf(e.tool);
        return setCaption(ch, str(e.icon) || a.emoji, joinText(a.verb, e.label), parseTs(e.startedTs), "info", false);
      }
      if (st === "delegating") {
        const agentEntry = runningList(node).find((e) => DELEGATE_TOOLS.has(e.tool));
        const n = isObj(node.subTotals) ? num(node.subTotals.running, 0) : 0;
        const text = n > 0 ? `สั่งงานผู้ช่วย · ทำงานอยู่ ${n} คน` : "สั่งงานผู้ช่วย";
        return setCaption(ch, "🤖", text, (agentEntry && parseTs(agentEntry.startedTs)) || since, "info", false);
      }
      if (st === "waiting") {
        const list = runningList(node);
        const ask = list.find((e) => e.tool === ASK_TOOL);
        if (ask) return setCaption(ch, "🙋", joinText("รอคุณตอบ", ask.label ? `· ${oneLine(ask.label)}` : ""), since, "warn", false);
        const e = primaryEntry(node);
        const what = e ? `· ${joinText(e.tool, e.label)}` : "";
        return setCaption(ch, "✋", joinText("รออนุญาต", what), since, "warn", false);
      }
      if (st === "thinking") return setCaption(ch, "💭", "คิดอยู่", since, "info", false);
      if (st === "idle") return setCaption(ch, "☕", "ว่าง", since, "neutral", false);
      if (st === "blocked") {
        const by = isObj(node.status) ? oneLine(node.status.endedBy) : "";
        return setCaption(ch, "⛔", by ? `ติดด่าน · ${by}` : "ติดด่าน", since, "bad", false);
      }
      return setCaption(ch, "❔", "ไม่ทราบสถานะ", null, "neutral", false);
    }
    if (s.exit) {
      const cls = s.exit.outcome;
      if (s.exit.type !== "deliver") return setCaption(ch, "👋", "ออกจากห้อง", null, "neutral", false);
      if (cls === "ok") return setCaption(ch, "✅", "ส่งงานแล้ว", null, "good", false);
      if (cls === "failed") return setCaption(ch, "❌", `ไม่สำเร็จ (${str(node.outcome) || "failed"})`, null, "bad", false);
      if (cls === "killed") return setCaption(ch, "⏹", "ถูกหยุดกลางคัน", null, "warn", false);
      return setCaption(ch, "❔", "จบงาน (ไม่ทราบผล)", null, "neutral", false);
    }
    const cur = isObj(node.current) && typeof node.current.tool === "string" && node.current.tool ? node.current : null;
    if (cur) {
      const a = activityOf(cur.tool);
      return setCaption(ch, str(cur.icon) || a.emoji, joinText(a.verb, cur.label), parseTs(cur.startedTs), "info", false);
    }
    const lt = isObj(node.lastTool) && typeof node.lastTool.tool === "string" ? node.lastTool : null;
    const tail = lt ? ` · ล่าสุด ${lt.tool} ${lt.error === true ? "✗" : "✓"}` : "";
    return setCaption(ch, "💭", `คิดอยู่${tail}`, null, lt && lt.error === true ? "warn" : "info", false);
  }

  /* ───────────── ต่อเฟรม: เดิน + ท่าทาง ───────────── */

  function present(ch, room, dt) {
    const s = ch._s;
    const d = s.desire;
    const t = s.target;
    const hold = s.hold;
    let pose = "stand";
    let dir = ch.dir;
    let item = null;
    let face = null;
    let bubble = null;
    let glow = null;
    if (hold && hold.kind === "here") {
      pose = hold.pose || "stand";
      if (hold.dir) dir = hold.dir;
      face = hold.face;
      item = hold.item || null;
      bubble = hold.bubble || null;
      glow = hold.glow || null;
    } else if (hold && hold.kind === "hidden") {
      pose = "stand";
    } else if (ch.moving) {
      pose = "walk";
      item = (d && d.walkItem) || null;
    } else if (t && s.arrived && d) {
      if (s.dwell) {
        /* ช่วง dwell: ท่าเป็นกลาง ไม่มีฟอง/ของในมือ/แสงจอของสถานะเก่า (ดู applyDesire) */
        pose = SEATED_POSES.has(d.pose) || t.id === "seat" ? "sit-idle" : "stand";
        dir = pose === "stand" ? t.facing || dir : "down";
      } else if (t.queued) {
        pose = "stand";
        dir = t.facing;
        bubble = { kind: "thought", icon: d.icon || "dots", tone: "neutral", blink: false };
      } else if (t.fallback) {
        /* สถานีเต็มทั้งช่องทั้งคิว: ทำที่โต๊ะตัวเองไปก่อน ไอคอนบอกว่ากำลังทำงานแบบไหนอยู่ */
        pose = "sit-type";
        dir = "down";
        glow = "on";
        bubble = { kind: "thought", icon: d.icon || "dots", tone: "neutral", blink: false };
      } else {
        pose = d.pose || "stand";
        dir = d.dir || t.facing || dir;
        face = d.face || null;
        item = d.item || null;
        bubble = d.bubble || null;
        glow = d.glow || null;
      }
    }
    if (s.ack) {
      if (clock >= s.ack.until) s.ack = null;
      else if (clock >= (s.ack.from || 0)) bubble = s.ack.bubble;
    }
    if (!face) face = DEFAULT_FACE[pose] || "normal";
    if (ch.talking && face !== "sleep") face = "talk";
    if (pose !== s.lastPose) {
      s.lastPose = pose;
      s.animT = 0;
    }
    ch.pose = pose;
    ch.dir = dir;
    ch.item = item;
    ch.face = face;
    ch.bubble = bubble;
    ch.glow = glow;
    const frames = POSE_FRAMES[pose] || 1;
    let fps = pose === "walk" ? WALK_FPS : POSE_FPS;
    /* เดินเร็วขึ้น (รีบเข้าโต๊ะ) → ก้าวถี่ขึ้นตาม ไม่งั้นดูเหมือนไถลบนพื้น */
    if (pose === "walk" && d && d.speed > 1) fps *= d.speed;
    if (RM) fps /= 2;
    if (RM && IDLE_BOB_POSES.has(pose)) {
      ch.frame = 0;
    } else {
      s.animT += dt * fps;
      ch.frame = frames > 1 ? Math.floor(s.animT) % frames : 0;
    }
    ch.sortY = room.y + ch.y;
  }

  function tickCharacter(ch, dt) {
    const s = ch._s;
    const room = rooms.get(ch.sessionId);
    if (!room) {
      s.remove = true;
      return;
    }
    let d = null;
    if (s.exit) {
      if (clock > s.exit.deadline) {
        s.remove = true;
        return;
      }
      d = runScript(ch, room, s.exit, dt);
      if (!d) {
        s.remove = true;
        return;
      }
    } else {
      if (s.beat) {
        d = runScript(ch, room, s.beat, dt);
        if (!d) {
          s.beat = null;
          refreshCaption(ch);
        }
      }
      if (!s.beat) {
        const nb = nextBeat(s);
        if (nb) {
          s.beat = nb;
          d = runScript(ch, room, nb, 0);
          if (!d) s.beat = null;
          refreshCaption(ch);
        }
      }
      if (!d) d = liveDesire(ch, room);
    }

    applyDesire(ch, room, d);

    if (!s.hold && s.target && !s.arrived) {
      const factor = s.desire && s.desire.speed ? s.desire.speed : 1;
      const done = stepMove(ch, s, dt, WALK_SPEED * factor);
      ch.moving = !done;
      if (done) {
        s.arrived = true;
        s.arrivedAt = clock;
        ch.x = s.target.x;
        ch.y = s.target.y;
      }
    } else {
      ch.moving = false;
    }

    if (s.hold && s.hold.kind === "hidden") ch.alpha = 0;
    else if (s.fadeIn) {
      ch.alpha = Math.min(1, ch.alpha + dt / FADE_IN_S);
      if (ch.alpha >= 1) s.fadeIn = false;
    }

    if (ch.speech && clock >= ch.speech.until) ch.speech = null;
    if (ch.talking && clock >= s.talkUntil) ch.talking = false;
    if (ch.shake > 0) ch.shake = Math.max(0, ch.shake - dt / 0.8);

    present(ch, room, dt);

    const r = room._r;
    const t = s.target;
    const dsr = s.desire;
    if (!s.hold && !s.dwell && t && s.arrived && dsr) {
      if (t.station && !t.queued && !t.fallback) {
        const st = room.stations[t.station];
        if (st) st.busy++;
        if (t.station === "whiteboard") r.boardUsedAt = clock;
        if (t.station === "phone" && dsr.ringing) r.phoneRinging = true;
      }
      if ((dsr.zzz || dsr.rain) && clock >= s.fxAt && !t.queued && !t.fallback) {
        s.fxAt = clock + (dsr.zzz ? 1.4 : 1.7);
        /* zZz (16×16) เยื้องขวาบนของหัว — ไม่บังหน้าคนหลับ */
        if (dsr.zzz) addEffect("zzz", ch.sessionId, ch.x + 7, ch.y - 28);
        else addEffect("rain", ch.sessionId, ch.x, ch.y - 30);
      }
    }
    if (ch.alpha > 0) {
      if (Math.abs(ch.x - room.door.x) < 22 && Math.abs(ch.y - room.door.y) < 14) r.doorOpenUntil = clock + 0.5;
      else if (ch.x < 20 && room.doors && room.doors.length > 1) {
        /* ประตูข้าง: เปิดเฉพาะตอนมีคนอยู่ในช่องประตู/กำลังก้าวผ่าน (คนเดินผ่านทางเดินคอลัมน์ 1 ไม่นับ) */
        for (const d of room.doors) if (d.tx === 0 && Math.abs(ch.y - d.y) < 12) r.sideOpenUntil.set(d.id, clock + 0.5);
      }
    }
  }

  /** variant ของเฟอร์นิเจอร์ตามการใช้งานจริงในเฟรมนี้ (ชั้น sorted วาดทุกเฟรมอยู่แล้ว ไม่ต้องอบใหม่) */
  function refreshProps(room) {
    const r = room._r;
    const P = r.propById;
    const set = (id, variant, frame = 0) => {
      const p = P.get(id);
      if (p) {
        p.variant = variant;
        p.frame = frame;
      }
    };
    const err = (id) => (r.errUntil.get(id) || 0) > clock;
    const st = room.stations;
    const blink = Math.floor(clock * (RM ? 1 : 2)) % 2;
    set("terminal", err("terminal") ? "error" : st.terminal.busy ? "active" : "idle", st.terminal.busy && !err("terminal") ? blink : 0);
    set("kiosk", st.kiosk.busy ? "active" : "idle");
    set("printer", st.printer.busy ? "active" : "idle");
    set("cabinet", st.cabinet.busy ? "open" : "closed");
    set("cctv", st.cctv.busy ? "on" : "default");
    set("phone", r.phoneRinging ? "ringing" : "idle", r.phoneRinging ? blink : 0);
    set("whiteboard", clock - r.boardUsedAt < 90 ? "scribble" : "clean");
    set("mailbox", r.mailFull ? "full" : "empty");
    set("door", r.doorOpenUntil > clock ? "open" : "closed");
    for (const d of room.doors || []) if (d.id !== "door") set(d.id, (r.sideOpenUntil.get(d.id) || 0) > clock ? "open" : "closed");
    for (const [id, until] of Array.from(r.sideOpenUntil)) if (until <= clock) r.sideOpenUntil.delete(id);
    for (const desk of room.desks) {
      const id = `desk-${desk.index}`;
      const owner = desk.owner ? characters.get(desk.owner) : null;
      const working = !!owner && owner.glow === "on" && SEATED_POSES.has(owner.pose);
      set(id, err(id) ? "error" : owner && owner.glow === "error" ? "error" : working ? "on" : "off");
    }
    const lead = characters.get(room.sessionId);
    const leadSeated = !!lead && SEATED_POSES.has(lead.pose) && lead._s.target && lead._s.target.id === "seat";
    /* โต๊ะหัวหน้าตอนติดด่าน: ไฟเตือนบนโต๊ะกะพริบ (เฟรม 0/1) — คนที่ฟุบอยู่หลังแล็ปท็อปเห็นแค่ผม โต๊ะต้องบอกแทน */
    const leadErr = err("lead-desk") || (leadSeated && lead.glow === "error");
    set("lead-desk", leadErr ? "error" : leadSeated ? "on" : "off", leadErr ? blink : 0);
    for (const [id, until] of Array.from(r.errUntil)) if (until <= clock) r.errUntil.delete(id);
  }

  /* ───────────── sync: diff snapshot เอง ───────────── */

  function scanEvents(list, maxI) {
    const arr = Array.isArray(list) ? list : [];
    let hi = -Infinity;
    for (const ev of arr) if (isObj(ev) && Number.isFinite(ev.i)) hi = Math.max(hi, ev.i);
    if (maxI === null || maxI === undefined) return { fresh: [], maxI: Number.isFinite(hi) ? hi : -1 };
    /* transcript เริ่มนับใหม่ (i ย้อนกลับ) → ตั้ง baseline ใหม่ ไม่เล่นทั้งก้อนซ้ำ */
    if (Number.isFinite(hi) && hi < maxI) return { fresh: [], maxI: hi };
    const fresh = arr.filter((ev) => isObj(ev) && Number.isFinite(ev.i) && ev.i > maxI).sort((a, b) => a.i - b.i);
    return { fresh, maxI: Number.isFinite(hi) ? Math.max(hi, maxI) : maxI };
  }

  function isDoneTool(ev) {
    return ev.done === true || (ev.done === undefined && Number.isFinite(ev.durMs));
  }

  function scoreInto(score, s) {
    const tot = isObj(s.subTotals) ? s.subTotals : null;
    const subs = Array.isArray(s.subagents) ? s.subagents.filter(isObj) : [];
    const pick = (field, fallback) => (tot && Number.isFinite(tot[field]) ? tot[field] : fallback());
    score.running = pick("running", () => subs.filter((x) => x.running === true).length);
    score.done = pick("done", () => subs.filter((x) => x.running !== true).length);
    score.failed = pick("failed", () => subs.filter((x) => outcomeClass(x.outcome) === "failed").length);
    /* errors บนป้าย = error ของฝั่งผู้ช่วย (ป้ายนี้คือสกอร์ของทีมผู้ช่วย) */
    score.errors = pick("errors", () => subs.reduce((n, x) => n + num(x.errors, 0), 0));
    score.total = pick("total", () => subs.length);
  }

  function syncSession(s, silent, batch) {
    const sid = s.sessionId;
    let room = rooms.get(sid);
    const isNew = !room;
    if (isNew) room = createRoom(s);
    const prev = sessDiff.get(sid) || null;
    const alive = s.alive !== false;
    const st = normState(s);
    const title = sessionDisplayName(s);

    room.node = s;
    room.title = title;
    room.subtitle = [basename(s.cwd), oneLine(s.gitBranch), oneLine(s.entrypoint)].filter(Boolean).join(" · ");
    room.modelTag = modelTagOf(s.model);
    room.state = st;
    room.alive = alive;
    room.endedAgo = Math.max(0, num(s.endedAgo, 0));
    scoreInto(room.score, s);

    const counts = isObj(s.counts) ? s.counts : {};
    const errors = Math.max(0, num(counts.errors, 0));
    const denials = Math.max(0, num(counts.denials, 0));
    const running = runningList(s);
    const runningTL = new Set(running.map((e) => toolLabelKey(e.tool, e.label)));
    const primary = primaryEntry(s);
    const primaryKey = entryKey(primary);
    const scan = scanEvents(s.events, prev ? prev.maxI : null);
    const live = !silent && !!prev && !isNew;

    /* ── หัวหน้า ── */
    let lead = characters.get(sid);
    if (alive) {
      if (lead && lead._s.exit) {
        /* process กลับมามีชีวิต (resume session เดิม) ระหว่างกำลังเดินออก → ยกเลิกการกลับบ้าน */
        lead._s.exit = null;
        lead.leaving = false;
        lead._s.fadeIn = true;
      }
      if (!lead) {
        lead = createLead(room, s);
        if (silent) placeDirect(lead, room);
        else enterFromDoor(lead, room, 0, false);
        if (!silent && (isNew || (prev && !prev.alive))) narrate("💡", `เปิดไฟห้อง ${title}`, "info", sid, sid);
      }
      setLights(room, true);
    } else {
      if (lead && !lead._s.exit) {
        if (silent) {
          removeCharacter(lead);
          lead = null;
        } else startLeave(lead, "home", "ended");
      }
      if (!characters.has(sid)) setLights(room, false);
      if (!silent && prev && prev.alive) narrate("🌙", `${title}: ปิดห้องแล้ว`, "info", sid, sid);
    }
    if (lead) {
      lead.node = s;
      lead.name = title;
      lead.state = alive ? st : "ended";
      setLook(lead, modelTagOf(s.model));
    }
    const leadActive = !!lead && !lead._s.exit;

    /* ── เหตุการณ์ใหม่ของหัวหน้า (ข้ามทั้งหมดใน sync แรก = baseline เงียบ) ── */
    if (live) {
      let lastPrompt = null;
      let lastSay = null;
      let sawThinking = false;
      let replayEv = null;
      let errorEv = null;
      let toolErr = null;
      let deniedEv = null;
      let blockedEv = null;
      for (const ev of scan.fresh) {
        const kind = ev.kind;
        if (kind === "prompt") lastPrompt = ev;
        else if (kind === "say") lastSay = ev;
        else if (kind === "thinking") sawThinking = true;
        else if (kind === "error") errorEv = ev;
        else if (kind === "denied") deniedEv = ev;
        else if (kind === "blocked") blockedEv = ev;
        else if (kind === "tool" && typeof ev.tool === "string" && ev.tool) {
          if (ev.error === true) toolErr = ev;
          const tl = toolLabelKey(ev.tool, ev.label);
          /* "เริ่มและจบระหว่างสอง poll" = ไม่เคยเห็นใน running เลยทั้งรอบก่อนและรอบนี้ */
          if (
            !DELEGATE_TOOLS.has(ev.tool) &&
            ev.tool !== ASK_TOOL &&
            isDoneTool(ev) &&
            !prev.runningTL.has(tl) &&
            !runningTL.has(tl)
          ) {
            replayEv = ev;
          }
        }
      }
      if (lastPrompt) {
        const text = truncate(oneLine(lastPrompt.text), 60);
        narrate("📬", `${title}: ได้รับคำสั่งใหม่ — "${text}"`, "info", sid, sid);
        if (leadActive) enqueueBeat(lead, mailBeat(room, lastPrompt.text));
      }
      if (lastSay && lead) {
        const text = truncate(oneLine(lastSay.text), SPEECH_CHARS);
        if (text) lead.speech = { text, until: clock + SPEECH_S };
      }
      if (sawThinking && lead) lead._s.bulbUntil = clock + BULB_S;
      const errBump = errors > prev.errors;
      if (errorEv || toolErr || errBump) {
        if (leadActive) enqueueBeat(lead, oopsBeat(false));
        const src = errorEv || toolErr;
        const text = src
          ? oneLine(src.text) || oneLine(src.errorLabel) || joinText(src.tool, "ล้มเหลว")
          : `${errors - prev.errors} ครั้ง`;
        narrateThrottled("err", sid, sid, "💥", `${title}: error — ${truncate(text, 80)}`, "bad", NARRATE_ERR_GAP_S);
      }
      if (deniedEv || denials > prev.denials) {
        if (leadActive) enqueueBeat(lead, oopsBeat(true));
        const label = deniedEv ? oneLine(deniedEv.denyLabel) || oneLine(deniedEv.text) || "ถูกปฏิเสธ" : "ถูกปฏิเสธ";
        narrate("🛑", `${title}: ถูกปฏิเสธ — ${truncate(label, 80)}`, "bad", sid, sid);
      }
      if (alive && prev.state !== st) {
        if (st === "waiting") {
          const ask = running.some((e) => e.tool === ASK_TOOL);
          narrate(ask ? "🙋" : "✋", `${title}: ${ask ? "รอคุณตอบ" : "รออนุญาต"}`, "warn", sid, sid);
        } else if (st === "blocked") {
          const why =
            (blockedEv && oneLine(blockedEv.text)) ||
            (deniedEv && (oneLine(deniedEv.denyLabel) || oneLine(deniedEv.text))) ||
            (errorEv && oneLine(errorEv.text)) ||
            (isObj(s.status) && oneLine(s.status.endedBy)) ||
            "ไม่ทราบสาเหตุ";
          narrate("⛔", `${title}: ติดด่าน — ${truncate(why, 80)}`, "bad", sid, sid);
        } else if (st === "idle") {
          narrate("☕", `${title}: งานเสร็จ พักจิบกาแฟ`, "good", sid, sid);
        }
      }
      if (alive && st === "tool" && primary && primaryKey !== prev.primaryKey) {
        const a = activityOf(primary.tool);
        narrateThrottled(
          "tool",
          sid,
          sid,
          str(primary.icon) || a.emoji,
          `${title}: ${joinText(a.verb, primary.label)}`,
          "info",
          NARRATE_GAP_S,
          primaryKey,
        );
      }
      if (leadActive && st === "thinking" && replayEv) enqueueBeat(lead, replayBeat(replayEv));
    }
    /* สถานะจริงชนะการเล่าย้อนเสมอ: ถ้าไม่ได้ "กำลังคิด" แล้ว ทิ้งบทเล่าย้อนทั้งที่รอและที่เล่นอยู่ */
    if (lead && (st !== "thinking" || !alive)) {
      const ls = lead._s;
      for (let i = ls.beats.length - 1; i >= 0; i--) if (ls.beats[i].type === "replay") ls.beats.splice(i, 1);
      if (ls.beat && ls.beat.type === "replay") ls.beat = null;
    }

    syncSubs(room, s, silent, isNew, batch);

    sessDiff.set(sid, { alive, state: st, maxI: scan.maxI, runningTL, errors, denials, primaryKey });
  }

  function syncSubs(room, s, silent, isNewRoom, batch) {
    const sid = room.sessionId;
    const list = Array.isArray(s.subagents) ? s.subagents : [];
    const byId = new Map();
    for (const sub of list) {
      if (!isObj(sub)) continue;
      const id = sub.agentId;
      if (typeof id !== "string" || !id || byId.has(id)) continue;
      byId.set(id, sub);
    }
    const prevMap = subDiff.get(sid) || null;
    const nextMap = new Map();
    const newcomers = [];
    let runningCount = 0;
    const errorLines = [];

    for (const [id, sub] of byId) {
      const key = `${sid}:${id}`;
      const running = sub.running === true;
      if (running) runningCount++;
      const p = prevMap ? prevMap.get(id) : undefined;
      const ch = characters.get(key);
      const errs = Math.max(0, num(sub.errors, 0));
      const scan = scanEvents(sub.events, p ? p.maxI : null);
      const parentKey = parentKeyOf(sid, sub, byId);
      if (ch) {
        ch.node = sub;
        ch.parentKey = parentKey;
        setLook(ch, subModelTag(sub));
        if (!ch._s.exit) ch.state = isObj(sub.current) ? "tool" : "thinking";
      }
      if (!silent && p) {
        if (p.running && !running) {
          if (ch) startDeliver(ch, room, sub);
          batch.delivers.push({ sid, room, sub, parentKey, key });
        }
        if (errs > p.errors && running) {
          if (ch && !ch._s.exit) enqueueBeat(ch, oopsBeat(false));
          const lt = isObj(sub.lastTool) ? sub.lastTool : null;
          const text = lt && lt.error === true ? joinText(lt.tool, lt.label) : `${errs - p.errors} ครั้ง`;
          errorLines.push({ key, name: withId(oneLine(sub.type) || "ผู้ช่วย", id), text });
        }
        if (ch && !ch._s.exit) {
          let lastSay = null;
          for (const ev of scan.fresh) if (ev.kind === "say") lastSay = ev;
          if (lastSay) {
            const text = truncate(oneLine(lastSay.text), SPEECH_CHARS);
            if (text) ch.speech = { text, until: clock + SPEECH_S };
          }
        }
      }
      if (running && !characters.has(key)) {
        /* จ้างใหม่จริง = เห็นครั้งแรกตอนกำลังวิ่ง ในห้องที่รู้จักอยู่แล้ว และไม่ใช่ sync แรก */
        const hire = !silent && !p && !isNewRoom;
        newcomers.push({ sub, key, parentKey, hire });
      }
      nextMap.set(id, { running, errors: errs, maxI: scan.maxI });
    }

    /* คนที่มีตัวแต่ sub หายไปจาก snapshot หรือไม่ running แล้วโดยไม่ได้เห็นช่วงเปลี่ยน */
    for (const key of Array.from(room._r.helperKeys)) {
      const ch = characters.get(key);
      if (!ch || ch._s.exit) continue;
      const sub = byId.get(ch.agentId);
      if (!sub) {
        if (silent) removeCharacter(ch);
        else startLeave(ch, "vanish", "gone");
      } else if (sub.running !== true) {
        if (silent) removeCharacter(ch);
        else startDeliver(ch, room, sub);
      }
    }

    subDiff.set(sid, nextMap);

    if (errorLines.length > 2) {
      narrateThrottled("err", sid, sid, "💥", `${room.title}: ผู้ช่วย ${errorLines.length} คนเจอ error`, "bad", NARRATE_ERR_GAP_S);
    } else {
      for (const e of errorLines) {
        narrateThrottled("err", e.key, sid, "💥", `${room.title}: ${e.name} error — ${truncate(e.text, 80)}`, "bad", NARRATE_ERR_GAP_S);
      }
    }

    for (const nc of newcomers) {
      if (!nc.hire) continue;
      let g = batch.hires.get(nc.parentKey);
      if (!g) batch.hires.set(nc.parentKey, (g = { sid, room, types: [], n: 0, byId }));
      g.n++;
      g.types.push(oneLine(nc.sub.type) || "agent");
    }

    placeNewcomers(room, newcomers, silent);

    room.overflow = Math.max(0, runningCount - activeHelperCount(room));
  }

  /**
   * ให้โต๊ะคนที่เพิ่งมา: โตห้องก่อนถ้าจำเป็น (เฉพาะ session ที่ยังมีชีวิต) แล้วแจกโต๊ะว่างเลขน้อยสุด
   * ที่เหลือจากเพดานเป็น overflow — จะได้ตัวเมื่อมีโต๊ะว่าง (เดินเข้าประตูมาทีหลัง)
   */
  function placeNewcomers(room, newcomers, silent) {
    if (!newcomers.length) return;
    newcomers.sort((a, b) => {
      const ta = parseTs(a.sub.startedTs) || 0;
      const tb = parseTs(b.sub.startedTs) || 0;
      if (ta !== tb) return ta - tb;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    /*
     * นับเฉพาะคนที่ "ยังทำงานอยู่" — คนที่จบงานแล้วกำลังส่งงาน/เดินออกคืนโต๊ะไปแล้ว และไม่กินโควตาการวาด
     * (เดิมพายุงานที่จบทีละหลายสิบคนทำให้ตัวที่วาดเกือบครึ่งเป็นคนที่เลิกงานแล้ว ขณะที่คนที่ยังทำงานจริง
     * ถูกซ่อนเป็น "+N ที่ไม่ได้วาด" — ภาพเล่างานที่จบแล้วแทนงานที่กำลังทำ)
     */
    let active = activeHelperCount(room);
    const want = Math.min(MAX_HELPERS, active + newcomers.length);
    if (room.alive && want > room.desks.length) {
      const cap = capacityFor(want);
      if (cap > room.desks.length) resizeRoom(room, cap / DESKS_PER_ROW);
    }
    const n = Math.min(newcomers.length, Math.max(0, MAX_HELPERS - active));
    const step = n > 1 ? Math.min(HIRE_STAGGER_S, HIRE_STAGGER_MAX_S / (n - 1)) : 0;
    let order = 0;
    for (const nc of newcomers) {
      if (active >= MAX_HELPERS) break;
      const desk = freeDesk(room);
      if (!desk) break;
      const ch = createHelper(room, nc.sub, desk, nc.parentKey);
      active++;
      if (silent) placeDirect(ch, room);
      else {
        enterFromDoor(ch, room, order * step, true, order);
        order++;
      }
    }
  }

  /** ผู้ช่วยที่ยังทำงานอยู่ (ไม่นับคนที่กำลังส่งงาน/เดินออก) */
  function activeHelperCount(room) {
    let n = 0;
    for (const key of room._r.helperKeys) {
      const ch = characters.get(key);
      if (ch && !ch._s.exit) n++;
    }
    return n;
  }

  /** "scout" + "a3f9c2…" → "scout·a3f9" — ป้ายชื่อผู้ช่วยในฟีดทุกบรรทัด (ชนิดเดียวกันมีหลายสิบตัวได้) */
  function withId(type, agentId) {
    const id = str(agentId).replace(/[^0-9a-z]/gi, "").slice(0, 4);
    return id ? `${type}·${id}` : type;
  }

  /** ชื่อผู้จ้างสำหรับฟีด: หัวหน้า = ชื่อห้อง · ผู้ช่วย = ชนิดของมัน (ตัวละครยังอยู่ หรืออ่านจาก snapshot) */
  function hirerInfo(room, sid, parentKey) {
    if (parentKey === sid) return { name: room.title, agentId: null };
    const pid = parentKey.slice(sid.length + 1);
    const h = characters.get(parentKey);
    if (h) return { name: h.name, agentId: pid };
    const psub = Array.isArray(room.node && room.node.subagents)
      ? room.node.subagents.find((x) => isObj(x) && x.agentId === pid)
      : null;
    return { name: (psub && oneLine(psub.type)) || "ผู้ช่วย", agentId: pid };
  }

  function flushBatch(batch) {
    for (const [hirerKey, g] of batch.hires) {
      const hirer = characters.get(hirerKey);
      /* ผู้จ้างเป็นผู้ช่วย → "ห้อง: ชนิด·รหัส รับผู้ช่วย …" (ชนิดเดียวกันหลายตัวในหลายห้อง ต้องบอกให้ได้ว่าตัวไหน) */
      let text = `${g.room.title}: รับผู้ช่วย ${g.n} คน (${listTypes(g.types)})`;
      if (hirerKey !== g.sid) {
        const pid = hirerKey.slice(g.sid.length + 1);
        const psub = g.byId.get(pid);
        const name = (psub && oneLine(psub.type)) || (hirer && hirer.name) || "ผู้ช่วย";
        text = `${g.room.title}: ${withId(name, pid)} รับผู้ช่วย ${g.n} คน (${listTypes(g.types)})`;
      }
      narrate("🤝", text, "spawn", hirer ? hirerKey : g.sid, g.sid);
      if (hirer && !hirer._s.exit && hirer.alpha > 0.2) enqueueBeat(hirer, waveBeat());
    }
    /*
     * บรรทัด "ส่งงานแล้ว": รอบแรกของห้องเล่าทันที แล้วเปิดหน้าต่าง ~2 วิ — ที่จบตามมาในหน้าต่างนั้นถูกรวม
     * เป็นบรรทัดเดียวตอนหน้าต่างปิด (พายุงานจบ 40 คนใน 2 วิ ต้องไม่กลายเป็น 10 บรรทัดที่ดันฟีดทิ้งหมด)
     * ชื่อผู้จ้างถูกคิดตอนนี้เลย (ตัวละครผู้จ้างอาจเดินออกไปแล้วตอนหน้าต่างปิด)
     */
    const bySid = new Map();
    for (const dl of batch.delivers) {
      const hi = hirerInfo(dl.room, dl.sid, dl.parentKey);
      const item = {
        cls: outcomeClass(dl.sub.outcome),
        outcome: str(dl.sub.outcome),
        type: oneLine(dl.sub.type) || "agent",
        agentId: str(dl.sub.agentId),
        key: dl.key,
        parentKey: dl.parentKey,
        hirer: hi.name,
        hirerId: hi.agentId,
      };
      let list = bySid.get(dl.sid);
      if (!list) bySid.set(dl.sid, (list = []));
      list.push(item);
    }
    for (const [sid, items] of bySid) {
      const w = deliverWin.get(sid);
      if (w && clock < w.until) {
        for (const it of items) w.items.push(it);
        continue;
      }
      narrateDelivers(sid, items);
      deliverWin.set(sid, { until: clock + DELIVER_NARRATE_WINDOW_S, items: [] });
    }
  }

  /** ปล่อยบรรทัดส่งงานที่รวมไว้เมื่อหน้าต่างปิด (เรียกจาก update) — หน้าต่างว่างแล้วก็ลบทิ้ง */
  function flushDeliverWindows() {
    for (const [sid, w] of Array.from(deliverWin)) {
      if (clock < w.until) continue;
      if (!w.items.length || !rooms.has(sid)) {
        deliverWin.delete(sid);
        continue;
      }
      const items = w.items;
      w.items = [];
      w.until = clock + DELIVER_NARRATE_WINDOW_S;
      narrateDelivers(sid, items);
    }
  }

  function narrateDelivers(sid, items) {
    const room = rooms.get(sid);
    if (!room || !items.length) return;
    const byCls = new Map();
    for (const it of items) {
      let g = byCls.get(it.cls);
      if (!g) byCls.set(it.cls, (g = []));
      g.push(it);
    }
    /*
     * ทุกบรรทัดขึ้นต้นด้วยชื่อห้อง และผู้ช่วยทุกตัวมีรหัสสั้นติดชื่อเสมอ — ฟีดของออฟฟิศหลายห้องที่มี scout
     * หลายสิบตัว "doc-writer ส่งงานให้ scout แล้ว" ไม่บอกเลยว่าตัวไหนในห้องไหน (คลิกแถวยังเลือกตัวละครได้ตาม key)
     * ผู้จ้างเป็นหัวหน้า = "หัวหน้า" (ชื่อห้องอยู่หน้าบรรทัดแล้ว ไม่ต้องซ้ำ)
     */
    const title = room.title;
    for (const [cls, g] of byCls) {
      const types = g.map((x) => x.type);
      const hirers = new Set(g.map((x) => x.parentKey));
      const one = g.length === 1;
      const sameHirer = hirers.size === 1;
      const key = one ? g[0].key : sameHirer ? g[0].parentKey : sid;
      const who = one ? withId(g[0].type, g[0].agentId) : `ผู้ช่วย ${g.length} คน (${listTypes(types)})`;
      const to = g[0].hirerId ? ` ${withId(g[0].hirer, g[0].hirerId)} ` : "หัวหน้า";
      if (cls === "ok") {
        const text = sameHirer ? `${title}: ${who} ส่งงานให้${to}แล้ว` : `${title}: ${who} ส่งงานแล้ว`;
        narrate("✅", text, "good", key, sid);
      } else if (cls === "failed") {
        const outs = Array.from(new Set(g.map((x) => x.outcome || "failed"))).join(", ");
        narrate("❌", `${title}: ${who} ทำงานไม่สำเร็จ (${outs})`, "bad", key, sid);
      } else if (cls === "killed") {
        narrate("⏹", `${title}: ${who} ถูกหยุดกลางคัน`, "warn", key, sid);
      } else {
        narrate("❔", `${title}: ${who} จบงาน (ไม่ทราบผล)`, "info", key, sid);
      }
    }
  }

  function sync(snapshot, opts) {
    if (disposed || !isObj(snapshot)) return;
    const o = isObj(opts) ? opts : {};
    const silent = o.first === true || !synced;
    quiet = silent;
    try {
      const n = typeof snapshot.nowMs === "number" && Number.isFinite(snapshot.nowMs) && snapshot.nowMs > 0 ? snapshot.nowMs : parseTs(snapshot.nowIso);
      if (n) {
        serverNowMs = n;
        serverNowAt = clock;
      }
      /* เฟรมที่ไม่มีรายการ agents เลย = เฟรมพัง ไม่ใช่ "ทุก session ปิดหมด" — เก็บภาพเดิมไว้ */
      if (!Array.isArray(snapshot.agents)) return;
      const seen = new Set();
      const sessions = [];
      for (const s of snapshot.agents) {
        if (!isObj(s) || typeof s.sessionId !== "string" || !s.sessionId || seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        sessions.push(s);
      }
      for (const sid of Array.from(rooms.keys())) if (!seen.has(sid)) removeRoom(sid);
      const batch = { hires: new Map(), delivers: [] };
      for (const s of sessions) {
        try {
          syncSession(s, silent, batch);
        } catch (err) {
          report(`sync session ${s.sessionId}`, err);
        }
      }
      try {
        flushBatch(batch);
      } catch (err) {
        report("sync narration", err);
      }
      if (needRepack) repack();
      for (const ch of characters.values()) refreshCaption(ch);
      synced = true;
    } catch (err) {
      report("sync", err);
    } finally {
      quiet = false;
    }
  }

  function update(dt) {
    if (disposed) return;
    const step = Math.max(0, Math.min(0.25, num(dt, 0)));
    clock += step;
    try {
      tweenRooms(step);
      for (const room of rooms.values()) {
        for (const name in room.stations) room.stations[name].busy = 0;
        room._r.phoneRinging = false;
      }
      const removals = [];
      for (const ch of characters.values()) {
        try {
          tickCharacter(ch, step);
        } catch (err) {
          report(`character ${ch.key}`, err);
        }
        if (ch._s.remove) removals.push(ch);
      }
      for (const ch of removals) removeCharacter(ch);
      for (const room of rooms.values()) {
        try {
          refreshProps(room);
          shrinkCheck(room);
        } catch (err) {
          report(`room ${room.sessionId}`, err);
        }
      }
      tickEffects(step);
      flushPendingNarration();
      flushDeliverWindows();
      captionTimer += step;
      if (captionTimer >= CAPTION_EVERY_S) {
        captionTimer = 0;
        for (const ch of characters.values()) refreshCaption(ch);
      }
      pruneTimer += step;
      if (pruneTimer >= 10) {
        pruneTimer = 0;
        for (const [k, at] of Array.from(narrLast)) if (clock - at > 10) narrLast.delete(k);
      }
      if (needRepack) repack();
    } catch (err) {
      report("update", err);
    }
  }

  /** เฟรมภาพจากระบบเสียง: ตัวละครที่ "พูด" อ้าปากตาม (ไม่มีตัว → ให้หัวหน้าห้องพูดแทน) */
  function voice(frame) {
    if (disposed || !isObj(frame)) return;
    const sid = str(frame.sessionId);
    if (!sid) return;
    const aid = str(frame.agentId);
    let ch = aid ? characters.get(`${sid}:${aid}`) : null;
    if (!ch) ch = characters.get(sid);
    if (!ch) return;
    if (frame.phase === "end") {
      ch.talking = false;
      ch._s.talkUntil = 0;
      return;
    }
    ch.talking = true;
    ch._s.talkUntil = clock + (frame.phase === "cue" ? 0.5 : 0.7);
  }

  function bounds() {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const room of rooms.values()) {
      const wpx = room.w * TILE;
      const hpx = room.h * TILE;
      x0 = Math.min(x0, room.x, room.tx);
      y0 = Math.min(y0, room.y, room.ty);
      x1 = Math.max(x1, room.x + wpx, room.tx + wpx);
      y1 = Math.max(y1, room.y + hpx, room.ty + hpx);
    }
    if (!Number.isFinite(x0)) {
      return { x: -BOUNDS_MARGIN, y: -BOUNDS_MARGIN, w: ROOM_W * TILE + BOUNDS_MARGIN * 2, h: (7 + 3 * MIN_DESK_ROWS) * TILE + BOUNDS_MARGIN * 2 };
    }
    return { x: x0 - BOUNDS_MARGIN, y: y0 - BOUNDS_MARGIN, w: x1 - x0 + BOUNDS_MARGIN * 2, h: y1 - y0 + BOUNDS_MARGIN * 2 };
  }

  function pick(wx, wy) {
    const x = num(wx, NaN);
    const y = num(wy, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let best = null;
    for (const ch of characters.values()) {
      if (ch.alpha < 0.3) continue;
      const room = rooms.get(ch.sessionId);
      if (!room) continue;
      const ax = room.x + ch.x;
      const ay = room.y + ch.y;
      if (x < ax - 6 || x > ax + 6 || y < ay - 20 || y > ay + 1) continue;
      if (!best || ch.sortY >= best.sortY) best = ch;
    }
    return best ? best.key : null;
  }

  function worldPos(chOrKey) {
    const ch = typeof chOrKey === "string" ? characters.get(chOrKey) : chOrKey;
    if (!isObj(ch)) return null;
    const room = rooms.get(ch.sessionId);
    return room ? { x: room.x + num(ch.x), y: room.y + num(ch.y) } : { x: num(ch.x), y: num(ch.y) };
  }

  function onNarrate(fn) {
    if (typeof fn !== "function") return () => {};
    narrators.add(fn);
    return () => narrators.delete(fn);
  }

  /** ขนาดของ Map/คิวภายในทั้งหมด — ให้เทสต์ (และ DevTools) ตรวจได้ว่าไม่มีอะไรโตไม่มีเพดาน */
  function stats() {
    let res = 0;
    let queues = 0;
    let helperIndex = 0;
    let subTracked = 0;
    let beats = 0;
    for (const room of rooms.values()) {
      res += room._r.res.size;
      for (const q of room._r.queues.values()) queues += q.size;
      helperIndex += room._r.helperKeys.size;
    }
    for (const m of subDiff.values()) subTracked += m.size;
    for (const ch of characters.values()) beats += ch._s.beats.length;
    return {
      rooms: rooms.size,
      characters: characters.size,
      slots: slotOf.size,
      sessionsTracked: sessDiff.size,
      subSessionsTracked: subDiff.size,
      subTracked,
      reservations: res,
      queued: queues,
      helperIndex,
      narrationKeys: narrLast.size,
      narrationPending: narrPending.size + deliverWin.size,
      effects: effects.length,
      queuedBeats: beats,
      listeners: narrators.size,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const ch of characters.values()) ch._s.removed = true;
    characters.clear();
    rooms.clear();
    effects.length = 0;
    narrators.clear();
    slotOf.clear();
    sessDiff.clear();
    subDiff.clear();
    narrLast.clear();
    narrPending.clear();
    deliverWin.clear();
  }

  return {
    sync,
    update,
    voice,
    setLayoutHint,
    rooms,
    characters,
    effects,
    bounds,
    pick,
    worldPos,
    nowMs,
    onNarrate,
    dispose,
    stats,
    reduceMotion: RM,
    maxHelpersPerRoom: MAX_HELPERS,
    get layoutVersion() {
      return layoutVersion;
    },
    /** นาฬิกาของโลก (วินาที) — หน่วยเดียวกับ speech.until / bubble ack */
    get time() {
      return clock;
    },
  };
}
