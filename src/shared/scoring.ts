import { COMPETENCIES_24, COMPETENCY_DOMAINS, getDomainByCompetencyId } from './competencies';
import {
  AnswerSubmission,
  Language,
  LeaderboardEntry,
  Lesson,
  QuestionType,
} from './types';

export function normalizeAnswer(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFC')
    .replace(/[.,!?;:"'()\[\]]/g, '')
    .replace(/\s+/g, ' ');
}

export function stripVietnameseDiacritics(input: string): string {
  return normalizeAnswer(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

const STRICT_NEGATION_TOKENS = new Set([
  'không',
  'đừng',
  'tránh',
  'chưa',
  'chớ',
  'cấm',
  'not',
  'never',
  'no',
  'dont',
  "don't",
]);

const STOPWORDS = new Set([
  'la',
  'cua',
  'va',
  'cac',
  'nhung',
  'de',
  'khi',
  'co',
  'mot',
  'duoc',
  'trong',
  'voi',
  've',
  'nen',
  'phai',
  'can',
  'em',
  'ban',
  'nhom',
  'ta',
  'minh',
  'hay',
  'rat',
  'nay',
  'do',
  'se',
  'da',
  'dang',
  'tai',
  'tren',
  'bang',
  'cho',
  'nhu',
  'the',
  'and',
  'for',
  'to',
  'is',
  'are',
  'of',
  'in',
  'on',
  'a',
  'an',
  'we',
  'you',
  'should',
]);

const OPTION_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

const NUMBER_WORD_MAP: Record<string, string> = {
  mot: '1',
  hai: '2',
  ba: '3',
  bon: '4',
  nam: '5',
  sau: '6',
  bay: '7',
  tam: '8',
  chin: '9',
  muoi: '10',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
};

function normalizeNumberWords(folded: string): string {
  return folded
    .split(' ')
    .map((tok) => NUMBER_WORD_MAP[tok] ?? tok)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Curated Vietnamese Digital Citizenship synonym / near-meaning equivalence groups
 * (diacritic-stripped & number-word normalized) so students typing valid near-matches
 * or equivalent everyday Vietnamese phrases on tablets receive full credit without AI.
 */
const VIETNAMESE_SYNONYM_GROUPS: string[][] = [
  [
    '2fa',
    'xac thuc 2 buoc',
    'xac thuc 2 yeu to',
    'xac thuc 2 lop',
    'bao mat 2 lop',
    'bao mat 2 buoc',
    'bao mat 2 yeu to',
    'ma otp',
    'otp',
    'two factor',
    'two step verification',
  ],
  [
    'ban quyen',
    'tac quyen',
    'copyright',
    'giay phep su dung',
    'ghi nguon',
    'ghi ro nguon',
    'trich dan nguon',
    'ton trong ban quyen',
    'xin phep tac gia',
  ],
  [
    'tin gia',
    'fake news',
    'tin sai su that',
    'tin don that thiet',
    'thong tin sai lech',
    'thong tin gia',
    'tin that thiet',
  ],
  [
    'kiem chung',
    'xac minh',
    'kiem tra nguon',
    'kiem chung nguon',
    'doi chieu nguon',
    'kiem tra thong tin',
    'check nguon',
    'nguon chinh thong',
    'nguon uy tin',
  ],
  [
    'mat khau manh',
    'password manh',
    'pass manh',
    'mat khau an toan',
    'mat khau phuc tap',
  ],
  [
    'lua dao',
    'phishing',
    'gia mao',
    'danh cap thong tin',
    'link doc hai',
    'duong link la',
    'link la',
    'trang web gia mao',
  ],
  [
    'quyen rieng tu',
    'thong tin ca nhan',
    'du lieu ca nhan',
    'bao mat ca nhan',
    'rieng tu',
    'anh rieng tu',
  ],
  [
    'ao giac',
    'hallucination',
    'bia thong tin',
    'thong tin bia dat',
    'ai noi sai',
    'ai bia thong tin',
  ],
  [
    'tu khoa',
    'keyword',
    'cum tu tim kiem',
    'tu tim kiem',
    'toan tu tim kiem',
  ],
  [
    'ung xu van minh',
    'van hoa mang',
    'netiquette',
    'lich su tren mang',
    'ton trong nguoi khac',
    'khong bat nat mang',
  ],
  [
    'bao cao',
    'report',
    'chan',
    'block',
    'bao giao vien',
    'bao thay co',
    'bao cha me',
    'bao nguoi lon',
  ],
  [
    'hop tac truc tuyen',
    'lam viec nhom truc tuyen',
    'soan thao nhom',
    'google docs',
    'google meet',
  ],
];

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function isFuzzyTokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) return false;
  const dist = levenshteinDistance(a, b);
  if (maxLen >= 8) return dist <= 2;
  return dist <= 1;
}

function matchesSynonymGroup(foldedNormUser: string, foldedNormCorrect: string): boolean {
  for (const group of VIETNAMESE_SYNONYM_GROUPS) {
    const refInGroup = group.some(
      (phrase) =>
        foldedNormCorrect === phrase ||
        (phrase.length >= 4 && foldedNormCorrect.includes(phrase)) ||
        (foldedNormCorrect.length >= 4 && phrase.includes(foldedNormCorrect)),
    );
    if (!refInGroup) continue;
    const userInGroup = group.some((phrase) => {
      if (foldedNormUser === phrase) return true;
      if (phrase.length >= 4 && foldedNormUser.includes(phrase)) return true;
      if (foldedNormUser.length >= 4 && phrase.includes(foldedNormUser)) return true;
      if (phrase.length >= 6 && Math.abs(foldedNormUser.length - phrase.length) <= 2) {
        return levenshteinDistance(foldedNormUser, phrase) <= 2;
      }
      return false;
    });
    if (userInGroup) return true;
  }
  return false;
}

function matchSingleKeyVariant(
  userAnswer: string,
  correctVariant: string,
  type: QuestionType,
  options?: string[],
): boolean {
  const normUser = normalizeAnswer(userAnswer);
  const normCorrect = normalizeAnswer(correctVariant);
  if (!normUser || !normCorrect) {
    return false;
  }
  if (normUser === normCorrect) {
    return true;
  }

  const foldedUser = stripVietnameseDiacritics(userAnswer);
  const foldedCorrect = stripVietnameseDiacritics(correctVariant);

  if (type === 'multiple_choice') {
    if (foldedUser && foldedUser === foldedCorrect) {
      return true;
    }
    // Support letter-only correctAnswer (e.g. "C") when options are provided
    const letterIdx = OPTION_LETTERS.indexOf(normCorrect);
    if (letterIdx >= 0 && Array.isArray(options) && options[letterIdx]) {
      if (
        normUser === normalizeAnswer(options[letterIdx]) ||
        foldedUser === stripVietnameseDiacritics(options[letterIdx])
      ) {
        return true;
      }
    }
    // Support letter-prefixed correctAnswer (e.g. "C. SaoXanh#5A@2026!")
    const strippedCorrect = normalizeAnswer(
      correctVariant.trim().replace(/^[A-Fa-f][.):\-\s]+/, ''),
    );
    if (
      strippedCorrect &&
      (normUser === strippedCorrect ||
        foldedUser === stripVietnameseDiacritics(strippedCorrect))
    ) {
      return true;
    }
    const strippedUser = normalizeAnswer(
      userAnswer.trim().replace(/^[A-Fa-f][.):\-\s]+/, ''),
    );
    if (
      strippedUser &&
      (strippedUser === normCorrect ||
        stripVietnameseDiacritics(strippedUser) === foldedCorrect)
    ) {
      return true;
    }
    return false;
  }

  // Deterministic pre-keyed forgiving grading for fill_blank & short_answer (ZERO AI needed)
  if (type === 'fill_blank' || type === 'short_answer') {
    // Check negation polarity on exact Vietnamese tokens (handles multiple negations like "không ... chưa ...")
    const exactRefTokens = normCorrect.split(' ').filter((t) => t.length > 1);
    const exactUserTokens = normUser.split(' ').filter((t) => t.length > 1);
    const refHasNeg = exactRefTokens.some((t) => STRICT_NEGATION_TOKENS.has(t));
    const userHasNeg = exactUserTokens.some((t) => STRICT_NEGATION_TOKENS.has(t));
    if (refHasNeg !== userHasNeg) {
      return false;
    }

    const numUser = normalizeNumberWords(foldedUser);
    const numCorrect = normalizeNumberWords(foldedCorrect);

    // Exact, diacritic-insensitive, or number-word equivalent match ("hai bước" == "2 bước")
    if (foldedUser === foldedCorrect || numUser === numCorrect) {
      return true;
    }

    // Substring match if student wrote a full sentence containing the key phrase
    if (
      numCorrect.length >= 3 &&
      (normUser.includes(normCorrect) ||
        foldedUser.includes(foldedCorrect) ||
        numUser.includes(numCorrect))
    ) {
      return true;
    }

    // Synonym / near-meaning equivalence match (e.g. "bảo mật hai lớp" <-> "2FA", "tác quyền" <-> "bản quyền")
    if (matchesSynonymGroup(numUser, numCorrect)) {
      return true;
    }

    // Whole-phrase minor typo tolerance for fill_blank (e.g. "ban quyenn", "mat khau manhh")
    if (
      type === 'fill_blank' &&
      numCorrect.length >= 5 &&
      Math.abs(numUser.length - numCorrect.length) <= 2
    ) {
      const allowedEdits = Math.min(2, Math.max(1, Math.floor(numCorrect.length * 0.2)));
      if (levenshteinDistance(numUser, numCorrect) <= allowedEdits) {
        return true;
      }
    }

    // Fuzzy typo-tolerant core keyword overlap (excluding filler stopwords)
    const refCore = numCorrect
      .split(' ')
      .filter((t) => t.length >= 1 && !STOPWORDS.has(t) && (t.length > 1 || /^\d+$/.test(t)));
    const userCore = numUser
      .split(' ')
      .filter((t) => t.length >= 1 && !STOPWORDS.has(t) && (t.length > 1 || /^\d+$/.test(t)));

    if (refCore.length === 1) {
      return userCore.some((ut) => isFuzzyTokenMatch(ut, refCore[0]));
    }
    if (refCore.length >= 2) {
      const matched = refCore.filter((rt) =>
        userCore.some((ut) => isFuzzyTokenMatch(ut, rt)),
      ).length;
      const ratio = matched / refCore.length;
      if (type === 'short_answer') {
        return ratio >= 0.55 || (refCore.length >= 5 && matched >= 3 && ratio >= 0.4);
      }
      return ratio >= 0.65;
    }
  }
  return false;
}

/**
 * Deterministic, instant answer matcher using pre-stored teacher/AI answer keys.
 * Supports multiple accepted variants separated by `|` for fill_blank & short_answer.
 */
export function isAnswerMatch(
  userAnswer: string,
  correctAnswer: string,
  type: QuestionType,
  options?: string[],
): boolean {
  if (!userAnswer?.trim() || !correctAnswer?.trim()) {
    return false;
  }
  if (type === 'multiple_choice') {
    return matchSingleKeyVariant(userAnswer, correctAnswer, type, options);
  }
  const variants = correctAnswer
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean);
  for (const variant of variants) {
    if (matchSingleKeyVariant(userAnswer, variant, type, options)) {
      return true;
    }
  }
  return false;
}

