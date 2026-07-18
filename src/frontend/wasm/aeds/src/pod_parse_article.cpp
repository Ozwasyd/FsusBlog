#include <cstring>

#include "pod_views.hpp"

namespace fsusblog::pod
{

namespace
{

constexpr std::uint32_t kArticleDetailV3Magic = 0x41524433u;
constexpr std::int32_t kArticleDetailV3Version = 3;
constexpr std::uint32_t kArticleDetailV4Magic = 0x41524434u;
constexpr std::int32_t kArticleDetailV4Version = 4;
constexpr std::int32_t kArticleDetailTagRecordSize = 12;
constexpr std::int32_t kArticleRightsV3RecordSize = 112;

bool valid_range(std::int32_t offset, std::int32_t length, std::size_t total)
{
    return offset >= 0 && length >= 0 && static_cast<std::size_t>(offset) <= total
           && static_cast<std::size_t>(length) <= total - static_cast<std::size_t>(offset);
}

bool valid_slice(const Utf8SliceRef& slice, std::int32_t blob_length)
{
    return valid_range(slice.offset, slice.length, static_cast<std::size_t>(blob_length));
}

} // namespace

bool parse_article_detail_payload(const std::uint8_t* payload, std::size_t payload_len, ParsedArticleDetail* out_result)
{
    if (payload == nullptr || out_result == nullptr)
    {
        return false;
    }

    if (payload_len < sizeof(ArticleDetailV4HeaderPod) + sizeof(ArticleDetailV3RecordPod)
                          + static_cast<std::size_t>(kArticleRightsV3RecordSize))
    {
        return false;
    }

    ArticleDetailV4HeaderPod header{};
    std::memcpy(&header, payload, sizeof(header));
    const bool is_v4 = header.magic == kArticleDetailV4Magic && header.version == kArticleDetailV4Version;
    const bool is_v3 = header.magic == kArticleDetailV3Magic && header.version == kArticleDetailV3Version;
    const std::int32_t expected_record_size = is_v4 ? static_cast<std::int32_t>(sizeof(ArticleDetailV4RecordPod))
                                                    : static_cast<std::int32_t>(sizeof(ArticleDetailV3RecordPod));
    if ((!is_v3 && !is_v4) || header.flags != 0u || header.tag_count < 0
        || header.article_record_offset != static_cast<std::int32_t>(sizeof(ArticleDetailV4HeaderPod))
        || header.article_record_length != expected_record_size
        || header.rights_record_length != kArticleRightsV3RecordSize)
    {
        return false;
    }

    if (header.tag_count
        > static_cast<std::int32_t>(payload_len / static_cast<std::size_t>(kArticleDetailTagRecordSize)))
    {
        return false;
    }

    const std::int32_t tag_bytes = header.tag_count * kArticleDetailTagRecordSize;
    if (header.tag_offset != header.article_record_offset + header.article_record_length
        || header.rights_record_offset != header.tag_offset + tag_bytes
        || header.blob_offset != header.rights_record_offset + header.rights_record_length
        || !valid_range(header.article_record_offset, header.article_record_length, payload_len)
        || !valid_range(header.tag_offset, tag_bytes, payload_len)
        || !valid_range(header.rights_record_offset, header.rights_record_length, payload_len)
        || !valid_range(header.blob_offset, header.blob_length, payload_len)
        || static_cast<std::size_t>(header.blob_offset) + static_cast<std::size_t>(header.blob_length) != payload_len)
    {
        return false;
    }

    ArticleDetailV4RecordPod article{};
    if (is_v4)
    {
        std::memcpy(&article, payload + header.article_record_offset, sizeof(article));
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

    if (article.is_deleted > 1u || !valid_slice(article.title, header.blob_length)
        || !valid_slice(article.content, header.blob_length) || !valid_slice(article.summary, header.blob_length)
        || !valid_slice(article.cover_image_url, header.blob_length)
        || !valid_slice(article.category_name, header.blob_length))
    {
        return false;
    }

    out_result->article_id = article.id;
    out_result->views = article.views;
    out_result->create_time_unix_ms = article.create_time_unix_ms;
    out_result->category_id = article.category_id;
    out_result->tag_count = header.tag_count;
    out_result->published_at_unix_ms = article.published_at_unix_ms;
    out_result->updated_at_unix_ms = article.updated_at_unix_ms;
    out_result->title = article.title;
    out_result->category_name = article.category_name;
    out_result->payload_ptr = payload + header.blob_offset;
    out_result->payload_len = header.blob_length;
    return true;
}

} // namespace fsusblog::pod
