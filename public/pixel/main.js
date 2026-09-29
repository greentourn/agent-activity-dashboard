/*
 * main.js — ตัวต่อสายของหน้า "PIXEL OFFICE"
 *
 * ไฟล์นี้ไม่มีตรรกะภาพหรือตรรกะเนื้อเรื่องของตัวเองเลย มีแค่ "ท่อ":
 *   store (SSE จริง หรือ fixture จำลอง) ──snapshot──▶ world.sync  (ใครอยู่ไหน ทำอะไร)
 *                                         ├───────▶ audio.ingest (เสียงเหตุการณ์ชุดเดียวกับหน้าอื่น)
 *                                         └───────▶ hud.update   (ชิปสรุป/แผงรายละเอียด)
 *   world.onNarrate ──▶ hud.pushFeed      (บรรทัดเล่าเรื่องภาษาไทย)
 *   rAF ──▶ world.update(dt) ──▶ scene.render(dt) ──▶ hud.tick
 *   HUD/scene ──คำสั่งผู้ใช้──▶ ที่นี่ ──▶ กล้อง / การเลือก / เสียง / ฉากทดสอบ
 *
 * กฎกล้อง (คำสั่งผู้ใช้ 2026-09-10 ใน brain/main.js): จัดกรอบอัตโนมัติได้ "ครั้งเดียว" หลังข้อมูลชุดแรก
 *   ที่มีห้อง จากนั้นกล้องขยับเฉพาะตอนผู้ใช้สั่งเท่านั้น ห้องใหม่เกิดนอกจอ → บอกด้วย toast (ห่างกัน ≥45 วิ)
 *   ไม่ใช่เลื่อนกล้องไปหา
 */

import { createStore } from "../brain/store.js";
import { createFixture } from "../brain/fixture.js";
import { createWorld } from "./world.js";
import * as sprites from "./sprites.js";
import { createScene } from "./scene.js";
import { createHud } from "./hud.js";

const SCENARIOS = ["auto", "idle", "thinking", "storm", "cascade", "errors"];
/** ห้องล้นจอ: บอกซ้ำได้ไม่ถี่กว่านี้ — คนที่ตั้งใจซูมดูห้องเดียวไม่ควรโดนเตือนทุกครั้งที่มีห้องใหม่ */
const OFFSCREEN_TOAST_GAP_MS = 45_000;
const MAX_HELPERS_PER_ROOM = 64;

const params = new URLSearchParams(location.search);
const fixtureParam = params.get("fixture");
const fixtureMode = fixtureParam !== null;

function prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (err) {
    return false;
  }
}
/*
 * อ่านครั้งเดียวตอนเปิดหน้า: world ถูกสร้างด้วยค่านี้ (ตัดเอฟเฟกต์ระเบิด/โยกตัว) และสร้างใหม่กลางทางไม่ได้
 * โดยไม่ทิ้งเนื้อเรื่องที่ค้างอยู่ — ใครสลับการตั้งค่าระหว่างเปิดหน้า รีเฟรชหนึ่งครั้งก็ได้ผลครบ
 */
const reduceMotion = prefersReducedMotion();

/** ครอบทุก callback — ขั้นตอนหนึ่งพัง (ข้อมูลรูปร่างแปลก) ต้องไม่ทำให้ลูปวาดหรือสายข้อมูลตายทั้งหน้า */
function guard(where, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`[pixel/main] ${where}`, err);
    return undefined;
  }
}

/* ───────────────────────── เวที ───────────────────────── */

const canvas = document.getElementById("stage");
const hudRoot = document.getElementById("hud");
if (!canvas || typeof canvas.getContext !== "function") throw new Error("ไม่พบ <canvas id=\"stage\"> ในหน้า");

/* ───────────────────────── ข้อมูล ───────────────────────── */

let fixture = null;
if (fixtureMode) {
  const scenario = SCENARIOS.includes(fixtureParam) ? fixtureParam : "auto";
  fixture = createFixture({ sessions: 2, scenario, speed: 1 });
}

const store = createStore({
  url: "/api/stream",
  stateUrl: "/api/state",
  fixture: fixture ? () => fixture.next() : null,
});

const world = createWorld({ reduceMotion, maxHelpersPerRoom: MAX_HELPERS_PER_ROOM });

