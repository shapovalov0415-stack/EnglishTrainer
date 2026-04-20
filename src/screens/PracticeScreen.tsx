import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Audio, type AVPlaybackStatus } from 'expo-av';
import * as Speech from 'expo-speech';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList, AudioSegment } from '../navigation/RootNavigator';
import { scorePronunciation, type ScoreResult } from '../ai';
import { transcribeAudio } from '../utils/transcribe';
import {
  createSessionFromPhrases,
  getPhrasesForSession,
  saveSessionPracticeState,
  setPhraseSaved,
  updatePhraseText,
  updatePhrasesOrder,
} from '../db/schema';
import { saveStep1Data, saveSegments, saveScript } from '../utils/sessionStorage';
import {
  DEFAULT_VOICE_SETTINGS,
  filterEnglishVoices,
  loadVoiceSettings,
  pickVoice,
  pitchForGender,
  saveVoiceSettings,
  type VoiceGender,
} from '../utils/voiceSettings';
import VoiceSettingsMenu from '../components/VoiceSettingsMenu';

type Props = NativeStackScreenProps<RootStackParamList, 'Practice'>;

type CardState = 'idle' | 'recording' | 'transcribing' | 'scoring' | 'done';

interface PhraseState {
  cardState: CardState;
  recordingDuration: number;
  spokenText: string | null;
  result: ScoreResult | null;
  isPlaying: boolean;
}

function initialPhraseState(): PhraseState {
  return {
    cardState: 'idle',
    recordingDuration: 0,
    spokenText: null,
    result: null,
    isPlaying: false,
  };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function findBestSegments(
  phrase: string,
  segments: AudioSegment[],
): { start: number; end: number } | null {
  if (segments.length === 0) return null;

  const normPhrase = normalize(phrase);
  const words = normPhrase.split(' ');
  if (words.length === 0) return null;

  let bestStart = 0;
  let bestEnd = 0;
  let bestScore = -1;

  for (let i = 0; i < segments.length; i++) {
    let combined = '';
    for (let j = i; j < Math.min(i + 5, segments.length); j++) {
      combined += (combined ? ' ' : '') + normalize(segments[j].text);

      let matchCount = 0;
      for (const w of words) {
        if (combined.includes(w)) matchCount++;
      }
      const score = matchCount / words.length;

      if (score > bestScore) {
        bestScore = score;
        bestStart = segments[i].start;
        bestEnd = segments[j].end;
      }

      if (score >= 1) break;
    }
  }

  if (bestScore < 0.3) return null;
  return { start: bestStart, end: bestEnd };
}

function stripParens(s: string): string {
  return s.replace(/[（(][^）)]*[）)]/g, '').trim();
}

