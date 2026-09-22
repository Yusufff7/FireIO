// Standalone host-side test tool for MkvDemuxCore — validates the parsing
// logic against a real local MKV file without needing a device deploy.
// Usage: manual_probe <file.mkv>
//
// Loads the whole file into memory and scans it in one pass. That's not how
// the real app will fetch data (progressive HTTP ranges, not a full local
// read) — this tool exists purely to validate MkvDemuxCore's EBML-walking
// logic against real bytes, not to model production chunking/resume
// behaviour, so the simplest thing that removes chunk-boundary edge cases
// from the picture is the right choice here.

#include "MkvDemuxCore.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: %s <file.mkv>\n", argv[0]);
    return 1;
  }

  FILE* f = std::fopen(argv[1], "rb");
  if (!f) {
    std::fprintf(stderr, "could not open %s\n", argv[1]);
    return 1;
  }
  std::fseek(f, 0, SEEK_END);
  const long fileSize = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  std::printf("file size: %ld bytes\n", fileSize);

  std::vector<uint8_t> whole(static_cast<size_t>(fileSize));
  if (std::fread(whole.data(), 1, whole.size(), f) != whole.size()) {
    std::fprintf(stderr, "short read\n");
    std::fclose(f);
    return 1;
  }
  std::fclose(f);

  // Header parse: real usage would only fetch the first couple hundred KB
  // for this, but reusing the same in-memory buffer here is harmless — the
  // function stops at the first Cluster regardless of how much more data
  // trails it.
  std::string initResult = MkvDemuxCore::parseInitSegment(whole.data(), whole.size());
  std::printf("parseInitSegment: %s\n", initResult.c_str());

  auto extractNumber = [](const std::string& json, const char* key) -> long {
    auto pos = json.find(key);
    if (pos == std::string::npos) return -1;
    pos = json.find(':', pos) + 1;
    return std::atol(json.c_str() + pos);
  };
  const long initEnd = extractNumber(initResult, "\"initSegmentEnd\"");
  if (initEnd < 0) {
    std::fprintf(stderr, "parseInitSegment did not report an initSegmentEnd — stopping\n");
    return 1;
  }

  std::string clustersResult =
      MkvDemuxCore::findClusters(whole.data() + initEnd, whole.size() - static_cast<size_t>(initEnd), static_cast<uint64_t>(initEnd));

  long totalClusters = 0;
  long lastTimecode = -1;
  bool monotonic = true;
  size_t pos = 0;
  while ((pos = clustersResult.find("\"timecode\":", pos)) != std::string::npos) {
    pos += 11;
    const long tc = std::atol(clustersResult.c_str() + pos);
    if (lastTimecode >= 0 && tc < lastTimecode) monotonic = false;
    lastTimecode = tc;
    totalClusters++;
  }

  // Print just the first and last couple of cluster entries rather than the
  // whole (potentially huge) array.
  std::printf("\nfindClusters found %ld clusters.\n", totalClusters);
  if (totalClusters > 0) {
    size_t head = clustersResult.find('[') + 1;
    size_t headEnd = clustersResult.find('}', head) + 1;
    std::printf("first: %s\n", clustersResult.substr(head, headEnd - head).c_str());
    size_t tail = clustersResult.rfind("{\"offset\"");
    size_t tailEnd = clustersResult.find('}', tail) + 1;
    std::printf("last:  %s\n", clustersResult.substr(tail, tailEnd - tail).c_str());
  }

  std::printf(
      "\nTimecodes monotonically increasing: %s\n"
      "Last timecode seen: %ld (ticks)\n",
      monotonic ? "yes" : "NO — BUG", lastTimecode);

  return 0;
}
