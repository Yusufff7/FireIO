// End-to-end offline simulation of mkvMse.ts's restartAt(): given a target
// seek time, converge on a landing byte offset the same way restartAt does
// (estimate -> probe with findClusters -> refine), then open FRESH remux
// sessions there — mirroring closeSessions()+openSessions() — and feed
// remuxChunk from that landing point, writing real .mp4 files so the result
// can be validated with ffprobe/ffmpeg instead of just trusting the numbers.
//
// This exercises the actual code path a device seek takes (parseInitSegment,
// openRemuxSession, findClusters, remuxChunk, closeRemuxSession) end to end,
// entirely offline, against a real downloaded file.
//
// Usage: seek_e2e <file.mkv> <fullFileSize> <durationSec> <output.mp4> <target...>
#include "MkvDemuxCore.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

constexpr int kMaxIterations = 6;
constexpr double kToleranceSec = 4.0;
constexpr size_t kProbeChunk = 2u * 1024 * 1024;
constexpr size_t kRemuxChunkSize = 4u * 1024 * 1024;
constexpr size_t kTargetOutputBytes = 6u * 1024 * 1024; // ~a few seconds worth

std::string jsonString(const std::string& json, const char* key) {
  const std::string needle = std::string("\"") + key + "\":\"";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return "";
  pos += needle.size();
  const auto end = json.find('"', pos);
  return json.substr(pos, end - pos);
}

long jsonNumber(const std::string& json, const char* key) {
  const std::string needle = std::string("\"") + key + "\":";
  auto pos = json.find(needle);
  if (pos == std::string::npos) return -1;
  pos += needle.size();
  return std::atol(json.c_str() + pos);
}

std::vector<uint8_t> base64Decode(const std::string& in) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  std::vector<uint8_t> out;
  int buf = 0, bits = 0;
  for (char c : in) {
    if (c == '=') break;
    const int v = val(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>((buf >> bits) & 0xff));
    }
  }
  return out;
}

bool firstCluster(const std::string& json, uint64_t& offsetOut, double& timecodeOut) {
  const size_t o = json.find("\"offset\":");
  const size_t t = json.find("\"timecode\":");
  if (o == std::string::npos || t == std::string::npos) return false;
  offsetOut = std::strtoull(json.c_str() + o + 9, nullptr, 10);
  timecodeOut = std::strtod(json.c_str() + t + 11, nullptr) / 1000.0;
  return true;
}

// Mirrors restartAt()'s estimate+refine loop. Returns landing byte offset
// and seconds, or false if it can't converge within the local slice.
bool convergeLanding(const std::vector<uint8_t>& have, uint64_t fileSize, double duration, uint64_t initSegmentEnd,
    double target, uint64_t& landingOffset, double& landingSec) {
  const double span = static_cast<double>(fileSize - initSegmentEnd);
  const double frac = std::fmax(0.0, std::fmin(1.0, target / duration));
  double est = std::round(static_cast<double>(initSegmentEnd) + frac * span);

  for (int i = 0; i < kMaxIterations; i++) {
    const uint64_t clamped =
        static_cast<uint64_t>(std::fmax(static_cast<double>(initSegmentEnd), std::floor(est)));
    if (clamped + kProbeChunk > have.size()) return false;
    std::string json = MkvDemuxCore::findClusters(have.data() + clamped, kProbeChunk, clamped);
    uint64_t cOffset = 0;
    double cSec = 0;
    if (!firstCluster(json, cOffset, cSec)) return false;
    const double diff = target - cSec;
    if (std::fabs(diff) < kToleranceSec) {
      landingOffset = cOffset;
      landingSec = cSec;
      return true;
    }
    const double bytesPerSec = span / duration;
    est = std::fmax(static_cast<double>(initSegmentEnd),
        std::fmin(static_cast<double>(fileSize) - 1, est + diff * bytesPerSec));
  }
  return false;
}

} // namespace

