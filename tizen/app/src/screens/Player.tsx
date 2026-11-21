import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Stream, Subtitle } from '../../../../src/types';
import type { Nav, PlayerParams } from '../App';
import { meta as fetchMeta, parseReleaseInfo, resolveStream, streams as fetchStreams } from '../../../../src/addons/client';
import { orderCandidates } from '../../../../src/addons/streamSelection';
import {
  fetchSrtCues,
  fetchSubtitles,
  parseCueSegments,
  pickSubtitleSet,
  subtitleLangLabel,
  subtitleVariantLabel,
  type SrtCue,
} from '../../../../src/addons/subtitles';
import { getSkipTimes, type SkipTimes } from '../../../../src/addons/skipTimes';
import { bestTrackMatch, canonicalLang, type TrackPreference } from '../../../../src/addons/languages';
import { getHistorySync, recordWatched, resumePositionFor, saveProgress } from '../../../../src/storage/history';
import { getSettingsSync, hasBackupStreamAddons, saveSettings } from '../../../../src/storage/settings';
import {
  describeSource,
  getSourcePrefSync,
  saveSourcePref,
  sourceMatchScore,
} from '../../../../src/storage/sourcePrefs';
import {
  DELAY_STEP,
  getAudioPrefSync,
  getSubtitleDelaySync,
  getSubtitlePrefSync,
  getSubtitleStyleSync,
  saveAudioPref,
  saveSubtitleDelay,
  saveSubtitlePref,
  saveSubtitleStyle,
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_SIZES,
  type SubtitleStyle,
} from '../../../../src/storage/subtitlePrefs';
import { av, closePlayer, trackExtra, type AvTrack } from '../platform/avplay';
import { KEY, useKeys } from '../platform/keys';
import { stopTrailer } from '../trailer';

const CONTROLS_HIDE_MS = 5000;
// Per-source limits in the walk: following the addon's link and checking
// the file, then AVPlay opening it. Past either, the next source is tried.
const RESOLVE_LIMIT_MS = 12000;
// Seconds of video AVPlay holds before it starts playing, and before it
// carries on after running dry (see open()).
const BUFFER_START_SEC = 10;
const BUFFER_RESUME_SEC = 15;
const OPEN_LIMIT_MS = 20000;

