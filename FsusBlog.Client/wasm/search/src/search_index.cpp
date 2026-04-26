#include <algorithm>
#include <chrono>
#include <cmath>
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

namespace {

constexpr std::uint32_t kShardMagic = 0x32534846u;   // FHS2
constexpr std::uint32_t kShardVersion = 2u;
constexpr std::uint32_t kPatchMagic = 0x54505346u;   // FSPT
constexpr std::uint32_t kPatchVersion = 2u;
constexpr std::uint32_t kPackageMagic = 0x4B505346u; // FSPK
constexpr std::uint32_t kPackageVersion = 2u;
constexpr double kBm25K1 = 1.2;
constexpr double kBm25B = 0.75;
constexpr double kTitleBoost = 2.5;
constexpr double kMetaBoost = 0.9;
constexpr double kBodyBoost = 1.0;
constexpr double kPhraseBonus = 1.25;
constexpr double kWeightRelevance = 1.0;
constexpr double kWeightHotness = 0.35;
constexpr double kHotCommentFactor = 12.0;
constexpr double kHotViewFactor = 0.15;
constexpr double kLambda = 1.0 / (1000.0 * 60.0 * 60.0 * 24.0 * 45.0);

enum class ErrorCode : std::uint8_t {
  None = 0,
  PackagePayloadEmpty = 1,
  PackageHeaderInvalid = 2,
  ShardHeaderInvalid = 3,
  PatchHeaderInvalid = 4,
  VarintOverflow = 5,
  StringOverflow = 6,
  IndexNotLoaded = 7
};

enum class EntryKind : std::uint32_t {
  Shard = 0,
  Patch = 1
};

enum class ShardRole : std::uint32_t {
  Core = 0,
  Recent = 1,
  Archive = 2,
  Body = 3
};

struct SearchTag {
  std::uint32_t id = 0;
  std::string name;
};

struct SearchDoc {
  std::uint32_t article_id = 0;
  std::uint32_t category_id = 0;
  std::int64_t publish_unix_ms = 0;
  std::uint32_t views = 0;
  std::uint32_t comment_count = 0;
  std::uint32_t doc_length = 1;
  std::string title;
  std::string summary;
  std::string category_name;
  std::vector<SearchTag> tags;
};

struct PositionRange {
  std::uint32_t position = 0;
  std::uint32_t length = 1;
  std::uint8_t field = 0;
};

struct PostingHit {
  std::uint32_t article_id = 0;
  std::uint8_t title_tf = 0;
  std::uint8_t meta_tf = 0;
  std::uint8_t body_tf = 0;
  std::vector<PositionRange> positions;
};

struct TermEntry {
  std::uint32_t hash = 0;
  float idf = 0.0f;
  std::uint32_t posting_offset = 0;
  std::uint32_t posting_length = 0;
  bool has_positions = false;
};

struct CategoryEntry {
  std::uint32_t id = 0;
  std::string name;
};

struct TagEntry {
  std::uint32_t id = 0;
  std::string name;
};

struct ShardState {
  ShardRole role = ShardRole::Core;
  bool is_patch = false;
  float avg_doc_length = 1.0f;
  std::vector<TermEntry> terms;
  std::vector<std::uint8_t> postings_blob;
  std::unordered_set<std::uint32_t> tombstones;
};

struct SearchState {
  std::vector<SearchDoc> docs;
  std::unordered_map<std::uint32_t, std::uint32_t> doc_index_by_article;
  std::vector<ShardState> shards;
  std::unordered_map<std::uint32_t, std::size_t> role_patch_index;
  float avg_doc_length = 1.0f;
  bool loaded = false;
};

struct ScoreEntry {
  std::uint32_t doc_index = 0;
  double bm25 = 0.0;
  double hot = 0.0;
  double final_score = 0.0;
};

thread_local SearchState g_state{};
thread_local std::string g_last_result;
thread_local std::string g_last_error;
thread_local ErrorCode g_last_error_code = ErrorCode::None;
thread_local std::vector<double> g_bm25_scores;
thread_local std::vector<std::uint8_t> g_doc_touched;
thread_local std::vector<std::uint32_t> g_touched_docs;

const char* to_error_string(ErrorCode code) {
  switch (code) {
    case ErrorCode::None: return "";
    case ErrorCode::PackagePayloadEmpty: return "search_package_payload_empty";
    case ErrorCode::PackageHeaderInvalid: return "search_package_header_invalid";
    case ErrorCode::ShardHeaderInvalid: return "search_shard_header_invalid";
    case ErrorCode::PatchHeaderInvalid: return "search_patch_header_invalid";
    case ErrorCode::VarintOverflow: return "search_varint_overflow";
    case ErrorCode::StringOverflow: return "search_string_overflow";
    case ErrorCode::IndexNotLoaded: return "search_index_not_loaded";
    default: return "search_runtime_failed";
  }
}

void clear_error() {
  g_last_error.clear();
  g_last_error_code = ErrorCode::None;
}

void set_error(ErrorCode code) {
  g_last_error_code = code;
  g_last_error = to_error_string(code);
}

std::uint32_t read_u32(const std::uint8_t*& cursor, const std::uint8_t* end) {
  if (cursor + 4 > end) {
    set_error(ErrorCode::ShardHeaderInvalid);
    return 0;
  }

  std::uint32_t value = static_cast<std::uint32_t>(cursor[0])
    | (static_cast<std::uint32_t>(cursor[1]) << 8)
    | (static_cast<std::uint32_t>(cursor[2]) << 16)
    | (static_cast<std::uint32_t>(cursor[3]) << 24);
  cursor += 4;
  return value;
}

std::uint16_t read_u16(const std::uint8_t*& cursor, const std::uint8_t* end) {
  if (cursor + 2 > end) {
    set_error(ErrorCode::ShardHeaderInvalid);
    return 0;
  }

  std::uint16_t value = static_cast<std::uint16_t>(cursor[0])
    | (static_cast<std::uint16_t>(cursor[1]) << 8);
  cursor += 2;
  return value;
}

std::int64_t read_i64(const std::uint8_t*& cursor, const std::uint8_t* end) {
  if (cursor + 8 > end) {
    set_error(ErrorCode::ShardHeaderInvalid);
    return 0;
  }

  std::int64_t value = 0;
  for (int i = 0; i < 8; ++i) {
    value |= static_cast<std::int64_t>(cursor[i]) << (8 * i);
  }
  cursor += 8;
  return value;
}

float read_f32(const std::uint8_t*& cursor, const std::uint8_t* end) {
  std::uint32_t raw = read_u32(cursor, end);
  float value = 0.0f;
  std::memcpy(&value, &raw, sizeof(float));
  return value;
}

std::string read_string(const std::uint8_t* start, const std::uint8_t* end, std::uint32_t offset, std::uint16_t length) {
  if (length == 0) {
    return {};
  }

  if (start + offset + length > end) {
    set_error(ErrorCode::StringOverflow);
    return {};
  }

  return std::string(reinterpret_cast<const char*>(start + offset), length);
}

std::uint32_t read_vint(const std::uint8_t*& cursor, const std::uint8_t* end) {
  std::uint32_t value = 0;
  int shift = 0;
  while (cursor < end && shift <= 28) {
    const std::uint8_t byte = *cursor++;
    value |= static_cast<std::uint32_t>(byte & 0x7Fu) << shift;
    if ((byte & 0x80u) == 0) {
      return value;
    }
    shift += 7;
  }

  set_error(ErrorCode::VarintOverflow);
  return 0;
}

std::uint32_t murmur_hash3(std::string_view source) {
  const auto* data = reinterpret_cast<const std::uint8_t*>(source.data());
  const int length = static_cast<int>(source.size());
  const int rounded_end = length & ~0x3;
  std::uint32_t h1 = 0;

  constexpr std::uint32_t c1 = 0xcc9e2d51u;
  constexpr std::uint32_t c2 = 0x1b873593u;

  for (int i = 0; i < rounded_end; i += 4) {
    std::uint32_t k1 = static_cast<std::uint32_t>(data[i])
      | (static_cast<std::uint32_t>(data[i + 1]) << 8)
      | (static_cast<std::uint32_t>(data[i + 2]) << 16)
      | (static_cast<std::uint32_t>(data[i + 3]) << 24);

    k1 *= c1;
    k1 = (k1 << 15) | (k1 >> 17);
    k1 *= c2;

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >> 19);
    h1 = h1 * 5 + 0xe6546b64u;
  }

