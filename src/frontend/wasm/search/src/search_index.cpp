#include "../../aeds/include/aeds_article_search_wire.generated.hpp"
#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace
{

constexpr std::uint32_t KShardMagic = 0x32534846u; // FHS2
constexpr std::uint32_t KShardVersion = 4u;
constexpr std::uint32_t KPatchMagic = 0x54505346u; // FSPT
constexpr std::uint32_t KPatchVersion = 3u;
constexpr std::uint32_t KPackageMagic = 0x4B505346u; // FSPK
constexpr std::uint32_t KPackageVersion = 4u;
constexpr std::uint32_t KSearchResultMagic = FsusBlog::AedsWire::ArticleSearchMagic;
constexpr std::uint32_t KSearchResultVersion = FsusBlog::AedsWire::ArticleSearchVersion;
constexpr double KBm25K1 = 1.2;
constexpr double KBm25B = 0.75;
constexpr double KTitleBoost = 2.5;
constexpr double KMetaBoost = 0.9;
constexpr double KBodyBoost = 1.0;
constexpr double KPhraseBonus = 1.25;
constexpr double KWeightRelevance = 1.0;
constexpr double KWeightHotness = 0.35;
constexpr double KHotCommentFactor = 12.0;
constexpr double KHotViewFactor = 0.15;
constexpr double KLambda = 1.0 / (1000.0 * 60.0 * 60.0 * 24.0 * 45.0);

enum class ErrorCode : std::uint8_t
{
    None = 0,
    PackagePayloadEmpty = 1,
    PackageHeaderInvalid = 2,
    ShardHeaderInvalid = 3,
    PatchHeaderInvalid = 4,
    VarintOverflow = 5,
    StringOverflow = 6,
    IndexNotLoaded = 7
};

enum class EntryKind : std::uint32_t
{
    Shard = 0,
    Patch = 1
};

enum class ShardRole : std::uint32_t
{
    Core = 0,
    Recent = 1,
    Archive = 2
};

struct SearchTag
{
    std::uint32_t Id = 0;
    std::string Name;
};

struct SearchDoc
{
    std::uint32_t ArticleId = 0;
    std::uint32_t CategoryId = 0;
    std::int64_t PublishUnixMs = 0;
    std::uint32_t Views = 0;
    std::uint32_t CommentCount = 0;
    std::uint32_t DocLength = 1;
    std::int64_t RevisionId = 0;
    std::int32_t RevisionNo = 0;
    std::int64_t PublicationId = 0;
    std::int32_t PublicationNo = 0;
    std::string Title;
    std::string Summary;
    std::string CategoryName;
    std::vector<SearchTag> Tags;
};

struct PositionRange
{
    std::uint32_t Position = 0;
    std::uint32_t Length = 1;
    std::uint8_t Field = 0;
};

struct PostingHit
{
    std::uint32_t ArticleId = 0;
    std::uint8_t TitleTf = 0;
    std::uint8_t MetaTf = 0;
    std::uint8_t BodyTf = 0;
    std::vector<PositionRange> Positions;
};

struct TermEntry
{
    std::uint32_t Hash = 0;
    float Idf = 0.0f;
    std::uint32_t PostingOffset = 0;
    std::uint32_t PostingLength = 0;
    bool HasPositions = false;
};

struct CategoryEntry
{
    std::uint32_t Id = 0;
    std::string Name;
};

struct TagEntry
{
    std::uint32_t Id = 0;
    std::string Name;
};

struct ShardState
{
    ShardRole Role = ShardRole::Core;
    bool IsPatch = false;
    float AvgDocLength = 1.0f;
    std::vector<TermEntry> Terms;
    std::vector<std::uint8_t> PostingsBlob;
    std::unordered_set<std::uint32_t> Tombstones;
};

struct SearchState
{
    std::vector<SearchDoc> Docs;
    std::unordered_map<std::uint32_t, std::uint32_t> DocIndexByArticle;
    std::vector<ShardState> Shards;
    std::unordered_map<std::uint32_t, std::size_t> RolePatchIndex;
    float AvgDocLength = 1.0f;
    bool Loaded = false;
};

struct ScoreEntry
{
    std::uint32_t DocIndex = 0;
    double Bm25 = 0.0;
    double Hot = 0.0;
    double FinalScore = 0.0;
};

thread_local SearchState t_state{};
thread_local std::string t_lastResult;
thread_local std::string t_lastError;
thread_local ErrorCode t_lastErrorCode = ErrorCode::None;
thread_local std::vector<double> t_bm25Scores;
thread_local std::vector<std::uint32_t> t_scoreGeneration;
thread_local std::vector<std::uint32_t> t_touchedDocs;
thread_local std::uint32_t t_currentScoreGeneration = 1;

const char* ToErrorString(ErrorCode code)
{
    switch (code)
    {
        case ErrorCode::None:
            return "";
        case ErrorCode::PackagePayloadEmpty:
            return "search_package_payload_empty";
        case ErrorCode::PackageHeaderInvalid:
            return "search_package_header_invalid";
        case ErrorCode::ShardHeaderInvalid:
            return "search_shard_header_invalid";
        case ErrorCode::PatchHeaderInvalid:
            return "search_patch_header_invalid";
        case ErrorCode::VarintOverflow:
            return "search_varint_overflow";
        case ErrorCode::StringOverflow:
            return "search_string_overflow";
        case ErrorCode::IndexNotLoaded:
            return "search_index_not_loaded";
        default:
            return "search_runtime_failed";
    }
}

void ClearError()
{
    t_lastError.clear();
    t_lastErrorCode = ErrorCode::None;
}

void SetError(ErrorCode code)
{
    t_lastErrorCode = code;
    t_lastError = ToErrorString(code);
}

std::uint32_t ReadU32(const std::uint8_t*& cursor, const std::uint8_t* end)
{
    if (cursor + 4 > end)
    {
        SetError(ErrorCode::ShardHeaderInvalid);
        return 0;
    }

    std::uint32_t value = static_cast<std::uint32_t>(cursor[0]) | (static_cast<std::uint32_t>(cursor[1]) << 8)
                          | (static_cast<std::uint32_t>(cursor[2]) << 16)
                          | (static_cast<std::uint32_t>(cursor[3]) << 24);
    cursor += 4;
    return value;
}

std::uint16_t ReadU16(const std::uint8_t*& cursor, const std::uint8_t* end)
{
    if (cursor + 2 > end)
    {
        SetError(ErrorCode::ShardHeaderInvalid);
        return 0;
    }

    std::uint16_t value = static_cast<std::uint16_t>(static_cast<std::uint32_t>(cursor[0])
                                                     | (static_cast<std::uint32_t>(cursor[1]) << 8U));
    cursor += 2;
    return value;
}

std::int64_t ReadI64(const std::uint8_t*& cursor, const std::uint8_t* end)
{
    if (cursor + 8 > end)
    {
        SetError(ErrorCode::ShardHeaderInvalid);
        return 0;
    }

    std::uint64_t raw = 0;
    for (std::uint32_t index = 0; index < 8U; ++index)
    {
        raw |= static_cast<std::uint64_t>(cursor[index]) << (8U * index);
    }
    cursor += 8;
    return std::bit_cast<std::int64_t>(raw);
}

float ReadF32(const std::uint8_t*& cursor, const std::uint8_t* end)
{
    std::uint32_t raw = ReadU32(cursor, end);
    float value = 0.0f;
    std::memcpy(&value, &raw, sizeof(float));
    return value;
}

std::string ReadString(const std::uint8_t* start, const std::uint8_t* end, std::uint32_t offset, std::uint16_t length)
{
    if (length == 0)
    {
        return {};
    }

    if (start + offset + length > end)
    {
        SetError(ErrorCode::StringOverflow);
        return {};
    }

    return std::string(reinterpret_cast<const char*>(start + offset), length);
}

std::uint32_t ReadVint(const std::uint8_t*& cursor, const std::uint8_t* end)
{
    std::uint32_t value = 0;
    std::uint32_t shift = 0;
    while (cursor < end && shift <= 28U)
    {
        const std::uint8_t Byte = *cursor++;
        value |= static_cast<std::uint32_t>(Byte & 0x7Fu) << shift;
        if ((Byte & 0x80u) == 0)
        {
            return value;
        }
        shift += 7;
    }

    SetError(ErrorCode::VarintOverflow);
    return 0;
}

std::uint32_t MurmurHash3(std::string_view source)
{
    const auto* data = reinterpret_cast<const std::uint8_t*>(source.data());
    const std::size_t Length = source.size();
    const std::size_t RoundedEnd = Length & ~std::size_t{3};
    std::uint32_t h1 = 0;

    constexpr std::uint32_t C1 = 0xcc9e2d51u;
    constexpr std::uint32_t C2 = 0x1b873593u;

    for (std::size_t index = 0; index < RoundedEnd; index += 4U)
    {
        std::uint32_t k1 = static_cast<std::uint32_t>(data[index]) | (static_cast<std::uint32_t>(data[index + 1]) << 8)
                           | (static_cast<std::uint32_t>(data[index + 2]) << 16)
                           | (static_cast<std::uint32_t>(data[index + 3]) << 24);

        k1 *= C1;
        k1 = (k1 << 15) | (k1 >> 17);
        k1 *= C2;

        h1 ^= k1;
        h1 = (h1 << 13) | (h1 >> 19);
        h1 = h1 * 5 + 0xe6546b64u;
    }

    std::uint32_t k1 = 0;
    switch (Length & std::size_t{3})
    {
        case 3:
            k1 ^= static_cast<std::uint32_t>(data[RoundedEnd + 2]) << 16;
            [[fallthrough]];
        case 2:
            k1 ^= static_cast<std::uint32_t>(data[RoundedEnd + 1]) << 8;
            [[fallthrough]];
        case 1:
            k1 ^= static_cast<std::uint32_t>(data[RoundedEnd]);
            k1 *= C1;
            k1 = (k1 << 15) | (k1 >> 17);
            k1 *= C2;
            h1 ^= k1;
            break;
        default:
            break;
    }

    h1 ^= static_cast<std::uint32_t>(Length);
    h1 ^= h1 >> 16;
    h1 *= 0x85ebca6bu;
    h1 ^= h1 >> 13;
    h1 *= 0xc2b2ae35u;
    h1 ^= h1 >> 16;
    return h1;
}

bool IsAsciiWord(std::uint8_t ch)
{
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
}

std::uint32_t DecodeUtf8Codepoint(const std::string& input, std::size_t& index)
{
    const unsigned char Lead = static_cast<unsigned char>(input[index]);
    if (Lead < 0x80)
    {
        ++index;
        return Lead;
    }
    if ((Lead >> 5) == 0x6 && index + 1 < input.size())
    {
        std::uint32_t codepoint = ((Lead & 0x1Fu) << 6) | (static_cast<unsigned char>(input[index + 1]) & 0x3Fu);
        index += 2;
        return codepoint;
    }
    if ((Lead >> 4) == 0xE && index + 2 < input.size())
    {
        std::uint32_t codepoint = ((Lead & 0x0Fu) << 12) | ((static_cast<unsigned char>(input[index + 1]) & 0x3Fu) << 6)
                                  | (static_cast<unsigned char>(input[index + 2]) & 0x3Fu);
        index += 3;
        return codepoint;
    }
    if ((Lead >> 3) == 0x1E && index + 3 < input.size())
    {
        std::uint32_t codepoint = ((Lead & 0x07u) << 18)
                                  | ((static_cast<unsigned char>(input[index + 1]) & 0x3Fu) << 12)
                                  | ((static_cast<unsigned char>(input[index + 2]) & 0x3Fu) << 6)
                                  | (static_cast<unsigned char>(input[index + 3]) & 0x3Fu);
        index += 4;
        return codepoint;
    }

    ++index;
    return 0;
}

bool IsCjk(std::uint32_t codepoint)
{
    return (codepoint >= 0x4E00u && codepoint <= 0x9FFFu) || (codepoint >= 0x3400u && codepoint <= 0x4DBFu)
           || (codepoint >= 0x3040u && codepoint <= 0x30FFu) || (codepoint >= 0xAC00u && codepoint <= 0xD7AFu);
}

std::vector<std::uint32_t> TokenizeQueryHashes(std::string query)
{
    std::vector<std::uint32_t> hashes;
    std::string asciiBuffer;
    auto flushAscii = [&]
    {
        if (!asciiBuffer.empty())
        {
            std::transform(asciiBuffer.begin(),
                           asciiBuffer.end(),
                           asciiBuffer.begin(),
                           [](unsigned char ch)
                           {
                               return static_cast<char>(std::tolower(ch));
                           });
            hashes.push_back(MurmurHash3(asciiBuffer));
            asciiBuffer.clear();
        }
    };

    for (std::size_t index = 0; index < query.size();)
    {
        unsigned char lead = static_cast<unsigned char>(query[index]);
        if (lead < 0x80)
        {
            char ch = static_cast<char>(lead);
            if (IsAsciiWord(static_cast<std::uint8_t>(ch)))
            {
                asciiBuffer.push_back(ch);
            }
            else
            {
                flushAscii();
            }
            ++index;
            continue;
        }

        flushAscii();
        std::size_t start = index;
        std::uint32_t codepoint = DecodeUtf8Codepoint(query, index);
        if (IsCjk(codepoint))
        {
            hashes.push_back(MurmurHash3(std::string_view(query.data() + start, index - start)));
        }
    }

    flushAscii();
    std::sort(hashes.begin(), hashes.end());
    hashes.erase(std::unique(hashes.begin(), hashes.end()), hashes.end());
    return hashes;
}

double DecodeQuantizedTf(std::uint8_t value)
{
    switch (value)
    {
        case 0:
            return 0.0;
        case 1:
        case 2:
        case 3:
        case 4:
        case 5:
        case 6:
        case 7:
        case 8:
        case 9:
        case 10:
            return static_cast<double>(value);
        case 11:
            return 12.0;
        case 12:
            return 15.0;
        case 13:
            return 20.0;
        case 14:
            return 30.0;
        case 15:
            return 50.0;
        case 16:
            return 100.0;
        default:
            return 140.0;
    }
}

double ComputeHotScore(const SearchDoc& doc, std::int64_t nowMs)
{
    const double AgeMs = std::max<double>(0.0, static_cast<double>(nowMs - doc.PublishUnixMs));
    const double Base =
        static_cast<double>(doc.CommentCount) * KHotCommentFactor + static_cast<double>(doc.Views) * KHotViewFactor;
    return Base * std::exp(-KLambda * AgeMs);
}

void WriteU16(std::string& target, std::uint16_t value)
{
    target.push_back(static_cast<char>(static_cast<std::uint32_t>(value) & 0xFFu));
    target.push_back(static_cast<char>((static_cast<std::uint32_t>(value) >> 8U) & 0xFFu));
}

void WriteU32(std::string& target, std::uint32_t value)
{
    target.push_back(static_cast<char>(value & 0xFFu));
    target.push_back(static_cast<char>((value >> 8) & 0xFFu));
    target.push_back(static_cast<char>((value >> 16) & 0xFFu));
    target.push_back(static_cast<char>((value >> 24) & 0xFFu));
}

void PatchU32(std::string& target, std::size_t offset, std::uint32_t value)
{
    if (offset + 4 > target.size())
    {
        return;
    }

    target[offset] = static_cast<char>(value & 0xFFu);
    target[offset + 1] = static_cast<char>((value >> 8) & 0xFFu);
    target[offset + 2] = static_cast<char>((value >> 16) & 0xFFu);
    target[offset + 3] = static_cast<char>((value >> 24) & 0xFFu);
}

void WriteI64(std::string& target, std::int64_t value)
{
    const std::uint64_t Bits = std::bit_cast<std::uint64_t>(value);
    for (std::uint32_t shift = 0; shift < 64U; shift += 8U)
    {
        target.push_back(static_cast<char>((Bits >> shift) & 0xFFu));
    }
}

std::size_t Utf8PrefixLen(std::string_view source, std::size_t maxBytes)
{
    if (source.size() <= maxBytes)
    {
        return source.size();
    }

    std::size_t index = 0;
    std::size_t lastSafe = 0;
    while (index < source.size() && index < maxBytes)
    {
        const unsigned char Lead = static_cast<unsigned char>(source[index]);
        std::size_t advance = 1;
        if ((Lead >> 5) == 0x6)
        {
            advance = 2;
        }
        else if ((Lead >> 4) == 0xE)
        {
            advance = 3;
        }
        else if ((Lead >> 3) == 0x1E)
        {
            advance = 4;
        }

        if (index + advance > maxBytes)
        {
            break;
        }

        lastSafe = index + advance;
        index += advance;
    }

    return lastSafe;
}

void AppendBlobRef(std::string& metadata, std::string& blob, std::string_view value)
{
    const std::size_t Length =
        Utf8PrefixLen(value, static_cast<std::size_t>(std::numeric_limits<std::uint32_t>::max()));
    WriteU32(metadata, static_cast<std::uint32_t>(blob.size()));
    WriteU32(metadata, static_cast<std::uint32_t>(Length));
    blob.append(value.data(), Length);
}

void BuildBinaryPage(const std::vector<ScoreEntry>& scores, std::size_t page, std::size_t pageSize)
{
    const std::size_t Total = scores.size();
    const std::size_t SafePage = page == 0 ? 1 : page;
    const std::size_t SafeSize = std::max<std::size_t>(1, pageSize);
    const std::size_t Start = (SafePage - 1) * SafeSize;

    t_lastResult.clear();
    const std::size_t ItemCount = Start < Total ? std::min(Total - Start, SafeSize) : 0;
    constexpr std::size_t HeaderSize = FsusBlog::AedsWire::ArticleSearchHeaderBytes;
    constexpr std::size_t ItemRecordSize = FsusBlog::AedsWire::ArticleSearchRecordBytes;
    constexpr std::size_t TagRecordSize = FsusBlog::AedsWire::ArticleSearchTagRecordBytes;
    std::string records;
    std::string tagRecords;
    std::string blob;
    records.reserve(ItemCount * ItemRecordSize);
    tagRecords.reserve(ItemCount * 24);
    blob.reserve(ItemCount * 256);

    t_lastResult.reserve(HeaderSize + ItemCount * ItemRecordSize + ItemCount * 24 + ItemCount * 256);
    WriteU32(t_lastResult, KSearchResultMagic);
    WriteU32(t_lastResult, KSearchResultVersion);
    WriteU32(t_lastResult, static_cast<std::uint32_t>(Total));
    WriteU32(t_lastResult, static_cast<std::uint32_t>(ItemCount));
    WriteU32(t_lastResult, static_cast<std::uint32_t>(HeaderSize + ItemCount * ItemRecordSize));
    WriteU32(t_lastResult, static_cast<std::uint32_t>(HeaderSize + ItemCount * ItemRecordSize));

    if (ItemCount == 0)
    {
        return;
    }

    const std::size_t End = Start + ItemCount;
    for (std::size_t i = Start; i < End; ++i)
    {
        const SearchDoc& doc = t_state.Docs[scores[i].DocIndex];
        WriteU32(records, doc.ArticleId);
        WriteU32(records, doc.Views);
        WriteI64(records, doc.PublishUnixMs);
        WriteU32(records, doc.CategoryId);
        AppendBlobRef(records, blob, doc.CategoryName);
        AppendBlobRef(records, blob, doc.Title);
        AppendBlobRef(records, blob, doc.Summary);
        WriteU32(records, static_cast<std::uint32_t>(tagRecords.size() / TagRecordSize));
        WriteU32(records, static_cast<std::uint32_t>(doc.Tags.size()));
        WriteI64(records, doc.RevisionId);
        WriteU32(records, static_cast<std::uint32_t>(doc.RevisionNo));
        WriteI64(records, doc.PublicationId);
        WriteU32(records, static_cast<std::uint32_t>(doc.PublicationNo));
        for (const SearchTag& tag : doc.Tags)
        {
            WriteU32(tagRecords, tag.Id);
            AppendBlobRef(tagRecords, blob, tag.Name);
        }
    }

    const std::uint32_t TagOffset = static_cast<std::uint32_t>(HeaderSize + records.size());
    const std::uint32_t BlobOffset = static_cast<std::uint32_t>(TagOffset + tagRecords.size());
    PatchU32(t_lastResult, 16, TagOffset);
    PatchU32(t_lastResult, 20, BlobOffset);
    t_lastResult.append(records);
    t_lastResult.append(tagRecords);
    t_lastResult.append(blob);
}

bool IsScoreBefore(const ScoreEntry& left, const ScoreEntry& right, int sortMode)
{
    const SearchDoc& leftDoc = t_state.Docs[left.DocIndex];
    const SearchDoc& rightDoc = t_state.Docs[right.DocIndex];
    switch (sortMode)
    {
        case 1:
            if (leftDoc.PublishUnixMs != rightDoc.PublishUnixMs)
            {
                return leftDoc.PublishUnixMs > rightDoc.PublishUnixMs;
            }
            if (left.FinalScore != right.FinalScore)
            {
                return left.FinalScore > right.FinalScore;
            }
            return leftDoc.ArticleId < rightDoc.ArticleId;
        case 2:
            if (left.Hot != right.Hot)
            {
                return left.Hot > right.Hot;
            }
            if (left.FinalScore != right.FinalScore)
            {
                return left.FinalScore > right.FinalScore;
            }
            return leftDoc.ArticleId < rightDoc.ArticleId;
        default:
            if (left.FinalScore != right.FinalScore)
            {
                return left.FinalScore > right.FinalScore;
            }
            if (left.Hot != right.Hot)
            {
                return left.Hot > right.Hot;
            }
            if (leftDoc.PublishUnixMs != rightDoc.PublishUnixMs)
            {
                return leftDoc.PublishUnixMs > rightDoc.PublishUnixMs;
            }
            return leftDoc.ArticleId < rightDoc.ArticleId;
    }
}

void OrderScoresForPage(std::vector<ScoreEntry>& scores, std::size_t page, std::size_t pageSize, int sortMode)
{
    if (scores.size() <= 1)
    {
        return;
    }

    const std::size_t SafePage = page == 0 ? 1 : page;
    const std::size_t SafeSize = std::max<std::size_t>(1, pageSize);
    if (SafePage > std::numeric_limits<std::size_t>::max() / SafeSize)
    {
        std::sort(scores.begin(),
                  scores.end(),
                  [sortMode](const ScoreEntry& left, const ScoreEntry& right)
                  {
                      return IsScoreBefore(left, right, sortMode);
                  });
        return;
    }

    const std::size_t TopCount = std::min(scores.size(), SafePage * SafeSize);
    if (TopCount == 0)
    {
        return;
    }

    auto comparator = [sortMode](const ScoreEntry& left, const ScoreEntry& right)
    {
        return IsScoreBefore(left, right, sortMode);
    };

    if (TopCount < scores.size())
    {
        std::nth_element(
            scores.begin(), scores.begin() + static_cast<std::ptrdiff_t>(TopCount), scores.end(), comparator);
    }

    std::sort(scores.begin(), scores.begin() + static_cast<std::ptrdiff_t>(TopCount), comparator);
}

const TermEntry* FindTerm(const ShardState& shard, std::uint32_t hash)
{
    auto it = std::lower_bound(shard.Terms.begin(),
                               shard.Terms.end(),
                               hash,
                               [](const TermEntry& entry, std::uint32_t value)
                               {
                                   return entry.Hash < value;
                               });
    if (it == shard.Terms.end() || it->Hash != hash)
    {
        return nullptr;
    }

    return &(*it);
}

bool AlignCursor(const std::uint8_t*& cursor, const std::uint8_t* base, const std::uint8_t* end, std::uint32_t offset)
{
    if (base + offset > end)
    {
        SetError(ErrorCode::ShardHeaderInvalid);
        return false;
    }
    cursor = base + offset;
    return true;
}

bool ParseShardPayload(const std::uint8_t* data,
                       int length,
                       ShardRole expectedRole,
                       bool isPatchPayload,
                       const std::unordered_set<std::uint32_t>& tombstones,
                       ShardState& outShard)
{
    if (length <= 0)
    {
        SetError(ErrorCode::ShardHeaderInvalid);
        return false;
    }

    const auto* base = data;
    const auto* cursor = data;
    const auto* end = data + length;

    const std::uint32_t Magic = ReadU32(cursor, end);
    const std::uint32_t Version = ReadU32(cursor, end);
    const auto Role = static_cast<ShardRole>(ReadU32(cursor, end));
    const std::uint32_t Flags = ReadU32(cursor, end);
    const std::uint32_t TermCount = ReadU32(cursor, end);
    const std::uint32_t DocCount = ReadU32(cursor, end);
    const std::uint32_t CategoryCount = ReadU32(cursor, end);
    const std::uint32_t TagCount = ReadU32(cursor, end);
    const std::uint32_t TagRefCount = ReadU32(cursor, end);
    const std::uint32_t TermOffset = ReadU32(cursor, end);
    const std::uint32_t DocOffset = ReadU32(cursor, end);
    const std::uint32_t CategoryOffset = ReadU32(cursor, end);
    const std::uint32_t TagOffset = ReadU32(cursor, end);
    const std::uint32_t TagRefOffset = ReadU32(cursor, end);
    const std::uint32_t StringPoolOffset = ReadU32(cursor, end);
    const std::uint32_t PostingOffset = ReadU32(cursor, end);
    const std::uint32_t PostingLength = ReadU32(cursor, end);
    const float AvgDocLength = ReadF32(cursor, end);

    if (!t_lastError.empty() || Magic != KShardMagic || Version != KShardVersion || Role != expectedRole)
    {
        SetError(ErrorCode::ShardHeaderInvalid);
        return false;
    }

    std::vector<CategoryEntry> categories;
    categories.reserve(CategoryCount);
    if (!AlignCursor(cursor, base, end, CategoryOffset))
    {
        return false;
    }
    for (std::uint32_t i = 0; i < CategoryCount; ++i)
    {
        CategoryEntry entry;
        entry.Id = ReadU32(cursor, end);
        std::uint32_t nameOffset = ReadU32(cursor, end);
        std::uint16_t nameLength = ReadU16(cursor, end);
        cursor += 2;
        cursor += 4;
        if (!t_lastError.empty())
        {
            return false;
        }
        entry.Name = ReadString(base + StringPoolOffset, end, nameOffset, nameLength);
        if (!t_lastError.empty())
        {
            return false;
        }
        categories.push_back(std::move(entry));
    }

    std::vector<TagEntry> tags;
    tags.reserve(TagCount);
    if (!AlignCursor(cursor, base, end, TagOffset))
    {
        return false;
    }
    for (std::uint32_t i = 0; i < TagCount; ++i)
    {
        TagEntry entry;
        entry.Id = ReadU32(cursor, end);
        std::uint32_t nameOffset = ReadU32(cursor, end);
        std::uint16_t nameLength = ReadU16(cursor, end);
        cursor += 2;
        cursor += 4;
        if (!t_lastError.empty())
        {
            return false;
        }
        entry.Name = ReadString(base + StringPoolOffset, end, nameOffset, nameLength);
        if (!t_lastError.empty())
        {
            return false;
        }
        tags.push_back(std::move(entry));
    }

    std::vector<std::uint16_t> tagRefs;
    tagRefs.reserve(TagRefCount);
    if (!AlignCursor(cursor, base, end, TagRefOffset))
    {
        return false;
    }
    for (std::uint32_t i = 0; i < TagRefCount; ++i)
    {
        tagRefs.push_back(ReadU16(cursor, end));
        if (!t_lastError.empty())
        {
            return false;
        }
    }

    if (!AlignCursor(cursor, base, end, DocOffset))
    {
        return false;
    }
    for (std::uint32_t i = 0; i < DocCount; ++i)
    {
        std::uint32_t articleId = ReadU32(cursor, end);
        std::uint16_t categoryIndex = ReadU16(cursor, end);
        std::uint16_t tagCountForDoc = ReadU16(cursor, end);
        std::uint32_t tagRefStart = ReadU32(cursor, end);
        std::uint32_t views = ReadU32(cursor, end);
        std::uint32_t commentCount = ReadU32(cursor, end);
        std::uint32_t docLength = ReadU32(cursor, end);
        std::int64_t publishUnixMs = ReadI64(cursor, end);
        std::uint32_t titleOffset = ReadU32(cursor, end);
        std::uint16_t titleLength = ReadU16(cursor, end);
        cursor += 2;
        std::uint32_t summaryOffset = ReadU32(cursor, end);
        std::uint16_t summaryLength = ReadU16(cursor, end);
        cursor += 2;
        cursor += 4;
        std::int64_t revisionId = ReadI64(cursor, end);
        std::int32_t revisionNo = static_cast<std::int32_t>(ReadU32(cursor, end));
        std::int64_t publicationId = ReadI64(cursor, end);
        std::int32_t publicationNo = static_cast<std::int32_t>(ReadU32(cursor, end));

        if (!t_lastError.empty())
        {
            return false;
        }

        if ((Flags & 1u) != 0u)
        {
            SearchDoc doc;
            doc.ArticleId = articleId;
            doc.PublishUnixMs = publishUnixMs;
            doc.Views = views;
            doc.CommentCount = commentCount;
            doc.DocLength = docLength == 0 ? 1u : docLength;
            doc.RevisionId = revisionId;
            doc.RevisionNo = revisionNo;
            doc.PublicationId = publicationId;
            doc.PublicationNo = publicationNo;
            doc.Title = ReadString(base + StringPoolOffset, end, titleOffset, titleLength);
            doc.Summary = ReadString(base + StringPoolOffset, end, summaryOffset, summaryLength);
            if (categoryIndex < categories.size())
            {
                doc.CategoryId = categories[categoryIndex].Id;
                doc.CategoryName = categories[categoryIndex].Name;
            }

            doc.Tags.reserve(tagCountForDoc);
            for (std::uint16_t tagIndex = 0; tagIndex < tagCountForDoc; ++tagIndex)
            {
                const std::uint32_t RefIndex = tagRefStart + tagIndex;
                if (RefIndex >= tagRefs.size())
                {
                    continue;
                }

                const std::uint16_t DictIndex = tagRefs[RefIndex];
                if (DictIndex >= tags.size())
                {
                    continue;
                }

                doc.Tags.push_back(SearchTag{tags[DictIndex].Id, tags[DictIndex].Name});
            }

            auto existing = t_state.DocIndexByArticle.find(articleId);
            if (existing == t_state.DocIndexByArticle.end())
            {
                t_state.DocIndexByArticle.emplace(articleId, static_cast<std::uint32_t>(t_state.Docs.size()));
                t_state.Docs.push_back(std::move(doc));
            }
            else
            {
                t_state.Docs[existing->second] = std::move(doc);
            }
        }
    }

    if (!AlignCursor(cursor, base, end, TermOffset))
    {
        return false;
    }

    outShard.Role = Role;
    outShard.IsPatch = isPatchPayload;
    outShard.AvgDocLength = AvgDocLength <= 0.0f ? 1.0f : AvgDocLength;
    outShard.Tombstones = tombstones;
    outShard.Terms.reserve(TermCount);
    for (std::uint32_t i = 0; i < TermCount; ++i)
    {
        TermEntry entry;
        entry.Hash = ReadU32(cursor, end);
        entry.Idf = ReadF32(cursor, end);
        entry.PostingOffset = ReadU32(cursor, end);
        entry.PostingLength = ReadU32(cursor, end);
        entry.HasPositions = ReadU32(cursor, end) != 0;
        cursor += 4;
        if (!t_lastError.empty())
        {
            return false;
        }
        outShard.Terms.push_back(entry);
    }

    if (base + PostingOffset + PostingLength > end)
    {
        SetError(ErrorCode::ShardHeaderInvalid);
        return false;
    }

    outShard.PostingsBlob.assign(base + PostingOffset, base + PostingOffset + PostingLength);
    return true;
}

bool ParsePatchPayload(const std::uint8_t* data, int length, ShardRole role, ShardState& outShard)
{
    const auto* cursor = data;
    const auto* end = data + length;
    const std::uint32_t Magic = ReadU32(cursor, end);
    const std::uint32_t Version = ReadU32(cursor, end);
    const std::uint32_t TombstoneCount = ReadU32(cursor, end);
    const std::uint32_t TombstoneBytesLength = ReadU32(cursor, end);
    const std::uint32_t ShardLength = ReadU32(cursor, end);
    cursor += 4;

    if (!t_lastError.empty() || Magic != KPatchMagic || Version != KPatchVersion
        || cursor + TombstoneBytesLength + ShardLength > end)
    {
        SetError(ErrorCode::PatchHeaderInvalid);
        return false;
    }

    std::unordered_set<std::uint32_t> tombstones;
    tombstones.reserve(TombstoneCount);
    std::uint32_t previousArticleId = 0;
    const auto* tombstoneEnd = cursor + TombstoneBytesLength;
    for (std::uint32_t i = 0; i < TombstoneCount; ++i)
    {
        previousArticleId += ReadVint(cursor, tombstoneEnd);
        if (!t_lastError.empty())
        {
            return false;
        }
        tombstones.insert(previousArticleId);
    }

    if (ShardLength == 0)
    {
        outShard.Role = role;
        outShard.IsPatch = true;
        outShard.AvgDocLength = 1.0f;
        outShard.Tombstones = std::move(tombstones);
        return true;
    }

    return ParseShardPayload(cursor, static_cast<int>(ShardLength), role, true, tombstones, outShard);
}

bool ApplySearchEntry(EntryKind kind, ShardRole role, const std::uint8_t* data, int length)
{
    ShardState shard;
    if (kind == EntryKind::Patch)
    {
        if (!ParsePatchPayload(data, length, role, shard))
        {
            return false;
        }
    }
    else
    {
        if (!ParseShardPayload(data, length, role, false, {}, shard))
        {
            return false;
        }
    }

    t_state.Shards.erase(std::remove_if(t_state.Shards.begin(),
                                        t_state.Shards.end(),
                                        [&](const ShardState& existing)
                                        {
                                            if (existing.Role != role)
                                            {
                                                return false;
                                            }

                                            return kind == EntryKind::Shard || existing.IsPatch == shard.IsPatch;
                                        }),
                         t_state.Shards.end());

    if (shard.Role == ShardRole::Core && !shard.IsPatch && shard.AvgDocLength > 0.0f)
    {
        t_state.AvgDocLength = shard.AvgDocLength;
    }

    t_state.Shards.push_back(std::move(shard));
    if (t_state.AvgDocLength <= 0.0f)
    {
        t_state.AvgDocLength = 1.0f;
    }
    t_state.Loaded = true;
    return true;
}

bool ParsePackage(const std::uint8_t* data, int length)
{
    const auto* cursor = data;
    const auto* end = data + length;
    const std::uint32_t Magic = ReadU32(cursor, end);
    const std::uint32_t Version = ReadU32(cursor, end);
    const std::uint32_t EntryCount = ReadU32(cursor, end);

    if (!t_lastError.empty() || Magic != KPackageMagic || Version != KPackageVersion)
    {
        SetError(ErrorCode::PackageHeaderInvalid);
        return false;
    }

    struct PackageEntry
    {
        EntryKind Kind = EntryKind::Shard;
        ShardRole Role = ShardRole::Core;
        std::uint32_t Offset = 0;
        std::uint32_t Length = 0;
    };

    std::vector<PackageEntry> entries;
    entries.reserve(EntryCount);
    for (std::uint32_t i = 0; i < EntryCount; ++i)
    {
        PackageEntry entry;
        entry.Kind = static_cast<EntryKind>(ReadU32(cursor, end));
        entry.Role = static_cast<ShardRole>(ReadU32(cursor, end));
        entry.Offset = ReadU32(cursor, end);
        entry.Length = ReadU32(cursor, end);
        if (!t_lastError.empty() || data + entry.Offset + entry.Length > end)
        {
            SetError(ErrorCode::PackageHeaderInvalid);
            return false;
        }
        entries.push_back(entry);
    }

    t_state = SearchState{};
    for (const PackageEntry& entry : entries)
    {
        if (!ApplySearchEntry(entry.Kind, entry.Role, data + entry.Offset, static_cast<int>(entry.Length)))
        {
            return false;
        }
    }

    t_state.Loaded = true;
    return true;
}

bool DecodePostingHit(const ShardState& shard, const TermEntry& term, std::uint32_t targetArticleId, PostingHit& hit)
{
    if (term.PostingOffset + term.PostingLength > shard.PostingsBlob.size())
    {
        return false;
    }

    const auto* cursor = shard.PostingsBlob.data() + term.PostingOffset;
    const auto* end = cursor + term.PostingLength;
    const std::uint32_t PostingCount = ReadVint(cursor, end);
    if (!t_lastError.empty())
    {
        return false;
    }

    std::uint32_t articleId = 0;
    for (std::uint32_t i = 0; i < PostingCount; ++i)
    {
        articleId += ReadVint(cursor, end);
        if (cursor + 3 > end || !t_lastError.empty())
        {
            return false;
        }

        const std::uint8_t TitleTf = *cursor++;
        const std::uint8_t MetaTf = *cursor++;
        const std::uint8_t BodyTf = *cursor++;
        const std::uint32_t PositionCount = ReadVint(cursor, end);
        if (!t_lastError.empty())
        {
            return false;
        }

        std::vector<PositionRange> positions;
        positions.reserve(PositionCount);
        std::uint32_t previousPosition = 0;
        for (std::uint32_t p = 0; p < PositionCount; ++p)
        {
            previousPosition += ReadVint(cursor, end);
            const std::uint32_t PositionLength = ReadVint(cursor, end);
            const std::uint32_t Field = ReadVint(cursor, end);
            if (!t_lastError.empty())
            {
                return false;
            }
            positions.push_back(PositionRange{
                previousPosition, PositionLength == 0 ? 1u : PositionLength, static_cast<std::uint8_t>(Field)});
        }

        if (articleId != targetArticleId)
        {
            continue;
        }

        hit.ArticleId = articleId;
        hit.TitleTf = TitleTf;
        hit.MetaTf = MetaTf;
        hit.BodyTf = BodyTf;
        hit.Positions = std::move(positions);
        return true;
    }

    return false;
}

double ComputePhraseBonus(const std::vector<const TermEntry*>& terms, const ShardState& shard, std::uint32_t articleId)
{
    if (terms.size() < 2)
    {
        return 0.0;
    }

    std::vector<std::vector<PositionRange>> termPositions;
    termPositions.reserve(terms.size());
    for (const TermEntry* term : terms)
    {
        if (term == nullptr || !term->HasPositions)
        {
            return 0.0;
        }

        PostingHit hit;
        if (!DecodePostingHit(shard, *term, articleId, hit) || hit.Positions.empty())
        {
            return 0.0;
        }
        termPositions.push_back(std::move(hit.Positions));
    }

    for (const PositionRange& first : termPositions.front())
    {
        std::uint32_t expected = first.Position + first.Length;
        const std::uint8_t ExpectedField = first.Field;
        bool matched = true;
        for (std::size_t index = 1; index < termPositions.size(); ++index)
        {
            const auto& positions = termPositions[index];
            auto it = std::find_if(positions.begin(),
                                   positions.end(),
                                   [&](const PositionRange& candidate)
                                   {
                                       return candidate.Position == expected && candidate.Field == ExpectedField;
                                   });
            if (it == positions.end())
            {
                matched = false;
                break;
            }

            expected = it->Position + it->Length;
        }

        if (matched)
        {
            return KPhraseBonus;
        }
    }

    return 0.0;
}

double ComputeEffectiveTf(std::uint8_t titleTf,
                          std::uint8_t metaTf,
                          std::uint8_t bodyTf,
                          const TermEntry& term,
                          const std::vector<PositionRange>& positions,
                          std::unordered_set<std::uint64_t>* coveredPositions)
{
    const double MetaContribution = DecodeQuantizedTf(metaTf) * KMetaBoost;
    double positionalContribution = DecodeQuantizedTf(titleTf) * KTitleBoost + DecodeQuantizedTf(bodyTf) * KBodyBoost;

    if (coveredPositions != nullptr && term.HasPositions && !positions.empty())
    {
        std::uint32_t newCoveredPositions = 0;
        for (const PositionRange& position : positions)
        {
            const std::uint32_t Length = std::max<std::uint32_t>(1, position.Length);
            for (std::uint32_t delta = 0; delta < Length; ++delta)
            {
                const std::uint64_t Key = (static_cast<std::uint64_t>(position.Field) << 56)
                                          | static_cast<std::uint64_t>(position.Position + delta);
                if (coveredPositions->insert(Key).second)
                {
                    ++newCoveredPositions;
                }
            }
        }

        const double MaxFieldBoost = titleTf > 0 ? KTitleBoost : KBodyBoost;
        positionalContribution =
            std::min(positionalContribution, static_cast<double>(newCoveredPositions) * MaxFieldBoost);
    }

    return MetaContribution + positionalContribution;
}

} // namespace

