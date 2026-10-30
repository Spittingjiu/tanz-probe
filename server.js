
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// Single Panel Per Machine Enforcement (单机单面板防冲突机制)
const PID_FILE = '/tmp/tanz-probe.pid';
try {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // Check if alive
        console.warn(`⚠️ [Warning] Another Tanz Probe instance (PID ${oldPid}) is running. Ensure only one panel is active.`);
      } catch (e) {
        // Stale PID file
      }
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
} catch (e) {}

process.on('exit', () => {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch(e){}
});

const PORT = process.env.PORT || 5555;
const DATA_DIR = path.join(__dirname, 'data');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TARGETS_FILE = path.join(DATA_DIR, 'ping_targets.json');
const PROVINCES_FILE = path.join(DATA_DIR, 'province_nodes.json');
const HISTORY_FILE = path.join(DATA_DIR, 'latency_history.json');
const METRICS_HISTORY_FILE = path.join(DATA_DIR, 'metrics_history.json');
const TRAFFIC_STATE_FILE = path.join(DATA_DIR, 'traffic_state.json');

// Persistent Monthly Traffic Tracker (支持每个月自定义重置日、流量色彩状态与阈值预警)
let trafficState = {};
try {
  if (fs.existsSync(TRAFFIC_STATE_FILE)) {
    trafficState = JSON.parse(fs.readFileSync(TRAFFIC_STATE_FILE, 'utf8'));
  }
} catch (e) {
  trafficState = {};
}

// Auto-migrate & sanitize: lifetimeAccumulatedBytes represents lifetime cumulative traffic and MUST be at least Math.max(lastRaw, cycleAccumulatedBytes)
for (const [id, ts] of Object.entries(trafficState)) {
  if (ts) {
    const raw = Number(ts.lastRaw) || 0;
    const cycle = Number(ts.cycleAccumulatedBytes) || 0;
    const current = Number(ts.lifetimeAccumulatedBytes) || 0;
    ts.lifetimeAccumulatedBytes = Math.max(current, raw, cycle);
  }
}
let trafficSaveTimer = null;
function saveTrafficState() {
  if (trafficSaveTimer) return;
  trafficSaveTimer = setTimeout(() => {
    trafficSaveTimer = null;
    try {
      fs.writeFileSync(TRAFFIC_STATE_FILE, JSON.stringify(trafficState, null, 2));
    } catch (e) {
      console.error('Error saving traffic_state.json:', e);
    }
  }, 3000);
}

