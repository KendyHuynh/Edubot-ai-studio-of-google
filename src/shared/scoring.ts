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
  'khong',
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
  [
    'dau chan so',
    'digital footprint',
    'dau vet so',
    'lich su hoat dong mang',
  ],
  [
    'ma doc',
    'virus',
    'malware',
    'phan mem doc hai',
    'trojan',
    'ransomware',
  ],
  [
    'sao luu',
    'backup',
    'sao luu du lieu',
    'luu tru dam may',
  ],
  [
    'ma hoa',
    'encryption',
    'ma hoa du lieu',
    'https',
  ],
];

export type AnswerMatchTier =
  | 'exact'
  | 'synonym'
  | 'fuzzy_full'
  | 'fuzzy_partial'
  | 'none';

export interface AnswerEvaluation {
  isCorrect: boolean;
  /** 1.0 = full credit, 0.7..0.85 = partial credit for near-match/typos, 0 = wrong */
  creditFactor: number;
  /** 0..1 combined fuzzy similarity score */
  similarity: number;
  matchTier: AnswerMatchTier;
  matchedVariant?: string;
}

/**
 * Optimal String Alignment (Damerau-Levenshtein) distance.
 * Treats insertion, deletion, substitution, AND adjacent character transposition
 * (e.g. "bna quyen" -> "ban quyen", "passwrod" -> "password") as edit distance 1.
 */
export function damerauLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const lenA = a.length;
  const lenB = b.length;
  if (!lenA) return lenB;
  if (!lenB) return lenA;

  const dp: number[][] = Array.from({ length: lenA + 1 }, () =>
    new Array<number>(lenB + 1).fill(0),
  );
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + 1); // adjacent transposition
      }
      dp[i][j] = val;
    }
  }
  return dp[lenA][lenB];
}

function bigramDiceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) {
    return a === b ? 1 : 0;
  }
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  for (let j = 0; j < b.length - 1; j++) {
    const bg = b.slice(j, j + 2);
    const n = counts.get(bg) ?? 0;
    if (n > 0) {
      intersection++;
      counts.set(bg, n - 1);
    }
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

/**
 * Combined fuzzy string similarity (0..1) blending Damerau-Levenshtein similarity (65%)
 * and character bigram Sørensen–Dice similarity (35%).
 */
export function normalizedFuzzySimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  const dist = damerauLevenshteinDistance(a, b);
  const dlSim = Math.max(0, 1 - dist / maxLen);
  const diceSim = bigramDiceSimilarity(a, b);
  return Number((dlSim * 0.65 + diceSim * 0.35).toFixed(4));
}

function tokenEditMatchQuality(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) return 0;
  const dist = damerauLevenshteinDistance(a, b);
  if (dist <= 1) return 0.92;
  if (maxLen >= 7 && dist <= 2) return 0.8;
  return 0;
}

function matchSynonymGroupDetailed(
  foldedNormUser: string,
  foldedNormCorrect: string,
): { tier: 'synonym' | 'fuzzy_partial'; similarity: number; creditFactor: number } | null {
  let bestPartial: { tier: 'fuzzy_partial'; similarity: number; creditFactor: number } | null =
    null;

  for (const group of VIETNAMESE_SYNONYM_GROUPS) {
    const refInGroup = group.some(
      (phrase) =>
        foldedNormCorrect === phrase ||
        (phrase.length >= 4 && foldedNormCorrect.includes(phrase)),
    );
    if (!refInGroup) continue;

    for (const phrase of group) {
      if (phrase === foldedNormCorrect) continue;
      if (
        foldedNormUser === phrase ||
        (phrase.length >= 4 && foldedNormUser.includes(phrase))
      ) {
        return { tier: 'synonym', similarity: 0.96, creditFactor: 1 };
      }

      if (phrase.length >= 5 && Math.abs(foldedNormUser.length - phrase.length) <= 3) {
        const dist = damerauLevenshteinDistance(foldedNormUser, phrase);
        const sim = normalizedFuzzySimilarity(foldedNormUser, phrase);
        if (dist <= 1 || (phrase.length >= 8 && dist <= 2 && sim >= 0.84)) {
          return { tier: 'synonym', similarity: Math.max(0.88, sim), creditFactor: 1 };
        }
        if (sim >= 0.68 && dist <= Math.max(2, Math.floor(phrase.length * 0.32))) {
          const creditFactor = sim >= 0.78 ? 0.8 : 0.7;
          if (!bestPartial || sim > bestPartial.similarity) {
            bestPartial = { tier: 'fuzzy_partial', similarity: sim, creditFactor };
          }
        }
      }
    }
  }

  return bestPartial;
}

