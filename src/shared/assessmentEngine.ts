import {
  ASSESSMENT_BANK_96,
  ASSESSMENT_BANK_ALL,
  ASSESSMENT_EXPANSION_48,
  ASSESSMENT_LEVELS,
} from './assessmentBank';
import { COMPETENCIES_24, COMPETENCY_DOMAINS } from './competencies';
import {
  AssessmentExercise,
  AssessmentExerciseOutcome,
  AssessmentLevel,
  CompetencyMasteryRecord,
  ExerciseAttemptRecord,
  ExerciseRetryScoringTier,
  LearnerGradeBand,
  LearnerProfile,
  PublicLearnerHonorEntry,
  TeacherAward,
} from './types';

export interface ExerciseSubmissionPayload {
  selectedOption?: string;
  selectedBool?: boolean;
  orderedSteps?: string[];
  matchedPairs?: Record<string, string>; // pair.id -> chosen right text
  classifiedMap?: Record<string, 'safe' | 'risk'>; // item.id -> chosen category
}

export function getLevelMeta(level: AssessmentLevel) {
  return (
    ASSESSMENT_LEVELS.find((l) => l.level === level) ?? ASSESSMENT_LEVELS[0]
  );
}

/**
 * Base XP for an exercise.
 * Higher-level Expansion Pack questions award a +20% challenge bonus over standard level XP
 * (L2+ = 50 XP, L3+ = 75 XP, L4+ = 105 XP) to reward climbing to harder unlocked content.
 */
export function getExerciseBaseXp(
  level: AssessmentLevel,
  tier?: 'core' | 'expansion',
): number {
  const base = getLevelMeta(level).xpPerCorrect;
  if (tier === 'expansion') {
    if (level === 2) return 50;
    if (level === 3) return 75;
    if (level === 4) return 105;
    return Math.round(base * 1.2);
  }
  return base;
}

export function getSuggestedStartLevel(gradeBand: LearnerGradeBand): AssessmentLevel {
  if (gradeBand === 'high') return 3;
  if (gradeBand === 'middle') return 2;
  return 1;
}

export function createEmptyLearnerProfile(params: {
  uid: string;
  authType: 'google' | 'guest';
  email?: string;
  photoUrl?: string;
  fullName: string;
  className: string;
  schoolName: string;
  gradeBand?: LearnerGradeBand;
  profileCompleted?: boolean;
}): LearnerProfile {
  const now = new Date().toISOString();
  const gradeBand: LearnerGradeBand = params.gradeBand ?? 'primary';
  return {
    uid: params.uid,
    authType: params.authType,
    email: params.email,
    photoUrl: params.photoUrl,
    fullName: params.fullName.trim() || 'Học sinh Công dân số',
    className: params.className.trim(),
    schoolName: params.schoolName.trim(),
    gradeBand,
    role: 'student',
    profileCompleted: Boolean(
      params.profileCompleted ??
        (params.fullName.trim().length > 0 &&
          params.className.trim().length > 0 &&
          params.schoolName.trim().length > 0),
    ),
    currentLevel: getSuggestedStartLevel(gradeBand),
    totalXp: 0,
    bestCombo: 0,
    totalExercisesDone: 0,
    totalCorrect: 0,
    masteryByCompetency: {},
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  };
}

/**
 * Looks up a student's prior attempt history for a specific exerciseId.
 */
export function getExerciseAttemptRecord(
  mastery: Record<string, CompetencyMasteryRecord> | undefined,
  competencyId: string,
  exerciseId: string,
): ExerciseAttemptRecord | undefined {
  return mastery?.[competencyId]?.exerciseHistory?.[exerciseId];
}

export interface RetryXpCalculationResult {
  xpEarned: number;
  baseXp: number;
  comboBonus: number;
  multiplierPercent: number;
  retryTier: ExerciseRetryScoringTier;
  badgeVi: string;
  badgeEn: string;
}

/**
 * Pedagogically fair anti-farming retry XP policy:
 * 1. First-try mastery (brand-new question): 100% XP + combo bonus (+10 when streak >= 3)
 * 2. Redemption mastery (previously answered wrong, now mastered): 80% XP + (+5 combo when streak >= 3)
 * 3. First spaced review (already mastered once, 0 prior review bonuses): 25% XP (no combo)
 * 4. Unlimited repeat practice (already mastered + review bonus claimed): 0 XP (prevents XP farming)
 * 5. Wrong answer: +5 effort XP on first try only; 0 XP on repeated wrong attempts
 */
export function calculateExerciseXpWithRetryPolicy(params: {
  level: AssessmentLevel;
  tier?: 'core' | 'expansion';
  isCorrect: boolean;
  nextCombo?: number;
  priorRecord?: ExerciseAttemptRecord;
}): RetryXpCalculationResult {
  const baseXp = getExerciseBaseXp(params.level, params.tier);
  const priorAttempts = params.priorRecord?.attempts ?? 0;
  const priorCorrect = params.priorRecord?.correctCount ?? 0;
  const priorReviewBonuses = params.priorRecord?.reviewBonusCount ?? 0;
  const streak = Math.max(0, params.nextCombo ?? 0);

  if (!params.isCorrect) {
    if (priorAttempts === 0) {
      return {
        xpEarned: 5,
        baseXp,
        comboBonus: 0,
        multiplierPercent: 0,
        retryTier: 'first_attempt_effort',
        badgeVi: 'Nỗ lực lần đầu (+5 XP)',
        badgeEn: 'First Attempt Effort (+5 XP)',
      };
    }
    return {
      xpEarned: 0,
      baseXp,
      comboBonus: 0,
      multiplierPercent: 0,
      retryTier: 'repeat_wrong_no_xp',
      badgeVi: 'Thử lại chưa đúng (0 XP)',
      badgeEn: 'Retry Missed (0 XP)',
    };
  }

  // Case 1: Brand-new exercise mastered on first attempt -> 100% XP
  if (priorAttempts === 0) {
    const comboBonus = streak >= 3 ? 10 : 0;
    return {
      xpEarned: baseXp + comboBonus,
      baseXp,
      comboBonus,
      multiplierPercent: 100,
      retryTier: 'first_mastery',
      badgeVi:
        params.tier === 'expansion'
          ? 'Chinh phục Câu Mở rộng · 100% XP'
          : 'Chinh phục lần đầu · 100% XP',
      badgeEn:
        params.tier === 'expansion'
          ? 'Expansion Mastered · 100% XP'
          : 'First-Try Mastery · 100% XP',
    };
  }

  // Case 2: Previously got it wrong, studied and now got it right -> 80% Redemption XP
  if (priorCorrect === 0) {
    const scaledBase = Math.round(baseXp * 0.8);
    const comboBonus = streak >= 3 ? 5 : 0;
    return {
      xpEarned: scaledBase + comboBonus,
      baseXp: scaledBase,
      comboBonus,
      multiplierPercent: 80,
      retryTier: 'redemption_mastery',
      badgeVi: 'Sửa sai thành công · 80% XP',
      badgeEn: 'Mistake Fixed · 80% XP',
    };
  }

  // Case 3: Already mastered once, first spaced-review reinforcement -> 25% XP (capped once per exercise)
  if (priorReviewBonuses === 0) {
    const reviewXp = Math.max(5, Math.round(baseXp * 0.25));
    return {
      xpEarned: reviewXp,
      baseXp: reviewXp,
      comboBonus: 0,
      multiplierPercent: 25,
      retryTier: 'review_bonus',
      badgeVi: 'Ôn tập củng cố · 25% XP',
      badgeEn: 'Spaced Review · 25% XP',
    };
  }

  // Case 4: Already mastered & review bonus already earned -> Pure practice mode (0 XP)
  return {
    xpEarned: 0,
    baseXp: 0,
    comboBonus: 0,
    multiplierPercent: 0,
    retryTier: 'practice_no_xp',
    badgeVi: 'Luyện tập không cộng điểm (0 XP)',
    badgeEn: 'Free Practice Mode (0 XP)',
  };
}

