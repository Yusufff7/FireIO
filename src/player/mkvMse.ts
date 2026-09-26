import { MediaSource, type SourceBuffer } from '@amazon-devices/react-native-w3cmedia';
import MkvDemuxModule, {
  type MkvDemuxAudioTrack,
  type MkvDemuxCluster,
  type MkvDemuxFindClustersResult,
  type MkvDemuxInitResult,
  type MkvDemuxSubtitleTrack,
} from '@amazon-devices/mkvdemuxmodule';
import { parseCueSegments, type SrtCue } from '../addons/subtitles';

// Feeds a remuxed fragmented-MP4 stream into a MediaSource, instead of
// handing an MKV URL straight to the player's `.src` — or, as an earlier
// version of this file did, feeding raw Matroska bytes into an MSE
// SourceBuffer directly.
//
// That raw-Matroska approach played back fine but did NOT fix seeking:
// device testing showed the exact same native failure (`Internal error 0` /
// `MPB Call failed with code: 50004`) through MSE as over a plain
// progressive URL, and a follow-up test proved it wasn't a codec issue
// either (HEVC-in-MP4 seeks correctly on this platform). The failure is
// specific to Matroska container parsing, at a layer MSE's own
// `video/x-matroska` SourceBuffer still has to go through internally —
// wrapping the bytes in MSE never bypassed it.
//
// So this module now remuxes MKV into fragmented MP4 on the fly (via
// MkvDemuxModule's openRemuxSession/remuxChunk, one independent session per
// track — see MkvDemuxCore.h's comment on openRemuxSession for why video
// and audio are two completely separate fMP4 streams, each fed to its own
// SourceBuffer) and feeds THAT to MSE, since MP4 is what's confirmed to
// seek correctly here.
//
// Cues (a time->byte-offset index) still isn't something these files
// reliably have, so seeking into a not-yet-buffered region is handled the
// same way ExoPlayer's MatroskaExtractor falls back when Cues are missing:
// estimate a byte offset proportionally from (targetTime / duration),
// probe it via findClusters (unrelated to remuxing — just Cluster
// boundaries and timecodes, cheap to call speculatively), and refine from
// the Cluster timecode actually found there.

const INIT_FETCH_START = 2 * 1024 * 1024;
const INIT_FETCH_MAX = 32 * 1024 * 1024;
const CHUNK_SIZE = 4 * 1024 * 1024;
const SEEK_PROBE_CHUNK = 2 * 1024 * 1024;
const MAX_SEEK_ESTIMATE_ITERATIONS = 6;
const SEEK_TOLERANCE_SEC = 4;
const BUFFER_AHEAD_TARGET_SEC = 60;
const BUFFER_KEEP_BEHIND_SEC = 30;
const FORWARD_LOOP_INTERVAL_MS = 500;
// Ceiling on the backed-off retry delay after consecutive stalls (see
// startForwardLoop) — without a cap, a source that never recovers would
// have the loop backing off forever instead of settling into a steady,
// bounded polling cadence.
const FORWARD_LOOP_MAX_STALL_INTERVAL_MS = 8000;
// How many consecutive 'stalled' windows the forward loop retries with a
// growing back-off before settling into slow polling at the ceiling. A single stall is routinely transient — a slow range
// request, a window that happened to land on no complete Cluster, a hiccup
// right after a seek — and used to kill the loop permanently on the very
// first one (see startForwardLoop); this many in a row is what actually
// means the source is gone.
const MAX_CONSECUTIVE_STALLS = 10;

// Matroska CodecIDs MkvDemuxCore's native remuxer actually knows how to
// remux — kept in sync with MkvDemuxCore.cpp's remuxKindForCodecId(). A
// track outside this set means remux (and therefore this whole MSE path)
// isn't attempted; the caller falls back to direct-URL playback, same as
// today's behavior for any other unsupported case.
function isRemuxableVideoCodecId(codecId: string): boolean {
  return codecId === 'V_MPEG4/ISO/AVC' || codecId === 'V_MPEGH/ISO/HEVC';
}
// Candidate RFC 6381 codec strings for each remuxable Matroska audio
// CodecID, in preference order; an empty list means the native remuxer
// can't handle that codec at all. There's more than one per codec because
// isTypeSupported isn't just a table lookup: after the static
// MimeTypeRegistry check (which accepts every string here, case-
// insensitively) it asks the platform decoder-capability query
// (isCodecSupportedByPlatform), whose own spelling rules aren't documented.
// Trying the registry's alternate spelling costs one extra call and means an
// unrecognised spelling can't silently drop a whole track's audio.
function audioCodecCandidates(codecId: string): string[] {
  // AAC-LC: the exact profile can't be told from the CodecID alone, and the
  // registry only lists fully-qualified "mp4a.40.x" strings, never bare "aac".
  if (codecId === 'A_AAC' || codecId.startsWith('A_AAC/')) return ['mp4a.40.2'];
  if (codecId.startsWith('A_AC3')) return ['ac-3', 'mp4a.a5'];
  if (codecId === 'A_EAC3') return ['ec-3', 'mp4a.a6'];
  if (codecId === 'A_FLAC') return ['flac', 'fLaC'];
  if (codecId === 'A_OPUS') return ['opus', 'Opus'];
  // TrueHD's MP4 sample entry — listed by the platform's MP4 audio table.
  // Whether this device can DECODE it (rather than only pass it through
  // over HDMI) is down to the capability query; if it says no, the track is
  // simply unplayable here and prepare() falls back to direct-URL playback.
  if (codecId === 'A_TRUEHD') return ['mlpa'];
  return [];
}

// Memoized: each isTypeSupported call is a synchronous native capability
// query, and the Audio menu asks about every track on every render.
const supportedAudioMimeCache = new Map<string, string | null>();
function supportedAudioMime(codecId: string): string | null {
  const cached = supportedAudioMimeCache.get(codecId);
  if (cached !== undefined) return cached;
  let found: string | null = null;
  for (const codec of audioCodecCandidates(codecId)) {
    const mime = `audio/mp4; codecs="${codec}"`;
    if (MediaSource.isTypeSupported(mime)) {
      found = mime;
      break;
    }
  }
  supportedAudioMimeCache.set(codecId, found);
  return found;
}

// ASS/SSA Block payloads are "ReadOrder,Layer,Style,Name,MarginL,MarginR,
// MarginV,Effect,Text" — keep the Text field (everything after the 8th
// comma, since Text itself may contain commas), drop {override} blocks, and
// turn \N / \n breaks into real newlines. Mirrors MkvDemuxCore.cpp's
// extractAssDialogueText; done here because cues for every track now come
// back from one native call as raw payloads (see extractEmbeddedCues).
function assDialogueText(payload: string): string {
  let i = 0;
  let commas = 0;
  for (; i < payload.length && commas < 8; i++) {
    if (payload[i] === ',') commas++;
  }
  const text = commas === 8 ? payload.slice(i) : payload;
  return text.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n');
}

function describeRanges(sb: SourceBuffer | null): string {
  if (!sb) return '-';
  try {
    const b = sb.buffered;
    const parts: string[] = [];
    for (let i = 0; i < b.length; i++) parts.push(`${b.start(i).toFixed(1)}-${b.end(i).toFixed(1)}`);
    return parts.length ? parts.join(',') : 'empty';
  } catch {
    return '?';
  }
}

