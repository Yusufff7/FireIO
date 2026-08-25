import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Focusable } from './Focusable';
import { colors, glow, radius } from '../theme';
import type { Meta } from '../types';

type PosterCardProps = {
  item: Meta;
  onPress: () => void;
  onFocus?: () => void;
  hasTVPreferredFocus?: boolean;
};

// Forwards a ref through to the underlying pressable so a row can name its
// first card as a TVFocusGuideView destination — see PosterRow.
//
// memo'd (below) because the parent re-renders on every hero change — i.e.
// on every single D-pad move — and without it each of those re-rendered
// every mounted poster in every row.
const PosterCardBase = React.forwardRef<React.ComponentRef<typeof Pressable>, PosterCardProps>(function PosterCard(
  { item, onPress, onFocus, hasTVPreferredFocus },
  ref,
) {
  // `bare` on the Focusable — the focus ring is scoped to just the poster
  // image below, not the whole card (which would also box in the title
  // text underneath it). This is the convention every other streaming app
  // uses: highlight the tile, not the label.
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      ref={ref}
      bare
      onPress={onPress}
      onFocus={() => {
        setFocused(true);
        onFocus?.();
      }}
      onBlur={() => setFocused(false)}
      hasTVPreferredFocus={hasTVPreferredFocus}
      style={styles.card}>
      {item.poster ? (
        <Image source={{ uri: item.poster }} style={[styles.image, focused && styles.imageFocused]} resizeMode="cover" />
      ) : (
        <View style={[styles.image, styles.placeholder, focused && styles.imageFocused]}>
          <Text style={styles.placeholderText} numberOfLines={3}>
            {item.name}
          </Text>
        </View>
      )}
      {/* Verbatim from whatever catalog this card came from — for the
          Animaze rows that's the AniList-specific title (e.g. "Fire Force
          Season 3"), never normalized down to the general show name. The
          general name only shows once the title is opened, from Cinemeta's
          own meta(). */}
      <Text style={styles.title} numberOfLines={2}>
        {item.name}
      </Text>
    </Focusable>
  );
});

export const PosterCard = React.memo(PosterCardBase);

// Slightly smaller than a "natural" poster tile on purpose: every pixel
// saved here buys height for the pinned hero above without costing a row.
const CARD_WIDTH = 106;
const IMAGE_HEIGHT = 142;

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    marginRight: 14,
  },
  image: {
    width: '100%',
    height: IMAGE_HEIGHT,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.glass,
  },
  // Outline (not border) so it draws outside the image's own bounds instead
  // of eating into it or forcing a layout shift, and isn't clipped by the
  // image's own overflow:hidden — same technique as the Player's controls.
  imageFocused: {
    outlineWidth: 2,
    outlineColor: colors.accent,
    outlineOffset: 3,
    ...glow(),
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  placeholderText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  title: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 15,
    marginTop: 6,
  },
});
