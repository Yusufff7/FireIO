const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

 /**
+ * Metro configuration
+ * https://facebook.github.io/metro/docs/configuration
  *
+ * @type {import('metro-config').MetroConfig}
  */
const config = {
  // MkvDemuxModule lives in this repo and is installed as a `file:`
  // dependency, which npm wires up as a node_modules symlink pointing back
  // at it. Metro's default resolver doesn't follow symlinks — and it fails
  // silently, resolving nothing without failing the overall build — so
  // unstable_enableSymlinks is required for the module to be found at all.
  // watchFolders keeps the real directory in Metro's crawl set so edits to
  // the native module's TypeScript surface are picked up.
  watchFolders: [path.resolve(__dirname, 'MkvDemuxModule')],
  resolver: {
    unstable_enableSymlinks: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);