// MkvDemuxCore's videoCodecFamily() emits bare MSE codec family tags
// ("hev1", "avc1") with no RFC 6381 profile/level suffix. The platform's
// SourceBuffer codec check (MimeTypeRegistry.checkSupportedType, read
// directly from node_modules) does a prefix match for video codecs, so a
// bare tag matches fine. Audio is an EXACT match instead, hence
// audioCodecCandidates above working from the CodecID.
function videoCodecsParam(family: string): string | null {
  return family === 'avc1' || family === 'hev1' ? family : null;
}

// Derived rather than referencing the `AbortSignal` type name directly —
// this codebase's ESLint config recognizes `AbortController` as a global
// (it's used as a value everywhere) but not `AbortSignal`, which only ever
// appears in type position and trips `no-undef`.
type AbortSignalLike = InstanceType<typeof AbortController>['signal'];

function parseContentRangeTotal(headerVal: string | null): number | undefined {
  if (!headerVal) return undefined;
  const m = /\/(\d+)\s*$/.exec(headerVal);
  return m ? Number(m[1]) : undefined;
}

async function fetchRange(
  url: string,
  start: number,
  end: number,
  signal: AbortSignalLike,
): Promise<{ buf: ArrayBuffer; total?: number }> {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (!r.ok) throw new Error(`range fetch failed: ${r.status}`);
  const buf = await r.arrayBuffer();
  return { buf, total: parseContentRangeTotal(r.headers.get('content-range')) };
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of b64) {
    if (c === '=') break;
    const v = table.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes).buffer;
}

// remuxChunk's return layout: 8 bytes little-endian bytesConsumed, then the
// muxed fMP4 bytes for this call — see MkvDemuxCore.h's own comment on it.
function splitRemuxResult(result: ArrayBuffer): { bytesConsumed: number; muxed: ArrayBuffer } {
  const view = new DataView(result);
  const bytesConsumed = Number(view.getBigUint64(0, true));
  return { bytesConsumed, muxed: result.slice(8) };
}

type PlayerLike = { srcObject: unknown };

export class MkvMseSession {
  private readonly url: string;
  private readonly abort = new AbortController();
  private mediaSource: MediaSource | null = null;
  private videoSourceBuffer: SourceBuffer | null = null;
  private audioSourceBuffer: SourceBuffer | null = null;
  private videoAppendQueue: Promise<void> = Promise.resolve();
  private audioAppendQueue: Promise<void> = Promise.resolve();

  private videoSessionId = -1;
  private audioSessionId = -1; // -1 whenever audio isn't remuxed (unsupported codec, or dropped after an isTypeSupported failure)
  // Which Matroska track number audioSessionId is currently open on —
  // undefined whenever audio isn't remuxed at all. Lets switchAudioTrack
  // know both what the current pick is (for the track menu's checkmark)
  // and, together with initResult.audioTracks, whether a requested switch
  // is actually a no-op.
  private activeAudioTrackNumber: number | undefined;

  // Embedded (in-MKV) subtitle extraction — see selectEmbeddedSubtitleTrack.
  // Unlike audio/video there's no SourceBuffer or remux session involved:
  // cues are just (start, end, text) triples the app-level overlay already
  // knows how to render (see PlayerScreen's activeCues/findCue), so this is
  // extraction only, piggybacked on the SAME bytes fetchAndAppendWindow is
  // already pulling down for video/audio — zero extra network cost, at the
  // price of only ever having cues for territory that's actually been
  // fetched (same tradeoff the seek Cluster index already makes).
  //
  // Cues are harvested for EVERY text subtitle track on every window, not
  // just the selected one. Extracting only the selected track (as an
  // earlier version did) meant picking a track mid-playback showed nothing
  // for a minute or more: the forward loop keeps ~60s buffered ahead, so all
  // of that territory had already been fetched — and its cues skipped —
  // before the selection was made. On-device that read as "I select the
  // embedded subtitles and they never show up".
  private activeSubtitleTrack: number | undefined;
  private subtitleTrackIsAss = new Map<number, boolean>();
  // Bitmask of text subtitle track numbers (bit N = track N), passed to
  // native negated — see MkvDemuxModule.cpp's extractTextCues. Kept as a
  // plain number rather than built with bitwise ops, which truncate to 32
  // bits in JS; tracks up to 52 fit exactly in a double.
  private subtitleTrackMask = 0;
  private cuesByTrack = new Map<number, SrtCue[]>();
  // De-dupes cues across windows whose byte ranges happen to overlap (a
  // seek's landing window can re-cover a few bytes of already-fetched
  // territory) — start+text is a cheap, good-enough identity for a cue.
  private cueKeysByTrack = new Map<number, Set<string>>();

  // Which audio track the audio session plays — chosen in prepare() as the
  // file's default track if this platform can decode it, otherwise the
  // first one it can (see pickAudioTrack).
  private audioTrack: MkvDemuxAudioTrack | undefined;
  // Diagnostics only — surfaced by logDiagnostics.
  private audioAppendCount = 0;
  private audioAppendBytes = 0;
  private lastDiagnosticsAt = 0;

  private fileSize: number | undefined;
  private initSegmentEnd = 0;
  private timestampScale = 1000000;
  private durationSeconds = 0;
  // Every complete Cluster we've ever found via findClusters, in discovery
  // order — used both to answer "do we already know a byte offset near
  // this timestamp" for a rewind/re-seek, and to refine a proportional
  // estimate for a seek into territory we haven't scanned yet. Purely a
  // timing index; unrelated to which bytes have actually been remuxed and
  // appended. Small enough for a whole episode (dozens to low hundreds of
  // entries) that a linear scan is fine.
  private clusters: MkvDemuxCluster[] = [];
  // Where the sequential forward-playback loop fetches next. A forward seek
  // that lands ahead of this moves it up; a rewind never moves it back, so
  // the forward loop doesn't re-walk territory it's already passed.
  private nextFetchOffset = 0;
  private lastTrimAt = 0;

  // Kept so a seek can re-open both remux sessions positioned somewhere
  // else in the file — see restartAt for why seeking has to work that way.
  private initResult: MkvDemuxInitResult | null = null;
  private videoMime = '';
  private audioMime: string | null = null;
  // Aborts only the fetches belonging to the CURRENT playback position, so
  // a seek can cancel work for the position it's abandoning without
  // poisoning the session-wide `abort` that dispose() owns.
  private epochAbort = new AbortController();

  private forwardLoopHandle: ReturnType<typeof setTimeout> | undefined;
  // Consecutive 'stalled' outcomes from fetchAndAppendNext, reset to 0 by
  // any 'appended' window — see startForwardLoop's stall handling.
  private consecutiveStalls = 0;
  // Set once the forward loop has fetched the last byte of the file (and
  // called endOfStream); cleared by any seek — see startForwardLoop.
  private reachedEof = false;
  private getCurrentTime: () => number = () => 0;
  private seekInProgress = false;
  // Bumped at the start of every restartAt call — lets an overlapping
  // call (a second seek arriving before the first's fetch work finishes)
  // supersede it cleanly. Without this, the FIRST call's own `finally`
  // clears `seekInProgress` the moment IT settles, regardless of whether a
  // second seek's fetch is still running — re-enabling the forward loop
  // mid-seek, which then raced its own fetchAndAppendWindow call against
  // the still-in-flight seek's, corrupting the sequential nextFetchOffset
  // cursor.
  private seekGeneration = 0;
  private disposed = false;

