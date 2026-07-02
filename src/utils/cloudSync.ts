// ---------------------------------------------------------------------------
// cloudSync — Supabase へのバックアップ / 復元
//
//   backupAll()  : ローカル SQLite + セッションフォルダの内容を Supabase へ
//                  スナップショット同期する（クラウド側は上書き。ローカルで
//                  消したセッションはクラウドに残る = バックアップ的挙動）。
//   restoreAll() : クラウドにあってローカルに無いフォルダー/セッションを
//                  端末に復元する（音声・スクリプト・タイムスタンプ込み）。
//
//   対応付けは端末で採番する sync_uuid (sessions.sync_uuid / folders.sync_uuid)。
//   音声は Storage バケット et-audio の {userId}/{sessionUuid}.m4a に置く。
// ---------------------------------------------------------------------------

import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Directory } from 'expo-file-system';
import { decode as decodeBase64 } from 'base64-arraybuffer';
import { supabase } from '../lib/supabase';
import { getDatabase } from '../db/schema';
import type { FolderRow, PhraseRow, PracticeLogRow, SessionRow } from '../db/schema';
import {
  createSessionFolder,
  extractSessionFolderName,
  loadScript,
  loadSegments,
  resolveSessionAudioUri,
  resolveSessionFolderPath,
  saveScript,
  saveSegments,
  type StoredAudioSegment,
  type StoredScript,
} from './sessionStorage';

const LAST_BACKUP_KEY = 'englishTrainer.cloudSync.lastBackupAt';
const AUTO_BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------------

/** Hermes に crypto.randomUUID が無い環境でも動く UUIDv4 */
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** SQLite の 'YYYY-MM-DD HH:MM:SS' (UTC) → ISO8601 */
function sqliteToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  if (s.includes('T')) return s;
  return `${s.replace(' ', 'T')}Z`;
}

