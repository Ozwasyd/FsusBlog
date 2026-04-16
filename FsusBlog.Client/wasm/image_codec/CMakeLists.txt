cmake_minimum_required(VERSION 3.20)
project(FsusImageCodec LANGUAGES CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "FsusBlog wasm image codec must be built with Emscripten")
endif()

add_executable(FsusImageCodec
  src/image_codec_exports.cpp
)

target_compile_features(FsusImageCodec PRIVATE cxx_std_23)
target_compile_options(FsusImageCodec PRIVATE
  -O3
  -fno-exceptions
  -fno-rtti
  -fvisibility=hidden
)

option(FSUSBLOG_IMAGE_CODEC_ENABLE_JPEG "Enable JPEG encode support in wasm codec" ON)
if(FSUSBLOG_IMAGE_CODEC_ENABLE_JPEG)
  target_compile_definitions(FsusImageCodec PRIVATE FSUSBLOG_IMAGE_CODEC_ENABLE_JPEG=1)
  find_path(
    FSUSBLOG_JPEG_INCLUDE_DIR
    NAMES jpeglib.h
    HINTS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES include
    NO_CMAKE_FIND_ROOT_PATH
  )
  find_library(
    FSUSBLOG_JPEG_LIBRARY
    NAMES jpeg libjpeg jpeg_a
    HINTS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES lib
    NO_CMAKE_FIND_ROOT_PATH
  )
  if(FSUSBLOG_JPEG_INCLUDE_DIR AND FSUSBLOG_JPEG_LIBRARY)
    message(STATUS "Image codec JPEG enabled via ${FSUSBLOG_JPEG_LIBRARY}")
    target_include_directories(FsusImageCodec PRIVATE "${FSUSBLOG_JPEG_INCLUDE_DIR}")
    target_link_libraries(FsusImageCodec PRIVATE "${FSUSBLOG_JPEG_LIBRARY}")
  else()
    message(STATUS "Image codec JPEG enabled via emscripten USE_LIBJPEG")
    target_compile_options(FsusImageCodec PRIVATE -sUSE_LIBJPEG=1)
    target_link_options(FsusImageCodec PRIVATE -sUSE_LIBJPEG=1)
  endif()
endif()

option(FSUSBLOG_IMAGE_CODEC_ENABLE_WEBP "Enable WebP encode support in wasm codec when libwebp is available" ON)
if(FSUSBLOG_IMAGE_CODEC_ENABLE_WEBP)
  find_path(
    FSUSBLOG_WEBP_INCLUDE_DIR
    NAMES webp/encode.h
    HINTS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES include
    NO_CMAKE_FIND_ROOT_PATH
  )
  find_library(
    FSUSBLOG_WEBP_LIBRARY
    NAMES webp libwebp webp_a
    HINTS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES lib
    NO_CMAKE_FIND_ROOT_PATH
  )
  find_library(
    FSUSBLOG_SHARPYUV_LIBRARY
    NAMES sharpyuv libsharpyuv sharpyuv_a
    HINTS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES lib
    NO_CMAKE_FIND_ROOT_PATH
  )
  if(FSUSBLOG_WEBP_INCLUDE_DIR AND FSUSBLOG_WEBP_LIBRARY AND FSUSBLOG_SHARPYUV_LIBRARY)
    message(STATUS "Image codec WebP enabled via ${FSUSBLOG_WEBP_LIBRARY}")
    target_compile_definitions(FsusImageCodec PRIVATE FSUSBLOG_IMAGE_CODEC_ENABLE_WEBP=1)
    target_include_directories(FsusImageCodec PRIVATE "${FSUSBLOG_WEBP_INCLUDE_DIR}")
    target_link_libraries(FsusImageCodec PRIVATE "${FSUSBLOG_WEBP_LIBRARY}")
    target_link_libraries(FsusImageCodec PRIVATE "${FSUSBLOG_SHARPYUV_LIBRARY}")
  else()
    message(STATUS "Image codec WebP unavailable (missing libwebp), keeping fallback")
  endif()
endif()

option(FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF "Enable AVIF encode support in wasm codec when libavif is available" ON)
if(FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF)
  find_path(
    FSUSBLOG_AVIF_INCLUDE_DIR
    NAMES avif/avif.h
    HINTS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES include
    NO_CMAKE_FIND_ROOT_PATH
  )
  find_library(
    FSUSBLOG_AVIF_LIBRARY
    NAMES avif libavif avif_a
    HINTS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES lib
    NO_CMAKE_FIND_ROOT_PATH
  )
  find_library(
    FSUSBLOG_LIBYUV_LIBRARY
    NAMES yuv libyuv yuv_a
    HINTS ${CMAKE_PREFIX_PATH}
    PATH_SUFFIXES lib
    NO_CMAKE_FIND_ROOT_PATH
  )
  if(FSUSBLOG_AVIF_INCLUDE_DIR AND FSUSBLOG_AVIF_LIBRARY AND FSUSBLOG_LIBYUV_LIBRARY)
    message(STATUS "Image codec AVIF enabled via ${FSUSBLOG_AVIF_LIBRARY}")
    target_compile_definitions(FsusImageCodec PRIVATE FSUSBLOG_IMAGE_CODEC_ENABLE_AVIF=1)
    target_include_directories(FsusImageCodec PRIVATE "${FSUSBLOG_AVIF_INCLUDE_DIR}")
    target_link_libraries(FsusImageCodec PRIVATE "${FSUSBLOG_AVIF_LIBRARY}")
    target_link_libraries(FsusImageCodec PRIVATE "${FSUSBLOG_LIBYUV_LIBRARY}")
  else()
    message(STATUS "Image codec AVIF unavailable (missing libavif), keeping fallback")
  endif()
endif()

set_target_properties(FsusImageCodec PROPERTIES
  OUTPUT_NAME "image_codec_basic"
  RUNTIME_OUTPUT_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}"
  SUFFIX ".js"
)

option(WASM_SIMD "Enable WebAssembly SIMD128 instructions" OFF)
if(WASM_SIMD)
  message(STATUS "Image codec wasm SIMD128 enabled")
  target_compile_options(FsusImageCodec PRIVATE -msimd128)
  target_link_options(FsusImageCodec PRIVATE -msimd128)
  set_target_properties(FsusImageCodec PROPERTIES OUTPUT_NAME "image_codec_simd")
else()
  message(STATUS "Image codec wasm scalar fallback enabled")
endif()

target_link_options(FsusImageCodec PRIVATE
  --no-entry
  -sWASM=1
  -sALLOW_MEMORY_GROWTH=1
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createImageCodecModule
  -sENVIRONMENT=web,worker,node
  -sEXPORTED_FUNCTIONS=["_image_codec_alloc_buffer","_image_codec_free_buffer","_image_codec_encode","_image_codec_get_last_output_ptr","_image_codec_get_last_output_len","_image_codec_get_last_error_ptr","_image_codec_get_last_error_len","_image_codec_get_last_error_code","_image_codec_get_level_ptr","_image_codec_get_level_len","_image_codec_get_version_ptr","_image_codec_get_version_len","_image_codec_get_supported_formats_bitmap","_image_codec_get_supported_formats_json_ptr","_image_codec_get_supported_formats_json_len"]
  -sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAPU8"]
)