  constructor(url: string) {
    this.url = url;
  }

  get duration(): number {
    return this.durationSeconds;
  }

  // Fetches and parses the init segment, opens a remux session per usable
  // track, checks whether this platform's MSE can actually play the
  // resulting MP4 codecs, and — only if so — attaches a MediaSource to
  // `player`, opens one SourceBuffer per track, and appends the first data
  // chunk so there's something to play immediately. Returns false (after
  // fully cleaning up) if MSE playback isn't viable for this file; the
  // caller should fall back to its existing direct-URL `.src` path in that
  // case.
  async prepare(player: PlayerLike, getCurrentTime: () => number): Promise<boolean> {
    try {
      const initFetch = await this.fetchInitSegment();
      if (!initFetch) return false;
      const { result } = initFetch;

      if (!isRemuxableVideoCodecId(result.videoCodecId) || result.videoDefaultDurationNs <= 0) return false;
      const videoParam = videoCodecsParam(result.videoCodec);
      if (!videoParam) return false;

      const videoMime = `video/mp4; codecs="${videoParam}"`;
      if (!MediaSource.isTypeSupported(videoMime)) return false;

      // A file WITH audio but no track this path can play (TrueHD/DTS-only
      // releases, most commonly) goes to direct-URL playback instead: the
      // platform's own Matroska pipeline plays those codecs with sound, it
      // just can't seek — and silent-but-seekable proved the worse trade on
      // device. A file with no audio tracks at all still plays here.
      const audioPick = this.pickAudioTrack(result);
      if (!audioPick && (result.audioTracks?.length || result.audioCodecId)) {
        console.warn('MkvMseSession: no playable audio track, falling back to direct URL for sound');
        return false;
      }
      const audioMime = audioPick?.mime ?? null;
      this.audioTrack = audioPick?.track;
      console.warn(
        `MkvMseSession: video ${result.videoCodecId} as ${videoMime}; audio ${
          audioPick ? `track ${audioPick.track.trackNumber} ${audioPick.track.codecId} as ${audioMime}` : 'NONE (silent)'
        }`,
      );

      this.initResult = result;
      this.videoMime = videoMime;
      this.audioMime = audioMime;
      this.initSubtitleTracks();
      if (!this.openSessions()) return false;

      this.initSegmentEnd = result.initSegmentEnd;
      this.timestampScale = result.timestampScale;
      this.durationSeconds = result.durationSeconds;
      this.nextFetchOffset = result.initSegmentEnd;
      this.getCurrentTime = getCurrentTime;

      const ms = new MediaSource();
      this.mediaSource = ms;
      const opened = new Promise<void>(resolve => {
        const onOpen = () => {
          ms.removeEventListener('sourceopen', onOpen);
          resolve();
        };
        ms.addEventListener('sourceopen', onOpen);
      });
      // Assigning srcObject is what triggers the sourceopen handshake —
      // constructing the MediaSource alone does nothing.
      player.srcObject = ms;
      await opened;
      if (this.disposed) return false;

      this.videoSourceBuffer = ms.addSourceBuffer(videoMime);
      if (audioMime) this.audioSourceBuffer = ms.addSourceBuffer(audioMime);
      if (this.durationSeconds > 0) {
        try {
          ms.duration = this.durationSeconds;
        } catch {
          // Some implementations reject a duration write before the first
          // append; harmless either way; each SourceBuffer's own buffered
          // ranges are what actually drive playback and seeking.
        }
      }

      await this.fetchAndAppendNext();
      if (this.disposed) return false;

      this.startForwardLoop();
      return true;
    } catch (e) {
      console.warn('MkvMseSession: prepare failed, falling back to direct URL —', e);
      this.dispose();
      return false;
    }
  }

  // Repositions playback to `targetSeconds` and returns the media time it
  // actually landed on (Cluster boundaries are the finest granularity a
  // Matroska file offers), or null if it couldn't get there — in which
  // case the caller must leave currentTime alone.
  //
  // This does NOT ask the player to seek, because the remuxed stream has no
  // seekable timeline to seek within. minimp4 writes fragments with no tfdt
  // box (MP4D_TFDT_SUPPORT is 0), so a fragment carries no notion of where
  // in the source it came from; the player builds its timeline purely by
  // accumulating fragment durations in append order. Feeding it bytes from
  // ten minutes in just makes those frames "the next second of video".
  // That is why every earlier seek attempt looked healthy in the logs —
  // currentTime advanced, buffered ranges grew, no errors — while the
  // picture never actually moved to the requested position.
  //
  // So a seek is a restart instead: throw away the remux sessions and the
  // buffered data, open fresh sessions positioned at the target's byte
  // offset, and use timestampOffset to declare that this new stream (which
  // again starts at zero) belongs at `landedSeconds` on the media timeline.
  // Native drops frames until a real keyframe so the decoder never gets a
  // mid-GOP frame it can't decode (see MkvDemuxCore.cpp's
  // waitingForKeyframe).
  // Locates the byte offset/media-time a target second value actually lands
  // on — the network-I/O part of a seek, shared by restartAt (which
  // rebuilds video+audio there) and switchAudioTrack (which rebuilds only
  // the audio session there, at whatever second is currently playing).
  // `stale` is the caller's own generation check, so an overlapping newer
  // call from either method can still supersede this one cleanly.
  private async findLandingOffset(
    targetSeconds: number,
    stale: () => boolean,
  ): Promise<{ offset: number; sec: number } | undefined> {
    // A known Cluster only counts if it's actually NEAR the target. The
    // index only holds Clusters from windows already fetched — territory
    // around where playback currently is — so for any real jump the
    // "nearest known Cluster at or before the target" is just the last one
    // downloaded, a second or two ahead. Taking it meant every forward
    // press crept forward by a couple of seconds instead of jumping, and
    // because it returned something, the byte-offset probe below (the part
    // that can actually reach unvisited territory) never ran at all.
    const known = this.findNearestKnownCluster(targetSeconds);
    if (known && targetSeconds - known.sec <= SEEK_TOLERANCE_SEC) return known;
    if (!(this.durationSeconds > 0) || this.fileSize === undefined) return undefined;

    // Bracketing search: track the tightest known [lowOffset,lowSec] at or
    // before the target and [highOffset,highSec] at or after it, and
    // interpolate the NEXT probe from those two real samples instead of
    // extrapolating from a single file-wide average bitrate. A global
    // average is a poor model for real encodes — bitrate routinely varies
    // 2-3x between static and busy scenes — so extrapolating one probe with
    // it regularly overshot or undershot by tens of seconds on a big jump,
    // burning through MAX_SEEK_ESTIMATE_ITERATIONS before landing within
    // tolerance. That's what made large forward skips fail outright:
    // restartAt returned null, and since a failed seek deliberately leaves
    // currentTime alone, the scrub bar's optimistic position snapped back
    // to wherever playback actually still was — "it rewinds back".
    // Interpolating between two real bracketing samples self-corrects for
    // local bitrate and converges reliably in a handful of iterations even
    // on a big jump, since the function (byte offset -> timecode) is
    // monotonic.
    let lowOffset = this.initSegmentEnd;
    let lowSec = 0;
    let highOffset = this.fileSize;
    let highSec = this.durationSeconds;
    let estOffset = this.estimateByteOffset(targetSeconds);
    for (let i = 0; i < MAX_SEEK_ESTIMATE_ITERATIONS; i++) {
      let probe = await this.probeAt(estOffset);
      if (stale()) return undefined;
      if (!probe) {
        // Sparse territory — this window happened to hold no complete
        // Cluster (a long GOP, or a big non-video Cluster before the next
        // one). Retry once with a much bigger window rather than giving up
        // the whole search on a single empty probe.
        probe = await this.probeAt(estOffset, SEEK_PROBE_CHUNK * 6);
        if (stale()) return undefined;
        if (!probe) return undefined;
      }
      const diff = targetSeconds - probe.timecodeSec;
      if (Math.abs(diff) < SEEK_TOLERANCE_SEC) return { offset: probe.offset, sec: probe.timecodeSec };
      if (probe.timecodeSec <= targetSeconds) {
        lowOffset = probe.offset;
        lowSec = probe.timecodeSec;
      } else {
        highOffset = probe.offset;
        highSec = probe.timecodeSec;
      }
      estOffset =
        highSec > lowSec
          ? Math.round(lowOffset + ((targetSeconds - lowSec) * (highOffset - lowOffset)) / (highSec - lowSec))
          : lowOffset;
      estOffset = Math.max(this.initSegmentEnd, Math.min(this.fileSize - 1, estOffset));
    }
    return undefined;
  }

