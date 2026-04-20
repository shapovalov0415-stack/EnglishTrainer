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
import { createFolder, listFolders, type FolderRow } from '../db/schema';

interface Props {
  visible: boolean;
  defaultTitle: string;
  /** タイトル・フォルダを受け取って保存 (または解析) を実行する。 */
  onConfirm: (title: string, folderId: number | null) => Promise<void> | void;
  /** キャンセル: 何も実行せずモーダルを閉じる。 */
  onCancel: () => void;
  /** 主ボタンのラベル。デフォルトは「保存して解析を開始」 */
  confirmLabel?: string;
  /** モーダル上部のタイトル文言。省略時は「レッスンを保存」 */
  title?: string;
  /** モーダル上部の説明文。省略時は汎用メッセージ。 */
  description?: string;
}

/**
 * 動画 / テキスト解析が完了した直後に表示するモーダル。
 * レッスン名とフォルダを選んで「保存して練習」できる。
 *
 * セッション行は本モーダルを開く前に既に INSERT されているため、
 * ユーザーがスキップしたりアプリを閉じたりしても、必ず「未分類」として
 * 履歴に残る。このモーダルは「必須の入力」ではなく「すぐ仕分ける導線」。
 */
export default function SaveSessionModal({
  visible,
  defaultTitle,
  onConfirm,
  onCancel,
  confirmLabel,
  title: headerTitle,
  description,
}: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderInputOpen, setNewFolderInputOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadFolders = useCallback(async () => {
    try {
      const rows = await listFolders();
      setFolders(rows);
    } catch (e) {
      console.warn('SaveSessionModal: listFolders failed', e);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      setTitle(defaultTitle);
      setSelectedFolderId(null);
      setNewFolderName('');
      setNewFolderInputOpen(false);
      loadFolders();
    }
  }, [visible, defaultTitle, loadFolders]);

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      Alert.alert('入力してください', 'フォルダー名を入力してください。');
      return;
    }
    setCreatingFolder(true);
    try {
      const newId = await createFolder(name);
      setNewFolderName('');
      setNewFolderInputOpen(false);
      await loadFolders();
      setSelectedFolderId(newId);
    } catch (e) {
      Alert.alert('エラー', e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleConfirm = async () => {
    const finalTitle = title.trim() || defaultTitle || '無題の練習';
    setBusy(true);
    try {
      await onConfirm(finalTitle, selectedFolderId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={busy ? undefined : onCancel}
        />
        <View style={styles.sheet}>
          <Text style={styles.title}>{headerTitle ?? 'レッスンを保存'}</Text>
          <Text style={styles.subtitle}>
            {description ?? '名前と保存先フォルダーを選んでください。\n後からでも変更できます。'}
          </Text>

          {/* Lesson name */}
          <Text style={styles.label}>レッスン名</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="例: カフェでの会話"
            placeholderTextColor="#94A3B8"
            maxLength={60}
          />

          {/* Folder picker */}
          <Text style={styles.label}>保存先フォルダー</Text>
          <ScrollView
            style={styles.folderList}
            contentContainerStyle={{ paddingVertical: 4 }}
          >
            <TouchableOpacity
              style={[
                styles.folderRow,
                selectedFolderId === null && styles.folderRowActive,
              ]}
              onPress={() => setSelectedFolderId(null)}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.radio,
                  selectedFolderId === null && styles.radioActive,
                ]}
              >
                {selectedFolderId === null && <View style={styles.radioDot} />}
              </View>
              <Text style={styles.folderName}>{'\u{1F4C2}'} 未分類</Text>
            </TouchableOpacity>
            {folders.map((f) => (
              <TouchableOpacity
                key={f.id}
                style={[
                  styles.folderRow,
                  selectedFolderId === f.id && styles.folderRowActive,
                ]}
                onPress={() => setSelectedFolderId(f.id)}
                activeOpacity={0.8}
              >
                <View
                  style={[
                    styles.radio,
                    selectedFolderId === f.id && styles.radioActive,
                  ]}
                >
                  {selectedFolderId === f.id && <View style={styles.radioDot} />}
                </View>
                <Text style={styles.folderName} numberOfLines={1}>
                  {'\u{1F4C1}'} {f.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Inline: new folder */}
          {newFolderInputOpen ? (
            <View style={styles.newFolderRow}>
              <TextInput
                style={[styles.input, styles.newFolderInput]}
                value={newFolderName}
                onChangeText={setNewFolderName}
                placeholder="新しいフォルダー名"
                placeholderTextColor="#94A3B8"
                autoFocus
                maxLength={50}
              />
              <TouchableOpacity
                style={styles.addBtn}
                onPress={handleCreateFolder}
                disabled={creatingFolder}
                activeOpacity={0.85}
              >
                {creatingFolder ? (
                  <ActivityIndicator size="small" color="#0F172A" />
                ) : (
                  <Text style={styles.addBtnText}>追加</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelInlineBtn}
                onPress={() => {
                  setNewFolderInputOpen(false);
                  setNewFolderName('');
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.cancelInlineBtnText}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.createFolderBtn}
              onPress={() => setNewFolderInputOpen(true)}
              activeOpacity={0.8}
            >
              <Text style={styles.createFolderBtnText}>
                {'\u002B'} 新しいフォルダーを作成
              </Text>
            </TouchableOpacity>
          )}

          {/* Actions */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, styles.btnGhost]}
              onPress={onCancel}
              disabled={busy}
              activeOpacity={0.7}
            >
              <Text style={styles.btnGhostText}>キャンセル</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={handleConfirm}
              disabled={busy}
              activeOpacity={0.85}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#0F172A" />
              ) : (
                <Text style={styles.btnPrimaryText}>
                  {confirmLabel ?? '保存して解析を開始'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    backgroundColor: '#F8FAFC',
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    maxHeight: '86%',
  },
  title: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 4,
  },
  subtitle: {
    color: '#64748B',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 16,
  },
  label: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
    marginTop: 4,
    letterSpacing: 0.5,
  },
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
  folderList: {
    maxHeight: 200,
    marginBottom: 6,
  },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 6,
    gap: 10,
  },
  folderRowActive: {
    borderColor: '#A78BFA',
    backgroundColor: '#EDE9FE',
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#94A3B8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioActive: {
    borderColor: '#A78BFA',
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#A78BFA',
  },
  folderName: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  newFolderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  newFolderInput: {
    flex: 1,
    marginBottom: 0,
  },
  addBtn: {
    backgroundColor: '#8B5CF6',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  addBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  cancelInlineBtn: {
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
  cancelInlineBtnText: {
    color: '#94A3B8',
    fontSize: 16,
    fontWeight: '700',
  },
  createFolderBtn: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderStyle: 'dashed',
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 14,
  },
  createFolderBtnText: {
    color: '#A78BFA',
    fontSize: 13,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  btn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnGhost: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  btnGhostText: {
    color: '#64748B',
    fontSize: 14,
    fontWeight: '700',
  },
  btnPrimary: {
    backgroundColor: '#8B5CF6',
  },
  btnPrimaryText: {
    color: '#0F172A',
    fontSize: 14,
    fontWeight: '800',
  },
});
