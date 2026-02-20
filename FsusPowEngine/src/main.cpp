#include <emscripten/bind.h>
#include <cstring>
#include <vector>
#include <string>
#include <algorithm> // for std::copy

// 引入 Picosha2 头文件 (请确保项目目录包含 include/picosha2.h)
#include "include/picosha2.h" 

// 仅在 SIMD 模式下引入 WASM Intrinsic 头文件
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

using namespace emscripten;

// ==========================================
// 🛡️ 通用辅助逻辑层
// ==========================================

/**
 * 快速 Nonce 自增逻辑 (通用优化版)
 * 处理数字自增及进位导致的缓冲区扩展
 * * @param buffer 缓冲区引用
 * @param nonce_start Nonce 在 buffer 中的起始索引
 * @param suffix_start 后缀 (:Fp) 起始索引的引用 (进位时会更新)
 * @param max_size 缓冲区最大允许容量 (安全熔断)
 * @return true 成功, false 溢出/错误
 */
inline bool increment_nonce(std::vector<char>& buffer, size_t nonce_start, size_t& suffix_start, size_t max_size) {
    // 1. 常规路径：从 Nonce 个位开始倒序尝试自增
    // Nonce 范围: [nonce_start, suffix_start)
    for (int i = (int)suffix_start - 1; i >= (int)nonce_start; --i) {
        if (buffer[i] < '9') {
            buffer[i]++;
            return true; // 仅数值变化，长度不变，无需内存搬移，极速返回
        }
        else {
            buffer[i] = '0'; // 9 -> 0, 继续向高位进位
        }
    }

    // 2. 进位路径：处理位数增加 (例如 99 -> 100)
    // 此时 buffer 范围内的 Nonce 区域已全变为 '0' (如 00)

    // 安全熔断
    if (buffer.size() + 1 >= max_size) return false;

    // 逻辑 A: 将首位改为 '1' (00 -> 10)
    buffer[nonce_start] = '1';

    // 逻辑 B: 需要在 Nonce 末尾 (即 suffix_start 处) 插入一个 '0'
    // 这意味着需要将后缀部分整体向后移动 1 位

    // 获取当前后缀的长度 (包含 :)
    size_t suffix_len = buffer.size() - suffix_start;

    // 扩展 buffer 大小 (可能会触发 realloc，但概率极低)
    buffer.resize(buffer.size() + 1);

    // 手动搬移后缀数据 (从后向前搬移，避免覆盖)
    // 原始后缀位置: [suffix_start ... old_end-1]
    // 目标位置:     [suffix_start+1 ... new_end-1]
    for (size_t i = 0; i < suffix_len; ++i) {
        // buffer.size() 已增加 1
        // 将倒数第 (i+2) 个元素移到倒数第 (i+1) 个位置
        buffer[buffer.size() - 1 - i] = buffer[buffer.size() - 2 - i];
    }

    // 🌟 核心修正点：
    // 腾出的空位正是原来的 suffix_start (现在是 Nonce 的最后一位)
    // 原来的 suffix_start+1 现在存放的是被移过去的冒号 ':'
    // 此时: 10...0:Fp
    buffer[suffix_start] = '0';

    // 更新后缀起始索引 (向后推一位)
    suffix_start++;

    return true;
}

// ==========================================
// ⚡ 路径 A: SIMD 加速实现
// 编译条件: CMake 开启 -msimd128
// ==========================================
#ifdef __wasm_simd128__

/**
 * SIMD 优化的哈希检查
 * 利用 v128 寄存器一次并行检查 16 字节
 */
