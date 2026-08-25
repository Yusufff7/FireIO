import React, { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { TVFocusGuideView } from '@amazon-devices/react-native-kepler';
import { PosterCard } from './PosterCard';
import { colors, spacing } from '../theme';
import type { Meta } from '../types';

function PosterRowBase({
  title,
  data,
  onSelect,
  onItemFocus,
  autoFocusFirst,
  guideRef,
  restoreLastFocused,
}: {
  title: string;
  data: Meta[];
  onSelect: (item: Meta) => void;
  onItemFocus?: (item: Meta) => void;
  autoFocusFirst?: boolean;
  // Lets a parent grab this row's focus guide and call requestTVFocus() on
  // it — the only reliable way to hand focus back after returning to a
  // screen that never unmounted. See HomeScreen.
  guideRef?: React.Ref<React.ComponentRef<typeof TVFocusGuideView>>;
  // Set on the one row that held focus when the screen was left. Suppresses
  // the first-card destination so the guide's own autoFocus can restore
  // whichever card was actually focused — which is what you want coming back
  // from a title, as opposed to arriving at a row from above.
  restoreLastFocused?: boolean;
}) {
  // `autoFocus` alone restores whichever card in this row had focus last, so
  // dropping into a row you'd already scrolled sideways landed you mid-row
  // rather than at the start. Naming the first card as an explicit
  // destination makes entering the row always mean entering it at item one.
  // Held in state, not just a ref, because the guide needs to re-render once
  // the node actually exists.
  const [firstCard, setFirstCard] = useState<React.ComponentRef<typeof Pressable> | null>(null);
  const listRef = useRef<FlatList<Meta>>(null);

  // Stable identities so FlatList doesn't treat every parent render as a
  // reason to re-render every visible cell.
  const keyExtractor = useCallback((item: Meta) => item.id, []);
  const getItemLayout = useCallback(
    (_: ArrayLike<Meta> | null | undefined, index: number) => ({
      length: CARD_STRIDE,
      offset: CARD_STRIDE * index,
      index,
    }),
    [],
  );
  const renderItem = useCallback(
    ({ item, index }: { item: Meta; index: number }) => (
      <PosterCard
        ref={index === 0 ? setFirstCard : undefined}
        item={item}
        onPress={() => onSelect(item)}
        onFocus={() => {
          // Entering at item one should also mean *seeing* item one — the
          // list keeps its horizontal offset otherwise. Skipped while
          // restoring, where the remembered card may legitimately be
          // further along the row.
          if (index === 0 && !restoreLastFocused) listRef.current?.scrollToOffset({ offset: 0, animated: false });
          onItemFocus?.(item);
        }}
        hasTVPreferredFocus={autoFocusFirst && index === 0}
      />
    ),
    [onSelect, onItemFocus, autoFocusFirst, restoreLastFocused],
  );

  if (data.length === 0) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      <TVFocusGuideView
        ref={guideRef}
        style={styles.listWrap}
        autoFocus
        destinations={!restoreLastFocused && firstCard ? [firstCard] : undefined}>
        <FlatList
          ref={listRef}
          horizontal
          data={data}
          keyExtractor={keyExtractor}
          showsHorizontalScrollIndicator={false}
          // Windowing config per Vega's FlatList guidance. A row is ~7 cards
          // wide on screen; rendering 8 up front covers the visible set plus
          // one, and a window of 3 screens' worth keeps a small buffer either
          // side rather than realising every poster in a 100-item catalog.
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          updateCellsBatchingPeriod={60}
          windowSize={3}
          removeClippedSubviews
          // Every card is a fixed width, so offsets can be computed instead
          // of measured — this skips layout passes entirely while scrolling.
          getItemLayout={getItemLayout}
          contentContainerStyle={styles.listContent}
          renderItem={renderItem}
        />
      </TVFocusGuideView>
    </View>
  );
}

// Whole rows are memo'd too — HomeScreen re-renders on every hero change, and
// without this each of those walked all ~9 rows and their visible cards.
export const PosterRow = React.memo(PosterRowBase);

// Must match PosterCard's own width + marginRight — getItemLayout computes
// offsets from this instead of measuring, so a mismatch shows up as cards
// landing slightly off when scrolled programmatically.
const CARD_STRIDE = 106 + 14;

const styles = StyleSheet.create({
  row: {
    marginBottom: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    // No background of its own — the focused card's outline ring and glow
    // extend up past the poster's top edge into this gap, and anything
    // painted here would cut across them.
    backgroundColor: 'transparent',
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  // Sized to exactly what's inside it — listContent's own vertical padding
  // (12 + 6) + the poster (142) + the title's gap and two lines (6 + 30).
  // Any slack beyond that reads as dead black space between the rows.
  listWrap: { height: 196 },
  // Padding on every side the focus ring can extend into: the ring is drawn
  // outside the poster's own box (outlineOffset) plus a soft glow, so with
  // the cards flush against the list's edges the top of the ring was being
  // clipped off by the list's own bounds.
  listContent: {
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
});