  std::uint32_t k1 = 0;
  switch (length & 3) {
    case 3: k1 ^= static_cast<std::uint32_t>(data[rounded_end + 2]) << 16; [[fallthrough]];
    case 2: k1 ^= static_cast<std::uint32_t>(data[rounded_end + 1]) << 8; [[fallthrough]];
    case 1:
      k1 ^= static_cast<std::uint32_t>(data[rounded_end]);
      k1 *= c1;
      k1 = (k1 << 15) | (k1 >> 17);
      k1 *= c2;
      h1 ^= k1;
      break;
    default:
      break;
  }

  h1 ^= static_cast<std::uint32_t>(length);
  h1 ^= h1 >> 16;
  h1 *= 0x85ebca6bu;
  h1 ^= h1 >> 13;
  h1 *= 0xc2b2ae35u;
  h1 ^= h1 >> 16;
  return h1;
}

bool is_ascii_word(std::uint8_t ch) {
  return (ch >= 'a' && ch <= 'z')
    || (ch >= 'A' && ch <= 'Z')
    || (ch >= '0' && ch <= '9');
}

std::uint32_t decode_utf8_codepoint(const std::string& input, std::size_t& index) {
  const unsigned char lead = static_cast<unsigned char>(input[index]);
  if (lead < 0x80) {
    ++index;
    return lead;
  }
  if ((lead >> 5) == 0x6 && index + 1 < input.size()) {
    std::uint32_t codepoint = ((lead & 0x1Fu) << 6)
      | (static_cast<unsigned char>(input[index + 1]) & 0x3Fu);
    index += 2;
    return codepoint;
  }
  if ((lead >> 4) == 0xE && index + 2 < input.size()) {
    std::uint32_t codepoint = ((lead & 0x0Fu) << 12)
      | ((static_cast<unsigned char>(input[index + 1]) & 0x3Fu) << 6)
      | (static_cast<unsigned char>(input[index + 2]) & 0x3Fu);
    index += 3;
    return codepoint;
  }
  if ((lead >> 3) == 0x1E && index + 3 < input.size()) {
    std::uint32_t codepoint = ((lead & 0x07u) << 18)
      | ((static_cast<unsigned char>(input[index + 1]) & 0x3Fu) << 12)
      | ((static_cast<unsigned char>(input[index + 2]) & 0x3Fu) << 6)
      | (static_cast<unsigned char>(input[index + 3]) & 0x3Fu);
    index += 4;
    return codepoint;
  }

  ++index;
  return 0;
}

