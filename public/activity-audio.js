/*
 * activity-audio.js — เสียงบรรยายเหตุการณ์ร่วมกันของ Classic และ Neural Core
 *
 * ไฟล์นี้เป็น plain script โดยตั้งใจ: Classic ใช้ script ธรรมดา ส่วน Neural Core ใช้ ES module
 * ทั้งคู่จึงเรียก API เดียวกันผ่าน globalThis.AgentActivityAudio โดยไม่ต้องมี build step/dependency
 * เพิ่มเติม เสียงพูดมาจาก Web Speech API ของ browser; เสียงดิจิทัลสั้น ๆ มาจาก Web Audio API
 * และซ้อนอยู่รอบคำพูด (Web Speech ไม่ยอมให้ route เสียงของมันผ่าน AudioContext โดยตรง)
 */
(function installAgentActivityAudio(root) {
  "use strict";

  const STORAGE_KEY = "agent-activity-dashboard.ai-voice.v1";
  const EVENT_TTL_MS = 12_000;
  const QUEUE_TTL_MS = 10_000;
  const MAX_SPEECH_QUEUE = 4;
  const SAME_PHRASE_COOLDOWN_MS = 1_800;
  const MAX_SEEN_KEYS = 600;
  const DELEGATION_TOOLS = new Set(["Agent", "Task"]);

  const PRIORITY = {
    ready: 10,
    prompt: 30,
    thinking: 28,
    say: 26,
    "tool-start": 32,
    "tool-end": 24,
    spawn: 48,
    finish: 52,
    state: 42,
    error: 92,
    denied: 100,
    blocked: 96,
    "session-start": 35,
    "session-end": 38,
    burst: 34,
  };

  const CUE_FREQUENCY = {
    ready: 720,
    prompt: 560,
    thinking: 420,
    say: 620,
    "tool-start": 760,
    "tool-end": 940,
    spawn: 520,
    finish: 880,
    state: 680,
    error: 230,
    denied: 160,
    blocked: 190,
    "session-start": 640,
    "session-end": 480,
    burst: 700,
  };

  function safeCall(fn, ...args) {
    if (typeof fn !== "function") return;
    try {
      fn(...args);
    } catch {
      /* เสียงเป็นส่วนเสริม — callback ของ UI ต้องไม่ทำ dashboard หลักล้ม */
    }
  }

  function safeProperty(object, name) {
    try {
      return object && object[name];
    } catch {
      // localStorage can throw merely by reading the property in sandboxed/privacy contexts.
      return undefined;
    }
  }

  function finiteMs(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function maxEventIndex(events) {
    let max = -1;
    for (const ev of Array.isArray(events) ? events : []) {
      if (ev && typeof ev.i === "number" && ev.i > max) max = ev.i;
    }
    return max;
  }

  function runningKey(row) {
    if (!row) return "";
    return String(row.tool || "?") + "|" + String(row.startedTs || "?");
  }

  function runningRows(rows) {
    const out = new Map();
    const occurrences = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const base = runningKey(row);
      const occurrence = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, occurrence);
      // One assistant message can launch the same tool several times at the same timestamp.
      // Keep it as a multiset so each completion still produces its own event cue.
      out.set(`${base}|${occurrence}`, row);
    }
    return out;
  }

  function toolPhrase(tool, ended, failed) {
    if (failed) return "พบข้อผิดพลาดจากเครื่องมือ";
    if (ended) return "เครื่องมือทำงานเสร็จแล้ว";
    const name = String(tool || "");
    if (DELEGATION_TOOLS.has(name)) return "กำลังเรียกซับเอเจนต์";
    if (name === "Read") return "กำลังอ่านข้อมูล";
    if (name === "Grep" || name === "Glob" || name === "ToolSearch") return "กำลังค้นหาข้อมูล";
    if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") {
      return "กำลังแก้ไขไฟล์";
    }
    if (name === "Bash" || name === "PowerShell") return "กำลังรันคำสั่ง";
    if (name === "WebFetch" || name === "WebSearch") return "กำลังค้นข้อมูลจากเว็บ";
    if (name === "AskUserQuestion") return "ต้องการคำตอบจากคุณ";
    if (name.startsWith("mcp__")) return "กำลังเรียกบริการภายนอก";
    return "กำลังใช้เครื่องมือ";
  }

  function phraseFor(kind, detail) {
    const d = detail || {};
    if (d.textOverride) return String(d.textOverride);
    if (kind === "ready") return "ระบบเสียงพร้อมทำงาน";
    if (kind === "prompt") return "รับคำสั่งใหม่แล้ว";
    if (kind === "thinking") return "กำลังคิด";
    if (kind === "say") return "กำลังตอบ";
    if (kind === "tool-start") return toolPhrase(d.tool, false, false);
    if (kind === "tool-end") return toolPhrase(d.tool, true, !!d.error);
    if (kind === "spawn") {
      const count = Math.max(1, Number(d.count) || 1);
      return count > 1 ? `เริ่มซับเอเจนต์ ${count} ตัว` : "เริ่มซับเอเจนต์";
    }
    if (kind === "finish") {
      if (d.ok === false) return "ซับเอเจนต์ทำงานไม่สำเร็จ";
      if (d.ok == null) return "ซับเอเจนต์สิ้นสุดการทำงาน";
      return "ซับเอเจนต์ทำงานเสร็จแล้ว";
    }
    if (kind === "error") return "พบข้อผิดพลาดในการทำงาน";
    if (kind === "denied") return "คำสั่งถูกปฏิเสธ";
    if (kind === "blocked") return "การทำงานถูกบล็อก";
    if (kind === "session-start") return "เริ่มเซสชันใหม่";
    if (kind === "session-end") return "เซสชันจบแล้ว";
    if (kind === "burst") return "มีหลายเหตุการณ์กำลังทำงาน";
    if (kind === "state") {
      if (d.state === "thinking") return "กำลังคิด";
      if (d.state === "tool") return "กำลังใช้เครื่องมือ";
      if (d.state === "delegating") return "กำลังรอผลจากซับเอเจนต์";
      if (d.state === "waiting") return "กำลังรอการอนุญาต";
      if (d.state === "blocked") return "การทำงานถูกบล็อก";
      if (d.state === "idle") return "งานเสร็จแล้ว";
    }
    return "";
  }

  function semanticFromRaw(ev, base, fallbackNow) {
    const common = { ...base, eventId: ev.i, timestamp: ev.ts };
    if (ev.kind === "prompt") return [{ kind: "prompt", ...common }];
    if (ev.kind === "thinking") return [{ kind: "thinking", ...common }];
    if (ev.kind === "say") return [{ kind: "say", ...common }];
    if (ev.kind === "error") return [{ kind: "error", tool: ev.tool, ...common }];
    if (ev.kind === "denied") return [{ kind: "denied", ...common }];
    if (ev.kind === "blocked" || ev.kind === "guard") return [{ kind: "blocked", ...common }];
    if (ev.kind === "tool") {
      const out = [{ kind: "tool-start", tool: ev.tool, ...common }];
      // Tool สั้นอาจเริ่มและจบระหว่าง SSE สองเฟรม จึงไม่เคยโผล่ใน status.running/current
      // ถ้า record ใหม่มาถึงพร้อม done:true ต้องสร้างเสียงจบให้ครบอีกเหตุการณ์ตรงนี้เลย
      if (ev.done) {
        const startMs = finiteMs(ev.ts, fallbackNow);
        out.push({
          kind: "tool-end",
          tool: ev.tool,
          error: !!ev.error,
          ...common,
          timestamp: startMs + (Number(ev.durMs) || 0),
          keySuffix: "done",
        });
      }
      return out;
    }
    return [];
  }

  function create(options) {
    const opts = options || {};
    const env = opts.global || root;
    const doc = opts.document === undefined ? safeProperty(env, "document") : opts.document;
    const storage = opts.storage === undefined ? safeProperty(env, "localStorage") : opts.storage;
    const speech = opts.speechSynthesis === undefined ? safeProperty(env, "speechSynthesis") : opts.speechSynthesis;
    const Utterance =
      opts.SpeechSynthesisUtterance === undefined
        ? safeProperty(env, "SpeechSynthesisUtterance")
        : opts.SpeechSynthesisUtterance;
    const AudioCtor =
      opts.AudioContext === undefined
        ? safeProperty(env, "AudioContext") || safeProperty(env, "webkitAudioContext")
        : opts.AudioContext;
    const now = typeof opts.now === "function" ? opts.now : () => Date.now();
    const setTimer = opts.setTimeout || env.setTimeout.bind(env);
    const clearTimer = opts.clearTimeout || env.clearTimeout.bind(env);
    const setEvery = opts.setInterval || env.setInterval.bind(env);
    const clearEvery = opts.clearInterval || env.clearInterval.bind(env);
    const key = opts.storageKey || STORAGE_KEY;

    let enabled = false;
    try {
      enabled = !!(storage && storage.getItem(key) === "1");
    } catch {
      enabled = false;
    }

    let disposed = false;
    let unlocked = false;
    let bootstrapped = false;
    let latestSnapshot = null;
    let audioCtx = null;
    let masterGain = null;
    let cueCursor = 0;
    let currentUtterance = null;
    let currentSpeech = null;
    let speechQueue = [];
    let drainTimer = null;
    let pulseTimer = null;
    let speechWatchdog = null;
    let selectedVoice = null;
    let sequence = 0;
    let stateTransitionSequence = 0;
    let level = 0;
    const sessions = new Map();
    const seenKeys = new Map();
    const lastPhraseAt = new Map();
    const activeOscillators = new Set();

    const supported = !!(AudioCtor || (speech && Utterance));

    function publicState() {
      return {
        enabled,
        unlocked,
        supported,
        speaking: !!currentSpeech,
        level,
        voiceName: selectedVoice ? selectedVoice.name || "" : "",
      };
    }

    function emitState() {
      safeCall(opts.onState, publicState());
    }

    function emitVisual(phase, item, extra) {
      safeCall(opts.onVisual, {
        phase,
        level,
        kind: item && item.kind,
        text: item && item.text,
        sessionId: item && item.sessionId,
        agentId: item && item.agentId,
        ...(extra || {}),
      });
    }

    function rememberKey(eventKey) {
      if (!eventKey) return true;
      if (seenKeys.has(eventKey)) return false;
      seenKeys.set(eventKey, now());
      if (seenKeys.size > MAX_SEEN_KEYS) {
        const remove = seenKeys.size - MAX_SEEN_KEYS;
        let n = 0;
        for (const oldKey of seenKeys.keys()) {
          seenKeys.delete(oldKey);
          n += 1;
          if (n >= remove) break;
        }
      }
      return true;
    }

    function forgetSeenPrefix(prefix) {
      for (const eventKey of seenKeys.keys()) {
        if (eventKey.startsWith(prefix)) seenKeys.delete(eventKey);
      }
    }

    function chooseVoice() {
      if (!speech || typeof speech.getVoices !== "function") return null;
      let voices = [];
      try {
        voices = speech.getVoices() || [];
      } catch {
        voices = [];
      }
      const thai = voices.filter((v) => /^th(?:-|_)/i.test(String(v.lang || "")));
      selectedVoice = thai.find((v) => v.localService) || thai[0] || null;
      emitState();
      return selectedVoice;
    }

    function ensureAudio() {
      if (!AudioCtor || audioCtx) return audioCtx;
      try {
        audioCtx = new AudioCtor();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.34;
        masterGain.connect(audioCtx.destination);
      } catch {
        audioCtx = null;
        masterGain = null;
      }
      return audioCtx;
    }

    function resumeAudio() {
      const ctx = ensureAudio();
      if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
        try {
          const result = ctx.resume();
          if (result && typeof result.catch === "function") result.catch(() => {});
        } catch {
          /* browser ปฏิเสธ autoplay — gesture ครั้งถัดไปจะลองใหม่ */
        }
      }
    }

    function tone(frequency, startAt, duration, type, volume, endFrequency) {
      const ctx = ensureAudio();
      if (!ctx || !masterGain) return;
      let osc = null;
      try {
        osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        const start = Math.max(ctx.currentTime, startAt);
        const end = start + Math.max(0.025, duration);
        osc.type = type || "square";
        osc.frequency.setValueAtTime(Math.max(40, frequency), start);
        if (endFrequency) osc.frequency.exponentialRampToValueAtTime(Math.max(40, endFrequency), end);
        filter.type = "bandpass";
        filter.frequency.value = Math.max(220, frequency * 1.7);
        filter.Q.value = 3.5;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume || 0.025), start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(filter).connect(gain).connect(masterGain);
        activeOscillators.add(osc);
        osc.onended = () => activeOscillators.delete(osc);
        osc.start(start);
        osc.stop(end + 0.01);
      } catch {
        if (osc) activeOscillators.delete(osc);
        /* Web Audio บาง implementation ขาด node บางชนิด — TTS ยังทำงานต่อได้ */
      }
    }

    function stopTones() {
      for (const osc of activeOscillators) {
        try {
          osc.onended = null;
          osc.stop();
        } catch {
          /* node อาจจบไปแล้วระหว่างวน */
        }
        try {
          if (typeof osc.disconnect === "function") osc.disconnect();
        } catch {
          /* optional */
        }
      }
      activeOscillators.clear();
      cueCursor = 0;
    }

    function playCue(item, tail) {
      if (!enabled || !unlocked) return;
      resumeAudio();
      const ctx = ensureAudio();
      if (!ctx) return;
      const base = CUE_FREQUENCY[item.kind] || 640;
      const urgent = item.priority >= 90;
      let at = Math.max(ctx.currentTime + 0.005, cueCursor);
      // ไม่ปล่อย event storm จอง timeline เสียงยาวเป็นนาที — 0.75s คือคิว cue สูงสุด
      if (at - ctx.currentTime > 0.75) at = ctx.currentTime + 0.05;
      cueCursor = at + 0.055;
      if (tail) {
        tone(base * 1.15, at, 0.09, "triangle", 0.022, base * 0.72);
      } else if (urgent) {
        tone(base, at, 0.16, "sawtooth", 0.045, Math.max(70, base * 0.55));
        tone(base * 1.5, at + 0.08, 0.11, "square", 0.025, base);
      } else if (item.kind === "spawn") {
        tone(base, at, 0.07, "square", 0.025, base * 1.18);
        tone(base * 1.35, at + 0.065, 0.08, "triangle", 0.024, base * 1.75);
      } else {
        tone(base, at, 0.075, "square", 0.018, base * 1.12);
        tone(base * 1.62, at + 0.035, 0.055, "triangle", 0.012, base * 1.28);
      }
    }

    function stopSpeechVisual(reason) {
      if (pulseTimer !== null) {
        clearEvery(pulseTimer);
        pulseTimer = null;
      }
      if (speechWatchdog !== null) {
        clearTimer(speechWatchdog);
        speechWatchdog = null;
      }
      if (currentSpeech) {
        const finished = currentSpeech;
        level = 0;
        emitVisual("end", finished, { reason: reason || "end" });
        // Normal speech gets a short digital sign-off. Navigation cleanup must be silent or that
        // tail leaks onto the destination page just after the user leaves this dashboard.
        if (reason !== "bfcache" && reason !== "dispose") playCue(finished, true);
      }
      currentSpeech = null;
      currentUtterance = null;
      emitState();
    }

    function finishSpeech(token, reason) {
      if (!currentSpeech || currentSpeech.token !== token) return;
      stopSpeechVisual(reason);
      if (drainTimer !== null) clearTimer(drainTimer);
      drainTimer = setTimer(() => {
        drainTimer = null;
        drainSpeech();
      }, 110);
    }

    function startSpeech(item) {
      if (!speech || !Utterance || !enabled || !unlocked || disposed) return;
      let utterance;
      try {
        utterance = new Utterance(item.text);
      } catch {
        setTimer(drainSpeech, 0);
        return;
      }
      utterance.lang = "th-TH";
      utterance.rate = 1.08;
      utterance.pitch = 0.78;
      utterance.volume = 0.86;
      if (selectedVoice) utterance.voice = selectedVoice;
      item.token = ++sequence;
      currentSpeech = item;
      currentUtterance = utterance; // กัน browser GC utterance กลางคำพูด

      let visualStarted = false;
      const startVisual = () => {
        if (visualStarted || !currentSpeech || currentSpeech.token !== item.token) return;
        visualStarted = true;
        level = 0.72;
        emitVisual("start", item);
        emitState();
        const beganAt = now();
        let tick = 0;
        pulseTimer = setEvery(() => {
          if (!currentSpeech || currentSpeech.token !== item.token) return;
          tick += 1;
          const wave = 0.42 + Math.abs(Math.sin((now() - beganAt) * 0.018)) * 0.52;
          level = Math.min(1, wave);
          emitVisual("frame", item, { tick });
          // carrier ดิจิทัลเบามากใต้เสียงพูด — ไม่กลบพยัญชนะของ TTS
          if (tick % 4 === 0 && audioCtx) {
            const f = 1180 + (tick % 3) * 170;
            tone(f, audioCtx.currentTime, 0.025, "square", 0.0045, f * 0.92);
          }
        }, 85);
      };

      utterance.onstart = startVisual;
      utterance.onboundary = () => {
        startVisual();
        level = 1;
        emitVisual("boundary", item);
      };
      utterance.onend = () => finishSpeech(item.token, "end");
      utterance.onerror = () => finishSpeech(item.token, "error");

      playCue(item, false);
      try {
        speech.speak(utterance);
        // บาง voice ไม่ยิง onstart/onend เมื่อมันพังเงียบ ๆ; watchdog ต้องคืน visual/queue เสมอ
        speechWatchdog = setTimer(
          () => finishSpeech(item.token, "watchdog"),
          Math.min(8_000, Math.max(2_400, item.text.length * 155 + 1_400)),
        );
        // Chrome บางรุ่นยิง onstart ช้าหรือไม่ยิงเลย แต่เริ่มเสียงจริงแล้ว — fallback สั้น ๆ
        setTimer(startVisual, 120);
      } catch {
        finishSpeech(item.token, "speak-error");
      }
    }

    function drainSpeech() {
      if (disposed || !enabled || !unlocked || currentSpeech || !speech || !Utterance) return;
      const at = now();
      speechQueue = speechQueue.filter((item) => at - item.queuedAt <= QUEUE_TTL_MS);
      const next = speechQueue.shift();
      if (next) startSpeech(next);
    }

    function queueSpeech(item, force) {
      if (!item.text || !speech || !Utterance) return;
      const at = now();
      const lastAt = lastPhraseAt.get(item.text) || 0;
      if (!force && item.priority < 90 && at - lastAt < SAME_PHRASE_COOLDOWN_MS) return;
      lastPhraseAt.set(item.text, at);

      if (currentSpeech && item.priority >= 90 && currentSpeech.priority < item.priority) {
        try {
          speech.cancel();
        } catch {
          /* optional */
        }
        stopSpeechVisual("preempted");
      }

      const sameQueued = speechQueue.find((q) => q.text === item.text);
      if (sameQueued && !force) {
        sameQueued.queuedAt = at;
        sameQueued.count = (sameQueued.count || 1) + 1;
        drainSpeech();
        return;
      }

      if (speechQueue.length >= MAX_SPEECH_QUEUE) {
        const lowestIndex = speechQueue.reduce(
          (best, q, i, arr) => (q.priority < arr[best].priority ? i : best),
          0,
        );
        if (item.priority > speechQueue[lowestIndex].priority) speechQueue[lowestIndex] = item;
        else if (!speechQueue.some((q) => q.kind === "burst")) {
          speechQueue[speechQueue.length - 1] = {
            ...item,
            kind: "burst",
            text: phraseFor("burst"),
            priority: PRIORITY.burst,
          };
        }
      } else {
        speechQueue.push(item);
      }
      speechQueue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
      drainSpeech();
    }

    function announce(kind, detail) {
      const d = detail || {};
      const timestamp = finiteMs(d.timestamp, now());
      const eventKey =
        d.eventKey ||
        [d.sessionId || "global", d.agentId || "main", kind, d.eventId ?? "", d.keySuffix || ""].join(":");
      if (!rememberKey(eventKey)) return false;
      if (!enabled || !unlocked || disposed) return false;
      if (!d.force && now() - timestamp > EVENT_TTL_MS) return false;

      const item = {
        kind,
        text: phraseFor(kind, d),
        priority: d.priority || PRIORITY[kind] || 20,
        sessionId: d.sessionId || null,
        agentId: d.agentId || null,
        queuedAt: now(),
      };
      playCue(item, false); // ทุก event ใหม่ได้ sonic cue แม้คำพูดจะถูก batch/cooldown
      level = Math.max(level, 0.68);
      emitVisual("cue", item);
      queueSpeech(item, !!d.force);
      return true;
    }

    function baselineSession(agent) {
      const running = runningRows((agent.status && agent.status.running) || []);
      const subs = new Map();
      for (const sub of agent.subagents || []) {
        subs.set(sub.agentId, {
          running: !!sub.running,
          maxEventI: maxEventIndex(sub.events),
          currentKey: sub.current ? runningKey(sub.current) : "",
          current: sub.current || null,
        });
      }
      return {
        state: agent.status && agent.status.state,
        maxEventI: maxEventIndex(agent.events),
        running,
        subs,
      };
    }

    function collectRawEvents(out, events, afterI, base, frameNow) {
      const list = Array.isArray(events) ? events : [];
      const frameMax = maxEventIndex(list);
      if (afterI >= 0 && frameMax >= 0 && frameMax < afterI) {
        // A server restart/re-read can restart the in-memory `i` sequence while this browser page
        // stays open. Treat that frame as a new silent cursor; otherwise every future event would
        // be ignored until the counter happened to overtake its pre-restart value.
        // Indices will be reused, so their old announce keys must go too.
        forgetSeenPrefix([base.sessionId, base.agentId || "main", "event", ""].join(":"));
        return frameMax;
      }
      let maxI = afterI;
      for (const ev of list) {
        if (!ev || typeof ev.i !== "number" || ev.i <= afterI) continue;
        if (ev.i > maxI) maxI = ev.i;
        const semantic = semanticFromRaw(ev, base, frameNow);
        for (const item of semantic) {
          item.timestamp = finiteMs(item.timestamp, frameNow);
          item.eventKey = [base.sessionId, base.agentId || "main", "event", ev.i, item.keySuffix || item.kind].join(":");
          out.push(item);
        }
      }
      return maxI;
    }

    function ingest(snapshot) {
      if (!snapshot || typeof snapshot !== "object" || disposed) return;
      latestSnapshot = snapshot;
      const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
      const frameNow = typeof snapshot.nowMs === "number" ? snapshot.nowMs : now();

      if (!bootstrapped) {
        sessions.clear();
        for (const agent of agents) {
          if (agent && agent.sessionId) sessions.set(agent.sessionId, baselineSession(agent));
        }
        bootstrapped = true;
        return; // ห้ามอ่าน history เก่าออกเสียงตอนเพิ่งเปิดหน้า
      }

      const detected = [];
      const present = new Set();
      for (const agent of agents) {
        if (!agent || !agent.sessionId) continue;
        const sid = agent.sessionId;
        present.add(sid);
        let prev = sessions.get(sid);
        if (!prev) {
          // The page-level first snapshot is the only silent baseline. A session that appears
          // later is live activity: start with empty cursors so every fresh buffered event gets a
          // cue (EVENT_TTL_MS still prevents old history from being spoken).
          prev = {
            state: agent.status && agent.status.state,
            maxEventI: -1,
            running: new Map(),
            subs: new Map(),
          };
          sessions.set(sid, prev);
          detected.push({
            kind: "session-start",
            sessionId: sid,
            timestamp: frameNow,
            eventKey: sid + ":session-start",
          });
        }

        const state = agent.status && agent.status.state;
        if (state && state !== prev.state) {
          detected.push({
            kind: state === "blocked" ? "blocked" : "state",
            state,
            sessionId: sid,
            timestamp: frameNow,
            // State diffing already suppresses duplicate snapshots. A local sequence keeps a real
            // re-entry audible even if the server reuses the original status.since timestamp.
            eventKey: [sid, "state", ++stateTransitionSequence, state].join(":"),
          });
        }
        prev.state = state;

        prev.maxEventI = collectRawEvents(
          detected,
          agent.events,
          prev.maxEventI,
          { sessionId: sid, agentId: null },
          frameNow,
        );

        const nextRunning = runningRows((agent.status && agent.status.running) || []);
        for (const [runKey, oldRow] of prev.running) {
          if (!nextRunning.has(runKey)) {
            detected.push({
              kind: "tool-end",
              tool: oldRow.tool,
              sessionId: sid,
              timestamp: frameNow,
              eventKey: [sid, "main", "tool-end", runKey].join(":"),
            });
          }
        }
        prev.running = nextRunning;

        const presentSubs = new Set();
        for (const sub of agent.subagents || []) {
          if (!sub || !sub.agentId) continue;
          const aid = sub.agentId;
          presentSubs.add(aid);
          let oldSub = prev.subs.get(aid);
          if (!oldSub) {
            oldSub = {
              running: !!sub.running,
              maxEventI: -1,
              currentKey: "",
              current: null,
            };
            prev.subs.set(aid, oldSub);
            detected.push({
              kind: "spawn",
              count: 1,
              sessionId: sid,
              agentId: aid,
              timestamp: finiteMs(sub.startedTs, frameNow),
              eventKey: [sid, aid, "spawn", sub.startedTs || ""].join(":"),
            });
            // A very short child can start and finish between two SSE frames. Preserve both
            // lifecycle edges; speech may batch, but each edge still receives its own cue.
            if (!sub.running) {
              detected.push({
                kind: "finish",
                ok: sub.outcome === "ok" ? true : sub.outcome && sub.outcome !== "unknown" ? false : null,
                sessionId: sid,
                agentId: aid,
                timestamp: finiteMs(sub.lastTs, frameNow),
                eventKey: [sid, aid, "finish", sub.outcome || "ok", sub.lastTs || ""].join(":"),
              });
            }
          } else if (oldSub.running && !sub.running) {
            detected.push({
              kind: "finish",
              ok: sub.outcome === "ok" ? true : sub.outcome && sub.outcome !== "unknown" ? false : null,
              sessionId: sid,
              agentId: aid,
              timestamp: frameNow,
              eventKey: [sid, aid, "finish", sub.outcome || "ok"].join(":"),
            });
          }

          oldSub.maxEventI = collectRawEvents(
            detected,
            sub.events,
            oldSub.maxEventI,
            { sessionId: sid, agentId: aid },
            frameNow,
          );

          const curKey = sub.current ? runningKey(sub.current) : "";
          if (oldSub.currentKey && oldSub.currentKey !== curKey) {
            detected.push({
              kind: "tool-end",
              tool: oldSub.current && oldSub.current.tool,
              error: !!(sub.lastTool && sub.lastTool.error),
              sessionId: sid,
              agentId: aid,
              timestamp: frameNow,
              eventKey: [sid, aid, "tool-end", oldSub.currentKey].join(":"),
            });
          }
          oldSub.running = !!sub.running;
          oldSub.currentKey = curKey;
          oldSub.current = sub.current || null;
        }

        // Fixture/live sources may cap old completed children. Do not retain stale per-child
        // cursors forever if the snapshot no longer contains them.
        for (const aid of prev.subs.keys()) {
          if (!presentSubs.has(aid)) prev.subs.delete(aid);
        }
      }

      for (const sid of sessions.keys()) {
        if (present.has(sid)) continue;
        sessions.delete(sid);
        detected.push({
          kind: "session-end",
          sessionId: sid,
          timestamp: frameNow,
          eventKey: sid + ":session-end:" + frameNow,
        });
      }

      // A new session's buffered prompt/tool timestamps naturally predate the SSE frame that
      // revealed it. Give its synthetic start the same effective time as that session's earliest
      // item, then use an explicit rank. This tuple stays transitive even when several sessions
      // appear together with interleaved timestamps.
      const firstTimeByNewSession = new Map();
      const newSessionIds = new Set(
        detected.filter((item) => item.kind === "session-start").map((item) => item.sessionId),
      );
      for (const item of detected) {
        if (!newSessionIds.has(item.sessionId)) continue;
        const itemAt = finiteMs(item.timestamp, frameNow);
        const firstAt = firstTimeByNewSession.get(item.sessionId);
        if (firstAt === undefined || itemAt < firstAt) firstTimeByNewSession.set(item.sessionId, itemAt);
      }
      detected
        .sort((a, b) => {
          const aAt =
            a.kind === "session-start"
              ? firstTimeByNewSession.get(a.sessionId) ?? finiteMs(a.timestamp, frameNow)
              : finiteMs(a.timestamp, frameNow);
          const bAt =
            b.kind === "session-start"
              ? firstTimeByNewSession.get(b.sessionId) ?? finiteMs(b.timestamp, frameNow)
              : finiteMs(b.timestamp, frameNow);
          if (aAt !== bAt) return aAt - bAt;
          return Number(b.kind === "session-start") - Number(a.kind === "session-start");
        })
        .forEach((item) => announce(item.kind, item));
    }

    function cancel(reason) {
      speechQueue = [];
      if (drainTimer !== null) {
        clearTimer(drainTimer);
        drainTimer = null;
      }
      // Clear our current token before calling the browser. Some engines fire utterance.onerror
      // synchronously from speech.cancel(); doing this first prevents that callback from turning a
      // silent navigation cancel into an audible sign-off cue.
      stopSpeechVisual(reason || "cancelled");
      stopTones();
      if (speech && typeof speech.cancel === "function") {
        try {
          speech.cancel();
        } catch {
          /* optional */
        }
      }
    }

    function announceCurrentOrReady() {
      const agents = (latestSnapshot && latestSnapshot.agents) || [];
      const live = agents.filter((a) => a && a.alive && a.status);
      const order = ["waiting", "blocked", "delegating", "tool", "thinking"];
      const current = order.find((state) => live.some((a) => a.status.state === state));
      if (current) {
        const agent = live.find((a) => a.status.state === current);
        announce(current === "blocked" ? "blocked" : "state", {
          state: current,
          sessionId: agent && agent.sessionId,
          timestamp: now(),
          eventKey: "activation:" + current + ":" + now(),
          force: true,
        });
      } else {
        announce("ready", {
          timestamp: now(),
          eventKey: "activation:ready:" + now(),
          force: true,
        });
      }
    }

    function unlock(announceCurrent) {
      if (!enabled || disposed) return false;
      unlocked = true;
      resumeAudio();
      chooseVoice();
      emitState();
      if (announceCurrent) announceCurrentOrReady();
      return true;
    }

    function setEnabled(next, config) {
      const value = !!next;
      const cfg = config || {};
      if (value === enabled && !(value && cfg.userGesture && !unlocked)) return publicState();
      enabled = value;
      try {
        if (storage) storage.setItem(key, enabled ? "1" : "0");
      } catch {
        /* private mode / storage disabled */
      }
      if (!enabled) {
        unlocked = false;
        cancel("disabled");
      } else if (cfg.userGesture) {
        unlock(cfg.preview !== false);
      }
      emitState();
      return publicState();
    }

    function gestureUnlock(event) {
      // ถ้ากำลังกดปุ่มเสียงเอง ให้ click handler เป็นคนตัดสินก่อนว่าจะเปิดหรือปิด มิฉะนั้นค่าที่จำว่า
      // "เปิด" จากรอบก่อนจะพูดหนึ่งคำทันทีตอนผู้ใช้ตั้งใจกดปิด
      const target = event && event.target;
      if (target && typeof target.closest === "function" && target.closest(".agent-voice-toggle")) return;
      if (enabled && !unlocked) unlock(true);
      else if (enabled && audioCtx && audioCtx.state === "suspended") resumeAudio();
    }

    function storageChanged(event) {
      if (!event || event.key !== key) return;
      const next = event.newValue === "1";
      if (next === enabled) return;
      enabled = next;
      if (!enabled) {
        unlocked = false;
        cancel("storage-disabled");
      }
      emitState();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      cancel("dispose");
      if (doc && typeof doc.removeEventListener === "function") {
        doc.removeEventListener("pointerdown", gestureUnlock, true);
        doc.removeEventListener("keydown", gestureUnlock, true);
      }
      if (env && typeof env.removeEventListener === "function") env.removeEventListener("storage", storageChanged);
      if (speech && typeof speech.removeEventListener === "function") speech.removeEventListener("voiceschanged", chooseVoice);
      if (audioCtx && typeof audioCtx.close === "function") {
        try {
          const closing = audioCtx.close();
          if (closing && typeof closing.catch === "function") closing.catch(() => {});
        } catch {
          /* optional */
        }
      }
      audioCtx = null;
      masterGain = null;
      latestSnapshot = null;
      selectedVoice = null;
      sessions.clear();
      seenKeys.clear();
      lastPhraseAt.clear();
      activeOscillators.clear();
    }

    if (speech && typeof speech.addEventListener === "function") speech.addEventListener("voiceschanged", chooseVoice);
    chooseVoice();
    if (doc && typeof doc.addEventListener === "function") {
      doc.addEventListener("pointerdown", gestureUnlock, true);
      doc.addEventListener("keydown", gestureUnlock, true);
    }
    if (env && typeof env.addEventListener === "function") env.addEventListener("storage", storageChanged);
    emitState();

    return {
      ingest,
      announce,
      setEnabled,
      unlock,
      cancel,
      dispose,
      getState: publicState,
      get enabled() {
        return enabled;
      },
      get speaking() {
        return !!currentSpeech;
      },
      get level() {
        return level;
      },
    };
  }

  root.AgentActivityAudio = Object.freeze({ create, STORAGE_KEY });
})(typeof globalThis !== "undefined" ? globalThis : this);
