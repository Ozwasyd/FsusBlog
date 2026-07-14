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

#if defined(FSUSBLOG_AEDS_SPEED_TIER)
const std::array<std::uint16_t, 65536>& crc16_pair_table() {
  static std::array<std::uint16_t, 65536> table{};
  static bool initialized = false;
  if (!initialized) {
    for (std::size_t value = 0; value < table.size(); ++value) {
      const std::uint16_t first = kCrc16Table[value & 0xFFu];
      table[value] = static_cast<std::uint16_t>(
        (first >> 8u) ^ kCrc16Table[(first ^ (value >> 8u)) & 0xFFu]);
    }
    initialized = true;
  }
  return table;
}
#endif

} // namespace

std::uint16_t compute_crc16(const std::uint8_t* data, std::size_t len) {
  std::uint16_t crc = 0xFFFFu;
#if defined(FSUSBLOG_AEDS_SPEED_TIER)
  const auto& pair_table = crc16_pair_table();
  std::size_t i = 0;
  for (; i + 1u < len; i += 2u) {
    const std::uint16_t word = static_cast<std::uint16_t>(data[i])
      | static_cast<std::uint16_t>(static_cast<std::uint16_t>(data[i + 1u]) << 8u);
    crc = pair_table[crc ^ word];
  }
  if (i < len) {
    crc = static_cast<std::uint16_t>((crc >> 8u) ^ kCrc16Table[(crc ^ data[i]) & 0xFFu]);
  }
#else
  for (std::size_t i = 0; i < len; ++i) {
    crc = static_cast<std::uint16_t>((crc >> 8u) ^ kCrc16Table[(crc ^ data[i]) & 0xFFu]);
  }
#endif

  return crc;
}

} // namespace fsusblog::aeds
