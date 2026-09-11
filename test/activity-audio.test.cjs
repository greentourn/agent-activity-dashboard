const test = require("node:test");
const assert = require("node:assert/strict");

let apiPromise;
function loadApi() {
  if (!apiPromise) {
    apiPromise = import("../public/activity-audio.js").then(() => globalThis.AgentActivityAudio);
  }
  return apiPromise;
}

class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.onstart = null;
    this.onboundary = null;
    this.onend = null;
    this.onerror = null;
  }
}

function fakeSpeech() {
  const listeners = new Map();
  return {
    spoken: [],
    cancelCount: 0,
    getVoices() {
      return [{ name: "Thai test voice", lang: "th-TH", localService: true }];
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    speak(utterance) {
      this.spoken.push(utterance);
      if (utterance.onstart) utterance.onstart();
    },
    cancel() {
      this.cancelCount += 1;
    },
  };
}

function fakeStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    value(key) {
      return values.get(key);
    },
  };
}

function snapshot(nowMs, { state = "thinking", events = [], subs = [], running = [] } = {}) {
  return {
    nowMs,
    agents: [
      {
        sessionId: "s1",
        alive: true,
        status: { state, since: new Date(nowMs).toISOString(), running },
        events,
        subagents: subs,
      },
    ],
  };
}

async function harness({ stored = false } = {}) {
  const api = await loadApi();
  const speech = fakeSpeech();
  const storage = fakeStorage(stored ? { [api.STORAGE_KEY]: "1" } : {});
  const visuals = [];
  let clock = 1_800_000_000_000;
  const controller = api.create({
    storage,
    speechSynthesis: speech,
    SpeechSynthesisUtterance: FakeUtterance,
    AudioContext: null,
    document: null,
    now: () => clock,
    onVisual: (event) => visuals.push(event),
  });
  return {
    api,
    controller,
    speech,
    storage,
    visuals,
    now: () => clock,
    advance(ms) {
      clock += ms;
      return clock;
    },
    finishCurrent() {
      const current = speech.spoken.at(-1);
      if (current && current.onend) current.onend();
    },
  };
}

test("defaults to off and persists an explicit opt-in", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.getState().enabled, false);

  h.controller.setEnabled(true, { userGesture: true, preview: false });
  assert.equal(h.controller.getState().enabled, true);
  assert.equal(h.controller.getState().mode, "voice");
  assert.equal(h.controller.getState().unlocked, true);
  assert.equal(h.storage.value(h.api.STORAGE_KEY), "voice");

  h.controller.setEnabled(false, { userGesture: true });
  assert.equal(h.storage.value(h.api.STORAGE_KEY), "off");
  assert.ok(h.speech.cancelCount >= 1);
});

test("first ingest is a silent baseline; later new events keep producing cues", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });

  const first = snapshot(h.now(), {
    events: [{ i: 1, kind: "thinking", ts: new Date(h.now()).toISOString() }],
  });
  h.controller.ingest(first);
  assert.equal(h.speech.spoken.length, 0);
  assert.equal(h.visuals.filter((e) => e.phase === "cue").length, 0);

  const nextAt = h.advance(700);
  const second = snapshot(nextAt, {
    events: [
      ...first.agents[0].events,
      { i: 2, kind: "prompt", ts: new Date(nextAt).toISOString() },
      { i: 3, kind: "tool", tool: "Read", done: true, durMs: 80, ts: new Date(nextAt).toISOString() },
    ],
  });
  h.controller.ingest(second);
  // prompt + tool-start + tool-end: ทุก event/lifecycle edge ได้ cue แม้ speech จะเข้า queue ทีละคำ
  assert.equal(h.visuals.filter((e) => e.phase === "cue").length, 3);
  assert.ok(["รับงานใหม่แล้ว", "เริ่มงานใหม่แล้ว", "รับเรื่องแล้ว กำลังเริ่มทำงาน"].includes(h.speech.spoken[0].text));
  assert.equal(h.speech.spoken[0].volume, 1, "Thai speech uses the browser's maximum volume");
  assert.equal(h.speech.spoken[0].rate, 1.02);
  assert.equal(h.speech.spoken[0].pitch, 0.9);

  const cueCount = h.visuals.filter((e) => e.phase === "cue").length;
  h.controller.ingest(second);
  assert.equal(h.visuals.filter((e) => e.phase === "cue").length, cueCount, "same SSE snapshot must not replay");
});

