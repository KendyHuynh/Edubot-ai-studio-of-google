import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  KeyRound,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { Language } from '../shared/types';
import { apiRequestJson } from '../utils/apiClient';
import { getAdminSessionMeta, setAdminSession } from '../utils/authSession';
import { validateTeacherPin } from '../utils/pinCrypto';

interface AuthStatusData {
  pinConfigured: boolean;
  pinLockedByEnv: boolean;
  adminOnlyMode: boolean;
  adminEmails: string[];
  primaryAdminEmail: string;
  authMethod: 'pin' | 'google' | null;
  adminEmail: string | null;
}

interface AdminSecurityPanelProps {
  lang: Language;
}

export function AdminSecurityPanel({ lang }: AdminSecurityPanelProps) {
  const [status, setStatus] = useState<AuthStatusData | null>(null);
  const [loading, setLoading] = useState(true);

  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmNewPin, setConfirmNewPin] = useState('');
  const [pinSaving, setPinSaving] = useState(false);
  const [pinMessage, setPinMessage] = useState('');
  const [pinError, setPinError] = useState('');

  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [policySaving, setPolicySaving] = useState(false);
  const [policyMessage, setPolicyMessage] = useState('');
  const [policyError, setPolicyError] = useState('');

  const loadAuthStatus = useCallback(async () => {
    try {
      const res = await apiRequestJson<AuthStatusData>(
        '/api/teacher/auth-status',
        {},
        lang,
      );
      if (res.ok && res.data) {
        setStatus(res.data);
      }
    } finally {
      setLoading(false);
    }
  }, [lang]);

  useEffect(() => {
    loadAuthStatus();
  }, [loadAuthStatus]);

  const handleChangePin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinMessage('');
    setPinError('');

    const check = validateTeacherPin(newPin, lang);
    if (!check.valid) {
      setPinError(check.reason || '');
      return;
    }
    if (newPin.trim() !== confirmNewPin.trim()) {
      setPinError(
        lang === 'vi'
          ? 'Mã PIN mới nhập lại không khớp.'
          : 'Confirm PIN does not match.',
      );
      return;
    }

    setPinSaving(true);
    try {
      const res = await apiRequestJson<{
        ok?: boolean;
        token?: string;
        message?: string;
        error?: string;
      }>(
        '/api/teacher/change-pin',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            currentPin: currentPin.trim(),
            newPin: newPin.trim(),
          }),
        },
        lang,
      );
      if (!res.ok) {
        setPinError(
          res.data?.error ||
            (lang === 'vi'
              ? 'Không thể đổi mã PIN.'
              : 'Could not change Teacher PIN.'),
        );
        return;
      }
      if (res.data?.token) {
        const meta = getAdminSessionMeta();
        setAdminSession(res.data.token, {
          authMethod: meta?.authMethod ?? status?.authMethod ?? 'pin',
          adminEmail: meta?.adminEmail ?? status?.adminEmail ?? undefined,
        });
      }
      setCurrentPin('');
      setNewPin('');
      setConfirmNewPin('');
      setPinMessage(
        res.data?.message ||
          (lang === 'vi'
            ? 'Đã đổi mã PIN Giáo viên mới thành công!'
            : 'Teacher PIN updated successfully!'),
      );
      await loadAuthStatus();
    } catch {
      setPinError(
        lang === 'vi'
          ? 'Lỗi kết nối khi đổi mã PIN.'
          : 'Connection error while updating PIN.',
      );
    } finally {
      setPinSaving(false);
    }
  };

  const saveSecurityPolicy = async (next: {
    adminOnlyMode?: boolean;
    adminEmails?: string[];
  }) => {
    setPolicySaving(true);
    setPolicyMessage('');
    setPolicyError('');
    try {
      const res = await apiRequestJson<{
        ok?: boolean;
        token?: string;
        adminOnlyMode?: boolean;
        adminEmails?: string[];
        error?: string;
      }>(
        '/api/teacher/security-settings',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        },
        lang,
      );
      if (!res.ok) {
        setPolicyError(
          res.data?.error ||
            (lang === 'vi'
              ? 'Không thể cập nhật phân quyền Admin.'
              : 'Could not update Admin security settings.'),
        );
        return;
      }
      if (res.data?.token) {
        const meta = getAdminSessionMeta();
        setAdminSession(res.data.token, {
          authMethod: meta?.authMethod ?? status?.authMethod ?? 'google',
          adminEmail: meta?.adminEmail ?? status?.adminEmail ?? undefined,
        });
      }
      setPolicyMessage(
        lang === 'vi'
          ? 'Đã lưu cấu hình bảo mật & phân quyền Admin.'
          : 'Admin security & access control settings saved.',
      );
      await loadAuthStatus();
    } catch {
      setPolicyError(
        lang === 'vi'
          ? 'Lỗi kết nối khi lưu cấu hình bảo mật.'
          : 'Connection error while saving security settings.',
      );
    } finally {
      setPolicySaving(false);
    }
  };

  const handleToggleAdminOnly = () => {
    if (!status || policySaving) return;
    saveSecurityPolicy({ adminOnlyMode: !status.adminOnlyMode });
  };

  const handleAddAdminEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status || policySaving) return;
    const clean = newAdminEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setPolicyError(
        lang === 'vi'
          ? 'Vui lòng nhập đúng định dạng email Google của giáo viên.'
          : 'Please enter a valid Google email address.',
      );
      return;
    }
    const nextList = Array.from(new Set([...status.adminEmails, clean]));
    await saveSecurityPolicy({ adminEmails: nextList });
    setNewAdminEmail('');
  };

  const handleRemoveAdminEmail = (emailToRemove: string) => {
    if (!status || policySaving) return;
    if (emailToRemove.toLowerCase() === status.primaryAdminEmail.toLowerCase()) {
      return;
    }
    const nextList = status.adminEmails.filter(
      (e) => e.toLowerCase() !== emailToRemove.toLowerCase(),
    );
    saveSecurityPolicy({ adminEmails: nextList });
  };

  if (loading || !status) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-6 text-sm text-slate-500">
        {lang === 'vi'
          ? 'Đang tải cài đặt bảo mật & phân quyền...'
          : 'Loading security & admin settings...'}
      </div>
    );
  }

  const signedInViaGoogle = status.authMethod === 'google';

  return (
    <div className="space-y-6">
      {/* Status overview */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
              <span>
                {lang === 'vi'
                  ? 'Phân quyền Admin & Chống học sinh vào nhầm Cổng Giáo Viên'
                  : 'Admin RBAC & Student Lockout Protection'}
              </span>
            </h2>
            <p className="text-sm text-slate-600">
              {lang === 'vi'
                ? 'Mọi link chia sẻ theo lớp (?class=...) đều tự động ẩn nút Cổng Giáo Viên và ẩn đáp án. Học sinh không thể mở hoặc sửa dữ liệu.'
                : 'All shared class links (?class=...) automatically hide the Teacher Portal button and strip answer keys.'}
            </p>
          </div>

          <div className="px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-0.5">
            <p className="font-semibold text-slate-900">
              {signedInViaGoogle
                ? lang === 'vi'
                  ? 'Phiên hiện tại: Google Admin'
                  : 'Active Session: Google Admin'
                : lang === 'vi'
                  ? 'Phiên hiện tại: Mã PIN Giáo viên'
                  : 'Active Session: Teacher PIN'}
            </p>
            {status.adminEmail && (
              <p className="text-slate-500">{status.adminEmail}</p>
            )}
          </div>
        </div>

        {/* Toggle Admin-Only Google Mode */}
        <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <p className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-sky-600" />
              <span>
                {lang === 'vi'
                  ? 'Chế độ Chỉ Admin Google (Khóa hẳn đăng nhập bằng mã PIN)'
                  : 'Admin Google-Only Mode (Disable PIN Login)'}
              </span>
            </p>
            <p className="text-xs text-slate-600 leading-relaxed">
              {lang === 'vi'
                ? 'Khi BẬT chế độ này, ô nhập mã PIN sẽ bị tắt hoàn toàn. Dù học sinh biết đường dẫn /teacher hay /?role=teacher cũng KHÔNG thể nhập PIN — chỉ email Admin Google bên dưới mới vào được.'
                : 'When enabled, the PIN login form is completely disabled. Only authorized Admin Google emails below can access the Teacher Portal.'}
            </p>
          </div>
          <button
            type="button"
            disabled={policySaving}
            onClick={handleToggleAdminOnly}
            className={`px-4 py-2 text-xs font-bold rounded-xl border transition-colors cursor-pointer disabled:opacity-50 ${
              status.adminOnlyMode
                ? 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-100'
            }`}
          >
            {status.adminOnlyMode
              ? lang === 'vi'
                ? 'ĐANG BẬT · Chỉ Admin Google'
                : 'ENABLED · Google Admin Only'
              : lang === 'vi'
                ? 'Đang tắt · Bấm để Bật khóa PIN'
                : 'Disabled · Enable Google-Only Lock'}
          </button>
        </div>

        {policyMessage && (
          <p className="text-xs font-semibold text-emerald-700 flex items-center gap-1.5">
            <Check className="w-4 h-4" />
            <span>{policyMessage}</span>
          </p>
        )}
        {policyError && (
          <p role="alert" className="text-xs font-semibold text-rose-700">
            {policyError}
          </p>
        )}
      </div>

      {/* Change Teacher PIN Card */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-sky-600" />
            <span>
              {status.pinConfigured
                ? lang === 'vi'
                  ? 'Đổi Mã PIN Giáo Viên Mới'
                  : 'Change Teacher PIN'
                : lang === 'vi'
                  ? 'Thiết Lập Mã PIN Giáo Viên Mới'
                  : 'Set Up New Teacher PIN'}
            </span>
          </h3>
          <p className="text-xs text-slate-500">
            {lang === 'vi'
              ? 'Mã PIN được băm bảo mật (không lưu dạng chữ thường), tối thiểu 6 ký tự và chặn các mã dễ đoán như 2025 hoặc 123456. Sau khi đổi, mọi phiên cũ sẽ tự đăng xuất.'
              : 'PIN is securely salted & hashed (min 6 chars, blocks weak PINs like 2025 or 123456). Changing PIN invalidates older sessions.'}
          </p>
        </div>

        {status.pinLockedByEnv ? (
          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
            {lang === 'vi'
              ? 'Mã PIN hiện đang được khóa bằng biến môi trường TEACHER_PIN trong phần Settings -> Secrets. Thầy/cô hãy cập nhật trực tiếp giá trị TEACHER_PIN tại Secrets.'
              : 'PIN is currently controlled by the TEACHER_PIN environment variable in Settings -> Secrets.'}
          </div>
        ) : (
          <form onSubmit={handleChangePin} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            {!signedInViaGoogle && status.pinConfigured && (
              <div className="space-y-1.5">
                <label
                  htmlFor="security-current-pin"
                  className="block text-xs font-semibold text-slate-700"
                >
                  {lang === 'vi' ? 'Mã PIN hiện tại' : 'Current PIN'}
                </label>
                <input
                  id="security-current-pin"
                  type="password"
                  autoComplete="current-password"
                  value={currentPin}
                  onChange={(e) => setCurrentPin(e.target.value)}
                  placeholder="••••••"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="security-new-pin"
                className="block text-xs font-semibold text-slate-700"
              >
                {lang === 'vi'
                  ? 'Mã PIN mới (tối thiểu 6 ký tự)'
                  : 'New PIN (min 6 chars)'}
              </label>
              <input
                id="security-new-pin"
                type="password"
                autoComplete="new-password"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                placeholder="Ví dụ: GiaoVien@2026"
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="security-confirm-pin"
                className="block text-xs font-semibold text-slate-700"
              >
                {lang === 'vi' ? 'Nhập lại mã PIN mới' : 'Confirm New PIN'}
              </label>
              <input
                id="security-confirm-pin"
                type="password"
                autoComplete="new-password"
                value={confirmNewPin}
                onChange={(e) => setConfirmNewPin(e.target.value)}
                placeholder="••••••"
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            <div className="md:col-span-3 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={pinSaving || !newPin.trim() || !confirmNewPin.trim()}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50 rounded-xl cursor-pointer"
              >
                <Shield className="w-4 h-4" />
                <span>
                  {pinSaving
                    ? lang === 'vi'
                      ? 'Đang cập nhật...'
                      : 'Updating...'
                    : lang === 'vi'
                      ? 'Lưu mã PIN mới'
                      : 'Save New PIN'}
                </span>
              </button>

              {pinMessage && (
                <span className="text-xs font-semibold text-emerald-700">
                  {pinMessage}
                </span>
              )}
              {pinError && (
                <span role="alert" className="text-xs font-semibold text-rose-700">
                  {pinError}
                </span>
              )}
            </div>
          </form>
        )}
      </div>

      {/* Authorized Admin Emails RBAC List */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-sky-600" />
            <span>
              {lang === 'vi'
                ? 'Danh sách Email Admin / Giáo viên được phân quyền'
                : 'Authorized Admin & Teacher Emails'}
            </span>
          </h3>
          <p className="text-xs text-slate-500">
            {lang === 'vi'
              ? 'Chỉ các tài khoản Google trong danh sách này mới có quyền đăng nhập vào Cổng Giáo Viên. Mọi email học sinh khác sẽ bị chặn tự động.'
              : 'Only Google accounts listed here can sign in to the Teacher Portal. All other emails are automatically rejected.'}
          </p>
        </div>

        <div className="space-y-2">
          {status.adminEmails.map((email) => {
            const isPrimary =
              email.toLowerCase() === status.primaryAdminEmail.toLowerCase();
            return (
              <div
                key={email}
                className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-slate-900 truncate">
                    {email}
                  </span>
                  {isPrimary && (
                    <span className="text-[11px] font-semibold text-sky-800 bg-sky-100 px-2 py-0.5 rounded-md shrink-0">
                      {lang === 'vi' ? 'Admin chính' : 'Primary Admin'}
                    </span>
                  )}
                </div>
                {!isPrimary && (
                  <button
                    type="button"
                    disabled={policySaving}
                    onClick={() => handleRemoveAdminEmail(email)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700 hover:text-rose-900 cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{lang === 'vi' ? 'Gỡ quyền' : 'Remove'}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <form onSubmit={handleAddAdminEmail} className="flex flex-wrap gap-2.5">
          <input
            type="email"
            value={newAdminEmail}
            onChange={(e) => setNewAdminEmail(e.target.value)}
            placeholder={
              lang === 'vi'
                ? 'Thêm email giáo viên đồng quản trị (vd: giaovien@gmail.com)'
                : 'Add co-teacher Google email'
            }
            className="flex-1 min-w-[240px] px-3.5 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          <button
            type="submit"
            disabled={policySaving || !newAdminEmail.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-xl cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{lang === 'vi' ? 'Thêm quyền Admin' : 'Add Admin'}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
