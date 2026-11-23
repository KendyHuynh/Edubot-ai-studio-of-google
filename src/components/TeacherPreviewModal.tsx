import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  FlaskConical,
  RotateCcw,
  Send,
  X,
  XCircle,
} from 'lucide-react';
import { getCompetencyById, getDomainByCompetencyId } from '../shared/competencies';
import {
  AnswerMatchTier,
  calculatePoints,
  evaluateAnswerMatch,
  formatTrueFalseMultiAnswer,
  getTimingRuleForQuestionType,
  parseTrueFalseMultiAnswer,
} from '../shared/scoring';
import { Language, Lesson, Question } from '../shared/types';

interface TeacherPreviewModalProps {
  lesson: Lesson;
  lang: Language;
  onClose: () => void;
}

interface SandboxResult {
  questionId: string;
  userAnswer: string;
  isCorrect: boolean;
  matchTier: AnswerMatchTier;
  creditFactor: number;
  similarity: number;
  totalPoints: number;
  speedBonus: number;
  elapsedMs: number;
}

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * Isolated Teacher Test / Sandbox Modal.
 * Runs 100% locally in memory using the exact same grading engine (isAnswerMatch + calculatePoints)
 * without touching student sessions, submissions, class leaderboards, or Firestore.
 */
export function TeacherPreviewModal({
  lesson,
  lang,
  onClose,
}: TeacherPreviewModalProps) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState('');
  const [tfMultiSelections, setTfMultiSelections] = useState<Array<boolean | null>>([]);
  const [textAnswer, setTextAnswer] = useState('');
  const [showKey, setShowKey] = useState(true);
  const [results, setResults] = useState<Record<string, SandboxResult>>({});
  const [finished, setFinished] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startTimeRef = useRef<number>(Date.now());

  const totalQ = lesson.questions.length;
  const currentQuestion: Question | null = lesson.questions[questionIndex] ?? null;
  const currentResult = currentQuestion ? results[currentQuestion.id] ?? null : null;

  useEffect(() => {
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    const stmtCount =
      currentQuestion?.type === 'true_false_multi'
        ? currentQuestion.options?.length ?? 0
        : 0;
    if (currentQuestion && results[currentQuestion.id]) {
      const prev = results[currentQuestion.id];
      if (currentQuestion.type === 'multiple_choice' || currentQuestion.type === 'true_false') {
        setSelectedOption(prev.userAnswer);
        setTfMultiSelections([]);
        setTextAnswer('');
      } else if (currentQuestion.type === 'true_false_multi') {
        setTfMultiSelections(parseTrueFalseMultiAnswer(prev.userAnswer, stmtCount));
        setSelectedOption('');
        setTextAnswer('');
      } else {
        setTextAnswer(prev.userAnswer);
        setSelectedOption('');
        setTfMultiSelections([]);
      }
    } else {
      setSelectedOption('');
      setTfMultiSelections(
        stmtCount > 0 ? new Array<boolean | null>(stmtCount).fill(null) : [],
      );
      setTextAnswer('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionIndex, lesson.id]);

  useEffect(() => {
    if (!currentQuestion || currentResult || finished) return;
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 200);
    return () => window.clearInterval(timer);
  }, [currentQuestion, currentResult, finished]);

  const tfStatements =
    currentQuestion?.type === 'true_false_multi' ? currentQuestion.options ?? [] : [];
  const allTfMultiSelected =
    tfStatements.length > 0 &&
    tfMultiSelections.length === tfStatements.length &&
    tfMultiSelections.every((v) => v !== null);

  const answerValue =
    currentQuestion?.type === 'multiple_choice' || currentQuestion?.type === 'true_false'
      ? selectedOption
      : currentQuestion?.type === 'true_false_multi'
        ? allTfMultiSelected
          ? formatTrueFalseMultiAnswer(tfMultiSelections)
          : ''
        : textAnswer;

  const handleCheckAnswer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentQuestion || !answerValue.trim()) return;
    const finalElapsed = Math.max(500, Date.now() - startTimeRef.current);
    const evaluation = evaluateAnswerMatch(
      answerValue.trim(),
      currentQuestion.correctAnswer ?? '',
      currentQuestion.type,
      currentQuestion.options,
    );
    const breakdown = calculatePoints(
      evaluation.isCorrect,
      finalElapsed,
      currentQuestion.type,
      evaluation.creditFactor,
    );
    setResults((prev) => ({
      ...prev,
      [currentQuestion.id]: {
        questionId: currentQuestion.id,
        userAnswer: answerValue.trim(),
        isCorrect: evaluation.isCorrect,
        matchTier: evaluation.matchTier,
        creditFactor: evaluation.creditFactor,
        similarity: evaluation.similarity,
        totalPoints: breakdown.totalPoints,
        speedBonus: breakdown.speedBonus,
        elapsedMs: finalElapsed,
      },
    }));
  };

  const handleRetryCurrent = () => {
    if (!currentQuestion) return;
    setResults((prev) => {
      const next = { ...prev };
      delete next[currentQuestion.id];
      return next;
    });
    setSelectedOption('');
    setTfMultiSelections(
      currentQuestion.type === 'true_false_multi'
        ? new Array<boolean | null>(currentQuestion.options?.length ?? 0).fill(null)
        : [],
    );
    setTextAnswer('');
    startTimeRef.current = Date.now();
    setElapsedMs(0);
  };

  const handleRestartAll = () => {
    setResults({});
    setQuestionIndex(0);
    setFinished(false);
    setSelectedOption('');
    const firstQ = lesson.questions[0];
    setTfMultiSelections(
      firstQ?.type === 'true_false_multi'
        ? new Array<boolean | null>(firstQ.options?.length ?? 0).fill(null)
        : [],
    );
    setTextAnswer('');
    startTimeRef.current = Date.now();
    setElapsedMs(0);
  };

  const resultList = Object.values(results);
  const totalScore = resultList.reduce((acc, r) => acc + r.totalPoints, 0);
  const correctCount = resultList.filter((r) => r.isCorrect).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={lang === 'vi' ? 'Chạy thử đề Giáo viên' : 'Teacher Sandbox Preview'}
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 overflow-y-auto"
    >
      <div className="w-full max-w-4xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden my-auto">
        {/* Sandbox Banner */}
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <FlaskConical className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-amber-950">
                {lang === 'vi'
                  ? 'Chế độ Chạy thử đề (Giáo viên) — Tách biệt hoàn toàn với học sinh'
                  : 'Teacher Sandbox Preview — Isolated from Student Scores'}
              </p>
              <p className="text-xs text-amber-800 mt-0.5">
                {lang === 'vi'
                  ? 'Mọi câu trả lời ở đây chỉ chấm thử trên trình duyệt, KHÔNG lưu vào lớp học, KHÔNG tính vào bảng xếp hạng và KHÔNG làm thay đổi máy học sinh.'
                  : 'Answers here are graded locally in memory only — NEVER saved to classes, leaderboards, or Firestore.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowKey((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-900 bg-white border border-amber-300 hover:bg-amber-100 rounded-lg cursor-pointer"
            >
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span>
                {showKey
                  ? lang === 'vi'
                    ? 'Ẩn đáp án chuẩn'
                    : 'Hide Key'
                  : lang === 'vi'
                    ? 'Hiện đáp án chuẩn'
                    : 'Show Key'}
              </span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={lang === 'vi' ? 'Đóng cửa sổ chạy thử' : 'Close sandbox'}
              className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-amber-100 rounded-lg cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Lesson Header & Quick Question Navigator */}
        <div className="px-6 py-4 border-b border-slate-100 space-y-3 bg-slate-50/60">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-900">
                {lesson.title}
              </h2>
              <p className="text-xs text-slate-500">
                {lang === 'vi'
                  ? `Đang thử: ${resultList.length}/${totalQ} câu · Đúng ${correctCount} · Tổng điểm thử: ${totalScore}đ`
                  : `Tested: ${resultList.length}/${totalQ} · Correct: ${correctCount} · Sandbox score: ${totalScore} pts`}
              </p>
            </div>
            <button
              type="button"
              onClick={handleRestartAll}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{lang === 'vi' ? 'Thử lại từ đầu' : 'Reset Sandbox'}</span>
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {lesson.questions.map((q, idx) => {
              const res = results[q.id];
              const isCurrent = !finished && idx === questionIndex;
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => {
                    setFinished(false);
                    setQuestionIndex(idx);
                  }}
                  className={`px-2.5 py-1 text-xs font-mono-num font-semibold rounded-lg border cursor-pointer transition-colors ${
                    isCurrent
                      ? 'bg-sky-600 border-sky-600 text-white'
                      : res
                        ? res.isCorrect
                          ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                          : 'bg-rose-50 border-rose-300 text-rose-800'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="p-6 max-h-[70vh] overflow-y-auto">
          {finished || !currentQuestion ? (
            <div className="space-y-5 text-center py-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto" />
              <div className="space-y-1">
                <h3 className="text-xl font-bold text-slate-900">
                  {lang === 'vi'
                    ? 'Hoàn tất chạy thử bộ đề!'
                    : 'Sandbox Test Complete!'}
                </h3>
                <p className="text-sm text-slate-600">
                  {lang === 'vi'
                    ? `Kết quả thử nghiệm: Đúng ${correctCount}/${totalQ} câu · ${totalScore} điểm (không ghi vào lớp học).`
                    : `Sandbox result: ${correctCount}/${totalQ} correct · ${totalScore} pts (not saved to classes).`}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleRestartAll}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-sky-700 bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-xl cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>{lang === 'vi' ? 'Chạy thử lại' : 'Run Again'}</span>
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-xl cursor-pointer"
                >
                  <span>{lang === 'vi' ? 'Quay lại Cổng Giáo viên' : 'Back to Teacher Studio'}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Question Meta */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-slate-900">
                    {lang === 'vi'
                      ? `Câu ${questionIndex + 1} / ${totalQ}`
                      : `Question ${questionIndex + 1} / ${totalQ}`}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="uppercase font-semibold text-sky-700">
                    {currentQuestion.type === 'multiple_choice'
                      ? lang === 'vi'
                        ? 'Trắc nghiệm'
                        : 'Multiple Choice'
                      : currentQuestion.type === 'true_false'
                        ? lang === 'vi'
                          ? 'Đúng / Sai'
                          : 'True / False'
                        : currentQuestion.type === 'true_false_multi'
                          ? lang === 'vi'
                            ? 'Đánh giá Đúng / Sai nâng cao'
                            : 'Advanced True / False'
                          : currentQuestion.type === 'fill_blank'
                            ? lang === 'vi'
                              ? 'Điền khuyết'
                              : 'Fill Blank'
                            : lang === 'vi'
                              ? 'Trả lời ngắn'
                              : 'Short Answer'}
                  </span>
                  <span aria-hidden="true">·</span>
                  {(() => {
                    const comp = getCompetencyById(currentQuestion.competencyId);
                    const dom = getDomainByCompetencyId(currentQuestion.competencyId);
                    return (
                      <span className={`font-semibold ${dom.textClass}`}>
                        {comp.id} ({lang === 'vi' ? comp.nameVi : comp.nameEn})
                      </span>
                    );
                  })()}
                </div>

                <div className="flex items-center gap-2 font-mono-num text-slate-700">
                  <Clock className="w-3.5 h-3.5 text-sky-600" />
                  <span>
                    {((currentResult?.elapsedMs ?? elapsedMs) / 1000).toFixed(1)}s
                  </span>
                  <span className="text-slate-400">
                    (≤{getTimingRuleForQuestionType(currentQuestion.type).graceSec}s +50đ)
                  </span>
                </div>
              </div>

              <h3 className="text-lg sm:text-xl font-bold text-slate-900 leading-snug">
                {currentQuestion.questionText}
              </h3>

              {/* Teacher-only Answer Key Inspection Box */}
              {showKey && (
                <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200 text-xs space-y-1">
                  <p className="font-bold text-sky-900">
                    {lang === 'vi' ? 'Đáp án chuẩn đã lưu (chỉ giáo viên thấy): ' : 'Stored Answer Key (Teacher Only): '}
                    <span className="font-mono-num text-emerald-800 bg-white px-2 py-0.5 rounded border border-emerald-200">
                      {currentQuestion.correctAnswer || '(Chưa có đáp án)'}
                    </span>
                  </p>
                  {(currentQuestion.type === 'fill_blank' || currentQuestion.type === 'short_answer') && (
                    <p className="text-sky-800">
                      {lang === 'vi'
                        ? 'Mẹo kiểm thử: Thầy/cô có thể nhập thử từ đồng nghĩa, không dấu hoặc hơi sai chính tả để kiểm tra hệ thống tự chấm linh hoạt.'
                        : 'Tip: Try typing synonyms, unaccented Vietnamese, or minor typos to verify flexible grading.'}
                    </p>
                  )}
                  {currentQuestion.type === 'true_false_multi' && (
                    <p className="text-sky-800">
                      {lang === 'vi'
                        ? 'Mẹo kiểm thử: Hệ thống tự động chia điểm tỷ lệ theo số nhận định đúng (VD: đúng 3/4 nhận 75% điểm, đúng 4/4 nhận 100% điểm).'
                        : 'Tip: Proportional partial credit is awarded automatically based on the number of correct statements.'}
                    </p>
                  )}
                </div>
              )}

              {/* Interactive Answer Form */}
              <form onSubmit={handleCheckAnswer} className="space-y-4">
                {currentQuestion.type === 'multiple_choice' && currentQuestion.options ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {currentQuestion.options.map((opt, idx) => {
                      const chosen = selectedOption === opt;
                      return (
                        <button
                          key={opt}
                          type="button"
                          disabled={Boolean(currentResult)}
                          onClick={() => setSelectedOption(opt)}
                          className={`text-left p-3.5 rounded-xl border transition-colors flex items-start gap-3 cursor-pointer disabled:cursor-default ${
                            chosen
                              ? 'bg-sky-600 border-sky-600 text-white'
                              : 'bg-white border-slate-200 hover:border-sky-400 text-slate-800'
                          }`}
                        >
                          <span
                            className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold shrink-0 ${
                              chosen
                                ? 'bg-white/20 text-white'
                                : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {OPTION_LABELS[idx] ?? idx + 1}
                          </span>
                          <span className="text-sm font-medium leading-snug">{opt}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : currentQuestion.type === 'true_false' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {[
                      { val: 'Đúng', labelVi: 'ĐÚNG · Chính xác', labelEn: 'TRUE · Accurate', isTrue: true },
                      { val: 'Sai', labelVi: 'SAI · Không chính xác', labelEn: 'FALSE · Inaccurate', isTrue: false },
                    ].map((btn) => {
                      const chosen = selectedOption === btn.val;
                      return (
                        <button
                          key={btn.val}
                          type="button"
                          disabled={Boolean(currentResult)}
                          onClick={() => setSelectedOption(btn.val)}
                          className={`p-4 rounded-xl border-2 font-bold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:cursor-default ${
                            chosen
                              ? btn.isTrue
                                ? 'bg-emerald-600 border-emerald-600 text-white'
                                : 'bg-rose-600 border-rose-600 text-white'
                              : btn.isTrue
                                ? 'bg-white border-slate-200 hover:border-emerald-400 text-slate-800'
                                : 'bg-white border-slate-200 hover:border-rose-400 text-slate-800'
                          }`}
                        >
                          {btn.isTrue ? (
                            <CheckCircle2 className="w-4 h-4" />
                          ) : (
                            <XCircle className="w-4 h-4" />
                          )}
                          <span>{lang === 'vi' ? btn.labelVi : btn.labelEn}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : currentQuestion.type === 'true_false_multi' && tfStatements.length > 0 ? (
                  <div className="space-y-2.5">
                    {tfStatements.map((stmt, idx) => {
                      const chosenVal = tfMultiSelections[idx] ?? null;
                      const letter = String.fromCharCode(97 + idx);
                      return (
                        <div
                          key={`${currentQuestion.id}-sb-stmt-${idx}`}
                          className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                        >
                          <div className="flex items-start gap-2 min-w-0">
                            <span className="w-6 h-6 rounded-md bg-sky-100 text-sky-800 font-bold text-xs flex items-center justify-center shrink-0 uppercase">
                              {letter}
                            </span>
                            <p className="text-sm text-slate-900 font-medium leading-snug">{stmt}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                            <button
                              type="button"
                              disabled={Boolean(currentResult)}
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
                              className={`px-3 py-1.5 rounded-lg border-2 text-xs font-bold cursor-pointer disabled:cursor-default ${
                                chosenVal === true
                                  ? 'bg-emerald-600 border-emerald-600 text-white'
                                  : 'bg-white border-slate-200 hover:border-emerald-400 text-slate-700'
                              }`}
                            >
                              {lang === 'vi' ? 'Đúng' : 'True'}
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(currentResult)}
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
                              className={`px-3 py-1.5 rounded-lg border-2 text-xs font-bold cursor-pointer disabled:cursor-default ${
                                chosenVal === false
                                  ? 'bg-rose-600 border-rose-600 text-white'
                                  : 'bg-white border-slate-200 hover:border-rose-400 text-slate-700'
                              }`}
                            >
                              {lang === 'vi' ? 'Sai' : 'False'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <label
                      htmlFor="teacher-sandbox-answer"
                      className="block text-xs font-semibold text-slate-700"
                    >
                      {lang === 'vi'
                        ? 'Nhập đáp án thử nghiệm (tự do nhập từ đồng nghĩa / gần đúng):'
                        : 'Type a test answer (try synonyms or near-matches):'}
                    </label>
                    <textarea
                      id="teacher-sandbox-answer"
                      rows={currentQuestion.type === 'short_answer' ? 3 : 2}
                      disabled={Boolean(currentResult)}
                      value={textAnswer}
                      onChange={(e) => setTextAnswer(e.target.value)}
                      placeholder={
                        lang === 'vi'
                          ? 'Gõ câu trả lời để kiểm tra thuật toán chấm điểm...'
                          : 'Enter an answer to test grading...'
                      }
                      className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:bg-slate-50"
                    />
                  </div>
                )}

                {!currentResult && (
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={!answerValue.trim()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-40 rounded-xl cursor-pointer"
                    >
                      <Send className="w-4 h-4" />
                      <span>{lang === 'vi' ? 'Chấm thử (Không lưu)' : 'Test Grade (Local)'}</span>
                    </button>
                  </div>
                )}
              </form>

              {/* Sandbox Result Feedback */}
              {currentResult && (
                <div
                  className={`rounded-xl border p-4 space-y-3 ${
                    currentResult.matchTier === 'fuzzy_partial'
                      ? 'bg-sky-50 border-sky-200'
                      : currentResult.isCorrect
                        ? 'bg-emerald-50 border-emerald-200'
                        : 'bg-rose-50 border-rose-200'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 font-bold text-sm">
                      {currentResult.matchTier === 'fuzzy_partial' ? (
                        <>
                          <CheckCircle2 className="w-5 h-5 text-sky-700" />
                          <span className="text-sky-900">
                            {lang === 'vi'
                              ? `Hệ thống chấm: GẦN ĐÚNG — Điểm khuyến khích ${Math.round(currentResult.creditFactor * 100)}% (Tương đồng ${Math.round(currentResult.similarity * 100)}%)`
                              : `Grader Result: PARTIAL CREDIT ${Math.round(currentResult.creditFactor * 100)}% (${Math.round(currentResult.similarity * 100)}% match)`}
                          </span>
                        </>
                      ) : currentResult.isCorrect ? (
                        <>
                          <CheckCircle2 className="w-5 h-5 text-emerald-700" />
                          <span className="text-emerald-900">
                            {currentResult.matchTier === 'synonym'
                              ? lang === 'vi'
                                ? 'Hệ thống chấm: CHÍNH XÁC 100% (Nhận diện từ đồng nghĩa)'
                                : 'Grader Result: 100% CORRECT (Synonym match)'
                              : currentResult.matchTier === 'fuzzy_full'
                                ? lang === 'vi'
                                  ? `Hệ thống chấm: CHÍNH XÁC 100% (Lỗi gõ nhẹ · Tương đồng ${Math.round(currentResult.similarity * 100)}%)`
                                  : `Grader Result: 100% CORRECT (Minor typo accepted · ${Math.round(currentResult.similarity * 100)}%)`
                                : lang === 'vi'
                                  ? 'Hệ thống chấm: CHÍNH XÁC 100%'
                                  : 'Grader Result: 100% CORRECT'}
                          </span>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-5 h-5 text-rose-700" />
                          <span className="text-rose-900">
                            {lang === 'vi'
                              ? `Hệ thống chấm: CHƯA KHỚP ĐÁP ÁN${currentResult.similarity > 0 ? ` (Tương đồng ${Math.round(currentResult.similarity * 100)}%)` : ''}`
                              : `Grader Result: NOT MATCHED${currentResult.similarity > 0 ? ` (${Math.round(currentResult.similarity * 100)}%)` : ''}`}
                          </span>
                        </>
                      )}
                    </div>
                    <span className="font-mono-num text-sm font-bold text-slate-900">
                      +{currentResult.totalPoints} {lang === 'vi' ? 'đ' : 'pts'}
                      {currentResult.speedBonus > 0
                        ? ` (+${currentResult.speedBonus} ${lang === 'vi' ? 'tốc độ' : 'speed'})`
                        : ''}
                    </span>
                  </div>

                  {currentQuestion.explanation && (
                    <p className="text-xs text-slate-700 leading-relaxed">
                      <strong>{lang === 'vi' ? 'Giải thích: ' : 'Explanation: '}</strong>
                      {currentQuestion.explanation}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleRetryCurrent}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>
                        {lang === 'vi'
                          ? 'Thử nhập đáp án khác cho câu này'
                          : 'Test Another Answer'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        if (questionIndex >= totalQ - 1) {
                          setFinished(true);
                        } else {
                          setQuestionIndex((i) => i + 1);
                        }
                      }}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                    >
                      <span>
                        {questionIndex >= totalQ - 1
                          ? lang === 'vi'
                            ? 'Xem tổng kết chạy thử'
                            : 'Finish Preview'
                          : lang === 'vi'
                            ? 'Câu tiếp theo'
                            : 'Next Question'}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
