#include <cstdint>
#include <cstring>
#include <type_traits>
#include <vector>

#include "aeds_crc32.hpp"
#include "aeds_frame.hpp"
#include "src/frontend/wasm/aeds/src/exports.cpp"

namespace
{

static_assert(std::is_same_v<decltype(&reserve_io_buffer), std::uint64_t (*)(int)>);
static_assert(std::is_same_v<decltype(&get_io_buffer_ptr), std::uintptr_t (*)(std::uint64_t)>);
static_assert(std::is_same_v<decltype(&decode_io_buffer), int (*)(std::uint64_t, int)>);
static_assert(std::is_same_v<decltype(&get_last_payload_token), std::uint64_t (*)()>);
static_assert(std::is_same_v<decltype(&get_last_payload_ptr), std::uintptr_t (*)(std::uint64_t)>);
static_assert(std::is_same_v<decltype(&get_last_payload_len), std::uint32_t (*)(std::uint64_t)>);
static_assert(std::is_same_v<decltype(&get_last_frame_type), std::uint16_t (*)(std::uint64_t)>);
static_assert(std::is_same_v<decltype(&render_view), int (*)(std::uint64_t)>);

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

std::vector<std::uint8_t> valid_frame()
{
    constexpr std::uint16_t frame_type = static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::MutationId);
    const std::vector<std::uint8_t> payload{1U, 2U, 3U, 4U, 5U};
    std::vector<std::uint8_t> frame(FsusBlog::Aeds::kHeaderSize + payload.size(), 0U);
    write_u32_le(frame.data(), FsusBlog::Aeds::kMagic);
    frame[4] = FsusBlog::Aeds::kVersion;
    frame[5] = static_cast<std::uint8_t>(FsusBlog::Aeds::kHeaderSize);
    write_u16_le(frame.data() + 8U, frame_type);
    write_u32_le(frame.data() + 10U, static_cast<std::uint32_t>(payload.size()));
    write_u16_le(frame.data() + 14U, FsusBlog::Aeds::ComputeCrc16(payload.data(), payload.size()));
    std::memcpy(frame.data() + FsusBlog::Aeds::kHeaderSize, payload.data(), payload.size());
    return frame;
}

} // namespace

int main()
{
    const std::vector<std::uint8_t> frame = valid_frame();
    const std::uint64_t input_token = reserve_io_buffer(static_cast<int>(frame.size()));
    if (input_token == 0U)
        return 10;
    const std::uintptr_t input_address = get_io_buffer_ptr(input_token);
    if (input_address == 0U || input_address != reinterpret_cast<std::uintptr_t>(t_ioArena.data()))
        return 11;
    std::memcpy(reinterpret_cast<void*>(input_address), frame.data(), frame.size());

    if (decode_io_buffer(input_token, static_cast<int>(frame.size())) != 1)
        return 12;
    if (get_io_buffer_ptr(input_token) != 0U)
        return 13;

    const std::uint64_t payload_token = get_last_payload_token();
    if (payload_token == 0U)
        return 14;
    const std::uintptr_t payload_address = get_last_payload_ptr(payload_token);
    if (payload_address == 0U || get_last_payload_len(payload_token) != 5U)
        return 15;
    if (get_last_frame_type(payload_token) != static_cast<std::uint16_t>(FsusBlog::Aeds::FrameType::MutationId))
        return 16;
    if (render_view(payload_token) != 1)
        return 24;

    const std::uint64_t next_input_token = reserve_io_buffer(static_cast<int>(frame.size() + 4096U));
    if (next_input_token == 0U || next_input_token == input_token || next_input_token == payload_token)
        return 17;
    if (get_last_payload_ptr(payload_token) != 0U || get_last_payload_len(payload_token) != 0U
        || get_last_frame_type(payload_token) != 0U)
        return 18;
    if (render_view(payload_token) != 0)
        return 25;
    if (get_io_buffer_ptr(input_token) != 0U || get_io_buffer_ptr(next_input_token) == 0U)
        return 19;

    if (decode_io_buffer(input_token, static_cast<int>(frame.size())) != 0)
        return 20;
    if (get_io_buffer_ptr(next_input_token) != 0U)
        return 21;

    const std::uint64_t final_token = reserve_io_buffer(static_cast<int>(frame.size()));
    if (final_token == 0U || get_io_buffer_ptr(final_token) == 0U)
        return 22;
    clear_io_buffer(1);
    if (get_io_buffer_ptr(final_token) != 0U || get_last_payload_token() != 0U)
        return 23;
    return 0;
}