int main(int argc, char** argv) {
  if (argc < 6) {
    std::printf("usage: %s <file.mkv> <fullFileSize> <durationSec> <output.mp4> <target...>\n", argv[0]);
    return 1;
  }
  const uint64_t fullFileSize = std::strtoull(argv[2], nullptr, 10);
  const double duration = std::strtod(argv[3], nullptr);
  const std::string outPrefix = argv[4];

  std::ifstream f(argv[1], std::ios::binary);
  if (!f) {
    std::printf("cannot open %s\n", argv[1]);
    return 1;
  }
  std::vector<uint8_t> have((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  std::printf("local slice: %zu bytes (of %llu), duration %.2fs\n\n", have.size(),
      static_cast<unsigned long long>(fullFileSize), duration);

  const std::string initJson = MkvDemuxCore::parseInitSegment(have.data(), have.size());
  const long initEnd = jsonNumber(initJson, "initSegmentEnd");
  if (initEnd < 0) {
    std::printf("parseInitSegment failed: %s\n", initJson.c_str());
    return 1;
  }
  const std::string videoCodecId = jsonString(initJson, "videoCodecId");
  const long videoTrackNumber = jsonNumber(initJson, "videoTrackNumber");
  const long videoWidth = jsonNumber(initJson, "videoWidth");
  const long videoHeight = jsonNumber(initJson, "videoHeight");
  const long timestampScale = jsonNumber(initJson, "timestampScale");
  const std::vector<uint8_t> videoCodecPrivate = base64Decode(jsonString(initJson, "videoCodecPrivateB64"));
  const long videoDefaultDurationNs = jsonNumber(initJson, "videoDefaultDurationNs");
  const std::string audioCodecId = jsonString(initJson, "audioCodecId");
  const long audioTrackNumber = jsonNumber(initJson, "audioTrackNumber");
  const long audioSampleRate = jsonNumber(initJson, "audioSampleRate");
  const long audioChannels = jsonNumber(initJson, "audioChannels");
  const std::vector<uint8_t> audioCodecPrivate = base64Decode(jsonString(initJson, "audioCodecPrivateB64"));

  std::printf("video: %s track=%ld %ldx%ld, audio: %s track=%ld\n\n", videoCodecId.c_str(), videoTrackNumber,
      videoWidth, videoHeight, audioCodecId.c_str(), audioTrackNumber);

  const bool hasAac = audioCodecId == "A_AAC" || audioCodecId.rfind("A_AAC/", 0) == 0;

  int caseNum = 0;
  for (int a = 5; a < argc; a++) {
    caseNum++;
    const double target = std::strtod(argv[a], nullptr);
    std::printf("=== target %.2fs ===\n", target);

    uint64_t landingOffset = 0;
    double landingSec = 0;
    if (!convergeLanding(have, fullFileSize, duration, static_cast<uint64_t>(initEnd), target, landingOffset,
            landingSec)) {
      std::printf("  restartAt() would return null (no convergence / past local slice) — skipping\n\n");
      continue;
    }
    std::printf("  landed at byte %llu (%.2fs, requested %.2fs)\n", static_cast<unsigned long long>(landingOffset),
        landingSec, target);

    // Mirrors openSessions(): fresh sessions, waitingForKeyframe=true is set
    // internally by openRemuxSession for video.
    const int videoSession = MkvDemuxCore::openRemuxSession(videoCodecId, videoCodecPrivate.data(),
        videoCodecPrivate.size(), static_cast<uint64_t>(videoTrackNumber), static_cast<uint32_t>(videoWidth),
        static_cast<uint32_t>(videoHeight), static_cast<uint64_t>(timestampScale),
        static_cast<uint64_t>(videoDefaultDurationNs));
    int audioSession = -1;
    if (hasAac) {
      audioSession = MkvDemuxCore::openRemuxSession(audioCodecId, audioCodecPrivate.data(), audioCodecPrivate.size(),
          static_cast<uint64_t>(audioTrackNumber), static_cast<uint32_t>(audioSampleRate),
          static_cast<uint32_t>(audioChannels), static_cast<uint64_t>(timestampScale), 0);
    }
    if (videoSession < 0) {
      std::printf("  openRemuxSession(video) failed\n\n");
      continue;
    }

    std::vector<uint8_t> videoOut, audioOut;
    uint64_t offset = landingOffset;
    int chunks = 0;
    while (offset < have.size() && videoOut.size() < kTargetOutputBytes && chunks < 50) {
      const size_t thisChunk = std::min<size_t>(kRemuxChunkSize, have.size() - offset);
      auto vres = MkvDemuxCore::remuxChunk(videoSession, have.data() + offset, thisChunk, offset);
      uint64_t vConsumed = 0;
      std::memcpy(&vConsumed, vres.data(), 8);
      videoOut.insert(videoOut.end(), vres.begin() + 8, vres.end());

      uint64_t aConsumed = vConsumed;
      if (audioSession >= 0) {
        auto ares = MkvDemuxCore::remuxChunk(audioSession, have.data() + offset, thisChunk, offset);
        std::memcpy(&aConsumed, ares.data(), 8);
        audioOut.insert(audioOut.end(), ares.begin() + 8, ares.end());
      }
      const uint64_t consumed = std::min(vConsumed, aConsumed);
      chunks++;
      if (consumed == 0) {
        std::printf("  no progress at offset %llu after %d chunks — stopping\n",
            static_cast<unsigned long long>(offset), chunks);
        break;
      }
      offset += consumed;
    }

    MkvDemuxCore::closeRemuxSession(videoSession);
    if (audioSession >= 0) MkvDemuxCore::closeRemuxSession(audioSession);

    std::printf("  processed %d chunks, video fMP4 bytes=%zu, audio fMP4 bytes=%zu\n", chunks, videoOut.size(),
        audioOut.size());

    const std::string videoPath = outPrefix + "." + std::to_string(caseNum) + ".video.mp4";
    FILE* outVideo = std::fopen(videoPath.c_str(), "wb");
    std::fwrite(videoOut.data(), 1, videoOut.size(), outVideo);
    std::fclose(outVideo);
    std::printf("  wrote %s\n", videoPath.c_str());

    if (!audioOut.empty()) {
      const std::string audioPath = outPrefix + "." + std::to_string(caseNum) + ".audio.mp4";
      FILE* outAudio = std::fopen(audioPath.c_str(), "wb");
      std::fwrite(audioOut.data(), 1, audioOut.size(), outAudio);
      std::fclose(outAudio);
      std::printf("  wrote %s\n", audioPath.c_str());
    }
    std::printf("\n");
  }

  return 0;
}
