# Web Console Hub

A mobile-friendly web dashboard for managing multiple AI CLI sessions (Claude, Gemini, etc.) from your phone or browser.

![Architecture](docs/architecture.png)

## Features

- **Multi-session management** — Create, monitor, and delete AI CLI sessions from a web dashboard
- **Mobile-first terminal** — Touch-friendly input bar with shortcut keys (Tab, Ctrl+C, arrow keys, etc.)
- **Native voice input** — Use your phone's voice-to-text directly in the input field
- **Real-time preview** — See terminal output live on the dashboard via Server-Sent Events (SSE)
- **Session status detection** — Automatic status indicators:
  - 🟢 Running — output is changing
  - 🟡 Waiting — CLI is waiting for your input
  - ⚪ Idle — no output change for 60s+
  - 🔴 Error — error keywords detected
- **Push notifications** — Get notified when a session needs input or encounters an error
- **Persistent sessions** — Sessions survive browser close (tmux on host)
- **Google Drive mount** — Mount/unmount Google Drive for file access in CLI sessions
- **Extensible CLI registry** — Add new CLI tools by editing `cli-registry.json`

## Architecture

```
Browser → https://your-domain.com/console
                │
        ┌───────▼────────┐
        │ Nginx (Docker)  │  SSL + Basic Auth + reverse proxy
        │ :80 / :443      │
        └───────┬────────┘
                │ proxy_pass :3000
        ┌───────▼────────┐
        │ Console Hub     │  Node.js Express (host, systemd)
        │ :3000           │  API + SSE + Dashboard + Terminal proxy
        └───┬───────┬────┘
            │       │ proxy to :7681-7700
     ┌──────▼──┐ ┌──▼─────────┐
     │ tmux    │ │ ttyd ×N    │  All on host
     │ sessions│ │ per-session │  Sessions persist
     └────┬────┘ └────────────┘
          │
     ┌────▼─────┐
     │ AI CLI   │  Claude, Gemini, etc.
     └──────────┘
```

## Prerequisites