  async restartAt(targetSeconds: number): Promise<number | null> {
    if (this.disposed || !this.videoSourceBuffer) return null;

    // Captured once, up front: if a second seek arrives (bumping
    // seekGeneration again) while this one is still awaiting a fetch, every
    // check below sees the mismatch and this call quietly abandons the rest
    // of its own work — the newer call is the one whose fetch result and
    // whose `finally` gets to decide when seeking is actually done.
    const myGeneration = ++this.seekGeneration;
    const stale = () => this.seekGeneration !== myGeneration;

    this.seekInProgress = true;
    try {
      const landing = await this.findLandingOffset(targetSeconds, stale);
      if (!landing || stale()) return null;

      // Everything from here down is local and effectively can't fail.
      // Cancel fetches for the position being abandoned so a slow response
      // can't append into the new stream after the reset below.
      this.epochAbort.abort();
      this.epochAbort = new AbortController();
      this.videoAppendQueue = Promise.resolve();
      this.audioAppendQueue = Promise.resolve();

      this.closeSessions();
      if (!this.openSessions()) return null;

      await this.resetSourceBuffer(this.videoSourceBuffer, landing.sec);
      if (this.audioSourceBuffer) await this.resetSourceBuffer(this.audioSourceBuffer, landing.sec);
      if (stale()) return null;

      this.nextFetchOffset = landing.offset;
      this.lastTrimAt = 0;
      this.reachedEof = false;
      this.consecutiveStalls = 0;

      // One window is enough to start on: it's ~4MB, and the forward loop
      // takes over from here. If this window happens to hold no keyframe
      // at all, keep pulling — the appends are what make the position
      // playable, and stopping early is what left playback frozen at the
      // landing point in an earlier version of this.
      let appendedAny = false;
      for (let i = 0; i < MAX_SEEK_ESTIMATE_ITERATIONS && !appendedAny; i++) {
        if (stale()) return null;
        const before = this.videoSourceBuffer.buffered.length;
        const ok = await this.fetchAndAppendWindow(this.nextFetchOffset, CHUNK_SIZE);
        if (stale()) return null;
        if (!ok) break;
        appendedAny = this.videoSourceBuffer.buffered.length > before || this.isBuffered(landing.sec);
      }

      return appendedAny ? landing.sec : null;
    } finally {
      if (!stale()) this.seekInProgress = false;
    }
  }

  // Drops everything currently buffered and declares that whatever gets
  // appended next — a fresh remux session's output, which always starts its
  // own timeline at zero — belongs at `offsetSeconds` on the media
  // timeline. Without the offset, restarting mid-file would append content
  // labelled from zero and overwrite the beginning of the movie.
  private async resetSourceBuffer(sb: SourceBuffer, offsetSeconds: number): Promise<void> {
    // ALWAYS abort, not just when `updating` — this is the single most
    // important line in the seek path, and gating it on `updating` (as an
    // earlier version did) is what made forward seeking fail intermittently
    // and then freeze the picture outright.
    //
    // abort() is not merely "cancel the in-flight append". Per the MSE spec
    // it runs the *reset parser state* algorithm, which clears the
    // SourceBuffer's coded-frame-processing state — `last_decode_timestamp`,
    // `last_frame_duration`, `highest_end_timestamp`,
    // `need_random_access_point_flag`. remove() does NOT clear any of that:
    // it drops buffered media but leaves the frame processor still believing
    // the next sample must follow the last one it saw.
    //
    // That mattered because the forward loop buffers ~60s AHEAD of playback.
    // Seek to 49s, let it buffer out to ~77s, then seek to 61s: the data is
    // correctly removed and re-appended at 61s, but the frame processor's
    // last_decode_timestamp is still 76.8s, so the 61s samples look like
    // time running backwards. Confirmed verbatim from a device log:
    //   "Discontinuity found for sample at PTS 61478000 DTS 61478000,
    //    because last_decode_timestamp was 76784000"
    // The decoder then stalls while the SourceBuffer keeps happily
    // accepting appends — buffered ranges grew 61s->108s with the picture
    // frozen on one frame, which is exactly the reported symptom.
    //
    // It was intermittent rather than constant purely because of the
    // `updating` gate: a seek that happened to land mid-append DID abort and
    // therefore worked, while one landing in an idle moment did not. Hence
    // "forwarding kinda worked but then broke".
    //
    // Ordering matters: abort() first (it also cancels any pending
    // append/remove), then remove() to drop the data, then set the offset
    // once the remove has settled.
    //
    // abort() is called a second time after the remove, too. abort() throws
    // unless the MediaSource is "open", and it is NOT open once playback has
    // reached the end of the file: the forward loop calls endOfStream()
    // there, which moves it to "ended". So a rewind from the end silently
    // skipped the parser-state reset above. remove() (like appendBuffer)
    // moves an ended MediaSource back to "open", so the second abort() is
    // the one that actually lands in that case.
    try {
      sb.abort();
    } catch {
      // MediaSource not "open" — ended (handled by the second abort below)
      // or already torn down.
    }
    const end = this.durationSeconds > 0 ? this.durationSeconds : Number.MAX_SAFE_INTEGER;
    await new Promise<void>(resolve => {
      const done = () => {
        sb.removeEventListener('updateend', done);
        resolve();
      };
      try {
        sb.addEventListener('updateend', done);
        sb.remove(0, end);
      } catch {
        sb.removeEventListener('updateend', done);
        resolve();
      }
    });
    try {
      sb.abort();
    } catch {
      // Still not open — torn down; nothing to reset.
    }
    try {
      sb.timestampOffset = offsetSeconds;
    } catch {
      // Rejected only if the buffer is mid-update, which the await above
      // has already ruled out.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.epochAbort.abort();
    if (this.forwardLoopHandle !== undefined) clearTimeout(this.forwardLoopHandle);
    this.closeSessions();
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      // Already closed/errored — nothing to clean up.
    }
  }

