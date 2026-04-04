#include "aeds_crc32.hpp"

namespace fsusblog::aeds {

std::uint32_t compute_crc32(const std::uint8_t* data, std::size_t len) {
  std::uint32_t crc = 0xFFFFFFFFu;
  for (std::size_t i = 0; i < len; ++i) {
    crc ^= static_cast<std::uint32_t>(data[i]);
    for (int j = 0; j < 8; ++j) {
      const std::uint32_t mask = static_cast<std::uint32_t>(-(static_cast<std::int32_t>(crc & 1u)));
      crc = (crc >> 1u) ^ (0xEDB88320u & mask);
    }
  }

  return ~crc;
}

} // namespace fsusblog::aeds
