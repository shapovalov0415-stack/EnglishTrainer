import type {
  TranscriptionResult,
  PhraseExtractionResult,
  ChatMessage,
  RoleplayFeedback,
  ExtensionFeedback,
  PastPerformance,
} from '../types/ai';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AIConfig {
  openaiApiKey: string;
  apiBaseUrl: string;
}

interface ClaudeRequest {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
}

async function callClaudeViaBackend(
  config: AIConfig,
  request: ClaudeRequest,
): Promise<string> {
  const baseUrl =
    config.apiBaseUrl ||
    process.env.EXPO_PUBLIC_API_BASE_URL ||
    'http://192.168.1.133:3000';

  const response = await fetch(`${baseUrl}/chat/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Backend API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const text = data.text as string | undefined;
  if (!text) {
    throw new Error('Backend API returned empty content');
  }

  return text;
}

// ---------------------------------------------------------------------------
// Whisper: 音声ファイル → 文字起こし
// ---------------------------------------------------------------------------

/**
 * サーバー経由で Whisper API を使い音声ファイルを文字起こしする。
 *
 * @param audioUri  ローカルの音声ファイルパス (file://...)
 * @param config    API キー設定（apiBaseUrl のみ使用）
 * @returns         文字起こし結果（セグメント付き）
 */
export async function transcribeAudio(
  audioUri: string,
  config: AIConfig,
): Promise<TranscriptionResult> {
  const baseUrl =
    config.apiBaseUrl || process.env.EXPO_PUBLIC_API_BASE_URL || 'http://192.168.1.133:3000';
  const url = `${baseUrl}/transcribe-file`;

  const formData = new FormData();
  formData.append('file', {
    uri: audioUri,
    type: 'audio/m4a',
    name: 'audio.m4a',
  } as unknown as Blob);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      body: formData,
    });
  } catch (e) {
    throw new Error(
      `サーバーに接続できません (${url}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Whisper API error (${response.status}): ${error}`);
  }

  const data = await response.json();

  return {
    text: data.text,
    language: data.language,
    duration: data.duration,
    segments: (data.segments ?? []).map((seg: Record<string, unknown>) => ({
      id: seg.id,
      start: seg.start,
      end: seg.end,
      text: (seg.text as string).trim(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Claude: 文字起こし → 学習フレーズ抽出 (JSON)
// ---------------------------------------------------------------------------

const PHRASE_EXTRACTION_PROMPT = `You are an expert English language tutor. Analyze the following transcript from a short video and extract key phrases that are most useful for an English learner.

Return your response as a JSON object with this exact structure:
{
  "summary": "A brief 1-2 sentence summary of the video content in Japanese",
  "phrases": [
    {
      "phrase": "the exact English phrase from the transcript",
      "translation": "natural Japanese translation",
      "context": "brief explanation of when/how this phrase is used, in Japanese",
      "difficulty": "beginner | intermediate | advanced",
      "notes": "pronunciation tips or grammar notes in Japanese"
    }
  ]
}

Rules:
- Extract 5-10 of the most useful, natural phrases
- Prioritize conversational phrases over formal ones
- Include idiomatic expressions if present
- Sort by order of appearance in the transcript
- All explanations (translation, context, notes) should be in Japanese
- Return ONLY the JSON object, no markdown fences or extra text`;

/**
 * Claude API で文字起こしテキストから学習フレーズを抽出する。
 *
 * @param transcript  Whisper で得た文字起こしテキスト
 * @param config      API キー設定
 * @returns           抽出されたフレーズ一覧
 */
export async function extractPhrases(
  transcript: string,
  config: AIConfig,
): Promise<PhraseExtractionResult> {
  const content = await callClaudeViaBackend(config, {
    maxTokens: 2048,
    messages: [
      {
        role: 'user',
        content: `${PHRASE_EXTRACTION_PROMPT}\n\n--- TRANSCRIPT ---\n${transcript}`,
      },
    ],
  });

  const parsed = JSON.parse(content) as PhraseExtractionResult;

  // バリデーション: 必須フィールドの存在チェック
  if (!parsed.summary || !Array.isArray(parsed.phrases)) {
    throw new Error('Claude API returned invalid phrase structure');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Roleplay: Claude が動画の相手役として対話
// ---------------------------------------------------------------------------

/**
 * ロールプレイ用のシステムプロンプトを構築する。
 * 動画の文脈・学習フレーズを組み込み、相手役として自然に振る舞わせる。
 */
export function buildRoleplaySystemPrompt(
  summary: string,
  phrases: { phrase: string; context: string }[],
): string {
  const phraseList = phrases
    .map((p, i) => `${i + 1}. "${p.phrase}" — ${p.context}`)
    .join('\n');

  return `You are a friendly, natural English conversation partner. You are role-playing as the other person in a conversation based on a video the user has been studying.

## Video Context
${summary}

## Key Phrases the User Is Practicing
${phraseList}

## Your Role
- Act as the other person in the conversation naturally, as if you are in the scenario described above.
- Keep your responses concise (1-3 sentences) and conversational.
- Naturally create opportunities for the user to use the key phrases listed above.
- If the user makes a grammar or expression mistake, do NOT correct them mid-conversation — stay in character.
- Respond ONLY in English. Keep the conversation flowing naturally.
- Match the user's energy and pace.`;
}

/**
 * Claude とロールプレイ会話を行う（1ターン）。
 *
 * @param systemPrompt  buildRoleplaySystemPrompt で作ったプロンプト
 * @param messages      これまでの会話履歴
 * @param config        API キー設定
 * @returns             AI の応答テキスト
 */
export async function sendRoleplayMessage(
  systemPrompt: string,
  messages: ChatMessage[],
  config: AIConfig,
): Promise<string> {
  const apiMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  return callClaudeViaBackend(config, {
    system: systemPrompt,
    maxTokens: 512,
    messages: apiMessages,
  });
}

// ---------------------------------------------------------------------------
// Feedback: ロールプレイ終了後のフィードバック生成
// ---------------------------------------------------------------------------

const FEEDBACK_PROMPT = `You are an expert English tutor reviewing a roleplay conversation between a student and an AI partner.

Analyze the student's messages and provide structured feedback as a JSON object:
{
  "goodPoints": ["specific things the student did well, in Japanese, 2-3 items"],
  "improvements": ["specific areas to improve with examples, in Japanese, 2-3 items"],
  "expressionsUsed": ["key phrases the student successfully used from the target list"],
  "overallComment": "encouraging overall summary in Japanese, 2-3 sentences",
  "score": 75
}

Rules:
- Score from 0-100 based on naturalness, grammar, and use of target phrases
- Be encouraging but honest
- All feedback text (goodPoints, improvements, overallComment) MUST be in Japanese
- expressionsUsed should list the English phrases as-is
- Return ONLY the JSON object, no markdown fences`;

/**
 * ロールプレイ会話のフィードバックを生成する。
 */
export async function generateRoleplayFeedback(
  messages: ChatMessage[],
  targetPhrases: string[],
  config: AIConfig,
): Promise<RoleplayFeedback> {
  const conversation = messages
    .map((m) => `${m.role === 'user' ? 'Student' : 'AI Partner'}: ${m.content}`)
    .join('\n');

  const content = await callClaudeViaBackend(config, {
    maxTokens: 1024,
    messages: [
      {
        role: 'user',
        content: `${FEEDBACK_PROMPT}\n\n## Target Phrases\n${targetPhrases.join('\n')}\n\n## Conversation\n${conversation}`,
      },
    ],
  });

  const parsed = JSON.parse(content) as RoleplayFeedback;

  if (!Array.isArray(parsed.goodPoints) || typeof parsed.score !== 'number') {
    throw new Error('Claude API returned invalid feedback structure');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Extension: 別シチュエーションでの応用練習
// ---------------------------------------------------------------------------

const EXTENSION_SCENARIOS = [
  'a cozy café in Melbourne where the user is ordering a coffee and chatting with the barista',
  'a university campus where the user is meeting a new classmate for the first time',
  'a local bookshop where the user is asking for a recommendation',
  'a weekend farmers market where the user is buying fresh produce',
  'a co-working space where the user is introducing themselves to a fellow freelancer',
  'a rooftop party where the user is making small talk with other guests',
  'a hiking trail where the user bumps into a friendly local',
  'a cooking class where the user is paired with another participant',
];

/**
 * レッスン内容 (要約 + フレーズ) に合わせたシナリオを Claude に生成させる。
 * - 元の動画と「同じテーマ」だが「別のシチュエーション」を用意する
 *   (例: レッスンがカラオケの誘いなら、シナリオは「友人からコンサートに誘われる」)
 * - 学習者が同じフレーズを新しい文脈で使えるようにするのが目的
 *
 * 失敗時は EXTENSION_SCENARIOS からランダムに 1 つ返す。
 */
export async function generateExtensionScenario(
  config: AIConfig,
  params: {
    summary?: string | null;
    transcript?: string | null;
    phrases: { phrase: string; context?: string | null }[];
  },
): Promise<string> {
  const phraseList = params.phrases
    .slice(0, 10)
    .map((p, i) => `${i + 1}. "${p.phrase}"`)
    .join('\n');

  const prompt = `You are an English conversation scenario designer.

The learner just studied the following lesson:

## Lesson summary
${params.summary?.trim() || '(no summary)'}

## Key phrases they practiced
${phraseList}

## Your task
Design ONE fresh conversation scenario in which the learner could NATURALLY reuse the same key phrases, where:
- The THEME is closely related to the lesson topic (same general topic / situation family)
- But the EXACT situation is DIFFERENT from the original (so it's practice, not a rehash)
- The scenario should make it realistic to use multiple of the practiced phrases

## Output
Return ONLY one short English sentence describing the scenario, starting with "at " or "on " or "in ".
Example style: "at a friend's house where you're discussing weekend plans over dinner"
Do NOT add quotes, prefixes, or explanation — just the one line.`;

  try {
    const raw = await callClaudeViaBackend(config, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 200,
    });
    const cleaned = raw
      .replace(/^["「『]|["」』]$/g, '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (cleaned && cleaned.length > 8) return cleaned;
  } catch (e) {
    console.warn('generateExtensionScenario failed, falling back to preset:', e);
  }
  return EXTENSION_SCENARIOS[
    Math.floor(Math.random() * EXTENSION_SCENARIOS.length)
  ];
}

/**
 * Extension 用のシステムプロンプトを構築する。
 * 動画のフレーズを、同じテーマの別シチュエーションで使わせる。
 */
export function buildExtensionSystemPrompt(
  phrases: { phrase: string; context: string }[],
  scenario?: string,
  lessonSummary?: string | null,
): { prompt: string; scenario: string } {
  const chosen =
    scenario ??
    EXTENSION_SCENARIOS[Math.floor(Math.random() * EXTENSION_SCENARIOS.length)];

  const phraseList = phrases
    .map((p, i) => `${i + 1}. "${p.phrase}" — ${p.context}`)
    .join('\n');

  const contextBlock = lessonSummary?.trim()
    ? `\n## Original Lesson Topic\nThe learner just studied this lesson:\n${lessonSummary.trim()}\nStay thematically connected to this — the conversation should feel like a natural extension of the topic, not a random new one.\n`
    : '';

  const prompt = `You are a friendly, natural English conversation partner in a brand-new scenario.
${contextBlock}
## Scenario
You are in: ${chosen}.
Play the other person in this scenario naturally.

## Key Phrases the User Should Try to Use
${phraseList}

## Your Role
- Stay in character for the scenario above — this is NOT the original video context.
- Keep the conversation thematically related to the original lesson topic so the phrases fit naturally.
- Keep responses concise (1-3 sentences) and conversational.
- Naturally steer the conversation so the user has opportunities to use the key phrases.
- Do NOT correct mistakes mid-conversation — stay in character.
- Respond ONLY in English. Be warm, natural, and encouraging.`;

  return { prompt, scenario: chosen };
}

// ---------------------------------------------------------------------------
// Growth Analysis: 過去の練習と今回を比較
// ---------------------------------------------------------------------------

const GROWTH_ANALYSIS_PROMPT = `You are an expert English tutor analyzing a student's growth over multiple practice sessions.

Compare the student's CURRENT Extension conversation with their PAST performance data and provide a structured analysis as a JSON object:
{
  "goodPoints": ["things done well in THIS session, in Japanese, 2-3 items"],
  "improvements": ["areas still to improve, in Japanese, 2-3 items"],
  "expressionsUsed": ["key phrases successfully used from the target list"],
  "overallComment": "encouraging growth summary in Japanese, 2-3 sentences",
  "score": 80,
  "growthPoints": [
    {
      "category": "category name in Japanese (e.g. 語彙力, 自然さ, 文法, 積極性)",
      "before": "description of past performance in Japanese",
      "after": "description of current performance in Japanese",
      "improved": true
    }
  ],
  "growthSummary": "1-2 sentence positive summary of overall growth in Japanese"
}

Rules:
- Score from 0-100
- growthPoints should have 3-5 items comparing before vs. after
- Be specific about what changed — use examples from the conversations
- Be encouraging and highlight positive changes
- If no past data exists, compare against a hypothetical beginner baseline
- All text in Japanese except expressionsUsed (keep English phrases as-is)
- Return ONLY the JSON object, no markdown fences`;

/**
 * Extension 会話の成長分析フィードバックを生成する。
 */
export async function generateExtensionFeedback(
  currentMessages: ChatMessage[],
  targetPhrases: string[],
  pastPerformance: PastPerformance,
  config: AIConfig,
): Promise<ExtensionFeedback> {
  const conversation = currentMessages
    .map((m) => `${m.role === 'user' ? 'Student' : 'AI Partner'}: ${m.content}`)
    .join('\n');

  let pastContext = '## Past Performance\n';
  if (pastPerformance.roleplayScore != null) {
    pastContext += `- Roleplay score: ${pastPerformance.roleplayScore}/100\n`;
  }
  if (pastPerformance.shadowingBestScore != null) {
    pastContext += `- Best shadowing score: ${pastPerformance.shadowingBestScore}/100\n`;
  }
  if (pastPerformance.roleplayFeedback) {
    const rf = pastPerformance.roleplayFeedback;
    if (Array.isArray(rf.goodPoints)) {
      pastContext += `- Previous good points: ${rf.goodPoints.join('; ')}\n`;
    }
    if (Array.isArray(rf.improvements)) {
      pastContext += `- Previous improvements needed: ${rf.improvements.join('; ')}\n`;
    }
    if (Array.isArray(rf.expressionsUsed)) {
      pastContext += `- Previously used expressions: ${rf.expressionsUsed.join(', ')}\n`;
    }
  }
  if (
    pastPerformance.roleplayScore == null &&
    pastPerformance.shadowingBestScore == null
  ) {
    pastContext += 'No previous session data available — this is the first attempt.\n';
  }

  const content = await callClaudeViaBackend(config, {
    maxTokens: 1536,
    messages: [
      {
        role: 'user',
        content: `${GROWTH_ANALYSIS_PROMPT}\n\n${pastContext}\n## Target Phrases\n${targetPhrases.join('\n')}\n\n## Current Extension Conversation\n${conversation}`,
      },
    ],
  });

  const parsed = JSON.parse(content) as ExtensionFeedback;

  if (!Array.isArray(parsed.growthPoints) || typeof parsed.score !== 'number') {
    throw new Error('Claude API returned invalid extension feedback');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// 一括処理: 音声ファイル → フレーズ抽出
// ---------------------------------------------------------------------------

export interface ProcessVideoResult {
  transcription: TranscriptionResult;
  extraction: PhraseExtractionResult;
}

/**
 * 音声ファイルから文字起こし → フレーズ抽出を一括で行う。
 *
 * @param audioUri  ローカルの音声ファイルパス
 * @param config    API キー設定
 * @returns         文字起こし結果 + 抽出フレーズ
 */
export async function processVideoAudio(
  audioUri: string,
  config: AIConfig,
): Promise<ProcessVideoResult> {
  const transcription = await transcribeAudio(audioUri, config);
  const extraction = await extractPhrases(transcription.text, config);

  return { transcription, extraction };
}
