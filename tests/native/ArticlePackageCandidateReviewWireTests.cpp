#include <cstdint>
#include <iostream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "aeds_crc32.hpp"
#include "aeds_decode.hpp"
#include "article_package_candidate_review_wire.hpp"

namespace
{

using namespace FsusBlog::Aeds::ArticlePackageCandidateReviewWire;

const std::string Request = R"json({"requestId":"wire-read","archiveBytes":"AQ==","requestedMode":"CreateNew","callerPolicyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","callerPermissionContextDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","createdAtUtc":"2026-10-09T01:02:03Z","expiresAtUtc":"2026-10-10T01:02:03Z","requestedTargets":null,"pageIndex":0,"pageSize":50,"expectedPlanDigest":null,"expectedContext":null})json";
const std::string Response = R"json({"requestId":"wire-read","review":{"candidateStatus":"finite_bytes_validated","summary":{"articleCount":1,"fileCount":3,"schemaVersion":1,"canonicalHashVersion":1,"propertySchemaVersion":1,"packageBytesDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","manifestSemanticDigest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","checksumComponentDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"requestedMode":"CreateNew","policyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","createdAtUtc":"2026-10-09T01:02:03.0000000Z","expiresAtUtc":"2026-10-10T01:02:03.0000000Z","intervalStatus":"caller_interval_current","planDigest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","pageIndex":0,"pageSize":50,"totalTargets":1,"targets":[{"portableArticle":"article:11111111-1111-1111-1111-111111111111","requiresNewIdentity":true,"requestedTargetArticleId":null,"expectedTargetRevision":null}],"requiredAuthorities":["archive_intake","complete_package_schema","canonical_source_and_property_provenance","fsusui_syntax_dependencies","persisted_relation_and_embed_plan","frozen_public_projection_retention","asset_and_dependency_resolution","rights_responsibility_taxonomy_privacy","current_actor_site_target_permissions","current_target_revision_and_identity","execution_qualification"],"executeDisabled":true,"executionReasonCode":"article_package_import_authority_unavailable"},"context":{"identity":"fsus-site:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","lifecycleVersion":1,"generation":2,"mappingRevision":7,"scopeRevision":3}})json";

bool RequestValid(const std::string& value)
{
    return ValidateRequestPayload(reinterpret_cast<const std::uint8_t*>(value.data()), value.size());
}

bool ResponseValid(const std::string& value)
{
    return ValidateResponsePayload(reinterpret_cast<const std::uint8_t*>(value.data()), value.size());
}

std::string Replace(std::string value, std::string_view from, std::string_view to)
{
    const auto start = value.find(from);
    if (start == std::string::npos)
    {
        return "";
    }
    value.replace(start, from.size(), to);
    return value;
}

void Write16(std::vector<std::uint8_t>& frame, std::size_t offset, std::uint16_t value)
{
    frame[offset] = static_cast<std::uint8_t>(value);
    frame[offset + 1] = static_cast<std::uint8_t>(value >> 8u);
}

std::vector<std::uint8_t> Frame(std::uint16_t type, const std::string& payload)
{
    std::vector<std::uint8_t> frame(FsusBlog::Aeds::kHeaderSize + payload.size());
    frame[0] = 'A';
    frame[1] = 'E';
    frame[2] = 'D';
    frame[3] = 'S';
    frame[4] = 2;
    frame[5] = 16;
    Write16(frame, 8, type);
    const auto length = static_cast<std::uint32_t>(payload.size());
    for (unsigned index = 0; index < 4; ++index)
    {
        frame[10 + index] = static_cast<std::uint8_t>(length >> (index * 8u));
    }
    std::copy(payload.begin(), payload.end(), frame.begin() + 16);
    Write16(frame, 14, FsusBlog::Aeds::ComputeCrc16(frame.data() + 16, payload.size()));
    return frame;
}

bool Check(bool valid, unsigned control)
{
    if (!valid)
    {
        std::cerr << "article_package_candidate_review_control_failed:" << control << '\n';
    }
    return valid;
}

} // namespace

