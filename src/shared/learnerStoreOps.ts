import {
  applyAssessmentOutcomesDetailed,
  buildPublicLearnerHonorList,
  computeOverallLevel,
  createEmptyLearnerProfile,
  mergeLearnerProfiles,
} from './assessmentEngine';
import { StoreData } from './seedData';
import {
  AssessmentExerciseOutcome,
  AssessmentLevel,
  AssessmentSessionAttempt,
  AssessmentSessionMode,
  LearnerGradeBand,
  LearnerProfile,
  PublicLearnerHonorEntry,
  TeacherAward,
} from './types';

export const GUEST_LEARNER_UID_RE = /^guest-[A-Za-z0-9_-]{4,80}$/;

export function isValidGuestLearnerUid(uid: unknown): uid is string {
  return typeof uid === 'string' && GUEST_LEARNER_UID_RE.test(uid.trim());
}

export function generateGuestLearnerUid(className: string, fullName: string): string {
  const slugify = (s: string, maxLen: number) =>
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, maxLen);
  const clsPart = slugify(className, 8) || 'hs';
  const namePart = slugify(fullName, 12) || 'hocsinh';
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `guest-${clsPart}-${namePart}-${rand}`;
}

export function ensureLearnerCollections(store: StoreData): {
  learnerProfiles: LearnerProfile[];
  assessmentAttempts: AssessmentSessionAttempt[];
  teacherAwards: TeacherAward[];
} {
  if (!Array.isArray(store.learnerProfiles)) store.learnerProfiles = [];
  if (!Array.isArray(store.assessmentAttempts)) store.assessmentAttempts = [];
  if (!Array.isArray(store.teacherAwards)) store.teacherAwards = [];
  return {
    learnerProfiles: store.learnerProfiles,
    assessmentAttempts: store.assessmentAttempts,
    teacherAwards: store.teacherAwards,
  };
}

/**
 * Monotonically merges a Cloud Firestore learner profile (plus optional attempts/awards)
 * into the local/server store so switching devices or clearing browser cache NEVER resets progress.
 */
