import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompetencyMatrix,
  buildDomainChampions,
  buildGradingFeedback,
  buildLeaderboard,
  calculatePoints,
  computeSkillLevelTitle,
  damerauLevenshteinDistance,
  evaluateAnswerMatch,
  formatGroupId,
  isAnswerMatch,
  normalizedFuzzySimilarity,
} from './scoring';
import { AnswerSubmission, Lesson } from './types';

test('calculatePoints awards fair per-question-type speed bonuses, scales partial credit, and preserves base points after bonus window', () => {
  // Multiple choice: <= 15s gets full +50 reading grace
  const fast = calculatePoints(true, 14000, 'multiple_choice');
  assert.equal(fast.basePoints, 100);
  assert.equal(fast.speedBonus, 50);
  assert.equal(fast.totalPoints, 150);

  // Multiple choice: 26.5s gets partial speed bonus
  const medium = calculatePoints(true, 26500, 'multiple_choice');
  assert.equal(medium.basePoints, 100);
  assert.ok(medium.speedBonus > 0 && medium.speedBonus < 50);

  // Multiple choice: > 60s still keeps full 100 accuracy points (never penalized for researching)
  const thorough = calculatePoints(true, 95000, 'multiple_choice');
  assert.equal(thorough.basePoints, 100);
  assert.equal(thorough.speedBonus, 0);
  assert.equal(thorough.totalPoints, 100);

  // Fill blank gets 20s full bonus; short answer gets 30s full bonus
  assert.equal(calculatePoints(true, 19000, 'fill_blank').speedBonus, 50);
  assert.equal(calculatePoints(true, 28000, 'short_answer').speedBonus, 50);

  // Partial credit scaling for fuzzy fill-in-the-blank near-matches
  const partial70 = calculatePoints(true, 15000, 'fill_blank', 0.7);
  assert.equal(partial70.basePoints, 70);
  assert.equal(partial70.speedBonus, 35);
  assert.equal(partial70.totalPoints, 105);

  const partial80 = calculatePoints(true, 15000, 'fill_blank', 0.8);
  assert.equal(partial80.basePoints, 80);
  assert.equal(partial80.speedBonus, 40);
  assert.equal(partial80.totalPoints, 120);

  // Wrong answer always earns 0 points regardless of speed or creditFactor
  const wrong = calculatePoints(false, 2000, 'multiple_choice', 1);
  assert.equal(wrong.totalPoints, 0);
  assert.equal(wrong.speedBonus, 0);
});

test('damerauLevenshteinDistance and normalizedFuzzySimilarity score adjacent transpositions and spelling variations accurately', () => {
  assert.equal(damerauLevenshteinDistance('password', 'password'), 0);
  // Adjacent transpositions count as edit distance 1 (not 2)
  assert.equal(damerauLevenshteinDistance('passwrod', 'password'), 1);
  assert.equal(damerauLevenshteinDistance('bna quyen', 'ban quyen'), 1);
  // Deletion + transposition = distance 2
  assert.equal(damerauLevenshteinDistance('paswrod', 'password'), 2);

  assert.equal(normalizedFuzzySimilarity('ban quyen', 'ban quyen'), 1);
  const simMinor = normalizedFuzzySimilarity('bna quyen', 'ban quyen');
  const simModerate = normalizedFuzzySimilarity('ban qyn', 'ban quyen');
  const simUnrelated = normalizedFuzzySimilarity('may tinh', 'ban quyen');
  assert.ok(simMinor > simModerate && simModerate > simUnrelated);
  assert.ok(simUnrelated < 0.35);
});