export interface PointsBreakdown {
  basePoints: number;
  speedBonus: number;
  totalPoints: number;
}

export interface TimingRule {
  /** Seconds of reading/thinking grace where full +50 speed bonus is awarded */
  graceSec: number;
  /** Seconds where speed bonus tapers down to 0 (accuracy still gets full +100 pts after this) */
  bonusEndSec: number;
  /** Upper clamp in seconds so idle tablets never distort class average speed */
  maxTrackedSec: number;
}

/**
 * Pedagogically fair classroom timing thresholds per question type:
 * - Multiple choice: 15s full-bonus reading window, bonus tapers until 60s
 * - Fill in blank:   20s full-bonus typing window, bonus tapers until 75s
 * - Short answer:    30s full-bonus thinking/typing window, bonus tapers until 90s
 * Beyond bonusEndSec, students ALWAYS keep full +100 accuracy points (never penalized for researching!).
 */
export function getTimingRuleForQuestionType(
  type: QuestionType = 'multiple_choice',
): TimingRule {
  if (type === 'short_answer') {
    return { graceSec: 30, bonusEndSec: 90, maxTrackedSec: 180 };
  }
  if (type === 'fill_blank') {
    return { graceSec: 20, bonusEndSec: 75, maxTrackedSec: 180 };
  }
  return { graceSec: 15, bonusEndSec: 60, maxTrackedSec: 180 };
}

