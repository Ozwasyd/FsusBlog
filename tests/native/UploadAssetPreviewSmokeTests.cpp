#include <cassert>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <vector>

#include "aeds_crc32.hpp"
#include "aeds_decode.hpp"
#include "upload_asset_preview_pod.hpp"

// Input is the real C# endpoint result produced with PostgreSQL and original upload/native file owners.
int main(int argc, char** argv)
{
    assert(argc == 2);
    std::ifstream input(argv[1], std::ios::binary);
    std::vector<std::uint8_t> frame((std::istreambuf_iterator<char>(input)), {});
    const auto original = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
    assert(original.ok && original.frame_type == 253 && original.payload_len > 760);
    constexpr std::size_t offsets[] = {0, 100, 128, 192, 448, 544, 548, 555, 560, 624, 688, 755, 756};
    constexpr std::uint8_t values[] = {1, 65, 70, 104, 65, 0, 1, 128, 71, 71, 71, 255, 1};
    for (std::size_t i = 0; i < 13; ++i)
    {
        auto changed = frame;
        changed[16 + offsets[i]] = values[i];
        auto crc = FsusBlog::Aeds::ComputeCrc16(changed.data() + 16, changed.size() - 16);
        changed[14] = static_cast<std::uint8_t>(crc);
        changed[15] = static_cast<std::uint8_t>(crc >> 8u);
        const auto rejected = FsusBlog::Aeds::DecodeFrame(changed.data(), changed.size());
        assert(!rejected.ok && rejected.error_code == FsusBlog::Aeds::ErrorCode::UploadAssetPreviewInvalid);
    }
    assert(!FsusBlog::Pod::UploadPreview::Parse(frame.data() + 16, original.payload_len - 1));
    frame.push_back(0);
    assert(!FsusBlog::Pod::UploadPreview::Parse(frame.data() + 16, original.payload_len + 1));
    assert(!FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size()).ok);
}
