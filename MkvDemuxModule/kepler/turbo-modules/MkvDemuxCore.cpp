#include "MkvDemuxCore.h"

#include <ebml/EbmlHead.h>
#include <ebml/EbmlStream.h>
#include <ebml/EbmlVoid.h>
#include <ebml/MemIOCallback.h>

#include <matroska/KaxBlock.h>
#include <matroska/KaxBlockData.h>
#include <matroska/KaxCluster.h>
#include <matroska/KaxSegment.h>
#include <matroska/KaxSemantic.h>
#include <matroska/KaxTracks.h>

// minimp4 (CC0 / public domain, vendored verbatim except two documented
// patches — see third_party/minimp4/minimp4.h) implements the actual
// fragmented-MP4 box writing. It wants already-encoded frames with
// timestamps, not a source to decode, which is exactly what falls out of
// walking Matroska SimpleBlocks below — no transcoding, just repackaging.
#define MINIMP4_IMPLEMENTATION
#include "../../third_party/minimp4/minimp4.h"

#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <sstream>
#include <unordered_map>

using namespace libebml;
using namespace libmatroska;

namespace MkvDemuxCore {

namespace {

// Length of Matroska's Cluster ID (0x1F43B675). Used to step past an ID
// that matched by chance inside frame data — see findClusters.
constexpr uint64_t kClusterIdBytes = 4;

// How many children to step through looking for a Cluster's Timestamp
// before giving up on it. A real Cluster puts its Timestamp first, so this
// only ever bounds the walk over a false match's garbage children.
constexpr int kMaxClusterChildScan = 16;

// libebml's MemIOCallback::read() is memory-unsafe once the read position
// has moved past the end of the supplied bytes: it takes the
// "return whatever is left" branch and computes `dataBufferTotalSize -
// dataBufferPos` with both operands unsigned, so a position past the end
// underflows to a huge length and memcpy walks off the buffer. Confirmed
// with AddressSanitizer against a real release —
// `negative-size-param (size=-326322638)` inside MemIOCallback::read,
// reached from EbmlElement::FindNextElement.
//
// Getting into that state is normal, not exotic: setFilePointer() accepts
// any offset without validation, and parsing necessarily starts at
// arbitrary byte offsets when seeking, so the scan lands inside frame
// payloads where Matroska element IDs occur by chance. Walking such a
// false element's "children" follows garbage sizes straight past the end.
//
// Fixed here rather than in the library because libebml is a git submodule
// — an edit there would be silently reverted by any submodule update, and
// this is exactly the kind of regression that hides for a long time.
// Reporting EOF is also simply the correct answer for a read that starts
// at or past the end.
class BoundedMemIO : public MemIOCallback {
 public:
  using MemIOCallback::MemIOCallback;

  std::size_t read(void* buffer, std::size_t size) override {
    if (getFilePointer() >= GetDataBufferSize()) return 0;
    return MemIOCallback::read(buffer, size);
  }
};

// Raw byte search for Matroska's 4-byte Cluster ID (0x1F43B675), starting at
// `data[from]`. Returns the offset of the next occurrence, or `size` if none.
//
// This exists because EbmlStream::FindNextID is NOT a scanner: it decodes
// exactly one element header at the IOCallback's *current* position and
// returns whatever that decodes to — the real Class if the ID matches, an
// EbmlDummy if it doesn't, or nullptr outright if the bytes it read happen to
// decode as an element with an "unknown size" marker (all-1s in the size
// vint) that the target class can't have. Calling it in a loop hoping it
// will walk forward through arbitrary bytes until it finds the next real
// Cluster is wrong on two counts: a non-matching read only advances by
// whatever that bogus element's declared size implies (not a reliable single
// step), and hitting an "unknown size" decode of pure garbage returns
// nullptr and looks identical to "no more data" — silently ending the whole
// scan before it ever reaches a real, later Cluster. That is exactly what
// caused findClusters to report zero clusters in 2MB windows that
// demonstrably contained one: confirmed by manually walking the same bytes
// outside this scan and finding a genuine Cluster with a readable Timestamp
// well within the window.
//
// The fix is to do the byte-pattern search ourselves, and only ask
// FindNextID to decode a header once we've already confirmed the exact ID
// bytes are present at that position — at which point it reliably succeeds
// (the ID comparison inside it can only match) rather than being trusted to
// locate the position itself.
size_t findClusterIdOffset(const uint8_t* data, size_t size, size_t from) {
  static constexpr uint8_t kPattern[kClusterIdBytes] = {0x1F, 0x43, 0xB6, 0x75};
  if (from >= size || size - from < kClusterIdBytes) return size;
  const uint8_t* base = data;
  const uint8_t* limit = data + size - kClusterIdBytes;
  const uint8_t* p = data + from;
  while (p <= limit) {
    const uint8_t* hit = static_cast<const uint8_t*>(std::memchr(p, kPattern[0], limit - p + 1));
    if (!hit) return size;
    if (std::memcmp(hit, kPattern, kClusterIdBytes) == 0) return static_cast<size_t>(hit - base);
    p = hit + 1;
  }
  return size;
}

// Matroska CodecID -> MSE codec family. A small, well-known lookup rather
// than reading exact profile/level out of the codec's own extradata (SPS/
// VPS parsing is its own project) — the JS side fills in a safe generic
// profile/level suffix per family when building the actual MSE `codecs=`
// string. A CodecID outside this set just means MSE playback isn't
// attempted for that release; the existing direct-URL path still applies.
std::string videoCodecFamily(const std::string& codecId) {
  if (codecId == "V_MPEG4/ISO/AVC") return "avc1";
  if (codecId == "V_MPEGH/ISO/HEVC") return "hev1";
  if (codecId == "V_VP9") return "vp09";
  if (codecId == "V_VP8") return "vp08";
  if (codecId == "V_AV1") return "av01";
  return "";
}

std::string audioCodecFamily(const std::string& codecId) {
  if (codecId == "A_AAC" || codecId.rfind("A_AAC/", 0) == 0) return "aac";
  if (codecId.rfind("A_AC3", 0) == 0) return "ac-3";
  if (codecId == "A_EAC3") return "ec-3";
  if (codecId == "A_FLAC") return "flac";
  if (codecId == "A_OPUS") return "opus";
  if (codecId == "A_MPEG/L3") return "mp3";
  if (codecId == "A_MPEG/L2") return "mp2";
  if (codecId == "A_DTS") return "dts";
  return "";
}

std::string base64Encode(const uint8_t* data, size_t size) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((size + 2) / 3) * 4);
  size_t i = 0;
  for (; i + 3 <= size; i += 3) {
    const uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out += table[(n >> 18) & 0x3f];
    out += table[(n >> 12) & 0x3f];
    out += table[(n >> 6) & 0x3f];
    out += table[n & 0x3f];
  }
  const size_t rem = size - i;
  if (rem == 1) {
    const uint32_t n = data[i] << 16;
    out += table[(n >> 18) & 0x3f];
    out += table[(n >> 12) & 0x3f];
    out += "==";
  } else if (rem == 2) {
    const uint32_t n = (data[i] << 16) | (data[i + 1] << 8);
    out += table[(n >> 18) & 0x3f];
    out += table[(n >> 12) & 0x3f];
    out += table[(n >> 6) & 0x3f];
    out += "=";
  }
  return out;
}

// Every field this was previously used for (codec IDs, track names/
// languages) happened to never contain a raw control character in
// practice, so escaping only `"`/`\` never showed a problem. extractTextCues
// broke that: real subtitle cue text routinely contains a literal newline
// (multi-line dialogue is the common case, not an edge case), and the JSON
// spec flatly disallows unescaped U+0000-U+001F inside a string — so a cue
// like "Multi-line\nsubtitle" produced JSON with a raw newline byte, which
// JSON.parse rejects outright ("U+0000 thru U+001F is not allowed in
// string"). That's not just a lost cue: the throw happened inside
// mkvMse.ts's fetchAndAppendWindow, BEFORE nextFetchOffset advances, so the
// forward-playback loop re-fetched and re-crashed on the exact same byte
// offset forever — playback got stuck showing whatever one frame had
// already been appended before the first crash, for the rest of the
// session, confirmed from a device log showing the identical SyntaxError
// repeating every ~500ms. Escaping every control character, not just the
// two that happened to matter before, is what real JSON string encoding
// requires.
std::string jsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  static const char kHex[] = "0123456789abcdef";
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      default:
        if (c < 0x20) {
          out += "\\u00";
          out += kHex[(c >> 4) & 0xf];
          out += kHex[c & 0xf];
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

// One entry per audio/subtitle TrackEntry — used to report every track in
// parseInitSegment's `audioTracks`/`subtitleTracks` arrays, not just
// whichever one is picked as the default. That list is what lets JS offer a
// real Audio Track / Subtitle Track menu for an MKV's own embedded tracks,
// instead of only ever exposing the single track this file already picks
// out for the default remux session.
struct AudioTrackEntry {
  uint64_t trackNumber = 0;
  std::string codecId;
  std::string codec; // MSE codec family tag, "" if not remuxable
  double sampleRate = 0;
  uint64_t channels = 0;
  std::string language;
  std::string name;
  std::vector<uint8_t> codecPrivate;
  bool isDefault = false;
};

struct SubtitleTrackEntry {
  uint64_t trackNumber = 0;
  std::string codecId;
  std::string language;
  std::string name;
  bool isDefault = false;
};

// For parseInitSegment: MkvDemuxInitResult always has an `ok` boolean.
std::string initErrorJson(const std::string& message) {
  std::ostringstream out;
  out << "{\"ok\":false,\"error\":\"" << jsonEscape(message) << "\"}";
  return out.str();
}

// For findClusters: MkvDemuxFindClustersResult always has a `clusters`
// array, even on failure — callers shouldn't need an `ok` check on top of
// checking the array.
std::string clustersErrorJson(const std::string& message) {
  std::ostringstream out;
  out << "{\"clusters\":[],\"error\":\"" << jsonEscape(message) << "\"}";
  return out.str();
}

// For extractTextCues: same "always has the array" convention as
// clustersErrorJson above.
std::string cuesErrorJson(const std::string& message) {
  std::ostringstream out;
  out << "{\"cues\":[],\"error\":\"" << jsonEscape(message) << "\"}";
  return out.str();
}

// Walks the direct children of `parent`, calling `onLeaf` for anything that
// isn't itself recursed into. Returns whatever comes AFTER `parent`'s own
// content — nullptr if that's true end of stream, otherwise an element
// that's already been found (its ID+size header already consumed).
//
// That return value is not optional bookkeeping — reusing it is the only
// correct way to continue. EbmlStream::FindNextElement consumes an
// element's header as a side effect of locating it, so when a nested walk
// steps out of its own parent (finds a sibling/uncle rather than a child),
// that element can never be safely "found" a second time: the stream is
// already positioned at ITS content, not at a fresh ID. Discarding it and
// calling FindNextElement again — the bug this replaced — reads from the
// middle of that element's data as if it were the start of a new one, and
// every element after it desyncs into garbage. Confirmed against a real
// 30MB slice of an actual anime release: everything between Info and
// Attachments came back as unrecognised "DummyElement" — including Tracks
// itself — because the walk had already desynced by that point.
//
// FindNextElement's `UpperElement` out-param says how many levels were
// stepped OUT of, not just "zero or more than zero": stepping out of a
// TrackEntry that happens to end exactly where its parent Tracks also ends
// reports upper=2, one level further than stepping out of the TrackEntry
// alone. Propagating that count via `stopAt`/`upperOut` below (as
// `upper - 1`, i.e. "levels past MY parent's boundary") is what lets a
// multi-level pop correctly keep bubbling up instead of being
// misinterpreted as "still my child" one level too many.
template <typename Fn>
EbmlElement* walkChildren(EbmlStream& stream, EbmlElement& parent, int& upperOut, Fn&& onLeaf) {
  int upper = 0;
  EbmlElement* child = stream.FindNextElement(EBML_CONTEXT(&parent), upper, UINT64_MAX, true);
  while (child != nullptr && upper <= 0) {
    onLeaf(*child);
    delete child;
    child = stream.FindNextElement(EBML_CONTEXT(&parent), upper, UINT64_MAX, true);
  }
  upperOut = upper > 0 ? upper - 1 : 0;
  return child;
}

} // namespace

