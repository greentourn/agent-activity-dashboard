// hud.js — HUD (DOM ล้วน) ของหน้า PIXEL OFFICE: ออฟฟิศพิกเซลที่ทุก session คือห้อง 1 ห้อง
//
// ES module รันตรงในเบราว์เซอร์ — ห้าม import อะไรทั้งสิ้น และไม่วาดอะไรลง canvas เลยสักบรรทัด
// (ฉาก/ตัวละครเป็นงานของ scene.js + sprites.js) ไฟล์นี้สร้าง DOM เองด้วย document.createElement
// แล้วใส่ข้อความด้วย textContent เท่านั้น — ห้ามใช้ innerHTML กับข้อมูลจาก snapshot เด็ดขาด เพราะ
// ชื่องาน/คำสั่ง/คำตอบของ agent คือข้อความที่ใครก็เขียนอะไรมาก็ได้ (รวมถึง <script>)
//
// สัญญากับ main.js (ห้ามเปลี่ยน signature — ดู pixel-spec.md หัวข้อ "hud.js contract"):
//   export function createHud(root, { fixtureMode, onCommand }) -> {
//     update(snapshot, info), setConnected(bool), pushFeed({icon,text,tone,key,ts}),
//     setSelected(key, detail|null), tick(dt, nowMs), setVoiceState(state), setVoiceVisual(frame),
//     toast(text, tone), setZoom(z), setRooms([{sessionId,title,state,alive}]), showEmpty(bool), dispose()
//     + setAttention([sessionId]) — ห้องที่รอคุณ/ติดด่านแต่อยู่นอกจอ (เพิ่มในรอบแก้ที่ 2; ไม่แตะของเดิม)
//   }
//   onCommand(name, value): "audio-mode" · "audio-reminders" · "zoom-in" · "zoom-out" · "fit" ·
//     "focus-room" · "select" · "close-panel" · "scenario" · "captions"
//
// หลักความซื่อตรงของ repo ("อย่ามั่นใจเกินหลักฐาน") ใช้กับแผงรายละเอียดตรง ๆ: ทุกบรรทัดในแผงมาจาก
// field ดิบของ snapshot ล่าสุด ไม่ได้มาจากท่าทางที่ตัวละครกำลังเล่นอยู่บนจอ — ท่าทางอาจเป็น "ภาพย้อน"
// ของ tool ที่จบไปแล้ว (world.js ติดธง replay ไว้) แผงจึงแยกบรรทัด "บนจอตอนนี้" ออกมาต่างหากพร้อมป้าย
// "ภาพย้อนหลัง" ให้เห็นชัดว่าอันไหนคือของจริงที่กำลังเกิด อันไหนคือการเล่าย้อน

"use strict";

// =====================================================================
// ค่าคงที่ — ข้อความ/ตาราง ที่ไม่เปลี่ยนตามข้อมูล
// =====================================================================

const FEED_MAX_ROWS = 60;
const TOAST_LIFETIME_MS = 3000;
const TOAST_FADE_MS = 240;
/* toast ซ้อนกันเกิน 4 อันแล้วอ่านไม่ทันอยู่ดี — ตัดอันเก่าสุดทิ้งแทนการดันจอลงไปเรื่อย ๆ */
const TOAST_MAX = 4;
/* นาฬิกาในแผงแสดงผลเป็นวินาที อัปเดต 4 ครั้ง/วิ ก็เกินพอ ไม่ต้องแตะ DOM ทุกเฟรม */
const TIMER_REFRESH_S = 0.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
/* ต้องตรงกับ breakpoint ใน pixel.css — จอแคบกว่านี้ฟีด/รายชื่อห้องเริ่มแบบพับไว้ */
const NARROW_QUERY = "(max-width: 760px)";
const TASK_MAX = 200;
const SAID_MAX = 200;
const ANSWER_MAX = 320;
const MAX_NOW_ROWS = 6;
const TONES = new Set(["info", "good", "bad", "warn", "spawn"]);

/* ชุดเดียวกับ brain/hud.js SCENARIO_LABELS ทุกตัวอักษร — สองหน้าต้องเรียกฉากทดสอบด้วยชื่อเดียวกัน */
const SCENARIO_LABELS = [
  ["auto", "อัตโนมัติ"],
  ["idle", "ว่าง"],
  ["thinking", "กำลังคิด"],
  ["storm", "พายุงาน (storm)"],
  ["cascade", "แตกเป็นทอด (cascade)"],
  ["errors", "จำลอง error"],
];

/* ค่าและป้ายเดียวกับ <select id="ai-voice-mode"> ของหน้าคลาสสิก — คนสลับหน้าไปมาต้องเห็นตัวเลือกเดิม */
const AUDIO_MODES = [
  ["off", "ปิด"],
  ["effects", "เอฟเฟกต์"],
  ["voice", "พูด+เอฟเฟกต์"],
];
const AUDIO_MODE_VALUES = AUDIO_MODES.map(([v]) => v);
/* รูปทรงมิเตอร์ 4 แท่งแบบเดียวกับหน้าคลาสสิก (index.html setVoiceMeterLevel) */
const METER_SHAPE = [0.52, 1, 0.7, 0.88];

const CAPTION_MODES = [
  ["auto", "อัตโนมัติ", "ป้ายงานของหัวหน้าขึ้นเมื่อซูม ≥2 · ของผู้ช่วยขึ้นเมื่อเลือก/ชี้ หรือซูม ≥4"],
  ["all", "ทั้งหมด", "แสดงป้ายงานเหนือตัวละครทุกตัว"],
  ["none", "ปิด", "ซ่อนป้ายงานทั้งหมด (ยังคลิกตัวละครดูรายละเอียดได้)"],
];

/**
 * สถานะของ session (status.state) → ไอคอน + ข้อความไทย
 * "short" ใช้ในรายชื่อห้องที่ที่แคบ ส่วน "text" ใช้ในแผงรายละเอียด
 */
const STATE_INFO = {
  tool: { icon: "🛠", text: "กำลังใช้เครื่องมือ", short: "ทำงาน" },
  delegating: { icon: "🤖", text: "คุมงานผู้ช่วย (รอ sub-agent)", short: "คุมงาน" },
  waiting: { icon: "🙋", text: "รอคุณ", short: "รอคุณ" },
  thinking: { icon: "💭", text: "กำลังคิด", short: "คิด" },
  blocked: { icon: "⛔", text: "ติดด่าน — เทิร์นจบด้วย error/ถูกปฏิเสธ", short: "ติดด่าน" },
  idle: { icon: "☕", text: "ว่าง รอคำสั่ง", short: "ว่าง" },
  unknown: { icon: "❔", text: "ไม่ทราบสถานะ (ไม่มี transcript)", short: "ไม่ทราบ" },
};

/** tag 2 ตัว → ชื่อรุ่น + คลาสสีเสื้อ (สีจริงอยู่ใน pixel.css ให้ตรงกับเสื้อใน sprites.js) */
const MODEL_INFO = {
  HA: { name: "Haiku", cls: "ha" },
  SO: { name: "Sonnet", cls: "so" },
  OP: { name: "Opus", cls: "op" },
  FA: { name: "Fable", cls: "fa" },
};

/**
 * ชื่อไอคอนของ sprites.js (9×9) → emoji สำหรับ DOM
 * world.js อาจส่ง icon มาเป็นชื่อสไปรต์ (สำหรับวาดบน canvas) — HUD จึงแปลงเป็น emoji เอง
 * ไม่ใช่พิมพ์คำว่า "magnifier" ออกไปดิบ ๆ
 */
const ICON_EMOJI = {
  book: "📖",
  magnifier: "🔍",
  terminal: "💻",
  pencil: "✏️",
  globe: "🌐",
  checklist: "📋",
  graph: "🗺️",
  robot: "🤖",
  question: "❓",
  exclaim: "❗",
  plug: "🔌",
  wrench: "🔧",
  eye: "👁️",
  chart: "📊",
  bulb: "💡",
  dots: "💭",
  check: "✅",
  cross: "❌",
  envelope: "📬",
  coffee: "☕",
  warning: "⚠️",
  zzz: "💤",
  star: "⭐",
  heart: "❤️",
};

/**
 * ตาราง tool → คำกริยาไทย + emoji สำรอง — สำเนาของตาราง activityForTool ใน pixel-spec.md
 * (ไฟล์นี้ import world.js ไม่ได้ตามสัญญา "ไม่มี import" จึงถือสำเนาเฉพาะส่วนที่เป็นป้ายข้อความ)
 * ใช้เมื่อ snapshot ไม่ได้ส่ง icon มา หรือเพื่อเติมคำไทยหน้าชื่อ tool ให้คนไม่ใช่โปรแกรมเมอร์อ่านออก
 */
const TOOL_TABLE = [
  [(t) => t === "Read", "อ่าน", "📖"],
  [(t) => t === "Grep" || t === "Glob", "ค้นหา", "🔍"],
  [(t) => t === "Bash" || t === "PowerShell", "รันคำสั่ง", "💻"],
  [(t) => t === "Write", "เขียนไฟล์", "✏️"],
  [(t) => t === "Edit" || t === "MultiEdit" || t === "NotebookEdit", "แก้ไฟล์", "✏️"],
  [(t) => t === "WebFetch" || t === "WebSearch", "ค้นเว็บ", "🌐"],
  [(t) => t === "TodoWrite", "จดงาน", "📋"],
  [(t) => t === "Workflow", "วางแผนงาน", "🗺️"],
  [(t) => t === "Agent" || t === "Task", "สั่งงานผู้ช่วย", "🤖"],
  [(t) => t === "AskUserQuestion", "ถามคุณ", "❓"],
  [(t) => t === "Skill" || t === "ToolSearch", "หยิบเครื่องมือ", "🔧"],
  [(t) => t.startsWith("mcp__"), "ใช้ปลั๊กอิน", "🔌"],
  [(t) => t === "Monitor", "เฝ้าดู", "👁️"],
  [(t) => t === "Artifact", "ทำรายงาน", "📊"],
];

const ENTRYPOINT_TH = {
  "claude-cli": "CLI",
  "claude-vscode": "VS Code",
  "claude-desktop": "แอปเดสก์ท็อป",
  "background-task": "งานเบื้องหลัง",
};

const OUTCOME_TH = {
  ok: "สำเร็จ",
  failed: "ล้มเหลว",
  error: "error",
  killed: "ถูกหยุดกลางทาง",
  unknown: "ไม่ทราบผล (เงียบไปเฉย ๆ)",
};

/*
 * runningSource = "ตัดสินว่ายังทำงาน/จบแล้ว จากหลักฐานอะไร" (server.mjs เขียนไว้ให้ตรวจย้อนได้)
 * แปลเป็นไทยเพื่อให้คนดูรู้ว่าสถานะของผู้ช่วยตัวนี้ "พิสูจน์แล้ว" หรือ "อนุมานเอา" — ต่างกันมาก
 * โดยเฉพาะ assumed-running ที่แปลว่า "ไม่มีสัญญาณชัด แต่เอนไปทางยังทำงานอยู่"
 */
const RUNNING_SOURCE_TH = {
  "task-notification": "หัวหน้าได้รับแจ้งว่างานเสร็จแล้ว",
  "parent-pending": "หัวหน้ายังรอผลจากผู้ช่วยตัวนี้อยู่",
  "parent-pending-stale": "หัวหน้ายังรออยู่ แต่ไม่มีความเคลื่อนไหวมานานแล้ว",
  "journal-started": "บันทึก workflow บอกว่าเริ่มแล้วและยังไม่จบ",
  "journal-started-stale": "บันทึก workflow บอกว่าเริ่มแล้ว แต่เงียบมานาน",
  "own-tool-in-flight": "มีเครื่องมือค้างอยู่ใน transcript ของมันเอง",
  "own-tool-in-flight-stale": "มีเครื่องมือค้าง แต่เงียบมานาน",
  "assumed-running": "ไม่มีสัญญาณชัด — อนุมานว่ายังทำงาน (ไฟล์เพิ่งขยับไม่นาน)",
  "idle-timeout": "เงียบนานเกินเกณฑ์ — ถือว่าจบแล้ว",
  fixture: "ข้อมูลจำลอง",
};

/* ตัวอธิบายฉาก (ปุ่ม ?) — ต้องตรงกับตาราง "Tool → activity" + "Story director" ใน pixel-spec.md */
const LEGEND_STATIONS = [
  ["📬", "ตู้จดหมาย", "คำสั่งใหม่จากคุณ — หัวหน้าเดินมาเปิดอ่าน"],
  ["📚", "ชั้นหนังสือ", "Read · อ่านไฟล์"],
  ["🗄️", "ตู้เอกสาร", "Grep · Glob · ค้นหาในโค้ด"],
  ["🖥️", "เทอร์มินัล", "Bash · PowerShell · รันคำสั่ง"],
  ["✏️", "โต๊ะของตัวเอง", "Edit · Write · NotebookEdit · แก้/เขียนไฟล์ (และเครื่องมืออื่น ๆ)"],
  ["🌐", "ตู้เว็บ", "WebFetch · WebSearch · ค้นเว็บ"],
  ["📋", "ไวต์บอร์ด", "TodoWrite · Workflow · จด/วางแผนงาน — และยืนคิด"],
  ["🧰", "แผงเครื่องมือ", "Skill · ToolSearch · mcp__* · หยิบเครื่องมือ/ใช้ปลั๊กอิน"],
  ["📹", "กล้องวงจรปิด", "Monitor · เฝ้าดู"],
  ["🖨️", "เครื่องพิมพ์", "Artifact · ทำรายงาน"],
  ["☎️", "ตู้โทรศัพท์", "AskUserQuestion · ถามคุณ — ยกมือ = รออนุญาต"],
  ["🤖", "เดินคุมงาน", "Agent · Task · สั่งงานผู้ช่วยแล้วเดินตรวจ"],
  ["☕", "มุมกาแฟ/โซฟา", "ว่าง — จิบกาแฟ แล้วงีบบนโซฟาถ้าว่างนาน"],
  ["🚪", "ประตู", "ผู้ช่วยเดินเข้ามารับงาน · ส่งรายงานแล้วเดินออก"],
];

