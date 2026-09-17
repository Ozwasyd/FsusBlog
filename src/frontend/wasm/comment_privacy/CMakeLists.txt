cmake_minimum_required(VERSION 3.20)
project(FsusCommentPrivacyRuntime LANGUAGES CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "FsusBlog comment privacy wasm must be built with Emscripten")
endif()

add_executable(FsusCommentPrivacyRuntime src/comment_privacy.cpp)

target_compile_features(FsusCommentPrivacyRuntime PRIVATE cxx_std_23)
target_compile_options(FsusCommentPrivacyRuntime PRIVATE -O3 -fno-exceptions -fno-rtti -fvisibility=hidden -flto)

set_target_properties(
    FsusCommentPrivacyRuntime
    PROPERTIES OUTPUT_NAME "comment_privacy_runtime"
               RUNTIME_OUTPUT_DIRECTORY "${FSUSBLOG_WASM_OUTPUT_DIR}"
               SUFFIX ".js"
)

string(
    CONCAT commentPrivacyExportedFunctions
           "[\"_malloc\",\"_free\",\"_comment_privacy_probe\","
           "\"_comment_privacy_validate_proving_key\",\"_comment_privacy_prepare_proof\","
           "\"_comment_privacy_get_proof_ptr\",\"_comment_privacy_get_proof_len\","
           "\"_comment_privacy_get_last_error\"]"
)

target_link_options(
    FsusCommentPrivacyRuntime
    PRIVATE
    -O3
    -flto
    --no-entry
    -sWASM=1
    -sALLOW_MEMORY_GROWTH=1
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createCommentPrivacyRuntime
    -sENVIRONMENT=web,worker,node
    -sFILESYSTEM=0
    -sMALLOC=emmalloc
    -sDYNAMIC_EXECUTION=0
    -sINCOMING_MODULE_JS_API=["locateFile","wasmBinary"]
    "-sEXPORTED_FUNCTIONS=${commentPrivacyExportedFunctions}"
    -sEXPORTED_RUNTIME_METHODS=["HEAPU8"]
)
