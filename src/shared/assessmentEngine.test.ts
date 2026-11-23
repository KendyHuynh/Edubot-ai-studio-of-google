import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSESSMENT_BANK_96,
  ASSESSMENT_BANK_ALL,
  ASSESSMENT_EXPANSION_48,
} from './assessmentBank';
import { COMPETENCIES_24, COMPETENCY_DOMAINS } from './competencies';
import {
  applyAssessmentOutcomesDetailed,
  applyAssessmentOutcomesToProfile,
  buildAdvancedExpansionDeck,
  buildCompetencyFocusDeck,
  buildDiagnosticDeck,
  buildLevelChallengeDeck,
  buildPublicLearnerHonorList,
  buildVarietySprintDeck,
  calculateExerciseXpWithRetryPolicy,
  createEmptyLearnerProfile,
  getExerciseBaseXp,
  getExpansionUnlockSummary,
  getUnlockedAssessmentBank,
  gradeAssessmentExercise,
  shuffleStepsNonTrivial,
} from './assessmentEngine';

test('ASSESSMENT_BANK_96 covers all 24 TT 02/2025 competencies across all 4 levels (96 exercises)', () => {
  assert.equal(ASSESSMENT_BANK_96.length, 96);

  const uniqueIds = new Set(ASSESSMENT_BANK_96.map((e) => e.id));
  assert.equal(uniqueIds.size, 96);

  for (const comp of COMPETENCIES_24) {
    for (const lvl of [1, 2, 3, 4] as const) {
      const matches = ASSESSMENT_BANK_96.filter(
        (e) => e.competencyId === comp.id && e.level === lvl,
      );
      assert.equal(
        matches.length,
        1,
        `Expected 1 exercise for competency ${comp.id} at level ${lvl}, found ${matches.length}`,
      );
    }
  }

  // Ensure all 5 interactive exercise types are substantially represented
  const byType = new Map<string, number>();
  for (const ex of ASSESSMENT_BANK_96) {
    byType.set(ex.type, (byType.get(ex.type) ?? 0) + 1);
  }
  for (const t of ['scenario_choice', 'true_false', 'order_steps', 'match_pairs', 'classify']) {
    assert.ok((byType.get(t) ?? 0) >= 10, `Expected at least 10 exercises of type ${t}`);
  }
});

test('gradeAssessmentExercise accurately grades all 5 interactive exercise mechanics', () => {
  const mc = ASSESSMENT_BANK_96.find((e) => e.type === 'scenario_choice')!;
  assert.equal(gradeAssessmentExercise(mc, { selectedOption: mc.correctOption }).isCorrect, true);
  assert.equal(gradeAssessmentExercise(mc, { selectedOption: 'wrong' }).isCorrect, false);

  const tf = ASSESSMENT_BANK_96.find((e) => e.type === 'true_false')!;
  assert.equal(gradeAssessmentExercise(tf, { selectedBool: tf.isTrue }).isCorrect, true);
  assert.equal(gradeAssessmentExercise(tf, { selectedBool: !tf.isTrue }).isCorrect, false);

  const ord = ASSESSMENT_BANK_96.find((e) => e.type === 'order_steps')!;
  assert.equal(gradeAssessmentExercise(ord, { orderedSteps: ord.steps }).isCorrect, true);
  assert.equal(
    gradeAssessmentExercise(ord, { orderedSteps: [...(ord.steps ?? [])].reverse() }).isCorrect,
    false,
  );
  const shuffled = shuffleStepsNonTrivial(ord.steps!, ord.id);
  assert.equal(shuffled.length, ord.steps!.length);
  assert.equal(
    shuffled.every((s, idx) => s === ord.steps![idx]),
    false,
  );

  const match = ASSESSMENT_BANK_96.find((e) => e.type === 'match_pairs')!;
  const goodMap = Object.fromEntries((match.pairs ?? []).map((p) => [p.id, p.right]));
  assert.equal(gradeAssessmentExercise(match, { matchedPairs: goodMap }).isCorrect, true);
  const badMap = { ...goodMap, [match.pairs![0].id]: 'wrong' };
  assert.equal(gradeAssessmentExercise(match, { matchedPairs: badMap }).isCorrect, false);

  const cls = ASSESSMENT_BANK_96.find((e) => e.type === 'classify')!;
  const goodCls = Object.fromEntries((cls.classifyItems ?? []).map((i) => [i.id, i.category]));
  assert.equal(gradeAssessmentExercise(cls, { classifiedMap: goodCls }).isCorrect, true);
  const badCls = {
    ...goodCls,
    [cls.classifyItems![0].id]: cls.classifyItems![0].category === 'safe' ? 'risk' : 'safe',
  } as Record<string, 'safe' | 'risk'>;
  assert.equal(gradeAssessmentExercise(cls, { classifiedMap: badCls }).isCorrect, false);
});