std::string parseInitSegment(const uint8_t* data, size_t size) {
  try {
    BoundedMemIO io;
    io.write(data, size);
    io.setFilePointer(0);
    EbmlStream stream(io);

    // Only used to confirm this is really an EBML stream — its own content
    // (doc type/version) doesn't affect MSE playback.
    std::unique_ptr<EbmlElement> head(stream.FindNextID<EbmlHead>(UINT64_MAX));
    if (!head) return initErrorJson("no EBML head in supplied bytes");
    head->SkipData(stream, EBML_CONTEXT(head.get()));

    std::unique_ptr<EbmlElement> segEl(stream.FindNextID<KaxSegment>(UINT64_MAX));
    if (!segEl) return initErrorJson("no Segment in supplied bytes");
    auto& segment = static_cast<KaxSegment&>(*segEl);

    uint64_t timestampScale = 1000000; // Matroska default: 1ms per tick.
    double durationTicks = 0; // Duration in units of timestampScale, per spec — 0 means "not present".
    std::string videoCodec, audioCodec; // MSE codec family tags (existing).
    // Raw per-track config, needed only for remuxing (openRemuxSession) —
    // parseInitSegment already has to walk every TrackEntry to find
    // videoCodec/audioCodec above, so it captures this at the same time
    // rather than requiring a second pass over the same bytes.
    std::string videoCodecIdRaw, audioCodecIdRaw;
    uint64_t videoTrackNumber = 0, audioTrackNumber = 0;
    uint64_t videoDefaultDurationNs = 0;
    uint64_t videoWidth = 0, videoHeight = 0;
    double audioSampleRate = 0;
    uint64_t audioChannels = 0;
    std::vector<uint8_t> videoCodecPrivate, audioCodecPrivate;
    uint64_t initEnd = 0;
    bool foundCluster = false;
    // Every audio/subtitle track seen, in file order — see AudioTrackEntry's
    // comment. audioCodec/audioTrackNumber above stay the single "pick one"
    // selection remuxing actually uses (now default-flagged-track-aware —
    // see the FlagDefault handling below); these two lists are purely
    // additional, reported for track-selection UI.
    std::vector<AudioTrackEntry> audioTracks;
    std::vector<SubtitleTrackEntry> subtitleTracks;
    bool primaryAudioIsDefaultFlagged = false;

    int upper = 0;
    EbmlElement* child = stream.FindNextElement(EBML_CONTEXT(&segment), upper, UINT64_MAX, true);
    while (child != nullptr && upper <= 0) {
      if (dynamic_cast<KaxCluster*>(child) != nullptr) {
        initEnd = child->GetElementPosition();
        foundCluster = true;
        delete child;
        break;
      }

      if (auto* info = dynamic_cast<KaxInfo*>(child)) {
        int infoUpper = 0;
        EbmlElement* next = walkChildren(stream, *info, infoUpper, [&](EbmlElement& infoChild) {
          if (auto* ts = dynamic_cast<KaxTimestampScale*>(&infoChild)) {
            ts->ReadData(stream.I_O());
            timestampScale = static_cast<uint64_t>(ts->GetValue());
          } else if (auto* dur = dynamic_cast<KaxDuration*>(&infoChild)) {
            dur->ReadData(stream.I_O());
            durationTicks = static_cast<double>(dur->GetValue());
          } else {
            infoChild.SkipData(stream, EBML_CONTEXT(&infoChild));
          }
        });
        delete child;
        child = next;
        upper = infoUpper;
        continue; // `child` is already the next real element — do not call FindNextElement again below
      }

      if (auto* tracks = dynamic_cast<KaxTracks*>(child)) {
        // Deliberately NOT using the generic walkChildren helper here, and
        // deliberately NOT gating this loop on FindNextElement's numeric
        // `upper` the way every other level in this file does. Both would
        // seem natural but are wrong for this specific nesting:
        //
        // walkChildren's onLeaf would need to recurse into each TrackEntry's
        // own children, and walkChildren always re-calls FindNextElement
        // after onLeaf returns regardless of what that recursion already
        // consumed — silently dropping whatever the nested walk already
        // found next, the same "leftover" bug walkChildren exists to avoid
        // at the Segment level, just one level deeper.
        //
        // Threading that leftover back up via arithmetic on `upper` (as
        // tried first, and as the Segment-level Info/Tracks transition does
        // correctly) turns out to be UNSOUND here: confirmed by tracing
        // against a real file, FindNextElement reports the exact same
        // upper=1 both for "next sibling TrackEntry" (normal, expected) and
        // for "this was the last TrackEntry and we've landed on Tracks'
        // OWN sibling, e.g. Attachments" (must stop) — the two cases are
        // numerically indistinguishable once the search that finds the
        // "leftover" was itself triggered from inside a TrackEntry's own
        // child loop, one level deeper than where Info/Tracks's transition
        // is triggered from. Matroska's schema means this is not a rare
        // edge case: it happens for every file's LAST TrackEntry.
        //
        // What IS reliable: Tracks' only real child type is TrackEntry
        // (plus the global Void/CRC-32, which FindNextElement reports via
        // its own distinct upper==-1 sentinel — libebml's convention for
        // global elements found in any context, not a level count). So the
        // loop is gated on the found element's TYPE, not on the numeric
        // upper: keep going only while it's actually a TrackEntry (or a
        // genuine Tracks-level global to skip past); the moment it's
        // anything else, stop and hand it back to the Segment-level loop
        // completely unread — never SkipData it, since it was never
        // actually a child of Tracks in the first place.
        int tracksUpper = 0;
        EbmlElement* trackChild = stream.FindNextElement(EBML_CONTEXT(tracks), tracksUpper, UINT64_MAX, true);
        while (trackChild != nullptr) {
          auto* entry = dynamic_cast<KaxTrackEntry*>(trackChild);
          if (!entry) {
            if (tracksUpper == -1) {
              // Genuine Void/CRC-32 nested directly under Tracks itself.
              trackChild->SkipData(stream, EBML_CONTEXT(trackChild));
              delete trackChild;
              trackChild = stream.FindNextElement(EBML_CONTEXT(tracks), tracksUpper, UINT64_MAX, true);
              continue;
            }
            // Not a TrackEntry and not a Tracks-level global: we've already
            // stepped past Tracks' own boundary. Hand it back unread.
            break;
          }

          std::string codecId;
          uint64_t trackType = 0;
          uint64_t trackNumber = 0;
          uint64_t defaultDurationNs = 0;
          std::vector<uint8_t> codecPrivate;
          uint64_t pixelWidth = 0, pixelHeight = 0;
          double samplingFreq = 0;
          uint64_t channels = 0;
          std::string language = "und";
          std::string trackName;
          bool flagDefault = true; // spec default when the element is absent
          int entryUpper = 0;
          EbmlElement* entryChild = stream.FindNextElement(EBML_CONTEXT(entry), entryUpper, UINT64_MAX, true);
          while (entryChild != nullptr && entryUpper <= 0) {
            if (auto* cid = dynamic_cast<KaxCodecID*>(entryChild)) {
              cid->ReadData(stream.I_O());
              codecId = cid->GetValue();
            } else if (auto* tt = dynamic_cast<KaxTrackType*>(entryChild)) {
              tt->ReadData(stream.I_O());
              trackType = tt->GetValue();
            } else if (auto* dd = dynamic_cast<KaxTrackDefaultDuration*>(entryChild)) {
              dd->ReadData(stream.I_O());
              defaultDurationNs = dd->GetValue(); // always nanoseconds per spec, independent of timestampScale
            } else if (auto* tn = dynamic_cast<KaxTrackNumber*>(entryChild)) {
              tn->ReadData(stream.I_O());
              trackNumber = tn->GetValue();
            } else if (auto* lang = dynamic_cast<KaxTrackLanguage*>(entryChild)) {
              lang->ReadData(stream.I_O());
              // Only takes it if IETF (below) hasn't already been seen —
              // element order within TrackEntry isn't guaranteed, and IETF
              // is preferred when both are present (see KaxLanguageIETF's
              // comment for why).
              if (language == "und") language = lang->GetValue();
            } else if (auto* langIetf = dynamic_cast<KaxLanguageIETF*>(entryChild)) {
              langIetf->ReadData(stream.I_O());
              // Newer mkvmerge versions write ONLY this BCP-47 tag (e.g.
              // "en", "ja", "pt-BR") for an explicitly-set language and
              // leave the legacy ISO-639-2 TrackLanguage element out
              // entirely — confirmed by inspecting a real file mkvmerge
              // v65 produced, where `--language 1:eng` resulted in no
              // TrackLanguage element on that track at all, just this one.
              // Reading only the legacy field left every such track
              // reporting "und" despite a real language being present.
              // Always wins over legacy when non-empty, regardless of
              // which was seen first.
              const std::string v = langIetf->GetValue();
              if (!v.empty()) language = v;
            } else if (auto* name = dynamic_cast<KaxTrackName*>(entryChild)) {
              name->ReadData(stream.I_O());
              trackName = name->GetValueUTF8();
            } else if (auto* def = dynamic_cast<KaxTrackFlagDefault*>(entryChild)) {
              def->ReadData(stream.I_O());
              flagDefault = def->GetValue() != 0;
            } else if (auto* priv = dynamic_cast<KaxCodecPrivate*>(entryChild)) {
              priv->ReadData(stream.I_O());
              const uint8_t* buf = priv->GetBuffer();
              codecPrivate.assign(buf, buf + priv->GetSize());
            } else if (auto* video = dynamic_cast<KaxTrackVideo*>(entryChild)) {
              // TrackVideo's own children are all leaves (PixelWidth etc, no
              // further recursion) — walkChildren's leftover-threading is
              // sound here for the same reason it's sound for Info's
              // children: the ambiguity that makes it UNSOUND for Tracks/
              // TrackEntry only exists when the callback itself recurses
              // into yet another level.
              int videoUpper = 0;
              EbmlElement* next = walkChildren(stream, *video, videoUpper, [&](EbmlElement& vc) {
                if (auto* w = dynamic_cast<KaxVideoPixelWidth*>(&vc)) {
                  w->ReadData(stream.I_O());
                  pixelWidth = w->GetValue();
                } else if (auto* h = dynamic_cast<KaxVideoPixelHeight*>(&vc)) {
                  h->ReadData(stream.I_O());
                  pixelHeight = h->GetValue();
                } else {
                  vc.SkipData(stream, EBML_CONTEXT(&vc));
                }
              });
              delete entryChild;
              entryChild = next;
              entryUpper = videoUpper;
              continue;
            } else if (auto* audio = dynamic_cast<KaxTrackAudio*>(entryChild)) {
              int audioUpper = 0;
              EbmlElement* next = walkChildren(stream, *audio, audioUpper, [&](EbmlElement& ac) {
                if (auto* sf = dynamic_cast<KaxAudioSamplingFreq*>(&ac)) {
                  sf->ReadData(stream.I_O());
                  samplingFreq = sf->GetValue();
                } else if (auto* ch = dynamic_cast<KaxAudioChannels*>(&ac)) {
                  ch->ReadData(stream.I_O());
                  channels = ch->GetValue();
                } else {
                  ac.SkipData(stream, EBML_CONTEXT(&ac));
                }
              });
              delete entryChild;
              entryChild = next;
              entryUpper = audioUpper;
              continue;
            } else {
              entryChild->SkipData(stream, EBML_CONTEXT(entryChild));
            }
            delete entryChild;
            entryChild = stream.FindNextElement(EBML_CONTEXT(entry), entryUpper, UINT64_MAX, true);
          }

          // TrackType 1 = video, 2 = audio, 0x11 = subtitle (Matroska spec).
          // First video track wins — multiple video angles aren't something
          // the MSE path tries to offer a picker for. Audio and subtitle
          // are different: every track is captured into audioTracks/
          // subtitleTracks for JS to build a real Audio/Subtitle Track menu
          // from (see their struct comments) — audioCodec/audioTrackNumber
          // etc. stay just the single "primary" pick the default MSE remux
          // session actually opens, preferring whichever track the file
          // itself marks FlagDefault (falling back to simply the first
          // audio track seen if none is, or if multiple claim it).
          if (trackType == 1 && videoCodec.empty()) {
            videoCodec = videoCodecFamily(codecId);
            videoCodecIdRaw = codecId;
            videoTrackNumber = trackNumber;
            videoDefaultDurationNs = defaultDurationNs;
            videoWidth = pixelWidth;
            videoHeight = pixelHeight;
            videoCodecPrivate = std::move(codecPrivate);
          } else if (trackType == 2) {
            AudioTrackEntry track;
            track.trackNumber = trackNumber;
            track.codecId = codecId;
            track.codec = audioCodecFamily(codecId);
            track.sampleRate = samplingFreq;
            track.channels = channels;
            track.language = language;
            track.name = trackName;
            track.codecPrivate = codecPrivate;
            track.isDefault = flagDefault;
            audioTracks.push_back(std::move(track));

            if (audioCodec.empty() || (flagDefault && !primaryAudioIsDefaultFlagged)) {
              audioCodec = audioTracks.back().codec;
              audioCodecIdRaw = codecId;
              audioTrackNumber = trackNumber;
              audioSampleRate = samplingFreq;
              audioChannels = channels;
              audioCodecPrivate = codecPrivate; // audioTracks.back() already owns its own copy
              primaryAudioIsDefaultFlagged = flagDefault;
            }
          } else if (trackType == 17) {
            SubtitleTrackEntry track;
            track.trackNumber = trackNumber;
            track.codecId = codecId;
            track.language = language;
            track.name = trackName;
            track.isDefault = flagDefault;
            subtitleTracks.push_back(std::move(track));
          }

          delete trackChild; // the TrackEntry element itself, already fully consumed above

          // `entryChild` is what comes after THIS TrackEntry's own content —
          // reuse it directly as Tracks' next candidate rather than calling
          // FindNextElement again (see the comment above this block). Its
          // numeric upper is not meaningful here; the top of the loop
          // decides what to do with it purely by type.
          trackChild = entryChild;
          tracksUpper = 0;
        }

        delete child;
        child = trackChild;
        // Reaching here (loop ended via `break` or trackChild==nullptr)
        // means whatever we're holding has already been confirmed, by
        // type, to be past Tracks' own boundary — safe to hand to the
        // Segment-level loop as a fresh direct child, same as Info's
        // transition above.
        upper = 0;
        continue;
      }

      child->SkipData(stream, EBML_CONTEXT(child));
      delete child;
      child = stream.FindNextElement(EBML_CONTEXT(&segment), upper, UINT64_MAX, true);
    }

    if (!foundCluster) {
      return initErrorJson("no Cluster within supplied bytes — caller must fetch further into the file");
    }

    // Duration is expressed in Segment Ticks (timestampScale units), same
    // convention as Cluster/Block timecodes — converting to seconds here
    // rather than handing the caller raw ticks plus a scale to multiply
    // themselves, since every other JSON field is already caller-ready.
    const double durationSeconds = durationTicks * (static_cast<double>(timestampScale) / 1e9);

    std::ostringstream out;
    out << "{\"ok\":true"
        << ",\"initSegmentEnd\":" << initEnd
        << ",\"timestampScale\":" << timestampScale
        << ",\"durationSeconds\":" << durationSeconds
        << ",\"videoCodec\":\"" << jsonEscape(videoCodec) << "\""
        << ",\"audioCodec\":\"" << jsonEscape(audioCodec) << "\""
        << ",\"videoCodecId\":\"" << jsonEscape(videoCodecIdRaw) << "\""
        << ",\"audioCodecId\":\"" << jsonEscape(audioCodecIdRaw) << "\""
        << ",\"videoTrackNumber\":" << videoTrackNumber
        << ",\"audioTrackNumber\":" << audioTrackNumber
        << ",\"videoDefaultDurationNs\":" << videoDefaultDurationNs
        << ",\"videoWidth\":" << videoWidth
        << ",\"videoHeight\":" << videoHeight
        << ",\"audioSampleRate\":" << static_cast<uint64_t>(audioSampleRate + 0.5)
        << ",\"audioChannels\":" << audioChannels
        << ",\"videoCodecPrivateB64\":\"" << base64Encode(videoCodecPrivate.data(), videoCodecPrivate.size()) << "\""
        << ",\"audioCodecPrivateB64\":\"" << base64Encode(audioCodecPrivate.data(), audioCodecPrivate.size()) << "\"";

    out << ",\"audioTracks\":[";
    for (size_t i = 0; i < audioTracks.size(); i++) {
      const auto& t = audioTracks[i];
      if (i > 0) out << ",";
      out << "{\"trackNumber\":" << t.trackNumber << ",\"codecId\":\"" << jsonEscape(t.codecId) << "\""
          << ",\"codec\":\"" << jsonEscape(t.codec) << "\"" << ",\"sampleRate\":"
          << static_cast<uint64_t>(t.sampleRate + 0.5) << ",\"channels\":" << t.channels << ",\"language\":\""
          << jsonEscape(t.language) << "\"" << ",\"name\":\"" << jsonEscape(t.name) << "\""
          << ",\"codecPrivateB64\":\"" << base64Encode(t.codecPrivate.data(), t.codecPrivate.size()) << "\""
          << ",\"isDefault\":" << (t.isDefault ? "true" : "false") << "}";
    }
    out << "]";

    out << ",\"subtitleTracks\":[";
    for (size_t i = 0; i < subtitleTracks.size(); i++) {
      const auto& t = subtitleTracks[i];
      if (i > 0) out << ",";
      out << "{\"trackNumber\":" << t.trackNumber << ",\"codecId\":\"" << jsonEscape(t.codecId) << "\""
          << ",\"language\":\"" << jsonEscape(t.language) << "\"" << ",\"name\":\"" << jsonEscape(t.name) << "\""
          << ",\"isDefault\":" << (t.isDefault ? "true" : "false") << "}";
    }
    out << "]";

    out << "}";
    return out.str();
  } catch (const std::exception& e) {
    return initErrorJson(e.what());
  } catch (...) {
    return initErrorJson("unknown native exception");
  }
}

