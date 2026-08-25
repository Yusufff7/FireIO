import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, StyleSheet, Text, View } from 'react-native';
import { useTVEventHandler } from '@amazon-devices/react-native-kepler';
import { Focusable } from '../components/Focusable';
import { meta } from '../addons/client';
import { colors, radius, spacing } from '../theme';
import type { Episode, Meta } from '../types';
import type { NativeStackScreenProps } from '@amazon-devices/react-navigation__native-stack';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Detail'>;

// Real CSS gradient (RN 0.83's `experimental_backgroundImage`), same as Hero
// and the Player's scrims. The previous stack of seven fixed-height
// semi-transparent Views rendered as visible horizontal bands rather than a
// smooth fade — each layer's flat opacity had a hard edge against the next.
// Darkest at the left and bottom, where the text sits; the art stays legible
// through the top-right.
const BACKDROP_SCRIM =
  'linear-gradient(90deg, rgba(10,10,11,0.97) 0%, rgba(10,10,11,0.88) 35%, rgba(10,10,11,0.55) 70%, rgba(10,10,11,0.35) 100%)';
const BACKDROP_SCRIM_VERTICAL =
  'linear-gradient(0deg, rgba(10,10,11,0.98) 0%, rgba(10,10,11,0.6) 40%, rgba(10,10,11,0.25) 75%, rgba(10,10,11,0.35) 100%)';

// Cinemeta files anything that isn't part of the numbered run — OVAs,
// recaps, specials — under season 0. "Season 0" is meaningless to a viewer,
// and sorting it first (which is what a plain numeric sort does) pushes the
// actual first season to the second tab.
const seasonLabel = (s: number) => (s === 0 ? 'Specials' : `Season ${s}`);
const bySeasonOrder = (a: number, b: number) => (a === 0 ? 1 : b === 0 ? -1 : 0) || a - b;

const episodeTitle = (v: Episode) => v.name ?? v.title ?? `Episode ${v.episode}`;
const episodeSummary = (v: Episode) => v.overview ?? v.description;

