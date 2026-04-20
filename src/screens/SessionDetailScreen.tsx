import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type {
  FolderStackParamList,
  RootStackParamList,
  RootTabParamList,
} from '../navigation/RootNavigator';
import {
  getSessionWithDetails,
  clearSessionMedia,
  deleteSessionCompletely,
  loadSessionPracticeState,
  type PhraseRow,
  type PracticeLogRow,
  type SessionRow,
} from '../db/schema';
import {
  hasSessionMedia,
  inspectSessionFolder,
  loadScript,
  loadSegments,
  resolveSessionFolderPath,
  resolveSessionAudioUri,
} from '../utils/sessionStorage';
import type { ScriptTurn } from '../navigation/RootNavigator';

type Props = CompositeScreenProps<
  NativeStackScreenProps<FolderStackParamList, 'SessionDetail'>,
  CompositeScreenProps<
    BottomTabScreenProps<RootTabParamList>,
    NativeStackScreenProps<RootStackParamList>
  >
>;

function formatDate(iso: string): string {
  try {
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

function stepLabel(step: string): string {
  if (step === 'shadowing') return 'Step 1: Shadowing';
  if (step === 'roleplay') return 'Step 2: Roleplay';
  if (step === 'extension') return 'Step 3: Extension';
  return step;
}

function scoreColor(score: number | null): string {
  if (score == null) return '#94A3B8';
  if (score >= 80) return '#22C55E';
  if (score >= 60) return '#60A5FA';
  if (score >= 40) return '#FBBF24';
  return '#F87171';
}

export default function SessionDetailScreen({ route, navigation }: Props) {
  const { sessionId } = route.params;

  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SessionRow | null>(null);
  const [phrases, setPhrases] = useState<PhraseRow[]>([]);
  const [logs, setLogs] = useState<PracticeLogRow[]>([]);
  const [mediaExists, setMediaExists] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getSessionWithDetails(sessionId);
      if (!data) {
        Alert.alert('エラー', 'セッションが見つかりません');
        navigation.goBack();
        return;
      }
      setSession(data.session);
      setPhrases(data.phrases);
      setLogs(data.logs);
      if (data.session?.folder_path) {
        try {
          const exists = await hasSessionMedia(data.session.folder_path);
          setMediaExists(exists);
        } catch {
          setMediaExists(false);
        }
      } else {
        setMediaExists(false);
      }
    } finally {
      setLoading(false);
    }
  }, [sessionId, navigation]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDeleteMedia = useCallback(() => {
    Alert.alert(
      '音声ファイルを削除',
      'このセッションの音声ファイルだけを削除します。\nスコアやフィードバックなどの学習履歴はそのまま残ります。',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '音声を削除',
          style: 'destructive',
          onPress: async () => {
            try {
              await clearSessionMedia(sessionId);
              setMediaExists(false);
              Alert.alert('削除しました', '音声ファイルのみ削除されました。');
            } catch (e) {
              Alert.alert(
                'エラー',
                e instanceof Error ? e.message : String(e),
              );
            }
          },
        },
      ],
    );
  }, [sessionId]);

  const handleDeleteAll = useCallback(() => {
    Alert.alert(
      'セッションを完全に削除',
      'このセッションの動画と学習履歴をすべて削除します。\nこの操作は元に戻せません。',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '完全に削除',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteSessionCompletely(sessionId);
              navigation.goBack();
            } catch (e) {
              Alert.alert(
                'エラー',
                e instanceof Error ? e.message : String(e),
              );
            }
          },
        },
      ],
    );
  }, [sessionId, navigation]);

  const handleRepractice = useCallback(async () => {
    if (phrases.length === 0) {
      Alert.alert('フレーズがありません', 'このセッションには練習できるフレーズが保存されていません。');
      return;
    }
    const phraseStrings = phrases.map((p) => p.phrase);
    const phrasesWithTranslation = phrases.map((p) => ({
      phrase: p.phrase,
      translation: p.translation,
    }));

    // DB の folder_path は「フォルダ名のみ」(旧データでは絶対パス)。
    // iOS の documentDirectory は再起動や再インストールで UUID が変わるため、
    // ここで必ず「今の端末における絶対パス」へ解決し直してから Practice へ渡す。
    // これを経由しないと mp4 と segments.json が両方読めなくなり、
    // 再生ボタンが無反応・スクリプトが空で表示されるといった致命的なバグになる。
    const storedFolder = session?.folder_path ?? undefined;
    let resolvedFolder: string | undefined;
    let fileUri: string | undefined;
    let segments: { id: number; start: number; end: number; text: string }[] | undefined;
    let scriptTurns: ScriptTurn[] | undefined;
    let speakers: [string, string] | undefined;

    if (!storedFolder) {
      console.warn('[SessionDetail] handleRepractice: session.folder_path is empty — DB row has no folder link');
    }

    // 後で「診断だけ表示して遷移はしない」とするための欠落フラグ。
    let missingFolder = false;
    let missingDetails: string[] = [];

    if (storedFolder) {
      try {
        resolvedFolder = await resolveSessionFolderPath(storedFolder);
      } catch {
        resolvedFolder = storedFolder;
      }
      // 再入場前にフォルダ内を検査して、欠落ファイルがあればユーザーに通知する。
      try {
        const inspect = await inspectSessionFolder(resolvedFolder);
        console.warn(
          '[SessionDetail] inspectSessionFolder:',
          JSON.stringify(inspect),
        );
        if (!inspect.exists) {
          missingFolder = true;
          missingDetails.push(`フォルダが存在しません: ${inspect.folder}`);
        } else {
          if (!inspect.hasAudio) missingDetails.push('audio.m4a が無い');
          if (!inspect.hasSegments) missingDetails.push('segments.json が無い');
          if (!inspect.hasScript) missingDetails.push('script.json が無い');
        }
      } catch (e) {
        console.warn('[SessionDetail] inspectSessionFolder failed:', e);
      }
      try {
        // 新スキーマでは audio.m4a が優先され、旧 video.* が fallback。
        const resolvedUri = await resolveSessionAudioUri(resolvedFolder);
        if (resolvedUri) fileUri = resolvedUri;
      } catch {
        /* 音声ファイルが無いだけ。テキストだけでも練習は可能 */
      }
      try {
        const saved = await loadSegments(resolvedFolder);
        if (saved && saved.length > 0) segments = saved;
      } catch {
        /* segments が無ければフレーズ単位シークはできないが全体再生は可能 */
      }
      // scriptTurns / speakers を script.json から復元する。
      // これがないと Practice → Roleplay で "スクリプトが見つかりませんでした" に落ちる。
      try {
        const script = await loadScript(resolvedFolder);
        if (script && script.scriptTurns.length > 0) {
          scriptTurns = script.scriptTurns;
          if (script.speakers.length >= 2) {
            speakers = [script.speakers[0], script.speakers[1]] as [string, string];
          } else {
            // 保存時に speakers が空だったセッションでも、scriptTurns 内の
            // speaker フィールドから一意な話者 2 名を導出すれば Step 2 に
            // 進める。これで「話者ボタンが消える」「Roleplay できない」症状を回避。
            const uniq: string[] = [];
            for (const t of script.scriptTurns) {
              if (t.speaker && !uniq.includes(t.speaker)) uniq.push(t.speaker);
              if (uniq.length >= 2) break;
            }
            if (uniq.length >= 2) {
              speakers = [uniq[0], uniq[1]] as [string, string];
            }
          }
        }
      } catch {
        /* スクリプトが保存されていないセッションでは Roleplay ステップをスキップする */
      }
    }

    // 前回 Step 1 で行ったフレーズ削除や話者選択の状態を DB から復元する。
    // なければ undefined のまま渡して PracticeScreen 側でデフォルト (全フレーズ残・役 0) を使わせる。
    let initialActivePhrases: number[] | undefined;
    let initialSpeakerAssign: number[] | undefined;
    let initialSelectedRole: number | undefined;
    try {
      const saved = await loadSessionPracticeState(sessionId);
      if (saved) {
        if (saved.activePhrases) initialActivePhrases = saved.activePhrases;
        if (saved.speakerAssign) initialSpeakerAssign = saved.speakerAssign;
        if (saved.selectedSpeaker != null) initialSelectedRole = saved.selectedSpeaker;
      }
    } catch (e) {
      console.warn('[SessionDetail] loadSessionPracticeState failed:', e);
    }

    console.warn(
      '[SessionDetail] handleRepractice → Practice params:',
      JSON.stringify(
        {
          storedFolder,
          resolvedFolder,
          fileUri: fileUri ?? null,
          segmentsCount: segments?.length ?? 0,
          scriptTurnsCount: scriptTurns?.length ?? 0,
          speakers: speakers ?? null,
          transcriptLen: session?.transcript?.length ?? 0,
          initialActivePhrases: initialActivePhrases ?? null,
          initialSpeakerAssign: initialSpeakerAssign ?? null,
          initialSelectedRole: initialSelectedRole ?? null,
        },
        null,
        2,
      ),
    );

    // フォルダ自体が見つからない場合は、音声もスクリプトも復元不能なので、
    // 遷移せずにその旨をユーザーに明確に伝える。
    if (missingFolder) {
      Alert.alert(
        'セッションデータが見つかりません',
        `保存フォルダが端末に残っていないため、音声再生と Roleplay は利用できません。\n\n${missingDetails.join('\n')}\n\n新しい動画を解析し直して練習してください。`,
      );
      return;
    }

    // 一部ファイルだけ欠けている場合は、できるところまで復元して進む。
    if (missingDetails.length > 0) {
      console.warn('[SessionDetail] re-practice with missing files:', missingDetails);
    }

    // sessionFolder として渡す値はフォルダ名（DB に入っている値）で統一する。
    // 下流の保存 API (saveSegments / saveScript / saveStep1Data) はいずれも
    // 内部で resolveSessionFolderPath を通して現在の documentDirectory と
    // 結合し直すため、絶対パスを持ち回る必要はない。絶対パスを回すと
    // iOS の UUID 変化で将来的に無効化されるリスクが残る。
    navigation.navigate('Practice', {
      phrases: phraseStrings,
      phrasesWithTranslation,
      transcript: session?.transcript,
      fileUri,
      segments,
      scriptTurns,
      speakers,
      sessionFolder: storedFolder ?? resolvedFolder,
      sessionId,
      initialActivePhrases,
      initialSpeakerAssign,
      initialSelectedRole,
    });
  }, [phrases, session, sessionId, navigation]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#A78BFA" />
      </View>
    );
  }

  if (!session) return null;

  const title = session.summary && session.summary !== 'Practice session'
    ? session.summary
    : (session.transcript.split('\n').find((l) => l.trim().length > 0) ?? '無題の練習').slice(0, 60);

  const bestScore = logs.reduce<number | null>((best, l) => {
    if (l.score == null) return best;
    return best == null ? l.score : Math.max(best, l.score);
  }, null);

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        {/* Title */}
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.date}>{formatDate(session.created_at)}</Text>

        {/* Best Score */}
        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>BEST SCORE</Text>
          <View style={styles.scoreRow}>
            <Text style={[styles.scoreNumber, { color: scoreColor(bestScore) }]}>
              {bestScore ?? '-'}
            </Text>
            <Text style={styles.scoreUnit}>/ 100</Text>
          </View>
        </View>

        {/* Repractice CTA */}
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={handleRepractice}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryBtnText}>
            この内容でもう一度練習する {'\u2192'}
          </Text>
        </TouchableOpacity>

        {/* Phrases */}
        <Text style={styles.sectionTitle}>練習フレーズ ({phrases.length})</Text>
        <View style={styles.section}>
          {phrases.map((p) => (
            <View key={p.id} style={styles.phraseRow}>
              <Text style={styles.phraseEn}>{p.phrase}</Text>
              {!!p.translation && (
                <Text style={styles.phraseJa}>{p.translation}</Text>
              )}
            </View>
          ))}
          {phrases.length === 0 && (
            <Text style={styles.emptyText}>フレーズが保存されていません。</Text>
          )}
        </View>

        {/* Practice Logs */}
        <Text style={styles.sectionTitle}>練習ログ ({logs.length})</Text>
        <View style={styles.section}>
          {logs.map((log) => (
            <View key={log.id} style={styles.logRow}>
              <View style={styles.logHeader}>
                <Text style={styles.logStep}>{stepLabel(log.step)}</Text>
                <Text style={[styles.logScore, { color: scoreColor(log.score) }]}>
                  {log.score ?? '-'} / 100
                </Text>
              </View>
              <Text style={styles.logDate}>{formatDate(log.created_at)}</Text>
              {!!log.feedback && (
                <Text style={styles.logFeedback} numberOfLines={8}>
                  {renderFeedback(log.feedback)}
                </Text>
              )}
            </View>
          ))}
          {logs.length === 0 && (
            <Text style={styles.emptyText}>
              このセッションでの練習ログはまだありません。
            </Text>
          )}
        </View>

        {/* Danger zone */}
        <Text style={styles.sectionTitle}>データ管理</Text>
        <View style={styles.dangerSection}>
          <Text style={styles.dangerHint}>
            {mediaExists
              ? '音声ファイルが保存されています。容量を空けたい場合は削除できます（学習履歴は残ります）。'
              : '音声ファイルは既に削除されているか、元々保存されていません。'}
          </Text>
          {mediaExists && (
            <TouchableOpacity
              style={styles.dangerBtn}
              onPress={handleDeleteMedia}
              activeOpacity={0.85}
            >
              <Text style={styles.dangerBtnIcon}>{'\u{1F5D1}'}</Text>
              <Text style={styles.dangerBtnText}>音声ファイルだけ削除</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.dangerBtn, styles.dangerBtnHard]}
            onPress={handleDeleteAll}
            activeOpacity={0.85}
          >
            <Text style={styles.dangerBtnIcon}>{'\u26A0'}</Text>
            <Text style={styles.dangerBtnText}>セッションごと完全削除</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function renderFeedback(raw: string): string {
  // Roleplay / Extension のフィードバックは JSON 文字列のことがあるので整形する
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const lines: string[] = [];
    if (typeof parsed.overallComment === 'string') lines.push(parsed.overallComment);
    if (typeof parsed.growthSummary === 'string') lines.push(parsed.growthSummary);
    if (Array.isArray(parsed.goodPoints)) {
      lines.push(...parsed.goodPoints.map((p) => `+ ${p}`));
    }
    if (Array.isArray(parsed.improvements)) {
      lines.push(...parsed.improvements.map((p) => `! ${p}`));
    }
    if (lines.length > 0) return lines.join('\n');
  } catch {
    /* plain text fallback */
  }
  return raw;
}

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
  content: {
    padding: 20,
    paddingBottom: 48,
  },
  title: {
    color: '#0F172A',
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 28,
  },
  date: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
    marginBottom: 20,
  },
  scoreCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 18,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  scoreLabel: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    marginTop: 4,
  },
  scoreNumber: {
    fontSize: 40,
    fontWeight: '800',
  },
  scoreUnit: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
  },
  primaryBtn: {
    backgroundColor: '#8B5CF6',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 28,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
  },
  sectionTitle: {
    color: '#64748B',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 10,
    marginTop: 4,
  },
  section: {
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    padding: 14,
    marginBottom: 20,
  },
  phraseRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  phraseEn: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 22,
  },
  phraseJa: {
    color: '#64748B',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  emptyText: {
    color: '#94A3B8',
    fontSize: 13,
    padding: 8,
    textAlign: 'center',
  },
  logRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  logStep: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '700',
  },
  logScore: {
    fontSize: 15,
    fontWeight: '800',
  },
  logDate: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 6,
  },
  logFeedback: {
    color: '#334155',
    fontSize: 13,
    lineHeight: 18,
  },
  dangerSection: {
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#FEE2E2',
    gap: 10,
  },
  dangerHint: {
    color: '#64748B',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 4,
  },
  dangerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FEE2E2',
    borderRadius: 10,
    paddingVertical: 12,
  },
  dangerBtnHard: {
    backgroundColor: '#991B1B',
  },
  dangerBtnIcon: {
    fontSize: 15,
  },
  dangerBtnText: {
    color: '#991B1B',
    fontSize: 14,
    fontWeight: '700',
  },
});
