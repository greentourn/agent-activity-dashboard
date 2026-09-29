// ทดสอบ public/pixel/world.js (PIXEL OFFICE) ด้วย node:test — world.js เป็น logic ล้วน (ไม่มี DOM/canvas)
// จึงรันใน Node ได้ตรง ๆ ไฟล์นี้ต้องเร็ว (< ~20 วิ) เพราะรันพร้อม test อื่นทั้งชุดด้วย `node --test`
//
// หลักของชุดทดสอบนี้: ตรวจ "สัญญา" ที่ scene/hud พึ่งพา (ชื่อ prop, ขนาด, ตำแหน่ง, caption ซื่อตรง,
// การล้าง Map) มากกว่ารายละเอียดภายใน — แต่ใช้ world.stats() (ที่ world.js เปิดไว้ให้เทสต์โดยเฉพาะ)
// เพื่อพิสูจน์ว่าไม่มีโครงสร้างภายในตัวไหนโตไม่มีเพดานในแท็บที่เปิดทิ้งไว้เป็นวัน
import test from "node:test";
import assert from "node:assert/strict";

import {
  TILE,
  PROP_SIZES,
  activityForTool,
  modelTagOf,
  sessionDisplayName,
  buildRoomLayout,
  findPath,
  createWorld,
} from "../public/pixel/world.js";
import { createFixture } from "../public/brain/fixture.js";

/*
 * world.js ครอบทุกขั้นด้วย try/catch แล้วรายงานผ่าน console.error("[pixel/world] …") เพื่อให้ลูปไม่ตาย
 * ⇒ exception ภายในจะ "ไม่หลุด" มาถึงเทสต์ — ต้องดักที่ console.error แทน ไม่งั้น "ไม่ throw" พิสูจน์อะไรไม่ได้
 */
const worldErrors = [];
const realConsoleError = console.error;
console.error = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("[pixel/world]")) {
    worldErrors.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "));
    return;
  }
  realConsoleError(...args);
};

/* ───────────────────────── ตัวช่วยสร้าง snapshot ───────────────────────── */

// นาฬิกา server ปลอม — คงที่ ไม่ผูกกับ Date.now() เพื่อให้ผลทุกรอบเหมือนเดิม
const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

/** session ขั้นต่ำที่ world.js ต้องใช้ (ฟิลด์อื่นในสเปกไม่จำเป็นต่อ logic) */
function session(id, over = {}) {
  const { status, ...rest } = over;
  return {
    sessionId: id,
    pid: 1,
    name: "",
    title: `room-${id}`,
    alive: true,
    endedAgo: 0,
    kind: "interactive",
    entrypoint: "claude-cli",
    cwd: `C:/work/${id}`,
    gitBranch: "main",
    model: "claude-opus-5",
    counts: { tools: 0, errors: 0, denials: 0, prompts: 1 },
    status: { state: "idle", since: iso(T0), running: [], ...(status || {}) },
    subagents: [],
    subTotals: null,
    events: [],
    ...rest,
  };
}

function sub(agentId, over = {}) {
  return {
    agentId,
    type: "scout",
    label: agentId,
    model: "haiku",
    modelTag: "HA",
    depth: 1,
    parentAgentId: null,
    running: true,
    outcome: "",
    errors: 0,
    startedTs: iso(T0),
    current: null,
    lastTool: null,
    events: [],
    ...over,
  };
}

function snap(agents, nowMs = T0) {
  return { nowMs, nowIso: iso(nowMs), totals: {}, agents };
}

/** เดินเวลาโลกไป `seconds` วิ ทีละ dt (เหมือนลูปเฟรมจริงที่ถูก clamp ≤ 0.1) */
function run(world, seconds, dt = 0.05) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) world.update(dt);
}

/** เก็บบรรทัดฟีดทั้งหมดที่ world เล่า */
function collect(world) {
  const lines = [];
  world.onNarrate((l) => lines.push(l));
  return lines;
}

const helpersOf = (world, sid) =>
  Array.from(world.characters.values()).filter((c) => c.sessionId === sid && c.role === "helper");

/** ความเร็วเดินสูงสุดต่อเฟรม (5.5 ช่อง/วิ × 0.05 วิ) — ขยับเกินนี้ในเฟรมเดียว = วาร์ป ไม่ใช่เดิน */
const MAX_STEP_PX = 5.5 * TILE * 0.05 + 1e-6;

/* ───────────────────────── ตาราง tool → กิจกรรม ───────────────────────── */

test("activityForTool follows the spec table for every listed tool", () => {
  // [tool, station, pose, icon] — ตรงกับตาราง "Tool → activity" ในสเปกทุกบรรทัด
  const table = [
    ["Read", "bookshelf", "read", "book"],
    ["Grep", "cabinet", "reach", "magnifier"],
    ["Glob", "cabinet", "reach", "magnifier"],
    ["Bash", "terminal", "type-stand", "terminal"],
    ["PowerShell", "terminal", "type-stand", "terminal"],
    ["Edit", "desk", "sit-type", "pencil"],
    ["MultiEdit", "desk", "sit-type", "pencil"],
    ["Write", "desk", "sit-type", "pencil"],
    ["NotebookEdit", "desk", "sit-type", "pencil"],
    ["WebFetch", "kiosk", "type-stand", "globe"],
    ["WebSearch", "kiosk", "type-stand", "globe"],
    ["TodoWrite", "whiteboard", "write-board", "checklist"],
    ["Workflow", "whiteboard", "write-board", "graph"],
    ["Agent", "delegate", "supervise", "robot"],
    ["Task", "delegate", "supervise", "robot"],
    ["AskUserQuestion", "phone", "phone", "question"],
    ["Skill", "toolbox", "reach", "wrench"],
    ["ToolSearch", "toolbox", "reach", "wrench"],
    ["Monitor", "cctv", "stand", "eye"],
    ["Artifact", "printer", "reach", "chart"],
  ];
  for (const [tool, station, pose, icon] of table) {
    const a = activityForTool(tool);
    assert.equal(a.station, station, `${tool}.station`);
    assert.equal(a.pose, pose, `${tool}.pose`);
    assert.equal(a.icon, icon, `${tool}.icon`);
    assert.equal(typeof a.verb, "string", `${tool}.verb`);
    assert.ok(a.verb.length > 0, `${tool}.verb non-empty`);
  }
  // คำกริยาภาษาไทยตามสเปก (ตัวที่ HUD/ฟีดโชว์)
  assert.equal(activityForTool("Read").verb, "อ่าน");
  assert.equal(activityForTool("Grep").verb, "ค้นหา");
  assert.equal(activityForTool("Bash").verb, "รันคำสั่ง");
  assert.equal(activityForTool("Edit").verb, "แก้ไฟล์");
  assert.equal(activityForTool("Write").verb, "เขียนไฟล์");
  assert.equal(activityForTool("WebSearch").verb, "ค้นเว็บ");
  assert.equal(activityForTool("TodoWrite").verb, "จดงาน");
  assert.equal(activityForTool("Workflow").verb, "วางแผนงาน");
  assert.equal(activityForTool("Agent").verb, "สั่งงานผู้ช่วย");
  assert.equal(activityForTool("AskUserQuestion").verb, "ถามคุณ");
  assert.equal(activityForTool("Skill").verb, "หยิบเครื่องมือ");
  assert.equal(activityForTool("Monitor").verb, "เฝ้าดู");
  assert.equal(activityForTool("Artifact").verb, "ทำรายงาน");
  // Monitor = ยืนใต้กล้อง "หันขึ้น"
  assert.equal(activityForTool("Monitor").dir, "up");
});

test("activityForTool: mcp__ prefix, unknown and junk input", () => {
  const m = activityForTool("mcp__github__create_issue");
  assert.deepEqual([m.station, m.pose, m.icon, m.verb], ["toolbox", "type-stand", "plug", "ใช้ปลั๊กอิน"]);
  for (const junk of ["SomethingNew", "", null, undefined, 42, {}, "mcp_", "read"]) {
    const a = activityForTool(junk);
    assert.deepEqual([a.station, a.pose, a.icon, a.verb], ["desk", "sit-type", "wrench", "ใช้เครื่องมือ"], String(junk));
  }
  // ชื่อที่ชนกับ property ของ Object.prototype ต้องไม่หลุดไปเจอของแปลก
  assert.equal(activityForTool("constructor").station, "desk");
  assert.equal(activityForTool("__proto__").station, "desk");
});

test("activityForTool returns a fresh, mutable copy every call", () => {
  const a = activityForTool("Read");
  const b = activityForTool("Read");
  assert.notEqual(a, b);
  assert.ok(!Object.isFrozen(a));
  a.station = "hacked";
  a.icon = "x";
  assert.equal(activityForTool("Read").station, "bookshelf");
  assert.equal(activityForTool("Read").icon, "book");
  const u = activityForTool("nope");
  u.station = "hacked";
  assert.equal(activityForTool("other").station, "desk");
  const m = activityForTool("mcp__a");
  m.icon = "hacked";
  assert.equal(activityForTool("mcp__b").icon, "plug");
});

test("modelTagOf derives the tag by substring, case-insensitive", () => {
  assert.equal(modelTagOf("claude-opus-5"), "OP");
  assert.equal(modelTagOf("claude-sonnet-5"), "SO");
  assert.equal(modelTagOf("claude-sonnet-4-6"), "SO");
  assert.equal(modelTagOf("claude-haiku-4-5-20251001"), "HA");
  assert.equal(modelTagOf("haiku"), "HA");
  assert.equal(modelTagOf("Claude-FABLE"), "FA");
  assert.equal(modelTagOf("OPUS"), "OP");
  for (const junk of ["", "gpt-4", null, undefined, 5, {}, []]) assert.equal(modelTagOf(junk), "", String(junk));
});

test("sessionDisplayName fallback chain: title → name → basename(cwd) → sessionId[0..8]", () => {
  assert.equal(sessionDisplayName({ title: "My task", name: "n", cwd: "/a/b", sessionId: "abcdef123456" }), "My task");
  assert.equal(sessionDisplayName({ title: "", name: "worker", cwd: "/a/b", sessionId: "abcdef123456" }), "worker");
  assert.equal(sessionDisplayName({ title: "  ", name: "", cwd: "/a/proj/", sessionId: "abcdef123456" }), "proj");
  assert.equal(sessionDisplayName({ cwd: "G:\\Dudee Project\\agent-activity-dashboard\\", sessionId: "x" }), "agent-activity-dashboard");
  assert.equal(sessionDisplayName({ cwd: "", sessionId: "abcdef123456" }), "abcdef12");
  assert.equal(sessionDisplayName({ title: 7, name: null, cwd: {}, sessionId: "0123456789" }), "01234567");
  // ไม่มีอะไรเลย/ไม่ใช่ object → ยังคืนสตริงที่ไม่ว่าง (ห้ามพังหรือได้ "undefined")
  for (const junk of [null, undefined, 5, "str", {}]) {
    const name = sessionDisplayName(junk);
    assert.equal(typeof name, "string");
    assert.ok(name.length > 0);
    assert.ok(!name.includes("undefined"));
  }
  // ช่องว่าง/ขึ้นบรรทัดใหม่ถูกยุบเป็นบรรทัดเดียว
  assert.equal(sessionDisplayName({ title: "fix\n  the\tbug" }), "fix the bug");
});

test("sessionDisplayName truncates to ~28 chars without splitting emoji", () => {
  const long = "abcdefghijklmnopqrstuvwxyz0123456789";
  const t = sessionDisplayName({ title: long });
  assert.equal(Array.from(t).length, 28);
  assert.ok(t.endsWith("…"));
  assert.ok(long.startsWith(t.slice(0, -1)));
  // 30 อีโมจิ (แต่ละตัวเป็น surrogate pair) — ต้องไม่มีครึ่งตัวค้างอยู่ท้ายสตริง
  const emo = "😀".repeat(30);
  const e = sessionDisplayName({ title: emo });
  assert.equal(Array.from(e).length, 28);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(e), "no lone high surrogate");
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(e), "no lone low surrogate");
  assert.equal(e, "😀".repeat(27) + "…");
  // ยาวพอดี 28 → ไม่ตัด
  const exact = "x".repeat(28);
  assert.equal(sessionDisplayName({ title: exact }), exact);
  // ภาษาไทยก็นับตาม code point ไม่พัง
  const thai = "แก้บั๊กหน้าแดชบอร์ดให้แสดงผลถูกต้องทุกกรณี";
  const th = sessionDisplayName({ title: thai });
  assert.ok(Array.from(th).length <= 28);
});

/* ───────────────────────── ผังห้อง + A* ───────────────────────── */

const LAYOUT_ROWS = [2, 3, 4, 6, 14];

/** Dijkstra อ้างอิง (ช้าแต่ถูกแน่) — ใช้เทียบว่า A* ให้ค่าเดินรวมต่ำสุดจริง */
function dijkstraCost(grid, sx, sy, gx, gy) {
  const { w, h, blocked, cost } = grid;
  const dist = new Float64Array(w * h).fill(Infinity);
  const done = new Uint8Array(w * h);
  dist[sy * w + sx] = 0;
  for (;;) {
    let best = -1;
    for (let k = 0; k < w * h; k++) if (!done[k] && dist[k] < Infinity && (best < 0 || dist[k] < dist[best])) best = k;
    if (best < 0) return Infinity;
    if (best === gy * w + gx) return dist[best];
    done[best] = 1;
    const x = best % w;
    const y = (best / w) | 0;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nb = ny * w + nx;
      if (blocked[nb]) continue;
      const nd = dist[best] + ((cost && cost[nb]) || 1);
      if (nd < dist[nb]) dist[nb] = nd;
    }
  }
}

/** ตรวจเส้นทางจาก findPath: ต่อเนื่อง 4 ทิศ ไม่เหยียบช่องกีดขวาง (ยกเว้นช่องเริ่ม) — คืนค่าเดินรวม */
function checkPath(grid, path, sx, sy, gx, gy, label) {
  assert.ok(Array.isArray(path) && path.length > 0, `${label}: path exists`);
  assert.deepEqual(path[0], [sx, sy], `${label}: starts at start`);
  assert.deepEqual(path[path.length - 1], [gx, gy], `${label}: ends at goal`);
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const [x, y] = path[i];
    const [px, py] = path[i - 1];
    assert.ok(x >= 0 && y >= 0 && x < grid.w && y < grid.h, `${label}: in bounds`);
    assert.equal(Math.abs(x - px) + Math.abs(y - py), 1, `${label}: 4-neighbour step at ${i}`);
    assert.equal(grid.blocked[y * grid.w + x], 0, `${label}: step ${i} (${x},${y}) not blocked`);
    total += (grid.cost && grid.cost[y * grid.w + x]) || 1;
  }
  return total;
}

const rectsOverlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const footRect = (p) => ({ x0: p.tx, x1: p.tx + p.fw, y0: p.ty, y1: p.ty + p.fh });
/** กรอบ sprite (px): มุมซ้ายล่างของ sprite = มุมซ้ายล่างของ footprint แล้วสูงขึ้นไปตามขนาดใน PROP_SIZES */
function spriteRect(p) {
  const [w, h] = PROP_SIZES[p.name];
  const bottom = (p.ty + p.fh) * TILE;
  return { x0: p.tx * TILE, x1: p.tx * TILE + w, y0: bottom - h, y1: bottom };
}

test("buildRoomLayout: dimensions, walls and desk rows for several sizes", () => {
  for (const rows of LAYOUT_ROWS) {
    const L = buildRoomLayout(rows);
    assert.equal(L.w, 26);
    assert.equal(L.h, 7 + 3 * rows, `h for ${rows} rows`);
    assert.equal(L.deskRows, rows);
    assert.equal(L.grid.w, L.w);
    assert.equal(L.grid.h, L.h);
    assert.equal(L.grid.blocked.length, L.w * L.h);
    const B = (x, y) => L.grid.blocked[y * L.w + x];
    for (let x = 0; x < L.w; x++) {
      for (let y = 0; y < 3; y++) assert.equal(B(x, y), 1, `back wall (${x},${y})`);
      assert.equal(B(x, L.h - 1), 1, `front wall (${x})`);
    }
    // ประตูข้าง (ห้องที่โตเกิน 2 ชุดโต๊ะ): ทุก 2 ชุดโต๊ะถัดลงไป มีช่องประตูในผนังซ้ายที่แถว 13, 19, 25 …
    const sideRows = L.doors.filter((d) => d.tx === 0).map((d) => d.ty);
    const wantRows = [];
    for (let k = 1; 2 * k + 1 <= rows - 1; k++) wantRows.push(7 + 6 * k);
    assert.deepEqual(sideRows, wantRows, `side doors for ${rows} rows`);
    assert.equal(L.doors[0], L.door, "the main door is always doors[0]");
    for (let y = 0; y < L.h; y++) {
      assert.equal(B(0, y), sideRows.includes(y) ? 0 : 1, `left wall row ${y}`);
      assert.equal(B(L.w - 1, y), 1, `right wall row ${y}`);
    }
    // แถว 4 = ทางเดินหลักยาวตลอดห้อง (เชื่อมทุกสถานี)
    for (let x = 1; x < L.w - 1; x++) assert.equal(B(x, 4), 0, `main corridor (${x},4)`);
    assert.equal(L.desks.length, rows * 5);
    L.desks.forEach((d, i) => {
      assert.equal(d.index, i);
      assert.equal(d.owner, null);
      assert.equal(d.seat.ty, d.ty - 1, "seat row is right above the desk row");
      assert.equal(d.seat.tx, d.tx);
      assert.ok(d.tx + 1 < 19, "helper desks stay left of the lead zone");
      assert.ok(d.ty < L.h - 1);
    });
  }
  // จำนวนแถวต่ำสุด 2 และค่าขยะไม่ทำให้พัง
  for (const junk of [0, 1, -5, NaN, undefined, "x"]) assert.equal(buildRoomLayout(junk).deskRows, 2, String(junk));
  assert.equal(buildRoomLayout("4").deskRows, 4);
  assert.equal(buildRoomLayout(3.7).deskRows, 3);
});

test("buildRoomLayout: desk positions are identical across sizes (seated helpers never move)", () => {
  const big = buildRoomLayout(14);
  for (const rows of LAYOUT_ROWS) {
    const L = buildRoomLayout(rows);
    L.desks.forEach((d, i) => {
      const b = big.desks[i];
      assert.deepEqual([d.tx, d.ty, d.seat.tx, d.seat.ty, d.seat.x, d.seat.y], [b.tx, b.ty, b.seat.tx, b.seat.ty, b.seat.x, b.seat.y]);
    });
    // ส่วนบนของห้อง (สถานี ประตู โซนหัวหน้า) ไม่ขยับเลยเมื่อห้องโต
    assert.deepEqual(L.door, big.door);
    assert.deepEqual(L.leadSeat, big.leadSeat);
    assert.deepEqual(L.stations, big.stations);
  }
});

