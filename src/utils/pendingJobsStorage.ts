// ---------------------------------------------------------------------------
// pendingJobsStorage
//   投入したが未完了のジョブを AsyncStorage に保存して、
//   アプリ再起動 / バックグラウンド復帰後に resume できるようにする。
//
//   各 PendingJob には、完了時に保存先フォルダとタイトルを決めるために必要な
//   メタデータ (ユーザーが選んだ title / folderId) も含める。
// ---------------------------------------------------------------------------

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'englishTrainer.pendingJobs.v1';

export interface PendingJob {
  jobId: string;
  url: string;
  title: string;
  folderId: number | null;
  submittedAt: number;
  /** UI 表示用の進行中ラベル（サーバーから返った最新の stage）。任意。 */
  stage?: string;
}

async function readAll(): Promise<PendingJob[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((j): j is PendingJob =>
      typeof j === 'object' &&
      j !== null &&
      typeof j.jobId === 'string' &&
      typeof j.url === 'string' &&
      typeof j.title === 'string' &&
      (typeof j.folderId === 'number' || j.folderId === null) &&
      typeof j.submittedAt === 'number',
    );
  } catch (e) {
    console.warn('pendingJobsStorage.readAll failed:', e);
    return [];
  }
}

async function writeAll(jobs: PendingJob[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
  } catch (e) {
    console.warn('pendingJobsStorage.writeAll failed:', e);
  }
}

export async function listPendingJobs(): Promise<PendingJob[]> {
  return readAll();
}

export async function addPendingJob(job: PendingJob): Promise<void> {
  const all = await readAll();
  // 重複排除（同じ jobId は上書き）
  const filtered = all.filter((j) => j.jobId !== job.jobId);
  filtered.push(job);
  await writeAll(filtered);
}

export async function updatePendingJob(
  jobId: string,
  patch: Partial<PendingJob>,
): Promise<void> {
  const all = await readAll();
  const next = all.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j));
  await writeAll(next);
}

export async function removePendingJob(jobId: string): Promise<void> {
  const all = await readAll();
  const next = all.filter((j) => j.jobId !== jobId);
  await writeAll(next);
}

export async function clearAllPendingJobs(): Promise<void> {
  await writeAll([]);
}