function evaluateSingleKeyVariant(
  userAnswer: string,
  correctVariant: string,
  type: QuestionType,
  options?: string[],
): AnswerEvaluation {
  const miss: AnswerEvaluation = {
    isCorrect: false,
    creditFactor: 0,
    similarity: 0,
    matchTier: 'none',
  };

  const normUser = normalizeAnswer(userAnswer);
  const normCorrect = normalizeAnswer(correctVariant);
  if (!normUser || !normCorrect) {
    return miss;
  }
  if (normUser === normCorrect) {
    return {
      isCorrect: true,
      creditFactor: 1,
      similarity: 1,
      matchTier: 'exact',
      matchedVariant: correctVariant,
    };
  }

  const foldedUser = stripVietnameseDiacritics(userAnswer);
  const foldedCorrect = stripVietnameseDiacritics(correctVariant);

  if (type === 'multiple_choice') {
    if (foldedUser && foldedUser === foldedCorrect) {
      return {
        isCorrect: true,
        creditFactor: 1,
        similarity: 1,
        matchTier: 'exact',
        matchedVariant: correctVariant,
      };
    }
    const letterIdx = OPTION_LETTERS.indexOf(normCorrect);
    if (letterIdx >= 0 && Array.isArray(options) && options[letterIdx]) {
      if (
        normUser === normalizeAnswer(options[letterIdx]) ||
        foldedUser === stripVietnameseDiacritics(options[letterIdx])
      ) {
        return {
          isCorrect: true,
          creditFactor: 1,
          similarity: 1,
          matchTier: 'exact',
          matchedVariant: correctVariant,
        };
      }
    }
    const strippedCorrect = normalizeAnswer(
      correctVariant.trim().replace(/^[A-Fa-f][.):\-\s]+/, ''),
    );
    if (
      strippedCorrect &&
      (normUser === strippedCorrect ||
        foldedUser === stripVietnameseDiacritics(strippedCorrect))
    ) {
      return {
        isCorrect: true,
        creditFactor: 1,
        similarity: 1,
        matchTier: 'exact',
        matchedVariant: correctVariant,
      };
    }
    const strippedUser = normalizeAnswer(
      userAnswer.trim().replace(/^[A-Fa-f][.):\-\s]+/, ''),
    );
    if (
      strippedUser &&
      (strippedUser === normCorrect ||
        stripVietnameseDiacritics(strippedUser) === foldedCorrect)
    ) {
      return {
        isCorrect: true,
        creditFactor: 1,
        similarity: 1,
        matchTier: 'exact',
        matchedVariant: correctVariant,
      };
    }
    return miss;
  }

  // Deterministic pre-keyed fuzzy grading for fill_blank & short_answer (ZERO AI needed)
  if (type === 'fill_blank' || type === 'short_answer') {
    // Check negation polarity FIRST so opposite meanings never receive full or partial credit
    const exactRefTokens = normCorrect.split(' ').filter((t) => t.length > 1);
    const exactUserTokens = normUser.split(' ').filter((t) => t.length > 1);
    const refHasNeg = exactRefTokens.some((t) => STRICT_NEGATION_TOKENS.has(t));
    const userHasNeg = exactUserTokens.some((t) => STRICT_NEGATION_TOKENS.has(t));
    if (refHasNeg !== userHasNeg) {
      return miss;
    }

    const numUser = normalizeNumberWords(foldedUser);
    const numCorrect = normalizeNumberWords(foldedCorrect);

    // 1. Exact, diacritic-insensitive, or number-word equivalent ("hai bước" == "2 bước")
    if (foldedUser === foldedCorrect || numUser === numCorrect) {
      return {
        isCorrect: true,
        creditFactor: 1,
        similarity: 1,
        matchTier: 'exact',
        matchedVariant: correctVariant,
      };
    }

    // 2. Substring match when student writes a complete sentence containing the exact key phrase
    if (
      numCorrect.length >= 3 &&
      (normUser.includes(normCorrect) ||
        foldedUser.includes(foldedCorrect) ||
        numUser.includes(numCorrect))
    ) {
      return {
        isCorrect: true,
        creditFactor: 1,
        similarity: 1,
        matchTier: 'exact',
        matchedVariant: correctVariant,
      };
    }

    // 3. Curated synonym / near-meaning equivalence (exact synonym = 100%, typo'd synonym = partial)
    const synMatch = matchSynonymGroupDetailed(numUser, numCorrect);
    if (synMatch && synMatch.creditFactor >= 1) {
      return {
        isCorrect: true,
        creditFactor: 1,
        similarity: synMatch.similarity,
        matchTier: 'synonym',
        matchedVariant: correctVariant,
      };
    }

    const maxLen = Math.max(numUser.length, numCorrect.length);
    const wholeDist = damerauLevenshteinDistance(numUser, numCorrect);
    const wholeSim = normalizedFuzzySimilarity(numUser, numCorrect);

    // 4. Whole-phrase fuzzy spelling check (fill_blank):
    //    Minor typo / adjacent transposition -> Full credit (100%)
    if (type === 'fill_blank' && numCorrect.length >= 4) {
      const fullAllowedEdits =
        numCorrect.length >= 8 ? 2 : 1;
      if (
        wholeDist <= fullAllowedEdits &&
        (wholeDist <= 1 || wholeSim >= 0.84) &&
        Math.abs(numUser.length - numCorrect.length) <= 2
      ) {
        return {
          isCorrect: true,
          creditFactor: 1,
          similarity: Math.max(0.86, wholeSim),
          matchTier: 'fuzzy_full',
          matchedVariant: correctVariant,
        };
      }
    }

    // 5. Token-level fuzzy overlap (excluding filler stopwords)
    const refCore = numCorrect
      .split(' ')
      .filter((t) => t.length >= 1 && !STOPWORDS.has(t) && (t.length > 1 || /^\d+$/.test(t)));
    const userCore = numUser
      .split(' ')
      .filter((t) => t.length >= 1 && !STOPWORDS.has(t) && (t.length > 1 || /^\d+$/.test(t)));

    let tokenWeightedSum = 0;
    let tokenMatchedCount = 0;
    for (const rt of refCore) {
      let bestQ = 0;
      for (const ut of userCore) {
        const q = tokenEditMatchQuality(ut, rt);
        if (q > bestQ) bestQ = q;
      }
      if (bestQ > 0) {
        tokenMatchedCount += 1;
        tokenWeightedSum += bestQ;
      }
    }
    const tokenRatio = refCore.length > 0 ? tokenMatchedCount / refCore.length : 0;
    const tokenQualityAvg = refCore.length > 0 ? tokenWeightedSum / refCore.length : 0;

    if (refCore.length === 1 && tokenMatchedCount === 1) {
      return {
        isCorrect: true,
        creditFactor: tokenQualityAvg >= 0.9 ? 1 : 0.75,
        similarity: Math.max(wholeSim, tokenQualityAvg),
        matchTier: tokenQualityAvg >= 0.9 ? 'fuzzy_full' : 'fuzzy_partial',
        matchedVariant: correctVariant,
      };
    }

    if (refCore.length >= 2) {
      if (type === 'short_answer') {
        if (tokenRatio >= 0.55 || (refCore.length >= 5 && tokenMatchedCount >= 3 && tokenRatio >= 0.4)) {
          return {
            isCorrect: true,
            creditFactor: 1,
            similarity: Math.max(wholeSim, tokenQualityAvg),
            matchTier: tokenRatio >= 0.8 ? 'fuzzy_full' : 'fuzzy_partial',
            matchedVariant: correctVariant,
          };
        }
      } else {
        // fill_blank multi-word token scoring:
        // >= 75% core tokens matched cleanly -> Full credit
        if (tokenRatio >= 0.75 && tokenQualityAvg >= 0.7) {
          return {
            isCorrect: true,
            creditFactor: 1,
            similarity: Math.max(wholeSim, tokenQualityAvg),
            matchTier: 'fuzzy_full',
            matchedVariant: correctVariant,
          };
        }
      }
    }

    // 6. Partial-credit tier for fill_blank (noticeable typos, fuzzy synonyms, or partial core phrase)
    if (type === 'fill_blank') {
      const candidates: AnswerEvaluation[] = [];

      if (synMatch) {
        candidates.push({
          isCorrect: true,
          creditFactor: synMatch.creditFactor,
          similarity: synMatch.similarity,
          matchTier: 'fuzzy_partial',
          matchedVariant: correctVariant,
        });
      }

      // Noticeable whole-phrase spelling variations (e.g. "xac thc 2 boc" vs "xac thuc 2 buoc")
      const minAcceptableUserLen = numCorrect.length <= 4 ? 3 : 4;
      const maxPartialEdits = Math.max(2, Math.floor(maxLen * 0.35));
      if (
        numCorrect.length >= 5 &&
        numUser.length >= minAcceptableUserLen &&
        wholeSim >= 0.65 &&
        wholeDist <= maxPartialEdits
      ) {
        candidates.push({
          isCorrect: true,
          creditFactor: wholeSim >= 0.78 ? 0.8 : 0.7,
          similarity: wholeSim,
          matchTier: 'fuzzy_partial',
          matchedVariant: correctVariant,
        });
      }

      // Partial core-keyword coverage (e.g. "mật khẩu" for "mật khẩu mạnh", or 2/3 key words)
      if (refCore.length >= 2 && tokenRatio >= 0.5) {
        candidates.push({
          isCorrect: true,
          creditFactor: tokenRatio >= 0.65 ? 0.8 : 0.7,
          similarity: Math.max(wholeSim, Number(tokenQualityAvg.toFixed(4))),
          matchTier: 'fuzzy_partial',
          matchedVariant: correctVariant,
        });
      }

      if (candidates.length > 0) {
        candidates.sort((a, b) =>
          b.creditFactor !== a.creditFactor
            ? b.creditFactor - a.creditFactor
            : b.similarity - a.similarity,
        );
        return candidates[0];
      }
    }

    return {
      ...miss,
      similarity: wholeSim,
    };
  }

  return miss;
}