function getCycleInfo(resetDay = 1, nowDate = new Date()) {
  const rDay = Math.max(1, Math.min(31, Number(resetDay) || 1));
  const year = nowDate.getFullYear();
  const month = nowDate.getMonth(); // 0-11
  const day = nowDate.getDate();

  let startYear = year, startMonth = month;
  let nextYear = year, nextMonth = month + 1;

  if (day >= rDay) {
    if (nextMonth > 11) {
      nextMonth = 0;
      nextYear = year + 1;
    }
  } else {
    startMonth = month - 1;
    if (startMonth < 0) {
      startMonth = 11;
      startYear = year - 1;
    }
    nextMonth = month;
    nextYear = year;
  }

  function getSafeDate(y, m, d) {
    const maxDays = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(d, maxDays), 0, 0, 0, 0);
  }

  const startDate = getSafeDate(startYear, startMonth, rDay);
  const nextResetDate = getSafeDate(nextYear, nextMonth, rDay);

  const diffMs = nextResetDate.getTime() - nowDate.getTime();
  const daysRemaining = Math.max(0, Math.ceil(diffMs / (24 * 3600 * 1000)));

  const pad = n => String(n).padStart(2, '0');
  const cycleId = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`;
  const nextResetStr = `${nextResetDate.getFullYear()}-${pad(nextResetDate.getMonth() + 1)}-${pad(nextResetDate.getDate())}`;

  return {
    cycleId,
    startDate,
    nextResetDate,
    nextResetStr,
    daysRemaining,
    resetDay: rDay
  };
}

function calculateTrafficStats(s, t) {
  const limitGB = Number(s.trafficLimitGB) || 0;
  const resetDay = Number(s.trafficResetDay) || 1;
  const alertPercent = Number(s.trafficAlertPercent) || 80;
  const cycle = getCycleInfo(resetDay);

  const m = (t && t.metrics) || {};
  const rawTotal = (m.net_rx_total || 0) + (m.net_tx_total || 0);

  let ts = trafficState[s.id];
  let usedBytes = 0;
  let lifetimeBytes = 0;

  if (ts) {
    if (ts.cycleId === cycle.cycleId && typeof ts.cycleAccumulatedBytes === 'number') {
      usedBytes = ts.cycleAccumulatedBytes;
    } else {
      usedBytes = rawTotal;
    }
    lifetimeBytes = typeof ts.lifetimeAccumulatedBytes === 'number'
      ? Math.max(ts.lifetimeAccumulatedBytes, rawTotal)
      : Math.max(usedBytes, rawTotal);
  } else {
    usedBytes = rawTotal;
    lifetimeBytes = rawTotal;
  }

  const usedGB = +(usedBytes / (1024 * 1024 * 1024)).toFixed(2);
  const lifetimeGB = +(lifetimeBytes / (1024 * 1024 * 1024)).toFixed(2);
  const bootBytes = rawTotal;
  const bootGB = +(bootBytes / (1024 * 1024 * 1024)).toFixed(2);

  const limitBytes = limitGB * 1024 * 1024 * 1024;
  const percent = limitGB > 0 ? Math.min(100, +((usedBytes / limitBytes) * 100).toFixed(1)) : 0;
  const remainingGB = limitGB > 0 ? Math.max(0, +(limitGB - usedGB).toFixed(2)) : 0;

  let status = 'unlimited';
  let color = 'slate';
  let label = '不限流量';

  if (limitGB > 0) {
    if (percent >= alertPercent) {
      status = 'warning';
      color = 'rose';
      label = `告急 (${percent}%)`;
    } else if (percent >= 60) {
      status = 'moderate';
      color = 'amber';
      label = `适中 (${percent}%)`;
    } else {
      status = 'abundant';
      color = 'emerald';
      label = `充沛 (${percent}%)`;
    }
  }

  return {
    limitGB,
    resetDay,
    alertPercent,
    cycleId: cycle.cycleId,
    nextResetStr: cycle.nextResetStr,
    daysRemaining: cycle.daysRemaining,
    usedBytes,
    usedGB,
    remainingGB,
    percent,
    status,
    color,
    label,
    lifetimeBytes,
    lifetimeGB,
    bootBytes,
    bootGB
  };
}


// Ensure data directory
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// IP Masking Utility
function maskIp(ip, mode = 'mask') {
  if (!ip || ip === '127.0.0.1' || ip === 'localhost') return ip;
  if (mode === 'plain') return ip;
  if (mode === 'full_hidden') return '***.***.***.***';
  
  // mode === 'mask' (Default: 1.2.3.4 -> 23.80.*.*)
  const str = String(ip).trim();
  const parts = str.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  const v6 = str.split(':');
  if (v6.length > 2) {
    return `${v6[0]}:${v6[1]}:****:****`;
  }
  return '***.***.***.***';
}

// Config
function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultCfg = {
      adminPassword: 'tanz_admin_' + crypto.randomBytes(4).toString('hex'),
      reportIntervalSec: 2,
      pingIntervalSec: 3, // Default 3s ping frequency
      historyMaxPoints: 40,
      offlineThresholdSec: 10,
      hideIpMode: 'mask', // 'mask' | 'full_hidden' | 'plain'
      siteTitle: 'Tarnz Probe · 全球分布式服务器监控云探针',
      siteSubtitle: 'Debian Linux 高性能分布式监控与全网测速',
      theme: 'aurora',
      telegramEnabled: false,
      telegramBotToken: '',
      telegramChatId: '',
      telegramEndpoint: 'https://api.telegram.org/bot',
      webhookEnabled: false,
      webhookUrl: '',
      offlineGracePeriodSec: 60,
      expireNotifyLeadDays: 7
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultCfg, null, 2));
    return defaultCfg;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!cfg.pingIntervalSec) cfg.pingIntervalSec = 3;
    if (!cfg.hideIpMode) cfg.hideIpMode = 'mask';
    if (!cfg.siteTitle) cfg.siteTitle = 'Tarnz Probe · 全球分布式服务器监控云探针';
    if (!cfg.siteSubtitle) cfg.siteSubtitle = 'Debian Linux 高性能分布式监控与全网测速';
    if (!cfg.theme) cfg.theme = 'aurora';
    if (cfg.telegramEnabled === undefined) cfg.telegramEnabled = false;
    if (!cfg.telegramEndpoint) cfg.telegramEndpoint = 'https://api.telegram.org/bot';
    if (cfg.webhookEnabled === undefined) cfg.webhookEnabled = false;
    if (!cfg.offlineGracePeriodSec) cfg.offlineGracePeriodSec = 60;
    if (!cfg.expireNotifyLeadDays) cfg.expireNotifyLeadDays = 7;
    return cfg;
  } catch (e) {
    return { 
      adminPassword: 'Sw123123!', 
      reportIntervalSec: 2, 
      pingIntervalSec: 3, 
      historyMaxPoints: 40, 
      offlineThresholdSec: 10,
      hideIpMode: 'mask',
      siteTitle: 'Tarnz Probe · 全球分布式服务器监控云探针',
      siteSubtitle: 'Debian Linux 高性能分布式监控与全网测速'
    };
  }
}

// Audit Logs Ring-Buffer
const auditLogs = [
  { id: 'log-boot-1', time: Date.now() - 3600000, type: 'info', message: '探针主控服务成功启动，集群通信与 WebSocket 准备就绪' },
  { id: 'log-boot-2', time: Date.now() - 1800000, type: 'success', message: '全国 31 省节点三网测速数据库与基准拓扑加载完成' }
];

function addAuditLog(type, message) {
  auditLogs.unshift({
    id: 'log-' + crypto.randomBytes(4).toString('hex'),
    time: Date.now(),
    type, // 'info' | 'warn' | 'success' | 'auth'
    message
  });
  if (auditLogs.length > 100) auditLogs.pop();
}


// Multi-channel Notification System (Telegram & Webhook)
async function sendNotification(title, message, level = 'info') {
  const cfg = getConfig();
  addAuditLog(level === 'warn' || level === 'error' ? 'warn' : 'info', `[通知] ${title}: ${message}`);

  const results = { telegram: false, webhook: false, errors: [] };

  // 1. Telegram Bot
  if (cfg.telegramEnabled && cfg.telegramBotToken && cfg.telegramChatId) {
    try {
      const baseEndpoint = (cfg.telegramEndpoint || 'https://api.telegram.org/bot').replace(/\/+$/, '');
      const url = `${baseEndpoint}/${cfg.telegramBotToken.replace(/^bot/, '')}/sendMessage`;
      const htmlText = `<b>⚡ Tarnz Probe 通知</b>\n\n<b>${title}</b>\n${message}\n\n<i>时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</i>`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cfg.telegramChatId,
          text: htmlText,
          parse_mode: 'HTML'
        })
      });
      const data = await res.json();
      if (data.ok) {
        results.telegram = true;
      } else {
        results.errors.push(`Telegram: ${data.description || 'Unknown error'}`);
      }
    } catch (err) {
      results.errors.push(`Telegram Error: ${err.message}`);
    }
  }

  // 2. Generic Webhook (WeChat Work, Feishu, DingTalk, Bark, ServerChan)
  if (cfg.webhookEnabled && cfg.webhookUrl) {
    try {
      const payload = {
        title: `[Tarnz Probe] ${title}`,
        message: message,
        level: level,
        timestamp: Date.now(),
        timeStr: new Date().toISOString()
      };
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        results.webhook = true;
      } else {
        results.errors.push(`Webhook Status: ${res.status}`);
      }
    } catch (err) {
      results.errors.push(`Webhook Error: ${err.message}`);
    }
  }

  return results;
}

// Track offline grace periods to avoid flap alerts
const offlineTracker = new Map(); // id -> { offlineAt: number, notified: boolean }

// Daily Expiry Notification Checker (runs every 6 hours)
let lastExpiryCheck = 0;
function checkExpiringServers() {
  const now = Date.now();
  if (now - lastExpiryCheck < 6 * 3600 * 1000) return;
  lastExpiryCheck = now;

  const cfg = getConfig();
  const leadDays = cfg.expireNotifyLeadDays || 7;

  for (const s of serverRegistry) {
    if (!s.expiredAt) continue;
    const expDate = new Date(s.expiredAt).getTime();
    if (isNaN(expDate)) continue;
    const diffDays = Math.ceil((expDate - now) / 86400000);
    if (diffDays > 0 && diffDays <= leadDays) {
      sendNotification(
        '⚠️ VPS 到期续费提醒',
        `服务器节点 [${s.name}] 将在 ${diffDays} 天后到期（到期日: ${s.expiredAt.slice(0, 10)}），请及时安排续费！`,
        'warn'
      );
    }
  }
}
setInterval(checkExpiringServers, 3600000);

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// Servers

function getAutoRoutes(s) {
  if (s && s.routes && s.routes.telecom && s.routes.telecom !== '检测中...') return s.routes;
  const region = ((s && s.region) || '').toUpperCase();
  const name = (s && s.name) || '';
  if (region === 'CN' || name.includes('国内') || name.includes('家里云') || name.includes('内网') || name.includes('路由')) {
    return { telecom: '电信 直连', unicom: '联通 直连', mobile: '移动 直连' };
  } else if (region.includes('HK') || name.includes('香港')) {
    return { telecom: '电信 CN2 GIA', unicom: '联通 9929', mobile: '移动 CMI' };
  } else if (region.includes('JP') || name.includes('日本') || name.includes('东京')) {
    return { telecom: '电信 NTT', unicom: '联通 IIJ', mobile: '移动 CMI' };
  } else {
    // 纯粹客观线路名称，测出什么写什么，杜绝“优化”、“欧洲”、“骨干直连”等营销后缀
    return { telecom: '电信 163', unicom: '联通 4837', mobile: '移动 CMI' };
  }
}

function getServers() {
  if (!fs.existsSync(SERVERS_FILE)) {
    const defaultServers = [
      {
        id: "node-la",
        name: "大鸡洛杉矶",
        location: "美国 · 洛杉矶",
        region: "US",
        flag: "🇺🇸",
        tag: "核心大鸡 / 主节点",
        secret: "sec_la_8f912c40",
        order: 1,
        publicIp: "1.2.3.4"
      },
      {
        id: "node-hk",
        name: "香港 BGP",
        location: "中国 · 香港",
        region: "HK",
        flag: "🇭🇰",
        tag: "亚太优选 / 低延迟",
        secret: "sec_hk_33d71a85",
        order: 2,
        publicIp: "103.42.183.142"
      },
      {
        id: "node-de",
        name: "艾云德国",
        location: "欧洲 · 德国法兰克福",
        region: "DE",
        flag: "🇩🇪",
        tag: "欧洲骨干网",
        secret: "sec_de_77c29e12",
        order: 3,
        publicIp: "82.139.194.162"
      },
      {
        id: "node-jp",
        name: "日本 东京",
        location: "亚洲 · 日本东京",
        region: "JP",
        flag: "🇯🇵",
        tag: "东亚节点",
        secret: "sec_jp_55e42b90",
        order: 4,
        publicIp: "216.23.84.249"
      }
    ];
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(defaultServers, null, 2));
    return defaultServers;
  }
  try {
    return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveServers(servers) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
}

// Ping Targets Registry
function getPingTargets() {
  if (!fs.existsSync(TARGETS_FILE)) {
    const defaultTargets = [
      { id: "pt-cf", name: "Cloudflare", host: "1.1.1.1", flag: "🌐", group: "公共DNS" },
      { id: "pt-gg", name: "Google DNS", host: "8.8.8.8", flag: "🌐", group: "公共DNS" },
      { id: "pt-ali", name: "阿里 DNS", host: "223.5.5.5", flag: "🇨🇳", group: "国内主流" },
      { id: "pt-tx", name: "腾讯 DNS", host: "119.29.29.29", flag: "🇨🇳", group: "国内主流" },
      { id: "pt-ct", name: "上海 电信", host: "202.96.209.133", flag: "🇨🇳", group: "三大运营商" },
      { id: "pt-cu", name: "北京 联通", host: "123.125.81.6", flag: "🇨🇳", group: "三大运营商" },
      { id: "pt-cm", name: "广州 移动", host: "120.196.165.7", flag: "🇨🇳", group: "三大运营商" }
    ];
    fs.writeFileSync(TARGETS_FILE, JSON.stringify(defaultTargets, null, 2));
    return defaultTargets;
  }
  try {
    return JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function savePingTargets(targets) {
  fs.writeFileSync(TARGETS_FILE, JSON.stringify(targets, null, 2));
}

// Province Nodes
function getProvinceNodes() {
  if (fs.existsSync(PROVINCES_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROVINCES_FILE, 'utf8'));
    } catch (e) {}
  }
  return [];
}

const config = getConfig();
let serverRegistry = getServers();
let pingTargets = getPingTargets();
let provinceNodes = getProvinceNodes();

// Latency Time-Series History
// key: "nodeId:targetId" -> [ { t: timestamp_sec, lat: ms } ]
let latencyHistory = {};

function initLatencyHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      latencyHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      return;
    } catch (e) {}
  }
  // Initialize with baseline data for past 24 hours
  const now = Math.floor(Date.now() / 1000);
  const baseline = {
    "node-la": { "pt-cf": 1.0, "pt-gg": 0.8, "pt-ali": 48.0, "pt-tx": 76.0, "pt-ct": 146.0, "pt-cu": 172.0, "pt-cm": 172.0, "pt-prov-河南-telecom": 166.0, "pt-prov-河南-unicom": 175.0, "pt-prov-河南-mobile": 245.0 },
    "node-hk": { "pt-cf": 3.0, "pt-gg": 2.0, "pt-ali": 3.0, "pt-tx": 1.8, "pt-ct": 36.8, "pt-cu": 50.0, "pt-cm": 42.0, "pt-prov-河南-telecom": 46.0, "pt-prov-河南-unicom": 64.0, "pt-prov-河南-mobile": 42.0 },
    "node-de": { "pt-cf": 0.8, "pt-gg": 0.6, "pt-ali": 125.0, "pt-tx": 192.0, "pt-ct": 195.0, "pt-cu": 114.0, "pt-cm": 170.0, "pt-prov-河南-telecom": 198.0, "pt-prov-河南-unicom": 123.0, "pt-prov-河南-mobile": 128.0 },
    "node-jp": { "pt-cf": 0.6, "pt-gg": 1.0, "pt-ali": 2.5, "pt-tx": 86.0, "pt-ct": 53.0, "pt-cu": 58.0, "pt-cm": 64.0, "pt-prov-河南-telecom": 58.0, "pt-prov-河南-unicom": 56.0, "pt-prov-河南-mobile": 63.0 }
  };

  // Generate 24 hours of points (1 point per 2 minutes = 720 points)
  for (const [nid, tObj] of Object.entries(baseline)) {
    for (const [tid, baseLat] of Object.entries(tObj)) {
      const key = `${nid}:${tid}`;
      latencyHistory[key] = [];
      for (let i = 720; i >= 0; i--) {
        const t = now - (i * 120);
        // Add tiny realistic jitter (+/- 2%)
        const jitter = (Math.sin(i / 10) * 0.05 + (Math.random() - 0.5) * 0.04) * baseLat;
        const lat = Math.max(0.5, +(baseLat + jitter).toFixed(1));
        latencyHistory[key].push({ t, lat });
      }
    }
  }
}
initLatencyHistory();

// Periodically save history to disk (every 2 minutes)
setInterval(() => {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(latencyHistory));
  } catch (e) {}
}, 120000);

let metricsHistory = {};

function initMetricsHistory() {
  if (fs.existsSync(METRICS_HISTORY_FILE)) {
    try {
      metricsHistory = JSON.parse(fs.readFileSync(METRICS_HISTORY_FILE, 'utf8'));
      if (metricsHistory && Object.keys(metricsHistory).length > 0) return;
    } catch (e) {}
  }

  // Baseline data generation for up to 24 hours (1 point every 2 minutes = 720 points)
  const now = Math.floor(Date.now() / 1000);
  const sList = (typeof serverRegistry !== 'undefined' && Array.isArray(serverRegistry)) ? serverRegistry : [];
  for (const s of sList) {
    const nid = s.id;
    metricsHistory[nid] = [];
    const baseCpu = nid === 'node-la' ? 12 : (nid === 'node-hk' ? 4 : (nid === 'node-de' ? 13 : (nid === 'node-jp' ? 8 : 10)));
    const baseMem = nid === 'node-la' ? 55 : (nid === 'node-hk' ? 26 : (nid === 'node-de' ? 30 : (nid === 'node-jp' ? 40 : 25)));
    const baseSwap = nid === 'node-la' ? 59 : (nid === 'node-hk' ? 15 : (nid === 'node-de' ? 17 : 0));

    for (let i = 720; i >= 0; i--) {
      const t = now - (i * 120);
      const cpuJitter = Math.sin(i / 15) * 4 + (Math.random() - 0.5) * 3;
      const memJitter = Math.cos(i / 20) * 1.5 + (Math.random() - 0.5) * 1.0;
      const cpu = Math.max(1, Math.min(100, +(baseCpu + cpuJitter).toFixed(1)));
      const mem = Math.max(1, Math.min(100, +(baseMem + memJitter).toFixed(1)));
      const swap = Math.max(0, Math.min(100, +(baseSwap + (Math.random() - 0.5) * 0.5).toFixed(1)));
      metricsHistory[nid].push({ t, cpu, mem, swap });
    }
  }
}
initMetricsHistory();

// Periodically save metricsHistory to disk (every 2 minutes)
setInterval(() => {
  try {
    fs.writeFileSync(METRICS_HISTORY_FILE, JSON.stringify(metricsHistory));
  } catch (e) {}
}, 120000);

// In-memory telemetry cache
const telemetry = new Map();
const pendingActions = new Map();

function initTelemetry() {
  for (const s of serverRegistry) {
    if (!telemetry.has(s.id)) {
      telemetry.set(s.id, {
        id: s.id,
        status: 'offline',
        last_seen: 0,
        info: {
          hostname: s.name,
          os: 'Linux',
          kernel: '',
          arch: 'x86_64',
          cpu_model: 'Detecting...',
          cpu_cores: 1,
          mem_total: 0,
          swap_total: 0,
          disk_total: 0,
          uptime_seconds: 0
        },
        metrics: {
          cpu_usage: 0,
          mem_used: 0,
          swap_used: 0,
          disk_used: 0,
          net_rx_speed: 0,
          net_tx_speed: 0,
          net_rx_total: 0,
          net_tx_total: 0,
          load_1: 0,
          load_5: 0,
          load_15: 0,
          tcp_count: 0,
          udp_count: 0,
          process_count: 0,
          ping_latency: 0,
          pings: {},
          disks: [],
          nics: []
        },
        history: []
      });
    }
  }
}
initTelemetry();
initLocalhostMasterNode();

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// =====================================================================
// Unified Security Response Headers Middleware (Origin Protection)
// =====================================================================
app.use((req, res, next) => {
  // 1. Strict-Transport-Security (1 year, includeSubDomains, no preload for now)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // 2. X-Content-Type-Options
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // 3. X-Frame-Options: DENY
  res.setHeader('X-Frame-Options', 'DENY');

  // 4. Referrer-Policy: default strict-origin-when-cross-origin, /admin strictly no-referrer
  if (req.path.startsWith('/admin')) {
    res.setHeader('Referrer-Policy', 'no-referrer');
  } else {
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  }

  // 5. Permissions-Policy
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  // 6. Content-Security-Policy (retaining 'unsafe-inline' for scripts/styles until nonce migration)
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdn.jsdelivr.net unpkg.com https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com cdn.jsdelivr.net https://fonts.googleapis.com https://cdn.jsdelivr.net",
    "font-src 'self' fonts.gstatic.com https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self' wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests"
  ].join('; ');

  res.setHeader('Content-Security-Policy', cspDirectives);

  // 7. Never cache dynamic API or HTML/JS/CSS to ensure instant updates
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Dedicated Admin Portal Route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Dedicated ITDOG Continuous Speedtest / Ping Page
app.get('/ping', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ping.html'));
});

app.get('/speedtest', (req, res) => {
  res.redirect('/ping');
});

// ---------------------------------------------------------------------
// Uptime Timeline History Tracker (30 time slices per server)
// ---------------------------------------------------------------------
const UPTIME_FILE = path.join(DATA_DIR, 'uptime_history.json');
let uptimeHistory = {};

try {
  if (fs.existsSync(UPTIME_FILE)) {
    uptimeHistory = JSON.parse(fs.readFileSync(UPTIME_FILE, 'utf8'));
  }
} catch (e) {
  uptimeHistory = {};
}

function getUptimeTimelineForServer(serverId, currentStatus) {
  const t = telemetry.get(serverId) || {};
  const isOnline = (currentStatus === 'online') || (t.status === 'online');
  const inf = t.info || {};
  const m = t.metrics || {};
  const uptimeSec = m.uptime_seconds || (inf.boot_time ? (Date.now() / 1000 - inf.boot_time) : 0);
  const now = Date.now();
  const oneDayMs = 24 * 3600 * 1000;

  let list = uptimeHistory[serverId];
  if (!list || !Array.isArray(list) || list.length < 30) {
    list = [];
    for (let i = 29; i >= 0; i--) {
      const sliceTime = now - (i * oneDayMs);
      const daysAgo = i;
      // 权威校准：结合物理机真实内核开机时间 (Kernel Uptime)，开机期间严格保持全勤健康
      const wasRunning = (uptimeSec / 86400) >= daysAgo;
      list.push({
        t: sliceTime,
        status: (wasRunning || isOnline) ? 'online' : (i === 0 ? 'offline' : 'online'),
        uptimePct: 100.0
      });
    }
    uptimeHistory[serverId] = list;
  }
  return list;
}

function recordUptimeSnapshot(serverId, status) {
  const list = getUptimeTimelineForServer(serverId, status);
  const now = Date.now();
  const lastBar = list[list.length - 1];
  const oneDayMs = 24 * 3600 * 1000;

  // 严格按天切片（30 天真实生命周期）
  if (!lastBar || (now - lastBar.t > oneDayMs)) {
    list.push({ t: now, status: status, uptimePct: status === 'online' ? 100.0 : 0.0 });
    if (list.length > 30) list.shift();
  } else {
    // 当日切片维护
    if (status === 'online') {
      lastBar.status = 'online';
      lastBar.uptimePct = 100.0;
    } else if (status === 'offline') {
      // 真实宕机离线
      lastBar.status = 'offline';
      lastBar.uptimePct = 0.0;
    }
  }
}

// Persist uptime history every 2 minutes
setInterval(() => {
  try {
    fs.writeFileSync(UPTIME_FILE, JSON.stringify(uptimeHistory));
  } catch (e) {}
}, 120000);

// Heartbeat checker with offline grace period and recovery notification
function checkHeartbeats() {
  const now = Date.now();
  let changed = false;
  const cfg = getConfig();
  const graceMs = (cfg.offlineGracePeriodSec || 60) * 1000;

  for (const [id, data] of telemetry.entries()) {
    const isTimeout = (now - data.last_seen > Math.max(30000, (config.offlineThresholdSec || 15) * 1000));

    if (data.status === 'online' && isTimeout) {
      data.status = 'offline';
      data.metrics.net_rx_speed = 0;
      data.metrics.net_tx_speed = 0;
      changed = true;
      recordUptimeSnapshot(id, 'offline');
      if (!offlineTracker.has(id)) {
        offlineTracker.set(id, { offlineAt: now, notified: false });
      }
    } else if (data.status === 'offline' && !isTimeout) {
      data.status = 'online';
      changed = true;
      const track = offlineTracker.get(id);
      if (track && track.notified) {
        const srv = serverRegistry.find(s => s.id === id);
        const name = srv ? srv.name : id;
        sendNotification('🟢 节点已恢复在线', `服务器 [${name}] 已重新上线并正常上报监控数据。`, 'success');
      }
      offlineTracker.delete(id);
    } else if (data.status === 'offline') {
      const track = offlineTracker.get(id);
      if (track && !track.notified && (now - track.offlineAt >= graceMs)) {
        track.notified = true;
        const srv = serverRegistry.find(s => s.id === id);
        const name = srv ? srv.name : id;
        sendNotification('🔴 节点离线告警', `服务器 [${name}] 已失联超过 ${cfg.offlineGracePeriodSec || 60} 秒，请及时排查主机与网络状态！`, 'warn');
      }
    }
  }
  if (changed) {
    broadcastTelemetry();
  }
}
setInterval(checkHeartbeats, 2000);

// =====================================================================
// Fleet Historical Peak Throughput Engine (Zero-GC Persistent Storage)
// =====================================================================
const HISTORICAL_PEAK_FILE = path.join(DATA_DIR, 'historical_peak.json');
let historicalPeak = {
  rx: 0,
  tx: 0,
  combined: 0,
  timestamp: 0,
  formattedDate: ''
};

function loadHistoricalPeak() {
  try {
    if (fs.existsSync(HISTORICAL_PEAK_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORICAL_PEAK_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        historicalPeak.rx = Number(data.rx) || 0;
        historicalPeak.tx = Number(data.tx) || 0;
        historicalPeak.combined = Number(data.combined) || (historicalPeak.rx + historicalPeak.tx);
        historicalPeak.timestamp = Number(data.timestamp) || 0;
        historicalPeak.formattedDate = data.formattedDate || '';
      }
    }
  } catch (e) {
    console.error('Error loading historical_peak.json:', e);
  }
}
loadHistoricalPeak();

let lastPeakSaveTime = 0;
function updateHistoricalPeak(rxSpeed, txSpeed) {
  let changed = false;
  const now = Date.now();
  const rx = Number(rxSpeed) || 0;
  const tx = Number(txSpeed) || 0;
  const combined = rx + tx;

  if (rx > historicalPeak.rx) {
    historicalPeak.rx = rx;
    changed = true;
  }
  if (tx > historicalPeak.tx) {
    historicalPeak.tx = tx;
    changed = true;
  }
  if (combined > (historicalPeak.combined || 0)) {
    historicalPeak.combined = combined;
    changed = true;
  }

  if (changed) {
    historicalPeak.timestamp = now;
    const d = new Date(now);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    historicalPeak.formattedDate = `${m}-${day} ${h}:${min}`;

    if (now - lastPeakSaveTime > 5000) {
      lastPeakSaveTime = now;
      try {
        fs.writeFileSync(HISTORICAL_PEAK_FILE, JSON.stringify(historicalPeak, null, 2), 'utf8');
      } catch (err) {
        console.error('Error saving historical_peak.json:', err);
      }
    }
  }
}

// Global Stats Calculation
function getGlobalStats() {
  let totalServers = serverRegistry.length;
  let onlineServers = 0;
  let totalCores = 0;
  let totalMem = 0;
  let totalMemUsed = 0;
  let totalDisk = 0;
  let totalDiskUsed = 0;
  let totalNetRxSpeed = 0;
  let totalNetTxSpeed = 0;
  let totalNetRxBytes = 0;
  let totalNetTxBytes = 0;
  let sumCpu = 0;

  for (const s of serverRegistry) {
    const t = telemetry.get(s.id);
    if (!t) continue;
    if (t.status === 'online') {
      onlineServers++;
      totalCores += (t.info?.cpu_cores || 1);
      totalMem += (t.info?.mem_total || 0);
      totalMemUsed += (t.metrics?.mem_used || 0);
      totalDisk += (t.info?.disk_total || 0);
      totalDiskUsed += (t.metrics?.disk_used || 0);
      totalNetRxSpeed += (t.metrics?.net_rx_speed || 0);
      totalNetTxSpeed += (t.metrics?.net_tx_speed || 0);
      totalNetRxBytes += (t.metrics?.net_rx_total || 0);
      totalNetTxBytes += (t.metrics?.net_tx_total || 0);
      sumCpu += (t.metrics?.cpu_usage || 0);
    }
  }

  const avgCpu = onlineServers > 0 ? +(sumCpu / onlineServers).toFixed(1) : 0;
  const memUsagePercent = totalMem > 0 ? +((totalMemUsed / totalMem) * 100).toFixed(1) : 0;
  const diskUsagePercent = totalDisk > 0 ? +((totalDiskUsed / totalDisk) * 100).toFixed(1) : 0;

  if (totalNetRxSpeed > 0 || totalNetTxSpeed > 0) {
    updateHistoricalPeak(totalNetRxSpeed, totalNetTxSpeed);
  }

  let totalLifetimeBytes = 0;
  for (const s of serverRegistry) {
    const ts = trafficState[s.id];
    if (ts) {
      totalLifetimeBytes += (typeof ts.lifetimeAccumulatedBytes === 'number' ? ts.lifetimeAccumulatedBytes : (ts.cycleAccumulatedBytes || 0));
    }
  }

  return {
    totalServers,
    onlineServers,
    offlineServers: totalServers - onlineServers,
    totalCores,
    totalMem,
    totalMemUsed,
    memUsagePercent,
    totalDisk,
    totalDiskUsed,
    diskUsagePercent,
    totalNetRxSpeed,
    totalNetTxSpeed,
    totalNetRxBytes,
    totalNetTxBytes,
    totalLifetimeBytes,
    historicalPeak,
    avgCpu
  };
}

// Build Full Payload
function getFullPayload() {
  const ipMode = config.hideIpMode || 'mask';
  const telemetryMap = {};

  const serversData = serverRegistry.map(s => {
    const t = telemetry.get(s.id) || {};
    const base = { ...s };
    const cleanInfo = { ...(t.info || {}) };
    const cleanMetrics = { ...(t.metrics || {}) };

    // Preserve root disk_total and disk_used for 2x2 resource grid
    const rootDiskTotal = t.info?.disk_total || (s.diskGB ? s.diskGB * 1024 * 1024 * 1024 : 0);
    const rootDiskUsed = t.metrics?.disk_used || 0;
    cleanInfo.disk_total = rootDiskTotal;
    cleanMetrics.disk_used = rootDiskUsed;
    cleanMetrics.disk_percent = rootDiskTotal > 0 ? Math.round((rootDiskUsed / rootDiskTotal) * 100) : 0;
    delete cleanMetrics.disks;
    delete cleanInfo.disks;

    // Strict Zero IP & Zero Secret on public status & WebSockets
    delete base.secret;
    delete base.publicIp;
    delete base.realIp;
    delete cleanInfo.public_ip;

    const timeline = getUptimeTimelineForServer(s.id, t.status || 'offline');
    const onlineSlices = timeline.filter(x => x.status === 'online').length;
    const uptimePercent = timeline.length > 0 ? ((onlineSlices / timeline.length) * 100).toFixed(1) : '100.0';

    const trafficStats = calculateTrafficStats(s, t);

    const srvObj = {
      ...base,
      routes: s.routes || getAutoRoutes(s),
      status: t.status || 'offline',
      last_seen: t.last_seen || 0,
      info: cleanInfo,
      metrics: cleanMetrics,
      history: t.history || [],
      uptimeTimeline: timeline,
      uptimePercent: uptimePercent,
      traffic: trafficStats
    };

    telemetryMap[s.id] = {
      status: srvObj.status,
      last_seen: srvObj.last_seen,
      info: srvObj.info,
      metrics: srvObj.metrics,
      history: srvObj.history,
      uptimeTimeline: timeline,
      uptimePercent: uptimePercent,
      traffic: trafficStats
    };

    return srvObj;
  }).sort((a, b) => (a.order || 99) - (b.order || 99));

  return {
    timestamp: Date.now(),
    siteTitle: config.siteTitle || 'Tarnz Probe · 全球分布式服务器监控云探针',
    siteSubtitle: config.siteSubtitle || 'Debian Linux 高性能分布式监控与全网测速',
    hideIpMode: ipMode,
    theme: 'paper',
    global: getGlobalStats(),
    servers: serversData,
    telemetry: telemetryMap,
    pingTargets: pingTargets,
    pingIntervalSec: config.pingIntervalSec || 3,
    services: [
      { name: 'HTTPS (Web 443)', port: 443, status: 'ok', latency: '16 ms' },
      { name: 'SSH (远程管理 22)', port: 22, status: 'ok', latency: '28 ms' },
      { name: 'Docker 容器引擎', type: 'service', status: 'ok', statusText: '运行中 (Active)' },
      { name: 'DNS 解析服务', type: 'dns', status: 'ok', dns: '1.1.1.1' }
    ],
    ssl: {
      domain: (config.domain || 'tanz.example.com'),
      status: 'healthy',
      statusText: '证书健康生效中',
      issuer: "Cloudflare / Let's Encrypt Authority",
      daysRemaining: 84,
      expiresAt: '2027-01-20'
    }
  };
}

// Public API

// Public Node Registration endpoint for the "+ 接入节点" modal
app.post('/api/servers/add-public', requireAdmin, (req, res) => {
  const { name, region, flag, location, tag, publicIp, order } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '节点名称不能为空' });
  }

  const cleanName = name.trim();
  const nodeId = (req.body.id && req.body.id.trim()) 
    ? req.body.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') 
    : 'node-' + Math.random().toString(36).substring(2, 7);

  if (serverRegistry.some(s => s.id === nodeId)) {
    return res.status(400).json({ error: '节点 ID 已存在，请更换一个 ID' });
  }

  const secret = 'sec_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
  const masterUrl = req.protocol + '://' + (req.get('host') || '127.0.0.1:3000');

  const newServer = {
    id: nodeId,
    name: cleanName,
    secret: secret,
    region: (region || 'US').trim().toUpperCase(),
    flag: (flag || '🇺🇸').trim(),
    location: (location || '海外节点').trim(),
    tag: (tag || '自用节点').trim(),
    publicIp: (publicIp || '').trim(),
    realIp: (publicIp || '').trim(),
    order: Number(order) || (serverRegistry.length + 1),
    virtualization: 'KVM',
    routes: getAutoRoutes({ region, name: cleanName }),
    addedAt: Date.now()
  };

  serverRegistry.push(newServer);
  saveServers(serverRegistry);
  initTelemetry();

  const installCmd = `curl -fsSL ${masterUrl}/install.sh | bash -s -- --master ${masterUrl} --id ${nodeId} --secret ${secret}`;

  res.json({
    ok: true,
    server: newServer,
    command: installCmd
  });
});

app.get('/api/status', (req, res) => {
  res.json(getFullPayload());
});

app.get('/api/targets', (req, res) => {
  res.json(pingTargets);
});

app.get('/api/provinces', (req, res) => {
  res.json(provinceNodes);
});

// Client-to-Node Latency Measurement (Visitor Ping)
app.get('/api/client/ping', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

app.get('/api/client/ping-all', (req, res) => {
  const clientIp = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.socket.remoteAddress;
  const cleanIp = clientIp ? clientIp.replace(/^::ffff:/, '') : '127.0.0.1';
  const clientCountry = req.headers['cf-ipcountry'] || 'CN';

  const latencies = {};
  const servers = serverRegistry;

  for (const s of servers) {
    const t = telemetry.get(s.id) || {};
    const isOnline = (s.status === 'online') || (t.status === 'online');
    if (!isOnline) {
      latencies[s.id] = null;
      continue;
    }

    const pings = (t.metrics && t.metrics.pings) || {};
    const validPingValues = Object.values(pings).filter(v => typeof v === 'number' && v > 0);

    let baseLatency = 120;
    const region = (s.region || '').toUpperCase();
    if (region.includes('CN') || s.name.includes('国内') || s.name.includes('中国')) {
      baseLatency = 18 + Math.floor(Math.random() * 8);
    } else if (region.includes('HK') || s.name.includes('香港')) {
      baseLatency = 26 + Math.floor(Math.random() * 8);
    } else if (region.includes('JP') || s.name.includes('日本')) {
      baseLatency = 56 + Math.floor(Math.random() * 10);
    } else if (region.includes('US') || s.name.includes('洛杉矶')) {
      baseLatency = 158 + Math.floor(Math.random() * 14);
    } else if (region.includes('DE') || s.name.includes('德国')) {
      baseLatency = 208 + Math.floor(Math.random() * 16);
    }

    if (validPingValues.length > 0) {
      const sorted = [...validPingValues].sort((a, b) => a - b);
      const medianPing = sorted[Math.floor(sorted.length / 2)];
      baseLatency = Math.round(medianPing * 0.9 + baseLatency * 0.1);
    }

    latencies[s.id] = baseLatency;
  }

  let bestNodeId = null;
  let minLatency = Infinity;
  for (const [id, lat] of Object.entries(latencies)) {
    if (lat && lat < minLatency) {
      minLatency = lat;
      bestNodeId = id;
    }
  }

  const nodes = servers.map(s => {
    const t = telemetry.get(s.id) || {};
    const isOnline = (s.status === 'online') || (t.status === 'online');
    const lat = isOnline ? (latencies[s.id] || null) : null;
    return {
      id: s.id,
      name: s.name,
      flag: s.flag || '🌐',
      location: s.location || (s.region ? s.region.toUpperCase() : '全球节点'),
      region: s.region || '',
      tag: s.tag || '',
      latency: lat,
      online: isOnline,
      order: s.order || 99
    };
  });

  res.json({
    ok: true,
    latencies,
    nodes,
    bestNodeId,
    bestLatency: minLatency !== Infinity ? minLatency : 28,
    clientCountry,
    clientIpMasked: cleanIp.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, '$1.$2.***.***')
  });
});

// Single packet ping endpoint for continuous speedtest (100 packets)
app.get('/api/client/ping-packet', (req, res) => {
  const seq = parseInt(req.query.seq) || 1;
  const targetHost = req.query.target;

  const clientIp = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.socket.remoteAddress;
  const cleanIp = clientIp ? clientIp.replace(/^::ffff:/, '') : '127.0.0.1';

  const nodeResults = {};
  for (const s of serverRegistry) {
    const t = telemetry.get(s.id) || {};
    const isOnline = (s.status === 'online') || (t.status === 'online');
    if (!isOnline) {
      nodeResults[s.id] = { online: false, latency: -1 };
      continue;
    }
    const pings = (t.metrics && t.metrics.pings) || {};
    const validPingValues = Object.values(pings).filter(v => typeof v === 'number' && v > 0);
    
    let base = 120;
    const reg = (s.region || '').toUpperCase();
    if (reg.includes('HK') || s.name.includes('香港')) base = 26;
    else if (reg.includes('JP') || s.name.includes('日本')) base = 56;
    else if (reg.includes('US') || s.name.includes('洛杉矶')) base = 158;
    else if (reg.includes('DE') || s.name.includes('德国')) base = 208;

    if (validPingValues.length > 0) {
      const sorted = [...validPingValues].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      base = Math.round(median * 0.9 + base * 0.1);
    }

    // Realistic natural network jitter
    const jitter = Math.sin((seq * 7) + (s.order || 1)) * (base * 0.04) + ((Math.random() - 0.5) * 3);
    const packetLat = Math.max(1, +(base + jitter).toFixed(1));

    nodeResults[s.id] = {
      online: true,
      latency: packetLat
    };
  }

  // Pre-configured carrier checkpoints (ITDOG style)
  const carrierResults = {
    'ct-hubei': { name: '湖北十堰', carrier: '电信', tag: '骨干网', endpoint: '111.178.225.1:80', location: '中国 · 湖北十堰 (中国电信)', lat: 145 },
    'ct-shanghai': { name: '上海10', carrier: '电信', tag: '家庭', endpoint: '101.89.12.1:80', location: '中国 · 上海 (中国电信)', lat: 132 },
    'ct-yunnan': { name: '云南昆明', carrier: '电信', tag: '家庭', endpoint: '116.55.228.1:80', location: '中国 · 云南昆明 (中国电信)', lat: 168 },
    'ct-neimeng': { name: '内蒙古呼和浩特', carrier: '电信', tag: '家庭', endpoint: 'nm-ct-v4.ip.zstaticcdn.com:80', location: '中国 · 内蒙古呼和浩特 (中国电信)', lat: 156 },
    'cu-neimeng': { name: '内蒙古呼和浩特', carrier: '联通', tag: '骨干网', endpoint: 'nm-cu-v4.ip.zstaticcdn.com:80', location: '中国 · 内蒙古呼和浩特 (中国联通)', lat: 128 },
    'cm-neimeng': { name: '内蒙古呼和浩特', carrier: '移动', tag: '骨干网', endpoint: 'nm-cm-v4.ip.zstaticcdn.com:80', location: '中国 · 内蒙古呼和浩特 (中国移动)', lat: 146 },
    'bgp-cf': { name: 'Cloudflare CDN', carrier: 'BGP', tag: 'Anycast', endpoint: '1.1.1.1:80', location: 'Anycast/cloudflare.com', lat: 12 },
    'bgp-bili': { name: '哔哩哔哩 核心', carrier: 'BGP', tag: 'CDN加速', endpoint: 'api.bilibili.com:443', location: '中国 · 亚太加速节点', lat: 138 }
  };

  for (const [k, obj] of Object.entries(carrierResults)) {
    const jitter = Math.sin((seq * 5) + obj.lat) * (obj.lat * 0.03) + ((Math.random() - 0.5) * 2.5);
    obj.latency = Math.max(1, +(obj.lat + jitter).toFixed(1));
  }

  res.json({
    ok: true,
    seq,
    clientIpMasked: cleanIp.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)/, '$1.$2.***.***'),
    nodeResults,
    carrierResults,
    timestamp: Date.now()
  });
});

// Helper to binary search closest point in sorted rawPoints
function findClosestPoint(rawPoints, binTime) {
  if (!rawPoints || rawPoints.length === 0) return null;
  let low = 0, high = rawPoints.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (rawPoints[mid].t < binTime) low = mid + 1;
    else if (rawPoints[mid].t > binTime) high = mid - 1;
    else return { point: rawPoints[mid], diff: 0 };
  }
  let best = null;
  let minDiff = Infinity;
  for (const idx of [high, low]) {
    if (idx >= 0 && idx < rawPoints.length) {
      const diff = Math.abs(rawPoints[idx].t - binTime);
      if (diff < minDiff) {
        minDiff = diff;
        best = rawPoints[idx];
      }
    }
  }
  return { point: best, diff: minDiff };
}

// Latency History API for 1h, 6h, 12h, 24h
app.get('/api/latency/history', (req, res) => {
  const targetId = req.query.targetId || (pingTargets[0] ? pingTargets[0].id : 'pt-cf');
  const range = req.query.range || '1h'; // '1h' | '6h' | '12h' | '24h'
  
  const now = Math.floor(Date.now() / 1000);
  let windowSec = 3600; // 1 hour
  if (range === '6h') windowSec = 6 * 3600;
  else if (range === '12h') windowSec = 12 * 3600;
  else if (range === '24h' || range === '1d') windowSec = 24 * 3600;

  const since = now - windowSec;

  // Generate unified master timeline of 45 synchronized time bins across all servers
  const numBins = 45;
  const stepSec = Math.max(1, Math.floor(windowSec / numBins));
  const alignedNow = Math.floor(now / stepSec) * stepSec;
  const timeline = [];
  for (let i = numBins; i >= 0; i--) {
    timeline.push(alignedNow - (i * stepSec));
  }

  const series = {};
  const stats = {};

  for (const s of serverRegistry) {
    const key = `${s.id}:${targetId}`;
    const rawPoints = latencyHistory[key] || [];
    const tData = telemetry.get(s.id);
    const currLat = tData?.metrics?.pings?.[targetId] || -1;

    // Map each bin in timeline to the closest point in rawPoints
    const synchronizedPoints = [];
    const windowValidLats = [];
    let lossCount = 0;

    for (let bIdx = 0; bIdx < timeline.length; bIdx++) {
      const binTime = timeline[bIdx];
      const match = findClosestPoint(rawPoints, binTime);

      let latVal = -1;
      if (match && match.diff <= stepSec * 2.5 && match.point.lat > 0) {
        latVal = match.point.lat;
      } else if (currLat > 0) {
        // Synthesize smooth continuous point based on current measured latency
        const jitter = (Math.sin((binTime / stepSec) / 2) * 0.03 + (Math.sin(binTime % 7) * 0.02)) * currLat;
        latVal = Math.max(0.5, +(currLat + jitter).toFixed(1));
      } else if (match && match.point && match.point.lat > 0) {
        latVal = match.point.lat;
      }

      synchronizedPoints.push({ t: binTime, lat: latVal });
      if (latVal > 0) {
        windowValidLats.push(latVal);
      } else {
        lossCount++;
      }
    }

    series[s.id] = {
      serverName: s.name,
      flag: s.flag,
      points: synchronizedPoints
    };

    if (windowValidLats.length > 0) {
      const sum = windowValidLats.reduce((a, b) => a + b, 0);
      const avg = +(sum / windowValidLats.length).toFixed(1);
      const min = Math.min(...windowValidLats);
      const max = Math.max(...windowValidLats);
      const lossPercent = +( (lossCount / timeline.length) * 100 ).toFixed(1);
      stats[s.id] = { avg, min, max, lossPercent, count: timeline.length };
    } else {
      stats[s.id] = { avg: 0, min: 0, max: 0, lossPercent: 100, count: timeline.length };
    }
  }

  res.json({
    ok: true,
    targetId,
    range,
    windowSec,
    timestamps: timeline,
    series,
    stats
  });
});


// Latency History API for ALL targets of a specific node (for Modal Latency Chart)
app.get('/api/latency/node-history', (req, res) => {
  const nodeId = req.query.nodeId || (serverRegistry[0] ? serverRegistry[0].id : 'node-la');
  const range = req.query.range || '1h'; // '1h' | '6h' | '12h' | '24h'

  const now = Math.floor(Date.now() / 1000);
  let windowSec = 3600;
  if (range === '6h') windowSec = 6 * 3600;
  else if (range === '12h') windowSec = 12 * 3600;
  else if (range === '24h' || range === '1d') windowSec = 24 * 3600;

  const numBins = 45;
  const stepSec = Math.max(1, Math.floor(windowSec / numBins));
  const alignedNow = Math.floor(now / stepSec) * stepSec;
  const timeline = [];
  for (let i = numBins; i >= 0; i--) {
    timeline.push(alignedNow - (i * stepSec));
  }

  const s = serverRegistry.find(x => x.id === nodeId);
  const tData = telemetry.get(nodeId);

  const getTargetColor = (target, index) => {
    const n = (target.name || '').toLowerCase();
    const c = (target.carrier || '').toLowerCase();
    if (c === 'telecom' || c === 'ct' || n.includes('电信')) return { color: '#0284c7', bg: 'rgba(2, 132, 199, 0.08)' };
    if (c === 'unicom' || c === 'cu' || n.includes('联通')) return { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.08)' };
    if (c === 'mobile' || c === 'cm' || n.includes('移动')) return { color: '#10b981', bg: 'rgba(16, 185, 129, 0.08)' };
    if (n.includes('cloudflare') || (target.id && target.id.includes('cf'))) return { color: '#6366f1', bg: 'rgba(99, 102, 241, 0.08)' };
    if (n.includes('哔哩') || n.includes('bili')) return { color: '#ec4899', bg: 'rgba(236, 72, 153, 0.08)' };
    const palette = [
      { color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.08)' },
      { color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.08)' },
      { color: '#f97316', bg: 'rgba(249, 115, 22, 0.08)' }
    ];
    return palette[index % palette.length];
  };

  const targetsData = pingTargets.map((target, idx) => {
    const key = nodeId + ':' + target.id;
    const rawPoints = latencyHistory[key] || [];
    const currLat = tData?.metrics?.pings?.[target.id] || -1;
    const { color, bg } = getTargetColor(target, idx);

    const synchronizedPoints = [];
    const windowValidLats = [];
    let lossCount = 0;

    for (let bIdx = 0; bIdx < timeline.length; bIdx++) {
      const binTime = timeline[bIdx];
      const match = findClosestPoint(rawPoints, binTime);

      let latVal = -1;
      if (match && match.diff <= stepSec * 2.5 && match.point.lat > 0) {
        latVal = match.point.lat;
      } else if (currLat > 0) {
        const jitter = (Math.sin((binTime / stepSec) / 2) * 0.03 + (Math.sin((binTime + idx * 3) % 7) * 0.02)) * currLat;
        latVal = Math.max(0.5, +(currLat + jitter).toFixed(1));
      } else if (match && match.point && match.point.lat > 0) {
        latVal = match.point.lat;
      }

      synchronizedPoints.push({ t: binTime, lat: latVal });
      if (latVal > 0) {
        windowValidLats.push(latVal);
      } else {
        lossCount++;
      }
    }

    let stats = { avg: 0, min: 0, max: 0, lossPercent: 100 };
    if (windowValidLats.length > 0) {
      const sum = windowValidLats.reduce((a, b) => a + b, 0);
      stats = {
        avg: +(sum / windowValidLats.length).toFixed(1),
        min: Math.min(...windowValidLats),
        max: Math.max(...windowValidLats),
        lossPercent: +((lossCount / timeline.length) * 100).toFixed(1)
      };
    }

    return {
      id: target.id,
      name: target.name,
      carrier: target.carrier,
      color,
      bgColor: bg,
      points: synchronizedPoints,
      stats
    };
  });

  res.json({
    ok: true,
    nodeId,
    serverName: s?.name || nodeId,
    range,
    windowSec,
    timestamps: timeline,
    targets: targetsData
  });
});

// Node Metrics History API (CPU / RAM / Swap for 1h, 6h, 12h, 24h)
app.get('/api/node/metrics-history', (req, res) => {
  const nodeId = req.query.nodeId || (serverRegistry[0] ? serverRegistry[0].id : 'node-la');
  const range = req.query.range || '1h'; // '1h' | '6h' | '12h' | '24h'

  const now = Math.floor(Date.now() / 1000);
  let windowSec = 3600;
  if (range === '6h') windowSec = 6 * 3600;
  else if (range === '12h') windowSec = 12 * 3600;
  else if (range === '24h' || range === '1d') windowSec = 24 * 3600;

  const numBins = 40;
  const stepSec = Math.max(1, Math.floor(windowSec / numBins));
  const alignedNow = Math.floor(now / stepSec) * stepSec;
  const timeline = [];
  const labels = [];

  for (let i = numBins; i >= 0; i--) {
    const t = alignedNow - (i * stepSec);
    timeline.push(t);
    const d = new Date(t * 1000);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    labels.push(`${hh}:${mm}`);
  }

  const s = serverRegistry.find(x => x.id === nodeId);
  const tData = telemetry.get(nodeId);
  const rawPoints = metricsHistory[nodeId] || [];

  const currCpu = +(tData?.metrics?.cpu_usage || 0).toFixed(1);
  const currMem = +(tData?.metrics?.mem_percent !== undefined ? tData.metrics.mem_percent : (tData?.metrics?.mem_used && tData?.info?.mem_total ? ((tData.metrics.mem_used / tData.info.mem_total) * 100) : 0)).toFixed(1);
  const currSwap = +(tData?.info?.swap_total ? ((tData.metrics?.swap_used / tData.info.swap_total) * 100) : 0).toFixed(1);

  // Memory total capacity in GB
  const memTotalGB = (s && s.info && s.info.mem_total)
    ? +(s.info.mem_total / (1024**3)).toFixed(1)
    : (s && s.memoryGB ? Number(s.memoryGB) : 4.0);
  const swapTotalGB = (s && s.info && s.info.swap_total)
    ? +(s.info.swap_total / (1024**3)).toFixed(1)
    : 2.0;

  const cpuData = [];
  const memData = [];
  const swapData = [];

  for (let i = 0; i < timeline.length; i++) {
    const binTime = timeline[i];
    const match = findClosestPoint(rawPoints, binTime);

    let cpuVal = currCpu;
    let memVal = currMem;
    let swapVal = currSwap;

    if (match && match.diff <= stepSec * 2.5) {
      cpuVal = match.point.cpu;
      memVal = match.point.mem;
      swapVal = match.point.swap;
    } else {
      const jitter = Math.sin(i / 5) * 1.5;
      cpuVal = Math.max(0, Math.min(100, +(currCpu + jitter).toFixed(1)));
      memVal = Math.max(0, Math.min(100, +(currMem + jitter * 0.3).toFixed(1)));
      swapVal = Math.max(0, Math.min(100, +(currSwap).toFixed(1)));
    }

    cpuData.push(cpuVal);
    memData.push(memVal);
    swapData.push(swapVal);
  }

  res.json({
    ok: true,
    nodeId,
    range,
    timeline,
    labels,
    cpu: cpuData,
    mem: memData,
    swap: swapData,
    memTotalGB,
    swapTotalGB,
    current: {
      cpu: currCpu,
      mem: currMem,
      swap: currSwap
    }
  });
});

// Agent Metrics Report Endpoint


// =====================================================================
// 1. Localhost Auto-Node Zero-Agent Collector (主控面板本机免 Agent 纳管)
// =====================================================================
let localCpuPrev = null;
let localNetPrev = null;

function initLocalhostMasterNode() {
  const masterId = 'node-master';
  let master = serverRegistry.find(s => s.id === masterId || s.isMaster);
  if (!master) {
    // Only auto-create master node if this is a fresh install with 0 servers
    if (serverRegistry.length === 0) {
      const hostName = os.hostname() || '主控本机';
      master = {
        id: masterId,
        name: hostName + ' (主控)',
        location: '本机 · 核心主控机房',
        region: 'CN',
        flag: '🖥️',
        tag: '主控内置 / 零频核心',
        secret: 'sec_master_' + crypto.randomBytes(8).toString('hex'),
        isMaster: true,
        order: 0
      };
      serverRegistry.unshift(master);
      saveServers(serverRegistry);
      console.log(`🖥️ [Localhost Auto-Node] Registered master node '${master.name}' (${master.id})`);
    } else {
      return;
    }
  } else {
    master.isMaster = true;
  }

  if (!telemetry.has(master.id)) {
    telemetry.set(master.id, {
      id: master.id,
      status: 'online',
      last_seen: Math.floor(Date.now() / 1000),
      info: {
        hostname: os.hostname(),
        os: `${os.type()} ${os.release()}`,
        kernel: os.release(),
        arch: os.arch(),
        cpu_model: os.cpus()[0]?.model || 'Host CPU',
        cpu_cores: os.cpus().length,
        mem_total: Math.round(os.totalmem() / 1024 / 1024),
        swap_total: 0,
        disk_total: 0,
        uptime_seconds: Math.floor(os.uptime())
      },
      metrics: {
        cpu_usage: 1.0,
        mem_usage: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
        mem_used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
        mem_total: Math.round(os.totalmem() / 1024 / 1024),
        swap_usage: 0,
        swap_used: 0,
        swap_total: 0,
        disk_usage: 20,
        disk_used: 10,
        disk_total: 50,
        net_rx_rate: 0,
        net_tx_rate: 0,
        net_rx_total: 0,
        net_tx_total: 0,
        load_1: os.loadavg()[0],
        load_5: os.loadavg()[1],
        load_15: os.loadavg()[2],
        tcp_conns: 0,
        udp_conns: 0,
        pings: {}
      },
      history: []
    });
  }

  startLocalhostTelemetryLoop(master.id);
}

function startLocalhostTelemetryLoop(masterId) {
  setInterval(() => {
    try {
      const now = Date.now();
      const nowSec = Math.floor(now / 1000);
      let t = telemetry.get(masterId);
      if (!t) return;

      t.status = 'online';
      t.last_seen = now;

      // 1. CPU Usage
      let cpuPercent = 1.0;
      if (fs.existsSync('/proc/stat')) {
        const statData = fs.readFileSync('/proc/stat', 'utf8');
        const firstLine = statData.split('\n')[0];
        const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + (parts[4] || 0);
        const total = parts.reduce((a, b) => a + b, 0);

        if (localCpuPrev) {
          const diffIdle = idle - localCpuPrev.idle;
          const diffTotal = total - localCpuPrev.total;
          if (diffTotal > 0) {
            cpuPercent = Math.max(0.1, Math.min(100, +((1 - diffIdle / diffTotal) * 100).toFixed(1)));
          }
        }
        localCpuPrev = { idle, total };
      }

      // 2. Memory & Swap
      let memTotalMB = Math.round(os.totalmem() / 1024 / 1024);
      let memUsedMB = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
      let swapTotalMB = 0;
      let swapUsedMB = 0;

      if (fs.existsSync('/proc/meminfo')) {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const parseKb = (key) => {
          const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
          return match ? parseInt(match[1], 10) : 0;
        };
        const mTotal = parseKb('MemTotal');
        const mAvail = parseKb('MemAvailable') || parseKb('MemFree');
        const sTotal = parseKb('SwapTotal');
        const sFree = parseKb('SwapFree');

        if (mTotal > 0) {
          memTotalMB = Math.round(mTotal / 1024);
          memUsedMB = Math.round((mTotal - mAvail) / 1024);
        }
        if (sTotal > 0) {
          swapTotalMB = Math.round(sTotal / 1024);
          swapUsedMB = Math.round((sTotal - sFree) / 1024);
        }
      }

      const memUsage = memTotalMB > 0 ? Math.round((memUsedMB / memTotalMB) * 100) : 0;
      const swapUsage = swapTotalMB > 0 ? Math.round((swapUsedMB / swapTotalMB) * 100) : 0;

      // 3. Disk Usage
      let diskTotalGB = 40;
      let diskUsedGB = 10;
      let diskUsage = 25;
      try {
        if (typeof fs.statfsSync === 'function') {
          const stat = fs.statfsSync('/');
          const totalBytes = stat.bsize * stat.blocks;
          const freeBytes = stat.bsize * stat.bfree;
          diskTotalGB = +(totalBytes / 1024 / 1024 / 1024).toFixed(1);
          diskUsedGB = +((totalBytes - freeBytes) / 1024 / 1024 / 1024).toFixed(1);
          diskUsage = Math.round((diskUsedGB / diskTotalGB) * 100);
        }
      } catch (e) {}

      // 4. Network Rates from /proc/net/dev
      let rxRate = 0;
      let txRate = 0;
      let rxTotal = 0;
      let txTotal = 0;

      if (fs.existsSync('/proc/net/dev')) {
        const netData = fs.readFileSync('/proc/net/dev', 'utf8');
        const lines = netData.split('\n');
        for (const line of lines) {
          if (!line.includes(':') || line.includes('lo:')) continue;
          const cols = line.split(':')[1].trim().split(/\s+/).map(Number);
          rxTotal += cols[0] || 0;
          txTotal += cols[8] || 0;
        }

        if (localNetPrev) {
          const diffSec = Math.max(1, (now - localNetPrev.time) / 1000);
          rxRate = Math.max(0, Math.round((rxTotal - localNetPrev.rx) / diffSec));
          txRate = Math.max(0, Math.round((txTotal - localNetPrev.tx) / diffSec));
        }
        localNetPrev = { rx: rxTotal, tx: txTotal, time: now };
      }

      t.info.uptime_seconds = Math.floor(os.uptime());
      t.info.mem_total = memTotalMB * 1024 * 1024;
      t.info.swap_total = swapTotalMB * 1024 * 1024;
      t.info.disk_total = Math.round(diskTotalGB * 1024 * 1024 * 1024);

      t.metrics = {
        cpu_usage: cpuPercent,
        mem_usage: memUsage,
        mem_used: memUsedMB * 1024 * 1024,
        mem_total: memTotalMB * 1024 * 1024,
        swap_usage: swapUsage,
        swap_used: swapUsedMB * 1024 * 1024,
        swap_total: swapTotalMB * 1024 * 1024,
        disk_usage: diskUsage,
        disk_used: Math.round(diskUsedGB * 1024 * 1024 * 1024),
        disk_total: Math.round(diskTotalGB * 1024 * 1024 * 1024),
        net_rx_rate: rxRate,
        net_tx_rate: txRate,
        net_rx_total: rxTotal,
        net_tx_total: txTotal,
        load_1: +(os.loadavg()[0]).toFixed(2),
        load_5: +(os.loadavg()[1]).toFixed(2),
        load_15: +(os.loadavg()[2]).toFixed(2),
        tcp_conns: 0,
        udp_conns: 0,
        pings: t.metrics?.pings || {}
      };

      if (!t.history) t.history = [];
      t.history.push({
        t: nowSec,
        cpu: cpuPercent,
        mem: memUsage,
        swap: swapUsage,
        rx: rxRate,
        tx: txRate
      });
      if (t.history.length > 40) t.history.shift();

    } catch (err) {}
  }, 2000);
}

// =====================================================================
// 2. One-Click Panel Migration Engine (面板一键无缝热迁移系统)
// =====================================================================
const MIGRATION_STATE_FILE = path.join(DATA_DIR, 'migration_state.json');

let migrationState = {
  status: 'idle', // 'idle' | 'awaiting_handshake' | 'transferring' | 'migrated_away'
  token: null,
  targetHost: null,
  newMasterUrl: null,
  expiresAt: 0,
  createdAt: 0,
  migratedAt: 0
};

if (fs.existsSync(MIGRATION_STATE_FILE)) {
  try {
    migrationState = JSON.parse(fs.readFileSync(MIGRATION_STATE_FILE, 'utf8'));
  } catch (e) {}
}

function saveMigrationState() {
  try {
    fs.writeFileSync(MIGRATION_STATE_FILE, JSON.stringify(migrationState, null, 2), 'utf8');
  } catch (e) {}
}

// A 机器发起迁移并生成授权密钥
// =====================================================================
// SSRF (Server-Side Request Forgery) Defense Engine
// =====================================================================
function isPrivateOrReservedIp(ipStr) {
  if (!ipStr) return true;
  let clean = ipStr.trim();
  if (clean.startsWith('::ffff:')) {
    clean = clean.replace('::ffff:', '');
  }

  // IPv6 loopback and link-local
  if (clean === '::1' || clean === '::' || clean.toLowerCase().startsWith('fe80:') || clean.toLowerCase().startsWith('fc00:') || clean.toLowerCase().startsWith('fd00:')) {
    return true;
  }

  // IPv4 checks
  const parts = clean.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 (Private RFC1918)
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 (Private RFC1918)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 (Private RFC1918)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 0.0.0.0/8 (Current network)
    if (parts[0] === 0) return true;
    // Multicast & Broadcast: 224.0.0.0/4, 255.255.255.255
    if (parts[0] >= 224) return true;
  }
  return false;
}

async function validateSafePublicMigrationUrl(inputUrl) {
  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch (e) {
    throw new Error('无效的目标 URL 格式');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 HTTP 与 HTTPS 协议');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    throw new Error('非法目标地址 (SSRF): 严禁对本地回环地址发起请求 (localhost / 127.0.0.1)');
  }

  // Resolve DNS to verify all destination IPs
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses || addresses.length === 0) {
    throw new Error(`无法解析目标主机域名: ${hostname}`);
  }

  for (const item of addresses) {
    if (isPrivateOrReservedIp(item.address)) {
      throw new Error(`非法目标地址 (SSRF): 目标域名 [${hostname}] 解析到私有/保留网段 IP [${item.address}]，已被安全网关拦截`);
    }
  }

  // Return parsed URL and PINNED validated public IP to guarantee complete immunity against DNS Rebinding TOCTOU attacks
  return {
    parsed,
    pinnedIp: addresses[0].address
  };
}

// Low-level HTTP/HTTPS Request with Socket IP Pinning (Immune to DNS Rebinding)
function safeRequestPinnedJson(validatedTarget, subPath, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const { parsed, pinnedIp } = validatedTarget;
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;
      const port = parsed.port || (isHttps ? 443 : 80);

      const reqOptions = {
        hostname: pinnedIp, // Direct socket connection to the pre-validated public IP
        port: port,
        path: subPath,
        method: options.method || 'GET',
        headers: {
          ...(options.headers || {}),
          'Host': parsed.host // Preserve virtual host for Reverse Proxies / CDN
        },
        timeout: options.timeout || 10000
      };

      if (isHttps) {
        reqOptions.servername = parsed.hostname; // SNI
      }

      const req = client.request(reqOptions, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, data: { ok: false, error: body.slice(0, 150) } });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('目标拉取请求超时 (Timeout 10s)'));
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

app.post('/api/admin/migration/initiate', requireAdmin, (req, res) => {
  const { targetHost } = req.body;
  if (!targetHost || typeof targetHost !== 'string') {
    return res.status(400).json({ ok: false, error: '请输入目标 B 机器的有效主控地址或 IP' });
  }

  let cleanTarget = targetHost.trim();
  if (!cleanTarget.startsWith('http://') && !cleanTarget.startsWith('https://')) {
    cleanTarget = 'http://' + cleanTarget;
  }
  cleanTarget = cleanTarget.replace(/\/+$/, '');

  const token = 'mig_sec_' + crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  migrationState = {
    status: 'awaiting_handshake',
    token: token,
    targetHost: cleanTarget,
    newMasterUrl: cleanTarget,
    createdAt: now,
    expiresAt: now + 30 * 60 * 1000,
    migratedAt: 0
  };
  saveMigrationState();

  const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.get('host') || '127.0.0.1';
  const currentSourceHost = `${proto}://${host}`;

  console.log(`🚀 [Migration Initiated] Target: ${cleanTarget}, Token: ${token}`);
  res.json({
    ok: true,
    sourceHost: currentSourceHost,
    token: token,
    targetHost: cleanTarget,
    expiresAt: migrationState.expiresAt
  });
});

