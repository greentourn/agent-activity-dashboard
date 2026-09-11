// public/brain/fixture.js
//
// ตัวสร้าง snapshot ปลอม "ที่มีชีวิต" สำหรับทดสอบ visualizer 3D ของ agent dashboard โดยไม่ต้องรอ
// session จริงวิ่ง — โครงสร้าง/ชนิดข้อมูลของทุก field ก็อปมาจาก GET /api/state ของจริงใน
// server.mjs (อ่าน + grep เทียบทีละ field ก่อนเขียนไฟล์นี้) เพราะ UI ตัวเดียวกัน
// ต้องกินได้ทั้งของจริงและของปลอมโดยไม่ต้องแก้โค้ด UI เลย
//
// ES module รันตรงในเบราว์เซอร์ — pure JS ห้าม import อะไรทั้งสิ้น
//
// จุดออกแบบสำคัญ:
//   - PRNG ทำเอง (mulberry32) seed จาก options.seed — ผลลัพธ์ต้อง "ซ้ำได้" ห้ามใช้ Math.random() ตรง ๆ
//   - เวลาเดินด้วยตัวนับภายใน (elapsedMs) คูณ speed ไม่ใช่ผูกกับนาฬิกาจริงทุกครั้ง — เร่งทดสอบได้
//   - session แต่ละอันมี "เครื่องสถานะ" ของตัวเอง (idle → thinking → tool → [spawn] → …) เดินจริง
//     ทุกครั้งที่ next() ถูกเรียก ไม่ใช่สุ่มค่า state ลอย ๆ ในแต่ละเฟรม
//   - sub-agent เก็บเป็น array แบนต่อ session (ตามพฤติกรรมของจริง — ไฟล์ transcript ของลูกอยู่แบน
//     ทั้งหมดใต้ subagents/ ไม่ว่าจะลึกกี่ชั้น) แล้วผูกต้นไม้ด้วย parentAgentId/depth เท่านั้น

// ---------------------------------------------------------------------------
// PRNG — mulberry32 (seed-based, ทำเองตามข้อกำหนด ห้ามใช้ Math.random() ตรง ๆ)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ค่าคงที่ก็อปจากของจริงใน server.mjs — ต้องตรงเป๊ะเพื่อให้ icon/label หน้าตาเหมือนของจริง
// ---------------------------------------------------------------------------

const TOOL_ICONS = {
  Agent: "🤖",
  Artifact: "📊",
  AskUserQuestion: "🙋",
  Bash: "⌨️",
  Edit: "✏️",
  Glob: "🔍",
  Grep: "🔍",
  Monitor: "👁️",
  MultiEdit: "✏️",
  NotebookEdit: "📓",
  PowerShell: "⌨️",
  Read: "📖",
  Skill: "🧩",
  Task: "🤖",
  TodoWrite: "☑️",
  ToolSearch: "🧰",
  WebFetch: "🌐",
  WebSearch: "🌐",
  Workflow: "🕸️",
  Write: "📝",
};

function toolIcon(name) {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (typeof name === "string" && name.startsWith("mcp__")) return "🔌";
  return "🔧";
}

// 8 หมวด error จริงที่วัดได้จาก state.json ของจริง (id/label/fix เป๊ะ — n/tokens นับเองในไฟล์นี้)
const ERROR_KINDS = [
  { id: "other", label: "อื่น ๆ", fix: "—" },
  { id: "path-missing", label: "path ไม่มีจริง (cwd ไม่ใช่ที่คิด)", fix: "ใช้ path absolute หรือ `git -C <repo>` เสมอ" },
  {
    id: "tool-param",
    label: "พารามิเตอร์ของ tool ผิด / schema ไม่ตรง",
    fix: "ลอกรูปทรงจากเอกสารของ tool ห้ามเดาชื่อฟิลด์ (StructuredOutput: เขียนชื่อฟิลด์ลงในพรอมป์ต)",
  },
  { id: "edit-no-match", label: "Edit: หา old_string ไม่เจอ", fix: "Read ไฟล์จริงก่อนแก้ทุกครั้ง — อย่าเชื่อว่าไฟล์หน้าตาแบบที่จำไว้" },
  { id: "exit-1", label: "exit code 1", fix: "อ่าน stderr ก่อนสั่งใหม่ — บางครั้งคำสั่งสำเร็จแล้ว" },
  {
    id: "search-not-found",
    label: "คำสั่งค้นไม่เจอ → exit 2 (คำสั่งทำงานถูกแล้ว)",
    fix: "ปิดท้ายด้วย `|| true` — ผลลัพธ์ที่ได้มาถูกอยู่แล้ว ไม่ต้องสั่งใหม่",
  },
  {
    id: "shell-syntax",
    label: "shell syntax / heredoc พัง",
    fix: "สคริปต์ยาวเขียนเป็นไฟล์ใน scratchpad แล้ว `node <path>` — ห้าม heredoc ซ้อน quote",
  },
  { id: "read-too-big", label: "Read ไฟล์ใหญ่เกินเพดาน", fix: "ใส่ `offset`/`limit` — เพดาน 25,000 โทเค็นต่อครั้ง" },
];

function errorKindInfo(id) {
  return ERROR_KINDS.find((e) => e.id === id) || ERROR_KINDS[0];
}

// denyKind เป็น enum ปิดตายตัว 3 ค่าเท่านั้น (ของจริงจาก DENY_LABEL ใน server.mjs) — "rule" ต่างหาก
// คือรหัสด่าน (G1, P1, ...) ที่ดึงมาจากข้อความจริง ไม่ใช่ตัว denyKind เอง
const DENY_KIND_LABELS = {
  "permission-rule": "ถูก guard hook บล็อก",
  "user-rejected": "ผู้ใช้กดปฏิเสธ",
  "automode-blocked": "auto mode บล็อก",
};
const DENY_KINDS = Object.keys(DENY_KIND_LABELS);
const DENY_RULES = ["permission-denied", "pre-tool-hook", "protected-path", "rate-limited", "confirm-required"];

const SUBAGENT_TYPES = ["scout", "test-runner", "researcher", "task-tracker", "doc-writer", "code-editor", "analyst", "code-reviewer", "workflow-subagent"];
// น้ำหนักคร่าว ๆ ให้ตัวที่ทำหน้าที่ค้นหาถูก spawn บ่อยที่สุด — ตรงกับที่เจอในทะเบียน agent จริง
const SUBAGENT_TYPE_WEIGHTS = [40, 10, 8, 6, 6, 6, 10, 2, 12];

// model + modelTag คู่กัน (ไม่ derive จาก substring เพื่อกันพลาด — ของจริงมีแค่ 4 ตัวนี้)
const MODEL_CHOICES = [
  { model: "haiku", tag: "HA" },
  { model: "sonnet-5", tag: "SO" },
  { model: "opus-5", tag: "OP" },
  { model: "fable", tag: "FA" },
];
const MODEL_CHOICE_WEIGHTS = [55, 30, 12, 3];

