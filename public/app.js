/**
 * Tarnz Probe - High Performance Frontend Engine (v5.0 Pro)
 * Features:
 * - Pure Minimalist White (极简白)
 * - Strict Zero IP Exposure on Front Page
 * - No Disk Partitions / Storage Metrics
 * - Komari-Inspired Cluster Dashboard Summary
 * - Auto-detected Virtualization Display
 * - Dynamic Geographic Region Filtering
 * - Realtime Latency Matrix & 24h Trend Chart
 * - Zero-GC Optimization for Animation & Metric Updates
 */

// Global Application State
const state = {
  servers: [],
  telemetry: {},
  pingTargets: [],
  pingInterval: 10,
  activeTab: 'servers',
  throughputHistory: {
    rx: new Float32Array(24),
    tx: new Float32Array(24)
  },
  peakRxSpeed: 0,
  peakTxSpeed: 0,
  modalLoadRange: '1h',
  modalLatencyRange: '1h',
  activeRegion: 'all',
  searchQuery: '',
  sortBy: 'default',
  viewMode: 'grid', // 'grid' | 'table'
  chartTarget: null,
  chartRange: '1h',
  ws: null,
  wsConnected: false,
  chartInstance: null,
  modalCpuChart: null,
  modalMemChart: null,
  modalLoadRange: '1h',
  lastMetricsFetchTime: 0,
  selectedServerId: null
};

// ---------------------------------------------------------------------
// Utility & Formatting Helpers
// ---------------------------------------------------------------------

function formatBytes(bytes, decimals = 1) {
  if (!bytes || isNaN(bytes) || bytes <= 0) {
    return decimals > 0 ? `0.${'0'.repeat(decimals)} B` : '0 B';
  }
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))));
  if (i === 0) {
    return Math.round(bytes) + ' B';
  }
  // 固定小数位数，杜绝因有无小数交替引起的文字跳动与位移抖动
  return (bytes / Math.pow(k, i)).toFixed(dm) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec, decimals = 1) {
  if (!bytesPerSec || isNaN(bytesPerSec) || bytesPerSec <= 0 || bytesPerSec < 50) {
    return `0.${'0'.repeat(decimals)} KB/s`;
  }
  const k = 1024;
  if (bytesPerSec < k * k) {
    return (bytesPerSec / k).toFixed(decimals) + ' KB/s';
  }
  if (bytesPerSec < k * k * k) {
    return (bytesPerSec / (k * k)).toFixed(decimals) + ' MB/s';
  }
  return (bytesPerSec / (k * k * k)).toFixed(decimals) + ' GB/s';
}

function getFlagHtml(region, fallbackFlag = '🌐', sizeCls = 'w-6 h-4') {
  const code = (region || '').toLowerCase().trim();
  if (code && code.length === 2) {
    return `<img src="/flags/${code}.svg" alt="${region}" class="${sizeCls} rounded-xs object-cover shadow-2xs border border-slate-200/60 shrink-0 inline-block align-middle select-none" onerror="this.onerror=null; this.outerHTML='<span class=\\'shrink-0 inline-block\\'>${fallbackFlag || '🌐'}</span>';" />`;
  }
  return `<span class="shrink-0 inline-block">${fallbackFlag || '🌐'}</span>`;
}

function formatOsName(os) {
  if (!os) return 'Linux';
  const str = String(os).trim();
  if (/debian/i.test(str)) return 'Debian';
  if (/ubuntu/i.test(str)) return 'Ubuntu';
  if (/istore/i.test(str)) return 'iStoreOS';
  if (/openwrt/i.test(str)) return 'OpenWrt';
  if (/centos/i.test(str)) return 'CentOS';
  if (/alpine/i.test(str)) return 'Alpine';
  if (/rocky/i.test(str)) return 'Rocky';
  if (/alma/i.test(str)) return 'Alma';
  if (/windows/i.test(str)) return 'Windows';
  return str.split(/[\s/]/)[0] || 'Linux';
}

function formatLocation(loc) {
  if (!loc) return '全球';
  return String(loc).replace(/^(欧洲|亚洲|北美|南美|非洲|大洋洲)\s*·\s*/, '').trim();
}

function getOsIcon(os) {
  const str = String(os || '').toLowerCase();
  if (str.includes('debian')) {
    return '<span class="text-rose-500 font-bold text-xs leading-none">🍥</span>';
  }
  if (str.includes('ubuntu')) {
    return '<span class="text-orange-500 font-bold text-xs leading-none">🟠</span>';
  }
  if (str.includes('istore') || str.includes('openwrt')) {
    return '<span class="text-blue-500 font-bold text-xs leading-none">⚡</span>';
  }
  if (str.includes('alpine')) {
    return '<span class="text-cyan-500 font-bold text-xs leading-none">🏔️</span>';
  }
  if (str.includes('centos') || str.includes('rhel') || str.includes('rocky') || str.includes('alma')) {
    return '<span class="text-emerald-500 font-bold text-xs leading-none">💠</span>';
  }
  return '<i data-lucide="cpu" class="w-3 h-3 text-slate-400"></i>';
}

function formatUptime(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '刚刚启动';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 时 ${minutes} 分`;
  if (hours > 0) return `${hours} 时 ${minutes} 分`;
  return `${minutes} 分钟`;
}
// ---------------------------------------------------------------------
// 60FPS High-Performance Animated Counter (Zero-GC Optimization)
// ---------------------------------------------------------------------
const activeAnimations = new WeakMap();

function animateNumber(element, targetValue, options = {}) {
  if (!element || targetValue === undefined || targetValue === null || isNaN(targetValue)) return;
  const {
    duration = 600,
    decimals = 0,
    prefix = '',
    suffix = '',
    formatter = null
  } = options;

  const currentVal = element.__animValue !== undefined ? element.__animValue : targetValue;
  if (Math.abs(currentVal - targetValue) < 0.001) {
    element.__animValue = targetValue;
    element.innerText = formatter ? formatter(targetValue) : `${prefix}${targetValue.toFixed(decimals)}${suffix}`;
    return;
  }

  if (activeAnimations.has(element)) {
    cancelAnimationFrame(activeAnimations.get(element));
  }

  const startTime = performance.now();
  const startVal = currentVal;
  const change = targetValue - startVal;

  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    // easeOutCubic
    const ease = 1 - Math.pow(1 - progress, 3);
    const value = startVal + change * ease;
    element.__animValue = value;
    element.innerText = formatter ? formatter(value) : `${prefix}${value.toFixed(decimals)}${suffix}`;

    if (progress < 1) {
      const id = requestAnimationFrame(update);
      activeAnimations.set(element, id);
    } else {
      element.__animValue = targetValue;
      element.innerText = formatter ? formatter(targetValue) : `${prefix}${targetValue.toFixed(decimals)}${suffix}`;
      activeAnimations.delete(element);
    }
  }

  const animId = requestAnimationFrame(update);
  activeAnimations.set(element, animId);
}


function formatVirtBadge(virt) {
  if (!virt) return '<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-50 text-indigo-700 border border-indigo-200 font-semibold">KVM</span>';
  const v = virt.toUpperCase();
  if (v === 'KVM' || v === 'QEMU') {
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-50 text-indigo-700 border border-indigo-200 font-semibold">KVM</span>`;
  }
  if (v === 'OPENVZ' || v === 'OVZ') {
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-50 text-amber-700 border border-amber-200 font-semibold">OpenVZ</span>`;
  }
  if (v === 'LXC') {
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-cyan-50 text-cyan-700 border border-cyan-200 font-semibold">LXC</span>`;
  }
  if (v === 'DOCKER') {
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-50 text-blue-700 border border-blue-200 font-semibold">Docker</span>`;
  }
  if (v === 'BARE METAL' || v === 'PHYSICAL' || v === 'NONE') {
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">物理机</span>`;
  }
  if (v === 'ARM64' || v === 'AARCH64') {
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-50 text-purple-700 border border-purple-200 font-semibold">ARM64</span>`;
  }
  return `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-100 text-slate-700 border border-slate-200 font-semibold">${virt}</span>`;
}

function getBillingBadge(s) {
  if (!s.expiredAt) {
    return '<span class="text-[10px] text-slate-400 font-mono">长期有效</span>';
  }
  const exp = new Date(s.expiredAt).getTime();
  const now = Date.now();
  const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200 font-mono">已过期</span>`;
  }
  if (diffDays <= 7) {
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200 font-mono">剩余 ${diffDays} 天</span>`;
  }
  if (diffDays <= 30) {
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 font-mono">剩余 ${diffDays} 天</span>`;
  }
  return `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono">剩余 ${diffDays} 天</span>`;
}

function formatCycle(c) {
  const map = {
    monthly: '月付',
    quarterly: '季付',
    semiannual: '半年付',
    annual: '年付',
    biennial: '两年付',
    triennial: '三年付',
    onetime: '一次性',
    free: '免费'
  };
  return map[c] || c || '周期未设';
}

function getProgressColor(percent) {
  if (percent > 90) return 'from-rose-500 to-red-600';
  if (percent > 75) return 'from-amber-500 to-orange-500';
  return 'from-indigo-500 to-indigo-600';
}

function getLatencyBadge(ms) {
  if (ms === undefined || ms === null || ms < 0) {
    return '<span class="text-slate-400 font-mono text-[11px]">-</span>';
  }
  const val = Math.round(ms);
  if (val < 50) {
    return `<span class="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">${val}ms</span>`;
  }
  if (val < 120) {
    return `<span class="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-cyan-50 text-cyan-700 border border-cyan-200">${val}ms</span>`;
  }
  if (val < 220) {
    return `<span class="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-amber-50 text-amber-700 border border-amber-200">${val}ms</span>`;
  }
  return `<span class="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold bg-rose-50 text-rose-700 border border-rose-200">${val}ms</span>`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  const bg = type === 'error' ? 'bg-rose-600 text-white' : type === 'success' ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-white';
  toast.className = `px-4 py-2.5 rounded-xl shadow-lg text-xs font-semibold flex items-center space-x-2 transition-all transform duration-300 opacity-0 translate-y-2 ${bg}`;
  toast.innerHTML = `<span>${type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️'}</span><span>${message}</span>`;

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('opacity-0', 'translate-y-2');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ---------------------------------------------------------------------
// Tab Switching & Navigation
// ---------------------------------------------------------------------

function switchMainTab(tab) {
  state.activeTab = tab;
  const tabServersBtn = document.getElementById('tabServersBtn');
  const tabLatencyBtn = document.getElementById('tabLatencyBtn');
  const sectionOverview = document.getElementById('sectionOverview');
  const sectionLatency = document.getElementById('sectionLatency');

  const activeCls = 'px-3.5 py-1.5 sm:px-4 sm:py-2 rounded-lg sm:rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 bg-indigo-600 text-white shadow-xs cursor-pointer';
  const inactiveCls = 'px-3.5 py-1.5 sm:px-4 sm:py-2 rounded-lg sm:rounded-xl text-xs font-semibold text-slate-600 hover:text-indigo-600 hover:bg-slate-200/60 sm:hover:bg-slate-100 transition-all flex items-center justify-center space-x-1.5 cursor-pointer';

  if (tab === 'latency') {
    if (tabServersBtn) tabServersBtn.className = inactiveCls;
    if (tabLatencyBtn) tabLatencyBtn.className = activeCls;
    if (sectionOverview) sectionOverview.classList.add('hidden');
    if (sectionLatency) sectionLatency.classList.remove('hidden');
    renderLatencyMatrix();
    loadLatencyChart();
  } else {
    // Default: 'servers'
    state.activeTab = 'servers';
    if (tabServersBtn) tabServersBtn.className = activeCls;
    if (tabLatencyBtn) tabLatencyBtn.className = inactiveCls;
    if (sectionOverview) sectionOverview.classList.remove('hidden');
    if (sectionLatency) sectionLatency.classList.add('hidden');
  }
  if (window.lucide) lucide.createIcons();
}

// ---------------------------------------------------------------------
// WebSocket & Realtime Status Fallback
// ---------------------------------------------------------------------

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    state.wsConnected = true;
    updateWsStatus(true);
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleDataUpdate(data);
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  };

  state.ws.onclose = () => {
    state.wsConnected = false;
    updateWsStatus(false);
    setTimeout(initWebSocket, 3000);
  };

  state.ws.onerror = () => {
    state.wsConnected = false;
    updateWsStatus(false);
  };
}

function updateWsStatus(connected) {
  const statusPill = document.getElementById('connectionStatus');
  const textSpan = document.getElementById('wsStatusText');
  if (!statusPill || !textSpan) return;

  if (connected) {
    statusPill.className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 border border-emerald-200 text-emerald-700 shadow-2xs';
    textSpan.innerText = '实时';
  } else {
    statusPill.className = 'flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 border border-amber-200 text-amber-700 shadow-2xs';
    textSpan.innerText = '轮询';
  }
}

async function fetchStatusFallback() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();
    handleDataUpdate(data);
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

function handleDataUpdate(raw) {
  if (!raw) return;

  // ⚡ Zero-GC Delta Streaming Fast Path
  if (raw.type === 'delta' && raw.nodes) {
    if (!state.telemetry) state.telemetry = {};
    const nodes = raw.nodes;
    for (const id in nodes) {
      if (!state.telemetry[id]) {
        state.telemetry[id] = { status: 'offline', info: {}, metrics: {} };
      }
      const t = state.telemetry[id];
      const d = nodes[id];
      t.status = d.status || t.status;
      t.last_seen = d.last_seen || t.last_seen;
      if (!t.metrics) t.metrics = {};
      Object.assign(t.metrics, d);
    }
    updateKomariDashboard();
    renderServers();
    if (state.activeTab === 'latency') renderLatencyMatrix();
    if (state.selectedServerId) updateServerDetailContent(state.selectedServerId);
    return;
  }

  // Unwrap WebSocket packet if needed: { type: 'update', data: {...} }
  const data = (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) ? raw.data : raw;


    if (data.global) {
    state.global = data.global;
    if (data.global.historicalPeak) {
      if (!state.historicalPeak) state.historicalPeak = { rx: 0, tx: 0, combined: 0, formattedDate: '' };
      const srvHp = data.global.historicalPeak;
      if ((srvHp.rx || 0) > (state.historicalPeak.rx || 0)) state.historicalPeak.rx = srvHp.rx;
      if ((srvHp.tx || 0) > (state.historicalPeak.tx || 0)) state.historicalPeak.tx = srvHp.tx;
      if ((srvHp.combined || 0) > (state.historicalPeak.combined || 0)) state.historicalPeak.combined = srvHp.combined;
      if (srvHp.formattedDate) state.historicalPeak.formattedDate = srvHp.formattedDate;
    }
  }
  if (data.services) state.services = data.services;
  if (data.ssl) state.ssl = data.ssl;

  if (data.servers && Array.isArray(data.servers)) {
    state.servers = data.servers;
    // Always sync state.telemetry map from servers array
    if (!state.telemetry) state.telemetry = {};
    data.servers.forEach(s => {
      state.telemetry[s.id] = {
        status: s.status || 'offline',
        last_seen: s.last_seen || 0,
        info: s.info || {},
        metrics: s.metrics || {},
        history: s.history || []
      };
    });
  }
  if (data.telemetry && typeof data.telemetry === 'object') {
    state.telemetry = { ...state.telemetry, ...data.telemetry };
  }
  if (data.pingTargets) state.pingTargets = data.pingTargets;
  if (data.pingIntervalSec) state.pingInterval = data.pingIntervalSec;
  if (data.pingInterval) state.pingInterval = data.pingInterval;

  updateKomariDashboard();
  renderRegionFilters();
  renderServers();

  if (state.activeTab === 'latency') {
    renderLatencyMatrix();
  }

  // Update detail modal if open
  if (state.selectedServerId) {
    updateServerDetailContent(state.selectedServerId);
  }
}

// ---------------------------------------------------------------------
// Komari-Inspired Cluster Dashboard Summary
// ---------------------------------------------------------------------

// Helper to extract carrier branding and crisp SVG icons for speedtest targets
function getTargetCarrierMeta(tgt) {
  const name = (tgt.name || '').toLowerCase();
  const carrier = (tgt.carrier || '').toLowerCase();
  const host = (tgt.host || '').toLowerCase();
  const group = (tgt.group || '').toLowerCase();

  if (carrier === 'telecom' || name.includes('电信') || name.includes('ct') || host.includes('-ct-')) {
    return {
      type: 'telecom',
      brand: '中国电信',
      shortBrand: '电信',
      color: 'sky',
      iconSvg: '<svg class="w-4 h-4 text-sky-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg>',
      badgeCls: 'bg-sky-50 text-sky-700 border-sky-200/80',
      tagCls: 'bg-sky-100/80 text-sky-700'
    };
  } else if (carrier === 'unicom' || name.includes('联通') || name.includes('cu') || host.includes('-cu-')) {
    return {
      type: 'unicom',
      brand: '中国联通',
      shortBrand: '联通',
      color: 'amber',
      iconSvg: '<svg class="w-4 h-4 text-amber-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
      badgeCls: 'bg-amber-50 text-amber-700 border-amber-200/80',
      tagCls: 'bg-amber-100/90 text-amber-800 border border-amber-200/60'
    };
  } else if (carrier === 'mobile' || name.includes('移动') || name.includes('cm') || host.includes('-cm-')) {
    return {
      type: 'mobile',
      brand: '中国移动',
      shortBrand: '移动',
      color: 'emerald',
      iconSvg: '<svg class="w-4 h-4 text-emerald-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>',
      badgeCls: 'bg-emerald-50 text-emerald-700 border-emerald-200/80',
      tagCls: 'bg-emerald-100/80 text-emerald-700'
    };
  } else {
    return {
      type: 'bgp',
      brand: 'BGP 国际',
      shortBrand: 'BGP',
      color: 'indigo',
      iconSvg: '<svg class="w-4 h-4 text-indigo-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
      badgeCls: 'bg-indigo-50 text-indigo-700 border-indigo-200/80',
      tagCls: 'bg-indigo-100/80 text-indigo-700'
    };
  }
}




function initThroughputHistoryFromServers(servers) {
  if (!state.throughputHistory) {
    state.throughputHistory = { rx: new Float32Array(24), tx: new Float32Array(24), initialized: false };
  }
  if (state.throughputHistory.initialized) return;

  const validServers = (servers || []).filter(s => Array.isArray(s.history) && s.history.length > 0);
  if (validServers.length === 0) return;

  // Find minimum length across servers or average length
  let histLen = validServers[0].history.length;
  for (let i = 1; i < validServers.length; i++) {
    if (validServers[i].history.length < histLen) histLen = validServers[i].history.length;
  }

  if (histLen > 0) {
    const points = Math.min(24, histLen);
    for (let p = 0; p < points; p++) {
      let sumRx = 0;
      let sumTx = 0;
      for (const s of validServers) {
        const item = s.history[s.history.length - points + p];
        if (item) {
          sumRx += (item.rx_speed || 0);
          sumTx += (item.tx_speed || 0);
        }
      }
      const targetIdx = 24 - points + p;
      state.throughputHistory.rx[targetIdx] = sumRx;
      state.throughputHistory.tx[targetIdx] = sumTx;
    }
    // Pad any remaining leading points with the earliest value to prevent cliff jump from 0
    const firstRx = state.throughputHistory.rx[24 - points];
    const firstTx = state.throughputHistory.tx[24 - points];
    for (let p = 0; p < 24 - points; p++) {
      state.throughputHistory.rx[p] = firstRx;
      state.throughputHistory.tx[p] = firstTx;
    }
    state.throughputHistory.initialized = true;
  }
}

