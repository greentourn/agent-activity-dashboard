/*
 * main.js — ตัวประกอบทั้งหมดของหน้า "NEURAL CORE"
 *
 * หน้าที่ของไฟล์นี้มีสามอย่างเท่านั้น:
 *   1. ตั้งฉาก (renderer / camera / โมดูลภาพทั้งหมด)
 *   2. แปลง "ข้อมูลดิบจาก server" ให้เป็น "บริบท" ที่ทุกโมดูลเข้าใจตรงกัน (ctx)
 *   3. ต่อสายเหตุการณ์จาก store ไปยังแอนิเมชันที่เหมาะกับเหตุการณ์นั้น
 *
 * ตรรกะภาพทั้งหมดอยู่ในโมดูลของมันเอง — ที่นี่ไม่มีการคำนวณรูปทรงหรือสีเลย
 * เพื่อให้เพิ่ม "ปฏิกิริยาต่อเหตุการณ์ใหม่" ได้โดยแก้ที่เดียว
 */

import * as THREE from "three";
import { createStore } from "./store.js";
import { createControls } from "./controls.js";
import { createBloom } from "./fx/bloom.js";
import { createStarfield } from "./starfield.js";
import { createBrainCore } from "./core.js";
import { createAgentField } from "./agents.js";
import { createHud } from "./hud.js";
import { createFixture } from "./fixture.js";
import {
  MOOD_LABEL,
  SEMANTIC_HEX,
  activityFromSnapshot,
  moodFromSnapshot,
  outcomeColor,
  stateColor,
} from "./palette.js";

const params = new URLSearchParams(location.search);
const fixtureParam = params.get("fixture");
const qualityParam = params.get("quality");

/* ───────────────────────── เวที ───────────────────────── */

const canvas = document.getElementById("stage");
const hudRoot = document.getElementById("hud");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false, // bloom กลบขอบหยักอยู่แล้ว — เปิด MSAA ด้วยคือจ่ายฟรี
  alpha: false,
  powerPreference: "high-performance",
  stencil: false,
});
renderer.setClearColor(0x03060d, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x03060d, 0.0075);

const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 600);
camera.position.set(0, 8, 46);

/* คุณภาพเริ่มต้น: เดาจากจอ/หน่วยความจำ แล้วปรับอัตโนมัติภายหลังตาม fps จริง */
function guessQuality() {
  if (qualityParam && ["low", "medium", "high"].includes(qualityParam)) return qualityParam;
  const mem = navigator.deviceMemory || 8;
  const px = window.innerWidth * window.innerHeight * Math.min(2, window.devicePixelRatio || 1);
  if (mem <= 4 || px > 4.6e6) return "medium";
  return "high";
}
let quality = guessQuality();

const brain = createBrainCore({ radius: 5.2, quality });
scene.add(brain.group);

const field = createAgentField({ coreRadius: 5.2, quality, sessionOrbit: 13.5 });
scene.add(field.group);

const stars = createStarfield({ radius: 120 });
stars.setQuality(quality);
/* ฉากหลังต้องเป็น "บรรยากาศ" ไม่ใช่ตัวเอก — ค่าเต็มกลบสมองจนหมดตอนทดสอบจริง */
stars.setIntensity(0.30);
scene.add(stars.group);

const bloom = createBloom(renderer, scene, camera, {
  strength: 0.55,
  threshold: 0.80,
  knee: 0.30,
  radius: 1.0,
  levels: 4,
  vignette: 0.45,
  grain: 0.03,
  chromatic: 0.0015,
});
bloom.setQuality(quality);

