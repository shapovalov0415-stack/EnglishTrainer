// npm install 時 (postinstall) に yt-dlp の Linux バイナリを取得する。
// Render のダッシュボードに長い buildCommand を貼る必要をなくすための仕組み。
// ローカル開発 (macOS) ではスキップし、PATH 上の yt-dlp (brew install yt-dlp) を使う。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(__dirname, '..', 'yt-dlp');

if (process.platform !== 'linux') {
  console.log('[get-yt-dlp] non-linux platform, skipping (use brew/PATH locally)');
  process.exit(0);
}

if (fs.existsSync(dest)) {
  console.log('[get-yt-dlp] yt-dlp already present, skipping download');
  process.exit(0);
}

const URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
console.log(`[get-yt-dlp] downloading ${URL} ...`);

try {
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  fs.chmodSync(dest, 0o755);
  console.log(`[get-yt-dlp] saved ${(buf.length / 1024 / 1024).toFixed(1)} MB to ${dest}`);
} catch (e) {
  // ビルド全体は落とさない: yt-dlp が無くても直リンク mp4 の解析は動くため。
  console.warn('[get-yt-dlp] download failed (SNS URL 解析は使えません):', e?.message ?? e);
}
