import { useEffect, useState } from 'react';
import {
  Award,
  Download,
  GraduationCap,
  Lock,
  Medal,
  School,
  ShieldCheck,
  Sparkles,
  Trophy,
} from 'lucide-react';
import { getLevelMeta } from '../shared/assessmentEngine';
import { COMPETENCY_DOMAINS } from '../shared/competencies';
import { CopyDict } from '../shared/i18n';
import { DomainHonorAward } from '../shared/scoring';
import {
  ClassRoom,
  Language,
  LeaderboardEntry,
  Lesson,
  PublicLearnerHonorEntry,
} from '../shared/types';
import { apiRequestJson } from '../utils/apiClient';
import { isLessonAssignedToClass } from '../utils/firestoreHelpers';

interface HonorBoardProps {
  classes: ClassRoom[];
  selectedClassId: string;
  lockedClassId?: string | null;
  initialBoardMode?: 'classroom' | 'self_learners';
  onChangeClass: (classId: string) => void;
  lessons?: Lesson[];
  selectedLessonId?: string;
  onChangeLesson?: (lessonId: string) => void;
  leaderboard: LeaderboardEntry[];
  domainChampions: DomainHonorAward[];
  copy: CopyDict;
  lang: Language;
}

export function HonorBoard({
  classes,
  selectedClassId,
  lockedClassId = null,
  initialBoardMode = 'classroom',
  onChangeClass,
  lessons = [],
  selectedLessonId = '',
  onChangeLesson,
  leaderboard,
  domainChampions,
  copy,
  lang,
}: HonorBoardProps) {
  const [boardMode, setBoardMode] = useState<'classroom' | 'self_learners'>(() =>
    lockedClassId ? 'classroom' : initialBoardMode,
  );
  const [learnerHonor, setLearnerHonor] = useState<PublicLearnerHonorEntry[]>([]);
  const [loadingLearners, setLoadingLearners] = useState(false);

  useEffect(() => {
    if (lockedClassId) {
      setBoardMode('classroom');
    } else {
      setBoardMode(initialBoardMode);
    }
  }, [lockedClassId, initialBoardMode]);

  useEffect(() => {
    if (boardMode !== 'self_learners' || lockedClassId) return;
    let active = true;
    setLoadingLearners(true);
    apiRequestJson<{ entries?: PublicLearnerHonorEntry[] }>('/api/learners/honor', {}, lang)
      .then((res) => {
        if (active && res.ok) {
          setLearnerHonor(res.data.entries ?? []);
        }
      })
      .finally(() => {
        if (active) setLoadingLearners(false);
      });
    return () => {
      active = false;
    };
  }, [boardMode, lockedClassId, lang]);

  const effectiveClassId = lockedClassId || selectedClassId;
  const activeClassObj = classes.find((c) => c.id === effectiveClassId);
  const classLessons = lessons.filter(
    (l) => !effectiveClassId || isLessonAssignedToClass(l, effectiveClassId),
  );

  const handleDownloadJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      ClassID: effectiveClassId,
      LessonID: selectedLessonId || 'ALL',
      rankings: leaderboard.map((row) => ({
        ClassID: row.ClassID,
        GroupID: row.GroupID,
        Score: row.Score,
        Rank: row.Rank,
        SkillLevel: row.SkillLevel,
        AccuracyPercent: row.accuracyPercent,
        AvgTimeSeconds: Number((row.avgElapsedMs / 1000).toFixed(1)),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vinh-danh-${effectiveClassId}${selectedLessonId ? `-${selectedLessonId}` : ''}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const topThree = leaderboard.slice(0, 3);

  if (boardMode === 'self_learners' && !lockedClassId) {
    return (
      <section className="max-w-6xl mx-auto space-y-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-emerald-700">
              {lang === 'vi'
                ? 'Vinh danh Cá nhân · Tự đánh giá 24 Năng lực ở nhà'
                : 'Personal Self-Assessment Honor Board'}
            </p>
            <h1 className="text-2xl font-bold text-slate-900">
              {lang === 'vi'
                ? 'Bảng Vinh Danh Học Sinh Tự Học 24 Năng Lực'
                : 'Top Home Self-Assessment Learners'}
            </h1>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl text-xs sm:text-sm font-semibold">
            <button
              type="button"
              onClick={() => setBoardMode('classroom')}
              className="px-3.5 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              {lang === 'vi' ? 'Vinh danh Lớp học' : 'Class Board'}
            </button>
            <button
              type="button"
              onClick={() => setBoardMode('self_learners')}
              className="px-3.5 py-1.5 rounded-lg bg-white text-emerald-700 shadow-xs cursor-pointer"
            >
              {lang === 'vi' ? 'Vinh danh Tự học ở nhà' : 'Home Self-Study'}
            </button>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          {loadingLearners ? (
            <div className="p-10 text-center text-sm text-slate-500">
              {lang === 'vi' ? 'Đang tải bảng vinh danh tự học...' : 'Loading self-study board...'}
            </div>
          ) : learnerHonor.length === 0 ? (
            <div className="p-10 text-center space-y-2 text-sm text-slate-500">
              <Sparkles className="w-8 h-8 text-emerald-500 mx-auto" />
              <p className="font-semibold text-slate-800">
                {lang === 'vi'
                  ? 'Chưa có học sinh nào hoàn thành tự đánh giá 24 năng lực ở nhà.'
                  : 'No home self-assessment completions recorded yet.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600 whitespace-nowrap">
                    <th className="py-3 px-6">{lang === 'vi' ? 'Hạng' : 'Rank'}</th>
                    <th className="py-3 px-4">{lang === 'vi' ? 'Học sinh' : 'Student'}</th>
                    <th className="py-3 px-4">{lang === 'vi' ? 'Lớp · Trường' : 'Class · School'}</th>
                    <th className="py-3 px-4">{lang === 'vi' ? 'Cấp độ' : 'Level'}</th>
                    <th className="py-3 px-4 text-right">{lang === 'vi' ? '24 Năng lực' : '24 Skills'}</th>
                    <th className="py-3 px-4 text-center">{lang === 'vi' ? 'Khen thưởng GV' : 'Awards'}</th>
                    <th className="py-3 px-6 text-right">XP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {learnerHonor.map((row, idx) => {
                    const lvl = getLevelMeta(row.currentLevel);
                    return (
                      <tr key={row.uid} className="hover:bg-slate-50/70">
                        <td className="py-3.5 px-6 font-mono-num font-bold text-slate-900">
                          #{idx + 1}
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900">{row.fullName}</span>
                            {row.authType === 'google' && (
                              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                            )}
                          </div>
                          {row.latestBadgeTitle && (
                            <p className="text-xs font-semibold text-amber-700 mt-0.5">
                              ★ {row.latestBadgeTitle}
                            </p>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-xs text-slate-700">
                          <p className="font-semibold flex items-center gap-1">
                            <GraduationCap className="w-3.5 h-3.5 text-slate-400" />
                            {row.className}
                          </p>
                          <p className="text-slate-500 flex items-center gap-1 mt-0.5">
                            <School className="w-3.5 h-3.5 text-slate-400" />
                            {row.schoolName}
                          </p>
                        </td>
                        <td className="py-3.5 px-4">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold border ${lvl.badgeClass}`}
                          >
                            {lang === 'vi' ? lvl.nameVi : lvl.nameEn}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono-num font-bold text-slate-900">
                          {row.masteredCount}/24
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200 tabular-nums">
                            <Award className="w-3.5 h-3.5" />
                            {row.awardsCount}
                          </span>
                        </td>
                        <td className="py-3.5 px-6 text-right font-mono-num font-extrabold text-sky-700">
                          {row.totalXp} XP
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="max-w-6xl mx-auto space-y-6">
      {/* Header & Class / Lesson Filter */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-semibold text-sky-700">
            {lang === 'vi'
              ? 'Bước 4 · Tổng hợp điểm & Bảng vinh danh'
              : 'Step 4 · Class Rankings & Skill Honor Board'}
          </p>
          <h1 className="text-2xl font-bold text-slate-900">
            {copy.leaderboardTitle}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {!lockedClassId && (
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl text-xs font-semibold">
              <button
                type="button"
                onClick={() => setBoardMode('classroom')}
                className="px-3 py-1.5 rounded-lg bg-white text-sky-700 shadow-xs cursor-pointer"
              >
                {lang === 'vi' ? 'Lớp học' : 'Class'}
              </button>
              <button
                type="button"
                onClick={() => setBoardMode('self_learners')}
                className="px-3 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                {lang === 'vi' ? 'Tự học ở nhà' : 'Home Study'}
              </button>
            </div>
          )}
          {lockedClassId ? (
            <div className="inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-semibold text-sky-900 bg-sky-50 border border-sky-200 rounded-xl">
              <Lock className="w-3.5 h-3.5 text-sky-700 shrink-0" />
              <span>
                {lang === 'vi'
                  ? `Lớp ${effectiveClassId}${activeClassObj ? ` · ${activeClassObj.name}` : ''} (Nội bộ lớp)`
                  : `Class ${effectiveClassId} (Class-Only Ranking)`}
              </span>
            </div>
          ) : (
            <>
              <label htmlFor="honor-class-filter" className="text-sm font-medium text-slate-600">
                {lang === 'vi' ? 'Lớp:' : 'Class:'}
              </label>
              <select
                id="honor-class-filter"
                value={effectiveClassId}
                onChange={(e) => onChangeClass(e.target.value)}
                className="px-3.5 py-2 text-sm font-semibold border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.name}
                  </option>
                ))}
              </select>
            </>
          )}

          {onChangeLesson && classLessons.length > 0 && (
            <select
              id="honor-lesson-filter"
              aria-label={lang === 'vi' ? 'Lọc theo bài học' : 'Filter by lesson'}
              value={selectedLessonId}
              onChange={(e) => onChangeLesson(e.target.value)}
              className="px-3.5 py-2 text-sm font-medium border border-slate-300 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-sky-500 max-w-[260px]"
            >
              <option value="">
                {lang === 'vi' ? 'Tất cả bài học của lớp' : 'All Class Lessons'}
              </option>
              {classLessons.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={handleDownloadJson}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>{lang === 'vi' ? 'Xuất JSON' : 'Export JSON'}</span>
          </button>
        </div>
      </div>

      {/* Top 3 Podium Cards */}
      {topThree.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {topThree.map((entry) => {
            const domain =
              COMPETENCY_DOMAINS.find((d) => d.id === entry.topDomainId) ??
              COMPETENCY_DOMAINS[0];
            const rankStyles =
              entry.Rank === 1
                ? 'border-amber-300 bg-amber-50/40'
                : entry.Rank === 2
                  ? 'border-slate-300 bg-slate-50/70'
                  : 'border-orange-200 bg-orange-50/30';

            return (
              <div
                key={entry.GroupID}
                className={`bg-white border rounded-2xl p-6 space-y-4 ${rankStyles}`}
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-sm font-bold text-slate-900">
                    {entry.Rank === 1 ? (
                      <Trophy className="w-5 h-5 text-amber-600" />
                    ) : (
                      <Medal className="w-5 h-5 text-slate-500" />
                    )}
                    <span>
                      {lang === 'vi' ? `Hạng #${entry.Rank}` : `Rank #${entry.Rank}`}
                    </span>
                  </span>
                  <span className="font-mono-num text-xl font-extrabold text-sky-700">
                    {entry.Score} {lang === 'vi' ? 'đ' : 'pts'}
                  </span>
                </div>

                <div>
                  <h2 className="text-lg font-bold text-slate-900 truncate">
                    {entry.GroupID}
                  </h2>
                  <p className={`text-sm font-semibold mt-1 ${domain.textClass}`}>
                    {entry.SkillLevel}
                  </p>
                </div>

                <div className="pt-3 border-t border-slate-200/80 flex items-center justify-between text-xs text-slate-600 tabular-nums">
                  <span>
                    {lang === 'vi' ? 'Chính xác' : 'Accuracy'}:{' '}
                    <strong className="text-slate-900">{entry.accuracyPercent}%</strong> (
                    {entry.correctCount}/{entry.totalAnswered})
                  </span>
                  <span>
                    {lang === 'vi' ? 'TB' : 'Avg'}:{' '}
                    <strong className="text-slate-900">
                      {(entry.avgElapsedMs / 1000).toFixed(1)}s
                    </strong>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Full Ranked Table */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900">
            {copy.honorBoardTitle}
          </h2>
          <span className="text-xs text-slate-500 tabular-nums">
            {leaderboard.length}{' '}
            {lang === 'vi' ? 'nhóm tham gia' : 'participating groups'}
          </span>
        </div>

        {leaderboard.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            {lang === 'vi'
              ? `Lớp ${effectiveClassId} chưa có lượt trả lời nào${selectedLessonId ? ' cho bài học này' : ''}. Hãy vào mục Trò chơi để ghi điểm đầu tiên!`
              : `No answers recorded yet for ${effectiveClassId}. Start a quiz to earn points!`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600 whitespace-nowrap">
                  <th className="py-3 px-6">{lang === 'vi' ? 'Hạng' : 'Rank'}</th>
                  <th className="py-3 px-4">{lang === 'vi' ? 'Nhóm / Máy' : 'GroupID'}</th>
                  <th className="py-3 px-4">{lang === 'vi' ? 'Danh hiệu Vinh danh' : 'SkillLevel'}</th>
                  <th className="py-3 px-4 text-right">{lang === 'vi' ? 'Độ chính xác' : 'Accuracy'}</th>
                  <th className="py-3 px-4 text-right">{lang === 'vi' ? 'Tốc độ TB' : 'Avg Speed'}</th>
                  <th className="py-3 px-6 text-right">{lang === 'vi' ? 'Tổng điểm' : 'Score'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {leaderboard.map((row) => {
                  const domain =
                    COMPETENCY_DOMAINS.find((d) => d.id === row.topDomainId) ??
                    COMPETENCY_DOMAINS[0];
                  return (
                    <tr key={row.GroupID} className="hover:bg-slate-50/70">
                      <td className="py-3.5 px-6 font-mono-num font-bold text-slate-900">
                        #{row.Rank}
                      </td>
                      <td className="py-3.5 px-4 font-semibold text-slate-900">
                        {row.GroupID}
                      </td>
                      <td className={`py-3.5 px-4 font-semibold ${domain.textClass}`}>
                        <span className="inline-flex items-center gap-1.5">
                          <ShieldCheck className="w-4 h-4 shrink-0" />
                          <span>{row.SkillLevel}</span>
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right tabular-nums text-slate-700">
                        {row.accuracyPercent}% ({row.correctCount}/{row.totalAnswered})
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono-num text-slate-700">
                        {(row.avgElapsedMs / 1000).toFixed(1)}s
                      </td>
                      <td className="py-3.5 px-6 text-right font-mono-num font-bold text-sky-700">
                        {row.Score}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detailed Skill-Level Domain Champions */}
      {domainChampions.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                {lang === 'vi'
                  ? 'Đề xuất Danh hiệu Vinh danh Theo Từng Nhóm Kỹ Năng'
                  : 'Proposed Skill-Level Honor Titles by Competency Domain'}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {lang === 'vi'
                  ? 'EduBot phân tích điểm chính xác và tốc độ từng miền năng lực để đề xuất danh hiệu cho các nhóm xuất sắc.'
                  : 'EduBot evaluates per-domain accuracy and speed to award specialized digital citizen titles.'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {domainChampions.map((award) => {
              const domain =
                COMPETENCY_DOMAINS.find((d) => d.id === award.domainId) ??
                COMPETENCY_DOMAINS[0];
              return (
                <div
                  key={`${award.domainId}-${award.groupId}`}
                  className="border border-slate-200 rounded-xl p-4 space-y-2 bg-slate-50/40"
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="font-medium truncate">
                      {domain.number}. {award.domainName}
                    </span>
                    <span className="font-mono-num font-bold text-slate-900 shrink-0">
                      {award.domainScore} {lang === 'vi' ? 'đ' : 'pts'}
                    </span>
                  </div>
                  <div className={`flex items-center gap-1.5 text-sm font-bold ${domain.textClass}`}>
                    <Award className="w-4 h-4 shrink-0" />
                    <span>{award.honorTitle}</span>
                  </div>
                  <p className="text-sm font-semibold text-slate-900">
                    {award.groupId}
                  </p>
                  <p className="text-xs text-slate-600 tabular-nums">
                    {award.skillTierLabel} · {award.accuracyPercent}% ·{' '}
                    {(award.avgElapsedMs / 1000).toFixed(1)}s
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
