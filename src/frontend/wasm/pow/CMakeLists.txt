cmake_minimum_required(VERSION 3.10)
project(FsusPowEngine CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 逻辑自洽：本工程现已转为纯粹的 WebAssembly 前端项目
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "This project is now strictly for WebAssembly. Please compile using emcmake.")
endif()

add_compile_definitions(__DEFINED_max_align_t)

set(SOURCES src/main.cpp)
add_executable(FsusPowEngine ${SOURCES})

# 显式包含 Emscripten 系统头文件
target_include_directories(FsusPowEngine SYSTEM PRIVATE ${EMSCRIPTEN_SYSROOT}/include)

target_compile_options(
    FsusPowEngine PRIVATE "-O3" "-fno-exceptions" "-fno-rtti" "-fomit-frame-pointer" "-fvisibility=hidden"
)

set_target_properties(
    FsusPowEngine
    PROPERTIES OUTPUT_NAME "fsus_pow"
               RUNTIME_OUTPUT_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}"
               SUFFIX ".js"
)

option(WASM_SIMD "Enable WebAssembly SIMD128 instructions" OFF)
option(WASM_RELAXED_SIMD "Enable WebAssembly relaxed SIMD instructions" OFF)
option(WASM_THREADS "Build the worker-sharded PoW tier artifact" OFF)

if(WASM_THREADS)
    message(STATUS "WebAssembly worker-sharded SIMD tier enabled")
    target_compile_options(FsusPowEngine PRIVATE "-msimd128")
    target_link_options(FsusPowEngine PRIVATE "-msimd128")
    set_target_properties(FsusPowEngine PROPERTIES OUTPUT_NAME "fsus_pow_threads")
elseif(WASM_RELAXED_SIMD)
    message(STATUS "WebAssembly relaxed SIMD enabled")
    target_compile_options(FsusPowEngine PRIVATE "-msimd128" "-mrelaxed-simd")
    target_link_options(FsusPowEngine PRIVATE "-msimd128" "-mrelaxed-simd")
    set_target_properties(FsusPowEngine PROPERTIES OUTPUT_NAME "fsus_pow_relaxed")
elseif(WASM_SIMD)
    message(STATUS "WebAssembly SIMD128 enabled")
    target_compile_options(FsusPowEngine PRIVATE "-msimd128")
    target_link_options(FsusPowEngine PRIVATE "-msimd128")
    set_target_properties(FsusPowEngine PROPERTIES OUTPUT_NAME "fsus_pow_simd")
else()
    message(STATUS "WebAssembly SIMD128 disabled (Scalar fallback mode)")
    set_target_properties(FsusPowEngine PROPERTIES OUTPUT_NAME "fsus_pow_basic")
endif()

target_link_options(
    FsusPowEngine
    PRIVATE
    "-O3"
    "-flto"
    "-sWASM=1"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createPowModule"
    "-sENVIRONMENT=web,worker"
    "-sALLOW_MEMORY_GROWTH=0"
    "-sINITIAL_MEMORY=16777216"
    "-sFILESYSTEM=0"
    "-sMALLOC=emmalloc"
    "-sDYNAMIC_EXECUTION=0"
    "-sEXPORTED_FUNCTIONS=[\"_malloc\",\"_free\",\"_solve_pow_c\",\"_solve_pow_range_c\",\"_solve_pow_limited_c\"]"
    "-sEXPORTED_RUNTIME_METHODS=[\"HEAPU8\"]"
    "--no-entry"
)