let lastSnapshot = null;
let activityAudio = null;
/** key ที่เลือกอยู่ + เคยมีตัวละครบนจอไหม (เลือกจากแถวฟีดของคนที่กลับไปแล้วได้ — แผงยังโชว์ข้อมูล snapshot) */
let selectedKey = null;
let selectedHadCharacter = false;
let initialFitDone = false;
let pendingFit = false;
let fitDelay = 0;
/** ผู้ใช้ขยับกล้องเองแล้วหรือยัง (ลาก/ซูม/ปุ่ม/คีย์) — ถ้าใช่ การจัดกรอบอัตโนมัติที่ค้างอยู่ถูกยกเลิก */
let userMovedCamera = false;
let autoFitting = false;
let lastOffscreenToast = -Infinity;
let offscreenSig = "";

/* ───────────────────────── HUD ───────────────────────── */

const hud = createHud(hudRoot, { fixtureMode, onCommand: handleCommand });

/**
 * พื้นที่ที่แผง HUD บังอยู่ (CSS px) — จัดกรอบ/เล็งกล้องให้ของอยู่กลางส่วนที่มองเห็นจริง
 * วัดจาก DOM จริงทุกครั้ง (แถบบนห่อบรรทัดได้ แผงพับ/กางได้ จอแคบเปลี่ยนผังทั้งชุด)
 */
function hudInsets(stable = false) {
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const rectOf = (sel) => {
    const el = hudRoot ? hudRoot.querySelector(sel) : null;
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };
  let top = 0;
  let right = 0;
  let bottom = 0;
  const bar = rectOf(".px-topbar");
  if (bar) top = bar.bottom + 6;
  const narrow = vw <= 760;
  if (!narrow) {
    /* จอกว้าง: คอลัมน์ขวา (เครื่องมือ + รายชื่อห้อง + แผงรายละเอียด) กินพื้นที่ทั้งแนวตั้ง */
    let left = vw;
    for (const sel of [".px-tools", ".px-rooms", ".px-detail"]) {
      const r = rectOf(sel);
      if (r) left = Math.min(left, r.left);
    }
    if (left < vw) right = vw - left + 6;
  } else {
    /* จอแคบ: เครื่องมือ + ปุ่มรายชื่อห้อง (ตอนพับ) เรียงใต้แถบบน — ดันขอบบนลงแทนการกินด้านขวา
       (รายชื่อที่กางอยู่เป็นแผงลอยชั่วคราว ไม่กันที่ให้ ไม่งั้นแค่กางดูก็ทำให้กรอบเล็กลงครึ่งจอ) */
    const tools = rectOf(".px-tools");
    if (tools) top = Math.max(top, tools.bottom + 6);
    const rooms = rectOf(".px-rooms.is-collapsed");
    if (rooms) top = Math.max(top, rooms.bottom + 6);
  }
  /* ฟีดอยู่มุมล่างซ้าย = ตรงที่ห้องแรก (slot 0) เริ่ม — กันพื้นที่ด้านล่างไว้ให้มันเสมอเมื่อกางอยู่
     (scene.js จำกัดแต่ละด้านไม่เกิน 60% ของจอ และยอมล้นลงใต้ฟีดเองถ้าห้องสูงกว่าพื้นที่ที่เหลือ) */
  const feed = rectOf(".px-feed");
  if (feed) bottom = vh - feed.top + 6;
  /* จอแคบ: แผงรายละเอียดเป็น bottom sheet สูงครึ่งจอ — เล็งตัวละครให้อยู่เหนือแผง ไม่ใช่ใต้แผง
     (stable = ขอพื้นที่ "ถาวร" สำหรับจัดผังห้อง — แผงที่เปิด/ปิดตามการเลือกไม่นับ ไม่งั้นแค่คลิกตัวละครห้องก็สลับผัง) */
  const detail = narrow && !stable ? rectOf(".px-detail") : null;
  if (detail) bottom = Math.max(bottom, vh - detail.top + 6);
  return { top, right, bottom, left: 0 };
}

/*
 * ขนาดพื้นที่ที่มองเห็นจริง (device px) → world ใช้เลือกจำนวนคอลัมน์ของผังห้อง (ข้อมูลล้วน world ไม่แตะ DOM)
 * 3–4 ห้องบนจอ 1440×900 จึงเป็น 2×2 ที่พ้นคอลัมน์ขวา · จอแคบเป็นคอลัมน์เดียว
 * ส่งใหม่เฉพาะตอนขนาดหน้าต่าง/แถบบนเปลี่ยน (การผู้ใช้ย่อ/ขยายหน้าต่าง) — ไม่ใช่ตามเหตุการณ์ของข้อมูล
 */
