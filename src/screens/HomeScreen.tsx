import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  AppState,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type {
  RootStackParamList,
  RootTabParamList,
} from '../navigation/RootNavigator';
import {
  extractPhrases,
  submitAnalyzeFromUrlJob,
  submitAnalyzeFileJob,
  pollAnalyzeJob,
  deleteAnalyzeJob,
  type AnalyzeFromUrlResult,
  type AnalyzeJobState,
} from '../ai';
import {
  createSessionFolder,
  saveAudioToSession,
  saveSegments,
  saveScript,
  extractSessionFolderName,
  inspectSessionFolder,
} from '../utils/sessionStorage';
import {
  createSessionFromPhrases,
  updateSessionTitle,
} from '../db/schema';
import SaveSessionModal from '../components/SaveSessionModal';
import {
  addPendingJob,
  listPendingJobs,
  removePendingJob,
  updatePendingJob,
  type PendingJob,
} from '../utils/pendingJobsStorage';

type Props = CompositeScreenProps<
  BottomTabScreenProps<RootTabParamList, 'HomeTab'>,
  NativeStackScreenProps<RootStackParamList>
>;

type LoadingState =
  | 'idle'
  | 'extracting'
  | 'downloading'
  | 'analyzing'
  | 'uploading'
  | 'reading_screen'
  | 'transcribing';

const LOADING_LABELS: Record<LoadingState, string> = {
  idle: '',
  extracting: '抽出中...',
  downloading: 'サーバーがダウンロード中...',
  analyzing: '解析中（OCR + 音声抽出）...',
  uploading: 'アップロード中...',
  reading_screen: '画面テキスト読み取り中...',
  transcribing: '音声解析中...',
};

type SourceKind = 'video' | 'text';

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const noExt = last.replace(/\.[^.]+$/, '');
    const decoded = decodeURIComponent(noExt);
    return decoded.slice(0, 40) || u.hostname;
  } catch {
    return '動画レッスン';
  }
}

