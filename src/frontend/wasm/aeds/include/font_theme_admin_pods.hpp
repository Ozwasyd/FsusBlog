#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "aeds_frame.hpp"

namespace FsusBlog::Pod::FontTheme
{

#pragma pack(push, 1)

struct Utf8SliceRef
{
    std::int32_t Offset;
    std::int32_t Length;
};

struct FontThemePayloadHeaderPod
{
    std::int32_t Version;
    std::int32_t RecordCount;
    std::int32_t PayloadLength;
    std::int32_t Reserved0;
};

static_assert(sizeof(FontThemePayloadHeaderPod) == 16);
static_assert(offsetof(FontThemePayloadHeaderPod, Version) == 0);
static_assert(offsetof(FontThemePayloadHeaderPod, RecordCount) == 4);
static_assert(offsetof(FontThemePayloadHeaderPod, PayloadLength) == 8);
static_assert(offsetof(FontThemePayloadHeaderPod, Reserved0) == 12);

struct FontRegistryItemPod
{
    std::int64_t InstalledAtUnixMs;
    std::int64_t UpdatedAtUnixMs;
    std::int64_t TotalSizeBytes;
    std::int32_t FaceCount;
    std::int32_t CriticalFaceCount;
    std::uint8_t Enabled;
    std::uint8_t BuiltIn;
    std::uint8_t InstallState;
    std::uint8_t Reserved0;
    Utf8SliceRef FontId;
    Utf8SliceRef Name;
    Utf8SliceRef Family;
    Utf8SliceRef Category;
    Utf8SliceRef Version;
};

static_assert(sizeof(FontRegistryItemPod) == 76);
static_assert(offsetof(FontRegistryItemPod, InstalledAtUnixMs) == 0);
static_assert(offsetof(FontRegistryItemPod, UpdatedAtUnixMs) == 8);
static_assert(offsetof(FontRegistryItemPod, TotalSizeBytes) == 16);
static_assert(offsetof(FontRegistryItemPod, FaceCount) == 24);
static_assert(offsetof(FontRegistryItemPod, CriticalFaceCount) == 28);
static_assert(offsetof(FontRegistryItemPod, Enabled) == 32);
static_assert(offsetof(FontRegistryItemPod, BuiltIn) == 33);
static_assert(offsetof(FontRegistryItemPod, InstallState) == 34);
static_assert(offsetof(FontRegistryItemPod, Reserved0) == 35);
static_assert(offsetof(FontRegistryItemPod, FontId) == 36);
static_assert(offsetof(FontRegistryItemPod, Name) == 44);
static_assert(offsetof(FontRegistryItemPod, Family) == 52);
static_assert(offsetof(FontRegistryItemPod, Category) == 60);
static_assert(offsetof(FontRegistryItemPod, Version) == 68);

struct FontRegistryDetailPod
{
    std::int64_t InstalledAtUnixMs;
    std::int64_t UpdatedAtUnixMs;
    std::int64_t TotalSizeBytes;
    std::int32_t FaceCount;
    std::int32_t CriticalFaceCount;
    std::uint8_t Enabled;
    std::uint8_t BuiltIn;
    std::uint8_t InstallState;
    std::uint8_t Reserved0;
    Utf8SliceRef FontId;
    Utf8SliceRef Name;
    Utf8SliceRef Family;
    Utf8SliceRef Category;
    Utf8SliceRef Version;
    Utf8SliceRef LicenseText;
    Utf8SliceRef LicenseSourceJson;
    Utf8SliceRef ManifestJson;
};

static_assert(sizeof(FontRegistryDetailPod) == 100);
static_assert(offsetof(FontRegistryDetailPod, InstalledAtUnixMs) == 0);
static_assert(offsetof(FontRegistryDetailPod, UpdatedAtUnixMs) == 8);
static_assert(offsetof(FontRegistryDetailPod, TotalSizeBytes) == 16);
static_assert(offsetof(FontRegistryDetailPod, FaceCount) == 24);
static_assert(offsetof(FontRegistryDetailPod, CriticalFaceCount) == 28);
static_assert(offsetof(FontRegistryDetailPod, Enabled) == 32);
static_assert(offsetof(FontRegistryDetailPod, BuiltIn) == 33);
static_assert(offsetof(FontRegistryDetailPod, InstallState) == 34);
static_assert(offsetof(FontRegistryDetailPod, Reserved0) == 35);
static_assert(offsetof(FontRegistryDetailPod, FontId) == 36);
static_assert(offsetof(FontRegistryDetailPod, Name) == 44);
static_assert(offsetof(FontRegistryDetailPod, Family) == 52);
static_assert(offsetof(FontRegistryDetailPod, Category) == 60);
static_assert(offsetof(FontRegistryDetailPod, Version) == 68);
static_assert(offsetof(FontRegistryDetailPod, LicenseText) == 76);
static_assert(offsetof(FontRegistryDetailPod, LicenseSourceJson) == 84);
static_assert(offsetof(FontRegistryDetailPod, ManifestJson) == 92);

struct FontFacePod
{
    std::int64_t SizeBytes;
    std::int32_t Weight;
    std::uint8_t Critical;
    std::uint8_t HasUnicodeRange;
    std::uint16_t Reserved0;
    Utf8SliceRef Style;
    Utf8SliceRef FilePath;
    Utf8SliceRef ContentHash;
    Utf8SliceRef UnicodeRange;
    Utf8SliceRef FontDisplay;
};

static_assert(sizeof(FontFacePod) == 56);
static_assert(offsetof(FontFacePod, SizeBytes) == 0);
static_assert(offsetof(FontFacePod, Weight) == 8);
static_assert(offsetof(FontFacePod, Critical) == 12);
static_assert(offsetof(FontFacePod, HasUnicodeRange) == 13);
static_assert(offsetof(FontFacePod, Reserved0) == 14);
static_assert(offsetof(FontFacePod, Style) == 16);
static_assert(offsetof(FontFacePod, FilePath) == 24);
static_assert(offsetof(FontFacePod, ContentHash) == 32);
static_assert(offsetof(FontFacePod, UnicodeRange) == 40);
static_assert(offsetof(FontFacePod, FontDisplay) == 48);

struct FontActivationPod
{
    std::int64_t ConfigVersion;
    std::int64_t UpdatedAtUnixMs;
    Utf8SliceRef Scope;
    Utf8SliceRef UiFontId;
    Utf8SliceRef ProseFontId;
    Utf8SliceRef CodeFontId;
    Utf8SliceRef CjkFontId;
    Utf8SliceRef EmojiFontId;
};

static_assert(sizeof(FontActivationPod) == 64);
static_assert(offsetof(FontActivationPod, ConfigVersion) == 0);
static_assert(offsetof(FontActivationPod, UpdatedAtUnixMs) == 8);
static_assert(offsetof(FontActivationPod, Scope) == 16);
static_assert(offsetof(FontActivationPod, UiFontId) == 24);
static_assert(offsetof(FontActivationPod, ProseFontId) == 32);
static_assert(offsetof(FontActivationPod, CodeFontId) == 40);
static_assert(offsetof(FontActivationPod, CjkFontId) == 48);
static_assert(offsetof(FontActivationPod, EmojiFontId) == 56);

struct ThemeRegistryItemPod
{
    std::int64_t InstalledAtUnixMs;
    std::int64_t UpdatedAtUnixMs;
    std::uint8_t Enabled;
    std::uint8_t InstallState;
    std::uint16_t Reserved0;
    Utf8SliceRef ThemeId;
    Utf8SliceRef Name;
    Utf8SliceRef Version;
    Utf8SliceRef Author;
    Utf8SliceRef Description;
    Utf8SliceRef Type;
    Utf8SliceRef PackageHash;
    Utf8SliceRef PackageLocation;
};

static_assert(sizeof(ThemeRegistryItemPod) == 84);
static_assert(offsetof(ThemeRegistryItemPod, InstalledAtUnixMs) == 0);
static_assert(offsetof(ThemeRegistryItemPod, UpdatedAtUnixMs) == 8);
static_assert(offsetof(ThemeRegistryItemPod, Enabled) == 16);
static_assert(offsetof(ThemeRegistryItemPod, InstallState) == 17);
static_assert(offsetof(ThemeRegistryItemPod, Reserved0) == 18);
static_assert(offsetof(ThemeRegistryItemPod, ThemeId) == 20);
static_assert(offsetof(ThemeRegistryItemPod, Name) == 28);
static_assert(offsetof(ThemeRegistryItemPod, Version) == 36);
static_assert(offsetof(ThemeRegistryItemPod, Author) == 44);
static_assert(offsetof(ThemeRegistryItemPod, Description) == 52);
static_assert(offsetof(ThemeRegistryItemPod, Type) == 60);
static_assert(offsetof(ThemeRegistryItemPod, PackageHash) == 68);
static_assert(offsetof(ThemeRegistryItemPod, PackageLocation) == 76);

struct ThemeRegistryDetailPod
{
    std::int64_t InstalledAtUnixMs;
    std::int64_t UpdatedAtUnixMs;
    std::int64_t CssBytes;
    std::int64_t AssetBytes;
    std::int64_t PreviewBytes;
    std::int32_t MaxSelectors;
    std::int32_t MaxSelectorDepth;
    std::int32_t MaxImportant;
    std::int32_t MaxMotionDurationMs;
    std::uint8_t Enabled;
    std::uint8_t InstallState;
    std::uint8_t SupportsPublic;
    std::uint8_t SupportsAdmin;
    std::uint8_t SupportsConsole;
    std::uint8_t SupportsHighContrast;
    std::uint8_t SupportsReducedMotion;
    std::uint8_t SupportsRtl;
    std::uint8_t PermissionScript;
    std::uint8_t PermissionNetwork;
    std::uint8_t PermissionFilesystem;
    std::uint8_t Reserved0;
    Utf8SliceRef ThemeId;
    Utf8SliceRef Name;
    Utf8SliceRef Version;
    Utf8SliceRef Author;
    Utf8SliceRef Description;
    Utf8SliceRef Type;
    Utf8SliceRef PackageHash;
    Utf8SliceRef PackageLocation;
    Utf8SliceRef ManifestJson;
    Utf8SliceRef ConfigSchemaJson;
};

static_assert(sizeof(ThemeRegistryDetailPod) == 148);
static_assert(offsetof(ThemeRegistryDetailPod, InstalledAtUnixMs) == 0);
static_assert(offsetof(ThemeRegistryDetailPod, UpdatedAtUnixMs) == 8);
static_assert(offsetof(ThemeRegistryDetailPod, CssBytes) == 16);
static_assert(offsetof(ThemeRegistryDetailPod, AssetBytes) == 24);
static_assert(offsetof(ThemeRegistryDetailPod, PreviewBytes) == 32);
static_assert(offsetof(ThemeRegistryDetailPod, MaxSelectors) == 40);
static_assert(offsetof(ThemeRegistryDetailPod, MaxSelectorDepth) == 44);
static_assert(offsetof(ThemeRegistryDetailPod, MaxImportant) == 48);
static_assert(offsetof(ThemeRegistryDetailPod, MaxMotionDurationMs) == 52);
static_assert(offsetof(ThemeRegistryDetailPod, Enabled) == 56);
static_assert(offsetof(ThemeRegistryDetailPod, InstallState) == 57);
static_assert(offsetof(ThemeRegistryDetailPod, SupportsPublic) == 58);
static_assert(offsetof(ThemeRegistryDetailPod, SupportsAdmin) == 59);
static_assert(offsetof(ThemeRegistryDetailPod, SupportsConsole) == 60);
static_assert(offsetof(ThemeRegistryDetailPod, SupportsHighContrast) == 61);
static_assert(offsetof(ThemeRegistryDetailPod, SupportsReducedMotion) == 62);
static_assert(offsetof(ThemeRegistryDetailPod, SupportsRtl) == 63);
static_assert(offsetof(ThemeRegistryDetailPod, PermissionScript) == 64);
static_assert(offsetof(ThemeRegistryDetailPod, PermissionNetwork) == 65);
static_assert(offsetof(ThemeRegistryDetailPod, PermissionFilesystem) == 66);
static_assert(offsetof(ThemeRegistryDetailPod, Reserved0) == 67);
static_assert(offsetof(ThemeRegistryDetailPod, ThemeId) == 68);
static_assert(offsetof(ThemeRegistryDetailPod, Name) == 76);
static_assert(offsetof(ThemeRegistryDetailPod, Version) == 84);
static_assert(offsetof(ThemeRegistryDetailPod, Author) == 92);
static_assert(offsetof(ThemeRegistryDetailPod, Description) == 100);
static_assert(offsetof(ThemeRegistryDetailPod, Type) == 108);
static_assert(offsetof(ThemeRegistryDetailPod, PackageHash) == 116);
static_assert(offsetof(ThemeRegistryDetailPod, PackageLocation) == 124);
static_assert(offsetof(ThemeRegistryDetailPod, ManifestJson) == 132);
static_assert(offsetof(ThemeRegistryDetailPod, ConfigSchemaJson) == 140);

struct ThemeActivationPod
{
    std::int64_t ConfigVersion;
    std::int64_t UpdatedAtUnixMs;
    std::uint8_t HasActiveThemeId;
    std::uint8_t HasMode;
    std::uint8_t HasActivationId;
    std::uint8_t HasAssetVersion;
    std::uint8_t HasConfigVersion;
    std::uint8_t HasUpdatedAt;
    std::uint16_t Reserved0;
    Utf8SliceRef Scope;
    Utf8SliceRef ActiveThemeId;
    Utf8SliceRef Mode;
    Utf8SliceRef ActivationId;
    Utf8SliceRef AssetVersion;
};

static_assert(sizeof(ThemeActivationPod) == 64);
static_assert(offsetof(ThemeActivationPod, ConfigVersion) == 0);
static_assert(offsetof(ThemeActivationPod, UpdatedAtUnixMs) == 8);
static_assert(offsetof(ThemeActivationPod, HasActiveThemeId) == 16);
static_assert(offsetof(ThemeActivationPod, HasMode) == 17);
static_assert(offsetof(ThemeActivationPod, HasActivationId) == 18);
static_assert(offsetof(ThemeActivationPod, HasAssetVersion) == 19);
static_assert(offsetof(ThemeActivationPod, HasConfigVersion) == 20);
static_assert(offsetof(ThemeActivationPod, HasUpdatedAt) == 21);
static_assert(offsetof(ThemeActivationPod, Reserved0) == 22);
static_assert(offsetof(ThemeActivationPod, Scope) == 24);
static_assert(offsetof(ThemeActivationPod, ActiveThemeId) == 32);
static_assert(offsetof(ThemeActivationPod, Mode) == 40);
static_assert(offsetof(ThemeActivationPod, ActivationId) == 48);
static_assert(offsetof(ThemeActivationPod, AssetVersion) == 56);

struct ThemeActivationHistoryPod
{
    std::int64_t ConfigVersion;
    std::int64_t PreviousConfigVersion;
    std::int64_t StartedAtUnixMs;
    std::int64_t CompletedAtUnixMs;
    std::uint8_t HasThemeId;
    std::uint8_t HasPreviousThemeId;
    std::uint8_t HasAssetVersion;
    std::uint8_t HasPreviousAssetVersion;
    std::uint8_t HasConfigVersion;
    std::uint8_t HasPreviousConfigVersion;
    std::uint8_t HasMode;
    std::uint8_t HasPreviousMode;
    std::uint8_t HasFailureReason;
    std::uint8_t Status;
    std::uint16_t Reserved0;
    Utf8SliceRef Id;
    Utf8SliceRef Scope;
    Utf8SliceRef ThemeId;
    Utf8SliceRef PreviousThemeId;
    Utf8SliceRef AssetVersion;
    Utf8SliceRef PreviousAssetVersion;
    Utf8SliceRef Mode;
    Utf8SliceRef PreviousMode;
    Utf8SliceRef FailureReason;
    Utf8SliceRef ActivatedBy;
};

static_assert(sizeof(ThemeActivationHistoryPod) == 124);
static_assert(offsetof(ThemeActivationHistoryPod, ConfigVersion) == 0);
static_assert(offsetof(ThemeActivationHistoryPod, PreviousConfigVersion) == 8);
static_assert(offsetof(ThemeActivationHistoryPod, StartedAtUnixMs) == 16);
static_assert(offsetof(ThemeActivationHistoryPod, CompletedAtUnixMs) == 24);
static_assert(offsetof(ThemeActivationHistoryPod, HasThemeId) == 32);
static_assert(offsetof(ThemeActivationHistoryPod, HasPreviousThemeId) == 33);
static_assert(offsetof(ThemeActivationHistoryPod, HasAssetVersion) == 34);
static_assert(offsetof(ThemeActivationHistoryPod, HasPreviousAssetVersion) == 35);
static_assert(offsetof(ThemeActivationHistoryPod, HasConfigVersion) == 36);
static_assert(offsetof(ThemeActivationHistoryPod, HasPreviousConfigVersion) == 37);
static_assert(offsetof(ThemeActivationHistoryPod, HasMode) == 38);
static_assert(offsetof(ThemeActivationHistoryPod, HasPreviousMode) == 39);
static_assert(offsetof(ThemeActivationHistoryPod, HasFailureReason) == 40);
static_assert(offsetof(ThemeActivationHistoryPod, Status) == 41);
static_assert(offsetof(ThemeActivationHistoryPod, Reserved0) == 42);
static_assert(offsetof(ThemeActivationHistoryPod, Id) == 44);
static_assert(offsetof(ThemeActivationHistoryPod, Scope) == 52);
static_assert(offsetof(ThemeActivationHistoryPod, ThemeId) == 60);
static_assert(offsetof(ThemeActivationHistoryPod, PreviousThemeId) == 68);
static_assert(offsetof(ThemeActivationHistoryPod, AssetVersion) == 76);
static_assert(offsetof(ThemeActivationHistoryPod, PreviousAssetVersion) == 84);
static_assert(offsetof(ThemeActivationHistoryPod, Mode) == 92);
static_assert(offsetof(ThemeActivationHistoryPod, PreviousMode) == 100);
static_assert(offsetof(ThemeActivationHistoryPod, FailureReason) == 108);
static_assert(offsetof(ThemeActivationHistoryPod, ActivatedBy) == 116);

#pragma pack(pop)

// Borrowed slices only: no allocation or ownership of the caller's payload.
struct PayloadView
{
    const std::uint8_t* Records;
    const std::uint8_t* Children;
    const std::uint8_t* Blob;
    std::size_t Count;
    std::size_t BlobLength;
};

inline std::uint32_t ReadU32(const std::uint8_t* p)
{
    return std::uint32_t(p[0]) | (std::uint32_t(p[1]) << 8u) | (std::uint32_t(p[2]) << 16u)
           | (std::uint32_t(p[3]) << 24u);
}

inline std::int32_t ReadI32(const std::uint8_t* p)
{
    const std::uint32_t bits = ReadU32(p);
    std::int32_t value;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
}

inline std::int64_t ReadI64(const std::uint8_t* p)
{
    const std::uint64_t bits = std::uint64_t(ReadU32(p)) | (std::uint64_t(ReadU32(p + 4)) << 32u);
    std::int64_t value;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
}

inline bool Timestamp(const std::uint8_t* p)
{
    const auto value = ReadI64(p);
    return value >= -62135596800000LL && value <= 253402300799999LL;
}

inline bool Utf8(const std::uint8_t* p, std::size_t length)
{
    std::size_t index = 0;
    while (index < length)
    {
        const auto first = p[index++];
        if (first < 0x80u)
        {
            continue;
        }
        const std::size_t remaining = first >= 0xc2u && first <= 0xdfu   ? 1
                                      : first >= 0xe0u && first <= 0xefu ? 2
                                      : first >= 0xf0u && first <= 0xf4u ? 3
                                                                         : 0;
        if (remaining == 0 || remaining > length - index)
        {
            return false;
        }
        const auto second = p[index];
        if ((first == 0xe0u && second < 0xa0u) || (first == 0xedu && second >= 0xa0u)
            || (first == 0xf0u && second < 0x90u) || (first == 0xf4u && second >= 0x90u))
        {
            return false;
        }
        for (std::size_t count = 0; count < remaining; ++count)
        {
            if ((p[index++] & 0xc0u) != 0x80u)
            {
                return false;
            }
        }
    }
    return true;
}

class BlobCursor
{
public:
    explicit BlobCursor(const PayloadView& view)
        : _blob(view.Blob)
        , _length(view.BlobLength)
    {
    }