function pushLayoutHint() {
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const d = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
  const ins = hudInsets(true);
  const w = Math.max(64, vw - ins.left - ins.right);
  const h = Math.max(64, vh - ins.top - ins.bottom);
  world.setLayoutHint({ width: Math.round(w * d), height: Math.round(h * d) });
}
guard("layout hint", pushLayoutHint);
let hintTimer = 0;
function scheduleLayoutHint() {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => guard("layout hint", pushLayoutHint), 150);
}

/*
 * กล่องแผง HUD ที่ทับ canvas อยู่จริง (CSS px) — ฉากใช้ตัดสินว่าหัวหน้าห้องที่ "รอคุณ/ติดด่าน" มองเห็นอยู่
 * หรือถูกแผงบัง (ต่างจาก hudInsets ที่เป็นแถบกว้างทั้งด้าน: ตัวละครที่ยืนขวาของฟีดยังมองเห็นอยู่จริง)
 * วัดใหม่ไม่เกินทุก 250 ms — getBoundingClientRect ทุกเฟรมบังคับเบราว์เซอร์คำนวณ layout ใหม่ทุกเฟรม
 */
const OCCLUDER_SELECTORS = [".px-topbar > .px-panel", ".px-tools", ".px-rooms", ".px-detail", ".px-feed", ".px-legend"];
let occluderCache = [];
let occluderAt = -Infinity;
function hudRects() {
  const now = performance.now();
  if (now - occluderAt < 250) return occluderCache;
  occluderAt = now;
  const out = [];
  if (hudRoot) {
    for (const sel of OCCLUDER_SELECTORS) {
      for (const el of hudRoot.querySelectorAll(sel)) {
        if (el.hidden) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }
    }
  }
  occluderCache = out;
  return out;
}

/* ───────────────────────── ฉาก ───────────────────────── */

const scene = createScene(canvas, world, sprites, {
  reduceMotion,
  insets: hudInsets,
  occluders: hudRects,
  onSelect: (key, info) => {
    select(key, { focus: false, source: info && info.source });
    /* แตะเลือกบนจอแคบ: bottom sheet ที่เพิ่งเปิดอาจทับตัวที่แตะ — เลื่อนฉากให้ตัวนั้นอยู่เหนือแผง (ผู้ใช้สั่ง) */
    if (key && info && info.source === "click") requestAnimationFrame(() => guard("keep above sheet", () => keepAboveSheet(key)));
  },
  onCamera: (z) => {
    hud.setZoom(z);
    /* กล้องขยับได้จากผู้ใช้เท่านั้น (ลาก/ซูม/ปุ่ม/คีย์/คลิกเล็ง) ยกเว้นการจัดกรอบอัตโนมัติครั้งแรกเอง */
    if (!autoFitting) userMovedCamera = true;
  },
  onFocusRoom: () => {},
});
hud.setZoom(scene.zoom);

/* ───────────────────────── การเลือกตัวละคร ───────────────────────── */

function parseKey(key) {
  const i = key.indexOf(":");
  return i < 0 ? { sessionId: key, agentId: null } : { sessionId: key.slice(0, i), agentId: key.slice(i + 1) || null };
}

function findSession(snap, sessionId) {
  const list = snap && Array.isArray(snap.agents) ? snap.agents : [];
  for (const s of list) if (s && s.sessionId === sessionId) return s;
  return null;
}

function findSub(session, agentId) {
  const list = session && Array.isArray(session.subagents) ? session.subagents : [];
  for (const s of list) if (s && s.agentId === agentId) return s;
  return null;
}

/** ข้อมูลของแผงรายละเอียด: ของดิบจาก snapshot ล่าสุด + ตัวละครใน world (HUD จัดรูปแบบเอง) */
function detailFor(key) {
  const { sessionId, agentId } = parseKey(key);
  const ch = world.characters.get(key) || null;
  const session = findSession(lastSnapshot, sessionId) || (ch && ch.role === "lead" ? ch.node : null);
  const node = agentId ? findSub(session, agentId) || (ch ? ch.node : null) : session;
  return { key, role: agentId ? "helper" : "lead", session, node, character: ch };
}

