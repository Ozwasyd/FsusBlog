#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <string_view>
#include <vector>

#include "aeds_crc32.hpp"
#include "aeds_decode.hpp"
#include "aeds_frame.hpp"

namespace
{

void write_u16_le(std::uint8_t* output, std::uint16_t value)
{
    output[0] = static_cast<std::uint8_t>(value & 0xffU);
    output[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
}

void write_u32_le(std::uint8_t* output, std::uint32_t value)
{
    output[0] = static_cast<std::uint8_t>(value & 0xffU);
    output[1] = static_cast<std::uint8_t>((value >> 8U) & 0xffU);
    output[2] = static_cast<std::uint8_t>((value >> 16U) & 0xffU);
    output[3] = static_cast<std::uint8_t>((value >> 24U) & 0xffU);
}

std::vector<std::uint8_t> empty_frame(std::uint16_t frame_type)
{
    std::vector<std::uint8_t> frame(FsusBlog::Aeds::kHeaderSize, 0U);
    write_u32_le(frame.data(), FsusBlog::Aeds::kMagic);
    frame[4] = FsusBlog::Aeds::kVersion;
    frame[5] = static_cast<std::uint8_t>(FsusBlog::Aeds::kHeaderSize);
    write_u16_le(frame.data() + 8U, frame_type);
    write_u16_le(frame.data() + 14U, FsusBlog::Aeds::ComputeCrc16(nullptr, 0U));
    return frame;
}

bool parse_u16(std::string_view text, std::uint16_t& output)
{
    unsigned int value = 0U;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || value > 0xffffU)
    {
        return false;
    }
    output = static_cast<std::uint16_t>(value);
    return true;
}

bool parse_hex(std::string_view hex, std::vector<std::uint8_t>& output)
{
    if ((hex.size() % 2U) != 0U)
    {
        return false;
    }
    output.clear();
    output.reserve(hex.size() / 2U);
    for (std::size_t index = 0; index < hex.size(); index += 2U)
    {
        unsigned int value = 0U;
        const auto parsed = std::from_chars(hex.data() + index, hex.data() + index + 2U, value, 16);
        if (parsed.ec != std::errc{} || parsed.ptr != hex.data() + index + 2U)
        {
            return false;
        }
        output.push_back(static_cast<std::uint8_t>(value));
    }
    return true;
}

} // namespace

int main(int argc, char** argv)
{
    if (argc >= 3 && std::string_view(argv[1]) == "all")
    {
        for (int index = 2; index < argc; ++index)
        {
            std::uint16_t frame_type = 0U;
            if (!parse_u16(argv[index], frame_type))
            {
                return 10;
            }
            const std::vector<std::uint8_t> frame = empty_frame(frame_type);
            const FsusBlog::Aeds::DecodeResult decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
            if (frame_type == static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::ArticleDetail))
            {
                if (decoded.error_code != FsusBlog::Aeds::ErrorCode::ArticlePayloadInvalid)
                {
                    return 11;
                }
            }
            else if (!decoded.ok || decoded.frame_type != frame_type || decoded.payload_len != 0U)
            {
                return 12;
            }
        }
        return 0;
    }

    if (argc >= 3 && std::string_view(argv[1]) == "retired")
    {
        for (int index = 2; index < argc; ++index)
        {
            std::uint16_t frame_type = 0U;
            if (!parse_u16(argv[index], frame_type))
            {
                return 13;
            }
            const std::vector<std::uint8_t> frame = empty_frame(frame_type);
            const FsusBlog::Aeds::DecodeResult decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
            if (decoded.error_code != FsusBlog::Aeds::ErrorCode::FrameTypeRetired)
            {
                return 14;
            }
        }
        return 0;
    }

    if (argc >= 3 && std::string_view(argv[1]) == "reject")
    {
        for (int index = 2; index < argc; ++index)
        {
            std::uint16_t frame_type = 0U;
            if (!parse_u16(argv[index], frame_type))
            {
                return 15;
            }
            const std::vector<std::uint8_t> frame = empty_frame(frame_type);
            const FsusBlog::Aeds::DecodeResult decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
            if (decoded.error_code != FsusBlog::Aeds::ErrorCode::FrameTypeUnsupported)
            {
                return 16;
            }
        }
        return 0;
    }

    if (argc == 5 && std::string_view(argv[1]) == "decode")
    {
        std::vector<std::uint8_t> frame;
        std::vector<std::uint8_t> expected_payload;
        std::uint16_t expected_type = 0U;
        if (!parse_hex(argv[2], frame) || !parse_u16(argv[3], expected_type) || !parse_hex(argv[4], expected_payload))
        {
            return 20;
        }
        const FsusBlog::Aeds::DecodeResult decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
        if (!decoded.ok || decoded.frame_type != expected_type || decoded.payload_len != expected_payload.size())
        {
            return 21;
        }
        for (std::size_t index = 0; index < expected_payload.size(); ++index)
        {
            if (decoded.payload_ptr[index] != expected_payload[index])
            {
                return 22;
            }
        }
        return 0;
    }

    return 2;
}