std::string findClusters(const uint8_t* data, size_t size, uint64_t baseOffset) {
  try {
    BoundedMemIO io;
    io.write(data, size);
    io.setFilePointer(0);
    EbmlStream stream(io);

    std::ostringstream out;
    out << "{\"clusters\":[";
    bool first = true;

    // No Segment element anchors this walk — the chunk starts mid-file, not
    // at a container boundary — so each Cluster's position is located with a
    // raw byte-pattern search for its 4-byte ID (findClusterIdOffset), NOT
    // by looping FindNextID: that call decodes exactly one element header at
    // wherever the IOCallback's position already is and does not scan for a
    // match itself, so looping it can silently end the whole search on a
    // garbage "unknown size" decode long before reaching a real, later
    // Cluster. See findClusterIdOffset's comment for the full story — this
    // was diagnosed offline by finding a genuine Timestamp-bearing Cluster
    // by hand inside a window this function was reporting as empty.
    //
    // FindNextID is still used, but only once per confirmed candidate
    // position, where the ID bytes are already known to match and it can
    // only succeed at decoding the real element (size, position, etc).
    size_t searchPos = 0;
    for (;;) {
      const size_t candidate = findClusterIdOffset(data, size, searchPos);
      if (candidate >= size) break;

      io.setFilePointer(static_cast<std::int64_t>(candidate), seek_beginning);
      std::unique_ptr<EbmlElement> el(stream.FindNextID<KaxCluster>(UINT64_MAX));
      if (!el) {
        // Should not happen once the ID bytes are confirmed, but stay
        // defensive and keep scanning rather than stopping the whole walk.
        searchPos = candidate + kClusterIdBytes;
        continue;
      }
      auto& cluster = static_cast<KaxCluster&>(*el);
      const uint64_t pos = cluster.GetElementPosition();
      const uint64_t end = cluster.GetEndPosition();

      // A Cluster that doesn't declare a size strictly greater than its own
      // start is degenerate — reject and keep scanning past its ID.
      if (end <= pos) {
        searchPos = candidate + kClusterIdBytes;
        continue;
      }

      // Every real Cluster carries a Timestamp, so being unable to read one
      // is the reliable tell that this ID matched by chance inside frame
      // data (the byte-pattern search above only confirms the 4 ID bytes,
      // not that they're really being used as a Cluster ID rather than
      // occurring inside compressed payload). Both alternatives to rejecting
      // it here were actively harmful:
      //
      //  - Reporting the Cluster with a default timecode of 0 made a false
      //    match at, say, byte 19,000,000 look exactly like a genuine
      //    Cluster at the very start of the file. The seek search reads
      //    that as "you asked for 30s and landed at 0s", jumps by the full
      //    error, and never converges — so restartAt gave up and the seek
      //    silently did nothing, which is precisely the "forwarding does
      //    nothing" symptom.
      //  - Bailing out of the whole scan on a false match's implausible
      //    size (the previous `if (end > size) break;`, which ran before
      //    this check) threw away the rest of the window, so a 2MB probe
      //    that really did contain several Clusters came back empty.
      //
      // Reading the Timestamp is safe even when `end` reaches past the data
      // supplied: BoundedMemIO reports EOF instead of running off the
      // buffer, which is what made checking-before-trusting possible at all.
      uint64_t timecode = 0;
      bool foundTimecode = false;
      int upper = 0;
      int childSteps = 0;
      EbmlElement* ce = stream.FindNextElement(EBML_CONTEXT(&cluster), upper, UINT64_MAX, true);
      while (ce != nullptr && upper <= 0 && !foundTimecode && childSteps++ < kMaxClusterChildScan) {
        if (auto* tc = dynamic_cast<KaxClusterTimestamp*>(ce)) {
          tc->ReadData(stream.I_O());
          timecode = tc->GetValue();
          foundTimecode = true;
        } else {
          ce->SkipData(stream, EBML_CONTEXT(ce));
        }
        delete ce;
        if (!foundTimecode) ce = stream.FindNextElement(EBML_CONTEXT(&cluster), upper, UINT64_MAX, true);
      }
      if (!foundTimecode) {
        searchPos = candidate + kClusterIdBytes;
        continue;
      }

      if (!first) out << ",";
      first = false;
      out << "{\"offset\":" << (baseOffset + pos) << ",\"size\":" << (end - pos) << ",\"timecode\":" << timecode << "}";

      // Now that this is known to be a real Cluster, a declared end past
      // the supplied data means the genuine last Cluster straddles the
      // chunk boundary — normal for a fixed-size progressive fetch. Its
      // offset and timecode above are still valid and useful for the seek
      // index; there is simply nothing further to scan in this window. The
      // caller re-requests from this Cluster's start in its next chunk.
      if (end > size) break;

      // Resume the byte-pattern search at the end of this Cluster's full
      // declared size, rather than one ID-length past its start — skips
      // over its actual frame content instead of re-scanning through it.
      searchPos = static_cast<size_t>(end);
    }
    out << "]}";
    return out.str();
  } catch (const std::exception& e) {
    return clustersErrorJson(e.what());
  } catch (...) {
    return clustersErrorJson("unknown native exception");
  }
}

