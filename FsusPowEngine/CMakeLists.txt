cmake_minimum_required(VERSION 3.10)

# 项目名称与语言
project(FsusPowEngine CXX)

# 1. 强制要求 C++20（为了性能和更好的位运算支持）
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 2. 定义源文件路径
set(SOURCES 
    src/main.cpp
)

# 3. 创建执行目标
add_executable(FsusPowEngine ${SOURCES})

# 4. 包含 PicoSHA2 所在的 include 文件夹
target_include_directories(FsusPowEngine PRIVATE 
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

# 5. 针对 Emscripten (WebAssembly) 的专项配置
if(EMSCRIPTEN)
    message(STATUS "Detected Emscripten Toolchain - Configuring for WebAssembly")

    # 显式包含 Emscripten 系统头文件，解决 VS 代码报红问题
    target_include_directories(FsusPowEngine SYSTEM PRIVATE ${EMSCRIPTEN_SYSROOT}/include)

    # 设置输出文件名和后缀 (.js 会自动关联生成 .wasm)
    set_target_properties(FsusPowEngine PROPERTIES 
        OUTPUT_NAME "fsus_pow"
        SUFFIX ".js"
    )

    # 你可以通过 cmake -DWASM_SIMD=ON ... 来触发
    option(WASM_SIMD "Enable WebAssembly SIMD128 instructions" OFF)

    if(WASM_SIMD)
        message(STATUS "WebAssembly SIMD128 enabled")
        
        # 编译参数：影响代码中的 #ifdef __wasm_simd128__
        target_compile_options(FsusPowEngine PRIVATE "-msimd128")
        
        # 链接参数：确保生成的 .js/.wasm 支持 SIMD 指令
        target_link_options(FsusPowEngine PRIVATE "-msimd128")
        
        # 修改输出文件名以区分版本
        set_target_properties(FsusPowEngine PROPERTIES OUTPUT_NAME "fsus_pow_simd")
    else()
        message(STATUS "WebAssembly SIMD128 disabled (Scalar fallback mode)")
        set_target_properties(FsusPowEngine PROPERTIES OUTPUT_NAME "fsus_pow_basic")
    endif()

    # 极致性能优化与 Wasm 链接参数
    # 修正点：去掉了 -sEXPORT_NAME 和 -sENVIRONMENT 内部不必要的单引号，防止 Windows 命令行解析出错
    target_link_options(FsusPowEngine PRIVATE
        "-O3"                               # 极致优化
        "-flto"                             # 链接时优化
        "-sWASM=1"                          # 生成 Wasm
        "-sMODULARIZE=1"                    # 封装为模块
        "-sEXPORT_NAME=createPowModule"      # JS 调用名：createPowModule()
        "-sENVIRONMENT=web,worker"          # 运行环境：支持 Web 页面和 Worker 线程
        "-sALLOW_MEMORY_GROWTH=1"           # 内存动态增长
        "--bind"                            # 开启 Embind
        "--no-entry"                        # 库模式，无 main 函数
    )

    # 调试选项：如需调试，请取消注释
    # target_link_options(FsusPowEngine PRIVATE "-g4" "--source-map-base" "./")

else()
    # 非 Emscripten 环境逻辑
    message(WARNING "Current toolchain is NOT Emscripten. IntelliSense might show errors for emscripten/bind.h")
endif()