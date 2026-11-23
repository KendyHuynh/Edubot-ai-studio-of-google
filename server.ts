import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
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
  sanitizeStoreRemoveDemoArtifacts,
} from './src/utils/firestoreHelpers';
import {
  fetchPublicSubmissionsViaRest,
  fetchPublicWorkspaceSnapshot,
  writePublicSubmissionViaRest,
} from './src/utils/publicFirestoreRest';
import { getCompetencyById } from './src/shared/competencies';
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
} from './src/shared/scoring';
import { recoverMissingCorrectAnswers } from './src/utils/answerRecovery';
import { mergeLessonsPreservingCustom } from './src/utils/aiLessonVault';
import {
  ActivityLog,
  AnswerSubmission,
  AssessmentExerciseOutcome,
  AssessmentLevel,
  AssessmentSessionMode,
  ClassRoom,
  Language,
  LearnerGradeBand,
  Lesson,
  OfflineQueueItem,
  PushNotification,
  Question,
  QuestionType,
} from './src/shared/types';
import {
  createTeacherAwardInStore,
  deleteTeacherAwardInStore,
  ensureLearnerCollections,
  getPublicHonorFromStore,
  recordAssessmentAttemptInStore,
  upsertLearnerProfileInStore,
} from './src/shared/learnerStoreOps';
import { generateLessonQuestions, QuestionStylePreset } from './server/gemini';
import { loadStore, saveStore } from './server/store';
import {
  AdminTokenPayload,
  checkPinRateLimit,
  clearPinRateLimit,
  createAdminToken,
  ensureAdminSecurity,
  extractBearerToken,
  hashPinScrypt,
  isAuthorizedAdminEmail,
  isPinStrengthValid,
  normalizeAdminEmails,
  recordFailedPinAttempt,
  verifyAdminToken,
  verifyEnvPinConstantTime,
  verifyFirebaseIdTokenViaRest,
  verifyPinScrypt,
} from './server/auth';
import { PRIMARY_ADMIN_EMAIL } from './src/shared/seedData';

dotenv.config();

function normalizeClassCode(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'D')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readFirebaseConfig(): {
  projectId?: string;
  appId?: string;
  authDomain?: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  apiKey?: string;
} {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (!fs.existsSync(cfgPath)) return {};
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch {
    return {};
  }
}

function resolveAppletUrls(): { devAppUrl: string; sharedAppUrl: string } {
  const rawAppUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const sharedAppUrl = rawAppUrl.includes('ais-dev-')
    ? rawAppUrl.replace('ais-dev-', 'ais-pre-')
    : rawAppUrl;
  return { devAppUrl: rawAppUrl, sharedAppUrl };
}

const hydratedWorkspaceCache = new Map<string, number>();
let activePublicWorkspaceId: string = DEFAULT_PUBLIC_WORKSPACE_ID;

