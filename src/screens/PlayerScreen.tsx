import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, BackHandler, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { VideoPlayer, KeplerVideoView } from '@amazon-devices/react-native-w3cmedia';
import { TVFocusGuideView, useTVEventHandler } from '@amazon-devices/react-native-kepler';
import { Focusable } from '../components/Focusable';
import { IconChevronLeft, IconSubtitles } from '../components/PlayerIcons';
import { streams as fetchStreams, meta as fetchMeta, parseReleaseInfo } from '../addons/client';
import {
  fetchSrtCues,
  fetchSubtitles,
  pickSubtitleSet,
  subtitleLangLabel,
  subtitleVariantLabel,
  type SrtCue,
  type SrtSegment,
} from '../addons/subtitles';
import {
  LANGUAGE_LABELS,
  availableLanguages,
  availableResolutions,
  detectAudioLanguage,
  orderCandidates,
  resolveFirstWorking,
  type AudioLanguage,
  type ResolveAttempt,
} from '../addons/streamSelection';
import { getSkipTimes, type SkipTimes } from '../addons/skipTimes';
import { MkvMseSession } from '../player/mkvMse';
import { getHistorySync, recordWatched, resumePositionFor, saveProgress } from '../storage/history';
import {
  DELAY_STEP,
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_SIZES,
  getSubtitleDelaySync,
  getSubtitleLangSync,
  getSubtitleStyleSync,
  saveSubtitleDelay,
  saveSubtitleLang,
  saveSubtitleStyle,
  type SubtitleStyle,
} from '../storage/subtitlePrefs';
import { colors, radius, spacing } from '../theme';
import type { NativeStackScreenProps } from '@amazon-devices/react-navigation__native-stack';
import type { RootStackParamList, Stream, Subtitle } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

// Native AudioTrackList/TextTrackList are DEAD on this platform for
// progressive URL playback — confirmed empirically on real hardware (device
// log, `audioTracks.length`/`textTracks.length` logged on every poll across
// five different files): zero entries, the entire time, regardless of how
// many audio/subtitle tracks the source actually has. Not a JS enumeration
// bug to work around — there's no track data on this path at all. Polling
// and subscribing to these lists was previously left in "in case a future
// SDK build populates them", but touching a native track list while the
// player is mid-teardown (which happens now on every source skip/switch) is
// a plausible native crash source, so it's gone rather than kept dark.
// Subtitles are external-only (OpenSubtitles), parsed and rendered by us —
// see `subtitleTracks`/`cueSegments` below — which was never affected by
// this gap since it never touches the native list either.
type SubtitleTrackEntry = {
  key: string;
  lang: string;
  label: string;
  // Release name, shown only when a language has multiple entries.
  variant?: string;
  cues: SrtCue[];
};

// Which pane of the track panel is showing. Each gets its own screen so no
// list has to be truncated to fit beside another.
type TrackPane = 'main' | 'language' | 'appearance' | 'resolution' | 'sourceLanguage';

// What the "next episode" flow carries forward — richer than the bare
// {id, title} that arrives via route params, since the derived lookup below
// has the full Cinemeta episode record to pull a label/thumbnail from.
type NextTarget = { id: string; title: string; episodeLabel?: string; thumbnail?: string };

const SEEK_SECONDS = 10;
// How long to keep collecting presses before committing one real seek. Long
// enough that a burst of taps becomes a single jump, short enough that one
// tap still feels immediate.
const SEEK_COMMIT_MS = 400;
// Grace period after committing before the position poll takes over again,
// so the scrub bar doesn't snap back to the old spot while the element is
// still moving.
const SEEK_SETTLE_MS = 1200;
// How much runtime has to remain after the ending interval before skipping
// it is worth offering. Below this the credits ARE the end of the episode,
// so "next episode" is the useful action instead.
const ENDING_TAIL_MIN_SEC = 30;
// How long a source gets to actually start moving before the walk gives up
// on it. Generous enough to cover a slow debrid link warming up, short
// enough that a dead source doesn't hold the screen black.
const PLAYBACK_WATCHDOG_MS = 15000;
const IDLE_HIDE_MS = 4000;
const FADE_MS = 200;
// How often the active cue is recomputed. Fine-grained enough that subtitle
// changes land with the dialogue, coarse enough not to re-render constantly
// — and it only sets state when the visible text actually changes.
const CUE_TICK_MS = 150;

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Real MediaError, not a guessed string — the old hardcoded "unsupported
// codec or container" message was actively wrong: HEVC/MKV both play fine on
// real hardware, and this same text was showing for e.g. a bad subtitle URI.
function describeMediaError(err: { code: number; message?: string } | null | undefined): string {
  if (!err) return 'Playback failed for an unknown reason.';
  const names: Record<number, string> = {
    1: 'Playback aborted',
    2: 'Network error',
    3: 'Decode error',
    4: 'Source not supported',
  };
  const name = names[err.code] ?? `Playback error ${err.code}`;
  return err.message ? `${name}: ${err.message}` : name;
}

// Real CSS gradient (RN 0.83's `experimental_backgroundImage`) instead of a
// stack of semi-transparent Views — the stacked layers rendered as visible
// opacity bands, not a smooth fade.
function EdgeScrim({ position }: { position: 'top' | 'bottom' }) {
  // Many stops on an ease-out curve rather than three on a straight ramp.
  // A linear fade over a short band still has a visible edge where it meets
  // the video — the eye picks up the sudden change in slope, which is what
  // made these read as a flat black bar with a hard boundary.
  //
  // The tail is the part that matters and the part that was wrong: the old
  // ramp was still at ~6% opacity at 84% and then jumped to transparent, so
  // the fade visibly "cut" instead of finishing. The stops below spend the
  // whole back half of the band easing through very low alphas (0.10 →
  // 0.06 → 0.03 → 0.015 → 0.005 → 0), which is below the threshold where a
  // step between neighbouring stops is perceptible, so the gradient lands
  // on fully transparent without an edge. Written as explicit rgba(0,0,0,0)
  // rather than the `transparent` keyword to keep the interpolation in the
  // same colour space as every other stop.
  const gradient =
    position === 'top'
      ? 'linear-gradient(180deg, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.80) 10%, rgba(0,0,0,0.66) 22%, rgba(0,0,0,0.50) 34%, rgba(0,0,0,0.35) 46%, rgba(0,0,0,0.22) 58%, rgba(0,0,0,0.13) 69%, rgba(0,0,0,0.07) 79%, rgba(0,0,0,0.03) 87%, rgba(0,0,0,0.012) 93%, rgba(0,0,0,0.004) 97%, rgba(0,0,0,0) 100%)'
      : 'linear-gradient(0deg, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.85) 10%, rgba(0,0,0,0.72) 22%, rgba(0,0,0,0.56) 34%, rgba(0,0,0,0.40) 46%, rgba(0,0,0,0.26) 58%, rgba(0,0,0,0.15) 69%, rgba(0,0,0,0.08) 79%, rgba(0,0,0,0.035) 87%, rgba(0,0,0,0.014) 93%, rgba(0,0,0,0.005) 97%, rgba(0,0,0,0) 100%)';
  return (
    <View
      style={[
        styles.scrimWrap,
        position === 'top' ? styles.scrimTop : styles.scrimBottom,
        { experimental_backgroundImage: gradient },
      ]}
      pointerEvents="none"
    />
  );
}

// Panel rows need their own focus treatment rather than Focusable's default.
// The default scales the whole pressable by 1.04, which on a row that already
// spans the panel's full width pushes its left and right edges past the
// panel and clips the ring to just the top and bottom strips. It also applies
// the standard glow, which on a box this large stops reading as a glow and
// just fills the row. So: no scale, no glow, a plain inset ring plus a lift
// in background — and horizontal margin so even the ring has room to breathe.
// The supplied transport artwork is solid black on transparency, so it's
// tinted at render time rather than shipped in two colours: white normally,
// the accent ice blue on focus. That tint IS the focus signature here — no
// ring, no circle, no scale — which is what keeps a row of large glyphs from
// looking like a row of buttons.
const TRANSPORT_ICONS = {
  play: require('../assets/play.png'),
  pause: require('../assets/pause.png'),
  next: require('../assets/next.png'),
  // One asset serves both directions: rewind is the same glyph mirrored, so
  // the pair can never drift apart visually.
  seek: require('../assets/right.png'),
};

