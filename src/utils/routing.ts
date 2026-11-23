import { StudentExperienceMode } from '../shared/types';

export type AppPortal = 'student' | 'teacher';

export interface ParsedEntryParams {
  portal: AppPortal;
  experienceMode: StudentExperienceMode | null;
  classId: string | null;
  tabletNumber: number | null;
  autostart: boolean;
  workspaceCode: string | null;
}

export function parseEntryParams(
  pathname: string,
  search: string,
  hash = '',
): ParsedEntryParams {
  const params = new URLSearchParams(search);
  const roleParam = params.get('role') || params.get('mode');
  const cleanPath = pathname.replace(/\/+$/, '');
  const isTeacherPath =
    cleanPath === '/teacher' ||
    cleanPath.endsWith('/teacher') ||
    cleanPath === '/giao-vien' ||
    cleanPath.endsWith('/giao-vien') ||
    hash.startsWith('#/teacher') ||
    hash.startsWith('#/giao-vien');
  const portal: AppPortal =
    isTeacherPath || roleParam === 'teacher' ? 'teacher' : 'student';

  const rawClass = params.get('class') || params.get('join') || params.get('classId');
  const classId = rawClass ? rawClass.trim().toUpperCase() : null;

  const rawTablet = params.get('tablet');
  const parsedTablet = rawTablet ? Number(rawTablet) : NaN;
  const tabletNumber =
    Number.isInteger(parsedTablet) && parsedTablet >= 1 && parsedTablet <= 10
      ? parsedTablet
      : null;

  const autostart = params.get('autostart') === '1';

  const rawWs = params.get('ws') || params.get('workspace');
  const workspaceCode =
    rawWs && /^[A-Za-z0-9_-]{2,64}$/.test(rawWs.trim()) ? rawWs.trim() : null;

  const isHomePath =
    cleanPath === '/tu-danh-gia' ||
    cleanPath.endsWith('/tu-danh-gia') ||
    cleanPath === '/self-assessment' ||
    cleanPath.endsWith('/self-assessment') ||
    hash.startsWith('#/tu-danh-gia') ||
    hash.startsWith('#/home');

  // If teacher sent a class/tablet join link, enforce classroom focus mode
  let experienceMode: StudentExperienceMode | null = null;
  if (portal === 'student') {
    if (classId || tabletNumber) {
      experienceMode = 'classroom';
    } else if (
      isHomePath ||
      roleParam === 'home' ||
      roleParam === 'self' ||
      roleParam === 'assessment'
    ) {
      experienceMode = 'home';
    } else if (roleParam === 'classroom' || roleParam === 'class') {
      experienceMode = 'classroom';
    }
  }

  return { portal, experienceMode, classId, tabletNumber, autostart, workspaceCode };
}

/**
 * Converts AI Studio development origin (ais-dev-*) to the public Shared App origin (ais-pre-*)
 * so links copied by the teacher always open for students without developer login.
 */
export function resolveShareableOrigin(
  currentOrigin: string,
  serverSharedAppUrl?: string,
): string {
  const cleanCurrent = (currentOrigin || '').replace(/\/+$/, '');
  if (cleanCurrent.includes('ais-dev-')) {
    return cleanCurrent.replace('ais-dev-', 'ais-pre-');
  }
  if (
    serverSharedAppUrl &&
    serverSharedAppUrl.startsWith('http') &&
    !cleanCurrent.startsWith('http://localhost') &&
    !cleanCurrent.startsWith('http://127.0.0.1') &&
    !cleanCurrent.includes('.github.io')
  ) {
    return serverSharedAppUrl.replace(/\/+$/, '').replace('ais-dev-', 'ais-pre-');
  }
  return cleanCurrent || 'http://localhost:3000';
}

/**
 * Preserves project subpath on GitHub Pages (e.g. https://user.github.io/my-repo)
 * while stripping trailing /teacher, /giao-vien, /tu-danh-gia, or /index.html segments.
 */
export function resolveShareableBaseUrl(
  currentOrigin: string,
  currentPathname = '/',
  serverSharedAppUrl?: string,
): string {
  const resolvedOrigin = resolveShareableOrigin(currentOrigin, serverSharedAppUrl);
  let basePath = (currentPathname || '/').replace(/\/index\.html$/i, '');
  basePath = basePath.replace(/\/(teacher|giao-vien|tu-danh-gia|self-assessment)\/?$/i, '');
  basePath = basePath.replace(/\/+$/, '');
  if (!basePath || basePath === '/') {
    return resolvedOrigin;
  }
  return `${resolvedOrigin}${basePath.startsWith('/') ? basePath : `/${basePath}`}`;
}

export function buildStudentJoinUrl(
  baseUrl: string,
  classId: string,
  tabletNumber?: number,
  workspaceCode?: string | null,
): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('class', classId.trim().toUpperCase());
  if (tabletNumber && tabletNumber >= 1 && tabletNumber <= 10) {
    params.set('tablet', String(tabletNumber));
  }
  if (workspaceCode && /^[A-Za-z0-9_-]{2,64}$/.test(workspaceCode.trim())) {
    params.set('ws', workspaceCode.trim());
  }
  return `${cleanBase}/?${params.toString()}`;
}

export function buildHomeAssessmentUrl(
  baseUrl: string,
  workspaceCode?: string | null,
): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('mode', 'home');
  if (workspaceCode && /^[A-Za-z0-9_-]{2,64}$/.test(workspaceCode.trim())) {
    params.set('ws', workspaceCode.trim());
  }
  return `${cleanBase}/?${params.toString()}`;
}

export function buildTeacherPortalUrl(baseUrl: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  // On GitHub Pages or subpath hosts, use ?role=teacher so refreshing never hits 404
  try {
    const parsed = new URL(cleanBase);
    if (
      parsed.hostname.endsWith('.github.io') ||
      (parsed.pathname && parsed.pathname !== '/')
    ) {
      return `${cleanBase}/?role=teacher`;
    }
  } catch {
    // fallback below
  }
  return `${cleanBase}/teacher`;
}