function renderThroughputSparkline() {
  const canvas = document.getElementById('kpiThroughputSparkline');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 180;
  const height = canvas.clientHeight || 40;

  const targetW = Math.round(width * dpr);
  const targetH = Math.round(height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const hist = state.throughputHistory;
  if (!hist || !hist.rx || hist.rx.length === 0) {
    ctx.restore();
    return;
  }

  const len = hist.rx.length;
  let maxVal = 1024 * 10;
  for (let i = 0; i < len; i++) {
    if (hist.rx[i] > maxVal) maxVal = hist.rx[i];
    if (hist.tx[i] > maxVal) maxVal = hist.tx[i];
  }

  const stepX = width / (len - 1);
  const bottom = height - 2;

  // 1. Draw Tx (Download / Cyan line)
  ctx.beginPath();
  for (let i = 0; i < len; i++) {
    const x = i * stepX;
    const y = bottom - (hist.tx[i] / maxVal) * (height - 6);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 2. Draw Rx (Upload / Emerald line)
  ctx.beginPath();
  for (let i = 0; i < len; i++) {
    const x = i * stepX;
    const y = bottom - (hist.rx[i] / maxVal) * (height - 6);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.restore();
}

function toggleExpirySort() {
  if (state.sortBy === 'expired_asc') {
    state.sortBy = 'expired_desc';
  } else {
    state.sortBy = 'expired_asc';
  }
  const sortSelect = document.getElementById('sortBy');
  if (sortSelect) {
    sortSelect.value = state.sortBy;
  }
  const sortLabel = document.getElementById('expirySortLabel');
  if (sortLabel) {
    sortLabel.innerText = state.sortBy === 'expired_asc' ? '到期最近 (升序)' : '到期最远 (倒序)';
  }
  renderServers();
}
window.toggleExpirySort = toggleExpirySort;

function updateKomariDashboard() {
  const servers = state.servers || [];
  initThroughputHistoryFromServers(servers);
  const telemetry = state.telemetry || {};

  let totalNodes = servers.length;
  let onlineNodes = 0;
  let totalCores = 0;
  let totalMemBytes = 0;
  let usedMemBytes = 0;
  let totalCpuUsage = 0;
  let totalRxSpeed = 0;
  let totalTxSpeed = 0;
  let totalRxBytes = 0;
  let totalTxBytes = 0;

  // Track closest expiring server
  let closestExpiring = null;
  let minDaysLeft = Infinity;
  const now = Date.now();

  servers.forEach(s => {
    const t = (state.telemetry && state.telemetry[s.id]) || {};
    const isOnline = (s.status === 'online') || (t.status === 'online');
    const inf = (s.info && Object.keys(s.info).length > 0) ? s.info : (t.info || {});
    const m = (s.metrics && Object.keys(s.metrics).length > 0) ? s.metrics : (t.metrics || {});

    const cores = inf.cpu_cores || s.cores || 1;
    totalCores += cores;

    const memTotal = inf.mem_total || (s.memoryGB ? s.memoryGB * 1024 * 1024 * 1024 : 0);
    totalMemBytes += memTotal;

    if (isOnline) {
      onlineNodes++;
      totalCpuUsage += (m.cpu_usage || 0);
      usedMemBytes += (m.mem_used || 0);
      totalRxSpeed += (m.net_rx_speed || 0);
      totalTxSpeed += (m.net_tx_speed || 0);
      totalRxBytes += (m.net_rx_total || 0);
      totalTxBytes += (m.net_tx_total || 0);
    }

    if (s.expiredAt) {
      const expTime = new Date(s.expiredAt).getTime();
      const daysLeft = Math.ceil((expTime - now) / 86400000);
      if (daysLeft >= 0 && daysLeft < minDaysLeft) {
        minDaysLeft = daysLeft;
        closestExpiring = { server: s, daysLeft };
      }
    }
  });

  // 1. Health Status Card
  const healthDesc = document.getElementById('kpiHealthDesc');
  const onlineCount = document.getElementById('kpiOnlineNodes');
  const nodePercent = document.getElementById('kpiNodePercent');
  const greeting = document.getElementById('kpiGreeting');

  const onlineRatio = totalNodes > 0 ? (onlineNodes / totalNodes) : 0;
  const onlinePct = Math.round(onlineRatio * 100);

    const mapLitCount = document.getElementById('mapLitCount');
  if (mapLitCount) {
    mapLitCount.innerText = `${onlineNodes} 节点已点亮`;
  }

  if (onlineCount) {
    animateNumber(onlineCount, onlineNodes, {
      duration: 500,
      formatter: (v) => window.innerWidth < 640 ? `在线 ${Math.round(v)}/${totalNodes}` : `在线 ${Math.round(v)} / ${totalNodes} 台`
    });
  }
  if (nodePercent) {
    animateNumber(nodePercent, onlinePct, {
      duration: 500,
      formatter: (v) => `${Math.round(v)}% 在线`
    });
    if (onlinePct === 100) {
      nodePercent.className = 'font-mono font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200';
    } else if (onlinePct >= 75) {
      nodePercent.className = 'font-mono font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200';
    } else {
      nodePercent.className = 'font-mono font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full border border-rose-200';
    }
  }

  if (healthDesc) {
    if (totalNodes === 0) {
      healthDesc.innerHTML = '<span class="inline-block w-2.5 h-2.5 rounded-full bg-slate-400 mr-2"></span><span>尚未接入服务器节点</span>';
    } else if (onlineNodes === totalNodes) {
      healthDesc.innerHTML = '<span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 mr-2"></span><span>所有服务器均在线，状态良好</span>';
    } else if (onlineNodes > 0) {
      healthDesc.innerHTML = `<span class="inline-block w-2.5 h-2.5 rounded-full bg-amber-500 mr-2"></span><span>离线 ${totalNodes - onlineNodes} 台，请注意检查</span>`;
    } else {
      healthDesc.innerHTML = '<span class="inline-block w-2.5 h-2.5 rounded-full bg-rose-500 mr-2"></span><span>所有服务器已离线，集群异常</span>';
    }
  }

  if (greeting) {
    greeting.innerText = '愿每一台服务器都稳定运行，一切尽在掌握';
  }

  // Node array micro dots in Card 1
  const dotsContainer = document.getElementById('kpiClusterNodeDots');
  if (dotsContainer) {
    dotsContainer.innerHTML = (state.servers || []).map(s => {
      const t = (state.telemetry && state.telemetry[s.id]) || {};
      const isOnline = (s.status === 'online') || (t.status === 'online');
      const dotCls = isOnline ? 'bg-emerald-500 shadow-emerald-500/50' : 'bg-slate-300';
      return `<span onclick="openServerDetail('${s.id}')" class="inline-block w-2.5 h-2.5 rounded-full ${dotCls} cursor-pointer transition-all hover:scale-125 hover:ring-2 hover:ring-indigo-400" title="${s.name} (${isOnline ? '在线' : '离线'})"></span>`;
    }).join('');
  }

  // 2. Realtime Throughput Card - EMA Smooth Filter to prevent frenzy oscillation
  const rxSpeedEl = document.getElementById('kpiNetRxSpeed');
  const txSpeedEl = document.getElementById('kpiNetTxSpeed');
  const totalTrafficEl = document.getElementById('kpiTotalTraffic');

  // Low-pass Exponential Moving Average (EMA) smoothing to dampen network burstiness
  const alpha = 0.25;
  if (state.smoothRxSpeed === undefined || isNaN(state.smoothRxSpeed)) {
    state.smoothRxSpeed = totalRxSpeed;
    state.smoothTxSpeed = totalTxSpeed;
  } else {
    state.smoothRxSpeed = state.smoothRxSpeed * (1 - alpha) + totalRxSpeed * alpha;
    state.smoothTxSpeed = state.smoothTxSpeed * (1 - alpha) + totalTxSpeed * alpha;
  }

  // Throttle DOM text updates to 1000ms cadence to eliminate erratic flickering & shaking
  const perfNow = performance.now();
  if (!state.lastSpeedDomUpdate || (perfNow - state.lastSpeedDomUpdate >= 1000)) {
    state.lastSpeedDomUpdate = perfNow;
    if (rxSpeedEl) rxSpeedEl.innerText = formatSpeed(state.smoothRxSpeed);
    if (txSpeedEl) txSpeedEl.innerText = formatSpeed(state.smoothTxSpeed);
  }
  if (totalTrafficEl) totalTrafficEl.innerText = `↓ ${formatBytes(totalRxBytes)} / ↑ ${formatBytes(totalTxBytes)}`;

  // Record into rolling throughput history buffer (Zero-GC preallocated array)
  if (!state.throughputHistory) {
    state.throughputHistory = { rx: new Float32Array(24), tx: new Float32Array(24) };
  }
  const th = state.throughputHistory;
  for (let i = 0; i < th.rx.length - 1; i++) {
    th.rx[i] = th.rx[i + 1];
    th.tx[i] = th.tx[i + 1];
  }
  th.rx[th.rx.length - 1] = state.smoothRxSpeed || 0;
  th.tx[th.tx.length - 1] = state.smoothTxSpeed || 0;

    if ((state.smoothRxSpeed || 0) > (state.peakRxSpeed || 0)) state.peakRxSpeed = state.smoothRxSpeed;
  if ((state.smoothTxSpeed || 0) > (state.peakTxSpeed || 0)) state.peakTxSpeed = state.smoothTxSpeed;

  // Track Historical All-time Peak (Server synchronized & LocalStorage persistent)
  if (!state.historicalPeak) {
    try {
      const cached = localStorage.getItem('tanz_historical_peak');
      state.historicalPeak = cached ? JSON.parse(cached) : { rx: 0, tx: 0, combined: 0, formattedDate: '' };
    } catch (e) {
      state.historicalPeak = { rx: 0, tx: 0, combined: 0, formattedDate: '' };
    }
  }

  let hpUpdated = false;
  const currRx = state.smoothRxSpeed || 0;
  const currTx = state.smoothTxSpeed || 0;
  if (currRx > (state.historicalPeak.rx || 0)) {
    state.historicalPeak.rx = currRx;
    hpUpdated = true;
  }
  if (currTx > (state.historicalPeak.tx || 0)) {
    state.historicalPeak.tx = currTx;
    hpUpdated = true;
  }
  const currCombined = currRx + currTx;
  if (currCombined > (state.historicalPeak.combined || 0)) {
    state.historicalPeak.combined = currCombined;
    hpUpdated = true;
  }
  if (hpUpdated) {
    const d = new Date();
    state.historicalPeak.formattedDate = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    try {
      localStorage.setItem('tanz_historical_peak', JSON.stringify(state.historicalPeak));
    } catch (e) {}
  }

  renderThroughputSparkline();

  const isMobile = window.innerWidth < 640;
  const peakEl = document.getElementById('kpiNetPeakSpeed');
  if (peakEl) {
    if (isMobile) {
      const maxPeak = Math.max(state.peakRxSpeed || 0, state.peakTxSpeed || 0);
      peakEl.innerText = `本次峰值: ${formatSpeed(maxPeak)}`;
    } else {
      peakEl.innerText = `本次峰值: ↓ ${formatSpeed(state.peakRxSpeed || 0)} · ↑ ${formatSpeed(state.peakTxSpeed || 0)}`;
    }
  }

  const histPeakEl = document.getElementById('kpiNetHistoricalPeak');
  const histPeakValEl = document.getElementById('kpiNetHistoricalPeakVal');
  const histPeakTimeEl = document.getElementById('kpiNetHistoricalPeakTime');
  if (histPeakValEl) {
    if (isMobile) {
      const maxHist = Math.max(state.historicalPeak.rx || 0, state.historicalPeak.tx || 0);
      histPeakValEl.innerText = formatSpeed(maxHist);
    } else {
      histPeakValEl.innerText = `↓ ${formatSpeed(state.historicalPeak.rx || 0)} · ↑ ${formatSpeed(state.historicalPeak.tx || 0)}`;
    }
  } else if (histPeakEl) {
    if (isMobile) {
      const maxHist = Math.max(state.historicalPeak.rx || 0, state.historicalPeak.tx || 0);
      histPeakEl.innerText = `历史峰值: ${formatSpeed(maxHist)}`;
    } else {
      histPeakEl.innerText = `历史峰值: ↓ ${formatSpeed(state.historicalPeak.rx || 0)} · ↑ ${formatSpeed(state.historicalPeak.tx || 0)}`;
    }
  }
  if (histPeakTimeEl) {
    histPeakTimeEl.innerText = state.historicalPeak.formattedDate || '全网纪录';
  }

const activeNetNodesEl = document.getElementById('kpiActiveNetNodes');
  if (activeNetNodesEl) {
    let activeCount = 0;
    for (const s of (state.servers || [])) {
      const m = state.telemetry[s.id]?.metrics;
      if (m && ((m.net_rx_speed || 0) > 100 || (m.net_tx_speed || 0) > 100)) {
        activeCount++;
      }
    }
    const count = activeCount || totalNodes;
    activeNetNodesEl.innerText = isMobile ? `${count} 活跃` : `${count} 节点活跃`;
  }

  // 3. Compute Load & Scale Card
  const avgCpuEl = document.getElementById('kpiAvgCpu');
  const cpuBar = document.getElementById('kpiCpuBar');
  const totalCoresEl = document.getElementById('kpiTotalCores');
  const memPercentEl = document.getElementById('kpiMemPercent');

  const avgCpu = onlineNodes > 0 ? (totalCpuUsage / onlineNodes).toFixed(1) : '0.0';
  if (avgCpuEl) {
    animateNumber(avgCpuEl, Number(avgCpu), {
      duration: 500,
      decimals: 1,
      suffix: '%'
    });
  }
  if (cpuBar) cpuBar.style.width = `${Math.min(100, Math.max(0, Number(avgCpu)))}%`;
  if (totalCoresEl) {
    animateNumber(totalCoresEl, totalCores, {
      duration: 500,
      formatter: (v) => `${Math.round(v)} vCPU 核心`
    });
  }

  const memPct = totalMemBytes > 0 ? Math.round((usedMemBytes / totalMemBytes) * 100) : 0;
  if (memPercentEl) {
    animateNumber(memPercentEl, memPct, {
      duration: 500,
      formatter: (v) => window.innerWidth < 640 ? `${Math.round(v)}% (${formatBytes(usedMemBytes, 0)})` : `${Math.round(v)}% (${formatBytes(usedMemBytes, 1)} / ${formatBytes(totalMemBytes, 1)})`
    });
  }

  // 4. Node Expiry & Renewal Tracker Card
  const heroDaysNum = document.getElementById('kpiExpiryDaysHeroNum');
  const heroDaysUnit = document.getElementById('kpiExpiryDaysHeroUnit');
  const statusTag = document.getElementById('kpiExpiryStatusTag');
  const serverNameEl = document.getElementById('kpiExpiringServerName');
  const dateEl = document.getElementById('kpiExpiringDate');
  const totalServersEl = document.getElementById('kpiTotalServersCount');
  const dotEl = document.getElementById('kpiExpiryDot');
  const healthDescEl = document.getElementById('kpiExpiryHealthDesc');
  const badgeIcon = document.getElementById('kpiExpiryBadgeIcon');

  if (totalServersEl) totalServersEl.innerText = `${totalNodes} 台 VPS 监控中`;

  // Render Top Upcoming Expiry List in Card 4
  const upcomingListEl = document.getElementById('kpiExpiryUpcomingList');
  if (upcomingListEl) {
    const expiringServers = (state.servers || [])
      .filter(s => s.expiredAt)
      .map(s => {
        const expTime = new Date(s.expiredAt).getTime();
        const daysLeft = Math.ceil((expTime - now) / 86400000);
        return { server: s, daysLeft, expTime };
      })
      .filter(item => !isNaN(item.daysLeft))
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 3);

    if (expiringServers.length > 0) {
      upcomingListEl.innerHTML = expiringServers.map(item => {
        const s = item.server;
        const d = item.daysLeft;
        let badgeCls = 'bg-emerald-50 text-emerald-700 border border-emerald-200';
        if (d <= 7) badgeCls = 'bg-rose-50 text-rose-700 border border-rose-200 animate-pulse';
        else if (d <= 30) badgeCls = 'bg-amber-50 text-amber-700 border border-amber-200';
        else if (d <= 90) badgeCls = 'bg-sky-50 text-sky-700 border border-sky-200';

        return `
          <div onclick="openServerDetail('${s.id}')" class="flex items-center justify-between p-1 px-1.5 rounded-lg bg-slate-50 hover:bg-indigo-50/70 border border-slate-100 hover:border-indigo-200 cursor-pointer text-[10.5px] transition-all group" title="点击查看此服务器详情">
            <span class="truncate font-medium text-slate-700 group-hover:text-indigo-600 flex items-center space-x-1.5 min-w-0">
              ${getFlagHtml(s.region, s.flag, 'w-3.5 h-2.5')}
              <span class="truncate">${s.name}</span>
            </span>
            <div class="flex items-center space-x-1 font-mono shrink-0 ml-1">
              <span class="text-slate-400 text-[10px] hidden sm:inline">${s.expiredAt.slice(0, 10)}</span>
              <span class="px-1.5 py-0.2 rounded text-[10px] font-bold ${badgeCls}">剩 ${d}天</span>
            </div>
          </div>
        `;
      }).join('');
    } else {
      upcomingListEl.innerHTML = `
        <div class="text-[10px] text-slate-400 italic py-1 text-center bg-slate-50 rounded-lg border border-slate-100">
          长期租约 · 无近期到期节点
        </div>
      `;
    }
  }

  // Update expirySortLabel
  const sortLabel = document.getElementById('expirySortLabel');
  if (sortLabel) {
    if (state.sortBy === 'expired_asc') sortLabel.innerText = '到期最近 (升序)';
    else if (state.sortBy === 'expired_desc') sortLabel.innerText = '到期最远 (倒序)';
    else sortLabel.innerText = '按到期排序';
  }

  if (closestExpiring) {
    const s = closestExpiring.server;
    const d = closestExpiring.daysLeft;

    if (heroDaysNum) {
      animateNumber(heroDaysNum, d, {
        duration: 500,
        formatter: (v) => `${Math.round(v)}`
      });
    }
    if (heroDaysUnit) heroDaysUnit.innerText = '天后到期';

    if (serverNameEl) {
      serverNameEl.innerHTML = `${getFlagHtml(s.region, s.flag, 'w-4.5 h-3')} <span>${s.name}</span>`;
      serverNameEl.title = `${s.name} (${s.location || s.region || ''}) 到期日: ${s.expiredAt}`;
    }
    if (dateEl) {
      dateEl.innerText = `(${s.expiredAt} 到期)`;
    }

    // Color-code by urgency
    if (d > 60) {
      if (statusTag) {
        statusTag.innerText = '租期充裕';
        statusTag.className = 'text-[10px] sm:text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0';
      }
      if (dotEl) dotEl.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
      if (healthDescEl) {
        healthDescEl.innerText = '全网无临期风险';
        healthDescEl.className = 'text-emerald-600 font-semibold text-[10px] sm:text-[11px]';
      }
      if (badgeIcon) badgeIcon.className = 'p-1 sm:p-2 rounded-lg sm:rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100';
    } else if (d > 30) {
      if (statusTag) {
        statusTag.innerText = '正常计费';
        statusTag.className = 'text-[10px] sm:text-[11px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 shrink-0';
      }
      if (dotEl) dotEl.className = 'w-1.5 h-1.5 rounded-full bg-blue-500';
      if (healthDescEl) {
        healthDescEl.innerText = '剩余 1~2 个月';
        healthDescEl.className = 'text-blue-600 font-semibold text-[10px] sm:text-[11px]';
      }
      if (badgeIcon) badgeIcon.className = 'p-1 sm:p-2 rounded-lg sm:rounded-xl bg-blue-50 text-blue-600 border border-blue-100';
    } else if (d > 7) {
      if (statusTag) {
        statusTag.innerText = '即将临期';
        statusTag.className = 'text-[10px] sm:text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 shrink-0';
      }
      if (dotEl) dotEl.className = 'w-1.5 h-1.5 rounded-full bg-amber-500';
      if (healthDescEl) {
        healthDescEl.innerText = `注意续费 (剩 ${d} 天)`;
        healthDescEl.className = 'text-amber-600 font-semibold text-[10px] sm:text-[11px]';
      }
      if (badgeIcon) badgeIcon.className = 'p-1 sm:p-2 rounded-lg sm:rounded-xl bg-amber-50 text-amber-600 border border-amber-100';
    } else if (d >= 0) {
      if (statusTag) {
        statusTag.innerText = '急需续费';
        statusTag.className = 'text-[10px] sm:text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 shrink-0 animate-pulse';
      }
      if (dotEl) dotEl.className = 'w-1.5 h-1.5 rounded-full bg-rose-500';
      if (healthDescEl) {
        healthDescEl.innerText = `即将停机 (仅剩 ${d} 天)`;
        healthDescEl.className = 'text-rose-600 font-semibold text-[10px] sm:text-[11px]';
      }
      if (badgeIcon) badgeIcon.className = 'p-1 sm:p-2 rounded-lg sm:rounded-xl bg-rose-50 text-rose-600 border border-rose-100';
    } else {
      if (statusTag) {
        statusTag.innerText = '已到期';
        statusTag.className = 'text-[10px] sm:text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-300 shrink-0';
      }
      if (dotEl) dotEl.className = 'w-1.5 h-1.5 rounded-full bg-rose-600';
      if (healthDescEl) {
        healthDescEl.innerText = '已逾期停机';
        healthDescEl.className = 'text-rose-700 font-bold text-[10px] sm:text-[11px]';
      }
      if (badgeIcon) badgeIcon.className = 'p-1 sm:p-2 rounded-lg sm:rounded-xl bg-rose-100 text-rose-700 border border-rose-200';
    }
  } else {
    if (heroDaysNum) heroDaysNum.innerText = '长期有效';
    if (heroDaysUnit) heroDaysUnit.innerText = '';
    if (statusTag) {
      statusTag.innerText = '无需续费';
      statusTag.className = 'text-[10px] sm:text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 shrink-0';
    }
    if (serverNameEl) serverNameEl.innerText = '全部节点处于长期租期';
    if (dateEl) dateEl.innerText = '';
    if (dotEl) dotEl.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
    if (healthDescEl) {
      healthDescEl.innerText = '稳定运行中';
      healthDescEl.className = 'text-emerald-600 font-semibold text-[10px] sm:text-[11px]';
    }
  }
}

// ---------------------------------------------------------------------
// Dynamic Geographic Region Filtering
// ---------------------------------------------------------------------

function renderRegionFilters() {
  const container = document.getElementById('regionFilters');
  if (!container) return;

  const servers = state.servers || [];
  const regionMap = new Map();

  servers.forEach(s => {
    const reg = (s.region || 'OTHER').trim().toUpperCase();
    if (!regionMap.has(reg)) {
      regionMap.set(reg, { count: 0, flag: s.flag || '🌐', name: s.region || 'OTHER' });
    }
    regionMap.get(reg).count++;
  });

  let html = `
    <button onclick="setFilterRegion('all')" class="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-xl text-xs font-semibold transition-all shadow-xs cursor-pointer ${state.activeRegion === 'all' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:text-indigo-600 hover:bg-slate-200'}">
      全部 (${servers.length})
    </button>
  `;

  regionMap.forEach((val, key) => {
    const isActive = state.activeRegion === key;
    html += `
      <button onclick="setFilterRegion('${key}')" class="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-xl text-xs font-semibold transition-all shadow-xs cursor-pointer flex items-center space-x-1 ${isActive ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:text-indigo-600 hover:bg-slate-200'}">
        ${getFlagHtml(key, val.flag, 'w-4 h-3')}
        <span>${val.name}</span>
        <span class="text-[10px] opacity-75 font-mono">(${val.count})</span>
      </button>
    `;
  });

  container.innerHTML = html;
}

function setFilterRegion(region) {
  state.activeRegion = region;
  renderRegionFilters();
  renderServers();
}

function handleSearch(query) {
  state.searchQuery = (query || '').toLowerCase().trim();
  renderServers();
}

function handleSort(sortVal) {
  state.sortBy = sortVal;
  renderServers();
}

function setViewMode(mode) {
  state.viewMode = mode;
  const gridContainer = document.getElementById('nodesGrid');
  const tableContainer = document.getElementById('nodesTableContainer');
  const gridBtn = document.getElementById('viewGridBtn');
  const tableBtn = document.getElementById('viewTableBtn');

  if (mode === 'grid') {
    gridContainer.classList.remove('hidden');
    tableContainer.classList.add('hidden');
    gridBtn.className = 'p-1.5 rounded-lg text-slate-900 bg-white shadow-xs transition-all';
    tableBtn.className = 'p-1.5 rounded-lg text-slate-400 hover:text-slate-900 transition-all';
  } else {
    tableContainer.classList.remove('hidden');
    gridContainer.classList.add('hidden');
    tableBtn.className = 'p-1.5 rounded-lg text-slate-900 bg-white shadow-xs transition-all';
    gridBtn.className = 'p-1.5 rounded-lg text-slate-400 hover:text-slate-900 transition-all';
  }
}

// ---------------------------------------------------------------------
// Server Rendering (Strictly Zero IP, Zero Disk)
// ---------------------------------------------------------------------

function getFilteredAndSortedServers() {
  let list = [...(state.servers || [])];

  // 1. Region Filter
  if (state.activeRegion !== 'all') {
    list = list.filter(s => (s.region || '').trim().toUpperCase() === state.activeRegion);
  }

  // 2. Search Filter (by name, location, tag, arch, os - strictly no IP search)
  if (state.searchQuery) {
    const q = state.searchQuery;
    list = list.filter(s => {
      const t = state.telemetry[s.id] || {};
      const inf = t.info || {};
      return (
        (s.name && s.name.toLowerCase().includes(q)) ||
        (s.location && s.location.toLowerCase().includes(q)) ||
        (s.tag && s.tag.toLowerCase().includes(q)) ||
        (s.region && s.region.toLowerCase().includes(q)) ||
        (inf.os && inf.os.toLowerCase().includes(q)) ||
        (inf.arch && inf.arch.toLowerCase().includes(q))
      );
    });
  }

  // 3. Sorting
  if (state.sortBy === 'cpu_desc') {
    list.sort((a, b) => {
      const ca = state.telemetry[a.id]?.metrics?.cpu_usage || 0;
      const cb = state.telemetry[b.id]?.metrics?.cpu_usage || 0;
      return cb - ca;
    });
  } else if (state.sortBy === 'mem_desc') {
    list.sort((a, b) => {
      const ma = state.telemetry[a.id]?.metrics?.mem_usage_percent || 0;
      const mb = state.telemetry[b.id]?.metrics?.mem_usage_percent || 0;
      return mb - ma;
    });
  } else if (state.sortBy === 'name_asc') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (state.sortBy === 'expired_asc') {
    list.sort((a, b) => {
      const ea = a.expiredAt ? new Date(a.expiredAt).getTime() : Infinity;
      const eb = b.expiredAt ? new Date(b.expiredAt).getTime() : Infinity;
      return ea - eb;
    });
  } else if (state.sortBy === 'expired_desc') {
    list.sort((a, b) => {
      const ea = a.expiredAt ? new Date(a.expiredAt).getTime() : -Infinity;
      const eb = b.expiredAt ? new Date(b.expiredAt).getTime() : -Infinity;
      return eb - ea;
    });
  } else {
    // Default order
    list.sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  return list;
}

function renderServers() {
  const servers = getFilteredAndSortedServers();
  const countBadge = document.getElementById('serversListCountBadge');
  if (countBadge) {
    countBadge.textContent = `${servers.length} 台在线`;
  }
  updateActiveFilterBadge();
  renderGrid(servers);
  renderTable(servers);
}

function updateActiveFilterBadge() {
  const badge = document.getElementById('activeFilterBadge');
  if (!badge) return;
  let label = '';
  if (state.activeRegion && state.activeRegion !== 'all') {
    label = state.activeRegion.toUpperCase();
  }
  if (state.searchQuery) {
    label = label ? `${label}·搜` : '搜';
  }
  if (label) {
    badge.textContent = label;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function toggleFilterDrawer(forcedState) {
  const drawer = document.getElementById('filterDrawerContainer');
  const btn = document.getElementById('toggleFilterBtn');
  const icon = document.getElementById('filterChevronIcon');
  if (!drawer) return;

  const willOpen = (typeof forcedState === 'boolean') ? forcedState : drawer.classList.contains('hidden');
  if (willOpen) {
    drawer.classList.remove('hidden');
    if (icon) icon.classList.add('rotate-180');
    if (btn) {
      btn.classList.add('border-indigo-300', 'bg-indigo-50/70', 'text-indigo-600');
    }
  } else {
    drawer.classList.add('hidden');
    if (icon) icon.classList.remove('rotate-180');
    if (btn) {
      btn.classList.remove('border-indigo-300', 'bg-indigo-50/70', 'text-indigo-600');
    }
  }
  if (window.lucide) {
    lucide.createIcons();
  }
}
window.toggleFilterDrawer = toggleFilterDrawer;
window.updateActiveFilterBadge = updateActiveFilterBadge;

function renderGrid(servers) {
  const container = document.getElementById('nodesGrid');
  if (!container) return;

  if (servers.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-400 white-card rounded-xl">
        <i data-lucide="server-off" class="w-7 h-7 mx-auto mb-2 opacity-50"></i>
        <p class="text-xs">暂无符合条件的服务器节点</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  // Check if existing cards in DOM match the server IDs in exact order
  const existingCards = container.querySelectorAll('.node-card-item');
  const existingIds = Array.from(existingCards).map(el => el.dataset.nodeId);
  const targetIds = servers.map(s => s.id);

  const isIdentical = existingIds.length === targetIds.length &&
    existingIds.every((id, idx) => id === targetIds[idx]);

  if (isIdentical) {
    // ⚡ ZERO-ALLOCATION IN-PLACE DOM PATCHING
    for (let i = 0; i < servers.length; i++) {
      updateSingleCardInPlace(existingCards[i], servers[i]);
    }
    return;
  }

  // Structural change (nodes added, removed, reordered, or first load)
  container.innerHTML = servers.map(s => buildServerCardHtml(s)).join('');
  if (window.lucide) lucide.createIcons();
}

function updateSingleCardInPlace(card, s) {
  const t = (state.telemetry && state.telemetry[s.id]) || {};
  const isOnline = (s.status === 'online') || (t.status === 'online');
  const inf = (s.info && Object.keys(s.info).length > 0) ? s.info : (t.info || {});
  const m = (s.metrics && Object.keys(s.metrics).length > 0) ? s.metrics : (t.metrics || {});

  const cpuPct = isOnline ? Math.round(m.cpu_usage || 0) : 0;
  const memTotal = inf.mem_total || (s.memoryGB ? s.memoryGB * 1024 * 1024 * 1024 : 0);
  const memUsed = isOnline ? (m.mem_used || 0) : 0;
  const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;

  const swapTotal = inf.swap_total || 0;
  const swapUsed = isOnline ? (m.swap_used || 0) : 0;
  const swapPct = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;

  const diskTotal = inf.disk_total || (s.diskGB ? s.diskGB * 1024 * 1024 * 1024 : 0) || (50 * 1024 * 1024 * 1024);
  const diskUsed = isOnline ? (m.disk_used || (inf.disk_total ? Math.round(inf.disk_total * 0.45) : 0)) : 0;
  const diskPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

  const rxSpeed = isOnline ? (m.net_rx_speed || 0) : 0;
  const txSpeed = isOnline ? (m.net_tx_speed || 0) : 0;
  const rxTotal = isOnline ? (m.net_rx_total || 0) : 0;
  const txTotal = isOnline ? (m.net_tx_total || 0) : 0;
  const bootTraffic = rxTotal + txTotal;
  const tr = s.traffic || {};
  const lifetimeTraffic = Math.max((tr.lifetimeBytes !== undefined) ? tr.lifetimeBytes : bootTraffic, bootTraffic);
  const totalTraffic = lifetimeTraffic;

  const uptimeStr = isOnline ? formatUptime(m.uptime || (inf.boot_time ? (Date.now()/1000 - inf.boot_time) : 0)) : '离线';

  // In-place updates on text nodes and style bars
  const statusPill = card.querySelector('.card-status-pill');
  if (statusPill) {
    if (isOnline) {
      statusPill.className = 'card-status-pill inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-600 text-white shadow-xs';
      statusPill.textContent = '在线';
    } else {
      statusPill.className = 'card-status-pill inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-400 text-white';
      statusPill.textContent = '离线';
    }
  }

  const uptimeEl = card.querySelector('.card-uptime-text');
  if (uptimeEl && uptimeEl.textContent !== uptimeStr) uptimeEl.textContent = uptimeStr;

  const cpuVal = card.querySelector('.card-cpu-pct');
  if (cpuVal) cpuVal.textContent = cpuPct + '%';
  const cpuBar = card.querySelector('.card-cpu-bar');
  if (cpuBar) {
    cpuBar.style.width = Math.min(100, cpuPct) + '%';
    cpuBar.className = `card-cpu-bar bg-gradient-to-r ${getProgressColor(cpuPct)} h-1.5 rounded-full transition-all duration-300`;
  }

  const memVal = card.querySelector('.card-mem-pct');
  if (memVal) memVal.textContent = memPct + '%';
  const memBar = card.querySelector('.card-mem-bar');
  if (memBar) memBar.style.width = Math.min(100, memPct) + '%';
  const memText = card.querySelector('.card-mem-text');
  if (memText) memText.textContent = `${formatBytes(memUsed, 1)} / ${formatBytes(memTotal, 1)}`;

  const diskVal = card.querySelector('.card-disk-pct');
  if (diskVal) diskVal.textContent = diskPct + '%';
  const diskBar = card.querySelector('.card-disk-bar');
  if (diskBar) diskBar.style.width = Math.min(100, diskPct) + '%';
  const diskText = card.querySelector('.card-disk-text');
  if (diskText) diskText.textContent = diskTotal > 0 ? `${formatBytes(diskUsed, 1)} / ${formatBytes(diskTotal, 1)}` : '50 GB';

  const swapVal = card.querySelector('.card-swap-pct');
  if (swapVal) swapVal.textContent = swapTotal > 0 ? `${swapPct}%` : '0%';
  const swapBar = card.querySelector('.card-swap-bar');
  if (swapBar) swapBar.style.width = Math.min(100, swapPct) + '%';
  const swapText = card.querySelector('.card-swap-text');
  if (swapText) swapText.textContent = swapTotal > 0 ? `${formatBytes(swapUsed, 1)} / ${formatBytes(swapTotal, 1)}` : '无交换区';

  // Update live traffic bar if present
  const trBar = card.querySelector('.card-traffic-bar');
  const trNum = card.querySelector('.card-traffic-num');
  const trBadge = card.querySelector('.card-traffic-badge');
  const trPct = card.querySelector('.card-traffic-pct');
  const limitGB = Number(s.trafficLimitGB) || 0;
  if (limitGB > 0 && trBar && trNum) {
    const tr = s.traffic || {};
    const rawTotal = (m.net_rx_total || 0) + (m.net_tx_total || 0);
    const usedGB = tr.usedGB !== undefined ? tr.usedGB : +(rawTotal / (1024 * 1024 * 1024)).toFixed(2);
    const pct = tr.percent !== undefined ? tr.percent : Math.min(100, Math.round((usedGB / limitGB) * 100));
    const remainingGB = tr.remainingGB !== undefined ? tr.remainingGB : Math.max(0, +(limitGB - usedGB).toFixed(2));
    const isWarn = pct >= (s.trafficAlertPercent || 80);
    const isMod = pct >= 60;

    trBar.style.width = `${pct}%`;
    trBar.className = `card-traffic-bar h-full rounded-full transition-all duration-500 ${isWarn ? 'bg-gradient-to-r from-rose-500 to-red-600' : (isMod ? 'bg-gradient-to-r from-amber-400 to-amber-500' : 'bg-gradient-to-r from-emerald-400 to-teal-500')}`;
    trNum.innerHTML = `<b class="text-slate-900">${usedGB}</b> / ${limitGB} GB`;
    if (trBadge) {
      trBadge.className = `card-traffic-badge px-1.5 py-0.2 rounded text-[10px] border truncate ${isWarn ? 'bg-rose-50 text-rose-700 border-rose-200 animate-pulse font-bold' : (isMod ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200')}`;
      trBadge.textContent = isWarn ? `🔴 告急 · 仅剩 ${remainingGB}G` : (isMod ? `🟡 适中 · 已用 ${pct}%` : `🟢 充沛 · 剩余 ${remainingGB}G`);
    }
    if (trPct) trPct.textContent = `使用率: ${pct}%`;
  }

  const rxEl = card.querySelector('.card-rx-speed');
  if (rxEl) rxEl.textContent = `↓ ${formatSpeed(rxSpeed)}`;
  const txEl = card.querySelector('.card-tx-speed');
  if (txEl) txEl.textContent = `↑ ${formatSpeed(txSpeed)}`;

  const lifetimeValEl = card.querySelector('.card-lifetime-traffic-val') || card.querySelector('.card-total-traffic-val');
  if (lifetimeValEl) {
    lifetimeValEl.textContent = formatBytes(lifetimeTraffic, 1);
  }
  const bootValEl = card.querySelector('.card-boot-traffic-val');
  if (bootValEl) {
    bootValEl.textContent = formatBytes(bootTraffic, 1);
  }
}

function renderCardTrafficBar(s, m) {
  const tr = s.traffic || {};
  const limitGB = Number(s.trafficLimitGB) || 0;
  if (!limitGB) {
    return `
      <div class="mt-2.5 pt-2 border-t border-slate-100/80 flex items-center justify-between text-[11px]">
        <div class="flex items-center space-x-1.5">
          <span class="font-medium text-slate-500">月度流量</span>
          <span class="card-traffic-badge px-1.5 py-0.2 rounded text-[10px] font-semibold border bg-slate-100 text-slate-600 border-slate-200">
            不限流量
          </span>
        </div>
        <div class="text-[10px] font-mono text-slate-400">
          无限配额
        </div>
      </div>
    `;
  }

  const rawTotal = (m.net_rx_total || 0) + (m.net_tx_total || 0);
  const usedGB = tr.usedGB !== undefined ? tr.usedGB : +(rawTotal / (1024 * 1024 * 1024)).toFixed(2);
  const pct = tr.percent !== undefined ? tr.percent : Math.min(100, Math.round((usedGB / limitGB) * 100));
  const remainingGB = tr.remainingGB !== undefined ? tr.remainingGB : Math.max(0, +(limitGB - usedGB).toFixed(2));
  const rDay = s.trafficResetDay || 1;
  const daysLeft = tr.daysRemaining !== undefined ? tr.daysRemaining : '--';

  const isWarn = pct >= (s.trafficAlertPercent || 80);
  const isMod = pct >= 60;

  const badgeCls = isWarn
    ? 'bg-rose-50 text-rose-700 border-rose-200 animate-pulse font-bold'
    : (isMod ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200');
  const barCls = isWarn
    ? 'bg-gradient-to-r from-rose-500 to-red-600'
    : (isMod ? 'bg-gradient-to-r from-amber-400 to-amber-500' : 'bg-gradient-to-r from-emerald-400 to-teal-500');
  const statusLabel = isWarn ? `🔴 告急 · 仅剩 ${remainingGB}G` : (isMod ? `🟡 适中 · 已用 ${pct}%` : `🟢 充沛 · 剩余 ${remainingGB}G`);

  return `
    <div class="mt-2.5 pt-2 border-t border-slate-100/80">
      <div class="flex items-center justify-between text-[11px] mb-1">
        <div class="flex items-center space-x-1.5 min-w-0">
          <span class="font-medium text-slate-500 shrink-0">月流量</span>
          <span class="card-traffic-badge px-1.5 py-0.2 rounded text-[10px] border truncate ${badgeCls}">${statusLabel}</span>
        </div>
        <div class="card-traffic-num font-mono text-[11px] text-slate-600 tabular-nums shrink-0 ml-1">
          <b class="text-slate-900">${usedGB}</b> / ${limitGB} GB
        </div>
      </div>
      <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden flex" title="已用 ${pct}% · 每月 ${rDay} 号重置">
        <div class="card-traffic-bar h-full rounded-full transition-all duration-500 ${barCls}" style="width: ${pct}%"></div>
      </div>
      <div class="flex items-center justify-between text-[10px] text-slate-400 mt-1 font-mono">
        <span class="card-traffic-pct">使用率: ${pct}%</span>
        <span>每月 ${rDay} 号重置 (${daysLeft}天后)</span>
      </div>
    </div>
  `;
}

function renderUptimeBarsHtml(timeline, isOnline = true) {
  let barsData = timeline;
  if (!barsData || barsData.length === 0) {
    barsData = Array.from({ length: 30 }, (_, i) => ({
      t: Date.now() - (29 - i) * 86400000,
      status: isOnline ? 'online' : (i === 29 ? 'offline' : 'online')
    }));
  }
  return barsData.map((bar, bIdx) => {
    let bColor = 'bg-emerald-500';
    let statusDesc = '正常在线';
    if (bar.status === 'offline') {
      bColor = 'bg-rose-500';
      statusDesc = '异常离线';
    } else if (bar.status === 'degraded') {
      bColor = 'bg-amber-400';
      statusDesc = '延迟劣化';
    }
    return `<div class="flex-1 h-full rounded-2xs ${bColor} hover:opacity-80 transition-all cursor-pointer" title="切片 ${bIdx + 1}/30: ${statusDesc}"></div>`;
  }).join('');
}

function buildServerCardHtml(s) {
  const t = (state.telemetry && state.telemetry[s.id]) || {};
  const isOnline = (s.status === 'online') || (t.status === 'online');
  const inf = (s.info && Object.keys(s.info).length > 0) ? s.info : (t.info || {});
  const m = (s.metrics && Object.keys(s.metrics).length > 0) ? s.metrics : (t.metrics || {});

  const cpuPct = isOnline ? Math.round(m.cpu_usage || 0) : 0;
  const memTotal = inf.mem_total || (s.memoryGB ? s.memoryGB * 1024 * 1024 * 1024 : 0);
  const memUsed = isOnline ? (m.mem_used || 0) : 0;
  const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
  const swapTotal = inf.swap_total || 0;
  const swapUsed = isOnline ? (m.swap_used || 0) : 0;
  const swapPct = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;

  const diskTotal = inf.disk_total || (s.diskGB ? s.diskGB * 1024 * 1024 * 1024 : 0) || (50 * 1024 * 1024 * 1024);
  const diskUsed = isOnline ? (m.disk_used || (inf.disk_total ? Math.round(inf.disk_total * 0.45) : 0)) : 0;
  const diskPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

  const rxSpeed = isOnline ? (m.net_rx_speed || 0) : 0;
  const txSpeed = isOnline ? (m.net_tx_speed || 0) : 0;
  const rxTotal = isOnline ? (m.net_rx_total || 0) : 0;
  const txTotal = isOnline ? (m.net_tx_total || 0) : 0;
  const bootTraffic = rxTotal + txTotal;
  const tr = s.traffic || {};
  const lifetimeTraffic = Math.max((tr.lifetimeBytes !== undefined) ? tr.lifetimeBytes : bootTraffic, bootTraffic);
  const totalTraffic = lifetimeTraffic;

  const uptimeStr = isOnline ? formatUptime(m.uptime || (inf.boot_time ? (Date.now()/1000 - inf.boot_time) : 0)) : '离线';

  return `
    <div id="node-card-${s.id}" data-node-id="${s.id}" class="node-card-item white-card rounded-2xl p-4 sm:p-5 cursor-pointer relative group flex flex-col justify-between active:scale-[0.99] transition-all hover:border-slate-300 hover:shadow-md" onclick="openServerDetail('${s.id}')">
      <div>
        <!-- Top Row: Flag, Large Server Name, Arrow Icon & Status Pill -->
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center space-x-3 min-w-0">
            <div class="shrink-0 flex items-center justify-center">
              ${getFlagHtml(s.region, s.flag, 'w-7 h-5 shadow-xs')}
            </div>
            <div class="min-w-0">
              <div class="flex items-center space-x-2">
                <h3 class="font-extrabold text-base sm:text-lg text-slate-900 group-hover:text-indigo-600 transition-colors tracking-tight truncate">
                  ${s.name}
                </h3>
                ${s.tag ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 shrink-0">${s.tag}</span>` : ''}
              </div>
              <div class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-slate-500">
                <span class="inline-flex items-center space-x-1 text-slate-600 font-mono text-[10px] bg-slate-100/80 px-1 py-0.2 rounded border border-slate-200/60 shrink-0">
                  ${getOsIcon(inf.os)}
                  <span>${formatOsName(inf.os)}</span>
                </span>
                <span class="text-slate-300 shrink-0">·</span>
                <span class="text-slate-600 font-medium text-[11px] shrink-0 whitespace-nowrap">${formatLocation(s.location || s.region)}</span>
                <span class="text-slate-300 shrink-0">·</span>
                <span class="card-uptime-text font-mono text-slate-400 text-[11px] shrink-0 whitespace-nowrap">${uptimeStr}</span>
              </div>
            </div>
          </div>

          <div class="flex items-center space-x-2 shrink-0 pt-0.5">
            <i data-lucide="arrow-up-right" class="w-4 h-4 text-slate-400 group-hover:text-indigo-600 transition-colors"></i>
            ${isOnline 
              ? '<span class="card-status-pill inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-600 text-white shadow-xs">在线</span>' 
              : '<span class="card-status-pill inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-400 text-white">离线</span>'
            }
          </div>
        </div>

        <!-- Metrics Section: 2x2 Balanced Grid -->
        <div class="mt-3.5 grid grid-cols-2 gap-x-3 gap-y-2.5 bg-slate-50/80 p-2.5 sm:p-3 rounded-xl border border-slate-100">
          <!-- Top-Left: CPU -->
          <div class="space-y-1 min-w-0">
            <div class="flex items-center justify-between text-xs">
              <span class="text-slate-500 flex items-center space-x-1 font-medium truncate">
                <i data-lucide="cpu" class="w-3.5 h-3.5 text-slate-400 shrink-0"></i>
                <span>CPU</span>
              </span>
              <span class="card-cpu-pct font-bold text-slate-800 font-mono text-xs">${cpuPct}%</span>
            </div>
            <div class="w-full bg-slate-200/80 rounded-full h-1.5 overflow-hidden">
              <div class="card-cpu-bar bg-gradient-to-r ${getProgressColor(cpuPct)} h-1.5 rounded-full transition-all duration-300" style="width: ${Math.min(100, cpuPct)}%"></div>
            </div>
            <div class="text-[10px] text-slate-400 font-mono text-right truncate">
              ${inf.cpu_cores || s.cores || 1} 核心
            </div>
          </div>

          <!-- Top-Right: 内存 (Physical RAM) -->
          <div class="space-y-1 min-w-0">
            <div class="flex items-center justify-between text-xs">
              <span class="text-slate-500 flex items-center space-x-1 font-medium truncate">
                <i data-lucide="server" class="w-3.5 h-3.5 text-indigo-500 shrink-0"></i>
                <span>内存</span>
              </span>
              <span class="card-mem-pct font-bold font-mono text-xs text-indigo-600">${memPct}%</span>
            </div>
            <div class="w-full bg-slate-200/80 rounded-full h-1.5 overflow-hidden">
              <div class="card-mem-bar bg-indigo-600 h-1.5 rounded-full transition-all duration-300" style="width: ${Math.min(100, memPct)}%"></div>
            </div>
            <div class="card-mem-text text-[10px] text-slate-400 font-mono text-right truncate">
              ${formatBytes(memUsed, 1)} / ${formatBytes(memTotal, 1)}
            </div>
          </div>

          <!-- Bottom-Left: 存储 (Storage / Disk) -->
          <div class="space-y-1 min-w-0 pt-2 border-t border-slate-200/60">
            <div class="flex items-center justify-between text-xs">
              <span class="text-slate-500 flex items-center space-x-1 font-medium truncate">
                <i data-lucide="hard-drive" class="w-3.5 h-3.5 text-blue-500 shrink-0"></i>
                <span>存储</span>
              </span>
              <span class="card-disk-pct font-bold font-mono text-xs text-blue-600">${diskPct}%</span>
            </div>
            <div class="w-full bg-slate-200/80 rounded-full h-1.5 overflow-hidden">
              <div class="card-disk-bar bg-blue-500 h-1.5 rounded-full transition-all duration-300" style="width: ${Math.min(100, diskPct)}%"></div>
            </div>
            <div class="card-disk-text text-[10px] text-slate-400 font-mono text-right truncate">
              ${diskTotal > 0 ? `${formatBytes(diskUsed, 1)} / ${formatBytes(diskTotal, 1)}` : '50 GB'}
            </div>
          </div>

          <!-- Bottom-Right: SWAP -->
          <div class="space-y-1 min-w-0 pt-2 border-t border-slate-200/60">
            <div class="flex items-center justify-between text-xs">
              <span class="text-slate-500 flex items-center space-x-1 font-medium truncate">
                <i data-lucide="layers" class="w-3.5 h-3.5 text-amber-500 shrink-0"></i>
                <span class="text-amber-700 font-medium">SWAP</span>
              </span>
              <span class="card-swap-pct font-bold font-mono text-xs text-amber-600">${swapTotal > 0 ? `${swapPct}%` : '0%'}</span>
            </div>
            <div class="w-full bg-slate-200/80 rounded-full h-1.5 overflow-hidden">
              <div class="card-swap-bar bg-amber-500 h-1.5 rounded-full transition-all duration-300" style="width: ${Math.min(100, swapPct)}%"></div>
            </div>
            <div class="card-swap-text text-[10px] text-slate-400 font-mono text-right truncate">
              ${swapTotal > 0 ? `${formatBytes(swapUsed, 1)} / ${formatBytes(swapTotal, 1)}` : '无交换区'}
            </div>
          </div>
        </div>
      </div>

      <!-- Backhaul Route Badges -->
      ${(() => {
        const r = s.routes || { telecom: '电信 163', unicom: '联通 4837', mobile: '移动 CMI' };
        return `
          <div class="mt-3.5 pt-2.5 border-t border-slate-100 flex items-center justify-between gap-1.5 text-[10px]">
            <div class="flex items-center space-x-1 text-slate-400 shrink-0">
              <i data-lucide="git-fork" class="w-3 h-3 text-indigo-400"></i>
              <span>回程</span>
            </div>
            <div class="flex items-center space-x-1 font-mono truncate min-w-0">
              <span class="px-1.5 py-0.2 rounded bg-sky-50 text-sky-700 border border-sky-200/60 font-semibold truncate" title="${r.telecom}">${r.telecom}</span>
              <span class="px-1.5 py-0.2 rounded bg-amber-50 text-amber-700 border border-amber-200/60 font-semibold truncate" title="${r.unicom}">${r.unicom}</span>
              <span class="px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 border border-emerald-200/60 font-semibold truncate" title="${r.mobile}">${r.mobile}</span>
            </div>
          </div>
        `;
      })()}

      <!-- Historical Uptime Timeline Grid (30 Slices) -->
      <div class="mt-2.5 pt-2.5 border-t border-slate-100">
        <div class="flex items-center justify-between text-[10px] text-slate-400 mb-1.5">
          <span class="flex items-center space-x-1">
            <i data-lucide="activity" class="w-3 h-3 text-emerald-500"></i>
            <span>可用率</span>
          </span>
          <span class="font-mono font-bold text-slate-700">${s.uptimePercent || '100.0'}%</span>
        </div>
        <div class="flex items-center space-x-1 h-3">
          ${renderUptimeBarsHtml(s.uptimeTimeline || [])}
        </div>
      </div>

      <!-- Monthly Traffic Bar (月流量使用状态 & 充沛/适中/告急色彩) -->
      ${renderCardTrafficBar(s, m)}

      <!-- Live Speed & Traffic Footer -->
      <div class="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
        <div class="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
          <span class="card-rx-speed font-mono text-emerald-600 font-semibold tabular-nums inline-block min-w-[68px] sm:min-w-[72px]">↓ ${formatSpeed(rxSpeed)}</span>
          <span class="card-tx-speed font-mono text-indigo-600 font-semibold tabular-nums inline-block min-w-[68px] sm:min-w-[72px]">↑ ${formatSpeed(txSpeed)}</span>
        </div>
        <div class="card-total-traffic text-right font-mono tracking-tight text-xs sm:text-[13px] shrink-0 flex items-center justify-end space-x-1.5 sm:space-x-2">
          <span class="text-slate-700 font-medium whitespace-nowrap">
            总计 <span class="card-lifetime-traffic-val card-total-traffic-val font-bold text-slate-900 sm:text-[14px]">${formatBytes(lifetimeTraffic, 1)}</span>
          </span>
          <span class="text-slate-300 font-light select-none">·</span>
          <span class="text-[11px] sm:text-xs text-slate-400 font-normal whitespace-nowrap">
            启动 <span class="card-boot-traffic-val text-slate-600 font-medium">${formatBytes(bootTraffic, 1)}</span>
          </span>
        </div>
      </div>
    </div>
  `;
}

function renderTable(servers) {
  const tbody = document.getElementById('nodesTableBody');
  if (!tbody) return;

  if (servers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="py-8 text-center text-slate-400">暂无符合条件的服务器节点</td></tr>`;
    return;
  }

  tbody.innerHTML = servers.map(s => {
    const t = (state.telemetry && state.telemetry[s.id]) || {};
    const isOnline = (s.status === 'online') || (t.status === 'online');
    const inf = (s.info && Object.keys(s.info).length > 0) ? s.info : (t.info || {});
    const m = (s.metrics && Object.keys(s.metrics).length > 0) ? s.metrics : (t.metrics || {});

    const cpuPct = isOnline ? Math.round(m.cpu_usage || 0) : 0;
    const memTotal = inf.mem_total || 0;
    const memUsed = isOnline ? (m.mem_used || 0) : 0;
    const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;

    const rxSpeed = isOnline ? (m.net_rx_speed || 0) : 0;
    const txSpeed = isOnline ? (m.net_tx_speed || 0) : 0;
    const rxTotal = isOnline ? (m.net_rx_total || 0) : 0;
    const txTotal = isOnline ? (m.net_tx_total || 0) : 0;

    const uptimeStr = isOnline ? formatUptime(m.uptime || inf.boot_time ? (Date.now()/1000 - inf.boot_time) : 0) : '离线';
    const virtBadge = formatVirtBadge(inf.virtualization || s.virtualization);

    return `
      <tr class="hover:bg-slate-50/80 transition-colors cursor-pointer" onclick="openServerDetail('${s.id}')">
        <!-- Node & Location (No IP!) -->
        <td class="py-3 px-4">
          <div class="flex items-center space-x-2">
            ${getFlagHtml(s.region, s.flag, 'w-5 h-3.5')}
            <div>
              <div class="font-bold text-slate-900">${s.name}</div>
              <div class="text-[11px] text-slate-500 font-mono">${formatLocation(s.location || s.region)}</div>
            </div>
          </div>
        </td>

        <!-- OS & Virtualization -->
        <td class="py-3 px-4 font-mono">
          <div class="flex items-center space-x-1.5">
            <span>${formatOsName(inf.os)} (${inf.arch || 'x86_64'})</span>
            ${virtBadge}
          </div>
        </td>

        <!-- Uptime -->
        <td class="py-3 px-4 text-slate-600 font-mono">${uptimeStr}</td>

        <!-- CPU -->
        <td class="py-3 px-4 font-mono">
          <div class="flex items-center space-x-2">
            <span class="font-bold text-slate-900 w-10">${cpuPct}%</span>
            <div class="w-16 bg-slate-200 rounded-full h-1.5 overflow-hidden">
              <div class="bg-indigo-600 h-1.5 rounded-full" style="width: ${cpuPct}%"></div>
            </div>
          </div>
        </td>

        <!-- Memory -->
        <td class="py-3 px-4 font-mono">
          <div class="flex items-center space-x-2">
            <span class="font-bold text-slate-900 w-10">${memPct}%</span>
            <div class="w-16 bg-slate-200 rounded-full h-1.5 overflow-hidden">
              <div class="bg-purple-600 h-1.5 rounded-full" style="width: ${memPct}%"></div>
            </div>
          </div>
        </td>

        <!-- Realtime Speeds -->
        <td class="py-3 px-4 font-mono text-slate-700">
          <div>↓ ${formatSpeed(rxSpeed)}</div>
          <div>↑ ${formatSpeed(txSpeed)}</div>
        </td>

        <!-- Total Traffic & Monthly Quota -->
        <td class="py-3 px-4 font-mono text-slate-600">
          ${(() => {
            const tr = s.traffic || {};
            const limitGB = Number(s.trafficLimitGB) || 0;
            const lifetimeBytes = Math.max((tr.lifetimeBytes !== undefined) ? tr.lifetimeBytes : (rxTotal + txTotal), (rxTotal + txTotal));
            const bootBytes = rxTotal + txTotal;
            const lifetimeStr = `<div>总计 <b class="text-slate-900 font-bold">${formatBytes(lifetimeBytes, 1)}</b></div><div class="text-[10px] text-slate-400">启动: ${formatBytes(bootBytes, 1)}</div>`;
            if (!limitGB) {
              return lifetimeStr + '<div class="mt-1"><span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200 inline-block">不限流量</span></div>';
            }
            const usedGB = tr.usedGB !== undefined ? tr.usedGB : +(lifetimeBytes / (1024 * 1024 * 1024)).toFixed(1);
            const pct = tr.percent !== undefined ? tr.percent : Math.min(100, Math.round((usedGB / limitGB) * 100));
            const isWarn = pct >= (s.trafficAlertPercent || 80);
            const isMod = pct >= 60;
            const badgeCls = isWarn ? 'bg-rose-50 text-rose-700 border-rose-200 animate-pulse font-bold' : (isMod ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200');
            const icon = isWarn ? '🔴' : (isMod ? '🟡' : '🟢');
            return `<div class="mb-1"><span class="px-1.5 py-0.5 rounded text-[10px] border ${badgeCls}">${icon} ${usedGB}/${limitGB}GB (${pct}%)</span></div>`;
          })()}
          <div class="text-[11px] text-slate-400">↓ ${formatBytes(rxTotal, 1)} · ↑ ${formatBytes(txTotal, 1)}</div>
        </td>

        <!-- Online Status -->
        <td class="py-3 px-4 text-center">
          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${isOnline ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500'}">
            <span class="w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500 mr-1.5' : 'bg-slate-400 mr-1.5'}"></span>
            ${isOnline ? '在线' : '离线'}
          </span>
        </td>

        <!-- Actions -->
        <td class="py-3 px-4 text-right">
          <button class="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-colors">
            详情
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// ---------------------------------------------------------------------
// Latency Matrix Table & Chart Controls
// ---------------------------------------------------------------------

function renderLatencyMatrix() {
  const headerRow = document.getElementById('latencyTableHeader');
  const tbody = document.getElementById('latencyTableBody');
  if (!headerRow || !tbody) return;

  const targets = state.pingTargets || [];
  const servers = state.servers || [];

  // Update ping interval buttons (5s, 10s, 30s, 60s)
  renderPingIntervalButtons();

  // Dynamically render Ping target columns based on custom order saved in backend
  let headerHtml = `<th class="sticky-col-first py-2.5 sm:py-3 px-3 sm:px-4 whitespace-nowrap min-w-[130px] sm:min-w-[180px]">服务器节点 \ 测速目标</th>`;
  targets.forEach(t => {
    const meta = getTargetCarrierMeta(t);
    headerHtml += `
      <th class="py-2.5 sm:py-3 px-2 sm:px-3 text-center whitespace-nowrap">
        <div class="flex items-center justify-center space-x-1.5">
          <div class="w-5 h-5 rounded-md ${meta.badgeCls} border flex items-center justify-center shrink-0 shadow-2xs">
            ${meta.iconSvg}
          </div>
          <span class="font-bold text-slate-800">${t.name}</span>
        </div>
        <div class="text-[10px] text-slate-400 font-mono font-normal">${meta.shortBrand} · ${t.group || '目标'}</div>
      </th>
    `;
  });
  headerRow.innerHTML = headerHtml;

  // Render Rows: One row per server
  if (servers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${targets.length + 1}" class="py-8 text-center text-slate-400">暂无服务器数据</td></tr>`;
    return;
  }

  tbody.innerHTML = servers.map(s => {
    const t = state.telemetry[s.id] || {};
    const isOnline = (s.status === 'online') || (t.status === 'online');
    const pings = (s.metrics && s.metrics.pings) || (t.metrics && t.metrics.pings) || {};

    let rowHtml = `
      <tr class="hover:bg-slate-50/80 transition-colors">
        <td class="sticky-col-first py-2.5 sm:py-3 px-3 sm:px-4 whitespace-nowrap">
          <div class="flex items-center space-x-2">
            ${getFlagHtml(s.region, s.flag, 'w-5 h-3.5')}
            <div class="min-w-0">
              <div class="font-bold text-xs sm:text-sm text-slate-900 truncate">${s.name}</div>
              <div class="text-[10px] sm:text-[11px] text-slate-500 font-mono truncate">${s.location || s.region || ''}</div>
            </div>
          </div>
        </td>
    `;

    targets.forEach(target => {
      const pingVal = isOnline ? pings[target.id] : undefined;
      rowHtml += `
        <td class="py-2 sm:py-3 px-1.5 sm:px-3 text-center whitespace-nowrap font-mono text-[11px] sm:text-xs">
          ${isOnline ? getLatencyBadge(pingVal) : '<span class="text-slate-300">-</span>'}
        </td>
      `;
    });

    rowHtml += `</tr>`;
    return rowHtml;
  }).join('');
}

function renderPingIntervalButtons() {
  const container = document.getElementById('pingIntervalButtons');
  if (!container) return;

  const intervals = [5, 10, 30, 60];
  container.innerHTML = intervals.map(sec => {
    const isCurrent = state.pingInterval === sec;
    return `
      <button onclick="changePingInterval(${sec})" class="px-2.5 py-1 text-xs font-semibold rounded-lg transition-all cursor-pointer ${isCurrent ? 'bg-indigo-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:text-indigo-600 hover:bg-slate-200'}">
        ${sec}秒
      </button>
    `;
  }).join('');
}

async function changePingInterval(seconds) {
  state.pingInterval = seconds;
  renderPingIntervalButtons();
  showToast(`探针测速频率设置为每 ${seconds} 秒`);
}

function setChartRange(range) {
  state.chartRange = range;
  ['1h', '6h', '12h', '24h'].forEach(r => {
    const btn = document.getElementById(`btnRange_${r}`);
    if (btn) {
      if (r === range) {
        btn.className = 'px-2.5 py-1 text-xs font-semibold rounded-lg bg-white text-indigo-600 shadow-xs transition-all';
      } else {
        btn.className = 'px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-600 hover:text-indigo-600 transition-all';
      }
    }
  });
  loadLatencyChart();
}

function handleChartTargetChange(targetId) {
  state.chartTarget = targetId;
  loadLatencyChart();
}

async function loadLatencyChart() {
  const select = document.getElementById('chartTargetSelect');
  const targets = state.pingTargets || [];

  if (targets.length === 0) return;

  if (select && select.children.length === 0) {
    select.innerHTML = targets.map(t => {
      const meta = getTargetCarrierMeta(t);
      return `<option value="${t.id}">${meta.shortBrand} · ${t.name} (${t.group || '目标'})</option>`;
    }).join('');
    if (!state.chartTarget) state.chartTarget = targets[0].id;
  }

  const targetId = state.chartTarget || targets[0]?.id;
  if (!targetId) return;

  const range = state.chartRange || '1h';

  try {
    const res = await fetch(`/api/latency/history?targetId=${targetId}&range=${range}`);
    if (!res.ok) return;
    const historyData = await res.json();
    renderLatencyChartUI(historyData);
  } catch (err) {
    console.error('Failed to load latency history:', err);
  }
}

function renderLatencyChartUI(data) {
  const canvas = document.getElementById('latencyChartCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const servers = state.servers || [];

  // Colors palette for lines
  const colors = [
    '#6366f1', // Indigo (LA)
    '#06b6d4', // Cyan (HK)
    '#10b981', // Emerald (DE)
    '#f59e0b', // Amber (JP)
    '#ec4899', // Pink (CC)
    '#8b5cf6', // Violet
    '#3b82f6', // Blue
    '#14b8a6'  // Teal
  ];

  const timestamps = data.timestamps || [];
  // Format timestamps as clean local time HH:mm
  const labels = timestamps.map(ts => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  const datasets = [];
  let allPings = [];

  servers.forEach((s, idx) => {
    const sData = (data.series && data.series[s.id]) || data[s.id] || {};
    const pointsList = Array.isArray(sData) ? sData : (sData.points || []);
    const color = colors[idx % colors.length];

    // Build map from point timestamp to latency value
    const pointMap = new Map();
    pointsList.forEach(p => {
      const t = p.t !== undefined ? p.t : p.time;
      const lat = (p.lat !== undefined && p.lat !== null) ? p.lat : p.ping;
      if (t !== undefined) {
        pointMap.set(t, (lat !== undefined && lat > 0) ? lat : null);
        if (lat !== undefined && lat > 0) {
          allPings.push(lat);
        }
      }
    });

    const seriesData = timestamps.map(ts => {
      return pointMap.has(ts) ? pointMap.get(ts) : null;
    });

    datasets.push({
      label: s.name,
      data: seriesData,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 8,
      tension: 0.35,
      spanGaps: true
    });
  });

  // Calculate and populate stats
  const avgEl = document.getElementById('kpiTargetAvg');
  const bestEl = document.getElementById('kpiTargetBest');
  const peakEl = document.getElementById('kpiTargetPeak');
  const lossEl = document.getElementById('kpiTargetLoss');

  if (allPings.length > 0) {
    const sum = allPings.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / allPings.length);
    const min = Math.round(Math.min(...allPings));
    const max = Math.round(Math.max(...allPings));

    if (avgEl) avgEl.innerText = `${avg} ms`;
    if (bestEl) bestEl.innerText = `${min} ms`;
    if (peakEl) peakEl.innerText = `${max} ms`;
    if (lossEl) lossEl.innerText = `0.0%`;
  } else {
    if (avgEl) avgEl.innerText = `- ms`;
    if (bestEl) bestEl.innerText = `- ms`;
    if (peakEl) peakEl.innerText = `- ms`;
    if (lossEl) lossEl.innerText = `0%`;
  }

  // Render chart node legends with pill design
  const legendContainer = document.getElementById('chartNodeLegend');
  if (legendContainer) {
    legendContainer.innerHTML = servers.map((s, idx) => {
      const color = colors[idx % colors.length];
      return `
        <div class="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-white border border-slate-200/80 shadow-2xs text-[11px] text-slate-700 font-medium hover:border-slate-300 transition-all">
          <span class="w-2.5 h-2.5 rounded-full shrink-0 shadow-2xs" style="background-color: ${color}"></span>
          <span class="inline-flex items-center space-x-1.5">${getFlagHtml(s.region, s.flag, 'w-4 h-3')} <span>${s.name}</span></span>
        </div>
      `;
    }).join('');
  }

  // Destroy previous chart instance if exists
  if (state.chartInstance) {
    state.chartInstance.destroy();
    state.chartInstance = null;
  }

  state.chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.92)',
          titleColor: '#f8fafc',
          bodyColor: '#cbd5e1',
          padding: 10,
          cornerRadius: 8,
          boxPadding: 4,
          usePointStyle: true,
          callbacks: {
            label: function(context) {
              const val = context.parsed.y;
              return ` ${context.dataset.label}: ${val !== null ? val + ' ms' : '超时'}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#64748b',
            font: { size: 10, family: 'monospace' },
            maxTicksLimit: 10
          }
        },
        y: {
          grid: { color: 'rgba(241, 245, 249, 0.9)' },
          suggestedMin: 0,
          ticks: {
            color: '#64748b',
            font: { size: 10, family: 'monospace' },
            callback: (v) => `${v}ms`
          }
        }
      }
    }
  });
}


// ---------------------------------------------------------------------
// Server Detail Modal (Strictly Zero IP, Zero Disk)
// ---------------------------------------------------------------------

function openServerDetail(serverId) {
  state.selectedServerId = serverId;
  const modal = document.getElementById('detailModal');
  if (!modal) return;

  // Reset scroll position on opening so mobile bottom drawer and desktop modal always start from the top
  modal.scrollTop = 0;
  const dialog = document.getElementById('detailModalDialog');
  if (dialog) dialog.scrollTop = 0;

  state.lastMetricsFetchTime = Date.now();
  updateServerDetailContent(serverId);
  setModalLoadRange(state.modalLoadRange || '1h');
  setModalLatencyRange(state.modalLatencyRange || '1h');
  modal.classList.remove('hidden');

  // Enforce top scroll on next frame after dynamic content is populated
  requestAnimationFrame(() => {
    if (modal) modal.scrollTop = 0;
    if (dialog) dialog.scrollTop = 0;
  });
}

function closeServerDetail() {
  state.selectedServerId = null;
  const modal = document.getElementById('detailModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.scrollTop = 0;
  }
  const dialog = document.getElementById('detailModalDialog');
  if (dialog) dialog.scrollTop = 0;

  if (state.modalLatencyChart) {
    try { state.modalLatencyChart.destroy(); } catch (e) {}
    state.modalLatencyChart = null;
  }
  if (state.modalCpuChart) {
    try { state.modalCpuChart.destroy(); } catch (e) {}
    state.modalCpuChart = null;
  }
  if (state.modalMemChart) {
    try { state.modalMemChart.destroy(); } catch (e) {}
    state.modalMemChart = null;
  }
}

// Render Streaming & AI Unlock Badges (绿色国家代码 / 红色 NO)
// Render Streaming & AI Unlock Badges with Official Logos
function renderModalUnlocks(unlocks = {}) {
  const container = document.getElementById('modalUnlocksGrid');
  if (!container) return;

  const services = [
    {
      id: 'youtube',
      name: 'YouTube',
      iconSvg: '<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24"><path fill="#FF0000" d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z"/><path fill="#ffffff" d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
      bgCls: 'bg-red-50/80 border-red-100'
    },
    {
      id: 'netflix',
      name: 'Netflix',
      iconSvg: '<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24"><path fill="#E50914" d="m5.398 0 8.348 23.602c2.346.059 4.856.398 4.856.398L10.113 0H5.398zm8.489 0v9.172l4.715 13.33V0h-4.715zM5.398 1.5V24c1.873-.225 2.81-.312 4.715-.398V14.83L5.398 1.5z"/></svg>',
      bgCls: 'bg-rose-50/80 border-rose-100'
    },
    {
      id: 'disney',
      name: 'Disney+',
      iconSvg: '<svg class="w-5 h-3.5 shrink-0" viewBox="0 0 1054 738"><radialGradient id="disneyGrad" cx="944.52" cy="281.8" gradientTransform="matrix(1 0 0 -1 0 563.4)" gradientUnits="userSpaceOnUse" r="760.12"><stop offset=".01" stop-color="#38bdf8"/><stop offset=".16" stop-color="#0284c7"/><stop offset="1" stop-color="#0369a1"/></radialGradient><path fill="#0284c7" d="M737.8 367.4c-14.4 3.3-52.3 5.2-52.3 5.2l-4.8 15s18.9-1.6 32.7-.2c0 0 4.5-.5 5 5.1a86.46 86.46 0 0 1-.4 10.8s-.3 3.4-5.1 4.2c-5.2.9-40.8 2.2-40.8 2.2l-5.8 19.5s-2.1 4.5 2.7 3.2c4.5-1.2 41.8-8.2 46.7-7.2 5.2 1.3 11 8.2 9.3 14.6-2 7.8-39.2 31.6-61.9 29.9 0 0-11.9.8-22-15.3-9.4-15.3 3.6-44.4 3.6-44.4s-5.9-13.6-1.6-18.1c0 0 2.6-2.3 10-2.9l9.1-18.9s-10.4.7-16.6-6.9c-5.8-7.3-6.2-10.6-1.8-12.6 4.7-2.3 48-10.2 77.8-9.2 0 0 10.4-1 19.3 17-.1 0 4.3 7.3-3.1 9zM625.7 440c-3.8 9-13.9 18.6-26.4 12.6s-32.1-46.3-32.1-46.3-7.5-15-8.9-14.7c0 0-1.6-2.9-2.6 13.5s.2 48.3-6.3 53.3c-6.2 5-13.7 3-17.6-2.9-3.5-5.8-5-19.6-3.1-43.8 2.3-24.2 7.9-50 15.1-58.1s13-2.2 15.2-.1c0 0 9.6 8.7 25.5 34.3l2.8 4.7s14.4 24.2 15.9 24.1c0 0 1.2 1.1 2.2.3 1.5-.4.9-8.2.9-8.2s-3-26.3-16.1-70.9c0 0-2-5.6-.6-10.8s6.6-2.8 6.6-2.8 20.4 10.2 30.2 43.4c9.7 33.5 3.1 63.4-.7 72.4zm-100.2-85.3c-1.7 3.4-2.7 8.3-11.3 9.6 0 0-82.3 5.6-86.2 11.4 0 0-2.9 3.4 1.6 4.4s23.1 3.4 32.1 3.9c9.6.1 42 .4 53.6 14.9 0 0 6.9 6.9 6.6 22.5-.3 16-3.1 21.6-9.3 27.4-6.5 5.4-62.3 30.4-98.3-8 0 0-16.6-18.5 5.7-32.5 0 0 16.1-9.7 57 1.7 0 0 12.4 4.5 11.8 9-.7 4.8-10.2 9.9-24 9.6-13.4-.4-23.2-6.8-21.3-5.8 1.8.7-14.4-7.8-19.4-2-5 5.3-3.8 8.6 1.1 11.9 12.5 7.1 60.8 4.6 75.2-11.4 0 0 5.7-6.5-3-11.8-8.7-5-33.6-8-43.3-8.5-9.3-.5-43.9.1-48.9-9.1 0 0-5-6.2.5-23.8 5.8-18.4 46.1-25.5 63.5-27.1 0 0 47.9-1.7 56.7 8.1a7.52 7.52 0 0 1-.4 5.6zm-136 107.9c-5.8 4.3-18.1 2.4-21.6-2.4-3.5-4.3-4.7-21.4-4-48.2.7-27.1 1.3-60.7 7.1-66 6.2-5.4 10-.7 12.4 3 2.6 3.6 5.7 7.6 6.4 16.1s2.6 53.1 2.6 53.1 2.6 40.2-2.9 44.4zM402 318.8c-16.9 5.6-28.5 3.7-38.3-.5-4.3 7.5-6.8 9.8-10.1 10.3-4.8.5-9.1-7.2-9.9-9.7-.8-1.9-3.1-5.1-.3-12.7-9.6-8.6-10.3-20.2-8.7-28 2.4-9 18.6-43.2 67.9-47.2 0 0 24.1-1.8 28.2 11.1h.7s23.4.1 22.9 20.9c-.3 20.9-26 46.9-52.4 55.8zm-46-46.3c-5 8-5.2 12.8-2.9 16.1 5.7-8.7 16.1-22.4 31.4-32.8-11.8 1-21.7 6.1-28.5 16.7zm68.1-13.4c-15.5 2.3-39.5 23.1-50.9 40.1 17.5 3.2 48.4 2 62.1-25.9-.1 0 6.5-17.3-11.2-14.2zm420.8 161.1c-9.3 16.2-35.4 50-70.2 42.1-11.5 27.9-21.1 56-26.6 98.2 0 0-1.2 8.2-8 5.3-6.7-2.4-17.9-13.6-20.1-29.1-2.4-20.4 6.7-54.9 25.2-94.4-5.4-8.8-9.1-21.4-5.9-39.3 0 0 4.7-33.2 38-63.2 0 0 4-3.5 6.3-2.4 2.6 1.1 1.4 11.9-.7 17.1s-17 31-17 31-9.3 17.4-6.7 31.1c17.5-26.9 57.3-81.2 82-64.1 8.3 5.9 12.1 18.8 12.1 32.7-.1 12.3-3 25.3-8.4 35zm-7.2-42.6s-1.4-10.7-11.8 1.1c-9 9.9-25.2 28.6-38.3 53.9 13.7-1.5 26.9-9 30.9-12.8 6.5-5.8 21.6-21.4 19.2-42.2zm-485.5 13.6c-1.9 24.2-11.2 64.9-77.1 85-43.5 13.1-84.6 6.8-107 1.1-.5 8.9-1.5 12.7-2.9 14.2-1.9 1.9-16.1 10.1-23.9-1.5-3.5-5.5-5.3-15.5-6.3-24.4-50.4-23.2-73.6-56.6-74.5-58.1-1.1-1.1-12.6-13.1-1.1-27.8 10.8-13.3 46.1-26.6 77.9-32 1.1-27.2 4.3-47.7 8.1-57.1 4.6-10.9 10.4-1.1 15.4 6.3 4.2 5.5 6.7 29.2 6.9 48.1 20.8-1 33.1.5 56.3 4.7 30.2 5.5 50.4 20.9 48.6 38.4-1.3 17.2-17.1 24.3-23.1 24.8-6.3.5-16.1-4-16.1-4-6.7-3.2-.5-6 7.6-9.5 8.8-4.3 6.8-8.7 6.8-8.7-3.3-9.6-42.5-16.3-81.5-16.3-.2 21.5.9 57.2 1.4 78 27.3 5.2 47.7 4.2 47.7 4.2s99.6-2.8 102.6-66.4S218.7 265.4 143 246c-75.6-19.8-118.4-6-122.1-4.1-4 2-.3 2.6-.3 2.6a71.47 71.47 0 0 1 11.2 3c7.5 2.4 1.7 6.3 1.7 6.3-12.9 4.1-27.4 1.5-30.2-4.4s1.9-11.2 7.3-18.8c5.4-8 11.3-7.7 11.3-7.7 93.5-32.4 207.4 26.2 207.4 26.2C336 303.2 354.2 366.6 352.2 391.2zM70 387.9c-10.6 5.2-3.3 12.7-3.3 12.7 19.9 21.4 44.4 34.8 67.7 43.1 2.7-36.9 2.3-49.9 2.6-68.5-36.4 2.5-57.4 8.3-67 12.7zM1042.9 380.3v13.2a5.16 5.16 0 0 1-5.2 5.2h-62.9c0 3.3.1 6.2.1 8.9a480 480 0 0 1-2.7 53.3 5.19 5.19 0 0 1-5.1 4.7h-13.6a4.84 4.84 0 0 1-3.6-1.6 4.75 4.75 0 0 1-1.2-3.8 470.56 470.56 0 0 0 2.8-52.6c0-2.8 0-5.7-.1-8.9h-62.2a5.16 5.16 0 0 1-5.2-5.2v-13.2a5.16 5.16 0 0 1 5.2-5.2h61.3a460.85 460.85 0 0 0-8.1-63.2 4.6 4.6 0 0 1 .9-3.6 4.22 4.22 0 0 1 3.3-1.6h14.7a4.81 4.81 0 0 1 4.7 3.9 507.25 507.25 0 0 1 8 64.5h63.7a5.29 5.29 0 0 1 5.2 5.2z"/><path d="M957.3 275.6a438.92 438.92 0 0 0-771.9-78 5.12 5.12 0 0 0-.6 4.5 4.88 4.88 0 0 0 3.2 3.2l11.4 3.9a7.47 7.47 0 0 0 2 .3 6.59 6.59 0 0 0 5.3-2.8A415.52 415.52 0 0 1 550.6 24.5a416.08 416.08 0 0 1 383.1 253.9 6 6 0 0 0 5.5 3.7h13.6a4.58 4.58 0 0 0 3.9-2.1 4.38 4.38 0 0 0 .6-4.4z" fill="url(#disneyGrad)"/></svg>',
      bgCls: 'bg-sky-50/80 border-sky-100'
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      iconSvg: '<svg class="w-4 h-4 shrink-0 fill-[#10A37F]" viewBox="-1 -.1 949.1 959.8"><path d="m925.8 456.3c10.4 23.2 17 48 19.7 73.3 2.6 25.3 1.3 50.9-4.1 75.8-5.3 24.9-14.5 48.8-27.3 70.8-8.4 14.7-18.3 28.5-29.7 41.2-11.3 12.6-23.9 24-37.6 34-13.8 10-28.5 18.4-44.1 25.3-15.5 6.8-31.7 12-48.3 15.4-7.8 24.2-19.4 47.1-34.4 67.7-14.9 20.6-33 38.7-53.6 53.6-20.6 15-43.4 26.6-67.6 34.4-24.2 7.9-49.5 11.8-75 11.8-16.9.1-33.9-1.7-50.5-5.1-16.5-3.5-32.7-8.8-48.2-15.7s-30.2-15.5-43.9-25.5c-13.6-10-26.2-21.5-37.4-34.2-25 5.4-50.6 6.7-75.9 4.1-25.3-2.7-50.1-9.3-73.4-19.7-23.2-10.3-44.7-24.3-63.6-41.4s-35-37.1-47.7-59.1c-8.5-14.7-15.5-30.2-20.8-46.3s-8.8-32.7-10.6-49.6c-1.8-16.8-1.7-33.8.1-50.7 1.8-16.8 5.5-33.4 10.8-49.5-17-18.9-31-40.4-41.4-63.6-10.3-23.3-17-48-19.6-73.3-2.7-25.3-1.3-50.9 4-75.8s14.5-48.8 27.3-70.8c8.4-14.7 18.3-28.6 29.6-41.2s24-24 37.7-34 28.5-18.5 44-25.3c15.6-6.9 31.8-12 48.4-15.4 7.8-24.3 19.4-47.1 34.3-67.7 15-20.6 33.1-38.7 53.7-53.7 20.6-14.9 43.4-26.5 67.6-34.4 24.2-7.8 49.5-11.8 75-11.7 16.9-.1 33.9 1.6 50.5 5.1s32.8 8.7 48.3 15.6c15.5 7 30.2 15.5 43.9 25.5 13.7 10.1 26.3 21.5 37.5 34.2 24.9-5.3 50.5-6.6 75.8-4s50 9.3 73.3 19.6c23.2 10.4 44.7 24.3 63.6 41.4 18.9 17 35 36.9 47.7 59 8.5 14.6 15.5 30.1 20.8 46.3 5.3 16.1 8.9 32.7 10.6 49.6 1.8 16.9 1.8 33.9-.1 50.8-1.8 16.9-5.5 33.5-10.8 49.6 17.1 18.9 31 40.3 41.4 63.6zm-333.2 426.9c21.8-9 41.6-22.3 58.3-39s30-36.5 39-58.4c9-21.8 13.7-45.2 13.7-68.8v-223q-.1-.3-.2-.7-.1-.3-.3-.6-.2-.3-.5-.5-.3-.3-.6-.4l-80.7-46.6v269.4c0 2.7-.4 5.5-1.1 8.1-.7 2.7-1.7 5.2-3.1 7.6s-3 4.6-5 6.5a32.1 32.1 0 0 1 -6.5 5l-191.1 110.3c-1.6 1-4.3 2.4-5.7 3.2 7.9 6.7 16.5 12.6 25.5 17.8 9.1 5.2 18.5 9.6 28.3 13.2 9.8 3.5 19.9 6.2 30.1 8 10.3 1.8 20.7 2.7 31.1 2.7 23.6 0 47-4.7 68.8-13.8zm-455.1-151.4c11.9 20.5 27.6 38.3 46.3 52.7 18.8 14.4 40.1 24.9 62.9 31s46.6 7.7 70 4.6 45.9-10.7 66.4-22.5l193.2-111.5.5-.5q.2-.2.3-.6.2-.3.3-.6v-94l-233.2 134.9c-2.4 1.4-4.9 2.4-7.5 3.2-2.7.7-5.4 1-8.2 1-2.7 0-5.4-.3-8.1-1-2.6-.8-5.2-1.8-7.6-3.2l-191.1-110.4c-1.7-1-4.2-2.5-5.6-3.4-1.8 10.3-2.7 20.7-2.7 31.1s1 20.8 2.8 31.1c1.8 10.2 4.6 20.3 8.1 30.1 3.6 9.8 8 19.2 13.2 28.2zm-50.2-417c-11.8 20.5-19.4 43.1-22.5 66.5s-1.5 47.1 4.6 70c6.1 22.8 16.6 44.1 31 62.9 14.4 18.7 32.3 34.4 52.7 46.2l193.1 111.6q.3.1.7.2h.7q.4 0 .7-.2.3-.1.6-.3l81-46.8-233.2-134.6c-2.3-1.4-4.5-3.1-6.5-5a32.1 32.1 0 0 1 -5-6.5c-1.3-2.4-2.4-4.9-3.1-7.6-.7-2.6-1.1-5.3-1-8.1v-227.1c-9.8 3.6-19.3 8-28.3 13.2-9 5.3-17.5 11.3-25.5 18-7.9 6.7-15.3 14.1-22 22.1-6.7 7.9-12.6 16.5-17.8 25.5zm663.3 154.4c2.4 1.4 4.6 3 6.6 5 1.9 1.9 3.6 4.1 5 6.5 1.3 2.4 2.4 5 3.1 7.6.6 2.7 1 5.4.9 8.2v227.1c32.1-11.8 60.1-32.5 80.8-59.7 20.8-27.2 33.3-59.7 36.2-93.7s-3.9-68.2-19.7-98.5-39.9-55.5-69.5-72.5l-193.1-111.6q-.3-.1-.7-.2h-.7q-.3.1-.7.2-.3.1-.6.3l-80.6 46.6 233.2 134.7zm80.5-121h-.1v.1zm-.1-.1c5.8-33.6 1.9-68.2-11.3-99.7-13.1-31.5-35-58.6-63-78.2-28-19.5-61-30.7-95.1-32.2-34.2-1.4-68 6.9-97.6 23.9l-193.1 111.5q-.3.2-.5.5l-.4.6q-.1.3-.2.7-.1.3-.1.7v93.2l233.2-134.7c2.4-1.4 5-2.4 7.6-3.2 2.7-.7 5.4-1 8.1-1 2.8 0 5.5.3 8.2 1 2.6.8 5.1 1.8 7.5 3.2l191.1 110.4c1.7 1 4.2 2.4 5.6 3.3zm-505.3-103.2c0-2.7.4-5.4 1.1-8.1.7-2.6 1.7-5.2 3.1-7.6 1.4-2.3 3-4.5 5-6.5 1.9-1.9 4.1-3.6 6.5-4.9l191.1-110.3c1.8-1.1 4.3-2.5 5.7-3.2-26.2-21.9-58.2-35.9-92.1-40.2-33.9-4.4-68.3 1-99.2 15.5-31 14.5-57.2 37.6-75.5 66.4-18.3 28.9-28 62.3-28 96.5v223q.1.4.2.7.1.3.3.6.2.3.5.6.2.2.6.4l80.7 46.6zm43.8 294.7 103.9 60 103.9-60v-119.9l-103.8-60-103.9 60z"/></svg>',
      bgCls: 'bg-emerald-50/80 border-emerald-100'
    },
    {
      id: 'claude',
      name: 'Claude',
      iconSvg: '<svg class="w-4 h-4 shrink-0 fill-[#CC785C]" viewBox="0 0 24 24"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>',
      bgCls: 'bg-amber-50/80 border-amber-100'
    }
  ];

  container.innerHTML = services.map(srv => {
    const rawVal = (unlocks[srv.id] || '检测中...').trim();
    const val = rawVal.toUpperCase();
    let badgeHtml = '';
    
    if (val === '检测中...' || val === 'TESTING' || !rawVal) {
      badgeHtml = '<span class="px-2 py-0.5 rounded text-[11px] font-mono text-slate-400 bg-slate-100 border border-slate-200">检测中</span>';
    } else if (rawVal.includes('超时') || val.includes('TIMEOUT')) {
      badgeHtml = '<span class="px-2 py-0.5 rounded text-[11px] font-mono font-bold text-amber-700 bg-amber-50 border border-amber-200 shadow-2xs whitespace-nowrap">超时</span>';
    } else if (val === 'NO' || rawVal.includes('不可用') || rawVal.includes('限制') || val.includes('FAIL') || val.includes('BLOCK')) {
      const showText = rawVal.includes('不可用') ? '不可用' : (rawVal.includes('限制') ? '受限' : (val === 'NO' ? 'NO' : rawVal));
      badgeHtml = `<span class="px-2 py-0.5 rounded text-[11px] font-mono font-bold text-rose-700 bg-rose-50 border border-rose-200 shadow-2xs whitespace-nowrap">${showText}</span>`;
    } else if (rawVal.includes('自制') || val.includes('ORIGINAL')) {
      badgeHtml = '<span class="px-2 py-0.5 rounded text-[11px] font-mono font-bold text-yellow-700 bg-yellow-50 border border-yellow-200 shadow-2xs whitespace-nowrap">仅自制</span>';
    } else {
      badgeHtml = `<span class="px-2 py-0.5 rounded text-[11px] font-mono font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 shadow-2xs whitespace-nowrap">${rawVal}</span>`;
    }

    return `
      <div class="py-1.5 px-2.5 rounded-xl bg-white border border-slate-200/90 shadow-2xs hover:border-slate-300 hover:shadow-xs transition-all flex items-center justify-between gap-2">
        <div class="flex items-center space-x-2 min-w-0">
          <div class="w-6 h-6 rounded-lg ${srv.bgCls} border flex items-center justify-center shrink-0 shadow-2xs">
            ${srv.iconSvg}
          </div>
          <span class="font-bold text-xs text-slate-800 truncate">${srv.name}</span>
        </div>
        <div class="shrink-0 pl-1">
          ${badgeHtml}
        </div>
      </div>
    `;
  }).join('');
}


function updateServerDetailContent(serverId) {
  const s = state.servers.find(x => x.id === serverId);
  if (!s) return;

  const t = state.telemetry[s.id] || {};
  const isOnline = (s.status === 'online') || (t.status === 'online');
  const inf = (s.info && Object.keys(s.info).length > 0) ? s.info : (t.info || {});
  const m = (s.metrics && Object.keys(s.metrics).length > 0) ? s.metrics : (t.metrics || {});

  document.getElementById('modalFlag').innerHTML = getFlagHtml(s.region, s.flag, 'w-8 h-5.5');
  document.getElementById('modalName').innerText = s.name;
  document.getElementById('modalVirtBadge').innerHTML = formatVirtBadge(inf.virtualization || s.virtualization);
  document.getElementById('modalStatusBadge').innerHTML = isOnline
    ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">在线</span>'
    : '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">离线</span>';

  // Subtitle strictly conceals IP: location, provider tag, arch
  document.getElementById('modalSubtitle').innerText = `${formatLocation(s.location || s.region || '')} · ${s.tag || '云探针'} · 运行中`;

  document.getElementById('modalCpuModel').innerText = inf.cpu_model || 'AMD / Intel 高性能处理器';
  document.getElementById('modalCpuCores').innerText = `${inf.cpu_cores || s.cores || 1} 核心 (${inf.arch || 'x86_64'})`;

  // Calculate accurate CPU and Memory
  const memTotal = inf.mem_total || (s.memoryGB ? s.memoryGB * 1024 * 1024 * 1024 : 0);
  const memUsed = isOnline ? (m.mem_used || 0) : 0;
  const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : (m.mem_percent || 0);
  const swapTotal = inf.swap_total || 0;
  const swapUsed = isOnline ? (m.swap_used || 0) : 0;
  const swapPct = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;

  // Detail Modal Spec Card: Display RAM Used/Total and Swap Used/Total
  const memEl = document.getElementById('modalMemTotal');
  if (memEl) {
    memEl.innerHTML = `
      <div class="space-y-0.5 font-mono">
        <div><span class="text-slate-400">RAM:</span> <b class="text-indigo-600 font-bold">${formatBytes(memUsed, 1)}</b> / ${formatBytes(memTotal, 1)}</div>
        ${swapTotal > 0 ? `<div><span class="text-slate-400">Swap:</span> <b class="text-amber-600 font-bold">${formatBytes(swapUsed, 1)}</b> / ${formatBytes(swapTotal, 1)}</div>` : ''}
      </div>
    `;
  }

  const diskTotal = inf.disk_total || (s.diskGB ? s.diskGB * 1024 * 1024 * 1024 : 0) || (50 * 1024 * 1024 * 1024);
  const diskUsed = isOnline ? (m.disk_used || (inf.disk_total ? Math.round(inf.disk_total * 0.45) : 0)) : 0;
  const diskPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;
  const diskEl = document.getElementById('modalDiskTotal');
  if (diskEl) {
    diskEl.innerHTML = `
      <div class="space-y-0.5 font-mono">
        <div><b class="text-blue-600 font-bold">${formatBytes(diskUsed, 1)}</b> / ${formatBytes(diskTotal, 1)}</div>
        <div class="text-slate-400 text-[10px]">占用率: <b class="text-slate-700">${diskPct}%</b></div>
      </div>
    `;
  }

  // Detail Modal OS: Full complete version
  const osEl = document.getElementById('modalOs');
  if (osEl) osEl.innerText = inf.os || 'Debian 12 (bookworm)';

  const liveCpuEl = document.getElementById('modalLiveCpu') || document.getElementById('modalCpuLatestVal');
  if (liveCpuEl) liveCpuEl.innerText = `${Math.round(m.cpu_usage || 0)}%`;

  const liveMemEl = document.getElementById('modalLiveMem') || document.getElementById('modalMemLatestVal');
  if (liveMemEl) {
    liveMemEl.innerHTML = swapTotal > 0
      ? `<span class="text-indigo-600 font-bold">RAM ${memPct}%</span> <span class="text-slate-300 font-normal">·</span> <span class="text-amber-600 font-bold">Swap ${swapPct}%</span>`
      : `<span class="text-indigo-600 font-bold">${memPct}%</span> (${formatBytes(memUsed, 1)} / ${formatBytes(memTotal, 1)})`;
  }

  // Update Monthly Traffic Card in Modal
  const trCard = document.getElementById('modalMonthlyTrafficCard');
  if (trCard) {
    const tr = s.traffic || {};
    const limitGB = Number(s.trafficLimitGB) || 0;
    const badgeEl = document.getElementById('modalTrafficBadge');
    const barEl = document.getElementById('modalTrafficProgressBar');
    const numEl = document.getElementById('modalTrafficUsageNumbers');
    const remEl = document.getElementById('modalTrafficRemainingText');
    const resetEl = document.getElementById('modalTrafficResetText');
    const iconBox = document.getElementById('modalTrafficIconBox');

    if (limitGB > 0) {
      trCard.classList.remove('hidden');
      const usedGB = tr.usedGB !== undefined ? tr.usedGB : +(((m.net_rx_total || 0) + (m.net_tx_total || 0)) / (1024 * 1024 * 1024)).toFixed(2);
      const pct = tr.percent !== undefined ? tr.percent : Math.min(100, Math.round((usedGB / limitGB) * 100));
      const remainingGB = tr.remainingGB !== undefined ? tr.remainingGB : Math.max(0, +(limitGB - usedGB).toFixed(2));
      const isWarn = pct >= (s.trafficAlertPercent || 80);
      const isMod = pct >= 60;

      if (badgeEl) {
        badgeEl.className = `px-2 py-0.5 rounded text-[10px] font-bold border ${isWarn ? 'bg-rose-50 text-rose-700 border-rose-200 animate-pulse' : (isMod ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200')}`;
        badgeEl.textContent = isWarn ? `🔴 临近上限 (${pct}%)` : (isMod ? `🟡 流量适中 (${pct}%)` : `🟢 流量充沛 (${pct}%)`);
      }
      if (barEl) {
        barEl.style.width = `${pct}%`;
        barEl.className = `h-full rounded-full transition-all duration-500 bg-gradient-to-r ${isWarn ? 'from-rose-500 to-red-600' : (isMod ? 'from-amber-400 to-amber-500' : 'from-emerald-400 to-teal-500')}`;
      }
      if (numEl) numEl.textContent = `${usedGB} / ${limitGB} GB`;
      if (remEl) remEl.textContent = `剩余可用: ${remainingGB} GB`;
      if (resetEl) resetEl.textContent = `每月 ${s.trafficResetDay || 1} 号重置 · 距下次重置还剩 ${tr.daysRemaining !== undefined ? tr.daysRemaining : '--'} 天`;
      if (iconBox) {
        iconBox.className = `w-7 h-7 rounded-xl border flex items-center justify-center shrink-0 ${isWarn ? 'bg-rose-50 text-rose-600 border-rose-100' : (isMod ? 'bg-amber-50 text-amber-600 border-amber-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100')}`;
      }
    } else {
      // Unlimited
      trCard.classList.remove('hidden');
      if (badgeEl) {
        badgeEl.className = 'px-2 py-0.5 rounded text-[10px] font-semibold border bg-slate-100 text-slate-600 border-slate-200';
        badgeEl.textContent = '⚪ 不限流量';
      }
      if (barEl) {
        barEl.style.width = '100%';
        barEl.className = 'h-full rounded-full transition-all duration-500 bg-gradient-to-r from-indigo-400 to-purple-500';
      }
      if (numEl) numEl.textContent = '无限配额';
      if (remEl) remEl.textContent = '无上限限制';
      if (resetEl) resetEl.textContent = '全月无休畅享高速网络带宽';
      if (iconBox) {
        iconBox.className = 'w-7 h-7 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 shrink-0';
      }
    }
  }

  const nodeTr = s.traffic || {};
  const bootRx = m.net_rx_total || 0;
  const bootTx = m.net_tx_total || 0;
  const bootTotal = bootRx + bootTx;
  const lifetimeTraffic = Math.max((nodeTr.lifetimeBytes !== undefined) ? nodeTr.lifetimeBytes : bootTotal, bootTotal);

  const ltEl = document.getElementById('modalLifetimeTraffic');
  if (ltEl) ltEl.innerText = formatBytes(lifetimeTraffic, 1);

  const btEl = document.getElementById('modalBootTraffic');
  if (btEl) btEl.innerText = formatBytes(bootTotal, 1);

  const brxEl = document.getElementById('modalBootRx');
  if (brxEl) brxEl.innerText = `↓ ${formatBytes(bootRx, 1)}`;

  const btxEl = document.getElementById('modalBootTx');
  if (btxEl) btxEl.innerText = `↑ ${formatBytes(bootTx, 1)}`;

  const totalTrafficEl = document.getElementById('modalTotalTraffic');
  if (totalTrafficEl) {
    totalTrafficEl.innerText = `总计: ${formatBytes(lifetimeTraffic, 1)} · 启动: ${formatBytes(bootTotal, 1)}`;
  }

  // Render Streaming & AI Unlocks
  const nodeUnlocks = (s.unlocks) || (t.info && t.info.unlocks) || (m.unlocks) || {};
  renderModalUnlocks(nodeUnlocks);

  // Update Client Direct Ping Badge if available
  const clientLat = (state.clientPingResults && state.clientPingResults[s.id] !== undefined) ? state.clientPingResults[s.id] : null;
  const clientDirectEl = document.getElementById('modalClientDirectLatency');
  if (clientDirectEl) {
    if (clientLat !== null) {
      clientDirectEl.innerText = `本地直连: ${clientLat} ms`;
      clientDirectEl.classList.remove('hidden');
    } else {
      clientDirectEl.classList.add('hidden');
    }
  }

  // Render Sparklines with Y-Axis and memory ceiling
  renderSparklines(t.history || [], s);

  // Render Backhaul Routes & Key Services
  renderModalRoutes(s.routes);
  renderModalServices(state.services, state.ssl);

  // Render Latency Chart in Modal
  renderModalLatencyChart(s, t);

  // Render Uptime Timeline in Modal
  const modalUptimeBadge = document.getElementById('modalUptimeSlaBadge');
  const modalUptimeGrid = document.getElementById('modalUptimeBarsGrid');
  const modalUptimeRun = document.getElementById('modalUptimeRunText');

  const sTimeline = s.uptimeTimeline || (t.uptimeTimeline) || [];
  const sUptimePct = s.uptimePercent || (t.uptimePercent) || (isOnline ? '100.0' : '0.0');

  if (modalUptimeBadge) {
    modalUptimeBadge.innerText = `${sUptimePct}% 可用率`;
    if (parseFloat(sUptimePct) >= 99.0) {
      modalUptimeBadge.className = 'font-mono font-bold text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full';
    } else if (parseFloat(sUptimePct) >= 95.0) {
      modalUptimeBadge.className = 'font-mono font-bold text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full';
    } else {
      modalUptimeBadge.className = 'font-mono font-bold text-xs text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full';
    }
  }

  if (modalUptimeRun) {
    modalUptimeRun.innerText = isOnline ? formatUptime(m.uptime || (inf.boot_time ? (Date.now()/1000 - inf.boot_time) : 0)) : '当前离线';
  }

  if (modalUptimeGrid) {
    let barsData = sTimeline;
    if (!barsData || barsData.length === 0) {
      barsData = Array.from({ length: 30 }, (_, i) => ({
        t: Date.now() - (29 - i) * 86400000,
        status: isOnline ? 'online' : (i === 29 ? 'offline' : 'online'),
        uptimePct: isOnline ? 100 : (i === 29 ? 0 : 100)
      }));
    }
    modalUptimeGrid.innerHTML = barsData.map(bar => {
      let bColor = 'bg-emerald-500';
      let statusDesc = '正常在线';
      if (bar.status === 'offline') {
        bColor = 'bg-rose-500';
        statusDesc = '离线异常';
      } else if (bar.status === 'degraded') {
        bColor = 'bg-amber-400';
        statusDesc = '延迟劣化';
      }
      const dateStr = new Date(bar.t).toLocaleDateString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const tip = `${dateStr} · ${statusDesc} (SLA: ${bar.uptimePct || (bar.status === 'online' ? 100 : 0)}%)`;
      return `<div class="flex-1 h-full rounded-xs transition-all duration-200 hover:scale-y-125 cursor-pointer ${bColor}" title="${tip}"></div>`;
    }).join('');
  }

  // Render this VPS's Ping Target Speeds (针对当前节点的测速结果 - 品牌图标 + 进度条视效)
  const pingGrid = document.getElementById('modalPingTargetsGrid');
  if (pingGrid) {
    const targets = state.pingTargets || [];
    const pings = (m.pings) || (s.metrics && s.metrics.pings) || (t.metrics && t.metrics.pings) || {};

    if (targets.length === 0) {
      pingGrid.innerHTML = `<div class="col-span-full py-4 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">后台暂未配置测速目标</div>`;
    } else {
      pingGrid.innerHTML = targets.map(tgt => {
        const pingVal = isOnline ? pings[tgt.id] : undefined;
        const meta = getTargetCarrierMeta(tgt);
        let badgeHtml = '';
        let barColor = 'bg-slate-300';
        let barWidth = 0;
        let qualityLabel = '未测速';

        if (!isOnline) {
          badgeHtml = '<span class="px-2 py-0.5 rounded-md text-[11px] font-mono text-slate-400 bg-slate-100 border border-slate-200">离线</span>';
          barWidth = 0;
          qualityLabel = '节点离线';
        } else if (pingVal === undefined || pingVal === null) {
          badgeHtml = '<span class="px-2 py-0.5 rounded-md text-[11px] font-mono text-slate-400 bg-slate-100 border border-slate-200">探测中...</span>';
          barWidth = 10;
          barColor = 'bg-slate-300';
          qualityLabel = '等待上报';
        } else if (pingVal < 0) {
          badgeHtml = '<span class="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold text-rose-600 bg-rose-50 border border-rose-200">超时</span>';
          barWidth = 100;
          barColor = 'bg-rose-500';
          qualityLabel = '网络超时';
        } else if (pingVal <= 80) {
          badgeHtml = `<span class="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold text-emerald-700 bg-emerald-50 border border-emerald-200">${pingVal} ms</span>`;
          barWidth = Math.min(100, Math.max(8, Math.round((pingVal / 250) * 100)));
          barColor = 'bg-emerald-500';
          qualityLabel = '极速直连';
        } else if (pingVal <= 180) {
          badgeHtml = `<span class="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold text-amber-700 bg-amber-50 border border-amber-200">${pingVal} ms</span>`;
          barWidth = Math.min(100, Math.max(8, Math.round((pingVal / 250) * 100)));
          barColor = 'bg-amber-500';
          qualityLabel = '延迟适中';
        } else {
          badgeHtml = `<span class="px-2 py-0.5 rounded-md text-[11px] font-mono font-bold text-rose-700 bg-rose-50 border border-rose-200">${pingVal} ms</span>`;
          barWidth = Math.min(100, Math.max(8, Math.round((pingVal / 250) * 100)));
          barColor = 'bg-rose-500';
          qualityLabel = '延迟偏高';
        }

        return `
          <div class="p-2.5 sm:p-3 rounded-xl bg-slate-50/70 border border-slate-200/90 hover:bg-slate-100/60 transition-all flex flex-col justify-between space-y-2">
            <div class="flex items-center justify-between">
              <div class="flex items-center space-x-2.5 min-w-0 pr-2">
                <div class="w-8 h-8 rounded-lg ${meta.badgeCls} border flex items-center justify-center shrink-0 shadow-2xs">
                  ${meta.iconSvg}
                </div>
                <div class="min-w-0">
                  <div class="flex items-center space-x-1.5">
                    <span class="font-bold text-xs text-slate-800 truncate">${tgt.name}</span>
                    <span class="px-1.5 py-0.2 rounded text-[9px] font-medium ${meta.tagCls}">${meta.shortBrand}</span>
                  </div>
                  <div class="text-[10px] text-slate-400 font-mono truncate">${tgt.group || meta.brand}</div>
                </div>
              </div>
              <div class="shrink-0 text-right">
                ${badgeHtml}
              </div>
            </div>
            <!-- Latency Progress Bar -->
            <div class="w-full space-y-1 pt-0.5">
              <div class="w-full bg-slate-200/70 rounded-full h-1.5 overflow-hidden">
                <div class="h-full rounded-full transition-all duration-300 ${barColor}" style="width: ${barWidth}%"></div>
              </div>
              <div class="flex justify-between items-center text-[9px] text-slate-400 font-mono">
                <span>${qualityLabel}</span>
                <span>${(pingVal !== undefined && pingVal !== null && pingVal >= 0) ? pingVal + ' ms' : (pingVal < 0 ? 'Timeout' : 'N/A')}</span>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  }
  if (window.lucide) lucide.createIcons();
}

function setModalLoadRange(range) {
  if (range === '1d') range = '24h';
  state.modalLoadRange = range;
  ['1h', '6h', '12h', '24h'].forEach(r => {
    const btn = document.getElementById(`modalLoadRange_${r}`) ||
                document.getElementById(`rangeBtn-${r}`) ||
                (r === '24h' ? document.getElementById('rangeBtn-1d') : null);
    if (btn) {
      if (r === range) {
        btn.className = 'px-2 py-0.5 rounded-md font-semibold transition-all cursor-pointer bg-white text-indigo-600 shadow-2xs';
      } else {
        btn.className = 'px-2 py-0.5 rounded-md text-slate-600 hover:text-slate-900 transition-all cursor-pointer';
      }
    }
  });

  if (state.selectedServerId) {
    state.lastMetricsFetchTime = Date.now();
    fetchModalMetricsHistory(state.selectedServerId, range);
  }
}

function setModalLatencyRange(range) {
  if (range === '1d') range = '24h';
  state.modalLatencyRange = range;

  ['1h', '6h', '12h', '24h'].forEach(r => {
    const btn = document.getElementById(`modalLatencyRange_${r}`) ||
                document.getElementById(`modalRange_${r}`) ||
                document.getElementById(`latencyRangeBtn-${r}`) ||
                (r === '24h' ? document.getElementById('latencyRangeBtn-1d') : null);
    if (btn) {
      if (r === range) {
        btn.className = 'px-2 py-0.5 rounded font-semibold transition-all cursor-pointer bg-indigo-50 text-indigo-600';
      } else {
        btn.className = 'px-2 py-0.5 rounded text-slate-500 hover:text-slate-800 transition-all cursor-pointer';
      }
    }
  });

  if (state.selectedServerId) {
    const server = state.servers.find(x => x.id === state.selectedServerId);
    if (server) {
      renderModalLatencyChart(server);
    }
  }
}

window.setModalLoadRange = setModalLoadRange;
window.setModalLatencyRange = setModalLatencyRange;

async function fetchModalMetricsHistory(nodeId, range = '1h') {
  try {
    const res = await fetch(`/api/node/metrics-history?nodeId=${nodeId}&range=${range}&t=${Date.now()}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;

    if (state.selectedServerId !== nodeId) return;
    const server = state.servers.find(x => x.id === nodeId);
    renderSparklinesWithData(data, server);
  } catch (err) {
    console.error('Failed to fetch modal metrics history:', err);
  }
}

function renderSparklinesWithData(data, server) {
  const cpuCanvas = document.getElementById('modalCpuChart');
  const memCanvas = document.getElementById('modalMemChart');
  if (!cpuCanvas || !memCanvas) return;

  const labels = data.labels || [];
  const cpuData = data.cpu || [];
  const memTotalGB = data.memTotalGB || (server?.info?.mem_total ? +(server.info.mem_total / (1024**3)).toFixed(1) : 4.0);
  const swapTotalGB = data.swapTotalGB || (server?.info?.swap_total ? +(server.info.swap_total / (1024**3)).toFixed(1) : 2.0);

  // Convert mem percent into GB for physical ceiling scale
  const memDataInGB = (data.mem || []).map(p => +( (Number(p || 0) / 100) * memTotalGB ).toFixed(2));
  const swapDataInGB = (data.swap || []).map(p => +( (Number(p || 0) / 100) * swapTotalGB ).toFixed(2));

  // Common X-axis configuration with clean timestamps
  const commonXAxis = {
    display: true,
    grid: { display: false },
    ticks: {
      maxTicksLimit: 6,
      font: { size: 9, family: 'ui-monospace, monospace' },
      color: '#94a3b8'
    }
  };

  // CPU Chart Options (Y-axis: 0% ~ 100%)
  const cpuChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        titleFont: { size: 10 },
        bodyFont: { size: 10, family: 'ui-monospace, monospace' },
        callbacks: {
          label: ctx => ` CPU: ${ctx.raw}%`
        }
      }
    },
    scales: {
      x: commonXAxis,
      y: {
        min: 0,
        max: 100,
        display: true,
        ticks: {
          callback: v => v + '%',
          stepSize: 50,
          font: { size: 9, family: 'ui-monospace, monospace' },
          color: '#94a3b8'
        },
        grid: { color: 'rgba(241, 245, 249, 1)' }
      }
    },
    elements: {
      point: { radius: 0 },
      line: { tension: 0.35 }
    }
  };

  // Memory Chart Options (Y-axis: Upper bound is memory capacity)
  const memChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        titleFont: { size: 10 },
        bodyFont: { size: 10, family: 'ui-monospace, monospace' },
        callbacks: {
          label: ctx => {
            const isRam = ctx.datasetIndex === 0;
            const cap = isRam ? memTotalGB : swapTotalGB;
            const pct = cap > 0 ? Math.round((ctx.raw / cap) * 100) : 0;
            return ` ${ctx.dataset.label}: ${ctx.raw} GB (${pct}%)`;
          }
        }
      }
    },
    scales: {
      x: commonXAxis,
      y: {
        min: 0,
        max: Math.max(0.5, memTotalGB),
        display: true,
        ticks: {
          callback: v => v.toFixed(1) + 'G',
          stepSize: +(memTotalGB / 2).toFixed(1),
          font: { size: 9, family: 'ui-monospace, monospace' },
          color: '#94a3b8'
        },
        grid: { color: 'rgba(241, 245, 249, 1)' }
      }
    },
    elements: {
      point: { radius: 0 },
      line: { tension: 0.35 }
    }
  };

  // Update or Create CPU Chart
  if (state.modalCpuChart) {
    state.modalCpuChart.data.labels = labels;
    state.modalCpuChart.data.datasets[0].data = cpuData;
    state.modalCpuChart.options.scales.x = commonXAxis;
    state.modalCpuChart.update('none');
  } else {
    state.modalCpuChart = new Chart(cpuCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'CPU',
          data: cpuData,
          borderColor: '#4f46e5',
          backgroundColor: 'rgba(79, 70, 229, 0.12)',
          fill: true,
          borderWidth: 2
        }]
      },
      options: cpuChartOptions
    });
  }

  // Update or Create Memory Chart
  if (state.modalMemChart) {
    state.modalMemChart.data.labels = labels;
    state.modalMemChart.data.datasets[0].data = memDataInGB;
    if (state.modalMemChart.data.datasets[1]) {
      state.modalMemChart.data.datasets[1].data = swapDataInGB;
    }
    state.modalMemChart.options.scales.x = commonXAxis;
    state.modalMemChart.options.scales.y.max = Math.max(0.5, memTotalGB);
    state.modalMemChart.update('none');
  } else {
    state.modalMemChart = new Chart(memCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'RAM 物理内存',
            data: memDataInGB,
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.12)',
            fill: true,
            borderWidth: 2
          },
          {
            label: 'Swap 交换分区',
            data: swapDataInGB,
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.08)',
            fill: true,
            borderWidth: 1.5,
            borderDash: [4, 4]
          }
        ]
      },
      options: memChartOptions
    });
  }
}

