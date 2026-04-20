import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import * as Speech from 'expo-speech';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation';
import { useRecorder } from '../hooks/useRecorder';
import { transcribeAudio, type AIConfig } from '../utils/ai';
import {
  getPhrasesForSession,
  updatePhraseMastery,
  insertPracticeLog,
  type PhraseRow,
} from '../db/schema';
import { calculateSimilarity, getScoreLabel } from '../utils/similarity';

type Props = NativeStackScreenProps<RootStackParamList, 'Shadowing'>;

// TODO: アプリ設定画面から取得する
const AI_CONFIG: AIConfig = {
  openaiApiKey: '',
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? '',
};

type PracticeState = 'ready' | 'listening' | 'playing' | 'processing' | 'result';

interface AttemptResult {
  userText: string;
  score: number;
  label: string;
  color: string;
}

export default function ShadowingScreen({ route, navigation }: Props) {
  const { sessionId } = route.params;

  // --- state ---
  const [phrases, setPhrases] = useState<PhraseRow[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [practiceState, setPracticeState] = useState<PracticeState>('ready');
  const [attempt, setAttempt] = useState<AttemptResult | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bestScores, setBestScores] = useState<Record<number, number>>({});

  const recorder = useRecorder();
  const currentPhrase = phrases[currentIndex];
  const totalPhrases = phrases.length;

  // --- DB からフレーズ取得 ---
  useEffect(() => {
    (async () => {
      try {
        const rows = await getPhrasesForSession(sessionId);
        setPhrases(rows);
      } catch (e) {
        console.error('Failed to load phrases:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId]);

  // --- お手本再生 (TTS) ---
  const playModel = useCallback(() => {
    if (!currentPhrase || isSpeaking) return;

    setIsSpeaking(true);
    setPracticeState('playing');

    Speech.speak(currentPhrase.phrase, {
      language: 'en-US',
      rate: 0.85,
      onDone: () => {
        setIsSpeaking(false);
        setPracticeState('ready');
      },
      onError: () => {
        setIsSpeaking(false);
        setPracticeState('ready');
      },
    });
  }, [currentPhrase, isSpeaking]);

  // --- 録音開始 ---
  const handleStartRecording = useCallback(async () => {
    try {
      setAttempt(null);
      await recorder.startRecording();
      setPracticeState('listening');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '録音を開始できません';
      Alert.alert('エラー', msg);
    }
  }, [recorder]);

  // --- 録音停止 & 文字起こし & 判定 ---
  const handleStopRecording = useCallback(async () => {
    setPracticeState('processing');

    const uri = await recorder.stopRecording();
    if (!uri || !currentPhrase) {
      setPracticeState('ready');
      return;
    }

    try {
      const transcription = await transcribeAudio(uri, AI_CONFIG);
      const score = calculateSimilarity(currentPhrase.phrase, transcription.text);
      const { label, color } = getScoreLabel(score);

      setAttempt({
        userText: transcription.text,
        score,
        label,
        color,
      });
      setPracticeState('result');

      // ベストスコア更新
      const prevBest = bestScores[currentPhrase.id] ?? 0;
      if (score > prevBest) {
        setBestScores((prev) => ({ ...prev, [currentPhrase.id]: score }));
        await updatePhraseMastery(currentPhrase.id, score);
      }

      // 練習ログ記録
      await insertPracticeLog(
        sessionId,
        'shadowing',
        score,
        label,
        transcription.text,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '文字起こしに失敗しました';
      Alert.alert('エラー', msg);
      setPracticeState('ready');
    }
  }, [recorder, currentPhrase, sessionId, bestScores]);

  // --- もう一度 Try ---
  const handleRetry = useCallback(() => {
    recorder.reset();
    setAttempt(null);
    setPracticeState('ready');
  }, [recorder]);

  // --- 次のフレーズ ---
  const handleNext = useCallback(() => {
    if (currentIndex < totalPhrases - 1) {
      setCurrentIndex((i) => i + 1);
      handleRetry();
    } else {
      // 全フレーズ完了 → Step 2 へ
      navigation.navigate('Roleplay', {
        sessionId,
        videoUrl: route.params.videoUrl,
      });
    }
  }, [currentIndex, totalPhrases, handleRetry, navigation, sessionId, route.params.videoUrl]);

  // --- ローディング ---
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#60A5FA" />
        <Text style={styles.loadingText}>フレーズを読み込み中...</Text>
      </View>
    );
  }

  // --- フレーズが無い場合 ---
  if (phrases.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>フレーズがまだありません</Text>
        <Text style={styles.emptySubText}>
          ホーム画面で動画を解析してください
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
    >
      {/* Progress */}
      <View style={styles.progressBar}>
        <View
          style={[
            styles.progressFill,
            { width: `${((currentIndex + 1) / totalPhrases) * 100}%` },
          ]}
        />
      </View>
      <Text style={styles.progressText}>
        {currentIndex + 1} / {totalPhrases}
      </Text>

      {/* Phrase Card */}
      <View style={styles.phraseCard}>
        <View style={styles.difficultyBadge}>
          <Text style={styles.difficultyText}>
            {currentPhrase.difficulty}
          </Text>
        </View>

        <Text style={styles.phraseText}>{currentPhrase.phrase}</Text>
        <Text style={styles.translationText}>{currentPhrase.translation}</Text>

        {currentPhrase.notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.notesLabel}>Notes</Text>
            <Text style={styles.notesText}>{currentPhrase.notes}</Text>
          </View>
        ) : null}
      </View>

      {/* お手本再生ボタン */}
      <TouchableOpacity
        style={[styles.modelButton, isSpeaking && styles.modelButtonActive]}
        onPress={playModel}
        disabled={isSpeaking}
        activeOpacity={0.7}
      >
        <Text style={styles.modelButtonIcon}>{isSpeaking ? '...' : '\u{1F50A}'}</Text>
        <Text style={styles.modelButtonText}>
          {isSpeaking ? '再生中...' : 'お手本を聞く'}
        </Text>
      </TouchableOpacity>

      {/* Recording Area */}
      <View style={styles.recordingArea}>
        {practiceState === 'ready' && (
          <TouchableOpacity
            style={styles.recordButton}
            onPress={handleStartRecording}
            activeOpacity={0.7}
          >
            <View style={styles.recordDot} />
            <Text style={styles.recordButtonText}>録音開始</Text>
          </TouchableOpacity>
        )}

        {practiceState === 'listening' && (
          <View style={styles.listeningContainer}>
            <Text style={styles.listeningTime}>{recorder.durationSec}s</Text>
            <TouchableOpacity
              style={styles.stopButton}
              onPress={handleStopRecording}
              activeOpacity={0.7}
            >
              <View style={styles.stopSquare} />
              <Text style={styles.stopButtonText}>録音停止</Text>
            </TouchableOpacity>
          </View>
        )}

        {practiceState === 'processing' && (
          <View style={styles.processingContainer}>
            <ActivityIndicator size="small" color="#60A5FA" />
            <Text style={styles.processingText}>解析中...</Text>
          </View>
        )}

        {practiceState === 'result' && attempt && (
          <View style={styles.resultContainer}>
            {/* Score */}
            <View style={styles.scoreCircle}>
              <Text style={[styles.scoreNumber, { color: attempt.color }]}>
                {attempt.score}
              </Text>
              <Text style={styles.scoreUnit}>点</Text>
            </View>
            <Text style={[styles.scoreLabel, { color: attempt.color }]}>
              {attempt.label}
            </Text>

            {/* User transcript */}
            <View style={styles.userTranscript}>
              <Text style={styles.userTranscriptLabel}>あなたの発話:</Text>
              <Text style={styles.userTranscriptText}>{attempt.userText}</Text>
            </View>

            {/* Action Buttons */}
            <View style={styles.actionButtons}>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={handleRetry}
                activeOpacity={0.7}
              >
                <Text style={styles.retryButtonText}>もう一度 Try</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.nextButton}
                onPress={handleNext}
                activeOpacity={0.7}
              >
                <Text style={styles.nextButtonText}>
                  {currentIndex < totalPhrases - 1
                    ? '次のフレーズ →'
                    : 'Step 2 へ →'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* Best Score for this phrase */}
      {bestScores[currentPhrase.id] != null && (
        <View style={styles.bestScoreBar}>
          <Text style={styles.bestScoreText}>
            Best: {bestScores[currentPhrase.id]}点
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  contentContainer: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 60,
  },
  centered: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  loadingText: {
    color: '#64748B',
    fontSize: 15,
    marginTop: 12,
  },
  emptyText: {
    color: '#0F172A',
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubText: {
    color: '#64748B',
    fontSize: 14,
  },

  // Progress
  progressBar: {
    height: 4,
    backgroundColor: '#F8FAFC',
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#60A5FA',
    borderRadius: 2,
  },
  progressText: {
    color: '#94A3B8',
    fontSize: 13,
    textAlign: 'right',
    marginBottom: 20,
  },

  // Phrase Card
  phraseCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 24,
    marginBottom: 20,
  },
  difficultyBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 12,
  },
  difficultyText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  phraseText: {
    color: '#0F172A',
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 30,
    marginBottom: 8,
  },
  translationText: {
    color: '#64748B',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 4,
  },
  notesBox: {
    marginTop: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 12,
  },
  notesLabel: {
    color: '#60A5FA',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  notesText: {
    color: '#334155',
    fontSize: 13,
    lineHeight: 18,
  },

  // Model Button
  modelButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  modelButtonActive: {
    borderColor: '#60A5FA',
    backgroundColor: '#E2E8F0',
  },
  modelButtonIcon: {
    fontSize: 18,
    marginRight: 8,
  },
  modelButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },

  // Recording Area
  recordingArea: {
    alignItems: 'center',
    minHeight: 160,
    justifyContent: 'center',
  },

  // Record Button
  recordButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DC2626',
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 32,
    width: '100%',
  },
  recordDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#FFF',
    marginRight: 10,
  },
  recordButtonText: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '700',
  },

  // Listening
  listeningContainer: {
    alignItems: 'center',
    width: '100%',
  },
  listeningTime: {
    color: '#F87171',
    fontSize: 40,
    fontWeight: '700',
    marginBottom: 16,
  },
  stopButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FEE2E2',
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 32,
    width: '100%',
  },
  stopSquare: {
    width: 14,
    height: 14,
    borderRadius: 2,
    backgroundColor: '#FFF',
    marginRight: 10,
  },
  stopButtonText: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '700',
  },

  // Processing
  processingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  processingText: {
    color: '#64748B',
    fontSize: 15,
    marginLeft: 10,
  },

  // Result
  resultContainer: {
    alignItems: 'center',
    width: '100%',
  },
  scoreCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  scoreNumber: {
    fontSize: 36,
    fontWeight: '800',
  },
  scoreUnit: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: -4,
  },
  scoreLabel: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  userTranscript: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    marginBottom: 20,
  },
  userTranscriptLabel: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  userTranscriptText: {
    color: '#0F172A',
    fontSize: 15,
    lineHeight: 22,
  },

  // Action Buttons
  actionButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  retryButton: {
    flex: 1,
    backgroundColor: '#E2E8F0',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  retryButtonText: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '600',
  },
  nextButton: {
    flex: 1,
    backgroundColor: '#3B82F6',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  nextButtonText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
  },

  // Best Score
  bestScoreBar: {
    marginTop: 16,
    alignItems: 'center',
  },
  bestScoreText: {
    color: '#22C55E',
    fontSize: 14,
    fontWeight: '600',
  },
});
