import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLocalApi, loadLocalStore, saveLocalStore, StorageLike } from './localStoreApi';
import { hashPinWebCrypto } from './pinCrypto';
import { PRIMARY_ADMIN_EMAIL } from '../shared/seedData';

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

async function seedAuthenticatedTeacherToken(
  storage: StorageLike,
  pin = 'GiaoVien#2026',
): Promise<string> {
  const store = loadLocalStore(storage);
  store.adminSecurity = {
    pinHash: await hashPinWebCrypto(pin),
    adminOnlyMode: false,
    adminEmails: [PRIMARY_ADMIN_EMAIL],
    tokenVersion: 1,
  };
  saveLocalStore(store, storage);
  const loginRes = await handleLocalApi(
    '/api/teacher/verify-pin',
    { method: 'POST', body: JSON.stringify({ pin }) },
    storage,
  );
  assert.equal(loginRes.ok, true);
  return (loginRes.data as { token: string }).token;
}

test('localStoreApi strips correctAnswer without teacher token and blocks anonymous PIN setup on static host', async () => {
  const storage = createMemoryStorage();
  const statusRes = await handleLocalApi('/api/teacher/auth-status', { method: 'GET' }, storage);
  assert.equal(statusRes.ok, true);
  const statusData = statusRes.data as { adminOnlyMode: boolean; canFirstRunSetup: boolean };
  assert.equal(statusData.adminOnlyMode, true);
  assert.equal(statusData.canFirstRunSetup, false);

  // Unauthenticated caller requesting role=teacher still gets NO answers
  const spoofedRes = await handleLocalApi(
    '/api/bootstrap?classId=LOP-5A&lang=vi&role=teacher',
    { method: 'GET' },
    storage,
  );
  assert.equal(spoofedRes.ok, true);
  const spoofedData = spoofedRes.data as {
    lessons: { questions: { correctAnswer?: string }[] }[];
  };
  assert.equal(spoofedData.lessons[0].questions.length, 15);
  assert.equal(spoofedData.lessons[0].questions[0].correctAnswer, undefined);

  // Unauthenticated teacher mutation is rejected with 401
  const unauthCreate = await handleLocalApi(
    '/api/classes',
    { method: 'POST', body: JSON.stringify({ id: 'LOP-X', name: 'Hack' }) },
    storage,
  );
  assert.equal(unauthCreate.status, 401);

  // Authenticated teacher receives correctAnswer
  const token = await seedAuthenticatedTeacherToken(storage);
  const teacherRes = await handleLocalApi(
    '/api/bootstrap?classId=LOP-5A&lang=vi&role=teacher',
    { method: 'GET', authToken: token },
    storage,
  );
  const teacherData = teacherRes.data as {
    lessons: { questions: { correctAnswer?: string }[] }[];
  };
  assert.ok(teacherData.lessons[0].questions[0].correctAnswer);
});

test('localStoreApi grades student quiz submission without login and updates leaderboard', async () => {
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

test('localStoreApi supports authenticated classroom CRUD, PIN rotation, and token invalidation', async () => {
  const storage = createMemoryStorage();
  const oldToken = await seedAuthenticatedTeacherToken(storage, 'OldSecret#99');

  const createRes = await handleLocalApi(
    '/api/classes',
    {
      method: 'POST',
      authToken: oldToken,
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

  // Weak PIN '2025' is rejected
  const weakChange = await handleLocalApi(
    '/api/teacher/change-pin',
    {
      method: 'POST',
      authToken: oldToken,
      body: JSON.stringify({ currentPin: 'OldSecret#99', newPin: '2025' }),
    },
    storage,
  );
  assert.equal(weakChange.ok, false);
  assert.equal(weakChange.status, 400);

  // Strong PIN rotation succeeds and invalidates oldToken
  const goodChange = await handleLocalApi(
    '/api/teacher/change-pin',
    {
      method: 'POST',
      authToken: oldToken,
      body: JSON.stringify({ currentPin: 'OldSecret#99', newPin: 'NewSecret#2026' }),
    },
    storage,
  );
  assert.equal(goodChange.ok, true);
  const newToken = (goodChange.data as { token: string }).token;

  const staleExport = await handleLocalApi(
    '/api/workspace/export',
    { method: 'GET', authToken: oldToken },
    storage,
  );
  assert.equal(staleExport.status, 401);

  const freshExport = await handleLocalApi(
    '/api/workspace/export',
    { method: 'GET', authToken: newToken },
    storage,
  );
  assert.equal(freshExport.ok, true);
});
