# Usage

← [back to README](../README.md) · [ภาษาไทย](usage.th.md)

The interface is in Thai. This page is the manual **and** the dictionary: every label you can see on
screen is translated in the [Label glossary](#label-glossary) at the bottom. The data itself — tool
names, file paths, models, timers, token counts, error text — is verbatim from your own transcripts,
in whatever language you and your agents work in.

**Contents**

- [The two views](#the-two-views)
- [Classic view](#classic-view)
- [NEURAL CORE (3D view)](#neural-core-3d-view)
- [What the statuses mean](#what-the-statuses-mean)
- [The quota bar](#the-quota-bar)
- [Demo mode](#demo-mode)
- [Limits and ceilings](#limits-and-ceilings)
- [HTTP endpoints](#http-endpoints)
- [Label glossary](#label-glossary)

---

## The two views

| | Classic | NEURAL CORE |
| --- | --- | --- |
| URL | `/` | `/brain.html` |
| Rendering | 2D SVG | 3D WebGL (three.js, vendored) |
| Best for | exact numbers, walking tool calls, drilling into errors | the shape of the system at a glance |
| Needs WebGL | no | **yes** |
| Data source | the same `/api/stream` SSE feed | the same `/api/stream` SSE feed |

`--open` always opens the **classic** view. There is no link from the classic view to the 3D one —
type `/brain.html`. The 3D view has a `← หน้าคลาสสิก` ("classic view") link in its bottom-right
control bar.

---

## Classic view

### Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Agent Activity          [pills: live · busy · waiting · subs · tools ·     │
│ every surface…           errors · denied · tokens]   [filter] [☐ alert]    │
├────────────────────────────────────────────────────────────────────────────┤
│ session (5 h) ▓▓▓░ 34% · resets in 2h56m │ this week ▓░ 12% │ this window… │
├────────────────────────────────────────────────────────────────────────────┤
│ 16 sub-agents running · 2 with errors  ▮▮▮▮▮▮▮▮▮▮  [legend] [reset view]   │
├──────────────────────────────────────────────┬─────────────────────────────┤
│                                              │  ← side panel opens here    │
│         ●  ●     ●                           │     when you click a node   │
│      ●    (session)   ●                      │                             │
│         ●     ●    ●                         │  [tabs across the top]      │
│                                              │                             │
└──────────────────────────────────────────────┴─────────────────────────────┘
```

### The graph

- One **hub** node per session, with its sub-agents orbiting it.
- Deep sub-agents orbit **the agent that actually spawned them**, not the session — so a
  parent-and-children group reads as one cluster. The leash shortens by 0.6× per level (floor 26 px).
- The label under a node is the tool it is running right now and for how long; the ring around it
  turns red in proportion to failed tool calls.
- Drag a node to pin it. Drag the background to pan. Wheel to zoom. `รีเซ็ตมุมมอง`
  ("reset view") unpins everything and refits.

### Controls

| Control | What it does |
| --- | --- |
| `กรอง ชื่อ/โปรเจกต์…` | filter box — matches session name and project path |
| `☐ เตือนเมื่อรอเรา` | beep when an agent looks stuck on a permission prompt |
| `เสียง AI: เปิด / ปิด` | toggle Thai activity voice + futuristic event effects; every fresh event gets a cue |
| `รีเซ็ตมุมมอง` | reset zoom/pan and unpin dragged nodes |
| click a node | open the side panel for that session or sub-agent |
| click a row in the panel | expand it (full tool input, error text, deny reason) |
| click a row in the waste table | drill into that error category |
| `← กลับไปตารางหมวด` | go back from a drill-down |
| `✕` | close the side panel |

**Keyboard:** `Enter` or `Space` on a focused node opens its panel; `Escape` closes the panel.
Only the AI-voice preference is remembered between reloads; no activity or transcript data is
stored in your browser.

The activity voice is **off by default**. Click its button once to satisfy the browser's audio
permission rule. From then on, every newly observed event gets a short electronic cue and important
events get a brief Thai phrase; the node/core and the button meter react with the speech. Repeated
SSE snapshots do not replay sounds, and the first snapshot is a silent baseline rather than old
history. During a rapid event storm all cues remain, but repeated speech is compacted so it stays
close to live activity. Voice pronunciation depends on the Thai voice installed in your browser or
operating system. This control is separate from `เตือนเมื่อรอเรา`, which is only the classic
permission-wait alarm.

### The side panel tabs

A **session** gets five tabs:

| Tab | Contents |
| --- | --- |
| `บทสนทนา` — Conversation | the event feed: prompts, thinking, tool calls, errors, denials |
| `💸 error กิน token` — Errors eating tokens | error categories ranked by the tokens spent recovering from them, with a per-category drill-down |
| `รายละเอียด session` — Session details | session id, name, title, surface, kind, status, `endedBy`, cwd, branch, model, effort, pid, version, started, last seen, tool/error/deny counts, whether a transcript was found |
| `sub-agent ที่จบแล้ว` — Finished sub-agents | DFS-ordered tree (parents before children, 16 px indent per level, `└` connectors) |
| `tool / error / deny` | every tool call, error and denial for this session |

A **sub-agent** gets three: `tool ทั้งหมด` (all tools), `รายละเอียด` (details — including a
**parent** row pointing back at whatever spawned it), and the waste tab.

> The `💸 error กิน token` tab is the unusual one. It attributes the cost of the *retry* back to the
> failure that caused it, so you can see that (for example) a guard hook that blocks a tool is more
> expensive than the mistake it prevented. Categories come from `lib/tool-error-kinds.cjs`.

---

## NEURAL CORE (3D view)

### Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ NEURAL CORE                          FPS  SESS  SUB-AGENT  TOOL  ERR  DENY │
│ ● mood word                          163   3      27/34     17    1    0  ◔│
├──────────────┐                                                             │
│ เซสชัน    ‹  │                                                             │
│ ● harbor-09  │                    (the brain + orbiting agents)            │
│ ● forge-66   │                                                             │
│              │                                          ┌──────────────────┤
└──────────────┘                                          │ detail panel     │
┌───────────────────────────────────────────┐ ┌────────────┴──────────────────┤
│ ฟีดสด (live feed, 60 rows)  [หยุดเลื่อน]  │ │ quality · auto-rotate · reset │
└───────────────────────────────────────────┘ └───────────────────────────────┘
```

### What it shows

- The **core** is the session. Its colour and the mood word in the top-left follow the state:
  thinking, calling a tool, waiting for sub-agents, waiting for permission, spawning agents,
  blocked, idle.
- Each **orbiting light** is a sub-agent; links are drawn as straight lines to its real parent.
- The **gauges** are FPS, sessions, sub-agents (`running/total`), tools, errors, denials, and a quota
  ring. The quota ring hides itself when there is no quota data at all.
- The **live feed** at the bottom keeps the last 60 rows.

### Controls

| Control | What it does |
| --- | --- |
| `‹` / `›` | collapse / expand the session rail |
| `หยุดเลื่อน` / `เลื่อนต่อ` | pause / resume feed auto-follow |
| `โฟกัสกล้อง` | fly the camera to the selected node |
| `คุณภาพ: ต่ำ / กลาง / สูง` | render quality — low / medium / high |
| `หมุนอัตโนมัติ: เปิด / ปิด` | auto-rotate — **off** by default |
| `รีเซ็ตกล้อง` | reset the camera (rotation and target; see the note below) |
| `เสียง AI: เปิด / ปิด` | toggle the same Thai event voice; the core pulses in time with cues/speech |
| `ทดสอบฉาก` | scenario dropdown — **only appears in fixture mode** |
| `← หน้าคลาสสิก` | back to the classic view |

**Mouse:** left-drag orbits · right-drag (or `Shift` + left-drag) pans · wheel zooms · two fingers
pan and pinch. There is momentum, so it keeps gliding after you let go. A click within 6 px of a
node selects it and focuses the camera on it.

**Keyboard:** `Escape` deselects · `Space` toggles auto-rotate. That is all of them.

> If you zoom far out and press `รีเซ็ตกล้อง`, the framing comes back but the zoom distance may not.
> Reload the page for a guaranteed default camera.

> If the browser cannot start WebGL you get a message saying so, with a link back to the classic
> view. A watchdog also warns if no first frame has arrived after 12 seconds — try `?quality=low`.

---

## What the statuses mean

The rule the whole tool follows is *never be more confident than the evidence*. Silence is
explicitly **not** treated as a problem, because long silence is the normal signature of thinking.

| Status | Evidence |
| --- | --- |
| ⚙️ tool | a `tool_use` with no matching `tool_result` yet |
| 🤖 delegating | the outstanding calls are `Agent`/`Task` calls → the parent is waiting for its sub-agents |
| 🙋 waiting | an `AskUserQuestion` is outstanding, or a non-agent tool has been outstanding for more than **25 s** → probably a permission prompt |
| 💭 thinking | no outstanding tool, but the turn has not ended — with a clock |
| ⛔ blocked | the turn **ended** on an error / `hookErrors` / `toolDenialKind` |
| 😴 idle | Claude's own `stop_reason` (`end_turn`/`stop_sequence`/`max_tokens`/`refusal`), or a Stop-hook summary record |

The `จบเทิร์นด้วย` ("turn ended by") row tells you **which** piece of evidence was used.
`blocked` is not sticky — an error is history, not a state.

**The one thing it refuses to guess:** whether a window closed mid-turn is still working. The
session registry file is not a heartbeat (a busy session's file was measured 274 s stale), so
"closed the laptop mid-turn" and "thinking hard" are indistinguishable from the available data. So
it shows a clock and lets you decide, instead of inventing a timeout.

A sub-agent is finally declared dead after **180 s** of silence — with the caveat, noted in the
source, that about 20% of real sub-agent transcripts go quiet for longer than that.

---

## The quota bar

Two different things live in that bar, and only one needs a credential.

**Always shown, no credential needed** — the live 5-hour window, computed from your transcripts:
when it opened, when it resets, how many requests and tokens went into it, and a per-model
breakdown. If the boundary came from the account's own `resets_at` it is exact; otherwise it is
estimated from the first request in the window and marked with `≈` (measured against the real value:
about 5 minutes off).

**Anthropic's official percentage** (session + weekly):

| Mode | Where the % comes from |
| --- | --- |
| default | the `~/.claude.json` cache, which Claude Code rewrites only on startup and token renewal — it can be **hours stale or simply wrong** |
| `--live-usage` | `GET /api/oauth/usage`, refreshed on your interval (default 120 s, minimum 15 s) |

When live fetching fails, the poller backs off on its own through `60s → 120s → 300s → 600s → 900s`
and keeps the last good number on screen, with a note saying how old it is and when it will retry.

The per-model numbers deliberately **exclude cache reads** — cache reads swamp the total and hide
the actual new work. Note that `cacheRead` is nonetheless the bulk of what you pay for: measured
over 634 sub-agent transcripts it was ~90% of everything spent, which is why the four input classes
are kept apart instead of merged into one total.

---

## Demo mode

Both views can render fake data so you can see the whole interface before you have anything running.
**`?fixture` means something different on each page.** That is deliberate.

### Classic

```
http://127.0.0.1:7676/?fixture=45
```

`N` is how many fake sub-agents to draw — clamped to `1..240`, and anything invalid falls back to
`45`. It renders **once** and never opens the event stream, so nothing animates. The connection
pill reads `fixture` so you cannot mistake it for real data.

### NEURAL CORE

```
http://127.0.0.1:7676/brain.html?fixture=cascade
```

| Scenario | What it plays |
| --- | --- |
| `auto` | cycles through all of the others (also the fallback for an unknown value) |
| `idle` | nothing running |
| `thinking` | a long think with no tools |
| `cascade` | sub-agents spawning sub-agents |
| `storm` | a large fan-out under load |
| `errors` | failures and denials |

This one **animates for real**, ticking every 700 ms, and shows a toast saying
`โหมดข้อมูลจำลอง — ไม่ได้ต่อกับ session จริง` ("mock data — not connected to a real session"). The
`ทดสอบฉาก` dropdown lets you switch scenarios live.

You can also pin render quality with `?quality=low|medium|high` and combine the two:
`/brain.html?fixture=storm&quality=high`.

---

## Limits and ceilings

All deliberate. Knowing them stops you from reading a ceiling as a bug.

| Limit | Value | Effect |
| --- | --- | --- |
| poll interval | 700 ms | how often the disk is re-read (it polls; it does not use `fs.watch`) |
| transcript seed | 256 KB from the tail | events older than that never appear at all |
| event buffer | 400 per session | kept in memory |
| events sent | 70 latest | what actually crosses the stream; the rest is behind `/api/agent` |
| sub-agents tailed | 240 | a bigger fan-out is not fully read |
| finished sub-agents sent | 24 | running ones are **all** sent; parents of any sent row are pulled back in past the cap, so a deep child is never re-parented onto the session |
| sub-agent idle timeout | 180 s | when a silent sub-agent is declared dead |
| permission suspicion | 25 s | when an outstanding non-agent tool starts reading as `waiting`; `AskUserQuestion` waits immediately |
| error log | 80 per transcript | so a category's drill-down can show fewer entries than its count |
| `/api/agent` slice | 200 events / 120 error rows | ceiling of the detail view |
| text clamps | 8000 / 600 / 600→400 chars | detail text, chips, blob preview |
| lifetime scan | 400 MB prescan · 24 MB usage seed · 13 h lookback | ceilings on the token accounting |
| drawn nodes | 64 (classic) · 640 nodes and links (3D) | drawing ceilings |
| feed rows | 60 (3D) | live feed length |
| SSE keep-alive | 20 s | `: ping` comment |
| reconnect | 1.5 s fixed (classic) · 1.5 s ×1.5 up to 10 s (3D) | after the stream drops |

There is **no hot reload**. If you edit `server.mjs`, restart it. (The page is read fresh from disk
on every request, so a page-only edit needs just a refresh — and if the page ends up newer than the
running server, the quota bar says so instead of silently hiding features.)

---

## HTTP endpoints

| Path | Returns |
| --- | --- |
| `/api/state` | one JSON snapshot, `cache-control: no-store` |
| `/api/stream` | SSE: a snapshot on connect, then one push per change (identical payloads are not re-sent) |
| `/api/agent?s=<sessionId>[&a=<agentId>]` | full detail for one session or sub-agent — tool inputs, error text, deny reasons |
| `/` | the classic view |
| `/<file>` | static files from `public/` only |

Ids are validated against `/^[A-Za-z0-9_-]{1,64}$/` before they are joined into a path, and static
serving cannot escape `public/`. No endpoint checks the HTTP method — `POST /api/state` returns the
same snapshot as `GET`. That is low-risk only because the server binds `127.0.0.1`.

---

## Label glossary

Thai → English for everything the interface can put on screen. Grouped by where you will meet it.
`{n}`, `{tool}`, `{dur}` and friends are values filled in at runtime.

### 1. Statuses

| Thai | English | Where |
| --- | --- | --- |
| กำลังใช้เครื่องมือ | Using a tool | classic |
| กำลังใช้ tool | Using a tool | 3D (same meaning, different wording) |
| กำลังเรียกเครื่องมือ | Calling a tool | 3D mood word, top-left |
| กำลังคิด | Thinking | both |
| รอ sub-agent | Waiting for sub-agents | classic and 3D session status |
| กำลังทำงานผ่าน sub-agent | Working through sub-agents | 3D mood word |
| รอเราตอบ / รออนุญาต | Waiting for a reply / for permission | both |
| รออนุญาต | Waiting for permission | 3D mood word |
| ติดด่าน / มี error | Blocked / has an error | both |
| ถูกบล็อก | Blocked | 3D mood word, feed fallback |
| 🚫 ถูกบล็อก | 🚫 Blocked | classic feed, when the server sent no label |
| ว่าง รอคำสั่ง | Idle — waiting for a prompt | both |
| รอคำสั่ง | Idle | 3D mood word |
| ไม่มี transcript | No transcript | both |
| กำลังแตก agent | Spawning agents | 3D mood word |
| กำลังทำงาน | Running | sub-agent status / 3D heading |
| ⛔ ล้มเหลว ({outcome}) | ⛔ Failed ({outcome}) | classic sub-agent outcome |
| ล้มเหลว ({outcome}) | Failed ({outcome}) | 3D tag |
| จบแล้ว (เดาจากความเงียบ) | Finished (inferred from silence) | classic |
| จบแล้ว (ไม่ทราบผลแน่ชัด) | Finished (outcome unknown) | 3D |
| จบแล้ว | Finished | both |
| สำเร็จ | Succeeded | 3D tag |
| 💭 คิดอยู่ | 💭 Thinking | node label |
| ปิดไปแล้ว · ล่าสุด {ago} | Closed · last active {ago} | node label for a dead session |
| กำลังทำ | In progress | badge on a running tool row |
| จบเทิร์นด้วย | Turn ended by | session details |
| ยังอยู่ / ใช่ | Alive / Yes | session details |

### 2. Classic view — panels and headers

| Thai | English | Where |
| --- | --- | --- |
| ตอนนี้ agent ทำอะไรอยู่ | What the agents are doing right now | page title |
| ทุก surface — CLI · VS Code extension · desktop · background | Every surface — CLI · VS Code extension · desktop · background | subtitle |
| ต่อ… / สด / หลุด — ต่อใหม่… | Connecting… / Live / Disconnected — reconnecting… | connection pill |
| กราฟ agent ที่กำลังทำงาน | Graph of running agents | `aria-label` of the graph |
| ยังไม่มี agent ทำงานอยู่ | No agents running yet | empty state |
| เปิด Claude Code ที่ไหนก็ได้ แล้วมันจะโผล่ที่นี่เอง | Start Claude Code anywhere and it will show up here | empty state |
| ลาก node ได้ · ล้อเมาส์ = ซูม · ลากพื้นหลัง = เลื่อน | Drag nodes · wheel = zoom · drag background = pan | hint |
| ทดสอบความหนาแน่นได้ด้วย ?fixture=45 | Try a density test with ?fixture=45 | hint |
| ทำงานอยู่ | Live | header pill |
| ยุ่ง | Busy | header pill |
| รอเรา | Waiting on us | header pill |
| sub-agent วิ่ง | Sub-agents running | header pill |
| tool กำลังรัน | Tools running | header pill |
| ถูก deny | Denied | header pill |
| เสียกับ error | Wasted on errors | header pill |
| {label}: {tokens} จาก {n} request | {label}: {tokens} across {n} requests | token tooltip |
| (คิด {n}) | (thinking {n}) | token tooltip |
| เสียไปกับการแก้ error {n} | Wasted recovering from errors {n} | token tooltip |
| ⚠️ ยอดไม่ครบ — อ่านไฟล์ทั้งไฟล์ไม่ได้ | ⚠️ Incomplete total — could not read the whole file | token tooltip |
| โทเค็น | Tokens | token rows |
| · ⚠️ ยอดไม่ครบ | · ⚠️ incomplete total | token row suffix |
| {head} — เสียไปกับ error | {head} — wasted on errors | error-recovery row |
| {n}% — request ที่ต้องใช้ไปอ่าน error แล้วสั่งใหม่ | {n}% — requests spent reading the error and retrying | error-recovery row |
| เมื่อกี้ | Just now | relative time |
| {dur} ที่แล้ว | {dur} ago | relative time |
| {h} ชม. {m} นาที · {m} นาที {s} วิ · {s} วิ | {h} h {m} min · {m} min {s} s · {s} s | countdowns |
| sub-agent {n} ตัวกำลังวิ่ง · {m} มี error | {n} sub-agents running · {m} with errors | fan-out band |
| ยังไม่มี sub-agent วิ่งอยู่ | No sub-agents running | fan-out band |
| ตัวที่จบแล้วดูได้ในแผงเมื่อกด node | Finished ones are in the panel when you click a node | fan-out tooltip |
| model ของ sub-agent ที่กำลังวิ่ง (นับทุกตัวที่วิ่ง ไม่ใช่แค่ที่วาด) | Models of the running sub-agents (counts every running one, not just the drawn ones) | legend tooltip |
| · ลูก {n} ตัว | · {n} children | under a session node |
| ล่าสุด {icon} {tool} {label} | Last {icon} {tool} {label} | under a node |
| โทเค็นของ session เอง | Tokens for this session itself | node tooltip |
| โทเค็นของ sub-agent ทั้งหมด | Tokens for all sub-agents | node tooltip |
| วงแดง = tool ล้มเหลว {n} จาก {m} ครั้ง (ของ agent เอง ไม่ใช่ dashboard) | Red ring = {n} of {m} tool calls failed (the agent's own, not the dashboard's) | node tooltip |
| กำลังทำ: {tool} {label} | Doing: {tool} {label} | child tooltip |
| ล่าสุด: {tool} {label} | Last: {tool} {label} | child tooltip |
| {n} tool · {m} พลาด | {n} tools · {m} failed | child tooltip |
| บทสนทนา | Conversation | panel tab |
| 💸 error กิน token | 💸 Errors eating tokens | panel tab |
| รายละเอียด session | Session details | panel tab |
| sub-agent ที่จบแล้ว | Finished sub-agents | panel tab |
| tool ทั้งหมด | All tools | panel tab (sub-agent) |
| รายละเอียด | Details | panel tab (sub-agent) |
| ชนิด | Type | detail row |
| ชื่องาน | Task name | detail row |
| ที่มาของชื่อ | Name source | detail row |
| สถานะ | Status | detail row |
| ตัดสินจาก | Decided from | detail row |
| พลาด | Failed | detail row (error count) |
| เริ่ม | Started | detail row |
| ล่าสุด | Last seen | detail row |
| ใช้เวลา | Duration | detail row |
| ความลึก · (ลูกของ sub-agent ตัวอื่น) · (สายหลักเรียกเอง) | Depth · (child of another sub-agent) · (spawned by the main thread) | detail row |
| พ่อ | Parent | detail row |
| (ไม่ได้ส่งมาในเฟรมนี้) | (not sent in this frame) | detail row suffix |
| งานที่ได้รับ | Task given | detail row |
| คำตอบ | Answer | detail row |
| ชื่อ | Name | detail row |
| หัวข้อ | Title | detail row |
| โทเค็นของ sub-agent | Sub-agent tokens | detail group |
| ⚠️ sub-agent เกินเพดาน · {n} ตัวบนดิสก์ · ไม่ได้อ่าน {m} ตัว | ⚠️ Sub-agent cap exceeded · {n} on disk · {m} not read | detail row |
| พบ / ไม่พบ | Found / Not found | transcript row |
| {n} พลาด | {n} failed | badge |
| × {n} ครั้ง · {tok}/ครั้ง | × {n} times · {tok}/time | error category row |
| {b} B · {n} บรรทัด | {b} B · {n} lines | truncated blob size |
| ลูกของ sub-agent ตัวหนึ่ง (ชั้น {d}) | Child of another sub-agent (level {d}) | tree indent tooltip |
| เหตุที่ถูกบล็อก | Reason it was blocked | event detail |
| tool ที่ถูกบล็อก | Blocked tool | event detail |
| เสีย {n} tok | {n} tok wasted | error badge |
| … (ตัดไว้) | … (truncated) | blob preview |
| {label} — {n} รายการ (จากทั้งหมด {m}) | {label} — {n} entries (out of {m}) | drill-down heading |
| งานทดสอบหมายเลข {i} | Test task #{i} | fixture only |
| ทดสอบความหนาแน่น {n} node | Density test, {n} nodes | fixture only |

### 3. Classic view — controls

| Thai | English | Where |
| --- | --- | --- |
| กรอง ชื่อ/โปรเจกต์… | Filter by name/project… | search placeholder |
| เตือนเมื่อรอเรา | Alert me when it's waiting on us | checkbox |
| เสียง AI: ปิด / แตะเพื่อเริ่ม / เปิด / กำลังพูด / ไม่รองรับ | AI voice: off / tap to start / on / speaking / unsupported | activity-voice button |
| รีเซ็ตมุมมอง | Reset view | button |
| กลับมุมมองเริ่มต้น และปลดหมุด node ที่ลากไว้ | Reset to the default view and unpin dragged nodes | that button's tooltip |
| ปิด | Close | panel close button |
| กดดูรายละเอียด | Click for details | feed row tooltip |
| กดดูรายการ error / deny จริง | Click to see the actual error / deny entries | waste row tooltip |
| กดดู tool ทั้งหมดของตัวนี้ | Click to see all of this one's tools | sub-agent row tooltip |
| ← กลับไปตารางหมวด | ← Back to the category table | drill-down back button |
| ลากได้ | Draggable | node tooltip |

### 4. Quota bar

| Thai | English | Where |
| --- | --- | --- |
| session (5 ชม.) | Session (5 h) | row label |
| สัปดาห์นี้ | This week | row label |
| สัปดาห์นี้ (เฉพาะรุ่น) | This week (this model only) | row label |
| ถึงเวลารีเซ็ตแล้ว | Reset is due | countdown |
| รีเซ็ตอีก {time} | Resets in {time} | countdown |
| · ประมาณจากโทเค็นในหน้าต่างนี้ · เลขทางการยังมาไม่ถึง | · estimated from the tokens burned in this window · the official number hasn't arrived yet | note |
| ยังไม่รู้ % | % not known yet | placeholder meter |
| · เลขที่มีเป็นของหน้าต่างก่อนหน้า (อ่านไว้ {clock}) · รันด้วย --live-usage เพื่อดึงเลขจริง | · the number we have belongs to the previous window (read at {clock}) · run with --live-usage to pull the real one | note |
| · ยังไม่มีค่าจากฝั่งบัญชี | · no value from the account side yet | note |
| หน้าต่างนี้ | This window | row label |
| เริ่ม {clock} · {n} request · {tok} โทเค็น | Started {clock} · {n} requests · {tok} tokens | window row |
| ขอบเขตหน้าต่างมาจาก resets_at ของฝั่งบัญชี — ตรงเป๊ะ | The window boundary comes from the account's resets_at — exact | tooltip |
| ประมาณจาก transcript: request แรกเปิดหน้าต่าง… | Estimated from the transcript: the first request opens the window… | tooltip |
| โทเค็นในหน้าต่างนี้ (ทุก session บนเครื่อง): | Tokens in this window (every session on this machine): | tooltip |
| ตัวเลขต่อรุ่นไม่รวม cache read — มันกินยอดรวมจนกลบส่วนที่เป็นงานใหม่ | Per-model numbers exclude cache reads — they swamp the total and hide the actual new work | tooltip |
| · % สดจาก /api/oauth/usage | · % live from /api/oauth/usage | note |
| · กำลังดึง % สดจาก /api/oauth/usage… | · fetching live % from /api/oauth/usage… | note |
| · % จาก /api/oauth/usage อ่านไว้ {dur} ที่แล้ว · รีเฟรชไม่ผ่าน ({err}) | · % from /api/oauth/usage read {dur} ago · refresh failed ({err}) | note |
| ไม่ทราบสาเหตุ | reason unknown | error fallback |
| · ดึง % สดไม่สำเร็จ ({err}) — เลขด้านบนมาจาก cache | · could not fetch live % ({err}) — the number above comes from cache | note |
| · ไม่รู้อายุของข้อมูล | · data age unknown | note |
| · % มาจาก cache อายุ {dur} — พิมพ์ /usage ใน Claude Code หรือรันด้วย --live-usage | · % comes from a {dur}-old cache — type /usage in Claude Code or run with --live-usage | note |
| · % มาจาก cache อ่านเมื่อ {dur} ที่แล้ว | · % comes from cache, read {dur} ago | note |
| · อัปเดต {ago} | · updated {ago} | note |
| · ลองใหม่อีก {time} / · กำลังลองใหม่… | · retrying in {time} / · retrying… | note |
| เมื่อครู่ | a moment ago | replaces "0 ms ago" |
| โควตา 5 ชม. | 5-hour quota | 3D quota ring |
| รีเซ็ตใน {duration} / รีเซ็ตแล้ว | Resets in {duration} / Reset | 3D quota ring |
| สัปดาห์ {n}% | Weekly {n}% | 3D quota ring |

### 5. NEURAL CORE — HUD and gauges

| Thai | English | Where |
| --- | --- | --- |
| เซสชัน | Sessions | gauge label / left rail header |
| ฟีดสด | Live feed | bottom panel header |
| รวม | Total | token grid |
| คิด (thinking) | Thinking | token grid |
| ข้อมูลเซสชัน | Session info | detail panel heading |
| อัปเดตล่าสุด | Last updated | detail row |
| เริ่มเมื่อ | Started | detail row |
| sub-agent ทั้งหมด ({n}) | All sub-agents ({n}) | detail heading |
| กำลังวิ่ง ({n}) | Running ({n}) | detail sub-heading |
| รายชื่อ sub-agent | Sub-agent list | detail heading |
| สายพันธุ์ | Lineage | detail heading (session → agent chain) |
| ข้อมูล sub-agent | Sub-agent info | detail heading |
| งาน (task) | Task | detail heading |
| จำนวน | Counts | detail heading |
| คำตอบ (answer) | Answer | detail heading |

### 6. NEURAL CORE — controls

| Thai | English | Where |
| --- | --- | --- |
| อัตโนมัติ | Auto | scenario dropdown (fixture only) |
| ว่าง | Idle | scenario dropdown |
| พายุงาน (storm) | Work storm | scenario dropdown |
| แตกเป็นทอด (cascade) | Cascading spawns | scenario dropdown |
| จำลอง error | Simulated errors | scenario dropdown |
| ต่ำ / กลาง / สูง | Low / Medium / High | quality buttons |
| ย่อ/ขยายรายชื่อ session | Collapse / expand the session list | rail toggle |
| โฟกัสกล้อง | Focus camera | detail panel header |
| ปิดแผงรายละเอียด | Close the detail panel | detail panel header |
| หยุดเลื่อน / เลื่อนต่อ | Pause feed / Resume feed | feed toggle |
| คุณภาพภาพ / คุณภาพ | Render quality / Quality | control bar |
| รีเซ็ตกล้อง | Reset camera | control bar |
| ทดสอบฉาก | Test scenario | control bar (fixture only) |
| ← หน้าคลาสสิก | ← Classic view | control bar |
| หมุนอัตโนมัติ: เปิด / ปิด | Auto-rotate: On / Off | control bar |
| ขยาย / ย่อ | Expand / Collapse | long-answer toggle |
| ← กลับไปหน้าคลาสสิก | ← Back to the classic view | boot/error card |

### 7. Messages, toasts and errors

| Thai | English | Where |
| --- | --- | --- |
| กำลังโหลด three.js และต่อสตรีม /api/stream … | Loading three.js and connecting to /api/stream … | 3D boot card |
| เปิด DevTools › Console เพื่อดูรายละเอียดเต็ม | Open DevTools › Console for full details | 3D error screen |
| โหลดสคริปต์ไม่สำเร็จ: {src} | Failed to load script: {src} | 3D error screen |
| ยังไม่มีเฟรมแรกหลัง 12 วินาที — ตรวจว่า /vendor/three.module.min.js และ /vendor/three.core.min.js มีอยู่จริง | No first frame after 12 seconds — check that /vendor/three.module.min.js and /vendor/three.core.min.js actually exist | 3D watchdog |
| เบราว์เซอร์นี้เปิด WebGL ไม่ได้ — หน้านี้ต้องใช้ WebGL ลองเปิด hardware acceleration หรือใช้หน้าคลาสสิกแทน | This browser cannot start WebGL — this page requires WebGL. Try enabling hardware acceleration, or use the classic view instead | 3D, no WebGL |
| ยังไม่มี session | No sessions yet | 3D empty state |
| ยังไม่มีเหตุการณ์ | No events yet | 3D feed empty |
| ยังไม่มีคำตอบ | No answer yet | 3D detail empty |
| ไม่พบข้อมูล | Not found | 3D detail title |
| เซสชันนี้ไม่มีอยู่แล้ว หรือยังไม่โหลดข้อมูล | This session no longer exists, or its data has not loaded yet | 3D detail empty |
| sub-agent นี้ไม่มีอยู่แล้ว | This sub-agent no longer exists | 3D detail empty |
| ไม่มี tool ที่กำลังทำงานอยู่ตอนนี้ | No tool is running right now | 3D detail empty |
| ยังไม่มี sub-agent | No sub-agents yet | 3D detail empty |
| ไม่มีข้อมูล tool | No tool data | 3D detail empty |
| สลับสถานการณ์: {scenario} | Switched scenario: {scenario} | 3D toast |
| คุณภาพภาพ: {LEVEL} | Render quality: {LEVEL} | 3D toast |
| เชื่อมต่อสตรีมแล้ว | Stream connected | 3D feed |
| สตรีมหลุด — กำลังเชื่อมใหม่ | Stream lost — reconnecting | 3D feed |
| โหลดสถานะแรก: {n} session · {m} sub-agent | Initial state loaded: {n} sessions · {m} sub-agents | 3D feed |
| แตก {n} agent: {type} … | Spawned {n} agents: {type} … | 3D feed |
| แตก agent: {type} — {label} | Spawned agent: {type} — {label} | 3D feed |
| {type} จบ — สำเร็จ / ล้มเหลว · {k} tool | {type} finished — Success / Failed · {k} tools | 3D feed |
| คำสั่งใหม่: {text} | New prompt: {text} | 3D feed |
| ดงโหนดล้นกรอบแล้ว — กด "รีเซ็ตกล้อง" เพื่อจัดกรอบใหม่ | Node cluster overflows the view — press "Reset camera" to refit | 3D toast |
| แสดงได้สูงสุด {n} โหนด — อีก {m} ตัวถูกซ่อน | Showing at most {n} nodes — {m} more hidden | 3D toast |
| ลดคุณภาพอัตโนมัติเพื่อรักษาความลื่น | Quality lowered automatically to keep the frame rate smooth | 3D toast |
| โหมดข้อมูลจำลอง — ไม่ได้ต่อกับ session จริง | Mock data mode — not connected to a real session | 3D toast (fixture) |
| ⚠️ server ยังเป็นโค้ดเก่า | ⚠️ The server is still running old code | replaces the quota bar |
| — หน้าเว็บอ่านไฟล์ใหม่แล้วแต่ process ของ server ยังเป็นตัวเดิม (ไม่มี hot-reload) ⇒ โควตาและยอดโทเค็นยังมาไม่ได้ · กด Ctrl+C แล้วรัน node server.mjs ใหม่ | — the page reloaded the new file but the server process is still the old one (no hot-reload) ⇒ quota and token totals can't arrive · press Ctrl+C and run node server.mjs again | same message |
| ยังไม่มี error ในเซสชันนี้ — ไม่มีโทเค็นที่เสียไปกับการแก้ตัว 🎉 | No errors in this session — no tokens wasted on recovery 🎉 | waste tab empty |
| เสียไปกับ error {a} จาก {b} ที่ใช้ทั้งหมด · {n} ครั้ง · เฉลี่ย {x}/ครั้ง — นับรวมของ session เองกับของ sub-agent ทุกตัว | {a} of {b} total tokens went to errors · {n} times · {x}/time on average — includes this session and every sub-agent | waste tab header |
| จบแล้ว {n} ตัว · ⛔ ล้มเหลว {m} ตัว (แสดง {k} ตัวล่าสุด — server จำกัดไว้) | {n} finished · ⛔ {m} failed (showing the latest {k} — capped by the server) | finished sub-agents |
| ยังไม่มีตัวที่จบ | Nothing has finished yet | finished sub-agents empty |
| ไม่มีรายละเอียดเพิ่มเติม | No further detail | event detail empty |
| กำลังโหลด… | Loading… | detail fetch |
| นี่คือข้อมูลทดสอบ (?fixture) — ไม่มี transcript จริงให้เจาะดู | This is test data (?fixture) — there is no real transcript to drill into | fixture only |
| เปิดหน้าปกติ (ไม่ใส่ ?fixture) เพื่อดู tool/error/deny ของ agent จริง | Open the page normally (without ?fixture) to see a real agent's tools/errors/denies | fixture only |
| โหลดไม่ได้: {err} | Could not load: {err} | detail fetch failed |
| ไม่มีรายละเอียดของหมวดนี้เก็บไว้ — errorLog เก็บย้อนหลังจำกัด (80 รายการต่อ transcript) ยอดในตารางจึงมากกว่าได้ | No stored detail for this category — errorLog keeps only a limited history (80 entries per transcript), so the table's count can be higher | drill-down empty |
| ไม่มีรายการในหมวดนี้ | Nothing in this category | drill-down empty |
| ไม่พบ OAuth token | OAuth token not found | quota bar (`--live-usage`) |
| token หมดอายุ — Claude Code จะต่ออายุให้เองเมื่อใช้งานครั้งถัดไป | Token expired — Claude Code will refresh it on its next call | quota bar |
| อ่าน ~/.claude/.credentials.json ไม่ได้ | Can't read ~/.claude/.credentials.json | quota bar |
| API ตอบ {status} | API returned {status} | quota bar |
| API ตอบมาในรูปแบบที่อ่านไม่ออก | API returned an unreadable response | quota bar |
| ยิง API ไม่สำเร็จ: {message} | API request failed: {message} | quota bar |
| … (ตัดที่ {max} ตัวอักษร) | … (truncated at {max} characters) | long text in the detail panel |
| ถูก guard hook บล็อก | Blocked by a guard hook | deny label |
| ผู้ใช้กดปฏิเสธ | Rejected by user | deny label |
| auto mode บล็อก | Blocked by auto mode | deny label |
| ถูก kill / หมดเวลา | Killed / timed out | exit note |
| ใน {file} | in {file} | tool summary, e.g. `"pattern" in server.mjs` |
| {n} รายการ | {n} items | tool summary (TodoWrite) |
| hook หมดเวลา: {command} ({ms}ms) | Hook timed out: {command} ({ms}ms) | guard event chip |
| hook ถูกยกเลิกเพราะหมดเวลา · ใช้ไป: {ms}ms · เพดาน: {ms}ms | Hook cancelled after timing out · Elapsed: {ms}ms · Limit: {ms}ms | guard event detail |
| ไม่พบ transcript ของ agent นี้ | No transcript found for this agent | `/api/agent` 404 |
| อ่าน transcript ไม่ได้ | Could not read the transcript | `/api/agent` 404 |
| อื่น ๆ | Other | error category fallback (`lib/tool-error-kinds.cjs`) |

### 8. Terminal output

| Thai | English | When |
| --- | --- | --- |
| port {port} ถูกใช้อยู่ — ลองอีกพอร์ต: --port {port+1} | Port {port} is already in use — try another: --port {port+1} | on `EADDRINUSE`, then exit 1 |
| โควตา: สด — GET /api/oauth/usage ทุก {n}s (อ่าน OAuth token จาก {path}) | Quota: live — GET /api/oauth/usage every {n}s (reads the OAuth token from {path}) | startup, with `--live-usage` |
| โควตา: หน้าต่าง 5 ชม. สดจาก transcript · % อย่างเป็นทางการมาจาก cache (ใส่ --live-usage เพื่อดึงสด) | Quota: 5-hour window live from transcripts · official % comes from cache (add --live-usage to fetch live) | startup, default |

---

Two labels not in the tables above, because they only ever appear in the browser's DevTools console
and never on screen: `public/brain/store.js` logs `[brain/store] เปิด EventSource ไม่สำเร็จ`
("could not open EventSource") and two similar reconnect messages.

Found a label that is missing here, or a translation that reads badly? Please open an issue — see
[Contributing](../README.md#contributing).