function TransportButton({
  icon,
  size = 34,
  flip,
  onPress,
  hasTVPreferredFocus,
}: {
  icon: keyof typeof TRANSPORT_ICONS;
  size?: number;
  flip?: boolean;
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      bare
      onPress={onPress}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={styles.transportButton}>
      <Image
        source={TRANSPORT_ICONS[icon]}
        resizeMode="contain"
        style={[
          { width: size, height: size, tintColor: focused ? colors.accent : '#fff' },
          flip && styles.flipped,
        ]}
      />
    </Focusable>
  );
}

// Same focus signature as the transport glyphs — the icon itself changes
// colour rather than gaining a ring — so the whole control row reads as one
// set rather than two different button styles.
function SubtitlesButton({ onPress }: { onPress: () => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      bare
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={styles.transportButton}>
      <IconSubtitles size={20} color={focused ? colors.accent : '#fff'} />
    </Focusable>
  );
}

function MenuRow({
  onPress,
  hasTVPreferredFocus,
  children,
}: {
  onPress: () => void;
  hasTVPreferredFocus?: boolean;
  children: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      bare
      onPress={onPress}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[styles.trackRow, focused && styles.trackRowFocused]}>
      {children}
    </Focusable>
  );
}

export function PlayerScreen({ route, navigation }: Props) {
  const {
    title,
    id,
    type,
    isAnime: isAnimeParam,
    preferredLanguage,
    preferredResolution,
    poster,
    background,
    releaseLabel,
    nextEpisode,
    episodeThumbnail,
    episodeLabel,
  } = route.params;
  const isAnime = Boolean(isAnimeParam);
  // `title` is the episode's display title ("Attack on Titan S1E1"); the
  // series name on its own is what history stores and what the AniList
  // lookup searches for.
  const seriesName =
    episodeLabel && title.endsWith(episodeLabel) ? title.slice(0, -episodeLabel.length).trim() : title;

  const playerRef = useRef<VideoPlayer | undefined>(undefined);
  // Set only when the current source is being played through the MSE path
  // (see mkvMse.ts) instead of a direct `.src` assignment — null means the
  // ordinary progressive-URL path is active, which is the common case for
  // any source with an MP4 alternative.
  const mseSessionRef = useRef<MkvMseSession | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [barFocused, setBarFocused] = useState(false);
  const [showTracks, setShowTracks] = useState(false);
  const [subtitlesLoading, setSubtitlesLoading] = useState(false);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackEntry[]>([]);
  const [activeSubtitleKey, setActiveSubtitleKey] = useState<string | null>(null);
  const [pane, setPane] = useState<TrackPane>('main');

  // Style is global (a readability preference about this TV); delay is
  // per-show and seeded from whatever was set last time — which is what makes
  // it carry across to the next episode without being re-dialled.
  const [subStyle, setSubStyle] = useState<SubtitleStyle>(() => getSubtitleStyleSync());
  const [delay, setDelay] = useState<number>(() => getSubtitleDelaySync(id));
  // Segments, not a flat string — that's what makes <i>/<b>/<u> render as
  // actual styling instead of showing the literal tag characters. Reference
  // equality is enough for the change check below: repeated lookups of the
  // SAME cue return the SAME segments array, since it's computed once at
  // parse time and stored on the cue.
  const [cueSegments, setCueSegments] = useState<SrtSegment[] | null>(null);

  // Controls auto-hide, like any real streaming app: visible by default,
  // fades out after idle while playing, comes back on any remote input.
  // `controlsMounted` trails `controlsVisible` by one fade so the chrome can
  // animate out smoothly, but — critically — is what actually gates
  // rendering. Hiding via opacity/pointerEvents alone isn't enough: TV focus
  // navigation doesn't route through pointerEvents, so an invisible-but-
  // mounted button could still eat the next "select" press instead of that
  // press just revealing the UI again. Fully unmounting closes that gap.
  const [controlsVisible, setControlsVisible] = useState(true);
  const [controlsMounted, setControlsMounted] = useState(true);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const [activityTick, setActivityTick] = useState(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seekBurstRef = useRef<{ dir: 'left' | 'right' | null; count: number; lastTs: number }>({ dir: null, count: 0, lastTs: 0 });

  const bumpActivity = useCallback(() => {
    setControlsVisible(true);
    setActivityTick(t => t + 1);
  }, []);

  // TEMPORARY diagnostic: does this platform's MediaSource actually accept
  // video/x-matroska, or does the JS-side MimeTypeRegistry just claim it
  // does without the native pipeline backing it up? Remove after checking.
  useEffect(() => {
    try {
      const MS = require('@amazon-devices/react-native-w3cmedia').MediaSource;
      const results = [
        'video/x-matroska; codecs="avc1.640028"',
        'video/x-matroska; codecs="avc1.640028,mp4a.40.2"',
        'video/x-matroska; codecs="hev1.1.6.L93.90"',
        'video/x-matroska',
      ].map(t => `${t} => ${MS?.isTypeSupported?.(t)}`);
      console.warn('MSEDIAG ' + results.join(' | '));
    } catch (e) {
      console.warn('MSEDIAG threw', String(e));
    }
  }, []);

  // --- Source resolution -----------------------------------------------
  // Every source for this id/type is fetched once, bucketed by audio
  // language and resolution (streamSelection.ts), and walked in priority
  // order until one actually resolves — this is what replaced the old
  // "jump to the Sources list" flow for every entry path except a manual
  // pick from that list (which arrives here with `streamUrl` already set).
  const [allStreams, setAllStreams] = useState<Stream[]>([]);
  const [streamsLoading, setStreamsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetchStreams(type, id)
      .then(s => !cancelled && setAllStreams(s))
      .catch(() => {})
      .finally(() => !cancelled && setStreamsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, type]);

  // What the Resolution/Audio Language menu picks override to — seeded from
  // Continue Watching/next-episode's remembered preference where present.
  const [userLanguage, setUserLanguage] = useState<AudioLanguage | undefined>(preferredLanguage);
  const [userResolution, setUserResolution] = useState<string | undefined>(preferredResolution);
  const candidates = useMemo(
    () => orderCandidates(allStreams, isAnime, { language: userLanguage, resolution: userResolution }),
    [allStreams, isAnime, userLanguage, userResolution],
  );
  const langOptions = useMemo(() => availableLanguages(allStreams, isAnime), [allStreams, isAnime]);
  const resOptions = useMemo(() => availableResolutions(allStreams), [allStreams]);

  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(undefined);
  const [resolvedStream, setResolvedStream] = useState<Stream | undefined>(undefined);
  const [resolveFailed, setResolveFailed] = useState(false);
  const [attempt, setAttempt] = useState<ResolveAttempt | null>(null);
  // Streams already tried this "session" — carries across a skip so the walk
  // never re-offers something that just failed or was flagged as wrong.
  const excludedRef = useRef<Set<Stream>>(new Set());
  const autoResolveStartedRef = useRef(false);

  // Tears down everything tied to the CURRENT source so a new one (skip, or
  // a Resolution/Language pick) can load clean. Deliberately leaves external
  // subtitle tracks alone — they come from OpenSubtitles, not the video
  // source, and stay valid across a switch; only an embedded track dies with
  // the player instance that surfaced it.
  const resetForNewSource = useCallback(() => {
    setResolvedUrl(undefined);
    setReady(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setCueSegments(null);
    // Subtitles are external-only and independent of the video source, so
    // the active pick survives a skip/resolution switch untouched.
  }, []);

  const runResolve = useCallback(async (list: Stream[]) => {
    if (list.length === 0) {
      setResolveFailed(true);
      return;
    }
    setResolveFailed(false);
    setAttempt(null);
    const result = await resolveFirstWorking(list, a => setAttempt(a));
    if (!result) {
      setResolveFailed(true);
      return;
    }
    excludedRef.current.add(result.stream);
    setResolvedStream(result.stream);
    setResolvedUrl(result.finalUrl);
  }, []);

  // Kicks off automatically once the stream list is in, for every entry path
  // except a manual Sources pick (which arrives already resolved).
  useEffect(() => {
    if (autoResolveStartedRef.current || streamsLoading) return;
    autoResolveStartedRef.current = true;
    runResolve(candidates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamsLoading]);

  // Drop the current release and try the next one down the same priority
  // order. Two callers: the "wrong video" menu button, and the playback
  // failure paths below — a source that resolves but won't actually decode
  // is just a failed candidate, so it re-enters the same walk rather than
  // dead-ending on an error screen. When nothing is left, runResolve sets
  // resolveFailed and the error screen is finally the right answer.
  const skipCurrentSource = useCallback(() => {
    if (resolvedStream) excludedRef.current.add(resolvedStream);
    const remaining = candidates.filter(s => !excludedRef.current.has(s));
    resetForNewSource();
    runResolve(remaining);
  }, [resolvedStream, candidates, resetForNewSource, runResolve]);

  // The media element's listeners are registered once per source and capture
  // the render that created them; this keeps them pointed at the current
  // skip function instead of a stale one.
  const skipRef = useRef(skipCurrentSource);
  useEffect(() => {
    skipRef.current = skipCurrentSource;
  }, [skipCurrentSource]);

  // Resolution/Language menu picks: re-walk from a clean slate with the new
  // preference pinned first, same fallback behavior as the initial load.
  const selectResolution = useCallback(
    (res: string) => {
      setUserResolution(res);
      const list = orderCandidates(allStreams, isAnime, { language: userLanguage, resolution: res });
      excludedRef.current = new Set();
      resetForNewSource();
      runResolve(list);
      setPane('main');
      setShowTracks(false);
    },
    [allStreams, isAnime, userLanguage, resetForNewSource, runResolve],
  );
  const selectSourceLanguage = useCallback(
    (lang: AudioLanguage) => {
      setUserLanguage(lang);
      const list = orderCandidates(allStreams, isAnime, { language: lang, resolution: userResolution });
      excludedRef.current = new Set();
      resetForNewSource();
      runResolve(list);
      setPane('main');
      setShowTracks(false);
    },
    [allStreams, isAnime, userResolution, resetForNewSource, runResolve],
  );

  // Subtitles come from OpenSubtitles and are keyed to the title, not to the
  // release being played — so they're fetched once here and survive every
  // source switch untouched.
  const [loadedSubtitles, setLoadedSubtitles] = useState<Subtitle[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    fetchSubtitles(type, id)
      .then(s => !cancelled && setLoadedSubtitles(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, type]);

  useEffect(() => {
    if (!resolvedUrl) return;
    let cancelled = false;
    // Scoped to this source: the effect re-runs per source, so these reset
    // naturally on every switch.
    let failedOver = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const p = new VideoPlayer();
    playerRef.current = p;
    mseSessionRef.current = null;

    p.initialize()
      .then(async () => {
        if (cancelled) return;

        // Any failure for THIS source hands back to the candidate walk. The
        // guard makes it one-shot: a dying element can fire 'error' several
        // times, and each extra call would burn another perfectly good
        // candidate without ever trying it.
        const failThisSource = (why: string) => {
          if (cancelled || failedOver) return;
          failedOver = true;
          if (watchdog !== undefined) clearTimeout(watchdog);
          console.warn('PlayerScreen: source failed, advancing —', why);
          skipRef.current();
        };

        p.addEventListener?.('error', () => {
          failThisSource(describeMediaError((p as any).error));
        });

        // MKV sources get one attempt through the MSE path first — the only
        // way this platform's native pipeline can seek Matroska reliably
        // (see mkvMse.ts for the full story). A source with no video track
        // MSE can play, or whose codecs this platform's MSE doesn't
        // support, or that errors while probing, all fall straight through
        // to the exact same direct-URL `.src` assignment used for
        // everything else — MSE is strictly additive, never a hard
        // dependency for playback to start.
        const isMkv = resolvedStream ? parseReleaseInfo(resolvedStream).container === 'MKV' : false;
        let mseReady = false;
        if (isMkv) {
          const session = new MkvMseSession(resolvedUrl);
          try {
            mseReady = await session.prepare(p as any, () => {
              const el = playerRef.current as any;
              return typeof el?.currentTime === 'number' ? el.currentTime : 0;
            });
          } catch (e) {
            console.warn('MkvMseSession: prepare threw, falling back to direct URL —', e);
            mseReady = false;
          }
          if (mseReady && !cancelled) {
            mseSessionRef.current = session;
          } else {
            session.dispose();
          }
        }
        if (cancelled) return;

        // Guard the src assignment: the known failure mode on an unsupported
        // codec/container is a crash, not a clean error event.
        try {
          if (!mseReady) p.src = resolvedUrl;
        } catch (e) {
          failThisSource(String(e));
          return;
        }

        if (cancelled) return;
        setReady(true);
        try {
          await p.play();
          setPlaying(true);

          // A source can pass every pre-flight check, start "playing", and
          // still never decode a frame — the position just sits at zero
          // until it eventually errors out. Rather than let the user stare
          // at a black screen waiting for that, give it a bounded window to
          // prove it is actually moving and treat silence as a failure.
          watchdog = setTimeout(() => {
            const el = playerRef.current as any;
            const pos = typeof el?.currentTime === 'number' ? el.currentTime : 0;
            if (pos <= 0) failThisSource('no playback progress');
          }, PLAYBACK_WATCHDOG_MS);

          // Resume where this episode was left off.
          //
          // The timing here is not cosmetic — getting it wrong breaks
          // seeking for the entire session, which is what "forward works in
          // movies but not series" turned out to be. Series carry a saved
          // position and movies (in practice) don't, so only series ran this
          // path. The old guard let the write through at readyState >= 1,
          // milliseconds after play(), while the native pipeline was still
          // coming up. That seek failed (`Seek failed. Internal error 0` /
          // `MPB Call failed with code: 50004`) and left the media element
          // permanently unable to seek: every later seek on that same
          // instance failed too, and only creating a NEW player instance
          // (which a source switch happens to do) restored it — visible in
          // the device log as failing seeks on [0xac814800] and working ones
          // on [0xad6513e0].
          //
          // So: wait for a pipeline that is genuinely ready to seek —
          // readyState >= 4 (HAVE_ENOUGH_DATA) AND actually advancing — then
          // commit through the normal single-write path (seekTo). This wait
          // is scoped to resume ONLY: seekTo/commitSeek themselves do not
          // gate on readiness any more, because that gate was tried here
          // once already and, when applied to every seek instead of just
          // this one, silently swallowed ordinary interactive seeks during
          // any brief buffering dip — which anime sources hit far more
          // often. This loop is self-contained specifically so that mistake
          // can't recur: it owns its own retry, and every other seek in the
          // screen is a bare, ungated write.
          const seriesKey = type === 'series' ? id.split(':')[0] : id;
          const entry = getHistorySync().find(h => h.id === seriesKey);
          const resumeAt = entry ? resumePositionFor(entry) : 0;
          if (resumeAt > 0) {
            let attempts = 0;
            const tryResume = () => {
              // Bail the moment the user takes over, so a resume can't yank
              // playback back from wherever they just sent it.
              if (cancelled || seekTargetRef.current !== null) return;
              const el = p as any;
              const rs = typeof el.readyState === 'number' ? el.readyState : 0;
              const pos = typeof el.currentTime === 'number' ? el.currentTime : 0;
              // Give up rather than seek into a pipeline that never got
              // healthy — starting from the beginning is a far better
              // outcome than poisoning the element with a doomed write.
              if (attempts++ > 40) return;
              if (rs < 4 || pos <= 0) {
                setTimeout(tryResume, 250);
                return;
              }
              seekTo(resumeAt);
            };
            // Even once readyState says it is ready, give the pipeline a
            // beat to settle before asking it to move.
            setTimeout(tryResume, 800);
          }
          // History entries navigate back to Detail on press, which needs the
          // base series id — episode ids (`tt0903747:1:1`) aren't resolvable
          // via Cinemeta's meta endpoint. Movies have no episode suffix.
          const historyId = type === 'series' ? id.split(':')[0] : id;
          // `title` here is the episode's display title ("Attack on Titan
          // S1E1"). History stores the series name on its own, with the
          // episode carried separately in episodeLabel — otherwise the
          // Continue Watching card renders "S1E1" twice, once baked into the
          // title and once as its own line.
          recordWatched({
            id: historyId,
            type,
            name: seriesName,
            poster,
            background,
            episodeThumbnail,
            episodeLabel,
            // Remembered so Continue Watching can resume this exact episode,
            // preferring the same language/resolution bucket without pinning
            // to this exact release — see types.ts.
            episodeId: id,
            isAnime,
            lastLanguage: resolvedStream ? detectAudioLanguage(resolvedStream, isAnime) : userLanguage,
            lastResolution: resolvedStream ? parseReleaseInfo(resolvedStream).resolution : userResolution,
          }).catch(() => {});
        } catch (e) {
          failThisSource(String(e));
        }
      })
      // A failure to construct the player at all is not the source's fault
      // and retrying other candidates would hit the same wall.
      .catch(e => !cancelled && setError(`Player failed to initialize: ${String(e)}`));

    return () => {
      cancelled = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      mseSessionRef.current?.dispose();
      mseSessionRef.current = null;
      playerRef.current?.pause?.();
      playerRef.current?.deinitialize?.().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedUrl]);

  // Cue fetching only needs the subtitle list, not a live player, so it's
  // independent of the video-init effect above and survives a mid-playback
  // source switch (skip, or a Resolution/Language pick) untouched.
  useEffect(() => {
    if (!loadedSubtitles?.length) {
      setSubtitlesLoading(false);
      return;
    }
    let cancelled = false;
    setSubtitlesLoading(true);
    const set = pickSubtitleSet(loadedSubtitles);
    Promise.allSettled(set.map(sub => fetchSrtCues(sub).then(cues => ({ sub, cues })))).then(results => {
      if (cancelled) return;
      const entries: SubtitleTrackEntry[] = [];
      for (const r of results) {
        if (r.status !== 'fulfilled' || r.value.cues.length === 0) continue;
        const { sub, cues } = r.value;
        entries.push({
          key: `ext:${sub.id}`,
          lang: sub.lang,
          label: subtitleLangLabel(sub.lang),
          variant: subtitleVariantLabel(sub),
          cues,
        });
      }
      setSubtitleTracks(entries);
      setSubtitlesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadedSubtitles]);

  // Poll rather than depend on 'timeupdate'/'loadedmetadata' event names we
  // haven't confirmed fire on this platform — matches how canPlayType/
  // addTextTrack were verified empirically rather than assumed from the spec.
  useEffect(() => {
    if (!ready) return;
    const iv = setInterval(() => {
      const p = playerRef.current as any;
      if (!p) return;
      // While a seek is pending the element still reports the OLD position,
      // so adopting it here would drag the scrub bar back from where the
      // user just sent it. The reconciler owns the position until it lands.
      if (seekTargetRef.current === null && typeof p.currentTime === 'number') setCurrentTime(p.currentTime);
      if (typeof p.duration === 'number' && isFinite(p.duration)) setDuration(p.duration);
    }, 500);
    return () => clearInterval(iv);
  }, [ready]);

  // Bookmark the position every few seconds while playing. Writes are keyed
  // to the episode actually on screen, and skipped when paused so a paused
  // player doesn't rewrite the same value forever.
  useEffect(() => {
    if (!ready || !playing) return;
    const seriesKey = type === 'series' ? id.split(':')[0] : id;
    const iv = setInterval(() => {
      const p = playerRef.current as any;
      const pos = typeof p?.currentTime === 'number' ? p.currentTime : 0;
      const dur = typeof p?.duration === 'number' && isFinite(p.duration) ? p.duration : 0;
      if (pos > 0 && dur > 0) saveProgress(seriesKey, id, pos, dur).catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, [ready, playing, id, type]);

  // Drives the subtitle overlay. `delay` shifts the lookup rather than the
  // cues themselves, so changing it is instant and lossless — positive delay
  // means "show this later", i.e. compare against a correspondingly earlier
  // playback position. Only sets state when the visible line actually
  // changes, so this ticks often without re-rendering often.
  const activeCues = subtitleTracks.find(t => t.key === activeSubtitleKey)?.cues;
  useEffect(() => {
    if (!ready || !activeCues) {
      setCueSegments(null);
      return;
    }
    // Binary search, not a linear scan. Cues are time-ordered and a feature
    // film's track runs to a couple of thousand of them; find() walked the
    // list from the start on every tick, several times a second, for the
    // whole runtime.
    const findCue = (t: number): SrtCue | undefined => {
      let lo = 0;
      let hi = activeCues.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = activeCues[mid];
        if (t < c.start) hi = mid - 1;
        else if (t > c.end) lo = mid + 1;
        else return c;
      }
      return undefined;
    };

    const iv = setInterval(() => {
      const p = playerRef.current as any;
      const t = (typeof p?.currentTime === 'number' ? p.currentTime : 0) - delay;
      const next = findCue(t)?.segments ?? null;
      setCueSegments(prev => (prev === next ? prev : next));
    }, CUE_TICK_MS);
    return () => clearInterval(iv);
  }, [ready, activeCues, delay]);

  // Fade + mount/unmount the controls chrome as controlsVisible changes.
  useEffect(() => {
    if (controlsVisible) {
      setControlsMounted(true);
      Animated.timing(controlsOpacity, { toValue: 1, duration: FADE_MS, useNativeDriver: true }).start();
    } else {
      Animated.timing(controlsOpacity, { toValue: 0, duration: FADE_MS, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setControlsMounted(false);
      });
    }
  }, [controlsVisible, controlsOpacity]);

  // Idle-hide timer — suspended while paused, while the track panel is open,
  // or while actively scrubbing, and reset by any activity in between.
  useEffect(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (!controlsVisible || !playing || showTracks || barFocused) return;
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), IDLE_HIDE_MS);
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [controlsVisible, playing, showTracks, barFocused, activityTick]);

  // Seeking, modelled directly on the SDK's own MediaControls — which is the
  // only reference we have for what this platform actually accepts, and it
  // does two things the previous implementation here did not:
  //
  //   1. It PAUSES before writing currentTime and resumes afterwards.
  //   2. It writes currentTime exactly ONCE, at the end of the gesture.
  //
  // That second point is what was breaking seeking outright. This SDK emits
  // no 'seeking'/'seeked' events at all (checked across the whole dist), so
  // there is no completion signal to wait on — the old code compensated by
  // re-writing currentTime every 700ms until the position moved. Each write
  // restarts the native seek, so on any source that takes longer than that
  // to land, the seek was being cancelled and reissued forever and the
  // position never moved at all.
  //
  // So: accumulate presses into a target (which keeps rapid presses adding
  // up instead of all measuring from the same spot), show that target on the
  // scrub bar immediately so the UI stays responsive, and commit one real
  // seek once the presses stop.
  const seekTargetRef = useRef<number | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Extracted so both the direct-URL and MSE-gated paths in commitSeek below
  // go through the exact same write — see the comments there for why this
  // has to be a single bare `currentTime` write and nothing more.
  const doCommitWrite = (p: any, target: number) => {
    if (p) {
      // Bare write, no readiness gate here. A gate was added for a while
      // (wait for readyState >= 4 before writing, to protect against the
      // resume-seek pipeline-poisoning bug described in the init effect) but
      // it was a mistake to put it here: it applies to EVERY seek, and
      // ordinary interactive seeks happen during playback that is already
      // healthy — readyState legitimately dips below 4 during normal
      // buffering, which anime sources hit more often (smaller seeder
      // pools, less debrid caching). The gate silently swallowed those
      // seeks for a full 30s retry window and then gave up — zero seeks
      // ever reached the native pipeline, confirmed from a device log
      // showing minutes of live playback with no
      // `MediaPlayerPipelineImpl::seek` line at all. Only the resume path
      // actually needs to wait for readiness, and it does its own waiting
      // before ever calling seekTo — see the resume code below.
      try {
        // Nothing but the write. Do NOT pause/play around this.
        //
        // Wrapping the seek in pause()/play() was tried and is exactly what
        // broke seeking — confirmed from a device log. The native pipeline
        // queues these calls asynchronously, so issuing all three in one
        // synchronous tick meant the pause only reached the backend AFTER
        // play had been dispatched; the seek then executed against a
        // contradictory state and failed outright:
        //
        //   MediaElement::play(): Unhandelled pause by apps!!!
        //   isPlayerInSameState fetchState: 2 desiredState: 1
        //   seekWithRate  Seek failed. Internal error 0
        //   seek: MPB Call failed with code: 50004
        //
        // The SDK's own MediaControls does pause on slidingStart and
        // seek+play on slidingEnd — separate gestures, far apart in time,
        // not three calls in one tick. A bare write is what this pipeline
        // wants while playback is running.
        p.currentTime = target;
      } catch (e) {
        console.warn('PlayerScreen: seek failed', e, p?.error);
      }
    }
  };

  const commitSeek = useCallback(() => {
    const p = playerRef.current as any;
    const target = seekTargetRef.current;
    if (target === null) return;

    const writeAndSettle = () => {
      doCommitWrite(p, target);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => {
        seekTargetRef.current = null;
      }, SEEK_SETTLE_MS);
    };

    // MSE-backed sources need the SourceBuffer to actually have data
    // covering the target before the write below means anything — the
    // native pipeline only ever plays whatever we've already appended, it
    // never fetches or seeks the raw URL itself. Direct-URL sources (the
    // common case) skip straight to the same bare write as always.
    const mse = mseSessionRef.current;
    if (mse) {
      mse
        .prepareForSeek(target)
        .catch(e => console.warn('MkvMseSession: seek prep failed, writing anyway —', e))
        .finally(writeAndSettle);
      return;
    }
    writeAndSettle();
  }, []);

  // Absolute seek. Every seek in the screen funnels through here so they all
  // get the same single-write-after-a-pause-in-input treatment.
  const seekTo = useCallback(
    (absolute: number) => {
      const p = playerRef.current as any;
      if (!p) return;
      // Read duration off the element rather than from React state. The
      // state copy is refreshed by a 500ms poll, so right after load it is
      // still 0 — and clamping a forward seek against a stale/short duration
      // pins the target at or below the current position, which looks
      // exactly like "forward does nothing" while rewind works fine.
      const live = typeof p.duration === 'number' && isFinite(p.duration) ? p.duration : 0;
      // Leave a small margin off the end; seeking to exactly duration ends
      // playback instead of moving.
      const max = live > 0 ? live - 0.5 : Number.MAX_SAFE_INTEGER;
      const target = Math.max(0, Math.min(max, absolute));
      seekTargetRef.current = target;
      // Move the scrub bar now rather than waiting for the next poll. Without
      // this a burst of presses looks like nothing is happening, which is
      // what made a working-but-slow seek feel broken.
      setCurrentTime(target);

      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = setTimeout(commitSeek, SEEK_COMMIT_MS);
    },
    [commitSeek],
  );

  const seek = useCallback(
    (deltaSeconds: number) => {
      const p = playerRef.current as any;
      if (!p) return;
      bumpActivity();
      const cur = typeof p.currentTime === 'number' && isFinite(p.currentTime) ? p.currentTime : 0;
      // Base off the pending destination when one exists, so held/rapid
      // presses add up instead of all measuring from the same spot.
      seekTo((seekTargetRef.current ?? cur) + deltaSeconds);
    },
    [bumpActivity, seekTo],
  );

  useEffect(
    () => () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  const togglePlay = useCallback(async () => {
    const p = playerRef.current;
    if (!p) return;
    bumpActivity();
    try {
      if (playing) {
        p.pause();
        setPlaying(false);
      } else {
        await p.play();
        setPlaying(true);
      }
    } catch (e) {
      console.warn('PlayerScreen: togglePlay failed', e);
    }
  }, [playing, bumpActivity]);

  // Single global key handler: reveals controls on any input (even with
  // nothing mounted to focus), routes physical transport keys regardless of
  // what's focused, and — only while the progress bar itself has focus —
  // scrubs with press-and-hold acceleration (10s -> 30s -> 60s per burst).
  useTVEventHandler(evt => {
    if (evt.eventKeyAction === 1) return;

    // Back is not "activity". It used to fall through to bumpActivity(),
    // which set controlsVisible = true — so by the time the BackHandler below
    // ran, it saw visible controls and "dismissed" them instead of exiting.
    // The visible symptom was the chrome flashing on for a frame and the
    // press being swallowed. Let the BackHandler see the real state.
    if (evt.eventType === 'back' || evt.eventType === 'menu') return;

    bumpActivity();

    if (evt.eventType === 'playpause') {
      togglePlay();
      return;
    }
    if (evt.eventType === 'rewind' || evt.eventType === 'skip_backward') {
      seek(-SEEK_SECONDS);
      return;
    }
    if (evt.eventType === 'forward' || evt.eventType === 'skip_forward') {
      seek(SEEK_SECONDS);
      return;
    }

    if (!barFocused) return;
    if (evt.eventType !== 'left' && evt.eventType !== 'right') return;

    const now = Date.now();
    const burst = seekBurstRef.current;
    if (burst.dir === evt.eventType && now - burst.lastTs < 600) burst.count += 1;
    else {
      burst.dir = evt.eventType;
      burst.count = 1;
    }
    burst.lastTs = now;
    const step = burst.count >= 6 ? 60 : burst.count >= 3 ? 30 : SEEK_SECONDS;
    seek(evt.eventType === 'left' ? -step : step);
  });

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // The 3-level panel -> hide-controls -> exit flow only makes sense
      // once the player chrome actually exists. On the error screen (or
      // still loading/resolving) there's no controls UI rendered at all, so
      // `controlsVisible`'s default `true` would otherwise eat the first
      // Back press on a state nothing is displaying, forcing a second press
      // to actually leave.
      if (error || resolveFailed || !ready) {
        navigation.goBack();
        return true;
      }
      if (showTracks) {
        // Inside a submenu, Back returns to the menu it came from rather
        // than closing the whole panel.
        if (pane !== 'main') {
          setPane('main');
          return true;
        }
        setShowTracks(false);
        return true;
      }
      if (controlsVisible) {
        setControlsVisible(false);
        return true;
      }
      navigation.goBack();
      return true;
    });
    return () => sub.remove();
  }, [navigation, showTracks, pane, controlsVisible, error, resolveFailed, ready]);

  const allSubtitles = subtitleTracks;

  const selectSubtitle = (key: string | null) => {
    setCueSegments(null);

    if (key === null) {
      setActiveSubtitleKey(null);
      saveSubtitleLang(id, null).catch(() => {});
      return;
    }

    const entry = allSubtitles.find(e => e.key === key);
    if (!entry) return;

    setActiveSubtitleKey(key);
    saveSubtitleLang(id, entry.lang || null).catch(() => {});
  };

  // Re-apply the show's remembered subtitle language as soon as the tracks
  // for this episode are available. Without this, resuming — or rolling into
  // the next episode — started with subtitles off even though you'd had them
  // on all series, because the selection lived only in this screen's state.
  // Runs once per load; after that the user's in-session choice wins.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (subtitlesLoading || allSubtitles.length === 0) return;
    const remembered = getSubtitleLangSync(id);
    if (remembered === undefined) return; // nothing stored for this show yet
    autoSelectedRef.current = true;
    if (remembered === null) return; // explicitly turned off — respect that
    const match = allSubtitles.find(e => e.lang === remembered);
    if (match) selectSubtitle(match.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitlesLoading, allSubtitles.length, id]);

  const applyDelay = (next: number) => {
    const rounded = Math.round(next * 100) / 100;
    setDelay(rounded);
    saveSubtitleDelay(id, rounded).catch(() => {});
  };

  // The next episode is derived here rather than trusted from route params.
  // It was only ever threaded in from the Detail screen, so it went missing
  // in exactly the cases you'd want it most: resuming from Continue Watching
  // never set it, and jumping to the next episode replaced the screen without
  // it — meaning the button vanished after using it once. Looking it up from
  // Cinemeta makes it always available, and correctly absent on a finale.
  const [derivedNext, setDerivedNext] = useState<NextTarget | undefined>(nextEpisode);
  useEffect(() => {
    if (nextEpisode || type !== 'series') return;
    let cancelled = false;
    const [seriesId, seasonStr, epStr] = id.split(':');
    const season = Number(seasonStr);
    const episode = Number(epStr);
    if (!seriesId || !isFinite(season) || !isFinite(episode)) return;
    fetchMeta('series', seriesId)
      .then(m => {
        if (cancelled || !m?.videos) return;
        const next =
          m.videos.find(v => v.season === season && v.episode === episode + 1) ??
          // Roll over to the next season's opener when this was a finale.
          m.videos.find(v => v.season === season + 1 && v.episode === 1);
        if (next)
          setDerivedNext({
            id: next.id,
            title: `${m.name} S${next.season}E${next.episode}`,
            episodeLabel: `S${next.season}E${next.episode}`,
            thumbnail: next.thumbnail,
          });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [nextEpisode, id, type]);

  // Continue into the next episode by resolution/audio preference, not exact
  // source — replaces the screen with a fresh Player for that episode,
  // carrying forward whatever language/resolution is currently playing (or
  // was preferred) so it stays roughly the same, with the normal fallback
  // walk behind it if that combination isn't available for this episode.
  // Deliberately synchronous: the resolve — and its own progress UI — happens
  // on the newly-mounted screen, not here.
  const goToNextEpisode = useCallback(() => {
    const target = derivedNext;
    if (!target) return;
    const lang = resolvedStream ? detectAudioLanguage(resolvedStream, isAnime) : userLanguage;
    const res = resolvedStream ? parseReleaseInfo(resolvedStream).resolution : userResolution;
    navigation.replace('Player', {
      id: target.id,
      type,
      title: target.title,
      poster,
      background,
      isAnime,
      preferredLanguage: lang,
      preferredResolution: res,
      episodeThumbnail: target.thumbnail,
      episodeLabel: target.episodeLabel,
    });
  }, [derivedNext, resolvedStream, isAnime, userLanguage, userResolution, navigation, type, poster, background]);

  // Opening/ending timestamps for this episode, when they exist. Attempted
  // for EVERY series rather than gated on the Animation genre: that genre
  // catches Western cartoons too and misses anime Cinemeta simply hasn't
  // tagged, so it's a hint, not an answer. The lookup itself is the real
  // test — a title AniList doesn't know isn't anime, and the negative is
  // cached, so a non-anime show costs one request once and never again.
  const [skipTimes, setSkipTimes] = useState<SkipTimes | null>(null);
  useEffect(() => {
    if (type !== 'series') return;
    const [, seasonStr, epStr] = id.split(':');
    const season = Number(seasonStr);
    const episode = Number(epStr);
    if (!isFinite(season) || !isFinite(episode)) return;
    let cancelled = false;
    getSkipTimes(id.split(':')[0], seriesName, season, episode)
      .then(t => !cancelled && setSkipTimes(t))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, type, seriesName]);

  // One dismissal per episode each: once a prompt is used it shouldn't
  // reappear if the user scrubs back over that stretch.
  const [introDismissed, setIntroDismissed] = useState(false);
  const [endingDismissed, setEndingDismissed] = useState(false);
  useEffect(() => {
    setIntroDismissed(false);
    setEndingDismissed(false);
  }, [id]);

  const skipIntro = useCallback(() => {
    if (!skipTimes?.op) return;
    setIntroDismissed(true);
    seekTo(skipTimes.op.end);
  }, [skipTimes, seekTo]);

  // Banner visibility — at most one prompt at a time, in priority order.
  //
  // The ending interval means two different things depending on where it
  // sits. Mid-episode credits with real content after them are worth
  // SKIPPING (jump to the end of the ending and keep watching this
  // episode); credits that run to the end of the file are the point to move
  // ON from, so the useful action there is the next episode, not a skip
  // that would land you two seconds from the end.
  const opRange = skipTimes?.op;
  const edRange = skipTimes?.ed;
  const endingHasTail = Boolean(edRange && duration > 0 && duration - edRange.end > ENDING_TAIL_MIN_SEC);

  const showSkipIntro =
    Boolean(opRange) && !introDismissed && currentTime >= opRange!.start && currentTime < opRange!.end;

  const showSkipEnding =
    Boolean(edRange) &&
    endingHasTail &&
    !endingDismissed &&
    currentTime >= edRange!.start &&
    currentTime < edRange!.end;

  // Falls back to the old "last minute of the file" guess when this episode
  // has no timestamp data, so the prompt still appears for everything the
  // database doesn't cover.
  const showUpNext =
    Boolean(derivedNext) &&
    currentTime > 0 &&
    (edRange
      ? currentTime >= (endingHasTail ? edRange.end : edRange.start)
      : duration > 0 && duration - currentTime < 60);

  const skipEnding = useCallback(() => {
    if (!edRange) return;
    setEndingDismissed(true);
    seekTo(edRange.end);
  }, [edRange, seekTo]);

  // Resolved to a single prompt so only one can ever be on screen, and so
  // the render site stays a single block rather than three near-identical
  // conditionals.
  const banner: { label: string; action: () => void } | null = showSkipIntro
    ? { label: 'Skip Intro', action: skipIntro }
    : showSkipEnding
    ? { label: 'Skip Ending', action: skipEnding }
    : showUpNext
    ? { label: 'Next Episode', action: goToNextEpisode }
    : null;

  const applyStyle = (patch: Partial<SubtitleStyle>) => {
    setSubStyle(prev => ({ ...prev, ...patch }));
    saveSubtitleStyle(patch).catch(() => {});
  };

  const hasAnySubtitles = allSubtitles.length > 0;
  const hasSourceChoice = !streamsLoading && allStreams.length > 0;
  const progressPct = duration ? Math.min(100, (currentTime / duration) * 100) : 0;
  const activeSubtitleLabel = allSubtitles.find(e => e.key === activeSubtitleKey)?.label ?? 'Off';
  const formatDelay = (d: number) => `${d > 0 ? '+' : ''}${d.toFixed(2)}s`;

  const currentSourceLanguage = resolvedStream ? detectAudioLanguage(resolvedStream, isAnime) : userLanguage;
  const currentLangLabel = currentSourceLanguage ? LANGUAGE_LABELS[currentSourceLanguage] : '—';
  const currentResLabel = resolvedStream ? parseReleaseInfo(resolvedStream).resolution ?? '—' : userResolution ?? '—';
  const displayReleaseLabel =
    releaseLabel ??
    (resolvedStream
      ? [
          parseReleaseInfo(resolvedStream).resolution,
          parseReleaseInfo(resolvedStream).codec,
          parseReleaseInfo(resolvedStream).container,
        ]
          .filter(Boolean)
          .join(' · ') || undefined
      : undefined);

  return (
    <View style={styles.page}>
      {error || resolveFailed ? (
        <View style={styles.center}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.error}>{error ?? 'No working source could be found for this title.'}</Text>
          <View style={styles.errorActions}>
            <Focusable hasTVPreferredFocus onPress={() => navigation.goBack()} pill style={styles.errorButton}>
              <Text style={styles.errorButtonText}>Go Back</Text>
            </Focusable>
          </View>
        </View>
      ) : !ready ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.text} size="large" />
          <Text style={styles.title}>{title}</Text>
          {attempt && (
            <Text style={styles.resolvingHint}>
              {attempt.failed ? `${attempt.label} — failed` : `Trying source: ${attempt.label}`}
            </Text>
          )}
        </View>
      ) : (
        <>
          <KeplerVideoView
            videoPlayer={playerRef.current!}
            style={styles.video}
            showControls={false}
            // Subtitles are always ours to draw — external only, see the
            // SubtitleTrackEntry comment above.
            showCaptions={false}
            scalingmode="fit"
          />

          {/* Our own subtitle renderer. Sits above the video and below the
              controls, and lifts out of the way when the control chrome is
              up so the two never overlap. */}
          {cueSegments && cueSegments.length > 0 ? (
            <View style={[styles.subtitleLayer, controlsMounted && styles.subtitleLayerRaised]} pointerEvents="none">
              <Text
                style={[
                  styles.subtitleText,
                  { fontSize: subStyle.size, lineHeight: Math.round(subStyle.size * 1.3) },
                  subStyle.background === 'box' && styles.subtitleBox,
                  subStyle.background === 'outline' && styles.subtitleOutline,
                ]}>
                {/* One nested Text per styled run — this, not a flat string,
                    is what turns <i>/<b>/<u> into actual italic/bold/
                    underline instead of showing the literal tag characters. */}
                {cueSegments.map((seg, i) => (
                  <Text
                    key={i}
                    style={[
                      seg.italic && styles.subtitleItalic,
                      seg.bold && styles.subtitleBold,
                      seg.underline && styles.subtitleUnderline,
                    ]}>
                    {seg.text}
                  </Text>
                ))}
              </Text>
            </View>
          ) : null}

          {controlsMounted && (
            <Animated.View style={[styles.chrome, { opacity: controlsOpacity }]} pointerEvents="box-none">
              <EdgeScrim position="top" />
              <View style={styles.topBar}>
                <Focusable onPress={() => navigation.goBack()} style={styles.backButton}>
                  <IconChevronLeft size={20} />
                </Focusable>
                <Text style={styles.topTitle} numberOfLines={1}>
                  {title}
                </Text>
                {displayReleaseLabel ? (
                  <View style={styles.qualityTag}>
                    <Text style={styles.qualityTagText}>{displayReleaseLabel}</Text>
                  </View>
                ) : null}
              </View>

              <EdgeScrim position="bottom" />

              <View style={styles.controls}>
                {/* Progress bar sits above the transport row. The Focusable
                    wraps only the track itself (not the timestamps either
                    side of it), and a focus-trapping guide keeps left/right
                    on the bar for scrubbing instead of letting focus escape
                    to the transport row below. */}
                <View style={styles.progressRow}>
                  <Text style={styles.time}>{formatTime(currentTime)}</Text>
                  <TVFocusGuideView trapFocusLeft trapFocusRight style={styles.progressGuide}>
                    {/* `bare`: Focusable's default adds a 2px transparent
                        border, and absolutely-positioned children sit inside
                        it — which pushed the scrub thumb 2px below the
                        track's true centre. The default also scales the
                        whole pressable by 1.04 on focus, which on a
                        full-width bar visibly stretches the track. This bar
                        shows its own focus state (taller track + thumb). */}
                    <Focusable
                      bare
                      onFocus={() => setBarFocused(true)}
                      onBlur={() => setBarFocused(false)}
                      style={[styles.progressTrack, barFocused && styles.progressTrackFocused]}>
                      <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
                      {barFocused && <View style={[styles.progressThumb, { left: `${progressPct}%` }]} />}
                    </Focusable>
                  </TVFocusGuideView>
                  <Text style={styles.time}>{duration ? formatTime(duration) : '—:—'}</Text>
                </View>

                {/* Centered transport row — a matching-width spacer on the
                    left balances the track buttons on the right so
                    play/pause/skip sit in the true horizontal middle. */}
                <View style={styles.transportRow}>
                  <View style={styles.sideSlot} />
                  <View style={styles.transportCenter}>
                    <TransportButton icon="seek" flip onPress={() => seek(-SEEK_SECONDS)} />
                    <TransportButton
                      icon={playing ? 'pause' : 'play'}
                      size={40}
                      hasTVPreferredFocus
                      onPress={togglePlay}
                    />
                    <TransportButton icon="seek" onPress={() => seek(SEEK_SECONDS)} />
                    {derivedNext && <TransportButton icon="next" onPress={goToNextEpisode} />}
                  </View>
                  <View style={[styles.sideSlot, styles.sideSlotRight]}>
                    {(hasAnySubtitles || subtitlesLoading || hasSourceChoice) && (
                      <SubtitlesButton
                        onPress={() => {
                          setPane('main');
                          setShowTracks(true);
                        }}
                      />
                    )}
                  </View>
                </View>
              </View>
            </Animated.View>
          )}

          {/* Prompts live OUTSIDE the control chrome on purpose: the whole
              point of a skip prompt is that it appears while you're just
              watching, with the controls faded out. Each takes focus as it
              appears so OK acts on it directly — there is nothing else
              focusable on screen at that moment — and the track panel
              suppresses both so it can't steal focus out of an open menu. */}
          {!showTracks && banner && (
            <Focusable
              onPress={banner.action}
              rounded
              style={[styles.sideBanner, controlsMounted && styles.sideBannerRaised]}>
              <Text style={styles.sideBannerTitle}>{banner.label}</Text>
            </Focusable>
          )}

          {showTracks && (
            <View style={styles.trackPanelOverlay}>
              <View style={styles.trackPanel}>
                {pane === 'main' && (
                  <ScrollView showsVerticalScrollIndicator={false}>
                    <Text style={styles.trackPanelHeading}>Subtitles</Text>
                    {subtitlesLoading && <ActivityIndicator color={colors.text} style={{ marginBottom: spacing.sm }} />}

                    <MenuRow hasTVPreferredFocus onPress={() => setPane('language')}>
                      <View style={styles.trackRowSplit}>
                        <Text style={styles.trackRowText}>Language</Text>
                        <Text style={styles.trackRowValue} numberOfLines={1}>
                          {activeSubtitleLabel}  ›
                        </Text>
                      </View>
                    </MenuRow>

                    <MenuRow onPress={() => setPane('appearance')}>
                      <View style={styles.trackRowSplit}>
                        <Text style={styles.trackRowText}>Appearance</Text>
                        <Text style={styles.trackRowValue}>
                          {SUBTITLE_SIZES.find(s => s.value === subStyle.size)?.label ?? 'Custom'}  ›
                        </Text>
                      </View>
                    </MenuRow>

                    {!subtitlesLoading && !hasAnySubtitles && (
                      <Text style={styles.trackEmpty}>No subtitles available for this release</Text>
                    )}

                    {/* Delay sits on the top level, not buried in Appearance:
                        it's the one subtitle control you reach for mid-scene,
                        and it's per-show rather than a global look setting. */}
                    <Text style={[styles.trackPanelHeading, { marginTop: spacing.lg }]}>Delay</Text>
                    <View style={styles.delayRow}>
                      <Focusable onPress={() => applyDelay(delay - DELAY_STEP)} pill style={styles.delayButton}>
                        <Text style={styles.delayButtonText}>−</Text>
                      </Focusable>
                      <Text style={styles.delayValue}>{formatDelay(delay)}</Text>
                      <Focusable onPress={() => applyDelay(delay + DELAY_STEP)} pill style={styles.delayButton}>
                        <Text style={styles.delayButtonText}>+</Text>
                      </Focusable>
                    </View>
                    <Text style={styles.delayHint}>
                      Positive shows subtitles later. Saved for this show and reused on the next episode.
                    </Text>
                    {delay !== 0 && (
                      <MenuRow onPress={() => applyDelay(0)}>
                        <Text style={styles.trackRowText}>Reset to 0.00s</Text>
                      </MenuRow>
                    )}

                    <Text style={[styles.trackPanelHeading, { marginTop: spacing.lg }]}>Source</Text>
                    {!hasSourceChoice ? (
                      <ActivityIndicator color={colors.text} style={{ marginBottom: spacing.sm }} />
                    ) : (
                      <>
                        <MenuRow onPress={() => setPane('resolution')}>
                          <View style={styles.trackRowSplit}>
                            <Text style={styles.trackRowText}>Resolution</Text>
                            <Text style={styles.trackRowValue} numberOfLines={1}>
                              {currentResLabel}  ›
                            </Text>
                          </View>
                        </MenuRow>
                        <MenuRow onPress={() => setPane('sourceLanguage')}>
                          <View style={styles.trackRowSplit}>
                            <Text style={styles.trackRowText}>Audio Language</Text>
                            <Text style={styles.trackRowValue} numberOfLines={1}>
                              {currentLangLabel}  ›
                            </Text>
                          </View>
                        </MenuRow>
                        {resolvedStream && (
                          <MenuRow onPress={skipCurrentSource}>
                            <Text style={styles.trackRowText}>Skip this source (wrong video)</Text>
                          </MenuRow>
                        )}
                      </>
                    )}

                    <Focusable onPress={() => setShowTracks(false)} pill style={styles.trackClose}>
                      <Text style={styles.trackRowText}>✕</Text>
                    </Focusable>
                  </ScrollView>
                )}

                {pane === 'language' && (
                  <ScrollView showsVerticalScrollIndicator={false}>
                    <MenuRow hasTVPreferredFocus onPress={() => setPane('main')}>
                      <Text style={styles.trackRowText}>‹  Subtitles</Text>
                    </MenuRow>
                    <Text style={[styles.trackPanelHeading, { marginTop: spacing.sm }]}>Language</Text>

                    <MenuRow onPress={() => selectSubtitle(null)}>
                      <Text style={[styles.trackRowText, activeSubtitleKey === null && styles.trackRowActive]}>
                        {activeSubtitleKey === null ? '✓  ' : '    '}Off
                      </Text>
                    </MenuRow>
                    {allSubtitles.map(entry => {
                      // The release name only earns its space when it's
                      // actually disambiguating something.
                      const ambiguous = allSubtitles.filter(e => e.label === entry.label).length > 1;
                      return (
                        <MenuRow key={entry.key} onPress={() => selectSubtitle(entry.key)}>
                          <Text style={[styles.trackRowText, activeSubtitleKey === entry.key && styles.trackRowActive]}>
                            {activeSubtitleKey === entry.key ? '✓  ' : '    '}
                            {entry.label}
                          </Text>
                          {ambiguous && entry.variant ? (
                            <Text style={styles.trackRowVariant} numberOfLines={1}>
                              {'    '}
                              {entry.variant}
                            </Text>
                          ) : null}
                        </MenuRow>
                      );
                    })}
                  </ScrollView>
                )}

                {pane === 'appearance' && (
                  <ScrollView showsVerticalScrollIndicator={false}>
                    <MenuRow hasTVPreferredFocus onPress={() => setPane('main')}>
                      <Text style={styles.trackRowText}>‹  Subtitles</Text>
                    </MenuRow>

                    <Text style={[styles.trackPanelHeading, { marginTop: spacing.sm }]}>Text size</Text>
                    {SUBTITLE_SIZES.map(opt => (
                      <MenuRow key={opt.value} onPress={() => applyStyle({ size: opt.value })}>
                        <Text style={[styles.trackRowText, subStyle.size === opt.value && styles.trackRowActive]}>
                          {subStyle.size === opt.value ? '✓  ' : '    '}
                          {opt.label}
                        </Text>
                      </MenuRow>
                    ))}

                    <Text style={[styles.trackPanelHeading, { marginTop: spacing.lg }]}>Background</Text>
                    {SUBTITLE_BACKGROUNDS.map(opt => (
                      <MenuRow key={opt.value} onPress={() => applyStyle({ background: opt.value })}>
                        <Text style={[styles.trackRowText, subStyle.background === opt.value && styles.trackRowActive]}>
                          {subStyle.background === opt.value ? '✓  ' : '    '}
                          {opt.label}
                        </Text>
                      </MenuRow>
                    ))}

                  </ScrollView>
                )}

                {pane === 'resolution' && (
                  <ScrollView showsVerticalScrollIndicator={false}>
                    <MenuRow hasTVPreferredFocus onPress={() => setPane('main')}>
                      <Text style={styles.trackRowText}>‹  Source</Text>
                    </MenuRow>
                    <Text style={[styles.trackPanelHeading, { marginTop: spacing.sm }]}>Resolution</Text>
                    {resOptions.map(res => (
                      <MenuRow key={res} onPress={() => selectResolution(res)}>
                        <Text style={[styles.trackRowText, currentResLabel === res && styles.trackRowActive]}>
                          {currentResLabel === res ? '✓  ' : '    '}
                          {res}
                        </Text>
                      </MenuRow>
                    ))}
                  </ScrollView>
                )}

                {pane === 'sourceLanguage' && (
                  <ScrollView showsVerticalScrollIndicator={false}>
                    <MenuRow hasTVPreferredFocus onPress={() => setPane('main')}>
                      <Text style={styles.trackRowText}>‹  Source</Text>
                    </MenuRow>
                    <Text style={[styles.trackPanelHeading, { marginTop: spacing.sm }]}>Audio Language</Text>
                    {langOptions.map(lang => (
                      <MenuRow key={lang} onPress={() => selectSourceLanguage(lang)}>
                        <Text style={[styles.trackRowText, currentSourceLanguage === lang && styles.trackRowActive]}>
                          {currentSourceLanguage === lang ? '✓  ' : '    '}
                          {LANGUAGE_LABELS[lang]}
                        </Text>
                      </MenuRow>
                    ))}
                  </ScrollView>
                )}
              </View>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000' },
  video: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 20, marginTop: 16 },
  error: { color: colors.danger, fontSize: 16, marginTop: 12, paddingHorizontal: 32, textAlign: 'center' },
  resolvingHint: { color: colors.textDim, fontSize: 14, marginTop: 10, textAlign: 'center', paddingHorizontal: 32 },
  errorActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  errorButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.glass,
  },
  errorButtonText: { color: colors.text, fontSize: 15, fontWeight: '700' },

  chrome: { ...StyleSheet.absoluteFillObject },

  // Taller than the chrome they sit behind — the fade needs room to reach
  // transparent gradually instead of being compressed into a short band.
  scrimWrap: { position: 'absolute', left: 0, right: 0 },
  // Taller than the chrome itself: a gradient needs room to reach zero
  // gradually, and compressing it into a short band is what makes the fade
  // read as an edge no matter how the stops are tuned.
  scrimTop: { top: 0, height: 300 },
  scrimBottom: { bottom: 0, height: 380 },

  topBar: {
    position: 'absolute',
    top: spacing.lg,
    left: spacing.xl,
    right: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    flexShrink: 1,
  },
  qualityTag: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  qualityTagText: { color: colors.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },

  // Sits low on the screen while you're just watching, and lifts clear of
  // the transport controls when they come up — same trick as the subtitle
  // layer, so the two never collide.
  // One line, sized to its text — a prompt, not a card. It sits over the
  // picture during playback, so the less of the frame it covers the better.
  sideBanner: {
    position: 'absolute',
    right: spacing.xl,
    bottom: 48,
    alignSelf: 'flex-start',
    // Light enough to read as an overlay on the picture rather than a panel
    // sitting on top of it. The text carries its own shadow (below) so it
    // stays legible over a bright frame even at this opacity.
    backgroundColor: 'rgba(10,10,11,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  sideBannerRaised: { bottom: 210 },
  sideBannerTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
    // Carries the legibility now that the plate behind it is mostly
    // transparent.
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },

  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
  },
  transportRow: { flexDirection: 'row', alignItems: 'center' },
  sideSlot: { width: 180, alignItems: 'flex-end' },
  sideSlotRight: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
  transportCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.lg },

  // Generous hit/spacing box around each glyph. No border or background:
  // focus is communicated by tinting the icon, so the box is purely layout.
  transportButton: {
    width: 60,
    height: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flipped: { transform: [{ scaleX: -1 }] },

  // No border here — Focusable already draws a transparent ring by default
  // and switches it to the accent glow on focus, which is exactly the "only
  // circled when highlighted" look. Setting our own borderColor here would
  // override that (it merges last) and make the ring permanent.
  playCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  tracksButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  progressRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  time: { color: colors.textDim, fontSize: 13, fontWeight: '600', width: 46 },
  progressGuide: { flex: 1, marginHorizontal: spacing.sm },
  // Was 4px of accent on a 20%-white track — technically drawn, but far too
  // thin and low-contrast to read as progress at TV viewing distance, so the
  // bar looked empty whenever it wasn't focused. Thicker, and the unfocused
  // trough is darker so the filled portion actually separates from it.
  progressTrack: {
    height: 7,
    backgroundColor: 'rgba(255,255,255,0.28)',
    borderRadius: 4,
    justifyContent: 'center',
    overflow: 'visible',
  },
  progressTrackFocused: { height: 10 },
  progressFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.accent, borderRadius: 4 },
  // Vertically centred on the focused track: (10 - 16) / 2 = -3. Now that
  // the Focusable is `bare` there's no border offsetting this any more.
  progressThumb: {
    position: 'absolute',
    top: -3,
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    backgroundColor: colors.accent,
  },

  trackPanelOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.scrim,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  trackPanel: {
    width: 380,
    height: '100%',
    backgroundColor: colors.backgroundElevated,
    borderTopLeftRadius: radius.lg,
    borderBottomLeftRadius: radius.lg,
    padding: spacing.lg,
    paddingTop: spacing.xl,
  },
  trackPanelHeading: { color: colors.textDim, fontSize: 13, fontWeight: '700', marginBottom: spacing.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  // marginHorizontal, not just padding: the focus ring is drawn on this row's
  // own border, so without a margin it sat flush against the panel's inner
  // edge and the left/right sides of the ring were clipped away.
  trackRow: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginHorizontal: 3,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  // Deliberately no glow() here. On a box this wide the shadow spreads across
  // the entire row instead of hugging its edge, which reads as a filled
  // rectangle rather than a highlight.
  trackRowFocused: {
    borderColor: colors.accent,
    backgroundColor: colors.glassFocused,
  },
  trackRowText: { color: colors.text, fontSize: 16 },
  trackRowActive: { fontWeight: '700' },
  trackRowVariant: { color: colors.textFaint, fontSize: 12, marginTop: 1 },
  trackRowSplit: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  trackRowValue: { color: colors.textDim, fontSize: 14, fontWeight: '600', flexShrink: 1 },

  delayRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.sm },
  delayButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
  },
  delayButtonText: { color: colors.text, fontSize: 24, fontWeight: '700', lineHeight: 28 },
  delayValue: { color: colors.text, fontSize: 20, fontWeight: '800', minWidth: 84, textAlign: 'center' },
  delayHint: { color: colors.textFaint, fontSize: 12, lineHeight: 17, paddingHorizontal: spacing.sm, marginTop: spacing.sm },

  // Sits low over the video, and lifts when the control chrome appears so
  // the two never collide.
  subtitleLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 56,
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
  },
  subtitleLayerRaised: { bottom: 200 },
  subtitleText: {
    color: '#ffffff',
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitleBox: {
    backgroundColor: 'rgba(0,0,0,0.78)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  // Not a true stroke — RN has no text-stroke — but a tight black shadow
  // reads as an outline and keeps white text legible over bright frames.
  subtitleItalic: { fontStyle: 'italic' },
  subtitleBold: { fontWeight: '900' },
  subtitleUnderline: { textDecorationLine: 'underline' },
  subtitleOutline: {
    textShadowColor: 'rgba(0,0,0,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 5,
  },
  trackEmpty: { color: colors.textFaint, fontSize: 14, fontStyle: 'italic' },
  trackClose: {
    marginTop: spacing.lg,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
  },
});