function select(key, { focus = false } = {}) {
  const k = typeof key === "string" && key ? key : null;
  if (k) {
    const known = world.characters.has(k) || !!detailFor(k).node;
    if (!known) return; // key จากฟีดของห้องที่หายไปแล้ว — ไม่มีอะไรให้ดู
  }
  selectedKey = k;
  selectedHadCharacter = !!k && world.characters.has(k);
  scene.setSelected(k);
  hud.setSelected(k, k ? detailFor(k) : null);
  if (k && focus) scene.focus(k);
}

/**
 * จอแคบ + แผงรายละเอียดเป็น bottom sheet: ถ้าตัวละครที่เพิ่งแตะอยู่ใต้แผง (หรือล้นขอบจอ) เลื่อนฉากขึ้นให้มัน
 * อยู่ราว 60% ของพื้นที่เหนือแผง — เป็นผลของการแตะของผู้ใช้เอง จึงไม่ขัดกฎ "กล้องไม่ขยับเอง"
 */
function keepAboveSheet(key) {
  const vw = window.innerWidth || 1;
  if (vw > 760 || selectedKey !== key) return;
  const sheet = hudRoot ? hudRoot.querySelector(".px-detail") : null;
  if (!sheet || sheet.hidden) return;
  const ch = world.characters.get(key);
  const p = ch ? world.worldPos(ch) : null;
  if (!p) return;
  const r = sheet.getBoundingClientRect();
  const top = hudInsets().top;
  const feet = scene.worldToScreen(p.x, p.y);
  const d = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
  const tall = (26 * scene.zoom) / d;
  let dx = 0;
  let dy = 0;
  if (feet.y > r.top - 6 || feet.y - tall < top) dy = top + (r.top - top) * 0.6 - feet.y;
  if (feet.x < 24 || feet.x > vw - 24) dx = vw / 2 - feet.x;
  if (dx || dy) scene.panBy(dx, dy);
}

/**
 * ทุก snapshot: ส่งรายละเอียดตัวที่เลือกซ้ำ (ข้อมูลสด) — ตัวละครที่เคยอยู่บนจอแล้วหายไป (ส่งงานเสร็จ
 * เดินออกประตูไปแล้ว / ห้องปิด) ถือว่าจบเรื่อง ปิดการเลือก ไม่ค้างแผงของคนที่ไม่อยู่แล้ว
 */
function refreshSelection() {
  if (!selectedKey) return;
  const has = world.characters.has(selectedKey);
  if (has) selectedHadCharacter = true;
  if (!has && selectedHadCharacter) {
    select(null);
    return;
  }
  hud.setSelected(selectedKey, detailFor(selectedKey));
}

/* ───────────────────────── คำสั่งจาก HUD ───────────────────────── */

function handleCommand(name, value) {
  if (name === "zoom-in") scene.zoomBy(1);
  else if (name === "zoom-out") scene.zoomBy(-1);
  else if (name === "fit") scene.fit();
  else if (name === "focus-room") scene.focusRoom(value);
  /* คลิกแถวในฟีด = เลือก + เล็งกล้องไปหา (การกระทำของผู้ใช้ จึงขยับกล้องได้ตามกฎ) */
  else if (name === "select") select(value, { focus: true });
  else if (name === "close-panel") select(null);
  else if (name === "captions") scene.setCaptions(value);
  /* แถบบนเปลี่ยนความสูง (พับ/กางแถวสรุปบนจอแคบ) → พื้นที่มองเห็นเปลี่ยน → บอก world ใหม่ */
  else if (name === "layout") scheduleLayoutHint();
  else if (name === "audio-mode" && activityAudio) {
    /* ต้องเรียกใน event ของผู้ใช้ตรง ๆ (hud เรียกเราแบบ synchronous) — engine ใช้ gesture นี้ปลดล็อกเสียง */
    const state =
      typeof activityAudio.setMode === "function"
        ? activityAudio.setMode(value, { userGesture: true, preview: true })
        : activityAudio.setEnabled(value !== "off", { userGesture: true, preview: true });
    hud.setVoiceState(state);
  } else if (name === "audio-reminders" && activityAudio) {
    const state =
      typeof activityAudio.setRemindersEnabled === "function"
        ? activityAudio.setRemindersEnabled(!!value)
        : activityAudio.getState();
    hud.setVoiceState(state);
  } else if (name === "scenario" && fixture) {
    if (!SCENARIOS.includes(value)) return;
    fixture.setScenario(value);
    hud.toast(`สลับสถานการณ์: ${value}`, "info");
  }
}

