import * as SQLite from 'expo-sqlite';
import {
  extractSessionFolderName,
  deleteSessionMediaFile,
  deleteSessionFolder,
} from '../utils/sessionStorage';

const DB_NAME = 'english_trainer.db';

let _db: SQLite.SQLiteDatabase | null = null;
let _initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * データベースインスタンスを取得する（シングルトン）。
 * 同時に複数箇所から呼ばれても初期化は1回だけ走るようにガードする。
 */
export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    try {
      await db.execAsync('PRAGMA journal_mode = WAL;');
      await initializeSchema(db);
      _db = db;
      return db;
    } catch (e) {
      // 初期化失敗時はハンドルを閉じて、次回再試行できるようにする。
      try {
        await db.closeAsync();
      } catch {
        /* ignore */
      }
      _initPromise = null;
      throw e;
    }
  })();

  return _initPromise;
}

/**
 * 開発用: DB を完全にリセットする。
 * 新スキーマへ移行したがマイグレーションが通らない端末向けの緊急脱出口。
 */
export async function resetDatabase(): Promise<void> {
  try {
    if (_db) {
      try {
        await _db.closeAsync();
      } catch {
        /* ignore */
      }
    }
  } finally {
    _db = null;
    _initPromise = null;
  }
  try {
    await SQLite.deleteDatabaseAsync(DB_NAME);
  } catch (e) {
    console.warn('resetDatabase: deleteDatabaseAsync failed', e);
  }
}

/**
 * テーブルスキーマを初期化する。
 */
async function initializeSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  // Step 1: テーブルを作る（CREATE IF NOT EXISTS）。
  // 旧DB に sessions が既にある場合は何もしないので、新カラムは後続の ALTER で補う。
  await db.execAsync(`
    -- folders: ユーザーが作成する整理用フォルダー
    CREATE TABLE IF NOT EXISTS folders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- sessions: 動画ごとの学習セッション
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      video_url     TEXT    NOT NULL,
      transcript    TEXT    NOT NULL,
      summary       TEXT    NOT NULL,
      title         TEXT    DEFAULT NULL,
      language      TEXT    NOT NULL DEFAULT 'en',
      duration      REAL    NOT NULL DEFAULT 0,
      folder_path   TEXT    DEFAULT NULL,
      folder_id     INTEGER DEFAULT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- phrases: セッションに紐づく学習フレーズ
    CREATE TABLE IF NOT EXISTS phrases (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    INTEGER NOT NULL,
      phrase        TEXT    NOT NULL,
      translation   TEXT    NOT NULL,
      context       TEXT    NOT NULL,
      difficulty    TEXT    NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
      notes         TEXT    NOT NULL DEFAULT '',
      mastery_level INTEGER NOT NULL DEFAULT 0,
      practice_count INTEGER NOT NULL DEFAULT 0,
      last_practiced_at TEXT,
      order_index   INTEGER NOT NULL DEFAULT 0,
      is_saved      INTEGER NOT NULL DEFAULT 0,
      saved_at      TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- practice_logs: 各練習の記録（成長比較用）
    CREATE TABLE IF NOT EXISTS practice_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    INTEGER NOT NULL,
      step          TEXT    NOT NULL CHECK (step IN ('shadowing', 'roleplay', 'extension')),
      score         INTEGER,
      feedback      TEXT,
      transcript    TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  // Step 2: 旧DB のための不足カラム補完。
  // ここが先に走らないと、sessions(folder_id) へのインデックスが作れない。
  await ensureSessionColumns(db);
  await ensurePhrasesColumns(db);

  // Step 3: 全カラムが揃った状態でインデックスを作る。
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_phrases_session    ON phrases(session_id);
    CREATE INDEX IF NOT EXISTS idx_practice_session   ON practice_logs(session_id);
    CREATE INDEX IF NOT EXISTS idx_practice_step      ON practice_logs(step);
    CREATE INDEX IF NOT EXISTS idx_sessions_folder    ON sessions(folder_id);
  `);
}

/**
 * 古い DB を持つ端末向けに不足カラムを安全に追加する。
 */