test("buildRoomLayout: props match the catalog (names, sizes, variants) and never overlap", () => {
  for (const rows of LAYOUT_ROWS) {
    const L = buildRoomLayout(rows);
    const ids = new Set();
    for (const p of L.props) {
      assert.ok(!ids.has(p.id), `unique prop id ${p.id}`);
      ids.add(p.id);
      assert.ok(Object.prototype.hasOwnProperty.call(PROP_SIZES, p.name), `known prop ${p.name}`);
      assert.ok(["floor", "wall", "sorted"].includes(p.layer), `${p.id}.layer`);
      for (const f of ["tx", "ty", "fw", "fh", "sortY", "frame"]) assert.ok(Number.isFinite(p[f]), `${p.id}.${f}`);
      assert.equal(typeof p.variant, "string");
      // ความกว้าง sprite พอดีกับ footprint (นาฬิกาเล็กกว่าช่อง — ยอมให้แคบกว่าได้ แต่ไม่ล้นช่อง)
      const [pw, ph] = PROP_SIZES[p.name];
      assert.ok(pw <= p.fw * TILE && pw > (p.fw - 1) * TILE, `${p.id} sprite width ${pw} fits ${p.fw} tiles`);
      // ของบนผนังหลัง: ไม่ล้นขอบบนของห้อง
      if (p.ty + p.fh <= 3) assert.ok((p.ty + p.fh) * TILE - ph >= 0, `${p.id} fits on the wall`);
      if (p.name === "rug") assert.deepEqual([pw, ph], [p.fw * TILE, p.fh * TILE]);
    }
    const floor = L.props.filter((p) => p.ty >= 3 && p.layer !== "floor");
    const wall = L.props.filter((p) => p.ty + p.fh <= 3);
    assert.equal(floor.length + wall.length + L.props.filter((p) => p.layer === "floor").length, L.props.length);
    for (const group of [floor, wall]) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          assert.ok(!rectsOverlap(footRect(group[i]), footRect(group[j])), `${group[i].id} overlaps ${group[j].id}`);
        }
      }
    }
    // เฟอร์นิเจอร์สูงชิดผนังต้องไม่บังของแต่งผนัง (เหตุผลที่ PROP_SIZES ถูก export)
    for (const f of floor.filter((p) => p.ty === 3)) {
      for (const wp of wall) assert.ok(!rectsOverlap(spriteRect(f), spriteRect(wp)), `${f.id} sprite hides ${wp.id}`);
    }
    // footprint ของเฟอร์นิเจอร์ทุกชิ้นเป็นสิ่งกีดขวาง ยกเว้นที่นั่ง (เก้าอี้/โซฟา) ที่ต้องเดินเข้าไปนั่งได้
    const SEATS = new Set(["chair", "lead-chair", "couch", "side-door"]); // ช่องประตูข้าง = ทางเดิน
    for (const p of floor) {
      for (let dx = 0; dx < p.fw; dx++) {
        const k = p.ty * L.w + Math.floor(p.tx + dx);
        assert.equal(L.grid.blocked[k], SEATS.has(p.name) ? 0 : 1, `${p.id} footprint blocked=${!SEATS.has(p.name)}`);
      }
    }
    // variant เริ่มต้นตามแคตตาล็อก
    const byId = new Map(L.props.map((p) => [p.id, p]));
    assert.equal(byId.get("door").variant, "closed");
    assert.equal(byId.get("mailbox").variant, "empty");
    assert.equal(byId.get("terminal").variant, "idle");
    assert.equal(byId.get("whiteboard").variant, "clean");
    assert.equal(byId.get("lead-desk").variant, "off");
    assert.equal(L.props.filter((p) => p.name === "desk").length, rows * 5);
    assert.equal(L.props.filter((p) => p.name === "chair").length, rows * 5);
    // เก้าอี้ต้องวาดก่อนคนนั่ง (sortY ต่ำกว่าจุดนั่ง) และคนนั่งวาดก่อนโต๊ะ
    for (const d of L.desks) {
      const chair = byId.get(`chair-${d.index}`);
      const desk = byId.get(`desk-${d.index}`);
      assert.ok(chair.sortY < d.seat.y && d.seat.y < desk.sortY, `draw order chair < seated < desk (${d.index})`);
    }
    assert.ok(byId.get("lead-chair").sortY < L.leadSeat.y && L.leadSeat.y < byId.get("lead-desk").sortY);
  }
});

/** ทุกจุดที่ตัวละครอาจถูกส่งไปยืน/นั่งในห้องหนึ่ง (ตามผังที่ world.js ใช้จริง) */
function destinationsOf(L) {
  const out = [];
  const add = (label, tx, ty) => out.push({ label, tx, ty });
  add("door threshold", L.door.tx, L.door.ty);
  add("door threshold (right)", L.door.tx + 1, L.door.ty);
  for (const d of L.doors.slice(1)) {
    add(`${d.id} doorway`, d.tx, d.ty);
    add(`${d.id} mat`, d.tx + 1, d.ty);
  }
  add("lead seat", L.leadSeat.tx, L.leadSeat.ty);
  add("lead beside", L.spots.leadBeside.tx, L.spots.leadBeside.ty);
  for (const [name, st] of Object.entries(L.stations)) st.slots.forEach((s, i) => add(`${name}[${i}]`, s.tx, s.ty));
  for (const d of L.desks) {
    add(`desk ${d.index} seat`, d.seat.tx, d.seat.ty);
    add(`desk ${d.index} seat (right chair tile)`, d.seat.tx + 1, d.seat.ty);
    add(`desk ${d.index} beside`, d.beside.tx, d.beside.ty);
    add(`desk ${d.index} side`, d.side.tx, d.side.ty);
  }
  return out;
}

test("buildRoomLayout: every desk, seat, station slot and the door are reachable from the door", () => {
  for (const rows of LAYOUT_ROWS) {
    const L = buildRoomLayout(rows);
    const g = L.grid;
    const { tx: sx, ty: sy } = L.door;
    assert.equal(g.blocked[sy * g.w + sx], 0, "door threshold is walkable");
    for (const dst of destinationsOf(L)) {
      assert.equal(g.blocked[dst.ty * g.w + dst.tx], 0, `${dst.label} walkable (rows=${rows})`);
      const p = findPath(g, sx, sy, dst.tx, dst.ty);
      checkPath(g, p, sx, sy, dst.tx, dst.ty, `door → ${dst.label} (rows=${rows})`);
      // และเดินกลับไปประตูได้ (ผู้ช่วยที่ส่งงานเสร็จต้องออกจากห้องได้เสมอ)
      const back = findPath(g, dst.tx, dst.ty, sx, sy);
      checkPath(g, back, dst.tx, dst.ty, sx, sy, `${dst.label} → door (rows=${rows})`);
    }
    // ไม่มีช่องเดินได้ช่องไหนถูกขังเป็นเกาะ (ท่วมจากประตูแล้วต้องถึงทุกช่องที่ไม่ใช่สิ่งกีดขวาง)
    const seen = new Uint8Array(g.w * g.h);
    const q = [sy * g.w + sx];
    seen[q[0]] = 1;
    for (let i = 0; i < q.length; i++) {
      const k = q[i];
      const x = k % g.w;
      const y = (k / g.w) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const nb = ny * g.w + nx;
        if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h || seen[nb] || g.blocked[nb]) continue;
        seen[nb] = 1;
        q.push(nb);
      }
    }
    for (let k = 0; k < g.w * g.h; k++) {
      if (!g.blocked[k]) assert.equal(seen[k], 1, `tile (${k % g.w},${(k / g.w) | 0}) reachable (rows=${rows})`);
    }
  }
});

test("findPath returns minimum-cost paths (checked against Dijkstra) and detours around seats", () => {
  for (const rows of [2, 4]) {
    const L = buildRoomLayout(rows);
    const g = L.grid;
    const dests = destinationsOf(L);
    // จับคู่แบบกำหนดตายตัว (ไม่สุ่ม) ทั้งจากประตูและระหว่างจุดหมายด้วยกัน
    const pairs = dests.map((d, i) => [d, dests[(i * 7 + 3) % dests.length]]);
    pairs.push(...dests.map((d) => [{ tx: L.door.tx, ty: L.door.ty, label: "door" }, d]));
    for (const [a, b] of pairs) {
      const p = findPath(g, a.tx, a.ty, b.tx, b.ty);
      const got = checkPath(g, p, a.tx, a.ty, b.tx, b.ty, `${a.label} → ${b.label}`);
      assert.equal(got, dijkstraCost(g, a.tx, a.ty, b.tx, b.ty), `optimal cost ${a.label} → ${b.label} (rows=${rows})`);
    }
  }
  // ทางเดินหลักแถว 4 ถูกกว่าการเดินลัดผ่านแถวเก้าอี้ (ค่าเดิน 4) — A* ต้องไม่เลือกเดินทับเก้าอี้คนอื่น
  const L = buildRoomLayout(2);
  const p = findPath(L.grid, 1, 5, 18, 5);
  for (const [x, y] of p.slice(1, -1)) assert.equal(L.grid.cost[y * L.w + x], 1, `(${x},${y}) is plain floor`);
});

test("findPath edge cases: bad input, blocked goal, start==goal, blocked start, unreachable", () => {
  const L = buildRoomLayout(2);
  const g = L.grid;
  assert.equal(findPath(null, 1, 3, 2, 3), null);
  assert.equal(findPath({}, 1, 3, 2, 3), null);
  assert.equal(findPath(g, -1, 3, 2, 3), null);
  assert.equal(findPath(g, 1, 3, 99, 3), null);
  assert.equal(findPath(g, 1.5, 3, 2, 3), null);
  assert.equal(findPath(g, NaN, 3, 2, 3), null);
  assert.equal(findPath(g, 1, 3, 0, 0), null, "goal in the wall");
  assert.equal(findPath(g, 1, 3, 4, 3), null, "goal on the bookshelf");
  assert.deepEqual(findPath(g, 5, 4, 5, 4), [[5, 4]]);
  // ช่องเริ่มเป็นสิ่งกีดขวางได้ (ตัวละครที่ค้างอยู่หลังห้องหดต้องเดินออกมาได้)
  const out = findPath(g, 4, 3, 10, 4);
  checkPath(g, out, 4, 3, 10, 4, "blocked start");
  // เป้าหมายถูกล้อมจนเข้าไม่ถึง → null (และไม่ค้าง)
  const w = 7;
  const h = 7;
  const blocked = new Uint8Array(w * h);
  for (const [x, y] of [[3, 2], [2, 3], [4, 3], [3, 4]]) blocked[y * w + x] = 1;
  assert.equal(findPath({ w, h, blocked }, 0, 0, 3, 3), null);
  // กริดไม่มี cost → ทุกช่องค่า 1 = ระยะแมนฮัตตันบนที่โล่ง
  const open = findPath({ w, h, blocked: new Uint8Array(w * h) }, 0, 0, 6, 6);
  assert.equal(open.length, 13);
  // ผลลัพธ์ซ้ำได้ (บัฟเฟอร์ที่ใช้ซ้ำข้ามการเรียกต้องไม่ทำให้ผลเพี้ยน)
  const a = JSON.stringify(findPath(g, 1, 3, 21, 5));
  findPath(buildRoomLayout(14).grid, 1, 3, 15, 44);
  assert.equal(JSON.stringify(findPath(g, 1, 3, 21, 5)), a);
});

/* ───────────────────────── โลก: baseline / slot / bounds / pick ───────────────────────── */

test("first sync is a silent baseline: no narration, no beats, everyone placed at their live spot", () => {
  const world = createWorld();
  const lines = collect(world);
  const A = session("A", {
    status: {
      state: "tool",
      since: iso(T0 - 5000),
      running: [
        { tool: "Agent", icon: "🤖", label: "fan out", startedTs: iso(T0 - 9000) },
        { tool: "Read", icon: "📖", label: "src/app.js", startedTs: iso(T0 - 2000) },
      ],
    },
    // เหตุการณ์เก่าทั้งหมดต้องเป็นแค่ baseline — ไม่มีจดหมาย ไม่มี oops ไม่มีการเล่าย้อน
    events: [
      { i: 1, kind: "prompt", ts: iso(T0 - 20000), text: "do the thing" },
      { i: 2, kind: "tool", tool: "Grep", label: "TODO", durMs: 12, ts: iso(T0 - 9000) },
      { i: 3, kind: "error", ts: iso(T0 - 8000), text: "boom" },
      { i: 4, kind: "denied", ts: iso(T0 - 7000), denyLabel: "no" },
    ],
    counts: { tools: 5, errors: 2, denials: 1, prompts: 1 },
    subagents: [
      sub("h1", { current: { tool: "Bash", icon: "⌨️", label: "npm test", startedTs: iso(T0 - 1000) } }),
      sub("h2"),
      sub("h3", { startedTs: iso(T0 + 1) }),
      sub("d1", { running: false, outcome: "ok" }),
    ],
  });
  const B = session("B", { status: { state: "idle", since: iso(T0 - 1000), running: [] } });
  world.sync(snap([A, B]), { first: true });

  assert.deepEqual(lines, [], "no narration on the first sync");
  assert.equal(world.rooms.size, 2);
  // หัวหน้า 2 + ผู้ช่วยที่ running จริง 3 (d1 จบไปก่อนเราเห็น → นับแค่บนป้ายคะแนน ไม่ประดิษฐ์ตัว)
  assert.equal(world.characters.size, 5);
  assert.ok(!world.characters.has("A:d1"));
  assert.equal(world.effects.length, 0);
  const roomA = world.rooms.get("A");
  assert.deepEqual(roomA.score, { running: 3, done: 1, failed: 0, errors: 0, total: 4 });
  assert.equal(roomA.title, "room-A");
  assert.equal(roomA.subtitle, "A · main · claude-cli");
  assert.equal(roomA.modelTag, "OP");
  assert.equal(roomA.lightsOn, true);
  assert.equal(roomA.overflow, 0);

  // หัวหน้าอยู่ที่ชั้นหนังสือแล้ว (Read) — ไม่ได้เดินเข้าประตู
  const lead = world.characters.get("A");
  assert.ok(roomA.stations.bookshelf.slots.some((s) => s.x === lead.x && s.y === lead.y), "lead placed at the bookshelf");
  assert.equal(lead.pose, "read");
  assert.equal(lead.alpha, 1);
  assert.equal(lead.role, "lead");
  assert.equal(lead.look.modelTag, "OP");
  // ผู้ช่วยได้โต๊ะตามลำดับ startedTs (เสมอกัน → ตาม key) และอยู่ที่จุดของ tool จริงทันที
  const h1 = world.characters.get("A:h1");
  const h2 = world.characters.get("A:h2");
  const h3 = world.characters.get("A:h3");
  assert.deepEqual([h1.deskIndex, h2.deskIndex, h3.deskIndex], [0, 1, 2]);
  assert.equal(roomA.desks[1].owner, "A:h2");
  assert.ok(roomA.stations.terminal.slots.some((s) => s.x === h1.x && s.y === h1.y), "h1 at the terminal");
  assert.equal(h1.pose, "type-stand");
  assert.deepEqual([h2.x, h2.y], [roomA.desks[1].seat.x, roomA.desks[1].seat.y]);
  assert.equal(h2.pose, "sit-think");
  assert.equal(h2.parentKey, "A");
  assert.equal(h2.look.modelTag, "HA");
  const leadB = world.characters.get("B");
  assert.ok(world.rooms.get("B").stations.coffee.slots.some((s) => s.x === leadB.x && s.y === leadB.y), "idle lead at the coffee machine");
  assert.equal(leadB.pose, "sip");

  // เดินเวลาต่อ: ยังเงียบ ไม่มีใครเดิน ไม่มีเอฟเฟกต์ประตู/จดหมาย/ตราประทับ
  for (let i = 0; i < 60; i++) {
    world.update(0.05);
    for (const ch of world.characters.values()) {
      assert.equal(ch.moving, false, `${ch.key} should not walk after a silent baseline`);
      assert.equal(ch.alpha, 1);
    }
  }
  assert.deepEqual(lines, []);
  assert.ok(!world.effects.some((e) => ["poof", "letter", "stamp", "spark", "smoke"].includes(e.kind)));
  assert.equal(lead.pose, "read");
});

test("room slots are stable while the server re-sorts agents between polls", () => {
  const world = createWorld();
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((id) => session(id));
  world.sync(snap([a, b, c, d, e]), { first: true });
  const slots = () =>
    Object.fromEntries(Array.from(world.rooms.values(), (r) => [r.sessionId, [r.slot, r.tx, r.ty, r.x, r.y]]));
  const base = slots();
  assert.deepEqual(["a", "b", "c", "d", "e"].map((id) => base[id][0]), [0, 1, 2, 3, 4]);
  const lv = world.layoutVersion;
  for (const order of [[e, c, a, b, d], [b, d, e, a, c], [d, a, c, e, b]]) {
    world.sync(snap(order));
    run(world, 0.3);
    assert.deepEqual(slots(), base, "no room moves when only the order changes");
  }
  assert.equal(world.layoutVersion, lv, "re-sorting must not bump layoutVersion");
  // ห้องไม่ทับกันและมีทางเดินกั้นอย่างน้อย 2 ช่อง · ≈ ceil(sqrt(5·1.6)) = 3 คอลัมน์
  const rs = Array.from(world.rooms.values());
  assert.equal(new Set(rs.map((r) => r.tx)).size, 3);
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const A = rs[i];
      const B = rs[j];
      const gap = 2 * TILE;
      const apart =
        A.tx + A.w * TILE + gap <= B.tx || B.tx + B.w * TILE + gap <= A.tx || A.ty + A.h * TILE + gap <= B.ty || B.ty + B.h * TILE + gap <= A.ty;
      assert.ok(apart, `${A.sessionId} and ${B.sessionId} keep a hallway between them`);
    }
  }
});

