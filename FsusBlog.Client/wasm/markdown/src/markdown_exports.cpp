#include "markdown_contract.hpp"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <string>
#include <string_view>

namespace {

enum class ErrorCode : std::uint8_t {
  None = 0,
  InvalidInput = 1
};

thread_local std::string g_last_html;
thread_local std::string g_last_error;
thread_local ErrorCode g_last_error_code = ErrorCode::None;
thread_local std::string g_last_metadata_json;
thread_local std::string g_last_features_json;
thread_local std::string g_last_placeholders_json;
thread_local std::string g_last_renderer_version;

const char* to_error_string(ErrorCode code) {
  switch (code) {
    case ErrorCode::None:
      return "";
    case ErrorCode::InvalidInput:
      return "source_invalid";
    default:
      return "markdown_render_failed";
  }
}

void append_json_string(std::string& out, std::string_view value) {
  out.push_back('"');
  for (char ch : value) {
    switch (ch) {
      case '\\':
        out.append("\\\\");
        break;
      case '"':
        out.append("\\\"");
        break;
      case '\n':
        out.append("\\n");
        break;
      case '\r':
        out.append("\\r");
        break;
      case '\t':
        out.append("\\t");
        break;
      default:
        out.push_back(ch);
        break;
    }
  }
  out.push_back('"');
}

std::string feature_name(fsusblog::wasm::markdown::feature value) {
  using fsusblog::wasm::markdown::feature;
  switch (value) {
    case feature::code_block: return "code_block";
    case feature::latex: return "latex";
    case feature::mermaid: return "mermaid";
    case feature::table: return "table";
    case feature::image: return "image";
    case feature::heading: return "heading";
    case feature::link: return "link";
  }

  return "unknown";
}

std::string placeholder_kind_name(fsusblog::wasm::markdown::placeholder_kind value) {
  using fsusblog::wasm::markdown::placeholder_kind;
  switch (value) {
    case placeholder_kind::latex_inline: return "latex_inline";
    case placeholder_kind::latex_block: return "latex_block";
    case placeholder_kind::mermaid_block: return "mermaid_block";
  }

  return "unknown";
}

std::string render_mode_name(fsusblog::wasm::markdown::render_mode value) {
  using fsusblog::wasm::markdown::render_mode;
  switch (value) {
    case render_mode::article: return "article";
    case render_mode::about: return "about";
    case render_mode::preview: return "preview";
    case render_mode::editor: return "editor";
  }

  return "article";
}

std::string build_features_json(const fsusblog::wasm::markdown::render_result& result) {
  std::string json;
  json.push_back('[');
  bool first = true;
  for (const auto feature : result.features) {
    if (!first) {
      json.push_back(',');
    }
    first = false;
    append_json_string(json, feature_name(feature));
  }
  json.push_back(']');
  return json;
}

std::string build_placeholders_json(const fsusblog::wasm::markdown::render_result& result) {
  std::string json;
  json.push_back('[');
  bool first = true;
  for (const auto& placeholder : result.placeholders) {
    if (!first) {
      json.push_back(',');
    }
    first = false;
    json.append("{\"kind\":");
    append_json_string(json, placeholder_kind_name(placeholder.kind));
    json.append(",\"token\":");
    append_json_string(json, placeholder.token);
    json.append(",\"label\":");
    append_json_string(json, placeholder.label);
    json.append(",\"source\":");
    append_json_string(json, placeholder.source);
    json.append(",\"line\":");
    json.append(std::to_string(placeholder.line));
    json.append(",\"column\":");
    json.append(std::to_string(placeholder.column));
    json.append(",\"endLine\":");
    json.append(std::to_string(placeholder.end_line));
    json.append(",\"endColumn\":");
    json.append(std::to_string(placeholder.end_column));
    json.append(",\"startOffset\":");
    json.append(std::to_string(placeholder.start_offset));
    json.append(",\"endOffset\":");
    json.append(std::to_string(placeholder.end_offset));
    json.push_back('}');
  }
  json.push_back(']');
  return json;
}

std::string build_metadata_json(const fsusblog::wasm::markdown::render_result& result) {
  std::string json;
  json.push_back('{');
  json.append("\"mode\":");
  append_json_string(json, render_mode_name(result.metadata.mode));
  json.append(",\"baseUrl\":");
  append_json_string(json, result.metadata.base_url);
  json.append(",\"allowHtml\":");
  json.append(result.metadata.allow_html ? "true" : "false");
  json.append(",\"allowLatex\":");
  json.append(result.metadata.allow_latex ? "true" : "false");
  json.append(",\"allowMermaid\":");
  json.append(result.metadata.allow_mermaid ? "true" : "false");
  json.append(",\"sourceLength\":");
  json.append(std::to_string(result.metadata.source_length));
  json.append(",\"sourceLineCount\":");
  json.append(std::to_string(result.metadata.source_line_count));
  json.append(",\"normalizedSourceLength\":");
  json.append(std::to_string(result.metadata.normalized_source_length));
  json.append(",\"featureCount\":");
  json.append(std::to_string(result.metadata.feature_count));
  json.append(",\"placeholderCount\":");
  json.append(std::to_string(result.metadata.placeholder_count));
  json.append(",\"rendererVersion\":");
  append_json_string(json, result.metadata.renderer_version);
  json.push_back('}');
  return json;
}

void set_success(const fsusblog::wasm::markdown::render_result& result) {
  g_last_html = result.html;
  g_last_metadata_json = build_metadata_json(result);
  g_last_features_json = build_features_json(result);
  g_last_placeholders_json = build_placeholders_json(result);
  g_last_renderer_version = std::string(fsusblog::wasm::markdown::renderer_version);
  g_last_error.clear();
  g_last_error_code = ErrorCode::None;
}

void set_error(ErrorCode code, std::string_view error) {
  g_last_html.clear();
  g_last_metadata_json.clear();
  g_last_features_json.clear();
  g_last_placeholders_json.clear();
  g_last_renderer_version.clear();
  g_last_error_code = code;
  g_last_error.assign(error.data(), error.size());
}

template <typename T>
const char* ptr_or_empty(const T& value) {
  return value.empty() ? "" : value.c_str();
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* markdown_alloc_buffer(std::size_t size) {
  return std::malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void* alloc_buffer(std::size_t size) {
  return markdown_alloc_buffer(size);
}

EMSCRIPTEN_KEEPALIVE
void markdown_free_buffer(void* ptr) {
  std::free(ptr);
}

EMSCRIPTEN_KEEPALIVE
void free_buffer(void* ptr) {
  markdown_free_buffer(ptr);
}

EMSCRIPTEN_KEEPALIVE
int markdown_render(const char* source_ptr, int source_len, int allow_html, int allow_latex, int allow_mermaid) {
  if (source_ptr == nullptr || source_len < 0) {
    set_error(ErrorCode::InvalidInput, to_error_string(ErrorCode::InvalidInput));
    return 0;
  }

  fsusblog::wasm::markdown::render_request request;
  request.source.assign(source_ptr, source_ptr + source_len);
  request.allow_html = allow_html != 0;
  request.allow_latex = allow_latex != 0;
  request.allow_mermaid = allow_mermaid != 0;

  const auto result = fsusblog::wasm::markdown::build_render_result(request);
  set_success(result);
  return 1;
}

EMSCRIPTEN_KEEPALIVE
int render_markdown(const char* source_ptr, int source_len, int allow_html, int allow_latex, int allow_mermaid) {
  return markdown_render(source_ptr, source_len, allow_html, allow_latex, allow_mermaid);
}

EMSCRIPTEN_KEEPALIVE
const char* markdown_get_last_html_ptr() {
  return ptr_or_empty(g_last_html);
}

EMSCRIPTEN_KEEPALIVE
const char* get_last_html_ptr() {
  return markdown_get_last_html_ptr();
}

EMSCRIPTEN_KEEPALIVE
int markdown_get_last_html_len() {
  return static_cast<int>(g_last_html.size());
}

EMSCRIPTEN_KEEPALIVE
int get_last_html_len() {
  return markdown_get_last_html_len();
}

EMSCRIPTEN_KEEPALIVE
const char* markdown_get_last_metadata_ptr() {
  return ptr_or_empty(g_last_metadata_json);
}

EMSCRIPTEN_KEEPALIVE
const char* get_last_metadata_ptr() {
  return markdown_get_last_metadata_ptr();
}

EMSCRIPTEN_KEEPALIVE
int markdown_get_last_metadata_len() {
  return static_cast<int>(g_last_metadata_json.size());
}

EMSCRIPTEN_KEEPALIVE
int get_last_metadata_len() {
  return markdown_get_last_metadata_len();
}

EMSCRIPTEN_KEEPALIVE
const char* markdown_get_last_error_ptr() {
  return ptr_or_empty(g_last_error);
}

EMSCRIPTEN_KEEPALIVE
const char* get_last_error_ptr() {
  return markdown_get_last_error_ptr();
}

EMSCRIPTEN_KEEPALIVE
int markdown_get_last_error_len() {
  return static_cast<int>(g_last_error.size());
}

EMSCRIPTEN_KEEPALIVE
int get_last_error_len() {
  return markdown_get_last_error_len();
}

EMSCRIPTEN_KEEPALIVE
int markdown_get_last_error_code() {
  return static_cast<int>(g_last_error_code);
}

EMSCRIPTEN_KEEPALIVE
int get_last_error_code() {
  return markdown_get_last_error_code();
}

EMSCRIPTEN_KEEPALIVE
const char* markdown_get_last_features_ptr() {
  return ptr_or_empty(g_last_features_json);
}

EMSCRIPTEN_KEEPALIVE
const char* get_last_features_ptr() {
  return markdown_get_last_features_ptr();
}

EMSCRIPTEN_KEEPALIVE
int markdown_get_last_features_len() {
  return static_cast<int>(g_last_features_json.size());
}

EMSCRIPTEN_KEEPALIVE
int get_last_features_len() {
  return markdown_get_last_features_len();
}

EMSCRIPTEN_KEEPALIVE
const char* markdown_get_last_placeholders_ptr() {
  return ptr_or_empty(g_last_placeholders_json);
}

EMSCRIPTEN_KEEPALIVE
const char* get_last_placeholders_ptr() {
  return markdown_get_last_placeholders_ptr();
}

EMSCRIPTEN_KEEPALIVE
int markdown_get_last_placeholders_len() {
  return static_cast<int>(g_last_placeholders_json.size());
}

EMSCRIPTEN_KEEPALIVE
int get_last_placeholders_len() {
  return markdown_get_last_placeholders_len();
}

EMSCRIPTEN_KEEPALIVE
const char* markdown_get_last_renderer_version_ptr() {
  return ptr_or_empty(g_last_renderer_version);
}

EMSCRIPTEN_KEEPALIVE
const char* get_last_renderer_version_ptr() {
  return markdown_get_last_renderer_version_ptr();
}

EMSCRIPTEN_KEEPALIVE
int markdown_get_last_renderer_version_len() {
  return static_cast<int>(g_last_renderer_version.size());
}

EMSCRIPTEN_KEEPALIVE
int get_last_renderer_version_len() {
  return markdown_get_last_renderer_version_len();
}

} // extern "C"
const char* to_error_string(ErrorCode code) {
  switch (code) {
    case ErrorCode::None:
      return "";
    case ErrorCode::InvalidInput:
      return "source_invalid";
    default:
      return "markdown_render_failed";
  }
}
