const API_BASE_URL: string =
  (typeof process !== 'undefined' &&
    process.env &&
    process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'http://192.168.1.133:3000';

// ---------------------------------------------------------------------------
// 汎用ヘルパー
// ---------------------------------------------------------------------------

async function serverFetch<T>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  let response: Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `サーバーに接続できません (${url}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Server error (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}

async function callClaude(userPrompt: string, maxTokens = 1024): Promise<string> {
  const data = await serverFetch<{ text: string }>('/chat/claude', {
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens,
  });
  if (!data.text) throw new Error('Server returned empty content');
  return data.text;
}

// ---------------------------------------------------------------------------
// MP4 ファイル → Whisper 文字起こし → Claude 解析
// ---------------------------------------------------------------------------

export interface AnalyzeResult {
  summary: string;
  phrases: {
    phrase: string;
    translation: string;
    context: string;
    difficulty: string;
    notes: string;
  }[];
  roles?: {
    description: string;
    speakerA: string;
    speakerB?: string;
    turns: { speaker: string; text: string }[];
  };
}

export interface TranscribeFileResult {
  text: string;
  language: string;
  duration: number;
  segments: { id: number; start: number; end: number; text: string }[];
  /**
   * サーバー側で ffmpeg により元動画から抽出した音声のみ (m4a) を Base64 化した文字列。
   * クライアントはこれをデコードして session フォルダに `audio.m4a` として保存し、
   * 以降の再生はこの音声ファイルだけを使う（mp4 は一切持たない）。
   */
  audioBase64?: string;
  audioMimeType?: string;
  audioExt?: string;
}

/**
 * ローカルの動画/音声ファイルをサーバーにアップロードし、
 * Whisper で文字起こしを行う。
 */
export async function transcribeFile(fileUri: string): Promise<TranscribeFileResult> {
  const url = `${API_BASE_URL}/transcribe-file`;
  const formData = new FormData();

  formData.append('file', {
    uri: fileUri,
    type: 'video/mp4',
    name: 'video.mp4',
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
    const text = await response.text();
    throw new Error(`Transcription error (${response.status}): ${text}`);
  }

  return response.json() as Promise<TranscribeFileResult>;
}

/**
 * 文字起こしテキストを Claude で解析し、フレーズ＋役割を抽出する。
 */
export async function analyzeTranscript(transcript: string): Promise<AnalyzeResult> {
  return serverFetch<AnalyzeResult>('/analyze', { transcript });
}

/**
 * MP4 ファイル → 文字起こし → フレーズ解析を一気通貫で行う。
 */
export async function processVideoFile(fileUri: string): Promise<{
  transcription: TranscribeFileResult;
  analysis: AnalyzeResult;
}> {
  const transcription = await transcribeFile(fileUri);
  const analysis = await analyzeTranscript(transcription.text);
  return { transcription, analysis };
}

// ---------------------------------------------------------------------------
// MP4 ファイル → Claude Vision OCR（動画内のスクリプトを読み取る）
// ---------------------------------------------------------------------------

export interface AnalyzeVideoResult {
  summary: string;
  screenTexts: string[];
  phrases: {
    phrase: string;
    translation: string;
    context: string;
    difficulty: string;
    notes: string;
  }[];
  scriptTurns?: {
    speaker: string;
    text: string;
  }[];
  speakers?: string[];
}

// ---------------------------------------------------------------------------
// URL 入力フロー: サーバーに URL を送るだけで OCR + 音声抽出 + Whisper をまとめて実施。
// クライアントは端末内に mp4 を保持する必要がない（音声のみ audio.m4a で受け取る）。
// ---------------------------------------------------------------------------

export interface AnalyzeFromUrlResult {
  summary: string;
  screenTexts: string[];
  phrases: {
    phrase: string;
    translation: string;
    context: string;
    difficulty: string;
    notes: string;
  }[];
  scriptTurns: { speaker: string; text: string }[];
  speakers: string[];
  transcript: string;
  language: string;
  duration: number;
  segments: { id: number; start: number; end: number; text: string }[];
  audioBase64?: string;
  audioMimeType?: string;
  audioExt?: string;
}

export async function analyzeFromUrl(url: string): Promise<AnalyzeFromUrlResult> {
  // 従来 API との互換: submit → poll done まで待つ。
  const jobId = await submitAnalyzeFromUrlJob(url);
  return pollAnalyzeJob(jobId);
}

// ---------------------------------------------------------------------------
// 非同期ジョブ API (サーバーがバックグラウンドで処理)
//   POST /analyze-from-url → { jobId }
//   GET  /jobs/:jobId      → { status, stage, result?, error? }
// クライアントは polling しながら他の画面へ移動できる。複数同時投入も可能。
// ---------------------------------------------------------------------------

export type AnalyzeJobStatus =
  | 'queued'
  | 'downloading'
  | 'ocr'
  | 'transcribing'
  | 'done'
  | 'error';

export interface AnalyzeJobState {
  status: AnalyzeJobStatus;
  stage?: string;
  result?: AnalyzeFromUrlResult;
  error?: string;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * ローカル mp4 ファイルをサーバーにアップロードし、非同期ジョブとして投入する。
 * 呼び出しはアップロード完了までブロック（HTTP 接続は必要）。以降の OCR / 音声抽出 /
 * Whisper はサーバーのバックグラウンドで走るので、ここが終わればアプリはバックグラウンドに
 * 移動しても良い（後は pollAnalyzeJob で結果を取りに行くだけ）。
 */
export async function submitAnalyzeFileJob(
  fileUri: string,
  originalName: string,
): Promise<string> {
  const reqUrl = `${API_BASE_URL}/analyze-file-job`;
  const formData = new FormData();
  formData.append('file', {
    uri: fileUri,
    type: 'video/mp4',
    name: originalName || 'video.mp4',
  } as unknown as Blob);

  let res: Response;
  try {
    res = await fetch(reqUrl, { method: 'POST', body: formData });
  } catch (e) {
    throw new Error(
      `サーバーに接続できません (${reqUrl}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`submitAnalyzeFileJob error (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { jobId?: string; error?: string };
  if (!data.jobId) {
    throw new Error(`submitAnalyzeFileJob: server did not return jobId (${data.error ?? ''})`);
  }
  return data.jobId;
}

/** URL をジョブとして投入し、即座に jobId を受け取る（アップロード/解析は裏で走る）。 */
export async function submitAnalyzeFromUrlJob(url: string): Promise<string> {
  const reqUrl = `${API_BASE_URL}/analyze-from-url`;
  let res: Response;
  try {
    res = await fetch(reqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch (e) {
    throw new Error(
      `サーバーに接続できません (${reqUrl}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`submitAnalyzeFromUrlJob error (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { jobId?: string; error?: string };
  if (!data.jobId) {
    throw new Error(`submitAnalyzeFromUrlJob: server did not return jobId (${data.error ?? ''})`);
  }
  return data.jobId;
}

/** ジョブ状態を 1 回だけ取得する。404 の時は null。 */
export async function getAnalyzeJobStatus(jobId: string): Promise<AnalyzeJobState | null> {
  const reqUrl = `${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`;
  let res: Response;
  try {
    res = await fetch(reqUrl);
  } catch (e) {
    throw new Error(
      `サーバーに接続できません (${reqUrl}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getAnalyzeJobStatus error (${res.status}): ${text}`);
  }
  return (await res.json()) as AnalyzeJobState;
}

/** ジョブ完了までポーリングし、完了時に result を返す。 */
export async function pollAnalyzeJob(
  jobId: string,
  options?: {
    intervalMs?: number;
    onProgress?: (s: AnalyzeJobState) => void;
    shouldStop?: () => boolean;
  },
): Promise<AnalyzeFromUrlResult> {
  const intervalMs = options?.intervalMs ?? 3000;
  while (true) {
    if (options?.shouldStop?.()) throw new Error('polling aborted');
    const state = await getAnalyzeJobStatus(jobId);
    if (!state) {
      throw new Error('ジョブが見つかりません（サーバー再起動で失われた可能性があります）');
    }
    options?.onProgress?.(state);
    if (state.status === 'done' && state.result) return state.result;
    if (state.status === 'error') throw new Error(state.error ?? 'ジョブがエラー終了しました');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** サーバー側のジョブメモリを解放する（取得後に呼ぶ）。失敗しても致命的ではない。 */
export async function deleteAnalyzeJob(jobId: string): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  } catch {
    /* ignore */
  }
}

export async function analyzeVideo(fileUri: string): Promise<AnalyzeVideoResult> {
  const url = `${API_BASE_URL}/analyze-video`;
  const formData = new FormData();

  formData.append('file', {
    uri: fileUri,
    type: 'video/mp4',
    name: 'video.mp4',
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
    const text = await response.text();
    throw new Error(`Video analysis error (${response.status}): ${text}`);
  }

  return response.json() as Promise<AnalyzeVideoResult>;
}

// ---------------------------------------------------------------------------
// extractPhrases — テキスト入力時の簡易フレーズ抽出
// ---------------------------------------------------------------------------

export async function extractPhrases(input: string): Promise<string[]> {
  const trimmed = input.trim();

  const prompt = `You are an expert English tutor.
From the following text, extract exactly 5 useful English phrases or sentences that a learner should practice speaking aloud.

Rules:
- Pick natural, conversational phrases
- Each phrase should be 3-15 words
- Return ONLY a JSON array of 5 strings, no markdown fences, no explanation
- Example: ["phrase one","phrase two","phrase three","phrase four","phrase five"]

Text:
${trimmed}`;

  const raw = await callClaude(prompt, 512);

  const stripped = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  const match = stripped.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error('Claude did not return a valid JSON array');
  }

  const parsed: unknown = JSON.parse(match[0]);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Claude returned an empty or invalid array');
  }

  return parsed.map(String).slice(0, 5);
}

// ---------------------------------------------------------------------------
// scorePronunciation
// ---------------------------------------------------------------------------

export interface ScoreResult {
  score: number;
  feedback: string;
}

export async function scorePronunciation(
  original: string,
  spoken: string,
): Promise<ScoreResult> {
  const prompt = `You are an English pronunciation coach.

Compare the original phrase with what the student actually said.
Evaluate accuracy, missing/extra words, and naturalness.

Return ONLY a JSON object (no markdown fences):
{
  "score": <0-100>,
  "feedback": "<1-2 sentence feedback in Japanese>"
}

Original: "${original}"
Student said: "${spoken}"`;

  const raw = await callClaude(prompt, 256);

  const stripped = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Claude did not return a valid JSON object');
  }

  const parsed = JSON.parse(match[0]) as ScoreResult;

  if (typeof parsed.score !== 'number' || typeof parsed.feedback !== 'string') {
    throw new Error('Claude returned an invalid score object');
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// paraphraseForEcho — Echo Trigger 用: 日本語 or 拙い英語 → 自然な口語英語
// ---------------------------------------------------------------------------

export interface EchoParaphrase {
  /** ネイティブが普段使う自然な英語表現 */
  naturalEnglish: string;
  /** 同じ意味を表す日本語（確認用） */
  translation: string;
  /** いつ使う表現か / トーン / 言い換えなど、1 行程度の補足 */
  note: string;
}

/**
 * 外出中に録音した「言いたいこと」を、メルボルンなど英語圏のネイティブが
 * 実際に使う自然なカジュアル表現に変換する。
 * 短く、その場ですぐ口に出せる長さ（最大 15 words 程度）に揃える。
 */
export async function paraphraseForEcho(input: string): Promise<EchoParaphrase> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Empty input');
  }

  const prompt = `You are a bilingual conversation coach helping a learner who lives in Melbourne, Australia.
The learner just recorded what they want to say, either in Japanese or in broken English.

Rewrite it as ONE short, natural spoken English expression a local would actually use in that situation.
- Keep it conversational (not textbook), 3-15 words when possible.
- Prefer everyday phrasing over formal phrasing. Australian-leaning is fine if it fits.
- If the input is ambiguous, pick the most common everyday interpretation.

Return ONLY a JSON object (no markdown fences, no preface):
{
  "naturalEnglish": "<the spoken English>",
  "translation": "<the same meaning in Japanese, 1 line>",
  "note": "<1 short line in Japanese: when to use it, tone, or an alternative. No more than 60 chars.>"
}

Learner input:
${trimmed}`;

  const raw = await callClaude(prompt, 400);

  const stripped = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Claude did not return a valid JSON object');
  }

  const parsed = JSON.parse(match[0]) as Partial<EchoParaphrase>;
  if (
    typeof parsed.naturalEnglish !== 'string' ||
    !parsed.naturalEnglish.trim()
  ) {
    throw new Error('Claude did not return a natural English string');
  }

  return {
    naturalEnglish: parsed.naturalEnglish.trim(),
    translation:
      typeof parsed.translation === 'string' ? parsed.translation.trim() : '',
    note: typeof parsed.note === 'string' ? parsed.note.trim() : '',
  };
}
