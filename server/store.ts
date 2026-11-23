import fs from 'fs';
import path from 'path';
import { createEmptyStore, StoreData } from '../src/shared/seedData';
import { recoverMissingCorrectAnswers } from '../src/utils/answerRecovery';
import { sanitizeStoreRemoveDemoArtifacts } from '../src/utils/firestoreHelpers';

import {
  sanitizeStudentPublicMemoryInput,
  StudentPublicMemory,
} from '../src/utils/studentPublicMemory';
import { DEFAULT_PUBLIC_WORKSPACE_ID } from '../src/utils/firestoreHelpers';
import { ClassRoom, Lesson, PushNotification } from '../src/shared/types';
import { hasStrippedAnswers } from '../src/utils/answerRecovery';

export type { StoreData, StudentPublicMemory };

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'edubot-store.json');
const STUDENT_MEMORY_PATH = path.join(DATA_DIR, 'student-public-memory.json');

let cachedStore: StoreData | null = null;
let cachedStudentMemory: StudentPublicMemory | null = null;

export function loadStudentPublicMemoryServer(): StudentPublicMemory | null {
  if (cachedStudentMemory && fs.existsSync(STUDENT_MEMORY_PATH)) {
    return cachedStudentMemory;
  }
  cachedStudentMemory = null;
  try {
    if (fs.existsSync(STUDENT_MEMORY_PATH)) {
      const raw = fs.readFileSync(STUDENT_MEMORY_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<StudentPublicMemory>;
      if (Array.isArray(parsed.classes) && Array.isArray(parsed.lessons)) {
        const clean = sanitizeStudentPublicMemoryInput({
          classes: parsed.classes,
          lessons: parsed.lessons,
          notifications: parsed.notifications,
        });
        if (clean.classes.length > 0 || clean.lessons.length > 0) {
          cachedStudentMemory = {
            version: 1,
            publishedAt: String(parsed.publishedAt || new Date().toISOString()),
            publishedBy: parsed.publishedBy ? String(parsed.publishedBy) : undefined,
            workspaceId: String(parsed.workspaceId || DEFAULT_PUBLIC_WORKSPACE_ID),
            revision: typeof parsed.revision === 'number' && parsed.revision >= 1 ? parsed.revision : 1,
            classes: clean.classes,
            lessons: clean.lessons,
            notifications: clean.notifications,
          };
          return cachedStudentMemory;
        }
      }
    }
  } catch (err) {
    console.error('Failed to read student-public-memory.json:', err);
  }
  return null;
}

export function saveStudentPublicMemoryServer(payload: {
  classes: ClassRoom[];
  lessons: Lesson[];
  notifications?: PushNotification[];
  workspaceId?: string;
  publishedBy?: string;
}): StudentPublicMemory | null {
  const prev = loadStudentPublicMemoryServer();
  const clean = sanitizeStudentPublicMemoryInput({
    classes: payload.classes,
    lessons: payload.lessons,
    notifications: payload.notifications ?? prev?.notifications ?? [],
    existingLessons: prev?.lessons ?? [],
  });
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
  cachedStudentMemory = next;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpPath = `${STUDENT_MEMORY_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmpPath, STUDENT_MEMORY_PATH);
  return next;
}

export function loadStore(): StoreData {
  if (cachedStore && fs.existsSync(STORE_PATH)) {
    return cachedStore;
  }
  cachedStore = null;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as StoreData;
      let upgraded = false;

      // Strip legacy virtual demo classes (LOP-5A/5B/6A) and *-seed-* ghosts & deduplicate
      const sanitized = sanitizeStoreRemoveDemoArtifacts(parsed);
      if (sanitized.changed) {
        upgraded = true;
      }

      const hadBlankAnswers = (parsed.lessons ?? []).some((l) =>
        (l.questions ?? []).some((q) => !q.correctAnswer?.trim()),
      );
      if (hadBlankAnswers) {
        parsed.lessons = recoverMissingCorrectAnswers(parsed.lessons);
        upgraded = true;
      }
      cachedStore = parsed;
      if (upgraded) {
        saveStore(parsed);
      }
      return cachedStore;
    }
  } catch (err) {
    console.error('Failed to read store file, initializing clean store:', err);
  }
  const empty = createEmptyStore();
  // If server's dedicated Student Public Memory exists, seed from it so students never lose synced classes/lessons
  const studentMem = loadStudentPublicMemoryServer();
  if (studentMem) {
    empty.classes = studentMem.classes;
    empty.lessons = studentMem.lessons;
    empty.notifications = studentMem.notifications;
  }
  cachedStore = empty;
  saveStore(cachedStore);
  return cachedStore;
}

export function saveStore(data: StoreData): void {
  sanitizeStoreRemoveDemoArtifacts(data);
  cachedStore = data;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, STORE_PATH);
}