/**
 * Returns all exercises unlocked for the student's current level:
 * - All 96 core exercises (24 competencies × L1..L4) are always available.
 * - Expansion packs unlock progressively as students climb:
 *   Level 2 unlocks +12 (L2+), Level 3 unlocks +18 (L3+), Level 4 unlocks +18 (L4+).
 */
export function getUnlockedAssessmentBank(
  currentLevel: AssessmentLevel = 1,
): AssessmentExercise[] {
  return ASSESSMENT_BANK_ALL.filter(
    (ex) => ex.tier !== 'expansion' || (ex.unlockMinLevel ?? ex.level) <= currentLevel,
  );
}

export interface ExpansionLevelPackInfo {
  level: 2 | 3 | 4;
  totalCount: number;
  unlocked: boolean;
  masteredCount: number;
  remainingNewCount: number;
  xpPerCorrect: number;
}

export interface ExpansionUnlockSummary {
  coreTotal: number;
  expansionTotal: number;
  unlockedExpansionCount: number;
  totalUnlockedBankSize: number;
  masteredExpansionCount: number;
  packs: ExpansionLevelPackInfo[];
}

export function getExpansionUnlockSummary(
  currentLevel: AssessmentLevel,
  mastery: Record<string, CompetencyMasteryRecord> = {},
): ExpansionUnlockSummary {
  const levels: Array<2 | 3 | 4> = [2, 3, 4];
  const packs: ExpansionLevelPackInfo[] = levels.map((lvl) => {
    const list = ASSESSMENT_EXPANSION_48.filter((ex) => ex.level === lvl);
    const unlocked = currentLevel >= lvl;
    const masteredCount = list.filter(
      (ex) => (getExerciseAttemptRecord(mastery, ex.competencyId, ex.id)?.correctCount ?? 0) > 0,
    ).length;
    return {
      level: lvl,
      totalCount: list.length,
      unlocked,
      masteredCount,
      remainingNewCount: Math.max(0, list.length - masteredCount),
      xpPerCorrect: getExerciseBaseXp(lvl, 'expansion'),
    };
  });

  const unlockedExpansionCount = packs
    .filter((p) => p.unlocked)
    .reduce((sum, p) => sum + p.totalCount, 0);
  const masteredExpansionCount = packs.reduce((sum, p) => sum + p.masteredCount, 0);

  return {
    coreTotal: ASSESSMENT_BANK_96.length,
    expansionTotal: ASSESSMENT_EXPANSION_48.length,
    unlockedExpansionCount,
    totalUnlockedBankSize: ASSESSMENT_BANK_96.length + unlockedExpansionCount,
    masteredExpansionCount,
    packs,
  };
}

/**
 * Deterministic hash-based shuffle so order_steps / match_pairs options never appear
 * in the exact solved order by accident.
 */
export function deterministicShuffle<T>(items: readonly T[], seed: string): T[] {
  const arr = [...items];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let i = arr.length - 1; i > 0; i--) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    const j = Math.abs(h) % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

export function shuffleStepsNonTrivial(steps: readonly string[], seed: string): string[] {
  if (steps.length <= 1) return [...steps];
  const shuffled = deterministicShuffle(steps, seed);
  const sameAsOriginal = shuffled.every((s, idx) => s === steps[idx]);
  if (sameAsOriginal) {
    return [...shuffled.slice(1), shuffled[0]];
  }
  return shuffled;
}

export function gradeAssessmentExercise(
  exercise: AssessmentExercise,
  payload: ExerciseSubmissionPayload,
): { isCorrect: boolean; detailNote: string } {
  switch (exercise.type) {
    case 'scenario_choice': {
      const ok = Boolean(
        payload.selectedOption &&
          exercise.correctOption &&
          payload.selectedOption.trim() === exercise.correctOption.trim(),
      );
      return {
        isCorrect: ok,
        detailNote: ok ? 'Lựa chọn chính xác!' : `Đáp án đúng: ${exercise.correctOption ?? ''}`,
      };
    }

    case 'true_false': {
      const ok =
        typeof payload.selectedBool === 'boolean' &&
        payload.selectedBool === Boolean(exercise.isTrue);
      return {
        isCorrect: ok,
        detailNote: ok
          ? 'Phán đoán chuẩn xác!'
          : `Nhận định này là ${exercise.isTrue ? 'ĐÚNG' : 'SAI'}.`,
      };
    }

    case 'order_steps': {
      const expected = exercise.steps ?? [];
      const actual = payload.orderedSteps ?? [];
      const ok =
        expected.length > 0 &&
        actual.length === expected.length &&
        expected.every((step, idx) => actual[idx] === step);
      return {
        isCorrect: ok,
        detailNote: ok
          ? 'Sắp xếp quy trình hoàn hảo!'
          : 'Thứ tự các bước chưa khớp hoàn toàn. Xem lại quy trình chuẩn bên dưới nhé!',
      };
    }

    case 'match_pairs': {
      const expected = exercise.pairs ?? [];
      const map = payload.matchedPairs ?? {};
      const ok =
        expected.length > 0 &&
        expected.every((pair) => map[pair.id] === pair.right);
      const matchedCount = expected.filter((pair) => map[pair.id] === pair.right).length;
      return {
        isCorrect: ok,
        detailNote: ok
          ? `Ghép đúng toàn bộ ${expected.length}/${expected.length} cặp!`
          : `Em ghép đúng ${matchedCount}/${expected.length} cặp. Xem lại các cặp chuẩn bên dưới nhé!`,
      };
    }

    case 'classify': {
      const expected = exercise.classifyItems ?? [];
      const map = payload.classifiedMap ?? {};
      const ok =
        expected.length > 0 &&
        expected.every((item) => map[item.id] === item.category);
      const correctCount = expected.filter((item) => map[item.id] === item.category).length;
      return {
        isCorrect: ok,
        detailNote: ok
          ? `Phân loại chuẩn ${expected.length}/${expected.length} tình huống!`
          : `Em phân loại đúng ${correctCount}/${expected.length} mục. Xem giải thích bên dưới nhé!`,
      };
    }
  }
}

