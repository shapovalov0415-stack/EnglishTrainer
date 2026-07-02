import {
  GoogleSignin,
  statusCodes,
  isErrorWithCode,
  isSuccessResponse,
} from '@react-native-google-signin/google-signin';
import { supabase } from './supabase';

// Vocab アプリと同じ Google Cloud プロジェクトの Web Client ID を使う。
// Android のネイティブサインインには、Google Cloud Console 側に
// 「Android クライアント (package=com.englishtrainer.app + EAS keystore の SHA-1)」
// の登録が別途必要（コードには書かない）。
let configured = false;

function ensureConfigured() {
  if (configured) return;
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  if (!webClientId) {
    throw new Error(
      'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID が未設定です (.env / eas.json を確認)',
    );
  }
  GoogleSignin.configure({ webClientId });
  configured = true;
}

export async function signInWithGoogle() {
  ensureConfigured();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const response = await GoogleSignin.signIn();

  if (!isSuccessResponse(response)) {
    return { data: null, error: new Error('サインインがキャンセルされました') };
  }

  const idToken = response.data.idToken;
  if (!idToken) {
    return { data: null, error: new Error('Google から ID トークンが返りませんでした') };
  }

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: 'google',
    token: idToken,
  });

  return { data, error };
}

export async function signOut() {
  ensureConfigured();
  try {
    await GoogleSignin.signOut();
  } catch (e) {
    if (!isErrorWithCode(e) || e.code !== statusCodes.SIGN_IN_REQUIRED) {
      throw e;
    }
  }
  await supabase.auth.signOut();
}