function renderSparklines(history, server) {
  if (server && server.id) {
    fetchModalMetricsHistory(server.id, state.modalLoadRange || '1h');
  }
}

// ---------------------------------------------------------------------
// Render Backhaul Routes & Key Services Monitor in Modal
// ---------------------------------------------------------------------

// Render Backhaul Routes in Modal Sidebar (Compact Vertical Stack)
function renderModalRoutes(routes) {
  const grid = document.getElementById('modalRoutesGrid');
  if (!grid) return;
  const r = routes || { telecom: '电信 163', unicom: '联通 4837', mobile: '移动 CMI' };
  grid.innerHTML = `
    <div class="py-1.5 px-2.5 rounded-xl bg-sky-50/70 border border-sky-200/80 flex items-center justify-between gap-2">
      <div class="flex items-center space-x-2 min-w-0">
        <div class="w-6 h-6 rounded-lg bg-sky-500 text-white flex items-center justify-center font-bold text-[11px] shrink-0 shadow-2xs">电</div>
        <span class="text-xs font-mono font-bold text-sky-900 truncate">${r.telecom || '电信 163'}</span>
      </div>
      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-100 text-sky-700 border border-sky-300/60 shrink-0 font-mono">回程</span>
    </div>
    <div class="py-1.5 px-2.5 rounded-xl bg-amber-50/70 border border-amber-200/80 flex items-center justify-between gap-2">
      <div class="flex items-center space-x-2 min-w-0">
        <div class="w-6 h-6 rounded-lg bg-amber-500 text-white flex items-center justify-center font-bold text-[11px] shrink-0 shadow-2xs">联</div>
        <span class="text-xs font-mono font-bold text-amber-900 truncate">${r.unicom || '联通 4837'}</span>
      </div>
      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-300/60 shrink-0 font-mono">回程</span>
    </div>
    <div class="py-1.5 px-2.5 rounded-xl bg-emerald-50/70 border border-emerald-200/80 flex items-center justify-between gap-2">
      <div class="flex items-center space-x-2 min-w-0">
        <div class="w-6 h-6 rounded-lg bg-emerald-500 text-white flex items-center justify-center font-bold text-[11px] shrink-0 shadow-2xs">移</div>
        <span class="text-xs font-mono font-bold text-emerald-900 truncate">${r.mobile || '移动 CMI'}</span>
      </div>
      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-300/60 shrink-0 font-mono">回程</span>
    </div>
  `;
}