  private closeSessions(): void {
    if (this.videoSessionId >= 0) {
      MkvDemuxModule.closeRemuxSession(this.videoSessionId);
      this.videoSessionId = -1;
    }
    if (this.audioSessionId >= 0) {
      MkvDemuxModule.closeRemuxSession(this.audioSessionId);
      this.audioSessionId = -1;
    }
  }

  // Opens a fresh remux session per track. Called once by prepare() and
  // again by every restartAt(), since a session's output timeline always
  // starts at zero and only ever moves forward — see restartAt.
  private openSessions(): boolean {
    const result = this.initResult;
    if (!result) return false;

    this.videoSessionId = MkvDemuxModule.openRemuxSession(
      result.videoCodecId,
      base64ToArrayBuffer(result.videoCodecPrivateB64),
      result.videoTrackNumber,
      result.videoWidth,
      result.videoHeight,
      result.timestampScale,
      result.videoDefaultDurationNs,
    );
    if (this.videoSessionId < 0) return false;

    const audio = this.audioTrack;
    if (this.audioMime && audio) {
      this.audioSessionId = MkvDemuxModule.openRemuxSession(
        audio.codecId,
        base64ToArrayBuffer(audio.codecPrivateB64),
        audio.trackNumber,
        audio.sampleRate,
        audio.channels,
        result.timestampScale,
        0,
      );
      this.activeAudioTrackNumber = this.audioSessionId >= 0 ? audio.trackNumber : undefined;
      if (this.audioSessionId < 0) console.warn(`MkvMseSession: native refused audio track ${audio.trackNumber} (${audio.codecId})`);
    }
    return true;
  }

  // The file's default audio track when this platform can decode it,
  // otherwise the first track it can — a dual-audio release whose default
  // track is in an unsupported codec should still play with sound, just in
  // its other language (the Audio menu can switch back if that ever becomes
  // playable). Falls back to the init result's primary fields for a file
  // whose audioTracks list is somehow empty.
  private pickAudioTrack(result: MkvDemuxInitResult): { track: MkvDemuxAudioTrack; mime: string } | undefined {
    const tracks: MkvDemuxAudioTrack[] = result.audioTracks?.length
      ? result.audioTracks
      : result.audioCodecId
      ? [
          {
            trackNumber: result.audioTrackNumber,
            codecId: result.audioCodecId,
            codec: result.audioCodec,
            sampleRate: result.audioSampleRate,
            channels: result.audioChannels,
            language: 'und',
            name: '',
            codecPrivateB64: result.audioCodecPrivateB64,
            isDefault: true,
          },
        ]
      : [];
    const primary = tracks.find(t => t.trackNumber === result.audioTrackNumber);
    const ordered = primary ? [primary, ...tracks.filter(t => t !== primary)] : tracks;
    for (const track of ordered) {
      const mime = supportedAudioMime(track.codecId);
      if (mime) return { track, mime };
      console.warn(`MkvMseSession: audio track ${track.trackNumber} (${track.codecId}, ${track.language}) not playable here`);
    }
    return undefined;
  }

  private initSubtitleTracks(): void {
    this.subtitleTrackIsAss = new Map();
    this.subtitleTrackMask = 0;
    for (const t of this.getSubtitleTracks()) {
      if (t.trackNumber < 1 || t.trackNumber > 52) continue;
      this.subtitleTrackIsAss.set(t.trackNumber, t.codecId !== 'S_TEXT/UTF8');
      this.subtitleTrackMask += 2 ** t.trackNumber;
    }
  }

  // Every audio track this file has, for a track-selection menu — the
  // primary audioCodec/audioTrackNumber on the init result is just
  // whichever one of these was chosen as the default (see
  // MkvDemuxInitResult's own comment).
  //
  // Only tracks this platform can actually play are listed, so every entry
  // in the Audio menu works when picked — a dual-audio file with one
  // unsupported track (e.g. TrueHD next to FLAC) used to show both, and
  // choosing the unsupported one silently did nothing.
  getAudioTracks(): MkvDemuxAudioTrack[] {
    return (this.initResult?.audioTracks ?? []).filter(t => supportedAudioMime(t.codecId) !== null);
  }

  getActiveAudioTrackNumber(): number | undefined {
    return this.activeAudioTrackNumber;
  }

  // Switches which embedded audio track is playing, without touching video
  // at all — closes only the audio remux session, reopens it on the new
  // track, and re-fetches audio starting from wherever playback currently
  // is. This is a smaller version of restartAt's own "throw away the
  // session, rebuild positioned at a byte offset" approach, for the same
  // structural reason: a remux session's output timeline always starts at
  // zero, so switching tracks mid-stream means a fresh session either way.
  //
  // A codec-family change (e.g. Japanese AAC <-> English AC-3, a real and
  // common case for dual-audio releases) needs a NEW SourceBuffer — MSE
  // SourceBuffers are created bound to one mimeType/codec string and can't
  // be repointed at a different codec, only appended to or reset. Same
  // codec family reuses the existing SourceBuffer, matching restartAt's own
  // resetSourceBuffer path.
  async switchAudioTrack(trackNumber: number): Promise<boolean> {
    if (this.disposed || !this.initResult || !this.mediaSource) return false;
    const track = this.initResult.audioTracks.find(t => t.trackNumber === trackNumber);
    if (!track || trackNumber === this.activeAudioTrackNumber) return false;

    const newMime = supportedAudioMime(track.codecId);
    if (!newMime) return false; // codec not remuxable, or not one this platform decodes

    const myGeneration = ++this.seekGeneration;
    const stale = () => this.seekGeneration !== myGeneration;

    this.seekInProgress = true;
    try {
      const targetSeconds = this.getCurrentTime();
      const landing = await this.findLandingOffset(targetSeconds, stale);
      if (!landing || stale()) return false;

      this.epochAbort.abort();
      this.epochAbort = new AbortController();
      this.audioAppendQueue = Promise.resolve();

      if (this.audioSessionId >= 0) {
        MkvDemuxModule.closeRemuxSession(this.audioSessionId);
        this.audioSessionId = -1;
      }

      if (newMime !== this.audioMime && this.audioSourceBuffer) {
        try {
          this.mediaSource.removeSourceBuffer(this.audioSourceBuffer);
        } catch {
          // Best-effort — a stale/detached buffer isn't worth failing the switch over.
        }
        this.audioSourceBuffer = null;
      }
      this.audioMime = newMime;

      this.audioSessionId = MkvDemuxModule.openRemuxSession(
        track.codecId,
        base64ToArrayBuffer(track.codecPrivateB64),
        track.trackNumber,
        track.sampleRate,
        track.channels,
        this.timestampScale,
        0,
      );
      if (this.audioSessionId < 0 || stale()) return false;

      if (!this.audioSourceBuffer) {
        try {
          this.audioSourceBuffer = this.mediaSource.addSourceBuffer(newMime);
        } catch (e) {
          console.warn('MkvMseSession: could not add an audio SourceBuffer mid-playback —', e);
          return false;
        }
      }
      await this.resetSourceBuffer(this.audioSourceBuffer, landing.sec);
      if (stale()) return false;

      this.audioTrack = track;
      this.activeAudioTrackNumber = trackNumber;

      // Feed windows of just the audio track, starting at the landing
      // offset, until something actually appends — mirrors restartAt's own
      // "keep pulling until buffered" loop, scoped to audio only so
      // video's session/buffer/forward-loop cursor are never touched.
      let offset = landing.offset;
      let appendedAny = false;
      for (let i = 0; i < MAX_SEEK_ESTIMATE_ITERATIONS && !appendedAny; i++) {
        if (stale()) return false;
        const end = this.fileSize !== undefined ? Math.min(offset + CHUNK_SIZE, this.fileSize) - 1 : offset + CHUNK_SIZE - 1;
        if (end < offset) break;
        const { buf, total } = await fetchRange(this.url, offset, end, this.epochAbort.signal);
        if (stale()) return false;
        if (total !== undefined) this.fileSize = total;
        if (buf.byteLength === 0) break;
        const result = splitRemuxResult(MkvDemuxModule.remuxChunk(this.audioSessionId, buf, offset));
        if (result.muxed.byteLength > 0) {
          await this.enqueueAppend(this.audioSourceBuffer, 'audio', result.muxed);
          if (stale()) return false;
          appendedAny = true;
        }
        if (result.bytesConsumed === 0) break;
        offset += result.bytesConsumed;
      }
      return appendedAny;
    } finally {
      if (!stale()) this.seekInProgress = false;
    }
  }