/*
 * เคารพ prefers-reduced-motion: หน้านี้เคลื่อนไหวตลอดเวลาโดยตั้งใจ ซึ่งเป็นปัญหาจริงกับคนที่
 * เวียนหัวกับภาพเคลื่อนไหว — จึงหรี่ความเร็วลงครึ่งหนึ่งและปิดการหมุนกล้องอัตโนมัติ
 * (ไม่หยุดสนิท เพราะ "ยังมีชีวิต" คือหน้าที่หลักของหน้านี้ แค่ทำให้ไม่กวนตา)
 */
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const controls = createControls(camera, canvas, {
  target: new THREE.Vector3(0, 0, 0),
  distance: 46,
  minDistance: 8,
  maxDistance: 220,
  /*
   * ปิดการหมุนกล้องอัตโนมัติเป็นค่าเริ่มต้น (คำสั่งผู้ใช้ 2026-09-09: "พื้นหลังขยับแล้วเวียนหัว
   * ไม่รู้ว่ามันขยับเพราะอะไร") กล้องที่หมุนเองลากดาวทั้งฉากไหลตลอดเวลาโดยไม่สื่ออะไรเลย
   * การเคลื่อนไหวที่มีความหมายถูกย้ายไปไว้ที่ตัวสมองแทน (core.js หมุน/หายใจของมันเอง)
   * ใครอยากได้กล้องหมุน กดปุ่ม "หมุนอัตโนมัติ" ที่มุมล่างขวาได้ตลอด
   */
  autoRotate: false,
  autoRotateSpeed: 0.035,
});

/* ───────────────────────── บริบทที่ทุกโมดูลใช้ร่วมกัน ───────────────────────── */

const ctx = {
  time: 0,
  activity: 0,
  mood: "idle",
  pulse: 0,
  fps: 60,
  quality,
  connected: false,
  cameraPos: camera.position,
};

let spawnRecent = 999; // วินาทีตั้งแต่ spawn ครั้งล่าสุด — ใช้ตัดสิน mood "กำลังแตก agent"
let lastSnapshot = null;
/* เวลาที่จะจัดกรอบกล้องครั้งแรก (-1 = ยังไม่มีข้อมูลเข้ามาเลย) — ดู "กฎของกล้อง" ในลูปหลัก */
let initialFitAt = -1;
let initialFitDone = false;

/* ───────────────────────── ข้อมูล ───────────────────────── */

const fixtureMode = fixtureParam !== null;
let fixture = null;
if (fixtureMode) {
  const scenario = ["idle", "thinking", "storm", "cascade", "errors", "auto"].includes(fixtureParam)
    ? fixtureParam
    : "auto";
  fixture = createFixture({ sessions: 2, scenario, speed: 1 });
}

const store = createStore({
  url: "/api/stream",
  stateUrl: "/api/state",
  fixture: fixture ? () => fixture.next() : null,
});

/* ───────────────────────── HUD ───────────────────────── */

let activityAudio = null;

const hud = createHud(hudRoot, {
  fixtureMode,
  onSelect: (key) => selectNode(key, { focus: false }),
  onCommand: (name, value) => {
    if (name === "quality") applyQuality(value);
    else if (name === "autorotate") controls.autoRotate = !!value;
    else if (name === "reset") {
      /* ปุ่มนี้คือทางเดียวที่กล้องจะ "ซูมเข้า" ได้ — จัดกรอบให้พอดีดงปัจจุบัน แล้วเล็งกลับมาที่สมอง */
      controls.reset();
      selectNode(null);
      fitDistance = fitDistanceFor();
      controls.distance = fitDistance;
    } else if (name === "focus") selectNode(value, { focus: true });
    else if (name === "voice" && activityAudio) {
      const state = activityAudio.setEnabled(!!value, { userGesture: true, preview: true });
      hud.setVoiceState(state);
    }
    else if (name === "scenario" && fixture) {
      fixture.setScenario(value);
      hud.toast(`สลับสถานการณ์: ${value}`, "info");
    } else if (name === "panel" && !value) selectNode(null);
  },
});