/* ───────────────────────── เสียง (engine ชุดเดียวกับหน้าคลาสสิก/NEURAL CORE) ───────────────────────── */

/** เฟรมภาพจากเสียง: ตัวละครต้นเรื่อง "อ้าปากพูด" + มิเตอร์ใน HUD — ไม่แตะกล้องหรือพื้นหลังเลย */
function onVoiceVisual(frame) {
  guard("world.voice", () => world.voice(frame));
  hud.setVoiceVisual(frame);
}

const activityAudioApi = globalThis.AgentActivityAudio;
if (activityAudioApi && typeof activityAudioApi.create === "function") {
  guard("audio create", () => {
    activityAudio = activityAudioApi.create({
      onState: (state) => hud.setVoiceState(state),
      onVisual: onVoiceVisual,
    });
    hud.setVoiceState(activityAudio.getState());
  });
}
if (!activityAudio) {
  /* /activity-audio.js โหลดไม่ขึ้น — หน้ายังทำงานต่อได้ ปุ่มเสียงขึ้น "ไม่รองรับ" แทน */
  hud.setVoiceState({ mode: "off", enabled: false, speaking: false, level: 0, supported: false });
}

/* ───────────────────────── สายข้อมูล ───────────────────────── */

world.onNarrate((line) => {
  hud.pushFeed({ icon: line.icon, text: line.text, tone: line.tone, key: line.key, ts: Date.now() });
});

let everConnected = false;
store.on("connect", () => {
  hud.setConnected(true);
  if (everConnected) hud.pushFeed({ icon: "🔌", text: "ต่อสตรีมกลับมาแล้ว", tone: "good", ts: Date.now() });
  everConnected = true;
});

store.on("disconnect", () => {
  hud.setConnected(false);
  hud.pushFeed({ icon: "🔌", text: "สตรีมหลุด — กำลังต่อใหม่ (ภาพค้างที่สถานะล่าสุด)", tone: "bad", ts: Date.now() });
});

function roomInfo() {
  let overflow = 0;
  for (const r of world.rooms.values()) overflow += Math.max(0, Number(r.overflow) || 0);
  return { rooms: world.rooms.size, characters: world.characters.size, overflow };
}

/** รายชื่อห้องใน HUD เรียงตาม slot ของ world (ตำแหน่งบนจอ) ไม่ใช่ตามที่ server เรียงสถานะมาใหม่ทุก poll */
function roomList() {
  return Array.from(world.rooms.values())
    .sort((a, b) => a.slot - b.slot)
    .map((r) => ({ sessionId: r.sessionId, title: r.title, state: r.state, alive: r.alive }));
}

store.on("snapshot", (snapshot, meta) => {
  const first = !!(meta && meta.first);
  lastSnapshot = snapshot;
  /* ก่อนจัดกรอบครั้งแรก: วัดพื้นที่อีกรอบ (แถบบนอาจห่อบรรทัดหลังฟอนต์โหลด) ให้ผังแรกถูกตั้งแต่ต้น */
  if (!initialFitDone) guard("layout hint", pushLayoutHint);
  guard("world.sync", () => world.sync(snapshot, { first }));
  /* engine ใช้เฟรมแรกเป็น baseline เงียบ ๆ แล้ว diff ทุก snapshot ถัดไปเพื่อส่งเสียงเหตุการณ์ใหม่ */
  if (activityAudio) guard("audio.ingest", () => activityAudio.ingest(snapshot));
  hud.update(snapshot, roomInfo());
  hud.setRooms(roomList());
  const agents = snapshot && Array.isArray(snapshot.agents) ? snapshot.agents : [];
  hud.showEmpty(agents.length === 0);
  guard("selection", refreshSelection);
  if (first) {
    const t = (snapshot && snapshot.totals) || {};
    hud.pushFeed({
      icon: "💡",
      text: `เปิดไฟออฟฟิศ: ${agents.length} ห้อง · ผู้ช่วยกำลังทำงาน ${Number(t.subsRunning) || 0} คน`,
      tone: "info",
      ts: Date.now(),
    });
  }
  /*
   * จัดกรอบอัตโนมัติครั้งเดียวในชีวิตของหน้า — ที่ snapshot แรกที่ "มีห้อง" (หน้าเปิดตอนยังไม่มี session
   * แล้วค่อยมี ก็ยังได้กรอบที่ถูก) · หน่วง ~0.35 วิ: HUD วัดความสูงแถบบนด้วย ResizeObserver แล้วค่อยป้อน
   * --px-top-h ให้แผงขวา "หลัง" รอบ layout ถัดไป ถ้าจัดกรอบทันทีจะวัดตำแหน่งแผงเก่า (จอแคบพลาด ~40 px)
   */
  if (!initialFitDone && !pendingFit && world.rooms.size > 0) {
    pendingFit = true;
    fitDelay = 0.35;
  }
});

