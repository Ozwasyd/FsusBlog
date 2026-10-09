#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "aeds_frame.hpp"

namespace FsusBlog::Aeds::ArticlePackageCandidateReviewWire
{

// Allocation only: the sole central owner must admit the pair before DecodeFrame uses it.
inline constexpr std::uint16_t ReservedRequestFrame = 288;
inline constexpr std::uint16_t ReservedResponseFrame = 289;
inline constexpr std::size_t MaxFrameBytes = 1048576;
inline constexpr std::size_t MaxArchiveBytes = 524288;

namespace Detail
{

enum class Kind : std::uint8_t { Null, Boolean, Number, String, Object, Array };

struct Node
{
    Kind kind = Kind::Null;
    bool boolean = false;
    std::uint32_t number = 0;
    std::string text;
    std::vector<std::string> names;
    std::vector<Node> children;
};

inline bool Scalar(std::string_view input, std::size_t& offset, std::uint32_t& scalar)
{
    if (offset >= input.size())
    {
        return false;
    }
    const auto first = static_cast<std::uint8_t>(input[offset++]);
    if (first < 0x80)
    {
        scalar = first;
        return true;
    }
    const unsigned count = first >= 0xc2 && first <= 0xdf ? 1u
        : first >= 0xe0 && first <= 0xef ? 2u : first >= 0xf0 && first <= 0xf4 ? 3u : 0u;
    if (count == 0 || count > input.size() - offset)
    {
        return false;
    }
    scalar = first & (0x7fu >> count);
    for (unsigned index = 0; index < count; ++index)
    {
        const auto next = static_cast<std::uint8_t>(input[offset++]);
        if ((next & 0xc0u) != 0x80u)
        {
            return false;
        }
        scalar = (scalar << 6u) | (next & 0x3fu);
    }
    return scalar >= (count == 1 ? 0x80u : count == 2 ? 0x800u : 0x10000u)
        && scalar <= 0x10ffffu && !(scalar >= 0xd800u && scalar <= 0xdfffu);
}

inline void AppendScalar(std::uint32_t scalar, std::string& value)
{
    if (scalar < 0x80u)
    {
        value.push_back(static_cast<char>(scalar));
    }
    else if (scalar < 0x800u)
    {
        value.push_back(static_cast<char>(0xc0u | (scalar >> 6u)));
        value.push_back(static_cast<char>(0x80u | (scalar & 0x3fu)));
    }
    else if (scalar < 0x10000u)
    {
        value.push_back(static_cast<char>(0xe0u | (scalar >> 12u)));
        value.push_back(static_cast<char>(0x80u | ((scalar >> 6u) & 0x3fu)));
        value.push_back(static_cast<char>(0x80u | (scalar & 0x3fu)));
    }
    else
    {
        value.push_back(static_cast<char>(0xf0u | (scalar >> 18u)));
        value.push_back(static_cast<char>(0x80u | ((scalar >> 12u) & 0x3fu)));
        value.push_back(static_cast<char>(0x80u | ((scalar >> 6u) & 0x3fu)));
        value.push_back(static_cast<char>(0x80u | (scalar & 0x3fu)));
    }
}

/** Confined bounded JSON parser, required because duplicates disappear in ordinary object decoding. */
class Parser
{
public:
    explicit Parser(std::string_view input) : _input(input) {}

    bool Parse(Node& root)
    {
        if (!Value(root, 0))
        {
            return false;
        }
        Space();
        return _offset == _input.size();
    }

private:
    std::string_view _input;
    std::size_t _offset = 0;
    std::size_t _nodes = 0;

    void Space()
    {
        while (_offset < _input.size() && (_input[_offset] == ' ' || _input[_offset] == '\t'
            || _input[_offset] == '\r' || _input[_offset] == '\n'))
        {
            ++_offset;
        }
    }

    bool Take(char expected)
    {
        if (_offset >= _input.size() || _input[_offset] != expected)
        {
            return false;
        }
        ++_offset;
        return true;
    }

    bool HexUnit(std::uint32_t& unit)
    {
        unit = 0;
        for (unsigned index = 0; index < 4; ++index)
        {
            if (_offset >= _input.size())
            {
                return false;
            }
            const char digit = _input[_offset++];
            const unsigned value = digit >= '0' && digit <= '9' ? static_cast<unsigned>(digit - '0')
                : digit >= 'a' && digit <= 'f' ? static_cast<unsigned>(digit - 'a' + 10)
                : digit >= 'A' && digit <= 'F' ? static_cast<unsigned>(digit - 'A' + 10) : 16u;
            if (value > 15u)
            {
                return false;
            }
            unit = (unit << 4u) | value;
        }
        return true;
    }

