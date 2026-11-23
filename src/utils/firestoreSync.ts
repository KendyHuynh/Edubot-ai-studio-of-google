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
  ClassRoom,
  LearnerProfile,
  Lesson,
  PushNotification,
  Question,
  TeacherAward,
} from '../shared/types';
import {
  hasStrippedAnswers,
  recoverMissingCorrectAnswers,
} from './answerRecovery';
import {
  DEFAULT_PUBLIC_WORKSPACE_ID,
  mergeLatestSubmissions,
  mergeSubmissionActivityLogs,
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
        classId: (sub.classId || 'LOP-5A').slice(0, 64),
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
        classId: (notif.classId || 'LOP-5A').slice(0, 64),
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
        classId: (log.classId || 'LOP-5A').slice(0, 64),
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

    const mergedSubmissions = mergeLatestSubmissions(submissions, publicSubmissions);
    const mergedActivityLogs = mergeSubmissionActivityLogs(activityLogs, mergedSubmissions);

    const healedLessons = recoverMissingCorrectAnswers(lessons);

    return {
      classes,
      lessons: healedLessons,
      submissions: mergedSubmissions,
      notifications,
      activityLogs: mergedActivityLogs,
    };
  } catch (error) {
    if (!isActiveOwner(ownerUid)) {
      return { classes: [], lessons: [], submissions: [], notifications: [], activityLogs: [] };
    }
    handleFirestoreError(error, OperationType.LIST, 'teacher_workspace');
  }
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
): Promise<void> {
  for (const cls of payload.classes) {
    if (!isActiveOwner(ownerUid)) return;
    await saveClassToFirestore(cls, ownerUid);
  }
  for (const lesson of payload.lessons) {
    if (!isActiveOwner(ownerUid)) return;
    await saveLessonToFirestore(lesson, ownerUid);
  }
  for (const sub of payload.submissions.slice(0, 40)) {
    if (!isActiveOwner(ownerUid)) return;
    await saveSubmissionToFirestore(sub, ownerUid);
  }
  for (const notif of payload.notifications.slice(0, 20)) {
    if (!isActiveOwner(ownerUid)) return;
    await saveNotificationToFirestore(notif, ownerUid);
  }
  for (const log of payload.activityLogs.slice(0, 30)) {
    if (!isActiveOwner(ownerUid)) return;
    const docId = toFirestoreDocId(log.id, 80);
    const knownExists = existingLogIds ? existingLogIds.has(docId) : undefined;
    await saveActivityLogToFirestore(log, ownerUid, knownExists);
  }
}

