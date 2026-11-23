import {
  AnswerSubmission,
  ClassRoom,
  Lesson,
  PushNotification,
} from '../shared/types';
import {
  buildPublicSubmissionRestFields,
  dedupeById,
  FirestoreRestValue,
  fromFirestoreRestValue,
  mergeLatestSubmissions,
  normalizeClassCode,
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
  updatedAt?: string;
}

function isValidConfig(cfg: PublicFirestoreConfig): cfg is Required<PublicFirestoreConfig> {
  return Boolean(cfg.projectId && cfg.firestoreDatabaseId && cfg.apiKey);
}

function parseTimestampMs(raw?: string | null): number {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

async function fetchSinglePublicWorkspaceDoc(
  cfg: Required<PublicFirestoreConfig>,
  wsId: string,
): Promise<PublicWorkspaceSnapshot | null> {
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      cfg.projectId,
    )}/databases/${encodeURIComponent(
      cfg.firestoreDatabaseId,
    )}/documents/publicWorkspaces/${encodeURIComponent(
      wsId,
    )}?key=${encodeURIComponent(cfg.apiKey)}`;

    const res = await fetch(url);
    if (!res.ok) return null;
    const doc = (await res.json()) as {
      updateTime?: string;
      fields?: Record<string, FirestoreRestValue>;
    };
    if (!doc.fields) return null;

    const decoded = fromFirestoreRestValue({
      mapValue: { fields: doc.fields },
    }) as {
      classes?: ClassRoom[];
      lessons?: Lesson[];
      notifications?: PushNotification[];
      updatedAt?: string;
    };

    const classes = Array.isArray(decoded.classes)
      ? dedupeById(
          decoded.classes
            .filter((c) => Boolean(c?.id && c?.name))
            .map((c) => ({
              ...c,
              id: normalizeClassCode(String(c.id)),
            })),
        )
      : [];
    const lessons = Array.isArray(decoded.lessons)
      ? dedupeById(
          decoded.lessons
            .filter(
              (l) => Boolean(l?.id && l?.title && Array.isArray(l.questions) && l.questions.length > 0),
            )
            .map((l) => ({
              ...l,
              assignedClassIds: Array.isArray(l.assignedClassIds)
                ? Array.from(
                    new Set(
                      l.assignedClassIds
                        .map((cid) => String(cid ?? '').trim())
                        .filter(Boolean)
                        .map((cid) => normalizeClassCode(cid))
                        .filter(Boolean),
                    ),
                  )
                : [],
            })),
        )
      : [];
    const notifications = Array.isArray(decoded.notifications)
      ? decoded.notifications
          .filter((n) => Boolean(n?.id && n?.classId))
          .map((n) => ({
            ...n,
            classId: normalizeClassCode(String(n.classId)),
          }))
      : undefined;

    if (classes.length === 0 && lessons.length === 0) {
      return null;
    }

    const updatedAt =
      (typeof decoded.updatedAt === 'string' && decoded.updatedAt) ||
      (typeof doc.updateTime === 'string' && doc.updateTime) ||
      undefined;

    return {
      workspaceId: wsId,
      classes,
      lessons,
      notifications,
      updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Fetches the teacher's published public workspace snapshot via Firestore REST API (zero-login).
 * Evaluates candidate workspaces (`?ws=`, `default`, legacy fallback) and selects the freshest
 * snapshot with real lessons so a stale `default` document with 0 lessons never hides teacher lessons
 * from incognito/student browsers.
 */
export async function fetchPublicWorkspaceSnapshot(
  cfg: PublicFirestoreConfig,
  requestedWs?: string | null,
): Promise<PublicWorkspaceSnapshot | null> {
  if (!isValidConfig(cfg)) return null;
  const candidates = resolveCandidateWorkspaceIds(requestedWs);
  const explicitWs = (requestedWs ?? '').trim();

  // If teacher shared an explicit ?ws= code and it already has lessons, honor it immediately
  if (explicitWs && candidates[0] === explicitWs) {
    const explicitSnap = await fetchSinglePublicWorkspaceDoc(cfg, explicitWs);
    if (explicitSnap && explicitSnap.lessons.length > 0) {
      return explicitSnap;
    }
    const restSnaps = (
      await Promise.all(
        candidates.slice(1).map((wsId) => fetchSinglePublicWorkspaceDoc(cfg, wsId)),
      )
    ).filter((s): s is PublicWorkspaceSnapshot => Boolean(s));
    const all = explicitSnap ? [explicitSnap, ...restSnaps] : restSnaps;
    if (all.length === 0) return null;
    const withLessons = all.filter((s) => s.lessons.length > 0);
    if (withLessons.length > 0) {
      withLessons.sort((a, b) => parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt));
      const best = withLessons[0];
      return {
        ...best,
        classes: dedupeById([...(explicitSnap?.classes ?? []), ...best.classes]),
      };
    }
    return explicitSnap ?? all[0];
  }

  // Zero-login root URL: fetch default & fallback in parallel and pick freshest snapshot with lessons
  const snapshots = (
    await Promise.all(candidates.map((wsId) => fetchSinglePublicWorkspaceDoc(cfg, wsId)))
  ).filter((s): s is PublicWorkspaceSnapshot => Boolean(s));

  if (snapshots.length === 0) return null;
  if (snapshots.length === 1) return snapshots[0];

  const withLessons = snapshots.filter((s) => s.lessons.length > 0);
  if (withLessons.length === 0) {
    return snapshots[0];
  }

  // Pick the snapshot with the strictly newest updatedAt timestamp among those that have lessons
  let best = withLessons[0];
  let bestTs = parseTimestampMs(best.updatedAt);
  for (let i = 1; i < withLessons.length; i++) {
    const curr = withLessons[i];
    const currTs = parseTimestampMs(curr.updatedAt);
    if (currTs > bestTs) {
      best = curr;
      bestTs = currTs;
    }
  }

  // If the primary candidate had classes (e.g. LOP-9-5) with 0 lessons while fallback had lessons,
  // preserve classes from both so no real class disappears.
  const emptyPrimary = snapshots.find((s) => s.workspaceId !== best.workspaceId && s.lessons.length === 0);
  if (emptyPrimary && emptyPrimary.classes.length > 0) {
    return {
      ...best,
      classes: dedupeById([...emptyPrimary.classes, ...best.classes]),
    };
  }

  return best;
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