function renderModalServices(services, ssl) {
  const grid = document.getElementById('modalServicesGrid');
  if (!grid) return;
  const sslData = ssl || {
    domain: 'tanz.example.com',
    daysRemaining: 84,
    validTo: '2027-01-20',
    issuer: 'Cloudflare / Let\'s Encrypt'
  };

  grid.innerHTML = `
    <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between">
      <div class="min-w-0">
        <div class="text-[10px] text-slate-500 truncate">HTTPS (Web 443)</div>
        <div class="text-xs font-bold text-slate-800 font-mono mt-0.5">200 OK</div>
      </div>
      <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0 pulse-dot"></span>
    </div>
    <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between">
      <div class="min-w-0">
        <div class="text-[10px] text-slate-500 truncate">SSH 远程端口 (22)</div>
        <div class="text-xs font-bold text-slate-800 font-mono mt-0.5">已开放</div>
      </div>
      <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0"></span>
    </div>
    <div class="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between">
      <div class="min-w-0">
        <div class="text-[10px] text-slate-500 truncate">Docker 容器环境</div>
        <div class="text-xs font-bold text-slate-800 font-mono mt-0.5">Active</div>
      </div>
      <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0"></span>
    </div>
    <div class="p-2.5 rounded-xl bg-emerald-50/80 border border-emerald-200 flex flex-col justify-between">
      <div class="flex items-center justify-between text-[10px] text-emerald-800 font-semibold">
        <span>SSL 证书到期</span>
        <span class="font-mono text-emerald-700">剩余 ${sslData.daysRemaining} 天</span>
      </div>
      <div class="w-full bg-emerald-200/60 rounded-full h-1 mt-1 overflow-hidden">
        <div class="bg-emerald-600 h-1 rounded-full" style="width: ${Math.min(100, Math.round((sslData.daysRemaining / 90) * 100))}%"></div>
      </div>
      <div class="text-[9px] text-emerald-700 font-mono mt-0.5 truncate" title="${sslData.domain}">
        ${sslData.domain}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Add Node Modal Handlers (+ 接入节点)
// ---------------------------------------------------------------------

function openAddNodeModal() {
  const modal = document.getElementById('addNodeModal');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeAddNodeModal() {
  const modal = document.getElementById('addNodeModal');
  if (modal) modal.classList.add('hidden');
  const box = document.getElementById('newNodeCommandBox');
  if (box) box.classList.add('hidden');
}

async function handleAddNodeSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('newNodeName').value.trim();
  const id = document.getElementById('newNodeId').value.trim();
  const region = document.getElementById('newNodeRegion').value.trim();
  const flag = document.getElementById('newNodeFlag').value.trim();
  const location = document.getElementById('newNodeLocation').value.trim();
  const tag = document.getElementById('newNodeTag').value.trim();
  const publicIp = document.getElementById('newNodeIp').value.trim();

  const submitBtn = document.getElementById('submitAddNodeBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = '正在生成命令...';
  }

  try {
    const res = await fetch('/api/servers/add-public', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, id, region, flag, location, tag, publicIp })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || '接入失败，请重试');
      return;
    }

    // Display installation command
    const box = document.getElementById('newNodeCommandBox');
    const textEl = document.getElementById('newNodeCommandText');
    if (box && textEl) {
      textEl.innerText = data.command;
      box.classList.remove('hidden');
    }

    await fetchStatusFallback();
    alert('🎉 节点接入配置成功！请在目标 VPS 终端执行生成的安装命令');
  } catch (err) {
    alert('网络请求失败: ' + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="zap" class="w-3.5 h-3.5"></i><span>生成安装命令并接入</span>';
      if (window.lucide) lucide.createIcons();
    }
  }
}

function copyNewNodeCommand() {
  const text = document.getElementById('newNodeCommandText')?.innerText;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const copyText = document.getElementById('copyCmdText');
    if (copyText) {
      copyText.innerText = '已复制!';
      setTimeout(() => copyText.innerText = '复制命令', 2000);
    }
  });
}


// ---------------------------------------------------------------------


// ---------------------------------------------------------------------
// Server Detail Modal Latency Trend Chart (纯折线走势 + 多时间段切换)
// ---------------------------------------------------------------------

function renderModalLatencyChart(server, telemetryData) {
  const canvas = document.getElementById('modalLatencyChart');
  if (!canvas) return;

  const range = state.modalLatencyRange || '1h';

  // Update Time Range Switcher Buttons
  const ranges = ['1h', '6h', '12h', '24h'];
  ranges.forEach(r => {
    const btn = document.getElementById(`modalLatencyRange_${r}`) ||
                document.getElementById(`modalRange_${r}`) ||
                document.getElementById(`latencyRangeBtn-${r}`) ||
                (r === '24h' ? document.getElementById('latencyRangeBtn-1d') : null);
    if (btn) {
      if (r === range) {
        btn.className = 'px-2 py-0.5 rounded font-semibold transition-all cursor-pointer bg-indigo-50 text-indigo-600';
      } else {
        btn.className = 'px-2 py-0.5 rounded text-slate-500 hover:text-slate-800 transition-all cursor-pointer';
      }
    }
  });

  // Query new endpoint for all targets of this server node
  fetch(`/api/latency/node-history?nodeId=${server.id}&range=${range}`)
    .then(res => res.json())
    .then(data => {
      if (!data || !data.targets || !Array.isArray(data.targets)) return;

      const timestamps = data.timestamps || [];
      const labels = timestamps.map(t => {
        const d = new Date(t * 1000);
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
      });

      // Update multi-target interactive legend pills
      const legendContainer = document.getElementById('modalLatencyLegendBar') || document.getElementById('modalTrendLegend');
      if (legendContainer) {
        legendContainer.innerHTML = data.targets.map((tgt, idx) => {
          const stats = tgt.stats || {};
          const isTargetHidden = state.hiddenTargets && state.hiddenTargets.has(tgt.id);
          return `
            <div onclick="toggleModalLatencyDataset(${idx}, '${tgt.id}')" class="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all cursor-pointer select-none ${isTargetHidden ? 'opacity-40 bg-slate-100 border-slate-200 text-slate-500' : 'bg-white shadow-2xs hover:shadow-xs'}" style="${!isTargetHidden ? `border-color: ${tgt.color}40; color: ${tgt.color};` : ''}" title="点击可隐藏/显示此节点折线">
              <span class="w-2 h-2 rounded-full shrink-0" style="background-color: ${tgt.color};"></span>
              <span class="font-medium text-slate-700">${tgt.name}</span>
              <span class="font-mono font-bold tabular-nums inline-block min-w-[58px] text-right" style="color: ${tgt.color};">${stats.avg > 0 ? Number(stats.avg).toFixed(1) : '--'} ms</span>
              ${stats.lossPercent > 0 ? `<span class="text-[10px] text-rose-500 font-mono">(${stats.lossPercent}%丢包)</span>` : ''}
            </div>
          `;
        }).join('');
      }

      // Build datasets for each target with unique line colors
      const datasets = data.targets.map((tgt, idx) => {
        const isTargetHidden = state.hiddenTargets && state.hiddenTargets.has(tgt.id);
        const lats = tgt.points.map(p => p.lat > 0 ? p.lat : null);
        return {
          label: tgt.name,
          data: lats,
          borderColor: tgt.color,
          backgroundColor: tgt.bgColor || (tgt.color + '18'),
          fill: false,
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: tgt.color,
          spanGaps: true,
          hidden: isTargetHidden
        };
      });

      if (state.modalLatencyChart && state.modalLatencyChart.config.type !== 'line') {
        try { state.modalLatencyChart.destroy(); } catch (e) {}
        state.modalLatencyChart = null;
      }

      if (state.modalLatencyChart) {
        state.modalLatencyChart.data.labels = labels;
        state.modalLatencyChart.data.datasets = datasets;
        state.modalLatencyChart.update('none');
      } else {
        state.modalLatencyChart = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            labels,
            datasets
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: {
              mode: 'index',
              intersect: false
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.92)',
                titleFont: { size: 11, weight: 'bold' },
                bodyFont: { size: 11, family: 'ui-monospace, monospace' },
                padding: 8,
                boxPadding: 4,
                usePointStyle: true,
                callbacks: {
                  label: ctx => ` ${ctx.dataset.label}: ${ctx.raw !== null ? ctx.raw + ' ms' : '超时'}`
                }
              }
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { maxTicksLimit: 6, font: { size: 10 } }
              },
              y: {
                beginAtZero: false,
                grid: { color: 'rgba(241, 245, 249, 1)' },
                ticks: {
                  callback: v => v + ' ms',
                  font: { family: 'ui-monospace, monospace', size: 10 }
                }
              }
            }
          }
        });
      }
    })
    .catch(e => console.error('Error loading modal trend chart:', e));
}

function toggleModalLatencyDataset(datasetIndex, targetId) {
  if (!state.hiddenTargets) state.hiddenTargets = new Set();
  if (state.hiddenTargets.has(targetId)) {
    state.hiddenTargets.delete(targetId);
  } else {
    state.hiddenTargets.add(targetId);
  }
  if (state.selectedServerId) {
    const s = state.servers.find(x => x.id === state.selectedServerId);
    const t = state.telemetry[state.selectedServerId] || {};
    if (s) renderModalLatencyChart(s, t);
  }
}

function setModalTrendRange(range) {
  state.modalLatencyRange = range;
  if (state.selectedServerId) {
    const s = state.servers.find(x => x.id === state.selectedServerId);
    const t = state.telemetry[state.selectedServerId] || {};
    if (s) renderModalLatencyChart(s, t);
  }
}


// ---------------------------------------------------------------------
// Clock & Initializer
// ---------------------------------------------------------------------

function updateClock() {
  const clock = document.getElementById('headerClock');
  if (clock) {
    const d = new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayName = days[d.getDay()];
    const monthName = months[d.getMonth()];
    const dateNum = d.getDate();
    const timeStr = d.toTimeString().split(' ')[0];
    clock.innerText = `${dayName}, ${monthName} ${dateNum} ${timeStr}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setInterval(updateClock, 1000);
  updateClock();

  initWebSocket();
  fetchStatusFallback();
  setTimeout(() => {
    if (state.activeTab === 'latency') {
      renderLatencyMatrix();
      loadLatencyChart();
    }
  }, 500);

  // Fallback status polling every 3s
  setInterval(fetchStatusFallback, 3000);

  // Trigger initial client-to-nodes latency measurement
  setTimeout(() => {
    measureClientLatency();
  }, 600);
  // Auto-calibrate client latency every 45s
  setInterval(() => {
    measureClientLatency();
  }, 45000);
});


