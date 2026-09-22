// Replicates, offline and deterministically, the byte-offset search that
// mkvMse.ts's restartAt() uses to turn "seek to T seconds" into "start
// reading at byte N": estimate N proportionally from T/duration, probe
// there with findClusters, then refine from the Cluster timecode actually
// found. If that loop can't land within SEEK_TOLERANCE_SEC of T within
// MAX_SEEK_ESTIMATE_ITERATIONS, restartAt gives up and the seek silently
// does nothing — which is exactly the symptom being diagnosed.
//
// Usage: seek_converge <file.mkv> <fullFileSize> <durationSec> <initSegEnd> <target...>
#include "MkvDemuxCore.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

namespace {

constexpr int kMaxIterations = 6;      // MAX_SEEK_ESTIMATE_ITERATIONS
constexpr double kToleranceSec = 4.0;  // SEEK_TOLERANCE_SEC
constexpr size_t kProbeChunk = 2u * 1024 * 1024;

// Minimal extraction of the first cluster's offset/timecode from the JSON
// findClusters returns. Good enough for a diagnostic; not a JSON parser.
bool firstCluster(const std::string& json, double& offsetOut, double& timecodeOut) {
  const size_t o = json.find("\"offset\":");
  const size_t t = json.find("\"timecode\":");
  if (o == std::string::npos || t == std::string::npos) return false;
  offsetOut = std::strtod(json.c_str() + o + 9, nullptr);
  timecodeOut = std::strtod(json.c_str() + t + 11, nullptr);
  return true;
}

} // namespace

int main(int argc, char** argv) {
  if (argc < 6) {
    std::printf("usage: %s <file.mkv> <fullFileSize> <durationSec> <initSegEnd> <target...>\n", argv[0]);
    return 1;
  }
  const double fileSize = std::strtod(argv[2], nullptr);
  const double duration = std::strtod(argv[3], nullptr);
  const double initSegmentEnd = std::strtod(argv[4], nullptr);

  std::ifstream f(argv[1], std::ios::binary);
  if (!f) {
    std::printf("cannot open %s\n", argv[1]);
    return 1;
  }
  std::vector<uint8_t> have((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  std::printf("local slice: %zu bytes (of %.0f), duration %.2fs, initSegmentEnd %.0f\n\n", have.size(), fileSize,
      duration, initSegmentEnd);

  int converged = 0, ranOut = 0, unprobeable = 0;
  for (int a = 5; a < argc; a++) {
    const double target = std::strtod(argv[a], nullptr);

    // estimateByteOffset()
    const double span = fileSize - initSegmentEnd;
    const double frac = std::fmax(0.0, std::fmin(1.0, target / duration));
    double est = std::round(initSegmentEnd + frac * span);

    std::printf("target %7.2fs -> initial estimate byte %.0f\n", target, est);

    bool done = false, offSlice = false;
    for (int i = 0; i < kMaxIterations; i++) {
      const size_t clamped = static_cast<size_t>(std::fmax(initSegmentEnd, std::floor(est)));
      if (clamped + kProbeChunk > have.size()) {
        std::printf("   iter %d: byte %zu is past the local slice — cannot probe offline\n", i, clamped);
        offSlice = true;
        break;
      }
      std::string json = MkvDemuxCore::findClusters(have.data() + clamped, kProbeChunk, clamped);
      double cOffset = 0, cTimecode = 0;
      if (!firstCluster(json, cOffset, cTimecode)) {
        std::printf("   iter %d: byte %zu -> no clusters found\n", i, clamped);
        break;
      }
      const double sec = cTimecode / 1000.0; // timestampScale 1ms
      const double diff = target - sec;
      std::printf("   iter %d: byte %zu -> cluster @ %.2fs (off by %+.2fs)\n", i, clamped, sec, diff);
      if (std::fabs(diff) < kToleranceSec) {
        std::printf("   CONVERGED at %.2fs\n", sec);
        done = true;
        break;
      }
      const double bytesPerSec = (fileSize - initSegmentEnd) / duration;
      est = std::fmax(initSegmentEnd, std::fmin(fileSize - 1, est + diff * bytesPerSec));
    }
    if (done) converged++;
    else if (offSlice) unprobeable++;
    else {
      ranOut++;
      std::printf("   GAVE UP after %d iterations -> restartAt() returns null, seek does nothing\n", kMaxIterations);
    }
    std::printf("\n");
  }

  std::printf("converged %d, gave up %d, not probeable offline %d\n", converged, ranOut, unprobeable);
  return 0;
}
