import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  Award,
  CheckCircle2,
  Compass,
  Edit3,
  Flame,
  Gift,
  GraduationCap,
  Layers,
  LogOut,
  Play,
  School,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Star,
  Target,
  Trophy,
  UserCircle2,
  Zap,
} from 'lucide-react';
import { ASSESSMENT_LEVELS } from '../shared/assessmentBank';
import {
  buildCompetencyFocusDeck,
  buildDiagnosticDeck,
  buildLevelChallengeDeck,
  buildVarietySprintDeck,
  computeDomainMasterySummary,
  getLevelMeta,
  getRecommendedCompetencies,
} from '../shared/assessmentEngine';
import { COMPETENCIES_24, COMPETENCY_DOMAINS, getCompetencyById } from '../shared/competencies';
import {
  AssessmentExercise,
  AssessmentExerciseOutcome,
  AssessmentLevel,
  AssessmentSessionAttempt,
  AssessmentSessionMode,
  ClassRoom,
  Language,
  LearnerGradeBand,
  LearnerProfile,
  TeacherAward,
  UiMode,
} from '../shared/types';
import { apiRequestJson } from '../utils/apiClient';
import { formatFirebaseAuthError } from '../utils/authErrors';
import {
  fetchLearnerCloudBundle,
  saveLearnerProfileToFirestore,
} from '../utils/firestoreSync';
import {
  auth,
  firebaseGoogleSignIn,
  logoutGoogle,
} from '../utils/googleDrive';
import { AuthErrorBanner } from './AuthErrorBanner';
import { GoogleSignInButton } from './GoogleSignInButton';
import { SelfAssessmentRunner } from './SelfAssessmentRunner';

const GUEST_UID_STORAGE_KEY = 'edubot_guest_learner_uid_v1';

interface SelfAssessmentHubProps {
  classes: ClassRoom[];
  onSwitchToClassroom: () => void;
  onGoToHonorBoard: () => void;
  lang: Language;
  uiMode: UiMode;
}

interface ActiveSessionConfig {
  title: string;
  mode: AssessmentSessionMode;
  targetLevel?: AssessmentLevel;
  targetCompetencyId?: string;
  exercises: AssessmentExercise[];
}

