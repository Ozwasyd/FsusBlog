#include "aeds_decode.hpp"
#include "aeds_crc32.hpp"
#include "article_canvas_link_wire.generated.hpp"
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

int main()
{
    unsigned frame;
    unsigned expected;
    std::string hex;
    unsigned cases = 0;
    while (std::cin >> frame >> expected >> hex)
    {
        std::vector<std::uint8_t> payload;
        for (std::size_t index = 0; index < hex.size(); index += 2)
            payload.push_back(static_cast<std::uint8_t>(std::stoul(hex.substr(index, 2), nullptr, 16)));
        bool valid = FsusBlog::Aeds::ValidateArticleCanvasLinkPayload(static_cast<std::uint16_t>(frame), payload.data(), payload.size());
        if (valid != (expected != 0)) return 1;
        std::vector<std::uint8_t> bytes{0x41, 0x45, 0x44, 0x53, 2, 16, 0, 0,
            static_cast<std::uint8_t>(frame), static_cast<std::uint8_t>(frame >> 8)};
        for (unsigned index = 0; index < 4; index++) bytes.push_back(static_cast<std::uint8_t>(payload.size() >> (index * 8)));
        auto crc = FsusBlog::Aeds::ComputeCrc16(payload.data(), payload.size());
        bytes.push_back(static_cast<std::uint8_t>(crc)); bytes.push_back(static_cast<std::uint8_t>(crc >> 8));
        bytes.insert(bytes.end(), payload.begin(), payload.end());
        const auto decoded = FsusBlog::Aeds::DecodeFrame(bytes.data(), bytes.size());
        if (decoded.ok != valid || (!valid && decoded.error_code != FsusBlog::Aeds::ErrorCode::ArticleCanvasLinkPayloadInvalid)) return 2;
        cases++;
    }
    std::cout << "ArticleCanvasLink production native decoder " << cases << " cases PASS\n";
}