test("a removed session frees its slot (and everything it owned) for the next new session", () => {
  const world = createWorld();
  const lines = collect(world);
  const withSubs = (id) => session(id, { subagents: [sub("x1"), sub("x2")] });
  world.sync(snap([withSubs("a"), withSubs("b"), withSubs("c")]), { first: true });
  assert.equal(world.characters.size, 9);
  world.sync(snap([withSubs("a"), withSubs("c")]));
  assert.ok(!world.rooms.has("b"));
  assert.ok(!Array.from(world.characters.values()).some((ch) => ch.sessionId === "b"), "b's characters removed with its room");
  assert.equal(world.rooms.get("a").slot, 0);
  assert.equal(world.rooms.get("c").slot, 2);
  run(world, 0.5);
  world.sync(snap([withSubs("c"), session("d"), withSubs("a")]));
  assert.equal(world.rooms.get("d").slot, 1, "d takes the freed slot");
  assert.ok(lines.some((l) => l.text.includes("เปิดไฟห้อง room-d")), "new room turns its lights on");
  world.sync(snap([withSubs("c"), session("d"), withSubs("a"), session("e")]));
  assert.equal(world.rooms.get("e").slot, 3);
  assert.equal(world.stats().slots, 4);
  // ห้องใหม่ที่โผล่กลางทาง: หัวหน้าเดินเข้าประตู (ไม่ใช่วาร์ป) และค่อย ๆ ปรากฏ
  const leadD = world.characters.get("d");
  const roomD = world.rooms.get("d");
  assert.deepEqual([leadD.x, leadD.y], [roomD.door.x, roomD.door.y]);
  run(world, 1);
  assert.equal(leadD.alpha, 1);
});

test("bounds() encloses every room; worldPos() and pick() agree", () => {
  const world = createWorld();
  const empty = world.bounds();
  for (const k of ["x", "y", "w", "h"]) assert.ok(Number.isFinite(empty[k]), `empty bounds.${k}`);
  assert.ok(empty.w > 0 && empty.h > 0);
  world.sync(snap(["a", "b", "c", "d"].map((id) => session(id, { subagents: [sub("h1"), sub("h2")] }))), { first: true });
  const bb = world.bounds();
  for (const r of world.rooms.values()) {
    assert.ok(r.x >= bb.x && r.y >= bb.y, "room inside bounds (top-left)");
    assert.ok(r.x + r.w * TILE <= bb.x + bb.w && r.y + r.h * TILE <= bb.y + bb.h, "room inside bounds (bottom-right)");
  }
  const minX = Math.min(...Array.from(world.rooms.values(), (r) => r.x));
  assert.ok(bb.x < minX, "bounds keep a margin");
  for (const ch of world.characters.values()) {
    const p = world.worldPos(ch);
    const room = world.rooms.get(ch.sessionId);
    assert.deepEqual(p, { x: room.x + ch.x, y: room.y + ch.y });
    assert.deepEqual(world.worldPos(ch.key), p);
    assert.equal(world.pick(p.x, p.y - 10), ch.key, `pick ${ch.key}`);
    assert.equal(world.pick(p.x + 3, p.y - 18), ch.key, "the ~12×20 box, not just the feet");
  }
  assert.equal(world.pick(bb.x - 100, bb.y - 100), null);
  assert.equal(world.pick(NaN, 0), null);
  assert.equal(world.pick("x", 1), null);
  assert.equal(world.worldPos("nope"), null);
  assert.equal(world.worldPos(null), null);
  // สองคนซ้อนกัน → ได้ตัวที่อยู่หน้าสุด (sortY มากกว่า) · ตัวที่ยังโปร่งใสกดไม่ได้
  const h1 = world.characters.get("a:h1");
  const h2 = world.characters.get("a:h2");
  h2.x = h1.x;
  h2.y = h1.y + 4;
  h2.sortY = h1.sortY + 4;
  const p1 = world.worldPos(h1);
  assert.equal(world.pick(p1.x, p1.y - 8), "a:h2");
  h2.alpha = 0.1;
  assert.equal(world.pick(p1.x, p1.y - 8), "a:h1");
});

test("nowMs() estimates the server clock from the last snapshot plus elapsed world time", () => {
  const world = createWorld();
  assert.equal(world.nowMs(), 0);
  world.sync(snap([session("a")], T0), { first: true });
  assert.equal(world.nowMs(), T0);
  run(world, 2);
  assert.ok(Math.abs(world.nowMs() - (T0 + 2000)) < 1);
  world.sync(snap([session("a")], T0 + 700));
  assert.equal(world.nowMs(), T0 + 700);
  // ไม่มี nowMs → ใช้ nowIso แทน
  world.sync({ nowIso: iso(T0 + 5000), agents: [session("a")] });
  assert.equal(world.nowMs(), T0 + 5000);
});

test("sync/update/voice are defensive against junk input", () => {
  const world = createWorld();
  for (const junk of [null, undefined, 5, "x", {}, { agents: "nope" }, { agents: null }]) world.sync(junk);
  assert.equal(world.rooms.size, 0);
  const agents = [null, 5, {}, { sessionId: "" }, { sessionId: 7 }, { sessionId: "ok" }, { sessionId: "ok", title: "dup" }];
  world.sync({ nowMs: T0, agents }, { first: true });
  assert.equal(world.rooms.size, 1, "only one valid, de-duplicated session");
  const lead = world.characters.get("ok");
  assert.equal(lead.state, "unknown");
  assert.equal(lead.bubble && lead.bubble.icon, "question", "unknown state shows a dim question mark");
  assert.equal(lead.caption.text, "ไม่ทราบสถานะ");
  world.sync({
    nowMs: T0 + 700,
    agents: [
      {
        sessionId: "ok",
        status: { state: "weird", running: "no", since: "not a date" },
        subagents: [null, 1, { agentId: 5 }, { agentId: "x", running: true, current: "bad", events: "nope", startedTs: {} }],
        events: [null, { i: "a" }, { i: 3, kind: "prompt" }],
        counts: { errors: "lots", denials: null },
        model: 42,
      },
    ],
  });
  world.voice(null);
  world.voice({ sessionId: "ok", agentId: "missing", phase: "start" });
  for (const dt of [NaN, -1, 1e9, "x", undefined, 0.05]) world.update(dt);
  run(world, 2);
  for (const ch of world.characters.values()) {
    assert.ok(Number.isFinite(ch.x) && Number.isFinite(ch.y) && Number.isFinite(ch.sortY), ch.key);
  }
  // เฟรมที่ไม่มีรายการ agents = เฟรมพัง ไม่ใช่ "ทุกห้องปิด" → ภาพเดิมต้องยังอยู่
  world.sync({ nowMs: T0 + 1400 });
  assert.equal(world.rooms.size, 1);
});

/* ───────────────────────── บท "จ้างผู้ช่วย" ───────────────────────── */

/** ห้อง A ที่หัวหน้ากำลังสั่งงานผู้ช่วย (หรือสถานะอื่นตาม st) พร้อมรายการ sub ที่ให้มา */
function roomA(subs, st = "delegating", over = {}) {
  const running = st === "delegating" ? [{ tool: "Agent", icon: "🤖", label: "fan out", startedTs: iso(T0) }] : [];
  return session("A", { status: { state: st, since: iso(T0), running }, subagents: subs, ...over });
}

/** ช่องบนกริดใต้เท้าตัวละครต้องเดินได้เสมอ (ทั้งตอนเดินและตอนหยุด) */
function assertOnFloor(world, ch, label = "") {
  const room = world.rooms.get(ch.sessionId);
  const tx = Math.floor(ch.x / TILE);
  const ty = Math.floor(ch.y / TILE);
  assert.ok(tx >= 0 && ty >= 0 && tx < room.w && ty < room.h, `${ch.key} inside room ${label}`);
  assert.equal(room.grid.blocked[ty * room.w + tx], 0, `${ch.key} on a walkable tile (${tx},${ty}) ${label}`);
}

/**
 * เดินเวลาไปเรื่อย ๆ แล้วจดไทม์ไลน์ของตัวละครหนึ่งตัว (ท่า/ของในมือ/ตำแหน่ง) จนกว่าจะหายไปหรือครบเวลา
 * ท่าที่ซ้ำติดกันถูกยุบเหลือหนึ่งรายการ ⇒ เทียบลำดับเหตุการณ์ได้ตรง ๆ
 */
function trace(world, key, maxSeconds, onStep) {
  const steps = [];
  let t = 0;
  while (t < maxSeconds) {
    world.update(0.05);
    t += 0.05;
    const ch = world.characters.get(key);
    if (!ch) return { steps, removedAt: t };
    assertOnFloor(world, ch, `t=${t.toFixed(2)}`);
    const last = steps[steps.length - 1];
    if (!last || last.pose !== ch.pose || last.item !== ch.item) {
      steps.push({ pose: ch.pose, item: ch.item, x: ch.x, y: ch.y, t, face: ch.face });
    }
    if (onStep) onStep(ch, t);
  }
  return { steps, removedAt: null };
}

test("hire: a new running sub on a later sync appears at the door, walks to a stable desk; the hirer waves", () => {
  const world = createWorld();
  const lines = collect(world);
  world.sync(snap([roomA([])]), { first: true });
  run(world, 0.5);
  const room = world.rooms.get("A");
  const lead = world.characters.get("A");
  const leadPos = [lead.x, lead.y];

  world.sync(snap([roomA([sub("s1", { type: "researcher" })])], T0 + 700));
  const h = world.characters.get("A:s1");
  assert.ok(h, "helper created on the hire sync");
  assert.equal(h.y, room.door.y, "starts on the door threshold row");
  assert.ok(room.door.lanes.includes(h.x), "on one of the two threshold tiles");
  assert.equal(h.alpha, 0, "fades in, does not pop in");
  assert.equal(h.deskIndex, 0);
  assert.equal(room.desks[0].owner, "A:s1");
  assert.equal(h.parentKey, "A");
  assert.equal(h.role, "helper");
  assert.equal(h.type, "researcher");
  const hires = lines.filter((l) => l.icon === "🤝");
  assert.equal(hires.length, 1);
  assert.equal(hires[0].text, "room-A: รับผู้ช่วย 1 คน (researcher)");
  assert.equal(hires[0].tone, "spawn");
  assert.equal(hires[0].sessionId, "A");

  world.update(0.05);
  assert.ok(world.effects.some((e) => e.kind === "poof" && e.sessionId === "A"), "poof at the door");
  assert.equal(world.rooms.get("A").props.find((p) => p.id === "door").variant, "open", "door opens while someone is on it");
  // ผู้จ้างโบกมือ "อยู่กับที่" ~1.5 วิ (ระหว่างนั้นผู้ช่วยเดินจากประตูไปโต๊ะ — โต๊ะ 0 อยู่ใกล้ประตูมาก)
  const seat = room.desks[0].seat;
  let walked = false;
  for (let t = 0; t < 1.3; t += 0.05) {
    assert.equal(lead.pose, "wave");
    assert.equal(lead.moving, false);
    assert.deepEqual([lead.x, lead.y], leadPos);
    world.update(0.05);
    if (h.moving) walked = true;
    assertOnFloor(world, h);
  }
  for (let t = 0; t < 8 && !(h.x === seat.x && h.y === seat.y && !h.moving); t += 0.05) {
    world.update(0.05);
    if (h.moving) walked = true;
    assertOnFloor(world, h);
  }
  assert.ok(walked, "walked (not teleported) to the desk");
  assert.deepEqual([h.x, h.y], [seat.x, seat.y], "arrived at its own seat");
  run(world, 0.1);
  assert.equal(h.pose, "sit-think");
  assert.equal(h.alpha, 1);

  // ผู้ช่วยคนใหม่ในรอบต่อไป + server เรียงรายการใหม่ → คนเดิมยังได้โต๊ะเดิม
  world.sync(snap([roomA([sub("s2", { startedTs: iso(T0 - 5000) }), sub("s1", { type: "researcher" })])], T0 + 1400));
  assert.equal(h.deskIndex, 0, "existing helper keeps its desk");
  assert.equal(world.characters.get("A:s2").deskIndex, 1);
  world.sync(snap([roomA([sub("s1", { type: "researcher" }), sub("s2", { startedTs: iso(T0 - 5000) })])], T0 + 2100));
  assert.deepEqual([h.deskIndex, world.characters.get("A:s2").deskIndex], [0, 1]);
  assert.equal(lines.filter((l) => l.icon === "🤝").length, 2, "one hire line per real hire, none for re-sorts");
});

test("hire: a batch staggers its entrances; a sub hired by a sub reports to its parent", () => {
  const world = createWorld();
  const lines = collect(world);
  world.sync(snap([roomA([sub("p", { type: "researcher" })])]), { first: true });
  run(world, 0.2);
  const kids = ["k1", "k2", "k3"].map((id, i) =>
    sub(id, { type: i === 2 ? "analyst" : "scout", parentAgentId: "p", depth: 2, startedTs: iso(T0 + 100 + i) }),
  );
  world.sync(snap([roomA([sub("p", { type: "researcher" }), ...kids])], T0 + 700));
  const ks = ["A:k1", "A:k2", "A:k3"].map((k) => world.characters.get(k));
  assert.deepEqual(ks.map((c) => c.deskIndex), [1, 2, 3]);
  for (const c of ks) assert.equal(c.parentKey, "A:p");
  const hire = lines.filter((l) => l.icon === "🤝");
  assert.equal(hire.length, 1, "one line per hirer per sync");
  assert.equal(hire[0].text, "room-A: researcher·p รับผู้ช่วย 3 คน (scout, analyst)");
  assert.equal(hire[0].key, "A:p");
  world.update(0.1);
  // เข้าประตูเหลื่อมเวลากัน: คนแรกเริ่มปรากฏแล้ว คนสุดท้ายยังรอ
  assert.ok(ks[0].alpha > 0, "first one is fading in");
  assert.equal(ks[2].alpha, 0, "last one still waits its turn");
  assert.equal(world.characters.get("A:p").pose, "wave", "the parent helper waves");
  run(world, 1);
  for (const c of ks) assert.ok(c.alpha > 0, `${c.key} has entered`);
  // คนที่จบงานทั้งที่ยังไม่ทันโผล่ ถูกเอาออกทันที (ไม่เล่นบทส่งงานของคนที่ไม่เคยเห็น) และคืนโต๊ะ
  const w2 = createWorld();
  w2.sync(snap([roomA([])]), { first: true });
  const many = Array.from({ length: 8 }, (_, i) => sub(`m${i}`, { startedTs: iso(T0 + i) }));
  w2.sync(snap([roomA(many)], T0 + 700));
  w2.update(0.05);
  const lastKey = "A:m7";
  assert.equal(w2.characters.get(lastKey).alpha, 0);
  const desk = w2.characters.get(lastKey).deskIndex;
  w2.sync(snap([roomA(many.map((s) => (s.agentId === "m7" ? { ...s, running: false, outcome: "ok" } : s)))], T0 + 1400));
  assert.ok(!w2.characters.has(lastKey), "never-seen helper removed at once");
  assert.equal(w2.rooms.get("A").desks[desk].owner, null, "its desk is free again");
});

/* ───────────────────────── บท "ส่งงาน" ───────────────────────── */

/**
 * ตั้งห้อง A: หัวหน้า "กำลังคิด" (ยืนนิ่งที่ไวต์บอร์ด เป็นเป้าส่งงานที่ไม่ขยับ) + ผู้ช่วยตามรายการ
 * แล้วเปลี่ยน sub ตัวที่ระบุให้จบงานด้วย outcome ที่ให้ — คืน world, บรรทัดฟีด และไทม์ไลน์ของผู้ช่วยตัวนั้น
 */
function finishOne(outcome, { subs = [sub("s1"), sub("s2")], who = "s1", seconds = 25, gone = false } = {}) {
  const world = createWorld();
  const lines = collect(world);
  world.sync(snap([roomA(subs, "thinking")]), { first: true });
  run(world, 0.5);
  const key = `A:${who}`;
  const ch = world.characters.get(key);
  const desk = ch.deskIndex;
  const next = gone
    ? subs.filter((s) => s.agentId !== who)
    : subs.map((s) => (s.agentId === who ? { ...s, running: false, outcome, current: null } : s));
  world.sync(snap([roomA(next, "thinking")], T0 + 700));
  const after = { leaving: ch.leaving, state: ch.state, caption: { ...ch.caption } };
  const fx = new Set();
  const acks = [];
  let giveDist = null;
  const tr = trace(world, key, seconds, (c) => {
    for (const e of world.effects) fx.add(e.kind);
    if (c.pose === "give" && giveDist === null) {
      const hirer = world.characters.get(c.parentKey) || world.characters.get("A");
      giveDist = Math.abs(hirer.x - c.x) / TILE + Math.abs(hirer.y - c.y) / TILE;
    }
    for (const other of world.characters.values()) {
      if (other !== c && other.bubble && other.bubble.kind === "speech") acks.push({ key: other.key, ...other.bubble });
    }
  });
  return { world, lines, ch, desk, after, fx, acks, giveDist, ...tr };
}

const poseIndex = (steps, pred, from = 0) => {
  for (let i = from; i < steps.length; i++) if (pred(steps[i])) return i;
  return -1;
};

test("deliver (ok): celebrate → carry the report to the hirer → give → leave by the door → removed, desk freed", () => {
  const r = finishOne("ok");
  const okLines = r.lines.filter((l) => l.icon === "✅");
  assert.equal(okLines.length, 1);
  assert.equal(okLines[0].text, "room-A: scout·s1 ส่งงานให้หัวหน้าแล้ว");
  assert.equal(okLines[0].tone, "good");
  assert.equal(okLines[0].key, "A:s1");
  assert.equal(r.after.leaving, true);
  assert.equal(r.after.state, "done");
  assert.equal(r.after.caption.text, "ส่งงานแล้ว");
  assert.equal(r.after.caption.tone, "good");
  assert.equal(r.after.caption.replay, false);

  const s = r.steps;
  assert.equal(s[0].pose, "celebrate");
  assert.equal(s[0].face, "happy");
  const walkPaper = poseIndex(s, (x) => x.pose === "walk" && x.item === "paper");
  const give = poseIndex(s, (x) => x.pose === "give", walkPaper);
  const walkOut = poseIndex(s, (x) => x.pose === "walk" && !x.item, give);
  assert.ok(walkPaper > 0, "walks to the hirer holding the report");
  assert.ok(give > walkPaper, "then hands it over");
  assert.equal(s[give].item, "paper");
  assert.ok(walkOut > give, "then walks out empty-handed");
  assert.ok(r.giveDist !== null && r.giveDist <= 2, `gives from a tile next to the hirer (dist ${r.giveDist})`);
  assert.ok(r.fx.has("sparkle"), "celebration sparkle");
  assert.ok(r.fx.has("paper"), "the paper hops to the hirer");
  assert.ok(
    r.acks.some((a) => a.key === "A" && ["heart", "check"].includes(a.icon) && a.tone === "good"),
    "hirer acknowledges with a heart/check",
  );
  assert.ok(r.removedAt !== null && r.removedAt < 15, `removed after leaving (t=${r.removedAt})`);
  const lastStep = s[s.length - 1];
  const room = r.world.rooms.get("A");
  assert.ok(Math.abs(lastStep.x - room.door.x) <= TILE && Math.abs(lastStep.y - room.door.y) <= TILE, "left through the door");
  assert.equal(room.desks[r.desk].owner, null, "desk freed");
  assert.equal(r.world.stats().helperIndex, 1, "only s2 remains");
  // โต๊ะที่ว่างแล้วถูกใช้ซ้ำโดยผู้ช่วยคนถัดไป
  r.world.sync(snap([roomA([sub("s1", { running: false, outcome: "ok" }), sub("s2"), sub("s3")], "thinking")], T0 + 20000));
  assert.equal(r.world.characters.get("A:s3").deskIndex, r.desk);
});

