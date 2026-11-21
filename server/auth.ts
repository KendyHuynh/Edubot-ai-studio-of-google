import crypto from 'crypto';
import {
  AdminSecurityConfig,
  createDefaultAdminSecurity,
  PRIMARY_ADMIN_EMAIL,
} from '../src/shared/seedData';
import { validateTeacherPin } from '../src/utils/pinCrypto';

const FALLBACK_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_FAILED_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000; // 60 seconds

export interface AdminTokenPayload {
  role: 'admin' | 'teacher';
  method: 'pin' | 'google';
  email?: string;
  tv: number; // tokenVersion
  exp: number;
}

function getSigningSecret(): string {
  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  return fromEnv.length >= 16 ? fromEnv : FALLBACK_SESSION_SECRET;
}

export function ensureAdminSecurity(
  existing?: AdminSecurityConfig,
): AdminSecurityConfig {
  const base = createDefaultAdminSecurity(false);
  if (!existing) return base;
  return {
    pinHash: existing.pinHash,
    adminOnlyMode: Boolean(existing.adminOnlyMode),
    adminEmails: normalizeAdminEmails(existing.adminEmails),
    tokenVersion:
      typeof existing.tokenVersion === 'number' && existing.tokenVersion >= 1
        ? existing.tokenVersion
        : 1,
    updatedAt: existing.updatedAt,
  };
}

export function normalizeAdminEmails(
  emails?: string[],
  envAllowlist?: string,
): string[] {
  const set = new Set<string>([PRIMARY_ADMIN_EMAIL.toLowerCase()]);
  const addEmail = (raw: string) => {
    const clean = raw.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) && clean.length <= 200) {
      set.add(clean);
    }
  };
  for (const e of emails ?? []) {
    if (typeof e === 'string') addEmail(e);
  }
  const fromEnv = envAllowlist ?? process.env.ADMIN_EMAILS ?? '';
  for (const part of fromEnv.split(/[,;\s]+/)) {
    if (part) addEmail(part);
  }
  return Array.from(set);
}

export function isAuthorizedAdminEmail(
  email: string | undefined,
  security: AdminSecurityConfig,
): boolean {
  if (!email) return false;
  const clean = email.trim().toLowerCase();
  const allowed = normalizeAdminEmails(security.adminEmails);
  return allowed.includes(clean);
}

export function hashPinScrypt(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin, salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPinScrypt(pin: string, storedHash?: string): boolean {
  if (!storedHash || !storedHash.startsWith('scrypt$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const derived = crypto.scryptSync(pin, salt, 32);
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function verifyEnvPinConstantTime(pin: string, envPin: string): boolean {
  const a = crypto.createHash('sha256').update(pin).digest();
  const b = crypto.createHash('sha256').update(envPin).digest();
  return crypto.timingSafeEqual(a, b);
}

export function isPinStrengthValid(pin: string): { valid: boolean; reason?: string } {
  return validateTeacherPin(pin, 'vi');
}

export function createAdminToken(
  payload: Omit<AdminTokenPayload, 'exp'>,
  secret: string = getSigningSecret(),
): string {
  const fullPayload: AdminTokenPayload = {
    ...payload,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload), 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyAdminToken(
  token: string | undefined,
  expectedTokenVersion: number,
  secret: string = getSigningSecret(),
): AdminTokenPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf-8'),
    ) as AdminTokenPayload;
    if (
      !parsed ||
      typeof parsed.exp !== 'number' ||
      parsed.exp < Date.now() ||
      parsed.tv !== expectedTokenVersion
    ) {
      return null;
    }
    if (parsed.role !== 'admin' && parsed.role !== 'teacher') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function extractBearerToken(authHeader?: string): string | undefined {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return undefined;
  const token = authHeader.slice(7).trim();
  return token || undefined;
}

// Simple in-memory rate limiter for PIN attempts per client IP
const failedPinAttempts = new Map<string, { count: number; lockUntil: number }>();

export function checkPinRateLimit(clientKey: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const rec = failedPinAttempts.get(clientKey);
  if (!rec) return { allowed: true, retryAfterSeconds: 0 };
  if (rec.lockUntil > Date.now()) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((rec.lockUntil - Date.now()) / 1000),
    };
  }
  if (rec.count >= MAX_FAILED_PIN_ATTEMPTS) {
    failedPinAttempts.delete(clientKey);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordFailedPinAttempt(clientKey: string): void {
  const rec = failedPinAttempts.get(clientKey) ?? { count: 0, lockUntil: 0 };
  const nextCount = rec.count + 1;
  failedPinAttempts.set(clientKey, {
    count: nextCount,
    lockUntil: nextCount >= MAX_FAILED_PIN_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0,
  });
}

export function clearPinRateLimit(clientKey: string): void {
  failedPinAttempts.delete(clientKey);
}

export async function verifyFirebaseIdTokenViaRest(
  idToken: string,
  apiKey: string,
): Promise<{ uid: string; email: string; emailVerified: boolean } | null> {
  if (!idToken || !apiKey) return null;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
        apiKey,
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
      }>;
    };
    const user = data.users?.[0];
    if (!user?.localId || !user?.email) return null;
    return {
      uid: user.localId,
      email: user.email,
      emailVerified: Boolean(user.emailVerified),
    };
  } catch {
    return null;
  }
}
