module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // reanimated v4 usa worklets plugin (vinha embutido na v3)
    plugins: ['react-native-worklets/plugin'],
  };
};
