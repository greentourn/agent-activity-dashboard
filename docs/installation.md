# Installation

← [back to README](../README.md) · [ภาษาไทย](installation.th.md)

There is no build step, no package to install, and no configuration file. If you have Node.js, you
already have everything.

---

## 1. Check Node.js

```bash
node --version
```

You need **v18.0.0 or newer**. If that prints a lower version or an error, install Node from
[nodejs.org](https://nodejs.org/) (the LTS build is fine) and try again.

<details>
<summary>Why 18?</summary>

The newest API the code uses is the global `fetch`, and only on the `--live-usage` code path.
Everything else is older Node built-ins. There are **no dependencies at all**, so nothing else can
raise the requirement out from under you.

On Node 18–20 you may see a one-time `ExperimentalWarning` about `fetch` the first time
`--live-usage` fires. It is noise, not a problem.

</details>

---

## 2. Get the code

```bash
git clone https://github.com/greentourn/agent-activity-dashboard.git
cd agent-activity-dashboard
```

No `git`? Download the ZIP from the repository's green **Code** button, unzip it, and `cd` into the
folder. Nothing in the tool depends on being inside a git checkout.

> **Do not cherry-pick files.** `server.mjs` requires `lib/tool-error-kinds.js` and serves
> everything under `public/` (including the vendored three.js). Keep the folder intact.

---

## 3. Run it

```bash
node server.mjs --open
```

`--open` launches your browser at the classic view. Without it, open
<http://127.0.0.1:7676> yourself.

You should see this on the terminal:

```
  Agent Activity Dashboard
    Classic (2D)      → http://127.0.0.1:7676/
    NEURAL CORE (3D)  → http://127.0.0.1:7676/brain.html
  watching C:\Users\you\.claude\sessions
         + C:\Users\you\.claude\projects
  โควตา: หน้าต่าง 5 ชม. สดจาก transcript · % อย่างเป็นทางการมาจาก cache (ใส่ --live-usage เพื่อดึงสด)

  Ctrl+C to stop
```

Both views are listed so you can pick either one straight from the terminal (`--open` only
launches the classic one). The `โควตา:` line means: *"Quota: the 5-hour window is live from the transcripts; the official
percentage comes from cache (pass `--live-usage` to fetch it live)."*

Stop the server with `Ctrl+C` — it prints `stopped` and exits cleanly.

---

## 4. Confirm it sees your sessions

Start (or already have) a Claude Code session — terminal, VS Code extension, desktop app, or a
`--bg` background run — and it appears as a node within about a second.

**Nothing on screen?** That is not necessarily a bug:

- The dashboard reads `~/.claude/sessions/` and `~/.claude/projects/`. If you have never run Claude
  Code on this machine, those do not exist yet and you correctly get an empty dashboard (it does not
  crash).
- Sessions whose process has already exited stay on screen for `--stale-minutes` (30 by default) and
  then disappear.
- To see the entire interface without any real session at all, use **demo mode**:

  ```
  http://127.0.0.1:7676/?fixture=45
  http://127.0.0.1:7676/brain.html?fixture=cascade
  ```

---

## Choosing a port

Default is `7676`.

```bash
node server.mjs --port 8080
```

If the port is already taken, the server does **not** silently pick another one. It prints
`port 7676 ถูกใช้อยู่ — ลองอีกพอร์ต: --port 7677` ("port 7676 is in use — try another") and exits
with status `1`.

---

## Running it as a command from anywhere

### Option A — an alias (simplest)

```bash
# macOS / Linux — add to ~/.bashrc or ~/.zshrc
alias agent-dash='node /path/to/agent-activity-dashboard/server.mjs --open'
```

```powershell
# Windows PowerShell — add to $PROFILE
function agent-dash { node "C:\path\to\agent-activity-dashboard\server.mjs" --open @args }
```

### Option B — `npm link`

From inside the repository folder:

```bash
npm link
```

That puts an `agent-activity-dashboard` command on your `PATH` (the file already has the right
shebang). `npm link` installs nothing — there are no dependencies to install — it only creates the
symlink.

```bash
agent-activity-dashboard --open --port 7777
```

Undo it with `npm unlink -g agent-activity-dashboard`.

---

## Keeping it running in the background

It is a plain HTTP server with no state, so any process manager works. The simplest options:

```bash
# macOS / Linux
nohup node server.mjs > /tmp/agent-dash.log 2>&1 &
```

```powershell
# Windows PowerShell
Start-Process -WindowStyle Hidden node -ArgumentList "server.mjs"
```

Remember it binds `127.0.0.1` only, so "background" means *on this machine* — see
[Security](#security) below.

---

## Optional: live quota percentages

By default the session/weekly percentage in the quota bar comes from the `~/.claude.json` cache that
Claude Code maintains. That cache is only rewritten on startup and token renewal, so it can be hours
stale or flatly wrong.

```bash
node server.mjs --open --live-usage
node server.mjs --open --live-usage-seconds 60   # implies --live-usage
```

With the flag, the server calls `GET https://api.anthropic.com/api/oauth/usage` on that interval,
using the OAuth token from `~/.claude/.credentials.json`.

**What that costs you, stated plainly:** the tool becomes something that reads a secret from disk.
It is opt-in for exactly that reason. The token is read-only, never logged, never included in the
data sent to the browser, and never refreshed or rewritten. The server also announces on its startup
line that it is doing this.

**What you do not need the flag for:** the live 5-hour window — when it opened, when it resets, how
many tokens went into it — is computed from your transcripts and is always shown.

If a call is rejected, the poller backs off on its own (1 → 15 minutes) and keeps the last good
number on screen instead of blanking the bar.

---

## Security

- The server binds **`127.0.0.1` only** and there is no flag to change that.
- Your transcripts contain your prompts and your file paths, and `/api/agent` returns them verbatim.
  **Do not expose this port** through a tunnel, a reverse proxy, or port forwarding on a shared
  machine.
- Static files are served from `public/` only, path traversal is rejected, and session/agent ids are
  validated against `/^[A-Za-z0-9_-]{1,64}$/` before being joined into any path.
- The dashboard never writes to `~/.claude` and installs no hooks.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `port 7676 ถูกใช้อยู่` then exit 1 | port in use. `--port 7677` |
| Empty dashboard, no error | no live sessions, or Claude Code has never run here. Try `/?fixture=45` to prove the UI works |
| A session is stuck on `💭 คิดอยู่` with a growing clock | usually genuine — long thinking is normal and the tool refuses to guess a timeout. If you closed that window mid-turn, the process may still be alive; the data cannot tell the two apart |
| Finished sessions linger | by design, for `--stale-minutes` (default 30). Lower it: `--stale-minutes 5` |
| `/brain.html` shows *"เบราว์เซอร์นี้เปิด WebGL ไม่ได้"* | your browser/GPU has no WebGL. That screen links back to the classic view, which needs no WebGL |
| `/brain.html` is black and never loads | a boot guard warns after 12 s. Try `?quality=low`, or use the classic view |
| `--open` opened the 2D view, not the 3D one | expected — `--open` always opens the classic view. The 3D URL is printed right under it in the terminal banner; open that one yourself |
| No link from the classic view to the 3D one | there isn't one yet. Copy the `/brain.html` URL from the terminal banner (or type it); the 3D view *does* have a link back |
| Deep sub-agents look like children of the session | should not happen — parents are pulled back in past the send cap. If you see it, please open an issue with what you did |
| Old tool calls missing from a long session | expected: each transcript is seeded from its last 256 KB only |
| Edited `server.mjs`, nothing changed | there is no hot reload. Restart it |

---

## Uninstalling

Delete the folder. If you ran `npm link`, run `npm unlink -g agent-activity-dashboard` first.

Nothing was ever written outside the folder — no config, no cache, no entries in `~/.claude`.
