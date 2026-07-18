#pragma once

#include <cstddef>
#include <cstdint>

namespace fsusblog::pod
{

#pragma pack(push, 1)

struct Utf8SliceRef
{
    std::int32_t offset;
    std::int32_t length;
};

struct ArticleCategoryViewPod
{
    std::int32_t id;
    std::uint8_t name[128];
};

struct ArticleDetailPod
{
    std::int32_t id;
    std::int32_t views;
    std::int64_t create_time_unix_ms;
    std::int32_t reserved0;
    ArticleCategoryViewPod category;
    std::uint8_t title[256];
    Utf8SliceRef summary;
    Utf8SliceRef content;
};

struct ArticleDetailV4HeaderPod
{
    std::uint32_t magic;
    std::int32_t version;
    std::uint32_t flags;
    std::int32_t article_record_offset;
    std::int32_t article_record_length;
    std::int32_t tag_offset;
    std::int32_t tag_count;
    std::int32_t rights_record_offset;
    std::int32_t rights_record_length;
    std::int32_t blob_offset;
    std::int32_t blob_length;
};

struct ArticleDetailV3RecordPod
{
    std::int32_t id;
    std::int32_t views;
    std::int64_t create_time_unix_ms;
    std::int32_t category_id;
    std::int32_t status;
    std::int64_t scheduled_publish_at_unix_ms;
    std::int64_t published_at_unix_ms;
    std::uint8_t is_deleted;
    std::uint8_t reserved0;
    std::uint16_t reserved1;
    Utf8SliceRef title;
    Utf8SliceRef content;
    Utf8SliceRef summary;
    Utf8SliceRef cover_image_url;
    Utf8SliceRef category_name;
};

struct ArticleDetailV4RecordPod
{
    std::int32_t id;
    std::int32_t views;
    std::int64_t create_time_unix_ms;
    std::int32_t category_id;
    std::int32_t status;
    std::int64_t scheduled_publish_at_unix_ms;
    std::int64_t published_at_unix_ms;
    std::int64_t updated_at_unix_ms;
    std::uint8_t is_deleted;
    std::uint8_t reserved0;
    std::uint16_t reserved1;
    Utf8SliceRef title;
    Utf8SliceRef content;
    Utf8SliceRef summary;
    Utf8SliceRef cover_image_url;
    Utf8SliceRef category_name;
};

struct TagPod
{
    std::int32_t id;
    std::uint8_t name[128];
};

#pragma pack(pop)

static_assert(sizeof(Utf8SliceRef) == 8, "Utf8SliceRef size mismatch");
static_assert(sizeof(ArticleCategoryViewPod) == 132, "ArticleCategoryViewPod size mismatch");
static_assert(sizeof(ArticleDetailPod) == 424, "ArticleDetailPod size mismatch");
static_assert(sizeof(ArticleDetailV4HeaderPod) == 44, "ArticleDetailV4HeaderPod size mismatch");
static_assert(sizeof(ArticleDetailV3RecordPod) == 84, "ArticleDetailV3RecordPod size mismatch");
static_assert(sizeof(ArticleDetailV4RecordPod) == 92, "ArticleDetailV4RecordPod size mismatch");
static_assert(sizeof(TagPod) == 132, "TagPod size mismatch");

struct ParsedArticleDetail
{
    std::int32_t article_id;
    std::int32_t views;
    std::int64_t create_time_unix_ms;
    std::int32_t category_id;
    std::int32_t tag_count;
    std::int64_t published_at_unix_ms;
    std::int64_t updated_at_unix_ms;
    Utf8SliceRef title;
    Utf8SliceRef category_name;
    const std::uint8_t* payload_ptr;
    std::int32_t payload_len;
};

bool parse_article_detail_payload(const std::uint8_t* payload,
                                  std::size_t payload_len,
                                  ParsedArticleDetail* out_result);

} // namespace fsusblog::pod
