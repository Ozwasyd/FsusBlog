#include <cstdint>
#include <fstream>
#include <iostream>
#include <vector>

#include "aeds_decode.hpp"

// Ordinary independent wire inputs only; no HTTP, database or file-observation receipt.
int main(int argc, char** argv)
{
    if (argc != 3)
        return 2;
    std::ifstream input(argv[1], std::ios::binary);
    const auto read32 = [&]()
    {
        std::uint8_t bytes[4]{};
        input.read(reinterpret_cast<char*>(bytes), 4);
        return static_cast<std::uint32_t>(bytes[0]) | (static_cast<std::uint32_t>(bytes[1]) << 8u)
               | (static_cast<std::uint32_t>(bytes[2]) << 16u) | (static_cast<std::uint32_t>(bytes[3]) << 24u);
    };
    const auto count = read32();
    if (count == 0 || count != std::stoul(argv[2]))
        return 4;
    for (std::uint32_t i = 0; i < count; ++i)
    {
        const auto length = read32(), expected = read32();
        if (length < 16 || length > 1024)
            return 3;
        std::vector<std::uint8_t> frame(length);
        input.read(reinterpret_cast<char*>(frame.data()), length);
        if (!input)
            return 3;
        const auto result = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
        if (static_cast<unsigned>(result.error_code) != expected || result.ok != (expected == 0))
        {
            std::cerr << "case " << i << " expected " << expected << " actual " << static_cast<unsigned>(result.error_code) << '\n';
            return 5;
        }
        if (result.ok && (result.payload_ptr != frame.data() + 16 || result.frame_type != 285 || result.payload_len != 760))
            return 6;
    }
    if (input.peek() != std::char_traits<char>::eof())
        return 3;
    std::cout << "verified_cases=" << count << '\n';
}
