import {
  ActivityLog,
  AnswerSubmission,
  ClassRoom,
  Lesson,
  Question,
} from '../shared/types';
import { getCompetencyById } from '../shared/competencies';

/**
 * Default school-wide public workspace ID published by the primary Teacher/Admin
 * so students opening the root URL (without ?ws=...) always receive real synced data.
 */
export const DEFAULT_PUBLIC_WORKSPACE_ID = 'default';

/**
 * Fallback live teacher workspace ID used only if `publicWorkspaces/default`
 * has not been published yet (ensures instant zero-login sync for existing deployments).
 */
export const LEGACY_FALLBACK_WORKSPACE_ID = 'WS-LHH4MPLJSIV8';

const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

/**
 * Resolves ordered candidate public workspace IDs to try when hydrating student/tablet data.
 */
export function resolveCandidateWorkspaceIds(requestedWs?: string | null): string[] {
  const candidates: string[] = [];
  const clean = (requestedWs ?? '').trim();
  if (clean && WORKSPACE_ID_RE.test(clean)) {
    candidates.push(clean);
  }
  if (!candidates.includes(DEFAULT_PUBLIC_WORKSPACE_ID)) {
    candidates.push(DEFAULT_PUBLIC_WORKSPACE_ID);
  }
  if (!candidates.includes(LEGACY_FALLBACK_WORKSPACE_ID)) {
    candidates.push(LEGACY_FALLBACK_WORKSPACE_ID);
  }
  return candidates;
}

/**
 * Converts arbitrary IDs (including legacy Vietnamese class codes like "LỚP-8A")
 * into safe Firestore document IDs matching ^[A-Za-z0-9_\-]+$.
 */
export function toFirestoreDocId(raw: string, maxLen = 80): string {
  const cleaned = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'D')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'doc').slice(0, maxLen);
}

/**
 * Normalizes a teacher-entered class code into uppercase ASCII e.g. "Lớp 6B" -> "LOP-6B".
 */
export function normalizeClassCode(raw: string): string {
  return toFirestoreDocId(raw, 64).toUpperCase();
}

const DEMO_SEED_CLASS_SIGNATURES = new Map<string, string>([
  ['LOP-5A', 'Cô Minh Anh'],
  ['LOP-5B', 'Thầy Quốc Bảo'],
  ['LOP-6A', 'Cô Thu Hà'],
]);

/**
 * Returns true when `classes` is empty or contains ONLY the built-in starter demo classes
 * (LOP-5A, LOP-5B, LOP-6A). Used to guarantee real teacher classes from Firestore always
 * replace starter demo placeholders—and demo classes are never accidentally pushed to cloud.
 */
export function isDefaultSeedClassesOnly(classes: ClassRoom[]): boolean {
  if (!Array.isArray(classes) || classes.length === 0) return true;
  return classes.every((c) => {
    const demoTeacher = DEMO_SEED_CLASS_SIGNATURES.get(c.id);
    return Boolean(demoTeacher && c.teacherName === demoTeacher);
  });
}

/**
 * Sanitizes a Question for Firestore storage (removes undefined fields, ensures competencies).
 */
export function sanitizeQuestionForFirestore(q: Question, idx: number, lessonId: string): Question {
  const compIds =
    Array.isArray(q.competencyIds) && q.competencyIds.length > 0
      ? q.competencyIds
      : [q.competencyId || '1.1'];
  const safeType: Question['type'] =
    q.type === 'fill_blank' ||
    q.type === 'short_answer' ||
    q.type === 'true_false' ||
    q.type === 'true_false_multi'
      ? q.type
      : 'multiple_choice';
  const base: Question = {
    id: toFirestoreDocId(q.id || `${lessonId}-q${idx + 1}`, 80),
    type: safeType,
    questionText: (q.questionText ?? '').slice(0, 1000),
    aiSearchKeywordHint: (q.aiSearchKeywordHint ?? '').slice(0, 300),
    correctAnswer: (q.correctAnswer ?? '').slice(0, 600),
    competencyId: compIds[0].slice(0, 16),
    competencyIds: compIds.slice(0, 10),
    explanation: (q.explanation ?? '').slice(0, 1000),
  };
  if (
    (base.type === 'multiple_choice' ||
      base.type === 'true_false' ||
      base.type === 'true_false_multi') &&
    Array.isArray(q.options) &&
    q.options.length > 0
  ) {
    base.options = q.options.map((opt) => String(opt).slice(0, 300));
  }
  return base;
}

