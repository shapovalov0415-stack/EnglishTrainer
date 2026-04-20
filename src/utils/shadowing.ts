import { Audio } from 'expo-av';
import { getPhraseAudioUri } from './phraseAudio';

/**
 * シャドーイング用の音声シーケンス再生。
 *
 * English phrase (cached OpenAI TTS mp3)
 *   ↓
 * 2 秒の空白（ユーザーが声に出す時間）
 *   ↓
 * English phrase
 *   ↓ (... x reps 回 繰り返し)
 *
 * 実装上の性質:
 *  - mp3 は `phraseAudio` 経由で端末キャッシュされるので、2 回目以降は通信なし。
 *  - 同じ Sound インスタンスを replay して 3 回読み上げる（読み込みは 1 回）。
 *  - 外部から `stop()` を呼ばれれば即座に中断し、onDone は呼ばない。
 */

export interface ShadowingOptions {
  /** 繰り返し回数。既定 3 回。 */
  reps?: number;
  /** フレーズを読み終わってから次の再生までの空白（ミリ秒）。既定 2000。 */
  gapMs?: number;
  /** TTS voice 名 (OpenAI)。既定 'alloy'。 */
  voice?: string;
  /** 各回の開始直前に呼ばれる。step は 1..reps。 */
  onStep?: (step: number, reps: number) => void;
  /** 全回終了で呼ばれる（stop() の場合は呼ばれない）。 */
  onDone?: () => void;
  /** エラーで中断したとき呼ばれる。 */
  onError?: (message: string) => void;
}

export interface ShadowingController {
  /** 再生を即時中断する。onDone は呼ばれない。 */
  stop: () => void;
  /** 実行中なら true。 */
  isRunning: () => boolean;
}

export function startShadowing(
  text: string,
  options: ShadowingOptions = {},
): ShadowingController {
  const {
    reps = 3,
    gapMs = 2000,
    voice = 'alloy',
    onStep,
    onDone,
    onError,
  } = options;

  let cancelled = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let sound: Audio.Sound | null = null;

  const cleanupSound = async () => {
    if (!sound) return;
    try {
      await sound.stopAsync();
    } catch {
      /* ignore */
    }
    try {
      await sound.unloadAsync();
    } catch {
      /* ignore */
    }
    sound = null;
  };

  const stop = () => {
    cancelled = true;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    cleanupSound();
  };

  const playOnce = async (step: number) => {
    if (cancelled || !sound) return;
    onStep?.(step, reps);
    try {
      await sound.setPositionAsync(0);
      await sound.playAsync();
    } catch (e) {
      if (!cancelled) {
        onError?.(e instanceof Error ? e.message : String(e));
      }
      return;
    }
  };

  (async () => {
    // 再生前に共有オーディオモードを整える（他の音は止まる）。
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });
    } catch {
      /* best-effort */
    }

    let uri: string;
    try {
      uri = await getPhraseAudioUri(text, voice);
    } catch (e) {
      if (!cancelled) {
        onError?.(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (cancelled) return;

    try {
      const { sound: s } = await Audio.Sound.createAsync({ uri });
      sound = s;
    } catch (e) {
      if (!cancelled) {
        onError?.(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (cancelled) {
      await cleanupSound();
      return;
    }

    let currentStep = 0;
    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) return;
      if (!status.didJustFinish) return;
      if (cancelled) return;

      if (currentStep >= reps) {
        onDone?.();
        cleanupSound();
        return;
      }
      // 次回の再生まで空白を挟む
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (cancelled) return;
        currentStep += 1;
        playOnce(currentStep);
      }, gapMs);
    });

    currentStep = 1;
    await playOnce(currentStep);
  })();

  return {
    stop,
    isRunning: () => !cancelled,
  };
}
