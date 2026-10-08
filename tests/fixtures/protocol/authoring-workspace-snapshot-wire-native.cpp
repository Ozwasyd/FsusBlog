#include "authoring_workspace_snapshot_wire.generated.hpp"

#include "aeds_crc32.hpp"
#include "aeds_decode.hpp"

#include <charconv>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

static int HexDigit(char value)
{
    if (value >= '0' && value <= '9')
    {
        return value - '0';
    }
    if (value >= 'a' && value <= 'f')
    {
        return value - 'a' + 10;
    }
    return -1;
}

int main(int argc, char** argv)
{
    if (argc != 3)
    {
        return 2;
    }
    unsigned expectedCount = 0;
    const char* countEnd = argv[2] + std::strlen(argv[2]);
    const auto parsedCount = std::from_chars(argv[2], countEnd, expectedCount);
    if (parsedCount.ec != std::errc() || parsedCount.ptr != countEnd || expectedCount == 0)
    {
        return 2;
    }
    std::ifstream cases(argv[1]);
    if (!cases)
    {
        return 2;
    }
    std::string line;
    unsigned checked = 0;
    while (std::getline(cases, line))
    {
        std::istringstream row(line);
        bool expected;
        unsigned frameType;
        std::string name;
        std::string hex;
        std::string extra;
        if (!(row >> expected >> frameType >> name >> hex) || row >> extra || hex.size() % 2 != 0 || (frameType != 270 && frameType != 271))
        {
            return 2;
        }
        std::vector<std::uint8_t> bytes;
        for (std::size_t index = 0; index < hex.size(); index += 2)
        {
            const int high = HexDigit(hex[index]);
            const int low = HexDigit(hex[index + 1]);
            if (high < 0 || low < 0)
            {
                return 2;
            }
            bytes.push_back(static_cast<std::uint8_t>(high * 16 + low));
        }
        bool actual = FsusBlog::Aeds::ValidateAuthoringWorkspaceSnapshotPayload(frameType, bytes.data(), bytes.size());
        if (actual != expected)
        {
            std::cerr << "mismatch " << name << '\n';
            return 1;
        }
        if (FsusBlog::Aeds::ValidateAuthoringWorkspaceSnapshotPayload(269, bytes.data(), bytes.size()))
        {
            return 3;
        }
        // Independently frame each witness, then exercise the actual public native dispatcher.
        std::vector<std::uint8_t> frame{0x41, 0x45, 0x44, 0x53, 2, 16, 0, 0, static_cast<std::uint8_t>(frameType), static_cast<std::uint8_t>(frameType >> 8)};
        for (unsigned shift = 0; shift < 32; shift += 8)
        {
            frame.push_back(static_cast<std::uint8_t>(bytes.size() >> shift));
        }
        const auto crc = FsusBlog::Aeds::ComputeCrc16(bytes.data(), bytes.size());
        frame.push_back(static_cast<std::uint8_t>(crc));
        frame.push_back(static_cast<std::uint8_t>(crc >> 8));
        frame.insert(frame.end(), bytes.begin(), bytes.end());
        const auto decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
        if (decoded.ok != expected || (!expected
            && decoded.error_code != FsusBlog::Aeds::ErrorCode::AuthoringWorkspaceSnapshotPayloadInvalid))
        {
            return 5;
        }
        if (expected && (decoded.frame_type != frameType || decoded.payload_ptr != frame.data() + 16
            || decoded.payload_len != bytes.size()))
        {
            return 6;
        }
        ++checked;
    }
    if (checked != expectedCount)
    {
        return 4;
    }
    std::cout << "native golden cases=" << checked << " all matched; unknown frame refused; production dispatcher/error14 matched\n";
    return 0;
}
