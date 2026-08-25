import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { RootNavigator } from './navigation/RootNavigator';
import { loadSettings } from './storage/settings';
import { loadSubtitlePrefs } from './storage/subtitlePrefs';
import { colors } from './theme';

// Named export — index.js does `import { App } from './src/App'`. A default
// export here resolves as `undefined` at the registration call and crashes
// with "Element type is invalid" at startup. Verified the hard way.
export const App = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Both are read synchronously later (getSettingsSync / getSubtitleStyleSync),
    // so both have to be warmed before the first screen renders.
    Promise.all([loadSettings(), loadSubtitlePrefs()]).finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return <RootNavigator />;
};

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
