import { Language } from '../shared/types';

const BLOCKED_WEAK_PINS = new Set([
  '2025',
  '2026',
  '0000',
  '1234',
  '123456',
  '000000',
  '111111',
  '654321',
  '12345678',
  'password',
]);

export function validateTeacherPin(
  rawPin: string,
  lang: Language = 'vi',
): { valid: boolean; reason?: string } {
  const pin = rawPin.trim();
  if (pin.length < 6 || pin.length > 32) {
    return {
      valid: false,
      reason:
        lang === 'vi'
          ? 'Mã PIN mới cần dài từ 6 đến 32 ký tự để tránh học sinh đoán được.'
          : 'New PIN must be 6–32 characters long so students cannot guess it.',
    };
  }
  if (/\s/.test(pin)) {
    return {
      valid: false,
      reason:
        lang === 'vi'
          ? 'Mã PIN không được chứa khoảng trắng.'
          : 'PIN must not contain spaces.',
    };
  }
  if (BLOCKED_WEAK_PINS.has(pin.toLowerCase())) {
    return {
      valid: false,
      reason:
        lang === 'vi'
          ? 'Mã PIN này quá dễ đoán (không dùng 2025, 123456...). Hãy chọn mã PIN bảo mật hơn.'
          : 'This PIN is too easy to guess (avoid 2025, 123456). Choose a stronger PIN.',
    };
  }
  return { valid: true };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function hashPinWebCrypto(pin: string): Promise<string> {
  const saltBytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(saltBytes);
  const enc = new TextEncoder();
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    256,
  );
  return `pbkdf2$${bytesToHex(saltBytes)}$${bytesToHex(new Uint8Array(derivedBits))}`;
}

export async function verifyPinWebCrypto(
  pin: string,
  storedHash?: string,
): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith('pbkdf2$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, saltHex, expectedHex] = parts;
  if (!saltHex || !expectedHex || saltHex.length % 2 !== 0) return false;
  try {
    const saltBytes = hexToBytes(saltHex);
    const enc = new TextEncoder();
    const baseKey = await globalThis.crypto.subtle.importKey(
      'raw',
      enc.encode(pin),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const derivedBits = await globalThis.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBytes.buffer as ArrayBuffer,
        iterations: 100_000,
        hash: 'SHA-256',
      },
      baseKey,
      256,
    );
    const actualHex = bytesToHex(new Uint8Array(derivedBits));
    return constantTimeEqualHex(actualHex, expectedHex);
  } catch {
    return false;
  }
}
