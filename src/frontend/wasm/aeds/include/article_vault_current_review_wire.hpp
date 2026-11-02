#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <string_view>

namespace FsusBlog::Pod::VaultCurrentReview
{
    constexpr std::size_t RequestBytes = 3176;
    constexpr std::uint64_t MaxWireInteger = 9007199254740991ULL;

#pragma pack(push, 1)
    struct OperationPod
    {
        char schema[48]; std::int32_t version; std::uint32_t reserved;
        char site[512]; char vault[512]; char device[512]; char agent[512]; char plan[512];
        char plan_sha[64]; char request_sha[64]; char idempotency_sha[64];
        std::int64_t deadline; char identity[64]; char content_sha[64];
    };
    struct RequestPod
    {
        std::uint32_t magic; std::uint16_t version; std::uint16_t flags;
        std::int32_t article_id; std::uint32_t reserved;
        char resolution[80]; char proposal_sha[64];
        std::int64_t sequence; char checkpoint_sha[64]; OperationPod operation;
    };
#pragma pack(pop)
    static_assert(sizeof(OperationPod) == 2944);
    static_assert(sizeof(RequestPod) == RequestBytes);
    static_assert(offsetof(RequestPod, operation) == 232);
    static_assert(offsetof(OperationPod, deadline) == 2808);

    inline std::uint64_t ReadLe(const std::uint8_t* p, unsigned size)
    {
        std::uint64_t value = 0;
        for (unsigned i = 0; i < size; ++i) value |= std::uint64_t(p[i]) << (8 * i);
        return value;
    }
    inline bool Zero(const std::uint8_t* p, std::size_t n)
    {
        for (std::size_t i = 0; i < n; ++i) if (p[i] != 0) return false;
        return true;
    }
    inline bool Digest(const std::uint8_t* p)
    {
        for (unsigned i = 0; i < 64; ++i)
            if (!(p[i] >= '0' && p[i] <= '9') && !(p[i] >= 'a' && p[i] <= 'f')) return false;
        return true;
    }
    inline bool Text(const std::uint8_t* p, std::size_t size, std::string_view expected)
    {
        return expected.size() <= size && std::memcmp(p, expected.data(), expected.size()) == 0
            && Zero(p + expected.size(), size - expected.size());
    }
    inline bool Identity(const std::uint8_t* p)
    {
        std::size_t length = 0;
        while (length < 512 && p[length] != 0) ++length;
        if (length == 512 || !Zero(p + length, 512 - length)) return false;
        unsigned units = 0;
        for (std::size_t i = 0; i < length;)
        {
            const std::uint8_t lead = p[i++];
            std::uint32_t cp = 0; unsigned remaining = 0;
            if (lead < 0x80) cp = lead;
            else if (lead >= 0xc2 && lead <= 0xdf) { cp = lead & 0x1f; remaining = 1; }
            else if (lead >= 0xe0 && lead <= 0xef) { cp = lead & 0x0f; remaining = 2; }
            else if (lead >= 0xf0 && lead <= 0xf4) { cp = lead & 7; remaining = 3; }
            else return false;
            const unsigned count = remaining;
            if (i + remaining > length) return false;
            while (remaining-- > 0)
            {
                const std::uint8_t b = p[i++];
                if ((b & 0xc0) != 0x80) return false;
                cp = (cp << 6) | (b & 0x3f);
            }
            if ((count == 1 && cp < 0x80) || (count == 2 && cp < 0x800) || (count == 3 && cp < 0x10000)
                || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
            if (cp == 0 || cp == 47 || cp == 92 || (cp >= 9 && cp <= 13) || cp == 32 || cp == 133
                || cp == 160 || cp == 5760 || (cp >= 8192 && cp <= 8202) || cp == 8232 || cp == 8233
                || cp == 8239 || cp == 8287 || cp == 12288) return false;
            units += cp > 0xffff ? 2U : 1U;
            if (units > 128) return false;
        }
        return units >= 3;
    }

    // Structural references only. Actual stored plan/checkpoint and permission checks remain server-owned.
    inline bool ParseRequest(const std::uint8_t* p, std::size_t size)
    {
        if (p == nullptr || size != RequestBytes || ReadLe(p, 4) != 0x31524356 || ReadLe(p + 4, 2) != 1
            || ReadLe(p + 6, 2) > 1 || ReadLe(p + 8, 4) == 0 || ReadLe(p + 8, 4) > 2147483647ULL
            || !Zero(p + 12, 4) || std::memcmp(p + 16, "resolution-", 11) != 0
            || !Digest(p + 27) || !Zero(p + 91, 5) || !Digest(p + 96)) return false;
        if (ReadLe(p + 6, 2) == 0) return Zero(p + 160, RequestBytes - 160);
        if (ReadLe(p + 160, 8) > MaxWireInteger || !Digest(p + 168)
            || !Text(p + 232, 48, "fsusblog.article-vault.operation-identity.v1")
            || ReadLe(p + 280, 4) != 1 || !Zero(p + 284, 4)) return false;
        for (const unsigned offset : {288U, 800U, 1312U, 1824U, 2336U}) if (!Identity(p + offset)) return false;
        for (const unsigned offset : {2848U, 2912U, 2976U, 3048U, 3112U}) if (!Digest(p + offset)) return false;
        const auto deadline = ReadLe(p + 3040, 8);
        return deadline > 0 && deadline <= MaxWireInteger;
    }
}
