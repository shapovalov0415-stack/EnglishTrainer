import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Audio, type AVPlaybackStatus } from 'expo-av';
import * as Speech from 'expo-speech';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type {
  RootStackParamList,
  AudioSegment,
} from '../navigation/RootNavigator';
import { scorePronunciation, type ScoreResult } from '../ai';
import { transcribeAudio } from '../utils/transcribe';
import { insertPracticeLog } from '../db/schema';
import { saveStep2Data } from '../utils/sessionStorage';
import {
  DEFAULT_VOICE_SETTINGS,
  filterEnglishVoices,
  loadVoiceSettings,
  pickVoice,
  pitchForGender,
  saveVoiceSettings,
  type VoiceGender,
} from '../utils/voiceSettings';
import VoiceSettingsMenu from '../components/VoiceSettingsMenu';

type Props = NativeStackScreenProps<RootStackParamList, 'Roleplay'>;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function findBestSegments(
  phrase: string, segments: AudioSegment[],
): { start: number; end: number } | null {
  if (segments.length === 0) return null;
  const words = normalize(phrase).split(' ');
  if (words.length === 0) return null;
  let bS = 0, bE = 0, best = -1;
  for (let i = 0; i < segments.length; i++) {
    let c = '';
    for (let j = i; j < Math.min(i + 5, segments.length); j++) {
      c += (c ? ' ' : '') + normalize(segments[j].text);
      let m = 0;
      for (const w of words) if (c.includes(w)) m++;
      const sc = m / words.length;
      if (sc > best) { best = sc; bS = segments[i].start; bE = segments[j].end; }
      if (sc >= 1) break;
    }
  }
  return best < 0.3 ? null : { start: bS, end: bE };
}

type Phase = 'countdown' | 'conversation' | 'scoring' | 'results';

const MY_SPEAK_TIME_SEC = 8;
const COUNTDOWN_SEC = 3;

interface TurnResult {
  turnIdx: number;
  spokenText: string;
  score: ScoreResult;
}

function stripParens(s: string): string {
  return s.replace(/[（(][^）)]*[）)]/g, '').trim();
}

