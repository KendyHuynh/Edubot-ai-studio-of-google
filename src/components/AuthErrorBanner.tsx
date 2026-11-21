import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { Language } from '../shared/types';
import { buildFirebaseAuthSettingsUrl } from '../utils/authDomains';

interface AuthErrorBannerProps {
  message: string;
  lang: Language;
  unauthorizedHost?: string | null;
  authorizedFallbackUrl?: string | null;
  suggestNewTab?: boolean;
  tone?: 'error' | 'warning';
}

export function AuthErrorBanner({
  message,
  lang,
  unauthorizedHost,
  authorizedFallbackUrl,
  suggestNewTab = false,
  tone = 'error',
}: AuthErrorBannerProps) {
  const [copiedHost, setCopiedHost] = useState(false);
  const firebaseAuthSettingsUrl = buildFirebaseAuthSettingsUrl();

  const handleCopyHost = async (host: string) => {
    try {
      await navigator.clipboard.writeText(host);
      setCopiedHost(true);
      window.setTimeout(() => setCopiedHost(false), 2000);
    } catch {
      // ignore clipboard restriction
    }
  };

  const containerClass =
    tone === 'warning'
      ? 'bg-amber-50 border-amber-200 text-amber-900'
      : 'bg-rose-50 border-rose-200 text-rose-700';

  return (
    <div
      role={tone === 'warning' ? 'status' : 'alert'}
      className={`p-3.5 rounded-xl border text-xs font-medium leading-relaxed space-y-2.5 ${containerClass}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>{message}</p>
        {suggestNewTab && !unauthorizedHost && typeof window !== 'undefined' && (
          <a
            href={window.location.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-semibold text-sky-700 hover:underline whitespace-nowrap"
          >
            <span>{lang === 'vi' ? 'Mở ở tab mới' : 'Open in new tab'}</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>

      {unauthorizedHost && (
        <div className="pt-2 border-t border-rose-200/80 space-y-2 text-slate-800">
          {authorizedFallbackUrl && (
            <div className="p-2.5 rounded-lg bg-white border border-sky-200 space-y-1.5">
              <p className="text-[11px] font-semibold text-slate-900">
                {lang === 'vi'
                  ? 'Cách nhanh nhất (không cần cấu hình): Mở bằng địa chỉ ứng dụng đã được cấp phép sẵn'
                  : 'Fastest option (no setup needed): Open the pre-authorized Applet URL'}
              </p>
              <a
                href={authorizedFallbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>
                  {lang === 'vi'
                    ? 'Mở Cổng Giáo Viên trên tên miền đã cấp phép'
                    : 'Open Pre-Authorized Teacher Portal'}
                </span>
              </a>
            </div>
          )}

          <p className="font-semibold text-slate-900">
            {lang === 'vi'
              ? `Hoặc cấp phép tên miền "${unauthorizedHost}" trên Firebase (chỉ làm 1 lần):`
              : `Or authorize "${unauthorizedHost}" in Firebase (one-time setup):`}
          </p>
          <ol className="list-decimal list-inside space-y-1 text-[11px] text-slate-700">
            <li>
              {lang === 'vi' ? 'Sao chép tên miền: ' : 'Copy domain: '}
              <code className="px-1.5 py-0.5 rounded bg-white border border-slate-200 font-mono-num text-slate-900">
                {unauthorizedHost}
              </code>
            </li>
            <li>
              {lang === 'vi'
                ? 'Mở Firebase Console → Authentication → Settings → Authorized domains → bấm Add domain.'
                : 'Open Firebase Console → Authentication → Settings → Authorized domains → click Add domain.'}
            </li>
            <li>
              {lang === 'vi'
                ? 'Dán tên miền vừa sao chép → bấm Add → quay lại đây bấm Đăng nhập Google.'
                : 'Paste the domain → click Add → return here and click Sign in with Google.'}
            </li>
          </ol>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => handleCopyHost(unauthorizedHost)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
            >
              {copiedHost ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span>{lang === 'vi' ? 'Đã sao chép!' : 'Copied!'}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>{lang === 'vi' ? 'Sao chép tên miền' : 'Copy domain'}</span>
                </>
              )}
            </button>
            <a
              href={firebaseAuthSettingsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-white bg-sky-600 hover:bg-sky-700 rounded-lg"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>
                {lang === 'vi'
                  ? 'Mở Firebase Authorized domains'
                  : 'Open Firebase Authorized domains'}
              </span>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
