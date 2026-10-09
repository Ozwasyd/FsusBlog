#pragma once

#include <cstddef>
#include <cstdint>

namespace FsusBlog::Aeds
{

enum class ErrorCode : std::uint8_t
{
    None = 0,
    InvalidInput = 1,
    MagicMismatch = 2,
    PayloadLengthMismatch = 3,
    VersionMismatch = 4,
    HeaderLengthMismatch = 5,
    PayloadCrcMismatch = 6,
    ArticlePayloadInvalid = 7,
    FrameTypeUnsupported = 8,
    FrameTypeRetired = 9,
    DocumentExportPayloadInvalid = 18,
    DocumentExportSourceOptionsPayloadInvalid = 19,
    FontThemePayloadInvalid = 10
};

struct DecodeResult
{
    bool ok;
    std::uint16_t frame_type;
    const std::uint8_t* payload_ptr;
    std::uint32_t payload_len;
    ErrorCode error_code;
    const char* error;
};

const char* ToErrorString(ErrorCode errorCode);

/**
 * Decodes one complete AEDS v2 frame without retaining the caller-owned bytes.
 *
 * The payload pointer is a borrowed view into `frame` and remains valid only
 * while the caller keeps that input buffer alive and unchanged.
 */
DecodeResult DecodeFrame(const std::uint8_t* frame, std::size_t frameLen);

} // namespace FsusBlog::Aeds