function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${why} within ${ms / 1000}s`)), ms);
    p.then(
      v => {
        clearTimeout(t);
        resolve(v);
      },
      e => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
// Each press of a burst (presses less than SEEK_BURST_GAP_MS apart, or a
// held key) jumps further than the last: 10 s for the first few, building to
// 5 minutes, so a long skip doesn't take dozens of presses.
const SEEK_STEPS: Array<[number, number]> = [
  [3, 10],
  [8, 30],
  [14, 60],
  [22, 120],
  [Infinity, 300],
];
const SEEK_BURST_GAP_MS = 900;
// Presses inside this window add up to one seek, sent when they stop.
const SEEK_COMMIT_MS = 600;
const PROGRESS_SAVE_MS = 10000;
// A source that opened but never actually starts playing is a dead source.
const START_WATCHDOG_MS = 25000;
const BANNER_VISIBLE_MS = 15000;
// Menu rows: fixed height (see .menu-item / .menu-section) and how many fit.
const MENU_ROW_H = 54;
const MENU_VISIBLE = 11;
const ENDING_TAIL_MIN_SEC = 30;

// `pos`: 1-based position among the file's audio tracks — what identifies a
// track when, as in many releases, it carries no language tag.
type AudioTrack = { index: number; lang: string; label: string; codec: string; pos: number };
type SubEntry =
  | { key: string; label: string; lang: string; name?: string; source: 'embedded'; index: number }
  | { key: string; label: string; lang: string; name?: string; source: 'external'; sub: Subtitle };
type Next = { id: string; title: string; label: string; thumbnail?: string };
type Menu = 'audio' | 'subtitles' | null;

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const two = (n: number) => (n < 10 ? '0' : '') + n;
  return h > 0 ? `${h}:${two(m)}:${two(ss)}` : `${m}:${two(ss)}`;
}

function streamLabel(s: Stream): string {
  return (s.behaviorHints?.filename || s.title || s.name || 'Unnamed release').split('\n')[0];
}

const RESOLUTION_ORDER = ['2160p', '1080p', '720p', '480p'];

// FLAC audio in MKV plays slightly out of sync on these TVs (measured on
// device against an MP3 release of the same episode; other Samsung owners
// report the same) and nothing in AVPlay can shift it, so FLAC releases are
// flagged in the Sources menu and tried after the rest.
//
// A release's name often doesn't say what its audio is ("[Salieri] … (1080p)
// (HDR) [Dual Audio]" is FLAC-only), so releases found to be FLAC once
// opened are remembered — by release pack, or release group + resolution —
// and recognised from then on without opening them.
//
// The same goes for MKVs packed with subtitle tracks (below).
type PoorKind = 'flac' | 'subs';
const POOR_KEY = 'fireio:poorReleases:v1';
// The first version remembered FLAC only, as a plain list.
const OLD_FLAC_KEY = 'fireio:flacReleases:v1';
let poorReleases: Record<string, PoorKind[]> | null = null;
function knownPoor(): Record<string, PoorKind[]> {
  if (!poorReleases) {
    poorReleases = {};
    try {
      poorReleases = JSON.parse(localStorage.getItem(POOR_KEY) || '{}') as Record<string, PoorKind[]>;
      for (const k of JSON.parse(localStorage.getItem(OLD_FLAC_KEY) || '[]') as string[]) {
        if (!poorReleases[k]) poorReleases[k] = ['flac'];
      }
      // Earlier keys could be shared by unrelated releases (a movie's binge
      // group is only its quality, e.g. "1080p WEBRip x265 10bit"): drop them.
      for (const k of Object.keys(poorReleases)) {
        // Dolby Vision turned out to play fine, so it is no longer remembered.
        const kinds = (poorReleases[k] ?? []).filter(kind => kind !== ('dv' as string));
        if (!isSpecificKey(k) || !kinds.length) delete poorReleases[k];
        else poorReleases[k] = kinds;
      }
      localStorage.setItem(POOR_KEY, JSON.stringify(poorReleases));
    } catch {
      // unreadable: start over
    }
  }
  return poorReleases;
}
// A binge group names one release pack only when it carries the pack's hash;
// otherwise it is just a quality label that many releases share, so the file
// itself is the key.
const PACK_HASH = /[0-9a-f]{40}/i;
function isSpecificKey(k: string): boolean {
  return k.startsWith('fn:') || (k.startsWith('bg:') && PACK_HASH.test(k));
}
function releaseKey(st: Stream): string | null {
  const bg = st.behaviorHints?.bingeGroup;
  if (bg && PACK_HASH.test(bg)) return `bg:${bg}`;
  const file = st.behaviorHints?.filename || st.title || st.name;
  return file ? `fn:${streamLabel(st)}` : null;
}
function rememberPoor(st: Stream, kind: PoorKind): void {
  const key = releaseKey(st);
  if (!key) return;
  const all = knownPoor();
  const kinds = all[key] ?? [];
  if (kinds.includes(kind)) return;
  all[key] = [...kinds, kind];
  try {
    const keys = Object.keys(all);
    const kept = keys.slice(-500).reduce<Record<string, PoorKind[]>>((o, k) => ((o[k] = all[k]), o), {});
    localStorage.setItem(POOR_KEY, JSON.stringify(kept));
  } catch {
    // storage full: only this session remembers
  }
}
function knownAs(st: Stream, kind: PoorKind): boolean {
  const key = releaseKey(st);
  return key !== null && (knownPoor()[key] ?? []).includes(kind);
}

// Releases this TV plays, but badly — tried after everything else.
function playsPoorly(st: Stream): boolean {
  return isFlac(st) || knownAs(st, 'subs');
}

function isFlac(st: Stream): boolean {
  if (/\bFLAC\b/i.test(`${st.behaviorHints?.filename ?? ''} ${st.title ?? ''} ${st.name ?? ''}`)) return true;
  return knownAs(st, 'flac');
}

// How much of the start of a file is read to check its track list.
const PROBE_BYTES = 768 * 1024;

// Subtitle tracks in an MKV's track list (TrackEntry elements whose
// TrackType is 17), read with a minimal EBML walk: Segment > Tracks >
// TrackEntry > TrackType. Returns 0 for anything that isn't Matroska.
function countSubtitleTracks(b: Uint8Array): number {
  if (b[0] !== 0x1a || b[1] !== 0x45 || b[2] !== 0xdf || b[3] !== 0xa3) return 0;
  const readId = (i: number) => {
    let len = 1;
    let mask = 0x80;
    while (len <= 4 && !(b[i] & mask)) {
      len++;
      mask >>= 1;
    }
    let v = 0;
    for (let k = 0; k < len; k++) v = v * 256 + b[i + k];
    return { id: v, len };
  };
  const readSize = (i: number) => {
    let len = 1;
    let mask = 0x80;
    while (len <= 8 && !(b[i] & mask)) {
      len++;
      mask >>= 1;
    }
    let v = b[i] & (mask - 1);
    for (let k = 1; k < len; k++) v = v * 256 + b[i + k];
    return { v, len, unknown: v === Math.pow(2, 7 * len) - 1 };
  };
  const SEGMENT = 0x18538067;
  const TRACKS = 0x1654ae6b;
  const TRACK_ENTRY = 0xae;
  const TRACK_TYPE = 0x83;
  const CLUSTER = 0x1f43b675;
  let subtitles = 0;
  const walk = (start: number, end: number): boolean => {
    let i = start;
    while (i < end && i + 8 < b.length) {
      const { id, len } = readId(i);
      const size = readSize(i + len);
      const dataStart = i + len + size.len;
      const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.v);
      if (id === CLUSTER) return true; // the track list always comes before the media
      if (id === SEGMENT || id === TRACKS || id === TRACK_ENTRY) {
        if (walk(dataStart, dataEnd)) return true;
        if (id === TRACKS) return true;
      } else if (id === TRACK_TYPE && b[dataStart] === 17) {
        subtitles++;
      }
      if (size.unknown) return false;
      i = dataEnd;
    }
    return false;
  };
  const header = readId(0);
  const headerSize = readSize(header.len);
  walk(header.len + headerSize.len + headerSize.v, b.length);
  return subtitles;
}

// Reads the start of the file to count its subtitle tracks.
async function probeFile(url: string): Promise<{ subtitleTracks: number }> {
  try {
    const r = await withTimeout(fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } }), 6000, 'probe');
    const b = new Uint8Array(await withTimeout(r.arrayBuffer(), 8000, 'probe'));
    return { subtitleTracks: countSubtitleTracks(b) };
  } catch {
    // couldn't check: treat as fine rather than hold the walk up
    return { subtitleTracks: 0 };
  }
}

// AVPlay smears and stutters on an MKV packed with dozens of subtitle
// tracks, whether or not one is shown — proven on device with the same
// clip three ways: 42 subtitle tracks smeared (with subtitles switched off
// in the player too), the same clip with none was clean. Files with this
// many are tried after the rest. Releases with a handful (Endgame's 4) are
// unaffected.
const MANY_SUBTITLE_TRACKS = 15;

// This TV (2018) has no DTS or TrueHD decoder, so a release whose only
// audio is one of those plays silent or not at all. Tried last.
function undecodableAudio(s: Stream): boolean {
  const text = `${s.behaviorHints?.filename ?? ''} ${s.title ?? ''}`;
  // AV1 video too: the 2018 models have no AV1 decoder (seen on device: an
  // AV1 release fails to open every time).
  if (/\bAV1\b/i.test(text)) return true;
  return /\b(DTS|TrueHD)\b/i.test(text) && !/\b(AC-?3|E-?AC-?3|DD\+?|DDP|AAC|Opus|FLAC|MP3)\b/i.test(text);
}

// AVPlay reports some languages by country-style codes rather than ISO 639
// (seen on device: Japanese audio as "jp"), which would never match a
// remembered "ja" choice.
const AVPLAY_LANG: Record<string, string> = { jp: 'ja', kr: 'ko', cn: 'zh', gr: 'el', dk: 'da', se: 'sv', ua: 'uk', cz: 'cs' };
function avLang(code: string): string {
  const c = code.trim().toLowerCase();
  return canonicalLang(AVPLAY_LANG[c] ?? c);
}

function audioLabel(t: AvTrack): AudioTrack {
  const x = trackExtra(t);
  const code = x.language ?? x.track_lang ?? '';
  const lang = avLang(code);
  const parts = [lang ? subtitleLangLabel(lang) : code || `Track ${t.index}`, x.fourCC, x.channels ? `${x.channels}ch` : ''];
  return { index: t.index, lang, label: parts.filter(Boolean).join(' · '), codec: (x.fourCC ?? '').toLowerCase(), pos: 0 };
}

// What's remembered for an audio choice: its language, or — for a track
// with none — its position in the file.
function audioPrefFor(t: AudioTrack): TrackPreference {
  return t.lang ? { lang: t.lang, name: t.label } : { lang: '', name: `track ${t.pos}` };
}

function matchAudio(pref: TrackPreference, tracks: AudioTrack[]): AudioTrack | undefined {
  if (pref.lang) return bestTrackMatch(pref, tracks, t => ({ code: t.lang, name: t.label }));
  return tracks.find(t => `track ${t.pos}` === pref.name);
}

// Embedded subtitle text arrives with ASS override tags ({\an8}, {\i1}) and
// \N line breaks; SRT-style tags are handled by parseCueSegments.
function cleanEmbedded(text: string): string {
  return text.replace(/\{\\[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();
}

// Both kinds of subtitle text can carry HTML the renderer would otherwise
// print literally — <br> line breaks, <font color=...> — plus entities.
// Line breaks become real ones; italic/bold/underline are left for
// parseCueSegments; anything else is dropped.
function cleanMarkup(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(?!\/?[ibu]>)[^>]*>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Subtitle size: the stored sizes are the Fire TV app's (20-40); on a TV
// seen from across a room they read far too small at face value.
const SUBTITLE_SCALE = 1.625;

export function PlayerScreen({ nav, active, params }: { nav: Nav; active: boolean; params: PlayerParams }) {
  const { id, type, title, isAnime, preferredResolution, poster, background, episodeThumbnail, episodeLabel } = params;
  const seriesId = type === 'series' ? id.split(':')[0] : id;
  const seriesName = episodeLabel && title.endsWith(episodeLabel) ? title.slice(0, -episodeLabel.length).trim() : title;

  // ---- Sources ---------------------------------------------------------------
  const [useBackup, setUseBackup] = useState(getSettingsSync().useBackupStreamAddons);
  const [allStreams, setAllStreams] = useState<Stream[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAllStreams(null);
    fetchStreams(type, id)
      .then(s => !cancelled && setAllStreams(s))
      .catch(() => !cancelled && setAllStreams([]));
    return () => {
      cancelled = true;
    };
  }, [type, id, useBackup]);

  // The remembered source picked out below, and whether you chose it
  // yourself — only then is it exempt from the FLAC set-aside.
  const rememberedSourceRef = useRef<Stream | null>(null);
  const rememberedPickedRef = useRef(false);
  // The source you picked from the Sources menu in this session, if any.
  const pickedRef = useRef<Stream | null>(null);

  // Source order on this TV:
  //   1. the source this show was last watched from (exact file when it's
  //      the same episode, otherwise the same release pack) — unless the app
  //      only fell back to it and it's one this TV plays poorly;
  //   2. everything else by resolution, 4K first (this TV plays it fine);
  //   3. FLAC releases and MKVs packed with subtitle tracks, which this TV
  //      plays out of sync or with smearing and judder;
  //   4. DTS/TrueHD-only and AV1 releases, which it can't decode at all.
  const candidates = useMemo(() => {
    if (!allStreams) return [];
    const pref = getSourcePrefSync(seriesId);
    // The normal order, by resolution — with no remembered source in it.
    const ordered = orderCandidates(allStreams, { resolutionOrder: RESOLUTION_ORDER });
    // Only the single best match: if it fails, the walk goes to the top of
    // the normal order, not on through other releases that merely share its
    // group (which once meant an OAD file was tried for an episode).
    let best: Stream | undefined;
    let bestScore = 0;
    if (pref) {
      for (const st of ordered) {
        const score = sourceMatchScore(st, pref, id);
        if (score > bestScore) {
          best = st;
          bestScore = score;
        }
      }
    }
    // A remembered source you didn't pick yourself that's known to be FLAC
    // gets no head start: it waits in the FLAC section like any other.
    if (best && !pref?.picked && playsPoorly(best)) best = undefined;
    rememberedSourceRef.current = best ?? null;
    rememberedPickedRef.current = Boolean(best && pref?.picked);
    const remembered = best ? [best] : [];
    const rest = ordered.filter(st => st !== best);
    const tier = (st: Stream) => (undecodableAudio(st) ? 2 : playsPoorly(st) ? 1 : 0);
    return [...remembered, ...[0, 1, 2].flatMap(t => rest.filter(st => tier(st) === t))];
  }, [allStreams, seriesId, id]);

  const [phase, setPhase] = useState<'loading' | 'resolving' | 'opening' | 'playing' | 'failed'>('loading');
  const [attempt, setAttempt] = useState<string>('');
  const [current, setCurrent] = useState<Stream | null>(null);
  const excluded = useRef(new Set<Stream>());
  const walkGen = useRef(0);
  const playingRef = useRef(false);

  // ---- Playback state --------------------------------------------------------
  const [time, setTime] = useState(0); // seconds
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [activeAudio, setActiveAudio] = useState<number | null>(null);
  const [embeddedSubs, setEmbeddedSubs] = useState<SubEntry[]>([]);
  const [externalSubs, setExternalSubs] = useState<SubEntry[]>([]);
  const [activeSub, setActiveSub] = useState<string | null>(null);
  const [cues, setCues] = useState<SrtCue[] | null>(null);
  const [embeddedCue, setEmbeddedCue] = useState<string | null>(null);
  const [delay, setDelay] = useState(() => getSubtitleDelaySync(id));
  // How subtitles look: one global setting (it's about the TV and the
  // room, not the show), shared with the Fire TV app's storage format.
  const [subStyle, setSubStyle] = useState<SubtitleStyle>(getSubtitleStyleSync);
  const applyStyle = (patch: Partial<SubtitleStyle>) => {
    setSubStyle(prev => ({ ...prev, ...patch }));
    saveSubtitleStyle(patch).catch(() => {});
  };
  const resumedRef = useRef(false);
  const recordedRef = useRef(false);

  useEffect(() => {
    stopTrailer();
    document.body.classList.add('video');
    return () => {
      document.body.classList.remove('video');
      const p = av();
      try {
        const pos = p.getCurrentTime() / 1000;
        const dur = p.getDuration() / 1000;
        if (playingRef.current && pos > 0 && dur > 0) saveProgress(seriesId, id, pos, dur).catch(() => {});
      } catch {
        // player already gone
      }
      closePlayer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opens one resolved URL in AVPlay; resolves once it's prepared, rejects
  // if the TV can't play it.
  const open = useCallback((url: string, gen: number) => {
    return new Promise<void>((resolve, reject) => {
      const p = av();
      closePlayer();
      p.open(url);
      // A bigger cushion than the TV's default few seconds. Measured on
      // device: the same release smeared and stuttered streamed from the
      // internet (at 26 Mbps available for a ~11 Mbps file) yet played clean
      // from a PC on the same network — so it's the arrival of data that
      // varies, not its average rate, and busy scenes outrun a small buffer.
      // Applies before prepare, while the player is IDLE.
      try {
        p.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', BUFFER_START_SEC);
        p.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', BUFFER_RESUME_SEC);
      } catch (e) {
        console.warn('[player] buffering params refused', String(e));
      }
      p.setDisplayRect(0, 0, 1920, 1080);
      try {
        p.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
      } catch {
        // older firmware: letterboxed by default
      }
      p.setListener({
        onbufferingstart: () => gen === walkGen.current && setBuffering(true),
        onbufferingcomplete: () => gen === walkGen.current && setBuffering(false),
        oncurrentplaytime: ms => {
          if (gen !== walkGen.current) return;
          if (seekPendingRef.current === null) setTime(ms / 1000);
          if (ms > 0) onFirstFrames();
        },
        onstreamcompleted: () => gen === walkGen.current && onCompletedRef.current(),
        onerror: e => {
          if (gen !== walkGen.current) return;
          console.warn('[player] error', e);
          if (!playingRef.current) failCurrentRef.current(String(e));
          else setFatal(String(e));
        },
        onsubtitlechange: (dur, text) => {
          if (gen !== walkGen.current) return;
          setEmbeddedCue(cleanEmbedded(text));
          if (embeddedTimer.current) clearTimeout(embeddedTimer.current);
          embeddedTimer.current = setTimeout(() => setEmbeddedCue(null), Math.max(500, dur));
        },
      });
      p.prepareAsync(resolve, reject);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const embeddedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The remembered audio track to switch to once playback is running.
  const pendingAudioRef = useRef<number | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fatal, setFatal] = useState<string | null>(null);

  // Walks the candidates in order: resolve (follow the addon's link, check
  // it's really video), open in AVPlay, and on any failure — or a stage
  // taking longer than its limit — move on to the next. The limits are hard
  // ones: a source that stalls mid-open used to hold the walk until it
  // eventually came through, however long that took.
  //
  // A file that turns out to be FLAC-only when opened is set aside and
  // tried only after every other source — unless it's the remembered source
  // or one picked from the Sources menu (`chosen`), which play as chosen.
  const walk = useCallback(
    async (list: Stream[], chosen?: Stream, allowFlac = false): Promise<void> => {
      const gen = ++walkGen.current;
      const stale = () => gen !== walkGen.current;
      playingRef.current = false;
      setFatal(null);
      const deferred: Stream[] = [];
      if (chosen) pickedRef.current = chosen;
      for (const stream of list) {
        if (stale()) return;
        if (excluded.current.has(stream)) continue;
        excluded.current.add(stream);
        setPhase('resolving');
        setAttempt(streamLabel(stream));
        let finalUrl: string;
        try {
          finalUrl = (await withTimeout(resolveStream(stream), RESOLVE_LIMIT_MS, 'link did not answer')).finalUrl;
        } catch (e) {
          console.warn('[player] skipped', streamLabel(stream).slice(0, 100), String((e as Error)?.message ?? e));
          continue;
        }
        if (stale()) return;
        const exempt =
          allowFlac || stream === chosen || (stream === rememberedSourceRef.current && rememberedPickedRef.current);
        // What the name doesn't say, checked in the file itself: a track
        // list packed with subtitle tracks.
        if (!exempt && !playsPoorly(stream)) {
          const found = await probeFile(finalUrl);
          if (stale()) return;
          if (found.subtitleTracks >= MANY_SUBTITLE_TRACKS) {
            rememberPoor(stream, 'subs');
            console.log(
              '[player] trying it after the rest:',
              streamLabel(stream).slice(0, 80),
              `(${found.subtitleTracks} subtitle tracks)`,
            );
            // Not excluded: a later "next source" walk reaches it again in order.
            excluded.current.delete(stream);
            deferred.push(stream);
            continue;
          }
        }
        if (stale()) return;
        setPhase('opening');
        const result = { stream, finalUrl };
        try {
          await withTimeout(open(result.finalUrl, gen), OPEN_LIMIT_MS, 'player did not open it');
          if (stale()) return;
          setCurrent(result.stream);
          setDuration(av().getDuration() / 1000);
          // The remembered audio language. Changing track leaves this
          // player's audio slightly out of step with the picture — observed
          // on device with a two-track release, whether the switch is made
          // before play or during it, while a single-track release from the
          // same title stayed in sync — and a seek is what lines them back
          // up (it flushes both pipelines). So after any switch, playback
          // starts and then one seek lands it at the start or resume point.
          const audio = readTracks();
          const audioPref = getAudioPrefSync(id);
          const match = audioPref ? matchAudio(audioPref, audio) : undefined;
          let defaultAudio: number | undefined;
          try {
            defaultAudio = av().getCurrentStreamInfo().find(t => t.type === 'AUDIO')?.index;
          } catch {
            // unknown: treat as different
          }
          const playingTrack = match ?? audio.find(t => t.index === defaultAudio) ?? audio[0];
          if (playingTrack && playingTrack.codec === 'flac') {
            rememberPoor(stream, 'flac');
            if (!exempt) {
              console.log('[player] FLAC audio, trying it after the rest:', streamLabel(stream).slice(0, 80));
              excluded.current.delete(stream);
              deferred.push(stream);
              closePlayer();
              continue;
            }
          }
          console.log(
            '[player] playing',
            streamLabel(result.stream).slice(0, 80),
            '| audio pref',
            JSON.stringify(audioPref ?? null),
            '-> track',
            match ? match.label : 'none',
            '| default',
            defaultAudio,
          );
          // Only switch if it's actually a different track — re-selecting the
          // one already playing still reconfigures the audio pipeline.
          // Applied once playback is running (see onFirstFrames): this TV
          // ignores a track change made before play and starts on the file's
          // default — which is why the remembered language wasn't sticking.
          pendingAudioRef.current = match && match.index !== defaultAudio ? match.index : null;
          let resumeAt = 0;
          if (continueAtRef.current > 0) {
            // Switched source mid-watch: carry on from the same moment.
            resumeAt = continueAtRef.current;
            continueAtRef.current = 0;
            resumedRef.current = true;
          } else if (!resumedRef.current) {
            resumedRef.current = true;
            const entry = getHistorySync().find(h => h.id === seriesId);
            const sameEpisode = entry && (type !== 'series' || entry.episodeId === id);
            resumeAt = entry && sameEpisode ? resumePositionFor(entry) : 0;
          }
          if (resumeAt > 0) {
            // Start straight at the saved position.
            await new Promise<void>(done => av().seekTo(resumeAt * 1000, () => done(), () => done()));
            if (stale()) return;
            setTime(resumeAt);
          }
          av().play();
          setPaused(false);
          setPhase('playing');
          if (watchdog.current) clearTimeout(watchdog.current);
          watchdog.current = setTimeout(() => {
            if (!playingRef.current && !stale()) failCurrentRef.current('never started playing');
          }, START_WATCHDOG_MS);
          return;
        } catch (e) {
          console.warn('[player] could not open', streamLabel(result.stream).slice(0, 100), String((e as Error)?.message ?? e));
          if (stale()) return;
          closePlayer();
        }
      }
      if (stale()) return;
      if (deferred.length) {
        // Nothing else played: the FLAC sources it is, in their order.
        for (const st of deferred) excluded.current.delete(st);
        return walkRef.current(deferred, chosen, true);
      }
      setPhase('failed');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const failCurrentRef = useRef((why: string) => {
    console.warn('[player] source failed:', why);
    walkRef.current(candidatesRef.current);
  });
  const walkRef = useRef(walk);
  walkRef.current = walk;

  useEffect(() => {
    if (allStreams === null) return;
    excluded.current = new Set();
    if (candidates.length === 0) {
      setPhase('failed');
      return;
    }
    walk(candidates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allStreams]);

  // ---- Tracks ----------------------------------------------------------------
  const readTracks = (): AudioTrack[] => {
    let tracks: AvTrack[] = [];
    try {
      tracks = av().getTotalTrackInfo();
    } catch {
      return [];
    }
    const audio = tracks.filter(t => t.type === 'AUDIO').map((t, n) => ({ ...audioLabel(t), pos: n + 1 }));
    setAudioTracks(audio);
    let currentAudio = audio[0]?.index ?? null;
    try {
      const cur = av().getCurrentStreamInfo().find(t => t.type === 'AUDIO');
      if (cur) currentAudio = cur.index;
    } catch {
      // first track it is
    }
    setActiveAudio(currentAudio);
    const text = tracks
      .filter(t => t.type === 'TEXT')
      .map((t, n): SubEntry => {
        const x = trackExtra(t);
        const code = x.track_lang || x.language || '';
        const lang = avLang(code);
        return {
          key: `embedded:${t.index}`,
          label: `${lang ? subtitleLangLabel(lang) : code || `Track ${n + 1}`} · in file`,
          lang,
          // Its position among the file's text tracks — what identifies it
          // when (as with many releases) the tracks carry no language.
          name: `track ${n + 1}`,
          source: 'embedded',
          index: t.index,
        };
      });
    setEmbeddedSubs(text);
    return audio;
  };

  // Switches audio track and checks it actually took (the player can refuse
  // or quietly ignore a change mid-seek or mid-buffer), retrying a few
  // times. Once it's in, a seek to the current spot re-syncs the new track
  // with the picture.
  const applyAudio = (index: number, attempt: number) => {
    const retry = () => {
      if (attempt < 3) setTimeout(() => applyAudio(index, attempt + 1), 700);
      else console.warn('[player] audio track', index, 'would not take');
    };
    try {
      av().setSelectTrack('AUDIO', index);
    } catch {
      return retry();
    }
    setTimeout(() => {
      let now: number | undefined;
      try {
        now = av().getCurrentStreamInfo().find(t => t.type === 'AUDIO')?.index;
      } catch {
        // between sources
      }
      if (now !== index) return retry();
      setActiveAudio(index);
      console.log('[player] audio track', index, 'in use');
      try {
        commitSeekRef.current(av().getCurrentTime());
      } catch {
        // between sources
      }
    }, 500);
  };
  const applyAudioRef = useRef(applyAudio);
  applyAudioRef.current = applyAudio;

  const selectAudio = useCallback(
    (index: number, remember: boolean) => {
      setActiveAudio(index);
      applyAudio(index, 0);
      const t = audioTracks.find(a => a.index === index);
      if (remember && t) saveAudioPref(id, audioPrefFor(t)).catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [audioTracks, id],
  );

  // External subtitles (OpenSubtitles), independent of the source.
  useEffect(() => {
    let cancelled = false;
    fetchSubtitles(type, id)
      .then(list => {
        if (cancelled) return;
        setExternalSubs(
          pickSubtitleSet(list).map(sub => {
            const lang = canonicalLang(sub.lang);
            const variant = subtitleVariantLabel(sub);
            return {
              key: `external:${sub.id}`,
              label: [subtitleLangLabel(sub.lang), variant].filter(Boolean).join(' · '),
              lang,
              name: variant,
              source: 'external' as const,
              sub,
            };
          }),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [type, id]);

  const allSubs = useMemo(() => [...embeddedSubs, ...externalSubs], [embeddedSubs, externalSubs]);

  const selectSub = useCallback(
    (key: string | null, remember: boolean) => {
      setCues(null);
      setEmbeddedCue(null);
      const entry = key ? allSubs.find(s => s.key === key) : undefined;
      try {
        if (entry?.source === 'embedded') {
          av().setSelectTrack('TEXT', entry.index);
          av().setSilentSubtitle(false);
        } else {
          av().setSilentSubtitle(true);
        }
      } catch {
        // no text tracks in this source
      }
      if (entry?.source === 'external') {
        fetchSrtCues(entry.sub)
          .then(c => setCues(c))
          .catch(() => setCues([]));
      }
      setActiveSub(entry ? entry.key : null);
      if (remember) {
        saveSubtitlePref(id, entry ? { source: entry.source, lang: entry.lang, name: entry.name } : null).catch(() => {});
      }
    },
    [allSubs, id],
  );

  // Once playback is actually running: resume position, and the history and
  // source bookkeeping. (Remembered audio was applied before play; see walk.)
  const onFirstFrames = () => {
    if (playingRef.current) return;
    playingRef.current = true;
    if (watchdog.current) clearTimeout(watchdog.current);
    // The remembered audio track, now that the player will take it.
    if (pendingAudioRef.current !== null) {
      const index = pendingAudioRef.current;
      pendingAudioRef.current = null;
      setTimeout(() => applyAudioRef.current(index, 0), 400);
    }
    const stream = currentRef.current;

    if (!recordedRef.current) {
      recordedRef.current = true;
      recordWatched({
        id: seriesId,
        type,
        name: seriesName,
        poster,
        background,
        episodeThumbnail,
        episodeLabel,
        episodeId: id,
        isAnime,
        lastResolution: stream ? parseReleaseInfo(stream).resolution : preferredResolution,
      }).catch(() => {});
    }
    // Saved for EVERY source that starts playing, not just the first: a
    // source picked from the Sources menu (or reached by failover) is the
    // one to come back to. Saving only the first one is why resuming went
    // back to the original release after a switch.
    if (stream) {
      console.log('[player] remembering source', streamLabel(stream).slice(0, 90));
      // Still "picked" if it's the source you chose, now or last time.
      const picked =
        stream === pickedRef.current || (stream === rememberedSourceRef.current && rememberedPickedRef.current);
      saveSourcePref(seriesId, { ...describeSource(stream, id), picked }).catch(() => {});
    }
  };
  const currentRef = useRef(current);
  currentRef.current = current;

  // The remembered subtitle choice, re-applied per source: the same kind
  // (in-file vs downloaded) first, matched by language and then by name.
  const autoSubFor = useRef<Stream | null>(null);
  useEffect(() => {
    if (phase !== 'playing' || !current || autoSubFor.current === current) return;
    const pref = getSubtitlePrefSync(id);
    if (pref === undefined || pref === null) {
      autoSubFor.current = current;
      if (activeSub?.startsWith('embedded:')) selectSub(null, false);
      return;
    }
    // In-file tracks often have no language at all; then the remembered
    // track is the one at the same position in the file.
    const embedded = pref.lang
      ? bestTrackMatch(pref, embeddedSubs, e => ({ code: e.lang, name: e.name }))
      : pref.source === 'embedded'
      ? embeddedSubs.find(e => e.name === pref.name) ?? embeddedSubs[0]
      : undefined;
    console.log('[player] subtitle pref', JSON.stringify(pref), '->', embedded ? embedded.key : 'no in-file match');
    if (embedded && pref.source !== 'external') {
      autoSubFor.current = current;
      selectSub(embedded.key, false);
      return;
    }
    if (externalSubs.length === 0) return; // still loading
    autoSubFor.current = current;
    const external = bestTrackMatch(pref, externalSubs, e => ({ code: e.lang, name: e.name }));
    const pick = external?.key ?? embedded?.key;
    if (pick) selectSub(pick, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current, embeddedSubs, externalSubs]);

  // Downloaded subtitles are timed against a fine-grained clock: AVPlay's own
  // time callback only fires about twice a second.
  const [subClock, setSubClock] = useState(0);
  useEffect(() => {
    if (!cues || phase !== 'playing') return;
    const t = setInterval(() => {
      try {
        setSubClock(av().getCurrentTime() / 1000);
      } catch {
        // between sources
      }
    }, 120);
    return () => clearInterval(t);
  }, [cues, phase]);
  const externalCue = useMemo(() => {
    if (!cues) return null;
    const at = subClock - delay;
    return cues.find(c => at >= c.start && at <= c.end) ?? null;
  }, [cues, subClock, delay]);

  // ---- Progress & completion -------------------------------------------------
  useEffect(() => {
    if (phase !== 'playing') return;
    const t = setInterval(() => {
      try {
        const p = av();
        const pos = p.getCurrentTime() / 1000;
        const dur = p.getDuration() / 1000;
        if (playingRef.current && pos > 0 && dur > 0) saveProgress(seriesId, id, pos, dur).catch(() => {});
      } catch {
        // between sources
      }
    }, PROGRESS_SAVE_MS);
    return () => clearInterval(t);
  }, [phase, seriesId, id]);

  // Next episode, looked up from the series record so it's there however
  // this episode was started (and correctly absent on a finale).
  const [next, setNext] = useState<Next | null>(null);
  useEffect(() => {
    if (type !== 'series') return;
    const [sid, s, e] = id.split(':');
    const season = Number(s);
    const episode = Number(e);
    let cancelled = false;
    fetchMeta('series', sid)
      .then(m => {
        if (cancelled || !m?.videos) return;
        const v =
          m.videos.find(x => x.season === season && x.episode === episode + 1) ??
          m.videos.find(x => x.season === season + 1 && x.episode === 1);
        if (v) setNext({ id: v.id, title: `${m.name} S${v.season}E${v.episode}`, label: `S${v.season}E${v.episode}`, thumbnail: v.thumbnail });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [type, id]);

  const goNext = useCallback(() => {
    if (!next) return;
    nav.replace({
      name: 'player',
      params: {
        id: next.id,
        type,
        title: next.title,
        poster,
        background,
        isAnime,
        preferredResolution: current ? parseReleaseInfo(current).resolution : preferredResolution,
        episodeThumbnail: next.thumbnail,
        episodeLabel: next.label,
      },
    });
  }, [next, nav, type, poster, background, isAnime, current, preferredResolution]);

  const onCompletedRef = useRef(() => {});
  onCompletedRef.current = () => {
    if (next) goNext();
    else nav.back();
  };

  // ---- Skip intro / ending ---------------------------------------------------
  const [skip, setSkip] = useState<SkipTimes | null>(null);
  useEffect(() => {
    if (type !== 'series') return;
    const [, s, e] = id.split(':');
    let cancelled = false;
    getSkipTimes(seriesId, seriesName, Number(s), Number(e))
      .then(t => !cancelled && setSkip(t))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [type, id, seriesId, seriesName]);

  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const op = skip?.op;
  const ed = skip?.ed;
  const endingHasTail = Boolean(ed && duration > 0 && duration - ed.end > ENDING_TAIL_MIN_SEC);
  const banner: { label: string; run: () => void } | null =
    op && time >= op.start && time < op.end
      ? { label: 'Skip Intro', run: () => commitSeek(op.end * 1000) }
      : ed && endingHasTail && time >= ed.start && time < ed.end
      ? { label: 'Skip Ending', run: () => commitSeek(ed.end * 1000) }
      : next && time > 0 && (ed ? time >= (endingHasTail ? ed.end : ed.start) : duration > 0 && duration - time < 60)
      ? { label: 'Next Episode', run: goNext }
      : null;
  // Each prompt shows for 15 s, then stays gone for this episode.
  const bannerLabel = banner?.label ?? null;
  useEffect(() => {
    if (!bannerLabel) return;
    const t = setTimeout(() => setDismissed(d => new Set(d).add(bannerLabel)), BANNER_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [bannerLabel]);
  const visibleBanner = banner && !dismissed.has(banner.label) ? banner : null;

  // ---- Seeking ---------------------------------------------------------------
  // Presses accumulate into one target, sent once they stop; only one seek
  // is ever in flight, and a target that moved while it ran is sent after.
  const seekPendingRef = useRef<number | null>(null);
  const [seekPending, setSeekPending] = useState<number | null>(null);
  const seekInFlight = useRef(false);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const burst = useRef({ dir: 0, count: 0, last: 0 });
  const [seekStep, setSeekStep] = useState(0);

  const commitSeek = (targetMs: number) => {
    seekPendingRef.current = targetMs;
    setSeekPending(targetMs / 1000);
    if (seekInFlight.current) return;
    const send = (ms: number, retried: boolean) => {
      seekInFlight.current = true;
      av().seekTo(
        Math.max(0, ms),
        () => {
          seekInFlight.current = false;
          if (seekPendingRef.current !== null && seekPendingRef.current !== ms) return send(seekPendingRef.current, false);
          seekPendingRef.current = null;
          setSeekPending(null);
          setTime(ms / 1000);
        },
        () => {
          seekInFlight.current = false;
          if (!retried) return setTimeout(() => send(seekPendingRef.current ?? ms, true), 400);
          seekPendingRef.current = null;
          setSeekPending(null);
        },
      );
    };
    send(targetMs, false);
  };
  const commitSeekRef = useRef(commitSeek);
  commitSeekRef.current = commitSeek;

  const nudgeSeek = (dir: 1 | -1) => {
    const now = Date.now();
    const b = burst.current;
    if (b.dir === dir && now - b.last < SEEK_BURST_GAP_MS) b.count++;
    else {
      b.dir = dir;
      b.count = 0;
    }
    b.last = now;
    const stepSec = SEEK_STEPS.find(([upTo]) => b.count < upTo)![1];
    setSeekStep(stepSec * dir);
    const step = stepSec * 1000;
    const base = seekPendingRef.current ?? av().getCurrentTime();
    const durMs = duration * 1000;
    const target = Math.max(0, Math.min(durMs > 0 ? durMs - 2000 : Infinity, base + dir * step));
    seekPendingRef.current = target;
    setSeekPending(target / 1000);
    if (seekTimer.current) clearTimeout(seekTimer.current);
    seekTimer.current = setTimeout(() => commitSeek(target), SEEK_COMMIT_MS);
  };

  const togglePause = () => {
    try {
      if (av().getState() === 'PLAYING') {
        av().pause();
        setPaused(true);
      } else {
        av().play();
        setPaused(false);
      }
    } catch {
      // not ready
    }
  };

  // ---- Controls & menus ------------------------------------------------------
  const [controls, setControls] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bump = () => {
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), CONTROLS_HIDE_MS);
  };
  useEffect(() => {
    if (phase === 'playing') bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  useEffect(() => {
    if (paused) {
      setControls(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    }
  }, [paused]);

  const backupAvailable = hasBackupStreamAddons(getSettingsSync());
  const toggleBackup = () => {
    const nextValue = !getSettingsSync().useBackupStreamAddons;
    saveSettings({ useBackupStreamAddons: nextValue }).catch(() => {});
    walkGen.current++;
    closePlayer();
    setPhase('loading');
    setMenu(null);
    setUseBackup(nextValue);
  };

  // Drops the current source and goes on to the next one in the walk's
  // order, picking up at the same moment.
  const continueAtRef = useRef(0);
  const nextSource = () => {
    try {
      continueAtRef.current = av().getCurrentTime() / 1000;
    } catch {
      continueAtRef.current = 0;
    }
    if (current) excluded.current.add(current);
    setMenu(null);
    closePlayer();
    walk(candidates);
  };

  const buttons: Array<{ key: string; label: string; icon?: string; run: () => void }> = [
    { key: 'play', label: paused ? 'Play' : 'Pause', icon: paused ? '▶' : '❚❚', run: togglePause },
  ];
  if (audioTracks.length > 1) buttons.push({ key: 'audio', label: 'Audio', run: () => openMenu('audio') });
  buttons.push({ key: 'subtitles', label: 'Subtitles', run: () => openMenu('subtitles') });
  // No source list to pick from: the walk's order is the one that works on
  // this TV, so the only choice left is "not this one — the next".
  buttons.push({ key: 'nextsrc', label: 'Next Source', run: nextSource });
  if (next) buttons.push({ key: 'next', label: 'Next Episode', run: goNext });

  const [zone, setZone] = useState<'bar' | 'buttons'>('bar');
  const [button, setButton] = useState(0);
  const [menu, setMenu] = useState<Menu>(null);
  const [menuIndex, setMenuIndex] = useState(0);

  // A menu row: `run` on OK, `adjust` on Left/Right (a value changed in
  // place, shown as "‹ Large ›"), or a non-focusable section `header`.
  type MenuItem = {
    label: string;
    detail?: string;
    selected?: boolean;
    header?: boolean;
    run?: () => void;
    adjust?: (dir: 1 | -1) => void;
  };
  const cycle = <T,>(list: T[], at: number, dir: number) => list[(at + dir + list.length) % list.length];
  const setDelayTo = (d: number) => {
    const v = Math.round(d * 100) / 100;
    setDelay(v);
    saveSubtitleDelay(id, v).catch(() => {});
  };
  const sizeLabel = SUBTITLE_SIZES.find(z => z.value === subStyle.size)?.label ?? `${subStyle.size}`;
  const bgLabel = SUBTITLE_BACKGROUNDS.find(b => b.value === subStyle.background)?.label ?? subStyle.background;
  const delayLabel = delay === 0 ? 'In sync' : `${delay > 0 ? '+' : ''}${delay.toFixed(2)}s`;

  // Subtitles: the look-and-timing settings first, adjusted in place with
  // Left/Right, so they're never at the bottom of a long track list; then
  // the tracks.
  const SUBTITLE_SETTINGS = 3;
  const menuItems: MenuItem[] =
    menu === 'audio'
      ? audioTracks.map(t => ({ label: t.label, selected: t.index === activeAudio, run: () => selectAudio(t.index, true) }))
      : menu === 'subtitles'
      ? [
          {
            label: 'Size',
            detail: `‹ ${sizeLabel} ›`,
            adjust: dir => {
              const at = SUBTITLE_SIZES.findIndex(z => z.value === subStyle.size);
              const nextAt = Math.max(0, Math.min(SUBTITLE_SIZES.length - 1, (at < 0 ? 1 : at) + dir));
              applyStyle({ size: SUBTITLE_SIZES[nextAt].value });
            },
          },
          {
            label: 'Background',
            detail: `‹ ${bgLabel} ›`,
            adjust: dir => {
              const at = SUBTITLE_BACKGROUNDS.findIndex(b => b.value === subStyle.background);
              applyStyle({ background: cycle(SUBTITLE_BACKGROUNDS, Math.max(0, at), dir).value });
            },
          },
          {
            label: 'Timing',
            detail: `‹ ${delayLabel} ›`,
            // Right = subtitles later, Left = earlier; OK puts them back in sync.
            adjust: dir => setDelayTo(delay + dir * DELAY_STEP),
            run: () => setDelayTo(0),
          },
          { label: 'Subtitle track', header: true },
          { label: 'Off', selected: activeSub === null, run: () => selectSub(null, true) },
          ...allSubs.map(sub => ({ label: sub.label, selected: sub.key === activeSub, run: () => selectSub(sub.key, true) })),
        ]
      : [];

  // Moves to the next focusable row in `dir`, skipping section headers.
  const stepMenu = (from: number, dir: 1 | -1) => {
    let i = from + dir;
    while (i >= 0 && i < menuItems.length && menuItems[i].header) i += dir;
    return i >= 0 && i < menuItems.length ? i : from;
  };

  const openMenu = (m: Menu) => {
    setMenu(m);
    // Opens on the current choice.
    const at =
      m === 'audio'
        ? audioTracks.findIndex(t => t.index === activeAudio)
        : SUBTITLE_SETTINGS + 1 + (activeSub ? allSubs.findIndex(sub => sub.key === activeSub) + 1 : 0);
    setMenuIndex(Math.max(0, at));
  };

  // ---- Keys --------------------------------------------------------------------
  useKeys(
    (code, e) => {
      if (phase !== 'playing') {
        if (code === KEY.BACK) {
          walkGen.current++;
          nav.back();
          return;
        }
        if (code === KEY.ENTER && phase === 'resolving' && backupAvailable) toggleBackup();
        if (code === KEY.ENTER && phase === 'failed') {
          if (backupAvailable) toggleBackup();
          else nav.back();
        }
        return;
      }

      if (menu) {
        switch (code) {
          case KEY.UP:
            setMenuIndex(stepMenu(menuIndex, -1));
            return;
          case KEY.DOWN:
            setMenuIndex(stepMenu(menuIndex, 1));
            return;
          case KEY.LEFT:
          case KEY.RIGHT: {
            const item = menuItems[menuIndex];
            if (item?.adjust) item.adjust(code === KEY.RIGHT ? 1 : -1);
            else if (code === KEY.LEFT) {
              setMenu(null);
              bump();
            }
            return;
          }
          case KEY.ENTER: {
            const item = menuItems[menuIndex];
            if (item?.run) item.run();
            else item?.adjust?.(1);
            if (menu === 'audio') setMenu(null);
            return;
          }
          case KEY.BACK:
            setMenu(null);
            bump();
            return;
          default:
            return;
        }
      }

      switch (code) {
        case KEY.PLAY_PAUSE:
        case KEY.PLAY:
        case KEY.PAUSE:
          togglePause();
          bump();
          return;
        case KEY.FAST_FORWARD:
          nudgeSeek(1);
          bump();
          return;
        case KEY.REWIND:
          nudgeSeek(-1);
          bump();
          return;
        case KEY.STOP:
          nav.back();
          return;
        case KEY.NEXT:
          goNext();
          return;
        case KEY.BACK:
          if (controls && !paused) {
            setControls(false);
            return;
          }
          nav.back();
          return;
      }

      // A Skip Intro / Next Episode prompt takes OK whenever it's up, unless
      // focus is down on the button row.
      if (code === KEY.ENTER && visibleBanner && !(controls && zone === 'buttons')) {
        visibleBanner.run();
        setDismissed(d => new Set(d).add(visibleBanner.label));
        return;
      }

      if (!controls) {
        // Controls hidden: Left/Right seek straight away; anything else just
        // brings the controls back.
        if (code === KEY.LEFT || code === KEY.RIGHT) {
          setZone('bar');
          nudgeSeek(code === KEY.RIGHT ? 1 : -1);
        }
        bump();
        return;
      }

      bump();
      switch (code) {
        case KEY.LEFT:
        case KEY.RIGHT:
          if (zone === 'bar') nudgeSeek(code === KEY.RIGHT ? 1 : -1);
          else setButton(Math.max(0, Math.min(buttons.length - 1, button + (code === KEY.RIGHT ? 1 : -1))));
          return;
        case KEY.UP:
          if (zone === 'buttons') setZone('bar');
          return;
        case KEY.DOWN:
          if (zone === 'bar') setZone('buttons');
          return;
        case KEY.ENTER:
          if (zone === 'bar') togglePause();
          else buttons[button]?.run();
          return;
        default:
          return false;
      }
    },
    active,
  );

  // ---- Render ------------------------------------------------------------------
  if (phase !== 'playing') {
    return (
      <div className="screen">
        {background && (
          <div className="detail-backdrop" style={{ backgroundImage: `url("${background}")`, opacity: 0.25 }} />
        )}
        <div className="center">
          <div className="player-title">{title}</div>
          {phase === 'failed' ? (
            <>
              <div className="error-text">No working source could be found for this title.</div>
              <div className="error-actions">
                <div className="btn focused">{backupAvailable ? (useBackup ? 'Use main sources' : 'Use backup sources') : 'Go back'}</div>
              </div>
            </>
          ) : (
            <>
              <div className="spinner" style={{ marginTop: 40 }} />
              <div className="resolving">
                {phase === 'loading' ? 'Finding sources…' : (
                  <>
                    Trying <b>{attempt.slice(0, 90)}</b>
                  </>
                )}
              </div>
              {backupAvailable && phase !== 'loading' && (
                <div className="error-actions">
                  <div className="btn">{useBackup ? 'OK: use main sources' : 'OK: use backup sources'}</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const shownTime = seekPending ?? time;
  const pct = duration > 0 ? Math.min(100, (shownTime / duration) * 100) : 0;
  const info = current ? parseReleaseInfo(current) : null;
  const subText = externalCue ? externalCue.text : embeddedCue;
  const segments = subText ? parseCueSegments(cleanMarkup(subText)) : [];

  return (
    <div className="screen transparent">
      {segments.length > 0 && (
        <div className={`subtitles ${subStyle.background}${controls ? ' raised' : ''}`} style={{ fontSize: subStyle.size * SUBTITLE_SCALE }}>
          {segments.map((s, i) => (
            <span
              key={i}
              style={{ fontStyle: s.italic ? 'italic' : undefined, fontWeight: s.bold ? 800 : undefined, textDecoration: s.underline ? 'underline' : undefined }}>
              {s.text}
            </span>
          ))}
        </div>
      )}

      {buffering && (
        <div className="center">
          <div className="spinner" />
        </div>
      )}
      {paused && !buffering && !menu && (
        <div className="center">
          <div className="paused-icon">▶</div>
        </div>
      )}

      <div className={controls ? 'player-top' : 'player-top hidden'}>
        <div className="player-title">{title}</div>
        {info && current && (
          <div className="player-release">
            {[
              info.resolution,
              info.codec,
              info.container,
              isFlac(current) ? 'FLAC – may lag on this TV' : '',
              knownAs(current, 'subs') ? 'many subtitle tracks – may smear on this TV' : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        )}
      </div>

      <div className={controls ? 'player-bottom' : 'player-bottom hidden'}>
        <div className={zone === 'bar' ? 'progress focused' : 'progress'}>
          <div className="progress-fill" style={{ width: `${pct}%` }} />
          {seekPending !== null && <div className="progress-pending" style={{ left: `${pct}%` }} />}
        </div>
        <div className="player-times">
          <span>{fmt(shownTime)}</span>
          {seekPending !== null && seekStep !== 0 && (
            <span className="seek-step">
              {seekStep > 0 ? '▶▶' : '◀◀'} {Math.abs(seekStep) >= 60 ? `${Math.abs(seekStep) / 60} min` : `${Math.abs(seekStep)} s`}
            </span>
          )}
          <span>{duration > 0 ? `-${fmt(duration - shownTime)}` : ''}</span>
        </div>
        <div className="player-buttons">
          {buttons.map((b, i) => (
            <div key={b.key} className={zone === 'buttons' && i === button ? 'btn focused' : 'btn'}>
              {b.icon ? <span className="btn-icon">{b.icon}</span> : null}
              {b.label}
            </div>
          ))}
        </div>
      </div>

      {visibleBanner && !menu && (
        <div className={controls ? 'side-banner raised' : 'side-banner'}>{visibleBanner.label}</div>
      )}

      {fatal && (
        <div className="banner">Playback stopped ({fatal}). Open Sources to try another release.</div>
      )}

      {menu && (
        <div className="menu">
          <div className="menu-heading">{menu === 'audio' ? 'Audio' : 'Subtitles'}</div>
          {/* Its own clipped area below the heading, scrolled to keep the
              focused row in view — never sliding under the heading or off
              the bottom of the panel. */}
          <div className="menu-list">
            <div
              className="menu-track"
              style={{
                transform: `translateY(${-Math.max(0, Math.min(menuIndex - 4, menuItems.length - MENU_VISIBLE)) * MENU_ROW_H}px)`,
              }}>
              {menuItems.map((m, i) =>
                m.header ? (
                  <div key={i} className="menu-section">
                    {m.label}
                  </div>
                ) : (
                  <div key={i} className={['menu-item', m.selected ? 'selected' : '', i === menuIndex ? 'focused' : ''].join(' ')}>
                    {m.selected ? '✓  ' : ''}
                    {m.label}
                    {m.detail ? <small>{m.detail}</small> : null}
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
