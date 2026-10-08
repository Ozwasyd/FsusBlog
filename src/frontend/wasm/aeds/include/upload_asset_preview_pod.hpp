#pragma once

#include <cstddef>
#include <cstdint>
#include <string_view>

namespace FsusBlog::Pod::UploadPreview
{
#pragma pack(push, 1)

struct Header
{
    char Schema[64];
    char UploadId[64];
    char AssetId[64];
    char PublicUrl[256];
    char MimeType[64];
    char Extension[32];
    std::int64_t SizeBytes;
    std::int32_t Width;
    std::int32_t Height;
    char Sha256[64];
    char AssetVersionSha256[64];
    char ReferenceLedgerSha256[64];
    std::int32_t ReferenceRowCount;
    std::int32_t Reserved0;
};

#pragma pack(pop)
static_assert(sizeof(Header) == 760);
static_assert(offsetof(Header, SizeBytes) == 544);
static_assert(offsetof(Header, Sha256) == 560);
static_assert(offsetof(Header, ReferenceRowCount) == 752);

inline std::uint32_t U32(const std::uint8_t* p)
{
    return p[0] | (static_cast<std::uint32_t>(p[1]) << 8u) | (static_cast<std::uint32_t>(p[2]) << 16u)
           | (static_cast<std::uint32_t>(p[3]) << 24u);
}

inline bool Field(const std::uint8_t* p, std::size_t size, std::string_view& value)
{
    std::size_t end = 0;
    while (end < size && p[end] != 0)
        ++end;
    for (std::size_t i = 0; i < size; ++i)
        if (i < end ? p[i] < 33 || p[i] > 126 : p[i] != 0)
            return false;
    value = std::string_view(reinterpret_cast<const char*>(p), end);
    return true;
}

inline bool Hex(std::string_view value, std::size_t size)
{
    if (value.size() != size)
        return false;
    for (char c : value)
        if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f'))
            return false;
    return true;
}

inline bool Parse(const std::uint8_t* p, std::size_t length)
{
    if (p == nullptr || length < sizeof(Header))
        return false;
    constexpr std::size_t offsets[] = {0, 64, 128, 192, 448, 512, 560, 624, 688};
    constexpr std::size_t sizes[] = {64, 64, 64, 256, 64, 32, 64, 64, 64};
    std::string_view f[9];
    for (std::size_t i = 0; i < 9; ++i)
        if (!Field(p + offsets[i], sizes[i], f[i]))
            return false;
    if (f[0] != "fsusblog.upload-asset-preview.v1" || !Hex(f[1], 32) || f[2].size() != 36)
        return false;
    std::size_t j = 0;
    for (std::size_t i = 0; i < 36; ++i)
    {
        if (i == 8 || i == 13 || i == 18 || i == 23)
        {
            if (f[2][i] != '-')
                return false;
        }
        else if (f[2][i] != f[1][j++])
            return false;
    }
    const std::string_view ext = f[5];
    const std::string_view mime = ext == ".png"                     ? "image/png"
                                  : ext == ".jpg" || ext == ".jpeg" ? "image/jpeg"
                                  : ext == ".gif"                   ? "image/gif"
                                  : ext == ".webp"                  ? "image/webp"
                                  : ext == ".ico"                   ? "image/x-icon"
                                                                    : "";
    constexpr std::string_view prefix = "/uploads/illustration/";
    if (mime.empty() || f[4] != mime || f[3].size() != prefix.size() + 32 + ext.size()
        || f[3].substr(0, prefix.size()) != prefix || f[3].substr(prefix.size(), 32) != f[1]
        || f[3].substr(prefix.size() + 32) != ext)
        return false;
    const auto size = U32(p + 544), width = U32(p + 552), height = U32(p + 556);
    constexpr std::uint32_t MaxPreviewBytes = 8u * 1024u * 1024u - 16u - sizeof(Header);
    return U32(p + 548) == 0 && size > 0 && size <= MaxPreviewBytes && length - sizeof(Header) == size
           && width <= 0x7fffffffu && height <= 0x7fffffffu && (width == 0) == (height == 0) && U32(p + 752) <= 1024
           && U32(p + 756) == 0 && Hex(f[6], 64) && Hex(f[7], 64) && Hex(f[8], 64);
}
} // namespace FsusBlog::Pod::UploadPreview
