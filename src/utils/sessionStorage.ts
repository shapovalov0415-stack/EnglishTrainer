// ---------------------------------------------------------------------------
// sessionStorage
//   セッションごとの専用フォルダ（documentDirectory/sessions/<name>/）への
//   動画(音声)・タイムスタンプ・スクリプト・ステップ別 JSON の書き込み / 読み込みを
//   担当するモジュール。
//
//   新 expo-file-system API (File / Directory / Paths クラス) のみを使用する。
//   `expo-file-system/legacy` の legacy 関数 API は Metro Bundler の subpath
//   解決で "Could not load bundle" が出るため一切使わない。
// ---------------------------------------------------------------------------

import { File, Directory, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

const SESSIONS_DIR = 'sessions';

function sanitize(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 60);
}

/**
 * DB に保存された値からセッションフォルダの「名前部分」だけを取り出す。
 *
 * DB には本来フォルダ名のみ（例: "20260417_1830_myvideo"）を格納するが、
 * 旧バージョンの絶対パス / 相対パスが混ざっていても正規化できるようにする。
 */
export function extractSessionFolderName(stored: string): string {
  if (!stored) return stored;
  let s = stored.endsWith('/') ? stored.slice(0, -1) : stored;
  const idx = s.lastIndexOf('/');
  if (idx >= 0) s = s.substring(idx + 1);
  return s;
}

/**
 * 保存された値（フォルダ名 / 絶対パス / 相対パス）を、現在の
 * documentDirectory 配下の `sessions/<folderName>/` という絶対パスへ解決する。
 * iOS の documentDirectory は端末の UUID を含むため再起動のたびに変わる可能性があり、
 * DB にはフォルダ名のみを入れて、毎回ここで結合しなおす方針。
 */
export async function resolveSessionFolderPath(stored: string): Promise<string> {
  const root = Paths.document.uri;
  const name = extractSessionFolderName(stored);
  if (!name) return stored;
  const ensured = root.endsWith('/') ? root : `${root}/`;
  return `${ensured}${SESSIONS_DIR}/${name}/`;
}

/** 後方互換エイリアス。 */
export async function normalizeSessionFolder(stored: string): Promise<string> {
  if (!stored) return stored;
  return resolveSessionFolderPath(stored);
}

function ts(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface Step1Data {
  phrases: string[];
  phrasesWithTranslation?: { phrase: string; translation: string }[];
  transcript?: string;
  scores: { phrase: string; score: number; feedback: string; spokenText: string }[];
  completedAt: string;
}

export interface Step2Data {
  scriptTurns: { speaker: string; text: string }[];
  myRole: string;
  avgScore: number;
  results: {
    turnIdx: number;
    expectedText: string;
    score: number;
    feedback: string;
  }[];
  completedAt: string;
}

export interface Step3Data {
  scenario: string;
  messages: { role: string; content: string }[];
  score: number;
  feedback: {
    overallComment: string;
    goodPoints: string[];
    improvements: string[];
    expressionsUsed: string[];
    growthSummary: string;
  };
  completedAt: string;
}

// ---------------------------------------------------------------------------
// フォルダ作成
// ---------------------------------------------------------------------------

export async function createSessionFolder(videoFileName: string): Promise<string> {
  const root = Paths.document.uri;
  if (!root) {
    throw new Error('documentDirectory が利用できません');
  }
  const ensuredRoot = root.endsWith('/') ? root : `${root}/`;

  // 親 sessions/ ディレクトリを必ず用意
  const baseDir = new Directory(`${ensuredRoot}${SESSIONS_DIR}/`);
  if (!baseDir.exists) {
    baseDir.create({ intermediates: true, idempotent: true });
  }

  const folderName = `${ts()}_${sanitize(videoFileName)}`;
  const folderPath = `${ensuredRoot}${SESSIONS_DIR}/${folderName}/`;

  const dir = new Directory(folderPath);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }

  console.warn(
    `[sessionStorage] createSessionFolder: "${folderPath}" exists=${dir.exists}`,
  );
  return folderPath;
}

