const { execSync } = require('child_process');

class SessionMonitor {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.pollInterval = 3000;
    this.prevContent = new Map();   // id -> content string
    this.prevStatus = new Map();    // id -> status
    this.lastChange = new Map();    // id -> timestamp
    this.sseClients = new Set();
    this.alertCallback = null;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), this.pollInterval);
    console.log('Session monitor started (interval: 3s)');
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  onAlert(callback) {
    this.alertCallback = callback;
  }

  addSSEClient(res) {
    this.sseClients.add(res);
    res.on('close', () => this.sseClients.delete(res));
    // Send initial state immediately
    this._sendSSE();
  }

  capturePane(sessionId) {
    try {
      return execSync(
        `tmux capture-pane -t "${sessionId}" -p -S -24 2>/dev/null`
      ).toString();
    } catch {
      return '';
    }
  }

  detectStatus(content, prevContent, sessionId) {
    const lines = content.trim().split('\n');
    const lastLine = lines[lines.length - 1] || '';
    const lastFewLines = lines.slice(-3).join('\n');

    // Error detection
    if (/\b(error|Error|ERROR|FATAL|panic|FAILED)\b/.test(lastFewLines)) {
      return 'error';
    }

    // Waiting for input detection (common CLI prompts)
    if (/[>?$#%]\s*$/.test(lastLine) ||
        /\(y\/n\)/i.test(lastLine) ||
        /\(Y\/n\)/i.test(lastLine) ||
        /\(yes\/no\)/i.test(lastLine) ||
        /What would you like/i.test(lastLine) ||
        /Enter.*:/i.test(lastLine)) {
      return 'waiting';
    }

    // Running vs idle
    if (content !== prevContent) {
      this.lastChange.set(sessionId, Date.now());
      return 'running';
    }

    const lastChangeTime = this.lastChange.get(sessionId) || Date.now();
    if (Date.now() - lastChangeTime > 60000) {
      return 'idle';
    }

    return 'running';
  }

  _poll() {
    const sessions = this.sessionManager.listSessions();
    let changed = false;

    for (const session of sessions) {
      const content = this.capturePane(session.id);
      const prev = this.prevContent.get(session.id) || '';
      const status = this.detectStatus(content, prev, session.id);
      const prevStatus = this.prevStatus.get(session.id);

      this.prevContent.set(session.id, content);
      this.prevStatus.set(session.id, status);

      // Check for alert conditions
      if (prevStatus && prevStatus !== status && this.alertCallback) {
        if (prevStatus === 'running' && status === 'waiting') {
          this.alertCallback(session.id, 'needs_input', `${session.id} needs your input`);
        } else if (status === 'error') {
          this.alertCallback(session.id, 'error', `${session.id} encountered an error`);
        } else if (prevStatus === 'running' && status === 'idle') {
          this.alertCallback(session.id, 'task_done', `${session.id} may have completed`);
        }
      }

      if (content !== prev || status !== prevStatus) {
        changed = true;
      }
    }

    // Clean up monitors for deleted sessions
    const activeIds = new Set(sessions.map(s => s.id));
    for (const id of this.prevContent.keys()) {
      if (!activeIds.has(id)) {
        this.prevContent.delete(id);
        this.prevStatus.delete(id);
        this.lastChange.delete(id);
        changed = true;
      }
    }

    if (changed || this.sseClients.size > 0) {
      this._sendSSE();
    }
  }

  _sendSSE() {
    if (this.sseClients.size === 0) return;

    const sessions = this.sessionManager.listSessions();
    const data = sessions.map(s => ({
      id: s.id,
      cli: s.cli,
      cliName: s.cliName,
      status: this.prevStatus.get(s.id) || 'running',
      preview: (this.prevContent.get(s.id) || '').split('\n').slice(-24).join('\n'),
      created: s.created,
      lastChange: this.lastChange.get(s.id) || Date.now()
    }));

    const msg = `data: ${JSON.stringify({ sessions: data })}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(msg); } catch { this.sseClients.delete(client); }
    }
  }

  getSnapshot() {
    const sessions = this.sessionManager.listSessions();
    return sessions.map(s => ({
      id: s.id,
      cli: s.cli,
      cliName: s.cliName,
      status: this.prevStatus.get(s.id) || 'running',
      preview: (this.prevContent.get(s.id) || '').split('\n').slice(-24).join('\n'),
      created: s.created,
      lastChange: this.lastChange.get(s.id) || Date.now()
    }));
  }
}

module.exports = SessionMonitor;
