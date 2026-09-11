#!/usr/bin/env node
/**
 * Agent Activity Dashboard — see WHAT every Claude Code agent is doing, on any surface.
 *
 * Why this exists: Pixel Agents shows a character per agent but not the work, and it does not
 * pick up sessions run through the VS Code Claude extension. Claude Code itself writes the same
 * two sources of truth no matter where it runs (CLI, VS Code extension, desktop app, `claude --bg`),
 * so this reads those directly:
 *
 *   1. ~/.claude/sessions/<pid>.json — the live session registry.
 *      Carries sessionId, cwd, kind (interactive|background), entrypoint (the surface),
 *      name and version. A file whose pid is dead is a finished session.
 *   2. ~/.claude/projects/<slug>/<sessionId>.jsonl — the transcript, appended as work happens.
 *      Carries every tool_use (name + input), tool_result (is_error), thinking, assistant text,
 *      isSidechain (subagents), hook errors and tool denials.
 *
 * Read-only: it never writes to ~/.claude and installs no hooks, so it adds zero latency to the
 * agents it watches. Binds to 127.0.0.1 only — transcripts contain your prompts.
 *
 * Usage:  node server.mjs [--port 7676] [--open] [--stale-minutes 30]
 */

import { createServer } from "node:http";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = join(homedir(), ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

/** Seed each transcript from its tail only — some are megabytes. */
const SEED_TAIL_BYTES = 256 * 1024;
const POLL_MS = 700;
/** Events kept per session in memory, and how many are shipped to the browser. */
const EVENT_BUFFER = 400;
const EVENTS_SENT = 70;
/** A non-delegation tool pending this long is probably sitting on a permission prompt. */
const PERMISSION_SUSPECT_MS = 25_000;
/** Agent/Task stay pending for the whole synchronous child run; that means delegation, not consent. */
const DELEGATION_TOOLS = new Set(["Agent", "Task"]);
/** This tool is itself proof that the turn is waiting for the user, so it needs no age heuristic. */
const EXPLICIT_USER_WAIT_TOOL = "AskUserQuestion";
/**
 * Sub-agents. Claude Code gives every sub-agent its own transcript at
 *   ~/.claude/projects/<slug>/<parentSessionId>/subagents/agent-<agentId>.jsonl
 * (workflow fan-outs nest one level deeper under `subagents/workflows/<wfId>/`), and the parent
 * session id is in the PATH — so a sub-agent links to its parent without any id matching.
 * Its records carry `isSidechain: true`, `agentId`, and `attributionAgent` (the agent type).
 */
const SUBAGENT_DIR = "subagents";
/**
 * LAST-RESORT liveness guess: a sub-agent whose transcript has not grown in this long, with no
 * tool in flight and no exact signal available, is treated as finished.
 *
 * 🔴 This was 8s and that was badly wrong. A sub-agent thinking at high effort writes NOTHING for
 * a long time, so an 8s window declared every thinking agent dead — measured live: a running
 * solver and three finished ones were STRUCTURALLY IDENTICAL in their transcripts (openTools 0,
 * same last record kind, same stop_reason); the only difference was write recency (5s vs 215-550s).
 * The visible symptom was exactly what the user reported: sub-agents blinking in and out.
 * The three exact signals below are consulted first; this number only covers what they miss.
 *
 * ⚠️ Measured 2026-09-07 over all 634 sub-agent transcripts on this machine: **127 of them (20%)
 * contain a silence longer than this**, so 180s decides nothing on its own — it is the tie-breaker
 * of last resort and the exact signals really do carry the weight.
 */
const SUBAGENT_IDLE_MS = 180_000;
/**
 * DEAD-MAN'S SWITCH on the "still running" signals — the fix for permanently stuck nodes.
 *
 * 🔴 The three "exact" running signals are only exact while the thing that emits them is ALIVE.
 * A workflow that is killed leaves `started` with no terminal record; an interrupted session
 * leaves its `Agent` tool_use forever pending; an agent killed mid-tool leaves its own tool_use
 * forever pending. Each of those used to pin a node to the graph for the rest of the session,
 * because they were consulted BEFORE any timeout and nothing downstream could overrule them.
 * Measured live 2026-09-07: one such node had been "running" for 237 minutes.
 *
 * So a running signal now expires. The number comes from measurement, not taste: across 634
 * transcripts the longest silence inside a genuinely working sub-agent was **14.9 minutes**
 * (p50 53s · p90 252s · p99 584s) and **zero** exceeded 15 minutes. 30 minutes clears the
 * observed maximum by 2× — wide enough that a real long think is never dropped, finite enough
 * that a killed agent leaves the graph.
 */
const RUNNING_SIGNAL_STALE_MS = 30 * 60_000;
/**
 * Hard cap so a session that fanned out to 100+ agents cannot stall a poll or bloat a frame.
 *
 * 🔴 Was 80, and that silently under-reported a real run: `wf_7138cdf4-a59` launched **111** agents,
 * so 31 of them existed only on disk — the graph, the counts and the model legend all acted as if
 * they were never there, with nothing on screen saying so. Raised to 240 (measured cost of the
 * per-poll work this guards: `statSync` + an incremental read of only the bytes that arrived, so
 * the cap protects the FRAME SIZE far more than the CPU) and, more importantly, truncation is now
 * REPORTED (`subTotals.truncated`) instead of being invisible. A cap you cannot see is a lie.
 */
const MAX_SUBAGENTS_TAILED = 240;
/** Finished sub-agents shipped to the browser (running ones are ALWAYS all shipped). */
const MAX_SUBAGENTS_SENT_DONE = 24;
/** Re-scan the subagents directory every Nth poll — readdir is the expensive part, not statSync. */
const SUBAGENT_RESCAN_EVERY = 3;
/**
 * Detail retained server-side per event and served on click, never pushed in the SSE frame.
 * Sized from measured reality: error texts are NOT truncated at source (median 323 chars, p90
 * 1298, max 7423), and Write's `content` input runs to 88KB — so blobs are reported by size and
 * previewed, never carried whole.
 */
const DETAIL_TEXT_MAX = 8000;
const BLOB_PREVIEW = 400;
/** An input string longer than this is a blob: size + preview instead of the whole value. */
const BLOB_THRESHOLD = 600;
/** Summary shown inline on a tool chip without a click. */
const CHIP_TEXT_MAX = 600;

// ---------------------------------------------------------------------------
// args

function parseArgs(argv) {
  const out = {
    port: 7676,
    open: false,
    staleMinutes: 30,
    help: false,
    /*
     * OFF by default, and that default is a decision, not an oversight: with the flag the server
     * reads the OAuth bearer out of `~/.claude/.credentials.json` and calls Anthropic. Everything
     * else this tool does is local, read-only and credential-free, so turning that on has to be an
     * explicit act by the person running it. See the "Source 1" block.
     */
    liveUsage: false,
    /*
     * 60 → 120 (2026-09-08 รอบสอง). ที่ 60 วิ เปิดค้าง 3.5 ชม. = ~210 ครั้ง แล้วโดน 429 ค้างยาว.
     * เลข session เดินช้ากว่านั้นมาก — 1% ของหน้าต่าง 5 ชม. ≈ 3 นาที ⇒ 120 วิ ยังจับได้ทุกขั้น 1%
     * โดยยิงน้อยลงครึ่งหนึ่ง (ถ้ายังโดนปฏิเสธอีก บันไดถอยข้างล่างจะขยายให้เอง)
     */
    liveUsageSeconds: 120,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" || arg === "-p") out.port = Number(argv[++i]) || out.port;
    else if (arg === "--open" || arg === "-o") out.open = true;
    else if (arg === "--stale-minutes") out.staleMinutes = Number(argv[++i]) || out.staleMinutes;
    else if (arg === "--live-usage") out.liveUsage = true;
    else if (arg === "--live-usage-seconds") {
      // Floor it at 15s — this is someone else's API and a dashboard left open all day would
      // otherwise hammer it for a number that moves in minutes.
      out.liveUsageSeconds = Math.max(15, Number(argv[++i]) || out.liveUsageSeconds);
      out.liveUsage = true;
    } else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help) {
  process.stdout.write(
    [
      "Agent Activity Dashboard",
      "",
      "  node server.mjs [options]",
      "",
      "  --port, -p <n>         port to listen on (default 7676)",
      "  --open, -o             open the dashboard in your browser",
      "  --stale-minutes <n>    keep a finished session on screen this long (default 30)",
      "",
      "  --live-usage           fetch the REAL session/weekly % from Anthropic instead of the",
      "                         stale ~/.claude.json cache. Reads the OAuth token from",
      "                         ~/.claude/.credentials.json (read-only, never logged, never",
      "                         refreshed) and calls GET /api/oauth/usage. Off by default.",
      "  --live-usage-seconds <n>  how often to refresh it (default 120, minimum 15). Implies",
      "                         --live-usage. A rejected call backs off on its own (1→15 min) and",
      "                         the last good percentage stays on screen while it does.",
      "",
      "  Without --live-usage the bar still shows the live 5-hour WINDOW (when it opened, when it",
      "  resets, tokens spent in it) read straight from the transcripts — that part needs no",
      "  credential. Only Anthropic's official percentage needs the flag.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// session roster — every surface registers here

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return err.code === "EPERM";
  }
}

function readRoster() {
  let files = [];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const file of files) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf8"));
    } catch {
      continue;
    }
    if (!meta || !meta.sessionId || !meta.pid) continue;
    rows.push({
      pid: meta.pid,
      sessionId: meta.sessionId,
      cwd: meta.cwd || "",
      startedAt: meta.startedAt || null,
      version: meta.version || "",
      kind: meta.kind || "interactive",
      entrypoint: meta.entrypoint || "unknown",
      name: meta.name || `pid ${meta.pid}`,
      alive: isPidAlive(meta.pid),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// plan usage — the session (5-hour) and weekly limits
//
// 🔴 REWRITTEN 2026-09-08 because the old single-source version showed a number that was simply
// WRONG, for hours at a time. What was measured that morning, side by side:
//
//     ~/.claude.json cache  →  session 0%,  resets_at null   ("no 5-hour window open")
//     GET /api/oauth/usage  →  session 7%,  resets_at 07:50Z ( a window IS open )
//
// The cache's `fetchedAtMs` had not moved in 45+ minutes of continuous heavy use (watched live at
// 2s intervals). It is written when Claude Code *starts* or refreshes its OAuth token — NOT per
// request — and there is no `claude usage` subcommand to poke it. So during any long session the
// bar sat at a confident `0%` while the real window filled up. Showing the age next to it was not
// enough: people read the meter, not the footnote.
//
// There are now THREE sources, in descending order of authority:
//
//   1. `--live-usage` → `GET https://api.anthropic.com/api/oauth/usage` with the OAuth bearer from
//      `~/.claude/.credentials.json`. This is exactly what `/usage` shows, refreshed on OUR clock.
//      OFF BY DEFAULT and opt-in on purpose: it makes the dashboard a thing that reads a
//      credential and makes an authenticated outbound call, which the original build deliberately
//      refused to be. Enabled by explicit user decision 2026-09-08. The file is opened read-only,
//      the token is never logged, never put in a snapshot, and never refreshed/rewritten by us —
//      an expired token is reported as expired and Claude Code is left to renew it.
//   2. The live 5-hour WINDOW derived from the transcripts this dashboard already reads. No
//      credential, no network, recomputed every scan: when the window opened, when it resets, and
//      how many tokens actually went into it. It cannot produce Anthropic's official percentage
//      (the weighting is not public) but everything it does report is true *now*.
//   3. `~/.claude.json` → `cachedUsageUtilization` — the old source, kept as the fallback for the
//      percentage. It is now allowed to say "I don't know": when the cache predates the current
//      window its session percentage describes a window that has already ended, so it is
//      suppressed rather than drawn as a meter.

const CLAUDE_JSON = join(homedir(), ".claude.json");
const CREDENTIALS_JSON = join(CLAUDE_DIR, ".credentials.json");

/** The plan's session window. Fixed by the plan, not by us — used to chain windows and to date them. */
const SESSION_WINDOW_MS = 5 * 60 * 60_000;

/**
 * Normalise one `/api/oauth/usage` body (the cache stores the same object under `utilization`).
 *
 * `limits[]` is the normalised view and the one to read: each entry carries `kind`
 * (session | weekly_all | weekly_scoped), `percent`, `severity`, `resets_at`, `is_active` and,
 * for the scoped one, which model it applies to. The older `five_hour` / `seven_day` objects say
 * the same thing in a shape that has already changed once, so they are only a fallback.
 * `accountUuid` and everything under `oauthAccount` are NOT read — the viewer has no use for
 * identity, and this function is the only thing that ever touches the response body.
 */
function normaliseUtilization(u) {
  if (!u || typeof u !== "object") return null;
  const rows = (Array.isArray(u.limits) ? u.limits : [])
    .filter((l) => l && typeof l.percent === "number")
    .map((l) => ({
      kind: String(l.kind || ""),
      group: String(l.group || ""),
      percent: l.percent,
      severity: String(l.severity || "normal"),
      resetsAt: l.resets_at || null,
      isActive: l.is_active !== false,
      scope: (l.scope && l.scope.model && l.scope.model.display_name) || "",
    }));
  if (!rows.length) {
    for (const [kind, src] of [["session", u.five_hour], ["weekly_all", u.seven_day]]) {
      if (src && typeof src.utilization === "number") {
        rows.push({
          kind,
          group: kind === "session" ? "session" : "weekly",
          percent: src.utilization,
          severity: "normal",
          resetsAt: src.resets_at || null,
          isActive: true,
          scope: "",
        });
      }
    }
  }
  if (!rows.length) return null;
  const extra = u.extra_usage || null;
  return {
    limits: rows,
    extraUsage: extra
      ? {
          enabled: Boolean(extra.is_enabled),
          utilization: extra.utilization,
          spendLimitReached: Boolean(extra.spend_limit_reached),
        }
      : null,
  };
}

let usageCache = { mtimeMs: -1, value: null };

/** Source 3 — the cache Claude Code parks in `~/.claude.json`. Keyed on mtime so it is re-parsed
 *  only when the (78KB, constantly rewritten) file actually changes. */
function readCachedUsage() {
  let stat;
  try {
    stat = statSync(CLAUDE_JSON);
  } catch {
    return null;
  }
  if (usageCache.mtimeMs === stat.mtimeMs) return usageCache.value;

  let value = null;
  try {
    const cached = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")).cachedUsageUtilization;
    const norm = cached && normaliseUtilization(cached.utilization);
    if (norm) value = { fetchedAtMs: cached.fetchedAtMs || null, ...norm };
  } catch {
    value = null;
  }
  usageCache = { mtimeMs: stat.mtimeMs, value };
  return value;
}

// ---------------------------------------------------------------------------
// Source 2 — the live 5-hour window, read off the transcripts
//
// Every assistant record carries `timestamp` + `message.usage`, so the set of requests inside the
// current window is directly observable, with no credential and no network. This scanner is
// deliberately separate from `pumpTail`: the window spans EVERY session on the machine, including
// ones that have already finished and are no longer on screen, and it needs only four numbers per
// record — so it keeps its own byte offsets and its own tiny record list rather than paying for
// the full event/tool/error parse.

/** How far back to keep records. Longer than one window so consecutive windows can be chained. */
const USAGE_LOOKBACK_MS = 13 * 60 * 60_000;
/** Rescan cadence. Fast enough to feel live, slow enough not to walk the tree every broadcast. */
const USAGE_SCAN_MS = 2_500;
/** First sight of a file: read at most this much of its tail. Records older than the lookback are
 *  dropped anyway, so this only has to cover ~13h of one session's writes. */
const USAGE_SEED_BYTES = 24 * 1024 * 1024;

/** absolute path -> byte offset already ingested */
const usageOffsets = new Map();
/** {t, input, cacheCreate, cacheRead, output, model} for the whole machine, within the lookback */
let usageRecords = [];
let lastUsageScanMs = 0;

/** Collect every transcript under `~/.claude/projects` touched inside the lookback. */
function listRecentTranscripts(nowMs) {
  const cutoff = nowMs - USAGE_LOOKBACK_MS;
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      out.push({ path, size: stat.size });
    }
  };
  walk(PROJECTS_DIR, 0);
  return out;
}

/** Ingest the bytes appended to every recent transcript since the last scan. */
function refreshUsageLedger(nowMs) {
  if (nowMs - lastUsageScanMs < USAGE_SCAN_MS) return;
  lastUsageScanMs = nowMs;

  const seen = new Set();
  for (const { path, size } of listRecentTranscripts(nowMs)) {
    seen.add(path);
    let from = usageOffsets.get(path);
    /*
     * `seeded` = we are seeking into the middle of the file rather than resuming from a known line
     * boundary, so its first line is the tail of a record we never saw and must be dropped. A
     * resumed read starts exactly after a newline, where the first line IS complete — conflating
     * the two silently loses one request per scan.
     */
    let seeded = false;
    if (from == null) {
      from = Math.max(0, size - USAGE_SEED_BYTES);
      seeded = from > 0;
    } else if (size < from) {
      // Rotated or rewritten shorter than where we were — start over from its tail.
      from = Math.max(0, size - USAGE_SEED_BYTES);
      seeded = from > 0;
    }
    if (size <= from) {
      usageOffsets.set(path, size);
      continue;
    }

    let buf;
    try {
      const fd = openSync(path, "r");
      try {
        const want = size - from;
        buf = Buffer.allocUnsafe(want);
        const read = readSync(fd, buf, 0, want, from);
        buf = buf.subarray(0, read);
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }

    // Only whole lines can be parsed; leave any trailing partial record for the next scan.
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) continue;
    const text = buf.subarray(0, lastNl).toString("utf8");
    usageOffsets.set(path, from + lastNl + 1);

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (i === 0 && seeded) continue; // fragment of a record that began before our seek
      // Cheap reject before JSON.parse — most records carry no usage at all.
      if (line.indexOf('"usage"') === -1) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = rec && rec.message && rec.message.usage;
      if (!usage || typeof usage !== "object") continue;
      const t = Date.parse(rec.timestamp || "");
      if (!isFinite(t)) continue;
      usageRecords.push({
        t,
        input: usage.input_tokens || 0,
        cacheCreate: usage.cache_creation_input_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        output: usage.output_tokens || 0,
        thinking: (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0,
        model: (rec.message && rec.message.model) || "",
      });
    }
  }

  // Forget files that fell out of the lookback so the offset map cannot grow forever.
  for (const path of usageOffsets.keys()) if (!seen.has(path)) usageOffsets.delete(path);

  const cutoff = nowMs - USAGE_LOOKBACK_MS;
  if (usageRecords.some((r) => r.t < cutoff)) usageRecords = usageRecords.filter((r) => r.t >= cutoff);
  usageRecords.sort((a, b) => a.t - b.t);
}

/**
 * Where the current 5-hour window starts.
 *
 * `resetsAtMs`, when a source gives us one, is authoritative and exact — the window is simply
 * `[reset - 5h, reset)`. Without it the boundary is chained off the transcripts: the first request
 * opens a window, and the first request at least 5h later opens the next one. That estimate lands
 * within a few minutes of the real thing (measured 2026-09-08: chained 02:55Z vs the API's exact
 * 02:50Z) because the account's clock starts on a request we can see — which is why it is flagged
 * `exact: false` and never presented as the official boundary.
 */
function computeSessionWindow(nowMs, resetsAtMs) {
  refreshUsageLedger(nowMs);

  if (resetsAtMs && isFinite(resetsAtMs) && resetsAtMs > nowMs) {
    const startedAtMs = resetsAtMs - SESSION_WINDOW_MS;
    return summariseWindow(startedAtMs, resetsAtMs, true, nowMs);
  }
  if (!usageRecords.length) return null;

  let start = usageRecords[0].t;
  for (const rec of usageRecords) if (rec.t - start >= SESSION_WINDOW_MS) start = rec.t;
  // The last window ran out and nothing has been sent since — there is no open window to report.
  if (nowMs - start >= SESSION_WINDOW_MS) return null;
  return summariseWindow(start, start + SESSION_WINDOW_MS, false, nowMs);
}

function summariseWindow(startedAtMs, resetsAtMs, exact, nowMs) {
  const tokens = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, thinking: 0, requests: 0 };
  const byModel = new Map();
  for (const rec of usageRecords) {
    if (rec.t < startedAtMs || rec.t >= resetsAtMs) continue;
    tokens.input += rec.input;
    tokens.cacheCreate += rec.cacheCreate;
    tokens.cacheRead += rec.cacheRead;
    tokens.output += rec.output;
    tokens.thinking += rec.thinking;
    tokens.requests++;
    /*
     * Split by model because the plan does not price them alike — the same token count against
     * Opus and against Haiku are not the same fraction of the window. Cache READS are left out of
     * this figure on purpose: they dominate the raw total (30M+ of a 33M session) and would drown
     * the part that actually reflects new work.
     */
    const key = rec.model || "unknown";
    byModel.set(key, (byModel.get(key) || 0) + rec.input + rec.cacheCreate + rec.output);
  }
  return {
    startedAtMs,
    resetsAtMs,
    exact,
    elapsedMs: Math.max(0, nowMs - startedAtMs),
    remainingMs: Math.max(0, resetsAtMs - nowMs),
    tokens,
    byModel: [...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([model, billed]) => ({ model, billed })),
  };
}

// ---------------------------------------------------------------------------
// Source 1 — the live percentage, opt-in behind `--live-usage`
//
// This is the only part of the dashboard that reads a credential or talks to the network, and it
// stays inert unless the flag is passed. What it does NOT do matters as much as what it does: it
// never writes `.credentials.json`, never refreshes the OAuth token (an expired one is reported,
// not renewed — Claude Code owns that), never logs or ships the token, and drops the response
// through `normaliseUtilization` so nothing but the percentages can reach a snapshot.

const LIVE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const LIVE_USAGE_BETA = "oauth-2025-04-20";

/*
 * 🔴 แก้ 2026-09-08 (รอบสอง) — "แถบ session กลายเป็น *ยังไม่รู้ %* บ่อยมาก" (ผู้ใช้แจ้งเอง)
 *
 * วัดของจริงตอนนั้น: server เปิดค้างไว้ 3.5 ชม. ด้วย `--live-usage` (ยิงทุก 60 วิ ≈ 210 ครั้ง) แล้ว
 * `GET /api/oauth/usage` ตอบ **429 rate_limit_error** ค้างยาว. สิ่งที่เกิดต่อคือบั๊กจริง ๆ ของรอบก่อน:
 *
 *   - `pollLiveUsage` **ตั้งใจ** เก็บ % ของรอบที่สำเร็จล่าสุดไว้ (คอมเมนต์เดิมเขียนว่า "Keep the last
 *     good percentages on screen") — แต่ `buildPlanUsage` เช็ค `liveUsage.ok` ⇒ **ยิงพลาดครั้งเดียว
 *     ก็ทิ้งเลขดี ๆ ทันที** แล้วถอยไปใช้ cache `~/.claude.json`
 *   - cache นั้น "อ่านไว้ตอน Claude Code สตาร์ต" ⇒ เกือบตลอดเวลา **เก่ากว่าเวลาเปิดหน้าต่างปัจจุบัน**
 *     ⇒ `sessionKnown=false` ⇒ ไม่วาดมิเตอร์ ⇒ "ยังไม่รู้ %"
 *   - ไม่มี backoff เลย ⇒ โดน 429 แล้วก็ยังยิงถี่เท่าเดิม ⇒ ค้าง 429 ต่อไปเรื่อย ๆ
 *
 * สรุปเป็นเหตุ→ผล: **เน็ตสะดุดครั้งเดียว = ตัวเลขหายทั้งแถบ** ทั้งที่เพิ่งอ่านมาได้เมื่อนาทีที่แล้ว
 * และมันพูดถึงหน้าต่างเดียวกันเป๊ะ ๆ
 *
 * รอบนี้จึงแยก "ผลของการยิงครั้งล่าสุด" (`ok`/`error`) ออกจาก "ข้อมูลดีชุดล่าสุดที่มี"
 * (`fetchedAtMs`/`limits`/`extraUsage`) — อย่างหลังอยู่ยาวจนกว่าจะมีชุดใหม่มาทับ
 */
let liveUsage = {
  // ผลของ "การยิงครั้งล่าสุด"
  ok: false,
  error: null,
  lastTryMs: null,
  failures: 0,
  nextTryMs: 0,
  // ข้อมูล "ชุดดีล่าสุด" — อยู่รอดข้ามการยิงที่ล้มเหลว โดยตั้งใจ
  fetchedAtMs: null,
  limits: null,
  extraUsage: null,
};
let liveUsageInFlight = false;

/*
 * บันไดถอยเวลาโดนปฏิเสธ. `/api/oauth/usage` เป็น API ของคนอื่นและไม่มีเอกสารบอกโควตา — ที่วัดได้คือ
 * ยิงทุก 60 วิ ติดกัน 3.5 ชม. แล้วโดน 429 (`retry-after: 0` ซึ่งไม่ได้บอกอะไร) ⇒ เดาไม่ได้ ก็ถอยเอา
 */
const LIVE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000];
/*
 * ...แต่ถอยได้ไม่สุดบันไดเมื่อ "ยังไม่มีเลขของหน้าต่างที่เปิดอยู่เลย" — นั่นคือช่วงเดียวที่แถบต้องเขียนว่า
 * ยังไม่รู้ % จริง ๆ ⇒ ช่วงนั้นเรายอมยิงถี่กว่าปกติเพื่อให้หลุดสถานะนั้นเร็วที่สุด (เกิดแค่ 1 ครั้ง/5 ชม.)
 */
