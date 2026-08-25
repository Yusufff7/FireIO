import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Focusable } from './Focusable';
import { colors, spacing } from '../theme';
import type { Meta } from '../types';

// Real CSS gradient (RN 0.83's `experimental_backgroundImage`) — replaces
// the old 7-layer stacked-View scrim, which rendered as visible opacity
// bands rather than a smooth fade. One View, one gradient, no banding.
export const SCRIM_GRADIENT =
  'linear-gradient(0deg, rgba(10,10,11,1) 0%, rgba(10,10,11,0.88) 28%, rgba(10,10,11,0.4) 58%, rgba(10,10,11,0.06) 82%, transparent 100%)';

// Backdrop and content are separate components so the caller can slot a
// SINGLE, never-animated scrim between them (see HomeScreen). With the scrim
// living inside one Hero, cross-fading two Heroes cross-faded two scrims as
// well — the gradient visibly pulsed on every title change even though it's
// identical in both.
// The hero always spans the full window, so its width is knowable up front —
// no measuring required. Two earlier attempts failed here for the same
// underlying reason, that the backdrop ended up with no usable height:
// `aspectRatio` on an absolutely-positioned box (top/left/right, no height)
// doesn't resolve to one, and `onLayout` on that same box never fired to
// supply one either. Both collapsed the image to zero and left nothing but
// the scrim over black.
//
// width * 9/16 is exactly the height at which a 16:9 backdrop needs no
// vertical cropping at all, so `cover` can't re-centre the crop — the
// visible region stays anchored to the top and the hero's own overflow
// clips the rest.
// useWindowDimensions(), not a module-level Dimensions.get(). This module is
// imported during startup, before the window has been measured, so the
// module-scope read returned 0 — which set the image's width to 0 and was
// the third distinct way this backdrop ended up invisible. The hook is
// evaluated on render, after mount, so it always has the real value.
export function HeroBackdrop({ item }: { item: Meta }) {
  const image = item.background ?? item.poster;
  if (!image) return null;
  return <Image source={{ uri: image }} style={styles.backdrop} resizeMode="cover" />;
}