export function computeOverallLevel(
  masteryByCompetency: Record<string, CompetencyMasteryRecord>,
  totalXp: number,
): AssessmentLevel {
  const records = Object.values(masteryByCompetency);
  const reachedL1 = records.filter((r) => r.highestLevel >= 1).length;
  const reachedL2 = records.filter((r) => r.highestLevel >= 2).length;
  const reachedL3 = records.filter((r) => r.highestLevel >= 3).length;
  const reachedL4 = records.filter((r) => r.highestLevel >= 4).length;

  if (reachedL4 >= 12 || (reachedL3 >= 18 && totalXp >= 1500)) {
    return 4;
  }
  if (reachedL3 >= 8 || (reachedL2 >= 14 && totalXp >= 750)) {
    return 3;
  }
  if (reachedL2 >= 4 || reachedL1 >= 8 || totalXp >= 250) {
    return 2;
  }
  return 1;
}

const EXERCISE_BY_ID = new Map<string, AssessmentExercise>(
  ASSESSMENT_BANK_ALL.map((ex) => [ex.id, ex]),
);

export interface ApplyOutcomesResult {
  profile: LearnerProfile;
  normalizedOutcomes: AssessmentExerciseOutcome[];
  xpAdded: number;
}

/**
 * Authoritatively applies session outcomes to a learner profile, updating per-exercise history
 * and strictly enforcing the anti-farming retry XP caps server-side.
 */
export function applyAssessmentOutcomesDetailed(
  profile: LearnerProfile,
  outcomes: AssessmentExerciseOutcome[],
  maxCombo: number,
): ApplyOutcomesResult {
  const now = new Date().toISOString();
  const nextMastery: Record<string, CompetencyMasteryRecord> = {};
  for (const [cid, rec] of Object.entries(profile.masteryByCompetency ?? {})) {
    nextMastery[cid] = {
      ...rec,
      exerciseHistory: rec.exerciseHistory ? { ...rec.exerciseHistory } : {},
    };
  }

  let addedXp = 0;
  let addedCorrect = 0;
  let runningCombo = 0;
  const normalizedOutcomes: AssessmentExerciseOutcome[] = [];

  for (const out of outcomes) {
    const prev = nextMastery[out.competencyId] ?? {
      competencyId: out.competencyId,
      highestLevel: 0 as const,
      attempts: 0,
      correctCount: 0,
      xp: 0,
      lastPracticedAt: now,
      exerciseHistory: {},
    };

    const history = { ...(prev.exerciseHistory ?? {}) };
    const priorEx = history[out.exerciseId];
    const bankEx = EXERCISE_BY_ID.get(out.exerciseId);
    const exLevel = bankEx?.level ?? out.level;
    const exTier = bankEx?.tier;

    runningCombo = out.isCorrect ? runningCombo + 1 : 0;

    const policy = calculateExerciseXpWithRetryPolicy({
      level: exLevel,
      tier: exTier,
      isCorrect: out.isCorrect,
      nextCombo: Math.max(runningCombo, maxCombo >= 3 ? 3 : 0),
      priorRecord: priorEx,
    });

    // Authoritative XP: never exceed the policy ceiling (prevents client spoofing & XP farming)
    const requestedXp = Math.max(0, Math.round(out.xpEarned || 0));
    const authoritativeXp =
      requestedXp > 0
        ? Math.min(requestedXp, policy.xpEarned)
        : policy.retryTier === 'practice_no_xp' || policy.retryTier === 'repeat_wrong_no_xp'
          ? 0
          : policy.xpEarned;

    history[out.exerciseId] = {
      attempts: (priorEx?.attempts ?? 0) + 1,
      correctCount: (priorEx?.correctCount ?? 0) + (out.isCorrect ? 1 : 0),
      reviewBonusCount:
        (priorEx?.reviewBonusCount ?? 0) + (policy.retryTier === 'review_bonus' ? 1 : 0),
      lastAttemptAt: now,
    };

    const nextHighest = out.isCorrect
      ? (Math.max(prev.highestLevel, exLevel) as 0 | AssessmentLevel)
      : prev.highestLevel;

    nextMastery[out.competencyId] = {
      competencyId: out.competencyId,
      highestLevel: nextHighest,
      attempts: prev.attempts + 1,
      correctCount: prev.correctCount + (out.isCorrect ? 1 : 0),
      xp: prev.xp + authoritativeXp,
      lastPracticedAt: now,
      exerciseHistory: history,
    };

    addedXp += authoritativeXp;
    if (out.isCorrect) addedCorrect += 1;

    normalizedOutcomes.push({
      ...out,
      level: exLevel,
      xpEarned: authoritativeXp,
      retryTier: policy.retryTier,
    });
  }

  const nextTotalXp = profile.totalXp + addedXp;
  const computedLevel = computeOverallLevel(nextMastery, nextTotalXp);

  const updatedProfile: LearnerProfile = {
    ...profile,
    currentLevel: Math.max(profile.currentLevel, computedLevel) as AssessmentLevel,
    totalXp: nextTotalXp,
    bestCombo: Math.max(profile.bestCombo, maxCombo),
    totalExercisesDone: profile.totalExercisesDone + outcomes.length,
    totalCorrect: profile.totalCorrect + addedCorrect,
    masteryByCompetency: nextMastery,
    updatedAt: now,
    lastActiveAt: now,
  };

  return {
    profile: updatedProfile,
    normalizedOutcomes,
    xpAdded: addedXp,
  };
}

