import { createSeedData } from '../shared/seedData';
import { Lesson, Question } from '../shared/types';
import { normalizeAnswer } from '../shared/scoring';

const SEED_ANSWER_BY_ID = new Map<string, string>();
const SEED_ANSWER_BY_TEXT = new Map<string, string>();

for (const lesson of createSeedData().lessons) {
  for (const q of lesson.questions) {
    if (q.correctAnswer?.trim()) {
      SEED_ANSWER_BY_ID.set(q.id, q.correctAnswer.trim());
      SEED_ANSWER_BY_TEXT.set(normalizeAnswer(q.questionText), q.correctAnswer.trim());
    }
  }
}

/**
 * Exact recovered answer keys for teacher's lesson `lesson-1794902362895`
 * whose `correctAnswer` fields were inadvertently cleared by an earlier sync race.
 */
const RECOVERED_CLOUD_ANSWERS: Record<string, string> = {
  'q-1794902362895-1':
    'Tắt mic khi không phát biểu, không chen ngang và dùng khung chat để góp ý',
  'q-1794902362895-2': 'Google Meet và Google Docs',
  'q-1794902362895-3': 'giấy phép sử dụng',
  'q-1794902362895-4':
    'Trang web có tên miền chính thức, thông tin tác giả và nguồn trích dẫn rõ ràng',
  'q-1794902362895-5':
    'Để dễ dàng tìm kiếm, quản lý và chia sẻ tài liệu với nhóm',
  'q-1794902362895-6':
    'Khi cần trao đổi nhanh thông tin ngắn gọn hoặc gửi liên kết tài liệu tức thì',
  'q-1794902362895-7': 'lịch sự',
  'q-1794902362895-8':
    'Địa chỉ nhà riêng, số điện thoại và mật khẩu tài khoản',
  'q-1794902362895-9':
    'Kết hợp hài hòa giữa văn bản ngắn gọn, hình ảnh, biểu tượng và biểu đồ dễ hiểu',
  'q-1794902362895-10':
    'Cập nhật phần mềm thường xuyên và sử dụng chương trình bảo mật để quét virus',
  'q-1794902362895-11': 'nghỉ giải lao',
  'q-1794902362895-12':
    'Thu gom riêng và bỏ vào điểm thu hồi rác thải điện tử đúng quy định',
  'q-1794902362895-13':
    'Bình tĩnh lắng nghe cả hai bạn, đối thoại minh bạch và đặt mục tiêu chung của nhóm lên hàng đầu để thống nhất phương án hợp lý.',
  'q-1794902362895-14':
    'Dùng AI gợi ý dàn ý, tự đối chiếu nguồn tin cậy, chỉnh sửa bằng lời văn của mình và ghi chú khi cần',
  'q-1794902362895-15':
    'Nhắc nhở bạn gỡ bỏ ngay, tôn trọng quyền riêng tư và đạo đức số, không chia sẻ thông tin cá nhân người khác khi chưa có sự đồng ý.',
};

/**
 * Fallback heuristic ONLY when a multiple-choice question arrives with an empty `correctAnswer`
 * and is not present in existing local store or recovery maps.
 */
function inferMultipleChoiceAnswerFromExplanation(q: Question): string {
  if (q.type !== 'multiple_choice' || !Array.isArray(q.options) || q.options.length === 0) {
    return '';
  }
  const refText = normalizeAnswer(`${q.explanation ?? ''} ${q.aiSearchKeywordHint ?? ''}`);
  if (!refText) return '';
  const refTokens = new Set(refText.split(' ').filter((t) => t.length >= 2));
  if (refTokens.size === 0) return '';

  let bestOpt = '';
  let bestScore = 0;
  for (const opt of q.options) {
    const optTokens = normalizeAnswer(opt)
      .split(' ')
      .filter((t) => t.length >= 2);
    let score = 0;
    for (const tok of optTokens) {
      if (refTokens.has(tok)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestOpt = opt;
    }
  }
  return bestScore >= 2 ? bestOpt : '';
}

/**
 * Repairs any question whose `correctAnswer` is missing or empty using:
 * 1. Existing non-empty `correctAnswer` on the incoming question itself.
 * 2. Preserved non-empty `correctAnswer` from the previous local store.
 * 3. Built-in seed answers or known recovered cloud answers.
 * 4. Explanation overlap fallback for multiple-choice questions.
 */
export function recoverMissingCorrectAnswers(
  incomingLessons: Lesson[],
  existingLessons: Lesson[] = [],
): Lesson[] {
  const existingById = new Map<string, string>();
  const existingByText = new Map<string, string>();
  for (const lesson of existingLessons) {
    for (const q of lesson.questions ?? []) {
      if (q.correctAnswer?.trim()) {
        existingById.set(`${lesson.id}::${q.id}`, q.correctAnswer.trim());
        existingById.set(q.id, q.correctAnswer.trim());
        existingByText.set(normalizeAnswer(q.questionText), q.correctAnswer.trim());
      }
    }
  }

  return incomingLessons.map((lesson) => ({
    ...lesson,
    questions: (lesson.questions ?? []).map((q) => {
      if (q.correctAnswer && q.correctAnswer.trim().length > 0) {
        return q;
      }
      const normText = normalizeAnswer(q.questionText ?? '');
      const recovered =
        existingById.get(`${lesson.id}::${q.id}`) ||
        existingById.get(q.id) ||
        existingByText.get(normText) ||
        SEED_ANSWER_BY_ID.get(q.id) ||
        SEED_ANSWER_BY_TEXT.get(normText) ||
        RECOVERED_CLOUD_ANSWERS[q.id] ||
        inferMultipleChoiceAnswerFromExplanation(q);

      return recovered ? { ...q, correctAnswer: recovered } : q;
    }),
  }));
}

/**
 * Returns true if the lesson list appears to be student-sanitized (answers stripped)
 * and therefore MUST NOT be pushed back to overwrite Firestore teacher records.
 */
export function hasStrippedAnswers(lessons: Lesson[]): boolean {
  const allQuestions = lessons.flatMap((l) => l.questions ?? []);
  if (allQuestions.length === 0) return false;
  return allQuestions.every((q) => !q.correctAnswer || !q.correctAnswer.trim());
}