const LIVE_BACKOFF_HUNGRY_MS = 120_000;
/** ตั้งโดย `buildPlanUsage` = "ตอนนี้ยังไม่มี % ของหน้าต่างที่เปิดอยู่" */
let liveHungry = false;
/** เวลาเปิดหน้าต่างที่เห็นล่าสุด — ใช้จับจังหวะ "หน้าต่างใหม่เปิดแล้ว" เพื่อรีเซ็ตบันไดถอย */
let liveWindowSeenMs = null;

/** Read just the OAuth bearer. Returns null (never throws, never logs) when it is missing or expired. */
function readOAuthToken() {
  try {
    const oauth = JSON.parse(readFileSync(CREDENTIALS_JSON, "utf8")).claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return { token: null, reason: "ไม่พบ OAuth token" };
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) {
      return { token: null, reason: "token หมดอายุ — Claude Code จะต่ออายุให้เองเมื่อใช้งานครั้งถัดไป" };
    }
    return { token: oauth.accessToken, reason: null };
  } catch {
    return { token: null, reason: "อ่าน ~/.claude/.credentials.json ไม่ได้" };
  }
}

/**
 * บันทึกว่าการยิงรอบนี้ล้มเหลว **โดยไม่แตะข้อมูลชุดดีล่าสุด** แล้วเลื่อนรอบถัดไปตามบันไดถอย
 * `retryAfterMs` มาจาก header `Retry-After` ถ้าเซิร์ฟเวอร์บอกมา (429 มักบอก) — เคารพมันก่อนเสมอ
 */
function noteLiveFailure(reason, startedMs, retryAfterMs) {
  const failures = liveUsage.failures + 1;
  const ladder = LIVE_BACKOFF_MS[Math.min(failures - 1, LIVE_BACKOFF_MS.length - 1)];
  const capped = liveHungry ? Math.min(ladder, LIVE_BACKOFF_HUNGRY_MS) : ladder;
  const wait = Math.max(capped, retryAfterMs || 0, ARGS.liveUsageSeconds * 1000);
  liveUsage = { ...liveUsage, ok: false, error: reason, lastTryMs: startedMs, failures, nextTryMs: startedMs + wait };
}

