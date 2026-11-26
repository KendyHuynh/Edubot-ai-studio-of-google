import { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  ActivityLog,
  AnswerSubmission,
  AssessmentSessionAttempt,
  ClassRoom,
  LearnerProfile,
  Lesson,
  PublicLearnerHonorEntry,
  PushNotification,
  Question,
  TeacherAward,
} from '../shared/types';
import {
  computeOverallLevel,
  sanitizeMasteryForFirestore,
} from '../shared/assessmentEngine';
import {
  hasStrippedAnswers,
  recoverMissingCorrectAnswers,
} from './answerRecovery';
import {
  DEFAULT_PUBLIC_WORKSPACE_ID,
  dedupeById,
  isDemoSeedArtifactId,
  isDemoSeedClass,
  mergeLatestSubmissions,
  mergeSubmissionActivityLogs,
  normalizeClassCode,
  sanitizeLessonFieldsForFirestore,
  toFirestoreDocId,
} from './firestoreHelpers';
import { app, auth } from './googleDrive';

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

function isActiveOwner(ownerUid: string): boolean {
  const current = auth.currentUser;
  return Boolean(current && current.uid === ownerUid && current.emailVerified);
}

function isSignedInVerified(): boolean {
  const current = auth.currentUser;
  return Boolean(current && current.emailVerified);
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes('the client is offline')
    ) {
      console.error(
        'Please check your Firebase configuration: Firestore client is offline.',
      );
      return false;
    }
    return true;
  }
}