test('deck builders produce balanced, multi-format decks and update learner mastery & honor list cleanly', () => {
  const diag = buildDiagnosticDeck('test-seed');
  assert.equal(diag.length, 12);

  const focus = buildCompetencyFocusDeck('4.2');
  assert.deepEqual(
    focus.map((e) => e.level),
    [1, 2, 3, 4],
  );

  const profile = createEmptyLearnerProfile({
    uid: 'learner-1',
    authType: 'google',
    email: 'student1@example.com',
    fullName: 'Nguyễn Minh Khôi',
    className: '5A',
    schoolName: 'TH Nguyễn Du',
    gradeBand: 'primary',
  });

  const sprint = buildVarietySprintDeck(profile.masteryByCompetency, 8, 'sprint-1');
  assert.equal(sprint.length, 8);
  const sprintTypes = new Set(sprint.map((e) => e.type));
  assert.equal(sprintTypes.size, 5, 'Variety sprint should include all 5 interactive types');

  const lvl2 = buildLevelChallengeDeck(2, profile.masteryByCompetency, 10, 'l2');
  assert.equal(lvl2.length, 10);
  assert.ok(lvl2.every((e) => e.level === 2));

  const updated = applyAssessmentOutcomesToProfile(
    profile,
    [
      { exerciseId: 'ex-4.2-l1', competencyId: '4.2', level: 1, type: 'scenario_choice', isCorrect: true, xpEarned: 25 },
      { exerciseId: 'ex-4.2-l2', competencyId: '4.2', level: 2, type: 'scenario_choice', isCorrect: true, xpEarned: 40 },
      { exerciseId: 'ex-6.1-l3', competencyId: '6.1', level: 3, type: 'scenario_choice', isCorrect: true, xpEarned: 60 },
      { exerciseId: 'ex-1.1-l2', competencyId: '1.1', level: 2, type: 'match_pairs', isCorrect: true, xpEarned: 40 },
      { exerciseId: 'ex-1.2-l2', competencyId: '1.2', level: 2, type: 'classify', isCorrect: true, xpEarned: 40 },
      { exerciseId: 'ex-2.1-l2', competencyId: '2.1', level: 2, type: 'match_pairs', isCorrect: true, xpEarned: 40 },
      { exerciseId: 'ex-3.3-l2', competencyId: '3.3', level: 2, type: 'match_pairs', isCorrect: true, xpEarned: 40 },
    ],
    7,
  );

  assert.equal(updated.totalXp, 285);
  assert.equal(updated.bestCombo, 7);
  assert.equal(updated.masteryByCompetency['4.2'].highestLevel, 2);
  assert.equal(updated.masteryByCompetency['6.1'].highestLevel, 3);
  assert.equal(updated.currentLevel, 2);

  // Honor list must never expose email PII
  const honor = buildPublicLearnerHonorList([updated], []);
  assert.equal(honor.length, 1);
  assert.equal(honor[0].fullName, 'Nguyễn Minh Khôi');
  assert.equal(honor[0].schoolName, 'TH Nguyễn Du');
  assert.equal('email' in honor[0], false);
});

