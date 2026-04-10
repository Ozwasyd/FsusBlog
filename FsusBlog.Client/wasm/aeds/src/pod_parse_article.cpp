#include "pod_views.hpp"

#include <cstring>

namespace fsusblog::pod {

namespace {

bool read_i32(const std::uint8_t* src, std::size_t len, std::size_t* offset, std::int32_t* out) {
  if (*offset + sizeof(std::int32_t) > len) {
    return false;
  }

  std::int32_t value = 0;
  std::memcpy(&value, src + *offset, sizeof(std::int32_t));
  *offset += sizeof(std::int32_t);
  *out = value;
  return true;
}

} // namespace

bool parse_article_detail_payload(const std::uint8_t* payload, std::size_t payload_len, ParsedArticleDetail* out_result) {
  if (payload == nullptr || out_result == nullptr) {
    return false;
  }

  if (payload_len < sizeof(ArticleDetailPod) + sizeof(std::int32_t) + sizeof(std::int32_t) + 1u) {
    return false;
  }

  const auto* pod = reinterpret_cast<const ArticleDetailPod*>(payload);
  std::size_t offset = sizeof(ArticleDetailPod);

  std::int32_t tag_count = 0;
  if (!read_i32(payload, payload_len, &offset, &tag_count) || tag_count < 0) {
    return false;
  }

  const std::size_t tags_bytes = static_cast<std::size_t>(tag_count) * sizeof(TagPod);
  if (offset + tags_bytes + sizeof(std::int32_t) + 1u > payload_len) {
    return false;
  }

  offset += tags_bytes;

  std::int32_t text_blob_len = 0;
  if (!read_i32(payload, payload_len, &offset, &text_blob_len) || text_blob_len < 0) {
    return false;
  }

  if (offset + static_cast<std::size_t>(text_blob_len) + 1u != payload_len) {
    return false;
  }

  out_result->article_id = pod->id;
  out_result->views = pod->views;
  out_result->create_time_unix_ms = pod->create_time_unix_ms;
  out_result->category_id = pod->category.id;
  out_result->tag_count = tag_count;
  out_result->payload_ptr = payload + offset;
  out_result->payload_len = text_blob_len;
  return true;
}

} // namespace fsusblog::pod