function airedYear(v: Episode): string | undefined {
  const raw = v.released ?? v.firstAired;
  if (!raw) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Netflix-style episode row: still frame on the left, title/description on
// the right. The focus ring is scoped to the whole card here (unlike a poster
// tile) because the card *is* the unit — image and text together.
function EpisodeCard({
  video,
  seriesName,
  fallbackImage,
  onPress,
  hasTVPreferredFocus,
}: {
  video: Episode;
  seriesName: string;
  // metahub 404s rather than omitting stills it doesn't have, so a missing
  // one renders as an empty box unless we catch onError and fall back.
  fallbackImage?: string;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const thumb = !thumbFailed && video.thumbnail ? video.thumbnail : fallbackImage;
  const summary = episodeSummary(video);
  const aired = airedYear(video);
  return (
    <Focusable
      bare
      hasTVPreferredFocus={hasTVPreferredFocus}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[styles.episodeCard, focused && styles.episodeCardFocused]}>
      <View style={styles.episodeThumbWrap}>
        {thumb ? (
          <Image
            key={thumb}
            source={{ uri: thumb }}
            onError={() => setThumbFailed(true)}
            style={styles.episodeThumb}
            resizeMode="cover"
          />
        ) : (
          <View style={[styles.episodeThumb, styles.episodeThumbEmpty]}>
            <Text style={styles.episodeThumbEmptyText}>E{video.episode}</Text>
          </View>
        )}
      </View>
      <View style={styles.episodeBody}>
        <Text style={styles.episodeHeading} numberOfLines={1}>
          {video.episode}. {episodeTitle(video)}
        </Text>
        <View style={styles.episodeMetaRow}>
          {aired ? <Text style={styles.episodeMeta}>{aired}</Text> : null}
          {video.rating ? <Text style={styles.episodeMeta}>★ {video.rating}</Text> : null}
        </View>
        {summary ? (
          <Text style={styles.episodeSummary} numberOfLines={3}>
            {summary}
          </Text>
        ) : (
          <Text style={styles.episodeSummaryMissing}>No description available for this episode.</Text>
        )}
      </View>
      <Text style={styles.episodeChevron} accessibilityLabel={`Play ${seriesName}`}>
        ›
      </Text>
    </Focusable>
  );
}

export function DetailScreen({ route, navigation }: Props) {
  const { id, type } = route.params;
  const [info, setInfo] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSeason, setActiveSeason] = useState<number | null>(null);

  // Season switching is a left/right gesture on the episode list, not a
  // separate focusable strip: the tabs are now a pure indicator, so D-pad
  // focus stays on the episodes and never has to detour up into a tab bar
  // just to change season. Assigned during render (below) and read here, so
  // the handler can be registered before the loading/error early-returns
  // without breaking the rules of hooks.
  const seasonNavRef = useRef<{ seasons: number[]; season: number | null }>({ seasons: [], season: null });
  useTVEventHandler(evt => {
    if (evt.eventKeyAction === 1) return;
    if (evt.eventType !== 'left' && evt.eventType !== 'right') return;
    const { seasons: list, season: current } = seasonNavRef.current;
    if (list.length < 2 || current === null) return;
    const at = list.indexOf(current);
    if (at < 0) return;
    const next = list[at + (evt.eventType === 'right' ? 1 : -1)];
    if (next !== undefined) setActiveSeason(next);
  });

  useEffect(() => {
    let cancelled = false;
    meta(type, id).then(m => !cancelled && setInfo(m)).finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, type]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.text} size="large" />
      </View>
    );
  }

  // Animaze rows are AniList-sourced and carry plain IMDB ids, but not every
  // one of them exists in Cinemeta — those titles resolve to nothing here.
  // Searching by name usually does find them, so offer that rather than a
  // dead end.
  if (!info) {
    return (
      <View style={styles.center}>
        <Text style={styles.notFoundTitle}>Details unavailable for this title</Text>
        <Text style={styles.notFoundBody}>
          This entry came from a catalog that doesn't provide full details. Try searching for it by name — the
          same show is usually listed there with episodes and sources.
        </Text>
        <View style={styles.notFoundActions}>
          <Focusable hasTVPreferredFocus onPress={() => navigation.navigate('Search')} pill style={styles.playButton}>
            <Text style={styles.playButtonText}>Go to Search</Text>
          </Focusable>
          <Focusable onPress={() => navigation.goBack()} pill style={styles.sourcesButton}>
            <Text style={styles.sourcesButtonText}>Back</Text>
          </Focusable>
        </View>
      </View>
    );
  }

  const episodes = info.videos ?? [];
  const seasons = [...new Set(episodes.map(v => v.season))].sort(bySeasonOrder);
  const season = activeSeason ?? seasons[0] ?? null;
  const isSeries = type === 'series' && seasons.length > 0;
  seasonNavRef.current = { seasons, season };

  // Cinemeta's own genre list is the only signal available here — no
  // structured "is this anime" flag exists — but it's what gates whether an
  // untagged release gets assumed Japanese-audio in streamSelection.ts, so
  // it has to travel with every play/resume/next-episode navigation from
  // this point on.
  const isAnime = Boolean(info.genres?.includes('Animation'));

  const seasonEpisodes = episodes.filter(v => v.season === season);
  const episodeKeyExtractor = (v: Episode) => v.id;
  const renderEpisode = ({ item, index }: { item: Episode; index: number }) => (
    <EpisodeCard
      video={item}
      seriesName={info.name}
      fallbackImage={info.background ?? info.poster}
      hasTVPreferredFocus={index === 0}
      onPress={() => playEpisode(item)}
    />
  );

  // Neither of these resolves anything itself any more — Player does that,
  // walking every source in language/resolution priority order and showing
  // progress as it goes, which is what replaced the old "jump straight to
  // the Sources list" behavior for both movies and episodes.
  const playEpisode = (video: Episode) => {
    navigation.navigate('Player', {
      id: video.id,
      type,
      title: `${info.name} S${video.season}E${video.episode}`,
      poster: info.poster,
      background: info.background,
      isAnime,
      episodeThumbnail: video.thumbnail,
      episodeLabel: `S${video.season}E${video.episode}`,
    });
  };

  const playMovie = () => {
    navigation.navigate('Player', {
      id,
      type,
      title: info.name,
      poster: info.poster,
      background: info.background,
      isAnime,
    });
  };

  const metaLine = [
    info.year,
    info.runtime,
    info.genres?.slice(0, 2).join(', '),
    info.imdbRating ? `★ ${info.imdbRating}` : undefined,
  ]
    .filter(Boolean)
    .join('  ·  ');

  // Header (art, title, description, season tabs) is FIXED; only the episode
  // list scrolls. Previously the whole page was one ScrollView, so browsing
  // episodes scrolled the title and season tabs off the top — you lost track
  // of which show and which season you were even in.
  return (
    <View style={styles.page}>
      {info.background && (
        <Image source={{ uri: info.background }} style={styles.backdrop} resizeMode="cover" />
      )}
      <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: BACKDROP_SCRIM_VERTICAL }]} pointerEvents="none" />
      <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: BACKDROP_SCRIM }]} pointerEvents="none" />

      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Focusable
            hasTVPreferredFocus={!isSeries}
            onPress={() => navigation.goBack()}
            pill
            style={styles.backButton}>
            <Text style={styles.backIcon}>‹</Text>
          </Focusable>

          {info.poster && <Image source={{ uri: info.poster }} style={styles.poster} resizeMode="cover" />}

          <View style={styles.infoCol}>
            <Text style={styles.title} numberOfLines={2}>
              {info.name}
            </Text>
            {metaLine.length > 0 && <Text style={styles.metaLine}>{metaLine}</Text>}
            {info.description && (
              <Text style={styles.description} numberOfLines={3}>
                {info.description}
              </Text>
            )}
            {info.cast && info.cast.length > 0 && (
              <Text style={styles.castLine} numberOfLines={1}>
                Starring {info.cast.slice(0, 3).join(', ')}
              </Text>
            )}

            {type === 'movie' && (
              <View style={styles.actionsRow}>
                <Focusable hasTVPreferredFocus onPress={playMovie} pill style={styles.playButton}>
                  <Text style={styles.playButtonText}>▸  Play</Text>
                </Focusable>
              </View>
            )}
          </View>
        </View>

        {isSeries && (
          <>
            {/* Plain Views — deliberately not focusable. These are a readout
                of which season you're on, driven by left/right on the episode
                list above; making them focusable would put a row of tab stops
                between the header and the episodes for no benefit. */}
            <View style={styles.seasonTabs}>
              {seasons.map(s => (
                <View key={s} style={styles.seasonTab}>
                  <Text style={[styles.seasonTabText, s === season && styles.seasonTabTextActive]}>{seasonLabel(s)}</Text>
                  <View style={[styles.seasonTabUnderline, s === season && styles.seasonTabUnderlineActive]} />
                </View>
              ))}
              {seasons.length > 1 && <Text style={styles.seasonHint}>‹ ›  to switch</Text>}
            </View>

            {/* A FlatList, not a ScrollView of .map()s: a long season is 25+
                cards each holding a decoded still, and mapping them all
                built and kept every one of them. Windowed, only what's near
                the viewport is realised. */}
            <FlatList
              style={styles.episodeScroll}
              data={seasonEpisodes}
              keyExtractor={episodeKeyExtractor}
              showsVerticalScrollIndicator={false}
              initialNumToRender={6}
              maxToRenderPerBatch={5}
              updateCellsBatchingPeriod={60}
              windowSize={5}
              removeClippedSubviews
              contentContainerStyle={styles.episodeList}
              renderItem={renderEpisode}
            />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
  },
  notFoundTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  notFoundBody: {
    color: colors.textDim,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginTop: spacing.sm,
    maxWidth: 620,
  },
  notFoundActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },

  // Full-bleed art behind everything, not a banner occupying the top third.
  backdrop: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },

  content: { flex: 1, paddingHorizontal: spacing.xl, paddingTop: spacing.lg },

  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
    flexShrink: 0,
  },
  backIcon: { color: colors.text, fontSize: 24, marginLeft: -2 },
  poster: { width: 104, height: 156, borderRadius: radius.md, backgroundColor: colors.glass, flexShrink: 0 },
  infoCol: { flex: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.3 },
  metaLine: { color: colors.textDim, fontSize: 14, fontWeight: '600', marginTop: 2 },
  description: { color: colors.textDim, fontSize: 14, lineHeight: 20, marginTop: spacing.xs, maxWidth: 720 },
  castLine: { color: colors.textFaint, fontSize: 12, fontWeight: '600', marginTop: 4 },

  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  playButton: {
    backgroundColor: colors.cta,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minWidth: 100,
    alignItems: 'center',
  },
  playButtonText: { color: colors.ctaText, fontSize: 15, fontWeight: '800' },
  sourcesButton: { backgroundColor: colors.glass, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  sourcesButtonText: { color: colors.text, fontSize: 14, fontWeight: '700' },

  seasonTabs: {
    flexDirection: 'row',
    gap: spacing.lg,
    borderBottomWidth: 2,
    borderBottomColor: 'rgba(255,255,255,0.1)',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  seasonTab: { paddingBottom: spacing.xs },
  seasonHint: { color: colors.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginLeft: 'auto', paddingBottom: spacing.xs },
  seasonTabText: { color: 'rgba(255,255,255,0.45)', fontSize: 15, fontWeight: '700' },
  seasonTabTextActive: { color: colors.text },
  seasonTabUnderline: { height: 2, backgroundColor: 'transparent', marginTop: spacing.xs },
  seasonTabUnderlineActive: { backgroundColor: colors.accent },

  // Only this scrolls — the header above it stays put.
  episodeScroll: { flex: 1 },
  episodeList: { gap: spacing.sm, paddingBottom: spacing.xl, paddingTop: spacing.xs },

  // Sized so more than two episodes are on screen at once — the thumbnail
  // drives the row height, so it's the thing that had to come down.
  episodeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.md,
    padding: spacing.xs,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  // No glow(): same reasoning as the player's menu rows — on a box this wide
  // the shadow floods the whole card instead of tracing its edge.
  episodeCardFocused: { borderColor: colors.accent, backgroundColor: colors.glassFocused },
  episodeThumbWrap: { flexShrink: 0 },
  episodeThumb: { width: 124, height: 70, borderRadius: radius.sm, backgroundColor: colors.glass },
  episodeThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  episodeThumbEmptyText: { color: colors.textFaint, fontSize: 17, fontWeight: '800' },
  episodeBody: { flex: 1 },
  episodeHeading: { color: colors.text, fontSize: 14, fontWeight: '700' },
  episodeMetaRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 1 },
  episodeMeta: { color: colors.textFaint, fontSize: 11, fontWeight: '600' },
  episodeSummary: { color: colors.textDim, fontSize: 12, lineHeight: 16, marginTop: 3 },
  episodeSummaryMissing: { color: colors.textFaint, fontSize: 12, fontStyle: 'italic', marginTop: 3 },
  episodeChevron: { color: colors.textFaint, fontSize: 18, flexShrink: 0 },
});
