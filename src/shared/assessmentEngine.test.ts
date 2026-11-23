import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSESSMENT_BANK_96 } from './assessmentBank';
import { COMPETENCIES_24 } from './competencies';
import {
  applyAssessmentOutcomesToProfile,
  buildCompetencyFocusDeck,
  buildDiagnosticDeck,
  buildLevelChallengeDeck,
  buildPublicLearnerHonorList,
  buildVarietySprintDeck,
  createEmptyLearnerProfile,
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