- **Linux server** (tested on Rocky Linux 9 ARM64, works on any Linux with aarch64/x86_64)
- **Node.js** >= 18
- **Docker** + Docker Compose (for Nginx)
- **tmux**
- **ttyd** ([github.com/tsl0922/ttyd](https://github.com/tsl0922/ttyd))
- **rclone** (optional, for Google Drive)
- **An AI CLI** installed and authenticated (e.g., `claude`, `gemini`)
- **A domain** with SSL certificate (Let's Encrypt recommended)

## Quick Start

### 1. Install dependencies

```bash
# tmux + rclone (RHEL/Rocky)
sudo dnf install -y tmux fuse3 rclone

# tmux + rclone (Debian/Ubuntu)
sudo apt install -y tmux fuse3 rclone

# ttyd — download binary for your architecture
# For aarch64:
sudo curl -L "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.aarch64" \
  -o /usr/local/bin/ttyd && sudo chmod +x /usr/local/bin/ttyd

# For x86_64:
sudo curl -L "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64" \
  -o /usr/local/bin/ttyd && sudo chmod +x /usr/local/bin/ttyd
```

### 2. Clone and install

```bash
git clone https://github.com/your-username/web-console-hub.git
cd web-console-hub/console-hub
npm install --omit=dev
```

### 3. Configure

```bash
# Edit cli-registry.json to add your CLI tools
# Edit nginx/nginx.conf — replace YOUR_DOMAIN with your domain

# Create Basic Auth password
sudo dnf install -y httpd-tools   # or: sudo apt install -y apache2-utils
htpasswd -cb nginx/.htpasswd YOUR_USERNAME YOUR_PASSWORD
```

### 4. Set up SSL (Let's Encrypt)

```bash
sudo certbot certonly --standalone -d YOUR_DOMAIN
```

### 5. Configure nginx

Edit `nginx/nginx.conf` and replace:
- `YOUR_DOMAIN` with your actual domain
- Verify SSL certificate paths match your Let's Encrypt setup

### 6. Start services

```bash
# Start Console Hub via systemd
sudo cp console-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now console-hub

# Start Nginx
docker compose up -d
```

### 7. Access

Open `https://YOUR_DOMAIN/console/` in your browser.

## Project Structure

```
web-console-hub/
├── console-hub/
│   ├── server.js              # Express API + SSE + ttyd proxy
│   ├── package.json           # Node.js dependencies
│   ├── cli-registry.json      # CLI tool definitions
│   ├── app/
│   │   ├── session-manager.js # tmux/ttyd lifecycle management
│   │   ├── session-monitor.js # Terminal capture + status detection
│   │   ├── push-manager.js    # Web Push notification management
│   │   └── gdrive-manager.js  # Google Drive rclone mount/unmount
│   ├── public/
│   │   ├── index.html         # Dashboard (session list + live preview)
│   │   ├── terminal.html      # Terminal page (ttyd + input bar + shortcuts)
│   │   └── sw.js              # Service Worker for push notifications
│   └── data/                  # Runtime data (auto-generated, gitignored)
│       ├── sessions.json
│       ├── vapid-keys.json
│       └── push-subscriptions.json
├── nginx/
│   ├── nginx.conf             # Nginx config template
│   └── html/
│       └── index.html         # Landing page
├── docker-compose.yml         # Nginx container
├── console-hub.service        # systemd unit file
└── README.md
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all sessions with status and preview |
| `POST` | `/api/sessions` | Create new session `{ cli: "claude" }` |
| `DELETE` | `/api/sessions/:id` | Delete session |
| `POST` | `/api/sessions/:id/input` | Send text input `{ text: "..." }` |
| `POST` | `/api/sessions/:id/key` | Send special key `{ key: "C-c" }` |
| `GET` | `/api/sessions/stream` | SSE real-time status stream |
| `GET` | `/api/gdrive/status` | Google Drive mount status |
| `POST` | `/api/gdrive/mount` | Mount Google Drive |
| `POST` | `/api/gdrive/unmount` | Unmount Google Drive |
| `GET` | `/api/push/vapid-key` | Get VAPID public key |
| `POST` | `/api/push/subscribe` | Subscribe to push notifications |

### Supported Special Keys

`Tab`, `Enter`, `Escape`, `Up`, `Down`, `Left`, `Right`, `C-c`, `C-d`, `C-z`, `C-l`, `C-a`, `C-e`, `C-r`, `Backspace`, `Delete`, `Space`

## Adding CLI Tools

Edit `cli-registry.json`:

```json
{
  "claude": {
    "name": "Claude CLI",
    "command": "claude",
    "icon": "circle-c",
    "color": "#d97706"
  },
  "gemini": {
    "name": "Gemini CLI",
    "command": "gemini",
    "icon": "sparkle",
    "color": "#4285f4"
  }
}
```

Then update `public/index.html` to add a button for the new CLI type.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Console Hub listen port |
| `NODE_ENV` | `production` | Node.js environment |

### Port Allocation

ttyd instances use ports 7681-7700 (max 20 concurrent sessions). These ports should NOT be exposed externally — they're accessed via the Console Hub's internal reverse proxy.

### Google Drive Setup

```bash
# On a machine with a browser:
rclone authorize "drive"
# Copy the token

# On the server:
rclone config
# → New remote → name: gdrive → type: drive → paste token
```

## Security Notes

- **Basic Auth** protects the `/console/` path via Nginx. For production, consider upgrading to OAuth2 (e.g., oauth2-proxy with Google SSO).
- ttyd ports (7681-7700) are **not exposed externally** — access is only through the authenticated Nginx reverse proxy.
- The Console Hub binds to `127.0.0.1:3000` (localhost only).
- VAPID keys are auto-generated on first start and stored in `data/`.
- The systemd service runs as root to access CLI tool credentials. Adjust `User=` in the service file if your CLI is authenticated under a different user.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Basic Auth loop | Regenerate password with `htpasswd` tool (avoid `!` in passwords — bash history expansion) |
| "Pattern mismatch" error on mobile | Ensure frontend `BASE` variable matches your reverse proxy path prefix |
| ttyd binary not working | Check architecture (`uname -m`), download matching binary |
| Session created but no terminal | Check `sudo tmux list-sessions` and `pgrep ttyd` |
| Push notifications not working | Requires HTTPS. Check browser permissions. |

## Documentation

- **[Architecture & Lessons Learned](docs/architecture-and-lessons.md)** — Full design rationale, end-cloud data bridge analysis, design patterns, and 8+ pitfall records from v1.0 to v2.1.x

## License

MIT