test('evaluateAnswerMatch distinguishes exact, synonym, fuzzy_full, fuzzy_partial, and none for fill_blank', () => {
  // 1. Exact & diacritic-insensitive match -> exact, 100% credit
  const exact = evaluateAnswerMatch('ban quyen', 'bản quyền', 'fill_blank');
  assert.equal(exact.isCorrect, true);
  assert.equal(exact.matchTier, 'exact');
  assert.equal(exact.creditFactor, 1);

  // 2. Curated Vietnamese/English synonym -> synonym, 100% credit
  const syn = evaluateAnswerMatch('digital footprint', 'dấu chân số', 'fill_blank');
  assert.equal(syn.isCorrect, true);
  assert.equal(syn.matchTier, 'synonym');
  assert.equal(syn.creditFactor, 1);

  // 3. Minor typo / adjacent transposition -> fuzzy_full, 100% credit
  const minorTypo = evaluateAnswerMatch('bna quyen', 'bản quyền', 'fill_blank');
  assert.equal(minorTypo.isCorrect, true);
  assert.equal(minorTypo.matchTier, 'fuzzy_full');
  assert.equal(minorTypo.creditFactor, 1);

  const transposeEn = evaluateAnswerMatch('passwrod', 'password', 'fill_blank');
  assert.equal(transposeEn.isCorrect, true);
  assert.equal(transposeEn.matchTier, 'fuzzy_full');
  assert.equal(transposeEn.creditFactor, 1);

  // 4. Moderate spelling variation -> fuzzy_partial, 70-80% credit
  const moderateTypo = evaluateAnswerMatch('ban qyn', 'bản quyền', 'fill_blank');
  assert.equal(moderateTypo.isCorrect, true);
  assert.equal(moderateTypo.matchTier, 'fuzzy_partial');
  assert.ok(moderateTypo.creditFactor >= 0.7 && moderateTypo.creditFactor <= 0.8);

  const moderateSingleWord = evaluateAnswerMatch('paswrod', 'password', 'fill_blank');
  assert.equal(moderateSingleWord.isCorrect, true);
  assert.equal(moderateSingleWord.matchTier, 'fuzzy_partial');
  assert.ok(moderateSingleWord.creditFactor >= 0.7 && moderateSingleWord.creditFactor <= 0.8);

  // 5. Partial core-keyword coverage -> fuzzy_partial (e.g. "mật khẩu" for "mật khẩu mạnh")
  const partialCore = evaluateAnswerMatch('mật khẩu', 'mật khẩu mạnh', 'fill_blank');
  assert.equal(partialCore.isCorrect, true);
  assert.equal(partialCore.matchTier, 'fuzzy_partial');
  assert.equal(partialCore.creditFactor, 0.8);

  // 6. Typo inside a synonym ("tac qyn" for "bản quyền") -> fuzzy_partial
  const fuzzySynonym = evaluateAnswerMatch('tac qyn', 'bản quyền', 'fill_blank');
  assert.equal(fuzzySynonym.isCorrect, true);
  assert.equal(fuzzySynonym.matchTier, 'fuzzy_partial');
  assert.ok(fuzzySynonym.creditFactor >= 0.7 && fuzzySynonym.creditFactor <= 0.8);

  // 7. Negation polarity mismatch MUST be rejected (0 credit), including diacritic-free "khong"
  const opposite1 = evaluateAnswerMatch('chia sẻ mật khẩu', 'không chia sẻ mật khẩu', 'fill_blank');
  assert.equal(opposite1.isCorrect, false);
  assert.equal(opposite1.creditFactor, 0);
  assert.equal(opposite1.matchTier, 'none');

  const sameNegNoAccent = evaluateAnswerMatch('khong chia se mat khau', 'không chia sẻ mật khẩu', 'fill_blank');
  assert.equal(sameNegNoAccent.isCorrect, true);
  assert.equal(sameNegNoAccent.creditFactor, 1);

  // 8. Completely unrelated answer -> none, 0 credit
  const unrelated = evaluateAnswerMatch('con mèo màu vàng', 'xác thực 2 bước', 'fill_blank');
  assert.equal(unrelated.isCorrect, false);
  assert.equal(unrelated.creditFactor, 0);
  assert.equal(unrelated.matchTier, 'none');

  // 9. Transparent encouraging feedback distinguishes partial credit vs synonym vs minor typo
  const partialPts = calculatePoints(true, 12000, 'fill_blank', moderateTypo.creditFactor);
  const partialMsgVi = buildGradingFeedback('Sao Xanh', moderateTypo, partialPts, 'vi');
  assert.match(partialMsgVi, /70%.*điểm khuyến khích/i);
  const synMsgEn = buildGradingFeedback('Blue Star', syn, calculatePoints(true, 10000, 'fill_blank', 1), 'en');
  assert.match(synMsgEn, /synonym/i);
});

test('isAnswerMatch grades deterministically without AI (|-variants, diacritics, negation, core keywords)', () => {
  assert.equal(isAnswerMatch('Mật khẩu mạnh!', 'Mật khẩu mạnh', 'multiple_choice'), true);
  assert.equal(
    isAnswerMatch('Em sẽ dùng xác thực hai yếu tố để bảo vệ', 'xác thực hai yếu tố', 'fill_blank'),
    true,
  );
  // Diacritic-insensitive tablet typing fallback
  assert.equal(
    isAnswerMatch('giay phep su dung', 'giấy phép sử dụng', 'fill_blank'),
    true,
  );
  // Pipe-separated accepted answer variants
  assert.equal(
    isAnswerMatch('ban quyen', 'giấy phép sử dụng | bản quyền | copyright', 'fill_blank'),
    true,
  );
  // Built-in Vietnamese synonym & number-word equivalence
  assert.equal(isAnswerMatch('bảo mật hai lớp', '2FA', 'fill_blank'), true);
  assert.equal(isAnswerMatch('xác thực hai bước', 'xác thực 2 bước', 'fill_blank'), true);
  assert.equal(isAnswerMatch('tác quyền', 'bản quyền', 'fill_blank'), true);
  assert.equal(isAnswerMatch('tin sai sự thật', 'tin giả', 'fill_blank'), true);
  // Minor tablet typo tolerance (Damerau-Levenshtein)
  assert.equal(isAnswerMatch('mat khau manhh', 'mật khẩu mạnh', 'fill_blank'), true);
  assert.equal(isAnswerMatch('kiem chung nguon', 'kiểm chứng nguồn tin', 'fill_blank'), true);
  // Short answer core keyword coverage without AI
  assert.equal(
    isAnswerMatch(
      'Nhắc bạn gỡ bỏ ngay vì tôn trọng quyền riêng tư không đăng ảnh người khác',
      'Nhắc nhở bạn gỡ bỏ ngay, tôn trọng quyền riêng tư và đạo đức số, không chia sẻ thông tin cá nhân người khác khi chưa có sự đồng ý.',
      'short_answer',
    ),
    true,
  );
  // Negation polarity still blocks opposite answers
  assert.equal(isAnswerMatch('Chia sẻ mật khẩu cho bạn', 'Không chia sẻ mật khẩu', 'short_answer'), false);
});