export function Hero({
  item,
  kicker,
  onMoreInfo,
  compact,
  withBackdrop,
}: {
  item: Meta;
  kicker?: string;
  onMoreInfo: () => void;
  // True once the caller has shrunk the hero (see HomeScreen's collapsing
  // header). Compact drops the Play/More Info buttons rather than shrinking
  // them — once collapsed, D-pad focus has already moved down into the
  // rows below, so those buttons aren't reachable anyway. That space goes
  // to more of the title's own real info instead (full description, cast).
  compact?: boolean;
  // When false the caller is drawing the backdrop and scrim itself (see
  // HomeScreen's cross-fade) and this renders text only.
  withBackdrop?: boolean;
}) {
  // Only real fields — genres/runtime/rating come from Cinemeta's catalog
  // response directly for browsed titles, or a follow-up meta() fetch for
  // sparse Continue Watching entries. Never fabricated.
  const metaParts = [
    item.year,
    item.genres?.length ? item.genres.slice(0, 3).join(', ') : undefined,
    item.runtime,
    item.imdbRating ? `★ ${item.imdbRating}` : undefined,
  ].filter(Boolean);
  const castLine = item.cast?.length ? `Starring ${item.cast.slice(0, 3).join(', ')}` : undefined;

  return (
    // The opaque wrap background is only correct when this Hero is drawing
    // its own backdrop. When the caller supplies one (HomeScreen's
    // cross-fade), this component is a text-only layer stacked ON TOP of
    // those backdrop layers — and an opaque background here painted straight
    // over them, which is why the hero art was invisible and the top of the
    // screen read as a slightly different black (#0d0d0e) to everything
    // else (#0a0a0b).
    <View style={[styles.wrap, withBackdrop === false && styles.wrapTransparent]}>
      {withBackdrop !== false && (
        <>
          <HeroBackdrop item={item} />
          <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: SCRIM_GRADIENT }]} pointerEvents="none" />
        </>
      )}
      <View style={[styles.content, compact && styles.contentCompact]}>
        {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
        <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>
          {item.name}
        </Text>
        {metaParts.length > 0 && <Text style={styles.meta}>{metaParts.join('  ·  ')}</Text>}

        {/* Description and action sit side by side rather than stacked. The
            button below the text pushed everything up against the top of the
            hero and left the whole block looking compressed; beside it, the
            text keeps its natural position and the empty right-hand side
            gets used. */}
        <View style={styles.bodyRow}>
          <View style={styles.textCol}>
            {item.description ? (
              <Text style={styles.description} numberOfLines={2}>
                {item.description}
              </Text>
            ) : null}
            {compact && castLine ? (
              <Text style={styles.castLine} numberOfLines={1}>
                {castLine}
              </Text>
            ) : null}
          </View>
          {!compact && (
            // One action, not two. Play is redundant here: the Continue
            // Watching cards themselves already resume on select, so the only
            // thing the hero adds is a way into the full details.
            <Focusable onPress={onMoreInfo} pill style={styles.detailsButton}>
              <Text style={styles.detailsButtonText}>View Details</Text>
            </Focusable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Fills whatever height the caller's container gives it (see HomeScreen's
  // heroSlot) rather than a fixed pixel height — a fixed height here used to
  // exceed the actual viewport and leave zero room for anything below it.
  wrap: {
    flex: 1,
    backgroundColor: colors.backgroundElevated,
    overflow: 'hidden',
  },
  wrapTransparent: { backgroundColor: 'transparent' },
  // Back to left/right anchoring, which is the form that actually rendered.
  // Deriving the width instead — via aspectRatio, onLayout, or Dimensions —
  // failed three different ways, all of them ending with a zero-sized image.
  // left:0/right:0 gets the real width from layout without computing it.
  //
  // The height is the device's own 16:9 screen height, so the box matches the
  // artwork's aspect: `cover` then has nothing to crop vertically, and the
  // visible slice stays anchored to the TOP of the image (the hero's
  // overflow:hidden trims the bottom) rather than being centre-cropped
  // through the middle of people's faces.
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, height: 720 },
  content: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // spacing.lg to match PosterRow's own title inset — the hero text used a
    // wider inset and sat visibly further right than every row heading
    // beneath it.
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    // Less bottom padding than the other sides — this used to be a blanket
    // spacing.xl (32) on every side, which left a visibly large gap between
    // the description/buttons and whatever renders directly below Hero.
    // This is what separates the hero text from the first row, rather than a
    // gap between them: it's inside the hero's own opaque area, so nothing
    // scrolling underneath can show through it.
    paddingBottom: spacing.lg,
    // No maxWidth: the content spans the hero so the action can sit out on
    // the right. The text column is what's width-limited now, not this.
  },
  contentCompact: { paddingTop: spacing.xs, paddingBottom: spacing.xs },
  kicker: { color: colors.accent, fontSize: 13, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: spacing.sm },
  title: {
    color: colors.text,
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  titleCompact: { fontSize: 26 },
  meta: { color: colors.textDim, fontSize: 15, fontWeight: '600', marginTop: spacing.sm },
  description: {
    color: colors.textDim,
    fontSize: 15,
    lineHeight: 21,
  },
  castLine: { color: colors.textFaint, fontSize: 13, fontWeight: '600', marginTop: spacing.xs },
  bodyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
    marginTop: spacing.sm,
  },
  // The text stays readable-width; the row's remaining space is what pushes
  // the action button out to the right.
  textCol: { flex: 1, maxWidth: 760 },
  // Outlined rather than a solid white slab — with only one action there's
  // no primary/secondary relationship left to express, and a quieter button
  // keeps the artwork the loudest thing in the hero.
  detailsButton: {
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.glass,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minWidth: 140,
    alignItems: 'center',
  },
  detailsButtonText: { color: colors.text, fontSize: 15, fontWeight: '700', letterSpacing: 0.2 },
});