test("deliver (failed/error): sad + rain, an honest ✗ acknowledgement, then leave", () => {
  for (const outcome of ["failed", "error"]) {
    const r = finishOne(outcome);
    const bad = r.lines.filter((l) => l.icon === "❌");
    assert.equal(bad.length, 1);
    assert.equal(bad[0].text, `room-A: scout·s1 ทำงานไม่สำเร็จ (${outcome})`);
    assert.equal(bad[0].tone, "bad");
    assert.equal(r.after.state, "failed");
    assert.equal(r.after.caption.text, `ไม่สำเร็จ (${outcome})`);
    assert.equal(r.after.caption.tone, "bad");
    assert.equal(r.steps[0].pose, "sad");
    assert.equal(r.steps[0].face, "sad");
    assert.ok(r.fx.has("rain"), "rain cloud");
    assert.ok(!r.fx.has("sparkle"), "no celebration for a failure");
    assert.ok(poseIndex(r.steps, (x) => x.pose === "give") > 0, "still reports back");
    // งานล้มเหลวจริง → ผู้จ้างไม่ขึ้นหัวใจ (เล่าเกินจริง) แต่ขึ้น ✗ โทนแดง
    assert.ok(r.acks.some((a) => a.key === "A" && a.icon === "cross" && a.tone === "bad"));
    assert.ok(!r.acks.some((a) => a.icon === "heart" || a.icon === "check"));
    assert.ok(r.removedAt !== null, "removed eventually");
    assert.equal(r.world.rooms.get("A").desks[r.desk].owner, null);
  }
});

test("deliver (killed) just leaves; a vanished sub leaves without a report", () => {
  const k = finishOne("killed");
  assert.equal(k.lines.filter((l) => l.icon === "⏹").length, 1);
  assert.equal(k.lines.find((l) => l.icon === "⏹").text, "room-A: scout·s1 ถูกหยุดกลางคัน");
  assert.equal(k.after.caption.text, "ถูกหยุดกลางคัน");
  assert.equal(poseIndex(k.steps, (x) => ["celebrate", "sad", "give"].includes(x.pose)), -1, "no celebrate/sad/give");
  assert.ok(!k.fx.has("paper"));
  assert.ok(k.removedAt !== null);

  const v = finishOne(null, { gone: true });
  assert.equal(v.after.leaving, true);
  assert.equal(v.after.caption.text, "ออกจากห้อง");
  assert.equal(v.lines.filter((l) => ["✅", "❌", "⏹", "❔"].includes(l.icon)).length, 0, "no fake deliver line");
  assert.equal(poseIndex(v.steps, (x) => x.pose === "give"), -1);
  assert.ok(v.removedAt !== null);
  assert.equal(v.world.rooms.get("A").desks[v.desk].owner, null);
});

test("deliver: children report to their parent helper; with the parent gone they report to the lead", () => {
  const subs = [sub("p", { type: "researcher" }), sub("k", { parentAgentId: "p", depth: 2, startedTs: iso(T0 + 5) })];
  const r = finishOne("ok", { subs, who: "k" });
  assert.equal(r.lines.find((l) => l.icon === "✅").text, "room-A: scout·k ส่งงานให้ researcher·p แล้ว");
  assert.ok(r.giveDist !== null && r.giveDist <= 2, "gave the report next to the parent helper");
  assert.ok(r.acks.some((a) => a.key === "A:p"), "the parent acknowledges");

  // ผู้จ้างจบงานและออกไปแล้ว → ลูกส่งงานให้หัวหน้าแทน
  const world = createWorld();
  const lines = collect(world);
  world.sync(snap([roomA(subs, "thinking")]), { first: true });
  run(world, 0.5);
  const doneP = { ...subs[0], running: false, outcome: "ok" };
  world.sync(snap([roomA([doneP, subs[1]], "thinking")], T0 + 700));
  run(world, 20);
  assert.ok(!world.characters.has("A:p"), "parent has left");
  world.sync(snap([roomA([doneP, { ...subs[1], running: false, outcome: "ok" }], "thinking")], T0 + 1400));
  const lead = world.characters.get("A");
  let gaveNearLead = false;
  trace(world, "A:k", 20, (c) => {
    if (c.pose === "give") gaveNearLead ||= Math.abs(lead.x - c.x) / TILE + Math.abs(lead.y - c.y) / TILE <= 2;
  });
  assert.ok(gaveNearLead, "reported to the lead");
  assert.ok(lines.some((l) => l.text === "room-A: scout·k ส่งงานให้ researcher·p แล้ว"), "narration still names the real hirer");
});

test("deliver: many helpers finishing in one poll become one grouped feed line", () => {
  const world = createWorld();
  const lines = collect(world);
  const subs = Array.from({ length: 6 }, (_, i) => sub(`s${i}`, { type: i % 2 ? "analyst" : "scout", startedTs: iso(T0 + i) }));
  world.sync(snap([roomA(subs)]), { first: true });
  run(world, 0.3);
  world.sync(snap([roomA(subs.map((s, i) => (i < 4 ? { ...s, running: false, outcome: "ok" } : s)))], T0 + 700));
  const ok = lines.filter((l) => l.icon === "✅");
  assert.equal(ok.length, 1);
  assert.equal(ok[0].text, "room-A: ผู้ช่วย 4 คน (scout, analyst) ส่งงานให้หัวหน้าแล้ว");
  assert.equal(ok[0].key, "A");
  run(world, 30);
  assert.equal(helpersOf(world, "A").length, 2);
  assert.equal(world.rooms.get("A").desks.filter((d) => d.owner).length, 2);
});

/* ───────────────────────── ความซื่อตรง: caption / สถานะจริง / การเล่าย้อน ───────────────────────── */

const atStation = (world, ch, name) =>
  world.rooms.get(ch.sessionId).stations[name].slots.some((s) => s.x === ch.x && s.y === ch.y);
const propOf = (world, sid, id) => world.rooms.get(sid).props.find((p) => p.id === id);

/** โลกที่มีห้อง A ห้องเดียว เริ่มจากหัวหน้า "กำลังคิด" (baseline เงียบ) */
function leadWorld(opts) {
  const world = createWorld(opts);
  const lines = collect(world);
  world.sync(snap([session("A", { status: { state: "thinking", since: iso(T0), running: [] } })]), { first: true });
  run(world, 0.3);
  return { world, lines, lead: world.characters.get("A") };
}
let tick = 1;
/** ส่ง snapshot ใหม่ของห้อง A (นาฬิกา server เดินหน้าทุกครั้ง) */
function push(world, over) {
  world.sync(snap([session("A", over)], T0 + 700 * tick++));
}

test("lead caption always shows the REAL current tool and label from status.running", () => {
  const { world, lines, lead } = leadWorld();
  const started = T0 + 300;
  push(world, {
    status: {
      state: "tool",
      since: iso(T0),
      running: [
        { tool: "Agent", icon: "🤖", label: "fan out", startedTs: iso(T0) },
        { tool: "Bash", icon: "⌨️", label: "npm test", startedTs: iso(started) },
      ],
    },
  });
  // caption เปลี่ยนทันทีหลัง sync (ไม่ต้องรอเดินถึง) และบอกเวลาเริ่มจริงของ tool
  assert.deepEqual(lead.caption, { icon: "⌨️", text: "รันคำสั่ง npm test", sinceMs: started, tone: "info", replay: false });
  assert.ok(lines.some((l) => l.text === "room-A: รันคำสั่ง npm test" && l.icon === "⌨️"));
  run(world, 4);
  assert.ok(atStation(world, lead, "terminal"), "walked to the terminal");
  assert.equal(lead.pose, "type-stand");
  assert.equal(propOf(world, "A", "terminal").variant, "active");
  // ไม่มี icon ใน entry → ใช้อีโมจิของตาราง; label ยาว/หลายบรรทัดถูกยุบเป็นบรรทัดเดียว
  push(world, { status: { state: "tool", since: iso(T0), running: [{ tool: "Read", label: "src/\n  app.js", startedTs: iso(T0 + 900) }] } });
  assert.equal(lead.caption.icon, "📖");
  assert.equal(lead.caption.text, "อ่าน src/ app.js");
  // Edit → นั่งพิมพ์ที่โต๊ะตัวเอง โต๊ะหัวหน้าเปิดไฟ
  push(world, { status: { state: "tool", since: iso(T0), running: [{ tool: "Edit", label: "a.js", startedTs: iso(T0 + 1000) }] } });
  run(world, 5);
  const room = world.rooms.get("A");
  assert.deepEqual([lead.x, lead.y], [room.leadSeat.x, room.leadSeat.y]);
  assert.equal(lead.pose, "sit-type");
  assert.equal(propOf(world, "A", "lead-desk").variant, "on");
});

test("lead states map to their places, poses, bubbles and captions", () => {
  const { world, lines, lead } = leadWorld();
  // waiting + AskUserQuestion → บูธโทรศัพท์ ถือหูโทรศัพท์ + ป้ายเตือนกะพริบ
  push(world, {
    status: { state: "waiting", since: iso(T0 + 500), running: [{ tool: "AskUserQuestion", label: "Which option?", startedTs: iso(T0 + 500) }] },
  });
  assert.equal(lead.caption.icon, "🙋");
  assert.equal(lead.caption.text, "รอคุณตอบ · Which option?");
  assert.equal(lead.caption.tone, "warn");
  assert.ok(lines.some((l) => l.text === "room-A: รอคุณตอบ" && l.tone === "warn"));
  run(world, 5);
  assert.ok(atStation(world, lead, "phone"));
  assert.equal(lead.pose, "phone");
  assert.deepEqual(lead.bubble, { kind: "alert", icon: "question", tone: "warn", blink: true });
  assert.equal(propOf(world, "A", "phone").variant, "ringing");
  // waiting เพราะ tool ค้าง (น่าจะรอสิทธิ์) → ยกมือ + ตกใจ
  push(world, { status: { state: "waiting", since: iso(T0 + 900), running: [{ tool: "Bash", label: "rm -rf dist", startedTs: iso(T0) }] } });
  assert.equal(lead.caption.text, "รออนุญาต · Bash rm -rf dist");
  run(world, 1.5);
  assert.equal(lead.pose, "raise-hand");
  assert.equal(lead.bubble.icon, "exclaim");
  // blocked → นั่งฟุบที่โต๊ะ ฝนตก โต๊ะเป็นสีแดง
  push(world, { status: { state: "blocked", since: iso(T0 + 1000), endedBy: "permission denied", running: [] } });
  assert.equal(lead.caption.text, "ติดด่าน · permission denied");
  assert.equal(lead.caption.tone, "bad");
  assert.ok(lines.some((l) => l.text === "room-A: ติดด่าน — permission denied"));
  run(world, 5);
  assert.equal(lead.pose, "sit-slump");
  assert.equal(lead.bubble.icon, "warning");
  assert.equal(propOf(world, "A", "lead-desk").variant, "error");
  assert.ok(world.effects.some((e) => e.kind === "rain"));
  // idle → จิบกาแฟ แล้วหลับบนโซฟาเมื่อว่างเกิน ~45 วิ (ตามนาฬิกา server ไม่ใช่นาฬิกาเฟรมล้วน ๆ)
  push(world, { status: { state: "idle", since: iso(T0 + 700 * tick), running: [] } });
  assert.equal(lead.caption.text, "ว่าง");
  assert.ok(lines.some((l) => l.text === "room-A: งานเสร็จ พักจิบกาแฟ" && l.tone === "good"));
  run(world, 5);
  assert.ok(atStation(world, lead, "coffee"));
  assert.equal(lead.pose, "sip");
  run(world, 45);
  assert.ok(atStation(world, lead, "couch"), "fell asleep on the couch");
  assert.equal(lead.pose, "sit-sleep");
  assert.equal(lead.face, "sleep");
  assert.ok(world.effects.some((e) => e.kind === "zzz"));
  // thinking → ไวต์บอร์ด สลับเขียน/คิดทุก ~3 วิ + บับเบิลความคิด
  push(world, { status: { state: "thinking", since: iso(T0), running: [] } });
  assert.equal(lead.caption.text, "คิดอยู่");
  run(world, 4);
  assert.ok(atStation(world, lead, "whiteboard"));
  const poses = new Set();
  for (let i = 0; i < 140; i++) {
    world.update(0.05);
    poses.add(lead.pose);
  }
  assert.deepEqual([...poses].sort(), ["think-stand", "write-board"]);
  assert.equal(lead.bubble.kind, "thought");
  assert.equal(propOf(world, "A", "whiteboard").variant, "scribble");
});

test("replay: a tool that started and finished between polls is replayed only while thinking, marked replay:true", () => {
  const { world, lead } = leadWorld();
  const thinking = { state: "thinking", since: iso(T0), running: [] };
  const grep = { i: 2, kind: "tool", tool: "Grep", icon: "🔍", label: "TODO", durMs: 40, ts: iso(T0 + 100) };
  push(world, { status: thinking, events: [grep] });
  world.update(0.05);
  assert.equal(lead.caption.replay, true, "caption flagged as a replay");
  assert.equal(lead.caption.icon, "✓");
  assert.equal(lead.caption.text, "เมื่อกี้ · 🔍 Grep TODO");
  assert.equal(lead.caption.sinceMs, null, "a replay has no live elapsed timer");
  let visited = false;
  for (let t = 0; t < 6 && lead.caption.replay; t += 0.05) {
    world.update(0.05);
    const tile = [Math.floor(lead.x / TILE), Math.floor(lead.y / TILE)];
    if (tile[1] === 4 && tile[0] >= 5 && tile[0] <= 8 && !lead.moving) visited = true;
  }
  assert.ok(visited, "visited the cabinet (Grep's station)");
  assert.equal(lead.caption.replay, false, "replay ends by itself");
  assert.equal(lead.caption.text, "คิดอยู่");

  // เล่าย้อนอยู่ แล้วสถานะจริงเปลี่ยนเป็น tool → caption เป็นของจริงทันที และเดินไปสถานีจริง
  push(world, { status: thinking, events: [grep, { ...grep, i: 3, tool: "Glob", label: "*.js" }] });
  world.update(0.05);
  assert.equal(lead.caption.replay, true);
  push(world, {
    status: { state: "tool", since: iso(T0), running: [{ tool: "Read", icon: "📖", label: "live.js", startedTs: iso(T0 + 2000) }] },
    events: [grep],
  });
  assert.equal(lead.caption.replay, false, "live tool wins immediately");
  assert.equal(lead.caption.text, "อ่าน live.js");
  for (let i = 0; i < 80; i++) {
    world.update(0.05);
    assert.equal(lead.caption.replay, false);
  }
  assert.ok(atStation(world, lead, "bookshelf"));
});

test("replay rules: never while a tool is live, never for tools already shown live, dropped when the state changes", () => {
  const { world, lead } = leadWorld();
  const ev = (i, tool, label, extra = {}) => ({ i, kind: "tool", tool, label, durMs: 30, ts: iso(T0), ...extra });
  const replaySeen = () => {
    let seen = false;
    for (let i = 0; i < 60; i++) {
      world.update(0.05);
      if (lead.caption.replay) seen = true;
    }
    return seen;
  };
  // tool จริงกำลังรัน + มี tool ที่จบระหว่าง poll → ไม่เล่าย้อน (ของจริงสำคัญกว่า)
  push(world, { status: { state: "tool", since: iso(T0), running: [{ tool: "Bash", label: "make", startedTs: iso(T0) }] }, events: [ev(1, "Grep", "x")] });
  assert.equal(replaySeen(), false);
  // tool ที่เห็นใน running รอบก่อนแล้ว (ได้แสดงสดไปแล้ว) → จบแล้วไม่เล่าซ้ำ
  push(world, { status: { state: "tool", since: iso(T0), running: [{ tool: "Read", label: "a.js", startedTs: iso(T0) }] }, events: [ev(2, "Grep", "y")] });
  push(world, { status: { state: "thinking", since: iso(T0), running: [] }, events: [ev(3, "Read", "a.js")] });
  assert.equal(replaySeen(), false);
  // ยังไม่จบ (ไม่มี durMs/done) → ไม่ใช่ "เริ่มและจบระหว่าง poll"
  push(world, { status: { state: "thinking", since: iso(T0), running: [] }, events: [{ i: 4, kind: "tool", tool: "Grep", label: "z", ts: iso(T0) }] });
  assert.equal(replaySeen(), false);
  // Agent / AskUserQuestion ไม่ถูกเล่าย้อน (มีบทของตัวเอง)
  push(world, { status: { state: "thinking", since: iso(T0), running: [] }, events: [ev(5, "Agent", "a"), ev(6, "AskUserQuestion", "q")] });
  assert.equal(replaySeen(), false);
  // เล่าย้อนที่รออยู่ถูกทิ้งเมื่อสถานะเปลี่ยนเป็น idle
  push(world, { status: { state: "thinking", since: iso(T0), running: [] }, events: [ev(7, "WebFetch", "https://x")] });
  world.update(0.05);
  assert.equal(lead.caption.replay, true);
  push(world, { status: { state: "idle", since: iso(T0), running: [] }, events: [] });
  assert.equal(lead.caption.replay, false);
  assert.equal(lead.caption.text, "ว่าง");
  assert.equal(replaySeen(), false);
});