/**
 * Clamps recorded elapsed time to realistic classroom bounds (0.5s .. maxTrackedSec).
 */
export function clampElapsedMs(
  elapsedMs: number,
  type: QuestionType = 'multiple_choice',
): number {
  const rule = getTimingRuleForQuestionType(type);
  return Math.max(500, Math.min(Math.round(elapsedMs || 0), rule.maxTrackedSec * 1000));
}

/**
 * Standard accuracy points = 100 (never penalized for slow thoughtful research).
 * Fair fast-response bonus = up to +50 based on question type's reading & research window.
 * Wrong answer = 0 points.
 */
export function calculatePoints(
  isCorrect: boolean,
  elapsedMs: number,
  questionType: QuestionType = 'multiple_choice',
): PointsBreakdown {
  if (!isCorrect) {
    return { basePoints: 0, speedBonus: 0, totalPoints: 0 };
  }
  const rule = getTimingRuleForQuestionType(questionType);
  const safeMs = clampElapsedMs(elapsedMs, questionType);
  const graceMs = rule.graceSec * 1000;
  const endMs = rule.bonusEndSec * 1000;
  const basePoints = 100;

  let speedBonus = 0;
  if (safeMs <= graceMs) {
    speedBonus = 50;
  } else if (safeMs <= endMs) {
    const ratio = 1 - (safeMs - graceMs) / (endMs - graceMs);
    speedBonus = Math.max(5, Math.round(ratio * 45) + 5);
    speedBonus = Math.min(49, speedBonus);
  }
  return {
    basePoints,
    speedBonus,
    totalPoints: basePoints + speedBonus,
  };
}

