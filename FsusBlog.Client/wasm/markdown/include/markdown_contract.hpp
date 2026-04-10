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
  link = 6
};

enum class placeholder_kind : std::uint8_t {
  latex_inline = 0,
  latex_block = 1,
  mermaid_block = 2
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
  bool allow_html{false};
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
  bool allow_html{false};
  bool allow_latex{true};
  bool allow_mermaid{true};
};

struct render_result final {
  std::string html;
  std::string normalized_source;
  std::vector<feature> features;
  std::vector<placeholder> placeholders;
  render_metadata metadata;
};

inline constexpr std::string_view renderer_version = "markdown-wasm-contract@2026-04-06-3";

[[nodiscard]] std::string normalize_source(std::string_view input);
[[nodiscard]] std::string escape_html(std::string_view input);
[[nodiscard]] bool contains_feature(std::string_view source, feature kind);
[[nodiscard]] std::vector<placeholder> collect_placeholders(std::string_view source);
[[nodiscard]] render_result build_render_result(const render_request& request);
[[nodiscard]] render_result build_placeholder_result(const render_request& request);
[[nodiscard]] std::string render_html(const render_request& request);

} // namespace fsusblog::wasm::markdown
