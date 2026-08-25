import React, { useState } from 'react';
import { Pressable, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { colors, glow, radius } from '../theme';

type Props = {
  onPress?: () => void;
  onLongPress?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  style?: StyleProp<ViewStyle>;
  hasTVPreferredFocus?: boolean;
  rounded?: boolean;
  pill?: boolean;
  // Skips the default border/scale/glow entirely — for callers (like
  // PosterCard) that want the focus ring scoped to just one inner element
  // (the poster image) rather than the whole pressable, so a title label
  // underneath doesn't get boxed in too. onFocus/onBlur still fire; the
  // caller drives its own visual treatment from those.
  bare?: boolean;
  children: React.ReactNode;
};

// Design's focus signature: an ice-blue outline ring + glow + a slight lift,
// not a flat colored box — see the Continue Watching "pinned" card in the
// mockup (outline: 2px solid #a8e0ff, scale 1.03, drop shadow).
export const Focusable = React.forwardRef<React.ComponentRef<typeof Pressable>, Props>(function Focusable(
  { onPress, onLongPress, onFocus, onBlur, style, hasTVPreferredFocus, rounded, pill, bare, children },
  ref,
) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      ref={ref}
      focusable
      hasTVPreferredFocus={hasTVPreferredFocus}
      onPress={onPress}
      onLongPress={onLongPress}
      onFocus={() => {
        setFocused(true);
        onFocus?.();
      }}
      onBlur={() => {
        setFocused(false);
        onBlur?.();
      }}
      style={[
        !bare && pill && styles.pill,
        !bare && rounded && !pill && { borderRadius: radius.md },
        !bare && styles.base,
        !bare && focused && styles.focused,
        !bare && focused && glow(),
        style,
      ]}>
      {children}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  base: { borderWidth: 2, borderColor: 'transparent' },
  pill: { borderRadius: radius.pill },
  focused: { borderColor: colors.accent, transform: [{ scale: 1.04 }] },
});
