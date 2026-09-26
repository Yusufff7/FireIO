#include "MkvDemuxModule.h"
#include "MkvDemuxCore.h"

#include <memory>

using namespace com::amazon::kepler::turbomodule;

namespace MkvDemuxModuleTurboModule {

MkvDemuxModule::MkvDemuxModule() {}
MkvDemuxModule::~MkvDemuxModule() noexcept {}

double MkvDemuxModule::getMajorVersion() { return 0; }
double MkvDemuxModule::getMinorVersion() { return 2; }
double MkvDemuxModule::getPatchVersion() { return 0; }

// Thin wrappers — the real parsing/muxing logic lives in MkvDemuxCore,
// decoupled from the Kepler ArrayBuffer type so it can be exercised by a
// plain host-side CLI tool against real files (see test/manual_probe.cpp
// and test/remux_probe.cpp) instead of requiring a device deploy for
// every change.

std::string MkvDemuxModule::parseInitSegment(ArrayBuffer headerBytes) {
  return MkvDemuxCore::parseInitSegment(headerBytes.data(), headerBytes.size());
}

std::string MkvDemuxModule::findClusters(ArrayBuffer chunk, double baseOffset) {
  return MkvDemuxCore::findClusters(chunk.data(), chunk.size(), static_cast<uint64_t>(baseOffset));
}

double MkvDemuxModule::openRemuxSession(std::string codecId, ArrayBuffer codecPrivate, double trackNumber,
    double param1, double param2, double timestampScale, double videoDefaultDurationNs) {
  return MkvDemuxCore::openRemuxSession(codecId, codecPrivate.data(), codecPrivate.size(),
      static_cast<uint64_t>(trackNumber), static_cast<uint32_t>(param1), static_cast<uint32_t>(param2),
      static_cast<uint64_t>(timestampScale), static_cast<uint64_t>(videoDefaultDurationNs));
}

ArrayBuffer MkvDemuxModule::remuxChunk(double sessionId, ArrayBuffer chunk, double baseOffset) {
  std::vector<uint8_t> result = MkvDemuxCore::remuxChunk(
      static_cast<int>(sessionId), chunk.data(), chunk.size(), static_cast<uint64_t>(baseOffset));
  auto shared = std::make_shared<std::vector<uint8_t>>(std::move(result));
  return ArrayBuffer(shared);
}

void MkvDemuxModule::closeRemuxSession(double sessionId) {
  MkvDemuxCore::closeRemuxSession(static_cast<int>(sessionId));
}

std::string MkvDemuxModule::extractTextCues(ArrayBuffer chunk, double trackNumber, bool isAss) {
  // A negative trackNumber is a bitmask of tracks (bit N = track N), for
  // harvesting every text subtitle track in one pass — see mkvMse.ts's
  // extractEmbeddedCues. Encoded into the existing parameter rather than a
  // new method so the generated TurboModule spec doesn't change.
  if (trackNumber < 0) {
    return MkvDemuxCore::extractTextCuesForTracks(
        chunk.data(), chunk.size(), static_cast<uint64_t>(-trackNumber), isAss, true);
  }
  return MkvDemuxCore::extractTextCues(chunk.data(), chunk.size(), static_cast<uint64_t>(trackNumber), isAss);
}

} // namespace MkvDemuxModuleTurboModule
