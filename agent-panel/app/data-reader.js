/**
 * data-reader.js — Read and parse all agent daemon data sources.
 *
 * All file reads are restricted to DATA_BASE and DAEMON_DIR via prefix checks.
 */

const fs = require('fs');
const path = require('path');

const DATA_BASE = process.env.DATA_BASE || '/home/YOUR_USER/ObsidianVault/Inbox/YOUR_ASSISTANT/.sophie';
const DAEMON_DIR = process.env.DAEMON_DIR || '/home/YOUR_USER/agent-daemon';

// --- Safety ---

function safePath(base, rel) {
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

function readFileSafe(base, rel) {
  try {
    return fs.readFileSync(safePath(base, rel), 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.message === 'Path traversal blocked') throw e;
    return null;
  }
}

function dirReachable(dir) {
  try {
    fs.accessSync(dir, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// --- Frontmatter parser ---

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w[\w_-]*):\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: match[2] };
}

// --- Startup Cache ---

function readCache() {
  const raw = readFileSafe(DATA_BASE, 'startup-cache.md');
  if (!raw) return { available: false };

  const lines = raw.split('\n');
  const result = { available: true, urgent_count: 0, pending_decisions: 0, active_projects: 0, focus: [], raw_length: raw.length };

  for (const line of lines) {
    const tableMatch = line.match(/\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
    if (tableMatch) {
      const key = tableMatch[1].trim();
      const val = tableMatch[2].trim();
      if (key.includes('緊急')) result.urgent_count = parseInt(val) || 0;
      if (key.includes('待決策')) result.pending_decisions = parseInt(val) || 0;
      if (key.includes('進行中')) result.active_projects = parseInt(val) || 0;
    }
    if (line.startsWith('- ')) {
      const trimmed = line.replace(/^- /, '').trim();
      if (trimmed.match(/^[🔴❓📌⚠️]/)) result.focus.push(trimmed);
    }
  }

  return result;
}

// --- Pending Reviews ---

function listPending() {
  const dir = safePath(DATA_BASE, 'pending-review');
  if (!dirReachable(dir)) return { available: false, items: [] };

  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.endsWith('.reviewed'));
  } catch {
    return { available: false, items: [] };
  }

  files.sort().reverse(); // newest first

  return {
    available: true,
    items: files.map(f => {
      const content = readFileSafe(dir, f);
      if (!content) return { filename: f, error: true };
      const { meta, body } = parseFrontmatter(content);
      // Extract first heading as title
      const titleMatch = body.match(/^#\s+(.+)$/m);
      // Count decision points in body
      const decisionMatches = body.match(/^#{1,3}.*🔴.*$/gm);
      const decisionCount = parseInt(meta.decision_points) || (decisionMatches ? decisionMatches.length : 0);
      // Summary: first non-empty non-heading line
      const summaryLine = body.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));

      return {
        filename: f,
        status: meta.status || 'unknown',
        created: meta.created || null,
        source: meta.source || null,
        decision_points: decisionCount,
        title: titleMatch ? titleMatch[1] : f,
        summary: summaryLine ? summaryLine.trim().slice(0, 200) : ''
      };
    })
  };
}

function readPendingFile(filename) {
  // Whitelist: only .md files, no path separators
  if (!filename.endsWith('.md') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }
  const content = readFileSafe(path.join(DATA_BASE, 'pending-review'), filename);
  if (!content) return null;
  const { meta, body } = parseFrontmatter(content);
  return { meta, body, raw: content };
}

function dismissPending(filename) {
  if (!filename.endsWith('.md') || filename.includes('/') || filename.includes('\\')) {
    return false;
  }
  const dir = safePath(DATA_BASE, 'pending-review');
  const src = path.join(dir, filename);
  const dst = path.join(dir, filename + '.reviewed');
  try {
    fs.renameSync(src, dst);
    return true;
  } catch {
    return false;
  }
}

// --- Watchlist ---