export default function RoleplayScreen({ route, navigation }: Props) {
  const { sessionId, scriptTurns, speakers, myRoleIndex, fileUri, segments, sessionFolder } = route.params;

  const hasScript = scriptTurns != null && scriptTurns.length > 0;
  const speakerNames = speakers ?? ['Speaker A', 'Speaker B'];
  const mySpeaker = speakerNames[myRoleIndex];

  const [phase, setPhase] = useState<Phase>('countdown');
  const [countdown, setCountdown] = useState(COUNTDOWN_SEC);
  const [currentTurn, setCurrentTurn] = useState(0);
  const [turnLabel, setTurnLabel] = useState<'partner_playing' | 'my_speak' | 'idle'>('idle');
  const [myTimer, setMyTimer] = useState(MY_SPEAK_TIME_SEC);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [scoringProgress, setScoringProgress] = useState(0);
  const [results, setResults] = useState<TurnResult[]>([]);
  const [conversationDone, setConversationDone] = useState(false);

  // Voice settings (gender / rate / enabled) は AsyncStorage から復元・保存する。
  // Roleplay では「自分」と「相手」で別の声にしたいので、pickVoice に渡す gender を
  // 話者ごとに切り替える（下の pickVoiceForSpeaker）。
  const [englishVoices, setEnglishVoices] = useState<Speech.Voice[]>([]);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(DEFAULT_VOICE_SETTINGS.enabled);
  const [voiceGender, setVoiceGender] = useState<VoiceGender>(DEFAULT_VOICE_SETTINGS.gender);
  const [speechRate, setSpeechRate] = useState<number>(DEFAULT_VOICE_SETTINGS.rate);
  const settingsLoadedRef = useRef(false);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const runningRef = useRef(false);

  const hasOriginalAudio = Boolean(fileUri && segments && segments.length > 0);

  const turnTimings = useMemo(() => {
    if (!segments || segments.length === 0 || !scriptTurns) return (scriptTurns ?? []).map(() => null);
    return scriptTurns.map((t) => findBestSegments(t.text, segments));
  }, [scriptTurns, segments]);

  const myTurnIndices = useMemo(() => {
    if (!scriptTurns) return [];
    return scriptTurns
      .map((t, i) => (t.speaker === mySpeaker ? i : -1))
      .filter((i) => i >= 0);
  }, [scriptTurns, mySpeaker]);

  useEffect(() => {
    return () => {
      if (soundRef.current) soundRef.current.unloadAsync().catch(() => {});
      if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
      if (myTimerRef.current) clearInterval(myTimerRef.current);
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, []);

  // 端末の英語ボイス + AsyncStorage から保存済み設定を一度だけ復元
  useEffect(() => {
    (async () => {
      try {
        const [voices, saved] = await Promise.all([
          Speech.getAvailableVoicesAsync(),
          loadVoiceSettings(),
        ]);
        setEnglishVoices(filterEnglishVoices(voices));
        setVoiceEnabled(saved.enabled);
        setVoiceGender(saved.gender);
        setSpeechRate(saved.rate);
      } catch (e) {
        console.warn('voice settings init failed:', e);
      } finally {
        settingsLoadedRef.current = true;
      }
    })();
  }, []);

  // 設定変更時に永続化
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    saveVoiceSettings({ enabled: voiceEnabled, gender: voiceGender, rate: speechRate });
  }, [voiceEnabled, voiceGender, speechRate]);

  // Roleplay では自分が役 A なら相手は役 B、という前提。
  // 自分の gender はユーザー設定 (voiceGender)、相手は「逆の性別」を割り当てて
  // 2 人が違う声で聞こえるようにする。
  //   speakerIdx === myRoleIndex → 自分の gender （基本 Practice では使わないが念のため）
  //   speakerIdx !== myRoleIndex → 逆の gender
  //
  // デバイスによっては pickVoice が性別に関係なく同じ voice を返すことがあるので、
  // 必ず pitch も一緒に返して 「voice 選択 + ピッチ加工」の二段構えで性別差を作る。
  const pickVoiceForSpeaker = useCallback(
    (speakerIdx: number): { voice: Speech.Voice | null; gender: VoiceGender; pitch: number } => {
      const oppositeGender: VoiceGender =
        voiceGender === 'female' ? 'male' : 'female';
      const g: VoiceGender =
        speakerIdx === myRoleIndex ? voiceGender : oppositeGender;
      return {
        voice: pickVoice(englishVoices, g),
        gender: g,
        pitch: pitchForGender(g),
      };
    },
    [englishVoices, voiceGender, myRoleIndex],
  );

  const stopPlayback = useCallback(async () => {
    await Speech.stop();
    if (playbackTimerRef.current) { clearTimeout(playbackTimerRef.current); playbackTimerRef.current = null; }
    if (soundRef.current) {
      await soundRef.current.stopAsync().catch(() => {});
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
  }, []);

  // --- TTS: 話者 (speakerIdx) ごとに pitch を切り替える ---
  // 注意: Speech.speak に特定の voice identifier を渡すと、
  // 端末によっては pitch パラメータが無視されることがある（そのボイスの既定ピッチに固定）。
  // そのため ここでは language のみ指定し、pitch で性別差を担保する。
  const speakAU = useCallback(
    async (text: string, speakerIdx: number): Promise<void> => {
      await stopPlayback();
      if (!voiceEnabled) return;
      const { voice, pitch, gender } = pickVoiceForSpeaker(speakerIdx);
      console.warn(
        `[RoleplayScreen] speakAU: speakerIdx=${speakerIdx} gender=${gender} pitch=${pitch} voice=${voice?.identifier ?? 'default'} lang=${voice?.language ?? 'en-AU'}`,
      );
      return new Promise((resolve) => {
        Speech.speak(text, {
          language: voice?.language ?? 'en-AU',
          rate: speechRate,
          pitch,
          onDone: () => resolve(),
          onStopped: () => resolve(),
          onError: () => resolve(),
        });
      });
    },
    [stopPlayback, voiceEnabled, pickVoiceForSpeaker, speechRate],
  );

  // --- Original audio seek play ---
  const playOriginal = useCallback(async (turnIdx: number): Promise<void> => {
    const timing = turnTimings[turnIdx];
    if (!fileUri || !timing) return;
    await stopPlayback();
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: fileUri },
        { positionMillis: Math.floor(timing.start * 1000), shouldPlay: true },
      );
      soundRef.current = sound;
      return new Promise<void>((resolve) => {
        const dur = Math.ceil((timing.end - timing.start) * 1000) + 300;
        playbackTimerRef.current = setTimeout(async () => {
          await sound.stopAsync().catch(() => {});
          await sound.unloadAsync().catch(() => {});
          soundRef.current = null;
          resolve();
        }, dur);
        sound.setOnPlaybackStatusUpdate((st: AVPlaybackStatus) => {
          if ('didJustFinish' in st && st.didJustFinish) {
            if (playbackTimerRef.current) { clearTimeout(playbackTimerRef.current); playbackTimerRef.current = null; }
            sound.unloadAsync().catch(() => {});
            soundRef.current = null;
            resolve();
          }
        });
      });
    } catch { /* ok */ }
  }, [fileUri, turnTimings, stopPlayback]);

  // --- Start continuous recording ---
  const startContinuousRecording = useCallback(async () => {
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const tryCreate = async () => {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      return recording;
    };

    // expo-av の既知バグ: 前画面が掴んだ Recording がネイティブ側にまだ
    // 残っていると "Only one Recording object can be prepared at a given time"
    // が発生する。audio mode を false → (遅延) → true と再設定して掴み直す。
    const recoverAndRetry = async (): Promise<Audio.Recording> => {
      let lastErr: unknown = null;
      const waits = [150, 350, 700]; // 徐々に間隔を伸ばして最大3回リトライ
      for (const wait of waits) {
        try {
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: false,
            playsInSilentModeIOS: true,
          });
        } catch {
          /* ignore */
        }
        await delay(wait);
        try {
          return await tryCreate();
        } catch (e) {
          lastErr = e;
          console.warn(`Recording recovery attempt failed (wait=${wait}ms):`, e);
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error('録音の準備に失敗しました');
    };

    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert('権限エラー', 'マイクの使用許可が必要です。');
        return;
      }

      // 自分自身が前回掴んだままの Recording を先に解放
      if (recordingRef.current) {
        try {
          await recordingRef.current.stopAndUnloadAsync();
        } catch {
          /* 既に unload 済みならここで落ちるので握りつぶす */
        }
        recordingRef.current = null;
      }

      let recording: Audio.Recording;
      try {
        recording = await tryCreate();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/Only one Recording object/i.test(msg) || /prepared/i.test(msg)) {
          console.warn('Recording prepare conflict, recovering...');
          recording = await recoverAndRetry();
        } else {
          throw e;
        }
      }

      recordingRef.current = recording;
      setIsRecording(true);
    } catch (e: unknown) {
      Alert.alert('エラー', e instanceof Error ? e.message : '録音を開始できません');
    }
  }, []);

  const stopContinuousRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      setIsRecording(false);
      if (uri) setRecordingUri(uri);
    } catch { /* ok */ }
  }, []);

  // --- Countdown ---
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (countdown <= 0) {
      setPhase('conversation');
      return;
    }
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  // --- Start recording + run conversation when phase becomes 'conversation' ---
  useEffect(() => {
    if (phase !== 'conversation' || runningRef.current) return;
    runningRef.current = true;

    (async () => {
      await startContinuousRecording();
      if (!scriptTurns) return;

      for (let idx = 0; idx < scriptTurns.length; idx++) {
        setCurrentTurn(idx);
        const turn = scriptTurns[idx];
        const isMyTurn = turn.speaker === mySpeaker;

        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

        if (!isMyTurn) {
          setTurnLabel('partner_playing');
          // この turn の speaker が話者配列のどちら (0 or 1) かを解決し、
          // そのインデックスに合わせた voice で読み上げる。
          const turnSpeakerIdx =
            speakerNames.findIndex((s) => s === turn.speaker);
          await speakAU(turn.text, turnSpeakerIdx >= 0 ? turnSpeakerIdx : 1 - myRoleIndex);
          setTurnLabel('idle');
        } else {
          setTurnLabel('my_speak');
          setMyTimer(MY_SPEAK_TIME_SEC);

          await new Promise<void>((resolve) => {
            let remaining = MY_SPEAK_TIME_SEC;
            myTimerRef.current = setInterval(() => {
              remaining--;
              setMyTimer(remaining);
              if (remaining <= 0) {
                if (myTimerRef.current) { clearInterval(myTimerRef.current); myTimerRef.current = null; }
                resolve();
              }
            }, 1000);
          });

          setTurnLabel('idle');
        }
      }

      setConversationDone(true);
      setCurrentTurn(scriptTurns.length);
      await stopContinuousRecording();
      setPhase('scoring');
    })();
  }, [phase, scriptTurns, mySpeaker, hasOriginalAudio, turnTimings, startContinuousRecording, stopContinuousRecording, speakAU, playOriginal]);

  // --- Skip my timer early ---
  const skipMyTimer = useCallback(() => {
    if (myTimerRef.current) {
      clearInterval(myTimerRef.current);
      myTimerRef.current = null;
    }
    setMyTimer(0);
  }, []);

  // --- Scoring phase ---
  useEffect(() => {
    if (phase !== 'scoring') return;
    if (!recordingUri || myTurnIndices.length === 0) {
      setPhase('results');
      return;
    }

    let cancelled = false;
    (async () => {
      const spokenText = await transcribeAudio(recordingUri);

      if (cancelled) return;

      const allResults: TurnResult[] = [];
      for (let i = 0; i < myTurnIndices.length; i++) {
        if (cancelled) return;
        const turnIdx = myTurnIndices[i];
        const expected = scriptTurns![turnIdx].text;
        setScoringProgress(i + 1);
        try {
          const score = await scorePronunciation(expected, spokenText);
          allResults.push({ turnIdx, spokenText: '(全体録音)', score });
        } catch {
          allResults.push({
            turnIdx,
            spokenText: '(採点失敗)',
            score: { score: 0, feedback: '採点に失敗しました' },
          });
        }
      }
      if (!cancelled) {
        setResults(allResults);
        setPhase('results');
      }
    })();
    return () => { cancelled = true; };
  }, [phase, recordingUri, myTurnIndices, scriptTurns]);

  const avgScore = results.length > 0
    ? Math.round(results.reduce((s, r) => s + r.score.score, 0) / results.length)
    : 0;

  const handleFinish = useCallback(async () => {
    try {
      await insertPracticeLog(
        sessionId, 'roleplay', avgScore,
        JSON.stringify(results.map((r) => ({ turn: r.turnIdx, score: r.score.score }))),
        scriptTurns?.map((t) => `${t.speaker}: ${t.text}`).join('\n') ?? '',
      );
    } catch {}

    if (sessionFolder && scriptTurns) {
      try {
        await saveStep2Data(sessionFolder, {
          scriptTurns,
          myRole: stripParens(mySpeaker),
          avgScore,
          results: results.map((r) => ({
            turnIdx: r.turnIdx,
            expectedText: scriptTurns[r.turnIdx]?.text ?? '',
            score: r.score.score,
            feedback: r.score.feedback,
          })),
          completedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.warn('Failed to save step2 data:', e);
      }
    }

    navigation.navigate('Extension', { sessionId, sessionFolder });
  }, [sessionId, navigation, avgScore, results, scriptTurns, sessionFolder, mySpeaker]);

  const handleRetry = useCallback(() => {
    runningRef.current = false;
    setPhase('countdown');
    setCountdown(COUNTDOWN_SEC);
    setCurrentTurn(0);
    setTurnLabel('idle');
    setMyTimer(MY_SPEAK_TIME_SEC);
    setIsRecording(false);
    setRecordingUri(null);
    setResults([]);
    setScoringProgress(0);
    setConversationDone(false);
  }, []);

  const scoreColor = (sc: number) => {
    if (sc >= 80) return '#22C55E';
    if (sc >= 60) return '#60A5FA';
    if (sc >= 40) return '#FBBF24';
    return '#F87171';
  };

  // ============================================================
  if (!hasScript) {
    return (
      <View style={styles.centered}>
        <Text style={styles.noScriptText}>この動画にはスクリプトが見つかりませんでした。</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Text style={styles.backBtnText}>戻る</Text>
        </TouchableOpacity>
      </View>
    );
  }
  const turns = scriptTurns!;

  // ============================================================
  // Countdown
  // ============================================================
  if (phase === 'countdown') {
    return (
      <View style={styles.centered}>
        <Text style={styles.countdownLabel}>会話が始まります</Text>
        <Text style={styles.countdownNumber}>{countdown}</Text>
        <Text style={styles.countdownRole}>You = {stripParens(mySpeaker)}</Text>
      </View>
    );
  }

  // ============================================================
  // Scoring
  // ============================================================
  if (phase === 'scoring') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#A78BFA" />
        <Text style={styles.scoringText}>
          採点中... {scoringProgress} / {myTurnIndices.length}
        </Text>
      </View>
    );
  }

  // ============================================================
  // Results
  // ============================================================
  if (phase === 'results') {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.resultsContent}>
        <Text style={styles.resultsTitle}>Roleplay Results</Text>
        <View style={styles.avgCircle}>
          <Text style={styles.avgNum}>{avgScore}</Text>
          <Text style={styles.avgUnit}>/ 100</Text>
        </View>

        {results.map((r, i) => {
          const turn = turns[r.turnIdx];
          return (
            <View key={i} style={styles.rCard}>
              <Text style={styles.rExpected}>{turn?.text}</Text>
              <View style={styles.rScoreRow}>
                <View style={[styles.rBadge, { backgroundColor: scoreColor(r.score.score) + '22' }]}>
                  <Text style={[styles.rScoreNum, { color: scoreColor(r.score.score) }]}>{r.score.score}</Text>
                </View>
                <Text style={styles.rFeedback}>{r.score.feedback}</Text>
              </View>
            </View>
          );
        })}

        <View style={styles.rActions}>
          <TouchableOpacity style={styles.retryBtn} onPress={handleRetry} activeOpacity={0.7}>
            <Text style={styles.retryBtnText}>もう一度 Try</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.nextBtn} onPress={handleFinish} activeOpacity={0.7}>
            <Text style={styles.nextBtnText}>Step 3 へ {'\u2192'}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  // ============================================================
  // Conversation
  // ============================================================
  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <View style={styles.topBarLeft}>
          <Text style={styles.topBarRole}>You = {stripParens(mySpeaker)}</Text>
          {isRecording && <View style={styles.recIndicator}><Text style={styles.recDotAnim}>{'\u{1F534}'}</Text><Text style={styles.recLabel}>REC</Text></View>}
        </View>
        <Text style={styles.topBarProgress}>{Math.min(currentTurn + 1, turns.length)} / {turns.length}</Text>
      </View>

      {/* 右上に音声設定 (男性/女性・速度・ON/OFF) の歯車アイコン */}
      <VoiceSettingsMenu
        enabled={voiceEnabled}
        onToggleEnabled={setVoiceEnabled}
        rate={speechRate}
        onChangeRate={setSpeechRate}
        gender={voiceGender}
        onChangeGender={setVoiceGender}
        top={12}
        right={12}
      />

      <ScrollView ref={scrollRef} style={styles.chatArea} contentContainerStyle={styles.chatPad}>
        {turns.map((turn, idx) => {
          if (idx > currentTurn) return null;
          const isMyTurn = turn.speaker === mySpeaker;
          const isCurrent = idx === currentTurn;

          return (
            <View key={idx} style={[styles.bubble, isMyTurn ? styles.bubbleMy : styles.bubblePartner]}>
              <Text style={styles.bubbleName}>{stripParens(turn.speaker)}</Text>

              {/* Partner: show script */}
              {!isMyTurn && <Text style={styles.bubbleScript}>{turn.text}</Text>}
              {!isMyTurn && isCurrent && turnLabel === 'partner_playing' && (
                <View style={styles.miniRow}>
                  <ActivityIndicator size="small" color="#22C55E" />
                  <Text style={styles.miniText}>再生中...</Text>
                </View>
              )}

              {/* My turn: NO script, show timer if current */}
              {isMyTurn && isCurrent && turnLabel === 'my_speak' && (
                <TouchableOpacity style={styles.myTurnBox} onPress={skipMyTimer} activeOpacity={0.7}>
                  <Text style={styles.myTurnTimer}>{myTimer}s</Text>
                  <Text style={styles.myTurnHint}>話してください（タップでスキップ）</Text>
                </TouchableOpacity>
              )}
              {isMyTurn && !isCurrent && (
                <Text style={styles.bubbleDone}>{'\u2705'}</Text>
              )}
              {isMyTurn && isCurrent && turnLabel === 'idle' && !conversationDone && (
                <Text style={styles.bubbleWait}>待機中...</Text>
              )}
            </View>
          );
        })}

        {conversationDone && (
          <View style={styles.doneCard}>
            <Text style={styles.doneText}>会話終了！ 採点に移ります...</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF' },
  centered: { flex: 1, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', padding: 24 },
  noScriptText: { color: '#64748B', fontSize: 16, textAlign: 'center', marginBottom: 20 },
  backBtn: { backgroundColor: '#E2E8F0', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32 },
  backBtnText: { color: '#0F172A', fontSize: 15, fontWeight: '600' },

  // Countdown
  countdownLabel: { color: '#64748B', fontSize: 16, marginBottom: 16 },
  countdownNumber: { color: '#A78BFA', fontSize: 72, fontWeight: '800' },
  countdownRole: { color: '#94A3B8', fontSize: 14, marginTop: 20 },

  // Scoring
  scoringText: { color: '#64748B', fontSize: 16, marginTop: 16 },

  // Top bar
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: '#F8FAFC', borderBottomWidth: 1, borderBottomColor: '#E2E8F0',
  },
  topBarLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  topBarRole: { color: '#A78BFA', fontSize: 14, fontWeight: '700' },
  topBarProgress: { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
  recIndicator: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  recDotAnim: { fontSize: 10 },
  recLabel: { color: '#F87171', fontSize: 11, fontWeight: '700' },

  // Chat
  chatArea: { flex: 1 },
  chatPad: { padding: 16, paddingBottom: 40 },
  bubble: { borderRadius: 16, padding: 14, marginBottom: 10, maxWidth: '90%' },
  bubblePartner: { alignSelf: 'flex-start', backgroundColor: '#F8FAFC', borderBottomLeftRadius: 4 },
  bubbleMy: { alignSelf: 'flex-end', backgroundColor: '#EDE9FE', borderBottomRightRadius: 4 },
  bubbleName: { color: '#94A3B8', fontSize: 11, fontWeight: '600', marginBottom: 4 },
  bubbleScript: { color: '#0F172A', fontSize: 15, lineHeight: 22 },
  bubbleDone: { fontSize: 16, textAlign: 'center' },
  bubbleWait: { color: '#94A3B8', fontSize: 13, textAlign: 'center' },
  miniRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 6 },
  miniText: { color: '#64748B', fontSize: 12 },

  // My turn box
  myTurnBox: {
    alignItems: 'center', backgroundColor: '#EDE9FE', borderRadius: 12,
    paddingVertical: 16, marginTop: 4,
  },
  myTurnTimer: { color: '#A78BFA', fontSize: 36, fontWeight: '800' },
  myTurnHint: { color: '#64748B', fontSize: 12, marginTop: 4 },

  // Done
  doneCard: { backgroundColor: '#F8FAFC', borderRadius: 14, padding: 20, alignItems: 'center', marginTop: 8 },
  doneText: { color: '#166534', fontSize: 15, fontWeight: '600' },

  // Results
  resultsContent: { padding: 24, paddingBottom: 60 },
  resultsTitle: { color: '#0F172A', fontSize: 24, fontWeight: '700', textAlign: 'center', marginBottom: 20 },
  avgCircle: {
    width: 110, height: 110, borderRadius: 55, backgroundColor: '#F8FAFC',
    alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 24,
  },
  avgNum: { color: '#A78BFA', fontSize: 38, fontWeight: '800' },
  avgUnit: { color: '#94A3B8', fontSize: 13, marginTop: -4 },
  rCard: { backgroundColor: '#F8FAFC', borderRadius: 14, padding: 16, marginBottom: 12 },
  rExpected: { color: '#334155', fontSize: 14, lineHeight: 20, marginBottom: 8 },
  rScoreRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rBadge: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  rScoreNum: { fontSize: 20, fontWeight: '800' },
  rFeedback: { color: '#64748B', fontSize: 12, flex: 1, lineHeight: 18 },
  rActions: { flexDirection: 'row', gap: 12, marginTop: 12 },
  retryBtn: { flex: 1, backgroundColor: '#E2E8F0', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  retryBtnText: { color: '#0F172A', fontSize: 15, fontWeight: '600' },
  nextBtn: { flex: 1, backgroundColor: '#A78BFA', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  nextBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
});