export async function syncUserProfileToFirestore(user: User): Promise<void> {
  if (!isActiveOwner(user.uid)) return;
  const path = `users/${user.uid}`;
  try {
    const ref = doc(db, 'users', user.uid);
    const snap = await getDoc(ref);
    if (!isActiveOwner(user.uid)) return;
    const displayName = (user.displayName || user.email || 'Giáo viên').slice(0, 120);
    const email = (user.email || '').slice(0, 200);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        email,
        displayName,
        role: 'teacher',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        displayName,
        email,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    if (!isActiveOwner(user.uid)) return;
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveClassToFirestore(
  cls: ClassRoom,
  ownerUid: string,
): Promise<void> {
  if (!isActiveOwner(ownerUid)) return;
  const docId = toFirestoreDocId(cls.id, 64);
  const path = `classes/${docId}`;
  try {
    const ref = doc(db, 'classes', docId);
    const snap = await getDoc(ref);
    if (!isActiveOwner(ownerUid)) return;
    const mutable = {
      name: (cls.name || docId).slice(0, 160),
      grade: (cls.grade || 'Khối 5').slice(0, 60),
      teacherName: (cls.teacherName || 'Giáo viên').slice(0, 120),
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists()) {
      await setDoc(ref, {
        id: docId,
        ownerUid,
        ...mutable,
        createdAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, mutable);
    }
  } catch (error) {
    if (!isActiveOwner(ownerUid)) return;
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteClassFromFirestore(classId: string): Promise<void> {
  if (!isSignedInVerified()) return;
  const docId = toFirestoreDocId(classId, 64);
  const path = `classes/${docId}`;
  try {
    await deleteDoc(doc(db, 'classes', docId));
  } catch (error) {
    if (!isSignedInVerified()) return;
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveLessonToFirestore(
  lesson: Lesson,
  ownerUid: string,
): Promise<void> {
  if (!isActiveOwner(ownerUid)) return;
  const docId = toFirestoreDocId(lesson.id, 80);
  const path = `lessons/${docId}`;
  try {
    const ref = doc(db, 'lessons', docId);
    const snap = await getDoc(ref);
    if (!isActiveOwner(ownerUid)) return;
    const existingLesson: Lesson[] = snap.exists()
      ? [
          {
            ...lesson,
            id: docId,
            questions: Array.isArray(snap.data()?.questions)
              ? (snap.data().questions as Question[])
              : [],
          },
        ]
      : [];
    const [healedLesson] = recoverMissingCorrectAnswers([lesson], existingLesson);
    // Hard anti-wipe guard: never overwrite an existing Firestore lesson with student-stripped blank answers
    if (snap.exists() && hasStrippedAnswers([healedLesson])) {
      return;
    }
    const mutable = sanitizeLessonFieldsForFirestore(healedLesson, docId);
    if (!snap.exists()) {
      await setDoc(ref, {
        id: docId,
        ownerUid,
        ...mutable,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        ...mutable,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    if (!isActiveOwner(ownerUid)) return;
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteLessonFromFirestore(lessonId: string): Promise<void> {
  if (!isSignedInVerified()) return;
  const docId = toFirestoreDocId(lessonId, 80);
  const path = `lessons/${docId}`;
  try {
    await deleteDoc(doc(db, 'lessons', docId));
  } catch (error) {
    if (!isSignedInVerified()) return;
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function saveSubmissionToFirestore(
  sub: AnswerSubmission,
  ownerUid: string,
): Promise<void> {
  if (!isActiveOwner(ownerUid)) return;
  const docId = toFirestoreDocId(sub.id, 80);
  const path = `submissions/${docId}`;
  try {
    const ref = doc(db, 'submissions', docId);
    const snap = await getDoc(ref);
    if (!isActiveOwner(ownerUid)) return;
    const mutable = {
      userAnswer: (sub.userAnswer ?? '').slice(0, 1000),
      isCorrect: Boolean(sub.isCorrect),
      basePoints: Math.max(0, Math.min(1000, Math.round(sub.basePoints))),
      speedBonus: Math.max(0, Math.min(1000, Math.round(sub.speedBonus))),
      totalPoints: Math.max(0, Math.min(2000, Math.round(sub.totalPoints))),
      elapsedMs: Math.max(0, Math.round(sub.elapsedMs)),
      submittedAt: (sub.submittedAt || new Date().toISOString()).slice(0, 64),
      feedbackText: (sub.feedbackText ?? '').slice(0, 500),
      explanation: (sub.explanation ?? '').slice(0, 1200),
      syncedFromOffline: Boolean(sub.syncedFromOffline),
    };
    if (!snap.exists()) {
      await setDoc(ref, {
        id: docId,
        ownerUid,
        classId: (sub.classId || '').slice(0, 64),
        groupId: (sub.groupId || 'May-01').slice(0, 120),
        tabletNumber: Math.max(1, Math.min(10, Math.round(sub.tabletNumber || 1))),
        groupName: (sub.groupName || 'Nhóm 1').slice(0, 80),
        lessonId: toFirestoreDocId(sub.lessonId || 'lesson', 80),
        lessonTitle: (sub.lessonTitle || 'Bài học').slice(0, 240),
        questionId: toFirestoreDocId(sub.questionId || 'q1', 80),
        competencyId: (sub.competencyId || '1.1').slice(0, 16),
        competencyIds: (sub.competencyIds ?? [sub.competencyId || '1.1']).slice(0, 10),
        ...mutable,
        createdAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, mutable);
    }
  } catch (error) {
    if (!isActiveOwner(ownerUid)) return;
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

/**
 * Syncs a teacher's manual grade override to both private `submissions` and published
 * `publicWorkspaces/{ws}/submissions` (permitted for admins in firestore.rules).
 */
export async function syncOverriddenSubmissionToCloud(
  sub: AnswerSubmission,
  ownerUid: string,
): Promise<void> {
  if (!isActiveOwner(ownerUid)) return;
  await saveSubmissionToFirestore(sub, ownerUid);
  const docId = toFirestoreDocId(sub.id, 128);
  const targetWorkspaces = Array.from(
    new Set([DEFAULT_PUBLIC_WORKSPACE_ID, defaultShareCodeForUid(ownerUid)]),
  );
  const mutable = {
    userAnswer: (sub.userAnswer ?? '').slice(0, 1000),
    isCorrect: Boolean(sub.isCorrect),
    basePoints: Math.max(0, Math.min(1000, Math.round(sub.basePoints))),
    speedBonus: Math.max(0, Math.min(1000, Math.round(sub.speedBonus))),
    totalPoints: Math.max(0, Math.min(2000, Math.round(sub.totalPoints))),
    elapsedMs: Math.max(0, Math.min(3600000, Math.round(sub.elapsedMs))),
    submittedAt: (sub.submittedAt || new Date().toISOString()).slice(0, 64),
    feedbackText: (sub.feedbackText ?? '').slice(0, 500),
    explanation: (sub.explanation ?? '').slice(0, 1200),
    syncedFromOffline: Boolean(sub.syncedFromOffline),
  };
  for (const wsId of targetWorkspaces) {
    try {
      const ref = doc(db, 'publicWorkspaces', wsId, 'submissions', docId);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        await updateDoc(ref, mutable);
      }
    } catch {
      // Non-fatal if doc was not created in this public workspace
    }
  }
}

export async function saveNotificationToFirestore(
  notif: PushNotification,
  ownerUid: string,
): Promise<void> {
  if (!isActiveOwner(ownerUid)) return;
  const docId = toFirestoreDocId(notif.id, 80);
  const path = `notifications/${docId}`;
  try {
    const ref = doc(db, 'notifications', docId);
    const snap = await getDoc(ref);
    if (!isActiveOwner(ownerUid)) return;
    if (!snap.exists()) {
      await setDoc(ref, {
        id: docId,
        ownerUid,
        classId: (notif.classId || '').slice(0, 64),
        lessonId: toFirestoreDocId(notif.lessonId || 'lesson', 80),
        title: (notif.title || 'Thông báo').slice(0, 240),
        message: (notif.message || '').slice(0, 1000),
        readByGroupIds: (notif.readByGroupIds ?? []).slice(0, 100),
        createdAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        readByGroupIds: (notif.readByGroupIds ?? []).slice(0, 100),
      });
    }
  } catch (error) {
    if (!isActiveOwner(ownerUid)) return;
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function saveActivityLogToFirestore(
  log: ActivityLog,
  ownerUid: string,
  knownExists?: boolean,
): Promise<void> {
  if (!isActiveOwner(ownerUid)) return;
  if (knownExists === true) return; // activityLogs are immutable once created
  const docId = toFirestoreDocId(log.id, 80);
  const path = `activityLogs/${docId}`;
  try {
    const ref = doc(db, 'activityLogs', docId);
    let shouldCreate = knownExists === false;
    if (knownExists === undefined) {
      const snap = await getDoc(ref);
      if (!isActiveOwner(ownerUid)) return;
      shouldCreate = !snap.exists();
    }
    if (shouldCreate) {
      if (!isActiveOwner(ownerUid)) return;
      await setDoc(ref, {
        id: docId,
        ownerUid,
        classId: (log.classId || '').slice(0, 64),
        groupId: (log.groupId || 'Hệ thống').slice(0, 120),
        action: (log.action || 'Hoạt động').slice(0, 120),
        detail: (log.detail || '').slice(0, 500),
        ...(log.competencyId ? { competencyId: String(log.competencyId).slice(0, 16) } : {}),
        ...(typeof log.pointsDelta === 'number' && Number.isFinite(log.pointsDelta)
          ? { pointsDelta: Math.round(log.pointsDelta) }
          : {}),
        timestamp: (log.timestamp || new Date().toISOString()).slice(0, 64),
        createdAt: serverTimestamp(),
      });
    }
  } catch (error) {
    if (!isActiveOwner(ownerUid)) return;
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

function normalizeTimestampToIso(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object' && 'toDate' in val && typeof (val as { toDate: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  return new Date().toISOString();
}

export async function fetchTeacherCloudData(ownerUid: string): Promise<{
  classes: ClassRoom[];
  lessons: Lesson[];
  submissions: AnswerSubmission[];
  notifications: PushNotification[];
  activityLogs: ActivityLog[];
}> {
  if (!isActiveOwner(ownerUid)) {
    return { classes: [], lessons: [], submissions: [], notifications: [], activityLogs: [] };
  }
  try {
    const [clsSnap, lesSnap, subSnap, notifSnap, logSnap] = await Promise.all([
      getDocs(query(collection(db, 'classes'), where('ownerUid', '==', ownerUid))),
      getDocs(query(collection(db, 'lessons'), where('ownerUid', '==', ownerUid))),
      getDocs(query(collection(db, 'submissions'), where('ownerUid', '==', ownerUid))),
      getDocs(query(collection(db, 'notifications'), where('ownerUid', '==', ownerUid))),
      getDocs(query(collection(db, 'activityLogs'), where('ownerUid', '==', ownerUid))),
    ]);

    const classes: ClassRoom[] = clsSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: String(data.id),
        name: String(data.name),
        grade: String(data.grade ?? 'Khối 5'),
        teacherName: String(data.teacherName ?? 'Giáo viên'),
        createdAt: normalizeTimestampToIso(data.createdAt),
      };
    });

    const lessons: Lesson[] = lesSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: String(data.id),
        title: String(data.title),
        topic: String(data.topic ?? ''),
        sourceFileName: String(data.sourceFileName ?? ''),
        summary: String(data.summary ?? ''),
        assignedClassIds: Array.isArray(data.assignedClassIds) ? data.assignedClassIds : [],
        createdAt: normalizeTimestampToIso(data.createdAt),
        questions: Array.isArray(data.questions) ? data.questions : [],
      };
    });

    const submissions: AnswerSubmission[] = subSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: String(data.id),
        classId: String(data.classId),
        groupId: String(data.groupId),
        tabletNumber: Number(data.tabletNumber ?? 1),
        groupName: String(data.groupName ?? ''),
        lessonId: String(data.lessonId),
        lessonTitle: String(data.lessonTitle ?? ''),
        questionId: String(data.questionId),
        competencyId: String(data.competencyId ?? '1.1'),
        competencyIds: Array.isArray(data.competencyIds) ? data.competencyIds : undefined,
        userAnswer: String(data.userAnswer ?? ''),
        isCorrect: Boolean(data.isCorrect),
        basePoints: Number(data.basePoints ?? 0),
        speedBonus: Number(data.speedBonus ?? 0),
        totalPoints: Number(data.totalPoints ?? 0),
        elapsedMs: Number(data.elapsedMs ?? 0),
        submittedAt: String(data.submittedAt ?? normalizeTimestampToIso(data.createdAt)),
        feedbackText: String(data.feedbackText ?? ''),
        explanation: String(data.explanation ?? ''),
        syncedFromOffline: Boolean(data.syncedFromOffline),
      };
    });

    const notifications: PushNotification[] = notifSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: String(data.id),
        classId: String(data.classId),
        lessonId: String(data.lessonId),
        title: String(data.title),
        message: String(data.message),
        createdAt: normalizeTimestampToIso(data.createdAt),
        readByGroupIds: Array.isArray(data.readByGroupIds) ? data.readByGroupIds : [],
      };
    });

    const activityLogs: ActivityLog[] = logSnap.docs.map((d) => {
      const data = d.data();
      return {
        id: String(data.id),
        classId: String(data.classId),
        groupId: String(data.groupId),
        action: String(data.action),
        detail: String(data.detail),
        competencyId: data.competencyId ? String(data.competencyId) : undefined,
        pointsDelta: typeof data.pointsDelta === 'number' ? data.pointsDelta : undefined,
        timestamp: String(data.timestamp ?? normalizeTimestampToIso(data.createdAt)),
      };
    });

    const shareCode = defaultShareCodeForUid(ownerUid);
    const publicSubSources = Array.from(new Set([DEFAULT_PUBLIC_WORKSPACE_ID, shareCode]));
    const publicSubmissions: AnswerSubmission[] = [];
    for (const wsId of publicSubSources) {
      try {
        const pubSnap = await getDocs(
          query(
            collection(db, 'publicWorkspaces', wsId, 'submissions'),
            where('workspaceId', '==', wsId),
            limit(300),
          ),
        );
        for (const d of pubSnap.docs) {
          const data = d.data();
          publicSubmissions.push({
            id: String(data.id),
            classId: String(data.classId),
            groupId: String(data.groupId),
            tabletNumber: Number(data.tabletNumber ?? 1),
            groupName: String(data.groupName ?? ''),
            lessonId: String(data.lessonId),
            lessonTitle: String(data.lessonTitle ?? ''),
            questionId: String(data.questionId),
            competencyId: String(data.competencyId ?? '1.1'),
            competencyIds: Array.isArray(data.competencyIds) ? data.competencyIds : undefined,
            userAnswer: String(data.userAnswer ?? ''),
            isCorrect: Boolean(data.isCorrect),
            basePoints: Number(data.basePoints ?? 0),
            speedBonus: Number(data.speedBonus ?? 0),
            totalPoints: Number(data.totalPoints ?? 0),
            elapsedMs: Number(data.elapsedMs ?? 0),
            submittedAt: String(data.submittedAt ?? normalizeTimestampToIso(data.createdAt)),
            feedbackText: String(data.feedbackText ?? ''),
            explanation: String(data.explanation ?? ''),
            syncedFromOffline: Boolean(data.syncedFromOffline),
          });
        }
      } catch {
        // Non-fatal if a workspace doc or subcollection doesn't exist yet
      }
    }

    const cleanClasses = dedupeById(classes.filter((c) => !isDemoSeedClass(c)));
    const cleanNotifs = dedupeById(
      notifications.filter((n) => !isDemoSeedArtifactId(n.id)),
    );
    const mergedSubmissions = mergeLatestSubmissions(
      submissions.filter((s) => !isDemoSeedArtifactId(s.id)),
      publicSubmissions.filter((s) => !isDemoSeedArtifactId(s.id)),
    );
    const mergedActivityLogs = mergeSubmissionActivityLogs(
      activityLogs.filter((l) => !isDemoSeedArtifactId(l.id)),
      mergedSubmissions,
    );

    const healedLessons = dedupeById(recoverMissingCorrectAnswers(lessons));

    return {
      classes: cleanClasses,
      lessons: healedLessons,
      submissions: mergedSubmissions,
      notifications: cleanNotifs,
      activityLogs: mergedActivityLogs,
    };
  } catch (error) {
    if (!isActiveOwner(ownerUid)) {
      return { classes: [], lessons: [], submissions: [], notifications: [], activityLogs: [] };
    }
    handleFirestoreError(error, OperationType.LIST, 'teacher_workspace');
  }
}

export interface PushWorkspaceResult {
  savedClasses: number;
  savedLessons: number;
  warnings: string[];
}

export async function pushWorkspaceToFirestore(
  ownerUid: string,
  payload: {
    classes: ClassRoom[];
    lessons: Lesson[];
    submissions: AnswerSubmission[];
    notifications: PushNotification[];
    activityLogs: ActivityLog[];
  },
  existingLogIds?: Set<string>,
): Promise<PushWorkspaceResult> {
  const warnings: string[] = [];
  let savedClasses = 0;
  let savedLessons = 0;

  const realClasses = dedupeById(payload.classes.filter((c) => !isDemoSeedClass(c)));
  for (const cls of realClasses) {
    if (!isActiveOwner(ownerUid)) return { savedClasses, savedLessons, warnings };
    try {
      await saveClassToFirestore(cls, ownerUid);
      savedClasses += 1;
    } catch (err) {
      warnings.push(`class:${cls.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const uniqueLessons = dedupeById(payload.lessons);
  for (const lesson of uniqueLessons) {
    if (!isActiveOwner(ownerUid)) return { savedClasses, savedLessons, warnings };
    try {
      await saveLessonToFirestore(lesson, ownerUid);
      savedLessons += 1;
    } catch (err) {
      warnings.push(`lesson:${lesson.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const realSubs = payload.submissions.filter((s) => !isDemoSeedArtifactId(s.id));
  for (const sub of realSubs.slice(0, 40)) {
    if (!isActiveOwner(ownerUid)) return { savedClasses, savedLessons, warnings };
    try {
      await saveSubmissionToFirestore(sub, ownerUid);
    } catch (err) {
      warnings.push(`sub:${sub.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const realNotifs = dedupeById(
    payload.notifications.filter((n) => !isDemoSeedArtifactId(n.id)),
  );
  for (const notif of realNotifs.slice(0, 20)) {
    if (!isActiveOwner(ownerUid)) return { savedClasses, savedLessons, warnings };
    try {
      await saveNotificationToFirestore(notif, ownerUid);
    } catch (err) {
      warnings.push(`notif:${notif.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const realLogs = dedupeById(
    payload.activityLogs.filter((l) => !isDemoSeedArtifactId(l.id)),
  );
  for (const log of realLogs.slice(0, 30)) {
    if (!isActiveOwner(ownerUid)) return { savedClasses, savedLessons, warnings };
    const docId = toFirestoreDocId(log.id, 80);
    const knownExists = existingLogIds ? existingLogIds.has(docId) : undefined;
    try {
      await saveActivityLogToFirestore(log, ownerUid, knownExists);
    } catch (err) {
      warnings.push(`log:${log.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { savedClasses, savedLessons, warnings };
}

export function defaultShareCodeForUid(uid: string): string {
  return `WS-${toFirestoreDocId(uid, 12).toUpperCase()}`;
}

function compactLessonsForPublicDoc(
  cleanLessons: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return cleanLessons.slice(0, 60).map((l) => {
    const qs = Array.isArray(l.questions) ? (l.questions as Array<Record<string, unknown>>) : [];
    return {
      ...l,
      summary: String(l.summary ?? '').slice(0, 400),
      questions: qs.slice(0, 25).map((q) => ({
        ...q,
        questionText: String(q.questionText ?? '').slice(0, 450),
        aiSearchKeywordHint: String(q.aiSearchKeywordHint ?? '').slice(0, 120),
        explanation: String(q.explanation ?? '').slice(0, 280),
      })),
    };
  });
}

async function writeSinglePublicWorkspaceDoc(
  docId: string,
  ownerUid: string,
  cleanClasses: Array<Record<string, unknown>>,
  cleanLessons: Array<Record<string, unknown>>,
  cleanNotifications: Array<Record<string, unknown>>,
): Promise<void> {
  const ref = doc(db, 'publicWorkspaces', docId);
  const snap = await getDoc(ref);
  if (!isActiveOwner(ownerUid)) return;

  const attemptWrite = async (
    lessonsPayload: Array<Record<string, unknown>>,
    includeNotifications: boolean,
  ): Promise<void> => {
    if (!snap.exists()) {
      await setDoc(ref, {
        id: docId,
        ownerUid,
        classes: cleanClasses,
        lessons: lessonsPayload,
        ...(includeNotifications ? { notifications: cleanNotifications } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        classes: cleanClasses,
        lessons: lessonsPayload,
        ...(includeNotifications ? { notifications: cleanNotifications } : {}),
        updatedAt: serverTimestamp(),
      });
    }
  };

  try {
    await attemptWrite(cleanLessons, true);
    return;
  } catch (firstErr) {
    // Fallback 1: retry WITHOUT `notifications` in case deployed firestore.rules still uses legacy key allowlist
    try {
      await attemptWrite(cleanLessons, false);
      return;
    } catch {
      // Fallback 2: retry with compacted lessons in case document exceeded Firestore 1 MiB limit
      try {
        await attemptWrite(compactLessonsForPublicDoc(cleanLessons), false);
        return;
      } catch {
        throw firstErr;
      }
    }
  }
}

export interface PublishPublicWorkspaceResult {
  workspaceId: string;
  publishedPersonal: boolean;
  publishedDefault: boolean;
  personalError?: string;
  defaultError?: string;
  skippedStrippedAnswers?: boolean;
  classesCount: number;
  lessonsCount: number;
  notificationsCount: number;
}

export async function publishPublicWorkspace(
  workspaceCode: string,
  ownerUid: string,
  classes: ClassRoom[],
  lessons: Lesson[],
  notifications: PushNotification[] = [],
): Promise<PublishPublicWorkspaceResult> {
  const docId = toFirestoreDocId(workspaceCode, 64);
  if (!isActiveOwner(ownerUid)) {
    return {
      workspaceId: docId,
      publishedPersonal: false,
      publishedDefault: false,
      classesCount: 0,
      lessonsCount: 0,
      notificationsCount: 0,
    };
  }

  let existingLessons: Lesson[] = [];
  for (const checkId of Array.from(new Set([docId, DEFAULT_PUBLIC_WORKSPACE_ID]))) {
    try {
      const existingSnap = await getDoc(doc(db, 'publicWorkspaces', checkId));
      if (existingSnap.exists() && Array.isArray(existingSnap.data()?.lessons)) {
        existingLessons = [...existingLessons, ...(existingSnap.data().lessons as Lesson[])];
      }
    } catch {
      // Non-fatal
    }
  }

  const healedLessons = dedupeById(recoverMissingCorrectAnswers(lessons, existingLessons));
  // Hard anti-wipe guard: never publish student-sanitized lessons (all blank answers) to publicWorkspaces
  if (hasStrippedAnswers(healedLessons)) {
    return {
      workspaceId: docId,
      publishedPersonal: false,
      publishedDefault: false,
      skippedStrippedAnswers: true,
      classesCount: 0,
      lessonsCount: 0,
      notificationsCount: 0,
    };
  }

  const cleanClasses = dedupeById(classes.filter((c) => !isDemoSeedClass(c)))
    .slice(0, 100)
    .map((c) => ({
      id: normalizeClassCode(String(c.id)),
      name: String(c.name || c.id).slice(0, 160),
      grade: String(c.grade || 'Khối 5').slice(0, 60),
      teacherName: String(c.teacherName || 'Giáo viên').slice(0, 120),
      createdAt: String(c.createdAt || new Date().toISOString()).slice(0, 64),
    }));
  const cleanLessons = healedLessons.slice(0, 100).map((l) => {
    const lid = toFirestoreDocId(l.id, 80);
    return {
      id: lid,
      createdAt: String(l.createdAt || new Date().toISOString()).slice(0, 64),
      ...sanitizeLessonFieldsForFirestore(l, lid),
    };
  });
  const cleanNotifications = dedupeById(
    notifications.filter((n) => !isDemoSeedArtifactId(n.id)),
  )
    .slice(0, 50)
    .map((n) => ({
      id: toFirestoreDocId(n.id || 'notif', 80),
      classId: n.classId ? normalizeClassCode(String(n.classId)) : '',
      lessonId: toFirestoreDocId(n.lessonId || 'lesson', 80),
      title: String(n.title || 'Thông báo').slice(0, 240),
      message: String(n.message || '').slice(0, 1000),
      createdAt: String(n.createdAt || new Date().toISOString()).slice(0, 64),
      readByGroupIds: (n.readByGroupIds ?? []).slice(0, 100).map((g) => String(g).slice(0, 120)),
    }));

  let publishedPersonal = false;
  let personalError: string | undefined;
  try {
    await writeSinglePublicWorkspaceDoc(
      docId,
      ownerUid,
      cleanClasses,
      cleanLessons,
      cleanNotifications,
    );
    publishedPersonal = true;
  } catch (error) {
    personalError = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to publish publicWorkspaces/${docId}:`, personalError);
  }

  // Also update the school-wide `default` public workspace so students opening the root URL
  // in an incognito tab (without ?ws=... or login) automatically see all classes & assigned lessons.
  let publishedDefault = docId === DEFAULT_PUBLIC_WORKSPACE_ID ? publishedPersonal : false;
  let defaultError: string | undefined =
    docId === DEFAULT_PUBLIC_WORKSPACE_ID ? personalError : undefined;

  if (docId !== DEFAULT_PUBLIC_WORKSPACE_ID && isActiveOwner(ownerUid)) {
    try {
      await writeSinglePublicWorkspaceDoc(
        DEFAULT_PUBLIC_WORKSPACE_ID,
        ownerUid,
        cleanClasses,
        cleanLessons,
        cleanNotifications,
      );
      publishedDefault = true;
    } catch (error) {
      defaultError = error instanceof Error ? error.message : String(error);
      console.warn('Failed to publish publicWorkspaces/default:', defaultError);
    }
  }

  return {
    workspaceId: docId,
    publishedPersonal,
    publishedDefault,
    personalError,
    defaultError,
    classesCount: cleanClasses.length,
    lessonsCount: cleanLessons.length,
    notificationsCount: cleanNotifications.length,
  };
}

// =========================================================================
// PERSONAL HOME LEARNER PROFILES, ATTEMPTS, HONORS & TEACHER AWARDS SYNC
// =========================================================================

export interface LearnerCloudWriteResult {
  ok: boolean;
  savedAt?: string;
  error?: string;
  permissionDenied?: boolean;
  honorSynced?: boolean;
}

function isPermissionDeniedError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err && 'code' in err
      ? String((err as { code?: unknown }).code ?? '').toLowerCase()
      : '';
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err ?? '').toLowerCase();
  return code.includes('permission-denied') || msg.includes('permission') || msg.includes('insufficient');
}

function parseLearnerDoc(id: string, d: Record<string, unknown>): LearnerProfile {
  return {
    uid: String(d.uid ?? id),
    authType: d.authType === 'guest' ? 'guest' : 'google',
    email: d.email ? String(d.email) : undefined,
    photoUrl: d.photoUrl ? String(d.photoUrl) : undefined,
    fullName: String(d.fullName ?? ''),
    className: String(d.className ?? ''),
    schoolName: String(d.schoolName ?? ''),
    gradeBand:
      d.gradeBand === 'middle' || d.gradeBand === 'high' ? d.gradeBand : 'primary',
    role: 'student',
    profileCompleted: Boolean(d.profileCompleted),
    currentLevel: Math.max(1, Math.min(4, Number(d.currentLevel ?? 1))) as 1 | 2 | 3 | 4,
    totalXp: Number(d.totalXp ?? 0),
    bestCombo: Number(d.bestCombo ?? 0),
    totalExercisesDone: Number(d.totalExercisesDone ?? 0),
    totalCorrect: Number(d.totalCorrect ?? 0),
    masteryByCompetency:
      d.masteryByCompetency && typeof d.masteryByCompetency === 'object'
        ? sanitizeMasteryForFirestore(
            d.masteryByCompetency as LearnerProfile['masteryByCompetency'],
          )
        : {},
    createdAt: normalizeTimestampToIso(d.createdAt),
    updatedAt: normalizeTimestampToIso(d.updatedAt),
    lastActiveAt: String(d.lastActiveAt ?? normalizeTimestampToIso(d.updatedAt)),
  };
}

function parseAwardDoc(id: string, d: Record<string, unknown>): TeacherAward {
  return {
    id: String(d.id ?? id),
    learnerUid: String(d.learnerUid ?? ''),
    learnerName: String(d.learnerName ?? ''),
    className: String(d.className ?? ''),
    schoolName: String(d.schoolName ?? ''),
    badgeId: String(d.badgeId ?? 'custom'),
    badgeTitle: String(d.badgeTitle ?? ''),
    message: String(d.message ?? ''),
    bonusXp: Number(d.bonusXp ?? 0),
    awardedByName: String(d.awardedByName ?? 'Giáo viên'),
    awardedByEmail: d.awardedByEmail ? String(d.awardedByEmail) : undefined,
    createdAt: normalizeTimestampToIso(d.createdAt),
  };
}

function parseAttemptDoc(id: string, d: Record<string, unknown>): AssessmentSessionAttempt {
  const rawMode = String(d.mode ?? 'variety_sprint');
  const mode: AssessmentSessionAttempt['mode'] =
    rawMode === 'diagnostic' ||
    rawMode === 'level_challenge' ||
    rawMode === 'competency_focus' ||
    rawMode === 'advanced_pack'
      ? rawMode
      : 'variety_sprint';
  const rawTargetLvl = Number(d.targetLevel);
  return {
    id: String(d.id ?? id),
    learnerUid: String(d.learnerUid ?? ''),
    learnerName: String(d.learnerName ?? ''),
    className: String(d.className ?? ''),
    schoolName: String(d.schoolName ?? ''),
    mode,
    targetLevel:
      Number.isInteger(rawTargetLvl) && rawTargetLvl >= 1 && rawTargetLvl <= 4
        ? (rawTargetLvl as 1 | 2 | 3 | 4)
        : undefined,
    targetCompetencyId: d.targetCompetencyId ? String(d.targetCompetencyId) : undefined,
    totalQuestions: Number(d.totalQuestions ?? 0),
    correctCount: Number(d.correctCount ?? 0),
    accuracyPercent: Number(d.accuracyPercent ?? 0),
    xpEarned: Number(d.xpEarned ?? 0),
    maxCombo: Number(d.maxCombo ?? 0),
    competencyIds: Array.isArray(d.competencyIds)
      ? d.competencyIds.map((c) => String(c))
      : [],
    completedAt: String(d.completedAt ?? normalizeTimestampToIso(d.createdAt)),
  };
}

export async function savePublicLearnerHonorToFirestore(
  profile: LearnerProfile,
  awardsCount = 0,
  latestBadgeTitle?: string,
): Promise<boolean> {
  if (!isSignedInVerified()) return false;
  try {
    const docId = toFirestoreDocId(profile.uid, 128);
    const cleanMastery = sanitizeMasteryForFirestore(profile.masteryByCompetency);
    const records = Object.values(cleanMastery);
    const masteredCount = Math.min(
      24,
      records.filter((r) => r.highestLevel >= 1).length,
    );
    const expertCount = Math.min(
      24,
      records.filter((r) => r.highestLevel >= 3).length,
    );
    const totalDone = Math.max(0, Math.min(100000, Math.round(profile.totalExercisesDone || 0)));
    const totalCorrect = Math.max(0, Math.min(totalDone, Math.round(profile.totalCorrect || 0)));
    const accuracyPercent =
      totalDone > 0 ? Math.min(100, Math.round((totalCorrect / totalDone) * 100)) : 0;

    // Publicly readable honor summary (NO email or photoUrl PII!)
    await setDoc(doc(db, 'publicLearnerHonor', docId), {
      uid: docId,
      fullName: (profile.fullName || 'Học sinh').trim().slice(0, 120) || 'Học sinh',
      className: (profile.className || 'Tự học').trim().slice(0, 60) || 'Tự học',
      schoolName: (profile.schoolName || 'Trường học').trim().slice(0, 160) || 'Trường học',
      gradeBand:
        profile.gradeBand === 'middle' || profile.gradeBand === 'high'
          ? profile.gradeBand
          : 'primary',
      authType: 'google',
      currentLevel: Math.max(1, Math.min(4, Math.round(profile.currentLevel || 1))),
      totalXp: Math.max(0, Math.min(1000000, Math.round(profile.totalXp || 0))),
      masteredCount,
      expertCount,
      accuracyPercent,
      totalExercisesDone: totalDone,
      awardsCount: Math.max(0, Math.min(1000, Math.round(awardsCount || 0))),
      ...(latestBadgeTitle?.trim()
        ? { latestBadgeTitle: latestBadgeTitle.trim().slice(0, 140) }
        : {}),
      lastActiveAt: (profile.lastActiveAt || new Date().toISOString()).slice(0, 64),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function saveLearnerProfileToFirestore(
  profile: LearnerProfile,
  options: {
    allowAdminWrite?: boolean;
    awardsCount?: number;
    latestBadgeTitle?: string;
  } = {},
): Promise<LearnerCloudWriteResult> {
  const current = auth.currentUser;
  if (!current || !current.emailVerified) {
    return {
      ok: false,
      error: 'Chưa đăng nhập tài khoản Gmail (Google) đã xác thực.',
    };
  }
  if (!options.allowAdminWrite && current.uid !== profile.uid) {
    return {
      ok: false,
      error: 'Tài khoản Gmail đăng nhập không khớp với hồ sơ học sinh.',
    };
  }

  try {
    const docId = toFirestoreDocId(profile.uid, 128);
    const ref = doc(db, 'learnerProfiles', docId);
    const snap = await getDoc(ref);
    const cleanMastery = sanitizeMasteryForFirestore(profile.masteryByCompetency);
    const cleanFullName = (profile.fullName || 'Học sinh').trim().slice(0, 120) || 'Học sinh';
    const cleanClassName = (profile.className || 'Tự học').trim().slice(0, 60) || 'Tự học';
    const cleanSchoolName =
      (profile.schoolName || 'Trường học').trim().slice(0, 160) || 'Trường học';
    const totalDone = Math.max(0, Math.min(100000, Math.round(profile.totalExercisesDone || 0)));
    const totalCorrect = Math.max(0, Math.min(totalDone, Math.round(profile.totalCorrect || 0)));

    const payload = {
      uid: docId,
      authType: 'google' as const,
      ...(profile.email?.trim() ? { email: profile.email.trim().slice(0, 200) } : {}),
      ...(profile.photoUrl?.trim() ? { photoUrl: profile.photoUrl.trim().slice(0, 500) } : {}),
      fullName: cleanFullName,
      className: cleanClassName,
      schoolName: cleanSchoolName,
      gradeBand:
        profile.gradeBand === 'middle' || profile.gradeBand === 'high'
          ? profile.gradeBand
          : 'primary',
      role: 'student' as const,
      profileCompleted: Boolean(profile.profileCompleted),
      currentLevel: Math.max(1, Math.min(4, Math.round(profile.currentLevel || 1))),
      totalXp: Math.max(0, Math.min(1000000, Math.round(profile.totalXp || 0))),
      bestCombo: Math.max(0, Math.min(1000, Math.round(profile.bestCombo || 0))),
      totalExercisesDone: totalDone,
      totalCorrect,
      masteryByCompetency: cleanMastery,
      lastActiveAt: (profile.lastActiveAt || new Date().toISOString()).slice(0, 64),
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists()) {
      await setDoc(ref, { ...payload, createdAt: serverTimestamp() });
    } else {
      await updateDoc(ref, payload);
    }

    // Automatically publish verified achievement summary to publicLearnerHonor so everyone can see it
    const honorSynced = await savePublicLearnerHonorToFirestore(
      { ...profile, authType: 'google', masteryByCompetency: cleanMastery },
      options.awardsCount ?? 0,
      options.latestBadgeTitle,
    );

    return {
      ok: true,
      savedAt: new Date().toISOString(),
      honorSynced,
    };
  } catch (err) {
    const permissionDenied = isPermissionDeniedError(err);
    const rawMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      permissionDenied,
      error: permissionDenied
        ? 'Quyền ghi Cloud Firestore cho learnerProfiles bị từ chối. Vui lòng Publish file firestore.rules mới trên Firebase Console.'
        : rawMsg,
    };
  }
}

export async function saveAssessmentAttemptToFirestore(
  attempt: AssessmentSessionAttempt,
): Promise<boolean> {
  const current = auth.currentUser;
  if (!current || !current.emailVerified || current.uid !== attempt.learnerUid) {
    return false;
  }
  try {
    const docId = toFirestoreDocId(attempt.id, 80);
    await setDoc(doc(db, 'assessmentAttempts', docId), {
      id: docId,
      learnerUid: toFirestoreDocId(attempt.learnerUid, 128),
      learnerName: (attempt.learnerName || 'Học sinh').slice(0, 120),
      className: (attempt.className || 'Tự học').slice(0, 60),
      schoolName: (attempt.schoolName || 'Trường học').slice(0, 160),
      mode: attempt.mode,
      ...(typeof attempt.targetLevel === 'number'
        ? { targetLevel: Math.max(1, Math.min(4, Math.round(attempt.targetLevel))) }
        : {}),
      ...(attempt.targetCompetencyId
        ? { targetCompetencyId: String(attempt.targetCompetencyId).slice(0, 16) }
        : {}),
      totalQuestions: Math.max(0, Math.min(100, Math.round(attempt.totalQuestions || 0))),
      correctCount: Math.max(0, Math.min(100, Math.round(attempt.correctCount || 0))),
      accuracyPercent: Math.max(0, Math.min(100, Math.round(attempt.accuracyPercent || 0))),
      xpEarned: Math.max(0, Math.min(10000, Math.round(attempt.xpEarned || 0))),
      maxCombo: Math.max(0, Math.min(100, Math.round(attempt.maxCombo || 0))),
      competencyIds: (attempt.competencyIds ?? []).slice(0, 24).map((c) => String(c).slice(0, 16)),
      completedAt: (attempt.completedAt || new Date().toISOString()).slice(0, 64),
      createdAt: serverTimestamp(),
    });
    return true;
  } catch {
    return false;
  }
}

export async function fetchLearnerCloudBundle(uid: string): Promise<{
  profile: LearnerProfile | null;
  attempts: AssessmentSessionAttempt[];
  awards: TeacherAward[];
  error?: string;
  permissionDenied?: boolean;
}> {
  const current = auth.currentUser;
  if (!current || !current.emailVerified || current.uid !== uid) {
    return { profile: null, attempts: [], awards: [] };
  }
  try {
    const docId = toFirestoreDocId(uid, 128);
    const [profileSnap, awardsSnap, attemptsSnap] = await Promise.all([
      getDoc(doc(db, 'learnerProfiles', docId)),
      getDocs(
        query(collection(db, 'teacherAwards'), where('learnerUid', '==', docId)),
      ).catch(() => null),
      getDocs(
        query(collection(db, 'assessmentAttempts'), where('learnerUid', '==', docId)),
      ).catch(() => null),
    ]);

    const profile = profileSnap.exists()
      ? parseLearnerDoc(profileSnap.id, profileSnap.data() as Record<string, unknown>)
      : null;

    const awards: TeacherAward[] = awardsSnap
      ? awardsSnap.docs
          .map((row) => parseAwardDoc(row.id, row.data() as Record<string, unknown>))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : [];

    const attempts: AssessmentSessionAttempt[] = attemptsSnap
      ? attemptsSnap.docs
          .map((row) => parseAttemptDoc(row.id, row.data() as Record<string, unknown>))
          .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
          .slice(0, 40)
      : [];

    return { profile, attempts, awards };
  } catch (err) {
    const permissionDenied = isPermissionDeniedError(err);
    return {
      profile: null,
      attempts: [],
      awards: [],
      permissionDenied,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchAllLearnersFromFirestore(): Promise<{
  learners: LearnerProfile[];
  attempts: AssessmentSessionAttempt[];
  awards: TeacherAward[];
  error?: string;
  permissionDenied?: boolean;
}> {
  if (!isSignedInVerified()) {
    return { learners: [], attempts: [], awards: [] };
  }
  try {
    const [profilesSnap, awardsSnap, attemptsSnap] = await Promise.all([
      getDocs(collection(db, 'learnerProfiles')),
      getDocs(collection(db, 'teacherAwards')),
      getDocs(collection(db, 'assessmentAttempts')).catch(() => null),
    ]);

    const learners: LearnerProfile[] = profilesSnap.docs.map((row) =>
      parseLearnerDoc(row.id, row.data() as Record<string, unknown>),
    );

    const awards: TeacherAward[] = awardsSnap.docs
      .map((row) => parseAwardDoc(row.id, row.data() as Record<string, unknown>))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const attempts: AssessmentSessionAttempt[] = attemptsSnap
      ? attemptsSnap.docs
          .map((row) => parseAttemptDoc(row.id, row.data() as Record<string, unknown>))
          .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
          .slice(0, 300)
      : [];

    return { learners, attempts, awards };
  } catch (err) {
    const permissionDenied = isPermissionDeniedError(err);
    return {
      learners: [],
      attempts: [],
      awards: [],
      permissionDenied,
      error: permissionDenied
        ? 'Tài khoản hiện tại không có quyền đọc danh sách learnerProfiles trên Firestore (hoặc firestore.rules chưa được cập nhật lên Firebase Console).'
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

export async function fetchPublicLearnerHonorFromFirestore(): Promise<
  PublicLearnerHonorEntry[]
> {
  try {
    const snap = await getDocs(
      query(collection(db, 'publicLearnerHonor'), limit(200)),
    );
    return snap.docs
      .map((row) => {
        const d = row.data();
        return {
          uid: String(d.uid ?? row.id),
          fullName: String(d.fullName ?? ''),
          className: String(d.className ?? ''),
          schoolName: String(d.schoolName ?? ''),
          gradeBand: (
            d.gradeBand === 'middle' || d.gradeBand === 'high' ? d.gradeBand : 'primary'
          ) as PublicLearnerHonorEntry['gradeBand'],
          authType: 'google' as PublicLearnerHonorEntry['authType'],
          currentLevel: Math.max(1, Math.min(4, Number(d.currentLevel ?? 1))) as 1 | 2 | 3 | 4,
          totalXp: Number(d.totalXp ?? 0),
          masteredCount: Number(d.masteredCount ?? 0),
          expertCount: Number(d.expertCount ?? 0),
          accuracyPercent: Number(d.accuracyPercent ?? 0),
          totalExercisesDone: Number(d.totalExercisesDone ?? 0),
          awardsCount: Number(d.awardsCount ?? 0),
          latestBadgeTitle: d.latestBadgeTitle ? String(d.latestBadgeTitle) : undefined,
          lastActiveAt: String(d.lastActiveAt ?? normalizeTimestampToIso(d.updatedAt)),
        };
      })
      .filter((e) => e.fullName.length > 0 && !e.uid.startsWith('guest-'))
      .sort((a, b) => {
        if (b.totalXp !== a.totalXp) return b.totalXp - a.totalXp;
        if (b.masteredCount !== a.masteredCount) return b.masteredCount - a.masteredCount;
        return b.accuracyPercent - a.accuracyPercent;
      });
  } catch {
    return [];
  }
}

export async function saveTeacherAwardToFirestore(
  award: TeacherAward,
  learnerProfile?: LearnerProfile,
  nextAwardsCount?: number,
): Promise<{ ok: boolean; error?: string; xpUpdated?: boolean }> {
  if (!isSignedInVerified()) {
    return { ok: false, error: 'Giáo viên chưa đăng nhập Google Đám mây.' };
  }
  try {
    const docId = toFirestoreDocId(award.id, 80);
    await setDoc(doc(db, 'teacherAwards', docId), {
      id: docId,
      learnerUid: toFirestoreDocId(award.learnerUid, 128),
      learnerName: (award.learnerName || '').slice(0, 120),
      className: (award.className || '').slice(0, 60),
      schoolName: (award.schoolName || '').slice(0, 160),
      badgeId: (award.badgeId || 'custom').slice(0, 64),
      badgeTitle: (award.badgeTitle || 'Khen thưởng').slice(0, 140),
      message: (award.message || '').slice(0, 500),
      bonusXp: Math.max(0, Math.min(500, Math.round(award.bonusXp || 0))),
      awardedByName: (award.awardedByName || 'Giáo viên').slice(0, 120),
      ...(award.awardedByEmail
        ? { awardedByEmail: award.awardedByEmail.slice(0, 200) }
        : {}),
      createdAt: serverTimestamp(),
    });

    // Also update the student's learnerProfiles/{uid} XP & level + public honor board in Firestore!
    let xpUpdated = false;
    if (learnerProfile) {
      const bonus = Math.max(0, Math.min(500, Math.round(award.bonusXp || 0)));
      const nextXp = Math.min(1000000, (learnerProfile.totalXp || 0) + bonus);
      const nextLevel = Math.max(
        learnerProfile.currentLevel || 1,
        computeOverallLevel(learnerProfile.masteryByCompetency ?? {}, nextXp),
      ) as 1 | 2 | 3 | 4;
      const updatedProfile: LearnerProfile = {
        ...learnerProfile,
        totalXp: nextXp,
        currentLevel: nextLevel,
        updatedAt: new Date().toISOString(),
      };
      const profileRes = await saveLearnerProfileToFirestore(updatedProfile, {
        allowAdminWrite: true,
        awardsCount: nextAwardsCount ?? 1,
        latestBadgeTitle: award.badgeTitle,
      });
      xpUpdated = profileRes.ok;
    }

    return { ok: true, xpUpdated };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteTeacherAwardFromFirestore(
  awardId: string,
): Promise<boolean> {
  if (!isSignedInVerified()) return false;
  try {
    const docId = toFirestoreDocId(awardId, 80);
    await deleteDoc(doc(db, 'teacherAwards', docId));
    return true;
  } catch {
    return false;
  }
}
