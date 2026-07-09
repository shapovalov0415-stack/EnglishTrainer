// Metro config.
//
// react-native-webrtc は `event-target-shim/index` (v6 API) を import するが、
// Expo SDK 54 はトップレベルに event-target-shim@5 をホイストしてしまい、
// `event-target-shim/index` が解決できず JS バンドルが失敗する。
//
// v6 を別名 `event-target-shim-v6` (npm alias) で入れておき、webrtc が使う
// サブパス指定 import だけを v6 の実ファイルへ振り向ける。bare の
// `event-target-shim` は従来どおり v5 のまま（Expo 側はこれを使う）。
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

const EVENT_TARGET_SHIM_V6 = path.resolve(
  __dirname,
  'node_modules/event-target-shim-v6/index.js',
);

const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === 'event-target-shim/index' ||
    moduleName === 'event-target-shim/index.js'
  ) {
    return { type: 'sourceFile', filePath: EVENT_TARGET_SHIM_V6 };
  }
  if (upstreamResolveRequest) {
    return upstreamResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
