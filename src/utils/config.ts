import type { AIConfig } from './ai';

/**
 * アプリ全体の AI 設定を返す。
 * .env の値は app.config.ts の extra 経由か、
 * ビルド時に expo-constants で注入する想定。
 * 開発中は直接 .env から読む。
 */
export function getAIConfig(): AIConfig {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? '',
  };
}
