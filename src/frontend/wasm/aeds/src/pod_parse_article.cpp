#include <cstring>

#include "aeds_article_list_wire.generated.hpp"
#include "pod_views.hpp"

namespace FsusBlog::Pod
{

static_assert(AedsWire::ArticleListRecordBytes == 100u);
static_assert(AedsWire::ArticleListTitleOffset == 28u);
static_assert(AedsWire::ArticleListCurrentRevisionIdOffset == 76u);

namespace
{

constexpr std::uint32_t KArticleDetailV3Magic = 0x41524433u;
constexpr std::int32_t KArticleDetailV3Version = 3;
constexpr std::uint32_t KArticleDetailV4Magic = 0x41524434u;
constexpr std::int32_t KArticleDetailV4Version = 4;
constexpr std::uint32_t KArticleDetailV5Magic = 0x41524435u;
constexpr std::int32_t KArticleDetailV5Version = 5;
constexpr std::int32_t KArticleDetailTagRecordSize = 12;
constexpr std::int32_t KArticleRightsV3RecordSize = 112;

bool ValidRange(std::int32_t offset, std::int32_t length, std::size_t total)
{
    return offset >= 0 && length >= 0 && static_cast<std::size_t>(offset) <= total
           && static_cast<std::size_t>(length) <= total - static_cast<std::size_t>(offset);
}

bool ValidSlice(const Utf8SliceRef& slice, std::int32_t blobLength)
{
    return ValidRange(slice.offset, slice.length, static_cast<std::size_t>(blobLength));
}

} // namespace

bool ParseArticleDetailPayload(const std::uint8_t* payload, std::size_t payloadLen, ParsedArticleDetail* outResult)
{
    if (payload == nullptr || outResult == nullptr)
    {
        return false;
    }

    if (payloadLen < sizeof(ArticleDetailV4HeaderPod) + sizeof(ArticleDetailV3RecordPod)
                         + static_cast<std::size_t>(KArticleRightsV3RecordSize))
    {
        return false;
    }

    ArticleDetailV4HeaderPod header{};
    std::memcpy(&header, payload, sizeof(header));
    const bool IsV4 = header.magic == KArticleDetailV4Magic && header.version == KArticleDetailV4Version;
    const bool IsV5 = header.magic == KArticleDetailV5Magic && header.version == KArticleDetailV5Version;
    const bool IsV3 = header.magic == KArticleDetailV3Magic && header.version == KArticleDetailV3Version;
    const std::int32_t ExpectedRecordSize = IsV5 ? static_cast<std::int32_t>(sizeof(ArticleDetailV5RecordPod))
        : IsV4 ? static_cast<std::int32_t>(sizeof(ArticleDetailV4RecordPod))
               : static_cast<std::int32_t>(sizeof(ArticleDetailV3RecordPod));
    if ((!IsV3 && !IsV4 && !IsV5) || header.flags != 0u || header.tag_count < 0
        || header.article_record_offset != static_cast<std::int32_t>(sizeof(ArticleDetailV4HeaderPod))
        || header.article_record_length != ExpectedRecordSize
        || header.rights_record_length != KArticleRightsV3RecordSize)
    {
        return false;
    }

    if (header.tag_count
        > static_cast<std::int32_t>(payloadLen / static_cast<std::size_t>(KArticleDetailTagRecordSize)))
    {
        return false;
    }

    const std::int32_t TagBytes = header.tag_count * KArticleDetailTagRecordSize;
    if (header.tag_offset != header.article_record_offset + header.article_record_length
        || header.rights_record_offset != header.tag_offset + TagBytes
        || header.blob_offset != header.rights_record_offset + header.rights_record_length
        || !ValidRange(header.article_record_offset, header.article_record_length, payloadLen)
        || !ValidRange(header.tag_offset, TagBytes, payloadLen)
        || !ValidRange(header.rights_record_offset, header.rights_record_length, payloadLen)
        || !ValidRange(header.blob_offset, header.blob_length, payloadLen)
        || static_cast<std::size_t>(header.blob_offset) + static_cast<std::size_t>(header.blob_length) != payloadLen)
    {
        return false;
    }

    ArticleDetailV5RecordPod article{};
    if (IsV5)
    {
        std::memcpy(&article, payload + header.article_record_offset, sizeof(article));
    }
    else if (IsV4)
    {
        ArticleDetailV4RecordPod v4{};
        std::memcpy(&v4, payload + header.article_record_offset, sizeof(v4));
        article.id = v4.id;
        article.views = v4.views;
        article.create_time_unix_ms = v4.create_time_unix_ms;
        article.category_id = v4.category_id;
        article.status = v4.status;
        article.scheduled_publish_at_unix_ms = v4.scheduled_publish_at_unix_ms;
        article.published_at_unix_ms = v4.published_at_unix_ms;
        article.updated_at_unix_ms = v4.updated_at_unix_ms;
        article.is_deleted = v4.is_deleted;
        article.title = v4.title;
        article.content = v4.content;
        article.summary = v4.summary;
        article.cover_image_url = v4.cover_image_url;
        article.category_name = v4.category_name;
    }
    else
    {
        ArticleDetailV3RecordPod legacy{};
        std::memcpy(&legacy, payload + header.article_record_offset, sizeof(legacy));
        article.id = legacy.id;
        article.views = legacy.views;
        article.create_time_unix_ms = legacy.create_time_unix_ms;
        article.category_id = legacy.category_id;
        article.status = legacy.status;
        article.scheduled_publish_at_unix_ms = legacy.scheduled_publish_at_unix_ms;
        article.published_at_unix_ms = legacy.published_at_unix_ms;
        article.updated_at_unix_ms = 0;
        article.is_deleted = legacy.is_deleted;
        article.title = legacy.title;
        article.content = legacy.content;
        article.summary = legacy.summary;
        article.cover_image_url = legacy.cover_image_url;
        article.category_name = legacy.category_name;
    }

    if (article.is_deleted > 1u || !ValidSlice(article.title, header.blob_length)
        || !ValidSlice(article.content, header.blob_length) || !ValidSlice(article.summary, header.blob_length)
        || !ValidSlice(article.cover_image_url, header.blob_length)
        || !ValidSlice(article.category_name, header.blob_length))
    {
        return false;
    }

    outResult->article_id = article.id;
    outResult->views = article.views;
    outResult->create_time_unix_ms = article.create_time_unix_ms;
    outResult->category_id = article.category_id;
    outResult->tag_count = header.tag_count;
    outResult->published_at_unix_ms = article.published_at_unix_ms;
    outResult->updated_at_unix_ms = article.updated_at_unix_ms;
    outResult->current_revision_id = article.current_revision_id;
    outResult->revision_no = article.revision_no;
    outResult->current_publication_id = article.current_publication_id;
    outResult->publication_no = article.publication_no;
    outResult->title = article.title;
    outResult->category_name = article.category_name;
    outResult->payload_ptr = payload + header.blob_offset;
    outResult->payload_len = header.blob_length;
    return true;
}

} // namespace FsusBlog::Pod
