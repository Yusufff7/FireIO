// Host-side test tool for extractTextCues. Parses the init segment to find
// subtitle tracks, then extracts cues from the whole file for the given
// track (or the first one found).
//
// Usage: subs_probe <file.mkv> [trackNumber | all]
//   "all" exercises the multi-track mode (every subtitle track in one pass,
//   raw text tagged with its track number) that mkvMse.ts uses on-device.
#include "MkvDemuxCore.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

namespace {
long jsonNumber(const std::string& json, const char* key) {
  const std::string needle = std::string("\"") + key + "\":";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return -1;
  pos += needle.size();
  return std::atol(json.c_str() + pos);
}
} // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::printf("usage: %s <file.mkv> [trackNumber]\n", argv[0]);
    return 1;
  }
  std::ifstream f(argv[1], std::ios::binary);
  std::vector<uint8_t> whole((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  std::printf("file size: %zu bytes\n", whole.size());

  const std::string initJson = MkvDemuxCore::parseInitSegment(whole.data(), whole.size());
  std::printf("init: %.*s...\n\n", 300, initJson.c_str());

  if (argc > 2 && std::string(argv[2]) == "all") {
    uint64_t mask = 0;
    const size_t subsPos = initJson.find("\"subtitleTracks\":[");
    for (size_t p = initJson.find("\"trackNumber\":", subsPos); subsPos != std::string::npos && p != std::string::npos;
         p = initJson.find("\"trackNumber\":", p + 1)) {
      const long tn = std::atol(initJson.c_str() + p + 14);
      if (tn > 0 && tn < 64) mask |= uint64_t{1} << tn;
    }
    std::printf("extracting all subtitle tracks, mask=0x%llx\n\n", static_cast<unsigned long long>(mask));
    std::printf("%s\n", MkvDemuxCore::extractTextCuesForTracks(whole.data(), whole.size(), mask, false, true).c_str());
    return 0;
  }

  long trackNumber = argc > 2 ? std::atol(argv[2]) : -1;
  if (trackNumber < 0) {
    const size_t subsPos = initJson.find("\"subtitleTracks\":[");
    if (subsPos == std::string::npos) {
      std::printf("no subtitleTracks field\n");
      return 1;
    }
    const size_t tnPos = initJson.find("\"trackNumber\":", subsPos);
    if (tnPos == std::string::npos) {
      std::printf("no subtitle tracks found\n");
      return 1;
    }
    trackNumber = std::atol(initJson.c_str() + tnPos + 14);
  }
  const bool isAss = initJson.find("S_TEXT/ASS") != std::string::npos || initJson.find("S_TEXT/SSA") != std::string::npos;
  std::printf("extracting track %ld (isAss=%d)\n\n", trackNumber, isAss);

  const std::string cuesJson =
      MkvDemuxCore::extractTextCues(whole.data(), whole.size(), static_cast<uint64_t>(trackNumber), isAss);
  std::printf("%s\n", cuesJson.c_str());
  return 0;
}
