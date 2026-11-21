import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublicSubmissionRestFields,
  DEFAULT_PUBLIC_WORKSPACE_ID,
  fromFirestoreRestValue,
  LEGACY_FALLBACK_WORKSPACE_ID,
  mergeLatestSubmissions,
  mergeSubmissionActivityLogs,
  normalizeClassCode,
  resolveCandidateWorkspaceIds,
  sanitizeLessonFieldsForFirestore,
  toFirestoreDocId,
  toFirestoreRestValue,
} from './firestoreHelpers';
import { AnswerSubmission, Lesson } from '../shared/types';

test('toFirestoreDocId strips Vietnamese diacritics and invalid chars', () => {
  assert.equal(toFirestoreDocId('LỚP-8A'), 'LOP-8A');
  assert.equal(toFirestoreDocId('Đội Sao Đỏ #1'), 'Doi-Sao-Do-1');
  assert.equal(toFirestoreDocId('lesson-123_abc'), 'lesson-123_abc');
});

test('normalizeClassCode produces uppercase ASCII class IDs', () => {
  assert.equal(normalizeClassCode('Lớp 6B'), 'LOP-6B');
  assert.equal(normalizeClassCode('  đội-tuyển_9a '), 'DOI-TUYEN_9A');
});

test('resolveCandidateWorkspaceIds prioritizes requested ws, then default, then legacy fallback', () => {
  assert.deepEqual(resolveCandidateWorkspaceIds(null), [
    DEFAULT_PUBLIC_WORKSPACE_ID,
    LEGACY_FALLBACK_WORKSPACE_ID,
  ]);
  assert.deepEqual(resolveCandidateWorkspaceIds('WS-CUSTOM123'), [
    'WS-CUSTOM123',
    DEFAULT_PUBLIC_WORKSPACE_ID,
    LEGACY_FALLBACK_WORKSPACE_ID,
  ]);
  // Invalid path-traversal / junk characters are ignored
  assert.deepEqual(resolveCandidateWorkspaceIds('../evil/path'), [
    DEFAULT_PUBLIC_WORKSPACE_ID,
    LEGACY_FALLBACK_WORKSPACE_ID,
  ]);
});

test('sanitizeLessonFieldsForFirestore removes undefined options on fill_blank and keeps 15+ questions', () => {
  const sampleLesson: Lesson = {
    id: 'lesson-test',
    title: 'An toàn số',
    topic: 'Công dân số',
    sourceFileName: 'test.txt',
    summary: 'Tóm tắt',
    assignedClassIds: ['LOP-8A'],
    createdAt: '2026-01-01T00:00:00.000Z',
    questions: Array.from({ length: 15 }, (_, idx) => ({
      id: `q-${idx + 1}`,
      type: idx % 2 === 0 ? 'multiple_choice' : 'fill_blank',
      questionText: `Câu ${idx + 1}`,
      options: idx % 2 === 0 ? ['A', 'B', 'C', 'D'] : undefined,
      aiSearchKeywordHint: 'từ khóa',
      correctAnswer: 'A',
      competencyId: '4.2',
      competencyIds: ['4.2'],
      explanation: 'Giải thích',
    })),
  };

  const sanitized = sanitizeLessonFieldsForFirestore(sampleLesson, 'lesson-test');
  assert.equal(sanitized.questions.length, 15);
  assert.deepEqual(sanitized.questions[0].options, ['A', 'B', 'C', 'D']);
  assert.equal('options' in sanitized.questions[1], false);
});

test('toFirestoreRestValue and fromFirestoreRestValue round-trip nested data cleanly', () => {
  const original = {
    id: 'LOP-8A',
    count: 15,
    ratio: 0.75,
    active: true,
    empty: null,
    tags: ['4.2', '6.2'],
    nested: { label: 'Công dân số' },
  };
  const encoded = toFirestoreRestValue(original);
  const decoded = fromFirestoreRestValue(encoded);
  assert.deepEqual(decoded, original);
});

test('buildPublicSubmissionRestFields clamps numeric bounds and matches firestore.rules keys', () => {
  const sub: AnswerSubmission = {
    id: 'sub-test-1',
    classId: 'LOP-8A',
    groupId: 'Máy-03 · Hải Âu',
    tabletNumber: 99, // should clamp to 10
    groupName: 'Hải Âu',
    lessonId: 'lesson-1',
    lessonTitle: 'Giao tiếp số',
    questionId: 'q1',
    competencyId: '2.1',
    competencyIds: ['2.1'],
    userAnswer: 'A',
    isCorrect: true,
    basePoints: 100,
    speedBonus: 5000, // should clamp to 1000
    totalPoints: 9999, // should clamp to 2000
    elapsedMs: -50, // should clamp to 0
    submittedAt: '2026-11-21T10:00:00.000Z',
    feedbackText: 'Tốt lắm!',
    explanation: 'Giải thích chuẩn.',
    syncedFromOffline: false,
  };

  const { docId, fields } = buildPublicSubmissionRestFields('default', sub);
  assert.equal(docId, 'sub-test-1');
  const decoded = fromFirestoreRestValue({ mapValue: { fields } }) as Record<string, unknown>;
  assert.equal(decoded.workspaceId, 'default');
  assert.equal(decoded.tabletNumber, 10);
  assert.equal(decoded.speedBonus, 1000);
  assert.equal(decoded.totalPoints, 2000);
  assert.equal(decoded.elapsedMs, 0);
  assert.equal('createdAt' in decoded, false); // injected by server REQUEST_TIME transform
});

test('mergeLatestSubmissions deduplicates by team+question keeping newest and synthesizes activity logs', () => {
  const older: AnswerSubmission = {
    id: 'sub-old',
    classId: 'LOP-8A',
    groupId: 'Máy-01 · Sao Xanh',
    tabletNumber: 1,
    groupName: 'Sao Xanh',
    lessonId: 'lesson-1',
    lessonTitle: 'Bài 1',
    questionId: 'q1',
    competencyId: '2.1',
    userAnswer: 'B',
    isCorrect: false,
    basePoints: 0,
    speedBonus: 0,
    totalPoints: 0,
    elapsedMs: 9000,
    submittedAt: '2026-11-21T08:00:00.000Z',
    feedbackText: 'Thử lại',
    explanation: 'Tip',
  };
  const newer: AnswerSubmission = {
    ...older,
    id: 'sub-new',
    userAnswer: 'A',
    isCorrect: true,
    basePoints: 100,
    speedBonus: 40,
    totalPoints: 140,
    submittedAt: '2026-11-21T08:05:00.000Z',
  };

  const merged = mergeLatestSubmissions([older], [newer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'sub-new');
  assert.equal(merged[0].totalPoints, 140);

  const logs = mergeSubmissionActivityLogs([], merged);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].classId, 'LOP-8A');
  assert.equal(logs[0].pointsDelta, 140);
});
