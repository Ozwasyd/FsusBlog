#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

constexpr std::uint32_t kMagic = 0x58425346u;
constexpr std::uint16_t kVersion = 1u;
constexpr std::uint32_t kPatchMagic = 0x50425346u;
constexpr std::uint16_t kPatchVersion = 1u;
constexpr double kBm25K1 = 1.2;
constexpr double kBm25B = 0.75;
constexpr double kTitleBoost = 2.5;
constexpr double kWeightRelevance = 1.0;
constexpr double kWeightHotness = 0.35;
constexpr double kHotCommentFactor = 12.0;
constexpr double kHotViewFactor = 0.15;
constexpr double kLambda = 1.0 / (1000.0 * 60.0 * 60.0 * 24.0 * 45.0);

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

struct Posting {
  std::uint32_t doc_index = 0;
  std::uint16_t body_tf = 0;
  std::uint16_t title_tf = 0;
};

struct TermEntry {
  std::uint32_t hash = 0;
  float idf = 0.0f;
  std::uint32_t posting_start = 0;
  std::uint32_t posting_count = 0;
};

struct SearchState {
  float avg_doc_length = 1.0f;
  std::vector<SearchDoc> docs;
  std::vector<Posting> postings;
  std::vector<TermEntry> terms;
  bool loaded = false;
};

struct ScoreEntry {
  std::uint32_t doc_index = 0;
  double bm25 = 0.0;
  double hot = 0.0;
  double final_score = 0.0;
};

enum class ErrorCode : std::uint8_t {
  None = 0,
  U32Overflow = 1,
  U16Overflow = 2,
  U8Overflow = 3,
  I64Overflow = 4,
  StringOverflow = 5,
  IndexPayloadEmpty = 6,
  IndexHeaderInvalid = 7,
  PatchPayloadEmpty = 8,
  PatchHeaderInvalid = 9,
  PatchCopyOutOfRange = 10,
  PatchOpcodeInvalid = 11,
  PatchLiteralOverflow = 12,
  PatchLengthMismatch = 13,
  IndexNotLoaded = 14
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
    case ErrorCode::U32Overflow: return "search_index_u32_overflow";
    case ErrorCode::U16Overflow: return "search_index_u16_overflow";
    case ErrorCode::U8Overflow: return "search_index_u8_overflow";
    case ErrorCode::I64Overflow: return "search_index_i64_overflow";
    case ErrorCode::StringOverflow: return "search_index_string_overflow";
    case ErrorCode::IndexPayloadEmpty: return "search_index_payload_empty";
    case ErrorCode::IndexHeaderInvalid: return "search_index_header_invalid";
    case ErrorCode::PatchPayloadEmpty: return "search_patch_payload_empty";
    case ErrorCode::PatchHeaderInvalid: return "search_patch_header_invalid";
    case ErrorCode::PatchCopyOutOfRange: return "search_patch_copy_out_of_range";
    case ErrorCode::PatchOpcodeInvalid: return "search_patch_opcode_invalid";
    case ErrorCode::PatchLiteralOverflow: return "search_patch_literal_overflow";
    case ErrorCode::PatchLengthMismatch: return "search_patch_length_mismatch";
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
    set_error(ErrorCode::U32Overflow);
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
    set_error(ErrorCode::U16Overflow);
    return 0;
  }

  std::uint16_t value = static_cast<std::uint16_t>(cursor[0])
    | (static_cast<std::uint16_t>(cursor[1]) << 8);
  cursor += 2;
  return value;
}

std::uint8_t read_u8(const std::uint8_t*& cursor, const std::uint8_t* end) {
  if (cursor + 1 > end) {
    set_error(ErrorCode::U8Overflow);
    return 0;
  }

  return *cursor++;
}