export function hydrateLearnerProfileInStore(
  store: StoreData,
  incomingProfile: LearnerProfile,
  incomingAttempts: AssessmentSessionAttempt[] = [],
  incomingAwards: TeacherAward[] = [],
): LearnerProfile {
  const { learnerProfiles, assessmentAttempts, teacherAwards } =
    ensureLearnerCollections(store);
  const cleanUid = String(incomingProfile.uid || '').trim().slice(0, 128);
  const idx = learnerProfiles.findIndex((p) => p.uid === cleanUid);

  let resolved: LearnerProfile;
  if (idx >= 0) {
    resolved = mergeLearnerProfiles(learnerProfiles[idx], {
      ...incomingProfile,
      uid: cleanUid,
    });
    learnerProfiles[idx] = resolved;
  } else {
    resolved = {
      ...incomingProfile,
      uid: cleanUid,
      role: 'student',
    };
    learnerProfiles.unshift(resolved);
  }

  if (incomingAttempts.length > 0) {
    const existingAttIds = new Set(assessmentAttempts.map((a) => a.id));
    for (const att of incomingAttempts) {
      if (att?.id && !existingAttIds.has(att.id)) {
        assessmentAttempts.push(att);
        existingAttIds.add(att.id);
      }
    }
    assessmentAttempts.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    if (assessmentAttempts.length > 500) {
      assessmentAttempts.length = 500;
    }
  }

  if (incomingAwards.length > 0) {
    const existingAwdIds = new Set(teacherAwards.map((a) => a.id));
    for (const awd of incomingAwards) {
      if (awd?.id && !existingAwdIds.has(awd.id)) {
        teacherAwards.push(awd);
        existingAwdIds.add(awd.id);
      }
    }
    teacherAwards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return resolved;
}

export interface UpsertLearnerProfileInput {
  uid: string;
  authType: 'google' | 'guest';
  email?: string;
  photoUrl?: string;
  fullName: string;
  className: string;
  schoolName: string;
  gradeBand?: LearnerGradeBand;
}

export function upsertLearnerProfileInStore(
  store: StoreData,
  input: UpsertLearnerProfileInput,
): LearnerProfile {
  const { learnerProfiles } = ensureLearnerCollections(store);
  const cleanUid = String(input.uid || '').trim().slice(0, 128);
  const fullName = String(input.fullName || '').trim().slice(0, 120);
  const className = String(input.className || '').trim().slice(0, 60);
  const schoolName = String(input.schoolName || '').trim().slice(0, 160);
  const gradeBand: LearnerGradeBand =
    input.gradeBand === 'middle' || input.gradeBand === 'high'
      ? input.gradeBand
      : 'primary';

  const existingIdx = learnerProfiles.findIndex((p) => p.uid === cleanUid);
  const now = new Date().toISOString();

  if (existingIdx >= 0) {
    const existing = learnerProfiles[existingIdx];
    const updated: LearnerProfile = {
      ...existing,
      authType: input.authType === 'google' ? 'google' : existing.authType,
      email: input.email ? String(input.email).trim().slice(0, 200) : existing.email,
      photoUrl: input.photoUrl ? String(input.photoUrl).slice(0, 500) : existing.photoUrl,
      fullName: fullName || existing.fullName,
      className: className || existing.className,
      schoolName: schoolName || existing.schoolName,
      gradeBand,
      role: 'student',
      profileCompleted: Boolean(
        (fullName || existing.fullName).length > 0 &&
          (className || existing.className).length > 0 &&
          (schoolName || existing.schoolName).length > 0,
      ),
      updatedAt: now,
      lastActiveAt: now,
    };
    learnerProfiles[existingIdx] = updated;
    return updated;
  }

  const created = createEmptyLearnerProfile({
    uid: cleanUid,
    authType: input.authType,
    email: input.email ? String(input.email).trim().slice(0, 200) : undefined,
    photoUrl: input.photoUrl ? String(input.photoUrl).slice(0, 500) : undefined,
    fullName: fullName || 'Học sinh Công dân số',
    className,
    schoolName,
    gradeBand,
  });
  learnerProfiles.unshift(created);
  return created;
}

export interface RecordAssessmentInput {
  learnerUid: string;
  learnerName?: string;
  className?: string;
  schoolName?: string;
  authType?: 'google' | 'guest';
  email?: string;
  gradeBand?: LearnerGradeBand;
  baseProfile?: LearnerProfile;
  mode: AssessmentSessionMode;
  targetLevel?: AssessmentLevel;
  targetCompetencyId?: string;
  outcomes: AssessmentExerciseOutcome[];
  maxCombo: number;
}

export function recordAssessmentAttemptInStore(
  store: StoreData,
  input: RecordAssessmentInput,
): { profile: LearnerProfile; attempt: AssessmentSessionAttempt } {
  const { learnerProfiles, assessmentAttempts } = ensureLearnerCollections(store);
  const uid = String(input.learnerUid || '').trim().slice(0, 128);
  let idx = learnerProfiles.findIndex((p) => p.uid === uid);

  if (idx < 0) {
    if (input.baseProfile && input.baseProfile.uid === uid) {
      hydrateLearnerProfileInStore(store, {
        ...input.baseProfile,
        authType: input.authType === 'google' ? 'google' : input.baseProfile.authType,
        email: input.email || input.baseProfile.email,
      });
      idx = learnerProfiles.findIndex((p) => p.uid === uid);
    } else {
      const created = upsertLearnerProfileInStore(store, {
        uid,
        authType: input.authType === 'google' ? 'google' : 'guest',
        email: input.email,
        fullName: input.learnerName || 'Học sinh thử nghiệm',
        className: input.className || 'Tự học',
        schoolName: input.schoolName || 'Trường học',
        gradeBand: input.gradeBand,
      });
      idx = learnerProfiles.findIndex((p) => p.uid === created.uid);
    }
  } else if (input.baseProfile && input.baseProfile.uid === uid) {
    learnerProfiles[idx] = mergeLearnerProfiles(learnerProfiles[idx], input.baseProfile);
  }

  const safeOutcomes = (Array.isArray(input.outcomes) ? input.outcomes : []).slice(0, 50);
  const {
    profile: updatedProfile,
    normalizedOutcomes,
    xpAdded,
  } = applyAssessmentOutcomesDetailed(
    learnerProfiles[idx],
    safeOutcomes,
    Math.max(0, Math.round(input.maxCombo || 0)),
  );
  learnerProfiles[idx] = updatedProfile;

  const totalQuestions = normalizedOutcomes.length;
  const correctCount = normalizedOutcomes.filter((o) => o.isCorrect).length;
  const accuracyPercent =
    totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
  const competencyIds = Array.from(new Set(normalizedOutcomes.map((o) => o.competencyId)));
  const now = new Date().toISOString();

  const attempt: AssessmentSessionAttempt = {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    learnerUid: updatedProfile.uid,
    learnerName: updatedProfile.fullName,
    className: updatedProfile.className,
    schoolName: updatedProfile.schoolName,
    mode: input.mode,
    targetLevel: input.targetLevel,
    targetCompetencyId: input.targetCompetencyId,
    totalQuestions,
    correctCount,
    accuracyPercent,
    xpEarned: xpAdded,
    maxCombo: Math.max(0, Math.round(input.maxCombo || 0)),
    competencyIds,
    outcomes: normalizedOutcomes,
    completedAt: now,
  };

  assessmentAttempts.unshift(attempt);
  if (assessmentAttempts.length > 500) {
    assessmentAttempts.length = 500;
  }

  return { profile: updatedProfile, attempt };
}

export interface CreateTeacherAwardInput {
  learnerUid: string;
  learnerSnapshot?: LearnerProfile;
  badgeId: string;
  badgeTitle: string;
  message: string;
  bonusXp: number;
  awardedByName: string;
  awardedByEmail?: string;
}

export function createTeacherAwardInStore(
  store: StoreData,
  input: CreateTeacherAwardInput,
): { award: TeacherAward; learner: LearnerProfile } | null {
  const { learnerProfiles, teacherAwards } = ensureLearnerCollections(store);
  let learner = learnerProfiles.find((p) => p.uid === input.learnerUid);
  if (!learner && input.learnerSnapshot && input.learnerSnapshot.uid === input.learnerUid) {
    learner = hydrateLearnerProfileInStore(store, input.learnerSnapshot);
  }
  if (!learner) return null;

  const bonusXp = Math.max(0, Math.min(500, Math.round(Number(input.bonusXp) || 0)));
  const now = new Date().toISOString();
  const award: TeacherAward = {
    id: `awd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    learnerUid: learner.uid,
    learnerName: learner.fullName,
    className: learner.className,
    schoolName: learner.schoolName,
    badgeId: String(input.badgeId || 'custom').slice(0, 64),
    badgeTitle: String(input.badgeTitle || 'Khen thưởng Công dân số').trim().slice(0, 140),
    message: String(input.message || '').trim().slice(0, 500),
    bonusXp,
    awardedByName: String(input.awardedByName || 'Giáo viên').trim().slice(0, 120),
    awardedByEmail: input.awardedByEmail
      ? String(input.awardedByEmail).trim().slice(0, 200)
      : undefined,
    createdAt: now,
  };

  teacherAwards.unshift(award);
  learner.totalXp += bonusXp;
  learner.currentLevel = Math.max(
    learner.currentLevel,
    computeOverallLevel(learner.masteryByCompetency, learner.totalXp),
  ) as AssessmentLevel;
  learner.updatedAt = now;

  return { award, learner };
}

export function deleteTeacherAwardInStore(
  store: StoreData,
  awardId: string,
): boolean {
  const { learnerProfiles, teacherAwards } = ensureLearnerCollections(store);
  const idx = teacherAwards.findIndex((a) => a.id === awardId);
  if (idx < 0) return false;
  const [removed] = teacherAwards.splice(idx, 1);
  const learner = learnerProfiles.find((p) => p.uid === removed.learnerUid);
  if (learner && removed.bonusXp > 0) {
    learner.totalXp = Math.max(0, learner.totalXp - removed.bonusXp);
    learner.updatedAt = new Date().toISOString();
  }
  return true;
}

export function getPublicHonorFromStore(
  store: StoreData,
  filters?: { schoolName?: string; className?: string },
): PublicLearnerHonorEntry[] {
  const { learnerProfiles, teacherAwards } = ensureLearnerCollections(store);
  return buildPublicLearnerHonorList(learnerProfiles, teacherAwards, filters);
}