/** `Retry-After` มาได้ 2 แบบ: จำนวนวินาที หรือวันที่แบบ HTTP. คืน ms เสมอ (0 = ไม่ได้บอก) */
function parseRetryAfter(res) {
  const raw = res.headers.get("retry-after");
  if (!raw) return 0;
  const secs = Number(raw);
  if (isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

async function pollLiveUsage(force = false) {
  if (liveUsageInFlight) return;
  const startedMs = Date.now();
  // บันไดถอยคุมจังหวะจริง ๆ ตรงนี้ — ตัวตั้งเวลาข้างล่างแค่มาเคาะถี่ ๆ แล้วให้บรรทัดนี้ตัดสิน
  if (!force && startedMs < liveUsage.nextTryMs) return;
  liveUsageInFlight = true;
  try {
    const { token, reason } = readOAuthToken();
    if (!token) {
      noteLiveFailure(reason, startedMs, 0);
      return;
    }
    const res = await fetch(LIVE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": LIVE_USAGE_BETA,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      // ข้อมูลชุดดีล่าสุดยังอยู่บนจอ (`buildPlanUsage` ใช้ต่อได้) · UI บอกสาเหตุ + เวลาที่จะลองใหม่
      noteLiveFailure(`API ตอบ ${res.status}`, startedMs, parseRetryAfter(res));
      return;
    }
    const norm = normaliseUtilization(await res.json());
    if (!norm) {
      noteLiveFailure("API ตอบมาในรูปแบบที่อ่านไม่ออก", startedMs, 0);
      return;
    }
    const at = Date.now();
    liveUsage = {
      ok: true,
      error: null,
      lastTryMs: startedMs,
      failures: 0,
      nextTryMs: at + ARGS.liveUsageSeconds * 1000,
      fetchedAtMs: at,
      ...norm,
    };
  } catch (err) {
    noteLiveFailure(`ยิง API ไม่สำเร็จ: ${err.message}`, startedMs, 0);
  } finally {
    liveUsageInFlight = false;
  }
}

/** โทเค็นรวมทุกชั้นในหน้าต่าง — ตัวเดียวกับที่แถว "หน้าต่างนี้" แสดง จึงเทียบกันได้ตรง ๆ */
function windowTotalTokens(win) {
  const t = win.tokens;
  return (t.input || 0) + (t.cacheCreate || 0) + (t.cacheRead || 0) + (t.output || 0);
}

/** โทเค็นทุกชั้นที่เกิดในช่วง `[fromMs, toMs)` — ใช้ย้อนดูว่า ณ ตอนที่อ่าน % ได้ เผาไปเท่าไรแล้ว */
function sumTokensBetween(fromMs, toMs) {
  let total = 0;
  for (const rec of usageRecords) {
    if (rec.t < fromMs || rec.t >= toMs) continue;
    total += rec.input + rec.cacheCreate + rec.cacheRead + rec.output;
  }
  return total;
}

/*
 * ตัวคูณที่ "เรียน" จากของจริง: session % ต่อ 1 โทเค็นในหน้าต่าง
 *
 * สูตรถ่วงน้ำหนักของแพลนไม่เปิดเผย (opus/sonnet/haiku ไม่เท่ากัน · cache read ถูกลด) — เดาเองไม่ได้
 * แต่**หารเอาได้**: ทุกครั้งที่อ่าน % จริงมาสำเร็จ เรารู้ทั้ง % และจำนวนโทเค็นในหน้าต่างเดียวกัน
 * ⇒ `% ÷ โทเค็น` คือค่าเฉลี่ยของหน้าต่างนั้น. เก็บไว้เพื่อ **ประมาณ** % ตอนที่เลขทางการยังมาไม่ถึง
 * (ช่วงต้นหน้าต่างใหม่ที่ยังยิง API ไม่ผ่าน) — และมันถูกแสดงเป็น `≈` เสมอ ไม่ปนกับเลขจริง
 */
let percentPerToken = null;
let percentPerTokenAtMs = null;
/** ตัวคูณตอนนี้ยังเป็นค่าตั้งต้นจาก cache อยู่ไหม — ค่าจริงตัวแรกที่อ่านได้จะ**ทับทิ้ง** ไม่ใช่เฉลี่ยด้วย */
let percentPerTokenIsSeed = false;

/**
 * ตั้งต้นตัวคูณโดยไม่ต้องยิงเน็ตเลย — สำคัญกับกรณี "สตาร์ต server ขึ้นมาตอนที่โดน 429 อยู่พอดี"
 * ซึ่งเป็นช่องเดียวที่เหลืออยู่ของอาการ "ยังไม่รู้ %"
 *
 * cache ใน `~/.claude.json` บอกทั้ง % และ **เวลาที่อ่านค่านั้น** ⇒ ย้อนไปนับได้ว่า ณ วินาทีนั้น
 * หน้าต่างของมันเผาไปกี่โทเค็นแล้ว ⇒ ได้ `% ÷ โทเค็น` เหมือนกัน แม้จะเป็นหน้าต่างที่จบไปแล้วก็ตาม
 * (เราเอาไปใช้แค่เป็น *อัตรา* ไม่ได้เอา % ของมันมาโชว์ ซึ่งคือสิ่งที่รอบก่อนแก้ไปแล้ว)
 *
 * เงื่อนไขคุมความมั่ว: ต้องมี `resets_at` (ไม่งั้นไม่รู้ขอบหน้าต่าง) · % ต้องไม่ใช่เศษเสี้ยว ·
 * และ ledger ต้องครอบคลุมถึงก่อนหน้าต่างนั้นเปิดจริง ๆ ไม่งั้นยอดโทเค็นจะขาดแล้วอัตราจะพุ่งเกินจริง
 */
function seedPercentPerTokenFromCache(cache, nowMs) {
  if (percentPerToken != null || !cache || !cache.fetchedAtMs) return;
  const row = cache.limits.find((l) => l.kind === "session");
  const resetMs = row && row.resetsAt ? Date.parse(row.resetsAt) : NaN;
  if (!row || !(row.percent >= 3) || !isFinite(resetMs)) return;
  const startedMs = resetMs - SESSION_WINDOW_MS;
  if (cache.fetchedAtMs < startedMs || cache.fetchedAtMs > resetMs) return;
  // ledger ย้อนหลัง 13 ชม. และตอนสตาร์ตมันอ่านแค่ท้ายไฟล์ — ถ้าแถวเก่าสุดยังไม่ถึงต้นหน้าต่างนั้น
  // แปลว่ายอดโทเค็นไม่ครบ ⇒ อัตราจะสูงเกินจริง ⇒ ไม่ตั้งต้นดีกว่าตั้งผิด
  if (!usageRecords.length || usageRecords[0].t > startedMs) return;
  const spent = sumTokensBetween(startedMs, cache.fetchedAtMs);
  if (spent <= 0) return;
  percentPerToken = row.percent / spent;
  percentPerTokenAtMs = cache.fetchedAtMs;
  percentPerTokenIsSeed = true;
}

/**
 * Assemble what the browser gets. The percentage comes from the best source that has one, the
 * window always comes from the transcripts, and `sessionKnown` is the flag that stops the bar
 * drawing a meter for a window the percentage does not describe.
 */
function buildPlanUsage(nowMs) {
  const cache = readCachedUsage();
  /*
   * 🔴 หัวใจของการแก้รอบสอง: เงื่อนไขคือ "**มี**ข้อมูลชุดดีไหม" ไม่ใช่ "การยิง**ครั้งล่าสุด**ผ่านไหม"
   * เลขที่อ่านมาได้เมื่อ 2 นาทีที่แล้วยังพูดถึงหน้าต่างเดียวกันอยู่ — 429 รอบล่าสุดไม่ได้ทำให้มันผิด
   */
  const live = ARGS.liveUsage && liveUsage.limits ? liveUsage : null;
  /*
   * เลือกจาก "ชุดไหนใหม่กว่า" ไม่ใช่ "ชุดไหนมาจากแหล่งดีกว่า" — ปกติ live ชนะขาด แต่ถ้า live ค้างมานาน
   * แล้ว Claude Code เพิ่งรีสตาร์ต (เขียน cache ใหม่) cache ก็ควรได้พูดแทน
   */
  const best = live && cache ? (live.fetchedAtMs >= (cache.fetchedAtMs || 0) ? live : cache) : live || cache;

  const sessionRow = best && best.limits.find((l) => l.kind === "session");
  const resetsAtMs = sessionRow && sessionRow.resetsAt ? Date.parse(sessionRow.resetsAt) : NaN;
  const window = computeSessionWindow(nowMs, isFinite(resetsAtMs) ? resetsAtMs : null);

  /*
   * Does the percentage actually describe the window that is open right now? A reading taken
   * before this window opened describes the previous one, and the previous one is over. This is
   * the exact case that made the bar read `0%` for hours, so it is answered explicitly instead of
   * being left to a "how old is it" footnote nobody reads.
   */
  const fetchedAtMs = best ? best.fetchedAtMs : null;
  const sessionKnown = Boolean(
    best && (!window || (fetchedAtMs != null && fetchedAtMs >= window.startedAtMs)),
  );

  /*
   * หน้าต่างใหม่เปิด = เลขที่มีกลายเป็นของหน้าต่างที่จบไปแล้วในพริบตา ⇒ รีเซ็ตบันไดถอยแล้วยิงใหม่ทันที
   * (เผื่อขอบหน้าต่างขยับเล็กน้อยตอนสลับ exact ↔ ประมาณ จึงยอมให้คลาดกันได้ 1 นาทีโดยไม่นับว่าใหม่)
   */
  if (window && (liveWindowSeenMs == null || Math.abs(window.startedAtMs - liveWindowSeenMs) > 60_000)) {
    liveWindowSeenMs = window.startedAtMs;
    liveUsage.failures = 0;
    liveUsage.nextTryMs = 0;
  }
  liveHungry = Boolean(window) && !sessionKnown;

  /*
   * เรียนตัวคูณเฉพาะตอนที่เลขยัง "ร้อน" (อ่านมาไม่เกิน 20 วิ) — ถ้าปล่อยให้เก่ากว่านั้น โทเค็นฝั่งเรา
   * เดินต่อไปแล้วแต่ % ยังเป็นของเมื่อครู่ ⇒ ตัวคูณจะต่ำกว่าความจริง. และข้าม % ต่ำ ๆ ที่ยังเป็นสัญญาณรบกวน
   */
  if (sessionKnown && window && sessionRow && sessionRow.percent >= 3 && nowMs - fetchedAtMs < 20_000) {
    const total = windowTotalTokens(window);
    if (total > 0) {
      const ratio = sessionRow.percent / total;
      // ค่าเฉลี่ยเคลื่อนที่ — กันไม่ให้ตัวคูณกระโดดตามการอ่านครั้งเดียว · แต่ถ้าของเดิมเป็นแค่ค่า
      // ตั้งต้นจาก cache ให้ **ทับทิ้ง** ไปเลย ไม่ต้องลากค่าที่เดามาถ่วง
      percentPerToken =
        percentPerToken == null || percentPerTokenIsSeed ? ratio : percentPerToken * 0.7 + ratio * 0.3;
      percentPerTokenAtMs = nowMs;
      percentPerTokenIsSeed = false;
    }
  } else {
    seedPercentPerTokenFromCache(cache, nowMs);
  }

  /*
   * ทางออกสุดท้ายเมื่อไม่มีเลขทางการของหน้าต่างนี้จริง ๆ — ประมาณจากโทเค็นที่เผาไปคูณตัวคูณที่เรียนมา
   * **ไม่ใช่การกลับไปทำผิดแบบเดิม**: ของเดิมวาดมิเตอร์จากเลขของหน้าต่างที่จบไปแล้วโดยไม่บอกใคร
   * อันนี้พูดถึงหน้าต่างที่เปิดอยู่ ติดป้าย `≈` และหน้าตาของมิเตอร์ต่างจากของจริงชัดเจน
   */
  let sessionEstimate = null;
  if (!sessionKnown && window && percentPerToken != null) {
    const est = percentPerToken * windowTotalTokens(window);
    sessionEstimate = {
      percent: Math.max(0, Math.min(100, Math.round(est))),
      calibratedAtMs: percentPerTokenAtMs,
      // ตัวคูณมาจาก cache (ยังไม่เคยอ่านค่าจริงได้เลย) ⇒ หยาบกว่า และ UI ควรพูดให้ต่างกัน
      seeded: percentPerTokenIsSeed,
    };
  }

  return {
    v: 2,
    source: best ? (best === live ? "live" : "cache") : null,
    fetchedAtMs,
    limits: best ? best.limits : [],
    extraUsage: best ? best.extraUsage : null,
    sessionKnown,
    sessionEstimate,
    window,
    cache: cache ? { fetchedAtMs: cache.fetchedAtMs } : null,
    live: {
      enabled: Boolean(ARGS.liveUsage),
      ok: Boolean(ARGS.liveUsage && liveUsage.ok),
      error: ARGS.liveUsage ? liveUsage.error : null,
      lastTryMs: ARGS.liveUsage ? liveUsage.lastTryMs : null,
      // "อ่านสำเร็จครั้งล่าสุดเมื่อไร" กับ "จะลองใหม่เมื่อไร" — UI ต้องพูดสองอย่างนี้ตอนยิงไม่ผ่าน
      lastOkMs: ARGS.liveUsage ? liveUsage.fetchedAtMs : null,
      nextTryMs: ARGS.liveUsage ? liveUsage.nextTryMs : null,
    },
  };
}

// ---------------------------------------------------------------------------
// transcript location

const transcriptPaths = new Map(); // sessionId -> absolute path

function findTranscript(sessionId) {
  const cached = transcriptPaths.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  let dirs = [];
  try {
    dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      transcriptPaths.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// sub-agent transcripts

const subagentScans = new Map(); // parentSessionId -> { tick, files }
const subagentMetas = new Map(); // meta path -> parsed sidecar (written once, never changes)
let pollTick = 0;

/**
 * A Workflow writes journal.jsonl beside its agents: one `{type:"started", agentId}` when an agent
 * launches and one TERMINAL record when it stops. That terminal record is the only exact signal
 * available for workflow fan-outs, whose sidecars carry nothing but {agentType, spawnDepth}.
 *
 * 🔴 THERE IS MORE THAN ONE TERMINAL TYPE, and assuming otherwise was the stuck-node bug.
 * This used to collect `started` and `result` and nothing else. Measured across all 24 journals on
 * this machine 2026-09-07: `started` 541 · `result` 357 · **`failed` 170**. A `failed` agent
 * therefore sat in `started` with nothing to clear it, so "started without result" read as
 * "still running" — for **170 of 541 workflow agents (31%)**, forever, since the check ran before
 * any timeout. One workflow (`wf_7138cdf4-a59`) failed 80 of its 111 agents; another failed 21 of
 * 21 — every node that run ever drew stayed on the graph for the life of the session.
 *
 * Hence: `started` is the ONLY non-terminal type, and every other type ends the agent. Recording
 * the type (not just the fact) both fixes the bug and future-proofs it — a `cancelled` or `killed`
 * type the harness adds later terminates correctly with no code change, and the panel can say
 * WHICH way the agent ended instead of silently dropping it.
 */
const journalCache = new Map(); // journal path -> { mtimeMs, started:Set, terminal:Map<agentId,type> }

function readWorkflowJournal(dir) {
  const path = join(dir, "journal.jsonl");
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  const cached = journalCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const started = new Set();
  const terminal = new Map();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || !rec.agentId) continue;
      // `started` is the only type that does NOT end an agent — see the comment above. Anything
      // else (`result`, `failed`, or a type added later) is terminal, and its name is kept.
      if (rec.type === "started") started.add(rec.agentId);
      else if (rec.type) terminal.set(rec.agentId, String(rec.type));
    }
  } catch {
    return null;
  }
  const entry = { mtimeMs: stat.mtimeMs, started, terminal };
  journalCache.set(path, entry);
  return entry;
}

function readSubagentMeta(path) {
  if (subagentMetas.has(path)) return subagentMetas.get(path);
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    meta = null;
  }
  // Only cache a successful read — the sidecar can lag the transcript by a moment.
  if (meta) subagentMetas.set(path, meta);
  return meta;
}