const LEGEND_SIGNS = [
  ["🌧️", "เมฆฝนเหนือโต๊ะ", "ติดด่าน — เทิร์นจบด้วย error/ถูกปฏิเสธ รอคุณช่วย"],
  ["❗", "ป้ายกระพริบ", "รอคุณตอบ หรือรออนุญาต"],
  ["💭", "ลูกโป่งความคิด", "กำลังคิด ไม่มีเครื่องมือค้าง"],
  ["⌨️", "นั่งพิมพ์ + ไอคอนสถานี", "ผู้ช่วยทำงานของสถานีนั้นที่โต๊ะตัวเอง (tool เพิ่งเริ่ม สถานีไกล หรือคิวเต็ม) — tool จริงดูที่ป้าย"],
  ["💨", "ปุ๊ฟหาย", "ผู้ช่วยจบงานไกลผู้จ้าง/ห้องเต็ม: ยื่นรายงานจากที่ยืนแล้วออกไป (ฟีดบอกผลงาน)"],
  ["✓", "“✓ เมื่อกี้”", "ภาพย้อน tool ที่จบไปแล้วระหว่างรอบอัปเดต — ไม่ใช่สิ่งที่กำลังทำอยู่"],
  ["🌙", "ไฟห้องดับ", "session ปิดแล้ว (ค้างบนจอได้ถึง 30 นาที)"],
];

const LEGEND_MODELS = [
  ["HA", "Haiku"],
  ["SO", "Sonnet"],
  ["OP", "Opus"],
  ["FA", "Fable"],
  ["", "ไม่ทราบรุ่น"],
];

/* ชิปสรุปบนแถบบน — ตามลำดับใน pixel-spec.md (ห้องเปิด · ทำงาน · รอคุณ · ผู้ช่วยทำงาน · tool ค้าง · โทเค็น) */
const STAT_DEFS = [
  ["rooms", "ห้องเปิด", "session ที่ยังเปิดอยู่ (ห้องที่ไฟติด)"],
  ["busy", "ทำงาน", "session ที่กำลังคิด / ใช้เครื่องมือ / คุมผู้ช่วย"],
  ["waiting", "รอคุณ", "session ที่รอคุณตอบคำถามหรือรออนุญาต"],
  ["subs", "ผู้ช่วยทำงาน", "sub-agent ที่กำลังทำงานอยู่ตอนนี้"],
  ["tools", "tool ค้าง", "เครื่องมือที่กำลังรันอยู่ตอนนี้ (ของหัวหน้า + ผู้ช่วย)"],
  ["tokens", "โทเค็น", "โทเค็นสะสม input + cache + output ของทุก session บนจอ"],
];

/*
 * emoji นำหน้าข้อความ — world.js เขียนข้อความเล่าเรื่องแบบ "📬 ห้อง: …" มาแล้ว แยก emoji ออกมาไว้
 * คอลัมน์ไอคอนของฟีด ข้อความจะได้เรียงตรงกันทุกแถว (รองรับ ZWJ/variation selector/สีผิว)
 */
const LEADING_EMOJI_RE =
  /^\s*(\p{Extended_Pictographic}️?[\u{1F3FB}-\u{1F3FF}]?(?:‍\p{Extended_Pictographic}️?[\u{1F3FB}-\u{1F3FF}]?)*)\s*/u;

// =====================================================================
// ฟังก์ชันช่วยจัดรูปแบบ — ทุกตัวกัน null/undefined/NaN เอง (field ใน snapshot หายได้เสมอ)
// =====================================================================