extern "C"
{
    std::uint8_t* alloc_buffer(int size)
    {
        if (size <= 0)
        {
            return nullptr;
        }

        return static_cast<std::uint8_t*>(std::malloc(static_cast<std::size_t>(size)));
    }

    void free_buffer(void* ptr)
    {
        std::free(ptr);
    }

    int load_search_index(const std::uint8_t* data, int length)
    {
        ClearError();
        t_lastResult.clear();

        if (data == nullptr || length <= 0)
        {
            SetError(ErrorCode::PackagePayloadEmpty);
            return 0;
        }

        if (!ParsePackage(data, length))
        {
            return 0;
        }

        return 1;
    }

    int load_search_entry(int kindRaw, int roleRaw, const std::uint8_t* data, int length)
    {
        ClearError();
        t_lastResult.clear();

        if (!t_state.Loaded)
        {
            SetError(ErrorCode::IndexNotLoaded);
            return 0;
        }

        if (data == nullptr || length <= 0)
        {
            SetError(ErrorCode::PackagePayloadEmpty);
            return 0;
        }

        const auto Kind = static_cast<EntryKind>(static_cast<std::uint32_t>(kindRaw));
        const auto Role = static_cast<ShardRole>(static_cast<std::uint32_t>(roleRaw));
        if (Kind != EntryKind::Shard && Kind != EntryKind::Patch)
        {
            SetError(ErrorCode::PackageHeaderInvalid);
            return 0;
        }

        if (!ApplySearchEntry(Kind, Role, data, length))
        {
            return 0;
        }

        return 1;
    }

    int search_articles(const std::uint8_t* queryPtr, int queryLen, int sortMode, int page, int pageSize)
    {
        ClearError();
        t_lastResult.clear();

        if (!t_state.Loaded)
        {
            SetError(ErrorCode::IndexNotLoaded);
            return 0;
        }

        if (queryPtr == nullptr || queryLen <= 0)
        {
            BuildBinaryPage({}, static_cast<std::size_t>(page), static_cast<std::size_t>(pageSize));
            return 1;
        }

        const std::string Query(reinterpret_cast<const char*>(queryPtr), static_cast<std::size_t>(queryLen));
        std::vector<std::uint32_t> hashes = TokenizeQueryHashes(Query);
        if (hashes.empty())
        {
            BuildBinaryPage({}, static_cast<std::size_t>(page), static_cast<std::size_t>(pageSize));
            return 1;
        }

        const std::size_t DocCount = t_state.Docs.size();
        if (t_bm25Scores.size() < DocCount)
        {
            t_bm25Scores.resize(DocCount, 0.0);
        }
        if (t_scoreGeneration.size() < DocCount)
        {
            t_scoreGeneration.resize(DocCount, 0);
        }
        ++t_currentScoreGeneration;
        if (t_currentScoreGeneration == 0)
        {
            std::fill(t_scoreGeneration.begin(), t_scoreGeneration.end(), 0);
            t_currentScoreGeneration = 1;
        }
        t_touchedDocs.clear();
        t_touchedDocs.reserve(std::min<std::size_t>(DocCount, 512));

        const auto NowMs =
            std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
                .count();

        std::unordered_map<std::uint32_t, std::unordered_set<std::uint32_t>> tombstonesByRole;
        std::unordered_map<std::uint32_t, std::unordered_set<std::uint64_t>> coveredPositionsByDoc;
        for (const ShardState& shard : t_state.Shards)
        {
            if (shard.IsPatch)
            {
                tombstonesByRole[static_cast<std::uint32_t>(shard.Role)].insert(shard.Tombstones.begin(),
                                                                                shard.Tombstones.end());
            }
        }

        for (const ShardState& shard : t_state.Shards)
        {
            const auto TombstoneIt = tombstonesByRole.find(static_cast<std::uint32_t>(shard.Role));
            const std::unordered_set<std::uint32_t>* tombstones =
                TombstoneIt == tombstonesByRole.end() ? nullptr : &TombstoneIt->second;

            for (std::uint32_t hash : hashes)
            {
                const TermEntry* term = FindTerm(shard, hash);
                if (term == nullptr || term->PostingOffset + term->PostingLength > shard.PostingsBlob.size())
                {
                    continue;
                }

                const auto* cursor = shard.PostingsBlob.data() + term->PostingOffset;
                const auto* end = cursor + term->PostingLength;
                std::uint32_t postingCount = ReadVint(cursor, end);
                if (!t_lastError.empty())
                {
                    return 0;
                }

                std::uint32_t articleId = 0;
                for (std::uint32_t i = 0; i < postingCount; ++i)
                {
                    articleId += ReadVint(cursor, end);
                    if (cursor + 3 > end || !t_lastError.empty())
                    {
                        return 0;
                    }

                    const std::uint8_t TitleTf = *cursor++;
                    const std::uint8_t MetaTf = *cursor++;
                    const std::uint8_t BodyTf = *cursor++;
                    const std::uint32_t PositionCount = ReadVint(cursor, end);
                    if (!t_lastError.empty())
                    {
                        return 0;
                    }

                    std::vector<PositionRange> positions;
                    positions.reserve(PositionCount);
                    std::uint32_t previousPosition = 0;
                    for (std::uint32_t p = 0; p < PositionCount; ++p)
                    {
                        previousPosition += ReadVint(cursor, end);
                        const std::uint32_t PositionLength = ReadVint(cursor, end);
                        const std::uint32_t Field = ReadVint(cursor, end);
                        if (!t_lastError.empty())
                        {
                            return 0;
                        }
                        positions.push_back(PositionRange{previousPosition,
                                                          PositionLength == 0 ? 1u : PositionLength,
                                                          static_cast<std::uint8_t>(Field)});
                    }

                    if (tombstones && tombstones->contains(articleId) && !shard.IsPatch)
                    {
                        continue;
                    }

                    auto docIt = t_state.DocIndexByArticle.find(articleId);
                    if (docIt == t_state.DocIndexByArticle.end())
                    {
                        continue;
                    }

                    const std::uint32_t DocIndex = docIt->second;
                    const SearchDoc& doc = t_state.Docs[DocIndex];
                    std::unordered_set<std::uint64_t>* coveredPositions = nullptr;
                    if (term->HasPositions && !positions.empty())
                    {
                        coveredPositions = &coveredPositionsByDoc[DocIndex];
                    }

                    const double Tf = ComputeEffectiveTf(TitleTf, MetaTf, BodyTf, *term, positions, coveredPositions);
                    if (Tf <= 0.0)
                    {
                        continue;
                    }

                    const double AvgDocLength = shard.AvgDocLength > 0.0f ? static_cast<double>(shard.AvgDocLength)
                                                                          : static_cast<double>(t_state.AvgDocLength);
                    const double Norm =
                        Tf
                        + KBm25K1
                              * (1.0 - KBm25B
                                 + KBm25B * (static_cast<double>(doc.DocLength) / std::max(1.0, AvgDocLength)));
                    const double Contribution = static_cast<double>(term->Idf) * ((Tf * (KBm25K1 + 1.0)) / Norm);

                    if (t_scoreGeneration[DocIndex] != t_currentScoreGeneration)
                    {
                        t_scoreGeneration[DocIndex] = t_currentScoreGeneration;
                        t_bm25Scores[DocIndex] = 0.0;
                        t_touchedDocs.push_back(DocIndex);
                    }
                    t_bm25Scores[DocIndex] += Contribution;
                }
            }
        }

        std::vector<ScoreEntry> scores;
        scores.reserve(t_touchedDocs.size());
        for (std::uint32_t docIndex : t_touchedDocs)
        {
            ScoreEntry entry{};
            entry.DocIndex = docIndex;
            entry.Bm25 = t_bm25Scores[docIndex];
            const SearchDoc& doc = t_state.Docs[docIndex];
            entry.Hot = ComputeHotScore(doc, NowMs);
            entry.FinalScore = entry.Bm25 * KWeightRelevance + entry.Hot * KWeightHotness;

            if (hashes.size() > 1)
            {
                for (const ShardState& shard : t_state.Shards)
                {
                    const auto TombstoneIt = tombstonesByRole.find(static_cast<std::uint32_t>(shard.Role));
                    const std::unordered_set<std::uint32_t>* tombstones =
                        TombstoneIt == tombstonesByRole.end() ? nullptr : &TombstoneIt->second;
                    if (tombstones && tombstones->contains(doc.ArticleId) && !shard.IsPatch)
                    {
                        continue;
                    }

                    std::vector<const TermEntry*> phraseTerms;
                    phraseTerms.reserve(hashes.size());
                    for (std::uint32_t hash : hashes)
                    {
                        phraseTerms.push_back(FindTerm(shard, hash));
                    }

                    entry.FinalScore += ComputePhraseBonus(phraseTerms, shard, doc.ArticleId);
                }
            }

            scores.push_back(entry);
        }

        OrderScoresForPage(scores, static_cast<std::size_t>(page), static_cast<std::size_t>(pageSize), sortMode);

        BuildBinaryPage(scores, static_cast<std::size_t>(page), static_cast<std::size_t>(pageSize));
        return 1;
    }

    const char* get_last_result_ptr()
    {
        return t_lastResult.c_str();
    }

    int get_last_result_len()
    {
        return static_cast<int>(t_lastResult.size());
    }

    const char* get_last_error_ptr()
    {
        return t_lastError.c_str();
    }

    int get_last_error_len()
    {
        return static_cast<int>(t_lastError.size());
    }

    int get_last_error_code()
    {
        return static_cast<int>(t_lastErrorCode);
    }
}
