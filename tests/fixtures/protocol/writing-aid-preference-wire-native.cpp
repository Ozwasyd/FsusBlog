#include "aeds_decode.hpp"
#include "writing_aid_preference_wire.generated.hpp"

#include <charconv>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

static int HexDigit(char value)
{
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
}

int main(int argc, char** argv)
{
    if (argc != 3) return 2;
    unsigned expectedCount = 0;
    const char* end = argv[2] + std::strlen(argv[2]);
    auto count = std::from_chars(argv[2], end, expectedCount);
    if (count.ec != std::errc() || count.ptr != end || expectedCount == 0) return 2;
    std::ifstream input(argv[1]);
    if (!input) return 2;
    unsigned checked = 0;
    std::string line;
    while (std::getline(input, line))
    {
        std::istringstream row(line);
        unsigned expectedError;
        std::string hex;
        std::string extra;
        if (!(row >> expectedError >> hex) || row >> extra || expectedError > 18 || (hex != "-" && hex.size() % 2 != 0)) return 2;
        std::vector<std::uint8_t> bytes;
        if (hex != "-") for (std::size_t i = 0; i < hex.size(); i += 2)
        {
            int first = HexDigit(hex[i]);
            int second = HexDigit(hex[i + 1]);
            if (first < 0 || second < 0) return 2;
            bytes.push_back(static_cast<std::uint8_t>((first << 4) | second));
        }
        auto decoded = FsusBlog::Aeds::DecodeFrame(bytes.data(), bytes.size());
        if (static_cast<unsigned>(decoded.error_code) != expectedError || decoded.ok != (expectedError == 0))
        {
            std::cerr << "case=" << checked << " error=" << static_cast<unsigned>(decoded.error_code) << " expected=" << expectedError << '\n';
            return 3;
        }
        if (expectedError == 0 && (decoded.payload_ptr != bytes.data() + 16 || decoded.payload_len != bytes.size() - 16)) return 3;
        if (expectedError != 0 && (decoded.payload_ptr != nullptr || decoded.payload_len != 0)) return 3;
        if (expectedError == 15 && (decoded.error == nullptr || std::string(decoded.error) != "writing_aid_preference_payload_invalid"
            || std::string(FsusBlog::Aeds::ToErrorString(FsusBlog::Aeds::ErrorCode::WritingAidPreferencePayloadInvalid)) != "writing_aid_preference_payload_invalid")) return 3;
        if (expectedError == 16 && (decoded.error == nullptr || std::string(decoded.error) != "upload_asset_preview_payload_invalid")) return 3;
        if (expectedError == 17 && (decoded.error == nullptr || std::string(decoded.error) != "author_article_selection_payload_invalid")) return 3;
        if (expectedError == 18 && (decoded.frame_type != 0 || decoded.error == nullptr
            || std::string(decoded.error) != "document_export_payload_invalid"
            || std::string(FsusBlog::Aeds::ToErrorString(FsusBlog::Aeds::ErrorCode::DocumentExportPayloadInvalid)) != "document_export_payload_invalid")) return 3;
        ++checked;
    }
    if (checked != expectedCount) return 4;
    std::cout << "production dispatcher=" << checked << " cases, error15 and borrowed views verified\n";
    return 0;
}