export function applyAssessmentOutcomesToProfile(
  profile: LearnerProfile,
  outcomes: AssessmentExerciseOutcome[],
  maxCombo: number,
): LearnerProfile {
  return applyAssessmentOutcomesDetailed(profile, outcomes, maxCombo).profile;
}

/**
 * Helper to rank exercises so students always see fresh/unmastered questions first:
 * 0 = never attempted (100% XP), 1 = attempted but missed (80% redemption XP),
 * 2 = mastered once & eligible for 25% review, 3 = fully reviewed (0 XP practice).
 */
function exerciseFreshnessBucket(
  ex: AssessmentExercise,
  mastery: Record<string, CompetencyMasteryRecord>,
): number {
  const rec = getExerciseAttemptRecord(mastery, ex.competencyId, ex.id);
  if (!rec || rec.attempts === 0) return 0;
  if (rec.correctCount === 0) return 1;
  if (rec.reviewBonusCount === 0) return 2;
  return 3;
}

/**
 * 12-question Diagnostic Quick Test covering ALL 6 domains (2 per domain),
 * spanning Levels 1..4 and mixing all 5 interactive exercise types.
 * Uses unlocked exercises and prefers fresh/unmastered items.
 */
export function buildDiagnosticDeck(
  seed = 'diag',
  mastery: Record<string, CompetencyMasteryRecord> = {},
  currentLevel: AssessmentLevel = 1,
): AssessmentExercise[] {
  const unlockedBank = getUnlockedAssessmentBank(currentLevel);
  const picked: AssessmentExercise[] = [];
  const usedIds = new Set<string>();

  for (const domain of COMPETENCY_DOMAINS) {
    const domainComps = COMPETENCIES_24.filter((c) => c.domainId === domain.id);
    const domainPool = unlockedBank.filter((ex) =>
      domainComps.some((c) => c.id === ex.competencyId),
    );
    const shuffled = deterministicShuffle(domainPool, `${seed}-${domain.id}`).sort(
      (a, b) => exerciseFreshnessBucket(a, mastery) - exerciseFreshnessBucket(b, mastery),
    );

    const foundational =
      shuffled.find((e) => (e.level === 1 || e.level === 2) && !usedIds.has(e.id)) ??
      shuffled[0];
    if (foundational) {
      picked.push(foundational);
      usedIds.add(foundational.id);
    }

    const advanced =
      shuffled.find(
        (e) =>
          (e.level === 3 || e.level === 4) &&
          !usedIds.has(e.id) &&
          e.competencyId !== foundational?.competencyId,
      ) ?? shuffled.find((e) => !usedIds.has(e.id));
    if (advanced) {
      picked.push(advanced);
      usedIds.add(advanced.id);
    }
  }

  return picked.sort((a, b) => a.level - b.level);
}

/**
 * 10-question Level Challenge targeting a specific Level (1..4).
 * Pulls from BOTH core exercises AND unlocked expansion exercises at that level,
 * prioritizing unattempted -> redemption -> review items.
 */
export function buildLevelChallengeDeck(
  level: AssessmentLevel,
  mastery: Record<string, CompetencyMasteryRecord>,
  count = 10,
  seed = String(Date.now()),
  currentLevel: AssessmentLevel = level,
): AssessmentExercise[] {
  const unlockedBank = getUnlockedAssessmentBank(currentLevel);
  const pool = unlockedBank.filter((ex) => ex.level === level);
  const ordered = deterministicShuffle(pool, `${seed}-lvl-${level}`).sort((a, b) => {
    const bucketDiff = exerciseFreshnessBucket(a, mastery) - exerciseFreshnessBucket(b, mastery);
    if (bucketDiff !== 0) return bucketDiff;
    const compUnmasteredA = (mastery[a.competencyId]?.highestLevel ?? 0) < level ? 0 : 1;
    const compUnmasteredB = (mastery[b.competencyId]?.highestLevel ?? 0) < level ? 0 : 1;
    return compUnmasteredA - compUnmasteredB;
  });
  return ordered.slice(0, Math.min(count, ordered.length));
}

/**
 * Dedicated Higher-Level Expansion Pack deck (Level 2+, 3+, 4+ unlocked questions).
 * Always prioritizes brand-new unmastered expansion exercises at or below currentLevel.
 */
export function buildAdvancedExpansionDeck(
  currentLevel: AssessmentLevel,
  mastery: Record<string, CompetencyMasteryRecord>,
  count = 10,
  seed = String(Date.now()),
): AssessmentExercise[] {
  const unlockedExpansions = ASSESSMENT_EXPANSION_48.filter(
    (ex) => (ex.unlockMinLevel ?? ex.level) <= currentLevel,
  );
  if (unlockedExpansions.length === 0) return [];

  const ordered = deterministicShuffle(unlockedExpansions, `${seed}-exp`).sort((a, b) => {
    const bucketDiff = exerciseFreshnessBucket(a, mastery) - exerciseFreshnessBucket(b, mastery);
    if (bucketDiff !== 0) return bucketDiff;
    // Prefer exercises closest to the student's highest unlocked tier first
    return b.level - a.level;
  });

  return ordered.slice(0, Math.min(count, ordered.length));
}

/**
 * Progressive climb (Level 1 -> Level 4) for one specific competency (1.1 .. 6.3),
 * automatically appending any unlocked higher-level expansion exercises for that competency!
 */
export function buildCompetencyFocusDeck(
  competencyId: string,
  currentLevel: AssessmentLevel = 1,
): AssessmentExercise[] {
  const unlockedBank = getUnlockedAssessmentBank(currentLevel);
  return unlockedBank
    .filter((ex) => ex.competencyId === competencyId)
    .sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      return (a.tier === 'expansion' ? 1 : 0) - (b.tier === 'expansion' ? 1 : 0);
    });
}

/**
 * 8-question Variety Sprint: guarantees a fresh mix of all 5 interactive exercise formats
 * prioritizing unattempted & unlocked higher-level exercises so practice stays rewarding.
 */
