import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  FlatList,
  Image,
  type LayoutChangeEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { TVFocusGuideView } from '@amazon-devices/react-native-kepler';
import { Focusable } from '../components/Focusable';
import { PosterRow } from '../components/PosterRow';
import { Hero, HeroBackdrop, SCRIM_GRADIENT } from '../components/Hero';
import { TopNav } from '../components/TopNav';
import { catalog, meta as fetchMeta } from '../addons/client';
import { fetchAnimazeRows, type AnimazeRow } from '../addons/animaze';
import { loadHistory, progressFractionFor, removeWatched, subscribeHistory } from '../storage/history';
import { colors, glow, radius, spacing } from '../theme';
import type { HistoryEntry, Meta } from '../types';
import type { NativeStackScreenProps } from '@amazon-devices/react-navigation__native-stack';
import type { RootStackParamList } from '../types';
import { getSettingsSync, isConfigured } from '../storage/settings';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

const FOCUS_DEBOUNCE_MS = 150;

// Continue Watching renders this many cards until "Show all" is pressed.
// Each card holds a decoded 16:9 still, so the tail of a long history is real
// memory for rows the user almost never scrolls to.
const CW_COLLAPSED_COUNT = 15;

// cwCard width + marginRight — see PosterRow's CARD_STRIDE for why this has
// to stay in step with the style.
const CW_CARD_STRIDE = 150 + 20;

// Bespoke (not PosterCard, which is portrait — this is the wide 16:9
// Continue Watching format) but the same focus-ring rule applies: `bare` on
// Focusable and a local focused state so the outline scopes to the image,
// not the title text below it.
// memo'd for the same reason as PosterCard: the parent re-renders on every
// hero change, which is every D-pad move.
const ContinueWatchingCard = React.memo(React.forwardRef<
  React.ComponentRef<typeof Focusable>,
  {
    item: HistoryEntry;
    onPress: () => void;
    // Long-press arms a confirmation rather than deleting outright: a hold is
    // easy to trigger by accident on a remote, and there's no undo. The armed
    // state lives in HomeScreen so a Back press can cancel it.
    onArmRemove: () => void;
    onFocus: () => void;
    hasTVPreferredFocus?: boolean;
    confirmingRemove?: boolean;
  }
>(function ContinueWatchingCard(
  { item, onPress, onArmRemove, onFocus, hasTVPreferredFocus, confirmingRemove },
  ref,
) {
  const [focused, setFocused] = useState(false);
  // The episode's own still frame when we have one — it's already 16:9, which
  // is this card's shape, and it says far more about where you left off than
  // the series poster does.
  //
  // But metahub doesn't actually have a still for every show, and a missing
  // one 404s rather than being absent from the metadata — so the <Image>
  // rendered as an empty box. Walk a real fallback chain on load failure:
  // episode still -> series backdrop (also 16:9) -> poster -> placeholder.
  const [failedCount, setFailedCount] = useState(0);
  const candidates = [item.episodeThumbnail, item.background, item.poster].filter(Boolean) as string[];
  const image = candidates[failedCount];
  // Entries written before the series name and episode label were stored
  // separately have the label baked into the name too. Strip it on read so
  // those don't show "S1E1" twice without needing to be re-watched first.
  const displayName =
    item.episodeLabel && item.name.endsWith(item.episodeLabel)
      ? item.name.slice(0, -item.episodeLabel.length).trim()
      : item.name;
  const progress = progressFractionFor(item);
  return (
    <Focusable
      ref={ref}
      bare
      onPress={onPress}
      onLongPress={onArmRemove}
      onFocus={() => {
        setFocused(true);
        onFocus();
      }}
      onBlur={() => setFocused(false)}
      hasTVPreferredFocus={hasTVPreferredFocus}
      style={styles.cwCard}>
      {image ? (
        <Image
          key={image}
          source={{ uri: image }}
          onError={() => setFailedCount(n => n + 1)}
          style={[styles.cwImage, focused && styles.cwImageFocused]}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.cwImage, styles.cwPlaceholder, focused && styles.cwImageFocused]}>
          <Text style={styles.cwPlaceholderText} numberOfLines={2}>
            {item.name}
          </Text>
        </View>
      )}
      {/* Watched-so-far bar along the bottom of the still, Netflix-style.
          Only drawn once there's a real position to show. */}
      {progress > 0 && (
        <View style={styles.cwProgressTrack} pointerEvents="none">
          <View style={[styles.cwProgressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
      )}
      {confirmingRemove && (
        <View style={styles.cwConfirm} pointerEvents="none">
          <Text style={styles.cwConfirmText}>Remove?</Text>
          <Text style={styles.cwConfirmHint}>Press OK</Text>
        </View>
      )}
      <Text style={styles.cwTitle} numberOfLines={1}>
        {displayName}
      </Text>
      {item.episodeLabel ? <Text style={styles.cwEpisode}>{item.episodeLabel}</Text> : null}
    </Focusable>
  );
}));

