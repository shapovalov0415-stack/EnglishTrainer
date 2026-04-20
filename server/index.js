import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Load env from both repo root and server dir to tolerate cwd differences.
const envPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), 'server', '.env'),
];
for (const envPath of envPaths) {
  dotenv.config({ path: envPath, override: true });
}

const port = Number(process.env.PORT ?? 3000);
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

const openaiApiKey = process.env.OPENAI_API_KEY;

const anthropic = apiKey ? new Anthropic({ apiKey }) : null;
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
const app = express();

const upload = multer({
  dest: path.join(os.tmpdir(), 'et-uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB まで受け付け
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/chat/claude', async (req, res) => {
  try {
    if (!anthropic) {
      return res
        .status(500)
        .json({ error: 'ANTHROPIC_API_KEY is not set. Check server/.env' });
    }

    const { system, messages, maxTokens } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }

    const response = await anthropic.messages.create({
      model,
      max_tokens: typeof maxTokens === 'number' ? maxTokens : 1024,
      system: typeof system === 'string' ? system : undefined,
      messages,
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const text = textBlock?.type === 'text' ? textBlock.text : '';
    if (!text) {
      return res.status(502).json({ error: 'Claude returned empty content' });
    }

    return res.json({ text });
  } catch (error) {
    console.error('Claude proxy error:', error);
    return res.status(500).json({
      error: 'Failed to call Claude API',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

// ---------------------------------------------------------------------------
// POST /transcribe-file — MP4/音声ファイルアップロード → Whisper で文字起こし
// ---------------------------------------------------------------------------

// 動画 (mp4 等) から音声ストリーム (AAC / m4a) のみをコピーで切り出す。
// 再エンコードしないのでほぼ瞬時。ストレージ節約と後続 Whisper アップロードの
// 帯域節約が目的。入力が既に m4a/mp3 等の音声ならそのままコピー。
async function extractAudioOnly(inputPath, outputPath) {
  // -vn で映像を捨て、-c:a copy でコード変換せずに音声ストリームをそのまま抜く。
  // 非対応コンテナで copy が落ちたときのフォールバックとして aac 再エンコードを試す。
  try {
    await runFfmpeg(['-y', '-i', inputPath, '-vn', '-c:a', 'copy', outputPath]);
  } catch (e) {
    console.warn('[extractAudioOnly] copy failed, falling back to aac encode:', e instanceof Error ? e.message : String(e));
    await runFfmpeg(['-y', '-i', inputPath, '-vn', '-c:a', 'aac', '-b:a', '128k', outputPath]);
  }
}

app.post('/transcribe-file', upload.single('file'), async (req, res) => {
  const tmpFiles = [];
  try {
    if (!openai) {
      return res
        .status(500)
        .json({ error: 'OPENAI_API_KEY is not set. Check server/.env' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'file is required (multipart/form-data)' });
    }

    const ext = path.extname(req.file.originalname || '.mp4') || '.mp4';
    const renamed = req.file.path + ext;
    fs.renameSync(req.file.path, renamed);
    tmpFiles.push(renamed);

    const fileSizeMB = req.file.size / (1024 * 1024);
    console.log(`[transcribe-file] Processing: ${req.file.originalname} (${fileSizeMB.toFixed(1)} MB)`);

    // 音声のみ (.m4a) を抽出。これを Whisper に送り、かつクライアントへ
    // Base64 で返してセッションフォルダに audio.m4a として保存させる。
    // 動画ファイル本体は破棄して容量を削減。
    const audioPath = renamed + '.audio.m4a';
    await extractAudioOnly(renamed, audioPath);
    tmpFiles.push(audioPath);

    const audioStat = fs.statSync(audioPath);
    console.log(`[transcribe-file] Extracted audio: ${(audioStat.size / 1024 / 1024).toFixed(2)} MB`);

    // Whisper API の上限は 25MB。m4a 抽出後に超える場合は先頭 24MB を切り出す。
    let fileToSend = audioPath;
    const WHISPER_LIMIT = 24 * 1024 * 1024;
    if (audioStat.size > WHISPER_LIMIT) {
      const truncated = audioPath + '.truncated.m4a';
      const buf = Buffer.alloc(WHISPER_LIMIT);
      const fd = fs.openSync(audioPath, 'r');
      fs.readSync(fd, buf, 0, WHISPER_LIMIT, 0);
      fs.closeSync(fd);
      fs.writeFileSync(truncated, buf);
      fileToSend = truncated;
      tmpFiles.push(truncated);
      console.log(`[transcribe-file] Audio truncated to ${WHISPER_LIMIT / 1024 / 1024} MB for Whisper`);
    }

    const fileStream = fs.createReadStream(fileToSend);
    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fileStream,
      language: 'en',
      response_format: 'verbose_json',
    });

    // クライアント保存用に audio 全体 (truncated でない方) を Base64 化。
    const audioBuffer = fs.readFileSync(audioPath);
    const audioBase64 = audioBuffer.toString('base64');

    console.log(
      `[transcribe-file] Done (${transcription.text.length} chars, audioBase64=${(audioBase64.length / 1024 / 1024).toFixed(2)} MB)`,
    );

    return res.json({
      text: transcription.text,
      language: transcription.language,
      duration: transcription.duration,
      segments: (transcription.segments ?? []).map((seg) => ({
        id: seg.id,
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
      })),
      audioBase64,
      audioMimeType: 'audio/mp4',
      audioExt: '.m4a',
    });
  } catch (error) {
    console.error('[transcribe-file] Error:', error);
    return res.status(500).json({
      error: 'Failed to transcribe file',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

// ---------------------------------------------------------------------------
// POST /analyze — 文字起こしテキスト → Claude でフレーズ・役割抽出
// ---------------------------------------------------------------------------

const ANALYZE_PROMPT = `You are an expert English language tutor. Analyze the following transcript and extract:
1. Key phrases useful for an English learner
2. Conversation roles (who is speaking, the "other" role and the "learner" role)

Return a JSON object with this exact structure:
{
  "summary": "Brief 1-2 sentence summary of the content in Japanese",
  "phrases": [
    {
      "phrase": "the exact English phrase",
      "translation": "natural Japanese translation",
      "context": "when/how this phrase is used, in Japanese",
      "difficulty": "beginner | intermediate | advanced",
      "notes": "pronunciation tips or grammar notes in Japanese"
    }
  ],
  "roles": {
    "description": "Brief scenario description in Japanese",
    "speakerA": "Role name of first speaker (e.g. 'Interviewer', 'Barista')",
    "speakerB": "Role name of second speaker (e.g. 'Guest', 'Customer')",
    "turns": [
      { "speaker": "A or B", "text": "what they said" }
    ]
  }
}

Rules:
- Extract 5-10 most useful, natural phrases
- Prioritize conversational phrases over formal ones
- Include idiomatic expressions if present
- If the transcript has multiple speakers, identify their roles
- If it's a monologue, set speakerA as "Narrator" and omit speakerB
- All explanations in Japanese, phrases in English
- Return ONLY the JSON object, no markdown fences`;

app.post('/analyze', async (req, res) => {
  try {
    if (!anthropic) {
      return res
        .status(500)
        .json({ error: 'ANTHROPIC_API_KEY is not set. Check server/.env' });
    }

    const { transcript } = req.body ?? {};
    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({ error: 'transcript is required' });
    }

    console.log(`[analyze] Analyzing transcript (${transcript.length} chars)`);

    const response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `${ANALYZE_PROMPT}\n\n--- TRANSCRIPT ---\n${transcript}`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = textBlock?.type === 'text' ? textBlock.text : '';
    if (!raw) {
      return res.status(502).json({ error: 'Claude returned empty content' });
    }

    // コードフェンス除去 → JSON パース
    const stripped = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    const parsed = JSON.parse(stripped);

    console.log(`[analyze] Extracted ${parsed.phrases?.length ?? 0} phrases`);

    return res.json(parsed);
  } catch (error) {
    console.error('[analyze] Error:', error);
    return res.status(500).json({
      error: 'Failed to analyze transcript',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

// ---------------------------------------------------------------------------
// POST /analyze-video — 動画をアップロード → フレーム抽出 → Claude Vision OCR
// 動画内に表示されたスクリプト（字幕テキスト）を読み取ってフレーズを返す
// ---------------------------------------------------------------------------

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg error: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

const OCR_PROMPT = `You are analyzing screenshots from an English learning video.
Each image is a frame captured from the video at different timestamps.

Your task:
1. Look at ALL the images and find any English text/script/subtitles displayed ON SCREEN.
2. Extract the EXACT text shown in the video frames — do NOT paraphrase or summarize.
3. Combine and deduplicate the text across all frames (the same text may appear in multiple frames).
4. If the video shows a CONVERSATION between two or more people, identify the speakers and extract each dialogue turn in order.
5. Many English learning videos show BOTH English text AND Japanese translations on screen. Extract both.
6. Return the extracted data as a JSON object.

Return ONLY this JSON structure (no markdown fences):
{
  "summary": "Brief description of the video content in Japanese",
  "screenTexts": ["exact text from screen 1", "exact text from screen 2", ...],
  "phrases": [
    {
      "phrase": "the exact English phrase shown on screen",
      "translation": "natural Japanese translation (from screen if available, otherwise generate one)",
      "context": "when/how this phrase is used, in Japanese",
      "difficulty": "beginner | intermediate | advanced",
      "notes": "pronunciation tips or grammar notes in Japanese"
    }
  ],
  "scriptTurns": [
    {
      "speaker": "Speaker A or role name (e.g. 'Customer', 'Barista')",
      "text": "the exact English line spoken by this speaker"
    }
  ],
  "speakers": ["Speaker A name/role", "Speaker B name/role"]
}

Rules:
- Extract ALL visible English text from the video frames
- Keep the original text exactly as shown (spelling, capitalization, punctuation)
- screenTexts should contain every unique piece of text found, in order of appearance
- phrases should contain ALL key phrases for an English learner (up to 15)
- If the same text appears across multiple frames, include it only once
- All explanations (translation, context, notes) should be in Japanese
- scriptTurns: if the video shows a conversation/dialogue, list each line in order with the speaker identified. If there is no clear conversation, return an empty array.
- speakers: the two (or more) distinct speaker names/roles found. If no conversation, return an empty array.
- Return ONLY the JSON object`;

app.post('/analyze-video', upload.single('file'), async (req, res) => {
  const tmpFiles = [];

  try {
    if (!anthropic) {
      return res
        .status(500)
        .json({ error: 'ANTHROPIC_API_KEY is not set. Check server/.env' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'file is required (multipart/form-data)' });
    }

    const ext = path.extname(req.file.originalname || '.mp4') || '.mp4';
    const videoPath = req.file.path + ext;
    fs.renameSync(req.file.path, videoPath);
    tmpFiles.push(videoPath);

    console.log(`[analyze-video] Processing: ${req.file.originalname}`);

    // フレーム抽出用ディレクトリ
    const framesDir = path.join(os.tmpdir(), `et-frames-${Date.now()}`);
    fs.mkdirSync(framesDir, { recursive: true });

    // 1秒ごとにフレームを抽出（最大60枚）
    await runFfmpeg([
      '-i', videoPath,
      '-vf', 'fps=1',
      '-frames:v', '60',
      '-q:v', '3',
      path.join(framesDir, 'frame-%03d.jpg'),
    ]);

    const frameFiles = fs.readdirSync(framesDir)
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .slice(0, 20);

    console.log(`[analyze-video] Extracted ${frameFiles.length} frames`);

    if (frameFiles.length === 0) {
      return res.status(400).json({ error: 'No frames could be extracted from the video' });
    }

    // フレーム画像を base64 に変換して Claude Vision に送信
    const imageContents = frameFiles.map((f) => {
      const imgPath = path.join(framesDir, f);
      tmpFiles.push(imgPath);
      const data = fs.readFileSync(imgPath);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: data.toString('base64'),
        },
      };
    });

    tmpFiles.push(framesDir);

    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            ...imageContents,
            { type: 'text', text: OCR_PROMPT },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = textBlock?.type === 'text' ? textBlock.text : '';
    if (!raw) {
      return res.status(502).json({ error: 'Claude Vision returned empty content' });
    }

    const stripped = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    const parsed = JSON.parse(stripped);

    console.log(`[analyze-video] Found ${parsed.screenTexts?.length ?? 0} screen texts, ${parsed.phrases?.length ?? 0} phrases`);

    return res.json(parsed);
  } catch (error) {
    console.error('[analyze-video] Error:', error);
    return res.status(500).json({
      error: 'Failed to analyze video',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const f of tmpFiles) {
      try {
        const stat = fs.statSync(f);
        if (stat.isDirectory()) fs.rmSync(f, { recursive: true });
        else fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
  }
});

// ---------------------------------------------------------------------------
// 非同期ジョブ: 動画 URL の解析は長時間かかるので、クライアントとの HTTP
// 接続を保持せずに進行する。
//
//   POST /analyze-from-url  → 即座に { jobId } を返して、バックグラウンドで
//                             ダウンロード→OCR→音声抽出→Whisper を実施
//   GET  /jobs/:jobId       → { status, stage, result?, error? } を返す
//
// クライアント (モバイル) が途中でアプリを閉じても、ジョブはサーバー側で
// 完走する。復帰時にポーリングで完成品を取りに来るだけで良い。
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} JobState
 * @property {'queued'|'downloading'|'ocr'|'transcribing'|'done'|'error'} status
 * @property {string} [stage] 進行中ステージの日本語ラベル (UI 表示用)
 * @property {any}    [result]
 * @property {string} [error]
 * @property {number} createdAt
 * @property {number} [updatedAt]
 * @property {string} url
 */

/** @type {Map<string, JobState>} */
const jobs = new Map();

function newJobId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function setJob(jobId, patch) {
  const prev = jobs.get(jobId) ?? {};
  jobs.set(jobId, { ...prev, ...patch, updatedAt: Date.now() });
}

// 30 分経過したジョブは破棄してメモリリークを防ぐ
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    const t = job.updatedAt ?? job.createdAt ?? 0;
    if (t < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Claude / Whisper 呼び出しの同時実行制御
//   複数ジョブを同時投入したとき、それぞれが並列に Claude Vision を叩くと
//   30,000 tokens/min のレートリミットを瞬時に突破してしまう。
//   ここで semaphore を 1 つ置いて、Vision 呼び出しだけは直列に並べる。
//   429 が返ったら指数バックオフで最大 5 回までリトライする。
// ---------------------------------------------------------------------------
let visionQueueTail = Promise.resolve();
async function runWithClaudeVisionQueue(fn) {
  const ticket = visionQueueTail.catch(() => {});
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  visionQueueTail = ticket.then(() => next);
  await ticket;
  try {
    return await fn();
  } finally {
    release();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractRetryAfterSec(err) {
  const msg = err?.message ?? '';
  // Anthropic の 429 レスポンスは x-retry-after ヘッダ or message 内に秒数を含む
  const m = /retry[- ]?after[^0-9]*([0-9]+)/i.exec(msg);
  if (m) return Number(m[1]);
  return null;
}

async function callClaudeWithRetry(fn, label) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isRateLimit = /429|rate[_ ]limit|too many/i.test(msg);
      if (!isRateLimit || attempt === maxAttempts) throw e;
      const hinted = extractRetryAfterSec(e);
      const delay =
        hinted != null
          ? Math.max(1, hinted) * 1000
          : Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      console.warn(
        `[${label}] rate limited (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  // Should not reach here
  throw new Error('retry exhausted');
}

/**
 * 共通パイプライン: 手元にある videoPath を入力に、OCR + 音声抽出 + Whisper を回し、
 * 結果を jobs Map へ書き込む。URL フローも ファイルアップロードフローも、
 * ここへ合流する。
 */
async function processLocalVideoForJob(jobId, videoPath) {
  const tmpFiles = [];
  const tmpDirs = [];
  try {
    // 1) フレーム抽出 → Claude Vision で OCR
    setJob(jobId, { status: 'ocr', stage: '画面テキスト読み取り中' });
    const ts = Date.now();
    const framesDir = path.join(os.tmpdir(), `et-frames-${ts}-${jobId}`);
    fs.mkdirSync(framesDir, { recursive: true });
    tmpDirs.push(framesDir);

    await runFfmpeg([
      '-i', videoPath,
      '-vf', 'fps=1',
      '-frames:v', '60',
      '-q:v', '3',
      path.join(framesDir, 'frame-%03d.jpg'),
    ]);

    const frameFiles = fs.readdirSync(framesDir)
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .slice(0, 20);

    if (frameFiles.length === 0) {
      throw new Error('No frames could be extracted from the video');
    }
    console.log(`[job ${jobId}] Extracted ${frameFiles.length} frames`);

    const imageContents = frameFiles.map((f) => {
      const imgPath = path.join(framesDir, f);
      const data = fs.readFileSync(imgPath);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: data.toString('base64'),
        },
      };
    });

    const ocrResponse = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [...imageContents, { type: 'text', text: OCR_PROMPT }],
        },
      ],
    });

    const ocrBlock = ocrResponse.content.find((b) => b.type === 'text');
    const ocrRaw = ocrBlock?.type === 'text' ? ocrBlock.text : '';
    if (!ocrRaw) throw new Error('Claude Vision returned empty content');
    const ocrStripped = ocrRaw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    const ocrParsed = JSON.parse(ocrStripped);

    console.log(
      `[job ${jobId}] OCR: ${ocrParsed.screenTexts?.length ?? 0} texts, ${ocrParsed.phrases?.length ?? 0} phrases, ${ocrParsed.scriptTurns?.length ?? 0} turns`,
    );

    // 2) 音声抽出
    setJob(jobId, { status: 'transcribing', stage: '音声抽出・文字起こし中' });
    const audioPath = videoPath + '.m4a';
    await extractAudioOnly(videoPath, audioPath);
    tmpFiles.push(audioPath);

    const audioStat = fs.statSync(audioPath);
    console.log(`[job ${jobId}] Audio: ${(audioStat.size / 1024 / 1024).toFixed(2)} MB`);

    // 3) Whisper
    const WHISPER_LIMIT = 24 * 1024 * 1024;
    let whisperPath = audioPath;
    if (audioStat.size > WHISPER_LIMIT) {
      const truncated = audioPath + '.truncated.m4a';
      const buf = Buffer.alloc(WHISPER_LIMIT);
      const fd = fs.openSync(audioPath, 'r');
      fs.readSync(fd, buf, 0, WHISPER_LIMIT, 0);
      fs.closeSync(fd);
      fs.writeFileSync(truncated, buf);
      whisperPath = truncated;
      tmpFiles.push(truncated);
    }
    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(whisperPath),
      language: 'en',
      response_format: 'verbose_json',
    });

    // 4) 音声全体を Base64 化して result へ格納（client が polling で取得する）
    const audioBase64 = fs.readFileSync(audioPath).toString('base64');

    console.log(
      `[job ${jobId}] Done (transcript=${transcription.text.length} chars, audioBase64=${(audioBase64.length / 1024 / 1024).toFixed(2)} MB)`,
    );

    const result = {
      summary: ocrParsed.summary ?? '',
      screenTexts: ocrParsed.screenTexts ?? [],
      phrases: ocrParsed.phrases ?? [],
      scriptTurns: ocrParsed.scriptTurns ?? [],
      speakers: ocrParsed.speakers ?? [],
      transcript: transcription.text,
      language: transcription.language,
      duration: transcription.duration,
      segments: (transcription.segments ?? []).map((seg) => ({
        id: seg.id,
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
      })),
      audioBase64,
      audioMimeType: 'audio/mp4',
      audioExt: '.m4a',
    };
    setJob(jobId, { status: 'done', stage: '完了', result });
  } catch (error) {
    console.error(`[job ${jobId}] Error:`, error);
    setJob(jobId, {
      status: 'error',
      stage: 'エラー',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true }); } catch { /* ignore */ }
    }
  }
}

/** URL からダウンロードしたうえで共通パイプラインへ渡す */
async function runAnalyzeJob(jobId, url) {
  const tmpFiles = [];
  try {
    setJob(jobId, { status: 'downloading', stage: 'ダウンロード中' });
    console.log(`[job ${jobId}] Downloading: ${url}`);

    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Upstream responded ${response.status}`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/video|octet-stream|mp4|quicktime/i.test(contentType)) {
      console.warn(`[job ${jobId}] Unexpected content-type: ${contentType}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const videoBuffer = Buffer.from(arrayBuffer);

    const videoPath = path.join(os.tmpdir(), `et-url-${Date.now()}-${jobId}.mp4`);
    fs.writeFileSync(videoPath, videoBuffer);
    tmpFiles.push(videoPath);

    const sizeMB = videoBuffer.length / (1024 * 1024);
    console.log(`[job ${jobId}] Downloaded ${sizeMB.toFixed(1)} MB`);

    await processLocalVideoForJob(jobId, videoPath);
  } catch (error) {
    console.error(`[job ${jobId}] Error (url):`, error);
    setJob(jobId, {
      status: 'error',
      stage: 'エラー',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

/** クライアントがアップロードしたローカルファイルパスから直接パイプラインへ渡す */
async function runAnalyzeFileJob(jobId, uploadedPath) {
  const tmpFiles = [uploadedPath];
  try {
    setJob(jobId, { status: 'queued', stage: 'アップロード受付済み' });
    await processLocalVideoForJob(jobId, uploadedPath);
  } catch (error) {
    console.error(`[job ${jobId}] Error (file):`, error);
    setJob(jobId, {
      status: 'error',
      stage: 'エラー',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /analyze-from-url — fire-and-forget でジョブを開始
//   即座に { jobId } を返し、処理は runAnalyzeJob() がバックグラウンドで進める。
// ---------------------------------------------------------------------------
app.post('/analyze-from-url', (req, res) => {
  if (!anthropic) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });
  }
  if (!openai) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not set' });
  }
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'url (http(s)) is required' });
  }

  const jobId = newJobId();
  setJob(jobId, { status: 'queued', stage: '待機中', createdAt: Date.now(), url });
  // 非同期実行 (await しない)。完了/失敗は jobs Map に反映される。
  runAnalyzeJob(jobId, url).catch((e) => {
    console.error(`[job ${jobId}] unhandled:`, e);
    setJob(jobId, {
      status: 'error',
      stage: 'エラー',
      error: e instanceof Error ? e.message : String(e),
    });
  });
  console.log(`[job ${jobId}] queued for url=${url}`);
  return res.status(202).json({ jobId });
});

// ---------------------------------------------------------------------------
// POST /analyze-file-job — アップロードされた mp4 を非同期ジョブとして投入
//   multipart/form-data で file フィールドにファイルを載せる。
//   即座に { jobId } を返し、以降 /jobs/:jobId でポーリング。
//   アップロード自体は HTTP 接続が必要だが、完了後に接続を切ってもサーバー側で
//   処理を継続できる。複数同時投入も OK。
// ---------------------------------------------------------------------------
app.post('/analyze-file-job', upload.single('file'), (req, res) => {
  if (!anthropic) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set' });
  }
  if (!openai) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    return res.status(500).json({ error: 'OPENAI_API_KEY is not set' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'file is required (multipart/form-data)' });
  }

  // オリジナル名の拡張子を付与して ffmpeg が扱えるようにする
  const ext = path.extname(req.file.originalname || '.mp4') || '.mp4';
  const renamed = req.file.path + ext;
  try {
    fs.renameSync(req.file.path, renamed);
  } catch (e) {
    console.warn('rename upload failed:', e);
  }

  const jobId = newJobId();
  setJob(jobId, {
    status: 'queued',
    stage: '待機中',
    createdAt: Date.now(),
    url: `file:${req.file.originalname ?? 'upload'}`,
  });

  runAnalyzeFileJob(jobId, renamed).catch((e) => {
    console.error(`[job ${jobId}] unhandled:`, e);
    setJob(jobId, {
      status: 'error',
      stage: 'エラー',
      error: e instanceof Error ? e.message : String(e),
    });
  });
  console.log(`[job ${jobId}] queued file=${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
  return res.status(202).json({ jobId });
});

// ---------------------------------------------------------------------------
// GET /jobs/:jobId — ジョブ状態取得
// ---------------------------------------------------------------------------
app.get('/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }
  // result は完了時のみ返す。進行中ジョブで大きな data を毎回返さない。
  if (job.status === 'done') {
    return res.json({
      status: job.status,
      stage: job.stage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      result: job.result,
    });
  }
  return res.json({
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
  });
});

// ---------------------------------------------------------------------------
// DELETE /jobs/:jobId — 取得済みジョブのサーバー側メモリ解放（任意）
// ---------------------------------------------------------------------------
app.delete('/jobs/:jobId', (req, res) => {
  jobs.delete(req.params.jobId);
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /tts
//
// フレーズリスト用の音声生成。OpenAI TTS で生成した mp3 を
// `server/audio_cache/<key>.mp3` にディスクキャッシュし、以降は再生成せず
// キャッシュを返す。キーはクライアント (src/utils/phraseAudio.ts) と
// 完全に同じアルゴリズムで計算しているため、同じ text → 同じファイル。
// ---------------------------------------------------------------------------

const TTS_CACHE_DIR = path.join(__dirname, 'audio_cache');
fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });

/**
 * 非暗号学的だが、短い英文ではクライアントと一致すれば十分な
 * 決定的ハッシュ (16 hex = 64bit)。衝突確率はアプリ規模では実質ゼロ。
 * Math.imul を使って JS 実装間で挙動を揃える。
 */
function phraseAudioKey(voice, text) {
  const s = `${voice}::${text}`;
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xdeadbeef >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return (
    h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
  );
}

app.post('/tts', async (req, res) => {
  try {
    if (!openai) {
      return res
        .status(500)
        .json({ error: 'OPENAI_API_KEY is not set. Check server/.env' });
    }
    const { text, voice } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const normVoice = typeof voice === 'string' && voice ? voice : 'alloy';
    const key = phraseAudioKey(normVoice, text.trim());
    const filePath = path.join(TTS_CACHE_DIR, `${key}.mp3`);

    if (!fs.existsSync(filePath)) {
      const speech = await openai.audio.speech.create({
        model: 'tts-1',
        voice: normVoice,
        input: text.trim(),
        format: 'mp3',
      });
      const buf = Buffer.from(await speech.arrayBuffer());
      await fs.promises.writeFile(filePath, buf);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Phrase-Key', key);
    return res.sendFile(filePath);
  } catch (e) {
    console.error('/tts failed:', e);
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.listen(port, () => {
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY is not set. /chat/claude will return 500.');
  }
  if (!openaiApiKey) {
    console.warn('OPENAI_API_KEY is not set. /transcribe-file will return 500.');
  }
  console.log(`EnglishTrainer API server running on http://localhost:${port}`);
});