test("helper captions come from its own current tool / lastTool", () => {
  const world = createWorld();
  const cur = { tool: "WebSearch", icon: "🌐", label: "pixel art", startedTs: iso(T0 + 50) };
  const oldRead = { tool: "Read", icon: "📖", label: "a.js", startedTs: iso(T0 - 5000) };
  world.sync(
    snap([
      roomA([
        sub("s1", { current: cur }),
        sub("s2", { lastTool: { tool: "Read", error: false } }),
        sub("s3", { lastTool: { tool: "Bash", error: true } }),
        sub("s4"),
        sub("s5", { current: oldRead }),
      ]),
    ]),
    { first: true },
  );
  const [h1, h2, h3] = ["A:s1", "A:s2", "A:s3"].map((k) => world.characters.get(k));
  const h5 = world.characters.get("A:s5");
  assert.deepEqual(h1.caption, { icon: "🌐", text: "ค้นเว็บ pixel art", sinceMs: T0 + 50, tone: "info", replay: false });
  assert.equal(h1.state, "tool");
  // hysteresis: tool เพิ่งเริ่ม + สถานีไกลจากโต๊ะ (> 8 ช่อง) → ทำที่โต๊ะก่อน พร้อมไอคอนสถานีในฟองความคิด
  const seat1 = world.rooms.get("A").desks[h1.deskIndex].seat;
  assert.deepEqual([h1.x, h1.y, h1.pose], [seat1.x, seat1.y, "sit-type"]);
  assert.equal(h1.bubble.icon, "globe");
  // tool ที่รันมานานแล้ว (น่าจะรันต่อ) → อยู่ที่สถานีแม้จะไกลจากโต๊ะ
  assert.ok(atStation(world, h5, "bookshelf"), "a long-running tool is worth the walk");
  assert.equal(h5.pose, "read");
  // รันนานพอแล้ว (≥ max(1.2 วิ, 0.6 × เวลาเดิน)) → ลุกเดินไปคีออสก์ทีเดียว ไม่เดินไปกลับ
  run(world, 5);
  assert.ok(atStation(world, h1, "kiosk"), "walked to the kiosk once the search kept running");
  assert.equal(h1.pose, "type-stand");
  assert.equal(h2.caption.text, "คิดอยู่ · ล่าสุด Read ✓");
  assert.equal(h2.state, "thinking");
  assert.equal(h3.caption.text, "คิดอยู่ · ล่าสุด Bash ✗");
  assert.equal(h3.caption.tone, "warn");
  // current หายไป → กลับไปนั่งคิดที่โต๊ะ caption เปลี่ยนตาม
  world.sync(snap([roomA([sub("s1", { current: null, lastTool: { tool: "WebSearch" } }), sub("s2"), sub("s3"), sub("s4"), sub("s5")])], T0 + 5700));
  assert.equal(h1.caption.text, "คิดอยู่ · ล่าสุด WebSearch ✓");
  run(world, 6);
  const seat = world.rooms.get("A").desks[h1.deskIndex].seat;
  assert.deepEqual([h1.x, h1.y], [seat.x, seat.y]);
  assert.equal(h1.pose, "sit-think");
});

/* ───────────────────────── ฟีดเล่าเรื่อง + บทสั้น ───────────────────────── */

const THINKING = { state: "thinking", since: iso(T0), running: [] };
const bashStatus = (label, at) => ({
  state: "tool",
  since: iso(T0),
  running: [{ tool: "Bash", icon: "⌨️", label, startedTs: iso(T0 + at) }],
});

test("narration: tool lines ≤ 1 per 1.5 s per character; a held line is released only while still true", () => {
  const { world, lines } = leadWorld();
  const stamped = [];
  world.onNarrate((l) => stamped.push({ ...l, at: world.time }));
  const toolLines = () => stamped.filter((l) => l.text.startsWith("room-A: รันคำสั่ง"));
  push(world, { status: bashStatus("c0", 0) });
  assert.equal(toolLines().length, 1, "first change is told at once");
  for (let i = 1; i <= 5; i++) {
    run(world, 0.2);
    push(world, { status: bashStatus(`c${i}`, i) });
  }
  assert.equal(toolLines().length, 1, "changes within the gap are held back");
  run(world, 0.8);
  assert.deepEqual(
    toolLines().map((l) => l.text),
    ["room-A: รันคำสั่ง c0", "room-A: รันคำสั่ง c5"],
    "only the latest held line is released, and only after the gap",
  );
  // บรรทัดที่ถูกกั้นไว้แต่ tool จบไปแล้ว → ไม่ถูกปล่อย (ไม่เล่าของที่ไม่จริงแล้ว)
  run(world, 2);
  push(world, { status: bashStatus("d0", 100) });
  run(world, 0.2);
  push(world, { status: bashStatus("d1", 101) });
  run(world, 0.2);
  push(world, { status: THINKING });
  run(world, 3);
  const texts = toolLines().map((l) => l.text);
  assert.ok(texts.includes("room-A: รันคำสั่ง d0"));
  assert.ok(!texts.includes("room-A: รันคำสั่ง d1"), "stale held line dropped");
  // พายุเปลี่ยน tool ทุก 0.2 วิ นาน 10 วิ → บรรทัดห่างกันอย่างน้อย 1.5 วิเสมอ
  const before = toolLines().length;
  for (let i = 0; i < 50; i++) {
    push(world, { status: bashStatus(`storm${i}`, 200 + i) });
    run(world, 0.2);
  }
  const storm = toolLines().slice(before);
  assert.ok(storm.length >= 5 && storm.length <= 8, `throttled burst (${storm.length} lines)`);
  for (let i = 1; i < storm.length; i++) assert.ok(storm[i].at - storm[i - 1].at >= 1.5 - 1e-9, "≥ 1.5 s apart");
  assert.equal(lines.length, stamped.length, "every listener sees the same lines");
});

test("narration: throttling is per character and error lines are throttled too", () => {
  const world = createWorld();
  const lines = collect(world);
  const two = (la, lb, errs) => [
    session("A", { status: bashStatus(la, 1), counts: { errors: errs } }),
    session("B", { status: bashStatus(lb, 2), counts: { errors: 0 } }),
  ];
  world.sync(snap(two("a0", "b0", 0)), { first: true });
  assert.equal(lines.length, 0);
  run(world, 0.2);
  world.sync(snap(two("a1", "b1", 0), T0 + 700));
  assert.ok(lines.some((l) => l.text === "room-A: รันคำสั่ง a1"));
  assert.ok(lines.some((l) => l.text === "room-B: รันคำสั่ง b1"), "B is not throttled by A");
  // error เพิ่มทุก 0.2 วิ นาน 4 วิ → ≤ 1 บรรทัดต่อ 2 วิ (+ บรรทัดที่ค้างถูกปล่อยตอนท้าย)
  for (let i = 1; i <= 20; i++) {
    run(world, 0.2);
    world.sync(snap(two("a1", "b1", i), T0 + 700 + i * 200));
  }
  run(world, 3);
  const errs = lines.filter((l) => l.icon === "💥");
  assert.ok(errs.length >= 2 && errs.length <= 4, `error lines throttled (${errs.length})`);
  assert.ok(errs.every((l) => l.tone === "bad" && l.sessionId === "A"));
});

test("mail: a new prompt → letter to the mailbox, the lead reads it, then resumes the live state", () => {
  const { world, lines, lead } = leadWorld();
  const long = "สร้าง UI อีกมุมมองเป็นรูปแบบ pixel art ให้มีตัวการ์ตูนทำงาน และเดินไปมาทำงานเป็นเรื่องเป็นราว";
  push(world, { status: THINKING, events: [{ i: 1, kind: "prompt", ts: iso(T0), text: long }] });
  const mail = lines.filter((l) => l.icon === "📬");
  assert.equal(mail.length, 1);
  assert.ok(mail[0].text.startsWith('room-A: ได้รับคำสั่งใหม่ — "สร้าง UI'));
  assert.ok(Array.from(mail[0].text).length < Array.from(long).length + 30, "prompt text is truncated");
  world.update(0.05);
  const letter = world.effects.find((e) => e.kind === "letter");
  assert.ok(letter && letter.from && letter.to, "a letter flies from the door to the mailbox");
  assert.equal(propOf(world, "A", "mailbox").variant, "full");
  let readAt = null;
  for (let t = 0; t < 6 && readAt === null; t += 0.05) {
    world.update(0.05);
    if (lead.pose === "read-letter") readAt = t;
  }
  assert.ok(readAt !== null, "reads the letter");
  assert.ok(atStation(world, lead, "mailbox"));
  // onArrive ของบทรันในเฟรมถัดจากเฟรมที่เดินถึง (ช้าไป 1 เฟรม มองไม่เห็น) — จึงเดินอีกหนึ่งเฟรมก่อนตรวจ
  world.update(0.05);
  assert.equal(propOf(world, "A", "mailbox").variant, "empty", "mail taken out");
  assert.equal(lead.caption.text, "คิดอยู่", "caption stays on the live state");
  run(world, 1.5);
  assert.equal(lead.pose, "read-letter", "reads for ~1.8 s");
  run(world, 4);
  assert.ok(atStation(world, lead, "whiteboard"), "then back to thinking at the whiteboard");
});

test("oops / denied / say beats and voice frames", () => {
  const { world, lines, lead } = leadWorld();
  push(world, { status: THINKING, counts: { errors: 1 }, events: [{ i: 1, kind: "error", ts: iso(T0), text: "ENOENT: no such file" }] });
  assert.ok(lines.some((l) => l.icon === "💥" && l.text === "room-A: error — ENOENT: no such file" && l.tone === "bad"));
  world.update(0.05);
  assert.equal(lead.pose, "oops");
  assert.equal(lead.face, "surprised");
  assert.ok(world.effects.some((e) => e.kind === "spark" || e.kind === "smoke"));
  run(world, 1);
  assert.notEqual(lead.pose, "oops", "oops lasts ~0.8 s");

  push(world, {
    status: THINKING,
    counts: { errors: 1, denials: 1 },
    events: [{ i: 2, kind: "denied", ts: iso(T0), denyKind: "user-rejected", denyLabel: "ผู้ใช้กดปฏิเสธ" }],
  });
  assert.ok(lines.some((l) => l.icon === "🛑" && l.text === "room-A: ถูกปฏิเสธ — ผู้ใช้กดปฏิเสธ"));
  world.update(0.05);
  assert.ok(world.effects.some((e) => e.kind === "stamp"), "red stamp over the character");
  assert.equal(lead.pose, "oops");

  push(world, { status: THINKING, counts: { errors: 1, denials: 1 }, events: [{ i: 3, kind: "say", ts: iso(T0), text: "ก".repeat(100) }] });
  assert.ok(lead.speech, "say → speech bubble");
  assert.ok(Array.from(lead.speech.text).length <= 40);
  run(world, 4.2);
  assert.equal(lead.speech, null, "speech bubble expires after ~4 s");

  // ผู้ช่วยเจอ error → oops ของตัวเอง + บรรทัดฟีดที่บอก tool จริงที่พัง
  const w = createWorld();
  const wl = collect(w);
  w.sync(snap([roomA([sub("s1")])]), { first: true });
  run(w, 0.3);
  w.sync(snap([roomA([sub("s1", { errors: 1, lastTool: { tool: "Bash", label: "npm test", error: true } })])], T0 + 700));
  assert.ok(wl.some((l) => l.text === "room-A: scout·s1 error — Bash npm test" && l.key === "A:s1"));
  w.update(0.05);
  assert.equal(w.characters.get("A:s1").pose, "oops");

  // เสียงพูด: เฟรมจากระบบเสียง → ตัวละครนั้นอ้าปาก · agentId ที่ไม่รู้จัก → หัวหน้าห้องพูดแทน
  const h = w.characters.get("A:s1");
  w.voice({ sessionId: "A", agentId: "s1", phase: "start", level: 0.5 });
  w.update(0.05);
  assert.equal(h.talking, true);
  assert.equal(h.face, "talk");
  run(w, 1);
  assert.equal(h.talking, false, "talking stops without new frames");
  w.voice({ sessionId: "A", agentId: "nobody", phase: "start" });
  assert.equal(w.characters.get("A").talking, true);
  w.voice({ sessionId: "A", phase: "end" });
  assert.equal(w.characters.get("A").talking, false);
  w.voice({ sessionId: "zzz", phase: "start" });
});

test("alive:false → the lead goes home through the door, lights off; alive again → lights on", () => {
  const { world, lines, lead } = leadWorld();
  const room = world.rooms.get("A");
  const sv = room.staticVersion;
  const lv = world.layoutVersion;
  push(world, { alive: false, endedAgo: 1000, status: { state: "idle", since: iso(T0), running: [] } });
  assert.equal(lines.filter((l) => l.icon === "🌙").length, 1);
  assert.equal(lines.find((l) => l.icon === "🌙").text, "room-A: ปิดห้องแล้ว");
  assert.equal(lead.leaving, true);
  assert.equal(lead.state, "ended");
  assert.equal(lead.caption.text, "ปิดแล้ว");
  assert.equal(room.alive, false);
  assert.equal(room.endedAgo, 1000);
  const tr = trace(world, "A", 34);
  assert.ok(tr.removedAt !== null, "lead removed after walking out");
  const last = tr.steps[tr.steps.length - 1];
  assert.ok(Math.abs(last.x - room.door.x) <= TILE && Math.abs(last.y - room.door.y) <= TILE, "left through the door");
  assert.equal(room.lightsOn, false);
  assert.ok(room.props.filter((p) => p.name === "window").every((p) => p.variant === "dark"));
  assert.ok(room.staticVersion > sv && world.layoutVersion > lv, "static layer must be re-baked");
  push(world, { alive: false, endedAgo: 60000, status: { state: "idle", since: iso(T0), running: [] } });
  assert.equal(lines.filter((l) => l.icon === "🌙").length, 1, "closing is told once");
  assert.ok(!world.characters.has("A"));
  // session กลับมามีชีวิต (resume) → เปิดไฟ หัวหน้าเดินเข้าประตู
  push(world, { status: THINKING });
  assert.ok(lines.some((l) => l.text === "เปิดไฟห้อง room-A" && l.icon === "💡"));
  assert.equal(room.lightsOn, true);
  const back = world.characters.get("A");
  assert.deepEqual([back.x, back.y], [room.door.x, room.door.y]);
  run(world, 5);
  assert.equal(back.alpha, 1);
  assert.ok(atStation(world, back, "whiteboard"));
});

/* ───────────────────────── หน่วยความจำ / เพดาน / ขนาดห้อง ───────────────────────── */

const TOOLS_CYCLE = ["Read", "Grep", "Bash", "WebFetch", "Edit", "Artifact", "mcp__x__y", "Monitor", "Skill", "TodoWrite"];
/** n ผู้ช่วยที่ทำงานต่างสถานีกัน (ให้ช่องจอง/คิวถูกใช้จริง) */
function crew(n, { running = true, outcome = "", offset = 0 } = {}) {
  return Array.from({ length: n }, (_, i) =>
    sub(`a${i}`, {
      running,
      outcome: running ? "" : outcome,
      startedTs: iso(T0 + offset + i),
      current: running && i % 4 ? { tool: TOOLS_CYCLE[i % TOOLS_CYCLE.length], label: `job ${i}`, startedTs: iso(T0 + i) } : null,
    }),
  );
}

test("memory: every internal map shrinks back after helpers and sessions disappear", () => {
  const world = createWorld();
  const unsub = world.onNarrate(() => {});
  const room = (id, subs) => session(id, { status: { state: "delegating", since: iso(T0), running: [{ tool: "Agent", label: "x", startedTs: iso(T0) }] }, subagents: subs });
  world.sync(snap(["S0", "S1", "S2"].map((id) => room(id, crew(12)))), { first: true });
  run(world, 1);
  world.sync(snap(["S0", "S1", "S2"].map((id) => room(id, crew(17)))), T0 + 700);
  run(world, 4);
  const peak = world.stats();
  assert.equal(peak.characters, 3 + 3 * 17);
  assert.equal(peak.helperIndex, 3 * 17);
  assert.ok(peak.reservations > 0, "station slots are reserved while working");
  // ทุกคนจบงาน → ส่งงาน เดินออก หายไป
  world.sync(snap(["S0", "S1", "S2"].map((id) => room(id, crew(17, { running: false, outcome: "ok" })))), T0 + 1400);
  run(world, 40);
  const mid = world.stats();
  assert.equal(mid.characters, 3, "only the leads remain");
  assert.equal(mid.helperIndex, 0);
  assert.equal(mid.queued, 0);
  assert.equal(mid.queuedBeats, 0);
  assert.ok(mid.reservations <= 3, "no reservation outlives its holder");
  assert.equal(mid.subTracked, 3 * 17, "diff state tracks only subs still listed in the snapshot");
  for (const r of world.rooms.values()) assert.ok(r.desks.every((d) => d.owner === null), "all desks free");
  // session หายไปทั้งหมด → ทุกอย่างกลับเป็นศูนย์
  world.sync(snap([], T0 + 2100));
  run(world, 12);
  const end = world.stats();
  for (const [k, v] of Object.entries(end)) {
    if (k === "listeners") continue;
    assert.equal(v, 0, `stats.${k} back to 0`);
  }
  assert.equal(world.effects.length, 0);
  assert.equal(end.listeners, 1);
  unsub();
  assert.equal(world.stats().listeners, 0, "onNarrate returns a working unsubscribe");
});

test("overflow: helpers beyond maxHelpersPerRoom are counted, not drawn, and take desks as they free up", () => {
  const world = createWorld({ maxHelpersPerRoom: 5 });
  const lines = collect(world);
  assert.equal(world.maxHelpersPerRoom, 5);
  const subs = crew(8);
  world.sync(snap([roomA(subs)]), { first: true });
  const room = world.rooms.get("A");
  assert.equal(helpersOf(world, "A").length, 5);
  assert.equal(room.overflow, 3);
  assert.equal(room.desks.length, 10, "never grows past the cap (rounded up to 10)");
  assert.deepEqual(helpersOf(world, "A").map((c) => c.agentId).sort(), ["a0", "a1", "a2", "a3", "a4"], "earliest subs are drawn");
  // สองคนจบงาน: คืนโต๊ะทันทีและไม่นับในเพดานอีก ⇒ คนที่ยังทำงานจริงแต่รออยู่ได้โต๊ะใน sync เดียวกัน
  // (ภาพต้องเล่างานที่กำลังทำ ไม่ใช่งานที่จบไปแล้ว — ห้องที่ล้นเพดานก็ส่งงานแบบสั้นแล้วหายไปเร็ว)
  const next = subs.map((s, i) => (i < 2 ? { ...s, running: false, outcome: "ok", current: null } : s));
  world.sync(snap([roomA(next)], T0 + 700));
  const working = () => helpersOf(world, "A").filter((c) => !c.leaving);
  assert.equal(working().length, 5, "the cap counts working helpers only");
  assert.equal(helpersOf(world, "A").filter((c) => c.leaving).length, 2, "the finished two are still on screen, leaving");
  assert.equal(room.overflow, 1, "6 running − 5 visible");
  const entered = helpersOf(world, "A").filter((c) => ["a5", "a6"].includes(c.agentId));
  assert.equal(entered.length, 2, "waiting subs take the freed desks at once");
  for (const c of entered) {
    assert.ok(Math.abs(c.x - room.door.x) <= 8 && c.y === room.door.y, "they walk in through the door");
    assert.ok(room.desks[c.deskIndex].owner === c.key);
  }
  assert.equal(lines.filter((l) => l.icon === "🤝").length, 0, "not a new hire — they were already counted");
  for (let t = 0; t < 30; t += 0.5) {
    run(world, 0.5);
    assert.ok(working().length <= 5);
  }
  assert.equal(helpersOf(world, "A").length, 5, "the finished two have left");
  world.sync(snap([roomA(next)], T0 + 1400));
  assert.equal(helpersOf(world, "A").length, 5);
  assert.equal(room.overflow, 1);
  // ห้องที่ปิดแล้วไม่โต: ผู้ช่วยที่เกินโต๊ะเป็น overflow
  const dead = createWorld();
  dead.sync(snap([roomA(crew(15), "idle", { alive: false })]), { first: true });
  assert.equal(dead.rooms.get("A").desks.length, 10);
  assert.equal(dead.rooms.get("A").overflow, 5);
  // เพดานปริยาย 64 → โต๊ะสูงสุด 70
  const big = createWorld();
  big.sync(snap([roomA(crew(100))]), { first: true });
  assert.equal(big.rooms.get("A").desks.length, 70);
  assert.equal(helpersOf(big, "A").length, 64);
  assert.equal(big.rooms.get("A").overflow, 36);
});