export function buildVarietySprintDeck(
  mastery: Record<string, CompetencyMasteryRecord>,
  count = 8,
  seed = String(Date.now()),
  currentLevel: AssessmentLevel = 1,
): AssessmentExercise[] {
  const types: AssessmentExercise['type'][] = [
    'scenario_choice',
    'true_false',
    'order_steps',
    'match_pairs',
    'classify',
  ];

  const unlockedBank = getUnlockedAssessmentBank(currentLevel);

  const scoredPool = deterministicShuffle(unlockedBank, seed).sort((a, b) => {
    const bucketA = exerciseFreshnessBucket(a, mastery);
    const bucketB = exerciseFreshnessBucket(b, mastery);
    if (bucketA !== bucketB) return bucketA - bucketB;

    const recA = mastery[a.competencyId];
    const recB = mastery[b.competencyId];
    const attemptsA = recA?.attempts ?? 0;
    const attemptsB = recB?.attempts ?? 0;
    const targetLevelA = Math.min(4, Math.max(currentLevel, (recA?.highestLevel ?? 0) + 1));
    const targetLevelB = Math.min(4, Math.max(currentLevel, (recB?.highestLevel ?? 0) + 1));
    const distA = Math.abs(a.level - targetLevelA);
    const distB = Math.abs(b.level - targetLevelB);
    return attemptsA * 2 + distA - (attemptsB * 2 + distB);
  });

  const picked: AssessmentExercise[] = [];
  const usedComp = new Set<string>();
  const usedId = new Set<string>();

  // Step 1: guarantee 1 exercise from each of the 5 interactive types
  for (const t of types) {
    const found =
      scoredPool.find(
        (ex) => ex.type === t && !usedId.has(ex.id) && !usedComp.has(ex.competencyId),
      ) ?? scoredPool.find((ex) => ex.type === t && !usedId.has(ex.id));
    if (found) {
      picked.push(found);
      usedId.add(found.id);
      usedComp.add(found.competencyId);
    }
  }

  // Step 2: fill remaining slots with distinct competencies
  for (const ex of scoredPool) {
    if (picked.length >= count) break;
    if (usedId.has(ex.id) || usedComp.has(ex.competencyId)) continue;
    picked.push(ex);
    usedId.add(ex.id);
    usedComp.add(ex.competencyId);
  }

  return deterministicShuffle(picked, `${seed}-mix`);
}

export interface DomainMasterySummary {
  domainId: string;
  totalCompetencies: number;
  masteredCount: number; // highestLevel >= 1
  proficientCount: number; // highestLevel >= 3
  averageLevel: number; // 0 .. 4
  percentComplete: number; // 0 .. 100 based on max 4 levels per competency
}

export function computeDomainMasterySummary(
  mastery: Record<string, CompetencyMasteryRecord>,
): DomainMasterySummary[] {
  return COMPETENCY_DOMAINS.map((domain) => {
    const comps = COMPETENCIES_24.filter((c) => c.domainId === domain.id);
    let levelSum = 0;
    let masteredCount = 0;
    let proficientCount = 0;

    for (const c of comps) {
      const lvl = mastery[c.id]?.highestLevel ?? 0;
      levelSum += lvl;
      if (lvl >= 1) masteredCount += 1;
      if (lvl >= 3) proficientCount += 1;
    }

    const total = comps.length || 1;
    return {
      domainId: domain.id,
      totalCompetencies: comps.length,
      masteredCount,
      proficientCount,
      averageLevel: Number((levelSum / total).toFixed(1)),
      percentComplete: Math.round((levelSum / (total * 4)) * 100),
    };
  });
}

export function getRecommendedCompetencies(
  mastery: Record<string, CompetencyMasteryRecord>,
  limit = 4,
): string[] {
  return [...COMPETENCIES_24]
    .sort((a, b) => {
      const ra = mastery[a.id];
      const rb = mastery[b.id];
      const la = ra?.highestLevel ?? 0;
      const lb = rb?.highestLevel ?? 0;
      if (la !== lb) return la - lb;
      return (ra?.attempts ?? 0) - (rb?.attempts ?? 0);
    })
    .slice(0, limit)
    .map((c) => c.id);
}

export function buildPublicLearnerHonorList(
  profiles: LearnerProfile[],
  awards: TeacherAward[],
  filters?: { schoolName?: string; className?: string },
): PublicLearnerHonorEntry[] {
  const awardsByUid = new Map<string, TeacherAward[]>();
  for (const a of awards) {
    const list = awardsByUid.get(a.learnerUid) ?? [];
    list.push(a);
    awardsByUid.set(a.learnerUid, list);
  }

  const schoolFilter = filters?.schoolName?.trim().toLowerCase() || '';
  const classFilter = filters?.className?.trim().toLowerCase() || '';

  return profiles
    .filter((p) => p.profileCompleted || p.totalExercisesDone > 0)
    .filter((p) => {
      if (schoolFilter && !p.schoolName.toLowerCase().includes(schoolFilter)) return false;
      if (classFilter && !p.className.toLowerCase().includes(classFilter)) return false;
      return true;
    })
    .map((p) => {
      const records = Object.values(p.masteryByCompetency ?? {});
      const masteredCount = records.filter((r) => r.highestLevel >= 1).length;
      const expertCount = records.filter((r) => r.highestLevel >= 3).length;
      const accuracyPercent =
        p.totalExercisesDone > 0
          ? Math.round((p.totalCorrect / p.totalExercisesDone) * 100)
          : 0;
      const learnerAwards = (awardsByUid.get(p.uid) ?? []).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );

      return {
        uid: p.uid,
        fullName: p.fullName,
        className: p.className,
        schoolName: p.schoolName,
        gradeBand: p.gradeBand,
        authType: p.authType,
        currentLevel: p.currentLevel,
        totalXp: p.totalXp,
        masteredCount,
        expertCount,
        accuracyPercent,
        totalExercisesDone: p.totalExercisesDone,
        awardsCount: learnerAwards.length,
        latestBadgeTitle: learnerAwards[0]?.badgeTitle,
        lastActiveAt: p.lastActiveAt,
      };
    })
    .sort((a, b) => {
      if (b.totalXp !== a.totalXp) return b.totalXp - a.totalXp;
      if (b.masteredCount !== a.masteredCount) return b.masteredCount - a.masteredCount;
      return b.accuracyPercent - a.accuracyPercent;
    });
}

