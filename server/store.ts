import fs from 'fs';
import path from 'path';
import { createSeedData, StoreData } from '../src/shared/seedData';

export type { StoreData };

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'edubot-store.json');

let cachedStore: StoreData | null = null;

export function loadStore(): StoreData {
  if (cachedStore) {
    return cachedStore;
  }
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as StoreData;
      // Upgrade built-in seed lessons if they still have < 15 questions from earlier demo
      const seed = createSeedData();
      let upgraded = false;
      for (const seedLesson of seed.lessons) {
        const idx = parsed.lessons.findIndex((l) => l.id === seedLesson.id);
        if (idx >= 0 && parsed.lessons[idx].questions.length < 15) {
          parsed.lessons[idx] = {
            ...seedLesson,
            assignedClassIds: parsed.lessons[idx].assignedClassIds,
          };
          upgraded = true;
        }
      }
      cachedStore = parsed;
      if (upgraded) {
        saveStore(parsed);
      }
      return cachedStore;
    }
  } catch (err) {
    console.error('Failed to read store file, re-seeding:', err);
  }
  cachedStore = createSeedData();
  saveStore(cachedStore);
  return cachedStore;
}

export function saveStore(data: StoreData): void {
  cachedStore = data;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmpPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, STORE_PATH);
}