test("room grows in steps of 10 desks while alive and shrinks only after ≥ 30 s of spare capacity", () => {
  const world = createWorld();
  world.sync(snap([roomA(crew(3).map((s) => ({ ...s, current: null })))]), { first: true });
  const room = world.rooms.get("A");
  assert.deepEqual([room.desks.length, room.h], [10, 13]);
  const seated = helpersOf(world, "A").map((c) => [c.key, c.x, c.y]);
  const sv = room.staticVersion;
  const lv = world.layoutVersion;
  world.sync(snap([roomA(crew(15).map((s) => ({ ...s, current: null })))], T0 + 700));
  assert.deepEqual([room.desks.length, room.h], [20, 19], "grew by one step of 10 desks");
  assert.ok(room.staticVersion > sv && world.layoutVersion > lv);
  assert.deepEqual(room.desks.slice(0, 3).map((d) => d.owner), ["A:a0", "A:a1", "A:a2"], "existing desks keep their owners");
  assert.ok(room.desks.slice(0, 15).every((d) => d.owner));
  // ผู้ช่วยที่นั่งอยู่แล้วไม่ต้องลุก (โต๊ะเดิมอยู่ที่เดิม) — ทดสอบบั๊กเดินส่ายตอนห้องเปลี่ยนขนาด
  for (let i = 0; i < 10; i++) {
    world.update(0.05);
    for (const [key, x, y] of seated) {
      const c = world.characters.get(key);
      assert.equal(c.moving, false, `${key} stays seated`);
      assert.deepEqual([c.x, c.y], [x, y]);
      assert.equal(c.pose, "sit-think");
    }
  }
  run(world, 5);
  // ห้าคนท้ายจบงาน → ห้องยังไม่หดทันที
  const fifteen = crew(15).map((s, i) => (i >= 10 ? { ...s, running: false, outcome: "ok", current: null } : { ...s, current: null }));
  world.sync(snap([roomA(fifteen)], T0 + 1400));
  let t = 0;
  while (helpersOf(world, "A").length > 10 && t < 30) {
    world.update(0.05);
    t += 0.05;
  }
  assert.equal(helpersOf(world, "A").length, 10);
  run(world, 20);
  assert.equal(room.desks.length, 20, "still big 20 s after the spare capacity appeared");
  // มีคนใหม่เข้ามาใช้โต๊ะแถวล่าง → นับเวลาใหม่
  const withNew = [...fifteen, sub("late", { startedTs: iso(T0 + 999) })];
  world.sync(snap([roomA(withNew)], T0 + 2100));
  assert.equal(world.characters.get("A:late").deskIndex, 10);
  run(world, 15);
  assert.equal(room.desks.length, 20, "the late hire reset the shrink timer");
  world.sync(snap([roomA(withNew.map((s) => (s.agentId === "late" ? { ...s, running: false, outcome: "ok" } : s)))], T0 + 2800));
  run(world, 20);
  assert.ok(!world.characters.has("A:late"));
  assert.equal(room.desks.length, 20);
  run(world, 20);
  assert.deepEqual([room.desks.length, room.h], [10, 13], "shrank back after ≥ 30 s spare");
  for (const c of helpersOf(world, "A")) {
    assert.ok(c.deskIndex < 10 && room.desks[c.deskIndex].owner === c.key, "every helper still owns a desk");
    assertOnFloor(world, c);
  }
});

test("reduceMotion: no particle bursts or idle bobbing, but walking (which carries meaning) still happens", () => {
  const world = createWorld({ reduceMotion: true });
  assert.equal(world.reduceMotion, true);
  world.sync(snap([roomA([])]), { first: true });
  run(world, 0.3);
  world.sync(snap([roomA([sub("s1")])], T0 + 700));
  const h = world.characters.get("A:s1");
  let walked = false;
  const kinds = new Set();
  for (let i = 0; i < 80; i++) {
    world.update(0.05);
    walked ||= h.moving;
    for (const e of world.effects) kinds.add(e.kind);
  }
  assert.ok(walked, "helper still walks to its desk");
  world.sync(snap([roomA([sub("s1", { running: false, outcome: "ok" })])], T0 + 1400));
  for (let i = 0; i < 200; i++) {
    world.update(0.05);
    for (const e of world.effects) kinds.add(e.kind);
  }
  for (const burst of ["poof", "spark", "smoke", "sparkle", "heart"]) assert.ok(!kinds.has(burst), `no ${burst} burst`);
  assert.ok(kinds.has("paper"), "meaningful effects (the report handed over) stay");
  // ท่ายืน/นั่งเฉยไม่โยกตัว
  const idle = createWorld({ reduceMotion: true });
  idle.sync(snap([roomA([sub("s1")], "unknown")]), { first: true });
  for (let i = 0; i < 40; i++) {
    idle.update(0.05);
    assert.equal(idle.characters.get("A").frame, 0, "lead stands still");
    assert.equal(idle.characters.get("A:s1").frame, 0, "seated helper does not bob");
  }
});

test("dispose() clears everything and turns later calls into no-ops", () => {
  const world = createWorld();
  let n = 0;
  world.onNarrate(() => n++);
  world.sync(snap([roomA(crew(4))]), { first: true });
  run(world, 0.5);
  world.dispose();
  world.dispose();
  assert.equal(world.rooms.size, 0);
  assert.equal(world.characters.size, 0);
  assert.equal(world.effects.length, 0);
  world.sync(snap([roomA(crew(6)), session("B")], T0 + 700));
  world.update(0.05);
  world.voice({ sessionId: "A", phase: "start" });
  assert.equal(world.rooms.size, 0);
  assert.equal(n, 0);
  assert.equal(world.pick(10, 10), null);
  const st = world.stats();
  assert.ok(Object.values(st).every((v) => v === 0));
});

/* ───────────────────────── สถานี: จอง / ต่อคิว / ไปทำที่โต๊ะ · การเดิน ───────────────────────── */

test("stations: slots are reserved, up to 3 queue facing the station, the rest work at their desk; queues get promoted", () => {
  const world = createWorld();
  const read = (i) => ({ tool: "Read", icon: "📖", label: `f${i}.js`, startedTs: iso(T0 + i) });
  const subs = Array.from({ length: 8 }, (_, i) => sub(`s${i}`, { startedTs: iso(T0 + i) }));
  world.sync(snap([roomA(subs, "thinking")]), { first: true });
  run(world, 0.3);
  const reading = subs.map((s, i) => ({ ...s, current: read(i) }));
  world.sync(snap([roomA(reading, "thinking")], T0 + 700));
  run(world, 10);
  const room = world.rooms.get("A");
  const hs = helpersOf(world, "A");
  const atSlot = hs.filter((c) => atStation(world, c, "bookshelf"));
  assert.equal(atSlot.length, 2, "both bookshelf slots in use");
  for (const c of atSlot) assert.equal(c.pose, "read");
  const seatOf = (c) => room.desks[c.deskIndex].seat;
  const atDesk = hs.filter((c) => c.x === seatOf(c).x && c.y === seatOf(c).y);
  const queued = hs.filter((c) => !atSlot.includes(c) && !atDesk.includes(c));
  assert.equal(queued.length, 3, "queue holds at most 3 (more is a pile of people in front of the shelf)");
  for (const c of queued) {
    assert.equal(c.pose, "stand");
    assert.deepEqual(c.bubble, { kind: "thought", icon: "book", tone: "neutral", blink: false }, "queued: shows what it waits for");
    assert.equal(c.moving, false);
  }
  assert.equal(atDesk.length, 3, "overflowing the queue → work at own desk");
  for (const c of atDesk) {
    assert.equal(c.pose, "sit-type");
    assert.equal(c.bubble.icon, "book");
  }
  // ไม่มีสองคนยืนช่องเดียวกัน
  const tiles = new Set(Array.from(world.characters.values(), (c) => `${Math.floor(c.x / TILE)},${Math.floor(c.y / TILE)}`));
  assert.equal(tiles.size, world.characters.size, "nobody shares a tile");
  // คนหนึ่งที่ชั้นหนังสืออ่านเสร็จ → คนในคิวได้ขึ้นไปแทน และคนที่ทำที่โต๊ะได้เข้าคิว
  const done = atSlot[0].agentId;
  world.sync(snap([roomA(reading.map((s) => (s.agentId === done ? { ...s, current: null } : s)), "thinking")], T0 + 1400));
  run(world, 6);
  const atSlot2 = helpersOf(world, "A").filter((c) => atStation(world, c, "bookshelf"));
  assert.equal(atSlot2.length, 2, "freed slot is taken by someone from the queue");
  assert.ok(!atSlot2.some((c) => c.agentId === done));
  assert.equal(atDesk.filter((c) => c.pose === "stand").length, 1, "one desk worker moved into the queue");
  assert.equal(world.stats().queued, 3);
});

test("walking: ≈ 5.5 tiles/s, minimum ~1 s dwell at a station unless a real tool takes over", () => {
  const { world, lead } = leadWorld();
  push(world, { status: bashStatus("make", 1) });
  let prev = { x: lead.x, y: lead.y };
  let moved = 0;
  let movingFor = 0;
  let arrivedAt = null;
  for (let t = 0; t < 5 && arrivedAt === null; t += 0.05) {
    world.update(0.05);
    const d = Math.hypot(lead.x - prev.x, lead.y - prev.y);
    assert.ok(d <= MAX_STEP_PX, `step ${d.toFixed(2)} px ≤ walking speed`);
    moved += d;
    if (d > 0) movingFor += 0.05; // นับเฟรมที่ขยับจริง (เฟรมที่เดินถึงขยับไม่เต็มก้าวแต่ moving=false แล้ว)
    prev = { x: lead.x, y: lead.y };
    if (!lead.moving && atStation(world, lead, "terminal")) arrivedAt = world.time;
  }
  assert.ok(arrivedAt !== null, "reached the terminal");
  const speed = moved / movingFor / TILE;
  assert.ok(speed > 4.5 && speed <= 5.5 + 1e-3, `walk speed ${speed.toFixed(2)} tiles/s`);
  // เพิ่งถึงแล้วสถานะเปลี่ยนเป็น "คิด" → ยืนต่ออีกนิด (≥ ~1 วิ) ก่อนเดินไปไวต์บอร์ด (caption เปลี่ยนทันที)
  push(world, { status: THINKING });
  assert.equal(lead.caption.text, "คิดอยู่", "caption is honest right away");
  let leftAt = null;
  for (let t = 0; t < 3 && leftAt === null; t += 0.05) {
    world.update(0.05);
    if (lead.moving) leftAt = world.time;
  }
  assert.ok(leftAt !== null && leftAt - arrivedAt >= 1 - 1e-6, `dwelled ${(leftAt - arrivedAt).toFixed(2)} s`);
  // แต่ tool จริงตัวใหม่ (urgent) ดึงออกไปได้ทันที
  run(world, 4);
  push(world, { status: bashStatus("make again", 50) });
  run(world, 4);
  assert.ok(atStation(world, lead, "terminal"));
  push(world, { status: { state: "tool", since: iso(T0), running: [{ tool: "WebFetch", label: "https://x", startedTs: iso(T0 + 60) }] } });
  world.update(0.05);
  world.update(0.05);
  assert.equal(lead.moving, true, "a new real tool pulls the lead away immediately");
});

test("delegating: the lead patrols its own helpers' desks slowly with a clipboard", () => {
  const world = createWorld();
  const subs = Array.from({ length: 6 }, (_, i) => sub(`s${i}`, { startedTs: iso(T0 + i) }));
  world.sync(snap([roomA(subs, "delegating")]), { first: true });
  const lead = world.characters.get("A");
  const room = world.rooms.get("A");
  const sides = new Set(room.desks.slice(0, 6).map((d) => `${d.side.x},${d.side.y}`));
  const visited = new Set();
  let maxStep = 0;
  let prev = { x: lead.x, y: lead.y };
  for (let i = 0; i < 600; i++) {
    world.update(0.05);
    maxStep = Math.max(maxStep, Math.hypot(lead.x - prev.x, lead.y - prev.y));
    prev = { x: lead.x, y: lead.y };
    if (!lead.moving) {
      assert.equal(lead.pose, "supervise");
      visited.add(`${lead.x},${lead.y}`);
    }
  }
  const stops = [...visited].filter((k) => sides.has(k));
  assert.ok(stops.length >= 2 && stops.length <= 3, `patrols 2–3 helper desks (${stops.length})`);
  assert.ok(maxStep < MAX_STEP_PX * 0.6, "patrol walk is slower than a normal walk");
  assert.equal(lead.caption.text, "สั่งงานผู้ช่วย");
  // ไม่มีผู้ช่วยให้ดูแล → ยืนคุมข้างโต๊ะตัวเอง
  const solo = createWorld();
  solo.sync(snap([roomA([], "delegating")]), { first: true });
  const sl = solo.characters.get("A");
  const beside = solo.rooms.get("A").spots.leadBeside;
  assert.deepEqual([sl.x, sl.y, sl.pose], [beside.x, beside.y, "supervise"]);
});

/* ───────────────────────── property / soak ด้วย fixture ของ brain ───────────────────────── */

// ค่าที่ sprites.js รู้จัก (จากสัญญาในสเปก) — world ห้ามส่งค่านอกชุดนี้ให้ scene วาด
const KNOWN_POSES = new Set([
  "stand", "walk", "sit-type", "sit-think", "sit-idle", "sit-slump", "sit-sleep", "sip", "read", "reach",
  "type-stand", "write-board", "think-stand", "raise-hand", "phone", "supervise", "celebrate", "sad", "oops",
  "wave", "read-letter", "give",
]);
const DIRS = new Set(["down", "up", "left", "right"]);
const FACES = new Set(["normal", "happy", "sad", "sleep", "talk", "surprised", "think"]);
const ITEMS = new Set(["paper", "letter", "mug", "book", "clipboard"]);
const BUBBLE_KINDS = new Set(["speech", "thought", "alert"]);
const ICONS = new Set(
  ("book magnifier terminal pencil globe checklist graph robot question exclaim plug wrench eye chart " +
    "bulb dots check cross envelope coffee warning zzz star heart").split(" "),
);
const EFFECT_KINDS = new Set(["poof", "spark", "smoke", "rain", "storm", "zzz", "letter", "paper", "stamp", "heart", "sparkle"]);
const PROP_VARIANTS = {
  door: ["closed", "open"], window: ["default", "dark"], whiteboard: ["clean", "scribble"], cctv: ["default", "on"],
  clock: ["default"], scoreboard: ["default"], poster: ["0", "1", "2"], mailbox: ["empty", "full"],
  bookshelf: ["default"], cabinet: ["closed", "open"], terminal: ["idle", "active", "error"], kiosk: ["idle", "active"],
  toolbox: ["default"], printer: ["idle", "active"], coffee: ["default"], phone: ["idle", "ringing"],
  couch: ["default"], plant: ["0", "1"], desk: ["off", "on", "error"], chair: ["default"],
  "lead-desk": ["off", "on", "error"], "lead-chair": ["default"], rug: ["default"], "side-door": ["closed", "open"],
};
const MAX_EFFECTS = 360;

/**
 * ตรวจทุกเฟรม (ถูกเรียกบ่อย — สร้างข้อความ error เฉพาะตอนพลาดเท่านั้น)
 * `prev` = ตำแหน่งเฟรมก่อนของแต่ละ key: คนที่มีอยู่แล้วต้อง "เดิน" ไม่ใช่วาร์ป (ตำแหน่งเป็นพิกัดในห้อง
 * จึงไม่ขึ้นกับการเลื่อนห้อง) — ยกเว้นคนที่เพิ่งเกิดใน sync ล่าสุด ซึ่งถูกวางที่ประตู/ที่ของตัวเองครั้งแรก
 */