export function formatGroupId(tabletNumber: number, groupName: string): string {
  const pad = String(tabletNumber).padStart(2, '0');
  const cleanName = groupName.trim() || `Nhóm ${pad}`;
  return `Máy-${pad} · ${cleanName}`;
}

export function computeSkillLevelTitle(
  submissions: AnswerSubmission[],
  lang: Language = 'vi',
): { title: string; topDomainId: string } {
  if (submissions.length === 0) {
    return {
      title: lang === 'vi' ? 'Tân binh Công dân Số' : 'Digital Citizen Rookie',
      topDomainId: '1',
    };
  }

  const domainScores = new Map<string, { correct: number; total: number; points: number }>();
  for (const sub of submissions) {
    const compList =
      sub.competencyIds && sub.competencyIds.length > 0
        ? sub.competencyIds
        : [sub.competencyId];
    for (const cid of compList) {
      const domain = getDomainByCompetencyId(cid);
      const prev = domainScores.get(domain.id) ?? { correct: 0, total: 0, points: 0 };
      domainScores.set(domain.id, {
        correct: prev.correct + (sub.isCorrect ? 1 : 0),
        total: prev.total + 1,
        points: prev.points + sub.totalPoints,
      });
    }
  }

  const totalCorrect = submissions.filter((s) => s.isCorrect).length;
  const accuracy = totalCorrect / submissions.length;
  const avgMs =
    submissions.reduce((acc, s) => acc + s.elapsedMs, 0) / submissions.length;

  let bestDomainId = '1';
  let bestMetric = -1;
  for (const [domainId, stats] of domainScores.entries()) {
    const metric = stats.points + stats.correct * 20;
    if (metric > bestMetric) {
      bestMetric = metric;
      bestDomainId = domainId;
    }
  }

  if (domainScores.size >= 4 && accuracy >= 0.85 && avgMs <= 20000) {
    return {
      title: lang === 'vi' ? 'Công dân Số Toàn năng' : 'All-Star Digital Citizen',
      topDomainId: bestDomainId,
    };
  }

  const domainInfo =
    COMPETENCY_DOMAINS.find((d) => d.id === bestDomainId) ?? COMPETENCY_DOMAINS[0];

  if (accuracy < 0.5) {
    return {
      title:
        lang === 'vi'
          ? `Nhà Khám phá ${domainInfo.nameVi}`
          : `${domainInfo.nameEn} Explorer`,
      topDomainId: bestDomainId,
    };
  }

  return {
    title: lang === 'vi' ? domainInfo.honorTitleVi : domainInfo.honorTitleEn,
    topDomainId: bestDomainId,
  };
}

