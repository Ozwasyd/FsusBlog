#include <cstring>
#include <vector>
#include <string>
#include <cstdint>
#include <emscripten/bind.h>

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

using namespace emscripten;

// 修复日期: 2026-02-22 (彻底移除后端 DLL 依赖，专职服务于前端 WebAssembly)

// ==========================================
// 硬核优化的原生 SHA-256 引擎
// ==========================================
#define BSWAP32(x) __builtin_bswap32(x)

namespace fast_sha256 {
    static const uint32_t K[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    };

#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x, y, z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define EP0(x) (ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22))
#define EP1(x) (ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25))
#define SIG0(x) (ROTR(x, 7) ^ ROTR(x, 18) ^ ((x) >> 3))
#define SIG1(x) (ROTR(x, 17) ^ ROTR(x, 19) ^ ((x) >> 10))

    static inline uint32_t load_be32(const uint8_t* p) {
        uint32_t v;
        std::memcpy(&v, p, 4);
        return BSWAP32(v);
    }

    static inline void store_be32(uint8_t* p, uint32_t v) {
        v = BSWAP32(v);
        std::memcpy(p, &v, 4);
    }

    static void transform(uint32_t* state, const uint8_t* data) {
        uint32_t a, b, c, d, e, f, g, h, i, j, t1, t2, m[64];

        for (i = 0, j = 0; i < 16; ++i, j += 4)
            m[i] = load_be32(&data[j]);
        for (; i < 64; ++i)
            m[i] = SIG1(m[i - 2]) + m[i - 7] + SIG0(m[i - 15]) + m[i - 16];

        a = state[0]; b = state[1]; c = state[2]; d = state[3];
        e = state[4]; f = state[5]; g = state[6]; h = state[7];

        for (i = 0; i < 64; ++i) {
            t1 = h + EP1(e) + CH(e, f, g) + K[i] + m[i];
            t2 = EP0(a) + MAJ(a, b, c);
            h = g; g = f; f = e; e = d + t1;
            d = c; c = b; b = a; a = t1 + t2;
        }

        state[0] += a; state[1] += b; state[2] += c; state[3] += d;
        state[4] += e; state[5] += f; state[6] += g; state[7] += h;
    }

    static void hash256(const uint8_t* data, size_t len, uint8_t* hash) {
        uint32_t state[8] = {
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        };
        uint8_t block[64];
        size_t i = 0;

        while (len >= 64) {
            transform(state, data + i);
            i += 64;
            len -= 64;
        }

        std::memcpy(block, data + i, len);
        block[len++] = 0x80;

        if (len > 56) {
            std::memset(block + len, 0, 64 - len);
            transform(state, block);
            std::memset(block, 0, 56);
        }
        else {
            std::memset(block + len, 0, 56 - len);
        }

        uint64_t bit_len = (uint64_t)(i + len - 1) * 8;
        block[56] = (bit_len >> 56) & 0xff;
        block[57] = (bit_len >> 48) & 0xff;
        block[58] = (bit_len >> 40) & 0xff;
        block[59] = (bit_len >> 32) & 0xff;
        block[60] = (bit_len >> 24) & 0xff;
        block[61] = (bit_len >> 16) & 0xff;
        block[62] = (bit_len >> 8) & 0xff;
        block[63] = bit_len & 0xff;

        transform(state, block);

        for (i = 0; i < 8; ++i) {
            store_be32(hash + i * 4, state[i]);
        }
    }
}

// ==========================================
// 辅助逻辑与 WASM 导出
// ==========================================

static inline bool increment_nonce(std::vector<char>& buffer, size_t nonce_start, size_t& suffix_start, size_t max_size) {
    for (int i = (int)suffix_start - 1; i >= (int)nonce_start; --i) {
        if (buffer[i] < '9') {
            buffer[i]++;
            return true;
        }
        else {
            buffer[i] = '0';
        }
    }

    if (buffer.size() + 1 >= max_size) return false;

    buffer[nonce_start] = '1';
    size_t suffix_len = buffer.size() - suffix_start;
    buffer.resize(buffer.size() + 1);

    for (size_t i = 0; i < suffix_len; ++i) {
        buffer[buffer.size() - 1 - i] = buffer[buffer.size() - 2 - i];
    }

    buffer[suffix_start] = '0';
    suffix_start++;
    return true;
}

