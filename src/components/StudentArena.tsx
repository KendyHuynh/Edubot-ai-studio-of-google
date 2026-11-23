import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Award,
  BookOpen,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  HelpCircle,
  Search,
  Send,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { getCompetencyById, getDomainByCompetencyId } from '../shared/competencies';
import { CopyDict } from '../shared/i18n';
import {
  calculatePoints,
  formatTrueFalseMultiAnswer,
  getTimingRuleForQuestionType,
} from '../shared/scoring';
import {
  AnswerSubmission,
  Language,
  Lesson,
  OfflineQueueItem,
  PushNotification,
  Question,
  SessionIdentity,
  UiMode,
} from '../shared/types';

export interface GroupLessonProgress {
  answeredQuestionIds: string[];
  correctCount: number;
  totalPoints: number;
}

interface StudentArenaProps {
  session: SessionIdentity | null;
  lessons: Lesson[];
  selectedLessonId: string | null;
  onSelectLesson: (lessonId: string | null) => void;
  groupProgress?: Record<string, GroupLessonProgress>;
  notifications: PushNotification[];
  onGoToIdentity: () => void;
  onGoToHonorBoard: () => void;
  isOfflineEffective: boolean;
  onOnlineSubmission: (submission: AnswerSubmission) => void;
  onQueueOffline: (item: OfflineQueueItem) => void;
  copy: CopyDict;
  lang: Language;
  uiMode: UiMode;
}

