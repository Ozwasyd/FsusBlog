#pragma once

#include <cstddef>
#include <cstdint>

namespace fsusblog::pod {

#pragma pack(push, 1)
struct Utf8SliceRef {
  std::int32_t offset;
  std::int32_t length;
};

struct ArticleCategoryViewPod {
  std::int32_t id;
  std::uint8_t name[128];
};

struct ArticleDetailPod {
  std::int32_t id;
  std::int32_t views;
  std::int64_t create_time_unix_ms;
  ArticleCategoryViewPod category;
  std::uint8_t title[256];
  Utf8SliceRef summary;
  Utf8SliceRef content;
};

struct TagPod {
  std::int32_t id;
  std::uint8_t name[128];
};
#pragma pack(pop)

static_assert(sizeof(Utf8SliceRef) == 8, "Utf8SliceRef size mismatch");
static_assert(sizeof(ArticleCategoryViewPod) == 132, "ArticleCategoryViewPod size mismatch");
static_assert(sizeof(ArticleDetailPod) == 420, "ArticleDetailPod size mismatch");
static_assert(sizeof(TagPod) == 132, "TagPod size mismatch");

struct ParsedArticleDetail {
  std::int32_t article_id;
  std::int32_t views;
  std::int64_t create_time_unix_ms;
  std::int32_t category_id;
  std::int32_t tag_count;
  const std::uint8_t* payload_ptr;
  std::int32_t payload_len;
};

bool parse_article_detail_payload(const std::uint8_t* payload, std::size_t payload_len, ParsedArticleDetail* out_result);

} // namespace fsusblog::pod
