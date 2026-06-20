cmake_minimum_required(VERSION 3.20)
project(FsusBlogWasm LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 核心兼容性补丁: 防止 Emscripten 3.1.6+ 与 Clang 15 混用时产生 max_align_t 重定义错误
add_compile_definitions(__DEFINED_max_align_t)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "FsusBlog.Client/wasm must be built with emcmake/emcc.")
endif()

if(NOT DEFINED FSUSBLOG_WASM_OUTPUT_DIR)
  set(FSUSBLOG_WASM_OUTPUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../public/wasm")
endif()
file(MAKE_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}")

add_subdirectory(pow)
add_subdirectory(aeds)
add_subdirectory(search)
add_subdirectory(comment_privacy)

option(FSUSBLOG_WASM_IMAGE_CODEC_ENABLE "Build the image codec wasm module" ON)
if(FSUSBLOG_WASM_IMAGE_CODEC_ENABLE)
  add_subdirectory(
    "${CMAKE_CURRENT_SOURCE_DIR}/image_codec"
    "${CMAKE_CURRENT_BINARY_DIR}/image_codec"
  )
endif()