export function defaultShareCodeForUid(uid: string): string {
  return `WS-${toFirestoreDocId(uid, 12).toUpperCase()}`;
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
  if (!snap.exists()) {
    await setDoc(ref, {
      id: docId,
      ownerUid,
      classes: cleanClasses,
      lessons: cleanLessons,
      notifications: cleanNotifications,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } else {
    await updateDoc(ref, {
      classes: cleanClasses,
      lessons: cleanLessons,
      notifications: cleanNotifications,
      updatedAt: serverTimestamp(),
    });
  }
}

export async function publishPublicWorkspace(
  workspaceCode: string,
  ownerUid: string,
  classes: ClassRoom[],
  lessons: Lesson[],
  notifications: PushNotification[] = [],
): Promise<string> {
  const docId = toFirestoreDocId(workspaceCode, 64);
  if (!isActiveOwner(ownerUid)) return docId;
  const path = `publicWorkspaces/${docId}`;
  try {
    let existingLessons: Lesson[] = [];
    try {
      const existingSnap = await getDoc(doc(db, 'publicWorkspaces', docId));
      if (existingSnap.exists() && Array.isArray(existingSnap.data()?.lessons)) {
        existingLessons = existingSnap.data().lessons as Lesson[];
      }
    } catch {
      // Non-fatal
    }
    const healedLessons = recoverMissingCorrectAnswers(lessons, existingLessons);
    // Hard anti-wipe guard: never publish student-sanitized lessons (all blank answers) to publicWorkspaces
    if (hasStrippedAnswers(healedLessons)) {
      return docId;
    }
    const cleanClasses = classes.slice(0, 100).map((c) => ({
      id: String(c.id).slice(0, 64),
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
    const cleanNotifications = notifications.slice(0, 50).map((n) => ({
      id: toFirestoreDocId(n.id || 'notif', 80),
      classId: String(n.classId || '').slice(0, 64),
      lessonId: toFirestoreDocId(n.lessonId || 'lesson', 80),
      title: String(n.title || 'Thông báo').slice(0, 240),
      message: String(n.message || '').slice(0, 1000),
      createdAt: String(n.createdAt || new Date().toISOString()).slice(0, 64),
      readByGroupIds: (n.readByGroupIds ?? []).slice(0, 100).map((g) => String(g).slice(0, 120)),
    }));

    await writeSinglePublicWorkspaceDoc(
      docId,
      ownerUid,
      cleanClasses,
      cleanLessons,
      cleanNotifications,
    );

    // Also update the school-wide `default` public workspace so students opening the root URL
    // (without ?ws=...) automatically receive the teacher's latest classes, lessons & alerts.
    if (docId !== DEFAULT_PUBLIC_WORKSPACE_ID && isActiveOwner(ownerUid)) {
      try {
        await writeSinglePublicWorkspaceDoc(
          DEFAULT_PUBLIC_WORKSPACE_ID,
          ownerUid,
          cleanClasses,
          cleanLessons,
          cleanNotifications,
        );
      } catch {
        // Non-admin secondary teachers only write their own WS-<code> doc; ignore permission denial on `default`.
      }
    }

    return docId;
  } catch (error) {
    if (!isActiveOwner(ownerUid)) return docId;
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

// =========================================================================
// PERSONAL HOME LEARNER PROFILES & TEACHER AWARDS (CLOUD FIRESTORE SYNC)
// =========================================================================

export async function saveLearnerProfileToFirestore(
  profile: LearnerProfile,
): Promise<boolean> {
  const current = auth.currentUser;
  if (!current || !current.emailVerified || current.uid !== profile.uid) {
    return false;
  }
  try {
    const docId = toFirestoreDocId(profile.uid, 128);
    const ref = doc(db, 'learnerProfiles', docId);
    const snap = await getDoc(ref);
    const payload = {
      uid: docId,
      authType: 'google' as const,
      ...(profile.email ? { email: profile.email.slice(0, 200) } : {}),
      ...(profile.photoUrl ? { photoUrl: profile.photoUrl.slice(0, 500) } : {}),
      fullName: (profile.fullName || 'Học sinh').slice(0, 120),
      className: (profile.className || 'Tự học').slice(0, 60),
      schoolName: (profile.schoolName || 'Trường học').slice(0, 160),
      gradeBand: profile.gradeBand || 'primary',
      role: 'student' as const,
      profileCompleted: Boolean(profile.profileCompleted),
      currentLevel: Math.max(1, Math.min(4, Math.round(profile.currentLevel || 1))),
      totalXp: Math.max(0, Math.min(1000000, Math.round(profile.totalXp || 0))),
      bestCombo: Math.max(0, Math.min(1000, Math.round(profile.bestCombo || 0))),
      totalExercisesDone: Math.max(0, Math.min(100000, Math.round(profile.totalExercisesDone || 0))),
      totalCorrect: Math.max(0, Math.min(100000, Math.round(profile.totalCorrect || 0))),
      masteryByCompetency: profile.masteryByCompetency ?? {},
      lastActiveAt: (profile.lastActiveAt || new Date().toISOString()).slice(0, 64),
      updatedAt: serverTimestamp(),
    };
    if (!snap.exists()) {
      await setDoc(ref, { ...payload, createdAt: serverTimestamp() });
    } else {
      await updateDoc(ref, payload);
    }
    return true;
  } catch {
    return false;
  }
}

export async function fetchLearnerCloudBundle(uid: string): Promise<{
  profile: LearnerProfile | null;
  awards: TeacherAward[];
}> {
  const current = auth.currentUser;
  if (!current || !current.emailVerified || current.uid !== uid) {
    return { profile: null, awards: [] };
  }
  try {
    const docId = toFirestoreDocId(uid, 128);
    const [profileSnap, awardsSnap] = await Promise.all([
      getDoc(doc(db, 'learnerProfiles', docId)),
      getDocs(query(collection(db, 'teacherAwards'), where('learnerUid', '==', docId))),
    ]);

    let profile: LearnerProfile | null = null;
    if (profileSnap.exists()) {
      const d = profileSnap.data();
      profile = {
        uid: String(d.uid),
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
            ? d.masteryByCompetency
            : {},
        createdAt: normalizeTimestampToIso(d.createdAt),
        updatedAt: normalizeTimestampToIso(d.updatedAt),
        lastActiveAt: String(d.lastActiveAt ?? normalizeTimestampToIso(d.updatedAt)),
      };
    }

    const awards: TeacherAward[] = awardsSnap.docs
      .map((row) => {
        const d = row.data();
        return {
          id: String(d.id ?? row.id),
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
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return { profile, awards };
  } catch {
    return { profile: null, awards: [] };
  }
}

export async function fetchAllLearnersFromFirestore(): Promise<{
  learners: LearnerProfile[];
  awards: TeacherAward[];
}> {
  if (!isSignedInVerified()) return { learners: [], awards: [] };
  try {
    const [profilesSnap, awardsSnap] = await Promise.all([
      getDocs(collection(db, 'learnerProfiles')),
      getDocs(collection(db, 'teacherAwards')),
    ]);

    const learners: LearnerProfile[] = profilesSnap.docs.map((row) => {
      const d = row.data();
      return {
        uid: String(d.uid ?? row.id),
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
            ? d.masteryByCompetency
            : {},
        createdAt: normalizeTimestampToIso(d.createdAt),
        updatedAt: normalizeTimestampToIso(d.updatedAt),
        lastActiveAt: String(d.lastActiveAt ?? normalizeTimestampToIso(d.updatedAt)),
      };
    });

    const awards: TeacherAward[] = awardsSnap.docs
      .map((row) => {
        const d = row.data();
        return {
          id: String(d.id ?? row.id),
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
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return { learners, awards };
  } catch {
    return { learners: [], awards: [] };
  }
}

export async function saveTeacherAwardToFirestore(
  award: TeacherAward,
): Promise<boolean> {
  if (!isSignedInVerified()) return false;
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
    return true;
  } catch {
    return false;
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
