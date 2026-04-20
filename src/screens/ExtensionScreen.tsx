import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import * as Speech from 'expo-speech';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import {
  DEFAULT_VOICE_SETTINGS,
  filterEnglishVoices,
  loadVoiceSettings,
  pickVoice,
  pitchForGender,
  saveVoiceSettings,
  type VoiceGender,
} from '../utils/voiceSettings';
import type {
  ChatMessage,
  ExtensionFeedback,
  RoleplayFeedback,
  PastPerformance,
} from '../types/ai';
import { useRecorder } from '../hooks/useRecorder';
import {
  buildExtensionSystemPrompt,
  generateExtensionScenario,
  sendRoleplayMessage,
  generateExtensionFeedback,
  transcribeAudio,
  type AIConfig,
} from '../utils/ai';
import {
  getPhrasesForSession,
  getPracticeLogs,
  insertPracticeLog,
  type PhraseRow,
  type SessionRow,
  type PracticeLogRow,
} from '../db/schema';
import { getDatabase } from '../db/schema';
import GrowthChart from '../components/GrowthChart';
import CongratulationModal from '../components/CongratulationModal';
import VoiceSettingsMenu from '../components/VoiceSettingsMenu';
import {
  saveStep3Data,
  getStorageHintText,
  shareSessionExport,
} from '../utils/sessionStorage';

type Props = NativeStackScreenProps<RootStackParamList, 'Extension'>;

const AI_CONFIG: AIConfig = {
  openaiApiKey: '',
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL || 'http://192.168.1.133:3000',
};

const MIN_TURNS = 3;
const MAX_TURNS = 5;

type ScreenPhase = 'loading' | 'chat' | 'generating_feedback' | 'feedback';

