import firebaseConfig from '../../firebase-applet-config.json';
import { getCompetencyById } from '../shared/competencies';
import {
  AnswerEvaluation,
  buildCompetencyMatrix,
  buildDomainChampions,
  buildGradingFeedback,
  buildLeaderboard,
  calculatePoints,
  clampElapsedMs,
  evaluateAnswerMatch,
  formatGroupId,
} from '../shared/scoring';
import {
  AdminSecurityConfig,
  createDefaultAdminSecurity,
  createEmptyStore,
  PRIMARY_ADMIN_EMAIL,
  StoreData,
} from '../shared/seedData';
import {
  ActivityLog,
  AnswerSubmission,
  AssessmentExerciseOutcome,
  AssessmentLevel,
  AssessmentSessionAttempt,
  AssessmentSessionMode,
  ClassRoom,
  Language,
  LearnerGradeBand,
  LearnerProfile,
  Lesson,
  OfflineQueueItem,
  PushNotification,
  Question,
  QuestionType,
  TeacherAward,
} from '../shared/types';
import {
  createTeacherAwardInStore,
  deleteTeacherAwardInStore,
  ensureLearnerCollections,
  getPublicHonorFromStore,
  hydrateLearnerProfileInStore,
  isValidGuestLearnerUid,
  recordAssessmentAttemptInStore,
  upsertLearnerProfileInStore,
} from '../shared/learnerStoreOps';
import {
  applyAuthoritativeCloudHydrate,
  CloudHydratePayload,
  dedupeById,
  DEFAULT_PUBLIC_WORKSPACE_ID,
  isDefaultSeedClassesOnly,
  isDemoSeedArtifactId,
  isDemoSeedClass,
  isLessonAssignedToClass,
  LEGACY_FALLBACK_WORKSPACE_ID,
  mergeLatestSubmissions,
  mergeSubmissionActivityLogs,
  normalizeClassCode,
  sanitizeStoreRemoveDemoArtifacts,
} from './firestoreHelpers';
import {
  fetchPublicSubmissionsViaRest,
  fetchPublicWorkspaceSnapshot,
  writePublicSubmissionViaRest,
} from './publicFirestoreRest';
import {
  hashPinWebCrypto,
  validateTeacherPin,
  verifyPinWebCrypto,
} from './pinCrypto';
import { recoverMissingCorrectAnswers } from './answerRecovery';
import {
  loadStudentPublicMemory,
  saveStudentPublicMemory,
} from './studentPublicMemory';

const STATIC_STORE_KEY = 'edubot_static_store_v1';
const SYNC_SNAPSHOT_KEY = 'edubot_cloud_sync_snapshot_v1';

interface LocalAdminSession {
  role: 'admin' | 'teacher';
  method: 'pin' | 'google';
  email?: string;
  tv: number;
  exp: number;
}

const localSessions = new Map<string, LocalAdminSession>();
let localFailedPinCount = 0;
let localPinLockUntil = 0;

function ensureLocalAdminSecurity(existing?: AdminSecurityConfig): AdminSecurityConfig {
  // Static/GitHub Pages defaults to Admin-Only Google mode so students on shared tablets
  // cannot hijack first-run PIN setup on a fresh browser.
  const base = createDefaultAdminSecurity(true);
  if (!existing) return base;
  const emails = new Set<string>([PRIMARY_ADMIN_EMAIL.toLowerCase()]);
  for (const e of existing.adminEmails ?? []) {
    const clean = String(e || '').trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) emails.add(clean);
  }
  return {
    pinHash: existing.pinHash,
    adminOnlyMode: Boolean(existing.adminOnlyMode),
    adminEmails: Array.from(emails),
    tokenVersion:
      typeof existing.tokenVersion === 'number' && existing.tokenVersion >= 1
        ? existing.tokenVersion
        : 1,
    updatedAt: existing.updatedAt,
  };
}

