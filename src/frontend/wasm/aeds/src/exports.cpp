#include "aeds_decode.hpp"

#include <array>
#include <cstddef>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <string>
#include <vector>

namespace {

thread_local std::array<char, 128> g_error{};
thread_local std::vector<std::uint8_t> g_payload_storage{};
thread_local std::uint32_t g_payload_len = 0;
thread_local std::uint16_t g_frame_type = 0;
thread_local std::uint8_t g_error_code = 0;
thread_local std::string g_last_html{};
constexpr std::size_t kArticleListRecordSize = 56u;
constexpr std::size_t kCompactTagRecordSize = 12u;
constexpr std::size_t kTagPodSize = 132u;
constexpr std::size_t kCommentItemPodSize = 88u;
constexpr std::size_t kUserCommentPodSize = 524u;
constexpr std::size_t kSiteStatsPodSize = 72u;
constexpr std::size_t kCompactPopularRecordSize = 16u;
constexpr std::size_t kRecentCommentRecordSize = 32u;
constexpr std::size_t kRegionDistributionRecordSize = 12u;
constexpr std::size_t kRecentCommentPodSize = 88u;
constexpr std::size_t kRegionDistributionPodSize = 132u;

void set_error(const char* err) {
  g_error.fill('\0');
  if (err == nullptr) {
    return;
  }

  const std::size_t max_copy = g_error.size() - 1u;
  std::strncpy(g_error.data(), err, max_copy);
  g_error[max_copy] = '\0';
}

void append_literal(std::string& out, const char* value) {
  if (value != nullptr) {
    out.append(value);
  }
}

void append_int(std::string& out, std::int64_t value) {
  char buffer[32]{};
  const int len = std::snprintf(buffer, sizeof(buffer), "%lld", static_cast<long long>(value));
  if (len > 0) {
    out.append(buffer, static_cast<std::size_t>(len));
  }
}

void append_u32(std::string& out, std::uint32_t value) {
  char buffer[24]{};
  const int len = std::snprintf(buffer, sizeof(buffer), "%u", static_cast<unsigned>(value));
  if (len > 0) {
    out.append(buffer, static_cast<std::size_t>(len));
  }
}

void append_escaped_ascii(std::string& out, const std::uint8_t* bytes, std::size_t len) {
  if (bytes == nullptr || len == 0) {
    return;
  }

  for (std::size_t i = 0; i < len && bytes[i] != 0; ++i) {
    const char ch = static_cast<char>(bytes[i]);
    switch (ch) {
      case '&':
        out.append("&amp;");
        break;
      case '<':
        out.append("&lt;");
        break;
      case '>':
        out.append("&gt;");
        break;
      case '"':
        out.append("&quot;");
        break;
      default:
        out.push_back(ch);
        break;
    }
  }
}

bool read_i32_le(const std::uint8_t* bytes, std::size_t len, std::size_t offset, std::int32_t& out) {
  if (bytes == nullptr || offset + sizeof(std::int32_t) > len) {
    return false;
  }

  std::memcpy(&out, bytes + offset, sizeof(std::int32_t));
  return true;
}

bool read_i64_le(const std::uint8_t* bytes, std::size_t len, std::size_t offset, std::int64_t& out) {
  if (bytes == nullptr || offset + sizeof(std::int64_t) > len) {
    return false;
  }

  std::memcpy(&out, bytes + offset, sizeof(std::int64_t));
  return true;
}

bool read_slice_ref(const std::uint8_t* bytes, std::size_t len, std::size_t offset, std::int32_t& value_offset, std::int32_t& value_len) {
  return read_i32_le(bytes, len, offset, value_offset)
    && read_i32_le(bytes, len, offset + sizeof(std::int32_t), value_len);
}

bool try_read_i32_advance(const std::uint8_t* bytes, std::size_t len, std::size_t& offset, std::int32_t& out) {
  if (!read_i32_le(bytes, len, offset, out)) {
    return false;
  }

  offset += sizeof(std::int32_t);
  return true;
}

bool skip_bytes(std::size_t& offset, std::size_t len, std::size_t count) {
  if (offset + count > len) {
    return false;
  }

  offset += count;
  return true;
}

void begin_panel(const char* title) {
  g_last_html.clear();
  g_last_html.reserve(1024);
  append_literal(g_last_html, "<section class=\"aot-panel\"><div class=\"aot-panel__header\"><strong>");
  append_literal(g_last_html, title);
  append_literal(g_last_html, "</strong></div><div class=\"aot-panel__body\">");
}

void end_panel() {
  append_literal(g_last_html, "</div></section>");
}

void append_blob_slice(std::string& out,
                       const std::uint8_t* blob,
                       std::size_t blob_len,
                       std::int32_t value_offset,
                       std::int32_t value_len) {
  if (blob == nullptr || value_offset < 0 || value_len <= 0) {
    return;
  }

  const std::size_t slice_offset = static_cast<std::size_t>(value_offset);
  const std::size_t slice_len = static_cast<std::size_t>(value_len);
  if (slice_offset + slice_len > blob_len) {
    return;
  }

  append_escaped_ascii(out, blob + slice_offset, slice_len);
}

int render_article_detail_html(const std::uint8_t* payload, std::uint32_t payload_len) {
  if (payload == nullptr || payload_len == 0) {
    set_error("payload_invalid");
    return 0;
  }

  if (payload_len < 420u) {
    set_error("payload_too_short");
    return 0;
  }

  std::int32_t id = 0;
  std::int32_t views = 0;
  std::memcpy(&id, payload + 0, sizeof(std::int32_t));
  std::memcpy(&views, payload + 4, sizeof(std::int32_t));
  const std::uint8_t* category_name = payload + 16;
  const std::uint8_t* title = payload + 148;

  g_last_html.clear();
  g_last_html.reserve(512);
  append_literal(g_last_html, "<article class=\"aot-panel\" data-aot-view=\"article-detail\">");
  append_literal(g_last_html, "<header class=\"aot-panel__header\"><h2>");
  append_escaped_ascii(g_last_html, title, 256);
  append_literal(g_last_html, "</h2></header><section class=\"aot-panel__body\">");
  append_literal(g_last_html, "<p class=\"meta\">#");
  append_int(g_last_html, id);
  append_literal(g_last_html, " · ");
  append_escaped_ascii(g_last_html, category_name, 128);
  append_literal(g_last_html, " · views ");
  append_int(g_last_html, views);
  append_literal(g_last_html, "</p>");
  append_literal(g_last_html, "<button class=\"aot-action-button\" data-aot-action=\"force-binary\">binary</button>");
  append_literal(g_last_html, "</section></article>");
  set_error(nullptr);
  return 1;
}

int render_article_list_html(const std::uint8_t* payload, std::uint32_t payload_len) {
  if (payload == nullptr || payload_len < 16u) {
    set_error("article_list_payload_invalid");
    return 0;
  }

  std::int32_t total = 0;
  std::int32_t count = 0;
  std::int32_t tag_record_count = 0;
  std::int32_t blob_len = 0;
  if (!read_i32_le(payload, payload_len, 0, total)
      || !read_i32_le(payload, payload_len, 4, count)
      || !read_i32_le(payload, payload_len, 8, tag_record_count)
      || !read_i32_le(payload, payload_len, 12, blob_len)
      || count < 0
      || tag_record_count < 0
      || blob_len < 0) {
    set_error("article_list_header_invalid");
    return 0;
  }

  std::size_t cursor = 16u;
  if (cursor + static_cast<std::size_t>(blob_len) > payload_len) {
    set_error("article_list_blob_overflow");
    return 0;
  }
  const std::uint8_t* blob = payload + cursor;
  cursor += static_cast<std::size_t>(blob_len);
  const std::size_t record_bytes = static_cast<std::size_t>(count) * kArticleListRecordSize;
  const std::size_t tag_record_bytes = static_cast<std::size_t>(tag_record_count) * kCompactTagRecordSize;
  if (cursor + record_bytes + tag_record_bytes > payload_len) {
    set_error("article_list_records_overflow");
    return 0;
  }
  const std::uint8_t* records = payload + cursor;

  g_last_html.clear();
  g_last_html.reserve(4096);
  append_literal(g_last_html, "<section class=\"flex flex-col gap-12 sm:gap-20\" data-aot-view=\"article-list\">");

  const int render_limit = count > 12 ? 12 : count;
  for (int i = 0; i < count; ++i) {
    if (i >= render_limit) {
      continue;
    }

    const std::uint8_t* pod = records + static_cast<std::size_t>(i) * kArticleListRecordSize;
    std::int32_t id = 0;
    std::memcpy(&id, pod + 0, sizeof(std::int32_t));

    std::int32_t category_offset = 0;
    std::int32_t category_len = 0;
    std::int32_t title_offset = 0;
    std::int32_t title_len = 0;
    std::int32_t summary_offset = 0;
    std::int32_t summary_len = 0;
    read_slice_ref(pod, kArticleListRecordSize, 20u, category_offset, category_len);
    read_slice_ref(pod, kArticleListRecordSize, 28u, title_offset, title_len);
    read_slice_ref(pod, kArticleListRecordSize, 36u, summary_offset, summary_len);

    append_literal(g_last_html, "<article class=\"group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased border-b border-zinc-100 pb-12 sm:pb-16\">");
    append_literal(g_last_html, "<div class=\"flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase\">");
    append_literal(g_last_html, "<span class=\"text-zinc-600\">");
    append_blob_slice(g_last_html, blob, static_cast<std::size_t>(blob_len), category_offset, category_len);
    append_literal(g_last_html, "</span></div>");

    append_literal(g_last_html, "<h2 class=\"text-xl sm:text-2xl font-bold text-zinc-950 leading-snug transition-colors duration-300 group-hover:text-zinc-500\">");
    append_literal(g_last_html, "<a class=\"block\" href=\"/article/");
    append_int(g_last_html, id);
    append_literal(g_last_html, "\" data-aot-action=\"open-article\" data-aot-id=\"");
    append_int(g_last_html, id);
    append_literal(g_last_html, "\">");
    append_blob_slice(g_last_html, blob, static_cast<std::size_t>(blob_len), title_offset, title_len);
    append_literal(g_last_html, "</a></h2>");

    append_literal(g_last_html, "<p class=\"text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3\">");
    append_blob_slice(g_last_html, blob, static_cast<std::size_t>(blob_len), summary_offset, summary_len);
    append_literal(g_last_html, "</p>");

    append_literal(g_last_html, "<a class=\"mt-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors flex items-center gap-2 py-2 -ml-0.5\" href=\"/article/");
    append_int(g_last_html, id);
    append_literal(g_last_html, "\" data-aot-action=\"open-article\" data-aot-id=\"");
    append_int(g_last_html, id);
    append_literal(g_last_html, "\">阅读<span aria-hidden=\"true\">→</span></a></article>");
  }

  if (count <= 0) {
    append_literal(g_last_html, "<section class=\"py-16 text-sm text-zinc-500\">暂无文章。</section>");
  }

  append_literal(g_last_html, "<nav class=\"pt-2 flex justify-between items-center border-t border-zinc-100\" aria-label=\"文章分页\">");
  append_literal(g_last_html, "<button class=\"text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 hover:text-zinc-950 p-4 -ml-4\" data-aot-action=\"page-prev\">上一页</button>");
  append_literal(g_last_html, "<span class=\"text-xs font-mono font-medium text-zinc-300 tabular-nums\">");
  append_int(g_last_html, count);
  append_literal(g_last_html, " / ");
  append_int(g_last_html, total);
  append_literal(g_last_html, "</span>");
  append_literal(g_last_html, "<button class=\"text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 hover:text-zinc-950 p-4 -mr-4\" data-aot-action=\"page-next\">下一页</button>");
  append_literal(g_last_html, "</nav></section>");
  set_error(nullptr);
  return 1;
}

int render_comment_cursor_html(const std::uint8_t* payload, std::uint32_t payload_len, bool include_article) {
  if (payload == nullptr || payload_len < 13u) {
    set_error("comment_payload_invalid");
    return 0;
  }

  std::size_t cursor = 0u;
  std::int64_t next_cursor = 0;
  if (!read_i64_le(payload, payload_len, cursor, next_cursor)) {
    set_error("comment_next_cursor_invalid");
    return 0;
  }
  cursor += 8u;

  if (cursor + 1u > payload_len) {
    set_error("comment_has_more_invalid");
    return 0;
  }
  const std::uint8_t has_more = payload[cursor++];

  std::int32_t count = 0;
  if (!try_read_i32_advance(payload, payload_len, cursor, count) || count < 0) {
    set_error("comment_count_invalid");
    return 0;
  }

  begin_panel(include_article ? "AOT My Comments" : "AOT Article Comments");
  append_literal(g_last_html, "<p class=\"aot-meta\">count=");
  append_int(g_last_html, count);
  append_literal(g_last_html, " hasMore=");
  append_int(g_last_html, has_more);
  append_literal(g_last_html, " next=");
  append_int(g_last_html, next_cursor);
  append_literal(g_last_html, "</p><ol class=\"aot-list\">");

  for (int i = 0; i < count; ++i) {
    const std::size_t pod_size = include_article ? kUserCommentPodSize : kCommentItemPodSize;
    if (cursor + pod_size > payload_len) {
      set_error("comment_pod_overflow");
      return 0;
    }
    const std::uint8_t* pod = payload + cursor;
    cursor += pod_size;

    std::int32_t blob_len = 0;
    if (!try_read_i32_advance(payload, payload_len, cursor, blob_len) || blob_len < 0) {
      set_error("comment_blob_len_invalid");
      return 0;
    }
    if (cursor + static_cast<std::size_t>(blob_len) > payload_len) {
      set_error("comment_blob_overflow");
      return 0;
    }
    const std::uint8_t* blob = payload + cursor;
    cursor += static_cast<std::size_t>(blob_len);

    std::int32_t content_offset = 0;
    std::int32_t content_len = 0;
    const std::size_t content_ref_offset = include_article ? 20u : 80u;
    std::memcpy(&content_offset, pod + content_ref_offset, sizeof(std::int32_t));
    std::memcpy(&content_len, pod + content_ref_offset + 4u, sizeof(std::int32_t));

    append_literal(g_last_html, "<li class=\"aot-item\"><strong>");
    if (include_article) {
      append_literal(g_last_html, "#");
      std::int32_t article_id = 0;
      std::memcpy(&article_id, pod + 8, sizeof(std::int32_t));
      append_int(g_last_html, article_id);
      append_literal(g_last_html, " ");
      append_escaped_ascii(g_last_html, pod + 28, 256);
    } else {
      append_escaped_ascii(g_last_html, pod + 16, 64);
    }
    append_literal(g_last_html, "</strong><p>");
    if (content_offset >= 0 && content_len > 0 && static_cast<std::size_t>(content_offset) + static_cast<std::size_t>(content_len) <= static_cast<std::size_t>(blob_len)) {
      append_escaped_ascii(g_last_html, blob + content_offset, static_cast<std::size_t>(content_len));
    }
    append_literal(g_last_html, "</p></li>");
  }

  append_literal(g_last_html, "</ol>");
  end_panel();
  set_error(nullptr);
  return 1;
}

int render_admin_stats_html(const std::uint8_t* payload, std::uint32_t payload_len) {
  if (payload == nullptr || payload_len < kSiteStatsPodSize + 4u + 4u + 4u) {
    set_error("stats_payload_invalid");
    return 0;
  }

  begin_panel("AOT Admin Stats");
  std::int32_t total_articles = 0;
  std::int32_t total_comments = 0;
  std::int32_t total_visits = 0;
  std::memcpy(&total_articles, payload + 0, sizeof(std::int32_t));
  std::memcpy(&total_comments, payload + 4, sizeof(std::int32_t));
  std::memcpy(&total_visits, payload + 12, sizeof(std::int32_t));

  append_literal(g_last_html, "<div class=\"aot-metrics\">");
  append_literal(g_last_html, "<span>articles:");
  append_int(g_last_html, total_articles);
  append_literal(g_last_html, "</span><span> comments:");
  append_int(g_last_html, total_comments);
  append_literal(g_last_html, "</span><span> visits:");
  append_int(g_last_html, total_visits);
  append_literal(g_last_html, "</span></div>");

  std::size_t cursor = kSiteStatsPodSize;
  std::int32_t blob_len = 0;
  if (!try_read_i32_advance(payload, payload_len, cursor, blob_len) || blob_len < 0 || cursor + static_cast<std::size_t>(blob_len) > payload_len) {
    set_error("stats_blob_invalid");
    return 0;
  }
  const std::uint8_t* blob = payload + cursor;
  cursor += static_cast<std::size_t>(blob_len);

  std::int32_t popular_count = 0;
  if (!try_read_i32_advance(payload, payload_len, cursor, popular_count) || popular_count < 0) {
    set_error("stats_popular_count_invalid");
    return 0;
  }

  append_literal(g_last_html, "<h4>popular</h4><ul class=\"aot-list\">");
  const int popular_limit = popular_count > 6 ? 6 : popular_count;
  for (int i = 0; i < popular_count; ++i) {
    if (cursor + kCompactPopularRecordSize > payload_len) {
      set_error("stats_popular_overflow");
      return 0;
    }
    const std::uint8_t* pod = payload + cursor;
    cursor += kCompactPopularRecordSize;
    if (i >= popular_limit) {
      continue;
    }
    std::int32_t views = 0;
    std::memcpy(&views, pod + 4, sizeof(std::int32_t));
    std::int32_t title_offset = 0;
    std::int32_t title_len = 0;
    read_slice_ref(pod, kCompactPopularRecordSize, 8u, title_offset, title_len);
    append_literal(g_last_html, "<li class=\"aot-item\">");
    append_blob_slice(g_last_html, blob, static_cast<std::size_t>(blob_len), title_offset, title_len);
    append_literal(g_last_html, " <em>");
    append_int(g_last_html, views);
    append_literal(g_last_html, "</em></li>");
  }
  append_literal(g_last_html, "</ul>");

  std::int32_t recent_count = 0;
  if (!try_read_i32_advance(payload, payload_len, cursor, recent_count) || recent_count < 0) {
    set_error("stats_recent_count_invalid");
    return 0;
  }
  for (int i = 0; i < recent_count; ++i) {
    if (cursor + kRecentCommentRecordSize > payload_len) {
      set_error("stats_recent_overflow");
      return 0;
    }
    cursor += kRecentCommentRecordSize;
  }

  std::int32_t region_count = 0;
  if (!try_read_i32_advance(payload, payload_len, cursor, region_count) || region_count < 0) {
    set_error("stats_region_count_invalid");
    return 0;
  }

  append_literal(g_last_html, "<h4>regions</h4><ul class=\"aot-list\">");
  const int region_limit = region_count > 5 ? 5 : region_count;
  for (int i = 0; i < region_count; ++i) {
    if (cursor + kRegionDistributionRecordSize > payload_len) {
      set_error("stats_region_overflow");
      return 0;
    }
    const std::uint8_t* pod = payload + cursor;
    cursor += kRegionDistributionRecordSize;
    if (i >= region_limit) {
      continue;
    }
    std::int32_t region_count_item = 0;
    std::memcpy(&region_count_item, pod + 0, sizeof(std::int32_t));
    std::int32_t region_offset = 0;
    std::int32_t region_len = 0;
    read_slice_ref(pod, kRegionDistributionRecordSize, 4u, region_offset, region_len);
    append_literal(g_last_html, "<li class=\"aot-item\">");
    append_blob_slice(g_last_html, blob, static_cast<std::size_t>(blob_len), region_offset, region_len);
    append_literal(g_last_html, " <em>");
    append_int(g_last_html, region_count_item);
    append_literal(g_last_html, "</em></li>");
  }
  append_literal(g_last_html, "</ul>");
  end_panel();
  set_error(nullptr);
  return 1;
}

int render_hot_articles_html(const std::uint8_t* payload, std::uint32_t payload_len) {
  if (payload == nullptr || payload_len < 8u) {
    set_error("article_hot_payload_invalid");
    return 0;
  }

  std::int32_t count = 0;
  std::int32_t blob_len = 0;
  if (!read_i32_le(payload, payload_len, 0, count)
      || !read_i32_le(payload, payload_len, 4, blob_len)
      || count < 0
      || blob_len < 0) {
    set_error("article_hot_count_invalid");
    return 0;
  }

  std::size_t cursor = 8u;
  if (cursor + static_cast<std::size_t>(blob_len) > payload_len) {
    set_error("article_hot_blob_overflow");
    return 0;
  }
  const std::uint8_t* blob = payload + cursor;
  cursor += static_cast<std::size_t>(blob_len);
  if (cursor + static_cast<std::size_t>(count) * kCompactPopularRecordSize > payload_len) {
    set_error("article_hot_records_overflow");
    return 0;
  }
  begin_panel("AOT Hot Articles");
  append_literal(g_last_html, "<ol class=\"aot-list\">");
  for (int i = 0; i < count; ++i) {
    const std::uint8_t* pod = payload + cursor;
    cursor += kCompactPopularRecordSize;

    std::int32_t id = 0;
    std::int32_t views = 0;
    std::memcpy(&id, pod + 0, sizeof(std::int32_t));
    std::memcpy(&views, pod + 4, sizeof(std::int32_t));
    std::int32_t title_offset = 0;
    std::int32_t title_len = 0;
    read_slice_ref(pod, kCompactPopularRecordSize, 8u, title_offset, title_len);
    append_literal(g_last_html, "<li class=\"aot-item\"><a data-aot-action=\"open-article\" data-aot-id=\"");
    append_int(g_last_html, id);
    append_literal(g_last_html, "\">");
    append_blob_slice(g_last_html, blob, static_cast<std::size_t>(blob_len), title_offset, title_len);
    append_literal(g_last_html, "</a><em>");
    append_int(g_last_html, views);
    append_literal(g_last_html, "</em></li>");
  }
  append_literal(g_last_html, "</ol>");
  end_panel();
  set_error(nullptr);
  return 1;
}

int render_generic_html(std::uint16_t frame_type, std::uint32_t payload_len) {
  g_last_html.clear();
  g_last_html.reserve(256);
  append_literal(g_last_html, "<section class=\"aot-frame\" data-aot-frame=\"");
  append_u32(g_last_html, frame_type);
  append_literal(g_last_html, "\"><p>frame:");
  append_u32(g_last_html, frame_type);
  append_literal(g_last_html, " payload:");
  append_u32(g_last_html, payload_len);
  append_literal(g_last_html, "</p></section>");
  set_error(nullptr);
  return 1;
}

} // namespace