/**
 * Prepares Lesson mutable payload matching firestore.rules isValidLesson bounds.
 */
export function sanitizeLessonFieldsForFirestore(lesson: Lesson, docId: string) {
  return {
    title: (lesson.title || 'Bài học Công dân số').slice(0, 240),
    topic: (lesson.topic || lesson.title || 'Công dân số').slice(0, 240),
    sourceFileName: (lesson.sourceFileName || 'BaiHoc_CongDanSo.txt').slice(0, 200),
    summary: (lesson.summary || '').slice(0, 2000),
    assignedClassIds: (lesson.assignedClassIds ?? []).slice(0, 50).map((c) => String(c).slice(0, 64)),
    questions: (lesson.questions ?? [])
      .slice(0, 30)
      .map((q, idx) => sanitizeQuestionForFirestore(q, idx, docId)),
  };
}

export interface FirestoreRestValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
  nullValue?: null;
  arrayValue?: { values?: FirestoreRestValue[] };
  mapValue?: { fields?: Record<string, FirestoreRestValue> };
}

export function fromFirestoreRestValue(val: FirestoreRestValue | undefined): unknown {
  if (!val) return null;
  if ('stringValue' in val) return val.stringValue ?? '';
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('timestampValue' in val) return val.timestampValue ?? '';
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) {
    return (val.arrayValue?.values ?? []).map((item) => fromFirestoreRestValue(item));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    const fields = val.mapValue?.fields ?? {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = fromFirestoreRestValue(v);
    }
    return out;
  }
  return null;
}

/**
 * Encodes plain JS values into Firestore REST API v1 typed value objects.
 */