test("events observed while disabled are not replayed after enabling", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.ingest(snapshot(h.now()));

  const eventAt = h.advance(700);
  const withEvent = snapshot(eventAt, {
    events: [{ i: 1, kind: "thinking", ts: new Date(eventAt).toISOString() }],
  });
  h.controller.ingest(withEvent);
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  h.controller.ingest(withEvent);
  assert.equal(h.speech.spoken.length, 0);

  const nextAt = h.advance(700);
  h.controller.ingest(
    snapshot(nextAt, {
      events: [
        ...withEvent.agents[0].events,
        { i: 2, kind: "say", ts: new Date(nextAt).toISOString() },
      ],
    }),
  );
  assert.equal(h.speech.spoken.length, 0, "routine reply events use an earcon, not repetitive narration");
  assert.ok(h.visuals.some((e) => e.phase === "cue" && e.kind === "say"));
});

test("delegating state and sub-agent lifecycle use short Thai phrases", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  h.controller.ingest(snapshot(h.now(), { state: "thinking" }));

  const delegatedAt = h.advance(700);
  h.controller.ingest(snapshot(delegatedAt, { state: "delegating" }));
  assert.match(h.speech.spoken.at(-1).text, /ผู้ช่วย/);
  assert.doesNotMatch(h.speech.spoken.at(-1).text, /ซับเอเจนต์/);
  h.finishCurrent();

  const spawnAt = h.advance(2_000);
  h.controller.ingest(
    snapshot(spawnAt, {
      state: "delegating",
      subs: [{ agentId: "a1", running: true, startedTs: new Date(spawnAt).toISOString(), events: [] }],
    }),
  );
  assert.ok(h.visuals.some((e) => e.phase === "cue" && e.kind === "spawn"));
  h.finishCurrent();

  const finishAt = h.advance(2_000);
  h.controller.ingest(
    snapshot(finishAt, {
      state: "delegating",
      subs: [{ agentId: "a1", running: false, outcome: "ok", startedTs: new Date(spawnAt).toISOString(), events: [] }],
    }),
  );
  assert.ok(h.visuals.some((e) => e.phase === "cue" && e.kind === "finish"));
});

test("a stored opt-in stays locked until a user gesture unlocks it", async (t) => {
  const h = await harness({ stored: true });
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.getState().enabled, true);
  assert.equal(h.controller.getState().unlocked, false);

  h.controller.ingest(snapshot(h.now()));
  const nextAt = h.advance(700);
  h.controller.ingest(
    snapshot(nextAt, {
      events: [{ i: 1, kind: "prompt", ts: new Date(nextAt).toISOString() }],
    }),
  );
  assert.equal(h.speech.spoken.length, 0);

  h.controller.unlock(true);
  assert.ok(["กำลังคิดอยู่", "กำลังวิเคราะห์ต่อ", "กำลังทบทวนข้อมูล"].includes(h.speech.spoken[0].text));
});

test("a session appearing after bootstrap emits each fresh buffered event", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  h.controller.ingest({ nowMs: h.now(), agents: [] });

  const eventAt = h.advance(700);
  const bufferedAt = eventAt - 300;
  h.controller.ingest(
    snapshot(eventAt, {
      events: [
        { i: 1, kind: "prompt", ts: new Date(bufferedAt).toISOString() },
        { i: 2, kind: "tool", tool: "Read", done: true, durMs: 80, ts: new Date(bufferedAt).toISOString() },
      ],
    }),
  );

  assert.deepEqual(
    h.visuals.filter((e) => e.phase === "cue").map((e) => e.kind),
    ["session-start", "prompt", "tool-start", "tool-end"],
  );
});