bool is_cjk(std::uint32_t codepoint) {
  return (codepoint >= 0x4E00u && codepoint <= 0x9FFFu)
    || (codepoint >= 0x3400u && codepoint <= 0x4DBFu)
    || (codepoint >= 0x3040u && codepoint <= 0x30FFu)
    || (codepoint >= 0xAC00u && codepoint <= 0xD7AFu);
}

std::vector<std::uint32_t> tokenize_query_hashes(std::string query) {
  std::vector<std::uint32_t> hashes;
  std::string ascii_buffer;
  auto flush_ascii = [&]() {
    if (!ascii_buffer.empty()) {
      std::transform(ascii_buffer.begin(), ascii_buffer.end(), ascii_buffer.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
      });
      hashes.push_back(murmur_hash3(ascii_buffer));
      ascii_buffer.clear();
    }
  };

  for (std::size_t index = 0; index < query.size();) {
    unsigned char lead = static_cast<unsigned char>(query[index]);
    if (lead < 0x80) {
      char ch = static_cast<char>(lead);
      if (is_ascii_word(static_cast<std::uint8_t>(ch))) {
        ascii_buffer.push_back(ch);
      } else {
        flush_ascii();
      }
      ++index;
      continue;
    }

    flush_ascii();
    std::size_t start = index;
    std::uint32_t codepoint = decode_utf8_codepoint(query, index);
    if (is_cjk(codepoint)) {
      hashes.push_back(murmur_hash3(std::string_view(query.data() + start, index - start)));
    }
  }

  flush_ascii();
  std::sort(hashes.begin(), hashes.end());
  hashes.erase(std::unique(hashes.begin(), hashes.end()), hashes.end());
  return hashes;
}

double decode_quantized_tf(std::uint8_t value) {
  switch (value) {
    case 0: return 0.0;
    case 1: case 2: case 3: case 4: case 5:
    case 6: case 7: case 8: case 9: case 10:
      return static_cast<double>(value);
    case 11: return 12.0;
    case 12: return 15.0;
    case 13: return 20.0;
    case 14: return 30.0;
    case 15: return 50.0;
    case 16: return 100.0;
    default: return 140.0;
  }
}

double compute_hot_score(const SearchDoc& doc, std::int64_t now_ms) {
  const double age_ms = std::max<double>(0.0, static_cast<double>(now_ms - doc.publish_unix_ms));
  const double base = static_cast<double>(doc.comment_count) * kHotCommentFactor
    + static_cast<double>(doc.views) * kHotViewFactor;
  return base * std::exp(-kLambda * age_ms);
}

void write_u16(std::string& target, std::uint16_t value) {
  target.push_back(static_cast<char>(value & 0xFFu));
  target.push_back(static_cast<char>((value >> 8) & 0xFFu));
}

void write_u32(std::string& target, std::uint32_t value) {
  target.push_back(static_cast<char>(value & 0xFFu));
  target.push_back(static_cast<char>((value >> 8) & 0xFFu));
  target.push_back(static_cast<char>((value >> 16) & 0xFFu));
  target.push_back(static_cast<char>((value >> 24) & 0xFFu));
}

void write_i64(std::string& target, std::int64_t value) {
  for (int shift = 0; shift < 64; shift += 8) {
    target.push_back(static_cast<char>((static_cast<std::uint64_t>(value) >> shift) & 0xFFu));
  }
}

std::size_t utf8_prefix_len(std::string_view source, std::size_t max_bytes) {
  if (source.size() <= max_bytes) {
    return source.size();
  }

  std::size_t index = 0;
  std::size_t last_safe = 0;
  while (index < source.size() && index < max_bytes) {
    const unsigned char lead = static_cast<unsigned char>(source[index]);
    std::size_t advance = 1;
    if ((lead >> 5) == 0x6) {
      advance = 2;
    } else if ((lead >> 4) == 0xE) {
      advance = 3;
    } else if ((lead >> 3) == 0x1E) {
      advance = 4;
    }

    if (index + advance > max_bytes) {
      break;
    }

    last_safe = index + advance;
    index += advance;
  }

  return last_safe;
}

void append_fixed_utf8(std::string& target, std::string_view source, std::size_t fixed_bytes) {
  const std::size_t actual = utf8_prefix_len(source, fixed_bytes);
  target.append(source.data(), actual);
  if (fixed_bytes > actual) {
    target.append(fixed_bytes - actual, '\0');
  }
}

void append_slice_ref(std::string& target, std::int32_t offset, std::int32_t length) {
  write_u32(target, static_cast<std::uint32_t>(offset));
  write_u32(target, static_cast<std::uint32_t>(length));
}