async function hydrateFromPublicWorkspace(
  workspaceCode: string,
  options: { replaceContent: boolean; forceRefresh?: boolean } = { replaceContent: true },
): Promise<string> {
  const cacheKey = `${workspaceCode.trim() || '__default__'}::${options.replaceContent ? 'full' : 'subs'}`;
  const lastFetched = hydratedWorkspaceCache.get(cacheKey) ?? 0;
  if (!options.forceRefresh && Date.now() - lastFetched < 5_000) {
    return activePublicWorkspaceId;
  }

  const cfg = readFirebaseConfig();
  if (!cfg.projectId || !cfg.firestoreDatabaseId || !cfg.apiKey) {
    return activePublicWorkspaceId;
  }

  try {
    const snapshot = await fetchPublicWorkspaceSnapshot(cfg, workspaceCode || null);
    const resolvedWsId = snapshot?.workspaceId || workspaceCode.trim() || activePublicWorkspaceId;
    if (snapshot) {
      activePublicWorkspaceId = snapshot.workspaceId;
    }

    const store = loadStore();
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
          recoverMissingCorrectAnswers(snapshot.lessons, store.lessons),
        );
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
    }

    const subSources = Array.from(
      new Set(
        resolvedWsId === DEFAULT_PUBLIC_WORKSPACE_ID
          ? [DEFAULT_PUBLIC_WORKSPACE_ID, LEGACY_FALLBACK_WORKSPACE_ID]
          : [resolvedWsId],
      ),
    );
    const cloudSubs: AnswerSubmission[] = [];
    for (const wsId of subSources) {
      const rows = await fetchPublicSubmissionsViaRest(cfg, wsId);
      if (rows.length > 0) {
        cloudSubs.push(...rows.filter((s) => !isDemoSeedArtifactId(s.id)));
      }
    }

    if (cloudSubs.length > 0) {
      store.submissions = mergeLatestSubmissions(store.submissions, cloudSubs);
      store.activityLogs = mergeSubmissionActivityLogs(store.activityLogs, store.submissions);
      changed = true;
    }

    const cleaned = sanitizeStoreRemoveDemoArtifacts(store);
    if (cleaned.changed) changed = true;

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
      saveStore(store);
    }
    hydratedWorkspaceCache.set(cacheKey, Date.now());
    return resolvedWsId;
  } catch {
    // Non-fatal: continue with current server store
    return activePublicWorkspaceId;
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '25mb' }));

  // Preserve window.opener communication across Google OAuth / Firebase signInWithPopup flows
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
  });

  // Serve Firebase Web App init JSON so auth handler / SDK lookups on this origin never 404 with HTML
  app.get('/__/firebase/init.json', (_req, res) => {
    const cfg = readFirebaseConfig();
    if (!cfg.apiKey || !cfg.projectId) {
      res.status(404).json({ error: 'Firebase configuration not found.' });
      return;
    }
    res.json({
      apiKey: cfg.apiKey,
      authDomain: cfg.authDomain,
      projectId: cfg.projectId,
      storageBucket: cfg.storageBucket,
      messagingSenderId: cfg.messagingSenderId,
      appId: cfg.appId,
    });
  });

  // Reverse-proxy Firebase Auth callback routes (/__/auth/handler, /__/auth/iframe, etc.)
  // so callbacks hitting any applet domain (ais-dev, ais-pre, ais-mob) resolve properly instead of SPA HTML
  app.all('/__/auth/*', async (req, res) => {
    const cfg = readFirebaseConfig();
    const authDomain = (cfg.authDomain || '').trim();
    if (!authDomain || !/^[a-z0-9.-]+$/i.test(authDomain)) {
      res.status(503).send('Firebase authDomain is not configured.');
      return;
    }
    try {
      const upstreamUrl = `https://${authDomain}${req.originalUrl}`;
      const upstreamHeaders: Record<string, string> = {};
      if (typeof req.headers['content-type'] === 'string') {
        upstreamHeaders['content-type'] = req.headers['content-type'];
      }
      if (typeof req.headers.accept === 'string') {
        upstreamHeaders.accept = req.headers.accept;
      }

      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body:
          req.method !== 'GET' && req.method !== 'HEAD' && req.body
            ? typeof req.body === 'string'
              ? req.body
              : JSON.stringify(req.body)
            : undefined,
        redirect: 'manual',
      });

      const contentType = upstreamRes.headers.get('content-type');
      const location = upstreamRes.headers.get('location');
      if (contentType) res.setHeader('Content-Type', contentType);
      if (location) res.setHeader('Location', location);
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
      res.status(upstreamRes.status);
      const buffer = Buffer.from(await upstreamRes.arrayBuffer());
      res.send(buffer);
    } catch {
      res.status(502).send('Failed to proxy Firebase Auth handler.');
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'EduBot Digital Citizen' });
  });

  app.get('/api/auth/domains', (_req, res) => {
    const cfg = readFirebaseConfig();
    const { devAppUrl, sharedAppUrl } = resolveAppletUrls();
    const callbackUrls = [
      cfg.authDomain ? `https://${cfg.authDomain}/__/auth/handler` : null,
      devAppUrl ? `${devAppUrl}/__/auth/handler` : null,
      sharedAppUrl && sharedAppUrl !== devAppUrl
        ? `${sharedAppUrl}/__/auth/handler`
        : null,
    ].filter((u): u is string => Boolean(u));

    res.json({
      projectId: cfg.projectId || '',
      authDomain: cfg.authDomain || '',
      devAppUrl,
      sharedAppUrl,
      callbackUrls,
    });
  });

  function getAuthenticatedTeacher(req: express.Request): AdminTokenPayload | null {
    const store = loadStore();
    const security = ensureAdminSecurity(store.adminSecurity);
    const token = extractBearerToken(req.headers.authorization);
    return verifyAdminToken(token, security.tokenVersion);
  }

  function requireTeacherAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void {
    const authPayload = getAuthenticatedTeacher(req);
    if (!authPayload) {
      res.status(401).json({
        error: 'Phiên Giáo viên / Admin đã hết hạn hoặc chưa xác thực. Vui lòng đăng nhập lại.',
      });
      return;
    }
    (req as express.Request & { teacherAuth?: AdminTokenPayload }).teacherAuth = authPayload;
    next();
  }

  app.get('/api/teacher/auth-status', (req, res) => {
    const store = loadStore();
    const security = ensureAdminSecurity(store.adminSecurity);
    const envPin = (process.env.TEACHER_PIN || '').trim();
    const authPayload = getAuthenticatedTeacher(req);
    const pinConfigured = Boolean(envPin) || Boolean(security.pinHash);

    const { devAppUrl, sharedAppUrl } = resolveAppletUrls();

    res.json({
      pinConfigured,
      pinLockedByEnv: Boolean(envPin),
      adminOnlyMode: security.adminOnlyMode,
      adminEmails: authPayload ? normalizeAdminEmails(security.adminEmails) : [],
      primaryAdminEmail: PRIMARY_ADMIN_EMAIL,
      canFirstRunSetup: !pinConfigured && !security.adminOnlyMode,
      isAuthenticated: Boolean(authPayload),
      authMethod: authPayload?.method ?? null,
      adminEmail: authPayload?.email ?? null,
      devAppUrl,
      sharedAppUrl,
    });
  });

  // One-time first-run PIN setup (locks itself permanently once claimed or when TEACHER_PIN env is set)
  app.post('/api/teacher/setup-pin', (req, res) => {
    const envPin = (process.env.TEACHER_PIN || '').trim();
    const store = loadStore();
    const security = ensureAdminSecurity(store.adminSecurity);

    if (envPin || security.pinHash || security.adminOnlyMode) {
      res.status(409).json({
        error: 'Mã PIN Giáo viên đã được thiết lập trước đó. Vui lòng đăng nhập để đổi mã PIN.',
      });
      return;
    }

    const { newPin } = req.body as { newPin?: string };
    const cleanPin = String(newPin ?? '').trim();
    const check = isPinStrengthValid(cleanPin);
    if (!check.valid) {
      res.status(400).json({ error: check.reason });
      return;
    }

    security.pinHash = hashPinScrypt(cleanPin);
    security.tokenVersion = (security.tokenVersion || 1) + 1;
    security.updatedAt = new Date().toISOString();
    store.adminSecurity = security;
    saveStore(store);

    const token = createAdminToken({
      role: 'teacher',
      method: 'pin',
      tv: security.tokenVersion,
    });
    res.json({ ok: true, token, authMethod: 'pin' });
  });

  app.post('/api/teacher/verify-pin', (req, res) => {
    const clientKey = req.ip || 'unknown';
    const rate = checkPinRateLimit(clientKey);
    if (!rate.allowed) {
      res.status(429).json({
        error: `Nhập sai quá nhiều lần. Vui lòng thử lại sau ${rate.retryAfterSeconds} giây.`,
      });
      return;
    }

    const store = loadStore();
    const security = ensureAdminSecurity(store.adminSecurity);
    if (security.adminOnlyMode) {
      res.status(403).json({
        error: 'Chế độ Chỉ Admin Google đang bật. Vui lòng đăng nhập bằng tài khoản Google Admin.',
      });
      return;
    }

    const envPin = (process.env.TEACHER_PIN || '').trim();
    if (!envPin && !security.pinHash) {
      res.status(409).json({
        error: 'Chưa thiết lập mã PIN Giáo viên. Vui lòng tạo mã PIN mới hoặc đăng nhập Google Admin.',
      });
      return;
    }

    const { pin } = req.body as { pin?: string };
    const cleanPin = String(pin ?? '').trim();
    const matched = envPin
      ? verifyEnvPinConstantTime(cleanPin, envPin)
      : verifyPinScrypt(cleanPin, security.pinHash);

    if (!matched) {
      recordFailedPinAttempt(clientKey);
      res.status(401).json({ error: 'Mã PIN Giáo viên chưa đúng. Vui lòng thử lại.' });
      return;
    }

    clearPinRateLimit(clientKey);
    const token = createAdminToken({
      role: 'teacher',
      method: 'pin',
      tv: security.tokenVersion,
    });
    res.json({ ok: true, token, authMethod: 'pin' });
  });

  app.post('/api/teacher/verify-google', async (req, res) => {
    const { idToken } = req.body as { idToken?: string };
    if (!idToken || typeof idToken !== 'string') {
      res.status(400).json({ error: 'Thiếu mã xác thực Google (ID token).' });
      return;
    }

    const cfg = readFirebaseConfig();
    if (!cfg.apiKey) {
      res.status(503).json({ error: 'Chưa cấu hình Firebase Auth trên máy chủ.' });
      return;
    }

    const verified = await verifyFirebaseIdTokenViaRest(idToken, cfg.apiKey);
    if (!verified || !verified.emailVerified) {
      res.status(401).json({
        error: 'Không thể xác thực tài khoản Google. Vui lòng đăng nhập lại.',
      });
      return;
    }

    const store = loadStore();
    const security = ensureAdminSecurity(store.adminSecurity);
    if (!isAuthorizedAdminEmail(verified.email, security)) {
      res.status(403).json({
        error: `Tài khoản ${verified.email} không có quyền Quản trị / Giáo viên. Học sinh chỉ được truy cập Cổng Học sinh.`,
      });
      return;
    }

    const token = createAdminToken({
      role: 'admin',
      method: 'google',
      email: verified.email.toLowerCase(),
      tv: security.tokenVersion,
    });
    res.json({
      ok: true,
      token,
      authMethod: 'google',
      adminEmail: verified.email.toLowerCase(),
    });
  });

  app.post('/api/teacher/change-pin', requireTeacherAuth, (req, res) => {
    const envPin = (process.env.TEACHER_PIN || '').trim();
    if (envPin) {
      res.status(400).json({
        error: 'Mã PIN đang được khóa bằng biến môi trường TEACHER_PIN trong Settings -> Secrets. Hãy đổi giá trị TEACHER_PIN tại đó.',
      });
      return;
    }

    const authPayload = (req as express.Request & { teacherAuth?: AdminTokenPayload }).teacherAuth;
    const { currentPin, newPin } = req.body as { currentPin?: string; newPin?: string };
    const store = loadStore();
    const security = ensureAdminSecurity(store.adminSecurity);

    // Require current PIN if signed in via PIN and a PIN already exists; Google Admin can reset directly
    if (authPayload?.method !== 'google' && security.pinHash) {
      const okCurrent = verifyPinScrypt(String(currentPin ?? '').trim(), security.pinHash);
      if (!okCurrent) {
        res.status(401).json({ error: 'Mã PIN hiện tại không chính xác.' });
        return;
      }
    }

    const cleanNewPin = String(newPin ?? '').trim();
    const check = isPinStrengthValid(cleanNewPin);
    if (!check.valid) {
      res.status(400).json({ error: check.reason });
      return;
    }

    security.pinHash = hashPinScrypt(cleanNewPin);
    security.tokenVersion = (security.tokenVersion || 1) + 1;
    security.updatedAt = new Date().toISOString();
    store.adminSecurity = security;
    saveStore(store);

    const freshToken = createAdminToken({
      role: authPayload?.role ?? 'teacher',
      method: authPayload?.method ?? 'pin',
      email: authPayload?.email,
      tv: security.tokenVersion,
    });

    res.json({
      ok: true,
      token: freshToken,
      message: 'Đã cập nhật mã PIN Giáo viên mới và vô hiệu hóa các phiên đăng nhập cũ.',
    });
  });

  app.put('/api/teacher/security-settings', requireTeacherAuth, (req, res) => {
    const authPayload = (req as express.Request & { teacherAuth?: AdminTokenPayload }).teacherAuth;
    const { adminOnlyMode, adminEmails } = req.body as {
      adminOnlyMode?: boolean;
      adminEmails?: string[];
    };
    const store = loadStore();
    const security = ensureAdminSecurity(store.adminSecurity);

    if (typeof adminOnlyMode === 'boolean') {
      security.adminOnlyMode = adminOnlyMode;
    }
    if (Array.isArray(adminEmails)) {
      security.adminEmails = normalizeAdminEmails(adminEmails);
    }
    security.tokenVersion = (security.tokenVersion || 1) + 1;
    security.updatedAt = new Date().toISOString();
    store.adminSecurity = security;
    saveStore(store);

    const freshToken = createAdminToken({
      role: authPayload?.role ?? 'admin',
      method: authPayload?.method ?? 'google',
      email: authPayload?.email,
      tv: security.tokenVersion,
    });

    res.json({
      ok: true,
      token: freshToken,
      adminOnlyMode: security.adminOnlyMode,
      adminEmails: security.adminEmails,
      primaryAdminEmail: PRIMARY_ADMIN_EMAIL,
    });
  });

  // Bootstrap state for a class & role (automatically hydrates teacher's published Firestore workspace + live student submissions)
  app.get('/api/bootstrap', async (req, res) => {
    const ws = typeof req.query.ws === 'string' ? req.query.ws : '';
    const forceRefresh = req.query.refresh === '1';
    const teacherAuth = getAuthenticatedTeacher(req);
    const includeAnswers = req.query.role === 'teacher' && Boolean(teacherAuth);

    const preStore = loadStore();
    const storeIsOnlyDemoSeed = isDefaultSeedClassesOnly(preStore.classes);

    const resolvedWsId = await hydrateFromPublicWorkspace(ws, {
      replaceContent: !includeAnswers || storeIsOnlyDemoSeed,
      forceRefresh: forceRefresh || storeIsOnlyDemoSeed,
    });

    const store = loadStore();
    const classId = typeof req.query.classId === 'string' ? req.query.classId : '';
    const lessonIdFilter = typeof req.query.lessonId === 'string' ? req.query.lessonId : '';
    const groupIdFilter = typeof req.query.groupId === 'string' ? req.query.groupId : '';
    const lang = (req.query.lang === 'en' ? 'en' : 'vi') as Language;

    const targetClassId =
      classId && store.classes.some((c) => c.id === classId)
        ? classId
        : store.classes[0]?.id || '';

    // Strict class isolation for students: only expose lessons assigned to their checked-in class
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

    // Safe per-lesson completion summary for the currently checked-in student group (zero answer leaks)
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

    const rawAppUrl = process.env.APP_URL || '';
    const sharedAppUrl = rawAppUrl.includes('ais-dev-')
      ? rawAppUrl.replace('ais-dev-', 'ais-pre-')
      : rawAppUrl;

    res.json({
      classes: store.classes,
      lessons: sanitizedLessons,
      leaderboard,
      domainChampions,
      competencyMatrix,
      notifications,
      activityLogs,
      groupProgress,
      submissionsCount: store.submissions.length,
      activeWorkspaceId: resolvedWsId,
      syncMeta: store.syncMeta ?? null,
      sharedAppUrl,
      ...(includeAnswers ? { submissions: store.submissions } : {}),
    });
  });

  // Export/Import full classes + lessons package (Teacher-authenticated only)
  app.get('/api/workspace/export', requireTeacherAuth, (_req, res) => {
    const store = loadStore();
    res.json({
      exportedAt: new Date().toISOString(),
      classes: store.classes,
      lessons: store.lessons,
    });
  });

  app.post('/api/workspace/import', requireTeacherAuth, (req, res) => {
    const payload = req.body as {
      classes?: ClassRoom[];
      lessons?: Lesson[];
    };
    if (!Array.isArray(payload.classes) && !Array.isArray(payload.lessons)) {
      res.status(400).json({ error: 'Tệp cấu hình không hợp lệ.' });
      return;
    }
    const store = loadStore();
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
        if (lesson?.id && lesson?.title && Array.isArray(lesson.questions) && lesson.questions.length > 0) {
          lessonMap.set(lesson.id, lesson);
          importedLessons++;
        }
      }
      store.lessons = Array.from(lessonMap.values());
    }

    saveStore(store);
    res.json({ ok: true, importedClasses, importedLessons });
  });

  // Create or update a classroom
  app.post('/api/classes', requireTeacherAuth, (req, res) => {
    const { id, name, grade, teacherName } = req.body as Partial<ClassRoom>;
    const cleanId = normalizeClassCode(id ?? '');
    if (!cleanId || !name?.trim()) {
      res.status(400).json({ error: 'Vui lòng nhập Mã lớp (không dấu) và Tên lớp học.' });
      return;
    }

    const store = loadStore();
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
    saveStore(store);
    res.json({ classes: store.classes, createdId: cleanId, classRoom: savedClass });
  });

  // Update an existing classroom (with optional class code rename cascade)
  app.put('/api/classes/:id', requireTeacherAuth, (req, res) => {
    const oldId = decodeURIComponent(req.params.id);
    const { newId, name, grade, teacherName } = req.body as Partial<ClassRoom> & {
      newId?: string;
    };

    if (!name?.trim()) {
      res.status(400).json({ error: 'Tên lớp học không được để trống.' });
      return;
    }

    const store = loadStore();
    const target = store.classes.find((c) => c.id === oldId);
    if (!target) {
      res.status(404).json({ error: 'Không tìm thấy lớp học cần chỉnh sửa.' });
      return;
    }

    const nextId = newId?.trim() ? normalizeClassCode(newId) : oldId;
    if (!nextId) {
      res.status(400).json({ error: 'Mã lớp mới không hợp lệ.' });
      return;
    }

    if (nextId !== oldId) {
      const conflict = store.classes.find((c) => c.id === nextId);
      if (conflict) {
        res.status(409).json({ error: `Mã lớp "${nextId}" đã tồn tại.` });
        return;
      }
      target.id = nextId;
      for (const lesson of store.lessons) {
        lesson.assignedClassIds = Array.from(
          new Set(lesson.assignedClassIds.map((cid) => (cid === oldId ? nextId : cid))),
        );
      }
      for (const sub of store.submissions) {
        if (sub.classId === oldId) sub.classId = nextId;
      }
      for (const notif of store.notifications) {
        if (notif.classId === oldId) notif.classId = nextId;
      }
      for (const log of store.activityLogs) {
        if (log.classId === oldId) log.classId = nextId;
      }
    }

    target.name = name.trim();
    target.grade = grade?.trim() || target.grade;
    target.teacherName = teacherName?.trim() || target.teacherName;

    store.activityLogs.unshift({
      id: `log-${Date.now()}`,
      classId: target.id,
      groupId: 'Giáo viên',
      action: 'Cập nhật lớp học',
      detail: `${target.id} · ${target.name} (${target.grade} - ${target.teacherName})`,
      timestamp: new Date().toISOString(),
    });

    saveStore(store);
    res.json({ classRoom: target, classes: store.classes, oldId });
  });

  // Delete a classroom
  app.delete('/api/classes/:id', requireTeacherAuth, (req, res) => {
    const classId = decodeURIComponent(req.params.id);
    const store = loadStore();
    const exists = store.classes.some((c) => c.id === classId);
    if (!exists) {
      res.status(404).json({ error: 'Không tìm thấy lớp học.' });
      return;
    }
    if (store.classes.length <= 1) {
      res.status(400).json({ error: 'Cần giữ lại ít nhất 1 lớp học trong hệ thống.' });
      return;
    }

    store.classes = store.classes.filter((c) => c.id !== classId);
    for (const lesson of store.lessons) {
      lesson.assignedClassIds = lesson.assignedClassIds.filter((cid) => cid !== classId);
    }

    saveStore(store);
    res.json({ ok: true, classes: store.classes });
  });

  // Step 2: Upload lesson text/file and generate 24-competency quiz with Gemini
  app.post('/api/lessons/generate', requireTeacherAuth, async (req, res) => {
    const {
      title,
      sourceFileName,
      textContent,
      base64Data,
      mimeType,
      questionCount,
      questionStyle,
      assignedClassIds,
      language,
    } = req.body as {
      title?: string;
      sourceFileName?: string;
      textContent?: string;
      base64Data?: string;
      mimeType?: string;
      questionCount?: number;
      questionStyle?: QuestionStylePreset;
      assignedClassIds?: string[];
      language?: Language;
    };

    if (!textContent?.trim() && !base64Data) {
      res.status(400).json({
        error: 'Vui lòng tải tệp bài học hoặc dán nội dung bài học trước khi tạo câu hỏi.',
      });
      return;
    }

    try {
      const generated = await generateLessonQuestions({
        title,
        sourceFileName: sourceFileName || 'BaiHoc_CongDanSo.txt',
        textContent,
        base64Data,
        mimeType,
        questionCount: questionCount ?? 15,
        questionStyle: questionStyle ?? 'mc_and_true_false',
        language: language ?? 'vi',
      });

      const store = loadStore();
      const targetClasses =
        assignedClassIds && assignedClassIds.length > 0
          ? assignedClassIds
          : store.classes[0]?.id
            ? [store.classes[0].id]
            : [];

      const newLesson: Lesson = {
        id: `lesson-${Date.now()}`,
        title: generated.title,
        topic: generated.topic,
        sourceFileName: sourceFileName || 'BaiHoc_CongDanSo.txt',
        summary: generated.summary,
        assignedClassIds: targetClasses,
        createdAt: new Date().toISOString(),
        questions: generated.questions,
      };

      store.lessons.unshift(newLesson);

      // Push notification for every assigned class
      for (const classId of targetClasses) {
        const notif: PushNotification = {
          id: `notif-${Date.now()}-${classId}`,
          classId,
          lessonId: newLesson.id,
          title: `Bài tập mới: ${newLesson.title}`,
          message: `Giáo viên vừa giao ${newLesson.questions.length} câu hỏi Công dân số cho lớp ${classId}. Hãy tra cứu từ khóa AI và chinh phục bảng xếp hạng!`,
          createdAt: new Date().toISOString(),
          readByGroupIds: [],
        };
        store.notifications.unshift(notif);
      }

      store.activityLogs.unshift({
        id: `log-${Date.now()}`,
        classId: targetClasses[0],
        groupId: 'Giáo viên',
        action: 'Tạo bài học AI',
        detail: `${newLesson.title} (${newLesson.questions.length} câu hỏi · Giao cho ${targetClasses.join(', ')})`,
        timestamp: new Date().toISOString(),
      });

      saveStore(store);
      res.json({ lesson: newLesson });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Không thể tạo câu hỏi từ Gemini AI.';
      console.error('Gemini lesson generation error:', err);
      res.status(502).json({
        error: `Lỗi kết nối AI tạo câu hỏi: ${message}`,
      });
    }
  });

  // Update an existing lesson and its full questions list
  app.put('/api/lessons/:id', requireTeacherAuth, (req, res) => {
    const lessonId = req.params.id;
    const { title, topic, summary, assignedClassIds, questions } = req.body as Partial<Lesson>;

    if (!title?.trim()) {
      res.status(400).json({ error: 'Tên bài học không được để trống.' });
      return;
    }
    if (!Array.isArray(questions) || questions.length === 0) {
      res.status(400).json({ error: 'Bài học cần có ít nhất 1 câu hỏi.' });
      return;
    }

    const store = loadStore();
    const lesson = store.lessons.find((l) => l.id === lessonId);
    if (!lesson) {
      res.status(404).json({ error: 'Không tìm thấy bài học cần chỉnh sửa.' });
      return;
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
      res.status(400).json({
        error: 'Mỗi câu hỏi cần có đầy đủ nội dung câu hỏi và đáp án đúng.',
      });
      return;
    }

    lesson.title = title.trim();
    lesson.topic = topic?.trim() || lesson.topic;
    lesson.summary = summary?.trim() ?? lesson.summary;
    lesson.assignedClassIds = Array.isArray(assignedClassIds)
      ? Array.from(new Set(assignedClassIds))
      : lesson.assignedClassIds;
    lesson.questions = sanitizedQuestions;

    store.activityLogs.unshift({
      id: `log-${Date.now()}`,
      classId: lesson.assignedClassIds[0] || store.classes[0]?.id || '',
      groupId: 'Giáo viên',
      action: 'Chỉnh sửa bài học',
      detail: `${lesson.title} (${lesson.questions.length} câu hỏi)`,
      timestamp: new Date().toISOString(),
    });

    saveStore(store);
    res.json({ lesson });
  });

  // Authoritatively hydrate cloud Firestore state into local server store (overwrites cleanly, deduplicates, purges demo artifacts, records syncMeta)
  app.post('/api/sync/cloud-hydrate', requireTeacherAuth, (req, res) => {
    const payload = req.body as CloudHydratePayload;
    const store = loadStore();
    const syncMeta = applyAuthoritativeCloudHydrate(store, payload);
    saveStore(store);
    res.json({
      ok: true,
      syncMeta,
      counts: {
        classes: store.classes.length,
        lessons: store.lessons.length,
        submissions: store.submissions.length,
        notifications: store.notifications.length,
      },
    });
  });

  // Reuse an existing lesson across additional classes + push notification
  app.post('/api/lessons/:id/assign', requireTeacherAuth, (req, res) => {
    const lessonId = req.params.id;
    const { classIds } = req.body as { classIds: string[] };
    const store = loadStore();
    const lesson = store.lessons.find((l) => l.id === lessonId);
    if (!lesson) {
      res.status(404).json({ error: 'Không tìm thấy bài học.' });
      return;
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

    saveStore(store);
    res.json({ lesson });
  });

  app.delete('/api/lessons/:id', requireTeacherAuth, (req, res) => {
    const store = loadStore();
    store.lessons = store.lessons.filter((l) => l.id !== req.params.id);
    saveStore(store);
    res.json({ ok: true });
  });

  // Shared helper to grade one submission
  async function gradeSubmissionItem(
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
  ): Promise<
    | {
        status: 'ok';
        submission: AnswerSubmission;
        alreadySubmitted?: boolean;
        evaluation?: AnswerEvaluation;
      }
    | { status: 'forbidden' }
    | { status: 'not_found' }
  > {
    const store = loadStore();
    const lesson = store.lessons.find((l) => l.id === item.lessonId);
    const question = lesson?.questions.find((q) => q.id === item.questionId);
    if (!lesson || !question) {
      return { status: 'not_found' };
    }

    // Strict per-class authorization: students may only submit to lessons assigned to their class
    if (
      Array.isArray(lesson.assignedClassIds) &&
      lesson.assignedClassIds.length > 0 &&
      !isLessonAssignedToClass(lesson, item.classId)
    ) {
      return { status: 'forbidden' };
    }

    const groupId = formatGroupId(item.tabletNumber, item.groupName);

    // Official 1st-attempt lock: keep the group's first recorded answer so repeated plays cannot overwrite/game scores
    const existing = store.submissions.find(
      (s) =>
        s.classId === item.classId &&
        s.groupId === groupId &&
        s.lessonId === lesson.id &&
        s.questionId === question.id,
    );
    if (existing) {
      return { status: 'ok', submission: existing, alreadySubmitted: true };
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

    // 100% deterministic, instant fuzzy grading with full & partial credit — NO AI calls!
    const evaluation = evaluateAnswerMatch(
      item.userAnswer,
      resolvedCorrectAnswer,
      question.type,
      question.options,
    );
    const isCorrect = evaluation.isCorrect;
    const explanation = question.explanation;
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
      explanation,
      syncedFromOffline,
    };

    store.submissions.push(submission);

    const isPartial = evaluation.matchTier === 'fuzzy_partial';
    const log: ActivityLog = {
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
    };
    store.activityLogs.unshift(log);

    saveStore(store);
    return { status: 'ok', submission, alreadySubmitted: false, evaluation };
  }

  // Teacher manual grade review / override for any recorded student answer
  app.post('/api/submissions/:id/override', requireTeacherAuth, (req, res) => {
    const subId = decodeURIComponent(req.params.id);
    const { isCorrect } = req.body as { isCorrect?: boolean };
    if (typeof isCorrect !== 'boolean') {
      res.status(400).json({ error: 'Vui lòng chọn kết quả chấm lại (Đúng hoặc Chưa đúng).' });
      return;
    }

    const store = loadStore();
    const sub = store.submissions.find((s) => s.id === subId);
    if (!sub) {
      res.status(404).json({ error: 'Không tìm thấy bài làm cần phúc khảo.' });
      return;
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

    saveStore(store);
    const leaderboard = buildLeaderboard(sub.classId, store.submissions, 'vi');
    res.json({ submission: sub, submissions: store.submissions, leaderboard });
  });

  // Step 3: Submit single answer
  app.post('/api/quiz/submit', async (req, res) => {
    const body = req.body as {
      classId: string;
      tabletNumber: number;
      groupName: string;
      lessonId: string;
      questionId: string;
      userAnswer: string;
      elapsedMs: number;
      lang?: Language;
    };

    if (!body.classId || !body.tabletNumber || !body.lessonId || !body.questionId) {
      res.status(400).json({ error: 'Thiếu thông tin Lớp học hoặc Số máy.' });
      return;
    }

    const graded = await gradeSubmissionItem(
      body,
      body.lang === 'en' ? 'en' : 'vi',
      false,
    );

    if (graded.status === 'forbidden') {
      res.status(403).json({
        error: 'Bài tập này thuộc lớp học khác, không được giao cho lớp của em.',
      });
      return;
    }

    if (graded.status === 'not_found') {
      res.status(404).json({ error: 'Không tìm thấy câu hỏi tương ứng.' });
      return;
    }

    const { submission, alreadySubmitted } = graded;

    // Mirror newly graded submission to Firestore publicSubmissions so GitHub Pages / other devices & teacher see it live
    if (!alreadySubmitted) {
      const cfg = readFirebaseConfig();
      const written = await writePublicSubmissionViaRest(cfg, activePublicWorkspaceId, submission);
      if (!written && activePublicWorkspaceId === DEFAULT_PUBLIC_WORKSPACE_ID) {
        await writePublicSubmissionViaRest(cfg, LEGACY_FALLBACK_WORKSPACE_ID, submission);
      }
    }

    const store = loadStore();
    const leaderboard = buildLeaderboard(
      body.classId,
      store.submissions,
      body.lang === 'en' ? 'en' : 'vi',
    );

    res.json({ submission, alreadySubmitted: Boolean(alreadySubmitted), leaderboard });
  });

  // Sync queued offline answers
  app.post('/api/quiz/sync', async (req, res) => {
    const { items, lang } = req.body as {
      items: OfflineQueueItem[];
      lang?: Language;
    };

    const cfg = readFirebaseConfig();
    const synced: AnswerSubmission[] = [];
    for (const item of items ?? []) {
      const graded = await gradeSubmissionItem(
        item,
        lang === 'en' ? 'en' : 'vi',
        true,
      );
      if (graded.status === 'ok') {
        synced.push(graded.submission);
        if (!graded.alreadySubmitted) {
          const written = await writePublicSubmissionViaRest(
            cfg,
            activePublicWorkspaceId,
            graded.submission,
          );
          if (!written && activePublicWorkspaceId === DEFAULT_PUBLIC_WORKSPACE_ID) {
            await writePublicSubmissionViaRest(
              cfg,
              LEGACY_FALLBACK_WORKSPACE_ID,
              graded.submission,
            );
          }
        }
      }
    }

    const store = loadStore();
    const classId = items?.[0]?.classId || store.classes[0]?.id || '';
    const leaderboard = buildLeaderboard(
      classId,
      store.submissions,
      lang === 'en' ? 'en' : 'vi',
    );

    res.json({ synced, leaderboard });
  });

  app.post('/api/notifications/read', (req, res) => {
    const { notificationId, groupId } = req.body as {
      notificationId: string;
      groupId: string;
    };
    const store = loadStore();
    const target = store.notifications.find((n) => n.id === notificationId);
    if (target && groupId && !target.readByGroupIds.includes(groupId)) {
      target.readByGroupIds.push(groupId);
      saveStore(store);
    }
    res.json({ ok: true });
  });

  // Structured Step 4 API Export (ClassID, GroupID, Score, Rank, SkillLevel)
  app.get('/api/export', (req, res) => {
    const store = loadStore();
    const classId =
      typeof req.query.classId === 'string' && req.query.classId
        ? req.query.classId
        : store.classes[0]?.id || '';
    const lang = (req.query.lang === 'en' ? 'en' : 'vi') as Language;
    const leaderboard = buildLeaderboard(classId, store.submissions, lang);

    res.json({
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
    });
  });

  // =========================================================================
  // PERSONAL HOME 24-COMPETENCY SELF-ASSESSMENT & TEACHER REWARDS API
  // =========================================================================

  // POST /api/learners/profile — Register/update personal learner profile (Google Sign-In mandatory)
  app.post('/api/learners/profile', async (req, res) => {
    const body = req.body as {
      idToken?: string;
      photoUrl?: string;
      fullName?: string;
      className?: string;
      schoolName?: string;
      gradeBand?: LearnerGradeBand;
    };

    const fullName = String(body.fullName ?? '').trim();
    const className = String(body.className ?? '').trim();
    const schoolName = String(body.schoolName ?? '').trim();

    if (!fullName || !className || !schoolName) {
      res.status(400).json({
        error: 'Vui lòng nhập đầy đủ Họ tên, Lớp học và Trường học để lưu hồ sơ.',
      });
      return;
    }

    if (!body.idToken) {
      res.status(401).json({
        error:
          'Tự đánh giá ở nhà bắt buộc đăng nhập Google để lưu tiến độ và đảm bảo công bằng (tránh xem trước câu hỏi và đáp án).',
      });
      return;
    }

    const cfg = readFirebaseConfig();
    const verified = await verifyFirebaseIdTokenViaRest(
      String(body.idToken),
      cfg.apiKey || '',
    );
    if (!verified || !verified.emailVerified) {
      res.status(401).json({
        error: 'Không thể xác thực tài khoản Google của học sinh. Vui lòng đăng nhập lại.',
      });
      return;
    }

    const store = loadStore();
    const profile = upsertLearnerProfileInStore(store, {
      uid: verified.uid,
      authType: 'google',
      email: verified.email,
      photoUrl: body.photoUrl,
      fullName,
      className,
      schoolName,
      gradeBand: body.gradeBand,
    });
    saveStore(store);

    const { assessmentAttempts, teacherAwards } = ensureLearnerCollections(store);
    res.json({
      profile,
      attempts: assessmentAttempts.filter((a) => a.learnerUid === profile.uid).slice(0, 30),
      awards: teacherAwards.filter((a) => a.learnerUid === profile.uid),
    });
  });

  // GET /api/learners/me — Fetch authenticated Google learner profile, recent attempts, and teacher awards
  app.get('/api/learners/me', async (req, res) => {
    const idToken =
      typeof req.headers['x-learner-token'] === 'string'
        ? req.headers['x-learner-token'].trim()
        : '';

    if (!idToken) {
      res.status(401).json({
        error: 'Cần đăng nhập tài khoản Google để xem hồ sơ Tự đánh giá ở nhà.',
      });
      return;
    }

    const cfg = readFirebaseConfig();
    const verified = await verifyFirebaseIdTokenViaRest(idToken, cfg.apiKey || '');
    if (!verified?.uid || !verified.emailVerified) {
      res.status(401).json({
        error: 'Phiên đăng nhập Google không hợp lệ. Vui lòng đăng nhập lại.',
      });
      return;
    }

    const store = loadStore();
    const { learnerProfiles, assessmentAttempts, teacherAwards } =
      ensureLearnerCollections(store);
    const profile = learnerProfiles.find((p) => p.uid === verified.uid) ?? null;

    res.json({
      profile,
      attempts: profile
        ? assessmentAttempts.filter((a) => a.learnerUid === profile.uid).slice(0, 30)
        : [],
      awards: profile ? teacherAwards.filter((a) => a.learnerUid === profile.uid) : [],
    });
  });

  // POST /api/learners/assessment-submit — Record self-assessment session (Google-verified & retry-capped)
  app.post('/api/learners/assessment-submit', async (req, res) => {
    const body = req.body as {
      idToken?: string;
      learnerName?: string;
      className?: string;
      schoolName?: string;
      gradeBand?: LearnerGradeBand;
      mode?: AssessmentSessionMode;
      targetLevel?: AssessmentLevel;
      targetCompetencyId?: string;
      outcomes?: AssessmentExerciseOutcome[];
      maxCombo?: number;
    };

    if (!body.idToken) {
      res.status(401).json({
        error: 'Cần đăng nhập Google để lưu kết quả Tự đánh giá 24 Năng lực.',
      });
      return;
    }

    const cfg = readFirebaseConfig();
    const verified = await verifyFirebaseIdTokenViaRest(
      String(body.idToken),
      cfg.apiKey || '',
    );
    if (!verified?.uid || !verified.emailVerified) {
      res.status(401).json({
        error: 'Không thể xác thực tài khoản Google. Vui lòng đăng nhập lại.',
      });
      return;
    }

    const store = loadStore();
    const { profile, attempt } = recordAssessmentAttemptInStore(store, {
      learnerUid: verified.uid,
      learnerName: body.learnerName,
      className: body.className,
      schoolName: body.schoolName,
      authType: 'google',
      email: verified.email,
      gradeBand: body.gradeBand,
      mode: body.mode || 'variety_sprint',
      targetLevel: body.targetLevel,
      targetCompetencyId: body.targetCompetencyId,
      outcomes: Array.isArray(body.outcomes) ? body.outcomes : [],
      maxCombo: Number(body.maxCombo || 0),
    });
    saveStore(store);

    const { teacherAwards } = ensureLearnerCollections(store);
    res.json({
      profile,
      attempt,
      awards: teacherAwards.filter((a) => a.learnerUid === profile.uid),
    });
  });

  // GET /api/learners/honor — PII-free public Home Self-Assessment Honor Board (no emails!)
  app.get('/api/learners/honor', (req, res) => {
    const store = loadStore();
    const schoolName =
      typeof req.query.schoolName === 'string' ? req.query.schoolName : undefined;
    const className =
      typeof req.query.className === 'string' ? req.query.className : undefined;
    const entries = getPublicHonorFromStore(store, { schoolName, className });
    res.json({ entries });
  });

  // GET /api/teacher/learners — Authenticated Teacher/Admin view of all self-assessment learners & awards
  app.get('/api/teacher/learners', requireTeacherAuth, (_req, res) => {
    const store = loadStore();
    const { learnerProfiles, assessmentAttempts, teacherAwards } =
      ensureLearnerCollections(store);
    res.json({
      learners: learnerProfiles,
      attempts: assessmentAttempts.slice(0, 200),
      awards: teacherAwards,
    });
  });

  // POST /api/teacher/awards — Teacher issues a reward badge, bonus XP & praise message to a learner
  app.post('/api/teacher/awards', requireTeacherAuth, (req, res) => {
    const authPayload = getAuthenticatedTeacher(req);
    const body = req.body as {
      learnerUid?: string;
      badgeId?: string;
      badgeTitle?: string;
      message?: string;
      bonusXp?: number;
      awardedByName?: string;
    };

    if (!body.learnerUid || !body.badgeTitle?.trim()) {
      res.status(400).json({ error: 'Vui lòng chọn học sinh và danh hiệu khen thưởng.' });
      return;
    }

    const store = loadStore();
    const result = createTeacherAwardInStore(store, {
      learnerUid: body.learnerUid,
      badgeId: body.badgeId || 'custom',
      badgeTitle: body.badgeTitle.trim(),
      message: body.message || '',
      bonusXp: Number(body.bonusXp ?? 100),
      awardedByName:
        body.awardedByName?.trim() ||
        (authPayload?.email ? `GV (${authPayload.email})` : 'Giáo viên'),
      awardedByEmail: authPayload?.email,
    });

    if (!result) {
      res.status(404).json({ error: 'Không tìm thấy hồ sơ học sinh tương ứng.' });
      return;
    }

    saveStore(store);
    res.status(201).json(result);
  });

  // DELETE /api/teacher/awards/:id — Remove a teacher award
  app.delete('/api/teacher/awards/:id', requireTeacherAuth, (req, res) => {
    const store = loadStore();
    const deleted = deleteTeacherAwardInStore(store, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Không tìm thấy khen thưởng để xóa.' });
      return;
    }
    saveStore(store);
    res.json({ ok: true });
  });

  // Always respond with JSON for unmatched or failing /api/* requests so clients never receive HTML <!doctype>
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint không tồn tại trên máy chủ.' });
  });

  app.use(
    '/api',
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        typeof (err as { status?: number })?.status === 'number'
          ? (err as { status: number }).status
          : 500;
      const message =
        err instanceof Error ? err.message : 'Lỗi xử lý trên máy chủ.';
      res.status(status).json({ error: message });
    },
  );

  let viteServer: Awaited<ReturnType<typeof createViteServer>> | null = null;

  if (process.env.NODE_ENV !== 'production') {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const viteReady = createViteServer({
      server: {
        middlewareMode: true,
        hmr: !disableHmr,
        watch: disableHmr ? null : undefined,
      },
      appType: 'spa',
    }).then((server) => {
      viteServer = server;
      return server;
    });

    // Attach Vite lazily so port 3000 opens immediately for health checks without waiting on cold Vite warm-up
    app.use((req, res, next) => {
      viteReady
        .then((server) => server.middlewares(req, res, next))
        .catch(next);
    });
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    const staticRoot = fs.existsSync(path.join(distPath, 'index.html'))
      ? distPath
      : path.resolve(process.cwd(), 'docs');
    app.use(express.static(staticRoot));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(staticRoot, 'index.html'));
    });
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`EduBot Digital Citizen running on http://localhost:${PORT}`);
    // Immediately pull real teacher classes, lessons, and alerts published in Firebase on boot
    void hydrateFromPublicWorkspace('', { replaceContent: true, forceRefresh: true });
  });

  const shutdown = () => {
    httpServer.close(() => {
      if (viteServer) {
        void viteServer.close().finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start EduBot server:', err);
  process.exit(1);
});
