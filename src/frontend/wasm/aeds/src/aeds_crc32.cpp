#include "aeds_crc32.hpp"

#include <array>

namespace fsusblog::aeds {

namespace {

constexpr std::uint16_t make_crc16_entry(std::uint16_t index) {
  std::uint16_t value = index;
  for (int bit = 0; bit < 8; ++bit) {
    value = static_cast<std::uint16_t>((value & 1u) != 0u ? ((value >> 1u) ^ 0xA001u) : (value >> 1u));
  }
  return value;
}

constexpr std::array<std::uint16_t, 256> make_crc16_table() {
  std::array<std::uint16_t, 256> table{};
  for (std::size_t i = 0; i < table.size(); ++i) {
    table[i] = make_crc16_entry(static_cast<std::uint16_t>(i));
  }
  return table;
}

constexpr auto kCrc16Table = make_crc16_table();

} // namespace

std::uint16_t compute_crc16(const std::uint8_t* data, std::size_t len) {
  std::uint16_t crc = 0xFFFFu;
  for (std::size_t i = 0; i < len; ++i) {
    crc = static_cast<std::uint16_t>((crc >> 8u) ^ kCrc16Table[(crc ^ data[i]) & 0xFFu]);
  }

  return crc;
}

} // namespace fsusblog::aeds
