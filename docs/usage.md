# Usage

← [back to README](../README.md) · [ภาษาไทย](usage.th.md)

The interface is in Thai. This page is the manual **and** the dictionary: every label you can see on
screen is translated in the [Label glossary](#label-glossary) at the bottom. The data itself — tool
names, file paths, models, timers, token counts, error text — is verbatim from your own transcripts,
in whatever language you and your agents work in.

**Contents**

- [The three views](#the-three-views)
- [Classic view](#classic-view)
- [NEURAL CORE (3D view)](#neural-core-3d-view)
- [PIXEL OFFICE (pixel view)](#pixel-office-pixel-view)
- [What the statuses mean](#what-the-statuses-mean)
- [The quota bar](#the-quota-bar)
- [Demo mode](#demo-mode)
- [Limits and ceilings](#limits-and-ceilings)
- [HTTP endpoints](#http-endpoints)
- [Label glossary](#label-glossary)

---

## The three views

| | Classic | NEURAL CORE | PIXEL OFFICE |
| --- | --- | --- | --- |
| URL | `/` | `/brain.html` | `/pixel.html` |
| Rendering | 2D SVG | 3D WebGL (three.js, vendored) | 2D Canvas pixel art, every sprite drawn in code (no image files) |
| Best for | exact numbers, walking tool calls, drilling into errors | the shape of the system at a glance | who is doing what right now, told as a story |
| Needs WebGL | no | **yes** | no |
| Data source | the same `/api/stream` SSE feed | the same `/api/stream` SSE feed | the same `/api/stream` SSE feed |

`--open` always opens **NEURAL CORE** (the 3D view); the server also prints all three URLs in its
startup banner. Every view links to the other two: the classic view has `NEURAL CORE` and
`PIXEL OFFICE` links at the end of its header (after the connection indicator). The 3D view
has `← หน้าคลาสสิก` ("classic view") and `PIXEL OFFICE` links in its bottom-right control bar, and
shows the classic link on its own when the browser has no WebGL. The pixel view has `คลาสสิก`
("classic") and `NEURAL CORE` links at the top right, plus a `ดูละเอียดในหน้าคลาสสิก →` ("see full
detail in the classic view") link at the bottom of its detail panel.

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
| `☐ เตือนซ้ำเมื่อรอฉัน` | repeat the wait-for-user alert until the waiting state clears |
| `เสียง AI — ปิด / เอฟเฟกต์ / พูด+เอฟเฟกต์` | choose off, event effects only, or Thai speech plus effects |
| `รีเซ็ตมุมมอง` | reset zoom/pan and unpin dragged nodes |
| `NEURAL CORE` · `PIXEL OFFICE` | end of the header: switch to the 3D view or the pixel office (same stream, nothing to restart) |
| click a node | open the side panel for that session or sub-agent |
| click a row in the panel | expand it (full tool input, error text, deny reason) |
| click a row in the waste table | drill into that error category |
| `← กลับไปตารางหมวด` | go back from a drill-down |
| `✕` | close the side panel |

**Keyboard:** `Enter` or `Space` on a focused node opens its panel; `Escape` closes the panel.
Only the audio mode and `เตือนซ้ำเมื่อรอฉัน` preference are remembered between reloads; no activity
or transcript data is stored in your browser.

The audio engine shared by all three views has three modes. `ปิด` (off) is the default and silences
everything. `เอฟเฟกต์` (effects) plays cues without speech. `พูด+เอฟเฟกต์` (speech + effects) adds
brief Thai announcements after the user starts audio with a click. Every newly observed event gets
a recognisable cue for its event family with subtle variation; speech is reserved for meaningful
state changes and compact summaries of rapid bursts. Phrase pools do not repeat the same line twice
in a row and use ordinary spoken Thai—`ผู้ช่วย` (helper), for example—instead of implementation
jargon.

With `เตือนซ้ำเมื่อรอฉัน` enabled, entering a wait-for-user state alerts immediately. It repeats an
effect after about 30 seconds, includes speech after about 90 seconds in `พูด+เอฟเฟกต์` mode, then reminds about every
120 seconds until the wait clears. Background-tab throttling or computer sleep can delay those timers.
Multiple waiting sessions are combined into one reminder. The
setting remains remembered while audio is off, but produces no sound until an audible mode is
selected.

Repeated SSE snapshots never replay sounds, and the first snapshot is a silent baseline rather than
old history. Effects are generated locally with Web Audio. Speech prefers an installed local `th-*`
voice exposed through Web Speech on Windows, macOS, or another supported OS; if no Thai voice is
installed, the machine's default local voice speaks an English version of the same cues (the button
tooltip shows which voice is in use), and if no local voice exists at all the feature falls back
safely to effects only. The audio path sends no text or activity
data over the network.

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
| `เสียง AI — ปิด / เอฟเฟกต์ / พูด+เอฟเฟกต์` | choose the shared audio mode; the core pulses in time with cues/speech |
| `เตือนซ้ำเมื่อรอฉัน: เปิด / ปิด` | enable or disable repeated wait-for-user reminders |
| `ทดสอบฉาก` | scenario dropdown — **only appears in fixture mode** |
| `← หน้าคลาสสิก` | back to the classic view |
| `PIXEL OFFICE` | switch to the pixel office view |

**Mouse:** left-drag orbits · right-drag (or `Shift` + left-drag) pans · wheel zooms · two fingers
pan and pinch. There is momentum, so it keeps gliding after you let go. A click within 6 px of a
node selects it and focuses the camera on it.

**Keyboard:** `Escape` deselects · `Space` toggles auto-rotate. That is all of them.

> If you zoom far out and press `รีเซ็ตกล้อง`, the framing comes back but the zoom distance may not.
> Reload the page for a guaranteed default camera.

> If the browser cannot start WebGL you get a message saying so, with a link back to the classic
> view. A watchdog also warns if no first frame has arrived after 12 seconds — try `?quality=low`.

---

## PIXEL OFFICE (pixel view)

A 2D pixel-art office that tells the same data as a story. Every Claude Code session is a **room**,
its main agent is the **lead** (`หัวหน้า`), and every running sub-agent is a **helper**
(`ผู้ช่วย`). Characters walk to the station that matches the tool they are really running, so you
can tell who is reading, searching, running commands or waiting on you from where they stand. It is
plain Canvas 2D — no WebGL — and every sprite is drawn in code, so there are no image files and
nothing to download.

### Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ PIXEL OFFICE ● live  [rooms · busy · waiting · helpers · tools · tokens]   │
│                [audio mode ▾] [☐ repeat reminders]  [classic] [NEURAL CORE]│
├──────────────────────────────────────────────────┬─────────────────────────┤
│  OP  my-project  thinking    ← room nameplate    │ [−] ×2 [+] [fit]        │
│ ┌──────────────────────────────────────────────┐ │ [captions: auto] [?]    │
│ │ door · stations along the back wall · phone  │ ├─────────────────────────┤
│ │ ▭ ▭ ▭ ▭ ▭  helper desks        lead's corner │ │ detail panel            │
│ │ ▭ ▭ ▭ ▭ ▭                      rug · couch   │ │ (click a character)     │
│ └──────────────────────────────────────────────┘ ├─────────────────────────┤
├───────────────────────────────────┐              │ ห้อง (room list)         │
│ event log (60 rows, click a row)  │              │                         │
└───────────────────────────────────┴──────────────┴─────────────────────────┘
```

On a narrow screen (760 px or less) the stat chips and audio controls fold away behind a `สรุป ▾`
("summary") button — which still shows how many sessions are waiting on you — the event log and the
room list start collapsed, and the detail panel becomes a bottom sheet.

### The office

- **One room per session**, laid out in a grid sized to the part of the screen the panels do not
  cover (three or four rooms on a 1440×900 screen come out as 2×2). A room keeps its place: new
  rooms are added, existing ones are not reshuffled.
- A **nameplate** floats above each room: the model tag, the room name (session title → name →
  project folder → first 8 characters of the session id) and a one-word state — `ทำงาน`, `คุมงาน`,
  `รอคุณ`, `คิด`, `ติดด่าน`, `ว่าง`, `ไม่ทราบ` or `ปิดแล้ว` (see the
  [glossary](#9-pixel-office--top-bar-tools-rooms-and-event-log)). From zoom ×2 up it also shows the
  project folder, git branch and surface when they fit. At ×1, where the captions over characters
  are hidden, it shows what the lead is doing instead, plus `· ผู้ช่วย N` (N helpers working). Click
  a nameplate to go to that room.
- Along the **back wall**, left to right: the door, mailbox, bookshelf, filing cabinet, terminal,
  whiteboard, globe kiosk, toolbox, printer, coffee machine, CCTV camera and phone booth. A
  **scoreboard** on the wall shows finished/total helpers for the session, and turns orange once any
  of them has failed.
- The **lead's corner** is on the right: a big desk, a rug and a couch. **Helper desks** fill the
  floor in rows of five. A room grows (and later shrinks) ten desks at a time, and a very big room
  gets extra side doors in its left wall so helpers do not all queue at one door.
- A **closed session** keeps its room with the lights off and a `ปิดแล้ว · N นาทีก่อน` ("closed · N
  min ago") sign for `--stale-minutes` (30 by default), exactly as long as the other views keep it.

### The characters

- The **lead** wears a tie and a headset. Each **helper** gets glasses, a cap, headphones or a
  beanie from its agent type, so helpers of the same type dress alike.
- **Every agent always looks the same.** Skin, hair and hairstyle are derived from its id, so you
  can follow one character around the room, and it looks the same again after a reload.
- **Shirt colour is the model:**

| Shirt | Tag | Model |
| --- | --- | --- |
| green | `HA` | Haiku |
| blue | `SO` | Sonnet |
| purple | `OP` | Opus |
| orange | `FA` | Fable |
| grey | — | unknown (no reply from the model in the transcript yet) |

Only **running** sub-agents become characters. A helper that had already finished the first time
the page saw it is not drawn — it only counts on the scoreboard.

### Stations — where each tool is worked

| Station | Tools | What you see |
| --- | --- | --- |
| 📚 bookshelf | `Read` | reading a book |
| 🗄️ filing cabinet | `Grep`, `Glob` | reaching into the drawers |
| 🖥️ terminal | `Bash`, `PowerShell` | typing, standing up |
| ✏️ own desk | `Edit`, `MultiEdit`, `NotebookEdit`, `Write` — and any tool not in this table | sitting and typing |
| 🌐 globe kiosk | `WebFetch`, `WebSearch` | typing at the kiosk |
| 📋 whiteboard | `TodoWrite`, `Workflow` | writing on the board |
| 🧰 toolbox | `Skill`, `ToolSearch`, every `mcp__*` tool | at the toolbox, picking a tool or plugging in |
| 📹 CCTV | `Monitor` | standing under the camera, looking up |
| 🖨️ printer | `Artifact` | at the printer |
| ☎️ phone booth | `AskUserQuestion` | on the phone |
| 🤖 the floor | `Agent`, `Task` | the lead walks between its helpers' desks; a helper that hires helpers of its own stands beside its desk |

The lead goes where its **first running tool that is not `Agent`/`Task` or `AskUserQuestion`**
belongs. What the lead does in every other state:

| Session status | Where the lead is | Signs |
| --- | --- | --- |
| ⚙️ tool | at the station of that tool | caption: the tool, its target and a clock |
| 🤖 delegating | walks between two or three of its helpers' desks, pausing at each | `สั่งงานผู้ช่วย · ทำงานอยู่ N คน` ("delegating · N working") |
| 🙋 waiting — a question | phone booth, on the phone | blinking ❓, the phone rings |
| 🙋 waiting — permission | phone booth, hand raised | blinking ❗ |
| 💭 thinking | at the whiteboard, alternating writing and pondering | thought bubble; a 💡 for a moment when a thinking block arrives |
| ⛔ blocked | slumped at its desk | rain cloud overhead, ⚠️ beside the head |
| 😴 idle | at the coffee machine; after 45 s idle it naps on the couch | ☕, then Zzz |
| closed | walks out through the door, then the lights go off | `ปิดแล้ว · N นาทีก่อน` sign |

**Helpers do not run across the room for every call.** A helper's tool changes every couple of
seconds, and a walk from a back desk can take several, so a helper only gets up when it will
plausibly arrive in time — the station is within 8 tiles, or the tool has already been running long
enough to cover the walk. Otherwise it does that station's work at its own desk, with the station's
icon in a thought bubble. At most three characters work at or queue for one station; the rest work
at their desks the same way. A helper with no tool running sits and thinks at its desk.

### Story beats

- **A prompt arrives** as a letter that flies in through the door to the mailbox. The lead walks
  over and reads it, with `📬 คำสั่งใหม่: "…"` ("new prompt") and the real prompt text shown above
  the caption while it does.
- **Hired helpers come in through the door** (in big rooms, the door nearest their desk) a few at a
  time, and take a free desk.
- **An error** makes the character jolt, with sparks at the station (smoke at the terminal); a
  denial adds a red stamp.
- **A finished helper celebrates** (sparkles) or **looks sad** on failure (a small rain cloud),
  carries its report to **whoever hired it** — the lead, or the helper that spawned it — and hands
  it over. The hirer answers with a heart or ✓, or a ✗ if the work failed. Then the helper walks out
  through the door. If the hirer is far away, or the room is full and other helpers are waiting to
  come in, it hands the report over from where it stands (the paper flies across the room) and
  vanishes in a puff. A helper that was stopped just leaves.
- **What an agent says** (its short text replies) appears in a speech bubble above it for a few
  seconds, and whenever the audio engine plays a cue or speaks, the character the event is about
  (or its room's lead) mouths along.
- **A session that ends**: the lead walks out through the door and the room's lights go off.

The first snapshot is a silent baseline, as it is for audio: everyone is placed straight at their
spot, with no walk-ins and no story lines — just one `💡 เปิดไฟออฟฟิศ: …` ("office lights on") line in
the event log. Everything after that is narrated there, one line per beat, and bursts (a storm
finishing dozens of helpers at once) are combined into one line per room.

### Captions — honest by design

- A caption **always names the real current tool or state** from the latest snapshot, with a clock
  — for example `📖 อ่าน server.mjs 0:12` ("read server.mjs"). The picture can lag a little behind
  the data (people have to walk), the caption does not.
- A tool that **started and ended between two polls** (~700 ms) is never seen as running. While the
  lead is thinking, the office may **replay** it — the lead briefly walks to that station — but the
  caption then reads `✓ เมื่อกี้ · …` ("✓ just now · …") and the detail panel marks it
  `ภาพย้อนหลัง` ("replay"). Real state always wins: a replay is dropped the moment the lead is no
  longer thinking.
- **Caption modes** (the `ป้าย:` button): `อัตโนมัติ` (auto) shows the leads' captions from zoom ×2
  and a helper's when you select or hover it, or at zoom ×4 (an icon chip at ×4, full text from ×5);
  `ทั้งหมด` (all) shows every caption; `ปิด` (off) hides them all. Captions give way to each other so
  they never pile up on someone's face — the selected and hovered characters always win.

### The camera

The camera **only moves when you move it** — drag, wheel, `−`/`+`, `จัดกรอบ` (fit), arrow keys, or
clicking something that means "go there" (a room in the list, a nameplate, an event-log row, a
double-clicked character). The one exception is a single automatic fit when the first data with a
room arrives. A new room that appears off-screen gets a toast (at most one every 45 s), not a camera
move.

If a room that is **waiting on you or blocked** has its lead out of view — off-screen or hidden
under a panel — a small badge appears at the edge of the visible area pointing towards it, and the
room's row in the `ห้อง` list blinks. Click either one to go there.

Zoom goes in whole steps from ×1 to ×8, so every pixel of the art stays a crisp square.

### Controls

| Control | What it does |
| --- | --- |
| drag the scene | pan |
| wheel · `−` / `+` | zoom one step (×1–×8); the wheel zooms around the cursor |
| `จัดกรอบ` | fit every room in view |
| `ป้าย: อัตโนมัติ / ทั้งหมด / ปิด` | caption mode: auto / all / off — click to cycle |
| `?` | the legend, `อ่านฉากออฟฟิศ` ("reading the office scene"): characters, stations, shirt colours, signs |
| click a character | select it and open the detail panel |
| double-click a character | select it and centre the camera on it (double-click an empty spot in a room = go to that room) |
| click empty floor | deselect |
| click a nameplate or an edge badge | go to that room |
| `ห้อง` list | click a room to go to it; click the header to fold / unfold the list |
| `บันทึกเหตุการณ์` rows | click a row to select that event's character and go to it; click the header to fold / unfold |
| `เสียง AI — ปิด / เอฟเฟกต์ / พูด+เอฟเฟกต์` | the shared audio mode |
| `☐ เตือนซ้ำเมื่อรอฉัน` | repeat wait-for-user reminders |
| `ทดสอบฉาก` | scenario dropdown — **only appears in fixture mode** |
| `คลาสสิก` / `NEURAL CORE` | switch to the classic / 3D view |
| `✕` | close the detail panel |

**Keyboard:** `+` zoom in · `-` zoom out · `0` fit · arrow keys pan (`Shift` for bigger steps) ·
`Esc` closes the legend first, then the detail panel. Keys are ignored while you are in a text box
or dropdown.

**Touch:** one finger pans, a tap selects, a pinch zooms one step at a time.

### The detail panel

Everything in the panel comes from the **latest snapshot**, not from what the character happens to
be acting out:

- **Header:** `หัวหน้า` / `ผู้ช่วย` (lead / helper), the name, where it runs (surface and kind for a
  lead, agent type and room for a helper), the model chip, and a state chip with a live clock.
- **`กำลังทำ`** ("doing now"): every running tool with its own clock — up to six, then
  `และอีก N รายการ` ("and N more"). A finished helper shows `งานล่าสุด` ("latest work") instead, with
  ✓ / ✗ and the duration.
- **`บนจอตอนนี้:`** ("on screen now"): what the character is acting out. When that is a replay it
  carries the `ภาพย้อนหลัง` chip, so you can always tell the story apart from the facts above it.
- **Four counters:** tool · error · `ถูกปฏิเสธ` (denied) · `โทเค็น` (tokens) for a lead; tool ·
  error · `เวลา` (time since it was hired) · tokens for a helper.
- **Text:** a lead shows your latest prompt, the last thing it said and its latest snag (error,
  denial or block); a helper shows the task it was given, the last thing it said, its latest snag
  and, once finished, the report it delivered.
- **Facts:** `ผู้ว่าจ้าง` (hired by — click it to walk up the hiring chain one step at a time),
  level, project and git branch, surface and version, model and effort, helpers (working / done /
  failed / total), `ตัดสินสถานะจาก` (the evidence the server used to decide a helper is still
  running — proven or inferred), outcome, `จบเทิร์นด้วย` (turn ended by), started, workflow id.
- **`ดูละเอียดในหน้าคลาสสิก →`** — the full tool history, error categories and raw inputs are in the
  classic view. The pixel view never calls `/api/agent`; it works from the stream alone.

When the character you selected finishes and walks out, the panel closes on its own.

> Motion: with `prefers-reduced-motion` set, particle bursts, idle bobbing and shaking are turned
> off and alert bubbles stay lit instead of blinking. The setting is read once, when the page loads.

> If `/activity-audio.js` fails to load, the page still runs and the audio control reads
> `เสียง AI: ไม่รองรับ` ("AI audio: not supported"). If anything else fails to load you get an error
> card with a link back to the classic view, and a watchdog speaks up if no first frame has arrived
> after 12 seconds.

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

All three views can render fake data so you can see the whole interface before you have anything
running. **`?fixture` means something different on the classic page than on the other two.** That
is deliberate.

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

### PIXEL OFFICE

```
http://127.0.0.1:7676/pixel.html?fixture=storm
```

The same scenario names as NEURAL CORE, played by the same fixture generator (two fake sessions,
one tick every 700 ms); an unknown name falls back to `auto`. It **animates for real**: the
connection pill reads `ต่อแล้ว (จำลอง)` ("connected (mock)"), a `ข้อมูลจำลอง` ("mock data") tag sits
next to the title, the same `โหมดข้อมูลจำลอง — ไม่ได้ต่อกับ session จริง` toast appears, and the
`ทดสอบฉาก` dropdown switches scenarios live. There is no `?quality` here — Canvas 2D has nothing to
tune.

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
| helpers drawn per room | 64 (pixel) | running helpers past the cap are not dropped silently: they are counted on a `+N ที่ไม่ได้วาด` ("+N not drawn") sign in the room's bottom-right corner and a `ไม่ได้วาด` ("not drawn") chip in the top bar, and walk in when a desk frees up |
| station queue | 3 characters (pixel) | the next one does that station's work at its own desk, with the station's icon in a thought bubble |
| zoom | ×1–×8, whole steps (pixel) | keeps every art pixel a crisp square |
| feed rows | 60 (3D and pixel) | live feed / event log length |
| SSE keep-alive | 20 s | `: ping` comment |
| reconnect | 1.5 s fixed (classic) · 1.5 s ×1.5 up to 10 s (3D and pixel) | after the stream drops |

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
`{n}`, `{tool}`, `{dur}` and friends are values filled in at runtime. In sections 1–8, "both" means
the classic view and NEURAL CORE; the PIXEL OFFICE's labels are collected in sections 9–13, even
where a word also appears earlier.

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
| เตือนซ้ำเมื่อรอฉัน | Repeat reminders while waiting for me | checkbox |
| เสียง AI | AI audio | audio-mode control |
| ปิด / เอฟเฟกต์ / พูด+เอฟเฟกต์ | Off / Effects / Speech + effects | audio-mode choices |
| รีเซ็ตมุมมอง | Reset view | button |
| สลับมุมมอง | Switch view | accessible name of the `NEURAL CORE` · `PIXEL OFFICE` links at the end of the header |
| มุมมองสามมิติ — ภาพรวมของทั้งระบบในแวบเดียว | 3D view — the whole system at a glance | `NEURAL CORE` link tooltip |
| ออฟฟิศพิกเซล — ตัวละครเดินไปทำงานตามเครื่องมือที่ใช้จริง | Pixel office — characters walk to work at whatever tool is really running | `PIXEL OFFICE` link tooltip |
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
| เสียง AI · ปิด / เอฟเฟกต์ / พูด+เอฟเฟกต์ | AI audio · Off / Effects / Speech + effects | control bar |
| เตือนซ้ำเมื่อรอฉัน: เปิด / ปิด | Repeat reminders while waiting for me: On / Off | control bar |
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

### 9. PIXEL OFFICE — top bar, tools, rooms and event log

| Thai | English | Where |
| --- | --- | --- |
| กำลังต่อ… | Connecting… | connection pill |
| ต่อแล้ว / ต่อแล้ว (จำลอง) | Connected / Connected (mock) | connection pill |
| สตรีมหลุด | Stream lost | connection pill |
| สถานะการเชื่อมต่อสตรีม /api/stream | Connection status of /api/stream | pill tooltip |
| เชื่อมต่อสตรีม /api/stream อยู่ | Connected to /api/stream | pill tooltip |
| กำลังเล่นข้อมูลจำลอง — ไม่ได้ต่อกับ session จริง | Playing mock data — not connected to a real session | pill tooltip (fixture) |
| สตรีมหลุด — กำลังต่อใหม่อัตโนมัติ (ภาพบนจอคือสถานะล่าสุดก่อนหลุด) | Stream lost — reconnecting automatically (the screen shows the last state before it dropped) | pill tooltip |
| ข้อมูลจำลอง | Mock data | tag next to the title (fixture only) |
| หน้านี้เปิดด้วย ?fixture= — ทุกอย่างบนจอเป็นข้อมูลปลอม ไม่ใช่ session จริง | This page was opened with ?fixture= — everything on screen is fake, not a real session | that tag's tooltip |
| สรุป ▾ / สรุป · รอคุณ {n} ▾ | Summary ▾ / Summary · {n} waiting on you ▾ | narrow screens: shows / hides the chips and audio controls |
| แสดง/ซ่อนชิปสรุปและตัวควบคุมเสียง | Show / hide the summary chips and audio controls | that button's tooltip |
| ห้องเปิด | Rooms open | stat chip |
| session ที่ยังเปิดอยู่ (ห้องที่ไฟติด) | Sessions still open (rooms with the lights on) | chip tooltip |
| บนจอ {n} ห้อง · ตัวละคร {m} ตัว | {n} rooms on screen · {m} characters | chip tooltip |
| ทำงาน | Busy | stat chip |
| session ที่กำลังคิด / ใช้เครื่องมือ / คุมผู้ช่วย | Sessions thinking / using a tool / supervising helpers | chip tooltip |
| รอคุณ | Waiting on you | stat chip |
| session ที่รอคุณตอบคำถามหรือรออนุญาต | Sessions waiting for your answer or your permission | chip tooltip |
| ผู้ช่วยทำงาน | Helpers working | stat chip |
| sub-agent ที่กำลังทำงานอยู่ตอนนี้ | Sub-agents running right now | chip tooltip |
| เคยจ้างทั้งหมด {n} คน | {n} hired in total | chip tooltip |
| tool ค้าง | Tools running | stat chip |
| เครื่องมือที่กำลังรันอยู่ตอนนี้ (ของหัวหน้า + ผู้ช่วย) | Tools running right now (leads + helpers) | chip tooltip |
| โทเค็น | Tokens | stat chip |
| โทเค็นสะสม input + cache + output ของทุก session บนจอ | Cumulative input + cache + output tokens of every session on screen | chip tooltip |
| ไม่ได้วาด | Not drawn | stat chip — only while some helpers do not fit |
| ผู้ช่วยที่กำลังทำงานแต่ไม่ได้วาดเพราะห้องเต็ม {n} คน (ยังนับรวมในชิป “ผู้ช่วยทำงาน”) | {n} helpers working but not drawn because the room is full (still counted in the “Helpers working” chip) | chip tooltip |
| เสียง AI / เสียง AI: ไม่รองรับ | AI audio / AI audio: not supported | audio control |
| ปิด / เอฟเฟกต์ / พูด+เอฟเฟกต์ | Off / Effects / Speech + effects | audio-mode choices |
| เตือนซ้ำเมื่อรอฉัน | Repeat reminders while waiting for me | checkbox |
| คลาสสิก | Classic | view link |
| หน้าคลาสสิก (กราฟ 2 มิติ + แผงรายละเอียดเต็ม) | Classic view (2D graph + full detail panel) | that link's tooltip |
| มุมมองสมอง AI สามมิติ | The 3D AI-brain view | `NEURAL CORE` link tooltip |
| ซูมออก / ซูมเข้า | Zoom out / Zoom in | `−` / `+` buttons |
| ระดับซูม (1–8) | Zoom level (1–8) | the `×N` readout |
| จัดกรอบ | Fit | button |
| จัดกรอบให้เห็นทุกห้อง | Fit so every room is visible | its tooltip |
| ป้าย: อัตโนมัติ / ทั้งหมด / ปิด | Captions: Auto / All / Off | caption button |
| ป้ายงานของหัวหน้าขึ้นเมื่อซูม ≥2 · ของผู้ช่วยขึ้นเมื่อเลือก/ชี้ หรือซูม ≥4 | Leads' captions appear from zoom ≥2 · a helper's when selected / hovered or at zoom ≥4 | tooltip (auto) |
| แสดงป้ายงานเหนือตัวละครทุกตัว | Show a caption over every character | tooltip (all) |
| ซ่อนป้ายงานทั้งหมด (ยังคลิกตัวละครดูรายละเอียดได้) | Hide every caption (you can still click a character for details) | tooltip (off) |
| (กดเพื่อสลับ อัตโนมัติ → ทั้งหมด → ปิด) | (click to cycle Auto → All → Off) | tooltip suffix |
| คำอธิบายสัญลักษณ์ในฉาก | Scene legend | `?` button |
| ทดสอบฉาก | Test scenario | dropdown (fixture only) — the same choices as the 3D view (section 6; `กำลังคิด` = thinking) |
| ห้อง | Rooms | room list header |
| ยังไม่มีห้อง | No rooms yet | room list, empty |
| พับรายชื่อห้อง / กางรายชื่อห้อง | Collapse / expand the room list | header tooltip |
| ไปที่ห้อง {name} ({state}) | Go to room {name} ({state}) | row tooltip |
| (อยู่นอกจอ) | (off-screen) | screen-reader suffix on a blinking row |
| ทำงาน · คุมงาน · รอคุณ · คิด · ติดด่าน · ว่าง · ไม่ทราบ · ปิดแล้ว | Working · Supervising · Waiting on you · Thinking · Blocked · Idle · Unknown · Closed | room state, in the list and on the nameplate |
| บันทึกเหตุการณ์ | Event log | bottom-left panel |
| ยังไม่มีเหตุการณ์ — ตัวละครจะเล่าเรื่องที่นี่ | No events yet — the characters will tell their story here | event log, empty |
| พับบันทึกเหตุการณ์ / กางบันทึกเหตุการณ์ | Collapse / expand the event log | header tooltip |
| คลิกเพื่อเลือกตัวละครของเหตุการณ์นี้ | Click to select this event's character | row tooltip |
| ออฟฟิศยังปิดไฟอยู่ | The office lights are still off | empty state |
| ยังไม่มี session — เปิด Claude Code แล้วไฟในออฟฟิศจะติดเอง | No sessions yet — start Claude Code and the office lights will come on | empty state |

### 10. PIXEL OFFICE — the scene: nameplates, captions and signs

| Thai | English | Where |
| --- | --- | --- |
| · ผู้ช่วย {n} | · {n} helpers | nameplate at zoom ×1 (helpers working) |
| ปิดแล้ว · {ago} | Closed · {ago} | sign in the middle of a closed room |
| เพิ่งปิด / {n} นาทีก่อน / {h} ชม. {m} นาทีก่อน | Just closed / {n} min ago / {h} h {m} min ago | that sign, and the detail panel |
| +{n} ที่ไม่ได้วาด | +{n} not drawn | sign in a room's bottom-right corner |
| {verb} {target} | {verb} {target} | caption while a tool runs — the verbs are in the next table |
| สั่งงานผู้ช่วย · ทำงานอยู่ {n} คน | Delegating to helpers · {n} working | lead caption |
| รอคุณตอบ · {question} | Waiting for your answer · {question} | lead caption |
| รออนุญาต · {tool} {target} | Waiting for permission · {tool} {target} | lead caption |
| คิดอยู่ | Thinking | caption |
| คิดอยู่ · ล่าสุด {tool} ✓ / ✗ | Thinking · last {tool} ✓ / ✗ | helper caption between tools |
| ว่าง | Idle | lead caption |
| ติดด่าน · {endedBy} | Blocked · {endedBy} | lead caption |
| ไม่ทราบสถานะ | Unknown status | lead caption |
| ปิดแล้ว | Closed | lead caption |
| ใช้เครื่องมือ | Using a tool | caption fallback |
| ✓ เมื่อกี้ · {tool} {target} | ✓ Just now · {tool} {target} | replay caption — a tool that already finished between two polls |
| 📬 คำสั่งใหม่: "{prompt}" | 📬 New prompt: "{prompt}" | extra line while the lead reads the letter |
| ส่งงานแล้ว | Report delivered | helper leaving after success |
| ไม่สำเร็จ ({outcome}) | Did not succeed ({outcome}) | helper leaving after a failure |
| ถูกหยุดกลางคัน | Stopped midway | helper that was stopped |
| จบงาน (ไม่ทราบผล) | Finished (outcome unknown) | helper leaving |
| ออกจากห้อง | Leaving the room | character walking out |
| ออฟฟิศพิกเซล: ลากเพื่อเลื่อนฉาก ล้อเมาส์เพื่อซูม คลิกตัวละครเพื่อดูรายละเอียด | Pixel office: drag to pan, wheel to zoom, click a character for details | canvas `aria-label` |

The verb in a caption, an event-log line or a `กำลังทำ` row comes from the tool:

| Thai | English | Tool |
| --- | --- | --- |
| อ่าน | Read | `Read` |
| ค้นหา | Search | `Grep`, `Glob` |
| รันคำสั่ง | Run a command | `Bash`, `PowerShell` |
| แก้ไฟล์ | Edit a file | `Edit`, `MultiEdit`, `NotebookEdit` |
| เขียนไฟล์ | Write a file | `Write` |
| ค้นเว็บ | Search the web | `WebFetch`, `WebSearch` |
| จดงาน | Note down tasks | `TodoWrite` |
| วางแผนงาน | Plan the work | `Workflow` |
| สั่งงานผู้ช่วย | Delegate to helpers | `Agent`, `Task` |
| ถามคุณ | Ask you | `AskUserQuestion` |
| หยิบเครื่องมือ | Pick up a tool | `Skill`, `ToolSearch` |
| ใช้ปลั๊กอิน | Use a plugin | `mcp__*` |
| เฝ้าดู | Watch | `Monitor` |
| ทำรายงาน | Make a report | `Artifact` |
| ใช้เครื่องมือ | Use a tool | anything else |

### 11. PIXEL OFFICE — detail panel

| Thai | English | Where |
| --- | --- | --- |
| หัวหน้า / ผู้ช่วย | Lead / Helper | role badge |
| หัวหน้าห้อง | Head of the room | lead subtitle |
| แอปเดสก์ท็อป / งานเบื้องหลัง | Desktop app / Background task | surface in the subtitle (`CLI` and `VS Code` stay as they are) |
| เบื้องหลัง | Background | session kind in the subtitle |
| ห้อง {name} | Room {name} | helper subtitle |
| ปิดแผงรายละเอียด (Esc) | Close the detail panel (Esc) | `✕` |
| ไม่ทราบรุ่น | Unknown model | model chip |
| สีเสื้อของตัวละครบอกโมเดล | The character's shirt colour shows the model | model chip tooltip |
| กำลังใช้เครื่องมือ | Using a tool | state chip |
| คุมงานผู้ช่วย (รอ sub-agent) | Supervising helpers (waiting on sub-agents) | state chip (lead) |
| คุมงานผู้ช่วยย่อย | Supervising its own helpers | state chip (helper) |
| รอคุณตอบคำถาม | Waiting for you to answer a question | state chip |
| รออนุญาต (น่าจะมีกล่องขอสิทธิ์ค้างอยู่) | Waiting for permission (probably a permission prompt is open) | state chip |
| รอคุณ | Waiting on you | state chip |
| กำลังคิด | Thinking | state chip |
| ติดด่าน — เทิร์นจบด้วย error/ถูกปฏิเสธ | Blocked — the turn ended on an error / a denial | state chip |
| ว่าง รอคำสั่ง | Idle — waiting for a prompt | state chip |
| ไม่ทราบสถานะ (ไม่มี transcript) | Unknown status (no transcript) | state chip |
| ปิดแล้ว · {ago} | Closed · {ago} | state chip |
| ส่งงานแล้ว | Report delivered | state chip (helper, success) |
| จบแล้ว / จบแล้ว (ไม่ทราบผลแน่ชัด) | Finished / Finished (outcome unknown) | state chip (helper) |
| ล้มเหลว ({outcome}) | Failed ({outcome}) | state chip (helper) |
| · ไม่อยู่ในข้อมูลล่าสุด | · not in the latest data | state suffix (lead) |
| · ออกจากออฟฟิศแล้ว | · has left the office | state suffix (helper) |
| ตัวละครนี้ออกจากออฟฟิศไปแล้ว — ด้านล่างคือข้อมูลล่าสุดที่เห็น | This character has left the office — below is the last data seen | note |
| ไม่พบข้อมูล | Not found | title |
| ไม่พบข้อมูลของตัวละครนี้ในสแนปช็อตล่าสุด | No data for this character in the latest snapshot | note |
| กำลังทำ | Doing now | section |
| งานล่าสุด | Latest work | section (finished helper) |
| ✓ เสร็จ: / ✗ พลาด: | ✓ Done: / ✗ Failed: | a helper's last finished tool |
| และอีก {n} รายการ | and {n} more | after six running tools |
| คิดอยู่ — ไม่มีเครื่องมือค้าง | Thinking — no tool running | row |
| นับเวลาจากความเคลื่อนไหวล่าสุดใน transcript | Timed from the last activity in the transcript | row detail |
| ว่าง รอคำสั่งจากคุณ | Idle — waiting for your prompt | row |
| ติดด่าน — รอคุณช่วยปลด | Blocked — waiting for you to unblock it | row |
| คุมงานผู้ช่วย | Supervising helpers | row |
| ไม่มีเครื่องมือค้างอยู่ | No tool running | empty |
| session ปิดไปแล้ว — ไม่มีงานค้าง | Session closed — nothing running | empty |
| ยังไม่มีข้อมูลเครื่องมือ | No tool data yet | empty (helper) |
| บนจอตอนนี้: | On screen now: | what the character is acting out |
| ภาพย้อนหลัง | Replay | chip on that line |
| ตัวละครกำลังเล่าย้อน tool ที่จบไปแล้วระหว่างรอบอัปเดต — ไม่ใช่สิ่งที่กำลังรันอยู่ | The character is replaying a tool that already finished between updates — not something running now | chip tooltip |
| ถูกปฏิเสธ | Denied | counter (lead) |
| เวลา | Time | counter (helper) |
| จำนวนครั้งที่เรียกเครื่องมือทั้ง session (ไม่รวมผู้ช่วย) | Tool calls in the whole session (helpers not included) | counter tooltip |
| ทำงานมาแล้ว (นับจากตอนถูกจ้าง) | Working for (counted from when it was hired) | counter tooltip |
| เวลาตั้งแต่ถูกจ้างจนเขียน transcript ครั้งสุดท้าย | Time from being hired to its last transcript write | counter tooltip |
| คำสั่งล่าสุดจากคุณ | Your latest prompt | field (lead) |
| งานที่ได้รับ | Task given | field (helper) |
| พูดล่าสุด | Last said | field |
| สะดุดล่าสุด | Latest snag | field |
| ถูกปฏิเสธ: / ถูกบล็อก: / guard: / error: | Denied: / Blocked: / guard: / error: | snag prefix |
| รายงานที่ส่ง | Report delivered | field (finished helper) |
| ผู้ว่าจ้าง | Hired by | fact row (clickable) |
| หัวหน้า · {room} / ผู้ช่วย · {name} | Lead · {room} / Helper · {name} | hired-by value |
| ผู้ช่วย {id} (ไม่อยู่ในข้อมูลล่าสุด) | Helper {id} (not in the latest data) | hired-by value |
| คลิกเพื่อดูผู้ว่าจ้าง / ผู้ว่าจ้างไม่อยู่ในข้อมูลล่าสุดแล้ว | Click to see the hirer / The hirer is no longer in the latest data | hired-by tooltip |
| ลำดับชั้น | Level | fact row |
| หัวหน้าจ้างตรง (ชั้น 1) / ผู้ช่วยจ้างต่อ (ชั้น {d}) | Hired directly by the lead (level 1) / Hired by another helper (level {d}) | level value |
| โปรเจกต์ | Project | fact row |
| เปิดผ่าน | Opened via | fact row (surface · version) |
| โมเดล | Model | fact row |
| ผู้ช่วย / จ้างต่อ | Helpers / Sub-hires | fact row (lead / helper) |
| ยังไม่ได้จ้าง | None hired yet | helpers value |
| ทำงาน {n} · จบ {n} · พลาด {n} · รวม {n} · (ตัดทิ้ง {n}) | {n} working · {n} done · {n} failed · {n} total · ({n} cut off) | helpers value |
| ตัดสินสถานะจาก | Status decided from | fact row — values below, followed by the raw code |
| หลักฐานที่ server ใช้ตัดสินว่าผู้ช่วยตัวนี้ยังทำงาน/จบแล้ว | The evidence the server used to decide whether this helper is still running | its tooltip |
| ผลลัพธ์ | Outcome | fact row |
| สำเร็จ · ล้มเหลว · error · ถูกหยุดกลางทาง · ไม่ทราบผล (เงียบไปเฉย ๆ) | Succeeded · Failed · error · Stopped midway · Outcome unknown (it just went quiet) | outcome values |
| จบเทิร์นด้วย | Turn ended by | fact row (lead) |
| เริ่มเมื่อ | Started | fact row |
| ดูละเอียดในหน้าคลาสสิก → | See full detail in the classic view → | link |
| หน้าคลาสสิกมีรายการ tool ทั้งหมด หมวด error และข้อมูลดิบของทุก agent | The classic view has every tool call, the error categories and the raw data of every agent | link tooltip |

`ตัดสินสถานะจาก` values — this is what tells you whether "still running" was proven or inferred:

| Thai | English | Code |
| --- | --- | --- |
| หัวหน้าได้รับแจ้งว่างานเสร็จแล้ว | The lead was notified that the task finished | `task-notification` |
| หัวหน้ายังรอผลจากผู้ช่วยตัวนี้อยู่ | The lead is still waiting for this helper's result | `parent-pending` |
| หัวหน้ายังรออยู่ แต่ไม่มีความเคลื่อนไหวมานานแล้ว | The lead is still waiting, but nothing has moved for a long time | `parent-pending-stale` |
| บันทึก workflow บอกว่าเริ่มแล้วและยังไม่จบ | The workflow journal says it started and has not finished | `journal-started` |
| บันทึก workflow บอกว่าเริ่มแล้ว แต่เงียบมานาน | The workflow journal says it started, but it has been quiet for a long time | `journal-started-stale` |
| บันทึก workflow ระบุว่าจบแล้ว ({x}) | The workflow journal says it finished ({x}) | any other `journal-*` |
| มีเครื่องมือค้างอยู่ใน transcript ของมันเอง | A tool is still outstanding in its own transcript | `own-tool-in-flight` |
| มีเครื่องมือค้าง แต่เงียบมานาน | A tool is outstanding, but it has been quiet for a long time | `own-tool-in-flight-stale` |
| transcript ของมันเองจบเทิร์นแล้ว ({x}) | Its own transcript has ended its turn ({x}) | any other `own-*` |
| ไม่มีสัญญาณชัด — อนุมานว่ายังทำงาน (ไฟล์เพิ่งขยับไม่นาน) | No clear signal — assumed still running (the file changed recently) | `assumed-running` |
| เงียบนานเกินเกณฑ์ — ถือว่าจบแล้ว | Silent past the threshold — treated as finished | `idle-timeout` |
| ข้อมูลจำลอง | Mock data | `fixture` |

### 12. PIXEL OFFICE — legend (`?`)

| Thai | English | Where |
| --- | --- | --- |
| อ่านฉากออฟฟิศ | Reading the office scene | legend title |
| คำอธิบายสัญลักษณ์ในฉากออฟฟิศ | Legend of the office scene | legend `aria-label` |
| ปิดคำอธิบาย | Close the legend | `✕` |
| ตัวละคร | Characters | section |
| หัวหน้า = ตัวหลักของ session (ผูกเนคไท) · ผู้ช่วย = sub-agent ที่ถูกจ้าง (แว่น/หมวก/หูฟังตามชนิดงาน) — agent ตัวเดิมหน้าตาเดิมเสมอ | Lead = the session's main agent (wears a tie) · Helper = a hired sub-agent (glasses / cap / headphones by agent type) — the same agent always looks the same | note |
| สถานีงาน → เครื่องมือ | Work stations → tools | section |
| ตู้จดหมาย · คำสั่งใหม่จากคุณ — หัวหน้าเดินมาเปิดอ่าน | Mailbox · a new prompt from you — the lead walks over and opens it | station |
| ชั้นหนังสือ · อ่านไฟล์ | Bookshelf · reading files | station |
| ตู้เอกสาร · ค้นหาในโค้ด | Filing cabinet · searching the code | station |
| เทอร์มินัล · รันคำสั่ง | Terminal · running commands | station |
| โต๊ะของตัวเอง · แก้/เขียนไฟล์ (และเครื่องมืออื่น ๆ) | Own desk · editing / writing files (and any other tool) | station |
| ตู้เว็บ · ค้นเว็บ | Web kiosk · searching the web | station |
| ไวต์บอร์ด · จด/วางแผนงาน — และยืนคิด | Whiteboard · noting / planning work — and standing there thinking | station |
| แผงเครื่องมือ · หยิบเครื่องมือ/ใช้ปลั๊กอิน | Toolbox · picking a tool / using a plugin | station |
| กล้องวงจรปิด · เฝ้าดู | CCTV · watching | station |
| เครื่องพิมพ์ · ทำรายงาน | Printer · making a report | station |
| ตู้โทรศัพท์ · ถามคุณ — ยกมือ = รออนุญาต | Phone booth · asking you — hand raised = waiting for permission | station |
| เดินคุมงาน · สั่งงานผู้ช่วยแล้วเดินตรวจ | Walking the floor · delegating to helpers, then walking round to check on them | station |
| มุมกาแฟ/โซฟา · ว่าง — จิบกาแฟ แล้วงีบบนโซฟาถ้าว่างนาน | Coffee corner / couch · idle — sips coffee, then naps on the couch if idle for long | station |
| ประตู · ผู้ช่วยเดินเข้ามารับงาน · ส่งรายงานแล้วเดินออก | Door · helpers walk in to take a job · hand in their report and walk out | station |
| สีเสื้อ → โมเดล | Shirt colour → model | section |
| ไม่ทราบรุ่น | Unknown model | grey shirt |
| สัญญาณในฉาก | Signs in the scene | section |
| เมฆฝนเหนือโต๊ะ · ติดด่าน — เทิร์นจบด้วย error/ถูกปฏิเสธ รอคุณช่วย | Rain cloud over the desk · blocked — the turn ended on an error / a denial, waiting for your help | sign |
| ป้ายกระพริบ · รอคุณตอบ หรือรออนุญาต | Blinking sign · waiting for your answer or your permission | sign |
| ลูกโป่งความคิด · กำลังคิด ไม่มีเครื่องมือค้าง | Thought bubble · thinking, no tool running | sign |
| นั่งพิมพ์ + ไอคอนสถานี · ผู้ช่วยทำงานของสถานีนั้นที่โต๊ะตัวเอง (tool เพิ่งเริ่ม สถานีไกล หรือคิวเต็ม) — tool จริงดูที่ป้าย | Typing at the desk + a station icon · the helper is doing that station's work at its own desk (the tool just started, the station is far away, or its queue is full) — the caption names the real tool | sign |
| ปุ๊ฟหาย · ผู้ช่วยจบงานไกลผู้จ้าง/ห้องเต็ม: ยื่นรายงานจากที่ยืนแล้วออกไป (ฟีดบอกผลงาน) | Poof · a helper that finished far from its hirer, or in a full room, hands in its report from where it stands and leaves (the event log tells the result) | sign |
| “✓ เมื่อกี้” · ภาพย้อน tool ที่จบไปแล้วระหว่างรอบอัปเดต — ไม่ใช่สิ่งที่กำลังทำอยู่ | “✓ just now” · a replay of a tool that finished between updates — not what is happening now | sign |
| ไฟห้องดับ · session ปิดแล้ว (ค้างบนจอได้ถึง 30 นาที) | Room lights off · the session has closed (stays on screen for up to 30 minutes) | sign |
| การใช้งาน | How to use it | section |
| ลาก = เลื่อนฉาก · ล้อเมาส์ = ซูม · คลิกตัวละคร = ดูรายละเอียด · ดับเบิลคลิก = ตามตัว · Esc = ปิดแผง | Drag = pan · wheel = zoom · click a character = details · double-click = go to that character · Esc = close the panel | note |

The legend also repeats the tool names (`Read`, `Grep · Glob`, …) next to each station, as in the
[stations table](#stations--where-each-tool-is-worked).

### 13. PIXEL OFFICE — event log, toasts and messages

`{room}` is a room name. `{who}` is a helper written as `type·id` (for example `scout·a3f9`), or
`ผู้ช่วย {n} คน ({types})` ("{n} helpers ({types})") when several are reported in one line.

| Thai | English | When |
| --- | --- | --- |
| 💡 เปิดไฟออฟฟิศ: {n} ห้อง · ผู้ช่วยกำลังทำงาน {m} คน | 💡 Office lights on: {n} rooms · {m} helpers working | first line after the page loads |
| 💡 เปิดไฟห้อง {room} | 💡 Lights on in {room} | a new session |
| 🌙 {room}: ปิดห้องแล้ว | 🌙 {room}: room closed | a session ended |
| 📬 {room}: ได้รับคำสั่งใหม่ — "{prompt}" | 📬 {room}: got a new prompt — "{prompt}" | a new prompt |
| {icon} {room}: {verb} {target} | {icon} {room}: {verb} {target} | the lead started a new tool |
| 🙋 {room}: รอคุณตอบ / ✋ {room}: รออนุญาต | 🙋 {room}: waiting for your answer / ✋ {room}: waiting for permission | the session started waiting |
| ⛔ {room}: ติดด่าน — {why} | ⛔ {room}: blocked — {why} | the turn ended on a problem |
| ไม่ทราบสาเหตุ | reason unknown | `{why}` fallback |
| ☕ {room}: งานเสร็จ พักจิบกาแฟ | ☕ {room}: work done, coffee break | the session went idle |
| 💥 {room}: error — {text} | 💥 {room}: error — {text} | the lead hit an error |
| {tool} ล้มเหลว / {n} ครั้ง | {tool} failed / {n} times | `{text}` fallback |
| 🛑 {room}: ถูกปฏิเสธ — {label} | 🛑 {room}: denied — {label} | a tool call was denied |
| 🤝 {room}: รับผู้ช่วย {n} คน ({types}) | 🤝 {room}: hired {n} helpers ({types}) | helpers hired by the lead |
| 🤝 {room}: {type·id} รับผู้ช่วย {n} คน ({types}) | 🤝 {room}: {type·id} hired {n} helpers ({types}) | a helper hiring helpers of its own |
| 💥 {room}: ผู้ช่วย {n} คนเจอ error | 💥 {room}: {n} helpers hit errors | three or more at once |
| 💥 {room}: {who} error — {text} | 💥 {room}: {who} error — {text} | a helper hit an error |
| ✅ {room}: {who} ส่งงานให้หัวหน้าแล้ว / ส่งงานให้ {hirer} แล้ว | ✅ {room}: {who} handed its report to the lead / to {hirer} | helpers finished |
| ✅ {room}: {who} ส่งงานแล้ว | ✅ {room}: {who} delivered | finished helpers with different hirers |
| ❌ {room}: {who} ทำงานไม่สำเร็จ ({outcomes}) | ❌ {room}: {who} did not succeed ({outcomes}) | helpers failed |
| ⏹ {room}: {who} ถูกหยุดกลางคัน | ⏹ {room}: {who} was stopped midway | helpers stopped |
| ❔ {room}: {who} จบงาน (ไม่ทราบผล) | ❔ {room}: {who} finished (outcome unknown) | helpers finished without a clear outcome |
| 🔌 ต่อสตรีมกลับมาแล้ว | 🔌 Stream reconnected | after a drop |
| 🔌 สตรีมหลุด — กำลังต่อใหม่ (ภาพค้างที่สถานะล่าสุด) | 🔌 Stream lost — reconnecting (the picture is frozen at the last state) | stream dropped |
| โหมดข้อมูลจำลอง — ไม่ได้ต่อกับ session จริง | Mock data mode — not connected to a real session | toast (fixture) |
| สลับสถานการณ์: {scenario} | Switched scenario: {scenario} | toast |
| ห้องใหม่ “{room}” อยู่นอกจอ — กด “จัดกรอบ” หรือเลือกจากรายชื่อห้อง | New room “{room}” is off-screen — press “Fit” or pick it from the room list | toast |
| มีห้องใหม่ {n} ห้องอยู่นอกจอ — กด “จัดกรอบ” หรือลากเพื่อเลื่อนดู | {n} new rooms are off-screen — press “Fit” or drag to look around | toast |
| ออฟฟิศใหญ่กว่าจอ ({n} ห้องเห็นไม่ครบ) — ลากเพื่อเลื่อนดู หรือเลือกห้องจากรายชื่อ | The office is bigger than the screen ({n} rooms not fully visible) — drag to look around, or pick a room from the list | toast, after the first fit |
| กำลังเปิดไฟออฟฟิศ — โหลดสคริปต์และต่อสตรีม /api/stream … | Turning on the office lights — loading scripts and connecting to /api/stream … | boot card |
| ออฟฟิศเปิดไม่ขึ้น | The office would not open | boot error title |
| ยังไม่มีเฟรมแรกหลัง 12 วินาที — ลองรีเฟรช หรือเปิด DevTools › Console ดูว่าไฟล์ใน /pixel/ หรือ /brain/ ตัวไหนโหลดไม่ขึ้น | No first frame after 12 seconds — try refreshing, or open DevTools › Console to see which file under /pixel/ or /brain/ failed to load | boot watchdog |
| หน้านี้ต้องเปิด JavaScript — หรือใช้หน้าคลาสสิกที่ /index.html | This page needs JavaScript — or use the classic view at /index.html | `<noscript>` |

The pixel boot card also reuses three labels from section 7: `เปิด DevTools › Console เพื่อดูรายละเอียดเต็ม`,
`โหลดสคริปต์ไม่สำเร็จ: {src}` and `← กลับไปหน้าคลาสสิก`.

---

A few labels are not in the tables above, because they only ever appear in the browser's DevTools
console and never on screen: `public/brain/store.js` logs `[brain/store] เปิด EventSource ไม่สำเร็จ`
("could not open EventSource") and two similar reconnect messages, and `public/pixel.html` logs
`[pixel] โหลด /activity-audio.js ไม่สำเร็จ — ทำงานต่อแบบไม่มีเสียง` ("could not load
/activity-audio.js — carrying on without sound").

Found a label that is missing here, or a translation that reads badly? Please open an issue — see
[Contributing](../README.md#contributing).