const TF_STATEMENT_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

/**
 * Parses a single True/False token in Vietnamese or English ("Đúng"/"Sai", "True"/"False", "Đ"/"S").
 */
export function parseTrueFalseToken(raw: string): boolean | null {
  const folded = stripVietnameseDiacritics(raw).replace(/^[a-f][.):\-\s]+/, '').trim();
  if (!folded) return null;
  if (
    folded === 'dung' ||
    folded === 'true' ||
    folded === 't' ||
    folded === 'd' ||
    folded === 'yes' ||
    folded === '1' ||
    folded === 'chinh xac' ||
    folded.startsWith('dung ')
  ) {
    return true;
  }
  if (
    folded === 'sai' ||
    folded === 'false' ||
    folded === 'f' ||
    folded === 's' ||
    folded === 'no' ||
    folded === '0' ||
    folded === 'khong dung' ||
    folded.startsWith('sai ')
  ) {
    return false;
  }
  return null;
}

/**
 * Parses a multi-statement True/False answer string such as:
 * "a:Đúng | b:Sai | c:Đúng | d:Sai" or "Đúng | Sai | Đúng | Sai" or "D, S, D, S".
 */
export function parseTrueFalseMultiAnswer(
  raw: string,
  expectedCount?: number,
): Array<boolean | null> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return expectedCount ? new Array<boolean | null>(expectedCount).fill(null) : [];
  }

  const rawParts = trimmed
    .split(/[|;\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const count = expectedCount && expectedCount > 0 ? expectedCount : rawParts.length;
  const result: Array<boolean | null> = new Array<boolean | null>(count).fill(null);

  let sequentialIdx = 0;
  for (const part of rawParts) {
    const labeled = part.match(/^([a-fA-F])\s*[:.)\-]\s*(.+)$/);
    if (labeled) {
      const idx = TF_STATEMENT_LETTERS.indexOf(labeled[1].toLowerCase());
      const val = parseTrueFalseToken(labeled[2]);
      if (idx >= 0 && idx < result.length) {
        result[idx] = val;
        continue;
      }
    }
    if (sequentialIdx < result.length) {
      result[sequentialIdx] = parseTrueFalseToken(part);
      sequentialIdx += 1;
    }
  }

  return result;
}

