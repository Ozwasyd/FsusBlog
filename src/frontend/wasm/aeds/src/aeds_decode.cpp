#include "aeds_decode.hpp"

#include "aeds_crc32.hpp"
#include "aeds_frame.hpp"
#include "font_theme_admin_pods.hpp"
#include "pod_views.hpp"

namespace FsusBlog::Aeds
{

namespace
{

std::uint16_t ReadU16Le(const std::uint8_t* data)
{
    return static_cast<std::uint16_t>(data[0]) | static_cast<std::uint16_t>(static_cast<std::uint16_t>(data[1]) << 8u);
}

std::uint32_t ReadU32Le(const std::uint8_t* data)
{
    return static_cast<std::uint32_t>(data[0]) | (static_cast<std::uint32_t>(data[1]) << 8u)
           | (static_cast<std::uint32_t>(data[2]) << 16u) | (static_cast<std::uint32_t>(data[3]) << 24u);
}

DecodeResult MakeError(ErrorCode errorCode)
{
    DecodeResult result{};
    result.ok = false;
    result.frame_type = static_cast<std::uint16_t>(FrameType::Unknown);
    result.payload_ptr = nullptr;
    result.payload_len = 0;
    result.error_code = errorCode;
    result.error = ToErrorString(errorCode);
    return result;
}

} // namespace

const char* ToErrorString(ErrorCode errorCode)
{
    switch (errorCode)
    {
        case ErrorCode::None:
            return "";
        case ErrorCode::InvalidInput:
            return "frame_too_short";
        case ErrorCode::MagicMismatch:
            return "magic_mismatch";
        case ErrorCode::PayloadLengthMismatch:
            return "payload_length_mismatch";
        case ErrorCode::VersionMismatch:
            return "version_mismatch";
        case ErrorCode::HeaderLengthMismatch:
            return "header_length_mismatch";
        case ErrorCode::PayloadCrcMismatch:
            return "payload_crc_mismatch";
        case ErrorCode::ArticlePayloadInvalid:
            return "article_payload_invalid";
        case ErrorCode::FrameTypeUnsupported:
            return "frame_type_unsupported";
        case ErrorCode::FrameTypeRetired:
            return "frame_type_retired";
        case ErrorCode::FontThemePayloadInvalid:
            return "font_theme_payload_invalid";
        default:
            return "decode_failed";
    }
}

DecodeResult DecodeFrame(const std::uint8_t* frame, std::size_t frameLen)
{
    if (frame == nullptr || frameLen < kHeaderSize)
    {
        return MakeError(ErrorCode::InvalidInput);
    }

    const std::uint32_t Magic = ReadU32Le(frame);
    const std::uint8_t Version = frame[4];
    const std::uint8_t HeaderLength = frame[5];
    const std::uint16_t FrameType = ReadU16Le(frame + 8);
    const std::uint32_t PayloadLength = ReadU32Le(frame + 10);
    const std::uint16_t PayloadCrc16 = ReadU16Le(frame + 14);

    if (Magic != kMagic)
    {
        return MakeError(ErrorCode::MagicMismatch);
    }

    if (Version != kVersion)
    {
        return MakeError(ErrorCode::VersionMismatch);
    }

    if (HeaderLength != kHeaderSize)
    {
        return MakeError(ErrorCode::HeaderLengthMismatch);
    }

    if (frameLen != static_cast<std::size_t>(PayloadLength) + kHeaderSize)
    {
        return MakeError(ErrorCode::PayloadLengthMismatch);
    }

    if (IsRetiredFrameType(FrameType))
    {
        return MakeError(ErrorCode::FrameTypeRetired);
    }

    if (!IsKnownFrameType(FrameType))
    {
        return MakeError(ErrorCode::FrameTypeUnsupported);
    }

    const std::uint8_t* payload = frame + kHeaderSize;
    const std::uint16_t PayloadCrc = ComputeCrc16(payload, PayloadLength);
    if (PayloadCrc != PayloadCrc16)
    {
        return MakeError(ErrorCode::PayloadCrcMismatch);
    }

    if (FrameType == static_cast<std::uint16_t>(FrameType::ArticleDetail))
    {
        FsusBlog::Pod::ParsedArticleDetail parsed{};
        if (!FsusBlog::Pod::ParseArticleDetailPayload(payload, PayloadLength, &parsed))
        {
            return MakeError(ErrorCode::ArticlePayloadInvalid);
        }
    }

    if (FsusBlog::Pod::FontTheme::IsFontThemeFrame(FrameType)
        && !FsusBlog::Pod::FontTheme::ParsePayload(FrameType, payload, PayloadLength, nullptr))
    {
        return MakeError(ErrorCode::FontThemePayloadInvalid);
    }

    DecodeResult ok{};
    ok.ok = true;
    ok.frame_type = FrameType;
    ok.payload_ptr = payload;
    ok.payload_len = PayloadLength;
    ok.error_code = ErrorCode::None;
    ok.error = nullptr;
    return ok;
}

} // namespace FsusBlog::Aeds