    bool String(std::string& value)
    {
        if (!Take('"'))
        {
            return false;
        }
        while (_offset < _input.size())
        {
            if (Take('"'))
            {
                return true;
            }
            if (Take('\\'))
            {
                if (_offset >= _input.size())
                {
                    return false;
                }
                const char escaped = _input[_offset++];
                if (escaped == 'u')
                {
                    std::uint32_t scalar = 0;
                    if (!HexUnit(scalar))
                    {
                        return false;
                    }
                    if (scalar >= 0xd800u && scalar <= 0xdfffu)
                    {
                        std::uint32_t low = 0;
                        if (scalar > 0xdbffu || !Take('\\') || !Take('u') || !HexUnit(low) || low < 0xdc00u || low > 0xdfffu)
                        {
                            return false;
                        }
                        scalar = 0x10000u + ((scalar - 0xd800u) << 10u) + low - 0xdc00u;
                    }
                    AppendScalar(scalar, value);
                }
                else
                {
                    switch (escaped)
                    {
                        case '"': case '\\': case '/': value.push_back(escaped); break;
                        case 'b': value.push_back('\b'); break;
                        case 'f': value.push_back('\f'); break;
                        case 'n': value.push_back('\n'); break;
                        case 'r': value.push_back('\r'); break;
                        case 't': value.push_back('\t'); break;
                        default: return false;
                    }
                }
            }
            else
            {
                const std::size_t start = _offset;
                std::uint32_t scalar = 0;
                if (!Scalar(_input, _offset, scalar) || scalar < 32u)
                {
                    return false;
                }
                value.append(_input.substr(start, _offset - start));
            }
        }
        return false;
    }

