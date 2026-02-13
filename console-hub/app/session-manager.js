const { execSync, spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const cliRegistry = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'cli-registry.json'), 'utf8')
);

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.portMin = 7681;
    this.portMax = 7700;
    this.usedPorts = new Set();
    this.stateFile = path.join(__dirname, '..', 'data', 'sessions.json');
    this._loadState();
    this.syncWithTmux();
  }

  _loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        for (const s of data) {
          this.sessions.set(s.id, s);
          this.usedPorts.add(s.port);
        }
      }
    } catch (e) {
      console.error('Failed to load session state:', e.message);
    }
  }

  _saveState() {
    try {
      const data = Array.from(this.sessions.values()).map(s => ({
        id: s.id,
        cli: s.cli,
        port: s.port,
        tmuxName: s.tmuxName,
        created: s.created
      }));
      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('Failed to save session state:', e.message);
    }
  }

  _allocatePort() {
    for (let p = this.portMin; p <= this.portMax; p++) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    throw new Error('No available ports (max 20 sessions)');
  }

  _freePort(port) {
    this.usedPorts.delete(port);
  }

  _tmuxSessionExists(name) {
    try {
      execSync(`tmux has-session -t ${name} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  _startTtyd(sessionId, port) {
    const proc = spawn('ttyd', [
      '-p', String(port),
      '--writable',
      '-t', 'fontSize=14',
      '-t', 'theme={"background":"#1a1a2e","foreground":"#e0e0e0"}',
      'tmux', 'attach', '-t', sessionId
    ], {
      detached: true,
      stdio: 'ignore'
    });
    proc.unref();
    return proc.pid;
  }

  _findTtydPid(port) {
    try {
      const out = execSync(`pgrep -f "ttyd.*-p ${port}" 2>/dev/null`).toString().trim();
      return out ? parseInt(out.split('\n')[0]) : null;
    } catch {
      return null;
    }
  }

  createSession(cliType = 'claude') {
    const cli = cliRegistry[cliType];
    if (!cli) throw new Error(`Unknown CLI type: ${cliType}`);

    const id = `${cliType}-${Date.now().toString(36)}`;
    const port = this._allocatePort();

    try {
      // Create tmux session running the CLI command
      execSync(`tmux new-session -d -s "${id}" -x 200 -y 50 "${cli.command}"`);

      // Start ttyd attached to this tmux session
      const ttydPid = this._startTtyd(id, port);

      const session = {
        id,
        cli: cliType,
        cliName: cli.name,
        port,
        tmuxName: id,
        ttydPid,
        created: new Date().toISOString()
      };

      this.sessions.set(id, session);
      this._saveState();
      return session;
    } catch (e) {
      this._freePort(port);
      // Cleanup tmux if created
      try { execSync(`tmux kill-session -t "${id}" 2>/dev/null`); } catch {}
      throw new Error(`Failed to create session: ${e.message}`);
    }
  }

  deleteSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);

    // Kill ttyd
    const ttydPid = this._findTtydPid(session.port);
    if (ttydPid) {
      try { process.kill(ttydPid, 'SIGTERM'); } catch {}
    }

    // Kill tmux session
    try { execSync(`tmux kill-session -t "${id}" 2>/dev/null`); } catch {}

    this._freePort(session.port);
    this.sessions.delete(id);
    this._saveState();
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) return null;

    // Check if ttyd is still running, restart if needed
    const ttydPid = this._findTtydPid(session.port);
    if (!ttydPid && this._tmuxSessionExists(id)) {
      console.log(`Restarting ttyd for session ${id} on port ${session.port}`);
      this._startTtyd(id, session.port);
    }

    return session;
  }

  listSessions() {
    // Verify sessions against tmux
    const toRemove = [];
    for (const [id, session] of this.sessions) {
      if (!this._tmuxSessionExists(id)) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      const session = this.sessions.get(id);
      if (session) {
        const ttydPid = this._findTtydPid(session.port);
        if (ttydPid) {
          try { process.kill(ttydPid, 'SIGTERM'); } catch {}
        }
        this._freePort(session.port);
      }
      this.sessions.delete(id);
    }
    if (toRemove.length > 0) this._saveState();

    return Array.from(this.sessions.values());
  }

  syncWithTmux() {
    // On startup: check existing tmux sessions that match our naming pattern
    try {
      const out = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null')
        .toString().trim();
      if (!out) return;

      const tmuxSessions = out.split('\n');
      for (const name of tmuxSessions) {
        if (this.sessions.has(name)) {
          // Session exists in our map, ensure ttyd is running
          const session = this.sessions.get(name);
          const ttydPid = this._findTtydPid(session.port);
          if (!ttydPid) {
            console.log(`Restarting ttyd for orphaned session ${name} on port ${session.port}`);
            this._startTtyd(name, session.port);
          }
        }
      }

      // Remove sessions from map that no longer exist in tmux
      const toRemove = [];
      for (const [id] of this.sessions) {
        if (!tmuxSessions.includes(id)) {
          toRemove.push(id);
        }
      }
      for (const id of toRemove) {
        const session = this.sessions.get(id);
        if (session) this._freePort(session.port);
        this.sessions.delete(id);
      }
      if (toRemove.length > 0) this._saveState();
    } catch {
      // No tmux server running - that's fine
    }
  }

  sendKeys(id, text) {
    if (!this._tmuxSessionExists(id)) throw new Error(`Session not found: ${id}`);
    // Escape special characters for tmux
    const escaped = text.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${id}" '${escaped}' Enter`);
  }

  sendSpecialKey(id, key) {
    if (!this._tmuxSessionExists(id)) throw new Error(`Session not found: ${id}`);
    // Map friendly names to tmux key names
    const keyMap = {
      'Tab': 'Tab',
      'Enter': 'Enter',
      'Escape': 'Escape',
      'Up': 'Up',
      'Down': 'Down',
      'Left': 'Left',
      'Right': 'Right',
      'C-c': 'C-c',
      'C-d': 'C-d',
      'C-z': 'C-z',
      'C-l': 'C-l',
      'C-a': 'C-a',
      'C-e': 'C-e',
      'C-r': 'C-r',
      'Backspace': 'BSpace',
      'Delete': 'DC',
      'Space': 'Space'
    };
    const tmuxKey = keyMap[key] || key;
    execSync(`tmux send-keys -t "${id}" ${tmuxKey}`);
  }
}

module.exports = SessionManager;
