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

  // Keep the original key so an existing "1" opt-in migrates to the new voice mode.
  const STORAGE_KEY = "agent-activity-dashboard.ai-voice.v1";
  const REMINDERS_STORAGE_KEY = "agent-activity-dashboard.ai-wait-reminders.v1";
  const EVENT_TTL_MS = 12_000;
  const QUEUE_TTL_MS = 10_000;
  const MAX_SPEECH_QUEUE = 4;
  const SAME_PHRASE_COOLDOWN_MS = 1_800;
  const MAX_SEEN_KEYS = 600;
  const REMINDER_EFFECT_MS = 30_000;
  const REMINDER_SPEECH_MS = 90_000;
  const REMINDER_REPEAT_MS = 120_000;
  // Speech synthesis has its own browser mixer. Keep Web Audio effects deliberately stronger so
  // they remain distinct beside a full-volume Thai utterance, while the limiter catches storms.
  const EFFECT_GAIN = 2.35;
  const AUDIO_MODES = new Set(["off", "effects", "voice"]);
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
    reminder: 94,
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
    reminder: 980,
  };

  // Only these semantic edges are worth interrupting the room with speech. Every event still
  // receives its own earcon in both audible modes.
  const SPOKEN_KINDS = new Set([
    "ready",
    "prompt",
    "spawn",
    "finish",
    "error",
    "denied",
    "blocked",
    "session-start",
    "session-end",
    "burst",
    "reminder",
  ]);

  const PHRASE_POOLS = Object.freeze({
    ready: ["ระบบเสียงพร้อมแล้ว", "พร้อมแจ้งความคืบหน้าแล้ว", "เปิดเสียงกิจกรรมแล้ว"],
    prompt: ["รับงานใหม่แล้ว", "เริ่มงานใหม่แล้ว", "รับเรื่องแล้ว กำลังเริ่มทำงาน"],
    thinking: ["กำลังคิดอยู่", "กำลังวิเคราะห์งาน", "ขอคิดสักครู่"],
    say: ["กำลังเตรียมคำตอบ", "กำลังสรุปคำตอบ", "ใกล้ได้คำตอบแล้ว"],
    "tool-read": ["กำลังอ่านข้อมูล", "กำลังตรวจข้อมูล", "กำลังเปิดดูรายละเอียด"],
    "tool-search": ["กำลังค้นหาข้อมูล", "กำลังไล่หาข้อมูล", "กำลังตรวจหาสิ่งที่เกี่ยวข้อง"],
    "tool-edit": ["กำลังแก้ไขไฟล์", "กำลังปรับงานให้", "กำลังลงมือแก้ไข"],
    "tool-command": ["กำลังประมวลผลคำสั่ง", "กำลังทำขั้นตอนถัดไป", "กำลังรันงานที่จำเป็น"],
    "tool-web": ["กำลังค้นข้อมูลจากเว็บ", "กำลังตรวจข้อมูลออนไลน์", "กำลังเปิดดูข้อมูลจากเว็บ"],
    "tool-question": ["มีคำถามรอคุณตอบ", "ต้องการคำตอบจากคุณเพื่อทำต่อ", "พร้อมทำต่อเมื่อคุณตอบ"],
    "tool-service": ["กำลังติดต่อบริการที่เกี่ยวข้อง", "กำลังเรียกข้อมูลจากบริการอื่น", "กำลังประสานงานกับบริการภายนอก"],
    "tool-generic": ["กำลังทำขั้นตอนหนึ่งอยู่", "กำลังจัดการงานต่อ", "กำลังประมวลผลงาน"],
    "tool-end": ["ขั้นตอนนี้เสร็จแล้ว", "ทำขั้นตอนนี้เรียบร้อยแล้ว", "ดำเนินการส่วนนี้เสร็จแล้ว"],
    "tool-error": ["ขั้นตอนนี้มีปัญหา", "พบข้อผิดพลาดในขั้นตอนนี้", "ขั้นตอนนี้ยังไม่สำเร็จ"],
    spawn: ["เรียกผู้ช่วยเพิ่มแล้ว", "ส่งงานให้ผู้ช่วยแล้ว", "มีผู้ช่วยเข้ามาช่วยทำงานแล้ว"],
    "spawn-many": ["เรียกผู้ช่วยเพิ่มแล้ว", "แบ่งงานให้ผู้ช่วยหลายคนแล้ว", "มีผู้ช่วยหลายคนกำลังช่วยทำงาน"],
    "finish-ok": ["ผู้ช่วยทำงานเสร็จแล้ว", "ได้รับผลจากผู้ช่วยแล้ว", "งานที่ให้ผู้ช่วยทำเรียบร้อยแล้ว"],
    "finish-failed": ["ผู้ช่วยทำงานไม่สำเร็จ", "งานที่ส่งให้ผู้ช่วยมีปัญหา", "ยังไม่ได้ผลจากผู้ช่วยตามที่ต้องการ"],
    "finish-unknown": ["ผู้ช่วยหยุดทำงานแล้ว", "งานของผู้ช่วยสิ้นสุดแล้ว", "ผู้ช่วยออกจากงานนี้แล้ว"],
    error: ["พบข้อผิดพลาดในการทำงาน", "มีบางอย่างผิดพลาด", "งานส่วนนี้เจอปัญหา"],
    denied: ["คำสั่งนี้ไม่ได้รับอนุญาต", "ขั้นตอนนี้ถูกปฏิเสธ", "ยังทำขั้นตอนนี้ต่อไม่ได้"],
    blocked: ["การทำงานติดขัด", "งานนี้ถูกหยุดไว้", "มีสิ่งกีดขวางการทำงาน"],
    "session-start": ["มีงานใหม่เข้ามา", "เริ่มดูแลงานใหม่แล้ว", "ตรวจพบงานใหม่"],
    "session-end": ["งานหนึ่งจบแล้ว", "ปิดงานหนึ่งรายการแล้ว", "มีงานเสร็จสมบูรณ์แล้ว"],
    burst: ["กำลังจัดการหลายขั้นตอน", "มีหลายอย่างเกิดขึ้นพร้อมกัน", "กำลังรวบงานหลายส่วนให้ทัน"],
    "state-thinking": ["กำลังคิดอยู่", "กำลังวิเคราะห์ต่อ", "กำลังทบทวนข้อมูล"],
    "state-tool": ["กำลังลงมือทำงาน", "กำลังทำขั้นตอนถัดไป", "กำลังประมวลผลงาน"],
    "state-delegating": ["กำลังรอผลจากผู้ช่วย", "ผู้ช่วยกำลังทำงานอยู่", "ส่งงานให้ผู้ช่วยแล้ว กำลังรอผล"],
    "state-wait-question": ["มีคำถามรอคุณตอบ", "ต้องการคำตอบจากคุณเพื่อทำต่อ", "พร้อมทำต่อเมื่อคุณตอบ"],
    "state-wait-confirm": ["มีขั้นตอนรอให้คุณตรวจสอบ", "มีรายการรอการยืนยันจากคุณ", "ต้องการให้คุณตรวจสอบก่อนทำต่อ"],
    "state-wait-generic": ["มีงานรอคุณอยู่", "ต้องการความช่วยเหลือจากคุณเพื่อทำต่อ", "พร้อมทำต่อเมื่อคุณกลับมา"],
    "state-idle": ["งานรอบนี้เรียบร้อยแล้ว", "ทำงานส่วนนี้เสร็จแล้ว", "ตอนนี้ว่างและพร้อมรับงานต่อ"],
    "reminder-question": ["ยังมีคำถามรอคุณตอบอยู่", "อย่าลืมกลับมาตอบคำถามนะ", "มีงานที่ต้องการคำตอบจากคุณ"],
    "reminder-confirm": ["ยังมีขั้นตอนรอให้คุณตรวจสอบ", "อย่าลืมกลับมายืนยันงานที่รออยู่", "มีรายการรอการตรวจสอบจากคุณ"],
    "reminder-generic": ["ยังมีงานรอคุณอยู่", "อย่าลืมกลับมาดูงานที่รออยู่", "มีงานพร้อมทำต่อเมื่อคุณกลับมา"],
    "reminder-many": ["มีหลายงานกำลังรอคุณอยู่", "ยังมีหลายงานที่ต้องการคำตอบจากคุณ", "อย่าลืมกลับมาดูงานที่รออยู่หลายรายการ"],
  });

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

  function stableHash(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
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

  function toolPhraseKey(tool, ended, failed) {
    if (failed) return "tool-error";
    if (ended) return "tool-end";
    const name = String(tool || "");
    if (DELEGATION_TOOLS.has(name)) return "spawn";
    if (name === "Read") return "tool-read";
    if (name === "Grep" || name === "Glob" || name === "ToolSearch") return "tool-search";
    if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") {
      return "tool-edit";
    }
    if (name === "Bash" || name === "PowerShell") return "tool-command";
    if (name === "WebFetch" || name === "WebSearch") return "tool-web";
    if (name === "AskUserQuestion") return "tool-question";
    if (name.startsWith("mcp__")) return "tool-service";
    return "tool-generic";
  }

  function phraseKeyFor(kind, detail) {
    const d = detail || {};
    if (kind === "ready" || kind === "prompt" || kind === "thinking" || kind === "say") return kind;
    if (kind === "tool-start") return toolPhraseKey(d.tool, false, false);
    if (kind === "tool-end") return toolPhraseKey(d.tool, true, !!d.error);
    if (kind === "spawn") return Math.max(1, Number(d.count) || 1) > 1 ? "spawn-many" : "spawn";
    if (kind === "finish") {
      if (d.ok === false) return "finish-failed";
      if (d.ok == null) return "finish-unknown";
      return "finish-ok";
    }
    if (["error", "denied", "blocked", "session-start", "session-end", "burst"].includes(kind)) return kind;
    if (kind === "reminder") {
      if ((Number(d.waitingCount) || 0) > 1) return "reminder-many";
      if (d.waitingKind === "question") return "reminder-question";
      if (d.waitingKind === "confirmation") return "reminder-confirm";
      return "reminder-generic";
    }
    if (kind === "state") {
      if (d.state === "waiting") {
        if ((Number(d.waitingCount) || 0) > 1) return "reminder-many";
        if (d.waitingKind === "question") return "state-wait-question";
        if (d.waitingKind === "confirmation") return "state-wait-confirm";
        return "state-wait-generic";
      }
      const stateKey = `state-${d.state || ""}`;
      if (PHRASE_POOLS[stateKey]) return stateKey;
      if (d.state === "blocked") return "blocked";
    }
    return "";
  }

  function phraseFor(kind, detail, choose) {
    const d = detail || {};
    if (d.textOverride) return String(d.textOverride);
    const poolKey = phraseKeyFor(kind, d);
    if (!poolKey) return "";
    const pool = PHRASE_POOLS[poolKey] || [];
    if (!pool.length) return "";
    return typeof choose === "function" ? choose(poolKey, pool) : pool[0];
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
    const remindersKey = opts.remindersStorageKey || REMINDERS_STORAGE_KEY;

    let mode = "off";
    let remindersEnabled = true;
    try {
      const storedMode = storage && storage.getItem(key);
      mode = storedMode === "1" ? "voice" : AUDIO_MODES.has(storedMode) ? storedMode : "off";
      const storedReminders = storage && storage.getItem(remindersKey);
      remindersEnabled = storedReminders == null ? true : storedReminders !== "0" && storedReminders !== "false";
    } catch {
      mode = "off";
      remindersEnabled = true;
    }

    let disposed = false;
    let unlocked = false;
    let bootstrapped = false;
    let latestSnapshot = null;
    let audioCtx = null;
    let masterGain = null;
    let limiter = null;
    let cueCursor = 0;
    let currentUtterance = null;
    let currentSpeech = null;
    let speechQueue = [];
    let drainTimer = null;
    let pulseTimer = null;
    let speechWatchdog = null;
    let selectedVoice = null;
    let voicesResolved = false;
    let sequence = 0;
    let stateTransitionSequence = 0;
    let phraseSequence = 0;
    let reminderSequence = 0;
    let reminderStartedAt = 0;
    let nextReminderAt = 0;
    let reminderTimer = null;
    let level = 0;
    const sessions = new Map();
    const seenKeys = new Map();
    const lastPhraseAt = new Map();
    const lastPhraseChoice = new Map();
    const waitingSessions = new Map();
    const activeOscillators = new Set();

    const effectsSupported = !!AudioCtor;
    const speechSupported = !!(speech && Utterance);
    const supported = effectsSupported || speechSupported;

    function enabled() {
      return mode !== "off";
    }

    function publicState() {
      return {
        mode,
        enabled: enabled(),
        effectsEnabled: mode !== "off",
        voiceEnabled: mode === "voice",
        remindersEnabled,
        unlocked,
        supported,
        effectsSupported,
        speechSupported,
        voiceAvailable: !!selectedVoice,
        voicesResolved,
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

    function pickPhrase(poolKey, pool, seed) {
      if (!pool.length) return "";
      const previous = lastPhraseChoice.get(poolKey);
      let index = stableHash(`${seed || poolKey}:${++phraseSequence}`) % pool.length;
      if (pool.length > 1 && index === previous) index = (index + 1) % pool.length;
      lastPhraseChoice.set(poolKey, index);
      return pool[index];
    }

    function chooseVoice() {
      if (!speech || typeof speech.getVoices !== "function") {
        voicesResolved = true;
        selectedVoice = null;
        emitState();
        return null;
      }
      let voices = [];
      try {
        voices = speech.getVoices() || [];
      } catch {
        voices = [];
      }
      voicesResolved = voices.length > 0;
      const thai = voices.filter((v) => /^th(?:-|_)/i.test(String(v.lang || "")));
      // Keep the privacy/offline promise honest. A browser may list cloud voices too, but this
      // dashboard only speaks through a Thai voice that declares itself local. If none exists the
      // selected voice mode remains usable as effects-only rather than sending activity text away.
      selectedVoice = thai.find((v) => v.localService === true) || null;
      emitState();
      return selectedVoice;
    }

    function ensureAudio() {
      if (!AudioCtor || audioCtx) return audioCtx;
      try {
        audioCtx = new AudioCtor();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = 1.08;
        if (typeof audioCtx.createDynamicsCompressor === "function") {
          try {
            limiter = audioCtx.createDynamicsCompressor();
            limiter.threshold.value = -10;
            limiter.knee.value = 5;
            limiter.ratio.value = 14;
            limiter.attack.value = 0.002;
            limiter.release.value = 0.14;
            limiter.connect(audioCtx.destination);
            masterGain.connect(limiter);
          } catch {
            limiter = null;
            masterGain.connect(audioCtx.destination);
          }
        } else {
          masterGain.connect(audioCtx.destination);
        }
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
        // The earlier centre frequency sat far above sine/triangle fundamentals, effectively
        // filtering the cue out on small speakers. Keep it near the note with a broad band.
        filter.frequency.value = Math.max(220, frequency * 1.08);
        filter.Q.value = 0.85;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(
          Math.max(0.001, (volume || 0.025) * EFFECT_GAIN),
          start + 0.012,
        );
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

    function playCue(item) {
      if (!enabled() || !unlocked) return;
      resumeAudio();
      const ctx = ensureAudio();
      if (!ctx) return;
      const cueKind = item.kind === "state" ? `state-${item.state || "generic"}` : item.kind;
      const seed = item.cueSeed || `${cueKind}:${item.sessionId || "global"}:${item.agentId || "main"}`;
      const variation = 0.985 + (stableHash(seed) % 31) / 1000;
      const base = (CUE_FREQUENCY[item.kind] || 640) * variation;
      let at = Math.max(ctx.currentTime + 0.005, cueCursor);
      // ไม่ปล่อย event storm จอง timeline เสียงยาวเป็นนาที — 0.75s คือคิว cue สูงสุด
      if (at - ctx.currentTime > 0.75) at = ctx.currentTime + 0.05;
      cueCursor = at + 0.075;
      const chirp = (ratio, delay, duration, type, volume, endRatio) =>
        tone(base * ratio, at + delay, duration, type, volume, endRatio ? base * endRatio : undefined);

      if (cueKind === "reminder" || cueKind === "state-waiting") {
        // Three separated notes are deliberately recognisable as "come back to me".
        chirp(0.92, 0, 0.11, "sine", 0.1, 1.08);
        chirp(1.24, 0.13, 0.11, "triangle", 0.09, 1.36);
        chirp(1.62, 0.28, 0.16, "sine", 0.11, 1.42);
      } else if (cueKind === "error" || cueKind === "blocked") {
        chirp(1.16, 0, 0.2, "sawtooth", 0.12, 0.5);
        chirp(0.72, 0.1, 0.18, "square", 0.075, 0.42);
      } else if (cueKind === "denied") {
        chirp(0.72, 0, 0.09, "square", 0.1, 0.62);
        chirp(0.72, 0.13, 0.09, "square", 0.1, 0.58);
      } else if (cueKind === "prompt" || cueKind === "session-start") {
        chirp(0.82, 0, 0.09, "triangle", 0.07, 1.08);
        chirp(1.22, 0.08, 0.11, "sine", 0.075, 1.55);
      } else if (cueKind === "thinking" || cueKind === "state-thinking") {
        chirp(0.82, 0, 0.12, "sine", 0.052, 0.98);
      } else if (cueKind === "say") {
        chirp(0.9, 0, 0.07, "triangle", 0.055, 1.22);
        chirp(1.38, 0.06, 0.07, "sine", 0.05, 1.24);
      } else if (cueKind === "tool-start" || cueKind === "state-tool") {
        chirp(1.15, 0, 0.055, "square", 0.07, 0.86);
        chirp(0.82, 0.055, 0.065, "triangle", 0.05, 1.04);
      } else if (cueKind === "tool-end") {
        chirp(0.86, 0, 0.075, "triangle", 0.055, 1.12);
        chirp(1.34, 0.065, 0.095, "sine", 0.07, 1.58);
      } else if (cueKind === "spawn" || cueKind === "state-delegating") {
        chirp(0.8, 0, 0.085, "square", 0.07, 1.04);
        chirp(0.92, 0.07, 0.1, "triangle", 0.065, 1.48);
        chirp(0.92, 0.07, 0.1, "sine", 0.055, 1.78);
      } else if (cueKind === "finish") {
        chirp(1.48, 0, 0.1, "triangle", 0.06, 1.05);
        chirp(1.08, 0.085, 0.13, "sine", 0.075, 0.88);
      } else if (cueKind === "session-end") {
        chirp(1.22, 0, 0.12, "triangle", 0.06, 0.9);
        chirp(0.86, 0.1, 0.14, "sine", 0.052, 0.62);
      } else if (cueKind === "burst") {
        chirp(0.82, 0, 0.1, "triangle", 0.06, 1.18);
        chirp(1.08, 0.025, 0.11, "sine", 0.052, 1.46);
        chirp(1.34, 0.05, 0.12, "triangle", 0.048, 1.72);
      } else {
        chirp(0.92, 0, 0.075, "square", 0.055, 1.08);
        chirp(1.42, 0.04, 0.065, "triangle", 0.04, 1.2);
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
      if (!speech || !Utterance || !selectedVoice || mode !== "voice" || !unlocked || disposed) return;
      let utterance;
      try {
        utterance = new Utterance(item.text);
      } catch {
        setTimer(drainSpeech, 0);
        return;
      }
      utterance.lang = "th-TH";
      // Full browser volume keeps Thai consonants clear; the slightly synthetic pitch preserves
      // the futuristic character without making every line sound like the same harsh robot.
      utterance.rate = 1.02;
      utterance.pitch = 0.9;
      utterance.volume = 1;
      utterance.voice = selectedVoice;
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
      if (
        disposed ||
        mode !== "voice" ||
        !unlocked ||
        currentSpeech ||
        !speech ||
        !Utterance ||
        !selectedVoice
      ) return;
      const at = now();
      speechQueue = speechQueue.filter((item) => at - item.queuedAt <= QUEUE_TTL_MS);
      const next = speechQueue.shift();
      if (next) startSpeech(next);
    }

    function queueSpeech(item, force) {
      if (mode !== "voice" || !item.text || !speech || !Utterance || !selectedVoice) return;
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
            text: phraseFor("burst", {}, (poolKey, pool) => pickPhrase(poolKey, pool, `${item.cueSeed}:burst`)),
            priority: PRIORITY.burst,
          };
        }
      } else {
        speechQueue.push(item);
      }
      speechQueue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
      drainSpeech();
    }

    function shouldSpeak(kind, detail) {
      const d = detail || {};
      if (d.speak !== undefined) return !!d.speak;
      if (d.textOverride) return true;
      if (kind === "state") return ["thinking", "delegating", "waiting", "idle", "blocked"].includes(d.state);
      // Raw thinking/say/tool edges stay audible as recognisable earcons, not repetitive narration.
      return SPOKEN_KINDS.has(kind);
    }

    function announce(kind, detail) {
      const d = detail || {};
      const timestamp = finiteMs(d.timestamp, now());
      const eventKey =
        d.eventKey ||
        [d.sessionId || "global", d.agentId || "main", kind, d.eventId ?? "", d.keySuffix || ""].join(":");
      if (!rememberKey(eventKey)) return false;
      if (!enabled() || !unlocked || disposed) return false;
      if (!d.force && now() - timestamp > EVENT_TTL_MS) return false;

      let priority = d.priority || PRIORITY[kind] || 20;
      if (kind === "state" && d.state === "waiting") priority = Math.max(priority, 88);
      if (kind === "state" && d.state === "idle") priority = Math.max(priority, 54);

      const item = {
        kind,
        text: phraseFor(kind, d, (poolKey, pool) => pickPhrase(poolKey, pool, eventKey)),
        priority,
        sessionId: d.sessionId || null,
        agentId: d.agentId || null,
        state: d.state || null,
        waitingKind: d.waitingKind || null,
        waitingCount: Number(d.waitingCount) || 0,
        cueSeed: eventKey,
        queuedAt: now(),
      };
      playCue(item); // ทุก event ใหม่ได้ sonic cue แม้คำพูดจะถูก batch/cooldown
      level = Math.max(level, 0.68);
      emitVisual("cue", item);
      if (shouldSpeak(kind, d)) queueSpeech(item, !!d.force);
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

    function waitingKindForAgent(agent) {
      const rows = (agent && agent.status && agent.status.running) || [];
      if (rows.some((row) => row && row.tool === "AskUserQuestion")) return "question";
      if (rows.length) return "confirmation";
      return "generic";
    }

    function currentWaitingSummary() {
      let kind = "generic";
      for (const entry of waitingSessions.values()) {
        if (entry.kind === "question") {
          kind = "question";
          break;
        }
        if (entry.kind === "confirmation") kind = "confirmation";
      }
      return { waitingCount: waitingSessions.size, waitingKind: kind };
    }

    function clearReminderTimer() {
      if (reminderTimer !== null) {
        clearTimer(reminderTimer);
        reminderTimer = null;
      }
    }

    function scheduleReminder() {
      clearReminderTimer();
      if (
        disposed ||
        !remindersEnabled ||
        !waitingSessions.size ||
        !enabled() ||
        !unlocked ||
        !nextReminderAt
      ) return;
      reminderTimer = setTimer(runReminder, Math.max(0, nextReminderAt - now()));
    }

    function resetReminderSchedule(startAt) {
      reminderStartedAt = finiteMs(startAt, now());
      nextReminderAt = reminderStartedAt + REMINDER_EFFECT_MS;
      scheduleReminder();
    }

    function runReminder() {
      reminderTimer = null;
      if (disposed || !waitingSessions.size || !remindersEnabled) return;
      const at = now();
      const shouldUseSpeech = at - reminderStartedAt >= REMINDER_SPEECH_MS;
      const summary = currentWaitingSummary();
      if (enabled() && unlocked) {
        announce("reminder", {
          ...summary,
          speak: shouldUseSpeech,
          timestamp: at,
          eventKey: `wait-reminder:${++reminderSequence}:${at}`,
          force: true,
        });
      }
      nextReminderAt = shouldUseSpeech ? at + REMINDER_REPEAT_MS : reminderStartedAt + REMINDER_SPEECH_MS;
      scheduleReminder();
    }

    function syncWaitingSessions(agents, frameNow) {
      const previous = new Set(waitingSessions.keys());
      const next = new Map();
      for (const agent of agents) {
        if (!agent || !agent.sessionId || !agent.status || agent.status.state !== "waiting") continue;
        next.set(agent.sessionId, {
          kind: waitingKindForAgent(agent),
          since: waitingSessions.get(agent.sessionId)?.since || frameNow,
        });
      }

      const entered = [];
      for (const sid of next.keys()) {
        if (!previous.has(sid)) entered.push(sid);
      }
      const hadWaiting = waitingSessions.size > 0;
      waitingSessions.clear();
      for (const [sid, entry] of next) waitingSessions.set(sid, entry);

      if (!waitingSessions.size) {
        clearReminderTimer();
        reminderStartedAt = 0;
        nextReminderAt = 0;
      } else if (!hadWaiting) {
        resetReminderSchedule(frameNow);
      } else {
        scheduleReminder();
      }
      return { entered, ...currentWaitingSummary() };
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
        syncWaitingSessions(agents, frameNow);
        bootstrapped = true;
        return; // ห้ามอ่าน history เก่าออกเสียงตอนเพิ่งเปิดหน้า
      }

      const detected = [];
      const waitingUpdate = syncWaitingSessions(agents, frameNow);
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
        // Waiting entries are announced once per snapshot below so several simultaneous questions
        // become one understandable alert instead of competing voices.
        if (state && state !== prev.state && state !== "waiting") {
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

      if (waitingUpdate.entered.length) {
        detected.push({
          kind: "state",
          state: "waiting",
          waitingKind: waitingUpdate.waitingKind,
          waitingCount: waitingUpdate.waitingCount,
          sessionId: waitingUpdate.entered[0],
          timestamp: frameNow,
          eventKey: ["waiting", ++stateTransitionSequence, waitingUpdate.entered.join(",")].join(":"),
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
      // A BFCache document can keep JavaScript timers alive while another page is visible. Pause
      // reminders there; pageshow calls resume() and re-evaluates the existing wait safely.
      if (reason === "bfcache") clearReminderTimer();
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
        const waiting = current === "waiting" ? currentWaitingSummary() : {};
        announce(current === "blocked" ? "blocked" : "state", {
          state: current,
          ...waiting,
          speak: true,
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
      if (!enabled() || disposed) return false;
      unlocked = true;
      resumeAudio();
      chooseVoice();
      emitState();
      if (announceCurrent) {
        announceCurrentOrReady();
        if (waitingSessions.size) resetReminderSchedule(now());
      } else {
        scheduleReminder();
      }
      return true;
    }

    function normalizeMode(value) {
      if (value === true || value === "1") return "voice";
      if (value === false || value == null || value === "0") return "off";
      return AUDIO_MODES.has(value) ? value : "off";
    }

    function setMode(next, config) {
      const value = normalizeMode(next);
      const cfg = config || {};
      if (value === mode) {
        if (value !== "off" && cfg.userGesture && !unlocked) unlock(cfg.preview !== false);
        else if (value !== "off" && cfg.userGesture) resumeAudio();
        return publicState();
      }
      const previous = mode;
      mode = value;
      try {
        if (storage) storage.setItem(key, mode);
      } catch {
        /* private mode / storage disabled */
      }
      if (mode === "off") {
        unlocked = false;
        clearReminderTimer();
        cancel("disabled");
      } else {
        if (previous === "voice" && mode === "effects") cancel("effects-only");
        if (cfg.userGesture) {
          unlock(cfg.preview !== false);
        } else if (unlocked) {
          if (mode === "voice") chooseVoice();
          scheduleReminder();
        }
      }
      emitState();
      return publicState();
    }

    function setEnabled(next, config) {
      return setMode(next ? "voice" : "off", config);
    }

    function setRemindersEnabled(next) {
      remindersEnabled = !!next;
      try {
        if (storage) storage.setItem(remindersKey, remindersEnabled ? "1" : "0");
      } catch {
        /* private mode / storage disabled */
      }
      if (!remindersEnabled) clearReminderTimer();
      else if (waitingSessions.size) resetReminderSchedule(now());
      emitState();
      return publicState();
    }

    function resume() {
      if (disposed || !enabled()) return false;
      resumeAudio();
      scheduleReminder();
      emitState();
      return true;
    }

    function gestureUnlock(event) {
      // ถ้ากำลังกดปุ่มเสียงเอง ให้ click handler เป็นคนตัดสินก่อนว่าจะเปิดหรือปิด มิฉะนั้นค่าที่จำว่า
      // "เปิด" จากรอบก่อนจะพูดหนึ่งคำทันทีตอนผู้ใช้ตั้งใจกดปิด
      const target = event && event.target;
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest(
          ".agent-voice-toggle, [data-audio-mode], .hud-audio-controls, .agent-wait-reminder-toggle, .hud-btn-reminders",
        )
      ) return;
      if (enabled() && !unlocked) unlock(true);
      else if (enabled() && audioCtx && audioCtx.state === "suspended") resumeAudio();
    }

    function storageChanged(event) {
      if (!event) return;
      if (event.key === remindersKey) {
        const next = event.newValue == null ? true : event.newValue !== "0" && event.newValue !== "false";
        if (next === remindersEnabled) return;
        remindersEnabled = next;
        if (!remindersEnabled) clearReminderTimer();
        else if (waitingSessions.size) resetReminderSchedule(now());
        emitState();
        return;
      }
      if (event.key !== key) return;
      const next = normalizeMode(event.newValue);
      if (next === mode) return;
      const previous = mode;
      mode = next;
      if (mode === "off") {
        unlocked = false;
        clearReminderTimer();
        cancel("storage-disabled");
      } else if (unlocked) {
        if (previous === "voice" && mode === "effects") cancel("storage-effects-only");
        if (mode === "voice") chooseVoice();
        scheduleReminder();
      }
      emitState();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      clearReminderTimer();
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
      limiter = null;
      latestSnapshot = null;
      selectedVoice = null;
      sessions.clear();
      waitingSessions.clear();
      seenKeys.clear();
      lastPhraseAt.clear();
      lastPhraseChoice.clear();
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
      setMode,
      setEnabled,
      setRemindersEnabled,
      unlock,
      resume,
      cancel,
      dispose,
      getState: publicState,
      get enabled() {
        return enabled();
      },
      get mode() {
        return mode;
      },
      get speaking() {
        return !!currentSpeech;
      },
      get level() {
        return level;
      },
    };
  }

  root.AgentActivityAudio = Object.freeze({
    create,
    STORAGE_KEY,
    REMINDERS_STORAGE_KEY,
    MODES: Object.freeze(["off", "effects", "voice"]),
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