namespace {

enum class RemuxKind { Unsupported, Avc, Hevc, Aac, Ac3, Eac3, Flac, Opus };

RemuxKind remuxKindForCodecId(const std::string& codecId) {
  if (codecId == "V_MPEG4/ISO/AVC") return RemuxKind::Avc;
  if (codecId == "V_MPEGH/ISO/HEVC") return RemuxKind::Hevc;
  if (codecId == "A_AAC" || codecId.rfind("A_AAC/", 0) == 0) return RemuxKind::Aac;
  if (codecId == "A_AC3" || codecId.rfind("A_AC3/", 0) == 0) return RemuxKind::Ac3;
  if (codecId == "A_EAC3") return RemuxKind::Eac3;
  if (codecId == "A_FLAC") return RemuxKind::Flac;
  if (codecId == "A_OPUS") return RemuxKind::Opus;
  // DTS/MP3/MP2 etc are still not remuxed. DTS isn't decodable through MSE on
  // this platform regardless of muxing. MP3/MP2 could reuse the esds path AAC
  // already has (same OTI family, just a different sub-value) but haven't come
  // up in practice. A track landing here just means the caller falls back to
  // the existing raw-Matroska MSE path or direct-URL playback, same as any
  // other unsupported codec today.
  return RemuxKind::Unsupported;
}

// Opus-in-Matroska's CodecPrivate is the OpusHead identification header —
// byte-for-byte the same structure Ogg encapsulation uses (RFC 7845 §5.1).
// ISOBMFF's dOps box (OpusSpecificBox, "Encapsulation of Opus in ISOBMFF"
// §4.3.2) wants the same fields, but with two differences that make this a
// real conversion rather than a copy:
//
//   1. The 8-byte "OpusHead" magic is dropped, and the leading byte becomes
//      the dOps box Version (0) rather than OpusHead's own Version (1).
//   2. ENDIANNESS FLIPS. OpusHead stores PreSkip/InputSampleRate/OutputGain
//      little-endian (it was designed for Ogg); every multi-byte field in
//      ISOBMFF is big-endian. Copying those three fields through verbatim
//      would yield a byte-swapped pre-skip and a sample rate in the
//      hundreds of millions, which is exactly the kind of thing a decoder
//      either rejects outright or renders as garbage.
//
// Single-byte fields after that (ChannelMappingFamily, and the mapping table
// for family != 0) carry across unchanged.
bool parseOpusConfig(const uint8_t* codecPrivate, size_t size, std::vector<uint8_t>& dOps) {
  // 8 magic + version + channels + 2 preskip + 4 rate + 2 gain + 1 family.
  constexpr size_t kOpusHeadMin = 19;
  if (size < kOpusHeadMin || std::memcmp(codecPrivate, "OpusHead", 8) != 0) return false;

  const uint8_t channelCount = codecPrivate[9];
  const uint8_t mappingFamily = codecPrivate[18];
  const auto le16 = [&](size_t at) -> uint16_t {
    return static_cast<uint16_t>(codecPrivate[at] | (codecPrivate[at + 1] << 8));
  };
  const uint32_t inputSampleRate = static_cast<uint32_t>(codecPrivate[12]) |
      (static_cast<uint32_t>(codecPrivate[13]) << 8) | (static_cast<uint32_t>(codecPrivate[14]) << 16) |
      (static_cast<uint32_t>(codecPrivate[15]) << 24);

  dOps.clear();
  const auto put8 = [&](uint8_t v) { dOps.push_back(v); };
  const auto put16be = [&](uint16_t v) {
    dOps.push_back(static_cast<uint8_t>(v >> 8));
    dOps.push_back(static_cast<uint8_t>(v & 0xff));
  };

  put8(0); // dOps Version — 0, NOT OpusHead's version byte
  put8(channelCount);
  put16be(le16(10)); // PreSkip
  dOps.push_back(static_cast<uint8_t>(inputSampleRate >> 24));
  dOps.push_back(static_cast<uint8_t>((inputSampleRate >> 16) & 0xff));
  dOps.push_back(static_cast<uint8_t>((inputSampleRate >> 8) & 0xff));
  dOps.push_back(static_cast<uint8_t>(inputSampleRate & 0xff));
  put16be(le16(16)); // OutputGain
  put8(mappingFamily);

  if (mappingFamily != 0) {
    // ChannelMappingTable: StreamCount, CoupledCount, then one byte per
    // output channel. All single bytes, so no endian handling needed.
    const size_t tableBytes = 2u + channelCount;
    if (size < kOpusHeadMin + tableBytes) return false;
    dOps.insert(dOps.end(), codecPrivate + kOpusHeadMin, codecPrivate + kOpusHeadMin + tableBytes);
  }
  return true;
}

// Number of 48 kHz samples one Opus packet represents, read from its TOC
// byte (RFC 6716 §3.1). Opus always decodes at 48 kHz no matter what
// InputSampleRate says, which is why the MP4 timescale for an Opus track is
// pinned to 48000 in openRemuxSession — these counts are in that timebase.
//
// Frame duration lives in the top 5 bits (the "config" number); the bottom
// 2 bits ("code") say how many frames are packed into this one packet, so a
// packet's duration is frames * per-frame duration. Returns 0 if the packet
// is too short or the frame count can't be trusted, which the caller treats
// as "try the next packet instead".
uint32_t opusPacketDurationSamples(const uint8_t* frame, size_t size) {
  if (size < 1) return 0;
  const uint8_t toc = frame[0];
  const uint8_t config = static_cast<uint8_t>(toc >> 3);
  const uint8_t code = static_cast<uint8_t>(toc & 0x3);

  // 48 kHz sample counts for 2.5/5/10/20/40/60 ms.
  uint32_t perFrame;
  if (config < 12) {
    // SILK-only: 10, 20, 40, 60 ms
    static const uint32_t kSilk[4] = {480, 960, 1920, 2880};
    perFrame = kSilk[config & 0x3];
  } else if (config < 16) {
    // Hybrid: 10, 20 ms
    static const uint32_t kHybrid[2] = {480, 960};
    perFrame = kHybrid[config & 0x1];
  } else {
    // CELT-only: 2.5, 5, 10, 20 ms
    static const uint32_t kCelt[4] = {120, 240, 480, 960};
    perFrame = kCelt[config & 0x3];
  }

  uint32_t frames;
  switch (code) {
    case 0:
      frames = 1;
      break;
    case 1:
    case 2:
      frames = 2;
      break;
    default: {
      // Code 3: arbitrary count, low 6 bits of the frame-count byte.
      if (size < 2) return 0;
      frames = static_cast<uint32_t>(frame[1] & 0x3f);
      if (frames == 0) return 0;
      break;
    }
  }
  return perFrame * frames;
}

// FLAC-in-Matroska's CodecPrivate is the native FLAC stream header
// verbatim — the 4-byte "fLaC" marker followed by metadata blocks,
// STREAMINFO always first and mandatory (RFC 9639 §8.1) — which is exactly
// what ISOBMFF's dfLa box wants (ISO/IEC 14496-12 Amendment 2,
// FLACSpecificBox: the same metadata-block sequence, marker dropped). No
// bitstream parsing needed, unlike AC-3/E-AC-3: everything is already
// sitting in CodecPrivate at session-open time.
//
// Also reads STREAMINFO's minimum/maximum block size (RFC 9639 §8.2): equal
// and nonzero guarantees every frame in the stream uses that exact number
// of samples, which is what lets this module use its constant-duration-
// per-sample model (see RemuxSession::fixedDurationUnits) for FLAC just
// like AAC/AC-3. A real variable-blocksize FLAC stream (encoder-optional,
// uncommon in practice — the reference encoder defaults to constant) falls
// back to maxBlockSize as a best-effort constant; frames may then drift out
// of sync over a long file rather than a hard failure, a real but narrow
// limitation not worth a full per-frame blocksize parse for.
bool parseFlacConfig(const uint8_t* codecPrivate, size_t size, std::vector<uint8_t>& dfLa, uint32_t& samplesPerFrame) {
  if (size < 4 + 4 + 34 || std::memcmp(codecPrivate, "fLaC", 4) != 0) return false;
  dfLa.assign(codecPrivate + 4, codecPrivate + size);
  const uint8_t* streamInfo = codecPrivate + 8; // past "fLaC" + metadata block header
  const uint32_t minBlockSize = (static_cast<uint32_t>(streamInfo[0]) << 8) | streamInfo[1];
  const uint32_t maxBlockSize = (static_cast<uint32_t>(streamInfo[2]) << 8) | streamInfo[3];
  samplesPerFrame = (minBlockSize == maxBlockSize && minBlockSize > 0) ? minBlockSize : maxBlockSize;
  return samplesPerFrame > 0;
}

// ---- AC-3 / E-AC-3 bitstream-info parsing ----------------------------
//
// Matroska's CodecPrivate is empty for both codecs (unlike AVC/HEVC/AAC,
// which carry a real decoder config record) — the fields minimp4's
// dac3/dec3 sample-entry config box needs only exist inside the compressed
// bitstream itself, so they're read out of the first actual audio frame
// instead (see RemuxSession::needsBsiFromFirstFrame). Box layouts are
// ETSI TS 102 366 Annex F (dac3: F.3.1, dec3: F.6).

class BitReader {
 public:
  BitReader(const uint8_t* data, size_t size) : data_(data), size_(size) {}
  uint32_t bits(int n) {
    uint32_t v = 0;
    for (int i = 0; i < n; i++) {
      const size_t byteIdx = pos_ >> 3;
      int bit = 0;
      if (byteIdx < size_) {
        bit = (data_[byteIdx] >> (7 - (pos_ & 7))) & 1;
      } else {
        ok_ = false;
      }
      v = (v << 1) | static_cast<uint32_t>(bit);
      pos_++;
    }
    return v;
  }
  bool ok() const { return ok_; }

