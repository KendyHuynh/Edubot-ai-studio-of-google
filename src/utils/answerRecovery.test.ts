import assert from 'node:assert/strict';
import test from 'node:test';
import { hasStrippedAnswers, recoverMissingCorrectAnswers } from './answerRecovery';
import { isAnswerMatch } from '../shared/scoring';
import { createSeedData } from '../shared/seedData';
import { Lesson } from '../shared/types';

test('recoverMissingCorrectAnswers restores cleared answers for built-in seed lessons', () => {
  const seed = createSeedData();
  const wiped: Lesson[] = seed.lessons.map((l) => ({
    ...l,
    questions: l.questions.map((q) => ({ ...q, correctAnswer: '' })),
  }));

  assert.equal(hasStrippedAnswers(wiped), true);
  const repaired = recoverMissingCorrectAnswers(wiped);
  assert.equal(hasStrippedAnswers(repaired), false);

  const q1 = repaired[0].questions.find((q) => q.id === 'q1-pw');
  assert.equal(q1?.correctAnswer, 'SaoXanh#5A@2026!');
  assert.equal(isAnswerMatch('SaoXanh#5A@2026!', q1?.correctAnswer ?? '', 'multiple_choice'), true);

  for (const lesson of repaired) {
    for (const q of lesson.questions) {
      assert.ok(q.correctAnswer && q.correctAnswer.trim().length > 0, `Missing answer for ${q.id}`);
    }
  }
});

test('recoverMissingCorrectAnswers restores cleared answers for teacher lesson-1794902362895', () => {
  const wipedTeacherLesson: Lesson = {
    id: 'lesson-1794902362895',
    title: 'GIAO TIẾP VÀ HỢP TÁC HIỆU QUẢ TRONG MÔI TRƯỜNG SỐ',
    topic: 'Giao tiếp số',
    sourceFileName: 'bai.txt',
    summary: 'Tóm tắt',
    assignedClassIds: ['LOP-8A'],
    createdAt: '2026-11-21T00:00:00.000Z',
    questions: [
      {
        id: 'q-1794902362895-1',
        type: 'multiple_choice',
        questionText: 'Khi tham gia cuộc họp nhóm trực tuyến...',
        options: [
          'Luôn bật mic',
          'Tắt mic khi không phát biểu, không chen ngang và dùng khung chat để góp ý',
        ],
        aiSearchKeywordHint: 'tắt mic',
        correctAnswer: '',
        competencyId: '2.1',
        explanation: 'Tắt micro khi không nói...',
      },
      {
        id: 'q-1794902362895-3',
        type: 'fill_blank',
        questionText: 'Sử dụng bộ lọc ______ để đảm bảo quyền sử dụng hợp pháp.',
        aiSearchKeywordHint: 'giấy phép',
        correctAnswer: '',
        competencyId: '1.1',
        explanation: 'Lọc theo giấy phép sử dụng.',
      },
    ],
  };

  const [repaired] = recoverMissingCorrectAnswers([wipedTeacherLesson]);
  assert.equal(
    repaired.questions[0].correctAnswer,
    'Tắt mic khi không phát biểu, không chen ngang và dùng khung chat để góp ý',
  );
  assert.equal(repaired.questions[1].correctAnswer, 'giấy phép sử dụng');
});

test('recoverMissingCorrectAnswers preserves existing local answers over empty cloud answers', () => {
  const local: Lesson[] = [
    {
      id: 'lesson-custom',
      title: 'Custom',
      topic: 'Custom',
      sourceFileName: 'c.txt',
      summary: 's',
      assignedClassIds: ['LOP-8A'],
      createdAt: '2026-11-21T00:00:00.000Z',
      questions: [
        {
          id: 'q-custom-1',
          type: 'multiple_choice',
          questionText: 'Câu hỏi tùy chỉnh?',
          options: ['Phương án 1', 'Phương án 2'],
          aiSearchKeywordHint: 'từ khóa',
          correctAnswer: 'Phương án 2',
          competencyId: '1.1',
          explanation: 'Giải thích',
        },
      ],
    },
  ];
  const cloudWithEmpty: Lesson[] = [
    {
      ...local[0],
      questions: [{ ...local[0].questions[0], correctAnswer: '' }],
    },
  ];

  const repaired = recoverMissingCorrectAnswers(cloudWithEmpty, local);
  assert.equal(repaired[0].questions[0].correctAnswer, 'Phương án 2');
});

test('isAnswerMatch supports multiple_choice letter codes and letter-prefixed answers', () => {
  const opts = ['12345678', 'ngay_sinh_cua_em_2015', 'SaoXanh#5A@2026!', 'matkhau'];
  assert.equal(isAnswerMatch('SaoXanh#5A@2026!', 'SaoXanh#5A@2026!', 'multiple_choice', opts), true);
  assert.equal(isAnswerMatch('SaoXanh#5A@2026!', 'C', 'multiple_choice', opts), true);
  assert.equal(isAnswerMatch('SaoXanh#5A@2026!', 'C. SaoXanh#5A@2026!', 'multiple_choice', opts), true);
  assert.equal(isAnswerMatch('12345678', 'C', 'multiple_choice', opts), false);
});