export function SelfAssessmentHub({
  classes,
  onSwitchToClassroom,
  onGoToHonorBoard,
  lang,
  uiMode,
}: SelfAssessmentHubProps) {
  const [googleUser, setGoogleUser] = useState<User | null>(() => auth.currentUser);
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [attempts, setAttempts] = useState<AssessmentSessionAttempt[]>([]);
  const [awards, setAwards] = useState<TeacherAward[]>([]);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuggestNewTab, setAuthSuggestNewTab] = useState(false);

  // Onboarding / Edit profile modal state
  const [editingProfile, setEditingProfile] = useState(false);
  const [guestModeIntent, setGuestModeIntent] = useState(false);
  const [formFullName, setFormFullName] = useState('');
  const [formClassName, setFormClassName] = useState('');
  const [formSchoolName, setFormSchoolName] = useState('');
  const [formGradeBand, setFormGradeBand] = useState<LearnerGradeBand>('primary');
  const [savingProfile, setSavingProfile] = useState(false);
  const [formError, setFormError] = useState('');

  // Active exercise runner state
  const [activeRun, setActiveRun] = useState<ActiveSessionConfig | null>(null);

  // Sync Firebase auth state for Student Google Login
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setGoogleUser(u);
    });
    return () => unsub();
  }, []);

  const hydrateLearnerData = useCallback(
    async (user: User | null) => {
      setLoading(true);
      try {
        if (user && user.emailVerified) {
          const idToken = await user.getIdToken();
          const [apiRes, cloudBundle] = await Promise.all([
            apiRequestJson<{
              profile: LearnerProfile | null;
              attempts: AssessmentSessionAttempt[];
              awards: TeacherAward[];
            }>(
              `/api/learners/me?uid=${encodeURIComponent(user.uid)}`,
              { headers: { 'x-learner-token': idToken } },
              lang,
            ).catch(() => null),
            fetchLearnerCloudBundle(user.uid).catch(() => ({
              profile: null,
              awards: [] as TeacherAward[],
            })),
          ]);

          const apiProfile = apiRes?.ok ? apiRes.data.profile : null;
          const cloudProfile = cloudBundle.profile;
          // Pick whichever profile has more progress / newer update
          let resolved: LearnerProfile | null = null;
          if (apiProfile && cloudProfile) {
            resolved =
              cloudProfile.totalXp >= apiProfile.totalXp ? cloudProfile : apiProfile;
          } else {
            resolved = cloudProfile ?? apiProfile;
          }

          const mergedAwardsMap = new Map<string, TeacherAward>();
          for (const a of [...(apiRes?.ok ? apiRes.data.awards : []), ...cloudBundle.awards]) {
            mergedAwardsMap.set(a.id, a);
          }
          const mergedAwards = Array.from(mergedAwardsMap.values()).sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          );

          setProfile(resolved);
          setAttempts(apiRes?.ok ? apiRes.data.attempts : []);
          setAwards(mergedAwards);

          if (!resolved || !resolved.profileCompleted) {
            setFormFullName(resolved?.fullName || user.displayName || '');
            setFormClassName(resolved?.className || '');
            setFormSchoolName(resolved?.schoolName || '');
            setFormGradeBand(resolved?.gradeBand || 'primary');
            setEditingProfile(true);
          } else {
            setEditingProfile(false);
          }
          return;
        }

        // Check if returning guest learner exists locally
        const savedGuestUid =
          typeof window !== 'undefined'
            ? window.localStorage.getItem(GUEST_UID_STORAGE_KEY)
            : null;
        if (savedGuestUid) {
          const res = await apiRequestJson<{
            profile: LearnerProfile | null;
            attempts: AssessmentSessionAttempt[];
            awards: TeacherAward[];
          }>(`/api/learners/me?uid=${encodeURIComponent(savedGuestUid)}`, {}, lang);
          if (res.ok && res.data.profile) {
            setProfile(res.data.profile);
            setAttempts(res.data.attempts ?? []);
            setAwards(res.data.awards ?? []);
            setEditingProfile(false);
            return;
          }
        }
        setProfile(null);
        setAttempts([]);
        setAwards([]);
      } finally {
        setLoading(false);
      }
    },
    [lang],
  );

  useEffect(() => {
    void hydrateLearnerData(googleUser);
  }, [googleUser, hydrateLearnerData]);

  const handleGoogleLogin = async () => {
    if (signingIn) return;
    setSigningIn(true);
    setAuthError(null);
    setAuthSuggestNewTab(false);
    try {
      const result = await firebaseGoogleSignIn();
      if (result?.user) {
        setGuestModeIntent(false);
        setGoogleUser(result.user);
      }
    } catch (err) {
      const formatted = formatFirebaseAuthError(err, lang);
      setAuthError(formatted.message);
      setAuthSuggestNewTab(formatted.suggestNewTab);
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    if (googleUser) {
      await logoutGoogle().catch(() => undefined);
    }
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(GUEST_UID_STORAGE_KEY);
    }
    setGoogleUser(null);
    setProfile(null);
    setAttempts([]);
    setAwards([]);
    setGuestModeIntent(false);
    setEditingProfile(false);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = formFullName.trim();
    const cleanClass = formClassName.trim();
    const cleanSchool = formSchoolName.trim();

    if (!cleanName || !cleanClass || !cleanSchool) {
      setFormError(
        lang === 'vi'
          ? 'Vui lòng nhập đầy đủ Họ và tên, Lớp học và Trường học để Thầy/Cô theo dõi và khen thưởng.'
          : 'Please enter Full Name, Class, and School so your teacher can view progress and reward you.',
      );
      return;
    }

    setFormError('');
    setSavingProfile(true);
    try {
      let idToken: string | undefined;
      if (googleUser) {
        idToken = await googleUser.getIdToken();
      }
      const existingGuestUid =
        !googleUser && typeof window !== 'undefined'
          ? window.localStorage.getItem(GUEST_UID_STORAGE_KEY) || undefined
          : undefined;

      const res = await apiRequestJson<{
        profile?: LearnerProfile;
        attempts?: AssessmentSessionAttempt[];
        awards?: TeacherAward[];
        error?: string;
      }>(
        '/api/learners/profile',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            uid: googleUser ? googleUser.uid : profile?.uid || existingGuestUid,
            authType: googleUser ? 'google' : 'guest',
            photoUrl: googleUser?.photoURL || undefined,
            fullName: cleanName,
            className: cleanClass,
            schoolName: cleanSchool,
            gradeBand: formGradeBand,
          }),
        },
        lang,
      );

      if (!res.ok || !res.data.profile) {
        setFormError(
          res.data?.error ||
            (lang === 'vi'
              ? 'Không thể lưu hồ sơ học sinh. Vui lòng thử lại.'
              : 'Could not save learner profile.'),
        );
        return;
      }

      const saved = res.data.profile;
      setProfile(saved);
      setAttempts(res.data.attempts ?? []);
      setAwards((prev) =>
        res.data.awards && res.data.awards.length > prev.length ? res.data.awards : prev,
      );

      if (saved.authType === 'guest' && typeof window !== 'undefined') {
        window.localStorage.setItem(GUEST_UID_STORAGE_KEY, saved.uid);
      }
      if (saved.authType === 'google' && googleUser) {
        void saveLearnerProfileToFirestore(saved);
      }

      setEditingProfile(false);
      setGuestModeIntent(false);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleCompleteRun = async (payload: {
    mode: AssessmentSessionMode;
    targetLevel?: AssessmentLevel;
    targetCompetencyId?: string;
    outcomes: AssessmentExerciseOutcome[];
    maxCombo: number;
  }) => {
    let idToken: string | undefined;
    if (googleUser) {
      idToken = await googleUser.getIdToken().catch(() => undefined);
    }
    const res = await apiRequestJson<{
      profile?: LearnerProfile;
      attempt?: AssessmentSessionAttempt;
      awards?: TeacherAward[];
    }>(
      '/api/learners/assessment-submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          learnerUid: profile?.uid,
          learnerName: profile?.fullName,
          className: profile?.className,
          schoolName: profile?.schoolName,
          gradeBand: profile?.gradeBand,
          ...payload,
        }),
      },
      lang,
    );

    if (res.ok && res.data.profile) {
      setProfile(res.data.profile);
      if (res.data.attempt) {
        setAttempts((prev) => [res.data.attempt!, ...prev].slice(0, 30));
      }
      if (res.data.profile.authType === 'google' && googleUser) {
        void saveLearnerProfileToFirestore(res.data.profile);
      }
    }
  };

  const mastery = profile?.masteryByCompetency ?? {};
  const domainSummaries = useMemo(
    () => computeDomainMasterySummary(mastery),
    [mastery],
  );
  const recommendedCompIds = useMemo(
    () => getRecommendedCompetencies(mastery, 4),
    [mastery],
  );
  const masteredCount = useMemo(
    () => Object.values(mastery).filter((m) => m.highestLevel >= 1).length,
    [mastery],
  );

  // Active Interactive Assessment Runner View
  if (activeRun) {
    return (
      <SelfAssessmentRunner
        title={activeRun.title}
        mode={activeRun.mode}
        targetLevel={activeRun.targetLevel}
        targetCompetencyId={activeRun.targetCompetencyId}
        exercises={activeRun.exercises}
        onCompleteSession={handleCompleteRun}
        onExit={() => setActiveRun(null)}
        lang={lang}
        uiMode={uiMode}
      />
    );
  }

  if (loading) {
    return (
      <section className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-500">
        {lang === 'vi'
          ? 'Đang tải không gian Tự đánh giá 24 Năng lực của em...'
          : 'Loading your 24-Competency Self-Assessment workspace...'}
      </section>
    );
  }

  // STEP A: Auth / Welcome Gate (when not signed in and no guest profile yet)
  if (!profile && !editingProfile && !guestModeIntent) {
    return (
      <section className="max-w-4xl mx-auto space-y-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2 max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-wide text-emerald-700">
                {lang === 'vi'
                  ? 'Phân quyền Cá nhân · Tự học & Đánh giá 24 Năng lực ở nhà'
                  : 'Personal Learner Space · Home 24-Competency Self-Assessment'}
              </p>
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">
                {lang === 'vi'
                  ? 'Tự Đánh Giá 24 Năng Lực Công Dân Số'
                  : 'Self-Assess Your 24 Digital Competencies'}
              </h1>
              <p className="text-sm text-slate-600 leading-relaxed">
                {lang === 'vi'
                  ? 'Khám phá trình độ Công dân số (TT 02/2025) qua 96 bài tập đa dạng 5 hình thức (Tình huống, Đúng/Sai, Sắp xếp quy trình, Ghép cặp, Phân loại) chia theo 4 cấp độ. Đăng nhập Google để lưu hồ sơ Tên · Lớp · Trường và nhận huy hiệu khen thưởng từ Thầy/Cô!'
                  : 'Discover your digital citizenship level across 96 interactive exercises (Scenarios, True/False, Step Puzzles, Matching, Sorting) across 4 levels. Sign in with Google to save your progress and receive Teacher Awards!'}
              </p>
            </div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>
                {lang === 'vi' ? 'Tài khoản Học sinh bảo mật' : 'Secure Student Role'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Option 1: Google Sign-In (Recommended) */}
            <div className="p-5 rounded-2xl border-2 border-sky-200 bg-sky-50/40 flex flex-col justify-between gap-5">
              <div className="space-y-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-sky-700">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>{lang === 'vi' ? 'Khuyên dùng · Đồng bộ cho Thầy/Cô khen thưởng' : 'Recommended · Syncs for Teacher Awards'}</span>
                </span>
                <h2 className="text-lg font-bold text-slate-900">
                  {lang === 'vi'
                    ? 'Đăng nhập bằng tài khoản Google'
                    : 'Sign in with Google Account'}
                </h2>
                <ul className="text-xs sm:text-sm text-slate-600 space-y-1.5">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>
                      {lang === 'vi'
                        ? 'Bảo mật tài khoản cá nhân, tự động yêu cầu khai báo Tên, Lớp, Trường cho tài khoản mới.'
                        : 'Secure personal account; new accounts register Name, Class & School.'}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>
                      {lang === 'vi'
                        ? 'Lưu trọn vẹn tiến độ 24 năng lực, Cấp độ 1–4 và nhận Huy hiệu khen thưởng từ Thầy/Cô.'
                        : 'Saves all 24 competency levels and unlocks Teacher Praise Badges.'}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>
                      {lang === 'vi'
                        ? 'Phân quyền chặt chẽ: tài khoản học sinh không thể vào Cổng Giáo Viên.'
                        : 'Strict role separation: student accounts cannot access Teacher Admin.'}
                    </span>
                  </li>
                </ul>
              </div>

              <div className="space-y-2">
                <GoogleSignInButton
                  onClick={handleGoogleLogin}
                  loading={signingIn}
                  label={
                    lang === 'vi'
                      ? 'Đăng nhập Học sinh bằng Google'
                      : 'Student Sign in with Google'
                  }
                />
              </div>
            </div>

            {/* Option 2: Quick Trial Guest Mode */}
            <div className="p-5 rounded-2xl border border-slate-200 bg-slate-50/60 flex flex-col justify-between gap-5">
              <div className="space-y-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600">
                  <Compass className="w-3.5 h-3.5" />
                  <span>{lang === 'vi' ? 'Trải nghiệm nhanh trên thiết bị này' : 'Quick Trial on This Device'}</span>
                </span>
                <h2 className="text-lg font-bold text-slate-900">
                  {lang === 'vi'
                    ? 'Kiểm tra thử ngay (Nhập Tên · Lớp · Trường)'
                    : 'Quick Trial Check (Name · Class · School)'}
                </h2>
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                  {lang === 'vi'
                    ? 'Nếu em chưa có sẵn tài khoản Google trên máy này, em vẫn có thể nhập Tên, Lớp và Trường để vào kiểm tra thử ngay cả 4 cấp độ & 24 năng lực, rồi liên kết Google sau.'
                    : 'No Google account on this device? Enter your Name, Class & School to try all 4 levels & 24 competencies right away.'}
                </p>
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => {
                    setGuestModeIntent(true);
                    setEditingProfile(true);
                  }}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-900 bg-white hover:bg-slate-100 border border-slate-300 rounded-xl cursor-pointer"
                >
                  <Play className="w-4 h-4 text-sky-600" />
                  <span>
                    {lang === 'vi' ? 'Vào Kiểm tra thử ngay' : 'Start Quick Trial'}
                  </span>
                </button>
              </div>
            </div>
          </div>

          {authError && (
            <AuthErrorBanner
              message={authError}
              lang={lang}
              suggestNewTab={authSuggestNewTab}
              tone="error"
            />
          )}

          <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
            <span>
              {lang === 'vi'
                ? 'Đang học trên lớp với 10 máy tính bảng dùng chung?'
                : 'In class on one of the 10 shared tablets?'}
            </span>
            <button
              type="button"
              onClick={onSwitchToClassroom}
              className="font-semibold text-sky-700 hover:underline cursor-pointer"
            >
              {lang === 'vi'
                ? 'Chuyển sang Chế độ Tập trung Trên lớp →'
                : 'Switch to Classroom Focus Mode →'}
            </button>
          </div>
        </div>
      </section>
    );
  }

  // STEP B: Mandatory Onboarding / Profile Editor (Name, Class, School, Grade Band)
  if (editingProfile || !profile?.profileCompleted) {
    return (
      <section className="max-w-xl mx-auto">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold bg-sky-50 text-sky-700 border border-sky-200">
              <GraduationCap className="w-3.5 h-3.5" />
              <span>
                {googleUser
                  ? lang === 'vi'
                    ? `Tài khoản Google đã xác thực: ${googleUser.email}`
                    : `Verified Google Account: ${googleUser.email}`
                  : lang === 'vi'
                    ? 'Hồ sơ Kiểm tra thử 24 Năng lực'
                    : 'Quick Trial Learner Profile'}
              </span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
              {profile?.profileCompleted
                ? lang === 'vi'
                  ? 'Cập nhật Hồ sơ Học sinh'
                  : 'Update Student Profile'
                : lang === 'vi'
                  ? 'Hoàn tất Hồ sơ Học sinh Mới'
                  : 'Complete Your New Student Profile'}
            </h1>
            <p className="text-sm text-slate-600">
              {lang === 'vi'
                ? 'Vui lòng điền chính xác Họ tên, Lớp học và Trường học để Thầy/Cô có thể xem bảng 24 năng lực và gửi khen thưởng cho em.'
                : 'Please fill in your Full Name, Class, and School so your teacher can review your 24 competencies and send awards.'}
            </p>
          </div>

          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="learner-fullname"
                className="block text-sm font-semibold text-slate-900"
              >
                {lang === 'vi' ? 'Họ và tên học sinh *' : 'Student Full Name *'}
              </label>
              <input
                id="learner-fullname"
                type="text"
                required
                value={formFullName}
                onChange={(e) => setFormFullName(e.target.value)}
                placeholder={lang === 'vi' ? 'Ví dụ: Nguyễn Minh Khôi' : 'e.g. Minh Khoi Nguyen'}
                className="w-full px-4 py-2.5 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="learner-class"
                  className="block text-sm font-semibold text-slate-900"
                >
                  {lang === 'vi' ? 'Lớp học *' : 'Class *'}
                </label>
                <input
                  id="learner-class"
                  type="text"
                  required
                  value={formClassName}
                  onChange={(e) => setFormClassName(e.target.value)}
                  placeholder={lang === 'vi' ? 'Ví dụ: 5A, 6B, 8A1' : 'e.g. 5A, 6B'}
                  className="w-full px-4 py-2.5 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
                {classes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {classes.slice(0, 5).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setFormClassName(c.id)}
                        className="px-2 py-0.5 text-[11px] font-semibold bg-slate-100 hover:bg-sky-50 hover:text-sky-700 text-slate-600 rounded-md cursor-pointer"
                      >
                        {c.id}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="learner-gradeband"
                  className="block text-sm font-semibold text-slate-900"
                >
                  {lang === 'vi' ? 'Cấp học (Gợi ý cấp độ)' : 'School Level'}
                </label>
                <select
                  id="learner-gradeband"
                  value={formGradeBand}
                  onChange={(e) => setFormGradeBand(e.target.value as LearnerGradeBand)}
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-sky-500"
                >
                  <option value="primary">
                    {lang === 'vi' ? 'Tiểu học (Gợi ý Cấp 1–2)' : 'Primary School (L1–L2)'}
                  </option>
                  <option value="middle">
                    {lang === 'vi' ? 'THCS (Gợi ý Cấp 2–3)' : 'Middle School (L2–L3)'}
                  </option>
                  <option value="high">
                    {lang === 'vi' ? 'THPT (Gợi ý Cấp 3–4)' : 'High School (L3–L4)'}
                  </option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="learner-school"
                className="block text-sm font-semibold text-slate-900"
              >
                {lang === 'vi' ? 'Trường học *' : 'School Name *'}
              </label>
              <input
                id="learner-school"
                type="text"
                required
                value={formSchoolName}
                onChange={(e) => setFormSchoolName(e.target.value)}
                placeholder={
                  lang === 'vi'
                    ? 'Ví dụ: Trường Tiểu học Nguyễn Du'
                    : 'e.g. Nguyen Du Primary School'
                }
                className="w-full px-4 py-2.5 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            {formError && (
              <p role="alert" className="text-xs sm:text-sm font-semibold text-rose-700">
                {formError}
              </p>
            )}

            <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
              {profile?.profileCompleted ? (
                <button
                  type="button"
                  onClick={() => setEditingProfile(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  {lang === 'vi' ? 'Hủy' : 'Cancel'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="text-xs font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
                >
                  {lang === 'vi' ? '← Chọn cách đăng nhập khác' : '← Choose another sign-in'}
                </button>
              )}

              <button
                type="submit"
                disabled={savingProfile}
                className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50 rounded-xl cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>
                  {savingProfile
                    ? lang === 'vi'
                      ? 'Đang lưu hồ sơ...'
                      : 'Saving...'
                    : lang === 'vi'
                      ? 'Lưu hồ sơ & Bắt đầu Tự đánh giá'
                      : 'Save Profile & Start Assessment'}
                </span>
              </button>
            </div>
          </form>
        </div>
      </section>
    );
  }

  // STEP C: Main Personal Self-Assessment Hub Dashboard
  const currentLevelMeta = getLevelMeta(profile.currentLevel);
  const accuracy =
    profile.totalExercisesDone > 0
      ? Math.round((profile.totalCorrect / profile.totalExercisesDone) * 100)
      : 0;

  return (
    <section className="max-w-7xl mx-auto space-y-6">
      {/* Top Personal Identity & Progress Strip */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            {profile.photoUrl ? (
              <img
                src={profile.photoUrl}
                alt={profile.fullName}
                referrerPolicy="no-referrer"
                className="w-14 h-14 rounded-2xl border border-slate-200 object-cover shrink-0"
              />
            ) : (
              <div className="w-14 h-14 rounded-2xl bg-sky-100 border border-sky-200 text-sky-700 flex items-center justify-center shrink-0">
                <UserCircle2 className="w-8 h-8" />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900 truncate">
                  {profile.fullName}
                </h1>
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${currentLevelMeta.badgeClass}`}
                >
                  {lang === 'vi' ? currentLevelMeta.nameVi : currentLevelMeta.nameEn}
                </span>
                {profile.authType === 'google' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <ShieldCheck className="w-3 h-3" />
                    <span>Google</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                    {lang === 'vi' ? 'Chế độ Khách' : 'Guest Trial'}
                  </span>
                )}
              </div>
              <p className="text-xs sm:text-sm text-slate-600 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1">
                  <GraduationCap className="w-3.5 h-3.5 text-slate-400" />
                  <strong>{lang === 'vi' ? 'Lớp' : 'Class'}:</strong> {profile.className}
                </span>
                <span className="inline-flex items-center gap-1">
                  <School className="w-3.5 h-3.5 text-slate-400" />
                  <strong>{lang === 'vi' ? 'Trường' : 'School'}:</strong> {profile.schoolName}
                </span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {profile.authType === 'guest' && (
              <GoogleSignInButton
                onClick={handleGoogleLogin}
                loading={signingIn}
                label={lang === 'vi' ? 'Liên kết Google' : 'Link Google'}
              />
            )}
            <button
              type="button"
              onClick={() => {
                setFormFullName(profile.fullName);
                setFormClassName(profile.className);
                setFormSchoolName(profile.schoolName);
                setFormGradeBand(profile.gradeBand);
                setEditingProfile(true);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>{lang === 'vi' ? 'Sửa hồ sơ' : 'Edit Profile'}</span>
            </button>
            <button
              type="button"
              onClick={onGoToHonorBoard}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl cursor-pointer"
            >
              <Trophy className="w-3.5 h-3.5" />
              <span>{lang === 'vi' ? 'Vinh danh Tự học' : 'Self-Study Board'}</span>
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{lang === 'vi' ? 'Đăng xuất' : 'Sign Out'}</span>
            </button>
          </div>
        </div>

        {/* 4 Key Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-100">
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <p className="text-xs text-slate-500">
              {lang === 'vi' ? 'Năng lực đã mở khóa' : 'Competencies Unlocked'}
            </p>
            <p className="text-xl font-extrabold font-mono-num text-slate-900 mt-0.5">
              {masteredCount} / 24
            </p>
          </div>
          <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200">
            <p className="text-xs text-sky-700">
              {lang === 'vi' ? 'Tổng điểm XP' : 'Total XP'}
            </p>
            <p className="text-xl font-extrabold font-mono-num text-sky-900 mt-0.5">
              {profile.totalXp} XP
            </p>
          </div>
          <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200">
            <p className="text-xs text-emerald-700">
              {lang === 'vi' ? 'Độ chính xác' : 'Accuracy'}
            </p>
            <p className="text-xl font-extrabold font-mono-num text-emerald-900 mt-0.5">
              {accuracy}%{' '}
              <span className="text-xs font-semibold text-emerald-700">
                ({profile.totalExercisesDone} {lang === 'vi' ? 'bài' : 'done'})
              </span>
            </p>
          </div>
          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200">
            <p className="text-xs text-amber-800">
              {lang === 'vi' ? 'Khen thưởng Thầy/Cô' : 'Teacher Awards'}
            </p>
            <p className="text-xl font-extrabold font-mono-num text-amber-900 mt-0.5">
              {awards.length} {lang === 'vi' ? 'huy hiệu' : 'badges'}
            </p>
          </div>
        </div>
      </div>

      {/* Teacher Awards Celebration Shelf (shown whenever teacher sent praise!) */}
      {awards.length > 0 && (
        <div className="bg-amber-50/70 border border-amber-200 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold text-amber-950 flex items-center gap-2">
              <Gift className="w-5 h-5 text-amber-600" />
              <span>
                {lang === 'vi'
                  ? `Hộp Quà Khen Thưởng Từ Thầy/Cô (${awards.length})`
                  : `Teacher Praise & Awards (${awards.length})`}
              </span>
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {awards.map((aw) => (
              <div
                key={aw.id}
                className="bg-white border border-amber-200 rounded-xl p-4 flex items-start gap-3"
              >
                <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                  <Award className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-slate-900">{aw.badgeTitle}</h3>
                    {aw.bonusXp > 0 && (
                      <span className="font-mono-num text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                        +{aw.bonusXp} XP
                      </span>
                    )}
                  </div>
                  {aw.message && (
                    <p className="text-xs sm:text-sm text-slate-700 leading-relaxed">
                      “{aw.message}”
                    </p>
                  )}
                  <p className="text-[11px] text-slate-500">
                    {aw.awardedByName} ·{' '}
                    {new Date(aw.createdAt).toLocaleDateString('vi-VN')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick Launch Interactive Modes (Anti-Boredom Variety!) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Diagnostic Quick Test */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col justify-between gap-4">
          <div className="space-y-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2.5 py-1 rounded-full">
              <Target className="w-3.5 h-3.5" />
              <span>{lang === 'vi' ? '12 câu · Đủ 6 miền · Xếp cấp độ ngay' : '12 items · All 6 Domains'}</span>
            </span>
            <h2 className="text-lg font-bold text-slate-900">
              {lang === 'vi'
                ? 'Kiểm tra thử Toàn diện 24 Năng lực'
                : '24-Competency Diagnostic Check'}
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed">
              {lang === 'vi'
                ? 'Bài kiểm tra tổng hợp qua đủ 6 miền Công dân số từ Cấp 1 đến Cấp 4 giúp em biết ngay thế mạnh và năng lực cần rèn thêm.'
                : 'A balanced check across all 6 digital domains from Level 1 to Level 4 to pinpoint your strengths and next focus areas.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              setActiveRun({
                title:
                  lang === 'vi'
                    ? 'Kiểm tra thử Toàn diện 24 Năng lực'
                    : '24-Competency Diagnostic Check',
                mode: 'diagnostic',
                exercises: buildDiagnosticDeck(`diag-${Date.now()}`),
              })
            }
            className="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 rounded-xl cursor-pointer"
          >
            <Play className="w-4 h-4" />
            <span>
              {lang === 'vi' ? 'Bắt đầu Kiểm tra thử (12 câu)' : 'Start Diagnostic (12 items)'}
            </span>
          </button>
        </div>

        {/* Variety Sprint (All 5 Interactive Game Mechanics!) */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col justify-between gap-4">
          <div className="space-y-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
              <Shuffle className="w-3.5 h-3.5" />
              <span>{lang === 'vi' ? '8 câu · Đủ 5 trò chơi tương tác · Không chán!' : '8 items · All 5 Game Formats'}</span>
            </span>
            <h2 className="text-lg font-bold text-slate-900">
              {lang === 'vi'
                ? 'Thử thách Đa dạng Siêu tốc (5 dạng bài)'
                : 'Multi-Format Variety Sprint'}
            </h2>
            <p className="text-sm text-slate-600 leading-relaxed">
              {lang === 'vi'
                ? 'Luôn đổi mới mỗi lượt chơi! Tự động ưu tiên các năng lực em chưa luyện và kết hợp đủ 5 dạng: Tình huống, Đúng/Sai, Sắp xếp 4 bước, Ghép cặp, Phân loại.'
                : 'Always fresh! Prioritizes unpracticed competencies and mixes Scenarios, True/False, Step Ordering, Pair Matching, and Sorting.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              setActiveRun({
                title:
                  lang === 'vi'
                    ? 'Thử thách Đa dạng Siêu tốc (5 dạng bài)'
                    : 'Multi-Format Variety Sprint',
                mode: 'variety_sprint',
                exercises: buildVarietySprintDeck(mastery, 8, `sprint-${Date.now()}`),
              })
            }
            className="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl cursor-pointer"
          >
            <Zap className="w-4 h-4" />
            <span>
              {lang === 'vi' ? 'Chơi Thử thách Đa dạng (8 câu)' : 'Play Variety Sprint (8 items)'}
            </span>
          </button>
        </div>
      </div>

      {/* Level Challenges (Level 1 -> Level 4) */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Layers className="w-5 h-5 text-sky-600" />
              <span>
                {lang === 'vi'
                  ? 'Chinh phục 4 Cấp độ Năng lực Số'
                  : 'Conquer 4 Digital Competency Levels'}
              </span>
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
              {lang === 'vi'
                ? 'Chọn cấp độ phù hợp với bản thân để luyện bộ 10 bài tập đa dạng và mở khóa huy hiệu cấp cao hơn.'
                : 'Pick your target level to practice 10 varied exercises and unlock higher mastery tiers.'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {ASSESSMENT_LEVELS.map((lvl) => {
            const clearedAtLevel = Object.values(mastery).filter(
              (m) => m.highestLevel >= lvl.level,
            ).length;
            const pct = Math.round((clearedAtLevel / 24) * 100);
            return (
              <button
                key={lvl.level}
                type="button"
                onClick={() =>
                  setActiveRun({
                    title: lang === 'vi' ? `Thử thách ${lvl.nameVi}` : `${lvl.nameEn} Challenge`,
                    mode: 'level_challenge',
                    targetLevel: lvl.level,
                    exercises: buildLevelChallengeDeck(
                      lvl.level,
                      mastery,
                      10,
                      `lvl-${lvl.level}-${Date.now()}`,
                    ),
                  })
                }
                className="text-left p-4 rounded-xl border border-slate-200 hover:border-sky-400 hover:bg-sky-50/30 transition-all flex flex-col justify-between gap-3 cursor-pointer"
              >
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${lvl.badgeClass}`}
                    >
                      {lvl.code}
                    </span>
                    <span className="font-mono-num text-xs font-bold text-slate-500">
                      +{lvl.xpPerCorrect} XP/câu
                    </span>
                  </div>
                  <h3 className="text-sm sm:text-base font-bold text-slate-900">
                    {lang === 'vi' ? lvl.nameVi : lvl.nameEn}
                  </h3>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {lang === 'vi' ? lvl.subtitleVi : lvl.subtitleEn}
                  </p>
                </div>

                <div className="space-y-1.5 pt-2 border-t border-slate-100">
                  <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600 tabular-nums">
                    <span>
                      {lang === 'vi' ? 'Đã đạt' : 'Cleared'}: {clearedAtLevel}/24
                    </span>
                    <span>{pct}%</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: lvl.accentHex }}
                    />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Recommended Next Competencies */}
      {recommendedCompIds.length > 0 && (
        <div className="bg-sky-50/60 border border-sky-200 rounded-2xl p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm sm:text-base font-bold text-sky-950 flex items-center gap-2">
              <Flame className="w-4 h-4 text-sky-600" />
              <span>
                {lang === 'vi'
                  ? 'Gợi ý luyện tập tiếp theo cho em'
                  : 'Recommended Competencies for You'}
              </span>
            </h2>
            <span className="text-xs text-sky-700">
              {lang === 'vi'
                ? 'Mỗi năng lực gồm trọn bộ 4 cấp độ (L1 → L4)'
                : 'Each skill includes all 4 levels (L1 → L4)'}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {recommendedCompIds.map((cid) => {
              const comp = getCompetencyById(cid);
              const rec = mastery[cid];
              return (
                <button
                  key={cid}
                  type="button"
                  onClick={() =>
                    setActiveRun({
                      title: `${comp.id} · ${lang === 'vi' ? comp.nameVi : comp.nameEn}`,
                      mode: 'competency_focus',
                      targetCompetencyId: comp.id,
                      exercises: buildCompetencyFocusDeck(comp.id),
                    })
                  }
                  className="text-left p-3.5 rounded-xl bg-white border border-sky-200 hover:border-sky-500 transition-colors cursor-pointer space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono-num text-xs font-bold text-sky-700">
                      {comp.id}
                    </span>
                    <span className="text-[11px] font-semibold text-slate-500">
                      {rec?.highestLevel ? `Cấp ${rec.highestLevel}/4` : 'Chưa thử'}
                    </span>
                  </div>
                  <p className="text-sm font-bold text-slate-900">
                    {lang === 'vi' ? comp.nameVi : comp.nameEn}
                  </p>
                  <p className="text-xs font-semibold text-sky-700">
                    {lang === 'vi' ? 'Luyện 4 cấp độ →' : 'Practice 4 levels →'}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Full Interactive 24-Competency Skill Map (TT 02/2025) */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg sm:text-xl font-bold text-slate-900">
              {lang === 'vi'
                ? 'Bản Đồ 24 Năng Lực Công Dân Số (TT 02/2025)'
                : 'Interactive 24 Digital Competency Map'}
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
              {lang === 'vi'
                ? 'Nhấn vào bất kỳ năng lực nào bên dưới để tự kiểm tra từ Cấp 1 đến Cấp 4 và thắp sáng đầy đủ 4 ngôi sao thành thạo.'
                : 'Click any competency below to practice Levels 1 to 4 and light up all 4 mastery stars.'}
            </p>
          </div>
          <span className="font-mono-num text-xs font-bold px-3 py-1.5 rounded-full bg-slate-100 text-slate-700">
            {masteredCount} / 24 {lang === 'vi' ? 'năng lực đã mở' : 'unlocked'}
          </span>
        </div>

        <div className="space-y-6">
          {COMPETENCY_DOMAINS.map((domain) => {
            const comps = COMPETENCIES_24.filter((c) => c.domainId === domain.id);
            const summary = domainSummaries.find((s) => s.domainId === domain.id);
            return (
              <div key={domain.id} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`px-2.5 py-0.5 rounded-lg text-xs font-bold border ${domain.surfaceClass} ${domain.textClass} ${domain.borderClass}`}
                    >
                      {lang === 'vi' ? `Miền ${domain.number}` : `Domain ${domain.number}`}
                    </span>
                    <h3 className="text-sm sm:text-base font-bold text-slate-900">
                      {lang === 'vi' ? domain.nameVi : domain.nameEn}
                    </h3>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-600 tabular-nums">
                    <span>
                      {summary?.masteredCount ?? 0}/{comps.length}{' '}
                      {lang === 'vi' ? 'đã mở' : 'unlocked'}
                    </span>
                    <span className="font-mono-num font-bold text-slate-900">
                      {summary?.percentComplete ?? 0}%
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {comps.map((comp) => {
                    const rec = mastery[comp.id];
                    const lvl = rec?.highestLevel ?? 0;
                    return (
                      <button
                        key={comp.id}
                        type="button"
                        onClick={() =>
                          setActiveRun({
                            title: `${comp.id} · ${lang === 'vi' ? comp.nameVi : comp.nameEn}`,
                            mode: 'competency_focus',
                            targetCompetencyId: comp.id,
                            exercises: buildCompetencyFocusDeck(comp.id),
                          })
                        }
                        className={`text-left p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                          lvl >= 4
                            ? 'bg-emerald-50/40 border-emerald-300 hover:border-emerald-500'
                            : lvl >= 1
                              ? 'bg-white border-sky-200 hover:border-sky-500'
                              : 'bg-slate-50/60 border-slate-200 hover:border-sky-400 hover:bg-white'
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`font-mono-num text-xs font-bold ${domain.textClass}`}
                            >
                              {comp.id}
                            </span>
                            <div className="flex items-center gap-0.5" aria-label={`Cấp độ ${lvl}/4`}>
                              {[1, 2, 3, 4].map((starLvl) => (
                                <Star
                                  key={starLvl}
                                  className={`w-3.5 h-3.5 ${
                                    lvl >= starLvl
                                      ? 'text-amber-500 fill-amber-400'
                                      : 'text-slate-300'
                                  }`}
                                />
                              ))}
                            </div>
                          </div>
                          <p className="text-sm font-bold text-slate-900">
                            {lang === 'vi' ? comp.nameVi : comp.nameEn}
                          </p>
                        </div>

                        <div className="flex items-center justify-between text-[11px] font-semibold">
                          <span className="text-slate-500">
                            {lvl > 0
                              ? lang === 'vi'
                                ? `Đạt Cấp ${lvl}/4`
                                : `Level ${lvl}/4`
                              : lang === 'vi'
                                ? 'Chưa đánh giá'
                                : 'Not assessed yet'}
                          </span>
                          <span className="text-sky-700">
                            {lang === 'vi' ? 'Luyện ngay →' : 'Practice →'}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Self-Assessment History */}
      {attempts.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-3">
          <h2 className="text-base font-bold text-slate-900">
            {lang === 'vi' ? 'Lịch sử Tự đánh giá gần đây' : 'Recent Self-Assessment Sessions'}
          </h2>
          <div className="divide-y divide-slate-100">
            {attempts.slice(0, 6).map((att) => (
              <div
                key={att.id}
                className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm"
              >
                <div>
                  <p className="font-semibold text-slate-900">
                    {att.mode === 'diagnostic'
                      ? lang === 'vi'
                        ? 'Kiểm tra thử Toàn diện 24 Năng lực'
                        : '24-Competency Diagnostic'
                      : att.mode === 'level_challenge'
                        ? lang === 'vi'
                          ? `Thử thách Cấp độ ${att.targetLevel ?? ''}`
                          : `Level ${att.targetLevel ?? ''} Challenge`
                        : att.mode === 'competency_focus'
                          ? lang === 'vi'
                            ? `Luyện chuyên sâu Năng lực ${att.targetCompetencyId ?? ''}`
                            : `Skill Focus ${att.targetCompetencyId ?? ''}`
                          : lang === 'vi'
                            ? 'Thử thách Đa dạng Siêu tốc'
                            : 'Variety Sprint'}
                  </p>
                  <p className="text-xs text-slate-500">
                    {new Date(att.completedAt).toLocaleString('vi-VN')} ·{' '}
                    {att.competencyIds.slice(0, 6).join(', ')}
                  </p>
                </div>
                <div className="flex items-center gap-3 tabular-nums">
                  <span className="font-semibold text-slate-800">
                    {att.correctCount}/{att.totalQuestions} ({att.accuracyPercent}%)
                  </span>
                  <span className="font-mono-num text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                    +{att.xpEarned} XP
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