/**
 * Formats an array of statement booleans into canonical readable key/answer format:
 * "a:Đúng | b:Sai | c:Đúng | d:Sai"
 */
export function formatTrueFalseMultiAnswer(values: Array<boolean | null>): string {
  return values
    .map((val, idx) => {
      const letter = TF_STATEMENT_LETTERS[idx] ?? String(idx + 1);
      const label = val === true ? 'Đúng' : val === false ? 'Sai' : '?';
      return `${letter}:${label}`;
    })
    .join(' | ');
}

/**
 * Evaluates a student's answer against stored teacher/AI answer keys (supporting `|`-separated variants),
 * returning full credit (1.0), partial credit (for fuzzy fill_blank OR multi-statement true_false_multi), or 0.
 */
export function evaluateAnswerMatch(
  userAnswer: string,
  correctAnswer: string,
  type: QuestionType,
  options?: string[],
): AnswerEvaluation {
  if (!userAnswer?.trim() || !correctAnswer?.trim()) {
    return { isCorrect: false, creditFactor: 0, similarity: 0, matchTier: 'none' };
  }
  if (type === 'true_false') {
    const userBool = parseTrueFalseToken(userAnswer);
    const keyBool = parseTrueFalseToken(correctAnswer);
    if (userBool !== null && keyBool !== null) {
      const ok = userBool === keyBool;
      return {
        isCorrect: ok,
        creditFactor: ok ? 1 : 0,
        similarity: ok ? 1 : 0,
        matchTier: ok ? 'exact' : 'none',
        matchedVariant: ok ? (keyBool ? 'Đúng' : 'Sai') : undefined,
      };
    }
    return evaluateSingleKeyVariant(userAnswer, correctAnswer, 'multiple_choice', ['Đúng', 'Sai']);
  }
  if (type === 'true_false_multi') {
    const expectedCount = Array.isArray(options) && options.length > 0 ? options.length : undefined;
    const keyVals = parseTrueFalseMultiAnswer(correctAnswer, expectedCount);
    const total = keyVals.filter((v) => v !== null).length;
    if (total === 0) {
      return { isCorrect: false, creditFactor: 0, similarity: 0, matchTier: 'none' };
    }
    const userVals = parseTrueFalseMultiAnswer(userAnswer, keyVals.length);
    let matched = 0;
    for (let i = 0; i < keyVals.length; i++) {
      if (keyVals[i] !== null && userVals[i] === keyVals[i]) {
        matched += 1;
      }
    }
    const ratio = Number((matched / total).toFixed(4));
    const fractionLabel = `${matched}/${total}`;
    if (matched === total) {
      return {
        isCorrect: true,
        creditFactor: 1,
        similarity: 1,
        matchTier: 'exact',
        matchedVariant: fractionLabel,
      };
    }
    if (matched > 0) {
      return {
        isCorrect: true,
        creditFactor: Number((matched / total).toFixed(2)),
        similarity: ratio,
        matchTier: 'fuzzy_partial',
        matchedVariant: fractionLabel,
      };
    }
    return {
      isCorrect: false,
      creditFactor: 0,
      similarity: 0,
      matchTier: 'none',
      matchedVariant: fractionLabel,
    };
  }
  if (type === 'multiple_choice') {
    return evaluateSingleKeyVariant(userAnswer, correctAnswer, type, options);
  }
  const variants = correctAnswer
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean);

  let best: AnswerEvaluation = {
    isCorrect: false,
    creditFactor: 0,
    similarity: 0,
    matchTier: 'none',
  };

  for (const variant of variants) {
    const res = evaluateSingleKeyVariant(userAnswer, variant, type, options);
    if (res.creditFactor === 1 && res.matchTier === 'exact') {
      return res;
    }
    if (
      res.creditFactor > best.creditFactor ||
      (res.creditFactor === best.creditFactor && res.similarity > best.similarity)
    ) {
      best = res;
    }
  }
  return best;
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
  return evaluateAnswerMatch(userAnswer, correctAnswer, type, options).isCorrect;
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
  if (type === 'true_false_multi') {
    return { graceSec: 25, bonusEndSec: 85, maxTrackedSec: 180 };
  }
  if (type === 'fill_blank') {
    return { graceSec: 20, bonusEndSec: 75, maxTrackedSec: 180 };
  }
  if (type === 'true_false') {
    return { graceSec: 12, bonusEndSec: 45, maxTrackedSec: 180 };
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
 * Standard accuracy points = 100 (scaled by creditFactor for fuzzy partial credit, e.g. 70-80 pts).
 * Fair fast-response bonus = up to +50 based on question type's reading & research window (also scaled).
 * Wrong answer = 0 points.
 */
export function calculatePoints(
  isCorrect: boolean,
  elapsedMs: number,
  questionType: QuestionType = 'multiple_choice',
  creditFactor = 1,
): PointsBreakdown {
  const clampedCredit = Math.max(0, Math.min(1, creditFactor));
  if (!isCorrect || clampedCredit <= 0) {
    return { basePoints: 0, speedBonus: 0, totalPoints: 0 };
  }
  const rule = getTimingRuleForQuestionType(questionType);
  const safeMs = clampElapsedMs(elapsedMs, questionType);
  const graceMs = rule.graceSec * 1000;
  const endMs = rule.bonusEndSec * 1000;
  const basePoints = Math.round(100 * clampedCredit);

  let rawSpeedBonus = 0;
  if (safeMs <= graceMs) {
    rawSpeedBonus = 50;
  } else if (safeMs <= endMs) {
    const ratio = 1 - (safeMs - graceMs) / (endMs - graceMs);
    rawSpeedBonus = Math.max(5, Math.round(ratio * 45) + 5);
    rawSpeedBonus = Math.min(49, rawSpeedBonus);
  }
  const speedBonus = Math.round(rawSpeedBonus * clampedCredit);
  return {
    basePoints,
    speedBonus,
    totalPoints: basePoints + speedBonus,
  };
}

/**
 * Builds encouraging, transparent feedback messages distinguishing exact matches,
 * synonym / minor-typo full credit, and fuzzy partial credit.
 */
export function buildGradingFeedback(
  groupName: string,
  evaluation: AnswerEvaluation,
  breakdown: PointsBreakdown,
  lang: Language = 'vi',
): string {
  const isMultiTfFraction = Boolean(
    evaluation.matchedVariant && /^\d+\/\d+$/.test(evaluation.matchedVariant),
  );

  if (!evaluation.isCorrect || breakdown.totalPoints <= 0) {
    if (isMultiTfFraction) {
      return lang === 'en'
        ? `0 correct statements (${evaluation.matchedVariant}), ${groupName}. Review the Digital Citizen explanation below!`
        : `Chưa chính xác (${evaluation.matchedVariant} nhận định Đúng/Sai)! Nhóm ${groupName} xem giải thích bên dưới để rút kinh nghiệm nhé!`;
    }
    return lang === 'en'
      ? `Nice try, ${groupName}! Check the Digital Citizen tip below and keep going!`
      : `Suýt đúng rồi ${groupName} ơi! Xem bí kíp Công dân số bên dưới để ghi điểm câu sau nhé!`;
  }

  if (isMultiTfFraction) {
    const pct = Math.round(evaluation.creditFactor * 100);
    if (evaluation.creditFactor >= 1) {
      return lang === 'en'
        ? `Outstanding, ${groupName}! Evaluated all ${evaluation.matchedVariant} True/False statements accurately (+${breakdown.totalPoints} pts)!`
        : `Xuất sắc ${groupName}! Đánh giá chuẩn xác toàn bộ ${evaluation.matchedVariant} nhận định Đúng/Sai (+${breakdown.totalPoints} điểm)!`;
    }
    return lang === 'en'
      ? `Good job, ${groupName}! Evaluated ${evaluation.matchedVariant} True/False statements correctly — awarded ${pct}% credit (+${breakdown.totalPoints} pts).`
      : `Tốt lắm ${groupName}! Đánh giá đúng ${evaluation.matchedVariant} nhận định Đúng/Sai — nhận ${pct}% điểm (+${breakdown.totalPoints} điểm).`;
  }

  if (evaluation.matchTier === 'fuzzy_partial') {
    const pct = Math.round(evaluation.creditFactor * 100);
    return lang === 'en'
      ? `Close match, ${groupName}! Awarded ${pct}% partial credit (+${breakdown.totalPoints} pts) so minor input slips don't hold you back.`
      : `Gần đúng rồi ${groupName} ơi! Hệ thống ghi nhận ${pct}% điểm khuyến khích (+${breakdown.totalPoints} điểm) cho đáp án gần khớp / hơi sai chính tả.`;
  }

  if (evaluation.matchTier === 'synonym') {
    return lang === 'en'
      ? `Great synonym, ${groupName}! Full credit +${breakdown.totalPoints} pts${breakdown.speedBonus > 0 ? ` (+${breakdown.speedBonus} speed)` : ''}!`
      : `Tuyệt vời ${groupName}! Hệ thống nhận diện từ đồng nghĩa và tặng trọn +${breakdown.totalPoints} điểm!`;
  }

  if (evaluation.matchTier === 'fuzzy_full') {
    return lang === 'en'
      ? `Correct, ${groupName}! Minor spelling variation accepted for full credit (+${breakdown.totalPoints} pts)!`
      : `Chính xác ${groupName}! Lỗi gõ nhẹ được bỏ qua — nhận trọn +${breakdown.totalPoints} điểm!`;
  }

  if (lang === 'en') {
    return breakdown.speedBonus >= 35
      ? `Lightning fast, ${groupName}! +${breakdown.totalPoints} pts (including +${breakdown.speedBonus} speed bonus)!`
      : `Spot on, ${groupName}! +${breakdown.totalPoints} pts!`;
  }

  return breakdown.speedBonus >= 35
    ? `Quá nhanh quá nguy hiểm! Nhóm ${groupName} ghi ngay +${breakdown.totalPoints} điểm (gồm +${breakdown.speedBonus} điểm tốc độ)!`
    : `Chính xác tuyệt đối! Chúc mừng nhóm ${groupName} nhận +${breakdown.totalPoints} điểm!`;
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
