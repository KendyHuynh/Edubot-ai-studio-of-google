import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  KeyRound,
  Lock,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { Language } from '../shared/types';
import { apiRequestJson } from '../utils/apiClient';
import {
  checkCurrentDomainAuthorization,
  getAuthorizedFallbackPortalUrl,
} from '../utils/authDomains';
import { formatFirebaseAuthError } from '../utils/authErrors';
import { setAdminSession } from '../utils/authSession';
import {
  firebaseGoogleSignIn,
  logoutGoogle,
  waitForAuthReady,
} from '../utils/googleDrive';
import { validateTeacherPin } from '../utils/pinCrypto';
import { AuthErrorBanner } from './AuthErrorBanner';

interface AuthStatusResponse {
  pinConfigured: boolean;
  pinLockedByEnv: boolean;
  adminOnlyMode: boolean;
  primaryAdminEmail: string;
  canFirstRunSetup: boolean;
  isAuthenticated: boolean;
  authMethod: 'pin' | 'google' | null;
  adminEmail: string | null;
  devAppUrl?: string;
  sharedAppUrl?: string;
}

interface TeacherPinGateProps {
  onUnlocked: () => void;
  onBackToStudent: () => void;
  lang: Language;
}

export function TeacherPinGate({
  onUnlocked,
  onBackToStudent,
  lang,
}: TeacherPinGateProps) {
  const [status, setStatus] = useState<AuthStatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [checking, setChecking] = useState(false);
  const [googleChecking, setGoogleChecking] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [errorSuggestNewTab, setErrorSuggestNewTab] = useState(false);
  const [unauthorizedHost, setUnauthorizedHost] = useState<string | null>(null);
  const [domainCheck, setDomainCheck] = useState<{
    checkedLive: boolean;
    authorized: boolean;
    hostname: string;
    authorizedDomains: string[];
  } | null>(null);

  useEffect(() => {
    let active = true;
    const loadStatus = async () => {
      try {
        const [res, domainInfo, currentUser] = await Promise.all([
          apiRequestJson<AuthStatusResponse>('/api/teacher/auth-status', {}, lang),
          checkCurrentDomainAuthorization(),
          waitForAuthReady(),
        ]);
        if (!active) return;

        setDomainCheck(domainInfo);

        if (res.ok && res.data) {
          setStatus(res.data);
          if (res.data.isAuthenticated) {
            onUnlocked();
            return;
          }
        }

        // Silently verify if an authorized Admin Google user is already signed in (or returned from redirect)
        if (currentUser) {
          try {
            const idToken = await currentUser.getIdToken();
            const gRes = await apiRequestJson<{
              ok?: boolean;
              token?: string;
              adminEmail?: string;
            }>(
              '/api/teacher/verify-google',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken }),
              },
              lang,
            );
            if (active && gRes.ok && gRes.data?.token) {
              setAdminSession(gRes.data.token, {
                authMethod: 'google',
                adminEmail: gRes.data.adminEmail,
              });
              onUnlocked();
              return;
            }
          } catch {
            // Fall through to normal gate
          }
        }
      } catch {
        // Non-fatal
      } finally {
        if (active) setLoadingStatus(false);
      }
    };
    loadStatus();
    return () => {
      active = false;
    };
  }, [lang, onUnlocked]);

  const authorizedFallbackUrl =
    typeof window !== 'undefined' && domainCheck
      ? getAuthorizedFallbackPortalUrl(
          window.location.origin,
          domainCheck.authorizedDomains,
          {
            devAppUrl: status?.devAppUrl,
            sharedAppUrl: status?.sharedAppUrl,
          },
          '/teacher',
        )
      : null;

  const handleGoogleAdminSignIn = async () => {
    if (googleChecking) return;
    setGoogleChecking(true);
    setErrorMsg('');
    setErrorSuggestNewTab(false);
    setUnauthorizedHost(null);
    try {
      // Invoke signInWithPopup directly in the click gesture (no preceding awaits!)
      const signInResult = await firebaseGoogleSignIn();
      if (!signInResult?.user) {
        setErrorMsg(
          lang === 'vi'
            ? 'Không thể hoàn tất đăng nhập Google. Vui lòng thử lại.'
            : 'Could not complete Google sign-in. Please try again.',
        );
        return;
      }
      const idToken = await signInResult.user.getIdToken(true);
      const res = await apiRequestJson<{
        ok?: boolean;
        token?: string;
        adminEmail?: string;
        error?: string;
      }>(
        '/api/teacher/verify-google',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        },
        lang,
      );
      if (!res.ok || !res.data?.token) {
        await logoutGoogle().catch(() => undefined);
        setErrorMsg(
          res.data?.error ||
            (lang === 'vi'
              ? 'Tài khoản Google này không có quyền Quản trị / Giáo viên.'
              : 'This Google account is not authorized as an Admin / Teacher.'),
        );
        return;
      }
      setAdminSession(res.data.token, {
        authMethod: 'google',
        adminEmail: res.data.adminEmail,
      });
      onUnlocked();
    } catch (err) {
      const formatted = formatFirebaseAuthError(err, lang);
      if (formatted.code === 'auth/unauthorized-domain' && typeof window !== 'undefined') {
        setUnauthorizedHost(window.location.hostname);
      }
      setErrorSuggestNewTab(formatted.suggestNewTab);
      setErrorMsg(formatted.message);
    } finally {
      setGoogleChecking(false);
    }
  };

  const handleFirstRunSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (checking) return;
    setErrorMsg('');

    const check = validateTeacherPin(pin, lang);
    if (!check.valid) {
      setErrorMsg(check.reason || '');
      return;
    }
    if (pin.trim() !== confirmPin.trim()) {
      setErrorMsg(
        lang === 'vi'
          ? 'Mã PIN nhập lại không khớp.'
          : 'Confirmation PIN does not match.',
      );
      return;
    }

    setChecking(true);
    try {
      const res = await apiRequestJson<{
        ok?: boolean;
        token?: string;
        error?: string;
      }>(
        '/api/teacher/setup-pin',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPin: pin.trim() }),
        },
        lang,
      );
      if (!res.ok || !res.data?.token) {
        setErrorMsg(
          res.data?.error ||
            (lang === 'vi'
              ? 'Không thể thiết lập mã PIN mới.'
              : 'Could not set up Teacher PIN.'),
        );
        return;
      }
      setAdminSession(res.data.token, { authMethod: 'pin' });
      onUnlocked();
    } catch {
      setErrorMsg(
        lang === 'vi'
          ? 'Không thể kết nối máy chủ để thiết lập mã PIN.'
          : 'Cannot reach server to set up PIN.',
      );
    } finally {
      setChecking(false);
    }
  };

  const handleVerifyPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim() || checking) return;
    setChecking(true);
    setErrorMsg('');
    try {
      const res = await apiRequestJson<{
        ok?: boolean;
        token?: string;
        error?: string;
      }>(
        '/api/teacher/verify-pin',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: pin.trim() }),
        },
        lang,
      );
      if (!res.ok || !res.data?.token) {
        setErrorMsg(
          res.data?.error ||
            (lang === 'vi'
              ? 'Mã PIN Giáo viên chưa chính xác.'
              : 'Incorrect Teacher PIN.'),
        );
        return;
      }
      setAdminSession(res.data.token, { authMethod: 'pin' });
      onUnlocked();
    } catch {
      setErrorMsg(
        lang === 'vi'
          ? 'Không thể kết nối máy chủ để xác thực.'
          : 'Cannot reach server for PIN verification.',
      );
    } finally {
      setChecking(false);
    }
  };

  const isFirstRun = Boolean(status?.canFirstRunSetup);
  const isAdminOnly = Boolean(status?.adminOnlyMode);
  const canUsePin = !isAdminOnly && (Boolean(status?.pinConfigured) || isFirstRun);

  return (
    <section className="max-w-md mx-auto py-8">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
        <div className="space-y-2">
          <div className="w-11 h-11 rounded-xl bg-sky-50 border border-sky-200 flex items-center justify-center text-sky-700">
            <Lock className="w-5 h-5" />
          </div>
          <h1 className="text-xl font-bold text-slate-900">
            {lang === 'vi'
              ? 'Cổng Quản Trị Giáo Viên / Admin'
              : 'Teacher & Admin Portal'}
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            {lang === 'vi'
              ? 'Khu vực bảo mật chỉ dành cho Giáo viên được phân quyền quản trị lớp học, bài tập và đáp án.'
              : 'Restricted workspace for authorized Teachers & Admins to manage classes, lessons, and answer keys.'}
          </p>
        </div>

        {loadingStatus ? (
          <div className="py-6 text-center text-sm text-slate-500">
            {lang === 'vi'
              ? 'Đang kiểm tra cấu hình bảo mật...'
              : 'Checking security policy...'}
          </div>
        ) : (
          <>
            {/* Primary Recommended Path: Google Admin RBAC */}
            <div className="space-y-2.5">
              <button
                type="button"
                disabled={googleChecking}
                onClick={handleGoogleAdminSignIn}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-xl cursor-pointer"
              >
                <UserCheck className="w-4 h-4" />
                <span>
                  {googleChecking
                    ? lang === 'vi'
                      ? 'Đang xác thực quyền Admin...'
                      : 'Verifying Admin access...'
                    : lang === 'vi'
                      ? 'Đăng nhập Admin bằng Google (Khuyên dùng)'
                      : 'Sign in with Admin Google Account'}
                </span>
              </button>
              <p className="text-xs text-slate-500 leading-relaxed">
                {lang === 'vi'
                  ? 'Chỉ email Giáo viên / Admin được phân quyền mới mở được cổng quản trị. Tài khoản học sinh sẽ bị từ chối tự động.'
                  : 'Only authorized Admin / Teacher emails can unlock this portal. Student accounts are automatically denied.'}
              </p>
            </div>

            {isAdminOnly ? (
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 leading-relaxed">
                {lang === 'vi'
                  ? 'Chế độ Chỉ Admin Google đang được bật để ngăn học sinh đoán mã PIN. Vui lòng dùng nút Đăng nhập Admin bằng Google ở trên.'
                  : 'Admin Google-Only mode is enabled to block PIN guessing. Please sign in with your authorized Admin Google account above.'}
              </div>
            ) : canUsePin ? (
              <>
                <div className="relative flex items-center">
                  <div className="flex-grow border-t border-slate-200" />
                  <span className="px-3 text-xs font-medium text-slate-400">
                    {lang === 'vi' ? 'hoặc dùng mã PIN Giáo viên' : 'or use Teacher PIN'}
                  </span>
                  <div className="flex-grow border-t border-slate-200" />
                </div>

                {isFirstRun ? (
                  <form onSubmit={handleFirstRunSetup} className="space-y-4">
                    <div className="p-3 rounded-xl bg-sky-50 border border-sky-200 text-xs text-sky-900 leading-relaxed">
                      {lang === 'vi'
                        ? 'Lần đầu thiết lập: Hãy tạo mã PIN bảo mật riêng của thầy/cô (tối thiểu 6 ký tự, không dùng 2025 hoặc 123456) để học sinh không thể vào được.'
                        : 'First-time setup: Create your private Teacher PIN (min 6 characters, avoid weak defaults like 2025 or 123456).'}
                    </div>
                    <div className="space-y-1.5">
                      <label
                        htmlFor="teacher-pin-input"
                        className="block text-sm font-semibold text-slate-800"
                      >
                        {lang === 'vi'
                          ? 'Tạo mã PIN Giáo viên mới (≥ 6 ký tự)'
                          : 'Create New Teacher PIN (≥ 6 chars)'}
                      </label>
                      <input
                        id="teacher-pin-input"
                        type="password"
                        autoComplete="new-password"
                        value={pin}
                        onChange={(e) => setPin(e.target.value)}
                        placeholder="••••••"
                        className="w-full px-4 py-2.5 text-base font-mono-num tracking-widest border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label
                        htmlFor="teacher-pin-confirm"
                        className="block text-sm font-semibold text-slate-800"
                      >
                        {lang === 'vi' ? 'Nhập lại mã PIN mới' : 'Confirm New PIN'}
                      </label>
                      <input
                        id="teacher-pin-confirm"
                        type="password"
                        autoComplete="new-password"
                        value={confirmPin}
                        onChange={(e) => setConfirmPin(e.target.value)}
                        placeholder="••••••"
                        className="w-full px-4 py-2.5 text-base font-mono-num tracking-widest border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={!pin.trim() || !confirmPin.trim() || checking}
                      className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50 rounded-xl cursor-pointer"
                    >
                      <KeyRound className="w-4 h-4" />
                      <span>
                        {checking
                          ? lang === 'vi'
                            ? 'Đang lưu mã PIN...'
                            : 'Saving PIN...'
                          : lang === 'vi'
                            ? 'Lưu mã PIN mới & Mở Cổng Giáo Viên'
                            : 'Save New PIN & Unlock Portal'}
                      </span>
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleVerifyPin} className="space-y-4">
                    <div className="space-y-1.5">
                      <label
                        htmlFor="teacher-pin-input"
                        className="block text-sm font-semibold text-slate-800"
                      >
                        {lang === 'vi'
                          ? 'Nhập mã PIN Giáo viên'
                          : 'Enter Teacher PIN'}
                      </label>
                      <input
                        id="teacher-pin-input"
                        type="password"
                        autoComplete="current-password"
                        value={pin}
                        onChange={(e) => setPin(e.target.value)}
                        placeholder="••••••"
                        className="w-full px-4 py-2.5 text-base font-mono-num tracking-widest border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={!pin.trim() || checking}
                      className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50 rounded-xl cursor-pointer"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      <span>
                        {checking
                          ? lang === 'vi'
                            ? 'Đang xác thực...'
                            : 'Verifying...'
                          : lang === 'vi'
                            ? 'Mở Cổng Giáo Viên'
                            : 'Unlock Teacher Portal'}
                      </span>
                    </button>
                  </form>
                )}
              </>
            ) : null}

            {errorMsg ? (
              <AuthErrorBanner
                message={errorMsg}
                lang={lang}
                unauthorizedHost={unauthorizedHost}
                authorizedFallbackUrl={authorizedFallbackUrl}
                suggestNewTab={errorSuggestNewTab}
                tone="error"
              />
            ) : domainCheck?.checkedLive && !domainCheck.authorized ? (
              <AuthErrorBanner
                message={
                  lang === 'vi'
                    ? `Tên miền "${domainCheck.hostname}" hiện chưa có trong Firebase Authorized domains, nên cửa sổ đăng nhập Google sẽ tự đóng nếu bấm trực tiếp tại đây.`
                    : `Domain "${domainCheck.hostname}" is not yet in Firebase Authorized domains, so the Google sign-in popup will close immediately on this host.`
                }
                lang={lang}
                unauthorizedHost={domainCheck.hostname}
                authorizedFallbackUrl={authorizedFallbackUrl}
                tone="warning"
              />
            ) : null}
          </>
        )}

        <div className="pt-4 border-t border-slate-100">
          <button
            type="button"
            onClick={onBackToStudent}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>
              {lang === 'vi'
                ? 'Quay lại Giao diện Học sinh'
                : 'Back to Student Portal'}
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
