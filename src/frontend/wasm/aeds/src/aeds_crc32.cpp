#include "aeds_crc32.hpp"

namespace fsusblog::aeds {

std::uint16_t compute_crc16(const std::uint8_t* data, std::size_t len) {
  std::uint16_t crc = 0xFFFFu;
  for (std::size_t i = 0; i < len; ++i) {
    crc ^= static_cast<std::uint16_t>(data[i]);
    for (int j = 0; j < 8; ++j) {
      crc = static_cast<std::uint16_t>((crc & 1u) != 0u ? ((crc >> 1u) ^ 0xA001u) : (crc >> 1u));
    }
  }

  return crc;
}

} // namespace fsusblog::aeds
