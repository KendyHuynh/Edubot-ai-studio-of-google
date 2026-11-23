export type Language = 'vi' | 'en';
export type UiMode = 'kid' | 'standard';
export type QuestionType = 'multiple_choice' | 'fill_blank' | 'short_answer';

export interface DomainInfo {
  id: string;
  number: number;
  nameVi: string;
  nameEn: string;
  accentHex: string;
  surfaceClass: string;
  textClass: string;
  borderClass: string;
  honorTitleVi: string;
  honorTitleEn: string;
}

export interface Competency {
  id: string; // e.g., "1.1", "4.2", "6.2"
  domainId: string;
  nameVi: string;
  nameEn: string;
  isCoreHighlighted: boolean;
}

export interface ClassRoom {
  id: string; // e.g., "LOP-5A"
  name: string;
  grade: string;
  teacherName: string;
  createdAt: string;
}

export interface SessionIdentity {
  classId: string;
  tabletNumber: number; // 1..10
  groupName: string; // e.g., "Nhóm Sao Xanh"
  groupId: string; // e.g., "May-01 · Nhóm Sao Xanh"
}

export interface Question {
  id: string;
  type: QuestionType;
  questionText: string;
  options?: string[];
  aiSearchKeywordHint: string;
  correctAnswer?: string; // Hidden from student payload during play
  competencyId: string; // Primary competency 1.1 .. 6.3
  competencyIds?: string[]; // 1 or more mapped competencies from 24 TT 02/2025
  explanation: string;
}

export interface Lesson {
  id: string;
  title: string;
  topic: string;
  sourceFileName: string;
  summary: string;
  assignedClassIds: string[];
  createdAt: string;
  questions: Question[];
}

export interface AnswerSubmission {
  id: string;
  classId: string;
  groupId: string;
  tabletNumber: number;
  groupName: string;
  lessonId: string;
  lessonTitle: string;
  questionId: string;
  competencyId: string;
  competencyIds?: string[];
  userAnswer: string;
  isCorrect: boolean;
  basePoints: number;
  speedBonus: number;
  totalPoints: number;
  elapsedMs: number;
  submittedAt: string;
  feedbackText: string;
  explanation: string;
  syncedFromOffline?: boolean;
}

export interface LeaderboardEntry {
  ClassID: string;
  GroupID: string;
  tabletNumber: number;
  groupName: string;
  Score: number;
  Rank: number;
  SkillLevel: string;
  correctCount: number;
  totalAnswered: number;
  accuracyPercent: number;
  avgElapsedMs: number;
  topDomainId: string;
}

export interface PushNotification {
  id: string;
  classId: string;
  lessonId: string;
  title: string;
  message: string;
  createdAt: string;
  readByGroupIds: string[];
}

export interface ActivityLog {
  id: string;
  classId: string;
  groupId: string;
  action: string;
  detail: string;
  competencyId?: string;
  pointsDelta?: number;
  timestamp: string;
}

export interface OfflineQueueItem {
  localId: string;
  classId: string;
  groupId: string;
  tabletNumber: number;
  groupName: string;
  lessonId: string;
  lessonTitle: string;
  questionId: string;
  competencyId: string;
  competencyIds?: string[];
  userAnswer: string;
  elapsedMs: number;
  submittedAt: string;
}

// --- Personal Home 24-Competency Self-Assessment & Teacher Rewards ---

export type StudentExperienceMode = 'classroom' | 'home';
export type AssessmentLevel = 1 | 2 | 3 | 4;
export type LearnerGradeBand = 'primary' | 'middle' | 'high';
export type AssessmentExerciseType =
  | 'scenario_choice'
  | 'true_false'
  | 'order_steps'
  | 'match_pairs'
  | 'classify';

export type AssessmentSessionMode =
  | 'diagnostic'
  | 'level_challenge'
  | 'competency_focus'
  | 'variety_sprint'
  | 'advanced_pack';

