const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProbeDatabase } = require('../lib/db');

test('ProbeDatabase migrates legacy JSON and persists metrics/latency/uptime', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanz-db-test-'));
  const metricsFile = path.join(tmpDir, 'metrics_history.json');
  const latencyFile = path.join(tmpDir, 'latency_history.json');
  const uptimeFile = path.join(tmpDir, 'uptime_history.json');

  fs.writeFileSync(metricsFile, JSON.stringify({ 'node-1': [{ t: 1700000000, cpu: 12.5, mem: 45.0, swap: 1.0 }] }));
  fs.writeFileSync(latencyFile, JSON.stringify({ 'node-1:pt-ct': [{ t: 1700000000, lat: 145 }] }));
  fs.writeFileSync(uptimeFile, JSON.stringify({ 'node-1': [{ t: 1700000000000, status: 'online', uptimePct: 100 }] }));

  const db = new ProbeDatabase(path.join(tmpDir, 'probe.db'));
  db.migrateFromLegacyJson({ metricsFile, latencyFile, uptimeFile });

  assert.equal(fs.existsSync(`${metricsFile}.migrated.bak`), true);
  assert.deepEqual(db.loadMetricsHistory()['node-1'], [{ t: 1700000000, cpu: 12.5, mem: 45, swap: 1 }]);
  assert.deepEqual(db.loadLatencyHistory()['node-1:pt-ct'], [{ t: 1700000000, lat: 145 }]);
  assert.deepEqual(db.loadUptimeHistory()['node-1'], [{ t: 1700000000000, status: 'online', uptimePct: 100 }]);

  db.saveMetricPoint('node-1', 1700000010, 20.1, 46.0, 2.0);
  db.saveLatencyPoint('node-1', 'pt-ct', 1700000010, 152);
  assert.equal(db.loadMetricsHistory()['node-1'].length, 2);
  assert.equal(db.loadLatencyHistory()['node-1:pt-ct'].length, 2);

  db.deleteTargetData('pt-ct');
  assert.equal(db.loadLatencyHistory()['node-1:pt-ct'], undefined);

  db.deleteServerData('node-1');
  assert.equal(db.loadMetricsHistory()['node-1'], undefined);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
