import React from 'react';
import { NavigationContainer, DarkTheme } from '@amazon-devices/react-navigation__native';
import { createNativeStackNavigator } from '@amazon-devices/react-navigation__native-stack';
import { HomeScreen } from '../screens/HomeScreen';
import { SearchScreen } from '../screens/SearchScreen';
import { DetailScreen } from '../screens/DetailScreen';
import { PlayerScreen } from '../screens/PlayerScreen';
import { colors } from '../theme';
import type { RootStackParamList } from '../types';

const Stack = createNativeStackNavigator<RootStackParamList>();

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: colors.background, card: colors.background },
};

export function RootNavigator() {
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}>
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Search" component={SearchScreen} />
        <Stack.Screen name="Detail" component={DetailScreen} />
        <Stack.Screen name="Player" component={PlayerScreen} options={{ orientation: 'landscape' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