/**
 * Deep-sanitizes masteryByCompetency for Firestore (strips undefined values,
 * enforces finite integer bounds and string length limits).
 */
export function sanitizeMasteryForFirestore(
  mastery: Record<string, CompetencyMasteryRecord> | undefined,
): Record<string, CompetencyMasteryRecord> {
  const clean: Record<string, CompetencyMasteryRecord> = {};
  if (!mastery || typeof mastery !== 'object') return clean;

  for (const [rawCompId, rec] of Object.entries(mastery)) {
    if (!rec || typeof rec !== 'object') continue;
    const compId = String(rec.competencyId || rawCompId).trim().slice(0, 16);
    if (!compId) continue;

    const cleanHistory: Record<string, ExerciseAttemptRecord> = {};
    if (rec.exerciseHistory && typeof rec.exerciseHistory === 'object') {
      for (const [rawExId, exRec] of Object.entries(rec.exerciseHistory)) {
        if (!exRec || typeof exRec !== 'object') continue;
        const exId = String(rawExId).trim().slice(0, 64);
        if (!exId) continue;
        cleanHistory[exId] = {
          attempts: Math.max(0, Math.min(10000, Math.round(Number(exRec.attempts) || 0))),
          correctCount: Math.max(0, Math.min(10000, Math.round(Number(exRec.correctCount) || 0))),
          reviewBonusCount: Math.max(
            0,
            Math.min(100, Math.round(Number(exRec.reviewBonusCount) || 0)),
          ),
          lastAttemptAt: String(exRec.lastAttemptAt || rec.lastPracticedAt || new Date().toISOString()).slice(
            0,
            64,
          ),
        };
      }
    }

    const lvlNum = Math.max(0, Math.min(4, Math.round(Number(rec.highestLevel) || 0)));
    clean[compId] = {
      competencyId: compId,
      highestLevel: lvlNum as 0 | AssessmentLevel,
      attempts: Math.max(0, Math.min(100000, Math.round(Number(rec.attempts) || 0))),
      correctCount: Math.max(0, Math.min(100000, Math.round(Number(rec.correctCount) || 0))),
      xp: Math.max(0, Math.min(1000000, Math.round(Number(rec.xp) || 0))),
      lastPracticedAt: String(rec.lastPracticedAt || new Date().toISOString()).slice(0, 64),
      exerciseHistory: cleanHistory,
    };
  }
  return clean;
}

/**
 * Monotonically merges two LearnerProfile snapshots for the same uid so switching devices,
 * reloading a browser, or reconciling Cloud Firestore + local storage NEVER wipes prior
 * 24-competency mastery, per-exercise history, XP, or unlocked levels.
 */
export function mergeLearnerProfiles(
  a: LearnerProfile,
  b: LearnerProfile,
): LearnerProfile {
  const aUpdatedMs = Date.parse(a.updatedAt || a.lastActiveAt || '') || 0;
  const bUpdatedMs = Date.parse(b.updatedAt || b.lastActiveAt || '') || 0;
  const newer = bUpdatedMs >= aUpdatedMs ? b : a;
  const older = bUpdatedMs >= aUpdatedMs ? a : b;

  const masteryA = sanitizeMasteryForFirestore(a.masteryByCompetency);
  const masteryB = sanitizeMasteryForFirestore(b.masteryByCompetency);
  const allCompIds = new Set([...Object.keys(masteryA), ...Object.keys(masteryB)]);
  const mergedMastery: Record<string, CompetencyMasteryRecord> = {};

  for (const cid of allCompIds) {
    const ra = masteryA[cid];
    const rb = masteryB[cid];
    if (ra && !rb) {
      mergedMastery[cid] = ra;
      continue;
    }
    if (rb && !ra) {
      mergedMastery[cid] = rb;
      continue;
    }
    if (!ra || !rb) continue;

    const histA = ra.exerciseHistory ?? {};
    const histB = rb.exerciseHistory ?? {};
    const allExIds = new Set([...Object.keys(histA), ...Object.keys(histB)]);
    const mergedHistory: Record<string, ExerciseAttemptRecord> = {};

    for (const exId of allExIds) {
      const ea = histA[exId];
      const eb = histB[exId];
      if (ea && !eb) {
        mergedHistory[exId] = ea;
      } else if (eb && !ea) {
        mergedHistory[exId] = eb;
      } else if (ea && eb) {
        mergedHistory[exId] = {
          attempts: Math.max(ea.attempts, eb.attempts),
          correctCount: Math.max(ea.correctCount, eb.correctCount),
          reviewBonusCount: Math.max(ea.reviewBonusCount, eb.reviewBonusCount),
          lastAttemptAt:
            ea.lastAttemptAt >= eb.lastAttemptAt ? ea.lastAttemptAt : eb.lastAttemptAt,
        };
      }
    }

    mergedMastery[cid] = {
      competencyId: cid,
      highestLevel: Math.max(ra.highestLevel, rb.highestLevel) as 0 | AssessmentLevel,
      attempts: Math.max(ra.attempts, rb.attempts),
      correctCount: Math.max(ra.correctCount, rb.correctCount),
      xp: Math.max(ra.xp, rb.xp),
      lastPracticedAt:
        ra.lastPracticedAt >= rb.lastPracticedAt ? ra.lastPracticedAt : rb.lastPracticedAt,
      exerciseHistory: mergedHistory,
    };
  }

  const mergedTotalXp = Math.max(a.totalXp || 0, b.totalXp || 0);
  const mergedTotalDone = Math.max(a.totalExercisesDone || 0, b.totalExercisesDone || 0);
  const mergedTotalCorrect = Math.min(
    mergedTotalDone,
    Math.max(a.totalCorrect || 0, b.totalCorrect || 0),
  );
  const mergedBestCombo = Math.max(a.bestCombo || 0, b.bestCombo || 0);
  const computedLevel = computeOverallLevel(mergedMastery, mergedTotalXp);
  const mergedLevel = Math.max(
    a.currentLevel || 1,
    b.currentLevel || 1,
    computedLevel,
  ) as AssessmentLevel;

  const fullName = newer.fullName?.trim() || older.fullName?.trim() || 'Học sinh Công dân số';
  const className = newer.className?.trim() || older.className?.trim() || '';
  const schoolName = newer.schoolName?.trim() || older.schoolName?.trim() || '';

  return {
    uid: newer.uid || older.uid,
    authType: a.authType === 'google' || b.authType === 'google' ? 'google' : newer.authType,
    email: newer.email || older.email,
    photoUrl: newer.photoUrl || older.photoUrl,
    fullName,
    className,
    schoolName,
    gradeBand: newer.gradeBand || older.gradeBand || 'primary',
    role: 'student',
    profileCompleted: Boolean(
      a.profileCompleted ||
        b.profileCompleted ||
        (fullName.length > 0 && className.length > 0 && schoolName.length > 0),
    ),
    currentLevel: mergedLevel,
    totalXp: mergedTotalXp,
    bestCombo: mergedBestCombo,
    totalExercisesDone: mergedTotalDone,
    totalCorrect: mergedTotalCorrect,
    masteryByCompetency: mergedMastery,
    createdAt:
      a.createdAt && b.createdAt
        ? a.createdAt <= b.createdAt
          ? a.createdAt
          : b.createdAt
        : newer.createdAt || older.createdAt,
    updatedAt: newer.updatedAt || older.updatedAt,
    lastActiveAt:
      (a.lastActiveAt || '') >= (b.lastActiveAt || '')
        ? a.lastActiveAt || b.lastActiveAt
        : b.lastActiveAt,
  };
}

