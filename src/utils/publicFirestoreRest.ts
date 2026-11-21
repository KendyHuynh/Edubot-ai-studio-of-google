import {
  AnswerSubmission,
  ClassRoom,
  Lesson,
  PushNotification,
} from '../shared/types';
import {
  buildPublicSubmissionRestFields,
  FirestoreRestValue,
  fromFirestoreRestValue,
  mergeLatestSubmissions,
  resolveCandidateWorkspaceIds,
  toFirestoreDocId,
} from './firestoreHelpers';

export interface PublicFirestoreConfig {
  projectId?: string;
  firestoreDatabaseId?: string;
  apiKey?: string;
}

export interface PublicWorkspaceSnapshot {
  workspaceId: string;
  classes: ClassRoom[];
  lessons: Lesson[];
  notifications?: PushNotification[];
}

function isValidConfig(cfg: PublicFirestoreConfig): cfg is Required<PublicFirestoreConfig> {
  return Boolean(cfg.projectId && cfg.firestoreDatabaseId && cfg.apiKey);
}

/**
 * Fetches the teacher's published public workspace snapshot via Firestore REST API (zero-login).
 * Tries requested `?ws=` first (if any), then `default`, then legacy fallback workspace.
 */
export async function fetchPublicWorkspaceSnapshot(
  cfg: PublicFirestoreConfig,
  requestedWs?: string | null,
): Promise<PublicWorkspaceSnapshot | null> {
  if (!isValidConfig(cfg)) return null;
  const candidates = resolveCandidateWorkspaceIds(requestedWs);

  for (const wsId of candidates) {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
        cfg.projectId,
      )}/databases/${encodeURIComponent(
        cfg.firestoreDatabaseId,
      )}/documents/publicWorkspaces/${encodeURIComponent(
        wsId,
      )}?key=${encodeURIComponent(cfg.apiKey)}`;

      const res = await fetch(url);
      if (!res.ok) continue;
      const doc = (await res.json()) as {
        fields?: Record<string, FirestoreRestValue>;
      };
      if (!doc.fields) continue;

      const decoded = fromFirestoreRestValue({
        mapValue: { fields: doc.fields },
      }) as {
        classes?: ClassRoom[];
        lessons?: Lesson[];
        notifications?: PushNotification[];
      };

      const classes = Array.isArray(decoded.classes)
        ? decoded.classes.filter((c) => Boolean(c?.id && c?.name))
        : [];
      const lessons = Array.isArray(decoded.lessons)
        ? decoded.lessons.filter(
            (l) => Boolean(l?.id && l?.title && Array.isArray(l.questions) && l.questions.length > 0),
          )
        : [];
      const notifications = Array.isArray(decoded.notifications)
        ? decoded.notifications.filter((n) => Boolean(n?.id && n?.classId))
        : undefined;

      if (classes.length > 0 || lessons.length > 0) {
        return {
          workspaceId: wsId,
          classes,
          lessons,
          notifications,
        };
      }
    } catch {
      // Try next candidate or fall back cleanly on offline network
    }
  }

  return null;
}

/**
 * Queries zero-login student submissions under `/publicWorkspaces/{workspaceId}/submissions`
 * matching the rule-enforced `where('workspaceId', '==', workspaceId)` and `limit(300)`.
 */
export async function fetchPublicSubmissionsViaRest(
  cfg: PublicFirestoreConfig,
  workspaceId: string,
): Promise<AnswerSubmission[]> {
  if (!isValidConfig(cfg)) return [];
  const cleanWs = toFirestoreDocId(workspaceId, 64);
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId,
    )}/databases/${encodeURIComponent(
      cfg.firestoreDatabaseId,
    )}/documents/publicWorkspaces/${encodeURIComponent(
      cleanWs,
    )}:runQuery?key=${encodeURIComponent(cfg.apiKey)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'submissions' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'workspaceId' },
              op: 'EQUAL',
              value: { stringValue: cleanWs },
            },
          },
          limit: 300,
        },
      }),
    });

    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{
      document?: { fields?: Record<string, FirestoreRestValue> };
    }>;
    if (!Array.isArray(rows)) return [];

    const parsed: AnswerSubmission[] = [];
    for (const row of rows) {
      if (!row?.document?.fields) continue;
      const d = fromFirestoreRestValue({
        mapValue: { fields: row.document.fields },
      }) as Record<string, unknown>;
      if (!d?.id || !d?.classId || !d?.lessonId || !d?.questionId) continue;
      parsed.push({
        id: String(d.id),
        classId: String(d.classId),
        groupId: String(d.groupId ?? ''),
        tabletNumber: Number(d.tabletNumber ?? 1),
        groupName: String(d.groupName ?? ''),
        lessonId: String(d.lessonId),
        lessonTitle: String(d.lessonTitle ?? ''),
        questionId: String(d.questionId),
        competencyId: String(d.competencyId ?? '1.1'),
        competencyIds: Array.isArray(d.competencyIds)
          ? d.competencyIds.map((c) => String(c))
          : undefined,
        userAnswer: String(d.userAnswer ?? ''),
        isCorrect: Boolean(d.isCorrect),
        basePoints: Number(d.basePoints ?? 0),
        speedBonus: Number(d.speedBonus ?? 0),
        totalPoints: Number(d.totalPoints ?? 0),
        elapsedMs: Number(d.elapsedMs ?? 0),
        submittedAt: String(d.submittedAt ?? new Date().toISOString()),
        feedbackText: String(d.feedbackText ?? ''),
        explanation: String(d.explanation ?? ''),
        syncedFromOffline: Boolean(d.syncedFromOffline),
      });
    }

    return mergeLatestSubmissions([], parsed);
  } catch {
    return [];
  }
}

/**
 * Persists a single graded student answer submission to `/publicWorkspaces/{workspaceId}/submissions/{docId}`
 * via Firestore REST `:commit` with server-side `REQUEST_TIME` timestamp — zero student login needed!
 */
export async function writePublicSubmissionViaRest(
  cfg: PublicFirestoreConfig,
  workspaceId: string,
  submission: AnswerSubmission,
): Promise<boolean> {
  if (!isValidConfig(cfg)) return false;
  const cleanWs = toFirestoreDocId(workspaceId, 64);
  const { docId, fields } = buildPublicSubmissionRestFields(cleanWs, submission);
  const docName = `projects/${cfg.projectId}/databases/${cfg.firestoreDatabaseId}/documents/publicWorkspaces/${cleanWs}/submissions/${docId}`;

  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId,
    )}/databases/${encodeURIComponent(
      cfg.firestoreDatabaseId,
    )}/documents:commit?key=${encodeURIComponent(cfg.apiKey)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writes: [
          {
            update: {
              name: docName,
              fields,
            },
            currentDocument: { exists: false },
            updateTransforms: [
              {
                fieldPath: 'createdAt',
                setToServerValue: 'REQUEST_TIME',
              },
            ],
          },
        ],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