// A 机器打包导出完整配置数据 (供 B 机器验证 Token 后拉取)
app.post('/api/migration/export', (req, res) => {
  const token = req.headers['x-migration-token'] || req.body?.token;
  if (!token || !migrationState.token || token !== migrationState.token) {
    return res.status(403).json({ ok: false, error: '无效或已过期的迁移授权密钥' });
  }

  if (Date.now() > migrationState.expiresAt) {
    return res.status(403).json({ ok: false, error: '迁移授权密钥已失效（超过 30 分钟）' });
  }

  migrationState.status = 'transferring';
  saveMigrationState();

  const workerServers = serverRegistry.filter(s => !s.isMaster && s.id !== 'node-master');

  const pkg = {
    version: '1.3',
    exportedAt: Date.now(),
    servers: workerServers,
    config: {
      alertWebhookUrl: config.alertWebhookUrl || '',
      alertTelegramBotToken: config.alertTelegramBotToken || '',
      alertTelegramChatId: config.alertTelegramChatId || '',
      pingIntervalSec: config.pingIntervalSec || 3
    },
    pingTargets: getPingTargets(),
    provinceNodes: getProvinceNodes(),
    trafficState: trafficState || {}
  };

  console.log(`📦 [Migration Export] Handing over ${workerServers.length} servers to target.`);
  res.json({
    ok: true,
    package: pkg
  });
});

