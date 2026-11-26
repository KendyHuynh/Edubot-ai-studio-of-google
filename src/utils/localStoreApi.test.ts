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

      // Fresh store starts completely clean with ZERO virtual demo classes (no LOP-5A/5B/6A!)
      const freshBoot = await handleLocalApi('/api/bootstrap?lang=vi&role=student', { method: 'GET' }, storage);
      assert.equal((freshBoot.data as { classes: unknown[] }).classes.length, 0);

      // Unauthenticated teacher mutation is rejected with 401
      const unauthCreate = await handleLocalApi(
        '/api/classes',
        { method: 'POST', body: JSON.stringify({ id: 'LOP-X', name: 'Hack' }) },
        storage,
      );
      assert.equal(unauthCreate.status, 401);

      // Authenticated teacher creates a real class & lesson
      const token = await seedAuthenticatedTeacherToken(storage);
      await handleLocalApi(
        '/api/sync/cloud-hydrate',
        {
          method: 'POST',
          authToken: token,
          body: JSON.stringify({
            authoritativeCloud: true,
            classes: [
              { id: 'LOP-8A', name: 'Lớp 8A Thực tế', grade: 'Khối 8', teacherName: 'Cô Ý', createdAt: '2026-11-22T00:00:00Z' },
            ],
            lessons: [
              {
                id: 'lesson-real-1',
                title: 'Bài 1 Thực tế',
                topic: 'An toàn số',
                sourceFileName: 'Bai1.txt',
                summary: 'Tóm tắt',
                assignedClassIds: ['LOP-8A'],
                createdAt: '2026-11-22T00:00:00Z',
                questions: [
                  {
                    id: 'q-real-1',
                    type: 'multiple_choice',
                    questionText: 'Mật khẩu mạnh là gì?',
                    options: ['1234', 'SaoXanh#8A@2026!'],
                    aiSearchKeywordHint: 'mật khẩu mạnh',
                    correctAnswer: 'SaoXanh#8A@2026!',
                    competencyId: '4.2',
                    explanation: 'Cần chữ hoa, chữ thường, số và ký tự đặc biệt.',
                  },
                ],
              },
            ],
          }),
        },
        storage,
      );

      // Unauthenticated caller requesting role=teacher still gets NO answers
      const spoofedRes = await handleLocalApi(
        '/api/bootstrap?classId=LOP-8A&lang=vi&role=teacher',
        { method: 'GET' },
        storage,
      );
      assert.equal(spoofedRes.ok, true);
      const spoofedData = spoofedRes.data as {
        lessons: { questions: { correctAnswer?: string }[] }[];
      };
      assert.equal(spoofedData.lessons[0].questions.length, 1);
      assert.equal(spoofedData.lessons[0].questions[0].correctAnswer, undefined);

      // Authenticated teacher receives correctAnswer
      const teacherRes = await handleLocalApi(
        '/api/bootstrap?classId=LOP-8A&lang=vi&role=teacher',
        { method: 'GET', authToken: token },
        storage,
      );
      const teacherData = teacherRes.data as {
        lessons: { questions: { correctAnswer?: string }[] }[];
      };
      assert.equal(teacherData.lessons[0].questions[0].correctAnswer, 'SaoXanh#8A@2026!');
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

