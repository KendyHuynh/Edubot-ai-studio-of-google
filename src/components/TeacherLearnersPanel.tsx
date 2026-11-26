import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BarChart3,
  Check,
  Clock,
  Cloud,
  CloudOff,
  Copy,
  Crown,
  Download,
  Eye,
  Flame,
  Gift,
  GraduationCap,
  History,
  Link2,
  Mail,
  Medal,
  Presentation,
  RefreshCw,
  School,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  Trash2,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import { ASSESSMENT_LEVELS, TEACHER_AWARD_PRESETS } from '../shared/assessmentBank';
import {
  buildCohortCompetencyOverview,
  buildHomeHonorNominations,
  computeDomainMasterySummary,
  getLearnerActivityStatus,
  getLevelMeta,
  LearnerActivityStatus,
  mergeLearnerProfiles,
} from '../shared/assessmentEngine';
import { COMPETENCIES_24, COMPETENCY_DOMAINS } from '../shared/competencies';
import {
  AssessmentSessionAttempt,
  Language,
  LearnerProfile,
  TeacherAward,
} from '../shared/types';
import { apiRequestJson } from '../utils/apiClient';
import {
  deleteTeacherAwardFromFirestore,
  fetchAllLearnersFromFirestore,
  saveTeacherAwardToFirestore,
} from '../utils/firestoreSync';
import {
  buildHomeAssessmentUrl,
  resolveShareableBaseUrl,
} from '../utils/routing';

interface TeacherLearnersPanelProps {
  sharedAppUrl?: string;
  workspaceCode?: string | null;
  cloudSignedIn: boolean;
  teacherEmail?: string | null;
  onSignInCloud?: () => void;
  onLearnersCountChange?: (count: number) => void;
  lang: Language;
}

type PanelViewMode = 'overview' | 'cohort24' | 'sessions';
type SortKey = 'xp' | 'mastered' | 'accuracy' | 'recent';

function formatSessionModeLabel(mode: AssessmentSessionAttempt['mode'], lang: Language): string {
  switch (mode) {
    case 'diagnostic':
      return lang === 'vi' ? 'Kiểm tra Tổng hợp' : 'Diagnostic';
    case 'level_challenge':
      return lang === 'vi' ? 'Thử thách Cấp độ' : 'Level Challenge';
    case 'competency_focus':
      return lang === 'vi' ? 'Luyện 1 Năng lực' : 'Skill Focus';
    case 'advanced_pack':
      return lang === 'vi' ? 'Kho Mở rộng' : 'Expansion Pack';
    case 'variety_sprint':
    default:
      return lang === 'vi' ? 'Thử thách Đa dạng' : 'Variety Sprint';
  }
}

function getActivityBadge(status: LearnerActivityStatus, lang: Language): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'today':
      return {
        label: lang === 'vi' ? 'Học hôm nay' : 'Active today',
        className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      };
    case 'week':
      return {
        label: lang === 'vi' ? '7 ngày qua' : 'Past 7 days',
        className: 'bg-sky-50 text-sky-700 border-sky-200',
      };
    case 'older':
      return {
        label: lang === 'vi' ? 'Cần nhắc ôn' : 'Needs review',
        className: 'bg-amber-50 text-amber-800 border-amber-200',
      };
    case 'not_started':
      return {
        label: lang === 'vi' ? 'Chưa làm bài' : 'Not started',
        className: 'bg-slate-100 text-slate-600 border-slate-200',
      };
  }
}