  // Every subtitle track this file has — text-based ones only (S_TEXT/UTF8,
  // S_TEXT/ASS, S_TEXT/SSA). Image-based tracks (S_HDMV/PGS, S_VOBSUB)
  // aren't in this list; extraction can't render those.
  getSubtitleTracks(): MkvDemuxSubtitleTrack[] {
    return (this.initResult?.subtitleTracks ?? []).filter(
      t => t.codecId === 'S_TEXT/UTF8' || t.codecId === 'S_TEXT/ASS' || t.codecId === 'S_TEXT/SSA',
    );
  }

  // Picks which embedded track getEmbeddedSubtitleCues returns (null turns
  // embedded subtitles off). Cheap and instant: cues for every text track
  // are already being harvested from each fetched window (see
  // activeSubtitleTrack's comment), so a newly selected track immediately
  // has everything fetched so far. `_isAss` is kept for API compatibility;
  // each track's format is known from the init segment.
  selectEmbeddedSubtitleTrack(trackNumber: number | null, _isAss: boolean): void {
    this.activeSubtitleTrack = trackNumber ?? undefined;
    if (trackNumber !== null) {
      console.warn(
        `MkvMseSession: embedded subtitle track ${trackNumber} selected, ${
          this.cuesByTrack.get(trackNumber)?.length ?? 0
        } cues so far`,
      );
    }
  }

  // Live, growing list — call this fresh each time cues are needed (e.g.
  // every subtitle-overlay tick) rather than caching the reference for
  // long, since more cues arrive as playback/fetching advances.
  getEmbeddedSubtitleCues(): SrtCue[] {
    if (this.activeSubtitleTrack === undefined) return [];
    return this.cuesByTrack.get(this.activeSubtitleTrack) ?? [];
  }

  // Harvests cues for every text subtitle track from a window already
  // fetched for video/audio, in one native pass — see activeSubtitleTrack's
  // comment for why every track rather than just the selected one.
  private extractEmbeddedCues(input: ArrayBuffer): void {
    if (this.subtitleTrackMask <= 0) return;
    const parsed: { cues?: { track: number; startTicks: number; durationTicks: number; text: string }[] } =
      JSON.parse(MkvDemuxModule.extractTextCues(input, -this.subtitleTrackMask, false));
    if (!parsed.cues?.length) return;
    const touched = new Set<number>();
    for (const c of parsed.cues) {
      const isAss = this.subtitleTrackIsAss.get(c.track);
      if (isAss === undefined) continue;
      const text = isAss ? assDialogueText(c.text) : c.text;
      if (!text.trim()) continue;
      const start = this.toSeconds(c.startTicks);
      const end = start + this.toSeconds(c.durationTicks);
      const key = `${start}|${text}`;
      let keys = this.cueKeysByTrack.get(c.track);
      if (!keys) this.cueKeysByTrack.set(c.track, (keys = new Set()));
      if (keys.has(key)) continue;
      keys.add(key);
      let cues = this.cuesByTrack.get(c.track);
      if (!cues) this.cuesByTrack.set(c.track, (cues = []));
      cues.push({ start, end, text, segments: parseCueSegments(text) });
      touched.add(c.track);
    }
    // Keeps each list ordered for the overlay's binary search. Within one
    // window cues arrive chronologically, but a seek can land a window
    // before territory fetched earlier, so a sort per touched track is
    // needed; batches are one window's worth, so it's cheap.
    for (const track of touched) this.cuesByTrack.get(track)!.sort((a, b) => a.start - b.start);
  }

  // ---- init segment ----

  private async fetchInitSegment(): Promise<{ result: MkvDemuxInitResult } | undefined> {
    let fetchSize = INIT_FETCH_START;
    while (fetchSize <= INIT_FETCH_MAX) {
      const { buf, total } = await fetchRange(this.url, 0, fetchSize - 1, this.abort.signal);
      if (total !== undefined) this.fileSize = total;
      // Read before handing `buf` to native — the bridge takes ownership of
      // an ArrayBuffer argument and leaves it detached, so reading its
      // length afterwards yields 0 (see fetchAndAppendWindow's comment).
      const fetchedLength = buf.byteLength;
      const result: MkvDemuxInitResult = JSON.parse(MkvDemuxModule.parseInitSegment(buf));
      if (result.ok) return { result };
      // A server that ignores Range (or a genuinely tiny file) returns fewer
      // bytes than asked for — growing the window further would just
      // refetch the same bytes and loop forever.
      if (fetchedLength < fetchSize) return undefined;
      fetchSize *= 4;
    }
    return undefined;
  }

  // ---- appending ----

  private enqueueAppend(sb: SourceBuffer, queueField: 'video' | 'audio', buf: ArrayBuffer): Promise<void> {
    const prior = queueField === 'video' ? this.videoAppendQueue : this.audioAppendQueue;
    // Chained off `prior` whether it succeeded or failed: a plain .then()
    // would make one failed append poison the queue, so every later append
    // for that track silently never ran — audio stopping for good after a
    // single bad fragment, while video carried on.
    const next = prior.catch(() => undefined).then(() => this.appendAndWait(sb, buf));
    if (queueField === 'video') this.videoAppendQueue = next;
    else this.audioAppendQueue = next;
    return next;
  }