const SESSION_MODEL_IDS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6"];
const EFFORT_CHOICES = ["high", "xhigh", "medium"];
const ENTRYPOINT_CHOICES = ["claude-vscode", "claude-cli"];

const CWD_SAMPLES = [
  "C:\\Users\\dev\\projects\\web-app",
  "C:\\Users\\dev\\projects\\api-server",
  "/home/dev/projects/mobile-app",
  "/Users/dev/code/design-system",
  "/home/dev/code/infra",
];
const BRANCH_SAMPLES = [
  "feat/agent-dashboard-threejs-ui",
  "develop",
  "main",
  "feat/ipd-paperless-forms",
  "fix/or-reschedule-history",
  "master",
];
const NAME_WORDS = ["nova", "atlas", "forge", "brain", "vision", "sprout", "harbor", "delta"];

const TASK_SAMPLES = [
  "อ่านไฟล์ server.mjs แล้วสรุปโครงสร้าง JSON ที่ API ส่งออกไปให้หน้าเว็บ พร้อม file:line",
  "หาว่า field นี้ถูกใช้ที่ไหนบ้างในโค้ดเบส ไล่ import/call chain ให้ครบ",
  "ยืนยัน field/enum ของ endpoint นี้จาก Scalar spec ที่ deploy จริงบน dev host",
  "สร้าง task ใหม่ในบอร์ดติดตามงาน พร้อมกำหนด sprint และประมาณเวลาให้ครบ",
  "แก้ไฟล์ตามสเปกที่เคาะแล้ว เฉพาะไฟล์ใน allow-list ที่ระบุมา แล้วรัน gate ที่ scope ไว้",
  "ตรวจว่าโครงผังใหม่เร็วขึ้นจริงไหม — วัดของจริงจากไฟล์และ log ไม่เชื่อคำอ้าง",
  "ไล่ root cause ข้าม repo ของบั๊กนี้ เทียบ FE↔BE contract ให้ตรงกัน",
  "รัน gate ที่ scope ไว้แล้วรายงานแค่เขียว/แดง พร้อมบรรทัดที่พัง",
  "ค้นว่ามีไลบรารีนี้อยู่ในเครื่อง/workspace แล้วหรือยัง ก่อนจะ vendor เพิ่ม",
  "สรุปว่า dashboard นี้ทำอะไร ข้อมูลมาจากไหน วิธีรัน และกฎการแก้ไฟล์",
];
const LABEL_SAMPLES = [
  "server.mjs agent data model",
  "event signals for animation",
  "README dashboard usage",
  "index.html UI architecture",
  "three.js availability offline",
  "server.mjs HTTP routes + static",
  "เปิด task ใหม่ในบอร์ด",
  "ตรวจ gate ก่อน push",
  "verify API contract ก่อนแก้ FE",
  "ไล่ root cause ข้าม repo",
];
const ANSWER_SAMPLES = [
  "ตรวจของจริงครบแล้ว — สรุปพร้อม file:line ตามที่ขอทุกข้อ",
  "Confirmed. Task created and verified พร้อมลิงก์ + สถานะ",
  "ครบทั้งหมดแล้ว — พอสำหรับขับ animation ตามบริบทจริง",
  "ยังไม่ผ่าน — มี blocker 1 ข้อ รายละเอียดอยู่ในรายงาน",
  "All gates green, repo working tree byte-identical to baseline",
  "พบข้อสำคัญที่พลาดไปตอนแรก — แก้ไขและยืนยันซ้ำแล้ว",
];
const SAY_SAMPLES = [
  "ครบทุกด้านแล้ว กำลังสรุปคำตอบ",
  "เจอจุดที่ต้องแก้เพิ่ม กำลังตรวจต่อ",
  "gate ผ่านหมดแล้ว เตรียมส่งรายงาน",
  "พบความคลาดเคลื่อนเล็กน้อย กำลังเทียบกับ commit เขียว",
];
const THINKING_SAMPLES = [
  "กำลังเทียบ field ที่เจอกับของจริงในไฟล์ต้นทาง",
  "คิดว่าจะแตกงานนี้เป็นกี่ก้อนดี",
  "กำลังไล่ดูว่า parent ตัวไหนควรรับผิดชอบส่วนนี้",
  "ทบทวนว่ามี edge case ไหนที่ยังไม่ครอบคลุม",
];
const GENERIC_ACTIONS = [
  "ตรวจโครงสร้างไฟล์เป้าหมาย",
  "grep หา pattern ที่เกี่ยวข้อง",
  "อ่านผลลัพธ์ก่อนหน้าเทียบกับสเปก",
  "รัน gate ที่ scope ไว้",
  "ยืนยันค่าที่ได้กับของจริง",
];

// ---------------------------------------------------------------------------
// helper เล็ก ๆ ทั่วไป
// ---------------------------------------------------------------------------

