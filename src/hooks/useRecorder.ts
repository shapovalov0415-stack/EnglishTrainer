import { useState, useRef, useCallback } from 'react';
import { Audio } from 'expo-av';

export type RecorderStatus = 'idle' | 'recording' | 'stopped';

export interface UseRecorderReturn {
  status: RecorderStatus;
  /** 録音中の経過時間（秒） */
  durationSec: number;
  /** 録音を開始する */
  startRecording: () => Promise<void>;
  /** 録音を停止し、URI を返す */
  stopRecording: () => Promise<string | null>;
  /** 録音結果をリセットする */
  reset: () => void;
  /** 最後に録音したファイルの URI */
  recordingUri: string | null;
}

export function useRecorder(): UseRecorderReturn {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [durationSec, setDurationSec] = useState(0);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

  const startRecording = useCallback(async () => {
    // マイク権限を要求
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) {
      throw new Error('マイクの使用許可が必要です');
    }

    // 既存の録音があれば解放
    if (recordingRef.current) {
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch {
        // already unloaded
      }
      recordingRef.current = null;
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    const { recording } = await Audio.Recording.createAsync(
      Audio.RecordingOptionsPresets.HIGH_QUALITY,
      (recordingStatus) => {
        if (recordingStatus.isRecording && recordingStatus.durationMillis) {
          setDurationSec(Math.floor(recordingStatus.durationMillis / 1000));
        }
      },
      100, // progressUpdateIntervalMillis
    );

    recordingRef.current = recording;
    setRecordingUri(null);
    setDurationSec(0);
    setStatus('recording');
  }, []);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!recordingRef.current) return null;

    await recordingRef.current.stopAndUnloadAsync();

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
    });

    const uri = recordingRef.current.getURI();
    recordingRef.current = null;

    setRecordingUri(uri);
    setStatus('stopped');
    return uri;
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setDurationSec(0);
    setRecordingUri(null);
  }, []);

  return {
    status,
    durationSec,
    startRecording,
    stopRecording,
    reset,
    recordingUri,
  };
}