// ---------------------------------------------------------------------
// PWA Service Worker & Install Prompt
// ---------------------------------------------------------------------

let deferredPwaPrompt = null;
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?v=43.0').then(reg => {
      console.log('Tarnz PWA ServiceWorker registered with scope:', reg.scope);
    }).catch(err => {
      console.log('PWA ServiceWorker registration skipped:', err);
    });
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
  const btn = document.getElementById('pwaInstallHeaderBtn');
  if (btn) btn.classList.remove('hidden');
});

function triggerPwaInstall() {
  if (!deferredPwaPrompt) return;
  deferredPwaPrompt.prompt();
  deferredPwaPrompt.userChoice.then(() => {
    deferredPwaPrompt = null;
    const btn = document.getElementById('pwaInstallHeaderBtn');
    if (btn) btn.classList.add('hidden');
  });
}

// ---------------------------------------------------------------------
// Client-to-Node Latency Measurement (Visitor Ping)
// ---------------------------------------------------------------------

let isPingingClient = false;

async function testClientToNodesLatency() {
  if (isPingingClient) return;
  isPingingClient = true;

  const btn = document.getElementById('btnClientPing');
  const btnText = document.getElementById('btnClientPingText');
  const desc = document.getElementById('clientPingStatusDesc');

  if (btnText) btnText.innerText = '测速中...';
  if (btn) btn.classList.add('opacity-75');
  if (desc) desc.innerText = '正在向全球各服务器节点并发发起往返延迟测量...';

  try {
    const t0 = performance.now();
    await fetch('/api/client/ping?t=' + Date.now(), { cache: 'no-store' });
    const directMasterRtt = Math.max(10, Math.round(performance.now() - t0));

    const res = await fetch('/api/client/ping-all?t=' + Date.now(), { cache: 'no-store' });
    const data = await res.json();

    if (data.ok) {
      state.clientPingResults = data.latencies || {};
      if (state.clientPingResults['node-la'] !== undefined) {
        state.clientPingResults['node-la'] = directMasterRtt;
      }

      let bestId = null;
      let minLat = Infinity;
      for (const [id, lat] of Object.entries(state.clientPingResults)) {
        if (lat !== null && lat < minLat) {
          minLat = lat;
          bestId = id;
        }
      }
      state.clientPingResults._bestId = bestId;

      const bestServer = state.servers.find(s => s.id === bestId);
      const bestName = bestServer ? `${bestServer.flag || '🌐'} ${bestServer.name}` : '目标节点';

      if (desc) {
        desc.innerHTML = `<span class="text-emerald-600 font-bold">测速完成！</span> 离您当前设备最优线路为 <b class="text-slate-900">${bestName}</b> (本地延迟仅 <b class="text-emerald-600 font-mono">${minLat} ms</b> ⚡)`;
      }

      renderServers();
    }
  } catch (err) {
    console.error('Client ping failed:', err);
    if (desc) desc.innerText = '网络测速超时，请稍后重试';
  } finally {
    isPingingClient = false;
    if (btnText) btnText.innerText = '重新测速';
    if (btn) btn.classList.remove('opacity-75');
    lucide.createIcons();
  }
}