export default function ExtensionScreen({ route, navigation }: Props) {
  const { sessionId, sessionFolder } = route.params;

  // --- state ---
  const [phase, setPhase] = useState<ScreenPhase>('loading');
  const [phrases, setPhrases] = useState<PhraseRow[]>([]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [scenarioLabel, setScenarioLabel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [feedback, setFeedback] = useState<ExtensionFeedback | null>(null);
  const [pastPerformance, setPastPerformance] = useState<PastPerformance>({
    roleplayScore: null,
    roleplayFeedback: null,
    shadowingBestScore: null,
  });
  const [showCongrats, setShowCongrats] = useState(false);
  const [sharing, setSharing] = useState(false);

  const recorder = useRecorder();
  const scrollRef = useRef<ScrollView>(null);

  // --- 音声設定 ---
  // 端末の英語 voice 一覧（初回取得してキャッシュ）。
  const [englishVoices, setEnglishVoices] = useState<Speech.Voice[]>([]);
  // 音声読み上げの ON/OFF（永続化される）
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(DEFAULT_VOICE_SETTINGS.enabled);
  // 話者性別（永続化される）
  const [voiceGender, setVoiceGender] = useState<VoiceGender>(DEFAULT_VOICE_SETTINGS.gender);
  // 再生速度 0.8〜1.2（永続化される）
  const [speechRate, setSpeechRate] = useState<number>(DEFAULT_VOICE_SETTINGS.rate);
  // AsyncStorage からの読み込みが終わるまで save を走らせないためのガード
  const settingsLoadedRef = useRef(false);

  const userTurnCount = messages.filter((m) => m.role === 'user').length;
  const canFinish = userTurnCount >= MIN_TURNS;

  // 端末の英語 voice を一度だけ取得 + AsyncStorage から設定を復元
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

  // 設定が変わったら AsyncStorage に永続化（初回ロード完了まではスキップ）
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    saveVoiceSettings({
      enabled: voiceEnabled,
      gender: voiceGender,
      rate: speechRate,
    });
  }, [voiceEnabled, voiceGender, speechRate]);

  // OFF に切り替えたら即時に発話を停止する
  useEffect(() => {
    if (!voiceEnabled) {
      Speech.stop().catch(() => {});
    }
  }, [voiceEnabled]);

  /**
   * AI 返答を en-AU で自動読み上げする。
   * - 前の読み上げが残っていれば先に stop
   * - gender に合う端末 voice を選ぶ
   * - speechRate を rate に渡す
   * - 音声合成失敗は握り潰してチャット進行を妨げない
   */
  const speakAi = useCallback(
    async (text: string) => {
      if (!voiceEnabled) return;
      if (!text || !text.trim()) return;
      try {
        try {
          await Speech.stop();
        } catch {
          /* ignore */
        }

        const voice = pickVoice(englishVoices, voiceGender);
        const pitch = pitchForGender(voiceGender);
        console.warn(
          `[ExtensionScreen] speakAi: gender=${voiceGender} pitch=${pitch} voice=${voice?.identifier ?? 'default'} lang=${voice?.language ?? 'en-AU'}`,
        );

        // voice identifier を渡すと端末次第で pitch が無視されるため、pitch 優先で
        // language のみ指定する。
        Speech.speak(text, {
          language: voice?.language ?? 'en-AU',
          rate: speechRate,
          pitch,
        });
      } catch (e) {
        console.warn('speakAi failed:', e);
      }
    },
    [voiceEnabled, englishVoices, voiceGender, speechRate],
  );

  // アンマウント時に読み上げを停止
  useEffect(() => {
    return () => {
      Speech.stop().catch(() => {});
    };
  }, []);

  // init useEffect 内（stale closure）からでも常に最新の speakAi を呼べるようにする
  const speakAiRef = useRef(speakAi);
  useEffect(() => {
    speakAiRef.current = speakAi;
  }, [speakAi]);

  // --- 初期化 ---
  useEffect(() => {
    (async () => {
      try {
        const db = await getDatabase();
        const rows = await getPhrasesForSession(sessionId);
        setPhrases(rows);

        const sessions = await db.getAllAsync<SessionRow>(
          'SELECT * FROM sessions WHERE id = ?',
          sessionId,
        );
        const sess = sessions[0] ?? null;

        // 過去の練習ログ取得（成長比較用）
        const roleplayLogs = await getPracticeLogs(sessionId, 'roleplay');
        const shadowingLogs = await getPracticeLogs(sessionId, 'shadowing');

        let rpFeedback: RoleplayFeedback | null = null;
        const latestRoleplay = roleplayLogs[0];
        if (latestRoleplay?.feedback) {
          try {
            const parsed = JSON.parse(latestRoleplay.feedback);
            if (parsed && Array.isArray(parsed.goodPoints)) {
              rpFeedback = parsed as RoleplayFeedback;
            }
          } catch {
            // invalid JSON
          }
        }

        const bestShadowing = shadowingLogs.reduce<number | null>(
          (best, log) => {
            if (log.score == null) return best;
            return best == null ? log.score : Math.max(best, log.score);
          },
          null,
        );

        const past: PastPerformance = {
          roleplayScore: latestRoleplay?.score ?? null,
          roleplayFeedback: rpFeedback,
          shadowingBestScore: bestShadowing,
        };
        setPastPerformance(past);

        if (rows.length === 0 || !sess) {
          setPhase('chat');
          return;
        }

        // シナリオ生成: レッスン要約 + フレーズを Claude に渡して、テーマに合った
        // 新しいシチュエーションを動的に作る（固定の 8 種類からランダムではなく、
        // 動画の内容に沿った練習になる）。
        const phrasesForAi = rows.map((r) => ({
          phrase: r.phrase,
          context: r.context,
        }));
        const generatedScenario = await generateExtensionScenario(AI_CONFIG, {
          summary: sess.summary,
          transcript: sess.transcript,
          phrases: phrasesForAi,
        });
        const { prompt, scenario } = buildExtensionSystemPrompt(
          phrasesForAi,
          generatedScenario,
          sess.summary,
        );
        setSystemPrompt(prompt);
        setScenarioLabel(scenario);

        // AI の最初の挨拶
        const greeting: ChatMessage = {
          role: 'user',
          content:
            'Start the conversation. Introduce the scenario naturally and greet me in 1-2 sentences. Make it clear where we are.',
          timestamp: Date.now(),
        };

        const aiResponse = await sendRoleplayMessage(
          prompt,
          [greeting],
          AI_CONFIG,
        );

        setMessages([
          {
            role: 'assistant',
            content: aiResponse,
            timestamp: Date.now(),
          },
        ]);
        setPhase('chat');
        // AI の最初の挨拶を自動読み上げ（最新の音声設定を参照）
        speakAiRef.current(aiResponse);
      } catch (e) {
        console.error('ExtensionScreen init error:', e);
        setPhase('chat');
      }
    })();
  }, [sessionId]);

  // --- メッセージ送信 ---
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isSending) return;

      const userMsg: ChatMessage = {
        role: 'user',
        content: text.trim(),
        timestamp: Date.now(),
      };

      const updatedMessages = [...messages, userMsg];
      setMessages(updatedMessages);
      setInputText('');
      setIsSending(true);

      try {
        const aiText = await sendRoleplayMessage(
          systemPrompt,
          updatedMessages,
          AI_CONFIG,
        );

        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: aiText, timestamp: Date.now() },
        ]);
        // AI 返答を en-AU で自動読み上げ
        speakAi(aiText);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '送信に失敗しました';
        Alert.alert('エラー', msg);
      } finally {
        setIsSending(false);
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
      }
    },
    [messages, systemPrompt, isSending, speakAi],
  );

  // --- 音声入力 ---
  const handleVoiceInput = useCallback(async () => {
    if (recorder.status === 'recording') {
      setIsTranscribing(true);
      const uri = await recorder.stopRecording();

      if (!uri) {
        setIsTranscribing(false);
        return;
      }

      try {
        const result = await transcribeAudio(uri, AI_CONFIG);
        setIsTranscribing(false);
        recorder.reset();
        if (result.text.trim()) {
          await sendMessage(result.text);
        }
      } catch (e: unknown) {
        setIsTranscribing(false);
        recorder.reset();
        const msg = e instanceof Error ? e.message : '音声認識に失敗しました';
        Alert.alert('エラー', msg);
      }
    } else {
      try {
        await recorder.startRecording();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '録音を開始できません';
        Alert.alert('エラー', msg);
      }
    }
  }, [recorder, sendMessage]);

  // --- 会話終了 & 成長分析フィードバック ---
  const handleFinish = useCallback(async () => {
    setPhase('generating_feedback');

    try {
      const targetPhrases = phrases.map((p) => p.phrase);
      const fb = await generateExtensionFeedback(
        messages,
        targetPhrases,
        pastPerformance,
        AI_CONFIG,
      );
      setFeedback(fb);

      const feedbackJson = JSON.stringify(fb);
      const conversationText = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');

      await insertPracticeLog(
        sessionId,
        'extension',
        fb.score,
        feedbackJson,
        conversationText,
      );

      if (sessionFolder) {
        try {
          await saveStep3Data(sessionFolder, {
            scenario: scenarioLabel,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            score: fb.score,
            feedback: {
              overallComment: fb.overallComment,
              goodPoints: fb.goodPoints,
              improvements: fb.improvements,
              expressionsUsed: fb.expressionsUsed,
              growthSummary: fb.growthSummary,
            },
            completedAt: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('Failed to save step3 data:', e);
        }
      }

      setPhase('feedback');
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : 'フィードバック生成に失敗しました';
      Alert.alert('エラー', msg);
      setPhase('chat');
    }
  }, [messages, phrases, sessionId, pastPerformance, sessionFolder, scenarioLabel]);

  const handleShareExport = useCallback(async () => {
    if (!sessionFolder) return;
    setSharing(true);
    try {
      await shareSessionExport(sessionFolder);
    } catch (e: unknown) {
      Alert.alert(
        '共有できませんでした',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSharing(false);
    }
  }, [sessionFolder]);

  // --- ホームに戻る ---
  const handleGoHome = useCallback(() => {
    navigation.popToTop();
  }, [navigation]);

  // =======================================================================
  // RENDER
  // =======================================================================

  // --- Loading ---
  if (phase === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#34D399" />
        <Text style={styles.loadingText}>新しいシナリオを準備中...</Text>
      </View>
    );
  }

  // --- Generating feedback ---
  if (phase === 'generating_feedback') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#34D399" />
        <Text style={styles.loadingText}>成長分析中...</Text>
      </View>
    );
  }

  // --- Feedback + Growth ---
  if (phase === 'feedback' && feedback) {
    return (
      <View style={{ flex: 1, backgroundColor: '#FFFFFF' }}>
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.feedbackContainer}
        >
          <Text style={styles.feedbackTitle}>Extension Feedback</Text>
          <Text style={styles.scenarioTag}>{scenarioLabel}</Text>

          {/* Score Circle */}
          <View style={styles.scoreCircle}>
            <Text style={styles.scoreNumber}>{feedback.score}</Text>
            <Text style={styles.scoreUnit}>/ 100</Text>
          </View>

          {/* Growth Summary */}
          <View style={styles.growthSummaryBox}>
            <Text style={styles.growthSummaryLabel}>Growth Summary</Text>
            <Text style={styles.growthSummaryText}>
              {feedback.growthSummary}
            </Text>
          </View>

          {/* Growth Chart */}
          <GrowthChart
            shadowingScore={pastPerformance.shadowingBestScore}
            roleplayScore={pastPerformance.roleplayScore}
            extensionScore={feedback.score}
            growthPoints={feedback.growthPoints}
          />

          {/* Overall Comment */}
          <Text style={styles.overallComment}>{feedback.overallComment}</Text>

          {/* Good Points */}
          <View style={styles.feedbackSection}>
            <Text style={styles.feedbackSectionTitle}>Good Points</Text>
            {feedback.goodPoints.map((point, i) => (
              <View key={i} style={styles.feedbackItem}>
                <Text style={styles.feedbackBullet}>+</Text>
                <Text style={styles.feedbackItemText}>{point}</Text>
              </View>
            ))}
          </View>

          {/* Improvements */}
          <View style={styles.feedbackSection}>
            <Text
              style={[styles.feedbackSectionTitle, { color: '#FBBF24' }]}
            >
              Next Steps
            </Text>
            {feedback.improvements.map((point, i) => (
              <View key={i} style={styles.feedbackItem}>
                <Text style={[styles.feedbackBullet, { color: '#FBBF24' }]}>
                  !
                </Text>
                <Text style={styles.feedbackItemText}>{point}</Text>
              </View>
            ))}
          </View>

          {/* Expressions Used */}
          {feedback.expressionsUsed.length > 0 && (
            <View style={styles.feedbackSection}>
              <Text
                style={[styles.feedbackSectionTitle, { color: '#60A5FA' }]}
              >
                Phrases You Used
              </Text>
              <View style={styles.expressionTags}>
                {feedback.expressionsUsed.map((expr, i) => (
                  <View key={i} style={styles.expressionTag}>
                    <Text style={styles.expressionTagText}>{expr}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {sessionFolder ? (
            <View style={styles.storageBox}>
              <Text style={styles.storageTitle}>セッションデータの保存</Text>
              <Text style={styles.storageHint}>{getStorageHintText()}</Text>
              <TouchableOpacity
                style={styles.shareBtn}
                onPress={handleShareExport}
                disabled={sharing}
                activeOpacity={0.85}
              >
                <Text style={styles.shareBtnText}>
                  {sharing ? '準備中...' : '学習ログ JSON を共有'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Complete Button */}
          <TouchableOpacity
            style={styles.completeButton}
            onPress={() => setShowCongrats(true)}
            activeOpacity={0.8}
          >
            <Text style={styles.completeButtonText}>
              Complete! 全ステップ完了
            </Text>
          </TouchableOpacity>
        </ScrollView>

        {/* Congratulation Overlay */}
        <CongratulationModal
          visible={showCongrats}
          score={feedback.score}
          onGoHome={handleGoHome}
        />
      </View>
    );
  }

  // --- Chat ---
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      {/* Scenario Banner */}
      <View style={styles.scenarioBanner}>
        <Text style={styles.scenarioBannerLabel}>New Scenario</Text>
        <Text style={styles.scenarioBannerText} numberOfLines={2}>
          {scenarioLabel}
        </Text>
      </View>

      {/* 音声設定（⚙️ → メニュー） */}
      <VoiceSettingsMenu
        enabled={voiceEnabled}
        onToggleEnabled={setVoiceEnabled}
        rate={speechRate}
        onChangeRate={setSpeechRate}
        gender={voiceGender}
        onChangeGender={setVoiceGender}
        top={10}
        right={12}
      />

      {/* Turn counter */}
      <View style={styles.turnBar}>
        <Text style={styles.turnText}>
          Turn {userTurnCount} / {MAX_TURNS}
        </Text>
        {canFinish && (
          <TouchableOpacity
            style={styles.finishButton}
            onPress={handleFinish}
            activeOpacity={0.7}
          >
            <Text style={styles.finishButtonText}>Finish</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollRef}
        style={styles.chatArea}
        contentContainerStyle={styles.chatContent}
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: true })
        }
      >
        {messages.map((msg, idx) => (
          <View
            key={idx}
            style={[
              styles.bubble,
              msg.role === 'user' ? styles.userBubble : styles.aiBubble,
            ]}
          >
            <Text style={styles.bubbleLabel}>
              {msg.role === 'user' ? 'You' : 'AI Partner'}
            </Text>
            <Text style={styles.bubbleText}>{msg.content}</Text>
          </View>
        ))}

        {isSending && (
          <View style={[styles.bubble, styles.aiBubble]}>
            <Text style={styles.bubbleLabel}>AI Partner</Text>
            <ActivityIndicator
              size="small"
              color="#34D399"
              style={{ marginTop: 4 }}
            />
          </View>
        )}
      </ScrollView>

      {/* Auto-finish hint */}
      {userTurnCount >= MAX_TURNS && (
        <View style={styles.autoFinishBar}>
          <Text style={styles.autoFinishText}>
            {MAX_TURNS}ターン達成！「Finish」で成長レポートを確認しましょう
          </Text>
        </View>
      )}

      {/* Input Area */}
      <View style={styles.inputArea}>
        <TouchableOpacity
          style={[
            styles.voiceButton,
            recorder.status === 'recording' && styles.voiceButtonRecording,
          ]}
          onPress={handleVoiceInput}
          disabled={isSending || isTranscribing}
          activeOpacity={0.7}
        >
          {isTranscribing ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text style={styles.voiceButtonIcon}>
              {recorder.status === 'recording' ? '\u23F9' : '\u{1F3A4}'}
            </Text>
          )}
        </TouchableOpacity>

        <TextInput
          style={styles.textInput}
          placeholder="Type your response..."
          placeholderTextColor="#94A3B8"
          value={inputText}
          onChangeText={setInputText}
          multiline
          editable={!isSending && recorder.status !== 'recording'}
        />

        <TouchableOpacity
          style={[
            styles.sendButton,
            (!inputText.trim() || isSending) && styles.sendButtonDisabled,
          ]}
          onPress={() => sendMessage(inputText)}
          disabled={!inputText.trim() || isSending}
          activeOpacity={0.7}
        >
          <Text style={styles.sendButtonIcon}>{'\u2191'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
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
  centered: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: '#64748B',
    fontSize: 15,
    marginTop: 12,
  },

  // Scenario banner
  scenarioBanner: {
    backgroundColor: '#064E3B',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#065F46',
  },
  scenarioBannerLabel: {
    color: '#34D399',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  scenarioBannerText: {
    color: '#D1FAE5',
    fontSize: 14,
    lineHeight: 20,
  },

  // Turn bar
  turnBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#F8FAFC',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  turnText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '600',
  },
  finishButton: {
    backgroundColor: '#34D399',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  finishButtonText: {
    color: '#064E3B',
    fontSize: 14,
    fontWeight: '700',
  },

  // Chat
  chatArea: {
    flex: 1,
  },
  chatContent: {
    padding: 16,
    paddingBottom: 8,
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#064E3B',
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#F8FAFC',
    borderBottomLeftRadius: 4,
  },
  bubbleLabel: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  bubbleText: {
    color: '#0F172A',
    fontSize: 15,
    lineHeight: 22,
  },

  // Auto finish hint
  autoFinishBar: {
    backgroundColor: '#064E3B',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  autoFinishText: {
    color: '#6EE7B7',
    fontSize: 13,
    textAlign: 'center',
  },

  // Input area
  inputArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 12,
    backgroundColor: '#F8FAFC',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    gap: 8,
  },
  voiceButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceButtonRecording: {
    backgroundColor: '#DC2626',
  },
  voiceButtonIcon: {
    fontSize: 20,
  },
  textInput: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#0F172A',
    fontSize: 15,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#34D399',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#E2E8F0',
  },
  sendButtonIcon: {
    color: '#FFF',
    fontSize: 20,
    fontWeight: '700',
  },

  // =========================================================================
  // Feedback Screen
  // =========================================================================
  feedbackContainer: {
    padding: 24,
    paddingBottom: 60,
    alignItems: 'center',
  },
  feedbackTitle: {
    color: '#0F172A',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  scenarioTag: {
    color: '#34D399',
    fontSize: 13,
    backgroundColor: '#064E3B',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    overflow: 'hidden',
    marginBottom: 24,
    textAlign: 'center',
  },
  scoreCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  scoreNumber: {
    color: '#34D399',
    fontSize: 42,
    fontWeight: '800',
  },
  scoreUnit: {
    color: '#94A3B8',
    fontSize: 14,
    marginTop: -4,
  },
  growthSummaryBox: {
    backgroundColor: '#064E3B',
    borderRadius: 14,
    padding: 18,
    width: '100%',
    marginBottom: 24,
  },
  growthSummaryLabel: {
    color: '#34D399',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  growthSummaryText: {
    color: '#D1FAE5',
    fontSize: 15,
    lineHeight: 22,
  },
  overallComment: {
    color: '#334155',
    fontSize: 15,
    lineHeight: 24,
    textAlign: 'center',
    marginVertical: 20,
    paddingHorizontal: 8,
  },
  feedbackSection: {
    width: '100%',
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  feedbackSectionTitle: {
    color: '#34D399',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  feedbackItem: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  feedbackBullet: {
    color: '#34D399',
    fontSize: 16,
    fontWeight: '700',
    marginRight: 8,
    width: 16,
  },
  feedbackItemText: {
    color: '#E2E8F0',
    fontSize: 14,
    lineHeight: 20,
    flex: 1,
  },
  expressionTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  expressionTag: {
    backgroundColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  expressionTagText: {
    color: '#60A5FA',
    fontSize: 13,
    fontWeight: '600',
  },
  storageBox: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  storageTitle: {
    color: '#64748B',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  storageHint: {
    color: '#94A3B8',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 10,
  },
  storagePath: {
    color: '#94A3B8',
    fontSize: 10,
    lineHeight: 14,
    marginBottom: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  androidFolderBtn: {
    backgroundColor: '#0F766E',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  androidFolderBtnText: {
    color: '#ECFDF5',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  shareBtn: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  shareBtnText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  shareBtnSecondary: {
    backgroundColor: '#E2E8F0',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  shareBtnSecondaryText: {
    color: '#E2E8F0',
    fontSize: 13,
    fontWeight: '600',
  },
  completeButton: {
    backgroundColor: '#34D399',
    borderRadius: 16,
    paddingVertical: 18,
    width: '100%',
    alignItems: 'center',
    marginTop: 8,
    shadowColor: '#34D399',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  completeButtonText: {
    color: '#064E3B',
    fontSize: 17,
    fontWeight: '800',
  },
});
