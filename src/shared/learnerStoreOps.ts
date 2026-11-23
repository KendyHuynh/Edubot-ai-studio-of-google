import {
  applyAssessmentOutcomesToProfile,
  buildPublicLearnerHonorList,
  createEmptyLearnerProfile,
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

  const safeOutcomes = (Array.isArray(input.outcomes) ? input.outcomes : []).slice(0, 50);
  const updatedProfile = applyAssessmentOutcomesToProfile(
    learnerProfiles[idx],
    safeOutcomes,
    Math.max(0, Math.round(input.maxCombo || 0)),
  );
  learnerProfiles[idx] = updatedProfile;

  const totalQuestions = safeOutcomes.length;
  const correctCount = safeOutcomes.filter((o) => o.isCorrect).length;
  const accuracyPercent =
    totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
  const xpEarned = safeOutcomes.reduce(
    (sum, o) => sum + Math.max(0, Math.round(o.xpEarned || 0)),
    0,
  );
  const competencyIds = Array.from(new Set(safeOutcomes.map((o) => o.competencyId)));
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
    xpEarned,
    maxCombo: Math.max(0, Math.round(input.maxCombo || 0)),
    competencyIds,
    outcomes: safeOutcomes,
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
  const learner = learnerProfiles.find((p) => p.uid === input.learnerUid);
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
