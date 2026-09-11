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
  assert.equal(h.controller.getState().unlocked, true);
  assert.equal(h.storage.value(h.api.STORAGE_KEY), "1");

  h.controller.setEnabled(false, { userGesture: true });
  assert.equal(h.storage.value(h.api.STORAGE_KEY), "0");
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
  assert.equal(h.speech.spoken[0].text, "รับคำสั่งใหม่แล้ว");

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
  assert.equal(h.speech.spoken[0].text, "กำลังตอบ");
});

test("delegating state and sub-agent lifecycle use short Thai phrases", async (t) => {
  const h = await harness();
  t.after(() => h.controller.dispose());
  h.controller.setEnabled(true, { userGesture: true, preview: false });
  h.controller.ingest(snapshot(h.now(), { state: "thinking" }));

  const delegatedAt = h.advance(700);
  h.controller.ingest(snapshot(delegatedAt, { state: "delegating" }));
  assert.equal(h.speech.spoken.at(-1).text, "กำลังรอผลจากซับเอเจนต์");
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

  h.controller.unlock(false);
  const finalAt = h.advance(700);
  h.controller.ingest(
    snapshot(finalAt, {
      events: [
        { i: 1, kind: "prompt", ts: new Date(nextAt).toISOString() },
        { i: 2, kind: "thinking", ts: new Date(finalAt).toISOString() },
      ],
    }),
  );
  assert.equal(h.speech.spoken[0].text, "กำลังคิด");
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
    h.visuals.filter((e) => e.phase === "cue" && e.text === "กำลังรอผลจากซับเอเจนต์").length,
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
  assert.equal(finishCue.text, "ซับเอเจนต์สิ้นสุดการทำงาน");
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
  let context;
  class FakeAudioContext {
    constructor() {
      context = this;
      this.currentTime = 0;
      this.state = "suspended";
      this.destination = {};
    }
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {
          return this;
        },
      };
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
  controller.setEnabled(true, { userGesture: true, preview: false });
  assert.equal(context.state, "running");
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
  // Each ordinary cue consists of two short oscillator tones. With speech disabled there is no
  // additional speech pre-chirp, so four starts prove that neither event was batched away.
  assert.equal(started.length, 4);
  assert.equal(stopped.length, 4, "each tone has its normal scheduled stop");
  controller.cancel("bfcache");
  assert.equal(stopped.length, 8, "navigation cancel immediately stops every scheduled tone");
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
  assert.equal(speech.spoken[0].text, "กำลังคิด");
});