function applyQuality(level) {
  if (!["low", "medium", "high"].includes(level) || level === quality) return;
  quality = level;
  ctx.quality = level;
  brain.setQuality(level);
  field.setQuality(level);
  stars.setQuality(level);
  bloom.setQuality(level);
  resize();
  hud.toast(`คุณภาพภาพ: ${level.toUpperCase()}`, "info");
}

/* ───────────────────────── การเลือกโหนด ───────────────────────── */

const focusTarget = new THREE.Vector3();

function selectNode(key, { focus = false } = {}) {
  field.setSelected(key);
  hud.setSelected(key);
  if (key && focus) {
    const pos = field.getPosition(key, focusTarget);
    if (pos) controls.focusOn(pos, Math.max(12, controls.distance * 0.75));
  }
  if (!key) controls.setTarget(new THREE.Vector3(0, 0, 0));
}

/* ───────────────────────── เหตุการณ์ → แอนิเมชัน ───────────────────────── */

/*
 * ตารางนี้คือหัวใจของโจทย์ "animation ต่างกันตามบริบท":
 * แต่ละเหตุการณ์จาก transcript จริงถูกแปลเป็นการกระตุ้นภาพคนละแบบ
 * (คลื่นสี / แสงวาบที่โหนด / สายที่งอก / ระดับตื่นตัวของสมอง)
 */
function bumpPulse(v) {
  ctx.pulse = Math.min(1.5, ctx.pulse + v);
}

/*
 * เสียงพูดขับเฉพาะ HUD กับก้อนสมองตรงกลาง ไม่แตะ controls/stars/calmCtx เลย
 * จึงเห็นจังหวะคำพูดได้โดยไม่ทำให้กล้องหรือฉากหลังไหลตามเสียง
 */
function voiceVisualHex(kind) {
  if (kind === "error" || kind === "blocked") return SEMANTIC_HEX.bad;
  if (kind === "denied") return SEMANTIC_HEX.deny;
  if (kind === "spawn") return SEMANTIC_HEX.spawn;
  if (kind === "finish" || kind === "tool-end" || kind === "session-end") return SEMANTIC_HEX.ok;
  if (kind === "prompt" || kind === "say") return SEMANTIC_HEX.white;
  return SEMANTIC_HEX.core;
}

function syncVoiceVisual(frame) {
  hud.setVoiceVisual(frame);
  if (!frame || !frame.phase) return;
  const level = Math.max(0, Math.min(1, Number(frame.level) || 0));
  if (frame.phase === "cue") {
    brain.excite(0.12 + level * 0.16);
    field.toolStart({ sessionId: frame.sessionId, agentId: frame.agentId });
    field.surge(0.12 + level * 0.12);
    brain.shockwave({
      hex: voiceVisualHex(frame.kind),
      strength: 0.28 + level * 0.26,
      reach: 1.65 + level * 0.45,
      speed: 1.45,
    });
  } else if (frame.phase === "start" || frame.phase === "boundary") {
    brain.excite(0.07 + level * 0.11);
    field.toolStart({ sessionId: frame.sessionId, agentId: frame.agentId });
  } else if (frame.phase === "frame") {
    brain.excite(0.012 + level * 0.022);
    /* ต่ออายุแสงของโหนดต้นทางตลอดช่วงพูด; หยุดเองทันทีเมื่อ engine เลิกส่ง frame */
    field.toolStart({ sessionId: frame.sessionId, agentId: frame.agentId });
  }
}

const activityAudioApi = globalThis.AgentActivityAudio;
if (activityAudioApi && typeof activityAudioApi.create === "function") {
  activityAudio = activityAudioApi.create({
    onState: (state) => hud.setVoiceState(state),
    onVisual: syncVoiceVisual,
  });
  hud.setVoiceState(activityAudio.getState());
} else {
  hud.setVoiceState({ enabled: false, speaking: false, level: 0, supported: false });
}

