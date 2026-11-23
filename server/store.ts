import fs from 'fs';
import path from 'path';
import { createEmptyStore, StoreData } from '../src/shared/seedData';
import { recoverMissingCorrectAnswers } from '../src/utils/answerRecovery';
import { sanitizeStoreRemoveDemoArtifacts } from '../src/utils/firestoreHelpers';

export type { StoreData };

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'edubot-store.json');

let cachedStore: StoreData | null = null;

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
  cachedStore = createEmptyStore();
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