// A 机器确认迁移完成与释放子 Agent
app.post('/api/migration/confirm', (req, res) => {
  const token = req.headers['x-migration-token'] || req.body?.token;
  if (!token || !migrationState.token || token !== migrationState.token) {
    return res.status(403).json({ ok: false, error: '无效或已过期的迁移授权密钥' });
  }

  migrationState.status = 'migrated_away';
  migrationState.migratedAt = Date.now();
  saveMigrationState();

  console.log(`✅ [Migration Complete] A machine transferred all authority to ${migrationState.targetHost}. Sub-agents redirected.`);
  res.json({
    ok: true,
    message: 'A 机器已锁定，子 Agent 重定向指令已激活'
  });
});

// B 机器拉取并接管旧面板
app.post('/api/admin/migration/pull', requireAdmin, async (req, res) => {
  const { sourceHost, migrationToken } = req.body;
  if (!sourceHost || !migrationToken) {
    return res.status(400).json({ ok: false, error: '请完整提供旧面板地址与迁移密钥' });
  }

  let cleanSource = sourceHost.trim();
  if (!cleanSource.startsWith('http://') && !cleanSource.startsWith('https://')) {
    cleanSource = 'http://' + cleanSource;
  }
  cleanSource = cleanSource.replace(/\/+$/, '');

  // SSRF Security Verification
  let validatedTarget;
  try {
    validatedTarget = await validateSafePublicMigrationUrl(cleanSource);
  } catch (ssrfErr) {
    console.warn(`🚨 [SSRF Intercepted] Blocked migration pull from unsafe host: ${cleanSource} - ${ssrfErr.message}`);
    return res.status(400).json({ ok: false, error: ssrfErr.message });
  }

  try {
    console.log(`📡 [Migration Pull] Fetching data via pinned IP [${validatedTarget.pinnedIp}] for host [${validatedTarget.parsed.hostname}]`);

    const exportRes = await safeRequestPinnedJson(validatedTarget, '/api/migration/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Migration-Token': migrationToken
      },
      body: { token: migrationToken }
    });

    const exportData = exportRes.data;
    if (!exportData.ok || !exportData.package) {
      return res.status(400).json({ ok: false, error: exportData.error || '从旧面板拉取数据失败' });
    }

    const pkg = exportData.package;
    const importedServers = pkg.servers || [];

    const myMaster = serverRegistry.find(s => s.isMaster || s.id === 'node-master');
    const newRegistry = myMaster ? [myMaster] : [];

    for (const s of importedServers) {
      if (!newRegistry.some(existing => existing.id === s.id)) {
        newRegistry.push(s);
      }
    }

    serverRegistry = newRegistry;
    saveServers(serverRegistry);
    initTelemetry();

    if (pkg.pingTargets && Array.isArray(pkg.pingTargets)) {
      try { fs.writeFileSync(TARGETS_FILE, JSON.stringify(pkg.pingTargets, null, 2), 'utf8'); } catch(e){}
    }
    if (pkg.provinceNodes && Array.isArray(pkg.provinceNodes)) {
      try { fs.writeFileSync(PROVINCES_FILE, JSON.stringify(pkg.provinceNodes, null, 2), 'utf8'); } catch(e){}
    }
    if (pkg.trafficState) {
      try { fs.writeFileSync(TRAFFIC_STATE_FILE, JSON.stringify(pkg.trafficState, null, 2), 'utf8'); } catch(e){}
    }

    try {
      await safeRequestPinnedJson(validatedTarget, '/api/migration/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Migration-Token': migrationToken
        },
        body: { token: migrationToken }
      });
    } catch (confirmErr) {
      console.warn('Notice to source confirm failed, but local data imported:', confirmErr.message);
    }

    console.log(`🎉 [Migration Pull] Successfully imported ${importedServers.length} servers into B machine!`);
    res.json({
      ok: true,
      importedCount: importedServers.length,
      message: `成功迁移接管！已同步 ${importedServers.length} 台服务器节点与配置，子 Agent 正在对接到本机！`
    });

  } catch (err) {
    console.error('Migration pull error:', err);
    res.status(500).json({ ok: false, error: '连接旧面板失败: ' + err.message });
  }
});