std::int64_t read_i64(const std::uint8_t*& cursor, const std::uint8_t* end) {
  if (cursor + 8 > end) {
    set_error(ErrorCode::I64Overflow);
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

std::string read_string(const std::uint8_t*& cursor, const std::uint8_t* end, std::size_t length) {
  if (cursor + length > end) {
    set_error(ErrorCode::StringOverflow);
    return {};
  }

  std::string value(reinterpret_cast<const char*>(cursor), length);
  cursor += length;
  return value;
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

bool is_ascii_word(char ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
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
  std::transform(query.begin(), query.end(), query.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });

  std::vector<std::uint32_t> hashes;
  std::string ascii_buffer;
  std::vector<std::string> cjk_segment;

  auto flush_ascii = [&]() {
    if (!ascii_buffer.empty()) {
      hashes.push_back(murmur_hash3(ascii_buffer));
      ascii_buffer.clear();
    }
  };

  auto flush_cjk = [&]() {
    if (cjk_segment.empty()) {
      return;
    }

    if (cjk_segment.size() == 1) {
      hashes.push_back(murmur_hash3(cjk_segment.front()));
    } else {
      for (std::size_t i = 0; i + 1 < cjk_segment.size(); ++i) {
        hashes.push_back(murmur_hash3(cjk_segment[i] + cjk_segment[i + 1]));
      }
    }

    cjk_segment.clear();
  };

  for (std::size_t index = 0; index < query.size();) {
    unsigned char lead = static_cast<unsigned char>(query[index]);
    if (lead < 0x80) {
      flush_cjk();
      char ch = static_cast<char>(lead);
      if (is_ascii_word(ch)) {
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
      cjk_segment.emplace_back(query.substr(start, index - start));
    } else {
      flush_cjk();
    }
  }

  flush_ascii();
  flush_cjk();

  std::sort(hashes.begin(), hashes.end());
  hashes.erase(std::unique(hashes.begin(), hashes.end()), hashes.end());
  return hashes;
}

const TermEntry* find_term(std::uint32_t hash) {
  auto it = std::lower_bound(g_state.terms.begin(), g_state.terms.end(), hash, [](const TermEntry& entry, std::uint32_t value) {
    return entry.hash < value;
  });
  if (it == g_state.terms.end() || it->hash != hash) {
    return nullptr;
  }

  return &(*it);
}

double compute_hot_score(const SearchDoc& doc, std::int64_t now_ms) {
  const double age_ms = std::max<double>(0.0, static_cast<double>(now_ms - doc.publish_unix_ms));
  const double base = static_cast<double>(doc.comment_count) * kHotCommentFactor
    + static_cast<double>(doc.views) * kHotViewFactor;
  return base * std::exp(-kLambda * age_ms);
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
  target.push_back(static_cast<char>(0));
  target.push_back(static_cast<char>(0));
  write_u16(target, 0);

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
  g_state = SearchState{};

  if (data == nullptr || length <= 0) {
    set_error(ErrorCode::IndexPayloadEmpty);
    return 0;
  }

  const auto* cursor = data;
  const auto* end = data + length;

  const std::uint32_t magic = read_u32(cursor, end);
  const std::uint16_t version = read_u16(cursor, end);
  (void)read_u16(cursor, end);
  const std::uint32_t term_count = read_u32(cursor, end);
  const std::uint32_t posting_count = read_u32(cursor, end);
  const std::uint32_t doc_count = read_u32(cursor, end);
  const float avg_doc_len = read_f32(cursor, end);

  if (!g_last_error.empty()) {
    return 0;
  }

  if (magic != kMagic || version != kVersion) {
    set_error(ErrorCode::IndexHeaderInvalid);
    return 0;
  }

  g_state.avg_doc_length = avg_doc_len <= 0.0f ? 1.0f : avg_doc_len;
  g_state.terms.reserve(term_count);
  g_state.postings.reserve(posting_count);
  g_state.docs.reserve(doc_count);

  for (std::uint32_t i = 0; i < term_count; ++i) {
    TermEntry entry;
    entry.hash = read_u32(cursor, end);
    entry.idf = read_f32(cursor, end);
    entry.posting_start = read_u32(cursor, end);
    entry.posting_count = read_u32(cursor, end);
    if (!g_last_error.empty()) {
      return 0;
    }
    g_state.terms.push_back(entry);
  }

  for (std::uint32_t i = 0; i < posting_count; ++i) {
    Posting posting;
    posting.doc_index = read_u32(cursor, end);
    posting.body_tf = read_u16(cursor, end);
    posting.title_tf = read_u16(cursor, end);
    if (!g_last_error.empty()) {
      return 0;
    }
    g_state.postings.push_back(posting);
  }

  for (std::uint32_t i = 0; i < doc_count; ++i) {
    SearchDoc doc;
    doc.article_id = read_u32(cursor, end);
    doc.category_id = read_u32(cursor, end);
    doc.publish_unix_ms = read_i64(cursor, end);
    doc.views = read_u32(cursor, end);
    doc.comment_count = read_u32(cursor, end);
    doc.doc_length = read_u32(cursor, end);
    const auto title_len = read_u16(cursor, end);
    const auto summary_len = read_u16(cursor, end);
    const auto category_len = read_u16(cursor, end);
    const auto tag_count = read_u16(cursor, end);
    if (!g_last_error.empty()) {
      return 0;
    }

    doc.title = read_string(cursor, end, title_len);
    doc.summary = read_string(cursor, end, summary_len);
    doc.category_name = read_string(cursor, end, category_len);
    if (!g_last_error.empty()) {
      return 0;
    }

    doc.tags.reserve(tag_count);
    for (std::uint16_t tag_index = 0; tag_index < tag_count; ++tag_index) {
      SearchTag tag;
      tag.id = read_u32(cursor, end);
      const auto name_len = read_u16(cursor, end);
      tag.name = read_string(cursor, end, name_len);
      if (!g_last_error.empty()) {
        return 0;
      }
      doc.tags.push_back(std::move(tag));
    }

    if (doc.doc_length == 0) {
      doc.doc_length = 1;
    }

    g_state.docs.push_back(std::move(doc));
  }

  g_state.loaded = true;
  return 1;
}

int apply_search_patch(const std::uint8_t* old_data, int old_length, const std::uint8_t* patch_data, int patch_length) {
  clear_error();
  g_last_result.clear();

  if ((old_data == nullptr && old_length > 0) || patch_data == nullptr || patch_length <= 0) {
    set_error(ErrorCode::PatchPayloadEmpty);
    return 0;
  }

  const auto* cursor = patch_data;
  const auto* end = patch_data + patch_length;

  const std::uint32_t magic = read_u32(cursor, end);
  const std::uint16_t version = read_u16(cursor, end);
  (void)read_u16(cursor, end);
  const std::uint32_t target_length = read_u32(cursor, end);
  const std::uint32_t op_count = read_u32(cursor, end);

  if (!g_last_error.empty()) {
    return 0;
  }

  if (magic != kPatchMagic || version != kPatchVersion) {
    set_error(ErrorCode::PatchHeaderInvalid);
    return 0;
  }

  g_last_result.reserve(target_length);
  for (std::uint32_t i = 0; i < op_count; ++i) {
    const std::uint8_t op = read_u8(cursor, end);
    if (!g_last_error.empty()) {
      return 0;
    }

    if (op == 1u) {
      const std::uint32_t offset = read_u32(cursor, end);
      const std::uint32_t length = read_u32(cursor, end);
      if (!g_last_error.empty()) {
        return 0;
      }

      if (offset > static_cast<std::uint32_t>(old_length) || length > static_cast<std::uint32_t>(old_length) || offset + length > static_cast<std::uint32_t>(old_length)) {
        set_error(ErrorCode::PatchCopyOutOfRange);
        return 0;
      }

      g_last_result.append(reinterpret_cast<const char*>(old_data + offset), length);
      continue;
    }

    if (op != 0u) {
      set_error(ErrorCode::PatchOpcodeInvalid);
      return 0;
    }

    const std::uint32_t length = read_u32(cursor, end);
    if (!g_last_error.empty()) {
      return 0;
    }

    if (cursor + length > end) {
      set_error(ErrorCode::PatchLiteralOverflow);
      return 0;
    }

    g_last_result.append(reinterpret_cast<const char*>(cursor), length);
    cursor += length;
  }

  if (g_last_result.size() != target_length) {
    set_error(ErrorCode::PatchLengthMismatch);
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

  for (std::uint32_t hash : hashes) {
    const TermEntry* term = find_term(hash);
    if (term == nullptr) {
      continue;
    }

    for (std::uint32_t i = 0; i < term->posting_count; ++i) {
      const Posting& posting = g_state.postings[term->posting_start + i];
      if (posting.doc_index >= g_state.docs.size()) {
        continue;
      }

      const SearchDoc& doc = g_state.docs[posting.doc_index];
      const double tf = static_cast<double>(posting.body_tf)
        + static_cast<double>(posting.title_tf) * kTitleBoost;
      if (tf <= 0.0) {
        continue;
      }

      const double norm = tf + kBm25K1 * (1.0 - kBm25B + kBm25B * (static_cast<double>(doc.doc_length) / g_state.avg_doc_length));
      const double contribution = static_cast<double>(term->idf) * ((tf * (kBm25K1 + 1.0)) / norm);

      g_bm25_scores[posting.doc_index] += contribution;
      if (g_doc_touched[posting.doc_index] == 0) {
        g_doc_touched[posting.doc_index] = 1;
        g_touched_docs.push_back(posting.doc_index);
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
    scores.push_back(entry);
  }

  switch (sort_mode) {
    case 1:
    {
      auto compare = [&](const ScoreEntry& left, const ScoreEntry& right) {
        return g_state.docs[left.doc_index].publish_unix_ms > g_state.docs[right.doc_index].publish_unix_ms;
      };
      const std::size_t safe_page = page <= 0 ? 1u : static_cast<std::size_t>(page);
      const std::size_t safe_size = std::max<std::size_t>(1, static_cast<std::size_t>(page_size));
      const std::size_t needed = std::min(scores.size(), safe_page * safe_size);
      if (needed < scores.size()) {
        std::nth_element(scores.begin(), scores.begin() + needed, scores.end(), compare);
        std::sort(scores.begin(), scores.begin() + needed, compare);
      } else {
        std::sort(scores.begin(), scores.end(), compare);
      }
      break;
    }
    case 2:
    {
      auto compare = [](const ScoreEntry& left, const ScoreEntry& right) {
        return left.hot > right.hot;
      };
      const std::size_t safe_page = page <= 0 ? 1u : static_cast<std::size_t>(page);
      const std::size_t safe_size = std::max<std::size_t>(1, static_cast<std::size_t>(page_size));
      const std::size_t needed = std::min(scores.size(), safe_page * safe_size);
      if (needed < scores.size()) {
        std::nth_element(scores.begin(), scores.begin() + needed, scores.end(), compare);
        std::sort(scores.begin(), scores.begin() + needed, compare);
      } else {
        std::sort(scores.begin(), scores.end(), compare);
      }
      break;
    }
    default:
    {
      auto compare = [](const ScoreEntry& left, const ScoreEntry& right) {
        return left.final_score > right.final_score;
      };
      const std::size_t safe_page = page <= 0 ? 1u : static_cast<std::size_t>(page);
      const std::size_t safe_size = std::max<std::size_t>(1, static_cast<std::size_t>(page_size));
      const std::size_t needed = std::min(scores.size(), safe_page * safe_size);
      if (needed < scores.size()) {
        std::nth_element(scores.begin(), scores.begin() + needed, scores.end(), compare);
        std::sort(scores.begin(), scores.begin() + needed, compare);
      } else {
        std::sort(scores.begin(), scores.end(), compare);
      }
      break;
    }
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