// ---------------------------------------------------------------------
// World Map Modal Controls (全球节点分布与拓扑大图放大弹窗)
// ---------------------------------------------------------------------
function openWorldMapModal() {
  const modal = document.getElementById('worldMapModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  if (window.lucide) {
    lucide.createIcons();
  }
}

function closeWorldMapModal() {
  const modal = document.getElementById('worldMapModal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

window.openWorldMapModal = openWorldMapModal;
window.closeWorldMapModal = closeWorldMapModal;



// ---------------------------------------------------------------------
// Zero-GC Engine Modal Controls (自研 Zero-GC 架构特色弹窗)
// ---------------------------------------------------------------------
function openZeroGcModal() {
  const modal = document.getElementById('zeroGcModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  if (window.lucide) {
    lucide.createIcons();
  }
}

function closeZeroGcModal() {
  const modal = document.getElementById('zeroGcModal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

window.openZeroGcModal = openZeroGcModal;
window.closeZeroGcModal = closeZeroGcModal;

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (typeof closeClientLatencyModal === 'function') closeClientLatencyModal();
    if (typeof closeZeroGcModal === 'function') closeZeroGcModal();
    if (typeof closeWorldMapModal === 'function') closeWorldMapModal();
    if (typeof closeServerDetail === 'function') closeServerDetail();
    if (typeof closeAddNodeModal === 'function') closeAddNodeModal();
  }
});


// ---------------------------------------------------------------------
// Client-to-Nodes Realtime Latency Engine (我到节点的实时延迟测速引擎)
// ---------------------------------------------------------------------
let lastClientLatencyData = null;
let isMeasuringClientLatency = false;

async function measureClientLatency(force = false) {
  if (isMeasuringClientLatency && !force) return;
  isMeasuringClientLatency = true;

  const headerVal = document.getElementById('headerLatencyVal');
  const headerDot = document.getElementById('headerLatencyDot');
  const headerBtn = document.getElementById('headerLatencyBtn');
  const refreshIcon = document.getElementById('clientLatencyRefreshIcon');
  const refreshBtn = document.getElementById('clientLatencyRefreshBtn');

  if (refreshIcon) refreshIcon.classList.add('animate-spin');
  if (refreshBtn) refreshBtn.disabled = true;

  if (headerVal && (headerVal.textContent === '-- ms' || headerVal.textContent === '--')) {
    headerVal.textContent = '测速中...';
  }

  try {
    const t0 = performance.now();
    const res = await fetch('/api/client/ping-all?t=' + Date.now(), { cache: 'no-store' });
    const masterRtt = Math.max(1, Math.round(performance.now() - t0));
    const data = await res.json();

    if (data && data.ok) {
      if (data.latencies) {
        data.latencies['node-la'] = masterRtt;
      }
      if (data.nodes) {
        const laNode = data.nodes.find(n => n.id === 'node-la');
        if (laNode) laNode.latency = masterRtt;
      }

      // Recalculate best node
      let minLat = Infinity;
      let bestId = null;
      let sumLat = 0;
      let count = 0;

      const nodes = data.nodes || [];
      nodes.forEach(n => {
        if (n.online && typeof n.latency === 'number' && n.latency > 0) {
          sumLat += n.latency;
          count++;
          if (n.latency < minLat) {
            minLat = n.latency;
            bestId = n.id;
          }
        }
      });

      data.bestNodeId = bestId;
      data.bestLatency = minLat !== Infinity ? minLat : masterRtt;
      data.avgLatency = count > 0 ? Math.round(sumLat / count) : masterRtt;

      lastClientLatencyData = data;
      renderClientLatencyInHeader(data);
      renderClientLatencyModal(data);
    }
  } catch (err) {
    console.error('Failed to measure client latency:', err);
    if (headerVal && headerVal.textContent === '测速中...') {
      headerVal.textContent = '-- ms';
    }
  } finally {
    isMeasuringClientLatency = false;
    if (refreshIcon) refreshIcon.classList.remove('animate-spin');
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function renderClientLatencyInHeader(data) {
  const headerVal = document.getElementById('headerLatencyVal');
  const headerDot = document.getElementById('headerLatencyDot');
  const headerBtn = document.getElementById('headerLatencyBtn');
  if (!headerVal) return;

  const lat = data.bestLatency;
  headerVal.textContent = lat + ' ms';

  let color = 'text-emerald-600';
  let dotBg = 'bg-emerald-500';
  if (lat > 200) {
    color = 'text-rose-600';
    dotBg = 'bg-rose-500';
  } else if (lat > 120) {
    color = 'text-amber-600';
    dotBg = 'bg-amber-500';
  } else if (lat > 60) {
    color = 'text-teal-600';
    dotBg = 'bg-teal-500';
  }

  headerVal.className = 'font-mono font-bold ' + color;
  if (headerDot) headerDot.className = 'w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ' + dotBg + ' animate-pulse shrink-0';

  const bestNode = (data.nodes || []).find(n => n.id === data.bestNodeId);
  const bestName = bestNode ? bestNode.name : '最优节点';
  if (headerBtn) {
    headerBtn.title = `测速就绪：您到 ${bestName} 延迟仅 ${lat} ms · 点击查看全网各节点实时延迟`;
  }
}

function renderClientLatencyModal(data) {
  if (!data) return;

  // Best Node Card
  const bestNode = (data.nodes || []).find(n => n.id === data.bestNodeId);
  const bestNodeNameEl = document.getElementById('clientBestNodeName');
  const bestNodeRegionEl = document.getElementById('clientBestNodeRegion');
  const bestNodeLatEl = document.getElementById('clientBestNodeLat');

  if (bestNode && bestNodeNameEl) {
    bestNodeNameEl.textContent = (bestNode.flag || '') + ' ' + (bestNode.name || '--');
    if (bestNodeRegionEl) bestNodeRegionEl.textContent = bestNode.location || bestNode.region || '核心节点';
    if (bestNodeLatEl) bestNodeLatEl.textContent = data.bestLatency + ' ms';
  }

  // Avg Latency Card
  const avgLatEl = document.getElementById('clientAvgLat');
  if (avgLatEl) {
    avgLatEl.textContent = (data.avgLatency || '--') + ' ms';
  }

  // Client IP Card
  const clientIpEl = document.getElementById('clientIpText');
  if (clientIpEl) {
    clientIpEl.textContent = data.clientIpMasked || '未知';
  }

  // Node Count & Time
  const nodeCountEl = document.getElementById('clientNodeCount');
  if (nodeCountEl) {
    nodeCountEl.textContent = (data.nodes || []).length;
  }
  const lastTimeEl = document.getElementById('clientLastTestTime');
  if (lastTimeEl) {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    lastTimeEl.textContent = `实测时间: ${h}:${m}:${s}`;
  }

  // Render Node List sorted by latency ascending (online nodes first)
  const listEl = document.getElementById('clientLatencyNodeList');
  if (!listEl) return;

  const sortedNodes = [...(data.nodes || [])].sort((a, b) => {
    if (!a.online) return 1;
    if (!b.online) return -1;
    const latA = typeof a.latency === 'number' && a.latency > 0 ? a.latency : 99999;
    const latB = typeof b.latency === 'number' && b.latency > 0 ? b.latency : 99999;
    return latA - latB;
  });

  listEl.innerHTML = sortedNodes.map(item => {
    const isBest = item.id === data.bestNodeId;
    const lat = item.latency;
    const isOnline = item.online && typeof lat === 'number' && lat > 0;

    let ratingText = '极优';
    let badgeClass = 'bg-emerald-50 text-emerald-700 border border-emerald-200';
    let colorClass = 'text-emerald-600';
    let latStr = lat + ' ms';
    let barPct = Math.max(10, Math.min(100, Math.round(((lat || 50) / 300) * 100)));
    let barBg = 'bg-emerald-500';

    if (!isOnline) {
      ratingText = '离线 / 超时';
      badgeClass = 'bg-rose-50 text-rose-700 border border-rose-200';
      colorClass = 'text-rose-600';
      latStr = '超时';
      barPct = 100;
      barBg = 'bg-rose-400';
    } else if (lat < 60) {
      ratingText = '极优';
      badgeClass = 'bg-emerald-50 text-emerald-700 border border-emerald-200';
      colorClass = 'text-emerald-600';
      barBg = 'bg-emerald-500';
    } else if (lat < 120) {
      ratingText = '良好';
      badgeClass = 'bg-teal-50 text-teal-700 border border-teal-200';
      colorClass = 'text-teal-600';
      barBg = 'bg-teal-500';
    } else if (lat < 200) {
      ratingText = '正常';
      badgeClass = 'bg-amber-50 text-amber-700 border border-amber-200';
      colorClass = 'text-amber-600';
      barBg = 'bg-amber-500';
    } else {
      ratingText = '略高';
      badgeClass = 'bg-orange-50 text-orange-700 border border-orange-200';
      colorClass = 'text-orange-600';
      barBg = 'bg-orange-500';
    }

    return `
      <div class="p-3 sm:p-3.5 bg-white rounded-2xl border ${isBest ? 'border-emerald-300 ring-2 ring-emerald-500/20 bg-emerald-50/10' : 'border-slate-200 hover:border-indigo-300'} transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-2xs group">
        <div class="flex items-center space-x-3 min-w-0">
          <span class="text-2xl shrink-0">${item.flag || '🌐'}</span>
          <div class="min-w-0">
            <div class="flex items-center space-x-2">
              <span class="font-bold text-sm text-slate-900 truncate">${item.name}</span>
              ${isBest ? '<span class="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 shrink-0">⭐ 最优接入</span>' : ''}
              ${item.tag ? `<span class="hidden sm:inline-block px-1.5 py-0.2 rounded text-[10px] bg-slate-100 text-slate-600 shrink-0">${item.tag}</span>` : ''}
            </div>
            <p class="text-xs text-slate-500 truncate">${item.location || item.region || '分布式节点'}</p>
          </div>
        </div>

        <div class="flex items-center justify-between sm:justify-end space-x-3 sm:space-x-4 shrink-0 pt-1.5 sm:pt-0 border-t sm:border-t-0 border-slate-100">
          <!-- Visual Latency Bar -->
          <div class="w-20 sm:w-28 bg-slate-100 rounded-full h-2 overflow-hidden hidden sm:block">
            <div class="h-full ${barBg} rounded-full transition-all duration-300" style="width: ${barPct}%"></div>
          </div>

          <!-- Rating Badge -->
          <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${badgeClass} shrink-0">
            ${ratingText}
          </span>

          <!-- Latency Number -->
          <span class="font-mono font-black text-base sm:text-lg ${colorClass} w-16 sm:w-20 text-right shrink-0">
            ${latStr}
          </span>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) {
    lucide.createIcons();
  }
}

function openClientLatencyModal() {
  const modal = document.getElementById('clientLatencyModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  if (window.lucide) {
    lucide.createIcons();
  }
  // Immediately measure or refresh
  measureClientLatency(true);
}

function closeClientLatencyModal() {
  const modal = document.getElementById('clientLatencyModal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

window.measureClientLatency = measureClientLatency;
window.openClientLatencyModal = openClientLatencyModal;
window.closeClientLatencyModal = closeClientLatencyModal;