async function ensureSessionColumns(db: SQLite.SQLiteDatabase): Promise<void> {
  const rows = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(sessions)',
  );
  const names = new Set(rows.map((r) => r.name));

  const addColumn = async (col: string, ddl: string) => {
    if (names.has(col)) return;
    try {
      await db.execAsync(ddl);
      names.add(col);
    } catch (e) {
      // 並行起動・部分適用済みなどで「duplicate column」になっても続行できるようにする。
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate column/i.test(msg)) {
        names.add(col);
        return;
      }
      console.warn(`ensureSessionColumns: failed to add ${col}`, e);
      throw e;
    }
  };

  await addColumn(
    'folder_path',
    'ALTER TABLE sessions ADD COLUMN folder_path TEXT DEFAULT NULL',
  );
  await addColumn(
    'folder_id',
    'ALTER TABLE sessions ADD COLUMN folder_id INTEGER DEFAULT NULL',
  );
  await addColumn(
    'title',
    'ALTER TABLE sessions ADD COLUMN title TEXT DEFAULT NULL',
  );
  // Step 1 のカスタマイズ状態（どのフレーズを残したか、どの話者を選んだか）を
  // 永続化するための列。次回 SessionDetail → Practice で再入場した時に
  // 前回の編集状態をそのまま復元できる。
  await addColumn(
    'selected_speaker',
    'ALTER TABLE sessions ADD COLUMN selected_speaker TEXT DEFAULT NULL',
  );
  await addColumn(
    'active_phrases',
    'ALTER TABLE sessions ADD COLUMN active_phrases TEXT DEFAULT NULL',
  );
}

/**
 * 旧 DB に phrases.order_index を追加する。既存行は id 昇順 = 挿入順に並ぶよう
 * order_index = id で初期化する。これで Step 1 の並び替えに対応できる。
 */
async function ensurePhrasesColumns(db: SQLite.SQLiteDatabase): Promise<void> {
  const rows = await db.getAllAsync<{ name: string }>(
    'PRAGMA table_info(phrases)',
  );
  const names = new Set(rows.map((r) => r.name));

  const addColumn = async (col: string, ddl: string, after?: () => Promise<void>) => {
    if (names.has(col)) return;
    try {
      await db.execAsync(ddl);
      names.add(col);
      if (after) await after();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate column/i.test(msg)) {
        names.add(col);
        return;
      }
      console.warn(`ensurePhrasesColumns: failed to add ${col}`, e);
    }
  };

  await addColumn(
    'order_index',
    'ALTER TABLE phrases ADD COLUMN order_index INTEGER NOT NULL DEFAULT 0',
    async () => {
      await db.execAsync('UPDATE phrases SET order_index = id WHERE order_index = 0');
    },
  );
  await addColumn(
    'is_saved',
    'ALTER TABLE phrases ADD COLUMN is_saved INTEGER NOT NULL DEFAULT 0',
  );
  await addColumn(
    'saved_at',
    'ALTER TABLE phrases ADD COLUMN saved_at TEXT',
  );
}

// ---------------------------------------------------------------------------
// CRUD ヘルパー
// ---------------------------------------------------------------------------

import type { ExtractedPhrase, TranscriptionResult, PhraseExtractionResult } from '../types/ai';