void append_blob(std::string& target, std::string_view payload) {
  write_u32(target, static_cast<std::uint32_t>(payload.size()));
  target.append(payload.data(), payload.size());
}

void append_article_list_item(std::string& target, const SearchDoc& doc) {
  std::string text_blob;
  text_blob.reserve(doc.summary.size());
  const std::size_t summary_len = utf8_prefix_len(doc.summary, static_cast<std::size_t>(std::numeric_limits<std::int32_t>::max()));
  text_blob.append(doc.summary.data(), summary_len);

  write_u32(target, doc.article_id);
  write_u32(target, doc.views);
  write_i64(target, doc.publish_unix_ms);
  write_u32(target, doc.category_id);
  append_fixed_utf8(target, doc.category_name, 128);
  append_fixed_utf8(target, doc.title, 256);
  append_slice_ref(target, 0, static_cast<std::int32_t>(summary_len));
  append_slice_ref(target, static_cast<std::int32_t>(summary_len), 0);
  write_u32(target, static_cast<std::uint32_t>(doc.tags.size()));
  for (const SearchTag& tag : doc.tags) {
    write_u32(target, tag.id);
    append_fixed_utf8(target, tag.name, 128);
  }

  append_blob(target, text_blob);
}

void build_binary_page(const std::vector<ScoreEntry>& scores, std::size_t page, std::size_t page_size) {
  const std::size_t total = scores.size();
  const std::size_t safe_page = page == 0 ? 1 : page;
  const std::size_t safe_size = std::max<std::size_t>(1, page_size);
  const std::size_t start = (safe_page - 1) * safe_size;

  g_last_result.clear();
  const std::size_t item_count = start < total ? std::min(total - start, safe_size) : 0;
  g_last_result.reserve(8 + item_count * 960);

  write_u32(g_last_result, static_cast<std::uint32_t>(total));
  write_u32(g_last_result, static_cast<std::uint32_t>(item_count));

  if (item_count == 0) {
    return;
  }

  const std::size_t end = start + item_count;
  for (std::size_t i = start; i < end; ++i) {
    append_article_list_item(g_last_result, g_state.docs[scores[i].doc_index]);
  }
}

const TermEntry* find_term(const ShardState& shard, std::uint32_t hash) {
  auto it = std::lower_bound(shard.terms.begin(), shard.terms.end(), hash, [](const TermEntry& entry, std::uint32_t value) {
    return entry.hash < value;
  });
  if (it == shard.terms.end() || it->hash != hash) {
    return nullptr;
  }

  return &(*it);
}

bool align_cursor(const std::uint8_t*& cursor, const std::uint8_t* base, const std::uint8_t* end, std::uint32_t offset) {
  if (base + offset > end) {
    set_error(ErrorCode::ShardHeaderInvalid);
    return false;
  }
  cursor = base + offset;
  return true;
}

