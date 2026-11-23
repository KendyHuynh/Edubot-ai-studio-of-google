import { ASSESSMENT_BANK_96, ASSESSMENT_LEVELS } from './assessmentBank';
import { COMPETENCIES_24, COMPETENCY_DOMAINS } from './competencies';
import {
  AssessmentExercise,
  AssessmentExerciseOutcome,
  AssessmentLevel,
  CompetencyMasteryRecord,
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

export function applyAssessmentOutcomesToProfile(
  profile: LearnerProfile,
  outcomes: AssessmentExerciseOutcome[],
  maxCombo: number,
): LearnerProfile {
  const now = new Date().toISOString();
  const nextMastery: Record<string, CompetencyMasteryRecord> = {
    ...profile.masteryByCompetency,
  };

  let addedXp = 0;
  let addedCorrect = 0;

  for (const out of outcomes) {
    const prev = nextMastery[out.competencyId] ?? {
      competencyId: out.competencyId,
      highestLevel: 0 as const,
      attempts: 0,
      correctCount: 0,
      xp: 0,
      lastPracticedAt: now,
    };

    const nextHighest = out.isCorrect
      ? (Math.max(prev.highestLevel, out.level) as 0 | AssessmentLevel)
      : prev.highestLevel;

    nextMastery[out.competencyId] = {
      competencyId: out.competencyId,
      highestLevel: nextHighest,
      attempts: prev.attempts + 1,
      correctCount: prev.correctCount + (out.isCorrect ? 1 : 0),
      xp: prev.xp + Math.max(0, Math.round(out.xpEarned)),
      lastPracticedAt: now,
    };

    addedXp += Math.max(0, Math.round(out.xpEarned));
    if (out.isCorrect) addedCorrect += 1;
  }

  const nextTotalXp = profile.totalXp + addedXp;
  const computedLevel = computeOverallLevel(nextMastery, nextTotalXp);

  return {
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
}

/**
 * 12-question Diagnostic Quick Test covering ALL 6 domains (2 per domain),
 * spanning Levels 1..4 and mixing all 5 interactive exercise types.
 */
export function buildDiagnosticDeck(seed = 'diag'): AssessmentExercise[] {
  const picked: AssessmentExercise[] = [];
  const usedIds = new Set<string>();

  for (const domain of COMPETENCY_DOMAINS) {
    const domainComps = COMPETENCIES_24.filter((c) => c.domainId === domain.id);
    const domainPool = ASSESSMENT_BANK_96.filter((ex) =>
      domainComps.some((c) => c.id === ex.competencyId),
    );
    const shuffled = deterministicShuffle(domainPool, `${seed}-${domain.id}`);

    // Pick 1 foundational (L1 or L2) and 1 advanced (L3 or L4) with distinct competencies when possible
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

  // Sort progressively from Level 1 to Level 4 so the test feels like an engaging climb
  return picked.sort((a, b) => a.level - b.level);
}

/**
 * 10-question Level Challenge targeting a specific Level (1..4), prioritizing competencies
 * the student hasn't yet mastered at that level.
 */
export function buildLevelChallengeDeck(
  level: AssessmentLevel,
  mastery: Record<string, CompetencyMasteryRecord>,
  count = 10,
  seed = String(Date.now()),
): AssessmentExercise[] {
  const pool = ASSESSMENT_BANK_96.filter((ex) => ex.level === level);
  const unmastered = pool.filter(
    (ex) => (mastery[ex.competencyId]?.highestLevel ?? 0) < level,
  );
  const mastered = pool.filter(
    (ex) => (mastery[ex.competencyId]?.highestLevel ?? 0) >= level,
  );
  const ordered = [
    ...deterministicShuffle(unmastered, `${seed}-u`),
    ...deterministicShuffle(mastered, `${seed}-m`),
  ];
  return ordered.slice(0, Math.min(count, ordered.length));
}

/**
 * 4-question progressive climb (Level 1 -> Level 4) for one specific competency (1.1 .. 6.3).
 */
export function buildCompetencyFocusDeck(competencyId: string): AssessmentExercise[] {
  return ASSESSMENT_BANK_96.filter((ex) => ex.competencyId === competencyId).sort(
    (a, b) => a.level - b.level,
  );
}

/**
 * 8-question Variety Sprint: guarantees a fresh mix of all 5 interactive exercise formats
 * prioritizing the student's least-practiced competencies so practice never feels repetitive.
 */
export function buildVarietySprintDeck(
  mastery: Record<string, CompetencyMasteryRecord>,
  count = 8,
  seed = String(Date.now()),
): AssessmentExercise[] {
  const types: AssessmentExercise['type'][] = [
    'scenario_choice',
    'true_false',
    'order_steps',
    'match_pairs',
    'classify',
  ];

  // Score each exercise: prefer less-practiced competencies and next attainable level
  const scoredPool = deterministicShuffle(ASSESSMENT_BANK_96, seed).sort((a, b) => {
    const recA = mastery[a.competencyId];
    const recB = mastery[b.competencyId];
    const attemptsA = recA?.attempts ?? 0;
    const attemptsB = recB?.attempts ?? 0;
    const targetLevelA = Math.min(4, (recA?.highestLevel ?? 0) + 1);
    const targetLevelB = Math.min(4, (recB?.highestLevel ?? 0) + 1);
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
