import type {KeplerTurboModule} from '@amazon-devices/keplerscript-turbomodule-api';
import {TurboModuleRegistry} from '@amazon-devices/keplerscript-turbomodule-api';

// Results come back as JSON strings rather than JSObject/JSArray — this
// keeps the native side to the well-verified ArrayBuffer/std::string bridge
// types (confirmed working from the generated scaffold) instead of an
// unverified JSObject construction API, at the cost of one JSON.parse per
// call. The payloads here are tiny (a handful of numbers/short strings per
// call), so that cost is not worth the risk trade.

export interface MkvDemuxInitResult {
  ok: boolean;
  error?: string;
  // Byte offset of the first Cluster — everything before this is the MSE
  // "initialization segment" (EBML header + Segment + Tracks, etc.).
  initSegmentEnd: number;
  // Nanoseconds per Matroska timecode tick, from the Segment's Info element
  // (Matroska default is 1000000 = 1ms/tick when absent).
  timestampScale: number;
  // Total duration in seconds, from the Segment's Info/Duration element.
  // 0 if absent (some muxers omit it) — caller should fall back to
  // whatever runtime metadata it already has (e.g. Cinemeta) in that case.
  durationSeconds: number;
  // MSE codec family strings ("avc1" | "hev1" | "vp09" | "vp08" | "av01"),
  // or "" if the track is missing/unrecognised.
  videoCodec: string;
  // "aac" | "ac-3" | "ec-3" | "flac" | "opus" | "mp3" | "mp2" | "dts", or "".
  audioCodec: string;

  // Everything below is raw per-track config, needed only for remuxing
  // (openRemuxSession) — not needed for the raw-Matroska MSE path, which
  // only needs the two fields above.
  videoCodecId: string; // raw Matroska CodecID, e.g. "V_MPEGH/ISO/HEVC"
  audioCodecId: string; // e.g. "A_AAC", "A_AC3", "A_FLAC", "" if none
  videoTrackNumber: number;
  audioTrackNumber: number;
  // Nanoseconds per video frame from KaxTrackDefaultDuration, 0 if absent.
  // Required by openRemuxSession for a video track — see its own comment
  // for why a source with B-frames can't be remuxed correctly without it.
  videoDefaultDurationNs: number;
  videoWidth: number;
  videoHeight: number;
  audioSampleRate: number;
  audioChannels: number;
  // Base64-encoded CodecPrivate bytes, verbatim (empty string if absent).
  videoCodecPrivateB64: string;
  audioCodecPrivateB64: string;

  // Every audio/subtitle track in the file, not just the single "primary"
  // one selected into audioCodec/audioTrackNumber/etc above — what lets the
  // caller build a real Audio Track / Subtitle Track menu for an MKV's own
  // embedded tracks. audioCodec/audioTrackNumber is just a convenience
  // pointer at whichever entry in audioTracks was chosen as the default
  // (isDefault, or the first track if none is flagged) — the same
  // information duplicated for callers that don't care about track
  // selection at all.
  audioTracks: MkvDemuxAudioTrack[];
  subtitleTracks: MkvDemuxSubtitleTrack[];
}

export type MkvDemuxAudioTrack = {
  trackNumber: number;
  codecId: string; // raw Matroska CodecID, e.g. "A_AC3"
  codec: string; // MSE codec family tag ("aac" | "ac-3" | "ec-3" | "flac" | ""), "" if not remuxable
  sampleRate: number;
  channels: number;
  // ISO 639-2 (3-letter, e.g. "eng") when only the legacy TrackLanguage
  // element is present, or whatever BCP-47 tag (e.g. "en", "pt-BR") a
  // modern muxer wrote to LanguageIETF when that's present instead — see
  // MkvDemuxCore.cpp's language-reading comment. "und" if neither is set.
  language: string;
  name: string; // TrackName, "" if absent
  codecPrivateB64: string;
  isDefault: boolean;
};

export type MkvDemuxSubtitleTrack = {
  trackNumber: number;
  codecId: string; // e.g. "S_TEXT/UTF8", "S_TEXT/ASS", "S_HDMV/PGS"
  language: string; // same convention as MkvDemuxAudioTrack.language
  name: string;
  isDefault: boolean;
};

export type MkvDemuxCluster = {
  // Absolute byte offset in the source file (baseOffset + position found
  // within the supplied chunk).
  offset: number;
  // Total size of this Cluster element, header included.
  size: number;
  // Raw Matroska timecode of this Cluster, in `timestampScale` ticks.
  timecode: number;
};