    bool Value(Node& value, unsigned depth)
    {
        Space();
        if (++_nodes > 20000 || depth > 6 || _offset >= _input.size())
        {
            return false;
        }
        const char first = _input[_offset];
        if (first == '"')
        {
            value.kind = Kind::String;
            return String(value.text);
        }
        if (first == '{' || first == '[')
        {
            const bool object = first == '{';
            value.kind = object ? Kind::Object : Kind::Array;
            ++_offset;
            Space();
            const char end = object ? '}' : ']';
            if (Take(end))
            {
                return true;
            }
            do
            {
                Space();
                if (value.children.size() >= (object ? 15u : 1000u))
                {
                    return false;
                }
                if (object)
                {
                    std::string name;
                    if (!String(name) || std::find(value.names.begin(), value.names.end(), name) != value.names.end())
                    {
                        return false;
                    }
                    Space();
                    if (!Take(':'))
                    {
                        return false;
                    }
                    value.names.push_back(std::move(name));
                }
                value.children.emplace_back();
                if (!Value(value.children.back(), depth + 1))
                {
                    return false;
                }
                Space();
            } while (Take(','));
            return Take(end);
        }
        for (std::string_view literal : { "true", "false", "null" })
        {
            if (_input.substr(_offset, literal.size()) == literal)
            {
                _offset += literal.size();
                value.kind = literal == "null" ? Kind::Null : Kind::Boolean;
                value.boolean = literal == "true";
                return true;
            }
        }
        if (first < '0' || first > '9')
        {
            return false;
        }
        value.kind = Kind::Number;
        do
        {
            const unsigned digit = static_cast<unsigned>(_input[_offset++] - '0');
            if (value.number > (2147483647u - digit) / 10u)
            {
                return false;
            }
            value.number = value.number * 10u + digit;
            if (first == '0')
            {
                break;
            }
        } while (_offset < _input.size() && _input[_offset] >= '0' && _input[_offset] <= '9');
        return true;
    }
};

inline const Node& Member(const Node& object, std::string_view name)
{
    const auto found = std::find(object.names.begin(), object.names.end(), name);
    // Called only after Closed proves every required member is present.
    return object.children[static_cast<std::size_t>(found - object.names.begin())];
}

inline bool Closed(const Node& value, std::initializer_list<std::string_view> names)
{
    return value.kind == Kind::Object && value.names.size() == names.size()
        && std::all_of(names.begin(), names.end(), [&](std::string_view name)
        { return std::find(value.names.begin(), value.names.end(), name) != value.names.end(); });
}

inline bool Integer(const Node& value, std::uint32_t minimum, std::uint32_t maximum)
{
    return value.kind == Kind::Number && value.number >= minimum && value.number <= maximum;
}

inline bool Literal(const Node& value, std::string_view expected)
{
    return value.kind == Kind::String && value.text == expected;
}

inline bool Hex(std::string_view value)
{
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char digit)
    { return (digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f'); });
}

inline bool Digest(const Node& value)
{
    return value.kind == Kind::String && Hex(value.text);
}

inline bool Revision(const Node& value)
{
    return value.kind == Kind::String && !value.text.empty() && value.text.size() <= 19 && value.text[0] >= '1' && value.text[0] <= '9'
        && std::all_of(value.text.begin(), value.text.end(), [](char digit) { return digit >= '0' && digit <= '9'; })
        && (value.text.size() < 19 || value.text <= "9223372036854775807");
}

inline bool Portable(const Node& value)
{
    if (value.kind != Kind::String || value.text.size() != 44 || value.text.substr(0, 8) != "article:")
    {
        return false;
    }
    bool nonzero = false;
    for (std::size_t index = 8; index < 44; ++index)
    {
        const char digit = value.text[index];
        if (index == 16 || index == 21 || index == 26 || index == 31)
        {
            if (digit != '-')
            {
                return false;
            }
        }
        else
        {
            if (!((digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f')))
            {
                return false;
            }
            nonzero = nonzero || digit != '0';
        }
    }
    return nonzero;
}

inline bool RequestId(const Node& value)
{
    if (value.kind != Kind::String || value.text.empty())
    {
        return false;
    }
    std::size_t offset = 0;
    unsigned units = 0;
    bool nonspace = false;
    while (offset < value.text.size())
    {
        std::uint32_t scalar = 0;
        if (!Scalar(value.text, offset, scalar))
        {
            return false;
        }
        units += scalar > 0xffffu ? 2u : 1u;
        const bool space = (scalar >= 9u && scalar <= 13u) || scalar == 32u || scalar == 0x85u || scalar == 0xa0u || scalar == 0x1680u
            || (scalar >= 0x2000u && scalar <= 0x200au) || scalar == 0x2028u || scalar == 0x2029u || scalar == 0x202fu
            || scalar == 0x205fu || scalar == 0x3000u;
        nonspace = nonspace || !space;
    }
    return units <= 128u && nonspace;
}

inline bool Utc(const Node& value, std::string& normalized)
{
    if (value.kind != Kind::String)
    {
        return false;
    }
    const std::string& text = value.text;
    if ((text.size() != 20 && (text.size() < 22 || text.size() > 28 || text[19] != '.')) || text.back() != 'Z')
    {
        return false;
    }
    for (std::size_t index = 0; index < text.size() - 1; ++index)
    {
        const char expected = index == 4 || index == 7 ? '-' : index == 10 ? 'T' : index == 13 || index == 16 ? ':' : index == 19 ? '.' : 0;
        if (expected != 0 ? text[index] != expected : text[index] < '0' || text[index] > '9')
        {
            return false;
        }
    }
    const auto number = [&](std::size_t start, std::size_t length)
    {
        unsigned result = 0;
        for (std::size_t index = start; index < start + length; ++index)
        {
            result = result * 10u + static_cast<unsigned>(text[index] - '0');
        }
        return result;
    };
    const unsigned year = number(0, 4);
    const unsigned month = number(5, 2);
    const unsigned day = number(8, 2);
    const unsigned days[] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (year == 0 || month < 1 || month > 12 || day < 1 || number(11, 2) > 23 || number(14, 2) > 59 || number(17, 2) > 59)
    {
        return false;
    }
    const bool leap = year % 4u == 0 && (year % 100u != 0 || year % 400u == 0);
    if (day > days[month - 1] + (month == 2 && leap ? 1u : 0u))
    {
        return false;
    }
    normalized = text.substr(0, 19) + '.';
    const std::string fraction = text.size() == 20 ? "" : text.substr(20, text.size() - 21);
    normalized += fraction + std::string(7 - fraction.size(), '0') + 'Z';
    return true;
}

inline bool Interval(const Node& value)
{
    std::string created;
    std::string expires;
    return Utc(Member(value, "createdAtUtc"), created) && Utc(Member(value, "expiresAtUtc"), expires) && expires > created;
}

inline bool Context(const Node& value)
{
    if (!Closed(value, { "identity", "lifecycleVersion", "generation", "mappingRevision", "scopeRevision" }))
    {
        return false;
    }
    const Node& identity = Member(value, "identity");
    return identity.kind == Kind::String && identity.text.substr(0, 10) == "fsus-site:" && Hex(std::string_view(identity.text).substr(10))
        && Integer(Member(value, "lifecycleVersion"), 1, 1) && Integer(Member(value, "generation"), 1, 16)
        && Integer(Member(value, "mappingRevision"), 1, 1024) && Integer(Member(value, "scopeRevision"), 1, Member(value, "mappingRevision").number);
}

inline bool Archive(const Node& value)
{
    if (value.kind != Kind::String || value.text.size() < 4 || value.text.size() > 699052 || value.text.size() % 4 != 0)
    {
        return false;
    }
    const std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const std::string& text = value.text;
    const std::size_t padding = text.back() == '=' ? (text[text.size() - 2] == '=' ? 2u : 1u) : 0u;
    for (std::size_t index = 0; index < text.size() - padding; ++index)
    {
        if (alphabet.find(text[index]) == std::string_view::npos)
        {
            return false;
        }
    }
    const std::size_t last = alphabet.find(text[text.size() - padding - 1]);
    const std::size_t bytes = text.size() / 4 * 3 - padding;
    return bytes > 0 && bytes <= MaxArchiveBytes && (padding == 0 || (last & (padding == 2 ? 15u : 3u)) == 0);
}

inline bool Mode(const Node& value)
{
    return Literal(value, "CreateNew") || Literal(value, "UpdateRequested");
}

inline bool Targets(const Node& targets, bool create, bool response)
{
    if (!response && targets.kind == Kind::Null)
    {
        return create;
    }
    if (targets.kind != Kind::Array || targets.children.size() > (response ? 50u : 1000u)
        || (!response && (create ? !targets.children.empty() : targets.children.empty())))
    {
        return false;
    }
    std::vector<std::string> identities;
    std::vector<std::uint32_t> ids;
    for (const Node& target : targets.children)
    {
        if (!(response ? Closed(target, { "portableArticle", "requiresNewIdentity", "requestedTargetArticleId", "expectedTargetRevision" })
            : Closed(target, { "portableArticle", "requestedTargetArticleId", "expectedTargetRevision" })))
        {
            return false;
        }
        const Node& portable = Member(target, "portableArticle");
        if (!Portable(portable) || std::find(identities.begin(), identities.end(), portable.text) != identities.end())
        {
            return false;
        }
        identities.push_back(portable.text);
        const Node& id = Member(target, "requestedTargetArticleId");
        const Node& revision = Member(target, "expectedTargetRevision");
        if (response)
        {
            const Node& requiresNode = Member(target, "requiresNewIdentity");
            if (requiresNode.kind != Kind::Boolean || requiresNode.boolean != create)
            {
                return false;
            }
        }
        if (response && create)
        {
            if (id.kind != Kind::Null || revision.kind != Kind::Null)
            {
                return false;
            }
        }
        else
        {
            if (!Integer(id, 1, 2147483647u) || !Revision(revision) || std::find(ids.begin(), ids.end(), id.number) != ids.end())
            {
                return false;
            }
            ids.push_back(id.number);
        }
    }
    return true;
}

inline bool Request(const Node& root)
{
    if (!Closed(root, { "requestId", "archiveBytes", "requestedMode", "callerPolicyDigest", "callerPermissionContextDigest", "createdAtUtc",
            "expiresAtUtc", "requestedTargets", "pageIndex", "pageSize", "expectedPlanDigest", "expectedContext" })
        || !RequestId(Member(root, "requestId")) || !Archive(Member(root, "archiveBytes")) || !Mode(Member(root, "requestedMode"))
        || !Digest(Member(root, "callerPolicyDigest")) || !Digest(Member(root, "callerPermissionContextDigest")) || !Interval(root)
        || !Integer(Member(root, "pageIndex"), 0, 999) || !Integer(Member(root, "pageSize"), 1, 50))
    {
        return false;
    }
    const Node& digest = Member(root, "expectedPlanDigest");
    const Node& context = Member(root, "expectedContext");
    const bool seed = digest.kind == Kind::Null && context.kind == Kind::Null;
    if (seed ? Member(root, "pageIndex").number != 0 : !Digest(digest) || !Context(context))
    {
        return false;
    }
    return Targets(Member(root, "requestedTargets"), Literal(Member(root, "requestedMode"), "CreateNew"), false);
}

inline bool Summary(const Node& value)
{
    return Closed(value, { "articleCount", "fileCount", "schemaVersion", "canonicalHashVersion", "propertySchemaVersion",
            "packageBytesDigest", "manifestSemanticDigest", "checksumComponentDigest" })
        && Integer(Member(value, "articleCount"), 1, 1000) && Integer(Member(value, "fileCount"), 3, 1002)
        && Member(value, "fileCount").number == Member(value, "articleCount").number + 2
        && Integer(Member(value, "schemaVersion"), 1, 1) && Integer(Member(value, "canonicalHashVersion"), 1, 1)
        && Integer(Member(value, "propertySchemaVersion"), 1, 1) && Digest(Member(value, "packageBytesDigest"))
        && Digest(Member(value, "manifestSemanticDigest")) && Digest(Member(value, "checksumComponentDigest"));
}

inline bool Review(const Node& value)
{
    if (!Closed(value, { "candidateStatus", "summary", "requestedMode", "policyDigest", "createdAtUtc", "expiresAtUtc", "intervalStatus", "planDigest",
            "pageIndex", "pageSize", "totalTargets", "targets", "requiredAuthorities", "executeDisabled", "executionReasonCode" })
        || !Literal(Member(value, "candidateStatus"), "finite_bytes_validated") || !Summary(Member(value, "summary"))
        || !Mode(Member(value, "requestedMode")) || !Digest(Member(value, "policyDigest")) || !Digest(Member(value, "planDigest")) || !Interval(value)
        || !(Literal(Member(value, "intervalStatus"), "caller_interval_not_started") || Literal(Member(value, "intervalStatus"), "caller_interval_current")
            || Literal(Member(value, "intervalStatus"), "caller_interval_expired"))
        || !Integer(Member(value, "pageIndex"), 0, 999) || !Integer(Member(value, "pageSize"), 1, 50) || !Integer(Member(value, "totalTargets"), 1, 1000)
        || Member(value, "executeDisabled").kind != Kind::Boolean || !Member(value, "executeDisabled").boolean
        || !Literal(Member(value, "executionReasonCode"), "article_package_import_authority_unavailable"))
    {
        return false;
    }
    const std::uint32_t count = Member(value, "totalTargets").number;
    const std::uint32_t size = Member(value, "pageSize").number;
    const std::uint32_t start = Member(value, "pageIndex").number * size;
    const Node& targets = Member(value, "targets");
    if (count != Member(Member(value, "summary"), "articleCount").number || start >= count
        || !Targets(targets, Literal(Member(value, "requestedMode"), "CreateNew"), true) || targets.children.size() != std::min(size, count - start))
    {
        return false;
    }
    const Node& authorities = Member(value, "requiredAuthorities");
    const std::string_view expected[] = { "archive_intake", "complete_package_schema", "canonical_source_and_property_provenance",
        "fsusui_syntax_dependencies", "persisted_relation_and_embed_plan", "frozen_public_projection_retention", "asset_and_dependency_resolution",
        "rights_responsibility_taxonomy_privacy", "current_actor_site_target_permissions", "current_target_revision_and_identity", "execution_qualification" };
    if (authorities.kind != Kind::Array || authorities.children.size() != 11)
    {
        return false;
    }
    for (std::size_t index = 0; index < 11; ++index)
    {
        if (!Literal(authorities.children[index], expected[index]))
        {
            return false;
        }
    }
    return true;
}

inline bool Response(const Node& root)
{
    return Closed(root, { "requestId", "review", "context" }) && RequestId(Member(root, "requestId"))
        && Context(Member(root, "context")) && Review(Member(root, "review"));
}

} // namespace Detail

/** Validates one payload under the complete-frame budget. Framing and CRC retain their canonical owner. */
inline bool ValidatePayload(const std::uint8_t* payload, std::size_t length, bool response)
{
    if (payload == nullptr || length == 0 || length > MaxFrameBytes - kHeaderSize)
    {
        return false;
    }
    Detail::Node root;
    Detail::Parser parser(std::string_view(reinterpret_cast<const char*>(payload), length));
    return parser.Parse(root) && (response ? Detail::Response(root) : Detail::Request(root));
}

inline bool ValidateRequestPayload(const std::uint8_t* payload, std::size_t length)
{
    return ValidatePayload(payload, length, false);
}

inline bool ValidateResponsePayload(const std::uint8_t* payload, std::size_t length)
{
    return ValidatePayload(payload, length, true);
}

} // namespace FsusBlog::Aeds::ArticlePackageCandidateReviewWire
