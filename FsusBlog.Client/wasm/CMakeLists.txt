cmake_minimum_required(VERSION 3.20)
project(FsusBlogWasm LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "FsusBlog.Client/wasm must be built with emcmake/emcc.")
endif()

if(NOT DEFINED FSUSBLOG_WASM_OUTPUT_DIR)
  set(FSUSBLOG_WASM_OUTPUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../public/wasm")
endif()
file(MAKE_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}")

add_subdirectory(pow)
add_subdirectory(aeds)

option(FSUSBLOG_WASM_MARKDOWN_ENABLE "Build the markdown wasm module" ON)
if(FSUSBLOG_WASM_MARKDOWN_ENABLE)
  add_subdirectory(
    "${CMAKE_CURRENT_SOURCE_DIR}/markdown"
    "${CMAKE_CURRENT_BINARY_DIR}/markdown"
  )
endif()
