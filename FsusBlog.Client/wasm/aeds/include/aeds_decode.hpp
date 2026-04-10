#pragma once

#include <cstddef>
#include <cstdint>

namespace fsusblog::aeds {

struct DecodeResult {
  bool ok;
  std::uint16_t frame_type;
  const std::uint8_t* payload_ptr;
  std::uint32_t payload_len;
  const char* error;
};

DecodeResult decode_frame(const std::uint8_t* frame, std::size_t frame_len);

} // namespace fsusblog::aeds