export type LearnerActivityStatus = 'today' | 'week' | 'older' | 'not_started';

export function getLearnerActivityStatus(
  learner: Pick<LearnerProfile, 'lastActiveAt' | 'totalExercisesDone'>,
  nowMs = Date.now(),
): LearnerActivityStatus {
  if (!learner.totalExercisesDone || learner.totalExercisesDone <= 0) {
    return 'not_started';
  }
  const activeMs = Date.parse(learner.lastActiveAt || '');
  if (!Number.isFinite(activeMs)) return 'older';
  const diffHours = (nowMs - activeMs) / (1000 * 60 * 60);
  if (diffHours <= 24) return 'today';
  if (diffHours <= 24 * 7) return 'week';
  return 'older';
}

export interface CohortCompetencyStat {
  competencyId: string;
  domainId: string;
  nameVi: string;
  nameEn: string;
  practicedLearners: number;
  masteredLearners: number; // highestLevel >= 1
  expertLearners: number; // highestLevel >= 3
  totalAttempts: number;
  totalCorrect: number;
  accuracyPercent: number;
  masteryRatePercent: number; // masteredLearners / totalLearners * 100
  avgLevel: number;
}

export interface CohortDomainStat {
  domainId: string;
  domainNumber: number;
  nameVi: string;
  nameEn: string;
  avgMasteryRatePercent: number;
  avgLevel: number;
  competencies: CohortCompetencyStat[];
}

export interface CohortCompetencyOverview {
  learnerCount: number;
  activeTodayCount: number;
  activeWeekCount: number;
  avgMasteredCount: number;
  avgAccuracyPercent: number;
  domains: CohortDomainStat[];
  strongestCompetencies: CohortCompetencyStat[];
  weakestCompetencies: CohortCompetencyStat[];
}

/**
 * Aggregates home self-assessment mastery across a cohort of learners for the Teacher
 * 24-competency overview dashboard.
 */
export function buildCohortCompetencyOverview(
  learners: LearnerProfile[],
  nowMs = Date.now(),
): CohortCompetencyOverview {
  const learnerCount = learners.length;
  let activeTodayCount = 0;
  let activeWeekCount = 0;
  let masteredSum = 0;
  let doneSum = 0;
  let correctSum = 0;

  for (const l of learners) {
    const status = getLearnerActivityStatus(l, nowMs);
    if (status === 'today') {
      activeTodayCount += 1;
      activeWeekCount += 1;
    } else if (status === 'week') {
      activeWeekCount += 1;
    }
    const mastered = Object.values(l.masteryByCompetency ?? {}).filter(
      (m) => m.highestLevel >= 1,
    ).length;
    masteredSum += mastered;
    doneSum += l.totalExercisesDone || 0;
    correctSum += l.totalCorrect || 0;
  }

  const allStats: CohortCompetencyStat[] = COMPETENCIES_24.map((c) => {
    let practicedLearners = 0;
    let masteredLearners = 0;
    let expertLearners = 0;
    let totalAttempts = 0;
    let totalCorrect = 0;
    let levelSum = 0;

    for (const l of learners) {
      const rec = l.masteryByCompetency?.[c.id];
      if (!rec) continue;
      if (rec.attempts > 0) practicedLearners += 1;
      if (rec.highestLevel >= 1) masteredLearners += 1;
      if (rec.highestLevel >= 3) expertLearners += 1;
      totalAttempts += rec.attempts || 0;
      totalCorrect += rec.correctCount || 0;
      levelSum += rec.highestLevel || 0;
    }

    return {
      competencyId: c.id,
      domainId: c.domainId,
      nameVi: c.nameVi,
      nameEn: c.nameEn,
      practicedLearners,
      masteredLearners,
      expertLearners,
      totalAttempts,
      totalCorrect,
      accuracyPercent:
        totalAttempts > 0 ? Math.round((totalCorrect / totalAttempts) * 100) : 0,
      masteryRatePercent:
        learnerCount > 0 ? Math.round((masteredLearners / learnerCount) * 100) : 0,
      avgLevel: learnerCount > 0 ? Number((levelSum / learnerCount).toFixed(1)) : 0,
    };
  });

  const domains: CohortDomainStat[] = COMPETENCY_DOMAINS.map((d) => {
    const comps = allStats.filter((s) => s.domainId === d.id);
    const avgMasteryRatePercent =
      comps.length > 0
        ? Math.round(comps.reduce((s, c) => s + c.masteryRatePercent, 0) / comps.length)
        : 0;
    const avgLevel =
      comps.length > 0
        ? Number((comps.reduce((s, c) => s + c.avgLevel, 0) / comps.length).toFixed(1))
        : 0;
    return {
      domainId: d.id,
      domainNumber: d.number,
      nameVi: d.nameVi,
      nameEn: d.nameEn,
      avgMasteryRatePercent,
      avgLevel,
      competencies: comps,
    };
  });

  const practicedStats = allStats.filter((s) => s.practicedLearners > 0);
  const strongestCompetencies = [...practicedStats]
    .sort((a, b) => {
      if (b.masteryRatePercent !== a.masteryRatePercent) {
        return b.masteryRatePercent - a.masteryRatePercent;
      }
      return b.accuracyPercent - a.accuracyPercent;
    })
    .slice(0, 3);

  const weakestCompetencies = [...allStats]
    .sort((a, b) => {
      if (a.masteryRatePercent !== b.masteryRatePercent) {
        return a.masteryRatePercent - b.masteryRatePercent;
      }
      return a.accuracyPercent - b.accuracyPercent;
    })
    .slice(0, 3);

  return {
    learnerCount,
    activeTodayCount,
    activeWeekCount,
    avgMasteredCount:
      learnerCount > 0 ? Number((masteredSum / learnerCount).toFixed(1)) : 0,
    avgAccuracyPercent: doneSum > 0 ? Math.round((correctSum / doneSum) * 100) : 0,
    domains,
    strongestCompetencies,
    weakestCompetencies,
  };
}

