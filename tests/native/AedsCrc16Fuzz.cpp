#include <cstddef>
#include <cstdint>

#include "aeds_crc32.hpp"

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size)
{
    static_cast<void>(FsusBlog::Aeds::ComputeCrc16(data, size));
    return 0;
}
