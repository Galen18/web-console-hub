# Web Console Hub — Architecture & Lessons Learned

> Version: 2.1.2 | Last updated: 2026-02-19
> Audience: Future self, contributors, similar project builders

---

## Table of Contents

1. [Problem Definition](#1-problem-definition)
2. [Mobile UX Insights](#2-mobile-ux-insights)
3. [Cloud Build Requirements](#3-cloud-build-requirements)
4. [Service Orchestration Logic](#4-service-orchestration-logic)
5. [End-Cloud Data Bridge](#5-end-cloud-data-bridge)
6. [Design Patterns](#6-design-patterns)
7. [Lessons Learned](#7-lessons-learned)
8. [Version History](#8-version-history)
9. [Next Steps](#9-next-steps)

---

## 1. Problem Definition

### Pain Point

AI CLI tools (Claude, Gemini, Kimi) are powerful but desktop-locked. Using them from a phone is painful:

| Barrier | Detail |
|---------|--------|
| No mobile client | CLI tools have no native mobile app |
| SSH is hell on mobile | Tiny font, no shortcuts, constant disconnects |
| Session persistence | Close the browser tab = lose the conversation |
| Multi-session | Can't run 3 CLIs side-by-side from a phone |
| File sharing | Can't upload photos/files to a CLI from mobile |

### Why Not Existing Solutions?

| Option | Problem |
|--------|---------|
| Termux (Android) | No iOS. Can't run server-side CLIs. No session persistence. |
| JuiceSSH / Blink | Raw terminal. No touch-friendly input. No session dashboard. |
| code-server / VS Code Web | Overkill. Designed for coding, not CLI conversations. |
| Self-hosted Jupyter | Wrong paradigm. Notebook cells != interactive CLI. |

### Solution

A purpose-built web dashboard that:
1. Manages multiple AI CLI sessions from a mobile browser
2. Provides touch-optimized input (shortcuts, voice, file upload)
3. Persists sessions server-side (tmux) so closing the browser doesn't kill anything
4. Shows real-time terminal output with status detection

---

## 2. Mobile UX Insights

### Principle: Design for Thumbs, Not Mice

Mobile terminal usage has fundamentally different constraints than desktop.

| Constraint | Impact | Solution |
|-----------|--------|----------|
| No physical keyboard | Can't type `Ctrl+C` or `Tab` | Shortcut button bar (18 keys) |
| Fat fingers | Precise clicking is hard | Large touch targets (min 44px), long-press for dangerous keys |
| Screen interruptions | Calls, notifications, app switches | Server-side persistence (tmux survives everything) |
| Soft keyboard eats screen | Only ~40% visible area left | Two-tier UI: quick bar (always visible) + extended panel (on focus) |
| Voice is faster than typing | Especially for long prompts | Native `<input>` with `speech` API — no custom voice engine needed |
| Copy/paste is clunky | No `Ctrl+V` equivalent | Dedicated paste button + passive paste event handler |

### Two-Tier Input Architecture

```
[ Terminal output area — scrollable, selectable text ]
                    ↕ (flex shrink/grow)
┌─────────────────────────────────────────┐
│ Tier 1: Quick Bar (always visible)       │
│ [Tab] [S-Tab] [Enter] [Paste] [↑] [↓]  │
├─────────────────────────────────────────┤
│ Tier 2: Input Bar (always visible)       │
│ [📎] [____________input____________] [▶] │
└─────────────────────────────────────────┘
       ↓ (on input focus, slides out)
┌─────────────────────────────────────────┐
│ Extended Panel: Full shortcut bar        │
│ [Tab][S-Tab][↑][↓][←][→][Ctrl+C]...    │
│ [staged files] [upload progress]         │
└─────────────────────────────────────────┘
```

When the input field gains focus, the extended panel slides open (hiding the quick bar), exposing 18 shortcut keys plus file staging area. On blur, it collapses back. This ensures the terminal output area gets maximum space when the user is reading, and full controls when they're typing.

### Dangerous Key Pattern

`Ctrl+D` (EOF) and `Ctrl+Z` (suspend) can kill a CLI session. These use a **long-press guard** (300ms hold) instead of tap — preventing accidental session termination.

### ANSI Rendering

The terminal page doesn't embed xterm.js for the main output — it uses a custom ANSI-to-HTML parser. Why:

| Factor | xterm.js | Custom ANSI parser |
|--------|----------|-------------------|
| Bundle size | ~500KB | ~3KB inline |
| Text selection | Canvas-based, clunky on mobile | Native browser selection |
| Copy/paste | Needs clipboard API adapter | Works natively |
| Font sizing | Fixed to canvas | Responsive, CSS-controlled |
| 256/truecolor | Full support | Full support (state machine) |
| Cursor movement | Full VT100 | Stripped (not needed for output-only view) |

The trade-off is acceptable because our terminal page is **output-only** — actual terminal interaction happens through the input bar + tmux send-keys, not direct keystroke passthrough.

### Screen-to-Terminal Mapping (resizePane)

Mobile screens vary wildly. The terminal dimensions must match the visible area to avoid wrapping/truncation artifacts.

```
resizePane():
  1. Measure .text-output element (clientWidth, clientHeight)
  2. Subtract padding
  3. Create a probe <span> with 10 'M' characters → measure actual char width
  4. cols = floor(usableWidth / charWidth) - 1 (safety margin)
  5. rows = floor(usableHeight / charHeight)
  6. POST /api/sessions/:id/resize { cols, rows }
  7. Server: tmux resize-window -t $id -x $cols -y $rows
```

Triggers: window resize, orientation change, extended panel open/close (with 250ms debounce to wait for animation).

---

## 3. Cloud Build Requirements

### Why Oracle Cloud (OCI)

| Factor | OCI Free Tier | AWS Free Tier | GCP Free Tier |
|--------|--------------|--------------|--------------|
| Always-Free VM | 4 OCPU, 24GB RAM (ARM) | 1 vCPU, 1GB (x86, 12 months) | e2-micro, 0.25 vCPU |
| Storage | 200GB boot | 30GB (12 months) | 30GB |
| Bandwidth | 10TB/month | 100GB/month (12 months) | 1GB/month |
| Expiration | Never | 12 months | Never but tiny |

OCI's Always Free ARM instance is overwhelmingly generous for a personal project.

### Containerization Strategy: Hybrid

Not everything should be in Docker. The decision matrix:

| Service | Docker? | Why |
|---------|---------|-----|
| Nginx | Yes | Isolated config, easy SSL cert mount, reproducible |
| MySQL | Yes | Standard practice, data volume isolation |
| Console Hub (Node.js) | No (systemd) | Needs direct access to tmux/ttyd on host |
| tmux | No (host) | Process manager — must be on host |
| ttyd | No (host) | Binds per-session ports, talks to tmux |
| rclone | No (host) | FUSE mount must be on host filesystem |

**Key insight**: When your app's core function is **managing host processes** (tmux sessions, ttyd instances), containerizing the app itself adds complexity with no benefit. The app needs `execSync('tmux ...')` — that means host access.

### Port Architecture (Three Layers)

```
Internet → OCI Firewall (Security List)
             ↓ only 80, 443
           Nginx (Docker, host networking)
             ↓ proxy_pass to 127.0.0.1:3000
           Console Hub (systemd, binds 127.0.0.1)
             ↓ proxy to 127.0.0.1:7681-7700
           ttyd instances (per-session, bind 127.0.0.1)
```

- **Layer 1 (OCI)**: Only ports 80/443 are open. 7681-7700 are NOT in the security list.
- **Layer 2 (Nginx)**: SSL termination + Basic Auth + reverse proxy. `/console/` → `:3000`.
- **Layer 3 (Console Hub)**: Internal reverse proxy for ttyd WebSocket connections. `/t/:id/*` → `:768x`.

This means ttyd is **never exposed to the internet**. All access goes through two layers of authentication.

---

## 4. Service Orchestration Logic

### Session Lifecycle

```
User clicks "New Session"
  → POST /api/sessions { cli: "claude" }
    → SessionManager.createSession()
      → tmux new-session -d -s "$id" -x 200 -y 50 "claude"
      → ttyd -p $port --writable -t fontSize=14 tmux attach -t $id
      → Save to sessions.json
  → 201 { id, port, ... }
    → Frontend opens /terminal/$id
      → Polls GET /api/sessions/$id/output (adaptive)
      → SSE stream for status dot
```

### Why tmux + ttyd (Not Alternatives)

| Approach | Persistence | Web Access | CLI Compatibility | Complexity |
|----------|-------------|------------|-------------------|------------|
| tmux + ttyd | Full (survives everything) | Built-in (xterm.js WebSocket) | Any CLI | Low |
| screen + gotty | Full | gotty abandoned since 2017 | Any CLI | Dead project |
| Docker per-session | Container restart = lost | Needs additional web terminal | Limited | High |
| node-pty + socket.io | Process dies on crash | Custom implementation | Any CLI | High, fragile |

tmux + ttyd is the sweet spot: battle-tested persistence + maintained web terminal.

### Adaptive Polling (Three-Speed)

The terminal page uses adaptive polling instead of a persistent WebSocket for output capture. Why: the output comes from `tmux capture-pane`, which is a point-in-time snapshot — there's no stream to subscribe to.

```
Speed       Interval   Trigger
─────────   ────────   ─────────────────────────────────
Fast        300ms      After user input (10s window)
Normal      800ms      Default — content is changing
Idle        3000ms     No change for 45s, or 3+ errors
```

```javascript
function schedulePoll() {
  if (consecutiveErrors >= 3)         interval = POLL_IDLE;    // back off on errors
  else if (now < fastPollEnd)         interval = POLL_FAST;    // user just sent input
  else if (now - idleStart > 45000)   interval = POLL_IDLE;    // nothing happening
  else                                interval = POLL_NORMAL;  // default
}
```

**Self-accelerating**: when `fetchOutput()` detects content changed, it automatically extends the fast-poll window — so a Claude response that takes 30 seconds to generate stays at 300ms throughout without user action.

### SSE for Dashboard Status

The dashboard uses Server-Sent Events (not WebSocket) for live session status updates.

| Factor | SSE | WebSocket |
|--------|-----|-----------|
| Direction | Server → Client only | Bidirectional |
| Reconnection | Built-in auto-reconnect | Manual implementation |
| Protocol | HTTP/1.1 compatible | Requires upgrade |
| Through reverse proxy | Works naturally | Needs explicit config |
| Our use case | Status push (one-way) | Overkill |

SSE is the right tool: we only need server-to-client status pushes. The `EventSource` API handles reconnection automatically.

### Session Status Detection

```javascript
detectStatus(content, prevContent, sessionId):
  1. Error: last 3 lines match /error|FATAL|panic|FAILED/i → 'error' (🔴)
  2. Waiting: last line matches prompt patterns (>, ?, $, y/n) → 'waiting' (🟡)
  3. Running: content changed since last poll → 'running' (🟢)
  4. Idle: content unchanged for 60s → 'idle' (⚪)
```

Status transitions trigger push notifications:
- running → waiting: "Session needs your input"
- running → idle: "Session may have completed"
- any → error: "Session encountered an error"

---

## 5. End-Cloud Data Bridge

This is the most nuanced part of the architecture — how files flow between the local machine and the server.

### 5.1 The Google Drive Dual-Path Problem

Google Drive Desktop (the sync client on Windows/Mac) stores files under two distinct cloud paths:

| Local Source | Cloud Path | Accessible via `rclone mount gdrive:` ? |
|-------------|-----------|------------------------------------------|
| My Drive folder | `My Drive/...` | Yes (default root) |
| Computer backup | `Computers/MACHINE_NAME/...` | **No** (different namespace) |

When you configure Google Drive Desktop to back up a folder like `C:\MyData\`, it syncs to `Computers/YOUR_PC/MyData/...` — NOT to `My Drive/`. This means a standard `rclone mount gdrive: /mnt/gdrive` **won't see these files**.

**Solution**: Mount the specific computer backup path:

```bash
rclone mount "gdrive:Computers/YOUR_PC/your-vault" /home/your-user/vault \
  --vfs-cache-mode full \
  --vfs-cache-max-size 5G \
  --allow-other \
  --daemon
```

### 5.2 The Transparent Bridge

The full data flow:

```
┌──────────────────────┐
│ Local PC              │
│ C:\MyData\vault\     │ ← Edit files here (e.g. Obsidian, VS Code)
│ workspace\           │
└──────────┬───────────┘
           │ Google Drive Desktop (continuous sync)
           ↓
┌──────────────────────┐
│ Google Drive Cloud    │
│ Computers/YOUR_PC/   │ ← Cloud storage (not My Drive!)
│ MyData/vault/        │
│ workspace/           │
└──────────┬───────────┘
           │ rclone FUSE mount (specific path)
           ↓
┌──────────────────────┐
│ Cloud Server          │
│ /home/your-user/     │ ← CLI tools read/write here
│ vault/workspace/     │
│                      │
│ AI CLI sessions      │
│ read config files    │
│ write logs/output    │
└──────────────────────┘
```

**Bidirectional**: Changes flow both ways. A CLI tool writes a log file → rclone syncs to GDrive Cloud → Google Drive Desktop syncs to local PC → your editor sees the new file.

### 5.3 FUSE Mount Parameters

```bash
rclone mount "gdrive:Computers/YOUR_PC/your-vault" \
  /home/your-user/vault \
  --vfs-cache-mode full \     # Full read/write cache (required for random access)
  --vfs-cache-max-size 5G \   # Cache up to 5GB locally
  --allow-other \             # Let non-root users (systemd services) access
  --daemon                    # Run in background
```

`/etc/fuse.conf` must have `user_allow_other` uncommented for `--allow-other` to work.

### 5.4 Cache Strategy

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `--vfs-cache-mode` | `full` | CLI tools do random read/write; `writes` or `minimal` would break |
| `--vfs-cache-max-size` | `5G` | Workspace is ~500MB; 5G gives 10x headroom |
| `--vfs-cache-max-age` | default (1h) | Files not accessed for 1h are evicted from local cache |
| `--dir-cache-time` | default (5m) | Directory listings cached for 5 minutes |
| `--poll-interval` | default (1m) | Check for remote changes every minute |

### 5.5 Conflict Window

**Conflict risk** = simultaneous write frequency x sync delay.

| Scenario | Sync Delay | Risk |
|----------|-----------|------|
| User edits locally, CLI reads on server | 5-60s (GDrive upload + rclone poll) | Low (read-only from server side) |
| User edits, CLI also edits same file | 5-60s | **Medium** — GDrive may create conflict copy |
| CLI writes on server, user reads locally | 5-60s | Low (read-only from local side) |
| Two CLI sessions edit same file | 0s (same filesystem) | Standard file locking applies |

**High-conflict files**: Config files, dashboard files, cache files — anything that both the user and CLI tools frequently edit.

### 5.6 Protection Mechanisms

Current protections in Console Hub:

| Mechanism | Implementation |
|-----------|---------------|
| GDrive mount check | `mountpoint -q` before any file operation |
| Mount status in UI | Green/red dot on toolbar + dashboard |
| Conflict file scan | Check for `* (1).md` pattern in key directories |
| Write-before-check | Session lock via `.sophie/session_manager.py` |

### 5.7 Improvement Roadmap

| Priority | Improvement | Method |
|----------|------------|--------|
| High | Mount health monitor | systemd timer: `mountpoint -q` every 60s, auto-remount on failure |
| High | Cache refresh on command | `rclone rc vfs/refresh dir=workspace/` before reading critical files |
| Medium | Conflict detection | Scan for `* (1).md` / `* conflict *` naming, WARN user |
| Medium | Hot-file mtime guard | Before writing core.md/Dashboard.md, compare mtime with last known |
| Low | Scoped mount | Mount only the workspace directory instead of broader path — faster cache |
| Evaluate | rclone bisync | Replace FUSE with bidirectional sync — more stable, but loses transparent path |

### 5.8 FUSE vs Alternatives

| Approach | Transparent Path | Real-time | Stability | Offline |
|----------|-----------------|-----------|-----------|---------|
| FUSE mount (current) | Yes — same paths as local | Near (with cache lag) | Medium (can hang) | No |
| rclone bisync | No — separate sync step | Periodic (cron) | High | Yes (local copy) |
| GDrive REST API | No — code changes needed | On-demand | High | No |
| rsync over SSH | No — needs SSH tunnel | Periodic | High | Yes |

FUSE wins on transparency: the CLI doesn't need to know files are remote. But it trades stability — a network blip can freeze the mount.

---

## 6. Design Patterns

### 6.1 Adaptive Polling Pattern

**Problem**: Need near-real-time updates but don't want to waste bandwidth when nothing is happening.

**Solution**: Three-speed polling that shifts gears based on activity:

```
User action → Fast (300ms, 10s window)
Content changing → Normal (800ms)
Nothing happening → Idle (3000ms)
Errors → Back off (3000ms)
```

**Self-acceleration**: If content changes during normal polling, automatically upgrade to fast — the system detects its own need for speed.

### 6.2 ANSI State Machine Pattern

**Problem**: Need to render terminal output with colors in a web page, but can't use a full terminal emulator (too heavy for mobile).

**Solution**: Build an ANSI escape code parser as a state machine that converts to HTML `<span>` tags with inline styles. Support 256-color and truecolor via `\e[38;5;Nm` and `\e[38;2;R;G;Bm` sequences. Strip cursor movement codes (not needed for output-only rendering).

### 6.3 Proxy Chain Pattern

**Problem**: ttyd instances bind to individual ports (7681-7700). Can't expose 20 ports to the internet.

**Solution**: Chain through a single entry point:

```
Internet → :443 (Nginx, auth) → :3000 (Console Hub) → :768x (ttyd)
```

Console Hub acts as a smart reverse proxy: parses `/t/:id/*` URLs, looks up the session's port, and forwards both HTTP and WebSocket traffic using `http-proxy`.

### 6.4 Session Reconciliation Pattern

**Problem**: Console Hub stores session state in `sessions.json`, but tmux is the source of truth. If the server reboots, they can diverge.

**Solution**: On every startup and every `listSessions()` call:

```
1. Read sessions.json (our state)
2. Run tmux list-sessions (ground truth)
3. For sessions in our state but not in tmux → remove
4. For sessions in both → ensure ttyd is running, restart if not
5. Save reconciled state
```

This makes the system self-healing: a hard reboot recovers automatically.

### 6.5 Upload Pipeline Pattern

**Problem**: Mobile users need to upload files (photos, documents) to CLI sessions. Files can be large (photos are 5-15MB). Network can be flaky.

**Solution**: Two-mode pipeline:

```
Mode A (default): Upload immediately on file select
  → Files start uploading while user types their message
  → Send button waits for in-flight uploads to complete

Mode B: Upload on send
  → Files staged locally as chips
  → All pending uploads fire when user hits send
  → Send button shows "..." until all complete

Auto-fallback: Files > 5MB use chunked upload (5MB chunks)
  → Each chunk retries on network error (2s delay)
  → Progress tracked per-file
```

---

## 7. Lessons Learned

### 7.1 Shell History Expansion Eats Passwords

**Problem**: `openssl passwd -apr1 'MyP@ss!2024'` — the `!` in the password gets interpreted by bash as history expansion. The generated hash is for a wrong password.

**Fix**: Use `htpasswd -cb` which handles escaping internally:
```bash
htpasswd -cb /path/.htpasswd username 'MyP@ss!2024'
```

**Rule**: Never put passwords with `!` in bash command-line strings. Use dedicated tools or single quotes with care.

### 7.2 Reverse Proxy BASE Path Mismatch

**Problem**: Frontend JavaScript uses `fetch('/api/sessions')` — but behind a reverse proxy at `/console/`, this resolves to the server root, not `/console/api/sessions`.

**Fix**: Set `var BASE = '/console'` in all frontend files. Every fetch call uses `BASE + '/api/...'`.

**Rule**: When deploying behind a reverse proxy with a path prefix, the frontend must be aware of its own base path.

### 7.3 FUSE Mount Permission Denied

**Problem**: `rclone mount` works as root but other users get "Permission denied".

**Fix**: Two steps:
1. Add `--allow-other` flag to rclone mount
2. Uncomment `user_allow_other` in `/etc/fuse.conf`

**Rule**: FUSE mounts are user-private by default. Cross-user access requires both flag and config.

### 7.4 SSH Heredoc vs SCP for Complex Files

**Problem**: Sending HTML/JS files via SSH heredoc (`cat <<'EOF' > file.html`) corrupts content — quote conflicts, escape sequences, and variable expansion despite single-quoted delimiter.

**Fix**: Write the file locally, then `scp` it:
```bash
# Local: write file with Write tool
# Then: scp file.html your-user@server:/path/
```

**Rule**: For files containing HTML, JS, or any mixed-quote content, always use `scp` instead of heredoc injection.

### 7.5 ttyd Option Syntax

**Problem**: `ttyd --reconnect 3 tmux attach` fails with `execvp failed: No such file or directory`. ttyd interprets `3` as the command to execute.

**Fix**: `reconnect` is a frontend (xterm.js) option, not a CLI flag. Pass via `-t`:
```bash
ttyd -t reconnect=3 tmux attach -t $session
```

**Rule**: ttyd's `-t key=value` passes options to the xterm.js frontend. CLI flags and frontend options are different namespaces.

### 7.6 Docker Bind Mount Hot Reload

**Problem**: After editing `nginx.conf` on the host, `docker exec nginx nginx -s reload` doesn't pick up the changes. The container still serves the old config.

**Fix**: `docker restart <nginx-container>`. The bind mount exposes the file, but nginx's in-memory config only refreshes on container restart (or a proper `nginx -s reload` that re-reads from the bind-mounted path — which may fail due to caching).

**Rule**: For Docker bind mounts, prefer `docker restart` over in-container reload when changing configuration files.

### 7.7 tmux resize-window Requires Target

**Problem**: `tmux resize-pane -x 120 -y 40` resizes the wrong pane in a multi-session server.

**Fix**: Use `resize-window` with explicit session target:
```bash
tmux resize-window -t "$sessionId" -x $cols -y $rows
```

**Rule**: In a multi-session tmux server, always specify `-t $session` to avoid affecting the wrong session.

### 7.8 Mobile Virtual Keyboard and Layout

**Problem**: On iOS Safari, the virtual keyboard pushes the page up via `visualViewport` changes, but `100vh` still refers to the full screen height — causing the input bar to be hidden behind the keyboard.

**Fix**: Use `100dvh` (dynamic viewport height) with fallback:
```css
height: calc(100vh - 40px);     /* fallback */
height: calc(100dvh - 40px);    /* modern browsers */
```

Plus `<meta name="viewport" content="interactive-widget=resizes-content">` to tell the browser that the keyboard should resize the content area, not overlay it.

---

## 8. Version History

### v1.0 — Core Platform (2026-02-12 ~ 02-13)

Phase 1-3 delivery:

- DNS + SSL (Let's Encrypt) + OCI security list
- Nginx reverse proxy (Docker, host networking) + Basic Auth
- Console Hub (Node.js Express, systemd)
- tmux session lifecycle (create, delete, sync)
- ttyd per-session WebSocket proxy
- SSE dashboard with live preview
- Session status detection (running/waiting/idle/error)
- Web Push notifications
- Google Drive rclone mount/unmount
- CLI registry (claude, gemini)

### v2.0 — Mobile Multimodal (2026-02-15)

Phase 4 delivery. Major mobile UX overhaul:

| Feature | Detail |
|---------|--------|
| Quick Ask page | Lightweight single-question interface |
| File upload | Drag-and-drop + camera capture + clipboard paste |
| HEIC conversion | Server-side HEIC → JPEG via sharp (iOS photos) |
| EXIF stripping | Privacy: remove GPS/camera metadata from uploads |
| Chunked upload | 5MB chunks for large files, with retry |
| Session naming | Rename sessions + soft-delete with undo |
| 18 shortcuts | Full shortcut bar with long-press guards |
| Cookie auth | 4-hour idle timeout, explicit logout |
| ANSI rendering | Full 256-color + truecolor parser |
| Adaptive polling | Three-speed polling (300ms/800ms/3000ms) |
| GDrive protection | Mount status indicator + conflict detection |
| Security headers | CSP, HSTS, X-Frame-Options via Nginx |
| ttyd bind localhost | ttyd binds 127.0.0.1 (was 0.0.0.0) |

### v2.1.x — Stability (2026-02-17 ~ 02-19)

| Version | Fix |
|---------|-----|
| v2.1.0 | Terminal output endpoint (dedicated /output route) |
| v2.1.1 | Resize API: browser measures actual char width → `tmux resize-window` |
| v2.1.2 | resizePane reliability: probe-based measurement, debounced triggers |

---

## 9. Next Steps

### Short Term
- [ ] Password strengthening (replace Basic Auth with session-based auth or OAuth2)
- [ ] Auto session naming (extract first user message as session name)
- [ ] CLI switching within session (start claude, switch to gemini)

### Medium Term
- [ ] Mount health monitoring (systemd timer + auto-remount)
- [ ] rclone cache refresh before critical reads
- [ ] Multiple CLI presets (different models, different system prompts)

### Long Term
- [ ] Google SSO via oauth2-proxy (Phase 5)
- [ ] Session sharing (read-only link for collaboration)
- [ ] Session export (conversation history as markdown)