bool parse_shard_payload(
  const std::uint8_t* data,
  int length,
  ShardRole expected_role,
  bool is_patch_payload,
  const std::unordered_set<std::uint32_t>& tombstones,
  ShardState& out_shard)
{
  if (length <= 0) {
    set_error(ErrorCode::ShardHeaderInvalid);
    return false;
  }

  const auto* base = data;
  const auto* cursor = data;
  const auto* end = data + length;

  const std::uint32_t magic = read_u32(cursor, end);
  const std::uint32_t version = read_u32(cursor, end);
  const auto role = static_cast<ShardRole>(read_u32(cursor, end));
  const std::uint32_t flags = read_u32(cursor, end);
  const std::uint32_t term_count = read_u32(cursor, end);
  const std::uint32_t doc_count = read_u32(cursor, end);
  const std::uint32_t category_count = read_u32(cursor, end);
  const std::uint32_t tag_count = read_u32(cursor, end);
  const std::uint32_t tag_ref_count = read_u32(cursor, end);
  const std::uint32_t term_offset = read_u32(cursor, end);
  const std::uint32_t doc_offset = read_u32(cursor, end);
  const std::uint32_t category_offset = read_u32(cursor, end);
  const std::uint32_t tag_offset = read_u32(cursor, end);
  const std::uint32_t tag_ref_offset = read_u32(cursor, end);
  const std::uint32_t string_pool_offset = read_u32(cursor, end);
  const std::uint32_t posting_offset = read_u32(cursor, end);
  const std::uint32_t posting_length = read_u32(cursor, end);
  const float avg_doc_length = read_f32(cursor, end);

  if (!g_last_error.empty() || magic != kShardMagic || version != kShardVersion || role != expected_role) {
    set_error(ErrorCode::ShardHeaderInvalid);
    return false;
  }

  std::vector<CategoryEntry> categories;
  categories.reserve(category_count);
  if (!align_cursor(cursor, base, end, category_offset)) {
    return false;
  }
  for (std::uint32_t i = 0; i < category_count; ++i) {
    CategoryEntry entry;
    entry.id = read_u32(cursor, end);
    std::uint32_t name_offset = read_u32(cursor, end);
    std::uint16_t name_length = read_u16(cursor, end);
    cursor += 2;
    cursor += 4;
    if (!g_last_error.empty()) {
      return false;
    }
    entry.name = read_string(base + string_pool_offset, end, name_offset, name_length);
    if (!g_last_error.empty()) {
      return false;
    }
    categories.push_back(std::move(entry));
  }

  std::vector<TagEntry> tags;
  tags.reserve(tag_count);
  if (!align_cursor(cursor, base, end, tag_offset)) {
    return false;
  }
  for (std::uint32_t i = 0; i < tag_count; ++i) {
    TagEntry entry;
    entry.id = read_u32(cursor, end);
    std::uint32_t name_offset = read_u32(cursor, end);
    std::uint16_t name_length = read_u16(cursor, end);
    cursor += 2;
    cursor += 4;
    if (!g_last_error.empty()) {
      return false;
    }
    entry.name = read_string(base + string_pool_offset, end, name_offset, name_length);
    if (!g_last_error.empty()) {
      return false;
    }
    tags.push_back(std::move(entry));
  }

  std::vector<std::uint16_t> tag_refs;
  tag_refs.reserve(tag_ref_count);
  if (!align_cursor(cursor, base, end, tag_ref_offset)) {
    return false;
  }
  for (std::uint32_t i = 0; i < tag_ref_count; ++i) {
    tag_refs.push_back(read_u16(cursor, end));
    if (!g_last_error.empty()) {
      return false;
    }
  }

  if (!align_cursor(cursor, base, end, doc_offset)) {
    return false;
  }
  for (std::uint32_t i = 0; i < doc_count; ++i) {
    std::uint32_t article_id = read_u32(cursor, end);
    std::uint16_t category_index = read_u16(cursor, end);
    std::uint16_t tag_count_for_doc = read_u16(cursor, end);
    std::uint32_t tag_ref_start = read_u32(cursor, end);
    std::uint32_t views = read_u32(cursor, end);
    std::uint32_t comment_count = read_u32(cursor, end);
    std::uint32_t doc_length = read_u32(cursor, end);
    std::int64_t publish_unix_ms = read_i64(cursor, end);
    std::uint32_t title_offset = read_u32(cursor, end);
    std::uint16_t title_length = read_u16(cursor, end);
    cursor += 2;
    std::uint32_t summary_offset = read_u32(cursor, end);
    std::uint16_t summary_length = read_u16(cursor, end);
    cursor += 2;
    cursor += 4;

    if (!g_last_error.empty()) {
      return false;
    }

    if ((flags & 1u) != 0u) {
      SearchDoc doc;
      doc.article_id = article_id;
      doc.publish_unix_ms = publish_unix_ms;
      doc.views = views;
      doc.comment_count = comment_count;
      doc.doc_length = doc_length == 0 ? 1u : doc_length;
      doc.title = read_string(base + string_pool_offset, end, title_offset, title_length);
      doc.summary = read_string(base + string_pool_offset, end, summary_offset, summary_length);
      if (category_index < categories.size()) {
        doc.category_id = categories[category_index].id;
        doc.category_name = categories[category_index].name;
      }

      doc.tags.reserve(tag_count_for_doc);
      for (std::uint16_t tag_index = 0; tag_index < tag_count_for_doc; ++tag_index) {
        const std::uint32_t ref_index = tag_ref_start + tag_index;
        if (ref_index >= tag_refs.size()) {
          continue;
        }

        const std::uint16_t dict_index = tag_refs[ref_index];
        if (dict_index >= tags.size()) {
          continue;
        }

        doc.tags.push_back(SearchTag{ tags[dict_index].id, tags[dict_index].name });
      }

      auto existing = g_state.doc_index_by_article.find(article_id);
      if (existing == g_state.doc_index_by_article.end()) {
        g_state.doc_index_by_article.emplace(article_id, static_cast<std::uint32_t>(g_state.docs.size()));
        g_state.docs.push_back(std::move(doc));
      } else {
        g_state.docs[existing->second] = std::move(doc);
      }
    }
  }

  if (!align_cursor(cursor, base, end, term_offset)) {
    return false;
  }

  out_shard.role = role;
  out_shard.is_patch = is_patch_payload;
  out_shard.avg_doc_length = avg_doc_length <= 0.0f ? 1.0f : avg_doc_length;
  out_shard.tombstones = tombstones;
  out_shard.terms.reserve(term_count);
  for (std::uint32_t i = 0; i < term_count; ++i) {
    TermEntry entry;
    entry.hash = read_u32(cursor, end);
    entry.idf = read_f32(cursor, end);
    entry.posting_offset = read_u32(cursor, end);
    entry.posting_length = read_u32(cursor, end);
    entry.has_positions = read_u32(cursor, end) != 0;
    cursor += 4;
    if (!g_last_error.empty()) {
      return false;
    }
    out_shard.terms.push_back(entry);
  }

  if (base + posting_offset + posting_length > end) {
    set_error(ErrorCode::ShardHeaderInvalid);
    return false;
  }

  out_shard.postings_blob.assign(base + posting_offset, base + posting_offset + posting_length);
  return true;
}

