import { ClassRoom, Lesson, PushNotification } from '../shared/types';
import { hasStrippedAnswers, recoverMissingCorrectAnswers } from './answerRecovery';
import {
  DEFAULT_PUBLIC_WORKSPACE_ID,
  dedupeById,
  isDemoSeedArtifactId,
  isDemoSeedClass,
  normalizeClassCode,
} from './firestoreHelpers';

export const STUDENT_PUBLIC_MEMORY_KEY = 'edubot_student_public_memory_v1';

export interface StudentPublicMemory {
  version: 1;
  publishedAt: string;
  publishedBy?: string;
  workspaceId: string;
  revision: number;
  classes: ClassRoom[];
  lessons: Lesson[];
  notifications: PushNotification[];
}

export interface StudentMemoryMeta {
  revision: number;
  publishedAt: string;
  publishedBy?: string;
  workspaceId: string;
  classesCount: number;
  lessonsCount: number;
}

export interface StudentMemoryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const memoryFallback = new Map<string, string>();
const defaultStudentMemoryStorage: StudentMemoryStorageLike = {
  getItem(key: string) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage.getItem(key);
      }
    } catch {
      // ignore storage access issues
    }
    return memoryFallback.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
        return;
      }
    } catch {
      // ignore storage quota errors
    }
    memoryFallback.set(key, value);
  },
};

export function sanitizeStudentPublicMemoryInput(input: {
  classes?: ClassRoom[];
  lessons?: Lesson[];
  notifications?: PushNotification[];
  existingLessons?: Lesson[];
}): {
  classes: ClassRoom[];
  lessons: Lesson[];
  notifications: PushNotification[];
} {
  const classes = dedupeById(
    (Array.isArray(input.classes) ? input.classes : [])
      .filter((c) => Boolean(c?.id && c?.name) && !isDemoSeedClass(c))
      .map((c) => ({
        ...c,
        id: normalizeClassCode(String(c.id)),
      })),
  );

  const rawLessons = (Array.isArray(input.lessons) ? input.lessons : []).filter(
    (l) => Boolean(l?.id && l?.title && Array.isArray(l.questions) && l.questions.length > 0),
  );
  const healedLessons = dedupeById(
    recoverMissingCorrectAnswers(rawLessons, input.existingLessons ?? []),
  ).map((l) => ({
    ...l,
    assignedClassIds: Array.from(
      new Set(
        (l.assignedClassIds ?? [])
          .map((cid) => normalizeClassCode(String(cid ?? '')))
          .filter(Boolean),
      ),
    ),
  }));

  const activeClassIds = new Set(classes.map((c) => c.id));
  const notifications = dedupeById(
    (Array.isArray(input.notifications) ? input.notifications : [])
      .filter(
        (n) =>
          Boolean(n?.id) &&
          !isDemoSeedArtifactId(n.id) &&
          (!n.classId || activeClassIds.size === 0 || activeClassIds.has(normalizeClassCode(n.classId))),
      )
      .map((n) => ({
        ...n,
        classId: n.classId ? normalizeClassCode(String(n.classId)) : '',
      })),
  );

  return { classes, lessons: healedLessons, notifications };
}

export function loadStudentPublicMemory(
  storage: StudentMemoryStorageLike = defaultStudentMemoryStorage,
): StudentPublicMemory | null {
  try {
    const raw = storage.getItem(STUDENT_PUBLIC_MEMORY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StudentPublicMemory>;
    if (!parsed || !Array.isArray(parsed.classes) || !Array.isArray(parsed.lessons)) {
      return null;
    }
    const clean = sanitizeStudentPublicMemoryInput({
      classes: parsed.classes,
      lessons: parsed.lessons,
      notifications: parsed.notifications,
    });
    if (clean.classes.length === 0 && clean.lessons.length === 0) {
      return null;
    }
    return {
      version: 1,
      publishedAt: String(parsed.publishedAt || new Date().toISOString()),
      publishedBy: parsed.publishedBy ? String(parsed.publishedBy) : undefined,
      workspaceId: String(parsed.workspaceId || DEFAULT_PUBLIC_WORKSPACE_ID),
      revision: typeof parsed.revision === 'number' && parsed.revision >= 1 ? parsed.revision : 1,
      classes: clean.classes,
      lessons: clean.lessons,
      notifications: clean.notifications,
    };
  } catch {
    return null;
  }
}

export function saveStudentPublicMemory(
  payload: {
    classes: ClassRoom[];
    lessons: Lesson[];
    notifications?: PushNotification[];
    workspaceId?: string;
    publishedBy?: string;
  },
  storage: StudentMemoryStorageLike = defaultStudentMemoryStorage,
): StudentPublicMemory | null {
  const prev = loadStudentPublicMemory(storage);
  const clean = sanitizeStudentPublicMemoryInput({
    classes: payload.classes,
    lessons: payload.lessons,
    notifications: payload.notifications ?? prev?.notifications ?? [],
    existingLessons: prev?.lessons ?? [],
  });

  // Never overwrite existing valid lessons in student memory with stripped student-mode lessons
  const finalLessons =
    clean.lessons.length > 0 && hasStrippedAnswers(clean.lessons) && prev && prev.lessons.length > 0
      ? prev.lessons
      : clean.lessons;

  if (clean.classes.length === 0 && finalLessons.length === 0) {
    return prev;
  }

  const next: StudentPublicMemory = {
    version: 1,
    publishedAt: new Date().toISOString(),
    publishedBy: payload.publishedBy ?? prev?.publishedBy,
    workspaceId: payload.workspaceId || prev?.workspaceId || DEFAULT_PUBLIC_WORKSPACE_ID,
    revision: (prev?.revision ?? 0) + 1,
    classes: clean.classes.length > 0 ? clean.classes : prev?.classes ?? [],
    lessons: finalLessons,
    notifications: clean.notifications,
  };

  try {
    storage.setItem(STUDENT_PUBLIC_MEMORY_KEY, JSON.stringify(next));
  } catch {
    // ignore storage quota errors
  }
  return next;
}