function weightedPick(rand, items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function zeroTokens() {
  return { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, thinking: 0, requests: 0, errorRecovery: 0, partial: false };
}

function sumTokensList(list) {
  const out = zeroTokens();
  for (const t of list) {
    if (!t) continue;
    out.input += t.input || 0;
    out.cacheCreate += t.cacheCreate || 0;
    out.cacheRead += t.cacheRead || 0;
    out.output += t.output || 0;
    out.thinking += t.thinking || 0;
    out.requests += t.requests || 0;
    out.errorRecovery += t.errorRecovery || 0;
  }
  return out;
}

/** เพิ่ม token แบบสมจริง: cacheRead โตเร็วสุด (~90% ของก้อนที่เพิ่ม), output โตช้าสุด */
function bumpTokens(rand, t, n = 1) {
  for (let i = 0; i < n; i++) {
    t.input += Math.floor(rand() * 8) + 1;
    t.cacheCreate += Math.floor(rand() * 1000) + 200;
    t.cacheRead += Math.floor(rand() * 12000) + 4000;
    t.output += Math.floor(rand() * 190) + 30;
    t.thinking += Math.floor(rand() * 140) + 10;
    t.requests += 1;
  }
}

function mergeErrorStats(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const e of list) {
      const info = errorKindInfo(e.id);
      const cur = map.get(e.id) || { id: e.id, label: e.label || info.label, fix: e.fix || info.fix, n: 0, tokens: 0 };
      cur.n += e.n;
      cur.tokens += e.tokens;
      map.set(e.id, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens);
}

function bumpErrorStat(list, id, tokens) {
  let e = list.find((x) => x.id === id);
  if (!e) {
    const info = errorKindInfo(id);
    e = { id: info.id, label: info.label, fix: info.fix, n: 0, tokens: 0 };
    list.push(e);
  }
  e.n += 1;
  e.tokens += tokens;
}

// ---------------------------------------------------------------------------
// createFixture
// ---------------------------------------------------------------------------

export function createFixture(options = {}) {
  const cfg = {
    sessions: Math.max(1, options.sessions ?? 2),
    maxDepth: Math.max(1, options.maxDepth ?? 4),
  };
  let speed = options.speed ?? 1;
  let scenario = options.scenario ?? "auto";

  const rand = mulberry32(options.seed ?? 1337);
  const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const chance = (p) => rand() < p;

  const usedIds = new Set();
  function hexId(len) {
    let id;
    do {
      id = "";
      for (let i = 0; i < len; i++) id += "0123456789abcdef"[Math.floor(rand() * 16)];
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  }
  function agentId() {
    return hexId(18);
  }
  const usedSessionIds = new Set();
  function sessionId() {
    let id;
    do {
      id = `${hexId(8)}-${hexId(4)}-${hexId(4)}-${hexId(4)}-${hexId(12)}`;
    } while (usedSessionIds.has(id));
    usedSessionIds.add(id);
    return id;
  }
  function workflowId() {
    return `wf_${hexId(8)}-${hexId(3)}`;
  }
  function nameGen() {
    return `${pick(NAME_WORDS)}-${hexId(2)}`;
  }

  // เวลาเดินด้วยตัวนับภายในเท่านั้น — Date.now() ถูกเรียกครั้งเดียวตรงนี้
  const startMs = Date.now();
  let elapsedMs = 0;
  const BASE_TICK_MS = 700;
  const PERMISSION_SUSPECT_MS = 25_000; // ค่าเดียวกับ server.mjs จริง
  const DELEGATION_TOOLS = new Set(["Agent", "Task"]);
  const EXPLICIT_USER_WAIT_TOOL = "AskUserQuestion";
  const EVENTS_SENT = 70;

  const logBuf = [];
  function log(msg) {
    logBuf.push(msg);
    if (logBuf.length > 50) logBuf.shift();
  }

  function nowVirtualMs() {
    return startMs + elapsedMs;
  }
  function isoNow() {
    return new Date(nowVirtualMs()).toISOString();
  }
  function isoAt(ms) {
    return new Date(ms).toISOString();
  }

  // ---- auto-scenario rotation ----
  const AUTO_ORDER = ["idle", "thinking", "cascade", "storm", "errors"];
  let autoIdx = 0;
  let autoUntilMs = nowVirtualMs() + 12_000;

  function currentForcedMode(sess) {
    if (!sess._isHero) return null;
    if (scenario === "auto") return AUTO_ORDER[autoIdx];
    return scenario;
  }

  // -------------------------------------------------------------------------
  // event push (ต่อ session)
  // -------------------------------------------------------------------------

  function pushEvent(sess, ev) {
    ev.i = ++sess._seq;
    ev.ts = isoNow();
    ev.hasDetail = ev.hasDetail === true;
    sess._events.push(ev);
    if (sess._events.length > 400) sess._events.splice(0, sess._events.length - 400);
    return ev;
  }

  // -------------------------------------------------------------------------
  // sub-agent: สร้าง / อัปเดต
  // -------------------------------------------------------------------------

  function createSubagent(sess, { parentAgentId, depth, wfId, forceType }) {
    const id = agentId();
    const model = weightedPick(rand, MODEL_CHOICES, MODEL_CHOICE_WEIGHTS);
    const type = forceType || weightedPick(rand, SUBAGENT_TYPES, SUBAGENT_TYPE_WEIGHTS);
    const useSidecarLabel = chance(0.6);
    const nowMs = nowVirtualMs();
    // ตัวลึก ๆ ทำงานสั้นกว่าตัวรากตามธรรมชาติ (ใบไม้ของต้นไม้ปิดงานเร็วกว่า)
    const durMs = randInt(6, 22) * 1000 - depth * 1500;
    const sub = {
      agentId: id,
      workflowId: wfId || null,
      type,
      label: useSidecarLabel ? pick(LABEL_SAMPLES) : "",
      labelSource: useSidecarLabel ? "sidecar" : chance(0.7) ? "prompt" : "fallback",
      model: model.model,
      modelTag: model.tag,
      depth,
      parentAgentId: parentAgentId || null,
      task: pick(TASK_SAMPLES),
      running: true,
      runningSource: "assumed-running",
      outcome: "",
      inFlight: 0,
      tools: 0,
      errors: 0,
      tokens: zeroTokens(),
      errorStats: [],
      startedTsMs: nowMs,
      lastTsMs: nowMs,
      current: null,
      lastTool: null,
      answer: "",
      // -------- internal only (ตัดออกตอน serialize) --------
      _endAtMs: nowMs + Math.max(2500, durMs),
      _nextToolChangeMs: nowMs + randInt(700, 2200),
      _spawnedChildren: false,
      _cascadeEligibleMs: nowMs + randInt(1500, 3500),
      _ring: [], // เก็บ event ล่าสุดของตัวเอง (สูงสุด 6 ตามของจริง — ส่งออกเฉพาะตอน running)
      _ringSeq: 0,
    };
    // ไม่มี description (sidecar) → label ว่าง แล้ว fallback เป็น "type + agentId 6 ตัวแรก" ด้านล่าง
    // (เลียนแบบ fallback จริงใน server.mjs: `${agentType} ${agentId.slice(0,6)}`)
    if (!sub.label) sub.label = `${type} ${id.slice(0, 6)}`;
    sess.subagents.push(sub);
    return sub;
  }

  function pushSubRing(sub, ev) {
    sub._ringSeq += 1;
    sub._ring.push({ i: sub._ringSeq, ts: isoAt(sub.lastTsMs), hasDetail: false, ...ev });
    if (sub._ring.length > 6) sub._ring.shift();
  }

  function spawnBatch(sess, { count, parentAgentId, depth, wfId, forceType, background }) {
    const created = [];
    for (let i = 0; i < count; i++) {
      created.push(createSubagent(sess, { parentAgentId, depth, wfId, forceType }));
    }
    const label =
      count >= 40
        ? `Storm spawn: ${count} sub-agents (โหมดทดสอบ storm)`
        : `Spawn ${count} sub-agent${count > 1 ? "s" : ""}${wfId ? " (workflow fan-out)" : ""}`;
    const startedAtMs = nowVirtualMs();
    const entry = {
      tool: "Agent",
      icon: "🤖",
      label,
      lane: "main",
      startedAtMs,
      batchIds: created.map((c) => c.agentId),
      background: Boolean(background),
      // background = true → tool_result กลับทันทีตอนเริ่ม (พฤติกรรมจริง); sync → รอจนลูกจบ
      endAtMs: background ? startedAtMs + randInt(400, 900) : null,
    };
    sess._running.push(entry);
    sess.counts.tools += 1;
    pushEvent(sess, { kind: "tool", lane: "main", tool: "Agent", icon: "🤖", label, done: false, error: false, durMs: null, hasDetail: true });
    bumpTokens(rand, sess.tokens, 1);
    log(`spawn: session ${sess.name} → ${count} ตัว (depth ${depth}${wfId ? ", workflow" : ""})`);
    return created;
  }

  function triggerStorm(sess) {
    const wfId = workflowId();
    spawnBatch(sess, { count: 40, parentAgentId: null, depth: 1, wfId, background: true });
  }

  function triggerCascadeStep(sess) {
    if (!sess._cascade) sess._cascade = { level: 1, frontier: [] };
    const c = sess._cascade;
    if (c.level === 1) {
      const created = spawnBatch(sess, { count: 2, parentAgentId: null, depth: 1, background: chance(0.5) });
      c.frontier = created.map((a) => a.agentId);
      c.level = 2;
      log(`cascade: session ${sess.name} เปิด wave 1 (depth 1, ${created.length} ตัว)`);
      return;
    }
    if (c.level > cfg.maxDepth) {
      c.level = 1;
      c.frontier = [];
      log(`cascade: session ${sess.name} วนครบ maxDepth=${cfg.maxDepth} แล้ว รีเซ็ตต้นไม้ใหม่`);
      return;
    }
    const nextFrontier = [];
    for (const parentAgentId of c.frontier) {
      const parent = sess.subagents.find((s) => s.agentId === parentAgentId);
      if (!parent || parent.depth >= cfg.maxDepth) continue;
      const n = randInt(1, 2);
      for (let i = 0; i < n; i++) {
        const child = createSubagent(sess, { parentAgentId, depth: c.level, wfId: parent.workflowId });
        nextFrontier.push(child.agentId);
      }
      parent._spawnedChildren = true;
    }
    if (nextFrontier.length === 0) {
      c.level = 1;
      c.frontier = [];
      log(`cascade: session ${sess.name} ไม่มี parent เหลือให้แตกต่อ รีเซ็ตต้นไม้ใหม่`);
      return;
    }
    log(`cascade: session ${sess.name} เปิด wave depth ${c.level} (${nextFrontier.length} ตัว)`);
    c.frontier = nextFrontier;
    c.level += 1;
  }

  function triggerErrorsBurst(sess) {
    if (chance(0.5)) {
      // denial → จบเทิร์นแบบ blocked
      const denyKind = weightedPick(rand, DENY_KINDS, [70, 20, 10]);
      const rule = pick(DENY_RULES);
      const attemptedTool = pick(["Bash", "Edit", "Write"]);
      pushEvent(sess, {
        kind: "tool",
        lane: "main",
        tool: attemptedTool,
        icon: toolIcon(attemptedTool),
        label: `${attemptedTool}: ${pick(GENERIC_ACTIONS)}`,
        done: true,
        error: true,
        durMs: randInt(80, 400),
        hasDetail: true,
      });
      pushEvent(sess, {
        kind: "denied",
        lane: "main",
        denyKind,
        denyLabel: DENY_KIND_LABELS[denyKind],
        rule,
        text: `🔒 [${rule}] ถูกปฏิเสธโดยยาม — ${DENY_KIND_LABELS[denyKind]}`,
        hasDetail: true,
      });
      sess.counts.denials += 1;
      sess._running = [];
      sess._phase = "blocked";
      sess._endedBy = `guard:${rule}`;
      sess._blockedUntilMs = nowVirtualMs() + randInt(8000, 20000);
      log(`errors: session ${sess.name} ถูก deny (${rule}) → blocked`);
    } else {
      const failedTool = pick(["Bash", "PowerShell", "Edit", "Read"]);
      const kindInfo = pick(ERROR_KINDS);
      const tokensWasted = randInt(20000, 200000);
      pushEvent(sess, {
        kind: "tool",
        lane: "main",
        tool: failedTool,
        icon: toolIcon(failedTool),
        label: `${failedTool}: ${pick(GENERIC_ACTIONS)}`,
        done: true,
        error: true,
        durMs: randInt(80, 500),
        hasDetail: true,
      });
      pushEvent(sess, {
        kind: "error",
        lane: "main",
        tool: failedTool,
        errorKind: kindInfo.id,
        errorLabel: kindInfo.label,
        errorFix: kindInfo.fix,
        exitCode: chance(0.6) ? 1 : null,
        exitNote: "",
        text: `${kindInfo.label} — ${failedTool} ล้มเหลว`,
        hasDetail: true,
      });
      sess.counts.errors += 1;
      sess.tokens.errorRecovery += tokensWasted;
      bumpErrorStat(sess.errorStats, kindInfo.id, tokensWasted);
      log(`errors: session ${sess.name} เจอ error (${kindInfo.id})`);
    }
    bumpTokens(rand, sess.tokens, 1);
  }

  // -------------------------------------------------------------------------
  // session: สร้าง
  // -------------------------------------------------------------------------

  let sessionSeqNo = 0;

  function createSessionState(kind, opts = {}) {
    sessionSeqNo += 1;
    const nowMs = nowVirtualMs();
    const sess = {
      sessionId: sessionId(),
      pid: randInt(1000, 42000),
      name: nameGen(),
      title: "",
      alive: true,
      endedAgo: 0,
      kind,
      entrypoint: kind === "background" ? "background-task" : pick(ENTRYPOINT_CHOICES),
      version: "2.1.263",
      cwd: pick(CWD_SAMPLES),
      gitBranch: pick(BRANCH_SAMPLES),
      model: pick(SESSION_MODEL_IDS),
      effort: pick(EFFORT_CHOICES),
      startedAt: nowMs - randInt(5, 600) * 1000,
      lastTsMs: nowMs,
      counts: { tools: 0, errors: 0, denials: 0, prompts: 0 },
      tokens: zeroTokens(),
      errorStats: [],
      subagents: [],
      hasTranscript: true,
      // -------- internal-only (ไม่ export) --------
      _isHero: Boolean(opts.isHero),
      _transient: Boolean(opts.transient),
      _permanentEnded: Boolean(opts.permanentEnded),
      _phase: "idle",
      _phaseEndMs: nowMs + randInt(3000, 9000),
      _running: [],
      _events: [],
      _seq: 0,
      _cascade: null,
      _blockedUntilMs: 0,
      _endedBy: null,
      _endedAtVirtualMs: null,
      _removeAtVirtualMs: null,
      _nextStormAtMs: nowMs, // scenario "storm" เจาะจง → ยิงตั้งแต่เฟรมแรกเลย
      _nextCascadeAtMs: nowMs,
      _nextErrorAtMs: nowMs + randInt(1000, 3000),
    };
    pushEvent(sess, { kind: "say", lane: "main", text: pick(SAY_SAMPLES), hasDetail: false });
    return sess;
  }

  const sessions = [];

  // hero: ตัวหลักที่โชว์ทุก scenario แบบเข้มข้น
  const hero = createSessionState("interactive", { isHero: true });
  sessions.push(hero);

  // session ปกติเพิ่มตาม options.sessions (organic เฉย ๆ ไม่ถูกบังคับ scenario)
  for (let i = 1; i < cfg.sessions; i++) sessions.push(createSessionState("interactive"));

  // ข้อกำหนด #9: ต้องมี kind:"background" ปนมาด้วยเสมอ
  const backgroundSession = createSessionState("background");
  sessions.push(backgroundSession);

  // ข้อกำหนด #9: ต้องมี session alive:false (endedAgo > 0) ปนมาด้วยเสมอ — ถาวร ไม่ถูก prune ทิ้ง
  const endedSession = createSessionState("interactive", { permanentEnded: true });
  endedSession.alive = false;
  endedSession._endedAtVirtualMs = -randInt(2, 10) * 60_000; // "จบไปแล้ว" ตั้งแต่ก่อนเฟรมแรก
  endedSession.endedAgo = -endedSession._endedAtVirtualMs;
  endedSession._phase = "idle";
  sessions.push(endedSession);

  let transientCount = 0;
  let nextChurnCheckMs = nowVirtualMs() + randInt(15000, 25000);

  // -------------------------------------------------------------------------
  // tick: sub-agents
  // -------------------------------------------------------------------------

  function tickSubagents(sess) {
    const nowMs = nowVirtualMs();
    const wantCascade = currentForcedMode(sess) === "cascade" || scenario === "cascade";
    for (const sub of sess.subagents) {
      if (!sub.running) continue;
      sub.lastTsMs = nowMs;

      if (nowMs >= sub._endAtMs) {
        sub.running = false;
        sub.outcome = weightedPick(rand, ["ok", "ok", "ok", "ok", "error", "failed"], [40, 40, 40, 40, 8, 5]);
        sub.runningSource = pick(["task-notification", "journal-result", "own-stop_reason:end_turn"]);
        sub.inFlight = 0;
        sub.current = null;
        sub.answer = pick(ANSWER_SAMPLES);
        sub._ring = [];
        continue;
      }

      if (nowMs >= sub._nextToolChangeMs) {
        const tool = pick(["Bash", "Read", "Grep", "Glob", "Edit", "WebFetch"]);
        if (sub.current) {
          sub.lastTool = { tool: sub.current.tool, icon: sub.current.icon, label: sub.current.label, durMs: randInt(150, 2500), error: chance(0.08) };
          if (sub.lastTool.error) {
            sub.errors += 1;
            const kindInfo = pick(ERROR_KINDS);
            bumpErrorStat(sub.errorStats, kindInfo.id, randInt(5000, 60000));
          }
        }
        const label = `${tool}: ${pick(GENERIC_ACTIONS)}`;
        sub.current = { tool, icon: toolIcon(tool), label, startedTs: isoAt(nowMs) };
        sub.tools += 1;
        sub.inFlight = 1;
        bumpTokens(rand, sub.tokens, 1);
        pushSubRing(sub, { kind: "tool", tool, icon: toolIcon(tool), label, done: false, error: false, durMs: null });
        sub._nextToolChangeMs = nowMs + randInt(900, 2600);
      }

      // cascade: ลูกที่ยังไม่เคยแตกต่อ และยังไม่สุดความลึก อาจ spawn หลานเพิ่ม
      if (
        !sub._spawnedChildren &&
        sub.depth < cfg.maxDepth &&
        nowMs >= sub._cascadeEligibleMs &&
        (wantCascade ? chance(0.35) : chance(0.03))
      ) {
        sub._spawnedChildren = true;
        const n = randInt(1, 3);
        for (let i = 0; i < n; i++) {
          createSubagent(sess, { parentAgentId: sub.agentId, depth: sub.depth + 1, wfId: sub.workflowId });
        }
        log(`cascade(organic): ${sub.agentId.slice(0, 6)} แตกลูกอีก ${n} ตัว (depth ${sub.depth + 1})`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // tick: session ที่ยังมีชีวิต (เครื่องสถานะหลัก idle→thinking→tool→spawn→…)
  // -------------------------------------------------------------------------

  function startToolBatch(sess) {
    const n = randInt(1, 3);
    const nowMs = nowVirtualMs();
    for (let i = 0; i < n; i++) {
      const tool = pick(["Bash", "Read", "Grep", "Edit", "Write", "Glob", "WebFetch", "ToolSearch"]);
      const slow = chance(0.08); // เผื่อกรณี "waiting" (permission-suspect) ตามเกณฑ์จริง
      const dur = slow ? randInt(PERMISSION_SUSPECT_MS + 3000, PERMISSION_SUSPECT_MS + 15000) : randInt(400, 3200);
      const willError = chance(0.1);
      const label = `${tool}: ${pick(GENERIC_ACTIONS)}`;
      sess._running.push({ tool, icon: toolIcon(tool), label, lane: "main", startedAtMs: nowMs, endAtMs: nowMs + dur, willError });
      sess.counts.tools += 1;
      pushEvent(sess, { kind: "tool", lane: "main", tool, icon: toolIcon(tool), label, done: false, error: false, durMs: null, hasDetail: true });
    }
    bumpTokens(rand, sess.tokens, 1);
    sess._phase = "tool";
  }

  function finishRunningEntries(sess) {
    const nowMs = nowVirtualMs();
    const still = [];
    for (const r of sess._running) {
      if (r.batchIds) {
        // Agent spawn batch: background จบทันที, sync รอจนลูกทุกตัวจบ
        const done = r.endAtMs != null ? nowMs >= r.endAtMs : r.batchIds.every((id) => {
          const s = sess.subagents.find((x) => x.agentId === id);
          return !s || !s.running;
        });
        if (!done) {
          still.push(r);
          continue;
        }
        // ปิด tool event ที่เปิดไว้ตอน spawnBatch (แถวสุดท้ายที่ยัง done:false ของ Agent)
        for (let i = sess._events.length - 1; i >= 0; i--) {
          const ev = sess._events[i];
          if (ev.kind === "tool" && ev.tool === "Agent" && ev.done === false) {
            ev.done = true;
            ev.durMs = nowMs - r.startedAtMs;
            break;
          }
        }
        continue;
      }
      if (nowMs < r.endAtMs) {
        still.push(r);
        continue;
      }
      const durMs = nowMs - r.startedAtMs;
      for (let i = sess._events.length - 1; i >= 0; i--) {
        const ev = sess._events[i];
        if (ev.kind === "tool" && ev.tool === r.tool && ev.label === r.label && ev.done === false) {
          ev.done = true;
          ev.error = r.willError;
          ev.durMs = durMs;
          break;
        }
      }
      if (r.willError) {
        sess.counts.errors += 1;
        const kindInfo = pick(ERROR_KINDS);
        const tokensWasted = randInt(20000, 150000);
        sess.tokens.errorRecovery += tokensWasted;
        bumpErrorStat(sess.errorStats, kindInfo.id, tokensWasted);
        pushEvent(sess, {
          kind: "error",
          lane: "main",
          tool: r.tool,
          errorKind: kindInfo.id,
          errorLabel: kindInfo.label,
          errorFix: kindInfo.fix,
          exitCode: chance(0.6) ? 1 : null,
          exitNote: "",
          text: `${kindInfo.label} — ${r.tool} ล้มเหลว`,
          hasDetail: true,
        });
      }
    }
    sess._running = still;
  }

  function organicPhaseTransition(sess) {
    const nowMs = nowVirtualMs();
    if (sess._running.length > 0) return; // ยังมี tool ทำงานอยู่ ไม่ตัดสินใจใหม่

    if (sess._phase === "tool") {
      // เพิ่งเสร็จ batch tool — สุ่มก้าวต่อไป
      const roll = rand();
      if (roll < 0.15 && cfg.maxDepth >= 1) {
        const n = randInt(1, 4);
        spawnBatch(sess, { count: n, parentAgentId: null, depth: 1, background: chance(0.5) });
      } else if (roll < 0.2) {
        sess._phase = "idle";
        sess._phaseEndMs = nowMs + randInt(3000, 9000);
        sess._endedBy = "stop_reason:end_turn";
        pushEvent(sess, { kind: "say", lane: "main", text: pick(SAY_SAMPLES), hasDetail: false });
      } else {
        sess._phase = "thinking";
        sess._phaseEndMs = nowMs + randInt(2000, 5000);
        pushEvent(sess, { kind: "thinking", lane: "main", text: pick(THINKING_SAMPLES), hasDetail: false });
      }
      return;
    }

    if (sess._phase === "idle" && nowMs >= sess._phaseEndMs) {
      sess._phase = "thinking";
      sess._phaseEndMs = nowMs + randInt(2000, 5000);
      pushEvent(sess, { kind: "prompt", lane: "main", text: pick(TASK_SAMPLES), hasDetail: false });
      sess.counts.prompts += 1;
      return;
    }

    if (sess._phase === "thinking" && nowMs >= sess._phaseEndMs) {
      startToolBatch(sess);
      return;
    }

    if (sess._phase === "blocked" && nowMs >= sess._blockedUntilMs) {
      // มีคนมาปลดบล็อกแล้ว กลับไปคิดต่อ
      sess._phase = "thinking";
      sess._phaseEndMs = nowMs + randInt(2000, 5000);
      pushEvent(sess, { kind: "say", lane: "main", text: "ผู้ใช้ปลดบล็อกให้แล้ว ทำงานต่อ", hasDetail: false });
    }
  }

  function applyForcedMode(sess, mode) {
    const nowMs = nowVirtualMs();
    if (mode === "idle") {
      sess._running = [];
      sess._phase = "idle";
      sess._phaseEndMs = nowMs + 5000;
      return true; // ล็อก ไม่ให้ organic ตัดสินใจแทน
    }
    if (mode === "thinking") {
      if (sess._running.length === 0 && sess._phase !== "blocked") {
        sess._phase = "thinking";
        sess._phaseEndMs = Math.max(sess._phaseEndMs, nowMs + 2000);
      }
      return true;
    }
    if (mode === "storm") {
      if (nowMs >= sess._nextStormAtMs) {
        triggerStorm(sess);
        sess._nextStormAtMs = nowMs + randInt(7000, 12000);
      }
      return false; // ไม่ล็อก organic — ปล่อยให้ tool/thinking วนต่อได้ตามปกติ
    }
    if (mode === "cascade") {
      if (nowMs >= sess._nextCascadeAtMs) {
        triggerCascadeStep(sess);
        sess._nextCascadeAtMs = nowMs + randInt(2500, 4500);
      }
      return false;
    }
    if (mode === "errors") {
      if (sess._phase !== "blocked" && nowMs >= sess._nextErrorAtMs) {
        triggerErrorsBurst(sess);
        sess._nextErrorAtMs = nowMs + randInt(3000, 6000);
      }
      return false;
    }
    return false;
  }

  /**
   * ของจริง server.mjs จำกัด "finished sub-agents ที่ส่งขึ้นจอ" ไว้ที่ MAX_SUBAGENTS_SENT_DONE=24
   * (running ทุกตัวส่งครบเสมอ) เพื่อกันเฟรมบวม — แต่การทำแบบนั้นตรง ๆ ในนี้จะเสี่ยงทำให้
   * parentAgentId ของลูกที่ยังโชว์อยู่ชี้ไปหา parent ที่ถูกตัดออกไปแล้ว (หา "เจอ" ไม่ได้อีก) ซึ่งขัดกับ
   * ข้อกำหนดที่ต้อง "หาเจอเสมอ" ⇒ แทนที่จะตัดตอนส่ง เราตัด (ลบถาวร) เฉพาะ "ใบไม้ที่จบแล้วและไม่มีใคร
   * อ้างเป็น parent" ตัวเก่าสุดก่อน เมื่อ session หนึ่งสะสมเกิน CAP ตัว — คงความถูกต้องของโซ่พ่อ-ลูกไว้
   * เสมอ ในขณะที่ยังกันหน่วยความจำ/ขนาด JSON ไม่ให้บวมไม่จำกัดตอนรันยาว ๆ
   */
  function pruneOldSubagents(sess) {
    const CAP = 300;
    if (sess.subagents.length <= CAP) return;
    const referencedAsParent = new Set(sess.subagents.filter((s) => s.parentAgentId).map((s) => s.parentAgentId));
    const removable = sess.subagents
      .filter((s) => !s.running && !referencedAsParent.has(s.agentId))
      .sort((a, b) => a.lastTsMs - b.lastTsMs);
    let toRemove = sess.subagents.length - CAP;
    const removeIds = new Set();
    for (const s of removable) {
      if (toRemove <= 0) break;
      removeIds.add(s.agentId);
      toRemove -= 1;
    }
    if (removeIds.size) sess.subagents = sess.subagents.filter((s) => !removeIds.has(s.agentId));
  }

  function tickSession(sess) {
    if (!sess.alive) {
      sess.endedAgo = nowVirtualMs() - sess._endedAtVirtualMs;
      return;
    }
    tickSubagents(sess);
    finishRunningEntries(sess);
    pruneOldSubagents(sess);

    const mode = currentForcedMode(sess);
    let locked = false;
    if (mode) locked = applyForcedMode(sess, mode);

    // errors/storm scenario ที่ตั้งตรง ๆ (ไม่ใช่ auto) ให้ session อื่น ๆ ที่ไม่ใช่ hero ก็มีสีสันตามด้วย
    if (!sess._isHero) {
      if (scenario === "errors" && sess._phase !== "blocked" && chance(0.02)) triggerErrorsBurst(sess);
      if (scenario === "storm" && sess._running.length === 0 && chance(0.01)) triggerStorm(sess);
    }

    if (!locked) organicPhaseTransition(sess);

    sess.lastTsMs = nowVirtualMs();
  }

  // -------------------------------------------------------------------------
  // churn: session ใหม่เข้ามา / session หายไป
  // -------------------------------------------------------------------------

  function tickChurn() {
    const nowMs = nowVirtualMs();
    if (nowMs < nextChurnCheckMs) return;
    nextChurnCheckMs = nowMs + randInt(15000, 25000);

    // เอา transient ที่ครบเวลาถูกลบออกจากลิสต์ (= "session หายไป" จริง ๆ ไม่ใช่แค่ alive:false)
    for (let i = sessions.length - 1; i >= 0; i--) {
      const s = sessions[i];
      if (s._transient && !s.alive && s._removeAtVirtualMs != null && nowMs >= s._removeAtVirtualMs) {
        sessions.splice(i, 1);
        transientCount -= 1;
        log(`churn: session ${s.name} หายไปจากลิสต์แล้ว`);
      }
    }

    if (chance(0.5) && transientCount < 3) {
      const s = createSessionState("interactive", { transient: true });
      sessions.push(s);
      transientCount += 1;
      log(`churn: session ใหม่เข้ามา — ${s.name}`);
    } else {
      const candidates = sessions.filter((s) => s._transient && s.alive);
      if (candidates.length) {
        const s = pick(candidates);
        s.alive = false;
        s._endedAtVirtualMs = nowMs;
        s.endedAgo = 0;
        s._removeAtVirtualMs = nowMs + randInt(20000, 40000);
        log(`churn: session ${s.name} จบงานแล้ว (จะหายไปในอีกพัก)`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // serialize: ทำ session/sub-agent ภายในให้เป็นรูปทรงสาธารณะแบบเดียวกับ /api/state จริง
  // -------------------------------------------------------------------------

  function computeStatus(sess) {
    if (!sess.alive) {
      return { state: "idle", since: isoAt(sess.lastTsMs), running: [], endedBy: sess._endedBy || "process-exit" };
    }
    if (sess._phase === "blocked") {
      return { state: "blocked", since: isoAt(sess.lastTsMs), running: [], endedBy: sess._endedBy || "guard" };
    }
    if (sess._running.length > 0) {
      const running = sess._running.map((r) => ({
        tool: r.tool,
        icon: r.icon,
        label: r.label,
        startedTs: isoAt(r.startedAtMs),
        lane: r.lane || "main",
      }));
      const explicitUserWait = sess._running.find((r) => r.tool === EXPLICIT_USER_WAIT_TOOL);
      const ordinary = sess._running.filter(
        (r) => r.tool !== EXPLICIT_USER_WAIT_TOOL && !DELEGATION_TOOLS.has(r.tool),
      );
      const permissionSuspect = ordinary.find(
        (r) => nowVirtualMs() - r.startedAtMs > PERMISSION_SUSPECT_MS,
      );

      let state;
      let cause;
      if (explicitUserWait) {
        state = "waiting";
        cause = explicitUserWait;
      } else if (permissionSuspect) {
        state = "waiting";
        cause = permissionSuspect;
      } else if (ordinary.length) {
        state = "tool";
        cause = ordinary[0];
      } else {
        state = "delegating";
        cause = sess._running[0];
      }
      return { state, since: isoAt(cause.startedAtMs), running };
    }
    if (sess._phase === "idle") {
      return { state: "idle", since: isoAt(sess.lastTsMs), running: [], endedBy: sess._endedBy || "stop_reason:end_turn" };
    }
    return { state: "thinking", since: isoAt(sess.lastTsMs), running: [] };
  }

  function computeSubTotals(subagents) {
    const st = {
      total: 0,
      running: 0,
      done: 0,
      failed: 0,
      withErrors: 0,
      runningWithErrors: 0,
      errors: 0,
      tools: 0,
      tokens: zeroTokens(),
      onDisk: 0,
      truncated: 0,
      models: {},
      runningModels: {},
    };
    for (const s of subagents) {
      st.total += 1;
      st.onDisk += 1;
      st.tools += s.tools;
      st.tokens = sumTokensList([st.tokens, s.tokens]);
      st.models[s.modelTag] = (st.models[s.modelTag] || 0) + 1;
      const hasErrors = s.errors > 0;
      if (s.running) {
        st.running += 1;
        st.runningModels[s.modelTag] = (st.runningModels[s.modelTag] || 0) + 1;
        if (hasErrors) st.runningWithErrors += 1;
      } else {
        st.done += 1;
        if (s.outcome === "failed" || s.outcome === "error") st.failed += 1;
      }
      if (hasErrors) {
        st.withErrors += 1;
        st.errors += 1;
      }
    }
    return st;
  }

  function serializeSubagent(sub) {
    return {
      agentId: sub.agentId,
      workflowId: sub.workflowId,
      type: sub.type,
      label: sub.label,
      labelSource: sub.labelSource,
      model: sub.model,
      modelTag: sub.modelTag,
      depth: sub.depth,
      parentAgentId: sub.parentAgentId,
      task: sub.task,
      running: sub.running,
      runningSource: sub.runningSource,
      outcome: sub.outcome,
      inFlight: sub.running ? sub.inFlight : 0,
      tools: sub.tools,
      errors: sub.errors,
      tokens: { ...sub.tokens },
      errorStats: sub.errorStats.map((e) => ({ id: e.id, n: e.n, tokens: e.tokens })),
      startedTs: isoAt(sub.startedTsMs),
      lastTs: isoAt(sub.lastTsMs),
      durMs: Math.max(0, sub.lastTsMs - sub.startedTsMs),
      current: sub.current
        ? { tool: sub.current.tool, icon: sub.current.icon, label: sub.current.label, startedTs: sub.current.startedTs }
        : null,
      lastTool: sub.lastTool
        ? { tool: sub.lastTool.tool, icon: sub.lastTool.icon, label: sub.lastTool.label, durMs: sub.lastTool.durMs, error: sub.lastTool.error }
        : null,
      answer: sub.running ? "" : sub.answer,
      events: sub.running ? sub._ring.map((e) => ({ ...e })) : [],
    };
  }

  function serializeSession(sess) {
    const status = computeStatus(sess);
    const subTotals = computeSubTotals(sess.subagents);
    const subagentsPublic = sess.subagents.map(serializeSubagent);
    const ownErrorStats = sess.errorStats.map((e) => ({ id: e.id, label: e.label, fix: e.fix, n: e.n, tokens: e.tokens }));
    const subErrorLists = sess.subagents.map((s) => s.errorStats);
    return {
      sessionId: sess.sessionId,
      pid: sess.pid,
      name: sess.name,
      title: sess.title,
      alive: sess.alive,
      endedAgo: Math.max(0, Math.round(sess.endedAgo)),
      kind: sess.kind,
      entrypoint: sess.entrypoint,
      version: sess.version,
      cwd: sess.cwd,
      gitBranch: sess.gitBranch,
      model: sess.model,
      effort: sess.effort,
      startedAt: sess.startedAt,
      lastTs: isoAt(sess.lastTsMs),
      counts: { ...sess.counts },
      tokens: { ...sess.tokens },
      errorStats: mergeErrorStats([ownErrorStats, ...subErrorLists]),
      status,
      subagents: subagentsPublic,
      subTotals,
      events: sess._events.slice(-EVENTS_SENT).map((e) => {
        const out = {};
        for (const k of Object.keys(e)) out[k] = e[k];
        return out;
      }),
      hasTranscript: sess.hasTranscript,
    };
  }

  // -------------------------------------------------------------------------
  // usage (HUD) — รูปทรงเดียวกับของจริง พอให้ % อ่านได้
  // -------------------------------------------------------------------------

  const SESSION_WINDOW_MS = 5 * 3600_000;
  const WEEKLY_WINDOW_MS = 7 * 24 * 3600_000;
  const usageWindowStartMs = startMs - randInt(0, 3600_000);

  function buildUsage(totalTokens) {
    const nowMs = nowVirtualMs();
    const elapsed = nowMs - usageWindowStartMs;
    const remaining = Math.max(0, SESSION_WINDOW_MS - elapsed);
    const sessionPercent = Math.min(100, Math.round((elapsed / SESSION_WINDOW_MS) * 100));
    const weeklyPercent = Math.min(100, Math.round((elapsed / WEEKLY_WINDOW_MS) * 100 * 6));
    return {
      v: 2,
      source: "cache",
      fetchedAtMs: nowMs,
      limits: [
        { kind: "session", group: "session", percent: sessionPercent, severity: sessionPercent > 80 ? "high" : "normal", resetsAt: isoAt(usageWindowStartMs + SESSION_WINDOW_MS), isActive: true, scope: "" },
        { kind: "weekly_all", group: "weekly", percent: weeklyPercent, severity: "normal", resetsAt: isoAt(usageWindowStartMs + WEEKLY_WINDOW_MS), isActive: false, scope: "" },
        { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resetsAt: isoAt(usageWindowStartMs + WEEKLY_WINDOW_MS), isActive: false, scope: "Fable" },
      ],
      extraUsage: { enabled: false, utilization: null, spendLimitReached: false },
      sessionKnown: true,
      sessionEstimate: null,
      window: {
        startedAtMs: usageWindowStartMs,
        resetsAtMs: usageWindowStartMs + SESSION_WINDOW_MS,
        exact: true,
        elapsedMs: elapsed,
        remainingMs: remaining,
        tokens: { input: totalTokens.input, cacheCreate: totalTokens.cacheCreate, cacheRead: totalTokens.cacheRead, output: totalTokens.output, thinking: totalTokens.thinking, requests: totalTokens.requests },
        byModel: [
          { model: "claude-opus-5", billed: Math.round(totalTokens.output * 0.6) },
          { model: "claude-sonnet-5", billed: Math.round(totalTokens.output * 0.25) },
          { model: "claude-haiku-4-5-20251001", billed: Math.round(totalTokens.output * 0.1) },
          { model: "claude-sonnet-4-6", billed: Math.round(totalTokens.output * 0.05) },
        ],
      },
      cache: { fetchedAtMs: nowMs },
      live: { enabled: false, ok: false, error: null, lastTryMs: null, lastOkMs: null, nextTryMs: null },
    };
  }

  // -------------------------------------------------------------------------
  // next()
  // -------------------------------------------------------------------------

  function next() {
    const dtMs = BASE_TICK_MS * speed;
    elapsedMs += dtMs;
    const nowMs = nowVirtualMs();

    if (scenario === "auto" && nowMs >= autoUntilMs) {
      autoIdx = (autoIdx + 1) % AUTO_ORDER.length;
      autoUntilMs = nowMs + 12_000;
      log(`auto: สลับไปโหมด "${AUTO_ORDER[autoIdx]}"`);
    }

    for (const sess of sessions) tickSession(sess);
    tickChurn();

    const agentsPublic = sessions.map(serializeSession);

    const totals = {
      live: agentsPublic.filter((a) => a.alive).length,
      busy: agentsPublic.filter(
        (a) =>
          a.alive &&
          (a.status.state === "tool" ||
            a.status.state === "delegating" ||
            a.status.state === "thinking"),
      ).length,
      waiting: agentsPublic.filter((a) => a.alive && a.status.state === "waiting").length,
      subsRunning: agentsPublic.reduce((n, a) => n + a.subTotals.running, 0),
      subsTotal: agentsPublic.reduce((n, a) => n + a.subTotals.total, 0),
      toolsRunning: agentsPublic.reduce(
        (n, a) => n + a.status.running.length + a.subagents.reduce((m, s) => m + (s.running ? s.inFlight || 0 : 0), 0),
        0,
      ),
      tools: agentsPublic.reduce((n, a) => n + a.counts.tools + a.subTotals.tools, 0),
      errors: agentsPublic.reduce((n, a) => n + a.counts.errors, 0),
      denials: agentsPublic.reduce((n, a) => n + a.counts.denials, 0),
      tokens: sumTokensList(agentsPublic.flatMap((a) => [a.tokens, a.subTotals.tokens])),
    };
    totals.tokens.partial = false;

    const errorStats = mergeErrorStats(agentsPublic.map((a) => a.errorStats));

    return {
      nowIso: isoAt(nowMs),
      nowMs,
      totals,
      errorStats,
      usage: buildUsage(totals.tokens),
      agents: agentsPublic,
    };
  }

  return {
    next,
    setScenario(name) {
      scenario = name;
      autoIdx = 0;
      autoUntilMs = nowVirtualMs() + 12_000;
      log(`setScenario("${name}")`);
    },
    setSpeed(v) {
      speed = v;
      log(`setSpeed(${v})`);
    },
    get scenario() {
      return scenario;
    },
    get log() {
      return logBuf.slice(-50);
    },
  };
}