/** ค่าที่เป็นตัวเลขจริงเท่านั้น — null/""/boolean ไม่นับเป็น 0 (ต่างจาก Number(null) === 0) */
function num(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** ISO string หรือ epoch ms → epoch ms (NaN ถ้า parse ไม่ได้) */
function toMs(t) {
  if (t === null || t === undefined || t === "") return NaN;
  if (typeof t === "number") return Number.isFinite(t) ? t : NaN;
  const p = Date.parse(String(t));
  return Number.isFinite(p) ? p : NaN;
}

/** จำนวนนับ — ไม่มีข้อมูล = "—" (แยกจาก "มีค่าเป็น 0") */
function fmtCount(v) {
  const n = num(v);
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** ตัดทศนิยม 1 ตำแหน่ง แต่ไม่โชว์ ".0" และตัดทศนิยมทิ้งเมื่อหลักร้อยขึ้นไป (123k ไม่ใช่ 123.4k) */
function trimUnit(x) {
  const s = x.toFixed(Math.abs(x) >= 100 ? 0 : 1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** โทเค็นแบบย่อ 12.3k / 1.2M / 3.4B — เกณฑ์ปัดขึ้นหน่วยถัดไปก่อนถึง 1000 เต็ม กัน "1000k" */
function fmtTok(v) {
  const n = num(v);
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 999500) return trimUnit(n / 1e3) + "k";
  if (a < 999500000) return trimUnit(n / 1e6) + "M";
  return trimUnit(n / 1e9) + "B";
}

/**
 * รวมโทเค็นแบบเดียวกับหน้าคลาสสิก/store.js: input + cacheCreate + cacheRead + output
 * (ไม่รวม thinking — มันถูกนับอยู่ใน output แล้ว) รับได้ทั้ง object และตัวเลขตรง ๆ
 * คืน NaN เมื่อไม่มีข้อมูลเลย เพื่อให้แสดง "—" แทน "0" ที่จะโกหกว่าไม่ได้ใช้เลย
 */
function tokTotal(t) {
  if (t === null || t === undefined) return NaN;
  if (typeof t === "number") return Number.isFinite(t) ? t : NaN;
  if (typeof t !== "object") return NaN;
  let sum = 0;
  let any = false;
  for (const k of ["input", "cacheCreate", "cacheRead", "output"]) {
    const v = num(t[k]);
    if (Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : NaN;
}

/** tooltip แจกแจงโทเค็นทีละชั้น — cache read มักเป็นก้อนใหญ่สุด คนควรเห็นว่ามาจากไหน */
function tokTitle(t) {
  if (!t || typeof t !== "object") return "";
  const parts = [
    ["input", t.input],
    ["output", t.output],
    ["cache write", t.cacheCreate],
    ["cache read", t.cacheRead],
    ["thinking", t.thinking],
  ]
    .filter(([, v]) => Number.isFinite(num(v)))
    .map(([k, v]) => k + " " + fmtTok(v));
  return parts.join(" · ");
}

/** ระยะเวลาที่จบแล้ว — "480ms" / "2.4s" / "1m 12s" / "1h 03m" */
function fmtDur(ms) {
  const v = num(ms);
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v < 1000) return Math.round(v) + "ms";
  if (v < 60000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + "s";
  const m = Math.floor(v / 60000);
  const s = Math.floor((v % 60000) / 1000);
  if (m < 60) return m + "m " + String(s).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}

/**
 * นาฬิกาเดินสด — ละเอียดระดับวินาทีเต็มเท่านั้น (ไม่มีทศนิยม) ตัวเลขจะได้ไม่สั่นทุก 250ms
 * ค่าติดลบ (นาฬิกาเครื่องกับ server เหลื่อมกันนิดหน่อย) ถือเป็น 0s ไม่ใช่ "—"
 */
function fmtElapsed(ms) {
  const v = num(ms);
  if (!Number.isFinite(v)) return "—";
  const total = Math.max(0, Math.floor(v / 1000));
  if (total < 60) return total + "s";
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return m + "m " + String(s).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}

/**
 * รูปแบบกระชับสำหรับช่องสถิติ 4 ช่องในแผง (กว้าง ~55 px): "11m 41s" → "11m41s" · "1h 03m" → "1h03m"
 * เดิมช่อง "เวลา" ถูกตัดเหลือ "11m 4…" — ตัวเลขที่ถูกตัดคือตัวเลขที่อ่านผิดได้
 */
function compactDur(text) {
  return String(text).replace(/(\d[a-z]+) (\d)/g, "$1$2");
}

/**
 * ข้อความที่มี id ยาวไม่มีช่องว่าง (เช่น "mcp:playwright/browser_run_code_unsafe") → fragment ที่แทรก <wbr>
 * หลัง / : . และหลังกลุ่ม _ — ให้ตัดบรรทัดตรงรอยต่อของชื่อ ไม่ใช่ผ่ากลางคำ ("…_u" + "nsafe")
 */
function breakable(text) {
  const t = text === undefined || text === null ? "" : String(text);
  const frag = document.createDocumentFragment();
  const parts = t.split(/(?<=[/:.]|_+(?!_))/);
  parts.forEach((part, i) => {
    if (i > 0) frag.append(document.createElement("wbr"));
    if (part) frag.append(document.createTextNode(part));
  });
  return frag;
}

/** "เมื่อกี้" / "2m 10s ที่แล้ว" */
function fmtAgo(t, nowMs) {
  const ms = toMs(t);
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return "";
  const diff = nowMs - ms;
  if (diff < 5000) return "เมื่อกี้";
  return fmtElapsed(diff) + " ที่แล้ว";
}

/** endedAgo (ms) → "เพิ่งปิด" / "5 นาทีก่อน" — ใช้คำเดียวกับป้ายปิดห้องที่ scene.js วาด */
function fmtEndedAgo(ms) {
  const v = num(ms);
  /* เกิน 30 วัน = ค่าเพี้ยน (fixture ส่ง epoch ปนมา) — ไม่บอกเวลาดีกว่าบอก "497,000 ชม. ก่อน" */
  if (!Number.isFinite(v) || v < 0 || v > 30 * 24 * 3600 * 1000) return "";
  const min = Math.floor(v / 60000);
  if (min < 1) return "เพิ่งปิด";
  if (min < 60) return min + " นาทีก่อน";
  return Math.floor(min / 60) + " ชม. " + (min % 60) + " นาทีก่อน";
}

/** นาฬิกา HH:MM:SS ของฟีด — ts ไม่มี/พัง ใช้เวลาปัจจุบันของเครื่องแทน */
function fmtClock(ts) {
  const ms = toMs(ts);
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/** ยุบช่องว่างทั้งหมดให้เหลือช่องเดียว — คืน "" ถ้าไม่มีเนื้อหา */
function cleanText(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

/** ตัดข้อความให้เหลือ n ตัว (นับเป็น code point ไม่ผ่าครึ่ง emoji) แล้วปิดท้ายด้วย "…" */
function truncate(s, n) {
  const t = cleanText(s);
  if (t.length <= n) return t;
  const chars = Array.from(t);
  return chars.length > n ? chars.slice(0, Math.max(1, n - 1)).join("") + "…" : t;
}

function basename(p) {
  const parts = String(p || "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/** ต่อท่อนข้อความด้วย " · " ข้ามท่อนที่ว่าง */
function joinDot(parts) {
  return parts.map(cleanText).filter(Boolean).join(" · ");
}

/** ชื่อห้อง: title || name || basename(cwd) || sessionId 8 ตัวแรก (กติกาเดียวกับ world.sessionDisplayName) */
function sessionDisplayName(s, max = 28) {
  if (!s || typeof s !== "object") return "session";
  const raw =
    cleanText(s.title) ||
    cleanText(s.name) ||
    basename(s.cwd) ||
    (s.sessionId ? String(s.sessionId).slice(0, 8) : "") ||
    "session";
  return truncate(raw, max);
}

/** "claude-opus-5" → "OP" (ตามสเปก: หาโดย substring) */
function modelTagOf(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("haiku")) return "HA";
  if (m.includes("sonnet")) return "SO";
  if (m.includes("opus")) return "OP";
  if (m.includes("fable")) return "FA";
  return "";
}

function normTag(tag) {
  const t = String(tag || "").toUpperCase();
  return MODEL_INFO[t] ? t : "";
}

function toolInfo(tool) {
  const t = String(tool || "");
  for (const [test, verb, emoji] of TOOL_TABLE) {
    if (test(t)) return { verb, emoji };
  }
  return { verb: "ใช้เครื่องมือ", emoji: "🔧" };
}

/** ชื่อ tool ของ MCP ยาวมาก ("mcp__claude_ai_Notion__notion-search") — ย่อเหลือ "mcp:Notion/notion-search" */
function shortTool(tool) {
  const t = String(tool || "");
  if (t.startsWith("mcp__")) {
    const parts = t.slice(5).split("__").filter(Boolean);
    const server = (parts[0] || "").replace(/^claude_ai_/, "");
    const name = parts.slice(1).join("__");
    return truncate("mcp:" + server + (name ? "/" + name : ""), 40);
  }
  return truncate(t, 40);
}

function isDelegateTool(tool) {
  return tool === "Agent" || tool === "Task";
}

/**
 * icon จาก world/snapshot → emoji ที่ใส่ DOM ได้
 * ชื่อสไปรต์ที่รู้จัก → emoji ตามตาราง · ชื่อภาษาอังกฤษที่ไม่รู้จัก → "" (ไม่พิมพ์คำดิบ) · ที่เหลือถือว่าเป็น emoji อยู่แล้ว
 */
function iconEmoji(icon) {
  if (icon === null || icon === undefined) return "";
  const s = String(icon).trim();
  if (!s) return "";
  if (Object.prototype.hasOwnProperty.call(ICON_EMOJI, s)) return ICON_EMOJI[s];
  if (/^[a-z0-9_-]+$/i.test(s)) return "";
  return Array.from(s).slice(0, 4).join("");
}

function splitLeadingEmoji(text) {
  const m = LEADING_EMOJI_RE.exec(text);
  if (!m) return { emoji: "", rest: text };
  return { emoji: m[1], rest: text.slice(m[0].length) };
}

function entrypointText(ep) {
  const e = cleanText(ep);
  if (!e) return "";
  return ENTRYPOINT_TH[e] || e.replace(/^claude-/, "");
}

function kindText(kind) {
  const k = cleanText(kind);
  if (!k || k === "interactive") return "";
  if (k === "background") return "เบื้องหลัง";
  return k;
}

function outcomeTh(o) {
  const k = cleanText(o);
  if (!k) return "";
  return OUTCOME_TH[k] || k;
}

function runningSourceText(src) {
  const s = cleanText(src);
  if (!s) return "";
  let th = RUNNING_SOURCE_TH[s];
  if (!th && s.startsWith("journal-")) th = "บันทึก workflow ระบุว่าจบแล้ว (" + s.slice(8) + ")";
  if (!th && s.startsWith("own-")) th = "transcript ของมันเองจบเทิร์นแล้ว (" + s.slice(4) + ")";
  return th ? th + " · " + s : s;
}

function depthText(depth) {
  const d = num(depth);
  if (!Number.isFinite(d) || d <= 1) return "หัวหน้าจ้างตรง (ชั้น 1)";
  return "ผู้ช่วยจ้างต่อ (ชั้น " + d + ")";
}

/** key ของ store: หัวหน้า = "sessionId" · ผู้ช่วย = "sessionId:agentId" (ตัดที่ ":" ตัวแรก) */
function parseKey(key) {
  const k = String(key);
  const idx = k.indexOf(":");
  if (idx === -1) return { sessionId: k, agentId: null };
  return { sessionId: k.slice(0, idx), agentId: k.slice(idx + 1) || null };
}

function findSession(snapshot, sessionId) {
  const agents = snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : [];
  for (const a of agents) if (a && a.sessionId === sessionId) return a;
  return null;
}

function findSub(session, agentId) {
  const subs = session && Array.isArray(session.subagents) ? session.subagents : [];
  for (const s of subs) if (s && s.agentId === agentId) return s;
  return null;
}

/** event ล่าสุดที่ตรงเงื่อนไข — events[] เรียงเก่า→ใหม่ จึงไล่จากท้าย */
function lastEvent(events, pred) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e && typeof e === "object" && pred(e)) return e;
  }
  return null;
}

function troubleText(ev) {
  if (!ev) return "";
  const body = cleanText(ev.text) || cleanText(ev.denyLabel) || cleanText(ev.label) || cleanText(ev.tool);
  if (ev.kind === "denied") return "ถูกปฏิเสธ: " + (cleanText(ev.denyLabel) || body || "—");
  if (ev.kind === "blocked") return "ถูกบล็อก: " + (body || "—");
  if (ev.kind === "guard") return "guard: " + (body || "—");
  return "error: " + (body || "—");
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/** แก้ textContent เฉพาะตอนค่าเปลี่ยน — กัน layout/reflow ฟรี ๆ ทุก snapshot */
function setText(node, text) {
  const t = text === undefined || text === null ? "" : String(text);
  if (node && node.textContent !== t) node.textContent = t;
}

function setTitle(node, title) {
  const t = title ? String(title) : "";
  if (!node) return;
  if (t) {
    if (node.title !== t) node.title = t;
  } else if (node.hasAttribute("title")) {
    node.removeAttribute("title");
  }
}

function matchesNarrow() {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
  } catch (err) {
    return false;
  }
}

function perfNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

// =====================================================================
// createHud — export เดียวของไฟล์นี้
// =====================================================================

export function createHud(root, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const fixtureMode = !!opts.fixtureMode;
  const onCommand = typeof opts.onCommand === "function" ? opts.onCommand : null;
  const host = root && typeof root.appendChild === "function" ? root : document.body;

  /** เรียก onCommand แบบกันพัง — callback ของฝั่งเรียกโยน error ต้องไม่ลาก HUD ไปด้วย */
  function command(name, value) {
    if (!onCommand) return;
    try {
      onCommand(name, value);
    } catch (err) {
      console.error(`[pixel/hud] onCommand("${name}") throw`, err);
    }
  }

  // ---------------------------------------------------------------
  // สถานะภายใน — อยู่ในสโคปนี้ทั้งหมด ไม่มี module-level state (สร้าง HUD ซ้ำได้ไม่ชนกัน)
  // ---------------------------------------------------------------

  const narrowAtStart = matchesNarrow();
  let disposed = false;
  let lastSnapshot = null;
  /* นาฬิกาฝั่ง server โดยประมาณ — ใช้เมื่อ tick() ไม่ได้ส่ง nowMs มา (จับเวลา tool ต้องเทียบกับ server ไม่ใช่เครื่องเรา) */
  let clockBaseMs = NaN;
  let clockBasePerf = 0;
  let nowRef = Date.now();
  let selectedKey = null;
  /** { key, role, sessionId, agentId, session, node, character, gone } ของตัวที่เลือกอยู่ */
  let detail = null;
  let captionMode = "auto";
  let feedOpen = !narrowAtStart;
  let roomsOpen = !narrowAtStart;
  /** รายชื่อห้องถูกพับให้เองตอนแผงรายละเอียดเปิด (ดู autoCollapseRooms) */
  let roomsAutoCollapsed = false;
  let detailWasOpen = false;
  /** จอแคบ: แถวเสียง + ชิปสรุปกางอยู่ไหม (จอกว้างไม่สนค่านี้ — CSS แสดงเสมอ) */
  let moreOpen = false;
  let waitingCount = 0;
  let feedUnread = 0;
  let legendOpen = false;
  let timerAcc = 0;
  /** นาฬิกาที่เดินอยู่ในแผง: { el, since (ms), scope: "now"|"state"|"stat", prefix } */
  let panelTimers = [];
  let nowListSig = "";
  let captionSig = "";
  let voice = {
    mode: "off",
    enabled: false,
    supported: true,
    speaking: false,
    level: 0,
    remindersEnabled: true,
    unlocked: false,
  };
  let cueTimer = null;
  let meterResetTimer = null;
  let resizeObs = null;
  const toastTimers = new Set();
  /** sessionId -> { btn, dot, name, state } — แถวรายชื่อห้องที่ reuse ข้ามการเรียก setRooms */
  const roomRows = new Map();
  let roomCount = 0;
  const refs = {};

  const hudEl = el("div", "px-hud");
  if (fixtureMode) hudEl.classList.add("px-hud--fixture");
  hudEl.append(buildTopBar(), buildDock(), buildFeed(), buildEmpty(), buildToasts());
  host.appendChild(hudEl);

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onDocPointerDown, true);
  observeLayout();
  renderDetail(true);
  applyFeedOpen();
  applyRoomsOpen();
  applyMoreOpen();
  setVoiceState(voice);

  // ---------------------------------------------------------------
  // โครง DOM — สร้างครั้งเดียว จากนั้นแก้แค่ textContent/class/hidden
  // ---------------------------------------------------------------

  function button(cls, text, label, onClick) {
    const b = el("button", "px-btn" + (cls ? " " + cls : ""), text);
    b.type = "button";
    if (label) {
      b.setAttribute("aria-label", label);
      b.title = label;
    }
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  // ---- แถบบน: ตราสัญลักษณ์ · ชิปสรุป · เสียง · ลิงก์ ----
  function buildTopBar() {
    const bar = el("div", "px-topbar");
    refs.topbar = bar;

    const brand = el("div", "px-panel px-brand");
    const mark = el("span", "px-mark");
    mark.setAttribute("aria-hidden", "true");
    const word = el("h1", "px-wordmark", "PIXEL OFFICE");
    const conn = el("span", "px-conn px-conn--pending");
    conn.setAttribute("role", "status");
    const connDot = el("i", "px-conn-dot");
    connDot.setAttribute("aria-hidden", "true");
    const connText = el("span", "px-conn-text", "กำลังต่อ…");
    conn.append(connDot, connText);
    conn.title = "สถานะการเชื่อมต่อสตรีม /api/stream";
    brand.append(mark, word, conn);
    if (fixtureMode) {
      const demo = el("span", "px-demo-tag", "ข้อมูลจำลอง");
      demo.title = "หน้านี้เปิดด้วย ?fixture= — ทุกอย่างบนจอเป็นข้อมูลปลอม ไม่ใช่ session จริง";
      brand.append(demo);
    }
    refs.conn = conn;
    refs.connText = connText;

    /*
     * จอแคบ: แถวเสียง + แถวชิปสรุปกินจอเกือบหนึ่งในสาม — พับไว้หลังปุ่ม "สรุป" (ค่าเริ่มต้นพับ)
     * ปุ่มบอกจำนวน "รอคุณ" ในตัว ⇒ สิ่งเดียวที่ห้ามพลาด (มีงานรอคุณอยู่) ยังเห็นได้แม้พับอยู่
     * (จอกว้างซ่อนปุ่มนี้ด้วย CSS — ทั้งสองแถวแสดงเสมอ)
     */
    const more = button("px-more", "สรุป ▾", "แสดง/ซ่อนชิปสรุปและตัวควบคุมเสียง", () => {
      moreOpen = !moreOpen;
      applyMoreOpen();
      command("layout");
    });
    more.setAttribute("aria-expanded", "false");
    brand.append(more);
    refs.moreBtn = more;

    const stats = el("div", "px-panel px-stats");
    stats.setAttribute("role", "group");
    stats.setAttribute("aria-label", "สรุปภาพรวมออฟฟิศ");
    refs.stats = {};
    for (const [id, label, tip] of STAT_DEFS) {
      const chip = el("div", "px-stat");
      chip.dataset.stat = id;
      chip.title = tip;
      const lab = el("span", "px-stat-label", label);
      const value = el("b", "px-stat-value", "—");
      chip.append(lab, value);
      stats.append(chip);
      refs.stats[id] = { chip, value, tip };
    }
    const over = el("div", "px-stat px-stat--warn px-stat--overflow");
    over.hidden = true;
    const overLab = el("span", "px-stat-label", "ไม่ได้วาด");
    const overVal = el("b", "px-stat-value", "0");
    over.append(overLab, overVal);
    stats.append(over);
    refs.overflowChip = over;
    refs.overflowValue = overVal;

    const audio = el("div", "px-panel px-audio");
    audio.append(buildAudio());

    const links = el("nav", "px-panel px-links");
    links.setAttribute("aria-label", "สลับมุมมอง");
    const classic = el("a", "px-linkbtn", "คลาสสิก");
    classic.href = "/index.html";
    classic.title = "หน้าคลาสสิก (กราฟ 2 มิติ + แผงรายละเอียดเต็ม)";
    const neural = el("a", "px-linkbtn", "NEURAL CORE");
    neural.href = "/brain.html";
    neural.title = "มุมมองสมอง AI สามมิติ";
    links.append(classic, neural);

    bar.append(brand, stats, audio, links);
    return bar;
  }

  /*
   * ตัวควบคุมเสียง — markup/คลาสเดียวกับหน้าคลาสสิก (index.html บรรทัด ~1182-1208) เพื่อให้
   * activity-audio.css ใช้ได้ทั้งสองหน้า และคนที่สลับหน้าไปมาเห็นตัวควบคุมหน้าตา/พฤติกรรมเดียวกัน
   * (id ขึ้นต้น px- กันชนกับหน้าอื่นเผื่อวันหนึ่งถูกฝังรวมกัน)
   */
  function buildAudio() {
    const frag = document.createDocumentFragment();

    const group = el("div", "agent-voice-toggle agent-audio-mode-control");
    group.id = "px-ai-voice";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "เสียงเหตุการณ์ของ AI");
    group.title = "เลือกรูปแบบเสียงสำหรับเหตุการณ์ของ AI";
    const icon = el("span", "agent-voice-icon", "🔇");
    icon.setAttribute("aria-hidden", "true");
    const label = el("label", "agent-voice-label", "เสียง AI");
    label.htmlFor = "px-ai-voice-mode";
    const select = el("select", "agent-audio-mode-select");
    select.id = "px-ai-voice-mode";
    select.name = "px-ai-voice-mode";
    select.setAttribute("aria-label", "โหมดเสียง AI: ปิด เอฟเฟกต์ หรือพูดพร้อมเอฟเฟกต์");
    for (const [value, text] of AUDIO_MODES) {
      const o = el("option", null, text);
      o.value = value;
      select.append(o);
    }
    /* ต้องเรียก onCommand แบบ synchronous ในตัว event นี้ — engine ต้องการ user gesture เพื่อปลดล็อกเสียง */
    select.addEventListener("change", () => command("audio-mode", select.value));
    const meter = el("span", "agent-voice-meter");
    meter.setAttribute("aria-hidden", "true");
    const bars = [];
    for (let i = 0; i < 4; i += 1) {
      const bar = el("i");
      meter.append(bar);
      bars.push(bar);
    }
    group.append(icon, label, select, meter);

    const reminder = el("label", "toggle agent-wait-reminder-toggle");
    reminder.title = "เตือนเป็นระยะจนกว่างานที่รอคำตอบหรือการยืนยันจากคุณจะทำต่อได้";
    const cb = el("input");
    cb.type = "checkbox";
    cb.id = "px-beep";
    cb.name = "px-beep";
    cb.checked = true;
    cb.addEventListener("change", () => command("audio-reminders", cb.checked));
    reminder.append(cb, el("span", null, "เตือนซ้ำเมื่อรอฉัน"));

    refs.voiceGroup = group;
    refs.voiceIcon = icon;
    refs.voiceLabel = label;
    refs.voiceSelect = select;
    refs.voiceBars = bars;
    refs.reminderLabel = reminder;
    refs.reminderInput = cb;

    frag.append(group, reminder);
    return frag;
  }

  // ---- ด้านขวา: เครื่องมือมุมมอง · แผงรายละเอียด · รายชื่อห้อง ----
  function buildDock() {
    const dock = el("div", "px-dock");
    dock.append(buildTools(), buildDetail(), buildRooms());
    refs.dock = dock;
    return dock;
  }

  function buildTools() {
    const tools = el("div", "px-panel px-tools");
    const row = el("div", "px-tools-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "มุมมองกล้อง");

    const zoomOut = button("px-btn--square", "−", "ซูมออก", () => command("zoom-out"));
    const zoomVal = el("span", "px-zoom-val", "×–");
    zoomVal.title = "ระดับซูม (1–8)";
    const zoomIn = button("px-btn--square", "+", "ซูมเข้า", () => command("zoom-in"));
    const fit = button("", "จัดกรอบ", "จัดกรอบให้เห็นทุกห้อง", () => command("fit"));
    const cap = button("px-btn--caption", "", "", cycleCaptions);
    const legendBtn = button("px-btn--square px-btn--legend", "?", "คำอธิบายสัญลักษณ์ในฉาก", toggleLegend);
    legendBtn.setAttribute("aria-expanded", "false");
    legendBtn.setAttribute("aria-controls", "px-legend");
    row.append(zoomOut, zoomVal, zoomIn, fit, cap, legendBtn);
    tools.append(row);

    refs.zoomOut = zoomOut;
    refs.zoomIn = zoomIn;
    refs.zoomVal = zoomVal;
    refs.captionBtn = cap;
    refs.legendBtn = legendBtn;
    applyCaptionBtn();

    if (fixtureMode) {
      const scen = el("label", "px-scenario");
      scen.append(el("span", "px-scenario-label", "ทดสอบฉาก"));
      const select = el("select", "px-select");
      select.id = "px-scenario-select";
      select.name = "px-scenario";
      select.setAttribute("aria-label", "ทดสอบฉาก (ข้อมูลจำลอง)");
      for (const [value, label] of SCENARIO_LABELS) {
        const o = el("option", null, label);
        o.value = value;
        select.append(o);
      }
      /* ตั้งค่าเริ่มให้ตรงกับ ?fixture= ที่ main.js ใช้สร้าง fixture ไม่งั้นป้ายจะโกหกตั้งแต่เปิดหน้า */
      try {
        const fromUrl = new URLSearchParams(window.location.search).get("fixture");
        if (SCENARIO_LABELS.some(([v]) => v === fromUrl)) select.value = fromUrl;
      } catch (err) {
        /* location อ่านไม่ได้ (เช่นฝังใน sandbox) — ใช้ค่าแรก "อัตโนมัติ" ไป */
      }
      select.addEventListener("change", () => command("scenario", select.value));
      scen.append(select);
      tools.append(scen);
      refs.scenarioSelect = select;
    }

    tools.append(buildLegend());
    return tools;
  }

  function legendSection(title) {
    const sec = el("section", "px-legend-sec");
    sec.append(el("h3", "px-sec-title", title));
    return sec;
  }

  function buildLegend() {
    const pop = el("div", "px-panel px-legend");
    pop.id = "px-legend";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "คำอธิบายสัญลักษณ์ในฉากออฟฟิศ");
    pop.hidden = true;

    const head = el("div", "px-panel-head");
    head.append(el("h2", "px-panel-title", "อ่านฉากออฟฟิศ"));
    const close = button("px-btn--square px-btn--ghost", "✕", "ปิดคำอธิบาย", () => closeLegend(true));
    head.append(close);
    pop.append(head);

    const body = el("div", "px-legend-body");

    const cast = legendSection("ตัวละคร");
    cast.append(
      el(
        "p",
        "px-legend-note",
        "หัวหน้า = ตัวหลักของ session (ผูกเนคไท) · ผู้ช่วย = sub-agent ที่ถูกจ้าง (แว่น/หมวก/หูฟังตามชนิดงาน) — agent ตัวเดิมหน้าตาเดิมเสมอ",
      ),
    );
    body.append(cast);

    const st = legendSection("สถานีงาน → เครื่องมือ");
    const stList = el("ul", "px-legend-list");
    for (const [emoji, name, desc] of LEGEND_STATIONS) {
      const li = el("li", "px-legend-row");
      const ic = el("span", "px-legend-icon", emoji);
      ic.setAttribute("aria-hidden", "true");
      const txt = el("span", "px-legend-text");
      txt.append(el("b", null, name), el("span", "px-legend-desc", desc));
      li.append(ic, txt);
      stList.append(li);
    }
    st.append(stList);
    body.append(st);

    const models = legendSection("สีเสื้อ → โมเดล");
    const mList = el("ul", "px-legend-models");
    for (const [tag, name] of LEGEND_MODELS) {
      const li = el("li", "px-legend-model");
      const sw = el("span", "px-shirt px-model--" + (MODEL_INFO[tag] ? MODEL_INFO[tag].cls : "un"));
      sw.setAttribute("aria-hidden", "true");
      li.append(sw, el("span", null, (tag ? tag + " · " : "") + name));
      mList.append(li);
    }
    models.append(mList);
    body.append(models);

    const signs = legendSection("สัญญาณในฉาก");
    const sList = el("ul", "px-legend-list");
    for (const [emoji, name, desc] of LEGEND_SIGNS) {
      const li = el("li", "px-legend-row");
      const ic = el("span", "px-legend-icon", emoji);
      ic.setAttribute("aria-hidden", "true");
      const txt = el("span", "px-legend-text");
      txt.append(el("b", null, name), el("span", "px-legend-desc", desc));
      li.append(ic, txt);
      sList.append(li);
    }
    signs.append(sList);
    body.append(signs);

    const how = legendSection("การใช้งาน");
    how.append(
      el(
        "p",
        "px-legend-note",
        "ลาก = เลื่อนฉาก · ล้อเมาส์ = ซูม · คลิกตัวละคร = ดูรายละเอียด · ดับเบิลคลิก = ตามตัว · Esc = ปิดแผง",
      ),
    );
    body.append(how);

    pop.append(body);
    refs.legend = pop;
    refs.legendClose = close;
    return pop;
  }

  function buildDetail() {
    const panel = el("section", "px-panel px-detail");
    panel.setAttribute("aria-label", "รายละเอียดตัวละครที่เลือก");
    panel.hidden = true;

    const head = el("header", "px-detail-head");
    const role = el("span", "px-role px-role--lead", "หัวหน้า");
    const close = button("px-btn--square px-btn--ghost px-detail-close", "✕", "ปิดแผงรายละเอียด (Esc)", closePanel);
    const name = el("h2", "px-detail-name", "—");
    const sub = el("div", "px-detail-sub", "");
    const chips = el("div", "px-detail-chips");
    const modelChip = el("span", "px-model-chip px-model--un");
    const modelSwatch = el("span", "px-shirt");
    modelSwatch.setAttribute("aria-hidden", "true");
    const modelText = el("span", "px-model-text", "—");
    modelChip.append(modelSwatch, modelText);
    const stateChip = el("span", "px-state-chip");
    const stateIcon = el("span", "px-state-icon", "");
    stateIcon.setAttribute("aria-hidden", "true");
    const stateText = el("span", "px-state-text", "");
    const stateSince = el("span", "px-state-since", "");
    stateChip.append(stateIcon, stateText, stateSince);
    chips.append(modelChip, stateChip);
    head.append(role, close, name, sub, chips);

    const body = el("div", "px-detail-body");
    const gone = el("div", "px-note px-note--gone", "ตัวละครนี้ออกจากออฟฟิศไปแล้ว — ด้านล่างคือข้อมูลล่าสุดที่เห็น");
    gone.hidden = true;
    const missing = el("div", "px-note", "ไม่พบข้อมูลของตัวละครนี้ในสแนปช็อตล่าสุด");
    missing.hidden = true;

    const content = el("div", "px-detail-content");

    const nowSec = el("section", "px-detail-sec");
    const nowTitle = el("h3", "px-sec-title", "กำลังทำ");
    const nowList = el("div", "px-now-list");
    nowSec.append(nowTitle, nowList);

    const scene = el("div", "px-scene");
    scene.hidden = true;
    const sceneLab = el("span", "px-scene-label", "บนจอตอนนี้:");
    const sceneText = el("span", "px-scene-text", "");
    const sceneReplay = el("span", "px-replay-chip", "ภาพย้อนหลัง");
    sceneReplay.title = "ตัวละครกำลังเล่าย้อน tool ที่จบไปแล้วระหว่างรอบอัปเดต — ไม่ใช่สิ่งที่กำลังรันอยู่";
    sceneReplay.hidden = true;
    scene.append(sceneLab, sceneText, sceneReplay);
    nowSec.append(scene);

    const grid = el("dl", "px-statgrid");
    const statCells = [];
    for (let i = 0; i < 4; i += 1) {
      const wrap = el("div", "px-statcell");
      const dt = el("dt", null, "");
      const dd = el("dd", null, "—");
      wrap.append(dt, dd);
      grid.append(wrap);
      statCells.push({ wrap, dt, dd });
    }

    const fTask = buildField();
    const fSaid = buildField();
    const fTrouble = buildField("px-field--trouble");
    const fAnswer = buildField();

    const kv = el("dl", "px-kv");
    const kvRows = {
      hirer: kvRow(kv, "ผู้ว่าจ้าง"),
      depth: kvRow(kv, "ลำดับชั้น"),
      project: kvRow(kv, "โปรเจกต์"),
      entry: kvRow(kv, "เปิดผ่าน"),
      model: kvRow(kv, "โมเดล"),
      helpers: kvRow(kv, "ผู้ช่วย"),
      source: kvRow(kv, "ตัดสินสถานะจาก"),
      outcome: kvRow(kv, "ผลลัพธ์"),
      endedBy: kvRow(kv, "จบเทิร์นด้วย"),
      started: kvRow(kv, "เริ่มเมื่อ"),
      workflow: kvRow(kv, "workflow"),
    };
    /* ผู้ว่าจ้างเป็นปุ่ม: คลิกแล้วเลือกตัวที่จ้าง — ไล่สายการจ้างขึ้นไปได้ทีละขั้นจากแผงเดียว */
    const hirerBtn = el("button", "px-btn px-btn--inline px-hirer-btn", "—");
    hirerBtn.type = "button";
    hirerBtn.addEventListener("click", () => {
      const k = hirerBtn.dataset.key;
      if (k) command("select", k);
    });
    kvRows.hirer.dd.append(hirerBtn);

    const link = el("a", "px-classic-link", "ดูละเอียดในหน้าคลาสสิก →");
    link.href = "/index.html";
    link.title = "หน้าคลาสสิกมีรายการ tool ทั้งหมด หมวด error และข้อมูลดิบของทุก agent";

    content.append(nowSec, grid, fTask.wrap, fSaid.wrap, fTrouble.wrap, fAnswer.wrap, kv, link);
    body.append(gone, missing, content);
    panel.append(head, body);

    Object.assign(refs, {
      detail: panel,
      role,
      name,
      sub,
      modelChip,
      modelText,
      stateChip,
      stateIcon,
      stateText,
      stateSince,
      detailBody: body,
      gone,
      missing,
      content,
      nowTitle,
      nowList,
      scene,
      sceneText,
      sceneReplay,
      statCells,
      fTask,
      fSaid,
      fTrouble,
      fAnswer,
      kv: kvRows,
      hirerBtn,
    });
    return panel;
  }

  function buildField(extraCls) {
    const wrap = el("section", "px-field" + (extraCls ? " " + extraCls : ""));
    const head = el("h3", "px-sec-title px-field-head");
    const lab = el("span", "px-field-label", "");
    const meta = el("span", "px-field-meta", "");
    head.append(lab, meta);
    const text = el("p", "px-field-text", "");
    wrap.append(head, text);
    wrap.hidden = true;
    return { wrap, lab, meta, text };
  }

  function kvRow(dl, label) {
    const dt = el("dt", "px-kv-key", label);
    const dd = el("dd", "px-kv-val");
    dt.hidden = true;
    dd.hidden = true;
    dl.append(dt, dd);
    return { dt, dd, label };
  }

  function buildRooms() {
    const panel = el("section", "px-panel px-rooms");
    const head = el("button", "px-panel-head px-rooms-head");
    head.type = "button";
    head.setAttribute("aria-controls", "px-rooms-list");
    const title = el("span", "px-panel-title", "ห้อง");
    const count = el("span", "px-count", "0");
    const chev = el("span", "px-chev", "▾");
    chev.setAttribute("aria-hidden", "true");
    head.append(title, count, chev);
    head.addEventListener("click", () => {
      roomsOpen = !roomsOpen;
      roomsAutoCollapsed = false; // ผู้ใช้กดเอง — ไม่กางคืนให้อัตโนมัติตอนปิดแผงรายละเอียด
      applyRoomsOpen();
    });
    /* role="group" ไม่ใช่ list/listitem — ถ้าใส่ role listitem ให้ปุ่ม screen reader จะไม่รู้ว่ามันกดได้ */
    const list = el("div", "px-rooms-list");
    list.id = "px-rooms-list";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "รายชื่อห้อง — กดเพื่อพากล้องไปที่ห้อง");
    const empty = el("div", "px-rooms-empty", "ยังไม่มีห้อง");
    panel.append(head, list, empty);
    refs.rooms = panel;
    refs.roomsHead = head;
    refs.roomsCount = count;
    refs.roomsChev = chev;
    refs.roomsList = list;
    refs.roomsEmpty = empty;
    return panel;
  }

  // ---- ล่างซ้าย: บันทึกเหตุการณ์ ----
  function buildFeed() {
    const feed = el("section", "px-panel px-feed");
    feed.setAttribute("aria-label", "บันทึกเหตุการณ์");
    const head = el("button", "px-panel-head px-feed-head");
    head.type = "button";
    head.setAttribute("aria-controls", "px-feed-list");
    const title = el("span", "px-panel-title", "บันทึกเหตุการณ์");
    const badge = el("span", "px-count px-count--new", "");
    badge.hidden = true;
    const chev = el("span", "px-chev", "▾");
    chev.setAttribute("aria-hidden", "true");
    head.append(title, badge, chev);
    head.addEventListener("click", () => {
      feedOpen = !feedOpen;
      applyFeedOpen();
    });
    const list = el("div", "px-feed-list");
    list.id = "px-feed-list";
    list.setAttribute("role", "list");
    /* คลิกแถว = เลือกตัวละครของเหตุการณ์นั้น (event delegation — ไม่ผูก listener ใหม่ทุกแถว) */
    list.addEventListener("click", (e) => {
      const target = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-key]") : null;
      if (target && list.contains(target) && target.dataset.key) command("select", target.dataset.key);
    });
    const empty = el("div", "px-feed-empty", "ยังไม่มีเหตุการณ์ — ตัวละครจะเล่าเรื่องที่นี่");
    feed.append(head, list, empty);
    refs.feed = feed;
    refs.feedHead = head;
    refs.feedBadge = badge;
    refs.feedChev = chev;
    refs.feedList = list;
    refs.feedEmpty = empty;
    return feed;
  }

  function buildEmpty() {
    const box = el("div", "px-panel px-empty");
    box.hidden = true;
    const art = el("span", "px-empty-art");
    art.setAttribute("aria-hidden", "true");
    box.append(
      art,
      el("div", "px-empty-title", "ออฟฟิศยังปิดไฟอยู่"),
      el("p", "px-empty-text", "ยังไม่มี session — เปิด Claude Code แล้วไฟในออฟฟิศจะติดเอง"),
    );
    refs.empty = box;
    return box;
  }

  function buildToasts() {
    const wrap = el("div", "px-toasts");
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-live", "polite");
    refs.toasts = wrap;
    return wrap;
  }

  /*
   * ResizeObserver วัดความสูงจริงของแถบบน + ฟีด แล้วป้อนเป็นตัวแปร CSS — แถบบนห่อบรรทัดได้
   * (จอแคบ/ชิปเยอะ) ถ้าใช้เลขคงที่ แผงขวาจะทับแถบบนแบบบั๊กเดิมของ NEURAL CORE ข้อ 1
   */
  function observeLayout() {
    if (typeof ResizeObserver !== "function") return;
    resizeObs = new ResizeObserver(() => {
      try {
        const topH = refs.topbar.getBoundingClientRect().height;
        const feedH = refs.feed.getBoundingClientRect().height;
        if (topH) hudEl.style.setProperty("--px-top-h", Math.ceil(topH) + "px");
        if (feedH) hudEl.style.setProperty("--px-feed-h", Math.ceil(feedH) + "px");
      } catch (err) {
        /* วัดไม่ได้ก็ใช้ค่าเริ่มต้นใน pixel.css ไป — ไม่ใช่เหตุให้ HUD พัง */
      }
    });
    resizeObs.observe(refs.topbar);
    resizeObs.observe(refs.feed);
  }

  // ---------------------------------------------------------------
  // พับ/กาง · legend · captions · คีย์บอร์ด
  // ---------------------------------------------------------------

  function applyFeedOpen() {
    refs.feed.classList.toggle("is-collapsed", !feedOpen);
    refs.feedList.hidden = !feedOpen;
    refs.feedHead.setAttribute("aria-expanded", feedOpen ? "true" : "false");
    refs.feedHead.title = feedOpen ? "พับบันทึกเหตุการณ์" : "กางบันทึกเหตุการณ์";
    setText(refs.feedChev, feedOpen ? "▾" : "▴");
    if (feedOpen) {
      feedUnread = 0;
      refs.feedList.scrollTop = 0;
    }
    applyFeedBadge();
    applyFeedEmpty();
  }

  function applyFeedBadge() {
    const show = !feedOpen && feedUnread > 0;
    refs.feedBadge.hidden = !show;
    if (show) setText(refs.feedBadge, "+" + (feedUnread > 99 ? "99" : feedUnread));
  }

  function applyFeedEmpty() {
    refs.feedEmpty.hidden = !feedOpen || refs.feedList.childElementCount > 0;
  }

  /*
   * แผงรายละเอียดเปิด → พับรายชื่อห้องให้เองชั่วคราว (เหลือแค่หัวแผง) แล้วกางคืนตอนปิดแผง
   * เดิมรายชื่อห้องถูกดันลงไปจนแถวสุดท้ายโดนขอบจอล่างตัดครึ่ง — ถ้าผู้ใช้กดกาง/พับเองระหว่างนั้น ถือว่าเขาคุมเอง
   */
  function autoCollapseRooms(open) {
    if (open === detailWasOpen) return;
    detailWasOpen = open;
    if (open) {
      if (roomsOpen) {
        roomsOpen = false;
        roomsAutoCollapsed = true;
        applyRoomsOpen();
      }
    } else {
      if (roomsAutoCollapsed && !roomsOpen) {
        roomsOpen = true;
        applyRoomsOpen();
      }
      roomsAutoCollapsed = false;
    }
  }

  function applyMoreOpen() {
    hudEl.classList.toggle("px-hud--more", moreOpen);
    refs.moreBtn.setAttribute("aria-expanded", moreOpen ? "true" : "false");
    const wait = waitingCount > 0 ? ` · รอคุณ ${waitingCount > 99 ? "99+" : waitingCount}` : "";
    setText(refs.moreBtn, `สรุป${wait} ${moreOpen ? "▴" : "▾"}`);
    refs.moreBtn.classList.toggle("px-more--warn", waitingCount > 0);
  }

  function applyRoomsOpen() {
    refs.rooms.classList.toggle("is-collapsed", !roomsOpen);
    refs.roomsList.hidden = !roomsOpen;
    refs.roomsHead.setAttribute("aria-expanded", roomsOpen ? "true" : "false");
    refs.roomsHead.title = roomsOpen ? "พับรายชื่อห้อง" : "กางรายชื่อห้อง";
    setText(refs.roomsChev, roomsOpen ? "▾" : "▸");
    refs.roomsEmpty.hidden = !roomsOpen || roomCount > 0;
  }

  function applyCaptionBtn() {
    const entry = CAPTION_MODES.find(([v]) => v === captionMode) || CAPTION_MODES[0];
    setText(refs.captionBtn, "ป้าย: " + entry[1]);
    refs.captionBtn.setAttribute("aria-label", "ป้ายงานเหนือตัวละคร: " + entry[1] + " — กดเพื่อสลับ");
    refs.captionBtn.title = entry[2] + " (กดเพื่อสลับ อัตโนมัติ → ทั้งหมด → ปิด)";
    refs.captionBtn.dataset.mode = entry[0];
  }

  function cycleCaptions() {
    const i = CAPTION_MODES.findIndex(([v]) => v === captionMode);
    captionMode = CAPTION_MODES[(i + 1) % CAPTION_MODES.length][0];
    applyCaptionBtn();
    command("captions", captionMode);
  }

  function toggleLegend() {
    if (legendOpen) closeLegend(false);
    else openLegend();
  }

  function openLegend() {
    legendOpen = true;
    refs.legend.hidden = false;
    refs.legendBtn.setAttribute("aria-expanded", "true");
    refs.legendBtn.classList.add("is-on");
    try {
      refs.legendClose.focus({ preventScroll: true });
    } catch (err) {
      /* focus ไม่ได้ (เช่นกำลังถูกซ่อนระหว่าง transition) — ไม่ใช่เรื่องใหญ่ */
    }
  }

  function closeLegend(returnFocus) {
    if (!legendOpen) return;
    legendOpen = false;
    refs.legend.hidden = true;
    refs.legendBtn.setAttribute("aria-expanded", "false");
    refs.legendBtn.classList.remove("is-on");
    if (returnFocus) {
      try {
        refs.legendBtn.focus({ preventScroll: true });
      } catch (err) {
        /* ดูเหตุผลใน openLegend */
      }
    }
  }

  function onKeyDown(e) {
    if (!e || e.key !== "Escape" || e.defaultPrevented) return;
    /* Esc ปิดของที่อยู่บนสุดทีละชั้น: legend ก่อน แล้วค่อยแผงรายละเอียด */
    if (legendOpen) {
      closeLegend(true);
      e.stopPropagation();
      return;
    }
    if (selectedKey) closePanel();
  }

  function onDocPointerDown(e) {
    if (!legendOpen) return;
    const t = e && e.target;
    if (t && (refs.legend.contains(t) || refs.legendBtn.contains(t))) return;
    closeLegend(false);
  }

  function closePanel() {
    const had = !!selectedKey;
    selectedKey = null;
    detail = null;
    renderDetail(true);
    refreshRoomHighlight();
    if (had) command("close-panel");
  }

  // ---------------------------------------------------------------
  // แถบบน: ชิปสรุป + การเชื่อมต่อ
  // ---------------------------------------------------------------

  function setStat(id, text, tone, extraTip) {
    const s = refs.stats[id];
    if (!s) return;
    setText(s.value, text);
    s.chip.classList.toggle("px-stat--warn", tone === "warn");
    s.chip.classList.toggle("px-stat--hot", tone === "hot");
    setTitle(s.chip, extraTip ? s.tip + " · " + extraTip : s.tip);
  }

  function renderStats(snap, info) {
    if (!snap) {
      for (const [id] of STAT_DEFS) setStat(id, "—", "");
      refs.overflowChip.hidden = true;
      return;
    }
    const t = snap.totals && typeof snap.totals === "object" ? snap.totals : {};
    const agents = Array.isArray(snap.agents) ? snap.agents : [];
    const live = Number.isFinite(num(t.live)) ? num(t.live) : agents.filter((a) => a && a.alive !== false).length;
    const i = info && typeof info === "object" ? info : {};

    let roomTip = "";
    if (Number.isFinite(num(i.rooms))) roomTip = "บนจอ " + fmtCount(i.rooms) + " ห้อง";
    if (Number.isFinite(num(i.characters))) roomTip = joinDot([roomTip, "ตัวละคร " + fmtCount(i.characters) + " ตัว"]);
    setStat("rooms", fmtCount(live), "", roomTip);
    setStat("busy", fmtCount(t.busy), num(t.busy) > 0 ? "hot" : "");
    setStat("waiting", fmtCount(t.waiting), num(t.waiting) > 0 ? "warn" : "");
    const w = Math.max(0, Math.floor(num(t.waiting)) || 0);
    if (w !== waitingCount) {
      waitingCount = w;
      applyMoreOpen();
    }
    setStat(
      "subs",
      fmtCount(t.subsRunning),
      num(t.subsRunning) > 0 ? "hot" : "",
      Number.isFinite(num(t.subsTotal)) ? "เคยจ้างทั้งหมด " + fmtCount(t.subsTotal) + " คน" : "",
    );
    setStat("tools", fmtCount(t.toolsRunning), "");
    setStat("tokens", fmtTok(tokTotal(t.tokens)), "", tokTitle(t.tokens));

    /* ผู้ช่วยที่ทำงานจริงแต่ไม่ได้วาดเพราะห้องเต็ม — ต้องบอก ไม่ใช่ตัดทิ้งเงียบ ๆ */
    const over = num(i.overflow);
    const showOver = Number.isFinite(over) && over > 0;
    refs.overflowChip.hidden = !showOver;
    if (showOver) {
      setText(refs.overflowValue, "+" + fmtCount(over));
      refs.overflowChip.title = "ผู้ช่วยที่กำลังทำงานแต่ไม่ได้วาดเพราะห้องเต็ม " + fmtCount(over) + " คน (ยังนับรวมในชิป “ผู้ช่วยทำงาน”)";
    }
  }

  function setConnected(bool) {
    const on = !!bool;
    refs.conn.classList.remove("px-conn--pending");
    refs.conn.classList.toggle("px-conn--on", on);
    refs.conn.classList.toggle("px-conn--off", !on);
    setText(refs.connText, on ? (fixtureMode ? "ต่อแล้ว (จำลอง)" : "ต่อแล้ว") : "สตรีมหลุด");
    refs.conn.title = on
      ? fixtureMode
        ? "กำลังเล่นข้อมูลจำลอง — ไม่ได้ต่อกับ session จริง"
        : "เชื่อมต่อสตรีม /api/stream อยู่"
      : "สตรีมหลุด — กำลังต่อใหม่อัตโนมัติ (ภาพบนจอคือสถานะล่าสุดก่อนหลุด)";
  }

  // ---------------------------------------------------------------
  // ฟีดเหตุการณ์
  // ---------------------------------------------------------------

  function pushFeed(entry) {
    if (!entry || typeof entry !== "object") return;
    const tone = TONES.has(entry.tone) ? entry.tone : "info";
    let text = cleanText(entry.text);
    if (!text) return;
    /*
     * emoji ที่ world.js เขียนนำหน้าข้อความ (เช่น "🤝 ห้อง: รับผู้ช่วย…") คือความหมายที่ผู้เล่าเลือกเอง
     * จึงชนะ entry.icon เสมอ — ไม่งั้นแถวเดียวจะมีไอคอนสองอันที่อาจขัดกัน
     */
    let icon = iconEmoji(entry.icon);
    const lead = splitLeadingEmoji(text);
    if (lead.emoji && lead.rest) {
      icon = lead.emoji;
      text = lead.rest;
    }
    const key = typeof entry.key === "string" && entry.key ? entry.key : null;

    const item = el("div", "px-feed-item");
    item.setAttribute("role", "listitem");
    const row = el(key ? "button" : "div", "px-feed-row px-tone--" + tone);
    if (key) {
      row.type = "button";
      row.dataset.key = key;
      row.title = "คลิกเพื่อเลือกตัวละครของเหตุการณ์นี้";
    }
    const time = el("span", "px-feed-time", fmtClock(entry.ts));
    const ic = el("span", "px-feed-icon", icon || "•");
    ic.setAttribute("aria-hidden", "true");
    const shown = truncate(text, 180);
    const body = el("span", "px-feed-text", shown);
    if (shown !== text) body.title = truncate(text, 1000);
    row.append(time, ic, body);
    item.append(row);

    refs.feedList.prepend(item);
    while (refs.feedList.childElementCount > FEED_MAX_ROWS) refs.feedList.lastElementChild.remove();
    /* ถ้าคนกำลังเลื่อนอ่านแถวเก่าอยู่ ห้ามดึงกลับขึ้นบนเอง — ดึงเฉพาะตอนอยู่บนสุดแล้ว */
    if (feedOpen && refs.feedList.scrollTop < 24) refs.feedList.scrollTop = 0;
    if (!feedOpen) {
      feedUnread += 1;
      applyFeedBadge();
    }
    applyFeedEmpty();
  }

  // ---------------------------------------------------------------
  // รายชื่อห้อง — keyed diff ไม่ล้างแล้วสร้างใหม่ (ปุ่มที่ถูก focus อยู่ต้องไม่หลุด focus ทุก snapshot)
  // ---------------------------------------------------------------

  function createRoomRow(sessionId) {
    const btn = el("button", "px-room");
    btn.type = "button";
    btn.dataset.sessionId = sessionId;
    const dot = el("span", "px-room-dot");
    dot.setAttribute("aria-hidden", "true");
    const name = el("span", "px-room-name", "—");
    const state = el("span", "px-room-state", "");
    btn.append(dot, name, state);
    btn.addEventListener("click", () => command("focus-room", sessionId));
    return { btn, dot, name, state };
  }

  function updateRoomRow(row, r) {
    const alive = r.alive !== false;
    const raw = typeof r.state === "string" ? r.state : "unknown";
    const state = alive ? (STATE_INFO[raw] ? raw : "unknown") : "closed";
    const title = truncate(cleanText(r.title) || String(r.sessionId).slice(0, 8), 32);
    const stText = alive ? STATE_INFO[state].short : "ปิดแล้ว";
    setText(row.name, title);
    setText(row.state, stText);
    row.btn.dataset.state = state;
    row.btn.classList.toggle("is-closed", !alive);
    row.btn.setAttribute("aria-label", "ไปที่ห้อง " + title + " — " + stText);
    row.btn.title = "ไปที่ห้อง " + (cleanText(r.title) || r.sessionId) + " (" + stText + ")";
  }

  function setRooms(list) {
    const arr = Array.isArray(list) ? list.filter((r) => r && typeof r === "object" && r.sessionId) : [];
    const seen = new Set();
    let prev = null;
    for (const r of arr) {
      const id = String(r.sessionId);
      if (seen.has(id)) continue;
      seen.add(id);
      let row = roomRows.get(id);
      if (!row) {
        row = createRoomRow(id);
        roomRows.set(id, row);
      }
      updateRoomRow(row, r);
      const want = prev ? prev.nextSibling : refs.roomsList.firstChild;
      if (row.btn !== want) refs.roomsList.insertBefore(row.btn, want);
      prev = row.btn;
    }
    for (const [id, row] of roomRows) {
      if (!seen.has(id)) {
        row.btn.remove();
        roomRows.delete(id);
      }
    }
    roomCount = seen.size;
    setText(refs.roomsCount, String(roomCount));
    refs.roomsEmpty.hidden = !roomsOpen || roomCount > 0;
    refreshRoomHighlight();
    applyAttention();
  }

  /*
   * ห้องที่ "รอคุณตอบ/รออนุญาต/ติดด่าน" แต่หัวหน้าอยู่นอกส่วนที่มองเห็นของฉาก (main.js ส่งมาจาก scene)
   * → แถวในรายชื่อห้องกระพริบเรียก + หัวรายชื่อ (ตอนพับอยู่) ติดไฟ — ไม่ขยับกล้อง ผู้ใช้กดแถวเองถ้าอยากไปดู
   */
  let attentionIds = new Set();
  function setAttention(list) {
    attentionIds = new Set(Array.isArray(list) ? list.filter((x) => typeof x === "string" && x) : []);
    applyAttention();
  }

  function applyAttention() {
    const tag = " (อยู่นอกจอ)";
    let any = false;
    for (const [id, row] of roomRows) {
      const on = attentionIds.has(id);
      row.btn.classList.toggle("is-attention", on);
      /* updateRoomRow เขียน aria-label ใหม่ทุก snapshot — ต่อท้ายใหม่ทุกครั้ง (ตัดของเดิมก่อน กันซ้ำ) */
      const base = (row.btn.getAttribute("aria-label") || "").replace(tag, "");
      row.btn.setAttribute("aria-label", on ? base + tag : base);
      if (on) any = true;
    }
    refs.rooms.classList.toggle("has-attention", any);
  }

  function refreshRoomHighlight() {
    const sid = selectedKey ? parseKey(selectedKey).sessionId : null;
    for (const [id, row] of roomRows) {
      const on = id === sid;
      row.btn.classList.toggle("is-current", on);
      if (on) row.btn.setAttribute("aria-current", "true");
      else row.btn.removeAttribute("aria-current");
    }
  }

  // ---------------------------------------------------------------
  // แผงรายละเอียด — จัดรูปแบบเองจาก object ดิบของ snapshot
  // ---------------------------------------------------------------

  function resolveDetail(key, given, prev) {
    const parsed = parseKey(key);
    const d = given && typeof given === "object" ? given : {};
    let session = d.session && typeof d.session === "object" ? d.session : null;
    let node = d.node && typeof d.node === "object" ? d.node : null;
    const character =
      d.character && typeof d.character === "object" ? d.character : prev && prev.character ? prev.character : null;
    if (!session) session = findSession(lastSnapshot, parsed.sessionId);
    if (!node) node = parsed.agentId ? findSub(session, parsed.agentId) : session;
    let gone = false;
    if (!node && prev && prev.node) {
      node = prev.node;
      session = session || prev.session;
      gone = true;
    }
    const role = d.role === "lead" || d.role === "helper" ? d.role : parsed.agentId ? "helper" : "lead";
    return { key, role, sessionId: parsed.sessionId, agentId: parsed.agentId, session, node, character, gone };
  }

  function setSelected(key, d) {
    const k = typeof key === "string" && key ? key : null;
    if (!k) {
      selectedKey = null;
      detail = null;
      renderDetail(true);
      refreshRoomHighlight();
      return;
    }
    const fresh = k !== selectedKey;
    selectedKey = k;
    detail = resolveDetail(k, d, fresh ? null : detail);
    if (fresh) {
      nowListSig = "";
      captionSig = "";
    }
    renderDetail(fresh);
    refreshRoomHighlight();
  }

  /** ดึงข้อมูลตัวที่เลือกจาก snapshot ใหม่เอง — main.js ไม่ต้องเรียก setSelected ซ้ำทุกรอบ */
  function refreshDetailFromSnapshot() {
    if (!selectedKey || !detail) return;
    const s = findSession(lastSnapshot, detail.sessionId);
    const n = detail.agentId ? findSub(s, detail.agentId) : s;
    if (n) {
      detail.session = s;
      detail.node = n;
      detail.gone = false;
    } else if (detail.node) {
      detail.gone = true;
    }
    renderDetail(false);
  }

  function renderDetail(fresh) {
    const open = !!(selectedKey && detail);
    refs.detail.hidden = !open;
    hudEl.classList.toggle("px-hud--detail-open", open);
    autoCollapseRooms(open);
    if (!open) {
      panelTimers = [];
      nowListSig = "";
      captionSig = "";
      return;
    }
    if (fresh) refs.detailBody.scrollTop = 0;
    panelTimers = panelTimers.filter((t) => t.scope === "now");

    if (!detail.node) {
      setRole(detail.role);
      setText(refs.name, "ไม่พบข้อมูล");
      refs.name.removeAttribute("title");
      setText(refs.sub, detail.agentId ? "ผู้ช่วย " + detail.agentId.slice(0, 8) : "session " + detail.sessionId.slice(0, 8));
      refs.modelChip.hidden = true;
      refs.stateChip.hidden = true;
      refs.gone.hidden = true;
      refs.missing.hidden = false;
      refs.content.hidden = true;
      panelTimers = [];
      nowListSig = "";
      return;
    }

    refs.missing.hidden = true;
    refs.content.hidden = false;
    refs.modelChip.hidden = false;
    refs.stateChip.hidden = false;
    refs.gone.hidden = !detail.gone;

    try {
      if (detail.role === "helper") renderHelper(detail.node, detail.session, detail.gone);
      else renderLead(detail.node, detail.gone);
    } catch (err) {
      /* ข้อมูลรูปร่างแปลกจนจัดรูปแบบไม่ได้ ต้องไม่ลาก HUD ทั้งตัวไปด้วย — แสดงว่าอ่านไม่ออกแทน */
      console.error("[pixel/hud] จัดรูปแบบแผงรายละเอียดไม่สำเร็จ", err);
      refs.content.hidden = true;
      refs.missing.hidden = false;
    }
    renderCaption();
    updateTimers(true);
  }

  function setRole(role) {
    const lead = role !== "helper";
    setText(refs.role, lead ? "หัวหน้า" : "ผู้ช่วย");
    refs.role.classList.toggle("px-role--lead", lead);
    refs.role.classList.toggle("px-role--helper", !lead);
  }

  function applyModel(tag, model) {
    const info = MODEL_INFO[tag];
    refs.modelChip.className = "px-model-chip px-model--" + (info ? info.cls : "un");
    const full = cleanText(model);
    setText(refs.modelText, info ? tag + (full ? " · " + full : " · " + info.name) : full || "ไม่ทราบรุ่น");
    refs.modelChip.title = "สีเสื้อของตัวละครบอกโมเดล" + (info ? " — " + info.name : "");
  }

  function applyState(stateKey, icon, text, sinceMs) {
    refs.stateChip.dataset.state = stateKey;
    setText(refs.stateIcon, icon || "");
    setText(refs.stateText, text || "");
    if (Number.isFinite(sinceMs)) {
      refs.stateSince.hidden = false;
      panelTimers.push({ el: refs.stateSince, since: sinceMs, scope: "state", prefix: "· " });
    } else {
      refs.stateSince.hidden = true;
      setText(refs.stateSince, "");
    }
  }

  function setStatCell(i, label, value, tone, title) {
    const c = refs.statCells[i];
    setText(c.dt, label);
    setText(c.dd, value);
    c.wrap.classList.toggle("px-statcell--bad", tone === "bad");
    c.wrap.classList.toggle("px-statcell--warn", tone === "warn");
    setTitle(c.wrap, title || "");
  }

  function setField(f, label, value, max, meta) {
    const t = cleanText(value);
    f.wrap.hidden = !t;
    if (!t) return;
    setText(f.lab, label);
    setText(f.meta, meta || "");
    const shown = truncate(t, max);
    setText(f.text, shown);
    setTitle(f.text, shown !== t ? truncate(t, 1500) : "");
  }

  function setKv(row, value, opt) {
    const o = opt || {};
    const v = value === undefined || value === null ? "" : String(value);
    const show = v !== "";
    row.dt.hidden = !show;
    row.dd.hidden = !show;
    if (!show) return;
    setText(row.dt, o.label || row.label);
    setText(row.dd, v);
    setTitle(row.dd, o.title || "");
  }

  function setHirer(name, key) {
    const row = refs.kv.hirer;
    const show = !!name;
    row.dt.hidden = !show;
    row.dd.hidden = !show;
    if (!show) return;
    setText(refs.hirerBtn, name);
    refs.hirerBtn.dataset.key = key || "";
    refs.hirerBtn.disabled = !key;
    refs.hirerBtn.setAttribute("aria-label", key ? "เลือกผู้ว่าจ้าง: " + name : "ผู้ว่าจ้าง: " + name);
    refs.hirerBtn.title = key ? "คลิกเพื่อดูผู้ว่าจ้าง" : "ผู้ว่าจ้างไม่อยู่ในข้อมูลล่าสุดแล้ว";
  }

  function runItem(r) {
    const tool = cleanText(r.tool);
    const info = toolInfo(tool);
    const label = cleanText(r.label);
    return {
      kind: "run",
      icon: iconEmoji(r.icon) || info.emoji,
      head: info.verb + (tool ? " · " + shortTool(tool) : ""),
      label: label && label !== tool ? label : "",
      since: toMs(r.startedTs),
    };
  }

  function doneItem(t) {
    const tool = cleanText(t.tool);
    const info = toolInfo(tool);
    const label = cleanText(t.label);
    const err = !!t.error;
    return {
      kind: "done",
      icon: iconEmoji(t.icon) || info.emoji,
      head: (err ? "✗ พลาด: " : "✓ เสร็จ: ") + info.verb + (tool ? " · " + shortTool(tool) : ""),
      label: label && label !== tool ? label : "",
      since: NaN,
      timeText: fmtDur(t.durMs),
      error: err,
    };
  }

  /** แถว "กำลังทำ" — สร้าง DOM ใหม่เฉพาะตอนรายการเปลี่ยนจริง นาฬิกาจะได้เดินต่อเนื่องไม่กระพริบ */
  function renderNow(items, emptyText) {
    const sig =
      items
        .map((it) => [it.kind, it.icon, it.head, it.label, it.since, it.timeText, it.error ? 1 : 0].join("|"))
        .join("§") +
      "#" +
      emptyText;
    if (sig === nowListSig) return;
    nowListSig = sig;
    panelTimers = panelTimers.filter((t) => t.scope !== "now");
    const nodes = [];
    for (const it of items) {
      const row = el(
        "div",
        "px-now-row px-now-row--" + it.kind + (it.error ? " px-now-row--error" : ""),
      );
      const ic = el("span", "px-now-icon", it.icon || "🔧");
      ic.setAttribute("aria-hidden", "true");
      const main = el("span", "px-now-main");
      const headEl = el("span", "px-now-head");
      headEl.append(breakable(it.head));
      main.append(headEl);
      if (it.label) {
        const shown = truncate(it.label, 90);
        const lab = el("span", "px-now-label");
        lab.append(breakable(shown));
        if (shown !== it.label) lab.title = truncate(it.label, 1000);
        main.append(lab);
      }
      const time = el("span", "px-now-time", it.timeText || "");
      row.append(ic, main, time);
      if (Number.isFinite(it.since)) panelTimers.push({ el: time, since: it.since, scope: "now", prefix: "" });
      nodes.push(row);
    }
    if (!nodes.length) nodes.push(el("div", "px-now-empty", emptyText || "—"));
    refs.nowList.replaceChildren(...nodes);
  }

  function renderLead(s, gone) {
    const status = s.status && typeof s.status === "object" ? s.status : {};
    const raw = typeof status.state === "string" ? status.state : "unknown";
    const state = STATE_INFO[raw] ? raw : "unknown";
    const running = Array.isArray(status.running) ? status.running.filter((r) => r && typeof r === "object") : [];
    const alive = s.alive !== false;
    const counts = s.counts && typeof s.counts === "object" ? s.counts : {};
    const events = Array.isArray(s.events) ? s.events : [];

    setRole("lead");
    const full = sessionDisplayName(s, 300);
    setText(refs.name, truncate(full, 60));
    setTitle(refs.name, full);
    setText(refs.sub, joinDot(["หัวหน้าห้อง", entrypointText(s.entrypoint), kindText(s.kind)]));
    applyModel(modelTagOf(s.model), s.model);

    let chip = state;
    let icon = STATE_INFO[state].icon;
    let text = STATE_INFO[state].text;
    if (!alive) {
      chip = "closed";
      icon = "🌙";
      const ago = fmtEndedAgo(s.endedAgo);
      text = "ปิดแล้ว" + (ago ? " · " + ago : "");
    } else if (state === "waiting") {
      /* waiting มีสองความหมาย (สเปก): ถาม AskUserQuestion จริง หรือ tool ค้าง >25s ซึ่ง "น่าจะ" รอสิทธิ์ */
      const asking = running.some((r) => r.tool === "AskUserQuestion");
      icon = asking ? "🙋" : "✋";
      text = asking ? "รอคุณตอบคำถาม" : "รออนุญาต (น่าจะมีกล่องขอสิทธิ์ค้างอยู่)";
    }
    if (gone) text += " · ไม่อยู่ในข้อมูลล่าสุด";
    applyState(chip, icon, text, alive && !gone ? toMs(status.since) : NaN);

    const items = running.slice(0, MAX_NOW_ROWS).map(runItem);
    if (running.length > MAX_NOW_ROWS) {
      items.push({ kind: "more", icon: "…", head: "และอีก " + (running.length - MAX_NOW_ROWS) + " รายการ", since: NaN });
    }
    if (!running.length && alive) {
      const since = toMs(status.since);
      if (state === "thinking") items.push({ kind: "state", icon: "💭", head: "คิดอยู่ — ไม่มีเครื่องมือค้าง", since });
      else if (state === "idle") items.push({ kind: "state", icon: "☕", head: "ว่าง รอคำสั่งจากคุณ", since });
      else if (state === "blocked") items.push({ kind: "state", icon: "⛔", head: "ติดด่าน — รอคุณช่วยปลด", since });
      else if (state === "delegating") items.push({ kind: "state", icon: "🤖", head: "คุมงานผู้ช่วย", since });
    }
    setText(refs.nowTitle, "กำลังทำ");
    renderNow(items, alive ? "ไม่มีเครื่องมือค้างอยู่" : "session ปิดไปแล้ว — ไม่มีงานค้าง");

    setStatCell(0, "tool", fmtCount(counts.tools), "", "จำนวนครั้งที่เรียกเครื่องมือทั้ง session (ไม่รวมผู้ช่วย)");
    setStatCell(1, "error", fmtCount(counts.errors), num(counts.errors) > 0 ? "bad" : "");
    setStatCell(2, "ถูกปฏิเสธ", fmtCount(counts.denials), num(counts.denials) > 0 ? "warn" : "");
    setStatCell(3, "โทเค็น", fmtTok(tokTotal(s.tokens)), "", tokTitle(s.tokens));

    const prompt = lastEvent(events, (e) => e.kind === "prompt" && cleanText(e.text));
    setField(refs.fTask, "คำสั่งล่าสุดจากคุณ", prompt && prompt.text, TASK_MAX, prompt ? fmtAgo(prompt.ts, nowRef) : "");
    const said = lastEvent(events, (e) => e.kind === "say" && cleanText(e.text));
    setField(refs.fSaid, "พูดล่าสุด", said && said.text, SAID_MAX, said ? fmtAgo(said.ts, nowRef) : "");
    const trouble = lastEvent(
      events,
      (e) => e.kind === "error" || e.kind === "denied" || e.kind === "blocked" || e.kind === "guard",
    );
    setField(refs.fTrouble, "สะดุดล่าสุด", trouble && troubleText(trouble), SAID_MAX, trouble ? fmtAgo(trouble.ts, nowRef) : "");
    setField(refs.fAnswer, "", "", 0);

    setHirer("", null);
    setKv(refs.kv.depth, "");
    setKv(refs.kv.project, joinDot([basename(s.cwd), s.gitBranch ? "⎇ " + s.gitBranch : ""]), { title: cleanText(s.cwd) });
    setKv(refs.kv.entry, joinDot([entrypointText(s.entrypoint), s.version ? "v" + s.version : ""]));
    setKv(refs.kv.model, joinDot([s.model, s.effort ? "effort " + s.effort : ""]));
    setKv(refs.kv.helpers, helpersText(s.subTotals), { label: "ผู้ช่วย" });
    setKv(refs.kv.source, "");
    setKv(refs.kv.outcome, "");
    setKv(refs.kv.endedBy, cleanText(status.endedBy));
    setKv(refs.kv.started, fmtAgo(s.startedAt, nowRef));
    setKv(refs.kv.workflow, "");
  }

  function helpersText(st) {
    if (!st || typeof st !== "object") return "";
    const total = num(st.total);
    if (Number.isFinite(total) && total === 0) return "ยังไม่ได้จ้าง";
    return joinDot([
      "ทำงาน " + fmtCount(st.running),
      Number.isFinite(num(st.done)) ? "จบ " + fmtCount(st.done) : "",
      num(st.failed) > 0 ? "พลาด " + fmtCount(st.failed) : "",
      "รวม " + fmtCount(st.total),
      num(st.truncated) > 0 ? "(ตัดทิ้ง " + fmtCount(st.truncated) + ")" : "",
    ]);
  }

  function renderHelper(sub, session, gone) {
    const running = sub.running === true;
    const cur = sub.current && typeof sub.current === "object" ? sub.current : null;
    const last = sub.lastTool && typeof sub.lastTool === "object" ? sub.lastTool : null;
    const tag = normTag(sub.modelTag) || modelTagOf(sub.model);
    const agentId = cleanText(sub.agentId) || detail.agentId || "";

    setRole("helper");
    const full = cleanText(sub.label) || cleanText(sub.type) || "ผู้ช่วย " + agentId.slice(0, 8);
    setText(refs.name, truncate(full, 60));
    setTitle(refs.name, truncate(full, 400));
    setText(refs.sub, joinDot([sub.type || "ผู้ช่วย", session ? "ห้อง " + sessionDisplayName(session) : ""]));
    applyModel(tag, sub.model);

    let st;
    let icon;
    let text;
    let since = NaN;
    if (running) {
      if (cur && isDelegateTool(cur.tool)) {
        st = "delegating";
        icon = "🤖";
        text = "คุมงานผู้ช่วยย่อย";
        since = toMs(cur.startedTs);
      } else if (cur) {
        st = "tool";
        icon = "🛠";
        text = "กำลังใช้เครื่องมือ";
        since = toMs(cur.startedTs);
      } else {
        st = "thinking";
        icon = "💭";
        text = "กำลังคิด";
        since = toMs(sub.lastTs);
      }
    } else {
      const o = cleanText(sub.outcome);
      if (o === "ok") {
        st = "done";
        icon = "✅";
        text = "ส่งงานแล้ว";
      } else if (o === "unknown" || !o) {
        st = "idle";
        icon = "🏁";
        text = o ? "จบแล้ว (ไม่ทราบผลแน่ชัด)" : "จบแล้ว";
      } else {
        st = "failed";
        icon = "❌";
        text = "ล้มเหลว (" + outcomeTh(o) + ")";
      }
    }
    if (gone) text += " · ออกจากออฟฟิศแล้ว";
    applyState(st, icon, text, gone ? NaN : since);

    const items = [];
    if (running && cur) items.push(runItem(cur));
    else if (running) {
      items.push({
        kind: "state",
        icon: "💭",
        head: "คิดอยู่ — ไม่มีเครื่องมือค้าง",
        label: "นับเวลาจากความเคลื่อนไหวล่าสุดใน transcript",
        since: toMs(sub.lastTs),
      });
    }
    if (last) items.push(doneItem(last));
    setText(refs.nowTitle, running ? "กำลังทำ" : "งานล่าสุด");
    renderNow(items, "ยังไม่มีข้อมูลเครื่องมือ");

    setStatCell(0, "tool", fmtCount(sub.tools));
    setStatCell(1, "error", fmtCount(sub.errors), num(sub.errors) > 0 ? "bad" : "");
    const startMs = toMs(sub.startedTs);
    if (running && !gone && Number.isFinite(startMs)) {
      setStatCell(2, "เวลา", compactDur(fmtElapsed(nowRef - startMs)), "", "ทำงานมาแล้ว (นับจากตอนถูกจ้าง)");
      panelTimers.push({ el: refs.statCells[2].dd, since: startMs, scope: "stat", prefix: "" });
    } else {
      setStatCell(2, "เวลา", compactDur(fmtDur(sub.durMs)), "", "เวลาตั้งแต่ถูกจ้างจนเขียน transcript ครั้งสุดท้าย");
    }
    setStatCell(3, "โทเค็น", fmtTok(tokTotal(sub.tokens)), "", tokTitle(sub.tokens));

    setField(refs.fTask, "งานที่ได้รับ", sub.task || sub.label, TASK_MAX, fmtAgo(sub.startedTs, nowRef));
    const said = lastEvent(sub.events, (e) => e.kind === "say" && cleanText(e.text));
    setField(refs.fSaid, "พูดล่าสุด", said && said.text, SAID_MAX, said ? fmtAgo(said.ts, nowRef) : "");
    const trouble = lastEvent(sub.events, (e) => e.kind === "error" || e.kind === "denied");
    setField(refs.fTrouble, "สะดุดล่าสุด", trouble && troubleText(trouble), SAID_MAX, trouble ? fmtAgo(trouble.ts, nowRef) : "");
    setField(refs.fAnswer, "รายงานที่ส่ง", running ? "" : sub.answer, ANSWER_MAX);

    /* ผู้ว่าจ้าง: parentAgentId ว่าง = หัวหน้าจ้างเอง · มีค่า = ผู้ช่วยอีกตัวจ้างต่อ (ข้อตกลงของ server.mjs) */
    const sid = detail.sessionId;
    if (sub.parentAgentId) {
      const par = findSub(session, sub.parentAgentId);
      const parId = String(sub.parentAgentId);
      if (par) setHirer("ผู้ช่วย · " + truncate(cleanText(par.label) || cleanText(par.type) || parId.slice(0, 8), 40), sid + ":" + parId);
      else setHirer("ผู้ช่วย " + parId.slice(0, 8) + " (ไม่อยู่ในข้อมูลล่าสุด)", null);
    } else {
      setHirer("หัวหน้า · " + (session ? sessionDisplayName(session) : sid.slice(0, 8)), session ? sid : null);
    }

    const kids = session && Array.isArray(session.subagents)
      ? session.subagents.filter((x) => x && x.parentAgentId && String(x.parentAgentId) === agentId)
      : [];
    const kidsRunning = kids.filter((x) => x.running === true).length;

    setKv(refs.kv.depth, depthText(sub.depth));
    setKv(refs.kv.project, "");
    setKv(refs.kv.entry, "");
    setKv(refs.kv.model, cleanText(sub.model));
    setKv(refs.kv.helpers, kids.length ? "ทำงาน " + kidsRunning + " · รวม " + kids.length : "", { label: "จ้างต่อ" });
    setKv(refs.kv.source, runningSourceText(sub.runningSource), {
      title: "หลักฐานที่ server ใช้ตัดสินว่าผู้ช่วยตัวนี้ยังทำงาน/จบแล้ว",
    });
    setKv(refs.kv.outcome, running ? "" : outcomeTh(sub.outcome));
    setKv(refs.kv.endedBy, "");
    setKv(refs.kv.started, fmtAgo(sub.startedTs, nowRef));
    setKv(refs.kv.workflow, sub.workflowId ? truncate(String(sub.workflowId), 24) : "", {
      title: sub.workflowId ? String(sub.workflowId) : "",
    });
  }

  /** บรรทัด "บนจอตอนนี้" — สิ่งที่ตัวละครกำลังแสดง (อาจเป็นภาพย้อน) แยกจากข้อมูลจริงด้านบน */
  function renderCaption() {
    const ch = detail && detail.character;
    const cap = ch && ch.caption && typeof ch.caption === "object" ? ch.caption : null;
    const text = cap ? cleanText(cap.text) : "";
    const replay = !!(cap && cap.replay);
    const sig = text + "|" + (replay ? 1 : 0) + "|" + (cap ? String(cap.icon || "") : "");
    if (sig === captionSig) return;
    captionSig = sig;
    refs.scene.hidden = !text;
    if (!text) return;
    const lead = splitLeadingEmoji(text);
    const ic = lead.emoji ? "" : iconEmoji(cap.icon);
    setText(refs.sceneText, truncate((ic ? ic + " " : "") + text, 120));
    refs.sceneReplay.hidden = !replay;
  }

  function currentNow() {
    if (Number.isFinite(nowRef)) return nowRef;
    if (Number.isFinite(clockBaseMs)) return clockBaseMs + (perfNow() - clockBasePerf);
    return Date.now();
  }

  function updateTimers(force) {
    if (!panelTimers.length) return;
    const now = currentNow();
    for (const t of panelTimers) {
      const el = fmtElapsed(now - t.since);
      const txt = (t.prefix || "") + (t.scope === "stat" ? compactDur(el) : el);
      if (force || t.el.textContent !== txt) t.el.textContent = txt;
    }
  }

  // ---------------------------------------------------------------
  // เสียง — สะท้อนสถานะจริงของ shared audio engine (activity-audio.js)
  // ---------------------------------------------------------------

  function setMeterLevel(rawLevel, active) {
    const level = Math.max(0, Math.min(1, Number(rawLevel) || 0));
    refs.voiceBars.forEach((bar, i) => {
      bar.style.setProperty("--voice-meter-height", Math.round(3 + level * 9 * METER_SHAPE[i]) + "px");
    });
    refs.voiceGroup.classList.toggle("has-live-level", !!active);
  }

  /** ตรรกะเดียวกับ renderActivityVoiceState ของหน้าคลาสสิก — สองหน้าต้องพูดเรื่องเดียวกันด้วยคำเดียวกัน */
  function setVoiceState(next) {
    const s = next && typeof next === "object" ? next : {};
    let mode = voice.mode;
    if (AUDIO_MODE_VALUES.includes(s.mode)) mode = s.mode;
    else if (s.voiceEnabled === true) mode = "voice";
    else if (s.effectsEnabled === true) mode = "effects";
    /* engine รุ่นก่อนส่งมาแค่ enabled — ถือว่าเปิด = พูด ตามพฤติกรรมเดิมของมัน */
    else if (typeof s.enabled === "boolean") mode = s.enabled ? "voice" : "off";
    voice = { ...voice, ...s, mode };

    const supported = voice.supported !== false;
    const active = mode !== "off" && supported;
    const remindersEnabled = voice.remindersEnabled !== false;
    const voiceAvailable = voice.voiceAvailable !== false;
    const speaking = !!voice.speaking;

    refs.voiceSelect.disabled = !supported;
    if (refs.voiceSelect.value !== mode) refs.voiceSelect.value = mode;
    refs.reminderInput.checked = remindersEnabled;
    /* ค่าจำของผู้ใช้ — เปลี่ยนได้แม้โหมดเสียงปิดอยู่ มันแค่ยังไม่ทำงานจนกว่าจะเปิดเสียง (เหมือนหน้าคลาสสิก) */
    refs.reminderInput.disabled = !supported;
    refs.voiceGroup.classList.toggle("is-unsupported", !supported);
    refs.voiceGroup.classList.toggle("is-enabled", active);
    refs.voiceGroup.classList.toggle("is-speaking", active && speaking);
    refs.voiceGroup.dataset.audioMode = mode;
    setText(refs.voiceLabel, supported ? "เสียง AI" : "เสียง AI: ไม่รองรับ");
    setText(refs.voiceIcon, mode === "voice" ? "🔊" : mode === "effects" ? "🔉" : "🔇");
    refs.voiceSelect.setAttribute(
      "aria-label",
      supported
        ? "โหมดเสียง AI ปัจจุบัน: " + (mode === "voice" ? "พูดพร้อมเอฟเฟกต์" : mode === "effects" ? "เอฟเฟกต์" : "ปิด")
        : "โหมดเสียง AI: เบราว์เซอร์นี้ไม่รองรับ",
    );
    const voiceName = cleanText(voice.voiceName);
    refs.voiceGroup.title = !supported
      ? "เบราว์เซอร์นี้ไม่รองรับ Web Audio หรือเสียงพูด"
      : active && !voice.unlocked
        ? "เลือกโหมดเสียงแล้ว — โต้ตอบกับหน้าเว็บหนึ่งครั้งเพื่อเริ่มเสียง"
        : mode === "voice"
          ? voiceAvailable
            ? voice.voiceFallback
              ? "ไม่พบเสียงภาษาไทย — ใช้เสียงของเครื่องพูดภาษาอังกฤษแทน" + (voiceName ? " · " + voiceName : "")
              : "พูดภาษาไทยพร้อมเอฟเฟกต์" + (voiceName ? " · " + voiceName : "")
            : "ไม่พบเสียงพูดในเครื่องเลย — จะเล่นเอฟเฟกต์แทน"
          : mode === "effects"
            ? "เอฟเฟกต์เสียงเท่านั้น ไม่มีเสียงพูด"
            : "ปิดเสียงเหตุการณ์ของ AI";
    refs.reminderLabel.title = !supported
      ? "เบราว์เซอร์นี้ไม่รองรับเสียงเตือน"
      : mode === "off"
        ? "เปิดโหมดเสียงก่อน จึงจะใช้การเตือนซ้ำได้"
        : remindersEnabled
          ? "กำลังเตือนเป็นระยะจนกว่างานที่รอคุณจะทำต่อได้"
          : "เปิดเพื่อเตือนเป็นระยะเมื่องานรอคำตอบหรือการยืนยันจากคุณ";
    if (!active || !speaking) {
      refs.voiceGroup.classList.remove("is-voice-fallback");
      setMeterLevel(0, false);
    }
  }

  function pulseCue() {
    const g = refs.voiceGroup;
    if (cueTimer !== null) clearTimeout(cueTimer);
    g.classList.remove("is-cue");
    /* บังคับ reflow ให้ cue ที่มาติด ๆ กันเริ่ม animation ใหม่ทุกครั้ง */
    void g.offsetWidth;
    g.classList.add("is-cue");
    cueTimer = setTimeout(() => {
      cueTimer = null;
      g.classList.remove("is-cue");
    }, 520);
  }

  /** เฟรมภาพจาก audio engine: มิเตอร์ขยับตามจังหวะพูด และกระพริบ 1 ครั้งต่อ cue ใหม่ */
  function setVoiceVisual(frame) {
    if (!frame || typeof frame !== "object") return;
    const phase = frame.phase;
    if (phase === "cue") {
      pulseCue();
      /* cue สั้น ๆ ไม่มี frame ตามมา — ยกมิเตอร์ค้างไว้ครู่เดียวให้เห็นว่ามีเสียงดัง แล้วคืนเอง */
      if (!voice.speaking) {
        refs.voiceGroup.classList.add("is-voice-fallback");
        setMeterLevel(Number(frame.level) || 0.68, true);
        if (meterResetTimer !== null) clearTimeout(meterResetTimer);
        meterResetTimer = setTimeout(() => {
          meterResetTimer = null;
          if (!voice.speaking) {
            refs.voiceGroup.classList.remove("is-voice-fallback");
            setMeterLevel(0, false);
          }
        }, 360);
      }
      return;
    }
    if (phase === "start" || phase === "frame" || phase === "boundary") {
      setMeterLevel(frame.level, true);
      return;
    }
    if (phase === "end" || phase === "cancel" || phase === "disabled") {
      refs.voiceGroup.classList.remove("is-voice-fallback");
      setMeterLevel(0, false);
    }
  }

  // ---------------------------------------------------------------
  // toast · ซูม · จอว่าง
  // ---------------------------------------------------------------

  function toast(text, tone) {
    const msg = cleanText(text);
    if (!msg) return;
    const t = el("div", "px-toast px-tone--" + (TONES.has(tone) ? tone : "info"), truncate(msg, 240));
    refs.toasts.append(t);
    while (refs.toasts.childElementCount > TOAST_MAX) refs.toasts.firstElementChild.remove();
    const timer = setTimeout(() => {
      toastTimers.delete(timer);
      t.classList.add("px-toast--leaving");
      const rm = setTimeout(() => {
        toastTimers.delete(rm);
        t.remove();
      }, TOAST_FADE_MS);
      toastTimers.add(rm);
    }, TOAST_LIFETIME_MS);
    toastTimers.add(timer);
  }

  function setZoom(z) {
    const v = num(z);
    if (!Number.isFinite(v)) return;
    setText(refs.zoomVal, "×" + (Number.isInteger(v) ? v : v.toFixed(1)));
    /*
     * ใช้ aria-disabled ไม่ใช่ disabled: ปุ่ม disabled จะทำ focus หลุดไปที่ body ทันที
     * คนที่กด + รัว ๆ ด้วยคีย์บอร์ดจนสุดทางจะหลงว่า focus ไปอยู่ไหน
     */
    refs.zoomOut.setAttribute("aria-disabled", v <= ZOOM_MIN ? "true" : "false");
    refs.zoomIn.setAttribute("aria-disabled", v >= ZOOM_MAX ? "true" : "false");
  }

  function showEmpty(bool) {
    refs.empty.hidden = !bool;
  }

  // ---------------------------------------------------------------
  // API สาธารณะ
  // ---------------------------------------------------------------

  function update(snapshot, info) {
    if (disposed) return;
    const snap = snapshot && typeof snapshot === "object" ? snapshot : null;
    lastSnapshot = snap;
    if (snap && Number.isFinite(num(snap.nowMs))) {
      clockBaseMs = num(snap.nowMs);
      clockBasePerf = perfNow();
      nowRef = clockBaseMs;
    }
    renderStats(snap, info);
    if (selectedKey) refreshDetailFromSnapshot();
  }

  /** เรียกทุกเฟรม — ห้ามสร้าง DOM ใหม่ แก้แค่ textContent ของนาฬิกา (throttle 4 ครั้ง/วิ) */
  function tick(dt, nowMs) {
    if (disposed) return;
    const n = num(nowMs);
    nowRef = Number.isFinite(n) ? n : Number.isFinite(clockBaseMs) ? clockBaseMs + (perfNow() - clockBasePerf) : Date.now();
    const d = num(dt);
    timerAcc += Number.isFinite(d) && d > 0 ? d : 0;
    if (timerAcc < TIMER_REFRESH_S) return;
    timerAcc = 0;
    if (selectedKey && detail) {
      updateTimers(false);
      renderCaption();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    if (cueTimer !== null) clearTimeout(cueTimer);
    if (meterResetTimer !== null) clearTimeout(meterResetTimer);
    cueTimer = null;
    meterResetTimer = null;
    for (const id of toastTimers) clearTimeout(id);
    toastTimers.clear();
    roomRows.clear();
    panelTimers = [];
    detail = null;
    lastSnapshot = null;
    if (hudEl.parentNode) hudEl.parentNode.removeChild(hudEl);
  }

  /*
   * ห่อทุกเมธอดสาธารณะด้วย try/catch — ลูปหลักของ main.js เรียก tick()/update() ทุกเฟรม ถ้าข้อมูล
   * รูปร่างแปลกทำให้ HUD โยน error ออกไป ลูปทั้งหน้า (รวมฉากตัวละคร) จะตายตาม
   */
  function guard(name, fn) {
    return (...args) => {
      if (disposed && name !== "dispose") return undefined;
      try {
        return fn(...args);
      } catch (err) {
        console.error(`[pixel/hud] ${name}() throw`, err);
        return undefined;
      }
    };
  }

  return {
    update: guard("update", update),
    setConnected: guard("setConnected", setConnected),
    pushFeed: guard("pushFeed", pushFeed),
    setSelected: guard("setSelected", setSelected),
    tick: guard("tick", tick),
    setVoiceState: guard("setVoiceState", setVoiceState),
    setVoiceVisual: guard("setVoiceVisual", setVoiceVisual),
    toast: guard("toast", toast),
    setZoom: guard("setZoom", setZoom),
    setRooms: guard("setRooms", setRooms),
    setAttention: guard("setAttention", setAttention),
    showEmpty: guard("showEmpty", showEmpty),
    dispose: guard("dispose", dispose),
    get selected() {
      return selectedKey;
    },
    get captions() {
      return captionMode;
    },
  };
}
