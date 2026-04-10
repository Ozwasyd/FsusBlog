cmake_minimum_required(VERSION 3.10)
project(FsusPowEngine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 逻辑自洽：本工程现已转为纯粹的 WebAssembly 前端项目
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "This project is now strictly for WebAssembly. Please compile using emcmake.")
endif()

set(SOURCES src/main.cpp)
add_executable(FsusPowEngine ${SOURCES})

# 显式包含 Emscripten 系统头文件
target_include_directories(FsusPowEngine SYSTEM PRIVATE ${EMSCRIPTEN_SYSROOT}/include)

set_target_properties(FsusPowEngine PROPERTIES
    OUTPUT_NAME "fsus_pow"
    RUNTIME_OUTPUT_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}"
    SUFFIX ".js"
)

option(WASM_SIMD "Enable WebAssembly SIMD128 instructions" OFF)

if(WASM_SIMD)
    message(STATUS "WebAssembly SIMD128 enabled")
    target_compile_options(FsusPowEngine PRIVATE "-msimd128")
    target_link_options(FsusPowEngine PRIVATE "-msimd128")
    set_target_properties(FsusPowEngine PROPERTIES OUTPUT_NAME "fsus_pow_simd")
else()
    message(STATUS "WebAssembly SIMD128 disabled (Scalar fallback mode)")
    set_target_properties(FsusPowEngine PROPERTIES OUTPUT_NAME "fsus_pow_basic")
endif()

target_link_options(FsusPowEngine PRIVATE
    "-O3"
    "-flto"
    "-sWASM=1"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createPowModule"
    "-sENVIRONMENT=web,worker"
    "-sALLOW_MEMORY_GROWTH=1"
    "--bind"
    "--no-entry"
)
