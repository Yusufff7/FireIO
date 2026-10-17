import React, { useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { colors, FOCUS_SCALE_MS, glow, radius } from '../theme';

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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Shared by the tiles that draw their own focus treatment (PosterCard, the
// Continue Watching card): an eased scale on the native driver.
export function useFocusScale(focusedScale: number) {
  const scale = useRef(new Animated.Value(1)).current;
  const animateTo = (focused: boolean) =>
    Animated.timing(scale, {
      toValue: focused ? focusedScale : 1,
      duration: FOCUS_SCALE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  return { scale, animateTo };
}

// Design's focus signature: an ice-blue outline ring + glow + a slight lift,
// not a flat colored box — see the Continue Watching "pinned" card in the
// mockup (outline: 2px solid #a8e0ff, scale 1.03, drop shadow).
//
// The lift eases in rather than snapping: an instant 4% jump on every D-pad
// press was a large part of why moving around felt jerky.
export const Focusable = React.forwardRef<React.ComponentRef<typeof Pressable>, Props>(function Focusable(
  { onPress, onLongPress, onFocus, onBlur, style, hasTVPreferredFocus, rounded, pill, bare, children },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const { scale, animateTo } = useFocusScale(1.04);

  // Bare stays a plain Pressable: callers hand its ref to TVFocusGuideView
  // as a destination, and it has no visuals of its own to animate.
  if (bare) {
    return (
      <Pressable
        ref={ref}
        focusable
        hasTVPreferredFocus={hasTVPreferredFocus}
        onPress={onPress}
        onLongPress={onLongPress}
        onFocus={onFocus}
        onBlur={onBlur}
        style={style}>
        {children}
      </Pressable>
    );
  }

  return (
    <AnimatedPressable
      ref={ref}
      focusable
      hasTVPreferredFocus={hasTVPreferredFocus}
      onPress={onPress}
      onLongPress={onLongPress}
      onFocus={() => {
        setFocused(true);
        animateTo(true);
        onFocus?.();
      }}
      onBlur={() => {
        setFocused(false);
        animateTo(false);
        onBlur?.();
      }}
      style={[
        pill && styles.pill,
        rounded && !pill && { borderRadius: radius.md },
        styles.base,
        focused && styles.focused,
        focused && glow(),
        style,
        { transform: [{ scale }] },
      ]}>
      {children}
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  base: { borderWidth: 2, borderColor: 'transparent' },
  pill: { borderRadius: radius.pill },
  focused: { borderColor: colors.accent },
});
