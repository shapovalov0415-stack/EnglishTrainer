const API_BASE_URL: string =
  (typeof process !== 'undefined' &&
    process.env &&
    process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'http://192.168.1.133:3000';

/**
 * expo-av で録音した音声ファイルをサーバー経由で Whisper API に送り、
 * テキストに変換して返す。
 *
 * @param uri  ローカルの音声ファイルパス (file://...)
 * @returns    文字起こし結果のテキスト
 */
export async function transcribeAudio(uri: string): Promise<string> {
  const url = `${API_BASE_URL}/transcribe-file`;

  const formData = new FormData();
  formData.append('file', {
    uri,
    type: 'audio/m4a',
    name: 'recording.m4a',
  } as unknown as Blob);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      body: formData,
    });
  } catch (e) {
    throw new Error(
      `サーバーに接続できません (${url}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Whisper API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  return (data.text as string) ?? '';
}
