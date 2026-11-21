import firebaseConfig from '../../firebase-applet-config.json';
import { getCompetencyById } from '../shared/competencies';
import {
  buildCompetencyMatrix,
  buildDomainChampions,
  buildLeaderboard,
  calculatePoints,
  formatGroupId,
  isAnswerMatch,
} from '../shared/scoring';
import { createSeedData, StoreData } from '../shared/seedData';
import {
  ActivityLog,
  AnswerSubmission,
  ClassRoom,
  Language,
  Lesson,
  OfflineQueueItem,
  PushNotification,
  Question,
  QuestionType,
} from '../shared/types';
import {
  FirestoreRestValue,
  fromFirestoreRestValue,
  normalizeClassCode,
} from './firestoreHelpers';

const STATIC_STORE_KEY = 'edubot_static_store_v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memoryFallback = new Map<string, string>();
const defaultStorage: StorageLike = {
  getItem(key: string) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage.getItem(key);
      }
    } catch {
      // ignore
    }
    return memoryFallback.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
        return;
      }
    } catch {
      // ignore
    }
    memoryFallback.set(key, value);
  },
};

const hydratedWorkspaceCache = new Map<string, number>();

export function loadLocalStore(storage: StorageLike = defaultStorage): StoreData {
  try {
    const raw = storage.getItem(STATIC_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoreData;
      if (Array.isArray(parsed.classes) && Array.isArray(parsed.lessons)) {
        return parsed;
      }
    }
  } catch {
    // Re-seed below
  }
  const seed = createSeedData();
  saveLocalStore(seed, storage);
  return seed;
}

export function saveLocalStore(
  data: StoreData,
  storage: StorageLike = defaultStorage,
): void {
  try {
    storage.setItem(STATIC_STORE_KEY, JSON.stringify(data));
  } catch {
    // ignore storage quota errors
  }
}

