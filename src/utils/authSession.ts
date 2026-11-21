export interface AdminSessionMeta {
  authMethod: 'pin' | 'google';
  adminEmail?: string;
}

// Held strictly in JS memory (never persisted to localStorage or sessionStorage)
let currentAdminToken: string | null = null;
let currentAdminMeta: AdminSessionMeta | null = null;

export function getAdminToken(): string | null {
  return currentAdminToken;
}

export function getAdminSessionMeta(): AdminSessionMeta | null {
  return currentAdminMeta;
}

export function setAdminSession(token: string, meta: AdminSessionMeta): void {
  currentAdminToken = token;
  currentAdminMeta = meta;
}

export function clearAdminSession(): void {
  currentAdminToken = null;
  currentAdminMeta = null;
}
