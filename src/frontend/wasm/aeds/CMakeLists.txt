cmake_minimum_required(VERSION 3.20)
project(fsusblog_aeds_decoder LANGUAGES CXX)

set(AEDS_DECODER_SOURCES src/aeds_crc32.cpp src/pod_parse_article.cpp src/aeds_decode.cpp src/exports.cpp)

set(AEDS_EXPORTED_FUNCTIONS
    "['_reserve_io_buffer','_decode_io_buffer','_clear_io_buffer','_get_io_buffer_ptr','_get_io_buffer_size','_get_io_buffer_capacity','_get_arena_reallocation_count','_get_arena_clear_count','_get_last_payload_token','_get_last_payload_ptr','_get_last_payload_len','_get_last_frame_type','_get_last_error_ptr','_get_last_error_len','_get_last_error_code','_render_view','_get_last_html_ptr','_get_last_html_len','_handle_event']"
)

option(FSUSBLOG_AEDS_MEMORY64 "Build AEDS decoder with Emscripten memory64" OFF)

# Contract: Define one AEDS decoder target without changing its exported C ABI.
# Input: target is the CMake target name, output_name is the emitted module name, and tier selects basic or speed flags.
# Output: A configured Emscripten executable that emits the requested JavaScript and WebAssembly module.
# Failure: Configuration or linking fails when the toolchain, tier options, or required exports are invalid.
function(add_aeds_decoder target output_name tier)
    add_executable(${target} ${AEDS_DECODER_SOURCES})
    target_include_directories(${target} PRIVATE include)
    target_compile_options(${target} PRIVATE -fno-exceptions -fno-rtti -fvisibility=hidden)

    set(memory_options -sSTACK_SIZE=1048576 -sMALLOC=emmalloc)
    if(tier STREQUAL "speed")
        target_compile_definitions(${target} PRIVATE FSUSBLOG_AEDS_SPEED_TIER=1)
        target_compile_options(${target} PRIVATE -O3 -flto -msimd128)
        target_link_options(
            ${target}
            PRIVATE
            -O3
            -flto
            -msimd128
            -sALLOW_MEMORY_GROWTH=0
            -sINITIAL_MEMORY=67108864
        )
    else()
        target_compile_options(${target} PRIVATE -Oz)
        target_link_options(
            ${target} PRIVATE -Oz -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=268435456
        )
    endif()

    set_target_properties(
        ${target}
        PROPERTIES OUTPUT_NAME "${output_name}"
                   RUNTIME_OUTPUT_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}"
                   SUFFIX ".js"
    )

    target_link_options(
        ${target}
        PRIVATE
        --no-entry
        -sWASM=1
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createAedsModule
        -sENVIRONMENT=web,worker
        -sWASM_BIGINT=1
        "-sEXPORTED_FUNCTIONS=${AEDS_EXPORTED_FUNCTIONS}"
        "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']"
        ${memory_options}
    )
    if(FSUSBLOG_AEDS_MEMORY64)
        target_compile_options(${target} PRIVATE -sMEMORY64=1)
        target_link_options(${target} PRIVATE -sMEMORY64=1)
    endif()
endfunction()

add_aeds_decoder(aeds_decoder_basic aeds_decoder_basic basic)
add_aeds_decoder(aeds_decoder_speed aeds_decoder_speed speed)