store.on("connect", () => {
  ctx.connected = true;
  hud.setConnected(true);
  hud.pushFeed({ kind: "sys", text: "เชื่อมต่อสตรีมแล้ว", tone: "good", ts: Date.now() });
  brain.shockwave({ hex: SEMANTIC_HEX.core, strength: 0.9, reach: 3.4 });
  field.surge(0.9);
});

store.on("disconnect", () => {
  ctx.connected = false;
  hud.setConnected(false);
  hud.pushFeed({ kind: "sys", text: "สตรีมหลุด — กำลังเชื่อมใหม่", tone: "bad", ts: Date.now() });
});

store.on("snapshot", (snapshot, meta) => {
  lastSnapshot = snapshot;
  /* engine ใช้เฟรมแรกเป็น baseline แบบเงียบ แล้ว diff ทุก snapshot ถัดไปเพื่อส่งเสียงทุก event ใหม่ */
  if (activityAudio) activityAudio.ingest(snapshot);
  field.syncSnapshot(snapshot, { silent: meta && meta.first });
  hud.update(snapshot, ctx);
  /* นัดจัดกรอบกล้อง "ครั้งเดียวในชีวิตของหน้านี้" หลังข้อมูลชุดแรกมาถึงและโหนดวิ่งเข้าที่แล้ว
     — ระยะเริ่มต้น 46 หน่วยไม่มีทางรู้ล่วงหน้าว่าดงจริงใหญ่แค่ไหน */
  if (initialFitAt < 0) initialFitAt = ctx.time + 1.2;
  if (meta && meta.first) {
    hud.pushFeed({
      kind: "sys",
      text: `โหลดสถานะแรก: ${snapshot.agents.length} session · ${snapshot.totals.subsTotal} sub-agent`,
      tone: "info",
      ts: Date.now(),
    });
  }
});

store.on("spawn", ({ sessionId, sub, batchIndex, batchSize }) => {
  field.spawn({ sessionId, sub, batchIndex });
  spawnRecent = 0;
  brain.excite(0.35);
  bumpPulse(0.35);
  /* ชุดใหญ่ = คลื่นเดียวที่แรงกว่า ไม่ใช่ 40 คลื่นซ้อนกันจนจอขาว */
  if (batchIndex === 0) {
    field.surge(Math.min(1.3, 0.75 + batchSize * 0.05));
    brain.shockwave({
      hex: SEMANTIC_HEX.spawn,
      strength: Math.min(1.6, 0.7 + batchSize * 0.06),
      reach: 3.0 + Math.min(2.5, batchSize * 0.08),
      speed: 1.15,
    });
    hud.pushFeed({
      kind: "spawn",
      text:
        batchSize > 1
          ? `แตก ${batchSize} agent: ${sub.type || "agent"} …`
          : `แตก agent: ${sub.type || "agent"} — ${sub.label || sub.task || ""}`,
      tone: "spawn",
      ts: Date.now(),
    });
  }
});

store.on("finish", ({ sessionId, sub, ok }) => {
  field.finish({ sessionId, sub });
  brain.excite(0.2);
  field.surge(0.5);
  bumpPulse(0.2);
  hud.pushFeed({
    kind: "finish",
    text: `${sub.type || "agent"} จบ — ${ok ? "สำเร็จ" : sub.outcome || "ล้มเหลว"} · ${sub.tools || 0} tool`,
    tone: ok ? "good" : "bad",
    ts: Date.now(),
  });
  if (!ok) brain.shockwave({ hex: SEMANTIC_HEX.bad, strength: 1.0, reach: 2.6 });
});

store.on("tool-start", (e) => {
  field.toolStart(e);
  brain.excite(0.12);
  field.surge(0.22);
});

store.on("tool-end", (e) => {
  field.toolEnd(e);
  if (e.error) {
    bumpPulse(0.3);
    field.surge(0.7);
    brain.shockwave({ hex: SEMANTIC_HEX.bad, strength: 0.7, reach: 2.2 });
  }
});

