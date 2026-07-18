include_guard(GLOBAL)

add_library(FsusWarnings INTERFACE)

if(MSVC)
    target_compile_options(FsusWarnings INTERFACE /W4 /permissive-)
else()
    target_compile_options(
        FsusWarnings
        INTERFACE
            -Wall
            -Wextra
            -Wpedantic
            -Wconversion
            -Wsign-conversion
            -Wshadow
            -Wformat=2
            -Wundef
    )
endif()

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
            TARGET "${targetName}"
            PROPERTY CXX_CLANG_TIDY "${clangTidyExecutable};--config-file=${PROJECT_SOURCE_DIR}/.clang-tidy"
        )
    endif()
endfunction()

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