export function TeacherLearnersPanel({
  sharedAppUrl,
  workspaceCode,
  cloudSignedIn,
  teacherEmail,
  onSignInCloud,
  onLearnersCountChange,
  lang,
}: TeacherLearnersPanelProps) {
  const [learners, setLearners] = useState<LearnerProfile[]>([]);
  const [attempts, setAttempts] = useState<AssessmentSessionAttempt[]>([]);
  const [awards, setAwards] = useState<TeacherAward[]>([]);
  const [loading, setLoading] = useState(true);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Sub-view & Filters
  const [viewMode, setViewMode] = useState<PanelViewMode>('overview');
  const [searchTerm, setSearchTerm] = useState('');
  const [schoolFilter, setSchoolFilter] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<string>('');
  const [activityFilter, setActivityFilter] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortKey>('xp');
  const [copiedLink, setCopiedLink] = useState(false);

  // Detail, Projector Honor Ceremony & Award Modals
  const [inspectLearner, setInspectLearner] = useState<LearnerProfile | null>(null);
  const [projectorOpen, setProjectorOpen] = useState(false);
  const [projectorShowEmail, setProjectorShowEmail] = useState(false);
  const [rewardTarget, setRewardTarget] = useState<LearnerProfile | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState(TEACHER_AWARD_PRESETS[0].id);
  const [customBadgeTitle, setCustomBadgeTitle] = useState(
    TEACHER_AWARD_PRESETS[0].titleVi,
  );
  const [customMessage, setCustomMessage] = useState(
    TEACHER_AWARD_PRESETS[0].defaultMessageVi,
  );
  const [bonusXp, setBonusXp] = useState(TEACHER_AWARD_PRESETS[0].defaultBonusXp);
  const [sendingAward, setSendingAward] = useState(false);

  const shareBaseUrl =
    typeof window !== 'undefined'
      ? resolveShareableBaseUrl(
          window.location.origin,
          window.location.pathname,
          sharedAppUrl,
        )
      : 'http://localhost:3000';
  const homeAssessmentLink = buildHomeAssessmentUrl(shareBaseUrl, workspaceCode);

  const loadData = useCallback(async () => {
    setLoading(true);
    setCloudError(null);
    try {
      const [apiRes, cloudRes] = await Promise.all([
        apiRequestJson<{
          learners?: LearnerProfile[];
          attempts?: AssessmentSessionAttempt[];
          awards?: TeacherAward[];
        }>('/api/teacher/learners', {}, lang).catch(() => null),
        cloudSignedIn
          ? fetchAllLearnersFromFirestore()
          : Promise.resolve({
              learners: [] as LearnerProfile[],
              attempts: [] as AssessmentSessionAttempt[],
              awards: [] as TeacherAward[],
              error: undefined as string | undefined,
              permissionDenied: false,
            }),
      ]);

      if (cloudRes.error) {
        setCloudError(cloudRes.error);
      }

      // Monotonically merge local/server learners and Cloud Firestore learners by uid
      const learnerMap = new Map<string, LearnerProfile>();
      for (const l of [
        ...(apiRes?.ok ? apiRes.data.learners ?? [] : []),
        ...cloudRes.learners,
      ]) {
        if (!l?.uid) continue;
        const prev = learnerMap.get(l.uid);
        learnerMap.set(l.uid, prev ? mergeLearnerProfiles(prev, l) : l);
      }

      const attemptMap = new Map<string, AssessmentSessionAttempt>();
      for (const att of [
        ...(apiRes?.ok ? apiRes.data.attempts ?? [] : []),
        ...cloudRes.attempts,
      ]) {
        if (att?.id) attemptMap.set(att.id, att);
      }

      const awardMap = new Map<string, TeacherAward>();
      for (const a of [
        ...(apiRes?.ok ? apiRes.data.awards ?? [] : []),
        ...cloudRes.awards,
      ]) {
        if (a?.id) awardMap.set(a.id, a);
      }

      const sortedLearners = Array.from(learnerMap.values()).sort((a, b) => {
        if (b.totalXp !== a.totalXp) return b.totalXp - a.totalXp;
        return (b.lastActiveAt || '').localeCompare(a.lastActiveAt || '');
      });

      setLearners(sortedLearners);
      onLearnersCountChange?.(sortedLearners.length);
      setAttempts(
        Array.from(attemptMap.values())
          .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
          .slice(0, 300),
      );
      setAwards(
        Array.from(awardMap.values()).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      );
      setLastRefreshedAt(new Date().toISOString());
    } finally {
      setLoading(false);
    }
  }, [cloudSignedIn, lang, onLearnersCountChange]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const uniqueSchools = useMemo(
    () =>
      Array.from(new Set(learners.map((l) => l.schoolName).filter(Boolean))).sort(),
    [learners],
  );
  const uniqueClasses = useMemo(
    () =>
      Array.from(new Set(learners.map((l) => l.className).filter(Boolean))).sort(),
    [learners],
  );

  const filteredLearners = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const list = learners.filter((l) => {
      if (schoolFilter && l.schoolName !== schoolFilter) return false;
      if (classFilter && l.className !== classFilter) return false;
      if (levelFilter && String(l.currentLevel) !== levelFilter) return false;
      if (activityFilter) {
        const status = getLearnerActivityStatus(l);
        if (activityFilter === 'active7' && status !== 'today' && status !== 'week') {
          return false;
        }
        if (activityFilter !== 'active7' && status !== activityFilter) {
          return false;
        }
      }
      if (q) {
        const hay = `${l.fullName} ${l.className} ${l.schoolName} ${l.email ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const masteredOf = (l: LearnerProfile) =>
      Object.values(l.masteryByCompetency ?? {}).filter((m) => m.highestLevel >= 1).length;
    const accOf = (l: LearnerProfile) =>
      l.totalExercisesDone > 0
        ? Math.round((l.totalCorrect / l.totalExercisesDone) * 100)
        : 0;

    return [...list].sort((a, b) => {
      if (sortBy === 'mastered') {
        const diff = masteredOf(b) - masteredOf(a);
        if (diff !== 0) return diff;
        return b.totalXp - a.totalXp;
      }
      if (sortBy === 'accuracy') {
        const diff = accOf(b) - accOf(a);
        if (diff !== 0) return diff;
        return b.totalExercisesDone - a.totalExercisesDone;
      }
      if (sortBy === 'recent') {
        return (b.lastActiveAt || '').localeCompare(a.lastActiveAt || '');
      }
      if (b.totalXp !== a.totalXp) return b.totalXp - a.totalXp;
      return masteredOf(b) - masteredOf(a);
    });
  }, [learners, schoolFilter, classFilter, levelFilter, activityFilter, searchTerm, sortBy]);

  const cohortOverview = useMemo(
    () => buildCohortCompetencyOverview(filteredLearners),
    [filteredLearners],
  );

  const honorNominations = useMemo(
    () => buildHomeHonorNominations(filteredLearners),
    [filteredLearners],
  );

  const topThreeHonors = useMemo(() => {
    return [...filteredLearners]
      .filter((l) => l.totalExercisesDone > 0 || l.totalXp > 0)
      .sort((a, b) => {
        if (b.totalXp !== a.totalXp) return b.totalXp - a.totalXp;
        const mA = Object.values(a.masteryByCompetency ?? {}).filter((m) => m.highestLevel >= 1).length;
        const mB = Object.values(b.masteryByCompetency ?? {}).filter((m) => m.highestLevel >= 1).length;
        return mB - mA;
      })
      .slice(0, 3);
  }, [filteredLearners]);

  const filteredUids = useMemo(
    () => new Set(filteredLearners.map((l) => l.uid)),
    [filteredLearners],
  );
  const filteredAttempts = useMemo(
    () => attempts.filter((a) => filteredUids.has(a.learnerUid)),
    [attempts, filteredUids],
  );

  const openAwardModal = (learner: LearnerProfile, presetId?: string) => {
    const preset =
      TEACHER_AWARD_PRESETS.find((p) => p.id === presetId) ?? TEACHER_AWARD_PRESETS[0];
    setRewardTarget(learner);
    setSelectedPresetId(preset.id);
    setCustomBadgeTitle(lang === 'vi' ? preset.titleVi : preset.titleEn);
    setCustomMessage(lang === 'vi' ? preset.defaultMessageVi : preset.defaultMessageEn);
    setBonusXp(preset.defaultBonusXp);
  };

  const handleSelectPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    const p = TEACHER_AWARD_PRESETS.find((item) => item.id === presetId);
    if (p) {
      setCustomBadgeTitle(lang === 'vi' ? p.titleVi : p.titleEn);
      setCustomMessage(lang === 'vi' ? p.defaultMessageVi : p.defaultMessageEn);
      setBonusXp(p.defaultBonusXp);
    }
  };

  const handleSendAward = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rewardTarget || !customBadgeTitle.trim() || sendingAward) return;
    setSendingAward(true);
    try {
      const payload = {
        learnerUid: rewardTarget.uid,
        learnerSnapshot: rewardTarget,
        badgeId: selectedPresetId,
        badgeTitle: customBadgeTitle.trim(),
        message: customMessage.trim(),
        bonusXp: Number(bonusXp) || 0,
        awardedByName: teacherEmail ? `GV (${teacherEmail})` : 'Giáo viên',
      };

      const res = await apiRequestJson<{
        award?: TeacherAward;
        learner?: LearnerProfile;
        error?: string;
      }>(
        '/api/teacher/awards',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        lang,
      );

      let createdAward: TeacherAward | null = res.ok ? res.data.award ?? null : null;

      if (!createdAward && cloudSignedIn) {
        createdAward = {
          id: `awd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          learnerUid: rewardTarget.uid,
          learnerName: rewardTarget.fullName,
          className: rewardTarget.className,
          schoolName: rewardTarget.schoolName,
          badgeId: payload.badgeId,
          badgeTitle: payload.badgeTitle,
          message: payload.message,
          bonusXp: payload.bonusXp,
          awardedByName: payload.awardedByName,
          awardedByEmail: teacherEmail ?? undefined,
          createdAt: new Date().toISOString(),
        };
      }

      const existingCount = awards.filter((a) => a.learnerUid === rewardTarget.uid).length;
      let cloudMsg = '';
      if (createdAward && cloudSignedIn) {
        const cloudSave = await saveTeacherAwardToFirestore(
          createdAward,
          rewardTarget,
          existingCount + 1,
        );
        if (!cloudSave.ok && cloudSave.error) {
          cloudMsg = ` (Lưu ý Cloud: ${cloudSave.error})`;
        }
      }

      if (createdAward) {
        setNotice(
          lang === 'vi'
            ? `Đã vinh danh & gửi huy hiệu "${createdAward.badgeTitle}" (+${createdAward.bonusXp} XP) cho em ${rewardTarget.fullName}!${cloudMsg}`
            : `Sent "${createdAward.badgeTitle}" (+${createdAward.bonusXp} XP) to ${rewardTarget.fullName}!${cloudMsg}`,
        );
        window.setTimeout(() => setNotice(null), 6000);
        setRewardTarget(null);
        await loadData();
      }
    } finally {
      setSendingAward(false);
    }
  };

  const handleDeleteAward = async (awardId: string) => {
    await apiRequestJson(
      `/api/teacher/awards/${encodeURIComponent(awardId)}`,
      { method: 'DELETE' },
      lang,
    ).catch(() => undefined);
    if (cloudSignedIn) {
      await deleteTeacherAwardFromFirestore(awardId);
    }
    await loadData();
  };

  const handleCopyHomeLink = async () => {
    try {
      await navigator.clipboard.writeText(homeAssessmentLink);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2500);
    } catch {
      // ignore
    }
  };

  const handleExportCsv = () => {
    const header = [
      'HoTen',
      'EmailGmail',
      'Lop',
      'Truong',
      'CapDo',
      'SoNangLucDat_24',
      'SoNangLucChuyenGia_L3_4',
      'TongXP',
      'SoBaiDaLam',
      'DoChinhXac_%',
      'SoKhenThuong',
      'HoatDongGanNhat',
      'Mien1_%',
      'Mien2_%',
      'Mien3_%',
      'Mien4_%',
      'Mien5_%',
      'Mien6_%',
    ];
    const rows = filteredLearners.map((l) => {
      const records = Object.values(l.masteryByCompetency ?? {});
      const mastered = records.filter((m) => m.highestLevel >= 1).length;
      const expert = records.filter((m) => m.highestLevel >= 3).length;
      const acc =
        l.totalExercisesDone > 0
          ? Math.round((l.totalCorrect / l.totalExercisesDone) * 100)
          : 0;
      const awCount = awards.filter((a) => a.learnerUid === l.uid).length;
      const domainPcts = computeDomainMasterySummary(l.masteryByCompetency ?? {}).map(
        (d) => d.percentComplete,
      );
      return [
        `"${(l.fullName || '').replace(/"/g, '""')}"`,
        `"${(l.email || '').replace(/"/g, '""')}"`,
        `"${(l.className || '').replace(/"/g, '""')}"`,
        `"${(l.schoolName || '').replace(/"/g, '""')}"`,
        l.currentLevel,
        mastered,
        expert,
        l.totalXp,
        l.totalExercisesDone,
        acc,
        awCount,
        `"${l.lastActiveAt ? new Date(l.lastActiveAt).toLocaleString('vi-VN') : ''}"`,
        ...domainPcts,
      ].join(',');
    });
    const csv = `\uFEFF${header.join(',')}\n${rows.join('\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tong-hop-tu-danh-gia-24-nang-luc-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const avgLevel =
    filteredLearners.length > 0
      ? (
          filteredLearners.reduce((sum, l) => sum + l.currentLevel, 0) /
          filteredLearners.length
        ).toFixed(1)
      : '—';
  const totalExercisesAll = filteredLearners.reduce((s, l) => s + l.totalExercisesDone, 0);

  return (
    <div className="space-y-6">
      {/* Cloud Sync Readiness Banner if teacher unlocked via PIN without Google Cloud */}
      {!cloudSignedIn && (
        <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3 max-w-2xl">
            <CloudOff className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1 text-xs sm:text-sm text-amber-950">
              <p className="font-bold">
                {lang === 'vi'
                  ? 'Chưa kết nối Google Giáo viên (Đám mây) — Đang chỉ hiển thị dữ liệu nội bộ máy này'
                  : 'Teacher Google Cloud Not Signed In — Showing Local Device Data Only'}
              </p>
              <p className="text-xs text-amber-800 leading-relaxed">
                {lang === 'vi'
                  ? 'Học sinh ở nhà bắt buộc đăng nhập bằng Gmail cá nhân và lưu thành tích lên Cloud Firestore (đồng thời công khai lên Bảng Vinh danh). Hãy đăng nhập Google Admin để xem đầy đủ chi tiết 24 năng lực và trao huy hiệu.'
                  : 'Home learners sign in with their personal Gmail to sync achievements to Cloud Firestore & the Public Honor Board. Sign in with Teacher Google to inspect all 24 skills and issue awards.'}
              </p>
            </div>
          </div>
          {onSignInCloud && (
            <button
              type="button"
              onClick={onSignInCloud}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-xl cursor-pointer shrink-0"
            >
              <Cloud className="w-4 h-4" />
              <span>
                {lang === 'vi'
                  ? 'Đăng nhập Google Giáo viên ngay'
                  : 'Sign in Teacher Google Cloud'}
              </span>
            </button>
          )}
        </div>
      )}

      {cloudError && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-start gap-3 text-xs sm:text-sm text-rose-900">
          <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-bold">
              {lang === 'vi'
                ? 'Không thể đọc dữ liệu Học sinh Tự học từ Cloud Firestore'
                : 'Could not read Cloud Firestore learner records'}
            </p>
            <p className="text-xs text-rose-800">{cloudError}</p>
          </div>
        </div>
      )}

      {/* Shareable Home Self-Assessment Link Card */}
      <div className="bg-emerald-50/70 border border-emerald-200 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1 max-w-2xl">
          <p className="text-xs font-bold text-emerald-800 flex items-center gap-1.5">
            <Link2 className="w-4 h-4" />
            <span>
              {lang === 'vi'
                ? 'Link Tự đánh giá 24 Năng lực ở nhà (Bắt buộc Gmail cá nhân · Thành tích công khai)'
                : 'Home 24-Competency Self-Assessment Link (Personal Gmail Required · Public Honors)'}
            </span>
          </p>
          <p className="text-xs sm:text-sm text-emerald-950">
            {lang === 'vi'
              ? 'Gửi đường link này cho học sinh tự luyện 24 năng lực thành phần ở nhà. Các em bắt buộc đăng nhập bằng Gmail cá nhân (không mở chế độ khách xem trước đề), thành tích lưu Cloud Firestore để Thầy/Cô vinh danh và công khai trên Bảng Vinh danh Tự học.'
              : 'Share this link for home 24-competency self-assessment. Students must sign in with their personal Gmail (no guest peeking); achievements sync to Cloud Firestore and publish to the Public Honor Board.'}
          </p>
          <p className="font-mono-num text-xs text-emerald-900 bg-white/80 border border-emerald-200 rounded-lg px-3 py-1.5 break-all">
            {homeAssessmentLink}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleCopyHomeLink}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl cursor-pointer"
          >
            {copiedLink ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            <span>
              {copiedLink
                ? lang === 'vi'
                  ? 'Đã sao chép link!'
                  : 'Copied!'
                : lang === 'vi'
                  ? 'Sao chép link Tự đánh giá'
                  : 'Copy Home Link'}
            </span>
          </button>
          <button
            type="button"
            disabled={filteredLearners.length === 0}
            onClick={() => setProjectorOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs sm:text-sm font-semibold text-amber-950 bg-amber-100 hover:bg-amber-200 border border-amber-300 disabled:opacity-40 rounded-xl cursor-pointer"
          >
            <Presentation className="w-4 h-4 text-amber-700" />
            <span>{lang === 'vi' ? 'Trình chiếu Vinh danh' : 'Honor Projector'}</span>
          </button>
          <button
            type="button"
            onClick={() => void loadData()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs sm:text-sm font-semibold text-emerald-900 bg-white border border-emerald-200 hover:bg-emerald-100 rounded-xl cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>{lang === 'vi' ? 'Làm mới' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="p-3.5 rounded-xl bg-emerald-600 text-white text-xs sm:text-sm font-semibold"
        >
          {notice}
        </div>
      )}

      {/* 5 Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs text-slate-500">
            {lang === 'vi' ? 'HS tự học ở nhà' : 'Home Self-Learners'}
          </p>
          <p className="text-2xl font-extrabold font-mono-num text-slate-900 mt-1">
            {filteredLearners.length}
          </p>
          <p className="text-[11px] text-emerald-700 font-semibold mt-0.5 tabular-nums">
            {lang === 'vi'
              ? `${cohortOverview.activeTodayCount} hôm nay · ${cohortOverview.activeWeekCount} tuần này`
              : `${cohortOverview.activeTodayCount} today · ${cohortOverview.activeWeekCount} this week`}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs text-slate-500">
            {lang === 'vi' ? 'Phủ 24 Năng lực TB' : 'Avg 24-Skill Coverage'}
          </p>
          <p className="text-2xl font-extrabold font-mono-num text-indigo-700 mt-1">
            {cohortOverview.avgMasteredCount}{' '}
            <span className="text-sm font-bold text-slate-400">/ 24</span>
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {lang === 'vi' ? 'Năng lực thành phần TT 02' : 'TT 02/2025 skills'}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs text-slate-500">
            {lang === 'vi' ? 'Cấp độ trung bình' : 'Average Level'}
          </p>
          <p className="text-2xl font-extrabold font-mono-num text-sky-700 mt-1">
            {avgLevel === '—' ? '—' : `Cấp ${avgLevel}/4`}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {lang === 'vi' ? 'Khám phá → Chuyên gia' : 'Explorer → Expert'}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs text-slate-500">
            {lang === 'vi' ? 'Tổng bài làm / Chính xác' : 'Exercises / Accuracy'}
          </p>
          <p className="text-2xl font-extrabold font-mono-num text-emerald-700 mt-1">
            {totalExercisesAll}
          </p>
          <p className="text-[11px] text-emerald-800 font-semibold mt-0.5 tabular-nums">
            {lang === 'vi'
              ? `Chính xác TB: ${cohortOverview.avgAccuracyPercent}%`
              : `Avg accuracy: ${cohortOverview.avgAccuracyPercent}%`}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4 col-span-2 lg:col-span-1">
          <p className="text-xs text-slate-500">
            {lang === 'vi' ? 'Huy hiệu Vinh danh' : 'Teacher Honors Sent'}
          </p>
          <p className="text-2xl font-extrabold font-mono-num text-amber-700 mt-1">
            {awards.length}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {lastRefreshedAt
              ? `${lang === 'vi' ? 'Cập nhật' : 'Updated'} ${new Date(
                  lastRefreshedAt,
                ).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`
              : 'Cloud Sync'}
          </p>
        </div>
      </div>

      {/* View Mode Switcher + Global Filters */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-xl text-xs sm:text-sm font-semibold">
            <button
              type="button"
              onClick={() => setViewMode('overview')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg cursor-pointer transition-colors ${
                viewMode === 'overview'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Users className="w-4 h-4 text-sky-600" />
              <span>
                {lang === 'vi'
                  ? `Tổng hợp & Vinh danh (${filteredLearners.length})`
                  : `Summary & Honors (${filteredLearners.length})`}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('cohort24')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg cursor-pointer transition-colors ${
                viewMode === 'cohort24'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <BarChart3 className="w-4 h-4 text-emerald-600" />
              <span>
                {lang === 'vi'
                  ? 'Tổng hợp 24 Năng lực ở nhà'
                  : 'Cohort 24-Skill Breakdown'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('sessions')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg cursor-pointer transition-colors ${
                viewMode === 'sessions'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <History className="w-4 h-4 text-amber-600" />
              <span>
                {lang === 'vi'
                  ? `Phiên luyện (${filteredAttempts.length}) & Khen thưởng (${awards.length})`
                  : `Sessions (${filteredAttempts.length}) & Awards (${awards.length})`}
              </span>
            </button>
          </div>

          <button
            type="button"
            disabled={filteredLearners.length === 0}
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-xl cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{lang === 'vi' ? 'Xuất báo cáo Excel (CSV)' : 'Export CSV Report'}</span>
          </button>
        </div>

        {/* Filter Bar (applies across all 3 teacher views) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5">
          <div className="relative lg:col-span-2">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={
                lang === 'vi'
                  ? 'Tìm tên, email cá nhân, lớp, trường...'
                  : 'Search name, personal email, class...'
              }
              className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          <select
            value={schoolFilter}
            onChange={(e) => setSchoolFilter(e.target.value)}
            className="px-3 py-2 text-xs sm:text-sm border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">{lang === 'vi' ? 'Tất cả Trường' : 'All Schools'}</option>
            {uniqueSchools.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            className="px-3 py-2 text-xs sm:text-sm border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">{lang === 'vi' ? 'Tất cả Lớp' : 'All Classes'}</option>
            {uniqueClasses.map((c) => (
              <option key={c} value={c}>
                {lang === 'vi' ? `Lớp ${c}` : `Class ${c}`}
              </option>
            ))}
          </select>

          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="px-3 py-2 text-xs sm:text-sm border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">{lang === 'vi' ? 'Tất cả Cấp độ' : 'All Levels'}</option>
            {ASSESSMENT_LEVELS.map((l) => (
              <option key={l.level} value={String(l.level)}>
                {lang === 'vi' ? l.nameVi : l.nameEn}
              </option>
            ))}
          </select>

          <select
            value={activityFilter}
            onChange={(e) => setActivityFilter(e.target.value)}
            className="px-3 py-2 text-xs sm:text-sm border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">{lang === 'vi' ? 'Mọi trạng thái học' : 'All Activity'}</option>
            <option value="today">{lang === 'vi' ? 'Học hôm nay' : 'Active today'}</option>
            <option value="active7">{lang === 'vi' ? 'Hoạt động 7 ngày qua' : 'Past 7 days'}</option>
            <option value="older">{lang === 'vi' ? 'Lâu chưa ôn tập' : 'Inactive > 7d'}</option>
            <option value="not_started">{lang === 'vi' ? 'Mới đăng ký · Chưa làm' : 'Not started'}</option>
          </select>
        </div>
      </div>

      {/* ================================================================= */}
      {/* VIEW 1: OVERVIEW, HONOR PODIUM, SMART NOMINATIONS & STUDENT TABLE */}
      {/* ================================================================= */}
      {viewMode === 'overview' && (
        <div className="space-y-6">
          {/* Top 3 Home Self-Study Honor Podium */}
          {topThreeHonors.length > 0 && (
            <div className="bg-gradient-to-br from-amber-50/80 via-white to-sky-50/50 border border-amber-200 rounded-2xl p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-amber-700 flex items-center gap-1.5">
                    <Crown className="w-4 h-4" />
                    <span>
                      {lang === 'vi'
                        ? 'Vinh danh Gương sáng Tự học 24 Năng lực ở nhà'
                        : 'Top Home Self-Assessment Honor Podium'}
                    </span>
                  </p>
                  <h2 className="text-lg sm:text-xl font-bold text-slate-900 mt-0.5">
                    {lang === 'vi'
                      ? `Top ${topThreeHonors.length} Học sinh Nổi bật Nhất${classFilter ? ` · Lớp ${classFilter}` : ''}`
                      : `Top ${topThreeHonors.length} Outstanding Home Learners`}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setProjectorOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-amber-950 bg-white hover:bg-amber-50 border border-amber-300 rounded-xl cursor-pointer"
                >
                  <Presentation className="w-4 h-4 text-amber-700" />
                  <span>{lang === 'vi' ? 'Mở màn hình Vinh danh' : 'Open Honor Display'}</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {topThreeHonors.map((student, idx) => {
                  const mastered = Object.values(student.masteryByCompetency ?? {}).filter(
                    (m) => m.highestLevel >= 1,
                  ).length;
                  const acc =
                    student.totalExercisesDone > 0
                      ? Math.round((student.totalCorrect / student.totalExercisesDone) * 100)
                      : 0;
                  const studentAwards = awards.filter((a) => a.learnerUid === student.uid);
                  const lvl = getLevelMeta(student.currentLevel);
                  const rankColors =
                    idx === 0
                      ? 'border-amber-300 bg-amber-50/50'
                      : idx === 1
                        ? 'border-slate-300 bg-slate-50/70'
                        : 'border-orange-200 bg-orange-50/40';

                  return (
                    <div
                      key={student.uid}
                      className={`bg-white border rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-3 ${rankColors}`}
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 text-xs font-extrabold text-slate-900">
                            {idx === 0 ? (
                              <Trophy className="w-4 h-4 text-amber-600" />
                            ) : (
                              <Medal className="w-4 h-4 text-slate-500" />
                            )}
                            <span>
                              {lang === 'vi' ? `Hạng #${idx + 1}` : `Rank #${idx + 1}`}
                            </span>
                          </span>
                          <span className="font-mono-num text-base font-extrabold text-sky-700">
                            {student.totalXp} XP
                          </span>
                        </div>

                        <div>
                          <h3 className="text-base font-bold text-slate-900 truncate">
                            {student.fullName}
                          </h3>
                          <p className="text-xs text-slate-600 truncate">
                            {student.className} · {student.schoolName}
                          </p>
                          {student.email && (
                            <p className="text-[11px] text-slate-500 truncate mt-0.5">
                              {student.email}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 pt-1">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold border ${lvl.badgeClass}`}
                          >
                            {lvl.code} · {lang === 'vi' ? `Cấp ${student.currentLevel}` : `Lv.${student.currentLevel}`}
                          </span>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 tabular-nums">
                            {mastered}/24 NL
                          </span>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums">
                            {acc}% ({student.totalExercisesDone} bài)
                          </span>
                        </div>
                      </div>

                      <div className="pt-3 border-t border-slate-200/70 flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-amber-800">
                          {studentAwards.length > 0
                            ? `★ ${studentAwards.length} ${lang === 'vi' ? 'huy hiệu' : 'awards'}`
                            : lang === 'vi'
                              ? 'Chưa trao huy hiệu'
                              : 'No award yet'}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setInspectLearner(student)}
                            className="px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                          >
                            {lang === 'vi' ? '24 NL' : 'Skills'}
                          </button>
                          <button
                            type="button"
                            onClick={() => openAwardModal(student, 'master_24')}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-amber-950 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg cursor-pointer"
                          >
                            <Gift className="w-3 h-3" />
                            <span>{lang === 'vi' ? 'Vinh danh' : 'Honor'}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Smart Honor Nominations */}
              {honorNominations.length > 0 && (
                <div className="pt-3 border-t border-amber-200/60 space-y-2.5">
                  <p className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                    <span>
                      {lang === 'vi'
                        ? 'Đề xuất Vinh danh Tự động theo tiêu chí tự học ở nhà'
                        : 'Smart Honor Nominations'}
                    </span>
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {honorNominations.map((nom) => (
                      <div
                        key={nom.categoryId}
                        className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-col justify-between gap-2.5"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="text-[11px] font-bold text-sky-700">
                              {lang === 'vi' ? nom.titleVi : nom.titleEn}
                            </span>
                            {nom.categoryId === 'overall_champion' ? (
                              <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                            ) : nom.categoryId === 'accuracy_star' ? (
                              <Target className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            ) : nom.categoryId === 'diligent_learner' ? (
                              <Flame className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                            ) : (
                              <Star className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                            )}
                          </div>
                          <p className="text-sm font-bold text-slate-900 truncate">
                            {nom.learner.fullName}{' '}
                            <span className="text-xs font-medium text-slate-500">
                              ({nom.learner.className})
                            </span>
                          </p>
                          <p className="text-[11px] text-slate-600 leading-snug">
                            {lang === 'vi' ? nom.reasonVi : nom.reasonEn}
                          </p>
                        </div>
                        <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
                          <span className="font-mono-num text-[11px] font-bold text-slate-700">
                            {nom.metricLabel}
                          </span>
                          <button
                            type="button"
                            onClick={() => openAwardModal(nom.learner, nom.suggestedBadgeId)}
                            className="text-[11px] font-bold text-amber-800 hover:underline cursor-pointer"
                          >
                            {lang === 'vi' ? 'Trao huy hiệu →' : 'Award →'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Learner Progress Table */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-slate-900">
                  {lang === 'vi'
                    ? `Bảng Tổng hợp Học sinh Tự đánh giá 24 Năng lực (${filteredLearners.length})`
                    : `Home 24-Competency Learners (${filteredLearners.length})`}
                </h2>
                <p className="text-xs text-slate-500">
                  {lang === 'vi'
                    ? 'Theo dõi email cá nhân, trạng thái tự học ở nhà, độ phủ 6 miền năng lực và trao huy hiệu vinh danh trực tiếp.'
                    : 'Track personal email accounts, home activity status, 6-domain progress, and issue honors.'}
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <label htmlFor="learners-sort" className="font-medium text-slate-600">
                  {lang === 'vi' ? 'Sắp xếp:' : 'Sort:'}
                </label>
                <select
                  id="learners-sort"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortKey)}
                  className="px-2.5 py-1.5 border border-slate-300 rounded-lg bg-white font-semibold text-slate-700"
                >
                  <option value="xp">{lang === 'vi' ? 'Tổng XP cao nhất' : 'Highest XP'}</option>
                  <option value="mastered">{lang === 'vi' ? 'Nhiều Năng lực /24 nhất' : 'Most Skills /24'}</option>
                  <option value="accuracy">{lang === 'vi' ? 'Độ chính xác cao nhất' : 'Highest Accuracy'}</option>
                  <option value="recent">{lang === 'vi' ? 'Hoạt động gần nhất' : 'Most Recent'}</option>
                </select>
              </div>
            </div>

            {loading ? (
              <div className="py-10 text-center text-sm text-slate-500">
                {lang === 'vi'
                  ? 'Đang tải tổng hợp thành tích học sinh ở nhà...'
                  : 'Loading home learners summary...'}
              </div>
            ) : filteredLearners.length === 0 ? (
              <div className="py-10 text-center space-y-2 text-sm text-slate-500">
                <GraduationCap className="w-8 h-8 text-slate-300 mx-auto" />
                <p className="font-semibold text-slate-700">
                  {lang === 'vi'
                    ? 'Chưa có học sinh nào tự đánh giá ở nhà (hoặc không khớp bộ lọc).'
                    : 'No home self-assessment learners found yet.'}
                </p>
                <p className="text-xs text-slate-500">
                  {lang === 'vi'
                    ? 'Hãy sao chép link Tự đánh giá ở trên gửi cho các em đăng nhập bằng email cá nhân (Google) và khai báo Tên · Lớp · Trường.'
                    : 'Copy the Home Assessment Link above so students can sign in with their personal email and save progress.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[880px] text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600 whitespace-nowrap">
                      <th className="py-3 px-4">{lang === 'vi' ? 'Học sinh & Email cá nhân' : 'Student & Email'}</th>
                      <th className="py-3 px-3">{lang === 'vi' ? 'Lớp · Trường' : 'Class · School'}</th>
                      <th className="py-3 px-3">{lang === 'vi' ? 'Ở nhà ra sao?' : 'Home Status'}</th>
                      <th className="py-3 px-3">{lang === 'vi' ? 'Cấp độ' : 'Level'}</th>
                      <th className="py-3 px-3">{lang === 'vi' ? '24 NL & 6 Miền' : '24 Skills & 6 Domains'}</th>
                      <th className="py-3 px-3 text-right">{lang === 'vi' ? 'XP / Chính xác' : 'XP / Acc'}</th>
                      <th className="py-3 px-3 text-center">{lang === 'vi' ? 'Vinh danh' : 'Awards'}</th>
                      <th className="py-3 px-4 text-right">{lang === 'vi' ? 'Thao tác' : 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                    {filteredLearners.map((l) => {
                      const lvlMeta = getLevelMeta(l.currentLevel);
                      const mastered = Object.values(l.masteryByCompetency ?? {}).filter(
                        (m) => m.highestLevel >= 1,
                      ).length;
                      const acc =
                        l.totalExercisesDone > 0
                          ? Math.round((l.totalCorrect / l.totalExercisesDone) * 100)
                          : 0;
                      const studentAwards = awards.filter((a) => a.learnerUid === l.uid);
                      const actStatus = getLearnerActivityStatus(l);
                      const actBadge = getActivityBadge(actStatus, lang);
                      const domSums = computeDomainMasterySummary(l.masteryByCompetency ?? {});

                      return (
                        <tr key={l.uid} className="hover:bg-slate-50/70">
                          <td className="py-3.5 px-4">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-bold text-slate-900">{l.fullName}</span>
                              {l.authType === 'google' && (
                                <span
                                  title={l.email || 'Google verified'}
                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold"
                                >
                                  <ShieldCheck className="w-3 h-3" />
                                  Gmail
                                </span>
                              )}
                            </div>
                            {l.email && (
                              <p className="text-[11px] text-slate-500 flex items-center gap-1 mt-0.5 truncate max-w-[230px]">
                                <Mail className="w-3 h-3 shrink-0 text-slate-400" />
                                <span className="truncate">{l.email}</span>
                              </p>
                            )}
                          </td>
                          <td className="py-3.5 px-3">
                            <p className="font-semibold text-slate-800">{l.className}</p>
                            <p className="text-[11px] text-slate-500 flex items-center gap-1">
                              <School className="w-3 h-3 shrink-0" />
                              <span className="truncate max-w-[160px]">{l.schoolName}</span>
                            </p>
                          </td>
                          <td className="py-3.5 px-3">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${actBadge.className}`}
                            >
                              <Clock className="w-3 h-3" />
                              <span>{actBadge.label}</span>
                            </span>
                            {l.lastActiveAt && l.totalExercisesDone > 0 && (
                              <p className="text-[10px] text-slate-400 mt-0.5 tabular-nums">
                                {new Date(l.lastActiveAt).toLocaleDateString('vi-VN')}
                              </p>
                            )}
                          </td>
                          <td className="py-3.5 px-3">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${lvlMeta.badgeClass}`}
                            >
                              {lvlMeta.code} · {lang === 'vi' ? `Cấp ${l.currentLevel}` : `Lv.${l.currentLevel}`}
                            </span>
                          </td>
                          <td className="py-3.5 px-3">
                            <div className="space-y-1">
                              <p className="font-mono-num font-bold text-slate-900 text-xs">
                                {mastered} / 24{' '}
                                <span className="font-normal text-slate-500">
                                  ({Math.round((mastered / 24) * 100)}%)
                                </span>
                              </p>
                              <div
                                className="flex items-center gap-1"
                                title={domSums
                                  .map((d, i) => `M${i + 1}: ${d.masteredCount}/${d.totalCompetencies}`)
                                  .join(' · ')}
                              >
                                {domSums.map((d, i) => {
                                  const dom = COMPETENCY_DOMAINS[i];
                                  return (
                                    <div
                                      key={d.domainId}
                                      className="w-6 h-1.5 rounded-full bg-slate-100 overflow-hidden"
                                    >
                                      <div
                                        className="h-full rounded-full"
                                        style={{
                                          width: `${Math.max(
                                            d.masteredCount > 0 ? 18 : 0,
                                            Math.round((d.masteredCount / Math.max(1, d.totalCompetencies)) * 100),
                                          )}%`,
                                          backgroundColor: dom?.accentHex || '#0284c7',
                                        }}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </td>
                          <td className="py-3.5 px-3 text-right tabular-nums">
                            <p className="font-mono-num font-bold text-sky-700">{l.totalXp} XP</p>
                            <p className="text-[11px] text-slate-500">
                              {acc}% ({l.totalExercisesDone} {lang === 'vi' ? 'bài' : 'done'})
                            </p>
                          </td>
                          <td className="py-3.5 px-3 text-center">
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-xs font-bold tabular-nums">
                              <Award className="w-3.5 h-3.5" />
                              {studentAwards.length}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setInspectLearner(l)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                <span>{lang === 'vi' ? 'Xem 24 NL' : '24 Skills'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => openAwardModal(l)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg cursor-pointer"
                              >
                                <Gift className="w-3.5 h-3.5" />
                                <span>{lang === 'vi' ? 'Vinh danh' : 'Honor'}</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* VIEW 2: COHORT 24-COMPETENCY SUMMARY ACROSS ALL HOME LEARNERS     */}
      {/* ================================================================= */}
      {viewMode === 'cohort24' && (
        <div className="space-y-6">
          {/* Strongest vs Needs-Reinforcement Callout */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-emerald-50/60 border border-emerald-200 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-emerald-950 flex items-center gap-2">
                <Trophy className="w-4 h-4 text-emerald-600" />
                <span>
                  {lang === 'vi'
                    ? 'Năng lực các em làm tốt nhất ở nhà'
                    : 'Strongest Home Competencies'}
                </span>
              </h3>
              {cohortOverview.strongestCompetencies.length === 0 ? (
                <p className="text-xs text-emerald-800">
                  {lang === 'vi'
                    ? 'Chưa đủ dữ liệu luyện tập để xếp hạng.'
                    : 'Not enough practice data yet.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {cohortOverview.strongestCompetencies.map((stat) => (
                    <div
                      key={stat.competencyId}
                      className="bg-white border border-emerald-200 rounded-xl p-3 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="font-bold text-slate-900 truncate">
                          {stat.competencyId} · {lang === 'vi' ? stat.nameVi : stat.nameEn}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {stat.masteredLearners}/{cohortOverview.learnerCount}{' '}
                          {lang === 'vi' ? 'HS đạt' : 'achieved'} ·{' '}
                          {lang === 'vi' ? 'Chính xác' : 'Acc'} {stat.accuracyPercent}%
                        </p>
                      </div>
                      <span className="font-mono-num text-sm font-extrabold text-emerald-700 shrink-0">
                        {stat.masteryRatePercent}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-amber-50/60 border border-amber-200 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-amber-950 flex items-center gap-2">
                <Target className="w-4 h-4 text-amber-600" />
                <span>
                  {lang === 'vi'
                    ? 'Năng lực cần Thầy/Cô củng cố thêm trên lớp'
                    : 'Competencies Needing Classroom Focus'}
                </span>
              </h3>
              {cohortOverview.learnerCount === 0 ? (
                <p className="text-xs text-amber-800">
                  {lang === 'vi'
                    ? 'Chưa có học sinh nào tự đánh giá.'
                    : 'No learner data yet.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {cohortOverview.weakestCompetencies.map((stat) => (
                    <div
                      key={stat.competencyId}
                      className="bg-white border border-amber-200 rounded-xl p-3 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="font-bold text-slate-900 truncate">
                          {stat.competencyId} · {lang === 'vi' ? stat.nameVi : stat.nameEn}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {stat.masteredLearners}/{cohortOverview.learnerCount}{' '}
                          {lang === 'vi' ? 'HS đạt' : 'achieved'} · {stat.totalAttempts}{' '}
                          {lang === 'vi' ? 'lượt làm' : 'attempts'}
                        </p>
                      </div>
                      <span className="font-mono-num text-sm font-extrabold text-amber-700 shrink-0">
                        {stat.masteryRatePercent}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Full 6 Domains x 24 Component Competencies Cohort Map */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-6">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900">
                {lang === 'vi'
                  ? `Bản đồ Tổng hợp 24 Năng lực Thành phần ở nhà (${cohortOverview.learnerCount} học sinh)`
                  : `Aggregated 24 Component Competencies (${cohortOverview.learnerCount} students)`}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {lang === 'vi'
                  ? 'Thống kê số lượng học sinh đã mở khóa (Cấp 1+), đạt Thành thạo/Chuyên gia (Cấp 3–4) và độ chính xác ở từng năng lực thành phần.'
                  : 'Shows how many students unlocked each competency (L1+), reached proficient/expert (L3–L4), and cohort accuracy.'}
              </p>
            </div>

            <div className="space-y-6">
              {cohortOverview.domains.map((domStat) => {
                const domainMeta = COMPETENCY_DOMAINS.find((d) => d.id === domStat.domainId);
                return (
                  <div key={domStat.domainId} className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2.5 py-0.5 rounded-lg text-xs font-bold border ${
                            domainMeta
                              ? `${domainMeta.surfaceClass} ${domainMeta.textClass} ${domainMeta.borderClass}`
                              : 'bg-slate-100 text-slate-700 border-slate-200'
                          }`}
                        >
                          {lang === 'vi' ? `Miền ${domStat.domainNumber}` : `Domain ${domStat.domainNumber}`}
                        </span>
                        <h3 className="text-sm sm:text-base font-bold text-slate-900">
                          {lang === 'vi' ? domStat.nameVi : domStat.nameEn}
                        </h3>
                      </div>
                      <span className="font-mono-num text-xs font-bold text-slate-700">
                        {lang === 'vi' ? 'Độ phủ TB' : 'Avg Mastery'}: {domStat.avgMasteryRatePercent}% · Cấp TB {domStat.avgLevel}/4
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {domStat.competencies.map((c) => (
                        <div
                          key={c.competencyId}
                          className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/40 space-y-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-bold text-slate-900 leading-snug">
                              <span className={`font-mono-num mr-1 ${domainMeta?.textClass ?? 'text-sky-700'}`}>
                                {c.competencyId}
                              </span>
                              {lang === 'vi' ? c.nameVi : c.nameEn}
                            </p>
                            <span className="font-mono-num text-xs font-extrabold text-slate-900 shrink-0">
                              {c.masteryRatePercent}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-slate-200 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${c.masteryRatePercent}%`,
                                backgroundColor: domainMeta?.accentHex || '#0284c7',
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-slate-600 tabular-nums">
                            <span>
                              {c.masteredLearners}/{cohortOverview.learnerCount}{' '}
                              {lang === 'vi' ? 'em đạt' : 'passed'}
                              {c.expertLearners > 0 ? ` (${c.expertLearners} cao)` : ''}
                            </span>
                            <span>
                              {c.totalAttempts > 0
                                ? `${c.accuracyPercent}% (${c.totalAttempts} lượt)`
                                : lang === 'vi'
                                  ? 'Chưa luyện'
                                  : 'No attempts'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* VIEW 3: RECENT HOME SESSIONS & ISSUED AWARDS HISTORY              */}
      {/* ================================================================= */}
      {viewMode === 'sessions' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent Home Assessment Sessions */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <History className="w-4 h-4 text-sky-600" />
              <span>
                {lang === 'vi'
                  ? `Các phiên Tự đánh giá ở nhà gần nhất (${filteredAttempts.length})`
                  : `Recent Home Assessment Sessions (${filteredAttempts.length})`}
              </span>
            </h3>
            {filteredAttempts.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                {lang === 'vi'
                  ? 'Chưa ghi nhận phiên luyện tập mới từ các học sinh thuộc bộ lọc này.'
                  : 'No recent home sessions recorded for this filter yet.'}
              </p>
            ) : (
              <div className="divide-y divide-slate-100 max-h-[520px] overflow-y-auto">
                {filteredAttempts.slice(0, 40).map((att) => (
                  <div
                    key={att.id}
                    className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <p className="font-bold text-slate-900">
                        {att.learnerName}{' '}
                        <span className="font-normal text-slate-500">
                          ({att.className})
                        </span>
                      </p>
                      <p className="text-slate-600">
                        {formatSessionModeLabel(att.mode, lang)}
                        {att.targetCompetencyId ? ` · NL ${att.targetCompetencyId}` : ''}
                        {att.targetLevel ? ` · Cấp ${att.targetLevel}` : ''} ·{' '}
                        {att.correctCount}/{att.totalQuestions} ({att.accuracyPercent}%)
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {new Date(att.completedAt).toLocaleString('vi-VN')}
                        {att.competencyIds.length > 0
                          ? ` · ${att.competencyIds.slice(0, 5).join(', ')}`
                          : ''}
                      </p>
                    </div>
                    <span className="font-mono-num font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full shrink-0">
                      +{att.xpEarned} XP
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Issued Awards History */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Award className="w-4 h-4 text-amber-600" />
              <span>
                {lang === 'vi'
                  ? `Lịch sử Khen thưởng & Vinh danh đã trao (${awards.length})`
                  : `Issued Honors & Awards (${awards.length})`}
              </span>
            </h3>
            {awards.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                {lang === 'vi'
                  ? 'Chưa có huy hiệu khen thưởng nào được trao. Hãy bấm "Vinh danh" ở bảng tổng hợp để động viên các em!'
                  : 'No awards issued yet.'}
              </p>
            ) : (
              <div className="divide-y divide-slate-100 max-h-[520px] overflow-y-auto">
                {awards.slice(0, 40).map((aw) => (
                  <div
                    key={aw.id}
                    className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <p className="font-bold text-slate-900">
                        {aw.learnerName}{' '}
                        <span className="font-normal text-slate-500">
                          ({aw.className} · {aw.schoolName})
                        </span>{' '}
                        — <span className="text-amber-700">{aw.badgeTitle}</span>
                      </p>
                      {aw.message && (
                        <p className="text-xs text-slate-600">“{aw.message}”</p>
                      )}
                      <p className="text-[11px] text-slate-400">
                        +{aw.bonusXp} XP · {aw.awardedByName} ·{' '}
                        {new Date(aw.createdAt).toLocaleString('vi-VN')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDeleteAward(aw.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 rounded-lg cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{lang === 'vi' ? 'Gỡ' : 'Remove'}</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 1: Inspect Student's Full 24 Competencies */}
      {inspectLearner && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-4xl w-full max-h-[88vh] overflow-y-auto p-6 space-y-5">
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h3 className="text-lg sm:text-xl font-bold text-slate-900">
                  {inspectLearner.fullName} · {inspectLearner.className}
                </h3>
                <p className="text-xs sm:text-sm text-slate-500">
                  {inspectLearner.schoolName}
                  {inspectLearner.email ? ` · ${inspectLearner.email}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const target = inspectLearner;
                    setInspectLearner(null);
                    openAwardModal(target);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-900 bg-amber-100 hover:bg-amber-200 rounded-lg cursor-pointer"
                >
                  <Gift className="w-3.5 h-3.5" />
                  <span>{lang === 'vi' ? 'Vinh danh em này' : 'Honor Student'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInspectLearner(null)}
                  className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="space-y-4">
              {COMPETENCY_DOMAINS.map((domain) => {
                const comps = COMPETENCIES_24.filter((c) => c.domainId === domain.id);
                return (
                  <div key={domain.id} className="space-y-2">
                    <h4 className={`text-xs font-bold uppercase ${domain.textClass}`}>
                      {lang === 'vi'
                        ? `Miền ${domain.number}: ${domain.nameVi}`
                        : `Domain ${domain.number}: ${domain.nameEn}`}
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {comps.map((c) => {
                        const rec = inspectLearner.masteryByCompetency?.[c.id];
                        const lvl = rec?.highestLevel ?? 0;
                        return (
                          <div
                            key={c.id}
                            className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-2 ${
                              lvl >= 3
                                ? 'bg-emerald-50/60 border-emerald-200'
                                : lvl >= 1
                                  ? 'bg-sky-50/40 border-sky-200'
                                  : 'bg-slate-50 border-slate-200'
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="font-bold text-slate-900 truncate">
                                {c.id} · {lang === 'vi' ? c.nameVi : c.nameEn}
                              </p>
                              <p className="text-[11px] text-slate-500">
                                {rec
                                  ? `${rec.correctCount}/${rec.attempts} đúng · +${rec.xp} XP`
                                  : lang === 'vi'
                                    ? 'Chưa làm'
                                    : 'Not attempted'}
                              </p>
                            </div>
                            <div className="flex items-center gap-0.5 shrink-0">
                              {[1, 2, 3, 4].map((s) => (
                                <Star
                                  key={s}
                                  className={`w-3.5 h-3.5 ${
                                    lvl >= s
                                      ? 'text-amber-500 fill-amber-400'
                                      : 'text-slate-300'
                                  }`}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {attempts.filter((a) => a.learnerUid === inspectLearner.uid).length > 0 && (
              <div className="pt-3 border-t border-slate-100 space-y-2">
                <h4 className="text-xs font-bold uppercase text-slate-500">
                  {lang === 'vi' ? 'Các phiên luyện ở nhà gần nhất' : 'Recent Home Sessions'}
                </h4>
                <div className="space-y-1.5 text-xs">
                  {attempts
                    .filter((a) => a.learnerUid === inspectLearner.uid)
                    .slice(0, 8)
                    .map((att) => (
                      <div
                        key={att.id}
                        className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded-lg"
                      >
                        <span>
                          {formatSessionModeLabel(att.mode, lang)} · {att.correctCount}/{att.totalQuestions} ({att.accuracyPercent}%) ·{' '}
                          <span className="text-slate-400">
                            {new Date(att.completedAt).toLocaleString('vi-VN')}
                          </span>
                        </span>
                        <span className="font-mono-num text-emerald-700 font-bold">
                          +{att.xpEarned} XP
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 2: Teacher Award / Praise Composer */}
      {rewardTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-amber-700">
                  {lang === 'vi' ? 'Vinh danh & Gửi Huy hiệu Khen thưởng' : 'Honor & Send Bonus XP'}
                </p>
                <h3 className="text-lg font-bold text-slate-900">
                  {rewardTarget.fullName} · {rewardTarget.className}
                </h3>
                <p className="text-xs text-slate-500">
                  {rewardTarget.schoolName}
                  {rewardTarget.email ? ` · ${rewardTarget.email}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRewardTarget(null)}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSendAward} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">
                  {lang === 'vi' ? 'Chọn nhanh mẫu Huy hiệu khen thưởng' : 'Quick Award Presets'}
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {TEACHER_AWARD_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleSelectPreset(preset.id)}
                      className={`text-left px-3 py-2 rounded-xl border text-xs font-semibold cursor-pointer transition-colors ${
                        selectedPresetId === preset.id
                          ? 'border-amber-500 bg-amber-50 text-amber-950'
                          : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      {lang === 'vi' ? preset.titleVi : preset.titleEn}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2 space-y-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    {lang === 'vi' ? 'Tên Huy hiệu / Danh hiệu' : 'Badge Title'}
                  </label>
                  <input
                    type="text"
                    required
                    value={customBadgeTitle}
                    onChange={(e) => setCustomBadgeTitle(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    {lang === 'vi' ? 'Điểm thưởng XP' : 'Bonus XP'}
                  </label>
                  <select
                    value={bonusXp}
                    onChange={(e) => setBonusXp(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                  >
                    <option value={50}>+50 XP</option>
                    <option value={80}>+80 XP</option>
                    <option value={100}>+100 XP</option>
                    <option value={150}>+150 XP</option>
                    <option value={200}>+200 XP</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-slate-700">
                  {lang === 'vi' ? 'Lời khen động viên gửi tới học sinh' : 'Encouraging Note'}
                </label>
                <textarea
                  rows={3}
                  value={customMessage}
                  onChange={(e) => setCustomMessage(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRewardTarget(null)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer"
                >
                  {lang === 'vi' ? 'Hủy' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  disabled={sendingAward}
                  className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 rounded-xl cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  <span>
                    {sendingAward
                      ? lang === 'vi'
                        ? 'Đang gửi & cộng XP...'
                        : 'Sending...'
                      : lang === 'vi'
                        ? 'Trao khen thưởng ngay'
                        : 'Send Award Now'}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: Classroom Projector Honor Ceremony View */}
      {projectorOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6">
          <div className="bg-white border border-amber-300 rounded-3xl max-w-5xl w-full max-h-[92vh] overflow-y-auto p-6 sm:p-8 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
              <div className="space-y-1">
                <p className="text-xs font-extrabold uppercase tracking-wider text-amber-700 flex items-center gap-1.5">
                  <Trophy className="w-4 h-4" />
                  <span>
                    {lang === 'vi'
                      ? 'Bảng Vàng Vinh Danh Công Dân Số TT 02/2025'
                      : 'Digital Citizenship Honor Board'}
                  </span>
                </p>
                <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900">
                  {lang === 'vi'
                    ? `Vinh Danh Học Sinh Tự Học 24 Năng Lực Ở Nhà${classFilter ? ` · Lớp ${classFilter}` : ''}`
                    : `Home 24-Competency Self-Study Honors${classFilter ? ` · Class ${classFilter}` : ''}`}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 bg-slate-100 px-3 py-1.5 rounded-xl cursor-pointer">
                  <input
                    type="checkbox"
                    checked={projectorShowEmail}
                    onChange={(e) => setProjectorShowEmail(e.target.checked)}
                    className="rounded"
                  />
                  <span>{lang === 'vi' ? 'Hiện email' : 'Show emails'}</span>
                </label>
                <button
                  type="button"
                  onClick={() => setProjectorOpen(false)}
                  className="p-2 rounded-xl hover:bg-slate-100 text-slate-600 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {topThreeHonors.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {topThreeHonors.map((st, idx) => {
                  const mastered = Object.values(st.masteryByCompetency ?? {}).filter(
                    (m) => m.highestLevel >= 1,
                  ).length;
                  const latestAward = awards.find((a) => a.learnerUid === st.uid);
                  return (
                    <div
                      key={st.uid}
                      className={`rounded-2xl p-5 border-2 text-center space-y-2 ${
                        idx === 0
                          ? 'bg-amber-50 border-amber-400'
                          : idx === 1
                            ? 'bg-slate-50 border-slate-300'
                            : 'bg-orange-50/70 border-orange-300'
                      }`}
                    >
                      <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-white shadow-xs mx-auto">
                        {idx === 0 ? (
                          <Crown className="w-7 h-7 text-amber-500" />
                        ) : (
                          <Medal className="w-7 h-7 text-slate-500" />
                        )}
                      </div>
                      <p className="text-xs font-extrabold uppercase text-amber-800">
                        {idx === 0
                          ? lang === 'vi'
                            ? 'Quán Quân Tự Học'
                            : 'Champion #1'
                          : idx === 1
                            ? lang === 'vi'
                              ? 'Á Quân #2'
                              : 'Runner-Up #2'
                            : lang === 'vi'
                              ? 'Hạng Ba #3'
                              : 'Third Place #3'}
                      </p>
                      <h3 className="text-xl font-extrabold text-slate-900">{st.fullName}</h3>
                      <p className="text-xs font-semibold text-slate-600">
                        {st.className} · {st.schoolName}
                      </p>
                      {projectorShowEmail && st.email && (
                        <p className="text-[11px] text-slate-500">{st.email}</p>
                      )}
                      <p className="text-2xl font-extrabold font-mono-num text-sky-700 pt-1">
                        {st.totalXp} XP
                      </p>
                      <p className="text-xs font-bold text-emerald-700">
                        {mastered}/24 {lang === 'vi' ? 'năng lực thành phần' : 'competencies'} · Cấp {st.currentLevel}/4
                      </p>
                      {latestAward && (
                        <p className="text-xs font-bold text-amber-800 bg-white/90 border border-amber-200 rounded-lg px-2.5 py-1 inline-block">
                          ★ {latestAward.badgeTitle}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="overflow-x-auto border border-slate-200 rounded-2xl">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-600">
                    <th className="py-3 px-4">#</th>
                    <th className="py-3 px-4">{lang === 'vi' ? 'Học sinh' : 'Student'}</th>
                    <th className="py-3 px-4">{lang === 'vi' ? 'Lớp · Trường' : 'Class'}</th>
                    <th className="py-3 px-4 text-right">{lang === 'vi' ? '24 Năng lực' : '24 Skills'}</th>
                    <th className="py-3 px-4 text-right">{lang === 'vi' ? 'Chính xác' : 'Accuracy'}</th>
                    <th className="py-3 px-4 text-right">XP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredLearners.slice(0, 15).map((l, idx) => {
                    const mastered = Object.values(l.masteryByCompetency ?? {}).filter(
                      (m) => m.highestLevel >= 1,
                    ).length;
                    const acc =
                      l.totalExercisesDone > 0
                        ? Math.round((l.totalCorrect / l.totalExercisesDone) * 100)
                        : 0;
                    const latestAw = awards.find((a) => a.learnerUid === l.uid);
                    return (
                      <tr key={l.uid}>
                        <td className="py-3 px-4 font-mono-num font-extrabold text-slate-900">
                          #{idx + 1}
                        </td>
                        <td className="py-3 px-4">
                          <p className="font-bold text-slate-900">{l.fullName}</p>
                          {latestAw && (
                            <p className="text-xs font-semibold text-amber-700">
                              ★ {latestAw.badgeTitle}
                            </p>
                          )}
                          {projectorShowEmail && l.email && (
                            <p className="text-[11px] text-slate-400">{l.email}</p>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600">
                          {l.className} · {l.schoolName}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num font-bold text-slate-900">
                          {mastered}/24
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num text-slate-700">
                          {acc}%
                        </td>
                        <td className="py-3 px-4 text-right font-mono-num font-extrabold text-sky-700">
                          {l.totalXp} XP
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
