cmake_minimum_required(VERSION 3.20)
project(FsusMarkdownRenderer LANGUAGES CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "FsusBlog wasm markdown must be built with Emscripten")
endif()

add_executable(FsusMarkdownRenderer
  src/markdown_contract.cpp
  src/markdown_exports.cpp
  src/markdown_latex.cpp
  src/markdown_mermaid.cpp
)

target_include_directories(FsusMarkdownRenderer
  SYSTEM PRIVATE
    ${EMSCRIPTEN_SYSROOT}/include
    include
)

target_compile_features(FsusMarkdownRenderer PRIVATE cxx_std_23)
target_compile_options(FsusMarkdownRenderer PRIVATE
  -O3
  -fno-exceptions
  -fno-rtti
  -fvisibility=hidden
)

set_target_properties(FsusMarkdownRenderer PROPERTIES
  OUTPUT_NAME "markdown_basic"
  RUNTIME_OUTPUT_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}"
  SUFFIX ".js"
)

option(WASM_SIMD "Enable WebAssembly SIMD128 instructions" OFF)

if(WASM_SIMD)
  message(STATUS "Markdown wasm SIMD128 enabled")
  target_compile_options(FsusMarkdownRenderer PRIVATE -msimd128)
  target_link_options(FsusMarkdownRenderer PRIVATE -msimd128)
  set_target_properties(FsusMarkdownRenderer PROPERTIES OUTPUT_NAME "markdown_simd")
else()
  message(STATUS "Markdown wasm scalar fallback enabled")
endif()

target_link_options(FsusMarkdownRenderer PRIVATE
  --no-entry
  -sWASM=1
  -sALLOW_MEMORY_GROWTH=1
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createMarkdownModule
  -sENVIRONMENT=web,worker,node
  -sEXPORTED_FUNCTIONS=["_alloc_buffer","_free_buffer","_render_markdown","_get_last_html_ptr","_get_last_html_len","_get_last_error_ptr","_get_last_error_len","_get_last_features_ptr","_get_last_features_len","_get_last_placeholders_ptr","_get_last_placeholders_len","_get_last_renderer_version_ptr","_get_last_renderer_version_len","_get_last_metadata_ptr","_get_last_metadata_len","_markdown_alloc_buffer","_markdown_free_buffer","_markdown_render","_markdown_get_last_html_ptr","_markdown_get_last_html_len","_markdown_get_last_error_ptr","_markdown_get_last_error_len","_markdown_get_last_features_ptr","_markdown_get_last_features_len","_markdown_get_last_placeholders_ptr","_markdown_get_last_placeholders_len","_markdown_get_last_renderer_version_ptr","_markdown_get_last_renderer_version_len","_markdown_get_last_metadata_ptr","_markdown_get_last_metadata_len"]
  -sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAPU8"]
)
