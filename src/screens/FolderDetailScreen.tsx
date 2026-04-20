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
import type {
  FolderStackParamList,
  RootStackParamList,
  RootTabParamList,
} from '../navigation/RootNavigator';
import {
  deleteFolder,
  getFolder,
  getSessionsWithBestScores,
  renameFolder,
  type FolderRow,
  type SessionHistoryRow,
} from '../db/schema';
import SessionCard from '../components/SessionCard';
import SessionActionsModal from '../components/SessionActionsModal';

type Props = CompositeScreenProps<
  NativeStackScreenProps<FolderStackParamList, 'FolderDetail'>,
  CompositeScreenProps<
    BottomTabScreenProps<RootTabParamList>,
    NativeStackScreenProps<RootStackParamList>
  >
>;

export default function FolderDetailScreen({ route, navigation }: Props) {
  const { folderId } = route.params;
  const insets = useSafeAreaInsets();

  const [folder, setFolder] = useState<FolderRow | null>(null);
  const [sessions, setSessions] = useState<SessionHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionSession, setActionSession] = useState<SessionHistoryRow | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);

  const load = useCallback(async () => {
    try {
      const f = await getFolder(folderId);
      if (!f) {
        Alert.alert('エラー', 'フォルダーが見つかりません');
        navigation.goBack();
        return;
      }
      setFolder(f);
      const rows = await getSessionsWithBestScores(folderId);
      setSessions(rows);
    } catch (e) {
      console.warn('FolderDetail load failed', e);
      Alert.alert('エラー', '読み込みに失敗しました');
      navigation.goBack();
    }
  }, [folderId, navigation]);

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

  const openRename = () => {
    if (folder) setNameDraft(folder.name);
    setRenameOpen(true);
  };

  const saveRename = async () => {
    setSavingName(true);
    try {
      await renameFolder(folderId, nameDraft);
      await load();
      setRenameOpen(false);
    } catch (e) {
      Alert.alert('エラー', e instanceof Error ? e.message : String(e));
    } finally {
      setSavingName(false);
    }
  };

  const confirmDeleteFolder = () => {
    Alert.alert(
      'フォルダーを削除',
      '中のセッションは未分類に戻ります（削除されません）。',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteFolder(folderId);
              navigation.goBack();
            } catch (e) {
              Alert.alert('エラー', e instanceof Error ? e.message : String(e));
            }
          },
        },
      ],
    );
  };

  if (loading || !folder) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#A78BFA" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.7}
        >
          <Text style={styles.backBtnText}>{'\u2039'} 戻る</Text>
        </TouchableOpacity>
        <Text style={styles.topTitle} numberOfLines={1}>
          {folder.name}
        </Text>
        <TouchableOpacity
          style={styles.menuBtn}
          onPress={() => {
            Alert.alert('フォルダー', undefined, [
              { text: '名前を変更', onPress: openRename },
              { text: 'フォルダーを削除', style: 'destructive', onPress: confirmDeleteFolder },
              { text: 'キャンセル', style: 'cancel' },
            ]);
          }}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.7}
        >
          <Text style={styles.menuBtnText}>{'\u22EF'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#A78BFA" />
        }
      >
        <Text style={styles.subHeader}>{sessions.length} セッション</Text>
        <Text style={styles.sectionLabel}>PAST PRACTICE {'\u2728'}</Text>

        {sessions.length === 0 ? (
          <View style={styles.emptyFolder}>
            <Text style={styles.emptyFolderEmoji}>{'\u{1F4C2}'}</Text>
            <Text style={styles.emptyFolderText}>
              このフォルダーにセッションはまだありません。{'\n'}
              一覧でカードの「⋯」から移動できます。
            </Text>
          </View>
        ) : (
          sessions.map((s) => (
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
        visible={renameOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setRenameOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.renameBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setRenameOpen(false)}
          />
          <View style={styles.renameSheet}>
            <Text style={styles.renameTitle}>フォルダー名</Text>
            <TextInput
              style={styles.renameInput}
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder="名前"
              placeholderTextColor="#94A3B8"
              autoFocus
              maxLength={50}
            />
            <View style={styles.renameRow}>
              <TouchableOpacity
                style={[styles.renameBtn, styles.renameBtnGhost]}
                onPress={() => setRenameOpen(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.renameBtnGhostText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.renameBtn, styles.renameBtnPrimary]}
                onPress={saveRename}
                disabled={savingName}
                activeOpacity={0.8}
              >
                <Text style={styles.renameBtnPrimaryText}>
                  {savingName ? '保存中…' : '保存'}
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
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F8FAFC',
    gap: 8,
  },
  backBtn: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  backBtnText: {
    color: '#A78BFA',
    fontSize: 16,
    fontWeight: '700',
  },
  topTitle: {
    flex: 1,
    color: '#0F172A',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  menuBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
  },
  menuBtnText: {
    color: '#A78BFA',
    fontSize: 20,
    fontWeight: '800',
    marginTop: -2,
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  subHeader: {
    color: '#60A5FA',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 20,
  },
  sectionLabel: {
    color: '#64748B',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  emptyFolder: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
  },
  emptyFolderEmoji: {
    fontSize: 40,
    marginBottom: 12,
  },
  emptyFolderText: {
    color: '#64748B',
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  renameBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    padding: 24,
  },
  renameSheet: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  renameTitle: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 12,
  },
  renameInput: {
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
  renameRow: {
    flexDirection: 'row',
    gap: 10,
  },
  renameBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  renameBtnGhost: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  renameBtnGhostText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '700',
  },
  renameBtnPrimary: {
    backgroundColor: '#8B5CF6',
  },
  renameBtnPrimaryText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '800',
  },
});
