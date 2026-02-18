const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');

const SessionManager = require('./app/session-manager');
const SessionMonitor = require('./app/session-monitor');
const PushManager = require('./app/push-manager');
const GDriveManager = require('./app/gdrive-manager');

const app = express();
const server = http.createServer(app);
const proxy = httpProxy.createProxyServer({ ws: true });

// Managers
const sessionManager = new SessionManager();
const sessionMonitor = new SessionMonitor(sessionManager);
const pushManager = new PushManager();
const gdriveManager = new GDriveManager();

// Wire up push notifications
sessionMonitor.onAlert((sessionId, type, message) => {
  const url = `/terminal/${sessionId}`;
  pushManager.notify('Web Console Hub', message, url);
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- API Routes ----

// List sessions
app.get('/api/sessions', (req, res) => {
  const snapshot = sessionMonitor.getSnapshot();
  res.json(snapshot);
});

// Create session
app.post('/api/sessions', (req, res) => {
  try {
    const { cli = 'claude' } = req.body || {};
    const session = sessionManager.createSession(cli);
    res.status(201).json(session);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete session
app.delete('/api/sessions/:id', (req, res) => {
  try {
    sessionManager.deleteSession(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Send text input to session
app.post('/api/sessions/:id/input', (req, res) => {
  try {
    const { text } = req.body;
    if (!text && text !== '') return res.status(400).json({ error: 'text required' });
    sessionManager.sendKeys(req.params.id, text);
    res.json({ success: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Send special key to session
app.post('/api/sessions/:id/key', (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    sessionManager.sendSpecialKey(req.params.id, key);
    res.json({ success: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// SSE stream
app.get('/api/sessions/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');
  sessionMonitor.addSSEClient(res);
});

// Google Drive
app.get('/api/gdrive/status', (req, res) => {
  res.json(gdriveManager.status());
});

app.post('/api/gdrive/mount', async (req, res) => {
  const result = await gdriveManager.mount();
  res.json(result);
});

app.post('/api/gdrive/unmount', (req, res) => {
  res.json(gdriveManager.unmount());
});

// Web Push
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: pushManager.publicKey });
});

app.post('/api/push/subscribe', (req, res) => {
  pushManager.subscribe(req.body);
  res.json({ success: true });
});

// Terminal page
app.get('/terminal/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminal.html'));
});

// ---- ttyd WebSocket Proxy ----

// HTTP proxy for ttyd
app.all('/t/:id/*', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // Strip /t/:id prefix
  req.url = req.url.replace(`/t/${req.params.id}`, '') || '/';

  proxy.web(req, res, {
    target: `http://127.0.0.1:${session.port}`,
    changeOrigin: true
  });
});

// WebSocket upgrade for ttyd
server.on('upgrade', (req, socket, head) => {
  const match = req.url.match(/^\/t\/([^/]+)/);
  if (!match) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    socket.destroy();
    return;
  }

  req.url = req.url.replace(`/t/${sessionId}`, '') || '/';

  proxy.ws(req, socket, head, {
    target: `http://127.0.0.1:${session.port}`,
    changeOrigin: true
  });
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Terminal proxy error' }));
  }
});

// ---- Start ----

const PORT = process.env.PORT || 3000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Web Console Hub Hub running on port ${PORT}`);
  sessionMonitor.start();
});
