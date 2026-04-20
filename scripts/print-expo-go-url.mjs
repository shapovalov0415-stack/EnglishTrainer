#!/usr/bin/env node
/**
 * Metro の manifest から Expo Go 用の exp:// を表示する。
 * トンネルは :80 / :443 の両方を試せるように出す（Android で片方しか通らないことがある）。
 */
import os from 'node:os';

const port = process.env.EXPO_METRO_PORT || process.env.RCT_METRO_PORT || 8081;
const metroUrl = `http://127.0.0.1:${port}/`;

function getLanIPv4() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
  } catch {
    /* サンドボックス等で networkInterfaces が失敗することがある */
  }
  return null;
}

async function main() {
  let res;
  try {
    res = await fetch(metroUrl);
  } catch {
    console.error(
      'Metro に接続できません。先に `npx expo start` を動かしてください。',
    );
    process.exit(1);
  }
  if (!res.ok) {
    console.error('Metro から応答がありません (HTTP', res.status, ')');
    process.exit(1);
  }
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    console.error('予期しない応答です。ポート', port, 'で Metro が動いているか確認。');
    process.exit(1);
  }

  const dh = j.expoGo?.debuggerHost;
  const hostUri = j.extra?.expoClient?.hostUri;
  const host = dh || hostUri;

  if (!host) {
    console.error('manifest に接続情報がありません。');
    process.exit(1);
  }

  console.log('');
  console.log('【Expo Go に「順に」試す URL】');
  console.log('（1つ開けたら OK。ダメなら次へ）');
  console.log('');

  if (host.includes('.exp.direct') || host.includes('.exp.host')) {
    console.log('■ トンネル利用中のとき（まず 443、だめなら 80）');
    console.log(`exp://${host}:443`);
    console.log(`exp://${host}:80`);
    console.log('');
  }

  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host)) {
    if (host.includes(':')) {
      console.log('■ manifest のホスト');
      console.log(`exp://${host}`);
    } else {
      console.log('■ manifest のホスト');
      console.log(`exp://${host}:${port}`);
    }
    console.log('');
  } else if (!host.includes('.exp.direct') && !host.includes('.exp.host')) {
    console.log('■ その他');
    console.log(`exp://${host}:80`);
    console.log('');
  }

  const lan = getLanIPv4();
  if (lan) {
    console.log('■ 同じ Wi‑Fi のとき（トンネルが不安定ならこちら）');
    console.log('  先に PC で:  npx expo start --lan --clear');
    console.log(`  exp://${lan}:${port}`);
    console.log('');
  }

  console.log('── それでも開けないとき ──');
  console.log('・Expo Go をストアで「最新」に更新（SDK 54 対応が必要）');
  console.log('・Galaxy の「バッテリー最適化」で Expo Go を制限しない');
  console.log('・USB で繋ぐ: adb reverse tcp:8081 tcp:8081  →  exp://127.0.0.1:8081');
  console.log('');
}

main();
