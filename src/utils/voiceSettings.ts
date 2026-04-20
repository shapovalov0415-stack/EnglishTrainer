import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceGender = 'male' | 'female';

export interface VoiceSettings {
  /** 音声読み上げのオン/オフ */
  enabled: boolean;
  /** 話者性別（端末に無い場合は別性別または先頭の英語 voice にフォールバック） */
  gender: VoiceGender;
  /** 再生速度: 0.8 〜 1.2 */
  rate: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  gender: 'female',
  rate: 1.0,
};

export const RATE_MIN = 0.8;
export const RATE_MAX = 1.2;
export const RATE_STEP = 0.1;
export const RATE_OPTIONS: readonly number[] = [0.8, 0.9, 1.0, 1.1, 1.2];

const STORAGE_KEY = 'englishTrainer.voiceSettings.v1';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function clampRate(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VOICE_SETTINGS.rate;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(v * 10) / 10));
}

function normalize(raw: unknown): VoiceSettings {
  const obj = (raw ?? {}) as Partial<VoiceSettings>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_VOICE_SETTINGS.enabled;
  const gender: VoiceGender = obj.gender === 'male' ? 'male' : 'female';
  const rate = typeof obj.rate === 'number' ? clampRate(obj.rate) : DEFAULT_VOICE_SETTINGS.rate;
  return { enabled, gender, rate };
}

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VOICE_SETTINGS;
    return normalize(JSON.parse(raw));
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export async function saveVoiceSettings(s: VoiceSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(s)));
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Voice picking
// ---------------------------------------------------------------------------

/**
 * expo-speech の Voice には gender フィールドが無いので、
 * 既知の名前・identifier の断片から推定する。iOS / macOS の標準音声名と、
 * Android Google TTS の identifier パターン (例: en-us-x-sfg#female_1-local) の両方をカバー。
 */
const MALE_HINTS = [
  // generic
  'male', '_m_', '-m-', '#m',
  // iOS / macOS 標準英語音声
  'daniel', 'alex', 'aaron', 'arthur', 'fred', 'oliver',
  'rocko', 'gordon', 'lee', 'thomas', 'reed', 'eddy',
  'ralph', 'albert', 'junior', 'bruce', 'grandpa',
  'rishi', 'rowan', 'danny', 'matthew', 'brian', 'joey',
  // Android Google TTS 由来の典型 identifier
  'sfb', 'sff', 'male-', 'mgn',
];
const FEMALE_HINTS = [
  // generic
  'female', '_f_', '-f-', '#f',
  // iOS / macOS 標準英語音声
  'samantha', 'karen', 'tessa', 'moira', 'fiona', 'allison',
  'susan', 'victoria', 'veena', 'serena', 'kate', 'ava',
  'zoe', 'evan', 'nora', 'grandma', 'flo', 'sandy',
  'catherine', 'emma', 'jenny', 'joanna', 'kimberly', 'sally',
  // Android Google TTS 由来の典型 identifier (sfg = speech female general)
  'sfg', 'female-', 'fgn',
];

function scoreGender(v: Speech.Voice, gender: VoiceGender): number {
  const hay = `${v.identifier} ${v.name ?? ''}`.toLowerCase();
  const hits = gender === 'male' ? MALE_HINTS : FEMALE_HINTS;
  const misses = gender === 'male' ? FEMALE_HINTS : MALE_HINTS;
  if (hits.some((w) => hay.includes(w))) return 2;
  if (misses.some((w) => hay.includes(w))) return -1;
  return 0;
}

function scoreQuality(v: Speech.Voice): number {
  // Enhanced > Default。enum の文字列比較で十分
  if (v.quality === Speech.VoiceQuality.Enhanced) return 1;
  return 0;
}

function scoreLocale(v: Speech.Voice): number {
  // en-AU を最優先、それ以外の英語は同率
  if (v.language === 'en-AU') return 2;
  if (v.language?.toLowerCase().startsWith('en-au')) return 2;
  if (v.language?.toLowerCase().startsWith('en')) return 1;
  return 0;
}

/**
 * 英語ボイスだけ抽出する。
 */
export function filterEnglishVoices(all: Speech.Voice[]): Speech.Voice[] {
  return all.filter((v) => (v.language ?? '').toLowerCase().startsWith('en'));
}

/**
 * 指定の gender に最もマッチする英語 voice を選ぶ。
 * 該当無しなら別性別・最後は null を返す（= OS デフォルトに任せる）。
 */
export function pickVoice(
  voices: Speech.Voice[],
  gender: VoiceGender,
): Speech.Voice | null {
  const english = filterEnglishVoices(voices);
  if (english.length === 0) return null;

  const ranked = english
    .map((v) => ({
      v,
      // 性別マッチを最優先、次にロケール（en-AU 優先）、最後に品質
      s: scoreGender(v, gender) * 10 + scoreLocale(v) * 3 + scoreQuality(v),
    }))
    .sort((a, b) => b.s - a.s);

  // 性別一致が見つからなかった場合も英語 voice を返す（何も鳴らないより良い）
  return ranked[0]?.v ?? null;
}

/**
 * 選ばれた voice の性別が本当にユーザー指定 gender と一致するかを返す。
 * true なら pitch 調整不要、false なら pitch で擬似的に性別差を作る。
 */
export function voiceMatchesGender(
  voice: Speech.Voice | null,
  gender: VoiceGender,
): boolean {
  if (!voice) return false;
  return scoreGender(voice, gender) > 0;
}

/**
 * expo-speech に渡す pitch 値を性別から決める。
 *   female → やや高め (1.2)
 *   male   → やや低め (0.85)
 * デバイスに女性/男性どちらか一方しか voice が入っていない場合でも、
 * これをかけるだけで音色がはっきり分かれる。聞き取りやすさを優先して控えめな差に設定。
 */
export function pitchForGender(gender: VoiceGender): number {
  return gender === 'female' ? 1.2 : 0.85;
}
