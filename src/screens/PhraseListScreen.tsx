import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '@react-navigation/native';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Speech from 'expo-speech';

import type {
  RootStackParamList,
  RootTabParamList,
} from '../navigation/RootNavigator';
import {
  listSavedPhrases,
  setPhraseSaved,
  type SavedPhraseRow,
} from '../db/schema';
import { startShadowing, type ShadowingController } from '../utils/shadowing';

const SHADOWING_REPS = 3;

type Props = CompositeScreenProps<
  BottomTabScreenProps<RootTabParamList, 'PhraseListTab'>,
  NativeStackScreenProps<RootStackParamList>
>;

export default function PhraseListScreen({ navigation }: Props) {
  const [phrases, setPhrases] = useState<SavedPhraseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  // プレイリスト再生状態。
  //   isPlaying : セッション進行中か
  //   playIndex : 現在のフレーズ（filtered 上の index）
  //   playStep  : そのフレーズの中の何回目か (1..SHADOWING_REPS)
  const [isPlaying, setIsPlaying] = useState(false);
  const [playIndex, setPlayIndex] = useState(0);
  const [playStep, setPlayStep] = useState(0);
  const shadowingCtrlRef = useRef<ShadowingController | null>(null);
  // onDone 内から最新の queue を参照するため、ref で現在のキューを保持する。
  const queueRef = useRef<SavedPhraseRow[]>([]);

  const stopAll = useCallback(() => {
    shadowingCtrlRef.current?.stop();
    shadowingCtrlRef.current = null;
    queueRef.current = [];
    setIsPlaying(false);
    setPlayIndex(0);
    setPlayStep(0);
  }, []);

  // アンマウント / 画面離脱時に確実に止める
  useEffect(() => {
    return () => {
      shadowingCtrlRef.current?.stop();
      shadowingCtrlRef.current = null;
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      return () => {
        shadowingCtrlRef.current?.stop();
        shadowingCtrlRef.current = null;
        queueRef.current = [];
        setIsPlaying(false);
        setPlayIndex(0);
        setPlayStep(0);
      };
    }, []),
  );

  // index 番目のフレーズをシャドーイングし、終わったら次へ進める。
  const playFromIndex = useCallback((index: number) => {
    const queue = queueRef.current;
    if (index >= queue.length) {
      // 全件完了
      shadowingCtrlRef.current = null;
      setIsPlaying(false);
      setPlayIndex(0);
      setPlayStep(0);
      return;
    }
    setPlayIndex(index);
    // 初回フレーズは音声生成で数秒かかる場合があるので、onStep が来るまで 0 にしておく。
    // UI 側は 0 のとき「音声を準備中…」を表示する。
    setPlayStep(0);
    const row = queue[index];
    const ctrl = startShadowing(row.phrase, {
      reps: SHADOWING_REPS,
      gapMs: 2000,
      onStep: (step) => setPlayStep(step),
      onDone: () => {
        // 次フレーズに進む前の小さな間
        setTimeout(() => playFromIndex(index + 1), 600);
      },
      onError: (msg) => {
        shadowingCtrlRef.current = null;
        setIsPlaying(false);
        setPlayIndex(0);
        setPlayStep(0);
        Alert.alert('再生エラー', msg);
      },
    });
    shadowingCtrlRef.current = ctrl;
  }, []);

  const startAll = useCallback(
    (list: SavedPhraseRow[], startIndex: number = 0) => {
      if (list.length === 0) return;
      shadowingCtrlRef.current?.stop();
      shadowingCtrlRef.current = null;
      queueRef.current = list;
      setIsPlaying(true);
      playFromIndex(startIndex);
    },
    [playFromIndex],
  );

  const reload = useCallback(async () => {
    try {
      const rows = await listSavedPhrases();
      setPhrases(rows);
    } catch (e) {
      console.warn('listSavedPhrases failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      reload();
    }, [reload]),
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return phrases;
    return phrases.filter(
      (p) =>
        p.phrase.toLowerCase().includes(q) ||
        p.translation.toLowerCase().includes(q) ||
        (p.session_title ?? p.session_summary ?? '').toLowerCase().includes(q),
    );
  }, [phrases, query]);

  const handleUnsave = useCallback(
    (row: SavedPhraseRow) => {
      Alert.alert('リストから外す', `「${row.phrase}」をフレーズリストから外しますか？`, [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '外す',
          style: 'destructive',
          onPress: async () => {
            try {
              await setPhraseSaved(row.id, false);
              setPhrases((prev) => prev.filter((p) => p.id !== row.id));
            } catch (e) {
              Alert.alert('エラー', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ]);
    },
    [],
  );

  const handleOpenSession = useCallback(
    (row: SavedPhraseRow) => {
      navigation.navigate('FolderTab', {
        screen: 'SessionDetail',
        params: { sessionId: row.session_id },
      });
    },
    [navigation],
  );

  const handleSpeak = useCallback((text: string) => {
    Speech.stop();
    Speech.speak(text, { language: 'en-US' });
  }, []);

  const renderItem = ({
    item,
    index,
  }: {
    item: SavedPhraseRow;
    index: number;
  }) => {
    const sourceLabel = item.session_title ?? item.session_summary ?? '無題';
    const isCurrent = isPlaying && index === playIndex;
    return (
      <View style={[styles.card, isCurrent && styles.cardActive]}>
        <View style={styles.cardHeader}>
          <Text style={styles.sourceLabel} numberOfLines={1}>
            {'\u{1F4C1}'} {sourceLabel}
          </Text>
          <TouchableOpacity
            onPress={() => handleUnsave(item)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.starIcon}>{'\u2605'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          onPress={() => handleSpeak(item.phrase)}
          activeOpacity={0.7}
        >
          <Text style={styles.phraseText}>{item.phrase}</Text>
          {item.translation ? (
            <Text style={styles.translationText}>{item.translation}</Text>
          ) : null}
        </TouchableOpacity>

        {isCurrent && (
          <View style={styles.nowPlayingRow}>
            <Text style={styles.nowPlayingText}>
              {playStep === 0
                ? '準備中…'
                : `${'\u25B6'} 再生中 (${playStep}/${SHADOWING_REPS})`}
            </Text>
          </View>
        )}

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => handleSpeak(item.phrase)}
            activeOpacity={0.7}
          >
            <Text style={styles.actionBtnText}>{'\u{1F3A7}'} 発音</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.actionBtnPrimary]}
            onPress={() => handleOpenSession(item)}
            activeOpacity={0.7}
          >
            <Text style={[styles.actionBtnText, styles.actionBtnTextPrimary]}>
              元のレッスンを開く
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.title}>フレーズリスト</Text>
        <Text style={styles.subtitle}>
          {loading ? '読み込み中...' : `${phrases.length} フレーズ`}
        </Text>
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.searchInput}
          placeholder="フレーズ・和訳・レッスン名で検索"
          placeholderTextColor="#94A3B8"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPlaying}
        />
      </View>

      {filtered.length > 0 && (
        <View style={styles.playAllWrap}>
          <TouchableOpacity
            style={[
              styles.playAllBtn,
              isPlaying && styles.playAllBtnActive,
            ]}
            onPress={() =>
              isPlaying ? stopAll() : startAll(filtered, 0)
            }
            activeOpacity={0.85}
          >
            <Text style={styles.playAllIcon}>
              {isPlaying ? '\u25A0' : '\u25B6'}
            </Text>
            <Text style={styles.playAllText}>
              {isPlaying
                ? playStep === 0
                  ? `音声を準備中... (${playIndex + 1}/${queueRef.current.length})`
                  : `停止 (${playIndex + 1}/${queueRef.current.length} · ${playStep}/${SHADOWING_REPS})`
                : `すべてシャドーイング ×${SHADOWING_REPS}`}
            </Text>
          </TouchableOpacity>
          {!isPlaying && (
            <Text style={styles.playAllHint}>
              各フレーズを {SHADOWING_REPS} 回ずつ読み上げ、2 秒の無音を挟んで{'\n'}
              次のフレーズに自動で進みます。
            </Text>
          )}
        </View>
      )}

      {loading ? (
        <View style={styles.emptyWrap}>
          <ActivityIndicator size="small" color="#7C3AED" />
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>
            {phrases.length === 0
              ? 'まだフレーズが保存されていません'
              : '一致するフレーズはありません'}
          </Text>
          {phrases.length === 0 && (
            <Text style={styles.emptyHint}>
              Step 1（Practice 画面）で各フレーズの{'\u2606'}を{'\n'}
              タップすると、ここに保存されます。
            </Text>
          )}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 72,
    paddingBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#7C3AED',
    marginTop: 4,
    fontWeight: '600',
  },
  searchWrap: {
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  searchInput: {
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#0F172A',
    fontSize: 14,
  },
  listContent: {
    paddingHorizontal: 24,
    paddingBottom: 32,
    gap: 12,
  },
  card: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sourceLabel: {
    flex: 1,
    fontSize: 11,
    color: '#64748B',
    fontWeight: '600',
    marginRight: 8,
  },
  starIcon: {
    fontSize: 22,
    color: '#F59E0B',
  },
  phraseText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0F172A',
    lineHeight: 24,
  },
  translationText: {
    fontSize: 13,
    color: '#475569',
    marginTop: 4,
    lineHeight: 19,
  },
  playAllWrap: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    gap: 6,
  },
  playAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#10B981',
  },
  playAllBtnActive: {
    backgroundColor: '#EF4444',
  },
  playAllIcon: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
  },
  playAllText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  playAllHint: {
    color: '#94A3B8',
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 2,
  },
  cardActive: {
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#10B981',
  },
  nowPlayingRow: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#10B981',
    marginTop: 4,
  },
  nowPlayingText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  actionBtnPrimary: {
    backgroundColor: '#7C3AED',
    borderColor: '#7C3AED',
  },
  actionBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
  },
  actionBtnTextPrimary: {
    color: '#FFFFFF',
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#475569',
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 19,
  },
});
