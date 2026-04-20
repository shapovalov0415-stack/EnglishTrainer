import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  StyleSheet,
  Alert,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {
  createFolder,
  deleteSessionCompletely,
  listFolders,
  moveSessionToFolder,
  updateSessionTitle,
  type FolderRow,
  type SessionHistoryRow,
} from '../db/schema';

type Phase = 'menu' | 'rename' | 'move';

interface Props {
  visible: boolean;
  session: SessionHistoryRow | null;
  onClose: () => void;
  onChanged: () => void;
}

export default function SessionActionsModal({
  visible,
  session,
  onClose,
  onChanged,
}: Props) {
  const [phase, setPhase] = useState<Phase>('menu');
  const [titleDraft, setTitleDraft] = useState('');
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [newFolderName, setNewFolderName] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset state each time the modal opens
  useEffect(() => {
    if (visible) {
      setPhase('menu');
      setTitleDraft(session?.display_title ?? '');
      setNewFolderName('');
    }
  }, [visible, session]);

  const loadFolders = useCallback(async () => {
    try {
      const rows = await listFolders();
      setFolders(rows);
    } catch (e) {
      console.warn('loadFolders failed', e);
    }
  }, []);

  useEffect(() => {
    if (phase === 'move') {
      loadFolders();
    }
  }, [phase, loadFolders]);

  if (!session) return null;

  const handleRename = async () => {
    setBusy(true);
    try {
      await updateSessionTitle(session.id, titleDraft);
      onChanged();
      onClose();
    } catch (e) {
      Alert.alert('エラー', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleMoveTo = async (folderId: number | null) => {
    setBusy(true);
    try {
      await moveSessionToFolder(session.id, folderId);
      onChanged();
      onClose();
    } catch (e) {
      Alert.alert('エラー', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateAndMove = async () => {
    const name = newFolderName.trim();
    if (!name) {
      Alert.alert('入力してください', 'フォルダー名を入力してください。');
      return;
    }
    setBusy(true);
    try {
      const newId = await createFolder(name);
      await moveSessionToFolder(session.id, newId);
      onChanged();
      onClose();
    } catch (e) {
      Alert.alert('エラー', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
      'セッションを完全に削除',
      '動画も学習履歴もすべて削除します。元に戻せません。',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '完全に削除',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await deleteSessionCompletely(session.id);
              onChanged();
              onClose();
            } catch (e) {
              Alert.alert('エラー', e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.backdropTouchable}
          onPress={onClose}
        />

        <View style={styles.sheet}>
          {busy && (
            <View style={styles.busyOverlay} pointerEvents="auto">
              <ActivityIndicator size="large" color="#A78BFA" />
            </View>
          )}

          {phase === 'menu' && (
            <>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {session.display_title}
              </Text>
              <MenuItem
                icon={'\u270E'}
                label="タイトルを編集"
                onPress={() => setPhase('rename')}
              />
              <MenuItem
                icon={'\u{1F4C1}'}
                label="フォルダーに移動"
                onPress={() => setPhase('move')}
              />
              <MenuItem
                icon={'\u{1F5D1}'}
                label="セッションを削除"
                onPress={handleDelete}
                destructive
              />
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={onClose}
                activeOpacity={0.7}
              >
                <Text style={styles.cancelBtnText}>閉じる</Text>
              </TouchableOpacity>
            </>
          )}

          {phase === 'rename' && (
            <>
              <Text style={styles.sheetTitle}>レッスン名の変更</Text>
              <TextInput
                style={styles.input}
                value={titleDraft}
                onChangeText={setTitleDraft}
                placeholder="新しいタイトル"
                placeholderTextColor="#94A3B8"
                autoFocus
                maxLength={100}
              />
              <View style={styles.rowButtons}>
                <TouchableOpacity
                  style={[styles.footerBtn, styles.footerBtnGhost]}
                  onPress={() => setPhase('menu')}
                  activeOpacity={0.7}
                >
                  <Text style={styles.footerBtnGhostText}>戻る</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.footerBtn, styles.footerBtnPrimary]}
                  onPress={handleRename}
                  activeOpacity={0.8}
                >
                  <Text style={styles.footerBtnPrimaryText}>保存</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {phase === 'move' && (
            <>
              <Text style={styles.sheetTitle}>フォルダーに移動</Text>

              <ScrollView style={styles.folderList} keyboardShouldPersistTaps="handled">
                <TouchableOpacity
                  style={[
                    styles.folderItem,
                    session.folder_id == null && styles.folderItemActive,
                  ]}
                  onPress={() => handleMoveTo(null)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.folderIcon}>{'\u2205'}</Text>
                  <Text style={styles.folderName}>未分類</Text>
                  {session.folder_id == null && (
                    <Text style={styles.folderCheck}>{'\u2713'}</Text>
                  )}
                </TouchableOpacity>

                {folders.map((f) => (
                  <TouchableOpacity
                    key={f.id}
                    style={[
                      styles.folderItem,
                      session.folder_id === f.id && styles.folderItemActive,
                    ]}
                    onPress={() => handleMoveTo(f.id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.folderIcon}>{'\u{1F4C1}'}</Text>
                    <Text style={styles.folderName} numberOfLines={1}>
                      {f.name}
                    </Text>
                    {session.folder_id === f.id && (
                      <Text style={styles.folderCheck}>{'\u2713'}</Text>
                    )}
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <View style={styles.createRow}>
                <TextInput
                  style={styles.createInput}
                  value={newFolderName}
                  onChangeText={setNewFolderName}
                  placeholder="新規フォルダー名"
                  placeholderTextColor="#94A3B8"
                  maxLength={50}
                />
                <TouchableOpacity
                  style={styles.createBtn}
                  onPress={handleCreateAndMove}
                  activeOpacity={0.8}
                >
                  <Text style={styles.createBtnText}>{'\u002B'} 作成して移動</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.footerBtn, styles.footerBtnGhost]}
                onPress={() => setPhase('menu')}
                activeOpacity={0.7}
              >
                <Text style={styles.footerBtnGhostText}>戻る</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function MenuItem({
  icon,
  label,
  onPress,
  destructive,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPress} activeOpacity={0.7}>
      <Text style={styles.menuIcon}>{icon}</Text>
      <Text style={[styles.menuLabel, destructive && styles.menuLabelDestructive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  backdropTouchable: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    backgroundColor: '#F8FAFC',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15,23,42,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    zIndex: 10,
  },
  sheetTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 14,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
  },
  menuIcon: {
    fontSize: 18,
    width: 28,
    textAlign: 'center',
  },
  menuLabel: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '600',
  },
  menuLabelDestructive: {
    color: '#FCA5A5',
  },
  cancelBtn: {
    marginTop: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '700',
  },

  // rename
  input: {
    backgroundColor: '#FFFFFF',
    color: '#0F172A',
    fontSize: 15,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 14,
  },
  rowButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  footerBtn: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  footerBtnGhost: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  footerBtnGhostText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '700',
  },
  footerBtnPrimary: {
    backgroundColor: '#8B5CF6',
  },
  footerBtnPrimaryText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '800',
  },

  // move
  folderList: {
    maxHeight: 260,
    marginBottom: 14,
  },
  folderItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    marginBottom: 6,
  },
  folderItemActive: {
    borderWidth: 1,
    borderColor: '#8B5CF6',
  },
  folderIcon: {
    fontSize: 18,
    width: 22,
    textAlign: 'center',
  },
  folderName: {
    flex: 1,
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '600',
  },
  folderCheck: {
    color: '#A78BFA',
    fontSize: 16,
    fontWeight: '800',
  },
  createRow: {
    marginBottom: 12,
    gap: 8,
  },
  createInput: {
    backgroundColor: '#FFFFFF',
    color: '#0F172A',
    fontSize: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  createBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  createBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
});
