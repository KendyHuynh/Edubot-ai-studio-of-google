import { Lesson } from '../shared/types';
import { hasStrippedAnswers, recoverMissingCorrectAnswers } from './answerRecovery';

const AI_LESSON_VAULT_KEY = 'edubot_ai_lesson_vault_v1';
const DELETED_LESSON_IDS_KEY = 'edubot_deleted_lesson_ids_v1';

export interface VaultStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memoryVault = new Map<string, string>();
const defaultVaultStorage: VaultStorageLike = {
  getItem(key: string) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage.getItem(key);
      }
    } catch {
      // ignore storage errors
    }
    return memoryVault.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
        return;
      }
    } catch {
      // ignore storage errors
    }
    memoryVault.set(key, value);
  },
};

export const BUILT_IN_SEED_LESSON_IDS = new Set([
  'lesson-safety-netiquette',
  'lesson-ai-search',
]);

export function isAiGeneratedOrCustomLesson(lesson: Lesson): boolean {
  return Boolean(lesson?.id && !BUILT_IN_SEED_LESSON_IDS.has(lesson.id));
}

export function loadDeletedLessonIds(
  storage: VaultStorageLike = defaultVaultStorage,
): Set<string> {
  try {
    const raw = storage.getItem(DELETED_LESSON_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.map((id) => String(id)));
    }
  } catch {
    // ignore
  }
  return new Set();
}

function saveDeletedLessonIds(
  ids: Set<string>,
  storage: VaultStorageLike = defaultVaultStorage,
): void {
  try {
    storage.setItem(DELETED_LESSON_IDS_KEY, JSON.stringify(Array.from(ids).slice(-100)));
  } catch {
    // ignore
  }
}

export function loadRememberedAiLessons(
  storage: VaultStorageLike = defaultVaultStorage,
): Lesson[] {
  try {
    const raw = storage.getItem(AI_LESSON_VAULT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (l): l is Lesson =>
        Boolean(l?.id && l?.title && Array.isArray(l.questions) && l.questions.length > 0),
    );
    return recoverMissingCorrectAnswers(valid);
  } catch {
    return [];
  }
}

/**
 * Saves teacher lessons (especially AI-generated quizzes with full answer keys)
 * into persistent browser memory so they are never lost across reloads, syncs,
 * or server restarts. Never overwrites existing answer keys with stripped ones.
 */
export function rememberAiLessons(
  incomingLessons: Lesson[],
  storage: VaultStorageLike = defaultVaultStorage,
): Lesson[] {
  const existing = loadRememberedAiLessons(storage);
  const deletedIds = loadDeletedLessonIds(storage);
  const healedIncoming = recoverMissingCorrectAnswers(incomingLessons, existing);

  const byId = new Map<string, Lesson>();
  for (const lesson of existing) {
    if (!deletedIds.has(lesson.id)) {
      byId.set(lesson.id, lesson);
    }
  }

  for (const lesson of healedIncoming) {
    if (!lesson?.id || !lesson.title || !Array.isArray(lesson.questions) || lesson.questions.length === 0) {
      continue;
    }
    // Never overwrite a remembered lesson with stripped student-mode questions
    if (hasStrippedAnswers([lesson])) {
      continue;
    }
    // If teacher explicitly creates/imports this lesson again, un-delete it
    if (deletedIds.has(lesson.id)) {
      deletedIds.delete(lesson.id);
      saveDeletedLessonIds(deletedIds, storage);
    }
    byId.set(lesson.id, lesson);
  }

  const merged = Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
  );

  try {
    storage.setItem(AI_LESSON_VAULT_KEY, JSON.stringify(merged));
  } catch {
    // ignore quota errors
  }

  return merged;
}

/**
 * Explicitly forgets a lesson deleted by the teacher so it is not resurrected
 * by vault restoration.
 */
export function forgetAiLesson(
  lessonId: string,
  storage: VaultStorageLike = defaultVaultStorage,
): void {
  if (!lessonId) return;
  const existing = loadRememberedAiLessons(storage).filter((l) => l.id !== lessonId);
  try {
    storage.setItem(AI_LESSON_VAULT_KEY, JSON.stringify(existing));
  } catch {
    // ignore
  }
  const deleted = loadDeletedLessonIds(storage);
  deleted.add(lessonId);
  saveDeletedLessonIds(deleted, storage);
}

/**
 * Merges incoming cloud lessons with locally created custom/AI lessons so
 * syncing from Firestore never discards a freshly generated local AI lesson
 * that hasn't finished uploading yet, while still removing deleted built-in seeds.
 */
export function mergeLessonsPreservingCustom(
  existingLocalLessons: Lesson[],
  incomingCloudLessons: Lesson[],
  deletedIds: Set<string> = new Set(),
): Lesson[] {
  const healedCloud = recoverMissingCorrectAnswers(incomingCloudLessons, existingLocalLessons);
  const byId = new Map<string, Lesson>();

  for (const lesson of healedCloud) {
    if (!deletedIds.has(lesson.id)) {
      byId.set(lesson.id, lesson);
    }
  }

  // Keep any locally created custom/AI lessons that aren't yet in cloud and weren't deleted
  for (const localLesson of existingLocalLessons) {
    if (
      isAiGeneratedOrCustomLesson(localLesson) &&
      !byId.has(localLesson.id) &&
      !deletedIds.has(localLesson.id) &&
      !hasStrippedAnswers([localLesson])
    ) {
      byId.set(localLesson.id, localLesson);
    }
  }

  return Array.from(byId.values());
}

/**
 * Counts how many questions in a lesson have ready, non-empty answer keys for instant non-AI grading.
 */
export function countReadyAnswerKeys(lesson: Lesson): { ready: number; total: number } {
  const total = lesson.questions?.length ?? 0;
  const ready = (lesson.questions ?? []).filter(
    (q) => Boolean(q.correctAnswer && q.correctAnswer.trim().length > 0),
  ).length;
  return { ready, total };
}