function checkFrame(world, where, prev) {
  for (const ch of world.characters.values()) {
    const room = world.rooms.get(ch.sessionId);
    if (!room) assert.fail(`${where}: ${ch.key} has no room`);
    const { x, y } = ch;
    const p = prev && prev.get(ch.key);
    // ผู้ช่วยที่เพิ่งเข้าห้องและทางเดินไกล "รีบ" ได้ ×1.5 (ENTER_HURRY ใน world.js) — เกินนั้นคือวาร์ป
    const hurry = ch._s && ch._s.beat && ch._s.beat.type === "enter" && ch._s.desire && ch._s.desire.hurry ? 1.5 : 1;
    if (p && p.ch === ch && Math.hypot(x - p.x, y - p.y) > MAX_STEP_PX * hurry) {
      assert.fail(`${where}: ${ch.key} jumped ${Math.hypot(x - p.x, y - p.y).toFixed(1)} px (${p.x},${p.y}) → (${x},${y}) pose=${ch.pose}`);
    }
    if (prev) {
      /*
       * "ไม่เดินเลยแล้วถอยกลับ": ระหว่างที่เป้าหมายยังเป็นจุดเดิม ทิศการเดินสองเฟรมติดกันต้องไม่สวนทางกัน
       * (ถ้าสวน = มูนวอล์ก/เดินเลยครึ่งช่องแล้วย้อน) — อ่านเป้าจาก _s ภายใน world (ไม่มี → ข้ามการตรวจนี้)
       */
      const tg = ch._s && ch._s.target;
      const tid = tg ? `${tg.id}@${tg.tx},${tg.ty}` : "";
      let v = null;
      if (p && p.ch === ch && p.tid === tid) {
        v = { x: x - p.x, y: y - p.y };
        const la = Math.hypot(v.x, v.y);
        const lb = p.v ? Math.hypot(p.v.x, p.v.y) : 0;
        if (tid && la > 0.05 && lb > 0.05 && (v.x * p.v.x + v.y * p.v.y) / (la * lb) < -0.5) {
          assert.fail(`${where}: ${ch.key} walked past and back while heading to ${tid} (${p.x},${p.y}) → (${x},${y})`);
        }
      }
      prev.set(ch.key, { ch, x, y, tid, v });
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(ch.sortY) || !Number.isFinite(ch.alpha)) {
      assert.fail(`${where}: ${ch.key} has a non-finite position/alpha (${x}, ${y}, ${ch.sortY}, ${ch.alpha})`);
    }
    if (x < 0 || y < 0 || x > room.w * TILE || y > room.h * TILE) {
      assert.fail(`${where}: ${ch.key} outside its room (${x}, ${y}) in ${room.w}×${room.h}`);
    }
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (room.grid.blocked[ty * room.w + tx]) {
      assert.fail(`${where}: ${ch.key} ${ch.moving ? "walking" : "at rest"} on blocked tile (${tx},${ty}) pose=${ch.pose}`);
    }
    if (ch.alpha < 0 || ch.alpha > 1) assert.fail(`${where}: ${ch.key} alpha ${ch.alpha}`);
    if (Math.abs(ch.sortY - (room.y + y)) > 1e-6) assert.fail(`${where}: ${ch.key} sortY out of date`);
    if (!KNOWN_POSES.has(ch.pose)) assert.fail(`${where}: ${ch.key} unknown pose ${ch.pose}`);
    if (!DIRS.has(ch.dir)) assert.fail(`${where}: ${ch.key} unknown dir ${ch.dir}`);
    if (!FACES.has(ch.face)) assert.fail(`${where}: ${ch.key} unknown face ${ch.face}`);
    if (ch.item !== null && !ITEMS.has(ch.item)) assert.fail(`${where}: ${ch.key} unknown item ${ch.item}`);
    if (!Number.isInteger(ch.frame) || ch.frame < 0 || ch.frame > 3) assert.fail(`${where}: ${ch.key} frame ${ch.frame}`);
    const b = ch.bubble;
    if (b !== null && (!BUBBLE_KINDS.has(b.kind) || !ICONS.has(b.icon) || typeof b.tone !== "string")) {
      assert.fail(`${where}: ${ch.key} bad bubble ${JSON.stringify(b)}`);
    }
    const c = ch.caption;
    if (typeof c.text !== "string" || !c.text || typeof c.icon !== "string" || typeof c.replay !== "boolean") {
      assert.fail(`${where}: ${ch.key} bad caption ${JSON.stringify(c)}`);
    }
    if (c.sinceMs !== null && !Number.isFinite(c.sinceMs)) assert.fail(`${where}: ${ch.key} caption.sinceMs ${c.sinceMs}`);
    // ความซื่อตรง: caption แบบเล่าย้อนมีได้เฉพาะหัวหน้าที่ "กำลังคิด" จริงเท่านั้น
    if (c.replay && !(ch.role === "lead" && ch.node && ch.node.status && ch.node.status.state === "thinking")) {
      assert.fail(`${where}: ${ch.key} shows a replay caption while its live state is ${ch.node && ch.node.status && ch.node.status.state}`);
    }
  }
  if (world.effects.length > MAX_EFFECTS) assert.fail(`${where}: ${world.effects.length} effects`);
  for (const e of world.effects) {
    if (!EFFECT_KINDS.has(e.kind) || !world.rooms.has(e.sessionId) || !Number.isFinite(e.x) || !Number.isFinite(e.y)) {
      assert.fail(`${where}: bad effect ${JSON.stringify(e)}`);
    }
  }
}

/** ตรวจหลังแต่ละ poll: จำนวนคน เพดาน โต๊ะ ความซื่อตรงของ caption และเพดานของโครงสร้างภายใน */
function checkTick(world, s, where) {
  const sessions = s.agents;
  let totalSubs = 0;
  let helpersTotal = 0;
  for (const sess of sessions) {
    const room = world.rooms.get(sess.sessionId);
    assert.ok(room, `${where}: room for ${sess.sessionId}`);
    const ids = new Set();
    let running = 0;
    for (const x of sess.subagents) {
      if (ids.has(x.agentId)) continue;
      ids.add(x.agentId);
      if (x.running === true) running++;
    }
    totalSubs += ids.size;
    const helpers = helpersOf(world, sess.sessionId);
    helpersTotal += helpers.length;
    const active = helpers.filter((c) => !c.leaving).length;
    // เพดานการวาดนับเฉพาะคนที่ยังทำงานอยู่ — คนที่จบงานแล้ว (กำลังส่งงาน/เดินออก) ไม่กินที่ของคนที่ยังทำงาน
    assert.ok(active <= world.maxHelpersPerRoom, `${where}: ${active} working helpers > cap`);
    // ตัวละคร = sub ที่ running จริง (ส่วนเกินเพดานนับเป็น overflow) + คนที่กำลังส่งงาน/เดินออก
    assert.equal(active + room.overflow, running, `${where}: active ${active} + overflow ${room.overflow} ≠ running ${running}`);
    for (const h of helpers) {
      if (h.leaving) {
        // คนที่จบงานแล้วคืนโต๊ะทันที (ไม่กลับไปนั่งอีก) — โต๊ะนั้นเป็นของคนที่รอเข้าห้อง
        assert.equal(h.deskIndex, null, `${where}: leaving ${h.key} returned its desk`);
        continue;
      }
      assert.ok(h.deskIndex !== null && h.deskIndex < room.desks.length, `${where}: ${h.key} desk index`);
      assert.equal(room.desks[h.deskIndex].owner, h.key, `${where}: ${h.key} owns its desk`);
    }
    for (const d of room.desks) {
      if (d.owner) assert.equal(world.characters.get(d.owner)?.deskIndex, d.index, `${where}: desk ${d.index} owner is real`);
    }
    const lead = world.characters.get(sess.sessionId);
    if (sess.alive !== false) {
      assert.ok(lead && !lead.leaving, `${where}: live session has its lead`);
      const st = sess.status && sess.status.state;
      const e = st === "tool" ? (sess.status.running || []).find((r) => !["Agent", "Task", "AskUserQuestion"].includes(r.tool)) : null;
      if (e) {
        // หัวหน้าที่มี tool จริงกำลังรัน: caption ต้องเป็นของจริง พร้อมเวลาเริ่มจริง
        assert.equal(lead.caption.replay, false, `${where}: live tool beats replay`);
        assert.ok(lead.caption.text.startsWith(activityForTool(e.tool).verb), `${where}: caption verb for ${e.tool}`);
        const started = Date.parse(e.startedTs);
        if (Number.isFinite(started)) assert.equal(lead.caption.sinceMs, started, `${where}: caption elapsed from startedTs`);
      }
    } else {
      assert.ok(!lead || lead.leaving, `${where}: ended session's lead is gone or leaving`);
    }
    for (const p of room.props) {
      assert.ok(PROP_VARIANTS[p.name].includes(p.variant), `${where}: ${p.id} variant ${p.variant}`);
    }
  }
  const st = world.stats();
  const n = sessions.length;
  assert.deepEqual([st.rooms, st.slots, st.sessionsTracked, st.subSessionsTracked], [n, n, n, n], `${where}: per-session maps`);
  assert.equal(st.subTracked, totalSubs, `${where}: sub diff tracks only listed subs`);
  assert.equal(st.helperIndex, helpersTotal, `${where}: helper index`);
  assert.ok(st.reservations <= st.characters, `${where}: reservations ${st.reservations} ≤ characters ${st.characters}`);
  assert.ok(st.queued <= st.characters, `${where}: queued`);
  assert.ok(st.queuedBeats <= 2 * st.characters, `${where}: beats queue ≤ 2 per character`);
  const cap = 2 * (st.characters + st.rooms) + totalSubs;
  assert.ok(st.narrationKeys <= cap && st.narrationPending <= cap, `${where}: narration maps bounded`);
  assert.ok(st.effects <= MAX_EFFECTS);
  // ห้อง (ตามตำแหน่งเป้าหมาย) ไม่ทับกัน และอยู่ใน bounds()
  const rs = Array.from(world.rooms.values());
  const bb = world.bounds();
  assert.equal(new Set(rs.map((r) => r.slot)).size, rs.length, `${where}: unique slots`);
  for (let i = 0; i < rs.length; i++) {
    const a = rs[i];
    assert.ok(a.tx >= bb.x && a.ty >= bb.y && a.tx + a.w * TILE <= bb.x + bb.w && a.ty + a.h * TILE <= bb.y + bb.h, `${where}: bounds`);
    for (let j = i + 1; j < rs.length; j++) {
      const b = rs[j];
      const overlap = a.tx < b.tx + b.w * TILE && b.tx < a.tx + a.w * TILE && a.ty < b.ty + b.h * TILE && b.ty < a.ty + a.h * TILE;
      assert.ok(!overlap, `${where}: rooms ${a.slot} and ${b.slot} overlap`);
    }
  }
}

/** รัน fixture หนึ่ง scenario: ~400 poll (poll ละ 0.7 วิของโลก = 14 × update(0.05)) แล้วตรวจทุกอย่าง */
function soak(scenario, { ticks = 400, steps = 14, options = {}, seed = 7 } = {}) {
  const fx = createFixture({ sessions: 2, scenario, speed: 1, seed });
  const world = createWorld(options);
  const lines = [];
  world.onNarrate((l) => lines.push(l));
  const errorsBefore = worldErrors.length;
  let maxChars = 0;
  let maxDepthHelper = 0;
  let last = null;
  const kinds = new Set();
  const prevPos = new Map();
  const deskSizes = new Map();
  let grew = 0;
  let shrank = 0;
  for (let i = 0; i < ticks; i++) {
    const s = fx.next();
    last = s;
    world.sync(s, { first: i === 0 });
    if (i === 0) assert.equal(lines.length, 0, `${scenario}: first sync is silent`);
    const where = `${scenario}#${i}`;
    // คนที่เพิ่งถูกสร้างใน sync นี้ถูกวางตำแหน่งแรก (ประตู/ที่นั่ง) — ลบออกจาก prev ให้ไม่นับเป็นการวาร์ป
    for (const key of Array.from(prevPos.keys())) {
      const e = prevPos.get(key);
      if (world.characters.get(key) !== e.ch) prevPos.delete(key);
      else if (e.x !== e.ch.x || e.y !== e.ch.y) assert.fail(`${where}: sync moved ${key} without walking`);
    }
    for (let k = 0; k < steps; k++) {
      world.update(0.05);
      checkFrame(world, where, prevPos);
      for (const e of world.effects) kinds.add(e.kind);
    }
    checkTick(world, s, where);
    maxChars = Math.max(maxChars, world.characters.size);
    for (const ch of world.characters.values()) {
      if (ch.role === "helper" && ch.parentKey !== ch.sessionId) maxDepthHelper = Math.max(maxDepthHelper, 2);
    }
    for (const room of world.rooms.values()) {
      const prev = deskSizes.get(room.sessionId);
      if (prev !== undefined && room.desks.length > prev) grew++;
      if (prev !== undefined && room.desks.length < prev) shrank++;
      deskSizes.set(room.sessionId, room.desks.length);
    }
  }
  assert.deepEqual(worldErrors.slice(errorsBefore), [], `${scenario}: world.js reported internal errors`);
  // ทุก session หายไป → ทุกโครงสร้างภายในต้องกลับเป็นศูนย์ (ไม่มีอะไรรั่วค้างในแท็บที่เปิดทิ้งไว้)
  world.sync({ nowMs: last.nowMs + 700, agents: [] });
  run(world, 12);
  const end = world.stats();
  for (const [k, v] of Object.entries(end)) if (k !== "listeners") assert.equal(v, 0, `${scenario}: stats.${k} drains to 0`);
  return { lines, maxChars, maxDepthHelper, kinds, grew, shrank };
}

for (const scenario of ["auto", "idle", "thinking", "cascade", "storm", "errors"]) {
  test(`soak: fixture scenario "${scenario}" keeps every invariant for 400 polls`, () => {
    const r = soak(scenario);
    assert.ok(r.lines.length > 0, "the story feed tells something after the baseline");
    assert.ok(r.lines.every((l) => typeof l.text === "string" && l.text && typeof l.sessionId === "string"));
    assert.ok(r.lines.every((l) => ["info", "good", "bad", "warn", "spawn"].includes(l.tone)), "known tones only");
    if (scenario === "storm") assert.ok(r.maxChars >= 40, `storm really stressed the world (${r.maxChars} characters)`);
    if (scenario === "cascade") assert.equal(r.maxDepthHelper, 2, "cascade produced helpers hired by helpers");
    if (scenario === "errors") assert.ok(r.lines.some((l) => l.icon === "💥" || l.icon === "🛑" || l.icon === "⛔"));
  });
}

test("soak: storm with a small cap + reduceMotion (overflow, grow/shrink, no bursts)", () => {
  const r = soak("storm", { ticks: 300, options: { maxHelpersPerRoom: 12, reduceMotion: true }, seed: 11 });
  for (const burst of ["poof", "spark", "smoke", "sparkle", "heart"]) assert.ok(!r.kinds.has(burst), `no ${burst} with reduceMotion`);
  assert.ok(r.grew > 0, "rooms grew under load");
  assert.ok(r.shrank > 0, "and shrank back after the storm (hysteresis)");
});

/* ───────────────────────── รอบแก้ตามคำวิจารณ์ (critic round 1) ───────────────────────── */

test("helpers: a tool change mid-walk sends the helper back to its desk (no cross-room re-route); no tool → seat", () => {
  const world = createWorld();
  const subs = Array.from({ length: 5 }, (_, i) => sub(`s${i}`, { startedTs: iso(T0 + i) }));
  world.sync(snap([roomA(subs, "thinking")]), { first: true });
  run(world, 0.3);
  const h = world.characters.get("A:s4"); // โต๊ะ 4 = ขวาสุดของแถวแรก ไกลชั้นหนังสือ > 8 ช่อง
  const seat = world.rooms.get("A").desks[h.deskIndex].seat;
  // Read ที่รันมานานแล้ว (น่าจะรันต่อ) → คุ้มที่จะเดินไปชั้นหนังสือ
  const oldRead = { tool: "Read", icon: "📖", label: "big.md", startedTs: iso(T0 - 20000) };
  world.sync(snap([roomA(subs.map((s, i) => (i === 4 ? { ...s, current: oldRead } : s)), "thinking")], T0 + 700));
  run(world, 0.5);
  assert.equal(h.moving, true, "walking to the bookshelf");
  assert.equal(h._s.target.station, "bookshelf");
  // กลางทาง tool เปลี่ยนเป็น Grep (ตู้เอกสาร = สถานีอื่น) ที่เพิ่งเริ่ม → กลับไปทำที่โต๊ะ ไม่ลากเส้นทางใหม่
  const grep = { tool: "Grep", icon: "🔍", label: "TODO", startedTs: iso(T0 + 1400) };
  world.sync(snap([roomA(subs.map((s, i) => (i === 4 ? { ...s, current: grep } : s)), "thinking")], T0 + 1400));
  const targets = new Set();
  for (let t = 0; t < 5; t += 0.05) {
    world.update(0.05);
    if (h._s.target) targets.add(h._s.target.id);
  }
  assert.ok(!targets.has("st:cabinet"), "never re-routed to the cabinet mid-walk");
  assert.deepEqual([h.x, h.y, h.pose], [seat.x, seat.y, "sit-type"], "does the search at its own desk");
  assert.equal(h.bubble.icon, "magnifier", "with the station icon over its head");
  assert.equal(h.caption.text, "ค้นหา TODO", "caption stays the real tool");
  // tool จบ → นั่งคิดที่โต๊ะเสมอ
  world.sync(snap([roomA(subs, "thinking")], T0 + 2100));
  run(world, 0.2);
  assert.deepEqual([h.x, h.y, h.pose], [seat.x, seat.y, "sit-think"]);
});

test("exit: finished helpers return their desk at once; a far delivery is handed over in place, then poof", () => {
  const world = createWorld();
  const lines = collect(world);
  const subs = Array.from({ length: 6 }, (_, i) => sub(`s${i}`, { startedTs: iso(T0 + i) }));
  world.sync(snap([roomA(subs, "idle")]), { first: true }); // หัวหน้าจิบกาแฟอยู่ฝั่งขวา
  run(world, 0.5);
  const h = world.characters.get("A:s5"); // โต๊ะ 5 = แถวสอง ซ้ายสุด (ไกลเครื่องกาแฟ > 10 ช่อง)
  const desk = h.deskIndex;
  const room = world.rooms.get("A");
  world.sync(snap([roomA(subs.map((s, i) => (i === 5 ? { ...s, running: false, outcome: "ok" } : s)), "idle")], T0 + 700));
  assert.equal(h.leaving, true);
  assert.equal(h.deskIndex, null, "gave its desk back immediately");
  assert.equal(room.desks[desk].owner, null);
  const start = { x: h.x, y: h.y };
  const fx = new Set();
  const tr = trace(world, "A:s5", 6, () => {
    for (const e of world.effects) fx.add(e.kind);
  });
  assert.ok(tr.removedAt !== null && tr.removedAt < 3.5, `gone quickly (t=${tr.removedAt})`);
  assert.ok(tr.steps.some((s) => s.pose === "give"), "still hands the report over");
  assert.ok(!tr.steps.some((s) => s.pose === "walk"), "no walk across the room");
  assert.ok(tr.steps.every((s) => s.x === start.x && s.y === start.y), "stays where it finished");
  assert.ok(fx.has("paper"), "the report flies to the hirer");
  assert.ok(fx.has("poof"), "poofs out");
  assert.equal(lines.filter((l) => l.icon === "✅").length, 1);
});

