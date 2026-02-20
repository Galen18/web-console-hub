/**
 * daemon-ctl.js — Wrapper for systemctl operations on agent-daemon service.
 *
 * Only hardcoded commands — no user input passed to shell.
 */

const { execFile } = require('child_process');

const SERVICE_NAME = 'agent-daemon';
let lastScanTime = 0;
const SCAN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function getStatus() {
  return new Promise((resolve) => {
    execFile('systemctl', ['show', SERVICE_NAME, '--no-pager',
      '-p', 'ActiveState,SubState,MainPID,MemoryCurrent,ExecMainStartTimestamp'],
      { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve({ active: false, error: err.message });
          return;
        }
        const props = {};
        for (const line of stdout.split('\n')) {
          const [k, ...v] = line.split('=');
          if (k) props[k.trim()] = v.join('=').trim();
        }

        const startTs = props.ExecMainStartTimestamp;
        let uptime = null;
        if (startTs) {
          // Format: "Fri 2026-02-20 23:32:39 CST" — strip day name and TZ abbreviation
          const cleaned = startTs.replace(/^\w+\s+/, '').replace(/\s+\w+$/, '');
          const startDate = new Date(cleaned);
          if (!isNaN(startDate)) {
            uptime = Math.floor((Date.now() - startDate.getTime()) / 1000);
          }
        }

        const memBytes = parseInt(props.MemoryCurrent);
        const memMB = !isNaN(memBytes) ? Math.round(memBytes / 1024 / 1024) : null;

        resolve({
          active: props.ActiveState === 'active',
          state: props.ActiveState || 'unknown',
          sub_state: props.SubState || 'unknown',
          pid: parseInt(props.MainPID) || null,
          memory_mb: memMB,
          uptime_seconds: uptime,
          uptime_human: uptime !== null ? formatUptime(uptime) : null
        });
      });
  });
}

function triggerScan() {
  const now = Date.now();
  if (now - lastScanTime < SCAN_COOLDOWN_MS) {
    const remaining = Math.ceil((SCAN_COOLDOWN_MS - (now - lastScanTime)) / 1000);
    return Promise.resolve({ triggered: false, cooldown: true, remaining_seconds: remaining });
  }

  return new Promise((resolve) => {
    const daemonDir = process.env.DAEMON_DIR || '/home/YOUR_USER/agent-daemon';
    execFile('python3', [daemonDir + '/daemon.py', '--once'],
      { timeout: 60000, cwd: daemonDir }, (err, stdout, stderr) => {
        lastScanTime = Date.now();
        if (err) {
          resolve({ triggered: true, success: false, error: err.message });
          return;
        }
        resolve({ triggered: true, success: true, output: (stdout || '').slice(-500) });
      });
  });
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

module.exports = { getStatus, triggerScan };