function issueLocalToken(session: Omit<LocalAdminSession, 'exp'>): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const token = `local_${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
  localSessions.set(token, {
    ...session,
    exp: Date.now() + 12 * 60 * 60 * 1000,
  });
  return token;
}

function verifyLocalToken(
  token: string | undefined,
  expectedTv: number,
): LocalAdminSession | null {
  if (!token) return null;
  const rec = localSessions.get(token);
  if (!rec) return null;
  if (rec.exp < Date.now() || rec.tv !== expectedTv) {
    localSessions.delete(token);
    return null;
  }
  return rec;
}

async function verifyGoogleIdTokenStatic(
  idToken: string,
): Promise<{ uid: string; email: string; emailVerified: boolean } | null> {
  if (!idToken || !firebaseConfig?.apiKey) return null;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
        firebaseConfig.apiKey,
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
    };
    const u = data.users?.[0];
    if (!u?.email || !u?.localId) return null;
    return {
      uid: u.localId,
      email: u.email.toLowerCase(),
      emailVerified: Boolean(u.emailVerified),
    };
  } catch {
    return null;
  }
}

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
let activePublicWorkspaceId: string = DEFAULT_PUBLIC_WORKSPACE_ID;

export function resetLocalHydrationCache(): void {
  hydratedWorkspaceCache.clear();
  activePublicWorkspaceId = DEFAULT_PUBLIC_WORKSPACE_ID;
}

export function loadLocalStore(storage: StorageLike = defaultStorage): StoreData {
  const tryParse = (raw: string | null): StoreData | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoreData;
      if (Array.isArray(parsed.classes) && Array.isArray(parsed.lessons)) {
        const { changed } = sanitizeStoreRemoveDemoArtifacts(parsed);
        parsed.lessons = recoverMissingCorrectAnswers(parsed.lessons);
        if (changed) {
          saveLocalStore(parsed, storage);
        }
        return parsed;
      }
    } catch {
      // ignore corrupted entry
    }
    return null;
  };

  // 1) Primary local store
  const primary = tryParse(storage.getItem(STATIC_STORE_KEY));
  if (primary) return primary;

  // 2) Restore from durable Cloud Sync Snapshot if primary store was cleared (prevents data loss!)
  const snapshot = tryParse(storage.getItem(SYNC_SNAPSHOT_KEY));
  if (snapshot) {
    saveLocalStore(snapshot, storage);
    return snapshot;
  }

  // 3) Restore from dedicated Student Public Memory if available (decoupled from Admin session!)
  const studentMem = loadStudentPublicMemory(storage);
  if (studentMem) {
    const hydratedFromStudentMem = createEmptyStore();
    hydratedFromStudentMem.classes = studentMem.classes;
    hydratedFromStudentMem.lessons = studentMem.lessons;
    hydratedFromStudentMem.notifications = studentMem.notifications;
    saveLocalStore(hydratedFromStudentMem, storage);
    return hydratedFromStudentMem;
  }

  // 4) Clean empty store — NEVER create fake/virtual LOP-5A/5B/6A classes!
  const empty = createEmptyStore();
  saveLocalStore(empty, storage);
  return empty;
}

export function saveLocalStore(
  data: StoreData,
  storage: StorageLike = defaultStorage,
): void {
  sanitizeStoreRemoveDemoArtifacts(data);
  try {
    const serialized = JSON.stringify(data);
    storage.setItem(STATIC_STORE_KEY, serialized);
    // Keep a durable Cloud Sync Snapshot backup whenever real synced data exists
    if (data.syncMeta || data.classes.length > 0 || data.lessons.length > 0) {
      storage.setItem(SYNC_SNAPSHOT_KEY, serialized);
    }
  } catch {
    // ignore storage quota errors
  }
}

async function hydrateLocalFromPublicWorkspace(
  workspaceCode: string,
  storage: StorageLike,
  options: { replaceContent: boolean; forceRefresh?: boolean } = { replaceContent: true },
): Promise<string | null> {
  const cacheKey = `${workspaceCode.trim() || '__default__'}::${options.replaceContent ? 'full' : 'subs'}`;
  const lastFetched = hydratedWorkspaceCache.get(cacheKey) ?? 0;
  if (!options.forceRefresh && Date.now() - lastFetched < 5_000) {
    return activePublicWorkspaceId;
  }

  try {
    const snapshot = await fetchPublicWorkspaceSnapshot(firebaseConfig, workspaceCode || null);
    const resolvedWsId = snapshot?.workspaceId || workspaceCode.trim() || activePublicWorkspaceId;
    if (snapshot) {
      activePublicWorkspaceId = snapshot.workspaceId;
    }

    const store = loadLocalStore(storage);
    const studentMem = loadStudentPublicMemory(storage);
    let changed = false;

    if (snapshot && options.replaceContent) {
      const cleanSnapClasses = dedupeById(
        snapshot.classes.filter((c) => Boolean(c?.id && c?.name) && !isDemoSeedClass(c)),
      );
      if (cleanSnapClasses.length > 0) {
        store.classes = cleanSnapClasses;
        changed = true;
      }
      if (snapshot.lessons.length > 0) {
        store.lessons = dedupeById(
          recoverMissingCorrectAnswers(snapshot.lessons, [
            ...store.lessons,
            ...(studentMem?.lessons ?? []),
          ]),
        );
        changed = true;
      } else if (store.lessons.length === 0 && studentMem && studentMem.lessons.length > 0) {
        // Cloud had classes but 0 lessons yet — preserve dedicated Student Public Memory lessons
        store.lessons = dedupeById(studentMem.lessons);
        changed = true;
      }
      if (snapshot.notifications && snapshot.notifications.length > 0) {
        const activeClassIds = new Set(store.classes.map((c) => c.id));
        const readMap = new Map(
          store.notifications.map((n) => [n.id, new Set(n.readByGroupIds ?? [])]),
        );
        store.notifications = dedupeById(
          snapshot.notifications
            .filter(
              (n) =>
                Boolean(n?.id) &&
                !isDemoSeedArtifactId(n.id) &&
                (!n.classId || activeClassIds.size === 0 || activeClassIds.has(n.classId)),
            )
            .map((n) => {
              const existingRead = readMap.get(n.id);
              const mergedRead = Array.from(
                new Set([
                  ...(n.readByGroupIds ?? []),
                  ...(existingRead ? Array.from(existingRead) : []),
                ]),
              );
              return { ...n, readByGroupIds: mergedRead };
            }),
        );
        changed = true;
      }

      // Mirror freshly fetched cloud data into dedicated Student Public Memory for offline/admin-disconnected resilience
      if (store.classes.length > 0 || store.lessons.length > 0) {
        saveStudentPublicMemory(
          {
            classes: store.classes,
            lessons: store.lessons,
            notifications: store.notifications,
            workspaceId: resolvedWsId,
          },
          storage,
        );
      }
    } else if (!snapshot && options.replaceContent && studentMem) {
      // Cloud unavailable / Admin disconnected -> fall back cleanly to dedicated Student Public Memory!
      if (store.classes.length === 0 && studentMem.classes.length > 0) {
        store.classes = studentMem.classes;
        changed = true;
      }
      if (store.lessons.length === 0 && studentMem.lessons.length > 0) {
        store.lessons = studentMem.lessons;
        changed = true;
      }
      if (store.notifications.length === 0 && studentMem.notifications.length > 0) {
        store.notifications = studentMem.notifications;
        changed = true;
      }
    }

    // Fetch live student submissions from the resolved workspace (and legacy fallback if active is default)
    const subSources = Array.from(
      new Set(
        resolvedWsId === DEFAULT_PUBLIC_WORKSPACE_ID
          ? [DEFAULT_PUBLIC_WORKSPACE_ID, LEGACY_FALLBACK_WORKSPACE_ID]
          : [resolvedWsId],
      ),
    );
    const cloudSubs: AnswerSubmission[] = [];
    for (const wsId of subSources) {
      const rows = await fetchPublicSubmissionsViaRest(firebaseConfig, wsId);
      if (rows.length > 0) {
        cloudSubs.push(...rows.filter((s) => !isDemoSeedArtifactId(s.id)));
      }
    }

    if (cloudSubs.length > 0) {
      store.submissions = mergeLatestSubmissions(store.submissions, cloudSubs);
      store.activityLogs = mergeSubmissionActivityLogs(store.activityLogs, store.submissions);
      changed = true;
    }

    const sanitized = sanitizeStoreRemoveDemoArtifacts(store);
    if (sanitized.changed) changed = true;

    if (changed || snapshot) {
      store.syncMeta = {
        lastSyncedAt: new Date().toISOString(),
        source: 'public_workspace',
        workspaceId: resolvedWsId,
        ownerUid: store.syncMeta?.ownerUid,
        ownerEmail: store.syncMeta?.ownerEmail,
        classesCount: store.classes.length,
        lessonsCount: store.lessons.length,
        submissionsCount: store.submissions.length,
        notificationsCount: store.notifications.length,
        learnersCount: Array.isArray(store.learnerProfiles) ? store.learnerProfiles.length : 0,
        syncRevision: (store.syncMeta?.syncRevision ?? 0) + (changed ? 1 : 0),
      };
      saveLocalStore(store, storage);
    }
    hydratedWorkspaceCache.set(cacheKey, Date.now());
    return resolvedWsId;
  } catch {
    return activePublicWorkspaceId;
  }
}

type LocalGradeResult =
  | {
      status: 'ok';
      submission: AnswerSubmission;
      alreadySubmitted?: boolean;
      evaluation?: AnswerEvaluation;
    }
  | { status: 'forbidden' }
  | { status: 'not_found' };

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
): LocalGradeResult {
  const lesson = store.lessons.find((l) => l.id === item.lessonId);
  const question = lesson?.questions.find((q) => q.id === item.questionId);
  if (!lesson || !question) return { status: 'not_found' };

  if (
    item.classId &&
    lesson.assignedClassIds.length > 0 &&
    !isLessonAssignedToClass(lesson, item.classId)
  ) {
    return { status: 'forbidden' };
  }

  const groupId = formatGroupId(item.tabletNumber, item.groupName);

  // Official 1st-attempt lock: preserve the first recorded submission for this group + question
  const existing = store.submissions.find(
    (s) =>
      s.classId === item.classId &&
      s.groupId === groupId &&
      s.lessonId === lesson.id &&
      s.questionId === question.id,
  );
  if (existing) {
    return {
      status: 'ok',
      alreadySubmitted: true,
      submission: {
        ...existing,
        feedbackText:
          lang === 'en'
            ? `Your team (${item.groupName}) already submitted this question earlier (${existing.totalPoints} pts). First official attempt is locked so scores stay fair.`
            : `Nhóm ${item.groupName} đã hoàn thành câu này trước đó (${existing.totalPoints} điểm). Hệ thống giữ nguyên kết quả lần nộp đầu tiên để không bị cộng trùng hoặc ghi đè điểm.`,
      },
    };
  }

  let resolvedCorrectAnswer = question.correctAnswer ?? '';
  if (!resolvedCorrectAnswer.trim()) {
    const healedLesson = recoverMissingCorrectAnswers([lesson])[0];
    const healedQuestion = healedLesson?.questions.find((q) => q.id === item.questionId);
    if (healedQuestion?.correctAnswer?.trim()) {
      resolvedCorrectAnswer = healedQuestion.correctAnswer.trim();
      question.correctAnswer = resolvedCorrectAnswer;
    }
  }

  const comp = getCompetencyById(question.competencyId);
  const safeElapsedMs = clampElapsedMs(item.elapsedMs, question.type);
  const evaluation = evaluateAnswerMatch(
    item.userAnswer,
    resolvedCorrectAnswer,
    question.type,
    question.options,
  );
  const isCorrect = evaluation.isCorrect;
  const breakdown = calculatePoints(
    isCorrect,
    safeElapsedMs,
    question.type,
    evaluation.creditFactor,
  );
  const feedbackText = buildGradingFeedback(
    item.groupName,
    evaluation,
    breakdown,
    lang,
  );

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
    elapsedMs: safeElapsedMs,
    submittedAt: item.submittedAt || new Date().toISOString(),
    feedbackText,
    explanation: question.explanation,
    syncedFromOffline,
  };

  store.submissions.push(submission);

  const isPartial = evaluation.matchTier === 'fuzzy_partial';
  store.activityLogs.unshift({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    classId: submission.classId,
    groupId: submission.groupId,
    action: syncedFromOffline
      ? isCorrect
        ? isPartial
          ? 'Đồng bộ ngoại tuyến · Gần đúng'
          : 'Đồng bộ ngoại tuyến · Đúng'
        : 'Đồng bộ ngoại tuyến · Chưa đúng'
      : isCorrect
        ? isPartial
          ? 'Trả lời gần đúng (Khuyến khích)'
          : 'Trả lời đúng'
        : 'Trả lời chưa đúng',
    detail: `Năng lực ${comp.id} (${comp.nameVi}) · ${(submission.elapsedMs / 1000).toFixed(1)}s`,
    competencyId: submission.competencyId,
    pointsDelta: submission.totalPoints,
    timestamp: submission.submittedAt,
  });

  return { status: 'ok', submission, evaluation };
}

export interface LocalApiResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export async function handleLocalApi(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    authToken?: string;
    learnerToken?: string;
  } = {},
  storage: StorageLike = defaultStorage,
): Promise<LocalApiResult> {
  const method = (options.method || 'GET').toUpperCase();
  const parsedUrl = new URL(url, 'http://local.edubot');
  const pathname = parsedUrl.pathname;
  const body =
    typeof options.body === 'string'
      ? JSON.parse(options.body || '{}')
      : (options.body ?? {});

  const getLocalAuth = (store: StoreData): LocalAdminSession | null => {
    const sec = ensureLocalAdminSecurity(store.adminSecurity);
    return verifyLocalToken(options.authToken, sec.tokenVersion);
  };

  // GET /api/auth/domains
  if (pathname === '/api/auth/domains' && method === 'GET') {
    return {
      ok: true,
      status: 200,
      data: {
        projectId: firebaseConfig?.projectId || '',
        authDomain: firebaseConfig?.authDomain || '',
        devAppUrl: '',
        sharedAppUrl: '',
        callbackUrls: firebaseConfig?.authDomain
          ? [`https://${firebaseConfig.authDomain}/__/auth/handler`]
          : [],
      },
    };
  }

  // GET /api/teacher/auth-status
  if (pathname === '/api/teacher/auth-status' && method === 'GET') {
    const store = loadLocalStore(storage);
    const sec = ensureLocalAdminSecurity(store.adminSecurity);
    const auth = verifyLocalToken(options.authToken, sec.tokenVersion);
    return {
      ok: true,
      status: 200,
      data: {
        pinConfigured: Boolean(sec.pinHash),
        pinLockedByEnv: false,
        adminOnlyMode: sec.adminOnlyMode,
        adminEmails: auth ? sec.adminEmails : [],
        primaryAdminEmail: PRIMARY_ADMIN_EMAIL,
        // Never allow anonymous first-run PIN setup on static GitHub Pages browsers
        canFirstRunSetup: false,
        isAuthenticated: Boolean(auth),
        authMethod: auth?.method ?? null,
        adminEmail: auth?.email ?? null,
        devAppUrl: '',
        sharedAppUrl: '',
      },
    };
  }

  // POST /api/teacher/setup-pin (disabled on static host — require Google Admin first)
  if (pathname === '/api/teacher/setup-pin' && method === 'POST') {
    return {
      ok: false,
      status: 403,
      data: {
        error:
          'Trên chế độ tĩnh (GitHub Pages), vui lòng đăng nhập bằng tài khoản Google Admin để thiết lập hoặc đổi mã PIN.',
      },
    };
  }

  // POST /api/teacher/verify-pin
  if (pathname === '/api/teacher/verify-pin' && method === 'POST') {
    if (localPinLockUntil > Date.now()) {
      const wait = Math.ceil((localPinLockUntil - Date.now()) / 1000);
      return {
        ok: false,
        status: 429,
        data: { error: `Nhập sai quá nhiều lần. Vui lòng thử lại sau ${wait} giây.` },
      };
    }
    const store = loadLocalStore(storage);
    const sec = ensureLocalAdminSecurity(store.adminSecurity);
    if (sec.adminOnlyMode || !sec.pinHash) {
      return {
        ok: false,
        status: 403,
        data: {
          error:
            'Chế độ Chỉ Admin Google đang bật. Vui lòng đăng nhập bằng tài khoản Google Admin.',
        },
      };
    }
    const pin = String((body as { pin?: string }).pin ?? '').trim();
    const ok = await verifyPinWebCrypto(pin, sec.pinHash);
    if (!ok) {
      localFailedPinCount += 1;
      if (localFailedPinCount >= 5) {
        localPinLockUntil = Date.now() + 60_000;
      }
      return {
        ok: false,
        status: 401,
        data: { error: 'Mã PIN Giáo viên chưa đúng. Vui lòng thử lại.' },
      };
    }
    localFailedPinCount = 0;
    localPinLockUntil = 0;
    const token = issueLocalToken({
      role: 'teacher',
      method: 'pin',
      tv: sec.tokenVersion,
    });
    return { ok: true, status: 200, data: { ok: true, token, authMethod: 'pin' } };
  }

  // POST /api/teacher/verify-google
  if (pathname === '/api/teacher/verify-google' && method === 'POST') {
    const { idToken } = body as { idToken?: string };
    if (!idToken) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Thiếu mã xác thực Google.' },
      };
    }
    const verified = await verifyGoogleIdTokenStatic(idToken);
    if (!verified || !verified.emailVerified) {
      return {
        ok: false,
        status: 401,
        data: { error: 'Không thể xác thực tài khoản Google. Vui lòng đăng nhập lại.' },
      };
    }
    const store = loadLocalStore(storage);
    const sec = ensureLocalAdminSecurity(store.adminSecurity);
    if (!sec.adminEmails.includes(verified.email)) {
      return {
        ok: false,
        status: 403,
        data: {
          error: `Tài khoản ${verified.email} không có quyền Quản trị / Giáo viên. Học sinh chỉ được truy cập Cổng Học sinh.`,
        },
      };
    }
    const token = issueLocalToken({
      role: 'admin',
      method: 'google',
      email: verified.email,
      tv: sec.tokenVersion,
    });
    return {
      ok: true,
      status: 200,
      data: { ok: true, token, authMethod: 'google', adminEmail: verified.email },
    };
  }

  // POST /api/teacher/change-pin
  if (pathname === '/api/teacher/change-pin' && method === 'POST') {
    const store = loadLocalStore(storage);
    const sec = ensureLocalAdminSecurity(store.adminSecurity);
    const auth = verifyLocalToken(options.authToken, sec.tokenVersion);
    if (!auth) {
      return {
        ok: false,
        status: 401,
        data: { error: 'Vui lòng đăng nhập Giáo viên / Admin trước.' },
      };
    }
    const { currentPin, newPin } = body as { currentPin?: string; newPin?: string };
    if (auth.method !== 'google' && sec.pinHash) {
      const okCurrent = await verifyPinWebCrypto(
        String(currentPin ?? '').trim(),
        sec.pinHash,
      );
      if (!okCurrent) {
        return {
          ok: false,
          status: 401,
          data: { error: 'Mã PIN hiện tại không chính xác.' },
        };
      }
    }
    const cleanNewPin = String(newPin ?? '').trim();
    const check = validateTeacherPin(cleanNewPin, 'vi');
    if (!check.valid) {
      return { ok: false, status: 400, data: { error: check.reason } };
    }
    sec.pinHash = await hashPinWebCrypto(cleanNewPin);
    sec.tokenVersion += 1;
    sec.updatedAt = new Date().toISOString();
    store.adminSecurity = sec;
    saveLocalStore(store, storage);
    const freshToken = issueLocalToken({
      role: auth.role,
      method: auth.method,
      email: auth.email,
      tv: sec.tokenVersion,
    });
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        token: freshToken,
        message: 'Đã cập nhật mã PIN Giáo viên mới thành công.',
      },
    };
  }

  // PUT /api/teacher/security-settings
  if (pathname === '/api/teacher/security-settings' && method === 'PUT') {
    const store = loadLocalStore(storage);
    const sec = ensureLocalAdminSecurity(store.adminSecurity);
    const auth = verifyLocalToken(options.authToken, sec.tokenVersion);
    if (!auth) {
      return {
        ok: false,
        status: 401,
        data: { error: 'Vui lòng đăng nhập Giáo viên / Admin trước.' },
      };
    }
    const { adminOnlyMode, adminEmails } = body as {
      adminOnlyMode?: boolean;
      adminEmails?: string[];
    };
    if (typeof adminOnlyMode === 'boolean') {
      sec.adminOnlyMode = adminOnlyMode;
    }
    if (Array.isArray(adminEmails)) {
      const set = new Set<string>([PRIMARY_ADMIN_EMAIL.toLowerCase()]);
      for (const e of adminEmails) {
        const clean = String(e || '').trim().toLowerCase();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) set.add(clean);
      }
      sec.adminEmails = Array.from(set);
    }
    sec.tokenVersion += 1;
    sec.updatedAt = new Date().toISOString();
    store.adminSecurity = sec;
    saveLocalStore(store, storage);
    const freshToken = issueLocalToken({
      role: auth.role,
      method: auth.method,
      email: auth.email,
      tv: sec.tokenVersion,
    });
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        token: freshToken,
        adminOnlyMode: sec.adminOnlyMode,
        adminEmails: sec.adminEmails,
        primaryAdminEmail: PRIMARY_ADMIN_EMAIL,
      },
    };
  }

  // GET /api/bootstrap
  if (pathname === '/api/bootstrap' && method === 'GET') {
    const ws = parsedUrl.searchParams.get('ws') || '';
    const forceRefresh = parsedUrl.searchParams.get('refresh') === '1';
    const preStore = loadLocalStore(storage);
    const includeAnswers =
      parsedUrl.searchParams.get('role') === 'teacher' && Boolean(getLocalAuth(preStore));

    const storeIsOnlyDemoSeed = isDefaultSeedClassesOnly(preStore.classes);
    // Student / unauthenticated requests ALWAYS hydrate authoritative teacher classes, lessons,
    // notifications & live submissions from Firestore (no Google/Firebase login required!).
    // Authenticated teacher requests also hydrate when the local store only holds starter demo classes (5A/5B/6A).
    const resolvedWsId = await hydrateLocalFromPublicWorkspace(ws, storage, {
      replaceContent: !includeAnswers || storeIsOnlyDemoSeed,
      forceRefresh: forceRefresh || storeIsOnlyDemoSeed,
    });

    const store = loadLocalStore(storage);
    const classId = parsedUrl.searchParams.get('classId') || '';
    const lessonIdFilter = parsedUrl.searchParams.get('lessonId') || '';
    const groupIdFilter = parsedUrl.searchParams.get('groupId') || '';
    const lang = (parsedUrl.searchParams.get('lang') === 'en' ? 'en' : 'vi') as Language;

    const targetClassId =
      classId && store.classes.some((c) => c.id === classId)
        ? classId
        : store.classes[0]?.id || '';

    // Strict class isolation for students: only expose lessons assigned to their class
    const visibleLessons =
      !includeAnswers && classId
        ? store.lessons.filter((l) => isLessonAssignedToClass(l, classId))
        : store.lessons;

    const sanitizedLessons = visibleLessons.map((lesson) => ({
      ...lesson,
      questions: lesson.questions.map((q) =>
        includeAnswers ? q : { ...q, correctAnswer: undefined },
      ),
    }));

    const leaderboard = buildLeaderboard(
      targetClassId,
      store.submissions,
      lang,
      lessonIdFilter || undefined,
    );
    const domainChampions = buildDomainChampions(
      targetClassId,
      store.submissions,
      lang,
      lessonIdFilter || undefined,
    );
    const competencyMatrix = buildCompetencyMatrix(
      store.lessons,
      store.submissions,
      classId || undefined,
    );

    const groupProgress: Record<
      string,
      { answeredQuestionIds: string[]; correctCount: number; totalPoints: number }
    > = {};
    if (classId && groupIdFilter) {
      for (const sub of store.submissions) {
        if (sub.classId === classId && sub.groupId === groupIdFilter) {
          const entry = groupProgress[sub.lessonId] ?? {
            answeredQuestionIds: [],
            correctCount: 0,
            totalPoints: 0,
          };
          if (!entry.answeredQuestionIds.includes(sub.questionId)) {
            entry.answeredQuestionIds.push(sub.questionId);
            if (sub.isCorrect) entry.correctCount += 1;
            entry.totalPoints += sub.totalPoints;
          }
          groupProgress[sub.lessonId] = entry;
        }
      }
    }

    const visibleLessonIds = new Set(visibleLessons.map((l) => l.id));
    const notifications = store.notifications
      .filter((n) => {
        if (classId && n.classId !== classId) return false;
        if (!includeAnswers && classId && n.lessonId && !visibleLessonIds.has(n.lessonId)) {
          return false;
        }
        return true;
      })
      .slice(0, 20);

    const activityLogs = store.activityLogs
      .filter((l) => !classId || l.classId === classId)
      .slice(0, 60);

    const studentMem = loadStudentPublicMemory(storage);
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
        groupProgress,
        submissionsCount: store.submissions.length,
        activeWorkspaceId: resolvedWsId || activePublicWorkspaceId,
        syncMeta: store.syncMeta ?? null,
        studentMemoryMeta: studentMem
          ? {
              revision: studentMem.revision,
              publishedAt: studentMem.publishedAt,
              publishedBy: studentMem.publishedBy,
              workspaceId: studentMem.workspaceId,
              classesCount: studentMem.classes.length,
              lessonsCount: studentMem.lessons.length,
            }
          : null,
        ...(includeAnswers ? { submissions: store.submissions } : {}),
      },
    };
  }

  // GET /api/student-memory (Public zero-login read of dedicated Student Public Memory — strips answer keys!)
  if (pathname === '/api/student-memory' && method === 'GET') {
    const mem = loadStudentPublicMemory(storage);
    const classId = parsedUrl.searchParams.get('classId') || '';
    if (!mem) {
      return { ok: true, status: 200, data: { memory: null } };
    }
    const visibleLessons = classId
      ? mem.lessons.filter((l) => isLessonAssignedToClass(l, classId))
      : mem.lessons;
    return {
      ok: true,
      status: 200,
      data: {
        memory: {
          version: mem.version,
          revision: mem.revision,
          publishedAt: mem.publishedAt,
          workspaceId: mem.workspaceId,
          classesCount: mem.classes.length,
          lessonsCount: mem.lessons.length,
          classes: mem.classes,
          lessons: visibleLessons.map((lesson) => ({
            ...lesson,
            questions: lesson.questions.map((q) => ({ ...q, correctAnswer: undefined })),
          })),
          notifications: classId
            ? mem.notifications.filter((n) => n.classId === normalizeClassCode(classId))
            : mem.notifications,
        },
      },
    };
  }

  const isTeacherOnlyPath =
    pathname.startsWith('/api/workspace/') ||
    pathname === '/api/sync/cloud-hydrate' ||
    pathname === '/api/student-memory/publish' ||
    pathname.startsWith('/api/classes') ||
    pathname.startsWith('/api/lessons') ||
    pathname.startsWith('/api/submissions/');

  if (isTeacherOnlyPath) {
    const authStore = loadLocalStore(storage);
    if (!getLocalAuth(authStore)) {
      return {
        ok: false,
        status: 401,
        data: {
          error:
            'Phiên Giáo viên / Admin chưa xác thực. Vui lòng đăng nhập lại.',
        },
      };
    }
  }

  // POST /api/student-memory/publish (Teacher-authenticated publish into dedicated Student Public Memory)
  if (pathname === '/api/student-memory/publish' && method === 'POST') {
    const store = loadLocalStore(storage);
    const payload = body as {
      classes?: ClassRoom[];
      lessons?: Lesson[];
      notifications?: PushNotification[];
      workspaceId?: string;
      publishedBy?: string;
    };
    const nextClasses = Array.isArray(payload.classes) && payload.classes.length > 0
      ? payload.classes
      : store.classes;
    const nextLessons = Array.isArray(payload.lessons) && payload.lessons.length > 0
      ? payload.lessons
      : store.lessons;
    const nextNotifs = Array.isArray(payload.notifications)
      ? payload.notifications
      : store.notifications;

    const saved = saveStudentPublicMemory(
      {
        classes: nextClasses,
        lessons: nextLessons,
        notifications: nextNotifs,
        workspaceId: payload.workspaceId || store.syncMeta?.workspaceId || activePublicWorkspaceId,
        publishedBy: payload.publishedBy || store.syncMeta?.ownerEmail,
      },
      storage,
    );
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        memory: saved
          ? {
              revision: saved.revision,
              publishedAt: saved.publishedAt,
              publishedBy: saved.publishedBy,
              workspaceId: saved.workspaceId,
              classesCount: saved.classes.length,
              lessonsCount: saved.lessons.length,
            }
          : null,
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
    saveStudentPublicMemory(
      {
        classes: store.classes,
        lessons: store.lessons,
        notifications: store.notifications,
        workspaceId: store.syncMeta?.workspaceId || activePublicWorkspaceId,
      },
      storage,
    );
    return { ok: true, status: 200, data: { ok: true, importedClasses, importedLessons } };
  }

  // POST /api/sync/cloud-hydrate
  if (pathname === '/api/sync/cloud-hydrate' && method === 'POST') {
    const payload = body as CloudHydratePayload;
    const store = loadLocalStore(storage);
    const syncMeta = applyAuthoritativeCloudHydrate(store, payload);
    saveLocalStore(store, storage);
    const studentMemory = saveStudentPublicMemory(
      {
        classes: store.classes,
        lessons: store.lessons,
        notifications: store.notifications,
        workspaceId: syncMeta.workspaceId,
        publishedBy: syncMeta.ownerEmail,
      },
      storage,
    );
    return {
      ok: true,
      status: 200,
      data: {
        ok: true,
        syncMeta,
        studentMemoryMeta: studentMemory
          ? {
              revision: studentMemory.revision,
              publishedAt: studentMemory.publishedAt,
              publishedBy: studentMemory.publishedBy,
              workspaceId: studentMemory.workspaceId,
              classesCount: studentMemory.classes.length,
              lessonsCount: studentMemory.lessons.length,
            }
          : null,
      },
    };
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
    const previous = new Set(lesson.assignedClassIds.map((c) => normalizeClassCode(c)));
    const nextList = Array.from(
      new Set((classIds ?? []).map((c) => normalizeClassCode(String(c ?? ''))).filter(Boolean)),
    );
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
        q.type === 'fill_blank' ||
        q.type === 'short_answer' ||
        q.type === 'true_false' ||
        q.type === 'true_false_multi'
          ? q.type
          : 'multiple_choice';
      const cleanedOptions =
        qType === 'multiple_choice' || qType === 'true_false_multi'
          ? (q.options ?? []).map((opt) => opt.trim()).filter(Boolean)
          : qType === 'true_false'
            ? ['Đúng', 'Sai']
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

  // POST /api/submissions/:id/override (Teacher manual review / re-grade)
  const overrideMatch = pathname.match(/^\/api\/submissions\/([^/]+)\/override$/);
  if (overrideMatch && method === 'POST') {
    const subId = decodeURIComponent(overrideMatch[1]);
    const { isCorrect } = body as { isCorrect?: boolean };
    if (typeof isCorrect !== 'boolean') {
      return {
        ok: false,
        status: 400,
        data: { error: 'Vui lòng chọn kết quả chấm lại (Đúng hoặc Chưa đúng).' },
      };
    }
    const store = loadLocalStore(storage);
    const sub = store.submissions.find((s) => s.id === subId);
    if (!sub) {
      return { ok: false, status: 404, data: { error: 'Không tìm thấy bài làm cần phúc khảo.' } };
    }
    const lesson = store.lessons.find((l) => l.id === sub.lessonId);
    const question = lesson?.questions.find((q) => q.id === sub.questionId);
    const breakdown = calculatePoints(isCorrect, sub.elapsedMs, question?.type ?? 'fill_blank');

    sub.isCorrect = isCorrect;
    sub.basePoints = breakdown.basePoints;
    sub.speedBonus = breakdown.speedBonus;
    sub.totalPoints = breakdown.totalPoints;
    sub.feedbackText = isCorrect
      ? `[GV phúc khảo] Công nhận đáp án đúng! Nhóm ${sub.groupName} nhận +${breakdown.totalPoints} điểm.`
      : `[GV phúc khảo] Đánh dấu chưa đạt (0 điểm).`;

    store.activityLogs.unshift({
      id: `log-ov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      classId: sub.classId,
      groupId: sub.groupId,
      action: isCorrect ? 'GV phúc khảo · Công nhận đúng' : 'GV phúc khảo · Chưa đúng',
      detail: `${sub.lessonTitle} · Đáp án HS: "${sub.userAnswer.slice(0, 80)}"`,
      competencyId: sub.competencyId,
      pointsDelta: sub.totalPoints,
      timestamp: new Date().toISOString(),
    });

    saveLocalStore(store, storage);
    const leaderboard = buildLeaderboard(sub.classId, store.submissions, 'vi');
    return {
      ok: true,
      status: 200,
      data: { submission: sub, submissions: store.submissions, leaderboard },
    };
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
    const graded = gradeOneLocally(store, item, lang, false);
    if (graded.status === 'forbidden') {
      return {
        ok: false,
        status: 403,
        data: { error: 'Bài tập này thuộc lớp học khác, không được giao cho lớp của em.' },
      };
    }
    if (graded.status === 'not_found') {
      return { ok: false, status: 404, data: { error: 'Không tìm thấy câu hỏi tương ứng.' } };
    }
    const { submission, alreadySubmitted } = graded;
    if (!alreadySubmitted) {
      saveLocalStore(store, storage);
      const written = await writePublicSubmissionViaRest(
        firebaseConfig,
        activePublicWorkspaceId,
        submission,
      );
      if (!written && activePublicWorkspaceId === DEFAULT_PUBLIC_WORKSPACE_ID) {
        await writePublicSubmissionViaRest(
          firebaseConfig,
          LEGACY_FALLBACK_WORKSPACE_ID,
          submission,
        );
      }
    }
    const leaderboard = buildLeaderboard(item.classId, store.submissions, lang);
    return {
      ok: true,
      status: 200,
      data: { submission, alreadySubmitted: Boolean(alreadySubmitted), leaderboard },
    };
  }

  // POST /api/quiz/sync
  if (pathname === '/api/quiz/sync' && method === 'POST') {
    const { items, lang } = body as { items?: OfflineQueueItem[]; lang?: Language };
    const store = loadLocalStore(storage);
    const resolvedLang: Language = lang === 'en' ? 'en' : 'vi';
    const synced: AnswerSubmission[] = [];
    for (const item of items ?? []) {
      const graded = gradeOneLocally(store, item, resolvedLang, true);
      if (graded.status === 'ok') {
        synced.push(graded.submission);
        if (!graded.alreadySubmitted) {
          const written = await writePublicSubmissionViaRest(
            firebaseConfig,
            activePublicWorkspaceId,
            graded.submission,
          );
          if (!written && activePublicWorkspaceId === DEFAULT_PUBLIC_WORKSPACE_ID) {
            await writePublicSubmissionViaRest(
              firebaseConfig,
              LEGACY_FALLBACK_WORKSPACE_ID,
              graded.submission,
            );
          }
        }
      }
    }
    saveLocalStore(store, storage);
    const classId = items?.[0]?.classId || store.classes[0]?.id || '';
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
    const classId = parsedUrl.searchParams.get('classId') || store.classes[0]?.id || '';
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

  // POST /api/learners/profile (Verified Google email OR zero-login guestUid for young students)
  if (pathname === '/api/learners/profile' && method === 'POST') {
    const pBody = body as {
      idToken?: string;
      guestUid?: string;
      photoUrl?: string;
      fullName?: string;
      className?: string;
      schoolName?: string;
      gradeBand?: LearnerGradeBand;
    };
    const fullName = String(pBody.fullName ?? '').trim();
    const className = String(pBody.className ?? '').trim();
    const schoolName = String(pBody.schoolName ?? '').trim();
    if (!fullName || !className || !schoolName) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Vui lòng nhập đầy đủ Họ tên, Lớp học và Trường học để lưu hồ sơ.' },
      };
    }

    let resolvedUid = '';
    let resolvedAuthType: 'google' | 'guest' = 'google';
    let resolvedEmail: string | undefined;

    if (pBody.idToken) {
      const verified = await verifyGoogleIdTokenStatic(String(pBody.idToken));
      if (!verified || !verified.emailVerified) {
        return {
          ok: false,
          status: 401,
          data: { error: 'Không thể xác thực tài khoản Google của học sinh.' },
        };
      }
      resolvedUid = verified.uid;
      resolvedAuthType = 'google';
      resolvedEmail = verified.email;
    } else if (isValidGuestLearnerUid(pBody.guestUid)) {
      resolvedUid = pBody.guestUid.trim();
      resolvedAuthType = 'guest';
    } else {
      return {
        ok: false,
        status: 401,
        data: {
          error:
            'Vui lòng đăng nhập bằng Email cá nhân (Google) hoặc tạo Hồ sơ Tự đánh giá không cần đăng nhập hợp lệ.',
        },
      };
    }

    const store = loadLocalStore(storage);
    const profile = upsertLearnerProfileInStore(store, {
      uid: resolvedUid,
      authType: resolvedAuthType,
      email: resolvedEmail,
      photoUrl: resolvedAuthType === 'google' ? pBody.photoUrl : undefined,
      fullName,
      className,
      schoolName,
      gradeBand: pBody.gradeBand,
    });
    saveLocalStore(store, storage);
    const { assessmentAttempts, teacherAwards } = ensureLearnerCollections(store);
    return {
      ok: true,
      status: 200,
      data: {
        profile,
        attempts: assessmentAttempts.filter((a) => a.learnerUid === profile.uid).slice(0, 30),
        awards: teacherAwards.filter((a) => a.learnerUid === profile.uid),
      },
    };
  }

  // GET /api/learners/me (Verified Google email OR valid guestUid)
  if (pathname === '/api/learners/me' && method === 'GET') {
    let resolvedUid = '';
    const requestedUid = parsedUrl.searchParams.get('uid')?.trim() || '';

    if (options.learnerToken) {
      const verified = await verifyGoogleIdTokenStatic(options.learnerToken);
      if (!verified?.uid || !verified.emailVerified) {
        return {
          ok: false,
          status: 401,
          data: { error: 'Phiên đăng nhập Google không hợp lệ. Vui lòng đăng nhập lại.' },
        };
      }
      resolvedUid = verified.uid;
    } else if (isValidGuestLearnerUid(requestedUid)) {
      resolvedUid = requestedUid;
    } else {
      return {
        ok: false,
        status: 401,
        data: { error: 'Cần đăng nhập Email cá nhân hoặc cung cấp Mã hồ sơ hợp lệ để xem tiến độ.' },
      };
    }

    const store = loadLocalStore(storage);
    const { learnerProfiles, assessmentAttempts, teacherAwards } =
      ensureLearnerCollections(store);
    const profile = learnerProfiles.find((p) => p.uid === resolvedUid) ?? null;
    return {
      ok: true,
      status: 200,
      data: {
        profile,
        attempts: profile
          ? assessmentAttempts.filter((a) => a.learnerUid === profile.uid).slice(0, 30)
          : [],
        awards: profile ? teacherAwards.filter((a) => a.learnerUid === profile.uid) : [],
      },
    };
  }

  // POST /api/learners/hydrate (Sync Cloud Firestore learner bundle into local store without data loss)
  if (pathname === '/api/learners/hydrate' && method === 'POST') {
    const hBody = body as {
      idToken?: string;
      guestUid?: string;
      profile?: LearnerProfile;
      attempts?: AssessmentSessionAttempt[];
      awards?: TeacherAward[];
    };
    if (!hBody.profile) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Thiếu dữ liệu đồng bộ hồ sơ học sinh.' },
      };
    }

    let resolvedUid = '';
    let resolvedAuthType: 'google' | 'guest' = 'google';
    let resolvedEmail: string | undefined;

    if (hBody.idToken) {
      const verified = await verifyGoogleIdTokenStatic(String(hBody.idToken));
      if (!verified?.uid || !verified.emailVerified || hBody.profile.uid !== verified.uid) {
        return {
          ok: false,
          status: 401,
          data: { error: 'Không thể xác thực tài khoản Google để đồng bộ hồ sơ.' },
        };
      }
      resolvedUid = verified.uid;
      resolvedAuthType = 'google';
      resolvedEmail = verified.email;
    } else if (
      isValidGuestLearnerUid(hBody.guestUid) &&
      hBody.profile.uid === hBody.guestUid.trim()
    ) {
      resolvedUid = hBody.guestUid.trim();
      resolvedAuthType = 'guest';
    } else {
      return {
        ok: false,
        status: 401,
        data: { error: 'Không thể xác thực phiên đồng bộ hồ sơ học sinh.' },
      };
    }

    const store = loadLocalStore(storage);
    const merged = hydrateLearnerProfileInStore(
      store,
      {
        ...hBody.profile,
        uid: resolvedUid,
        authType: resolvedAuthType,
        email: resolvedEmail || (resolvedAuthType === 'google' ? hBody.profile.email : undefined),
      },
      Array.isArray(hBody.attempts) ? hBody.attempts : [],
      Array.isArray(hBody.awards) ? hBody.awards : [],
    );
    saveLocalStore(store, storage);
    const { assessmentAttempts, teacherAwards } = ensureLearnerCollections(store);
    return {
      ok: true,
      status: 200,
      data: {
        profile: merged,
        attempts: assessmentAttempts.filter((a) => a.learnerUid === merged.uid).slice(0, 30),
        awards: teacherAwards.filter((a) => a.learnerUid === merged.uid),
      },
    };
  }

  // POST /api/learners/assessment-submit (Google email OR zero-login guestUid, retry-capped)
  if (pathname === '/api/learners/assessment-submit' && method === 'POST') {
    const aBody = body as {
      idToken?: string;
      guestUid?: string;
      learnerName?: string;
      className?: string;
      schoolName?: string;
      gradeBand?: LearnerGradeBand;
      baseProfile?: LearnerProfile;
      mode?: AssessmentSessionMode;
      targetLevel?: AssessmentLevel;
      targetCompetencyId?: string;
      outcomes?: AssessmentExerciseOutcome[];
      maxCombo?: number;
    };

    let resolvedUid = '';
    let resolvedAuthType: 'google' | 'guest' = 'google';
    let resolvedEmail: string | undefined;

    if (aBody.idToken) {
      const verified = await verifyGoogleIdTokenStatic(String(aBody.idToken));
      if (!verified?.uid || !verified.emailVerified) {
        return {
          ok: false,
          status: 401,
          data: { error: 'Không thể xác thực tài khoản Google. Vui lòng đăng nhập lại.' },
        };
      }
      resolvedUid = verified.uid;
      resolvedAuthType = 'google';
      resolvedEmail = verified.email;
    } else if (isValidGuestLearnerUid(aBody.guestUid)) {
      resolvedUid = aBody.guestUid.trim();
      resolvedAuthType = 'guest';
    } else {
      return {
        ok: false,
        status: 401,
        data: { error: 'Cần đăng nhập Email cá nhân hoặc dùng Hồ sơ Tự đánh giá hợp lệ để lưu kết quả.' },
      };
    }

    const store = loadLocalStore(storage);
    const { profile, attempt } = recordAssessmentAttemptInStore(store, {
      learnerUid: resolvedUid,
      learnerName: aBody.learnerName,
      className: aBody.className,
      schoolName: aBody.schoolName,
      authType: resolvedAuthType,
      email: resolvedEmail,
      gradeBand: aBody.gradeBand,
      baseProfile:
        aBody.baseProfile && aBody.baseProfile.uid === resolvedUid
          ? aBody.baseProfile
          : undefined,
      mode: aBody.mode || 'variety_sprint',
      targetLevel: aBody.targetLevel,
      targetCompetencyId: aBody.targetCompetencyId,
      outcomes: Array.isArray(aBody.outcomes) ? aBody.outcomes : [],
      maxCombo: Number(aBody.maxCombo || 0),
    });
    saveLocalStore(store, storage);
    const { teacherAwards } = ensureLearnerCollections(store);
    return {
      ok: true,
      status: 200,
      data: {
        profile,
        attempt,
        awards: teacherAwards.filter((a) => a.learnerUid === profile.uid),
      },
    };
  }

  // GET /api/learners/honor
  if (pathname === '/api/learners/honor' && method === 'GET') {
    const store = loadLocalStore(storage);
    const schoolName = parsedUrl.searchParams.get('schoolName') || undefined;
    const className = parsedUrl.searchParams.get('className') || undefined;
    return {
      ok: true,
      status: 200,
      data: { entries: getPublicHonorFromStore(store, { schoolName, className }) },
    };
  }

  // GET /api/teacher/learners
  if (pathname === '/api/teacher/learners' && method === 'GET') {
    const store = loadLocalStore(storage);
    if (!getLocalAuth(store)) {
      return {
        ok: false,
        status: 401,
        data: { error: 'Phiên Giáo viên / Admin đã hết hạn hoặc chưa xác thực.' },
      };
    }
    const { learnerProfiles, assessmentAttempts, teacherAwards } =
      ensureLearnerCollections(store);
    return {
      ok: true,
      status: 200,
      data: {
        learners: learnerProfiles,
        attempts: assessmentAttempts.slice(0, 200),
        awards: teacherAwards,
      },
    };
  }

  // POST /api/teacher/awards
  if (pathname === '/api/teacher/awards' && method === 'POST') {
    const store = loadLocalStore(storage);
    const authSess = getLocalAuth(store);
    if (!authSess) {
      return {
        ok: false,
        status: 401,
        data: { error: 'Phiên Giáo viên / Admin đã hết hạn hoặc chưa xác thực.' },
      };
    }
    const awBody = body as {
      learnerUid?: string;
      learnerSnapshot?: LearnerProfile;
      badgeId?: string;
      badgeTitle?: string;
      message?: string;
      bonusXp?: number;
      awardedByName?: string;
    };
    if (!awBody.learnerUid || !awBody.badgeTitle?.trim()) {
      return {
        ok: false,
        status: 400,
        data: { error: 'Vui lòng chọn học sinh và danh hiệu khen thưởng.' },
      };
    }
    const result = createTeacherAwardInStore(store, {
      learnerUid: awBody.learnerUid,
      learnerSnapshot: awBody.learnerSnapshot,
      badgeId: awBody.badgeId || 'custom',
      badgeTitle: awBody.badgeTitle.trim(),
      message: awBody.message || '',
      bonusXp: Number(awBody.bonusXp ?? 100),
      awardedByName:
        awBody.awardedByName?.trim() ||
        (authSess.email ? `GV (${authSess.email})` : 'Giáo viên'),
      awardedByEmail: authSess.email,
    });
    if (!result) {
      return { ok: false, status: 404, data: { error: 'Không tìm thấy hồ sơ học sinh.' } };
    }
    saveLocalStore(store, storage);
    return { ok: true, status: 201, data: result };
  }

  // DELETE /api/teacher/awards/:id
  if (pathname.startsWith('/api/teacher/awards/') && method === 'DELETE') {
    const store = loadLocalStore(storage);
    if (!getLocalAuth(store)) {
      return {
        ok: false,
        status: 401,
        data: { error: 'Phiên Giáo viên / Admin đã hết hạn hoặc chưa xác thực.' },
      };
    }
    const awardId = decodeURIComponent(pathname.slice('/api/teacher/awards/'.length));
    const ok = deleteTeacherAwardInStore(store, awardId);
    if (!ok) {
      return { ok: false, status: 404, data: { error: 'Không tìm thấy khen thưởng.' } };
    }
    saveLocalStore(store, storage);
    return { ok: true, status: 200, data: { ok: true } };
  }

  return { ok: false, status: 404, data: { error: 'Not found' } };
}