store.on("state", ({ sessionId, from, to }) => {
  /* การเปลี่ยนสถานะของ session คือ "จังหวะหายใจ" ของทั้งฉาก — ยิงคลื่นสีของสถานะใหม่ */
  brain.shockwave({ hex: stateColor(to).getHex(), strength: 0.55, reach: 2.4, speed: 1.2 });
  field.surge(0.45);
  bumpPulse(0.15);
  if (to === "blocked" || to === "waiting") {
    hud.pushFeed({
      kind: "state",
      text: `${sessionId.slice(0, 8)} → ${MOOD_LABEL[to] || to}`,
      tone: to === "blocked" ? "bad" : "warn",
      ts: Date.now(),
    });
  }
});

store.on("denied", () => {
  bumpPulse(0.6);
  brain.excite(0.8);
  field.surge(1.2);
  brain.shockwave({ hex: SEMANTIC_HEX.deny, strength: 1.3, reach: 3.2 });
});

store.on("error", () => {
  bumpPulse(0.4);
  brain.excite(0.5);
  field.surge(0.6);
});

store.on("event", ({ sessionId, event }) => {
  if (!event) return;
  /* ฟีดข้อความ: เอาเฉพาะชนิดที่คนอ่านแล้วได้ความ ไม่ยัด tool ทุกตัวจนล้น */
  if (event.kind === "prompt") {
    hud.pushFeed({ kind: "prompt", text: `คำสั่งใหม่: ${event.text || ""}`, tone: "info", ts: Date.now() });
    brain.shockwave({ hex: SEMANTIC_HEX.white, strength: 1.2, reach: 3.6, speed: 1.3 });
    brain.excite(1.0);
    field.surge(1.3);
    bumpPulse(0.8);
  } else if (event.kind === "denied") {
    hud.pushFeed({
      kind: "denied",
      text: `${event.denyKind || "deny"} · ${event.denyLabel || event.text || ""}`,
      tone: "bad",
      ts: Date.now(),
    });
  } else if (event.kind === "error") {
    hud.pushFeed({ kind: "error", text: event.text || "error", tone: "bad", ts: Date.now() });
  } else if (event.kind === "blocked") {
    hud.pushFeed({ kind: "blocked", text: event.text || "ถูกบล็อก", tone: "warn", ts: Date.now() });
  }
});

/* ───────────────────────── เมาส์: ชี้ / คลิก ───────────────────────── */

const ndc = new THREE.Vector2();
const viewport = { width: 1, height: 1 };
let pointerMoved = 0;
let downAt = null;

canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  viewport.width = rect.width;
  viewport.height = rect.height;
  if (downAt) pointerMoved += Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
});

canvas.addEventListener("pointerdown", (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  pointerMoved = 0;
});

canvas.addEventListener("pointerup", () => {
  /* ลากเพื่อหมุนกล้อง ≠ คลิกเพื่อเลือก — แยกด้วยระยะที่เมาส์เคลื่อนระหว่างกด */
  if (pointerMoved < 6) {
    const hit = field.pick(ndc, camera, viewport);
    selectNode(hit ? hit.key : null, { focus: !!hit });
    if (hit) brain.excite(0.25);
  }
  downAt = null;
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") selectNode(null);
  else if (e.key === " ") {
    const target = e.target;
    if (
      target &&
      typeof target.closest === "function" &&
      target.closest("button, input, select, textarea, a, [contenteditable='true']")
    ) {
      return;
    }
    controls.autoRotate = !controls.autoRotate;
    e.preventDefault();
  }
});

/* ───────────────────────── ขนาดจอ ───────────────────────── */

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  /* จำกัด DPR ที่ 2 และลดลงอีกเมื่อคุณภาพต่ำ — ค่าตัวนี้คือปุ่มที่ได้ fps กลับมามากที่สุด */
  const dprCap = quality === "low" ? 1 : quality === "medium" ? 1.5 : 2;
  const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  bloom.setSize(w, h, dpr);
  brain.setPixelRatio(dpr);
  field.setPixelRatio(dpr);
  viewport.width = w;
  viewport.height = h;
}
window.addEventListener("resize", resize);
resize();

