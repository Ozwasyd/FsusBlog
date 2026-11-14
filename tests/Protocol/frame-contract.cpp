#include "aeds-frame.hpp"
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

using namespace fsus::wire;

int main(int argc, char** argv) {
    if (argc != 3) return EXIT_FAILURE;

    const char* expected_payload_prefix[] = {"0503000093010000", "000000000000000000000000"};
    const FrameType expected_types[] = {FrameType::ApiError, FrameType::ArticleCommand};
    for (int index = 0; index < 2; ++index) {
        std::ifstream file(argv[index + 1]);
        std::string hex;
        if (!(file >> hex) || hex.size() % 2 != 0) return EXIT_FAILURE;
        std::vector<std::uint8_t> bytes;
        for (std::size_t offset = 0; offset < hex.size(); offset += 2) {
            bytes.push_back(static_cast<std::uint8_t>(std::stoi(hex.substr(offset, 2), nullptr, 16)));
        }

        const auto type = validate(bytes.data(), bytes.size());
        const std::string prefix = expected_payload_prefix[index];
        if (type != static_cast<std::uint16_t>(expected_types[index]) || hex.substr(2 * header::HeaderSize, prefix.size()) != prefix)
            return EXIT_FAILURE;
        bytes.back() ^= 1;
        if (validate(bytes.data(), bytes.size())) return EXIT_FAILURE;
    }
}