// ---------------------------------------------------------------------------
// 音声保存 (base64)
// ---------------------------------------------------------------------------

/**
 * サーバー側 ffmpeg で抽出された m4a (base64) を セッションフォルダに
 * `audio<ext>` として書き込む。再生時はこの音声だけを使う。
 */
export async function saveAudioToSession(
  sessionFolder: string,
  base64: string,
  ext: string = '.m4a',
): Promise<string> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  const dir = new Directory(folder);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  const normExt = ext.startsWith('.') ? ext : `.${ext}`;
  const dest = `${folder}audio${normExt}`;
  const file = new File(dest);
  if (file.exists) {
    try {
      file.delete();
    } catch (e) {
      console.warn(`[sessionStorage] saveAudioToSession: delete existing failed`, e);
    }
  }
  file.create();
  file.write(base64, { encoding: 'base64' });
  console.warn(
    `[sessionStorage] saveAudioToSession: wrote "${dest}" exists=${file.exists} size=${file.size ?? 'n/a'}`,
  );
  return dest;
}

/** 後方互換: 旧 mp4 をそのままコピーしたいケース（現在は未使用）。 */
export async function copyVideoToSession(
  sourceUri: string,
  sessionFolder: string,
  originalName: string,
): Promise<string> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  const dir = new Directory(folder);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const ext = originalName.match(/\.[^.]+$/)?.[0] ?? '.mp4';
  const dest = `${folder}video${ext}`;
  const src = new File(sourceUri);
  const destFile = new File(dest);
  if (destFile.exists) {
    try {
      destFile.delete();
    } catch {
      /* ignore */
    }
  }
  src.copy(destFile);
  console.warn(
    `[sessionStorage] copyVideoToSession: from="${sourceUri}" → "${dest}" exists=${destFile.exists}`,
  );
  return dest;
}

// ---------------------------------------------------------------------------
// Step 1 / 2 / 3 結果の JSON 永続化
// ---------------------------------------------------------------------------

function writeTextFile(uri: string, content: string) {
  const file = new File(uri);
  if (file.exists) {
    try {
      file.delete();
    } catch {
      /* ignore */
    }
  }
  file.create();
  file.write(content);
}

async function readTextFileIfExists(uri: string): Promise<string | null> {
  const file = new File(uri);
  if (!file.exists) return null;
  return await file.text();
}

export async function saveStep1Data(
  sessionFolder: string,
  data: Step1Data,
): Promise<void> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  writeTextFile(`${folder}step1_practice.json`, JSON.stringify(data, null, 2));
}

export async function saveStep2Data(
  sessionFolder: string,
  data: Step2Data,
): Promise<void> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  writeTextFile(`${folder}step2_roleplay.json`, JSON.stringify(data, null, 2));
}

export async function saveStep3Data(
  sessionFolder: string,
  data: Step3Data,
): Promise<void> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  writeTextFile(`${folder}step3_extension.json`, JSON.stringify(data, null, 2));

  let step1: Step1Data | null = null;
  let step2: Step2Data | null = null;
  try {
    const raw = await readTextFileIfExists(`${folder}step1_practice.json`);
    if (raw) step1 = JSON.parse(raw) as Step1Data;
  } catch {
    /* optional */
  }
  try {
    const raw = await readTextFileIfExists(`${folder}step2_roleplay.json`);
    if (raw) step2 = JSON.parse(raw) as Step2Data;
  } catch {
    /* optional */
  }

  const merged = {
    exportedAt: new Date().toISOString(),
    step1,
    step2,
    step3: data,
  };
  writeTextFile(`${folder}session_export.json`, JSON.stringify(merged, null, 2));
}

