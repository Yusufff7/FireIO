import React, { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TVFocusGuideView } from '@amazon-devices/react-native-kepler';
import { Carousel, type CarouselRenderInfo } from '@amazon-devices/vega-carousel';
import { PosterCard } from './PosterCard';
import { colors, spacing } from '../theme';
import type { Meta } from '../types';

// One Home row, on Amazon's native Vega Carousel rather than a FlatList.
//
// The FlatList kept every card it had ever realised inside its window —
// with nine rows that was hundreds of decoded posters on a 1 GB stick — and
// scrolled through JS-driven virtualisation that dropped frames whenever the
// JS thread was busy (which, on Home, is every focus change). The Carousel
// recycles a fixed set of item views (renderedItemsCount) and runs the
// scroll animation natively, the way TV-first apps do it. Its "anchored"
// strategy is the Netflix motion: the selected card stays put at the start
// of the row and the row slides under it.

function PosterRowBase({
  title,
  data,
  onSelect,
  onItemFocus,
  autoFocusFirst,
  guideRef,
}: {
  title: string;
  data: Meta[];
  onSelect: (item: Meta) => void;
  onItemFocus?: (item: Meta, index: number) => void;
  autoFocusFirst?: boolean;
  // Lets a parent grab this row's focus guide and call requestTVFocus() on
  // it — the only reliable way to hand focus back after returning to a
  // screen that never unmounted. See HomeScreen.
  guideRef?: React.Ref<React.ComponentRef<typeof TVFocusGuideView>>;
}) {
  const getItem = useCallback((index: number) => data[index], [data]);
  const getItemCount = useCallback(() => data.length, [data]);
  const getItemKey = useCallback((info: CarouselRenderInfo<Meta>) => info.item?.id ?? String(info.index), []);
  const notifyDataError = useCallback(() => false, []);
  const dataAdapter = useMemo(
    () => ({ getItem, getItemCount, getItemKey, notifyDataError }),
    [getItem, getItemCount, getItemKey, notifyDataError],
  );

  const renderItem = useCallback(
    ({ item, index }: CarouselRenderInfo<Meta>) => (
      // The slot is the row's full height; the top padding is the room the
      // focus ring, glow and lift draw into above the poster.
      <View style={styles.slot}>
        <PosterCard
          flush
          item={item}
          onPress={() => onSelect(item)}
          onFocus={() => onItemFocus?.(item, index)}
          hasTVPreferredFocus={autoFocusFirst && index === 0}
        />
      </View>
    ),
    [onSelect, onItemFocus, autoFocusFirst],
  );

  if (data.length === 0) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      <TVFocusGuideView ref={guideRef} style={styles.listWrap} autoFocus={autoFocusFirst}>
        <Carousel
          uniqueId={title}
          orientation="horizontal"
          dataAdapter={dataAdapter}
          renderItem={renderItem}
          // ~11 cards fit across the screen; a few extra either side are
          // what the next presses reveal.
          renderedItemsCount={15}
          numOffsetItems={3}
          selectionStrategy="anchored"
          navigableScrollAreaMargin={spacing.md}
          containerStyle={styles.carousel}
          itemStyle={ITEM_STYLE}
          animationDuration={ANIMATION}
        />
      </TVFocusGuideView>
    </View>
  );
}

// Whole rows are memo'd too — HomeScreen re-renders on every hero change, and
// without this each of those walked all ~9 rows.
export const PosterRow = React.memo(PosterRowBase);

// Module-level so their identity never changes: a new object each render
// would read to the carousel as a style change.
const ITEM_STYLE = { itemPadding: 14, pressedItemScaleFactor: 0.95, selectedItemScaleFactor: 1 };
const ANIMATION = { itemPressedDuration: 0.12, itemScrollDuration: 0.18 };

// The list band under the row title.
export const ROW_LIST_HEIGHT = 196;

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
  // Sized to exactly what's inside it: the slot's top padding (12) + the
  // card (178) + a little room under it (6).
  listWrap: { height: ROW_LIST_HEIGHT },
  carousel: { width: '100%', height: ROW_LIST_HEIGHT },
  slot: { height: ROW_LIST_HEIGHT, paddingTop: spacing.sm },
});
