import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio } from 'expo-av';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type {
  RootStackParamList,
  RootTabParamList,
} from '../navigation/RootNavigator';
import { addEchoPhrase } from '../db/schema';
import {
  paraphraseToNaturalEnglish,
  transcribeForEcho,
  type EchoParaphraseResult,
} from '../utils/echoTrigger';

type Props = CompositeScreenProps<
  BottomTabScreenProps<RootTabParamList, 'EchoTriggerTab'>,
  NativeStackScreenProps<RootStackParamList>
>;

type Phase =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'paraphrasing'
  | 'saving'
  | 'done';

const PHASE_LABEL: Record<Phase, string> = {
  idle: '',
  recording: '録音中... タップで停止',
  transcribing: '音声を文字起こししています...',
  paraphrasing: 'Claude が自然な英語に変換中...',
  saving: 'フレーズリストに保存中...',
  done: '保存しました',
};

interface LastResult {
  intent: string;
  paraphrased: EchoParaphraseResult;
}

/** 録音の自動停止時間（秒）。外出中の思いつきを 1 フレーズ単位で保存する想定。 */
const MAX_RECORDING_SECONDS = 30;

export default function EchoTriggerScreen({ navigation }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [duration, setDuration] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // stopAndProcess は setInterval から呼びたいが、useCallback の相互参照で
  // 初期化順序の問題が起きるため、最新の関数を ref 経由で差し込む。
  const stopAndProcessRef = useRef<() => void>(() => {});

  const isBusy =
    phase === 'transcribing' || phase === 'paraphrasing' || phase === 'saving';

  // アンマウント時に録音と timer を確実に解放する。
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    setErrorMsg(null);
    setLastResult(null);
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert('権限エラー', 'マイクの使用許可が必要です。');
        return;
      }
      // 既存の録音が残っていれば破棄
      if (recordingRef.current) {
        try {
          await recordingRef.current.stopAndUnloadAsync();
        } catch {
          /* already unloaded */
        }
        recordingRef.current = null;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      recordingRef.current = recording;
      setDuration(0);
      setPhase('recording');
      timerRef.current = setInterval(() => {
        setDuration((d) => {
          const next = d + 1;
          // 上限到達で自動停止。stopAndProcess 内でも clearInterval するが、
          // 二重停止を避けるためここで先に timer を落とす。
          if (next >= MAX_RECORDING_SECONDS) {
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            stopAndProcessRef.current();
          }
          return next;
        });
      }, 1000);
    } catch (e) {
      setPhase('idle');
      Alert.alert('録音開始エラー', e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stopAndProcess = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!recordingRef.current) return;

    let uri: string | null = null;
    try {
      await recordingRef.current.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      uri = recordingRef.current.getURI();
    } catch (e) {
      console.warn('stopAndUnloadAsync failed:', e);
    }
    recordingRef.current = null;

    if (!uri) {
      setPhase('idle');
      setErrorMsg('録音ファイルを取得できませんでした。');
      return;
    }

    // ---- 1. 文字起こし ----
    setPhase('transcribing');
    let transcript = '';
    try {
      transcript = await transcribeForEcho(uri);
    } catch (e) {
      console.warn('transcribeForEcho failed:', e);
      setPhase('idle');
      setErrorMsg(
        `文字起こしに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    if (!transcript.trim()) {
      setPhase('idle');
      setErrorMsg('音声から内容を聞き取れませんでした。もう一度お試しください。');
      return;
    }

    // ---- 2. Claude で自然な英語化 (現在はダミー実装) ----
    setPhase('paraphrasing');
    let paraphrased: EchoParaphraseResult;
    try {
      paraphrased = await paraphraseToNaturalEnglish(transcript);
    } catch (e) {
      setPhase('idle');
      setErrorMsg(
        `英語化に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    // ---- 3. フレーズリストに保存 ----
    setPhase('saving');
    try {
      await addEchoPhrase(paraphrased.naturalEnglish, transcript);
    } catch (e) {
      setPhase('idle');
      setErrorMsg(
        `保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    setLastResult({ intent: transcript, paraphrased });
    setPhase('done');
  }, []);

  useEffect(() => {
    stopAndProcessRef.current = stopAndProcess;
  }, [stopAndProcess]);

  const onPressMain = useCallback(() => {
    if (phase === 'recording') {
      stopAndProcess();
    } else if (phase === 'idle' || phase === 'done') {
      startRecording();
    }
    // transcribing/paraphrasing/saving 中は無視（ボタン disabled でも保険）
  }, [phase, startRecording, stopAndProcess]);

  const renderMainButton = () => {
    if (phase === 'recording') {
      const remain = Math.max(0, MAX_RECORDING_SECONDS - duration);
      const progressPct = Math.min(100, (duration / MAX_RECORDING_SECONDS) * 100);
      return (
        <TouchableOpacity
          style={[styles.micButton, styles.micButtonRecording]}
          onPress={onPressMain}
          activeOpacity={0.8}
        >
          <View style={styles.stopSquare} />
          <Text style={styles.micLabel}>停止</Text>
          <Text style={styles.timerText}>
            {duration}s / {MAX_RECORDING_SECONDS}s
          </Text>
          <Text style={styles.remainText}>残り {remain}s</Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
          </View>
        </TouchableOpacity>
      );
    }
    if (isBusy) {
      return (
        <View style={[styles.micButton, styles.micButtonBusy]}>
          <ActivityIndicator size="large" color="#FFFFFF" />
          <Text style={styles.micLabel}>処理中</Text>
        </View>
      );
    }
    return (
      <TouchableOpacity
        style={styles.micButton}
        onPress={onPressMain}
        activeOpacity={0.85}
      >
        <Text style={styles.micIcon}>{'\u{1F3A4}'}</Text>
        <Text style={styles.micLabel}>話す</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Echo Trigger</Text>
          <Text style={styles.subtitle}>
            外出先で思いついたフレーズを{'\n'}
            その場で“現地の英語”に変換
          </Text>
        </View>

        <View style={styles.micWrap}>{renderMainButton()}</View>

        {phase !== 'idle' && (
          <Text style={styles.statusLabel}>{PHASE_LABEL[phase]}</Text>
        )}

        {errorMsg && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        )}

        {lastResult && (
          <View style={styles.resultCard}>
            <Text style={styles.resultLabel}>変換結果</Text>
            <Text style={styles.resultEnglish}>
              {lastResult.paraphrased.naturalEnglish}
            </Text>
            {lastResult.paraphrased.translation ? (
              <Text style={styles.resultTranslation}>
                {lastResult.paraphrased.translation}
              </Text>
            ) : null}
            {lastResult.paraphrased.note ? (
              <Text style={styles.resultNote}>
                {lastResult.paraphrased.note}
              </Text>
            ) : null}
            <Text style={styles.resultIntentLabel}>あなたの入力</Text>
            <Text style={styles.resultIntent}>{lastResult.intent}</Text>
            <Text style={styles.savedBadge}>
              {'\u2B50'} フレーズリストに保存済み
            </Text>
            <TouchableOpacity
              style={styles.goToListButton}
              onPress={() => navigation.navigate('PhraseListTab')}
              activeOpacity={0.85}
            >
              <Text style={styles.goToListButtonText}>
                フレーズタブで確認する {'\u203A'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={styles.hint}>
          書かない・読まない。話すだけ。{'\n'}
          変換結果は「フレーズ」タブから確認できます。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 72,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 6,
    textAlign: 'center',
    lineHeight: 19,
  },
  micWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 32,
  },
  micButton: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: '#7C3AED',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#7C3AED',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 8,
    gap: 8,
  },
  micButtonRecording: {
    backgroundColor: '#EF4444',
    shadowColor: '#EF4444',
  },
  micButtonBusy: {
    backgroundColor: '#A78BFA',
  },
  micIcon: {
    fontSize: 64,
  },
  micLabel: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
  },
  stopSquare: {
    width: 44,
    height: 44,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
  },
  timerText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  remainText: {
    color: '#FECACA',
    fontSize: 12,
    fontWeight: '700',
    marginTop: -4,
  },
  progressTrack: {
    marginTop: 8,
    width: 140,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#FFFFFF',
  },
  statusLabel: {
    textAlign: 'center',
    color: '#7C3AED',
    fontWeight: '700',
    fontSize: 14,
    marginBottom: 16,
  },
  errorBox: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FCA5A5',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  errorText: {
    color: '#B91C1C',
    fontSize: 13,
    lineHeight: 19,
  },
  resultCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 18,
    marginBottom: 24,
    gap: 6,
  },
  resultLabel: {
    color: '#7C3AED',
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  resultEnglish: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
  },
  resultTranslation: {
    color: '#475569',
    fontSize: 13,
    lineHeight: 19,
  },
  resultNote: {
    color: '#94A3B8',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
    fontStyle: 'italic',
  },
  resultIntentLabel: {
    color: '#94A3B8',
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 0.5,
    marginTop: 12,
  },
  resultIntent: {
    color: '#334155',
    fontSize: 13,
    lineHeight: 19,
  },
  savedBadge: {
    color: '#F59E0B',
    fontWeight: '800',
    fontSize: 12,
    marginTop: 10,
  },
  goToListButton: {
    marginTop: 12,
    backgroundColor: '#7C3AED',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  goToListButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  hint: {
    color: '#94A3B8',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
    marginTop: 12,
  },
});