test("multiple new sessions are each introduced before their interleaved buffered events", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  h.controller.ingest({ nowMs: h.now(), agents: [] });

  const frameAt = h.advance(700);
  const agent = (sessionId, eventAt) => ({
    sessionId,
    alive: true,
    status: { state: "thinking", since: new Date(eventAt).toISOString(), running: [] },
    events: [{ i: 1, kind: "prompt", ts: new Date(eventAt).toISOString() }],
    subagents: [],
  });
  h.controller.ingest({
    nowMs: frameAt,
    agents: [agent("s1", frameAt - 100), agent("s2", frameAt - 300)],
  });

  assert.deepEqual(
    h.visuals.filter((e) => e.phase === "cue").map((e) => `${e.sessionId}:${e.kind}`),
    ["s2:session-start", "s2:prompt", "s1:session-start", "s1:prompt"],
  );
});

test("simultaneous and very short sub-agents retain every lifecycle cue", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  h.controller.ingest(snapshot(h.now()));

  const eventAt = h.advance(700);
  const ts = new Date(eventAt).toISOString();
  h.controller.ingest(
    snapshot(eventAt, {
      subs: [
        { agentId: "a1", running: true, startedTs: ts, lastTs: ts, events: [] },
        { agentId: "a2", running: false, outcome: "ok", startedTs: ts, lastTs: ts, events: [] },
      ],
    }),
  );

  const cues = h.visuals.filter((e) => e.phase === "cue");
  assert.equal(cues.filter((e) => e.kind === "spawn").length, 2);
  assert.equal(cues.filter((e) => e.kind === "finish").length, 1);
});

test("parallel identical running tools each produce a completion cue", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  const startedTs = new Date(h.now()).toISOString();
  const row = { tool: "Read", startedTs };
  h.controller.ingest(snapshot(h.now(), { state: "tool", running: [row, { ...row }] }));

  h.controller.ingest(snapshot(h.advance(700), { state: "tool", running: [row] }));
  assert.equal(h.visuals.filter((e) => e.phase === "cue" && e.kind === "tool-end").length, 1);

  h.controller.ingest(snapshot(h.advance(700), { state: "thinking", running: [] }));
  assert.equal(h.visuals.filter((e) => e.phase === "cue" && e.kind === "tool-end").length, 2);
});

test("a newly completed tool with a missing timestamp still gets start and end cues", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  h.controller.ingest(snapshot(h.now()));

  h.controller.ingest(
    snapshot(h.advance(700), {
      events: [{ i: 1, kind: "tool", tool: "Read", done: true, durMs: 80 }],
    }),
  );
  assert.deepEqual(
    h.visuals.filter((e) => e.phase === "cue").map((e) => e.kind),
    ["tool-start", "tool-end"],
  );
});

test("an event-index reset re-baselines once and keeps later events audible", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  h.controller.ingest(snapshot(h.now()));

  const beforeReset = h.advance(700);
  h.controller.ingest(
    snapshot(beforeReset, {
      events: [
        { i: 1, kind: "prompt", ts: new Date(beforeReset).toISOString() },
        { i: 2, kind: "thinking", ts: new Date(beforeReset).toISOString() },
      ],
    }),
  );
  const cueCountBeforeReset = h.visuals.filter((e) => e.phase === "cue").length;
  assert.equal(cueCountBeforeReset, 2);

  const resetAt = h.advance(700);
  h.controller.ingest(
    snapshot(resetAt, {
      events: [{ i: 1, kind: "prompt", ts: new Date(resetAt).toISOString() }],
    }),
  );
  assert.equal(
    h.visuals.filter((e) => e.phase === "cue").length,
    cueCountBeforeReset,
    "restart frame is a silent cursor reset",
  );

  const nextAt = h.advance(700);
  h.controller.ingest(
    snapshot(nextAt, {
      events: [
        { i: 1, kind: "prompt", ts: new Date(resetAt).toISOString() },
        { i: 2, kind: "thinking", ts: new Date(nextAt).toISOString() },
      ],
    }),
  );
  assert.equal(h.visuals.filter((e) => e.phase === "cue" && e.kind === "thinking").length, 2);
});

