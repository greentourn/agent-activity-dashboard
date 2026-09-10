/**
 * store.js — ตัวกลางระหว่าง SSE `/api/stream` (หรือ fixture ปลอม) กับหน้า UI
 *
 * ปัญหาที่ไฟล์นี้แก้:
 * 1) server ส่ง "snapshot" ทั้งก้อนมาทุกครั้ง (ไม่ใช่ diff) — ไฟล์นี้ทำหน้าที่ diff เอง
 *    ระหว่างเฟรมก่อนกับเฟรมปัจจุบัน แล้วแปลงเป็น event ย่อย ๆ ที่มีความหมาย (spawn, tool-start,
 *    finish, ...) เพื่อให้ฝั่ง UI ไม่ต้อง diff object ใหญ่ ๆ เองทุกที่
 * 2) การเชื่อมต่อ (EventSource) หลุดได้เสมอ (server รีสตาร์ท, เครือข่ายสะดุด) — ไฟล์นี้จัดการ
 *    reconnect แบบ backoff ให้ ไม่ให้ UI ต้องรู้เรื่องนี้เลย
 * 3) หน่วยความจำ — เก็บ "เคยเห็นอะไรมาแล้วบ้าง" ต่อ session ไว้ใน Map เพื่อ diff ได้ ต้องลบทิ้ง
 *    ทันทีที่ session หายไปจาก snapshot ไม่งั้นรั่วเรื่อย ๆ ตามจำนวน session ที่เคยเปิดมาทั้งหมด
 *
 * ไม่ import อะไรทั้งสิ้น — ไฟล์นี้พึ่งแค่ browser API มาตรฐาน (EventSource, fetch, setTimeout,
 * setInterval) เพื่อให้รันตรงได้โดยไม่มีขั้นตอน build
 */

/**
 * สร้าง store หนึ่งชุด ผูกกับ SSE stream (หรือ fixture) หนึ่งอัน
 * @param {object} [options]
 * @param {string} [options.url] endpoint ของ SSE stream
 * @param {string} [options.stateUrl] endpoint ดึง snapshot ครั้งเดียว (ใช้ paint หน้าจอไว
 *   ก่อนที่ EventSource จะต่อสำเร็จ)
 * @param {() => object} [options.fixture] ถ้าใส่มา จะใช้แทน SSE ทั้งหมด — เรียกซ้ำทุก 700ms
 * @param {number} [options.reconnectMs] ดีเลย์เริ่มต้นก่อน reconnect ครั้งแรก (ms)
 */
