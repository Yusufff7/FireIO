import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { PosterCard } from '../components/PosterCard';
import { Focusable } from '../components/Focusable';
import { IconSearch } from '../components/NavIcons';
import { TopNav } from '../components/TopNav';
import { search } from '../addons/client';
import { colors, radius, spacing } from '../theme';
import type { Meta, MediaType } from '../types';
import type { NativeStackScreenProps } from '@amazon-devices/react-navigation__native-stack';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Search'>;

const DEBOUNCE_MS = 400;
type Filter = 'all' | MediaType;

export function SearchScreen({ navigation }: Props) {
  const [query, setQuery] = useState('');
  const [movies, setMovies] = useState<Meta[]>([]);
  const [series, setSeries] = useState<Meta[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < 2) {
      setMovies([]);
      setSeries([]);
      return;
    }
    timer.current = setTimeout(() => {
      setLoading(true);
      Promise.all([search('movie', query), search('series', query)])
        .then(([m, s]) => {
          setMovies(m);
          setSeries(s);
        })
        .catch(() => {
          setMovies([]);
          setSeries([]);
        })
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  const openDetail = useCallback(
    (item: Meta) => navigation.navigate('Detail', { id: item.id, type: item.type }),
    [navigation],
  );

  // Back goes Home rather than out of the app. Without this the press fell
  // through to the platform default, which pops the stack — and since the
  // hover-driven nav means Search is often reached by a navigate() that
  // popped Home off first, "pop" could mean an empty stack and an exit.
  // Falling back to an explicit Home navigation makes it deterministic.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (navigation.canGoBack()) navigation.goBack();
      else navigation.navigate('Home');
      return true;
    });
    return () => sub.remove();
  }, [navigation]);

  const results = useMemo(
    () => (filter === 'movie' ? movies : filter === 'series' ? series : [...movies, ...series]),
    [filter, movies, series],
  );

  const keyExtractor = useCallback((item: Meta) => item.id, []);
  const renderItem = useCallback(
    ({ item }: { item: Meta }) => (
      <View style={styles.gridItem}>
        <PosterCard item={item} onPress={() => openDetail(item)} />
      </View>
    ),
    [openDetail],
  );

  return (
    <View style={styles.page}>
      <TopNav active="Search" onNavigate={r => navigation.navigate(r)} />

      <View style={styles.content}>
        {/* No autoFocus. It threw the on-screen keyboard up the instant the
            screen opened, covering the results before there was anything to
            type against. The bar is a normal focusable target now; the
            keyboard only appears once it's actually selected. */}
        <Focusable onPress={() => inputRef.current?.focus()} style={styles.inputRow}>
          <IconSearch size={18} color={colors.textDim} />
          <TextInput
            ref={inputRef}
            // Back to opening the keyboard on arrival — you come to this
            // screen to type, and the extra select press to get going was
            // the more annoying of the two behaviours.
            autoFocus
            focusable={false}
            value={query}
            onChangeText={setQuery}
            placeholder="Search movies and series"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
          />
        </Focusable>

        <View style={styles.chipRow}>
          {(['all', 'movie', 'series'] as Filter[]).map(f => (
            <Focusable key={f} onPress={() => setFilter(f)} pill style={[styles.chip, filter === f && styles.chipActive]}>
              <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>
                {f === 'all' ? 'All' : f === 'movie' ? 'Movies' : 'Shows'}
              </Text>
            </Focusable>
          ))}
        </View>

        {loading && <ActivityIndicator color={colors.text} style={styles.spinner} />}
        {!loading && query.trim().length >= 2 && results.length === 0 && (
          <Text style={styles.empty}>No results for "{query}"</Text>
        )}
        <FlatList
          data={results}
          numColumns={6}
          keyExtractor={keyExtractor}
          // Two rows up front, a small window around them, and clipped views
          // released — a broad search can return a couple of hundred posters
          // and there's no reason to hold them all decoded.
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          updateCellsBatchingPeriod={60}
          windowSize={3}
          removeClippedSubviews
          contentContainerStyle={styles.grid}
          renderItem={renderItem}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, paddingHorizontal: spacing.xl },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.glass,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  searchIcon: { color: colors.textDim, fontSize: 20, marginRight: spacing.sm },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 20,
    paddingVertical: spacing.md,
  },
  chipRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.lg },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.glassBorder },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: colors.accentOn },
  spinner: { marginTop: spacing.lg },
  empty: { color: colors.textDim, fontSize: 18, marginTop: spacing.lg },
  grid: { paddingBottom: spacing.xl },
  gridItem: { marginBottom: spacing.md },
});
