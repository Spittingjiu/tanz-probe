const crypto = require('crypto');

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(candidate, stored) {
  if (typeof candidate !== 'string' || typeof stored !== 'string' || !candidate || !stored) {
    return false;
  }
  if (stored.startsWith('scrypt:')) {
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    const [, salt, hashHex] = parts;
    try {
      const expected = Buffer.from(hashHex, 'hex');
      const actual = crypto.scryptSync(candidate, salt, expected.length);
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch (e) {
      return false;
    }
  }
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateSecret(prefix = 'sec', bytes = 8) {
  const cleanPrefix = String(prefix || 'sec').replace(/[^a-zA-Z0-9_-]/g, '');
  return `${cleanPrefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

function validateSafeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (!h || h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      if (a === 10 || a === 127 || a === 0) return false;
      if (a === 169 && b === 254) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a >= 224) return false;
    }
    if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function normalizeIp(ip) {
  if (!ip) return '';
  let str = String(ip).trim();
  if (str.startsWith('::ffff:')) {
    str = str.slice(7);
  }
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(str)) {
    str = str.split(':')[0];
  }
  if (str.startsWith('[') && str.includes(']')) {
    str = str.slice(1, str.indexOf(']'));
  }
  return str.trim();
}

function maskIp(ip, mode = 'mask') {
  if (!ip || ip === '127.0.0.1' || ip === 'localhost') return ip;
  if (mode === 'plain') return ip;
  if (mode === 'full_hidden') return '***.***.***.***';

  const str = String(ip).trim();
  const parts = str.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.*.*`;
  }
  const v6 = str.split(':');
  if (v6.length > 2) {
    return `${v6[0]}:${v6[1]}:****:****`;
  }
  return '***.***.***';
}

function redactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return {};
  const { adminPassword: _omit, ...safeCfg } = cfg;
  return {
    ...safeCfg,
    hasAdminPassword: Boolean(cfg.adminPassword)
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateSecret,
  validateSafeUrl,
  normalizeIp,
  maskIp,
  redactConfig
};