/**
 * ห้อง "ใหม่" ที่เกิดนอกจอ → บอกด้วย toast (ไม่เลื่อนกล้องเอง) เว้นระยะอย่างน้อย 45 วิระหว่างสองครั้ง
 * ห้องที่หลุดจอเพราะผู้ใช้ซูม/ลากเองไม่นับ — เขาตั้งใจดูตรงนั้นอยู่ การเตือนคือการรบกวน
 * (ห้องที่เคยเห็นแล้ว = อยู่ในโลกตอนจัดกรอบครั้งแรก หรือถูกนับไปแล้วรอบก่อน)
 */
const seenRooms = new Set();
function roomFullyVisible(r, v) {
  const w = r.w * 16;
  const h = r.h * 16;
  return r.tx >= v.x && r.ty >= v.y && r.tx + w <= v.x + v.w && r.ty + h <= v.y + v.h;
}
function offscreenToast(text) {
  const now = Date.now();
  if (now - lastOffscreenToast < OFFSCREEN_TOAST_GAP_MS) return;
  lastOffscreenToast = now;
  hud.toast(text, "info");
}
function checkOffscreen() {
  if (!initialFitDone) return;
  const sig = String(world.layoutVersion);
  if (sig === offscreenSig) return;
  offscreenSig = sig;
  const v = scene.viewRect();
  const fresh = [];
  for (const r of world.rooms.values()) {
    if (seenRooms.has(r.sessionId)) continue;
    seenRooms.add(r.sessionId);
    if (!roomFullyVisible(r, v)) fresh.push(r);
  }
  for (const sid of Array.from(seenRooms)) if (!world.rooms.has(sid)) seenRooms.delete(sid);
  if (fresh.length) {
    offscreenToast(
      fresh.length === 1
        ? `ห้องใหม่ “${fresh[0].title}” อยู่นอกจอ — กด “จัดกรอบ” หรือเลือกจากรายชื่อห้อง`
        : `มีห้องใหม่ ${fresh.length} ห้องอยู่นอกจอ — กด “จัดกรอบ” หรือลากเพื่อเลื่อนดู`,
    );
  }
}
/** หลังจัดกรอบครั้งแรก: จำทุกห้องว่าเห็นแล้ว และถ้าออฟฟิศใหญ่กว่าจอแม้ซูมต่ำสุด ก็บอกตรง ๆ หนึ่งครั้ง */
function afterInitialFit() {
  const v = scene.viewRect();
  let hidden = 0;
  for (const r of world.rooms.values()) {
    seenRooms.add(r.sessionId);
    if (!roomFullyVisible(r, v)) hidden++;
  }
  offscreenSig = String(world.layoutVersion);
  if (hidden) offscreenToast(`ออฟฟิศใหญ่กว่าจอ (${hidden} ห้องเห็นไม่ครบ) — ลากเพื่อเลื่อนดู หรือเลือกห้องจากรายชื่อ`);
}

/* ───────────────────────── ลูปหลัก ───────────────────────── */

let lastT = 0;
let booted = false;
let lastDpr = window.devicePixelRatio || 1;
let offscreenTimer = 0;

