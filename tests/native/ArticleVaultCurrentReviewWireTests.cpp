#include <article_vault_current_review_wire.hpp>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

static std::vector<std::uint8_t> Literal(const char* path)
{
    std::ifstream file(path); std::string hex; file >> hex;
    if (!file || hex.size() != 6352) throw std::runtime_error("literal size");
    std::vector<std::uint8_t> bytes;
    for (std::size_t i = 0; i < hex.size(); i += 2)
        bytes.push_back(static_cast<std::uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
    return bytes;
}
int main(int argc, char** argv)
{
    if (argc != 3) return 2;
    using namespace FsusBlog::Pod::VaultCurrentReview;
    const auto absent = Literal(argv[1]); const auto present = Literal(argv[2]);
    unsigned checks = 0;
    const auto Check = [&checks](bool pass) { ++checks; if (!pass) throw std::runtime_error("control " + std::to_string(checks)); };
    Check(ParseRequest(absent.data(), absent.size())); Check(ParseRequest(present.data(), present.size()));
    const unsigned offsets[] = {0,4,6,12,16,27,91,96,167,168,232,275,280,284,288,289,310,800,1312,1824,2848,2912,2976,3047,3048,3112};
    const std::uint8_t replacements[] = {0,2,2,1,0,65,1,65,255,65,0,1,2,1,32,192,1,47,92,9,65,65,65,255,65,65};
    for (unsigned i = 0; i < 26; ++i)
    {
        auto bad = present; bad[offsets[i]] = replacements[i]; Check(!ParseRequest(bad.data(), bad.size()));
    }
    auto hidden = absent; hidden[160] = 1; Check(!ParseRequest(hidden.data(), hidden.size()));
    Check(!ParseRequest(nullptr, RequestBytes));
    Check(!ParseRequest(present.data(), present.size() - 1)); Check(!ParseRequest(present.data(), present.size() + 1));
    auto zero = absent; for (unsigned i = 8; i < 12; ++i) zero[i] = 0; Check(!ParseRequest(zero.data(), zero.size()));
    for (const unsigned offset : {160U, 3040U})
    {
        auto unsafe = present; for (unsigned i = 0; i < 8; ++i) unsafe[offset+i] = 0;
        unsafe[offset+6] = 0x20; Check(!ParseRequest(unsafe.data(), unsafe.size()));
    }
    std::cout << "PASS " << checks << " controls\n";
}
