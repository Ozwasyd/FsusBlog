include_guard(GLOBAL)

add_library(FsusWarnings INTERFACE)

if(MSVC)
    target_compile_options(FsusWarnings INTERFACE /W4 /permissive-)
else()
    target_compile_options(
        FsusWarnings
        INTERFACE -Wall
                  -Wextra
                  -Wpedantic
                  -Wconversion
                  -Wsign-conversion
                  -Wshadow
                  -Wformat=2
                  -Wundef
    )
endif()

# Contract: Attach the repository warning profile and optional clang-tidy analysis to one owned target.
# Input: targetName identifies an existing CMake target; NO_CLANG_TIDY opts that target out of clang-tidy only.
# Output: The target inherits FsusWarnings and the configured warnings-as-errors or clang-tidy properties.
# Failure: Configuration stops when targetName is missing or the requested clang-tidy executable is unavailable.
function(FsusEnableProjectWarnings targetName)
    set(options NO_CLANG_TIDY)
    cmake_parse_arguments(PARSE_ARGV 1 warningOptions "${options}" "" "")

    if(NOT TARGET "${targetName}")
        message(FATAL_ERROR "FsusEnableProjectWarnings requires an existing project target: ${targetName}")
    endif()

    target_link_libraries("${targetName}" PRIVATE FsusWarnings)
    if(FSUSBLOG_WARNINGS_AS_ERRORS)
        if(MSVC)
            target_compile_options("${targetName}" PRIVATE /WX)
        else()
            target_compile_options("${targetName}" PRIVATE -Werror)
        endif()
    endif()

    if(FSUSBLOG_ENABLE_CLANG_TIDY AND NOT warningOptions_NO_CLANG_TIDY)
        find_program(clangTidyExecutable NAMES clang-tidy REQUIRED)
        set_property(
            TARGET "${targetName}" PROPERTY CXX_CLANG_TIDY
                                            "${clangTidyExecutable};--config-file=${PROJECT_SOURCE_DIR}/.clang-tidy"
        )
    endif()
endfunction()

# Contract: Attach the repository AddressSanitizer and UndefinedBehaviorSanitizer profile to one owned target.
# Input: targetName identifies the target that should receive sanitizer compile and link options.
# Output: The target is unchanged when sanitizers are disabled, otherwise it receives the shared sanitizer profile.
# Failure: Configuration stops when sanitizers are requested with an unsupported compiler.
function(FsusEnableSanitizers targetName)
    if(NOT FSUSBLOG_ENABLE_SANITIZERS)
        return()
    endif()

    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options("${targetName}" PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options("${targetName}" PRIVATE -fsanitize=address,undefined)
    else()
        message(FATAL_ERROR "FSUSBLOG_ENABLE_SANITIZERS requires Clang or GCC")
    endif()
endfunction()