test("re-entering a state stays audible when status.since is reused", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  const sharedSince = new Date(h.now()).toISOString();
  const first = snapshot(h.now(), { state: "thinking" });
  first.agents[0].status.since = sharedSince;
  h.controller.ingest(first);

  const delegated = snapshot(h.advance(700), { state: "delegating" });
  delegated.agents[0].status.since = sharedSince;
  h.controller.ingest(delegated);

  const tool = snapshot(h.advance(700), { state: "tool" });
  tool.agents[0].status.since = sharedSince;
  h.controller.ingest(tool);

  const delegatedAgain = snapshot(h.advance(700), { state: "delegating" });
  delegatedAgain.agents[0].status.since = sharedSince;
  h.controller.ingest(delegatedAgain);

  assert.equal(
    h.visuals.filter((e) => e.phase === "cue" && e.kind === "state" && e.text.includes("ผู้ช่วย")).length,
    2,
  );
});

test("an unknown sub-agent outcome is announced without claiming failure", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  const startedAt = new Date(h.now()).toISOString();
  h.controller.ingest(
    snapshot(h.now(), {
      subs: [{ agentId: "a1", running: true, startedTs: startedAt, events: [] }],
    }),
  );

  const finishAt = h.advance(2_000);
  h.controller.ingest(
    snapshot(finishAt, {
      subs: [
        {
          agentId: "a1",
          running: false,
          outcome: "unknown",
          startedTs: startedAt,
          lastTs: new Date(finishAt).toISOString(),
          events: [],
        },
      ],
    }),
  );
  const finishCue = h.visuals.find((e) => e.phase === "cue" && e.kind === "finish");
  assert.match(finishCue.text, /ผู้ช่วย/);
  assert.doesNotMatch(finishCue.text, /ไม่สำเร็จ/);
});

test("a blocked localStorage getter cannot break optional audio initialization", async () => {
  const api = await loadApi();
  const hostileGlobal = Object.create(globalThis);
  Object.defineProperty(hostileGlobal, "localStorage", {
    get() {
      throw new Error("storage denied");
    },
  });

  let controller;
  assert.doesNotThrow(() => {
    controller = api.create({
      global: hostileGlobal,
      document: null,
      speechSynthesis: null,
      SpeechSynthesisUtterance: null,
      AudioContext: null,
    });
  });
  assert.equal(controller.getState().enabled, false);
  assert.equal(controller.getState().supported, false);
  controller.dispose();
});