export function buildLeaderboard(
  classId: string,
  submissions: AnswerSubmission[],
  lang: Language = 'vi',
  lessonId?: string,
): LeaderboardEntry[] {
  const classSubs = submissions.filter(
    (s) => s.classId === classId && (!lessonId || s.lessonId === lessonId),
  );
  // Deduplicate by (groupId, lessonId, questionId) so repeated rows can never double-count points
  const deduped = new Map<string, AnswerSubmission>();
  for (const sub of classSubs) {
    const key = `${sub.groupId}::${sub.lessonId}::${sub.questionId}`;
    deduped.set(key, sub);
  }
  const byGroup = new Map<string, AnswerSubmission[]>();

  for (const sub of deduped.values()) {
    const list = byGroup.get(sub.groupId) ?? [];
    list.push(sub);
    byGroup.set(sub.groupId, list);
  }

  const entries: Omit<LeaderboardEntry, 'Rank'>[] = [];
  for (const [groupId, subs] of byGroup.entries()) {
    const totalScore = subs.reduce((sum, s) => sum + s.totalPoints, 0);
    const correctCount = subs.filter((s) => s.isCorrect).length;
    const totalAnswered = subs.length;
    const accuracyPercent =
      totalAnswered > 0 ? Math.round((correctCount / totalAnswered) * 100) : 0;
    const avgElapsedMs =
      totalAnswered > 0
        ? Math.round(subs.reduce((sum, s) => sum + s.elapsedMs, 0) / totalAnswered)
        : 0;
    const skill = computeSkillLevelTitle(subs, lang);
    const latest = subs[subs.length - 1];

    entries.push({
      ClassID: classId,
      GroupID: groupId,
      tabletNumber: latest.tabletNumber,
      groupName: latest.groupName,
      Score: totalScore,
      SkillLevel: skill.title,
      correctCount,
      totalAnswered,
      accuracyPercent,
      avgElapsedMs,
      topDomainId: skill.topDomainId,
    });
  }

  entries.sort((a, b) => {
    if (b.Score !== a.Score) return b.Score - a.Score;
    if (b.accuracyPercent !== a.accuracyPercent) return b.accuracyPercent - a.accuracyPercent;
    return a.avgElapsedMs - b.avgElapsedMs;
  });

  return entries.map((entry, idx) => ({
    ...entry,
    Rank: idx + 1,
  }));
}

export interface CompetencyCoverageStat {
  competencyId: string;
  questionCount: number;
  attemptCount: number;
  correctCount: number;
  accuracyPercent: number | null;
}