test('buildLeaderboard ranks groups by total score then accuracy then speed', () => {
  const subs: AnswerSubmission[] = [
    {
      id: '1',
      classId: 'LOP-5A',
      groupId: formatGroupId(1, 'Sao Xanh'),
      tabletNumber: 1,
      groupName: 'Sao Xanh',
      lessonId: 'L1',
      lessonTitle: 'An toàn mạng',
      questionId: 'Q1',
      competencyId: '4.2',
      userAnswer: 'A',
      isCorrect: true,
      basePoints: 100,
      speedBonus: 40,
      totalPoints: 140,
      elapsedMs: 10000,
      submittedAt: '2026-11-16T08:00:00Z',
      feedbackText: 'Tuyệt vời!',
      explanation: 'Bảo vệ dữ liệu cá nhân',
    },
    {
      id: '2',
      classId: 'LOP-5A',
      groupId: formatGroupId(2, 'Mặt Trời'),
      tabletNumber: 2,
      groupName: 'Mặt Trời',
      lessonId: 'L1',
      lessonTitle: 'An toàn mạng',
      questionId: 'Q1',
      competencyId: '6.2',
      userAnswer: 'B',
      isCorrect: true,
      basePoints: 100,
      speedBonus: 50,
      totalPoints: 150,
      elapsedMs: 5000,
      submittedAt: '2026-11-16T08:00:05Z',
      feedbackText: 'Xuất sắc!',
      explanation: 'Dùng AI có đạo đức',
    },
  ];

  const board = buildLeaderboard('LOP-5A', subs, 'vi');
  assert.equal(board.length, 2);
  assert.equal(board[0].Rank, 1);
  assert.equal(board[0].groupName, 'Mặt Trời');
  assert.equal(board[0].Score, 150);
  assert.equal(board[0].SkillLevel, 'Bậc thầy Ứng dụng AI');
  assert.equal(board[1].Rank, 2);
  assert.equal(board[1].SkillLevel, 'Chiến thần Bảo mật dữ liệu');

  const champions = buildDomainChampions('LOP-5A', subs, 'vi');
  assert.equal(champions.length, 2);
  assert.equal(champions[0].honorTitle, 'Bậc thầy Ứng dụng AI');
  assert.equal(champions[0].skillTierLabel, 'Cấp độ Chuyên gia Tốc độ');
});

test('computeSkillLevelTitle returns domain-specific honor title', () => {
  const subs: AnswerSubmission[] = [
    {
      id: '1',
      classId: 'LOP-5A',
      groupId: 'Máy-03 · Tia Chớp',
      tabletNumber: 3,
      groupName: 'Tia Chớp',
      lessonId: 'L1',
      lessonTitle: 'Bài 1',
      questionId: 'Q1',
      competencyId: '4.2',
      userAnswer: 'A',
      isCorrect: true,
      basePoints: 100,
      speedBonus: 30,
      totalPoints: 130,
      elapsedMs: 12000,
      submittedAt: '2026-11-16T08:00:00Z',
      feedbackText: 'Hay lắm!',
      explanation: 'OK',
    },
  ];
  const res = computeSkillLevelTitle(subs, 'vi');
  assert.equal(res.title, 'Chiến thần Bảo mật dữ liệu');
  assert.equal(res.topDomainId, '4');
});

test('buildCompetencyMatrix aggregates multi-competency questions across 24 competencies', () => {
  const lessons: Lesson[] = [
    {
      id: 'L1',
      title: 'Test',
      topic: 'AI',
      sourceFileName: 'test.txt',
      summary: 'Summary',
      assignedClassIds: ['LOP-5A'],
      createdAt: '2026-11-16T00:00:00Z',
      questions: [
        {
          id: 'Q1',
          type: 'multiple_choice',
          questionText: 'Q?',
          options: ['A', 'B'],
          aiSearchKeywordHint: 'AI ethics',
          correctAnswer: 'A',
          competencyId: '6.2',
          competencyIds: ['6.2', '2.3'],
          explanation: 'Exp',
        },
      ],
    },
  ];
  const matrix = buildCompetencyMatrix(lessons, []);
  assert.equal(matrix.length, 24);
  const comp62 = matrix.find((m) => m.competencyId === '6.2');
  const comp23 = matrix.find((m) => m.competencyId === '2.3');
  assert.equal(comp62?.questionCount, 1);
  assert.equal(comp23?.questionCount, 1);
  assert.equal(comp62?.accuracyPercent, null);
});
