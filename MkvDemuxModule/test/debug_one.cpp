// One-off debug: call findClusters at a single known-good offset and dump
// the raw result, to see whether it's finding zero clusters or something
// else entirely.
#include "MkvDemuxCore.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <vector>

int main(int argc, char** argv) {
  if (argc < 3) {
    std::printf("usage: %s <file.mkv> <offset> [size]\n", argv[0]);
    return 1;
  }
  const uint64_t offset = std::strtoull(argv[2], nullptr, 10);
  const size_t size = argc > 3 ? std::strtoull(argv[3], nullptr, 10) : (2u * 1024 * 1024);

  std::ifstream f(argv[1], std::ios::binary);
  std::vector<uint8_t> whole((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  std::printf("file size %zu, probing offset %llu size %zu\n", whole.size(),
      static_cast<unsigned long long>(offset), size);

  if (offset + size > whole.size()) {
    std::printf("window exceeds file size\n");
    return 1;
  }

  std::string json = MkvDemuxCore::findClusters(whole.data() + offset, size, offset);
  std::printf("result (%zu bytes): %s\n", json.size(), json.c_str());
  return 0;
}