test('ASSESSMENT_EXPANSION_48 adds 48 unique higher-level exercises (12 L2+, 18 L3+, 18 L4+) across all 6 domains and 5 formats', () => {
  assert.equal(ASSESSMENT_EXPANSION_48.length, 48);
  assert.equal(ASSESSMENT_BANK_ALL.length, 144);

  const allIds = new Set(ASSESSMENT_BANK_ALL.map((e) => e.id));
  assert.equal(allIds.size, 144);

  const l2 = ASSESSMENT_EXPANSION_48.filter((e) => e.level === 2);
  const l3 = ASSESSMENT_EXPANSION_48.filter((e) => e.level === 3);
  const l4 = ASSESSMENT_EXPANSION_48.filter((e) => e.level === 4);
  assert.equal(l2.length, 12);
  assert.equal(l3.length, 18);
  assert.equal(l4.length, 18);

  // Every expansion item has tier='expansion', valid competencyId, and valid unlockMinLevel
  const validCompIds = new Set(COMPETENCIES_24.map((c) => c.id));
  for (const ex of ASSESSMENT_EXPANSION_48) {
    assert.equal(ex.tier, 'expansion');
    assert.equal(ex.unlockMinLevel, ex.level);
    assert.ok(validCompIds.has(ex.competencyId), `Unknown competencyId: ${ex.competencyId}`);

    // Verify each expansion item is cleanly gradeable
    if (ex.type === 'scenario_choice') {
      assert.equal(gradeAssessmentExercise(ex, { selectedOption: ex.correctOption }).isCorrect, true);
    } else if (ex.type === 'true_false') {
      assert.equal(gradeAssessmentExercise(ex, { selectedBool: ex.isTrue }).isCorrect, true);
    } else if (ex.type === 'order_steps') {
      assert.equal(gradeAssessmentExercise(ex, { orderedSteps: ex.steps }).isCorrect, true);
    } else if (ex.type === 'match_pairs') {
      const m = Object.fromEntries((ex.pairs ?? []).map((p) => [p.id, p.right]));
      assert.equal(gradeAssessmentExercise(ex, { matchedPairs: m }).isCorrect, true);
    } else if (ex.type === 'classify') {
      const c = Object.fromEntries((ex.classifyItems ?? []).map((i) => [i.id, i.category]));
      assert.equal(gradeAssessmentExercise(ex, { classifiedMap: c }).isCorrect, true);
    }
  }

  // All 6 domains & all 5 interactive formats represented in expansion bank
  const domainCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const ex of ASSESSMENT_EXPANSION_48) {
    const comp = COMPETENCIES_24.find((c) => c.id === ex.competencyId)!;
    domainCounts.set(comp.domainId, (domainCounts.get(comp.domainId) ?? 0) + 1);
    typeCounts.set(ex.type, (typeCounts.get(ex.type) ?? 0) + 1);
  }
  for (const d of COMPETENCY_DOMAINS) {
    assert.equal(domainCounts.get(d.id), 8, `Expected 8 expansion exercises in domain ${d.id}`);
  }
  for (const t of ['scenario_choice', 'true_false', 'order_steps', 'match_pairs', 'classify']) {
    assert.ok((typeCounts.get(t) ?? 0) >= 5, `Expected >=5 expansion items of type ${t}`);
  }
});