 private:
  const uint8_t* data_;
  size_t size_;
  size_t pos_ = 0;
  bool ok_ = true;
};

class BitWriter {
 public:
  void bits(uint32_t v, int n) {
    for (int i = n - 1; i >= 0; i--) {
      if (pos_ % 8 == 0) buf_.push_back(0);
      buf_.back() |= static_cast<uint8_t>(((v >> i) & 1) << (7 - (pos_ & 7)));
      pos_++;
    }
  }
  std::vector<uint8_t> take() { return std::move(buf_); }

 private:
  std::vector<uint8_t> buf_;
  size_t pos_ = 0;
};

// AC-3 sync frame (ATSC A/52 syncinfo+bsi) -> the 3-byte dac3 payload.
// Empty return means the frame was too short/malformed to trust.
std::vector<uint8_t> parseAc3Dac3(const uint8_t* frame, size_t size) {
  if (size < 7) return {};
  BitReader br(frame, size);
  br.bits(16); // syncword
  br.bits(16); // crc1
  const uint32_t fscod = br.bits(2);
  const uint32_t frmsizecod = br.bits(6);
  const uint32_t bsid = br.bits(5);
  const uint32_t bsmod = br.bits(3);
  const uint32_t acmod = br.bits(3);
  if ((acmod & 0x1) != 0 && acmod != 0x1) br.bits(2); // cmixlev
  if ((acmod & 0x4) != 0) br.bits(2);                  // surmixlev
  if (acmod == 0x2) br.bits(2);                        // dsurmod
  const uint32_t lfeon = br.bits(1);
  if (!br.ok()) return {};

  BitWriter bw;
  bw.bits(fscod, 2);
  bw.bits(bsid, 5);
  bw.bits(bsmod, 3);
  bw.bits(acmod, 3);
  bw.bits(lfeon, 1);
  bw.bits(frmsizecod >> 1, 5); // bit_rate_code
  bw.bits(0, 5);               // reserved
  return bw.take();
}

struct Eac3Info {
  std::vector<uint8_t> dec3;
  uint32_t samplesPerFrame = 0;
};

// E-AC-3 sync frame (ETSI TS 102 366 Annex E.1.2.1 bsi) -> a dec3 payload
// modeling a single independent substream with no dependent substreams —
// correct for the overwhelming majority of real E-AC-3 tracks (plain 5.1/
// stereo, not object-based Atmos with extra substreams). bsmod isn't
// reliably present at a fixed position in the base header for E-AC-3 the
// way it is for AC-3 (it lives in the optional, frequently-absent
// Alternate Bit Stream Info), so it's fixed at 0 ("complete main") rather
// than parsed — correct for ordinary main-audio tracks, which is what this
// is used for. Returns false if the frame was too short/malformed to
// trust.
bool parseEac3(const uint8_t* frame, size_t size, Eac3Info& out) {
  if (size < 8) return false;
  BitReader br(frame, size);
  br.bits(16); // syncword
  br.bits(2);  // strmtyp
  br.bits(3);  // substreamid
  br.bits(11); // frmsiz
  const uint32_t fscod = br.bits(2);
  uint32_t numblkscod;
  if (fscod == 3) {
    br.bits(2);      // fscod2
    numblkscod = 3;  // reduced sample rate implies 6 blocks/frame
  } else {
    numblkscod = br.bits(2);
  }
  const uint32_t acmod = br.bits(3);
  const uint32_t lfeon = br.bits(1);
  const uint32_t bsid = br.bits(5);
  if (!br.ok()) return false;

  static const uint32_t kBlocksForCode[4] = {1, 2, 3, 6};
  out.samplesPerFrame = kBlocksForCode[numblkscod & 0x3] * 256;

  BitWriter bw;
  bw.bits(0, 13); // data_rate — advisory only; decoders derive the real rate from the bitstream itself
  bw.bits(0, 3);  // num_ind_sub - 1 == 0 (single independent substream)
  bw.bits(fscod, 2);
  bw.bits(bsid, 5);
  bw.bits(0, 1); // reserved
  bw.bits(0, 1); // asvc
  bw.bits(0, 3); // bsmod — see comment above
  bw.bits(acmod, 3);
  bw.bits(lfeon, 1);
  bw.bits(0, 3); // reserved
  bw.bits(0, 4); // num_dep_sub = 0
  bw.bits(0, 1); // reserved (num_dep_sub == 0 case)
  out.dec3 = bw.take();
  return true;
}

// ---- AVC/HEVC decoder configuration record parsing ------------------------
//
// Matroska stores CodecPrivate for these two CodecIDs as the exact same
// AVCDecoderConfigurationRecord / HEVCDecoderConfigurationRecord structure
// MP4 itself uses (ISO 14496-15) — a deliberate compatibility choice in the
// Matroska spec, not a coincidence. That means the SPS/PPS/VPS NAL bodies
// minimp4's low-level API wants (MP4E_set_sps/pps/vps) can be extracted by
// parsing this record directly, with no bitstream-level NAL scanning
// (mp4_h26x_write_nal-style) needed — and it's also where the real
// profile/tier/level fields for the hvcC patch (MP4E_set_hevc_ptl) live.
//
// This same record format is also why frame data can be fed to
// MP4E_put_sample() completely unchanged: Matroska's Block payload for
// these two CodecIDs is already length-prefixed NAL data, the exact sample
// format MP4 itself uses. Both writers below hardcode a 4-byte length
// prefix (lengthSizeMinusOne=3) in the avcC/hvcC they emit, which matches
// what every encoder seen in practice actually uses (confirmed against
// this module's own real test files); a source using a different length
// size would need the frame data itself rewritten, not just detected —
// not implemented, since it hasn't been observed to matter yet.

struct AvcConfig {
  std::vector<std::vector<uint8_t>> sps, pps;
};

bool parseAvcConfig(const uint8_t* d, size_t n, AvcConfig& out) {
  if (n < 6) return false;
  size_t p = 5;
  const int numSps = d[p++] & 0x1f;
  for (int i = 0; i < numSps && p + 2 <= n; i++) {
    const size_t len = (static_cast<size_t>(d[p]) << 8) | d[p + 1];
    p += 2;
    if (p + len > n) return false;
    out.sps.emplace_back(d + p, d + p + len);
    p += len;
  }
  if (p >= n) return false;
  const int numPps = d[p++];
  for (int i = 0; i < numPps && p + 2 <= n; i++) {
    const size_t len = (static_cast<size_t>(d[p]) << 8) | d[p + 1];
    p += 2;
    if (p + len > n) return false;
    out.pps.emplace_back(d + p, d + p + len);
    p += len;
  }
  return true;
}

struct HevcConfig {
  unsigned profileSpace = 0, tierFlag = 0, profileIdc = 0;
  unsigned profileCompatFlags = 0;
  uint64_t constraintFlags = 0; // low 48 bits used
  unsigned levelIdc = 0;
  std::vector<std::vector<uint8_t>> vps, sps, pps;
};

bool parseHevcConfig(const uint8_t* d, size_t n, HevcConfig& out) {
  if (n < 23) return false;
  out.profileSpace = (d[1] >> 6) & 0x3;
  out.tierFlag = (d[1] >> 5) & 0x1;
  out.profileIdc = d[1] & 0x1f;
  out.profileCompatFlags = (static_cast<unsigned>(d[2]) << 24) | (static_cast<unsigned>(d[3]) << 16) |
      (static_cast<unsigned>(d[4]) << 8) | d[5];
  out.constraintFlags = (static_cast<uint64_t>(d[6]) << 40) | (static_cast<uint64_t>(d[7]) << 32) |
      (static_cast<uint64_t>(d[8]) << 24) | (static_cast<uint64_t>(d[9]) << 16) |
      (static_cast<uint64_t>(d[10]) << 8) | d[11];
  out.levelIdc = d[12];
  size_t p = 22;
  const int numArrays = d[p++];
  for (int a = 0; a < numArrays && p + 3 <= n; a++) {
    const int nalType = d[p] & 0x3f;
    p += 1;
    const int numNalus = (static_cast<int>(d[p]) << 8) | d[p + 1];
    p += 2;
    for (int i = 0; i < numNalus && p + 2 <= n; i++) {
      const size_t len = (static_cast<size_t>(d[p]) << 8) | d[p + 1];
      p += 2;
      if (p + len > n) return false;
      std::vector<uint8_t> nal(d + p, d + p + len);
      if (nalType == HEVC_NAL_VPS) out.vps.push_back(std::move(nal));
      else if (nalType == HEVC_NAL_SPS) out.sps.push_back(std::move(nal));
      else if (nalType == HEVC_NAL_PPS) out.pps.push_back(std::move(nal));
      p += len;
    }
  }
  return true;
}

// ---- Remux session ----------------------------------------------------

struct RemuxSession {
  MP4E_mux_t* mux = nullptr;
  int mp4TrackId = -1;
  uint64_t matroskaTrackNumber = 0;
  uint64_t timestampScaleNs = 1000000;
  bool isVideo = false;
  RemuxKind kind = RemuxKind::Unsupported;
  uint32_t mp4TimeScale = 1000; // 90000 for video, sample rate for audio

