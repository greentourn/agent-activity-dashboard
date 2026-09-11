// hud.js — HUD overlay ลอยบน canvas WebGL ของ Agent Dashboard "สมองสามมิติ"
//
// ES module รันตรงในเบราว์เซอร์ — ห้าม import อะไรทั้งสิ้น (ไม่มี three ไม่มี lib ภายนอก)
// สร้าง DOM เองล้วน ๆ ด้วย document.createElement แล้วพึ่ง hud.css (โหลดแยกผ่าน <link>) ล้วน ๆ
// สำหรับหน้าตา ไฟล์นี้ไม่ยุ่งกับ WebGL/three.js เลยสักบรรทัด
//
// สัญญากับ main.js (ห้ามเปลี่ยน signature):
//   export function createHud(root, options = {}) -> { update, tick, pushFeed, setSelected,
//     setConnected, setFps, setHint, setVoiceState, setVoiceVisual, toast, dispose, get selected() }

"use strict";

// =====================================================================
// ค่าคงที่ — ข้อความ/สี/ป้าย ที่ไม่เปลี่ยนตามข้อมูล
// =====================================================================

/** ข้อความไทยของ ctx.mood ("idle"|"thinking"|"tool"|"delegating"|"waiting"|"blocked"|"spawning") */
const MOOD_TH = {
  idle: "รอคำสั่ง",
  thinking: "กำลังคิด",
  tool: "กำลังเรียกเครื่องมือ",
  delegating: "กำลังทำงานผ่าน sub-agent",
  waiting: "รออนุญาต",
  blocked: "ถูกบล็อก",
  spawning: "กำลังแตก agent",
};

/** ข้อความไทยของ session.status.state ("tool"|"delegating"|"waiting"|"idle"|"blocked"|"thinking"|"unknown") */
const STATE_TH = {
  tool: "กำลังใช้ tool",
  delegating: "รอ sub-agent",
  waiting: "รอเราตอบ / รออนุญาต",
  idle: "ว่าง รอคำสั่ง",
  blocked: "ติดด่าน / มี error",
  thinking: "กำลังคิด",
  unknown: "ไม่มี transcript",
};

/** ตัวแปร CSS สีของแต่ละโมเดล — HA เขียว · SO ฟ้า · OP ม่วง · FA ส้ม (นิยามจริงอยู่ใน hud.css) */
const MODEL_COLOR_VAR = {
  HA: "--hud-model-ha",
  SO: "--hud-model-so",
  OP: "--hud-model-op",
  FA: "--hud-model-fa",
};

/** ลำดับโมเดลที่ตายตัว — กันไม่ให้แถบสัดส่วนโมเดลสลับตำแหน่งไปมาตามลำดับ key ของ object */
const MODEL_ORDER = ["HA", "SO", "OP", "FA"];

const SCENARIO_LABELS = [
  ["auto", "อัตโนมัติ"],
  ["idle", "ว่าง"],
  ["thinking", "กำลังคิด"],
  ["storm", "พายุงาน (storm)"],
  ["cascade", "แตกเป็นทอด (cascade)"],
  ["errors", "จำลอง error"],
];

const QUALITY_LABELS = [
  ["low", "ต่ำ"],
  ["medium", "กลาง"],
  ["high", "สูง"],
];

/** โหมดเสียงเป็นตัวเลือกแยกชัดเจน แทนสวิตช์เดียวที่บอกไม่ได้ว่าจะมีเสียงพูดหรือไม่ */
const AUDIO_MODES = [
  ["off", "ปิด", "ปิดเสียงเหตุการณ์ทั้งหมด"],
  ["effects", "เอฟเฟกต์", "เล่นเสียงสัญญาณสั้น ๆ โดยไม่พูด"],
  ["voice", "พูด+เอฟเฟกต์", "พูดภาษาไทยเฉพาะเหตุการณ์สำคัญ พร้อมเสียงสัญญาณ"],
];

const FEED_MAX_ROWS = 60;
const TOAST_LIFETIME_MS = 3000;
const TOAST_FADE_MS = 260;

// =====================================================================
// ฟังก์ชันช่วยจัดรูปแบบ — ทุกตัวกัน undefined/NaN แล้วคืน "—" เอง
// =====================================================================

