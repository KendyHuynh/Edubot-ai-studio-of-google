import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  Award,
  CheckCircle2,
  Cloud,
  CloudOff,
  Edit3,
  Flame,
  Gift,
  GraduationCap,
  Layers,
  Lock,
  LogOut,
  Mail,
  Play,
  RefreshCw,
  RotateCcw,
  School,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Star,
  Target,
  Trophy,
  Unlock,
  UserCircle2,
  Zap,
} from 'lucide-react';
import { ASSESSMENT_LEVELS } from '../shared/assessmentBank';
import {
  buildAdvancedExpansionDeck,
  buildCompetencyFocusDeck,
  buildDiagnosticDeck,
  buildLevelChallengeDeck,
  buildVarietySprintDeck,
  computeDomainMasterySummary,
  getExpansionUnlockSummary,
  getLevelMeta,
  getRecommendedCompetencies,
  mergeLearnerProfiles,
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
  saveAssessmentAttemptToFirestore,
  saveLearnerProfileToFirestore,
} from '../utils/firestoreSync';
import {
  auth,
  firebaseGoogleSignIn,
  logoutGoogle,
  waitForAuthReady,
} from '../utils/googleDrive';
import { AuthErrorBanner } from './AuthErrorBanner';
import { GoogleSignInButton } from './GoogleSignInButton';
import { SelfAssessmentRunner, SessionSaveOutcome } from './SelfAssessmentRunner';

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

interface CloudSyncState {
  status: 'idle' | 'syncing' | 'synced' | 'error';
  savedAt?: string;
  error?: string;
  permissionDenied?: boolean;
}