/** Every agent-*.jsonl under a parent session's subagents/ tree, newest first. */
function listSubagentFiles(parentTranscriptPath, sessionId) {
  const cached = subagentScans.get(sessionId);
  if (cached && pollTick - cached.tick < SUBAGENT_RESCAN_EVERY) return cached.files;

  const root = join(dirname(parentTranscriptPath), sessionId, SUBAGENT_DIR);
  const found = [];
  const walk = (dir, workflowId) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // subagents/workflows/<wfId>/agent-*.jsonl
        walk(full, entry.name.startsWith("wf_") ? entry.name : workflowId);
        continue;
      }
      if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl")) continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const agentId = entry.name.slice("agent-".length, -".jsonl".length);
      found.push({
        path: full,
        agentId,
        dir,
        workflowId: workflowId || null,
        mtimeMs: stat.mtimeMs,
        // Sidecar written next to every sub-agent transcript. Cheaper and more accurate than
        // parsing the transcript: it names the agent type, the caller's own description, the
        // parent tool_use id, the model, and how deep the spawn is nested.
        meta: readSubagentMeta(join(dir, `agent-${agentId}.meta.json`)),
      });
    }
  };
  walk(root, null);

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const files = found.slice(0, MAX_SUBAGENTS_TAILED);
  // How many actually exist on disk, carried on the array itself so the one other caller
  // (resolveTailPath, which only does .find) needs no change. buildSnapshot reports it — a cap
  // that hides what it dropped is how a 111-agent run looked like an 80-agent run.
  files.totalFound = found.length;
  subagentScans.set(sessionId, { tick: pollTick, files });
  return files;
}

/** Compact row for one sub-agent, plus a short feed while it is still running. */
function describeSubagent(file, parentTail, now) {
  const tail = pumpTail(file.path);
  if (!tail) return null;

  const pending = [...tail.pending.values()].map((p) => ({ ...p.event, startedTs: p.ts }));
  const meta = file.meta || {};

  /*
   * Deciding "is it still running". PROOF OF DEATH FIRST, then proof of life, then a guess:
   *
   *  1. the workflow journal's TERMINAL record — `result`, `failed`, or any future type. Exact,
   *     and the only exact one for a workflow fan-out. (`started` alone is NOT terminal.)
   *  2. the parent's task-notification — a background Agent's completion arrives in the parent
   *     transcript as `<task-id>…</task-id><status>completed</status>`. Exact.
   *  3. the sub-agent's OWN end-of-turn `stop_reason` with no tool of its own in flight — it
   *     emitted its final answer, so it is done whatever anyone else's bookkeeping says. Exact,
   *     and it is what rescues an agent whose parent never recorded the notification.
   *  4. the parent's own Agent tool_use still pending — a SYNCHRONOUS sub-agent.
   *  5. the workflow journal's `started` with no terminal record — launched, never reported back.
   *  6. a tool of its own in flight — it was working when it last wrote.
   *  7. otherwise: write recency (SUBAGENT_IDLE_MS).
   *
   * 🔴 4-6 are evidence of life ONLY while their emitter is alive, so each is AND-ed with
   * RUNNING_SIGNAL_STALE_MS. Without that a killed workflow / interrupted session / agent killed
   * mid-tool pinned its node to the graph forever (measured: 237 minutes), which is why they now
   * report `…-stale` instead of `running` once the transcript has gone quiet past the switch.
   *
   * NOT usable: the Agent tool_result text. A background launch emits that text (with the agentId
   * inside it) the instant the agent STARTS, so it marks every background sub-agent done at birth.
   *
   * NOT usable in reverse either: a MISSING `stop_reason` proves nothing. Measured 2026-09-07 —
   * of 357 workflow agents the journal calls `result` (i.e. finished and successful) only 4% ever
   * wrote a terminal `stop_reason`, because their answer leaves through StructuredOutput and the
   * transcript just stops after the last tool_result. Signal 3 is therefore a one-way proof of
   * DONE; it can never be read as proof of still-running.
   */
  const journal = file.workflowId ? readWorkflowJournal(file.dir) : null;
  const journalTerminal = journal ? journal.terminal.get(file.agentId) || "" : "";
  const journalSaysRunning = Boolean(
    journal && journal.started.has(file.agentId) && !journalTerminal,
  );
  const notifiedDone = Boolean(parentTail && parentTail.notifiedDone.has(file.agentId));
  const parentStillWaiting = Boolean(
    parentTail && meta.toolUseId && parentTail.pending.has(meta.toolUseId),
  );
  /** A running signal older than the switch is a leftover, not a live agent. */
  const signalFresh = now - file.mtimeMs < RUNNING_SIGNAL_STALE_MS;

  let running;
  let runningSource;
  /** How it ended, when that is known: "" while running, else "ok" | the journal's terminal type. */
  let outcome = "";
  if (journalTerminal) {
    running = false;
    runningSource = "journal-" + journalTerminal;
    outcome = journalTerminal === "result" ? "ok" : journalTerminal;
  } else if (notifiedDone) {
    running = false;
    runningSource = "task-notification";
    outcome = "ok";
  } else if (tail.turnEnded && pending.length === 0) {
    running = false;
    runningSource = "own-" + (tail.turnEndedBy || "stop");
    outcome = "ok";
  } else if (parentStillWaiting) {
    running = signalFresh;
    runningSource = signalFresh ? "parent-pending" : "parent-pending-stale";
  } else if (journalSaysRunning) {
    running = signalFresh;
    runningSource = signalFresh ? "journal-started" : "journal-started-stale";
  } else if (pending.length > 0) {
    running = signalFresh;
    runningSource = signalFresh ? "own-tool-in-flight" : "own-tool-in-flight-stale";
  } else {
    /*
     * No signal at all. Lean towards STILL WORKING: a sub-agent that thinks for minutes writes
     * nothing, and dropping it off the graph tells the viewer "nothing is running" when something
     * is — the exact failure this dashboard exists to prevent. A finished agent lingering for a
     * few extra minutes is the far cheaper mistake, and the counts stay honest because
     * `runningSource` records that this one was inferred rather than proven.
     */
    running = now - file.mtimeMs < SUBAGENT_IDLE_MS;
    runningSource = running ? "assumed-running" : "idle-timeout";
  }
  if (!running && !outcome) outcome = "unknown";

  const first = tail.events.find((e) => e.kind === "prompt");
  const lastSay = [...tail.events].reverse().find((e) => e.kind === "say");
  const current = pending[0] || null;
  /*
   * A sub-agent spends much of its life THINKING, with no tool in flight. Reporting only
   * `current` left those rows saying nothing useful and left their clock frozen, because durMs
   * (lastTs - firstTs) stops advancing while nothing is written. So also report the last tool it
   * finished — "just read X, thinking for 40s" is real information — and let the client tick from
   * lastTs instead.
   */
  const lastTool = [...tail.events].reverse().find((e) => e.kind === "tool") || null;

  return {
    agentId: file.agentId,
    workflowId: file.workflowId,
    type: meta.agentType || tail.meta.agentType || "sub-agent",
    // A workflow fan-out's sidecar carries ONLY {agentType, spawnDepth} — no description and no
    // model — so both fall back to the transcript. Verified against a live 9-agent workflow.
    label:
      meta.description ||
      firstLine((first && first.text) || "") ||
      firstLine((tail.events.find((e) => e.kind === "say") || {}).text || "") ||
      `${meta.agentType || tail.meta.agentType || "sub-agent"} ${file.agentId.slice(0, 6)}`,
    labelSource: meta.description ? "sidecar" : first ? "prompt" : "fallback",
    model: shortModel(meta.model || tail.meta.model),
    modelTag: modelMonogram(meta.model || tail.meta.model),
    depth: meta.spawnDepth || 1,
    /*
     * ความเป็นพ่อ–ลูกของ sub-agent — ใช้ประกอบต้นไม้ทุกระดับฝั่งเบราว์เซอร์
     *
     * ไฟล์ transcript ของลูกอยู่ **แบนทั้งหมด** ใน `<sessionId>/subagents/` ไม่ว่าจะลึกกี่ชั้น
     * ⇒ โครงต้นไม้อ่านได้จาก sidecar เท่านั้น (วัดจากลูกจริงบนเครื่องจริง):
     *   ชั้น 1: `{agentType, description, toolUseId, spawnDepth: 1}`  ← **ไม่มี** `parentAgentId`
     *   ชั้น 2: `{…, parentAgentId: "ab6db76…", spawnDepth: 2}`
     * ⇒ `parentAgentId` ว่าง = ลูกของ session (สายหลักเรียกเอง) · มีค่า = ลูกของ agent ตัวนั้น
     */
    parentAgentId: meta.parentAgentId || null,
    task: (first && first.text) || "",
    running,
    runningSource,
    outcome,
    inFlight: pending.length,
    tools: tail.counts.tools,
    errors: tail.counts.errors,
    tokens: tail.tokens,
    /*
     * ต่อ sub-agent ส่งแค่ `{id,n,tokens}` — ไม่ส่ง label/fix ซ้ำ เพราะระดับ session มีครบแล้ว
     * (วัดแล้วว่าการส่งซ้ำทำให้ frame โตจาก 29KB เป็น 59KB ทุก 700ms) · ฝั่งเบราว์เซอร์ map
     * id → label จากลิสต์ระดับ session ซึ่งเป็น superset ของลูกทุกตัวโดยนิยาม (มันคือการ merge)
     */
    errorStats: publicErrorStats(tail.errorStats).map((r) => ({ id: r.id, n: r.n, tokens: r.tokens })),
    startedTs: tail.firstTs,
    lastTs: tail.lastTs,
    durMs:
      tail.firstTs && tail.lastTs ? Math.max(0, Date.parse(tail.lastTs) - Date.parse(tail.firstTs)) : null,
    current: current
      ? { tool: current.tool, icon: current.icon, label: current.label, startedTs: current.startedTs }
      : null,
    lastTool: lastTool
      ? {
          tool: lastTool.tool,
          icon: lastTool.icon,
          label: lastTool.label,
          durMs: lastTool.durMs,
          error: Boolean(lastTool.error),
        }
      : null,
    answer: running ? "" : (lastSay && lastSay.text) || "",
    events: (running ? tail.events.slice(-6) : []).map(publicEvent),
  };
}

// ---------------------------------------------------------------------------
// what a tool call is actually doing — the whole point of the dashboard

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

function oneLine(value, max = 120) {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** First meaningful line — the label of last resort when no sidecar description exists. */
function firstLine(text, max = 90) {
  const line = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 2);
  return oneLine(line || "", max);
}

