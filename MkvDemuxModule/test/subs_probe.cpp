// Host-side test tool for extractTextCues. Parses the init segment to find
// subtitle tracks, then extracts cues from the whole file for the given
// track (or the first one found).
//
// Usage: subs_probe <file.mkv> [trackNumber]
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