test('calculateExerciseXpWithRetryPolicy enforces all 6 anti-farming retry tiers and expansion challenge bonuses', () => {
  // Expansion base XP: L2+=50, L3+=75, L4+=105
  assert.equal(getExerciseBaseXp(2, 'core'), 40);
  assert.equal(getExerciseBaseXp(2, 'expansion'), 50);
  assert.equal(getExerciseBaseXp(3, 'expansion'), 75);
  assert.equal(getExerciseBaseXp(4, 'expansion'), 105);

  // 1. First-try mastery (100% + combo bonus when streak >= 3)
  const firstCore = calculateExerciseXpWithRetryPolicy({
    level: 2,
    tier: 'core',
    isCorrect: true,
    nextCombo: 3,
  });
  assert.equal(firstCore.retryTier, 'first_mastery');
  assert.equal(firstCore.multiplierPercent, 100);
  assert.equal(firstCore.xpEarned, 50); // 40 + 10 combo

  const firstExp = calculateExerciseXpWithRetryPolicy({
    level: 4,
    tier: 'expansion',
    isCorrect: true,
    nextCombo: 1,
  });
  assert.equal(firstExp.retryTier, 'first_mastery');
  assert.equal(firstExp.xpEarned, 105);

  // 2. Wrong attempt on first try (+5 effort XP) vs repeated wrong (0 XP)
  const firstWrong = calculateExerciseXpWithRetryPolicy({
    level: 2,
    isCorrect: false,
  });
  assert.equal(firstWrong.retryTier, 'first_attempt_effort');
  assert.equal(firstWrong.xpEarned, 5);

  const repeatWrong = calculateExerciseXpWithRetryPolicy({
    level: 2,
    isCorrect: false,
    priorRecord: { attempts: 1, correctCount: 0, reviewBonusCount: 0, lastAttemptAt: '' },
  });
  assert.equal(repeatWrong.retryTier, 'repeat_wrong_no_xp');
  assert.equal(repeatWrong.xpEarned, 0);

  // 3. Redemption mastery (previously wrong, now correct -> 80% XP + 5 combo)
  const redemption = calculateExerciseXpWithRetryPolicy({
    level: 2,
    isCorrect: true,
    nextCombo: 3,
    priorRecord: { attempts: 1, correctCount: 0, reviewBonusCount: 0, lastAttemptAt: '' },
  });
  assert.equal(redemption.retryTier, 'redemption_mastery');
  assert.equal(redemption.multiplierPercent, 80);
  assert.equal(redemption.xpEarned, 37); // Math.round(40 * 0.8) = 32 + 5 combo

  // 4. First spaced review (already mastered once -> 25% XP, no combo)
  const review1 = calculateExerciseXpWithRetryPolicy({
    level: 2,
    isCorrect: true,
    nextCombo: 5,
    priorRecord: { attempts: 1, correctCount: 1, reviewBonusCount: 0, lastAttemptAt: '' },
  });
  assert.equal(review1.retryTier, 'review_bonus');
  assert.equal(review1.multiplierPercent, 25);
  assert.equal(review1.xpEarned, 10); // Math.round(40 * 0.25) = 10, combo=0

  // 5. Repeated review (already mastered + review bonus claimed -> 0 XP)
  const review2 = calculateExerciseXpWithRetryPolicy({
    level: 2,
    isCorrect: true,
    nextCombo: 5,
    priorRecord: { attempts: 2, correctCount: 2, reviewBonusCount: 1, lastAttemptAt: '' },
  });
  assert.equal(review2.retryTier, 'practice_no_xp');
  assert.equal(review2.xpEarned, 0);
});

test('applyAssessmentOutcomesDetailed authoritatively caps spoofed repeat XP and tracks exerciseHistory', () => {
  const base = createEmptyLearnerProfile({
    uid: 'u-cap',
    authType: 'google',
    email: 'cap@example.com',
    fullName: 'Lê Minh Thư',
    className: '6A',
    schoolName: 'THCS Chu Văn An',
    gradeBand: 'middle',
  });

  // Session 1: Correct on ex-1.1-l2 (40 XP), Wrong on ex-4.2-l2 (+5 effort XP)
  const s1 = applyAssessmentOutcomesDetailed(
    base,
    [
      { exerciseId: 'ex-1.1-l2', competencyId: '1.1', level: 2, type: 'match_pairs', isCorrect: true, xpEarned: 40 },
      { exerciseId: 'ex-4.2-l2', competencyId: '4.2', level: 2, type: 'scenario_choice', isCorrect: false, xpEarned: 5 },
    ],
    1,
  );
  assert.equal(s1.xpAdded, 45);
  assert.equal(s1.normalizedOutcomes[0].retryTier, 'first_mastery');
  assert.equal(s1.normalizedOutcomes[1].retryTier, 'first_attempt_effort');

  // Session 2: Student spoofs full XP (999) on repeat of ex-1.1-l2 -> capped to 25% (10 XP)
  // and fixes ex-4.2-l2 -> capped to 80% redemption (32 XP)
  const s2 = applyAssessmentOutcomesDetailed(
    s1.profile,
    [
      { exerciseId: 'ex-1.1-l2', competencyId: '1.1', level: 2, type: 'match_pairs', isCorrect: true, xpEarned: 999 },
      { exerciseId: 'ex-4.2-l2', competencyId: '4.2', level: 2, type: 'scenario_choice', isCorrect: true, xpEarned: 999 },
    ],
    2,
  );
  assert.equal(s2.normalizedOutcomes[0].retryTier, 'review_bonus');
  assert.equal(s2.normalizedOutcomes[0].xpEarned, 10);
  assert.equal(s2.normalizedOutcomes[1].retryTier, 'redemption_mastery');
  assert.equal(s2.normalizedOutcomes[1].xpEarned, 32);
  assert.equal(s2.xpAdded, 42);

  // Session 3: Repeating ex-1.1-l2 a 3rd time yields 0 XP (pure practice mode) even if client sends 40 XP
  const s3 = applyAssessmentOutcomesDetailed(
    s2.profile,
    [
      { exerciseId: 'ex-1.1-l2', competencyId: '1.1', level: 2, type: 'match_pairs', isCorrect: true, xpEarned: 40 },
    ],
    1,
  );
  assert.equal(s3.normalizedOutcomes[0].retryTier, 'practice_no_xp');
  assert.equal(s3.normalizedOutcomes[0].xpEarned, 0);
  assert.equal(s3.xpAdded, 0);
  assert.equal(s3.profile.totalXp, 87);
});