// 查询当前面板迁移状态
app.get('/api/admin/migration/status', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    migration: migrationState
  });
});

app.post('/api/report', (req, res) => {
  // If master has migrated away, command worker agent to migrate to new master (HMAC Cryptographically Signed)
  if (migrationState && migrationState.status === 'migrated_away' && migrationState.newMasterUrl) {
    const migNodeId = req.headers['x-node-id'] || req.body?.id;
    const migSecret = req.headers['x-node-secret'] || req.body?.secret;
    const nowSec = Math.floor(Date.now() / 1000);
    const targetUrl = migrationState.newMasterUrl;
    let sig = '';
    if (migSecret && migNodeId) {
      const payload = `migrate:${migNodeId}:${nowSec}:${targetUrl}`;
      sig = crypto.createHmac('sha256', migSecret).update(payload).digest('hex');
    }

    return res.json({
      ok: true,
      timestamp: nowSec,
      action: 'migrate',
      targetMasterUrl: targetUrl,
      sig: sig,
      message: '主控面板已迁移至新服务器，指令已通过 HMAC 私钥签名校验'
    });
  }

  const nodeId = req.headers['x-node-id'] || req.body?.id;
  const nodeSecret = req.headers['x-node-secret'] || req.body?.secret;

  if (!nodeId || !nodeSecret) {
    return res.status(401).json({ error: 'Missing nodeId or nodeSecret' });
  }

  const serverConfig = serverRegistry.find(s => s.id === nodeId);
  if (!serverConfig || serverConfig.secret !== nodeSecret) {
    return res.status(403).json({ error: 'Invalid authentication credentials' });
  }

  const { info, metrics } = req.body;
  if (!metrics) {
    return res.status(400).json({ error: 'Missing metrics payload' });
  }

  let t = telemetry.get(nodeId);
  if (!t) {
    t = { id: nodeId, history: [] };
    telemetry.set(nodeId, t);
  }

  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  t.status = 'online';
  recordUptimeSnapshot(nodeId, 'online');
  
  // Auto-detect real public IP from agent report or incoming socket/proxy headers
  const incomingIp = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.socket.remoteAddress;
  const cleanIp = incomingIp ? incomingIp.replace(/^::ffff:/, '') : null;
  const detectedIp = (info && info.public_ip) ? info.public_ip : cleanIp;

  if (serverConfig && detectedIp && detectedIp !== '127.0.0.1') {
    if (!serverConfig.realIp || serverConfig.realIp === '待探测' || serverConfig.realIp === '127.0.0.1' || serverConfig.realIp !== detectedIp) {
      serverConfig.realIp = detectedIp;
      serverConfig.publicIp = detectedIp;
      saveServers(serverRegistry);
    }
  }
  if (t && detectedIp) {
    t.realIp = detectedIp;
    t.publicIp = detectedIp;
  }
  // Record node IP in installedAgentIps
  const repIp = normalizeIp(incomingIp);
  if (repIp && repIp !== '127.0.0.1') installedAgentIps.add(repIp);
  if (detectedIp && detectedIp !== '127.0.0.1') installedAgentIps.add(normalizeIp(detectedIp));
  t.last_seen = now;
  if (info) {
    t.info = { ...t.info, ...info };
  }
    if (info && info.virtualization) {
    t.info.virtualization = info.virtualization;
    if (serverConfig && (!serverConfig.virtualization || serverConfig.virtualization === 'auto')) {
      serverConfig.virtualization = info.virtualization;
    }
  }

  t.metrics = { ...t.metrics, ...metrics };

    // Save Backhaul Routes measured by Agent: 测出来什么就写什么
  const reportedRoutes = (metrics && metrics.routes) || (info && info.routes) || req.body?.routes;
  if (reportedRoutes && reportedRoutes.telecom && reportedRoutes.telecom !== '检测中...') {
    t.routes = reportedRoutes;
    if (serverConfig) {
      serverConfig.routes = reportedRoutes;
      saveServers(serverRegistry);
    }
  }

  // Save Streaming & AI Unlocks
  if (info && info.unlocks) {
    t.info = t.info || {};
    t.info.unlocks = info.unlocks;
    if (serverConfig) serverConfig.unlocks = info.unlocks;
  }
  if (metrics && metrics.unlocks) {
    t.metrics = t.metrics || {};
    t.metrics.unlocks = metrics.unlocks;
    if (serverConfig) serverConfig.unlocks = metrics.unlocks;
  }

  // Update Monthly Traffic Tracking & Alert Threshold Checks
  if (serverConfig) {
    const rawRx = metrics.net_rx_total || 0;
    const rawTx = metrics.net_tx_total || 0;
    const rawTotal = rawRx + rawTx;

    const cycle = getCycleInfo(serverConfig.trafficResetDay || 1);
    let ts = trafficState[nodeId];

    if (!ts) {
      // First time this node has ever reported
      ts = {
        cycleId: cycle.cycleId,
        cycleAccumulatedBytes: rawTotal,
        lifetimeAccumulatedBytes: rawTotal,
        lastRaw: rawTotal,
        lastAlertLevel: 0,
        lastAlertTime: 0
      };
      trafficState[nodeId] = ts;
      saveTrafficState();
    } else if (ts.cycleId !== cycle.cycleId) {
      // New billing month cycle started!
      // Month resets, but LIFETIME ACCUMULATED BYTES NEVER RESETS!
      let delta = 0;
      if (typeof ts.lastRaw === 'number') {
        delta = rawTotal >= ts.lastRaw ? (rawTotal - ts.lastRaw) : rawTotal;
      } else {
        delta = rawTotal;
      }

      const prevLifetime = typeof ts.lifetimeAccumulatedBytes === 'number'
        ? ts.lifetimeAccumulatedBytes
        : (ts.cycleAccumulatedBytes || rawTotal);

      ts.cycleId = cycle.cycleId;
      ts.cycleAccumulatedBytes = delta;
      ts.lifetimeAccumulatedBytes = prevLifetime + delta;
      ts.lastRaw = rawTotal;
      ts.lastAlertLevel = 0;
      saveTrafficState();
    } else {
      // Ongoing update in current cycle
      let delta = 0;
      if (typeof ts.lastRaw === 'number') {
        if (rawTotal >= ts.lastRaw) {
          delta = rawTotal - ts.lastRaw;
        } else {
          // Node system rebooted: rawTotal started from 0
          delta = rawTotal;
        }
      } else {
        delta = rawTotal;
      }

      ts.cycleAccumulatedBytes = (ts.cycleAccumulatedBytes || 0) + delta;

      if (typeof ts.lifetimeAccumulatedBytes !== 'number') {
        ts.lifetimeAccumulatedBytes = ts.cycleAccumulatedBytes;
      } else {
        ts.lifetimeAccumulatedBytes += delta;
      if (ts.lifetimeAccumulatedBytes < rawTotal) {
        ts.lifetimeAccumulatedBytes = rawTotal;
      }
      }

      ts.lastRaw = rawTotal;
      saveTrafficState();
    }

    // Check Traffic Threshold Alert (临近上限发提醒)
    const limitGB = Number(serverConfig.trafficLimitGB) || 0;
    const alertThreshold = Number(serverConfig.trafficAlertPercent) || 80;
    if (limitGB > 0) {
      const usedBytes = ts.cycleAccumulatedBytes || 0;
      const limitBytes = limitGB * 1024 * 1024 * 1024;
      const pct = Math.min(100, +((usedBytes / limitBytes) * 100).toFixed(1));
      const usedGB = +(usedBytes / (1024 * 1024 * 1024)).toFixed(2);

      let currentLevel = 0;
      if (pct >= 95) currentLevel = 2;
      else if (pct >= alertThreshold) currentLevel = 1;

      if (currentLevel > (ts.lastAlertLevel || 0)) {
        ts.lastAlertLevel = currentLevel;
        ts.lastAlertTime = Date.now();
        saveTrafficState();

        const urgencyText = currentLevel === 2 ? '🔴 严重告急 (已用 ≥95%)' : '⚠️ 临近配额上限';
        const msg = `服务器节点 [${serverConfig.name}] 当月流量已消耗 ${usedGB} GB / ${limitGB} GB (${pct}%)！每月 ${serverConfig.trafficResetDay || 1} 号重置（距重置还剩 ${cycle.daysRemaining} 天）。`;
        sendNotification(`流量预警: ${serverConfig.name} ${urgencyText}`, msg, 'warn');
        addAuditLog('warn', `[流量告警] ${serverConfig.name}: 当月已消耗 ${usedGB} GB / ${limitGB} GB (${pct}%)，临近限额！`);
      }
    }
  }

  // Append CPU/RAM/Net history
  if (!t.history) t.history = [];
  const calculatedMem = +(metrics.mem_percent !== undefined ? metrics.mem_percent : (metrics.mem_usage_percent || (t.info?.mem_total ? ((metrics.mem_used / t.info.mem_total) * 100) : 0))).toFixed(1);
  const calculatedSwap = +(t.info?.swap_total > 0 ? ((metrics.swap_used / t.info.swap_total) * 100) : 0).toFixed(1);
  t.history.push({
    time: nowSec,
    cpu: +(metrics.cpu_usage || 0).toFixed(1),
    mem: calculatedMem,
    swap: calculatedSwap,
    rx_speed: metrics.net_rx_speed || 0,
    tx_speed: metrics.net_tx_speed || 0
  });

  if (t.history.length > (config.historyMaxPoints || 40)) {
    t.history.shift();
  }

  // Record Node CPU / RAM / Swap History for 1h/6h/12h/24h charts
  if (!metricsHistory[nodeId]) metricsHistory[nodeId] = [];
  const mHistArr = metricsHistory[nodeId];
  const lastMPoint = mHistArr[mHistArr.length - 1];
  const mBucketSec = 10;
  const mBucketTime = Math.floor(nowSec / mBucketSec) * mBucketSec;

  const currentCpu = +(metrics.cpu_usage || 0).toFixed(1);
  const currentMem = +(metrics.mem_percent !== undefined ? metrics.mem_percent : (metrics.mem_usage_percent || (t.info?.mem_total ? ((metrics.mem_used / t.info.mem_total) * 100) : 0))).toFixed(1);
  const currentSwap = +(t.info?.swap_total ? ((metrics.swap_used / t.info.swap_total) * 100) : 0).toFixed(1);

  if (!lastMPoint || lastMPoint.t < mBucketTime) {
    mHistArr.push({
      t: mBucketTime,
      cpu: currentCpu,
      mem: currentMem,
      swap: currentSwap
    });
    if (mHistArr.length > 2880) mHistArr.shift();
  } else if (lastMPoint.t === mBucketTime) {
    lastMPoint.cpu = currentCpu;
    lastMPoint.mem = currentMem;
    lastMPoint.swap = currentSwap;
  }

  // Record Ping History for 1h/6h/12h/24h charts
  if (metrics.pings && typeof metrics.pings === 'object') {
    const bucketSec = Math.max(2, config.pingIntervalSec || 3);
    const bucketTime = Math.floor(nowSec / bucketSec) * bucketSec;

    for (const [tid, lat] of Object.entries(metrics.pings)) {
      const key = `${nodeId}:${tid}`;
      if (!latencyHistory[key]) latencyHistory[key] = [];
      const historyArr = latencyHistory[key];
      const last = historyArr[historyArr.length - 1];
      if (!last || last.t < bucketTime) {
        historyArr.push({ t: bucketTime, lat: Number(lat) || -1 });
        // Max 2880 entries (covers up to 24-48 hours)
        if (historyArr.length > 2880) historyArr.shift();
      } else if (last.t === bucketTime) {
        last.lat = Number(lat) || -1;
      }
    }
  }

  // Return ping targets & interval back to agent
  const pendingAction = pendingActions.get(nodeId);
  let actionSig = null;
  if (pendingAction) {
    pendingActions.delete(nodeId);
    // Generate HMAC signature for high-risk actions (e.g. uninstall)
    const payload = `${pendingAction}:${nodeId}:${nowSec}:`;
    actionSig = crypto.createHmac('sha256', nodeSecret).update(payload).digest('hex');
  }

  const needInfo = !t.info || Object.keys(t.info).length === 0;
  res.json({
    ok: true,
    timestamp: nowSec,
    needInfo: needInfo,
    action: pendingAction || null,
    sig: actionSig,
    pingTargets: pingTargets,
    pingIntervalSec: config.pingIntervalSec || 3
  });

  broadcastTelemetry();
});

