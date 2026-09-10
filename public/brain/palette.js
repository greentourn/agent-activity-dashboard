/*
 * palette.js — ศูนย์รวม "สี + โทนอารมณ์" ของ visualizer สมอง AI
 *
 * ทำไมต้องแยกไฟล์: สีถูกใช้ใน 3 ที่ที่ไม่เห็นกัน — shader (ต้องเป็น THREE.Color/vec3),
 * HUD (ต้องเป็น CSS string) และ logic ตัดสินอารมณ์ (mood) ถ้าปล่อยให้แต่ละไฟล์นิยามเอง
 * สีของ node กับสีของแถวใน HUD จะเพี้ยนกันทันทีที่แก้ที่เดียว
 *
 * โทนหลัก: cyan/violet บนพื้นดำ — สื่อ "ปัญญาประดิษฐ์" มากกว่าเขียว-เมทริกซ์แบบเดิม ๆ
 */

import * as THREE from "three";

/* สีตามโมเดล — ล้อกับ index.html เดิม (--m-ha/so/op/fa) เพื่อให้คนที่ชินหน้าเก่าอ่านออกทันที */
export const MODEL_HEX = {
  HA: 0x7ee787, // haiku — เขียว
  SO: 0x79c0ff, // sonnet — ฟ้า
  OP: 0xd2a8ff, // opus — ม่วง
  FA: 0xffa657, // fable — ส้ม
  "": 0x8b949e, // ไม่รู้จัก — เทา
};

/*
 * สีตามสถานะของ session (status.state จาก server)
 * - idle     = ฟ้าเย็น "หลับตื้น ๆ รอคำสั่ง"
 * - thinking = ม่วง "พลังงานหมุนเข้าใน"
 * - tool     = ฟ้าสว่าง "ยิงพลังงานออก"
 * - waiting  = เหลืองอำพัน "ค้างรออนุญาต"
 * - blocked  = แดง "ถูกปฏิเสธ"
 */
export const STATE_HEX = {
  idle: 0x3fb7d6,
  thinking: 0xa371f7,
  tool: 0x58d3ff,
  waiting: 0xe3b341,
  blocked: 0xff6b6b,
  unknown: 0x6e7681,
};

/* สีเชิงความหมายที่ใช้ร่วมกันทั้งฉากและ HUD */
export const SEMANTIC_HEX = {
  core: 0x66e0ff,
  coreDeep: 0x2b6cff,
  spawn: 0x00ffc8,
  ok: 0x3fb950,
  bad: 0xf85149,
  deny: 0xff8c42,
  dim: 0x30363d,
  white: 0xeaf6ff,
};

/* แคช THREE.Color ไว้ เพราะ new THREE.Color() ทุกเฟรมคือขยะ GC ฟรี ๆ */
const cache = new Map();

/** แปลงเลขฐาน 16 → THREE.Color (อินสแตนซ์ที่ใช้ร่วมกัน ห้ามแก้ค่าในที่) */
export function color(hex) {
  let c = cache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    cache.set(hex, c);
  }
  return c;
}

/** สีของโมเดล — รับ modelTag ("HA"/"SO"/"OP"/"FA") หรือชื่อโมเดลเต็มก็ได้ */
export function modelColor(tag) {
  if (!tag) return color(MODEL_HEX[""]);
  const key = String(tag).toUpperCase();
  if (MODEL_HEX[key] !== undefined) return color(MODEL_HEX[key]);
  const lower = String(tag).toLowerCase();
  if (lower.includes("haiku")) return color(MODEL_HEX.HA);
  if (lower.includes("sonnet")) return color(MODEL_HEX.SO);
  if (lower.includes("opus")) return color(MODEL_HEX.OP);
  if (lower.includes("fable")) return color(MODEL_HEX.FA);
  return color(MODEL_HEX[""]);
}

/** สีของสถานะ session */
export function stateColor(state) {
  return color(STATE_HEX[state] !== undefined ? STATE_HEX[state] : STATE_HEX.unknown);
}

/** สีตามผลลัพธ์ของ sub-agent ที่จบแล้ว */
export function outcomeColor(outcome) {
  if (!outcome || outcome === "ok") return color(SEMANTIC_HEX.ok);
  if (outcome === "failed" || outcome === "error") return color(SEMANTIC_HEX.bad);
  if (outcome === "killed") return color(SEMANTIC_HEX.deny);
  return color(SEMANTIC_HEX.dim);
}

/** hex → "#rrggbb" สำหรับฝั่ง DOM */
export function css(hex) {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

/*
 * moodFromSnapshot — แปลง snapshot ทั้งก้อนให้เหลือ "อารมณ์เดียว" ที่ฉากใช้ขับ animation
 *
 * ลำดับความสำคัญตั้งใจให้เหตุการณ์ที่ผู้ใช้ต้อง "รู้ทันที" ชนะเสมอ:
 *   blocked > waiting > spawning > tool > thinking > idle
 * (ของที่ผิดปกติต้องเด้ง ไม่ใช่ถูกกลบด้วยงานปกติที่วิ่งพร้อมกัน)
 */
export function moodFromSnapshot(snapshot, opts = {}) {
  if (!snapshot || !Array.isArray(snapshot.agents)) return "idle";
  const spawnRecent = opts.spawnRecent || 0; // วินาทีตั้งแต่ spawn ครั้งล่าสุด
  let blocked = 0;
  let waiting = 0;
  let tool = 0;
  let thinking = 0;
  for (const a of snapshot.agents) {
    if (!a || !a.alive || !a.status) continue;
    const s = a.status.state;
    if (s === "blocked") blocked += 1;
    else if (s === "waiting") waiting += 1;
    else if (s === "tool") tool += 1;
    else if (s === "thinking") thinking += 1;
  }
  if (blocked > 0) return "blocked";
  if (waiting > 0) return "waiting";
  if (spawnRecent > 0 && spawnRecent < 2.2) return "spawning";
  if (tool > 0) return "tool";
  if (thinking > 0) return "thinking";
  return "idle";
}

/*
 * activityFromSnapshot — ระดับความยุ่ง 0..1 ที่ทุกระบบ (สมอง/ฉากหลัง/HUD) ใช้ร่วมกัน
 *
 * ผสมจาก 3 แหล่งที่โตคนละอัตรา แล้วบีบด้วย log เพราะ 40 sub-agent ไม่ควรทำให้จอ "แดงหมด"
 * ตั้งแต่ตัวที่ 5 — ต้องยังเห็นความต่างระหว่าง 5 กับ 40 ได้
 */
export function activityFromSnapshot(snapshot) {
  if (!snapshot || !snapshot.totals) return 0;
  const t = snapshot.totals;
  const subs = Math.log2(1 + (t.subsRunning || 0)) / Math.log2(1 + 32);
  const tools = Math.log2(1 + (t.toolsRunning || 0)) / Math.log2(1 + 12);
  const busy = (t.busy || 0) / Math.max(1, t.live || 1);
  const raw = subs * 0.5 + tools * 0.3 + busy * 0.2;
  return Math.max(0, Math.min(1, raw));
}

/** ป้ายอารมณ์ภาษาไทย (HUD ใช้ตัวนี้ ห้ามแปลซ้ำที่อื่น) */
export const MOOD_LABEL = {
  idle: "รอคำสั่ง",
  thinking: "กำลังคิด",
  tool: "กำลังเรียกเครื่องมือ",
  waiting: "รออนุญาต",
  blocked: "ถูกบล็อก",
  spawning: "กำลังแตก agent",
};
