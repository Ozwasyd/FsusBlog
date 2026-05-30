#pragma once

#include <cstddef>
#include <cstdint>

namespace fsusblog::aeds {

std::uint16_t compute_crc16(const std::uint8_t* data, std::size_t len);

} // namespace fsusblog::aeds
