import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleLocalApi,
  loadLocalStore,
  resetLocalHydrationCache,
  saveLocalStore,
  StorageLike,
} from './localStoreApi';
import { hashPinWebCrypto } from './pinCrypto';
import { PRIMARY_ADMIN_EMAIL } from '../shared/seedData';
import { toFirestoreRestValue } from './firestoreHelpers';

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function withMockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
    resetLocalHydrationCache();
  });
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
  await withMockFetch(
    () => new Response(JSON.stringify({}), { status: 404 }),
    async () => {
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
    },
  );
});

test('localStoreApi replaces seed classes with published default Firestore workspace for zero-login students and uploads submissions', async () => {
  const committedPayloads: Array<Record<string, unknown>> = [];

  await withMockFetch(
    (url, init) => {
      if (url.includes('/publicWorkspaces/default?') && (!init?.method || init.method === 'GET')) {
        const docFields = toFirestoreRestValue({
          id: 'default',
          classes: [
            {
              id: 'LOP-8A',
              name: 'Lớp 8A - AI Công Dân Số',
              grade: 'Khối 8',
              teacherName: 'Huỳnh Như Ý',
              createdAt: '2026-11-20T00:00:00.000Z',
            },
          ],
          lessons: [
            {
              id: 'lesson-8a-live',
              title: 'Giao tiếp số an toàn',
              topic: 'Công dân số 8',
              sourceFileName: 'bai8.txt',
              summary: 'Bài học thật của cô Ý',
              assignedClassIds: ['LOP-8A'],
              createdAt: '2026-11-20T00:00:00.000Z',
              questions: [
                {
                  id: 'q1-live',
                  type: 'multiple_choice',
                  questionText: 'Nên làm gì khi gặp tin giả?',
                  options: ['Kiểm chứng nguồn tin', 'Chia sẻ ngay'],
                  aiSearchKeywordHint: 'kiểm chứng tin giả',
                  correctAnswer: 'Kiểm chứng nguồn tin',
                  competencyId: '1.2',
                  competencyIds: ['1.2'],
                  explanation: 'Luôn kiểm chứng nguồn tin trước khi chia sẻ.',
                },
              ],
            },
          ],
        }).mapValue?.fields;
        return new Response(JSON.stringify({ fields: docFields }), { status: 200 });
      }
      if (url.includes(':runQuery')) {
        return new Response(JSON.stringify([{ readTime: '2026-11-21T00:00:00Z' }]), { status: 200 });
      }
      if (url.includes(':commit') && init?.method === 'POST') {
        committedPayloads.push(JSON.parse(String(init.body ?? '{}')));
        return new Response(JSON.stringify({ writeResults: [{}] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    },
    async () => {
      resetLocalHydrationCache();
      const storage = createMemoryStorage();
      // Fresh Incognito student opens root URL with NO ?ws= param
      const bootRes = await handleLocalApi('/api/bootstrap?lang=vi&role=student', { method: 'GET' }, storage);
      assert.equal(bootRes.ok, true);
      const boot = bootRes.data as {
        classes: { id: string }[];
        lessons: { id: string; questions: { correctAnswer?: string }[] }[];
      };

      // Seed classes (LOP-5A, LOP-5B, LOP-6A) MUST be completely replaced by teacher's LOP-8A!
      assert.deepEqual(
        boot.classes.map((c) => c.id),
        ['LOP-8A'],
      );
      assert.equal(boot.lessons.length, 1);
      assert.equal(boot.lessons[0].id, 'lesson-8a-live');
      assert.equal(boot.lessons[0].questions[0].correctAnswer, undefined);

      // Student submits answer with ZERO login -> graded locally AND committed to Firestore publicSubmissions
      const submitRes = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-8A',
            tabletNumber: 3,
            groupName: 'Hải Âu',
            lessonId: 'lesson-8a-live',
            questionId: 'q1-live',
            userAnswer: 'Kiểm chứng nguồn tin',
            elapsedMs: 4200,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(submitRes.ok, true);
      const submitData = submitRes.data as {
        submission: { isCorrect: boolean; totalPoints: number };
        leaderboard: { GroupID: string }[];
      };
      assert.equal(submitData.submission.isCorrect, true);
      assert.ok(submitData.submission.totalPoints >= 100);
      assert.ok(submitData.leaderboard.some((r) => r.GroupID.includes('Hải Âu')));
      assert.equal(committedPayloads.length, 1);
    },
  );
});

test('localStoreApi supports authenticated classroom CRUD, PIN rotation, and token invalidation', async () => {
  await withMockFetch(
    () => new Response(JSON.stringify({}), { status: 404 }),
    async () => {
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
    },
  );
});