test('localStoreApi auto-heals stripped correctAnswer="" from Firestore so SaoXanh#5A@2026! is graded correct with full points', async () => {
  await withMockFetch(
    (url, init) => {
      if (url.includes('/publicWorkspaces/default?') && (!init?.method || init.method === 'GET')) {
        const docFields = toFirestoreRestValue({
          id: 'default',
          classes: [
            {
              id: 'LOP-8A',
              name: 'Lớp 8A',
              grade: 'Khối 8',
              teacherName: 'Cô Ý',
              createdAt: '2026-11-20T00:00:00.000Z',
            },
          ],
          lessons: [
            {
              id: 'lesson-safety-netiquette',
              title: 'Bài 1: Bảo vệ dữ liệu & Ứng xử văn minh trên mạng',
              topic: 'An toàn & Ứng xử',
              sourceFileName: 'Bai1.txt',
              summary: 'Tóm tắt',
              assignedClassIds: ['LOP-8A'],
              createdAt: '2026-11-20T00:00:00.000Z',
              questions: [
                {
                  id: 'q1-pw',
                  type: 'multiple_choice',
                  questionText:
                    'Khi lập tài khoản học tập trực tuyến, lựa chọn mật khẩu nào sau đây giúp bảo vệ dữ liệu cá nhân tốt nhất?',
                  options: [
                    '12345678',
                    'ngay_sinh_cua_em_2015',
                    'SaoXanh#5A@2026!',
                    'matkhau',
                  ],
                  aiSearchKeywordHint: 'Cách đặt mật khẩu mạnh an toàn thông tin học sinh',
                  correctAnswer: '',
                  competencyId: '4.2',
                  competencyIds: ['4.2'],
                  explanation:
                    'Mật khẩu mạnh cần kết hợp chữ hoa, chữ thường, chữ số và ký tự đặc biệt.',
                },
              ],
            },
            {
              id: 'lesson-1794902362895',
              title: 'GIAO TIẾP VÀ HỢP TÁC HIỆU QUẢ TRONG MÔI TRƯỜNG SỐ',
              topic: 'Giao tiếp số',
              sourceFileName: 'BaiGiaoTiep.txt',
              summary: 'Tóm tắt',
              assignedClassIds: ['LOP-8A'],
              createdAt: '2026-11-20T00:00:00.000Z',
              questions: [
                {
                  id: 'q-1794902362895-2',
                  type: 'multiple_choice',
                  questionText: 'Công cụ họp trực tuyến và soạn thảo nhóm?',
                  options: ['Paint', 'Google Meet và Google Docs', 'Calculator', 'Notepad'],
                  aiSearchKeywordHint: 'Google Meet Google Docs',
                  correctAnswer: '',
                  competencyId: '2.2',
                  competencyIds: ['2.2'],
                  explanation: 'Google Meet và Google Docs hỗ trợ hợp tác nhóm trực tuyến.',
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
        return new Response(JSON.stringify({ writeResults: [{}] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    },
    async () => {
      resetLocalHydrationCache();
      const storage = createMemoryStorage();
      const bootRes = await handleLocalApi('/api/bootstrap?lang=vi&role=student', { method: 'GET' }, storage);
      assert.equal(bootRes.ok, true);

      // Submit exact correct answer for q1-pw
      const sub1 = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-8A',
            tabletNumber: 2,
            groupName: 'Tia Chớp',
            lessonId: 'lesson-safety-netiquette',
            questionId: 'q1-pw',
            userAnswer: 'SaoXanh#5A@2026!',
            elapsedMs: 3500,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(sub1.ok, true);
      const d1 = sub1.data as { submission: { isCorrect: boolean; totalPoints: number } };
      assert.equal(d1.submission.isCorrect, true);
      assert.ok(d1.submission.totalPoints >= 100, `Expected >=100 points, got ${d1.submission.totalPoints}`);

      // Submit exact correct answer for teacher's custom lesson q-1794902362895-2
      const sub2 = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-8A',
            tabletNumber: 2,
            groupName: 'Tia Chớp',
            lessonId: 'lesson-1794902362895',
            questionId: 'q-1794902362895-2',
            userAnswer: 'Google Meet và Google Docs',
            elapsedMs: 4000,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(sub2.ok, true);
      const d2 = sub2.data as { submission: { isCorrect: boolean; totalPoints: number } };
      assert.equal(d2.submission.isCorrect, true);
      assert.ok(d2.submission.totalPoints >= 100);
    },
  );
});

test('localStoreApi preserves locally generated AI lessons on cloud-hydrate and grades fill_blank deterministically with 20s full bonus', async () => {
  await withMockFetch(
    () => new Response(JSON.stringify({}), { status: 404 }),
    async () => {
      const storage = createMemoryStorage();
      const token = await seedAuthenticatedTeacherToken(storage);

      // Import a newly AI-generated lesson locally with pipe-separated accepted answers
      const aiLesson = {
        id: 'lesson-1799888777666',
        title: 'Bài AI: Xác thực 2 bước',
        topic: 'Bảo mật số',
        sourceFileName: 'BaiAI.txt',
        summary: 'Tạo bởi AI và ghi nhớ lâu dài',
        assignedClassIds: ['LOP-5A'],
        createdAt: '2026-11-21T08:00:00.000Z',
        questions: [
          {
            id: 'q-ai-blank-1',
            type: 'fill_blank',
            questionText: 'Tính năng bảo mật cần thêm mã OTP ngoài mật khẩu gọi là gì?',
            aiSearchKeywordHint: 'xác thực 2 bước 2FA',
            correctAnswer: '2FA|xác thực 2 bước|xác thực hai yếu tố',
            competencyId: '4.2',
            competencyIds: ['4.2'],
            explanation: '2FA (xác thực 2 bước) bảo vệ tài khoản ngay cả khi lộ mật khẩu.',
          },
        ],
      };

      const importRes = await handleLocalApi(
        '/api/workspace/import',
        {
          method: 'POST',
          authToken: token,
          body: JSON.stringify({ classes: [], lessons: [aiLesson] }),
        },
        storage,
      );
      assert.equal(importRes.ok, true);

      // Cloud hydrate arrives WITHOUT the newly created local AI lesson -> MUST preserve it!
      const hydrateRes = await handleLocalApi(
        '/api/sync/cloud-hydrate',
        {
          method: 'POST',
          authToken: token,
          body: JSON.stringify({
            classes: [],
            lessons: [
              {
                id: 'lesson-cloud-older',
                title: 'Bài cũ trên đám mây',
                topic: 'Cũ',
                sourceFileName: 'old.txt',
                summary: 'Cũ',
                assignedClassIds: ['LOP-5A'],
                createdAt: '2026-11-01T00:00:00.000Z',
                questions: [
                  {
                    id: 'q-old-1',
                    type: 'multiple_choice',
                    questionText: 'Câu cũ?',
                    options: ['Đúng', 'Sai'],
                    aiSearchKeywordHint: 'câu cũ',
                    correctAnswer: 'Đúng',
                    competencyId: '1.1',
                    competencyIds: ['1.1'],
                    explanation: 'Đúng.',
                  },
                ],
              },
            ],
          }),
        },
        storage,
      );
      assert.equal(hydrateRes.ok, true);

      const storeAfterHydrate = loadLocalStore(storage);
      assert.ok(
        storeAfterHydrate.lessons.some((l) => l.id === 'lesson-1799888777666'),
        'Local AI lesson must survive cloud-hydrate',
      );
      assert.ok(
        storeAfterHydrate.lessons.some((l) => l.id === 'lesson-cloud-older'),
        'Cloud lesson must also be present',
      );

      // Student submits diacritic-free variant of fill_blank at 19s -> instant non-AI match + full 20s speed bonus (+50)
      const subRes = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-5A',
            tabletNumber: 4,
            groupName: 'Sao Băng',
            lessonId: 'lesson-1799888777666',
            questionId: 'q-ai-blank-1',
            userAnswer: 'xac thuc 2 buoc',
            elapsedMs: 19000,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(subRes.ok, true);
      const subData = subRes.data as {
        submission: {
          isCorrect: boolean;
          basePoints: number;
          speedBonus: number;
          totalPoints: number;
        };
      };
      assert.equal(subData.submission.isCorrect, true);
      assert.equal(subData.submission.basePoints, 100);
      assert.equal(subData.submission.speedBonus, 50);
      assert.equal(subData.submission.totalPoints, 150);
    },
  );
});

test('localStoreApi replaces starter 5A/5B/6A demo seed classes with real Firestore classes even on authenticated teacher bootstrap', async () => {
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
            {
              id: 'LOP-8B',
              name: 'Lớp 8B - AI Công Dân Số',
              grade: 'Khối 8',
              teacherName: 'Huỳnh Như Ý',
              createdAt: '2026-11-20T00:00:00.000Z',
            },
          ],
          lessons: [],
        }).mapValue?.fields;
        return new Response(JSON.stringify({ fields: docFields }), { status: 200 });
      }
      if (url.includes(':runQuery')) {
        return new Response(JSON.stringify([{ readTime: '2026-11-21T00:00:00Z' }]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    },
    async () => {
      resetLocalHydrationCache();
      const storage = createMemoryStorage();
      const token = await seedAuthenticatedTeacherToken(storage);

      // Authenticated teacher opens portal on a freshly reset store (which temporarily holds 5A/5B/6A seed)
      const bootRes = await handleLocalApi(
        '/api/bootstrap?lang=vi&role=teacher',
        { method: 'GET', authToken: token },
        storage,
      );
      assert.equal(bootRes.ok, true);
      const boot = bootRes.data as {
        classes: { id: string }[];
        notifications: { id: string }[];
      };
      assert.deepEqual(
        boot.classes.map((c) => c.id),
        ['LOP-8A', 'LOP-8B'],
      );
      assert.equal(
        boot.notifications.some((n) => n.id.startsWith('notif-seed-')),
        false,
        'Demo 5A/5B notifications must be removed when real classes load',
      );
    },
  );
});

test('localStoreApi enforces class isolation (403 cross-class), 1st-attempt lock, groupProgress, and teacher grade override', async () => {
  await withMockFetch(
    () => new Response(JSON.stringify({}), { status: 404 }),
    async () => {
      const storage = createMemoryStorage();
      const token = await seedAuthenticatedTeacherToken(storage);

      // Seed 2 classes (LOP-8A, LOP-8B) and 1 lesson assigned ONLY to LOP-8A
      await handleLocalApi(
        '/api/workspace/import',
        {
          method: 'POST',
          authToken: token,
          body: JSON.stringify({
            classes: [
              { id: 'LOP-8A', name: 'Lớp 8A', grade: 'Khối 8', teacherName: 'Cô Ý', createdAt: '2026-11-20T00:00:00Z' },
              { id: 'LOP-8B', name: 'Lớp 8B', grade: 'Khối 8', teacherName: 'Cô Ý', createdAt: '2026-11-20T00:00:00Z' },
            ],
            lessons: [
              {
                id: 'lesson-only-8a',
                title: 'Bài riêng 8A',
                topic: 'An toàn số',
                sourceFileName: '8a.txt',
                summary: 'Chỉ dành cho 8A',
                assignedClassIds: ['LOP-8A'],
                createdAt: '2026-11-20T00:00:00Z',
                questions: [
                  {
                    id: 'q-8a-1',
                    type: 'fill_blank',
                    questionText: 'Tính năng bảo mật 2 lớp gọi là gì?',
                    aiSearchKeywordHint: '2FA',
                    correctAnswer: 'xác thực 2 bước',
                    competencyId: '4.2',
                    competencyIds: ['4.2'],
                    explanation: '2FA bảo vệ tài khoản.',
                  },
                ],
              },
            ],
          }),
        },
        storage,
      );

      // 1) Student in LOP-8B does NOT see lesson-only-8a on bootstrap
      const boot8B = await handleLocalApi(
        '/api/bootstrap?classId=LOP-8B&lang=vi&role=student',
        { method: 'GET' },
        storage,
      );
      const lessons8B = (boot8B.data as { lessons: { id: string }[] }).lessons;
      assert.equal(lessons8B.some((l) => l.id === 'lesson-only-8a'), false);

      // 2) Student in LOP-8B attempting to submit to lesson-only-8a gets HTTP 403
      const crossClassSubmit = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-8B',
            tabletNumber: 1,
            groupName: 'Nhóm 8B',
            lessonId: 'lesson-only-8a',
            questionId: 'q-8a-1',
            userAnswer: '2FA',
            elapsedMs: 5000,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(crossClassSubmit.ok, false);
      assert.equal(crossClassSubmit.status, 403);

      // 3) Student in LOP-8A submits wrong answer on 1st attempt -> recorded with 0 pts
      const firstAttempt = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-8A',
            tabletNumber: 2,
            groupName: 'Nhóm 1',
            lessonId: 'lesson-only-8a',
            questionId: 'q-8a-1',
            userAnswer: 'câu trả lời gần đúng cần xem lại',
            elapsedMs: 10000,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(firstAttempt.ok, true);
      const firstData = firstAttempt.data as {
        submission: { id: string; isCorrect: boolean; totalPoints: number; userAnswer: string };
        alreadySubmitted: boolean;
      };
      assert.equal(firstData.alreadySubmitted, false);
      assert.equal(firstData.submission.isCorrect, false);
      assert.equal(firstData.submission.totalPoints, 0);
      assert.equal(firstData.submission.userAnswer, 'câu trả lời gần đúng cần xem lại');

      // 4) Same group retries with exact right answer -> 1st attempt stays locked (alreadySubmitted = true)
      const secondAttempt = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-8A',
            tabletNumber: 2,
            groupName: 'Nhóm 1',
            lessonId: 'lesson-only-8a',
            questionId: 'q-8a-1',
            userAnswer: 'xác thực 2 bước',
            elapsedMs: 4000,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(secondAttempt.ok, true);
      const secondData = secondAttempt.data as {
        submission: { isCorrect: boolean; totalPoints: number };
        alreadySubmitted: boolean;
      };
      assert.equal(secondData.alreadySubmitted, true);
      assert.equal(secondData.submission.totalPoints, 0);

      // 5) Bootstrap returns groupProgress showing Nhóm 1 answered q-8a-1
      const boot8A = await handleLocalApi(
        `/api/bootstrap?classId=LOP-8A&groupId=${encodeURIComponent('Máy-02 · Nhóm 1')}&lang=vi&role=student`,
        { method: 'GET' },
        storage,
      );
      const gp = (boot8A.data as { groupProgress: Record<string, { answeredQuestionIds: string[] }> }).groupProgress;
      assert.deepEqual(gp['lesson-only-8a']?.answeredQuestionIds, ['q-8a-1']);

      // 6) Unauthenticated caller CANNOT override grades (401)
      const unauthOverride = await handleLocalApi(
        `/api/submissions/${encodeURIComponent(firstData.submission.id)}/override`,
        { method: 'POST', body: JSON.stringify({ isCorrect: true }) },
        storage,
      );
      assert.equal(unauthOverride.status, 401);

      // 7) Teacher manually accepts the archived answer -> points & class leaderboard update immediately!
      const overrideRes = await handleLocalApi(
        `/api/submissions/${encodeURIComponent(firstData.submission.id)}/override`,
        {
          method: 'POST',
          authToken: token,
          body: JSON.stringify({ isCorrect: true }),
        },
        storage,
      );
      assert.equal(overrideRes.ok, true);
      const overrideData = overrideRes.data as {
        submission: { isCorrect: boolean; totalPoints: number };
        leaderboard: { GroupID: string; Score: number }[];
      };
      assert.equal(overrideData.submission.isCorrect, true);
      assert.equal(overrideData.submission.totalPoints, 150);
      assert.equal(overrideData.leaderboard[0]?.Score, 150);
    },
  );
});

test('localStoreApi supports personal 24-competency self-assessment, Google profile onboarding, PII isolation, and teacher awards', async () => {
  const storage = createMemoryStorage();
  await withMockFetch(
    async (input, init) => {
      const url = String(input);
      if (url.includes('identitytoolkit.googleapis.com/v1/accounts:lookup')) {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { idToken?: string };
        if (parsed.idToken === 'student-google-token') {
          return new Response(
            JSON.stringify({
              users: [
                {
                  localId: 'uid-student-an',
                  email: 'minhan.student@gmail.com',
                  emailVerified: true,
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (parsed.idToken === 'admin-google-token') {
          return new Response(
            JSON.stringify({
              users: [
                {
                  localId: 'uid-admin-teacher',
                  email: 'huynh.nhu.y1601@gmail.com',
                  emailVerified: true,
                },
              ],
            }),
            { status: 200 },
          );
        }
      }
      return new Response(JSON.stringify({}), { status: 404 });
    },
    async () => {
      // 1) Profile requires fullName, className, and schoolName
      const badProfile = await handleLocalApi(
        '/api/learners/profile',
        {
          method: 'POST',
          body: JSON.stringify({ idToken: 'student-google-token', fullName: 'Minh An' }),
        },
        storage,
      );
      assert.equal(badProfile.status, 400);

      // 2) Student Google onboarding succeeds with Name + Class + School
      const goodProfile = await handleLocalApi(
        '/api/learners/profile',
        {
          method: 'POST',
          body: JSON.stringify({
            idToken: 'student-google-token',
            fullName: 'Trần Minh An',
            className: '5A',
            schoolName: 'TH Nguyễn Du',
            gradeBand: 'primary',
          }),
        },
        storage,
      );
      assert.equal(goodProfile.ok, true);
      const profData = goodProfile.data as {
        profile: { uid: string; role: string; email: string; profileCompleted: boolean };
      };
      assert.equal(profData.profile.uid, 'uid-student-an');
      assert.equal(profData.profile.role, 'student');
      assert.equal(profData.profile.profileCompleted, true);

      // 3) Student Google account is STILL strictly rejected from Teacher Admin Portal!
      const studentTryAdmin = await handleLocalApi(
        '/api/teacher/verify-google',
        { method: 'POST', body: JSON.stringify({ idToken: 'student-google-token' }) },
        storage,
      );
      assert.equal(studentTryAdmin.ok, false);

      // 4) Unauthenticated caller CANNOT read Google student's profile or teacher learner list
      const unauthMe = await handleLocalApi(
        '/api/learners/me?uid=uid-student-an',
        { method: 'GET' },
        storage,
      );
      assert.equal(unauthMe.status, 401);

      const unauthTeacherList = await handleLocalApi(
        '/api/teacher/learners',
        { method: 'GET' },
        storage,
      );
      assert.equal(unauthTeacherList.status, 401);

      // 5) Student submits self-assessment session
      const submitRes = await handleLocalApi(
        '/api/learners/assessment-submit',
        {
          method: 'POST',
          body: JSON.stringify({
            idToken: 'student-google-token',
            mode: 'variety_sprint',
            maxCombo: 4,
            outcomes: [
              { exerciseId: 'ex-1.1-l1', competencyId: '1.1', level: 1, type: 'scenario_choice', isCorrect: true, xpEarned: 25 },
              { exerciseId: 'ex-4.2-l2', competencyId: '4.2', level: 2, type: 'scenario_choice', isCorrect: true, xpEarned: 40 },
              { exerciseId: 'ex-6.2-l3', competencyId: '6.2', level: 3, type: 'true_false', isCorrect: true, xpEarned: 60 },
            ],
          }),
        },
        storage,
      );
      assert.equal(submitRes.ok, true);
      const subData = submitRes.data as { profile: { totalXp: number } };
      assert.equal(subData.profile.totalXp, 125);

      // 6) Teacher authenticates and sends a reward badge (+100 XP)
      const adminAuth = await handleLocalApi(
        '/api/teacher/verify-google',
        { method: 'POST', body: JSON.stringify({ idToken: 'admin-google-token' }) },
        storage,
      );
      assert.equal(adminAuth.ok, true);
      const adminToken = (adminAuth.data as { token: string }).token;

      const awardRes = await handleLocalApi(
        '/api/teacher/awards',
        {
          method: 'POST',
          authToken: adminToken,
          body: JSON.stringify({
            learnerUid: 'uid-student-an',
            badgeId: 'star-self-learner',
            badgeTitle: 'Ngôi sao Tự học Xuất sắc',
            message: 'Cô rất khen ngợi tinh thần tự học của An!',
            bonusXp: 100,
          }),
        },
        storage,
      );
      assert.equal(awardRes.status, 201);

      // 7) Public Honor Board includes student + award count + updated XP (225) WITHOUT exposing email
      const honorRes = await handleLocalApi('/api/learners/honor', { method: 'GET' }, storage);
      assert.equal(honorRes.ok, true);
      const entries = (honorRes.data as { entries: Array<Record<string, unknown>> }).entries;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].fullName, 'Trần Minh An');
      assert.equal(entries[0].schoolName, 'TH Nguyễn Du');
      assert.equal(entries[0].totalXp, 225);
      assert.equal(entries[0].awardsCount, 1);
      assert.equal('email' in entries[0], false);
    },
  );
});

test('localStoreApi awards partial credit for fuzzy fill_blank near-match and allows teacher upgrade to 100%', async () => {
  await withMockFetch(
    () => new Response(JSON.stringify({}), { status: 404 }),
    async () => {
      const storage = createMemoryStorage();
      const token = await seedAuthenticatedTeacherToken(storage);

      await handleLocalApi(
        '/api/workspace/import',
        {
          method: 'POST',
          authToken: token,
          body: JSON.stringify({
            classes: [
              { id: 'LOP-9A', name: 'Lớp 9A', grade: 'Khối 9', teacherName: 'Cô Ý', createdAt: '2026-11-22T00:00:00Z' },
            ],
            lessons: [
              {
                id: 'lesson-fuzzy-9a',
                title: 'Bài kiểm tra điền chỗ trống',
                topic: 'Bản quyền số',
                sourceFileName: 'banquyen.txt',
                summary: 'Ôn tập bản quyền',
                assignedClassIds: ['LOP-9A'],
                createdAt: '2026-11-22T00:00:00Z',
                questions: [
                  {
                    id: 'q-fuzzy-1',
                    type: 'fill_blank',
                    questionText: 'Khi sử dụng hình ảnh trên mạng cần tôn trọng ___ của tác giả.',
                    aiSearchKeywordHint: 'bản quyền tác giả',
                    correctAnswer: 'bản quyền',
                    competencyId: '3.3',
                    competencyIds: ['3.3'],
                    explanation: 'Tôn trọng bản quyền và ghi rõ nguồn khi sử dụng nội dung số.',
                  },
                ],
              },
            ],
          }),
        },
        storage,
      );

      // Student types moderate spelling variation ("ban qyn") -> receives partial credit (70% base + scaled speed)
      const subRes = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-9A',
            tabletNumber: 5,
            groupName: 'Bình Minh',
            lessonId: 'lesson-fuzzy-9a',
            questionId: 'q-fuzzy-1',
            userAnswer: 'ban qyn',
            elapsedMs: 12000,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(subRes.ok, true);
      const subData = subRes.data as {
        submission: {
          id: string;
          isCorrect: boolean;
          basePoints: number;
          speedBonus: number;
          totalPoints: number;
          feedbackText: string;
        };
      };
      assert.equal(subData.submission.isCorrect, true);
      assert.equal(subData.submission.basePoints, 70);
      assert.equal(subData.submission.speedBonus, 35);
      assert.equal(subData.submission.totalPoints, 105);
      assert.match(subData.submission.feedbackText, /70%/);

      // Teacher upgrades partial credit submission to 100% full credit via override endpoint
      const upgradeRes = await handleLocalApi(
        `/api/submissions/${encodeURIComponent(subData.submission.id)}/override`,
        {
          method: 'POST',
          authToken: token,
          body: JSON.stringify({ isCorrect: true }),
        },
        storage,
      );
      assert.equal(upgradeRes.ok, true);
      const upData = upgradeRes.data as {
        submission: { basePoints: number; speedBonus: number; totalPoints: number };
      };
      assert.equal(upData.submission.basePoints, 100);
      assert.equal(upData.submission.speedBonus, 50);
      assert.equal(upData.submission.totalPoints, 150);
    },
  );
});

test('localStoreApi enforces mandatory verified Gmail login (rejects ALL guest/unauthenticated access with 401), anti-farming retry XP caps, and public honor board visibility', async () => {
  const storage = createMemoryStorage();
  await withMockFetch(
    async (input, init) => {
      const url = String(input);
      if (url.includes('identitytoolkit.googleapis.com/v1/accounts:lookup')) {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { idToken?: string };
        if (parsed.idToken === 'verified-student-token') {
          return new Response(
            JSON.stringify({
              users: [
                {
                  localId: 'uid-google-student-2',
                  email: 'baochau@gmail.com',
                  emailVerified: true,
                },
              ],
            }),
            { status: 200 },
          );
        }
      }
      return new Response(JSON.stringify({}), { status: 404 });
    },
    async () => {
      // 1) ALL guest / unauthenticated calls (even with guestUid) MUST be rejected with 401 to prevent peeking at questions!
      const guestProfileRes = await handleLocalApi(
        '/api/learners/profile',
        {
          method: 'POST',
          body: JSON.stringify({
            guestUid: 'guest-5a-minh-khoi-test1',
            fullName: 'Khách xem trước đề',
            className: '5A',
            schoolName: 'TH Test',
          }),
        },
        storage,
      );
      assert.equal(guestProfileRes.status, 401);

      const guestMeRes = await handleLocalApi(
        '/api/learners/me?uid=guest-5a-minh-khoi-test1',
        { method: 'GET' },
        storage,
      );
      assert.equal(guestMeRes.status, 401);

      const guestSubmitRes = await handleLocalApi(
        '/api/learners/assessment-submit',
        {
          method: 'POST',
          body: JSON.stringify({
            guestUid: 'guest-5a-minh-khoi-test1',
            mode: 'diagnostic',
            maxCombo: 1,
            outcomes: [
              { exerciseId: 'ex-1.1-l1', competencyId: '1.1', level: 1, type: 'scenario_choice', isCorrect: true, xpEarned: 25 },
            ],
          }),
        },
        storage,
      );
      assert.equal(guestSubmitRes.status, 401);

      const spoofGoogleRes = await handleLocalApi(
        '/api/learners/me?uid=uid-google-student-2',
        { method: 'GET' },
        storage,
      );
      assert.equal(spoofGoogleRes.status, 401);

      // 2) Verified Gmail student completes profile
      const profileRes = await handleLocalApi(
        '/api/learners/profile',
        {
          method: 'POST',
          body: JSON.stringify({
            idToken: 'verified-student-token',
            fullName: 'Nguyễn Bảo Châu',
            className: '6B',
            schoolName: 'THCS Lê Quý Đôn',
            gradeBand: 'middle',
          }),
        },
        storage,
      );
      assert.equal(profileRes.ok, true);
      assert.equal((profileRes.data as { profile: { authType: string; email: string } }).profile.authType, 'google');
      assert.equal((profileRes.data as { profile: { email: string } }).profile.email, 'baochau@gmail.com');

      // 3) 1st submission: ex-1.1-l2 correct (40 XP), ex-4.2-l2 wrong (+5 effort XP)
      const run1 = await handleLocalApi(
        '/api/learners/assessment-submit',
        {
          method: 'POST',
          body: JSON.stringify({
            idToken: 'verified-student-token',
            mode: 'variety_sprint',
            maxCombo: 1,
            outcomes: [
              { exerciseId: 'ex-1.1-l2', competencyId: '1.1', level: 2, type: 'match_pairs', isCorrect: true, xpEarned: 40 },
              { exerciseId: 'ex-4.2-l2', competencyId: '4.2', level: 2, type: 'scenario_choice', isCorrect: false, xpEarned: 5 },
            ],
          }),
        },
        storage,
      );
      assert.equal(run1.ok, true);
      assert.equal((run1.data as { profile: { totalXp: number } }).profile.totalXp, 45);

      // 4) 2nd submission: repeating ex-1.1-l2 (spoofing 40 XP -> capped to 25% = 10 XP) + fixing ex-4.2-l2 (80% = 32 XP)
      const run2 = await handleLocalApi(
        '/api/learners/assessment-submit',
        {
          method: 'POST',
          body: JSON.stringify({
            idToken: 'verified-student-token',
            mode: 'variety_sprint',
            maxCombo: 2,
            outcomes: [
              { exerciseId: 'ex-1.1-l2', competencyId: '1.1', level: 2, type: 'match_pairs', isCorrect: true, xpEarned: 40 },
              { exerciseId: 'ex-4.2-l2', competencyId: '4.2', level: 2, type: 'scenario_choice', isCorrect: true, xpEarned: 40 },
            ],
          }),
        },
        storage,
      );
      assert.equal(run2.ok, true);
      const run2Data = run2.data as {
        profile: { totalXp: number };
        attempt: { xpEarned: number; outcomes: Array<{ retryTier?: string; xpEarned: number }> };
      };
      assert.equal(run2Data.attempt.xpEarned, 42);
      assert.equal(run2Data.attempt.outcomes[0].retryTier, 'review_bonus');
      assert.equal(run2Data.attempt.outcomes[0].xpEarned, 10);
      assert.equal(run2Data.attempt.outcomes[1].retryTier, 'redemption_mastery');
      assert.equal(run2Data.attempt.outcomes[1].xpEarned, 32);
      assert.equal(run2Data.profile.totalXp, 87);

      // 5) 3rd submission: repeating ex-1.1-l2 again -> 0 XP practice mode!
      const run3 = await handleLocalApi(
        '/api/learners/assessment-submit',
        {
          method: 'POST',
          body: JSON.stringify({
            idToken: 'verified-student-token',
            mode: 'variety_sprint',
            maxCombo: 1,
            outcomes: [
              { exerciseId: 'ex-1.1-l2', competencyId: '1.1', level: 2, type: 'match_pairs', isCorrect: true, xpEarned: 40 },
            ],
          }),
        },
        storage,
      );
      assert.equal(run3.ok, true);
      const run3Data = run3.data as {
        profile: { totalXp: number };
        attempt: { xpEarned: number; outcomes: Array<{ retryTier?: string; xpEarned: number }> };
      };
      assert.equal(run3Data.attempt.xpEarned, 0);
      assert.equal(run3Data.attempt.outcomes[0].retryTier, 'practice_no_xp');
      assert.equal(run3Data.profile.totalXp, 87);

      // 6) Verified Gmail student's achievement is PUBLICLY readable on /api/learners/honor (no login needed, no email PII leaked)
      const honorRes = await handleLocalApi('/api/learners/honor', { method: 'GET' }, storage);
      assert.equal(honorRes.ok, true);
      const honorEntries = (honorRes.data as { entries: Array<{ uid: string; fullName: string; totalXp: number; email?: string; authType: string }> }).entries;
      assert.equal(honorEntries.length, 1);
      assert.equal(honorEntries[0].fullName, 'Nguyễn Bảo Châu');
      assert.equal(honorEntries[0].totalXp, 87);
      assert.equal(honorEntries[0].authType, 'google');
      assert.equal(honorEntries[0].email, undefined);

      // 7) Teacher sees verified Gmail student and awards badge + bonus XP -> reflected on public honor board!
      const teacherToken = await seedAuthenticatedTeacherToken(storage);
      const teacherList = await handleLocalApi(
        '/api/teacher/learners',
        { method: 'GET', authToken: teacherToken },
        storage,
      );
      assert.equal(teacherList.ok, true);
      assert.equal((teacherList.data as { learners: unknown[] }).learners.length, 1);

      const awardRes = await handleLocalApi(
        '/api/teacher/awards',
        {
          method: 'POST',
          authToken: teacherToken,
          body: JSON.stringify({
            learnerUid: 'uid-google-student-2',
            badgeId: 'digital_star',
            badgeTitle: 'Ngôi sao Tự học ở nhà',
            bonusXp: 100,
            message: 'Tuyên dương em Bảo Châu tự học rất tốt!',
          }),
        },
        storage,
      );
      assert.equal(awardRes.ok, true);

      const honorAfter = await handleLocalApi('/api/learners/honor', { method: 'GET' }, storage);
      const afterEntries = (honorAfter.data as { entries: Array<{ totalXp: number; awardsCount: number; latestBadgeTitle?: string }> }).entries;
      assert.equal(afterEntries[0].totalXp, 187);
      assert.equal(afterEntries[0].awardsCount, 1);
      assert.equal(afterEntries[0].latestBadgeTitle, 'Ngôi sao Tự học ở nhà');
    },
  );
});

test('localStoreApi saves true_false and true_false_multi via PUT /api/lessons/:id and grades proportional partial credit accurately', async () => {
  await withMockFetch(
    () => new Response(JSON.stringify({}), { status: 404 }),
    async () => {
      const storage = createMemoryStorage();
      const token = await seedAuthenticatedTeacherToken(storage);

      // Hydrate a real teacher class + lesson first (no virtual demo LOP-5A auto-created)
      await handleLocalApi(
        '/api/sync/cloud-hydrate',
        {
          method: 'POST',
          authToken: token,
          body: JSON.stringify({
            authoritativeCloud: true,
            classes: [
              { id: 'LOP-8A', name: 'Lớp 8A', grade: 'Khối 8', teacherName: 'Cô Ý', createdAt: '2026-11-22T00:00:00Z' },
            ],
            lessons: [
              {
                id: 'lesson-ai-search',
                title: 'Bài 2',
                topic: 'Đánh giá thông tin',
                sourceFileName: 'Bai2.txt',
                summary: 'Tóm tắt',
                assignedClassIds: ['LOP-8A'],
                createdAt: '2026-11-22T00:00:00Z',
                questions: [
                  {
                    id: 'q-init',
                    type: 'multiple_choice',
                    questionText: 'Init?',
                    options: ['A', 'B'],
                    aiSearchKeywordHint: 'init',
                    correctAnswer: 'A',
                    competencyId: '1.2',
                    explanation: 'Init',
                  },
                ],
              },
            ],
          }),
        },
        storage,
      );

      // Update lesson-ai-search with a true_false_multi (4 statements) and a single true_false question
      const putRes = await handleLocalApi(
        '/api/lessons/lesson-ai-search',
        {
          method: 'PUT',
          authToken: token,
          body: JSON.stringify({
            title: 'Bài 2: Đánh giá thông tin nâng cao',
            topic: 'Đánh giá thông tin số',
            summary: 'Luyện tập dạng Đúng/Sai nâng cao',
            assignedClassIds: ['LOP-8A'],
            questions: [
              {
                id: 'q-tfm-test',
                type: 'true_false_multi',
                questionText: 'Một bài đăng trên mạng khẳng định nước chanh chữa khỏi mọi bệnh. Đánh giá các nhận định sau:',
                options: [
                  'Bài đăng có nhiều lượt chia sẻ nên chắc chắn đúng.',
                  'Cần đối chiếu với trang web chính thức của Bộ Y tế hoặc WHO.',
                  'Không nên chia sẻ lại khi chưa kiểm chứng nguồn tin.',
                  'Chỉ cần đọc tiêu đề là đủ để tin tưởng.',
                ],
                aiSearchKeywordHint: 'kiểm chứng thông tin sức khỏe đáng tin cậy',
                correctAnswer: 'a:Sai | b:Đúng | c:Đúng | d:Sai',
                competencyId: '1.2',
                competencyIds: ['1.2'],
                explanation: 'Luôn kiểm tra nguồn y tế chính thống trước khi tin hoặc chia sẻ.',
              },
              {
                id: 'q-tf-single-test',
                type: 'true_false',
                questionText: 'Khi tra cứu bằng AI, học sinh vẫn cần kiểm chứng lại các con số và trích dẫn.',
                options: ['Đúng', 'Sai'],
                aiSearchKeywordHint: 'kiểm chứng thông tin AI tạo ra',
                correctAnswer: 'Đúng',
                competencyId: '6.2',
                competencyIds: ['6.2'],
                explanation: 'AI có thể tạo thông tin chưa chính xác nên cần kiểm chứng.',
              },
            ],
          }),
        },
        storage,
      );
      assert.equal(putRes.ok, true);
      const updated = (putRes.data as { lesson: { questions: Array<{ type: string; options?: string[] }> } }).lesson;
      assert.equal(updated.questions[0].type, 'true_false_multi');
      assert.equal(updated.questions[0].options?.length, 4);
      assert.equal(updated.questions[1].type, 'true_false');
      assert.deepEqual(updated.questions[1].options, ['Đúng', 'Sai']);

      // Group 1 gets 3/4 statements right on true_false_multi -> 75% partial credit (75 base + 38 speed = 113)
      const subPartial = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-8A',
            tabletNumber: 1,
            groupName: 'Nhóm 3/4',
            lessonId: 'lesson-ai-search',
            questionId: 'q-tfm-test',
            userAnswer: 'a:Sai | b:Đúng | c:Đúng | d:Đúng',
            elapsedMs: 20000,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(subPartial.ok, true);
      const pData = subPartial.data as {
        submission: { isCorrect: boolean; basePoints: number; speedBonus: number; totalPoints: number; feedbackText: string };
      };
      assert.equal(pData.submission.isCorrect, true);
      assert.equal(pData.submission.basePoints, 75);
      assert.equal(pData.submission.speedBonus, 38);
      assert.equal(pData.submission.totalPoints, 113);
      assert.match(pData.submission.feedbackText, /3\/4 nhận định/);

      // Group 2 gets 4/4 statements right -> 100% credit (100 base + 50 speed = 150)
      const subFull = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-8A',
            tabletNumber: 2,
            groupName: 'Nhóm 4/4',
            lessonId: 'lesson-ai-search',
            questionId: 'q-tfm-test',
            userAnswer: 'a:Sai | b:Đúng | c:Đúng | d:Sai',
            elapsedMs: 18000,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(subFull.ok, true);
      const fData = subFull.data as {
        submission: { isCorrect: boolean; basePoints: number; totalPoints: number };
      };
      assert.equal(fData.submission.isCorrect, true);
      assert.equal(fData.submission.basePoints, 100);
      assert.equal(fData.submission.totalPoints, 150);

      // Group 2 answers single true_false correctly -> 100% credit
      const subSingle = await handleLocalApi(
        '/api/quiz/submit',
        {
          method: 'POST',
          body: JSON.stringify({
            classId: 'LOP-8A',
            tabletNumber: 2,
            groupName: 'Nhóm 4/4',
            lessonId: 'lesson-ai-search',
            questionId: 'q-tf-single-test',
            userAnswer: 'Đúng',
            elapsedMs: 10000,
            lang: 'vi',
          }),
        },
        storage,
      );
      assert.equal(subSingle.ok, true);
      const sData = subSingle.data as { submission: { isCorrect: boolean; totalPoints: number } };
      assert.equal(sData.submission.isCorrect, true);
      assert.equal(sData.submission.totalPoints, 150);
    },
  );
});

test('localStoreApi purges legacy virtual LOP-5A seed artifacts, deduplicates repeated Firebase syncs, and preserves durable Sync Ledger snapshot', async () => {
  await withMockFetch(
    () => new Response(JSON.stringify({}), { status: 404 }),
    async () => {
      const backing = new Map<string, string>();
      const storage: StorageLike = {
        getItem: (k) => backing.get(k) ?? null,
        setItem: (k, v) => {
          backing.set(k, v);
        },
      };

      // Simulate legacy localStorage polluted with fake demo LOP-5A + sub-seed-1 + notif-seed-1
      backing.set(
        'edubot_static_store_v1',
        JSON.stringify({
          classes: [
            { id: 'LOP-5A', name: 'Lớp 5A', grade: 'Khối 5', teacherName: 'Cô Minh Anh', createdAt: '2026-01-01T00:00:00Z' },
          ],
          lessons: [],
          submissions: [{ id: 'sub-seed-1', classId: 'LOP-5A', groupId: 'g1', tabletNumber: 1, groupName: 'g', lessonId: 'l', lessonTitle: 'l', questionId: 'q', competencyId: '1.1', userAnswer: 'a', isCorrect: true, basePoints: 100, speedBonus: 0, totalPoints: 100, elapsedMs: 1000, submittedAt: '2026-01-01T00:00:00Z', feedbackText: '', explanation: '' }],
          notifications: [{ id: 'notif-seed-1', classId: 'LOP-5A', lessonId: 'l', title: 'Demo', message: 'Demo', createdAt: '2026-01-01T00:00:00Z', readByGroupIds: [] }],
          activityLogs: [{ id: 'log-seed-1', classId: 'LOP-5A', groupId: 'g1', action: 'Demo', detail: '', timestamp: '2026-01-01T00:00:00Z' }],
        }),
      );

      // Loading store IMMEDIATELY purges all fake demo LOP-5A & *-seed-* artifacts
      const cleaned = loadLocalStore(storage);
      assert.equal(cleaned.classes.length, 0);
      assert.equal(cleaned.submissions.length, 0);
      assert.equal(cleaned.notifications.length, 0);
      assert.equal(cleaned.activityLogs.length, 0);

      // Authoritative Firebase sync with duplicate entries + real classes deduplicates cleanly & records Sync Ledger
      const token = await seedAuthenticatedTeacherToken(storage);
      const syncPayload = {
        authoritativeCloud: true,
        workspaceId: 'WS-TEACHER-REAL',
        ownerUid: 'uid-real-teacher',
        ownerEmail: 'huynh.nhu.y1601@gmail.com',
        classes: [
          { id: 'LOP-8A', name: 'Lớp 8A', grade: 'Khối 8', teacherName: 'Cô Huỳnh Như Ý', createdAt: '2026-11-22T00:00:00Z' },
          { id: 'LOP-8A', name: 'Lớp 8A (Cập nhật)', grade: 'Khối 8', teacherName: 'Cô Huỳnh Như Ý', createdAt: '2026-11-22T00:00:00Z' },
          { id: 'LOP-9-5', name: 'Lớp 9/5', grade: 'Khối 9', teacherName: 'Cô Huỳnh Như Ý', createdAt: '2026-11-22T00:00:00Z' },
          // Even if a legacy demo class snuck into payload, it is stripped!
          { id: 'LOP-5A', name: 'Lớp 5A', grade: 'Khối 5', teacherName: 'Cô Minh Anh', createdAt: '2026-01-01T00:00:00Z' },
        ],
        lessons: [],
        notifications: [
          { id: 'n-real-1', classId: 'LOP-8A', lessonId: 'l1', title: 'Bài mới', message: 'Làm bài', createdAt: '2026-11-22T00:00:00Z', readByGroupIds: [] },
          { id: 'n-real-1', classId: 'LOP-8A', lessonId: 'l1', title: 'Bài mới', message: 'Làm bài', createdAt: '2026-11-22T00:00:00Z', readByGroupIds: [] },
        ],
      };

      const sync1 = await handleLocalApi(
        '/api/sync/cloud-hydrate',
        { method: 'POST', authToken: token, body: JSON.stringify(syncPayload) },
        storage,
      );
      assert.equal(sync1.ok, true);

      // Repeat the exact same sync -> still zero duplicates, revision increments to 2
      const sync2 = await handleLocalApi(
        '/api/sync/cloud-hydrate',
        { method: 'POST', authToken: token, body: JSON.stringify(syncPayload) },
        storage,
      );
      assert.equal(sync2.ok, true);
      const meta = (sync2.data as { syncMeta: { syncRevision: number; classesCount: number; notificationsCount: number } }).syncMeta;
      assert.equal(meta.syncRevision, 2);
      assert.equal(meta.classesCount, 2);
      assert.equal(meta.notificationsCount, 1);

      // Even if primary key is cleared, durable Sync Snapshot restores exact synced Firebase classes (no data loss, no fake LOP-5A!)
      backing.delete('edubot_static_store_v1');
      const restored = loadLocalStore(storage);
      assert.deepEqual(
        restored.classes.map((c) => c.id),
        ['LOP-8A', 'LOP-9-5'],
      );
      assert.equal(restored.syncMeta?.syncRevision, 2);
    },
  );
});

test('incognito student selecting LOP-9-5 sees lessons with zero login even when publicWorkspaces/default is stale vs fallback workspace', async () => {
  await withMockFetch(
    (url, init) => {
      // Simulate stale `default` doc that has class LOP-9-5 but 0 lessons (older updatedAt)
      if (url.includes('/publicWorkspaces/default?') && (!init?.method || init.method === 'GET')) {
        const docFields = toFirestoreRestValue({
          id: 'default',
          classes: [
            {
              id: 'LOP-9-5',
              name: 'Lớp 9/5',
              grade: 'Khối 9',
              teacherName: 'Cô Huỳnh Như Ý',
              createdAt: '2026-11-22T00:00:00.000Z',
            },
          ],
          lessons: [],
          updatedAt: '2026-11-22T01:00:00.000Z',
        }).mapValue?.fields;
        return new Response(
          JSON.stringify({ updateTime: '2026-11-22T01:00:00.000Z', fields: docFields }),
          { status: 200 },
        );
      }
      // Simulate fresher teacher workspace `WS-LHH4MPLJSIV8` with the real lesson assigned to Lớp 9-5
      if (url.includes('/publicWorkspaces/WS-LHH4MPLJSIV8?') && (!init?.method || init.method === 'GET')) {
        const docFields = toFirestoreRestValue({
          id: 'WS-LHH4MPLJSIV8',
          classes: [
            {
              id: 'LOP-9-5',
              name: 'Lớp 9/5',
              grade: 'Khối 9',
              teacherName: 'Cô Huỳnh Như Ý',
              createdAt: '2026-11-22T00:00:00.000Z',
            },
          ],
          lessons: [
            {
              id: 'lesson-9-5-live',
              title: 'An toàn thông tin số lớp 9',
              topic: 'Công dân số 9',
              sourceFileName: 'bai9.txt',
              summary: 'Bài tập cho lớp 9-5',
              assignedClassIds: ['Lớp 9-5'],
              createdAt: '2026-11-22T02:00:00.000Z',
              questions: [
                {
                  id: 'q95-1',
                  type: 'multiple_choice',
                  questionText: 'Cách đặt mật khẩu mạnh?',
                  options: ['Kết hợp chữ hoa, số, ký tự đặc biệt', 'Ngày sinh'],
                  aiSearchKeywordHint: 'mật khẩu mạnh',
                  correctAnswer: 'Kết hợp chữ hoa, số, ký tự đặc biệt',
                  competencyId: '4.1',
                  competencyIds: ['4.1'],
                  explanation: 'Mật khẩu mạnh cần đa dạng ký tự.',
                },
              ],
            },
          ],
          updatedAt: '2026-11-22T02:00:00.000Z',
        }).mapValue?.fields;
        return new Response(
          JSON.stringify({ updateTime: '2026-11-22T02:00:00.000Z', fields: docFields }),
          { status: 200 },
        );
      }
      if (url.includes(':runQuery')) {
        return new Response(JSON.stringify([{ readTime: '2026-11-22T02:00:00Z' }]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    },
    async () => {
      resetLocalHydrationCache();
      const storage = createMemoryStorage();
      // Fresh incognito student enters LOP-9-5 with NO login and NO ?ws= param
      const res = await handleLocalApi(
        '/api/bootstrap?classId=LOP-9-5&lang=vi&role=student&refresh=1',
        { method: 'GET' },
        storage,
      );
      assert.equal(res.ok, true);
      const data = res.data as {
        classes: Array<{ id: string }>;
        lessons: Array<{ id: string; assignedClassIds: string[]; questions: Array<{ correctAnswer?: string }> }>;
      };
      assert.deepEqual(
        data.classes.map((c) => c.id),
        ['LOP-9-5'],
      );
      assert.equal(data.lessons.length, 1);
      assert.equal(data.lessons[0].id, 'lesson-9-5-live');
      assert.deepEqual(data.lessons[0].assignedClassIds, ['LOP-9-5']);
      // Answer key remains strictly stripped for unauthenticated student
      assert.equal(data.lessons[0].questions[0].correctAnswer, undefined);
    },
  );
});

test('dedicated Student Public Memory serves classes & lessons to students with zero login even when Admin disconnects and Cloud is offline', async () => {
  await withMockFetch(
    () => new Response(JSON.stringify({}), { status: 404 }),
    async () => {
      resetLocalHydrationCache();
      const backing = new Map<string, string>();
      const storage = {
        getItem: (k: string) => backing.get(k) ?? null,
        setItem: (k: string, v: string) => {
          backing.set(k, v);
        },
      };

      const token = await seedAuthenticatedTeacherToken(storage);

      // 1) Admin publishes classes + lessons into the website's dedicated Student Public Memory
      const pubRes = await handleLocalApi(
        '/api/student-memory/publish',
        {
          method: 'POST',
          authToken: token,
          body: JSON.stringify({
            workspaceId: 'WS-TEACHER-REAL',
            publishedBy: 'huynh.nhu.y1601@gmail.com',
            classes: [
              {
                id: 'LOP-9-5',
                name: 'Lớp 9/5',
                grade: 'Khối 9',
                teacherName: 'Cô Huỳnh Như Ý',
                createdAt: '2026-11-23T00:00:00Z',
              },
            ],
            lessons: [
              {
                id: 'lesson-95-student-mem',
                title: 'Kỹ năng số lớp 9-5',
                topic: 'Công dân số',
                sourceFileName: 'bai95.txt',
                summary: 'Lưu trong bộ nhớ riêng học sinh',
                assignedClassIds: ['LOP-9-5'],
                createdAt: '2026-11-23T00:00:00Z',
                questions: [
                  {
                    id: 'q-sm-1',
                    type: 'multiple_choice',
                    questionText: 'Nên bảo mật tài khoản bằng cách nào?',
                    options: ['Xác thực 2 bước (2FA)', 'Đặt mật khẩu 123456'],
                    aiSearchKeywordHint: '2FA',
                    correctAnswer: 'Xác thực 2 bước (2FA)',
                    competencyId: '4.1',
                    competencyIds: ['4.1'],
                    explanation: '2FA tăng cường bảo mật.',
                  },
                ],
              },
            ],
          }),
        },
        storage,
      );
      assert.equal(pubRes.ok, true);
      assert.ok(backing.has('edubot_student_public_memory_v1'));

      // 2) Simulate Admin disconnected + primary store & sync cache cleared + Cloud offline (404)
      backing.delete('edubot_static_store_v1');
      backing.delete('edubot_cloud_sync_snapshot_v1');
      resetLocalHydrationCache();

      // 3) Unauthenticated student opens Student Portal for LOP-9-5 -> STILL works seamlessly!
      const studentBoot = await handleLocalApi(
        '/api/bootstrap?classId=LOP-9-5&lang=vi&role=student&refresh=1',
        { method: 'GET' },
        storage,
      );
      assert.equal(studentBoot.ok, true);
      const bootData = studentBoot.data as {
        classes: Array<{ id: string }>;
        lessons: Array<{ id: string; questions: Array<{ correctAnswer?: string }> }>;
        studentMemoryMeta: { revision: number; classesCount: number; lessonsCount: number } | null;
      };
      assert.deepEqual(
        bootData.classes.map((c) => c.id),
        ['LOP-9-5'],
      );
      assert.equal(bootData.lessons.length, 1);
      assert.equal(bootData.lessons[0].id, 'lesson-95-student-mem');
      assert.equal(bootData.lessons[0].questions[0].correctAnswer, undefined);
      assert.equal(bootData.studentMemoryMeta?.classesCount, 1);
      assert.equal(bootData.studentMemoryMeta?.lessonsCount, 1);

      // 4) Public GET /api/student-memory?classId=LOP-9-5 also returns stripped lessons without Admin token
      const memRes = await handleLocalApi('/api/student-memory?classId=LOP-9-5', { method: 'GET' }, storage);
      assert.equal(memRes.ok, true);
      const memData = (memRes.data as {
        memory: { classes: Array<{ id: string }>; lessons: Array<{ id: string; questions: Array<{ correctAnswer?: string }> }> };
      }).memory;
      assert.equal(memData.classes[0].id, 'LOP-9-5');
      assert.equal(memData.lessons[0].id, 'lesson-95-student-mem');
      assert.equal(memData.lessons[0].questions[0].correctAnswer, undefined);
    },
  );
});

test('cross-device personal email learner hydration & baseProfile prevent XP wipe and teacher can honor remote cloud learners', async () => {
  await withMockFetch(
    (url) => {
      if (url.includes('identitytoolkit.googleapis.com/v1/accounts:lookup')) {
        return new Response(
          JSON.stringify({
            users: [
              {
                localId: 'student-home-uid-99',
                email: 'minh.an.9a@gmail.com',
                emailVerified: true,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    },
    async () => {
      resetLocalHydrationCache();
      const deviceBStorage = createMemoryStorage();

      const cloudProfileFromDeviceA = {
        uid: 'student-home-uid-99',
        authType: 'google' as const,
        email: 'minh.an.9a@gmail.com',
        fullName: 'Trần Minh An',
        className: '9A',
        schoolName: 'THCS Nguyễn Du',
        gradeBand: 'middle' as const,
        role: 'student' as const,
        profileCompleted: true,
        currentLevel: 2 as const,
        totalXp: 420,
        bestCombo: 6,
        totalExercisesDone: 10,
        totalCorrect: 9,
        masteryByCompetency: {
          '1.1': {
            competencyId: '1.1',
            highestLevel: 2 as const,
            attempts: 2,
            correctCount: 2,
            xp: 65,
            lastPracticedAt: '2026-11-23T10:00:00Z',
            exerciseHistory: {
              'ex-1.1-l1': { attempts: 1, correctCount: 1, reviewBonusCount: 0, lastAttemptAt: '2026-11-23T10:00:00Z' },
              'ex-1.1-l2': { attempts: 1, correctCount: 1, reviewBonusCount: 0, lastAttemptAt: '2026-11-23T10:00:00Z' },
            },
          },
        },
        createdAt: '2026-11-20T08:00:00Z',
        updatedAt: '2026-11-23T10:00:00Z',
        lastActiveAt: '2026-11-23T10:00:00Z',
      };

      // 1) Device B hydrates from Cloud Firestore via POST /api/learners/hydrate
      const hydrateRes = await handleLocalApi(
        '/api/learners/hydrate',
        {
          method: 'POST',
          body: JSON.stringify({
            idToken: 'fake-google-token',
            profile: cloudProfileFromDeviceA,
          }),
        },
        deviceBStorage,
      );
      assert.equal(hydrateRes.ok, true);
      const hydrated = (hydrateRes.data as { profile: { totalXp: number; email?: string } }).profile;
      assert.equal(hydrated.totalXp, 420);
      assert.equal(hydrated.email, 'minh.an.9a@gmail.com');

      // 2) Even if storage was cleared again right before submitting, baseProfile preserves prior 420 XP!
      const freshStorageAfterClear = createMemoryStorage();
      const submitRes = await handleLocalApi(
        '/api/learners/assessment-submit',
        {
          method: 'POST',
          body: JSON.stringify({
            idToken: 'fake-google-token',
            learnerName: 'Trần Minh An',
            className: '9A',
            schoolName: 'THCS Nguyễn Du',
            gradeBand: 'middle',
            baseProfile: cloudProfileFromDeviceA,
            mode: 'competency_focus',
            targetCompetencyId: '4.2',
            maxCombo: 2,
            outcomes: [
              {
                exerciseId: 'ex-4.2-l1',
                competencyId: '4.2',
                level: 1,
                type: 'scenario_choice',
                isCorrect: true,
                xpEarned: 25,
              },
            ],
          }),
        },
        freshStorageAfterClear,
      );
      assert.equal(submitRes.ok, true);
      const afterSubmit = (
        submitRes.data as {
          profile: {
            totalXp: number;
            totalExercisesDone: number;
            masteryByCompetency: Record<string, { highestLevel: number }>;
          };
        }
      ).profile;
      assert.equal(afterSubmit.totalXp, 445);
      assert.equal(afterSubmit.totalExercisesDone, 11);
      assert.equal(afterSubmit.masteryByCompetency['1.1']?.highestLevel, 2);
      assert.equal(afterSubmit.masteryByCompetency['4.2']?.highestLevel, 1);

      // 3) Teacher on a separate browser awards a remote Cloud student using learnerSnapshot
      const teacherStorage = createMemoryStorage();
      const teacherToken = await seedAuthenticatedTeacherToken(teacherStorage);
      const awardRes = await handleLocalApi(
        '/api/teacher/awards',
        {
          method: 'POST',
          authToken: teacherToken,
          body: JSON.stringify({
            learnerUid: 'student-home-uid-99',
            learnerSnapshot: afterSubmit,
            badgeId: 'master_24',
            badgeTitle: 'Thủ khoa 24 Năng lực',
            message: 'Cô tuyên dương tinh thần tự học ở nhà rất xuất sắc!',
            bonusXp: 100,
          }),
        },
        teacherStorage,
      );
      assert.equal(awardRes.ok, true);
      const awardData = awardRes.data as {
        award: { badgeTitle: string; bonusXp: number };
        learner: { totalXp: number };
      };
      assert.equal(awardData.award.badgeTitle, 'Thủ khoa 24 Năng lực');
      assert.equal(awardData.learner.totalXp, 545);
    },
  );
});





