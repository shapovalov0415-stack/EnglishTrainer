/**
 * 2つの英文の類似度を 0〜100 のスコアで返す。
 * 単語レベルの一致率をベースに、語順ボーナスを加味する。
 */
export function calculateSimilarity(expected: string, actual: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const expectedNorm = normalize(expected);
  const actualNorm = normalize(actual);

  if (expectedNorm === actualNorm) return 100;
  if (!actualNorm) return 0;

  const expectedWords = expectedNorm.split(' ');
  const actualWords = actualNorm.split(' ');

  // 単語一致率
  const expectedSet = new Set(expectedWords);
  let matchCount = 0;
  for (const word of actualWords) {
    if (expectedSet.has(word)) {
      matchCount++;
    }
  }

  const wordScore =
    (matchCount / Math.max(expectedWords.length, actualWords.length)) * 100;

  // 語順ボーナス: LCS (最長共通部分列) の長さで加味
  const lcsLen = lcs(expectedWords, actualWords);
  const orderScore =
    (lcsLen / Math.max(expectedWords.length, actualWords.length)) * 100;

  // wordScore 70% + orderScore 30%
  const combined = wordScore * 0.7 + orderScore * 0.3;

  return Math.min(100, Math.round(combined));
}

/** 最長共通部分列の長さ */
function lcs(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  return dp[m][n];
}

/** スコアに応じた評価ラベルを返す */
export function getScoreLabel(score: number): {
  label: string;
  color: string;
} {
  if (score >= 90) return { label: 'Excellent!', color: '#22C55E' };
  if (score >= 70) return { label: 'Great!', color: '#60A5FA' };
  if (score >= 50) return { label: 'Good effort!', color: '#FBBF24' };
  return { label: 'Keep trying!', color: '#F87171' };
}
