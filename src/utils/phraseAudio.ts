import { File, Directory, Paths } from 'expo-file-system';

/**
 * フレーズリスト用 音声キャッシュユーティリティ。
 *
 *   1. フレーズ文字列から決定的キーを計算 (サーバーと完全一致)
 *   2. 端末ローカルに `<documentDirectory>/phrase_audio/<key>.mp3` がキャッシュ済みなら即それを返す
 *   3. 無ければサーバー `POST /tts` で生成 → 端末にダウンロード保存 → 返す
 *
 * 2 回目以降は完全にオフライン再生でき、API コールも発生しない。
 *
 * 新 expo-file-system API (File / Directory / Paths) のみを使用する。
 * legacy subpath は Metro Bundler で読めない環境があるため使わない。
 */

const API_BASE_URL: string =
  (typeof process !== 'undefined' &&
    process.env &&
    process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'http://192.168.1.133:3000';

const DEFAULT_VOICE = 'alloy';
const PHRASE_AUDIO_DIR_NAME = 'phrase_audio';

function getPhraseAudioDirUri(): string {
  const root = Paths.document.uri;
  const ensured = root.endsWith('/') ? root : `${root}/`;
  return `${ensured}${PHRASE_AUDIO_DIR_NAME}/`;
}

function ensureDir(): void {
  const dir = new Directory(getPhraseAudioDirUri());
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
}

/**
 * サーバー側 `phraseAudioKey` と同一アルゴリズム。
 * 両者がズレるとキャッシュが当たらないので、変更する際は必ず両方同時に修正すること。
 */
export function phraseAudioKey(text: string, voice: string = DEFAULT_VOICE): string {
  const s = `${voice}::${text.trim()}`;
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

function localUriForKey(key: string): string {
  return `${getPhraseAudioDirUri()}${key}.mp3`;
}

/**
 * 端末キャッシュに既にあるかだけ確認する（ネットワークに出ない）。
 */
export function hasCachedPhraseAudio(
  text: string,
  voice: string = DEFAULT_VOICE,
): boolean {
  const key = phraseAudioKey(text, voice);
  const file = new File(localUriForKey(key));
  return file.exists && (file.size ?? 0) > 0;
}

/**
 * 指定フレーズの再生用ローカル URI を返す。
 * キャッシュヒット時は通信なし。ミス時のみサーバーから取得してから返す。
 */
export async function getPhraseAudioUri(
  text: string,
  voice: string = DEFAULT_VOICE,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('text is empty');

  ensureDir();
  const key = phraseAudioKey(trimmed, voice);
  const localUri = localUriForKey(key);
  const cached = new File(localUri);
  if (cached.exists && (cached.size ?? 0) > 0) {
    return localUri;
  }

  // 未キャッシュ: サーバーで生成させて、レスポンスの mp3 バイナリを保存する。
  const url = `${API_BASE_URL}/tts`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed, voice }),
    });
  } catch (e) {
    throw new Error(
      `TTS サーバーに接続できません (${url}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`TTS サーバーエラー (${response.status}): ${body}`);
  }

  const buf = await response.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  if (cached.exists) {
    try {
      cached.delete();
    } catch {
      /* ignore */
    }
  }
  cached.create();
  cached.write(base64, { encoding: 'base64' });
  return localUri;
}

/**
 * キャッシュを warming する（失敗しても例外を投げずに false を返す）。
 * フレーズリスト取得直後にバックグラウンドで呼ぶ用途を想定。
 */
export async function warmPhraseAudio(
  text: string,
  voice: string = DEFAULT_VOICE,
): Promise<boolean> {
  try {
    await getPhraseAudioUri(text, voice);
    return true;
  } catch {
    return false;
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return globalThis.btoa(binary);
}
