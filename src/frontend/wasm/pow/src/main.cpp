#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <cstring>
#include <limits>

#include <emscripten/emscripten.h>

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace {

constexpr std::size_t kMaxSaltBytes = 256;
constexpr std::size_t kMaxFingerprintBytes = 512;
constexpr std::size_t kShortBlockBytes = 128;
constexpr std::size_t kMaxPowOutputBytes = 11;
constexpr std::uint32_t kDefaultStep = 1;

namespace sha256 {

constexpr std::array<std::uint32_t, 8> kInitialState = {
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u
};

constexpr std::array<std::uint32_t, 64> kRoundConstants = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

[[gnu::always_inline]] inline std::uint32_t load_be32(const std::uint8_t* ptr) noexcept
{
    std::uint32_t value;
    std::memcpy(&value, ptr, sizeof(value));
    return __builtin_bswap32(value);
}

[[gnu::always_inline]] inline std::uint32_t ch(std::uint32_t x, std::uint32_t y, std::uint32_t z) noexcept
{
    return (x & y) ^ (~x & z);
}

[[gnu::always_inline]] inline std::uint32_t maj(std::uint32_t x, std::uint32_t y, std::uint32_t z) noexcept
{
    return (x & y) ^ (x & z) ^ (y & z);
}

[[gnu::always_inline]] inline std::uint32_t ep0(std::uint32_t x) noexcept
{
    return std::rotr(x, 2) ^ std::rotr(x, 13) ^ std::rotr(x, 22);
}

[[gnu::always_inline]] inline std::uint32_t ep1(std::uint32_t x) noexcept
{
    return std::rotr(x, 6) ^ std::rotr(x, 11) ^ std::rotr(x, 25);
}

[[gnu::always_inline]] inline std::uint32_t sig0(std::uint32_t x) noexcept
{
    return std::rotr(x, 7) ^ std::rotr(x, 18) ^ (x >> 3);
}

[[gnu::always_inline]] inline std::uint32_t sig1(std::uint32_t x) noexcept
{
    return std::rotr(x, 17) ^ std::rotr(x, 19) ^ (x >> 10);
}

[[gnu::always_inline]] inline void reset_state(std::uint32_t state[8]) noexcept
{
    std::memcpy(state, kInitialState.data(), kInitialState.size() * sizeof(std::uint32_t));
}

[[gnu::always_inline]] inline void transform(std::uint32_t state[8], const std::uint8_t* block) noexcept
{
    std::uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
        w[i] = load_be32(block + (i * 4));
    }
    for (int i = 16; i < 64; ++i) {
        w[i] = sig1(w[i - 2]) + w[i - 7] + sig0(w[i - 15]) + w[i - 16];
    }

    std::uint32_t a = state[0];
    std::uint32_t b = state[1];
    std::uint32_t c = state[2];
    std::uint32_t d = state[3];
    std::uint32_t e = state[4];
    std::uint32_t f = state[5];
    std::uint32_t g = state[6];
    std::uint32_t h = state[7];

    for (int i = 0; i < 64; ++i) {
        const std::uint32_t t1 = h + ep1(e) + ch(e, f, g) + kRoundConstants[i] + w[i];
        const std::uint32_t t2 = ep0(a) + maj(a, b, c);
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }

    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

[[gnu::always_inline]] inline void digest_blocks(const std::uint8_t* blocks, int block_count, std::uint32_t state[8]) noexcept
{
    reset_state(state);
    transform(state, blocks);
    if (block_count == 2) [[likely]] {
        transform(state, blocks + 64);
    }
}

#ifdef __wasm_simd128__
namespace simd4 {

[[gnu::always_inline]] inline v128_t make_word(const std::uint8_t* b0, const std::uint8_t* b1, const std::uint8_t* b2, const std::uint8_t* b3, int word) noexcept
{
    const int offset = word * 4;
    return wasm_i32x4_make(
        static_cast<std::int32_t>(load_be32(b0 + offset)),
        static_cast<std::int32_t>(load_be32(b1 + offset)),
        static_cast<std::int32_t>(load_be32(b2 + offset)),
        static_cast<std::int32_t>(load_be32(b3 + offset)));
}

[[gnu::always_inline]] inline v128_t splat(std::uint32_t value) noexcept
{
    return wasm_i32x4_splat(static_cast<std::int32_t>(value));
}

[[gnu::always_inline]] inline v128_t add(v128_t left, v128_t right) noexcept
{
    return wasm_i32x4_add(left, right);
}

[[gnu::always_inline]] inline v128_t rotr(v128_t value, int bits) noexcept
{
    return wasm_v128_or(wasm_u32x4_shr(value, bits), wasm_i32x4_shl(value, 32 - bits));
}

[[gnu::always_inline]] inline v128_t ch(v128_t x, v128_t y, v128_t z) noexcept
{
    return wasm_v128_xor(wasm_v128_and(x, y), wasm_v128_and(wasm_v128_not(x), z));
}

[[gnu::always_inline]] inline v128_t maj(v128_t x, v128_t y, v128_t z) noexcept
{
    return wasm_v128_xor(wasm_v128_xor(wasm_v128_and(x, y), wasm_v128_and(x, z)), wasm_v128_and(y, z));
}

[[gnu::always_inline]] inline v128_t ep0(v128_t x) noexcept
{
    return wasm_v128_xor(wasm_v128_xor(rotr(x, 2), rotr(x, 13)), rotr(x, 22));
}

[[gnu::always_inline]] inline v128_t ep1(v128_t x) noexcept
{
    return wasm_v128_xor(wasm_v128_xor(rotr(x, 6), rotr(x, 11)), rotr(x, 25));
}

[[gnu::always_inline]] inline v128_t sig0(v128_t x) noexcept
{
    return wasm_v128_xor(wasm_v128_xor(rotr(x, 7), rotr(x, 18)), wasm_u32x4_shr(x, 3));
}

[[gnu::always_inline]] inline v128_t sig1(v128_t x) noexcept
{
    return wasm_v128_xor(wasm_v128_xor(rotr(x, 17), rotr(x, 19)), wasm_u32x4_shr(x, 10));
}

[[gnu::always_inline]] inline void reset_state(v128_t state[8]) noexcept
{
    for (int i = 0; i < 8; ++i) {
        state[i] = splat(kInitialState[i]);
    }
}

[[gnu::always_inline]] inline void transform(v128_t state[8], const std::uint8_t* b0, const std::uint8_t* b1, const std::uint8_t* b2, const std::uint8_t* b3) noexcept
{
    v128_t w[64];
    for (int i = 0; i < 16; ++i) {
        w[i] = make_word(b0, b1, b2, b3, i);
    }
    for (int i = 16; i < 64; ++i) {
        w[i] = add(add(add(sig1(w[i - 2]), w[i - 7]), sig0(w[i - 15])), w[i - 16]);
    }

    v128_t a = state[0];
    v128_t b = state[1];
    v128_t c = state[2];
    v128_t d = state[3];
    v128_t e = state[4];
    v128_t f = state[5];
    v128_t g = state[6];
    v128_t h = state[7];

    for (int i = 0; i < 64; ++i) {
        const v128_t t1 = add(add(add(add(h, ep1(e)), ch(e, f, g)), splat(kRoundConstants[i])), w[i]);
        const v128_t t2 = add(ep0(a), maj(a, b, c));
        h = g;
        g = f;
        f = e;
        e = add(d, t1);
        d = c;
        c = b;
        b = a;
        a = add(t1, t2);
    }

    state[0] = add(state[0], a);
    state[1] = add(state[1], b);
    state[2] = add(state[2], c);
    state[3] = add(state[3], d);
    state[4] = add(state[4], e);
    state[5] = add(state[5], f);
    state[6] = add(state[6], g);
    state[7] = add(state[7], h);
}

[[gnu::always_inline]] inline void digest_blocks(
    const std::uint8_t* b0,
    const std::uint8_t* b1,
    const std::uint8_t* b2,
    const std::uint8_t* b3,
    int block_count,
    v128_t state[8]) noexcept
{
    reset_state(state);
    transform(state, b0, b1, b2, b3);
    if (block_count == 2) [[likely]] {
        transform(state, b0 + 64, b1 + 64, b2 + 64, b3 + 64);
    }
}

} // namespace simd4
#endif

} // namespace sha256

[[gnu::always_inline]] inline std::size_t bounded_strlen(const char* value, std::size_t max_len) noexcept
{
    std::size_t len = 0;
    while (len <= max_len && value[len] != '\0') {
        ++len;
    }
    return len;
}

[[gnu::always_inline]] inline std::size_t u32_decimal_length(std::uint32_t value) noexcept
{
    if (value >= 1000000000u) return 10;
    if (value >= 100000000u) return 9;
    if (value >= 10000000u) return 8;
    if (value >= 1000000u) return 7;
    if (value >= 100000u) return 6;
    if (value >= 10000u) return 5;
    if (value >= 1000u) return 4;
    if (value >= 100u) return 3;
    if (value >= 10u) return 2;
    return 1;
}

[[gnu::always_inline]] inline void write_u32_decimal(std::uint32_t value, std::uint8_t* output, std::size_t width) noexcept
{
    for (std::size_t i = width; i > 0; --i) {
        output[i - 1] = static_cast<std::uint8_t>('0' + (value % 10u));
        value /= 10u;
    }
}

[[gnu::always_inline]] inline void write_be64(std::uint8_t* output, std::uint64_t value) noexcept
{
    output[0] = static_cast<std::uint8_t>(value >> 56);
    output[1] = static_cast<std::uint8_t>(value >> 48);
    output[2] = static_cast<std::uint8_t>(value >> 40);
    output[3] = static_cast<std::uint8_t>(value >> 32);
    output[4] = static_cast<std::uint8_t>(value >> 24);
    output[5] = static_cast<std::uint8_t>(value >> 16);
    output[6] = static_cast<std::uint8_t>(value >> 8);
    output[7] = static_cast<std::uint8_t>(value);
}

[[gnu::always_inline]] inline bool build_short_blocks(
    const char* salt,
    std::size_t salt_len,
    const char* browser_fp,
    std::size_t browser_fp_len,
    std::uint32_t nonce,
    std::uint8_t blocks[kShortBlockBytes],
    int& block_count) noexcept
{
    const std::size_t nonce_len = u32_decimal_length(nonce);
    const std::size_t message_len = salt_len + 1 + nonce_len + 1 + browser_fp_len;
    if (message_len + 9 > kShortBlockBytes) [[unlikely]] {
        return false;
    }

    block_count = message_len <= 55 ? 1 : 2;
    std::memset(blocks, 0, static_cast<std::size_t>(block_count) * 64);

    std::size_t offset = 0;
    std::memcpy(blocks + offset, salt, salt_len);
    offset += salt_len;
    blocks[offset++] = static_cast<std::uint8_t>(':');
    write_u32_decimal(nonce, blocks + offset, nonce_len);
    offset += nonce_len;
    blocks[offset++] = static_cast<std::uint8_t>(':');
    std::memcpy(blocks + offset, browser_fp, browser_fp_len);
    offset += browser_fp_len;

    blocks[offset] = 0x80u;
    write_be64(blocks + (static_cast<std::size_t>(block_count) * 64) - 8, static_cast<std::uint64_t>(message_len) * 8u);
    return true;
}

[[gnu::always_inline]] inline bool meets_difficulty(const std::uint32_t state[8], int difficulty) noexcept
{
    if (difficulty <= 0) [[unlikely]] {
        return true;
    }

    const int leading_bits = difficulty;
    const int full_words = leading_bits / 32;
    const int remaining_bits = leading_bits % 32;

    for (int i = 0; i < full_words; ++i) {
        if (state[i] != 0u) {
            return false;
        }
    }

    if (remaining_bits == 0) {
        return true;
    }

    const std::uint32_t mask = 0xffffffffu << (32 - remaining_bits);
    return (state[full_words] & mask) == 0u;
}

[[gnu::always_inline]] inline bool meets_difficulty_first_word(std::uint32_t state0, int difficulty) noexcept
{
    if (difficulty <= 0) [[unlikely]] {
        return true;
    }
    if (difficulty > 32) [[unlikely]] {
        return false;
    }

    const int leading_bits = difficulty;
    const std::uint32_t mask = leading_bits == 32 ? 0xffffffffu : (0xffffffffu << (32 - leading_bits));
    return (state0 & mask) == 0u;
}

bool solve_range_scalar(
    const char* salt,
    std::size_t salt_len,
    const char* browser_fp,
    std::size_t browser_fp_len,
    int difficulty,
    std::uint32_t start_nonce,
    std::uint32_t step,
    std::uint32_t& solution) noexcept
{
    std::uint8_t blocks[kShortBlockBytes];
    std::uint32_t state[8];
    std::uint32_t nonce = start_nonce;

    for (;;) {
        int block_count = 0;
        if (!build_short_blocks(salt, salt_len, browser_fp, browser_fp_len, nonce, blocks, block_count)) [[unlikely]] {
            return false;
        }

        sha256::digest_blocks(blocks, block_count, state);
        if (meets_difficulty(state, difficulty)) {
            solution = nonce;
            return true;
        }

        const std::uint32_t next = nonce + step;
        if (next < nonce) [[unlikely]] {
            return false;
        }
        nonce = next;
    }
}

bool solve_limited_scalar(
    const char* salt,
    std::size_t salt_len,
    const char* browser_fp,
    std::size_t browser_fp_len,
    int difficulty,
    std::uint32_t start_nonce,
    std::uint32_t max_attempts,
    std::uint32_t& solution) noexcept
{
    if (max_attempts == 0u) {
        return false;
    }

    std::uint8_t blocks[kShortBlockBytes];
    std::uint32_t state[8];
    std::uint32_t nonce = start_nonce;

    for (std::uint32_t attempt = 0; attempt < max_attempts; ++attempt) {
        int block_count = 0;
        if (!build_short_blocks(salt, salt_len, browser_fp, browser_fp_len, nonce, blocks, block_count)) [[unlikely]] {
            return false;
        }

        sha256::digest_blocks(blocks, block_count, state);
        if (meets_difficulty(state, difficulty)) {
            solution = nonce;
            return true;
        }

        const std::uint32_t next = nonce + 1u;
        if (next < nonce) [[unlikely]] {
            return false;
        }
        nonce = next;
    }

    return false;
}

#ifdef __wasm_simd128__
bool solve_range_simd4(
    const char* salt,
    std::size_t salt_len,
    const char* browser_fp,
    std::size_t browser_fp_len,
    int difficulty,
    std::uint32_t start_nonce,
    std::uint32_t step,
    std::uint32_t& solution) noexcept
{
    if (difficulty > 32) [[unlikely]] {
        return solve_range_scalar(salt, salt_len, browser_fp, browser_fp_len, difficulty, start_nonce, step, solution);
    }

    alignas(16) std::uint8_t blocks[4][kShortBlockBytes];
    v128_t state[8];
    std::uint32_t nonce = start_nonce;

    for (;;) {
        int block_counts[4] = {};
        std::uint32_t candidates[4] = {};

        for (int lane = 0; lane < 4; ++lane) {
            candidates[lane] = nonce + (step * static_cast<std::uint32_t>(lane));
            if (candidates[lane] < nonce) [[unlikely]] {
                return false;
            }
            if (!build_short_blocks(salt, salt_len, browser_fp, browser_fp_len, candidates[lane], blocks[lane], block_counts[lane])) [[unlikely]] {
                return solve_range_scalar(salt, salt_len, browser_fp, browser_fp_len, difficulty, nonce, step, solution);
            }
        }

        if (block_counts[0] != block_counts[1] || block_counts[0] != block_counts[2] || block_counts[0] != block_counts[3]) [[unlikely]] {
            for (int lane = 0; lane < 4; ++lane) {
                std::uint32_t scalar_solution = 0;
                if (solve_range_scalar(salt, salt_len, browser_fp, browser_fp_len, difficulty, candidates[lane], step * 4u, scalar_solution)) {
                    solution = scalar_solution;
                    return true;
                }
            }
            return false;
        }

        sha256::simd4::digest_blocks(blocks[0], blocks[1], blocks[2], blocks[3], block_counts[0], state);
        const std::uint32_t state0[4] = {
            static_cast<std::uint32_t>(wasm_i32x4_extract_lane(state[0], 0)),
            static_cast<std::uint32_t>(wasm_i32x4_extract_lane(state[0], 1)),
            static_cast<std::uint32_t>(wasm_i32x4_extract_lane(state[0], 2)),
            static_cast<std::uint32_t>(wasm_i32x4_extract_lane(state[0], 3))
        };

        for (int lane = 0; lane < 4; ++lane) {
            if (meets_difficulty_first_word(state0[lane], difficulty)) {
                solution = candidates[lane];
                return true;
            }
        }

        const std::uint32_t advance = step * 4u;
        const std::uint32_t next = nonce + advance;
        if (next < nonce || advance == 0u) [[unlikely]] {
            return false;
        }
        nonce = next;
    }
}

bool solve_limited_simd4(
    const char* salt,
    std::size_t salt_len,
    const char* browser_fp,
    std::size_t browser_fp_len,
    int difficulty,
    std::uint32_t start_nonce,
    std::uint32_t max_attempts,
    std::uint32_t& solution) noexcept
{
    if (max_attempts == 0u) {
        return false;
    }

    if (difficulty > 32) [[unlikely]] {
        return solve_limited_scalar(salt, salt_len, browser_fp, browser_fp_len, difficulty, start_nonce, max_attempts, solution);
    }

    alignas(16) std::uint8_t blocks[4][kShortBlockBytes];
    v128_t state[8];
    std::uint32_t nonce = start_nonce;
    std::uint32_t attempted = 0;

    while (attempted < max_attempts) {
        const std::uint32_t remaining = max_attempts - attempted;
        if (remaining < 4u || nonce > std::numeric_limits<std::uint32_t>::max() - 3u) [[unlikely]] {
            return solve_limited_scalar(salt, salt_len, browser_fp, browser_fp_len, difficulty, nonce, remaining, solution);
        }

        int block_counts[4] = {};
        std::uint32_t candidates[4] = {};

        for (int lane = 0; lane < 4; ++lane) {
            candidates[lane] = nonce + static_cast<std::uint32_t>(lane);
            if (!build_short_blocks(salt, salt_len, browser_fp, browser_fp_len, candidates[lane], blocks[lane], block_counts[lane])) [[unlikely]] {
                return solve_limited_scalar(salt, salt_len, browser_fp, browser_fp_len, difficulty, nonce, remaining, solution);
            }
        }

        if (block_counts[0] != block_counts[1] || block_counts[0] != block_counts[2] || block_counts[0] != block_counts[3]) [[unlikely]] {
            return solve_limited_scalar(salt, salt_len, browser_fp, browser_fp_len, difficulty, nonce, remaining, solution);
        }

        sha256::simd4::digest_blocks(blocks[0], blocks[1], blocks[2], blocks[3], block_counts[0], state);
        const std::uint32_t state0[4] = {
            static_cast<std::uint32_t>(wasm_i32x4_extract_lane(state[0], 0)),
            static_cast<std::uint32_t>(wasm_i32x4_extract_lane(state[0], 1)),
            static_cast<std::uint32_t>(wasm_i32x4_extract_lane(state[0], 2)),
            static_cast<std::uint32_t>(wasm_i32x4_extract_lane(state[0], 3))
        };

        for (int lane = 0; lane < 4; ++lane) {
            if (meets_difficulty_first_word(state0[lane], difficulty)) {
                solution = candidates[lane];
                return true;
            }
        }

        nonce += 4u;
        attempted += 4u;
    }

    return false;
}
#endif

bool validate_inputs(const char* salt, const char* browser_fp, int difficulty, std::size_t& salt_len, std::size_t& fp_len) noexcept
{
    if (salt == nullptr || browser_fp == nullptr) {
        return false;
    }
    if (difficulty <= 0 || difficulty > 256) {
        salt_len = 0;
        fp_len = 0;
        return true;
    }

    salt_len = bounded_strlen(salt, kMaxSaltBytes);
    fp_len = bounded_strlen(browser_fp, kMaxFingerprintBytes);
    if (salt_len > kMaxSaltBytes || fp_len > kMaxFingerprintBytes) {
        return false;
    }

    const std::size_t worst_message_len = salt_len + 1 + 10 + 1 + fp_len;
    return worst_message_len + 9 <= kShortBlockBytes;
}

int write_solution(std::uint32_t nonce, char* output, int output_length) noexcept
{
    const std::size_t nonce_len = u32_decimal_length(nonce);
    if (output_length <= 0 || nonce_len + 1 > static_cast<std::size_t>(output_length)) {
        return -2;
    }

    write_u32_decimal(nonce, reinterpret_cast<std::uint8_t*>(output), nonce_len);
    output[nonce_len] = '\0';
    return static_cast<int>(nonce_len);
}

int solve_pow_range_impl(
    const char* salt,
    const char* browser_fp,
    int difficulty,
    std::uint32_t start_nonce,
    std::uint32_t step,
    char* output,
    int output_length) noexcept
{
    if (output == nullptr || output_length <= 0) {
        return -1;
    }

    std::size_t salt_len = 0;
    std::size_t fp_len = 0;
    if (!validate_inputs(salt, browser_fp, difficulty, salt_len, fp_len)) {
        return -1;
    }

    if (difficulty <= 0) {
        return write_solution(0, output, output_length);
    }

    if (step == 0u) {
        step = kDefaultStep;
    }

    std::uint32_t solution = 0;
#ifdef __wasm_simd128__
    const bool solved = solve_range_simd4(salt, salt_len, browser_fp, fp_len, difficulty, start_nonce, step, solution);
#else
    const bool solved = solve_range_scalar(salt, salt_len, browser_fp, fp_len, difficulty, start_nonce, step, solution);
#endif

    if (!solved) {
        static constexpr char kOverflow[] = "failed_overflow";
        constexpr std::size_t overflow_len = sizeof(kOverflow);
        if (overflow_len > static_cast<std::size_t>(output_length)) {
            return -2;
        }
        std::memcpy(output, kOverflow, overflow_len);
        return static_cast<int>(overflow_len - 1);
    }

    return write_solution(solution, output, output_length);
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int solve_pow_c(const char* salt, const char* browser_fp, int difficulty, char* output, int output_length)
{
    return solve_pow_range_impl(salt, browser_fp, difficulty, 0u, 1u, output, output_length);
}

EMSCRIPTEN_KEEPALIVE
int solve_pow_range_c(
    const char* salt,
    const char* browser_fp,
    int difficulty,
    std::uint32_t start_nonce,
    std::uint32_t step,
    char* output,
    int output_length)
{
    return solve_pow_range_impl(salt, browser_fp, difficulty, start_nonce, step, output, output_length);
}

EMSCRIPTEN_KEEPALIVE
int solve_pow_limited_c(
    const char* salt,
    const char* browser_fp,
    int difficulty,
    std::uint32_t start_nonce,
    std::uint32_t max_attempts,
    char* output,
    int output_length)
{
    if (output == nullptr || output_length <= 0) {
        return -1;
    }

    std::size_t salt_len = 0;
    std::size_t fp_len = 0;
    if (!validate_inputs(salt, browser_fp, difficulty, salt_len, fp_len)) {
        return -1;
    }

    if (difficulty <= 0) {
        return write_solution(0, output, output_length);
    }

    std::uint32_t solution = 0;
#ifdef __wasm_simd128__
    const bool solved = solve_limited_simd4(salt, salt_len, browser_fp, fp_len, difficulty, start_nonce, max_attempts, solution);
#else
    const bool solved = solve_limited_scalar(salt, salt_len, browser_fp, fp_len, difficulty, start_nonce, max_attempts, solution);
#endif
    if (!solved) {
        return 0;
    }

    return write_solution(solution, output, output_length);
}

}
