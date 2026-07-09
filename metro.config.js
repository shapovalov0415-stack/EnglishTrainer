// Metro config.
//
// react-native-webrtc は event-target-shim@6 を要求するが、Expo SDK 54 は
// event-target-shim@5 を巻き込むためバージョン衝突が起きる。ここで
// react-native-webrtc からの 'event-target-shim/index' 解決を v6 に固定して
// 「Unable to resolve module event-target-shim/index」エラーを防ぐ。
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'event-target-shim/index') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(
        __dirname,
        'node_modules/react-native-webrtc/node_modules/event-target-shim/dist/event-target-shim.js',
      ),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