test('progressive level unlocking expands bank 96 -> 108 -> 126 -> 144 and prioritizes fresh expansion items', () => {
  assert.equal(getUnlockedAssessmentBank(1).length, 96);
  assert.equal(getUnlockedAssessmentBank(2).length, 108);
  assert.equal(getUnlockedAssessmentBank(3).length, 126);
  assert.equal(getUnlockedAssessmentBank(4).length, 144);

  const summaryL1 = getExpansionUnlockSummary(1, {});
  assert.equal(summaryL1.unlockedExpansionCount, 0);
  assert.equal(summaryL1.totalUnlockedBankSize, 96);

  const summaryL3 = getExpansionUnlockSummary(3, {});
  assert.equal(summaryL3.unlockedExpansionCount, 30); // 12 (L2+) + 18 (L3+)
  assert.equal(summaryL3.totalUnlockedBankSize, 126);
  assert.deepEqual(
    summaryL3.packs.map((p) => p.unlocked),
    [true, true, false],
  );

  // Level 1 has 0 unlocked expansion exercises
  assert.equal(buildAdvancedExpansionDeck(1, {}, 10, 'seed1').length, 0);

  // Level 2 unlocks 12 expansion exercises -> deck returns 10 L2+ items
  const deckL2 = buildAdvancedExpansionDeck(2, {}, 10, 'seed2');
  assert.equal(deckL2.length, 10);
  assert.ok(deckL2.every((e) => e.tier === 'expansion' && e.level === 2));

  // If we mark the first 2 items as already mastered + reviewed, they drop to the end behind fresh ones
  const masteredIds = new Set([deckL2[0].id, deckL2[1].id]);
  const mastery = {
    [deckL2[0].competencyId]: {
      competencyId: deckL2[0].competencyId,
      highestLevel: 2 as const,
      attempts: 2,
      correctCount: 2,
      xp: 60,
      lastPracticedAt: '2026-11-22T00:00:00Z',
      exerciseHistory: {
        [deckL2[0].id]: { attempts: 2, correctCount: 2, reviewBonusCount: 1, lastAttemptAt: '2026-11-22T00:00:00Z' },
      },
    },
    [deckL2[1].competencyId]: {
      competencyId: deckL2[1].competencyId,
      highestLevel: 2 as const,
      attempts: 2,
      correctCount: 2,
      xp: 60,
      lastPracticedAt: '2026-11-22T00:00:00Z',
      exerciseHistory: {
        [deckL2[1].id]: { attempts: 2, correctCount: 2, reviewBonusCount: 1, lastAttemptAt: '2026-11-22T00:00:00Z' },
      },
    },
  };
  const freshDeck = buildAdvancedExpansionDeck(2, mastery, 10, 'seed2');
  // Since there are 12 L2+ exercises and 2 were mastered, the top 10 fresh ones should exclude both masteredIds!
  assert.equal(
    freshDeck.some((e) => masteredIds.has(e.id)),
    false,
    'Deck builder should prioritize all 10 unattempted expansion items ahead of already-mastered ones',
  );
});