export interface MkvDemuxFindClustersResult {
  clusters: MkvDemuxCluster[];
  error?: string;
}

export interface MkvDemuxModule extends KeplerTurboModule {
  getMajorVersion: () => number;
  getMinorVersion: () => number;
  getPatchVersion: () => number;

  // `headerBytes` must start at byte 0 of the file and extend at least past
  // the first Cluster — a few hundred KB is generous for a real release.
  // Returns JSON-encoded MkvDemuxInitResult.
  parseInitSegment: (headerBytes: ArrayBuffer) => string;

  // `chunk` is raw bytes fetched starting at file offset `baseOffset`.
  // Scans forward for Cluster elements and returns JSON-encoded
  // MkvDemuxFindClustersResult. Safe to call with any chunk that starts
  // past the init segment — clusters found are always whole (the scan skips
  // by each cluster's own declared size, never scans byte-by-byte through
  // frame data, which is what keeps it from false-matching the Cluster ID
  // pattern inside compressed video/audio bytes).
  findClusters: (chunk: ArrayBuffer, baseOffset: number) => string;

  // ---- Remuxing (MKV -> fragmented MP4, for MSE seeking) ------------------
  //
  // This platform's native seek fails unconditionally on Matroska-demuxed
  // content, over both a direct URL and MSE with raw Matroska bytes — but
  // not on MP4. Remuxing into fragmented MP4 on the fly and feeding MSE
  // that instead is what actually fixes seeking. See MkvDemuxCore.h's own
  // comment on openRemuxSession for the full story, including why a video
  // track needs videoDefaultDurationNs specifically.

  // Opens a session for ONE track (video and audio are remuxed into two
  // independent fMP4 streams, each fed to its own SourceBuffer — MSE
  // supports multiple SourceBuffers per element). Returns a positive
  // session id, or -1 if this CodecID isn't remuxable (caller falls back
  // to the raw-Matroska MSE path or direct-URL playback, same as any other
  // unsupported codec).
  //
  // `param1`/`param2` are width/height for video, sampleRate/channelCount
  // for audio. `videoDefaultDurationNs` is ignored for audio — pass 0.
  openRemuxSession: (
    codecId: string,
    codecPrivate: ArrayBuffer,
    trackNumber: number,
    param1: number,
    param2: number,
    timestampScale: number,
    videoDefaultDurationNs: number,
  ) => number;

  // Feeds a chunk of raw Matroska bytes (must start exactly at a Cluster
  // boundary, same contract as findClusters) into an open session. Returns
  // a buffer laid out as: 8 bytes (little-endian uint64) bytesConsumed —
  // how far into `chunk` was fully processed, so the caller's next fetch
  // should start at baseOffset + bytesConsumed — followed by whatever fMP4
  // bytes this call produced (ftyp+moov on the first successful call,
  // moof+mdat fragments after; may be exactly 8 bytes if no complete Block
  // for this session's track was found in this chunk).
  remuxChunk: (sessionId: number, chunk: ArrayBuffer, baseOffset: number) => ArrayBuffer;

  closeRemuxSession: (sessionId: number) => void;

  // ---- Embedded subtitle extraction ---------------------------------------
  //
  // Stateless, unlike remuxChunk — `chunk` can be any byte range from
  // anywhere in the file, not just one starting exactly at a Cluster
  // boundary (it self-scans for Cluster IDs the same way findClusters
  // does). The caller accumulates cues across repeated calls as more of the
  // file is fetched by the normal forward-playback/seek machinery, the same
  // way it already accumulates Clusters for the seek index.
  //
  // Only text-based subtitle CodecIDs are handled (S_TEXT/UTF8, S_TEXT/ASS,
  // S_TEXT/SSA) — `isAss` selects ASS/SSA's Dialogue-line field extraction
  // over UTF8's "payload is the cue text verbatim" handling. Image-based
  // formats (S_HDMV/PGS, S_VOBSUB) aren't supported; don't call this for
  // one of those tracks.
  //
  // Returns JSON: {"cues": [{startTicks, durationTicks, text}], error?}.
  // Ticks are raw Segment-timestampScale units, same convention as
  // findClusters' `timecode` field.
  extractTextCues: (chunk: ArrayBuffer, trackNumber: number, isAss: boolean) => string;
}

export default TurboModuleRegistry.getEnforcing<MkvDemuxModule>(
  'MkvDemuxModule',
);
