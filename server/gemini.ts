import { GoogleGenAI, Type } from '@google/genai';
import { COMPETENCIES_24 } from '../src/shared/competencies';
import { Language, Question } from '../src/shared/types';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export interface GeneratedLessonPayload {
  title: string;
  topic: string;
  summary: string;
  questions: Question[];
}

export type QuestionStylePreset = 'multiple_choice_only' | 'mc_and_blank' | 'mixed';

export async function generateLessonQuestions(params: {
  title?: string;
  sourceFileName: string;
  textContent?: string;
  base64Data?: string;
  mimeType?: string;
  questionCount: number;
  questionStyle?: QuestionStylePreset;
  language: Language;
}): Promise<GeneratedLessonPayload> {
  const ai = getGeminiClient();
  const competencyCatalog = COMPETENCIES_24.map(
    (c) => `${c.id}: ${params.language === 'vi' ? c.nameVi : c.nameEn}`,
  ).join('\n');

  const count = Math.max(3, Math.min(params.questionCount || 15, 25));
  const langLabel = params.language === 'vi' ? 'Tiếng Việt' : 'English';
  const style: QuestionStylePreset = params.questionStyle ?? 'multiple_choice_only';

  const styleInstruction =
    style === 'multiple_choice_only'
      ? `2. TẤT CẢ ${count} câu hỏi đều thuộc dạng "multiple_choice" (có đúng 4 đáp án ngắn gọn rõ ràng trong options, và correctAnswer PHẢI trùng khớp chính xác từng ký tự với đúng 1 phần tử trong options) để hệ thống chấm tự động chính xác 100% mà KHÔNG cần AI chấm lại.`
      : style === 'mc_and_blank'
        ? `2. Kết hợp khoảng 80% "multiple_choice" (4 đáp án rõ ràng, correctAnswer trùng khớp từng ký tự với 1 phần tử trong options) và 20% "fill_blank" (1 chỗ trống ______ với correctAnswer là cụm 1-3 từ ngắn gọn, có thể kèm 1-2 cách viết đồng nghĩa ngăn cách bằng dấu " | " để chấm tự động không cần AI). Không dùng "short_answer".`
        : `2. Kết hợp đa dạng dạng câu hỏi: "multiple_choice" (4 đáp án rõ ràng, correctAnswer trùng khớp 1 phần tử trong options), "fill_blank" (1 chỗ trống ______ với correctAnswer ngắn 1-3 từ, có thể kèm biến thể cách nhau bằng " | "), và "short_answer" (ghi correctAnswer ngắn gọn gồm các từ khóa cốt lõi và 1-2 biến thể ngăn cách bằng " | " để hệ thống chấm trực tiếp theo đáp án có sẵn mà KHÔNG cần AI chấm).`;

  const systemInstruction = `Bạn là "EduBot Digital Citizen" - Trợ lý AI giáo dục chuyên về khung 24 Năng lực Công dân số (TT 02/2025).
Nhiệm vụ của bạn: Đọc kỹ nội dung bài học giáo viên cung cấp và tạo ra ĐÚNG ${count} câu hỏi trò chơi tương tác (không ít hơn ${count} câu, tương tự Quizizz/Kahoot) bằng ${langLabel}, phù hợp với học sinh phổ thông.

QUY TẮC BẮT BUỘC:
1. Mỗi câu hỏi phải ánh xạ vào 1 hoặc nhiều mã năng lực thành phần (1 đến 2 mã phù hợp nhất) trong số 24 mã dưới đây (chỉ ghi mã số như "1.1", "4.2", "6.2"):
${competencyCatalog}
${styleInstruction}
3. Mỗi câu hỏi PHẢI có "aiSearchKeywordHint": gợi ý từ khóa cụ thể để học sinh tự đi tra cứu trên Google hoặc AI khác trước khi chọn đáp án cuối cùng.
4. Mỗi câu hỏi PHẢI có "explanation": giải thích ngắn gọn, dễ hiểu, gắn với tiêu chuẩn Công dân số.
5. Đáp án đúng ("correctAnswer") BẮT BUỘC phải đầy đủ, rõ ràng, không bao giờ để trống vì hệ thống lưu cố định đáp án này để chấm điểm trực tiếp không dùng AI.`;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  if (params.base64Data && params.mimeType) {
    parts.push({
      inlineData: {
        mimeType: params.mimeType,
        data: params.base64Data,
      },
    });
  }

  const promptText = `Tài liệu bài học: "${params.sourceFileName}"
Tiêu đề gợi ý: "${params.title || params.sourceFileName}"
${params.textContent ? `\nNội dung bài học:\n${params.textContent.slice(0, 24000)}` : '\nHãy phân tích tệp đính kèm ở trên và tạo câu hỏi.'}

Hãy trích xuất chủ đề chính, viết tóm tắt 1-2 câu và tạo ${count} câu hỏi Công dân số kèm đáp án chuẩn sẵn sàng chấm tự động theo đúng JSON schema.`;

  parts.push({ text: promptText });

  const allowedTypes =
    style === 'multiple_choice_only'
      ? ['multiple_choice']
      : style === 'mc_and_blank'
        ? ['multiple_choice', 'fill_blank']
        : ['multiple_choice', 'fill_blank', 'short_answer'];

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: { parts },
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          topic: { type: Type.STRING },
          summary: { type: Type.STRING },
          questions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                type: {
                  type: Type.STRING,
                  enum: allowedTypes,
                },
                questionText: { type: Type.STRING },
                options: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                aiSearchKeywordHint: { type: Type.STRING },
                correctAnswer: { type: Type.STRING },
                competencyIds: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                explanation: { type: Type.STRING },
              },
              required: [
                'type',
                'questionText',
                'aiSearchKeywordHint',
                'correctAnswer',
                'competencyIds',
                'explanation',
              ],
            },
          },
        },
        required: ['title', 'topic', 'summary', 'questions'],
      },
    },
  });

  const rawText = (response.text ?? '{}').trim();
  const parsed = JSON.parse(rawText) as {
    title: string;
    topic: string;
    summary: string;
    questions: Array<Omit<Question, 'id' | 'competencyId'> & { competencyId?: string }>;
  };

  const validIds = new Set(COMPETENCIES_24.map((c) => c.id));
  const letters = ['a', 'b', 'c', 'd', 'e', 'f'];

  const questions: Question[] = (parsed.questions ?? []).map((q, index) => {
    const rawList = q.competencyIds?.length
      ? q.competencyIds
      : q.competencyId
        ? [q.competencyId]
        : ['1.1'];
    const filteredIds = Array.from(new Set(rawList.filter((id) => validIds.has(id))));
    const safeCompIds = filteredIds.length > 0 ? filteredIds : ['1.1'];
    const safeType =
      style === 'multiple_choice_only'
        ? 'multiple_choice'
        : q.type === 'fill_blank' || (q.type === 'short_answer' && style === 'mixed')
          ? q.type
          : 'multiple_choice';

    let options: string[] | undefined;
    let resolvedAnswer = String(q.correctAnswer ?? '').trim();

    if (safeType === 'multiple_choice') {
      const cleanedOpts = (q.options ?? []).map((o) => String(o).trim()).filter(Boolean);
      options =
        cleanedOpts.length >= 2 ? cleanedOpts : [resolvedAnswer || 'Đúng', 'Sai'];
      // Ensure correctAnswer matches one of the options verbatim for 100% deterministic grading
      if (!options.includes(resolvedAnswer)) {
        const letterIdx = letters.indexOf(resolvedAnswer.toLowerCase());
        if (letterIdx >= 0 && options[letterIdx]) {
          resolvedAnswer = options[letterIdx];
        } else {
          const stripped = resolvedAnswer.replace(/^[A-Fa-f][.):\-\s]+/, '').trim();
          const matchedOpt = options.find(
            (o) =>
              o.toLowerCase() === resolvedAnswer.toLowerCase() ||
              o.toLowerCase() === stripped.toLowerCase(),
          );
          resolvedAnswer = matchedOpt ?? options[0];
        }
      }
    }

    return {
      id: `q-${Date.now()}-${index + 1}`,
      type: safeType,
      questionText: String(q.questionText ?? '').trim(),
      options,
      aiSearchKeywordHint: String(q.aiSearchKeywordHint ?? '').trim() || 'công dân số TT 02/2025',
      correctAnswer: resolvedAnswer,
      competencyId: safeCompIds[0],
      competencyIds: safeCompIds,
      explanation: String(q.explanation ?? '').trim(),
    };
  });

  return {
    title: params.title?.trim() || parsed.title || params.sourceFileName,
    topic: parsed.topic || 'Công dân số (TT 02/2025)',
    summary: parsed.summary || '',
    questions,
  };
}