/** セッションを作成し、フレーズを一括保存する */
export async function createSession(
  videoUrl: string,
  transcription: TranscriptionResult,
  extraction: PhraseExtractionResult,
): Promise<number> {
  const db = await getDatabase();

  const result = await db.runAsync(
    `INSERT INTO sessions (video_url, transcript, summary, language, duration)
     VALUES (?, ?, ?, ?, ?)`,
    videoUrl,
    transcription.text,
    extraction.summary,
    transcription.language,
    transcription.duration,
  );

  const sessionId = result.lastInsertRowId;

  // フレーズを一括挿入
  for (const phrase of extraction.phrases) {
    await db.runAsync(
      `INSERT INTO phrases (session_id, phrase, translation, context, difficulty, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sessionId,
      phrase.phrase,
      phrase.translation,
      phrase.context,
      phrase.difficulty,
      phrase.notes,
    );
  }

  return sessionId;
}

/**
 * Practice 画面用: フレーズ文字列配列から軽量セッションを作成する。
 * OCR / テキスト入力フローなど、TranscriptionResult を持たない場合に使う。
 *
 * 第1段階（初期保存）で呼ばれる想定。HomeScreen で音声解析完了直後に
 * すでにレコードを作り、その後の Step 1〜3 の結果は UPDATE で上書きする。
 */
export interface CreateSessionInit {
  phrases: string[];
  phrasesWithTranslation?: { phrase: string; translation: string }[];
  transcript?: string;
  summary?: string;
  folderPath?: string;
  language?: string;
  duration?: number;
  folderId?: number | null;
}

export async function createSessionFromPhrases(
  phrasesOrInit: string[] | CreateSessionInit,
  legacyTranscript?: string,
  legacySummary?: string,
  legacyFolderPath?: string,
): Promise<number> {
  // 旧シグネチャ (phrases, transcript, summary, folderPath) と新シグネチャ (init) の両対応。
  const init: CreateSessionInit = Array.isArray(phrasesOrInit)
    ? {
        phrases: phrasesOrInit,
        transcript: legacyTranscript,
        summary: legacySummary,
        folderPath: legacyFolderPath,
      }
    : phrasesOrInit;

  const { phrases, phrasesWithTranslation, transcript, summary, folderPath, language, duration, folderId } = init;

  const db = await getDatabase();

  // DB には絶対パスではなく「フォルダ名のみ」を格納する（iOS の
  // documentDirectory 配下の UUID がアプリ再起動で変わるため、絶対パスは
  // 起動のたびに無効になる）。再生時は sessionStorage 側で現在の
  // documentDirectory と結合し直す。
  let folderNameForDb: string | null = null;
  if (folderPath) {
    const name = extractSessionFolderName(folderPath);
    folderNameForDb = name && name.length > 0 ? name : null;
  }

  let result;
  try {
    result = await db.runAsync(
      `INSERT INTO sessions (video_url, transcript, summary, language, duration, folder_path, folder_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'local',
      transcript ?? phrases.join('\n'),
      summary ?? 'Practice session',
      language ?? 'en',
      duration ?? 0,
      folderNameForDb,
      folderId ?? null,
    );
  } catch (e) {
    // folder_id がまだ無い超旧 DB でのみフォールバック。folder_path は必ず保存する
    // ことで、再入場時に音声フォルダが見つからなくなるバグを防ぐ。
    console.warn(
      'createSessionFromPhrases: 7-column insert failed, retrying with folder_path only',
      e,
    );
    try {
      result = await db.runAsync(
        `INSERT INTO sessions (video_url, transcript, summary, language, duration, folder_path)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'local',
        transcript ?? phrases.join('\n'),
        summary ?? 'Practice session',
        language ?? 'en',
        duration ?? 0,
        folderNameForDb,
      );
    } catch (e2) {
      // folder_path 列もまだ無い最古の DB: ここで初めてフォルダ情報なしで保存。
      // この場合は再入場時に音声が出ないため、マイグレーションのやり直しが必要。
      console.warn(
        'createSessionFromPhrases: 6-column insert also failed, inserting bare row (folder lost!)',
        e2,
      );
      result = await db.runAsync(
        `INSERT INTO sessions (video_url, transcript, summary, language, duration)
         VALUES (?, ?, ?, ?, ?)`,
        'local',
        transcript ?? phrases.join('\n'),
        summary ?? 'Practice session',
        language ?? 'en',
        duration ?? 0,
      );
    }
  }

  const sessionId = result.lastInsertRowId;

  // folder_path が実際に書き込まれたか念のため確認。万が一 null なら UPDATE で修復する。
  if (folderNameForDb) {
    try {
      const check = await db.getAllAsync<{ folder_path: string | null }>(
        'SELECT folder_path FROM sessions WHERE id = ?',
        sessionId,
      );
      if (check[0] && !check[0].folder_path) {
        console.warn(
          'createSessionFromPhrases: folder_path was NULL after INSERT, patching with UPDATE',
        );
        await db.runAsync(
          `UPDATE sessions SET folder_path = ? WHERE id = ?`,
          folderNameForDb,
          sessionId,
        );
      }
    } catch (e) {
      console.warn('createSessionFromPhrases: folder_path verification failed', e);
    }
  }

  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    const translation = phrasesWithTranslation?.[i]?.translation ?? '';
    try {
      await db.runAsync(
        `INSERT INTO phrases (session_id, phrase, translation, context, difficulty, notes, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        phrase,
        translation,
        '',
        'intermediate',
        '',
        i + 1,
      );
    } catch (e) {
      // order_index 列が無い古い DB での fallback
      console.warn('createSessionFromPhrases: insert with order_index failed, retrying without', e);
      await db.runAsync(
        `INSERT INTO phrases (session_id, phrase, translation, context, difficulty, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        sessionId,
        phrase,
        translation,
        '',
        'intermediate',
        '',
      );
    }
  }

  return sessionId;
}

/**
 * セッション内のフレーズの並び順を UPDATE する。
 * orderedPhraseIds の先頭から順に order_index = 1, 2, 3... を振り直す。
 */
export async function updatePhrasesOrder(
  sessionId: number,
  orderedPhraseIds: number[],
): Promise<void> {
  if (orderedPhraseIds.length === 0) return;
  const db = await getDatabase();
  for (let i = 0; i < orderedPhraseIds.length; i++) {
    try {
      await db.runAsync(
        'UPDATE phrases SET order_index = ? WHERE id = ? AND session_id = ?',
        i + 1,
        orderedPhraseIds[i],
        sessionId,
      );
    } catch (e) {
      console.warn('updatePhrasesOrder: row update failed', e);
    }
  }
}

/**
 * 第2段階（上書き更新）用: 既存セッションのメタ情報を UPDATE する。
 * Step 1〜3 の完了時に呼ばれる想定。新規 INSERT はせず常に上書き。
 */
export interface UpdateSessionMetadata {
  transcript?: string;
  summary?: string;
  language?: string;
  duration?: number;
  folderPath?: string;
  folderId?: number | null;
}

export async function updateSessionMetadata(
  sessionId: number,
  meta: UpdateSessionMetadata,
): Promise<void> {
  const db = await getDatabase();
  const sets: string[] = [];
  const args: unknown[] = [];
  if (meta.transcript !== undefined) {
    sets.push('transcript = ?');
    args.push(meta.transcript);
  }
  if (meta.summary !== undefined) {
    sets.push('summary = ?');
    args.push(meta.summary);
  }
  if (meta.language !== undefined) {
    sets.push('language = ?');
    args.push(meta.language);
  }
  if (meta.duration !== undefined) {
    sets.push('duration = ?');
    args.push(meta.duration);
  }
  if (meta.folderPath !== undefined) {
    const { extractSessionFolderName } = await import('../utils/sessionStorage');
    const name = meta.folderPath
      ? extractSessionFolderName(meta.folderPath)
      : null;
    sets.push('folder_path = ?');
    args.push(name && name.length > 0 ? name : null);
  }
  if (meta.folderId !== undefined) {
    sets.push('folder_id = ?');
    args.push(meta.folderId);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  args.push(sessionId);
  await db.runAsync(
    `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`,
    ...(args as (string | number | null)[]),
  );
}

/** セッション一覧を取得する（新しい順） */
export async function getSessions(): Promise<SessionRow[]> {
  const db = await getDatabase();
  return await db.getAllAsync<SessionRow>(
    'SELECT * FROM sessions ORDER BY created_at DESC',
  );
}

/** History 用: 各セッションの最高スコアと最終更新を一覧取得する */
export interface SessionHistoryRow extends SessionRow {
  best_score: number | null;
  last_practiced_at: string | null;
  /** 表示用タイトル（ユーザー指定 title > summary > 先頭フレーズ の優先順） */
  display_title: string;
}

type RawSessionWithScore = SessionRow & {
  best_score: number | null;
  last_practiced_at: string | null;
};

function computeDisplayTitle(row: SessionRow): string {
  if (row.title && row.title.trim().length > 0) return row.title.trim();
  if (row.summary && row.summary !== 'Practice session') return row.summary;
  const firstPhrase = row.transcript.split('\n').find((l) => l.trim().length > 0) ?? '';
  return firstPhrase ? firstPhrase.slice(0, 60) : '無題の練習';
}

/**
 * 全セッションを最高スコア・最終更新付きで取得する。
 * folderId を指定すると、そのフォルダに属するものだけ返す。
 * folderId === null を指定すると「未分類」のみ。
 * 指定しない (undefined) と全件。
 */
export async function getSessionsWithBestScores(
  folderId?: number | null,
): Promise<SessionHistoryRow[]> {
  const db = await getDatabase();
  const where =
    folderId === undefined
      ? ''
      : folderId === null
        ? 'WHERE s.folder_id IS NULL'
        : 'WHERE s.folder_id = ?';
  const sql = `SELECT s.*,
          (SELECT MAX(score) FROM practice_logs pl WHERE pl.session_id = s.id) AS best_score,
          (SELECT MAX(created_at) FROM practice_logs pl WHERE pl.session_id = s.id) AS last_practiced_at
     FROM sessions s
     ${where}
    ORDER BY COALESCE(
               (SELECT MAX(created_at) FROM practice_logs pl WHERE pl.session_id = s.id),
               s.created_at
             ) DESC`;

  const rows =
    folderId === undefined || folderId === null
      ? await db.getAllAsync<RawSessionWithScore>(sql)
      : await db.getAllAsync<RawSessionWithScore>(sql, folderId);

  return rows.map((r) => ({
    ...r,
    display_title: computeDisplayTitle(r),
  }));
}

/**
 * セッションのユーザー指定タイトルを更新する。
 */
export async function updateSessionTitle(
  sessionId: number,
  title: string,
): Promise<void> {
  const db = await getDatabase();
  const trimmed = title.trim();
  await db.runAsync(
    `UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`,
    trimmed.length === 0 ? null : trimmed,
    sessionId,
  );
}

/**
 * セッションをフォルダーに移動する（null で未分類に戻す）。
 */
export async function moveSessionToFolder(
  sessionId: number,
  folderId: number | null,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE sessions SET folder_id = ?, updated_at = datetime('now') WHERE id = ?`,
    folderId,
    sessionId,
  );
}

// ---------------------------------------------------------------------------
// Folders CRUD
// ---------------------------------------------------------------------------

export interface FolderRow {
  id: number;
  name: string;
  created_at: string;
}

export interface FolderWithCountRow extends FolderRow {
  session_count: number;
}

export async function listFolders(): Promise<FolderRow[]> {
  const db = await getDatabase();
  return db.getAllAsync<FolderRow>(
    'SELECT * FROM folders ORDER BY created_at DESC',
  );
}

/** フォルダー一覧（各フォルダー内のセッション数付き） */
export async function listFoldersWithCounts(): Promise<FolderWithCountRow[]> {
  const db = await getDatabase();
  return db.getAllAsync<FolderWithCountRow>(
    `SELECT f.*,
            (SELECT COUNT(*) FROM sessions s WHERE s.folder_id = f.id) AS session_count
       FROM folders f
      ORDER BY f.created_at DESC`,
  );
}

export async function createFolder(name: string): Promise<number> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('フォルダー名を入力してください');
  const db = await getDatabase();
  const result = await db.runAsync(
    'INSERT INTO folders (name) VALUES (?)',
    trimmed,
  );
  return result.lastInsertRowId;
}

export async function renameFolder(id: number, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('フォルダー名を入力してください');
  const db = await getDatabase();
  await db.runAsync('UPDATE folders SET name = ? WHERE id = ?', trimmed, id);
}

/**
 * フォルダーを削除する。中のセッションは未分類に戻る（削除されない）。
 */
export async function deleteFolder(id: number): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE sessions SET folder_id = NULL WHERE folder_id = ?',
    id,
  );
  await db.runAsync('DELETE FROM folders WHERE id = ?', id);
}

export async function getFolder(id: number): Promise<FolderRow | null> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<FolderRow>(
    'SELECT * FROM folders WHERE id = ?',
    id,
  );
  return rows[0] ?? null;
}