  // AC-3/E-AC-3 only: MP4E_set_dsi can't be called at session-open time the
  // way it is for AAC/AVC/HEVC, because Matroska's CodecPrivate is empty
  // for these codecs — the dac3/dec3 fields only exist inside the
  // compressed bitstream. remuxChunk's handleBlock parses them from this
  // track's first real frame instead, the first time it sees one, and
  // clears this flag. See openRemuxSession and parseAc3Dac3/parseEac3.
  bool needsBsiFromFirstFrame = false;

  // Every remuxed track uses a constant per-sample duration, fed straight
  // through in arrival order — video to sidestep B-frame decode/
  // presentation-order divergence (see openRemuxSession's comment on
  // `videoDefaultDurationNs`), audio because Matroska only carries one
  // timecode per Block even when the Block is laced into several frames,
  // so there's no per-frame timecode to derive a delta duration from
  // anyway. An earlier version of this session computed audio duration
  // from the delta between consecutive frames' timecodes, one frame
  // behind — that only ever saw frame 0 of each Block, since it was
  // written before delacing (below) was added, and silently produced
  // almost no audio output on any real-world laced AAC track.
  uint32_t fixedDurationUnits = 0;

  // Bytes produced by the write callback since the last drain, plus how
  // many total bytes have already been drained — see writeCallback's
  // comment for why the two together are what make append-only writes
  // safe to hand off incrementally instead of buffering the whole session.
  std::vector<uint8_t> outputBuffer;
  uint64_t drainedBytes = 0;

  // Closing a track that never received a sample faults inside minimp4
  // (it computes over an empty sample list), so closeRemuxSession skips
  // MP4E_close entirely in that case — see its comment.
  uint64_t samplesWritten = 0;

  // Detects a seek purely from the byte offset jumping, with no separate
  // "this is a seek" signal from JS: normal forward playback always calls
  // remuxChunk with baseOffset equal to where the previous call left off,
  // so any other baseOffset means the caller jumped — a seek. When that
  // happens the video track needs to drop leading frames until the next
  // real keyframe, since the decoder has no reference frames from before
  // the jump and choking on a non-keyframe first sample is exactly what
  // produced "MPB Call failed with code: 50004" at send_video_sample
  // after a seek. Audio has no such dependency, so this only matters for
  // isVideo sessions — see handleBlock in remuxChunk.
  uint64_t lastProcessedEndOffset = 0;
  bool hasProcessedAny = false;
  bool waitingForKeyframe = false;
};

std::mutex g_sessionsMutex;
std::unordered_map<int, RemuxSession> g_sessions;
int g_nextSessionId = 1;

int writeCallback(int64_t offset, const void* buffer, size_t size, void* token) {
  auto* session = static_cast<RemuxSession*>(token);
  const uint64_t expected = session->drainedBytes + session->outputBuffer.size();
  if (static_cast<uint64_t>(offset) != expected) return -1; // violates the append-only assumption this design relies on
  const auto* src = static_cast<const uint8_t*>(buffer);
  session->outputBuffer.insert(session->outputBuffer.end(), src, src + size);
  return 0;
}

// AAC-LC (the only audio codec this module remuxes — see
// isRemuxableAudioCodecId in mkvMse.ts) always encodes 1024 samples per
// frame. Since an audio track's MP4 time_scale is set to its sample rate
// (see mp4TimeScale below), that duration is exactly 1024 time-scale
// units — no conversion needed, and no per-frame timecode required.
constexpr uint32_t AAC_LC_SAMPLES_PER_FRAME = 1024;

} // namespace

int openRemuxSession(const std::string& codecId, const uint8_t* codecPrivateData, size_t codecPrivateSize,
    uint64_t trackNumber, uint32_t param1, uint32_t param2, uint64_t timestampScale, uint64_t videoDefaultDurationNs) {
  const RemuxKind kind = remuxKindForCodecId(codecId);
  if (kind == RemuxKind::Unsupported) return -1;

  std::lock_guard<std::mutex> lock(g_sessionsMutex);
  const int id = g_nextSessionId++;
  // Constructed directly inside the map (not via a local unique_ptr later
  // moved in) deliberately: std::unordered_map guarantees an element's
  // address stays stable across further insertions/rehashes as long as it
  // isn't erased, which is exactly the guarantee minimp4's write_callback
  // token needs, since that token has to stay valid across every
  // remuxChunk call for this session's entire lifetime. A move (construct
  // locally, then move into the map) would leave the token pointing at the
  // moved-from original the instant this function returns — a real bug
  // caught here before it ever ran, not a hypothetical one.
  RemuxSession& session = g_sessions[id];
  session.matroskaTrackNumber = trackNumber;
  session.timestampScaleNs = timestampScale > 0 ? timestampScale : 1000000;
  session.kind = kind;
  session.isVideo = (kind == RemuxKind::Avc || kind == RemuxKind::Hevc);
  session.mp4TimeScale = session.isVideo ? 90000 : param1; // param1 = sampleRate for audio
  // Opus always decodes at 48 kHz regardless of what the container reports
  // as the track's sampling frequency (RFC 7845 §3: InputSampleRate is
  // informational, describing the ORIGINAL source rate, not the decode
  // rate). Sample durations below are counted in 48 kHz units, so the MP4
  // timescale has to match or every Opus track would play at the wrong
  // speed whenever Matroska happened to carry a non-48k SamplingFrequency.
  if (kind == RemuxKind::Opus) session.mp4TimeScale = 48000;
  // A session can be opened to start anywhere in the file, not just at its
  // beginning — seeking works by closing this session and opening a fresh
  // one positioned at the seek target (see mkvMse.ts's restartAt). Feeding
  // a decoder mid-GOP gives it frames whose reference frames it never saw,
  // so every video session starts by dropping frames until a real keyframe
  // arrives. At the start of the file that's free: the first frame IS a
  // keyframe, so it's accepted immediately and nothing is lost.
  session.waitingForKeyframe = session.isVideo;

  const auto fail = [&]() {
    g_sessions.erase(id);
    return -1;
  };

  if (session.isVideo && videoDefaultDurationNs > 0) {
    const double units = (static_cast<double>(videoDefaultDurationNs) / 1e9) * static_cast<double>(session.mp4TimeScale);
    session.fixedDurationUnits = static_cast<uint32_t>(units + 0.5);
  } else if (session.isVideo) {
    // No KaxTrackDefaultDuration to anchor a constant duration on — the
    // fixed-duration approach needs SOME per-frame duration to use, so
    // this track isn't remuxed at all rather than guess one.
    return fail();
  } else if (kind == RemuxKind::Ac3) {
    session.fixedDurationUnits = 1536; // fixed by spec — always 6 blocks of 256 samples
    session.needsBsiFromFirstFrame = true;
  } else if (kind == RemuxKind::Eac3) {
    // Varies with numblkscod — left at 0 until remuxChunk parses the first
    // real frame and sets it from there (see needsBsiFromFirstFrame).
    session.fixedDurationUnits = 0;
    session.needsBsiFromFirstFrame = true;
  } else if (kind == RemuxKind::Flac) {
    // Resolved below from CodecPrivate's STREAMINFO — everything FLAC needs
    // is available upfront, unlike AC-3/E-AC-3, so no first-frame parsing.
    session.fixedDurationUnits = 0;
  } else if (kind == RemuxKind::Opus) {
    // Split source, unlike every other codec here: the dOps box comes from
    // CodecPrivate (set below), but packet duration is encoded per-packet in
    // the TOC byte, so it can only be read off a real frame. Encoders in
    // practice hold one frame size for a whole stream — 20 ms is libopus's
    // default — so the first packet's duration is taken as the session's
    // constant, the same bet already made for E-AC-3's numblkscod.
    session.fixedDurationUnits = 0;
    session.needsBsiFromFirstFrame = true;
  } else {
    session.fixedDurationUnits = AAC_LC_SAMPLES_PER_FRAME;
  }

  MP4E_mux_t* mux = MP4E_open(/*sequential_mode_flag=*/0, /*enable_fragmentation=*/1, &session, &writeCallback);
  if (!mux) return fail();
  session.mux = mux;

  MP4E_track_t track{};
  track.language[0] = 'u';
  track.language[1] = 'n';
  track.language[2] = 'd';
  track.time_scale = session.mp4TimeScale;

  if (session.isVideo) {
    track.track_media_kind = e_video;
    track.object_type_indication = (kind == RemuxKind::Avc) ? MP4_OBJECT_TYPE_AVC : MP4_OBJECT_TYPE_HEVC;
    track.u.v.width = static_cast<int>(param1);
    track.u.v.height = static_cast<int>(param2);
  } else {
    track.track_media_kind = e_audio;
    track.object_type_indication = kind == RemuxKind::Eac3 ? MP4_OBJECT_TYPE_EAC3
        : kind == RemuxKind::Ac3                            ? MP4_OBJECT_TYPE_AC3
        : kind == RemuxKind::Flac                           ? MP4_OBJECT_TYPE_FLAC
        : kind == RemuxKind::Opus                           ? MP4_OBJECT_TYPE_OPUS
                                                              : MP4_OBJECT_TYPE_AUDIO_ISO_IEC_14496_3;
    track.u.a.channelcount = param2; // param2 = channel count for audio
  }

  const int trackId = MP4E_add_track(mux, &track);
  if (trackId < 0) {
    MP4E_close(mux);
    return fail();
  }
  session.mp4TrackId = trackId;

  if (kind == RemuxKind::Avc) {
    AvcConfig cfg;
    if (!parseAvcConfig(codecPrivateData, codecPrivateSize, cfg) || cfg.sps.empty() || cfg.pps.empty()) {
      MP4E_close(mux);
      return fail();
    }
    for (auto& sps : cfg.sps) MP4E_set_sps(mux, trackId, sps.data(), static_cast<int>(sps.size()));
    for (auto& pps : cfg.pps) MP4E_set_pps(mux, trackId, pps.data(), static_cast<int>(pps.size()));
  } else if (kind == RemuxKind::Hevc) {
    HevcConfig cfg;
    if (!parseHevcConfig(codecPrivateData, codecPrivateSize, cfg) || cfg.sps.empty()) {
      MP4E_close(mux);
      return fail();
    }
    for (auto& vps : cfg.vps) MP4E_set_vps(mux, trackId, vps.data(), static_cast<int>(vps.size()));
    for (auto& sps : cfg.sps) MP4E_set_sps(mux, trackId, sps.data(), static_cast<int>(sps.size()));
    for (auto& pps : cfg.pps) MP4E_set_pps(mux, trackId, pps.data(), static_cast<int>(pps.size()));
    MP4E_set_hevc_ptl(mux, trackId, cfg.profileSpace, cfg.tierFlag, cfg.profileIdc, cfg.profileCompatFlags,
        cfg.constraintFlags, cfg.levelIdc);
  } else if (kind == RemuxKind::Aac) {
    if (codecPrivateSize == 0) {
      // No AudioSpecificConfig to hand the decoder — playable in principle
      // with an implicit config, but not attempted here.
      MP4E_close(mux);
      return fail();
    }
    MP4E_set_dsi(mux, trackId, codecPrivateData, static_cast<int>(codecPrivateSize));
  } else if (kind == RemuxKind::Flac) {
    std::vector<uint8_t> dfLa;
    uint32_t samplesPerFrame = 0;
    if (!parseFlacConfig(codecPrivateData, codecPrivateSize, dfLa, samplesPerFrame)) {
      MP4E_close(mux);
      return fail();
    }
    session.fixedDurationUnits = samplesPerFrame;
    MP4E_set_dsi(mux, trackId, dfLa.data(), static_cast<int>(dfLa.size()));
  } else if (kind == RemuxKind::Opus) {
    std::vector<uint8_t> dOps;
    if (!parseOpusConfig(codecPrivateData, codecPrivateSize, dOps)) {
      MP4E_close(mux);
      return fail();
    }
    MP4E_set_dsi(mux, trackId, dOps.data(), static_cast<int>(dOps.size()));
    // fixedDurationUnits still comes from the first packet's TOC byte —
    // see needsBsiFromFirstFrame.
  }
  // Ac3/Eac3: MP4E_set_dsi is deferred to remuxChunk's first real frame for
  // this track — see needsBsiFromFirstFrame. Opus is the reverse split: dsi
  // is set here, duration comes from the first frame.

  return id;
}