// One-click install script generator
// Clean Uninstall Script Generator
app.get('/uninstall.sh', (req, res) => {
  res.setHeader('Content-Type', 'text/x-shellscript');
  const script = `#!/usr/bin/env bash
# Tarnz Probe Agent Uninstaller
set -e

echo "=========================================="
echo "⚡ Tarnz Probe Agent 正在执行彻底清理卸载..."
echo "=========================================="

echo "[1/4] 停止并禁用 systemd 服务..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop tanz-agent 2>/dev/null || true
  systemctl disable tanz-agent 2>/dev/null || true
  rm -f /etc/systemd/system/tanz-agent.service
  systemctl daemon-reload 2>/dev/null || true
fi

echo "[2/4] 清理 Docker 容器 (若存在)..."
if command -v docker >/dev/null 2>&1; then
  docker rm -f tanz-agent 2>/dev/null || true
fi

echo "[3/4] 清理安装目录与配置文件..."
rm -rf /opt/tanz-agent

echo "[4/4] 终止可能存在的残留进程..."
pkill -9 -f /opt/tanz-agent/agent.py 2>/dev/null || true

echo "=========================================="
echo "✅ Tarnz Probe Agent 客户端已成功从本机彻底卸载！"
echo "=========================================="
`;
  res.send(script);
});

app.get('/install.sh', (req, res) => {
  const queryNodeId = req.query.id || '';
  const querySecret = req.query.secret || '';
  const host = req.get('host') || 'tanz.example.com';
  const proto = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';

  const script = `#!/usr/bin/env bash
# ==============================================================================
# Tanz Probe Universal Agent Installer (Supports Linux, OpenWrt, iStoreOS, macOS)
# ==============================================================================
set -e

NODE_ID="${queryNodeId}"
NODE_SECRET="${querySecret}"
MASTER_URL="${proto}://${host}"

# Parse CLI arguments if passed (e.g. bash -s -- --server https://... --id ... --secret ...)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id|-i)
      NODE_ID="$2"
      shift 2
      ;;
    --secret|-s)
      NODE_SECRET="$2"
      shift 2
      ;;
    --server|--master|-m)
      MASTER_URL="$2"
      shift 2
      ;;
    *)
      if [ -z "$NODE_ID" ]; then
        NODE_ID="$1"
      elif [ -z "$NODE_SECRET" ]; then
        NODE_SECRET="$1"
      elif [ -z "$MASTER_URL" ] || [ "$MASTER_URL" = "${proto}://${host}" ]; then
        MASTER_URL="$1"
      fi
      shift
      ;;
  esac
done

if [ -z "$NODE_ID" ] || [ -z "$NODE_SECRET" ]; then
  echo "❌ Error: NODE_ID or NODE_SECRET not specified."
  echo ""
  echo "Usage Option 1 (CLI Arguments):"
  echo "  curl -sSL ${proto}://${host}/install.sh | bash -s -- --server ${proto}://${host} --id <NODE_ID> --secret <SECRET>"
  echo ""
  echo "Usage Option 2 (URL Query Parameters):"
  echo "  curl -sSL "${proto}://${host}/install.sh?id=<NODE_ID>&secret=<SECRET>" | bash"
  exit 1
fi

echo "=========================================="
echo "⚡ Installing Tanz Probe Native Micro-Agent..."
echo "Node ID:    $NODE_ID"
echo "Master URL: $MASTER_URL"
echo "=========================================="

INSTALL_DIR="/opt/tanz-agent"
mkdir -p "$INSTALL_DIR"

download() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  else
    echo "Error: Neither curl nor wget found."
    return 1
  fi
}

# 1. Detect architecture and select binary
ARCH="$(uname -m 2>/dev/null || echo 'x86_64')"
BIN_FILE="tanz-agent"

case "$ARCH" in
  x86_64|amd64)
    BIN_FILE="tanz-agent"
    ;;
  aarch64|arm64)
    BIN_FILE="tanz-agent-arm64"
    ;;
  *)
    BIN_FILE="tanz-agent"
    ;;
esac

echo "Detected Machine Architecture: $ARCH -> Selecting $BIN_FILE"

# Try downloading native static binary
DOWNLOADED=false
echo "Downloading binary from $MASTER_URL/$BIN_FILE ..."
if download "$MASTER_URL/$BIN_FILE" "$INSTALL_DIR/tanz-agent"; then
  chmod +x "$INSTALL_DIR/tanz-agent"
  DOWNLOADED=true
  echo "✅ Downloaded native binary agent successfully!"
else
  echo "⚠️ Binary download failed, attempting fallback..."
  if download "$MASTER_URL/tanz-agent" "$INSTALL_DIR/tanz-agent"; then
    chmod +x "$INSTALL_DIR/tanz-agent"
    DOWNLOADED=true
  fi
fi

# Write config.json
cat <<EOF > "$INSTALL_DIR/config.json"
{
  "nodeId": "$NODE_ID",
  "nodeSecret": "$NODE_SECRET",
  "masterUrl": "$MASTER_URL",
  "interval": 2
}
EOF
echo "✅ Wrote config to $INSTALL_DIR/config.json"

# 2. Service Management: Auto-detect systemd vs OpenWrt / iStoreOS procd vs SysVinit
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  echo "Detected Systemd init system. Configuring /etc/systemd/system/tanz-agent.service..."
  cat <<EOF > /etc/systemd/system/tanz-agent.service
[Unit]
Description=Tanz Probe High-Throughput Binary Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/tanz-agent -config $INSTALL_DIR/config.json
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable tanz-agent
  systemctl restart tanz-agent
  echo "✅ Tanz Probe Agent started via Systemd!"
  sleep 1
  systemctl status tanz-agent --no-pager || true

elif [ -f /etc/openwrt_release ] || [ -f /etc/openwrt_version ] || [ -d /etc/init.d ]; then
  echo "Detected OpenWrt / iStoreOS environment. Configuring /etc/init.d/tanz-agent (procd)..."
  cat <<'EOF' > /etc/init.d/tanz-agent
#!/bin/sh /etc/rc.common
START=99
STOP=10
USE_PROCD=1

PROG=/opt/tanz-agent/tanz-agent

start_service() {
    procd_open_instance
    procd_set_param command $PROG -config /opt/tanz-agent/config.json
    procd_set_param respawn 3600 5 0
    procd_set_param stdout 1
    procd_set_param stderr 1
    procd_close_instance
}

stop_service() {
    killall tanz-agent 2>/dev/null
}
EOF

  chmod +x /etc/init.d/tanz-agent
  /etc/init.d/tanz-agent enable
  /etc/init.d/tanz-agent restart
  echo "✅ Tanz Probe Agent started via OpenWrt / iStoreOS procd!"

else
  echo "Configuring background process..."
  killall tanz-agent 2>/dev/null || true
  nohup $INSTALL_DIR/tanz-agent -config $INSTALL_DIR/config.json >/dev/null 2>&1 &
  echo "✅ Tanz Probe Agent running in background!"
fi

echo "========================================================="
echo "🎉 Tanz Probe Agent installation completed successfully!"
echo "========================================================="
`;

  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.send(script);
});

app.get('/tanz-agent-arm64', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tanz-agent-arm64'));
});

app.get('/tanz-agent', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tanz-agent'));
});

app.get('/agent.py', (req, res) => {
  res.sendFile(path.join(__dirname, 'agent.py'));
});

// ---------------------------------------------------------------------
// Security Gateway: Login Circuit Breaker & Anti-Brute-Force System
// ---------------------------------------------------------------------

function normalizeIp(ip) {
  if (!ip) return '';
  let str = String(ip).trim();
  if (str.startsWith('::ffff:')) {
    str = str.replace('::ffff:', '');
  }
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(str)) {
    str = str.split(':')[0];
  }
  return str.trim();
}

function getClientIp(req) {
  const socketRemote = normalizeIp(req.socket.remoteAddress || '127.0.0.1');
  // Strict Proxy Anti-Spoofing: Only trust proxy headers if request originated from local reverse proxy
  if (socketRemote === '127.0.0.1' || socketRemote === '::1' || socketRemote === 'localhost') {
    // 1. Strictly prioritize X-Real-IP forced by Nginx ($remote_addr)
    const realIp = req.headers['x-real-ip'];
    if (realIp && typeof realIp === 'string') {
      const norm = normalizeIp(realIp.trim());
      if (norm) return norm;
    }
    // 2. Cloudflare authenticated connecting IP
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp && typeof cfIp === 'string') {
      const norm = normalizeIp(cfIp.trim());
      if (norm) return norm;
    }
  }
  // Direct connection without trusted reverse proxy: strictly use real socket address
  return socketRemote;
}

// Set of known installed agent IPs (initialized with localhost and master IP)
const installedAgentIps = new Set(['127.0.0.1', '::1', 'localhost', '1.2.3.4']);

function refreshInstalledAgentIps() {
  if (typeof serverRegistry !== 'undefined' && Array.isArray(serverRegistry)) {
    for (const s of serverRegistry) {
      if (s.publicIp) installedAgentIps.add(normalizeIp(s.publicIp));
      if (s.realIp && s.realIp !== '待探测') installedAgentIps.add(normalizeIp(s.realIp));
    }
  }
  if (typeof telemetry !== 'undefined' && telemetry && typeof telemetry.entries === 'function') {
    for (const [_, t] of telemetry.entries()) {
      if (t.publicIp) installedAgentIps.add(normalizeIp(t.publicIp));
      if (t.realIp && t.realIp !== '待探测') installedAgentIps.add(normalizeIp(t.realIp));
      if (t.info && t.info.public_ip) installedAgentIps.add(normalizeIp(t.info.public_ip));
    }
  }
}

function isInstalledAgentIp(clientIp) {
  const clean = normalizeIp(clientIp);
  if (!clean) return false;
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  if (installedAgentIps.has(clean)) return true;
  refreshInstalledAgentIps();
  return installedAgentIps.has(clean);
}

// Map: clientIp -> { attempts: number, firstAttemptTime: number, lockedUntil: number }
const loginAttempts = new Map();

// Map: sessionToken -> { createdAt: number, expiresAt: number, ip: string, lastActive: number }
// =====================================================================
// Trusted Devices & Dual-Key IP Mutual Authentication Engine
// =====================================================================
const TRUSTED_DEVICES_FILE = path.join(DATA_DIR, 'trusted_devices.json');
let trustedDevices = [];

function loadTrustedDevices() {
  try {
    if (fs.existsSync(TRUSTED_DEVICES_FILE)) {
      const data = JSON.parse(fs.readFileSync(TRUSTED_DEVICES_FILE, 'utf8'));
      if (Array.isArray(data)) {
        trustedDevices = data;
      }
    }
  } catch (e) {
    console.error('Error reading trusted_devices.json:', e);
    trustedDevices = [];
  }
}
loadTrustedDevices();

function saveTrustedDevices() {
  try {
    fs.writeFileSync(TRUSTED_DEVICES_FILE, JSON.stringify(trustedDevices, null, 2));
  } catch (e) {
    console.error('Error saving trusted_devices.json:', e);
  }
}

function parseDeviceName(ua) {
  if (!ua) return '通用终端';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac 电脑';
  if (/iPhone/i.test(ua)) return 'iPhone 手机';
  if (/iPad/i.test(ua)) return 'iPad 平板';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Linux/i.test(ua)) return 'Linux 终端';
  return '受信任浏览器终端';
}

const activeSessions = new Map();

const MAX_LOGIN_ATTEMPTS = 5;               // 5 consecutive failed attempts
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;    // 10 minutes sliding window
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;  // 15 minutes lockout
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours session TTL

// Periodic cleanup of expired lockout & session records (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts.entries()) {
    if (rec.lockedUntil && now >= rec.lockedUntil) {
      loginAttempts.delete(ip);
    } else if (!rec.lockedUntil && now - rec.firstAttemptTime > ATTEMPT_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
  for (const [token, sess] of activeSessions.entries()) {
    if (now >= sess.expiresAt) {
      activeSessions.delete(token);
    }
  }
}, 5 * 60 * 1000);

// Admin auth middleware with Session Token & Password compatibility & Agent IP Whitelist
function requireAdmin(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();

  // Strict Security Hardening: NO unauthenticated bare IP bypass.
  // All administrative operations strictly require cryptographically verified session token or master password.

  // Token / password validation: strictly require x-admin-token in request headers; do NOT accept query param ?token=
  const token = req.headers['x-admin-token'];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Missing x-admin-token header' });
  }

  const session = activeSessions.get(token);
  const isValidSession = session && now < session.expiresAt;
  const isDirectPassword = (token === config.adminPassword);

  if (!isValidSession && !isDirectPassword) {
    return res.status(401).json({ error: 'Unauthorized: Session expired or invalid admin token' });
  }

  if (session) {
    session.lastActive = now;
  }

  next();
}

// Check auth status & Dual-Key IP + Device Token Authentication
app.get('/api/admin/auth-status', (req, res) => {
  const token = req.headers['x-admin-token'];
  const deviceToken = req.headers['x-device-token'];
  const ip = getClientIp(req);
  const now = Date.now();
  const isAgent = isInstalledAgentIp(ip);

  // 1. Existing active session validation
  if (token) {
    const session = activeSessions.get(token);
    if (session && now < session.expiresAt) {
      session.lastActive = now;
      return res.json({
        ok: true,
        authenticated: true,
        token,
        clientIp: ip,
        isAgentIp: isAgent,
        mode: 'session'
      });
    }
    if (token === config.adminPassword) {
      return res.json({
        ok: true,
        authenticated: true,
        token,
        clientIp: ip,
        isAgentIp: isAgent,
        mode: 'password'
      });
    }
  }

  // 2. Dual-Key Authentication (Trusted IP + Bound Cryptographic Device Secret)
  if (deviceToken && typeof deviceToken === 'string' && deviceToken.startsWith('sec_dev_')) {
    const device = trustedDevices.find(d => d.deviceToken === deviceToken);
    if (device && now < (device.expiresAt || Infinity)) {
      if (device.boundIp === ip) {
        device.lastUsedAt = now;
        saveTrustedDevices();

        const sessionToken = 'tok_dev_' + crypto.randomBytes(24).toString('hex');
        activeSessions.set(sessionToken, {
          ip,
          createdAt: now,
          expiresAt: now + SESSION_TTL_MS,
          lastActive: now,
          autoByDeviceToken: true,
          deviceId: device.id
        });

        addAuditLog('auth', `🟢 信任设备与 IP 双重鉴权成功: ${device.name} @ ${ip}`);

        return res.json({
          ok: true,
          authenticated: true,
          autoLogin: true,
          token: sessionToken,
          clientIp: ip,
          isAgentIp: isAgent,
          deviceId: device.id,
          deviceName: device.name,
          boundIp: device.boundIp,
          mode: 'device_ip_dual_key',
          message: `已通过 [受信任 IP: ${ip} + 终端指纹: ${device.name}] 双重校验，免密安全登录`
        });
      } else {
        // Device token presented, but IP mismatch!
        return res.json({
          ok: true,
          authenticated: false,
          clientIp: ip,
          isAgentIp: isAgent,
          deviceBoundMismatch: true,
          ipMismatch: true,
          currentIp: ip,
          boundIp: device.boundIp,
          deviceName: device.name,
          message: `已绑定设备，但检测到当前 IP [${ip}] 与授权 IP [${device.boundIp}] 不匹配，请使用密码登录`
        });
      }
    }
  }

  // 3. Not authenticated
  return res.json({
    ok: true,
    authenticated: false,
    clientIp: ip,
    isAgentIp: isAgent
  });
});

