import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Award,
  Check,
  CheckCircle2,
  Flame,
  Lightbulb,
  Link2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trophy,
  XCircle,
} from 'lucide-react';
import { getCompetencyById, getDomainByCompetencyId } from '../shared/competencies';
import {
  deterministicShuffle,
  ExerciseSubmissionPayload,
  getLevelMeta,
  gradeAssessmentExercise,
  shuffleStepsNonTrivial,
} from '../shared/assessmentEngine';
import {
  AssessmentExercise,
  AssessmentExerciseOutcome,
  AssessmentLevel,
  AssessmentSessionMode,
  Language,
  UiMode,
} from '../shared/types';

interface SelfAssessmentRunnerProps {
  title: string;
  mode: AssessmentSessionMode;
  targetLevel?: AssessmentLevel;
  targetCompetencyId?: string;
  exercises: AssessmentExercise[];
  onCompleteSession: (payload: {
    mode: AssessmentSessionMode;
    targetLevel?: AssessmentLevel;
    targetCompetencyId?: string;
    outcomes: AssessmentExerciseOutcome[];
    maxCombo: number;
  }) => Promise<void>;
  onExit: () => void;
  lang: Language;
  uiMode: UiMode;
}

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];
const PAIR_COLORS = [
  'bg-sky-100 text-sky-800 border-sky-300',
  'bg-emerald-100 text-emerald-800 border-emerald-300',
  'bg-amber-100 text-amber-800 border-amber-300',
  'bg-rose-100 text-rose-800 border-rose-300',
];

function getExerciseTypeBadge(type: AssessmentExercise['type'], lang: Language): string {
  switch (type) {
    case 'scenario_choice':
      return lang === 'vi' ? 'Tình huống thực tế' : 'Real-World Scenario';
    case 'true_false':
      return lang === 'vi' ? 'Đúng hay Sai · Quét nhanh' : 'True / False Rapid Check';
    case 'order_steps':
      return lang === 'vi' ? 'Sắp xếp Quy trình 4 bước' : '4-Step Sequence Puzzle';
    case 'match_pairs':
      return lang === 'vi' ? 'Ghép cặp Kiến thức' : 'Concept Match Game';
    case 'classify':
      return lang === 'vi' ? 'Phân loại Thông minh' : 'Smart Sorting Challenge';
  }
}