/** セッション 1 件とフレーズ・練習ログを一括取得する（SessionDetail 用） */
export async function getSessionWithDetails(sessionId: number): Promise<{
  session: SessionRow | null;
  phrases: PhraseRow[];
  logs: PracticeLogRow[];
} | null> {
  const db = await getDatabase();
  const sessions = await db.getAllAsync<SessionRow>(
    'SELECT * FROM sessions WHERE id = ?',
    sessionId,
  );
  if (sessions.length === 0) return null;
  const phrases = await db.getAllAsync<PhraseRow>(
    'SELECT * FROM phrases WHERE session_id = ? ORDER BY order_index, id',
    sessionId,
  );
  const logs = await db.getAllAsync<PracticeLogRow>(
    'SELECT * FROM practice_logs WHERE session_id = ? ORDER BY created_at DESC',
    sessionId,
  );
  return { session: sessions[0], phrases, logs };
}

/** セッションに紐づくフレーズを取得する */
export async function getPhrasesForSession(sessionId: number): Promise<PhraseRow[]> {
  const db = await getDatabase();
  return await db.getAllAsync<PhraseRow>(
    'SELECT * FROM phrases WHERE session_id = ? ORDER BY order_index, id',
    sessionId,
  );
}

/**
 * フレーズの英文・和訳テキストを書き換える (Step 1 で編集されたとき用)。
 * 翻訳は省略可能。null を渡せば空文字で更新。
 */
