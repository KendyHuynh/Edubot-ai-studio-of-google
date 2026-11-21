import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkPinRateLimit,
  clearPinRateLimit,
  createAdminToken,
  ensureAdminSecurity,
  hashPinScrypt,
  isAuthorizedAdminEmail,
  isPinStrengthValid,
  normalizeAdminEmails,
  recordFailedPinAttempt,
  verifyAdminToken,
  verifyPinScrypt,
} from './auth';
import { PRIMARY_ADMIN_EMAIL } from '../src/shared/seedData';

test('scrypt PIN hashing verifies matching PIN and rejects wrong PINs', () => {
  const hash = hashPinScrypt('GiaoVien#99');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(verifyPinScrypt('GiaoVien#99', hash), true);
  assert.equal(verifyPinScrypt('2025', hash), false);
  assert.equal(verifyPinScrypt('', hash), false);
});

test('PIN strength rejects weak defaults like 2025 and 123456', () => {
  assert.equal(isPinStrengthValid('2025').valid, false);
  assert.equal(isPinStrengthValid('123456').valid, false);
  assert.equal(isPinStrengthValid('abc').valid, false);
  assert.equal(isPinStrengthValid('abc def').valid, false);
  assert.equal(isPinStrengthValid('CoMinhAnh@88').valid, true);
});

test('HMAC-SHA256 admin session token validates signature and tokenVersion', () => {
  const secret = 'unit-test-secret-key-at-least-32-chars!!';
  const token = createAdminToken(
    { role: 'admin', method: 'google', email: PRIMARY_ADMIN_EMAIL, tv: 2 },
    secret,
  );
  const valid = verifyAdminToken(token, 2, secret);
  assert.ok(valid);
  assert.equal(valid?.email, PRIMARY_ADMIN_EMAIL);

  // Stale tokenVersion after PIN or policy change is rejected
  assert.equal(verifyAdminToken(token, 3, secret), null);

  // Tampered payload is rejected
  const tampered = `${token.slice(0, -4)}AAAA`;
  assert.equal(verifyAdminToken(tampered, 2, secret), null);
});

test('Admin RBAC email allowlist always retains primary admin and rejects students', () => {
  const sec = ensureAdminSecurity({
    adminOnlyMode: true,
    adminEmails: ['co.giaovien@school.edu.vn'],
    tokenVersion: 1,
  });
  assert.ok(normalizeAdminEmails(sec.adminEmails).includes(PRIMARY_ADMIN_EMAIL));
  assert.equal(isAuthorizedAdminEmail(PRIMARY_ADMIN_EMAIL, sec), true);
  assert.equal(isAuthorizedAdminEmail('co.giaovien@school.edu.vn', sec), true);
  assert.equal(isAuthorizedAdminEmail('hocsinh.5a@gmail.com', sec), false);
});

test('PIN brute-force rate limiter locks out after 5 consecutive failures', () => {
  const ip = 'test-client-ip-99';
  clearPinRateLimit(ip);
  for (let i = 0; i < 4; i++) {
    recordFailedPinAttempt(ip);
    assert.equal(checkPinRateLimit(ip).allowed, true);
  }
  recordFailedPinAttempt(ip);
  const blocked = checkPinRateLimit(ip);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  clearPinRateLimit(ip);
  assert.equal(checkPinRateLimit(ip).allowed, true);
});
