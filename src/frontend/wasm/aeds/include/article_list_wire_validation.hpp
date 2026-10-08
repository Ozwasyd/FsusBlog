#pragma once
#include <cstring>
#include "aeds_article_list_wire.generated.hpp"

namespace FsusBlog::AedsWire
{
struct ArticleListPayloadView
{
    std::int32_t total;
    std::int32_t count;
    const std::uint8_t* blob;
    std::size_t blobLength;
    const std::uint8_t* records;
};

inline std::int32_t ArticleListInt32(const std::uint8_t* bytes, std::size_t offset)
{
    std::int32_t value;
    std::memcpy(&value, bytes + offset, sizeof(value));
    return value;
}

inline std::int64_t ArticleListInt64(const std::uint8_t* bytes, std::size_t offset)
{
    std::int64_t value;
    std::memcpy(&value, bytes + offset, sizeof(value));
    return value;
}

inline bool ArticleListUtf8(const std::uint8_t* bytes, std::size_t length)
{
    for (std::size_t index = 0; index < length;)
    {
        const auto first = bytes[index++];
        if (first < 0x80u) continue;
        const std::size_t continuation = first >= 0xc2u && first <= 0xdfu ? 1u
            : first >= 0xe0u && first <= 0xefu ? 2u : first >= 0xf0u && first <= 0xf4u ? 3u : 0u;
        if (continuation == 0u || continuation > length - index) return false;
        const auto second = bytes[index];
        if ((first == 0xe0u && second < 0xa0u) || (first == 0xedu && second >= 0xa0u)
            || (first == 0xf0u && second < 0x90u) || (first == 0xf4u && second >= 0x90u)) return false;
        for (std::size_t tail = 0; tail < continuation; ++tail)
            if ((bytes[index++] & 0xc0u) != 0x80u) return false;
    }
    return true;
}

inline bool ValidateArticleListPayload(const std::uint8_t* bytes, std::size_t length, ArticleListPayloadView& out)
{
    if (bytes == nullptr || length < 29u || ArticleListInt32(bytes, 0) != ArticleListCursorMagic
        || ArticleListInt32(bytes, 4) != ArticleListCursorVersion || bytes[8] > 1u) return false;
    const auto total = ArticleListInt32(bytes, 9);
    const auto cursorLength = ArticleListInt32(bytes, 13);
    if (total < 0 || cursorLength < 0 || cursorLength > 512 || static_cast<std::size_t>(cursorLength) > length - 29u
        || (bytes[8] == 1u) != (cursorLength != 0)) return false;
    for (std::int32_t i = 0; i < cursorLength; ++i)
    {
        const auto ch = bytes[17u + static_cast<std::size_t>(i)];
        if (!((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
            || ch == '_' || ch == '-')) return false;
    }
    const auto header = 17u + static_cast<std::size_t>(cursorLength);
    const auto count = ArticleListInt32(bytes, header);
    const auto tagCount = ArticleListInt32(bytes, header + 4u);
    const auto blobLength = ArticleListInt32(bytes, header + 8u);
    if (count < 0 || tagCount < 0 || blobLength < 0) return false;
    const auto blobStart = header + 12u;
    if (static_cast<std::size_t>(blobLength) > length - blobStart) return false;
    const auto recordStart = blobStart + static_cast<std::size_t>(blobLength);
    const auto remaining = length - recordStart;
    if (static_cast<std::uint64_t>(count) * ArticleListRecordBytes
        + static_cast<std::uint64_t>(tagCount) * ArticleListTagRecordBytes != remaining) return false;
    const auto* blob = bytes + blobStart;
    const auto sliceValid = [blob, blobLength](const std::uint8_t* record, std::size_t offset)
    {
        const auto start = ArticleListInt32(record, offset);
        const auto size = ArticleListInt32(record, offset + 4u);
        return start >= 0 && size >= 0 && start <= blobLength && size <= blobLength - start
            && ArticleListUtf8(blob + start, static_cast<std::size_t>(size));
    };
    for (std::int32_t i = 0; i < count; ++i)
    {
        const auto* record = bytes + recordStart + static_cast<std::size_t>(i) * ArticleListRecordBytes;
        const auto start = ArticleListInt32(record, ArticleListTagStartOffset);
        const auto size = ArticleListInt32(record, ArticleListTagCountOffset);
        const auto revisionId = ArticleListInt64(record, ArticleListCurrentRevisionIdOffset);
        const auto revisionNo = ArticleListInt32(record, ArticleListRevisionNoOffset);
        const auto publicationId = ArticleListInt64(record, ArticleListCurrentPublicationIdOffset);
        const auto publicationNo = ArticleListInt32(record, ArticleListPublicationNoOffset);
        if (start < 0 || size < 0 || start > tagCount || size > tagCount - start
            || record[ArticleListIsDeletedOffset] > 1u || record[ArticleListHasIsDeletedOffset] > 1u
            || record[ArticleListReserved0Offset] != 0u || record[ArticleListReserved1Offset] != 0u
            || revisionId <= 0 || revisionNo <= 0 || publicationId < 0 || publicationNo < 0
            || (publicationId == 0) != (publicationNo == 0)
            || !sliceValid(record, ArticleListCategoryNameOffset) || !sliceValid(record, ArticleListTitleOffset)
            || !sliceValid(record, ArticleListSummaryOffset)) return false;
    }
    const auto* tags = bytes + recordStart + static_cast<std::size_t>(count) * ArticleListRecordBytes;
    for (std::int32_t i = 0; i < tagCount; ++i)
        if (!sliceValid(tags + static_cast<std::size_t>(i) * ArticleListTagRecordBytes, 4u)) return false;
    out = {total, count, blob, static_cast<std::size_t>(blobLength), bytes + recordStart};
    return true;
}
}
