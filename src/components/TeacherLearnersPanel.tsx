import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Award,
  Check,
  Copy,
  Download,
  Eye,
  Gift,
  GraduationCap,
  Link2,
  RefreshCw,
  School,
  Search,
  Send,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { ASSESSMENT_LEVELS, TEACHER_AWARD_PRESETS } from '../shared/assessmentBank';
import { getLevelMeta } from '../shared/assessmentEngine';
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
  lang: Language;
}

export function TeacherLearnersPanel({
  sharedAppUrl,
  workspaceCode,
  cloudSignedIn,
  teacherEmail,
  lang,
}: TeacherLearnersPanelProps) {
  const [learners, setLearners] = useState<LearnerProfile[]>([]);
  const [attempts, setAttempts] = useState<AssessmentSessionAttempt[]>([]);
  const [awards, setAwards] = useState<TeacherAward[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [schoolFilter, setSchoolFilter] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState(false);

  // Detail & Award Modals
  const [inspectLearner, setInspectLearner] = useState<LearnerProfile | null>(null);
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
    try {
      const [apiRes, cloudRes] = await Promise.all([
        apiRequestJson<{
          learners?: LearnerProfile[];
          attempts?: AssessmentSessionAttempt[];
          awards?: TeacherAward[];
        }>('/api/teacher/learners', {}, lang).catch(() => null),
        cloudSignedIn
          ? fetchAllLearnersFromFirestore().catch(() => ({
              learners: [] as LearnerProfile[],
              awards: [] as TeacherAward[],
            }))
          : Promise.resolve({
              learners: [] as LearnerProfile[],
              awards: [] as TeacherAward[],
            }),
      ]);

      // Merge learners by uid, preferring the record with higher totalXp / newer update
      const learnerMap = new Map<string, LearnerProfile>();
      for (const l of [...(apiRes?.ok ? apiRes.data.learners ?? [] : []), ...cloudRes.learners]) {
        const prev = learnerMap.get(l.uid);
        if (
          !prev ||
          l.totalXp > prev.totalXp ||
          (l.totalXp === prev.totalXp && l.updatedAt > prev.updatedAt)
        ) {
          learnerMap.set(l.uid, l);
        }
      }

      const awardMap = new Map<string, TeacherAward>();
      for (const a of [...(apiRes?.ok ? apiRes.data.awards ?? [] : []), ...cloudRes.awards]) {
        awardMap.set(a.id, a);
      }

      setLearners(
        Array.from(learnerMap.values()).sort((a, b) => {
          if (b.totalXp !== a.totalXp) return b.totalXp - a.totalXp;
          return b.lastActiveAt.localeCompare(a.lastActiveAt);
        }),
      );
      setAttempts(apiRes?.ok ? apiRes.data.attempts ?? [] : []);
      setAwards(
        Array.from(awardMap.values()).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [cloudSignedIn, lang]);

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
    return learners.filter((l) => {
      if (schoolFilter && l.schoolName !== schoolFilter) return false;
      if (classFilter && l.className !== classFilter) return false;
      if (levelFilter && String(l.currentLevel) !== levelFilter) return false;
      if (q) {
        const hay = `${l.fullName} ${l.className} ${l.schoolName} ${l.email ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [learners, schoolFilter, classFilter, levelFilter, searchTerm]);

  const openAwardModal = (learner: LearnerProfile) => {
    const first = TEACHER_AWARD_PRESETS[0];
    setRewardTarget(learner);
    setSelectedPresetId(first.id);
    setCustomBadgeTitle(lang === 'vi' ? first.titleVi : first.titleEn);
    setCustomMessage(lang === 'vi' ? first.defaultMessageVi : first.defaultMessageEn);
    setBonusXp(first.defaultBonusXp);
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

      // If learner only exists in Cloud Firestore (e.g. different device), construct award & write to Firestore directly
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

      if (createdAward && cloudSignedIn) {
        await saveTeacherAwardToFirestore(createdAward);
      }

      if (createdAward) {
        setNotice(
          lang === 'vi'
            ? `Đã gửi khen thưởng "${createdAward.badgeTitle}" (+${createdAward.bonusXp} XP) cho em ${rewardTarget.fullName}!`
            : `Sent "${createdAward.badgeTitle}" (+${createdAward.bonusXp} XP) to ${rewardTarget.fullName}!`,
        );
        window.setTimeout(() => setNotice(null), 5000);
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
      'Lop',
      'Truong',
      'EmailGoogle',
      'CapDo',
      'SoNangLucDat_24',
      'TongXP',
      'SoBaiDaLam',
      'DoChinhXac_%',
      'SoKhenThuong',
    ];
    const rows = filteredLearners.map((l) => {
      const mastered = Object.values(l.masteryByCompetency ?? {}).filter(
        (m) => m.highestLevel >= 1,
      ).length;
      const acc =
        l.totalExercisesDone > 0
          ? Math.round((l.totalCorrect / l.totalExercisesDone) * 100)
          : 0;
      const awCount = awards.filter((a) => a.learnerUid === l.uid).length;
      return [
        `"${(l.fullName || '').replace(/"/g, '""')}"`,
        `"${(l.className || '').replace(/"/g, '""')}"`,
        `"${(l.schoolName || '').replace(/"/g, '""')}"`,
        `"${(l.email || 'Khach').replace(/"/g, '""')}"`,
        l.currentLevel,
        mastered,
        l.totalXp,
        l.totalExercisesDone,
        acc,
        awCount,
      ].join(',');
    });
    const csv = `\uFEFF${header.join(',')}\n${rows.join('\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tu-danh-gia-24-nang-luc-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const avgLevel =
    learners.length > 0
      ? (
          learners.reduce((sum, l) => sum + l.currentLevel, 0) / learners.length
        ).toFixed(1)
      : '—';
  const totalExercisesAll = learners.reduce((s, l) => s + l.totalExercisesDone, 0);

  return (
    <div className="space-y-6">
      {/* Shareable Home Self-Assessment Link Card */}
      <div className="bg-emerald-50/70 border border-emerald-200 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1 max-w-2xl">
          <p className="text-xs font-bold text-emerald-800 flex items-center gap-1.5">
            <Link2 className="w-4 h-4" />
            <span>
              {lang === 'vi'
                ? 'Link Tự đánh giá 24 Năng lực ở nhà (Phân quyền Cá nhân Học sinh)'
                : 'Home 24-Competency Self-Assessment Share Link'}
            </span>
          </p>
          <p className="text-xs sm:text-sm text-emerald-950">
            {lang === 'vi'
              ? 'Gửi đường link này cho học sinh tự luyện ở nhà. Các em đăng nhập Google, khai báo Tên · Lớp · Trường và kết quả sẽ hiện ngay tại bảng bên dưới để Thầy/Cô xem và khen thưởng.'
              : 'Share this link for home practice. Students sign in with Google, enter Name · Class · School, and appear below for review & awards.'}
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
                  : 'Copy Home Assessment Link'}
            </span>
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

      {/* 4 Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs text-slate-500">
            {lang === 'vi' ? 'Học sinh đăng ký Tự đánh giá' : 'Registered Self-Learners'}
          </p>
          <p className="text-2xl font-extrabold font-mono-num text-slate-900 mt-1">
            {learners.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs text-slate-500">
            {lang === 'vi' ? 'Cấp độ trung bình' : 'Average Level'}
          </p>
          <p className="text-2xl font-extrabold font-mono-num text-sky-700 mt-1">
            {avgLevel === '—' ? '—' : `Cấp ${avgLevel}/4`}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs text-slate-500">
            {lang === 'vi' ? 'Tổng bài tập đã hoàn thành' : 'Total Exercises Done'}
          </p>
          <p className="text-2xl font-extrabold font-mono-num text-emerald-700 mt-1">
            {totalExercisesAll}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4">
          <p className="text-xs text-slate-500">
            {lang === 'vi' ? 'Huy hiệu khen thưởng đã trao' : 'Teacher Awards Sent'}
          </p>
          <p className="text-2xl font-extrabold font-mono-num text-amber-700 mt-1">
            {awards.length}
          </p>
        </div>
      </div>

      {/* Filters & Export */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base sm:text-lg font-bold text-slate-900">
            {lang === 'vi'
              ? `Danh sách Học sinh Tự đánh giá 24 Năng lực (${filteredLearners.length})`
              : `Personal Self-Assessment Learners (${filteredLearners.length})`}
          </h2>
          <button
            type="button"
            disabled={filteredLearners.length === 0}
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-xl cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{lang === 'vi' ? 'Xuất Excel (CSV)' : 'Export CSV'}</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={lang === 'vi' ? 'Tìm tên, lớp, trường, email...' : 'Search name, class, school...'}
              className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          <select
            value={schoolFilter}
            onChange={(e) => setSchoolFilter(e.target.value)}
            className="px-3 py-2 text-xs sm:text-sm border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">{lang === 'vi' ? 'Tất cả Trường học' : 'All Schools'}</option>
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
            <option value="">{lang === 'vi' ? 'Tất cả Lớp học' : 'All Classes'}</option>
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
        </div>

        {/* Learner Table */}
        {loading ? (
          <div className="py-10 text-center text-sm text-slate-500">
            {lang === 'vi' ? 'Đang tải danh sách học sinh...' : 'Loading learners...'}
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
                ? 'Hãy sao chép link Tự đánh giá ở trên gửi cho các em đăng nhập Google và nhập Tên · Lớp · Trường.'
                : 'Copy the Home Assessment Link above so students can sign in and submit their profile.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600 whitespace-nowrap">
                  <th className="py-3 px-4">{lang === 'vi' ? 'Học sinh' : 'Student'}</th>
                  <th className="py-3 px-3">{lang === 'vi' ? 'Lớp · Trường' : 'Class · School'}</th>
                  <th className="py-3 px-3">{lang === 'vi' ? 'Cấp độ' : 'Level'}</th>
                  <th className="py-3 px-3 text-right">{lang === 'vi' ? '24 Năng lực' : '24 Skills'}</th>
                  <th className="py-3 px-3 text-right">{lang === 'vi' ? 'XP / Chính xác' : 'XP / Acc'}</th>
                  <th className="py-3 px-3 text-center">{lang === 'vi' ? 'Khen thưởng' : 'Awards'}</th>
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

                  return (
                    <tr key={l.uid} className="hover:bg-slate-50/70">
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900">{l.fullName}</span>
                          {l.authType === 'google' && (
                            <span
                              title={l.email || 'Google verified'}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold"
                            >
                              <ShieldCheck className="w-3 h-3" />
                              Google
                            </span>
                          )}
                        </div>
                        {l.email && (
                          <p className="text-[11px] text-slate-500 truncate max-w-[220px]">
                            {l.email}
                          </p>
                        )}
                      </td>
                      <td className="py-3.5 px-3">
                        <p className="font-semibold text-slate-800">{l.className}</p>
                        <p className="text-[11px] text-slate-500 flex items-center gap-1">
                          <School className="w-3 h-3 shrink-0" />
                          <span className="truncate max-w-[180px]">{l.schoolName}</span>
                        </p>
                      </td>
                      <td className="py-3.5 px-3">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${lvlMeta.badgeClass}`}
                        >
                          {lvlMeta.code} · {lang === 'vi' ? `Cấp ${l.currentLevel}` : `Lv.${l.currentLevel}`}
                        </span>
                      </td>
                      <td className="py-3.5 px-3 text-right font-mono-num font-bold text-slate-900">
                        {mastered} / 24
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
                            <span>{lang === 'vi' ? 'Khen thưởng' : 'Reward'}</span>
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

      {/* Recent Awards History */}
      {awards.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Award className="w-4 h-4 text-amber-600" />
            <span>
              {lang === 'vi'
                ? `Lịch sử Khen thưởng đã trao (${awards.length})`
                : `Issued Awards History (${awards.length})`}
            </span>
          </h3>
          <div className="divide-y divide-slate-100">
            {awards.slice(0, 15).map((aw) => (
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
                  <span>{lang === 'vi' ? 'Khen thưởng em này' : 'Reward Student'}</span>
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
                                  ? `${rec.correctCount}/${rec.attempts} đúng`
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
                  {lang === 'vi' ? 'Các phiên luyện gần nhất' : 'Recent Sessions'}
                </h4>
                <div className="space-y-1.5 text-xs">
                  {attempts
                    .filter((a) => a.learnerUid === inspectLearner.uid)
                    .slice(0, 5)
                    .map((att) => (
                      <div
                        key={att.id}
                        className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded-lg"
                      >
                        <span>
                          {att.mode} · {att.correctCount}/{att.totalQuestions} ({att.accuracyPercent}%)
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
                  {lang === 'vi' ? 'Gửi Khen thưởng & Điểm cộng' : 'Send Praise & Bonus XP'}
                </p>
                <h3 className="text-lg font-bold text-slate-900">
                  {rewardTarget.fullName} · {rewardTarget.className}
                </h3>
                <p className="text-xs text-slate-500">{rewardTarget.schoolName}</p>
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
                        ? 'Đang gửi...'
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
    </div>
  );
}
