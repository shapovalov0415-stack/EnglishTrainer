import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Modal,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootTabParamList, FolderStackParamList } from '../navigation/RootNavigator';
import {
  createFolder,
  getSessionsWithBestScores,
  listFoldersWithCounts,
  type FolderWithCountRow,
  type SessionHistoryRow,
} from '../db/schema';
import SessionCard from '../components/SessionCard';
import SessionActionsModal from '../components/SessionActionsModal';

type Props = CompositeScreenProps<
  NativeStackScreenProps<FolderStackParamList, 'FolderList'>,
  BottomTabScreenProps<RootTabParamList>
>;

export default function HistoryScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const [folders, setFolders] = useState<FolderWithCountRow[]>([]);
  const [uncategorized, setUncategorized] = useState<SessionHistoryRow[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionSession, setActionSession] = useState<SessionHistoryRow | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  const load = useCallback(async () => {
    try {
      const [folderRows, allRows, uncRows] = await Promise.all([
        listFoldersWithCounts(),
        getSessionsWithBestScores(),
        getSessionsWithBestScores(null),
      ]);
      setFolders(folderRows);
      setTotalSessions(allRows.length);
      setUncategorized(uncRows);
    } catch (e) {
      console.warn('Failed to load history:', e);
      setFolders([]);
      setUncategorized([]);
      setTotalSessions(0);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      Alert.alert('入力してください', 'フォルダー名を入力してください。');
      return;
    }
    setCreatingFolder(true);
    try {
      await createFolder(name);
      setNewFolderName('');
      setCreateFolderOpen(false);
      await load();
    } catch (e) {
      Alert.alert('エラー', e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingFolder(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#A78BFA" />
      </View>
    );
  }

  const isEmpty = folders.length === 0 && uncategorized.length === 0;

  if (isEmpty) {
    return (
      <View style={styles.centered}>
        <StatusBar style="dark" />
        <Text style={styles.emptyEmoji}>{'\u{1F4DA}'}</Text>
        <Text style={styles.emptyTitle}>まだ練習履歴がありません</Text>
        <Text style={styles.emptyDesc}>
          Home タブで動画やテキストを{'\n'}解析すると、ここにフォルダーと履歴が並びます。
        </Text>
        <TouchableOpacity
          style={styles.emptyCreateBtn}
          onPress={() => setCreateFolderOpen(true)}
          activeOpacity={0.85}
        >
          <Text style={styles.emptyCreateBtnText}>{'\u002B'} フォルダーを作成</Text>
        </TouchableOpacity>

        <Modal
          visible={createFolderOpen}
          animationType="fade"
          transparent
          onRequestClose={() => setCreateFolderOpen(false)}
        >
          <KeyboardAvoidingView
            style={styles.modalBackdrop}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <TouchableOpacity
              style={StyleSheet.absoluteFill}
              activeOpacity={1}
              onPress={() => setCreateFolderOpen(false)}
            />
            <View style={styles.modalSheet}>
              <Text style={styles.modalTitle}>新規フォルダー</Text>
              <TextInput
                style={styles.modalInput}
                value={newFolderName}
                onChangeText={setNewFolderName}
                placeholder="フォルダー名"
                placeholderTextColor="#94A3B8"
                autoFocus
                maxLength={50}
              />
              <View style={styles.modalRow}>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnGhost]}
                  onPress={() => setCreateFolderOpen(false)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.modalBtnGhostText}>キャンセル</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnPrimary]}
                  onPress={handleCreateFolder}
                  disabled={creatingFolder}
                  activeOpacity={0.85}
                >
                  <Text style={styles.modalBtnPrimaryText}>
                    {creatingFolder ? '作成中…' : '作成'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: Math.max(insets.top, 16) + 24 },
        ]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#A78BFA" />
        }
      >
        <View style={styles.titleRow}>
          <View style={styles.titleBlock}>
            <Text style={styles.header}>フォルダー</Text>
            <Text style={styles.subHeader}>{totalSessions} セッション</Text>
          </View>
          <TouchableOpacity
            style={styles.addFolderBtn}
            onPress={() => setCreateFolderOpen(true)}
            activeOpacity={0.85}
          >
            <Text style={styles.addFolderBtnText}>{'\u002B'}</Text>
          </TouchableOpacity>
        </View>

        {folders.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>FOLDERS {'\u{1F4C1}'}</Text>
            {folders.map((f) => (
              <TouchableOpacity
                key={f.id}
                style={styles.folderCard}
                activeOpacity={0.85}
                onPress={() =>
                  navigation.navigate('FolderDetail', { folderId: f.id })
                }
              >
                <Text style={styles.folderIcon}>{'\u{1F4C1}'}</Text>
                <View style={styles.folderCardBody}>
                  <Text style={styles.folderName} numberOfLines={2}>
                    {f.name}
                  </Text>
                  <Text style={styles.folderMeta}>
                    {f.session_count} セッション
                  </Text>
                </View>
                <Text style={styles.folderChevron}>{'\u203A'}</Text>
              </TouchableOpacity>
            ))}
          </>
        )}

        <Text style={[styles.sectionLabel, folders.length > 0 && styles.sectionSpaced]}>
          未分類
        </Text>
        {uncategorized.length === 0 ? (
          <View style={styles.uncatEmpty}>
            <Text style={styles.uncatEmptyText}>
              未分類のセッションはありません。{'\n'}
              カードの「⋯」からフォルダーへ移動できます。
            </Text>
          </View>
        ) : (
          uncategorized.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              onOpen={() =>
                navigation.navigate('SessionDetail', { sessionId: s.id })
              }
              onEdit={() => {
                setActionSession(s);
                setModalVisible(true);
              }}
            />
          ))
        )}
      </ScrollView>

      <SessionActionsModal
        visible={modalVisible}
        session={actionSession}
        onClose={() => {
          setModalVisible(false);
          setActionSession(null);
        }}
        onChanged={load}
      />

      <Modal
        visible={createFolderOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setCreateFolderOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setCreateFolderOpen(false)}
          />
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>新規フォルダー</Text>
            <TextInput
              style={styles.modalInput}
              value={newFolderName}
              onChangeText={setNewFolderName}
              placeholder="フォルダー名"
              placeholderTextColor="#94A3B8"
              autoFocus
              maxLength={50}
            />
            <View style={styles.modalRow}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setCreateFolderOpen(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.modalBtnGhostText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={handleCreateFolder}
                disabled={creatingFolder}
                activeOpacity={0.85}
              >
                <Text style={styles.modalBtnPrimaryText}>
                  {creatingFolder ? '作成中…' : '作成'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
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
    padding: 32,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyDesc: {
    color: '#64748B',
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 24,
  },
  emptyCreateBtn: {
    backgroundColor: '#8B5CF6',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 12,
  },
  emptyCreateBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 24,
    gap: 12,
  },
  titleBlock: {
    flex: 1,
  },
  header: {
    color: '#0F172A',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  subHeader: {
    color: '#60A5FA',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  addFolderBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  addFolderBtnText: {
    color: '#A78BFA',
    fontSize: 26,
    fontWeight: '700',
    marginTop: -2,
  },
  sectionLabel: {
    color: '#64748B',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  sectionSpaced: {
    marginTop: 8,
  },
  folderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 18,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 12,
  },
  folderIcon: {
    fontSize: 28,
  },
  folderCardBody: {
    flex: 1,
  },
  folderName: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  folderMeta: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  folderChevron: {
    color: '#A78BFA',
    fontSize: 24,
    fontWeight: '700',
  },
  uncatEmpty: {
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  uncatEmptyText: {
    color: '#94A3B8',
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 24,
  },
  modalSheet: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  modalTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 12,
  },
  modalInput: {
    backgroundColor: '#FFFFFF',
    color: '#0F172A',
    fontSize: 15,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  modalRow: {
    flexDirection: 'row',
    gap: 10,
  },
  modalBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalBtnGhost: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  modalBtnGhostText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '700',
  },
  modalBtnPrimary: {
    backgroundColor: '#8B5CF6',
  },
  modalBtnPrimaryText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '800',
  },
});
