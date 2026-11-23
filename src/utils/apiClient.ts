import { Language } from '../shared/types';
import { getAdminToken } from './authSession';
import { handleLocalApi } from './localStoreApi';
import { HtmlInsteadOfJsonError, readJsonSafe } from './safeJson';

let detectedStaticHost = false;

export function isStaticHostingEnvironment(): boolean {
  if (detectedStaticHost) return true;
  if (typeof window === 'undefined') return false;
  const { hostname, protocol } = window.location;
  if (protocol === 'file:' || hostname.endsWith('.github.io')) {
    detectedStaticHost = true;
    return true;
  }
  return false;
}

export interface ApiJsonResponse<T> {
  ok: boolean;
  status: number;
  data: T;
  fromStaticFallback: boolean;
}

/**
 * Transparent API client:
 * - Attaches in-memory Teacher/Admin Authorization Bearer token when authenticated.
 * - Uses Express `/api/*` when running with a backend (AI Studio, Cloud Run, Render, local dev).
 * - Automatically falls back to browser-local `localStoreApi` on static hosts (GitHub Pages, `vite preview`).
 */
export async function apiRequestJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  lang: Language = 'vi',
): Promise<ApiJsonResponse<T>> {
  const token = getAdminToken();
  const headers = new Headers(init.headers ?? {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const learnerToken = headers.get('x-learner-token') ?? undefined;
  const authedInit: RequestInit = { ...init, headers };

  if (isStaticHostingEnvironment()) {
    const local = await handleLocalApi(url, {
      method: authedInit.method,
      body: authedInit.body,
      authToken: token ?? undefined,
      learnerToken,
    });
    return {
      ok: local.ok,
      status: local.status,
      data: local.data as T,
      fromStaticFallback: true,
    };
  }

  try {
    const res = await fetch(url, authedInit);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

    // Static hosts return 404/405 or HTML (index.html / 404.html) for /api/*
    if (
      res.status === 405 ||
      (res.status === 404 && !contentType.includes('application/json')) ||
      contentType.includes('text/html')
    ) {
      detectedStaticHost = true;
      const local = await handleLocalApi(url, {
        method: authedInit.method,
        body: authedInit.body,
        authToken: token ?? undefined,
        learnerToken,
      });
      return {
        ok: local.ok,
        status: local.status,
        data: local.data as T,
        fromStaticFallback: true,
      };
    }

    const data = await readJsonSafe<T>(res, lang);
    return {
      ok: res.ok,
      status: res.status,
      data,
      fromStaticFallback: false,
    };
  } catch (err) {
    if (err instanceof HtmlInsteadOfJsonError) {
      detectedStaticHost = true;
      const local = await handleLocalApi(url, {
        method: authedInit.method,
        body: authedInit.body,
        authToken: token ?? undefined,
        learnerToken,
      });
      return {
        ok: local.ok,
        status: local.status,
        data: local.data as T,
        fromStaticFallback: true,
      };
    }
    throw err;
  }
}
