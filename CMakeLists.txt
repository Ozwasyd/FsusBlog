cmake_minimum_required(VERSION 3.25)

project(FsusBlogNativeTooling LANGUAGES CXX)

include(CTest)

option(FSUSBLOG_WARNINGS_AS_ERRORS "Treat warnings as errors for repository-owned native targets" OFF)
option(FSUSBLOG_ENABLE_CLANG_TIDY "Run clang-tidy for repository-owned native targets" OFF)
option(FSUSBLOG_ENABLE_SANITIZERS "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(FSUSBLOG_ENABLE_FUZZING "Build repository-owned libFuzzer targets" OFF)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include(cmake/FsusWarnings.cmake)
add_subdirectory(tests/native)

add_custom_target(
    FormatCheck
    COMMAND "${PROJECT_SOURCE_DIR}/tools/format.sh" --check --full --domain native
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    USES_TERMINAL
)

add_custom_target(
    LintNative
    COMMAND "${PROJECT_SOURCE_DIR}/tools/lint.sh" native --full
    WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
    USES_TERMINAL
)
