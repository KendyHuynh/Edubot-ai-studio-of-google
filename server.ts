import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import {
  DEFAULT_PUBLIC_WORKSPACE_ID,
  LEGACY_FALLBACK_WORKSPACE_ID,
  mergeLatestSubmissions,
  mergeSubmissionActivityLogs,
} from './src/utils/firestoreHelpers';
import {
  fetchPublicSubmissionsViaRest,
  fetchPublicWorkspaceSnapshot,
  writePublicSubmissionViaRest,
} from './src/utils/publicFirestoreRest';
import { getCompetencyById } from './src/shared/competencies';
import {
  buildCompetencyMatrix,
  buildDomainChampions,
  buildLeaderboard,
  calculatePoints,
  formatGroupId,
  isAnswerMatch,
} from './src/shared/scoring';
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
} from './src/shared/types';
import { generateLessonQuestions, evaluateShortAnswerWithAI } from './server/gemini';
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
      if (snapshot.classes.length > 0) {
        store.classes = snapshot.classes;
        changed = true;
      }
      if (snapshot.lessons.length > 0) {
        store.lessons = snapshot.lessons;
        changed = true;
      }
      if (snapshot.notifications && snapshot.notifications.length > 0) {
        const readMap = new Map(
          store.notifications.map((n) => [n.id, new Set(n.readByGroupIds ?? [])]),
        );
        store.notifications = snapshot.notifications.map((n) => {
          const existingRead = readMap.get(n.id);
          const mergedRead = Array.from(
            new Set([...(n.readByGroupIds ?? []), ...(existingRead ? Array.from(existingRead) : [])]),
          );
          return { ...n, readByGroupIds: mergedRead };
        });
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
      if (rows.length > 0) cloudSubs.push(...rows);
    }

    if (cloudSubs.length > 0) {
      store.submissions = mergeLatestSubmissions(store.submissions, cloudSubs);
      store.activityLogs = mergeSubmissionActivityLogs(store.activityLogs, store.submissions);
      changed = true;
    }

    if (changed) {
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
  const PORT = 3000;

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

    const resolvedWsId = await hydrateFromPublicWorkspace(ws, {
      replaceContent: !includeAnswers,
      forceRefresh,
    });

    const store = loadStore();
    const classId = typeof req.query.classId === 'string' ? req.query.classId : '';
    const lang = (req.query.lang === 'en' ? 'en' : 'vi') as Language;

    const sanitizedLessons = store.lessons.map((lesson) => ({
      ...lesson,
      questions: lesson.questions.map((q) =>
        includeAnswers ? q : { ...q, correctAnswer: undefined },
      ),
    }));

    const targetClassId =
      classId && store.classes.some((c) => c.id === classId)
        ? classId
        : store.classes[0]?.id || 'LOP-8A';
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
      submissionsCount: store.submissions.length,
      activeWorkspaceId: resolvedWsId,
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
      assignedClassIds,
      language,
    } = req.body as {
      title?: string;
      sourceFileName?: string;
      textContent?: string;
      base64Data?: string;
      mimeType?: string;
      questionCount?: number;
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
        language: language ?? 'vi',
      });

      const store = loadStore();
      const targetClasses =
        assignedClassIds && assignedClassIds.length > 0
          ? assignedClassIds
          : [store.classes[0]?.id || 'LOP-5A'];

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
      classId: lesson.assignedClassIds[0] || store.classes[0]?.id || 'LOP-5A',
      groupId: 'Giáo viên',
      action: 'Chỉnh sửa bài học',
      detail: `${lesson.title} (${lesson.questions.length} câu hỏi)`,
      timestamp: new Date().toISOString(),
    });

    saveStore(store);
    res.json({ lesson });
  });

  // Hydrate cloud Firestore state into local server store (replaces seed classes/lessons with authoritative cloud data)
  app.post('/api/sync/cloud-hydrate', requireTeacherAuth, (req, res) => {
    const payload = req.body as {
      classes?: ClassRoom[];
      lessons?: Lesson[];
      submissions?: AnswerSubmission[];
      notifications?: PushNotification[];
      activityLogs?: ActivityLog[];
    };

    const store = loadStore();

    if (Array.isArray(payload.classes) && payload.classes.length > 0) {
      const validClasses = payload.classes.filter((c) => Boolean(c?.id && c?.name));
      if (validClasses.length > 0) {
        store.classes = validClasses;
      }
    }

    if (Array.isArray(payload.lessons) && payload.lessons.length > 0) {
      const validLessons = payload.lessons.filter(
        (l) => Boolean(l?.id && l?.title && Array.isArray(l.questions) && l.questions.length > 0),
      );
      if (validLessons.length > 0) {
        store.lessons = validLessons;
      }
    }

    if (Array.isArray(payload.submissions) && payload.submissions.length > 0) {
      store.submissions = mergeLatestSubmissions(store.submissions, payload.submissions);
    }

    if (Array.isArray(payload.notifications) && payload.notifications.length > 0) {
      const notifMap = new Map(store.notifications.map((n) => [n.id, n]));
      for (const notif of payload.notifications) {
        if (notif?.id) {
          notifMap.set(notif.id, notif);
        }
      }
      store.notifications = Array.from(notifMap.values());
    }

    if (Array.isArray(payload.activityLogs) && payload.activityLogs.length > 0) {
      const logMap = new Map(store.activityLogs.map((l) => [l.id, l]));
      for (const log of payload.activityLogs) {
        if (log?.id) {
          logMap.set(log.id, log);
        }
      }
      store.activityLogs = mergeSubmissionActivityLogs(
        Array.from(logMap.values()),
        store.submissions,
      );
    } else if (store.submissions.length > 0) {
      store.activityLogs = mergeSubmissionActivityLogs(store.activityLogs, store.submissions);
    }

    saveStore(store);
    res.json({
      ok: true,
      counts: {
        classes: store.classes.length,
        lessons: store.lessons.length,
        submissions: store.submissions.length,
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
  ): Promise<AnswerSubmission | null> {
    const store = loadStore();
    const lesson = store.lessons.find((l) => l.id === item.lessonId);
    const question = lesson?.questions.find((q) => q.id === item.questionId);
    if (!lesson || !question) {
      return null;
    }

    const groupId = formatGroupId(item.tabletNumber, item.groupName);
    const comp = getCompetencyById(question.competencyId);
    const compName = `${comp.id}. ${lang === 'vi' ? comp.nameVi : comp.nameEn}`;

    let isCorrect = isAnswerMatch(
      item.userAnswer,
      question.correctAnswer ?? '',
      question.type,
    );
    let feedbackText = '';
    let explanation = question.explanation;

    if (question.type === 'short_answer' && process.env.GEMINI_API_KEY) {
      try {
        const aiGrade = await evaluateShortAnswerWithAI({
          questionText: question.questionText,
          correctAnswer: question.correctAnswer ?? '',
          userAnswer: item.userAnswer,
          competencyName: compName,
          groupName: item.groupName,
          language: lang,
        });
        isCorrect = aiGrade.isCorrect;
        feedbackText = aiGrade.feedbackText;
        explanation = aiGrade.explanation;
      } catch {
        // Fallback smoothly to deterministic feedback if AI grading call drops
      }
    }

    const breakdown = calculatePoints(isCorrect, item.elapsedMs);

    if (!feedbackText) {
      if (lang === 'en') {
        feedbackText = isCorrect
          ? breakdown.speedBonus >= 35
            ? `Lightning fast, ${item.groupName}! +${breakdown.totalPoints} pts (including +${breakdown.speedBonus} speed bonus)!`
            : `Spot on, ${item.groupName}! +${breakdown.totalPoints} pts!`
          : `Nice try, ${item.groupName}! Check the Digital Citizen tip below and keep going!`;
      } else {
        feedbackText = isCorrect
          ? breakdown.speedBonus >= 35
            ? `Quá nhanh quá nguy hiểm! Nhóm ${item.groupName} ghi ngay +${breakdown.totalPoints} điểm (gồm +${breakdown.speedBonus} điểm tốc độ)!`
            : `Chính xác tuyệt đối! Chúc mừng nhóm ${item.groupName} nhận +${breakdown.totalPoints} điểm!`
          : `Suýt đúng rồi ${item.groupName} ơi! Xem bí kíp Công dân số bên dưới để ghi điểm câu sau nhé!`;
      }
    }

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
      explanation,
      syncedFromOffline,
    };

    // Replace earlier attempt for the same group + question + lesson so retries update cleanly or keep best
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

    const log: ActivityLog = {
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
    };
    store.activityLogs.unshift(log);

    saveStore(store);
    return submission;
  }

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

    const submission = await gradeSubmissionItem(
      body,
      body.lang === 'en' ? 'en' : 'vi',
      false,
    );

    if (!submission) {
      res.status(404).json({ error: 'Không tìm thấy câu hỏi tương ứng.' });
      return;
    }

    // Mirror graded submission to Firestore publicSubmissions so GitHub Pages / other devices & teacher see it live
    const cfg = readFirebaseConfig();
    const written = await writePublicSubmissionViaRest(cfg, activePublicWorkspaceId, submission);
    if (!written && activePublicWorkspaceId === DEFAULT_PUBLIC_WORKSPACE_ID) {
      await writePublicSubmissionViaRest(cfg, LEGACY_FALLBACK_WORKSPACE_ID, submission);
    }

    const store = loadStore();
    const leaderboard = buildLeaderboard(
      body.classId,
      store.submissions,
      body.lang === 'en' ? 'en' : 'vi',
    );

    res.json({ submission, leaderboard });
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
      const result = await gradeSubmissionItem(
        item,
        lang === 'en' ? 'en' : 'vi',
        true,
      );
      if (result) {
        synced.push(result);
        const written = await writePublicSubmissionViaRest(cfg, activePublicWorkspaceId, result);
        if (!written && activePublicWorkspaceId === DEFAULT_PUBLIC_WORKSPACE_ID) {
          await writePublicSubmissionViaRest(cfg, LEGACY_FALLBACK_WORKSPACE_ID, result);
        }
      }
    }

    const store = loadStore();
    const classId = items?.[0]?.classId || store.classes[0]?.id || 'LOP-8A';
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
        : store.classes[0]?.id || 'LOP-5A';
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

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`EduBot Digital Citizen running on http://localhost:${PORT}`);
  });
}

startServer();
