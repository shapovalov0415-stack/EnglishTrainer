import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { signInWithGoogle, signOut } from '../lib/auth';
import {
  backupAll,
  getCurrentUser,
  getLastBackupAt,
  restoreAll,
} from '../utils/cloudSync';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** 復元でローカルデータが変わったとき、呼び出し元が一覧を更新するためのフック */
  onDataChanged?: () => void;
}

type Busy = 'idle' | 'signin' | 'backup' | 'restore' | 'signout';

export default function AccountModal({ visible, onClose, onDataChanged }: Props) {
  const [user, setUser] = useState<{ id: string; email: string | null } | null>(null);
  const [lastBackup, setLastBackup] = useState<Date | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');

  const refresh = useCallback(async () => {
    setUser(await getCurrentUser());
    setLastBackup(await getLastBackupAt());
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const handleSignIn = async () => {
    setBusy('signin');
    try {
      const { error } = await signInWithGoogle();
      if (error) throw error;
      await refresh();
      Alert.alert(
        'ログインしました',
        '「今すぐバックアップ」でこの端末の学習データをクラウドに保存できます。',
      );
    } catch (e) {
      Alert.alert('ログインに失敗しました', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  };

  const handleBackup = async () => {
    setBusy('backup');
    try {
      const r = await backupAll();
      await refresh();
      Alert.alert(
        'バックアップ完了',
        `フォルダー ${r.folders} 件・セッション ${r.sessions} 件を保存しました。\n音声 ${r.audiosUploaded} 件を新規アップロード。`,
      );
    } catch (e) {
      Alert.alert('バックアップに失敗しました', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  };

  const handleRestore = async () => {
    Alert.alert(
      'クラウドから復元',
      'クラウドにあってこの端末に無いセッションを復元します（既存データは変更されません）。よろしいですか？',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '復元する',
          onPress: async () => {
            setBusy('restore');
            try {
              const r = await restoreAll();
              onDataChanged?.();
              Alert.alert(
                '復元完了',
                r.sessions === 0 && r.folders === 0
                  ? '復元が必要なデータはありませんでした。'
                  : `フォルダー ${r.folders} 件・セッション ${r.sessions} 件を復元しました。`,
              );
            } catch (e) {
              Alert.alert('復元に失敗しました', e instanceof Error ? e.message : String(e));
            } finally {
              setBusy('idle');
            }
          },
        },
      ],
    );
  };

  const handleSignOut = async () => {
    setBusy('signout');
    try {
      await signOut();
      await refresh();
    } catch (e) {
      Alert.alert('ログアウトに失敗しました', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  };

  const busyLabel: Record<Busy, string> = {
    idle: '',
    signin: 'Google でログイン中...',
    backup: 'バックアップ中... (音声のアップロードに時間がかかることがあります)',
    restore: '復元中... (音声のダウンロードに時間がかかることがあります)',
    signout: 'ログアウト中...',
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>{'☁️'} クラウドバックアップ</Text>

          {busy !== 'idle' ? (
            <View style={styles.busyWrap}>
              <ActivityIndicator size="large" color="#7C3AED" />
              <Text style={styles.busyText}>{busyLabel[busy]}</Text>
            </View>
          ) : user ? (
            <>
              <Text style={styles.emailText}>{user.email ?? '(メール不明)'}</Text>
              <Text style={styles.metaText}>
                最終バックアップ:{' '}
                {lastBackup
                  ? lastBackup.toLocaleString('ja-JP', { hour12: false })
                  : 'まだありません'}
              </Text>
              <Text style={styles.hintText}>
                ログイン中は新しいセッション保存後に自動バックアップされます。
              </Text>

              <TouchableOpacity style={styles.primaryBtn} onPress={handleBackup}>
                <Text style={styles.primaryBtnText}>今すぐバックアップ</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondaryBtn} onPress={handleRestore}>
                <Text style={styles.secondaryBtnText}>クラウドから復元</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.ghostBtn} onPress={handleSignOut}>
                <Text style={styles.ghostBtnText}>ログアウト</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.hintText}>
                Google アカウントでログインすると、フォルダー・セッション・フレーズ・練習ログ・音声をクラウドに保存できます。機種変更やアプリの入れ直しでもデータを復元できます。
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={handleSignIn}>
                <Text style={styles.primaryBtnText}>Google でログイン</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity style={styles.closeBtn} onPress={onClose} disabled={busy !== 'idle'}>
            <Text style={styles.closeBtnText}>閉じる</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 12,
  },
  emailText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0F172A',
    marginBottom: 4,
  },
  metaText: {
    fontSize: 13,
    color: '#64748B',
    marginBottom: 8,
  },
  hintText: {
    fontSize: 13,
    color: '#475569',
    lineHeight: 19,
    marginBottom: 16,
  },
  busyWrap: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  busyText: {
    marginTop: 12,
    fontSize: 13,
    color: '#475569',
    textAlign: 'center',
  },
  primaryBtn: {
    backgroundColor: '#7C3AED',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryBtn: {
    backgroundColor: '#EDE9FE',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  secondaryBtnText: {
    color: '#6D28D9',
    fontSize: 15,
    fontWeight: '700',
  },
  ghostBtn: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  ghostBtnText: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
  },
  closeBtn: {
    marginTop: 6,
    paddingVertical: 10,
    alignItems: 'center',
  },
  closeBtnText: {
    color: '#475569',
    fontSize: 14,
    fontWeight: '600',
  },
});
