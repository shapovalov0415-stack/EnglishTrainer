// ---------------------------------------------------------------------------
// realtime — OpenAI Realtime API (音声リアルタイム会話) の WebRTC 接続マネージャ。
//
//   startRealtimeSession() は
//     1. サーバー /realtime/token でエフェメラルトークンを取得
//     2. マイクを取得して RTCPeerConnection に載せる
//     3. SDP offer を OpenAI に送って answer を受け取る（接続確立）
//     4. data channel 'oai-events' で会話イベントを送受信
//   を行い、接続を stop() できる controller を返す。
//
//   会話中の文字起こし（ユーザー / AI）はコールバックで受け取り、
//   会話終了後に既存の Claude フィードバック生成へ渡せるようにしておく。
// ---------------------------------------------------------------------------

import {
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
  type MediaStream,
} from 'react-native-webrtc';

const API_BASE_URL: string =
  (typeof process !== 'undefined' &&
    process.env &&
    process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'http://192.168.1.133:3000';

export type RealtimeStatus =
  | 'connecting'
  | 'connected'
  | 'listening'
  | 'speaking'
  | 'closed'
  | 'error';

export interface RealtimeTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface StartRealtimeOptions {
  /** 会話の役割・シナリオ・使わせたいフレーズ等（session instructions） */
  instructions: string;
  /** 出力音声（alloy / marin / cedar など）。既定は marin。 */
  voice?: string;
  /** 接続状態が変わるたびに呼ばれる */
  onStatus?: (status: RealtimeStatus) => void;
  /** ユーザー / AI の発話が文字起こしされるたびに呼ばれる */
  onTranscript?: (turn: RealtimeTurn) => void;
  /** 復帰不能なエラー時に呼ばれる */
  onError?: (message: string) => void;
}

export interface RealtimeController {
  /** 接続を切ってマイクを解放する */
  stop: () => Promise<void>;
  /** これまでの会話ターン（文字起こし）を新しい順ではなく発生順で返す */
  getTranscript: () => RealtimeTurn[];
}

async function mintToken(
  instructions: string,
  voice: string,
): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/realtime/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instructions, voice }),
  }).catch((e) => {
    throw new Error(
      `サーバーに接続できません (${API_BASE_URL}/realtime/token): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`トークン取得に失敗 (${res.status}): ${t}`);
  }
  const data = (await res.json()) as { token?: string; error?: string };
  if (!data.token) {
    throw new Error(`トークンが空です: ${data.error ?? ''}`);
  }
  return data.token;
}

export async function startRealtimeSession(
  options: StartRealtimeOptions,
): Promise<RealtimeController> {
  const { instructions, voice = 'marin', onStatus, onTranscript, onError } = options;

  onStatus?.('connecting');

  const transcript: RealtimeTurn[] = [];
  let stopped = false;
  let pc: RTCPeerConnection | null = null;
  let localStream: MediaStream | null = null;

  const token = await mintToken(instructions, voice);

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  // AI の音声トラックを受信 → react-native-webrtc が自動でスピーカー再生する。
  // ここでは受信を確認するだけ（明示ハンドラが無いと一部環境で再生されないため登録）。
  (pc as unknown as {
    addEventListener: (t: string, cb: (e: unknown) => void) => void;
  }).addEventListener('track', () => {
    /* 受信するだけで再生される。ここでは何もしない。 */
  });

  // マイクを取得して送信トラックに載せる
  try {
    localStream = (await mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })) as unknown as MediaStream;
  } catch (e) {
    onError?.('マイクを取得できませんでした。設定でマイク許可を確認してください。');
    try { pc.close(); } catch { /* ignore */ }
    throw e;
  }
  localStream.getTracks().forEach((track) => {
    pc!.addTrack(track, localStream!);
  });

  // 会話イベント用の data channel
  const dc = pc.createDataChannel('oai-events');

  dc.addEventListener('open', () => {
    if (stopped) return;
    onStatus?.('connected');
  });

  dc.addEventListener('message', (ev: { data: string }) => {
    if (stopped) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const type = String(msg.type ?? '');

    // ユーザー発話の文字起こし完了
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const text = String((msg.transcript as string) ?? '').trim();
      if (text) {
        const turn: RealtimeTurn = { role: 'user', text };
        transcript.push(turn);
        onTranscript?.(turn);
      }
      return;
    }

    // AI 応答の文字起こし完了（GA/preview で名前が異なるため両対応）
    if (
      type === 'response.output_audio_transcript.done' ||
      type === 'response.audio_transcript.done'
    ) {
      const text = String((msg.transcript as string) ?? '').trim();
      if (text) {
        const turn: RealtimeTurn = { role: 'assistant', text };
        transcript.push(turn);
        onTranscript?.(turn);
      }
      return;
    }

    // 発話の開始 / 終了で UI インジケータを切り替える
    if (type === 'input_audio_buffer.speech_started') {
      onStatus?.('listening');
      return;
    }
    if (type === 'response.created') {
      onStatus?.('speaking');
      return;
    }
    if (type === 'response.done') {
      onStatus?.('connected');
      return;
    }

    if (type === 'error') {
      const detail =
        (msg.error as { message?: string } | undefined)?.message ??
        JSON.stringify(msg.error ?? msg);
      onError?.(`Realtime エラー: ${detail}`);
      return;
    }
  });

  // SDP offer を作成して OpenAI に渡し、answer で接続を確立する
  const offer = await pc.createOffer({});
  await pc.setLocalDescription(offer);

  const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/sdp',
    },
  }).catch((e) => {
    throw new Error(
      `Realtime 接続に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    );
  });

  if (!sdpRes.ok) {
    const t = await sdpRes.text();
    try { pc.close(); } catch { /* ignore */ }
    throw new Error(`Realtime SDP 交換に失敗 (${sdpRes.status}): ${t}`);
  }

  const answerSdp = await sdpRes.text();
  await pc.setRemoteDescription(
    new RTCSessionDescription({ type: 'answer', sdp: answerSdp }),
  );

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      dc.close();
    } catch {
      /* ignore */
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }
    if (pc) {
      try { pc.close(); } catch { /* ignore */ }
    }
    onStatus?.('closed');
  };

  return {
    stop,
    getTranscript: () => [...transcript],
  };
}