export function SelfAssessmentHub({
  classes,
  onSwitchToClassroom,
  onGoToHonorBoard,
  lang,
  uiMode,
}: SelfAssessmentHubProps) {
  const [authReady, setAuthReady] = useState(false);
  const [googleUser, setGoogleUser] = useState<User | null>(() => auth.currentUser);
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [attempts, setAttempts] = useState<AssessmentSessionAttempt[]>([]);
  const [awards, setAwards] = useState<TeacherAward[]>([]);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuggestNewTab, setAuthSuggestNewTab] = useState(false);
  const [cloudSyncState, setCloudSyncState] = useState<CloudSyncState>({ status: 'idle' });

  // Onboarding / Edit profile modal state
  const [editingProfile, setEditingProfile] = useState(false);
  const [formFullName, setFormFullName] = useState('');
  const [formClassName, setFormClassName] = useState('');
  const [formSchoolName, setFormSchoolName] = useState('');
  const [formGradeBand, setFormGradeBand] = useState<LearnerGradeBand>('primary');
  const [savingProfile, setSavingProfile] = useState(false);
  const [formError, setFormError] = useState('');

  // Active exercise runner state
  const [activeRun, setActiveRun] = useState<ActiveSessionConfig | null>(null);

  // Sync Firebase auth state cleanly without flashing login gate on reload
  useEffect(() => {
    let active = true;
    waitForAuthReady().then((u) => {
      if (!active) return;
      setGoogleUser(u);
      setAuthReady(true);
    });
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!active) return;
      setGoogleUser(u);
      setAuthReady(true);
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const hydrateLearnerData = useCallback(
    async (user: User | null) => {
      setLoading(true);
      try {
        if (!user || !user.emailVerified) {
          setProfile(null);
          setAttempts([]);
          setAwards([]);
          setCloudSyncState({ status: 'idle' });
          setEditingProfile(false);
          setActiveRun(null);
          return;
        }

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
            attempts: [] as AssessmentSessionAttempt[],
            awards: [] as TeacherAward[],
            error: undefined as string | undefined,
            permissionDenied: false,
          })),
        ]);

        const apiProfile = apiRes?.ok ? apiRes.data.profile : null;
        const cloudProfile = cloudBundle.profile;

        let resolved: LearnerProfile | null = null;
        if (apiProfile && cloudProfile) {
          resolved = mergeLearnerProfiles(apiProfile, cloudProfile);
        } else {
          resolved = cloudProfile ?? apiProfile;
        }

        const mergedAttemptsMap = new Map<string, AssessmentSessionAttempt>();
        for (const att of [
          ...(apiRes?.ok ? apiRes.data.attempts : []),
          ...(cloudBundle.attempts ?? []),
        ]) {
          if (att?.id) mergedAttemptsMap.set(att.id, att);
        }
        const mergedAttempts = Array.from(mergedAttemptsMap.values())
          .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
          .slice(0, 40);

        const mergedAwardsMap = new Map<string, TeacherAward>();
        for (const a of [
          ...(apiRes?.ok ? apiRes.data.awards : []),
          ...(cloudBundle.awards ?? []),
        ]) {
          if (a?.id) mergedAwardsMap.set(a.id, a);
        }
        const mergedAwards = Array.from(mergedAwardsMap.values()).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );

        if (resolved) {
          const hydrateRes = await apiRequestJson<{
            profile?: LearnerProfile;
          }>(
            '/api/learners/hydrate',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                idToken,
                profile: resolved,
                attempts: mergedAttempts,
                awards: mergedAwards,
              }),
            },
            lang,
          ).catch(() => null);
          if (hydrateRes?.ok && hydrateRes.data.profile) {
            resolved = hydrateRes.data.profile;
          }

          const cloudBehind =
            !cloudProfile ||
            resolved.totalXp > cloudProfile.totalXp ||
            resolved.totalExercisesDone > cloudProfile.totalExercisesDone;

          if (cloudBehind && resolved.profileCompleted) {
            setCloudSyncState({ status: 'syncing' });
            const pushRes = await saveLearnerProfileToFirestore(resolved, {
              awardsCount: mergedAwards.length,
              latestBadgeTitle: mergedAwards[0]?.badgeTitle,
            });
            setCloudSyncState(
              pushRes.ok
                ? { status: 'synced', savedAt: pushRes.savedAt }
                : {
                    status: 'error',
                    error: pushRes.error,
                    permissionDenied: pushRes.permissionDenied,
                  },
            );
          } else if (cloudBundle.error) {
            setCloudSyncState({
              status: 'error',
              error: cloudBundle.error,
              permissionDenied: cloudBundle.permissionDenied,
            });
          } else if (cloudProfile) {
            setCloudSyncState({
              status: 'synced',
              savedAt: cloudProfile.updatedAt || cloudProfile.lastActiveAt,
            });
          }
        }

        setProfile(resolved);
        setAttempts(mergedAttempts);
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
      } finally {
        setLoading(false);
      }
    },
    [lang],
  );

  useEffect(() => {
    if (!authReady) return;
    void hydrateLearnerData(googleUser);
  }, [authReady, googleUser, hydrateLearnerData]);

  const handleGoogleLogin = async () => {
    if (signingIn) return;
    setSigningIn(true);
    setAuthError(null);
    setAuthSuggestNewTab(false);
    try {
      const result = await firebaseGoogleSignIn();
      if (result?.user) {
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
    setGoogleUser(null);
    setProfile(null);
    setAttempts([]);
    setAwards([]);
    setCloudSyncState({ status: 'idle' });
    setEditingProfile(false);
    setActiveRun(null);
  };

  const handleRetryCloudSync = async () => {
    if (!profile || !googleUser || !googleUser.emailVerified) return;
    setCloudSyncState({ status: 'syncing' });
    const res = await saveLearnerProfileToFirestore(profile, {
      awardsCount: awards.length,
      latestBadgeTitle: awards[0]?.badgeTitle,
    });
    setCloudSyncState(
      res.ok
        ? { status: 'synced', savedAt: res.savedAt }
        : {
            status: 'error',
            error: res.error,
            permissionDenied: res.permissionDenied,
          },
    );
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = formFullName.trim();
    const cleanClass = formClassName.trim();
    const cleanSchool = formSchoolName.trim();

    if (!cleanName || !cleanClass || !cleanSchool) {
      setFormError(
        lang === 'vi'
          ? 'Vui lòng nhập đầy đủ Họ và tên, Lớp học và Trường học để lưu thành tích công khai và Thầy/Cô vinh danh.'
          : 'Please enter Full Name, Class, and School so your achievements publish and your teacher can honor you.',
      );
      return;
    }

    if (!googleUser || !googleUser.emailVerified) {
      setFormError(
        lang === 'vi'
          ? 'Bắt buộc đăng nhập bằng Gmail cá nhân (Google) trước khi lưu hồ sơ.'
          : 'Verified personal Gmail sign-in is required before saving your profile.',
      );
      return;
    }

    setFormError('');
    setSavingProfile(true);
    setCloudSyncState({ status: 'syncing' });
    try {
      const idToken = await googleUser.getIdToken();

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
            photoUrl: googleUser.photoURL || undefined,
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

      const saved = profile
        ? mergeLearnerProfiles(profile, res.data.profile)
        : res.data.profile;
      const nextAwards =
        res.data.awards && res.data.awards.length > awards.length
          ? res.data.awards
          : awards;

      setProfile(saved);
      if (res.data.attempts && res.data.attempts.length > attempts.length) {
        setAttempts(res.data.attempts);
      }
      setAwards(nextAwards);

      const cloudRes = await saveLearnerProfileToFirestore(saved, {
        awardsCount: nextAwards.length,
        latestBadgeTitle: nextAwards[0]?.badgeTitle,
      });
      setCloudSyncState(
        cloudRes.ok
          ? { status: 'synced', savedAt: cloudRes.savedAt }
          : {
              status: 'error',
              error: cloudRes.error,
              permissionDenied: cloudRes.permissionDenied,
            },
      );
      setEditingProfile(false);
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
  }): Promise<SessionSaveOutcome> => {
    if (!googleUser || !googleUser.emailVerified) {
      return {
        cloudSaved: false,
        error: 'Bắt buộc đăng nhập Gmail cá nhân (Google) để lưu thành tích.',
      };
    }

    const idToken = await googleUser.getIdToken().catch(() => undefined);
    if (!idToken) {
      return {
        cloudSaved: false,
        error: 'Không lấy được phiên xác thực Google. Vui lòng đăng nhập lại.',
      };
    }

    setCloudSyncState({ status: 'syncing' });
    const res = await apiRequestJson<{
      profile?: LearnerProfile;
      attempt?: AssessmentSessionAttempt;
      awards?: TeacherAward[];
      error?: string;
    }>(
      '/api/learners/assessment-submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          learnerName: profile?.fullName,
          className: profile?.className,
          schoolName: profile?.schoolName,
          gradeBand: profile?.gradeBand,
          baseProfile: profile ?? undefined,
          ...payload,
        }),
      },
      lang,
    );

    if (!res.ok || !res.data.profile) {
      const errMsg = res.data?.error || 'Không thể lưu kết quả tự đánh giá.';
      setCloudSyncState({ status: 'error', error: errMsg });
      return { cloudSaved: false, error: errMsg };
    }

    const updatedProfile = res.data.profile;
    const nextAwards =
      res.data.awards && res.data.awards.length > awards.length
        ? res.data.awards
        : awards;

    setProfile(updatedProfile);
    if (res.data.attempt) {
      setAttempts((prev) =>
        [res.data.attempt!, ...prev.filter((a) => a.id !== res.data.attempt!.id)].slice(0, 40),
      );
    }
    setAwards(nextAwards);

    // AWAIT Cloud Firestore persistence (private Gmail profile + PUBLIC honor board!)
    const [cloudRes] = await Promise.all([
      saveLearnerProfileToFirestore(updatedProfile, {
        awardsCount: nextAwards.length,
        latestBadgeTitle: nextAwards[0]?.badgeTitle,
      }),
      res.data.attempt
        ? saveAssessmentAttemptToFirestore(res.data.attempt)
        : Promise.resolve(false),
    ]);

    setCloudSyncState(
      cloudRes.ok
        ? { status: 'synced', savedAt: cloudRes.savedAt }
        : {
            status: 'error',
            error: cloudRes.error,
            permissionDenied: cloudRes.permissionDenied,
          },
    );

    return {
      cloudSaved: cloudRes.ok,
      error: cloudRes.error,
    };
  };

  const mastery = profile?.masteryByCompetency ?? {};
  const currentLevel: AssessmentLevel = profile?.currentLevel ?? 1;
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
  const expansionSummary = useMemo(
    () => getExpansionUnlockSummary(currentLevel, mastery),
    [currentLevel, mastery],
  );

  // Active Interactive Assessment Runner View (Verified Gmail ONLY!)
  if (activeRun && googleUser && googleUser.emailVerified && profile?.profileCompleted) {
    return (
      <SelfAssessmentRunner
        title={activeRun.title}
        mode={activeRun.mode}
        targetLevel={activeRun.targetLevel}
        targetCompetencyId={activeRun.targetCompetencyId}
        exercises={activeRun.exercises}
        mastery={mastery}
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

  // STEP A: Mandatory Verified Gmail Sign-In Gate (Strictly blocks guest peeking at questions & answers!)
  if (!googleUser || !googleUser.emailVerified) {
    return (
      <section className="max-w-4xl mx-auto space-y-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2 max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-wide text-emerald-700">
                {lang === 'vi'
                  ? 'Tự học ở nhà · Bắt buộc Gmail cá nhân · Lưu Cloud & Công khai Thành tích'
                  : 'Home Self-Assessment · Verified Personal Gmail Required · Public Cloud Achievements'}
              </p>
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">
                {lang === 'vi'
                  ? 'Tự Đánh Giá 24 Năng Lực Công Dân Số'
                  : 'Self-Assess Your 24 Digital Competencies'}
              </h1>
              <p className="text-sm text-slate-600 leading-relaxed">
                {lang === 'vi'
                  ? 'Chinh phục 96 bài tập cốt lõi và mở khóa thêm 48 câu hỏi nâng cao (tổng 144 bài tập, 5 dạng trò chơi tương tác). Học sinh bắt buộc đăng nhập bằng Gmail cá nhân (Google) để đảm bảo công bằng (không xem trước đề); mọi thành tích 24 năng lực tự động lưu Google Cloud Firestore và hiển thị công khai trên Bảng Vinh danh.'
                  : 'Master 96 core exercises and unlock 48 advanced items (144 total across 5 interactive formats). Personal Gmail sign-in is mandatory to prevent peeking at questions; all 24-competency achievements save to Google Cloud Firestore and publish to the Public Honor Board.'}
              </p>
            </div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800">
              <Lock className="w-4 h-4 shrink-0" />
              <span>
                {lang === 'vi' ? 'Bắt buộc Gmail · Thành tích Công khai' : 'Gmail Required · Public Honors'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {/* Primary Mandatory Personal Gmail Login Card */}
            <div className="lg:col-span-3 p-5 sm:p-6 rounded-2xl border-2 border-sky-200 bg-sky-50/40 flex flex-col justify-between gap-5">
              <div className="space-y-3">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-sky-700">
                  <ShieldCheck className="w-4 h-4" />
                  <span>
                    {lang === 'vi'
                      ? 'Bước 1 · Đăng nhập bằng Gmail cá nhân của em (Bắt buộc)'
                      : 'Step 1 · Sign in with Your Personal Gmail (Required)'}
                  </span>
                </span>
                <h2 className="text-lg sm:text-xl font-bold text-slate-900">
                  {lang === 'vi'
                    ? 'Đăng nhập Gmail để làm bài, lưu Cloud & công khai thành tích'
                    : 'Sign in with Gmail to Practice, Sync & Publish Achievements'}
                </h2>
                <ul className="text-xs sm:text-sm text-slate-700 space-y-2">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>
                      {lang === 'vi'
                        ? 'Công bằng tuyệt đối: Khóa hoàn toàn chế độ khách — không ai có thể vào xem trước câu hỏi hay đáp án nếu chưa đăng nhập Gmail thật.'
                        : 'Strict fairness: Guest mode is disabled so nobody can peek at questions or answers without a verified Gmail.'}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>
                      {lang === 'vi'
                        ? 'Lưu thành tích theo Gmail lên Google Cloud Firestore: Đồng bộ 24 năng lực, XP, Cấp độ 1–4 trên mọi thiết bị cho Thầy/Cô tổng hợp và trao huy hiệu.'
                        : 'Gmail-backed Google Cloud Firestore sync: Saves all 24 competencies, XP, and Levels 1–4 across devices for teacher review and awards.'}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>
                      {lang === 'vi'
                        ? 'Thành tích tự động CÔNG KHAI trên Bảng Vinh danh Tự học (mọi bạn bè, phụ huynh, thầy cô đều xem được; địa chỉ email cá nhân được ẩn bảo mật).'
                        : 'Achievements publish automatically to the Public Self-Study Honor Board (viewable by classmates, parents & teachers; email address stays hidden).'}
                    </span>
                  </li>
                </ul>
              </div>

              <div className="space-y-2.5">
                <GoogleSignInButton
                  onClick={handleGoogleLogin}
                  loading={signingIn}
                  label={
                    lang === 'vi'
                      ? 'Đăng nhập bằng Gmail cá nhân (Google)'
                      : 'Sign in with Personal Gmail (Google)'
                  }
                />
                <button
                  type="button"
                  onClick={onGoToHonorBoard}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl cursor-pointer"
                >
                  <Trophy className="w-4 h-4 text-amber-600" />
                  <span>
                    {lang === 'vi'
                      ? 'Xem Bảng Vinh danh Công khai (Không cần đăng nhập) →'
                      : 'View Public Honor Board (No Sign-In Needed) →'}
                  </span>
                </button>
              </div>
            </div>

            {/* Scoring & Progressive Unlock Overview Card */}
            <div className="lg:col-span-2 p-5 rounded-2xl border border-slate-200 bg-slate-50/70 space-y-4">
              <div className="space-y-1.5">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-700">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>
                    {lang === 'vi' ? 'Điểm làm lại công bằng & Mở khóa câu mới' : 'Fair Retry Scoring & Unlocks'}
                  </span>
                </span>
                <h3 className="text-sm font-bold text-slate-900">
                  {lang === 'vi' ? 'Càng lên cấp cao, kho đề càng phong phú!' : 'Level Up to Unlock More Questions!'}
                </h3>
              </div>

              <ul className="space-y-2 text-xs text-slate-700">
                <li className="p-2.5 rounded-xl bg-white border border-slate-200">
                  <strong className="text-emerald-700">100% XP</strong>{' '}
                  {lang === 'vi'
                    ? 'khi làm đúng lần đầu (câu mở rộng thưởng tới +105 XP/câu).'
                    : 'for first-try mastery (up to +105 XP on expansion items).'}
                </li>
                <li className="p-2.5 rounded-xl bg-white border border-slate-200">
                  <strong className="text-sky-700">80% XP</strong>{' '}
                  {lang === 'vi'
                    ? 'khi quay lại sửa đúng câu từng làm sai (khuyến khích tự ôn!).'
                    : 'when mastering a previously missed exercise.'}
                </li>
                <li className="p-2.5 rounded-xl bg-white border border-slate-200">
                  <strong className="text-amber-700">25% XP (1 lần) → 0 XP</strong>{' '}
                  {lang === 'vi'
                    ? 'khi ôn lại câu đã đạt để tránh cày điểm lặp lại.'
                    : 'for 1 spaced review, then free 0 XP practice to prevent farming.'}
                </li>
                <li className="p-2.5 rounded-xl bg-indigo-50/70 border border-indigo-200 text-indigo-950">
                  <strong>96 → 144 {lang === 'vi' ? 'câu' : 'items'}:</strong>{' '}
                  {lang === 'vi'
                    ? 'Đạt Cấp 2 mở +12 câu · Cấp 3 mở +18 câu · Cấp 4 mở +18 câu Chuyên gia!'
                    : 'Level 2 unlocks +12 · Level 3 unlocks +18 · Level 4 unlocks +18 Master items!'}
                </li>
              </ul>
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
                : 'In class on one of the 10 shared classroom tablets?'}
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
                {lang === 'vi'
                  ? `Gmail đã xác thực: ${googleUser.email}`
                  : `Verified Gmail: ${googleUser.email}`}
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
                ? 'Vui lòng điền chính xác Họ tên, Lớp học và Trường học để lưu thành tích công khai trên Bảng Vinh danh và để Thầy/Cô gửi khen thưởng.'
                : 'Please fill in your Full Name, Class, and School so your achievements publish on the Public Honor Board and your teacher can send awards.'}
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
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  <ShieldCheck className="w-3 h-3" />
                  <span>Gmail</span>
                </span>
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
                {(profile.email || googleUser?.email) && (
                  <span className="inline-flex items-center gap-1 text-slate-500">
                    <Mail className="w-3.5 h-3.5 text-slate-400" />
                    <span className="truncate max-w-[240px]">
                      {profile.email || googleUser?.email}
                    </span>
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
              <span>{lang === 'vi' ? 'Bảng Vinh danh Công khai' : 'Public Honor Board'}</span>
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

        {/* Cloud Achievement Persistence Status Bar */}
        <div
          className={`rounded-xl px-3.5 py-2.5 border flex flex-wrap items-center justify-between gap-2 text-xs ${
            cloudSyncState.status === 'error'
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {cloudSyncState.status === 'error' ? (
              <CloudOff className="w-4 h-4 text-amber-600 shrink-0" />
            ) : (
              <Cloud className="w-4 h-4 text-emerald-600 shrink-0" />
            )}
            <span className="font-semibold">
              {cloudSyncState.status === 'syncing'
                ? lang === 'vi'
                  ? 'Đang lưu thành tích 24 năng lực lên Đám mây & Bảng Vinh danh công khai...'
                  : 'Syncing your 24-competency achievements to Cloud & Public Honor Board...'
                : cloudSyncState.status === 'error'
                  ? lang === 'vi'
                    ? `Đã lưu tạm trên máy · Chưa đồng bộ Đám mây (${cloudSyncState.error || 'mất mạng'})`
                    : `Saved locally · Cloud sync pending (${cloudSyncState.error || 'offline'})`
                  : lang === 'vi'
                    ? `Thành tích đã đồng bộ Đám mây theo Gmail${
                        cloudSyncState.savedAt
                          ? ` (${new Date(cloudSyncState.savedAt).toLocaleTimeString('vi-VN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })})`
                          : ''
                      } & công khai trên Bảng Vinh danh để Thầy/Cô và các bạn cùng xem!`
                    : `Achievements synced to Cloud under your Gmail & published to the Public Honor Board!`}
            </span>
          </div>
          <button
            type="button"
            disabled={cloudSyncState.status === 'syncing'}
            onClick={() => void handleRetryCloudSync()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold disabled:opacity-50 cursor-pointer shrink-0"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${cloudSyncState.status === 'syncing' ? 'animate-spin' : ''}`}
            />
            <span>{lang === 'vi' ? 'Đồng bộ Đám mây' : 'Sync Cloud'}</span>
          </button>
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
                ? 'Kiểm tra Tổng hợp 24 Năng lực'
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
                      ? 'Kiểm tra Toàn diện 24 Năng lực'
                      : '24-Competency Diagnostic Check',
                  mode: 'diagnostic',
                  exercises: buildDiagnosticDeck(`diag-${Date.now()}`, mastery, currentLevel),
                })
              }
              className="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 rounded-xl cursor-pointer"
            >
              <Play className="w-4 h-4" />
              <span>
                {lang === 'vi' ? 'Bắt đầu Kiểm tra Tổng hợp (12 câu)' : 'Start Diagnostic (12 items)'}
              </span>
            </button>
          </div>

          {/* Variety Sprint (All 5 Interactive Game Mechanics!) */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col justify-between gap-4">
            <div className="space-y-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                <Shuffle className="w-3.5 h-3.5" />
                <span>{lang === 'vi' ? '8 câu · Ưu tiên câu mới · Đủ 5 dạng bài' : '8 items · Fresh First · All 5 Formats'}</span>
              </span>
              <h2 className="text-lg font-bold text-slate-900">
                {lang === 'vi'
                  ? 'Thử thách Đa dạng Siêu tốc (5 dạng bài)'
                  : 'Multi-Format Variety Sprint'}
              </h2>
              <p className="text-sm text-slate-600 leading-relaxed">
                {lang === 'vi'
                  ? 'Tự động chọn các câu em CHƯA làm đúng từ kho bài tập đã mở khóa (96 → 144 câu) kết hợp đủ 5 dạng: Tình huống, Đúng/Sai, Sắp xếp 4 bước, Ghép cặp, Phân loại.'
                  : 'Automatically prioritizes unmastered exercises from your unlocked bank (96 → 144 items) across all 5 interactive formats.'}
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
                  exercises: buildVarietySprintDeck(mastery, 8, `sprint-${Date.now()}`, currentLevel),
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

        {/* Fair Retry Scoring Policy Strip */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-white border border-slate-200 text-sky-700 flex items-center justify-center shrink-0">
              <RotateCcw className="w-4 h-4" />
            </div>
            <div className="space-y-0.5">
              <p className="text-sm font-bold text-slate-900">
                {lang === 'vi'
                  ? 'Quy tắc tính điểm làm lại công bằng (Chống cày điểm lặp lại)'
                  : 'Fair Anti-Farming Retry XP Policy'}
              </p>
              <p className="text-xs text-slate-600">
                {lang === 'vi'
                  ? 'Khuyến khích học sinh chinh phục câu mới & lên cấp cao hơn thay vì làm lặp lại câu dễ.'
                  : 'Rewards conquering new & higher-level questions instead of repeating easy ones.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            <span className="px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200">
              {lang === 'vi' ? 'Câu mới lần đầu: 100% XP' : 'First Try: 100% XP'}
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-sky-50 text-sky-800 border border-sky-200">
              {lang === 'vi' ? 'Sửa câu từng sai: 80% XP' : 'Fix Missed: 80% XP'}
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-amber-50 text-amber-800 border border-amber-200">
              {lang === 'vi' ? 'Ôn tập 1 lần: 25% XP' : '1st Review: 25% XP'}
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-white text-slate-600 border border-slate-200">
              {lang === 'vi' ? 'Lặp lại thêm: 0 XP (Luyện tự do)' : 'Further Repeats: 0 XP'}
            </span>
          </div>
        </div>

        {/* Progressive Higher-Level Expansion Bank (96 -> 144 Questions!) */}
        <div className="bg-indigo-50/50 border border-indigo-200 rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-700">
                <Sparkles className="w-4 h-4" />
                <span>
                  {lang === 'vi'
                    ? `Kho Mở Rộng Theo Cấp Độ · Đã mở ${expansionSummary.totalUnlockedBankSize} / ${expansionSummary.coreTotal + expansionSummary.expansionTotal} bài tập`
                    : `Progressive Expansion Bank · ${expansionSummary.totalUnlockedBankSize} / ${expansionSummary.coreTotal + expansionSummary.expansionTotal} Unlocked`}
                </span>
              </div>
              <h2 className="text-lg font-bold text-slate-900">
                {lang === 'vi'
                  ? 'Lên cấp cao hơn để mở thêm +48 câu hỏi thực chiến chuyên sâu (+20% XP)'
                  : 'Level Up to Unlock +48 Deeper Practice Challenges (+20% XP)'}
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 max-w-2xl">
                {lang === 'vi'
                  ? 'Ngoài 96 câu hỏi cốt lõi (đủ 24 năng lực × 4 cấp), mỗi khi em thăng hạng lên Cấp 2, Cấp 3 và Cấp 4, hệ thống sẽ tự động mở khóa thêm các gói câu hỏi nâng cao thưởng XP cao hơn để em luyện tập càng nhiều càng giỏi!'
                  : 'Beyond the 96 core items, reaching Levels 2, 3, and 4 automatically unlocks bonus expansion packs with +20% XP for deeper practice!'}
              </p>
            </div>

            <button
              type="button"
              disabled={expansionSummary.unlockedExpansionCount === 0}
              onClick={() =>
                setActiveRun({
                  title:
                    lang === 'vi'
                      ? `Kho Mở Rộng Cấp ${currentLevel} (+20% XP)`
                      : `Level ${currentLevel} Expansion Pack (+20% XP)`,
                  mode: 'advanced_pack',
                  targetLevel: currentLevel,
                  exercises: buildAdvancedExpansionDeck(
                    currentLevel,
                    mastery,
                    10,
                    `adv-${Date.now()}`,
                  ),
                })
              }
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:text-slate-600 rounded-xl cursor-pointer disabled:cursor-not-allowed shrink-0"
            >
              {expansionSummary.unlockedExpansionCount > 0 ? (
                <>
                  <Unlock className="w-4 h-4" />
                  <span>
                    {lang === 'vi'
                      ? `Luyện Kho Mở Rộng (${expansionSummary.unlockedExpansionCount} câu)`
                      : `Play Expansion Pack (${expansionSummary.unlockedExpansionCount})`}
                  </span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>
                    {lang === 'vi' ? 'Đạt Cấp 2 để mở khóa' : 'Reach Level 2 to Unlock'}
                  </span>
                </>
              )}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {expansionSummary.packs.map((pack) => (
              <div
                key={pack.level}
                className={`p-4 rounded-xl border flex flex-col justify-between gap-2.5 ${
                  pack.unlocked
                    ? 'bg-white border-indigo-200'
                    : 'bg-white/60 border-slate-200 opacity-80'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-0.5 rounded-full border ${
                      pack.unlocked
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-slate-100 text-slate-600 border-slate-200'
                    }`}
                  >
                    {pack.unlocked ? (
                      <Unlock className="w-3 h-3" />
                    ) : (
                      <Lock className="w-3 h-3" />
                    )}
                    <span>
                      {pack.unlocked
                        ? lang === 'vi'
                          ? `Gói Cấp ${pack.level}+ · Đã mở`
                          : `Level ${pack.level}+ · Unlocked`
                        : lang === 'vi'
                          ? `Gói Cấp ${pack.level}+ · Khóa`
                          : `Level ${pack.level}+ · Locked`}
                    </span>
                  </span>
                  <span className="font-mono-num text-xs font-bold text-indigo-700">
                    +{pack.xpPerCorrect} XP/câu
                  </span>
                </div>
                <p className="text-sm font-bold text-slate-900">
                  +{pack.totalCount}{' '}
                  {lang === 'vi'
                    ? pack.level === 2
                      ? 'câu Thực hành mở rộng (đủ 6 miền)'
                      : pack.level === 3
                        ? 'câu Thành thạo chuyên sâu (đủ 6 miền)'
                        : 'câu Chuyên gia Số & Đạo đức AI'
                    : `Level ${pack.level}+ Expansion Exercises`}
                </p>
                <p className="text-xs text-slate-600 tabular-nums">
                  {pack.unlocked
                    ? lang === 'vi'
                      ? `Đã chinh phục: ${pack.masteredCount}/${pack.totalCount} câu (Còn ${pack.remainingNewCount} câu mới)`
                      : `Mastered: ${pack.masteredCount}/${pack.totalCount} (${pack.remainingNewCount} new left)`
                    : lang === 'vi'
                      ? `Đạt Cấp độ ${pack.level} để tự động mở khóa thêm ${pack.totalCount} câu hỏi mới.`
                      : `Reach Level ${pack.level} to unlock ${pack.totalCount} new questions.`}
                </p>
              </div>
            ))}
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
                  ? 'Mỗi lượt tự động ưu tiên câu chưa làm đúng và tự động trộn thêm các câu Mở rộng đã mở khóa ở cấp độ tương ứng.'
                  : 'Prioritizes unmastered questions and automatically mixes in unlocked higher-level expansion items.'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            {ASSESSMENT_LEVELS.map((lvl) => {
              const clearedAtLevel = Object.values(mastery).filter(
                (m) => m.highestLevel >= lvl.level,
              ).length;
              const pct = Math.round((clearedAtLevel / 24) * 100);
              const expPack = expansionSummary.packs.find((p) => p.level === lvl.level);
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
                        currentLevel,
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
                    {expPack && (
                      <p
                        className={`text-[11px] font-semibold ${
                          expPack.unlocked ? 'text-indigo-700' : 'text-slate-500'
                        }`}
                      >
                        {expPack.unlocked
                          ? lang === 'vi'
                            ? `Đã mở thêm +${expPack.totalCount} câu nâng cao (${24 + expPack.totalCount} câu)`
                            : `+${expPack.totalCount} expansion unlocked (${24 + expPack.totalCount} total)`
                          : lang === 'vi'
                            ? `Đạt Cấp ${lvl.level} để mở thêm +${expPack.totalCount} câu`
                            : `Reach L${lvl.level} for +${expPack.totalCount} more`}
                      </p>
                    )}
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
                        exercises: buildCompetencyFocusDeck(comp.id, currentLevel),
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
                            exercises: buildCompetencyFocusDeck(comp.id, currentLevel),
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
                        ? 'Kiểm tra Tổng hợp 24 Năng lực'
                        : '24-Competency Diagnostic'
                      : att.mode === 'advanced_pack'
                        ? lang === 'vi'
                          ? `Kho Mở Rộng Cấp ${att.targetLevel ?? ''}+`
                          : `Level ${att.targetLevel ?? ''}+ Expansion Pack`
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