test("audio-only browsers still synthesize a sonic cue for every detected event", async (t) => {
  const api = await loadApi();
  const started = [];
  const stopped = [];
  const gainNodes = [];
  const gainRamps = [];
  let compressor = null;
  let context;
  class FakeAudioContext {
    constructor() {
      context = this;
      this.currentTime = 0;
      this.state = "suspended";
      this.destination = {};
    }
    createGain() {
      const node = {
        gain: {
          value: 0,
          setValueAtTime() {},
          exponentialRampToValueAtTime(value) {
            gainRamps.push(value);
          },
        },
        connect() {
          return this;
        },
      };
      gainNodes.push(node);
      return node;
    }
    createDynamicsCompressor() {
      compressor = {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        connect() {
          return this;
        },
      };
      return compressor;
    }
    createOscillator() {
      return {
        type: "",
        frequency: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {
          return this;
        },
        start(at) {
          started.push(at);
        },
        stop() {
          stopped.push(true);
        },
      };
    }
    createBiquadFilter() {
      return {
        type: "",
        frequency: { value: 0 },
        Q: { value: 0 },
        connect() {
          return this;
        },
      };
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  }

  let clock = 1_800_000_000_000;
  const controller = api.create({
    storage: fakeStorage(),
    speechSynthesis: null,
    SpeechSynthesisUtterance: null,
    AudioContext: FakeAudioContext,
    document: null,
    now: () => clock,
  });
  t.after(() => controller.dispose());
  controller.setMode("voice", { userGesture: true, preview: false });
  assert.equal(context.state, "running");
  assert.equal(gainNodes[0].gain.value, 1.08, "event master gain stays at the audible preset");
  assert.equal(compressor.threshold.value, -10);
  assert.equal(compressor.ratio.value, 14);
  controller.ingest(snapshot(clock));

  clock += 700;
  controller.ingest(
    snapshot(clock, {
      events: [
        { i: 1, kind: "prompt", ts: new Date(clock).toISOString() },
        { i: 2, kind: "thinking", ts: new Date(clock).toISOString() },
      ],
    }),
  );
  // Cue families use different note counts. At least one oscillator per fresh event proves that
  // neither edge was batched away.
  assert.ok(started.length >= 3);
  assert.ok(Math.max(...gainRamps) >= 0.12, "ordinary event cues use the stronger per-tone level");
  assert.equal(stopped.length, started.length, "each tone has its normal scheduled stop");
  controller.cancel("bfcache");
  assert.equal(stopped.length, started.length * 2, "navigation cancel immediately stops every scheduled tone");
});

test("persisted audio unlocks on a real page gesture but not on the sound toggle pre-click", async (t) => {
  const api = await loadApi();
  const handlers = new Map();
  const document = {
    addEventListener(type, fn) {
      handlers.set(type, fn);
    },
    removeEventListener(type) {
      handlers.delete(type);
    },
  };
  const speech = fakeSpeech();
  const controller = api.create({
    storage: fakeStorage({ [api.STORAGE_KEY]: "1" }),
    speechSynthesis: speech,
    SpeechSynthesisUtterance: FakeUtterance,
    AudioContext: null,
    document,
  });
  t.after(() => controller.dispose());
  controller.ingest(snapshot(Date.now(), { state: "thinking" }));

  handlers.get("pointerdown")({ target: { closest: () => ({}) } });
  assert.equal(controller.getState().unlocked, false, "toggle gesture is reserved for its click handler");
  assert.equal(speech.spoken.length, 0);

  handlers.get("pointerdown")({ target: { closest: () => null } });
  assert.equal(controller.getState().unlocked, true);
  assert.ok(["กำลังคิดอยู่", "กำลังวิเคราะห์ต่อ", "กำลังทบทวนข้อมูล"].includes(speech.spoken[0].text));
});

test("three audio modes persist independently from repeat-wait reminders", async (t) => {
  const h = await harness({ stored: true });
  t.after(() => h.controller.dispose());
  assert.equal(h.controller.getState().mode, "voice", "legacy 1 migrates to voice mode");

  h.controller.setMode("effects", { userGesture: true, preview: false });
  assert.equal(h.controller.getState().mode, "effects");
  assert.equal(h.controller.getState().voiceEnabled, false);
  assert.equal(h.storage.value(h.api.STORAGE_KEY), "effects");

  h.controller.setRemindersEnabled(false);
  assert.equal(h.controller.getState().remindersEnabled, false);
  assert.equal(h.storage.value(h.api.REMINDERS_STORAGE_KEY), "0");
  h.controller.setMode("off", { userGesture: true });
  assert.equal(h.controller.getState().remindersEnabled, false, "the reminder preference survives sound being off");
});

test("effects-only keeps every event cue but does not start browser speech", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setMode("effects", { userGesture: true, preview: false });
  h.controller.ingest(snapshot(h.now()));
  const at = h.advance(700);
  h.controller.ingest(
    snapshot(at, {
      events: [
        { i: 1, kind: "prompt", ts: new Date(at).toISOString() },
        { i: 2, kind: "tool", tool: "Read", done: true, ts: new Date(at).toISOString() },
      ],
    }),
  );
  assert.equal(h.visuals.filter((event) => event.phase === "cue").length, 3);
  assert.equal(h.speech.spoken.length, 0);
});

test("voice mode keeps activity local: a remote-only Thai voice falls back to effects", async (t) => {
  const api = await loadApi();
  const remoteOnlySpeech = fakeSpeech();
  remoteOnlySpeech.getVoices = () => [{ name: "Remote Thai", lang: "th-TH", localService: false }];
  const visuals = [];
  const controller = api.create({
    storage: fakeStorage(),
    speechSynthesis: remoteOnlySpeech,
    SpeechSynthesisUtterance: FakeUtterance,
    AudioContext: null,
    document: null,
    onVisual: (event) => visuals.push(event),
  });
  t.after(() => controller.dispose());
  controller.setMode("voice", { userGesture: true, preview: false });
  assert.equal(controller.getState().voiceAvailable, false);
  assert.equal(controller.getState().voiceLanguage, "");
  controller.announce("prompt", { force: true, timestamp: Date.now(), eventKey: "remote-only" });
  assert.equal(remoteOnlySpeech.spoken.length, 0);
  assert.ok(visuals.some((event) => event.phase === "cue" && event.kind === "prompt"));
});