function clamp(n, lo, hi) {
  if (!isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** ตัวเลขนับ (จำนวนเต็ม) — undefined/null/NaN -> "—" */
function fmtNumOrDash(n) {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  return String(n);
}

/** เศษส่วน "วิ่ง/ทั้งหมด" — ถ้าทั้งคู่ไม่มีข้อมูลเลยให้คืน "—" อันเดียว ไม่ใช่ "—/—" */
function fmtFraction(run, total) {
  const r = fmtNumOrDash(run);
  const t = fmtNumOrDash(total);
  if (r === "—" && t === "—") return "—";
  return r + "/" + t;
}

/** ย่อโทเค็น — 1 ทศนิยมตั้งแต่หลักล้าน, 2 ทศนิยมตั้งแต่หลักพันล้าน (เช่น 1.2M, 284.6M) */
function fmtTok(n) {
  const v = Number(n);
  if (!isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(Math.round(v));
}

/** เหมือน fmtTok แต่ถ้า field ไม่มีอยู่จริง (undefined/null) ให้คืน "—" แยกจาก "มีค่าเป็น 0" */
function fmtTokOrDash(n) {
  if (n === undefined || n === null) return "—";
  return fmtTok(n);
}

/** ระยะเวลา — รูปแบบ "480ms" / "2.4s" / "1m 12s" / "1h 03m" */
function fmtDur(ms) {
  if (ms === undefined || ms === null || !isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  if (m < 60) return m + "m " + String(s).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}

/** ISO string หรือ epoch ms -> epoch ms (NaN ถ้า parse ไม่ได้) */
function toMs(t) {
  if (t === undefined || t === null) return NaN;
  if (typeof t === "number") return t;
  const p = Date.parse(t);
  return isFinite(p) ? p : NaN;
}

/** "เมื่อกี้" / "2.4s ที่แล้ว" — รับได้ทั้ง ISO string และ epoch ms */
function fmtAgo(t, nowMs) {
  const ms = toMs(t);
  if (!isFinite(ms)) return "—";
  const diff = (nowMs || Date.now()) - ms;
  if (diff < 0) return "—";
  if (diff < 5000) return "เมื่อกี้";
  return fmtDur(diff) + " ที่แล้ว";
}

/** นาฬิกา HH:MM:SS ของเวลาที่ให้มา (สำหรับฟีด) */
function fmtClock(t) {
  const ms = toMs(t);
  const d = isFinite(ms) ? new Date(ms) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/** ย่อ path ให้เหลือ 2 ท่อนท้าย เช่น "…/projects/web-app" */
function shortCwd(p) {
  if (!p) return "—";
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
}

/** ตัดสตริงยาว ๆ ให้เหลือ n ตัวอักษร แล้วปิดท้ายด้วย "…" */
function truncate(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "—";
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** รวมโทเค็นทั้ง 4 ชั้น — คืน null ถ้าไม่มี object เลย (แยกจาก "มีแต่เป็น 0") */
function tokTotal(t) {
  if (!t) return null;
  return (t.input || 0) + (t.cacheCreate || 0) + (t.cacheRead || 0) + (t.output || 0);
}

/** จับคู่ model tag (HA/SO/OP/FA) -> ตัวแปรสี CSS ของมัน, ไม่รู้จักให้ใช้สีกลาง */
function modelColor(tag) {
  const key = String(tag || "").toUpperCase();
  return "var(" + (MODEL_COLOR_VAR[key] || "--hud-model-un") + ")";
}

/** session.model เป็น string เต็ม ๆ เช่น "claude-opus-5" — แปลงเป็น tag 2 ตัวให้ modelColor() ใช้ต่อ */
function sessionModelTag(model) {
  const m = String(model || "").toLowerCase();
  if (m.indexOf("opus") !== -1) return "OP";
  if (m.indexOf("sonnet") !== -1) return "SO";
  if (m.indexOf("haiku") !== -1) return "HA";
  if (m.indexOf("fable") !== -1) return "FA";
  return "";
}

/** สีตาม severity ของโควตา — ไม่รู้จักถือว่าปกติ (สี accent) */
function severityColor(sev) {
  const s = String(sev || "").toLowerCase();
  if (s.indexOf("crit") !== -1 || s.indexOf("danger") !== -1 || s === "high" || s === "severe") {
    return "var(--hud-bad)";
  }
  if (s.indexOf("warn") !== -1 || s === "elevated" || s === "medium") return "var(--hud-warn)";
  return "var(--hud-accent)";
}

/*
 * สถานะของ sub-agent 1 ตัวเป็นข้อความ+คลาส — แยก "ล้มเหลว" ออกจาก "จบแล้วแบบไม่ทราบผล"
 * (ตามธรรมเนียมเดิมของ index.html: outcome "ok" = สำเร็จ, "unknown" = เงียบไปเฉย ๆ ไม่นับว่าสำเร็จ)
 */
function subOutcomeInfo(agent) {
  if (agent && agent.running) return { cls: "hud-tag--running", text: "กำลังทำงาน" };
  if (agent && agent.outcome && agent.outcome !== "ok" && agent.outcome !== "unknown") {
    return { cls: "hud-tag--failed", text: "ล้มเหลว (" + agent.outcome + ")" };
  }
  if (agent && agent.outcome === "unknown") return { cls: "hud-tag--unknown", text: "จบแล้ว (ไม่ทราบผลแน่ชัด)" };
  return { cls: "hud-tag--ok", text: "สำเร็จ" };
}

/** key ที่ onSelect/setSelected ใช้ คือ "sessionId" หรือ "sessionId:agentId" */
function parseKey(key) {
  const idx = String(key).indexOf(":");
  if (idx === -1) return { sessionId: key, agentId: null };
  return { sessionId: key.slice(0, idx), agentId: key.slice(idx + 1) };
}

function findSession(snapshot, sessionId) {
  const agents = (snapshot && snapshot.agents) || [];
  for (const a of agents) if (a.sessionId === sessionId) return a;
  return null;
}

function findSubagent(session, agentId) {
  const subs = (session && session.subagents) || [];
  for (const a of subs) if (a.agentId === agentId) return a;
  return null;
}

/**
 * ไล่ parentAgentId ขึ้นไปจนสุดสาย -> array เรียงจาก "รากที่ใกล้ session ที่สุด" ไปจนถึง agent เป้าหมาย
 * (รวม agent เป้าหมายเองเป็นตัวสุดท้ายเสมอ)
 *
 * รับ "agent object ที่ resolve แล้ว" ตรง ๆ (ไม่ใช่ agentId แล้วไป findSubagent ซ้ำ) — กันบั๊กที่ chain
 * ว่างเปล่าถ้า findSubagent ครั้งแรกพลาดด้วยเหตุผลใดก็ตาม (เช่น ข้อมูล race ระหว่าง render) ตัว agent เอง
 * ต้องอยู่ใน chain เสมออย่างน้อย 1 ตัวโดยไม่ต้อง lookup ซ้ำ — สายพันธุ์จึงแสดง "session → ตัวมันเอง"
 * ได้เสมอแม้ agent จะเป็น depth 1 (ไม่มีพ่อเป็น sub-agent อื่น, parentAgentId เป็น null)
 */
function buildLineage(session, agent) {
  const chain = [];
  if (!agent) return chain;
  const guard = new Set();
  let cur = agent;
  while (cur && !guard.has(cur.agentId)) {
    guard.add(cur.agentId);
    chain.unshift(cur);
    cur = cur.parentAgentId ? findSubagent(session, cur.parentAgentId) : null;
  }
  return chain;
}

// =====================================================================
// ฟังก์ชันช่วยสร้าง DOM
// =====================================================================

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

// =====================================================================
// createHud — จุดเริ่ม export เดียวของไฟล์นี้
// =====================================================================

export function createHud(root, options = {}) {
  const opts = options || {};
  const onSelect = typeof opts.onSelect === "function" ? opts.onSelect : () => {};
  const onCommand = typeof opts.onCommand === "function" ? opts.onCommand : () => {};
  const fixtureMode = !!opts.fixtureMode;

  /** เรียก callback ของฝั่งเรียกแบบกันพัง — ถ้ามันโยน error ต้องไม่ลาก HUD ไปด้วย */
  function safeCall(fn, ...args) {
    try {
      fn(...args);
    } catch (err) {
      /* เงียบไว้ — นี่ไม่ใช่หน้าที่ของ HUD ที่จะรายงาน error ของฝั่งเรียก */
    }
  }

  // ---------------------------------------------------------------
  // สถานะภายใน (mutable) — ทั้งหมดอยู่ในสโคปนี้ ไม่มี module-level state
  // ---------------------------------------------------------------

  let lastSnapshot = { agents: [], totals: {}, nowMs: Date.now() };
  let nowMsRef = Date.now();
  let selectedKey = null;
  let lastPanelOpenNotified = false;
  let railCollapsed = false;
  let feedFollowing = true;
  /* ต้องตรงกับค่าเริ่มต้นใน main.js (ปิดไว้ตั้งแต่ 2026-09-09) ไม่งั้นป้ายปุ่มจะโกหกตั้งแต่เฟรมแรก */
  let autorotateOn = false;
  let connectedState = false;
  let voiceState = {
    mode: "off",
    enabled: false,
    effectsEnabled: false,
    voiceEnabled: false,
    voiceAvailable: false,
    remindersEnabled: true,
    unlocked: false,
    speaking: false,
    level: 0,
    supported: true,
  };
  let voiceCueTimer = null;
  let lastMoodShown = null;
  let lastFpsShown = null;
  let lastQualityShown = null;
  let lastActivityShown = -1;
  /** ResizeObserver ที่วัดความสูงจริงของแถบบน/ล่าง — ต้องประกาศก่อน buildSkeleton() เรียก observeBoundaries() */
  let boundaryObserver = null;
  /** key -> { el, since } — ตัวจับเวลาที่ tick() ไล่อัปเดตทุกเฟรม (มีแค่ของแผงรายละเอียดที่เปิดอยู่) */
  const timerRegistry = new Map();
  /** sessionId -> { root, refs } — แถวราง session ที่ reuse ข้ามการ update() ทุกครั้ง */
  const railRows = new Map();
  /** setTimeout id ทั้งหมดของ toast ที่ยังไม่ถูกเคลียร์ — เก็บไว้ล้างตอน dispose() */
  const toastTimers = new Set();

  const refs = {};

  buildSkeleton();

  // ---------------------------------------------------------------
  // โครงสร้าง DOM ทั้งหมด — สร้างครั้งเดียว จากนั้น update()/tick() แก้แค่ textContent/style/class
  // ---------------------------------------------------------------

  function buildSkeleton() {
    const overlay = el("div", "hud-overlay");
    refs.overlay = overlay;

    // เอฟเฟกต์พื้นหลังล้วน ๆ — ไม่ยุ่งกับข้อมูล ไม่ต้องอัปเดตอีกเลย
    overlay.append(el("div", "hud-scanlines"));
    overlay.append(el("div", "hud-corner hud-corner--tl"));
    overlay.append(el("div", "hud-corner hud-corner--tr"));
    overlay.append(el("div", "hud-corner hud-corner--bl"));
    overlay.append(el("div", "hud-corner hud-corner--br"));

    /*
     * แถบบนซ้าย + ขวา อยู่ใน wrapper เดียวกัน (.hud-top-band, flex-wrap) — จอกว้างพอ ทั้งคู่อยู่แถวเดียวกัน
     * (ซ้าย/ขวา), จอแคบมาก (วัดจริงที่ ~500px: ตราสัญลักษณ์ชนแถบมาตรวัดพอดี ไม่มี media query ไหนกันไว้)
     * แถบขวาจะห่อลงบรรทัดใหม่เองผ่าน flexbox โดยอัตโนมัติ ไม่ต้องเดาความกว้างเป็นเลขคงที่ (ข้อ 3)
     */
    const topBand = el("div", "hud-top-band");
    topBand.append(buildTopLeft(), buildTopRight());
    overlay.append(topBand);
    refs.topBand = topBand;

    overlay.append(buildRail());
    overlay.append(buildDetailPanel());

    /*
     * ฟีด + แถบควบคุม อยู่ใน wrapper เดียวกัน (.hud-bottom-band) — desktop เรียงแนวนอน (flex row),
     * จอแคบเรียงซ้อนแนวตั้ง (ดู hud.css media query) วัดความสูงจริงของ wrapper นี้ด้วย ResizeObserver
     * แล้วป้อนกลับเป็น --hud-bottom-band-h ให้รางซ้าย/แผงขวารู้ว่าต้องเว้นจากขอบล่างแค่ไหน (ข้อ 1, 3, 4)
     */
    const bottomBand = el("div", "hud-bottom-band");
    bottomBand.append(buildFeed(), buildControls());
    overlay.append(bottomBand);
    refs.bottomBand = bottomBand;

    overlay.append(buildHint());
    overlay.append(buildToastWrap());

    root.appendChild(overlay);

    document.addEventListener("keydown", onKeyDown);
    observeBoundaries();
  }

  /*
   * ResizeObserver แทนเลขคงที่ (78px เดิม) — วัดความสูงจริงของแถบบนซ้าย/ขวา + บล็อกล่าง (ฟีด+ควบคุม)
   * ทุกครั้งที่ขนาดจริงเปลี่ยน (โควตาโผล่/หาย, ปุ่มควบคุมห่อบรรทัดจอแคบ, ฯลฯ) แล้วเขียนเป็นตัวแปร CSS
   * ให้ hud.css คำนวณ top/bottom ของรางซ้าย/แผงขวาได้ถูกเสมอ — แก้บั๊กข้อ 1 (แผงขวาทับแถบมาตรวัด)
   * แบบที่ไม่พังซ้ำเมื่อเนื้อหาแถบบน/ล่างเปลี่ยนขนาดในอนาคต ไม่ใช่แค่ปะเลขที่วัดได้ ณ ตอนนี้
   */
  function observeBoundaries() {
    if (typeof ResizeObserver !== "function") return;
    boundaryObserver = new ResizeObserver(() => {
      const tbH = refs.topBand && refs.topBand.getBoundingClientRect().height;
      const bbH = refs.bottomBand && refs.bottomBand.getBoundingClientRect().height;
      const ctlH = refs.controls && refs.controls.getBoundingClientRect().height;
      if (tbH) refs.overlay.style.setProperty("--hud-top-band-h", Math.ceil(tbH) + "px");
      if (bbH) refs.overlay.style.setProperty("--hud-bottom-band-h", Math.ceil(bbH) + "px");
      if (ctlH) refs.overlay.style.setProperty("--hud-controls-h", Math.ceil(ctlH) + "px");
    });
    for (const target of [refs.topBand, refs.bottomBand, refs.controls]) {
      if (target) boundaryObserver.observe(target);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && selectedKey) closeSelection();
  }

  // ---- แถบบนซ้าย: ตราสัญลักษณ์ + สถานะเชื่อมต่อ ----
  function buildTopLeft() {
    const panel = el("div", "hud-panel hud-top-left");
    const brand = el("div", "hud-brand");
    const dot = el("span", "hud-brand-dot hud-brand-dot--off");
    const text = el("div", "hud-brand-text");
    text.append(el("div", "hud-brand-title", "NEURAL CORE"), el("div", "hud-brand-mood", MOOD_TH.idle));
    brand.append(dot, text);
    panel.append(brand);
    refs.brandDot = dot;
    refs.brandMood = text.querySelector(".hud-brand-mood");
    return panel;
  }

  // ---- แถบบนขวา: มาตรวัด ----
  function createGauge(label) {
    const wrap = el("div", "hud-gauge");
    wrap.append(el("div", "hud-gauge-label", label));
    const value = el("div", "hud-gauge-value", "—");
    wrap.append(value);
    return { wrap, value };
  }

  function buildTopRight() {
    const panel = el("div", "hud-panel hud-top-right");
    const gauges = el("div", "hud-gauges");

    const gFps = createGauge("FPS");
    const gSessions = createGauge("เซสชัน");
    const gSubs = createGauge("sub-agent");
    const gTools = createGauge("tool");
    const gErrors = createGauge("error");
    const gDenials = createGauge("denial");
    refs.gaugeFps = gFps.value;
    refs.gaugeSessions = gSessions.value;
    refs.gaugeSubs = gSubs.value;
    refs.gaugeTools = gTools.value;
    refs.gaugeErrors = gErrors.value;
    refs.gaugeDenials = gDenials.value;
    gauges.append(gFps.wrap, gSessions.wrap, gSubs.wrap, gTools.wrap, gErrors.wrap, gDenials.wrap);

    const quota = el("div", "hud-quota");
    quota.hidden = true;
    const ring = el("div", "hud-quota-ring");
    const hole = el("div", "hud-quota-ring-hole");
    const pct = el("div", "hud-quota-pct", "—");
    hole.append(pct);
    ring.append(hole);
    const label = el("div", "hud-quota-label", "โควตา 5 ชม.");
    const resetTxt = el("div", "hud-quota-reset", "");
    const weekly = el("div", "hud-quota-weekly", "");
    weekly.hidden = true;
    quota.append(ring, label, resetTxt, weekly);
    refs.quota = quota;
    refs.quotaRing = ring;
    refs.quotaPct = pct;
    refs.quotaReset = resetTxt;
    refs.quotaWeekly = weekly;

    panel.append(gauges, quota);
    return panel;
  }

  // ---- รางซ้าย: รายการ session ----
  function buildRail() {
    const rail = el("div", "hud-panel hud-rail");
    const header = el("div", "hud-rail-header");
    header.append(el("div", "hud-rail-title", "เซสชัน"));
    const toggle = el("button", "hud-rail-toggle", "‹");
    toggle.type = "button";
    toggle.setAttribute("aria-label", "ย่อ/ขยายรายชื่อ session");
    toggle.setAttribute("aria-expanded", "true");
    toggle.addEventListener("click", () => {
      railCollapsed = !railCollapsed;
      rail.classList.toggle("hud-rail--collapsed", railCollapsed);
      toggle.textContent = railCollapsed ? "›" : "‹";
      toggle.setAttribute("aria-expanded", railCollapsed ? "false" : "true");
    });
    header.append(toggle);
    const list = el("div", "hud-rail-list");
    const empty = el("div", "hud-rail-empty", "ยังไม่มี session");
    rail.append(header, list, empty);
    refs.rail = rail;
    refs.railList = list;
    refs.railEmpty = empty;
    return rail;
  }

  // ---- แผงขวา: รายละเอียด ----
  function buildDetailPanel() {
    const panel = el("div", "hud-panel hud-panel-detail");
    const header = el("div", "hud-panel-detail-header");
    const titleWrap = el("div", "hud-panel-detail-titlewrap");
    const title = el("div", "hud-panel-detail-title", "—");
    const sub = el("div", "hud-panel-detail-sub", "");
    titleWrap.append(title, sub);
    const actions = el("div", "hud-panel-detail-actions");
    const focusBtn = el("button", "hud-btn hud-btn-focus", "โฟกัสกล้อง");
    focusBtn.type = "button";
    focusBtn.addEventListener("click", () => {
      if (selectedKey) safeCall(onCommand, "focus", selectedKey);
    });
    const closeBtn = el("button", "hud-panel-detail-close", "✕");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "ปิดแผงรายละเอียด");
    closeBtn.addEventListener("click", closeSelection);
    actions.append(focusBtn, closeBtn);
    header.append(titleWrap, actions);
    const body = el("div", "hud-panel-detail-body");
    panel.append(header, body);
    refs.panelDetail = panel;
    refs.panelDetailTitle = title;
    refs.panelDetailSub = sub;
    refs.panelDetailBody = body;
    return panel;
  }

  // ---- แถบล่าง: ฟีดสด ----
  function buildFeed() {
    const feed = el("div", "hud-panel hud-feed");
    const header = el("div", "hud-feed-header");
    header.append(el("div", "hud-feed-title", "ฟีดสด"));
    const toggle = el("button", "hud-btn hud-feed-toggle hud-btn--active", "หยุดเลื่อน");
    toggle.type = "button";
    toggle.setAttribute("aria-pressed", "true");
    toggle.addEventListener("click", () => {
      feedFollowing = !feedFollowing;
      toggle.textContent = feedFollowing ? "หยุดเลื่อน" : "เลื่อนต่อ";
      toggle.classList.toggle("hud-btn--active", feedFollowing);
      toggle.setAttribute("aria-pressed", feedFollowing ? "true" : "false");
    });
    header.append(toggle);
    const list = el("div", "hud-feed-list");
    const empty = el("div", "hud-feed-empty", "ยังไม่มีเหตุการณ์");
    feed.append(header, list, empty);
    refs.feed = feed;
    refs.feedList = list;
    refs.feedEmpty = empty;
    return feed;
  }

  // ---- แถบควบคุมล่างขวา ----
  function buildControls() {
    const controls = el("div", "hud-panel hud-controls");

    const qualityGroup = el("div", "hud-controls-group");
    qualityGroup.setAttribute("role", "group");
    qualityGroup.setAttribute("aria-label", "คุณภาพภาพ");
    qualityGroup.append(el("span", "hud-controls-caption", "คุณภาพ"));
    const qualityBtns = [];
    for (const [value, label] of QUALITY_LABELS) {
      const btn = el("button", "hud-btn hud-btn-quality", label);
      btn.type = "button";
      btn.dataset.quality = value;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => safeCall(onCommand, "quality", value));
      qualityGroup.append(btn);
      qualityBtns.push(btn);
    }
    refs.qualityBtns = qualityBtns;

    const autorotateBtn = el("button", "hud-btn hud-btn-autorotate", "");
    autorotateBtn.type = "button";
    autorotateBtn.setAttribute("aria-pressed", "false");
    autorotateBtn.addEventListener("click", () => {
      autorotateOn = !autorotateOn;
      applyAutorotateBtn();
      safeCall(onCommand, "autorotate", autorotateOn);
    });
    refs.autorotateBtn = autorotateBtn;

    const resetBtn = el("button", "hud-btn hud-btn-reset", "รีเซ็ตกล้อง");
    resetBtn.type = "button";
    resetBtn.addEventListener("click", () => safeCall(onCommand, "reset"));

    const audioRow = el("div", "hud-controls-group hud-audio-controls");
    audioRow.append(el("span", "hud-controls-caption", "เสียง AI"));
    const modeGroup = el("div", "hud-audio-mode-group");
    modeGroup.setAttribute("role", "group");
    modeGroup.setAttribute("aria-label", "เลือกรูปแบบเสียงเหตุการณ์ของ AI");
    const modeBtns = new Map();
    for (const [mode, label, title] of AUDIO_MODES) {
      const btn = el("button", "hud-btn hud-btn-audio-mode");
      btn.type = "button";
      btn.dataset.audioMode = mode;
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", `${label}: ${title}`);
      btn.title = title;
      btn.append(el("span", "hud-audio-mode-label", label));
      btn.addEventListener("click", () => safeCall(onCommand, "audio-mode", mode));
      modeGroup.append(btn);
      modeBtns.set(mode, btn);
    }

    /* มิเตอร์อยู่ในปุ่มโหมดพูด จึงบอกได้ทั้งโหมดที่เลือกและจังหวะคำพูดโดยไม่เพิ่มแถวใหม่ */
    const voiceBtn = modeBtns.get("voice");
    const voiceMeter = el("span", "agent-voice-meter");
    voiceMeter.setAttribute("aria-hidden", "true");
    const voiceBars = [];
    for (let i = 0; i < 4; i += 1) {
      const bar = el("i");
      voiceMeter.append(bar);
      voiceBars.push(bar);
    }
    voiceBtn.append(voiceMeter);
    audioRow.append(modeGroup);

    const reminderBtn = el("button", "hud-btn hud-btn-reminders", "");
    reminderBtn.type = "button";
    reminderBtn.setAttribute("aria-pressed", "true");
    reminderBtn.addEventListener("click", () => {
      safeCall(onCommand, "audio-reminders", !voiceState.remindersEnabled);
    });

    refs.audioRow = audioRow;
    refs.audioModeGroup = modeGroup;
    refs.audioModeBtns = modeBtns;
    refs.voiceBtn = voiceBtn;
    refs.voiceMeter = voiceMeter;
    refs.voiceBars = voiceBars;
    refs.reminderBtn = reminderBtn;

    controls.append(qualityGroup, autorotateBtn, resetBtn, audioRow, reminderBtn);

    if (fixtureMode) {
      const scenarioWrap = el("div", "hud-controls-group");
      scenarioWrap.append(el("span", "hud-controls-caption", "ทดสอบฉาก"));
      const select = el("select", "hud-scenario");
      select.id = "hud-scenario-select";
      select.name = "hud-scenario";
      select.setAttribute("aria-label", "ทดสอบฉาก");
      for (const [value, label] of SCENARIO_LABELS) {
        const option = el("option", "", label);
        option.value = value;
        select.append(option);
      }
      select.addEventListener("change", () => safeCall(onCommand, "scenario", select.value));
      scenarioWrap.append(select);
      controls.append(scenarioWrap);
    }

    const classicLink = el("a", "hud-classic-link", "← หน้าคลาสสิก");
    classicLink.href = "/index.html";
    controls.append(classicLink);

    applyAutorotateBtn();
    refs.controls = controls;
    return controls;
  }

  function applyAutorotateBtn() {
    refs.autorotateBtn.classList.toggle("hud-btn--active", autorotateOn);
    refs.autorotateBtn.setAttribute("aria-pressed", autorotateOn ? "true" : "false");
    refs.autorotateBtn.textContent = "หมุนอัตโนมัติ: " + (autorotateOn ? "เปิด" : "ปิด");
  }

  // ---- ป้าย hover ล่างซ้าย ----
  function buildHint() {
    const hint = el("div", "hud-hint", "");
    hint.hidden = true;
    refs.hint = hint;
    return hint;
  }

  // ---- toast มุมบนกลาง ----
  function buildToastWrap() {
    const wrap = el("div", "hud-toast-wrap");
    refs.toastWrap = wrap;
    return wrap;
  }

  // ---------------------------------------------------------------
  // ราง session — keyed diff เต็มรูปแบบ ห้ามล้างลิสต์แล้วสร้างใหม่ทุกครั้ง
  // ---------------------------------------------------------------

  function createRailRow(sessionId) {
    const rowEl = el("div", "hud-rail-row");
    const dot = el("span", "hud-rail-row-dot");
    const main = el("div", "hud-rail-row-main");
    const name = el("div", "hud-rail-row-name", "—");
    const status = el("div", "hud-rail-row-status", "—");
    main.append(name, status);
    const subs = el("div", "hud-rail-row-subs", "—");
    const activity = el("div", "hud-rail-row-activity");
    const activityFill = el("div", "hud-rail-row-activity-fill");
    activity.append(activityFill);
    rowEl.append(dot, main, subs, activity);
    rowEl.addEventListener("click", () => selectFromUI(sessionId));
    const refsRow = { dot, name, status, subs, activityFill };
    refs.railList.append(rowEl);
    return { root: rowEl, refs: refsRow };
  }

  function updateRailRow(row, a) {
    row.root.classList.toggle("hud-rail-row--dead", !a.alive);
    row.root.classList.toggle("hud-rail-row--selected", selectedKey === a.sessionId);
    row.refs.dot.style.background = modelColor(sessionModelTag(a.model));
    row.refs.name.textContent = a.title || a.name || (a.sessionId ? a.sessionId.slice(0, 8) : "—");
    const state = (a.status && a.status.state) || "unknown";
    row.refs.status.textContent = STATE_TH[state] || "—";
    row.refs.status.dataset.state = state;
    const subTotals = a.subTotals || {};
    row.refs.subs.textContent = fmtFraction(subTotals.running, subTotals.total);

    const isBusy = state === "tool" || state === "thinking" || state === "delegating";
    let ratio = 0;
    if (subTotals.total > 0) ratio = (subTotals.running || 0) / subTotals.total;
    else if (isBusy) ratio = 1;
    const pct = Math.max(isBusy ? 6 : 0, ratio * 100);
    row.refs.activityFill.style.width = clamp(pct, 0, 100) + "%";
    row.refs.activityFill.classList.toggle("hud-rail-row-activity-fill--busy", isBusy);
  }

  function renderRail(agents) {
    const seen = new Set();
    let prevEl = null;
    for (const a of agents) {
      if (!a || !a.sessionId) continue;
      seen.add(a.sessionId);
      let row = railRows.get(a.sessionId);
      if (!row) {
        row = createRailRow(a.sessionId);
        railRows.set(a.sessionId, row);
      }
      updateRailRow(row, a);
      if (row.root.previousElementSibling !== prevEl) {
        if (prevEl) prevEl.after(row.root);
        else refs.railList.prepend(row.root);
      }
      prevEl = row.root;
    }
    for (const [sid, row] of railRows) {
      if (!seen.has(sid)) {
        row.root.remove();
        railRows.delete(sid);
      }
    }
    refs.railEmpty.hidden = agents.length > 0;
  }

  // ---------------------------------------------------------------
  // การเลือก node — คลิกในราง / ปิดแผง / setSelected() จากภายนอก
  // ---------------------------------------------------------------

  function selectFromUI(key) {
    const next = selectedKey === key ? null : key;
    selectedKey = next;
    safeCall(onSelect, next);
    refreshSelectionUI();
  }

  function closeSelection() {
    if (!selectedKey) return;
    selectedKey = null;
    safeCall(onSelect, null);
    refreshSelectionUI();
  }

  function refreshSelectionUI() {
    for (const [sid, row] of railRows) {
      row.root.classList.toggle("hud-rail-row--selected", selectedKey === sid);
    }
    renderDetailPanel();
  }

  // ---------------------------------------------------------------
  // แผงรายละเอียด
  // ---------------------------------------------------------------

  function buildSection(title) {
    const section = el("div", "hud-section");
    section.append(el("div", "hud-section-title", title));
    const body = el("div", "hud-section-body");
    section.append(body);
    return { section, body };
  }

  function kvRow(container, key, val) {
    const row = el("div", "hud-kv-row");
    const valEl = el("div", "hud-kv-val");
    if (val instanceof Node) valEl.append(val);
    else valEl.textContent = val === undefined || val === null || val === "" ? "—" : val;
    row.append(el("div", "hud-kv-key", key), valEl);
    container.append(row);
  }

  /** ป้ายสถานะสีตามผลลัพธ์ของ sub-agent — ใช้ทั้งในลิสต์ย่อและแผงรายละเอียด */
  function buildTag(info) {
    return el("span", "hud-tag " + info.cls, info.text);
  }

  function buildTokenGrid(t) {
    const grid = el("div", "hud-token-grid");
    const total = tokTotal(t);
    const cells = [
      ["รวม", fmtTokOrDash(total)],
      ["input", fmtTokOrDash(t && t.input)],
      ["output", fmtTokOrDash(t && t.output)],
      ["cache write", fmtTokOrDash(t && t.cacheCreate)],
      ["cache read", fmtTokOrDash(t && t.cacheRead)],
      ["คิด (thinking)", fmtTokOrDash(t && t.thinking)],
    ];
    for (const [label, val] of cells) {
      const cell = el("div", "hud-token-cell");
      cell.append(el("div", "hud-token-cell-label", label), el("div", "hud-token-cell-value", val));
      grid.append(cell);
    }
    return grid;
  }

  function buildModelBar(modelsObj) {
    const wrap = el("div", "hud-model-bar");
    const legend = el("div", "hud-model-legend");
    const entries = MODEL_ORDER.map((k) => [k, (modelsObj && modelsObj[k]) || 0]).filter(([, v]) => v > 0);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    if (!total) {
      wrap.classList.add("hud-model-bar--empty");
      legend.append(el("span", "hud-model-chip hud-model-chip--empty", "—"));
      return { bar: wrap, legend };
    }
    for (const [k, v] of entries) {
      const seg = el("div", "hud-model-bar-seg");
      seg.style.width = (v / total) * 100 + "%";
      seg.style.background = modelColor(k);
      seg.title = k + " × " + v;
      wrap.append(seg);
      const chip = el("span", "hud-model-chip");
      const dot = el("span", "hud-model-chip-dot");
      dot.style.background = modelColor(k);
      chip.append(dot, document.createTextNode(k + " " + v));
      legend.append(chip);
    }
    return { bar: wrap, legend };
  }

  function buildSubagentListItem(sessionId, sub) {
    const item = el("div", "hud-subagent-item");
    const info = subOutcomeInfo(sub);
    if (sub.running) item.classList.add("hud-subagent-item--running");
    else if (info.cls === "hud-tag--failed") item.classList.add("hud-subagent-item--failed");
    const dot = el("span", "hud-rail-row-dot");
    dot.style.background = modelColor(sub.modelTag);
    const main = el("div", "hud-subagent-item-main");
    const statusTag = buildTag(info);
    statusTag.classList.add("hud-subagent-item-status");
    main.append(el("div", "hud-subagent-item-label", sub.label || sub.type || sub.agentId), statusTag);
    item.append(dot, main);
    item.addEventListener("click", () => selectFromUI(sessionId + ":" + sub.agentId));
    return item;
  }

  function buildLineageChip(text, isCurrent) {
    return el("span", "hud-lineage-item" + (isCurrent ? " hud-lineage-item--current" : ""), truncate(text, 24));
  }

  function buildAnswerBlock(answer) {
    const wrap = el("div", "hud-answer-wrap");
    const text = String(answer || "").trim();
    if (!text) {
      wrap.append(el("div", "hud-empty-state", "ยังไม่มีคำตอบ"));
      return wrap;
    }
    const long = text.length > 600;
    const p = el("div", "hud-answer", long ? truncate(text, 600) : text);
    wrap.append(p);
    if (long) {
      let expanded = false;
      const btn = el("button", "hud-answer-toggle", "ขยาย");
      btn.type = "button";
      btn.addEventListener("click", () => {
        expanded = !expanded;
        p.textContent = expanded ? text : truncate(text, 600);
        btn.textContent = expanded ? "ย่อ" : "ขยาย";
      });
      wrap.append(btn);
    }
    return wrap;
  }

  function buildEmptyState(text) {
    return el("div", "hud-empty-state", text);
  }

  function renderDetailPanel() {
    const isOpen = !!selectedKey;
    refs.panelDetail.classList.toggle("hud-panel-detail--open", isOpen);
    if (isOpen !== lastPanelOpenNotified) {
      lastPanelOpenNotified = isOpen;
      safeCall(onCommand, "panel", isOpen);
    }
    timerRegistry.forEach((_, k) => {
      if (k.indexOf("panel:") === 0) timerRegistry.delete(k);
    });
    if (!isOpen) {
      refs.panelDetailBody.replaceChildren();
      refs.panelDetailTitle.textContent = "—";
      refs.panelDetailSub.textContent = "";
      return;
    }
    const { sessionId, agentId } = parseKey(selectedKey);
    const session = findSession(lastSnapshot, sessionId);
    if (!session) {
      refs.panelDetailTitle.textContent = "ไม่พบข้อมูล";
      refs.panelDetailSub.textContent = "";
      refs.panelDetailBody.replaceChildren(buildEmptyState("เซสชันนี้ไม่มีอยู่แล้ว หรือยังไม่โหลดข้อมูล"));
      return;
    }
    if (agentId) {
      const agent = findSubagent(session, agentId);
      if (!agent) {
        refs.panelDetailTitle.textContent = "ไม่พบข้อมูล";
        refs.panelDetailSub.textContent = "";
        refs.panelDetailBody.replaceChildren(buildEmptyState("sub-agent นี้ไม่มีอยู่แล้ว"));
        return;
      }
      renderSubagentDetail(session, agent);
    } else {
      renderSessionDetail(session);
    }
  }

  function renderSessionDetail(session) {
    refs.panelDetailTitle.textContent = session.title || session.name || (session.sessionId || "").slice(0, 8);
    refs.panelDetailSub.textContent = [session.kind, session.entrypoint].filter(Boolean).join(" · ");

    const body = el("div", "hud-panel-detail-content");

    const info = buildSection("ข้อมูลเซสชัน");
    kvRow(info.body, "cwd", shortCwd(session.cwd));
    kvRow(info.body, "git branch", session.gitBranch);
    kvRow(info.body, "model", [session.model, session.effort].filter(Boolean).join(" · "));
    kvRow(info.body, "สถานะ", STATE_TH[(session.status && session.status.state) || "unknown"]);
    kvRow(info.body, "อัปเดตล่าสุด", fmtAgo(session.lastTs, nowMsRef));
    kvRow(info.body, "เริ่มเมื่อ", fmtAgo(session.startedAt, nowMsRef));
    body.append(info.section);

    const running = (session.status && session.status.running) || [];
    const runSec = buildSection("กำลังทำงาน");
    if (running.length) {
      running.forEach((r, i) => {
        const row = el("div", "hud-running-tool");
        const timer = el("span", "hud-running-tool-timer", "—");
        row.append(el("span", "hud-running-tool-icon", r.icon || "⚙️"), el("span", "hud-running-tool-label", r.label || r.tool || "—"), timer);
        runSec.body.append(row);
        if (r.startedTs) timerRegistry.set("panel:tool:" + i, { el: timer, since: r.startedTs });
      });
    } else {
      runSec.body.append(buildEmptyState("ไม่มี tool ที่กำลังทำงานอยู่ตอนนี้"));
    }
    body.append(runSec.section);

    const tokSec = buildSection("โทเค็น");
    tokSec.body.append(buildTokenGrid(session.tokens));
    body.append(tokSec.section);

    const subTotals = session.subTotals || {};
    const totalsSec = buildSection("sub-agent ทั้งหมด (" + fmtNumOrDash(subTotals.total) + ")");
    const modelsAll = buildModelBar(subTotals.models);
    totalsSec.body.append(modelsAll.bar, modelsAll.legend);
    if (subTotals.running) {
      totalsSec.body.append(el("div", "hud-section-subtitle", "กำลังวิ่ง (" + subTotals.running + ")"));
      const modelsRunning = buildModelBar(subTotals.runningModels);
      totalsSec.body.append(modelsRunning.bar, modelsRunning.legend);
    }
    body.append(totalsSec.section);

    const listSec = buildSection("รายชื่อ sub-agent");
    const subs = session.subagents || [];
    if (subs.length) {
      const list = el("div", "hud-subagent-list");
      for (const sub of subs) list.append(buildSubagentListItem(session.sessionId, sub));
      listSec.body.append(list);
    } else {
      listSec.body.append(buildEmptyState("ยังไม่มี sub-agent"));
    }
    body.append(listSec.section);

    refs.panelDetailBody.replaceChildren(body);
  }

  function renderSubagentDetail(session, agent) {
    refs.panelDetailTitle.textContent = agent.label || agent.type || agent.agentId;
    refs.panelDetailSub.textContent = [agent.type, agent.model].filter(Boolean).join(" · ");

    const body = el("div", "hud-panel-detail-content");

    const lineage = buildLineage(session, agent);
    const lineSec = buildSection("สายพันธุ์");
    const chain = el("div", "hud-lineage");
    chain.append(buildLineageChip(session.title || session.name || "session", false));
    for (const node of lineage) {
      chain.append(el("span", "hud-lineage-sep", "›"));
      chain.append(buildLineageChip(node.label || node.type || node.agentId, node.agentId === agent.agentId));
    }
    lineSec.body.append(chain);
    body.append(lineSec.section);

    const info = buildSection("ข้อมูล sub-agent");
    kvRow(info.body, "type", agent.type);
    kvRow(info.body, "model", agent.model);
    kvRow(info.body, "depth", fmtNumOrDash(agent.depth));
    kvRow(info.body, "สถานะ", buildTag(subOutcomeInfo(agent)));
    kvRow(info.body, "เริ่มเมื่อ", fmtAgo(agent.startedTs, nowMsRef));
    body.append(info.section);

    const taskSec = buildSection("งาน (task)");
    taskSec.body.append(el("div", "hud-task-text", truncate(agent.task, 400)));
    body.append(taskSec.section);

    const toolSec = buildSection("tool");
    if (agent.running && agent.current) {
      const row = el("div", "hud-running-tool");
      const timer = el("span", "hud-running-tool-timer", "—");
      row.append(el("span", "hud-running-tool-icon", agent.current.icon || "⚙️"), el("span", "hud-running-tool-label", agent.current.label || agent.current.tool || "—"), timer);
      toolSec.body.append(row);
      if (agent.current.startedTs) timerRegistry.set("panel:subtool", { el: timer, since: agent.current.startedTs });
    } else if (agent.lastTool) {
      const row = el("div", "hud-running-tool hud-running-tool--done");
      row.append(
        el("span", "hud-running-tool-icon", agent.lastTool.icon || "⚙️"),
        el("span", "hud-running-tool-label", agent.lastTool.label || agent.lastTool.tool || "—"),
        el("span", "hud-running-tool-timer", fmtDur(agent.lastTool.durMs))
      );
      if (agent.lastTool.error) row.classList.add("hud-running-tool--error");
      toolSec.body.append(row);
    } else {
      toolSec.body.append(buildEmptyState("ไม่มีข้อมูล tool"));
    }
    body.append(toolSec.section);

    const countSec = buildSection("จำนวน");
    kvRow(countSec.body, "tools", fmtNumOrDash(agent.tools));
    kvRow(countSec.body, "errors", fmtNumOrDash(agent.errors));
    body.append(countSec.section);

    const tokSec = buildSection("โทเค็น");
    tokSec.body.append(buildTokenGrid(agent.tokens));
    body.append(tokSec.section);

    const ansSec = buildSection("คำตอบ (answer)");
    ansSec.body.append(buildAnswerBlock(agent.answer));
    body.append(ansSec.section);

    refs.panelDetailBody.replaceChildren(body);
  }

  // ---------------------------------------------------------------
  // มาตรวัด + โควตา
  // ---------------------------------------------------------------

  function updateGauges(totals) {
    const t = totals || {};
    refs.gaugeSessions.textContent = fmtNumOrDash(t.live);
    refs.gaugeSubs.textContent = fmtFraction(t.subsRunning, t.subsTotal);
    refs.gaugeTools.textContent = fmtNumOrDash(t.toolsRunning);
    refs.gaugeErrors.textContent = fmtNumOrDash(t.errors);
    refs.gaugeDenials.textContent = fmtNumOrDash(t.denials);
    refs.gaugeErrors.parentElement.classList.toggle("hud-gauge--bad", (t.errors || 0) > 0);
    refs.gaugeDenials.parentElement.classList.toggle("hud-gauge--warn", (t.denials || 0) > 0);
  }

  function applyQuota(usage) {
    const limits = usage && Array.isArray(usage.limits) ? usage.limits : [];
    const session = limits.find((l) => l && l.kind === "session" && typeof l.percent === "number" && isFinite(l.percent));
    if (!session) {
      refs.quota.hidden = true;
      return;
    }
    refs.quota.hidden = false;
    const pct = clamp(session.percent, 0, 100);
    const color = severityColor(session.severity);
    refs.quotaRing.style.background = "conic-gradient(" + color + " " + pct * 3.6 + "deg, rgba(255,255,255,.14) 0deg)";
    refs.quotaPct.textContent = Math.round(pct) + "%";
    refs.quotaPct.style.color = color;
    const resetMs = session.resetsAt ? Date.parse(session.resetsAt) : NaN;
    if (isFinite(resetMs)) {
      const remain = resetMs - nowMsRef;
      refs.quotaReset.textContent = remain > 0 ? "รีเซ็ตใน " + fmtDur(remain) : "รีเซ็ตแล้ว";
    } else {
      refs.quotaReset.textContent = "";
    }
    const weekly = limits.find((l) => l && l.kind === "weekly_all" && typeof l.percent === "number" && isFinite(l.percent));
    if (weekly) {
      refs.quotaWeekly.hidden = false;
      refs.quotaWeekly.textContent = "สัปดาห์ " + Math.round(clamp(weekly.percent, 0, 100)) + "%";
    } else {
      refs.quotaWeekly.hidden = true;
    }
  }

  // ---------------------------------------------------------------
  // API สาธารณะ
  // ---------------------------------------------------------------

  function update(snapshot, ctx) {
    lastSnapshot = snapshot && typeof snapshot === "object" ? snapshot : { agents: [], totals: {} };
    nowMsRef = typeof lastSnapshot.nowMs === "number" ? lastSnapshot.nowMs : Date.now();

    updateGauges(lastSnapshot.totals);
    applyQuota(lastSnapshot.usage);
    renderRail(lastSnapshot.agents || []);
    renderDetailPanel();

    if (ctx) {
      if (typeof ctx.connected === "boolean") setConnected(ctx.connected);
      if (typeof ctx.quality === "string") applyQuality(ctx.quality);
      if (typeof ctx.mood === "string") applyMood(ctx.mood);
    }
  }

  function applyMood(mood) {
    const m = MOOD_TH[mood] ? mood : "idle";
    if (m === lastMoodShown) return;
    lastMoodShown = m;
    refs.brandMood.textContent = MOOD_TH[m];
    refs.overlay.dataset.mood = m;
  }

  function applyQuality(q) {
    if (!q || q === lastQualityShown) return;
    lastQualityShown = q;
    for (const btn of refs.qualityBtns) {
      const active = btn.dataset.quality === q;
      btn.classList.toggle("hud-btn--active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function applyFps(n) {
    const v = Number(n);
    const shown = isFinite(v) ? Math.round(v) : null;
    if (shown === lastFpsShown) return;
    lastFpsShown = shown;
    refs.gaugeFps.textContent = shown === null ? "—" : String(shown);
  }

  function applyActivity(activity) {
    const v = clamp(Number(activity) || 0, 0, 1);
    if (Math.abs(v - lastActivityShown) < 0.02) return;
    lastActivityShown = v;
    refs.overlay.style.setProperty("--hud-energy", String(v));
  }

  /** เรียกทุกเฟรม — ห้ามสร้าง DOM ใหม่ แก้แค่ textContent/style ของ node ที่มีอยู่แล้ว */
  function tick(dt, ctx) {
    const c = ctx || {};
    if (typeof c.mood === "string") applyMood(c.mood);
    if (typeof c.fps === "number") applyFps(c.fps);
    if (typeof c.activity === "number") applyActivity(c.activity);
    if (typeof c.quality === "string") applyQuality(c.quality);
    if (typeof c.connected === "boolean" && c.connected !== connectedState) setConnected(c.connected);

    if (timerRegistry.size) {
      const now = Date.now();
      timerRegistry.forEach((entry) => {
        const since = toMs(entry.since);
        entry.el.textContent = isFinite(since) ? fmtDur(now - since) : "—";
      });
    }
  }

  function pushFeed(entry) {
    if (!entry) return;
    const tone = entry.tone || "info";
    const item = el("div", "hud-feed-item hud-feed-item--" + tone + " hud-feed-item--enter");
    item.append(el("span", "hud-feed-time", fmtClock(entry.ts)), el("span", "hud-feed-text", String(entry.text || entry.kind || "")));
    refs.feedList.prepend(item);
    requestAnimationFrame(() => item.classList.remove("hud-feed-item--enter"));
    while (refs.feedList.children.length > FEED_MAX_ROWS) refs.feedList.lastElementChild.remove();
    if (feedFollowing) refs.feedList.scrollTop = 0;
    refs.feedEmpty.hidden = true;
  }

  function setSelected(key) {
    selectedKey = key || null;
    refreshSelectionUI();
  }

  function setConnected(bool) {
    connectedState = !!bool;
    refs.brandDot.classList.toggle("hud-brand-dot--on", connectedState);
    refs.brandDot.classList.toggle("hud-brand-dot--off", !connectedState);
  }

  function setFps(n) {
    applyFps(n);
  }

  /** สะท้อนสถานะจริงจาก shared audio engine; เรียกซ้ำได้ทั้งตอนเปิด/ปิดและระหว่างกำลังพูด */
  function setVoiceState(next) {
    const state = next && typeof next === "object" ? next : {};
    let mode = voiceState.mode;
    if (AUDIO_MODES.some(([value]) => value === state.mode)) mode = state.mode;
    else if (state.voiceEnabled === true) mode = "voice";
    else if (state.effectsEnabled === true) mode = "effects";
    /* รองรับ engine รุ่นก่อนที่ส่งแค่ enabled ระหว่างช่วงเปลี่ยนผ่าน */
    else if (state.enabled !== undefined) mode = state.enabled ? "voice" : "off";

    voiceState = {
      ...voiceState,
      ...state,
      mode,
      enabled: mode !== "off",
      effectsEnabled: mode !== "off",
      voiceEnabled: mode === "voice",
      voiceAvailable: state.voiceAvailable === undefined ? voiceState.voiceAvailable : !!state.voiceAvailable,
      remindersEnabled:
        state.remindersEnabled === undefined ? voiceState.remindersEnabled : !!state.remindersEnabled,
      speaking: state.speaking === undefined ? voiceState.speaking : !!state.speaking,
      level: state.level === undefined ? voiceState.level : clamp(Number(state.level) || 0, 0, 1),
      supported: state.supported === undefined ? voiceState.supported : !!state.supported,
    };
    if (!refs.audioModeBtns) return;

    for (const [value, btn] of refs.audioModeBtns) {
      const selected = value === voiceState.mode;
      btn.disabled = value !== "off" && !voiceState.supported;
      btn.classList.toggle("hud-btn--active", selected);
      btn.setAttribute("aria-pressed", selected ? "true" : "false");
    }

    const voiceActive = voiceState.voiceEnabled && voiceState.voiceAvailable && voiceState.supported;
    refs.voiceBtn.classList.toggle("is-speaking", voiceActive && voiceState.speaking);
    refs.voiceBtn.classList.toggle("has-live-level", voiceActive && voiceState.speaking);
    const meterShape = [0.52, 1, 0.7, 0.88];
    refs.voiceBars.forEach((bar, i) => {
      bar.style.setProperty("--voice-meter-height", `${Math.round(3 + voiceState.level * 9 * meterShape[i])}px`);
    });

    if (!voiceState.supported) {
      refs.voiceBtn.title = "เบราว์เซอร์นี้ไม่รองรับเสียงพูดหรือเสียงเอฟเฟกต์";
    } else if (voiceState.voiceEnabled && !voiceState.voiceAvailable) {
      refs.voiceBtn.title = "ยังไม่พบเสียงภาษาไทยในเครื่อง — โหมดนี้จะเล่นเอฟเฟกต์แทน";
    } else if (voiceState.voiceEnabled && !voiceState.unlocked) {
      refs.voiceBtn.title = "แตะอีกครั้งเพื่อเริ่มเสียงพูดและฟังตัวอย่าง";
    } else {
      refs.voiceBtn.title = "พูดภาษาไทยเฉพาะเหตุการณ์สำคัญ พร้อมเสียงสัญญาณ";
    }

    const remindersOn = voiceState.remindersEnabled;
    refs.reminderBtn.disabled = !voiceState.supported;
    refs.reminderBtn.classList.toggle("hud-btn--active", remindersOn);
    refs.reminderBtn.classList.toggle("hud-btn-reminders--dormant", voiceState.mode === "off");
    refs.reminderBtn.setAttribute("aria-pressed", remindersOn ? "true" : "false");
    refs.reminderBtn.textContent = `เตือนซ้ำเมื่อรอฉัน: ${remindersOn ? "เปิด" : "ปิด"}`;
    refs.reminderBtn.setAttribute(
      "aria-label",
      `เตือนซ้ำเมื่อ AI รอคำตอบจากฉัน: ${remindersOn ? "เปิด" : "ปิด"}`,
    );
    refs.reminderBtn.title = voiceState.mode === "off"
      ? "ตั้งค่านี้จะเริ่มทำงานเมื่อเลือกโหมดเสียง"
      : remindersOn
        ? "ส่งเสียงเตือนเป็นระยะจนกว่าคุณจะกลับมาตอบ"
        : "ไม่ส่งเสียงเตือนซ้ำเมื่อกำลังรอคำตอบ";
  }

  /** เฟรมภาพจาก audio engine — meter ขยับตามจังหวะพูดและกระพริบหนึ่งครั้งต่อ cue ใหม่ */
  function setVoiceVisual(frame) {
    if (!frame || typeof frame !== "object") return;
    const active = !["end", "cancel", "disabled"].includes(frame.phase);
    setVoiceState({
      speaking: frame.phase === "cue" ? voiceState.speaking : active,
      level: frame.phase === "end" ? 0 : frame.level,
    });
    if (frame.phase !== "cue" || !refs.audioModeBtns) return;
    for (const btn of refs.audioModeBtns.values()) btn.classList.remove("is-cue");
    const cueBtn = refs.audioModeBtns.get(voiceState.mode);
    if (!cueBtn) return;
    // บังคับ reflow เล็ก ๆ เพื่อให้ cue ที่มาติดกันเริ่ม animation ใหม่ทุกเหตุการณ์
    void cueBtn.offsetWidth;
    cueBtn.classList.add("is-cue");
    if (voiceCueTimer !== null) clearTimeout(voiceCueTimer);
    voiceCueTimer = setTimeout(() => {
      voiceCueTimer = null;
      if (refs.audioModeBtns) {
        for (const btn of refs.audioModeBtns.values()) btn.classList.remove("is-cue");
      }
    }, 260);
  }

  function setHint(text) {
    if (text) {
      refs.hint.textContent = text;
      refs.hint.hidden = false;
    } else {
      refs.hint.hidden = true;
      refs.hint.textContent = "";
    }
  }

  function toast(text, tone) {
    if (!text) return;
    const t = el("div", "hud-toast hud-toast--" + (tone || "info"), String(text));
    refs.toastWrap.append(t);
    requestAnimationFrame(() => t.classList.add("hud-toast--show"));
    const timer = setTimeout(() => {
      t.classList.add("hud-toast--leaving");
      const rm = setTimeout(() => {
        t.remove();
        toastTimers.delete(rm);
      }, TOAST_FADE_MS);
      toastTimers.add(rm);
      toastTimers.delete(timer);
    }, TOAST_LIFETIME_MS);
    toastTimers.add(timer);
  }

  function dispose() {
    document.removeEventListener("keydown", onKeyDown);
    if (voiceCueTimer !== null) {
      clearTimeout(voiceCueTimer);
      voiceCueTimer = null;
    }
    if (boundaryObserver) {
      boundaryObserver.disconnect();
      boundaryObserver = null;
    }
    for (const id of toastTimers) clearTimeout(id);
    toastTimers.clear();
    timerRegistry.clear();
    railRows.clear();
    if (refs.overlay && refs.overlay.parentNode) refs.overlay.parentNode.removeChild(refs.overlay);
  }

  return {
    update,
    tick,
    pushFeed,
    setSelected,
    setConnected,
    setFps,
    setHint,
    setVoiceState,
    setVoiceVisual,
    toast,
    dispose,
    get selected() {
      return selectedKey;
    },
  };
}
