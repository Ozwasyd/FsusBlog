#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

#include "aeds_crc32.hpp"
#include "aeds_decode.hpp"
#include "aeds_frame.hpp"
#include "font_theme_admin_pods.hpp"
#include "property_value_read.generated.hpp"

namespace
{

void write_u16_le(std::uint8_t* output, std::uint16_t value)
{
    output[0] = static_cast<std::uint8_t>(value & 0xffU);
    output[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}

void write_u32_le(std::uint8_t* output, std::uint32_t value)
{
    output[0] = static_cast<std::uint8_t>(value & 0xffU);
    output[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
    output[2] = static_cast<std::uint8_t>((value >> 16U) & 0xffU);
    output[3] = static_cast<std::uint8_t>((value >> 24U) & 0xffU);
}

std::vector<std::uint8_t> empty_frame(std::uint16_t frame_type)
{
    std::vector<std::uint8_t> frame(FsusBlog::Aeds::kHeaderSize, 0U);
    write_u32_le(frame.data(), FsusBlog::Aeds::kMagic);
    frame[4] = FsusBlog::Aeds::kVersion;
    frame[5] = static_cast<std::uint8_t>(FsusBlog::Aeds::kHeaderSize);
    write_u16_le(frame.data() + 8U, frame_type);
    write_u16_le(frame.data() + 14U, FsusBlog::Aeds::ComputeCrc16(nullptr, 0U));
    return frame;
}

std::vector<std::uint8_t> PayloadFrame(std::uint16_t type, const std::vector<std::uint8_t>& payload)
{
    auto frame = empty_frame(type);
    frame.insert(frame.end(), payload.begin(), payload.end());
    write_u32_le(frame.data() + 10, static_cast<std::uint32_t>(payload.size()));
    write_u16_le(frame.data() + 14, FsusBlog::Aeds::ComputeCrc16(payload.data(), payload.size()));
    return frame;
}

// Actual wire fixture construction, independent of the production parser.
std::vector<std::uint8_t> FontThemePayload(std::uint16_t frameType)
{
    using FsusBlog::Aeds::FrameType;
    const auto type = static_cast<FrameType>(frameType);
    const bool fontDetail = type == FrameType::FontRegistryDetail;
    const bool themeDetail = type == FrameType::ThemeRegistryDetail;
    const bool fontSummary = type == FrameType::FontRegistryList || fontDetail;
    const bool themeSummary = type == FrameType::ThemeRegistryList || themeDetail;
    const std::size_t mainSize = fontSummary ? (fontDetail ? 100 : 76)
        : themeSummary ? (themeDetail ? 148 : 84)
        : type == FrameType::ThemeActivationHistory ? 124 : 64;
    const std::size_t childSize = fontDetail ? 56 : themeDetail ? 8 : 0;
    std::vector<std::uint8_t> records(mainSize + childSize, 0);
    std::vector<std::uint8_t> blob;
    const auto text = [&](std::size_t offset, std::string_view value)
    {
        write_u32_le(records.data() + offset, static_cast<std::uint32_t>(blob.size()));
        write_u32_le(records.data() + offset + 4, static_cast<std::uint32_t>(value.size()));
        blob.insert(blob.end(), value.begin(), value.end());
    };
    const auto fullInt64 = [&](std::size_t offset)
    {
        write_u32_le(records.data() + offset, 0xffffffffu);
        write_u32_le(records.data() + offset + 4, 0x7fffffffu);
    };
    if (fontSummary)
    {
        fullInt64(16);
        write_u32_le(records.data() + 24, 1);
        write_u32_le(records.data() + 28, 1);
        records[32] = 1;
        records[34] = 1;
        for (const auto offset : {36, 44, 52, 60, 68})
        {
            text(offset, "x");
        }
        if (fontDetail)
        {
            for (const auto offset : {76, 84, 92})
            {
                text(offset, "");
            }
            fullInt64(100);
            write_u32_le(records.data() + 108, 400);
            records[112] = 1;
            text(116, "normal");
            text(124, "regular.woff2");
            text(132, "sha256:a");
            text(148, "swap");
        }
    }
    else if (themeSummary)
    {
        const std::size_t start = themeDetail ? 68 : 20;
        records[themeDetail ? 57 : 17] = 4;
        if (themeDetail)
        {
            for (const auto offset : {16, 24, 32})
            {
                fullInt64(offset);
            }
        }
        for (std::size_t index = 0; index < 8; ++index)
        {
            text(start + index * 8, index == 4 ? "" : "x");
        }
        if (themeDetail)
        {
            text(132, "{}");
            text(140, "{}");
            text(148, "light");
        }
    }
    else if (type == FrameType::FontActivationList)
    {
        fullInt64(0);
        for (const auto offset : {16, 24, 32, 40, 48, 56})
        {
            text(offset, "x");
        }
    }
    else if (type == FrameType::ThemeActivationHistory)
    {
        fullInt64(0);
        records[36] = 1;
        records[41] = 1;
        text(44, "fedcba98-7654-3210-fedc-ba9876543210");
        text(52, "public");
        text(116, "admin");
    }
    else
    {
        fullInt64(0);
        records[20] = 1;
        text(24, "public");
    }
    std::vector<std::uint8_t> payload(16, 0);
    write_u32_le(payload.data(), 1);
    write_u32_le(payload.data() + 4, 1);
    write_u32_le(payload.data() + 8, static_cast<std::uint32_t>(records.size() + 4 + blob.size()));
    payload.insert(payload.end(), records.begin(), records.end());
    const auto blobLengthOffset = payload.size();
    payload.resize(payload.size() + 4);
    write_u32_le(payload.data() + blobLengthOffset, static_cast<std::uint32_t>(blob.size()));
    payload.insert(payload.end(), blob.begin(), blob.end());
    return payload;
}

bool FontThemeContract(std::uint16_t type)
{
    using FsusBlog::Aeds::FrameType;
    using FsusBlog::Aeds::ErrorCode;
    const auto original = FontThemePayload(type);
    const auto frame = PayloadFrame(type, original);
    const auto decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
    FsusBlog::Pod::FontTheme::PayloadView view{};
    if (!decoded.ok || decoded.frame_type != type || decoded.payload_ptr != frame.data() + FsusBlog::Aeds::kHeaderSize
        || decoded.payload_len != original.size()
        || !FsusBlog::Pod::FontTheme::ParsePayload(type, decoded.payload_ptr, decoded.payload_len, &view)
        || view.Count != 1 || view.Blob < decoded.payload_ptr || view.Blob + view.BlobLength != frame.data() + frame.size())
    {
        return false;
    }
    for (int mutation = 0; mutation < 10; ++mutation)
    {
        auto payload = original;
        if (mutation == 0)
        {
            write_u32_le(payload.data(), 2);
        }
        if (mutation == 1)
        {
            write_u32_le(payload.data() + 4, 0x7fffffffu);
        }
        if (mutation == 2)
        {
            payload[12] = 1;
        }
        if (mutation == 3)
        {
            payload.pop_back();
        }
        if (mutation == 4)
        {
            payload.push_back(0);
        }
        const auto firstRef = type == static_cast<std::uint16_t>(FrameType::FontRegistryList)
            || type == static_cast<std::uint16_t>(FrameType::FontRegistryDetail) ? 36
            : type == static_cast<std::uint16_t>(FrameType::ThemeRegistryList) ? 20
            : type == static_cast<std::uint16_t>(FrameType::ThemeRegistryDetail) ? 68
            : type == static_cast<std::uint16_t>(FrameType::FontActivationList) ? 16
            : type == static_cast<std::uint16_t>(FrameType::ThemeActivationHistory) ? 44 : 24;
        if (mutation == 5)
        {
            write_u32_le(payload.data() + 16 + firstRef, 1);
        }
        if (mutation == 6)
        {
            write_u32_le(payload.data() + 16 + firstRef + 4, 0xffffffffu);
        }
        if (mutation == 7)
        {
            const auto relative = static_cast<std::size_t>(view.Blob - decoded.payload_ptr);
            payload[relative] = 0xff;
        }
        if (mutation == 8)
        {
            const auto timestamp = type == static_cast<std::uint16_t>(FrameType::FontActivationList)
                || type == static_cast<std::uint16_t>(FrameType::ThemeActivationList)
                || type == static_cast<std::uint16_t>(FrameType::ThemeActivation) ? 8
                : type == static_cast<std::uint16_t>(FrameType::ThemeActivationHistory) ? 16 : 0;
            write_u32_le(payload.data() + 16 + timestamp, 0xffffffffu);
            write_u32_le(payload.data() + 16 + timestamp + 4, 0x7fffffffu);
            if (type == static_cast<std::uint16_t>(FrameType::ThemeActivationList)
                || type == static_cast<std::uint16_t>(FrameType::ThemeActivation))
            {
                payload[16 + 21] = 1;
            }
        }
        if (mutation == 9)
        {
            if (type == static_cast<std::uint16_t>(FrameType::FontActivationList))
            {
                payload[16 + 7] = 0x80;
            }
            else
            {
                const auto code = type == static_cast<std::uint16_t>(FrameType::FontRegistryList)
                    || type == static_cast<std::uint16_t>(FrameType::FontRegistryDetail) ? 34
                    : type == static_cast<std::uint16_t>(FrameType::ThemeRegistryList) ? 17
                    : type == static_cast<std::uint16_t>(FrameType::ThemeRegistryDetail) ? 57
                    : type == static_cast<std::uint16_t>(FrameType::ThemeActivationHistory) ? 41 : 20;
                payload[16 + code] = 99;
            }
        }
        const auto malformed = PayloadFrame(type, payload);
        if (FsusBlog::Aeds::DecodeFrame(malformed.data(), malformed.size()).error_code != ErrorCode::FontThemePayloadInvalid)
        {
            return false;
        }
    }
    auto mismatch = PayloadFrame(static_cast<std::uint16_t>(FrameType::ThemeActivation), original);
    if (type == static_cast<std::uint16_t>(FrameType::ThemeActivation)
        || type == static_cast<std::uint16_t>(FrameType::ThemeActivationList))
    {
        mismatch = PayloadFrame(static_cast<std::uint16_t>(FrameType::FontRegistryList), original);
    }
    return FsusBlog::Aeds::DecodeFrame(mismatch.data(), mismatch.size()).error_code == ErrorCode::FontThemePayloadInvalid;
}

bool parse_u16(std::string_view text, std::uint16_t& output)
{
    unsigned int value = 0U;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || value > 0xffffU)
    {
        return false;
    }
    output = static_cast<std::uint16_t>(value);
    return true;
}

bool parse_hex(std::string_view hex, std::vector<std::uint8_t>& output)
{
    if ((hex.size() % 2U) != 0U)
    {
        return false;
    }
    output.clear();
    output.reserve(hex.size() / 2U);
    for (std::size_t index = 0; index < hex.size(); index += 2U)
    {
        unsigned int value = 0U;
        const auto parsed = std::from_chars(hex.data() + index, hex.data() + index + 2U, value, 16);
        if (parsed.ec != std::errc{} || parsed.ptr != hex.data() + index + 2U)
        {
            return false;
        }
        output.push_back(static_cast<std::uint8_t>(value));
    }
    return true;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc == 2 && std::string_view(argv[1]) == "canvas-payloads")
    {
        unsigned int frame_type = 0U;
        unsigned int expected_valid = 0U;
        std::string hex;
        unsigned int count = 0U;
        while (std::cin >> frame_type >> expected_valid >> hex)
        {
            if (frame_type < 253U || frame_type > 265U || expected_valid > 1U)
            {
                return 30;
            }
            std::vector<std::uint8_t> payload;
            if (!parse_hex(hex, payload))
            {
                return 31;
            }
            std::vector<std::uint8_t> frame = empty_frame(static_cast<std::uint16_t>(frame_type));
            frame.insert(frame.end(), payload.begin(), payload.end());
            write_u32_le(frame.data() + 10U, static_cast<std::uint32_t>(payload.size()));
            write_u16_le(frame.data() + 14U, FsusBlog::Aeds::ComputeCrc16(payload.data(), payload.size()));
            const FsusBlog::Aeds::DecodeResult decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
            if (decoded.ok != (expected_valid == 1U)
                || (expected_valid == 0U && decoded.error_code != FsusBlog::Aeds::ErrorCode::AuthoringCanvasPayloadInvalid)
                || (expected_valid == 1U && (decoded.frame_type != frame_type || decoded.payload_len != payload.size())))
            {
                std::cerr << "Canvas payload case " << count << " failed\n";
                return 32;
            }
            ++count;
        }
        if (count == 0U || !std::cin.eof())
        {
            return 33;
        }
        std::cout << "production C++ Canvas payload cases=" << count << '\n';
        return 0;
    }

    if (argc >= 3 && std::string_view(argv[1]) == "all")
    {
        for (int index = 2; index < argc; ++index)
        {
            std::uint16_t frame_type = 0U;
            if (!parse_u16(argv[index], frame_type))
            {
                return 10;
            }
            const std::vector<std::uint8_t> frame = empty_frame(frame_type);
            const FsusBlog::Aeds::DecodeResult decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
            if (frame_type == static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::ArticleDetail))
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::ArticlePayloadInvalid)
                {
                    return 11;
                }
            }
            else if (FsusBlog::Pod::FontTheme::IsFontThemeFrame(frame_type))
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::FontThemePayloadInvalid || !FontThemeContract(frame_type))
                {
                    return 23;
                }
            }
            else if (frame_type >= 253 && frame_type <= 265)
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::AuthoringCanvasPayloadInvalid)
                {
                    return 15;
                }
            }

            else if (frame_type >= 266 && frame_type <= 268)
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::ArticleCanvasLinkPayloadInvalid)
                {
                    return 16;
                }
            }
            else if (frame_type >= 270 && frame_type <= 271)
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::AuthoringWorkspaceSnapshotPayloadInvalid)
                {
                    std::cerr << "workspace snapshot empty payload accepted for " << frame_type << '\n';
                    return 1;
                }
            }
            else if (FsusBlog::Aeds::IsArticlePropertyPayloadFrame(frame_type))
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::ArticlePropertyValueReadPayloadInvalid)
                {
                    return 17;
                }
            }
            else if (frame_type >= 272 && frame_type <= 274)
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::WritingAidPreferencePayloadInvalid)
                {
                    return 18;
                }
            }
            else if (frame_type == 275)
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::UploadAssetPreviewPayloadInvalid)
                {
                    return 19;
                }
            }
            else if (frame_type == static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::AuthorArticleSelectionRevalidateRequest)
                || frame_type == static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::AuthorArticleSelectionRevalidateResponse))
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::AuthorArticleSelectionPayloadInvalid)
                {
                    return 24;
                }
            }
            else if (frame_type == static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::DocumentExportRequest)
                || frame_type == static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::DocumentExportTaskRequest)
                || frame_type == static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::DocumentExportJobResponse)
                || frame_type == static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::DocumentExportPageResponse))
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::DocumentExportPayloadInvalid)
                {
                    return 25;
                }
            }
            else if (!decoded.ok || decoded.frame_type != frame_type || decoded.payload_len != 0U)
            {
                std::cerr << "unexpected empty-frame result for " << frame_type << " error=" << static_cast<unsigned>(decoded.error_code) << '\n';
                return 12;
            }
        }
        return 0;
    }

    if (argc >= 3 && std::string_view(argv[1]) == "retired")
    {
        for (int index = 2; index < argc; ++index)
        {
            std::uint16_t frame_type = 0U;
            if (!parse_u16(argv[index], frame_type))
            {
                return 13;
            }
            const std::vector<std::uint8_t> frame = empty_frame(frame_type);
            const FsusBlog::Aeds::DecodeResult decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
            if (decoded.error_code != FsusBlog::Aeds::ErrorCode::FrameTypeRetired)
            {
                return 14;
            }
        }
        return 0;
    }

    if (argc >= 3 && std::string_view(argv[1]) == "reject")
    {
        for (int index = 2; index < argc; ++index)
        {
            std::uint16_t frame_type = 0U;
            if (!parse_u16(argv[index], frame_type))
            {
                return 15;
            }
            const std::vector<std::uint8_t> frame = empty_frame(frame_type);
            const FsusBlog::Aeds::DecodeResult decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
            if (decoded.error_code != FsusBlog::Aeds::ErrorCode::FrameTypeUnsupported)
            {
                return 16;
            }
        }
        return 0;
    }

    if (argc == 5 && std::string_view(argv[1]) == "decode")
    {
        std::vector<std::uint8_t> frame;
        std::vector<std::uint8_t> expected_payload;
        std::uint16_t expected_type = 0U;
        if (!parse_hex(argv[2], frame) || !parse_u16(argv[3], expected_type) || !parse_hex(argv[4], expected_payload))
        {
            return 20;
        }
        const FsusBlog::Aeds::DecodeResult decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
        if (!decoded.ok || decoded.frame_type != expected_type || decoded.payload_len != expected_payload.size())
        {
            return 21;
        }
        for (std::size_t index = 0; index < expected_payload.size(); ++index)
        {
            if (decoded.payload_ptr[index] != expected_payload[index])
            {
                return 22;
            }
        }
        return 0;
    }

    return 2;
}