async function voicesHarness(voices) {
  const api = await loadApi();
  const speech = fakeSpeech();
  speech.getVoices = () => voices;
  const controller = api.create({
    storage: fakeStorage(),
    speechSynthesis: speech,
    SpeechSynthesisUtterance: FakeUtterance,
    AudioContext: null,
    document: null,
  });
  return { controller, speech };
}

const THAI_TEXT = /[฀-๿]/;

test("without a Thai voice, the machine's local default voice speaks the English phrase set", async (t) => {
  const { controller, speech } = await voicesHarness([
    { name: "Microsoft Zira", lang: "en-US", localService: true, default: false },
    { name: "Microsoft David", lang: "en-US", localService: true, default: true },
    { name: "Premwadee Online (Natural)", lang: "th-TH", localService: false, default: false },
  ]);
  t.after(() => controller.dispose());
  controller.setMode("voice", { userGesture: true, preview: false });
  const state = controller.getState();
  assert.equal(state.voiceAvailable, true);
  assert.equal(state.voiceFallback, true);
  assert.equal(state.voiceLanguage, "en");
  assert.equal(state.voiceName, "Microsoft David");

  controller.announce("prompt", { force: true, timestamp: Date.now(), eventKey: "fallback-prompt" });
  assert.equal(speech.spoken.length, 1);
  const utterance = speech.spoken[0];
  assert.equal(utterance.lang, "en-US");
  assert.equal(utterance.voice.name, "Microsoft David");
  assert.ok(utterance.text.length > 0);
  assert.ok(!THAI_TEXT.test(utterance.text), `expected an English phrase, got ${utterance.text}`);
});

test("a local Thai voice still wins over the machine's default voice", async (t) => {
  const { controller, speech } = await voicesHarness([
    { name: "Microsoft David", lang: "en-US", localService: true, default: true },
    { name: "Microsoft Premwadee", lang: "th-TH", localService: true, default: false },
  ]);
  t.after(() => controller.dispose());
  controller.setMode("voice", { userGesture: true, preview: false });
  const state = controller.getState();
  assert.equal(state.voiceFallback, false);
  assert.equal(state.voiceLanguage, "th");
  assert.equal(state.voiceName, "Microsoft Premwadee");

  controller.announce("prompt", { force: true, timestamp: Date.now(), eventKey: "thai-prompt" });
  assert.equal(speech.spoken.length, 1);
  assert.equal(speech.spoken[0].lang, "th-TH");
  assert.ok(THAI_TEXT.test(speech.spoken[0].text));
});

test("fallback prefers an English local voice over a non-English default", async (t) => {
  const { controller } = await voicesHarness([
    { name: "Microsoft Haruka", lang: "ja-JP", localService: true, default: true },
    { name: "Microsoft Mark", lang: "en-US", localService: true, default: false },
  ]);
  t.after(() => controller.dispose());
  controller.setMode("voice", { userGesture: true, preview: false });
  assert.equal(controller.getState().voiceName, "Microsoft Mark");
  assert.equal(controller.getState().voiceLanguage, "en");
});

test("every Thai phrase pool key has an English counterpart of the same size", async (t) => {
  // Reminder/burst/state keys are resolved by name at announce time, so a missing English key
  // would silently produce an empty utterance on machines without a Thai voice.
  const { controller, speech } = await voicesHarness([
    { name: "Microsoft David", lang: "en-US", localService: true, default: true },
  ]);
  t.after(() => controller.dispose());
  controller.setMode("voice", { userGesture: true, preview: false });
  const cases = [
    ["ready", {}],
    ["prompt", {}],
    ["spawn", { count: 1 }],
    ["spawn", { count: 3 }],
    ["finish", { ok: true }],
    ["finish", { ok: false }],
    ["finish", { ok: null }],
    ["error", {}],
    ["denied", {}],
    ["blocked", {}],
    ["session-start", {}],
    ["session-end", {}],
    ["burst", {}],
    ["state", { state: "thinking" }],
    ["state", { state: "delegating" }],
    ["state", { state: "idle" }],
    ["state", { state: "waiting", waitingKind: "question", waitingCount: 1 }],
    ["state", { state: "waiting", waitingKind: "confirmation", waitingCount: 1 }],
    ["state", { state: "waiting", waitingKind: "other", waitingCount: 1 }],
    ["state", { state: "waiting", waitingKind: "question", waitingCount: 2 }],
    ["reminder", { waitingKind: "question", waitingCount: 1 }],
    ["reminder", { waitingKind: "confirmation", waitingCount: 1 }],
    ["reminder", { waitingKind: "other", waitingCount: 1 }],
    ["reminder", { waitingKind: "question", waitingCount: 3 }],
  ];
  for (const [kind, detail] of cases) {
    speech.spoken.length = 0;
    controller.cancel("test");
    controller.announce(kind, { ...detail, force: true, speak: true, timestamp: Date.now(), eventKey: `en:${kind}:${JSON.stringify(detail)}` });
    assert.equal(speech.spoken.length, 1, `${kind} ${JSON.stringify(detail)} should speak`);
    const text = speech.spoken[0].text;
    assert.ok(text && !THAI_TEXT.test(text), `${kind} ${JSON.stringify(detail)} spoke "${text}"`);
  }
});