std::vector<uint8_t> remuxChunk(int sessionId, const uint8_t* data, size_t size, uint64_t baseOffset) {
  // bytesConsumed (the return value's header) is relative to `data`; the
  // caller, which already tracks absolute file position, adds baseOffset
  // itself. baseOffset is still needed here, though — see
  // waitingForKeyframe's comment on RemuxSession for why.
  std::vector<uint8_t> header8(8, 0);
  RemuxSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_sessionsMutex);
    auto it = g_sessions.find(sessionId);
    if (it == g_sessions.end()) return header8;
    session = &it->second;
  }

  if (session->isVideo) {
    if (session->hasProcessedAny && baseOffset != session->lastProcessedEndOffset) {
      session->waitingForKeyframe = true;
    }
    session->hasProcessedAny = true;
  }

  uint64_t bytesConsumed = 0;
  try {
    BoundedMemIO io;
    io.write(data, size);
    io.setFilePointer(0);
    EbmlStream stream(io);

    // Same raw byte-pattern search as findClusters, for the same reason:
    // looping FindNextID is not a scan, and can silently end this whole walk
    // on a garbage "unknown size" decode before reaching real data. See
    // findClusterIdOffset's comment for the full explanation. In the normal
    // case `data` starts exactly at a Cluster boundary already confirmed by
    // findClusters, so the first candidate found here is almost always at
    // searchPos 0 immediately — this is defensive, not the common path.
    size_t searchPos = 0;
    for (;;) {
      const size_t candidate = findClusterIdOffset(data, size, searchPos);
      if (candidate >= size) break;

      io.setFilePointer(static_cast<std::int64_t>(candidate), seek_beginning);
      std::unique_ptr<EbmlElement> el(stream.FindNextID<KaxCluster>(UINT64_MAX));
      if (!el) {
        searchPos = candidate + kClusterIdBytes;
        continue;
      }
      auto& cluster = static_cast<KaxCluster&>(*el);
      const uint64_t pos = cluster.GetElementPosition();
      const uint64_t end = cluster.GetEndPosition();
      // Same false-Cluster-ID guard as findClusters, for the same reason:
      // without it the jump below can't advance and this loop spins
      // forever. See findClusters for the full explanation. This must run
      // before the chunk-boundary check below — a degenerate `end` can
      // otherwise satisfy `end > size` and break the whole scan on the
      // first false match, discarding the rest of a chunk that has real
      // Clusters later in it.
      if (end <= pos) {
        searchPos = candidate + kClusterIdBytes;
        continue;
      }
      // Same chunk-boundary guard as findClusters — see its comment.
      if (end > size) break;

      // Shared by both SimpleBlock and a BlockGroup's inner Block: both
      // extend KaxInternalBlock and expose the identical TrackNum/
      // NumberFrames/GetBuffer surface. Takes raw values rather than the
      // block object itself deliberately — for the BlockGroup case below,
      // the inner Block is deleted by walkChildren the instant its own
      // onLeaf callback returns, so nothing can hold a reference/pointer
      // to it past that point; copying out just the bytes actually
      // needed sidesteps that lifetime entirely instead of fighting it.
      auto handleBlock = [&](uint16_t trackNum, bool keyframe, const uint8_t* frameData, size_t frameSize) {
        if (trackNum != session->matroskaTrackNumber) return;
        if (session->waitingForKeyframe) {
          // Dropping frames here, not just skipping the mux call — a
          // decoder resuming after a seek has no reference frames from
          // before the jump, so anything before the next real keyframe
          // is undecodable, not merely redundant.
          if (!keyframe) return;
          session->waitingForKeyframe = false;
        }
        if (session->needsBsiFromFirstFrame) {
          // AC-3/E-AC-3/Opus — see openRemuxSession and the
          // parseAc3Dac3/parseEac3/opusPacketDurationSamples comments for
          // what each one needs off a real frame. If this particular frame
          // fails to parse (truncated/corrupt), it's dropped and the next
          // frame gets another attempt rather than muxing a track minimp4
          // would build a malformed sample entry for.
          bool parsed = false;
          if (session->kind == RemuxKind::Opus) {
            // Opus already had its dOps box set at session-open time from
            // CodecPrivate; the only thing missing is the packet duration,
            // which lives in the TOC byte of an actual packet.
            const uint32_t samples = opusPacketDurationSamples(frameData, frameSize);
            if (samples > 0) {
              session->fixedDurationUnits = samples;
              parsed = true;
            }
          } else if (session->kind == RemuxKind::Ac3) {
            std::vector<uint8_t> dac3 = parseAc3Dac3(frameData, frameSize);
            if (!dac3.empty()) {
              MP4E_set_dsi(session->mux, session->mp4TrackId, dac3.data(), static_cast<int>(dac3.size()));
              parsed = true;
            }
          } else if (session->kind == RemuxKind::Eac3) {
            Eac3Info info;
            if (parseEac3(frameData, frameSize, info) && !info.dec3.empty()) {
              MP4E_set_dsi(session->mux, session->mp4TrackId, info.dec3.data(), static_cast<int>(info.dec3.size()));
              if (info.samplesPerFrame > 0) session->fixedDurationUnits = info.samplesPerFrame;
              parsed = true;
            }
          }
          if (!parsed) return;
          session->needsBsiFromFirstFrame = false;
        }
        session->samplesWritten++;
        MP4E_put_sample(session->mux, 0, frameData, static_cast<int>(frameSize),
            static_cast<int>(session->fixedDurationUnits), keyframe ? MP4E_SAMPLE_RANDOM_ACCESS : MP4E_SAMPLE_DEFAULT);
      };

      int upper = 0;
      EbmlElement* ce = stream.FindNextElement(EBML_CONTEXT(&cluster), upper, UINT64_MAX, true);
      while (ce != nullptr && upper <= 0) {
        if (auto* tc = dynamic_cast<KaxClusterTimestamp*>(ce)) {
          tc->ReadData(stream.I_O()); // ReadData alone fully consumes it — no SkipData call needed or correct here
        } else if (auto* sb = dynamic_cast<KaxSimpleBlock*>(ce)) {
          sb->ReadData(stream.I_O());
          // A Block can be "laced" — several frames packed into one Block
          // to cut per-Block overhead, common for small audio frames (a
          // typical AAC frame is ~1024 samples, so muxers often batch
          // several per Block). libmatroska already decodes the lacing
          // header for us — NumberFrames()/GetBuffer(i) hand back each
          // frame separately — so this just has to loop over all of them.
          // An earlier version only ever read GetBuffer(0), which silently
          // dropped virtually all audio on any real-world laced AAC track.
          const uint16_t trackNum = sb->TrackNum();
          const bool keyframe = sb->IsKeyframe();
          for (unsigned i = 0; i < sb->NumberFrames(); ++i) {
            DataBuffer& buf = sb->GetBuffer(i);
            handleBlock(trackNum, keyframe, buf.Buffer(), buf.Size());
          }
        } else if (auto* bg = dynamic_cast<KaxBlockGroup*>(ce)) {
          // A significant fraction of real encodes (confirmed against this
          // module's own test files) put B-frames in a BlockGroup instead
          // of a bare SimpleBlock, apparently so the muxer can attach a
          // ReferenceBlock — skipping BlockGroup entirely (an earlier,
          // "uncommon legacy case" assumption) silently dropped roughly
          // two-thirds of all video frames, confirmed by decoding the
          // muxed output and finding ~8fps out of a 24fps source. Its
          // children (Block, ReferenceBlock, BlockDuration) are all leaves
          // — none recurse further — so walkChildren's leftover-threading
          // is sound here for the same reason it's sound for Info's or
          // TrackVideo's children.
          bool hasReference = false;
          uint16_t blockTrackNum = 0;
          // Frame bytes copied out (not held as pointers) inside the
          // walkChildren callback below, since it deletes the KaxBlock the
          // instant the callback returns — see handleBlock's comment.
          std::vector<std::vector<uint8_t>> blockFrames;
          int bgUpper = 0;
          EbmlElement* next = walkChildren(stream, *bg, bgUpper, [&](EbmlElement& bc) {
            if (auto* b = dynamic_cast<KaxBlock*>(&bc)) {
              b->ReadData(stream.I_O());
              blockTrackNum = b->TrackNum();
              blockFrames.reserve(b->NumberFrames());
              for (unsigned i = 0; i < b->NumberFrames(); ++i) {
                DataBuffer& buf = b->GetBuffer(i);
                blockFrames.emplace_back(buf.Buffer(), buf.Buffer() + buf.Size());
              }
            } else if (dynamic_cast<KaxReferenceBlock*>(&bc) != nullptr) {
              // Absence of any ReferenceBlock is what marks a keyframe —
              // per Matroska convention, the value itself isn't needed,
              // only that this element exists at all.
              hasReference = true;
              bc.SkipData(stream, EBML_CONTEXT(&bc));
            } else {
              bc.SkipData(stream, EBML_CONTEXT(&bc));
            }
          });
          for (auto& frame : blockFrames) handleBlock(blockTrackNum, !hasReference, frame.data(), frame.size());
          delete ce;
          ce = next;
          upper = bgUpper;
          continue;
        } else {
          ce->SkipData(stream, EBML_CONTEXT(ce));
        }
        delete ce;
        ce = stream.FindNextElement(EBML_CONTEXT(&cluster), upper, UINT64_MAX, true);
      }

      bytesConsumed = end;
      searchPos = static_cast<size_t>(end);
    }
  } catch (const std::exception&) {
    // Whatever was already muxed before the exception is still valid —
    // return it rather than discarding progress; the caller will simply
    // not advance past `bytesConsumed` and can retry from there.
  } catch (...) {
  }

  if (session->isVideo && bytesConsumed > 0) session->lastProcessedEndOffset = baseOffset + bytesConsumed;

  std::vector<uint8_t> out(8 + session->outputBuffer.size());
  std::memcpy(out.data(), &bytesConsumed, 8);
  std::memcpy(out.data() + 8, session->outputBuffer.data(), session->outputBuffer.size());
  session->drainedBytes += session->outputBuffer.size();
  session->outputBuffer.clear();
  return out;
}

