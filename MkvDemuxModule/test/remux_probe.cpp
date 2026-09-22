// Host-side test tool for the MKV->fMP4 remux path (openRemuxSession /
// remuxChunk / closeRemuxSession). Mirrors the real intended usage: parse
// the init segment, pull out the video (and, if AAC, audio) track config
// exactly as the JS caller will (JSON field extraction + base64 decode,
// not by reaching into MkvDemuxCore's internals), then feed the file
// through in fixed-size chunks the same way the real progressive-fetch
// loop will, writing whatever comes out to a real .mp4 file for
// independent validation with ffprobe.
//
// Usage: remux_probe <file.mkv> <output.mp4> [chunkSizeBytes]

#include "MkvDemuxCore.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

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

} // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: %s <file.mkv> <output.mp4> [chunkSizeBytes]\n", argv[0]);
    return 1;
  }
  const size_t chunkSize = argc > 3 ? static_cast<size_t>(std::atol(argv[3])) : (4 * 1024 * 1024);

  FILE* f = std::fopen(argv[1], "rb");
  if (!f) {
    std::fprintf(stderr, "could not open %s\n", argv[1]);
    return 1;
  }
  std::fseek(f, 0, SEEK_END);
  const long fileSize = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  std::vector<uint8_t> whole(static_cast<size_t>(fileSize));
  if (std::fread(whole.data(), 1, whole.size(), f) != whole.size()) {
    std::fprintf(stderr, "short read\n");
    std::fclose(f);
    return 1;
  }
  std::fclose(f);
  std::printf("file size: %ld bytes\n", fileSize);

  const std::string initJson = MkvDemuxCore::parseInitSegment(whole.data(), whole.size());
  std::printf("parseInitSegment: %.*s...\n", 200, initJson.c_str());

  const long initEnd = jsonNumber(initJson, "initSegmentEnd");
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

  std::printf("video: codecId=%s trackNumber=%ld %ldx%ld codecPrivateBytes=%zu\n", videoCodecId.c_str(),
      videoTrackNumber, videoWidth, videoHeight, videoCodecPrivate.size());
  std::printf("audio: codecId=%s trackNumber=%ld sampleRate=%ld channels=%ld codecPrivateBytes=%zu\n",
      audioCodecId.c_str(), audioTrackNumber, audioSampleRate, audioChannels, audioCodecPrivate.size());

  if (initEnd < 0) {
    std::fprintf(stderr, "no initSegmentEnd — stopping\n");
    return 1;
  }

  const int videoSession = MkvDemuxCore::openRemuxSession(videoCodecId, videoCodecPrivate.data(),
      videoCodecPrivate.size(), static_cast<uint64_t>(videoTrackNumber), static_cast<uint32_t>(videoWidth),
      static_cast<uint32_t>(videoHeight), static_cast<uint64_t>(timestampScale),
      static_cast<uint64_t>(videoDefaultDurationNs));
  std::printf("video remux session: %d\n", videoSession);
  if (videoSession < 0) {
    std::fprintf(stderr, "video track not remuxable (codec unsupported or bad CodecPrivate)\n");
    return 1;
  }

  int audioSession = -1;
  const bool audioMaybeRemuxable = audioCodecId == "A_AAC" || audioCodecId.rfind("A_AAC/", 0) == 0 ||
      audioCodecId.rfind("A_AC3", 0) == 0 || audioCodecId == "A_EAC3" || audioCodecId == "A_FLAC" || audioCodecId == "A_OPUS";
  if (audioMaybeRemuxable) {
    audioSession = MkvDemuxCore::openRemuxSession(audioCodecId, audioCodecPrivate.data(), audioCodecPrivate.size(),
        static_cast<uint64_t>(audioTrackNumber), static_cast<uint32_t>(audioSampleRate),
        static_cast<uint32_t>(audioChannels), static_cast<uint64_t>(timestampScale), /*videoDefaultDurationNs=*/0);
    std::printf("audio remux session: %d\n", audioSession);
  } else {
    std::printf("audio codec '%s' not remuxed in this pass — output will be video-only\n", audioCodecId.c_str());
  }

  std::vector<uint8_t> videoOut, audioOut;
  size_t offset = static_cast<size_t>(initEnd);
  int chunkCount = 0;
  while (offset < whole.size()) {
    const size_t thisChunk = std::min(chunkSize, whole.size() - offset);
    auto vres = MkvDemuxCore::remuxChunk(videoSession, whole.data() + offset, thisChunk, offset);
    uint64_t vConsumed = 0;
    std::memcpy(&vConsumed, vres.data(), 8);
    videoOut.insert(videoOut.end(), vres.begin() + 8, vres.end());

    uint64_t aConsumed = vConsumed; // default: advance by video's progress if no audio session
    if (audioSession >= 0) {
      auto ares = MkvDemuxCore::remuxChunk(audioSession, whole.data() + offset, thisChunk, offset);
      std::memcpy(&aConsumed, ares.data(), 8);
      audioOut.insert(audioOut.end(), ares.begin() + 8, ares.end());
    }

    const uint64_t consumed = std::min(vConsumed, aConsumed);
    chunkCount++;
    if (consumed == 0) {
      std::printf("no progress at offset %zu after %d chunks (vConsumed=%llu aConsumed=%llu) — stopping\n", offset,
          chunkCount, static_cast<unsigned long long>(vConsumed), static_cast<unsigned long long>(aConsumed));
      break;
    }
    offset += consumed;
  }
  std::printf("processed %d chunks, stopped at file offset %zu / %ld\n", chunkCount, offset, fileSize);

  MkvDemuxCore::closeRemuxSession(videoSession);
  if (audioSession >= 0) MkvDemuxCore::closeRemuxSession(audioSession);

  std::printf("video fMP4 bytes: %zu, audio fMP4 bytes: %zu\n", videoOut.size(), audioOut.size());

  FILE* outVideo = std::fopen((std::string(argv[2]) + ".video.mp4").c_str(), "wb");
  std::fwrite(videoOut.data(), 1, videoOut.size(), outVideo);
  std::fclose(outVideo);
  std::printf("wrote %s.video.mp4\n", argv[2]);

  if (!audioOut.empty()) {
    FILE* outAudio = std::fopen((std::string(argv[2]) + ".audio.mp4").c_str(), "wb");
    std::fwrite(audioOut.data(), 1, audioOut.size(), outAudio);
    std::fclose(outAudio);
    std::printf("wrote %s.audio.mp4\n", argv[2]);
  }

  return 0;
}