bool parse_patch_payload(const std::uint8_t* data, int length, ShardRole role, ShardState& out_shard) {
  const auto* cursor = data;
  const auto* end = data + length;
  const std::uint32_t magic = read_u32(cursor, end);
  const std::uint32_t version = read_u32(cursor, end);
  const std::uint32_t tombstone_count = read_u32(cursor, end);
  const std::uint32_t tombstone_bytes_length = read_u32(cursor, end);
  const std::uint32_t shard_length = read_u32(cursor, end);
  cursor += 4;

  if (!g_last_error.empty() || magic != kPatchMagic || version != kPatchVersion || cursor + tombstone_bytes_length + shard_length > end) {
    set_error(ErrorCode::PatchHeaderInvalid);
    return false;
  }

  std::unordered_set<std::uint32_t> tombstones;
  tombstones.reserve(tombstone_count);
  std::uint32_t previous_article_id = 0;
  const auto* tombstone_end = cursor + tombstone_bytes_length;
  for (std::uint32_t i = 0; i < tombstone_count; ++i) {
    previous_article_id += read_vint(cursor, tombstone_end);
    if (!g_last_error.empty()) {
      return false;
    }
    tombstones.insert(previous_article_id);
  }

  return parse_shard_payload(cursor, static_cast<int>(shard_length), role, true, tombstones, out_shard);
}

bool parse_package(const std::uint8_t* data, int length) {
  const auto* cursor = data;
  const auto* end = data + length;
  const std::uint32_t magic = read_u32(cursor, end);
  const std::uint32_t version = read_u32(cursor, end);
  const std::uint32_t entry_count = read_u32(cursor, end);

  if (!g_last_error.empty() || magic != kPackageMagic || version != kPackageVersion) {
    set_error(ErrorCode::PackageHeaderInvalid);
    return false;
  }

  struct PackageEntry {
    EntryKind kind = EntryKind::Shard;
    ShardRole role = ShardRole::Core;
    std::uint32_t offset = 0;
    std::uint32_t length = 0;
  };

  std::vector<PackageEntry> entries;
  entries.reserve(entry_count);
  for (std::uint32_t i = 0; i < entry_count; ++i) {
    PackageEntry entry;
    entry.kind = static_cast<EntryKind>(read_u32(cursor, end));
    entry.role = static_cast<ShardRole>(read_u32(cursor, end));
    entry.offset = read_u32(cursor, end);
    entry.length = read_u32(cursor, end);
    if (!g_last_error.empty() || data + entry.offset + entry.length > end) {
      set_error(ErrorCode::PackageHeaderInvalid);
      return false;
    }
    entries.push_back(entry);
  }

  g_state = SearchState{};
  for (const PackageEntry& entry : entries) {
    ShardState shard;
    if (entry.kind == EntryKind::Patch) {
      if (!parse_patch_payload(data + entry.offset, static_cast<int>(entry.length), entry.role, shard)) {
        return false;
      }
    } else {
      if (!parse_shard_payload(data + entry.offset, static_cast<int>(entry.length), entry.role, false, {}, shard)) {
        return false;
      }
    }
    g_state.shards.push_back(std::move(shard));
  }

  for (std::size_t index = 0; index < g_state.shards.size(); ++index) {
    if (g_state.shards[index].role == ShardRole::Core) {
      g_state.avg_doc_length = g_state.shards[index].avg_doc_length;
      break;
    }
  }
  if (g_state.avg_doc_length <= 0.0f) {
    g_state.avg_doc_length = 1.0f;
  }
  g_state.loaded = true;
  return true;
}

bool decode_posting_hit(const ShardState& shard, const TermEntry& term, std::uint32_t target_article_id, PostingHit& hit) {
  if (term.posting_offset + term.posting_length > shard.postings_blob.size()) {
    return false;
  }

  const auto* cursor = shard.postings_blob.data() + term.posting_offset;
  const auto* end = cursor + term.posting_length;
  const std::uint32_t posting_count = read_vint(cursor, end);
  if (!g_last_error.empty()) {
    return false;
  }

  std::uint32_t article_id = 0;
  for (std::uint32_t i = 0; i < posting_count; ++i) {
    article_id += read_vint(cursor, end);
    if (cursor + 3 > end || !g_last_error.empty()) {
      return false;
    }

    const std::uint8_t title_tf = *cursor++;
    const std::uint8_t meta_tf = *cursor++;
    const std::uint8_t body_tf = *cursor++;
    const std::uint32_t position_count = read_vint(cursor, end);
    if (!g_last_error.empty()) {
      return false;
    }

    std::vector<PositionRange> positions;
    positions.reserve(position_count);
    std::uint32_t previous_position = 0;
    for (std::uint32_t p = 0; p < position_count; ++p) {
      previous_position += read_vint(cursor, end);
      const std::uint32_t position_length = read_vint(cursor, end);
      const std::uint32_t field = read_vint(cursor, end);
      if (!g_last_error.empty()) {
        return false;
      }
      positions.push_back(PositionRange{ previous_position, position_length == 0 ? 1u : position_length, static_cast<std::uint8_t>(field) });
    }

    if (article_id != target_article_id) {
      continue;
    }

    hit.article_id = article_id;
    hit.title_tf = title_tf;
    hit.meta_tf = meta_tf;
    hit.body_tf = body_tf;
    hit.positions = std::move(positions);
    return true;
  }

  return false;
}