export type ExerciseRetryScoringTier =
  | 'first_mastery'
  | 'redemption_mastery'
  | 'review_bonus'
  | 'practice_no_xp'
  | 'first_attempt_effort'
  | 'repeat_wrong_no_xp';

export interface MatchPairItem {
  id: string;
  left: string;
  right: string;
}

export interface ClassifyItem {
  id: string;
  text: string;
  category: 'safe' | 'risk';
}

export interface AssessmentExercise {
  id: string;
  competencyId: string; // 1.1 .. 6.3
  level: AssessmentLevel; // 1 = Khám phá, 2 = Thực hành, 3 = Thành thạo, 4 = Chuyên gia
  type: AssessmentExerciseType;
  tier?: 'core' | 'expansion'; // expansion questions unlock at higher levels (L2/L3/L4)
  unlockMinLevel?: AssessmentLevel;
  contextBadge: string;
  prompt: string;
  options?: string[]; // scenario_choice
  correctOption?: string; // scenario_choice
  statement?: string; // true_false
  isTrue?: boolean; // true_false
  steps?: string[]; // order_steps (canonical correct order)
  pairs?: MatchPairItem[]; // match_pairs
  classifyItems?: ClassifyItem[]; // classify
  categoryLabels?: { safe: string; risk: string }; // classify
  hint: string;
  explanation: string;
}

export interface ExerciseAttemptRecord {
  attempts: number;
  correctCount: number;
  reviewBonusCount: number;
  lastAttemptAt: string;
}

export interface CompetencyMasteryRecord {
  competencyId: string;
  highestLevel: 0 | AssessmentLevel;
  attempts: number;
  correctCount: number;
  xp: number;
  lastPracticedAt: string;
  exerciseHistory?: Record<string, ExerciseAttemptRecord>;
}

export interface LearnerProfile {
  uid: string;
  authType: 'google' | 'guest';
  email?: string;
  photoUrl?: string;
  fullName: string;
  className: string;
  schoolName: string;
  gradeBand: LearnerGradeBand;
  role: 'student';
  profileCompleted: boolean;
  currentLevel: AssessmentLevel;
  totalXp: number;
  bestCombo: number;
  totalExercisesDone: number;
  totalCorrect: number;
  masteryByCompetency: Record<string, CompetencyMasteryRecord>;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

export interface AssessmentExerciseOutcome {
  exerciseId: string;
  competencyId: string;
  level: AssessmentLevel;
  type: AssessmentExerciseType;
  isCorrect: boolean;
  xpEarned: number;
  retryTier?: ExerciseRetryScoringTier;
}

export interface AssessmentSessionAttempt {
  id: string;
  learnerUid: string;
  learnerName: string;
  className: string;
  schoolName: string;
  mode: AssessmentSessionMode;
  targetLevel?: AssessmentLevel;
  targetCompetencyId?: string;
  totalQuestions: number;
  correctCount: number;
  accuracyPercent: number;
  xpEarned: number;
  maxCombo: number;
  competencyIds: string[];
  outcomes?: AssessmentExerciseOutcome[];
  completedAt: string;
}

export interface TeacherAward {
  id: string;
  learnerUid: string;
  learnerName: string;
  className: string;
  schoolName: string;
  badgeId: string;
  badgeTitle: string;
  message: string;
  bonusXp: number;
  awardedByName: string;
  awardedByEmail?: string;
  createdAt: string;
}

export interface PublicLearnerHonorEntry {
  uid: string;
  fullName: string;
  className: string;
  schoolName: string;
  gradeBand: LearnerGradeBand;
  authType: 'google' | 'guest';
  currentLevel: AssessmentLevel;
  totalXp: number;
  masteredCount: number; // competencies with highestLevel >= 1
  expertCount: number; // competencies with highestLevel >= 3
  accuracyPercent: number;
  totalExercisesDone: number;
  awardsCount: number;
  latestBadgeTitle?: string;
  lastActiveAt: string;
}

