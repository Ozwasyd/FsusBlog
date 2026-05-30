cmake_minimum_required(VERSION 3.20)
project(FsusSearchRuntime LANGUAGES CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "FsusBlog search wasm must be built with Emscripten")
endif()

add_executable(FsusSearchRuntime
  src/search_index.cpp
)

target_compile_features(FsusSearchRuntime PRIVATE cxx_std_23)
target_compile_options(FsusSearchRuntime PRIVATE
  -fno-exceptions
  -fno-rtti
  -fvisibility=hidden
  -flto
)

set_target_properties(FsusSearchRuntime PROPERTIES
  OUTPUT_NAME "search_basic"
  RUNTIME_OUTPUT_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}"
  SUFFIX ".js"
)

option(WASM_SIMD "Enable WebAssembly SIMD128 instructions" OFF)

if(WASM_SIMD)
  target_compile_options(FsusSearchRuntime PRIVATE -O3 -msimd128)
  target_link_options(FsusSearchRuntime PRIVATE -O3 -msimd128)
  set_target_properties(FsusSearchRuntime PROPERTIES OUTPUT_NAME "search_simd")
else()
  target_compile_options(FsusSearchRuntime PRIVATE -Oz)
  target_link_options(FsusSearchRuntime PRIVATE -Oz)
endif()

target_link_options(FsusSearchRuntime PRIVATE
  --no-entry
  -sWASM=1
  -sALLOW_MEMORY_GROWTH=1
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createSearchModule
  -sENVIRONMENT=web,worker,node
  -sFILESYSTEM=0
  -sINCOMING_MODULE_JS_API=["locateFile","wasmBinary"]
  -sEXPORTED_FUNCTIONS=["_alloc_buffer","_free_buffer","_load_search_index","_load_search_entry","_search_articles","_get_last_result_ptr","_get_last_result_len","_get_last_error_ptr","_get_last_error_len","_get_last_error_code"]
  -sEXPORTED_RUNTIME_METHODS=[]
)