function frame(t) {
  requestAnimationFrame(frame);
  const dt = lastT ? Math.min(0.1, Math.max(0, (t - lastT) / 1000)) : 0;
  lastT = t;
  guard("world.update", () => world.update(dt));
  /* แท็บซ่อนอยู่: โลกเดินต่อ (เนื้อเรื่องไม่ค้าง) แต่ไม่ต้องวาดให้ใครดู */
  if (document.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  if (dpr !== lastDpr) {
    lastDpr = dpr;
    guard("scene.resize", () => scene.resize());
  }
  if (pendingFit) {
    fitDelay -= dt;
    if (userMovedCamera) {
      /* ผู้ใช้ลาก/ซูมเองไปแล้วระหว่างรอ — กล้องเป็นของเขาแล้ว ไม่จัดกรอบทับ */
      pendingFit = false;
      initialFitDone = true;
      guard("after user camera", afterInitialFit);
    } else if (fitDelay <= 0) {
      pendingFit = false;
      initialFitDone = true;
      autoFitting = true;
      guard("initial fit", () => {
        scene.fit();
        afterInitialFit();
      });
      autoFitting = false;
    }
  }
  guard("scene.render", () => scene.render(dt));
  hud.tick(dt, world.nowMs() || undefined);
  if (!booted) {
    booted = true;
    if (typeof window.__bootReady === "function") guard("bootReady", () => window.__bootReady());
  }
  offscreenTimer += dt;
  if (offscreenTimer >= 1) {
    offscreenTimer = 0;
    guard("offscreen check", checkOffscreen);
  }
  attentionTimer += dt;
  if (attentionTimer >= 0.3) {
    attentionTimer = 0;
    guard("attention", syncAttention);
  }
}

/**
 * ห้องที่รอคุณ/ติดด่านแต่อยู่นอกส่วนที่มองเห็น (ฉากวาดป้ายขอบจอให้แล้ว) → แถวในรายชื่อห้องกระพริบด้วย
 * ส่งให้ HUD เฉพาะตอนชุดเปลี่ยน — ไม่แตะกล้อง ผู้ใช้เลือกเองว่าจะกดไปดูหรือไม่
 */
let attentionTimer = 0;
let attentionSig = "";
function syncAttention() {
  const ids = scene.attention;
  const sig = ids.join("|");
  if (sig === attentionSig) return;
  attentionSig = sig;
  hud.setAttention(ids);
}

window.addEventListener("resize", () => {
  guard("scene.resize", () => scene.resize());
  scheduleLayoutHint();
});
document.addEventListener("visibilitychange", () => {
  /* กลับมาที่แท็บ: เริ่มนับ dt ใหม่ ไม่ให้เฟรมแรกกระโดด (ถึง world จะ clamp ไว้ 0.1 อยู่แล้ว) */
  if (!document.hidden) lastT = 0;
});

/* หยุดเสียง/คิว/ตัวจับเวลาเมื่อเปลี่ยนหน้า ไม่ให้คำพูดตามไปทับหน้าอื่น (แบบเดียวกับ brain/main.js) */
function disposeActivityAudio() {
  if (!activityAudio) return;
  guard("audio dispose", () => activityAudio.dispose());
  activityAudio = null;
  hud.setVoiceState({ mode: "off", enabled: false, speaking: false, level: 0 });
}
window.addEventListener("pagehide", (event) => {
  // หน้าที่เข้า BFCache กลับมาได้โดยไม่รันโมดูลนี้ใหม่ — เก็บ engine ไว้ แต่ตัดประโยคที่พูดค้างทิ้ง
  // ไม่ให้พูดทับหน้าที่ผู้ใช้เพิ่งเปิด
  if (event.persisted) {
    if (activityAudio) guard("audio cancel", () => activityAudio.cancel("bfcache"));
    return;
  }
  disposeActivityAudio();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && activityAudio && typeof activityAudio.resume === "function") {
    guard("audio resume", () => activityAudio.resume());
  }
});

/* ───────────────────────── เริ่มทำงาน ───────────────────────── */

store.start();
requestAnimationFrame(frame);

if (fixtureMode) hud.toast("โหมดข้อมูลจำลอง — ไม่ได้ต่อกับ session จริง", "warn");

/* เปิดทางให้แกะดูสถานะใน DevTools ได้โดยไม่ต้องแก้โค้ด */
window.__pixel = {
  store,
  world,
  scene,
  hud,
  sprites,
  fixture,
  get audio() {
    return activityAudio;
  },
  get snapshot() {
    return lastSnapshot;
  },
  get selected() {
    return selectedKey;
  },
};