test("plain Thai phrase pools avoid an immediate repeated line", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setMode("voice", { userGesture: true, preview: false });
  h.controller.announce("prompt", { force: true, timestamp: h.now(), eventKey: "phrase-a" });
  const first = h.speech.spoken.at(-1).text;
  h.finishCurrent();
  h.advance(400);
  h.controller.announce("prompt", { force: true, timestamp: h.now(), eventKey: "phrase-b" });
  const second = h.speech.spoken.at(-1).text;
  assert.notEqual(first, second);
});

test("wait reminders cue at 30s, speak at 90s, and stop after the waiting state clears", async (t) => {
  const api = await loadApi();
  let clock = 1_800_000_000_000;
  let nextTimerId = 1;
  const timers = new Map();
  const setTimeoutFake = (fn, delay) => {
    const id = nextTimerId++;
    timers.set(id, { due: clock + Number(delay || 0), fn });
    return id;
  };
  const clearTimeoutFake = (id) => timers.delete(id);
  const runDue = () => {
    let ready = true;
    while (ready) {
      ready = [...timers.entries()]
        .filter(([, timer]) => timer.due <= clock)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (ready) {
        timers.delete(ready[0]);
        ready[1].fn();
      }
    }
  };
  const speech = fakeSpeech();
  const visuals = [];
  const controller = api.create({
    storage: fakeStorage(),
    speechSynthesis: speech,
    SpeechSynthesisUtterance: FakeUtterance,
    AudioContext: null,
    document: null,
    now: () => clock,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    setInterval: () => 0,
    clearInterval: () => {},
    onVisual: (event) => visuals.push(event),
  });
  t.after(() => controller.dispose());
  controller.setMode("voice", { userGesture: true, preview: false });
  controller.ingest(
    snapshot(clock, {
      state: "waiting",
      running: [{ tool: "AskUserQuestion", startedTs: new Date(clock).toISOString() }],
    }),
  );
  assert.equal(visuals.filter((event) => event.phase === "cue" && event.kind === "reminder").length, 0, "baseline stays quiet");

  clock += 30_000;
  runDue();
  assert.equal(visuals.filter((event) => event.phase === "cue" && event.kind === "reminder").length, 1);
  assert.equal(speech.spoken.length, 0, "first repeat is an effect only");

  controller.cancel("bfcache");
  clock += 60_000;
  runDue();
  assert.equal(visuals.filter((event) => event.phase === "cue" && event.kind === "reminder").length, 1, "hidden pages stay silent");
  controller.resume();
  runDue();
  assert.equal(visuals.filter((event) => event.phase === "cue" && event.kind === "reminder").length, 2);
  assert.equal(speech.spoken.length, 1, "second repeat adds a short spoken reminder");
  assert.match(speech.spoken[0].text, /คุณ/);

  controller.ingest(snapshot(clock, { state: "thinking", running: [] }));
  const before = visuals.filter((event) => event.phase === "cue" && event.kind === "reminder").length;
  clock += 240_000;
  runDue();
  assert.equal(visuals.filter((event) => event.phase === "cue" && event.kind === "reminder").length, before);
});