export function getStorageHintText(): string {
  return [
    'データはこのアプリの専用領域に保存されています（外部からは見えません）。',
    '学習ログ（テキスト）は残したまま、音声ファイルだけをゴミ箱で削除できます。',
  ].join('\n');
}

export async function shareSessionExport(sessionFolder: string): Promise<void> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  const path = `${folder}session_export.json`;
  const file = new File(path);
  if (!file.exists) {
    throw new Error('まとめファイル session_export.json が見つかりません');
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('この端末では共有が利用できません');
  }
  await Sharing.shareAsync(path, {
    mimeType: 'application/json',
    dialogTitle: 'Googleドライブなどに保存',
  });
}

// ---------------------------------------------------------------------------
// メディア (audio.* / 旧 video.*) の存在チェック / URI 解決 / 削除
// ---------------------------------------------------------------------------

function listFolderEntryNames(folder: string): string[] {
  const dir = new Directory(folder);
  if (!dir.exists) return [];
  return dir.list().map((entry) => entry.name);
}

export async function deleteSessionMediaFile(sessionFolder: string): Promise<boolean> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  const names = listFolderEntryNames(folder);
  let deleted = false;
  for (const name of names) {
    if (name.startsWith('audio.') || name.startsWith('video.')) {
      try {
        new File(`${folder}${name}`).delete();
        deleted = true;
      } catch (e) {
        console.warn(`[sessionStorage] deleteSessionMediaFile: ${name}`, e);
      }
    }
  }
  return deleted;
}

/** 後方互換: 旧名称。 */
export const deleteSessionVideoFile = deleteSessionMediaFile;

export async function hasSessionMedia(sessionFolder: string): Promise<boolean> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  const names = listFolderEntryNames(folder);
  return names.some((n) => n.startsWith('audio.') || n.startsWith('video.'));
}

/** 後方互換: 旧名称。 */
export const hasSessionVideo = hasSessionMedia;

/**
 * セッションフォルダ内のメディア URI を返す。audio.* を優先し、
 * 旧 video.* にフォールバック。見つからなければ null。
 */
export async function resolveSessionAudioUri(
  sessionFolder: string,
): Promise<string | null> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  const dir = new Directory(folder);
  if (!dir.exists) {
    console.warn(
      `[sessionStorage] resolveSessionAudioUri: folder missing — "${folder}"`,
    );
    return null;
  }
  const names = listFolderEntryNames(folder);
  let name = names.find((n) => n.startsWith('audio.'));
  if (!name) name = names.find((n) => n.startsWith('video.'));
  console.warn(
    `[sessionStorage] resolveSessionAudioUri: folder="${folder}" entries=${JSON.stringify(names)} picked=${name ?? 'null'}`,
  );
  if (!name) return null;
  const mediaUri = `${folder}${name}`;
  const mediaFile = new File(mediaUri);
  console.warn(
    `[sessionStorage] resolveSessionAudioUri: mediaUri="${mediaUri}" exists=${mediaFile.exists} size=${mediaFile.size ?? 'n/a'}`,
  );
  return mediaUri;
}

/** 後方互換: 旧名称。 */
export const resolveSessionVideoUri = resolveSessionAudioUri;

// ---------------------------------------------------------------------------
// Audio segments (word-level timestamps) の永続化
// ---------------------------------------------------------------------------

export interface StoredAudioSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

const SEGMENTS_FILE = 'segments.json';

export async function saveSegments(
  sessionFolder: string,
  segments: StoredAudioSegment[],
): Promise<void> {
  if (!sessionFolder || !segments || segments.length === 0) {
    console.warn(
      `[sessionStorage] saveSegments: skipped (sessionFolder=${!!sessionFolder}, len=${segments?.length ?? 0})`,
    );
    return;
  }
  try {
    const folder = await resolveSessionFolderPath(sessionFolder);
    const dir = new Directory(folder);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const path = `${folder}${SEGMENTS_FILE}`;
    writeTextFile(path, JSON.stringify(segments));
    const f = new File(path);
    console.warn(
      `[sessionStorage] saveSegments: wrote ${segments.length} to "${path}" exists=${f.exists} size=${f.size ?? 'n/a'}`,
    );
  } catch (e) {
    console.warn('[sessionStorage] saveSegments failed:', e);
  }
}

