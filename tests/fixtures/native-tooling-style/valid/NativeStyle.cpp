#include <cstdint>

namespace fsusblog::style
{

struct SampleValue
{
    std::uint32_t Count;
};

std::uint32_t ReadCount(const SampleValue& sampleValue)
{
    return sampleValue.Count;
}

} // namespace fsusblog::style