/* ───────────────────────── ลูปหลัก ───────────────────────── */

let last = performance.now();
let booted = false;
let overflowTimer = 0;
let overflowWarnedAt = -999;
let fitDistance = 46;
/*
 * ระยะกล้องที่ทำให้โหนดไกลสุดยังอยู่ในกรอบ — คิดจาก fov แนวตั้งจริง ไม่ใช่ตัวคูณที่เดาเอา
 * (แนวตั้งแคบกว่าแนวนอนบนจอ 16:9 จึงใช้เป็นตัวตัดสินได้อย่างปลอดภัย)
 */
function fitDistanceFor(margin = 1.12, percentile = 0.9) {
  const radii = [];
  for (const node of field.nodes.values()) radii.push(node.pos.length());
  if (!radii.length) return 46;
  radii.sort((a, b) => a - b);
  /*
   * ใช้เปอร์เซ็นไทล์ที่ 90 ไม่ใช่ค่าสูงสุด: โหนดตัวเดียวที่แกว่งออกไปไกลกว่าเพื่อนไม่ควรมีอำนาจ
   * สั่งให้กล้องทั้งตัวถอย — ยอมให้ราว 10% หลุดขอบจอไปบ้าง ดีกว่าภาพขยับเองบ่อย ๆ
   */
  const far = Math.max(10, radii[Math.min(radii.length - 1, Math.floor(radii.length * percentile))]);
  const halfFov = (camera.fov * Math.PI) / 360;
  return Math.max(26, Math.min(200, (far * margin) / Math.tan(halfFov)));
}

/*
 * ฉากหลังเดินด้วย "นาฬิกาของตัวเอง" — ไหลเรื่อย ๆ ช้า ๆ ได้ แต่ **ไม่รับรู้เหตุการณ์เลย**
 *
 * คำสั่งผู้ใช้ 2026-09-10 (ข้อความที่สอง): *"พื้นหลังเคลื่อนไหวได้ แต่ไม่ได้ให้เคลื่อนไหวตาม event
 * เฉย ๆ"* ⇒ สิ่งที่ต้องตัดคือ **การผูกกับเหตุการณ์** ไม่ใช่ตัวการเคลื่อนไหว
 * จึงคง `BG_MOTION` ไว้ที่ 0.55 (ไหลนุ่ม ๆ เห็นได้ว่ามีชีวิต) แต่ตรึง `activity`/`pulse` ไว้ที่ 0
 * และตรึง mood ไว้ที่ idle ⇒ ฉากหลังเดินสม่ำเสมอตลอดกาล ไม่เร่งไม่กระตุกตอน agent แตกหรือ error
 *
 * รอบที่แล้ว (2026-09-09) ตั้งใจหรี่ฉากหลังไว้แล้ว แต่หรี่ไม่ติด เพราะหรี่แค่ `dt` ที่ส่งเข้าไป
 * ขณะที่ shader ของฝุ่น/กริด/เนบิวลา/ละอองทุกตัวอ่าน `state.time` ซึ่งรับ `ctx.time` มาเต็มความเร็ว
 * ⇒ มีแค่การหมุนของชั้นฝุ่นเท่านั้นที่ช้าลงจริง ที่เหลือวิ่งเท่าเดิมทั้งหมด
 * รอบนี้จึงใช้ตัวคูณตัวเดียวคุมทั้งเวลาและ dt ให้ตรงกันจริง ๆ
 */
const BG_MOTION = 0.55;
let bgTime = 0;
const calmCtx = { time: 0, activity: 0, mood: "idle", pulse: 0, cameraPos: camera.position };
let fpsAccum = 0;
let fpsFrames = 0;
let fpsTimer = 0;
let autoDownshiftDone = false;
let truncationWarned = false;

