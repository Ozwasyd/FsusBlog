#include <array>
#include <cstdint>

#include "aeds_crc32.hpp"

namespace
{

constexpr std::array<std::uint8_t, 9> CheckInput{static_cast<std::uint8_t>('1'),
                                                 static_cast<std::uint8_t>('2'),
                                                 static_cast<std::uint8_t>('3'),
                                                 static_cast<std::uint8_t>('4'),
                                                 static_cast<std::uint8_t>('5'),
                                                 static_cast<std::uint8_t>('6'),
                                                 static_cast<std::uint8_t>('7'),
                                                 static_cast<std::uint8_t>('8'),
                                                 static_cast<std::uint8_t>('9')};

} // namespace

int main()
{
    constexpr std::uint16_t ExpectedCrc16 = 0x4B37U;
    const std::uint16_t ActualCrc16 = FsusBlog::Aeds::ComputeCrc16(CheckInput.data(), CheckInput.size());
    return ActualCrc16 == ExpectedCrc16 ? 0 : 1;
}
