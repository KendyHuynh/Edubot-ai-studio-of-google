import { Language } from '../shared/types';
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
 * - Uses Express `/api/*` when running with a backend (AI Studio, Cloud Run, Render, local dev).
 * - Automatically falls back to browser-local `localStoreApi` on static hosts (GitHub Pages, `vite preview`).
 */
export async function apiRequestJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  lang: Language = 'vi',
): Promise<ApiJsonResponse<T>> {
  if (isStaticHostingEnvironment()) {
    const local = await handleLocalApi(url, {
      method: init.method,
      body: init.body,
    });
    return {
      ok: local.ok,
      status: local.status,
      data: local.data as T,
      fromStaticFallback: true,
    };
  }

  try {
    const res = await fetch(url, init);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

    // Static hosts return 404/405 or HTML (index.html / 404.html) for /api/*
    if (
      res.status === 405 ||
      (res.status === 404 && !contentType.includes('application/json')) ||
      contentType.includes('text/html')
    ) {
      detectedStaticHost = true;
      const local = await handleLocalApi(url, {
        method: init.method,
        body: init.body,
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
        method: init.method,
        body: init.body,
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