export function createStore(options = {}) {
  const url = options.url || "/api/stream";
  const stateUrl = options.stateUrl || "/api/state";
  const fixtureFn = typeof options.fixture === "function" ? options.fixture : null;
  const baseReconnectMs = options.reconnectMs || 1500;

  // ---------- state สาธารณะ (อ่านผ่าน getter ด้านล่าง) ----------
  let snapshot = null;
  let connected = false;
  let running = false;

  // ---------- ตัวเชื่อมต่อ ----------
  let eventSource = null;
  let fixtureTimer = null;
  let reconnectTimer = null;
  let currentReconnectDelay = baseReconnectMs;

  // ---------- listener registry: type -> Set<fn> ----------
  const listeners = new Map();

  // ---------- สถิติเฟรม/token-rate (โชว์ผ่าน .stats) ----------
  const stats = { frames: 0, lastFrameMs: 0, deltaMs: 0, tokensPerSec: 0 };

  // ---------- บัญชี "เคยเห็นอะไรมาแล้ว" ต่อ sessionId — ต้องลบทิ้งเมื่อ session หายไป ----------
  /** @type {Map<string, string>} sessionId -> status.state ล่าสุดที่เคยเห็น */
  const sessionState = new Map();
  /** @type {Map<string, {errors:number, denials:number}>} sessionId -> counts ล่าสุด */
  const sessionCounts = new Map();
  /** @type {Map<string, Map<string, object>>} sessionId -> (key tool|startedTs -> running entry) ของ session เอง */
  const sessionRunningKeys = new Map();
  /** @type {Map<string, number>} sessionId -> ค่า i สูงสุดของ events[] ที่เคยยิงไปแล้ว */
  const sessionMaxEventIndex = new Map();
  /** @type {Map<string, Set<string>>} sessionId -> agentId ของ sub-agent ที่เคยเห็นแล้ว (กัน spawn ซ้ำ) */
  const sessionAgentIds = new Map();
  /** @type {Map<string, Map<string, {key:string}|null>>} sessionId -> agentId -> current tool key ล่าสุด */
  const sessionSubCurrent = new Map();
  /** @type {Map<string, Map<string, number>>} sessionId -> agentId -> errors ล่าสุด */
  const sessionSubErrors = new Map();
  /** @type {Map<string, Map<string, boolean>>} sessionId -> agentId -> running ล่าสุด (จับ true->false = finish) */
  const sessionSubRunning = new Map();
  /** @type {Map<string, number>} sessionId -> ผลรวม token (input+cacheCreate+cacheRead+output) ล่าสุด */
  const sessionTokensSum = new Map();
  /** @type {Map<string, number>} sessionId -> EMA ของ token/วินาที */
  const sessionTokenEma = new Map();

  // ---------- token รวมทั้งระบบ (สำหรับ event "tokens" ที่ sessionId=null) ----------
  let globalTokensSum = null;
  let globalTokenEma = null;

  /**
   * ยิง event ให้ listener ทุกตัวที่ลงทะเบียนไว้ — ครอบ try/catch ต่อตัว กัน listener หนึ่งพัง
   * แล้วทำให้ตัวอื่นไม่ถูกเรียก (ข้อกำหนดคุณภาพข้อบังคับ)
   * @param {string} type
   * @param {...any} args
   */
  function emit(type, ...args) {
    const set = listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[brain/store] listener ของ "${type}" throw`, err);
      }
    }
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    const set = listeners.get(type);
    if (set) set.delete(fn);
  }

  /** รวม token 4 ตัวที่นับเป็น "ปริมาณงาน" — ไม่รวม thinking ตามสเปก */
  function sumTokens(t) {
    if (!t) return 0;
    return (t.input || 0) + (t.cacheCreate || 0) + (t.cacheRead || 0) + (t.output || 0);
  }

  function keyOf(tool, startedTs) {
    return `${tool}|${startedTs}`;
  }

  /**
   * เคลียร์บัญชีทั้งหมดของ session หนึ่ง — เรียกตอน session-remove เพื่อไม่ให้ Map โตไม่มีเพดาน
   * ตามจำนวน session ที่เคยเปิดมาทั้งหมดในเครื่อง (ข้อกำหนด "จำกัดหน่วยความจำ")
   */
  function forgetSession(sessionId) {
    sessionState.delete(sessionId);
    sessionCounts.delete(sessionId);
    sessionRunningKeys.delete(sessionId);
    sessionMaxEventIndex.delete(sessionId);
    sessionAgentIds.delete(sessionId);
    sessionSubCurrent.delete(sessionId);
    sessionSubErrors.delete(sessionId);
    sessionSubRunning.delete(sessionId);
    sessionTokensSum.delete(sessionId);
    sessionTokenEma.delete(sessionId);
  }

  /** รีเซ็ตทุกอย่างกลับสภาพเริ่มต้น — เรียกตอน stop() เพื่อให้ start() รอบถัดไปเหมือนเปิดหน้าใหม่ */
  function resetAllState() {
    snapshot = null;
    for (const sid of Array.from(sessionState.keys())) forgetSession(sid);
    sessionState.clear();
    sessionCounts.clear();
    sessionRunningKeys.clear();
    sessionMaxEventIndex.clear();
    sessionAgentIds.clear();
    sessionSubCurrent.clear();
    sessionSubErrors.clear();
    sessionSubRunning.clear();
    sessionTokensSum.clear();
    sessionTokenEma.clear();
    globalTokensSum = null;
    globalTokenEma = null;
    stats.frames = 0;
    stats.lastFrameMs = 0;
    stats.deltaMs = 0;
    stats.tokensPerSec = 0;
  }

  // ================= ส่วน diff: session-level (agent object เอง ไม่ใช่ sub-agent) =================

  /** เทียบ status.state — ยิง "state" เฉพาะตอนมีค่าก่อนหน้าจริง ๆ (ไม่งั้นไม่มี "from" ที่มีความหมาย) */
  function diffSessionStatus(agent) {
    const sid = agent.sessionId;
    const state = agent.status && agent.status.state;
    if (state === undefined) return;
    const prev = sessionState.get(sid);
    if (prev !== undefined && prev !== state) {
      emit("state", { sessionId: sid, from: prev, to: state });
    }
    sessionState.set(sid, state);
  }

  /** เทียบ counts.errors/denials ของ session เอง — เพิ่มขึ้นเมื่อไรถือเป็น event ใหม่ */
  function diffSessionCounts(agent) {
    const sid = agent.sessionId;
    const counts = agent.counts || {};
    const errors = counts.errors || 0;
    const denials = counts.denials || 0;
    const prev = sessionCounts.get(sid) || { errors: 0, denials: 0 };
    if (errors > prev.errors) {
      emit("error", { sessionId: sid, agentId: null, delta: errors - prev.errors });
    }
    if (denials > prev.denials) {
      emit("denied", { sessionId: sid, delta: denials - prev.denials });
    }
    sessionCounts.set(sid, { errors, denials });
  }

  /**
   * เทียบ status.running[] ของ session เองทีละ key (tool+startedTs) — key หายไปจากเฟรมก่อน
   * แปลว่า tool จบแล้ว (tool-end), key ใหม่ที่ไม่เคยเห็นแปลว่าเพิ่งเริ่ม (tool-start)
   * durMs ของ tool-end เป็นค่าประมาณ (จำกัดความละเอียดตามรอบ poll ของ SSE ~700ms) เพราะ
   * running[] ของ session ไม่มีฟิลด์ durMs/error ให้ตรง ๆ แบบ sub-agent's lastTool
   */
  function diffSessionRunning(agent, nowMs) {
    const sid = agent.sessionId;
    const list = (agent.status && agent.status.running) || [];
    const prevMap = sessionRunningKeys.get(sid) || new Map();
    const nextMap = new Map();
    for (const r of list) {
      const key = keyOf(r.tool, r.startedTs);
      nextMap.set(key, r);
      if (!prevMap.has(key)) {
        emit("tool-start", { sessionId: sid, agentId: null, tool: r.tool, icon: r.icon, label: r.label });
      }
    }
    for (const [key, r] of prevMap) {
      if (!nextMap.has(key)) {
        const startedMs = Date.parse(r.startedTs);
        const durMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null;
        emit("tool-end", { sessionId: sid, agentId: null, tool: r.tool, icon: r.icon, label: r.label, durMs, error: false });
      }
    }
    sessionRunningKeys.set(sid, nextMap);
  }

  /** เทียบ events[] ของ session ด้วย field `i` — ยิง "event" เฉพาะ entry ที่ i มากกว่าค่าสูงสุดที่เคยเห็น */
  function diffSessionEvents(agent) {
    const sid = agent.sessionId;
    const list = agent.events || [];
    let maxSeen = sessionMaxEventIndex.has(sid) ? sessionMaxEventIndex.get(sid) : -1;
    for (const ev of list) {
      if (typeof ev.i === "number" && ev.i > maxSeen) {
        emit("event", { sessionId: sid, event: ev });
      }
    }
    for (const ev of list) {
      if (typeof ev.i === "number" && ev.i > maxSeen) maxSeen = ev.i;
    }
    sessionMaxEventIndex.set(sid, maxSeen);
  }

  /**
   * เทียบ subagents[] ทั้งหมดของ session หนึ่ง — ครอบทั้ง spawn / finish / tool-start-end / error
   * @param {object} agent
   * @param {boolean} isFirstFrame เฟรมแรกสุดของทั้ง store (ห้ามยิง spawn — ของที่มีอยู่แล้วตั้งแต่ก่อนต่อ)
   */
  function diffSubagents(agent, isFirstFrame) {
    const sid = agent.sessionId;
    const subs = agent.subagents || [];

    const seenIds = sessionAgentIds.get(sid) || new Set();
    const curMap = sessionSubCurrent.get(sid) || new Map();
    const errMap = sessionSubErrors.get(sid) || new Map();
    const runMap = sessionSubRunning.get(sid) || new Map();

    // ---- spawn: agentId ที่ไม่เคยเห็นในบัญชีของ session นี้มาก่อน ----
    const newlySpawned = subs.filter((s) => s && s.agentId && !seenIds.has(s.agentId));
    if (newlySpawned.length > 0) {
      for (const s of newlySpawned) seenIds.add(s.agentId);
      if (!isFirstFrame) {
        // เรียงตาม startedTs เพื่อทำ cascade animation ตามลำดับที่เกิดจริง
        const ordered = newlySpawned.slice().sort((a, b) => (Date.parse(a.startedTs) || 0) - (Date.parse(b.startedTs) || 0));
        const batchSize = ordered.length;
        ordered.forEach((sub, batchIndex) => {
          emit("spawn", {
            sessionId: sid,
            sub,
            parentAgentId: sub.parentAgentId ?? null,
            depth: sub.depth,
            batchIndex,
            batchSize,
          });
        });
      }
    }

    // ---- ต่อ sub-agent ทีละตัว: finish / current-tool / error ----
    for (const sub of subs) {
      const agentId = sub.agentId;
      if (!agentId) continue;

      // finish: running true -> false
      const prevRunning = runMap.get(agentId);
      if (prevRunning === true && sub.running === false) {
        const outcome = sub.outcome;
        const ok = outcome === "ok" || outcome === "";
        emit("finish", { sessionId: sid, sub, outcome, ok });
      }
      runMap.set(agentId, !!sub.running);

      // current tool: เทียบ key เดียวกับที่ session ใช้ (tool|startedTs)
      const prevCur = curMap.get(agentId) || null;
      const curKey = sub.current ? keyOf(sub.current.tool, sub.current.startedTs) : null;
      const prevKey = prevCur ? prevCur.key : null;
      if (curKey !== prevKey) {
        if (prevCur && sub.lastTool) {
          emit("tool-end", {
            sessionId: sid,
            agentId,
            tool: sub.lastTool.tool,
            icon: sub.lastTool.icon,
            label: sub.lastTool.label,
            durMs: sub.lastTool.durMs,
            error: !!sub.lastTool.error,
          });
        }
        if (sub.current) {
          emit("tool-start", { sessionId: sid, agentId, tool: sub.current.tool, icon: sub.current.icon, label: sub.current.label });
        }
      }
      curMap.set(agentId, sub.current ? { key: curKey } : null);

      // error: sub.errors เพิ่มขึ้น
      const prevErr = errMap.has(agentId) ? errMap.get(agentId) : 0;
      const errs = sub.errors || 0;
      if (errs > prevErr) {
        emit("error", { sessionId: sid, agentId, delta: errs - prevErr });
      }
      errMap.set(agentId, errs);
    }

    sessionAgentIds.set(sid, seenIds);
    sessionSubCurrent.set(sid, curMap);
    sessionSubErrors.set(sid, errMap);
    sessionSubRunning.set(sid, runMap);
  }

  /**
   * token รวมทั้งระบบ + รายเซสชัน — คำนวณ delta/rate ด้วย EMA (alpha 0.3) เพื่อไม่ให้กราฟ
   * อัตราเร็ว/ช้ากระตุกตามความคลาดเคลื่อนของแต่ละเฟรม
   */
  function diffTokens(newSnapshot, deltaMs) {
    const totalSum = sumTokens(newSnapshot.totals && newSnapshot.totals.tokens);
    if (globalTokensSum !== null) {
      const delta = totalSum - globalTokensSum;
      const instantRate = deltaMs > 0 ? delta / (deltaMs / 1000) : 0;
      globalTokenEma = globalTokenEma === null ? instantRate : 0.3 * instantRate + 0.7 * globalTokenEma;
      stats.tokensPerSec = globalTokenEma;
      emit("tokens", { sessionId: null, delta, rate: globalTokenEma });
    }
    globalTokensSum = totalSum;

    for (const agent of newSnapshot.agents || []) {
      const sid = agent.sessionId;
      const sum = sumTokens(agent.tokens);
      const prev = sessionTokensSum.get(sid);
      if (prev !== undefined) {
        const delta = sum - prev;
        const instantRate = deltaMs > 0 ? delta / (deltaMs / 1000) : 0;
        const prevEma = sessionTokenEma.has(sid) ? sessionTokenEma.get(sid) : null;
        const ema = prevEma === null ? instantRate : 0.3 * instantRate + 0.7 * prevEma;
        sessionTokenEma.set(sid, ema);
        emit("tokens", { sessionId: sid, delta, rate: ema });
      }
      sessionTokensSum.set(sid, sum);
    }
  }

  /**
   * จุดเข้าเดียวของทุกเฟรมใหม่ ไม่ว่าจะมาจาก SSE, fetch(stateUrl) ครั้งแรก หรือ fixture
   * ลำดับสำคัญ: diff event เฉพาะทางทั้งหมดต้องยิงก่อน "snapshot" เสมอ (ตามสเปก)
   */
  function handleSnapshot(newSnapshot) {
    if (!newSnapshot || typeof newSnapshot !== "object") return;
    const isFirstFrame = snapshot === null;
    const prevSnapshot = snapshot;
    const nowMs = typeof newSnapshot.nowMs === "number" ? newSnapshot.nowMs : Date.now();
    const deltaMs = stats.lastFrameMs ? nowMs - stats.lastFrameMs : 0;

    const prevBySessionId = new Map();
    if (prevSnapshot && Array.isArray(prevSnapshot.agents)) {
      for (const a of prevSnapshot.agents) prevBySessionId.set(a.sessionId, a);
    }

    const currentIds = new Set();
    const agents = Array.isArray(newSnapshot.agents) ? newSnapshot.agents : [];
    for (const agent of agents) {
      if (!agent || !agent.sessionId) continue;
      currentIds.add(agent.sessionId);
      if (!prevBySessionId.has(agent.sessionId)) {
        emit("session-add", { session: agent });
      }
      diffSessionStatus(agent);
      diffSessionCounts(agent);
      diffSessionRunning(agent, nowMs);
      diffSessionEvents(agent);
      diffSubagents(agent, isFirstFrame);
    }

    for (const [sid, prevAgent] of prevBySessionId) {
      if (!currentIds.has(sid)) {
        emit("session-remove", { sessionId: sid, session: prevAgent });
        forgetSession(sid);
      }
    }

    diffTokens(newSnapshot, deltaMs);

    snapshot = newSnapshot;
    stats.frames += 1;
    stats.lastFrameMs = nowMs;
    stats.deltaMs = deltaMs;

    emit("snapshot", newSnapshot, { first: isFirstFrame, deltaMs });
  }

  // ================= การเชื่อมต่อ: SSE จริง หรือ fixture ปลอม =================

  function cleanupConnections() {
    if (eventSource) {
      eventSource.onopen = null;
      eventSource.onmessage = null;
      eventSource.onerror = null;
      eventSource.close();
      eventSource = null;
    }
    if (fixtureTimer) {
      clearInterval(fixtureTimer);
      fixtureTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /** นัด reconnect รอบถัดไปแบบ exponential backoff (x1.5 ต่อครั้ง จนสุดที่ 10 วิ แล้วคงที่) */
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = currentReconnectDelay;
    reconnectTimer = setTimeout(() => {
      if (running && !fixtureFn) connectSSE();
    }, delay);
    currentReconnectDelay = Math.min(currentReconnectDelay * 1.5, 10000);
  }

  function connectSSE() {
    cleanupConnections();
    let es;
    try {
      es = new EventSource(url);
    } catch (err) {
      console.error("[brain/store] เปิด EventSource ไม่สำเร็จ", err);
      scheduleReconnect();
      return;
    }
    eventSource = es;
    es.onopen = () => {
      connected = true;
      currentReconnectDelay = baseReconnectMs; // ต่อสำเร็จแล้ว รีเซ็ต backoff กลับค่าเริ่มต้น
      emit("connect", {});
    };
    es.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch (err) {
        console.error("[brain/store] parse SSE payload เป็น JSON ไม่สำเร็จ", err);
        return;
      }
      handleSnapshot(data);
    };
    es.onerror = () => {
      const wasConnected = connected;
      connected = false;
      cleanupConnections();
      if (wasConnected) emit("disconnect", {});
      if (running) scheduleReconnect();
    };
  }

  function startFixture() {
    cleanupConnections();
    connected = true;
    emit("connect", {});
    const tick = () => {
      let data;
      try {
        data = fixtureFn();
      } catch (err) {
        console.error("[brain/store] fixture() throw", err);
        return;
      }
      if (data) handleSnapshot(data);
    };
    tick(); // ยิงทันที ไม่ต้องรอรอบแรกของ interval
    fixtureTimer = setInterval(tick, 700);
  }

  /** ดึง snapshot ครั้งเดียวจาก stateUrl เพื่อ paint หน้าจอได้ไวก่อน SSE จะต่อสำเร็จ (best-effort) */
  function fetchInitialState() {
    if (typeof fetch !== "function") return;
    fetch(stateUrl)
      .then((res) => (res && res.ok ? res.json() : null))
      .then((data) => {
        // ถ้า SSE มาถึงก่อนแล้ว (มี snapshot แล้ว) ไม่ต้องใช้ผลลัพธ์ที่อาจเก่ากว่านี้
        if (data && !snapshot) handleSnapshot(data);
      })
      .catch(() => {
        /* เงียบไว้ — connectSSE() จะเป็นทางหลักอยู่แล้ว */
      });
  }

  function start() {
    if (running) return;
    running = true;
    if (fixtureFn) {
      startFixture();
      return;
    }
    fetchInitialState();
    connectSSE();
  }

  function stop() {
    if (!running) return;
    running = false;
    const wasConnected = connected;
    cleanupConnections();
    connected = false;
    if (wasConnected) emit("disconnect", {});
    resetAllState();
  }

  // ================= ตัวช่วยอ่านค่า: หา node / แจกแจง tree เป็น array แบน =================

  function findAgent(sessionId, agentId) {
    if (!snapshot || !Array.isArray(snapshot.agents)) return null;
    const session = snapshot.agents.find((a) => a.sessionId === sessionId);
    if (!session) return null;
    if (agentId == null) return session;
    return (session.subagents || []).find((s) => s.agentId === agentId) || null;
  }

  function flatNodes() {
    const out = [];
    if (!snapshot || !Array.isArray(snapshot.agents)) return out;
    for (const session of snapshot.agents) {
      out.push({
        kind: "session",
        sessionId: session.sessionId,
        agentId: null,
        node: session,
        parentKey: null,
        key: session.sessionId,
        depth: 0,
      });
      for (const sub of session.subagents || []) {
        const key = `${session.sessionId}:${sub.agentId}`;
        const parentKey = sub.parentAgentId ? `${session.sessionId}:${sub.parentAgentId}` : session.sessionId;
        out.push({
          kind: "sub",
          sessionId: session.sessionId,
          agentId: sub.agentId,
          node: sub,
          parentKey,
          key,
          depth: typeof sub.depth === "number" ? sub.depth : 1,
        });
      }
    }
    return out;
  }

  return {
    start,
    stop,
    on,
    off,
    get snapshot() {
      return snapshot;
    },
    get connected() {
      return connected;
    },
    get stats() {
      return { frames: stats.frames, lastFrameMs: stats.lastFrameMs, deltaMs: stats.deltaMs, tokensPerSec: stats.tokensPerSec };
    },
    findAgent,
    flatNodes,
  };
}
