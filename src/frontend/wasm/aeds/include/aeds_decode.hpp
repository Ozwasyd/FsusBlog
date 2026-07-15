#pragma once

#include <cstddef>
#include <cstdint>

namespace fsusblog::aeds {

enum class ErrorCode : std::uint8_t {
  None = 0,
  InvalidInput = 1,
  MagicMismatch = 2,
  PayloadLengthMismatch = 3,
  VersionMismatch = 4,
  HeaderLengthMismatch = 5,
  PayloadCrcMismatch = 6,
  ArticlePayloadInvalid = 7,
  FrameTypeUnsupported = 8
};

struct DecodeResult {
  bool ok;
  std::uint16_t frame_type;
  const std::uint8_t* payload_ptr;
  std::uint32_t payload_len;
  ErrorCode error_code;
  const char* error;
};

const char* to_error_string(ErrorCode error_code);
DecodeResult decode_frame(const std::uint8_t* frame, std::size_t frame_len);

} // namespace fsusblog::aeds
