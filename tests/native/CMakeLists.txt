add_library(
    FsusAedsCrc16
    STATIC
    "${PROJECT_SOURCE_DIR}/src/frontend/wasm/aeds/src/aeds_crc32.cpp"
)
target_include_directories(
    FsusAedsCrc16
    PUBLIC
        "${PROJECT_SOURCE_DIR}/src/frontend/wasm/aeds/include"
)
FsusEnableProjectWarnings(FsusAedsCrc16 NO_CLANG_TIDY)
FsusEnableSanitizers(FsusAedsCrc16)

add_executable(FsusNativeSmokeTests AedsCrc16SmokeTests.cpp)
target_link_libraries(FsusNativeSmokeTests PRIVATE FsusAedsCrc16)
FsusEnableProjectWarnings(FsusNativeSmokeTests)
FsusEnableSanitizers(FsusNativeSmokeTests)

add_test(NAME FsusNativeSmokeTests COMMAND FsusNativeSmokeTests)

if(FSUSBLOG_ENABLE_FUZZING)
    if(NOT CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        message(FATAL_ERROR "FSUSBLOG_ENABLE_FUZZING requires Clang")
    endif()

    add_library(
        FsusAedsCrc16Fuzz
        STATIC
        "${PROJECT_SOURCE_DIR}/src/frontend/wasm/aeds/src/aeds_crc32.cpp"
    )
    target_include_directories(
        FsusAedsCrc16Fuzz
        PUBLIC
            "${PROJECT_SOURCE_DIR}/src/frontend/wasm/aeds/include"
    )
    target_compile_options(FsusAedsCrc16Fuzz PRIVATE -fsanitize=fuzzer-no-link,address,undefined)
    FsusEnableProjectWarnings(FsusAedsCrc16Fuzz NO_CLANG_TIDY)

    add_executable(FsusCrc16Fuzz AedsCrc16Fuzz.cpp)
    target_link_libraries(FsusCrc16Fuzz PRIVATE FsusAedsCrc16Fuzz)
    target_compile_options(FsusCrc16Fuzz PRIVATE -fsanitize=fuzzer,address,undefined)
    target_link_options(FsusCrc16Fuzz PRIVATE -fsanitize=fuzzer,address,undefined)
    FsusEnableProjectWarnings(FsusCrc16Fuzz)
endif()