extern "C" {

int decode_aeds(const std::uint8_t* data, int len) {
  if (data == nullptr || len <= 0) {
    set_error("invalid_input");
    g_payload_storage.clear();
    g_payload_len = 0;
    g_frame_type = 0;
    g_error_code = static_cast<std::uint8_t>(fsusblog::aeds::ErrorCode::InvalidInput);
    return 0;
  }

  const fsusblog::aeds::DecodeResult result = fsusblog::aeds::decode_frame(data, static_cast<std::size_t>(len));
  if (!result.ok) {
    g_error_code = static_cast<std::uint8_t>(result.error_code);
    set_error(result.error);
    g_payload_storage.clear();
    g_payload_len = 0;
    g_frame_type = 0;
    return 0;
  }

  g_error_code = static_cast<std::uint8_t>(fsusblog::aeds::ErrorCode::None);
  set_error(nullptr);
  g_payload_storage.assign(result.payload_ptr, result.payload_ptr + result.payload_len);
  g_payload_len = result.payload_len;
  g_frame_type = result.frame_type;
  return 1;
}

std::uint32_t get_last_payload_ptr() {
  if (g_payload_storage.empty()) {
    return 0;
  }

  return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(g_payload_storage.data()));
}
std::uint32_t get_last_payload_len() { return g_payload_len; }
std::uint16_t get_last_frame_type() { return g_frame_type; }
const char* get_last_error_ptr() { return g_error.data(); }
int get_last_error_len() { return static_cast<int>(std::strlen(g_error.data())); }
std::uint8_t get_last_error_code() { return g_error_code; }
std::uint32_t alloc_buffer(int size) {
  if (size <= 0) {
    return 0;
  }

  void* ptr = std::malloc(static_cast<std::size_t>(size));
  return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(ptr));
}
void free_buffer(std::uint32_t ptr) {
  if (ptr == 0) {
    return;
  }

  std::free(reinterpret_cast<void*>(static_cast<std::uintptr_t>(ptr)));
}

int render_view(std::uint16_t frame_type, const std::uint8_t* payload, std::uint32_t payload_len) {
  switch (frame_type) {
    case 1u:
    case 4u:
      return render_article_list_html(payload, payload_len);
    case 2u:
      return render_article_detail_html(payload, payload_len);
    case 3u:
      return render_hot_articles_html(payload, payload_len);
    case 5u:
      return render_comment_cursor_html(payload, payload_len, false);
    case 6u:
      return render_comment_cursor_html(payload, payload_len, true);
    case 7u:
      return render_admin_stats_html(payload, payload_len);
    default:
      return render_generic_html(frame_type, payload_len);
  }
}

std::uint32_t get_last_html_ptr() {
  return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(g_last_html.data()));
}

std::uint32_t get_last_html_len() {
  return static_cast<std::uint32_t>(g_last_html.size());
}

int handle_event(std::int32_t action_id, std::int32_t value) {
  g_last_html.clear();
  g_last_html.reserve(128);
  append_literal(g_last_html, "<span class=\"aot-event\">action=");
  append_int(g_last_html, action_id);
  append_literal(g_last_html, " value=");
  append_int(g_last_html, value);
  append_literal(g_last_html, "</span>");
  set_error(nullptr);
  return 1;
}

}
