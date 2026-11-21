import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalApi, StorageLike } from './localStoreApi';

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

test('localStoreApi bootstrap seeds 15-question lessons and strips correctAnswer for students', async () => {
  const storage = createMemoryStorage();
  const studentRes = await handleLocalApi(
    '/api/bootstrap?classId=LOP-5A&lang=vi&role=student',
    { method: 'GET' },
    storage,
  );
  assert.equal(studentRes.ok, true);
  const studentData = studentRes.data as {
    classes: { id: string }[];
    lessons: { questions: { correctAnswer?: string }[] }[];
  };
  assert.ok(studentData.classes.length >= 3);
  assert.equal(studentData.lessons[0].questions.length, 15);
  assert.equal(studentData.lessons[0].questions[0].correctAnswer, undefined);

  const teacherRes = await handleLocalApi(
    '/api/bootstrap?classId=LOP-5A&lang=vi&role=teacher',
    { method: 'GET' },
    storage,
  );
  const teacherData = teacherRes.data as {
    lessons: { questions: { correctAnswer?: string }[] }[];
  };
  assert.ok(teacherData.lessons[0].questions[0].correctAnswer);
});

test('localStoreApi grades student quiz submission and updates leaderboard', async () => {
  const storage = createMemoryStorage();
  const submitRes = await handleLocalApi(
    '/api/quiz/submit',
    {
      method: 'POST',
      body: JSON.stringify({
        classId: 'LOP-5A',
        tabletNumber: 7,
        groupName: 'GitHub Stars',
        lessonId: 'lesson-safety-netiquette',
        questionId: 'q1-pw',
        userAnswer: 'SaoXanh#5A@2026!',
        elapsedMs: 6500,
        lang: 'vi',
      }),
    },
    storage,
  );
  assert.equal(submitRes.ok, true);
  const payload = submitRes.data as {
    submission: { isCorrect: boolean; totalPoints: number };
    leaderboard: { GroupID: string }[];
  };
  assert.equal(payload.submission.isCorrect, true);
  assert.ok(payload.submission.totalPoints >= 100);
  assert.ok(payload.leaderboard.some((row) => row.GroupID.includes('GitHub Stars')));
});

test('localStoreApi supports full classroom CRUD and workspace export/import', async () => {
  const storage = createMemoryStorage();
  const createRes = await handleLocalApi(
    '/api/classes',
    {
      method: 'POST',
      body: JSON.stringify({
        id: 'LOP-7C',
        name: 'Lớp 7C GitHub Pages',
        grade: 'Khối 7',
        teacherName: 'Cô Ý',
      }),
    },
    storage,
  );
  assert.equal(createRes.ok, true);

  const exportRes = await handleLocalApi('/api/workspace/export', { method: 'GET' }, storage);
  assert.equal(exportRes.ok, true);
  const exported = exportRes.data as { classes: { id: string }[]; lessons: unknown[] };
  assert.ok(exported.classes.some((c) => c.id === 'LOP-7C'));

  const freshStorage = createMemoryStorage();
  const importRes = await handleLocalApi(
    '/api/workspace/import',
    { method: 'POST', body: JSON.stringify(exported) },
    freshStorage,
  );
  assert.equal(importRes.ok, true);
  const verifyRes = await handleLocalApi('/api/bootstrap?role=teacher', { method: 'GET' }, freshStorage);
  const verified = verifyRes.data as { classes: { id: string }[] };
  assert.ok(verified.classes.some((c) => c.id === 'LOP-7C'));
});
