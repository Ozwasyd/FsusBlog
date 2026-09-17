#pragma once

#include <cstddef>
#include <cstdint>

namespace FsusBlog::Aeds
{

std::uint16_t ComputeCrc16(const std::uint8_t* data, std::size_t len);

} // namespace FsusBlog::Aeds