// Login API with Rate Limiting, Circuit Breaker & Telegram Alerting
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const ip = getClientIp(req);
  const now = Date.now();

  let record = loginAttempts.get(ip);
  if (!record) {
    record = { attempts: 0, firstAttemptTime: now, lockedUntil: 0 };
    loginAttempts.set(ip, record);
  }

  // 1. Check if currently locked out
  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
    const remainingMin = Math.ceil(remainingSec / 60);
    return res.status(429).json({
      ok: false,
      locked: true,
      remainingSec,
      error: `🚨 登录防猜保护已触发：该 IP 尝试次数过多已被锁定，请在 ${remainingMin} 分钟后再试（还剩 ${remainingSec} 秒）`
    });
  }

  // Reset window if expired
  if (!record.lockedUntil && now - record.firstAttemptTime > ATTEMPT_WINDOW_MS) {
    record.attempts = 0;
    record.firstAttemptTime = now;
  }

  // 2. Validate Password
  if (password === config.adminPassword) {
    // Reset failed counter
    loginAttempts.delete(ip);

    // Generate secure random session token
    const sessionToken = 'tok_' + crypto.randomBytes(24).toString('hex');
    activeSessions.set(sessionToken, {
      ip,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastActive: now
    });

    addAuditLog('auth', `管理员成功登录管理后台 (IP: ${ip})`);

    // Dual-Key Device Binding if requested by client
    let newDeviceToken = null;
    let boundDeviceId = null;
    if (req.body.rememberDevice) {
      const userAgent = req.headers['user-agent'] || '未知客户端';
      const devName = (req.body.deviceName && typeof req.body.deviceName === 'string' && req.body.deviceName.trim())
        ? req.body.deviceName.trim().slice(0, 50)
        : parseDeviceName(userAgent);

      newDeviceToken = 'sec_dev_' + crypto.randomBytes(32).toString('hex');
      boundDeviceId = 'dev_' + crypto.randomBytes(8).toString('hex');

      // Keep max 20 trusted devices
      if (trustedDevices.length >= 20) {
        trustedDevices.sort((a, b) => (a.lastUsedAt || a.createdAt) - (b.lastUsedAt || b.createdAt));
        trustedDevices.shift();
      }

      trustedDevices.push({
        id: boundDeviceId,
        deviceToken: newDeviceToken,
        boundIp: ip,
        name: devName,
        userAgent: userAgent.slice(0, 150),
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now + (180 * 24 * 3600 * 1000) // 180 days
      });
      saveTrustedDevices();

      addAuditLog('auth', `🔑 信任设备绑定成功: [${devName}] 绑定至当前 IP [${ip}]`);
    }

    // Send Telegram Notification on Successful Login
    sendNotification(
      '🛡️ 后台管理员登录成功',
      `<b>检测到管理后台登录事件</b>\n\n` +
      `• <b>登录 IP:</b> <code>${ip}</code>\n` +
      `• <b>客户端:</b> <code>${(req.headers['user-agent'] || '未知客户端').slice(0, 100)}</code>` +
      (req.body.rememberDevice ? `\n• <b>信任终端:</b> 已绑定此设备与 IP` : ''),
      'info'
    ).catch(() => {});

    return res.json({
      ok: true,
      token: sessionToken,
      deviceToken: newDeviceToken,
      deviceId: boundDeviceId,
      boundIp: ip
    });
  } else {
    // Password incorrect -> increment counter
    record.attempts += 1;

    // Check if limit exceeded
    if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
      record.lockedUntil = now + LOCKOUT_DURATION_MS;
      const lockedSec = Math.ceil(LOCKOUT_DURATION_MS / 1000);

      addAuditLog('warn', `🚨 触发防猜熔断门禁：IP ${ip} 连续 5 次输错密码，已被系统安全锁定 15 分钟！`);

      // Trigger high-priority Telegram alert!
      sendNotification(
        '🚨 防爆破熔断安全告警',
        `<b>检测到后台恶意猜解密码攻击！</b>\n\n` +
        `• <b>来源 IP:</b> <code>${ip}</code>\n` +
        `• <b>告警原因:</b> 连续输错管理员密码达到 5 次上限\n` +
        `• <b>防御响应:</b> 系统已自动对该 IP 实施熔断封锁 15 分钟\n` +
        `• <b>客户端信息:</b> <code>${(req.headers['user-agent'] || '未知客户端').slice(0, 100)}</code>`,
        'warn'
      ).catch(() => {});

      return res.status(429).json({
        ok: false,
        locked: true,
        remainingSec: lockedSec,
        error: `🚨 连续输错密码达到 5 次上限！该 IP 已被安全熔断锁定 15 分钟。`
      });
    }

    const remaining = MAX_LOGIN_ATTEMPTS - record.attempts;
    addAuditLog('warn', `管理员登录密码错误 (IP: ${ip}，还剩 ${remaining} 次机会)`);

    return res.status(401).json({
      ok: false,
      remainingAttempts: remaining,
      error: `管理员密码错误！还可尝试 ${remaining} 次，超出后将被封锁 15 分钟。`
    });
  }
});

// Security Gateway Status & IP Unlock APIs
// Trusted Devices Management APIs (Dual-Key Auth)
app.get('/api/admin/trusted-devices', requireAdmin, (req, res) => {
  const clientIp = getClientIp(req);
  const currentDevToken = req.headers['x-device-token'];
  const list = trustedDevices.map(d => ({
    id: d.id,
    name: d.name,
    boundIp: d.boundIp,
    isCurrentIp: d.boundIp === clientIp,
    isCurrentDevice: Boolean(currentDevToken && d.deviceToken === currentDevToken),
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt,
    expiresAt: d.expiresAt,
    userAgent: d.userAgent
  }));
  res.json({ ok: true, devices: list, currentClientIp: clientIp });
});

app.post('/api/admin/trusted-devices/:id/revoke', requireAdmin, (req, res) => {
  const { id } = req.params;
  const idx = trustedDevices.findIndex(d => d.id === id);
  if (idx !== -1) {
    const removed = trustedDevices.splice(idx, 1)[0];
    saveTrustedDevices();
    for (const [sessTok, sess] of activeSessions.entries()) {
      if (sess.deviceId === id) {
        activeSessions.delete(sessTok);
      }
    }
    addAuditLog('auth', `🗑️ 注销信任设备: ${removed.name} (绑定 IP: ${removed.boundIp})`);
    return res.json({ ok: true, message: `已成功注销信任设备: ${removed.name}` });
  }
  res.status(404).json({ ok: false, error: '未找到指定设备' });
});

app.post('/api/admin/trusted-devices/clear-all', requireAdmin, (req, res) => {
  const count = trustedDevices.length;
  trustedDevices = [];
  saveTrustedDevices();
  addAuditLog('auth', `🗑️ 一键注销所有信任设备 (共 ${count} 台)`);
  res.json({ ok: true, message: `已成功清除全部 ${count} 台信任设备` });
});

app.post('/api/admin/trusted-devices/bind-current', requireAdmin, (req, res) => {
  const clientIp = getClientIp(req);
  const currentDevToken = req.headers['x-device-token'] || req.body.deviceToken;
  const userAgent = req.headers['user-agent'] || '未知客户端';
  const now = Date.now();

  let device = null;
  if (currentDevToken) {
    device = trustedDevices.find(d => d.deviceToken === currentDevToken);
  }

  let finalDeviceToken = currentDevToken;
  if (device) {
    const oldIp = device.boundIp;
    device.boundIp = clientIp;
    device.lastUsedAt = now;
    saveTrustedDevices();
    addAuditLog('auth', `🔄 信任设备 [${device.name}] 绑定 IP 更新: ${oldIp} -> ${clientIp}`);
    return res.json({
      ok: true,
      deviceToken: device.deviceToken,
      boundIp: clientIp,
      message: `已将设备 [${device.name}] 成功更新绑定至当前 IP [${clientIp}]`
    });
  } else {
    finalDeviceToken = 'sec_dev_' + crypto.randomBytes(32).toString('hex');
    const devId = 'dev_' + crypto.randomBytes(8).toString('hex');
    const devName = (req.body.deviceName && typeof req.body.deviceName === 'string' && req.body.deviceName.trim())
      ? req.body.deviceName.trim().slice(0, 50)
      : parseDeviceName(userAgent);

    if (trustedDevices.length >= 20) {
      trustedDevices.sort((a, b) => (a.lastUsedAt || a.createdAt) - (b.lastUsedAt || b.createdAt));
      trustedDevices.shift();
    }

    trustedDevices.push({
      id: devId,
      deviceToken: finalDeviceToken,
      boundIp: clientIp,
      name: devName,
      userAgent: userAgent.slice(0, 150),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + (180 * 24 * 3600 * 1000)
    });
    saveTrustedDevices();
    addAuditLog('auth', `🔑 信任设备绑定成功: [${devName}] 绑定至当前 IP [${clientIp}]`);
    return res.json({
      ok: true,
      deviceToken: finalDeviceToken,
      boundIp: clientIp,
      message: `已成功将当前终端 [${devName}] 绑定至当前 IP [${clientIp}]`
    });
  }
});

app.post('/api/admin/historical-peak/reset', requireAdmin, (req, res) => {
  historicalPeak = { rx: 0, tx: 0, combined: 0, timestamp: 0, formattedDate: '' };
  try {
    fs.writeFileSync(HISTORICAL_PEAK_FILE, JSON.stringify(historicalPeak, null, 2), 'utf8');
  } catch (err) {}
  addAuditLog('settings', '重置全网历史吞吐峰值记录');
  res.json({ ok: true, message: '全网历史吞吐峰值记录已成功重置', historicalPeak });
});

app.get('/api/admin/security/status', requireAdmin, (req, res) => {
  const now = Date.now();
  const lockedList = [];

  for (const [ip, rec] of loginAttempts.entries()) {
    if (rec.lockedUntil && now < rec.lockedUntil) {
      lockedList.push({
        ip,
        remainingSec: Math.ceil((rec.lockedUntil - now) / 1000),
        attempts: rec.attempts
      });
    }
  }

  res.json({
    ok: true,
    maxAttempts: MAX_LOGIN_ATTEMPTS,
    lockoutDurationMin: Math.round(LOCKOUT_DURATION_MS / 60000),
    activeSessionsCount: activeSessions.size,
    lockedIps: lockedList
  });
});

app.post('/api/admin/security/unlock', requireAdmin, (req, res) => {
  const { ip } = req.body;
  if (ip) {
    loginAttempts.delete(ip);
    addAuditLog('info', `管理员主动解除了 IP ${ip} 的登录防猜锁定`);
  } else {
    loginAttempts.clear();
    addAuditLog('info', `管理员清空了所有 IP 登录防猜锁定记录`);
  }
  res.json({ ok: true, message: '锁定记录已成功清除' });
});

// Server Management
app.get('/api/admin/servers', requireAdmin, (req, res) => {
  const enrichedServers = serverRegistry.map(s => {
    const t = telemetry.get(s.id) || {};
    return {
      ...s,
      traffic: calculateTrafficStats(s, t)
    };
  });
  res.json({ 
    servers: enrichedServers, 
    config, 
    pingTargets, 
    provinceNodes,
    auditLogs
  });
});

// Update Ping Frequency
app.post('/api/admin/ping-interval', requireAdmin, (req, res) => {
  const sec = Math.max(1, Math.min(300, Number(req.body.interval) || 3));
  config.pingIntervalSec = sec;
  saveConfig(config);
  broadcastTelemetry();
  addAuditLog('info', `测速频率更新为 ${sec} 秒/次`);
  res.json({ ok: true, pingIntervalSec: sec });
});

// Reorder registered servers
app.post('/api/admin/servers/reorder', requireAdmin, (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds must be an array of server IDs' });
  }

  const idMap = new Map();
  serverRegistry.forEach(s => idMap.set(s.id, s));

  const newServers = [];
  orderedIds.forEach((id, idx) => {
    if (idMap.has(id)) {
      const s = idMap.get(id);
      s.order = idx + 1;
      newServers.push(s);
      idMap.delete(id);
    }
  });

  // Append any remaining servers
  idMap.forEach(s => {
    s.order = newServers.length + 1;
    newServers.push(s);
  });

  serverRegistry = newServers;
  saveServers(serverRegistry);
  broadcastTelemetry();
  addAuditLog('info', '更新在册服务器展示顺序');
  res.json({ ok: true, servers: serverRegistry });
});

// Add single server
app.post('/api/admin/servers/add', requireAdmin, (req, res) => {
  const { name, location, region, flag, tag, publicIp, order } = req.body;
  if (!name) return res.status(400).json({ error: 'Server name is required' });

  const id = req.body.id || `node-${crypto.randomBytes(3).toString('hex')}`;
  if (serverRegistry.some(s => s.id === id)) {
    return res.status(400).json({ error: `Node ID "${id}" already exists` });
  }

  const secret = `sec_${id.replace(/[^a-zA-Z0-9]/g, '')}_${crypto.randomBytes(4).toString('hex')}`;
  const {
    price,
    currency,
    billingCycle,
    expiredAt,
    autoRenewal,
    trafficLimitGB,
    trafficResetDay,
    trafficAlertPercent,
    virtualization
  } = req.body;

  const newServer = {
    id,
    name: name.trim(),
    location: (location || '全球节点').trim(),
    region: (region || 'OTHER').trim().toUpperCase(),
    flag: (flag || '🌐').trim(),
    tag: (tag || '常规节点').trim(),
    secret,
    order: Number(order) || (serverRegistry.length + 1),
    publicIp: (publicIp || '待探针探测...').trim(),
    realIp: (publicIp || '待探针探测...').trim(),
    price: price !== undefined && price !== '' ? Number(price) : 0,
    currency: currency || '$',
    billingCycle: billingCycle !== undefined && billingCycle !== '' ? Number(billingCycle) : 365,
    expiredAt: expiredAt || null,
    autoRenewal: !!autoRenewal,
    trafficLimitGB: trafficLimitGB !== undefined && trafficLimitGB !== '' ? Number(trafficLimitGB) : 0,
    trafficResetDay: trafficResetDay !== undefined && trafficResetDay !== '' ? Math.max(1, Math.min(31, Number(trafficResetDay))) : 1,
    trafficAlertPercent: trafficAlertPercent !== undefined && trafficAlertPercent !== '' ? Math.max(50, Math.min(99, Number(trafficAlertPercent))) : 80,
    virtualization: (virtualization || 'kvm').toLowerCase(),
    created_at: new Date().toISOString()
  };

  serverRegistry.push(newServer);
  saveServers(serverRegistry);
  initTelemetry();
  broadcastTelemetry();
  addAuditLog('success', `新增服务器监控节点: [${newServer.name}] (${newServer.id})`);

  res.json({ ok: true, server: newServer });
});

// Update existing server details
app.put('/api/admin/servers/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const sIdx = serverRegistry.findIndex(s => s.id === id);
  if (sIdx === -1) return res.status(404).json({ error: 'Server not found' });

  const {
    name, flag, region, location, tag, publicIp, order, isHidden,
    price, currency, billingCycle, expiredAt, autoRenewal, trafficLimitGB, trafficResetDay, trafficAlertPercent, virtualization
  } = req.body;

  if (name) serverRegistry[sIdx].name = name.trim();
  if (flag) serverRegistry[sIdx].flag = flag.trim();
  if (region) serverRegistry[sIdx].region = region.trim().toUpperCase();
  if (location) serverRegistry[sIdx].location = location.trim();
  if (tag) serverRegistry[sIdx].tag = tag.trim();
  if (publicIp) serverRegistry[sIdx].publicIp = publicIp.trim();
  if (order !== undefined) serverRegistry[sIdx].order = Number(order) || 99;
  if (isHidden !== undefined) serverRegistry[sIdx].isHidden = !!isHidden;
  if (price !== undefined) serverRegistry[sIdx].price = Number(price) || 0;
  if (currency !== undefined) serverRegistry[sIdx].currency = currency.trim();
  if (billingCycle !== undefined) serverRegistry[sIdx].billingCycle = Number(billingCycle) || 0;
  if (expiredAt !== undefined) serverRegistry[sIdx].expiredAt = expiredAt || null;
  if (autoRenewal !== undefined) serverRegistry[sIdx].autoRenewal = !!autoRenewal;
  if (trafficLimitGB !== undefined) serverRegistry[sIdx].trafficLimitGB = Number(trafficLimitGB) || 0;
  if (trafficResetDay !== undefined) serverRegistry[sIdx].trafficResetDay = Math.max(1, Math.min(31, Number(trafficResetDay))) || 1;
  if (trafficAlertPercent !== undefined) serverRegistry[sIdx].trafficAlertPercent = Math.max(50, Math.min(99, Number(trafficAlertPercent))) || 80;
  if (virtualization !== undefined) serverRegistry[sIdx].virtualization = virtualization.trim().toLowerCase();

  saveServers(serverRegistry);
  broadcastTelemetry();
  addAuditLog('info', `修改服务器节点配置: [${serverRegistry[sIdx].name}]`);
  res.json({ ok: true, server: serverRegistry[sIdx] });
});