test("feed: same-type hirer/deliverer get a short id; deliveries within ~2 s merge into one line", () => {
  const world = createWorld();
  const lines = collect(world);
  const p = sub("p1a2b3", { type: "scout" });
  const k = sub("k9f8e7", { type: "scout", parentAgentId: "p1a2b3", depth: 2, startedTs: iso(T0 + 1) });
  const others = [sub("x1", { type: "analyst", startedTs: iso(T0 + 2) }), sub("x2", { type: "writer", startedTs: iso(T0 + 3) })];
  world.sync(snap([roomA([p, k, ...others], "thinking")]), { first: true });
  run(world, 0.5);
  world.sync(snap([roomA([p, { ...k, running: false, outcome: "ok" }, ...others], "thinking")], T0 + 700));
  const ok1 = lines.filter((l) => l.icon === "✅");
  assert.equal(ok1.length, 1);
  assert.equal(ok1[0].text, "room-A: scout·k9f8 ส่งงานให้ scout·p1a2 แล้ว", "room + short ids on every line");
  // อีกสองคนจบในรอบถัดไป (ยังอยู่ในหน้าต่าง ~2 วิ) → ยังไม่เล่าทันที แล้วรวมเป็นบรรทัดเดียว
  const done = (s) => ({ ...s, running: false, outcome: "ok" });
  world.sync(snap([roomA([p, done(k), done(others[0]), done(others[1])], "thinking")], T0 + 1400));
  assert.equal(lines.filter((l) => l.icon === "✅").length, 1, "held while the window is open");
  run(world, 2.2);
  const ok2 = lines.filter((l) => l.icon === "✅");
  assert.equal(ok2.length, 2);
  assert.equal(ok2[1].text, "room-A: ผู้ช่วย 2 คน (analyst, writer) ส่งงานให้หัวหน้าแล้ว");
  run(world, 3);
  assert.equal(world.stats().narrationPending, 0, "the merge window closes when nothing is left");
});

test("layout hint: 3–4 rooms pack 2×2 on a 1440×900-like view, one column on a phone", () => {
  const ids = ["A", "B", "C", "D"];
  const packed = (hint) => {
    const w = createWorld();
    if (hint) w.setLayoutHint(hint);
    w.sync(snap(ids.map((id) => session(id))), { first: true });
    w.update(0.05);
    return new Set(Array.from(w.rooms.values(), (r) => r.tx)).size;
  };
  assert.equal(packed(null), 3, "no hint → the classic landscape packing");
  assert.equal(packed({ width: 1128, height: 690 }), 2, "wide view with the right HUD column → 2 columns");
  assert.equal(packed({ width: 380, height: 520 }), 1, "phone → 1 column");
  // hint ใหม่หลังจากนั้น (ผู้ใช้ย่อหน้าต่าง) → จัดผังใหม่แบบ tween ไม่วาร์ป
  const w = createWorld();
  w.sync(snap(ids.map((id) => session(id))), { first: true });
  w.update(0.05);
  w.setLayoutHint({ width: 380, height: 520 });
  w.setLayoutHint({ width: 380, height: 520 }); // ค่าซ้ำไม่ทำอะไร
  w.update(0.05);
  const c = w.rooms.get("C"); // 3 คอลัมน์ → C อยู่ขวาสุดของแถวแรก · 1 คอลัมน์ → แถวที่สาม
  assert.equal(c.tx, 0);
  assert.ok(c.x !== c.tx && c.y !== c.ty, "room C slides to its new place");
  run(w, 0.5);
  assert.deepEqual([c.x, c.y], [c.tx, c.ty]);
  assert.equal(new Set(Array.from(w.rooms.values(), (r) => r.slot)).size, 4, "slots never change");
});

test("dwell: a lead that must linger ~1 s drops the old state's pose and bubble right away", () => {
  const { world, lead } = leadWorld();
  push(world, { status: { state: "waiting", since: iso(T0), running: [{ tool: "Bash", label: "rm", startedTs: iso(T0) }] } });
  let arrived = false;
  for (let t = 0; t < 6 && !arrived; t += 0.05) {
    world.update(0.05);
    arrived = !lead.moving && lead.pose === "raise-hand";
  }
  assert.ok(arrived, "raises a hand at the ask booth");
  push(world, { status: THINKING });
  world.update(0.05);
  assert.equal(lead.caption.text, "คิดอยู่");
  assert.equal(lead.moving, false, "still lingers (minimum dwell)");
  assert.equal(lead.pose, "stand", "but no longer raises a hand for a permission nobody asks");
  assert.equal(lead.bubble, null);
  assert.equal(propOf(world, "A", "phone").variant, "idle", "the phone stops ringing");
});

test("stations: the lead stands beside the phone/coffee (not in front), sleeps on the middle cushion; mail note", () => {
  const L = buildRoomLayout(2);
  const near = (st, px) => st.slots.every((s) => s.ty === 3 && Math.abs(s.tx - px) === 1);
  assert.ok(near(L.stations.phone, 19), "phone spot is beside the podium on the same row");
  assert.ok(near(L.stations.coffee, 17), "coffee spot is beside the machine on the same row");
  const { world, lead } = leadWorld();
  push(world, { status: { state: "idle", since: iso(T0 - 60000), running: [] } });
  run(world, 6);
  assert.equal(lead.pose, "sit-sleep");
  assert.deepEqual([Math.floor(lead.x / TILE), Math.floor(lead.y / TILE)], [21, 8], "middle cushion, not the armrest");
  // บทจดหมาย: ป้ายเสริมบอกข้อความ prompt จริง ระหว่างที่บทเล่นอยู่เท่านั้น
  push(world, { status: THINKING, events: [{ i: 1, kind: "prompt", ts: iso(T0), text: "ช่วยแก้บั๊ก login" }] });
  world.update(0.05);
  world.update(0.05);
  assert.equal(lead.captionNote, '📬 คำสั่งใหม่: "ช่วยแก้บั๊ก login"');
  assert.equal(lead.caption.text, "คิดอยู่", "the main caption is still the live state");
  run(world, 8);
  assert.equal(lead.captionNote, null);
});

/* ───────────────────────── รอบแก้ตามคำวิจารณ์ (critic round 2) ───────────────────────── */

/** ห้องที่มีผู้ช่วยวิ่งอยู่ n คน (ห้องโตสูงตามจำนวนโต๊ะ) */
function busyRoom(id, n) {
  const subs = Array.from({ length: n }, (_, i) => sub(`${id}${i}`, { startedTs: iso(T0 + i) }));
  return session(id, { status: { state: "delegating", since: iso(T0), running: [{ tool: "Agent", label: "x", startedTs: iso(T0) }] }, subagents: subs });
}

test("layout: with 5+ rooms or tall rooms the fit overflows downward only (never under the right HUD column)", () => {
  const HINT = { width: 1124, height: 570 }; // 1440×900 ลบแถบบน คอลัมน์ขวา และฟีด (DPR 1)
  const ROOM_PX = 26 * TILE;
  const cols = (w) => new Set(Array.from(w.rooms.values(), (r) => r.tx)).size;
  // 7 ห้องขนาดปกติ: ไม่มีแบบไหนพอดีที่ ×1 → คอลัมน์มากสุดที่ยังกว้างไม่เกินจอ (2) ไม่ใช่ 4 คอลัมน์ที่มุดใต้แผง
  const w7 = createWorld();
  w7.setLayoutHint(HINT);
  w7.sync(snap("ABCDEFG".split("").map((id) => session(id))), { first: true });
  w7.update(0.05);
  assert.equal(cols(w7), 2);
  const b = w7.bounds();
  assert.ok(b.w <= HINT.width, `office width ${b.w} fits the visible width`);
  for (const r of w7.rooms.values()) assert.ok(r.tx + ROOM_PX <= HINT.width, `${r.sessionId} never lands right of the view`);
  // ห้องเท่ากันหมด → masonry = เติมทีละแถวแบบเดิม (slot 0,1 แถวบน · 2,3 แถวสอง …)
  const bySlot = Array.from(w7.rooms.values()).sort((a, c) => a.slot - c.slot);
  assert.deepEqual(bySlot.map((r) => [r.tx / ROOM_PX > 0.5 ? 1 : 0, r.ty > 0]), [
    [0, false], [1, false], [0, true], [1, true], [0, true], [1, true], [0, true],
  ]);

  // ห้องสูงสองห้อง (พายุงาน): ยืนเคียงกัน ไม่ซ้อนเป็นตึก และห้องเตี้ยไปต่อใต้คอลัมน์ที่เตี้ยกว่า
  const wt = createWorld();
  wt.setLayoutHint(HINT);
  wt.sync(snap([busyRoom("A", 60), session("B"), busyRoom("C", 60), session("D")]), { first: true });
  wt.update(0.05);
  const [A, B, C, D] = ["A", "B", "C", "D"].map((id) => wt.rooms.get(id));
  assert.ok(A.h > 40 && C.h > 40, "A and C grew tall");
  assert.equal(A.tx, 0);
  assert.equal(B.tx, C.tx, "C goes under the short room B, i.e. beside A");
  assert.ok(C.ty < A.ty + A.h * TILE, "the two tall rooms sit side by side");
  assert.equal(D.tx, A.tx, "D goes to the shorter column");
  assert.ok(wt.bounds().w <= HINT.width);
  for (const r of [A, B, C, D]) {
    for (const o of [A, B, C, D]) {
      if (o === r) continue;
      const overlap = r.tx < o.tx + o.w * TILE && o.tx < r.tx + r.w * TILE && r.ty < o.ty + o.h * TILE && o.ty < r.ty + r.h * TILE;
      assert.ok(!overlap, `${r.sessionId} and ${o.sessionId} do not overlap`);
    }
  }
});

test("hire burst: newcomers wait off-stage until their threshold tile is free — never a translucent heap on the door", () => {
  const world = createWorld();
  world.sync(snap([roomA([])]), { first: true });
  run(world, 0.3);
  const room = world.rooms.get("A");
  const many = Array.from({ length: 12 }, (_, i) => sub(`h${i}`, { startedTs: iso(T0 + i) }));
  world.sync(snap([roomA(many)], T0 + 700));
  let maxOnThreshold = 0;
  for (let t = 0; t < 8; t += 0.05) {
    world.update(0.05);
    const shown = helpersOf(world, "A").filter((c) => c.alpha > 0.02 || c._s.fadeIn);
    // ไม่มีสองคนที่ "มองเห็นอยู่" ยืนห่างกันไม่ถึงครึ่งตัวบนแถวธรณี
    const onDoor = shown.filter((c) => Math.abs(c.y - room.door.y) < 6);
    maxOnThreshold = Math.max(maxOnThreshold, onDoor.length);
    for (let i = 0; i < onDoor.length; i++) {
      for (let j = i + 1; j < onDoor.length; j++) {
        const a = onDoor[i];
        const b = onDoor[j];
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 12, `t=${t.toFixed(2)} ${a.key} and ${b.key} overlap on the threshold`);
      }
    }
  }
  assert.ok(maxOnThreshold <= 2, "at most one newcomer per threshold tile");
  const hs = helpersOf(world, "A");
  assert.equal(hs.length, 12);
  for (const h of hs) {
    assert.equal(h.alpha, 1, `${h.key} has entered`);
    assert.ok(!h.moving && h.pose === "sit-think", `${h.key} is seated`);
  }
});

test("side doors: a grown room gets doors in the left wall; helpers enter/leave by the door nearest their desk, quickly", () => {
  const world = createWorld();
  world.sync(snap([roomA([], "thinking")]), { first: true });
  run(world, 0.3);
  const subs = Array.from({ length: 40 }, (_, i) => sub(`d${i}`, { startedTs: iso(T0 + i) }));
  world.sync(snap([roomA(subs, "thinking")], T0 + 700));
  const room = world.rooms.get("A");
  assert.equal(room.deskRows, 8);
  assert.deepEqual(room.doors.map((d) => d.ty), [3, 13, 19, 25]);
  assert.ok(room.props.some((p) => p.name === "side-door" && p.tx === 0 && p.ty === 13));
  // ประตูของแต่ละคน = ประตูที่ใกล้โต๊ะที่สุด (โต๊ะชุดล่าง ๆ ไม่ต้องเดินจากมุมซ้ายบนอีก)
  const bySide = new Map();
  for (const h of helpersOf(world, "A")) {
    const seat = room.desks[h.deskIndex].seat;
    const group = Math.floor(h.deskIndex / 5);
    if (group >= 2) {
      assert.equal(h.x, 8, `${h.key} (group ${group}) enters by a side door`);
      const d = room.doors.find((x) => x.tx === 0 && x.y === h.y);
      assert.ok(d, `${h.key} stands in a side doorway`);
      assert.ok(Math.abs(d.ty - seat.ty) <= 3, `${h.key}: side door row ${d.ty} is next to its seat row ${seat.ty}`);
      bySide.set(d.id, (bySide.get(d.id) || 0) + 1);
    } else {
      assert.equal(h.y, room.door.y, `${h.key} (group ${group}) uses the main door`);
    }
  }
  assert.equal(bySide.size, 3, "every side door is used");
  // ทุกคนได้นั่งเร็ว: ทางเข้าสั้น + รีบเมื่อทางยาว (เดิมโต๊ะแถวล่างใช้ 7–10 วิ)
  const seatedAt = new Map();
  let sideOpen = false;
  for (let t = 0; t < 12 && seatedAt.size < 40; t += 0.05) {
    world.update(0.05);
    if (room.props.some((p) => p.name === "side-door" && p.variant === "open")) sideOpen = true;
    for (const h of helpersOf(world, "A")) {
      const seat = room.desks[h.deskIndex].seat;
      if (!seatedAt.has(h.key) && h.x === seat.x && h.y === seat.y && !h.moving) seatedAt.set(h.key, t);
    }
  }
  assert.equal(seatedAt.size, 40, "everyone reached their seat");
  assert.ok(sideOpen, "side doors open while someone walks through");
  const worst = Math.max(...seatedAt.values());
  assert.ok(worst < 8, `slowest newcomer seated after ${worst.toFixed(1)} s`);
  // ผู้ช่วยโต๊ะชุดล่างจบงาน (ผู้จ้างไกล → ยื่นจากที่ยืน) หรือคนที่ใกล้ประตูข้างเดินออกทางประตูข้าง
  const leaver = helpersOf(world, "A").find((h) => h.deskIndex === 15); // ชุดที่ 3 ซ้ายสุด ติดประตูข้างแถว 13
  world.sync(snap([roomA(subs.map((s) => (s.agentId === leaver.agentId ? { ...s, running: false, outcome: "killed" } : s)), "thinking")], T0 + 1400));
  const tr = trace(world, leaver.key, 10);
  assert.ok(tr.removedAt !== null, "left the room");
  const last = tr.steps[tr.steps.length - 1];
  assert.ok(last.x <= 24 && Math.abs(last.y - (13 * TILE + 13)) <= TILE, `left through the side door (${last.x},${last.y})`);
});

test("deliver: hirer gone → no handover to nobody; far hirer → the paper really flies to them and they ack on arrival", () => {
  // หัวหน้ากลับบ้านแล้ว (session จบ) → ผู้ช่วยที่จบงานไม่ยื่นกระดาษให้เก้าอี้ว่าง
  const world = createWorld();
  const subs = [sub("s1"), sub("s2")];
  world.sync(snap([roomA(subs, "thinking")]), { first: true });
  run(world, 0.3);
  world.sync(snap([roomA(subs, "thinking", { alive: false })], T0 + 700));
  run(world, 15);
  assert.ok(!world.characters.has("A"), "the lead went home");
  world.sync(snap([roomA([{ ...subs[0], running: false, outcome: "ok" }, subs[1]], "thinking", { alive: false })], T0 + 1400));
  const tr = trace(world, "A:s1", 15);
  assert.ok(tr.steps.some((s) => s.pose === "celebrate"), "still celebrates");
  assert.ok(!tr.steps.some((s) => s.pose === "give" || s.item === "paper"), "no paper held out to nobody");
  assert.ok(tr.removedAt !== null);

  // ผู้จ้างอยู่ไกล: ยื่นจากที่ยืน หันหาผู้จ้าง กระดาษบินนานตามระยะ โค้งสูงขึ้น ผู้จ้างขึ้นฟองตอนกระดาษถึง
  const w2 = createWorld();
  const six = Array.from({ length: 6 }, (_, i) => sub(`s${i}`, { startedTs: iso(T0 + i) }));
  w2.sync(snap([roomA(six, "idle")]), { first: true });
  run(w2, 0.5);
  const lead = w2.characters.get("A");
  w2.sync(snap([roomA(six.map((s, i) => (i === 5 ? { ...s, running: false, outcome: "ok" } : s)), "idle")], T0 + 700));
  let giveAt = null;
  let giveDir = null;
  let paper = null;
  let ackAt = null;
  trace(w2, "A:s5", 5, (c, t) => {
    if (c.pose === "give" && giveAt === null) {
      giveAt = t;
      giveDir = c.dir;
      paper = w2.effects.find((e) => e.kind === "paper") || null;
    }
    if (ackAt === null && lead.bubble && lead.bubble.kind === "speech") ackAt = t;
  });
  assert.ok(giveAt !== null, "handed over in place");
  assert.equal(giveDir, "right", "faces the hirer (the lead is far to the right)");
  assert.ok(paper && paper.ttl > 0.6 && paper.arc > 10, "a long, high arc all the way to the hirer");
  assert.deepEqual([paper.to.x, paper.to.y], [lead.x, lead.y - 12], "lands on the hirer");
  assert.ok(ackAt !== null && ackAt > giveAt + 0.3, `the hirer acknowledges when the paper arrives (give ${giveAt}, ack ${ackAt})`);
});

test("deliver: near hand-overs (≤ 6 tiles) are walked even when the room is over its drawing cap", () => {
  const world = createWorld({ maxHelpersPerRoom: 2 });
  const p = sub("p", { type: "researcher" });
  const k = sub("k", { parentAgentId: "p", depth: 2, startedTs: iso(T0 + 1) });
  const extra = sub("x", { startedTs: iso(T0 + 2) });
  const extra2 = sub("y", { startedTs: iso(T0 + 3) });
  world.sync(snap([roomA([p, k, extra, extra2], "thinking")]), { first: true });
  run(world, 0.5);
  assert.equal(world.rooms.get("A").overflow, 2, "two running subs are not drawn");
  world.sync(snap([roomA([p, { ...k, running: false, outcome: "ok" }, extra, extra2], "thinking")], T0 + 700));
  assert.equal(world.rooms.get("A").overflow, 1, "still over the cap when k finishes");
  const parent = world.characters.get("A:p");
  let gaveNear = false;
  const tr = trace(world, "A:k", 12, (c) => {
    if (c.pose === "give") gaveNear ||= Math.abs(parent.x - c.x) / TILE + Math.abs(parent.y - c.y) / TILE <= 2;
  });
  assert.ok(tr.steps.some((s) => s.pose === "walk" && s.item === "paper"), "walks over with the report");
  assert.ok(gaveNear, "hands it over next to the parent");
});

test("no internal errors were reported by world.js during the whole file", () => {
  assert.deepEqual(worldErrors, []);
});
