cmake_minimum_required(VERSION 3.20)
project(fsusblog_aeds_decoder LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(aeds_decoder
  src/aeds_crc32.cpp
  src/pod_parse_article.cpp
  src/aeds_decode.cpp
  src/exports.cpp
)

target_include_directories(aeds_decoder PRIVATE include)

if(EMSCRIPTEN)
  target_compile_options(aeds_decoder PRIVATE
    -Oz
    -fno-exceptions
    -fno-rtti
    -fvisibility=hidden
  )

  set_target_properties(aeds_decoder PROPERTIES SUFFIX ".js")

  target_link_options(aeds_decoder PRIVATE
    --no-entry
    -sWASM=1
    -sALLOW_MEMORY_GROWTH=1
    -sEXPORTED_FUNCTIONS=["_decode_aeds","_get_last_payload_ptr","_get_last_payload_len","_get_last_frame_type","_get_last_error_ptr","_get_last_error_len","_alloc_buffer","_free_buffer"]
    -sEXPORTED_RUNTIME_METHODS=["cwrap","getValue","UTF8ToString"]
  )
endif()