function readWatchlist() {
  const raw = readFileSafe(DATA_BASE, 'watchlist.md');
  if (!raw) return { available: false };

  const now = new Date();
  const persons = [];
  const trends = [];
  const events = [];
  let currentSection = null;

  for (const line of raw.split('\n')) {
    // Section detection only on heading lines (## or ###)
    if (line.startsWith('#')) {
      if (line.includes('關鍵人物') || line.includes('AI 編碼') || line.includes('商業/科技') || line.includes('AI 研究') || line.includes('法規/政策') || line.includes('MCP 生態')) {
        currentSection = 'persons';
      } else if (line.includes('趨勢/工具')) {
        currentSection = 'trends';
      } else if (line.includes('近期重要活動')) {
        currentSection = 'events';
      } else if (line.includes('高信號來源') || line.includes('檢查記錄')) {
        currentSection = null;
      }
    }

    if (currentSection === 'persons') {
      const m = line.match(/\|\s*(P-\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\d+)天\s*\|\s*(—|[\d-]+)\s*\|/);
      if (m) {
        const lastCheck = m[6] === '—' ? null : m[6];
        const daysSince = lastCheck ? Math.floor((now - new Date(lastCheck)) / 86400000) : null;
        persons.push({
          id: m[1], name: m[2].trim(), role: m[3].trim(), focus: m[4].trim(),
          threshold: parseInt(m[5]), last_check: lastCheck, days_since: daysSince,
          overdue: lastCheck ? daysSince >= parseInt(m[5]) : true
        });
      }
    } else if (currentSection === 'trends') {
      const m = line.match(/\|\s*(T-\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\d+)天\s*\|\s*(—|[\d-]+)\s*\|/);
      if (m) {
        const lastCheck = m[5] === '—' ? null : m[5];
        const daysSince = lastCheck ? Math.floor((now - new Date(lastCheck)) / 86400000) : null;
        trends.push({
          id: m[1], topic: m[2].trim(), keywords: m[3].trim(),
          threshold: parseInt(m[4]), last_check: lastCheck, days_since: daysSince,
          overdue: lastCheck ? daysSince >= parseInt(m[4]) : true
        });
      }
    } else if (currentSection === 'events') {
      const m = line.match(/\|\s*([\d-]+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/);
      if (m && m[1].match(/^\d{2}-\d{2}$/)) {
        const eventDate = new Date(`2026-${m[1]}`);
        const daysUntil = Math.ceil((eventDate - now) / 86400000);
        events.push({
          date: `2026-${m[1]}`, name: m[2].trim(), relevance: m[3].trim(),
          days_until: daysUntil
        });
      }
    }
  }

  const overdueCount = persons.filter(p => p.overdue).length + trends.filter(t => t.overdue).length;

  return { available: true, persons, trends, events, overdue_count: overdueCount };
}

// --- Usage Stats ---

function readUsageStats() {
  const csvPath = path.join(DAEMON_DIR, 'outputs', 'usage-stats.csv');
  let raw;
  try {
    raw = fs.readFileSync(csvPath, 'utf-8');
  } catch {
    return { available: false };
  }

  const lines = raw.trim().split('\n');
  if (lines.length < 2) return { available: true, rows: [], summary: {} };

  const header = lines[0].split(',');
  const rows = lines.slice(1).map(line => {
    const cols = line.split(',');
    const obj = {};
    header.forEach((h, i) => obj[h] = cols[i] || '');
    return obj;
  });

  // Compute summary
  let totalCost = 0, totalCalls = rows.length;
  const byModel = {};

  for (const row of rows) {
    const cost = parseFloat(row.cost_usd) || 0;
    totalCost += cost;
    const model = row.model || 'unknown';
    if (!byModel[model]) byModel[model] = { calls: 0, cost: 0 };
    byModel[model].calls++;
    byModel[model].cost += cost;
  }

  // Round costs
  totalCost = Math.round(totalCost * 10000) / 10000;
  for (const m of Object.keys(byModel)) {
    byModel[m].cost = Math.round(byModel[m].cost * 10000) / 10000;
  }

  // Last 7 days
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const recentRows = rows.filter(r => new Date(r.timestamp) >= weekAgo);
  let weekCost = 0;
  for (const r of recentRows) weekCost += parseFloat(r.cost_usd) || 0;
  weekCost = Math.round(weekCost * 10000) / 10000;

  return {
    available: true,
    rows: rows.slice(-50).reverse(), // last 50, newest first
    summary: { total_cost: totalCost, total_calls: totalCalls, avg_cost: totalCalls ? Math.round(totalCost / totalCalls * 10000) / 10000 : 0, week_cost: weekCost, week_calls: recentRows.length },
    by_model: byModel
  };
}

// --- Logs ---

function listLogs() {
  const dir = safePath(DATA_BASE, path.join('memory', 'logs'));
  if (!dirReachable(dir)) return { available: false, files: [] };

  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/));
  } catch {
    return { available: false, files: [] };
  }

  files.sort().reverse(); // newest first
  return { available: true, files: files.slice(0, 14) }; // last 14 days
}

function readLog(date) {
  if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) return null;
  const content = readFileSafe(path.join(DATA_BASE, 'memory', 'logs'), `${date}.md`);
  return content;
}

// --- Config (sanitized) ---

function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(DAEMON_DIR, 'config.json'), 'utf-8');
  } catch {
    return { available: false };
  }

  const config = JSON.parse(raw);
  // Remove absolute paths for security
  const sanitized = {
    heartbeat_interval_seconds: config.heartbeat_interval_seconds,
    heartbeat_interval_human: `${Math.round(config.heartbeat_interval_seconds / 3600)}h`,
    max_items_per_cycle: config.max_items_per_cycle,
    claude_model_watchlist: config.claude_model_watchlist,
    claude_model_urgent: config.claude_model_urgent,
    claude_timeout_seconds: config.claude_timeout_seconds,
    claude_allowed_tools: config.claude_allowed_tools,
    log_retention_days: config.log_retention_days,
    pending_review_archive_days: config.pending_review_archive_days
  };

  return { available: true, config: sanitized };
}

// --- Aggregated Status ---

function getStatus() {
  const reachable = dirReachable(DATA_BASE);
  const cache = readCache();
  const pending = listPending();
  const watchlist = readWatchlist();
  const usage = readUsageStats();

  return {
    timestamp: new Date().toISOString(),
    data_reachable: reachable,
    cache,
    pending: { count: pending.items ? pending.items.length : 0, items: pending.items ? pending.items.slice(0, 5) : [] },
    watchlist: { overdue_count: watchlist.overdue_count || 0 },
    usage: usage.summary || {}
  };
}

module.exports = {
  readCache, listPending, readPendingFile, dismissPending,
  readWatchlist, readUsageStats, listLogs, readLog,
  readConfig, getStatus, dirReachable,
  DATA_BASE, DAEMON_DIR
};