export function toFirestoreRestValue(value: unknown): FirestoreRestValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { integerValue: '0' };
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((item) => toFirestoreRestValue(item)),
      },
    };
  }
  if (typeof value === 'object') {
    const fields: Record<string, FirestoreRestValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = toFirestoreRestValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

/**
 * Builds sanitized Firestore REST fields matching `isValidPublicSubmission` in firestore.rules
 * (excluding `createdAt`, which is injected server-side via `REQUEST_TIME` updateTransform).
 */
export function buildPublicSubmissionRestFields(
  workspaceId: string,
  sub: AnswerSubmission,
): { docId: string; fields: Record<string, FirestoreRestValue> } {
  const cleanWs = toFirestoreDocId(workspaceId || DEFAULT_PUBLIC_WORKSPACE_ID, 64);
  const docId = toFirestoreDocId(
    sub.id || `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    128,
  );
  const compId = (sub.competencyId || '1.1').slice(0, 16);
  const compIds = (
    Array.isArray(sub.competencyIds) && sub.competencyIds.length > 0
      ? sub.competencyIds
      : [compId]
  )
    .slice(0, 10)
    .map((c) => String(c).slice(0, 16));

  const plain: Record<string, unknown> = {
    id: docId,
    workspaceId: cleanWs,
    classId: (sub.classId || 'LOP-8A').slice(0, 64),
    groupId: (sub.groupId || 'Máy-01 · Nhóm 1').slice(0, 120),
    tabletNumber: Math.max(1, Math.min(10, Math.round(Number(sub.tabletNumber) || 1))),
    groupName: (sub.groupName || 'Nhóm 1').slice(0, 80),
    lessonId: toFirestoreDocId(sub.lessonId || 'lesson', 80),
    lessonTitle: (sub.lessonTitle || 'Bài học').slice(0, 240),
    questionId: toFirestoreDocId(sub.questionId || 'q1', 80),
    competencyId: compId,
    competencyIds: compIds,
    userAnswer: (sub.userAnswer ?? '').slice(0, 1000),
    isCorrect: Boolean(sub.isCorrect),
    basePoints: Math.max(0, Math.min(1000, Math.round(Number(sub.basePoints) || 0))),
    speedBonus: Math.max(0, Math.min(1000, Math.round(Number(sub.speedBonus) || 0))),
    totalPoints: Math.max(0, Math.min(2000, Math.round(Number(sub.totalPoints) || 0))),
    elapsedMs: Math.max(0, Math.min(3600000, Math.round(Number(sub.elapsedMs) || 0))),
    submittedAt: (sub.submittedAt || new Date().toISOString()).slice(0, 64),
    feedbackText: (sub.feedbackText ?? '').slice(0, 500),
    explanation: (sub.explanation ?? '').slice(0, 1200),
    syncedFromOffline: Boolean(sub.syncedFromOffline),
  };

  const fields: Record<string, FirestoreRestValue> = {};
  for (const [k, v] of Object.entries(plain)) {
    fields[k] = toFirestoreRestValue(v);
  }
  return { docId, fields };
}

/**
 * Deduplicates submissions by (classId, groupId, lessonId, questionId), keeping the newest submittedAt.
 */
export function mergeLatestSubmissions(
  existing: AnswerSubmission[],
  incoming: AnswerSubmission[],
): AnswerSubmission[] {
  const map = new Map<string, AnswerSubmission>();
  const keyOf = (s: AnswerSubmission) =>
    `${s.classId}::${s.groupId}::${s.lessonId}::${s.questionId}`;

  const insert = (s: AnswerSubmission) => {
    if (!s || !s.classId || !s.lessonId || !s.questionId) return;
    const key = keyOf(s);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, s);
      return;
    }
    const prevTime = new Date(prev.submittedAt || 0).getTime();
    const nextTime = new Date(s.submittedAt || 0).getTime();
    if (nextTime >= prevTime) {
      map.set(key, s);
    }
  };

  for (const s of existing) insert(s);
  for (const s of incoming) insert(s);

  return Array.from(map.values()).sort(
    (a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime(),
  );
}

/**
 * Synthesizes activity log entries for cloud-synced student submissions that don't yet have a log row.
 */
export function mergeSubmissionActivityLogs(
  existingLogs: ActivityLog[],
  submissions: AnswerSubmission[],
): ActivityLog[] {
  const byId = new Map<string, ActivityLog>();
  for (const log of existingLogs) {
    if (log?.id) byId.set(log.id, log);
  }

  for (const sub of submissions) {
    const syntheticId = `log-sub-${toFirestoreDocId(sub.id, 64)}`;
    const alreadyLogged =
      byId.has(syntheticId) ||
      existingLogs.some(
        (l) =>
          l.classId === sub.classId &&
          l.groupId === sub.groupId &&
          l.timestamp === sub.submittedAt &&
          l.competencyId === sub.competencyId,
      );
    if (!alreadyLogged) {
      const comp = getCompetencyById(sub.competencyId);
      byId.set(syntheticId, {
        id: syntheticId,
        classId: sub.classId,
        groupId: sub.groupId,
        action: sub.syncedFromOffline
          ? sub.isCorrect
            ? 'Đồng bộ ngoại tuyến · Đúng'
            : 'Đồng bộ ngoại tuyến · Chưa đúng'
          : sub.isCorrect
            ? 'Trả lời đúng'
            : 'Trả lời chưa đúng',
        detail: `Năng lực ${comp.id} (${comp.nameVi}) · ${(sub.elapsedMs / 1000).toFixed(1)}s`,
        competencyId: sub.competencyId,
        pointsDelta: sub.totalPoints,
        timestamp: sub.submittedAt,
      });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0, 200);
}
