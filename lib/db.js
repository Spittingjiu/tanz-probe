const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class ProbeDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics_history (
        node_id TEXT NOT NULL,
        t INTEGER NOT NULL,
        cpu REAL NOT NULL,
        mem REAL NOT NULL,
        swap REAL NOT NULL,
        PRIMARY KEY (node_id, t)
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_node_t ON metrics_history(node_id, t);

      CREATE TABLE IF NOT EXISTS latency_history (
        node_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        t INTEGER NOT NULL,
        lat REAL NOT NULL,
        PRIMARY KEY (node_id, target_id, t)
      );
      CREATE INDEX IF NOT EXISTS idx_latency_nt_t ON latency_history(node_id, target_id, t);

      CREATE TABLE IF NOT EXISTS uptime_history (
        node_id TEXT NOT NULL,
        t INTEGER NOT NULL,
        status TEXT NOT NULL,
        uptime_pct REAL NOT NULL,
        PRIMARY KEY (node_id, t)
      );
      CREATE INDEX IF NOT EXISTS idx_uptime_node_t ON uptime_history(node_id, t);
    `);

    this.stmts = {
      upsertMetric: this.db.prepare(
        'INSERT OR REPLACE INTO metrics_history (node_id, t, cpu, mem, swap) VALUES (?, ?, ?, ?, ?)'
      ),
      upsertLatency: this.db.prepare(
        'INSERT OR REPLACE INTO latency_history (node_id, target_id, t, lat) VALUES (?, ?, ?, ?)'
      ),
      upsertUptime: this.db.prepare(
        'INSERT OR REPLACE INTO uptime_history (node_id, t, status, uptime_pct) VALUES (?, ?, ?, ?)'
      ),
      delMetricsByNode: this.db.prepare('DELETE FROM metrics_history WHERE node_id = ?'),
      delLatencyByNode: this.db.prepare('DELETE FROM latency_history WHERE node_id = ?'),
      delUptimeByNode: this.db.prepare('DELETE FROM uptime_history WHERE node_id = ?'),
      delLatencyByTarget: this.db.prepare('DELETE FROM latency_history WHERE target_id = ?'),
      delAllLatency: this.db.prepare('DELETE FROM latency_history'),
      pruneMetricsBefore: this.db.prepare('DELETE FROM metrics_history WHERE t < ?'),
      pruneLatencyBefore: this.db.prepare('DELETE FROM latency_history WHERE t < ?'),
      pruneUptimeBefore: this.db.prepare('DELETE FROM uptime_history WHERE t < ?')
    };
  }

  migrateFromLegacyJson({ metricsFile, latencyFile, uptimeFile }) {
    const countRow = (table) => this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

    if (metricsFile && fs.existsSync(metricsFile) && countRow('metrics_history') === 0) {
      try {
        const raw = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
        if (raw && typeof raw === 'object') {
          this.db.exec('BEGIN');
          try {
            for (const [nodeId, pts] of Object.entries(raw)) {
              if (!Array.isArray(pts)) continue;
              for (const p of pts) {
                if (p && Number.isFinite(Number(p.t))) {
                  this.stmts.upsertMetric.run(nodeId, Math.floor(Number(p.t)), Number(p.cpu) || 0, Number(p.mem) || 0, Number(p.swap) || 0);
                }
              }
            }
            this.db.exec('COMMIT');
            fs.renameSync(metricsFile, `${metricsFile}.migrated.bak`);
          } catch (e) {
            this.db.exec('ROLLBACK');
          }
        }
      } catch (e) {}
    }

    if (latencyFile && fs.existsSync(latencyFile) && countRow('latency_history') === 0) {
      try {
        const raw = JSON.parse(fs.readFileSync(latencyFile, 'utf8'));
        if (raw && typeof raw === 'object') {
          this.db.exec('BEGIN');
          try {
            for (const [key, pts] of Object.entries(raw)) {
              if (!key.includes(':') || !Array.isArray(pts)) continue;
              const idx = key.indexOf(':');
              const nodeId = key.slice(0, idx);
              const targetId = key.slice(idx + 1);
              for (const p of pts) {
                if (p && Number.isFinite(Number(p.t))) {
                  this.stmts.upsertLatency.run(nodeId, targetId, Math.floor(Number(p.t)), Number(p.lat ?? -1));
                }
              }
            }
            this.db.exec('COMMIT');
            fs.renameSync(latencyFile, `${latencyFile}.migrated.bak`);
          } catch (e) {
            this.db.exec('ROLLBACK');
          }
        }
      } catch (e) {}
    }

    if (uptimeFile && fs.existsSync(uptimeFile) && countRow('uptime_history') === 0) {
      try {
        const raw = JSON.parse(fs.readFileSync(uptimeFile, 'utf8'));
        if (raw && typeof raw === 'object') {
          this.db.exec('BEGIN');
          try {
            for (const [nodeId, pts] of Object.entries(raw)) {
              if (!Array.isArray(pts)) continue;
              for (const p of pts) {
                if (p && Number.isFinite(Number(p.t))) {
                  this.stmts.upsertUptime.run(nodeId, Math.floor(Number(p.t)), String(p.status || 'online'), Number(p.uptimePct ?? 100));
                }
              }
            }
            this.db.exec('COMMIT');
            fs.renameSync(uptimeFile, `${uptimeFile}.migrated.bak`);
          } catch (e) {
            this.db.exec('ROLLBACK');
          }
        }
      } catch (e) {}
    }
  }

  loadMetricsHistory() {
    const out = {};
    const rows = this.db.prepare('SELECT node_id, t, cpu, mem, swap FROM metrics_history ORDER BY node_id, t ASC').all();
    for (const r of rows) {
      if (!out[r.node_id]) out[r.node_id] = [];
      out[r.node_id].push({ t: r.t, cpu: r.cpu, mem: r.mem, swap: r.swap });
    }
    return out;
  }

  loadLatencyHistory() {
    const out = {};
    const rows = this.db.prepare('SELECT node_id, target_id, t, lat FROM latency_history ORDER BY node_id, target_id, t ASC').all();
    for (const r of rows) {
      const k = `${r.node_id}:${r.target_id}`;
      if (!out[k]) out[k] = [];
      out[k].push({ t: r.t, lat: r.lat });
    }
    return out;
  }

  loadUptimeHistory() {
    const out = {};
    const rows = this.db.prepare('SELECT node_id, t, status, uptime_pct FROM uptime_history ORDER BY node_id, t ASC').all();
    for (const r of rows) {
      if (!out[r.node_id]) out[r.node_id] = [];
      out[r.node_id].push({ t: r.t, status: r.status, uptimePct: r.uptime_pct });
    }
    return out;
  }

  saveMetricPoint(nodeId, t, cpu, mem, swap) {
    this.stmts.upsertMetric.run(nodeId, t, cpu, mem, swap);
  }

  saveLatencyPoint(nodeId, targetId, t, lat) {
    this.stmts.upsertLatency.run(nodeId, targetId, t, lat);
  }

  saveUptimeList(nodeId, list) {
    this.db.exec('BEGIN');
    try {
      this.stmts.delUptimeByNode.run(nodeId);
      for (const item of list) {
        this.stmts.upsertUptime.run(nodeId, Math.floor(item.t), String(item.status || 'online'), Number(item.uptimePct ?? 100));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
    }
  }

  saveUptimeSlice(nodeId, t, status, uptimePct) {
    this.stmts.upsertUptime.run(nodeId, Math.floor(t), String(status || 'online'), Number(uptimePct ?? 100));
  }

  deleteServerData(nodeId) {
    this.stmts.delMetricsByNode.run(nodeId);
    this.stmts.delLatencyByNode.run(nodeId);
    this.stmts.delUptimeByNode.run(nodeId);
  }

  deleteTargetData(targetId) {
    this.stmts.delLatencyByTarget.run(targetId);
  }

  clearLatencyHistory() {
    this.stmts.delAllLatency.run();
  }

  pruneOldData(nowSec = Math.floor(Date.now() / 1000)) {
    const cutoffSec = nowSec - (48 * 3600);
    const cutoffUptimeMs = Date.now() - (35 * 24 * 3600 * 1000);
    this.stmts.pruneMetricsBefore.run(cutoffSec);
    this.stmts.pruneLatencyBefore.run(cutoffSec);
    this.stmts.pruneUptimeBefore.run(cutoffUptimeMs);
  }

  close() {
    this.db.close();
  }
}

module.exports = { ProbeDatabase };