/** Keep newlines (for commands, diffs, stack traces) but bound the size. */
function clampText(value, max = DETAIL_TEXT_MAX) {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max)}\n… (ตัดที่ ${max} ตัวอักษร)` : value;
}

/**
 * Model ids arrive in two shapes: the sidecar writes a short alias ("haiku"), while a transcript's
 * assistant records write the full id ("claude-opus-5", "claude-haiku-4-5-20251001"). Workflow
 * sub-agents get NO sidecar model at all, so the transcript is the only source for them — hence
 * this normaliser rather than showing two different-looking things in one column.
 */
function shortModel(id) {
  if (typeof id !== "string" || !id) return "";
  let s = id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  s = s.replace(/^(fable|opus|sonnet|haiku)-(\d)-(\d)$/, "$1-$2.$3");
  return s.replace(/\[1m\]$/, "");
}

/** Two-letter monogram for the dense model column: haiku → HA, opus-5 → OP. */
function modelMonogram(id) {
  const s = shortModel(id);
  if (!s) return "??";
  return s.slice(0, 2).toUpperCase();
}

/**
 * A denial's rule identity is NOT a field — it only exists as a prefix inside the reason text.
 * Measured over 104 real denials: every one is a PreToolUse hook deny whose text starts either
 * either `🔒 [<rule>]` or `[<rule>]`, whatever the hook chose to call itself.
 */
function denyRuleFrom(text) {
  if (typeof text !== "string") return "";
  const locked = /^\s*🔒\s*\[([^\]]+)\]/.exec(text);
  if (locked) return locked[1];
  const bracketed = /^\s*\[([^\]]{2,40})\]/.exec(text);
  if (bracketed) return bracketed[1];
  const named = /[\w.]*(?:guard|hook)[\w./-]*/i.exec(text);
  return named ? named[0] : "";
}

/**
 * `toolDenialKind` is the only field, and it lies: all 104 observed `permission-rule`
 * denials were guard hooks, not permission rules. So report what actually happened.
 */
const DENY_LABEL = {
  "permission-rule": "ถูก guard hook บล็อก",
  "user-rejected": "ผู้ใช้กดปฏิเสธ",
  "automode-blocked": "auto mode บล็อก",
};

/** 21 of 274 observed error texts arrive wrapped in this tag; the rest are bare. */
function stripToolError(text) {
  return String(text || "")
    .replace(/^\s*<tool_use_error>\s*/, "")
    .replace(/\s*<\/tool_use_error>\s*$/, "");
}

/** Bash/PowerShell exit codes exist only as the literal first line of the error text. */
function exitCodeFrom(text) {
  const m = /^Exit code (\d+)/.exec(String(text || ""));
  if (!m) return null;
  const code = Number(m[1]);
  return { code, note: code === 143 ? "ถูก kill / หมดเวลา" : "" };
}

/*
 * Error categories + the one-line fix for each live in `lib/tool-error-kinds.cjs`, which is
 * deliberately CommonJS so a CJS consumer (e.g. a Stop hook of your own that wants to report
 * the same numbers at the end of a turn) can require the exact same definitions. One owner,
 * no copies — two copies of this table would drift apart immediately.
 */
const { classifyError } = createRequire(import.meta.url)("./lib/tool-error-kinds.cjs");


/** Claude Code spills oversized results to disk; detect both the structured and the text form. */
function persistedOutputFrom(resultObj, text) {
  if (resultObj && typeof resultObj === "object" && resultObj.persistedOutputPath) {
    return { path: resultObj.persistedOutputPath, size: resultObj.persistedOutputSize || null };
  }
  const m = /Full output saved to:\s*(\S+)/.exec(String(text || ""));
  return m ? { path: m[1], size: null } : null;
}

function baseName(p) {
  if (typeof p !== "string") return "";
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** One human-readable line describing a tool call, built from its real input. */
function summarizeTool(name, input) {
  const arg = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Bash":
    case "PowerShell":
      return oneLine(arg.description || arg.command);
    case "Read":
      return oneLine(baseName(arg.file_path) + (arg.offset ? ` @${arg.offset}` : ""));
    case "NotebookEdit":
      return oneLine(baseName(arg.notebook_path || arg.file_path));
    case "Edit":
    case "MultiEdit":
    case "Write":
      return oneLine(baseName(arg.file_path));
    case "Grep": {
      const where = arg.path ? ` ใน ${baseName(arg.path)}` : arg.glob ? ` (${arg.glob})` : "";
      return oneLine(`"${arg.pattern || ""}"${where}`);
    }
    case "Glob":
      return oneLine(arg.pattern);
    case "Agent":
    case "Task":
      return oneLine(
        (arg.subagent_type ? `[${arg.subagent_type}] ` : "") + (arg.description || arg.prompt),
      );
    case "Skill":
      return oneLine(arg.skill + (arg.args ? ` — ${arg.args}` : ""));
    case "WebFetch":
      return oneLine(arg.url);
    case "WebSearch":
    case "ToolSearch":
      return oneLine(arg.query);
    case "TodoWrite":
      return Array.isArray(arg.todos) ? `${arg.todos.length} รายการ` : "";
    case "Artifact":
      return oneLine(arg.action || arg.file_path || arg.url);
    case "AskUserQuestion":
      return oneLine(Array.isArray(arg.questions) ? arg.questions[0]?.question : "");
    default:
      break;
  }
  if (typeof name === "string" && name.startsWith("mcp__")) {
    const [, server, ...rest] = name.split("__");
    const keys = ["query", "sql", "text", "url", "page_id", "id", "pattern", "file_path"];
    const key = keys.find((k) => typeof arg[k] === "string" && arg[k]);
    let detail = "";
    if (key) detail = ` — ${oneLine(arg[key], 70)}`;
    else if (arg.data && typeof arg.data === "object" && typeof arg.data.query === "string") {
      detail = ` — ${oneLine(arg.data.query, 70)}`;
    }
    return oneLine(`${server}: ${rest.join("__")}${detail}`, 130);
  }
  const firstString = Object.values(arg).find((v) => typeof v === "string" && v);
  return oneLine(firstString);
}

/**
 * Turn a tool_use input into rows a person can read, without ever carrying a blob.
 * Field choices come from a sweep of 27,456 real tool_use blocks — notably: Grep's flag keys
 * literally start with a hyphen (`-n`, `-i`, `-C`), so they must be bracket-accessed; Edit's
 * old_string/new_string and Write's content are blobs (p50 247 B / 736 B / 3.8 KB, max 88 KB).
 */
function describeInput(name, input) {
  const arg = input && typeof input === "object" ? input : {};
  const rows = [];
  const add = (key, value) => {
    if (value === undefined || value === null || value === "") return;
    if (typeof value === "string" && value.length > BLOB_THRESHOLD) {
      rows.push({
        key,
        kind: "blob",
        bytes: Buffer.byteLength(value, "utf8"),
        lines: value.split("\n").length,
        preview: value.slice(0, BLOB_PREVIEW),
      });
      return;
    }
    if (typeof value === "object") {
      rows.push({ key, kind: "json", text: clampText(JSON.stringify(value, null, 1), 1200) });
      return;
    }
    rows.push({ key, kind: "text", text: clampText(String(value), DETAIL_TEXT_MAX) });
  };

  // Ordered so the most explanatory field is first for each tool kind.
  const ORDER = {
    Bash: ["description", "command", "timeout", "run_in_background"],
    PowerShell: ["description", "command", "timeout", "run_in_background"],
    Read: ["file_path", "offset", "limit", "pages"],
    Write: ["file_path", "content"],
    Edit: ["file_path", "replace_all", "old_string", "new_string"],
    MultiEdit: ["file_path", "edits"],
    Grep: ["pattern", "path", "glob", "type", "output_mode", "head_limit", "-n", "-i", "-o", "-C", "-A", "-B", "multiline"],
    Glob: ["pattern", "path"],
    Agent: ["description", "subagent_type", "model", "run_in_background", "isolation", "prompt"],
    Task: ["description", "subagent_type", "prompt"],
    Skill: ["skill", "args"],
    WebFetch: ["url", "prompt"],
    WebSearch: ["query"],
    ToolSearch: ["query", "max_results"],
    TodoWrite: ["todos"],
    NotebookEdit: ["notebook_path", "cell_id", "edit_mode"],
    Artifact: ["action", "file_path", "url", "title", "description"],
  };

  const ordered = ORDER[name] || [];
  for (const key of ordered) add(key, arg[key]);
  // Anything the ordered list did not name still gets shown — a new tool field should surface,
  // not silently vanish.
  for (const key of Object.keys(arg)) {
    if (ordered.includes(key)) continue;
    if (key === "caller") continue; // observed as {type:"direct"} on 27456/27456 blocks
    add(key, arg[key]);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// incremental transcript tail + reducer

const tails = new Map(); // path -> tail state

function newTail(startOffset) {
  return {
    offset: startOffset,
    seededMidLine: startOffset > 0,
    decoder: new StringDecoder("utf8"),
    partial: "",
    events: [],
    pending: new Map(), // tool_use_id -> { ts, event }
    /** assistant record uuid -> the tool it called, so a denial can name what it blocked. */
    uuidToTool: new Map(),
    /**
     * agentIds this session has been NOTIFIED are finished. A background sub-agent's completion
     * arrives in the parent transcript as a task-notification carrying <task-id> and <status>.
     * This is exact — unlike the Agent tool_result, which fires at launch for background agents.
     */
    notifiedDone: new Set(),
    seq: 0,
    counts: { tools: 0, errors: 0, denials: 0, prompts: 0 },
    /**
     * Tokens this transcript has spent, summed from `message.usage` on every assistant record.
     *
     * The four input classes are kept apart on purpose, because they do NOT cost the same and
     * lumping them hides the only number that explains the bill: `cacheRead` is the
     * whole context being re-sent on every single request, at 10% of input price. Measured over
     * 634 real sub-agent transcripts, cacheRead was ~90% of everything spent — so the
     * dashboard has to show it broken out, not as a
     * single merged total that makes a bloated session look like a busy one.
     *
     * `errorRecovery` is the subset attributable to tool failures: the request the model had to
     * spend reading an error and re-issuing a corrected call. On the success path that request
     * would not exist, so it is pure waste — measured at ~102K tokens per error, because the
     * price of a request is the size of the context, not the size of the mistake.
     */
    tokens: {
      input: 0,
      cacheCreate: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
      requests: 0,
      errorRecovery: 0,
      /** True when the lifetime total could not be recovered from the whole file (see prescan). */
      partial: false,
    },
    /**
     * Failures whose recovery cost has not landed yet. The request that follows a failed
     * tool_result is the one the model spends reading the error and re-issuing a corrected call,
     * so its tokens are billed back to these entries when it arrives.
     */
    pendingErrors: [],
    /**
     * Tokens lost per KIND of failure — the answer to "what is actually eating the budget".
     * `{ [kindId]: { id, label, fix, n, tokens, tools:{}, sample:{tool,cmd,text} } }`
     */
    errorStats: {},
    /**
     * The failures themselves, newest last, so "what error was it, exactly?" has an answer.
     *
     * 🔴 This exists because the event feed CANNOT answer it. `events` is seeded from the last
     * 256KB only, while `errorStats` counts the whole file via the prescan — so the table said
     * "26 ครั้ง" while clicking through to the feed showed "ไม่มีรายการในหมวดนี้". A count you
     * cannot drill into is the same broken promise as a cap you cannot see.
     *
     * Kept server-side only (never in the 700ms frame) and bounded, because an error text runs
     * to 7,423 characters — same rule as every other heavy field in this file.
     */
    errorLog: [],
    meta: {},
    firstTs: null,
    lastTs: null,
    /**
     * True once the turn has actually ended. The gap between a tool_result and the next
     * tool_use is the model THINKING, not idleness — the only trustworthy "turn over" signal
     * in the transcript is the Stop-hook summary record that Claude Code writes at that moment.
     */
    turnEnded: false,
    /** Which signal proved the turn was over — shown in the panel so the state is auditable. */
    turnEndedBy: null,
  };
}

/**
 * The SSE frame carries only what a chip needs. Everything expensive (full command text, full
 * error text, diff hunks, blob previews) stays in `full` on the server and is fetched by
 * /api/agent when the viewer actually clicks — otherwise every 700ms frame would carry megabytes.
 */
function publicEvent(event) {
  const out = {};
  for (const key of Object.keys(event)) {
    if (key === "full") continue;
    out[key] = event[key];
  }
  out.hasDetail = Boolean(event.full);
  return out;
}

function pushEvent(tail, event) {
  event.i = ++tail.seq;
  tail.events.push(event);
  if (tail.events.length > EVENT_BUFFER) {
    tail.events.splice(0, tail.events.length - EVENT_BUFFER);
  }
  return event;
}

function firstText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (typeof b.text === "string") return b.text;
    // A `tool_result` block keeps its payload in `.content`, NOT `.text` — and that is exactly
    // where a hook deny's reason lives. Reading only `.text` returned "" for every denial, which
    // cost both the reason text and the rule badge parsed out of it.
    if (typeof b.content === "string") return b.content;
    if (Array.isArray(b.content)) {
      const inner = b.content.find((x) => x && typeof x.text === "string");
      if (inner) return inner.text;
    }
  }
  return "";
}

/**
 * A background sub-agent's completion arrives as a task-notification carrying <task-id> and
 * <status>. It is the ONLY exact "that one finished" signal for a background launch.
 *
 * 🔴 It does NOT arrive as a `user` record. Measured over 600 consecutive real records, it lands
 * as `queue-operation` (22 occurrences) and `attachment` (11) — scanning only `user` records
 * found ZERO of them, so finished sub-agents stayed on the graph until a 10-minute timeout.
 * Hence: check the text-bearing field of whatever record type it turns up in.
 */
function harvestTaskNotification(tail, rec) {
  let text = "";
  if (typeof rec.content === "string") text = rec.content;
  else if (rec.attachment && typeof rec.attachment.content === "string") text = rec.attachment.content;
  else if (rec.attachment && Array.isArray(rec.attachment.content))
    text = rec.attachment.content.join(" ");
  else text = firstText(rec.message && rec.message.content);
  if (!text || text.indexOf("task-notification") === -1) return;

  const id = /<task-id>([^<]+)<\/task-id>/.exec(text);
  const status = /<status>([^<]+)<\/status>/.exec(text);
  if (id && status && /completed|failed|error|killed|stopped|cancel/i.test(status[1])) {
    tail.notifiedDone.add(id[1].trim());
  }
}

/**
 * Add one request's `message.usage` to a tail's running totals.
 *
 * Field names come from the real records on this machine, not from the API docs: `input_tokens`,
 * `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, and thinking tokens
 * nested at `output_tokens_details.thinking_tokens`. `iterations[]` is NOT summed — it is a
 * per-iteration breakdown of the SAME request and adding it would double-count.
 */
function addUsage(tokens, usage, isErrorRecovery) {
  if (!usage || typeof usage !== "object") return 0;
  const input = usage.input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const billable = input + cacheCreate + cacheRead + output;
  tokens.input += input;
  tokens.cacheCreate += cacheCreate;
  tokens.cacheRead += cacheRead;
  tokens.output += output;
  tokens.thinking += (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0;
  tokens.requests++;
  if (isErrorRecovery) tokens.errorRecovery += billable;
  return billable;
}

/** How many individual failures each transcript remembers for the drill-down. */
const ERROR_LOG_MAX = 80;

/** Record one failure against its kind, and keep the failure itself for the drill-down. */
function noteError(tail, kind, tool, cmd, text, ts) {
  const stat =
    tail.errorStats[kind.id] ||
    (tail.errorStats[kind.id] = { id: kind.id, label: kind.label, fix: kind.fix, n: 0, tokens: 0, tools: {}, sample: null });
  stat.n++;
  stat.tools[tool || "?"] = (stat.tools[tool || "?"] || 0) + 1;
  // Keep the NEWEST example, not the first: when a viewer opens the table they want to see the
  // thing that just happened, and an old sample makes a fixed problem look current.
  stat.sample = {
    tool: tool || "?",
    cmd: oneLine(cmd || "", 160),
    text: oneLine(text || "", 300),
  };
  const entry = {
    kind: kind.id,
    label: kind.label,
    fix: kind.fix,
    tool: tool || "?",
    ts: ts || null,
    cmd: oneLine(cmd || "", 300),
    text: clampText(text || "", 1200),
    wasted: 0,
  };
  tail.errorLog.push(entry);
  if (tail.errorLog.length > ERROR_LOG_MAX) tail.errorLog.shift();
  return { stat, entry };
}

/**
 * Bill one request's tokens back to the failures that made it necessary.
 * Split evenly when a single tool_result batch failed more than once, so the per-kind numbers
 * still add up to `tokens.errorRecovery` instead of double-counting the same request.
 */
function chargePendingErrors(tail, billable) {
  if (!tail.pendingErrors.length) return;
  const share = billable / tail.pendingErrors.length;
  for (const p of tail.pendingErrors) {
    p.stat.tokens += share;
    if (p.entry) p.entry.wasted = Math.round(share);
    if (p.event) p.event.wastedTokens = Math.round(share);
  }
  tail.pendingErrors = [];
}

const ZERO_TOKENS = {
  input: 0,
  cacheCreate: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
  requests: 0,
  errorRecovery: 0,
  partial: false,
};

/** Add up several token records into one (sub-agent rows → a session's fan-out total). */
function sumTokens(list) {
  const out = { ...ZERO_TOKENS };
  for (const t of list) {
    if (!t) continue;
    out.input += t.input || 0;
    out.cacheCreate += t.cacheCreate || 0;
    out.cacheRead += t.cacheRead || 0;
    out.output += t.output || 0;
    out.thinking += t.thinking || 0;
    out.requests += t.requests || 0;
    out.errorRecovery += t.errorRecovery || 0;
    if (t.partial) out.partial = true;
  }
  return out;
}

/**
 * หมวด error เรียงจากที่กินโทเค็นมากสุด — รูปแบบที่ส่งไปให้เบราว์เซอร์
 *
 * ตัดฟิลด์หนักออกจาก frame โดยเจตนา (`sample.text` ยาวได้ 300 ตัวอักษร · `tools` เป็นอ็อบเจ็กต์)
 * เพราะ frame ถูกส่งทุก 700ms — ของหนักอยู่ฝั่ง server แล้วดึงตอนกดผ่าน `/api/agent` เหมือน
 * ทุกอย่างอื่นในไฟล์นี้ (ดู README §ทำไมรายละเอียดไม่มาใน SSE)
 */
function publicErrorStats(stats) {
  return Object.values(stats || {})
    .map((s) => ({ id: s.id, label: s.label, fix: s.fix, n: s.n, tokens: Math.round(s.tokens) }))
    .sort((a, b) => b.tokens - a.tokens || b.n - a.n);
}

/** รวมหมวด error จากหลายที่ (session + ลูกทุกตัว) ให้เป็นภาพเดียว */
function mergeErrorStats(lists) {
  const out = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const cur = out.get(row.id) || { id: row.id, label: row.label, fix: row.fix, n: 0, tokens: 0 };
      cur.n += row.n;
      cur.tokens += row.tokens;
      out.set(row.id, cur);
    }
  }
  return [...out.values()].sort((a, b) => b.tokens - a.tokens || b.n - a.n);
}

