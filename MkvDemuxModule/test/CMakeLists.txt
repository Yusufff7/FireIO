# Standalone HOST build for manual_probe — deliberately separate from the
# root CMakeLists.txt (which requires the Vega SDK's turbomodule/Kepler
# toolchain and only cross-compiles for the device architectures). Nothing
# exercised here — MkvDemuxCore, libebml, libmatroska — has any Kepler
# dependency, so it builds and runs directly on the dev machine with a plain
# compiler, which is what makes iterating on the parsing logic against real
# files fast: no cross-compile, no device deploy, just `cmake --build .`
# and run the binary.
cmake_minimum_required(VERSION 3.15)
project(mkv_demux_probe LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libebml ${CMAKE_CURRENT_BINARY_DIR}/libebml)
add_library(EBML::ebml ALIAS ebml)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libmatroska ${CMAKE_CURRENT_BINARY_DIR}/libmatroska)

add_executable(manual_probe
  manual_probe.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules/MkvDemuxCore.cpp
)
target_include_directories(manual_probe PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libebml/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libmatroska/include
)
target_link_libraries(manual_probe PRIVATE matroska ebml)

find_package(Threads REQUIRED)
add_executable(remux_probe
  remux_probe.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules/MkvDemuxCore.cpp
)
target_include_directories(remux_probe PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libebml/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libmatroska/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/minimp4
)
target_link_libraries(remux_probe PRIVATE matroska ebml Threads::Threads)

add_executable(seek_probe
  seek_probe.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules/MkvDemuxCore.cpp
)
target_include_directories(seek_probe PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libebml/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libmatroska/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/minimp4
)
target_link_libraries(seek_probe PRIVATE matroska ebml Threads::Threads)

add_executable(seek_converge
  seek_converge.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules/MkvDemuxCore.cpp
)
target_include_directories(seek_converge PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libebml/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libmatroska/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/minimp4
)
target_link_libraries(seek_converge PRIVATE matroska ebml Threads::Threads)

add_executable(debug_one
  debug_one.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules/MkvDemuxCore.cpp
)
target_include_directories(debug_one PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libebml/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libmatroska/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/minimp4
)
target_link_libraries(debug_one PRIVATE matroska ebml Threads::Threads)

add_executable(seek_e2e
  seek_e2e.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules/MkvDemuxCore.cpp
)
target_include_directories(seek_e2e PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libebml/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libmatroska/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/minimp4
)
target_link_libraries(seek_e2e PRIVATE matroska ebml Threads::Threads)

add_executable(subs_probe
  subs_probe.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules/MkvDemuxCore.cpp
)
target_include_directories(subs_probe PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../kepler/turbo-modules
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libebml/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/libmatroska/include
  ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/minimp4
)
target_link_libraries(subs_probe PRIVATE matroska ebml Threads::Threads)