// Netflix-style pinned hero: it stays on screen for whatever card currently
// has focus, big at the top and shrinking to a compact strip once focus moves
// down into the rows. It is NOT a child of the rows ScrollView — an equally
// tall spacer is, so the rows start below it and then slide up *behind* it as
// the platform auto-scrolls them into view.
//
// The collapse is driven by focus (which row owns the highlight), never by
// scroll offset. onScroll does not reliably fire during D-pad focus-driven
// auto-scroll here — tested by navigating 7 rows deep with a scroll-driven
// collapse that never triggered once. onFocus always fires, so that's what
// drives it. This also avoids the feedback loop an earlier scroll-linked
// version had, where shrinking the hero grew the scrollable viewport, which
// revealed more content, which fed back into the collapse.
const HERO_EXPANDED = 320;
const HERO_COMPACT = 205;

// Gap left between the bottom of the hero and the top of the focused row.
//
// Deliberately tiny. Anything visible in this gap is a window onto the row
// ABOVE the focused one — its card titles and episode labels showed through
// there as stray floating text. Masking the gap with an opaque strip covered
// the first row's own heading at rest, so instead the gap is closed and the
// breathing room comes from the hero's own bottom padding, which is part of
// the hero's opaque area and therefore can't leak.
const ROW_GAP = spacing.xs;