function frame(now) {
  requestAnimationFrame(frame);
  /* หนีบ dt กัน "กระโดด" ตอนสลับแท็บกลับมา (dt 10 วิ = ทุกอย่างพุ่งข้ามฉาก) */
  const rawDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const dt = reduceMotion ? rawDt * 0.45 : rawDt;

  ctx.time += dt;
  spawnRecent += dt;
  ctx.pulse = Math.max(0, ctx.pulse - dt * 1.4);

  /* บริบทจาก snapshot ล่าสุด — ค่อย ๆ ไล่ตามเพื่อไม่ให้ภาพกระตุกทุก 700ms ที่เฟรมใหม่มา */
  const targetActivity = activityFromSnapshot(lastSnapshot);
  ctx.activity += (targetActivity - ctx.activity) * Math.min(1, dt * 2.2);
  ctx.mood = moodFromSnapshot(lastSnapshot, { spawnRecent });
  if (!ctx.connected && lastSnapshot === null) ctx.mood = "idle";

  /*
   * กฎของกล้อง (เขียนใหม่ทั้งข้อ 2026-09-10 — คำสั่งผู้ใช้ "กล้อง … ยังเคลื่อนไหวไม่หยุดเลย
   * เวลามี event"): กล้อง **ไม่ตอบสนองเหตุการณ์เลย** มีสามอย่างเท่านั้นที่ขยับกล้องได้ —
   *   1. มือของคนดู (ลาก/ซูม)
   *   2. ปุ่ม "รีเซ็ตกล้อง" และการโฟกัสโหนดที่คลิกเลือก
   *   3. การจัดกรอบ **ครั้งเดียว** ตอนข้อมูลชุดแรกลงตัว — เพราะระยะเริ่มต้น 46 หน่วยไม่มีทาง
   *      รู้ล่วงหน้าว่าดงจริงของ session นี้ใหญ่แค่ไหน
   * รอบก่อนยังเหลือ "กล้องคืบถอยเองเมื่อดงล้นกรอบ" ไว้ ซึ่งพอ agent แตกเป็นชุด ๆ ดงก็โตทุกไม่กี่
   * วินาที ⇒ กล้องคืบออกแทบตลอดเวลา = ภาพทั้งจอไหลตามเหตุการณ์ ซึ่งคือสิ่งที่ผู้ใช้ไม่เอา
   */
  if (!initialFitDone && initialFitAt >= 0 && ctx.time >= initialFitAt) {
    initialFitDone = true;
    if (!controls.isUserInteracting && !field.selected) {
      fitDistance = fitDistanceFor();
      controls.distance = fitDistance;
    }
  }

  /*
   * ดงล้นกรอบแล้วทำยังไง: **บอกให้คนกดเอง** ไม่ใช่ขยับกล้องให้
   * เตือนเมื่อล้นเกิน 35% และไม่ถี่กว่า 45 วินาทีต่อครั้ง — ไม่งั้น toast จะกลายเป็นสิ่งรบกวนใหม่
   */
  overflowTimer += dt;
  if (overflowTimer > 2) {
    overflowTimer = 0;
    const overflowing = initialFitDone && fitDistanceFor() > controls.distance * 1.35;
    if (overflowing && ctx.time - overflowWarnedAt > 45) {
      overflowWarnedAt = ctx.time;
      hud.toast('ดงโหนดล้นกรอบแล้ว — กด "รีเซ็ตกล้อง" เพื่อจัดกรอบใหม่', "info");
    }
  }

  controls.update(dt);
  /*
   * ฉากหลังกินบริบทฉบับ "สงบ" ที่ตัดขาดจากเหตุการณ์จริง ๆ: pulse = 0 · activity = 0 · mood ตรึงที่
   * idle — มันยังไหลของมันเรื่อย ๆ ตามนาฬิกา BG_MOTION แต่จะไหลเท่าเดิมเสมอ
   * เหตุผล: ฝุ่น/กริด/เนบิวลา/ละอองกินพื้นที่จอเกือบทั้งหมด พอมันเร่งตามงานที่วิ่งอยู่ ทั้งจอจึงกวนตา
   * โดยไม่ได้บอกอะไรที่อ่านออก — ข้อมูลเดียวกันนี้ถูกเล่าที่สมองและที่สายซึ่งอยู่ในโฟกัสอยู่แล้ว
   */
  bgTime += dt * BG_MOTION;
  calmCtx.time = bgTime;
  calmCtx.activity = 0;
  calmCtx.cameraPos = ctx.cameraPos;
  stars.update(dt * BG_MOTION, calmCtx);
  brain.update(dt, ctx);
  field.update(dt, ctx);
  hud.tick(dt, ctx);

  bloom.render(dt);

  /* บอกจอโหลดใน brain.html ว่าเฟรมแรกออกจริงแล้ว (ถ้าไม่เรียก จอโหลดจะค้างและถือว่าพัง) */
  if (!booted) {
    booted = true;
    if (typeof window.__bootReady === "function") window.__bootReady();
  }

  /* วัด fps จริงแล้วลดคุณภาพให้อัตโนมัติ 1 ครั้ง ถ้าเครื่องตามไม่ไหว */
  fpsAccum += dt;
  fpsFrames += 1;
  fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    const fps = fpsFrames / fpsAccum;
    ctx.fps = fps;
    hud.setFps(fps);
    fpsAccum = 0;
    fpsFrames = 0;
    fpsTimer = 0;
    /* เตือนครั้งเดียวถ้าดงใหญ่เกินเพดานบัฟเฟอร์ — ภาพจะไม่ครบ ต้องบอก ไม่ใช่ตัดเงียบ ๆ */
    if (!truncationWarned && field.truncated > 0) {
      truncationWarned = true;
      hud.toast(`แสดงได้สูงสุด ${field.maxNodes} โหนด — อีก ${field.truncated} ตัวถูกซ่อน`, "warn");
    }
    if (!autoDownshiftDone && ctx.time > 6 && fps < 34 && quality !== "low") {
      autoDownshiftDone = true;
      applyQuality(quality === "high" ? "medium" : "low");
      hud.toast("ลดคุณภาพอัตโนมัติเพื่อรักษาความลื่น", "warn");
    }
  }
}