  private appendAndWait(sb: SourceBuffer, buf: ArrayBuffer): Promise<void> {
    if (this.disposed || buf.byteLength === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        sb.removeEventListener('updateend', onUpdateEnd);
        sb.removeEventListener('error', onError);
      };
      const onUpdateEnd = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        console.warn(`MkvMseSession: SourceBuffer append error (${sb === this.audioSourceBuffer ? 'audio' : 'video'})`);
        reject(new Error('SourceBuffer append error'));
      };
      sb.addEventListener('updateend', onUpdateEnd);
      sb.addEventListener('error', onError);
      try {
        sb.appendBuffer(buf);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  // Fetches [offset, offset+size) ONCE and feeds the same bytes through
  // both the video and (if present) audio remux sessions — each session
  // independently finds its own track's Blocks within whatever complete
  // Clusters are in this window and mux them into fMP4, reported back via
  // remuxChunk's bytesConsumed. The window's "fully processed" point — what
  // advances `nextFetchOffset` and what `this.clusters` gets filtered
  // against — is VIDEO's bytesConsumed alone; see the comment above the
  // audio remux call below for why audio is deliberately not allowed a vote
  // in that. Advances `nextFetchOffset` only forward, so a rewind's fetch
  // never rewinds the sequential playback cursor.
  private async fetchAndAppendWindow(offset: number, size: number): Promise<boolean> {
    const end = this.fileSize !== undefined ? Math.min(offset + size, this.fileSize) - 1 : offset + size - 1;
    if (end < offset) return false;
    const { buf, total } = await fetchRange(this.url, offset, end, this.epochAbort.signal);
    if (total !== undefined) this.fileSize = total;
    if (buf.byteLength === 0) return false;

    // Each native call gets its OWN copy of the window's bytes, made up
    // front while `buf` is still guaranteed intact — the Kepler bridge's
    // ownership semantics for an ArrayBuffer argument aren't documented,
    // and handing the same one to three separate native calls (video,
    // audio, findClusters) isn't worth the risk of one of them detaching
    // it out from under the others.
    const audioInput =
      this.audioSessionId >= 0 && this.audioSourceBuffer ? buf.slice(0) : undefined;
    const clustersInput = buf.slice(0);
    const subtitleInput = this.subtitleTrackMask > 0 ? buf.slice(0) : undefined;

    const videoResult = splitRemuxResult(MkvDemuxModule.remuxChunk(this.videoSessionId, buf, offset));
    const consumed = videoResult.bytesConsumed;
    if (videoResult.muxed.byteLength > 0 && this.videoSourceBuffer) {
      await this.enqueueAppend(this.videoSourceBuffer, 'video', videoResult.muxed);
    }

    // Audio is fed the same window and still appended whenever it produces
    // something, but it is NOT allowed to gate `consumed` the way an
    // earlier version did (`consumed = Math.min(videoConsumed,
    // audioConsumed)`). That made video's progress hostage to audio's: if
    // the audio remux session returned bytesConsumed === 0 for ANY reason —
    // the session had gone invalid, native handed back its all-zero 8-byte
    // header, or this particular window simply had no complete audio Blocks
    // — `consumed` collapsed to 0, this function returned false, and
    // (combined with startForwardLoop's old non-recovering stall handling)
    // the forward loop died for good. Video had remuxed perfectly fine and
    // still froze. Confirmed on-device as: turning on an audio track makes
    // video stop playing entirely. A window where audio genuinely produced
    // nothing isn't a failure worth reporting — it's just quiet for audio
    // this time around — so it's silently skipped rather than thrown.
    if (audioInput !== undefined && this.audioSourceBuffer) {
      const audioResult = splitRemuxResult(MkvDemuxModule.remuxChunk(this.audioSessionId, audioInput, offset));
      if (audioResult.muxed.byteLength > 0) {
        this.audioAppendCount++;
        this.audioAppendBytes += audioResult.muxed.byteLength;
        // A failed audio append must not throw out of this function: video
        // for this window is already appended, so a throw here (before
        // nextFetchOffset advances below) made the next tick re-fetch the
        // same window and remux its video a second time, duplicating it
        // further along the timeline.
        try {
          await this.enqueueAppend(this.audioSourceBuffer, 'audio', audioResult.muxed);
        } catch (e) {
          if ((e as { name?: string })?.name === 'AbortError') throw e;
        }
      }
    }

    if (consumed === 0) return false;

    // findClusters is unrelated to remuxing but cheap (no frame-level
    // parsing, just Cluster boundaries) — calling it on the same bytes
    // keeps the seek-timing index warm as a side effect of normal forward
    // playback, not just during an explicit seek probe.
    const parsed: MkvDemuxFindClustersResult = JSON.parse(MkvDemuxModule.findClusters(clustersInput, offset));
    this.clusters.push(...parsed.clusters.filter(c => c.offset + c.size <= offset + consumed));

    // Never let a subtitle-extraction failure block video/audio progress —
    // this is exactly what let one malformed cue (a native jsonEscape bug,
    // since fixed, that produced invalid JSON for any cue text containing a
    // raw newline) wedge the ENTIRE forward loop: the throw happened before
    // nextFetchOffset advanced below, so every subsequent tick re-fetched
    // and re-crashed on the identical byte offset forever, freezing
    // playback on whatever one frame had already been appended. Extraction
    // is a nice-to-have; it must never be able to do that again, regardless
    // of what specifically goes wrong inside it next time.
    if (subtitleInput !== undefined) {
      try {
        this.extractEmbeddedCues(subtitleInput);
      } catch (e) {
        console.warn('MkvMseSession: embedded subtitle extraction failed, continuing without it —', e);
      }
    }

    const newCursor = offset + consumed;
    if (newCursor > this.nextFetchOffset) this.nextFetchOffset = newCursor;
    return true;
  }

  private async fetchAndAppendNext(): Promise<'appended' | 'eof' | 'stalled'> {
    const startOffset = this.nextFetchOffset;
    if (this.fileSize !== undefined && startOffset >= this.fileSize) return 'eof';
    let appended = await this.fetchAndAppendWindow(startOffset, CHUNK_SIZE);
    if (!appended) {
      // An unusually large single Cluster can exceed the normal chunk size
      // — retry once with a much bigger window before giving up, rather
      // than silently skipping data.
      appended = await this.fetchAndAppendWindow(startOffset, CHUNK_SIZE * 6);
    }
    if (appended) return 'appended';
    return this.fileSize !== undefined && startOffset + CHUNK_SIZE * 6 >= this.fileSize ? 'eof' : 'stalled';
  }

  // ---- forward playback loop ----

  private startForwardLoop(): void {
    const tick = async () => {
      if (this.disposed) return;
      // Overridden below when this tick hits a stall — everything else
      // (nothing to fetch yet, a normal append, a caught error) reschedules
      // at the regular cadence.
      let nextDelay: number = FORWARD_LOOP_INTERVAL_MS;
      if (!this.seekInProgress) {
        try {
          const cur = this.getCurrentTime();
          this.logDiagnostics(cur);
          if (this.reachedEof) {
            // Parked at the end of the file: nothing left to fetch until a
            // seek moves the cursor back (restartAt clears reachedEof). The
            // loop keeps ticking rather than exiting, because an exited loop
            // is exactly what froze playback on any rewind after reaching
            // the end — the seek appended its one landing window and then
            // nothing ever fetched past it.
            nextDelay = FORWARD_LOOP_MAX_STALL_INTERVAL_MS;
          } else if (this.bufferedAheadOf(cur) >= BUFFER_AHEAD_TARGET_SEC) {
            // Buffer is healthy, so there is nothing to fetch this tick —
            // and that is itself proof we are not stalled. Clearing the
            // counter here is what makes it mean CONSECUTIVE stalls: without
            // it the steady state (buffer full, no fetch attempted) never
            // resets, so isolated transient stalls scattered across a whole
            // movie would slowly accumulate and eventually trip the
            // give-up ceiling on a perfectly healthy stream.
            this.consecutiveStalls = 0;
          } else {
            const outcome = await this.fetchAndAppendNext();
            if (outcome === 'eof') {
              this.reachedEof = true;
              try {
                if (this.mediaSource?.readyState === 'open') this.mediaSource.endOfStream();
              } catch {
                // Already ended/closed.
              }
            }
            if (outcome === 'stalled') {
              // A stall used to `return` here — exiting the tick WITHOUT
              // rescheduling the next setTimeout, which killed the forward
              // loop forever after a single bad window. Any transient stall
              // (slow range request, a window that happened to contain no
              // complete Cluster, a hiccup right after a seek) then froze
              // playback permanently with no recovery. Instead, keep
              // retrying — but back off the retry interval as stalls pile
              // up, so a source that's genuinely dead settles into slow,
              // bounded polling instead of hammering the network in a tight
              // loop.
              //
              // Even a long run of stalls no longer exits the loop — it only
              // stops backing off further and polls at the ceiling, so a
              // later seek (which moves the fetch cursor somewhere healthy)
              // still has a loop to hand off to.
              this.consecutiveStalls++;
              if (this.consecutiveStalls === MAX_CONSECUTIVE_STALLS) {
                console.warn(
                  `MkvMseSession: ${this.consecutiveStalls} consecutive stalled windows, polling slowly from here`,
                );
              }
              nextDelay = Math.min(
                FORWARD_LOOP_INTERVAL_MS * (this.consecutiveStalls + 1),
                FORWARD_LOOP_MAX_STALL_INTERVAL_MS,
              );
            } else if (outcome === 'appended') {
              this.consecutiveStalls = 0;
            }
          }
          this.trimBehind(cur);
        } catch (e) {
          // A seek deliberately aborts whatever this loop had in flight for
          // the position being left behind, so an AbortError here is the
          // system working, not a fault worth reporting.
          if ((e as { name?: string })?.name !== 'AbortError') {
            console.warn('MkvMseSession: forward loop error —', e);
          }
        }
      }
      if (!this.disposed) this.forwardLoopHandle = setTimeout(tick, nextDelay);
    };
    this.forwardLoopHandle = setTimeout(tick, FORWARD_LOOP_INTERVAL_MS);
  }

  // Periodic one-line state dump at WARN level. The device throttles an app
  // that logs more than ~300 lines/s by dropping its INFO lines for 16s at a
  // time — and the media stack alone logs that much during playback — so
  // INFO-level logging from here routinely vanishes exactly when it's
  // needed. WARN survives the throttle.
  private logDiagnostics(cur: number): void {
    const now = Date.now();
    if (now - this.lastDiagnosticsAt < 5000) return;
    this.lastDiagnosticsAt = now;
    console.warn(
      `MkvMseSession: t=${cur.toFixed(1)} ms=${this.mediaSource?.readyState} video=[${describeRanges(
        this.videoSourceBuffer,
      )}] audio=[${describeRanges(this.audioSourceBuffer)}] audioSession=${this.audioSessionId} audioAppends=${
        this.audioAppendCount
      }/${this.audioAppendBytes}B next=${this.nextFetchOffset} eof=${this.reachedEof} stalls=${
        this.consecutiveStalls
      } subs=${this.activeSubtitleTrack ?? '-'}:${this.getEmbeddedSubtitleCues().length}`,
    );
  }

  private bufferedAheadOf(cur: number): number {
    const b = this.videoSourceBuffer?.buffered;
    if (!b) return 0;
    for (let i = 0; i < b.length; i++) {
      if (cur >= b.start(i) && cur <= b.end(i)) return b.end(i) - cur;
    }
    return 0;
  }

  private trimBehind(cur: number): void {
    const cutoff = cur - BUFFER_KEEP_BEHIND_SEC;
    if (cutoff <= this.lastTrimAt + 10) return; // avoid spamming remove() for tiny increments
    for (const sb of [this.videoSourceBuffer, this.audioSourceBuffer]) {
      if (!sb || sb.updating) continue;
      try {
        sb.remove(0, cutoff);
      } catch {
        // Not fatal — the buffer just holds more than intended.
      }
    }
    this.lastTrimAt = cutoff;
  }

  // ---- seeking ----

  private toSeconds(timecode: number): number {
    return (timecode * this.timestampScale) / 1e9;
  }

  private isBuffered(t: number): boolean {
    const b = this.videoSourceBuffer?.buffered;
    if (!b) return false;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) && t <= b.end(i)) return true;
    }
    return false;
  }

  private findNearestKnownCluster(targetSeconds: number): { offset: number; sec: number } | undefined {
    let best: { offset: number; sec: number } | undefined;
    for (const c of this.clusters) {
      const sec = this.toSeconds(c.timecode);
      if (sec <= targetSeconds && (!best || sec > best.sec)) best = { offset: c.offset, sec };
    }
    return best;
  }

  private estimateByteOffset(targetSeconds: number): number {
    if (this.fileSize === undefined) return this.nextFetchOffset;
    const span = this.fileSize - this.initSegmentEnd;
    const frac = Math.max(0, Math.min(1, targetSeconds / this.durationSeconds));
    return Math.round(this.initSegmentEnd + frac * span);
  }

  private async probeAt(
    offset: number,
    size: number = SEEK_PROBE_CHUNK,
  ): Promise<{ offset: number; timecodeSec: number } | undefined> {
    const clamped = Math.max(this.initSegmentEnd, Math.floor(offset));
    const end = this.fileSize !== undefined ? Math.min(clamped + size, this.fileSize) - 1 : clamped + size - 1;
    const { buf, total } = await fetchRange(this.url, clamped, end, this.epochAbort.signal);
    if (total !== undefined) this.fileSize = total;
    if (buf.byteLength === 0) return undefined;
    const parsed: MkvDemuxFindClustersResult = JSON.parse(MkvDemuxModule.findClusters(buf, clamped));
    if (parsed.clusters.length === 0) return undefined;
    this.clusters.push(...parsed.clusters);
    const first = parsed.clusters[0];
    return { offset: first.offset, timecodeSec: this.toSeconds(first.timecode) };
  }
}
