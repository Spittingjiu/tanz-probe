const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createSslInspector(getConfigFn) {
  let cachedSslInfo = null;
  let lastSslCheck = 0;

  return function getRealSslInfo() {
    const now = Date.now();
    if (cachedSslInfo !== null && now - lastSslCheck < 10 * 60 * 1000) {
      return cachedSslInfo;
    }
    lastSslCheck = now;

    const config = (typeof getConfigFn === 'function' ? getConfigFn() : {}) || {};
    const candidatePaths = [
      process.env.SSL_CERT_PATH,
      config.sslCertPath
    ].filter(Boolean);

    try {
      if (candidatePaths.length === 0 && fs.existsSync('/etc/letsencrypt/live')) {
        const dirs = fs.readdirSync('/etc/letsencrypt/live', { withFileTypes: true });
        for (const d of dirs) {
          if (d.isDirectory() || d.isSymbolicLink()) {
            candidatePaths.push(path.join('/etc/letsencrypt/live', d.name, 'fullchain.pem'));
          }
        }
      }
    } catch (e) {}

    for (const certPath of candidatePaths) {
      try {
        if (fs.existsSync(certPath) && typeof crypto.X509Certificate === 'function') {
          const pem = fs.readFileSync(certPath);
          const x509 = new crypto.X509Certificate(pem);
          const validToMs = Date.parse(x509.validTo);
          const daysRemaining = isNaN(validToMs) ? null : Math.max(0, Math.ceil((validToMs - now) / 86400000));
          const cnMatch = /CN=([^\n,]+)/.exec(x509.subject || '');
          const issuerMatch = /O=([^\n,]+)/.exec(x509.issuer || '') || /CN=([^\n,]+)/.exec(x509.issuer || '');
          const expiresAt = isNaN(validToMs) ? '' : new Date(validToMs).toISOString().slice(0, 10);
          const rawCn = cnMatch ? cnMatch[1].trim() : '';
          cachedSslInfo = {
            domain: config.domain || (rawCn ? (rawCn.startsWith('*.') ? rawCn : `*.${rawCn}`) : 'localhost'),
            status: daysRemaining !== null && daysRemaining > 14 ? 'healthy' : 'warning',
            statusText: daysRemaining !== null && daysRemaining > 14 ? '证书健康生效中' : '证书即将过期',
            issuer: issuerMatch ? issuerMatch[1].trim() : "Let's Encrypt",
            daysRemaining: daysRemaining ?? 0,
            expiresAt
          };
          return cachedSslInfo;
        }
      } catch (e) {}
    }

    cachedSslInfo = null;
    return null;
  };
}

module.exports = { createSslInspector };
