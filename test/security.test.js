const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPassword,
  verifyPassword,
  generateSecret,
  validateSafeUrl,
  normalizeIp,
  maskIp,
  redactConfig
} = require('../lib/security');

test('hashPassword & verifyPassword use salted scrypt', () => {
  const hash = hashPassword('StrongPass!2026');
  assert.ok(hash.startsWith('scrypt:'));
  assert.equal(verifyPassword('StrongPass!2026', hash), true);
  assert.equal(verifyPassword('WrongPass', hash), false);
  assert.equal(verifyPassword('', hash), false);
});

test('generateSecret creates cryptographic prefixed secret', () => {
  const s1 = generateSecret('sec_la', 8);
  const s2 = generateSecret('sec_la', 8);
  assert.ok(s1.startsWith('sec_la_'));
  assert.notEqual(s1, s2);
  assert.equal(s1.length, 'sec_la_'.length + 16);
});

test('validateSafeUrl blocks loopback and RFC1918 targets', () => {
  assert.equal(validateSafeUrl('https://hooks.slack.com/services/a/b'), true);
  assert.equal(validateSafeUrl('http://127.0.0.1:5555/hook'), false);
  assert.equal(validateSafeUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(validateSafeUrl('http://10.0.0.5/api'), false);
  assert.equal(validateSafeUrl('http://192.168.1.1/'), false);
  assert.equal(validateSafeUrl('ftp://example.com/file'), false);
});

test('normalizeIp & maskIp format cleanly', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(maskIp('1.2.3.4', 'mask'), '1.2.*.*');
  assert.equal(maskIp('1.2.3.4', 'full_hidden'), '***.***.***.***');
});

test('redactConfig strips adminPassword hash', () => {
  const safe = redactConfig({ adminPassword: 'scrypt:abc:def', siteTitle: 'Tanz' });
  assert.equal('adminPassword' in safe, false);
  assert.equal(safe.hasAdminPassword, true);
  assert.equal(safe.siteTitle, 'Tanz');
});
