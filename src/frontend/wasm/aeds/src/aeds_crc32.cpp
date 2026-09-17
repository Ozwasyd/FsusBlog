#include "aeds_crc32.hpp"

#include <array>

namespace FsusBlog::Aeds
{

namespace
{

constexpr std::uint16_t MakeCrc16Entry(std::uint16_t index)
{
    std::uint32_t value = index;
    for (int bit = 0; bit < 8; ++bit)
    {
        value = (value & 1U) != 0U ? ((value >> 1U) ^ 0xA001U) : (value >> 1U);
    }
    return static_cast<std::uint16_t>(value);
}

constexpr std::array<std::uint16_t, 256> MakeCrc16Table()
{
    std::array<std::uint16_t, 256> table{};
    for (std::size_t i = 0; i < table.size(); ++i)
    {
        table[i] = MakeCrc16Entry(static_cast<std::uint16_t>(i));
    }
    return table;
}

constexpr auto KCrc16Table = MakeCrc16Table();

#if defined(FSUSBLOG_AEDS_SPEED_TIER)
const std::array<std::uint16_t, 65536>& Crc16PairTable()
{
    static std::array<std::uint16_t, 65536> s_table{};
    static bool s_initialized = false;
    if (!s_initialized)
    {
        for (std::size_t value = 0; value < s_table.size(); ++value)
        {
            const std::uint32_t First = KCrc16Table[value & 0xFFU];
            s_table[value] = static_cast<std::uint16_t>(
                (First >> 8U) ^ KCrc16Table[(First ^ (static_cast<std::uint32_t>(value) >> 8U)) & 0xFFU]);
        }
        s_initialized = true;
    }
    return s_table;
}
#endif

} // namespace

std::uint16_t ComputeCrc16(const std::uint8_t* data, std::size_t len)
{
    std::uint16_t crc = 0xFFFFu;
#if defined(FSUSBLOG_AEDS_SPEED_TIER)
    const auto& pairTable = Crc16PairTable();
    std::size_t i = 0;
    for (; i + 1u < len; i += 2u)
    {
        const std::uint16_t Word = static_cast<std::uint16_t>(static_cast<std::uint32_t>(data[i])
                                                              | (static_cast<std::uint32_t>(data[i + 1U]) << 8U));
        crc = pairTable[static_cast<std::uint32_t>(crc) ^ static_cast<std::uint32_t>(Word)];
    }
    if (i < len)
    {
        const std::uint32_t CrcValue = crc;
        const std::uint32_t ByteValue = data[i];
        crc = static_cast<std::uint16_t>((CrcValue >> 8U) ^ KCrc16Table[(CrcValue ^ ByteValue) & 0xFFU]);
    }
#else
    for (std::size_t i = 0; i < len; ++i)
    {
        const std::uint32_t CrcValue = crc;
        const std::uint32_t ByteValue = data[i];
        crc = static_cast<std::uint16_t>((CrcValue >> 8U) ^ KCrc16Table[(CrcValue ^ ByteValue) & 0xFFU]);
    }
#endif

    return crc;
}

} // namespace FsusBlog::Aeds
