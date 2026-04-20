/**
 * Echo Trigger ユーティリティ。
 *
 * 外出中の音声入力（日本語 or 拙い英語）を、ネイティブが普段使う自然な
 * 英語表現に変換するためのパイプラインを 1 ファイルにまとめている。
 * UI 側はここの 2 関数だけ知っていればよい。
 *
 *   1. transcribeForEcho(uri)        : 音声 → テキスト (Whisper)
 *   2. paraphraseToNaturalEnglish(s) : テキスト → 自然英語 + メタ情報 (Claude)
 *
 * 現状は API 呼び出しを未配線のため、いずれもダミー実装で「流れだけ」通す。
 * 実呼び出しに差し替える時は、この 2 関数の中身を埋めるだけで済むようにする。
 */

import { transcribeAudio } from './transcribe';
import { paraphraseForEcho } from '../ai';

export interface EchoParaphraseResult {
  /** Claude が生成した自然な口語英語表現（フレーズリストに保存される） */
  naturalEnglish: string;
  /** 同じ意味の和訳（任意。フレーズリスト下段に表示される） */
  translation: string;
  /** どんな状況で使う表現か / トーン / 言い換えなど（任意の補足） */
  note?: string;
}

/**
 * 録音ファイルを文字起こしする。
 * Whisper サーバーが未起動の開発環境でも UI フローを検証できるよう、
 * ネットワークエラー時はダミー文字列にフォールバックする。
 * サーバー本体を起動していれば自動で実呼び出しが優先される。
 */
export async function transcribeForEcho(uri: string): Promise<string> {
  try {
    const text = await transcribeAudio(uri);
    if (text.trim()) return text;
    // 空文字が返ってきた場合はダミーに回す（UI 流れ確認のため）
    return DUMMY_TRANSCRIPT;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Whisper サーバー未起動 / 到達不可は開発中に頻発するので、
    // ここで握りつぶして UI の続きを流す。本番で残らないよう console には出す。
    if (/サーバーに接続できません|Network request failed|Whisper API error/i.test(msg)) {
      console.warn('[echoTrigger] Whisper 未到達のためダミー応答を返します:', msg);
      return DUMMY_TRANSCRIPT;
    }
    throw e;
  }
}

const DUMMY_TRANSCRIPT =
  '(ダミー) 今日の打ち合わせ、リスケできないか聞いてみたい';

/**
 * 口語英語化。Claude API (サーバー経由) を呼び出し、自然な表現に変換する。
 * サーバー未起動や JSON パース失敗など、復帰不能でないエラーは
 * ダミー応答にフォールバックして UI フローを止めない。
 */
export async function paraphraseToNaturalEnglish(
  inputText: string,
): Promise<EchoParaphraseResult> {
  const trimmed = inputText.trim();
  if (!trimmed) {
    return {
      naturalEnglish: '(empty)',
      translation: '(空の入力)',
      note: 'No transcript was produced.',
    };
  }

  try {
    const r = await paraphraseForEcho(trimmed);
    return {
      naturalEnglish: r.naturalEnglish,
      translation: r.translation,
      note: r.note || undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      /サーバーに接続できません|Network request failed|Server error|did not return a valid JSON|empty content/i.test(
        msg,
      )
    ) {
      console.warn('[echoTrigger] Claude 呼び出しに失敗したのでダミー応答:', msg);
      const head = trimmed.replace(/\s+/g, ' ').slice(0, 80);
      return {
        naturalEnglish: `[Draft] ${head}`,
        translation: trimmed,
        note:
          'Claude サーバー未接続のためダミー応答です。server を起動すると自然な変換になります。',
      };
    }
    throw e;
  }
}