export default function HomeScreen({ navigation }: Props) {
  const [input, setInput] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<{ uri: string; name: string }[]>([]);
  const [loadingState, setLoadingState] = useState<LoadingState>('idle');
  // モーダル表示中のソース（動画 or テキスト）。null ならモーダル非表示。
  const [pendingSource, setPendingSource] = useState<SourceKind | null>(null);

  const isLoading = loadingState !== 'idle';

  // ---------------------------------------------------------------------------
  // 進行中ジョブ (URL フローの非同期解析) を UI 表示用に持つ
  //   activeJobs: jobId → { title, stage }
  //   activeJobIdsRef: poller が二重起動しないようにするガード
  // ---------------------------------------------------------------------------
  const [activeJobs, setActiveJobs] = useState<
    { jobId: string; title: string; stage: string }[]
  >([]);
  const activeJobIdsRef = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const upsertActiveJob = useCallback(
    (jobId: string, title: string, stage: string) => {
      setActiveJobs((prev) => {
        const without = prev.filter((j) => j.jobId !== jobId);
        return [...without, { jobId, title, stage }];
      });
    },
    [],
  );
  const dropActiveJob = useCallback((jobId: string) => {
    setActiveJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    activeJobIdsRef.current.delete(jobId);
  }, []);

  // ---------------------------------------------------------------------------
  // モーダルの既定値
  //   ファイルが 1 件 → ファイル名をタイトル候補に。
  //   ファイルが 複数件 → モーダルの title は使わず各ファイル名を採用するので、表示は代表値のみ。
  //   URL 指定時 → URL 末尾パスから推定。
  // ---------------------------------------------------------------------------
  const modalDefaultTitle =
    pendingSource === 'video'
      ? selectedFiles.length > 0
        ? selectedFiles[0].name.replace(/\.[^.]+$/, '')
        : deriveTitleFromUrl(videoUrl.trim())
      : pendingSource === 'text'
        ? (input.trim().split('\n')[0].slice(0, 40) ?? '')
        : '';

  // ---------------------------------------------------------------------------
  // DocumentPicker でローカル mp4 を複数選ぶ
  // ---------------------------------------------------------------------------
  const handlePickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['video/mp4', 'video/*', 'audio/*'],
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      const picked = result.assets.map((a) => ({ uri: a.uri, name: a.name }));
      setSelectedFiles(picked);
      // ファイルを選んだら URL 入力は無効化（どちらか一方が優先）
      setVideoUrl('');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'ファイル選択に失敗しました';
      Alert.alert('エラー', msg);
    }
  };

  // ---------------------------------------------------------------------------
  // 「動画を解析して練習開始」: まずモーダルを開いて、確定後に解析する
  //   ファイルが選ばれていればアップロードフロー、無ければ URL ダウンロードフロー
  // ---------------------------------------------------------------------------
  const openVideoSaveModal = () => {
    if (selectedFiles.length > 0) {
      setPendingSource('video');
      return;
    }
    const trimmed = videoUrl.trim();
    if (!trimmed) {
      Alert.alert(
        '動画を指定してください',
        'ファイルを選択するか、MP4 の URL を貼り付けてください。',
      );
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      Alert.alert(
        'URL の形式が正しくありません',
        'http:// または https:// で始まる URL を入力してください。',
      );
      return;
    }
    setPendingSource('video');
  };

  const openTextSaveModal = () => {
    if (!input.trim()) {
      Alert.alert('入力してください', 'テキストを入力してください。');
      return;
    }
    setPendingSource('text');
  };

  // ---------------------------------------------------------------------------
  // 完了したジョブの保存処理 (共通): audio/segments/script をセッションフォルダへ、
  // sessions 行を INSERT し、title / folderId を確定させる。
  // URL フローでも、fallback として手元ファイルフロー完了時の保存でも使える。
  // ---------------------------------------------------------------------------
  const persistAnalyzedResult = useCallback(
    async (
      result: AnalyzeFromUrlResult,
      meta: { title: string; folderId: number | null; folderLabel: string },
    ): Promise<{ sessionId?: number; sessionFolder?: string; saveErrors: string[] }> => {
      const saveErrors: string[] = [];
      let sessionFolder: string | undefined;
      try {
        const folderPath = await createSessionFolder(meta.folderLabel);
        if (folderPath) {
          const folderName = extractSessionFolderName(folderPath);
          sessionFolder = folderName || folderPath;
          if (result.audioBase64) {
            try {
              await saveAudioToSession(
                sessionFolder,
                result.audioBase64,
                result.audioExt ?? '.m4a',
              );
            } catch (e) {
              saveErrors.push(`audio.m4a (${e instanceof Error ? e.message : String(e)})`);
            }
          } else {
            saveErrors.push('audio.m4a (音声が返りませんでした)');
          }
          if (result.segments && result.segments.length > 0) {
            try {
              await saveSegments(sessionFolder, result.segments);
            } catch (e) {
              saveErrors.push(`segments.json (${e instanceof Error ? e.message : String(e)})`);
            }
          }
          if (result.scriptTurns && result.scriptTurns.length > 0) {
            try {
              await saveScript(sessionFolder, result.scriptTurns, result.speakers ?? []);
            } catch (e) {
              saveErrors.push(`script.json (${e instanceof Error ? e.message : String(e)})`);
            }
          }
          try {
            const inspect = await inspectSessionFolder(sessionFolder);
            if (!inspect.exists) saveErrors.push('セッションフォルダが見つかりません');
          } catch {
            /* ignore */
          }
        } else {
          saveErrors.push('セッションフォルダ作成に失敗');
        }
      } catch (e) {
        saveErrors.push(
          `フォルダ作成エラー: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const phrases = (result.phrases ?? []).map((p) => p.phrase).slice(0, 15);
      const phrasesWithTranslation = (result.phrases ?? [])
        .map((p) => ({ phrase: p.phrase, translation: p.translation }))
        .slice(0, 15);

      let sessionId: number | undefined;
      try {
        sessionId = await createSessionFromPhrases({
          phrases,
          phrasesWithTranslation,
          transcript: (result.screenTexts ?? []).join('\n') || result.transcript,
          summary: meta.title,
          folderPath: sessionFolder,
          language: result.language ?? 'en',
          duration: result.duration ?? 0,
          folderId: meta.folderId,
        });
        if (sessionId != null) {
          try {
            await updateSessionTitle(sessionId, meta.title);
          } catch (e) {
            console.warn('updateSessionTitle failed:', e);
          }
        }
      } catch (e) {
        console.warn('Failed to INSERT session from job:', e);
      }

      return { sessionId, sessionFolder, saveErrors };
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // ジョブポーラー
  //   1 つの jobId に対して完了まで poll し続ける。
  //   完了したら persistAnalyzedResult でフォルダ保存 & DB INSERT し、
  //   AsyncStorage からも削除 & サーバー側メモリも解放する。
  //   画面が生きていれば Alert で完了通知する。
  // ---------------------------------------------------------------------------
  const startPoller = useCallback(
    (job: PendingJob) => {
      if (activeJobIdsRef.current.has(job.jobId)) return; // 二重起動防止
      activeJobIdsRef.current.add(job.jobId);
      upsertActiveJob(job.jobId, job.title, job.stage ?? '待機中');

      const folderLabel = job.title || 'lesson';
      (async () => {
        try {
          const result = await pollAnalyzeJob(job.jobId, {
            intervalMs: 3000,
            onProgress: (s: AnalyzeJobState) => {
              if (isMountedRef.current) {
                upsertActiveJob(job.jobId, job.title, s.stage ?? s.status);
              }
              updatePendingJob(job.jobId, { stage: s.stage }).catch(() => {});
            },
          });
          // 完了 → 保存
          const { saveErrors } = await persistAnalyzedResult(result, {
            title: job.title,
            folderId: job.folderId,
            folderLabel,
          });
          await removePendingJob(job.jobId);
          await deleteAnalyzeJob(job.jobId);
          if (isMountedRef.current) {
            dropActiveJob(job.jobId);
            if (saveErrors.length > 0) {
              Alert.alert(
                `解析完了: ${job.title}`,
                [
                  '以下のデータ保存に失敗しました:',
                  ...saveErrors.map((s) => `- ${s}`),
                ].join('\n'),
              );
            } else {
              Alert.alert(
                '解析完了',
                `「${job.title}」が保存されました。フォルダータブから練習できます。`,
              );
            }
          }
        } catch (e) {
          console.warn(`[poller ${job.jobId}] failed:`, e);
          await removePendingJob(job.jobId);
          await deleteAnalyzeJob(job.jobId);
          if (isMountedRef.current) {
            dropActiveJob(job.jobId);
            Alert.alert(
              `解析エラー: ${job.title}`,
              e instanceof Error ? e.message : String(e),
            );
          }
        }
      })();
    },
    [persistAnalyzedResult, upsertActiveJob, dropActiveJob],
  );

  // 起動時 + フォアグラウンド復帰時に、保存されている pending jobs を復元して
  // poller を走らせる。サーバーが 30 分以内なら結果を掴みに行ける。
  useEffect(() => {
    const resume = async () => {
      try {
        const list = await listPendingJobs();
        for (const j of list) startPoller(j);
      } catch (e) {
        console.warn('resume pendingJobs failed:', e);
      }
    };
    resume();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') resume();
    });
    return () => sub.remove();
  }, [startPoller]);

  const handleCancelModal = () => {
    setPendingSource(null);
  };

  /**
   * モーダル確定後の中心処理。
   *   1. モーダルを閉じる（タイトル・フォルダが分かった）
   *   2. 実際の解析 (OCR + 音声抽出 + 文字起こし) を走らせる
   *   3. セッションフォルダへ audio.m4a / segments.json / script.json を保存
   *   4. sessions へ INSERT（ここで指定タイトル・フォルダで保存）
   *   5. Practice へ遷移
   */
  const handleConfirmModal = async (title: string, folderId: number | null) => {
    const source = pendingSource;
    setPendingSource(null);
    if (source === 'text') {
      await runTextFlow(title.trim(), folderId);
    } else if (source === 'video') {
      await runVideoFlow(title.trim(), folderId);
    }
  };

  // ---------------------------------------------------------------------------
  // テキスト入力フロー
  // ---------------------------------------------------------------------------
  const runTextFlow = async (title: string, folderId: number | null) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    setLoadingState('extracting');
    try {
      const phrases = await extractPhrases(trimmed);
      const finalTitle = title || trimmed.split('\n')[0].slice(0, 40) || 'テキスト練習';
      let sessionId: number | undefined;
      try {
        sessionId = await createSessionFromPhrases({
          phrases,
          transcript: trimmed,
          summary: finalTitle,
          folderId,
        });
        if (sessionId != null) {
          // createSessionFromPhrases は summary で title を設定しないので、別途セット。
          try {
            await updateSessionTitle(sessionId, finalTitle);
          } catch (e) {
            console.warn('updateSessionTitle (text) failed:', e);
          }
        }
      } catch (e) {
        console.warn('Failed to INSERT session from text:', e);
      }
      setInput('');
      navigation.navigate('Practice', {
        phrases,
        transcript: trimmed,
        ...(sessionId != null ? { sessionId } : {}),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'フレーズ抽出に失敗しました';
      Alert.alert('エラー', msg);
    } finally {
      setLoadingState('idle');
    }
  };

  // ---------------------------------------------------------------------------
  // 動画フロー: 全て非同期ジョブに統一。
  //   - URL  : submitAnalyzeFromUrlJob → poller 起動
  //   - ファイル: 各ファイルごとに submitAnalyzeFileJob → 個別 poller 起動
  //   HTTP アップロード自体はフォアグラウンドで完了する必要があるが、
  //   アップロード後の OCR/音声抽出/Whisper はサーバー側で続行するので、
  //   ユーザーはアップロード待機中以外はアプリを閉じても OK。
  // ---------------------------------------------------------------------------
  const runVideoFlow = async (title: string, folderId: number | null) => {
    const hasFiles = selectedFiles.length > 0;
    const urlTrimmed = videoUrl.trim();
    if (!hasFiles && !urlTrimmed) return;

    // ----- URL フロー -----
    if (!hasFiles) {
      const finalTitle = title || deriveTitleFromUrl(urlTrimmed);
      try {
        const jobId = await submitAnalyzeFromUrlJob(urlTrimmed);
        const pending: PendingJob = {
          jobId,
          url: urlTrimmed,
          title: finalTitle,
          folderId,
          submittedAt: Date.now(),
          stage: '待機中',
        };
        await addPendingJob(pending);
        startPoller(pending);
        setVideoUrl('');
        Alert.alert(
          '解析を開始しました',
          `「${finalTitle}」を処理中です。アプリを閉じても大丈夫です。\n完了するとフォルダータブに表示されます。`,
        );
      } catch (e: unknown) {
        Alert.alert(
          'エラー',
          e instanceof Error ? e.message : 'ジョブ投入に失敗しました',
        );
      }
      return;
    }

    // ----- ファイル アップロードフロー (複数) -----
    // 各ファイルを順番にアップロード→ジョブ化。アップロードは HTTP 接続が必要なので
    // ここだけは foreground で進める。アップロード完了したジョブはサーバー側で走る。
    setLoadingState('uploading');
    const submitted: { name: string; jobId?: string; error?: string }[] = [];
    const files = [...selectedFiles];
    const singleTitle = files.length === 1 ? title : undefined;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        // 複数選択時のタイトルは、各ファイル名から個別に生成する。
        // 1 件だけならユーザーがモーダルで指定したタイトルを優先。
        const perFileTitle =
          singleTitle && singleTitle.trim().length > 0
            ? singleTitle
            : f.name.replace(/\.[^.]+$/, '') || `動画レッスン (${i + 1})`;
        try {
          const jobId = await submitAnalyzeFileJob(f.uri, f.name);
          const pending: PendingJob = {
            jobId,
            url: `file:${f.name}`,
            title: perFileTitle,
            folderId,
            submittedAt: Date.now(),
            stage: 'アップロード完了・解析待機中',
          };
          await addPendingJob(pending);
          startPoller(pending);
          submitted.push({ name: f.name, jobId });
        } catch (e) {
          console.warn(`submitAnalyzeFileJob failed for ${f.name}:`, e);
          submitted.push({
            name: f.name,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } finally {
      setLoadingState('idle');
    }

    setSelectedFiles([]);

    const successCount = submitted.filter((s) => s.jobId).length;
    const errorCount = submitted.filter((s) => s.error).length;
    if (successCount > 0 && errorCount === 0) {
      Alert.alert(
        '解析を開始しました',
        `${successCount} 件のレッスンを処理中です。アプリを閉じても大丈夫です。\n完了するとフォルダータブに表示されます。`,
      );
    } else if (successCount > 0 && errorCount > 0) {
      Alert.alert(
        '一部のみ投入できました',
        [
          `成功: ${successCount} 件、失敗: ${errorCount} 件`,
          '',
          ...submitted.filter((s) => s.error).map((s) => `- ${s.name}: ${s.error}`),
        ].join('\n'),
      );
    } else {
      Alert.alert(
        'ジョブ投入に失敗しました',
        submitted.map((s) => `- ${s.name}: ${s.error ?? ''}`).join('\n'),
      );
    }
  };

  return (
    <>
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.logo}>English Trainer</Text>
          <Text style={styles.subtitle}>Iterative Learning Edition</Text>
        </View>

        {/* 進行中のジョブ (URL 解析バックグラウンド処理) */}
        {activeJobs.length > 0 && (
          <View style={styles.jobsBanner}>
            <View style={styles.jobsBannerHeader}>
              <ActivityIndicator size="small" color="#A78BFA" />
              <Text style={styles.jobsBannerTitle}>
                解析中: {activeJobs.length} 件
              </Text>
            </View>
            {activeJobs.map((j) => (
              <View key={j.jobId} style={styles.jobRow}>
                <Text style={styles.jobRowTitle} numberOfLines={1}>
                  {j.title}
                </Text>
                <Text style={styles.jobRowStage}>{j.stage}</Text>
              </View>
            ))}
            <Text style={styles.jobsBannerHint}>
              アプリを閉じても処理は続行されます。完了したら通知します。
            </Text>
          </View>
        )}

        {/* Video Card (ファイルアップロード or URL) */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>動画から学ぶ</Text>
          <Text style={styles.cardDescription}>
            端末内の MP4 を選ぶか、動画 URL を貼り付けてください。{'\n'}
            音声だけを抽出して端末に保存します。
          </Text>

          {/* ファイル選択 (複数選択可) */}
          <TouchableOpacity
            style={styles.filePickerButton}
            onPress={handlePickFile}
            disabled={isLoading}
            activeOpacity={0.7}
          >
            <Text style={styles.filePickerIcon}>{'\u{1F4C1}'}</Text>
            <Text style={styles.filePickerText} numberOfLines={1}>
              {selectedFiles.length === 0
                ? 'ファイルを選択（複数可）'
                : selectedFiles.length === 1
                  ? selectedFiles[0].name
                  : `${selectedFiles.length} 件選択中`}
            </Text>
            {selectedFiles.length > 0 && (
              <TouchableOpacity
                onPress={() => setSelectedFiles([])}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Text style={styles.filePickerClear}>{'\u2715'}</Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>

          {/* 複数選択時はファイル名リストを表示 */}
          {selectedFiles.length > 1 && (
            <View style={styles.fileList}>
              {selectedFiles.map((f, i) => (
                <View key={`${i}-${f.uri}`} style={styles.fileListRow}>
                  <Text style={styles.fileListIndex}>#{i + 1}</Text>
                  <Text style={styles.fileListName} numberOfLines={1}>
                    {f.name}
                  </Text>
                  <TouchableOpacity
                    onPress={() =>
                      setSelectedFiles((prev) => prev.filter((_, idx) => idx !== i))
                    }
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.fileListRemove}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* 区切り */}
          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>または</Text>
            <View style={styles.orLine} />
          </View>

          {/* URL 入力 */}
          <TextInput
            style={styles.input}
            placeholder="https://example.com/video.mp4"
            placeholderTextColor="#94A3B8"
            value={videoUrl}
            onChangeText={(v) => {
              setVideoUrl(v);
              if (v.trim() && selectedFiles.length > 0) setSelectedFiles([]);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!isLoading && selectedFiles.length === 0}
          />

          <TouchableOpacity
            style={[styles.button, styles.buttonVideo, isLoading && styles.buttonLoading]}
            onPress={openVideoSaveModal}
            disabled={isLoading || (selectedFiles.length === 0 && !videoUrl.trim())}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <View style={styles.buttonInner}>
                <ActivityIndicator size="small" color="#FFF" />
                <Text style={styles.buttonText}>{LOADING_LABELS[loadingState]}</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>動画を解析して練習開始</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Divider */}
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Text Input Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>テキストを入力</Text>
          <Text style={styles.cardDescription}>
            スクリプトのテキストを貼り付けて{'\n'}
            フレーズを抽出します。
          </Text>

          <TextInput
            style={styles.input}
            placeholder="English text..."
            placeholderTextColor="#94A3B8"
            value={input}
            onChangeText={setInput}
            multiline
            textAlignVertical="top"
            editable={!isLoading}
          />

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonLoading]}
            onPress={openTextSaveModal}
            disabled={isLoading || !input.trim()}
            activeOpacity={0.8}
          >
            {isLoading && loadingState === 'extracting' ? (
              <View style={styles.buttonInner}>
                <ActivityIndicator size="small" color="#FFF" />
                <Text style={styles.buttonText}>抽出中...</Text>
              </View>
            ) : (
              <Text style={styles.buttonText}>テキストから練習開始</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
    <SaveSessionModal
      visible={pendingSource != null}
      defaultTitle={modalDefaultTitle}
      onConfirm={handleConfirmModal}
      onCancel={handleCancelModal}
      title={
        pendingSource === 'video' && selectedFiles.length > 1
          ? `${selectedFiles.length} 件のレッスンを保存`
          : 'レッスンを保存'
      }
      description={
        pendingSource === 'video' && selectedFiles.length > 1
          ? `${selectedFiles.length} 件のファイルを一括で解析します。\n各レッスン名にはファイル名が使われます。保存先フォルダーだけ選んでください。`
          : pendingSource === 'video'
            ? 'アップロードして解析する前に、レッスン名と保存先フォルダーを決めてください。'
            : '解析する前に、レッスン名と保存先フォルダーを決めてください。'
      }
      confirmLabel={
        pendingSource === 'video'
          ? selectedFiles.length > 1
            ? `${selectedFiles.length} 件をアップロード・解析`
            : '保存してアップロード・解析'
          : '保存して解析を開始'
      }
    />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  jobsBanner: {
    backgroundColor: '#EDE9FE',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#6D28D9',
    padding: 14,
    marginBottom: 20,
    gap: 8,
  },
  jobsBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  jobsBannerTitle: {
    color: '#4C1D95',
    fontSize: 14,
    fontWeight: '800',
  },
  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  jobRowTitle: {
    color: '#0F172A',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  jobRowStage: {
    color: '#A78BFA',
    fontSize: 11,
    fontWeight: '700',
  },
  jobsBannerHint: {
    color: '#64748B',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 80,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logo: {
    fontSize: 32,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: '#60A5FA',
    marginTop: 4,
    fontWeight: '500',
  },
  card: {
    backgroundColor: '#F8FAFC',
    borderRadius: 20,
    padding: 24,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 8,
  },
  cardDescription: {
    fontSize: 14,
    color: '#64748B',
    lineHeight: 20,
    marginBottom: 20,
  },
  filePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderStyle: 'dashed',
    paddingHorizontal: 16,
    paddingVertical: 18,
    marginBottom: 16,
    gap: 10,
  },
  filePickerIcon: {
    fontSize: 20,
  },
  filePickerText: {
    color: '#64748B',
    fontSize: 15,
    flex: 1,
  },
  filePickerClear: {
    color: '#94A3B8',
    fontSize: 16,
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  fileList: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginBottom: 12,
    gap: 4,
  },
  fileListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    gap: 8,
  },
  fileListIndex: {
    color: '#60A5FA',
    fontSize: 11,
    fontWeight: '800',
    width: 24,
  },
  fileListName: {
    flex: 1,
    color: '#334155',
    fontSize: 13,
  },
  fileListRemove: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: 4,
  },
  orRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  orLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E2E8F0',
  },
  orText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
    marginHorizontal: 10,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    color: '#0F172A',
    fontSize: 15,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 100,
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#3B82F6',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonVideo: {
    backgroundColor: '#8B5CF6',
  },
  buttonLoading: {
    backgroundColor: '#E2E8F0',
  },
  buttonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    paddingHorizontal: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E2E8F0',
  },
  dividerText: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
    marginHorizontal: 16,
  },
});