/* ───────────────────────── เริ่มทำงาน ───────────────────────── */

store.start();
requestAnimationFrame(frame);

if (fixtureMode) {
  hud.toast("โหมดข้อมูลจำลอง — ไม่ได้ต่อกับ session จริง", "warn");
}

/* หยุดเสียง/คิว/ตัวจับเวลาเมื่อเปลี่ยนหน้า ไม่ให้คำพูดตามไปทับหน้า Classic */
function disposeActivityAudio() {
  if (!activityAudio) return;
  activityAudio.dispose();
  activityAudio = null;
  hud.setVoiceState({ enabled: false, speaking: false, level: 0 });
}
window.addEventListener("pagehide", (event) => {
  // A BFCache page resumes without re-running this module. Keep its controller alive, but cancel
  // the current utterance so it cannot talk over the page the user navigated to.
  if (event.persisted) {
    if (activityAudio) activityAudio.cancel("bfcache");
    return;
  }
  disposeActivityAudio();
});

/* เปิดทางให้เปิด DevTools แล้วแกะดูสถานะได้โดยไม่ต้องแก้โค้ด */
window.__neural = {
  store,
  brain,
  field,
  stars,
  bloom,
  controls,
  hud,
  ctx,
  get audio() { return activityAudio; },
  get snapshot() { return lastSnapshot; },
};
