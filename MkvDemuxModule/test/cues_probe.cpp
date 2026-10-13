// Host-side test tool for the seek index: parses the init segment for
// segmentDataStart/cuesPosition, then hands parseCues the bytes at that
// position — the same two steps mkvMse.ts takes on-device.
//
// Usage: cues_probe <file.mkv> [jumpToCueIndex]
//   With a cue index, also simulates playback-then-seek on ONE remux
//   session pair: 4MB from the start, then 4MB from that cue's Cluster.
//   Writes /tmp/jump.{video,audio}.mp4 so the absolute timeline can be
//   checked with ffprobe.
#include "MkvDemuxCore.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {
long long jsonNumber(const std::string& json, const char* key) {
  const std::string needle = std::string("\"") + key + "\":";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return -2;
  return std::atoll(json.c_str() + pos + needle.size());
}

std::string jsonString(const std::string& json, const char* key) {
  const std::string needle = std::string("\"") + key + "\":\"";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return "";
  pos += needle.size();
  return json.substr(pos, json.find('"', pos) - pos);
}

std::vector<uint8_t> base64Decode(const std::string& in) {
  static const char* table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<uint8_t> out;
  int val = 0;
  int bits = -8;
  for (char c : in) {
    const char* f = std::strchr(table, c);
    if (c == '=' || !f) break;
    val = (val << 6) + static_cast<int>(f - table);
    bits += 6;
    if (bits >= 0) {
      out.push_back(static_cast<uint8_t>((val >> bits) & 0xFF));
      bits -= 8;
    }
  }
  return out;
}

void writeFile(const char* path, const std::vector<uint8_t>& bytes) {
  FILE* f = std::fopen(path, "wb");
  std::fwrite(bytes.data(), 1, bytes.size(), f);
  std::fclose(f);
}
} // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::printf("usage: %s <file.mkv> [jumpToCueIndex]\n", argv[0]);
    return 1;
  }
  std::ifstream f(argv[1], std::ios::binary);
  std::vector<uint8_t> whole((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  const size_t initBytes = std::min<size_t>(whole.size(), 4u << 20);
  const std::string init = MkvDemuxCore::parseInitSegment(whole.data(), initBytes);
  const long long segStart = jsonNumber(init, "segmentDataStart");
  const long long cuesPos = jsonNumber(init, "cuesPosition");
  std::printf("segmentDataStart=%lld cuesPosition=%lld\n", segStart, cuesPos);
  if (cuesPos < 0) return 0;
  const size_t at = static_cast<size_t>(segStart + cuesPos);
  if (at >= whole.size()) {
    std::printf("cues beyond the bytes on disk (truncated file)\n");
    return 0;
  }
  const std::string cues = MkvDemuxCore::parseCues(whole.data() + at, whole.size() - at);
  std::printf("%.*s ...\n", 300, cues.c_str());
  if (argc < 3) return 0;

  // The Nth cue point's absolute byte offset.
  const int want = std::atoi(argv[2]);
  long long jumpOffset = -1;
  size_t p = cues.find("[[");
  if (p != std::string::npos) p++;
  for (int i = 0; p != std::string::npos && p < cues.size(); i++) {
    long long t = 0, track = 0, cluster = 0;
    if (std::sscanf(cues.c_str() + p, "[%lld,%lld,%lld]", &t, &track, &cluster) != 3) break;
    if (i == want) {
      jumpOffset = segStart + cluster;
      std::printf("jumping to cue %d: time %lld at byte %lld\n", i, t, jumpOffset);
      break;
    }
    p = cues.find('[', cues.find(']', p));
  }
  if (jumpOffset < 0) return 1;

  const std::vector<uint8_t> vcp = base64Decode(jsonString(init, "videoCodecPrivateB64"));
  const std::vector<uint8_t> acp = base64Decode(jsonString(init, "audioCodecPrivateB64"));
  const uint64_t scale = static_cast<uint64_t>(jsonNumber(init, "timestampScale"));
  const int v = MkvDemuxCore::openRemuxSession(jsonString(init, "videoCodecId"), vcp.data(), vcp.size(),
      jsonNumber(init, "videoTrackNumber"), static_cast<uint32_t>(jsonNumber(init, "videoWidth")),
      static_cast<uint32_t>(jsonNumber(init, "videoHeight")), scale,
      static_cast<uint64_t>(jsonNumber(init, "videoDefaultDurationNs")));
  const int a = MkvDemuxCore::openRemuxSession(jsonString(init, "audioCodecId"), acp.data(), acp.size(),
      jsonNumber(init, "audioTrackNumber"), static_cast<uint32_t>(jsonNumber(init, "audioSampleRate")),
      static_cast<uint32_t>(jsonNumber(init, "audioChannels")), scale, 0);
  std::vector<uint8_t> vout, aout;
  auto feed = [&](size_t from) {
    const size_t len = std::min<size_t>(4u << 20, whole.size() - from);
    const auto rv = MkvDemuxCore::remuxChunk(v, whole.data() + from, len, from);
    const auto ra = MkvDemuxCore::remuxChunk(a, whole.data() + from, len, from);
    vout.insert(vout.end(), rv.begin() + 8, rv.end());
    aout.insert(aout.end(), ra.begin() + 8, ra.end());
  };
  feed(static_cast<size_t>(jsonNumber(init, "initSegmentEnd")));
  feed(static_cast<size_t>(jumpOffset));
  MkvDemuxCore::closeRemuxSession(v);
  MkvDemuxCore::closeRemuxSession(a);
  writeFile("/tmp/jump.video.mp4", vout);
  writeFile("/tmp/jump.audio.mp4", aout);
  std::printf("wrote /tmp/jump.video.mp4 (%zu) /tmp/jump.audio.mp4 (%zu)\n", vout.size(), aout.size());
  return 0;
}