async function hydrateLocalFromPublicWorkspace(
  workspaceCode: string,
  storage: StorageLike,
): Promise<void> {
  const cleanCode = workspaceCode.trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(cleanCode)) return;
  const lastFetched = hydratedWorkspaceCache.get(cleanCode) ?? 0;
  if (Date.now() - lastFetched < 30_000) return;

  if (
    !firebaseConfig?.projectId ||
    !firebaseConfig?.firestoreDatabaseId ||
    !firebaseConfig?.apiKey
  ) {
    return;
  }

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      firebaseConfig.projectId,
    )}/databases/${encodeURIComponent(
      firebaseConfig.firestoreDatabaseId,
    )}/documents/publicWorkspaces/${encodeURIComponent(
      cleanCode,
    )}?key=${encodeURIComponent(firebaseConfig.apiKey)}`;

    const res = await fetch(url);
    if (!res.ok) return;
    const doc = (await res.json()) as {
      fields?: Record<string, FirestoreRestValue>;
    };
    if (!doc.fields) return;

    const decoded = fromFirestoreRestValue({
      mapValue: { fields: doc.fields },
    }) as {
      classes?: ClassRoom[];
      lessons?: Lesson[];
    };

    const store = loadLocalStore(storage);
    let changed = false;

    if (Array.isArray(decoded.classes) && decoded.classes.length > 0) {
      const classMap = new Map(store.classes.map((c) => [c.id, c]));
      for (const cls of decoded.classes) {
        if (cls?.id && cls?.name) {
          classMap.set(cls.id, cls);
          changed = true;
        }
      }
      store.classes = Array.from(classMap.values());
    }

    if (Array.isArray(decoded.lessons) && decoded.lessons.length > 0) {
      const lessonMap = new Map(store.lessons.map((l) => [l.id, l]));
      for (const lesson of decoded.lessons) {
        if (
          lesson?.id &&
          lesson?.title &&
          Array.isArray(lesson.questions) &&
          lesson.questions.length > 0
        ) {
          lessonMap.set(lesson.id, lesson);
          changed = true;
        }
      }
      store.lessons = Array.from(lessonMap.values());
    }

    if (changed) {
      saveLocalStore(store, storage);
    }
    hydratedWorkspaceCache.set(cleanCode, Date.now());
  } catch {
    // Non-fatal on offline / blocked network
  }
}

function gradeOneLocally(
  store: StoreData,
  item: {
    classId: string;
    tabletNumber: number;
    groupName: string;
    lessonId: string;
    questionId: string;
    userAnswer: string;
    elapsedMs: number;
    submittedAt?: string;
  },
  lang: Language,
  syncedFromOffline = false,
): AnswerSubmission | null {
  const lesson = store.lessons.find((l) => l.id === item.lessonId);
  const question = lesson?.questions.find((q) => q.id === item.questionId);
  if (!lesson || !question) return null;

  const groupId = formatGroupId(item.tabletNumber, item.groupName);
  const comp = getCompetencyById(question.competencyId);
  const isCorrect = isAnswerMatch(
    item.userAnswer,
    question.correctAnswer ?? '',
    question.type,
  );
  const breakdown = calculatePoints(isCorrect, item.elapsedMs);

  const feedbackText =
    lang === 'en'
      ? isCorrect
        ? breakdown.speedBonus >= 35
          ? `Lightning fast, ${item.groupName}! +${breakdown.totalPoints} pts (including +${breakdown.speedBonus} speed bonus)!`
          : `Spot on, ${item.groupName}! +${breakdown.totalPoints} pts!`
        : `Nice try, ${item.groupName}! Check the Digital Citizen tip below and keep going!`
      : isCorrect
        ? breakdown.speedBonus >= 35
          ? `Quá nhanh quá nguy hiểm! Nhóm ${item.groupName} ghi ngay +${breakdown.totalPoints} điểm (gồm +${breakdown.speedBonus} điểm tốc độ)!`
          : `Chính xác tuyệt đối! Chúc mừng nhóm ${item.groupName} nhận +${breakdown.totalPoints} điểm!`
        : `Suýt đúng rồi ${item.groupName} ơi! Xem bí kíp Công dân số bên dưới để ghi điểm câu sau nhé!`;

  const submission: AnswerSubmission = {
    id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    classId: item.classId,
    groupId,
    tabletNumber: item.tabletNumber,
    groupName: item.groupName,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    questionId: question.id,
    competencyId: question.competencyId,
    competencyIds: question.competencyIds ?? [question.competencyId],
    userAnswer: item.userAnswer,
    isCorrect,
    basePoints: breakdown.basePoints,
    speedBonus: breakdown.speedBonus,
    totalPoints: breakdown.totalPoints,
    elapsedMs: item.elapsedMs,
    submittedAt: item.submittedAt || new Date().toISOString(),
    feedbackText,
    explanation: question.explanation,
    syncedFromOffline,
  };

  const existingIdx = store.submissions.findIndex(
    (s) =>
      s.classId === submission.classId &&
      s.groupId === submission.groupId &&
      s.lessonId === submission.lessonId &&
      s.questionId === submission.questionId,
  );
  if (existingIdx >= 0) {
    store.submissions[existingIdx] = submission;
  } else {
    store.submissions.push(submission);
  }

  store.activityLogs.unshift({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    classId: submission.classId,
    groupId: submission.groupId,
    action: syncedFromOffline
      ? isCorrect
        ? 'Đồng bộ ngoại tuyến · Đúng'
        : 'Đồng bộ ngoại tuyến · Chưa đúng'
      : isCorrect
        ? 'Trả lời đúng'
        : 'Trả lời chưa đúng',
    detail: `Năng lực ${comp.id} (${comp.nameVi}) · ${(submission.elapsedMs / 1000).toFixed(1)}s`,
    competencyId: submission.competencyId,
    pointsDelta: submission.totalPoints,
    timestamp: submission.submittedAt,
  });

  return submission;
}

export interface LocalApiResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export async function handleLocalApi(
  url: string,
  options: { method?: string; body?: unknown } = {},
  storage: StorageLike = defaultStorage,
): Promise<LocalApiResult> {
  const method = (options.method || 'GET').toUpperCase();
  const parsedUrl = new URL(url, 'http://local.edubot');
  const pathname = parsedUrl.pathname;
  const body =
    typeof options.body === 'string'
      ? JSON.parse(options.body || '{}')
      : (options.body ?? {});

  // POST /api/teacher/verify-pin
  if (pathname === '/api/teacher/verify-pin' && method === 'POST') {
    const pin = String((body as { pin?: string }).pin ?? '').trim();
    if (pin !== '2025') {
      return {
        ok: false,
        status: 401,
        data: { error: 'Mã PIN Giáo viên chưa đúng. Vui lòng thử lại.' },
      };
    }
    return { ok: true, status: 200, data: { ok: true } };
  }

  // GET /api/bootstrap
  if (pathname === '/api/bootstrap' && method === 'GET') {
    const ws = parsedUrl.searchParams.get('ws') || '';
    if (ws) {
      await hydrateLocalFromPublicWorkspace(ws, storage);
    }

    const store = loadLocalStore(storage);
    const classId = parsedUrl.searchParams.get('classId') || '';
    const lang = (parsedUrl.searchParams.get('lang') === 'en' ? 'en' : 'vi') as Language;
    const includeAnswers = parsedUrl.searchParams.get('role') === 'teacher';

    const sanitizedLessons = store.lessons.map((lesson) => ({
      ...lesson,
      questions: lesson.questions.map((q) =>
        includeAnswers ? q : { ...q, correctAnswer: undefined },
      ),
    }));

    const targetClassId = classId || store.classes[0]?.id || 'LOP-5A';
    const leaderboard = buildLeaderboard(targetClassId, store.submissions, lang);
    const domainChampions = buildDomainChampions(targetClassId, store.submissions, lang);
    const competencyMatrix = buildCompetencyMatrix(
      store.lessons,
      store.submissions,
      classId || undefined,
    );

    const notifications = store.notifications
      .filter((n) => !classId || n.classId === classId)
      .slice(0, 20);

    const activityLogs = store.activityLogs
      .filter((l) => !classId || l.classId === classId)
      .slice(0, 60);

    return {
      ok: true,
      status: 200,
      data: {
        classes: store.classes,
        lessons: sanitizedLessons,
        leaderboard,
        domainChampions,
        competencyMatrix,
        notifications,
        activityLogs,
        submissionsCount: store.submissions.length,
        ...(includeAnswers ? { submissions: store.submissions } : {}),
      },
    };
  }

  // GET /api/workspace/export
  if (pathname === '/api/workspace/export' && method === 'GET') {
    const store = loadLocalStore(storage);
    return {
      ok: true,
      status: 200,
      data: {
        exportedAt: new Date().toISOString(),
        classes: store.classes,
        lessons: store.lessons,
      },
    };
  }

  // POST /api/workspace/import
  if (pathname === '/api/workspace/import' && method === 'POST') {
    const payload = body as { classes?: ClassRoom[]; lessons?: Lesson[] };
    if (!Array.isArray(payload.classes) && !Array.isArray(payload.lessons)) {
      return { ok: false, status: 400, data: { error: 'Tệp cấu hình không hợp lệ.' } };
    }
    const store = loadLocalStore(storage);
    let importedClasses = 0;
    let importedLessons = 0;

    if (Array.isArray(payload.classes)) {
      const classMap = new Map(store.classes.map((c) => [c.id, c]));
      for (const cls of payload.classes) {
        if (cls?.id && cls?.name) {
          classMap.set(cls.id, cls);
          importedClasses++;
        }
      }
      store.classes = Array.from(classMap.values());
    }

    if (Array.isArray(payload.lessons)) {
      const lessonMap = new Map(store.lessons.map((l) => [l.id, l]));
      for (const lesson of payload.lessons) {
        if (
          lesson?.id &&
          lesson?.title &&
          Array.isArray(lesson.questions) &&
          lesson.questions.length > 0
        ) {
          lessonMap.set(lesson.id, lesson);
          importedLessons++;
        }
      }
      store.lessons = Array.from(lessonMap.values());
    }

    saveLocalStore(store, storage);
    return { ok: true, status: 200, data: { ok: true, importedClasses, importedLessons } };
  }

  // POST /api/sync/cloud-hydrate
  if (pathname === '/api/sync/cloud-hydrate' && method === 'POST') {
    const payload = body as Partial<StoreData>;
    const store = loadLocalStore(storage);
    if (Array.isArray(payload.classes) && payload.classes.length > 0) {
      const map = new Map(store.classes.map((c) => [c.id, c]));
      for (const c of payload.classes) if (c?.id && c?.name) map.set(c.id, c);
      store.classes = Array.from(map.values());
    }
    if (Array.isArray(payload.lessons) && payload.lessons.length > 0) {
      const map = new Map(store.lessons.map((l) => [l.id, l]));
      for (const l of payload.lessons) {
        if (l?.id && l?.title && Array.isArray(l.questions) && l.questions.length > 0) {
          map.set(l.id, l);
        }
      }
      store.lessons = Array.from(map.values());
    }
    if (Array.isArray(payload.submissions) && payload.submissions.length > 0) {
      const map = new Map(store.submissions.map((s) => [s.id, s]));
      for (const s of payload.submissions) if (s?.id) map.set(s.id, s);
      store.submissions = Array.from(map.values());
    }
    if (Array.isArray(payload.notifications) && payload.notifications.length > 0) {
      const map = new Map(store.notifications.map((n) => [n.id, n]));
      for (const n of payload.notifications) if (n?.id) map.set(n.id, n);
      store.notifications = Array.from(map.values());
    }
    if (Array.isArray(payload.activityLogs) && payload.activityLogs.length > 0) {
      const map = new Map(store.activityLogs.map((l) => [l.id, l]));
      for (const l of payload.activityLogs) if (l?.id) map.set(l.id, l);
      store.activityLogs = Array.from(map.values())
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 200);
    }
    saveLocalStore(store, storage);
    return { ok: true, status: 200, data: { ok: true } };
  }

  // POST /api/classes
  if (pathname === '/api/classes' && method === 'POST') {
    const { id, name, grade, teacherName } = body as Partial<ClassRoom>;
    const cleanId = normalizeClassCode(id ?? '');
    if (!cleanId || !name?.trim()) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Vui lòng nhập Mã lớp (không dấu) và Tên lớp học.' },
      };
    }
    const store = loadLocalStore(storage);
    const existing = store.classes.find((c) => c.id === cleanId);
    let savedClass: ClassRoom;
    if (existing) {
      existing.name = name.trim();
      existing.grade = grade?.trim() || existing.grade;
      existing.teacherName = teacherName?.trim() || existing.teacherName;
      savedClass = existing;
    } else {
      savedClass = {
        id: cleanId,
        name: name.trim(),
        grade: grade?.trim() || 'Khối 5',
        teacherName: teacherName?.trim() || 'Giáo viên',
        createdAt: new Date().toISOString(),
      };
      store.classes.unshift(savedClass);
    }
    saveLocalStore(store, storage);
    return {
      ok: true,
      status: 200,
      data: { classes: store.classes, createdId: cleanId, classRoom: savedClass },
    };
  }

  // PUT / DELETE /api/classes/:id
  const classMatch = pathname.match(/^\/api\/classes\/([^/]+)$/);
  if (classMatch && method === 'PUT') {
    const oldId = decodeURIComponent(classMatch[1]);
    const { newId, name, grade, teacherName } = body as Partial<ClassRoom> & {
      newId?: string;
    };
    if (!name?.trim()) {
      return { ok: false, status: 400, data: { error: 'Tên lớp học không được để trống.' } };
    }
    const store = loadLocalStore(storage);
    const target = store.classes.find((c) => c.id === oldId);
    if (!target) {
      return { ok: false, status: 404, data: { error: 'Không tìm thấy lớp học cần chỉnh sửa.' } };
    }
    const nextId = newId?.trim() ? normalizeClassCode(newId) : oldId;
    if (!nextId) {
      return { ok: false, status: 400, data: { error: 'Mã lớp mới không hợp lệ.' } };
    }
    if (nextId !== oldId) {
      if (store.classes.some((c) => c.id === nextId)) {
        return { ok: false, status: 409, data: { error: `Mã lớp "${nextId}" đã tồn tại.` } };
      }
      target.id = nextId;
      for (const lesson of store.lessons) {
        lesson.assignedClassIds = Array.from(
          new Set(lesson.assignedClassIds.map((cid) => (cid === oldId ? nextId : cid))),
        );
      }
      for (const sub of store.submissions) if (sub.classId === oldId) sub.classId = nextId;
      for (const notif of store.notifications) if (notif.classId === oldId) notif.classId = nextId;
      for (const log of store.activityLogs) if (log.classId === oldId) log.classId = nextId;
    }
    target.name = name.trim();
    target.grade = grade?.trim() || target.grade;
    target.teacherName = teacherName?.trim() || target.teacherName;
    saveLocalStore(store, storage);
    return {
      ok: true,
      status: 200,
      data: { classRoom: target, classes: store.classes, oldId },
    };
  }

  if (classMatch && method === 'DELETE') {
    const classId = decodeURIComponent(classMatch[1]);
    const store = loadLocalStore(storage);
    if (!store.classes.some((c) => c.id === classId)) {
      return { ok: false, status: 404, data: { error: 'Không tìm thấy lớp học.' } };
    }
    if (store.classes.length <= 1) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Cần giữ lại ít nhất 1 lớp học trong hệ thống.' },
      };
    }
    store.classes = store.classes.filter((c) => c.id !== classId);
    for (const lesson of store.lessons) {
      lesson.assignedClassIds = lesson.assignedClassIds.filter((cid) => cid !== classId);
    }
    saveLocalStore(store, storage);
    return { ok: true, status: 200, data: { ok: true, classes: store.classes } };
  }

  // POST /api/lessons/generate (static hosting notice)
  if (pathname === '/api/lessons/generate' && method === 'POST') {
    const lang = (body as { language?: Language }).language === 'en' ? 'en' : 'vi';
    return {
      ok: false,
      status: 503,
      data: {
        error:
          lang === 'vi'
            ? 'Trang đang chạy trên máy chủ tĩnh GitHub Pages (không có Node.js để gọi Gemini AI trực tiếp). Thầy/cô có thể: (1) Tạo bộ đề AI trên AI Studio rồi đồng bộ Firestore hoặc Xuất/Nhập file JSON sang đây, hoặc (2) Chỉnh sửa trực tiếp kho bài học có sẵn.'
            : 'Running on static GitHub Pages (no backend server for Gemini AI). Generate lessons in AI Studio and sync via Firestore or JSON Export/Import, or edit existing lessons directly.',
      },
    };
  }

  // POST /api/lessons/:id/assign
  const assignMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/assign$/);
  if (assignMatch && method === 'POST') {
    const lessonId = decodeURIComponent(assignMatch[1]);
    const { classIds } = body as { classIds?: string[] };
    const store = loadLocalStore(storage);
    const lesson = store.lessons.find((l) => l.id === lessonId);
    if (!lesson) {
      return { ok: false, status: 404, data: { error: 'Không tìm thấy bài học.' } };
    }
    const previous = new Set(lesson.assignedClassIds);
    const nextList = Array.from(new Set(classIds ?? []));
    lesson.assignedClassIds = nextList;
    for (const cid of nextList) {
      if (!previous.has(cid)) {
        store.notifications.unshift({
          id: `notif-${Date.now()}-${cid}`,
          classId: cid,
          lessonId: lesson.id,
          title: `Bài tập mới: ${lesson.title}`,
          message: `Bài học "${lesson.title}" vừa được giao thêm cho lớp ${cid}!`,
          createdAt: new Date().toISOString(),
          readByGroupIds: [],
        });
      }
    }
    saveLocalStore(store, storage);
    return { ok: true, status: 200, data: { lesson } };
  }

  // PUT / DELETE /api/lessons/:id
  const lessonMatch = pathname.match(/^\/api\/lessons\/([^/]+)$/);
  if (lessonMatch && method === 'PUT') {
    const lessonId = decodeURIComponent(lessonMatch[1]);
    const { title, topic, summary, assignedClassIds, questions } = body as Partial<Lesson>;
    if (!title?.trim()) {
      return { ok: false, status: 400, data: { error: 'Tên bài học không được để trống.' } };
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      return { ok: false, status: 400, data: { error: 'Bài học cần có ít nhất 1 câu hỏi.' } };
    }
    const store = loadLocalStore(storage);
    const lesson = store.lessons.find((l) => l.id === lessonId);
    if (!lesson) {
      return { ok: false, status: 404, data: { error: 'Không tìm thấy bài học cần chỉnh sửa.' } };
    }
    const sanitizedQuestions: Question[] = questions.map((q, idx) => {
      const compIds =
        Array.isArray(q.competencyIds) && q.competencyIds.length > 0
          ? q.competencyIds
          : [q.competencyId || '1.1'];
      const qType: QuestionType =
        q.type === 'fill_blank' || q.type === 'short_answer'
          ? q.type
          : 'multiple_choice';
      const cleanedOptions =
        qType === 'multiple_choice'
          ? (q.options ?? []).map((opt) => opt.trim()).filter(Boolean)
          : undefined;
      return {
        id: q.id?.trim() || `${lessonId}-q${idx + 1}`,
        type: qType,
        questionText: (q.questionText ?? '').trim(),
        ...(cleanedOptions && cleanedOptions.length >= 2 ? { options: cleanedOptions } : {}),
        aiSearchKeywordHint: (q.aiSearchKeywordHint ?? '').trim() || 'công dân số TT 02/2025',
        correctAnswer: (q.correctAnswer ?? '').trim(),
        competencyId: compIds[0],
        competencyIds: compIds,
        explanation: (q.explanation ?? '').trim(),
      };
    });
    if (sanitizedQuestions.some((q) => !q.questionText || !q.correctAnswer)) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Mỗi câu hỏi cần có đầy đủ nội dung câu hỏi và đáp án đúng.' },
      };
    }
    lesson.title = title.trim();
    lesson.topic = topic?.trim() || lesson.topic;
    lesson.summary = summary?.trim() ?? lesson.summary;
    lesson.assignedClassIds = Array.isArray(assignedClassIds)
      ? Array.from(new Set(assignedClassIds))
      : lesson.assignedClassIds;
    lesson.questions = sanitizedQuestions;
    saveLocalStore(store, storage);
    return { ok: true, status: 200, data: { lesson } };
  }

  if (lessonMatch && method === 'DELETE') {
    const lessonId = decodeURIComponent(lessonMatch[1]);
    const store = loadLocalStore(storage);
    store.lessons = store.lessons.filter((l) => l.id !== lessonId);
    saveLocalStore(store, storage);
    return { ok: true, status: 200, data: { ok: true } };
  }

  // POST /api/quiz/submit
  if (pathname === '/api/quiz/submit' && method === 'POST') {
    const item = body as {
      classId: string;
      tabletNumber: number;
      groupName: string;
      lessonId: string;
      questionId: string;
      userAnswer: string;
      elapsedMs: number;
      lang?: Language;
    };
    const store = loadLocalStore(storage);
    const lang: Language = item.lang === 'en' ? 'en' : 'vi';
    const submission = gradeOneLocally(store, item, lang, false);
    if (!submission) {
      return { ok: false, status: 404, data: { error: 'Không tìm thấy câu hỏi tương ứng.' } };
    }
    saveLocalStore(store, storage);
    const leaderboard = buildLeaderboard(item.classId, store.submissions, lang);
    return { ok: true, status: 200, data: { submission, leaderboard } };
  }

  // POST /api/quiz/sync
  if (pathname === '/api/quiz/sync' && method === 'POST') {
    const { items, lang } = body as { items?: OfflineQueueItem[]; lang?: Language };
    const store = loadLocalStore(storage);
    const resolvedLang: Language = lang === 'en' ? 'en' : 'vi';
    const synced: AnswerSubmission[] = [];
    for (const item of items ?? []) {
      const sub = gradeOneLocally(store, item, resolvedLang, true);
      if (sub) synced.push(sub);
    }
    saveLocalStore(store, storage);
    const classId = items?.[0]?.classId || store.classes[0]?.id || 'LOP-5A';
    const leaderboard = buildLeaderboard(classId, store.submissions, resolvedLang);
    return { ok: true, status: 200, data: { synced, leaderboard } };
  }

  // POST /api/notifications/read
  if (pathname === '/api/notifications/read' && method === 'POST') {
    const { notificationId, groupId } = body as {
      notificationId?: string;
      groupId?: string;
    };
    const store = loadLocalStore(storage);
    const target = store.notifications.find((n) => n.id === notificationId);
    if (target && groupId && !target.readByGroupIds.includes(groupId)) {
      target.readByGroupIds.push(groupId);
      saveLocalStore(store, storage);
    }
    return { ok: true, status: 200, data: { ok: true } };
  }

  // GET /api/export
  if (pathname === '/api/export' && method === 'GET') {
    const store = loadLocalStore(storage);
    const classId = parsedUrl.searchParams.get('classId') || store.classes[0]?.id || 'LOP-5A';
    const lang: Language = parsedUrl.searchParams.get('lang') === 'en' ? 'en' : 'vi';
    const leaderboard = buildLeaderboard(classId, store.submissions, lang);
    return {
      ok: true,
      status: 200,
      data: {
        exportedAt: new Date().toISOString(),
        ClassID: classId,
        rankings: leaderboard.map((row) => ({
          ClassID: row.ClassID,
          GroupID: row.GroupID,
          Score: row.Score,
          Rank: row.Rank,
          SkillLevel: row.SkillLevel,
          AccuracyPercent: row.accuracyPercent,
          AvgTimeSeconds: Number((row.avgElapsedMs / 1000).toFixed(1)),
        })),
      },
    };
  }

  return { ok: false, status: 404, data: { error: 'Not found' } };
}