export interface HomeHonorNomination {
  categoryId: 'overall_champion' | 'accuracy_star' | 'diligent_learner' | 'expert_pioneer';
  titleVi: string;
  titleEn: string;
  reasonVi: string;
  reasonEn: string;
  suggestedBadgeId: string;
  learner: LearnerProfile;
  metricLabel: string;
}

/**
 * Generates automatic Teacher Honor Nominations so teachers can quickly spot
 * and recognize outstanding home self-assessment students.
 */
export function buildHomeHonorNominations(
  learners: LearnerProfile[],
): HomeHonorNomination[] {
  const active = learners.filter((l) => l.totalExercisesDone > 0 || l.totalXp > 0);
  if (active.length === 0) return [];

  const masteredOf = (l: LearnerProfile) =>
    Object.values(l.masteryByCompetency ?? {}).filter((m) => m.highestLevel >= 1).length;
  const expertOf = (l: LearnerProfile) =>
    Object.values(l.masteryByCompetency ?? {}).filter((m) => m.highestLevel >= 3).length;
  const accOf = (l: LearnerProfile) =>
    l.totalExercisesDone > 0
      ? Math.round((l.totalCorrect / l.totalExercisesDone) * 100)
      : 0;

  const nominations: HomeHonorNomination[] = [];

  // 1. Overall Champion (highest XP / mastered competencies)
  const overall = [...active].sort((a, b) => {
    if (b.totalXp !== a.totalXp) return b.totalXp - a.totalXp;
    return masteredOf(b) - masteredOf(a);
  })[0];
  if (overall) {
    nominations.push({
      categoryId: 'overall_champion',
      titleVi: 'Thủ khoa Tự học 24 Năng lực',
      titleEn: '24-Competency Overall Champion',
      reasonVi: `Dẫn đầu với ${overall.totalXp} XP và mở khóa ${masteredOf(overall)}/24 năng lực thành phần.`,
      reasonEn: `Leading with ${overall.totalXp} XP and ${masteredOf(overall)}/24 competencies unlocked.`,
      suggestedBadgeId: 'master_24',
      learner: overall,
      metricLabel: `${overall.totalXp} XP · ${masteredOf(overall)}/24 NL`,
    });
  }

  // 2. Accuracy Star (highest accuracy among students with >= 4 exercises done)
  const accPool = active.filter((l) => l.totalExercisesDone >= 4);
  const accuracyStar = [...(accPool.length > 0 ? accPool : active)].sort((a, b) => {
    const diff = accOf(b) - accOf(a);
    if (diff !== 0) return diff;
    return b.totalExercisesDone - a.totalExercisesDone;
  })[0];
  if (accuracyStar) {
    nominations.push({
      categoryId: 'accuracy_star',
      titleVi: 'Ngôi sao Chính xác',
      titleEn: 'Precision Star',
      reasonVi: `Đạt độ chính xác ${accOf(accuracyStar)}% qua ${accuracyStar.totalExercisesDone} bài tập tự đánh giá ở nhà.`,
      reasonEn: `Achieved ${accOf(accuracyStar)}% accuracy across ${accuracyStar.totalExercisesDone} home exercises.`,
      suggestedBadgeId: 'safety_shield',
      learner: accuracyStar,
      metricLabel: `${accOf(accuracyStar)}% (${accuracyStar.totalCorrect}/${accuracyStar.totalExercisesDone})`,
    });
  }

  // 3. Most Diligent Home Learner (most exercises done)
  const diligent = [...active].sort((a, b) => {
    if (b.totalExercisesDone !== a.totalExercisesDone) {
      return b.totalExercisesDone - a.totalExercisesDone;
    }
    return b.totalXp - a.totalXp;
  })[0];
  if (diligent) {
    nominations.push({
      categoryId: 'diligent_learner',
      titleVi: 'Ong chăm chỉ Tự học ở nhà',
      titleEn: 'Dedicated Home Learner',
      reasonVi: `Kiên trì hoàn thành ${diligent.totalExercisesDone} bài tập tương tác tại nhà (chuỗi cao nhất x${diligent.bestCombo}).`,
      reasonEn: `Completed ${diligent.totalExercisesDone} interactive home exercises (best streak x${diligent.bestCombo}).`,
      suggestedBadgeId: 'home_diligent',
      learner: diligent,
      metricLabel: `${diligent.totalExercisesDone} bài · Combo x${diligent.bestCombo}`,
    });
  }

  // 4. Expert Pioneer (highest level / most L3-L4 skills)
  const pioneer = [...active].sort((a, b) => {
    if (b.currentLevel !== a.currentLevel) return b.currentLevel - a.currentLevel;
    const expDiff = expertOf(b) - expertOf(a);
    if (expDiff !== 0) return expDiff;
    return b.totalXp - a.totalXp;
  })[0];
  if (pioneer && (pioneer.currentLevel >= 2 || expertOf(pioneer) > 0)) {
    nominations.push({
      categoryId: 'expert_pioneer',
      titleVi: 'Tiên phong Cấp độ Cao',
      titleEn: 'Advanced Level Pioneer',
      reasonVi: `Đạt Cấp ${pioneer.currentLevel}/4 với ${expertOf(pioneer)} năng lực đạt mức Thành thạo – Chuyên gia.`,
      reasonEn: `Reached Level ${pioneer.currentLevel}/4 with ${expertOf(pioneer)} proficient/expert skills.`,
      suggestedBadgeId: 'ai_explorer',
      learner: pioneer,
      metricLabel: `Cấp ${pioneer.currentLevel}/4 · ${expertOf(pioneer)} NL cao`,
    });
  }

  return nominations;
}