function reduceRecord(tail, rec) {
  if (!rec || typeof rec !== "object") return;
  if (rec.timestamp) {
    tail.lastTs = rec.timestamp;
    if (!tail.firstTs) tail.firstTs = rec.timestamp;
  }
  // On a sub-agent transcript this names the agent type ("scout", "workflow-subagent", …).
  if (rec.attributionAgent) tail.meta.agentType = rec.attributionAgent;
  if (rec.entrypoint) tail.meta.entrypoint = rec.entrypoint;
  if (rec.cwd) tail.meta.cwd = rec.cwd;
  if (typeof rec.gitBranch === "string") tail.meta.gitBranch = rec.gitBranch;
  if (rec.version) tail.meta.version = rec.version;
  if (rec.type === "custom-title" && rec.customTitle) tail.meta.title = rec.customTitle;

  const ts = rec.timestamp || null;
  const lane = rec.isSidechain ? "sub" : "main";
  const content = rec.message && rec.message.content;

  harvestTaskNotification(tail, rec);

  // Any prompt or model output means work is in flight again; the signals below end it.
  if (rec.type === "user" || rec.type === "assistant") {
    tail.turnEnded = false;
    tail.turnEndedBy = null;
  }

  if (rec.type === "assistant") {
    if (rec.message && rec.message.model) tail.meta.model = rec.message.model;
    if (typeof rec.effort === "string") tail.meta.effort = rec.effort;
    // This request is "error recovery" when the tool_result just before it failed: on the success
    // path the model would have moved on instead of spending a whole round-trip on the failure.
    const billed = addUsage(tail.tokens, rec.message && rec.message.usage, tail.pendingErrors.length > 0);
    chargePendingErrors(tail, billed);
    /*
     * 🔴 `stop_reason` is the UNIVERSAL end-of-turn signal, and skipping it was a real bug.
     *
     * The Stop-hook summary record used to be the only thing that could set turnEnded — but
     * that record only exists where a Stop hook is configured. Measured across the four live
     * sessions on this machine: two had NEVER written one (0 of 235 records, 0 of 696), and a
     * third had one 84 records ago. Those sessions could therefore never reach `idle`, so they
     * sat on "กำลังคิด" with a running clock forever — exactly what the user reported after
     * closing their windows. `stop_reason` comes from Claude itself in every session.
     *
     * `tool_use` means the agent loop continues (a tool call is next), and null means the
     * message is still streaming. Anything else — end_turn, stop_sequence, max_tokens, refusal —
     * means nothing more is coming without a new prompt.
     */
    const stopReason = rec.message && rec.message.stop_reason;
    if (stopReason && stopReason !== "tool_use") {
      tail.turnEnded = true;
      tail.turnEndedBy = "stop_reason:" + stopReason;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking" && block.thinking) {
        pushEvent(tail, { kind: "thinking", lane, ts, text: oneLine(block.thinking, 220) });
      } else if (block.type === "text" && block.text && block.text.trim()) {
        pushEvent(tail, { kind: "say", lane, ts, text: oneLine(block.text, 400) });
      } else if (block.type === "tool_use") {
        tail.counts.tools++;
        const event = pushEvent(tail, {
          kind: "tool",
          lane,
          ts,
          tool: block.name,
          icon: toolIcon(block.name),
          label: summarizeTool(block.name, block.input),
          done: false,
          error: false,
          durMs: null,
        });
        // Retained for the detail endpoint only — stripped out of every SSE frame.
        event.full = {
          toolUseId: block.id || "",
          // The raw command/pattern, kept only server-side. Needed to tell a `grep` that found
          // nothing (exit 1 = fine) from a `grep` that was actually wrong — see classifyError.
          cmdRaw: oneLine(
            (block.input && (block.input.command || block.input.pattern || block.input.file_path)) || "",
            300,
          ),
          input: describeInput(block.name, block.input),
          result: null,
          skill: rec.attributionSkill || "",
          mcpServer: rec.attributionMcpServer || "",
          mcpTool: rec.attributionMcpTool || "",
          requestId: rec.requestId || "",
        };
        if (block.id) tail.pending.set(block.id, { ts, event });
        if (rec.uuid) {
          tail.uuidToTool.set(rec.uuid, {
            tool: block.name,
            label: summarizeTool(block.name, block.input),
          });
          // Bound it — a long session would otherwise grow this map without limit.
          if (tail.uuidToTool.size > 600) {
            tail.uuidToTool.delete(tail.uuidToTool.keys().next().value);
          }
        }
      }
    }
    return;
  }

  if (rec.type === "user") {
    if (rec.toolDenialKind) {
      tail.counts.denials++;
      // The reason text sits on THIS SAME record, at message.content[0].content — verified over
      // 104 real denials. No adjacent record, no system record, no hookErrors lookup needed.
      const reason = stripToolError(firstText(content));
      const kind = String(rec.toolDenialKind);
      const rule = denyRuleFrom(reason);
      const denyEvent = pushEvent(tail, {
        kind: "denied",
        lane,
        ts,
        denyKind: kind,
        denyLabel: DENY_LABEL[kind] || kind,
        rule,
        text: oneLine(reason.replace(/^\s*🔒\s*\[[^\]]+\]\s*/, ""), CHIP_TEXT_MAX),
      });
      denyEvent.full = {
        denyKind: kind,
        rule,
        reason: clampText(reason),
        // Which tool got blocked lives on the assistant record this one points back to.
        sourceUuid: rec.sourceToolAssistantUUID || "",
        deniedTool: tail.uuidToTool.get(rec.sourceToolAssistantUUID) || null,
      };
    }
    if (typeof content === "string") {
      if (!rec.isMeta) {
        tail.counts.prompts++;
        pushEvent(tail, { kind: "prompt", lane, ts, text: oneLine(content, 400) });
      }
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "tool_result") {
        // `is_error` is written ONLY when true for every tool except Bash/PowerShell — so test
        // the value, never key presence (measured: absent on 4,713 successful results).
        const failed = block.is_error === true;
        const rawText = stripToolError(firstText(block.content));
        const pending = block.tool_use_id ? tail.pending.get(block.tool_use_id) : null;
        if (pending) {
          tail.pending.delete(block.tool_use_id);
          pending.event.done = true;
          pending.event.error = failed;
          if (ts && pending.ts) {
            const delta = Date.parse(ts) - Date.parse(pending.ts);
            pending.event.durMs = Number.isFinite(delta) && delta >= 0 ? delta : null;
          }
          // On failure `toolUseResult` collapses to a plain string, and sub-agent transcripts
          // carry it only 3 times in 657 results — so the text block is the reliable source and
          // the structured object is a bonus when present.
          const structured =
            rec.toolUseResult && typeof rec.toolUseResult === "object" ? rec.toolUseResult : null;
          const exit = failed ? exitCodeFrom(rawText) : null;
          if (pending.event.full) {
            pending.event.full.result = {
              failed,
              text: clampText(rawText),
              bytes: Buffer.byteLength(rawText, "utf8"),
              exitCode: exit ? exit.code : null,
              exitNote: exit ? exit.note : "",
              persisted: persistedOutputFrom(structured, rawText),
              // Edit/Write hand back ready-to-render diff hunks when they succeed.
              patch: structured && Array.isArray(structured.structuredPatch)
                ? structured.structuredPatch.slice(0, 12)
                : null,
              resultType: structured ? structured.type || "" : "",
              numLines: structured && structured.file ? structured.file.numLines || null : null,
            };
          }
          if (exit) pending.event.exitCode = exit.code;
        }
        if (failed) {
          tail.counts.errors++;
          const exit = exitCodeFrom(rawText);
          const failedTool = pending ? pending.event.tool : "";
          const cmdRaw = pending && pending.event.full ? pending.event.full.cmdRaw : "";
          const kind = classifyError(failedTool, rawText, cmdRaw);
          const noted = noteError(tail, kind, failedTool, cmdRaw, rawText, ts);
          const errEvent = pushEvent(tail, {
            kind: "error",
            lane,
            ts,
            tool: failedTool,
            // ชนิดของความล้มเหลว + วิธีแก้ ติดไปกับ event เลย เพื่อให้ฟีดบอกได้ทันทีว่าควรทำอะไร
            errorKind: kind.id,
            errorLabel: kind.label,
            errorFix: kind.fix,
            /** เติมค่าจริงตอน request ถัดไปมาถึง (chargePendingErrors) */
            wastedTokens: 0,
            exitCode: exit ? exit.code : null,
            exitNote: exit ? exit.note : "",
            // Error texts run to 7,423 chars and are NOT truncated at source — clamping to 240
            // was throwing away the part that explains the failure.
            text: oneLine(rawText, CHIP_TEXT_MAX),
          });
          errEvent.full = {
            tool: failedTool,
            reason: clampText(rawText),
            bytes: Buffer.byteLength(rawText, "utf8"),
            exitCode: exit ? exit.code : null,
            exitNote: exit ? exit.note : "",
            persisted: persistedOutputFrom(null, rawText),
            errorKind: kind.id,
            errorLabel: kind.label,
            errorFix: kind.fix,
            cmdRaw,
          };
          // Wait for the next request to arrive, then bill its tokens to this failure.
          tail.pendingErrors.push({ stat: noted.stat, entry: noted.entry, event: errEvent });
        }
      } else if (block.type === "text" && block.text && block.text.trim() && !rec.isMeta) {
        tail.counts.prompts++;
        pushEvent(tail, { kind: "prompt", lane, ts, text: oneLine(block.text, 400) });
      }
    }
    return;
  }

  if (rec.type === "system") {
    if (typeof rec.subtype === "string" && rec.subtype.includes("stop")) {
      tail.turnEnded = true;
      tail.turnEndedBy = "stop-hook";
    }
    // hookErrors elements are plain strings in all 237 observed cases — no object form exists.
    // These are Stop-hook WARNINGS, not tool denials, and most are the same repeated module-load
    // noise, so they are filtered rather than shown one per line.
    const warnings = (Array.isArray(rec.hookErrors) ? rec.hookErrors : [])
      .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
      .filter((e) => !/Cannot find module|non-blocking status code/i.test(e));
    if (warnings.length) {
      const ev = pushEvent(tail, {
        kind: "guard",
        lane,
        ts,
        text: oneLine(warnings.join(" · "), CHIP_TEXT_MAX),
        count: warnings.length,
      });
      ev.full = { reason: clampText(warnings.join("\n\n")), source: "stop_hook_summary.hookErrors" };
    }
    if (rec.subtype === "api_error" && rec.error) {
      const ev = pushEvent(tail, {
        kind: "guard",
        lane,
        ts,
        text: oneLine(rec.error.formatted || JSON.stringify(rec.error), CHIP_TEXT_MAX),
      });
      ev.full = { reason: clampText(rec.error.formatted || JSON.stringify(rec.error, null, 1)), source: "api_error" };
    }
    return;
  }

  // A Stop hook that BLOCKS writes no stop_hook_summary at all — it lands here instead, and its
  // message is double-JSON-encoded (attachment.blockingError is a STRING holding {blockingError}).
  if (rec.type === "attachment" && rec.attachment && typeof rec.attachment === "object") {
    const att = rec.attachment;
    if (att.type === "hook_blocking_error") {
      let msg = att.blockingError;
      let command = att.command || "";
      if (typeof msg === "string") {
        try {
          const inner = JSON.parse(msg);
          msg = inner.blockingError || msg;
          command = inner.command || command;
        } catch {
          /* already plain text */
        }
      } else if (msg && typeof msg === "object") {
        command = msg.command || command;
        msg = msg.blockingError || JSON.stringify(msg);
      }
      const text = stripToolError(String(msg || ""));
      const rule = denyRuleFrom(text);
      const ev = pushEvent(tail, {
        kind: "blocked",
        lane,
        ts,
        rule,
        hookEvent: att.hookEvent || "Stop",
        text: oneLine(text.replace(/^\s*🔒\s*\[[^\]]+\]\s*/, ""), CHIP_TEXT_MAX),
      });
      ev.full = { reason: clampText(text), rule, command, hookEvent: att.hookEvent || "Stop" };
    } else if (att.type === "hook_cancelled") {
      const ev = pushEvent(tail, {
        kind: "guard",
        lane,
        ts,
        text: oneLine(`hook หมดเวลา: ${att.command || "?"} (${att.durationMs || "?"}ms)`, CHIP_TEXT_MAX),
      });
      ev.full = {
        reason: `hook ถูกยกเลิกเพราะหมดเวลา\ncommand: ${att.command || "?"}\nใช้ไป: ${att.durationMs || "?"}ms\nเพดาน: ${att.timeoutMs || "?"}ms`,
        source: "hook_cancelled",
      };
    }
  }
}