export function HomeScreen({ navigation }: Props) {
  const [movies, setMovies] = useState<Meta[]>([]);
  const [series, setSeries] = useState<Meta[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [animazeRows, setAnimazeRows] = useState<AnimazeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // Always-on hero, Prime/Netflix style: whatever card last had focus drives
  // it, not just the single "featured" item. Catalog rows already carry
  // description/genres/runtime/rating from Cinemeta's "top" list, so most
  // focus changes need no network call at all — only sparse Continue
  // Watching entries (which record just id/name/poster/background) fall
  // back to a follow-up meta() fetch, cached so revisits are free.
  const [focusedItem, setFocusedItem] = useState<Meta | null>(null);
  const metaCacheRef = useRef<Map<string, Meta>>(new Map());
  const latestFocusKeyRef = useRef<string | null>(null);
  const focusDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Each row's y offset *within the rows container* (not the scroll content
  // — see onCardFocus for why that distinction matters), reported by its own
  // onLayout. Used to scroll a focused row clear of the pinned hero.
  const scrollRef = useRef<ScrollView>(null);
  const rowOffsetsRef = useRef<Map<string, number>>(new Map());
  const measureRow = useCallback(
    (key: string) => (e: LayoutChangeEvent) => rowOffsetsRef.current.set(key, e.nativeEvent.layout.y),
    [],
  );

  // A real cross-dissolve: both titles are on screen at once, the outgoing
  // one at 1-t and the incoming one at t, so total coverage stays at 1
  // throughout and nothing behind the hero is ever revealed.
  //
  // Two earlier versions of this both flickered, for the same underlying
  // reason: they animated a single layer down and back up, so mid-transition
  // there was a moment with nothing (or only flat background) drawn. Holding
  // the previous title until the new one has fully faded in removes that
  // moment entirely.
  const [displayItem, setDisplayItem] = useState<Meta | null>(null);
  const [outgoingItem, setOutgoingItem] = useState<Meta | null>(null);
  const fade = useRef(new Animated.Value(1)).current;
  const prevFocusedIdRef = useRef<string | null>(null);

  // Tracked in a ref as well as state so the effect below can read the
  // currently-shown item without re-running every time it changes.
  const displayItemRef = useRef<Meta | null>(null);
  displayItemRef.current = displayItem;

  useEffect(() => {
    if (!focusedItem) return;
    if (prevFocusedIdRef.current === focusedItem.id) return;
    prevFocusedIdRef.current = focusedItem.id;

    const current = displayItemRef.current;
    // First hero of the session: nothing to dissolve from, so just show it.
    if (!current) {
      setDisplayItem(focusedItem);
      fade.setValue(1);
      return;
    }

    let cancelled = false;
    const begin = () => {
      if (cancelled) return;
      setOutgoingItem(displayItemRef.current);
      setDisplayItem(focusedItem);
      fade.setValue(0);
      Animated.timing(fade, { toValue: 1, duration: 300, useNativeDriver: true }).start(({ finished }) => {
        // Drop the outgoing layer only once it's fully hidden, so the
        // unmount can't show through.
        if (finished) setOutgoingItem(null);
      });
    };

    // The remaining flash was never the fade itself — it was fading INTO a
    // hero whose backdrop hadn't downloaded yet, so the incoming layer was
    // an empty dark box for a beat. Hold the outgoing title on screen until
    // the new artwork is actually decoded, then dissolve between two fully
    // painted frames. The timeout means a slow or missing image degrades to
    // "fade a little late" rather than "never fade".
    const uri = focusedItem.background ?? focusedItem.poster;
    if (!uri) {
      begin();
      return;
    }
    const timeout = setTimeout(begin, 700);
    Image.prefetch(uri)
      .then(begin)
      .catch(begin)
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [focusedItem, fade]);

  const outgoingOpacity = fade.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

  // Two independent focus-derived flags, both fed by onCardFocus:
  //
  //  atTopRow    — focus is in the topmost row, whichever that is (Continue
  //                Watching when there's history, otherwise Movies). Drives
  //                the TopNav fade, so the nav is present exactly while the
  //                user is at the top of the page.
  //  onCWRow     — focus is specifically in Continue Watching. Only that row
  //                gets the full-size hero; every other row (Movies, Series,
  //                the Animaze rows) gets the compact strip, so browsing
  //                shows as many real rows as possible.
  const [atTopRow, setAtTopRow] = useState(true);
  const [onCWRow, setOnCWRow] = useState(false);

  const navOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(navOpacity, { toValue: atTopRow ? 1 : 0, duration: 200, useNativeDriver: true }).start();
  }, [atTopRow, navOpacity]);

  // Height, not opacity, so it can't use the native driver. That's fine: this
  // fires once per row change, not once per scroll frame.
  const heroHeight = useRef(new Animated.Value(HERO_EXPANDED)).current;
  useEffect(() => {
    // eslint-disable-next-line @amazon-devices/kepler/animated
    Animated.timing(heroHeight, {
      toValue: onCWRow ? HERO_EXPANDED : HERO_COMPACT,
      duration: 220,
      // Height is a layout property — the native driver only handles
      // transform and opacity, so this genuinely cannot run on the UI
      // thread. It fires once per row change, not per frame.
      // eslint-disable-next-line @amazon-devices/kepler/animated
      useNativeDriver: false,
    }).start();
  }, [onCWRow, heroHeight]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([catalog('movie', 'top'), catalog('series', 'top'), loadHistory()])
      .then(([m, s, h]) => {
        if (cancelled) return;
        setMovies(m);
        setSeries(s);
        setHistory(h);
      })
      .catch(e => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return subscribeHistory(h => !cancelled && setHistory(h));
  }, []);

  // Fetched separately, never gating the main loading spinner — this is a
  // free-tier hosted addon and can have a real cold start; its rows should
  // pop in whenever they're ready rather than stall Home on a slow addon.
  useEffect(() => {
    let cancelled = false;
    fetchAnimazeRows()
      .then(rows => !cancelled && setAnimazeRows(rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (focusDebounceRef.current) clearTimeout(focusDebounceRef.current);
    };
  }, []);

  // Home never unmounts while you're off in Detail/Search/Settings, and
  // `hasTVPreferredFocus` is only honoured at mount — so coming back, nothing
  // re-claimed focus. The D-pad had nowhere to go: cards couldn't be
  // highlighted, and vertical presses just scrolled the ScrollView (the only
  // thing left that responds). The hero froze on whatever was last focused
  // because it's driven entirely by card focus.
  //
  // Remounting the rows to re-fire hasTVPreferredFocus was the first attempt
  // and it wasn't dependable — the freshly mounted card doesn't always take
  // focus. Asking for it explicitly does: Kepler adds requestTVFocus() to
  // View refs, and calling it on the first row's focus guide pushes focus
  // into that row's first card. One frame of delay so layout has settled.
  //
  // `screenFocused` additionally gates TopNav: its items navigate on focus,
  // so a stray focus event landing there mid-restore would bounce straight
  // back out to another screen.
  const screenFocusedRef = useRef(true);
  const firstRowGuideRef = useRef<React.ComponentRef<typeof TVFocusGuideView>>(null);
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Which row last held focus, so coming back from a title returns you to
  // that row (and, via its guide's own autoFocus, to that card) rather than
  // dumping you at the top of Continue Watching every time.
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  // Continue Watching's first card, named as an explicit focus destination
  // the same way PosterRow names its own. `autoFocus` alone was not enough:
  // it restores whichever card last had focus, and the horizontal list
  // unmounts off-screen cards, so arriving from Movies could target a card
  // that no longer exists and focus simply stayed put. That's what made
  // moving up into this row work only sometimes.
  const [firstCwCard, setFirstCwCard] = useState<React.ComponentRef<typeof Focusable> | null>(null);
  const rowGuidesRef = useRef(new Map<string, unknown>());
  const registerRowGuide = useCallback(
    (key: string) => (node: unknown) => {
      if (node) rowGuidesRef.current.set(key, node);
      else rowGuidesRef.current.delete(key);
      if (key === 'cw' || key === 'movies') firstRowGuideRef.current = node as never;
    },
    [],
  );

  // requestTVFocus is Kepler's own addition to View's imperative handle; it
  // isn't in the shipped TVFocusGuideView typings.
  // Coming back to Home always lands on Continue Watching's first card,
  // rather than restoring whichever row happened to hold focus when you
  // left. Two reasons that beat "put me back where I was":
  //
  //   - It is almost always what you want next. Backing out of a title (or
  //     out of Search) usually means "that wasn't it" or "I just finished
  //     that", and either way the thing you just touched is now card zero of
  //     Continue Watching.
  //   - Restoring by memory was unreliable here anyway: watching something
  //     rewrites its watchedAt and reorders this row, so the remembered card
  //     has moved or is a different node, and focus would sometimes land
  //     nowhere at all.
  //
  // Falls back to the first row when there is no Continue Watching yet.
  const restoreFocus = useCallback((delay = 80) => {
    if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = setTimeout(() => {
      const target = rowGuidesRef.current.get('cw') ?? firstRowGuideRef.current;
      (target as { requestTVFocus?: () => void } | null)?.requestTVFocus?.();
    }, delay);
  }, []);

  // Focus has to be reclaimed on THREE separate paths, which is why fixing
  // only one of them kept leaving the screen dead:
  //
  //   1. Returning from another screen  -> navigation 'focus'.
  //   2. Returning from the background  -> AppState 'active'. Backgrounding
  //      and resuming the app fires NO navigation event at all (Home was
  //      already the focused route before and still is), so this path was
  //      completely uncovered — that's the "exited from Search, reopened
  //      into Home, nothing selectable" case.
  //   3. First paint                    -> the rows don't exist yet when the
  //      screen mounts, so a request fired at mount hits nothing. Re-fired
  //      once the catalog has rendered.
  //
  // In every case the symptom was identical: no card holds focus, the D-pad
  // only scrolls the ScrollView, and the hero stays blank because it is
  // driven entirely by card focus.
  useEffect(() => {
    const onScreenFocus = () => {
      screenFocusedRef.current = true;
      restoreFocus();
    };
    const onScreenBlur = () => {
      screenFocusedRef.current = false;
    };
    const onAppState = (state: string) => {
      if (state === 'active' && screenFocusedRef.current) restoreFocus(150);
    };
    const unsubFocus = navigation.addListener('focus', onScreenFocus);
    const unsubBlur = navigation.addListener('blur', onScreenBlur);
    const appStateSub = AppState.addEventListener('change', onAppState);
    return () => {
      unsubFocus();
      unsubBlur();
      appStateSub.remove();
      if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
    };
  }, [navigation, restoreFocus]);

  const onCardFocus = useCallback((item: Meta, row: { key: string; top: boolean; continueWatching: boolean }) => {
    setAtTopRow(row.top);
    setOnCWRow(row.continueWatching);
    setActiveRowKey(row.key);

    // The platform auto-scrolls a newly focused card into view, but it has no
    // idea the hero is floating over the top of the viewport — so a row it
    // considers "visible" can still be sitting underneath it. Worse, it only
    // ever scrolls in one direction: moving focus DOWN pushes a card off the
    // bottom so it scrolls (minimally, leaving a gap), while moving focus UP
    // leaves the card technically inside the viewport — just hidden behind
    // the hero — so it doesn't scroll at all. Drive it ourselves instead.
    //
    // Offsets are measured relative to the rows container, NOT the scroll
    // content, which is the important part: the spacer above that container
    // is exactly as tall as the hero, so `contentY = heroHeight + rowY` and
    // the scroll needed to park a row at `heroHeight + gap` reduces to just
    // `rowY - gap` — with the hero height cancelling out. Measuring against
    // the scroll content instead made the offsets depend on whatever the
    // spacer happened to be mid-animation, which is what broke the Continue
    // Watching -> Movies step specifically: those offsets were captured
    // while the hero was still expanded, then used after it had collapsed.
    const rowY = rowOffsetsRef.current.get(row.key);
    if (rowY !== undefined) {
      scrollRef.current?.scrollTo({ y: Math.max(0, rowY - ROW_GAP), animated: true });
    }

    if (focusDebounceRef.current) clearTimeout(focusDebounceRef.current);
    focusDebounceRef.current = setTimeout(() => {
      // Cinemeta's "top" catalog entries always carry genres alongside
      // description; Animaze's catalog-only entries have a description but
      // never genres/runtime/rating. If we set the hero to the sparse
      // version immediately and then swap in the enriched one once the
      // fetch resolves, that's a visible flash — the meta line popping in
      // a beat after the title does. So for anything sparse, resolve the
      // full version *before* the hero ever shows it at all — it just
      // holds the previous title a little longer instead.
      if (item.genres?.length) {
        setFocusedItem(item);
        return;
      }

      const key = `${item.type}:${item.id}`;
      latestFocusKeyRef.current = key;
      const cached = metaCacheRef.current.get(key);
      if (cached) {
        setFocusedItem(cached);
        return;
      }
      fetchMeta(item.type, item.id).then(full => {
        if (latestFocusKeyRef.current !== key) return; // stale response, user moved on
        if (full) metaCacheRef.current.set(key, full);
        setFocusedItem(full ?? item); // fall back to the sparse item if Cinemeta has nothing for it
      });
    }, FOCUS_DEBOUNCE_MS);
  }, []);

  // Path 3 above: once the catalog has actually rendered there is finally a
  // row to hand focus to. Runs on the loading -> loaded edge only.
  useEffect(() => {
    if (loading || error) return;
    if (movies.length === 0 && history.length === 0) return;
    restoreFocus(250);
  }, [loading, error, movies.length, history.length, restoreFocus]);

  // Default hero on load, before any focus event: most-recent Continue
  // Watching entry, or the top movie.
  useEffect(() => {
    if (loading || error || focusedItem) return;
    const initial = history[0] ?? movies[0];
    if (initial)
      onCardFocus(initial, {
        key: history.length > 0 ? 'cw' : 'movies',
        top: true,
        continueWatching: history.length > 0,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, error, history, movies]);

  const openDetail = useCallback(
    (item: Meta) => navigation.navigate('Detail', { id: item.id, type: item.type }),
    [navigation],
  );

  // Resuming a Continue Watching entry no longer means re-resolving one
  // specific stored release — Player owns that now. This just navigates
  // with the remembered language/resolution as a PREFERENCE; Player walks
  // the current source list starting there, falling back through the rest
  // of the normal priority order if that exact combination isn't available
  // any more (provider caches and indexer results shift day to day, so
  // pinning to one exact release just meant "resume" broke the moment that
  // release disappeared). The "Trying source" progress UI lives on Player
  // now too, so there's nothing left for this screen to show while resuming
  // — it's just a navigate.
  const resumeEntry = useCallback(
    (entry: HistoryEntry) => {
      const targetId = entry.episodeId ?? entry.id;
      navigation.navigate('Player', {
        id: targetId,
        type: entry.type,
        title: entry.episodeLabel ? `${entry.name} ${entry.episodeLabel}` : entry.name,
        isAnime: entry.isAnime,
        preferredResolution: entry.lastResolution,
        poster: entry.poster,
        background: entry.background,
        episodeThumbnail: entry.episodeThumbnail,
        episodeLabel: entry.episodeLabel,
      });
    },
    [navigation],
  );

  // Which Continue Watching card, if any, is currently asking "Remove?".
  // Lifted out of the card so Back can dismiss it — inside the card, Back
  // had nothing listening and fell through to exiting the app.
  const [removeArmedId, setRemoveArmedId] = useState<string | null>(null);
  useEffect(() => {
    if (!removeArmedId) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setRemoveArmedId(null);
      return true;
    });
    return () => sub.remove();
  }, [removeArmedId]);

  const [showAllHistory, setShowAllHistory] = useState(false);
  const visibleHistory = showAllHistory ? history : history.slice(0, CW_COLLAPSED_COUNT);
  const hiddenHistoryCount = history.length - visibleHistory.length;

  // PosterRow is memo'd, which only helps if the handlers it receives keep
  // their identity across renders — an inline arrow would be a new function
  // on every hero change and defeat the memo entirely. Cached per row key.
  const focusHandlersRef = useRef(new Map<string, (item: Meta) => void>());
  const getRowFocusHandler = useCallback(
    (key: string, top: boolean) => {
      const cacheKey = `${key}:${top}`;
      const existing = focusHandlersRef.current.get(cacheKey);
      if (existing) return existing;
      const fn = (item: Meta) => onCardFocus(item, { key, top, continueWatching: false });
      focusHandlersRef.current.set(cacheKey, fn);
      return fn;
    },
    [onCardFocus],
  );

  const cwKeyExtractor = useCallback((item: HistoryEntry) => item.id, []);
  const cwGetItemLayout = useCallback(
    (_: ArrayLike<HistoryEntry> | null | undefined, index: number) => ({
      length: CW_CARD_STRIDE,
      offset: CW_CARD_STRIDE * index,
      index,
    }),
    [],
  );
  const renderCwItem = useCallback(
    ({ item, index }: { item: HistoryEntry; index: number }) => (
      <ContinueWatchingCard
        ref={index === 0 ? setFirstCwCard : undefined}
        item={item}
        confirmingRemove={removeArmedId === item.id}
        onPress={() => {
          // While armed, OK confirms the removal instead of resuming.
          if (removeArmedId === item.id) {
            setRemoveArmedId(null);
            removeWatched(item.id).catch(() => {});
          } else {
            resumeEntry(item);
          }
        }}
        onArmRemove={() => setRemoveArmedId(item.id)}
        onFocus={() => {
          // Moving to another card cancels a pending removal.
          setRemoveArmedId(prev => (prev === item.id ? prev : null));
          onCardFocus(item, { key: 'cw', top: true, continueWatching: true });
        }}
        hasTVPreferredFocus={index === 0}
      />
    ),
    [removeArmedId, resumeEntry, onCardFocus, setFirstCwCard],
  );

  const configured = isConfigured(getSettingsSync());
  const isContinueWatching = Boolean(displayItem && history.some(h => h.id === displayItem.id));
  // Movies is the first row only when there's no Continue Watching row above it.
  const moviesIsFirstRow = history.length === 0;

  return (
    <View style={styles.page}>
      {!configured && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            No stream sources configured. Add addon URLs to streamAddonUrls in src/storage/localDefaults.ts.
          </Text>
        </View>
      )}

      {loading && <ActivityIndicator color={colors.text} style={styles.spinner} size="large" />}
      {error && <Text style={styles.error}>Failed to load catalog: {error}</Text>}

      {!loading && !error && (
        <ScrollView ref={scrollRef} style={styles.rows} showsVerticalScrollIndicator={false}>
          {/* Reserves exactly the pinned hero's height so the first row starts
              below it. Shrinks in lockstep with the hero, which is what pulls
              the rows up as it collapses. */}
          <Animated.View style={{ height: heroHeight }} />

          {/* Every row's onLayout y is relative to THIS container, so the
              spacer's animating height never leaks into the measurements. */}
          <View>
          {history.length > 0 && (
            <View style={styles.row} onLayout={measureRow('cw')}>
              <Text style={styles.rowTitle}>Continue Watching</Text>
              {/* Same focus guide PosterRow uses. Without it this row was the
                  odd one out: leaving it fell back to plain geometric
                  navigation, which is why dropping from here into Movies
                  didn't land on Movies' first card the way every other
                  row-to-row move does. */}
              <TVFocusGuideView
                ref={registerRowGuide('cw')}
                style={styles.cwListWrap}
                autoFocus
                // Unconditional, unlike PosterRow's equivalent. PosterRow can
                // suppress its destination when returning to a row, because
                // its data is stable and `autoFocus` can restore the exact
                // card you left. This row's data is NOT stable: finishing or
                // even opening something rewrites its watchedAt and reorders
                // the list, so the card the guide remembers has moved or is
                // a different node entirely. That left it with nothing valid
                // to aim at — which is why "exit a show, then scroll up"
                // specifically was the case that kept failing. Card zero is
                // also the right target anyway: after the reorder it is the
                // thing you were just watching.
                destinations={firstCwCard ? [firstCwCard] : undefined}>
                <FlatList
                  horizontal
                  data={visibleHistory}
                  keyExtractor={cwKeyExtractor}
                  showsHorizontalScrollIndicator={false}
                  // Deliberately unwindowed — no removeClippedSubviews, no
                  // narrow windowSize. This list is capped at a handful of
                  // entries so the memory win is negligible, and BOTH of
                  // those unmount off-screen cards, which takes the first
                  // card out from under the focus guide above: scroll this
                  // row sideways and `destinations` silently becomes empty,
                  // so moving up into it from Movies stopped working.
                  initialNumToRender={visibleHistory.length || 6}
                  getItemLayout={cwGetItemLayout}
                  contentContainerStyle={styles.cwListContent}
                  renderItem={renderCwItem}
                  ListFooterComponent={
                    hiddenHistoryCount > 0 ? (
                      <Focusable onPress={() => setShowAllHistory(true)} rounded style={styles.cwShowAll}>
                        <Text style={styles.cwShowAllText}>Show all</Text>
                        <Text style={styles.cwShowAllCount}>+{hiddenHistoryCount}</Text>
                      </Focusable>
                    ) : null
                  }
                />
              </TVFocusGuideView>
            </View>
          )}

          <View onLayout={measureRow('movies')}>
            <PosterRow
              title="Movies"
              data={movies}
              onSelect={openDetail}
              onItemFocus={getRowFocusHandler('movies', moviesIsFirstRow)}
              autoFocusFirst={moviesIsFirstRow}
              guideRef={registerRowGuide('movies')}
              restoreLastFocused={activeRowKey === 'movies'}
            />
          </View>
          <View onLayout={measureRow('series')}>
            <PosterRow
              title="Series"
              data={series}
              onSelect={openDetail}
              onItemFocus={getRowFocusHandler('series', false)}
              guideRef={registerRowGuide('series')}
              restoreLastFocused={activeRowKey === 'series'}
            />
          </View>

          {animazeRows.map(row => (
            <View key={row.title} onLayout={measureRow(row.title)}>
              <PosterRow
                title={row.title}
                data={row.data}
                onSelect={openDetail}
                onItemFocus={getRowFocusHandler(row.title, false)}
                guideRef={registerRowGuide(row.title)}
                restoreLastFocused={activeRowKey === row.title}
              />
            </View>
          ))}
          </View>

          {/* The last row still needs to be able to scroll clear of the
              pinned hero above it, so the content has to be able to run
              past the bottom of the viewport by roughly a hero's worth. */}
          <View style={styles.tailSpacer} />
        </ScrollView>
      )}

      {/* Pinned above the rows, below the nav. The rows slide up behind it
          rather than pushing it away — Hero's own backdrop is opaque, so
          that reads as content passing underneath. */}
      {displayItem && (
        <Animated.View style={[styles.heroPinned, { height: heroHeight }]}>
          {/* Layer order matters here. Backdrops cross-fade, then ONE static
              scrim, then the text cross-fades over it. Previously each Hero
              carried its own scrim, so cross-fading two Heroes cross-faded
              two identical gradients — which read as the gradient pulsing on
              every title change. */}
          {outgoingItem && outgoingItem.id !== displayItem.id && (
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: outgoingOpacity }]} pointerEvents="none">
              <HeroBackdrop item={outgoingItem} />
            </Animated.View>
          )}
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]} pointerEvents="none">
            <HeroBackdrop item={displayItem} />
          </Animated.View>
          <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: SCRIM_GRADIENT }]} pointerEvents="none" />

          {outgoingItem && outgoingItem.id !== displayItem.id && (
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: outgoingOpacity }]} pointerEvents="none">
              <Hero
                item={outgoingItem}
                withBackdrop={false}
                onMoreInfo={() => openDetail(outgoingItem)}
                compact={!onCWRow}
              />
            </Animated.View>
          )}
          <Animated.View style={[styles.heroFade, { opacity: fade }]}>
            <Hero
              withBackdrop={false}
              item={displayItem}
              // Only on the full-size hero. The compact strip has no room for
              // a kicker above the title, and it was showing up whenever the
              // focused title merely happened to be in history — e.g. while
              // browsing Movies — which read as a mislabel.
              kicker={onCWRow && isContinueWatching ? 'Continue Watching' : undefined}
              onMoreInfo={() => openDetail(displayItem)}
              compact={!onCWRow}
            />
          </Animated.View>
        </Animated.View>
      )}

      {/* Floats over Hero's full-bleed backdrop art instead of pushing it
          down, and fades out once focus leaves the top row. Faded out it's
          also non-interactive, so D-pad focus can't land on an invisible
          nav item. */}
      <Animated.View style={[styles.navOverlay, { opacity: navOpacity }]} pointerEvents={atTopRow ? 'auto' : 'none'}>
        <TopNav
          active="Home"
          onNavigate={r => {
            // Ignore focus-driven navigation fired while Home isn't the
            // active screen (or for Home itself) — otherwise restoring focus
            // on the way back in can immediately throw you out again.
            if (!screenFocusedRef.current || r === 'Home') return;
            navigation.navigate(r);
          }}
          overlay
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  banner: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.glass,
    borderRadius: 8,
  },
  bannerText: { color: colors.textDim, fontSize: 16 },
  spinner: { marginTop: spacing.xl },
  error: { color: colors.danger, marginHorizontal: spacing.xl, fontSize: 16 },

  navOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 },

  rows: { flex: 1 },
  // Below navOverlay's zIndex (10) so the nav still draws over the hero art.
  heroPinned: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  heroFade: { flex: 1 },
  tailSpacer: { height: HERO_EXPANDED },
  row: { marginBottom: spacing.md },
  // Matches PosterRow's own title exactly — same font size and the same
  // spacing.lg inset. This row used to sit at spacing.xl, which left
  // "Continue Watching" and its cards visibly further right than "Movies"
  // and every row below it.
  rowTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    backgroundColor: 'transparent',
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  // Same insets as PosterRow's listContent, for the same reason: the cards
  // have to line up with every other row, and the focus ring needs room to
  // draw outside the poster without being clipped.
  cwListContent: {
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  cwCard: { width: 150, marginRight: spacing.md },
  cwShowAll: {
    width: 110,
    height: 84,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
    marginRight: spacing.md,
  },
  cwShowAllText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  cwShowAllCount: { color: colors.textDim, fontSize: 11, fontWeight: '600', marginTop: 2 },
  cwImage: { width: 150, height: 84, borderRadius: radius.md, backgroundColor: colors.glass, overflow: 'hidden' },
  cwImageFocused: { outlineWidth: 2, outlineColor: colors.accent, outlineOffset: 3, ...glow() },
  cwPlaceholder: { alignItems: 'center', justifyContent: 'center', padding: spacing.sm },
  cwPlaceholderText: { color: colors.text, fontSize: 12, fontWeight: '600', textAlign: 'center' },
  cwTitle: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: spacing.xs },
  cwEpisode: { color: colors.textDim, fontSize: 11, fontWeight: '600', marginTop: 1 },
  cwListWrap: { height: 130 },
  cwProgressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 84 - 4,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.28)',
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
    overflow: 'hidden',
  },
  cwProgressFill: { height: '100%', backgroundColor: colors.accent },
  cwConfirm: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 84,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10,10,11,0.82)',
    borderRadius: radius.md,
  },
  cwConfirmText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  cwConfirmHint: { color: colors.textDim, fontSize: 11, fontWeight: '600', marginTop: 2 },
});
