#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace MkvDemuxCore {

// Deliberately takes raw bytes rather than the Kepler ArrayBuffer type: the
// turbo module method is a thin wrapper over these two functions, and
// keeping the actual parsing logic decoupled from the Kepler bridge is what
// makes it possible to test against real files with a plain host-side CLI
// tool (see test/manual_probe.cpp) instead of round-tripping through a
// device deploy for every change — the ArrayBuffer type itself depends on a
// live N-API/Kepler runtime and can't be constructed standalone.

// See MkvDemuxModule.ts's MkvDemuxInitResult for the returned JSON shape.
std::string parseInitSegment(const uint8_t* data, size_t size);

// See MkvDemuxModule.ts's MkvDemuxFindClustersResult for the returned JSON
// shape. `baseOffset` is the absolute file offset the first byte of `data`
// corresponds to.
std::string findClusters(const uint8_t* data, size_t size, uint64_t baseOffset);

// ---- Remuxing (MKV -> fragmented MP4, for MSE seeking) -------------------
//
// This platform's native seek implementation fails unconditionally on
// Matroska-demuxed content — confirmed both over a direct progressive URL
// and via MSE with raw Matroska bytes fed to a `video/x-matroska`
// SourceBuffer, but NOT on MP4 (including HEVC-in-MP4, ruling out codec as
// the cause). The fix is to remux MKV into fragmented MP4 on the fly and
// feed THAT to MSE instead of raw Matroska bytes, since MP4 is what
// actually seeks correctly here.
//
// Video and audio are each remuxed into their OWN independent fMP4 byte
// stream, fed to their own SourceBuffer (MSE supports multiple SourceBuffers
// per element) — this keeps a bug in one codec's box-writing from being able
// to corrupt the other, and keeps each session's state trivial (one track).

// Opens a new remux session for a single track. Returns a positive session
// id, or -1 if this track's CodecID isn't one this module knows how to
// remux (caller should fall back to the existing raw-Matroska MSE path, or
// to direct-URL playback, same as an unsupported codec today).
//
// `codecId` is the raw Matroska CodecID ("V_MPEGH/ISO/HEVC", "A_AC3", ...).
// `codecPrivate` is that track's CodecPrivate bytes verbatim (may be empty
// for some codecs). `trackNumber` is this track's Matroska TrackNumber,
// used to pick out the right Blocks in remuxChunk. `param1`/`param2` are
// width/height for a video track, sampleRate/channelCount for audio.
//
// `videoDefaultDurationNs` (from the track's KaxTrackDefaultDuration,
// always real nanoseconds regardless of timestampScale; 0 if absent) is
// used as a CONSTANT per-sample duration for video tracks, ignored for
// audio. This is not an optimization — it's required for correctness:
// Matroska stores Blocks in decode order, but each Block's own timecode is
// a PRESENTATION timestamp, and any source with B-frames has decode order
// diverge from presentation order (confirmed against this module's real
// test files: naively using consecutive arrival-order timecode deltas as
// sample durations produced a stream whose total duration was ~3x too
// long, from unsigned-underflowed "durations" whenever a block's
// presentation time was earlier than the block before it in the file).
// Proper composition-time-offset support (decode-order DTS + a per-sample
// PTS-DTS delta) is the fully correct fix and isn't implemented here;
// using the track's own constant nominal frame duration instead keeps
// decode order correct (frames still decode successfully) at the cost of
// exact sub-frame display timing for B-frames, a real but minor tradeoff.
// Audio isn't affected — codecs used here have no B-frame-style forward
// referencing, so arrival order, decode order, and presentation order all
// coincide and the original delta-based duration is exact.
int openRemuxSession(const std::string& codecId, const uint8_t* codecPrivateData, size_t codecPrivateSize,
    uint64_t trackNumber, uint32_t param1, uint32_t param2, uint64_t timestampScale, uint64_t videoDefaultDurationNs);

// Feeds a chunk of raw Matroska bytes (must start exactly at a Cluster
// boundary, same contract as findClusters) into an open session, extracting
// only the Blocks belonging to that session's track and muxing them into
// fMP4. Returns a buffer laid out as:
//   [0..8)   bytesConsumed, little-endian uint64 — how far into `data` was
//            fully processed; the caller's next fetch should start at
//            baseOffset + bytesConsumed.
//   [8..end) muxed fMP4 bytes produced by this call (ftyp+moov on the first
//            successful call, moof+mdat fragments after — may be exactly 8
//            bytes total if no complete Block for this track was found).
// Returns an 8-byte all-zero buffer if sessionId is unknown/closed.
std::vector<uint8_t> remuxChunk(int sessionId, const uint8_t* data, size_t size, uint64_t baseOffset);

void closeRemuxSession(int sessionId);

// ---- Embedded subtitle extraction -----------------------------------------
//
// See MkvDemuxModule.ts's extractTextCues for the full contract. Stateless
// and tolerant of `data` starting anywhere in the file (self-scans for
// Cluster IDs the same way findClusters does) — unlike remuxChunk, there's
// no "must start exactly at a Cluster boundary" requirement.
std::string extractTextCues(const uint8_t* data, size_t size, uint64_t trackNumber, bool isAss);

// Same, for every track whose bit is set in `trackMask` (bit N = Matroska
// track N) in one pass; with `tagTrack`, each cue carries a "track" field.
std::string extractTextCuesForTracks(const uint8_t* data, size_t size, uint64_t trackMask, bool isAss, bool tagTrack);

} // namespace MkvDemuxCore
