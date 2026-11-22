import assert from 'node:assert/strict';
import test from 'node:test';
import { Lesson } from '../shared/types';
import {
  countReadyAnswerKeys,
  forgetAiLesson,
  loadRememberedAiLessons,
  mergeLessonsPreservingCustom,
  rememberAiLessons,
  VaultStorageLike,
} from './aiLessonVault';

function createMemoryVault(): VaultStorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const sampleAiLesson: Lesson = {
  id: 'lesson-1799000000001',
  title: 'An toàn AI lớp 8',
  topic: 'AI & Công dân số',
  sourceFileName: 'BaiAI.txt',
  summary: 'Bài tạo bằng AI có sẵn đáp án chấm tự động',
  assignedClassIds: ['LOP-8A'],
  createdAt: '2026-11-21T10:00:00.000Z',
  questions: [
    {
      id: 'q-ai-1',
      type: 'multiple_choice',
      questionText: 'Nên làm gì khi AI đưa ra thông tin chưa rõ nguồn?',
      options: ['Kiểm chứng bằng nguồn uy tín', 'Tin ngay 100%', 'Chia sẻ luôn', 'Không cần đọc'],
      aiSearchKeywordHint: 'kiểm chứng thông tin AI',
      correctAnswer: 'Kiểm chứng bằng nguồn uy tín',
      competencyId: '6.2',
      competencyIds: ['6.2'],
      explanation: 'Luôn kiểm chứng thông tin từ AI bằng nguồn tin cậy.',
    },
  ],
};

test('rememberAiLessons persists AI lessons with answer keys and refuses stripped overwrites', () => {
  const storage = createMemoryVault();
  rememberAiLessons([sampleAiLesson], storage);

  const loaded = loadRememberedAiLessons(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].questions[0].correctAnswer, 'Kiểm chứng bằng nguồn uy tín');
  assert.deepEqual(countReadyAnswerKeys(loaded[0]), { ready: 1, total: 1 });

  // Attempt to overwrite with student-stripped lesson (correctAnswer: undefined)
  const stripped: Lesson = {
    ...sampleAiLesson,
    questions: sampleAiLesson.questions.map((q) => ({ ...q, correctAnswer: undefined })),
  };
  rememberAiLessons([stripped], storage);

  const afterStripped = loadRememberedAiLessons(storage);
  assert.equal(afterStripped.length, 1);
  assert.equal(afterStripped[0].questions[0].correctAnswer, 'Kiểm chứng bằng nguồn uy tín');
});

test('mergeLessonsPreservingCustom keeps locally generated AI lessons when cloud sync lacks them', () => {
  const cloudLesson: Lesson = {
    id: 'lesson-safety-netiquette',
    title: 'Bài 1',
    topic: 'An toàn',
    sourceFileName: 'b1.txt',
    summary: 'Seed',
    assignedClassIds: ['LOP-8A'],
    createdAt: '2026-11-20T00:00:00.000Z',
    questions: [
      {
        id: 'q1-pw',
        type: 'multiple_choice',
        questionText: 'Mật khẩu mạnh?',
        options: ['1234', 'SaoXanh#5A@2026!'],
        aiSearchKeywordHint: 'mật khẩu mạnh',
        correctAnswer: 'SaoXanh#5A@2026!',
        competencyId: '4.2',
        competencyIds: ['4.2'],
        explanation: 'Kết hợp ký tự.',
      },
    ],
  };

  const merged = mergeLessonsPreservingCustom([sampleAiLesson], [cloudLesson]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((l) => l.id === 'lesson-1799000000001'));
  assert.ok(merged.some((l) => l.id === 'lesson-safety-netiquette'));
});

test('forgetAiLesson removes deleted lesson so it does not come back', () => {
  const storage = createMemoryVault();
  rememberAiLessons([sampleAiLesson], storage);
  forgetAiLesson(sampleAiLesson.id, storage);

  assert.equal(loadRememberedAiLessons(storage).length, 0);
});