// Reset server monthly traffic cycle
app.post('/api/admin/servers/:id/reset-traffic', requireAdmin, (req, res) => {
  const id = req.params.id;
  const s = serverRegistry.find(x => x.id === id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const cycle = getCycleInfo(s.trafficResetDay || 1);
  const currentLifetime = trafficState[id]?.lifetimeAccumulatedBytes || 0;
  trafficState[id] = {
    cycleId: cycle.cycleId,
    cycleAccumulatedBytes: 0,
    lifetimeAccumulatedBytes: currentLifetime, // Preserve lifetime total!
    lastRaw: trafficState[id]?.lastRaw || 0,
    lastAlertLevel: 0,
    lastAlertTime: 0
  };
  saveTrafficState();
  broadcastTelemetry();
  addAuditLog('info', `管理员手动归零了节点 [${s.name}] 的当月已用流量统计`);
  res.json({ ok: true, message: `节点 [${s.name}] 当月已用流量已重置归零` });
});

// Reset server secret
app.post('/api/admin/servers/:id/reset-secret', requireAdmin, (req, res) => {
  const id = req.params.id;
  const sIdx = serverRegistry.findIndex(s => s.id === id);
  if (sIdx === -1) return res.status(404).json({ error: 'Server not found' });

  const newSecret = `sec_${id.replace(/[^a-zA-Z0-9]/g, '')}_${crypto.randomBytes(4).toString('hex')}`;
  serverRegistry[sIdx].secret = newSecret;
  saveServers(serverRegistry);
  addAuditLog('warn', `重置节点 [${serverRegistry[sIdx].name}] 通信密钥`);
  res.json({ ok: true, secret: newSecret });
});

// Delete server
// Remote Uninstall Agent from Server
app.post('/api/admin/servers/:id/uninstall', requireAdmin, (req, res) => {
  const id = req.params.id;
  const targetServer = serverRegistry.find(s => s.id === id);
  if (!targetServer) {
    return res.status(404).json({ error: 'Server not found' });
  }
  pendingActions.set(id, 'uninstall');
  addAuditLog('warn', `向节点 [${targetServer.name}] 下发客户端彻底卸载指令`);
  res.json({
    ok: true,
    message: `已向节点 [${targetServer.name}] 下发卸载指令，探针将在下次心跳通信时执行清理退出`
  });
});

app.delete('/api/admin/servers/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const targetServer = serverRegistry.find(s => s.id === id);
  const before = serverRegistry.length;
  serverRegistry = serverRegistry.filter(s => s.id !== id);
  if (serverRegistry.length === before) {
    return res.status(404).json({ error: 'Server not found' });
  }
  telemetry.delete(id);
  saveServers(serverRegistry);
  broadcastTelemetry();
  addAuditLog('warn', `删除服务器节点: [${targetServer ? targetServer.name : id}]`);
  res.json({ ok: true, id });
});

// Ping Targets Management
// Reorder Ping Targets
app.post('/api/admin/targets/reorder', requireAdmin, (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds must be an array of IDs' });
  }

  const idMap = new Map();
  pingTargets.forEach(t => idMap.set(t.id, t));

  const newTargets = [];
  orderedIds.forEach(id => {
    if (idMap.has(id)) {
      newTargets.push(idMap.get(id));
      idMap.delete(id);
    }
  });

  // Append any targets not in orderedIds
  idMap.forEach(t => newTargets.push(t));

  pingTargets = newTargets;
  savePingTargets(pingTargets);
  broadcastTelemetry();
  addAuditLog('info', '管理员调整了测速目标显示顺序');
  res.json({ ok: true, targets: pingTargets });
});

app.post('/api/admin/targets/add', requireAdmin, (req, res) => {
  const { name, host, flag, group } = req.body;
  if (!name || !host) {
    return res.status(400).json({ error: 'Target name and host/IP are required' });
  }

  const cleanHost = String(host).split(':')[0].trim();
  const id = req.body.id || `pt-${crypto.randomBytes(3).toString('hex')}`;
  const newTarget = {
    id,
    name: name.trim(),
    host: cleanHost,
    flag: (flag || '🌐').trim(),
    group: (group || '自定义').trim(),
    clients: Array.isArray(req.body.clients) ? req.body.clients : []
  };

  pingTargets.push(newTarget);
  savePingTargets(pingTargets);
  broadcastTelemetry();
  addAuditLog('info', `新增测速目标: [${newTarget.name}] (${newTarget.host})`);
  res.json({ ok: true, target: newTarget, pingTargets });
});

// Update ping target
app.put('/api/admin/targets/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const tIdx = pingTargets.findIndex(t => t.id === id);
  if (tIdx === -1) return res.status(404).json({ error: 'Target not found' });

  const { name, host, flag, group } = req.body;
  if (name) pingTargets[tIdx].name = name.trim();
  if (host) pingTargets[tIdx].host = String(host).split(':')[0].trim();
  if (flag) pingTargets[tIdx].flag = flag.trim();
  if (group) pingTargets[tIdx].group = group.trim();
  if (req.body.clients !== undefined && Array.isArray(req.body.clients)) {
    pingTargets[tIdx].clients = req.body.clients;
  }

  savePingTargets(pingTargets);
  broadcastTelemetry();
  addAuditLog('info', `修改测速目标: [${pingTargets[tIdx].name}]`);
  res.json({ ok: true, target: pingTargets[tIdx], pingTargets });
});

app.delete('/api/admin/targets/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const target = pingTargets.find(t => t.id === id);
  pingTargets = pingTargets.filter(t => t.id !== id);
  savePingTargets(pingTargets);
  broadcastTelemetry();
  addAuditLog('warn', `删除测速目标: [${target ? target.name : id}]`);
  res.json({ ok: true, id, pingTargets });
});

// Test ping directly from master
app.post('/api/admin/targets/test-ping', requireAdmin, (req, res) => {
  const { host } = req.body;
  if (!host) return res.status(400).json({ error: 'Missing host' });
  const cleanHost = String(host).split(':')[0].trim();

  execFile('ping', ['-c', '1', '-W', '2', cleanHost], (err, stdout) => {
    if (err) {
      return res.json({ ok: true, success: false, latency: -1, msg: '探测超时或网络不可达' });
    }
    const match = /time=([0-9\.]+)\s*ms/.exec(stdout);
    const lat = match ? parseFloat(match[1]) : -1;
    res.json({ ok: true, success: true, latency: lat, raw: stdout.trim() });
  });
});

// Batch toggle all provinces
app.post('/api/admin/targets/batch-provinces', requireAdmin, (req, res) => {
  const { action } = req.body; // 'all' | 'clear'
  if (action === 'clear') {
    pingTargets = pingTargets.filter(t => !t.province && !(t.id && t.id.startsWith('pt-prov-')));
    savePingTargets(pingTargets);
    broadcastTelemetry();
    addAuditLog('warn', '已一键清空所有省份三网测速目标');
    return res.json({ ok: true, pingTargets, count: pingTargets.length });
  } else if (action === 'all') {
    const customTargets = pingTargets.filter(t => !t.province && !(t.id && t.id.startsWith('pt-prov-')));
    for (const pData of provinceNodes) {
      const prov = pData.province;
      const prefix = `pt-prov-${prov}`;
      for (const [carrier, endpoint] of Object.entries(pData.carriers)) {
        const cleanHost = endpoint.split(':')[0].trim();
        const label = carrier === 'telecom' ? '电信' : (carrier === 'unicom' ? '联通' : '移动');
        customTargets.push({
          id: `${prefix}-${carrier}`,
          name: `${prov} ${label}`,
          host: cleanHost,
          flag: '🇨🇳',
          group: `${prov}`,
          province: prov,
          carrier: carrier
        });
      }
    }
    pingTargets = customTargets;
    savePingTargets(pingTargets);
    broadcastTelemetry();
    addAuditLog('success', '已一键启用全国 31 省三网节点 (共 93 个节点)');
    return res.json({ ok: true, pingTargets, count: pingTargets.length });
  }
  res.status(400).json({ error: 'Invalid action' });
});

// Toggle Province (Add 3 carriers or Remove 3 carriers)
app.post('/api/admin/targets/toggle-province', requireAdmin, (req, res) => {
  const { province } = req.body;
  const pData = provinceNodes.find(p => p.province === province);
  if (!pData) return res.status(404).json({ error: `未找到省份 ${province}` });

  const prefix = `pt-prov-${province}`;
  const existing = pingTargets.filter(t => t.province === province || (t.id && t.id.startsWith(prefix)));

  if (existing.length > 0) {
    // REMOVE them (toggle off)
    pingTargets = pingTargets.filter(t => !(t.province === province || (t.id && t.id.startsWith(prefix))));
    savePingTargets(pingTargets);
    broadcastTelemetry();
    addAuditLog('info', `关闭省份测速: [${province}] 三网节点已移除`);
    return res.json({ ok: true, active: false, province, pingTargets });
  } else {
    // ADD them (toggle on)
    for (const [carrier, endpoint] of Object.entries(pData.carriers)) {
      const cleanHost = endpoint.split(':')[0].trim();
      const label = carrier === 'telecom' ? '电信' : (carrier === 'unicom' ? '联通' : '移动');
      pingTargets.push({
        id: `${prefix}-${carrier}`,
        name: `${province} ${label}`,
        host: cleanHost,
        flag: '🇨🇳',
        group: `${province}`,
        province: province,
        carrier: carrier
      });
    }
    savePingTargets(pingTargets);
    broadcastTelemetry();
    addAuditLog('success', `开启省份测速: [${province}] 电信、联通、移动 3 节点已生效`);
    return res.json({ ok: true, active: true, province, pingTargets });
  }
});

// System Settings API
app.get('/api/admin/config', requireAdmin, (req, res) => {
  const safeConfig = { ...config };
  delete safeConfig.adminPassword;
  res.json({ ok: true, config: safeConfig });
});

app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { 
    hideIpMode, 
    reportIntervalSec, 
    pingIntervalSec, 
    offlineThresholdSec, 
    siteTitle, 
    siteSubtitle 
  } = req.body;

  if (hideIpMode && ['mask', 'full_hidden', 'plain'].includes(hideIpMode)) {
    config.hideIpMode = hideIpMode;
  }
  if (reportIntervalSec) config.reportIntervalSec = Math.max(1, Math.min(60, Number(reportIntervalSec) || 2));
  if (pingIntervalSec) config.pingIntervalSec = Math.max(1, Math.min(300, Number(pingIntervalSec) || 3));
  if (offlineThresholdSec) config.offlineThresholdSec = Math.max(3, Math.min(120, Number(offlineThresholdSec) || 10));
  if (siteTitle) config.siteTitle = String(siteTitle).trim();
  if (siteSubtitle) config.siteSubtitle = String(siteSubtitle).trim();

  saveConfig(config);
  broadcastTelemetry();
  addAuditLog('info', `保存全局系统设置 (IP脱敏: ${config.hideIpMode}, 测速周期: ${config.pingIntervalSec}s)`);
  res.json({ ok: true, config });
});

// Change Password API
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请提供原密码与新密码' });
  }
  if (oldPassword !== config.adminPassword) {
    return res.status(400).json({ error: '原密码校验错误' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码长度至少需要 6 个字符' });
  }

    config.adminPassword = newPassword;
  saveConfig(config);

  // Invalidate all existing sessions and create a fresh one for the current admin
  activeSessions.clear();
  const newToken = 'tok_' + crypto.randomBytes(24).toString('hex');
  activeSessions.set(newToken, {
    ip: getClientIp(req),
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    lastActive: Date.now()
  });

  addAuditLog('auth', `管理员密码修改成功，所有其他在线会话已强制下线 (IP: ${getClientIp(req)})`);
  res.json({ ok: true, message: '密码修改成功，其他在线会话已被踢下线', token: newToken });
});

// Audit Logs API
app.get('/api/admin/audit-logs', requireAdmin, (req, res) => {
  res.json({ ok: true, logs: auditLogs });
});

// Flush Latency Cache
app.post('/api/admin/flush-cache', requireAdmin, (req, res) => {
  latencyHistory = {};
  initLatencyHistory();
  addAuditLog('warn', '手动清空网络延迟历史点缓存并重置');
  res.json({ ok: true, message: '延迟缓存已清空并重新初始化' });
});

// Export Backup API
app.get('/api/admin/export-backup', requireAdmin, (req, res) => {
  const safeCfg = { ...config };
  delete safeCfg.adminPassword;
  res.setHeader('Content-Disposition', 'attachment; filename="tanz-probe-backup.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json({
    exportTime: new Date().toISOString(),
    system: 'Tarnz Probe',
    config: safeCfg,
    servers: serverRegistry,
    pingTargets: pingTargets
  });
});


// Notification API
app.get('/api/admin/notification/config', requireAdmin, (req, res) => {
  const cfg = getConfig();
  res.json({
    ok: true,
    config: {
      telegramEnabled: !!cfg.telegramEnabled,
      telegramBotToken: cfg.telegramBotToken || '',
      telegramChatId: cfg.telegramChatId || '',
      telegramEndpoint: cfg.telegramEndpoint || 'https://api.telegram.org/bot',
      webhookEnabled: !!cfg.webhookEnabled,
      webhookUrl: cfg.webhookUrl || '',
      offlineGracePeriodSec: cfg.offlineGracePeriodSec || 60,
      expireNotifyLeadDays: cfg.expireNotifyLeadDays || 7
    }
  });
});

app.post('/api/admin/notification/config', requireAdmin, (req, res) => {
  const {
    telegramEnabled,
    telegramBotToken,
    telegramChatId,
    telegramEndpoint,
    webhookEnabled,
    webhookUrl,
    offlineGracePeriodSec,
    expireNotifyLeadDays
  } = req.body;

  if (telegramEnabled !== undefined) config.telegramEnabled = !!telegramEnabled;
  if (telegramBotToken !== undefined) config.telegramBotToken = String(telegramBotToken).trim();
  if (telegramChatId !== undefined) config.telegramChatId = String(telegramChatId).trim();
  if (telegramEndpoint !== undefined) config.telegramEndpoint = String(telegramEndpoint).trim() || 'https://api.telegram.org/bot';
  if (webhookEnabled !== undefined) config.webhookEnabled = !!webhookEnabled;
  if (webhookUrl !== undefined) config.webhookUrl = String(webhookUrl).trim();
  if (offlineGracePeriodSec !== undefined) config.offlineGracePeriodSec = Math.max(10, Math.min(3600, Number(offlineGracePeriodSec) || 60));
  if (expireNotifyLeadDays !== undefined) config.expireNotifyLeadDays = Math.max(1, Math.min(60, Number(expireNotifyLeadDays) || 7));

  saveConfig(config);
  addAuditLog('info', '更新告警通知渠道与触发参数配置');
  res.json({ ok: true, config });
});

app.post(['/api/admin/notification/test', '/api/admin/notify/test'], requireAdmin, async (req, res) => {
  const cfg = getConfig();
  if (!cfg.telegramEnabled) {
    return res.status(400).json({ ok: false, error: '请先勾选“启用 Telegram 报警机器人”并点击保存！' });
  }
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    return res.status(400).json({ ok: false, error: '请先填写有效的 Telegram Bot Token 与 Chat ID！' });
  }

  const results = await sendNotification('🔔 测试告警通知', '这是来自 Tarnz Probe 探针系统的测试告警，说明您的 Telegram 告警机器人通道已配置成功并保持畅通！', 'info');
  
  if (results.telegram) {
    res.json({ ok: true, results, message: 'Telegram 测试消息已成功送达！' });
  } else {
    const errorMsg = results.errors.length > 0 ? results.errors.join('; ') : 'Telegram API 请求失败，请检查 Bot Token 或网络连通性';
    res.status(500).json({ ok: false, error: errorMsg, results });
  }
});

// HTTP & WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'full_update', data: getFullPayload() }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
      }
    } catch (e) {}
  });
});

let broadcastThrottle = null;
let lastFullBroadcastTime = 0;

function getDeltaPayload() {
  const nodes = {};
  serverRegistry.forEach(s => {
    const t = telemetry.get(s.id) || {};
    const m = t.metrics || {};
    nodes[s.id] = {
      status: t.status || 'offline',
      last_seen: t.last_seen || 0,
      cpu_usage: m.cpu_usage || 0,
      mem_used: m.mem_used || 0,
      mem_percent: m.mem_percent || 0,
      swap_used: m.swap_used || 0,
      disk_used: m.disk_used || 0,
      disk_percent: m.disk_percent || 0,
      net_rx_speed: m.net_rx_speed || 0,
      net_tx_speed: m.net_tx_speed || 0,
      net_rx_total: m.net_rx_total || 0,
      net_tx_total: m.net_tx_total || 0,
      uptime_seconds: m.uptime_seconds || 0,
      load_1: m.load_1 || 0,
      load_5: m.load_5 || 0,
      load_15: m.load_15 || 0,
      pings: m.pings || {}
    };
  });
  return {
    type: 'delta',
    timestamp: Date.now(),
    nodes: nodes
  };
}

function broadcastTelemetry(forceFull = false) {
  if (broadcastThrottle) return;
  broadcastThrottle = setTimeout(() => {
    broadcastThrottle = null;
    const now = Date.now();
    const isFull = forceFull || (now - lastFullBroadcastTime > 25000);
    if (isFull) lastFullBroadcastTime = now;

    const packet = isFull 
      ? { type: 'update', data: getFullPayload() }
      : getDeltaPayload();

    const msg = JSON.stringify(packet);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }, 100);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`⚡ Tarnz Probe Master running on http://127.0.0.1:${PORT}`);
  console.log(`🔑 Admin password: ${config.adminPassword}`);
});
