const express = require('express');
const path = require('path');
const data = require('./app/data-reader');
const daemon = require('./app/daemon-ctl');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API Routes ---

// Aggregated dashboard status
app.get('/api/status', (req, res) => {
  res.json(data.getStatus());
});

// Daemon systemd status
app.get('/api/daemon', async (req, res) => {
  const status = await daemon.getStatus();
  res.json(status);
});

// Trigger manual scan (10min cooldown)
app.post('/api/daemon/scan', async (req, res) => {
  const result = await daemon.triggerScan();
  res.json(result);
});

// List pending reviews
app.get('/api/pending', (req, res) => {
  res.json(data.listPending());
});

// Read single pending file
app.get('/api/pending/:filename', (req, res) => {
  const result = data.readPendingFile(req.params.filename);
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

// Dismiss (mark as reviewed)
app.post('/api/pending/:filename/dismiss', (req, res) => {
  const ok = data.dismissPending(req.params.filename);
  if (!ok) return res.status(404).json({ error: 'Failed to dismiss' });
  res.json({ success: true });
});

// Watchlist
app.get('/api/watchlist', (req, res) => {
  res.json(data.readWatchlist());
});

// Startup cache
app.get('/api/cache', (req, res) => {
  res.json(data.readCache());
});

// Usage stats
app.get('/api/usage', (req, res) => {
  res.json(data.readUsageStats());
});

// Logs
app.get('/api/logs', (req, res) => {
  res.json(data.listLogs());
});

app.get('/api/logs/:date', (req, res) => {
  const content = data.readLog(req.params.date);
  if (!content) return res.status(404).json({ error: 'Not found' });
  res.json({ date: req.params.date, content });
});

// Config (sanitized)
app.get('/api/config', (req, res) => {
  res.json(data.readConfig());
});

// --- Start ---

const PORT = process.env.PORT || 3001;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Panel running on port ${PORT}`);
});
