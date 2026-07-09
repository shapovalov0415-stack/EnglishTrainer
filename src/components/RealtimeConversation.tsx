import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  startRealtimeSession,
  type RealtimeController,
  type RealtimeStatus,
  type RealtimeTurn,
} from '../utils/realtime';

interface Props {
  /** 会話の役割・シナリオ・使わせたいフレーズ（session instructions） */
  instructions: string;
  /** 出力音声（marin / cedar など） */
  voice: string;
  /** シナリオ表示用ラベル */
  scenarioLabel?: string;
  /** 「終了して評価」時に、会話の文字起こしを渡す */
  onEnd: (turns: RealtimeTurn[]) => void;
  /** 何も話さず戻る */
  onCancel: () => void;
}

const STATUS_LABEL: Record<RealtimeStatus, string> = {
  connecting: '接続中...',
  connected: '会話中 — そのまま話しかけてください',
  listening: 'あなたの声を聞いています...',
  speaking: 'AI が話しています...',
  closed: '終了しました',
  error: 'エラー',
};

export default function RealtimeConversation({
  instructions,
  voice,
  scenarioLabel,
  onEnd,
  onCancel,
}: Props) {
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [turns, setTurns] = useState<RealtimeTurn[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const controllerRef = useRef<RealtimeController | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // 二重起動防止（StrictMode / 再レンダー対策）
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const controller = await startRealtimeSession({
          instructions,
          voice,
          onStatus: (s) => {
            if (!cancelled) setStatus(s);
          },
          onTranscript: (turn) => {
            if (!cancelled) setTurns((prev) => [...prev, turn]);
          },
          onError: (msg) => {
            if (!cancelled) setErrorMsg(msg);
          },
        });
        if (cancelled) {
          controller.stop();
          return;
        }
        controllerRef.current = controller;
      } catch (e) {
        if (!cancelled) {
          setErrorMsg(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      controllerRef.current?.stop().catch(() => {});
    };
  }, [instructions, voice]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [turns]);

  const handleEnd = useCallback(async () => {
    const collected = controllerRef.current?.getTranscript() ?? turns;
    await controllerRef.current?.stop().catch(() => {});
    onEnd(collected);
  }, [onEnd, turns]);

  const handleCancel = useCallback(async () => {
    await controllerRef.current?.stop().catch(() => {});
    onCancel();
  }, [onCancel]);

  const userTurnCount = turns.filter((t) => t.role === 'user').length;
  const canEnd = userTurnCount >= 2 && status !== 'connecting';

  if (errorMsg) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorEmoji}>{'\u{1F615}'}</Text>
        <Text style={styles.errorTitle}>リアルタイム会話に接続できませんでした</Text>
        <Text style={styles.errorBody}>{errorMsg}</Text>
        <TouchableOpacity style={styles.secondaryBtn} onPress={handleCancel}>
          <Text style={styles.secondaryBtnText}>テキスト会話に戻る</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isLive =
    status === 'connected' || status === 'listening' || status === 'speaking';

  return (
    <View style={styles.container}>
      {scenarioLabel ? (
        <Text style={styles.scenario}>{scenarioLabel}</Text>
      ) : null}

      {/* ステータスインジケータ */}
      <View style={styles.statusRow}>
        <View
          style={[
            styles.dot,
            status === 'listening' && styles.dotListening,
            status === 'speaking' && styles.dotSpeaking,
            status === 'connecting' && styles.dotConnecting,
          ]}
        />
        <Text style={styles.statusText}>{STATUS_LABEL[status]}</Text>
        {status === 'connecting' && (
          <ActivityIndicator size="small" color="#34D399" style={{ marginLeft: 8 }} />
        )}
      </View>

      {/* 会話の文字起こし（リアルタイム） */}
      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
      >
        {turns.length === 0 && isLive && (
          <Text style={styles.hint}>
            マイクに向かって英語で話しかけてみましょう。{'\n'}
            AI が相手役として自然に返してくれます。
          </Text>
        )}
        {turns.map((t, i) => (
          <View
            key={i}
            style={[
              styles.bubble,
              t.role === 'user' ? styles.bubbleUser : styles.bubbleAi,
            ]}
          >
            <Text style={styles.bubbleRole}>
              {t.role === 'user' ? 'あなた' : 'AI'}
            </Text>
            <Text style={styles.bubbleText}>{t.text}</Text>
          </View>
        ))}
      </ScrollView>

      {/* コントロール */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.endBtn, !canEnd && styles.endBtnDisabled]}
          onPress={handleEnd}
          disabled={!canEnd}
        >
          <Text style={styles.endBtnText}>
            {canEnd ? '終了して評価する' : 'もう少し会話してみましょう'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
          <Text style={styles.cancelBtnText}>やめる</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFFFFF', padding: 16 },
  centered: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  scenario: {
    fontSize: 13,
    color: '#059669',
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginBottom: 12,
    overflow: 'hidden',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#34D399',
    marginRight: 8,
  },
  dotConnecting: { backgroundColor: '#FBBF24' },
  dotListening: { backgroundColor: '#3B82F6' },
  dotSpeaking: { backgroundColor: '#8B5CF6' },
  statusText: { fontSize: 14, color: '#334155', fontWeight: '600' },
  transcript: { flex: 1, backgroundColor: '#F8FAFC', borderRadius: 12 },
  transcriptContent: { padding: 12 },
  hint: {
    color: '#94A3B8',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginTop: 40,
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 10,
  },
  bubbleUser: {
    alignSelf: 'flex-end',
    backgroundColor: '#DBEAFE',
  },
  bubbleAi: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  bubbleRole: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748B',
    marginBottom: 3,
  },
  bubbleText: { fontSize: 15, color: '#0F172A', lineHeight: 21 },
  controls: { marginTop: 12 },
  endBtn: {
    backgroundColor: '#10B981',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  endBtnDisabled: { backgroundColor: '#A7F3D0' },
  endBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  cancelBtn: { paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: { color: '#94A3B8', fontSize: 14, fontWeight: '600' },
  errorEmoji: { fontSize: 40, marginBottom: 12 },
  errorTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 20,
  },
  secondaryBtn: {
    backgroundColor: '#EDE9FE',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  secondaryBtnText: { color: '#6D28D9', fontSize: 15, fontWeight: '700' },
});