#ifdef __wasm_simd128__

static inline bool check_hash_simd(const unsigned char* hash, int difficulty) {
    int full_128bit_blocks = difficulty / 32;
    const v128_t zero = wasm_i8x16_const(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

    for (int i = 0; i < full_128bit_blocks; ++i) {
        v128_t val = wasm_v128_load(hash + (i * 16));
        if (wasm_i8x16_bitmask(wasm_i8x16_eq(val, zero)) != 0xFFFF) {
            return false;
        }
    }

    int checked_bytes = full_128bit_blocks * 16;
    int full_bytes = difficulty / 2;

    for (int i = checked_bytes; i < full_bytes; ++i) {
        if (hash[i] != 0) return false;
    }

    if (difficulty % 2 != 0) {
        if ((hash[full_bytes] & 0xF0) != 0) return false;
    }

    return true;
}

static std::string solve_pow_simd(std::string salt, std::string browserFp, int difficulty) {
    alignas(16) unsigned char hash[32];
    std::vector<char> buffer;
    buffer.reserve(1024);

    buffer.insert(buffer.end(), salt.begin(), salt.end());
    buffer.push_back(':');
    size_t nonce_start = buffer.size();
    buffer.push_back('0');
    size_t suffix_start = buffer.size();
    buffer.push_back(':');
    buffer.insert(buffer.end(), browserFp.begin(), browserFp.end());

    while (true) {
        fast_sha256::hash256(reinterpret_cast<const uint8_t*>(buffer.data()), buffer.size(), hash);
        if (check_hash_simd(hash, difficulty)) {
            return std::string(buffer.data() + nonce_start, suffix_start - nonce_start);
        }
        if (!increment_nonce(buffer, nonce_start, suffix_start, 1024)) return "failed_overflow";
    }
    return "failed";
}

#else 

static inline bool check_hash_scalar(const unsigned char* hash, int difficulty) {
    int full_bytes = difficulty / 2;
    for (int i = 0; i < full_bytes; ++i) {
        if (hash[i] != 0) return false;
    }
    if (difficulty % 2 != 0) {
        if ((hash[full_bytes] & 0xF0) != 0) return false;
    }
    return true;
}

static std::string solve_pow_scalar(std::string salt, std::string browserFp, int difficulty) {
    unsigned char hash[32];
    std::vector<char> buffer;
    buffer.reserve(1024);

    buffer.insert(buffer.end(), salt.begin(), salt.end());
    buffer.push_back(':');
    size_t nonce_start = buffer.size();
    buffer.push_back('0');
    size_t suffix_start = buffer.size();
    buffer.push_back(':');
    buffer.insert(buffer.end(), browserFp.begin(), browserFp.end());

    while (true) {
        fast_sha256::hash256(reinterpret_cast<const uint8_t*>(buffer.data()), buffer.size(), hash);
        if (check_hash_scalar(hash, difficulty)) {
            return std::string(buffer.data() + nonce_start, suffix_start - nonce_start);
        }
        if (!increment_nonce(buffer, nonce_start, suffix_start, 1024)) return "failed_overflow";
    }
    return "failed";
}

#endif 

static std::string solve_pow(std::string salt, std::string browserFp, int difficulty) {
    if (salt.length() > 256 || browserFp.length() > 512) return "error_input_too_long";
    if (difficulty <= 0 || difficulty > 64) return "0";

#ifdef __wasm_simd128__
    return solve_pow_simd(salt, browserFp, difficulty);
#else
    return solve_pow_scalar(salt, browserFp, difficulty);
#endif
}

EMSCRIPTEN_BINDINGS(pow_module) {
    function("solve_pow", &solve_pow);
}