export async function updatePhraseText(
  phraseId: number,
  phrase: string,
  translation?: string | null,
): Promise<void> {
  const db = await getDatabase();
  if (translation === undefined) {
    await db.runAsync(
      `UPDATE phrases SET phrase = ? WHERE id = ?`,
      phrase,
      phraseId,
    );
  } else {
    await db.runAsync(
      `UPDATE phrases SET phrase = ?, translation = ? WHERE id = ?`,
      phrase,
      translation ?? '',
      phraseId,
    );
  }
}

/**
 * Step1 で「フレーズリスト」に保存／解除する。
 * is_saved を 1/0 にトグルし、saved_at を更新する。
 */
export async function setPhraseSaved(
  phraseId: number,
  saved: boolean,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE phrases
       SET is_saved = ?, saved_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
     WHERE id = ?`,
    saved ? 1 : 0,
    saved ? 1 : 0,
    phraseId,
  );
}

/**
 * 「フレーズリスト」タブ用: 保存済みフレーズを横断的に取得する。
 * 元セッションのタイトル（無ければ summary）を JOIN して付ける。
 */
export async function listSavedPhrases(): Promise<SavedPhraseRow[]> {
  const db = await getDatabase();
  return await db.getAllAsync<SavedPhraseRow>(
    `SELECT p.*, s.title AS session_title, s.summary AS session_summary
       FROM phrases p
       JOIN sessions s ON s.id = p.session_id
      WHERE p.is_saved = 1
      ORDER BY p.saved_at DESC, p.id DESC`,
  );
}

/**
 * Echo Trigger 専用セッションを 1 件確保して id を返す（無ければ作る）。
 * 外出中の音声入力をすべて 1 つのセッションにまとめておくことで、
 * 既存のフォルダー画面・SessionDetail からも履歴が辿れるようにする。
 *
 * 識別子: video_url = 'echo_trigger://inbox'
 */
const ECHO_SESSION_MARKER = 'echo_trigger://inbox';

async function getOrCreateEchoSession(): Promise<number> {
  const db = await getDatabase();
  const existing = await db.getAllAsync<{ id: number }>(
    'SELECT id FROM sessions WHERE video_url = ? LIMIT 1',
    ECHO_SESSION_MARKER,
  );
  if (existing[0]) return existing[0].id;

  const result = await db.runAsync(
    `INSERT INTO sessions (video_url, transcript, summary, title, language, duration)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ECHO_SESSION_MARKER,
    '',
    'Echo Trigger',
    'Echo Trigger',
    'en',
    0,
  );
  return result.lastInsertRowId;
}