/**
 * A file this big skips the token prescan rather than risk a multi-second stall on first sight.
 * Sized against reality: the largest transcript on this machine is 33MB and a full read+parse of
 * it measured **259ms**, so the ceiling is ~1000× the observed worst case — it exists to stop a
 * pathological file, not to trade away correctness.
 */
const PRESCAN_MAX_BYTES = 400 * 1024 * 1024;

/**
 * Seed a tail at a RECORD boundary, and recover the token totals from everything before it.
 *
 * Two problems solved together:
 *
 *  1. **The seed used to land mid-record** and throw that fragment away (`seededMidLine`). Landing
 *     on the newline instead costs one backward scan and loses nothing.
 *  2. **A lifetime token total cannot come from the tail.** The tail is the last 256KB; a 33MB
 *     transcript has spent almost all of its tokens before that. Reporting the tail's sum as "what
 *     this session used" would understate a heavy session by orders of magnitude — the opposite of
 *     what the number is for. So the prefix is read ONCE, and only `usage` / `is_error` are pulled
 *     out of it; the events, tools, denials and pending state still come from the tail alone, so
 *     memory does not grow with file size.
 *
 * The error-recovery flag is carried across the boundary so a failure in the prefix still bills the
 * first request of the tail.
 */
function seedTail(path, size) {
  /*
   * A file that is not much bigger than the tail window is read from byte 0 outright. Skipping
   * the split entirely is both cheaper and more accurate than prescanning a sliver: a file only
   * slightly over the window leaves a prefix of a few bytes that contains no newline at all, so
   * the prescan could recover nothing AND the tail still discarded its straddling record — the
   * first request's usage was lost and the total had to be flagged `partial` for no gain. Most
   * sub-agent transcripts land in exactly this range.
   */
  if (size <= 2 * SEED_TAIL_BYTES) return newTail(0);

  const want = size - SEED_TAIL_BYTES;
  const tail = newTail(want);
  if (want > PRESCAN_MAX_BYTES) {
    tail.tokens.partial = true;
    return tail;
  }

  let buf = null;
  try {
    const fd = openSync(path, "r");
    try {
      buf = Buffer.allocUnsafe(want);
      const read = readSync(fd, buf, 0, want, 0);
      buf = buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    tail.tokens.partial = true;
    return tail;
  }

  /*
   * No newline anywhere in the prefix means one record is bigger than the whole prefix — a single
   * enormous prompt. Reading from byte 0 is then both correct and affordable (the file is already
   * known to be under PRESCAN_MAX_BYTES), so fall back to that rather than giving up on the total.
   * Measured case: `agent-a072ccd9…` is 844KB whose first 582KB is one record, and flagging it
   * `partial` was the last thing keeping the machine-wide total from being trustworthy.
   */
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return newTail(0);

  // Everything through `lastNl` is whole records, so the tail can start right after it.
  tail.offset = lastNl + 1;
  tail.seededMidLine = false;

  /** tool_use id -> {name, cmd} เพื่อจัดหมวด error ในส่วนหัวไฟล์ให้ได้เหมือนกับใน tail */
  const prescanTools = new Map();
  for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
    if (!line) continue;
    // Cheap reject before JSON.parse — the overwhelming majority of records carry none of these,
    // and parsing 9,470 records of a 33MB file for fields we do not need is the whole cost here.
    const hasUsage = line.indexOf('"usage"') !== -1;
    const hasErr = line.indexOf('"is_error"') !== -1;
    const hasDeny = line.indexOf('"toolDenialKind"') !== -1;
    if (!hasUsage && !hasErr && !hasDeny) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "assistant") {
      const billed = addUsage(tail.tokens, rec.message && rec.message.usage, tail.pendingErrors.length > 0);
      chargePendingErrors(tail, billed);
      /*
       * Count the tools too, because it costs nothing: an assistant record that calls a tool is
       * the SAME record that carries `usage`, so it is already parsed here.
       *
       * 🔴 Without this the counters lie, and visibly. Measured 2026-09-07: sub-agent
       * `a637fe31…` (1.5MB) really made **142** tool calls and the panel said **25** — only the
       * ones inside the 256KB tail. The README even claimed this "only affects sessions that have
       * already ended, which are not shown anyway", which was wrong: that agent belongs to a LIVE
       * session. Putting a correct lifetime token total next to a truncated tool count would have
       * made the two numbers contradict each other on the same row.
       */
      const content = rec.message && rec.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || block.type !== "tool_use") continue;
          tail.counts.tools++;
          if (block.id) {
            prescanTools.set(block.id, {
              name: block.name,
              cmd: oneLine((block.input && (block.input.command || block.input.pattern || block.input.file_path)) || "", 300),
            });
            // ผูกขนาดของ map ไว้ — ไฟล์ 33MB มี tool_use เป็นพัน และเราต้องการแค่ id ที่ยังไม่ถูกตอบ
            if (prescanTools.size > 4000) prescanTools.delete(prescanTools.keys().next().value);
          }
        }
      }
      continue;
    }
    if (rec.type !== "user") continue;
    if (rec.toolDenialKind) tail.counts.denials++;
    const content = rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== "tool_result" || block.is_error !== true) continue;
      tail.counts.errors++;
      const src = block.tool_use_id ? prescanTools.get(block.tool_use_id) : null;
      if (block.tool_use_id) prescanTools.delete(block.tool_use_id);
      const text = stripToolError(firstText(block.content));
      const tool = src ? src.name : "";
      const cmd = src ? src.cmd : "";
      const kind = classifyError(tool, text, cmd);
      // ไม่มี event ในส่วนนี้ (prescan ทิ้ง event ทั้งหมดโดยเจตนา) แต่ **เก็บ errorLog** เพราะ
      // นั่นคือของที่ทำให้ตัวเลขในตารางกดดูได้จริง (ดูคอมเมนต์ที่ errorLog ใน newTail)
      const noted = noteError(tail, kind, tool, cmd, text, rec.timestamp);
      tail.pendingErrors.push({ stat: noted.stat, entry: noted.entry, event: null });
    }
  }
  return tail;
}

function pumpTail(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }

  let tail = tails.get(path);
  if (!tail) {
    tail = seedTail(path, stat.size);
    tails.set(path, tail);
  } else if (stat.size < tail.offset) {
    // The file shrank (rewritten) — start over from the top.
    tail = newTail(0);
    tails.set(path, tail);
  }

  if (stat.size > tail.offset) {
    const length = stat.size - tail.offset;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    const fd = openSync(path, "r");
    try {
      read = readSync(fd, buffer, 0, length, tail.offset);
    } finally {
      closeSync(fd);
    }
    tail.offset += read;
    // StringDecoder keeps multi-byte characters (Thai, emoji) intact across chunk boundaries.
    const chunk = tail.decoder.write(buffer.subarray(0, read));
    const lines = (tail.partial + chunk).split("\n");
    tail.partial = lines.pop() || "";
    for (const line of lines) {
      if (tail.seededMidLine) {
        // The seed offset landed mid-record; that first fragment is not valid JSON.
        tail.seededMidLine = false;
        continue;
      }
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      reduceRecord(tail, rec);
    }
  }

  return tail;
}

// ---------------------------------------------------------------------------
// status derivation

function deriveStatus(tail, now) {
  const running = [...tail.pending.values()]
    .map((p) => ({ ...p.event, startedTs: p.ts }))
    .sort((a, b) => Date.parse(a.startedTs || 0) - Date.parse(b.startedTs || 0));

  if (running.length) {
    /*
     * Pending tools do not all mean the same kind of wait:
     *
     * - AskUserQuestion is direct evidence of a human wait and must surface immediately.
     * - Agent/Task remain pending while synchronous children work, often for many minutes. Their
     *   age must NEVER trigger the permission heuristic; an all-delegation set is `delegating`.
     * - Other tools retain the old >25s permission suspicion.
     *
     * Multiple tool_use blocks can be in flight together. A real/suspected user wait wins; an
     * ordinary active tool wins over concurrent delegation; only delegation calls left means the
     * parent is waiting on its children. `since` follows the call that caused the chosen state so
     * an hour-old Agent call cannot make a newly-started Bash look an hour old.
     */
    const explicitUserWait = running.find((r) => r.tool === EXPLICIT_USER_WAIT_TOOL);
    const ordinary = running.filter(
      (r) => r.tool !== EXPLICIT_USER_WAIT_TOOL && !DELEGATION_TOOLS.has(r.tool),
    );
    const permissionSuspect = ordinary.find((r) => {
      const started = r.startedTs ? Date.parse(r.startedTs) : NaN;
      return Number.isFinite(started) && now - started > PERMISSION_SUSPECT_MS;
    });

    let state;
    let since;
    if (explicitUserWait) {
      state = "waiting";
      since = explicitUserWait.startedTs;
    } else if (permissionSuspect) {
      state = "waiting";
      since = permissionSuspect.startedTs;
    } else if (ordinary.length) {
      state = "tool";
      since = ordinary[0].startedTs;
    } else {
      state = "delegating";
      since = running[0].startedTs;
    }

    return {
      state,
      since,
      running: running.map((r) => ({
        tool: r.tool,
        icon: r.icon,
        label: r.label,
        startedTs: r.startedTs,
        lane: r.lane,
      })),
    };
  }

  const last = tail.events[tail.events.length - 1];
  if (!last) return { state: "idle", since: tail.lastTs, running: [] };

  /*
   * An error or a denial is HISTORY, not a state.
   *
   * 🔴 This used to return "blocked" whenever the newest event happened to be an error, which
   * left a session reading "ติดด่าน / มี error" long after it had read the error and carried on —
   * the same reasoning error as the old "quiet": describing the last thing that HAPPENED instead
   * of what the agent is DOING. A failed tool is almost always followed by the model thinking
   * about it and continuing, so the state below is "thinking" and the failure is surfaced where
   * it belongs: the error count, the red arc, and the feed.
   *
   * "blocked" is therefore only claimed when the turn ENDED on a refusal — the agent tried to
   * finish and a guard would not let it, which really is a stuck state needing a human.
   */
  const endedBadly =
    tail.turnEnded && (last.kind === "blocked" || last.kind === "denied" || last.kind === "guard");
  if (endedBadly)
    return { state: "blocked", since: last.ts, running: [], endedBy: tail.turnEndedBy };

  // Only a PROOF that the turn is over earns "idle": Claude's own stop_reason, or the Stop-hook
  // summary where a hook is installed. `endedBy` reports which one, so the claim is auditable.
  if (tail.turnEnded)
    return { state: "idle", since: last.ts, running: [], endedBy: tail.turnEndedBy };

  /*
   * The turn has NOT ended and no tool is in flight, so the model is THINKING. Full stop.
   *
   * 🔴 This used to become "quiet — maybe stuck" after 45 seconds of silence, which was a
   * reasoning error dressed up as caution: a long think writes nothing to the transcript, so
   * silence is the NORMAL signature of thinking, not evidence of trouble. Claude Code's own
   * status line says "36m 44s · Almost done thinking…" for exactly this state — it reports the
   * elapsed time, it does not decide the agent has died. Reporting "เงียบไป" here made a working
   * agent look abandoned, which is the precise failure this dashboard exists to prevent.
   *
   * Liveness is answered by the PID, not by transcript silence, and the caller already knows it —
   * a dead process never reaches this branch (it is filtered as a finished session upstream).
   */
  return { state: "thinking", since: last.ts, running: [] };
}

// ---------------------------------------------------------------------------
// snapshot

const finishedAt = new Map(); // sessionId -> epoch ms when its pid went away

