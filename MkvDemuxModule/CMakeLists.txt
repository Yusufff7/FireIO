cmake_minimum_required(VERSION 3.15)

project(MkvDemuxModule
        VERSION 1.0
        LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Fail at compile time for unresolved symbols. This can catch cases
# where we forget to add .cpp files to the CMake target shared object
# library. If your use case requires dynamic symbol linking, remove
# these lines.
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_link_options("LINKER:--no-undefined" "LINKER:-z,defs")
endif()

if (CMAKE_SYSTEM_NAME STREQUAL Android)
  add_compile_definitions(ANDROID)
endif()

set(HEADERS
  kepler/turbo-modules/generated/MkvDemuxModuleSpec.h
  kepler/turbo-modules/MkvDemuxModule.h
  kepler/turbo-modules/MkvDemuxCore.h
)
set(SOURCES
    kepler/turbo-modules/generated/MkvDemuxModuleSpec.cpp
    kepler/turbo-modules/MkvDemuxModule.cpp
    kepler/turbo-modules/MkvDemuxCore.cpp
    kepler/AutoLinkInit.cpp
)

find_package(turbomoduleAPI CONFIG REQUIRED)

# libebml/libmatroska build as static libs by default (see their own
# CMakeLists) — exactly what we want linked into one shared turbo-module .so,
# rather than shipping extra loose .so files the manifest would need to
# declare. Their own test/tooling targets are switched off; we only need the
# library code.
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
add_subdirectory(third_party/libebml)
# libmatroska's own CMakeLists resolves libebml via find_package(EBML), which
# only succeeds against an INSTALLED libebml (the EBML::ebml namespace comes
# from its install(EXPORT ...) step) — not from a same-tree add_subdirectory.
# Since we're building both in-tree rather than installing libebml first,
# the alias is created here so the target already exists by the time
# libmatroska's (patched, see third_party/libmatroska/CMakeLists.txt) guarded
# find_package call is reached.
add_library(EBML::ebml ALIAS ebml)
add_subdirectory(third_party/libmatroska)

kepler_add_turbo_module_library(MkvDemuxModule SHARED ${HEADERS} ${SOURCES})

target_include_directories(MkvDemuxModule PRIVATE
    third_party/libebml/include
    third_party/libmatroska/include
)

if (CMAKE_SYSTEM_NAME STREQUAL Android)
    list(APPEND LIBRARIES
        android log)
endif()
list(APPEND LIBRARIES matroska ebml)
target_link_libraries(MkvDemuxModule PRIVATE ${LIBRARIES})

install(TARGETS MkvDemuxModule)
