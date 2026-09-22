// Exercises findClusters the way seeking does: from arbitrary byte offsets
// that land in the middle of frame payloads rather than on element
// boundaries. That is where Matroska's 4-byte Cluster ID can match by
// chance, which used to send the scan into an endless loop on a
// zero-length "Cluster" (the read position was set to the match's own end,
// i.e. back to where it already was) until the process ran out of memory.
//
// Usage: seek_probe <file.mkv> [numOffsets]
#include "MkvDemuxCore.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

int main(int argc, char** argv) {
  if (argc < 2) {
    std::printf("usage: %s <file.mkv> [numOffsets]\n", argv[0]);
    return 1;
  }
  const int numOffsets = argc > 2 ? std::atoi(argv[2]) : 200;

  std::ifstream f(argv[1], std::ios::binary);
  if (!f) {
    std::printf("cannot open %s\n", argv[1]);
    return 1;
  }
  std::vector<uint8_t> whole((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  std::printf("file size: %zu bytes, probing %d offsets\n", whole.size(), numOffsets);

  // 2MB is what mkvMse.ts's probeAt fetches per seek probe.
  const size_t probeSize = 2u * 1024 * 1024;
  if (whole.size() <= probeSize) {
    std::printf("file too small to probe\n");
    return 1;
  }

  int emptyResults = 0;
  size_t worstBytes = 0;
  for (int i = 0; i < numOffsets; i++) {
    // Deliberately arbitrary: spread across the file with a prime-ish stride
    // so offsets land inside frame data, not on Cluster boundaries.
    const size_t span = whole.size() - probeSize;
    const size_t offset = (static_cast<size_t>(i) * 7919u * 1024u) % span;

    const auto start = std::chrono::steady_clock::now();
    std::string json = MkvDemuxCore::findClusters(whole.data() + offset, probeSize, offset);
    const auto elapsedMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();

    if (json.size() > worstBytes) worstBytes = json.size();
    if (json.find("\"clusters\":[]") != std::string::npos) emptyResults++;

    // A runaway would show up as either a wildly long runtime or a JSON
    // blob far larger than the window it describes.
    if (elapsedMs > 5000 || json.size() > probeSize) {
      std::printf("RUNAWAY at offset %zu: %lldms, json %zu bytes\n", offset,
          static_cast<long long>(elapsedMs), json.size());
      return 2;
    }
  }

  std::printf("OK: %d offsets probed, %d found no clusters, largest json %zu bytes\n", numOffsets, emptyResults,
      worstBytes);
  return 0;
}