double compute_phrase_bonus(const std::vector<const TermEntry*>& terms, const ShardState& shard, std::uint32_t article_id) {
  if (terms.size() < 2) {
    return 0.0;
  }

  std::vector<std::vector<PositionRange>> term_positions;
  term_positions.reserve(terms.size());
  for (const TermEntry* term : terms) {
    if (term == nullptr || !term->has_positions) {
      return 0.0;
    }

    PostingHit hit;
    if (!decode_posting_hit(shard, *term, article_id, hit) || hit.positions.empty()) {
      return 0.0;
    }
    term_positions.push_back(std::move(hit.positions));
  }

  for (const PositionRange& first : term_positions.front()) {
    std::uint32_t expected = first.position + first.length;
    const std::uint8_t expected_field = first.field;
    bool matched = true;
    for (std::size_t index = 1; index < term_positions.size(); ++index) {
      const auto& positions = term_positions[index];
      auto it = std::find_if(positions.begin(), positions.end(), [&](const PositionRange& candidate) {
        return candidate.position == expected && candidate.field == expected_field;
      });
      if (it == positions.end()) {
        matched = false;
        break;
      }

      expected = it->position + it->length;
    }

    if (matched) {
      return kPhraseBonus;
    }
  }

  return 0.0;
}

double compute_effective_tf(
  std::uint8_t title_tf,
  std::uint8_t meta_tf,
  std::uint8_t body_tf,
  const TermEntry& term,
  const std::vector<PositionRange>& positions,
  std::unordered_set<std::uint64_t>* covered_positions)
{
  const double meta_contribution = decode_quantized_tf(meta_tf) * kMetaBoost;
  double positional_contribution = decode_quantized_tf(title_tf) * kTitleBoost
    + decode_quantized_tf(body_tf) * kBodyBoost;

  if (covered_positions != nullptr && term.has_positions && !positions.empty()) {
    std::uint32_t new_covered_positions = 0;
    for (const PositionRange& position : positions) {
      const std::uint32_t length = std::max<std::uint32_t>(1, position.length);
      for (std::uint32_t delta = 0; delta < length; ++delta) {
        const std::uint64_t key = (static_cast<std::uint64_t>(position.field) << 56)
          | static_cast<std::uint64_t>(position.position + delta);
        if (covered_positions->insert(key).second) {
          ++new_covered_positions;
        }
      }
    }

    const double max_field_boost = title_tf > 0 ? kTitleBoost : kBodyBoost;
    positional_contribution = std::min(positional_contribution, static_cast<double>(new_covered_positions) * max_field_boost);
  }

  return meta_contribution + positional_contribution;
}

} // namespace