/**
 * Echo Trigger で生成したフレーズを保存する。
 * - phrase: Claude が生成した自然な英語表現
 * - intent: ユーザーが録音した元の意図（日本語 or 拙い英語）
 * - savedToList: 既定 true。フレーズリストにも即時表示する。
 *
 * 戻り値は新しい phrase 行の id。
 */
export async function addEchoPhrase(
  phrase: string,
  intent: string,
  savedToList: boolean = true,
): Promise<number> {
  const db = await getDatabase();
  const sessionId = await getOrCreateEchoSession();
  const result = await db.runAsync(
    `INSERT INTO phrases
       (session_id, phrase, translation, context, difficulty, notes, is_saved, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${savedToList ? "datetime('now')" : 'NULL'})`,
    sessionId,
    phrase,
    intent,
    'Echo Trigger',
    'intermediate',
    '',
    savedToList ? 1 : 0,
  );
  return result.lastInsertRowId;
}

/** フレーズの練習状況を更新する */
export async function updatePhraseMastery(
  phraseId: number,
  masteryLevel: number,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE phrases
     SET mastery_level = ?, practice_count = practice_count + 1, last_practiced_at = datetime('now')
     WHERE id = ?`,
    masteryLevel,
    phraseId,
  );
}

/** 練習ログを記録する */
export async function insertPracticeLog(
  sessionId: number,
  step: 'shadowing' | 'roleplay' | 'extension',
  score: number | null,
  feedback: string | null,
  transcript: string | null,
): Promise<number> {
  const db = await getDatabase();
  const result = await db.runAsync(
    `INSERT INTO practice_logs (session_id, step, score, feedback, transcript)
     VALUES (?, ?, ?, ?, ?)`,
    sessionId,
    step,
    score,
    feedback,
    transcript,
  );
  return result.lastInsertRowId;
}

/** 特定ステップの練習ログ履歴を取得する（成長比較用） */
export async function getPracticeLogs(
  sessionId: number,
  step: 'shadowing' | 'roleplay' | 'extension',
): Promise<PracticeLogRow[]> {
  const db = await getDatabase();
  return await db.getAllAsync<PracticeLogRow>(
    'SELECT * FROM practice_logs WHERE session_id = ? AND step = ? ORDER BY created_at DESC',
    sessionId,
    step,
  );
}

/**
 * Step 1 (Practice) のカスタマイズ状態。
 * - selectedSpeaker: Roleplay で演じる話者の index（未選択なら null）
 * - activePhrases : 削除されずに残ったフレーズの index 配列（null なら全件が残っている扱い）
 * - speakerAssign : 各フレーズに割り当てられた話者の index 配列（-1 は未割当）
 */
export interface PracticeCustomizationState {
  selectedSpeaker: number | null;
  activePhrases: number[] | null;
  speakerAssign: number[] | null;
}

export async function saveSessionPracticeState(
  sessionId: number,
  state: PracticeCustomizationState,
): Promise<void> {
  const db = await getDatabase();
  const speakerStr =
    state.selectedSpeaker == null || !Number.isFinite(state.selectedSpeaker)
      ? null
      : String(state.selectedSpeaker);
  const blob = JSON.stringify({
    activePhrases: state.activePhrases ?? null,
    speakerAssign: state.speakerAssign ?? null,
  });
  try {
    await db.runAsync(
      `UPDATE sessions
         SET selected_speaker = ?, active_phrases = ?, updated_at = datetime('now')
       WHERE id = ?`,
      speakerStr,
      blob,
      sessionId,
    );
  } catch (e) {
    // 旧スキーマ（列が無い）環境で落ちないように吸収する。
    console.warn('saveSessionPracticeState: update failed', e);
  }
}

export async function loadSessionPracticeState(
  sessionId: number,
): Promise<PracticeCustomizationState | null> {
  const db = await getDatabase();
  let rows: { selected_speaker: string | null; active_phrases: string | null }[] = [];
  try {
    rows = await db.getAllAsync<{
      selected_speaker: string | null;
      active_phrases: string | null;
    }>(
      'SELECT selected_speaker, active_phrases FROM sessions WHERE id = ?',
      sessionId,
    );
  } catch (e) {
    // マイグレーション前の DB では列が存在しない。
    console.warn('loadSessionPracticeState: select failed', e);
    return null;
  }
  if (rows.length === 0) return null;

  const row = rows[0];
  let selectedSpeaker: number | null = null;
  if (row.selected_speaker != null && row.selected_speaker !== '') {
    const n = Number(row.selected_speaker);
    if (Number.isFinite(n)) selectedSpeaker = n;
  }
  let activePhrases: number[] | null = null;
  let speakerAssign: number[] | null = null;
  if (row.active_phrases) {
    try {
      const parsed = JSON.parse(row.active_phrases);
      if (parsed && Array.isArray(parsed.activePhrases)) {
        activePhrases = parsed.activePhrases.filter(
          (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v),
        );
      }
      if (parsed && Array.isArray(parsed.speakerAssign)) {
        speakerAssign = parsed.speakerAssign.map((v: unknown) =>
          typeof v === 'number' && Number.isFinite(v) ? v : -1,
        );
      }
    } catch (e) {
      console.warn('loadSessionPracticeState: parse failed', e);
    }
  }
  return { selectedSpeaker, activePhrases, speakerAssign };
}

/**
 * セッションのメディア (audio.* / 旧 video.*) だけ削除してテキスト履歴は残す。
 * - phrases / practice_logs / step*_*.json はそのまま残す
 * - folder_path は残す（JSON ログがまだフォルダに入っているため）
 * - UI 側では hasSessionMedia で再生可能かを判定する
 */
export async function clearSessionMedia(sessionId: number): Promise<void> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ folder_path: string | null }>(
    'SELECT folder_path FROM sessions WHERE id = ?',
    sessionId,
  );
  const folder = rows[0]?.folder_path;
  if (folder) {
    try {
      await deleteSessionMediaFile(folder);
    } catch (e) {
      console.warn('clearSessionMedia: failed to delete media file', e);
    }
  }
}

/** 後方互換: 旧名称 `clearSessionVideo` は内部で `clearSessionMedia` を呼ぶ。 */
export const clearSessionVideo = clearSessionMedia;

/**
 * セッションごと削除する（動画 + テキスト履歴すべて）。
 * sessions 行を削除すると phrases / practice_logs も ON DELETE CASCADE で消える。
 */
export async function deleteSessionCompletely(sessionId: number): Promise<void> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ folder_path: string | null }>(
    'SELECT folder_path FROM sessions WHERE id = ?',
    sessionId,
  );
  const folder = rows[0]?.folder_path;
  if (folder) {
    try {
      await deleteSessionFolder(folder);
    } catch (e) {
      console.warn('deleteSessionCompletely: failed to delete folder', e);
    }
  }
  await db.runAsync('DELETE FROM sessions WHERE id = ?', sessionId);
}

// ---------------------------------------------------------------------------
// Row 型定義
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: number;
  video_url: string;
  transcript: string;
  summary: string;
  /** ユーザーが手で変更できる表示名（null なら summary から自動生成） */
  title: string | null;
  language: string;
  duration: number;
  folder_path: string | null;
  /** 属するフォルダー。null の場合は「未分類」 */
  folder_id: number | null;
  /** Step 1 でユーザーが選択した話者インデックス（stringify された number） */
  selected_speaker: string | null;
  /**
   * Step 1 の「残っているフレーズ」と「各フレーズへの話者割当」を JSON で保存したもの。
   * 形式: {"activePhrases":[0,2,3],"speakerAssign":[0,-1,1,0]}
   */
  active_phrases: string | null;
  created_at: string;
  updated_at: string;
}

export interface PhraseRow {
  id: number;
  session_id: number;
  phrase: string;
  translation: string;
  context: string;
  difficulty: string;
  notes: string;
  mastery_level: number;
  practice_count: number;
  last_practiced_at: string | null;
  is_saved: number;
  saved_at: string | null;
  created_at: string;
}

/** 「フレーズリスト」タブで表示する、横断的な保存フレーズ行（元セッションのタイトル付き）。 */
export interface SavedPhraseRow extends PhraseRow {
  session_title: string | null;
  session_summary: string;
}

export interface PracticeLogRow {
  id: number;
  session_id: number;
  step: string;
  score: number | null;
  feedback: string | null;
  transcript: string | null;
  created_at: string;
}