interface LocalFeedbackState {
  isOfflineQueued: boolean;
  alreadySubmitted?: boolean;
  isError?: boolean;
  isCorrect?: boolean;
  isPartialCredit?: boolean;
  creditPercent?: number;
  totalPoints?: number;
  speedBonus?: number;
  feedbackText: string;
  explanation?: string;
}

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function StudentArena({
  session,
  lessons,
  selectedLessonId,
  onSelectLesson,
  groupProgress = {},
  notifications,
  onGoToIdentity,
  onGoToHonorBoard,
  isOfflineEffective,
  onOnlineSubmission,
  onQueueOffline,
  copy,
  lang,
  uiMode,
}: StudentArenaProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState('');
  const [tfMultiSelections, setTfMultiSelections] = useState<Array<boolean | null>>([]);
  const [textAnswer, setTextAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [copiedHint, setCopiedHint] = useState(false);
  const [feedback, setFeedback] = useState<LocalFeedbackState | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sessionScore, setSessionScore] = useState(0);
  const startTimeRef = useRef<number>(Date.now());

  const classLessons = session
    ? lessons.filter((l) => l.assignedClassIds.includes(session.classId))
    : [];

  // Strictly restrict activeLesson to lessons assigned to the student's checked-in class
  const activeLesson =
    classLessons.find((l) => l.id === selectedLessonId) ?? null;

  const currentQuestion: Question | null =
    activeLesson && activeLesson.questions[questionIndex]
      ? activeLesson.questions[questionIndex]
      : null;

  useEffect(() => {
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    setSelectedOption('');
    const stmtCount =
      currentQuestion?.type === 'true_false_multi'
        ? currentQuestion.options?.length ?? 0
        : 0;
    setTfMultiSelections(
      stmtCount > 0 ? new Array<boolean | null>(stmtCount).fill(null) : [],
    );
    setTextAnswer('');
    setFeedback(null);
    setCopiedHint(false);
  }, [selectedLessonId, questionIndex, currentQuestion?.id, currentQuestion?.type, currentQuestion?.options?.length]);

  useEffect(() => {
    if (!currentQuestion || feedback) return;
    const interval = window.setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 200);
    return () => window.clearInterval(interval);
  }, [currentQuestion, feedback]);

  if (!session) {
    return (
      <section className="max-w-2xl mx-auto bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-4">
        <HelpCircle className="w-10 h-10 text-sky-600 mx-auto" />
        <h2 className="text-xl font-bold text-slate-900">
          {lang === 'vi'
            ? 'Cần định danh Lớp & Máy tính bảng trước khi chơi'
            : 'Please check in your Class & Tablet first'}
        </h2>
        <p className="text-sm text-slate-600">
          {lang === 'vi'
            ? 'Hệ thống luôn kiểm tra Mã lớp và Số máy (01–10) ở Bước 1 để đảm bảo điểm số không bị lẫn giữa các tiết học.'
            : 'Step 1 verifies your Class Code and Tablet number (01–10) before starting any quiz.'}
        </p>
        <button
          type="button"
          onClick={onGoToIdentity}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 rounded-xl cursor-pointer"
        >
          <span>{lang === 'vi' ? 'Đi tới Bước 1: Vào lớp' : 'Go to Step 1: Check-In'}</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </section>
    );
  }

  // Lesson Mission Picker View
  if (!activeLesson || !currentQuestion) {
    const unreadNotifs = notifications.filter(
      (n) =>
        n.classId === session.classId &&
        classLessons.some((l) => l.id === n.lessonId) &&
        !n.readByGroupIds.includes(session.groupId),
    );

    return (
      <section className="max-w-5xl mx-auto space-y-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-slate-500">
              {session.classId} · {session.groupId}
            </p>
            <h1 className="text-2xl font-bold text-slate-900 mt-1">
              {lang === 'vi'
                ? 'Nhiệm Vụ Công Dân Số Của Lớp'
                : 'Class Digital Citizen Missions'}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onGoToHonorBoard}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl cursor-pointer"
            >
              <Award className="w-4 h-4 text-amber-600" />
              <span>{copy.finishLeaderboardBtn}</span>
            </button>
          </div>
        </div>

        {unreadNotifs.length > 0 && (
          <div className="bg-sky-50 border border-sky-200 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-xs font-bold text-sky-800">
                {copy.newAssignmentBanner}
              </p>
              <p className="text-sm font-semibold text-slate-900">
                {unreadNotifs[0].title}
              </p>
              <p className="text-sm text-slate-600">{unreadNotifs[0].message}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setQuestionIndex(0);
                setSessionScore(0);
                onSelectLesson(unreadNotifs[0].lessonId);
              }}
              className="px-4 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 rounded-xl whitespace-nowrap shrink-0 cursor-pointer"
            >
              {lang === 'vi' ? 'Chơi ngay bài mới' : 'Play New Mission'}
            </button>
          </div>
        )}

        {classLessons.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center space-y-2">
            <BookOpen className="w-8 h-8 text-slate-400 mx-auto" />
            <h2 className="text-base font-semibold text-slate-900">
              {lang === 'vi'
                ? `Lớp ${session.classId} chưa có bài học nào được giao`
                : `No lessons assigned to ${session.classId} yet`}
            </h2>
            <p className="text-sm text-slate-500">
              {lang === 'vi'
                ? 'Giáo viên có thể tải tài liệu bài học hoặc giao bài có sẵn tại mục Giáo viên.'
                : 'Teachers can upload a lesson or assign existing lessons in Teacher Studio.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {classLessons.map((lesson) => {
              const uniqueDomains = Array.from(
                new Set(
                  lesson.questions.map(
                    (q) => getDomainByCompetencyId(q.competencyId).number,
                  ),
                ),
              );
              const prog = groupProgress[lesson.id];
              const answeredSet = new Set(prog?.answeredQuestionIds ?? []);
              const answeredCount = answeredSet.size;
              const totalCount = lesson.questions.length;
              const isCompleted = totalCount > 0 && answeredCount >= totalCount;
              const isInProgress = answeredCount > 0 && answeredCount < totalCount;
              const firstUnansweredIdx = lesson.questions.findIndex(
                (q) => !answeredSet.has(q.id),
              );

              return (
                <article
                  key={lesson.id}
                  className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col justify-between gap-5"
                >
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-semibold text-sky-700 shrink-0">
                          {totalCount} {lang === 'vi' ? 'câu hỏi' : 'questions'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">
                          {lang === 'vi' ? 'Nhóm năng lực' : 'Domains'}{' '}
                          {uniqueDomains.join(', ')}
                        </span>
                      </div>
                      {isCompleted ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 font-semibold tabular-nums">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>
                            {lang === 'vi'
                              ? `Đã hoàn thành ${answeredCount}/${totalCount} · ${prog?.totalPoints ?? 0}đ`
                              : `Done ${answeredCount}/${totalCount} · ${prog?.totalPoints ?? 0} pts`}
                          </span>
                        </span>
                      ) : isInProgress ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-50 border border-sky-200 text-sky-800 font-semibold tabular-nums">
                          <span>
                            {lang === 'vi'
                              ? `Đang làm ${answeredCount}/${totalCount} · ${prog?.totalPoints ?? 0}đ`
                              : `In progress ${answeredCount}/${totalCount}`}
                          </span>
                        </span>
                      ) : null}
                    </div>
                    <h2 className="text-lg font-bold text-slate-900 text-balance">
                      {lesson.title}
                    </h2>
                    <p className="text-sm text-slate-600 leading-relaxed">
                      {lesson.summary}
                    </p>
                  </div>

                  <div className="pt-4 border-t border-slate-100 flex items-center justify-between gap-4">
                    <span className="text-xs text-slate-500 truncate">
                      {lesson.topic}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setQuestionIndex(
                          isInProgress && firstUnansweredIdx >= 0
                            ? firstUnansweredIdx
                            : 0,
                        );
                        setSessionScore(prog?.totalPoints ?? 0);
                        onSelectLesson(lesson.id);
                      }}
                      className={`inline-flex items-center gap-2 px-5 font-semibold rounded-xl whitespace-nowrap shrink-0 cursor-pointer ${
                        isCompleted
                          ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                          : 'bg-sky-600 hover:bg-sky-700 text-white'
                      } ${uiMode === 'kid' ? 'py-3 text-base' : 'py-2 text-sm'}`}
                    >
                      <span>
                        {isCompleted
                          ? lang === 'vi'
                            ? 'Xem lại (Đã khóa điểm)'
                            : 'Review (Locked)'
                          : isInProgress
                            ? lang === 'vi'
                              ? `Tiếp tục câu ${firstUnansweredIdx + 1}`
                              : `Resume Q${firstUnansweredIdx + 1}`
                            : lang === 'vi'
                              ? 'Bắt đầu chơi'
                              : 'Start Quiz'}
                      </span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  // Active Question Play Stage (Step 3)
  const totalQ = activeLesson.questions.length;
  const comp = getCompetencyById(currentQuestion.competencyId);
  const domain = getDomainByCompetencyId(currentQuestion.competencyId);
  const tfStatements =
    currentQuestion.type === 'true_false_multi' ? currentQuestion.options ?? [] : [];
  const allTfMultiSelected =
    tfStatements.length > 0 &&
    tfMultiSelections.length === tfStatements.length &&
    tfMultiSelections.every((v) => v !== null);
  const answerValue =
    currentQuestion.type === 'multiple_choice' || currentQuestion.type === 'true_false'
      ? selectedOption
      : currentQuestion.type === 'true_false_multi'
        ? allTfMultiSelected
          ? formatTrueFalseMultiAnswer(tfMultiSelections)
          : ''
        : textAnswer;
  const isLastQuestion = questionIndex >= totalQ - 1;

  const handleCopyKeyword = async () => {
    try {
      await navigator.clipboard.writeText(currentQuestion.aiSearchKeywordHint);
      setCopiedHint(true);
      window.setTimeout(() => setCopiedHint(false), 2000);
    } catch {
      setCopiedHint(true);
    }
  };

  const handleSubmitAnswer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!answerValue.trim() || submitting || feedback) return;

    const finalElapsed = Math.max(500, Date.now() - startTimeRef.current);
    setSubmitting(true);

    if (isOfflineEffective) {
      const queueItem: OfflineQueueItem = {
        localId: `off-${Date.now()}`,
        classId: session.classId,
        groupId: session.groupId,
        tabletNumber: session.tabletNumber,
        groupName: session.groupName,
        lessonId: activeLesson.id,
        lessonTitle: activeLesson.title,
        questionId: currentQuestion.id,
        competencyId: currentQuestion.competencyId,
        competencyIds: currentQuestion.competencyIds ?? [currentQuestion.competencyId],
        userAnswer: answerValue.trim(),
        elapsedMs: finalElapsed,
        submittedAt: new Date().toISOString(),
      };
      onQueueOffline(queueItem);
      setFeedback({
        isOfflineQueued: true,
        feedbackText:
          lang === 'vi'
            ? `Đã lưu tạm đáp án của nhóm ${session.groupName} (${(finalElapsed / 1000).toFixed(1)}s). Khi mạng ổn định hệ thống sẽ tự động chấm và đồng bộ lên bảng xếp hạng!`
            : `Saved ${session.groupName}'s answer offline (${(finalElapsed / 1000).toFixed(1)}s). It will auto-sync once connected!`,
      });
      setSubmitting(false);
      return;
    }

    try {
      const { apiRequestJson } = await import('../utils/apiClient');
      const res = await apiRequestJson<{
        submission?: AnswerSubmission;
        alreadySubmitted?: boolean;
        error?: string;
      }>(
        '/api/quiz/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            classId: session.classId,
            tabletNumber: session.tabletNumber,
            groupName: session.groupName,
            lessonId: activeLesson.id,
            questionId: currentQuestion.id,
            userAnswer: answerValue.trim(),
            elapsedMs: finalElapsed,
            lang,
          }),
        },
        lang,
      );

      if (res.status === 403) {
        setFeedback({
          isOfflineQueued: false,
          isError: true,
          isCorrect: false,
          totalPoints: 0,
          feedbackText:
            res.data?.error ||
            (lang === 'vi'
              ? 'Bài tập này thuộc lớp học khác, không được giao cho lớp của em.'
              : 'This lesson belongs to another class.'),
        });
        return;
      }

      if (!res.ok || !res.data?.submission) {
        throw new Error('Network error');
      }

      const submission = res.data.submission;
      const alreadySubmitted = Boolean(res.data.alreadySubmitted);
      const isPartialCredit =
        submission.isCorrect &&
        submission.basePoints > 0 &&
        submission.basePoints < 100;
      onOnlineSubmission(submission);
      if (!alreadySubmitted) {
        setSessionScore((prev) => prev + submission.totalPoints);
      }
      setFeedback({
        isOfflineQueued: false,
        alreadySubmitted,
        isCorrect: submission.isCorrect,
        isPartialCredit,
        creditPercent: isPartialCredit ? submission.basePoints : 100,
        totalPoints: submission.totalPoints,
        speedBonus: submission.speedBonus,
        feedbackText: submission.feedbackText,
        explanation: submission.explanation,
      });
    } catch {
      // Automatic fallback to offline queue if request drops mid-flight!
      const queueItem: OfflineQueueItem = {
        localId: `off-${Date.now()}`,
        classId: session.classId,
        groupId: session.groupId,
        tabletNumber: session.tabletNumber,
        groupName: session.groupName,
        lessonId: activeLesson.id,
        lessonTitle: activeLesson.title,
        questionId: currentQuestion.id,
        competencyId: currentQuestion.competencyId,
        competencyIds: currentQuestion.competencyIds ?? [currentQuestion.competencyId],
        userAnswer: answerValue.trim(),
        elapsedMs: finalElapsed,
        submittedAt: new Date().toISOString(),
      };
      onQueueOffline(queueItem);
      setFeedback({
        isOfflineQueued: true,
        feedbackText:
          lang === 'vi'
            ? 'Mạng vừa bị gián đoạn — Đáp án đã được lưu an toàn ngoại tuyến để đồng bộ sau!'
            : 'Connection dropped — Answer safely stored offline for auto-sync!',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => {
    if (isLastQuestion) {
      onSelectLesson(null);
      onGoToHonorBoard();
    } else {
      setQuestionIndex((i) => i + 1);
    }
  };

  return (
    <section className="max-w-4xl mx-auto space-y-5">
      {/* Top Progress & Session Strip */}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm text-slate-600">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectLesson(null)}
              className="font-semibold text-sky-700 hover:underline cursor-pointer"
            >
              {lang === 'vi' ? '← Đổi bài học' : '← All Lessons'}
            </button>
            <span aria-hidden="true">·</span>
            <span className="font-medium text-slate-900 truncate max-w-xs sm:max-w-md">
              {activeLesson.title}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 tabular-nums">
            <span className="inline-flex items-center gap-1.5 font-mono-num font-semibold text-slate-900">
              <Clock className="w-4 h-4 text-sky-600" />
              <span>{(elapsedMs / 1000).toFixed(1)}s</span>
            </span>
            {!feedback && (() => {
              const rule = getTimingRuleForQuestionType(currentQuestion.type);
              const live = calculatePoints(true, elapsedMs, currentQuestion.type);
              const elapsedSec = elapsedMs / 1000;
              if (elapsedSec <= rule.graceSec) {
                return (
                  <span className="text-xs font-semibold text-emerald-700">
                    {lang === 'vi'
                      ? `≤${rule.graceSec}s · Thưởng tối đa +50đ`
                      : `≤${rule.graceSec}s · Max +50 speed bonus`}
                  </span>
                );
              }
              if (live.speedBonus > 0) {
                return (
                  <span className="text-xs font-semibold text-sky-700">
                    {lang === 'vi'
                      ? `Thưởng tốc độ: +${live.speedBonus}đ (tới ${rule.bonusEndSec}s)`
                      : `Speed bonus: +${live.speedBonus} (up to ${rule.bonusEndSec}s)`}
                  </span>
                );
              }
              return (
                <span className="text-xs font-medium text-slate-500">
                  {lang === 'vi'
                    ? 'Đúng vẫn trọn +100đ'
                    : 'Correct still earns +100 pts'}
                </span>
              );
            })()}
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-sky-700">
              {lang === 'vi' ? `Điểm lượt này: ${sessionScore}` : `Score: ${sessionScore}`}
            </span>
          </div>
        </div>

        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-sky-600 transition-transform duration-200"
            style={{
              width: `${Math.round(((questionIndex + 1) / totalQ) * 100)}%`,
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-800 tabular-nums">
              {lang === 'vi'
                ? `Câu ${questionIndex + 1} / ${totalQ}`
                : `Question ${questionIndex + 1} / ${totalQ}`}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-sky-700">
              {currentQuestion.type === 'multiple_choice'
                ? lang === 'vi'
                  ? 'Trắc nghiệm'
                  : 'Multiple Choice'
                : currentQuestion.type === 'true_false'
                  ? lang === 'vi'
                    ? 'Đánh giá Đúng / Sai'
                    : 'True / False'
                  : currentQuestion.type === 'true_false_multi'
                    ? lang === 'vi'
                      ? `Đánh giá Đúng / Sai nâng cao (${tfStatements.length} nhận định)`
                      : `Advanced True / False (${tfStatements.length} statements)`
                    : currentQuestion.type === 'fill_blank'
                      ? lang === 'vi'
                        ? 'Điền khuyết'
                        : 'Fill Blank'
                      : lang === 'vi'
                        ? 'Trả lời ngắn'
                        : 'Short Answer'}
            </span>
          </div>
          <span className={`font-semibold ${domain.textClass}`}>
            {(() => {
              const ids =
                currentQuestion.competencyIds && currentQuestion.competencyIds.length > 0
                  ? currentQuestion.competencyIds
                  : [currentQuestion.competencyId];
              const names = ids
                .map((id) => {
                  const c = getCompetencyById(id);
                  return `${c.id} (${lang === 'vi' ? c.nameVi : c.nameEn})`;
                })
                .join(' · ');
              return lang === 'vi'
                ? `Năng lực: ${names}`
                : `Competencies: ${names}`;
            })()}
          </span>
        </div>
      </div>

      {/* Main Question Stage */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
        <h2
          className={`font-bold text-slate-900 leading-snug text-balance ${
            uiMode === 'kid' ? 'text-xl sm:text-2xl' : 'text-lg sm:text-xl'
          }`}
        >
          {currentQuestion.questionText}
        </h2>

        {/* AI Search Keyword Hint Card (Core EduBot Feature) */}
        <div className="bg-sky-50/70 border border-sky-200 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-bold text-sky-800">
              <Search className="w-4 h-4" />
              <span>{copy.aiHintTitle}</span>
            </div>
            <p className="text-sm font-semibold text-slate-900">
              “{currentQuestion.aiSearchKeywordHint}”
            </p>
            <p className="text-xs text-slate-600">{copy.aiHintHelp}</p>
          </div>
          <button
            type="button"
            onClick={handleCopyKeyword}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-sky-800 bg-white border border-sky-300 hover:bg-sky-50 rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedHint ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span>{copy.copiedLabel}</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>{copy.copyKeywordBtn}</span>
              </>
            )}
          </button>
        </div>

        {/* Answer Input Form */}
        <form onSubmit={handleSubmitAnswer} className="space-y-5">
          {currentQuestion.type === 'multiple_choice' && currentQuestion.options ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {currentQuestion.options.map((opt, idx) => {
                const chosen = selectedOption === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    disabled={Boolean(feedback)}
                    onClick={() => setSelectedOption(opt)}
                    className={`text-left rounded-xl border transition-colors flex items-start gap-3 cursor-pointer disabled:cursor-default ${
                      uiMode === 'kid' ? 'p-4 min-h-[60px]' : 'p-3.5 min-h-[52px]'
                    } ${
                      chosen
                        ? 'bg-sky-600 border-sky-600 text-white'
                        : 'bg-white border-slate-200 hover:border-sky-400 text-slate-800'
                    }`}
                  >
                    <span
                      className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                        chosen
                          ? 'bg-white/20 text-white'
                          : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {OPTION_LABELS[idx] ?? idx + 1}
                    </span>
                    <span
                      className={`font-medium leading-snug ${
                        uiMode === 'kid' ? 'text-base' : 'text-sm'
                      }`}
                    >
                      {opt}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : currentQuestion.type === 'true_false' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                {
                  val: 'Đúng',
                  labelVi: 'ĐÚNG · Chính xác',
                  labelEn: 'TRUE · Accurate',
                  isTrue: true,
                },
                {
                  val: 'Sai',
                  labelVi: 'SAI · Không chính xác',
                  labelEn: 'FALSE · Inaccurate',
                  isTrue: false,
                },
              ].map((btn) => {
                const chosen = selectedOption === btn.val;
                return (
                  <button
                    key={btn.val}
                    type="button"
                    disabled={Boolean(feedback)}
                    onClick={() => setSelectedOption(btn.val)}
                    className={`rounded-xl border-2 font-bold flex items-center justify-center gap-2.5 transition-colors cursor-pointer disabled:cursor-default ${
                      uiMode === 'kid' ? 'p-5 text-base min-h-[68px]' : 'p-4 text-sm min-h-[56px]'
                    } ${
                      chosen
                        ? btn.isTrue
                          ? 'bg-emerald-600 border-emerald-600 text-white'
                          : 'bg-rose-600 border-rose-600 text-white'
                        : btn.isTrue
                          ? 'bg-white border-slate-200 hover:border-emerald-400 hover:bg-emerald-50/50 text-slate-800'
                          : 'bg-white border-slate-200 hover:border-rose-400 hover:bg-rose-50/50 text-slate-800'
                    }`}
                  >
                    {btn.isTrue ? (
                      <CheckCircle2 className="w-5 h-5 shrink-0" />
                    ) : (
                      <XCircle className="w-5 h-5 shrink-0" />
                    )}
                    <span>{lang === 'vi' ? btn.labelVi : btn.labelEn}</span>
                  </button>
                );
              })}
            </div>
          ) : currentQuestion.type === 'true_false_multi' && tfStatements.length > 0 ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                <span className="font-semibold text-slate-800">
                  {lang === 'vi'
                    ? 'Chọn ĐÚNG hoặc SAI cho từng nhận định dưới đây (chấm điểm theo số ý đúng):'
                    : 'Evaluate each statement as TRUE or FALSE (proportional partial credit):'}
                </span>
                <span className="font-mono-num font-bold text-sky-700">
                  {lang === 'vi'
                    ? `Đã đánh giá ${tfMultiSelections.filter((v) => v !== null).length}/${tfStatements.length} ý`
                    : `Rated ${tfMultiSelections.filter((v) => v !== null).length}/${tfStatements.length}`}
                </span>
              </div>

              <div className="space-y-2.5">
                {tfStatements.map((stmt, idx) => {
                  const chosenVal = tfMultiSelections[idx] ?? null;
                  const letter = String.fromCharCode(97 + idx);
                  return (
                    <div
                      key={`${currentQuestion.id}-stmt-${idx}`}
                      className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-start gap-2.5 min-w-0">
                        <span className="w-6 h-6 rounded-md bg-sky-100 text-sky-800 font-bold text-xs flex items-center justify-center shrink-0 mt-0.5 uppercase">
                          {letter}
                        </span>
                        <p
                          className={`text-slate-900 font-medium leading-relaxed ${
                            uiMode === 'kid' ? 'text-base' : 'text-sm'
                          }`}
                        >
                          {stmt}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                        <button
                          type="button"
                          disabled={Boolean(feedback)}
                          aria-label={`${letter.toUpperCase()} - ${lang === 'vi' ? 'Đúng' : 'True'}`}
                          onClick={() =>
                            setTfMultiSelections((prev) => {
                              const next =
                                prev.length === tfStatements.length
                                  ? [...prev]
                                  : new Array<boolean | null>(tfStatements.length).fill(null);
                              next[idx] = true;
                              return next;
                            })
                          }
                          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border-2 text-xs sm:text-sm font-bold transition-colors cursor-pointer disabled:cursor-default ${
                            chosenVal === true
                              ? 'bg-emerald-600 border-emerald-600 text-white'
                              : 'bg-white border-slate-200 hover:border-emerald-400 text-slate-700'
                          }`}
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          <span>{lang === 'vi' ? 'Đúng' : 'True'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(feedback)}
                          aria-label={`${letter.toUpperCase()} - ${lang === 'vi' ? 'Sai' : 'False'}`}
                          onClick={() =>
                            setTfMultiSelections((prev) => {
                              const next =
                                prev.length === tfStatements.length
                                  ? [...prev]
                                  : new Array<boolean | null>(tfStatements.length).fill(null);
                              next[idx] = false;
                              return next;
                            })
                          }
                          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border-2 text-xs sm:text-sm font-bold transition-colors cursor-pointer disabled:cursor-default ${
                            chosenVal === false
                              ? 'bg-rose-600 border-rose-600 text-white'
                              : 'bg-white border-slate-200 hover:border-rose-400 text-slate-700'
                          }`}
                        >
                          <XCircle className="w-4 h-4" />
                          <span>{lang === 'vi' ? 'Sai' : 'False'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <label
                htmlFor="open-answer-input"
                className="block text-sm font-semibold text-slate-700"
              >
                {currentQuestion.type === 'fill_blank'
                  ? lang === 'vi'
                    ? 'Nhập từ còn thiếu vào chỗ trống:'
                    : 'Type the missing word:'
                  : lang === 'vi'
                    ? 'Nhập câu trả lời của nhóm sau khi tra cứu AI:'
                    : 'Type your team’s answer after researching:'}
              </label>
              <textarea
                id="open-answer-input"
                rows={currentQuestion.type === 'short_answer' ? 3 : 2}
                disabled={Boolean(feedback)}
                value={textAnswer}
                onChange={(e) => setTextAnswer(e.target.value)}
                placeholder={
                  lang === 'vi'
                    ? 'Gõ câu trả lời của nhóm tại đây...'
                    : 'Enter your answer here...'
                }
                className="w-full px-4 py-3 text-base border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:bg-slate-50"
              />
            </div>
          )}

          {!feedback && (
            <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
              <button
                type="button"
                onClick={onGoToHonorBoard}
                className="text-sm font-medium text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                {copy.finishLeaderboardBtn}
              </button>

              <button
                type="submit"
                disabled={!answerValue.trim() || submitting}
                className={`inline-flex items-center gap-2 px-6 font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-40 rounded-xl transition-colors cursor-pointer ${
                  uiMode === 'kid' ? 'py-3.5 text-base' : 'py-2.5 text-sm'
                }`}
              >
                <Send className="w-4 h-4" />
                <span>
                  {submitting
                    ? lang === 'vi'
                      ? 'Đang chấm điểm...'
                      : 'Grading...'
                    : copy.submitAnswerBtn}
                </span>
              </button>
            </div>
          )}
        </form>

        {/* Feedback Banner after Submitting */}
        {feedback && (
          <div
            role="status"
            className={`rounded-xl border p-5 space-y-3 ${
              feedback.isOfflineQueued || feedback.alreadySubmitted
                ? 'bg-amber-50 border-amber-200'
                : feedback.isPartialCredit
                  ? 'bg-sky-50 border-sky-200'
                  : feedback.isCorrect
                    ? 'bg-emerald-50 border-emerald-200'
                    : 'bg-rose-50 border-rose-200'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-bold text-base">
                {feedback.isOfflineQueued ? (
                  <>
                    <WifiOff className="w-5 h-5 text-amber-700" />
                    <span className="text-amber-900">
                      {lang === 'vi'
                        ? 'Đã lưu ngoại tuyến (Chờ đồng bộ)'
                        : 'Saved Offline (Pending Sync)'}
                    </span>
                  </>
                ) : feedback.alreadySubmitted ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-amber-700" />
                    <span className="text-amber-900">
                      {lang === 'vi'
                        ? 'Câu này đã được ghi điểm ở lần nộp đầu tiên'
                        : 'First Official Attempt Already Locked'}
                    </span>
                  </>
                ) : feedback.isPartialCredit ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-sky-700" />
                    <span className="text-sky-900">
                      {lang === 'vi'
                        ? `Gần đúng — Điểm khuyến khích (${feedback.creditPercent ?? 75}%)!`
                        : `Close Match — Partial Credit (${feedback.creditPercent ?? 75}%)!`}
                    </span>
                  </>
                ) : feedback.isCorrect ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-emerald-700" />
                    <span className="text-emerald-900">
                      {lang === 'vi' ? 'Chính xác!' : 'Correct!'}
                    </span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-5 h-5 text-rose-700" />
                    <span className="text-rose-900">
                      {lang === 'vi' ? 'Chưa chính xác' : 'Not quite right'}
                    </span>
                  </>
                )}
              </div>

              {!feedback.isOfflineQueued && !feedback.isError && (
                <span className="font-mono-num text-sm font-bold text-slate-900">
                  {feedback.alreadySubmitted
                    ? lang === 'vi'
                      ? `Giữ nguyên: ${feedback.totalPoints ?? 0} điểm`
                      : `Kept: ${feedback.totalPoints ?? 0} pts`
                    : `+${feedback.totalPoints ?? 0} ${lang === 'vi' ? 'điểm' : 'pts'}${
                        (feedback.speedBonus ?? 0) > 0
                          ? ` (+${feedback.speedBonus} ${lang === 'vi' ? 'tốc độ' : 'speed'})`
                          : ''
                      }`}
                </span>
              )}
            </div>

            <p className="text-sm font-medium text-slate-800 leading-relaxed">
              {feedback.feedbackText}
            </p>

            {feedback.explanation && (
              <p className="text-xs sm:text-sm text-slate-700 pt-2 border-t border-black/10 leading-relaxed">
                <strong className="font-semibold">
                  {lang === 'vi' ? 'Giải thích Công dân số: ' : 'Digital Citizen Note: '}
                </strong>
                {feedback.explanation}
              </p>
            )}

            <div className="pt-2 flex flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                onClick={handleNext}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-xl cursor-pointer"
              >
                <span>
                  {isLastQuestion ? copy.finishLeaderboardBtn : copy.nextQuestionBtn}
                </span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