inline bool check_hash_simd(const unsigned char* hash, int difficulty) {
    // 1. 快速检查 (以 16 字节为单位)
    // difficulty 是半字节数 (nibbles)。32 nibbles = 128 bits = 16 bytes
    int full_128bit_blocks = difficulty / 32;

    // 加载 128位 零向量
    const v128_t zero = wasm_i8x16_const(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

    for (int i = 0; i < full_128bit_blocks; ++i) {
        // 加载哈希片段 (v128_load 要求地址对齐，solve_pow_simd 中已处理 alignas)
        v128_t val = wasm_v128_load(hash + (i * 16));

        // 比较 val 是否全为 0。
        // wasm_i8x16_eq 返回一个向量，相等的位置为 0xFF，不等为 0x00
        // wasm_i8x16_bitmask 提取每个字节的最高位组成 16bit 掩码
        // 如果全为 0，掩码应为 0xFFFF
        if (wasm_i8x16_bitmask(wasm_i8x16_eq(val, zero)) != 0xFFFF) {
            return false;
        }
    }

    // 2. 剩余完整字节检查 (标量回退)
    int checked_bytes = full_128bit_blocks * 16;
    int full_bytes = difficulty / 2;

    for (int i = checked_bytes; i < full_bytes; ++i) {
        if (hash[i] != 0) return false;
    }

    // 3. 半字节检查 (奇数难度)
    if (difficulty % 2 != 0) {
        if ((hash[full_bytes] & 0xF0) != 0) return false;
    }

    return true;
}

std::string solve_pow_simd(std::string salt, std::string browserFp, int difficulty) {
    // 内存对齐的哈希缓冲区 (SIMD 加载必须对齐 16 字节，否则崩溃)
    alignas(16) unsigned char hash[32];

    // 初始化 Buffer，预留足够空间防止 resize
    std::vector<char> buffer;
    buffer.reserve(1024);

    // 构建初始数据 Salt:0:Fp
    buffer.insert(buffer.end(), salt.begin(), salt.end());
    buffer.push_back(':');
    size_t nonce_start = buffer.size();
    buffer.push_back('0');
    size_t suffix_start = buffer.size();
    buffer.push_back(':');
    buffer.insert(buffer.end(), browserFp.begin(), browserFp.end());

    // 主循环
    while (true) {
        // 计算哈希
        picosha2::hash256(buffer.data(), buffer.data() + buffer.size(), hash, hash + 32);

        // SIMD 检查
        if (check_hash_simd(hash, difficulty)) {
            return std::string(buffer.data() + nonce_start, suffix_start - nonce_start);
        }

        // 自增 Nonce
        if (!increment_nonce(buffer, nonce_start, suffix_start, 1024)) {
            return "failed_overflow";
        }
    }
    return "failed";
}

#else 

// ==========================================
// 🐢 路径 B: 标量极致优化实现 (Fallback)
// 编译条件: 未开启 -msimd128
// ==========================================

inline bool check_hash_scalar(const unsigned char* hash, int difficulty) {
    // 1. 完整字节检查
    int full_bytes = difficulty / 2;
    for (int i = 0; i < full_bytes; ++i) {
        if (hash[i] != 0) return false;
    }

    // 2. 半字节检查
    if (difficulty % 2 != 0) {
        if ((hash[full_bytes] & 0xF0) != 0) return false;
    }
    return true;
}

std::string solve_pow_scalar(std::string salt, std::string browserFp, int difficulty) {
    unsigned char hash[32];

    std::vector<char> buffer;
    buffer.reserve(1024);

    // 构建初始数据
    buffer.insert(buffer.end(), salt.begin(), salt.end());
    buffer.push_back(':');
    size_t nonce_start = buffer.size();
    buffer.push_back('0');
    size_t suffix_start = buffer.size();
    buffer.push_back(':');
    buffer.insert(buffer.end(), browserFp.begin(), browserFp.end());

    // 主循环
    while (true) {
        // 计算哈希
        picosha2::hash256(buffer.data(), buffer.data() + buffer.size(), hash, hash + 32);

        // 标量检查
        if (check_hash_scalar(hash, difficulty)) {
            return std::string(buffer.data() + nonce_start, suffix_start - nonce_start);
        }

        // 自增 Nonce
        if (!increment_nonce(buffer, nonce_start, suffix_start, 1024)) {
            return "failed_overflow";
        }
    }
    return "failed";
}

#endif // End of Path Selection

// ==========================================
// 🚀 统一入口 (双路径分发代理)
// ==========================================

std::string solve_pow(std::string salt, std::string browserFp, int difficulty) {
    // 1. 参数防御 (Input Validation)
    if (salt.length() > 256 || browserFp.length() > 512) return "error_input_too_long";
    if (difficulty <= 0 || difficulty > 64) return "0";

    // 2. 宏编译分发
    // 根据编译参数决定调用哪个内核，最大化减小 WASM 体积
#ifdef __wasm_simd128__
    return solve_pow_simd(salt, browserFp, difficulty);
#else
    return solve_pow_scalar(salt, browserFp, difficulty);
#endif
}

// Embind 导出定义
EMSCRIPTEN_BINDINGS(pow_module) {
    function("solve_pow", &solve_pow);
}