export default function PracticeScreen({ route, navigation }: Props) {
  const {
    phrases: phrasesFromRoute,
    phrasesWithTranslation: phrasesWithTranslationFromRoute,
    transcript,
    fileUri,
    segments,
    scriptTurns,
    speakers: speakersFromRoute,
    sessionFolder,
    sessionId: sessionIdFromRoute,
    initialActivePhrases,
    initialSpeakerAssign,
    initialSelectedRole,
  } = route.params;

  // フレーズは編集可能（Step 1 で英文を書き換えられるようにする）。
  // route.params から初期化してローカル state で持ち、編集時に DB も UPDATE する。
  const [phrases, setPhrases] = useState<string[]>(phrasesFromRoute);
  const [phrasesWithTranslation, setPhrasesWithTranslation] = useState<
    { phrase: string; translation: string }[] | undefined
  >(phrasesWithTranslationFromRoute);
  // DB の phrases テーブル row id。インデックスが phrases[] と一致する。
  const [phraseIds, setPhraseIds] = useState<number[]>([]);
  // フレーズリスト保存フラグ（phrases と同じ index）。DB の phrases.is_saved を反映。
  const [savedFlags, setSavedFlags] = useState<boolean[]>([]);
  // インライン編集中のフレーズ index と、その下書きテキスト。
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<string>('');

  // 前画面から speakers が届かなかった（例: 再入場時に script.json の speakers が
  // 空だった）場合でも、scriptTurns 内の speaker から 2 名導出することで
  // Step 2 の役割選択 UI を維持する。これが無いと「話者の選択ボタンが消える」
  // バグの第 2 の原因になる。
  const speakers = useMemo<[string, string] | undefined>(() => {
    if (speakersFromRoute && speakersFromRoute.length >= 2) {
      return [speakersFromRoute[0], speakersFromRoute[1]] as [string, string];
    }
    if (scriptTurns && scriptTurns.length > 0) {
      const uniq: string[] = [];
      for (const t of scriptTurns) {
        if (t.speaker && !uniq.includes(t.speaker)) uniq.push(t.speaker);
        if (uniq.length >= 2) break;
      }
      if (uniq.length >= 2) return [uniq[0], uniq[1]] as [string, string];
    }
    return undefined;
  }, [speakersFromRoute, scriptTurns]);

  // fileUri さえあれば動画全体の再生はできる。segments はフレーズ単位の
  // シーク再生に必要なだけなので、両者を独立して扱う。
  // （SessionDetail 再入場時に segments.json だけ欠けていても、
  //   全体再生ボタンは動くようにする）
  const hasFullAudio = Boolean(fileUri);
  const hasPhraseSeek = Boolean(fileUri && segments && segments.length > 0);

  // マウント時に受け取ったパラメータの実態を明示的にログ出し。
  // 「お手本を聴く (TTS)」が表示されるのは hasPhraseSeek === false の時で、
  //   - fileUri が undefined
  //   - segments が undefined or length 0
  // のどちらかが原因。ここでターミナルに目立つ形で出す。
  useEffect(() => {
    console.log(
      '[PracticeScreen] mounted with route.params:',
      JSON.stringify(
        {
          fileUri: fileUri ?? null,
          segmentsCount: segments?.length ?? 0,
          segmentsSample: segments?.slice(0, 2) ?? null,
          transcriptLen: transcript?.length ?? 0,
          scriptTurnsCount: scriptTurns?.length ?? 0,
          speakers: speakers ?? null,
          sessionFolder: sessionFolder ?? null,
          hasFullAudio,
          hasPhraseSeek,
        },
        null,
        2,
      ),
    );
  }, [fileUri, segments, transcript, scriptTurns, speakers, sessionFolder, hasFullAudio, hasPhraseSeek]);

  const phraseTimings = useMemo(() => {
    if (!segments || segments.length === 0) return phrases.map(() => null);
    return phrases.map((p) => findBestSegments(p, segments));
  }, [phrases, segments]);

  const [states, setStates] = useState<PhraseState[]>(
    phrases.map(() => initialPhraseState()),
  );
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [isPlayingFull, setIsPlayingFull] = useState(false);

  // TTS 用: 端末のボイス + ユーザーの音声設定を AsyncStorage から復元
  const [englishVoices, setEnglishVoices] = useState<Speech.Voice[]>([]);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(DEFAULT_VOICE_SETTINGS.enabled);
  const [voiceGender, setVoiceGender] = useState<VoiceGender>(DEFAULT_VOICE_SETTINGS.gender);
  const [speechRate, setSpeechRate] = useState<number>(DEFAULT_VOICE_SETTINGS.rate);
  const voiceLoadedRef = useRef(false);
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
        console.warn('[Practice] voice settings load failed:', e);
      } finally {
        voiceLoadedRef.current = true;
      }
    })();
  }, []);
  useEffect(() => {
    if (!voiceLoadedRef.current) return;
    saveVoiceSettings({ enabled: voiceEnabled, gender: voiceGender, rate: speechRate });
  }, [voiceEnabled, voiceGender, speechRate]);
  const [sessionId, setSessionId] = useState<number | null>(
    sessionIdFromRoute ?? null,
  );
  const [selectedRole, setSelectedRole] = useState<number>(
    typeof initialSelectedRole === 'number' && Number.isFinite(initialSelectedRole)
      ? initialSelectedRole
      : 0,
  );
  const [speakerAssign, setSpeakerAssign] = useState<number[]>(() => {
    // 再入場時は前回保存された各フレーズの話者割当を初期値として復元する。
    // 要素数がフレーズ数と一致しなければ合わせる（不足は -1 で埋める）。
    if (initialSpeakerAssign && initialSpeakerAssign.length > 0) {
      return phrases.map((_, i) => {
        const v = initialSpeakerAssign[i];
        return typeof v === 'number' && Number.isFinite(v) ? v : -1;
      });
    }
    return phrases.map(() => -1);
  });
  const [removedIndices, setRemovedIndices] = useState<Set<number>>(() => {
    // activePhrases は「残っているフレーズの index 配列」。
    // 全フレーズの集合から activePhrases を引いた差分が removedIndices。
    if (initialActivePhrases) {
      const active = new Set(initialActivePhrases);
      const removed = new Set<number>();
      phrases.forEach((_, i) => {
        if (!active.has(i)) removed.add(i);
      });
      return removed;
    }
    return new Set();
  });

  const removePhrase = useCallback((idx: number) => {
    setRemovedIndices((prev) => new Set(prev).add(idx));
  }, []);

  /**
   * フレーズ並び替え: from と to の位置を swap する（一段ずつの移動前提）。
   * phrases / phrasesWithTranslation / speakerAssign / states / phraseIds の各
   * インデックス付与配列を同時に更新し、removedIndices (Set<number>) も
   * 位置ベースなので同時に remap する。編集中の phrase を動かしたら編集状態を解除。
   * 最後に updatePhrasesOrder で DB の order_index も書き戻す。
   */
  const movePhrase = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      const n = phrases.length;
      if (from < 0 || from >= n || to < 0 || to >= n) return;

      const swap = <T,>(arr: T[]): T[] => {
        const copy = arr.slice();
        [copy[from], copy[to]] = [copy[to], copy[from]];
        return copy;
      };

      const nextPhrases = swap(phrases);
      const nextPhrasesWithTranslation = phrasesWithTranslation
        ? swap(phrasesWithTranslation)
        : phrasesWithTranslation;
      const nextSpeakerAssign = swap(speakerAssign);
      const nextStates = swap(states);
      const nextPhraseIds = phraseIds.length === n ? swap(phraseIds) : phraseIds;
      const nextSavedFlags = savedFlags.length === n ? swap(savedFlags) : savedFlags;

      // removedIndices (位置ベース Set) を swap 後の位置にも合わせる
      const nextRemoved = new Set<number>();
      removedIndices.forEach((i) => {
        if (i === from) nextRemoved.add(to);
        else if (i === to) nextRemoved.add(from);
        else nextRemoved.add(i);
      });

      setPhrases(nextPhrases);
      if (nextPhrasesWithTranslation) setPhrasesWithTranslation(nextPhrasesWithTranslation);
      setSpeakerAssign(nextSpeakerAssign);
      setStates(nextStates);
      setPhraseIds(nextPhraseIds);
      setSavedFlags(nextSavedFlags);
      setRemovedIndices(nextRemoved);
      if (editingIndex === from) setEditingIndex(to);
      else if (editingIndex === to) setEditingIndex(from);

      // DB 書き戻し（phraseIds が揃っている時のみ）
      if (sessionId != null && nextPhraseIds.length === n) {
        updatePhrasesOrder(sessionId, nextPhraseIds).catch((e) =>
          console.warn('updatePhrasesOrder failed:', e),
        );
      }
    },
    [
      phrases,
      phrasesWithTranslation,
      speakerAssign,
      states,
      phraseIds,
      savedFlags,
      removedIndices,
      editingIndex,
      sessionId,
    ],
  );
  const movePhraseUp = useCallback(
    (idx: number) => movePhrase(idx, idx - 1),
    [movePhrase],
  );
  const movePhraseDown = useCallback(
    (idx: number) => movePhrase(idx, idx + 1),
    [movePhrase],
  );

  const hasSpeakers = speakers != null && speakers.length >= 2;

  const assignSpeaker = useCallback((phraseIdx: number, speakerIdx: number) => {
    setSpeakerAssign((prev) =>
      prev.map((v, i) => (i === phraseIdx ? (v === speakerIdx ? -1 : speakerIdx) : v)),
    );
  }, []);

  useEffect(() => {
    // SessionDetail から再入場したときは既存の sessionId が route 経由で渡ってくる。
    // その場合は新しい session 行を作らない。作ると毎回複製されてしまう上に、
    // カスタマイズ状態 (selected_speaker / active_phrases) の保存先が
    // 毎回新しい行へ逸れて「次回開いたときに復元できない」状態になる。
    if (sessionIdFromRoute != null) {
      setSessionId(sessionIdFromRoute);
      return;
    }
    createSessionFromPhrases(phrasesFromRoute, transcript, undefined, sessionFolder)
      .then(setSessionId)
      .catch(() => {});
  }, [phrasesFromRoute, transcript, sessionFolder, sessionIdFromRoute]);

  // sessionId が確定したら DB から phrase 行の id 一覧を引いてくる。
  // 編集時に UPDATE する対象レコードを特定するために必要。
  useEffect(() => {
    if (sessionId == null) return;
    let cancelled = false;
    getPhrasesForSession(sessionId)
      .then((rows) => {
        if (cancelled) return;
        setPhraseIds(rows.map((r) => r.id));
        setSavedFlags(rows.map((r) => r.is_saved === 1));
        // DB のフレーズが route の phrases より新しい内容を持っていれば
        // ローカル state を DB 側に寄せる（再入場時にも最新の編集済みテキストが表示される）。
        const dbPhrases = rows.map((r) => r.phrase);
        if (dbPhrases.length === phrases.length) {
          const diff = dbPhrases.some((p, i) => p !== phrases[i]);
          if (diff) {
            setPhrases(dbPhrases);
            setPhrasesWithTranslation((prev) =>
              prev
                ? prev.map((pt, i) => ({ ...pt, phrase: dbPhrases[i] ?? pt.phrase }))
                : rows.map((r) => ({ phrase: r.phrase, translation: r.translation })),
            );
          }
        }
      })
      .catch((e) => console.warn('getPhrasesForSession failed:', e));
    return () => {
      cancelled = true;
    };
    // phrases は依存に入れない: 編集のたびに再取得したくない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 編集開始/キャンセル/保存
  const startEditPhrase = useCallback(
    (idx: number) => {
      setEditingIndex(idx);
      setEditDraft(phrases[idx] ?? '');
    },
    [phrases],
  );
  const cancelEditPhrase = useCallback(() => {
    setEditingIndex(null);
    setEditDraft('');
  }, []);
  const commitEditPhrase = useCallback(async () => {
    const idx = editingIndex;
    if (idx == null) return;
    const trimmed = editDraft.trim();
    if (!trimmed) {
      Alert.alert('空のフレーズにはできません', '1 文字以上入力してください。');
      return;
    }
    // 変更がなければ閉じるだけ
    if (trimmed === phrases[idx]) {
      setEditingIndex(null);
      setEditDraft('');
      return;
    }
    // ローカル state を更新（UI 即反映）
    setPhrases((prev) => prev.map((p, i) => (i === idx ? trimmed : p)));
    setPhrasesWithTranslation((prev) =>
      prev ? prev.map((pt, i) => (i === idx ? { ...pt, phrase: trimmed } : pt)) : prev,
    );
    setEditingIndex(null);
    setEditDraft('');
    // DB にも書き戻す
    const phraseId = phraseIds[idx];
    if (phraseId != null) {
      try {
        await updatePhraseText(phraseId, trimmed);
      } catch (e) {
        console.warn('updatePhraseText failed:', e);
      }
    }
  }, [editingIndex, editDraft, phrases, phraseIds]);

  // フレーズを「フレーズリスト」に追加／解除する。
  // UI を即時反映してから DB に書き戻し、失敗時はロールバックする。
  const toggleSavedPhrase = useCallback(
    async (idx: number) => {
      const phraseId = phraseIds[idx];
      if (phraseId == null) {
        Alert.alert(
          '保存できません',
          'まだ DB への登録が完了していません。少し待ってから試してください。',
        );
        return;
      }
      const next = !(savedFlags[idx] ?? false);
      setSavedFlags((prev) => {
        const copy = [...prev];
        while (copy.length <= idx) copy.push(false);
        copy[idx] = next;
        return copy;
      });
      try {
        await setPhraseSaved(phraseId, next);
      } catch (e) {
        console.warn('setPhraseSaved failed:', e);
        setSavedFlags((prev) => {
          const copy = [...prev];
          copy[idx] = !next;
          return copy;
        });
        Alert.alert('エラー', e instanceof Error ? e.message : String(e));
      }
    },
    [phraseIds, savedFlags],
  );

  // --- Step 1 カスタマイズ状態の自動保存 ---
  // フレーズ削除 / 話者割当 / 役割選択 が変わるたびに DB へ反映する。
  // ユーザーが次ステップに進まず途中で抜けても、次回 SessionDetail から
  // Practice を開き直したときに前回の編集状態がそのまま戻るようにするため。
  // 連続変更での書き込み暴発を避けて 400ms デバウンスする。
  useEffect(() => {
    if (sessionId == null) return;
    const activePhrases: number[] = [];
    phrases.forEach((_, i) => {
      if (!removedIndices.has(i)) activePhrases.push(i);
    });
    const timer = setTimeout(() => {
      saveSessionPracticeState(sessionId, {
        selectedSpeaker: selectedRole,
        activePhrases,
        speakerAssign,
      }).catch((e) => {
        console.warn('saveSessionPracticeState failed:', e);
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [sessionId, phrases, removedIndices, speakerAssign, selectedRole]);

  // segments（単語タイムスタンプ）をセッションフォルダに永続化し、
  // 後日 SessionDetail → Practice で再入場したときにフレーズ単位のシーク再生が復元できるようにする。
  useEffect(() => {
    if (!sessionFolder || !segments || segments.length === 0) return;
    saveSegments(sessionFolder, segments).catch(() => {});
  }, [sessionFolder, segments]);

  // scriptTurns / speakers も永続化する。これがないと
  // SessionDetail → Practice → Roleplay の復元フローで
  // Roleplay 画面が「スクリプトが見つかりませんでした」になる。
  useEffect(() => {
    if (!sessionFolder) return;
    if (!scriptTurns || scriptTurns.length === 0) return;
    saveScript(sessionFolder, scriptTurns, speakers).catch(() => {});
  }, [sessionFolder, scriptTurns, speakers]);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
      if (playbackTimerRef.current) {
        clearTimeout(playbackTimerRef.current);
        playbackTimerRef.current = null;
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      // 録音中のまま遷移された場合に備えて必ず解放する。
      // これをやらないと次画面 (Roleplay) で
      // "Only one Recording object can be prepared at a given time" が発生する。
      if (recordingRef.current) {
        const rec = recordingRef.current;
        recordingRef.current = null;
        rec.stopAndUnloadAsync().catch(() => {});
      }
      // 録音モードを明示的にオフに戻しておく（expo-av の内部状態をリセット）。
      Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
    };
  }, []);

  const updateState = useCallback(
    (idx: number, patch: Partial<PhraseState>) => {
      setStates((prev) =>
        prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
      );
    },
    [],
  );

  // 次画面 (Roleplay) へ遷移する前に、このスクリーンが掴んでいる Audio オブジェクトを
  // すべて await で解放する。Native Stack Navigator は前画面をアンマウントせず
  // 保持し続けるため、unmount useEffect のクリーンアップは発火しない。
  // 解放を怠ると Roleplay 側で Audio.Recording.createAsync が
  // "Only one Recording object can be prepared at a given time" で失敗する。
  const cleanupAudioBeforeLeave = useCallback(async () => {
    try {
      await Speech.stop();
    } catch {
      /* ignore */
    }
    if (playbackTimerRef.current) {
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (soundRef.current) {
      try {
        await soundRef.current.stopAsync();
      } catch {
        /* ignore */
      }
      try {
        await soundRef.current.unloadAsync();
      } catch {
        /* ignore */
      }
      soundRef.current = null;
    }
    if (recordingRef.current) {
      const rec = recordingRef.current;
      recordingRef.current = null;
      try {
        await rec.stopAndUnloadAsync();
      } catch {
        /* ignore */
      }
    }
    try {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
    } catch {
      /* ignore */
    }
  }, []);

  // --- 停止ヘルパー ---
  const stopAllPlayback = useCallback(async () => {
    await Speech.stop();
    if (playbackTimerRef.current) {
      clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    if (soundRef.current) {
      await soundRef.current.stopAsync().catch(() => {});
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    setIsPlayingFull(false);
  }, []);

  // --- 全文再生（動画の最初から最後まで） ---
  const playFullAudio = useCallback(async () => {
    if (isPlayingFull) {
      await stopAllPlayback();
      return;
    }
    if (!fileUri) return;

    await stopAllPlayback();
    setIsPlayingFull(true);

    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      const { sound } = await Audio.Sound.createAsync(
        { uri: fileUri },
        { shouldPlay: true, positionMillis: 0 },
      );
      soundRef.current = sound;

      sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
        if ('didJustFinish' in status && status.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          soundRef.current = null;
          setIsPlayingFull(false);
        }
      });
    } catch (e) {
      setIsPlayingFull(false);
      Alert.alert('再生エラー', e instanceof Error ? e.message : '音声を再生できません');
    }
  }, [fileUri, isPlayingFull, stopAllPlayback]);

  // --- 元動画の音声をシーク再生 ---
  const playOriginalAudio = useCallback(
    async (idx: number) => {
      const timing = phraseTimings[idx];
      if (!fileUri || !timing) return;

      await stopAllPlayback();
      updateState(idx, { isPlaying: true });

      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
        });

        const { sound } = await Audio.Sound.createAsync(
          { uri: fileUri },
          {
            positionMillis: Math.floor(timing.start * 1000),
            shouldPlay: true,
          },
        );
        soundRef.current = sound;

        const durationMs = Math.ceil((timing.end - timing.start) * 1000) + 300;

        playbackTimerRef.current = setTimeout(async () => {
          await sound.stopAsync().catch(() => {});
          await sound.unloadAsync().catch(() => {});
          soundRef.current = null;
          updateState(idx, { isPlaying: false });
        }, durationMs);

        sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
          if ('didJustFinish' in status && status.didJustFinish) {
            if (playbackTimerRef.current) {
              clearTimeout(playbackTimerRef.current);
              playbackTimerRef.current = null;
            }
            sound.unloadAsync().catch(() => {});
            soundRef.current = null;
            updateState(idx, { isPlaying: false });
          }
        });
      } catch (e) {
        updateState(idx, { isPlaying: false });
        Alert.alert('再生エラー', e instanceof Error ? e.message : '音声を再生できません');
      }
    },
    [fileUri, phraseTimings, updateState],
  );

  // --- TTS フォールバック: ユーザー設定の gender / rate を使う ---
  const speakPhrase = useCallback(
    async (idx: number, text: string) => {
      await Speech.stop();
      if (!voiceEnabled) return;
      updateState(idx, { isPlaying: true });

      // フレーズに割り当てられた話者がいればその index の gender を、
      // そうでなければユーザー設定の gender をそのまま使う。
      const assigned = speakerAssign[idx];
      const gender: VoiceGender =
        assigned >= 0
          ? assigned === selectedRole
            ? voiceGender
            : voiceGender === 'female'
              ? 'male'
              : 'female'
          : voiceGender;
      const voice = pickVoice(englishVoices, gender);
      const pitch = pitchForGender(gender);
      console.warn(
        `[PracticeScreen] speakPhrase: gender=${gender} pitch=${pitch} voice=${voice?.identifier ?? 'default'} lang=${voice?.language ?? 'en-AU'}`,
      );

      // Speech.speak に voice identifier を渡すと端末によっては pitch が無視される。
      // pitch 優先のため、ここでは language だけ指定する。
      Speech.speak(text, {
        language: voice?.language ?? 'en-AU',
        rate: speechRate,
        pitch,
        onDone: () => updateState(idx, { isPlaying: false }),
        onStopped: () => updateState(idx, { isPlaying: false }),
        onError: () => updateState(idx, { isPlaying: false }),
      });
    },
    [updateState, voiceEnabled, speakerAssign, selectedRole, voiceGender, englishVoices, speechRate],
  );

  // --- 再生ハンドラ: 常に元音声を優先、なければ TTS ---
  const handleListen = useCallback(
    (idx: number, phrase: string) => {
      if (hasPhraseSeek && phraseTimings[idx]) {
        playOriginalAudio(idx);
      } else {
        speakPhrase(idx, phrase);
      }
    },
    [hasPhraseSeek, phraseTimings, playOriginalAudio, speakPhrase],
  );

  const startRecording = useCallback(
    async (idx: number) => {
      try {
        // 再生中のものをすべて停止
        await Speech.stop();
        if (soundRef.current) {
          await soundRef.current.stopAsync().catch(() => {});
          await soundRef.current.unloadAsync().catch(() => {});
          soundRef.current = null;
        }

        const { granted } = await Audio.requestPermissionsAsync();
        if (!granted) {
          Alert.alert('権限エラー', 'マイクの使用許可が必要です。');
          return;
        }

        if (recordingRef.current) {
          try {
            await recordingRef.current.stopAndUnloadAsync();
          } catch {
            /* already unloaded */
          }
          recordingRef.current = null;
        }

        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });

        const { recording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY,
        );
        recordingRef.current = recording;

        updateState(idx, {
          cardState: 'recording',
          recordingDuration: 0,
          spokenText: null,
          result: null,
        });

        timerRef.current = setInterval(() => {
          setStates((prev) =>
            prev.map((s, i) =>
              i === idx ? { ...s, recordingDuration: s.recordingDuration + 1 } : s,
            ),
          );
        }, 1000);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '録音を開始できません';
        Alert.alert('エラー', msg);
      }
    },
    [updateState],
  );

  const stopRecording = useCallback(
    async (idx: number) => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }

      if (!recordingRef.current) return;

      updateState(idx, { cardState: 'transcribing' });

      try {
        await recordingRef.current.stopAndUnloadAsync();
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

        const uri = recordingRef.current.getURI();
        recordingRef.current = null;

        if (!uri) {
          updateState(idx, { cardState: 'idle' });
          return;
        }

        const spoken = await transcribeAudio(uri);
        updateState(idx, { spokenText: spoken, cardState: 'scoring' });

        const result = await scorePronunciation(phrases[idx], spoken);
        updateState(idx, { result, cardState: 'done' });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '処理に失敗しました';
        Alert.alert('エラー', msg);
        updateState(idx, { cardState: 'idle' });
      }
    },
    [phrases, updateState],
  );

  const retry = useCallback(
    (idx: number) => {
      updateState(idx, initialPhraseState());
    },
    [updateState],
  );

  const scoreColor = (score: number) => {
    if (score >= 80) return '#22C55E';
    if (score >= 60) return '#60A5FA';
    if (score >= 40) return '#FBBF24';
    return '#F87171';
  };

  return (
    <>
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <Text style={styles.heading}>Practice Phrases</Text>
      <Text style={styles.subheading}>
        音声を聴いてから、録音ボタンで発話してください
      </Text>

      {/* --- Script (英語 + 日本語ペア表示) --- */}
      {phrasesWithTranslation && phrasesWithTranslation.length > 0 ? (
        <View style={styles.transcriptCard}>
          <View style={styles.transcriptHeader}>
            <Text style={styles.transcriptTitle}>Script</Text>
            <TouchableOpacity
              onPress={() => setTranscriptExpanded((v) => !v)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.transcriptToggle}>
                {transcriptExpanded ? '閉じる' : '全文を見る'}
              </Text>
            </TouchableOpacity>
          </View>

          {(transcriptExpanded
            ? phrasesWithTranslation
            : phrasesWithTranslation.slice(0, 3)
          ).map((p, i) => (
            <View key={i} style={styles.bilingualRow}>
              <Text style={styles.bilingualEn}>{p.phrase}</Text>
              <Text style={styles.bilingualJa}>{p.translation}</Text>
            </View>
          ))}

          {!transcriptExpanded && phrasesWithTranslation.length > 3 && (
            <Text style={styles.moreHint}>
              + {phrasesWithTranslation.length - 3} more...
            </Text>
          )}

          {hasFullAudio && (
            <TouchableOpacity
              style={[
                styles.fullPlayBtn,
                isPlayingFull && styles.fullPlayBtnActive,
              ]}
              onPress={playFullAudio}
              activeOpacity={0.7}
            >
              <Text style={styles.listenIcon}>
                {isPlayingFull ? '\u{23F9}' : '\u{25B6}\u{FE0F}'}
              </Text>
              <Text style={styles.fullPlayBtnText}>
                {isPlayingFull ? '停止' : '元の音声を聴く'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ) : transcript ? (
        <View style={styles.transcriptCard}>
          <View style={styles.transcriptHeader}>
            <Text style={styles.transcriptTitle}>Original Transcript</Text>
            <TouchableOpacity
              onPress={() => setTranscriptExpanded((v) => !v)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.transcriptToggle}>
                {transcriptExpanded ? '閉じる' : '全文を見る'}
              </Text>
            </TouchableOpacity>
          </View>
          <Text
            style={styles.transcriptText}
            numberOfLines={transcriptExpanded ? undefined : 4}
          >
            {transcript}
          </Text>
          {hasFullAudio && (
            <TouchableOpacity
              style={[
                styles.fullPlayBtn,
                isPlayingFull && styles.fullPlayBtnActive,
              ]}
              onPress={playFullAudio}
              activeOpacity={0.7}
            >
              <Text style={styles.listenIcon}>
                {isPlayingFull ? '\u{23F9}' : '\u{25B6}\u{FE0F}'}
              </Text>
              <Text style={styles.fullPlayBtnText}>
                {isPlayingFull ? '停止' : '元の音声を聴く'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ) : null}

      {/* --- Phrase Cards --- */}
      {phrases.map((phrase, idx) => {
        if (removedIndices.has(idx)) return null;
        const s = states[idx];
        const hasTiming = hasPhraseSeek && phraseTimings[idx] != null;
        const translation = phrasesWithTranslation?.[idx]?.translation;
        const assigned = speakerAssign[idx];
        const isPartner = assigned >= 0 && assigned !== selectedRole;
        // 削除済みをスキップした「次に表示されるフレーズ」の位置を求める
        let prevVisibleIdx = -1;
        for (let i = idx - 1; i >= 0; i--) {
          if (!removedIndices.has(i)) { prevVisibleIdx = i; break; }
        }
        let nextVisibleIdx = -1;
        for (let i = idx + 1; i < phrases.length; i++) {
          if (!removedIndices.has(i)) { nextVisibleIdx = i; break; }
        }
        const canMoveUp = prevVisibleIdx >= 0;
        const canMoveDown = nextVisibleIdx >= 0;
        return (
          <View key={idx} style={styles.card}>
            {/* Header: #番号 + 上下並び替え + 編集 + 削除 + 話者タグ */}
            <View style={styles.cardHeader}>
              <View style={styles.cardHeaderLeft}>
                <Text style={styles.phraseIndex}>#{idx + 1}</Text>
                <TouchableOpacity
                  onPress={() => canMoveUp && movePhrase(idx, prevVisibleIdx)}
                  disabled={!canMoveUp}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[styles.moveBtn, !canMoveUp && styles.moveBtnDisabled]}>
                    {'\u25B2'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => canMoveDown && movePhrase(idx, nextVisibleIdx)}
                  disabled={!canMoveDown}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={[styles.moveBtn, !canMoveDown && styles.moveBtnDisabled]}>
                    {'\u25BC'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    editingIndex === idx ? cancelEditPhrase() : startEditPhrase(idx)
                  }
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.editBtn}>
                    {editingIndex === idx ? '\u2715' : '\u270E'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => removePhrase(idx)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.removeBtn}>{'\u{1F5D1}'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => toggleSavedPhrase(idx)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={
                    savedFlags[idx] ? 'フレーズリストから外す' : 'フレーズリストに追加'
                  }
                >
                  <Text
                    style={[
                      styles.saveBtn,
                      savedFlags[idx] && styles.saveBtnActive,
                    ]}
                  >
                    {savedFlags[idx] ? '\u2605' : '\u2606'}
                  </Text>
                </TouchableOpacity>
              </View>
              {hasSpeakers && (
                <View style={styles.speakerTags}>
                  {speakers!.map((name, sIdx) => (
                    <TouchableOpacity
                      key={sIdx}
                      style={[
                        styles.speakerTag,
                        assigned === sIdx && (sIdx === selectedRole
                          ? styles.speakerTagMe
                          : styles.speakerTagPartner),
                      ]}
                      onPress={() => assignSpeaker(idx, sIdx)}
                      activeOpacity={0.7}
                    >
                      <Text style={[
                        styles.speakerTagText,
                        assigned === sIdx && styles.speakerTagTextActive,
                      ]}>
                        {stripParens(name)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
            {editingIndex === idx ? (
              <View style={styles.editRow}>
                <TextInput
                  style={styles.editInput}
                  value={editDraft}
                  onChangeText={setEditDraft}
                  multiline
                  autoFocus
                  placeholder="英語の文章を入力"
                  placeholderTextColor="#94A3B8"
                />
                <View style={styles.editActions}>
                  <TouchableOpacity
                    style={[styles.editActionBtn, styles.editCancelBtn]}
                    onPress={cancelEditPhrase}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.editCancelBtnText}>キャンセル</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.editActionBtn, styles.editSaveBtn]}
                    onPress={commitEditPhrase}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.editSaveBtnText}>保存</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              // 英文テキスト自体をタップしても編集モードに入れるようにする
              <TouchableOpacity
                onPress={() => startEditPhrase(idx)}
                activeOpacity={0.6}
              >
                <Text style={styles.phraseText}>{phrase}</Text>
                {translation ? (
                  <Text style={styles.phraseTranslation}>{translation}</Text>
                ) : null}
                <Text style={styles.phraseTapHint}>タップで編集</Text>
              </TouchableOpacity>
            )}

            {/* 再生ボタン */}
            <TouchableOpacity
              style={[
                styles.listenBtn,
                hasTiming && styles.listenBtnOriginal,
                s.isPlaying && styles.listenBtnActive,
              ]}
              onPress={() => handleListen(idx, phrase)}
              activeOpacity={0.7}
            >
              <Text style={styles.listenIcon}>
                {s.isPlaying ? '\u{1F50A}' : '\u{1F3A7}'}
              </Text>
              <Text style={[styles.listenBtnText, hasTiming && styles.listenBtnTextOriginal]}>
                {s.isPlaying
                  ? '再生中...'
                  : hasTiming
                    ? '元の音声を聴く'
                    : 'お手本を聴く (TTS)'}
              </Text>
            </TouchableOpacity>

            {/* === idle === */}
            {s.cardState === 'idle' && (
              <TouchableOpacity
                style={styles.recordBtn}
                onPress={() => startRecording(idx)}
                activeOpacity={0.7}
              >
                <View style={styles.recordDot} />
                <Text style={styles.recordBtnText}>録音開始</Text>
              </TouchableOpacity>
            )}

            {/* === recording === */}
            {s.cardState === 'recording' && (
              <View style={styles.recordingArea}>
                <Text style={styles.timer}>{s.recordingDuration}s</Text>
                <TouchableOpacity
                  style={styles.stopBtn}
                  onPress={() => stopRecording(idx)}
                  activeOpacity={0.7}
                >
                  <View style={styles.stopSquare} />
                  <Text style={styles.stopBtnText}>録音停止</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* === transcribing === */}
            {s.cardState === 'transcribing' && (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color="#60A5FA" />
                <Text style={styles.loadingText}>文字起こし中...</Text>
              </View>
            )}

            {/* === scoring === */}
            {s.cardState === 'scoring' && (
              <View>
                <View style={styles.spokenBox}>
                  <Text style={styles.spokenLabel}>あなたの発話:</Text>
                  <Text style={styles.spokenText}>{s.spokenText}</Text>
                </View>
                <View style={styles.loadingRow}>
                  <ActivityIndicator size="small" color="#A78BFA" />
                  <Text style={styles.loadingText}>採点中...</Text>
                </View>
              </View>
            )}

            {/* === done === */}
            {s.cardState === 'done' && s.result && (
              <View>
                <View style={styles.spokenBox}>
                  <Text style={styles.spokenLabel}>あなたの発話:</Text>
                  <Text style={styles.spokenText}>{s.spokenText}</Text>
                </View>

                <View style={styles.scoreRow}>
                  <View
                    style={[
                      styles.scoreBadge,
                      { backgroundColor: scoreColor(s.result.score) + '22' },
                    ]}
                  >
                    <Text
                      style={[
                        styles.scoreNumber,
                        { color: scoreColor(s.result.score) },
                      ]}
                    >
                      {s.result.score}
                    </Text>
                    <Text style={styles.scoreUnit}>/ 100</Text>
                  </View>
                </View>

                <View style={styles.feedbackBox}>
                  <Text style={styles.feedbackText}>{s.result.feedback}</Text>
                </View>

                <TouchableOpacity
                  style={styles.retryBtn}
                  onPress={() => retry(idx)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.retryBtnText}>もう一度 Try</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      })}

      {/* Step 2 への遷移セクション */}
      {sessionId != null && scriptTurns && scriptTurns.length > 0 && speakers && (
        <View style={styles.step2Section}>
          <Text style={styles.step2Title}>Step 2: Roleplay</Text>
          <Text style={styles.step2Desc}>あなたの役割を選んでください</Text>

          <View style={styles.rolePicker}>
            {speakers.map((name, idx) => (
              <TouchableOpacity
                key={idx}
                style={[
                  styles.roleOption,
                  selectedRole === idx && styles.roleOptionActive,
                ]}
                onPress={() => setSelectedRole(idx)}
                activeOpacity={0.7}
              >
                <View style={[
                  styles.roleRadio,
                  selectedRole === idx && styles.roleRadioActive,
                ]}>
                  {selectedRole === idx && <View style={styles.roleRadioDot} />}
                </View>
                <Text style={[
                  styles.roleOptionText,
                  selectedRole === idx && styles.roleOptionTextActive,
                ]}>
                  {stripParens(name)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={styles.nextStepBtn}
            onPress={async () => {
              if (sessionFolder) {
                try {
                  const scores = phrases
                    .map((phrase, i) => {
                      const s = states[i];
                      if (removedIndices.has(i) || !s.result) return null;
                      return {
                        phrase,
                        score: s.result.score,
                        feedback: s.result.feedback,
                        spokenText: s.spokenText ?? '',
                      };
                    })
                    .filter((x): x is NonNullable<typeof x> => x != null);
                  await saveStep1Data(sessionFolder, {
                    phrases,
                    phrasesWithTranslation,
                    transcript,
                    scores,
                    completedAt: new Date().toISOString(),
                  });
                } catch (e) {
                  console.warn('Failed to save step1 data:', e);
                }
              }
              const assignedTurns = phrases
                .map((p, i) => ({ p, i }))
                .filter(({ i }) => !removedIndices.has(i))
                .map(({ p, i }) => ({
                  speaker: speakerAssign[i] >= 0 ? speakers![speakerAssign[i]] : speakers![selectedRole],
                  text: p,
                }));
              await cleanupAudioBeforeLeave();
              navigation.navigate('Roleplay', {
                sessionId,
                scriptTurns: assignedTurns,
                speakers,
                myRoleIndex: selectedRole,
                fileUri,
                segments,
                sessionFolder,
              });
            }}
            activeOpacity={0.8}
          >
            <Text style={styles.nextStepBtnText}>
              {stripParens(speakers[selectedRole])} として会話を始める
            </Text>
            <Text style={styles.nextStepArrow}>{'\u2192'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* scriptTurns がない場合のフォールバック */}
      {sessionId != null && (!scriptTurns || scriptTurns.length === 0 || !speakers) && (
        <TouchableOpacity
          style={styles.nextStepBtn}
          onPress={async () => {
            if (sessionFolder) {
              try {
                const scores = phrases
                  .map((phrase, i) => {
                    const s = states[i];
                    if (removedIndices.has(i) || !s.result) return null;
                    return {
                      phrase,
                      score: s.result.score,
                      feedback: s.result.feedback,
                      spokenText: s.spokenText ?? '',
                    };
                  })
                  .filter((x): x is NonNullable<typeof x> => x != null);
                await saveStep1Data(sessionFolder, {
                  phrases,
                  phrasesWithTranslation,
                  transcript,
                  scores,
                  completedAt: new Date().toISOString(),
                });
              } catch (e) {
                console.warn('Failed to save step1 data:', e);
              }
            }
            await cleanupAudioBeforeLeave();
            // scriptTurns があれば必ず渡す（speakers が欠けていても Roleplay は
            // scriptTurns 内の speaker 名を使って動作する）。fileUri / segments も
            // 可能な限り引き継ぐ。
            navigation.navigate('Roleplay', {
              sessionId,
              scriptTurns: scriptTurns && scriptTurns.length > 0 ? scriptTurns : undefined,
              speakers,
              myRoleIndex: 0,
              fileUri,
              segments,
              sessionFolder,
            });
          }
          }
          activeOpacity={0.8}
        >
          <Text style={styles.nextStepBtnText}>Step 2: Roleplay へ</Text>
          <Text style={styles.nextStepArrow}>{'\u2192'}</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
    {/* 右上に音声設定 (男性/女性・速度・ON/OFF) の歯車アイコン */}
    <VoiceSettingsMenu
      enabled={voiceEnabled}
      onToggleEnabled={setVoiceEnabled}
      rate={speechRate}
      onChangeRate={setSpeechRate}
      gender={voiceGender}
      onChangeGender={setVoiceGender}
      top={12}
      right={12}
    />
    </>
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
  content: {
    padding: 20,
    paddingBottom: 60,
  },
  heading: {
    color: '#0F172A',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 4,
  },
  subheading: {
    color: '#64748B',
    fontSize: 14,
    marginBottom: 24,
  },

  // Transcript
  transcriptCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderLeftWidth: 3,
    borderLeftColor: '#8B5CF6',
  },
  transcriptHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  transcriptTitle: {
    color: '#A78BFA',
    fontSize: 14,
    fontWeight: '700',
  },
  transcriptToggle: {
    color: '#60A5FA',
    fontSize: 13,
    fontWeight: '600',
  },
  transcriptText: {
    color: '#334155',
    fontSize: 14,
    lineHeight: 22,
  },
  bilingualRow: {
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  bilingualEn: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 22,
    marginBottom: 4,
  },
  bilingualJa: {
    color: '#64748B',
    fontSize: 13,
    lineHeight: 20,
  },
  moreHint: {
    color: '#60A5FA',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
  },
  fullPlayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DCFCE7',
    borderRadius: 10,
    paddingVertical: 10,
    marginTop: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: '#22C55E44',
  },
  fullPlayBtnActive: {
    backgroundColor: '#DC2626',
    borderColor: '#DC262644',
  },
  fullPlayBtnText: {
    color: '#166534',
    fontSize: 14,
    fontWeight: '600',
  },

  // Card
  card: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  phraseIndex: {
    color: '#60A5FA',
    fontSize: 12,
    fontWeight: '700',
  },
  removeBtn: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '600',
  },
  saveBtn: {
    color: '#CBD5E1',
    fontSize: 18,
    fontWeight: '700',
  },
  saveBtnActive: {
    color: '#F59E0B',
  },
  editBtn: {
    color: '#60A5FA',
    fontSize: 14,
    fontWeight: '700',
  },
  moveBtn: {
    color: '#7C3AED',
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: 2,
  },
  moveBtnDisabled: {
    color: '#CBD5E1',
  },
  editRow: {
    marginBottom: 10,
  },
  editInput: {
    backgroundColor: '#FFFFFF',
    color: '#0F172A',
    fontSize: 16,
    lineHeight: 24,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#60A5FA',
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  editActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
  },
  editActionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  editCancelBtn: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  editCancelBtnText: {
    color: '#64748B',
    fontSize: 13,
    fontWeight: '700',
  },
  editSaveBtn: {
    backgroundColor: '#3B82F6',
  },
  editSaveBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  speakerTags: {
    flexDirection: 'row',
    gap: 6,
  },
  speakerTag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  speakerTagMe: {
    backgroundColor: '#EDE9FE',
    borderColor: '#A78BFA66',
  },
  speakerTagPartner: {
    backgroundColor: '#DCFCE7',
    borderColor: '#22C55E66',
  },
  speakerTagText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
  },
  speakerTagTextActive: {
    color: '#0F172A',
  },
  phraseText: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 26,
    marginBottom: 4,
  },
  phraseTranslation: {
    color: '#64748B',
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 4,
  },
  phraseTapHint: {
    color: '#94A3B8',
    fontSize: 11,
    fontStyle: 'italic',
    marginBottom: 10,
  },

  // Listen button
  listenBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DBEAFE',
    borderRadius: 12,
    paddingVertical: 12,
    marginBottom: 10,
    gap: 8,
  },
  listenBtnOriginal: {
    backgroundColor: '#DCFCE7',
    borderWidth: 1,
    borderColor: '#22C55E44',
  },
  listenBtnPartnerAU: {
    backgroundColor: '#DCFCE7',
    borderWidth: 1,
    borderColor: '#F59E0B44',
  },
  listenBtnActive: {
    backgroundColor: '#2563EB',
  },
  listenIcon: {
    fontSize: 18,
  },
  listenBtnText: {
    color: '#1E40AF',
    fontSize: 14,
    fontWeight: '600',
  },
  listenBtnTextOriginal: {
    color: '#166534',
  },
  listenBtnTextPartner: {
    color: '#92400E',
  },

  // Record button
  recordBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DC2626',
    borderRadius: 12,
    paddingVertical: 14,
  },
  recordDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FFF',
    marginRight: 8,
  },
  recordBtnText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
  },

  // Recording
  recordingArea: {
    alignItems: 'center',
  },
  timer: {
    color: '#F87171',
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 12,
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FEE2E2',
    borderRadius: 12,
    paddingVertical: 14,
    width: '100%',
  },
  stopSquare: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: '#FFF',
    marginRight: 8,
  },
  stopBtnText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
  },

  // Loading
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  loadingText: {
    color: '#64748B',
    fontSize: 14,
  },

  // Spoken text
  spokenBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  spokenLabel: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  spokenText: {
    color: '#E2E8F0',
    fontSize: 14,
    lineHeight: 20,
  },

  // Score
  scoreRow: {
    alignItems: 'center',
    marginBottom: 12,
  },
  scoreBadge: {
    flexDirection: 'row',
    alignItems: 'baseline',
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
    gap: 4,
  },
  scoreNumber: {
    fontSize: 32,
    fontWeight: '800',
  },
  scoreUnit: {
    color: '#94A3B8',
    fontSize: 14,
  },

  // Feedback
  feedbackBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  feedbackText: {
    color: '#334155',
    fontSize: 14,
    lineHeight: 20,
  },

  // Retry
  retryBtn: {
    backgroundColor: '#E2E8F0',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  retryBtnText: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '600',
  },

  // Step 2 section
  step2Section: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 20,
    marginTop: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#A78BFA',
  },
  step2Title: {
    color: '#0F172A',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  step2Desc: {
    color: '#64748B',
    fontSize: 13,
    marginBottom: 16,
  },
  rolePicker: {
    gap: 10,
    marginBottom: 16,
  },
  roleOption: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 12,
  },
  roleOptionActive: {
    borderColor: '#A78BFA',
    backgroundColor: '#EDE9FE',
  },
  roleRadio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#94A3B8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  roleRadioActive: {
    borderColor: '#A78BFA',
  },
  roleRadioDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#A78BFA',
  },
  roleOptionText: {
    color: '#64748B',
    fontSize: 15,
    fontWeight: '600',
  },
  roleOptionTextActive: {
    color: '#0F172A',
  },

  // Next step
  nextStepBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#A78BFA',
    borderRadius: 16,
    paddingVertical: 18,
    marginTop: 4,
    gap: 10,
  },
  nextStepBtnText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  nextStepArrow: {
    color: '#FFF',
    fontSize: 20,
    fontWeight: '700',
  },
});