export function buildCompetencyMatrix(
  lessons: Lesson[],
  submissions: AnswerSubmission[],
  classId?: string,
): CompetencyCoverageStat[] {
  const filteredSubs = classId
    ? submissions.filter((s) => s.classId === classId)
    : submissions;

  return COMPETENCIES_24.map((comp) => {
    const questionCount = lessons.reduce(
      (sum, lesson) =>
        sum +
        lesson.questions.filter((q) => {
          const list =
            q.competencyIds && q.competencyIds.length > 0
              ? q.competencyIds
              : [q.competencyId];
          return list.includes(comp.id);
        }).length,
      0,
    );
    const attempts = filteredSubs.filter((s) => {
      const list =
        s.competencyIds && s.competencyIds.length > 0
          ? s.competencyIds
          : [s.competencyId];
      return list.includes(comp.id);
    });
    const correctCount = attempts.filter((s) => s.isCorrect).length;
    const accuracyPercent =
      attempts.length > 0 ? Math.round((correctCount / attempts.length) * 100) : null;

    return {
      competencyId: comp.id,
      questionCount,
      attemptCount: attempts.length,
      correctCount,
      accuracyPercent,
    };
  });
}

export interface DomainHonorAward {
  domainId: string;
  domainName: string;
  honorTitle: string;
  groupId: string;
  domainScore: number;
  accuracyPercent: number;
  avgElapsedMs: number;
  skillTierLabel: string;
}

export function buildDomainChampions(
  classId: string,
  submissions: AnswerSubmission[],
  lang: Language = 'vi',
  lessonId?: string,
): DomainHonorAward[] {
  const classSubs = submissions.filter(
    (s) => s.classId === classId && (!lessonId || s.lessonId === lessonId),
  );
  const awards: DomainHonorAward[] = [];

  for (const domain of COMPETENCY_DOMAINS) {
    const byGroup = new Map<string, AnswerSubmission[]>();
    for (const sub of classSubs) {
      const compList =
        sub.competencyIds && sub.competencyIds.length > 0
          ? sub.competencyIds
          : [sub.competencyId];
      const touchesDomain = compList.some(
        (cid) => getDomainByCompetencyId(cid).id === domain.id,
      );
      if (touchesDomain) {
        const arr = byGroup.get(sub.groupId) ?? [];
        arr.push(sub);
        byGroup.set(sub.groupId, arr);
      }
    }

    let winner: DomainHonorAward | null = null;
    for (const [groupId, subs] of byGroup.entries()) {
      const domainScore = subs.reduce((sum, s) => sum + s.totalPoints, 0);
      const correct = subs.filter((s) => s.isCorrect).length;
      const accuracyPercent = Math.round((correct / subs.length) * 100);
      const avgElapsedMs = Math.round(
        subs.reduce((sum, s) => sum + s.elapsedMs, 0) / subs.length,
      );
      if (domainScore <= 0) continue;

      const skillTierLabel =
        accuracyPercent === 100 && avgElapsedMs <= 12000
          ? lang === 'vi'
            ? 'Cấp độ Chuyên gia Tốc độ'
            : 'Master Speed Tier'
          : accuracyPercent >= 80
            ? lang === 'vi'
              ? 'Cấp độ Thành thạo'
              : 'Proficient Tier'
            : lang === 'vi'
              ? 'Cấp độ Khám phá'
              : 'Explorer Tier';

      if (
        !winner ||
        domainScore > winner.domainScore ||
        (domainScore === winner.domainScore && avgElapsedMs < winner.avgElapsedMs)
      ) {
        winner = {
          domainId: domain.id,
          domainName: lang === 'vi' ? domain.nameVi : domain.nameEn,
          honorTitle: lang === 'vi' ? domain.honorTitleVi : domain.honorTitleEn,
          groupId,
          domainScore,
          accuracyPercent,
          avgElapsedMs,
          skillTierLabel,
        };
      }
    }

    if (winner) {
      awards.push(winner);
    }
  }

  return awards.sort((a, b) => b.domainScore - a.domainScore);
}