function buildSnapshot() {
  const now = Date.now();
  pollTick++;
  const roster = readRoster();
  const staleCutoff = ARGS.staleMinutes * 60_000;
  const agents = [];

  for (const row of roster) {
    if (row.alive) finishedAt.delete(row.sessionId);
    else if (!finishedAt.has(row.sessionId)) finishedAt.set(row.sessionId, now);

    const endedAgo = row.alive ? 0 : now - finishedAt.get(row.sessionId);
    if (!row.alive && endedAgo > staleCutoff) continue;

    const path = findTranscript(row.sessionId);
    const tail = path ? pumpTail(path) : null;
    const status = tail ? deriveStatus(tail, now) : { state: "unknown", running: [] };

    // Sub-agents: one row per agent-*.jsonl under this session's subagents/ tree. Running ones
    // are always all sent; finished ones are capped so a 100-agent fan-out stays a usable frame.
    let subagents = [];
    /** ลิสต์ error (มี label) ของลูกแต่ละตัว — ใช้ merge เป็นภาพรวมของ session */
    const subErrorLists = [];
    let subTotals = {
      total: 0,
      running: 0,
      done: 0,
      failed: 0,
      errors: 0,
      tools: 0,
      tokens: { ...ZERO_TOKENS },
      onDisk: 0,
      truncated: 0,
    };
    if (path && row.alive) {
      const files = listSubagentFiles(path, row.sessionId);
      const rows = [];
      for (const file of files) {
        const described = describeSubagent(file, tail, now);
        if (described) {
          rows.push(described);
          /*
           * เก็บลิสต์ error แบบมี label ไว้จากตัว tail ตรง ๆ (ไม่ใช่จากแถวที่จะส่ง เพราะแถวนั้นถูก
           * ตัด label ออกเพื่อลดขนาด frame) — `tails` แคชด้วย path เดียวกับที่ describeSubagent
           * เพิ่ง pump ⇒ เป็นออบเจ็กต์ตัวเดียวกัน ไม่ได้อ่านไฟล์ซ้ำ
           */
          const t = tails.get(file.path);
          if (t) subErrorLists.push(publicErrorStats(t.errorStats));
        }
      }
      // Computed over EVERY sub-agent, before the send cap — the browser must never derive a
      // total from the rows it received or a 100-agent fan-out reads as 24.
      const models = {};
      const runningModels = {};
      for (const r of rows) {
        const tag = r.modelTag || "??";
        models[tag] = (models[tag] || 0) + 1;
        if (r.running) runningModels[tag] = (runningModels[tag] || 0) + 1;
      }
      /*
       * Two families of number on purpose (user directive 2026-09-04): the GRAPH may only show
       * what is running, so it reads `running*`; the click-through panel keeps the historical
       * totals. Both are computed here over EVERY sub-agent, before the send cap — the browser
       * must never derive a count from the rows it received or a 100-agent fan-out reads as 24.
       */
      subTotals = {
        total: rows.length,
        running: rows.filter((r) => r.running).length,
        done: rows.filter((r) => !r.running).length,
        /*
         * "จบแล้ว" and "ล้มเหลว" are different facts and the panel used to conflate them. A
         * workflow that failed 80 of its 111 agents read as "จบแล้ว 80" — which is how a run
         * that mostly did not work looked like a run that did. `outcome` carries the journal's
         * own terminal type, so this counts the ones that ended badly rather than inferring it
         * from the error count (an agent can fail with 0 tool errors, e.g. a schema rejection).
         */
        failed: rows.filter((r) => !r.running && r.outcome && r.outcome !== "ok" && r.outcome !== "unknown").length,
        withErrors: rows.filter((r) => r.errors > 0).length,
        runningWithErrors: rows.filter((r) => r.running && r.errors > 0).length,
        errors: rows.reduce((n, r) => n + r.errors, 0),
        tools: rows.reduce((n, r) => n + r.tools, 0),
        tokens: sumTokens(rows.map((r) => r.tokens)),
        // Files that exist on disk but were dropped by MAX_SUBAGENTS_TAILED. Reported so a run
        // bigger than the cap can never again look like a run the size of the cap.
        onDisk: files.totalFound || rows.length,
        truncated: Math.max(0, (files.totalFound || 0) - rows.length),
        models,
        runningModels,
      };
      const running = rows.filter((r) => r.running);
      const done = rows
        .filter((r) => !r.running)
        .sort((a, b) => Date.parse(b.lastTs || 0) - Date.parse(a.lastTs || 0))
        .slice(0, MAX_SUBAGENTS_SENT_DONE);
      /*
       * เก็บ "พ่อ" ของทุกแถวที่ส่งไปด้วย แม้พ่อจะตกโดน MAX_SUBAGENTS_SENT_DONE
       *
       * ถ้าไม่ทำ: ลูกชั้น 2 ที่ยังวิ่งอยู่ถูกส่งไป แต่พ่อ (ชั้น 1) ที่จบแล้วถูกตัดออก ⇒ ฝั่งเบราว์เซอร์
       * ประกอบต้นไม้ไม่ติด แล้วลูกจะไปโผล่ที่ระดับบนสุดเหมือนเป็นลูกของ session เอง = **บอกผังผิด**
       * ⇒ ไล่ขึ้นไปตาม `parentAgentId` จนถึงราก แล้วเติมตัวที่ขาดกลับเข้าไป (ไม่นับใน cap)
       */
      const byId = new Map(rows.map((r) => [r.agentId, r]));
      const picked = new Map([...running, ...done].map((r) => [r.agentId, r]));
      for (const r of [...picked.values()]) {
        let pid = r.parentAgentId;
        while (pid && !picked.has(pid) && byId.has(pid)) {
          const anc = byId.get(pid);
          picked.set(pid, anc);
          pid = anc.parentAgentId;
        }
      }
      subagents = [...picked.values()];
    }

    agents.push({
      sessionId: row.sessionId,
      pid: row.pid,
      name: row.name,
      title: (tail && tail.meta.title) || "",
      alive: row.alive,
      endedAgo,
      kind: row.kind,
      entrypoint: row.entrypoint,
      version: row.version,
      cwd: (tail && tail.meta.cwd) || row.cwd,
      gitBranch: (tail && tail.meta.gitBranch) || "",
      model: (tail && tail.meta.model) || "",
      effort: (tail && tail.meta.effort) || "",
      startedAt: row.startedAt,
      lastTs: tail ? tail.lastTs : null,
      counts: tail ? tail.counts : { tools: 0, errors: 0, denials: 0, prompts: 0 },
      // The session's OWN tokens (its main thread). Sub-agent tokens are billed to the account
      // too but are reported separately in subTotals.tokens, because merging them hides which
      // half of a session's cost came from delegation — the exact question the 2026-09-04
      // token-discipline round was about.
      tokens: tail ? tail.tokens : { ...ZERO_TOKENS },
      /*
       * error แยกตามหมวด เรียงตามโทเค็นที่เสียไป — รวมของ session เองกับของลูกทุกตัวไว้ด้วยกัน
       * เพราะคำถามที่ต้องตอบคือ "งานนี้เผาโทเค็นไปกับอะไร" ไม่ใช่ "ใครเป็นคนพลาด"
       */
      errorStats: mergeErrorStats([tail ? publicErrorStats(tail.errorStats) : [], ...subErrorLists]),
      status,
      subagents,
      subTotals,
      events: tail ? tail.events.slice(-EVENTS_SENT).map(publicEvent) : [],
      hasTranscript: Boolean(path),
    });
  }

  const rank = {
    tool: 0,
    delegating: 1,
    waiting: 2,
    thinking: 3,
    blocked: 4,
    quiet: 5,
    idle: 6,
    unknown: 7,
  };
  agents.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const byState = (rank[a.status.state] ?? 9) - (rank[b.status.state] ?? 9);
    if (byState) return byState;
    return Date.parse(b.lastTs || 0) - Date.parse(a.lastTs || 0);
  });

  return {
    nowIso: new Date(now).toISOString(),
    nowMs: now,
    totals: {
      live: agents.filter((a) => a.alive).length,
      busy: agents.filter(
        (a) =>
          a.alive &&
          (a.status.state === "tool" ||
            a.status.state === "delegating" ||
            a.status.state === "thinking"),
      ).length,
      waiting: agents.filter((a) => a.alive && a.status.state === "waiting").length,
      subsRunning: agents.reduce((n, a) => n + a.subTotals.running, 0),
      subsTotal: agents.reduce((n, a) => n + a.subTotals.total, 0),
      /*
       * `toolsRunning` is what the header shows (user directive 2026-09-04): tools IN FLIGHT
       * right now — a session's own pending calls plus those of its running sub-agents. The
       * lifetime `tools` figure reached 1049 on this machine, which is a number about the past
       * pretending to be a number about the present. It stays in the payload because the
       * click-through panel still reports it per session, and the full tool list with it.
       */
      toolsRunning: agents.reduce(
        (n, a) =>
          n +
          (a.status.running || []).length +
          (a.subagents || []).reduce((m, s) => m + (s.running ? s.inFlight || 0 : 0), 0),
        0,
      ),
      tools: agents.reduce((n, a) => n + a.counts.tools + a.subTotals.tools, 0),
      errors: agents.reduce((n, a) => n + a.counts.errors, 0),
      denials: agents.reduce((n, a) => n + a.counts.denials, 0),
      /*
       * Tokens across every session on screen, own thread + fan-out. Unlike `tools`, this one is
       * NOT "what is happening now" — a token is spent once and stays spent, so a lifetime figure
       * is the only honest one. It is what makes the cost of a long session visible at a glance,
       * which is the thing the 2026-09-04 measurement round could only show after the fact.
       */
      tokens: sumTokens(agents.flatMap((a) => [a.tokens, a.subTotals.tokens])),
    },
    /** หมวด error ของทุก session บนจอรวมกัน เรียงตามโทเค็นที่เสียไป */
    errorStats: mergeErrorStats(agents.map((a) => a.errorStats)),
    /*
     * The plan's session (5h) + weekly windows. Three sources merged into one payload: the live
     * window off the transcripts (always), Anthropic's official percentage (from `--live-usage`
     * when on, else Claude Code's cache), and `sessionKnown` saying whether that percentage even
     * describes the window that is currently open — plus `sessionEstimate`, the `≈` fallback for
     * the one case where it does not. See buildPlanUsage.
     */
    usage: buildPlanUsage(now),
    agents,
  };
}

// ---------------------------------------------------------------------------
// http + sse

/**
 * Map (sessionId, agentId) back to a transcript on disk for the detail endpoint. Both ids come
 * from a snapshot the server itself produced, but they arrive over HTTP, so validate their shape
 * and never build a path out of raw input.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function resolveTailPath(sessionId, agentId) {
  if (!ID_RE.test(sessionId)) return null;
  const parent = findTranscript(sessionId);
  if (!parent) return null;
  if (!agentId) return parent;
  if (!ID_RE.test(agentId)) return null;
  const match = listSubagentFiles(parent, sessionId).find((f) => f.agentId === agentId);
  return match ? match.path : null;
}

const clients = new Set();
let lastPayload = "";

function broadcast() {
  let snapshot;
  try {
    snapshot = buildSnapshot();
  } catch (err) {
    process.stderr.write(`[agent-dashboard] snapshot failed: ${err.message}\n`);
    return;
  }
  const payload = JSON.stringify(snapshot);
  if (payload === lastPayload) return;
  lastPayload = payload;
  const frame = `data: ${payload}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/api/state") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(buildSnapshot()));
    return;
  }

  /*
   * Detail on demand. The snapshot deliberately carries no tool inputs, no full error text and no
   * diffs; this is where a click goes to get them. `a` is a sub-agent id, or absent for the
   * session's own transcript.
   */
  if (url.pathname === "/api/agent") {
    const sessionId = url.searchParams.get("s") || "";
    const agentId = url.searchParams.get("a") || "";
    const path = resolveTailPath(sessionId, agentId);
    if (!path) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "ไม่พบ transcript ของ agent นี้" }));
      return;
    }
    const tail = pumpTail(path);
    if (!tail) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "อ่าน transcript ไม่ได้" }));
      return;
    }
    // Newest last, and only the kinds a drill-down is about.
    const events = tail.events
      .filter((e) => e.kind === "tool" || e.kind === "error" || e.kind === "denied" || e.kind === "blocked")
      .slice(-200)
      .map((e) => ({ ...publicEvent(e), detail: e.full || null }));
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    /*
     * The failures themselves, so a row in the "error กิน token" table can be opened.
     *
     * At SESSION level this must include the sub-agents' failures too, because the table it
     * backs is the merged view (session + every child) — offering a merged count that drills
     * into only half the data is the same broken promise the errorLog was added to fix.
     * The sub-agent tails are already in `tails` from the poll, so this is a map lookup.
     */
    const logs = [{ from: "session", log: tail.errorLog }];
    if (!agentId) {
      const parentPath = findTranscript(sessionId);
      for (const file of parentPath ? listSubagentFiles(parentPath, sessionId) : []) {
        const t = tails.get(file.path);
        if (t && t.errorLog.length) {
          logs.push({ from: (file.meta && file.meta.agentType) || "sub-agent", log: t.errorLog });
        }
      }
    }
    const errorLog = logs
      .flatMap(({ from, log }) => log.map((e) => ({ ...e, from })))
      .sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0))
      .slice(0, 120);

    res.end(
      JSON.stringify({
        sessionId,
        agentId,
        model: shortModel(tail.meta.model),
        agentType: tail.meta.agentType || "",
        cwd: tail.meta.cwd || "",
        counts: tail.counts,
        firstTs: tail.firstTs,
        lastTs: tail.lastTs,
        events,
        errorLog,
        errorStats: publicErrorStats(tail.errorStats),
      }),
    );
    return;
  }

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  if (file.includes("..")) {
    res.writeHead(400).end("bad path");
    return;
  }
  const full = join(HERE, "public", file);
  if (!existsSync(full)) {
    res.writeHead(404).end("not found");
    return;
  }
  const ext = file.slice(file.lastIndexOf("."));
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(readFileSync(full));
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `\n  port ${ARGS.port} ถูกใช้อยู่ — ลองอีกพอร์ต: --port ${ARGS.port + 1}\n\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(ARGS.port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${ARGS.port}`;
  // Both views come off this one server, but the classic page has no link to the 3D one — so
  // list both URLs here, where the person choosing is actually looking. `--open` still goes to
  // the classic view; the second line is there to be clicked/copied.
  process.stdout.write(`\n  Agent Activity Dashboard\n`);
  process.stdout.write(`    Classic (2D)      → ${url}/\n`);
  process.stdout.write(`    NEURAL CORE (3D)  → ${url}/brain.html\n`);
  process.stdout.write(`  watching ${SESSIONS_DIR}\n`);
  process.stdout.write(`         + ${PROJECTS_DIR}\n`);
  // Say out loud whether the credential-reading path is armed. A flag that silently starts
  // reading a token and calling out is exactly the kind of thing that should announce itself.
  process.stdout.write(
    ARGS.liveUsage
      ? `  โควตา: สด — GET /api/oauth/usage ทุก ${ARGS.liveUsageSeconds}s (อ่าน OAuth token จาก ${CREDENTIALS_JSON})\n`
      : `  โควตา: หน้าต่าง 5 ชม. สดจาก transcript · % อย่างเป็นทางการมาจาก cache (ใส่ --live-usage เพื่อดึงสด)\n`,
  );
  process.stdout.write(`\n  Ctrl+C to stop\n\n`);
  if (ARGS.open) {
    const opener =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    try {
      spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* opening a browser is a nicety, not a requirement */
    }
  }
});

setInterval(broadcast, POLL_MS);

/*
 * The live-percentage poller. Started only when the flag asked for it, so a default run makes no
 * network call and never opens `.credentials.json`. First fetch is immediate so the bar is right
 * on the first paint instead of showing the stale cache for a minute.
 *
 * ตัวตั้งเวลาเคาะถี่ (10 วิ) แต่คนตัดสินว่า "ยิงจริงไหม" คือ `liveUsage.nextTryMs` ข้างใน — แบบนี้
 * บันไดถอยตอนโดน 429 กับการยิงทันทีตอนหน้าต่างใหม่เปิด ใช้กลไกเดียวกันได้โดยไม่ต้องรื้อ interval
 */
if (ARGS.liveUsage) {
  pollLiveUsage(true);
  setInterval(() => pollLiveUsage(), 10_000);
}
// Keep SSE connections alive through idle timeouts / proxies.
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(": ping\n\n");
    } catch {
      clients.delete(res);
    }
  }
}, 20_000);

process.on("SIGINT", () => {
  process.stdout.write("\n  stopped\n");
  process.exit(0);
});