extern "C" {

std::uint8_t* alloc_buffer(int size) {
  if (size <= 0) {
    return nullptr;
  }

  return static_cast<std::uint8_t*>(std::malloc(static_cast<std::size_t>(size)));
}

void free_buffer(void* ptr) {
  std::free(ptr);
}

int load_search_index(const std::uint8_t* data, int length) {
  clear_error();
  g_last_result.clear();

  if (data == nullptr || length <= 0) {
    set_error(ErrorCode::PackagePayloadEmpty);
    return 0;
  }

  if (!parse_package(data, length)) {
    return 0;
  }

  return 1;
}

int search_articles(const std::uint8_t* query_ptr, int query_len, int sort_mode, int page, int page_size) {
  clear_error();
  g_last_result.clear();

  if (!g_state.loaded) {
    set_error(ErrorCode::IndexNotLoaded);
    return 0;
  }

  if (query_ptr == nullptr || query_len <= 0) {
    build_binary_page({}, static_cast<std::size_t>(page), static_cast<std::size_t>(page_size));
    return 1;
  }

  const std::string query(reinterpret_cast<const char*>(query_ptr), static_cast<std::size_t>(query_len));
  std::vector<std::uint32_t> hashes = tokenize_query_hashes(query);
  if (hashes.empty()) {
    build_binary_page({}, static_cast<std::size_t>(page), static_cast<std::size_t>(page_size));
    return 1;
  }

  const std::size_t doc_count = g_state.docs.size();
  g_bm25_scores.assign(doc_count, 0.0);
  g_doc_touched.assign(doc_count, static_cast<std::uint8_t>(0));
  g_touched_docs.clear();
  g_touched_docs.reserve(std::min<std::size_t>(doc_count, 512));

  const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count();

  std::unordered_map<std::uint32_t, std::unordered_set<std::uint32_t>> tombstones_by_role;
  std::unordered_map<std::uint32_t, std::unordered_set<std::uint64_t>> covered_positions_by_doc;
  for (const ShardState& shard : g_state.shards) {
    if (shard.is_patch) {
      tombstones_by_role[static_cast<std::uint32_t>(shard.role)].insert(shard.tombstones.begin(), shard.tombstones.end());
    }
  }

  for (const ShardState& shard : g_state.shards) {
    const auto tombstone_it = tombstones_by_role.find(static_cast<std::uint32_t>(shard.role));
    const std::unordered_set<std::uint32_t>* tombstones = tombstone_it == tombstones_by_role.end() ? nullptr : &tombstone_it->second;

    for (std::uint32_t hash : hashes) {
      const TermEntry* term = find_term(shard, hash);
      if (term == nullptr || term->posting_offset + term->posting_length > shard.postings_blob.size()) {
        continue;
      }

      const auto* cursor = shard.postings_blob.data() + term->posting_offset;
      const auto* end = cursor + term->posting_length;
      std::uint32_t posting_count = read_vint(cursor, end);
      if (!g_last_error.empty()) {
        return 0;
      }

      std::uint32_t article_id = 0;
      for (std::uint32_t i = 0; i < posting_count; ++i) {
        article_id += read_vint(cursor, end);
        if (cursor + 3 > end || !g_last_error.empty()) {
          return 0;
        }

        const std::uint8_t title_tf = *cursor++;
        const std::uint8_t meta_tf = *cursor++;
        const std::uint8_t body_tf = *cursor++;
        const std::uint32_t position_count = read_vint(cursor, end);
        if (!g_last_error.empty()) {
          return 0;
        }

        std::vector<PositionRange> positions;
        positions.reserve(position_count);
        std::uint32_t previous_position = 0;
        for (std::uint32_t p = 0; p < position_count; ++p) {
          previous_position += read_vint(cursor, end);
          const std::uint32_t position_length = read_vint(cursor, end);
          const std::uint32_t field = read_vint(cursor, end);
          if (!g_last_error.empty()) {
            return 0;
          }
          positions.push_back(PositionRange{ previous_position, position_length == 0 ? 1u : position_length, static_cast<std::uint8_t>(field) });
        }

        if (tombstones && tombstones->contains(article_id) && !shard.is_patch) {
          continue;
        }

        auto doc_it = g_state.doc_index_by_article.find(article_id);
        if (doc_it == g_state.doc_index_by_article.end()) {
          continue;
        }

        const std::uint32_t doc_index = doc_it->second;
        const SearchDoc& doc = g_state.docs[doc_index];
        std::unordered_set<std::uint64_t>* covered_positions = nullptr;
        if (term->has_positions && !positions.empty()) {
          covered_positions = &covered_positions_by_doc[doc_index];
        }

        const double tf = compute_effective_tf(title_tf, meta_tf, body_tf, *term, positions, covered_positions);
        if (tf <= 0.0) {
          continue;
        }

        const double avg_doc_length = shard.avg_doc_length > 0.0f ? static_cast<double>(shard.avg_doc_length) : static_cast<double>(g_state.avg_doc_length);
        const double norm = tf + kBm25K1 * (1.0 - kBm25B + kBm25B * (static_cast<double>(doc.doc_length) / std::max(1.0, avg_doc_length)));
        const double contribution = static_cast<double>(term->idf) * ((tf * (kBm25K1 + 1.0)) / norm);

        g_bm25_scores[doc_index] += contribution;
        if (g_doc_touched[doc_index] == 0) {
          g_doc_touched[doc_index] = 1;
          g_touched_docs.push_back(doc_index);
        }
      }
    }
  }

  std::vector<ScoreEntry> scores;
  scores.reserve(g_touched_docs.size());
  for (std::uint32_t doc_index : g_touched_docs) {
    ScoreEntry entry{};
    entry.doc_index = doc_index;
    entry.bm25 = g_bm25_scores[doc_index];
    const SearchDoc& doc = g_state.docs[doc_index];
    entry.hot = compute_hot_score(doc, now_ms);
    entry.final_score = entry.bm25 * kWeightRelevance + entry.hot * kWeightHotness;

    if (hashes.size() > 1) {
      for (const ShardState& shard : g_state.shards) {
        const auto tombstone_it = tombstones_by_role.find(static_cast<std::uint32_t>(shard.role));
        const std::unordered_set<std::uint32_t>* tombstones = tombstone_it == tombstones_by_role.end() ? nullptr : &tombstone_it->second;
        if (tombstones && tombstones->contains(doc.article_id) && !shard.is_patch) {
          continue;
        }

        std::vector<const TermEntry*> phrase_terms;
        phrase_terms.reserve(hashes.size());
        for (std::uint32_t hash : hashes) {
          phrase_terms.push_back(find_term(shard, hash));
        }

        entry.final_score += compute_phrase_bonus(phrase_terms, shard, doc.article_id);
      }
    }

    scores.push_back(entry);
  }

  switch (sort_mode) {
    case 1:
      std::sort(scores.begin(), scores.end(), [](const ScoreEntry& left, const ScoreEntry& right) {
        return g_state.docs[left.doc_index].publish_unix_ms > g_state.docs[right.doc_index].publish_unix_ms;
      });
      break;
    case 2:
      std::sort(scores.begin(), scores.end(), [](const ScoreEntry& left, const ScoreEntry& right) {
        return left.hot > right.hot;
      });
      break;
    default:
      std::sort(scores.begin(), scores.end(), [](const ScoreEntry& left, const ScoreEntry& right) {
        return left.final_score > right.final_score;
      });
      break;
  }

  build_binary_page(scores, static_cast<std::size_t>(page), static_cast<std::size_t>(page_size));
  return 1;
}

const char* get_last_result_ptr() {
  return g_last_result.c_str();
}

int get_last_result_len() {
  return static_cast<int>(g_last_result.size());
}

const char* get_last_error_ptr() {
  return g_last_error.c_str();
}

int get_last_error_len() {
  return static_cast<int>(g_last_error.size());
}

int get_last_error_code() {
  return static_cast<int>(g_last_error_code);
}

}