/** ISO8601 → SQLite の 'YYYY-MM-DD HH:MM:SS' */
function isoToSqlite(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export async function getCurrentUser(): Promise<{ id: string; email: string | null } | null> {
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  if (!user) return null;
  return { id: user.id, email: user.email ?? null };
}

export async function getLastBackupAt(): Promise<Date | null> {
  const raw = await AsyncStorage.getItem(LAST_BACKUP_KEY);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// sync_uuid の採番
// ---------------------------------------------------------------------------

async function ensureSyncUuids(): Promise<void> {
  const db = await getDatabase();
  const folders = await db.getAllAsync<{ id: number }>(
    "SELECT id FROM folders WHERE sync_uuid IS NULL OR sync_uuid = ''",
  );
  for (const f of folders) {
    await db.runAsync('UPDATE folders SET sync_uuid = ? WHERE id = ?', uuidv4(), f.id);
  }
  const sessions = await db.getAllAsync<{ id: number }>(
    "SELECT id FROM sessions WHERE sync_uuid IS NULL OR sync_uuid = ''",
  );
  for (const s of sessions) {
    await db.runAsync('UPDATE sessions SET sync_uuid = ? WHERE id = ?', uuidv4(), s.id);
  }
}

// ---------------------------------------------------------------------------
// バックアップ (ローカル → クラウド)
// ---------------------------------------------------------------------------

export interface BackupResult {
  folders: number;
  sessions: number;
  audiosUploaded: number;
}

export async function backupAll(): Promise<BackupResult> {
  const user = await getCurrentUser();
  if (!user) throw new Error('ログインしていません');

  await ensureSyncUuids();
  const db = await getDatabase();

  // ----- folders -----
  const folders = await db.getAllAsync<FolderRow>('SELECT * FROM folders');
  if (folders.length > 0) {
    const { error } = await supabase.from('et_folders').upsert(
      folders.map((f) => ({
        sync_uuid: f.sync_uuid,
        user_id: user.id,
        name: f.name,
        created_at: sqliteToIso(f.created_at),
        updated_at: new Date().toISOString(),
      })),
    );
    if (error) throw new Error(`フォルダーの同期に失敗: ${error.message}`);
  }
  const folderUuidById = new Map<number, string>();
  for (const f of folders) {
    if (f.sync_uuid) folderUuidById.set(f.id, f.sync_uuid);
  }

  // ----- sessions (script / segments 込み) -----
  const sessions = await db.getAllAsync<SessionRow>('SELECT * FROM sessions');
  const sessionRows = [];
  for (const s of sessions) {
    let script: StoredScript | null = null;
    let segments: StoredAudioSegment[] | null = null;
    if (s.folder_path) {
      script = await loadScript(s.folder_path);
      segments = await loadSegments(s.folder_path);
    }
    sessionRows.push({
      sync_uuid: s.sync_uuid,
      user_id: user.id,
      folder_sync_uuid: s.folder_id != null ? folderUuidById.get(s.folder_id) ?? null : null,
      video_url: s.video_url,
      transcript: s.transcript,
      summary: s.summary,
      title: s.title,
      language: s.language,
      duration: s.duration,
      selected_speaker: s.selected_speaker,
      active_phrases: s.active_phrases,
      script_json: script,
      segments_json: segments,
      created_at: sqliteToIso(s.created_at),
      updated_at: new Date().toISOString(),
    });
  }
  if (sessionRows.length > 0) {
    // audio_path はクラウド側の既存値を保持したいので upsert 対象に含めない
    const { error } = await supabase.from('et_sessions').upsert(sessionRows);
    if (error) throw new Error(`セッションの同期に失敗: ${error.message}`);
  }

  const sessionUuids = sessions
    .map((s) => s.sync_uuid)
    .filter((u): u is string => !!u);

  // ----- phrases / practice_logs: セッション単位で総入れ替え -----
  if (sessionUuids.length > 0) {
    const uuidBySessionId = new Map<number, string>();
    for (const s of sessions) {
      if (s.sync_uuid) uuidBySessionId.set(s.id, s.sync_uuid);
    }

    const { error: delPhrasesErr } = await supabase
      .from('et_phrases')
      .delete()
      .in('session_sync_uuid', sessionUuids);
    if (delPhrasesErr) throw new Error(`フレーズの同期に失敗: ${delPhrasesErr.message}`);

    const phrases = await db.getAllAsync<PhraseRow>('SELECT * FROM phrases');
    const phraseRows = phrases
      .filter((p) => uuidBySessionId.has(p.session_id))
      .map((p) => ({
        user_id: user.id,
        session_sync_uuid: uuidBySessionId.get(p.session_id)!,
        phrase: p.phrase,
        translation: p.translation,
        context: p.context,
        difficulty: p.difficulty,
        notes: p.notes,
        mastery_level: p.mastery_level,
        practice_count: p.practice_count,
        last_practiced_at: sqliteToIso(p.last_practiced_at),
        is_saved: p.is_saved === 1,
        saved_at: sqliteToIso(p.saved_at),
        order_index: (p as PhraseRow & { order_index?: number }).order_index ?? 0,
        created_at: sqliteToIso(p.created_at),
      }));
    if (phraseRows.length > 0) {
      const { error } = await supabase.from('et_phrases').insert(phraseRows);
      if (error) throw new Error(`フレーズの同期に失敗: ${error.message}`);
    }

    const { error: delLogsErr } = await supabase
      .from('et_practice_logs')
      .delete()
      .in('session_sync_uuid', sessionUuids);
    if (delLogsErr) throw new Error(`練習ログの同期に失敗: ${delLogsErr.message}`);

    const logs = await db.getAllAsync<PracticeLogRow>('SELECT * FROM practice_logs');
    const logRows = logs
      .filter((l) => uuidBySessionId.has(l.session_id))
      .map((l) => ({
        user_id: user.id,
        session_sync_uuid: uuidBySessionId.get(l.session_id)!,
        step: l.step,
        score: l.score,
        feedback: l.feedback,
        transcript: l.transcript,
        created_at: sqliteToIso(l.created_at),
      }));
    if (logRows.length > 0) {
      const { error } = await supabase.from('et_practice_logs').insert(logRows);
      if (error) throw new Error(`練習ログの同期に失敗: ${error.message}`);
    }
  }

  // ----- audio: クラウド未アップロードのものだけ送る -----
  let audiosUploaded = 0;
  const { data: cloudSessions, error: cloudErr } = await supabase
    .from('et_sessions')
    .select('sync_uuid, audio_path')
    .eq('user_id', user.id);
  if (cloudErr) throw new Error(`クラウド状態の取得に失敗: ${cloudErr.message}`);
  const cloudAudioByUuid = new Map(
    (cloudSessions ?? []).map((r) => [r.sync_uuid as string, r.audio_path as string | null]),
  );

  for (const s of sessions) {
    if (!s.sync_uuid || !s.folder_path) continue;
    if (cloudAudioByUuid.get(s.sync_uuid)) continue; // アップロード済み
    const audioUri = await resolveSessionAudioUri(s.folder_path);
    if (!audioUri) continue;
    try {
      const base64 = await new File(audioUri).base64();
      const storagePath = `${user.id}/${s.sync_uuid}.m4a`;
      const { error: upErr } = await supabase.storage
        .from('et-audio')
        .upload(storagePath, decodeBase64(base64), {
          contentType: 'audio/mp4',
          upsert: true,
        });
      if (upErr) {
        console.warn(`[cloudSync] audio upload failed for ${s.sync_uuid}:`, upErr.message);
        continue;
      }
      await supabase
        .from('et_sessions')
        .update({ audio_path: storagePath })
        .eq('sync_uuid', s.sync_uuid);
      audiosUploaded++;
    } catch (e) {
      console.warn(`[cloudSync] audio read/upload failed for ${s.sync_uuid}:`, e);
    }
  }

  await AsyncStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  return { folders: folders.length, sessions: sessions.length, audiosUploaded };
}

/**
 * 自動バックアップ: ログイン済み かつ 前回から一定時間経過していれば
 * 静かに backupAll() を回す。失敗しても投げない。
 */
export async function maybeAutoBackup(): Promise<void> {
  try {
    const user = await getCurrentUser();
    if (!user) return;
    const last = await getLastBackupAt();
    if (last && Date.now() - last.getTime() < AUTO_BACKUP_MIN_INTERVAL_MS) return;
    const result = await backupAll();
    console.log(
      `[cloudSync] auto backup done: ${result.sessions} sessions, ${result.audiosUploaded} audios uploaded`,
    );
  } catch (e) {
    console.warn('[cloudSync] auto backup failed:', e);
  }
}

// ---------------------------------------------------------------------------
// 復元 (クラウド → ローカル)
// ---------------------------------------------------------------------------

export interface RestoreResult {
  folders: number;
  sessions: number;
}

interface CloudSessionRow {
  sync_uuid: string;
  folder_sync_uuid: string | null;
  video_url: string | null;
  transcript: string | null;
  summary: string | null;
  title: string | null;
  language: string | null;
  duration: number | null;
  selected_speaker: string | null;
  active_phrases: string | null;
  script_json: StoredScript | null;
  segments_json: StoredAudioSegment[] | null;
  audio_path: string | null;
  created_at: string | null;
}

export async function restoreAll(): Promise<RestoreResult> {
  const user = await getCurrentUser();
  if (!user) throw new Error('ログインしていません');

  await ensureSyncUuids();
  const db = await getDatabase();

  // ----- folders -----
  const { data: cloudFolders, error: cfErr } = await supabase
    .from('et_folders')
    .select('*')
    .eq('user_id', user.id);
  if (cfErr) throw new Error(`フォルダーの取得に失敗: ${cfErr.message}`);

  const localFolders = await db.getAllAsync<FolderRow>('SELECT * FROM folders');
  const localFolderUuids = new Set(localFolders.map((f) => f.sync_uuid).filter(Boolean));
  let restoredFolders = 0;
  for (const cf of cloudFolders ?? []) {
    if (localFolderUuids.has(cf.sync_uuid)) continue;
    await db.runAsync(
      'INSERT INTO folders (name, sync_uuid, created_at) VALUES (?, ?, ?)',
      cf.name,
      cf.sync_uuid,
      isoToSqlite(cf.created_at) ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
    );
    restoredFolders++;
  }
  // uuid → local folder id マップを作り直す
  const foldersNow = await db.getAllAsync<FolderRow>('SELECT * FROM folders');
  const folderIdByUuid = new Map<string, number>();
  for (const f of foldersNow) {
    if (f.sync_uuid) folderIdByUuid.set(f.sync_uuid, f.id);
  }

  // ----- sessions -----
  const { data: cloudSessions, error: csErr } = await supabase
    .from('et_sessions')
    .select('*')
    .eq('user_id', user.id);
  if (csErr) throw new Error(`セッションの取得に失敗: ${csErr.message}`);

  const localSessions = await db.getAllAsync<SessionRow>('SELECT * FROM sessions');
  const localSessionUuids = new Set(localSessions.map((s) => s.sync_uuid).filter(Boolean));

  let restoredSessions = 0;
  for (const cs of (cloudSessions ?? []) as CloudSessionRow[]) {
    if (localSessionUuids.has(cs.sync_uuid)) continue;

    // 1) セッションフォルダを作り、スクリプト / セグメント / 音声を書き戻す
    const folderPath = await createSessionFolder(cs.title || cs.summary || 'restored');
    if (cs.script_json) {
      await saveScript(folderPath, cs.script_json.scriptTurns, cs.script_json.speakers);
    }
    if (cs.segments_json && cs.segments_json.length > 0) {
      await saveSegments(folderPath, cs.segments_json);
    }
    if (cs.audio_path) {
      try {
        const { data: signed, error: signErr } = await supabase.storage
          .from('et-audio')
          .createSignedUrl(cs.audio_path, 300);
        if (signErr || !signed?.signedUrl) {
          console.warn(`[cloudSync] signed url failed for ${cs.sync_uuid}:`, signErr?.message);
        } else {
          const resolved = await resolveSessionFolderPath(folderPath);
          const dest = new File(`${resolved}audio.m4a`);
          if (dest.exists) {
            try { dest.delete(); } catch { /* ignore */ }
          }
          await File.downloadFileAsync(signed.signedUrl, dest);
        }
      } catch (e) {
        console.warn(`[cloudSync] audio download failed for ${cs.sync_uuid}:`, e);
      }
    }

    // 2) sessions 行を復元
    const folderName = extractSessionFolderName(folderPath);
    const result = await db.runAsync(
      `INSERT INTO sessions
         (video_url, transcript, summary, title, language, duration,
          folder_path, folder_id, selected_speaker, active_phrases, sync_uuid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cs.video_url ?? 'local',
      cs.transcript ?? '',
      cs.summary ?? 'Practice session',
      cs.title,
      cs.language ?? 'en',
      cs.duration ?? 0,
      folderName,
      cs.folder_sync_uuid ? folderIdByUuid.get(cs.folder_sync_uuid) ?? null : null,
      cs.selected_speaker,
      cs.active_phrases,
      cs.sync_uuid,
      isoToSqlite(cs.created_at) ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
    );
    const localSessionId = result.lastInsertRowId;

    // 3) phrases / practice_logs を復元
    const { data: cloudPhrases } = await supabase
      .from('et_phrases')
      .select('*')
      .eq('session_sync_uuid', cs.sync_uuid)
      .order('order_index');
    for (const p of cloudPhrases ?? []) {
      await db.runAsync(
        `INSERT INTO phrases
           (session_id, phrase, translation, context, difficulty, notes,
            mastery_level, practice_count, last_practiced_at, is_saved, saved_at, order_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        localSessionId,
        p.phrase,
        p.translation ?? '',
        p.context ?? '',
        p.difficulty ?? 'intermediate',
        p.notes ?? '',
        p.mastery_level ?? 0,
        p.practice_count ?? 0,
        isoToSqlite(p.last_practiced_at),
        p.is_saved ? 1 : 0,
        isoToSqlite(p.saved_at),
        p.order_index ?? 0,
      );
    }

    const { data: cloudLogs } = await supabase
      .from('et_practice_logs')
      .select('*')
      .eq('session_sync_uuid', cs.sync_uuid)
      .order('created_at');
    for (const l of cloudLogs ?? []) {
      await db.runAsync(
        `INSERT INTO practice_logs (session_id, step, score, feedback, transcript, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        localSessionId,
        l.step,
        l.score,
        l.feedback,
        l.transcript,
        isoToSqlite(l.created_at) ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
      );
    }

    restoredSessions++;
  }

  return { folders: restoredFolders, sessions: restoredSessions };
}
