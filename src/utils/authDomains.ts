import firebaseConfig from '../../firebase-applet-config.json';

export interface DomainAuthCheckResult {
  hostname: string;
  authorized: boolean;
  authorizedDomains: string[];
  checkedLive: boolean;
}

const DOMAIN_CACHE_TTL_MS = 60_000;
let cachedDomains: { domains: string[]; fetchedAt: number; live: boolean } | null = null;

export function normalizeHostname(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Matches Firebase Auth's authorized domain rules:
 * exact hostname match, or valid subdomain of an authorized domain
 * (rejecting partial suffix spoofing like "evil-firebaseapp.com").
 */
export function isHostnameAuthorized(
  hostname: string,
  authorizedDomains: string[],
): boolean {
  const cleanHost = normalizeHostname(hostname);
  if (!cleanHost) return false;

  for (const rawDomain of authorizedDomains) {
    const domain = normalizeHostname(rawDomain);
    if (!domain) continue;
    if (cleanHost === domain) return true;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(domain) && cleanHost.endsWith(`.${domain}`)) {
      return true;
    }
  }
  return false;
}

export function buildFirebaseAuthSettingsUrl(projectId?: string): string {
  const pid = (projectId || firebaseConfig?.projectId || '').trim();
  if (!pid) return 'https://console.firebase.google.com/';
  return `https://console.firebase.google.com/project/${encodeURIComponent(
    pid,
  )}/authentication/settings`;
}

/**
 * Picks the best pre-authorized Applet URL (preferring the live Dev URL when on localhost,
 * or the Shared App URL / first authorized ais-pre-* / ais-dev-* host otherwise)
 * so the teacher can complete Google OAuth immediately when visiting from an unauthorized domain.
 */
export function getAuthorizedFallbackPortalUrl(
  currentOrigin: string,
  authorizedDomains: string[],
  serverUrls?: { devAppUrl?: string; sharedAppUrl?: string },
  portalPath = '/teacher',
): string | null {
  let currentHost = '';
  try {
    currentHost = new URL(currentOrigin).hostname;
  } catch {
    currentHost = currentOrigin;
  }

  if (isHostnameAuthorized(currentHost, authorizedDomains)) {
    return null;
  }

  const isLocalDev =
    normalizeHostname(currentHost) === 'localhost' ||
    normalizeHostname(currentHost) === '127.0.0.1';

  const cleanPath = portalPath.startsWith('/') ? portalPath : `/${portalPath}`;

  const candidates: string[] = [];
  if (isLocalDev && serverUrls?.devAppUrl) candidates.push(serverUrls.devAppUrl);
  if (serverUrls?.sharedAppUrl) candidates.push(serverUrls.sharedAppUrl);
  if (!isLocalDev && serverUrls?.devAppUrl) candidates.push(serverUrls.devAppUrl);

  for (const domain of authorizedDomains) {
    const clean = normalizeHostname(domain);
    if (clean.startsWith('ais-pre-') && clean.endsWith('.run.app')) {
      candidates.push(`https://${clean}`);
    }
  }
  for (const domain of authorizedDomains) {
    const clean = normalizeHostname(domain);
    if (clean.startsWith('ais-dev-') && clean.endsWith('.run.app')) {
      candidates.push(`https://${clean}`);
    }
  }

  for (const rawUrl of candidates) {
    try {
      const parsed = new URL(rawUrl);
      if (isHostnameAuthorized(parsed.hostname, authorizedDomains)) {
        return `${parsed.origin}${cleanPath}`;
      }
    } catch {
      // skip invalid URL
    }
  }

  return null;
}

export async function fetchAuthorizedDomains(
  apiKey: string = firebaseConfig?.apiKey || '',
  fallbackDomains: string[] = firebaseConfig?.authDomain ? [firebaseConfig.authDomain] : [],
): Promise<{ domains: string[]; live: boolean }> {
  if (cachedDomains && Date.now() - cachedDomains.fetchedAt < DOMAIN_CACHE_TTL_MS) {
    return { domains: cachedDomains.domains, live: cachedDomains.live };
  }

  if (!apiKey) {
    return { domains: fallbackDomains, live: false };
  }

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(apiKey)}`,
    );
    if (!res.ok) {
      return { domains: fallbackDomains, live: false };
    }
    const data = (await res.json()) as { authorizedDomains?: string[] };
    const domains = Array.isArray(data.authorizedDomains)
      ? data.authorizedDomains.filter((d): d is string => typeof d === 'string' && d.length > 0)
      : fallbackDomains;
    cachedDomains = { domains, fetchedAt: Date.now(), live: true };
    return { domains, live: true };
  } catch {
    return { domains: fallbackDomains, live: false };
  }
}

export async function checkCurrentDomainAuthorization(): Promise<DomainAuthCheckResult> {
  const hostname =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname
      : '';
  const { domains, live } = await fetchAuthorizedDomains();
  return {
    hostname,
    authorized: live ? isHostnameAuthorized(hostname, domains) : true,
    authorizedDomains: domains,
    checkedLive: live,
  };
}
