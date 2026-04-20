/** Whisper API から返る文字起こし結果 */
export interface TranscriptionResult {
  text: string;
  language: string;
  duration: number;
  segments: TranscriptionSegment[];
}

export interface TranscriptionSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** Claude が抽出する学習フレーズ */
export interface ExtractedPhrase {
  phrase: string;
  translation: string;
  context: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  notes: string;
}

/** Claude のフレーズ抽出レスポンス全体 */
export interface PhraseExtractionResult {
  summary: string;
  phrases: ExtractedPhrase[];
}

// ---------------------------------------------------------------------------
// Roleplay Chat
// ---------------------------------------------------------------------------

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  timestamp: number;
}

/** Roleplay 終了後のフィードバック */
export interface RoleplayFeedback {
  goodPoints: string[];
  improvements: string[];
  expressionsUsed: string[];
  overallComment: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Extension (Growth Analysis)
// ---------------------------------------------------------------------------

/** 成長ポイントの差分 */
export interface GrowthPoint {
  category: string;
  before: string;
  after: string;
  improved: boolean;
}

/** Extension のフィードバック（成長比較付き） */
export interface ExtensionFeedback {
  goodPoints: string[];
  improvements: string[];
  expressionsUsed: string[];
  overallComment: string;
  score: number;
  growthPoints: GrowthPoint[];
  growthSummary: string;
}

/** 過去の練習記録サマリー */
export interface PastPerformance {
  roleplayScore: number | null;
  roleplayFeedback: RoleplayFeedback | null;
  shadowingBestScore: number | null;
}
