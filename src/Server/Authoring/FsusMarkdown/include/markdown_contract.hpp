#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace fsusblog::wasm::markdown {

enum class render_mode : std::uint8_t {
  article = 0,
  about = 1,
  preview = 2,
  editor = 3
};

enum class feature : std::uint8_t {
  code_block = 0,
  latex = 1,
  mermaid = 2,
  table = 3,
  image = 4,
  heading = 5,
  link = 6,
  emphasis = 7,
  footnote = 8
};

enum class placeholder_kind : std::uint8_t {
  latex_inline = 0,
  latex_block = 1,
  mermaid_block = 2
};

enum class syntax_kind : std::uint8_t {
  heading = 0,
  paragraph = 1,
  list = 2,
  task = 3,
  quote = 4,
  table = 5,
  link = 6,
  image = 7,
  code = 8,
  latex = 9,
  mermaid = 10,
  footnote = 11,
  explicit_paragraph = 12,
  embed = 13,
  caption = 14,
  anchor = 15,
  malformed = 16,
  count = 17
};

enum class syntax_status : std::uint8_t {
  valid = 0,
  malformed = 1
};

enum class syntax_table_alignment : std::uint8_t {
  none = 0,
  left = 1,
  center = 2,
  right = 3
};

struct syntax_range final {
  std::size_t start_offset{0};
  std::size_t end_offset{0};
};

struct anchor_owner_block final {
  syntax_kind kind;
  syntax_range range;
};

struct syntax_node final {
  syntax_kind kind{};
  std::size_t start_offset{0};
  std::size_t end_offset{0};
  std::size_t parent_index{static_cast<std::size_t>(-1)};
  std::vector<syntax_range> content_ranges;
  std::vector<syntax_range> marker_ranges;
  syntax_status status{syntax_status::valid};
  std::string diagnostic_code;
  std::vector<syntax_range> table_row_ranges;
  std::vector<std::vector<syntax_range>> table_cell_ranges;
  std::vector<syntax_table_alignment> table_alignments;
  std::size_t table_separator_row{static_cast<std::size_t>(-1)};
};

struct placeholder final {
  placeholder_kind kind{};
  std::string token;
  std::string label;
  std::string source;
  std::size_t line{0};
  std::size_t column{0};
  std::size_t end_line{0};
  std::size_t end_column{0};
  std::size_t start_offset{0};
  std::size_t end_offset{0};
};

struct render_metadata final {
  render_mode mode{render_mode::article};
  std::string base_url;
  bool allow_latex{true};
  bool allow_mermaid{true};
  std::size_t source_length{0};
  std::size_t source_line_count{0};
  std::size_t normalized_source_length{0};
  std::size_t feature_count{0};
  std::size_t placeholder_count{0};
  std::string renderer_version;
};

struct render_request final {
  std::string source;
  std::string base_url;
  render_mode mode{render_mode::article};
  bool allow_latex{true};
  bool allow_mermaid{true};
};

struct render_result final {
  std::string html;
  std::string normalized_source;
  std::vector<feature> features;
  std::vector<placeholder> placeholders;
  std::vector<syntax_node> syntax_nodes;
  render_metadata metadata;
};

inline constexpr std::string_view renderer_version = "markdown-wasm-contract@2026-07-29";

[[nodiscard]] std::string normalize_source(std::string_view input);
[[nodiscard]] std::string escape_html(std::string_view input);
[[nodiscard]] bool contains_feature(std::string_view source, feature kind);
[[nodiscard]] std::size_t count_placeholders(std::string_view source);
[[nodiscard]] std::vector<placeholder> collect_placeholders(std::string_view source);
[[nodiscard]] std::string_view syntax_kind_name(syntax_kind kind);
[[nodiscard]] std::vector<syntax_node> collect_syntax_nodes(std::string_view source);
[[nodiscard]] std::vector<anchor_owner_block> collect_anchor_owner_blocks(std::string_view normalized_source);
[[nodiscard]] render_result build_summary_result(const render_request& request);
[[nodiscard]] render_result build_render_result(const render_request& request);
[[nodiscard]] render_result build_placeholder_result(const render_request& request);
[[nodiscard]] std::string render_html(const render_request& request);

} // namespace fsusblog::wasm::markdown