int main()
{
    unsigned control = 0;
    bool passed = Check(RequestValid(Request) && ResponseValid(Response), ++control);
    passed = Check(ReservedRequestFrame == 288 && ReservedResponseFrame == 289, ++control) && passed;
    for (const auto& [type, payload] : std::vector<std::pair<std::uint16_t, std::string>>{{288, Request}, {289, Response}})
    {
        const auto frame = Frame(type, payload);
        const auto decoded = FsusBlog::Aeds::DecodeFrame(frame.data(), frame.size());
        // This branch prepares an inactive pair. Current central DecodeFrame must still refuse it.
        passed = Check(!decoded.ok && decoded.error_code == FsusBlog::Aeds::ErrorCode::FrameTypeUnsupported, ++control) && passed;
    }
    for (std::string_view value : { "null", "\"50\"", "0", "51", "1.0", "1e0", "9007199254740993", "true", "-0" })
    {
        passed = Check(!RequestValid(Replace(Request, "\"pageSize\":50", "\"pageSize\":" + std::string(value))), ++control) && passed;
    }
    for (const auto& [from, to] : std::vector<std::pair<std::string, std::string>>{
        {"\"pageSize\":50", "\"pageSize\":50,\"pageSize\":50"}, {"\"pageSize\":50", "\"pageSize\":50,\"page\\u0053ize\":50"},
        {"\"pageSize\":50,", ""}, {"\"archiveBytes\":\"AQ==\"", "\"archiveBytes\":\"AR==\""},
        {"\"requestedMode\":\"CreateNew\"", "\"requestedMode\":\"Execute\""},
        {"2026-10-09T01:02:03Z", "2026-02-30T01:02:03Z"}, {"2026-10-09T01:02:03Z", "2026-10-09T24:00:00Z"},
        {"2026-10-09T01:02:03Z", "2026-10-09T01:02:03+00:00"}, {"wire-read", "\\ud800"},
        {"wire-read", "\\u0085"}, {"\"requestId\":", "\"adminSession\":\"private-canary\",\"requestId\":"}})
    {
        passed = Check(!RequestValid(Replace(Request, from, to)), ++control) && passed;
    }
    for (std::string_view member : {
        "\"requestId\":\"wire-read\"", "\"candidateStatus\":\"finite_bytes_validated\"", "\"articleCount\":1",
        "\"portableArticle\":\"article:11111111-1111-1111-1111-111111111111\"", "\"generation\":2" })
    {
        passed = Check(!ResponseValid(Replace(Response, member, std::string(member) + ',' + std::string(member))), ++control) && passed;
        passed = Check(!ResponseValid(Replace(Response, member, std::string(member) + ",\"privateSource\":\"private-canary\"")), ++control) && passed;
        const auto colon = member.find(':');
        passed = Check(!ResponseValid(Replace(Response, member, std::string(member.substr(0, colon + 1)) + "null")), ++control) && passed;
    }
    for (const auto& [from, to] : std::vector<std::pair<std::string, std::string>>{
        {"\"executeDisabled\":true", "\"executeDisabled\":false"}, {"execution_qualification", "execution_granted"},
        {"\"totalTargets\":1", "\"totalTargets\":2"}, {"\"scopeRevision\":3", "\"scopeRevision\":8"},
        {"\"generation\":2", "\"generation\":\"2\""}, {"\"schemaVersion\":1", "\"schemaVersion\":2"}})
    {
        passed = Check(!ResponseValid(Replace(Response, from, to)), ++control) && passed;
    }
    std::string update = Replace(Request, "\"requestedMode\":\"CreateNew\"", "\"requestedMode\":\"UpdateRequested\"");
    const std::string target = R"json([{"portableArticle":"article:11111111-1111-1111-1111-111111111111","requestedTargetArticleId":73,"expectedTargetRevision":"9223372036854775807"}])json";
    update = Replace(update, "\"requestedTargets\":null", "\"requestedTargets\":" + target);
    std::string updateResponse = Replace(Response, "\"requestedMode\":\"CreateNew\"", "\"requestedMode\":\"UpdateRequested\"");
    updateResponse = Replace(updateResponse, "\"requiresNewIdentity\":true", "\"requiresNewIdentity\":false");
    updateResponse = Replace(updateResponse, "\"requestedTargetArticleId\":null", "\"requestedTargetArticleId\":73");
    updateResponse = Replace(updateResponse, "\"expectedTargetRevision\":null", "\"expectedTargetRevision\":\"9223372036854775807\"");
    passed = Check(RequestValid(update) && ResponseValid(updateResponse), ++control) && passed;
    for (std::string_view revision : { "0", "01", "+1", "-1", "1.0", "9223372036854775808" })
    {
        passed = Check(!RequestValid(Replace(update, "9223372036854775807", revision))
            && !ResponseValid(Replace(updateResponse, "9223372036854775807", revision)), ++control) && passed;
    }
    std::string boundary = Request;
    boundary.resize(1048576 - 16, ' ');
    passed = Check(RequestValid(boundary), ++control) && passed;
    boundary.push_back(' ');
    passed = Check(!RequestValid(boundary), ++control) && passed;
    const std::string utf16Pair = "\\ud83d\\ude00";
    std::string identifier;
    for (unsigned index = 0; index < 64; ++index)
    {
        identifier += utf16Pair;
    }
    passed = Check(RequestValid(Replace(Request, "wire-read", identifier)), ++control) && passed;
    passed = Check(!RequestValid(Replace(Request, "wire-read", identifier + utf16Pair)), ++control) && passed;
    std::string maxZip(699048, 'A');
    maxZip += "AAA=";
    passed = Check(RequestValid(Replace(Request, "AQ==", maxZip)), ++control) && passed;
    passed = Check(!RequestValid(Replace(Request, "AQ==", std::string(699052, 'A'))), ++control) && passed;
    passed = Check(!RequestValid(std::string(1, static_cast<char>(0xff))), ++control) && passed;
    std::cout << "article_package_candidate_review_controls:" << control << '\n';
    return passed ? 0 : 1;
}
