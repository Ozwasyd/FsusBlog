cmake_minimum_required(VERSION 3.20)
project(fsusblog_aeds_decoder LANGUAGES CXX)

add_executable(aeds_decoder
  src/aeds_crc32.cpp
  src/pod_parse_article.cpp
  src/aeds_decode.cpp
  src/exports.cpp
)

target_include_directories(aeds_decoder PRIVATE include)

target_compile_options(aeds_decoder PRIVATE
  -Oz
  -fno-exceptions
  -fno-rtti
  -fvisibility=hidden
)

set_target_properties(aeds_decoder PROPERTIES
  OUTPUT_NAME "aeds_decoder"
  RUNTIME_OUTPUT_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}"
  SUFFIX ".js"
)

target_link_options(aeds_decoder PRIVATE
  --no-entry
  -sWASM=1
  -sALLOW_MEMORY_GROWTH=1
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createAedsModule
  -sENVIRONMENT=web,worker
  -sEXPORTED_FUNCTIONS=["_decode_aeds","_get_last_payload_ptr","_get_last_payload_len","_get_last_frame_type","_get_last_error_ptr","_get_last_error_len","_alloc_buffer","_free_buffer","_render_view","_get_last_html_ptr","_get_last_html_len","_handle_event"]
  -sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAPU8"]
)