    bool Text(const std::uint8_t* reference, std::size_t maximum, bool allowEmpty = false, bool guid = false)
    {
        const auto offset = ReadI32(reference);
        const auto length = ReadI32(reference + 4);
        if (offset < 0 || std::size_t(offset) != _cursor || length < 0 || std::size_t(length) > maximum
            || std::size_t(length) > _length - _cursor || (!allowEmpty && length == 0)
            || !Utf8(_blob + _cursor, std::size_t(length)))
        {
            return false;
        }
        if (guid)
        {
            if (length != 36)
            {
                return false;
            }
            for (std::size_t index = 0; index < 36; ++index)
            {
                const auto c = _blob[_cursor + index];
                const bool dash = index == 8 || index == 13 || index == 18 || index == 23;
                if (dash ? c != '-' : !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
                {
                    return false;
                }
            }
        }
        _cursor += std::size_t(length);
        return true;
    }

    bool Optional(std::uint8_t present, const std::uint8_t* reference, std::size_t maximum, bool guid = false)
    {
        return present == 0 ? ReadI32(reference) == 0 && ReadI32(reference + 4) == 0
                            : present == 1 && Text(reference, maximum, true, guid);
    }

    bool Finished() const
    {
        return _cursor == _length;
    }

private:
    const std::uint8_t* _blob;
    std::size_t _length;
    std::size_t _cursor = 0;
};

inline bool Flags(const std::uint8_t* p, std::size_t count)
{
    for (std::size_t index = 0; index < count; ++index)
    {
        if (p[index] > 1)
        {
            return false;
        }
    }
    return true;
}

inline bool FontSummary(const std::uint8_t* p, BlobCursor& blob, bool detail)
{
    const auto count = ReadI32(p + 24);
    const auto critical = ReadI32(p + 28);
    return Timestamp(p) && Timestamp(p + 8) && ReadI64(p + 16) >= 0 && count >= 0 && count <= 32 && critical >= 0
           && critical <= count && Flags(p + 32, 2) && p[34] == 1 && p[35] == 0 && blob.Text(p + 36, 256)
           && blob.Text(p + 44, 4096) && blob.Text(p + 52, 16384) && blob.Text(p + 60, 256) && blob.Text(p + 68, 256)
           && (!detail
               || (blob.Text(p + 76, 2097152, true) && blob.Text(p + 84, 2097152, true)
                   && blob.Text(p + 92, 2097152, true)));
}

inline bool ThemeSummary(const std::uint8_t* p, BlobCursor& blob, bool detail)
{
    const std::size_t flag = detail ? 56 : 16;
    const std::size_t text = detail ? 68 : 20;
    if (!Timestamp(p) || !Timestamp(p + 8) || p[flag] > 1 || p[flag + 1] < 1 || p[flag + 1] > 8)
    {
        return false;
    }
    if (detail)
    {
        if (ReadI64(p + 16) < 0 || ReadI64(p + 24) < 0 || ReadI64(p + 32) < 0 || ReadI32(p + 40) < 0
            || ReadI32(p + 44) < 0 || ReadI32(p + 48) < 0 || ReadI32(p + 52) < 0 || !Flags(p + 58, 9) || p[67] != 0)
        {
            return false;
        }
    }
    else if (p[18] != 0 || p[19] != 0)
    {
        return false;
    }
    return blob.Text(p + text, 256) && blob.Text(p + text + 8, 4096) && blob.Text(p + text + 16, 256)
           && blob.Text(p + text + 24, 4096) && blob.Text(p + text + 32, 4096, true) && blob.Text(p + text + 40, 256)
           && blob.Text(p + text + 48, 256) && blob.Text(p + text + 56, 4096)
           && (!detail || (blob.Text(p + 132, 2097152, true) && blob.Text(p + 140, 2097152, true)));
}

inline bool Activation(const std::uint8_t* p, BlobCursor& blob)
{
    return Flags(p + 16, 6) && p[22] == 0 && p[23] == 0 && (p[20] == 0 ? ReadI64(p) == 0 : ReadI64(p) >= 0)
           && (p[21] == 0 ? ReadI64(p + 8) == 0 : Timestamp(p + 8)) && blob.Text(p + 24, 256)
           && blob.Optional(p[16], p + 32, 256) && blob.Optional(p[17], p + 40, 256)
           && blob.Optional(p[18], p + 48, 256, true) && blob.Optional(p[19], p + 56, 256);
}

inline bool History(const std::uint8_t* p, BlobCursor& blob)
{
    return Flags(p + 32, 9) && p[41] >= 1 && p[41] <= 4 && p[42] == 0 && p[43] == 0
           && (p[36] == 0 ? ReadI64(p) == 0 : ReadI64(p) >= 0)
           && (p[37] == 0 ? ReadI64(p + 8) == 0 : ReadI64(p + 8) >= 0) && Timestamp(p + 16) && Timestamp(p + 24)
           && blob.Text(p + 44, 256, false, true) && blob.Text(p + 52, 256) && blob.Optional(p[32], p + 60, 256)
           && blob.Optional(p[33], p + 68, 256) && blob.Optional(p[34], p + 76, 256)
           && blob.Optional(p[35], p + 84, 256) && blob.Optional(p[38], p + 92, 256)
           && blob.Optional(p[39], p + 100, 256) && blob.Optional(p[40], p + 108, 4096) && blob.Text(p + 116, 1024);
}

inline bool IsFontThemeFrame(std::uint16_t frame)
{
    using FsusBlog::Aeds::FrameType;
    switch (static_cast<FrameType>(frame))
    {
        case FrameType::FontRegistryList:
        case FrameType::FontRegistryDetail:
        case FrameType::FontActivationList:
        case FrameType::ThemeRegistryList:
        case FrameType::ThemeRegistryDetail:
        case FrameType::ThemeActivationList:
        case FrameType::ThemeActivation:
        case FrameType::ThemeActivationHistory:
            return true;
        default:
            return false;
    }
}

inline bool ParsePayload(std::uint16_t frame, const std::uint8_t* payload, std::size_t length, PayloadView* result)
{
    using FsusBlog::Aeds::FrameType;
    const auto type = static_cast<FrameType>(frame);
    if (!IsFontThemeFrame(frame) || payload == nullptr || length < 20 || length - 16 > 0x7fffffffu
        || ReadI32(payload) != 1 || ReadI32(payload + 8) != std::int32_t(length - 16) || ReadI32(payload + 12) != 0)
    {
        return false;
    }
    const auto signedCount = ReadI32(payload + 4);
    const std::size_t maximum = type == FrameType::FontRegistryDetail       ? 32
                                : type == FrameType::ThemeRegistryDetail    ? 2
                                : type == FrameType::FontActivationList     ? 256
                                : type == FrameType::ThemeActivationHistory ? 50
                                : type == FrameType::ThemeActivation        ? 1
                                                                            : 1024;
    if (signedCount < 0 || std::size_t(signedCount) > maximum
        || (type == FrameType::ThemeActivation && signedCount != 1))
    {
        return false;
    }
    const auto count = std::size_t(signedCount);
    const std::size_t detailSize = type == FrameType::FontRegistryDetail    ? 100
                                   : type == FrameType::ThemeRegistryDetail ? 148
                                                                            : 0;
    const std::size_t recordSize = type == FrameType::FontRegistryList         ? 76
                                   : type == FrameType::FontRegistryDetail     ? 56
                                   : type == FrameType::ThemeRegistryList      ? 84
                                   : type == FrameType::ThemeRegistryDetail    ? 8
                                   : type == FrameType::ThemeActivationHistory ? 124
                                                                               : 64;
    const std::size_t fixedLength = detailSize + count * recordSize;
    if (fixedLength > length - 20)
    {
        return false;
    }
    const auto blobLength = ReadI32(payload + 16 + fixedLength);
    if (blobLength < 0 || blobLength > 7 * 1024 * 1024 || std::size_t(blobLength) != length - 20 - fixedLength)
    {
        return false;
    }
    const PayloadView view{
        payload + 16, payload + 16 + detailSize, payload + 20 + fixedLength, count, std::size_t(blobLength)};
    BlobCursor blob(view);
    if (type == FrameType::FontRegistryDetail
        && (!FontSummary(view.Records, blob, true) || ReadI32(view.Records + 24) != signedCount))
    {
        return false;
    }
    if (type == FrameType::ThemeRegistryDetail && !ThemeSummary(view.Records, blob, true))
    {
        return false;
    }
    std::size_t critical = 0;
    unsigned modes = 0;
    for (std::size_t index = 0; index < count; ++index)
    {
        const auto* p = view.Children + index * recordSize;
        switch (type)
        {
            case FrameType::FontRegistryList:
                if (!FontSummary(p, blob, false))
                {
                    return false;
                }
                break;
            case FrameType::FontRegistryDetail:
                if (ReadI64(p) < 0 || ReadI32(p + 8) <= 0 || !Flags(p + 12, 2) || p[14] != 0 || p[15] != 0
                    || !blob.Text(p + 16, 256) || !blob.Text(p + 24, 4096) || !blob.Text(p + 32, 256)
                    || !blob.Optional(p[13], p + 40, 4096) || !blob.Text(p + 48, 256))
                {
                    return false;
                }
                critical += p[12];
                break;
            case FrameType::FontActivationList:
                if (ReadI64(p) < 0 || !Timestamp(p + 8))
                {
                    return false;
                }
                for (std::size_t field = 16; field < 64; field += 8)
                {
                    if (!blob.Text(p + field, 256))
                    {
                        return false;
                    }
                }
                break;
            case FrameType::ThemeRegistryList:
                if (!ThemeSummary(p, blob, false))
                {
                    return false;
                }
                break;
            case FrameType::ThemeRegistryDetail:
                {
                    if (!blob.Text(p, 256))
                    {
                        return false;
                    }
                    const auto* text = view.Blob + ReadI32(p);
                    const auto size = ReadI32(p + 4);
                    const unsigned mode = size == 5 && std::memcmp(text, "light", 5) == 0  ? 1
                                          : size == 4 && std::memcmp(text, "dark", 4) == 0 ? 2
                                                                                           : 0;
                    if (mode == 0 || (modes & mode) != 0)
                    {
                        return false;
                    }
                    modes |= mode;
                    break;
                }
            case FrameType::ThemeActivationList:
            case FrameType::ThemeActivation:
                if (!Activation(p, blob))
                {
                    return false;
                }
                break;
            case FrameType::ThemeActivationHistory:
                if (!History(p, blob))
                {
                    return false;
                }
                break;
            default:
                return false;
        }
    }
    if (!blob.Finished()
        || (type == FrameType::FontRegistryDetail && critical != std::size_t(ReadI32(view.Records + 28))))
    {
        return false;
    }
    if (result != nullptr)
    {
        *result = view;
    }
    return true;
}

} // namespace FsusBlog::Pod::FontTheme