export async function loadSegments(
  sessionFolder: string,
): Promise<StoredAudioSegment[] | null> {
  if (!sessionFolder) return null;
  try {
    const folder = await resolveSessionFolderPath(sessionFolder);
    const path = `${folder}${SEGMENTS_FILE}`;
    const raw = await readTextFileIfExists(path);
    if (raw == null) {
      console.warn(`[sessionStorage] loadSegments: not found "${path}"`);
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    console.warn(
      `[sessionStorage] loadSegments: loaded ${parsed.length} from "${path}"`,
    );
    return parsed as StoredAudioSegment[];
  } catch (e) {
    console.warn('[sessionStorage] loadSegments failed:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Script (scriptTurns + speakers) の永続化
// ---------------------------------------------------------------------------

export interface StoredScript {
  scriptTurns: { speaker: string; text: string }[];
  speakers: string[];
}

const SCRIPT_FILE = 'script.json';

export async function saveScript(
  sessionFolder: string,
  scriptTurns: { speaker: string; text: string }[] | undefined,
  speakers: string[] | readonly string[] | undefined,
): Promise<void> {
  if (!sessionFolder) return;
  if (!scriptTurns || scriptTurns.length === 0) return;
  try {
    const folder = await resolveSessionFolderPath(sessionFolder);
    const dir = new Directory(folder);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const payload: StoredScript = {
      scriptTurns,
      speakers: speakers ? Array.from(speakers) : [],
    };
    const path = `${folder}${SCRIPT_FILE}`;
    writeTextFile(path, JSON.stringify(payload));
    const f = new File(path);
    console.warn(
      `[sessionStorage] saveScript: wrote ${scriptTurns.length} turns to "${path}" exists=${f.exists}`,
    );
  } catch (e) {
    console.warn('[sessionStorage] saveScript failed:', e);
  }
}

export async function loadScript(
  sessionFolder: string,
): Promise<StoredScript | null> {
  if (!sessionFolder) return null;
  try {
    const folder = await resolveSessionFolderPath(sessionFolder);
    const path = `${folder}${SCRIPT_FILE}`;
    const raw = await readTextFileIfExists(path);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as StoredScript;
    if (!parsed || !Array.isArray(parsed.scriptTurns)) return null;
    return parsed;
  } catch (e) {
    console.warn('[sessionStorage] loadScript failed:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// フォルダ検査 (デバッグ / 再入場時の欠落チェック用)
// ---------------------------------------------------------------------------

export async function inspectSessionFolder(sessionFolder: string): Promise<{
  exists: boolean;
  folder: string;
  entries: string[];
  hasAudio: boolean;
  hasSegments: boolean;
  hasScript: boolean;
}> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  const dir = new Directory(folder);
  if (!dir.exists) {
    return {
      exists: false,
      folder,
      entries: [],
      hasAudio: false,
      hasSegments: false,
      hasScript: false,
    };
  }
  const entries = dir.list().map((e) => e.name);
  return {
    exists: true,
    folder,
    entries,
    hasAudio: entries.some((n) => n.startsWith('audio.') || n.startsWith('video.')),
    hasSegments: entries.includes('segments.json'),
    hasScript: entries.includes('script.json'),
  };
}

// ---------------------------------------------------------------------------
// 完全削除
// ---------------------------------------------------------------------------

export async function deleteSessionFolder(sessionFolder: string): Promise<void> {
  const folder = await resolveSessionFolderPath(sessionFolder);
  const dir = new Directory(folder);
  if (!dir.exists) return;
  try {
    dir.delete();
  } catch (e) {
    console.warn('[sessionStorage] deleteSessionFolder failed:', e);
  }
}
