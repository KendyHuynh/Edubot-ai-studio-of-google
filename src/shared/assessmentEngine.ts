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