export function SelfAssessmentRunner({
  title,
  mode,
  targetLevel,
  targetCompetencyId,
  exercises,
  onCompleteSession,
  onExit,
  lang,
  uiMode,
}: SelfAssessmentRunnerProps) {
  const [index, setIndex] = useState(0);
  const [outcomes, setOutcomes] = useState<AssessmentExerciseOutcome[]>([]);
  const [combo, setCombo] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const [feedback, setFeedback] = useState<{
    isCorrect: boolean;
    detailNote: string;
    xpEarned: number;
  } | null>(null);
  const [finished, setFinished] = useState(false);
  const [saving, setSaving] = useState(false);

  // Per-mechanic interactive state
  const [selectedOption, setSelectedOption] = useState<string>('');
  const [selectedBool, setSelectedBool] = useState<boolean | null>(null);
  const [orderedSteps, setOrderedSteps] = useState<string[]>([]);
  const [activeLeftPairId, setActiveLeftPairId] = useState<string | null>(null);
  const [matchedPairs, setMatchedPairs] = useState<Record<string, string>>({});
  const [classifiedMap, setClassifiedMap] = useState<Record<string, 'safe' | 'risk'>>({});

  const current = exercises[index] ?? null;

  const shuffledMatchRights = useMemo(() => {
    if (!current || current.type !== 'match_pairs' || !current.pairs) return [];
    const rights = current.pairs.map((p) => p.right);
    return shuffleStepsNonTrivial(rights, `${current.id}-rights`);
  }, [current]);

  const shuffledClassifyItems = useMemo(() => {
    if (!current || current.type !== 'classify' || !current.classifyItems) return [];
    return deterministicShuffle(current.classifyItems, `${current.id}-cls`);
  }, [current]);

  useEffect(() => {
    if (!current) return;
    setSelectedOption('');
    setSelectedBool(null);
    setActiveLeftPairId(current.pairs?.[0]?.id ?? null);
    setMatchedPairs({});
    setClassifiedMap({});
    setShowHint(false);
    setFeedback(null);
    if (current.type === 'order_steps' && current.steps) {
      setOrderedSteps(shuffleStepsNonTrivial(current.steps, `${current.id}-steps`));
    } else {
      setOrderedSteps([]);
    }
  }, [current]);

  if (!current && !finished) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-4">
        <p className="text-sm text-slate-600">
          {lang === 'vi' ? 'Không tìm thấy bài tập phù hợp.' : 'No exercises found.'}
        </p>
        <button
          type="button"
          onClick={onExit}
          className="px-4 py-2 text-sm font-semibold text-white bg-sky-600 rounded-xl cursor-pointer"
        >
          {lang === 'vi' ? 'Quay lại' : 'Go Back'}
        </button>
      </div>
    );
  }

  const canSubmit = (() => {
    if (!current || feedback) return false;
    switch (current.type) {
      case 'scenario_choice':
        return Boolean(selectedOption);
      case 'true_false':
        return selectedBool !== null;
      case 'order_steps':
        return orderedSteps.length === (current.steps?.length ?? 0);
      case 'match_pairs':
        return (
          (current.pairs?.length ?? 0) > 0 &&
          (current.pairs ?? []).every((p) => Boolean(matchedPairs[p.id]))
        );
      case 'classify':
        return (
          (current.classifyItems?.length ?? 0) > 0 &&
          (current.classifyItems ?? []).every((item) => Boolean(classifiedMap[item.id]))
        );
    }
  })();

  const handleMoveStep = (pos: number, delta: -1 | 1) => {
    if (feedback) return;
    const target = pos + delta;
    if (target < 0 || target >= orderedSteps.length) return;
    setOrderedSteps((prev) => {
      const next = [...prev];
      const tmp = next[pos];
      next[pos] = next[target];
      next[target] = tmp;
      return next;
    });
  };

  const handleSelectMatchRight = (rightText: string) => {
    if (feedback || !current?.pairs) return;
    const targetLeftId =
      activeLeftPairId ??
      current.pairs.find((p) => !matchedPairs[p.id])?.id ??
      current.pairs[0].id;

    setMatchedPairs((prev) => {
      const next = { ...prev };
      // Ensure 1-to-1 matching by removing rightText from any previous left pair
      for (const [k, v] of Object.entries(next)) {
        if (v === rightText) delete next[k];
      }
      next[targetLeftId] = rightText;
      // Advance selection to next unmatched left item
      const nextUnmatched = current.pairs?.find((p) => !next[p.id]);
      setActiveLeftPairId(nextUnmatched ? nextUnmatched.id : null);
      return next;
    });
  };

  const handleSubmit = () => {
    if (!current || !canSubmit || feedback) return;

    const payload: ExerciseSubmissionPayload = {
      selectedOption,
      selectedBool: selectedBool ?? undefined,
      orderedSteps,
      matchedPairs,
      classifiedMap,
    };

    const result = gradeAssessmentExercise(current, payload);
    const levelMeta = getLevelMeta(current.level);
    const nextCombo = result.isCorrect ? combo + 1 : 0;
    const comboBonus = result.isCorrect && nextCombo >= 3 ? 10 : 0;
    const xpEarned = result.isCorrect ? levelMeta.xpPerCorrect + comboBonus : 5; // +5 effort XP even when learning from mistake

    setCombo(nextCombo);
    const updatedMaxCombo = Math.max(maxCombo, nextCombo);
    setMaxCombo(updatedMaxCombo);

    const outcome: AssessmentExerciseOutcome = {
      exerciseId: current.id,
      competencyId: current.competencyId,
      level: current.level,
      type: current.type,
      isCorrect: result.isCorrect,
      xpEarned,
    };
    setOutcomes((prev) => [...prev, outcome]);
    setFeedback({
      isCorrect: result.isCorrect,
      detailNote: result.detailNote,
      xpEarned,
    });
  };

  const handleNext = async () => {
    if (index + 1 < exercises.length) {
      setIndex((i) => i + 1);
      return;
    }
    setFinished(true);
    setSaving(true);
    try {
      await onCompleteSession({
        mode,
        targetLevel,
        targetCompetencyId,
        outcomes,
        maxCombo,
      });
    } finally {
      setSaving(false);
    }
  };

  // Completion Summary Screen
  if (finished) {
    const total = outcomes.length;
    const correct = outcomes.filter((o) => o.isCorrect).length;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
    const totalXp = outcomes.reduce((s, o) => s + o.xpEarned, 0);
    const leveledComps = Array.from(
      new Set(outcomes.filter((o) => o.isCorrect).map((o) => o.competencyId)),
    );

    return (
      <section className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
        <div className="text-center space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center mx-auto">
            <Trophy className="w-8 h-8" />
          </div>
          <p className="text-xs font-bold uppercase tracking-wide text-sky-700">
            {lang === 'vi' ? 'Hoàn thành phiên Tự đánh giá!' : 'Self-Assessment Complete!'}
          </p>
          <h2 className="text-2xl sm:text-3xl font-bold text-slate-900">{title}</h2>
          <p className="text-sm text-slate-600">
            {accuracy >= 80
              ? lang === 'vi'
                ? 'Xuất sắc! Em đang tiến rất nhanh trên hành trình chinh phục 24 Năng lực Công dân số.'
                : 'Outstanding! You are mastering the 24 Digital Competencies rapidly.'
              : accuracy >= 50
                ? lang === 'vi'
                  ? 'Làm tốt lắm! Hãy xem các năng lực vừa luyện và tiếp tục nâng cấp độ nhé.'
                  : 'Great effort! Review what you practiced and keep leveling up.'
                : lang === 'vi'
                  ? 'Khởi đầu tuyệt vời! Mỗi câu giải thích đều giúp em hiểu sâu hơn để lần sau đạt điểm cao hơn.'
                  : 'Good start! Every explanation makes you stronger for the next round.'}
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-4 rounded-xl bg-sky-50 border border-sky-200 text-center">
            <p className="text-xs font-medium text-sky-800">
              {lang === 'vi' ? 'Chính xác' : 'Accuracy'}
            </p>
            <p className="text-2xl font-extrabold font-mono-num text-sky-900 mt-1">
              {accuracy}%
            </p>
            <p className="text-[11px] text-sky-700 tabular-nums">
              {correct}/{total} {lang === 'vi' ? 'câu đúng' : 'correct'}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-center">
            <p className="text-xs font-medium text-emerald-800">
              {lang === 'vi' ? 'Điểm kinh nghiệm' : 'XP Earned'}
            </p>
            <p className="text-2xl font-extrabold font-mono-num text-emerald-900 mt-1">
              +{totalXp}
            </p>
            <p className="text-[11px] text-emerald-700">XP</p>
          </div>
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-center">
            <p className="text-xs font-medium text-amber-800">
              {lang === 'vi' ? 'Chuỗi đúng cao nhất' : 'Best Streak'}
            </p>
            <p className="text-2xl font-extrabold font-mono-num text-amber-900 mt-1">
              {maxCombo}
            </p>
            <p className="text-[11px] text-amber-700">Combo</p>
          </div>
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-center">
            <p className="text-xs font-medium text-slate-600">
              {lang === 'vi' ? 'Năng lực ghi nhận' : 'Skills Cleared'}
            </p>
            <p className="text-2xl font-extrabold font-mono-num text-slate-900 mt-1">
              {leveledComps.length}
            </p>
            <p className="text-[11px] text-slate-500">TT 02/2025</p>
          </div>
        </div>

        {leveledComps.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-700">
              {lang === 'vi'
                ? 'Các năng lực vừa được cộng điểm thành thạo:'
                : 'Competencies leveled up in this session:'}
            </p>
            <div className="flex flex-wrap gap-2">
              {leveledComps.map((cid) => {
                const c = getCompetencyById(cid);
                const d = getDomainByCompetencyId(cid);
                return (
                  <span
                    key={cid}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${d.surfaceClass} ${d.textClass} ${d.borderClass}`}
                  >
                    <Award className="w-3.5 h-3.5" />
                    <span>
                      {c.id} · {lang === 'vi' ? c.nameVi : c.nameEn}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            {saving
              ? lang === 'vi'
                ? 'Đang lưu kết quả vào hồ sơ 24 năng lực...'
                : 'Saving results to your 24-competency profile...'
              : lang === 'vi'
                ? 'Kết quả đã được lưu vào Hồ sơ 24 Năng lực của em!'
                : 'Results saved to your 24-Competency Profile!'}
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={onExit}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50 rounded-xl cursor-pointer"
          >
            <span>
              {lang === 'vi' ? 'Về Bản đồ 24 Năng lực' : 'Back to 24-Competency Map'}
            </span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </section>
    );
  }

  const comp = getCompetencyById(current.competencyId);
  const domain = getDomainByCompetencyId(current.competencyId);
  const levelMeta = getLevelMeta(current.level);
  const progressPct = Math.round(((index + (feedback ? 1 : 0)) / exercises.length) * 100);

  return (
    <section className="max-w-4xl mx-auto space-y-5">
      {/* Runner Header Bar */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onExit}
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{lang === 'vi' ? 'Thoát bài' : 'Exit'}</span>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            {combo >= 2 && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-orange-50 text-orange-700 border border-orange-200 tabular-nums">
                <Flame className="w-3.5 h-3.5" />
                <span>
                  {lang === 'vi' ? `Chuỗi x${combo}` : `Streak x${combo}`}
                </span>
              </span>
            )}
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold border ${levelMeta.badgeClass}`}
            >
              {lang === 'vi' ? levelMeta.nameVi : levelMeta.nameEn}
            </span>
            <span className="font-mono-num text-xs font-bold text-slate-700 bg-slate-100 px-2.5 py-1 rounded-full">
              {index + 1} / {exercises.length}
            </span>
          </div>
        </div>

        <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full bg-sky-600 transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Main Exercise Card */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-bold border ${domain.surfaceClass} ${domain.textClass} ${domain.borderClass}`}
            >
              {comp.id} · {lang === 'vi' ? comp.nameVi : comp.nameEn}
            </span>
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
              <Sparkles className="w-3 h-3 text-sky-600" />
              <span>{getExerciseTypeBadge(current.type, lang)}</span>
            </span>
          </div>
          <span className="text-xs font-semibold text-slate-500">
            {current.contextBadge}
          </span>
        </div>

        <h2
          className={`font-bold text-slate-900 leading-snug ${
            uiMode === 'kid' ? 'text-xl sm:text-2xl' : 'text-lg sm:text-xl'
          }`}
        >
          {current.prompt}
        </h2>

        {/* MECHANIC 1: SCENARIO CHOICE */}
        {current.type === 'scenario_choice' && current.options && (
          <div className="space-y-3">
            {current.options.map((opt, i) => {
              const isSelected = selectedOption === opt;
              const isCorrectOpt = opt === current.correctOption;
              let cardClass =
                'border-slate-200 bg-white hover:border-sky-300 hover:bg-sky-50/40 text-slate-800';
              if (feedback) {
                if (isCorrectOpt) {
                  cardClass = 'border-emerald-500 bg-emerald-50 text-emerald-950';
                } else if (isSelected && !isCorrectOpt) {
                  cardClass = 'border-rose-400 bg-rose-50 text-rose-950';
                } else {
                  cardClass = 'border-slate-200 bg-slate-50/50 text-slate-500';
                }
              } else if (isSelected) {
                cardClass = 'border-sky-600 bg-sky-50 text-sky-950 ring-2 ring-sky-200';
              }

              return (
                <button
                  key={opt}
                  type="button"
                  disabled={Boolean(feedback)}
                  onClick={() => setSelectedOption(opt)}
                  className={`w-full text-left p-4 rounded-xl border transition-all flex items-start gap-3.5 cursor-pointer disabled:cursor-default ${cardClass}`}
                >
                  <span
                    className={`w-7 h-7 rounded-lg text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                      isSelected
                        ? 'bg-sky-600 text-white'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {OPTION_LETTERS[i] ?? i + 1}
                  </span>
                  <span className="text-sm sm:text-base font-medium leading-relaxed">
                    {opt}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* MECHANIC 2: TRUE / FALSE RAPID CARD */}
        {current.type === 'true_false' && (
          <div className="space-y-4">
            <div className="p-5 rounded-xl bg-slate-50 border border-slate-200 text-base sm:text-lg font-semibold text-slate-900 leading-relaxed">
              “{current.statement}”
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { val: true, labelVi: 'ĐÚNG · Chính xác', labelEn: 'TRUE · Accurate', icon: CheckCircle2 },
                { val: false, labelVi: 'SAI · Không đúng', labelEn: 'FALSE · Myth / Wrong', icon: XCircle },
              ].map((btn) => {
                const Icon = btn.icon;
                const isSelected = selectedBool === btn.val;
                const isRightChoice = Boolean(current.isTrue) === btn.val;
                let cls =
                  btn.val
                    ? 'border-slate-200 bg-white hover:border-emerald-400 hover:bg-emerald-50/40 text-slate-800'
                    : 'border-slate-200 bg-white hover:border-rose-400 hover:bg-rose-50/40 text-slate-800';
                if (feedback) {
                  if (isRightChoice) {
                    cls = 'border-emerald-500 bg-emerald-50 text-emerald-900';
                  } else if (isSelected) {
                    cls = 'border-rose-400 bg-rose-50 text-rose-900';
                  } else {
                    cls = 'border-slate-200 bg-slate-50 text-slate-400';
                  }
                } else if (isSelected) {
                  cls = btn.val
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-200'
                    : 'border-rose-600 bg-rose-50 text-rose-900 ring-2 ring-rose-200';
                }

                return (
                  <button
                    key={String(btn.val)}
                    type="button"
                    disabled={Boolean(feedback)}
                    onClick={() => setSelectedBool(btn.val)}
                    className={`p-5 rounded-xl border-2 font-bold text-base flex items-center justify-center gap-2.5 transition-all cursor-pointer disabled:cursor-default ${cls}`}
                  >
                    <Icon className="w-5 h-5" />
                    <span>{lang === 'vi' ? btn.labelVi : btn.labelEn}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* MECHANIC 3: ORDER STEPS PUZZLE */}
        {current.type === 'order_steps' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              {lang === 'vi'
                ? 'Bấm mũi tên Lên / Xuống để sắp xếp các bước theo đúng trình tự từ Bước 1 đến Bước 4:'
                : 'Use Up / Down arrows to arrange the steps from Step 1 to Step 4:'}
            </p>
            <div className="space-y-2.5">
              {orderedSteps.map((step, i) => {
                const isExactSpot = feedback && current.steps?.[i] === step;
                return (
                  <div
                    key={step}
                    className={`p-3.5 rounded-xl border flex items-center justify-between gap-3 ${
                      feedback
                        ? isExactSpot
                          ? 'bg-emerald-50 border-emerald-300'
                          : 'bg-rose-50 border-rose-300'
                        : 'bg-slate-50/70 border-slate-200'
                    }`}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="w-7 h-7 rounded-lg bg-sky-600 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
                        {i + 1}
                      </span>
                      <p className="text-sm sm:text-base font-medium text-slate-900 leading-snug">
                        {step}
                      </p>
                    </div>
                    {!feedback && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={i === 0}
                          onClick={() => handleMoveStep(i, -1)}
                          aria-label="Di chuyển lên"
                          className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowUp className="w-4 h-4 text-slate-700" />
                        </button>
                        <button
                          type="button"
                          disabled={i === orderedSteps.length - 1}
                          onClick={() => handleMoveStep(i, 1)}
                          aria-label="Di chuyển xuống"
                          className="p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowDown className="w-4 h-4 text-slate-700" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {feedback && !feedback.isCorrect && current.steps && (
              <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-1.5">
                <p className="text-xs font-bold text-emerald-800">
                  {lang === 'vi' ? 'Thứ tự quy trình chuẩn:' : 'Correct step order:'}
                </p>
                <ol className="list-decimal list-inside text-xs sm:text-sm text-emerald-950 space-y-1">
                  {current.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        {/* MECHANIC 4: MATCH PAIRS */}
        {current.type === 'match_pairs' && current.pairs && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>
                {lang === 'vi'
                  ? 'Bước 1: Chọn 1 thẻ bên TRÁI · Bước 2: Chọn ý nghĩa tương ứng bên PHẢI.'
                  : 'Step 1: Pick a card on the LEFT · Step 2: Click its matching meaning on the RIGHT.'}
              </span>
              {!feedback && Object.keys(matchedPairs).length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setMatchedPairs({});
                    setActiveLeftPairId(current.pairs?.[0]?.id ?? null);
                  }}
                  className="inline-flex items-center gap-1 text-sky-700 font-semibold hover:underline cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>{lang === 'vi' ? 'Nối lại' : 'Reset'}</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Left Column */}
              <div className="space-y-2.5">
                {current.pairs.map((pair, idx) => {
                  const chosenRight = matchedPairs[pair.id];
                  const isActive = activeLeftPairId === pair.id && !feedback;
                  const pairColor = PAIR_COLORS[idx % PAIR_COLORS.length];
                  const isPairCorrect = feedback && chosenRight === pair.right;
                  return (
                    <button
                      key={pair.id}
                      type="button"
                      disabled={Boolean(feedback)}
                      onClick={() => setActiveLeftPairId(pair.id)}
                      className={`w-full text-left p-3.5 rounded-xl border transition-all cursor-pointer disabled:cursor-default ${
                        feedback
                          ? isPairCorrect
                            ? 'bg-emerald-50 border-emerald-400'
                            : 'bg-rose-50 border-rose-400'
                          : isActive
                            ? 'bg-sky-50 border-sky-600 ring-2 ring-sky-200'
                            : chosenRight
                              ? 'bg-white border-slate-300'
                              : 'bg-white border-slate-200 hover:border-sky-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 font-semibold text-sm text-slate-900">
                          <span
                            className={`w-6 h-6 rounded-md text-xs font-bold border flex items-center justify-center shrink-0 ${pairColor}`}
                          >
                            {idx + 1}
                          </span>
                          <span>{pair.left}</span>
                        </span>
                        {chosenRight && (
                          <Link2 className="w-4 h-4 text-sky-600 shrink-0" />
                        )}
                      </div>
                      {chosenRight && (
                        <p className="mt-2 text-xs text-slate-600 pl-8">
                          → {chosenRight}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Right Column */}
              <div className="space-y-2.5">
                {shuffledMatchRights.map((rightText) => {
                  const linkedPairIdx = current.pairs!.findIndex(
                    (p) => matchedPairs[p.id] === rightText,
                  );
                  const isLinked = linkedPairIdx >= 0;
                  const pairColor = isLinked
                    ? PAIR_COLORS[linkedPairIdx % PAIR_COLORS.length]
                    : '';
                  return (
                    <button
                      key={rightText}
                      type="button"
                      disabled={Boolean(feedback)}
                      onClick={() => handleSelectMatchRight(rightText)}
                      className={`w-full text-left p-3.5 rounded-xl border transition-all flex items-start gap-2.5 cursor-pointer disabled:cursor-default ${
                        isLinked
                          ? 'bg-slate-50 border-slate-300'
                          : 'bg-white border-slate-200 hover:border-sky-400 hover:bg-sky-50/40'
                      }`}
                    >
                      {isLinked ? (
                        <span
                          className={`w-6 h-6 rounded-md text-xs font-bold border flex items-center justify-center shrink-0 mt-0.5 ${pairColor}`}
                        >
                          {linkedPairIdx + 1}
                        </span>
                      ) : (
                        <span className="w-6 h-6 rounded-md border border-dashed border-slate-300 shrink-0 mt-0.5" />
                      )}
                      <span className="text-sm text-slate-800 leading-snug">
                        {rightText}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {feedback && !feedback.isCorrect && (
              <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-1.5">
                <p className="text-xs font-bold text-emerald-800">
                  {lang === 'vi' ? 'Các cặp ghép chuẩn:' : 'Correct matches:'}
                </p>
                <ul className="text-xs sm:text-sm text-emerald-950 space-y-1">
                  {current.pairs.map((p) => (
                    <li key={p.id}>
                      <strong>{p.left}</strong> → {p.right}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* MECHANIC 5: CLASSIFY SORTING */}
        {current.type === 'classify' && current.classifyItems && (
          <div className="space-y-3">
            <div className="space-y-2.5">
              {shuffledClassifyItems.map((item) => {
                const chosen = classifiedMap[item.id];
                const isItemCorrect = feedback && chosen === item.category;
                const safeLabel = current.categoryLabels?.safe || 'An toàn / Nên làm';
                const riskLabel = current.categoryLabels?.risk || 'Rủi ro / Nên tránh';
                return (
                  <div
                    key={item.id}
                    className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                      feedback
                        ? isItemCorrect
                          ? 'bg-emerald-50 border-emerald-300'
                          : 'bg-rose-50 border-rose-300'
                        : 'bg-slate-50/70 border-slate-200'
                    }`}
                  >
                    <p className="text-sm sm:text-base font-medium text-slate-900 leading-snug">
                      {item.text}
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={Boolean(feedback)}
                        onClick={() =>
                          setClassifiedMap((prev) => ({ ...prev, [item.id]: 'safe' }))
                        }
                        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border transition-colors cursor-pointer disabled:cursor-default ${
                          chosen === 'safe'
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                        }`}
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>{safeLabel}</span>
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(feedback)}
                        onClick={() =>
                          setClassifiedMap((prev) => ({ ...prev, [item.id]: 'risk' }))
                        }
                        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold border transition-colors cursor-pointer disabled:cursor-default ${
                          chosen === 'risk'
                            ? 'bg-rose-600 text-white border-rose-600'
                            : 'bg-white text-rose-700 border-rose-200 hover:bg-rose-50'
                        }`}
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>{riskLabel}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Optional Hint */}
        {!feedback && (
          <div>
            {showHint ? (
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs sm:text-sm text-amber-900 flex items-start gap-2.5">
                <Lightbulb className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>{current.hint}</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowHint(true)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-800 cursor-pointer"
              >
                <Lightbulb className="w-3.5 h-3.5" />
                <span>
                  {lang === 'vi' ? 'Xem gợi ý nhỏ' : 'Show a quick hint'}
                </span>
              </button>
            )}
          </div>
        )}

        {/* Instant Feedback & Explanation */}
        {feedback && (
          <div
            role="status"
            className={`p-4 sm:p-5 rounded-xl border space-y-2 ${
              feedback.isCorrect
                ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
                : 'bg-amber-50 border-amber-200 text-amber-950'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 font-bold text-sm sm:text-base">
                {feedback.isCorrect ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                ) : (
                  <XCircle className="w-5 h-5 text-amber-700" />
                )}
                <span>{feedback.detailNote}</span>
              </span>
              <span className="font-mono-num text-xs font-bold px-2.5 py-1 rounded-full bg-white/80 border border-current/15">
                +{feedback.xpEarned} XP
              </span>
            </div>
            <p className="text-xs sm:text-sm leading-relaxed opacity-90">
              {current.explanation}
            </p>
          </div>
        )}

        {/* Footer Action Bar */}
        <div className="pt-4 border-t border-slate-100 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">
            {lang === 'vi'
              ? `Miền ${domain.number}: ${domain.nameVi}`
              : `Domain ${domain.number}: ${domain.nameEn}`}
          </span>

          {!feedback ? (
            <button
              type="button"
              disabled={!canSubmit}
              onClick={handleSubmit}
              className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-semibold text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-40 rounded-xl transition-colors cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>{lang === 'vi' ? 'Kiểm tra đáp án' : 'Check Answer'}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleNext}
              className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
            >
              <span>
                {index + 1 < exercises.length
                  ? lang === 'vi'
                    ? 'Câu tiếp theo'
                    : 'Next Exercise'
                  : lang === 'vi'
                    ? 'Xem kết quả tổng hợp'
                    : 'View Final Summary'}
              </span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
