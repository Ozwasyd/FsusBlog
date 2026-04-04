#pragma once

#include <cstddef>
#include <cstdint>

namespace fsusblog::aeds {

std::uint32_t compute_crc32(const std::uint8_t* data, std::size_t len);

} // namespace fsusblog::aeds