namespace {

// ASS/SSA Block payload is "ReadOrder,Layer,Style,Name,MarginL,MarginR,
// MarginV,Effect,Text" — the Text field (everything after the 8th comma,
// since Text itself can legally contain commas) with its own override tags
// ({\i1}, {\pos(400,570)}, etc) stripped rather than translated, and \N/\n
// explicit breaks turned into real newlines. Readable, just without ASS's
// own styling/positioning applied — the same tradeoff subtitles.ts already
// makes for tags it doesn't render.
std::string extractAssDialogueText(const std::string& payload) {
  size_t i = 0;
  int commas = 0;
  for (; i < payload.size() && commas < 8; i++) {
    if (payload[i] == ',') commas++;
  }
  const std::string text = commas == 8 ? payload.substr(i) : payload;
  std::string out;
  bool inBrace = false;
  for (size_t j = 0; j < text.size(); j++) {
    const char c = text[j];
    if (c == '{') {
      inBrace = true;
    } else if (c == '}') {
      inBrace = false;
    } else if (inBrace) {
      // skip — inside an override block
    } else if (c == '\\' && j + 1 < text.size() && (text[j + 1] == 'N' || text[j + 1] == 'n')) {
      out += '\n';
      j++;
    } else {
      out += c;
    }
  }
  return out;
}

} // namespace

// Extracts subtitle cues for exactly one track from a chunk anywhere in the
// file — same tolerant, self-scanning approach as findClusters (a
// byte-pattern search for each Cluster's ID, confirmed once via FindNextID
// rather than trusted to locate them itself; see findClusterIdOffset's
// comment), so unlike remuxChunk this has no "must start exactly at a
// Cluster boundary" contract. Stateless: no session, nothing persisted
// between calls — the caller (mkvMse.ts) accumulates cues across calls as
// more of the file is fetched, the same way it already accumulates
// Clusters for the seek index.
//
// Only S_TEXT/UTF8 and S_TEXT/ASS|SSA are handled: UTF8's Block payload IS
// the cue text verbatim (Matroska's own convention for that CodecID);
// ASS/SSA needs its Text field pulled out of the Dialogue line — see
// extractAssDialogueText. Image-based subtitle formats (S_HDMV/PGS,
// S_VOBSUB) would need bitmap decoding, a different problem entirely, and
// aren't attempted here.
//
// Returns JSON: {"cues":[{"startTicks":N,"durationTicks":N,"text":"..."}]}
// — ticks are raw Segment-timestampScale units, same convention as
// findClusters' timecode field; the caller already has toSeconds() for
// converting those.
std::string extractTextCues(const uint8_t* data, size_t size, uint64_t trackNumber, bool isAss) {
  try {
    BoundedMemIO io;
    io.write(data, size);
    EbmlStream stream(io);

    std::ostringstream out;
    out << "{\"cues\":[";
    bool first = true;

    size_t searchPos = 0;
    for (;;) {
      const size_t candidate = findClusterIdOffset(data, size, searchPos);
      if (candidate >= size) break;

      io.setFilePointer(static_cast<std::int64_t>(candidate), seek_beginning);
      std::unique_ptr<EbmlElement> el(stream.FindNextID<KaxCluster>(UINT64_MAX));
      if (!el) {
        searchPos = candidate + kClusterIdBytes;
        continue;
      }
      auto& cluster = static_cast<KaxCluster&>(*el);
      const uint64_t pos = cluster.GetElementPosition();
      const uint64_t end = cluster.GetEndPosition();
      if (end <= pos) {
        searchPos = candidate + kClusterIdBytes;
        continue;
      }

      uint64_t clusterTimecode = 0;
      const auto emitCue = [&](int64_t relativeTicks, uint64_t durationTicks, const std::string& raw) {
        std::string text = isAss ? extractAssDialogueText(raw) : raw;
        if (text.empty()) return;
        if (!first) out << ",";
        first = false;
        const uint64_t startTicks = clusterTimecode + static_cast<uint64_t>(relativeTicks);
        out << "{\"startTicks\":" << startTicks << ",\"durationTicks\":" << durationTicks << ",\"text\":\""
            << jsonEscape(text) << "\"}";
      };

      int upper = 0;
      EbmlElement* ce = stream.FindNextElement(EBML_CONTEXT(&cluster), upper, UINT64_MAX, true);
      while (ce != nullptr && upper <= 0) {
        if (auto* tc = dynamic_cast<KaxClusterTimestamp*>(ce)) {
          tc->ReadData(stream.I_O());
          clusterTimecode = tc->GetValue();
        } else if (auto* sb = dynamic_cast<KaxSimpleBlock*>(ce)) {
          sb->ReadData(stream.I_O());
          // A SimpleBlock has no duration field. Real subtitle tracks
          // always use BlockGroup+BlockDuration instead (a cue's whole
          // point is a defined display span) — this branch exists for
          // robustness, not because it's expected to fire, so a fixed
          // fallback duration beats silently dropping the cue.
          if (sb->TrackNum() == trackNumber) {
            for (unsigned i = 0; i < sb->NumberFrames(); ++i) {
              DataBuffer& buf = sb->GetBuffer(i);
              emitCue(sb->GetRelativeTimestamp(), 2000,
                  std::string(reinterpret_cast<const char*>(buf.Buffer()), buf.Size()));
            }
          }
        } else if (auto* bg = dynamic_cast<KaxBlockGroup*>(ce)) {
          uint16_t blockTrackNum = 0;
          int16_t relativeTimestamp = 0;
          uint64_t durationTicks = 0;
          std::string text;
          bool haveBlock = false;
          int bgUpper = 0;
          EbmlElement* next = walkChildren(stream, *bg, bgUpper, [&](EbmlElement& bc) {
            if (auto* b = dynamic_cast<KaxBlock*>(&bc)) {
              b->ReadData(stream.I_O());
              blockTrackNum = b->TrackNum();
              relativeTimestamp = b->GetRelativeTimestamp();
              if (b->NumberFrames() > 0) {
                DataBuffer& buf = b->GetBuffer(0);
                text.assign(reinterpret_cast<const char*>(buf.Buffer()), buf.Size());
                haveBlock = true;
              }
            } else if (auto* dur = dynamic_cast<KaxBlockDuration*>(&bc)) {
              dur->ReadData(stream.I_O());
              durationTicks = dur->GetValue();
            } else {
              bc.SkipData(stream, EBML_CONTEXT(&bc));
            }
          });
          if (haveBlock && blockTrackNum == trackNumber) emitCue(relativeTimestamp, durationTicks, text);
          delete ce;
          ce = next;
          upper = bgUpper;
          continue;
        } else {
          ce->SkipData(stream, EBML_CONTEXT(ce));
        }
        delete ce;
        ce = stream.FindNextElement(EBML_CONTEXT(&cluster), upper, UINT64_MAX, true);
      }

      if (end > size) break;
      searchPos = static_cast<size_t>(end);
    }
    out << "]}";
    return out.str();
  } catch (const std::exception& e) {
    return cuesErrorJson(e.what());
  } catch (...) {
    return cuesErrorJson("unknown native exception");
  }
}

void closeRemuxSession(int sessionId) {
  std::lock_guard<std::mutex> lock(g_sessionsMutex);
  auto it = g_sessions.find(sessionId);
  if (it == g_sessions.end()) return;
  // The final pending frame (if any) is deliberately not flushed — its
  // duration can only be guessed at close time, and dropping the last
  // fraction of a second of a track that's being torn down anyway is a
  // better trade than writing a fragment with a made-up duration.
  //
  // A track that never received a single sample is closed WITHOUT
  // MP4E_close: minimp4 faults walking an empty sample list there, which
  // showed up as a native SIGSEGV on every source switch whenever a
  // session had been starved of data. Leaking the mux for such a session
  // is a deliberate trade — it only happens on a track that produced
  // nothing, and a small leak beats crashing the app during teardown.
  if (it->second.samplesWritten > 0) MP4E_close(it->second.mux);
  g_sessions.erase(it);
}

} // namespace MkvDemuxCore
